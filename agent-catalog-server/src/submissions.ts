/**
 * Agent-package submissions, independent digest and signed publishing (Task 5).
 *
 * Flow (design spec §8.3/§8.4):
 *
 *   POST   submissions                publish  raw `application/gzip` upload
 *   GET    submissions?status=pending admin    pending review queue
 *   GET    submissions/{id}           publish|admin (creator check for publish)
 *   GET    submissions/{id}/bundle    admin    the ORIGINAL unsigned bytes
 *   POST   submissions/{id}/approve   admin    `{ signature }` over the stored digest
 *   POST   submissions/{id}/reject    admin    `{ reason }` (trimmed, 1-500)
 *
 *   GET    /                          read     highest published version per slug
 *   GET    {slug}/{version}           read     metadata (digest + signature)
 *   GET    {slug}/{version}/bundle    read     signed bytes (410 once withdrawn)
 *
 * Invariants this module owns:
 *
 *   - The digest is ALWAYS recomputed from the uploaded bytes; a client-supplied
 *     digest is not read, accepted or stored.
 *   - The upload body is raw gzip and is capped: buffering stops at
 *     `MAX_AGENT_PACKAGE_BUNDLE_BYTES + 1`, so an oversized body is refused with
 *     413 instead of being read into memory.
 *   - Conflicts are version-scoped for packages (same slug + different version
 *     is the update path) and name-scoped for legacy directory entries. The
 *     only exception is an explicit, matching `X-Agent-Catalog-Migration` header
 *     for a same-name `kind:"agent"` entry; tools never migrate. Conflicts are
 *     re-checked at approval so a slug cannot be occupied while pending.
 *   - Approval verifies the admin signature against the PINNED keyring over the
 *     STORED digest, rebuilds the signed bundle, self-checks it, writes
 *     `packages/{slug}/{version}/bundle.tgz` via temp+rename, and only then
 *     commits ONE state update (package published + submission published).
 *     Nothing is visible before that commit: read routes only consult
 *     `CatalogStore` state and never scan the packages directory.
 *   - `PublishedPackage.size` is the FINAL signed bundle byte count; list and
 *     detail responses only use the stored, validated manifest (never a client
 *     field).
 *   - The list, metadata and bundle routes derive listability, `bundleUrl` and
 *     the 410 verdict from ONE helper (`packageDistributionStatus`, types.ts);
 *     none of them tests `record.status` itself.
 *
 * All failures are ordinary `HandlerResult`s so the dispatcher can audit them
 * before answering (server.ts); expected conflicts are never thrown.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open as openFile, readFile, rename } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { basename, dirname, join } from 'node:path'

import {
  MAX_AGENT_PACKAGE_BUNDLE_BYTES,
  buildSignedAgentPackageBundle,
  compareAgentPackageVersions,
  inspectSignedAgentPackageBundle,
  inspectUnsignedAgentPackageBundle,
  type AgentPackageDigest,
} from '@huaanwork/agent-package-format'
import {
  canonicalJson,
  verifyAgentPackageDigestSignature,
  type CatalogSignature,
} from '@huaanwork/catalog-signing'

import type { AgentCatalogRole } from './auth.ts'
import type { AgentCatalogConfig } from './config.ts'
import { findEntry } from './legacy.ts'
import { packageKey, type CatalogStore } from './store.ts'
import { packageDistributionStatus, type AdminSubmissionResponse } from './types.ts'
import type {
  AgentPackageMetadata,
  AgentPackageSummary,
  CatalogState,
  HandlerResult,
  LegacyCatalogEntry,
  PublishedPackage,
  Submission,
  SubmissionResponse,
} from './types.ts'

/** Data-directory layout owned by this module. */
export const SUBMISSIONS_DIRECTORY = 'submissions'
export const PACKAGES_DIRECTORY = 'packages'
export const BUNDLE_FILE_NAME = 'bundle.tgz'

/** Explicit migration exception header (`X-Agent-Catalog-Migration: <slug>`). */
export const MIGRATION_HEADER = 'x-agent-catalog-migration'

/**
 * Upload read cap. A legal bundle is at most 5 MiB, so the read aborts at
 * 5 MiB + 1: accepting the cap itself would only let the inspector reject a
 * body that can never be a legal package.
 */
export const SUBMISSION_BODY_CAP_BYTES = MAX_AGENT_PACKAGE_BUNDLE_BYTES + 1

/** JSON bodies of approve/reject are tiny; the cap bounds a hostile client. */
export const MAX_JSON_REQUEST_BYTES = 64 * 1024

/** `reason` budget of a rejection (trimmed). */
export const MAX_REASON_LENGTH = 500

