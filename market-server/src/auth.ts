/**
 * Admin bearer-token authentication (Task 2 Step 3, review D5).
 *
 * Fail-closed at both ends:
 *   - NO token configured (`MARKET_SERVER_ADMIN_TOKEN` unset/empty): the
 *     admin surface is ENTIRELY DISABLED — every admin endpoint answers 401
 *     `admin-disabled` with operator guidance. Nothing mutating is reachable.
 *   - Wrong or missing Authorization header on a configured server: 401
 *     `unauthorized`. Comparison is length-checked `timingSafeEqual`.
 *
 * The token travels only as `Authorization: Bearer <token>` over the
 * operator's channel; it is never echoed back or logged.
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { MarketServerConfig } from './config.ts'

export type AdminAuthVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'admin-disabled' | 'unauthorized'; readonly message: string }

export function authenticateAdmin(request: IncomingMessage, config: MarketServerConfig): AdminAuthVerdict {
  if (config.adminToken === null) {
    return {
      ok: false,
      code: 'admin-disabled',
      message:
        'the admin surface is disabled: MARKET_SERVER_ADMIN_TOKEN is not configured. ' +
        'Set a strong random token and restart to enable publishing.',
    }
  }
  const header = request.headers.authorization
  if (header === undefined || !header.startsWith('Bearer ')) {
    return { ok: false, code: 'unauthorized', message: 'missing bearer token' }
  }
  const presented = header.slice('Bearer '.length).trim()
  const expected = config.adminToken
  const presentedBytes = Buffer.from(presented)
  const expectedBytes = Buffer.from(expected)
  if (presentedBytes.length !== expectedBytes.length || !timingSafeEqual(presentedBytes, expectedBytes)) {
    return { ok: false, code: 'unauthorized', message: 'invalid bearer token' }
  }
  return { ok: true }
}
