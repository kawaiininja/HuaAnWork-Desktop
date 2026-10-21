import assert from "node:assert/strict";
import { test } from "vitest";
import { createHostExitGate, probeAnswered, reduceLiveness, type Liveness } from "../src/huaanwork-host/host-liveness.ts";

const start: Liveness = { phase: "ok", turns: 1, lastOkMs: 0 };

test("fifteen seconds without an answer is suspect, sixty with a live turn is stoppable", () => {
  const suspect = reduceLiveness(start, { kind: "probe-miss", atMs: 15_000 });
  assert.equal(suspect.phase, "suspect");
  const idle = reduceLiveness({ ...suspect, turns: 0 }, { kind: "probe-miss", atMs: 60_000 });
  assert.equal(idle.phase, "suspect");
  const stoppable = reduceLiveness(suspect, { kind: "probe-miss", atMs: 60_000 });
  assert.equal(stoppable.phase, "stoppable");
  assert.equal(reduceLiveness(stoppable, { kind: "probe-ok", atMs: 61_000 }).phase, "ok");
});

test("only a status reply from the Host loop counts as an answer", () => {
  assert.equal(probeAnswered({ pid: 4321, services: { aaRuntime: false, aaOnboarding: false } }), true);
  assert.equal(probeAnswered({ ok: true }), false);
  assert.equal(probeAnswered(undefined), false);
  assert.equal(probeAnswered({ pid: "4321" }), false);
});

test("a requested Host stop is a stop, not an unexpected failure", () => {
  const gate = createHostExitGate();
  // Before boot nothing has been promised to a renderer, so an exit stays silent.
  assert.equal(gate.disposition(), "silent");

  gate.markBooted();
  assert.equal(gate.disposition(), "failure");

  // The flag is set before child.kill(); the exit that follows must never reach onFailure.
  gate.markStoppedByUser();
  assert.equal(gate.stoppedByUser, true);
  assert.equal(gate.disposition(), "user-stop");

  // An app-requested teardown after the user stop stays off every exit report.
  gate.markStopping();
  assert.equal(gate.disposition(), "silent");
});

test("a stop marked before the exit is still a user stop, even if boot completed first", () => {
  const gate = createHostExitGate();
  gate.markBooted();
  gate.markStoppedByUser();
  assert.equal(gate.disposition(), "user-stop");
});

test("a stopped phase is terminal: a late probe cannot revive liveness or the stop button", () => {
  const stopped: Liveness = { phase: "stopped", turns: 3, lastOkMs: 0 };
  assert.equal(reduceLiveness(stopped, { kind: "turn-count", atMs: 1, turns: 0 }), stopped);
  assert.equal(reduceLiveness(stopped, { kind: "probe-miss", atMs: 90_000 }), stopped);
  assert.equal(reduceLiveness(stopped, { kind: "probe-ok", atMs: 90_000 }), stopped);
});
