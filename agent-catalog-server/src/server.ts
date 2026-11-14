/**
 * agent-catalog-server HTTP surface.
 *
 * Route table (Task 5 installs submissions + public reads; Task 6 installs the
 * delist/revocation governance routes):
 *
 *   read     GET  /v1/catalog, /v1/catalog/{name}
 *            GET  /v1/agent-packages
 *            GET  /v1/agent-packages/{slug}/{version}
 *            GET  /v1/agent-packages/{slug}/{version}/bundle
 *            GET  /v1/agent-packages/revocations
 *   publish  POST /v1/agent-packages/submissions
 *            GET  /v1/agent-packages/submissions/{id}      (creator check in submissions.ts)
 *            POST /v1/agent-packages/{slug}/{version}/delist-requests
 *   admin    GET  /v1/agent-packages/submissions?status=pending
 *            GET  /v1/agent-packages/submissions/{id}      (any submission)
 *            GET  /v1/agent-packages/submissions/{id}/bundle
 *            POST /v1/agent-packages/submissions/{id}/approve|reject
 *            GET  /v1/agent-packages/delist-requests?status=pending
 *            POST /v1/agent-packages/delist-requests/{id}/approve|reject
 *            POST /v1/agent-packages/{slug}/{version}/revoke
 *
 * Task 5 handlers live in submissions.ts, Task 6 handlers in governance.ts; both
 * return ordinary `HandlerResult`s (expected conflicts included) so every
 * outcome is audited before it is sent.
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
 * Every response — including 401/403/404/405, unknown routes and unexpected
 * handler failures (500 `internal`, whose cause is recorded in the audit line
 * and printed, redacted, to the console) — is audited before it is written
 * (see audit.ts). JSON error bodies are always `{ error, code? }`; JSON
 * responses are capped at 1 MiB. The server never logs the Authorization
 * header and never logs a request line containing a token: path-derived text
 * reaches only the audit log, where it is redacted.
 *
 * Mutating requests additionally write a durable intent to
 * `audit-intents.jsonl` BEFORE the handler runs, and every request id is
 * stamped on both the intent and the result line (Task 4). If the intent
 * cannot be written the request is refused with 500 `audit-write-failed` and
 * the handler never runs; a crash between the state commit and the result line
 * is closed at startup by `AuditLog.reconcile`.
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { AuditLog, redactSecrets, type AuditEvent } from './audit.ts'
import {
  authenticateSkillPublisher,
  authenticateToken,
  bearerToken,
  tokenActor,
  type AgentCatalogRole,
} from './auth.ts'
import type { AgentCatalogConfig } from './config.ts'
import {
  approveDelistRequest,
  createDelistRequest,
  listDelistRequests,
  listRevocations,
  rejectDelistRequest,
  revokePackage,
  type GovernanceHandlerContext,
} from './governance.ts'
import { findEntry, loadEntries } from './legacy.ts'
import { SkillStore } from './skill-store.ts'
import { downloadSkillArchive, getSkillRevision, listSkills, publishSkill } from './skills.ts'
import { CatalogStore } from './store.ts'
import {
  approveSubmission,
  createSubmission,
  downloadPackageBundle,
  downloadSubmissionBundle,
  getPackageMetadata,
  getSubmission,
  listPendingSubmissions,
  listPublishedPackages,
  rejectSubmission,
  type SubmissionHandlerContext,
} from './submissions.ts'
import type { AgentCatalogErrorBody, HandlerResult } from './types.ts'

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
  readonly skillStore: SkillStore
  readonly skillAudit: AuditLog
}

/** Every configured secret, including skill upload tokens (spec §7.4). */
function secretList(config: AgentCatalogConfig): readonly string[] {
  return [
    config.readToken,
    config.publishToken,
    config.adminToken,
    ...Object.values(config.skillUploaders),
  ]
}

