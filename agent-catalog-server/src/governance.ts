/**
 * Delist requests, revocations and the distribution state machine (Task 6).
 *
 * Flow (design spec §8.2/§8.3, plan Task 6):
 *
 *   POST   {slug}/{version}/delist-requests      publish  `{ reason }`, creator only
 *   GET    delist-requests?status=pending        admin    the pending queue
 *   POST   delist-requests/{id}/approve          admin    withdrawal, one commit
 *   POST   delist-requests/{id}/reject           admin    optional `{ reason }`
 *   POST   {slug}/{version}/revoke               admin    `{ reason }`, terminal
 *   GET    revocations                           read     the revocation list
 *
 * Semantics this module owns:
 *
 *   - A delist request is a REQUEST: while it is pending the package stays
 *     published, listed and downloadable. Approval is what moves the package to
 *     `delisted`; rejection only resolves the request.
 *   - Only the creator of the published version may apply. The published record
 *     stores the APPROVING administrator in `actor` (Task 5), so the creator is
 *     resolved from the submission that produced the exact slug/version; the
 *     stored actor is used only when that link no longer exists.
 *   - A duplicate pending application is idempotent: it returns the SAME
 *     request id (200) instead of creating a second record. A resolved request
 *     can never be resolved again (409). After a rejection the creator may file
 *     a NEW request.
 *   - Revocation is terminal: it writes one `Revocation` and sets the package to
 *     `revoked`. Repeating it keeps the FIRST reason/revokedAt/actor and answers
 *     200 without touching the state. There is deliberately no unrevoke route.
 *   - Every mutating handler runs under the per-package lock, so an approval can
 *     never race a revocation (or another approval). Whichever runs second sees
 *     the committed state: an approval that arrives after a revocation marks the
 *     request approved but NEVER downgrades the package back to `delisted`.
 *
 * Read filtering is NOT implemented here: `packageDistributionStatus` (types.ts)
 * is the single rule the list/metadata/bundle routes consult. This module only
 * writes the state that rule reads.
 *
 * Dependency direction: governance imports the shared HTTP kit from
 * submissions.ts (capped body reader, reason rule, package lookup). submissions
 * must never import governance — that is why the distribution helper lives in
 * types.ts.
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import type { AgentCatalogRole } from './auth.ts'
import { packageKey, type CatalogStore } from './store.ts'
import {
  MAX_REASON_LENGTH,
  findPackageRecord,
  payloadTooLarge,
  readJsonObject,
  reasonFromBody,
  type JsonBody,
} from './submissions.ts'
import type {
  CatalogState,
  DelistRequest,
  DelistRequestListBody,
  HandlerResult,
  PublishedPackage,
  Revocation,
  RevocationListBody,
  RevocationListEntry,
} from './types.ts'

/** Stable audit actions (the route ids of server.ts). */
const ACTIONS = {
  create: 'agentPackages.delistRequests.create',
  pending: 'agentPackages.delistRequests.pending',
  approve: 'agentPackages.delistRequests.approve',
  reject: 'agentPackages.delistRequests.reject',
  revoke: 'agentPackages.revoke',
  revocations: 'agentPackages.revocations.list',
} as const

/**
 * Delist request ids are server-generated UUIDs, exactly like submission ids.
 * The shape guard keeps `..`-like URL segments out of the state lookup.
 */
const DELIST_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * Revocation list paging (I-6). One page is capped at 200 items and each
 * revocation reason is capped at 4 KiB, so a page stays well below the 1 MiB
 * JSON response cap (200 × 4 KiB = 800 KiB before field overhead). Without a
 * page bound the whole list is one response, and a catalog that outgrew the
 * cap could never refresh again — new revocations would stay invisible.
 */
const REVOCATION_PAGE_DEFAULT = 200
const REVOCATION_PAGE_MAX = 200
const MAX_REVOCATION_REASON_BYTES = 4096

/** Everything a governance handler may touch (plumbed by the dispatcher). */
export interface GovernanceHandlerContext {
  readonly request: IncomingMessage
  readonly store: CatalogStore
  readonly role: AgentCatalogRole
  readonly actor: string
  /** The request whose durable audit intent this mutation must be bound to. */
  readonly requestId: string
}

