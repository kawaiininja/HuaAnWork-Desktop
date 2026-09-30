/**
 * Admin surface for market-server (Task 2 Steps 1-3).
 *
 * All routes live under `/v1/admin/` and are bearer-token authenticated
 * (auth.ts, review D5): no token configured -> the whole surface answers 401
 * `admin-disabled`; wrong/missing token -> 401 `unauthorized`. The public
 * GET catalog/artifact routes are the only unauthenticated faces.
 *
 * Routes:
 *   GET  /v1/admin/state                    overview (entries + manifest slots
 *                                           + the artifact inventory, P11b)
 *   POST /v1/admin/artifacts                publish a .tgz (raw body; the
 *                                           publish gate runs HERE so the
 *                                           operator gets honest errors at
 *                                           publish time, not the user at
 *                                           install time)
 *   DELETE /v1/admin/artifact?file=<name>   delete one stored artifact (P11b);
 *                                           refused while ANY of the three
 *                                           reference faces (catalog entry /
 *                                           activated manifest / prepared
 *                                           pending manifest) still names it
 *   PATCH /v1/admin/entries/:id             edit display fields (URL-typed
 *                                           fields preflighted: empty = unset,
 *                                           non-https rejected, round3 R15)
 *   POST /v1/admin/entries/:id/unpublish    remove an entry from the catalog
 *   POST /v1/admin/manifest/prepare         two-step flow step 1: build +
 *                                           persist the canonical pending manifest
 *                                           (refused with an honest 409 while a
 *                                           stored entry violates the
 *                                           provider-page contract, ruling
 *                                           D-M6-26 — the read side isolates,
 *                                           a signed manifest never silently
 *                                           sheds an entry)
 *   GET  /v1/admin/manifest/pending         download the pending manifest
 *   POST /v1/admin/manifest/signature       two-step flow step 3: verify the
 *                                           detached signature, activate only
 *                                           on a fully valid verdict (fail-closed)
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { authenticateAdmin } from '../auth.ts'
import { EntryContractError, formatContractIssues, validateCatalogEntryContract } from '../catalog/entry-contract.ts'
import type { CatalogService } from '../catalog/service.ts'
import { DuplicateEntryError, EntryNotFoundError, ManifestActivationConflictError } from '../catalog/store.ts'
import type { CatalogEntry, CatalogEntryPatch, CatalogStore } from '../catalog/store.ts'
import type { MarketServerConfig } from '../config.ts'
import { intakeSignature, ManifestPrepareError, preparePendingManifest, type IntakeVerdict } from '../manifest-prepare.ts'
import { isSafeArtifactName } from '../tarball/http.ts'
import { TarballError, extractPackageManifestFromFile } from '../tarball/parse.ts'
import { checkPublishGate } from '../tarball/gate.ts'
import {
  SHA256_PATTERN,
  MAX_ARTIFACT_BYTES,
  ArtifactShaMismatchError,
  ArtifactStore,
  ArtifactTooLargeError,
  artifactFileName,
} from '../tarball/store.ts'

export const ADMIN_ROUTE_PREFIX = '/v1/admin/'
/** Artifact upload route; server.ts keys its upload concurrency cap (P8) off this path. */
export const ADMIN_ARTIFACTS_PATH = `${ADMIN_ROUTE_PREFIX}artifacts`
/** Artifact deletion route (P11b): `DELETE ...?file=<stored artifact file name>`. */
export const ADMIN_ARTIFACT_PATH = `${ADMIN_ROUTE_PREFIX}artifact`

const MAX_JSON_BODY_BYTES = 1024 * 1024

export interface AdminContext {
  readonly config: MarketServerConfig
  readonly store: CatalogStore
  readonly catalog: CatalogService
  readonly artifacts: ArtifactStore
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(`${JSON.stringify(body)}\n`)
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } })
}

async function readJsonBody(request: IncomingMessage, cap: number = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > cap) throw new Error('request body too large')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (cause) {
    throw new Error(`request body is not valid JSON: ${(cause as Error).message}`)
  }
}

/** Provider-page URL-typed display fields and their https preflight (round3 R15). */
const URL_TYPED_FIELDS = ['homepage', 'publisherUrl', 'repositoryUrl'] as const
type UrlTypedField = (typeof URL_TYPED_FIELDS)[number]

