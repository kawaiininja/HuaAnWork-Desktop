/**
 * Provider-page query service (Task 1).
 *
 * Answers in the upstream `CatalogProviderPage` wire shape and self-validates
 * every SERVED entry with the very validator the write path runs (the upstream
 * contract validator behind it) — no dialect of our own (守则 2: 协议字段只
 * import 上游 contract). A contract-violating stored entry is isolated and
 * reported per response instead of failing the whole catalog (D3 residual,
 * ruling D-M6-26; see `queryWithIsolation`).
 * The assembled page is then validated AS A WHOLE with the upstream
 * `parseCatalogProviderPage` (Task 6.7 fix round 1): the per-entry pass cannot
 * stand in for that, because entry rules are per item and do not cover the
 * page envelope — `$defs/page/nextCursor` is `maxLength: 2048`, and this
 * service's cursor is the base64url of the normalized query key, which a
 * legal-but-oversized query can exceed. That failure fails closed as a
 * request-level refusal (`CatalogPageEnvelopeError`), never as stored-state
 * corruption and never as a 200 whose payload violates the schema.
 * It never emits a `CatalogSnapshot`: Host provenance is forged by the
 * wrapper (Task 5), not by this server.
 *
 * Query semantics follow docs/catalog-provider-contract.md:
 *   - `q`           provider-defined matching: case-insensitive substring over
 *                   name / displayName / summary;
 *   - `category`    repeated values are an OR filter;
 *   - `capability`  the item must declare ALL requested capabilities;
 *   - `sort`        relevance = stable stored order; updated = updatedAt
 *                   descending (entries without updatedAt last); name =
 *                   displayName locale order; downloads = stored order
 *                   (this intranet source keeps no download statistics);
 *   - `cursor`      opaque base64url JSON {v, offset, queryKey}; a cursor
 *                   sent with a different effective query is rejected
 *                   (mirrors the upstream scoped-cursor rule).
 *
 * No catalog caching (round5 N8): every request re-runs over the current
 * state document.
 */

import {
  CatalogContractError,
  normalizeCatalogQuery,
  parseCatalogProviderPage,
  type CatalogContractIssue,
  type CatalogProviderPage,
  type CatalogQuery,
} from 'dsh-community-market/contracts'
// entry-contract.ts wraps the SAME upstream validator around a single entry
// (the write-side guard, review D3); the read side reuses it so one judgment
// covers both paths. The two modules import each other's functions, used at
// call time only (initialization-safe).
import { EntryContractError, formatContractIssues, validateCatalogEntryContract } from './entry-contract.ts'
import type { CatalogEntry, CatalogStore } from './store.ts'

export class CatalogQueryError extends Error {
  readonly code: 'invalid-cursor'

  constructor(code: 'invalid-cursor', message: string) {
    super(message)
    this.name = 'CatalogQueryError'
    this.code = code
  }
}

const SCHEMA_VERSION = '1.0.0'
const MAX_PAGE_ITEMS = 200

/**
 * The upstream page schema caps `page.nextCursor` at 2048 characters
 * (`dsh-community-market/docs/schemas/catalog-provider-page.schema.json` →
 * `$defs/page/nextCursor`). The cursor this service emits is the base64url of
 * the normalized effective query key, so a legal-but-large query can need a
 * longer one — see `CatalogPageEnvelopeError`.
 */
const MAX_NEXT_CURSOR_LENGTH = 2048

interface CursorBody {
  readonly v: 1
  readonly o: number
  readonly k: string
}

function encodeCursor(body: CursorBody): string {
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')
}

function decodeCursor(raw: string): CursorBody {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new CatalogQueryError('invalid-cursor', 'cursor is not decodable')
  }
  if (
    typeof parsed !== 'object' || parsed === null
    || (parsed as { v?: unknown }).v !== 1
    || !Number.isInteger((parsed as { o?: unknown }).o)
    || typeof (parsed as { k?: unknown }).k !== 'string'
  ) {
    throw new CatalogQueryError('invalid-cursor', 'cursor has an unsupported shape')
  }
  return parsed as unknown as CursorBody
}

