import assert from "node:assert/strict";
import { test } from "vitest";

import type { RunSummary, TaskInfo } from "../../src/client-huaanwork/logic/projects.ts";
import {
  dropRunningRunIds,
  isRunTabLive,
  runEndNeedsFailureNotice,
  runIdOfTab,
  runResultNoteText,
  runTabsToRebuild,
  sessionsToSuppressAfterDelete,
  settleRunningRuns,
} from "../../src/client-huaanwork/logic/runTabsLogic.ts";

function run(partial: Partial<RunSummary> & { runId: string; startedAt: number }): RunSummary {
  return { endedAt: partial.startedAt + 1000, ok: true, output: "", ...partial };
}

/** 运行子任务：来源字段三件套（automationId/runId/sessionId）与 Run 一致时才允许重建。 */
function task(partial: Partial<TaskInfo> & { id: string }): TaskInfo {
  return { projectId: "proj-1", name: "任务甲 · 200", createdAt: 1, ...partial };
}

const autoA = { id: "auto-a", name: "任务甲", projectId: "proj-1" };
const autoB = { id: "auto-b", name: "任务乙", projectId: null };

test("failure notices exclude user-cancelled runs", () => {
  assert.equal(runEndNeedsFailureNotice("error"), true);
  assert.equal(runEndNeedsFailureNotice("timeout"), true);
  assert.equal(runEndNeedsFailureNotice("cancelled"), false);
  assert.equal(runEndNeedsFailureNotice("ok"), false);
  assert.equal(runEndNeedsFailureNotice(undefined), false);
});

test("runTabsToRebuild: the newest run with a live task rebuilds one descriptor carrying the task's label and project", () => {
  const runs = {
    "auto-a": [
      run({ runId: "r1", startedAt: 100, sessionId: "sess-r1", taskId: "task-1" }),
      run({ runId: "r2", startedAt: 200, sessionId: "sess-r2", taskId: "task-2" }),
    ],
  };
  const tasks = [
    task({ id: "task-1", projectId: "proj-old", name: "任务甲 · 100", automationId: "auto-a", runId: "r1", sessionId: "sess-r1" }),
    task({ id: "task-2", projectId: "proj-old", name: "任务甲 · 200", automationId: "auto-a", runId: "r2", sessionId: "sess-r2" }),
  ];
  // 自动化当前项目（proj-1）与运行当时的项目（proj-old）不同：标签必须跟 Task。
  const result = runTabsToRebuild([autoA], runs, tasks, new Set());
  assert.deepEqual(result, [
    {
      tabId: "run-r2",
      automationId: "auto-a",
      runId: "r2",
      sessionId: "sess-r2",
      taskId: "task-2",
      label: "任务甲 · 200",
      projectId: "proj-old",
      ok: true,
    },
  ]);
});

test("runTabsToRebuild: runs whose task is legacy, deleted or mismatched never rebuild", () => {
  const legacy = run({ runId: "r-legacy", startedAt: 400, sessionId: "sess-legacy" });
  const deleted = run({ runId: "r-deleted", startedAt: 300, sessionId: "sess-deleted", taskId: "task-gone" });
  const mismatchedAutomation = run({ runId: "r-auto", startedAt: 200, sessionId: "sess-auto", taskId: "task-auto" });
  const mismatchedRun = run({ runId: "r-run", startedAt: 100, sessionId: "sess-run", taskId: "task-run" });
  const mismatchedSession = run({ runId: "r-session", startedAt: 50, sessionId: "sess-session", taskId: "task-session" });
  const runs = {
    "auto-a": [legacy, deleted, mismatchedAutomation, mismatchedRun, mismatchedSession],
  };
  const tasks = [
    task({ id: "task-auto", automationId: "auto-other", runId: "r-auto", sessionId: "sess-auto" }),
    task({ id: "task-run", automationId: "auto-a", runId: "r-other", sessionId: "sess-run" }),
    task({ id: "task-session", automationId: "auto-a", runId: "r-session", sessionId: "sess-other" }),
  ];
  assert.deepEqual(runTabsToRebuild([autoA], runs, tasks, new Set()), []);
});

