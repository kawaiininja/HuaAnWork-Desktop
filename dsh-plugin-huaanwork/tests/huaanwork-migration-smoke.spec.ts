/**
 * M6 Task 2.9 真机冒烟(门控,默认 skip,不进常规门禁)。
 *
 * 运行方式:`HUAANWORK_MIGRATION_SMOKE=1 corepack yarn vitest run tests/huaanwork-migration-smoke.spec.ts`。
 * 应用产物路径默认在 `dsh-plugin-huaanwork/dist/` 下探测(package:dir 产物),
 * 可用 `HUAANWORK_MIGRATION_SMOKE_APP` 覆盖。门控开启而产物缺失时 fail-loud。
 *
 * 层级诚实标注(与 market-smoke-live 同口径):
 * - 「真实应用」= spawn package:dir 产物:真实 Electron 主进程 + 隔离 Host 子进程;
 * - 「host 就绪」= 轮询宿主 web server 的 loopback 端口(43120 起,DESKTOP_DEFAULT_WEB_PORT)
 *   收到**任何** HTTP 响应即已监听 —— 桌面 Web 载体对无 renderer token 的外部请求
 *   一律 403(desktop-browser-access.ts:86,ordinaryBrowserEnabled 仅兼容模式开启),
 *   所以 403 是「宿主在服务」的阳性证据而非失败;
 * - 「GET /huaanwork/…」断言落层为 route handler 包装的同一批读侧函数直调
 *   (readHuaanworkSettings / listProjects / listAutomations / authStatus / 会话日志 reader),
 *   HTTP 载体本身由 tests/huaanwork-host/routes.spec.ts + tests/client-huaanwork/api.spec.ts 覆盖;
 * - 全程隔离:临时 HOME + `--user-data-dir=<临时>/HuaAnWork`(config dir;旧 Tauri 的
 *   三个文件与旧 `$DSH_HOME`(`<config dir>/dsh`,paths.ts 的 LEGACY_DSH_HOME)播种于此。
 *   macOS 的 `app.getPath('appData')` 不跟随 HOME,实测;`--user-data-dir` 是唯一
 *   可靠的 userData 重定向,迁移源 = userData,故它必须指向播种目录)
 *   + 另一个独立临时根作为显式 `DSH_HOME`(新 home;迁移目的树,marker 与会话读侧都看它,
 *   绝不能与旧树同根);
 *   应用自身在解析 userData 之前调用 `app.setName(PRODUCT_NAME)`(main.ts:1843),
 *   所以实际产品运行时该目录名确为 HuaAnWork(F1)。
 *   说明:应用会探测稳定版 `~/Library/Application Support/DSH Desktop` 的
 *   profile 使用记录(只读为主;清理由临时 profile 路径驱动,对该目录是空操作)。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { dshProductVersion } from '../src/dsh-product-version.ts'
import { authStatus } from '../src/huaanwork-host/auth.ts'
import { readHuaanworkSettings } from '../src/huaanwork-host/settings.ts'
import { listAutomations, listProjects } from '../src/huaanwork-host/stores.ts'
import { sessionIdFor } from '../src/huaanwork-host/session-id.ts'
import { decompressZstdFrames } from '../src/huaanwork-host/session-view.ts'
import { neutralWorkspaceRoot } from '../src/huaanwork-host/workspace-state.ts'
import { MIGRATION_MARKER_FILENAME, type HuaanworkMigrationMarker } from '../src/huaanwork-migration/marker.ts'
import { resolveLegacySource, type HuaanworkLegacySource } from '../src/huaanwork-migration/paths.ts'
import { encodeSegment, projectKey } from '../src/huaanwork-migration/sessions.ts'
import { createDesktopWebProfile } from '../src/profile-manager.ts'
import { completeOrSkipDesktopSetupWizard, desktopSetupWizardStateConstants } from '../src/setup-wizard-state.ts'

const LIVE = process.env.HUAANWORK_MIGRATION_SMOKE === '1'
const describeLive = LIVE ? describe : describe.skip

const PLUGIN_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
/** 桌面宿主默认 web 端口与重试上限(desktop-port.ts)。 */
const FIRST_WEB_PORT = 43_120
const LAST_WEB_PORT = FIRST_WEB_PORT + 32

