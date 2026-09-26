/**
 * Write-side contract validation for catalog entries (review D3).
 *
 * The upstream `parseCatalogProviderPage` validator used to run only on the
 * read side, so one contract-violating field (an over-long displayName, a
 * control character, a bad updatedAt) stored by publish/PATCH poisoned the
 * whole catalog: every provider page and every manifest prepare failed while
 * the write had answered 200. This helper validates an ASSEMBLED catalog
 * entry the same way the read side validates a full page — by building a
 * synthetic one-item provider page and running it through the upstream
 * validator (守则 2: no homegrown field list). Both publish and PATCH run it
 * inside the locked write, so a violating entry never reaches the state
 * document.
 */

import { CatalogContractError, parseCatalogProviderPage, type CatalogContractIssue } from 'dsh-community-market/contracts'
import { entryToItem } from './service.ts'
import type { CatalogEntry } from './store.ts'

const SCHEMA_VERSION = '1.0.0'

/** A stored catalog entry would violate the provider-page contract. */
export class EntryContractError extends Error {
  readonly issues: readonly CatalogContractIssue[]

  constructor(issues: readonly CatalogContractIssue[]) {
    super(`catalog entry violates the provider-page contract: ${formatContractIssues(issues)}`)
    this.name = 'EntryContractError'
    this.issues = issues
  }
}

/** Human-readable "path message; path message" listing of ajv issues. */
export function formatContractIssues(issues: readonly CatalogContractIssue[]): string {
  return issues.map(issue => `${issue.path} ${issue.message}`).join('; ')
}

/**
 * Validate one assembled catalog entry against the upstream provider-page
 * contract. Throws EntryContractError on violation; returns void otherwise.
 */
export function validateCatalogEntryContract(entry: CatalogEntry): void {
  const page: unknown = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    items: [entryToItem(entry)],
    page: { total: 1 },
  }
  // The effective-limit semantic check is a read-side query concern, not an
  // item-shape concern; a one-item page is validated without it (the read
  // side passes it explicitly, capped at 100 by the upstream helper).
  try {
    parseCatalogProviderPage(page)
  } catch (cause) {
    if (cause instanceof CatalogContractError) throw new EntryContractError(cause.issues)
    throw cause
  }
}
