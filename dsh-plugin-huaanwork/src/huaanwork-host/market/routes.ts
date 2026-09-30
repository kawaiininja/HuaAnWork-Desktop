/**
 * huaanwork-market wrapper 消费面 routes(M5 Task 5 Step 2)。
 *
 * 表外注册(守则 5):7 条 routes 经 `ctx.webServer.register` 自注册,不进
 * ROUTE_TABLE / NATIVE_ROUTES(54 不破;keep-awake 先例)。模块级路径常量 +
 * index.ts 的 `HUAANWORK_MARKET_ROUTES` 可测枚举清单:spec 断言清单内 route
 * 逐一注册、总量恰 7(round3 R19)。
 *
 * 客户端同源 loopback 约束(keep-awake/desktop-settings-route 同口径):
 * GET 读可凭 same-origin fetch metadata;POST 变更必须带精确 Origin 头。
 *
 * 应答形态:安装/卸载应答键名与 M4 plugin.add/remove 一致({bundles,
 * restarting?, message?});state/catalog 为 **wrapper 自有形态**(round3 R14,
 * 不复用上游 Market*Response);远程安装额外过「验签(含防重放)+ origin 钉扎 +
 * sha256 比对 + 零依赖与无脚本预检」四道门 + `--offline --ignore-scripts` 兜底。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { parseCatalogProviderPage } from 'dsh-community-market/contracts'
import type { ConfirmedRestartRuntime } from '../../host-runtime-bridge.ts'
import type { DesktopPnpm } from '../../pnpm.ts'
import { isSameOriginLoopbackRequest } from '../loopback.ts'
import { IMMUTABLE_BUNDLES, listPlugins, PluginCommandError, RESTART_CANCELLED_MESSAGES } from '../plugins-host.ts'
import { readJsonBody, RouteError } from '../routes.ts'
import { readProfileDependencies } from './artifacts.ts'
import {
  createFileRevisionStore,
  fetchVerifiedManifest,
  MarketFetchError,
  resolveSameOriginUrl,
  type MarketHttpClient,
  type MarketRevisionStore,
  type VerifiedManifest,
} from './catalog-client.ts'
import {
  assertMarketVerificationReady,
  PINS_AT_RELEASE,
  type MarketVerificationPins,
} from './config.ts'
import { fingerprintPublicKeyHex } from './verify.ts'
import {
  downloadAndStageArtifact,
  executeMarketInstall,
  MarketInstallGateError,
} from './install.ts'
import { normalizeProviderPageToSnapshot } from './normalize.ts'
import type { MarketManifestFile } from './verify.ts'

/** 表外 market routes(round3 R19 枚举清单;index.ts re-export 为 HUAANWORK_MARKET_ROUTES)。 */
export const MARKET_ROUTE_PATHS = {
  state: '/api/huaanwork-market/state',
  catalog: '/api/huaanwork-market/catalog',
  installable: '/api/huaanwork-market/installable',
  installations: '/api/huaanwork-market/installations',
  preview: '/api/huaanwork-market/operations/preview',
  execute: '/api/huaanwork-market/operations/execute',
  requestRestart: '/api/huaanwork-market/desktop/request-restart',
} as const

export const MARKET_ROUTE_LIST: readonly string[] = Object.freeze(Object.values(MARKET_ROUTE_PATHS))

/** 路由依赖(测试可注入:pins/now/revisionStore/http/logger——PINS_AT_RELEASE 默认为空 = 恒拒)。 */
export interface MarketRouteDeps {
  readonly profileDir: string
  readonly origin: string
  readonly pins?: MarketVerificationPins
  readonly now?: () => number
  readonly revisionStore?: MarketRevisionStore
  readonly http?: MarketHttpClient
  readonly logger?: (message: string) => void
}

