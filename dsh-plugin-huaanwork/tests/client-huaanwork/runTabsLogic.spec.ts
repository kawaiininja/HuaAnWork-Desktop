import assert from "node:assert/strict";
import { test } from "vitest";

import type { RunSummary } from "../../src/client-huaanwork/logic/projects.ts";
import {
  dropRunningRunIds,
  isRunTabLive,
  runIdOfTab,
  runResultNoteText,
  runTabsToRebuild,
  sessionsToSuppressAfterDelete,
  settleRunningRuns,
} from "../../src/client-huaanwork/logic/runTabsLogic.ts";

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

test("runIdOfTab: extracts the run id only from run-<runId> tab ids", () => {
  assert.equal(runIdOfTab("run-abc"), "abc");
  assert.equal(runIdOfTab("run-"), undefined);
  assert.equal(runIdOfTab("work-1"), undefined);
});

test("settleRunningRuns: a run record appearing means that run is no longer live", () => {
  const running = new Map([
    ["r1", { automationId: "auto-a" }],
    ["r2", { automationId: "auto-a" }],
    ["r3", { automationId: "auto-b" }],
  ]);
  const settled = settleRunningRuns(running, {
    "auto-a": [run({ runId: "r2", startedAt: 200 })],
    "auto-b": [run({ runId: "other", startedAt: 300 })],
  });
  assert.deepEqual([...settled.keys()], ["r1", "r3"]);

  // 没有命中时返回同一个 Map，避免刷新触发无意义的状态更新。
  assert.equal(settleRunningRuns(running, {}), running);
  assert.equal(
    settleRunningRuns(running, { "auto-a": [run({ runId: "not-live", startedAt: 1 })] }),
    running,
  );
});

test("dropRunningRunIds: clears only the ids captured before the stop call", () => {
  const running = new Map([
    ["old-1", { automationId: "auto-a" }],
    ["old-2", { automationId: "auto-a" }],
    ["new", { automationId: "auto-a" }],
  ]);
  const next = dropRunningRunIds(running, ["old-1", "old-2"]);
  assert.deepEqual([...next.keys()], ["new"]);
  assert.equal(dropRunningRunIds(running, []), running);
  assert.equal(dropRunningRunIds(running, ["missing"]), running);
});

test("sessionsToSuppressAfterDelete: deleted run and earlier runs only, never newer ones", () => {
  const runs = [
    { startedAt: 100, sessionId: "s-old" },
    { startedAt: 200, sessionId: "s-deleted" },
    { startedAt: 250 },
    { startedAt: 300, sessionId: "s-new" },
  ];
  assert.deepEqual(
    sessionsToSuppressAfterDelete(runs, "s-deleted", 200).sort(),
    ["s-deleted", "s-old"],
  );
  assert.deepEqual(
    sessionsToSuppressAfterDelete(runs, "s-new", 300).sort(),
    ["s-deleted", "s-new", "s-old"],
  );
});

test("runResultNoteText: exact footer strings (single source for run-end handler and rebuild backfill)", () => {
  assert.equal(runResultNoteText("timeout"), "自动化运行超时");
  assert.equal(runResultNoteText("cancelled"), "自动化运行已取消");
  assert.equal(runResultNoteText("error"), "自动化运行失败");
  assert.equal(runResultNoteText("missed"), "自动化运行失败");
  assert.equal(runResultNoteText("ok"), "自动化运行完成");
  assert.equal(runResultNoteText(undefined), "自动化运行完成");
});