function queryKey(query: CatalogQuery): string {
  const { cursor: _cursor, ...rest } = query
  return JSON.stringify(rest)
}

export function entryToItem(entry: CatalogEntry): Record<string, unknown> {
  const item: Record<string, unknown> = {
    id: entry.id,
    name: entry.packageName,
    displayName: entry.displayName,
    summary: entry.summary,
    package: { registry: 'npm', name: entry.packageName },
    latestVersion: entry.version,
  }
  if (entry.description !== undefined) item.description = entry.description
  if (entry.license !== undefined) item.license = entry.license
  if (entry.categories !== undefined && entry.categories.length > 0) item.categories = [...entry.categories]
  if (entry.keywords !== undefined && entry.keywords.length > 0) item.keywords = [...entry.keywords]
  if (entry.capabilities !== undefined && entry.capabilities.length > 0) {
    item.capabilities = { required: [...entry.capabilities] }
  }
  if (entry.updatedAt !== undefined) item.updatedAt = entry.updatedAt
  if (entry.homepage !== undefined && entry.homepage !== '') item.homepage = entry.homepage
  if (entry.publisherName !== undefined && entry.publisherName !== '') {
    const publisher: Record<string, unknown> = { name: entry.publisherName }
    if (entry.publisherUrl !== undefined && entry.publisherUrl !== '') publisher.url = entry.publisherUrl
    item.publisher = publisher
  }
  if (entry.repositoryUrl !== undefined && entry.repositoryUrl !== '') {
    item.repository = { url: entry.repositoryUrl }
  }
  return item
}

function matchesQuery(entry: CatalogEntry, query: CatalogQuery): boolean {
  if (query.q !== undefined) {
    const haystack = `${entry.packageName} ${entry.displayName} ${entry.summary}`.toLowerCase()
    if (!haystack.includes(query.q.toLowerCase())) return false
  }
  if (query.category !== undefined && query.category.length > 0) {
    const owned = new Set(entry.categories ?? [])
    if (!query.category.some(category => owned.has(category))) return false
  }
  if (query.capability !== undefined && query.capability.length > 0) {
    const owned = new Set(entry.capabilities ?? [])
    if (!query.capability.every(capability => owned.has(capability))) return false
  }
  return true
}

function compareUpdated(a: CatalogEntry, b: CatalogEntry): number {
  const aTime = a.updatedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(a.updatedAt)
  const bTime = b.updatedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(b.updatedAt)
  return bTime - aTime
}

/**
 * One stored entry that was kept out of a served page because it violates the
 * provider-page contract (ruling D-M6-26). The reachable cause is an operator
 * hand-editing the state file or restoring an old backup — every write path
 * validates in the locked write (review D3) — so the operator must be able to
 * see WHAT was isolated, not just that the list got shorter.
 */
export interface IsolatedCatalogEntry {
  /** Stored entry id (`name@version`) — what the state file and admin API key on. */
  readonly id: string
  /** Contract `name` (packageName) of the isolated entry. */
  readonly name: string
  /** The contract issues, rendered by `formatContractIssues` for the operator. */
  readonly reason: string
}

/** One catalog query's result: the served page plus what was isolated from it. */
export interface CatalogQueryResult {
  readonly page: CatalogProviderPage
  readonly isolated: readonly IsolatedCatalogEntry[]
}

/**
 * Fail-closed arm of the read-side isolation (ruling D-M6-26): EVERY entry the
 * query would have served violates the provider-page contract. Answering 200
 * with an empty page would tell clients the market is empty, so callers must
 * report this as the server-side data fault it is. Carries the per-entry report
 * so the caller can log it verbatim (and name the entries to the operator).
 */
export class InvalidStoredCatalogError extends Error {
  readonly isolated: readonly IsolatedCatalogEntry[]

