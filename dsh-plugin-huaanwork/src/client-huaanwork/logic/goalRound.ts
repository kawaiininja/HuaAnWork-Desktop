export const GOAL_ROUND_LIMIT = 4;

export function goalRoundLabel(round: number): string {
  return `正在按目标继续，第 ${round}/${GOAL_ROUND_LIMIT} 轮，这还不是验收结果`;
}

export function goalRoundStopped(round: number, gaps: readonly string[]): string {
  const pending = gaps.length > 0 ? gaps.join("；") : "无";
  return `已停在第 ${round}/${GOAL_ROUND_LIMIT} 轮。尚未核对：${pending}`;
}

/** 官方目标插件的持久相位（`@deepseek-ai/dsh-goal` 的 GoalPhase）。 */
export type GoalPhase = "active" | "paused" | "blocked" | "complete";

/**
 * 会话级目标回合状态。`settled` 里记的是已经写过验收结论（或专用停止文案 /
 * 已取消回合）的会话；每个用户回合由 `turn-started` 重新开窗。
 */
export type GoalTurnState = {
  readonly phases: Readonly<Record<string, GoalPhase>>;
  /**
   * 本回合观察到 paused/blocked 终态边沿的会话。它只压住**本回合**的结束结论：
   * 相位本身会保留到目标被恢复或清空，若按相位抑制，一次 `/goal pause` 会让该会话
   * 之后每个普通回合也丢掉结论。`turn-started` 与 resume（`active` 边沿）清掉它。
   */
  readonly suppressed: readonly string[];
  readonly settled: readonly string[];
};

export const INITIAL_GOAL_TURN_STATE: GoalTurnState = {
  phases: {},
  suppressed: [],
  settled: [],
};

export type GoalTurnEvent =
  | { kind: "turn-started"; sessionId?: string }
  | { kind: "goal-state"; phase: GoalPhase; roundsStarted?: number; sessionId?: string; stopped?: boolean }
  | { kind: "goal-cleared"; sessionId?: string }
  | { kind: "goal-round-limit"; round: number; sessionId?: string }
  | { kind: "session-end"; sessionId?: string; ok: boolean; cancelled?: boolean };

/** 一次事件之后 App 应该写什么；同一个用户回合最多出现一次非 none。 */
export type GoalTurnAction =
  | { kind: "none" }
  | { kind: "outcome" }
  | { kind: "goal-stopped"; round: number };

const NOTHING: GoalTurnAction = { kind: "none" };

/**
 * 目标相位边沿：进入/恢复 `active` 是回合的 start，落到任一终态是 finish；
 * 同相位重复投递没有边沿。
 */
export function goalTurnEdge(previous: GoalPhase | undefined, next: GoalPhase): "start" | "finish" | undefined {
  if (next === "active") return previous === "active" ? undefined : "start";
  return previous === next ? undefined : "finish";
}

/**
 * 目标事件 → 回合结论的纯状态机（App 在 ref 里持有状态）。
 *
 * 裁定：只有 `active` 抑制每轮结束结论。`complete` 是唯一的验收结论；`paused` 与
 * 非 round-limit 的 `blocked` 是目标的终态但不是「已完成」的证据，只给**本回合**打
 * `suppressed` 标记、不结算（输入卡取消、退出计划模式、删会话与 `/goal pause` 都会
 * 先暂停目标再结束回合）。标记在 `turn-started` 与 resume 时清掉，所以暂停只影响它
 * 发生的那一回合，pause → resume → complete 仍由 complete 写一次。
 * round-limit 由专用停止文案结算，不再写普通结论。
 * `settled` 是每回合幂等闸：`session/end` 与终态 `goal/state` 无论谁先到都只写一次。
 */
