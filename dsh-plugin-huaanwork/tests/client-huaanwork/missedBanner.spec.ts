import assert from "node:assert/strict";
import { test } from "vitest";

import { missedBannerView, nextMissedCount } from "../../src/client-huaanwork/logic/missedBanner.ts";

test("hidden when no automation/missed events received yet", () => {
  assert.deepEqual(missedBannerView(0, false), { visible: false, count: 0 });
});

test("visible with the received count once at least one missed event arrived", () => {
  assert.deepEqual(missedBannerView(1, false), { visible: true, count: 1 });
  assert.deepEqual(missedBannerView(3, false), { visible: true, count: 3 });
});

test("hidden after dismissed, even though the count stays positive", () => {
  assert.deepEqual(missedBannerView(3, true), { visible: false, count: 3 });
});

test("nextMissedCount increments while not dismissed", () => {
  assert.equal(nextMissedCount(0, false), 1);
  assert.equal(nextMissedCount(4, false), 5);
});

test("nextMissedCount stops accumulating once dismissed this session", () => {
  assert.equal(nextMissedCount(2, true), 2);
  assert.equal(nextMissedCount(0, true), 0);
});