/**
 * The exact contract httpsUri pattern (docs/schemas/catalog-provider-page.schema.json
 * $defs.httpsUri), mirrored because the contracts package does not export it.
 * A bare `new URL(v).protocol === 'https:'` check is weaker: it accepts
 * userinfo, a non-default port, and a fragment, all of which the contract
 * forbids (review D3a).
 */
const HTTPS_URI_PATTERN = /^https:\/\/(?![^/?#]*@)(?![^/?#]*:)[^#]+$/u
const HTTPS_URI_MAX_LENGTH = 2048

function isHttpsUri(value: string): boolean {
  return value.length <= HTTPS_URI_MAX_LENGTH && HTTPS_URI_PATTERN.test(value)
}

function optionalStringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`"${key}" must be a string`)
  return value
}

function optionalStringArrayField(body: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`"${key}" must be an array of strings`)
  }
  return value as readonly string[]
}

/** Validate + normalize a PATCH body into a CatalogEntryPatch (throws on bad input). */
export function parseEntryPatch(body: unknown): CatalogEntryPatch {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('request body must be a JSON object')
  }
  const record = body as Record<string, unknown>
  const allowed = new Set([
    'displayName',
    'summary',
    'description',
    'license',
    'categories',
    'keywords',
    'capabilities',
    'updatedAt',
    ...URL_TYPED_FIELDS,
    'publisherName',
  ])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`unknown field "${key}"`)
  }

  const patch: CatalogEntryPatch = {}
  const displayName = optionalStringField(record, 'displayName')
  const summary = optionalStringField(record, 'summary')
  if (displayName !== undefined) {
    if (displayName.trim() === '') throw new Error('"displayName" must be non-empty')
    patch.displayName = displayName
  }
  if (summary !== undefined) {
    if (summary.trim() === '') throw new Error('"summary" must be non-empty')
    patch.summary = summary
  }
  const description = optionalStringField(record, 'description')
  const license = optionalStringField(record, 'license')
  const updatedAt = optionalStringField(record, 'updatedAt')
  const publisherName = optionalStringField(record, 'publisherName')
  if (description !== undefined) patch.description = description
  if (license !== undefined) patch.license = license
  if (updatedAt !== undefined) patch.updatedAt = updatedAt
  if (publisherName !== undefined) patch.publisherName = publisherName === '' ? undefined : publisherName

  const categories = optionalStringArrayField(record, 'categories')
  const keywords = optionalStringArrayField(record, 'keywords')
  const capabilities = optionalStringArrayField(record, 'capabilities')
  if (categories !== undefined) patch.categories = categories
  if (keywords !== undefined) patch.keywords = keywords
  if (capabilities !== undefined) patch.capabilities = capabilities

  // URL-typed fields: empty string clears (the intranet source has no public
  // URLs to fill); any other non-https value is rejected at publish time.
  for (const field of URL_TYPED_FIELDS) {
    const value = optionalStringField(record, field)
    if (value === undefined) continue
    if (value === '') {
      patch[field as UrlTypedField] = undefined
      continue
    }
    if (!isHttpsUri(value)) {
      throw new Error(
        `"${field}" must be an https:// URI or empty (the contract requires https for URL-typed display fields); got ${JSON.stringify(value)}`,
      )
    }
    patch[field as UrlTypedField] = value
  }
  return patch
}

/** Stable catalog id for a published name@version (contract identifier pattern). */
export function catalogEntryId(packageName: string, version: string): string {
  return `${packageName.replace(/^@/u, '')}@${version}`
}

// ---------------------------------------------------------------------------
// P11b: artifact reference judgment (three faces, fail-closed)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Catalog face: an entry whose `tarball` field IS the target file (review D2 precedent). */
function catalogEntryReferencing(store: CatalogStore, fileName: string): CatalogEntry | null {
  return store.entries().find(entry => entry.tarball === fileName) ?? null
}

/**
 * Verdict for one manifest slot (the ACTIVATED slot or the PREPARED-PENDING
 * slot — both share the wire shape, `null` = empty slot).
 *
 * `referenced` and `unreadable` are both refusals; only `clear` permits a
 * delete. `clear` means "empty slot, or one whose files[] was scanned with no
 * hit". `unreadable` is the fail-closed arm: a stored manifest whose `files[]`
 * cannot be inspected cannot PROVE the artifact is unreferenced (reachable by
 * an operator hand-editing the state file or restoring an old backup —
 * activation pins the signature, not the shape).
 */
type ManifestReferenceVerdict = 'clear' | 'referenced' | 'unreadable'

