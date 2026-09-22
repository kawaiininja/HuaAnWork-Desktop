/**
 * HuaAnWork host loop spec(M3 出口证据):session 回合端到端——文本回合 /
 * 工具审批(approve + reject)/ run_code、web_search 缺席 / session.cancel /
 * presentAs("ptc") 防线,全部经真实组合 boot + 真实 HTTP 路由 + WS 事件帧断言,
 * 模型侧走 loopback stub LLM(见 huaanwork-stub-llm.mjs),永不触达真实模型。
 *
 * Boot 模式逐字参照 scripts/verify-profile-boot.mjs 的进程内组合:
 * 临时 home、rendererToken 自铸经 BROWSER_ACCESS 注入(与 main.ts:1507
 * startIsolatedDesktopHost 的 rendererToken 同位置)、webserver 取实际监听端口
 * (ctx.webServer.port)、fetch/WS 带 x-dsh-desktop-renderer header。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { WebSocket } from 'ws'

import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'

import { DESKTOP_SETTINGS_NAMESPACE } from '../lib/index.js'
import { installDesktopPnpmRuntime } from '../lib/desktop-runtime-environment.js'
import { installProfilePackageResolver } from '../lib/module-resolution.js'
import { prepareDesktopProfile } from '../lib/profile.js'
import { DesktopProfileService } from '../lib/profile-service.js'
import { startStubLlm } from './huaanwork-stub-llm.mjs'

const BIN_NAME = 'dsh-plugin-huaanwork-host-loop-smoke'
const TEST_TIMEOUT_MS = 30_000
const EVENT_WAIT_MS = 15_000

let ordinaryBrowserEnabled = false
/** 测试自铸 rendererToken(main.ts:1507 的 rendererToken 同位置:经 BROWSER_ACCESS 注入)。 */
const rendererHeader = {
  name: 'x-dsh-desktop-renderer',
  value: randomBytes(32).toString('base64url'),
}
const BROWSER_ACCESS = Object.freeze({
  get ordinaryBrowserEnabled() { return ordinaryBrowserEnabled },
  rendererHeader: Object.freeze(rendererHeader),
  setOrdinaryBrowserEnabled(enabled) { ordinaryBrowserEnabled = enabled },
})
const LAN_HTTPS_SNAPSHOT = Object.freeze({
  state: 'inactive',
  actualPort: null,
  addresses: Object.freeze([]),
  caFingerprint: null,
  errorCode: null,
})
const LAN_HTTPS = Object.freeze({
  caCertificate: null,
  attach() {},
  snapshot() { return LAN_HTTPS_SNAPSHOT },
  async setEnabled() { return LAN_HTTPS_SNAPSHOT },
  async stop() { return LAN_HTTPS_SNAPSHOT },
})

let base
let home
let repo
let ctx
let stub
let ws
let releasePackageResolver
let pnpmRuntime
let mountedSpec
let webPort
let origin
let previousDshHome
let profileDir

/** @type {unknown[]} 进程内直接可达的 WS 事件帧(bridge/approval 经 hub 广播)。 */
const events = []

// 注意:node --test 的 root hook 在 v22.23.2 下 `before({timeout}, fn)` 形式
// 会被静默跳过(实测 hook 不执行、无任何报错),因此 hook 不带 options;
// boot 超时用包内 watchdog 实现。
const BOOT_WATCHDOG_MS = 240_000

before(async () => {
  const watchdog = setTimeout(() => {
    console.error(`[loop-spec] boot watchdog: shared host boot exceeded ${String(BOOT_WATCHDOG_MS)}ms`)
  }, BOOT_WATCHDOG_MS)
  try {
    await bootSharedHost()
  } catch (err) {
    console.error('[loop-spec] before hook failed:', err)
    throw err
  } finally {
    clearTimeout(watchdog)
  }
})

