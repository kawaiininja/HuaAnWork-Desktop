/**
 * Shared types of the in-repo agent catalog server.
 *
 * `CatalogState` is the ENTIRE persisted server state: one JSON document with
 * four keyed collections. Keys are fixed by the plan and by every later task:
 *
 *   submissions      submission id
 *   packages         `${slug}/${version}`
 *   delistRequests   request id
 *   revocations      `${slug}/${version}`
 *
 * Task 4 introduces the shape and the store; Task 5 fills the submission and
 * read handlers, Task 6 adds the governance handlers. Later tasks may add fields
 * to the records (never new top-level collections).
 */

import type { AgentPackageDigest, AgentPackageManifest } from '@huaanwork/agent-package-format'
import type { CatalogSignature } from '@huaanwork/catalog-signing'
import type { AuditOutcome } from './audit.ts'

/** The unified error body of every JSON error response. */
export interface AgentCatalogErrorBody {
  readonly error: string
  readonly code?: string
}

/**
 * One handler result, exactly as the dispatcher expects it (`server.ts` audits
 * `audit` before writing `raw` or `body`).
 */
export interface HandlerResult {
  readonly status: number
  /** JSON body (`raw` wins when both are present). */
  readonly body?: unknown
  readonly raw?: { readonly contentType: string; readonly data: Buffer }
  readonly headers?: Readonly<Record<string, string>>
  readonly audit: {
    readonly action: string
    readonly outcome: AuditOutcome
    readonly reason?: string
    readonly slug?: string
    readonly version?: string
    readonly submissionId?: string
    /**
     * Delist request id (Task 6). Every governance response and audit record
     * carries it; it is a request id, NOT a submission id.
     */
    readonly delistRequestId?: string
  }
}

/**
 * One legacy M-A0 catalog entry. The document is served VERBATIM (parsed and
 * re-serialized, no field rewriting): desktop clients validate its fields, so
 * the server must not invent, rename, or drop any of them.
 */
export type LegacyCatalogEntry = Record<string, unknown>

/** Rendered item of `GET /v1/catalog`. */
export interface LegacyCatalogListBody {
  readonly items: LegacyCatalogEntry[]
}

export type SubmissionStatus = 'pending-review' | 'published' | 'rejected'

/**
 * One agent-package submission (Task 5 owns the lifecycle). `digest` is the
 * digest the SERVER recomputed from the uploaded bundle; the client-provided
 * digest is never trusted or stored.
 *
 * `migrationFrom` is INTERNAL bookkeeping: it is set only when the submission
 * used a legal `X-Agent-Catalog-Migration` exception (matching header plus a
 * same-name `kind:"agent"` legacy entry). It is never part of the client-facing
 * submission body; approval copies it onto the published package.
 */
export interface Submission {
  readonly id: string
  readonly slug: string
  readonly version: string
  status: SubmissionStatus
  readonly submittedAt: string
  updatedAt: string
  readonly actor: string
  readonly digest: AgentPackageDigest
  reason?: string
  migrationFrom?: string
}

/** Client-facing submission body (never carries internal actors or markers). */
export interface SubmissionResponse {
  readonly submissionId: string
  readonly slug: string
  readonly version: string
  readonly status: SubmissionStatus
  readonly submittedAt: string
  readonly updatedAt: string
  readonly digest: AgentPackageDigest
  readonly reason?: string
}

/**
 * Admin submission detail: the live `previousVersion`/`previousDigest` of the
 * highest already-signed record for the slug (delisted/revoked included) so the
 * offline CLI can diff the candidate against what the catalog serves today.
 */
export interface AdminSubmissionResponse extends SubmissionResponse {
  readonly previousVersion?: string
  readonly previousDigest?: AgentPackageDigest
}

/** One item of `GET /v1/agent-packages` (the highest published version). */
export interface AgentPackageSummary {
  readonly slug: string
  readonly displayName: string
  readonly description: string
  readonly version: string
  readonly size: number
  readonly status: 'published'
  readonly updatedAt: string
  readonly migrationFrom?: string
}

/**
 * `GET /v1/agent-packages/{slug}/{version}`. Installed clients still receive
 * delisted/revoked metadata (so they can explain the state); only `published`
 * records carry `bundleUrl`.
 */
export interface AgentPackageMetadata {
  readonly slug: string
  readonly version: string
  readonly status: PackageStatus
  readonly displayName: string
  readonly description: string
  readonly size: number
  readonly updatedAt: string
  readonly digest: AgentPackageDigest
  readonly signature: CatalogSignature
  readonly migrationFrom?: string
  readonly bundleUrl?: string
}

