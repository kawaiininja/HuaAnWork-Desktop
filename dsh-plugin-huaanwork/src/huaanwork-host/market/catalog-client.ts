/**
 * huaanwork-market catalog client + 每源 revision 持久化(M5 Task 5 Step 1)。
 *
 * **自有 HTTP client**(market-face-spec〈市场面规范〉):只向配置的内网 origin 发
 * 请求(node:http/node:https 流式,无第三方依赖);绕开上游 restricted-http 的公网
 * 防线(该防线对公网社区市场正确,内网 plain-http 由离线签名 + wrapper 验签背书)。
 * plain http 内网可用——真实性靠签名,不靠 TLS。
 *
 * 每次读都是「拉取 + 验签」,**无 catalog 缓存**(round5 N8 裁定 (a)):revision 单调
 * 使重放无效,缓存只会放大被绕过的窗口。
 *
 * 链路:`GET /v1/manifest` + `GET /v1/manifest/signature` → verify.ts 三输入两槽验签
 * (信封:domain = 配置 origin、revision genuinely older 才拒(`<` 持久化最大值;
 * 等值 = 当前清单幂等重读,放行——final-review 裁定 2026-09-26,spec §14 第十轮
 * 第 49 条)、notAfter 未过期)——任一不满足即拒,**不信任其中任何 sha256** → 通过
 * 后才更新每源持久化 max revision(防重放判定的持久事实;仅当推进时写盘)。
 */

import { get as httpGet, type IncomingMessage } from 'node:http'
import { get as httpsGet } from 'node:https'
import { renameSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MarketVerificationPins } from './config.ts'
import { ensureMarketArtifactsDir } from './artifacts.ts'
import {
  verifyMarketManifest,
  type MarketManifest,
  type MarketManifestSignature,
  type VerificationVerdict,
} from './verify.ts'

/** 拉取/验签失败的具名错误——routes 层映射为诚实的 HTTP 错误应答。 */
export class MarketFetchError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
    readonly code: string = 'market-unreachable',
  ) {
    super(message)
    this.name = 'MarketFetchError'
  }
}

/** 请求超时(内网服务挂死时诚实失败,不无限挂起)。 */
export const MARKET_HTTP_TIMEOUT_MS = 15_000

/** 单次响应体上限(清单与制品都走这条路;制品由 install.ts 另设更高上限)。 */
export const MARKET_JSON_MAX_BYTES = 4 * 1024 * 1024

interface OriginParts { readonly protocol: 'http:' | 'https:'; readonly host: string }

function originParts(origin: string): OriginParts {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new MarketFetchError(`configured market origin is not a URL: ${origin}`, 500, 'market-config')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MarketFetchError(`configured market origin must be http(s): ${origin}`, 500, 'market-config')
  }
  return { protocol: url.protocol, host: url.host }
}

/**
 * 把(服务端相对的)tgz 路径解析为绝对 URL,并**同源钉扎**(round4 X1,守则 8):
 * 只接受配置 origin 下的路径/URL——跨源即拒,fail-closed,catalog 拉取与制品
 * 下载两处共用本判定。
 */
export function resolveSameOriginUrl(origin: string, pathOrUrl: string): string {
  let url: URL
  try {
    url = new URL(pathOrUrl, origin)
  } catch {
    throw new MarketFetchError(`market artifact URL is not valid: ${pathOrUrl}`, 400, 'market-artifact-url')
  }
  if (url.origin !== origin) {
    throw new MarketFetchError(
      `market artifact URL ${url.href} is not on the configured source origin ${origin} (origin pinning, fail-closed)`,
      400,
      'market-artifact-origin',
    )
  }
  return url.href
}

