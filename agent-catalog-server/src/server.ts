/**
 * agent-catalog-server HTTP surface (Task 4 foundation).
 *
 * Route table (Tasks 5/6 fill the handlers; the AUTH MATRIX below is already
 * final so those tasks never have to rewrite authorization):
 *
 *   read     GET  /v1/catalog, /v1/catalog/{name}
 *            GET  /v1/agent-packages
 *            GET  /v1/agent-packages/{slug}/{version}
 *            GET  /v1/agent-packages/{slug}/{version}/bundle
 *            GET  /v1/agent-packages/revocations
 *   publish  POST /v1/agent-packages/submissions
 *            GET  /v1/agent-packages/submissions/{id}      (creator check in Task 5)
 *            POST /v1/agent-packages/{slug}/{version}/delist-requests
 *   admin    GET  /v1/agent-packages/submissions?status=pending
 *            GET  /v1/agent-packages/submissions/{id}      (any submission)
 *            GET  /v1/agent-packages/submissions/{id}/bundle
 *            POST /v1/agent-packages/submissions/{id}/approve|reject
 *            GET  /v1/agent-packages/delist-requests?status=pending
 *            POST /v1/agent-packages/delist-requests/{id}/approve|reject
 *            POST /v1/agent-packages/{slug}/{version}/revoke
 *
 * Dispatch order is deliberate:
 *
 *   1. authenticate            missing/unknown token → 401 {"error":"口令错误"}
 *   2. resolve the route       unknown path → 404 {"error":"Not Found"}
 *   3. check the role           valid token, wrong role → 403
 *   4. check the method         wrong method → 405
 *   5. handler
 *
 * STATIC SEGMENTS WIN over `/{slug}/{version}`: the route table is ordered and
 * matched top-down, so `/submissions`, `/delist-requests` and `/revocations`
 * can never be swallowed by a dynamic slug (plan Task 5 requirement).
 *
 * Every response — including 401/403/404/405 and unknown routes — is audited
 * before it is written (see audit.ts). JSON error bodies are always
 * `{ error, code? }`; JSON responses are capped at 1 MiB. The server never
 * logs the Authorization header and never logs a request line containing a
 * token: path-derived text reaches only the audit log, where it is redacted.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AuditLog, redactSecrets, type AuditEvent } from './audit.ts'
import { authenticateToken, bearerToken, tokenActor, type AgentCatalogRole } from './auth.ts'
import type { AgentCatalogConfig } from './config.ts'
import { findEntry, loadEntries } from './legacy.ts'
import { CatalogStore } from './store.ts'
import type { AgentCatalogErrorBody } from './types.ts'

/** JSON response cap: no route may stream a larger JSON body to a client. */
export const MAX_JSON_RESPONSE_BYTES = 1024 * 1024

/** node:http timeouts (explicit; Node's `timeout = 0` means "never"). */
export const REQUEST_TIMEOUT_MS = 120_000
export const DEFAULT_HEADERS_TIMEOUT_MS = 30_000
export const SOCKET_TIMEOUT_MS = 120_000

export interface AgentCatalogRuntime {
  readonly config: AgentCatalogConfig
  readonly store: CatalogStore
  readonly audit: AuditLog
}

/**
 * Open the runtime (state store first: a corrupt state file must refuse
 * startup before any request can be served or audited).
 */
