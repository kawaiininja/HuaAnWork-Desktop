/**
 * HTTP client of the offline administrator CLI.
 *
 * Every request is bound to ONE role token:
 *
 *   adminToken    pending reviews, submission detail, review bundle download,
 *                 approve/reject, delist approval, revoke
 *   readToken     legacy `/v1/catalog/{slug}` persona reads and the personaUrl
 *                 fetch (migration only)
 *   publishToken  `POST /v1/agent-packages/submissions` (migration `--submit`)
 *
 * The CLI deliberately has no public read route usage for review: the admin
 * metadata + admin bundle routes are the only review inputs, so a review never
 * needs a read token. Tokens and request headers are never echoed into errors,
 * stdout or the review receipt.
 *
 * Safety rules enforced here (not in the commands):
 *   - JSON responses are capped at 1 MiB, bundles at the shared 5 MiB cap.
 *   - Redirects are disabled: an `Authorization` header must never follow a
 *     redirect to another origin.
 *   - Every response body is parsed defensively; a server digest is only
 *     accepted after its exact documented shape is verified, because that
 *     object is what the CLI signs.
 */

import {
  MAX_AGENT_PACKAGE_BUNDLE_BYTES,
  type AgentPackageDigest,
} from '@huaanwork/agent-package-format'
import type { CatalogSignature } from '@huaanwork/catalog-signing'

/** JSON response cap (same budget as the server's own JSON responses). */
export const MAX_JSON_RESPONSE_BYTES = 1024 * 1024
/** Bundle response cap: one byte over the legal archive size is enough. */
export const MAX_BUNDLE_RESPONSE_BYTES = MAX_AGENT_PACKAGE_BUNDLE_BYTES + 1
/** Per-request timeout (catalog + admin APIs). */
export const REQUEST_TIMEOUT_MS = 10_000
/** Legacy persona read timeout, fixed by the plan. */
export const LEGACY_PERSONA_TIMEOUT_MS = 5_000
/** A legacy persona payload must fit the shared 32 KiB persona budget. */
export const MAX_LEGACY_PERSONA_BYTES = 32 * 1024
/** Error-response cap: the unified error body is tiny. */
const MAX_ERROR_BODY_BYTES = 64 * 1024

const HEX64_RE = /^[0-9a-f]{64}$/u

/** Expected operator failure: the message is the whole user-facing report. */
export class CatalogCliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CatalogCliError'
  }
}

export type SubmissionStatus = 'pending-review' | 'published' | 'rejected'

/**
 * Admin submission detail (`GET /v1/agent-packages/submissions/{id}`).
 *
 * `previousVersion`/`previousDigest` are present only for administrator calls
 * and only when the slug already has a signed record (delisted/revoked
 * included). Structural validation happens in {@link parseSubmission}.
 */
export interface SubmissionDetail {
  readonly submissionId: string
  readonly slug: string
  readonly version: string
  readonly status: SubmissionStatus
  readonly submittedAt: string
  readonly updatedAt: string
  readonly digest: AgentPackageDigest
  readonly reason?: string
  readonly previousVersion?: string
  readonly previousDigest?: AgentPackageDigest
}

export interface DelistRequestRecord {
  readonly id: string
  readonly slug: string
  readonly version: string
  readonly status: 'pending' | 'approved' | 'rejected'
  readonly reason: string
  readonly createdAt: string
  readonly resolvedAt?: string
}

export interface RevocationRecord {
  readonly slug: string
  readonly version: string
  readonly reason: string
  readonly revokedAt: string
}

