import type {
  RpcEvent,
  SubagentCleanupWarning,
  SubagentRunPhase,
  SubagentRunProjection,
  SubagentRunSnapshot,
  SubagentStopReason,
  SubagentToolActivity,
} from "../rpc-types.ts";

/**
 * 子代理 run 的客户端对账(设计 §5.6 / C-05–C-08)。
 *
 * 输入只有三种:Host 的 `subagent/run[-remove]` 事件、重连或补拉得到的
 * `SubagentRunSnapshot`、以及 WS 断开通知。规则:
 * - 同代 snapshot 按 run.revision 合并:比 snapshot 新的 WS 事件不被回滚,
 *   snapshot 捕获后才出现的 run 不被误删;
 * - snapshot 缺项只删除同一父会话的终态历史(`subagent.list` 按父会话取快照,
 *   别的 tab 的历史不能因为不在本快照里而消失);空快照不携带父会话身份,
 *   因此不做缺项删除;
 * - generation 变化时,旧代际的非终态 run 原地标成 `stale`(仅供回看的失效视图),
 *   旧终态保留为历史;stale 永不参与活跃对账,也不会被事件改写成终态;
 * - 断连冻结计时,直到下一次 snapshot 对账完成才恢复;
 * - 终态历史沿用 Host 的 20/父会话、200 全局上限;活跃、stopping 与 stale 不淘汰。
 *
 * generation 切换只由 snapshot 建立:来自其他代际的 `subagent/run` 事件一律忽略,
 * 避免旧代际的迟到帧把新代际的活跃卡误标失效。同代事件按 revision 合并,
 * 迟到或重复的旧帧不会回滚卡片。终态卡只接受终态投影:更高的 revision 也不能把
 * `completed`/`failed`/`stopped` 改写回活跃相位(设计 §5.2「终态后忽略迟到活动,
 * 不复活旧 run」);terminal→terminal 仍按 revision 合并,以便迟到的清理告警落卡。
 * `stopping` 卡不能回退到停止受理前的活动相位(`starting`/`reasoning`/`generating`/`tool`),
 * 更高的 revision 也不改写停止中卡片的活动、原因与时间(设计 §5.2);但 `stopping`
 * 与终态投影照常按 revision 合并,停止不会被误挡。
 *
 * `expanded`、确认态等 UI 状态不进入这里的 run 对象(设计 D26),由调用方按 runId
 * 另行保存。纯函数:不修改入参 state 或其中的 run 对象;有实际变化时返回新的
 * state 与 Map,无变化时返回原 state,便于 React 跳过重渲染。
 */

/** 终态相位:进入后不再参与活跃对账,只进入有界历史。 */
export const TERMINAL_RUN_PHASES: ReadonlySet<SubagentRunPhase> = new Set<SubagentRunPhase>([
  "completed",
  "failed",
  "stopped",
]);

/** 每父会话与全局的终态历史上限,与 Host registry 的默认值一致。 */
const TERMINAL_PER_PARENT = 20;
const TERMINAL_GLOBAL = 200;

/**
 * 停止受理前的活动相位。`stopping` 卡不得回退进入这些相位(设计 §5.2),
 * 无论来帧 revision 多高;`finalizing` 是收尾方向,不在其中。
 */
const STOPPING_REGRESSION_PHASES: ReadonlySet<SubagentRunPhase> = new Set<SubagentRunPhase>([
  "starting",
  "reasoning",
  "generating",
  "tool",
]);

/** 客户端 run 视图:Host 投影 + 只在本端存在的失效标记。 */
export type SubagentRunView = SubagentRunProjection & { stale?: boolean; staleAt?: number };

/** reducer 消费的两条 run 事件(其余 RpcEvent 不进入本模块)。 */
export type SubagentRunEvent = Extract<RpcEvent, { event: "subagent/run" | "subagent/run-remove" }>;

type SubagentRunUpdateEvent = Extract<RpcEvent, { event: "subagent/run" }>;
type SubagentRunRemoveEvent = Extract<RpcEvent, { event: "subagent/run-remove" }>;

export type SubagentRunsAction =
  | { type: "event"; event: SubagentRunEvent }
  /** `at` 是客户端时钟,只用于新代际失效卡的 `staleAt`(Task 11 传 Date.now())。 */
  | { type: "snapshot"; snapshot: SubagentRunSnapshot; at?: number }
  | { type: "disconnect"; at: number };