/** Stable audit actions (the route ids of server.ts). */
const ACTIONS = {
  create: 'agentPackages.submissions.create',
  pending: 'agentPackages.submissions.pending',
  get: 'agentPackages.submissions.get',
  reviewBundle: 'agentPackages.submissions.bundle',
  approve: 'agentPackages.submissions.approve',
  reject: 'agentPackages.submissions.reject',
  list: 'agentPackages.list',
  metadata: 'agentPackages.get',
  bundle: 'agentPackages.bundle',
} as const

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
/**
 * Static top-level segments of `/v1/agent-packages/*` (server.ts). A package
 * using one of these as its slug can be submitted, but its metadata/bundle
 * URLs are shadowed by the static route forever — reject it at submit AND at
 * approve (a record written before this guard must not become publishable).
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set(['delist-requests', 'revocations', 'submissions'])
/**
 * Loose semver SHAPE for path safety: three numeric parts then optional
 * prerelease/build. Stored versions already passed the strict manifest parser;
 * this guard only keeps `..`-like URL segments away from a state key/path.
 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const SUBMISSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** Everything a Task 5 handler may touch (plumbed by the dispatcher). */
export interface SubmissionHandlerContext {
  readonly request: IncomingMessage
  readonly config: AgentCatalogConfig
  readonly store: CatalogStore
  readonly role: AgentCatalogRole
  readonly actor: string
}

interface Conflict {
  readonly status: number
  readonly error: string
  readonly code: string
  readonly reason: string
}

function result(status: number, body: unknown, audit: HandlerResult['audit']): HandlerResult {
  return { status, body, audit }
}

function errorBody(error: string, code: string): { error: string; code: string } {
  return { error, code }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function isSubmissionId(value: string): boolean {
  return SUBMISSION_ID_PATTERN.test(value)
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

class BodyTooLargeError extends Error {
  constructor() {
    super('request body exceeded the read cap')
    this.name = 'BodyTooLargeError'
  }
}

/**
 * Read a request body, aborting BUFFERING at `cap`. The connection is then
 * drained rather than destroyed so the client can still read the 413 instead
 * of observing a reset; nothing beyond the cap is kept in memory.
 */
function readCappedBody(request: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const cleanup = (): void => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      request.off('aborted', onAborted)
      request.off('close', onClose)
    }
    const onData = (chunk: Buffer): void => {
      if (settled) return
      total += chunk.byteLength
      if (total >= cap) {
        settled = true
        cleanup()
        request.resume()
        reject(new BodyTooLargeError())
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks, total))
    }
    const onError = (cause: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(cause)
    }
    const onAborted = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('request aborted while reading the body'))
    }
    const onClose = (): void => {
      // Node also emits `close` after a successful `end`; `settled` guards that.
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('connection closed while reading the body'))
    }

    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onError)
    request.on('aborted', onAborted)
    request.on('close', onClose)
  })
}

/** Discard an unread body so the error response can reach the client. */
function drain(request: IncomingMessage): void {
  if (!request.readableEnded) request.resume()
}

function isGzipRequest(request: IncomingMessage): boolean {
  const header = request.headers['content-type']
  if (typeof header !== 'string') return false
  const mediaType = header.split(';')[0]?.trim().toLowerCase() ?? ''
  return mediaType === 'application/gzip'
}

function declaredContentLength(request: IncomingMessage): number | null {
  const raw = request.headers['content-length']
  if (typeof raw !== 'string' || !/^\d+$/u.test(raw.trim())) return null
  return Number(raw.trim())
}

/** One parsed JSON request body (shared with the governance handlers). */
export type JsonBody =
  | { readonly kind: 'object'; readonly value: Record<string, unknown> }
  /** A body that is not JSON / not an object (whitespace counts as invalid). */
  | { readonly kind: 'invalid' }
  | { readonly kind: 'too-large' }
  /** No body at all (an optional-body route may accept this). */
  | { readonly kind: 'empty' }

/**
 * Read a JSON object body under the shared cap. Exported because the governance
 * handlers (Task 6) must not grow a second body reader with a different cap.
 */
export async function readJsonObject(request: IncomingMessage): Promise<JsonBody> {
  let raw: Buffer
  try {
    raw = await readCappedBody(request, MAX_JSON_REQUEST_BYTES)
  } catch (cause) {
    if (cause instanceof BodyTooLargeError) return { kind: 'too-large' }
    return { kind: 'invalid' }
  }
  if (raw.byteLength === 0) return { kind: 'empty' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return { kind: 'invalid' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'invalid' }
  }
  return { kind: 'object', value: parsed as Record<string, unknown> }
}

/**
 * The ONE reason rule of the write surface: a trimmed string of 1-500
 * characters, or `null` when the body carries none/invalid. Shared by reject,
 * delist request and revoke so the budget can never drift between them.
 */
export function reasonFromBody(body: JsonBody): string | null {
  if (body.kind !== 'object') return null
  const raw = body.value.reason
  const reason = typeof raw === 'string' ? raw.trim() : ''
  return reason.length < 1 || reason.length > MAX_REASON_LENGTH ? null : reason
}