export interface AgentCatalogClientOptions {
  /** Catalog root URL without a trailing slash. */
  readonly baseUrl: string
  readonly adminToken?: string
  readonly readToken?: string
  readonly publishToken?: string
  /** Test seam; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch
}

interface JsonRequestOptions {
  readonly token: string
  readonly role: string
  readonly method?: 'GET' | 'POST'
  readonly body?: unknown
  readonly rawBody?: Buffer
  readonly headers?: Record<string, string>
  readonly timeoutMs?: number
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CatalogCliError(`服务端响应格式错误：${what} 必须是非空字符串`)
  }
  return value
}

function requireHex64(value: unknown, what: string): string {
  if (typeof value !== 'string' || !HEX64_RE.test(value)) {
    throw new CatalogCliError(`服务端响应格式错误：${what} 必须是 64 位十六进制 sha256`)
  }
  return value
}

/**
 * Validate the exact digest shape before it is compared or signed.
 *
 * The server computed this object from the uploaded bytes, but the CLI is the
 * signing party: it must not sign an object whose shape it cannot explain.
 */
export function parseAgentPackageDigest(value: unknown, what = 'digest'): AgentPackageDigest {
  if (!isRecord(value)) throw new CatalogCliError(`服务端响应格式错误：${what} 必须是对象`)
  if (value.schemaVersion !== 1) {
    throw new CatalogCliError(`服务端响应格式错误：${what}.schemaVersion 必须为 1`)
  }
  const slug = requireString(value.slug, `${what}.slug`)
  const version = requireString(value.version, `${what}.version`)
  const manifestSha256 = requireHex64(value.manifestSha256, `${what}.manifestSha256`)
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new CatalogCliError(`服务端响应格式错误：${what}.files 必须是非空数组`)
  }
  const files = value.files.map((file, index) => {
    if (!isRecord(file)) {
      throw new CatalogCliError(`服务端响应格式错误：${what}.files[${String(index)}] 必须是对象`)
    }
    const size = file.size
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
      throw new CatalogCliError(
        `服务端响应格式错误：${what}.files[${String(index)}].size 必须是非负整数`,
      )
    }
    return {
      path: requireString(file.path, `${what}.files[${String(index)}].path`),
      size,
      sha256: requireHex64(file.sha256, `${what}.files[${String(index)}].sha256`),
    }
  })
  return { schemaVersion: 1, slug, version, manifestSha256, files }
}

function parseSubmissionStatus(value: unknown): SubmissionStatus {
  if (value === 'pending-review' || value === 'published' || value === 'rejected') return value
  throw new CatalogCliError(`服务端响应格式错误：submission.status 未知取值 ${String(value)}`)
}

/** Validate one submission document; `previous*` stays optional. */
export function parseSubmission(value: unknown): SubmissionDetail {
  if (!isRecord(value)) throw new CatalogCliError('服务端响应格式错误：submission 必须是对象')
  const status = parseSubmissionStatus(value.status)
  const detail: {
    submissionId: string
    slug: string
    version: string
    status: SubmissionStatus
    submittedAt: string
    updatedAt: string
    digest: AgentPackageDigest
    reason?: string
    previousVersion?: string
    previousDigest?: AgentPackageDigest
  } = {
    submissionId: requireString(value.submissionId, 'submission.submissionId'),
    slug: requireString(value.slug, 'submission.slug'),
    version: requireString(value.version, 'submission.version'),
    status,
    submittedAt: requireString(value.submittedAt, 'submission.submittedAt'),
    updatedAt: requireString(value.updatedAt, 'submission.updatedAt'),
    digest: parseAgentPackageDigest(value.digest, 'submission.digest'),
  }
  if (typeof value.reason === 'string') detail.reason = value.reason
  if (value.previousVersion !== undefined) {
    detail.previousVersion = requireString(value.previousVersion, 'submission.previousVersion')
  }
  if (value.previousDigest !== undefined) {
    detail.previousDigest = parseAgentPackageDigest(value.previousDigest, 'submission.previousDigest')
  }
  return detail
}