export type SubagentRunsState = {
  generation?: string;
  revision: number;
  runs: Map<string, SubagentRunView>;
  connection: "live" | "disconnected";
  /** 第一次断连的时刻;重复断连保持最早值,snapshot 对账完成后清除。 */
  frozenAt?: number;
};

/**
 * 活跃 = 非终态且未被标失效。stale 卡片是展示用失效视图,永不活跃;
 * `stopping` 仍算活跃(停止已受理,清理尚未确认)。
 *
 * @param run 当前 run 视图
 * @returns 该 run 是否仍参与活跃对账
 */
export function isSubagentRunActive(run: SubagentRunView): boolean {
  return run.stale !== true && !TERMINAL_RUN_PHASES.has(run.phase);
}

/**
 * 按一条事件或快照推进客户端 run 状态。
 *
 * @param state 当前状态;不会被修改
 * @param action run 事件、snapshot 或断连通知
 * @returns 新状态;没有实际变化时返回入参 `state`
 */
export function reduceSubagentRuns(state: SubagentRunsState, action: SubagentRunsAction): SubagentRunsState {
  switch (action.type) {
    case "event":
      return reduceEvent(state, action.event);
    case "snapshot":
      return reduceSnapshot(state, action.snapshot, action.at);
    case "disconnect":
      return reduceDisconnect(state, action.at);
  }
}

function reduceEvent(state: SubagentRunsState, event: SubagentRunEvent): SubagentRunsState {
  if (event.event === "subagent/run-remove") return reduceRunRemove(state, event);
  return reduceRunUpdate(state, event);
}

function reduceRunUpdate(state: SubagentRunsState, event: SubagentRunUpdateEvent): SubagentRunsState {
  const incoming = event.run;
  // generation 只能由 snapshot 建立;其他代际的事件不得混入当前对账。
  if (state.generation !== undefined && incoming.generation !== state.generation) return state;
  const existing = state.runs.get(incoming.runId);
  // stale 卡片只供回看:既不复活成活跃,也不被迟到事件改写成终态。
  if (existing?.stale === true) return state;
  // 终态后忽略迟到的活动帧:终态只能是终态,更高的 revision 也不能复活旧 run。
  // terminal→terminal 仍走下一条 revision 合并(清理告警可以晚于终态投影到达)。
  if (
    existing !== undefined &&
    TERMINAL_RUN_PHASES.has(existing.phase) &&
    !TERMINAL_RUN_PHASES.has(incoming.phase)
  ) {
    return state;
  }
  // 停止已受理后不得回退到停止前的活动相位:来帧整体忽略,相位、活动工具、
  // 停止原因与时间戳都保持停止时的样子(设计 §5.2)。stopping/终态投影照常合并。
  if (
    existing !== undefined &&
    existing.phase === "stopping" &&
    STOPPING_REGRESSION_PHASES.has(incoming.phase)
  ) {
    return state;
  }
  // 同代事件按 revision 合并,迟到或重复的旧帧不回滚已经更新的卡片。
  if (existing !== undefined && existing.revision >= incoming.revision) return state;
  const runs = new Map(state.runs);
  runs.set(incoming.runId, { ...incoming });
  pruneTerminalHistory(runs);
  return {
    ...state,
    generation: state.generation ?? incoming.generation,
    revision: Math.max(state.revision, incoming.revision),
    runs,
  };
}

function reduceRunRemove(state: SubagentRunsState, event: SubagentRunRemoveEvent): SubagentRunsState {
  const existing = state.runs.get(event.runId);
  if (existing === undefined) return state;
  if (existing.generation !== event.generation) return state;
  // run 的 revision 比移除帧更新:移除针对的是更早的状态,不能删。
  if (existing.revision > event.revision) return state;
  // 只有终态历史会被 Host 淘汰;活跃/stopping/stale 一律保留。
  if (isSubagentRunActive(existing) || !TERMINAL_RUN_PHASES.has(existing.phase)) return state;
  const runs = new Map(state.runs);
  runs.delete(event.runId);
  return { ...state, runs };
}

