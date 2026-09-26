/**
 * Catalog state for market-server (Task 1).
 *
 * One JSON document (`<dataDir>/catalog-state.json`) is the entire catalog
 * state: versioned entries plus the stored signed manifest. Mutations go
 * through the locked atomic store; a restart reloads the document, which IS
 * the full-recovery story (§13). The server keeps no separate response cache
 * (round5 N8: M5 has no catalog caching anywhere; the wrapper re-fetches and
 * re-verifies every time).
 *
 * Contract positioning (round3 R4/R12 + round4 M4'): market-server does NOT
 * claim to be a standard source — it serves no `catalog-source` manifest.
 * The provider-page payload layer is schema-compatible only. The install
 * target (tarball URL + sha256) is a versioned huaanwork private envelope,
 * carried by the offline-signed manifest (Task 2 intake/activation) and
 * stored here verbatim; this task never signs anything.
 */

import { JsonFileStore } from '../store.ts'

export const MARKET_STATE_VERSION = 1
export const CATALOG_STATE_FILE = 'catalog-state.json'

/**
 * One published catalog entry. `sha256`/`tarball` are private-envelope data:
 * they feed the signed manifest (wrapper install target) and are never
 * emitted in the contract provider page.
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
  /** lowercase hex sha256 of the published tarball (Task 2 envelope). */
  readonly sha256?: string
  /** tarball file name served from the artifact endpoint (Task 2). */
  readonly tarball?: string
}

export interface MarketStateV1 {
  readonly version: 1
  readonly entries: readonly CatalogEntry[]
  /** Stored signed manifest (offline-signed envelope), verbatim; null until Task 2 activates one. */
  readonly manifest: unknown | null
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
  } = { id, packageName, version, displayName, summary }
  const description = optionalString(value.description)
  const license = optionalString(value.license)
  const categories = optionalStringArray(value.categories)
  const keywords = optionalStringArray(value.keywords)
  const capabilities = optionalStringArray(value.capabilities)
  const updatedAt = optionalString(value.updatedAt)
  const sha256 = optionalString(value.sha256)
  const tarball = optionalString(value.tarball)
  if (description !== undefined) entry.description = description
  if (license !== undefined) entry.license = license
  if (categories !== undefined) entry.categories = categories
  if (keywords !== undefined) entry.keywords = keywords
  if (capabilities !== undefined) entry.capabilities = capabilities
  if (updatedAt !== undefined) entry.updatedAt = updatedAt
  if (sha256 !== undefined) entry.sha256 = sha256
  if (tarball !== undefined) entry.tarball = tarball
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
  return {
    version: MARKET_STATE_VERSION,
    entries,
    manifest: value.manifest === undefined ? null : value.manifest,
  }
}

export class CatalogStore {
  readonly #store: JsonFileStore<MarketStateV1>
  #state: MarketStateV1

  private constructor(store: JsonFileStore<MarketStateV1>, state: MarketStateV1) {
    this.#store = store
    this.#state = state
  }

  /** Open (or initialize) the catalog state. Corrupt JSON fails closed via StoreCorruptError. */
  static async open(dataDir: string): Promise<CatalogStore> {
    const store = new JsonFileStore<MarketStateV1>(dataDir, CATALOG_STATE_FILE, {
      defaultValue: { version: MARKET_STATE_VERSION, entries: [], manifest: null },
      validate: parseState,
    })
    return new CatalogStore(store, await store.load())
  }

  /** Stateless read: the in-memory state is the authoritative document, not a cache tier. */
  get state(): MarketStateV1 {
    return this.#state
  }

  entries(): readonly CatalogEntry[] {
    return this.#state.entries
  }

  /** The stored signed manifest, verbatim. Task 2 fills this via intake/activation. */
  manifest(): unknown | null {
    return this.#state.manifest
  }

  /** Replace the catalog entries (admin intake lands in Task 2; tests seed via this). */
  async replaceEntries(entries: readonly CatalogEntry[]): Promise<void> {
    const next = await this.#store.update(current => ({ ...current, entries: [...entries] }))
    this.#state = next
  }

  /** Store a signed manifest verbatim (no verification here — that is Task 2's activation gate). */
  async setManifest(manifest: unknown): Promise<void> {
    const next = await this.#store.update(current => ({ ...current, manifest }))
    this.#state = next
  }
}
