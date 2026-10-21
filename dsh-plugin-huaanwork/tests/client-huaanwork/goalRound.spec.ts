import assert from "node:assert/strict";
import { test } from "vitest";
import {
  GOAL_ROUND_LIMIT,
  INITIAL_GOAL_TURN_STATE,
  goalRoundDrivesTurn,
  goalRoundLabel,
  goalRoundStopped,
  goalTurnEdge,
  reduceGoalTurn,
  type GoalTurnAction,
  type GoalTurnEvent,
  type GoalTurnState,
} from "../../src/client-huaanwork/logic/goalRound.ts";

const SESSION = "huaanwork-0123456789abcdef";
const BACKGROUND = "huaanwork-ffffffffffffffff";

test("goal rounds stop at four and keep the gaps", () => {
  assert.equal(GOAL_ROUND_LIMIT, 4);
  assert.equal(goalRoundLabel(2), "正在按目标继续，第 2/4 轮，这还不是验收结果");
  assert.equal(goalRoundStopped(4, ["缺少文件：报告.md"]), "已停在第 4/4 轮。尚未核对：缺少文件：报告.md");
});

test("goalRoundStopped says 无 when nothing is left unchecked", () => {
  assert.equal(goalRoundStopped(4, []), "已停在第 4/4 轮。尚未核对：无");
});

test("goalTurnEdge names the edges that start and finish a tracked turn", () => {
  assert.equal(goalTurnEdge(undefined, "active"), "start");
  assert.equal(goalTurnEdge("complete", "active"), "start");
  assert.equal(goalTurnEdge("paused", "active"), "start");
  assert.equal(goalTurnEdge("active", "active"), undefined);
  assert.equal(goalTurnEdge("active", "complete"), "finish");
  assert.equal(goalTurnEdge("active", "paused"), "finish");
  assert.equal(goalTurnEdge("active", "blocked"), "finish");
  assert.equal(goalTurnEdge("paused", "paused"), undefined);
  assert.equal(goalTurnEdge("blocked", "complete"), "finish");
});

/** 按 App 的调用顺序把事件序列喂给生产用状态机，返回每一步的动作。 */
function drive(events: readonly GoalTurnEvent[], initial: GoalTurnState = INITIAL_GOAL_TURN_STATE): GoalTurnAction[] {
  let state = initial;
  const actions: GoalTurnAction[] = [];
  for (const event of events) {
    const result = reduceGoalTurn(state, event);
    state = result.state;
    actions.push(result.action);
  }
  return actions;
}

function kinds(actions: readonly GoalTurnAction[]): string[] {
  return actions.map((action) => action.kind);
}

test("an active goal suppresses every per-round outcome; the round limit writes the stop message instead", () => {
  const actions = drive([
    { kind: "turn-started", sessionId: SESSION },
    { kind: "goal-state", phase: "active", roundsStarted: 1, sessionId: SESSION },
    // rounds 1-3 finish; each `session/end ok` must stay silent.
    { kind: "session-end", sessionId: SESSION, ok: true },
    { kind: "session-end", sessionId: SESSION, ok: true },
    { kind: "session-end", sessionId: SESSION, ok: true },
    // round 4 hits the cap: the dedicated stop sentence, then a terminal blocked state.
    { kind: "goal-round-limit", round: 4, sessionId: SESSION },
    { kind: "goal-state", phase: "blocked", roundsStarted: 4, sessionId: SESSION },
    { kind: "session-end", sessionId: SESSION, ok: true },
  ]);
  assert.deepEqual(actions, [
    { kind: "none" },
    { kind: "none" },
    { kind: "none" },
    { kind: "none" },
    { kind: "none" },
    { kind: "goal-stopped", round: 4 },
    { kind: "none" },
    { kind: "none" },
  ]);
  // The labels stay as labels; no intermediate "已完成" can come out of this sequence.
  assert.equal(goalRoundLabel(1), "正在按目标继续，第 1/4 轮，这还不是验收结果");
  assert.equal(goalRoundLabel(2), "正在按目标继续，第 2/4 轮，这还不是验收结果");
  assert.equal(goalRoundLabel(3), "正在按目标继续，第 3/4 轮，这还不是验收结果");
  assert.equal(goalRoundStopped(4, []), "已停在第 4/4 轮。尚未核对：无");
});