function migrationHeaderOf(request: IncomingMessage): string | undefined {
  const raw = request.headers[MIGRATION_HEADER]
  return typeof raw === 'string' ? raw : undefined
}

// ---------------------------------------------------------------------------
// Filesystem helpers (all writes are temp + rename)
// ---------------------------------------------------------------------------

export function submissionBundlePath(dataDir: string, submissionId: string): string {
  return join(dataDir, SUBMISSIONS_DIRECTORY, submissionId, BUNDLE_FILE_NAME)
}

export function packageBundlePath(dataDir: string, slug: string, version: string): string {
  return join(dataDir, PACKAGES_DIRECTORY, slug, version, BUNDLE_FILE_NAME)
}

async function writeFileAtomic(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(
    dirname(path),
    `${basename(path)}.tmp-${String(process.pid)}-${randomBytes(8).toString('hex')}`,
  )
  const handle = await openFile(temp, 'w', 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

function sameDigest(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right)
  } catch {
    return false
  }
}

const SIGNATURE_FIELDS = new Set(['version', 'algorithm', 'keyId', 'slot', 'signedAt', 'signature'])

/**
 * Exactly the documented `CatalogSignature` fields. The verifier is tolerant of
 * extra keys (it validates a trust decision, not a schema); persistable state
 * must not be.
 */
function hasExactSignatureShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === SIGNATURE_FIELDS.size && keys.every(key => SIGNATURE_FIELDS.has(key))
}

/** The exception is EXERCISED only for a matching header plus an agent entry. */
function migrationFromFor(
  entry: LegacyCatalogEntry | undefined,
  slug: string,
  header: string | undefined,
): string | undefined {
  return header === slug && entry?.kind === 'agent' ? slug : undefined
}

function legacyConflict(
  entry: LegacyCatalogEntry | undefined,
  slug: string,
  migrationFrom: string | undefined,
): Conflict | null {
  if (entry === undefined) return null
  const legalMigration = migrationFrom === slug && entry.kind === 'agent'
  if (legalMigration) return null
  return {
    status: 409,
    error: `标识与目录条目冲突：${slug}`,
    code: 'legacy-conflict',
    reason: `legacy entry ${slug} (kind ${String(entry.kind)}) already occupies the slug`,
  }
}

/**
 * A slug that collides with a static route can never be fetched: reject with a
 * clear 400 instead of publishing an unreachable package.
 */
function reservedSlugConflict(slug: string): Conflict | null {
  if (!RESERVED_SLUGS.has(slug)) return null
  return {
    status: 400,
    error: `标识「${slug}」是目录保留路径，不能用作包名`,
    code: 'reserved-slug',
    reason: `slug ${slug} is shadowed by a static catalog route`,
  }
}

interface SubmitVerdict {
  readonly conflict: Conflict | null
  /** Set only when this submission legally migrates a legacy agent entry. */
  readonly migrationFrom: string | undefined
}

/** Conflict verdict for a NEW submission (`state` is the committed state). */
function evaluateSubmission(
  state: CatalogState,
  config: AgentCatalogConfig,
  manifest: { slug: string; version: string },
  digest: AgentPackageDigest,
  migrationHeader: string | undefined,
): SubmitVerdict {
  const { slug, version } = manifest
  const entry = findEntry(config.entriesDir, slug)
  const migrationFrom = migrationFromFor(entry, slug, migrationHeader)

  const existingPackage = state.packages[packageKey(slug, version)]
  if (existingPackage !== undefined) {
    return {
      conflict: {
        status: 409,
        error: '该版本已发布',
        code: 'version-conflict',
        reason: `package ${slug}/${version} already exists with status ${existingPackage.status}`,
      },
      migrationFrom,
    }
  }

  const sameVersion = Object.values(state.submissions).filter(
    record => record.slug === slug && record.version === version,
  )
  if (sameVersion.some(record => record.status === 'pending-review')) {
    return {
      conflict: {
        status: 409,
        error: '该版本已在审查中',
        code: 'version-conflict',
        reason: `another pending submission already covers ${slug}/${version}`,
      },
      migrationFrom,
    }
  }
  if (sameVersion.some(record => record.status === 'published')) {
    return {
      conflict: {
        status: 409,
        error: '该版本已发布',
        code: 'version-conflict',
        reason: `a published submission already covers ${slug}/${version}`,
      },
      migrationFrom,
    }
  }

  // A rejected version number is frozen to the content that was reviewed:
  // resubmitting the SAME digest is allowed, different content must bump.
  const rejected = sameVersion
    .filter(record => record.status === 'rejected')
    .sort((left, right) => (left.updatedAt === right.updatedAt ? 0 : left.updatedAt < right.updatedAt ? 1 : -1))[0]
  if (rejected !== undefined && !sameDigest(rejected.digest, digest)) {
    return {
      conflict: {
        status: 409,
        error: '该版本已被拒绝且内容不同，请提升版本号',
        code: 'rejected-digest-conflict',
        reason: `rejected submission ${rejected.id} froze ${slug}/${version} to a different digest`,
      },
      migrationFrom,
    }
  }

  // Legacy directory entries are name-scoped (any version) and only the
  // explicit, legal migration unlocks the exception.
  return { conflict: legacyConflict(entry, slug, migrationFrom), migrationFrom }
}