interface Conflict {
  readonly status: number
  readonly error: string
  readonly code: string
  readonly reason: string
}

/** The request/slug/version coordinates every governance audit line carries. */
interface AuditContext {
  readonly slug?: string
  readonly version?: string
  readonly delistRequestId?: string
}

function result(status: number, body: unknown, audit: HandlerResult['audit']): HandlerResult {
  return { status, body, audit }
}

function errorBody(error: string, code: string): { error: string; code: string } {
  return { error, code }
}

function isDelistRequestId(value: string): boolean {
  return DELIST_REQUEST_ID_PATTERN.test(value)
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * The actor that created the published version.
 *
 * Task 5 stores the admin who APPROVED the submission in `PublishedPackage.actor`
 * (pinned by tests/submissions.spec.ts), so the creator must be read from the
 * submission that produced this exact slug/version. The stored actor is the
 * fallback for a record whose submission link no longer exists — refusing there
 * would lock a version out of its only withdrawal path.
 */
function creatorActorOf(state: CatalogState, record: PublishedPackage): string {
  for (const submission of Object.values(state.submissions)) {
    if (
      submission.slug === record.slug
      && submission.version === record.version
      && submission.status === 'published'
    ) {
      return submission.actor
    }
  }
  return record.actor
}

function findPendingRequest(
  state: Pick<CatalogState, 'delistRequests'>,
  slug: string,
  version: string,
): DelistRequest | undefined {
  for (const record of Object.values(state.delistRequests)) {
    if (record.status === 'pending' && record.slug === slug && record.version === version) {
      return record
    }
  }
  return undefined
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function notFoundPackage(action: string, slug: string, version: string): HandlerResult {
  return result(404, errorBody('版本不存在', 'not-found'), {
    action,
    outcome: 'error',
    reason: `package not found: ${slug}/${version}`,
    slug,
    version,
  })
}

function notFoundRequest(action: string, requestId: string): HandlerResult {
  return result(404, errorBody('下架申请不存在', 'not-found'), {
    action,
    outcome: 'error',
    reason: `delist request not found: ${requestId}`,
    delistRequestId: requestId,
  })
}

function invalidBody(action: string, reason: string, context: AuditContext): HandlerResult {
  return result(400, errorBody('请求无效', 'invalid-body'), {
    action,
    outcome: 'error',
    reason,
    ...context,
  })
}

function invalidReason(action: string, context: AuditContext): HandlerResult {
  return result(
    400,
    errorBody(`原因需为 1-${String(MAX_REASON_LENGTH)} 个字符`, 'invalid-reason'),
    {
      action,
      outcome: 'error',
      reason: 'reason must be a trimmed string of 1-500 characters',
      ...context,
    },
  )
}

function conflictResult(
  action: string,
  context: AuditContext,
  conflict: Conflict,
): HandlerResult {
  return result(conflict.status, errorBody(conflict.error, conflict.code), {
    action,
    outcome: 'error',
    reason: conflict.reason,
    ...context,
  })
}

/** Trimmed reason of a write body, or the exact 400/413 the caller must send. */
function requireReason(
  body: JsonBody,
  action: string,
  context: AuditContext,
): { readonly reason: string } | { readonly rejection: HandlerResult } {
  if (body.kind === 'too-large') return { rejection: payloadTooLarge(action) }
  if (body.kind !== 'object') {
    return { rejection: invalidBody(action, 'body must be a JSON object with a reason', context) }
  }
  const reason = reasonFromBody(body)
  if (reason === null) return { rejection: invalidReason(action, context) }
  return { reason }
}

type AdminReason =
  | { readonly kind: 'none' }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'reason'; readonly reason: string }

/**
 * The admin's optional rejection reason. An absent/empty body or an object
 * without `reason` means "no reason given"; a present but malformed `reason` is
 * an error rather than being silently dropped.
 */
function adminReasonOf(body: JsonBody): AdminReason {
  if (body.kind === 'empty') return { kind: 'none' }
  if (body.kind === 'too-large') return { kind: 'too-large' }
  if (body.kind !== 'object') return { kind: 'invalid' }
  if (body.value.reason === undefined) return { kind: 'none' }
  const reason = reasonFromBody(body)
  return reason === null ? { kind: 'invalid' } : { kind: 'reason', reason }
}

// ---------------------------------------------------------------------------
// POST /v1/agent-packages/{slug}/{version}/delist-requests
// ---------------------------------------------------------------------------

export async function createDelistRequest(
  context: GovernanceHandlerContext,
  slug: string,
  version: string,
): Promise<HandlerResult> {
  const action = ACTIONS.create
  const record = findPackageRecord(context.store, slug, version)
  if (record === undefined) return notFoundPackage(action, slug, version)

  // Authorization precedes payload validation: a non-creator learns nothing
  // about the reason budget.
  if (creatorActorOf(context.store.read(), record) !== context.actor) {
    return result(403, errorBody('权限不足', 'forbidden'), {
      action,
      outcome: 'denied',
      reason: 'the publish actor is not the creator of this published version',
      slug,
      version,
    })
  }

  const body = await readJsonObject(context.request)
  const parsed = requireReason(body, action, { slug, version })
  if ('rejection' in parsed) return parsed.rejection
  const { reason } = parsed

  const requestId = randomUUID()
  const outcome = await context.store.withPackageLock(slug, version, async () => {
    const state = context.store.read()
    const live = state.packages[packageKey(slug, version)]
    if (live === undefined) return { kind: 'not-found' as const }
    if (live.status !== 'published') {
      return { kind: 'not-published' as const, status: live.status }
    }
    const pending = findPendingRequest(state, slug, version)
    if (pending !== undefined) return { kind: 'pending' as const, request: pending }

    const request: DelistRequest = {
      id: requestId,
      slug,
      version,
      status: 'pending',
      reason,
      actor: context.actor,
      createdAt: new Date().toISOString(),
    }
    await context.store.mutate(context.requestId, action, draft => {
      if (draft.packages[packageKey(slug, version)]?.status !== 'published') {
        throw new Error(`package ${slug}/${version} changed while requesting delisting`)
      }
      if (findPendingRequest(draft, slug, version) !== undefined) {
        throw new Error(`a pending delist request appeared for ${slug}/${version}`)
      }
      draft.delistRequests[request.id] = request
    })
    return { kind: 'created' as const, request }
  })

  switch (outcome.kind) {
    case 'not-found':
      return notFoundPackage(action, slug, version)
    case 'not-published':
      return conflictResult(
        action,
        { slug, version },
        {
          status: 409,
          error: '版本未处于已发布状态',
          code: 'package-not-published',
          reason: `package ${slug}/${version} is ${outcome.status}`,
        },
      )
    case 'pending':
      // Idempotent replay: the SAME request id, the FIRST reason.
      return result(200, outcome.request, {
        action,
        outcome: 'ok',
        reason: `returned the existing pending request ${outcome.request.id}`,
        slug,
        version,
        delistRequestId: outcome.request.id,
      })
    case 'created':
      return {
        status: 201,
        body: outcome.request,
        audit: {
          action,
          outcome: 'ok',
          // M-2: the creator's (trimmed) reason is part of the success record.
          reason: outcome.request.reason,
          slug,
          version,
          delistRequestId: outcome.request.id,
        },
      }
  }
}

// ---------------------------------------------------------------------------
// GET /v1/agent-packages/delist-requests?status=pending
// ---------------------------------------------------------------------------

export async function listDelistRequests(context: GovernanceHandlerContext): Promise<HandlerResult> {
  const action = ACTIONS.pending
  let status: string | null
  try {
    status = new URL(context.request.url ?? '/', 'http://localhost').searchParams.get('status')
  } catch {
    status = null
  }
  if (status !== 'pending') {
    return result(400, errorBody('不支持的下架申请状态筛选', 'invalid-status'), {
      action,
      outcome: 'error',
      reason: `unsupported status filter: ${String(status)}`,
    })
  }

  const body: DelistRequestListBody = {
    items: Object.values(context.store.read().delistRequests)
      .filter(record => record.status === 'pending')
      .sort((left, right) =>
        left.createdAt === right.createdAt
          ? compareStrings(left.id, right.id)
          : compareStrings(left.createdAt, right.createdAt),
      ),
  }
  return result(200, body, { action, outcome: 'ok' })
}

// ---------------------------------------------------------------------------
// POST /v1/agent-packages/delist-requests/{id}/approve
// ---------------------------------------------------------------------------

export async function approveDelistRequest(
  context: GovernanceHandlerContext,
  requestId: string,
): Promise<HandlerResult> {
  const action = ACTIONS.approve
  if (!isDelistRequestId(requestId)) return notFoundRequest(action, requestId)
  const snapshot = context.store.read().delistRequests[requestId]
  if (snapshot === undefined) return notFoundRequest(action, requestId)
  const auditContext = { slug: snapshot.slug, version: snapshot.version, delistRequestId: requestId }
  if (snapshot.status !== 'pending') {
    return conflictResult(action, auditContext, {
      status: 409,
      error: '下架申请已处理',
      code: 'delist-request-not-pending',
      reason: `delist request ${requestId} is ${snapshot.status}`,
    })
  }

  const outcome = await context.store.withPackageLock(
    snapshot.slug,
    snapshot.version,
    async () => {
      const state = context.store.read()
      const current = state.delistRequests[requestId]
      if (current === undefined) return { kind: 'not-found' as const }
      if (current.status !== 'pending') {
        return { kind: 'conflict' as const, status: current.status }
      }
      const pkg = state.packages[packageKey(current.slug, current.version)]
      if (pkg === undefined) return { kind: 'package-missing' as const }

      const resolvedAt = new Date().toISOString()
      const updated = await context.store.mutate(context.requestId, action, draft => {
        const live = draft.delistRequests[requestId]
        if (live === undefined || live.status !== 'pending') {
          throw new Error(`delist request ${requestId} changed while approving`)
        }
        live.status = 'approved'
        live.resolvedAt = resolvedAt
        const packageRecord = draft.packages[packageKey(live.slug, live.version)]
        if (packageRecord !== undefined && packageRecord.status === 'published') {
          // ONE commit: request resolved AND package withdrawn. A package that
          // is already `revoked` keeps that terminal state (never a downgrade).
          packageRecord.status = 'delisted'
          packageRecord.updatedAt = resolvedAt
        }
        return live
      })
      return { kind: 'approved' as const, request: updated }
    },
  )

  switch (outcome.kind) {
    case 'not-found':
      return notFoundRequest(action, requestId)
    case 'package-missing':
      return conflictResult(action, auditContext, {
        status: 409,
        error: '版本未处于已发布状态',
        code: 'package-not-published',
        reason: `package ${snapshot.slug}/${snapshot.version} no longer exists`,
      })
    case 'conflict':
      return conflictResult(action, auditContext, {
        status: 409,
        error: '下架申请已处理',
        code: 'delist-request-not-pending',
        reason: `delist request ${requestId} became ${outcome.status} while approving`,
      })
    case 'approved':
      return result(200, outcome.request, {
        action,
        outcome: 'ok',
        ...auditContext,
      })
  }
}

// ---------------------------------------------------------------------------
// POST /v1/agent-packages/delist-requests/{id}/reject
// ---------------------------------------------------------------------------

export async function rejectDelistRequest(
  context: GovernanceHandlerContext,
  requestId: string,
): Promise<HandlerResult> {
  const action = ACTIONS.reject
  if (!isDelistRequestId(requestId)) return notFoundRequest(action, requestId)
  const snapshot = context.store.read().delistRequests[requestId]
  if (snapshot === undefined) return notFoundRequest(action, requestId)
  const auditContext = { slug: snapshot.slug, version: snapshot.version, delistRequestId: requestId }
  if (snapshot.status !== 'pending') {
    return conflictResult(action, auditContext, {
      status: 409,
      error: '下架申请已处理',
      code: 'delist-request-not-pending',
      reason: `delist request ${requestId} is ${snapshot.status}`,
    })
  }

  const body = await readJsonObject(context.request)
  const adminReason = adminReasonOf(body)
  if (adminReason.kind === 'too-large') return payloadTooLarge(action)
  if (adminReason.kind === 'invalid') {
    return invalidBody(action, 'reject body must be empty or { reason }', auditContext)
  }

  const outcome = await context.store.withPackageLock(
    snapshot.slug,
    snapshot.version,
    async () => {
      const current = context.store.read().delistRequests[requestId]
      if (current === undefined) return { kind: 'not-found' as const }
      if (current.status !== 'pending') {
        return { kind: 'conflict' as const, status: current.status }
      }
      // Only the request changes; the package stays published.
      const updated = await context.store.mutate(context.requestId, action, draft => {
        const live = draft.delistRequests[requestId]
        if (live === undefined || live.status !== 'pending') {
          throw new Error(`delist request ${requestId} changed while rejecting`)
        }
        live.status = 'rejected'
        live.resolvedAt = new Date().toISOString()
        return live
      })
      return { kind: 'rejected' as const, request: updated }
    },
  )

  const rejectionSuffix = adminReason.kind === 'reason' ? `: ${adminReason.reason}` : ''
  switch (outcome.kind) {
    case 'not-found':
      return notFoundRequest(action, requestId)
    case 'conflict':
      return conflictResult(action, auditContext, {
        status: 409,
        error: '下架申请已处理',
        code: 'delist-request-not-pending',
        reason: `delist request ${requestId} became ${outcome.status} while rejecting`,
      })
    case 'rejected':
      return result(200, outcome.request, {
        action,
        outcome: 'ok',
        reason: `delist request rejected${rejectionSuffix}`,
        ...auditContext,
      })
  }
}

// ---------------------------------------------------------------------------
// POST /v1/agent-packages/{slug}/{version}/revoke
// ---------------------------------------------------------------------------

export async function revokePackage(
  context: GovernanceHandlerContext,
  slug: string,
  version: string,
): Promise<HandlerResult> {
  const action = ACTIONS.revoke
  if (findPackageRecord(context.store, slug, version) === undefined) {
    return notFoundPackage(action, slug, version)
  }

  const body = await readJsonObject(context.request)
  // The byte cap is checked FIRST: a reason that is oversized in bytes is
  // rejected as such even when it would also blow the character budget, and a
  // bounded reason is what keeps a 200-item page under the JSON cap.
  if (body.kind === 'object') {
    const rawReason = body.value.reason
    const reasonBytes =
      typeof rawReason === 'string' ? Buffer.byteLength(rawReason.trim(), 'utf8') : 0
    if (reasonBytes > MAX_REVOCATION_REASON_BYTES) {
      return result(400, errorBody('撤销原因过长', 'reason-too-long'), {
        action,
        outcome: 'error',
        reason: `revocation reason exceeds ${String(MAX_REVOCATION_REASON_BYTES)} bytes`,
        slug,
        version,
      })
    }
  }
  const parsed = requireReason(body, action, { slug, version })
  if ('rejection' in parsed) return parsed.rejection
  const { reason } = parsed

  const outcome = await context.store.withPackageLock(slug, version, async () => {
    const state = context.store.read()
    const live = state.packages[packageKey(slug, version)]
    if (live === undefined) return { kind: 'not-found' as const }
    const existing = state.revocations[packageKey(slug, version)]
    if (existing !== undefined) return { kind: 'replayed' as const, revocation: existing }

    const revocation: Revocation = {
      slug,
      version,
      reason,
      revokedAt: new Date().toISOString(),
      actor: context.actor,
    }
    await context.store.mutate(context.requestId, action, draft => {
      const packageRecord = draft.packages[packageKey(slug, version)]
      if (packageRecord === undefined) {
        throw new Error(`package ${slug}/${version} vanished while revoking`)
      }
      if (draft.revocations[packageKey(slug, version)] !== undefined) {
        throw new Error(`package ${slug}/${version} was revoked concurrently`)
      }
      draft.revocations[packageKey(slug, version)] = revocation
      packageRecord.status = 'revoked'
      packageRecord.updatedAt = revocation.revokedAt
    })
    return { kind: 'revoked' as const, revocation }
  })

  switch (outcome.kind) {
    case 'not-found':
      return notFoundPackage(action, slug, version)
    case 'replayed':
      // Idempotent: the FIRST reason/revokedAt/actor wins, and no state is
      // written (the package timestamp does not move either). The submitted
      // reason is still audited (spec §8.6 requires 原因); `redactSecrets`
      // runs on the free text before serialization.
      return result(200, outcome.revocation, {
        action,
        outcome: 'ok',
        reason: `idempotent replay: the first revocation is kept; submitted reason: ${reason}`,
        slug,
        version,
      })
    case 'revoked':
      return result(200, outcome.revocation, {
        action,
        outcome: 'ok',
        reason: `revocation reason: ${reason}`,
        slug,
        version,
      })
  }
}

// ---------------------------------------------------------------------------
// GET /v1/agent-packages/revocations
// ---------------------------------------------------------------------------

/** The sort/projection tuple of a revocation: never the audit-only actor. */
interface RevocationCursor {
  readonly revokedAt: string
  readonly slug: string
  readonly version: string
}

/**
 * The ONE ordering of the revocation list: `(revokedAt, slug, version)`
 * ascending. The page cursor is the same tuple, so a page boundary can never
 * fall inside an ambiguous group of equal timestamps.
 */
function compareRevocationCursor(left: RevocationCursor, right: RevocationCursor): number {
  const byTime = compareStrings(left.revokedAt, right.revokedAt)
  if (byTime !== 0) return byTime
  const bySlug = compareStrings(left.slug, right.slug)
  return bySlug !== 0 ? bySlug : compareStrings(left.version, right.version)
}

/** Explicit projection, never `{ ...record }`: `actor` must not leak. */
function projectRevocation(record: Revocation): RevocationListEntry {
  return {
    slug: record.slug,
    version: record.version,
    reason: record.reason,
    revokedAt: record.revokedAt,
  }
}

function encodeRevocationCursor(record: RevocationCursor): string {
  return Buffer.from(
    JSON.stringify({
      revokedAt: record.revokedAt,
      slug: record.slug,
      version: record.version,
    }),
    'utf8',
  ).toString('base64url')
}

/** An opaque cursor, or null when the value is absent/not the documented tuple. */
function decodeRevocationCursor(raw: string | null): RevocationCursor | null {
  if (raw === null || raw === '') return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (!isRecord(parsed)) return null
    const { revokedAt, slug, version } = parsed
    if (typeof revokedAt !== 'string' || typeof slug !== 'string' || typeof version !== 'string') {
      return null
    }
    return { revokedAt, slug, version }
  } catch {
    return null
  }
}

