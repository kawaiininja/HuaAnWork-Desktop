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

test("pnpm-busy maps to busy (D12: pnpm service mutex surfaced via asPnpmBusy)", () => {
  assert.equal(classifyMarketError("pnpm-busy"), "busy");
});

test("unregistered market routes classify as not-registered (D10)", () => {
  // webserver 对未注册路由的统一应答：404 + code 'not-found'。
  assert.equal(classifyMarketError("not-found"), "not-registered");
  // frontend-static fallback 回 HTML（无 code 可解析）时按 HTTP 状态判定。
  assert.equal(classifyMarketError(undefined, 404), "not-registered");
  assert.equal(classifyMarketError(undefined, 405), "not-registered");
  // 其他无 code 状态仍是 unknown。
  assert.equal(classifyMarketError(undefined, 500), "unknown");
  assert.equal(classifyMarketError(undefined), "unknown");
});

test("unreachable presentation offers the local-install bypass hint (Task 7: tab now exists)", () => {
  const presentation = marketErrorPresentation("unreachable");
  assert.equal(presentation.canBypass, true);
  assert.match(presentation.body, /本地安装/);
  assert.match(presentation.body, /本地目录或 \.tgz/);
  // Task 6 的占位口径（「将在后续版本并入本页」）不得回潮。
  assert.doesNotMatch(presentation.body, /后续版本/);
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

test("not-registered presentation points at the settings entry (D10)", () => {
  const presentation = marketErrorPresentation("not-registered");
  assert.equal(presentation.canBypass, false);
  assert.match(presentation.body, /设置/);
  assert.match(presentation.body, /huaanwork-market/);
});

test("no presentation other than unreachable offers a bypass (R23)", () => {
  for (const kind of ["verification", "sha256", "install-gate", "busy", "not-registered", "unknown"] as const) {
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

test("unknown presentations keep the server-side message for diagnosis (D12)", () => {
  // plugin-error 500（如 dsh plugin add failed (exit 254)）等最常真实发生的
  // 失败没有专属分类——原文必须出现在正文里，排障线索不得归零。
  const withMessage = presentMarketError(new Error("dsh plugin add failed (exit 254)"));
  assert.equal(withMessage.kind, "unknown");
  assert.match(withMessage.body, /dsh plugin add failed \(exit 254\)/);
  assert.match(withMessage.body, /操作失败/);

  const noMessage = presentMarketError(new Error(""));
  assert.equal(noMessage.body, "操作失败，请稍后重试或联系市场管理员。");

  // marketFetch 的 .status 也被消费：无 code 的 404 → not-registered。
  const unregistered = new Error("HTTP 404") as Error & { status?: number };
  unregistered.status = 404;
  assert.equal(presentMarketError(unregistered).kind, "not-registered");
});