function reduceSnapshot(
  state: SubagentRunsState,
  snapshot: SubagentRunSnapshot,
  at: number | undefined,
): SubagentRunsState {
  const generationChanged = state.generation !== undefined && state.generation !== snapshot.generation;
  const runs = new Map(state.runs);

  if (generationChanged) {
    // 新代际:旧非终态 run 原地失效(冻结计时),旧终态保留为历史。
    const staleAt = at ?? Date.now();
    for (const [runId, existing] of runs) {
      runs.set(
        runId,
        TERMINAL_RUN_PHASES.has(existing.phase)
          ? { ...existing, stale: false }
          : // 已经失效的卡片保留第一次冻结的时刻,再次换代不得让计时跳变。
            { ...existing, stale: true, staleAt: existing.staleAt ?? staleAt },
      );
    }
  }

  const snapshotIds = new Set<string>();
  const snapshotParents = new Set<string>();
  for (const incoming of snapshot.runs) {
    snapshotIds.add(incoming.runId);
    snapshotParents.add(incoming.parentSessionId);
    const existing = runs.get(incoming.runId);
    // 同代快照不覆盖比它更新的 WS 事件;新代际的 snapshot 是权威来源。
    if (!generationChanged && existing !== undefined && existing.revision > snapshot.revision) continue;
    runs.set(incoming.runId, mergeSnapshotRun(existing, incoming, generationChanged));
  }

  if (!generationChanged) {
    for (const [runId, existing] of runs) {
      if (snapshotIds.has(runId)) continue;
      if (existing.generation !== snapshot.generation) continue;
      // 快照只覆盖一个父会话,别的 tab 的 run 不参与缺项对账。
      if (!snapshotParents.has(existing.parentSessionId)) continue;
      // snapshot 捕获后才出现的 run 不在快照里是正常的,不能删。
      if (existing.revision > snapshot.revision) continue;
      if (isSubagentRunActive(existing)) continue;
      if (!TERMINAL_RUN_PHASES.has(existing.phase)) continue;
      runs.delete(runId);
    }
  }

  pruneTerminalHistory(runs);
  return {
    generation: snapshot.generation,
    revision: generationChanged ? snapshot.revision : Math.max(state.revision, snapshot.revision),
    runs,
    connection: "live",
  };
}

/** 同代快照保留既有客户端字段(正常情况下不该存在,但不得因它们崩溃或丢标记)。 */
function mergeSnapshotRun(
  existing: SubagentRunView | undefined,
  incoming: SubagentRunProjection,
  generationChanged: boolean,
): SubagentRunView {
  const next: SubagentRunView = { ...incoming };
  if (generationChanged || existing === undefined) return next;
  if (existing.stale !== undefined) next.stale = existing.stale;
  if (existing.staleAt !== undefined) next.staleAt = existing.staleAt;
  return next;
}

function reduceDisconnect(state: SubagentRunsState, at: number): SubagentRunsState {
  if (state.connection === "disconnected" && state.frozenAt !== undefined) return state;
  return { ...state, connection: "disconnected", frozenAt: state.frozenAt ?? at, runs: new Map(state.runs) };
}

/**
 * 终态历史有界:每父会话 20 条、全局 200 条,按终态时间从旧到新淘汰。
 * 活跃、stopping 与 stale 不参与计数,也不会被裁剪。并发 run 的淘汰顺序不构成契约。
 */
function pruneTerminalHistory(runs: Map<string, SubagentRunView>): void {
  const insertion = new Map<string, number>();
  let index = 0;
  for (const runId of runs.keys()) insertion.set(runId, index);

  const isTerminal = (run: SubagentRunView): boolean =>
    run.stale !== true && TERMINAL_RUN_PHASES.has(run.phase);
  const orderOf = (run: SubagentRunView): number => run.endedAt ?? run.startedAt;
  const dropOldest = (candidates: SubagentRunView[], keep: number): void => {
    if (candidates.length <= keep) return;
    candidates.sort(
      (left, right) =>
        orderOf(left) - orderOf(right) ||
        (insertion.get(left.runId) ?? 0) - (insertion.get(right.runId) ?? 0),
    );
    for (const run of candidates.slice(0, candidates.length - keep)) runs.delete(run.runId);
  };

  const byParent = new Map<string, SubagentRunView[]>();
  for (const run of runs.values()) {
    if (!isTerminal(run)) continue;
    const list = byParent.get(run.parentSessionId);
    if (list === undefined) byParent.set(run.parentSessionId, [run]);
    else list.push(run);
  }
  for (const list of byParent.values()) dropOldest(list, TERMINAL_PER_PARENT);
  dropOldest([...runs.values()].filter(isTerminal), TERMINAL_GLOBAL);
}

