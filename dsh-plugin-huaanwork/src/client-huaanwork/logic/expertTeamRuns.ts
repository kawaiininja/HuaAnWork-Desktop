import type { ExpertTeamRun } from "../rpc-types.ts";

/**
 * 专家团聚合运行卡的客户端对账（设计 §8.5 / §13.3 / §16）。
 *
 * 输入只有 Host 的 `expertTeam/run[-remove]` 事件、重连或补拉得到的
 * `ExpertTeamRunSnapshot`,以及 WS 断开通知。规则:
 * - snapshot 是 generation 与连接恢复的唯一来源:任何快照都恢复 `open` 并清除
 *   冻结时刻;换代清空旧运行,不标 interrupted、不保留旧 running,revision 取快照值;
 * - 同代 snapshot 按 run.revision 合并,缺项只清理本快照所属父会话(或快照内出现的
 *   父会话)的终态,绝不删除其他 tab、活跃/stopping 或捕获快照后到达的高 revision 运行;
 * - 同代 run 只接受严格更高的 revision,终态不回退到 running/stopping,
 *   stopping 不回退到 running;
 * - remove 只删除同代、同父会话、终态且 revision 不高于移除帧的运行;
 * - disconnect 只冻结展示,绝不把 running 改写成 stopped;
 * - 终态历史沿用 Host 的 20/父会话、100 全局上限,活跃与 stopping 不淘汰。
 *
 * 纯函数:不修改入参 state 或其中的 Map;有实际变化时返回新 state 与新 Map,
 * 被忽略的帧返回原 state,便于 React 跳过重渲染。
 */

/** 终态:进入后不再参与活跃对账,只进入有界历史。 */
const TERMINAL_STATUSES: ReadonlySet<ExpertTeamRun["status"]> = new Set<ExpertTeamRun["status"]>([
  "completed",
  "completed_with_issues",
  "partial",
  "failed",
  "stopped",
]);

/** 每父会话与全局的终态历史上限,与 Host 运行注册表一致。 */
const TERMINAL_PER_PARENT = 20;
const TERMINAL_GLOBAL = 100;

export type ExpertTeamRunsState = {
  /** Host generation;只由 snapshot 建立或替换,旧代际的运行不跨代保留。 */
  generation?: string;
  /** 已合并的最大 snapshot/revision;换代时重置为快照值。 */
  revision: number;
  runs: ReadonlyMap<string, ExpertTeamRun>;
  /** `closed` 期间运行卡操作禁用;任何 snapshot 都恢复 `open`。 */
  connection: "open" | "closed";
  /** 第一次断连的时刻;重复断连保持最早值,下一次 snapshot 清除。 */
  frozenAt?: string;
};

/** 客户端消费的团队运行帧与连接事件。 */
export type ExpertTeamRunAction =
  | { type: "snapshot"; sessionId?: string; generation: string; revision: number; runs: ExpertTeamRun[] }
  | { type: "run"; generation: string; run: ExpertTeamRun }
  | { type: "remove"; generation: string; revision: number; teamRunId: string; parentSessionId: string }
  | { type: "disconnect"; at: string };

type ExpertTeamSnapshotAction = Extract<ExpertTeamRunAction, { type: "snapshot" }>;
type ExpertTeamRunUpdateAction = Extract<ExpertTeamRunAction, { type: "run" }>;
type ExpertTeamRunRemoveAction = Extract<ExpertTeamRunAction, { type: "remove" }>;

/**
 * 对话条目里的聚合运行卡锚点。`logic/` 不反向依赖 `App.tsx` 的私有 `ChatItem`,
 * 只约束条目共有的 `id` 与 `kind` 字段,由调用方把自己的条目类型传进来。
 */
export type ExpertTeamRunCardItem = { id: number; kind: "expert-team-run"; teamRunId: string };

/** 聚合卡计数(设计 §13.1):只统计结果链,不猜测未派工成员或虚假总步骤。 */
export type ExpertTeamCounts = {
  /** 实际派工数量:每个 execute/review/revision 结果都来自一次成功派工。 */
  dispatched: number;
  /** 进行中的派工数量(starting/running)。 */
  running: number;
  completed: number;
  failed: number;
  /** 用户终止或父会话 abort 导致的结果,与 `failed` 分开,不伪装成失败。 */
  stopped: number;
  /** 审查型派工数量。 */
  reviews: number;
  /** 返修型派工数量。 */
  revisions: number;
};

/**
 * @param run 团队运行投影
 * @returns 该运行是否已进入终态(完成/完成但有业务意见/部分完成/失败/已停止)
 */
export function isExpertTeamTerminal(run: ExpertTeamRun): boolean {
  return TERMINAL_STATUSES.has(run.status);
}