/** Conflict verdict re-run at approval time (occupancy may have changed). */
function findApproveConflict(
  state: CatalogState,
  config: AgentCatalogConfig,
  submission: Submission,
): Conflict | null {
  const existing = state.packages[packageKey(submission.slug, submission.version)]
  if (existing !== undefined) {
    return {
      status: 409,
      error: '该版本已发布',
      code: 'version-conflict',
      reason: `package ${submission.slug}/${submission.version} already exists with status ${existing.status}`,
    }
  }
  const entry = findEntry(config.entriesDir, submission.slug)
  return legacyConflict(entry, submission.slug, submission.migrationFrom)
}

/** Highest signed record for a slug (delisted/revoked included), if any. */
function highestPackageRecord(
  state: CatalogState,
  slug: string,
  excludeVersion?: string,
): PublishedPackage | undefined {
  let best: PublishedPackage | undefined
  for (const record of Object.values(state.packages)) {
    if (record.slug !== slug) continue
    if (excludeVersion !== undefined && record.version === excludeVersion) continue
    if (best === undefined || compareAgentPackageVersions(record.version, best.version) > 0) {
      best = record
    }
  }
  return best
}

function submissionBody(record: Submission): SubmissionResponse {
  return {
    submissionId: record.id,
    slug: record.slug,
    version: record.version,
    status: record.status,
    submittedAt: record.submittedAt,
    updatedAt: record.updatedAt,
    digest: record.digest,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  }
}

function notFoundSubmission(action: string, submissionId: string): HandlerResult {
  return result(404, errorBody('提交不存在', 'not-found'), {
    action,
    outcome: 'error',
    reason: `submission not found: ${submissionId}`,
    submissionId,
  })
}

/** Shared 413 result (governance bodies are capped identically). */
export function payloadTooLarge(action: string): HandlerResult {
  return result(413, errorBody('请求体过大', 'payload-too-large'), {
    action,
    outcome: 'error',
    reason: 'request body exceeded the read cap',
  })
}

function conflictResult(action: string, context: Pick<Submission, 'slug' | 'version'>, conflict: Conflict): HandlerResult {
  return result(conflict.status, errorBody(conflict.error, conflict.code), {
    action,
    outcome: 'error',
    reason: conflict.reason,
    slug: context.slug,
    version: context.version,
  })
}

// ---------------------------------------------------------------------------
// POST /v1/agent-packages/submissions
// ---------------------------------------------------------------------------

export async function createSubmission(context: SubmissionHandlerContext): Promise<HandlerResult> {
  const action = ACTIONS.create
  const { request, config, store, actor } = context

  if (!isGzipRequest(request)) {
    drain(request)
    return result(415, errorBody('只接受 application/gzip', 'unsupported-media-type'), {
      action,
      outcome: 'error',
      reason: `unsupported content type: ${String(request.headers['content-type'] ?? 'missing')}`,
    })
  }

  const declared = declaredContentLength(request)
  if (declared !== null && declared >= SUBMISSION_BODY_CAP_BYTES) {
    drain(request)
    return payloadTooLarge(action)
  }

  let raw: Buffer
  try {
    raw = await readCappedBody(request, SUBMISSION_BODY_CAP_BYTES)
  } catch (cause) {
    if (cause instanceof BodyTooLargeError) return payloadTooLarge(action)
    throw cause
  }

  // The digest is recomputed here; nothing the client claimed is consulted.
  let digest: AgentPackageDigest
  let slug: string
  let version: string
  try {
    const inspected = await inspectUnsignedAgentPackageBundle(raw)
    digest = inspected.digest
    slug = inspected.manifest.slug
    version = inspected.manifest.version
  } catch (cause) {
    const message = messageOf(cause)
    return result(400, errorBody(message, 'invalid-bundle'), {
      action,
      outcome: 'error',
      reason: message,
    })
  }

  // A reserved slug would shadow every metadata/bundle URL; refuse BEFORE any
  // bundle is written or submission recorded.
  const reserved = reservedSlugConflict(slug)
  if (reserved !== null) return conflictResult(action, { slug, version }, reserved)

  const migrationHeader = migrationHeaderOf(request)
  const submissionId = randomUUID()

  const outcome = await store.withPackageLock(slug, version, async () => {
    const verdict = evaluateSubmission(store.read(), config, { slug, version }, digest, migrationHeader)
    if (verdict.conflict !== null) return { kind: 'conflict' as const, conflict: verdict.conflict }

    await writeFileAtomic(submissionBundlePath(config.dataDir, submissionId), raw)

    const now = new Date().toISOString()
    const migrationFrom = verdict.migrationFrom
    const record = await store.update(draft => {
      // The package lock already serialized this `${slug}/${version}`, so a
      // package that appeared here would mean a bug; refuse to overwrite it.
      if (draft.packages[packageKey(slug, version)] !== undefined) {
        throw new Error(`package ${slug}/${version} was committed concurrently`)
      }
      const created: Submission = {
        id: submissionId,
        slug,
        version,
        status: 'pending-review',
        submittedAt: now,
        updatedAt: now,
        actor,
        digest,
        ...(migrationFrom === undefined ? {} : { migrationFrom }),
      }
      draft.submissions[submissionId] = created
      return created
    })
    return { kind: 'created' as const, record }
  })

  if (outcome.kind === 'conflict') {
    return conflictResult(action, { slug, version }, outcome.conflict)
  }

  return {
    status: 201,
    body: submissionBody(outcome.record),
    headers: { location: `/v1/agent-packages/submissions/${outcome.record.id}` },
    audit: { action, outcome: 'ok', slug, version, submissionId: outcome.record.id },
  }
}