/**
 * Open the runtime (state stores first: a corrupt state file must refuse
 * startup before any request can be served or audited). After the stores and
 * their audit logs are open, unclosed write intents are reconciled (Task 4):
 * a crash between a state commit and its audit result line must not leave an
 * unaudited successful change. Skill state and the agent state keep separate
 * audit logs, so each reconciliation only sees its own journal.
 */
export async function createAgentCatalogRuntime(config: AgentCatalogConfig): Promise<AgentCatalogRuntime> {
  const secrets = secretList(config)
  const store = await CatalogStore.open(config.dataDir)
  const skillStore = await SkillStore.open(config.dataDir)
  const audit = await AuditLog.open(config.dataDir, secrets)
  const skillAudit = await AuditLog.open(join(config.dataDir, 'skills'), secrets)
  await audit.reconcile(store.read())
  await skillAudit.reconcile(skillStore.read())
  return { config, store, audit, skillStore, skillAudit }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

type PatternSegment = string | ':slug' | ':version' | ':id' | ':requestId' | ':skillName' | ':revision'

/** Role of a request: one of the agent roles, or a skill uploader. */
export type CatalogPrincipal = AgentCatalogRole | 'skill-publish'

interface RouteDefinition {
  readonly id: string
  readonly path: readonly PatternSegment[]
  readonly method: string
  readonly roles: readonly CatalogPrincipal[]
  /** Which audit journal the route writes to (spec §7.4). */
  readonly audit: 'agent' | 'skill'
}

/**
 * Ordered static-first table. `:id`/`:requestId` routes appear after every
 * literal route with the same prefix length, which is what protects
 * `/submissions/{id}` and `/delist-requests/{id}/approve` from being read as
 * `/{slug}/{version}` (and keeps the two capture kinds apart in the audit).
 */
const AGENT_PACKAGE_ROUTES: readonly RouteDefinition[] = [
  { id: 'agentPackages.list', path: [], method: 'GET', roles: ['read'], audit: 'agent' },
  { id: 'agentPackages.submissions.create', path: ['submissions'], method: 'POST', roles: ['publish'], audit: 'agent' },
  { id: 'agentPackages.submissions.pending', path: ['submissions'], method: 'GET', roles: ['admin'], audit: 'agent' },
  { id: 'agentPackages.submissions.get', path: ['submissions', ':id'], method: 'GET', roles: ['publish', 'admin'], audit: 'agent' },
  { id: 'agentPackages.submissions.bundle', path: ['submissions', ':id', 'bundle'], method: 'GET', roles: ['admin'], audit: 'agent' },
  { id: 'agentPackages.submissions.approve', path: ['submissions', ':id', 'approve'], method: 'POST', roles: ['admin'], audit: 'agent' },
  { id: 'agentPackages.submissions.reject', path: ['submissions', ':id', 'reject'], method: 'POST', roles: ['admin'], audit: 'agent' },
  { id: 'agentPackages.delistRequests.pending', path: ['delist-requests'], method: 'GET', roles: ['admin'], audit: 'agent' },
  { id: 'agentPackages.delistRequests.approve', path: ['delist-requests', ':requestId', 'approve'], method: 'POST', roles: ['admin'], audit: 'agent' },
  { id: 'agentPackages.delistRequests.reject', path: ['delist-requests', ':requestId', 'reject'], method: 'POST', roles: ['admin'], audit: 'agent' },
  { id: 'agentPackages.revocations.list', path: ['revocations'], method: 'GET', roles: ['read'], audit: 'agent' },
  { id: 'agentPackages.get', path: [':slug', ':version'], method: 'GET', roles: ['read'], audit: 'agent' },
  { id: 'agentPackages.bundle', path: [':slug', ':version', 'bundle'], method: 'GET', roles: ['read'], audit: 'agent' },
  { id: 'agentPackages.delistRequests.create', path: [':slug', ':version', 'delist-requests'], method: 'POST', roles: ['publish'], audit: 'agent' },
  { id: 'agentPackages.revoke', path: [':slug', ':version', 'revoke'], method: 'POST', roles: ['admin'], audit: 'agent' },
]

/**
 * Skill surface (spec §7.1). Static segment `archive` is matched after the
 * two-segment metadata pattern by length, never shadowed by `:skillName`.
 */
const SKILL_ROUTES: readonly RouteDefinition[] = [
  { id: 'skills.list', path: [], method: 'GET', roles: ['read'], audit: 'skill' },
  { id: 'skills.get', path: [':skillName', ':revision'], method: 'GET', roles: ['read'], audit: 'skill' },
  { id: 'skills.archive', path: [':skillName', ':revision', 'archive'], method: 'GET', roles: ['read'], audit: 'skill' },
  { id: 'skills.publish', path: [':skillName'], method: 'POST', roles: ['skill-publish'], audit: 'skill' },
]

interface ResolvedRoute {
  /** Stable action id used both for dispatch and for the audit action. */
  readonly id: string
  readonly roles: readonly CatalogPrincipal[]
  readonly audit: 'agent' | 'skill'
  readonly methodMatched: boolean
  readonly legacy: boolean
  readonly entryNameRaw?: string
  readonly slug?: string
  readonly version?: string
  readonly submissionId?: string
  /** Delist request id (`:requestId`); never a submission id. */
  readonly delistRequestId?: string
}

const AGENT_PACKAGE_PREFIX = '/v1/agent-packages'
const SKILLS_PREFIX = '/v1/skills'
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
    roles: readonly CatalogPrincipal[]
    audit: 'agent' | 'skill'
    methodMatched: boolean
    legacy: boolean
    slug?: string
    version?: string
    submissionId?: string
    delistRequestId?: string
  } = {
    id: definition.id,
    roles: definition.roles,
    audit: definition.audit,
    methodMatched,
    legacy: false,
  }
  // Skill routes reuse the agent audit coordinates: name -> slug,
  // revision -> version (spec §7.4), so routeAuditContext stays one shape.
  const slug = captures.skillName ?? captures.slug
  const version = captures.revision ?? captures.version
  if (slug !== undefined) route.slug = slug
  if (version !== undefined) route.version = version
  if (captures.id !== undefined) route.submissionId = captures.id
  if (captures.requestId !== undefined) route.delistRequestId = captures.requestId
  return route
}

