/**
 * Catalog state for market-server (Task 1; extended by Task 2).
 *
 * One JSON document (`<dataDir>/catalog-state.json`) is the entire catalog
 * state: versioned entries, the activated signed manifest + its detached
 * signature, the pending (not yet signed) manifest, and the persisted
 * per-source maximum accepted revision. Mutations go through the locked
 * atomic store; a restart reloads the document, which IS the full-recovery
 * story (§13). The server keeps no separate response cache (round5 N8).
 *
 * Single instance (Task 6.5, P6): opening the state takes `<dataDir>/server.lock`
 * (pid + start time). A second instance against the same data directory — or a
 * state JSON restored underneath a running instance — would silently serve
 * stale state, so it FAILS AT STARTUP with an honest error naming the holding
 * pid (the operator either stops that instance or, if the pid is gone, deletes
 * the lock file). A lock whose recorded owner is confirmed gone (crashed
 * process) is taken over atomically, so restarts keep working; `close()`
 * releases the lock on the way out.
 *
 * Contract positioning (round3 R4/R12 + round4 M4'): market-server does NOT
 * claim to be a standard source — it serves no `catalog-source` manifest.
 * The provider-page payload layer is schema-compatible only. The install
 * target (tarball URL + sha256) is a versioned huaanwork private envelope,
 * carried by the offline-signed manifest and stored here verbatim; the
 * signature record is a DETACHED sidecar — it never enters the strict
 * contract schema body (Task 2 / Task 5 Step 1).
 *
 * The state schema stays `version: 1`; the Task 2 fields are additive and
 * optional for backward compatibility with Task 1 state files.
 */

import { join } from 'node:path'
import { JsonFileStore, acquireLockFile, type LockFileConflict } from '../store.ts'

export const MARKET_STATE_VERSION = 1
export const CATALOG_STATE_FILE = 'catalog-state.json'
/** Single-instance lock of the data directory (pid + start time). */
export const SERVER_LOCK_FILE = 'server.lock'

/**
 * One published catalog entry. `sha256`/`tarball` are private-envelope data:
 * they feed the signed manifest (wrapper install target) and are never
 * emitted in the contract provider page. The URL-typed display fields
 * (homepage / publisher.url / repository.url) are provider-page display data
 * only; the contract requires them to be https URIs, and the intranet source
 * has no public URLs to fill in — the admin surface therefore treats empty
 * as unset and rejects non-https values at publish time (round3 R15).
 */
export interface CatalogEntry {
  /** Stable provider item ID (contract identifier pattern). */
  readonly id: string
  /** npm-package-identity name (`@scope/name` or `name`). */
  readonly packageName: string
  readonly version: string
  readonly displayName: string
  readonly summary: string
  readonly description?: string
  readonly license?: string
  readonly categories?: readonly string[]
  readonly keywords?: readonly string[]
  readonly capabilities?: readonly string[]
  /** ISO 8601 UTC date-time. */
  readonly updatedAt?: string
  /** lowercase hex sha256 of the published tarball (private envelope). */
  readonly sha256?: string
  /** tarball file name served from the artifact endpoint (private envelope). */
  readonly tarball?: string
  /** https-only provider-page display field; empty/absent = unset. */
  readonly homepage?: string
  readonly publisherName?: string
  /** https-only (paired with publisherName in the provider page). */
  readonly publisherUrl?: string
  /** https-only repository URL. */
  readonly repositoryUrl?: string
}

export interface MarketStateV1 {
  readonly version: 1
  readonly entries: readonly CatalogEntry[]
  /** Activated signed manifest, verbatim; null until a valid signature activates one. */
  readonly manifest: unknown | null
  /** Canonical pending manifest awaiting an offline signature; null when none. */
  readonly pendingManifest: unknown | null
  /** Detached signature record of the ACTIVATED manifest (sidecar); null until activation. */
  readonly signature: unknown | null
  /** Persisted per-source maximum accepted manifest revision (anti-replay). */
  readonly maxRevision: number
}

/** Mutable edit patch: every listed field may be replaced; `| undefined` clears it. */
export type CatalogEntryPatch = Partial<{
  displayName: string
  summary: string
  description: string | undefined
  license: string | undefined
  categories: readonly string[] | undefined
  keywords: readonly string[] | undefined
  capabilities: readonly string[] | undefined
  updatedAt: string | undefined
  homepage: string | undefined
  publisherName: string | undefined
  publisherUrl: string | undefined
  repositoryUrl: string | undefined
}>

