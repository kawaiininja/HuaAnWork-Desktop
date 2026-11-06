import assert from "node:assert/strict";
import { test } from "vitest";
import {
  canStartStop,
  consumeBufferedStaleEnds,
  consumeStaleIdle,
  finishStop,
  isStopPending,
  rememberStale,
  sessionStopRequested,
  takeHeldEnds,
  type StopTicket,
} from "../../src/client-huaanwork/logic/stopGate.ts";

const ticket: StopTicket = { id: 1, sessionId: "huaanwork-weather", epoch: 4 };

test("a session end waits only while that session's cancel is in flight", () => {
  assert.equal(isStopPending(ticket, "huaanwork-weather"), true);
  assert.equal(isStopPending(null, "huaanwork-weather"), false);
  assert.equal(isStopPending(ticket, "other"), false);
  assert.equal(canStartStop(null), true);
  assert.equal(canStartStop(ticket), false);
});

test("a stop is in effect while its cancel is in flight or after it arms the latch", () => {
  // 取消在飞：目标驱动的 paused 终态先到也算停止。
  assert.equal(sessionStopRequested(ticket, null, "huaanwork-weather"), true);
  // 取消已成功、闩锁仍扣着。
  assert.equal(sessionStopRequested(null, "huaanwork-weather", "huaanwork-weather"), true);
  // 别的会话或没有会话 id 不算。
  assert.equal(sessionStopRequested(ticket, "huaanwork-weather", "other"), false);
  assert.equal(sessionStopRequested(null, null, "huaanwork-weather"), false);
  assert.equal(sessionStopRequested(ticket, null, undefined), false);
  assert.equal(sessionStopRequested(null, "", ""), false);
});

test("a cancel arms the latch only for the turn that is still current", () => {
  assert.equal(finishStop({ ticket, pending: ticket, currentEpoch: 4, ok: true, latchOwner: null }).arm, true);
  const stale = finishStop({ ticket, pending: ticket, currentEpoch: 5, ok: true, latchOwner: null });
  assert.equal(stale.arm, false);
  assert.deepEqual(stale.stale, { sessionId: "huaanwork-weather", epoch: 4 });
  assert.equal(finishStop({ ticket, pending: null, currentEpoch: 4, ok: true, latchOwner: null }).arm, false);
});

test("a failed cancel clears only the latch that same call armed", () => {
  assert.equal(finishStop({ ticket, pending: ticket, currentEpoch: 4, ok: false, latchOwner: 1 }).clearLatch, true);
  assert.equal(finishStop({ ticket, pending: ticket, currentEpoch: 4, ok: false, latchOwner: 9 }).clearLatch, false);
  assert.equal(finishStop({ ticket, pending: ticket, currentEpoch: 4, ok: true, latchOwner: 1 }).clearLatch, false);
});

test("an idle end from the stopped turn is dropped after a newer send", () => {
  const older = { sessionId: "huaanwork-weather", epoch: 4 };
  const newer = { sessionId: "huaanwork-weather", epoch: 5 };
  const both = rememberStale(rememberStale([], older), newer);
  assert.deepEqual(both, [older, newer]);
  const cancelled = consumeStaleIdle(both, { sessionId: "huaanwork-weather", cancelled: true }, 5);
  assert.equal(cancelled.drop, true);
  assert.deepEqual(cancelled.stale, both);
  const idle = consumeStaleIdle(cancelled.stale, { sessionId: "huaanwork-weather" }, 5);
  assert.equal(idle.drop, true);
  assert.deepEqual(idle.stale, [newer]);
  const current = consumeStaleIdle([newer], { sessionId: "huaanwork-weather" }, 5);
  assert.equal(current.drop, false);
  assert.deepEqual(current.stale, []);
  assert.deepEqual(consumeStaleIdle([], { sessionId: "huaanwork-weather" }, 5), {
    drop: false,
    stale: [],
  });
});