const BOOT_TIMEOUT_MS = 120_000

const cleanup: Array<() => void | Promise<void>> = []
afterEach(() => {
  while (cleanup.length > 0) {
    const task = cleanup.pop()
    if (task) task()
  }
})

/** package:dir 产物的可执行文件:env 覆盖优先,否则按平台默认位置探测。 */
function locatePackagedApp(): string {
  const configured = process.env.HUAANWORK_MIGRATION_SMOKE_APP
  if (configured !== undefined && configured.length > 0) return configured
  const candidates = process.platform === 'darwin'
    ? ['mac-universal', 'mac-arm64', 'mac'].map(dir =>
        join(PLUGIN_ROOT, 'dist', dir, 'HuaAnWork.app', 'Contents', 'MacOS', 'HuaAnWork'))
    : process.platform === 'win32'
      ? [join(PLUGIN_ROOT, 'dist', 'win-unpacked', 'HuaAnWork.exe')]
      : [join(PLUGIN_ROOT, 'dist', 'linux-unpacked', 'huaanwork')]
  const found = candidates.find(candidate => existsSync(candidate))
  if (found === undefined) {
    throw new Error(
      `HUAANWORK_MIGRATION_SMOKE=1 but no package:dir artifact was found (checked ${candidates.join(', ')}); `
      + 'run `corepack yarn package:dir` or set HUAANWORK_MIGRATION_SMOKE_APP',
    )
  }
  return found
}

/** Electron 的 userData(config dir)在临时 HOME 下的位置,三平台同构。 */
function legacyUserDataDir(home: string): string {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'HuaAnWork')
  if (process.platform === 'win32') return join(home, 'AppData', 'Roaming', 'HuaAnWork')
  return join(home, '.config', 'HuaAnWork')
}