function manifestArtifactVerdict(manifest: unknown, fileName: string): ManifestReferenceVerdict {
  if (manifest === null) return 'clear'
  if (!isRecord(manifest)) return 'unreadable'
  const files = manifest.files
  if (!Array.isArray(files)) return 'unreadable'
  // manifest-prepare.ts writes `/artifacts/<tarball>` into files[].tarballPath.
  const tarballPath = `/artifacts/${fileName}`
  return files.some(file => isRecord(file) && file.tarballPath === tarballPath) ? 'referenced' : 'clear'
}

/**
 * The face that still names an artifact. Deleting needs ALL of them clear.
 *
 * Three faces, because each one can keep the bytes installable while the
 * others are clear:
 *   catalog  — an entry's `tarball` field (review D2);
 *   manifest — the ACTIVATED signed manifest's files[].tarballPath, replayed
 *              verbatim by GET /v1/manifest, so unpublish alone is not enough;
 *   pending  — the PREPARED but not yet activated manifest (fix round 1): it is
 *              stored verbatim while its signature is still signable, so
 *              deleting an artifact it names arms a dangling download for the
 *              very next activation (review: 被校验的字节 = 被安装的字节).
 * The `*-unreadable` faces are refusals too: an operator-edited state document
 * whose files[] cannot be inspected cannot PROVE the artifact is unreferenced.
 */
type ArtifactReference =
  | { readonly face: 'catalog'; readonly entry: CatalogEntry }
  | { readonly face: 'manifest' }
  | { readonly face: 'pending' }
  | { readonly face: 'manifest-unreadable' }
  | { readonly face: 'pending-unreadable' }

/**
 * The ONE judgment shared by the delete route and the admin inventory (single
 * source, no re-derivation): the first face that still names the artifact, or
 * null when every face is clear. Faces are checked in a fixed order so the
 * refusal copy stays stable when more than one face hits.
 */
function artifactReference(store: CatalogStore, fileName: string): ArtifactReference | null {
  const entry = catalogEntryReferencing(store, fileName)
  if (entry !== null) return { face: 'catalog', entry }
  const manifestVerdict = manifestArtifactVerdict(store.manifest(), fileName)
  if (manifestVerdict === 'referenced') return { face: 'manifest' }
  if (manifestVerdict === 'unreadable') return { face: 'manifest-unreadable' }
  const pendingVerdict = manifestArtifactVerdict(store.pendingManifest(), fileName)
  if (pendingVerdict === 'referenced') return { face: 'pending' }
  if (pendingVerdict === 'unreadable') return { face: 'pending-unreadable' }
  return null
}

/** One stored artifact as the operator surface sees it (P11b). */
interface AdminArtifactView {
  readonly fileName: string
  readonly size: number
  /** True only when ALL THREE reference faces are clear (fail-closed). */
  readonly deletable: boolean
  /** The face that still references it; null when deletable. */
  readonly referencedBy: ArtifactReference['face'] | null
}

async function artifactInventory(ctx: AdminContext): Promise<readonly AdminArtifactView[]> {
  const stored = await ctx.artifacts.list()
  return stored.map(({ fileName, size }) => {
    const reference = artifactReference(ctx.store, fileName)
    return reference === null
      ? { fileName, size, deletable: true, referencedBy: null }
      : { fileName, size, deletable: false, referencedBy: reference.face }
  })
}

/**
 * Refuse a delete, naming the face and the operator's next step (honest copy).
 * The two pending-manifest arms answer `artifact-referenced` per the fix-round
 * ruling (a prepared manifest is a reference: it can still be signed and
 * activated as stored); the unreadable arm says outright that we could not
 * prove it is unreferenced rather than claiming a hit we did not see.
 */
