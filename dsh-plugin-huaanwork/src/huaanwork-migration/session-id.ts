/** Session-id re-minting for the one-time migration. */

import { sessionIdFor } from '../huaanwork-host/session-id.ts'

/** A root-derived session id: the fixed prefix plus exactly sixteen hex characters. */
export const NEUTRAL_ROOT_SESSION_ID = /^huaanwork-[0-9a-f]{16}$/u

export interface SessionIdRewritePlan {
  readonly oldNeutralId: string
  readonly newNeutralId: string
}

/**
 * Build the rewrite plan for one neutral-root move.
 *
 * Only the neutral root's digest changes: project-rooted sessions keep their
 * absolute cwd, and `huaanwork-auto-…` / `huaanwork-chat-…` ids cannot collide
 * with a root-derived id because "auto" and "chat" contain non-hexadecimal
 * characters. The shape assertion below turns that argument into an invariant.
 */
export function buildSessionIdRewritePlan(oldNeutralRoot: string, newNeutralRoot: string): SessionIdRewritePlan {
  const oldNeutralId = sessionIdFor(oldNeutralRoot)
  const newNeutralId = sessionIdFor(newNeutralRoot)
  if (!NEUTRAL_ROOT_SESSION_ID.test(oldNeutralId) || !NEUTRAL_ROOT_SESSION_ID.test(newNeutralId)) {
    throw new Error('sessionIdFor stopped producing a root-derived id shape')
  }
  return { oldNeutralId, newNeutralId }
}

/** Re-mint one session id, preserving a random task suffix and every non-neutral id. */
export function rewriteSessionId(id: string, plan: SessionIdRewritePlan): string {
  if (id === plan.oldNeutralId) return plan.newNeutralId
  const prefix = `${plan.oldNeutralId}-`
  if (id.startsWith(prefix)) return `${plan.newNeutralId}-${id.slice(prefix.length)}`
  return id
}
