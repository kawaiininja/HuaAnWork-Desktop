import type { AutomationInfo, RunSummary, TaskInfo } from "./projects.ts";
import { closeRunTabsForSession } from "./chatTabs.ts";

/**
 * 运行记录跳转与失效运行标签对账（纯函数，便于单测）。
 *
 * 规格 §8：运行记录的可见目标由「该 Run 创建的运行子任务」决定，不能拿自动化
 * 当前绑定的 projectId 猜——自动化改绑后，旧 Run 必须打开旧项目里的历史 Task。
 * 三种结果：可跳到 Task（复用子任务选择流程）、只能只读打开的旧会话、不可点并
 * 给出原因（script / missed / Task 已删除或 prune / 关联字段不一致）。
 */

export type AutomationRunNavigation =
  | { kind: "task"; task: TaskInfo }
  | { kind: "legacy"; sessionId: string }
  | { kind: "unavailable"; reason: string }

const TASK_GONE = "对应子任务或会话已删除/清理";
const SESSION_MISMATCH = "运行与子任务会话关联不一致";

export function resolveAutomationRunNavigation(
  automation: AutomationInfo,
  run: RunSummary,
  tasks: readonly TaskInfo[],
): AutomationRunNavigation {
  if (run.taskId) {
    const task = tasks.find((item) => item.id === run.taskId);
    if (!task || task.automationId !== automation.id || task.runId !== run.runId || !task.sessionId) {
      return { kind: "unavailable", reason: TASK_GONE };
    }
    if (run.sessionId && task.sessionId !== run.sessionId) {
      return { kind: "unavailable", reason: SESSION_MISMATCH };
    }
    return { kind: "task", task };
  }
  if (run.sessionId) return { kind: "legacy", sessionId: run.sessionId };
  return { kind: "unavailable", reason: automation.kind === "script" ? "脚本运行无会话" : "该运行未建立子任务会话" };
}

/**
 * 权威 tasks 快照里找不到的自动化运行标签（规格 §7.2 / §8.8）。
 *
 * 只认同时带 automationId 与 taskId 的标签：旧版无 taskId 的运行标签不据此关闭
 * （它们没有可对账的关联），普通对话/子任务标签永不在此列。调用方必须等首次
 * `task.list` 成功后才用空快照调用——启动并发时的空列表不是删除证据。
 */
export function staleAutomationRunTabs<T extends { automationId?: string; taskId?: string }>(
  tabs: readonly T[],
  tasks: readonly TaskInfo[],
): T[] {
  const alive = new Set(tasks.map((task) => task.id));
  return tabs.filter((tab) => tab.automationId && tab.taskId && !alive.has(tab.taskId));
}

/**
 * App 失效运行标签对账的整段合成：多张失效标签逐张走 {@link closeRunTabsForSession}。
 *
 * 关闭范围与 active 选择规则完全复用 `closeRunTabsForSession`（不另写一份）：每关一张
 * 都可能改选 active，所以必须把上一次的结果喂给下一次，而不是对原始列表重复计算。
 * 没有失效标签（或失效标签都没有 sessionId）时原样返回输入数组与 activeId —— 引用相等，
 * 调用方据此跳过 setState。缺 sessionId 的骨架不在此列：运行标签恒带 sessionId
 * （run-task / 重建都要求会话），没有会话的骨架无从对账。
 */
export function reconcileStaleAutomationTabs<
  T extends { id: string; automationId?: string; taskId?: string; sessionId?: string },
>(
  tabs: readonly T[],
  tasks: readonly TaskInfo[],
  activeId: string,
): { tabs: T[]; nextActiveId: string } {
  let current = tabs as T[];
  let nextActiveId = activeId;
  for (const stale of staleAutomationRunTabs(tabs, tasks)) {
    if (!stale.sessionId) continue;
    const result = closeRunTabsForSession(current, stale.sessionId, nextActiveId);
    current = result.tabs;
    nextActiveId = result.nextActiveId;
  }
  // closeRunTabsForSession 未命中时原引用返回，故引用相等即「没有任何标签被关」。
  if (current === tabs) return { tabs: current, nextActiveId: activeId };
  return { tabs: current, nextActiveId };
}