function splitSkillPath(pathname: string): string[] | null {
  if (pathname === SKILLS_PREFIX) return []
  if (!pathname.startsWith(`${SKILLS_PREFIX}/`)) return null
  const rest = pathname.slice(SKILLS_PREFIX.length + 1)
  return rest === '' ? [] : rest.split('/')
}

/**
 * Match one surface's table. A known path with a wrong method answers 405
 * with the union of every method's roles, so authorization still runs before
 * the method verdict (a publish token cannot probe an admin-only path). The
 * method-not-allowed route keeps the surface's audit journal.
 */
function resolveSurface(
  method: string,
  segments: readonly string[],
  definitions: readonly RouteDefinition[],
  audit: 'agent' | 'skill',
): ResolvedRoute | null {
  for (const definition of definitions) {
    if (definition.method !== method) continue
    const captures = matchPattern(definition.path, segments)
    if (captures !== null) return withCaptures(definition, captures, true)
  }

  const roles = new Set<CatalogPrincipal>()
  let matchedPath = false
  for (const definition of definitions) {
    const captures = matchPattern(definition.path, segments)
    if (captures === null) continue
    matchedPath = true
    for (const role of definition.roles) roles.add(role)
  }
  if (!matchedPath) return null
  return {
    id: 'route.method-not-allowed',
    roles: [...roles],
    audit,
    methodMatched: false,
    legacy: false,
  }
}

