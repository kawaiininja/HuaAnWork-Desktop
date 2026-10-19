import assert from "node:assert/strict";
import { test } from "vitest";

import { apply } from "../../src/huaanwork-guardrails/limits.ts";

type Decision = { kind: string; reason?: string; exitCode?: number };
type PreExecute = (
  execution: { name: string; arguments: unknown; agent?: { cancel?: (reason: unknown) => void } },
  next: () => Promise<Decision>,
) => Promise<Decision>;

function createLimits() {
  const listeners: Record<string, unknown[]> = {};
  const cancelled: unknown[] = [];
  apply({
    on(event: string, listener: unknown) {
      listeners[event] = [...(listeners[event] ?? []), listener];
    },
  } as never);
  const preExecute = listeners["tools/pre-execute"]?.[0] as PreExecute;
  const agent = { cancel: (reason: unknown) => cancelled.push(reason) };
  const call = (name: string, args: unknown) =>
    preExecute({ name, arguments: args, agent }, async () => ({ kind: "allow" }));
  return { call, cancelled };
}

test("create_goal and update_goal reject max_goal_rounds above four", async () => {
  const { call, cancelled } = createLimits();
  for (const name of ["create_goal", "update_goal"]) {
    const decision = await call(name, { objective: "汇总报告", max_goal_rounds: 5 });
    assert.equal(decision.kind, "deny");
    assert.equal(decision.reason, "目标最多自动续 4 轮");
    assert.equal("exitCode" in decision, false);
  }
  assert.deepEqual(cancelled, [], "a rejected cap must not cancel the turn");
});

test("goal tools accept four rounds or no cap, and other tools ignore max_goal_rounds", async () => {
  const { call } = createLimits();
  assert.equal((await call("create_goal", { objective: "汇总报告", max_goal_rounds: 4 })).kind, "allow");
  assert.equal((await call("create_goal", { objective: "汇总报告" })).kind, "allow");
  assert.equal((await call("update_goal", { action: "pause", goal_id: "g", revision: 1 })).kind, "allow");
  assert.equal((await call("get_goal", {})).kind, "allow");
  assert.equal((await call("read", { path: "a.md", max_goal_rounds: 9 })).kind, "allow");
});
