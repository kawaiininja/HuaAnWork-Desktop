import assert from "node:assert/strict";
import { test } from "vitest";
import { canStartStop, consumeStaleIdle, finishStop, isStopPending, rememberStale, takeHeldEnds, type StopTicket } from "../../src/client-huaanwork/logic/stopGate.ts";

const ticket: StopTicket = { id: 1, sessionId: "huaanwork-weather", epoch: 4 };

test("a session end waits only while that session's cancel is in flight", () => {
  assert.equal(isStopPending(ticket, "huaanwork-weather"), true);
  assert.equal(isStopPending(null, "huaanwork-weather"), false);
  assert.equal(isStopPending(ticket, "other"), false);
  assert.equal(canStartStop(null), true);
  assert.equal(canStartStop(ticket), false);
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