function sendArtifactReferenceRefusal(response: ServerResponse, fileName: string, reference: ArtifactReference): void {
  switch (reference.face) {
    case 'catalog':
      sendError(
        response,
        409,
        'artifact-referenced',
        `制品 ${fileName} 仍被目录条目 ${reference.entry.id} 引用(目录面);先下架该条目(POST /v1/admin/entries/${reference.entry.id}/unpublish),再删制品`,
      )
      return
    case 'manifest':
      sendError(
        response,
        409,
        'artifact-referenced',
        `制品 ${fileName} 仍被已激活清单引用;先重新 prepare + activate 一份不含该条目的清单,再删制品`,
      )
      return
    case 'pending':
      sendError(
        response,
        409,
        'artifact-referenced',
        `制品 ${fileName} 仍被已 prepare 的待激活清单引用(待签清单面);先重新 prepare 一份不含该条目的清单(或先处理当前 pending 清单),再删制品`,
      )
      return
    case 'manifest-unreadable':
      sendError(
        response,
        409,
        'manifest-unreadable',
        `制品 ${fileName} 的引用判定失败:已激活清单的形状无法解析(files[] 缺失或不是数组),无法证明它未被引用;` +
          '先重新 prepare + activate 一份可解析的清单,再删制品',
      )
      return
    case 'pending-unreadable':
      sendError(
        response,
        409,
        'artifact-referenced',
        `制品 ${fileName} 的删除被拒:已 prepare 的待激活清单形状无法解析(files[] 缺失或不是数组),无法证明它未被引用;` +
          '先重新 prepare 一份可解析的清单,再删制品',
      )
      return
  }
}

/**
 * `DELETE /v1/admin/artifact?file=<name>` (P11b): the operator-facing artifact
 * deletion that `ArtifactStore.remove` never had a production caller for
 * (unpublish deliberately keeps the bytes, so the disk only grew).
 *
 * The judgment is fail-closed on ALL THREE reference faces (see
 * `artifactReference`): only when no catalog entry, no activated signed
 * manifest, and no prepared-not-yet-activated manifest names the artifact does
 * it unlink, answering 204 (the reclaimed byte count travels in the
 * `x-artifact-bytes-reclaimed` header — 204 carries no body). Every refusal
 * names the face and the operator's next step.
 */
async function deleteArtifact(response: ServerResponse, url: URL, ctx: AdminContext): Promise<void> {
  const fileName = url.searchParams.get('file')
  if (fileName === null || fileName.trim() === '') {
    sendError(response, 400, 'invalid-delete-request', 'query param file (the stored artifact file name) is required')
    return
  }
  // The name is joined into the artifacts directory by stat()/remove(): an
  // unsafe name must never reach the filesystem (`..` would escape the
  // subdirectory and could unlink the state document). Same rule as the
  // download route.
  if (!isSafeArtifactName(fileName)) {
    sendError(response, 404, 'artifact-not-found', 'no stored artifact with that name; hosted artifact names end in .tgz')
    return
  }
  const info = await ctx.artifacts.stat(fileName)
  if (info === null) {
    sendError(response, 404, 'artifact-not-found', `no stored artifact named ${fileName}`)
    return
  }

  const reference = artifactReference(ctx.store, fileName)
  if (reference !== null) {
    sendArtifactReferenceRefusal(response, fileName, reference)
    return
  }

  const removed = await ctx.artifacts.remove(fileName)
  if (!removed) {
    // Raced with another deleter: nothing was reclaimed, so say so honestly.
    sendError(response, 404, 'artifact-not-found', `no stored artifact named ${fileName}`)
    return
  }
  response.writeHead(204, {
    'cache-control': 'no-store',
    'x-artifact-bytes-reclaimed': String(info.size),
  })
  response.end()
}