function resolveRoute(method: string, pathname: string): ResolvedRoute | null {
  // Legacy M-A0 surface. Shape preserved exactly: `/v1/catalog` (list) and
  // `/v1/catalog/<name>` (single entry); everything else is unknown.
  if (pathname === LEGACY_PREFIX) {
    return { id: 'catalog.list', roles: ['read'], audit: 'agent', methodMatched: method === 'GET', legacy: true }
  }
  if (pathname.startsWith(`${LEGACY_PREFIX}/`)) {
    return {
      id: 'catalog.get',
      roles: ['read'],
      audit: 'agent',
      methodMatched: method === 'GET',
      legacy: true,
      entryNameRaw: pathname.slice(LEGACY_PREFIX.length + 1),
    }
  }

  const skillSegments = splitSkillPath(pathname)
  if (skillSegments !== null) return resolveSurface(method, skillSegments, SKILL_ROUTES, 'skill')

  const segments = splitAgentPackagePath(pathname)
  if (segments === null) return null
  return resolveSurface(method, segments, AGENT_PACKAGE_ROUTES, 'agent')
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

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
  audit: AuditLog,
  result: HandlerResult,
  actor: string,
  config: AgentCatalogConfig,
  requestId: string,
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
    requestId,
  }
  try {
    await audit.writeAudit(event)
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

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function routeAuditContext(
  route: ResolvedRoute,
): Pick<AuditEvent, 'slug' | 'version' | 'submissionId' | 'delistRequestId'> {
  const context: {
    slug?: string
    version?: string
    submissionId?: string
    delistRequestId?: string
  } = {}
  if (route.slug !== undefined) context.slug = route.slug
  if (route.version !== undefined) context.version = route.version
  if (route.submissionId !== undefined) context.submissionId = route.submissionId
  if (route.delistRequestId !== undefined) context.delistRequestId = route.delistRequestId
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

  // One id per request. It appears in the result line of EVERY response and in
  // the write intent of every mutating request (Task 4), which is what lets
  // startup reconciliation pair the two after a crash.
  const requestId = randomUUID()
  const method = request.method ?? 'GET'
  const presented = bearerToken(request)
  const actor = tokenActor(presented)

  let pathname: string
  try {
    pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  } catch {
    await finish(
      response,
      runtime.audit,
      jsonResult(400, errorBody('请求无效', 'bad-request'), {
        action: 'request.invalid',
        outcome: 'error',
        reason: 'malformed request URL',
      }),
      actor,
      config,
      requestId,
    )
    return
  }

  // BOTH authenticators always run: a role match must never skip the skill
  // uploader comparison (spec §7.4). The principal is the role when one
  // matched, otherwise the skill publisher id when an upload token matched.
  const identity = presented === undefined ? null : authenticateToken(config, presented)
  const publisher = presented === undefined ? undefined : authenticateSkillPublisher(config, presented)
  const route = resolveRoute(method, pathname)
  const targetAudit = route?.audit === 'skill' ? runtime.skillAudit : runtime.audit
  const principal: CatalogPrincipal | null = identity ?? (publisher === undefined ? null : 'skill-publish')

  if (principal === null) {
    await finish(
      response,
      targetAudit,
      jsonResult(401, errorBody('口令错误'), {
        action: 'auth.denied',
        outcome: 'denied',
        reason: presented === undefined ? 'missing token' : 'unrecognized token',
      }),
      actor,
      config,
      requestId,
    )
    return
  }

  if (route === null) {
    // Unmatched routes never belong to the skill surface: agent audit.
    await finish(
      response,
      runtime.audit,
      jsonResult(404, errorBody('Not Found'), {
        action: 'route.unknown',
        outcome: 'error',
        reason: `unknown route: ${pathname}`,
      }),
      actor,
      config,
      requestId,
    )
    return
  }

  if (!route.roles.includes(principal)) {
    await finish(
      response,
      targetAudit,
      jsonResult(403, errorBody('权限不足', 'forbidden'), {
        action: route.id,
        outcome: 'denied',
        reason: `role ${principal} is not allowed on this route`,
        ...routeAuditContext(route),
      }),
      actor,
      config,
      requestId,
    )
    return
  }

  if (!route.methodMatched) {
    await finish(
      response,
      targetAudit,
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
      requestId,
    )
    return
  }

  // Fail-closed on a broken audit log: a mutating request must not reach its
  // handler if its audit line could not be written anyway. GETs may still
  // fail later in finish(); this gate is specifically about WRITES.
  if (method !== 'GET' && method !== 'HEAD' && targetAudit.unavailable) {
    console.error('agent-catalog-server: refusing a write while the audit log is unavailable')
    sendJson(response, 500, errorBody('审计写入失败', 'audit-write-failed'))
    return
  }

  // Durable intent BEFORE the handler can commit state (Task 4 / I-5). If the
  // intent cannot be written the write is refused here: the handler never runs,
  // so there is no state change and nothing for reconciliation to guess about.
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      await targetAudit.writeIntent({
        action: route.id,
        actor,
        requestId,
        ...routeAuditContext(route),
      })
    } catch (cause) {
      const message = redactSecrets(String((cause as Error)?.message ?? cause), secretList(config))
      console.error(`agent-catalog-server: audit intent write failed: ${message}`)
      sendJson(response, 500, errorBody('审计写入失败', 'audit-write-failed'))
      return
    }
  }

  // A handler failure (an environmental one such as an entries path that is a
  // regular file, or a bug in code Tasks 5/6 add) still has to leave an AUDIT
  // RECORD before any response: "every request is audited" is the invariant,
  // and forensics matter most exactly when a handler blows up. The failure is
  // therefore converted into an ordinary HandlerResult instead of escaping to
  // the server-level guard (which is left for `finish` itself).
  let result: HandlerResult
  try {
    result = await dispatch(route, {
      request,
      runtime,
      config,
      role: principal,
      ...(publisher === undefined ? {} : { publisher }),
      actor,
      requestId,
    })
  } catch (cause) {
    const message = redactSecrets(String((cause as Error)?.message ?? cause), secretList(config))
    console.error(`agent-catalog-server: request handler failed: ${message}`)
    result = jsonResult(500, errorBody('内部错误', 'internal'), {
      action: route.id,
      outcome: 'error',
      reason: `unhandled handler error: ${message}`,
      ...routeAuditContext(route),
    })
  }
  await finish(response, targetAudit, result, actor, config, requestId)
}