export async function listRevocations(context: GovernanceHandlerContext): Promise<HandlerResult> {
  const action = ACTIONS.revocations
  const url = new URL(context.request.url ?? '/', 'http://localhost')
  const rawCursor = url.searchParams.get('cursor')
  const cursor = decodeRevocationCursor(rawCursor)
  if (rawCursor !== null && cursor === null) {
    return result(400, errorBody('撤销游标无效', 'invalid-cursor'), {
      action,
      outcome: 'error',
      reason: 'invalid revocation cursor',
    })
  }
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? REVOCATION_PAGE_DEFAULT : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > REVOCATION_PAGE_MAX) {
    return result(400, errorBody('撤销分页大小无效', 'invalid-limit'), {
      action,
      outcome: 'error',
      reason: `invalid revocation limit: ${String(rawLimit)}`,
    })
  }

  const sorted = Object.values(context.store.read().revocations)
    .sort(compareRevocationCursor)
    .map(projectRevocation)
  // First item strictly AFTER the cursor tuple; a cursor past the end yields
  // an empty final page (and therefore no nextCursor), never a repeat.
  const start =
    cursor === null
      ? 0
      : sorted.findIndex(item => compareRevocationCursor(item, cursor) > 0)
  const pageStart = start === -1 ? sorted.length : start
  const page = sorted.slice(pageStart, pageStart + limit)
  const last = page[page.length - 1]
  const hasMore = last !== undefined && pageStart + page.length < sorted.length
  const body: RevocationListBody = {
    items: page,
    ...(hasMore ? { nextCursor: encodeRevocationCursor(last) } : {}),
  }
  return result(200, body, { action, outcome: 'ok' })
}