/**
 * 对话条目里的运行卡锚点。`logic/` 不反向依赖 `App.tsx` 的私有 `ChatItem`,
 * 只约束条目共有的 `id` 与 `kind` 字段,由调用方把自己的条目类型传进来。
 */
export type SubagentRunCardItem = { id: number; kind: "subagent-run"; runId: string };

/**
 * 在父会话的用户消息之后插入运行卡(设计 D8 / §6)。
 *
 * - 精确锚点:实时事件只在 `clientMessageId` 等于本 tab 里某条 `user` 条目的 `id` 时插入;
 * - 快照回退:只有 `allowSnapshotFallback === true`(仅 snapshot 对账)才回退到本 tab
 *   最后一条 `user`。实时事件不得猜测归属,两条路径都不得跨 tab 查找;
 * - 同 `runId` 的卡已存在或本 tab 没有可用锚点时返回入参 `items`,React 可跳过重渲染。
 *
 * @param items 目标 tab 的对话条目
 * @param input 运行 id、消息锚点、是否允许快照回退与 id 分配器
 * @returns 含新卡的数组;无需插入时返回入参 `items`
 */
export function insertSubagentRunCard<T extends { id: number; kind: string }>(
  items: T[],
  input: { runId: string; clientMessageId?: string; allowSnapshotFallback?: boolean; allocateId(): number },
): Array<T | SubagentRunCardItem> {
  if (items.some((item) => item.kind === "subagent-run" && "runId" in item && item.runId === input.runId)) {
    return items;
  }
  const exactIndex = input.clientMessageId === undefined
    ? -1
    : items.findIndex((item) => item.kind === "user" && item.id === Number(input.clientMessageId));
  const fallbackIndex = input.allowSnapshotFallback === true
    ? items.findLastIndex((item) => item.kind === "user")
    : -1;
  const index = exactIndex >= 0 ? exactIndex : fallbackIndex;
  if (index < 0) return items;
  const card: SubagentRunCardItem = { id: input.allocateId(), kind: "subagent-run", runId: input.runId };
  return [...items.slice(0, index + 1), card, ...items.slice(index + 1)];
}

/**
 * 父回合状态行(设计 D4):父会话有活跃运行卡时只说明「主会话运行中」,
 * 子代理的工具与活动详情留在各自的运行卡里;没有活跃子运行卡时保持原有
 * `turnStatus` 输出。该函数只决定展示,不改变任何回合或取消状态。
 *
 * @param input 是否存在活跃子运行卡,以及原本要展示的回合状态
 * @returns 父状态行的文案与告警级别
 */
export function parentTurnLine(input: {
  hasActiveChild: boolean;
  current: { text: string; alert: boolean };
}): { text: string; alert: boolean } {
  return input.hasActiveChild ? { text: "主会话运行中", alert: false } : input.current;
}

/**
 * 运行卡的展示纯函数:固定文案、计时、提醒与工具摘要。
 *
 * 这些函数只读投影,不写回 `endedAt`,也不读取环境时钟——`now` 一律由调用方
 * 注入。提醒按设计 D10 的优先级排列(清理未确认/失败 > 停止等待 > 收尾预算 >
 * 无新活动),每张卡默认只直接展示第一条,其余由卡片展开显示。
 */

/** 稳定 `code` 供样式与合并展示,`text` 是已定稿的展示文案。 */
export type SubagentRunAlert = { code: string; severity: "info" | "error"; text: string };

const STOP_WAIT_MS = 60_000;
const INACTIVITY_MS = 300_000;
const MINUTE_MS = 60_000;
const VISIBLE_TOOL_COUNT = 2;

const PHASE_TEXT: Record<SubagentRunPhase, string> = {
  starting: "启动中",
  reasoning: "思考中",
  generating: "生成中",
  tool: "正在执行工具",
  finalizing: "正在确认执行结果",
  stopping: "停止中",
  completed: "已完成",
  stopped: "已停止",
  failed: "失败 · 原因未知",
};

const CLEANUP_WARNING_TEXT: Record<string, string> = {
  "activation-dispose-failed": "子代理释放失败，清理未确认",
  "activation-dispose-timeout": "子代理释放超时，清理未确认",
  "runtime-stop-failed": "运行环境停止失败，清理未确认",
  "runtime-stop-timeout": "运行环境停止超时，清理未确认",
  "upstream-end-error": "上游结束状态与执行结果不一致",
  "cleanup-failed": "清理失败",
};