function parseDelistRequest(value: unknown): DelistRequestRecord {
  if (!isRecord(value)) throw new CatalogCliError('服务端响应格式错误：下架申请必须是对象')
  const status = value.status
  if (status !== 'pending' && status !== 'approved' && status !== 'rejected') {
    throw new CatalogCliError(`服务端响应格式错误：下架申请状态未知取值 ${String(status)}`)
  }
  const record: {
    id: string
    slug: string
    version: string
    status: 'pending' | 'approved' | 'rejected'
    reason: string
    createdAt: string
    resolvedAt?: string
  } = {
    id: requireString(value.id, 'delist.id'),
    slug: requireString(value.slug, 'delist.slug'),
    version: requireString(value.version, 'delist.version'),
    status,
    reason: requireString(value.reason, 'delist.reason'),
    createdAt: requireString(value.createdAt, 'delist.createdAt'),
  }
  if (typeof value.resolvedAt === 'string') record.resolvedAt = value.resolvedAt
  return record
}

function parseRevocation(value: unknown): RevocationRecord {
  if (!isRecord(value)) throw new CatalogCliError('服务端响应格式错误：撤销记录必须是对象')
  return {
    slug: requireString(value.slug, 'revocation.slug'),
    version: requireString(value.version, 'revocation.version'),
    reason: requireString(value.reason, 'revocation.reason'),
    revokedAt: requireString(value.revokedAt, 'revocation.revokedAt'),
  }
}

function listItems(value: unknown, what: string): unknown[] {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new CatalogCliError(`服务端响应格式错误：${what} 必须是 { items: [] }`)
  }
  return value.items
}

function fetchFailure(cause: unknown): CatalogCliError {
  if (cause instanceof CatalogCliError) return cause
  if (cause instanceof Error) {
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
      return new CatalogCliError('目录请求超时，请检查 AGENT_CATALOG_URL 与网络')
    }
    return new CatalogCliError(`目录不可达：${cause.message}`)
  }
  return new CatalogCliError('目录不可达：未知错误')
}

/**
 * Read a response body with a hard byte cap.
 *
 * `content-length` is only a hint (and can be absent), so the stream itself is
 * counted; exceeding the cap cancels the download instead of buffering it.
 */
async function readBodyCapped(response: Response, cap: number, what: string): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > cap) {
    throw new CatalogCliError(`${what}超过 ${String(cap)} 字节上限`)
  }
  const body = response.body
  if (body === null) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => undefined)
      throw new CatalogCliError(`${what}超过 ${String(cap)} 字节上限`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total)
}

async function errorDetail(response: Response): Promise<string> {
  let text = ''
  try {
    text = (await readBodyCapped(response, MAX_ERROR_BODY_BYTES, '错误响应')).toString('utf8')
  } catch {
    text = ''
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed) && typeof parsed.error === 'string') {
      const code = typeof parsed.code === 'string' ? ` (${parsed.code})` : ''
      return `${parsed.error}${code}`
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  const trimmed = text.trim()
  return trimmed === '' ? '服务端未返回错误详情' : trimmed.slice(0, 200)
}

export class AgentCatalogAdminClient {
  private readonly baseUrl: string
  private readonly adminToken: string | undefined
  private readonly readToken: string | undefined
  private readonly publishToken: string | undefined
  private readonly fetchImpl: typeof fetch

  constructor(options: AgentCatalogClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '')
    this.adminToken = options.adminToken
    this.readToken = options.readToken
    this.publishToken = options.publishToken
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  // -------------------------------------------------------------------------
  // Admin surface
  // -------------------------------------------------------------------------

  async listPendingSubmissions(): Promise<SubmissionDetail[]> {
    const body = await this.requestJson('/v1/agent-packages/submissions?status=pending', {
      token: this.requireAdminToken(),
      role: 'AGENT_CATALOG_ADMIN_TOKEN',
    })
    return listItems(body, '待审查提交列表').map(parseSubmission)
  }

  async getSubmission(submissionId: string): Promise<SubmissionDetail> {
    const body = await this.requestJson(
      `/v1/agent-packages/submissions/${encodeURIComponent(submissionId)}`,
      { token: this.requireAdminToken(), role: 'AGENT_CATALOG_ADMIN_TOKEN' },
    )
    return parseSubmission(body)
  }

