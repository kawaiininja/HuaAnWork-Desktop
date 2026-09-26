/**
 * wrapper 离线端到端(Step 5/6 命名矩阵):真实 pnpm + 密封 store/cache,经
 * 「mock 内网源 → wrapper execute → addPlugin(制品, {offline:true}) → 真 pnpm
 * --offline --ignore-scripts」全链。断网等价性由 --offline 机制强制(封死网络
 * 路径)+ 密封 store/cache(与机器缓存状态无关)双证;mock 源在 127.0.0.1,
 * 除配置 origin 外零外联。
 *
 * 覆盖:装 A → 装 B → 卸 A → 卸 B 四步(N1 唯一有效回归门)+ 每个 file: 路径
 * 存在断言;依赖数 +1 机械校验(N3);add argv 恒带 --offline --ignore-scripts、
 * remove argv 永不带(N2);无 --registry;无批准键写入;制品 GC(装后不删、卸后删);
 * 密封兜底负例(带依赖制品直喂 addPlugin({offline:true}) 确定性失败且不污染);
 * 带 build 脚本制品经市场链 ⇒ 脚本零执行痕迹(ERR_PNPM_IGNORED_BUILDS 或装成但
 * 无 POSTINSTALL_RAN,对 pnpm 版本漂移免疫);装坏包无自动回滚(§14 #25,恢复
 * 窗口由 main.ts 的 routeDesktopStartupFailure/openStartupRecoveryWindow 承接)。
 */
import { spawnSync } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { routeDesktopStartupFailure } from '../../src/startup-failure-routing.ts'
import { addPlugin, removePlugin } from '../../src/huaanwork-host/plugins-host.ts'
import { MARKET_ROUTE_PATHS, registerMarketRoutes } from '../../src/huaanwork-host/market/routes.ts'
import type { MarketManifest } from '../../src/huaanwork-host/market/verify.ts'
import {
  combinedOutput,
  createMarketSandbox,
  disposeAllMarketSandboxes,
  fileReferenceExists,
  fileReferenceFor,
  pnpmSemanticsProbe,
  type MarketSandbox,
} from './market-pnpm-fixture.ts'
import {
  createMarketTestServer,
  createMemoryRevisionStore,
  loadSigningVectors,
  signManifestForTest,
  type MarketTestServer,
} from './market-test-server.ts'

const probe = pnpmSemanticsProbe()
const suite = probe.supported ? describe : describe.skip

const NOW = Date.parse('2026-09-26T00:00:00Z')
const vectors = loadSigningVectors()
const PINS = { current: { publicKeyHex: vectors.keys.slot1.publicKeyHex } }

const servers: MarketTestServer[] = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close()
  disposeAllMarketSandboxes()
})

// ---------------------------------------------------------------------------
// pnpm-backed runPlugin 桩:真实 pnpm + 密封 store/cache,argv 原样转发并记录。
// ---------------------------------------------------------------------------

interface PnpmStub { pnpm: { runPlugin(argv: readonly string[], invokingDir: string): any }; calls: string[][] }