test("runTabsToRebuild: a newer taskless run does not block an older task-backed run (order not trusted)", () => {
  const runs = {
    "auto-a": [
      run({ runId: "r-missed", startedAt: 300, status: "missed", ok: false }),
      run({ runId: "r-legacy", startedAt: 250, sessionId: "sess-legacy" }),
      run({ runId: "r-task", startedAt: 200, sessionId: "sess-task", taskId: "task-1" }),
    ],
  };
  const tasks = [
    task({ id: "task-1", automationId: "auto-a", runId: "r-task", sessionId: "sess-task" }),
  ];
  const result = runTabsToRebuild([autoA], runs, tasks, new Set());
  assert.equal(result.length, 1);
  assert.equal(result[0]?.runId, "r-task");
  assert.equal(result[0]?.taskId, "task-1");
});

test("runTabsToRebuild: existing tabId is skipped (live run-task tab or already-rebuilt skeleton)", () => {
  const runs = { "auto-a": [run({ runId: "r2", startedAt: 200, sessionId: "sess-r2", taskId: "task-1" })] };
  const tasks = [task({ id: "task-1", automationId: "auto-a", runId: "r2", sessionId: "sess-r2" })];
  assert.deepEqual(runTabsToRebuild([autoA], runs, tasks, new Set(["run-r2"])), []);
});

test("runTabsToRebuild: orphan runs of a deleted automation are skipped", () => {
  const runs = { "auto-gone": [run({ runId: "r1", startedAt: 100, sessionId: "sess-r1", taskId: "task-1" })] };
  const tasks = [task({ id: "task-1", automationId: "auto-gone", runId: "r1", sessionId: "sess-r1" })];
  assert.deepEqual(runTabsToRebuild([autoA], runs, tasks, new Set()), []);
});

test("runTabsToRebuild: status passes through and multiple automations each rebuild from their own task", () => {
  const runs = {
    "auto-a": [run({ runId: "ra", startedAt: 100, sessionId: "sess-a", taskId: "task-a", status: "timeout", ok: false })],
    "auto-b": [run({ runId: "rb", startedAt: 200, sessionId: "sess-b", taskId: "task-b" })],
  };
  const autoNoProject = { id: "auto-b", name: "任务乙" };
  const tasks = [
    task({ id: "task-a", projectId: "proj-1", automationId: "auto-a", runId: "ra", sessionId: "sess-a" }),
    task({ id: "task-b", projectId: "proj-2", name: "任务乙 · 200", automationId: "auto-b", runId: "rb", sessionId: "sess-b" }),
  ];
  const result = runTabsToRebuild([autoA, autoNoProject], runs, tasks, new Set());
  assert.equal(result.length, 2);
  assert.equal(result[0]?.status, "timeout");
  assert.equal(result[0]?.ok, false);
  assert.equal(result[1]?.taskId, "task-b");
  assert.equal(result[1]?.projectId, "proj-2");
  assert.equal(result[1]?.label, "任务乙 · 200");
  assert.equal(result[1]?.status, undefined);
});

test("runTabsToRebuild: empty inputs yield nothing", () => {
  assert.deepEqual(runTabsToRebuild([], {}, [], new Set()), []);
  assert.deepEqual(runTabsToRebuild([autoA, autoB], {}, [], new Set()), []);
  // 首批 tasks 快照未加载时列表为空：没有 Task 就没有可重建的运行标签。
  const runs = { "auto-a": [run({ runId: "r1", startedAt: 100, sessionId: "sess-r1", taskId: "task-1" })] };
  assert.deepEqual(runTabsToRebuild([autoA], runs, [], new Set()), []);
});

test("runTabsToRebuild: suppressing the newest session skips the task instead of rebuilding an older run", () => {
  const runs = {
    "auto-a": [
      run({ runId: "r-new", startedAt: 200, sessionId: "sess-new", taskId: "task-new" }),
      run({ runId: "r-old", startedAt: 100, sessionId: "sess-old", taskId: "task-old" }),
    ],
  };
  const tasks = [
    task({ id: "task-new", automationId: "auto-a", runId: "r-new", sessionId: "sess-new" }),
    task({ id: "task-old", automationId: "auto-a", runId: "r-old", sessionId: "sess-old" }),
  ];
  // 最新一条被抑制（刚被删掉）：整个任务不重建，绝不回退到 r-old。
  assert.deepEqual(runTabsToRebuild([autoA], runs, tasks, new Set(), new Set(["sess-new"])), []);
  // 抑制的只是更早的那条：最新一条照常重建。
  assert.equal(runTabsToRebuild([autoA], runs, tasks, new Set(), new Set(["sess-old"]))[0]?.runId, "r-new");
  // 无抑制时仍是旧行为。
  assert.equal(runTabsToRebuild([autoA], runs, tasks, new Set())[0]?.runId, "r-new");
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
