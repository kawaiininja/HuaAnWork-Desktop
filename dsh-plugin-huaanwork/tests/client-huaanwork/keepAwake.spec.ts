import assert from "node:assert/strict";
import { test } from "vitest";

import { shouldHoldKeepAwake } from "../../src/client-huaanwork/logic/keepAwake.ts";

test("holds when keep_awake is on and a non-manual automation is enabled", () => {
  assert.equal(
    shouldHoldKeepAwake(true, [{ enabled: true, schedule: { kind: "daily" } }]),
    true,
  );
});

test("does not hold when keep_awake is off, even with enabled automations", () => {
  assert.equal(
    shouldHoldKeepAwake(false, [{ enabled: true, schedule: { kind: "daily" } }]),
    false,
  );
});

test("does not hold when every automation is disabled", () => {
  assert.equal(
    shouldHoldKeepAwake(true, [{ enabled: false, schedule: { kind: "daily" } }]),
    false,
  );
});

test("does not hold when the only enabled automations are manual", () => {
  assert.equal(
    shouldHoldKeepAwake(true, [
      { enabled: true, schedule: { kind: "manual" } },
      { enabled: false, schedule: { kind: "daily" } },
    ]),
    false,
  );
});

test("does not hold with an empty automation list", () => {
  assert.equal(shouldHoldKeepAwake(true, []), false);
});

test("holds if at least one of several automations qualifies", () => {
  assert.equal(
    shouldHoldKeepAwake(true, [
      { enabled: true, schedule: { kind: "manual" } },
      { enabled: false, schedule: { kind: "cron" } },
      { enabled: true, schedule: { kind: "cron" } },
    ]),
    true,
  );
});