function sealedPnpmStub(sandbox: MarketSandbox): PnpmStub {
  const calls: string[][] = []
  return {
    calls,
    pnpm: {
      runPlugin(argv: readonly string[], invokingDir: string) {
        calls.push([...argv])
        const run = spawnSync('pnpm', [...argv, '--store-dir', sandbox.storeDir, '--cache-dir', sandbox.cacheDir], {
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

function runtimeStub(confirmed: boolean) {
  return { requestConfirmedRestart: async () => confirmed }
}

function routeCtxFor(sandbox: MarketSandbox, stub: PnpmStub, confirmed = true) {
  return {
    profileDir: sandbox.profileDir,
    logger: () => {},
    desktopPnpm: stub.pnpm,
    requestRestart: () => Promise.resolve(confirmed),
  }
}

// ---------------------------------------------------------------------------
// req/res mock(market-routes.spec 同构)
// ---------------------------------------------------------------------------

function request(body: unknown): IncomingMessage {
  const raw = Buffer.from(JSON.stringify(body))
  const req = {
    method: 'POST',
    headers: { host: '127.0.0.1:9', origin: 'http://127.0.0.1:9', 'content-length': String(raw.byteLength) },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield raw
    },
  }
  return req as unknown as IncomingMessage
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

interface RecordedRoute { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }

async function callRoute(recorded: RecordedRoute[], path: string, req: IncomingMessage): Promise<{ status: () => number; json: () => any }> {
  const route = recorded.find(entry => entry.path === path)
  if (route === undefined) throw new Error(`route not registered: ${path}`)
  const out = capture()
  route.handler(req, out.res)
  const deadline = Date.now() + 120_000
  while (out.status() === 0 && Date.now() < deadline) {
    await new Promise(resolve => setImmediate(resolve))
  }
  if (out.status() === 0) throw new Error(`route ${path} did not finish`)
  return out
}

async function callExecute(recorded: RecordedRoute[], body: { name: string; version: string }): Promise<{ status: () => number; json: () => any }> {
  return callRoute(recorded, MARKET_ROUTE_PATHS.execute, request(body))
}

// ---------------------------------------------------------------------------

async function serveSignedManifest(server: MarketTestServer, sandbox: MarketSandbox, packages: { name: string; version: string }[], revision = 1): Promise<void> {
  const files = packages.map(pkg => {
    const built = sandbox.buildTarball({ name: pkg.name, version: pkg.version })
    const tarballPath = `/artifacts/${pkg.name.replace(/^@/u, '').replace(/\//u, '-')}-${pkg.version}.tgz`
    server.addArtifact(tarballPath, readFileSync(built.path))
    return {
      name: pkg.name,
      version: pkg.version,
      sha256: built.sha256,
      tarballPath,
      size: existsSync(built.path) ? readFileSync(built.path).byteLength : 0,
    }
  })
  const manifest: MarketManifest = {
    envelope: {
      version: 1,
      domain: server.origin,
      revision,
      issuedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
      notAfter: new Date(NOW + 6 * 24 * 60 * 60 * 1000).toISOString(),
    },
    catalog: {
      schemaVersion: '1.0.0',
      generatedAt: new Date(NOW).toISOString(),
      items: files.map(file => ({
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
  server.setManifest(manifest, signManifestForTest(manifest, vectors.keys.slot1.privateKeyPem, 1))
}

function registerExecuteRoutes(sandbox: MarketSandbox, server: MarketTestServer, stub: PnpmStub): RecordedRoute[] {
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
    desktopRuntime: runtimeStub(true),
  } as unknown as Context
  registerMarketRoutes(fake, {
    profileDir: sandbox.profileDir,
    origin: server.origin,
    pins: PINS,
    now: () => NOW,
    revisionStore: createMemoryRevisionStore().store,
    logger: () => {},
  })
  return recorded
}

function workspaceYamlSnapshot(sandbox: MarketSandbox): string {
  return readFileSync(join(sandbox.profileDir, 'pnpm-workspace.yaml'), 'utf8')
}

function noApprovalKeys(sandbox: MarketSandbox): boolean {
  const yaml = workspaceYamlSnapshot(sandbox)
  return !yaml.includes('onlyBuiltDependencies') && !yaml.includes('allowBuilds')
}

suite('wrapper 离线端到端(解法 A 全链,真实 pnpm + 密封 store/cache)', () => {
  test('装 A → 装 B → 卸 A → 卸 B 四步全绿,每步依赖数恰 +1,file: 引用全程在盘', async () => {
    const sandbox = createMarketSandbox()
    const server = await createMarketTestServer()
    servers.push(server)
    await serveSignedManifest(server, sandbox, [
      { name: 'huaanwork-plugin-a', version: '1.0.0' },
      { name: 'huaanwork-plugin-b', version: '2.0.0' },
    ])
    const stub = sealedPnpmStub(sandbox)
    const recorded = registerExecuteRoutes(sandbox, server, stub)
    const workspaceBefore = workspaceYamlSnapshot(sandbox)

    const tgzCount = () => readdirSync(sandbox.artifactsDir).filter(entry => entry.endsWith('.tgz')).length

    // ── 一次激活下 catalog → preview → execute 全链(2026-09-26 裁定,§14 第十轮
    //    第 49 条):等值 revision = 当前清单幂等重读,每次读都拉取验签(N8)但
    //    不再要求逐次供给更新清单。 ──
    const catalog = await callRoute(recorded, MARKET_ROUTE_PATHS.catalog, getRequest())
    expect(catalog.status()).toBe(200)
    expect(catalog.json().items).toHaveLength(2)
    const previewA = await callRoute(recorded, MARKET_ROUTE_PATHS.preview, request({ name: 'huaanwork-plugin-a', version: '1.0.0' }))
    expect(previewA.status()).toBe(200)
    expect(previewA.json().tarballUrl).toBe(`${server.origin}/artifacts/huaanwork-plugin-a-1.0.0.tgz`)

    // ── 装 A ──
    const installA = await callExecute(recorded, { name: 'huaanwork-plugin-a', version: '1.0.0' })
    expect(installA.status()).toBe(200)
    expect(installA.json().restarting).toBe(true)
    expect(Object.keys(sandbox.readProfileDependencies())).toHaveLength(1)
    expect(existsSync(join(sandbox.profileDir, 'node_modules', 'huaanwork-plugin-a', 'package.json'))).toBe(true)
    expect(fileReferenceExists(sandbox.profileDir, sandbox.readProfileDependencies())).toBe(true)

    // ── 装 B(同一激活下的幂等重读;制品 A 必须仍在盘——N1:file: 引用共存亡)──
    const installB = await callExecute(recorded, { name: 'huaanwork-plugin-b', version: '2.0.0' })
    expect(installB.status()).toBe(200)
    expect(Object.keys(sandbox.readProfileDependencies())).toHaveLength(2)
    expect(tgzCount()).toBe(2)
    expect(fileReferenceExists(sandbox.profileDir, sandbox.readProfileDependencies())).toBe(true)

    // ── 卸 A(remove argv 永不带 flag;制品 A 被 GC,制品 B 不受影响)──
    const removeA = await removePlugin(routeCtxFor(sandbox, stub), 'huaanwork-plugin-a')
    expect(removeA.restarting).toBe(true)
    const afterA = sandbox.readProfileDependencies()
    expect(Object.keys(afterA)).toHaveLength(1)
    expect(afterA['huaanwork-plugin-a']).toBeUndefined()
    expect(fileReferenceFor(afterA, 'huaanwork-plugin-b')).toBeDefined()
    expect(fileReferenceExists(sandbox.profileDir, afterA)).toBe(true)
    expect(tgzCount()).toBe(1)

    // ── 卸 B(回归空态)──
    const removeB = await removePlugin(routeCtxFor(sandbox, stub), 'huaanwork-plugin-b')
    expect(removeB.restarting).toBe(true)
    expect(Object.keys(sandbox.readProfileDependencies())).toHaveLength(0)
    expect(tgzCount()).toBe(0)

    // ── argv 形状:install 恒带 --offline --ignore-scripts;remove 永不带;
    //    全程无 --registry、无 runExternalMarketPluginInstall(该函数不在链上)。──
    const addCalls = stub.calls.filter(call => call[0] === 'add')
    const removeCalls = stub.calls.filter(call => call[0] === 'remove')
    expect(addCalls).toHaveLength(2)
    for (const call of addCalls) {
      expect(call[2]).toBe('--offline')
      expect(call[3]).toBe('--ignore-scripts')
      expect(call[1]!.endsWith('.tgz')).toBe(true)
      expect(call.some(arg => arg.includes('--registry'))).toBe(false)
    }
    expect(removeCalls).toHaveLength(2)
    for (const call of removeCalls) {
      expect(call).toEqual(['remove', call[1]!])
      expect(call.some(arg => arg === '--offline' || arg === '--ignore-scripts')).toBe(false)
    }

    // ── 市场流程零批准键写入(workspace yaml 逐字不变)。──
    expect(workspaceYamlSnapshot(sandbox)).toBe(workspaceBefore)
    expect(noApprovalKeys(sandbox)).toBe(true)
    // 网络层同源断言:全部请求都在配置 origin 路径空间内(无外链 URL)。
    for (const path of server.requestedUrls) {
      expect(path.startsWith('/')).toBe(true)
    }
  }, 180_000)

  test('卸载取消:清单已写入,诚实 message,下次自然重启照常生效(§14 #33)', async () => {
    const sandbox = createMarketSandbox()
    const server = await createMarketTestServer()
    servers.push(server)
    await serveSignedManifest(server, sandbox, [{ name: 'huaanwork-plugin-a', version: '1.0.0' }])
    const stub = sealedPnpmStub(sandbox)
    const recorded = registerExecuteRoutes(sandbox, server, stub)

    const install = await callExecute(recorded, { name: 'huaanwork-plugin-a', version: '1.0.0' })
    expect(install.status()).toBe(200)

    // 用户取消重启:remove 已写清单,message 诚实告知不重启 ≠ 未生效。
    const cancelled = await removePlugin(routeCtxFor(sandbox, stub, false), 'huaanwork-plugin-a')
    expect(cancelled.restarting).toBeUndefined()
    expect(cancelled.message).toMatch(/已取消重启/u)
    // 清单确实已写入(取消不回滚)。
    expect(sandbox.readProfileDependencies()['huaanwork-plugin-a']).toBeUndefined()
    expect(stub.calls.filter(call => call[0] === 'remove')).toHaveLength(1)
  }, 120_000)

  test('装坏包:wrapper 无自动回滚,恢复窗口由启动失败路由承接(§14 #25)', async () => {
    const sandbox = createMarketSandbox()
    const server = await createMarketTestServer()
    servers.push(server)
    // 制品本身过全部安装门(零依赖/无脚本),但其 bundle 行在 boot 期 row 断言下
    // 会失败——安装链**不**自动回滚:profile 变更与制品都保留,由下次启动的
    // routeDesktopStartupFailure → openStartupRecoveryWindow(slot 还原)承接。
    await serveSignedManifest(server, sandbox, [{ name: 'huaanwork-bad-bundle', version: '1.0.0' }])
    const stub = sealedPnpmStub(sandbox)
    const recorded = registerExecuteRoutes(sandbox, server, stub)

    const install = await callExecute(recorded, { name: 'huaanwork-bad-bundle', version: '1.0.0' })
    expect(install.status()).toBe(200)
    expect(install.json().restarting).toBe(true)

    // 无自动回滚:依赖与制品均在盘(boot 失败 ≠ 安装链撤销)。
    expect(sandbox.readProfileDependencies()['huaanwork-bad-bundle']).toBeDefined()
    expect(readdirSync(sandbox.artifactsDir).some(entry => entry.endsWith('.tgz'))).toBe(true)

    // 启动恢复窗口的承接路由(main.ts:1776-1812 消费的判定表;窗口本体是
    // Electron 面,单测不可达,既有 startup-recovery-window.spec 覆盖)。
    expect(routeDesktopStartupFailure({ appReady: true, stage: 'host-boot' })).toBe('startup-recovery')
    expect(routeDesktopStartupFailure({ appReady: false, stage: 'shell-environment' })).toBe('stderr-only')
  }, 120_000)

  test('密封兜底负例:绕过预检的带依赖制品直喂 addPlugin({offline:true}) 确定性失败且不污染 profile(N3)', async () => {
    const sandbox = createMarketSandbox()
    const before = sandbox.readProfileManifestRaw()
    // 模拟「双门失准」的制品:带依赖(正常会被 wrapper 预检拒,这里直喂 addPlugin)。
    const built = sandbox.buildTarball({ name: 'probe-dep-ful', version: '1.0.0', dependencies: { ms: '^2.1.3' } })
    const stub = sealedPnpmStub(sandbox)

    await expect(addPlugin(routeCtxFor(sandbox, stub), built.path, { offline: true }))
      .rejects.toThrow(/dsh plugin add failed \(exit [1-9]/u)
    // 冷 store/冷元数据镜像下 --offline 解析确定性失败;profile 逐字节不变。
    expect(sandbox.readProfileManifestRaw()).toBe(before)
    expect(Object.keys(sandbox.readProfileDependencies())).toHaveLength(0)
    expect(existsSync(join(sandbox.profileDir, 'node_modules', 'ms'))).toBe(false)
    // argv 双 flag 在、--registry 不在。
    const addCall = stub.calls.find(call => call[0] === 'add')!
    expect(addCall).toContain('--offline')
    expect(addCall).toContain('--ignore-scripts')
    expect(addCall.some(arg => arg.includes('--registry'))).toBe(false)
    expect(noApprovalKeys(sandbox)).toBe(true)
  }, 120_000)

  test('带 build 脚本制品经市场链:脚本零执行痕迹(ERR_PNPM_IGNORED_BUILDS 或无痕迹装成,版本漂移免疫)', async () => {
    // 市场链安装门会拒 lifecycle 脚本(routes 层负例已锁);本条模拟「断言失准」
    // 直喂 addPlugin:要么 --ignore-scripts 装成但 POSTINSTALL_RAN 不存在,
    // 要么 pnpm 11 以 ERR_PNPM_IGNORED_BUILDS 硬失败——两种形态均无执行痕迹。
    const sandbox = createMarketSandbox()
    const built = sandbox.buildTarball({
      name: 'probe-scripted',
      version: '1.0.0',
      scripts: { postinstall: 'touch POSTINSTALL_RAN' },
    })
    const stub = sealedPnpmStub(sandbox)

    let outcome: { exitCode: number; output: string }
    try {
      await addPlugin(routeCtxFor(sandbox, stub), built.path, { offline: true })
      outcome = { exitCode: 0, output: '' }
    } catch (error) {
      // runDesktopPlugin 只回 exit code;重跑一次拿输出断言 IGNORED_BUILDS 形态。
      const run = spawnSync('pnpm', ['add', built.path, '--offline', '--ignore-scripts', '--store-dir', sandbox.storeDir, '--cache-dir', sandbox.cacheDir], {
        cwd: sandbox.profileDir,
        encoding: 'utf8',
        env: { ...process.env, CI: 'true' },
      })
      outcome = { exitCode: run.status ?? -1, output: combinedOutput({ exitCode: run.status ?? -1, stdout: run.stdout ?? '', stderr: run.stderr ?? '' }) }
      expect(outcome.exitCode).not.toBe(0)
    }
    if (outcome.exitCode !== 0) {
      expect(outcome.output).toContain('ERR_PNPM_IGNORED_BUILDS')
    }
    const marker = join(sandbox.profileDir, 'node_modules', 'probe-scripted', 'POSTINSTALL_RAN')
    expect(existsSync(marker)).toBe(false)
    expect(noApprovalKeys(sandbox)).toBe(true)
  }, 120_000)
})
