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
 * 链路:`GET /v1/manifest` + `GET /v1/manifest/signature` → verify.ts keyId 权威验签
 * (信封:domain = 配置 origin、revision genuinely older 才拒(`<` 持久化最大值;
 * 等值 = 当前清单幂等重读,放行——final-review 裁定 2026-09-26,spec §14 第十轮
 * 第 49 条)、notAfter 未过期)——任一不满足即拒,**不信任其中任何 sha256** → 通过
 * 后先过 `files` 形状守卫(P19:结构不可消费 = 拒绝整份清单,且不落 revision),
 * 再更新每源持久化 max revision(防重放判定的持久事实;仅当推进时写盘)。
 */

import { get as httpGet, type IncomingMessage } from 'node:http'
import { get as httpsGet } from 'node:https'
import { randomBytes } from 'node:crypto'
import { renameSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MarketVerificationPins } from './config.ts'
import { ensureMarketArtifactsDir } from './artifacts.ts'
import {
  verifyMarketManifest,
  type MarketManifest,
  type MarketManifestFile,
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

/**
 * 逐 chunk 拉取(GET;第 53 条):每个 chunk 交给 `onChunk`(返回 Promise 则 await,
 * 调用方据此施加背压——写盘返回 false 时等 'drain'),内存峰值 O(chunk)。
 *
 * **不跟随重定向**:3xx 与其它任何非 200 一律拒(第 51 条的同源钉扎在调用方完成,
 * 故一个跨源 3xx 无从击穿;本方法只打传入的那个 URL)。超 `maxBytes` 立即
 * `response.destroy()` 并拒,**不读完剩余字节**。`onChunk` 抛错即中止下载并原样
 * 上抛(宿主 IO 故障不得被伪装成网络故障)。返回累计收到的字节数。
 */
function requestStream(
  url: string,
  label: string,
  maxBytes: number,
  onChunk: (chunk: Buffer) => void | Promise<void>,
): Promise<{ bytes: number }> {
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
      void (async () => {
        let bytes = 0
        try {
          for await (const chunk of response) {
            const buffer = chunk as Buffer
            bytes += buffer.byteLength
            if (bytes > maxBytes) {
              // 超限即断连:剩余字节不再读(第 53 条:内存峰值 = O(chunk),不是 O(响应体))。
              response.destroy()
              throw new MarketFetchError(`market ${label} exceeded ${maxBytes} bytes`, 502)
            }
            await onChunk(buffer)
          }
          resolvePromise({ bytes })
        } catch (error) {
          response.destroy()
          rejectPromise(error instanceof MarketFetchError
            ? error
            : new MarketFetchError(`market ${label} is unreachable: ${error instanceof Error ? error.message : String(error)}`, 502))
        }
      })()
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
  /**
   * 拉字节(GET;全量缓冲,上限 maxBytes)。M5 起 install 侧即用此面;第 53 条后
   * 安装路径改走 `fetchStream`(本方法保留为通用字节拉取面,现有冒烟/端到端测试的
   * 注入桩仍以它记录真实 client 行为)。非 2xx/超时/超限 → MarketFetchError。
   */
  fetchBuffer(url: string, label: string, maxBytes: number): Promise<Buffer>
  /**
   * 逐 chunk 拉字节(第 53 条,内存峰值 O(chunk)):`onChunk` 可返回 Promise 以施加
   * 背压;**不跟随重定向**(非 200 一律拒);超 maxBytes 即断连不读完。返回收到字节数。
   */
  fetchStream(
    url: string,
    label: string,
    maxBytes: number,
    onChunk: (chunk: Buffer) => void | Promise<void>,
  ): Promise<{ bytes: number }>
}

export function createMarketHttpClient(): MarketHttpClient {
  return {
    fetchText: (url, label) => requestBuffer(url, MARKET_JSON_MAX_BYTES, label).then(buffer => buffer.toString('utf8')),
    fetchBuffer: (url, label, maxBytes) => requestBuffer(url, maxBytes, label),
    fetchStream: (url, label, maxBytes, onChunk) => requestStream(url, label, maxBytes, onChunk),
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

/**
 * revision 状态暂存名协议(唯一实现,Task 6.9 P16):`<statePath>.tmp-<pid>-<8hex>`。
 *
 * 固定名 `${statePath}.tmp` 下,共享同一 profileDir 的两个 app 实例会互相覆盖
 * 对方的暂存文件(install.ts 一侧的制品暂存已带 pid,Task 6.2/6.3;本处补齐
 * 另一半):pid 区分实例,8 位随机 hex 让同一 pid 的多次提交也各有其名——制品侧
 * 的重复落盘是「同 sha 等价重写」,只带 pid 就够;状态文件每次内容都不同,加随机
 * 后缀才稳。
 *
 * 该名字只被本模块写入并被紧随其后的 `renameSync` 消费:制品孤儿清扫只认
 * `.tgz`(sweepOrphanMarketArtifacts),不会扫到它;改名的窗口极短,崩溃残留
 * 不会遮蔽或冒充状态文件。
 */
export function revisionStateTempPath(statePath: string): string {
  return `${statePath}.tmp-${String(process.pid)}-${randomBytes(4).toString('hex')}`
}

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
      // P16(Task 6.9):暂存名带 pid + 随机后缀,共享 profileDir 的并列实例不互相覆盖。
      const tmp = revisionStateTempPath(statePath)
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
}

export interface FetchVerifiedManifestOptions {
  readonly origin: string
  readonly pins: MarketVerificationPins
  readonly revisionStore: MarketRevisionStore
  /** epoch 毫秒(可注入;生产为 Date.now())。 */
  readonly now: number
  readonly http?: MarketHttpClient
}

/** 形状守卫的取值描述:只报类型,不回显不可信内容(错误文案会到达渲染进程)。 */
function describeManifestValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * P19(Task 6.9):已验签清单的 `files` 形状守卫(数组 + 每个条目是非数组对象)。
 *
 * 验签只保证**字节与信封**可信,不保证结构可消费:routes.ts 的两处消费点
 * (`.find` ~:142 / `.map` ~:195)对非数组会抛裸 TypeError(`.find is not a function`),
 * 条目非对象则在 `file.name` 解引用时抛 TypeError —— 到了 toRouteError 只会变成
 * 500 internal + 通用文案,不可诊断。此处 fail-closed 拒绝整份清单,错误码具名。
 *
 * 口径分工(不与 Task 6.3 的 sha256 形状预检重复):本层管「清单结构能不能被消费」
 * (结构边界,拒绝整份清单);install.ts 管「被选中条目的 sha256 能不能当暂存名与
 * 校验值」(安装边界,只针对被选中的那一条)。两者都在各自的信任边界上判一次。
 */
function assertManifestFilesShape(files: unknown): asserts files is readonly MarketManifestFile[] {
  if (!Array.isArray(files)) {
    throw new MarketFetchError(
      `已验签清单的 files 字段不是数组(收到 ${describeManifestValue(files)}):清单结构不可消费,已拒绝整份清单,其中任何 sha256 均不被采用`,
      502,
      'market-manifest-files',
    )
  }
  for (const [index, entry] of files.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new MarketFetchError(
        `已验签清单的 files[${String(index)}] 不是对象(收到 ${describeManifestValue(entry)}):清单结构不可消费,已拒绝整份清单,其中任何 sha256 均不被采用`,
        502,
        'market-manifest-files',
      )
    }
  }
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

  // P19:结构守卫在**验签之后、落 revision 之前**——真实但不可消费的清单照样拒绝,
  // 且不推进防重放 revision(它从未被采用过)。畸形到 canonicalJson 都拒绝的值
  // 已在上面映射 503(verifyMarketManifest 抛 → market-verification-unavailable);
  // 本守卫补的是「canonicalJson 收得下、消费点收不下」这条路径。
  assertManifestFilesShape(manifest.files)

  // P20(Task 6.9):「是否推进」不再作为返回值透出(零消费方;spec §14 第 49 条把
  // revision 判定改为 `>=` 后「是否前进」对消费方已无语义)——该判据只剩落盘一处用途。
  if (lastSeenRevision === undefined || manifest.envelope.revision > lastSeenRevision) {
    options.revisionStore.saveMaxRevision(options.origin, manifest.envelope.revision)
  }
  return { manifest, signature, slot: verdict.slot }
}