/**
 * 运行卡主状态文案。`failed` 按权威 `stopReason` 取 §6.1 的固定映射;
 * `unknown`、缺失与无法识别的值一律落到「失败 · 原因未知」,绝不当作成功。
 *
 * @param run 当前 run 投影
 * @returns 展示用状态文案
 */
export function subagentStatusText(run: SubagentRunProjection): string {
  if (run.phase === "failed") return failedStatusText(run.stopReason);
  return PHASE_TEXT[run.phase];
}

function failedStatusText(stopReason: SubagentStopReason | undefined): string {
  switch (stopReason) {
    case "error":
      return "失败 · 执行出错";
    case "max-tokens":
      return "未完成 · 达到模型输出上限";
    case "refusal":
      return "未完成 · 子代理拒绝执行";
    default:
      return "失败 · 原因未知";
  }
}

/**
 * `finalizing` 的副文案:只解释 child idle 后的真实等待,不承诺即将完成。
 *
 * @param run 当前 run 投影
 * @returns `finalizing` 的说明文案;其他相位没有副文案
 */
export function subagentStatusDetail(run: SubagentRunProjection): string | undefined {
  return run.phase === "finalizing" ? "子代理已空闲，等待运行结果返回" : undefined;
}

/**
 * 显示用耗时。真实 `endedAt` 是权威值,这里只冻结展示:
 * 断连使用 `frozenAt`,Host 换代失效卡优先使用自己的 `staleAt`。
 *
 * @param run 当前 run 视图(可携带客户端失效标记)
 * @param now 调用方注入的当前时刻
 * @param frozenAt WS 断连冻结时刻;stale 卡由 `staleAt` 覆盖
 * @returns 从 `startedAt` 起算且不小于 0 的显示毫秒数
 */
export function subagentElapsedMs(
  run: SubagentRunProjection & { stale?: boolean; staleAt?: number },
  now: number,
  frozenAt?: number,
): number {
  const freeze = run.stale === true && run.staleAt !== undefined ? run.staleAt : frozenAt;
  return Math.max(0, Math.min(now, run.endedAt ?? now, freeze ?? now) - run.startedAt);
}

/**
 * 收尾预算的可读时长:整分钟及以上按分钟,其余按秒;最多两位小数并去掉尾零。
 * 文案里的数字只来自 Host 投影,前端不另写预算常量。
 *
 * @param ms 收尾预算毫秒数
 * @returns 例如 `10 分钟`、`5 秒`、`1.5 分钟`
 */
export function formatCleanupBudget(ms: number): string {
  const useMinutes = ms >= MINUTE_MS;
  const amount = Number((ms / (useMinutes ? MINUTE_MS : 1_000)).toFixed(2));
  return `${amount} ${useMinutes ? "分钟" : "秒"}`;
}

/**
 * 同名运行的区分时间:本地时区 24 小时制 `HH:MM:SS`,补零。
 *
 * @param startedAt run 的 `startedAt` 毫秒时间戳
 * @returns 本地时区的 `HH:MM:SS`
 */
