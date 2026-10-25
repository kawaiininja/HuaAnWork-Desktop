/**
 * Three-role bearer authentication (Task 4).
 *
 * Roles are strictly separated by token:
 *
 *   read     browse the legacy catalog, published packages, bundles,
 *            revocations
 *   publish  submit packages, read YOUR OWN submission, request a delisting
 *   admin    pending lists, review bundles, approve/reject, delist approval,
 *            revoke
 *
 * A valid token with the wrong role answers 403 (`forbidden`). A missing or
 * unrecognized token answers 401 `{"error":"口令错误"}` — the M-A0 body, kept
 * identical so existing desktop clients keep working.
 *
 * Comparison hashes both sides with SHA-256 first (equal-length inputs) and
 * then uses `timingSafeEqual`; all three tokens are always compared so the
 * response time does not reveal which role matched (or how many bytes did).
 * The Authorization header is never logged; only the 12-hex actor prefix of
 * its SHA-256 reaches the audit log.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { AgentCatalogConfig } from './config.ts'

export type AgentCatalogRole = 'read' | 'publish' | 'admin'

/** Extract the bearer value exactly like the M-A0 service did (no trimming). */
export function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined
  return header.slice('Bearer '.length)
}

/**
 * The audit actor for a presented token: first 12 hex of SHA-256. A request
 * without a bearer value is `anonymous`. The raw token never leaves auth.
 */
export function tokenActor(token: string | undefined): string {
  if (token === undefined || token === '') return 'anonymous'
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12)
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected))
}

/**
 * Resolve the role of a presented token, or null when it matches none of the
 * three configured tokens. All comparisons run before the verdict.
 */
export function authenticateToken(
  config: AgentCatalogConfig,
  presented: string,
): AgentCatalogRole | null {
  const isRead = tokenMatches(presented, config.readToken)
  const isPublish = tokenMatches(presented, config.publishToken)
  const isAdmin = tokenMatches(presented, config.adminToken)
  // Config guarantees distinct tokens, so at most one flag is true.
  if (isAdmin) return 'admin'
  if (isPublish) return 'publish'
  if (isRead) return 'read'
  return null
}