// ---------------------------------------------------------------------------
// GET /v1/agent-packages/submissions?status=pending
// ---------------------------------------------------------------------------

export async function listPendingSubmissions(context: SubmissionHandlerContext): Promise<HandlerResult> {
  const action = ACTIONS.pending
  let status: string | null
  try {
    status = new URL(context.request.url ?? '/', 'http://localhost').searchParams.get('status')
  } catch {
    status = null
  }
  if (status !== 'pending') {
    return result(400, errorBody('不支持的提交状态筛选', 'invalid-status'), {
      action,
      outcome: 'error',
      reason: `unsupported status filter: ${String(status)}`,
    })
  }

  const items = Object.values(context.store.read().submissions)
    .filter(record => record.status === 'pending-review')
    .sort((left, right) =>
      left.submittedAt === right.submittedAt
        ? left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0
        : left.submittedAt < right.submittedAt
          ? -1
          : 1,
    )
    .map(submissionBody)
  return result(200, { items }, { action, outcome: 'ok' })
}

// ---------------------------------------------------------------------------
// GET /v1/agent-packages/submissions/{id}
// ---------------------------------------------------------------------------

export async function getSubmission(
  context: SubmissionHandlerContext,
  submissionId: string,
): Promise<HandlerResult> {
  const action = ACTIONS.get
  if (!isSubmissionId(submissionId)) return notFoundSubmission(action, submissionId)
  const state = context.store.read()
  const record = state.submissions[submissionId]
  if (record === undefined) return notFoundSubmission(action, submissionId)

  if (context.role === 'publish' && record.actor !== context.actor) {
    return result(403, errorBody('权限不足', 'forbidden'), {
      action,
      outcome: 'denied',
      reason: 'the publish actor is not the submission creator',
      slug: record.slug,
      version: record.version,
      submissionId: record.id,
    })
  }

  let body: AdminSubmissionResponse = submissionBody(record)
  if (context.role === 'admin') {
    // Live, server-computed diff anchor. Delisted/revoked records qualify: they
    // are exactly what an installed client may still run.
    const previous = highestPackageRecord(state, record.slug, record.version)
    if (previous !== undefined) {
      body = { ...body, previousVersion: previous.version, previousDigest: previous.digest }
    }
  }
  return result(200, body, {
    action,
    outcome: 'ok',
    slug: record.slug,
    version: record.version,
    submissionId: record.id,
  })
}

// ---------------------------------------------------------------------------
// GET /v1/agent-packages/submissions/{id}/bundle (admin review download)
// ---------------------------------------------------------------------------

export async function downloadSubmissionBundle(
  context: SubmissionHandlerContext,
  submissionId: string,
): Promise<HandlerResult> {
  const action = ACTIONS.reviewBundle
  const record = isSubmissionId(submissionId)
    ? context.store.read().submissions[submissionId]
    : undefined
  if (record === undefined) return notFoundSubmission(action, submissionId)

  let data: Buffer
  try {
    data = await readFile(submissionBundlePath(context.config.dataDir, record.id))
  } catch (cause) {
    const message = messageOf(cause)
    return result(500, errorBody('内部错误', 'internal'), {
      action,
      outcome: 'error',
      reason: `submission bundle unreadable: ${message}`,
      slug: record.slug,
      version: record.version,
      submissionId: record.id,
    })
  }
  return {
    status: 200,
    raw: { contentType: 'application/gzip', data },
    audit: {
      action,
      outcome: 'ok',
      slug: record.slug,
      version: record.version,
      submissionId: record.id,
    },
  }
}

// ---------------------------------------------------------------------------
// POST /v1/agent-packages/submissions/{id}/approve
// ---------------------------------------------------------------------------