test("a buffered idle end from the stopped turn uses up its stale marker", () => {
  const marker = { sessionId: "huaanwork-weather", epoch: 3 };
  const consumed = consumeBufferedStaleEnds(
    [marker],
    [{ event: "session/end", sessionId: "huaanwork-weather" }],
    () => 3,
  );
  assert.deepEqual(consumed.stale, [], "当前轮的空闲结束用掉标记");
  assert.deepEqual(consumed.clearedSessionIds, ["huaanwork-weather"]);
});

test("a buffered idle end from a newer turn drops the marker but not the stop latch", () => {
  const marker = { sessionId: "huaanwork-weather", epoch: 3 };
  const consumed = consumeBufferedStaleEnds(
    [marker],
    [{ event: "session/end", sessionId: "huaanwork-weather" }],
    () => 4,
  );
  // 这条结束属于新的一轮：丢弃它，但标记不能留下来吞掉下一回合自己的结束。
  assert.deepEqual(consumed.stale, [], "标记失效，不再毒害后续回合");
  assert.deepEqual(consumed.clearedSessionIds, [], "它不是被停止的那一轮的空闲结束");
});

test("a cancelled buffered end leaves the stale marker in place", () => {
  const marker = { sessionId: "huaanwork-weather", epoch: 3 };
  const cancelled = [{ event: "session/end", sessionId: "huaanwork-weather", cancelled: true }];
  const current = consumeBufferedStaleEnds([marker], cancelled, () => 3);
  assert.deepEqual(current.stale, [marker], "取消结束只用掉标记会丢掉随后的空闲结束");
  assert.deepEqual(current.clearedSessionIds, []);
  // 更新一轮的取消结束同样保留标记。
  const newer = consumeBufferedStaleEnds([marker], cancelled, () => 4);
  assert.deepEqual(newer.stale, [marker]);
  assert.deepEqual(newer.clearedSessionIds, []);
});

test("buffered events that are not an end for a marked session leave markers alone", () => {
  const marker = { sessionId: "huaanwork-weather", epoch: 3 };
  const consumed = consumeBufferedStaleEnds(
    [marker],
    [
      { event: "goal/state", sessionId: "huaanwork-weather" },
      { event: "session/end", sessionId: "other" },
      { event: "session/end" },
    ],
    () => 3,
  );
  assert.deepEqual(consumed.stale, [marker]);
  assert.deepEqual(consumed.clearedSessionIds, []);
  assert.deepEqual(consumeBufferedStaleEnds([], [{ event: "session/end", sessionId: "a" }], () => 1), {
    stale: [],
    clearedSessionIds: [],
  });
});

test("a consumed buffered end keeps a later turn's idle end", () => {
  // 停止落在第 3 轮：标记与下一次发送缓冲里的第 3 轮空闲结束相遇，标记被用掉。
  const marker = { sessionId: "huaanwork-weather", epoch: 3 };
  const consumed = consumeBufferedStaleEnds(
    [marker],
    [{ event: "session/end", sessionId: "huaanwork-weather" }],
    () => 3,
  );
  assert.deepEqual(consumed.stale, []);
  assert.deepEqual(consumed.clearedSessionIds, ["huaanwork-weather"]);
  // 第 4 轮自己的空闲结束不能再被残留标记吞掉。
  assert.deepEqual(consumeStaleIdle(consumed.stale, { sessionId: "huaanwork-weather" }, 4), {
    drop: false,
    stale: [],
  });
});

test("releasing a cancel returns only that session's held ends", () => {
  const held = [
    { sessionId: "huaanwork-weather", cancelled: true },
    { sessionId: "other", ok: true },
    { sessionId: "huaanwork-weather", ok: true },
  ];
  const released = takeHeldEnds(held, "huaanwork-weather", (event) => event.sessionId);
  assert.deepEqual(released.taken.map((event) => event.sessionId), ["huaanwork-weather", "huaanwork-weather"]);
  assert.deepEqual(released.rest, [{ sessionId: "other", ok: true }]);
});
