/**
 * Generic intranet-catalog transport (Task 6).
 *
 * Shared by the signed agent-package client and the skill client: same-origin
 * root resolution is done by the callers through `@huaanwork/policy`, while
 * this module owns the request mechanics that must not drift — Bearer header,
 * request timeout, manual redirects, 401/403 classification, capped JSON and
 * capped buffer reads that abort buffering at the cap.
 *
 * Signature/keyring semantics stay out of this module: it never verifies
 * anything, it only fetches bytes with bounded resources.
 */

export const DEFAULT_CATALOG_REQUEST_TIMEOUT_MS = 5_000
export const MAX_CATALOG_JSON_BYTES = 1024 * 1024

export type CatalogTransportErrorCode =
  | 'unreachable'
  | 'redirect'
  | 'auth'
  | 'http'
  | 'response-too-large'
  | 'invalid-response'
  | 'cross-origin'

export class CatalogTransportError extends Error {
  readonly code: CatalogTransportErrorCode
  readonly status: number | undefined

  constructor(message: string, code: CatalogTransportErrorCode, status?: number) {
    super(message)
    this.name = 'CatalogTransportError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export const CATALOG_AUTH_ERROR = '目录口令错误或权限不足'
export const CATALOG_UNREACHABLE_ERROR = '目录不可达，请稍后重试；本地智能体不受影响'

/** Build one request: accept header, optional Bearer, timeout, no auto redirect. */
export function buildCatalogInit(init: RequestInit, token: string | undefined, timeoutMs: number): RequestInit {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  return {
    ...init,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  }
}

/** Trimmed token, or undefined for the empty string. */
export function optionalCatalogToken(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400
}

/**
 * Factory hook so each surface throws its own error class while sharing the
 * read discipline. `status` is only present when the response carried one.
 */
export type CatalogErrorFactory = (message: string, code: CatalogTransportErrorCode, status?: number) => Error

const defaultErrorFactory: CatalogErrorFactory = (message, code, status) =>
  new CatalogTransportError(message, code, status)

/**
 * Read a response body as a Buffer, aborting at `cap` bytes. Any read failure
 * that is not already a catalog error becomes `unreachable`.
 */
export async function readCappedCatalogBuffer(
  response: Response,
  cap: number,
  tooLargeMessage: string,
  makeError: CatalogErrorFactory = defaultErrorFactory,
): Promise<Buffer> {
  const body = response.body
  if (body === null) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let exceeded = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > cap) {
        exceeded = true
        await reader.cancel().catch(() => undefined)
        break
      }
      chunks.push(value)
    }
  } catch {
    throw makeError(CATALOG_UNREACHABLE_ERROR, 'unreachable')
  }
  if (exceeded) throw makeError(tooLargeMessage, 'response-too-large')
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  )
}

export type CatalogJsonResponse = { readonly status: number; readonly body: unknown }

export interface CatalogTransportOptions {
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly makeError?: CatalogErrorFactory
}

export interface CatalogTransport {
  requestJson(url: string, token: string | undefined, init: RequestInit): Promise<CatalogJsonResponse>
  /**
   * Like `requestJson`, but hands back the parsed body for EVERY non-redirect
   * response (including 4xx). Upload callers need the server's structured
   * conflict code; redirects and transport failures still throw.
   */
  requestJsonResult(url: string, token: string | undefined, init: RequestInit): Promise<CatalogJsonResponse>
  requestBuffer(
    url: string,
    token: string | undefined,
    init: RequestInit,
    cap: number,
    tooLargeMessage: string,
  ): Promise<Buffer>
}

export function createCatalogTransport(options: CatalogTransportOptions = {}): CatalogTransport {
  const fetchFn = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_CATALOG_REQUEST_TIMEOUT_MS
  const makeError = options.makeError ?? defaultErrorFactory

  async function fetchResponse(url: string, token: string | undefined, init: RequestInit): Promise<Response> {
    let response: Response
    try {
      response = await fetchFn(url, buildCatalogInit(init, token, timeoutMs))
    } catch {
      throw makeError(CATALOG_UNREACHABLE_ERROR, 'unreachable')
    }
    if (isRedirectStatus(response.status)) {
      throw makeError('目录请求被重定向，已拒绝', 'redirect', response.status)
    }
    // Classify by status BEFORE reading the body: an oversized error page must
    // not turn an auth failure into "response too large".
    if (response.status === 401 || response.status === 403) {
      throw makeError(CATALOG_AUTH_ERROR, 'auth', response.status)
    }
    if (!response.ok) {
      // Never echo the server body: it may contain a token fragment.
      throw makeError(`目录请求失败（HTTP ${response.status}）`, 'http', response.status)
    }
    return response
  }

  async function fetchAnyResponse(url: string, token: string | undefined, init: RequestInit): Promise<Response> {
    let response: Response
    try {
      response = await fetchFn(url, buildCatalogInit(init, token, timeoutMs))
    } catch {
      throw makeError(CATALOG_UNREACHABLE_ERROR, 'unreachable')
    }
    if (isRedirectStatus(response.status)) {
      throw makeError('目录请求被重定向，已拒绝', 'redirect', response.status)
    }
    return response
  }

  return {
    async requestJson(url, token, init) {
      const response = await fetchResponse(url, token, init)
      const body = await readCappedCatalogBuffer(response, MAX_CATALOG_JSON_BYTES, '目录响应超过 1 MiB 上限', makeError)
      try {
        return { status: response.status, body: JSON.parse(body.toString('utf8')) as unknown }
      } catch {
        throw makeError('目录响应不是合法 JSON', 'invalid-response', response.status)
      }
    },

    async requestJsonResult(url, token, init) {
      const response = await fetchAnyResponse(url, token, init)
      const body = await readCappedCatalogBuffer(response, MAX_CATALOG_JSON_BYTES, '目录响应超过 1 MiB 上限', makeError)
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        if (response.ok) throw makeError('目录响应不是合法 JSON', 'invalid-response', response.status)
        // An error body that is not JSON still carries the status.
        parsed = undefined
      }
      return { status: response.status, body: parsed }
    },

    async requestBuffer(url, token, init, cap, tooLargeMessage) {
      const response = await fetchResponse(url, token, init)
      return readCappedCatalogBuffer(response, cap, tooLargeMessage, makeError)
    },
  }
}