function writeZstdSession(dir: string, sessionId: string, cwd: string): void {
  mkdirSync(dir, { recursive: true })
  const header = JSON.stringify({
    type: 'session', version: 0, id: sessionId, createdAt: 1_700_000_000_000, cwd, delegationDepth: 0,
  })
  const body = [header, JSON.stringify({ type: 'turn', index: 0 })]
  writeFileSync(join(dir, 'session.jsonl.zstd'), Buffer.concat(body.map(line => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8')))))
}

interface SmokeTree {
  readonly root: string
  readonly home: string
  /** Electron userData 与旧 Tauri config dir:两个产品共用同一目录(F1)。 */
  readonly userDataDir: string
  /** 旧 Tauri `$DSH_HOME`:在 config dir 内,即迁移源树。 */
  readonly legacyDshHome: string
  /** 新 Desktop home:显式 `DSH_HOME`,即迁移目的树;必须独立于旧树。 */
  readonly newHome: string
}

/**
 * 在临时 HOME 下播种一份完整旧布局(同 end-to-end.spec 的形状,规模收敛),
 * 并预置两个与迁移正交、应用在真实「已有数据」的机器上必然已存在的状态:
 *
 * - 默认 profile 目录:零 profile 的 home 上应用冷启动会自行 materialize
 *   (profile-manager.ts `materializeDefaultDesktopProfile`);夹具用同一实现
 *   (`createDesktopWebProfile`)预置,让该目录属于「启动前已存在」的一批。
 * - Setup Wizard 完成标记:全新 profile 的首启 wizard 是**真实产品行为**,与
 *   迁移正交;无人值守运行须预置完成态(应用自身 `completeOrSkipDesktopSetupWizard`
 *   写出的同一 v2 状态),否则宿主在人工决策前不会启动(R1 发现 1)。
 *   两者必须同在:profile 目录若本次启动才出现,`main.ts` 会先清空该 profile
 *   的使用记录(`clearDesktopProfileUsageHistory`),单独预置的标记会被清掉。
 */
async function seedSmokeTree(): Promise<SmokeTree> {
  // 夹具根必须 realpath:Electron 解析 --user-data-dir 时会穿过 macOS 的
  // /var -> /private/var 符号链接,remint 会话的落盘路径断言依赖两侧文本路径一致。
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mig-smoke-')))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const userDataDir = legacyUserDataDir(home)
  // F1 的三个文件写在 config dir 下,而 mkdtemp 只创建了 root:先补建这一层。
  mkdirSync(userDataDir, { recursive: true })
  const legacyDshHome = join(userDataDir, 'dsh')
  const newHome = join(root, 'new-home')
  mkdirSync(newHome, { recursive: true })
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({
    base_url: 'http://127.0.0.1:11434/v1', model: 'llama3', api_key: 'k', theme: 'dark',
    models: [{ id: 'default', name: '默认', base_url: 'http://127.0.0.1:11434/v1', model: 'llama3', api_key: 'k' }], active_model_id: 'default', work_allow_network: true, guard_mode: 'smart',
    automation_timeout_ms: 600000, keep_awake: true, agents_host: '', agents_port: '',
    agents_catalog_token: '',
  }), 'utf8')
  writeFileSync(join(userDataDir, 'account.json'), JSON.stringify({
    username: 'u', salt: 's', hash: 'h', kdf: 'scrypt', N: 16384, r: 8, p: 1,
  }), 'utf8')
  writeFileSync(join(userDataDir, 'auth-session.json'), JSON.stringify({ username: 'u' }), 'utf8')
  mkdirSync(join(legacyDshHome, 'automations'), { recursive: true })
  writeFileSync(join(legacyDshHome, 'projects.json'), JSON.stringify({
    projects: [{ id: 'p1', name: 'proj', root: join(root, 'proj'), createdAt: 1 }],
  }), 'utf8')
  writeFileSync(join(legacyDshHome, 'automations.json'), JSON.stringify({
    automations: [{
      id: 'a1', projectId: null, name: 'auto', kind: 'agent', schedule: { kind: 'manual' },
      widget: false, enabled: true, createdAt: 1, channel: 'chat',
    }],
  }), 'utf8')
  writeFileSync(join(legacyDshHome, 'automations', 'a1.runs.jsonl'),
    `${JSON.stringify({ runId: 'r1', startedAt: 1, endedAt: 2, ok: true, output: 'ok' })}\n`, 'utf8')
  mkdirSync(join(legacyDshHome, 'workspace'), { recursive: true })
  writeFileSync(join(legacyDshHome, 'workspace', 'notes.md'), 'notes\n', 'utf8')
  const neutral = sessionIdFor(join(legacyDshHome, 'workspace'))
  writeZstdSession(join(legacyDshHome, 'sessions', projectKey(join(legacyDshHome, 'workspace')), neutral), neutral, join(legacyDshHome, 'workspace'))
  mkdirSync(join(legacyDshHome, 'profiles', 'huaanwork'), { recursive: true })
  writeFileSync(join(legacyDshHome, 'profiles', 'huaanwork', 'package.json'),
    JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['legacy-plugin'] } } }), 'utf8')
  // 预置默认 profile(应用冷启动的同一 materialize 路径)与它的 wizard 完成标记。
  const profileDir = createDesktopWebProfile(newHome, 'desktop').dir
  // 版本字段与应用 setupWizardVersions 同源:插件 package.json(electron-runtime.ts
  // `desktopProductVersion` 读的就是它,这里不能引 electron 模块)+ 已安装的
  // @deepseek-ai/dsh;setupRevision 取产品常量。字段仅作诊断,门只判「状态存在」。
  const desktopVersion = (JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')) as { version: string }).version
  await completeOrSkipDesktopSetupWizard(userDataDir, profileDir, 'completed', {
    desktopVersion,
    dshVersion: dshProductVersion(),
    setupRevision: desktopSetupWizardStateConstants.setupRevision,
  })
  return { root, home, userDataDir, legacyDshHome, newHome }
}

