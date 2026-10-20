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
  readonly settled: readonly string[];
};

export const INITIAL_GOAL_TURN_STATE: GoalTurnState = {
  phases: {},
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
 * 裁定：只有 `active` 抑制每轮结束结论。`complete`、`paused`、非 round-limit 的
 * `blocked` 都是终结态；round-limit 由专用停止文案结算，不再写普通结论。
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
        state: { ...state, settled: without(state.settled, key) },
        action: NOTHING,
      };
    case "goal-cleared": {
      // 目标已清空：忘掉相位，后续结束按「没有目标」正常写结论。
      const phases = { ...state.phases };
      delete phases[key];
      return { state: { ...state, phases }, action: NOTHING };
    }
    case "goal-state": {
      const previous = state.phases[key];
      const edge = goalTurnEdge(previous, event.phase);
      const phases = { ...state.phases, [key]: event.phase };
      // 用户停止时的终态不是验收结论：官方 goal-round-driver 在空闲处理里先把目标
      // 暂停，桥随后才发取消结束。这里只结算，「已停止」由停止流程自己写，
      // 迟到的取消结束不会补写。注意：用户主动 `/goal pause` 也会走到 paused 相位，
      // 但那是另一条产品路径，本判定不覆盖它（是否也应静默属于单独的产品决定）。
      if (event.stopped === true) {
        return { state: { ...state, phases, settled: withSettled(state, key) }, action: NOTHING };
      }
      // start 只更新相位（供 session/end 判断是否抑制）；结算窗口由 turn-started 开启，
      // 所以同一用户回合里 pause → resume → complete 仍只写一次结论。
      // 抑制中（例如 round-limit 的专用文案已写）或没有边沿的重复投递同样不再写。
      if (edge !== "finish" || state.settled.includes(key)) {
        return { state: { ...state, phases }, action: NOTHING };
      }
      return {
        state: { ...state, phases, settled: [...state.settled, key] },
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