export type PackageStatus = 'published' | 'delisted' | 'revoked'

/**
 * One published package version (Task 5 writes it on approval, Task 6 moves
 * the status through delisted/revoked). `size` is the final SIGNED bundle
 * byte count; list/detail responses never read untrusted client fields.
 */
export interface PublishedPackage {
  readonly slug: string
  readonly version: string
  readonly manifest: AgentPackageManifest
  readonly digest: AgentPackageDigest
  readonly signature: CatalogSignature
  status: PackageStatus
  readonly size: number
  updatedAt: string
  readonly actor: string
  readonly migrationFrom?: string
}

export type DelistRequestStatus = 'pending' | 'approved' | 'rejected'

/** One delist request (Task 6 owns the approval semantics). */
export interface DelistRequest {
  readonly id: string
  readonly slug: string
  readonly version: string
  status: DelistRequestStatus
  readonly reason: string
  readonly actor: string
  readonly createdAt: string
  resolvedAt?: string
}

/** `GET /v1/agent-packages/delist-requests?status=pending`. */
export interface DelistRequestListBody {
  readonly items: DelistRequest[]
}

/** One revocation record (Task 6 owns the write path). */
export interface Revocation {
  readonly slug: string
  readonly version: string
  readonly reason: string
  readonly revokedAt: string
  readonly actor: string
}

/**
 * Client-facing revocation item. `actor` is server audit material only: every
 * read-token holder must not learn the 12-hex admin-token hash, so the list
 * route maps the internal {@link Revocation} down to exactly these fields.
 */
export interface RevocationListEntry {
  readonly slug: string
  readonly version: string
  readonly reason: string
  readonly revokedAt: string
}

/** `GET /v1/agent-packages/revocations` (one page). */
export interface RevocationListBody {
  readonly items: RevocationListEntry[]
  /**
   * The `(revokedAt, slug, version)` tuple of the last item on this page, when
   * more records follow. Absent on the final page.
   */
  readonly nextCursor?: string
}

export interface CatalogState {
  schemaVersion: 1
  /**
   * The request id of the LAST committed mutation (Task 4). It binds a state
   * commit to its durable audit intent: after a crash between the commit and
   * the audit result line, startup reconciliation compares this id with each
   * unclosed intent to decide whether the change actually happened.
   */
  lastMutation?: { requestId: string; action: string; at: string }
  submissions: Record<string, Submission>
  packages: Record<string, PublishedPackage>
  delistRequests: Record<string, DelistRequest>
  revocations: Record<string, Revocation>
}

/** The key of a package record in `packages` and `revocations`. */
export function packageKey(slug: string, version: string): string {
  return `${slug}/${version}`
}

/**
 * Every distribution decision a package version can have, derived from ONE
 * function (Task 6):
 *
 *   listed        appears in `GET /v1/agent-packages`
 *   downloadable  `GET .../bundle` serves the signed bytes
 *   error/code    the exact 410 body when the bundle is withheld
 *
 * The list, metadata and bundle routes MUST read this instead of testing
 * `record.status` themselves: three independent tests are how a catalog starts
 * advertising a bundle it then refuses to serve.
 *
 * Metadata stays readable for every state (installed clients have to be able to
 * explain why a version stopped updating); only `downloadable` gates the bytes
 * and only `listed` gates the catalog entry.
 */
export type PackageDistribution =
  | { readonly status: 'published'; readonly listed: true; readonly downloadable: true }
  | {
      readonly status: 'delisted'
      readonly listed: false
      readonly downloadable: false
      readonly error: string
      readonly code: 'package-delisted'
    }
  | {
      readonly status: 'revoked'
      readonly listed: false
      readonly downloadable: false
      readonly error: string
      readonly code: 'package-revoked'
    }

export function packageDistributionStatus(record: Pick<PublishedPackage, 'status'>): PackageDistribution {
  switch (record.status) {
    case 'published':
      return { status: 'published', listed: true, downloadable: true }
    case 'delisted':
      return {
        status: 'delisted',
        listed: false,
        downloadable: false,
        error: '版本已下架',
        code: 'package-delisted',
      }
    case 'revoked':
      return {
        status: 'revoked',
        listed: false,
        downloadable: false,
        error: '版本已撤销',
        code: 'package-revoked',
      }
  }
}

/** A fresh, empty `CatalogState` (the initial state of a new data dir). */
export function emptyCatalogState(): CatalogState {
  return {
    schemaVersion: 1,
    submissions: {},
    packages: {},
    delistRequests: {},
    revocations: {},
  }
}
