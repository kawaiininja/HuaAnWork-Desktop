/**
 * wrapper market routes 测试(Step 6):R19 枚举清单逐一注册且总量恰 7;
 * state 自有形态(R14);catalog/installable/installations;preview/execute;
 * 单飞 409(R16);取消诚实 message(§14 #33);内网宕机诚实报错;
 * X1 跨源 tarball URL 拒绝;防重放三负例(旧 revision / notAfter 过期 / 跨 domain)。
 */
import { spawnSync } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { HUAANWORK_MARKET_ROUTES } from '../../src/huaanwork-host/market/index.ts'
import { MARKET_ROUTE_PATHS, MARKET_ROUTE_LIST, registerMarketRoutes } from '../../src/huaanwork-host/market/routes.ts'
import { IMMUTABLE_BUNDLES } from '../../src/huaanwork-host/plugins-host.ts'
import {
  createMarketHttpClient,
  fetchVerifiedManifest,
  type MarketHttpClient,
} from '../../src/huaanwork-host/market/catalog-client.ts'
import { fingerprintPublicKeyHex, type MarketManifest } from '../../src/huaanwork-host/market/verify.ts'
import {
  createMarketTestServer,
  createMemoryRevisionStore,
  loadSigningVectors,
  sha256Hex,
  signManifestForTest,
  type MarketTestServer,
} from './market-test-server.ts'

const NOW = Date.parse('2026-09-26T00:00:00Z')

const vectors = loadSigningVectors()
const PINS = {
  current: { publicKeyHex: vectors.keys.slot1.publicKeyHex },
  previous: {
    key: { publicKeyHex: vectors.keys.slot2.publicKeyHex },
    retiredAt: '2027-01-01T00:00:00Z',
  },
}

const roots: string[] = []
const servers: MarketTestServer[] = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close()
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function tempProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hw-market-routes-'))
  roots.push(dir)
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'profile',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, undefined, 2)}\n`)
  return dir
}

function buildTgz(dir: string, manifest: Record<string, unknown>): Buffer {
  const pkgDir = join(dir, 'package')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  const out = join(dir, 'out.tgz')
  const tar = spawnSync('tar', ['czf', out, 'package'], { cwd: dir, encoding: 'utf8' })
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`)
  return readFileSync(out)
}

function manifestFor(origin: string, revision: number, files: MarketManifest['files'], domain = origin): MarketManifest {
  return {
    envelope: {
      version: 1,
      domain,
      revision,
      issuedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
      notAfter: new Date(NOW + 6 * 24 * 60 * 60 * 1000).toISOString(),
    },
    catalog: {
      schemaVersion: '1.0.0',
      generatedAt: new Date(NOW).toISOString(),
      items: files.map(file => ({
        // provider-page 契约 id 形态:首字符须字母数字(round3 契约,market-server 同口径)。
        id: `${file.name.replace(/^@/u, '')}@${file.version}`,
        name: file.name,
        displayName: `Plugin ${file.name}`,
        summary: 'fixture package',
        package: { registry: 'npm', name: file.name },
        latestVersion: file.version,
      })),
      page: { total: files.length },
    },
    files,
  }
}

function activate(server: MarketTestServer, manifest: MarketManifest): void {
  server.setManifest(manifest, signManifestForTest(manifest, vectors.keys.slot1.privateKeyPem, 1))
}

// ---------------------------------------------------------------------------
// req/res mock(keep-awake-route.spec 同构)
// ---------------------------------------------------------------------------

