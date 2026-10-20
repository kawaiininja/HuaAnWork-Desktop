/**
 * Every git probe here runs synchronously on the Host's main loop, and the Desktop
 * supervisor decides whether the Host is wedged by a 2 s `status` probe. A working
 * Host that spends seconds in `git diff` therefore looks dead. Give each snapshot
 * one liveness window and let it degrade instead of blocking the loop.
 */

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
  now: () => number = () => Date.now(),
): GitWorkBudget {
  const deadline = now() + totalMs;
  return {
    // spawnSync reads `timeout: 0` as "no timeout", so callers must skip a spent budget.
    remainingMs: () => Math.max(0, deadline - now()),
  };
}
