import { expect, test } from "vitest";

import {
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