test("goal completion writes exactly one outcome, whichever event lands first", () => {
  const completeFirst = drive([
    { kind: "turn-started", sessionId: SESSION },
    { kind: "goal-state", phase: "active", sessionId: SESSION },
    { kind: "goal-state", phase: "complete", roundsStarted: 3, sessionId: SESSION },
    { kind: "session-end", sessionId: SESSION, ok: true },
  ]);
  assert.deepEqual(kinds(completeFirst), ["none", "none", "outcome", "none"]);

  const endFirst = drive([
    { kind: "turn-started", sessionId: SESSION },
    { kind: "goal-state", phase: "active", sessionId: SESSION },
    { kind: "session-end", sessionId: SESSION, ok: true },
    { kind: "goal-state", phase: "complete", roundsStarted: 3, sessionId: SESSION },
    { kind: "session-end", sessionId: SESSION, ok: true },
  ]);
  assert.deepEqual(kinds(endFirst), ["none", "none", "none", "outcome", "none"]);

  const duplicated = drive([
    { kind: "turn-started", sessionId: SESSION },
    { kind: "goal-state", phase: "active", sessionId: SESSION },
    { kind: "goal-state", phase: "complete", roundsStarted: 3, sessionId: SESSION },
    { kind: "goal-state", phase: "complete", roundsStarted: 3, sessionId: SESSION },
    { kind: "session-end", sessionId: SESSION, ok: true },
  ]);
  assert.deepEqual(kinds(duplicated), ["none", "none", "outcome", "none", "none"]);
});

test("a paused or non-round-limit blocked goal never claims 已完成", () => {
  // 只有 goal/state complete 是验收结论:paused / blocked 不是「已完成」的证据。
  for (const phase of ["paused", "blocked"] as const) {
    const actions = drive([
      { kind: "turn-started", sessionId: SESSION },
      { kind: "goal-state", phase: "active", sessionId: SESSION },
      { kind: "goal-state", phase, roundsStarted: 2, sessionId: SESSION },
      { kind: "session-end", sessionId: SESSION, ok: true },
    ]);
    assert.deepEqual(kinds(actions), ["none", "none", "none", "none"], phase);
  }
});

test("an input-card cancel pauses the goal before the cancelled end and writes no 已完成", () => {
  // 真实顺序(cancelRouteInput → agent.cancel → goal-round-driver 空闲处理先 pause,
  // 再发 session/end cancelled):App 的停止信号只认用户按停止,这条 paused 不是 stopped。
  const actions = drive([
    { kind: "turn-started", sessionId: SESSION },
    { kind: "goal-state", phase: "active", sessionId: SESSION },
    { kind: "goal-state", phase: "paused", roundsStarted: 1, sessionId: SESSION },
    { kind: "session-end", sessionId: SESSION, ok: true, cancelled: true },
  ]);
  assert.deepEqual(kinds(actions), ["none", "none", "none", "none"]);
});

test("a /goal pause pauses without a stop flag and still writes no 已完成", () => {
  // `/goal pause` 不经过用户停止:goal/state paused 到达时 stopped=false。
  // 若回合随后正常结束,暂停的目标也不是验收结论。
  const paused = drive([
    { kind: "turn-started", sessionId: SESSION },
    { kind: "goal-state", phase: "active", sessionId: SESSION },
    { kind: "goal-state", phase: "paused", roundsStarted: 2, sessionId: SESSION, stopped: false },
    { kind: "session-end", sessionId: SESSION, ok: true },
  ]);
  assert.deepEqual(kinds(paused), ["none", "none", "none", "none"]);

  // 之后恢复并真正完成时,仍然只由 complete 写一次结论。
  const resumed = drive([
    { kind: "turn-started", sessionId: SESSION },
    { kind: "goal-state", phase: "active", sessionId: SESSION },
    { kind: "goal-state", phase: "paused", roundsStarted: 2, sessionId: SESSION },
    { kind: "goal-state", phase: "active", sessionId: SESSION },
    { kind: "goal-state", phase: "complete", roundsStarted: 3, sessionId: SESSION },
    { kind: "session-end", sessionId: SESSION, ok: true },
  ]);
  assert.deepEqual(kinds(resumed), ["none", "none", "none", "none", "outcome", "none"]);
});

test("pausing and resuming inside one user turn writes only the completion outcome", () => {
  const actions = drive([
    { kind: "turn-started", sessionId: SESSION },
    { kind: "goal-state", phase: "active", sessionId: SESSION },
    { kind: "goal-state", phase: "paused", roundsStarted: 1, sessionId: SESSION },
    { kind: "goal-state", phase: "active", sessionId: SESSION },
    { kind: "goal-state", phase: "complete", roundsStarted: 2, sessionId: SESSION },
    { kind: "session-end", sessionId: SESSION, ok: true },
  ]);
  // pause 不再是结论：同一回合恢复后仍只由 complete 写一次。
  assert.deepEqual(kinds(actions), ["none", "none", "none", "none", "outcome", "none"]);
});

test("a cancelled turn settles silently and a late paused goal cannot add 已完成", () => {
  const actions = drive([
    { kind: "turn-started", sessionId: SESSION },
    { kind: "goal-state", phase: "active", sessionId: SESSION },
    { kind: "session-end", sessionId: SESSION, ok: true, cancelled: true },
    { kind: "goal-state", phase: "paused", roundsStarted: 2, sessionId: SESSION },
    { kind: "session-end", sessionId: SESSION, ok: true },
  ]);
  assert.deepEqual(kinds(actions), ["none", "none", "none", "none", "none"]);
});

