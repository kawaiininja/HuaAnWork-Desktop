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
 * Task 4 introduces the shape and the store; Tasks 5/6 fill the handlers and
 * may add fields to the records (never new top-level collections).
 */

import type { AgentPackageDigest, AgentPackageManifest } from '@huaanwork/agent-package-format'
import type { CatalogSignature } from '@huaanwork/catalog-signing'

/** The unified error body of every JSON error response. */
export interface AgentCatalogErrorBody {
  readonly error: string
  readonly code?: string
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

/** One revocation record (Task 6 owns the write path). */
export interface Revocation {
  readonly slug: string
  readonly version: string
  readonly reason: string
  readonly revokedAt: string
  readonly actor: string
}

export interface CatalogState {
  schemaVersion: 1
  submissions: Record<string, Submission>
  packages: Record<string, PublishedPackage>
  delistRequests: Record<string, DelistRequest>
  revocations: Record<string, Revocation>
}

/** The key of a package record in `packages` and `revocations`. */
export function packageKey(slug: string, version: string): string {
  return `${slug}/${version}`
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