export class EntryNotFoundError extends Error {
  readonly entryId: string

  constructor(entryId: string) {
    super(`no catalog entry with id ${entryId}`)
    this.name = 'EntryNotFoundError'
    this.entryId = entryId
  }
}

export class DuplicateEntryError extends Error {
  readonly entryId: string

  constructor(entryId: string) {
    super(`a catalog entry with id ${entryId} already exists`)
    this.name = 'DuplicateEntryError'
    this.entryId = entryId
  }
}

/**
 * Concurrent-activation conflict: two intakes raced on the same pending
 * manifest and the locked update observed that the persisted max revision
 * already advanced past the revision being activated. Surfaced by the
 * intake route as an honest 409 (final review finding 2), never a bare 500.
 */
export class ManifestActivationConflictError extends Error {
  readonly revision: number
  readonly maxRevision: number

  constructor(revision: number, maxRevision: number) {
    super(`activation revision ${String(revision)} does not advance maxRevision ${String(maxRevision)}`)
    this.name = 'ManifestActivationConflictError'
    this.revision = revision
    this.maxRevision = maxRevision
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every(item => typeof item === 'string') ? (value as readonly string[]) : undefined
}

function parseEntry(value: unknown): CatalogEntry {
  if (!isRecord(value)) throw new TypeError('catalog entry must be an object')
  const id = value.id
  const packageName = value.packageName
  const version = value.version
  const displayName = value.displayName
  const summary = value.summary
  if (typeof id !== 'string' || id === '') throw new TypeError('catalog entry.id must be a non-empty string')
  if (typeof packageName !== 'string' || packageName === '') {
    throw new TypeError(`catalog entry ${id}: packageName must be a non-empty string`)
  }
  if (typeof version !== 'string' || version === '') {
    throw new TypeError(`catalog entry ${id}: version must be a non-empty string`)
  }
  if (typeof displayName !== 'string' || displayName === '') {
    throw new TypeError(`catalog entry ${id}: displayName must be a non-empty string`)
  }
  if (typeof summary !== 'string' || summary === '') {
    throw new TypeError(`catalog entry ${id}: summary must be a non-empty string`)
  }
  const entry: {
    id: string
    packageName: string
    version: string
    displayName: string
    summary: string
    description?: string
    license?: string
    categories?: readonly string[]
    keywords?: readonly string[]
    capabilities?: readonly string[]
    updatedAt?: string
    sha256?: string
    tarball?: string
    homepage?: string
    publisherName?: string
    publisherUrl?: string
    repositoryUrl?: string
  } = { id, packageName, version, displayName, summary }
  const description = optionalString(value.description)
  const license = optionalString(value.license)
  const categories = optionalStringArray(value.categories)
  const keywords = optionalStringArray(value.keywords)
  const capabilities = optionalStringArray(value.capabilities)
  const updatedAt = optionalString(value.updatedAt)
  const sha256 = optionalString(value.sha256)
  const tarball = optionalString(value.tarball)
  const homepage = optionalString(value.homepage)
  const publisherName = optionalString(value.publisherName)
  const publisherUrl = optionalString(value.publisherUrl)
  const repositoryUrl = optionalString(value.repositoryUrl)
  if (description !== undefined) entry.description = description
  if (license !== undefined) entry.license = license
  if (categories !== undefined) entry.categories = categories
  if (keywords !== undefined) entry.keywords = keywords
  if (capabilities !== undefined) entry.capabilities = capabilities
  if (updatedAt !== undefined) entry.updatedAt = updatedAt
  if (sha256 !== undefined) entry.sha256 = sha256
  if (tarball !== undefined) entry.tarball = tarball
  if (homepage !== undefined) entry.homepage = homepage
  if (publisherName !== undefined) entry.publisherName = publisherName
  if (publisherUrl !== undefined) entry.publisherUrl = publisherUrl
  if (repositoryUrl !== undefined) entry.repositoryUrl = repositoryUrl
  return entry
}

function parseState(value: unknown): MarketStateV1 {
  if (!isRecord(value)) throw new TypeError('catalog state must be an object')
  if (value.version !== MARKET_STATE_VERSION) {
    throw new TypeError(`unsupported catalog state version ${String(value.version)} (expected ${MARKET_STATE_VERSION})`)
  }
  if (!Array.isArray(value.entries)) throw new TypeError('catalog state entries must be an array')
  const entries = value.entries.map(parseEntry)
  const ids = new Set<string>()
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new TypeError(`duplicate catalog entry id ${entry.id}`)
    ids.add(entry.id)
  }
  const maxRevision = value.maxRevision === undefined ? 0 : value.maxRevision
  if (typeof maxRevision !== 'number' || !Number.isInteger(maxRevision) || maxRevision < 0) {
    throw new TypeError('catalog state maxRevision must be a non-negative integer')
  }
  return {
    version: MARKET_STATE_VERSION,
    entries,
    manifest: value.manifest === undefined ? null : value.manifest,
    pendingManifest: value.pendingManifest === undefined ? null : value.pendingManifest,
    signature: value.signature === undefined ? null : value.signature,
    maxRevision,
  }
}