export function reduceGoalTurn(
  state: GoalTurnState,
  event: GoalTurnEvent,
): { readonly state: GoalTurnState; readonly action: GoalTurnAction } {
  const key = event.sessionId ?? "";
  switch (event.kind) {
    case "turn-started":
      return {
        state: {
          ...state,
          suppressed: without(state.suppressed, key),
          settled: without(state.settled, key),
        },
        action: NOTHING,
      };
    case "goal-cleared": {
      // 目标已清空：忘掉相位，后续结束按「没有目标」正常写结论。
      const phases = { ...state.phases };
      delete phases[key];
      return { state: { ...state, phases, suppressed: without(state.suppressed, key) }, action: NOTHING };
    }
    case "goal-state": {
      const previous = state.phases[key];
      const edge = goalTurnEdge(previous, event.phase);
      const phases = { ...state.phases, [key]: event.phase };
      // 用户停止时的终态不是验收结论：官方 goal-round-driver 在空闲处理里先把目标
      // 暂停，桥随后才发取消结束。这里只结算，「已停止」由停止流程自己写，
      // 迟到的取消结束不会补写。
      if (event.stopped === true) {
        return {
          state: { ...state, phases, suppressed: without(state.suppressed, key), settled: withSettled(state, key) },
          action: NOTHING,
        };
      }
      // start 只更新相位（供 session/end 判断是否抑制），并清掉本回合的暂停标记：
      // 结算窗口由 turn-started 开启，所以 pause → resume → complete 仍只写一次结论。
      // 抑制中（例如 round-limit 的专用文案已写）或没有边沿的重复投递同样不再写。
      if (edge !== "finish" || state.settled.includes(key)) {
        const suppressed = event.phase === "active" ? without(state.suppressed, key) : state.suppressed;
        return { state: { ...state, phases, suppressed }, action: NOTHING };
      }
      // paused / blocked 不写结论也不结算：只压住本回合的结束结论，恢复后仍可由 complete 写一次。
      if (event.phase !== "complete") {
        return { state: { ...state, phases, suppressed: withSuppressed(state.suppressed, key) }, action: NOTHING };
      }
      return {
        state: { ...state, phases, suppressed: without(state.suppressed, key), settled: [...state.settled, key] },
        action: { kind: "outcome" },
      };
    }
    case "goal-round-limit": {
      if (state.settled.includes(key)) return { state, action: NOTHING };
      return {
        state: { ...state, settled: [...state.settled, key] },
        action: { kind: "goal-stopped", round: event.round },
      };
    }
    case "session-end": {
      if (!event.ok || event.cancelled === true) {
        // 取消/失败的回合不写验收结论；记下已结算（停止时的终态可能已记过，不能再记一次），
        // 迟到的 paused 目标也不能补写。
        return { state: { ...state, settled: withSettled(state, key) }, action: NOTHING };
      }
      // 目标仍在续轮：每轮结束只是中间结果。
      if (state.phases[key] === "active") return { state, action: NOTHING };
      // 本回合见过 paused/blocked 终态：回合结束不是验收结论；结算掉，免得迟到的
      // complete 补写。标记随这次结束消费，相位照旧留给下一回合判断。
      if (state.suppressed.includes(key)) {
        return {
          state: { ...state, suppressed: without(state.suppressed, key), settled: withSettled(state, key) },
          action: NOTHING,
        };
      }
      if (state.settled.includes(key)) return { state, action: NOTHING };
      return {
        state: { ...state, settled: [...state.settled, key] },
        action: { kind: "outcome" },
      };
    }
  }
}

/**
 * `goal/round` 是否属于当前跟踪的用户回合。只有同一会话才允许恢复全局 turnActive；
 * 后台会话的续轮只写它自己的标签，不能卡住发送。
 */
export function goalRoundDrivesTurn(sessionId: string | undefined, trackedSessionId: string | null): boolean {
  return typeof sessionId === "string" && sessionId.length > 0 && sessionId === trackedSessionId;
}

function without(values: readonly string[], key: string): readonly string[] {
  return values.includes(key) ? values.filter((value) => value !== key) : [...values];
}

/** 每回合只记一次：停止终态与取消结束可能先后到达同一会话。 */
function withSettled(state: GoalTurnState, key: string): readonly string[] {
  return state.settled.includes(key) ? state.settled : [...state.settled, key];
}

/** 每回合只记一次暂停/受阻标记（同一终态重复投递不重复入列）。 */
function withSuppressed(values: readonly string[], key: string): readonly string[] {
  return values.includes(key) ? values : [...values, key];
}