async function bootSharedHost() {
  base = mkdtempSync(join(tmpdir(), 'huaanwork-host-loop-'))
  repo = join(base, 'repo')
  mkdirSync(repo, { recursive: true })
  assert.equal(spawnSync('git', ['init', '-q', '--template=/dev/null'], { cwd: repo }).status, 0)
  writeFileSync(join(repo, 'README.md'), '# loop fixture\n')
  home = join(base, 'dsh')
  mkdirSync(home, { recursive: true })

  stub = await startStubLlm([
    { match: /hang/, reply: { hang: true } },
    { match: /自我介绍/, reply: { content: 'stub:我是 HuaAnWork 本地智能助手。' } },
    {
      match: /ls/,
      reply: { toolCalls: [{ name: 'bash', arguments: { command: 'ls' } }] },
    },
  ])

  // 模型适配器(guardrails/model.ts loadSettings)读 dirname($DSH_HOME)/settings.json,
  // 与 main.ts:710(process.env.DSH_HOME = homeDir)同约定。
  writeFileSync(join(base, 'settings.json'), `${JSON.stringify({
    base_url: stub.url,
    model: 'stub',
    api_key: '',
    models: [{ id: 'stub', name: 'stub', base_url: stub.url, model: 'stub', api_key: '' }],
    active_model_id: 'stub',
    allow_network: false,
  }, null, 2)}\n`)
  writeFileSync(join(home, 'settings.yaml'), [
    'dsh-desktop:',
    '  mode: advanced',
    'agent-presets:',
    '  default: minimal',
    '',
  ].join('\n'))

  let prepared = prepareDesktopProfile('1', home, 'win32')
  // pending workspace root:组合期消费一次(agent-loop cwd + fs-sandbox),boot 后清除。
  writeFileSync(join(prepared.profile.dir, 'huaanwork-workspace.json'), `${JSON.stringify({ pendingRoot: repo })}\n`)
  prepared = prepareDesktopProfile('1', home, 'win32')
  profileDir = prepared.profile.dir
  // session.send 的联网门禁(Task 5)读 profileDir/huaanwork-settings.json;loopback 端点天然放行。
  writeFileSync(join(prepared.profile.dir, 'huaanwork-settings.json'), `${JSON.stringify({
    base_url: stub.url,
    model: 'stub',
    api_key: '',
  })}\n`)

  previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const packageRoot = new URL('../', import.meta.url)
  const pnpmBinPath = fileURLToPathLocal(new URL('node_modules/pnpm/bin/pnpm.mjs', packageRoot))
  const electronVersion = JSON.parse(
    readFileText(new URL('node_modules/electron/package.json', packageRoot)),
  ).version
  pnpmRuntime = installDesktopPnpmRuntime({
    platform: process.platform,
    appExecutable: process.execPath,
    pnpmBinPath,
    electronVersion,
    stateDir: join(home, 'runtime-commands'),
    environment: process.env,
  })
  releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
  ctx = await bootPrepared(prepared)

  webPort = ctx.webServer.port
  origin = `http://127.0.0.1:${String(webPort)}`
  const desktopSettings = ctx.settings.get(DESKTOP_SETTINGS_NAMESPACE)
  assert.equal(desktopSettings?.mode, 'advanced')

  ws = new WebSocket(`ws://127.0.0.1:${String(webPort)}/huaanwork/events`, {
    headers: { [rendererHeader.name]: rendererHeader.value },
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  ws.on('message', (data) => {
    let event
    try {
      event = JSON.parse(data.toString())
    } catch {
      event = { event: 'unparseable', raw: data.toString() }
    }
    events.push(event)
    if (process.env.LOOP_DEBUG) console.error(`[loop-spec] ws event: ${data.toString()}`)
  })
}

after(async () => {
  try {
    try { ws?.close() } catch { /* socket 可能已被服务端重启侧关闭 */ }
    try { await ctx?.fiber.dispose() } catch { /* 二次 dispose(workspace 用例已 dispose 旧 ctx)容忍幂等 */ }
  } finally {
    releasePackageResolver?.()
    pnpmRuntime?.dispose()
    await stub?.close()
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    if (base !== undefined) rmSync(base, { recursive: true, force: true })
  }
})

function fileURLToPathLocal(url) {
  return fileURLToPath(url)
}

/**
 * 进程内组合 + boot(Workspace 用例的「generation 重启」即再调本函数一次)。
 * 复用同一 pnpmRuntime / BROWSER_ACCESS;每次 boot 新铸 desktopRuntime stub。
 */
async function bootPrepared(prepared) {
  const packageRoot = new URL('../', import.meta.url)
  const pnpmBinPath = fileURLToPathLocal(new URL('node_modules/pnpm/bin/pnpm.mjs', packageRoot))
  const electronVersion = JSON.parse(
    readFileText(new URL('node_modules/electron/package.json', packageRoot)),
  ).version
  const runtime = {
    platform: 'win32',
    windowsBuild: 22_631,
    locale: 'en',
    updates: {
      isPackaged: false,
      canDownload: true,
      currentVersion: '2.0.0',
      statePath: join(home, 'update-state.json'),
      request: async () => { throw new Error('host loop spec must not perform update requests') },
      confirmDownload: async () => false,
      showManualCheckResult: async () => {},
      downloadAndOpen: async () => {},
      notify: () => {},
    },
    schedule(spec) {
      mountedSpec = spec
      return async () => {}
    },
    async mountScheduled() {
      if (mountedSpec === undefined) throw new Error('desktop shell was not registered')
      runtime.setLocalePreference(mountedSpec.readLocalePreference())
    },
    show() {},
    registerTrayItem(item) {
      return { refresh() {}, dispose() {} }
    },
    openTerminal() {},
    setLocalePreference(preference) { runtime.locale = preference ?? 'en' },
    setThemeSource() {},
    async requestRestart() {},
    // 评审 R2:workspace 切换走 requestConfirmedRestart 确认回传,桩须具备该能力,
    // 否则经 route 驱动 workspace/project 用例会以「is not a function」崩。
    async requestConfirmedRestart() { return true },
    prepareToQuit() {},
  }
  const nextCtx = await boot(
    BIN_NAME,
    prepared.rootConfig,
    [...prepared.patches],
    async (host) => {
      host.loader.internal = undefined
      host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]))
      host.provide('desktopBrowserAccess', BROWSER_ACCESS)
      host.provide('desktopLanHttps', LAN_HTTPS)
      host.provide('desktopRuntime', runtime)
      host.provide('desktopPnpmBootstrap', {
        activeProfileName: 'desktop',
        activeProfileDir: prepared.profile.dir,
        homeDir: home,
        appExecutable: process.execPath,
        pnpmBinPath,
        electronVersion,
        nodeBinDir: pnpmRuntime.nodeBinDir,
        nodeShimPath: pnpmRuntime.nodeShimPath,
        clearEnvironmentPath: pnpmRuntime.clearEnvironmentPath,
        dshBootstrapPath: fileURLToPathLocal(new URL('../lib/desktop-cli.js', import.meta.url)),
      })
      await host.plugin(DesktopProfileService, {
        current: {
          name: 'desktop',
          dir: prepared.profile.dir,
        },
        list: () => [{
          name: 'desktop',
          dir: prepared.profile.dir,
          exists: true,
          bundles: prepared.profile.layers.map((layer) => layer.packageName),
          webCapable: true,
        }],
        persistSelection: () => {},
        requestRestart: () => {},
      })
      provideCmdline(host, {
        args: ['--host', '127.0.0.1', '--port', '0'],
        exit: () => {},
      })
    },
    prepared.bareModuleBaseUrl,
  )
  await runtime.mountScheduled()
  return nextCtx
}

