import type { RunSummary, TaskInfo } from "./projects.ts";

/**
 * 重启后运行对话标签（run tab）的重建判定（纯函数，便于单测）。
 *
 * 背景：run tab 只由实时 automation/run-task 事件创建进内存 chatTabs，重启即消失；
 * 但运行历史（automations/<id>.runs.jsonl）、运行子任务与运行会话日志都在磁盘上。
 * 这里从 automation.list 返回的 runs（每任务最近 5 条）挑出需要重建骨架标签的描述符，
 * 内容在用户首次打开标签时懒加载（session.open + historyToChatItems）。
 */

export type RunTabDescriptor = {
  /** 与实时 run-task 创建的标签同一去重键：`run-<runId>`。 */
  tabId: string;
  automationId: string;
  runId: string;
  /** 该运行创建的运行子任务 id（重建的唯一依据，规格 §7.2）。 */
  taskId: string;
  sessionId: string;
  /** 任务名取 Task.name（运行当时的日期任务名，不是自动化当前名称）。 */
  label: string;
  /** 归属项目取 Task.projectId（自动化改绑后旧运行仍回旧项目）。 */
  projectId: string | null;
  status?: RunSummary["status"];
  ok: boolean;
};

type AutomationLike = { id: string };

/** Run 的关联字段三件套与 Task 一致：该 Task 才能证明这条运行的历史归属。 */
function taskOfRun(run: RunSummary, automationId: string, tasks: readonly TaskInfo[]): TaskInfo | undefined {
  if (!run.taskId) return undefined;
  const task = tasks.find((item) => item.id === run.taskId);
  if (!task || !task.sessionId) return undefined;
  if (task.automationId !== automationId || task.runId !== run.runId) return undefined;
  if (task.sessionId !== run.sessionId) return undefined;
  return task;
}

/**
 * 每个任务取 startedAt 最新的、taskId 能解析到现存 Task 的运行各重建一个骨架（只取
 * 最近一个，避免侧栏被历史运行刷屏；更早的运行仍走任务中心「运行记录」下钻）。
 * 只接受「Run.taskId 能解析且 automation/run/session 一致」的运行：旧无 taskId、
 * 已删 Task、已 prune Task 都不重建（规格 §7.2）。
 * 跳过：已存在的标签（实时 run-task 标签或已重建骨架，同 id 键去重）、
 * automationRuns 里残留但已从注册表删除的任务，以及 `suppressedSessionIds` 命中的运行。
 *
 * 抑制集合是 session 内存（重启即清空）：删掉一条运行记录后，它的会话不该被
 * 重建回骨架标签。命中最新一条时必须整任务跳过，不能回退到更早的运行——那会
 * 凭空造出一个用户没在看的旧标签。
 */
export function runTabsToRebuild(
  automations: readonly AutomationLike[],
  automationRuns: Record<string, RunSummary[]>,
  tasks: readonly TaskInfo[],
  existingTabIds: ReadonlySet<string>,
  suppressedSessionIds: ReadonlySet<string> = new Set(),
): RunTabDescriptor[] {
  const descriptors: RunTabDescriptor[] = [];
  for (const automation of automations) {
    const runs = automationRuns[automation.id];
    if (!Array.isArray(runs) || runs.length === 0) continue;
    const candidates = runs
      .filter((run) => typeof run.sessionId === "string" && run.sessionId !== "")
      .sort((a, b) => b.startedAt - a.startedAt)
      .flatMap((run) => {
        const task = taskOfRun(run, automation.id, tasks);
        return task ? [{ run, task }] : [];
      });
    const latest = candidates[0];
    if (!latest) continue;
    if (suppressedSessionIds.has(latest.run.sessionId as string)) continue;
    const tabId = `run-${latest.run.runId}`;
    if (existingTabIds.has(tabId)) continue;
    descriptors.push({
      tabId,
      automationId: automation.id,
      runId: latest.run.runId,
      taskId: latest.task.id,
      sessionId: latest.run.sessionId as string,
      label: latest.task.name,
      projectId: latest.task.projectId,
      ...(latest.run.status === undefined ? {} : { status: latest.run.status }),
      ok: latest.run.ok,
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

/** 只有失败/超时才发系统失败通知；用户主动取消不是失败，别再弹失败通知。 */
export function runEndNeedsFailureNotice(status: RunSummary["status"] | undefined): boolean {
  return status === "error" || status === "timeout";
}

/** `run-<runId>` 标签的运行 id；非运行标签返回 undefined。 */
export function runIdOfTab(tabId: string): string | undefined {
  const prefix = "run-";
  if (!tabId.startsWith(prefix)) return undefined;
  const runId = tabId.slice(prefix.length);
  return runId.length > 0 ? runId : undefined;
}

/**
 * 运行对话标签是否仍在跑（纯函数）。
 *
 * 在途状态按 runId 记账：同一任务的 run N 进行中时，run N-1 的标签不再算 live，
 * 否则旧标签会显示「停止」并把最新一轮停掉。标签 id 与 run-task 的去重键一致，
 * 都是 `run-<runId>`；非运行标签（默认对话 / Work 会话）恒为 false。
 */
export function isRunTabLive(tabId: string, runningRunIds: ReadonlySet<string>): boolean {
  const runId = runIdOfTab(tabId);
  return runId !== undefined && runningRunIds.has(runId);
}

/**
 * 刷新任务快照时对账在途表：运行记录出现即表示该轮已经落盘，客户端不应再把它
 * 当成在途（覆盖丢失 run-end / host 重启后 stop 返回 stopped:false 的场景）。
 * 返回原 Map 表示没有变化，避免无意义的状态更新。
 */
export function settleRunningRuns<T>(
  running: ReadonlyMap<string, T>,
  runs: Readonly<Record<string, readonly { runId: string }[]>>,
): ReadonlyMap<string, T> {
  if (running.size === 0) return running;
  const settled = new Set<string>();
  for (const list of Object.values(runs)) {
    for (const run of list) settled.add(run.runId);
  }
  if (settled.size === 0) return running;
  let changed = false;
  const next = new Map(running);
  for (const runId of next.keys()) {
    if (!settled.has(runId)) continue;
    next.delete(runId);
    changed = true;
  }
  return changed ? next : running;
}

/**
 * 删除一条运行后要抑制重建的会话：被删会话及其更早的运行。
 * 不能连更新的运行一起抑制，否则刷新时会挡住最新运行的合法重建。
 */
export function sessionsToSuppressAfterDelete(
  runs: readonly { startedAt: number; sessionId?: string }[],
  deletedSessionId: string,
  deletedStartedAt: number,
): string[] {
  const result = new Set<string>();
  if (deletedSessionId) result.add(deletedSessionId);
  for (const run of runs) {
    if (typeof run.sessionId === "string" && run.sessionId && run.startedAt <= deletedStartedAt) {
      result.add(run.sessionId);
    }
  }
  return [...result];
}

/**
 * 停止调用返回 stopped:false 时，只摘掉调用前快照里的 runId。
 * 不能按 automationId 清空：调用在飞期间可能已经开了新一轮。
 */
export function dropRunningRunIds<T>(
  running: ReadonlyMap<string, T>,
  runIds: readonly string[],
): ReadonlyMap<string, T> {
  if (running.size === 0 || runIds.length === 0) return running;
  let changed = false;
  const next = new Map(running);
  for (const runId of runIds) {
    if (next.delete(runId)) changed = true;
  }
  return changed ? next : running;
}
