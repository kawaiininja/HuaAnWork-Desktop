import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveActiveTab } from "../../src/client-huaanwork/logic/chatTabs.ts";

test("a removed tab selection falls back to a tab that exists", () => {
  assert.equal(resolveActiveTab("gone", [{ id: "work-1" }, { id: "work-2" }]), "work-1");
  assert.equal(resolveActiveTab("work-2", [{ id: "work-1" }, { id: "work-2" }]), "work-2");
  assert.equal(resolveActiveTab("gone", []), "gone");
});
