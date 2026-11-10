import { expect, test } from "vitest";

import {
  reconcileStaleAutomationTabs,
  resolveAutomationRunNavigation,
  staleAutomationRunTabs,
} from "../../src/client-huaanwork/logic/automationRunLink.ts";
import type { AutomationInfo, RunSummary, TaskInfo } from "../../src/client-huaanwork/logic/projects.ts";

const AUTOMATION: AutomationInfo = {
  id: "auto-1",
  projectId: "old-project",
  name: "任务",
  kind: "agent",
  schedule: { kind: "manual" },
  prompt: "执行",
  enabled: true,
  createdAt: 1,
};

const RUN: RunSummary = {
  runId: "r1",
  startedAt: 1000,
  endedAt: 1100,
  ok: true,
  output: "done",
  status: "ok",
  sessionId: "s1",
};

function task(partial: Partial<TaskInfo> & { id: string }): TaskInfo {
  return { projectId: "old-project", name: "任务 · 2026-11-09 10:00:00", createdAt: 1000, ...partial };
}

test("run navigation uses the historical task, not current automation project", () => {
  const automation = { ...AUTOMATION, projectId: "new-project" };
  const historical = task({
    id: "task-1",
    projectId: "old-project",
    automationId: automation.id,
    runId: "r1",
    sessionId: "s1",
  });
  expect(resolveAutomationRunNavigation(automation, { ...RUN, taskId: "task-1" }, [historical]))
    .toEqual({ kind: "task", task: historical });
  expect(resolveAutomationRunNavigation(automation, { ...RUN, taskId: "missing" }, []))
    .toEqual({ kind: "unavailable", reason: "对应子任务或会话已删除/清理" });
  expect(resolveAutomationRunNavigation(automation, RUN, []))
    .toEqual({ kind: "legacy", sessionId: "s1" });
});

test("run navigation rejects a task whose origin fields do not match the run", () => {
  const automation = AUTOMATION;
  const mismatchedAutomation = task({ id: "task-1", automationId: "auto-other", runId: "r1", sessionId: "s1" });
  const mismatchedRun = task({ id: "task-1", automationId: automation.id, runId: "r2", sessionId: "s1" });
  const withoutSession = task({ id: "task-1", automationId: automation.id, runId: "r1" });
  // 自动化当前项目已改绑也不影响：Task 才是历史关联的证据。
  const otherProject = task({
    id: "task-1",
    projectId: "old-project",
    automationId: automation.id,
    runId: "r1",
    sessionId: "s1",
  });
  expect(resolveAutomationRunNavigation(automation, { ...RUN, taskId: "task-1" }, [mismatchedAutomation]))
    .toEqual({ kind: "unavailable", reason: "对应子任务或会话已删除/清理" });
  expect(resolveAutomationRunNavigation(automation, { ...RUN, taskId: "task-1" }, [mismatchedRun]))
    .toEqual({ kind: "unavailable", reason: "对应子任务或会话已删除/清理" });
  expect(resolveAutomationRunNavigation(automation, { ...RUN, taskId: "task-1" }, [withoutSession]))
    .toEqual({ kind: "unavailable", reason: "对应子任务或会话已删除/清理" });
  expect(resolveAutomationRunNavigation({ ...automation, projectId: "new-project" }, { ...RUN, taskId: "task-1" }, [otherProject]))
    .toEqual({ kind: "task", task: otherProject });
});

test("run navigation never conflates a run and task that point at different sessions", () => {
  const linked = task({ id: "task-1", automationId: AUTOMATION.id, runId: "r1", sessionId: "s-other" });
  expect(resolveAutomationRunNavigation(AUTOMATION, { ...RUN, taskId: "task-1" }, [linked]))
    .toEqual({ kind: "unavailable", reason: "运行与子任务会话关联不一致" });
});

test("run navigation explains why a record without task or session is not clickable", () => {
  const { sessionId: _sessionId, ...sessionless } = RUN;
  expect(resolveAutomationRunNavigation(AUTOMATION, sessionless, []))
    .toEqual({ kind: "unavailable", reason: "该运行未建立子任务会话" });
  expect(resolveAutomationRunNavigation({ ...AUTOMATION, kind: "script" }, sessionless, []))
    .toEqual({ kind: "unavailable", reason: "脚本运行无会话" });
});