function requestBuffer(url: string, maxBytes: number, label: string): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const parts = originParts(url)
    const transport = parts.protocol === 'https:' ? httpsGet : httpGet
    const request = transport(url, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0
      if (status !== 200) {
        response.resume()
        rejectPromise(new MarketFetchError(
          `market ${label} returned HTTP ${status} (${url})`,
          502,
        ))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > maxBytes) {
          request.destroy(new MarketFetchError(`market ${label} exceeded ${maxBytes} bytes`, 502))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolvePromise(Buffer.concat(chunks)))
    })
    request.setTimeout(MARKET_HTTP_TIMEOUT_MS, () => {
      request.destroy(new MarketFetchError(`market ${label} timed out after ${MARKET_HTTP_TIMEOUT_MS}ms`, 502))
    })
    request.on('error', (error: Error) => {
      if (error instanceof MarketFetchError) rejectPromise(error)
      else rejectPromise(new MarketFetchError(`market ${label} is unreachable: ${error.message}`, 502))
    })
  })
}

/** 自有 HTTP client 面(测试可注入假实现;默认实现只打配置 origin)。 */
export interface MarketHttpClient {
  /** 拉 JSON 文本(GET);非 2xx/超时/超限 → MarketFetchError(诚实报错)。 */
  fetchText(url: string, label: string): Promise<string>
  /** 拉字节(GET;全量缓冲,上限 maxBytes)——评审 D6:当前**非流式**,「流式拉字节」是后续批次目标;install 侧对返回的缓冲一次性算 sha256。非 2xx/超时/超限 → MarketFetchError(诚实报错)。 */
  fetchBuffer(url: string, label: string, maxBytes: number): Promise<Buffer>
}

export function createMarketHttpClient(): MarketHttpClient {
  return {
    fetchText: (url, label) => requestBuffer(url, MARKET_JSON_MAX_BYTES, label).then(buffer => buffer.toString('utf8')),
    fetchBuffer: (url, label, maxBytes) => requestBuffer(url, maxBytes, label),
  }
}

// ---------------------------------------------------------------------------
// 每源 revision 持久化(防重放判定的持久事实)
// ---------------------------------------------------------------------------

/** 每源已接受的最大 revision 存取接口(测试可注入内存实现)。 */
export interface MarketRevisionStore {
  loadMaxRevision(origin: string): number | undefined
  saveMaxRevision(origin: string, revision: number): void
}

const REVISION_STATE_VERSION = 1