function emptyState(): MarketStateV1 {
  return { version: MARKET_STATE_VERSION, entries: [], manifest: null, pendingManifest: null, signature: null, maxRevision: 0 }
}

/**
 * A second instance against the same data directory (P6). The error names the
 * holder so the operator can act; the process exits non-zero at startup instead
 * of serving stale state.
 */
export class InstanceLockError extends Error {
  readonly lockPath: string
  readonly holderPid: number | null
  readonly holderStartedAt: number | null

  constructor(lockPath: string, conflict: LockFileConflict) {
    const holder = conflict.holder
    if (holder === null) {
      super(
        `market-server: another instance may already be using the data directory — ${lockPath} exists but does not name a process ` +
          `(${conflict.reason}). Inspect it and remove it only after confirming no market-server is running against that data directory.`,
      )
    } else {
      super(
        `market-server: another instance is already using the data directory — ${lockPath} is held by pid ${String(holder.pid)} ` +
          `since ${holder.startedAt > 0 ? new Date(holder.startedAt).toISOString() : 'an unknown time'} (${conflict.reason}). ` +
          'Stop that instance before starting this one; if that pid is no longer running, remove the lock file.',
      )
    }
    this.name = 'InstanceLockError'
    this.lockPath = lockPath
    this.holderPid = holder?.pid ?? null
    this.holderStartedAt = holder?.startedAt ?? null
  }
}

export class CatalogStore {
  readonly #store: JsonFileStore<MarketStateV1>
  readonly #releaseInstanceLock: () => Promise<void>
  #state: MarketStateV1

  private constructor(store: JsonFileStore<MarketStateV1>, state: MarketStateV1, releaseInstanceLock: () => Promise<void>) {
    this.#store = store
    this.#state = state
    this.#releaseInstanceLock = releaseInstanceLock
  }

  /**
   * Open (or initialize) the catalog state. Corrupt JSON fails closed via
   * StoreCorruptError; a data directory already owned by a live instance fails
   * via InstanceLockError (P6).
   */
  static async open(dataDir: string): Promise<CatalogStore> {
    const store = new JsonFileStore<MarketStateV1>(dataDir, CATALOG_STATE_FILE, {
      defaultValue: emptyState(),
      validate: parseState,
    })
    const lockPath = join(dataDir, SERVER_LOCK_FILE)
    // No age requirement and no waiting: the server may run for days, so the
    // mtime says nothing about liveness — the recorded pid does. A lock whose
    // owner is gone (crashed instance) is taken over atomically; a live (or
    // unattributable) holder refuses this startup immediately.
    const acquisition = await acquireLockFile(lockPath, { staleMs: 0, waitMs: 0 })
    if (!acquisition.ok) throw new InstanceLockError(lockPath, acquisition.conflict)
    try {
      return new CatalogStore(store, await store.load(), acquisition.release)
    } catch (cause) {
      await acquisition.release().catch((releaseCause: unknown) => {
        console.error('[market-server] failed to release the instance lock after a startup error:', releaseCause)
      })
      throw cause
    }
  }

  /**
   * Release this instance's data-directory lock (`<dataDir>/server.lock`).
   * Idempotent; the process exit path needs no signal handler because a lock
   * whose owner is gone is taken over by the next instance.
   */
  async close(): Promise<void> {
    await this.#releaseInstanceLock()
  }

  /** Stateless read: the in-memory state is the authoritative document, not a cache tier. */
  get state(): MarketStateV1 {
    return this.#state
  }

  entries(): readonly CatalogEntry[] {
    return this.#state.entries
  }