test("stale automation tabs close only after an authoritative task snapshot removes them", () => {
  const tabs = [
    { id: "run-r1", automationId: "auto-1", taskId: "task-1", sessionId: "s1" },
    { id: "work-1" },
  ];
  expect(staleAutomationRunTabs(tabs, [{ id: "task-1" } as TaskInfo])).toEqual([]);
  expect(staleAutomationRunTabs(tabs, [])).toEqual([tabs[0]]);
});

test("stale reconciliation ignores tabs that are not automation task tabs", () => {
  const tabs = [
    { id: "run-legacy", automationId: "auto-1", sessionId: "s1" },
    { id: "work-1", taskId: "task-1", sessionId: "s1" },
    { id: "run-stale", automationId: "auto-1", taskId: "task-gone", sessionId: "s2" },
  ];
  expect(staleAutomationRunTabs(tabs, [])).toEqual([tabs[2]]);
  // 空快照与「任务都还在」是两种输入：前者说明快照还没加载，调用方必须自己门控。
  expect(staleAutomationRunTabs([], [])).toEqual([]);
});

test("reconciliation leaves the tab list and selection untouched when nothing is stale", () => {
  const tabs = [
    { id: "run-r1", automationId: "auto-1", taskId: "task-1", sessionId: "s1" },
    { id: "work-1", sessionId: "s2" },
  ];
  const result = reconcileStaleAutomationTabs(tabs, [task({ id: "task-1" })], "work-1");
  // 引用相等：调用方据此跳过 setChatTabs（App effect 用 result.tabs === 输入 判空）。
  expect(result.tabs).toBe(tabs);
  expect(result.nextActiveId).toBe("work-1");
});

test("a single stale non-active tab closes without moving the selection", () => {
  const tabs = [
    { id: "run-r1", automationId: "auto-1", taskId: "task-gone", sessionId: "s1" },
    { id: "work-1", sessionId: "s2" },
  ];
  const result = reconcileStaleAutomationTabs(tabs, [], "work-1");
  expect(result.tabs).toEqual([tabs[1]]);
  expect(result.tabs).not.toBe(tabs);
  expect(result.nextActiveId).toBe("work-1");
});

test("multiple stale tabs all close and the survivor is chosen right-then-left", () => {
  const tabs = [
    { id: "run-r1", automationId: "auto-1", taskId: "gone-1", sessionId: "s1" },
    { id: "work-1", sessionId: "s2" },
    { id: "run-r2", automationId: "auto-1", taskId: "gone-2", sessionId: "s3" },
    { id: "work-2", sessionId: "s4" },
  ];
  // 当前标签是第二张失效标签：先向右取 work-2。
  const right = reconcileStaleAutomationTabs(tabs, [], "run-r2");
  expect(right.tabs.map((tab) => tab.id)).toEqual(["work-1", "work-2"]);
  expect(right.nextActiveId).toBe("work-2");

  // 当前标签在列表末尾：右边没有存活标签，退回左边最近的 work-1。
  const tailActive = [
    { id: "run-r1", automationId: "auto-1", taskId: "gone-1", sessionId: "s1" },
    { id: "work-1", sessionId: "s2" },
    { id: "run-r2", automationId: "auto-1", taskId: "gone-2", sessionId: "s3" },
  ];
  const left = reconcileStaleAutomationTabs(tailActive, [], "run-r2");
  expect(left.tabs.map((tab) => tab.id)).toEqual(["work-1"]);
  expect(left.nextActiveId).toBe("work-1");
});

test("a stale tab without a session id stays and never crashes the sweep", () => {
  const tabs = [
    { id: "run-skeleton", automationId: "auto-1", taskId: "gone-1" },
    { id: "run-r2", automationId: "auto-1", taskId: "gone-2", sessionId: "s3" },
    { id: "work-1", sessionId: "s4" },
  ];
  const result = reconcileStaleAutomationTabs(tabs, [], "work-1");
  // 没有 sessionId 的骨架不在关闭范围（与 closeRunTabsForSession 的判据一致），其余照常关闭。
  expect(result.tabs.map((tab) => tab.id)).toEqual(["run-skeleton", "work-1"]);
  expect(result.nextActiveId).toBe("work-1");
});
