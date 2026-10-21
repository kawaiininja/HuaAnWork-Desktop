import assert from "node:assert/strict";
import { test } from "vitest";

import type { RunSummary } from "../../src/client-huaanwork/logic/projects.ts";
import { isRunTabLive, runResultNoteText, runTabsToRebuild } from "../../src/client-huaanwork/logic/runTabsLogic.ts";

function run(partial: Partial<RunSummary> & { runId: string; startedAt: number }): RunSummary {
  return { endedAt: partial.startedAt + 1000, ok: true, output: "", ...partial };
}

const autoA = { id: "auto-a", name: "任务甲", projectId: "proj-1" };
const autoB = { id: "auto-b", name: "任务乙", projectId: null };

test("runTabsToRebuild: latest run with sessionId rebuilds one descriptor", () => {
  const runs = {
    "auto-a": [
      run({ runId: "r1", startedAt: 100, sessionId: "sess-r1" }),
      run({ runId: "r2", startedAt: 200, sessionId: "sess-r2" }),
    ],
  };
  const result = runTabsToRebuild([autoA], runs, new Set());
  assert.deepEqual(result, [
    {
      tabId: "run-r2",
      automationId: "auto-a",
      runId: "r2",
      sessionId: "sess-r2",
      label: "任务甲",
      projectId: "proj-1",
      ok: true,
    },
  ]);
});

test("runTabsToRebuild: latest run without sessionId falls back to the most recent one that has it (order not trusted)", () => {
  const runs = {
    // 列表顺序故意打乱：startedAt 排序判定，不信任返回顺序。
    "auto-a": [
      run({ runId: "r-old", startedAt: 100, sessionId: "sess-old" }),
      run({ runId: "r-missed", startedAt: 300, status: "missed", ok: false }),
      run({ runId: "r-mid", startedAt: 200, sessionId: "sess-mid" }),
    ],
  };
  const result = runTabsToRebuild([autoA], runs, new Set());
  assert.equal(result.length, 1);
  assert.equal(result[0]?.runId, "r-mid");
  assert.equal(result[0]?.sessionId, "sess-mid");
});

test("runTabsToRebuild: no run with sessionId yields nothing; empty sessionId counts as missing", () => {
  const runs = {
    "auto-a": [run({ runId: "r1", startedAt: 100 }), run({ runId: "r2", startedAt: 200, sessionId: "" })],
  };
  assert.deepEqual(runTabsToRebuild([autoA], runs, new Set()), []);
});

test("runTabsToRebuild: existing tabId is skipped (live run-start tab or already-rebuilt skeleton)", () => {
  const runs = { "auto-a": [run({ runId: "r2", startedAt: 200, sessionId: "sess-r2" })] };
  assert.deepEqual(runTabsToRebuild([autoA], runs, new Set(["run-r2"])), []);
});

test("runTabsToRebuild: orphan runs of a deleted automation are skipped", () => {
  const runs = { "auto-gone": [run({ runId: "r1", startedAt: 100, sessionId: "sess-r1" })] };
  assert.deepEqual(runTabsToRebuild([autoA], runs, new Set()), []);
});

test("runTabsToRebuild: null/absent projectId becomes null; multiple automations each rebuild", () => {
  const runs = {
    "auto-a": [run({ runId: "ra", startedAt: 100, sessionId: "sess-a", status: "timeout", ok: false })],
    "auto-b": [run({ runId: "rb", startedAt: 200, sessionId: "sess-b" })],
  };
  const autoNoProject = { id: "auto-b", name: "任务乙" };
  const result = runTabsToRebuild([autoA, autoNoProject], runs, new Set());
  assert.equal(result.length, 2);
  assert.equal(result[0]?.projectId, "proj-1");
  assert.equal(result[0]?.status, "timeout");
  assert.equal(result[0]?.ok, false);
  assert.equal(result[1]?.projectId, null);
  assert.equal(result[1]?.status, undefined);
});

test("runTabsToRebuild: empty inputs yield nothing", () => {
  assert.deepEqual(runTabsToRebuild([], {}, new Set()), []);
  assert.deepEqual(runTabsToRebuild([autoA, autoB], {}, new Set()), []);
});

test("runTabsToRebuild: suppressing the newest session skips the task instead of rebuilding an older run", () => {
  const runs = {
    "auto-a": [
      run({ runId: "r-new", startedAt: 200, sessionId: "sess-new" }),
      run({ runId: "r-old", startedAt: 100, sessionId: "sess-old" }),
    ],
  };
  // 最新一条被抑制（刚被删掉）：整个任务不重建，绝不回退到 r-old。
  assert.deepEqual(runTabsToRebuild([autoA], runs, new Set(), new Set(["sess-new"])), []);
  // 抑制的只是更早的那条：最新一条照常重建。
  assert.equal(runTabsToRebuild([autoA], runs, new Set(), new Set(["sess-old"])).length, 1);
  assert.equal(runTabsToRebuild([autoA], runs, new Set(), new Set(["sess-old"]))[0]?.runId, "r-new");
  // 无抑制时仍是旧行为。
  assert.equal(runTabsToRebuild([autoA], runs, new Set())[0]?.runId, "r-new");
});

test("isRunTabLive: only a run- tab whose runId is live counts", () => {
  const live = new Set(["new"]);
  assert.equal(isRunTabLive("run-new", live), true);
  assert.equal(isRunTabLive("run-old", live), false);
  assert.equal(isRunTabLive("run-", live), false);
  assert.equal(isRunTabLive("work-1", live), false);
  assert.equal(isRunTabLive("run-", new Set([""])), false);
});

test("runResultNoteText: exact footer strings (single source for run-end handler and rebuild backfill)", () => {
  assert.equal(runResultNoteText("timeout"), "自动化运行超时");
  assert.equal(runResultNoteText("cancelled"), "自动化运行已取消");
  assert.equal(runResultNoteText("error"), "自动化运行失败");
  assert.equal(runResultNoteText("missed"), "自动化运行失败");
  assert.equal(runResultNoteText("ok"), "自动化运行完成");
  assert.equal(runResultNoteText(undefined), "自动化运行完成");
});
