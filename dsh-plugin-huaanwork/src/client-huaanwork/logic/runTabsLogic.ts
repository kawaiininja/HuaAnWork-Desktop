import type { RunSummary } from "./projects.ts";

/**
 * 重启后运行对话标签（run tab）的重建判定（纯函数，便于单测）。
 *
 * 背景：run tab 只由实时 automation/run-start 事件创建进内存 chatTabs，重启即消失；
 * 但运行历史（automations/<id>.runs.jsonl）与运行会话日志都在磁盘上。这里从
 * automation.list 返回的 runs（每任务最近 5 条）挑出需要重建骨架标签的描述符，
 * 内容在用户首次打开标签时懒加载（session.open + historyToChatItems）。
 */

export type RunTabDescriptor = {
  /** 与实时 run-start 创建的标签同一去重键：`run-<runId>`。 */
  tabId: string;
  automationId: string;
  runId: string;
  sessionId: string;
  /** 任务名（RunSummary 无 name 字段，只能取 automation 的）。 */
  label: string;
  projectId: string | null;
  status?: RunSummary["status"];
  ok: boolean;
};

type AutomationLike = { id: string; name: string; projectId?: string | null };

/**
 * 每个任务取 startedAt 最新的、带 sessionId 的运行各重建一个骨架（只取最近一个，
 * 避免侧栏被历史运行刷屏；更早的运行仍走任务中心「运行记录」下钻）。
 * 跳过：已存在的标签（实时 run-start 或已重建骨架，同 id 键去重）、
 * automationRuns 里残留但已从注册表删除的任务（拿不到 label）、以及
 * `suppressedSessionIds` 命中的运行。
 *
 * 抑制集合是 session 内存（重启即清空）：删掉一条运行记录后，它的会话不该被
 * 重建回骨架标签。命中最新一条时必须整任务跳过，不能回退到更早的运行——那会
 * 凭空造出一个用户没在看的旧标签。
 */
export function runTabsToRebuild(
  automations: readonly AutomationLike[],
  automationRuns: Record<string, RunSummary[]>,
  existingTabIds: ReadonlySet<string>,
  suppressedSessionIds: ReadonlySet<string> = new Set(),
): RunTabDescriptor[] {
  const descriptors: RunTabDescriptor[] = [];
  for (const automation of automations) {
    const runs = automationRuns[automation.id];
    if (!Array.isArray(runs) || runs.length === 0) continue;
    const withSession = runs
      .filter((run) => typeof run.sessionId === "string" && run.sessionId !== "")
      .sort((a, b) => b.startedAt - a.startedAt);
    const latest = withSession[0];
    if (!latest) continue;
    if (suppressedSessionIds.has(latest.sessionId as string)) continue;
    const tabId = `run-${latest.runId}`;
    if (existingTabIds.has(tabId)) continue;
    descriptors.push({
      tabId,
      automationId: automation.id,
      runId: latest.runId,
      sessionId: latest.sessionId as string,
      label: automation.name,
      projectId: automation.projectId ?? null,
      ...(latest.status === undefined ? {} : { status: latest.status }),
      ok: latest.ok,
    });
  }
  return descriptors;
}

/** 运行结果脚注文案：run-end 处理器与重建标签回填共用（单一来源，勿再内联第三份）。 */
export function runResultNoteText(status: RunSummary["status"] | undefined): string {
  if (status === "timeout") return "自动化运行超时";
  if (status === "cancelled") return "自动化运行已取消";
  if (status && status !== "ok") return "自动化运行失败";
  return "自动化运行完成";
}

/**
 * 运行对话标签是否仍在跑（纯函数）。
 *
 * 在途状态按 runId 记账：同一任务的 run N 进行中时，run N-1 的标签不再算 live，
 * 否则旧标签会显示「停止」并把最新一轮停掉。标签 id 与 run-start 的去重键一致，
 * 都是 `run-<runId>`；非运行标签（默认对话 / Work 会话）恒为 false。
 */
export function isRunTabLive(tabId: string, runningRunIds: ReadonlySet<string>): boolean {
  const prefix = "run-";
  if (!tabId.startsWith(prefix)) return false;
  const runId = tabId.slice(prefix.length);
  return runId.length > 0 && runningRunIds.has(runId);
}
