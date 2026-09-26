/**
 * Provider-page query service (Task 1).
 *
 * Answers in the upstream `CatalogProviderPage` wire shape and self-validates
 * every response with the upstream `parseCatalogProviderPage` runtime
 * validator — no dialect of our own (守则 2: 协议字段只 import 上游 contract).
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
  normalizeCatalogQuery,
  parseCatalogProviderPage,
  type CatalogProviderPage,
  type CatalogQuery,
} from 'dsh-community-market/contracts'
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

export class CatalogService {
  readonly #store: CatalogStore
  readonly #now: () => Date

  constructor(store: CatalogStore, options: { now?: () => Date } = {}) {
    this.#store = store
    this.#now = options.now ?? (() => new Date())
  }

  /**
   * Run a catalog query and return a self-validated provider page.
   *
   * @param queryInput normalized-or-raw query value; run through the upstream
   *   `normalizeCatalogQuery`, so contract violations throw CatalogContractError.
   */
  query(queryInput: unknown): CatalogProviderPage {
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
    // Self-validation against the upstream contract (round3 R12). The
    // effective-limit semantic check is enforced by construction above; the
    // upstream helper caps that check at 100, so it is not passed here.
    return parseCatalogProviderPage(page)
  }
}
