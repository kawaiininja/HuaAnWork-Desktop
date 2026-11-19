import type { TodoEntry, TodoStatus } from "@huaanwork/policy/todo";

import { isSubagentRunActive, type SubagentRunView } from "./subagentRuns.ts";
import {
  currentTurnStart,
  type ToolPanelItem,
  type ToolPanelRow,
  type ToolPanelView,
} from "./toolPanel.ts";

/**
 * 右栏「进度」的纯投影：当前回合的分步任务、工具活动与受管子代理运行。
 *
 * 输入是 `App.tsx` 已有的消息条目、工具面板行、回合终态、连接状态与 run 列表；
 * 输出只供展示，不回写任何输入。任务没有单步百分比：只有 `completed/total` 与
 * 展示状态；`in_progress` 在回合终结后叠加 `interrupted`，但原始数组保持不变。
 */

/** 当前回合的 `todo` 快照字段；`todos` 是 Task 4 已归属当前回合的结构化列表。 */
export type ProgressPanelItem = ToolPanelItem & {
  clientMessageId?: string;
  todos?: TodoEntry[];
};

/** 连接三态：断连、重连对账中、正常。 */
export type ProgressConnection = "live" | "disconnected" | "reconnecting";

/** 分步任务区相位：有快照、等待首份快照、空回合。 */
export type ProgressTaskPhase = "ready" | "waiting" | "empty";

/** 单步任务的展示投影；`interrupted` 只叠加在 `in_progress` 上。 */
export type ProgressTaskView = {
  content: string;
  sourceStatus: TodoStatus;
  displayStatus: TodoStatus | "interrupted";
};

/** 右栏组件消费的唯一模型；不含 `percentage` 之类虚构进度。 */
export type ProgressPanelModel = {
  sessionId: string;
  connection: ProgressConnection;
  currentTurnClientMessageId?: string;
  taskPhase: ProgressTaskPhase;
  tasks: ProgressTaskView[];
  completedCount: number;
  totalCount: number;
  activity: ToolPanelView[];
  subagents: SubagentRunView[];
};

/**
 * 选择器入参。`items` 与 `toolRows` 都保留完整内容：面板按
 * `items.slice(currentTurnStart(items))` 的条目 id 过滤 `toolRows`，从而只取当前
 * 回合的工具面板，同时沿用调用方已有的 `turnFinalByUserId` 折叠结果。
 */
export type ProgressPanelInput<T extends ProgressPanelItem = ProgressPanelItem> = {
  sessionId: string;
  items: readonly T[];
  toolRows: readonly ToolPanelRow<T>[];
  /** 当前回合已启动用户条目的权威锚点；缺失时终态运行 fail-closed。 */
  currentTurnClientMessageId?: string;
  /** 当前逻辑回合是否已结算（`turnFinalByUserId` / `turnFinalWithoutUser`）。 */
  turnFinal: boolean;
  /** 同一父会话的全部受管运行；选择器按当前会话与活跃/终态规则过滤。 */
  subagents: readonly SubagentRunView[];
  sidecarDead: boolean;
  ready: boolean;
  sawReady: boolean;
  subagentConnection: "live" | "disconnected";
};

/**
 * 把当前标签的会话状态投影成右栏模型。
 *
 * @param input 当前标签的消息条目、工具面板行、回合锚点与连接状态
 * @returns 只读模型：任务计数、当前回合活动面板与筛选后的受管运行
 */
export function selectProgressPanelModel<T extends ProgressPanelItem>(
  input: ProgressPanelInput<T>,
): ProgressPanelModel {
  const turnStart = currentTurnStart(input.items);
  const snapshot = lastTodoSnapshot(input.items, turnStart);
  const tasks: ProgressTaskView[] = (snapshot?.todos ?? []).map((entry) => ({
    content: entry.content,
    sourceStatus: entry.status,
    displayStatus:
      entry.status === "in_progress" && input.turnFinal ? "interrupted" : entry.status,
  }));
  const completedCount = tasks.filter((task) => task.sourceStatus === "completed").length;

  const taskPhase: ProgressTaskPhase =
    snapshot !== undefined
      ? "ready"
      : turnStart > 0 && !input.turnFinal
        ? "waiting"
        : "empty";

  const currentTurnIds = new Set(input.items.slice(turnStart).map((item) => item.id));
  const activity = input.toolRows.flatMap((row) =>
    row.kind === "panel" && currentTurnIds.has(row.panel.anchorId) ? [row.panel] : [],
  );

  const subagents = input.subagents.filter(
    (run) =>
      run.parentSessionId === input.sessionId &&
      (isSubagentRunActive(run) ||
        (typeof input.currentTurnClientMessageId === "string" &&
          run.clientMessageId === input.currentTurnClientMessageId)),
  );

  return {
    sessionId: input.sessionId,
    connection: resolveConnection(input),
    ...(input.currentTurnClientMessageId === undefined
      ? {}
      : { currentTurnClientMessageId: input.currentTurnClientMessageId }),
    taskPhase,
    tasks,
    completedCount,
    totalCount: tasks.length,
    activity,
    subagents,
  };
}

/** 当前回合最后一条 todo 快照（`currentTurnStart` 之后），空数组仍是合法快照。 */
function lastTodoSnapshot<T extends ProgressPanelItem>(
  items: readonly T[],
  turnStart: number,
): { todos: TodoEntry[] } | undefined {
  for (let index = items.length - 1; index >= turnStart; index -= 1) {
    const item = items[index];
    if (item?.kind === "todo") return { todos: item.todos ?? [] };
  }
  return undefined;
}

/** 连接三态只由既有 ready/sawReady/sidecarDead/快照连接合成，不新增宿主字段。 */
function resolveConnection(
  input: Pick<ProgressPanelInput, "sidecarDead" | "ready" | "sawReady" | "subagentConnection">,
): ProgressConnection {
  if (input.sidecarDead) return "disconnected";
  if ((!input.ready && input.sawReady) || input.subagentConnection === "disconnected") {
    return "reconnecting";
  }
  return "live";
}