interface DispatchContext {
  readonly request: IncomingMessage
  readonly runtime: AgentCatalogRuntime
  readonly config: AgentCatalogConfig
  readonly role: CatalogPrincipal
  /** Present whenever the presented token belongs to a skill uploader. */
  readonly publisher?: string
  readonly actor: string
  /** The id of this request; mutations stamp it into `state.lastMutation`. */
  readonly requestId: string
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://localhost')
}

async function dispatch(route: ResolvedRoute, context: DispatchContext): Promise<HandlerResult> {
  const { config } = context
  if (route.legacy) {
    // Malformed legacy files are reported on the process log; their path/content
    // can carry a token or PEM block, so both reads share the audit redaction.
    const redact = (text: string): string => redactSecrets(text, secretList(config))
    if (route.id === 'catalog.list') {
      return jsonResult(200, { items: loadEntries(config.entriesDir, redact) }, {
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
    const entry = findEntry(config.entriesDir, name, redact)
    if (entry === undefined) {
      return jsonResult(404, errorBody('条目不存在'), {
        action: 'catalog.get',
        outcome: 'error',
        reason: `entry not found: ${name}`,
      })
    }
    return jsonResult(200, entry, { action: 'catalog.get', outcome: 'ok' })
  }

  // Constructed lazily: skill routes must never build an agent handler context,
  // whose role invariant excludes the skill-publish principal.
  const handlers = (): SubmissionHandlerContext => submissionContext(context)
  const governance = (): GovernanceHandlerContext => governanceContext(context)
  switch (route.id) {
    case 'agentPackages.list':
      return listPublishedPackages(handlers())
    case 'agentPackages.get':
      return getPackageMetadata(handlers(), route.slug ?? '', route.version ?? '')
    case 'agentPackages.bundle':
      return downloadPackageBundle(handlers(), route.slug ?? '', route.version ?? '')
    case 'agentPackages.submissions.create':
      return createSubmission(handlers())
    case 'agentPackages.submissions.pending':
      return listPendingSubmissions(handlers())
    case 'agentPackages.submissions.get':
      return getSubmission(handlers(), route.submissionId ?? '')
    case 'agentPackages.submissions.bundle':
      return downloadSubmissionBundle(handlers(), route.submissionId ?? '')
    case 'agentPackages.submissions.approve':
      return approveSubmission(handlers(), route.submissionId ?? '')
    case 'agentPackages.submissions.reject':
      return rejectSubmission(handlers(), route.submissionId ?? '')
    case 'agentPackages.delistRequests.create':
      return createDelistRequest(governance(), route.slug ?? '', route.version ?? '')
    case 'agentPackages.delistRequests.pending':
      return listDelistRequests(governance())
    case 'agentPackages.delistRequests.approve':
      return approveDelistRequest(governance(), route.delistRequestId ?? '')
    case 'agentPackages.delistRequests.reject':
      return rejectDelistRequest(governance(), route.delistRequestId ?? '')
    case 'agentPackages.revoke':
      return revokePackage(governance(), route.slug ?? '', route.version ?? '')
    case 'agentPackages.revocations.list':
      return listRevocations(governance())
    case 'skills.list':
      return listSkills(context.runtime.skillStore, requestUrl(context.request))
    case 'skills.get':
      return getSkillRevision(context.runtime.skillStore, route.slug ?? '', route.version ?? '')
    case 'skills.archive':
      return downloadSkillArchive(context.runtime.skillStore, route.slug ?? '', route.version ?? '')
    case 'skills.publish': {
      const publisher = context.publisher
      if (publisher === undefined) {
        throw new Error('a skill-publish principal must carry a publisher id')
      }
      return publishSkill({
        request: context.request,
        store: context.runtime.skillStore,
        publisher,
        requestId: context.requestId,
      }, route.slug ?? '')
    }
    default:
      // Unreachable while AGENT_PACKAGE_ROUTES and this switch agree. It must
      // still answer with the unified body: adding a route id without a handler
      // is a programming error, never an unknown path.
      return jsonResult(500, errorBody('内部错误', 'unhandled-route'), {
        action: route.id,
        outcome: 'error',
        reason: 'the resolved route has no handler',
        ...routeAuditContext(route),
      })
  }
}

/**
 * The agent handlers were written against the three agent roles. A
 * `skill-publish` principal can only reach skill routes (the role sets never
 * overlap), so this narrowing is an invariant assertion, not a mapping.
 */
function agentRole(context: DispatchContext): AgentCatalogRole {
  if (context.role === 'skill-publish') {
    throw new Error('skill-publish principal dispatched an agent route')
  }
  return context.role
}

function submissionContext(context: DispatchContext): SubmissionHandlerContext {
  return {
    request: context.request,
    config: context.config,
    store: context.runtime.store,
    role: agentRole(context),
    actor: context.actor,
    requestId: context.requestId,
  }
}

/** The governance handlers only need the state store (no entries/keyring). */
function governanceContext(context: DispatchContext): GovernanceHandlerContext {
  return {
    request: context.request,
    store: context.runtime.store,
    role: agentRole(context),
    actor: context.actor,
    requestId: context.requestId,
  }
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
      // Last-resort guard, narrowed to failures of `finish` itself (audit or
      // response plumbing): every handler failure is caught and audited inside
      // handleRequest. A stack trace still never escapes to the client, and the
      // body stays the unified `{ error, code }` shape when nothing was sent.
      const message = redactSecrets(String((cause as Error)?.message ?? cause), secretList(config))
      console.error(`agent-catalog-server: request failed: ${message}`)
      if (!response.headersSent) {
        sendJson(response, 500, errorBody('内部错误', 'internal'))
        return
      }
      response.end()
    })
  })
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.headersTimeout = DEFAULT_HEADERS_TIMEOUT_MS
  server.timeout = SOCKET_TIMEOUT_MS
  return server
}