function snapshotTree(root: string): Map<string, string> {
  const snapshot = new Map<string, string>()
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(dir, entry.name)
      const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        snapshot.set(`${key}/`, 'dir')
        walk(path, key)
      } else if (entry.isFile()) {
        snapshot.set(key, createHash('sha256').update(readFileSync(path)).digest('hex'))
      }
    }
  }
  walk(root, '')
  return snapshot
}

/** 旧数据全量快照:旧 `$DSH_HOME` 整树 + config dir 内只属于旧版的三个文件。 */
function snapshotLegacySource(source: HuaanworkLegacySource): Map<string, string> {
  const snapshot = snapshotTree(source.dshHome)
  for (const name of ['settings.json', 'account.json', 'auth-session.json']) {
    const path = join(source.configDir, name)
    if (existsSync(path)) snapshot.set(`config-dir/${name}`, createHash('sha256').update(readFileSync(path)).digest('hex'))
  }
  return snapshot
}

async function waitFor<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(done => setTimeout(done, 500))
  }
}

/** marker 落在活动 profile:轮询 `<DSH_HOME>/profiles/<name>/huaanwork-migration.json`。 */
function findMigratedProfile(dshHome: string): { dir: string; marker: HuaanworkMigrationMarker } | undefined {
  let names: string[]
  try {
    names = readdirSync(join(dshHome, 'profiles'))
  } catch {
    return undefined
  }
  for (const name of names) {
    const markerPath = join(dshHome, 'profiles', name, MIGRATION_MARKER_FILENAME)
    if (!existsSync(markerPath)) continue
    return { dir: join(dshHome, 'profiles', name), marker: JSON.parse(readFileSync(markerPath, 'utf8')) as HuaanworkMigrationMarker }
  }
  return undefined
}