test("a user stop pauses the goal before the cancelled end and writes no completion", () => {
  // 真实顺序：官方 goal-round-driver 在空闲处理里先暂停目标（goal/state paused），
  // 桥随后才发出 session/end cancelled。停止期间这条 paused 只能结算，不能写结论。
  const steps: GoalTurnEvent[] = [
    { kind: "turn-started", sessionId: SESSION },
    { kind: "goal-state", phase: "active", sessionId: SESSION },
    { kind: "goal-state", phase: "paused", roundsStarted: 1, sessionId: SESSION, stopped: true },
    { kind: "session-end", sessionId: SESSION, ok: true, cancelled: true },
    // 再迟到的终态与结束也不补写。
    { kind: "goal-state", phase: "paused", roundsStarted: 1, sessionId: SESSION, stopped: true },
    { kind: "session-end", sessionId: SESSION, ok: true },
  ];
  const actions = drive(steps);
  assert.deepEqual(kinds(actions), ["none", "none", "none", "none", "none", "none"]);

  // 停止终态与取消结束都会结算同一会话，`settled` 里不能出现两次。
  let reduced = INITIAL_GOAL_TURN_STATE;
  for (const event of steps) reduced = reduceGoalTurn(reduced, event).state;
  assert.deepEqual(reduced.settled, [SESSION]);
});

test("a normal paused goal stays neutral even when no stop is in effect", () => {
  const actions = drive([
    { kind: "turn-started", sessionId: SESSION },
    { kind: "goal-state", phase: "active", sessionId: SESSION },
    { kind: "goal-state", phase: "paused", roundsStarted: 2, sessionId: SESSION, stopped: false },
    { kind: "session-end", sessionId: SESSION, ok: true },
  ]);
  assert.deepEqual(kinds(actions), ["none", "none", "none", "none"]);
});

test("clearing the goal stops suppression for the rest of the turn", () => {
  const actions = drive([
    { kind: "turn-started", sessionId: SESSION },
    { kind: "goal-state", phase: "active", sessionId: SESSION },
    { kind: "goal-cleared", sessionId: SESSION },
    { kind: "session-end", sessionId: SESSION, ok: true },
  ]);
  assert.deepEqual(kinds(actions), ["none", "none", "none", "outcome"]);
});

test("a paused or blocked goal suppresses only the turn it ended, never later unrelated turns", () => {
  // 回归:抑制曾按相位判断,相位停在 paused/blocked 后,该会话每个后续普通回合
  // 的 `session/end ok` 都被吞掉。标记只属于它发生的那一回合。
  for (const phase of ["paused", "blocked"] as const) {
    const actions = drive([
      { kind: "turn-started", sessionId: SESSION },
      { kind: "goal-state", phase: "active", sessionId: SESSION },
      { kind: "goal-state", phase, roundsStarted: 1, sessionId: SESSION },
      { kind: "session-end", sessionId: SESSION, ok: true },
      // 用户没有恢复目标(相位仍是 paused/blocked),下一回合是一次普通对话。
      { kind: "turn-started", sessionId: SESSION },
      { kind: "session-end", sessionId: SESSION, ok: true },
    ]);
    assert.deepEqual(kinds(actions), ["none", "none", "none", "none", "none", "outcome"], phase);
  }
});

test("a new user turn gets its own outcome after a terminal goal", () => {
  const actions = drive([
    { kind: "turn-started", sessionId: SESSION },
    { kind: "goal-state", phase: "active", sessionId: SESSION },
    { kind: "goal-state", phase: "complete", roundsStarted: 2, sessionId: SESSION },
    { kind: "session-end", sessionId: SESSION, ok: true },
    { kind: "turn-started", sessionId: SESSION },
    { kind: "session-end", sessionId: SESSION, ok: true },
  ]);
  assert.deepEqual(kinds(actions), ["none", "none", "outcome", "none", "none", "outcome"]);
});

test("a background goal round never drives the tracked turn and never blocks send", () => {
  assert.equal(goalRoundDrivesTurn(SESSION, SESSION), true);
  assert.equal(goalRoundDrivesTurn(BACKGROUND, SESSION), false);
  assert.equal(goalRoundDrivesTurn(undefined, SESSION), false);
  assert.equal(goalRoundDrivesTurn("", ""), false);

  // A tracked continuation keeps the global turn alive; a background one cannot
  // resurrect it after the user's own turn ended (which is what blocked send()).
  let turnActive = false;
  const onGoalRound = (sessionId: string | undefined, tracked: string | null) => {
    if (goalRoundDrivesTurn(sessionId, tracked)) turnActive = true;
  };
  onGoalRound(SESSION, SESSION);
  assert.equal(turnActive, true);
  turnActive = false; // session/end of the tracked turn
  onGoalRound(BACKGROUND, null);
  assert.equal(turnActive, false);

  // The background session keeps its own per-round outcome suppressed without
  // touching the tracked session's settlement.
  const background = drive([
    { kind: "turn-started", sessionId: BACKGROUND },
    { kind: "goal-state", phase: "active", sessionId: BACKGROUND },
    { kind: "session-end", sessionId: BACKGROUND, ok: true },
  ]);
  assert.deepEqual(kinds(background), ["none", "none", "none"]);
});