export function formatRunStartedAt(startedAt: number): string {
  const date = new Date(startedAt);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 同一父会话里存在同名、不同 runId 的其他卡片(含终态与失效历史)时,
 * 卡片需要显示 `startedAt` 以便区分。
 *
 * @param run 当前 run 投影
 * @param allRuns 同一父会话的全部 run 投影
 * @returns 是否存在同名且不同 runId 的另一条 run
 */
export function subagentNeedsStartTime(
  run: SubagentRunProjection,
  allRuns: readonly SubagentRunProjection[],
): boolean {
  return allRuns.some((other) => other.runId !== run.runId && other.label === run.label);
}

/**
 * 在途工具摘要:按 `startedAt`、再按内部 `id` 稳定排序,最多直接显示前 2 个,
 * 其余用 `+N` 表达。输入数组不被重排。
 *
 * @param tools 当前在途工具
 * @returns 可见的前两个工具、被隐藏的数量与单行摘要文案
 */
export function subagentToolSummary(tools: SubagentToolActivity[]): {
  visible: SubagentToolActivity[];
  hiddenCount: number;
  text: string;
} {
  const sorted = [...tools].sort(compareTools);
  if (sorted.length === 0) return { visible: [], hiddenCount: 0, text: "" };

  const visible = sorted.slice(0, VISIBLE_TOOL_COUNT);
  const hiddenCount = sorted.length - visible.length;
  const first = sorted[0];
  if (sorted.length === 1 && first !== undefined) {
    return { visible, hiddenCount, text: first.name };
  }

  const names = visible.map((item) => item.name).join("、");
  const hiddenSuffix = hiddenCount > 0 ? ` +${hiddenCount}` : "";
  return {
    visible,
    hiddenCount,
    text: `正在执行 ${sorted.length} 个工具 · ${names}${hiddenSuffix}`,
  };
}

function compareTools(left: SubagentToolActivity, right: SubagentToolActivity): number {
  if (left.startedAt !== right.startedAt) return left.startedAt - right.startedAt;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/**
 * 运行卡的全部提醒,按 D10 的优先级排序:清理未确认/失败 > 停止等待 60 秒 >
 * 收尾预算 > 无新活动。清理告警在每个相位都保留,包括 `completed` 与 `failed`;
 * 这些提醒不改变相位,也不把 `completed` 改写成 `failed`。
 *
 * @param run 当前 run 投影
 * @param now 调用方注入的当前时刻
 * @returns 按优先级排序的提醒;没有提醒时为空数组
 */
export function subagentAlerts(run: SubagentRunProjection, now: number): SubagentRunAlert[] {
  const alerts: SubagentRunAlert[] = [];
  const seenCodes = new Set<string>();
  let hasBudgetWarning = false;
  for (const warning of run.cleanupWarnings) {
    if (seenCodes.has(warning.code)) continue;
    seenCodes.add(warning.code);
    if (warning.code === "cleanup-budget-exceeded") {
      hasBudgetWarning = true;
      continue;
    }
    const alert = cleanupWarningAlert(warning);
    if (alert !== undefined) alerts.push(alert);
  }

  if (
    run.phase === "stopping" &&
    run.stopRequestedAt !== undefined &&
    now - run.stopRequestedAt > STOP_WAIT_MS
  ) {
    alerts.push({
      code: "stop-wait",
      severity: "info",
      text: "停止已受理超过 1 分钟，资源释放仍未确认；可离开此卡稍后查看，无需重复点击",
    });
  }

  if (run.cleanupBudgetMs !== undefined || run.stopCause === "cleanup-budget" || hasBudgetWarning) {
    alerts.push(cleanupBudgetAlert(run));
  }

  if (!TERMINAL_RUN_PHASES.has(run.phase)) {
    const last = run.lastActivity ?? run.startedAt;
    if (now - last >= INACTIVITY_MS) {
      alerts.push({
        code: "inactive",
        severity: "info",
        text: `已 ${Math.floor((now - last) / MINUTE_MS)} 分钟没有新活动`,
      });
    }
  }

  return alerts;
}

/** 收尾预算提醒;缺 `cleanupBudgetMs` 时只给无数字的结论,不编造数值。 */
function cleanupBudgetAlert(run: SubagentRunProjection): SubagentRunAlert {
  const text =
    run.cleanupBudgetMs === undefined
      ? "等待收尾超时"
      : `父会话空闲后等待收尾超过 ${formatCleanupBudget(run.cleanupBudgetMs)}，已开始强制释放`;
  return { code: "cleanup-budget", severity: "info", text };
}

/** 已知清理失败 code 决定 error banner;未知 code 保留 Host 的 severity。 */
function cleanupWarningAlert(warning: SubagentCleanupWarning): SubagentRunAlert | undefined {
  if (warning.code === "cleanup-budget-exceeded") return undefined;
  const text = CLEANUP_WARNING_TEXT[warning.code];
  return text === undefined
    ? { code: warning.code, severity: warning.severity, text: "清理状态需要关注" }
    : { code: warning.code, severity: "error", text };
}

/**
 * 默认直接展示的第一条提醒。
 *
 * @param run 当前 run 投影
 * @param now 调用方注入的当前时刻
 * @returns 优先级最高的提醒;没有提醒时为 `undefined`
 */
export function subagentAlert(run: SubagentRunProjection, now: number): SubagentRunAlert | undefined {
  return subagentAlerts(run, now)[0];
}