export async function approveSubmission(
  context: SubmissionHandlerContext,
  submissionId: string,
): Promise<HandlerResult> {
  const action = ACTIONS.approve
  if (!isSubmissionId(submissionId)) return notFoundSubmission(action, submissionId)

  const snapshot = context.store.read().submissions[submissionId]
  if (snapshot === undefined) return notFoundSubmission(action, submissionId)
  if (snapshot.status !== 'pending-review') {
    return result(409, errorBody('提交已处理', 'submission-not-pending'), {
      action,
      outcome: 'error',
      reason: `submission ${submissionId} is ${snapshot.status}`,
      slug: snapshot.slug,
      version: snapshot.version,
      submissionId,
    })
  }

  // Defense in depth for records created before the submit guard: approving a
  // reserved slug would publish an unreachable package.
  const reserved = reservedSlugConflict(snapshot.slug)
  if (reserved !== null) {
    return result(reserved.status, errorBody(reserved.error, reserved.code), {
      action,
      outcome: 'error',
      reason: reserved.reason,
      slug: snapshot.slug,
      version: snapshot.version,
      submissionId,
    })
  }

  const body = await readJsonObject(context.request)
  if (body.kind === 'too-large') return payloadTooLarge(action)
  const keys = body.kind === 'object' ? Object.keys(body.value) : []
  if (
    body.kind !== 'object'
    || keys.length !== 1
    || keys[0] !== 'signature'
    || body.value.signature === undefined
  ) {
    return result(400, errorBody('请求无效', 'invalid-body'), {
      action,
      outcome: 'error',
      reason: 'approve body must be exactly { signature }',
      slug: snapshot.slug,
      version: snapshot.version,
      submissionId,
    })
  }

  const signature = body.value.signature as CatalogSignature
  if (!hasExactSignatureShape(signature)) {
    // Reject unknown fields: the stored/built signature record must stay the
    // exact documented shape instead of carrying client junk into the bundle.
    return result(400, errorBody('请求无效', 'invalid-body'), {
      action,
      outcome: 'error',
      reason: 'signature must have exactly the documented CatalogSignature fields',
      slug: snapshot.slug,
      version: snapshot.version,
      submissionId,
    })
  }
  const verdict = verifyAgentPackageDigestSignature(snapshot.digest, signature, context.config.keyring)
  if (!verdict.ok) {
    return result(400, errorBody('签名无效', 'invalid-signature'), {
      action,
      outcome: 'error',
      reason: `signature rejected: ${verdict.reason}`,
      slug: snapshot.slug,
      version: snapshot.version,
      submissionId,
    })
  }

  const { slug, version } = snapshot

  // Re-read the EXACT bytes the review covered and confirm they still hash to
  // the digest the administrator signed.
  let unsigned: Awaited<ReturnType<typeof inspectUnsignedAgentPackageBundle>>
  try {
    unsigned = await inspectUnsignedAgentPackageBundle(
      await readFile(submissionBundlePath(context.config.dataDir, submissionId)),
    )
  } catch (cause) {
    const message = messageOf(cause)
    return result(500, errorBody('内部错误', 'internal'), {
      action,
      outcome: 'error',
      reason: `stored submission bundle is unusable: ${message}`,
      slug,
      version,
      submissionId,
    })
  }
  if (
    !sameDigest(unsigned.digest, snapshot.digest)
    || unsigned.manifest.slug !== slug
    || unsigned.manifest.version !== version
  ) {
    return result(409, errorBody('存储的提交包与摘要不一致', 'digest-mismatch'), {
      action,
      outcome: 'error',
      reason: `stored bundle digest does not match the reviewed digest for ${slug}/${version}`,
      slug,
      version,
      submissionId,
    })
  }

  // Cheap pre-check before the expensive rebuild: occupancy may have changed
  // while the submission was pending. The authoritative check runs again under
  // the package lock below (a concurrent approval/legacy edit must not slip in
  // between).
  const earlyConflict = findApproveConflict(context.store.read(), context.config, snapshot)
  if (earlyConflict !== null) return conflictResult(action, { slug, version }, earlyConflict)

  // Build the signed bundle and self-verify it before anything is written.
  let signed: Buffer
  try {
    signed = await buildSignedAgentPackageBundle(unsigned.files, snapshot.digest, signature)
    const checked = await inspectSignedAgentPackageBundle(signed, context.config.keyring)
    if (!sameDigest(checked.digest, snapshot.digest) || checked.signature.signature !== signature.signature) {
      throw new Error('the rebuilt signed bundle does not match the reviewed digest/signature')
    }
  } catch (cause) {
    const message = messageOf(cause)
    return result(500, errorBody('签名包生成失败', 'signed-bundle-failed'), {
      action,
      outcome: 'error',
      reason: `signed bundle build failed: ${message}`,
      slug,
      version,
      submissionId,
    })
  }

  const outcome = await context.store.withPackageLock(slug, version, async () => {
    const state = context.store.read()
    const current = state.submissions[submissionId]
    if (current === undefined) return { kind: 'not-found' as const }
    if (current.status !== 'pending-review') {
      return {
        kind: 'conflict' as const,
        conflict: {
          status: 409,
          error: '提交已处理',
          code: 'submission-not-pending',
          reason: `submission ${submissionId} became ${current.status} while approving`,
        },
      }
    }
    const conflict = findApproveConflict(state, context.config, current)
    if (conflict !== null) return { kind: 'conflict' as const, conflict }

    // The final path may already hold a bundle from an interrupted attempt
    // (`crashed after rename, before the state commit`). Only IDENTICAL content
    // may be adopted; anything else is a conflict, never an overwrite.
    const finalPath = packageBundlePath(context.config.dataDir, slug, version)
    let finalBundle: Buffer = signed
    let existing: Buffer | null = null
    try {
      existing = await readFile(finalPath)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
    if (existing !== null) {
      let identical = false
      try {
        const inspected = await inspectSignedAgentPackageBundle(existing, context.config.keyring)
        identical = sameDigest(inspected.digest, current.digest)
      } catch {
        identical = false
      }
      if (!identical) return { kind: 'bundle-conflict' as const }
      finalBundle = existing
    } else {
      await writeFileAtomic(finalPath, signed)
    }

    const size = finalBundle.byteLength
    const publishedAt = new Date().toISOString()
    const updated = await context.store.update(draft => {
      const live = draft.submissions[submissionId]
      if (live === undefined || live.status !== 'pending-review') {
        throw new Error(`submission ${submissionId} changed while approving`)
      }
      // ONE commit makes the package and its submission visible together.
      draft.packages[packageKey(slug, version)] = {
        slug,
        version,
        manifest: unsigned.manifest,
        digest: current.digest,
        signature,
        status: 'published',
        size,
        updatedAt: publishedAt,
        actor: context.actor,
        ...(current.migrationFrom === undefined ? {} : { migrationFrom: current.migrationFrom }),
      }
      live.status = 'published'
      live.updatedAt = publishedAt
      return live
    })
    return { kind: 'approved' as const, submission: updated }
  })

  switch (outcome.kind) {
    case 'not-found':
      return notFoundSubmission(action, submissionId)
    case 'conflict':
      return conflictResult(action, { slug, version }, outcome.conflict)
    case 'bundle-conflict':
      return result(409, errorBody('该版本已存在不同内容的包', 'bundle-conflict'), {
        action,
        outcome: 'error',
        reason: `packages/${slug}/${version}/bundle.tgz holds a different signed bundle`,
        slug,
        version,
        submissionId,
      })
    case 'approved':
      return result(200, submissionBody(outcome.submission), {
        action,
        outcome: 'ok',
        slug,
        version,
        submissionId,
      })
  }
}

// ---------------------------------------------------------------------------
// POST /v1/agent-packages/submissions/{id}/reject
// ---------------------------------------------------------------------------

export async function rejectSubmission(
  context: SubmissionHandlerContext,
  submissionId: string,
): Promise<HandlerResult> {
  const action = ACTIONS.reject
  if (!isSubmissionId(submissionId)) return notFoundSubmission(action, submissionId)

  const snapshot = context.store.read().submissions[submissionId]
  if (snapshot === undefined) return notFoundSubmission(action, submissionId)

  const body = await readJsonObject(context.request)
  if (body.kind === 'too-large') return payloadTooLarge(action)
  const reason = reasonFromBody(body)
  if (reason === null) {
    return result(400, errorBody(`原因需为 1-${String(MAX_REASON_LENGTH)} 个字符`, 'invalid-reason'), {
      action,
      outcome: 'error',
      reason: 'reject reason must be a trimmed string of 1-500 characters',
      slug: snapshot.slug,
      version: snapshot.version,
      submissionId,
    })
  }

  const { slug, version } = snapshot
  // The package lock keeps reject from racing approve on the same version.
  const outcome = await context.store.withPackageLock(slug, version, async () => {
    const current = context.store.read().submissions[submissionId]
    if (current === undefined) return { kind: 'not-found' as const }
    if (current.status !== 'pending-review') {
      return {
        kind: 'conflict' as const,
        conflict: {
          status: 409,
          error: '提交已处理',
          code: 'submission-not-pending',
          reason: `submission ${submissionId} is ${current.status}`,
        },
      }
    }
    const updated = await context.store.update(draft => {
      const live = draft.submissions[submissionId]
      if (live === undefined || live.status !== 'pending-review') {
        throw new Error(`submission ${submissionId} changed while rejecting`)
      }
      live.status = 'rejected'
      live.reason = reason
      live.updatedAt = new Date().toISOString()
      return live
    })
    return { kind: 'rejected' as const, submission: updated }
  })

  if (outcome.kind === 'not-found') return notFoundSubmission(action, submissionId)
  if (outcome.kind === 'conflict') return conflictResult(action, { slug, version }, outcome.conflict)
  return result(200, submissionBody(outcome.submission), {
    action,
    outcome: 'ok',
    slug,
    version,
    submissionId,
  })
}

// ---------------------------------------------------------------------------
// GET /v1/agent-packages
// ---------------------------------------------------------------------------

export async function listPublishedPackages(context: SubmissionHandlerContext): Promise<HandlerResult> {
  const action = ACTIONS.list
  const best = new Map<string, PublishedPackage>()
  for (const record of Object.values(context.store.read().packages)) {
    // ONE distribution rule decides catalog visibility (delisted/revoked are out).
    if (!packageDistributionStatus(record).listed) continue
    const current = best.get(record.slug)
    if (current === undefined || compareAgentPackageVersions(record.version, current.version) > 0) {
      best.set(record.slug, record)
    }
  }

  const items: AgentPackageSummary[] = [...best.values()]
    .sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0))
    .map(record => ({
      slug: record.slug,
      // Only the stored, validated manifest feeds the read surface.
      displayName: record.manifest.displayName,
      description: record.manifest.description,
      version: record.version,
      size: record.size,
      status: 'published',
      updatedAt: record.updatedAt,
      ...(record.migrationFrom === undefined ? {} : { migrationFrom: record.migrationFrom }),
    }))
  return result(200, { items }, { action, outcome: 'ok' })
}

