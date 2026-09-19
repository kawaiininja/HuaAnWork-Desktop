import assert from "node:assert/strict";
import { test } from "vitest";

import { authFormReady } from "../../src/client-huaanwork/logic/authForm.ts";

test("login enables only with 2–32 name and 8+ password", () => {
  assert.equal(authFormReady(false, "a", "12345678", ""), false);
  assert.equal(authFormReady(false, "ab", "1234567", ""), false);
  assert.equal(authFormReady(false, "ab", "12345678", ""), true);
  assert.equal(authFormReady(false, "  华安  ", "password1", ""), true);
});

test("register also requires matching confirm", () => {
  assert.equal(authFormReady(true, "user", "12345678", "12345679"), false);
  assert.equal(authFormReady(true, "user", "12345678", "12345678"), true);
});