  /** The ORIGINAL unsigned bytes of a pending submission (admin-only route). */
  async downloadSubmissionBundle(submissionId: string): Promise<Buffer> {
    return this.requestBuffer(
      `/v1/agent-packages/submissions/${encodeURIComponent(submissionId)}/bundle`,
      this.requireAdminToken(),
      'AGENT_CATALOG_ADMIN_TOKEN',
      MAX_BUNDLE_RESPONSE_BYTES,
      '提交包',
    )
  }

  async approveSubmission(
    submissionId: string,
    signature: CatalogSignature,
  ): Promise<SubmissionDetail> {
    const body = await this.requestJson(
      `/v1/agent-packages/submissions/${encodeURIComponent(submissionId)}/approve`,
      {
        token: this.requireAdminToken(),
        role: 'AGENT_CATALOG_ADMIN_TOKEN',
        method: 'POST',
        body: { signature },
      },
    )
    return parseSubmission(body)
  }

  async rejectSubmission(submissionId: string, reason: string): Promise<SubmissionDetail> {
    const body = await this.requestJson(
      `/v1/agent-packages/submissions/${encodeURIComponent(submissionId)}/reject`,
      {
        token: this.requireAdminToken(),
        role: 'AGENT_CATALOG_ADMIN_TOKEN',
        method: 'POST',
        body: { reason },
      },
    )
    return parseSubmission(body)
  }

  async listPendingDelistRequests(): Promise<DelistRequestRecord[]> {
    const body = await this.requestJson('/v1/agent-packages/delist-requests?status=pending', {
      token: this.requireAdminToken(),
      role: 'AGENT_CATALOG_ADMIN_TOKEN',
    })
    return listItems(body, '下架申请列表').map(parseDelistRequest)
  }

  async approveDelistRequest(requestId: string): Promise<DelistRequestRecord> {
    const body = await this.requestJson(
      `/v1/agent-packages/delist-requests/${encodeURIComponent(requestId)}/approve`,
      {
        token: this.requireAdminToken(),
        role: 'AGENT_CATALOG_ADMIN_TOKEN',
        method: 'POST',
      },
    )
    return parseDelistRequest(body)
  }

  async rejectDelistRequest(requestId: string, reason: string): Promise<DelistRequestRecord> {
    const body = await this.requestJson(
      `/v1/agent-packages/delist-requests/${encodeURIComponent(requestId)}/reject`,
      {
        token: this.requireAdminToken(),
        role: 'AGENT_CATALOG_ADMIN_TOKEN',
        method: 'POST',
        body: { reason },
      },
    )
    return parseDelistRequest(body)
  }

  async revoke(slug: string, version: string, reason: string): Promise<RevocationRecord> {
    const body = await this.requestJson(
      `/v1/agent-packages/${encodeURIComponent(slug)}/${encodeURIComponent(version)}/revoke`,
      {
        token: this.requireAdminToken(),
        role: 'AGENT_CATALOG_ADMIN_TOKEN',
        method: 'POST',
        body: { reason },
      },
    )
    return parseRevocation(body)
  }

  // -------------------------------------------------------------------------
  // Legacy M-A0 surface (migration only)
  // -------------------------------------------------------------------------

  async getLegacyEntry(slug: string): Promise<UnknownRecord> {
    const body = await this.requestJson(`/v1/catalog/${encodeURIComponent(slug)}`, {
      token: this.requireReadToken(),
      role: 'AGENT_CATALOG_TOKEN',
      timeoutMs: LEGACY_PERSONA_TIMEOUT_MS,
    })
    if (!isRecord(body)) throw new CatalogCliError('服务端响应格式错误：旧目录条目必须是对象')
    return body
  }

