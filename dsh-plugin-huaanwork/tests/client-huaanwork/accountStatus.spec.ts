import assert from "node:assert/strict";
import { test } from "vitest";

import { parseTheme, resolveTheme, sidecarStatus } from "../../src/client-huaanwork/logic/accountStatus.ts";

test("sidecarStatus maps the three tones", () => {
  assert.deepEqual(sidecarStatus(true, false), { tone: "ok", label: "sidecar 就绪" });
  assert.deepEqual(sidecarStatus(false, false), { tone: "wait", label: "sidecar 启动中…" });
  assert.deepEqual(sidecarStatus(false, true), { tone: "dead", label: "sidecar 已退出，请重启应用" });
  assert.deepEqual(sidecarStatus(true, true), { tone: "dead", label: "sidecar 已退出，请重启应用" });
});

test("parseTheme keeps legal values and falls back to system", () => {
  assert.equal(parseTheme("light"), "light");
  assert.equal(parseTheme("dark"), "dark");
  assert.equal(parseTheme("system"), "system");
  assert.equal(parseTheme(undefined), "system");
  assert.equal(parseTheme(""), "system");
  assert.equal(parseTheme("foo"), "system");
});

test("resolveTheme follows preference then system", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});