interface MarketRouteServices {
  readonly deps: Required<Pick<MarketRouteDeps, 'origin' | 'now' | 'logger'>> & MarketRouteDeps
  readonly profileDir: string
  readonly pnpm: Pick<DesktopPnpm, 'runPlugin'>
  readonly runtime: ConfirmedRestartRuntime
  readonly revisionStore: MarketRevisionStore
  readonly executing: { current: boolean }
}

function finishJson(res: ServerResponse, statusCode: number, value: unknown, allow?: 'GET' | 'POST'): void {
  res.statusCode = statusCode
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  if (allow !== undefined) res.setHeader('allow', allow)
  res.end(JSON.stringify(value))
}

function sendRouteError(res: ServerResponse, error: RouteError, allow?: 'GET' | 'POST'): void {
  finishJson(res, error.status, { error: { code: error.code, message: error.message } }, allow)
}

function toRouteError(error: unknown, logger: (message: string) => void): RouteError {
  if (error instanceof RouteError) return error
  if (error instanceof PluginCommandError) return new RouteError(error.status, error.code, error.message)
  if (error instanceof MarketFetchError) return new RouteError(error.status, error.code, error.message)
  if (error instanceof MarketInstallGateError) return new RouteError(400, error.code, error.message)
  // 未预期错误(fs 故障、TypeError 等)一律 500 + 通用文案,细节只进日志(评审 P1):
  // ① 这类是**服务端**故障,答 400 会让客户端与运维误判为调用方错误;
  // ② `error.message` 可能含 profileDir 绝对路径(如 install.ts 的落盘失败),
  //    不该原样回给渲染进程。已知具名错误类走上面的分支,其 message 是刻意
  //    为用户/运维编写的,不含路径,保留可诊断性(评审 D12)。
  logger(`huaanwork-market: unexpected route error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  return new RouteError(500, 'internal', 'Internal Server Error')
}

function guardLoopback(req: IncomingMessage, expectedOrigin: string, mutating: boolean): RouteError | undefined {
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, mutating)) {
    return new RouteError(403, 'forbidden', 'forbidden')
  }
  return undefined
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  try {
    return await readJsonBody(req)
  } catch (cause) {
    throw cause instanceof RouteError ? cause : new RouteError(400, 'bad-request', 'invalid JSON body')
  }
}

function bodyString(body: unknown, key: string): string | undefined {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function verified(services: MarketRouteServices): Promise<VerifiedManifest> {
  return fetchVerifiedManifest({
    origin: services.deps.origin,
    pins: services.deps.pins ?? PINS_AT_RELEASE,
    revisionStore: services.revisionStore,
    now: services.deps.now(),
    ...(services.deps.http !== undefined ? { http: services.deps.http } : {}),
  })
}

function findManifestFile(verifiedManifest: VerifiedManifest, name: string, version: string): MarketManifestFile {
  const entry = verifiedManifest.manifest.files.find((file) => file.name === name && file.version === version)
  if (entry === undefined) {
    throw new RouteError(404, 'market-package-not-found', `market catalog has no signed artifact for ${name}@${version}`)
  }
  return entry
}

function installedNames(profileDir: string): Set<string> {
  return new Set(Object.keys(readProfileDependencies(profileDir)))
}

async function handleState(services: MarketRouteServices, res: ServerResponse): Promise<void> {
  // wrapper 自有形态(round3 R14):本地事实 + 信任锚状态,不触网(intranet 宕机时仍诚实可读)。
  let ready = true
  let currentKeyId: string | undefined
  try {
    const key = assertMarketVerificationReady(services.deps.pins ?? PINS_AT_RELEASE)
    currentKeyId = fingerprintPublicKeyHex(key.publicKeyHex)
  } catch {
    ready = false
  }
  finishJson(res, 200, {
    provider: 'huaanwork-market',
    origin: services.deps.origin,
    // 单飞标志（D13 轮询恢复）：客户端挂载读到 true ⇒ 显示「安装进行中」
    // 标识并轮询至完成——在飞安装跨 view 卸载/重挂后仍可自恢复。
    executing: services.executing.current,
    verification: {
      ready,
      ...(currentKeyId !== undefined ? { currentKeyId } : {}),
    },
    catalog: {
      maxAcceptedRevision: services.revisionStore.loadMaxRevision(services.deps.origin) ?? null,
    },
    desktopActions: { requestRestart: true },
  })
}

async function handleCatalog(services: MarketRouteServices, res: ServerResponse): Promise<void> {
  const fetched = await verified(services)
  // 契约负载经上游 parseCatalogProviderPage 自校(不自造方言);旁挂信封剥离后 parse。
  const page = parseCatalogProviderPage(fetched.manifest.catalog)
  finishJson(res, 200, normalizeProviderPageToSnapshot(page, services.deps.origin, new Date(services.deps.now()).toISOString()))
}

async function handleInstallable(services: MarketRouteServices, res: ServerResponse): Promise<void> {
  const fetched = await verified(services)
  const installed = installedNames(services.profileDir)
  const page = parseCatalogProviderPage(fetched.manifest.catalog)
  const displayOf = new Map<string, Record<string, unknown>>()
  for (const item of page.items) {
    if (typeof item.name === 'string') displayOf.set(item.name, item as Record<string, unknown>)
  }
  const items = fetched.manifest.files.map((file) => {
    const display = displayOf.get(file.name) ?? {}
    const displayName = typeof display.displayName === 'string' ? display.displayName : undefined
    const summary = typeof display.summary === 'string' ? display.summary : undefined
    return {
      id: `${file.name}@${file.version}`,
      name: file.name,
      version: file.version,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(summary !== undefined ? { summary } : {}),
      sha256: file.sha256,
      size: file.size,
      installed: installed.has(file.name),
    }
  })
  finishJson(res, 200, { items })
}

async function handleInstallations(services: MarketRouteServices, res: ServerResponse): Promise<void> {
  // 复用 plugins-host 的 listPlugins 语义(M4 口径:bundles 读 dsh.profile.bundles),
  // 并带上 host 的权威不可移除集合(P26,M6 Task 6.10):客户端据此灰化移除按钮并
  // 给出说明。名单**只有这一个真相源**(plugins-host.ts 的 IMMUTABLE_BUNDLES)——
  // 下发全量集合而非过滤后的子集,判定留在客户端逐条做;旧客户端忽略该字段、
  // 旧 wrapper 无此字段时各自保持既有行为。不新增 route(恒 7 条),只扩应答字段。
  finishJson(res, 200, { ...listPlugins(services.profileDir), immutable: [...IMMUTABLE_BUNDLES] })
}

async function handlePreview(services: MarketRouteServices, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req)
  const name = bodyString(body, 'name')
  const version = bodyString(body, 'version')
  if (name === undefined || version === undefined) {
    throw new RouteError(400, 'bad-request', 'market preview requires params.name and params.version')
  }
  const fetched = await verified(services)
  const entry = findManifestFile(fetched, name, version)
  // X1:预览即同源钉扎(execute 复跑同判定,fail-closed 两处一致)。
  const tarballUrl = resolveSameOriginUrl(services.deps.origin, entry.tarballPath)
  finishJson(res, 200, {
    name: entry.name,
    version: entry.version,
    sha256: entry.sha256,
    size: entry.size,
    tarballUrl,
  })
}

async function handleExecute(services: MarketRouteServices, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 单飞互斥(round3 R16):进行中的 execute 重复调用一律 409,绝不并发改 profile。
  // 置位必须先于任何 await(评审 D8):检查与置位之间让出事件循环即 TOCTOU——
  // 同一 tick 内并发派发的两个 execute 会都通过检查、都置位、都跑完整条链。
  if (services.executing.current) {
    throw new RouteError(409, 'market-execute-busy', 'another market install is already running')
  }
  services.executing.current = true
  try {
    const body = await readBody(req)
    const name = bodyString(body, 'name')
    const version = bodyString(body, 'version')
    if (name === undefined || version === undefined) {
      throw new RouteError(400, 'bad-request', 'market execute requires params.name and params.version')
    }
    const fetched = await verified(services)
    const entry = findManifestFile(fetched, name, version)
    const prepared = await downloadAndStageArtifact({
      origin: services.deps.origin,
      file: entry,
      profileDir: services.profileDir,
      ...(services.deps.http !== undefined ? { http: services.deps.http } : {}),
    })
    services.deps.logger(`huaanwork-market: staged verified artifact ${prepared.artifactPath} (${prepared.sha256})`)
    const result = await executeMarketInstall({
      profileDir: services.profileDir,
      logger: services.deps.logger,
      pnpm: services.pnpm,
      runtime: services.runtime,
    }, prepared)
    finishJson(res, 200, result)
  } finally {
    services.executing.current = false
  }
}

async function handleRequestRestart(services: MarketRouteServices, res: ServerResponse): Promise<void> {
  const confirmed = await services.runtime.requestConfirmedRestart()
  if (!confirmed) {
    // P3(Task 6.9):取消 ≠ 未生效(spec §14 第 33 条)。本路由无安装/卸载语境,
    // 故回共享常量里的中立句(「变更已保存」);字面量只活在 RESTART_CANCELLED_MESSAGES。
    finishJson(res, 200, { restarting: false, message: RESTART_CANCELLED_MESSAGES.pending })
    return
  }
  finishJson(res, 200, { restarting: true })
}

/**
 * 注册 7 条表外 market routes(返回 dispose)。ctx 消费 webServer/desktopPnpm/
 * desktopRuntime;deps 注入测试缝(pins/now/revisionStore/http/logger/profileDir/origin)。
 */
export function registerMarketRoutes(ctx: Context, deps: MarketRouteDeps): () => void {
  const services: MarketRouteServices = {
    deps: {
      ...deps,
      pins: deps.pins ?? PINS_AT_RELEASE,
      now: deps.now ?? (() => Date.now()),
      logger: deps.logger ?? (() => {}),
    },
    profileDir: deps.profileDir,
    pnpm: (ctx as { desktopPnpm: Pick<DesktopPnpm, 'runPlugin'> }).desktopPnpm,
    runtime: ctx.desktopRuntime as ConfirmedRestartRuntime,
    revisionStore: deps.revisionStore ?? createFileRevisionStore(deps.profileDir, deps.logger ?? (() => {})),
    executing: { current: false },
  }
  const expectedOrigin = () => `http://127.0.0.1:${ctx.webServer.port}`
  const disposers: (() => void)[] = []
  const register = (
    path: string,
    method: 'GET' | 'POST',
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ): void => {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => {
        void (async () => {
          if (req.method !== method) {
            return sendRouteError(res, new RouteError(405, 'method-not-allowed', 'method not allowed'), method)
          }
          const guard = guardLoopback(req, expectedOrigin(), method === 'POST')
          if (guard !== undefined) return sendRouteError(res, guard, method)
          try {
            await handler(req, res)
          } catch (error) {
            sendRouteError(res, toRouteError(error, services.deps.logger), method)
          }
        })()
      },
    }))
  }

  register(MARKET_ROUTE_PATHS.state, 'GET', async (_req, res) => handleState(services, res))
  register(MARKET_ROUTE_PATHS.catalog, 'GET', async (_req, res) => handleCatalog(services, res))
  register(MARKET_ROUTE_PATHS.installable, 'GET', async (_req, res) => handleInstallable(services, res))
  register(MARKET_ROUTE_PATHS.installations, 'GET', async (_req, res) => handleInstallations(services, res))
  register(MARKET_ROUTE_PATHS.preview, 'POST', async (req, res) => handlePreview(services, req, res))
  register(MARKET_ROUTE_PATHS.execute, 'POST', async (req, res) => handleExecute(services, req, res))
  register(MARKET_ROUTE_PATHS.requestRestart, 'POST', async (_req, res) => handleRequestRestart(services, res))

  return () => {
    while (disposers.length > 0) disposers.pop()!()
  }
}
