import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { apply as applyWeb } from "../../src/huaanwork-guardrails/web.ts";

type ToolDefinition = {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

function createCtx(profileDir: string, workspaceRoot: string) {
  const registered: ToolDefinition[] = [];
  const ctx = {
    huaanworkProfileDir: profileDir,
    huaanworkWorkspaceRoot: { current: workspaceRoot },
    tools: {
      register(definition: ToolDefinition) {
        registered.push(definition);
        return () => {};
      },
    },
  };
  return { ctx, registered };
}

function writeSettings(dir: string, allowNetwork: boolean): void {
  writeFileSync(join(dir, "huaanwork-settings.json"), JSON.stringify({ allow_network: allowNetwork }));
}

test("web 接线注册 web_fetch 与 screenshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "huaanwork-web-"));
  const { ctx, registered } = createCtx(dir, dir);
  applyWeb(ctx as never);
  assert.deepEqual(registered.map((t) => t.name).sort(), ["screenshot", "web_fetch"]);
});

test("attachments 经 ctx.inject 订阅，而不是读未注入字段", () => {
  const dir = mkdtempSync(join(tmpdir(), "huaanwork-web-"));
  const { ctx, registered } = createCtx(dir, dir);
  const injected: string[][] = [];
  (ctx as { inject: (names: readonly string[], cb: (inner: unknown) => void) => void }).inject = (names, cb) => {
    injected.push([...names]);
    cb({ get: () => undefined });
  };
  applyWeb(ctx as never);
  assert.deepEqual(injected, [["attachments"]]);
  assert.deepEqual(registered.map((t) => t.name).sort(), ["screenshot", "web_fetch"]);
});

test("web_fetch：allow_network=off 时公网被拒、局域网放行（真 fetch 不发出）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "huaanwork-web-"));
  writeSettings(dir, false);
  const { ctx, registered } = createCtx(dir, dir);
  applyWeb(ctx as never);
  const tool = registered.find((t) => t.name === "web_fetch")!;

  const blocked = (await tool.execute({ url: "https://example.com" })) as { ok: boolean; error?: string };
  assert.equal(blocked.ok, false);
  assert.match(blocked.error ?? "", /设置 → 权限/);

  // 局域网地址放行后会真发请求并失败（127.0.0.1:9 不可达）——证明门控放行而非拦截。
  const lan = (await tool.execute({ url: "http://127.0.0.1:9/", timeoutMs: 500 })) as { ok: boolean; error?: string };
  assert.equal(lan.ok, false);
  assert.doesNotMatch(lan.error ?? "", /设置 → 权限/);
});

test("web_fetch：allow_network 缺失时按 false 处理（fail-closed）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "huaanwork-web-"));
  const { ctx, registered } = createCtx(dir, dir); // 不写 settings 文件
  applyWeb(ctx as never);
  const tool = registered.find((t) => t.name === "web_fetch")!;
  const result = (await tool.execute({ url: "https://example.com" })) as { ok: boolean };
  assert.equal(result.ok, false);
});