// ---------------------------------------------------------------------------
// GET /v1/agent-packages/{slug}/{version}[, /bundle]
// ---------------------------------------------------------------------------

/**
 * The shared package lookup (identity guard + state read). Exported for the
 * governance handlers (Task 6) so path-segment validation cannot drift.
 */
export function findPackageRecord(
  store: Pick<CatalogStore, 'read'>,
  slug: string,
  version: string,
): PublishedPackage | undefined {
  // Path segments are attacker-controlled; only validated identities may reach
  // a state key (and therefore a filesystem path).
  if (!SLUG_PATTERN.test(slug) || !VERSION_PATTERN.test(version)) return undefined
  return store.read().packages[packageKey(slug, version)]
}

function findPackage(
  context: SubmissionHandlerContext,
  slug: string,
  version: string,
): PublishedPackage | undefined {
  return findPackageRecord(context.store, slug, version)
}

export async function getPackageMetadata(
  context: SubmissionHandlerContext,
  slug: string,
  version: string,
): Promise<HandlerResult> {
  const action = ACTIONS.metadata
  const record = findPackage(context, slug, version)
  if (record === undefined) {
    return result(404, errorBody('版本不存在', 'not-found'), {
      action,
      outcome: 'error',
      reason: `package not found: ${slug}/${version}`,
      slug,
      version,
    })
  }

  // The SAME distribution rule the list and bundle routes consult.
  const distribution = packageDistributionStatus(record)
  const body: AgentPackageMetadata = {
    slug: record.slug,
    version: record.version,
    status: distribution.status,
    displayName: record.manifest.displayName,
    description: record.manifest.description,
    size: record.size,
    updatedAt: record.updatedAt,
    digest: record.digest,
    signature: record.signature,
    ...(record.migrationFrom === undefined ? {} : { migrationFrom: record.migrationFrom }),
    // Installed clients keep the metadata to explain a withdrawal, but only a
    // downloadable version advertises downloadable bytes.
    ...(distribution.downloadable
      ? {
          bundleUrl: `/v1/agent-packages/${encodeURIComponent(record.slug)}/${encodeURIComponent(record.version)}/bundle`,
        }
      : {}),
  }
  return result(200, body, {
    action,
    outcome: 'ok',
    slug: record.slug,
    version: record.version,
  })
}