async function publishArtifact(request: IncomingMessage, response: ServerResponse, url: URL, ctx: AdminContext): Promise<void> {
  const displayName = url.searchParams.get('displayName')
  const summary = url.searchParams.get('summary')
  if (displayName === null || displayName.trim() === '' || summary === null || summary.trim() === '') {
    sendError(response, 400, 'invalid-publish-request', 'query params displayName and summary (non-empty) are required')
    return
  }
  const claimedSha256 = url.searchParams.get('sha256')
  if (claimedSha256 !== null && !SHA256_PATTERN.test(claimedSha256)) {
    sendError(response, 400, 'invalid-sha256-format', 'query param sha256 must be 64 lowercase hex characters')
    return
  }

  let staged: { tempName: string; sha256: string; size: number }
  try {
    staged = await ctx.artifacts.stage(request, claimedSha256 ?? undefined)
  } catch (cause) {
    if (cause instanceof ArtifactShaMismatchError) {
      sendError(response, 400, 'sha256-mismatch', 'claimed sha256 does not match the uploaded bytes')
      return
    }
    // 超限是调用方可诊断可纠正的,给 413 与实际上限(评审 P1:原答 400 且
    // 文案不含上限,运营者无从判断该压到多大)。
    if (cause instanceof ArtifactTooLargeError) {
      sendError(response, 413, 'artifact-too-large', `artifact exceeds the ${String(MAX_ARTIFACT_BYTES)}-byte limit`)
      return
    }
    // 其余 staging 失败(fs 故障等)是**服务端**问题:答 500 + 通用文案,
    // cause.message 只进日志(评审 P1:fs 错误的 message 含数据目录绝对路径,
    // 与 server.ts 自述的「never leak paths, env, or internals」矛盾)。
    console.error('[market-server] failed to stage uploaded artifact:', cause)
    sendError(response, 500, 'upload-failed', 'failed to stage the uploaded artifact; see the server log')
    return
  }

  try {
    let gateResult: ReturnType<typeof checkPublishGate>
    try {
      // Review D6: run the gate over the staged file via streaming gunzip
      // (capped decompression) instead of readFile-ing the whole artifact
      // (up to 100 MiB compressed, far more decompressed) into memory.
      gateResult = checkPublishGate(await extractPackageManifestFromFile(ctx.artifacts.pathOf(staged.tempName)))
    } catch (cause) {
      if (cause instanceof TarballError) {
        sendError(response, 400, cause.code, cause.message)
        return
      }
      throw cause
    }
    if (!gateResult.ok) {
      // Publish-side gate (round4 (c)): honest error AT PUBLISH TIME.
      sendError(response, 422, gateResult.rejection.code, gateResult.rejection.message)
      return
    }

    const fileName = artifactFileName(gateResult.name, gateResult.version, staged.sha256)
    const entryId = catalogEntryId(gateResult.name, gateResult.version)
    // The catalog id becomes a contract `identifier` (maxLength 160, review
    // D4): a long-but-valid name+version pair must be rejected here, not
    // silently stored as a provider page that fails self-validation.
    if (entryId.length > 160) {
      sendError(
        response,
        422,
        'invalid-package-identity',
        `catalog entry id for ${gateResult.name}@${gateResult.version} exceeds the contract identifier maximum of 160 characters`,
      )
      return
    }
    // Duplicate detection BEFORE commit() (review D2): the artifact file name
    // is content-derived, so re-publishing identical bytes maps to the very
    // file an existing entry still references. commit() rename-overwrites it
    // and addEntry would then throw — deleting the in-use artifact. Detect
    // the duplicate up front and touch nothing on disk; the staged temp file
    // is discarded by the finally path below.
    if (
      ctx.store.entry(entryId) !== null
      || ctx.store.entries().some(existing => existing.tarball === fileName)
    ) {
      sendError(response, 409, 'already-published', `${gateResult.name}@${gateResult.version} is already published; unpublish it first to re-release`)
      return
    }
    // Review D15: enforce the catalog scale cap AT PUBLISH TIME. prepare()
    // rejects an oversized catalog with `catalog-too-large`, but on its own that
    // only produces a frozen pipeline: entry N+1 published fine and every
    // subsequent prepare then failed, so the operator could not release a new
    // manifest for the N entries they already had without unpublishing first.
    // Rejecting here means the catalog can never enter that state — `>=`
    // because prepare's own guard is `entries.length > cap`. The cap is the
    // configured effective value (config.maxCatalogEntries, default = the
    // upstream contract maximum; Task 6.4, ruling R-3) — never a literal here.
    const maxCatalogEntries = ctx.config.maxCatalogEntries
    if (ctx.store.entries().length >= maxCatalogEntries) {
      sendError(
        response,
        422,
        'catalog-full',
        `the catalog already holds ${String(maxCatalogEntries)} entries, the most this deployment accepts; ` +
        'unpublish an entry before publishing this one (paginated / multi-page manifests are not implemented, ruling R-3)',
      )
      return
    }
    const entry: CatalogEntry = {
      id: entryId,
      packageName: gateResult.name,
      version: gateResult.version,
      displayName: displayName.trim(),
      summary: summary.trim(),
      updatedAt: new Date().toISOString(),
      sha256: staged.sha256,
      tarball: fileName,
    }
    // Write-side contract validation (review D3): the assembled entry must
    // already satisfy the provider-page contract. Checked BEFORE commit() so
    // a violating publish leaves no orphan artifact on disk, and again inside
    // the locked addEntry write as defense in depth.
    try {
      validateCatalogEntryContract(entry)
    } catch (cause) {
      if (cause instanceof EntryContractError) {
        sendError(response, 400, 'invalid-entry-contract', formatContractIssues(cause.issues))
        return
      }
      throw cause
    }
    await ctx.artifacts.commit(staged.tempName, fileName)
    staged.tempName = '' // committed; skip discard

    try {
      await ctx.store.addEntry(entry, validateCatalogEntryContract)
    } catch (cause) {
      if (cause instanceof DuplicateEntryError) {
        // Reachable, not dead code (fix-round N-5 — the previous wording claimed
        // the pre-commit duplicate check "serializes against addEntry", which is
        // false: an `await ctx.artifacts.commit(...)` sits between them, so two
        // same-byte publishes arriving in the same tick both pass the check, both
        // commit, and the loser lands here). That is harmless by construction —
        // the filename is content-derived, so the second commit renames over
        // identical bytes — but the branch must stay.
        // NEVER remove the on-disk artifact here — another entry may still
        // reference it (review D2); the old remove() turned a harmless
        // re-publish into data loss plus a frozen release pipeline.
        sendError(response, 409, 'already-published', `${gateResult.name}@${gateResult.version} is already published; unpublish it first to re-release`)
        return
      }
      throw cause
    }
    sendJson(response, 201, { entry, sha256: staged.sha256 })
  } finally {
    if (staged.tempName !== '') await ctx.artifacts.discard(staged.tempName)
  }
}