  /**
   * Fetch a persona from an already LAN-validated `personaUrl`.
   *
   * The caller must run the LAN check BEFORE calling this method; the read
   * token is the only credential sent and the response is capped at 1 MiB.
   * A JSON object carrying a string `persona` wins, otherwise the raw body is
   * the persona text (the M-A0 contract).
   */
  async fetchLegacyPersona(personaUrl: string): Promise<string> {
    let response: Response
    try {
      response = await this.fetchImpl(personaUrl, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.requireReadToken()}`,
          accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
        },
        signal: AbortSignal.timeout(LEGACY_PERSONA_TIMEOUT_MS),
        redirect: 'error',
      })
    } catch (cause) {
      throw fetchFailure(cause)
    }
    if (!response.ok) {
      throw new CatalogCliError(`人设地址返回 HTTP ${String(response.status)}：${await errorDetail(response)}`)
    }
    const buffer = await readBodyCapped(response, MAX_JSON_RESPONSE_BYTES, '人设响应')
    const text = buffer.toString('utf8')
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed) && typeof parsed.persona === 'string') return parsed.persona
    } catch {
      // Not JSON: the raw text is the persona.
    }
    return text
  }

  /** `POST /v1/agent-packages/submissions` with the explicit migration header. */
  async submitMigration(slug: string, bundle: Buffer): Promise<SubmissionDetail> {
    const body = await this.requestJson('/v1/agent-packages/submissions', {
      token: this.requirePublishToken(),
      role: 'AGENT_CATALOG_PUBLISH_TOKEN',
      method: 'POST',
      rawBody: bundle,
      headers: {
        'content-type': 'application/gzip',
        'x-agent-catalog-migration': slug,
      },
    })
    return parseSubmission(body)
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private requireAdminToken(): string {
    if (this.adminToken === undefined) {
      throw new CatalogCliError('该命令需要 AGENT_CATALOG_ADMIN_TOKEN')
    }
    return this.adminToken
  }

  private requireReadToken(): string {
    if (this.readToken === undefined) {
      throw new CatalogCliError('migrate-legacy 需要 AGENT_CATALOG_TOKEN（读 token）')
    }
    return this.readToken
  }

  private requirePublishToken(): string {
    if (this.publishToken === undefined) {
      throw new CatalogCliError('migrate-legacy --submit 需要 AGENT_CATALOG_PUBLISH_TOKEN')
    }
    return this.publishToken
  }

  private async requestJson(path: string, options: JsonRequestOptions): Promise<unknown> {
    const buffer = await this.requestBuffer(
      path,
      options.token,
      options.role,
      MAX_JSON_RESPONSE_BYTES,
      '响应',
      options,
    )
    if (buffer.byteLength === 0) throw new CatalogCliError('服务端响应为空')
    try {
      return JSON.parse(buffer.toString('utf8')) as unknown
    } catch {
      throw new CatalogCliError('服务端响应不是合法 JSON')
    }
  }

  private async requestBuffer(
    path: string,
    token: string,
    role: string,
    cap: number,
    what: string,
    options: {
      readonly method?: 'GET' | 'POST'
      readonly body?: unknown
      readonly rawBody?: Buffer
      readonly headers?: Record<string, string>
      readonly timeoutMs?: number
    } = {},
  ): Promise<Buffer> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...options.headers,
    }
    let payload: Buffer | undefined
    if (options.rawBody !== undefined) {
      payload = options.rawBody
      headers['content-length'] = String(payload.byteLength)
    } else if (options.body !== undefined) {
      payload = Buffer.from(JSON.stringify(options.body), 'utf8')
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.byteLength)
    }

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
        redirect: 'error',
      })
    } catch (cause) {
      throw fetchFailure(cause)
    }

    if (!response.ok) {
      const detail = await errorDetail(response)
      const hint = response.status === 401 || response.status === 403
        ? `（请检查 ${role} 是否正确、是否已过期）`
        : ''
      throw new CatalogCliError(`目录请求失败：HTTP ${String(response.status)} ${detail}${hint}`)
    }
    return readBodyCapped(response, cap, what)
  }
}
