/**
 * Every git probe here runs synchronously on the Host's main loop, and the Desktop
 * supervisor decides whether the Host is wedged by a 2 s `status` probe. A working
 * Host that spends seconds in `git diff` therefore looks dead. Give each snapshot
 * one liveness window and let it degrade instead of blocking the loop.
 *
 * The budget is per snapshot. Concurrent sessions can each spend one window on the
 * same loop, so stacking is still possible; a global coalescing throttle across
 * concurrent snapshots is a follow-up, not part of this per-snapshot bound.
 */

import { performance } from "node:perf_hooks";

/** Longest a synchronous git snapshot may hold the event loop (the liveness probe is every 2 s). */
export const GIT_SNAPSHOT_BUDGET_MS = 1_500;

/** Most untracked files one snapshot renders; a bigger tree keeps the tracked diff only. */
export const GIT_SNAPSHOT_MAX_UNTRACKED_DIFFS = 20;

export type GitWorkBudget = {
  /** Milliseconds left for the next blocking call; 0 means the snapshot must stop. */
  remainingMs(): number;
};

export function createGitWorkBudget(
  totalMs = GIT_SNAPSHOT_BUDGET_MS,
  // Monotonic: a wall-clock step backwards must not hand a snapshot a longer window.
  now: () => number = () => performance.now(),
): GitWorkBudget {
  const deadline = now() + totalMs;
  return {
    // spawnSync reads `timeout: 0` as "no timeout", so callers must skip a spent budget.
    // Clamp at the configured total too: a backward clock step would otherwise make
    // `deadline - now()` exceed the original budget.
    remainingMs: () => Math.max(0, Math.min(totalMs, deadline - now())),
  };
}