function activeRevision(manifest: unknown): number | null {
  if (manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)) {
    const envelope = (manifest as Record<string, unknown>).envelope
    if (envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope)) {
      const revision = (envelope as Record<string, unknown>).revision
      if (typeof revision === 'number') return revision
    }
  }
  return null
}

/**
 * Dispatch one request. Returns false when the path is not an admin route;
 * otherwise sends the response and returns true.
 */
export async function handleAdminRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ctx: AdminContext,
): Promise<boolean> {
  const { pathname } = url
  if (!pathname.startsWith(ADMIN_ROUTE_PREFIX)) return false
  const method = request.method ?? 'GET'

  const auth = authenticateAdmin(request, ctx.config)
  if (!auth.ok) {
    sendError(response, 401, auth.code, auth.message)
    return true
  }

  try {
    if (pathname === `${ADMIN_ROUTE_PREFIX}state` && method === 'GET') {
      const manifest = ctx.store.manifest()
      sendJson(response, 200, {
        adminEnabled: true,
        entries: ctx.store.entries(),
        entryCount: ctx.store.entries().length,
        maxRevision: ctx.store.maxRevision(),
        activeRevision: activeRevision(manifest),
        active: manifest !== null,
        pending: ctx.store.pendingManifest() !== null,
        // P11b: the operator page lists deletable artifacts separately from
        // referenced ones; the flag is computed here (one judgment, all three
        // faces) so the page never re-derives it.
        artifacts: await artifactInventory(ctx),
      })
      return true
    }

    if (pathname === ADMIN_ARTIFACTS_PATH && method === 'POST') {
      await publishArtifact(request, response, url, ctx)
      return true
    }

    if (pathname === ADMIN_ARTIFACT_PATH) {
      if (method !== 'DELETE') {
        sendError(response, 405, 'method-not-allowed', 'only DELETE is supported')
        return true
      }
      await deleteArtifact(response, url, ctx)
      return true
    }

    if (pathname === `${ADMIN_ROUTE_PREFIX}manifest/prepare` && method === 'POST') {
      let manifest: Awaited<ReturnType<typeof preparePendingManifest>>
      try {
        manifest = await preparePendingManifest({
          store: ctx.store,
          catalog: ctx.catalog,
          config: ctx.config,
          artifactSize: async fileName => (await ctx.artifacts.stat(fileName))?.size ?? null,
        })
      } catch (cause) {
        // Honest 4xx for operator-preventable conditions (review D14d): the
        // runbook promises "more entries than the cap or a missing artifact is
        // honestly rejected" — a bare 500 buries manifest-prepare's operator
        // guidance (e.g. "Split the source before releasing") in server logs
        // and mislabels a data-side problem as an internal error.
        if (cause instanceof ManifestPrepareError) {
          const status = cause.code === 'catalog-too-large' ? 422 : 409
          // Ruling D-M6-26: a refusal caused by a contract-violating stored
          // entry reaches the operator in the response body (this route is
          // token-authenticated, so the named entry + reason are allowed) and
          // in the durable log.
          if (cause.code === 'catalog-entry-invalid') {
            console.error('[market-server] refusing to prepare a signed manifest:', cause.message)
          }
          sendError(response, status, cause.code, cause.message)
          return true
        }
        throw cause
      }
      sendJson(response, 200, { pendingManifest: manifest })
      return true
    }

    if (pathname === `${ADMIN_ROUTE_PREFIX}manifest/pending` && method === 'GET') {
      const pending = ctx.store.pendingManifest()
      if (pending === null) {
        sendError(response, 404, 'pending-manifest-not-found', 'no pending manifest; run POST /v1/admin/manifest/prepare first')
        return true
      }
      sendJson(response, 200, { pendingManifest: pending })
      return true
    }

    if (pathname === `${ADMIN_ROUTE_PREFIX}manifest/signature` && method === 'POST') {
      let body: unknown
      try {
        body = await readJsonBody(request)
      } catch (cause) {
        sendError(response, 400, 'invalid-json', cause instanceof Error ? cause.message : 'invalid JSON body')
        return true
      }
      let verdict: IntakeVerdict
      try {
        verdict = await intakeSignature({ store: ctx.store, config: ctx.config, signatureRecord: body })
      } catch (cause) {
        // Concurrent double-intake race: a second activate() lost the locked
        // update because the max revision already advanced — an honest 409
        // conflict, not a bare 500 (final review finding 2).
        if (cause instanceof ManifestActivationConflictError) {
          sendError(response, 409, 'manifest-activation-conflict', cause.message)
          return true
        }
        throw cause
      }
      if (!verdict.ok) {
        sendJson(response, 400, { activated: false, reason: verdict.reason })
        return true
      }
      sendJson(response, 200, { activated: true, revision: verdict.revision, slot: verdict.slot })
      return true
    }

    const entriesPrefix = `${ADMIN_ROUTE_PREFIX}entries/`
    if (pathname.startsWith(entriesPrefix)) {
      const rest = pathname.slice(entriesPrefix.length)
      if (rest === '') {
        sendError(response, 404, 'not-found', 'unknown admin route')
        return true
      }
      const unpublishSuffix = '/unpublish'
      if (rest.endsWith(unpublishSuffix)) {
        const id = decodeURIComponent(rest.slice(0, rest.length - unpublishSuffix.length))
        if (method !== 'POST') {
          sendError(response, 405, 'method-not-allowed', 'only POST is supported')
          return true
        }
        try {
          await ctx.store.removeEntry(id)
        } catch (cause) {
          if (cause instanceof EntryNotFoundError) {
            sendError(response, 404, 'entry-not-found', cause.message)
            return true
          }
          throw cause
        }
        sendJson(response, 200, { unpublished: id })
        return true
      }

      const id = decodeURIComponent(rest)
      if (method === 'PATCH') {
        let body: unknown
        try {
          body = await readJsonBody(request)
        } catch (cause) {
          sendError(response, 400, 'invalid-json', cause instanceof Error ? cause.message : 'invalid JSON body')
          return true
        }
        let patch: CatalogEntryPatch
        try {
          patch = parseEntryPatch(body)
        } catch (cause) {
          sendError(response, 400, 'invalid-entry-patch', cause instanceof Error ? cause.message : 'invalid patch')
          return true
        }
        try {
          // The merged entry is validated INSIDE the locked write (review
          // D3): a contract-violating patch aborts the update, so the stored
          // catalog can never reach a state the read side must reject.
          const entry = await ctx.store.updateEntry(id, patch, validateCatalogEntryContract)
          sendJson(response, 200, { entry })
        } catch (cause) {
          if (cause instanceof EntryNotFoundError) {
            sendError(response, 404, 'entry-not-found', cause.message)
            return true
          }
          if (cause instanceof EntryContractError) {
            sendError(response, 400, 'invalid-entry-contract', formatContractIssues(cause.issues))
            return true
          }
          throw cause
        }
        return true
      }

      sendError(response, 405, 'method-not-allowed', 'only PATCH and POST /unpublish are supported')
      return true
    }

    sendError(response, 404, 'not-found', 'unknown admin route')
    return true
  } catch (cause) {
    // Never swallow silently: the 500 body stays generic (contract security
    // boundary), but the caught error must reach the operator's log.
    console.error('[market-server] unhandled admin route error:', cause)
    if (!response.headersSent) sendError(response, 500, 'internal-error', 'internal error')
    else response.destroy()
    return true
  }
}