  constructor(isolated: readonly IsolatedCatalogEntry[]) {
    super(
      `every catalog entry matching this query violates the provider-page contract (${String(isolated.length)} isolated); ` +
        'refusing to answer with an empty catalog as if the market were empty',
    )
    this.name = 'InvalidStoredCatalogError'
    this.isolated = isolated
  }
}

/**
 * The ASSEMBLED page failed the upstream WHOLE-page validation although every
 * served entry passed the per-entry validator — so no single stored entry is
 * at fault, and this must never be reported as stored-state corruption
 * (Task 6.7 fix round 1).
 *
 * The reachable cause is envelope/cursor-level: `page.nextCursor` is the
 * base64url of the normalized effective query key, and the upstream page
 * schema caps it at `MAX_NEXT_CURSOR_LENGTH` characters, which an
 * oversized-but-legal query can exceed (e.g. `q` at its 200-character bound
 * plus 20 long `category` values — the query schema permits both). The request
 * provokes it, so it fails closed as a request-level refusal: the service
 * refuses to serve a page the contract rejects instead of answering 200 with
 * a schema-violating payload.
 */
export class CatalogPageEnvelopeError extends Error {
  readonly issues: readonly CatalogContractIssue[]
  /** Isolation report of the refused query (D-M6-26: logged by callers, never silent). */
  readonly isolated: readonly IsolatedCatalogEntry[]
  /** True when the only fault is the contract's `page.nextCursor` length cap. */
  readonly cursorOverflow: boolean

  constructor(
    issues: readonly CatalogContractIssue[],
    isolated: readonly IsolatedCatalogEntry[],
    cursorLength: number | undefined,
  ) {
    const cursorOverflow = issues.length > 0 && issues.every(issue => issue.path === '/page/nextCursor')
    super(
      cursorOverflow
        ? 'the effective query is too large to paginate within the provider-page contract: page.nextCursor is the '
          + `base64url of the normalized query key and the contract caps it at ${String(MAX_NEXT_CURSOR_LENGTH)} characters, `
          + `but this query needs ${String(cursorLength ?? 0)}; narrow q/category/capability and retry (the stored catalog is not at fault)`
        : 'the assembled provider page failed the upstream whole-page contract validation although every served entry '
          + `passed the per-entry validator (${formatContractIssues(issues)}); refusing to serve a page the contract rejects`,
    )
    this.name = 'CatalogPageEnvelopeError'
    this.issues = issues
    this.isolated = isolated
    this.cursorOverflow = cursorOverflow
  }
}

export class CatalogService {
  readonly #store: CatalogStore
  readonly #now: () => Date

  constructor(store: CatalogStore, options: { now?: () => Date } = {}) {
    this.#store = store
    this.#now = options.now ?? (() => new Date())
  }

  /**
   * Run a catalog query and return the served page.
   *
   * Convenience wrapper for callers with no operator report to deliver: an
   * isolated entry is dropped from the page and only the caller who used
   * `queryWithIsolation` can tell the operator about it. HTTP surfaces must use
   * that method (ruling D-M6-26: isolation is never silent).
   *
   * @param queryInput normalized-or-raw query value; run through the upstream
   *   `normalizeCatalogQuery`, so contract violations throw CatalogContractError.
   */
  query(queryInput: unknown): CatalogProviderPage {
    return this.queryWithIsolation(queryInput).page
  }