/**
 * 按一条 snapshot、run 事件、移除帧或断连通知推进客户端团队运行状态。
 *
 * @param state 当前状态;不会被修改
 * @param action 团队运行帧、快照对账或断连通知
 * @returns 新状态;被忽略的帧返回入参 `state`
 */
export function reduceExpertTeamRuns(state: ExpertTeamRunsState, action: ExpertTeamRunAction): ExpertTeamRunsState {
  switch (action.type) {
    case "snapshot":
      return reduceSnapshot(state, action);
    case "run":
      return reduceRun(state, action);
    case "remove":
      return reduceRemove(state, action);
    case "disconnect":
      return reduceDisconnect(state, action);
  }
}

function reduceRun(state: ExpertTeamRunsState, action: ExpertTeamRunUpdateAction): ExpertTeamRunsState {
  const incoming = action.run;
  // generation 只能由 snapshot 建立;其他代际的事件不得混入当前对账。
  if (state.generation !== undefined && action.generation !== state.generation) return state;
  const existing = state.runs.get(incoming.teamRunId);
  if (existing !== undefined) {
    // 终态后忽略迟到的活动帧:更高的 revision 也不能复活旧运行。
    if (isExpertTeamTerminal(existing) && !isExpertTeamTerminal(incoming)) return state;
    // 停止已受理后不得回退到 running;stopping/终态投影照常按 revision 合并。
    if (existing.status === "stopping" && incoming.status === "running") return state;
    // 同代事件按 revision 合并,迟到或重复的旧帧不回滚已经更新的卡片。
    if (existing.revision >= incoming.revision) return state;
  }
  const runs = new Map(state.runs);
  runs.set(incoming.teamRunId, { ...incoming });
  pruneTerminalHistory(runs);
  return {
    ...state,
    generation: state.generation ?? action.generation,
    revision: Math.max(state.revision, incoming.revision),
    runs,
  };
}

function reduceRemove(state: ExpertTeamRunsState, action: ExpertTeamRunRemoveAction): ExpertTeamRunsState {
  const existing = state.runs.get(action.teamRunId);
  if (existing === undefined) return state;
  // 移除帧只对产生它的 generation 与父会话有效;teamRunId 全局唯一,父会话是交叉校验。
  if (state.generation !== action.generation || existing.parentSessionId !== action.parentSessionId) return state;
  // 运行比移除帧更新:移除针对的是更早的状态,不能删。
  if (existing.revision > action.revision) return state;
  // 只有终态历史会被 Host 淘汰;活跃/stopping 一律保留。
  if (!isExpertTeamTerminal(existing)) return state;
  const runs = new Map(state.runs);
  runs.delete(action.teamRunId);
  return { ...state, runs };
}

function reduceSnapshot(state: ExpertTeamRunsState, action: ExpertTeamSnapshotAction): ExpertTeamRunsState {
  const generationChanged = state.generation !== undefined && state.generation !== action.generation;
  // 换代时旧运行整体丢弃:不标记 interrupted,也不保留旧 running。
  const runs = generationChanged ? new Map<string, ExpertTeamRun>() : new Map(state.runs);

  for (const incoming of action.runs) {
    const existing = runs.get(incoming.teamRunId);
    // 同代快照不覆盖比它更新的 WS 事件;新代际的 snapshot 是权威来源。
    if (!generationChanged && existing !== undefined && existing.revision > action.revision) continue;
    runs.set(incoming.teamRunId, { ...incoming });
  }

  if (!generationChanged) {
    const snapshotIds = new Set(action.runs.map((item) => item.teamRunId));
    // 缺项对账范围:快照所属会话加快照内出现的父会话;空快照没有会话身份时不猜测归属。
    const scopedParents = new Set(action.runs.map((item) => item.parentSessionId));
    if (action.sessionId !== undefined) scopedParents.add(action.sessionId);
    for (const [teamRunId, existing] of runs) {
      if (snapshotIds.has(teamRunId)) continue;
      if (!scopedParents.has(existing.parentSessionId)) continue;
      // snapshot 捕获后才出现的运行不在快照里是正常的,不能删。
      if (existing.revision > action.revision) continue;
      if (!isExpertTeamTerminal(existing)) continue;
      runs.delete(teamRunId);
    }
  }

  pruneTerminalHistory(runs);
  return {
    generation: action.generation,
    revision: generationChanged ? action.revision : Math.max(state.revision, action.revision),
    runs,
    connection: "open",
  };
}

function reduceDisconnect(state: ExpertTeamRunsState, action: Extract<ExpertTeamRunAction, { type: "disconnect" }>): ExpertTeamRunsState {
  if (state.connection === "closed" && state.frozenAt !== undefined) return state;
  return { ...state, connection: "closed", frozenAt: state.frozenAt ?? action.at };
}