export async function downloadPackageBundle(
  context: SubmissionHandlerContext,
  slug: string,
  version: string,
): Promise<HandlerResult> {
  const action = ACTIONS.bundle
  const record = findPackage(context, slug, version)
  if (record === undefined) {
    return result(404, errorBody('版本不存在', 'not-found'), {
      action,
      outcome: 'error',
      reason: `package not found: ${slug}/${version}`,
      slug,
      version,
    })
  }
  // The exact 410 body/code comes from the shared helper, never from a local
  // `status === 'delisted' || status === 'revoked'` test.
  const distribution = packageDistributionStatus(record)
  if (!distribution.downloadable) {
    return result(410, errorBody(distribution.error, distribution.code), {
      action,
      outcome: 'error',
      reason: `package ${slug}/${version} is ${distribution.status}`,
      slug: record.slug,
      version: record.version,
    })
  }

  let data: Buffer
  try {
    data = await readFile(packageBundlePath(context.config.dataDir, record.slug, record.version))
  } catch (cause) {
    const message = messageOf(cause)
    return result(500, errorBody('内部错误', 'internal'), {
      action,
      outcome: 'error',
      reason: `published bundle unreadable: ${message}`,
      slug: record.slug,
      version: record.version,
    })
  }
  return {
    status: 200,
    raw: { contentType: 'application/gzip', data },
    audit: { action, outcome: 'ok', slug: record.slug, version: record.version },
  }
}