  /**
   * Run a catalog query, isolating any candidate entry that violates the
   * provider-page contract (D3 residual, ruling D-M6-26).
   *
   * Isolation happens AFTER the effective query filter (only entries this
   * response would serve are judged, so the report describes the response) and
   * BEFORE pagination (so `page.total`, cursors and offsets all describe what
   * is actually served). If every matching entry is invalid the query fails
   * closed via InvalidStoredCatalogError rather than serving an empty page.
   * The assembled page then goes through the upstream WHOLE-page validator as
   * well (Task 6.7 fix round 1): a page the contract rejects — reachably, a
   * legal-but-oversized query whose cursor exceeds the 2048-char cap — fails
   * closed via CatalogPageEnvelopeError instead of being served.
   *
   * @param queryInput normalized-or-raw query value; run through the upstream
   *   `normalizeCatalogQuery`, so contract violations throw CatalogContractError.
   */
  queryWithIsolation(queryInput: unknown): CatalogQueryResult {
    const query = normalizeCatalogQuery(queryInput)
    const key = queryKey(query)
    const limit = Math.min(query.limit ?? 50, MAX_PAGE_ITEMS)

    let filtered = this.#store.entries().filter(entry => matchesQuery(entry, query))
    switch (query.sort) {
      case 'name':
        filtered = [...filtered].sort((a, b) => a.displayName.localeCompare(b.displayName))
        break
      case 'updated':
        filtered = [...filtered].sort(compareUpdated)
        break
      case 'relevance':
      case 'downloads':
      default:
        // Stored order is the relevance/downloads ranking (no local statistics).
        break
    }

    // Read-side per-entry validation (ruling D-M6-26): one hand-edited entry
    // must not take down the catalog, so each candidate is judged with the
    // single-entry validator the write path uses. A non-contract failure
    // (structural corruption) is NOT folded into "isolated": it stays
    // fail-closed, exactly as before this change.
    const isolated: IsolatedCatalogEntry[] = []
    const servable: CatalogEntry[] = []
    for (const entry of filtered) {
      try {
        validateCatalogEntryContract(entry)
        servable.push(entry)
      } catch (cause) {
        if (!(cause instanceof EntryContractError)) throw cause
        isolated.push({ id: entry.id, name: entry.packageName, reason: formatContractIssues(cause.issues) })
      }
    }
    if (servable.length === 0 && filtered.length > 0) throw new InvalidStoredCatalogError(isolated)
    filtered = servable

    let offset = 0
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor)
      if (cursor.k !== key) {
        throw new CatalogQueryError('invalid-cursor', 'cursor does not belong to this effective query')
      }
      offset = cursor.o
    }

    const pageItems = filtered.slice(offset, offset + limit).map(entryToItem)
    const nextOffset = offset + pageItems.length
    const pageInfo: Record<string, unknown> = { total: filtered.length }
    if (nextOffset < filtered.length) {
      pageInfo.nextCursor = encodeCursor({ v: 1, o: nextOffset, k: key })
    }

    const page: unknown = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: this.#now().toISOString(),
      items: pageItems,
      page: pageInfo,
    }

    // Whole-page validation, re-asserted AFTER the per-entry pass (Task 6.7
    // fix round 1). The per-entry pass is not a substitute for it: entry rules
    // are per item and say nothing about the envelope. It can no longer be
    // tripped by a poisoned entry (each item above just passed the very same
    // upstream validator in isolation), so what remains is envelope-level —
    // reachably `page.nextCursor` (maxLength 2048; ours is the base64url of
    // the normalized query key, which a legal-but-oversized query exceeds),
    // while id uniqueness, the validator's only cross-item rule, is enforced
    // by the store at load (catalog/store.ts parseState rejects duplicate ids).
    // A failure here is a request-level refusal (CatalogPageEnvelopeError),
    // deliberately NOT conflated with InvalidStoredCatalogError; the service
    // never answers 200 with a payload the contract rejects.
    // (The effective-limit semantic check stays a query concern: the upstream
    // helper caps that argument at 100 while this service admits limit up to
    // MAX_PAGE_ITEMS, so it is not passed here.)
    try {
      return { page: parseCatalogProviderPage(page), isolated }
    } catch (cause) {
      if (cause instanceof CatalogContractError) {
        const cursorLength = typeof pageInfo.nextCursor === 'string' ? pageInfo.nextCursor.length : undefined
        throw new CatalogPageEnvelopeError(cause.issues, isolated, cursorLength)
      }
      throw cause
    }
  }
}
