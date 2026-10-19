import assert from "node:assert/strict";
import { test } from "vitest";
import { reduceLiveness, type Liveness } from "../src/host-liveness.ts";

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