  entry(id: string): CatalogEntry | null {
    return this.#state.entries.find(candidate => candidate.id === id) ?? null
  }

  /** The activated signed manifest, verbatim. */
  manifest(): unknown | null {
    return this.#state.manifest
  }

  /** The canonical pending manifest awaiting an offline signature. */
  pendingManifest(): unknown | null {
    return this.#state.pendingManifest
  }

  /** Detached signature record of the activated manifest. */
  signature(): unknown | null {
    return this.#state.signature
  }

  /** Persisted per-source maximum accepted revision (anti-replay). */
  maxRevision(): number {
    return this.#state.maxRevision
  }

  /** Replace the catalog entries (tests seed via this). */
  async replaceEntries(entries: readonly CatalogEntry[]): Promise<void> {
    const next = await this.#store.update(current => {
      const ids = new Set<string>()
      for (const entry of entries) {
        if (ids.has(entry.id)) throw new DuplicateEntryError(entry.id)
        ids.add(entry.id)
      }
      return { ...current, entries: [...entries] }
    })
    this.#state = next
  }

  /**
   * Append one entry (admin publish; identity+gate checks happened upstream).
   * `validate`, when given, runs on the assembled state INSIDE the locked
   * write (review D3): throwing aborts the write, so a contract-violating
   * entry can never reach the state document.
   */
  async addEntry(entry: CatalogEntry, validate?: (entry: CatalogEntry) => void): Promise<void> {
    const next = await this.#store.update(current => {
      if (current.entries.some(candidate => candidate.id === entry.id)) {
        throw new DuplicateEntryError(entry.id)
      }
      if (validate !== undefined) validate(entry)
      return { ...current, entries: [...current.entries, entry] }
    })
    this.#state = next
  }

  /**
   * Patch display fields of one entry (admin edit). Throws EntryNotFoundError.
   * `validate`, when given, runs on the MERGED entry inside the locked write
   * (review D3): throwing aborts the write, so a contract-violating patch
   * can never poison the stored catalog.
   */
  async updateEntry(id: string, patch: CatalogEntryPatch, validate?: (entry: CatalogEntry) => void): Promise<CatalogEntry> {
    let updated: CatalogEntry | undefined
    const next = await this.#store.update(current => {
      const existing = current.entries.find(candidate => candidate.id === id)
      if (existing === undefined) throw new EntryNotFoundError(id)
      const index = current.entries.indexOf(existing)
      // exactOptionalPropertyTypes: explicit-undefined patch entries CLEAR the
      // field (key removed) instead of being written as undefined.
      const merged: Record<string, unknown> = { ...existing }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete merged[key]
        else merged[key] = value
      }
      updated = merged as unknown as CatalogEntry
      if (validate !== undefined) validate(updated)
      const entries = [...current.entries]
      entries[index] = updated
      return { ...current, entries }
    })
    this.#state = next
    if (updated === undefined) throw new EntryNotFoundError(id)
    return updated
  }

  /** Remove one entry from the catalog (admin unpublish; the artifact file stays on disk). */
  async removeEntry(id: string): Promise<void> {
    const next = await this.#store.update(current => {
      if (!current.entries.some(candidate => candidate.id === id)) throw new EntryNotFoundError(id)
      return { ...current, entries: current.entries.filter(candidate => candidate.id !== id) }
    })
    this.#state = next
  }

  /** Store the canonical pending manifest (admin prepare; no signature yet = not active). */
  async setPendingManifest(manifest: unknown): Promise<void> {
    const next = await this.#store.update(current => ({ ...current, pendingManifest: manifest }))
    this.#state = next
  }

  /**
   * Activate a verified pending manifest: the manifest and its detached
   * signature become the served pair, the pending slot clears, and the
   * persisted per-source max revision advances (anti-replay). Callers MUST
   * have run verifyWithKeySlots first — this stores blindly (fail-closed
   * verification lives in the intake path, manifest-prepare.ts).
   */
  async activate(manifest: unknown, signature: unknown, revision: number): Promise<void> {
    const next = await this.#store.update(current => {
      if (!Number.isInteger(revision) || revision <= current.maxRevision) {
        throw new ManifestActivationConflictError(
          typeof revision === 'number' ? revision : 0,
          current.maxRevision,
        )
      }
      return { ...current, manifest, signature, pendingManifest: null, maxRevision: revision }
    })
    this.#state = next
  }
}