/**
 * 终态历史有界:每父会话 20 条、全局 100 条,按终态时间从旧到新淘汰。
 * 活跃与 stopping 不参与计数,也不会被裁剪;并发运行的淘汰顺序不构成契约。
 */
function pruneTerminalHistory(runs: Map<string, ExpertTeamRun>): void {
  const insertion = new Map<string, number>();
  let index = 0;
  for (const teamRunId of runs.keys()) insertion.set(teamRunId, index);

  const dropOldest = (candidates: ExpertTeamRun[], keep: number): void => {
    if (candidates.length <= keep) return;
    candidates.sort(
      (left, right) =>
        terminalOrder(left) - terminalOrder(right) ||
        (insertion.get(left.teamRunId) ?? 0) - (insertion.get(right.teamRunId) ?? 0),
    );
    for (const run of candidates.slice(0, candidates.length - keep)) runs.delete(run.teamRunId);
  };

  const byParent = new Map<string, ExpertTeamRun[]>();
  for (const run of runs.values()) {
    if (!isExpertTeamTerminal(run)) continue;
    const list = byParent.get(run.parentSessionId);
    if (list === undefined) byParent.set(run.parentSessionId, [run]);
    else list.push(run);
  }
  for (const list of byParent.values()) dropOldest(list, TERMINAL_PER_PARENT);
  dropOldest(
    [...runs.values()].filter((run) => isExpertTeamTerminal(run)),
    TERMINAL_GLOBAL,
  );
}

/** 终态时间:优先 `endedAt`;无法解析的时间视为最旧,先被淘汰。 */
function terminalOrder(run: ExpertTeamRun): number {
  const parsed = Date.parse(run.endedAt ?? run.startedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 在父会话的用户消息之后插入聚合运行卡(设计 §13.1)。
 *
 * - 精确锚点:顶层 `clientMessageId` 与条目的持久锚(`user.clientMessageId`)比较,
 *   旧条目没有持久锚时退回 `String(item.id)` 兼容历史卡;
 * - 快照回退:只有 `allowSnapshotFallback === true`(仅 snapshot 对账)才回退到本 tab
 *   最后一条 `user`;实时事件不得猜测归属,两条路径都不得跨 tab 查找;
 * - 同 `teamRunId` 的卡已存在或本 tab 没有可用锚点时返回入参 `items`,React 可跳过重渲染。
 *
 * @param items 目标 tab 的对话条目
 * @param input 团队运行 id、消息锚点、是否允许快照回退与 id 分配器
 * @returns 含新卡的数组;无需插入时返回入参 `items`
 */
export function insertExpertTeamRunCard<T extends { id: number; kind: string; clientMessageId?: string }>(
  items: T[],
  input: { teamRunId: string; clientMessageId?: string; allowSnapshotFallback?: boolean; allocateId(): number },
): Array<T | ExpertTeamRunCardItem> {
  if (
    items.some((item) => item.kind === "expert-team-run" && "teamRunId" in item && item.teamRunId === input.teamRunId)
  ) {
    return items;
  }
  const exactIndex = input.clientMessageId === undefined
    ? -1
    : items.findIndex(
        (item) => item.kind === "user" && (item.clientMessageId ?? String(item.id)) === input.clientMessageId,
      );
  const fallbackIndex = input.allowSnapshotFallback === true
    ? items.findLastIndex((item) => item.kind === "user")
    : -1;
  const index = exactIndex >= 0 ? exactIndex : fallbackIndex;
  if (index < 0) return items;
  const card: ExpertTeamRunCardItem = { id: input.allocateId(), kind: "expert-team-run", teamRunId: input.teamRunId };
  return [...items.slice(0, index + 1), card, ...items.slice(index + 1)];
}

/**
 * 聚合卡计数:派工按结果链实际产生的 execute/review/revision 结果统计,
 * 进行中只包括 starting/running;stopped 与 failed 分开,不把用户终止伪装成失败。
 *
 * @param run 团队运行投影
 * @returns 实际派工、进行中、完成、失败、停止、审查与返修数量
 */
export function expertTeamCounts(run: ExpertTeamRun): ExpertTeamCounts {
  const counts: ExpertTeamCounts = {
    dispatched: run.results.length,
    running: 0,
    completed: 0,
    failed: 0,
    stopped: 0,
    reviews: 0,
    revisions: 0,
  };
  for (const result of run.results) {
    switch (result.status) {
      case "starting":
      case "running":
        counts.running += 1;
        break;
      case "completed":
        counts.completed += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "stopped":
        counts.stopped += 1;
        break;
    }
    if (result.kind === "review") counts.reviews += 1;
    if (result.kind === "revision") counts.revisions += 1;
  }
  return counts;
}
