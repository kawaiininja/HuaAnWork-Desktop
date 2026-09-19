import assert from "node:assert/strict";
import { test } from "vitest";

import { buildUnattendedAllow, UNATTENDED_DEFAULT_BASE } from "../../src/client-huaanwork/logic/unattendedAllow.ts";

test("create mode (no stored allow) uses the default base list", () => {
  assert.deepEqual(buildUnattendedAllow({ storedAllow: undefined, shellChecked: false }), UNATTENDED_DEFAULT_BASE);
});

test("create mode + shell checked appends bash/pwsh to the default base", () => {
  assert.deepEqual(buildUnattendedAllow({ storedAllow: undefined, shellChecked: true }), [
    ...UNATTENDED_DEFAULT_BASE,
    "bash",
    "pwsh",
  ]);
});

test("edit mode preserves a narrower stored allow instead of falling back to the default", () => {
  // Regression (review finding 3): a task whose stored allow was narrowed to just "read"
  // must not have its allow list replaced by the full default base on an unrelated update.
  assert.deepEqual(buildUnattendedAllow({ storedAllow: ["read"], shellChecked: false }), ["read"]);
});

test("edit mode + shell checked appends bash/pwsh onto the stored (narrower) list", () => {
  assert.deepEqual(buildUnattendedAllow({ storedAllow: ["read"], shellChecked: true }), ["read", "bash", "pwsh"]);
});

test("edit mode + shell unchecked strips bash/pwsh out of a previously-shell-enabled stored list", () => {
  assert.deepEqual(buildUnattendedAllow({ storedAllow: ["read", "write", "bash", "pwsh"], shellChecked: false }), [
    "read",
    "write",
  ]);
});

test("edit mode with an empty stored allow (explicitly narrowed to nothing) stays empty", () => {
  assert.deepEqual(buildUnattendedAllow({ storedAllow: [], shellChecked: false }), []);
});
