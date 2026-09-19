import assert from "node:assert/strict";
import { test } from "vitest";

import {
  GUARD_MODE_LABELS,
  GUARD_MODES,
  commitGuardMode,
  nextGuardMode,
  parseGuardMode,
  shouldConfirmFull,
} from "../../src/client-huaanwork/logic/guardMode.ts";

test("nextGuardMode cycles ask → smart → full → ask", () => {
  assert.equal(nextGuardMode("ask"), "smart");
  assert.equal(nextGuardMode("smart"), "full");
  assert.equal(nextGuardMode("full"), "ask");
  assert.deepEqual([...GUARD_MODES], ["ask", "smart", "full"]);
  for (const mode of GUARD_MODES) {
    assert.ok(GUARD_MODE_LABELS[mode].label.length > 0);
    assert.ok(GUARD_MODE_LABELS[mode].tooltip.length > 0);
  }
});

test("parseGuardMode whitelists three values and falls back to ask", () => {
  assert.equal(parseGuardMode("ask"), "ask");
  assert.equal(parseGuardMode("smart"), "smart");
  assert.equal(parseGuardMode("full"), "full");
  assert.equal(parseGuardMode(undefined), "ask");
  assert.equal(parseGuardMode("bypass"), "ask");
  assert.equal(parseGuardMode(3), "ask");
});

test("every entry into full requires confirmation", () => {
  assert.equal(shouldConfirmFull("full"), true);
  assert.equal(shouldConfirmFull("smart"), false);
  assert.equal(shouldConfirmFull("ask"), false);
});

test("commitGuardMode persists and rolls back on failure", async () => {
  const seen: string[] = [];
  const ok = await commitGuardMode("ask", "smart", async (mode) => {
    seen.push(mode);
  });
  assert.deepEqual(ok, { mode: "smart" });
  assert.deepEqual(seen, ["smart"]);

  const failed = await commitGuardMode("smart", "full", async () => {
    throw new Error("磁盘只读");
  });
  assert.equal(failed.mode, "smart", "must roll back to the pre-switch mode");
  assert.equal(failed.error, "磁盘只读");
});