export async function createAgentCatalogRuntime(config: AgentCatalogConfig): Promise<AgentCatalogRuntime> {
  const store = await CatalogStore.open(config.dataDir)
  const audit = await AuditLog.open(config.dataDir, [config.readToken, config.publishToken, config.adminToken])
  return { config, store, audit }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

type PatternSegment = string | ':slug' | ':version' | ':id'

interface RouteDefinition {
  readonly id: string
  readonly path: readonly PatternSegment[]
  readonly method: string
  readonly roles: readonly AgentCatalogRole[]
}

/**
 * Ordered static-first table. `:id` routes appear after every literal route
 * with the same prefix length, which is what protects
 * `/submissions/{id}` from being read as `/{slug}/{version}`.
 */
const AGENT_PACKAGE_ROUTES: readonly RouteDefinition[] = [
  { id: 'agentPackages.list', path: [], method: 'GET', roles: ['read'] },
  { id: 'agentPackages.submissions.create', path: ['submissions'], method: 'POST', roles: ['publish'] },
  { id: 'agentPackages.submissions.pending', path: ['submissions'], method: 'GET', roles: ['admin'] },
  { id: 'agentPackages.submissions.get', path: ['submissions', ':id'], method: 'GET', roles: ['publish', 'admin'] },
  { id: 'agentPackages.submissions.bundle', path: ['submissions', ':id', 'bundle'], method: 'GET', roles: ['admin'] },
  { id: 'agentPackages.submissions.approve', path: ['submissions', ':id', 'approve'], method: 'POST', roles: ['admin'] },
  { id: 'agentPackages.submissions.reject', path: ['submissions', ':id', 'reject'], method: 'POST', roles: ['admin'] },
  { id: 'agentPackages.delistRequests.pending', path: ['delist-requests'], method: 'GET', roles: ['admin'] },
  { id: 'agentPackages.delistRequests.approve', path: ['delist-requests', ':id', 'approve'], method: 'POST', roles: ['admin'] },
  { id: 'agentPackages.delistRequests.reject', path: ['delist-requests', ':id', 'reject'], method: 'POST', roles: ['admin'] },
  { id: 'agentPackages.revocations.list', path: ['revocations'], method: 'GET', roles: ['read'] },
  { id: 'agentPackages.get', path: [':slug', ':version'], method: 'GET', roles: ['read'] },
  { id: 'agentPackages.bundle', path: [':slug', ':version', 'bundle'], method: 'GET', roles: ['read'] },
  { id: 'agentPackages.delistRequests.create', path: [':slug', ':version', 'delist-requests'], method: 'POST', roles: ['publish'] },
  { id: 'agentPackages.revoke', path: [':slug', ':version', 'revoke'], method: 'POST', roles: ['admin'] },
]

interface ResolvedRoute {
  /** Stable action id used both for dispatch and for the audit action. */
  readonly id: string
  readonly roles: readonly AgentCatalogRole[]
  readonly methodMatched: boolean
  readonly legacy: boolean
  readonly entryNameRaw?: string
  readonly slug?: string
  readonly version?: string
  readonly submissionId?: string
}

const AGENT_PACKAGE_PREFIX = '/v1/agent-packages'
const LEGACY_PREFIX = '/v1/catalog'

function splitAgentPackagePath(pathname: string): string[] | null {
  if (pathname === AGENT_PACKAGE_PREFIX) return []
  if (!pathname.startsWith(`${AGENT_PACKAGE_PREFIX}/`)) return null
  const rest = pathname.slice(AGENT_PACKAGE_PREFIX.length + 1)
  return rest === '' ? [] : rest.split('/')
}

/**
 * Match one pattern. Literal segments compare against the RAW path segment
 * (static shadows dynamic); capture segments are decoded, and a malformed
 * percent-encoding simply fails to match (404, never a thrown URIError).
 */
function matchPattern(
  pattern: readonly PatternSegment[],
  segments: readonly string[],
): Record<string, string> | null {
  if (pattern.length !== segments.length) return null
  const captures: Record<string, string> = {}
  for (const [index, part] of pattern.entries()) {
    const segment = segments[index]
    if (segment === undefined) return null
    if (part.startsWith(':')) {
      if (segment === '') return null
      let decoded: string
      try {
        decoded = decodeURIComponent(segment)
      } catch {
        return null
      }
      captures[part.slice(1)] = decoded
    } else if (part !== segment) {
      return null
    }
  }
  return captures
}

function withCaptures(
  definition: RouteDefinition,
  captures: Record<string, string>,
  methodMatched: boolean,
): ResolvedRoute {
  const route: {
    id: string
    roles: readonly AgentCatalogRole[]
    methodMatched: boolean
    legacy: boolean
    slug?: string
    version?: string
    submissionId?: string
  } = {
    id: definition.id,
    roles: definition.roles,
    methodMatched,
    legacy: false,
  }
  if (captures.slug !== undefined) route.slug = captures.slug
  if (captures.version !== undefined) route.version = captures.version
  if (captures.id !== undefined) route.submissionId = captures.id
  return route
}

function resolveRoute(method: string, pathname: string): ResolvedRoute | null {
  // Legacy M-A0 surface. Shape preserved exactly: `/v1/catalog` (list) and
  // `/v1/catalog/<name>` (single entry); everything else is unknown.
  if (pathname === LEGACY_PREFIX) {
    return { id: 'catalog.list', roles: ['read'], methodMatched: method === 'GET', legacy: true }
  }
  if (pathname.startsWith(`${LEGACY_PREFIX}/`)) {
    return {
      id: 'catalog.get',
      roles: ['read'],
      methodMatched: method === 'GET',
      legacy: true,
      entryNameRaw: pathname.slice(LEGACY_PREFIX.length + 1),
    }
  }

  const segments = splitAgentPackagePath(pathname)
  if (segments === null) return null

  for (const definition of AGENT_PACKAGE_ROUTES) {
    if (definition.method !== method) continue
    const captures = matchPattern(definition.path, segments)
    if (captures !== null) return withCaptures(definition, captures, true)
  }

  // Known path, wrong method: 405. The role set is the union of every method
  // defined for this path, so authorization still runs before the method
  // verdict (a publish token cannot probe an admin-only path).
  const roles = new Set<AgentCatalogRole>()
  let matchedPath = false
  for (const definition of AGENT_PACKAGE_ROUTES) {
    const captures = matchPattern(definition.path, segments)
    if (captures === null) continue
    matchedPath = true
    for (const role of definition.roles) roles.add(role)
  }
  if (!matchedPath) return null
  return {
    id: 'route.method-not-allowed',
    roles: [...roles],
    methodMatched: false,
    legacy: false,
  }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

interface HandlerResult {
  readonly status: number
  /** JSON body (`raw` wins when both are present). */
  readonly body?: unknown
  readonly raw?: { readonly contentType: string; readonly data: Buffer }
  readonly headers?: Readonly<Record<string, string>>
  readonly audit: {
    readonly action: string
    readonly outcome: AuditEvent['outcome']
    readonly reason?: string
    readonly slug?: string
    readonly version?: string
    readonly submissionId?: string
  }
}

function jsonResult(
  status: number,
  body: unknown,
  audit: HandlerResult['audit'],
): HandlerResult {
  return { status, body, audit }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const payload = `${JSON.stringify(body)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(payload)
}

function sendRaw(
  response: ServerResponse,
  status: number,
  raw: { readonly contentType: string; readonly data: Buffer },
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    'content-type': raw.contentType,
    'cache-control': 'no-store',
    'content-length': String(raw.data.byteLength),
    ...headers,
  })
  response.end(raw.data)
}

function errorBody(error: string, code?: string): AgentCatalogErrorBody {
  return code === undefined ? { error } : { error, code }
}

/**
 * Audit first, then respond. An oversized JSON body is converted into a 500
 * BEFORE auditing so the recorded status matches what the client receives.
 * If the audit write itself fails there is no response other than 500 — a
 * request is never answered successfully without a durable audit record.
 */
async function finish(
  response: ServerResponse,
  runtime: AgentCatalogRuntime,
  result: HandlerResult,
  actor: string,
  config: AgentCatalogConfig,
): Promise<void> {
  let effective = result
  if (effective.raw === undefined) {
    const serialized = JSON.stringify(effective.body ?? null)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_RESPONSE_BYTES) {
      effective = {
        status: 500,
        body: errorBody('响应过大', 'response-too-large'),
        audit: { ...effective.audit, outcome: 'error', reason: 'JSON response exceeded the 1 MiB cap' },
      }
    }
  }

  const event: AuditEvent = {
    ...effective.audit,
    status: effective.status,
    actor,
  }
  try {
    await runtime.audit.writeAudit(event)
  } catch (cause) {
    const message = redactSecrets(String((cause as Error).message), secretList(config))
    console.error(`agent-catalog-server: audit write failed: ${message}`)
    sendJson(response, 500, errorBody('审计写入失败', 'audit-write-failed'))
    return
  }

  if (effective.raw !== undefined) {
    sendRaw(response, effective.status, effective.raw, effective.headers)
    return
  }
  sendJson(response, effective.status, effective.body ?? null, effective.headers)
}

function secretList(config: AgentCatalogConfig): readonly string[] {
  return [config.readToken, config.publishToken, config.adminToken]
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function routeAuditContext(route: ResolvedRoute): Pick<AuditEvent, 'slug' | 'version' | 'submissionId'> {
  const context: { slug?: string; version?: string; submissionId?: string } = {}
  if (route.slug !== undefined) context.slug = route.slug
  if (route.version !== undefined) context.version = route.version
  if (route.submissionId !== undefined) context.submissionId = route.submissionId
  return context
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: AgentCatalogConfig,
  runtimePromise: Promise<AgentCatalogRuntime>,
): Promise<void> {
  let runtime: AgentCatalogRuntime
  try {
    runtime = await runtimePromise
  } catch (cause) {
    const message = redactSecrets(String((cause as Error).message), secretList(config))
    console.error(`agent-catalog-server: runtime unavailable: ${message}`)
    sendJson(response, 500, errorBody('服务未就绪', 'not-ready'))
    return
  }

  const method = request.method ?? 'GET'
  const presented = bearerToken(request)
  const actor = tokenActor(presented)

  let pathname: string
  try {
    pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  } catch {
    await finish(
      response,
      runtime,
      jsonResult(400, errorBody('请求无效', 'bad-request'), {
        action: 'request.invalid',
        outcome: 'error',
        reason: 'malformed request URL',
      }),
      actor,
      config,
    )
    return
  }

  const identity = presented === undefined ? null : authenticateToken(config, presented)
  const route = resolveRoute(method, pathname)

  if (identity === null) {
    await finish(
      response,
      runtime,
      jsonResult(401, errorBody('口令错误'), {
        action: 'auth.denied',
        outcome: 'denied',
        reason: presented === undefined ? 'missing token' : 'unrecognized token',
      }),
      actor,
      config,
    )
    return
  }

  if (route === null) {
    await finish(
      response,
      runtime,
      jsonResult(404, errorBody('Not Found'), {
        action: 'route.unknown',
        outcome: 'error',
        reason: `unknown route: ${pathname}`,
      }),
      actor,
      config,
    )
    return
  }

  if (!route.roles.includes(identity)) {
    await finish(
      response,
      runtime,
      jsonResult(403, errorBody('权限不足', 'forbidden'), {
        action: route.id,
        outcome: 'denied',
        reason: `role ${identity} is not allowed on this route`,
        ...routeAuditContext(route),
      }),
      actor,
      config,
    )
    return
  }

  if (!route.methodMatched) {
    await finish(
      response,
      runtime,
      jsonResult(
        405,
        // M-A0 answered `{"error":"只支持 GET"}` for the legacy surface; keep
        // that body for compatibility, use the unified shape everywhere else.
        route.legacy ? { error: '只支持 GET' } : errorBody('方法不允许', 'method-not-allowed'),
        {
          action: 'route.method-not-allowed',
          outcome: 'error',
          reason: `method ${method} is not allowed for ${pathname}`,
        },
      ),
      actor,
      config,
    )
    return
  }

  // Fail-closed on a broken audit log: a mutating request must not reach its
  // handler if its audit line could not be written anyway. GETs may still
  // fail later in finish(); this gate is specifically about WRITES.
  if (method !== 'GET' && method !== 'HEAD' && runtime.audit.unavailable) {
    console.error('agent-catalog-server: refusing a write while the audit log is unavailable')
    sendJson(response, 500, errorBody('审计写入失败', 'audit-write-failed'))
    return
  }

  await finish(response, runtime, await dispatch(route, config), actor, config)
}

async function dispatch(route: ResolvedRoute, config: AgentCatalogConfig): Promise<HandlerResult> {
  if (route.legacy) {
    if (route.id === 'catalog.list') {
      return jsonResult(200, { items: loadEntries(config.entriesDir) }, {
        action: 'catalog.list',
        outcome: 'ok',
      })
    }
    let name: string
    try {
      name = decodeURIComponent(route.entryNameRaw ?? '')
    } catch {
      // Malformed percent-encoding is a miss, exactly like M-A0: it must not
      // throw a URIError and take the request (or process) down.
      return jsonResult(404, errorBody('条目不存在'), {
        action: 'catalog.get',
        outcome: 'error',
        reason: 'malformed percent-encoding in the entry name',
      })
    }
    const entry = findEntry(config.entriesDir, name)
    if (entry === undefined) {
      return jsonResult(404, errorBody('条目不存在'), {
        action: 'catalog.get',
        outcome: 'error',
        reason: `entry not found: ${name}`,
      })
    }
    return jsonResult(200, entry, { action: 'catalog.get', outcome: 'ok' })
  }

  // Tasks 5/6 install the handlers for these already-authorized routes.
  // 501 is deliberate: a reserved route must fail loudly, never pretend to be
  // an unknown path.
  return jsonResult(501, errorBody('接口尚未实现', 'not-implemented'), {
    action: route.id,
    outcome: 'error',
    reason: 'handler is introduced by a later task',
    ...routeAuditContext(route),
  })
}

/**
 * Create the HTTP server. `runtime` is optional so production code can use the
 * documented `createAgentCatalogServer(config)` signature; tests pass an
 * already-open runtime to inspect the store/audit directly.
 */
export function createAgentCatalogServer(
  config: AgentCatalogConfig,
  runtime?: AgentCatalogRuntime,
): Server {
  const runtimePromise =
    runtime === undefined ? createAgentCatalogRuntime(config) : Promise.resolve(runtime)
  // Avoid an unhandled rejection when no request ever awaits the lazy runtime;
  // each request still observes the rejection through `runtimePromise`.
  void runtimePromise.catch(() => undefined)

  const server = createServer((request, response) => {
    void handleRequest(request, response, config, runtimePromise).catch(cause => {
      // Last-resort guard: a handler bug must not leak a stack trace or kill
      // the process. The response (if still writable) is a generic 500.
      const message = redactSecrets(String((cause as Error)?.message ?? cause), secretList(config))
      console.error(`agent-catalog-server: request failed: ${message}`)
      if (!response.headersSent) {
        response.writeHead(500, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
      }
      response.end()
    })
  })
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.headersTimeout = DEFAULT_HEADERS_TIMEOUT_MS
  server.timeout = SOCKET_TIMEOUT_MS
  return server
}
