import assert from "node:assert/strict";
import { test } from "vitest";
import { probeAnswered, reduceLiveness, type Liveness } from "../src/huaanwork-host/host-liveness.ts";

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