function readFileText(url) {
  return readFileSync(fileURLToPathLocal(url), 'utf8')
}

async function post(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      [rendererHeader.name]: rendererHeader.value,
    },
    body: JSON.stringify(body ?? {}),
  })
  const text = await response.text()
  const parsed = text.length > 0 ? JSON.parse(text) : undefined
  if (process.env.LOOP_DEBUG) {
    console.error(`[loop-spec] POST ${path} -> HTTP ${String(response.status)}: ${text.slice(0, 300)}`)
  }
  assert.equal(response.status, 200, `POST ${path} -> HTTP ${String(response.status)}: ${text}`)
  return parsed
}

async function get(path) {
  const response = await fetch(`${origin}${path}`, {
    headers: {
      origin,
      [rendererHeader.name]: rendererHeader.value,
    },
  })
  const text = await response.text()
  const parsed = text.length > 0 ? JSON.parse(text) : undefined
  assert.equal(response.status, 200, `GET ${path} -> HTTP ${String(response.status)}: ${text}`)
  return parsed
}

function drainEvents() {
  events.length = 0
}

async function waitForEvent(predicate, label) {
  const deadline = Date.now() + EVENT_WAIT_MS
  while (Date.now() < deadline) {
    const found = events.find((event) => predicate(event))
    if (found !== undefined) return found
    await new Promise((done) => setTimeout(done, 25))
  }
  throw new Error(
    `timed out waiting for ${label}; events=${JSON.stringify(events).slice(0, 4_000)}`,
  )
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

function mainAgent() {
  const agents = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : []
  const agent = agents.find((entry) => entry?.id === 'huaanwork') ?? agents[0]
  assert.ok(agent, 'main agent is missing from the agent registry')
  return agent
}

test('文本回合:token 帧 + session/end ok + 会话列表标题非空', { timeout: TEST_TIMEOUT_MS }, async () => {
  drainEvents()
  const sending = post('/huaanwork/session/send', { text: '你好,请自我介绍' })
  const sent = await sending
  assert.equal(sent.queued, true)
  assert.equal(typeof sent.sessionId, 'string')
  await waitForEvent(
    (event) => event?.event === 'session/end' && event.sessionId === sent.sessionId && event.ok === true,
    `session/end ok for ${String(sent.sessionId)}`,
  )
  assert.ok(
    events.some((event) => event?.event === 'token' && typeof event.text === 'string' && event.text.length > 0),
    'expected at least one token frame',
  )
  assert.ok(stub.requests.length >= 1, 'stub LLM recorded the model request')
  const list = await get('/huaanwork/session/list')
  assert.ok(Array.isArray(list), 'session/list returns an array')
  const session = list.find((entry) => entry?.id === sent.sessionId)
  assert.ok(session, `session ${String(sent.sessionId)} appears in session/list`)
  assert.equal(typeof session.title, 'string')
  assert.ok(session.title.trim().length > 0, 'session title is non-empty')
})

test('工具审批 approve:approval/asked → approve → tool/start → tool/end → session/end ok', { timeout: TEST_TIMEOUT_MS }, async () => {
  drainEvents()
  const sending = post('/huaanwork/session/send', { text: '请审批:运行 ls 查看文件' })
  const asked = await waitForEvent(
    (event) => event?.event === 'approval/asked' && event.toolName === 'bash' && typeof event.approvalRequestId === 'string',
    'approval/asked for bash',
  )
  const answered = await post('/huaanwork/session/approve', { approvalRequestId: asked.approvalRequestId })
  assert.equal(answered.handled, true)
  await waitForEvent(
    (event) => event?.event === 'tool/start' && event.name === 'bash',
    'tool/start bash',
  )
  await waitForEvent(
    (event) => event?.event === 'tool/end' && event.name === 'bash',
    'tool/end bash',
  )
  await waitForEvent(
    (event) => event?.event === 'session/end' && event.ok === true,
    'session/end ok after approval',
  )
  const sent = await sending
  assert.equal(sent.queued, true)
})

test('工具审批 reject:拒绝后工具不执行,回合以拒绝收尾(不崩、不挂起)', { timeout: TEST_TIMEOUT_MS }, async () => {
  drainEvents()
  const sending = post('/huaanwork/session/send', { text: '再次请审批:运行 ls(这次拒绝)' })
  const asked = await waitForEvent(
    (event) => event?.event === 'approval/asked' && event.toolName === 'bash' && typeof event.approvalRequestId === 'string',
    'approval/asked for bash',
  )
  const answered = await post('/huaanwork/session/reject', { approvalRequestId: asked.approvalRequestId })
  assert.equal(answered.handled, true)
  const sent = await sending
  assert.equal(sent.queued, true)
  await waitForEvent(
    (event) => event?.event === 'session/end',
    'session/end closing the rejected turn',
  )
  assert.equal(
    events.filter((event) => event?.event === 'tool/start' && event.name === 'bash').length,
    0,
    'bash must not execute after rejection',
  )
})

test('run_code / web_search 缺席:主 agent schemas 不含禁用工具', { timeout: TEST_TIMEOUT_MS }, async () => {
  const agent = mainAgent()
  const tools = agent.ctx?.get?.('tools')
  assert.equal(typeof tools?.schemas, 'function', 'main agent exposes a tools schema dump')
  const names = tools.schemas().map((schema) => schema?.name)
  assert.ok(!names.includes('run_code'), `run_code must be absent, got: ${names.join(', ')}`)
  assert.ok(!names.includes('web_search'), `web_search must be absent, got: ${names.join(', ')}`)
})

test('session.cancel:挂起回合被取消收尾,进程不挂', { timeout: TEST_TIMEOUT_MS }, async () => {
  drainEvents()
  const sending = post('/huaanwork/session/send', { text: 'hang:这个回合请挂起不要结束' })
  await sleep(500)
  const cancelled = await post('/huaanwork/session/cancel', {})
  assert.equal(cancelled.accepted, true)
  const sent = await sending
  assert.equal(sent.queued, true)
  await waitForEvent(
    (event) => event?.event === 'session/end' && (event.cancelled === true || event.ok === true),
    'session/end after cancel',
  )
})

test('presentAs("ptc") 防线:主 agent scope 抛 disabled by HuaAnWork', { timeout: TEST_TIMEOUT_MS }, async () => {
  const agent = mainAgent()
  const tools = agent.ctx?.get?.('tools')
  assert.equal(typeof tools?.presentAs, 'function', 'main agent tools expose presentAs')
  assert.throws(
    () => tools.presentAs('ptc'),
    /disabled by HuaAnWork/,
  )
})

test('workspace pendingRoot:project.open 经 route 驱动写盘,二次组合 + boot 模拟 generation 重启(不触发真实 relaunch)', { timeout: BOOT_WATCHDOG_MS }, async () => {
  // 评审 R2:M3 唯一的真 boot 整合证据改走与 UI 相同的 route——注册项目后经
  // POST /huaanwork/project/open 钉新根(runtime 桩确认重启),覆盖
  // assertAutomationIdle → 写 pendingRoot → 确认回传应答全链;此前此处直接写
  // huaanwork-workspace.json,完全绕过 route,D2 修复涉及的逻辑均不在覆盖内。
  const repo2 = join(base, 'repo2')
  mkdirSync(repo2, { recursive: true })
  writeFileSync(join(repo2, 'README.md'), '# second workspace\n')
  const created = await post('/huaanwork/project/create', { root: repo2, name: 'repo2' })
  assert.equal(created.project.root, repo2, 'project.create pins repo2 root')
  const opened = await post('/huaanwork/project/open', { projectId: created.project.id })
  assert.equal(opened.restarting, true, 'stub confirms restart, route answers restarting')
  assert.equal(opened.workspaceRoot, repo2, 'project.open response carries workspaceRoot (评审 D1)')
  assert.equal(opened.project.id, created.project.id, 'project.open response carries project')
  assert.deepEqual(
    JSON.parse(readFileSync(join(profileDir, 'huaanwork-workspace.json'), 'utf8')),
    { pendingRoot: repo2 },
    'project.open wrote pendingRoot via route',
  )

  const reprepared = prepareDesktopProfile('1', home, 'win32')
  await ctx.fiber.dispose()
  ctx = await bootPrepared(reprepared)

  // 组合期消费 pendingRoot:holder 钉新根,agent-loop cwd / 会话 id 按新根铸造。
  assert.equal(ctx.huaanworkWorkspaceRoot.current, repo2, 'workspace root holder pinned to pendingRoot')
  const agent = mainAgent()
  assert.equal(agent.session?.header?.cwd, repo2, 'agent-loop cwd follows pendingRoot')
  const expectedSessionId = `huaanwork-${createHash('sha256').update(resolvePath(repo2)).digest('hex').slice(0, 16)}`
  assert.equal(agent.session?.id, expectedSessionId, 'session id minted from pendingRoot')

  // huaanwork-host 首个 effect:pendingRoot 已清(文件保留 {} 占位,不删除)。
  const state = JSON.parse(readFileSync(join(profileDir, 'huaanwork-workspace.json'), 'utf8'))
  assert.deepEqual(state, {}, 'pendingRoot cleared by first apply effect')

  // open 同根短路(旧 host.ts:1013 语义):不重启、不写 pendingRoot,服务端仍活着应答 200。
  const reopened = await post('/huaanwork/workspace/open', { root: repo2 })
  assert.deepEqual(reopened, { workspaceRoot: repo2 }, 'open short-circuits on same root')
  assert.deepEqual(
    JSON.parse(readFileSync(join(profileDir, 'huaanwork-workspace.json'), 'utf8')),
    {},
    'short-circuit must not write pendingRoot',
  )
})
