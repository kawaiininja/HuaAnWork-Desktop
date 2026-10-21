import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createGitWorkBudget,
  GIT_SNAPSHOT_BUDGET_MS,
  GIT_SNAPSHOT_MAX_UNTRACKED_DIFFS,
} from "../../src/huaanwork-guardrails/git-budget.ts";

test("a git snapshot budget only shrinks and clamps at zero instead of blocking forever", () => {
  let now = 1_000;
  const budget = createGitWorkBudget(1_200, () => now);
  assert.equal(budget.remainingMs(), 1_200);
  now += 400;
  assert.equal(budget.remainingMs(), 800);
  now += 800;
  assert.equal(budget.remainingMs(), 0);
  now += 10_000;
  assert.equal(budget.remainingMs(), 0, "a spent budget must never go negative");
});

test("the default budget fits the two-second liveness window and the untracked cap is bounded", () => {
  let now = 0;
  const budget = createGitWorkBudget(undefined, () => now);
  assert.equal(budget.remainingMs(), GIT_SNAPSHOT_BUDGET_MS);
  assert.ok(GIT_SNAPSHOT_BUDGET_MS > 0 && GIT_SNAPSHOT_BUDGET_MS <= 1_500);
  assert.ok(GIT_SNAPSHOT_MAX_UNTRACKED_DIFFS > 0 && GIT_SNAPSHOT_MAX_UNTRACKED_DIFFS <= 20);
  now = GIT_SNAPSHOT_BUDGET_MS;
  assert.equal(budget.remainingMs(), 0);
});

test("a backwards clock step must not extend the budget", () => {
  let now = 10_000;
  const budget = createGitWorkBudget(1_000, () => now);
  now += 400;
  assert.equal(budget.remainingMs(), 600);
  // A wall-clock adjustment that moves backwards cannot hand out more than the
  // snapshot's original window.
  now -= 5_000;
  assert.equal(budget.remainingMs(), 1_000);
  now = 0;
  assert.equal(budget.remainingMs(), 1_000);
});
