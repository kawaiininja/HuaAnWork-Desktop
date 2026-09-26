import assert from "node:assert/strict";
import { test } from "vitest";

import {
  classifyMarketError,
  marketErrorPresentation,
  presentMarketError,
} from "../../src/client-huaanwork/logic/marketErrors.ts";

test("classifyMarketError maps wrapper codes to the three distinguished states", () => {
  assert.equal(classifyMarketError("market-unreachable"), "unreachable");
  assert.equal(classifyMarketError("market-config"), "unreachable");
  assert.equal(classifyMarketError("market-verification-failed"), "verification");
  assert.equal(classifyMarketError("market-verification-unavailable"), "verification");
  assert.equal(classifyMarketError("market-sha256-mismatch"), "sha256");
  assert.equal(classifyMarketError("market-execute-busy"), "busy");
  assert.equal(classifyMarketError("market-install-gate"), "install-gate");
  assert.equal(classifyMarketError("market-artifact-origin"), "install-gate");
  assert.equal(classifyMarketError(undefined), "unknown");
  assert.equal(classifyMarketError("internal"), "unknown");
});

test("unreachable presentation offers the local-install bypass hint", () => {
  const presentation = marketErrorPresentation("unreachable");
  assert.equal(presentation.canBypass, true);
  assert.match(presentation.body, /本地安装/);
});

test("verification failure is fail-closed with the mandated copy", () => {
  const presentation = marketErrorPresentation("verification");
  assert.equal(presentation.canBypass, false);
  assert.equal(presentation.body, "目录签名校验失败，已拒绝；请联系市场管理员或检查信任锚。");
});

test("sha256 mismatch is fail-closed with the mandated copy", () => {
  const presentation = marketErrorPresentation("sha256");
  assert.equal(presentation.canBypass, false);
  assert.equal(presentation.body, "插件文件校验失败，已拒绝安装。");
});

test("no presentation other than unreachable offers a bypass (R23)", () => {
  for (const kind of ["verification", "sha256", "install-gate", "busy", "unknown"] as const) {
    assert.equal(marketErrorPresentation(kind).canBypass, false, kind);
  }
});

test("presentMarketError reads .code from Error and falls back to unknown", () => {
  const error = new Error("boom") as Error & { code?: string };
  error.code = "market-sha256-mismatch";
  assert.equal(presentMarketError(error).kind, "sha256");
  assert.equal(presentMarketError(new Error("plain")).kind, "unknown");
  assert.equal(presentMarketError("not an error").kind, "unknown");
});