/** 文件实现:`<profileDir>/.market-artifacts/state.json`(0600,原子写)。 */
export function createFileRevisionStore(profileDir: string, logger: (message: string) => void): MarketRevisionStore {
  const statePath = join(profileDir, '.market-artifacts', 'state.json')
  function readAll(): Record<string, unknown> {
    if (!existsSync(statePath)) return { version: REVISION_STATE_VERSION, sources: {} }
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
      return typeof parsed === 'object' && parsed !== null ? parsed : { version: REVISION_STATE_VERSION, sources: {} }
    } catch (error) {
      // 状态文件损坏:降级为「无持久 revision」并记录(签名仍兜底,不接受无签内容)。
      logger(`huaanwork-market: revision state unreadable (${error instanceof Error ? error.message : String(error)}); replay window resets for this source`)
      return { version: REVISION_STATE_VERSION, sources: {} }
    }
  }
  function sourcesOf(state: Record<string, unknown>): Record<string, { maxRevision?: number }> {
    const sources = state.sources
    return typeof sources === 'object' && sources !== null
      ? sources as Record<string, { maxRevision?: number }>
      : {}
  }
  return {
    loadMaxRevision(origin) {
      const entry = sourcesOf(readAll())[origin]
      return typeof entry?.maxRevision === 'number' && Number.isInteger(entry.maxRevision) ? entry.maxRevision : undefined
    },
    saveMaxRevision(origin, revision) {
      // 并行读(catalog + installable 同刻拉取)在无互斥的 RMW 上竞态:只在新值
      // **大于**已存值时落盘——revision 永不允许回退写(2026-09-26 final review)。
      const state = readAll()
      const sources = sourcesOf(state)
      const stored = sources[origin]?.maxRevision
      if (typeof stored === 'number' && revision <= stored) return
      sources[origin] = { maxRevision: revision }
      state.sources = sources
      // D7:catalog 读先于安装是生产正常时序(用户先浏览再安装),revision
      // 落盘路径必须走同一 0700 归位,不得另开无 mode 的建目录岔路。
      ensureMarketArtifactsDir(profileDir)
      const tmp = `${statePath}.tmp`
      writeFileSync(tmp, `${JSON.stringify(state, undefined, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, statePath)
    },
  }
}

// ---------------------------------------------------------------------------
// 已验签清单拉取(每次读都拉取 + 验签——无缓存,N8)
// ---------------------------------------------------------------------------

export interface VerifiedManifest {
  readonly manifest: MarketManifest
  readonly signature: MarketManifestSignature
  readonly slot: 1 | 2
  /** 本次验签是否推进了持久化 max revision(防重放判定的提交点)。 */
  readonly revisionAdvanced: boolean
}

export interface FetchVerifiedManifestOptions {
  readonly origin: string
  readonly pins: MarketVerificationPins
  readonly revisionStore: MarketRevisionStore
  /** epoch 毫秒(可注入;生产为 Date.now())。 */
  readonly now: number
  readonly http?: MarketHttpClient
}

/**
 * 拉取并验签当前激活清单。fail-closed 汇总层:
 * 网络层失败 → MarketFetchError(market-unreachable,诚实);验签失败 → MarketFetchError
 * (market-verification-failed,带稳定 reason);**只有全 verdict 通过才更新持久化
 * max revision**——验签失败时 revision 不前进,重放旧清单永远失败。
 */
export async function fetchVerifiedManifest(options: FetchVerifiedManifestOptions): Promise<VerifiedManifest> {
  const http = options.http ?? createMarketHttpClient()
  const manifestUrl = resolveSameOriginUrl(options.origin, '/v1/manifest')
  const signatureUrl = resolveSameOriginUrl(options.origin, '/v1/manifest/signature')

  let manifest: MarketManifest
  let signature: MarketManifestSignature
  try {
    manifest = JSON.parse(await http.fetchText(manifestUrl, 'manifest')) as MarketManifest
  } catch (error) {
    if (error instanceof MarketFetchError) {
      throw error.status === 502
        ? new MarketFetchError(`内网市场不可达或清单未激活:${error.message}`, 502, 'market-unreachable')
        : error
    }
    throw new MarketFetchError(`市场清单不是合法 JSON:${error instanceof Error ? error.message : String(error)}`, 502, 'market-unreachable')
  }
  try {
    signature = JSON.parse(await http.fetchText(signatureUrl, 'manifest signature')) as MarketManifestSignature
  } catch (error) {
    if (error instanceof MarketFetchError) throw error
    throw new MarketFetchError(`市场清单签名不是合法 JSON:${error instanceof Error ? error.message : String(error)}`, 502, 'market-unreachable')
  }

  const lastSeenRevision = options.revisionStore.loadMaxRevision(options.origin)
  let verdict: VerificationVerdict
  try {
    verdict = verifyMarketManifest(manifest, signature, options.pins, {
      domain: options.origin,
      now: options.now,
      ...(lastSeenRevision !== undefined ? { lastSeenRevision } : {}),
    })
  } catch (error) {
    // assertMarketVerificationReady / retiredAt 配置事故:fail-closed,不更新 revision。
    throw new MarketFetchError(
      `市场验签信任锚未就绪:${error instanceof Error ? error.message : String(error)}`,
      503,
      'market-verification-unavailable',
    )
  }
  if (!verdict.ok) {
    // 不信任清单中任何字段(包括 sha256);revision 不前进。
    throw new MarketFetchError(
      `市场目录签名校验失败,已拒绝(reason=${verdict.reason}):清单不可信,其中任何 sha256 均不被采用`,
      502,
      'market-verification-failed',
    )
  }

  const revisionAdvanced = lastSeenRevision === undefined || manifest.envelope.revision > lastSeenRevision
  if (revisionAdvanced) {
    options.revisionStore.saveMaxRevision(options.origin, manifest.envelope.revision)
  }
  return { manifest, signature, slot: verdict.slot, revisionAdvanced }
}