function request(body: unknown, init: { method?: string; origin?: string } = {}): IncomingMessage {
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const headers: Record<string, string> = {
    host: '127.0.0.1:9',
    origin: init.origin ?? 'http://127.0.0.1:9',
    'content-length': String(raw.byteLength),
  }
  const req = {
    method: init.method ?? 'POST',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield raw
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
  return {
    res: res as unknown as ServerResponse,
    status: () => status,
    json: () => JSON.parse(raw),
  }
}

// GET 读:浏览器同源 GET 无 Origin 头——sec-fetch-site + referer 路径(loopback.ts)。
function getRequest(): IncomingMessage {
  const req = {
    method: 'GET',
    headers: {
      host: '127.0.0.1:9',
      'sec-fetch-site': 'same-origin',
      referer: 'http://127.0.0.1:9/',
    },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { /* empty */ },
  }
  return req as unknown as IncomingMessage
}

interface RecordedRoute { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }

function fakeCtx(overrides: Record<string, unknown> = {}): { ctx: Context; recorded: RecordedRoute[]; pnpmCalls: string[][] } {
  const recorded: RecordedRoute[] = []
  const pnpmCalls: string[][] = []
  const ctx = {
    webServer: {
      port: 9,
      register(route: RecordedRoute) {
        recorded.push(route)
        return () => {}
      },
    },
    desktopPnpm: {
      runPlugin(argv: readonly string[]) {
        pnpmCalls.push([...argv])
        return {
          stdout: { resume() {} },
          stderr: { resume() {} },
          done: Promise.resolve({ exitCode: 0, signal: null }),
          cancel() {},
        }
      },
    },
    desktopRuntime: {
      requestConfirmedRestart: async () => true,
    },
    ...overrides,
  } as unknown as Context
  return { ctx, recorded, pnpmCalls }
}

function depsFor(profileDir: string, origin: string, extra: Record<string, unknown> = {}) {
  return {
    profileDir,
    origin,
    pins: PINS,
    now: () => NOW,
    logger: () => {},
    ...extra,
  }
}

async function callRoute(recorded: RecordedRoute[], path: string, req: IncomingMessage): Promise<{ status: () => number; json: () => any }> {
  const route = recorded.find(entry => entry.path === path)
  if (route === undefined) throw new Error(`route not registered: ${path}`)
  const out = capture()
  route.handler(req, out.res)
  // handler 内是异步链(网络/子进程):轮询 mock res 的 end() 落点,最长 10s。
  const deadline = Date.now() + 10_000
  while (out.status() === 0 && Date.now() < deadline) {
    await new Promise(resolve => setImmediate(resolve))
  }
  if (out.status() === 0) throw new Error(`route handler did not finish: ${path}`)
  return out
}

function noTgzStaged(profileDir: string): boolean {
  const dir = join(profileDir, '.market-artifacts')
  if (!existsSync(dir)) return true
  return !readdirSync(dir).some(entry => entry.endsWith('.tgz'))
}

// ---------------------------------------------------------------------------

describe('HUAANWORK_MARKET_ROUTES 枚举清单(round3 R19)', () => {
  test('清单恰 7 条,逐一经 ctx.webServer 注册,总量恰等于清单', () => {
    expect(HUAANWORK_MARKET_ROUTES).toHaveLength(7)
    expect([...HUAANWORK_MARKET_ROUTES].sort()).toEqual([...MARKET_ROUTE_LIST].sort())
    const { ctx, recorded } = fakeCtx()
    registerMarketRoutes(ctx, depsFor('/tmp/nope', 'http://127.0.0.1:1'))
    expect(recorded).toHaveLength(HUAANWORK_MARKET_ROUTES.length)
    for (const path of HUAANWORK_MARKET_ROUTES) {
      expect(recorded.some(entry => entry.path === path && entry.kind === 'exact')).toBe(true)
    }
  })

  test('ROUTE_TABLE 不受影响(表外注册,69 不破)', async () => {
    const { ROUTE_TABLE } = await import('../../src/huaanwork-host/routes.ts')
    expect(ROUTE_TABLE).toHaveLength(69)
  })
})

describe('GET state(wrapper 自有形态,R14)', () => {
  test('reports origin, verification readiness and persisted revision without network', async () => {
    const { ctx, recorded } = fakeCtx()
    const revisions = createMemoryRevisionStore()
    revisions.map.set('http://127.0.0.1:1', 7)
    registerMarketRoutes(ctx, depsFor('/tmp/nope', 'http://127.0.0.1:1', { revisionStore: revisions.store }))
    const out = await callRoute(recorded, MARKET_ROUTE_PATHS.state, getRequest())
    expect(out.status()).toBe(200)
    expect(out.json()).toEqual({
      provider: 'huaanwork-market',
      origin: 'http://127.0.0.1:1',
      executing: false,
      verification: { ready: true, currentKeyId: fingerprintPublicKeyHex(vectors.keys.slot1.publicKeyHex) },
      catalog: { maxAcceptedRevision: 7 },
      desktopActions: { requestRestart: true },
    })
  })

  test('exposes the single-flight executing flag for in-flight install recovery (D13)', async () => {
    // 在飞安装跨 view 卸载/重挂的自恢复信号:execute 持有互斥期间 /state 必须如实
    // 报 executing=true(客户端据此显示进行中标识并轮询),完成后复位为 false。
    const server = await createMarketTestServer()
    servers.push(server)
    const profileDir = tempProfile()
    const buildDir = mkdtempSync(join(tmpdir(), 'hw-market-state-exec-'))
    roots.push(buildDir)
    const bytes = buildTgz(buildDir, { name: '@huaanwork/sample', version: '1.2.3' })
    server.addArtifact('/artifacts/a.tgz', bytes)
    const manifest = manifestFor(server.origin, 1, [{
      name: '@huaanwork/sample', version: '1.2.3', sha256: sha256Hex(bytes), tarballPath: '/artifacts/a.tgz', size: bytes.byteLength,
    }])
    activate(server, manifest)
    let release!: (bytes: Buffer) => void
    const gate = new Promise<Buffer>((resolvePromise) => { release = resolvePromise })
    const http: MarketHttpClient = {
      fetchText: async (url) => (await fetch(url)).text(),
      fetchStream: async (_url, _label, _maxBytes, onChunk) => {
        const bytes = await gate
        await onChunk(bytes)
        return { bytes: bytes.byteLength }
      },
    }
    const { ctx, recorded } = fakeCtx()
    registerMarketRoutes(ctx, depsFor(profileDir, server.origin, { http }))
    const first = callRoute(recorded, MARKET_ROUTE_PATHS.execute, request({ name: '@huaanwork/sample', version: '1.2.3' }))
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    const inFlight = await callRoute(recorded, MARKET_ROUTE_PATHS.state, getRequest())
    expect(inFlight.status()).toBe(200)
    expect((inFlight.json() as { executing: boolean }).executing).toBe(true)
    release(bytes)
    await first
    const settled = await callRoute(recorded, MARKET_ROUTE_PATHS.state, getRequest())
    expect((settled.json() as { executing: boolean }).executing).toBe(false)
  })
})

describe('GET catalog / installable / installations', () => {
  test('catalog returns the normalized snapshot with wrapper-forged provenance', async () => {
    const server = await createMarketTestServer()
    servers.push(server)
    const profileDir = tempProfile()
    const manifest = manifestFor(server.origin, 1, [{
      name: '@huaanwork/sample', version: '1.2.3', sha256: '0'.repeat(64), tarballPath: '/artifacts/a.tgz', size: 1,
    }])
    activate(server, manifest)
    const { ctx, recorded } = fakeCtx()
    registerMarketRoutes(ctx, depsFor(profileDir, server.origin))
    const out = await callRoute(recorded, MARKET_ROUTE_PATHS.catalog, getRequest())
    expect(out.status()).toBe(200)
    const snapshot = out.json()
    expect(snapshot.schemaVersion).toBe('1.0.0')
    expect(snapshot.source.providerId).toBe('huaanwork-market')
    expect(snapshot.source.finalUrl).toBe(server.origin)
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0].provenance).toEqual({
      sourceRecordId: 'huaanwork-intranet',
      providerId: 'huaanwork-market',
      itemId: 'huaanwork/sample@1.2.3',
    })
  })

  test('installations reuses listPlugins semantics (dsh.profile.bundles) + the host immutable set (P26)', async () => {
    const profileDir = tempProfile()
    const { ctx, recorded } = fakeCtx()
    registerMarketRoutes(ctx, depsFor(profileDir, 'http://127.0.0.1:1'))
    const out = await callRoute(recorded, MARKET_ROUTE_PATHS.installations, getRequest())
    expect(out.status()).toBe(200)
    const body = out.json() as { bundles: string[]; immutable: string[] }
    expect(body.bundles).toEqual(['@deepseek-ai/dsh-base'])
    // P26(M6 Task 6.10):客户端据 `immutable` 灰化移除按钮——随应用/市场分发的
    // carrier 必须在列(名单真相源是 IMMUTABLE_BUNDLES,客户端不复制)。名字按
    // profile 清单的真实形态(brief 简写的 dsh-web-app/dsh-desktop-app 实为带
    // scope 的 @deepseek-ai/ 形态,见 app-boot profile.ts:140)。
    expect(body.immutable).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-desktop-app',
      'dsh-community-market',
      'huaanwork-market',
    ]))
    // 下发的就是卸载写路径(plugin.remove)用的那个集合本身:不是第二份手抄名单。
    expect(new Set(body.immutable)).toEqual(new Set(IMMUTABLE_BUNDLES))
  })

  test('installable marks installed packages from profile dependencies', async () => {
    const server = await createMarketTestServer()
    servers.push(server)
    const profileDir = tempProfile()
    const manifest = manifestFor(server.origin, 1, [
      { name: '@huaanwork/onboard', version: '1.0.0', sha256: '0'.repeat(64), tarballPath: '/artifacts/on.tgz', size: 1 },
      { name: '@huaanwork/fresh', version: '2.0.0', sha256: '1'.repeat(64), tarballPath: '/artifacts/fr.tgz', size: 1 },
    ])
    activate(server, manifest)
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      dependencies: { '@huaanwork/onboard': 'file:/x/on.tgz' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    })}\n`)
    const { ctx, recorded } = fakeCtx()
    registerMarketRoutes(ctx, depsFor(profileDir, server.origin))
    const out = await callRoute(recorded, MARKET_ROUTE_PATHS.installable, getRequest())
    expect(out.status()).toBe(200)
    const items = out.json().items
    expect(items.find((i: any) => i.name === '@huaanwork/onboard').installed).toBe(true)
    expect(items.find((i: any) => i.name === '@huaanwork/fresh').installed).toBe(false)
  })
})

describe('内网宕机诚实报错', () => {
  test('catalog/installable surface an honest 502 when the intranet is down', async () => {
    const profileDir = tempProfile()
    const { ctx, recorded } = fakeCtx()
    // 指向一个必然不可达的 loopback 端口。
    registerMarketRoutes(ctx, depsFor(profileDir, 'http://127.0.0.1:1'))
    const catalog = await callRoute(recorded, MARKET_ROUTE_PATHS.catalog, getRequest())
    expect(catalog.status()).toBe(502)
    expect(catalog.json().error.code).toBe('market-unreachable')
    expect(catalog.json().error.message).toMatch(/内网市场不可达|unreachable/u)
    // state 不触网,仍诚实可读(客户端据此给出本地 tab 旁路提示)。
    const state = await callRoute(recorded, MARKET_ROUTE_PATHS.state, getRequest())
    expect(state.status()).toBe(200)
  })
})

describe('POST operations/preview + execute(单飞 R16 / X1 / 取消诚实)', () => {
  test('preview returns the signed tarball target pinned to the configured origin', async () => {
    const server = await createMarketTestServer()
    servers.push(server)
    const profileDir = tempProfile()
    const manifest = manifestFor(server.origin, 1, [{
      name: '@huaanwork/sample', version: '1.2.3', sha256: '0'.repeat(64), tarballPath: '/artifacts/a.tgz', size: 42,
    }])
    activate(server, manifest)
    const { ctx, recorded } = fakeCtx()
    registerMarketRoutes(ctx, depsFor(profileDir, server.origin))
    // 先查不存在的包(每次读都拉取验签;验签通过即持久化 revision)。
    const missing = await callRoute(recorded, MARKET_ROUTE_PATHS.preview, request({ name: 'nope', version: '1.0.0' }))
    expect(missing.status()).toBe(404)
    // 2026-09-26 裁定(§14 第十轮 第 49 条):等值 revision = 当前清单幂等重读,
    // 同一 revision store 下第二次拉取照常放行——catalog → preview 可共享一次激活。
    const out = await callRoute(recorded, MARKET_ROUTE_PATHS.preview, request({ name: '@huaanwork/sample', version: '1.2.3' }))
    expect(out.status()).toBe(200)
    expect(out.json().tarballUrl).toBe(`${server.origin}/artifacts/a.tgz`)
  })

  test('execute installs the verified artifact and answers in plugin.add shape', async () => {
    const server = await createMarketTestServer()
    servers.push(server)
    const profileDir = tempProfile()
    const buildDir = mkdtempSync(join(tmpdir(), 'hw-market-exec-'))
    roots.push(buildDir)
    const bytes = buildTgz(buildDir, { name: '@huaanwork/sample', version: '1.2.3' })
    const sha256 = sha256Hex(bytes)
    server.addArtifact('/artifacts/a.tgz', bytes)
    const manifest = manifestFor(server.origin, 1, [{
      name: '@huaanwork/sample', version: '1.2.3', sha256, tarballPath: '/artifacts/a.tgz', size: bytes.byteLength,
    }])
    activate(server, manifest)
    const { ctx, recorded, pnpmCalls } = fakeCtx()
    registerMarketRoutes(ctx, depsFor(profileDir, server.origin))
    const out = await callRoute(recorded, MARKET_ROUTE_PATHS.execute, request({ name: '@huaanwork/sample', version: '1.2.3' }))
    expect(out.status()).toBe(200)
    expect(out.json().restarting).toBe(true)
    expect(Array.isArray(out.json().bundles)).toBe(true)
    // argv 恒带 --offline --ignore-scripts(N2/兜底);绝不带 --registry。
    expect(pnpmCalls).toEqual([['add', join(profileDir, '.market-artifacts', `huaanwork-sample-1.2.3-${sha256.slice(0, 12)}.tgz`), '--offline', '--ignore-scripts']])
    // 网络层同源断言:catalog/签名/制品三处请求全部落在配置 origin。
    for (const path of server.requestedUrls) {
      expect(path.startsWith('/')).toBe(true)
    }
    // 远程安装不触公网:请求 host 全部是 127.0.0.1 mock(本条由 mock origin 保证)。
  })

  // P14:夹具里早已接好的 tamperNextArtifact 一直零调用——「下载途中篡改」负例
  // 此前只在单元层用 fakeHttp 覆盖(market-install.spec.ts 把清单 sha 换成 f*64
  // 模拟)。此处走**真实 HTTP 服务端换字节**,校验的才是「清单 sha256 是真制品的、
  // 传输中被换成另一份合法 tarball」这一真实攻击形态。
  test('execute rejects bytes swapped in transit by the real server (P14)', async () => {
    const server = await createMarketTestServer()
    servers.push(server)
    const profileDir = tempProfile()
    const goodDir = mkdtempSync(join(tmpdir(), 'hw-market-tamper-good-'))
    const badDir = mkdtempSync(join(tmpdir(), 'hw-market-tamper-bad-'))
    roots.push(goodDir, badDir)
    const bytes = buildTgz(goodDir, { name: '@huaanwork/sample', version: '1.2.3' })
    // 篡改后的字节仍是一个**结构合法**的 tarball(否则测到的是解包失败而非 sha 不符)。
    const tampered = buildTgz(badDir, { name: '@huaanwork/sample', version: '1.2.3', dependencies: { lodash: '^4.0.0' } })
    const sha256 = sha256Hex(bytes)
    expect(sha256Hex(tampered)).not.toBe(sha256)

    server.addArtifact('/artifacts/a.tgz', bytes)
    const manifest = manifestFor(server.origin, 1, [{
      name: '@huaanwork/sample', version: '1.2.3', sha256, tarballPath: '/artifacts/a.tgz', size: bytes.byteLength,
    }])
    activate(server, manifest)
    server.tamperNextArtifact('/artifacts/a.tgz', tampered)

    const { ctx, recorded, pnpmCalls } = fakeCtx()
    registerMarketRoutes(ctx, depsFor(profileDir, server.origin))
    const out = await callRoute(recorded, MARKET_ROUTE_PATHS.execute, request({ name: '@huaanwork/sample', version: '1.2.3' }))

    expect(out.status()).toBe(400)
    expect(out.json().error.code).toBe('market-sha256-mismatch')
    // 不落盘、不安装:pnpm 一次都没被调用,制品目录里没有该制品(被校验字节 ≠
    // 传输所得字节 ⇒ 绝不让它进入 profile)。
    expect(pnpmCalls).toEqual([])
    expect(existsSync(join(profileDir, '.market-artifacts', `huaanwork-sample-1.2.3-${sha256.slice(0, 12)}.tgz`))).toBe(false)
  })

  test('execute is single-flight: a concurrent execute gets 409 (R16)', async () => {
    const server = await createMarketTestServer()
    servers.push(server)
    const profileDir = tempProfile()
    const buildDir = mkdtempSync(join(tmpdir(), 'hw-market-sf-'))
    roots.push(buildDir)
    const bytes = buildTgz(buildDir, { name: '@huaanwork/sample', version: '1.2.3' })
    server.addArtifact('/artifacts/a.tgz', bytes)
    const manifest = manifestFor(server.origin, 1, [{
      name: '@huaanwork/sample', version: '1.2.3', sha256: sha256Hex(bytes), tarballPath: '/artifacts/a.tgz', size: bytes.byteLength,
    }])
    activate(server, manifest)

    // fetchStream 挂起 → 第一个 execute 持有互斥;第二个必须 409。
    let release!: (bytes: Buffer) => void
    const gate = new Promise<Buffer>((resolvePromise) => { release = resolvePromise })
    const http: MarketHttpClient = {
      fetchText: async (url) => (await fetch(url)).text(),
      fetchStream: async (_url, _label, _maxBytes, onChunk) => {
        const bytes = await gate
        await onChunk(bytes)
        return { bytes: bytes.byteLength }
      },
    }
    const { ctx, recorded } = fakeCtx()
    registerMarketRoutes(ctx, depsFor(profileDir, server.origin, { http }))
    const first = callRoute(recorded, MARKET_ROUTE_PATHS.execute, request({ name: '@huaanwork/sample', version: '1.2.3' }))
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    const second = await callRoute(recorded, MARKET_ROUTE_PATHS.execute, request({ name: '@huaanwork/sample', version: '1.2.3' }))
    expect(second.status()).toBe(409)
    expect(second.json().error.code).toBe('market-execute-busy')
    release(bytes)
    const firstOut = await first
    expect(firstOut.status()).toBe(200)
  })

  test('single-flight flag is set before the first await: a same-tick duplicate is rejected (D8 TOCTOU)', async () => {
    const server = await createMarketTestServer()
    servers.push(server)
    const profileDir = tempProfile()
    const buildDir = mkdtempSync(join(tmpdir(), 'hw-market-sf-tick-'))
    roots.push(buildDir)
    const bytes = buildTgz(buildDir, { name: '@huaanwork/sample', version: '1.2.3' })
    server.addArtifact('/artifacts/a.tgz', bytes)
    const manifest = manifestFor(server.origin, 1, [{
      name: '@huaanwork/sample', version: '1.2.3', sha256: sha256Hex(bytes), tarballPath: '/artifacts/a.tgz', size: bytes.byteLength,
    }])
    activate(server, manifest)

    let release!: (bytes: Buffer) => void
    const gate = new Promise<Buffer>((resolvePromise) => { release = resolvePromise })
    const http: MarketHttpClient = {
      fetchText: async (url) => (await fetch(url)).text(),
      fetchStream: async (_url, _label, _maxBytes, onChunk) => {
        const bytes = await gate
        await onChunk(bytes)
        return { bytes: bytes.byteLength }
      },
    }
    const { ctx, recorded } = fakeCtx()
    registerMarketRoutes(ctx, depsFor(profileDir, server.origin, { http }))
    const route = recorded.find(entry => entry.path === MARKET_ROUTE_PATHS.execute)
    if (route === undefined) throw new Error('execute route not registered')

    // 评审 D8 的窗口:两个 execute 在同一 tick 内背靠背派发(两个 fetch 并发、
    // 或 UI 双击),第二个绝不得通过互斥检查——修复前置位在 readBody 的 await
    // 之后,两个都会通过。此处刻意不插任何 setImmediate。
    const first = capture()
    const second = capture()
    route.handler(request({ name: '@huaanwork/sample', version: '1.2.3' }), first.res)
    route.handler(request({ name: '@huaanwork/sample', version: '1.2.3' }), second.res)

    const deadline = Date.now() + 10_000
    while (second.status() === 0 && Date.now() < deadline) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(second.status()).toBe(409)
    expect(second.json().error.code).toBe('market-execute-busy')
    // 第一个仍持有互斥(挂在 gate 上),未完成。
    expect(first.status()).toBe(0)

    release(bytes)
    while (first.status() === 0 && Date.now() < deadline + 10_000) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(first.status()).toBe(200)
  })

  test('cancelled restart answers with the honest not-effective message (§14 #33)', async () => {
    const server = await createMarketTestServer()
    servers.push(server)
    const profileDir = tempProfile()
    const buildDir = mkdtempSync(join(tmpdir(), 'hw-market-cancel-'))
    roots.push(buildDir)
    const bytes = buildTgz(buildDir, { name: '@huaanwork/sample', version: '1.2.3' })
    server.addArtifact('/artifacts/a.tgz', bytes)
    const manifest = manifestFor(server.origin, 1, [{
      name: '@huaanwork/sample', version: '1.2.3', sha256: sha256Hex(bytes), tarballPath: '/artifacts/a.tgz', size: bytes.byteLength,
    }])
    activate(server, manifest)
    const { ctx, recorded } = fakeCtx({
      desktopRuntime: { requestConfirmedRestart: async () => false },
    })
    registerMarketRoutes(ctx, depsFor(profileDir, server.origin))
    const out = await callRoute(recorded, MARKET_ROUTE_PATHS.execute, request({ name: '@huaanwork/sample', version: '1.2.3' }))
    expect(out.status()).toBe(200)
    expect(out.json().restarting).toBeUndefined()
    expect(out.json().message).toMatch(/已取消重启/u)
  })

  test('cross-origin tarball URL in the signed manifest is rejected (X1)', async () => {
    const server = await createMarketTestServer()
    servers.push(server)
    const profileDir = tempProfile()
    const manifest = manifestFor(server.origin, 1, [{
      name: '@huaanwork/sample', version: '1.2.3', sha256: '0'.repeat(64), tarballPath: 'http://evil.intranet.example:9999/artifacts/a.tgz', size: 1,
    }])
    activate(server, manifest)
    const { ctx, recorded } = fakeCtx()
    registerMarketRoutes(ctx, depsFor(profileDir, server.origin))
    const out = await callRoute(recorded, MARKET_ROUTE_PATHS.execute, request({ name: '@huaanwork/sample', version: '1.2.3' }))
    expect(out.status()).toBe(400)
    expect(out.json().error.code).toBe('market-artifact-origin')
    expect(noTgzStaged(profileDir)).toBe(true)
  })

  test('non-zero-dependency tarball is rejected by the install gate ((c), nothing staged)', async () => {
    const server = await createMarketTestServer()
    servers.push(server)
    const profileDir = tempProfile()
    const buildDir = mkdtempSync(join(tmpdir(), 'hw-market-dep-'))
    roots.push(buildDir)
    const bytes = buildTgz(buildDir, { name: '@huaanwork/sample', version: '1.2.3', dependencies: { ms: '^2.1.3' } })
    server.addArtifact('/artifacts/a.tgz', bytes)
    const manifest = manifestFor(server.origin, 1, [{
      name: '@huaanwork/sample', version: '1.2.3', sha256: sha256Hex(bytes), tarballPath: '/artifacts/a.tgz', size: bytes.byteLength,
    }])
    activate(server, manifest)
    const { ctx, recorded } = fakeCtx()
    registerMarketRoutes(ctx, depsFor(profileDir, server.origin))
    const out = await callRoute(recorded, MARKET_ROUTE_PATHS.execute, request({ name: '@huaanwork/sample', version: '1.2.3' }))
    expect(out.status()).toBe(400)
    expect(out.json().error.message).toMatch(/dependencies must be empty/u)
    expect(noTgzStaged(profileDir)).toBe(true)
  })

  test('lifecycle-script tarball is rejected by the install gate ((c))', async () => {
    const server = await createMarketTestServer()
    servers.push(server)
    const profileDir = tempProfile()
    const buildDir = mkdtempSync(join(tmpdir(), 'hw-market-script-'))
    roots.push(buildDir)
    const bytes = buildTgz(buildDir, { name: '@huaanwork/sample', version: '1.2.3', scripts: { postinstall: 'curl evil' } })
    server.addArtifact('/artifacts/a.tgz', bytes)
    const manifest = manifestFor(server.origin, 1, [{
      name: '@huaanwork/sample', version: '1.2.3', sha256: sha256Hex(bytes), tarballPath: '/artifacts/a.tgz', size: bytes.byteLength,
    }])
    activate(server, manifest)
    const { ctx, recorded } = fakeCtx()
    registerMarketRoutes(ctx, depsFor(profileDir, server.origin))
    const out = await callRoute(recorded, MARKET_ROUTE_PATHS.execute, request({ name: '@huaanwork/sample', version: '1.2.3' }))
    expect(out.status()).toBe(400)
    expect(out.json().error.message).toMatch(/scripts\.postinstall/u)
  })
})

describe('防重放三负例(信封 revision / notAfter / domain)', () => {
  async function serveAndFetch(server: MarketTestServer, manifest: MarketManifest): Promise<any> {
    const profileDir = tempProfile()
    activate(server, manifest)
    const { ctx, recorded } = fakeCtx()
    registerMarketRoutes(ctx, depsFor(profileDir, server.origin))
    const out = await callRoute(recorded, MARKET_ROUTE_PATHS.catalog, getRequest())
    expect(out.status()).toBe(502)
    expect(out.json().error.code).toBe('market-verification-failed')
    return out.json()
  }

  test('old revision replay is rejected after a newer one was accepted', async () => {
    const server = await createMarketTestServer()
    servers.push(server)
    const profileDir = tempProfile()
    const revisions = createMemoryRevisionStore()
    const deps = depsFor(profileDir, server.origin, { revisionStore: revisions.store })
    const files = [{ name: 'a', version: '1.0.0', sha256: '0'.repeat(64), tarballPath: '/artifacts/a.tgz', size: 1 }]
    const { ctx, recorded } = fakeCtx()
    registerMarketRoutes(ctx, deps)

    const fresh = manifestFor(server.origin, 2, files)
    activate(server, fresh)
    const ok = await callRoute(recorded, MARKET_ROUTE_PATHS.catalog, getRequest())
    expect(ok.status()).toBe(200)
    expect(revisions.map.get(server.origin)).toBe(2)

    // 重放旧 revision 1(重签合法签名):必须被 revision-regression 拒。
    const stale = manifestFor(server.origin, 1, files)
    activate(server, stale)
    const replayed = await callRoute(recorded, MARKET_ROUTE_PATHS.catalog, getRequest())
    expect(replayed.status()).toBe(502)
    expect(replayed.json().error.message).toMatch(/reason=revision-regression/u)
  })

  test('expired notAfter manifest is rejected', async () => {
    const server = await createMarketTestServer()
    servers.push(server)
    const manifest = manifestFor(server.origin, 1, [{
      name: 'a', version: '1.0.0', sha256: '0'.repeat(64), tarballPath: '/artifacts/a.tgz', size: 1,
    }])
    const expired: MarketManifest = {
      ...manifest,
      envelope: {
        ...manifest.envelope,
        // TTL 恰 7 天(含界,过 ttl-cap 门)但窗口整体在过去 → expired。
        issuedAt: new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString(),
        notAfter: new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
      },
    }
    const out = await serveAndFetch(server, expired)
    expect(out.error.message).toMatch(/reason=expired/u)
  })

  test('cross-domain whole-manifest replay is rejected', async () => {
    const server = await createMarketTestServer()
    servers.push(server)
    const manifest = manifestFor(server.origin, 1, [{
      name: 'a', version: '1.0.0', sha256: '0'.repeat(64), tarballPath: '/artifacts/a.tgz', size: 1,
    }], 'http://other.intranet.example:8787')
    const out = await serveAndFetch(server, manifest)
    expect(out.error.message).toMatch(/reason=domain-mismatch/u)
  })
})

describe('POST desktop/request-restart', () => {
  test('confirmed restart proxies the runtime; cancel answers honestly', async () => {
    const { ctx, recorded } = fakeCtx()
    registerMarketRoutes(ctx, depsFor('/tmp/nope', 'http://127.0.0.1:1'))
    const yes = await callRoute(recorded, MARKET_ROUTE_PATHS.requestRestart, request({}))
    expect(yes.status()).toBe(200)
    expect(yes.json()).toEqual({ restarting: true })

    const ctxNo = fakeCtx({ desktopRuntime: { requestConfirmedRestart: async () => false } })
    registerMarketRoutes(ctxNo.ctx, depsFor('/tmp/nope', 'http://127.0.0.1:1'))
    const no = await callRoute(ctxNo.recorded, MARKET_ROUTE_PATHS.requestRestart, request({}))
    expect(no.status()).toBe(200)
    expect(no.json().restarting).toBe(false)
    // §14 第 33 条:取消 ≠ 未生效——变更已保存,下次启动照常生效(不再回裸「已取消重启」)。
    expect(no.json().message).toContain('已取消重启')
    expect(no.json().message).toContain('下次启动时生效')
    expect(no.json().message).not.toContain('未生效')
  })

  /**
   * P3(Task 6.9):独立 restart 路由无安装/卸载语境(待生效变更可能是增也可能是删),
   * 故取增删皆准的中立句(「变更已保存」);但它必须与 plugins-host 的两处取消分支
   * 引用**同一个**导出常量——路由源码内不再有裸字面量,应答的「已取消重启」前缀
   * 只能来自共享常量(本文件只扫 routes.ts;plugins-host.ts 侧由其自测钉住)。
   */
  test('P3: the cancel copy is the shared exported constant, not a bare「已取消重启」', async () => {
    const module = (await import('../../src/huaanwork-host/plugins-host.ts')) as unknown as Record<string, unknown>
    const shared = module.RESTART_CANCELLED_MESSAGES as Record<string, string> | undefined
    expect(shared?.pending).toBe('已取消重启：变更已保存，下次启动时生效')

    const { ctx, recorded } = fakeCtx({ desktopRuntime: { requestConfirmedRestart: async () => false } })
    registerMarketRoutes(ctx, depsFor('/tmp/nope', 'http://127.0.0.1:1'))
    const out = await callRoute(recorded, MARKET_ROUTE_PATHS.requestRestart, request({}))
    expect(out.json().message).toBe(shared?.pending)

    const routesSource = readFileSync(resolve(import.meta.dirname, '../../src/huaanwork-host/market/routes.ts'), 'utf8')
    expect(routesSource).toContain('RESTART_CANCELLED_MESSAGES')
    expect(routesSource).not.toContain('已取消重启')
  })
})

describe('P19/P20: signed-manifest shape guard and the consumer-less revision field', () => {
  const singleFile = () => [{ name: 'a', version: '1.0.0', sha256: '0'.repeat(64), tarballPath: '/artifacts/a.tgz', size: 1 }]

  /**
   * P19:清单按合法形状构造(catalog.items 由 files 派生)并**真实签名**后再把
   * `files` 换成非数组——canonicalJson 能序列化该值,故验签通过,命中的是形状路径。
   * 修复前:`installable`(`.map`)抛裸 TypeError → 500 internal;修复后:具名错误码。
   */
  test('P19: a signed manifest whose files field is not an array fails with a named error code', async () => {
    const server = await createMarketTestServer()
    servers.push(server)
    const manifest = {
      ...manifestFor(server.origin, 1, singleFile()),
      files: 'nope',
    } as unknown as MarketManifest
    activate(server, manifest)
    const { ctx, recorded } = fakeCtx()
    registerMarketRoutes(ctx, depsFor(tempProfile(), server.origin))

    const installable = await callRoute(recorded, MARKET_ROUTE_PATHS.installable, getRequest())
    expect(installable.status()).toBe(502)
    expect(installable.json().error.code).toBe('market-manifest-files')
    expect(installable.json().error.message).not.toMatch(/TypeError/u)

    // preview(`.find`)与 installable(`.map`)是 manifest.files 仅有的两处消费点。
    const preview = await callRoute(recorded, MARKET_ROUTE_PATHS.preview, request({ name: 'a', version: '1.0.0' }))
    expect(preview.status()).toBe(502)
    expect(preview.json().error.code).toBe('market-manifest-files')
  })

  test('P19: file entries that are not objects fail with the same named code', async () => {
    const server = await createMarketTestServer()
    servers.push(server)
    // `[null]` 修复前同样抛裸 TypeError(`file.name` 解引用);条目形状与数组形状同码。
    const manifest = {
      ...manifestFor(server.origin, 1, singleFile()),
      files: [null],
    } as unknown as MarketManifest
    activate(server, manifest)
    const { ctx, recorded } = fakeCtx()
    registerMarketRoutes(ctx, depsFor(tempProfile(), server.origin))

    const out = await callRoute(recorded, MARKET_ROUTE_PATHS.installable, getRequest())
    expect(out.status()).toBe(502)
    expect(out.json().error.code).toBe('market-manifest-files')
  })

  /**
   * P20:`VerifiedManifest.revisionAdvanced` 零消费方(全仓 grep 见 Task 6.9 报告),
   * 删除后返回值只剩三键;字段仍在时本断言红(对象携带、`Object.keys` 可见)。
   */
  test('P20: VerifiedManifest carries no field without a consumer', async () => {
    const server = await createMarketTestServer()
    servers.push(server)
    activate(server, manifestFor(server.origin, 1, singleFile()))
    const verified = await fetchVerifiedManifest({
      origin: server.origin,
      pins: PINS,
      revisionStore: createMemoryRevisionStore().store,
      now: NOW,
      http: createMarketHttpClient(),
    })
    expect(Object.keys(verified).sort()).toEqual(['manifest', 'signature', 'slot'])
  })
})