/** 宿主已监听:任一 loopback 端口给出 HTTP 响应(403 也算,见文件头层级标注)。 */
async function hostResponds(): Promise<number | undefined> {
  for (let port = FIRST_WEB_PORT; port <= LAST_WEB_PORT; port += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/`, { signal: AbortSignal.timeout(500) })
      void response.status
      return port
    } catch {
      // 端口未监听或未响应;继续扫下一个。
    }
  }
  return undefined
}

describeLive('legacy migration against a real packaged layout', () => {
  it('migrates a seeded tree under the real DSH_HOME and boots the host afterwards', async () => {
    const app = locatePackagedApp()
    const tree = await seedSmokeTree()
    const source = resolveLegacySource(tree.userDataDir)
    // 旧树 = config dir 内三个文件 + `<config dir>/dsh`(paths.ts);新 home 是另一个临时根,
    // 旧树与新 home 不得同根,否则迁移源与目的树重叠(旧 fixture 的缺陷)。
    expect(source.dshHome).toBe(tree.legacyDshHome)
    expect(tree.newHome).not.toBe(tree.legacyDshHome)
    // 快照只覆盖旧版专属部分:config dir 是新旧共享目录(F1),运行中的应用合法地
    // 往其中写 Electron/新应用自己的文件(Cookies、Preferences、profile-selection…)。
    const legacySnapshot = snapshotLegacySource(source)

    let log = ''
    // macOS 下 userData 不跟随 HOME(文件头实测),迁移源 = userData ⇒ 用 Chromium 开关把它指到播种目录。
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tree.home,
      USERPROFILE: tree.home,
      DSH_HOME: tree.newHome,
      ...(process.platform === 'linux' ? { XDG_CONFIG_HOME: join(tree.home, '.config') } : {}),
    }
    // A parent Electron or test runner may export this. Leaving it set makes the
    // packaged binary start as Node and reject --user-data-dir (exit 9).
    delete childEnv.ELECTRON_RUN_AS_NODE
    const child: ChildProcess = spawn(app, [`--user-data-dir=${tree.userDataDir}`], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    cleanup.push(() => { child.kill('SIGKILL') })
    child.stdout?.on('data', chunk => { log = (log + String(chunk)).slice(-16_000) })
    child.stderr?.on('data', chunk => { log = (log + String(chunk)).slice(-16_000) })
    child.on('exit', (code, signal) => { log += `\n[child exit code=${String(code)} signal=${String(signal)}]\n` })

    // 1. 旧树就位(源发现的前提):presence 判据与迁移同源。
    expect(existsSync(source.dshHome)).toBe(true)
    expect(existsSync(join(source.configDir, 'settings.json'))).toBe(true)

    // 2. 等迁移 marker(活动 profile 内,目的树 = 新 home):应用已跑完一次性迁移。
    let migrated: { dir: string; marker: HuaanworkMigrationMarker }
    try {
      migrated = await waitFor('the migration marker', () => findMigratedProfile(tree.newHome), BOOT_TIMEOUT_MS)
    } catch (error) {
      console.error(`APP_LOG\n${log}`)
      throw error
    }
    const profileDir = migrated.dir
    const marker = migrated.marker
    expect(marker.version).toBe(1)
    expect(marker.counts.settings).toBe(1)
    expect(marker.counts.sessions).toBeGreaterThanOrEqual(1)
    expect(marker.skipped).toContain('auth-session.json: intentionally expired')
    expect(marker.notMigrated).toContain('legacy-plugin')

    // 3. GET /huaanwork/settings|session/list|project/list|automation/list 背后的读侧(route handler 同函数)。
    const settings = await readHuaanworkSettings(profileDir)
    expect(settings.model).toBe('llama3')
    expect(settings.allow_network).toBe(true)

    const projects = await listProjects(profileDir)
    expect(projects.map(project => project.id)).toContain('p1')

    const automations = await listAutomations(profileDir)
    expect(automations.map(automation => automation.id)).toContain('a1')
    const rawAutomations = JSON.parse(readFileSync(join(profileDir, 'automations.json'), 'utf8')) as {
      automations: Array<Record<string, unknown>>
    }
    expect(rawAutomations.automations[0]).not.toHaveProperty('channel')

    // 4. 中性根会话已重铸,`session/list` 读到的就是它。
    const newNeutralRoot = neutralWorkspaceRoot(profileDir)
    const newNeutralId = sessionIdFor(newNeutralRoot)
    const remintedPath = join(tree.newHome, 'sessions', projectKey(newNeutralRoot), encodeSegment(newNeutralId), 'session.jsonl.zstd')
    expect(existsSync(remintedPath)).toBe(true)
    const header = JSON.parse(decompressZstdFrames(readFileSync(remintedPath)).split('\n', 1)[0] ?? '') as { id: string; cwd: string }
    expect(header.id).toBe(newNeutralId)
    expect(header.cwd).toBe(newNeutralRoot)

    // 5. AuthGate 处于 needs-login:账号已迁移、会话已过期(logged-out)。
    expect((await authStatus(profileDir)).state).toBe('logged-out')

    // 6. 宿主真的起来了(loopback 端口在服务),且旧版专属数据逐字节未动。
    const port = await waitFor('the host web server', hostResponds, BOOT_TIMEOUT_MS)
    expect(port).toBeGreaterThanOrEqual(FIRST_WEB_PORT)
    expect([...snapshotLegacySource(source).entries()]).toEqual([...legacySnapshot.entries()])
    void log // 失败诊断时人工查看;成功路径不消费。
  }, 300_000)
})
