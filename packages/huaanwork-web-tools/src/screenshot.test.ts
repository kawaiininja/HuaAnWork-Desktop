import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CHROME_MISSING_ERROR, screenshot, type BrowserLike } from "./screenshot.ts";
import { NETWORK_GATE_ERROR } from "./web.ts";

const LAN_URL = "http://127.0.0.1/preview"; // 无显式端口：URL.host 即 "127.0.0.1"，与下方文件名断言一致

function fakeBrowser(png: Uint8Array, captured?: { viewport?: unknown; fullPage?: boolean }): BrowserLike {
  return {
    async newPage() {
      return {
        async setViewportSize(v) { if (captured) captured.viewport = v; },
        async goto() {},
        async waitForTimeout() {},
        async screenshot(o) { if (captured) captured.fullPage = o.fullPage; return png; },
      };
    },
    async close() {},
  };
}

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "huaanwork-shot-"));
}

test("门控：off 档公网被拒", async () => {
  const result = await screenshot(
    { url: "https://example.com" },
    { checkNetwork: () => false, workspaceRoot: tempWorkspace(), launch: async () => fakeBrowser(new Uint8Array([1])) },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, NETWORK_GATE_ERROR);
});

test("成功：PNG 落盘 <workspace>/.huaanwork/screenshots/ 并返回路径与字节数", async () => {
  const root = tempWorkspace();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const result = await screenshot(
    { url: LAN_URL },
    { checkNetwork: () => true, workspaceRoot: root, launch: async () => fakeBrowser(png), now: () => 1700000000000 },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.path, /^.*\/\.huaanwork\/screenshots\/1700000000000-127\.0\.0\.1\.png$/);
    assert.equal(result.bytes, 4);
    assert.deepEqual([...readFileSync(result.path)], [...png]);
    assert.equal(result.imageRef, undefined);
  }
  rmSync(root, { recursive: true, force: true });
});

test("saveImage 缝存在时返回 imageRef；视口与 fullPage 透传", async () => {
  const captured: { viewport?: unknown; fullPage?: boolean } = {};
  const result = await screenshot(
    { url: LAN_URL, width: 800, height: 600, fullPage: true, waitMs: 50 },
    {
      checkNetwork: () => true,
      workspaceRoot: tempWorkspace(),
      launch: async () => fakeBrowser(new Uint8Array([1, 2]), captured),
      saveImage: async () => ({ id: "att-1" }),
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.imageRef, { id: "att-1" });
  assert.deepEqual(captured.viewport, { width: 800, height: 600 });
  assert.equal(captured.fullPage, true);
});

test("Playwright 找不到 chrome 发行版时返回指路错误", async () => {
  const result = await screenshot(
    { url: LAN_URL },
    {
      checkNetwork: () => true,
      workspaceRoot: tempWorkspace(),
      launch: async () => {
        throw new Error("Chromium distribution 'chrome' is not found");
      },
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, CHROME_MISSING_ERROR);
});

test("发行版不受支持不算缺 Chrome", async () => {
  const result = await screenshot(
    { url: LAN_URL },
    {
      checkNetwork: () => true,
      workspaceRoot: tempWorkspace(),
      launch: async () => {
        throw new Error("Chromium distribution 'chrome' is not supported on darwin");
      },
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.notEqual(result.error, CHROME_MISSING_ERROR);
    assert.match(result.error, /is not supported on darwin/);
  }
});

test("file: 即使允许公网也不启动浏览器", async () => {
  let launched = false;
  const result = await screenshot(
    { url: "file:///etc/passwd" },
    {
      checkNetwork: () => true,
      workspaceRoot: tempWorkspace(),
      launch: async () => {
        launched = true;
        return fakeBrowser(new Uint8Array([1]));
      },
    },
  );
  assert.equal(launched, false);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "截图目标协议不受支持：file:");
});

test("launch 抛错（无系统 Chrome）返回指路错误", async () => {
  const result = await screenshot(
    { url: LAN_URL },
    {
      checkNetwork: () => true,
      workspaceRoot: tempWorkspace(),
      launch: async () => { throw new Error("Executable doesn't exist"); },
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, CHROME_MISSING_ERROR);
});

test("waitMs 超上限被钳到 MAX_WAIT_MS", async () => {
  let waited = -1;
  const browser: BrowserLike = {
    async newPage() {
      return {
        async setViewportSize() {},
        async goto() {},
        async waitForTimeout(ms) { waited = ms; },
        async screenshot() { return new Uint8Array([1]); },
      };
    },
    async close() {},
  };
  await screenshot(
    { url: LAN_URL, waitMs: 99999 },
    { checkNetwork: () => true, workspaceRoot: tempWorkspace(), launch: async () => browser },
  );
  assert.equal(waited, 10_000);
});

test("门控：off 档下后续请求落到公网时中止并返回门控错误", async () => {
  let disposition = "";
  const browser: BrowserLike = {
    async newPage() {
      return {
        async setViewportSize() {},
        async route(_pattern, handler) {
          await handler({
            request: () => ({ url: () => "https://example.com/landing" }),
            async abort() { disposition = "abort"; },
            async continue() { disposition = "continue"; },
          });
        },
        async goto() { throw new Error("net::ERR_FAILED"); },
        async waitForTimeout() {},
        async screenshot() { return new Uint8Array([1]); },
      };
    },
    async close() {},
  };
  const result = await screenshot(
    { url: LAN_URL },
    { checkNetwork: () => false, workspaceRoot: tempWorkspace(), launch: async () => browser },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, NETWORK_GATE_ERROR);
  assert.equal(disposition, "abort");
});

test("门控：off 档 data: 与 blob: 继续，不记为公网拦截", async () => {
  const dispositions: Record<string, string> = {};
  const browser: BrowserLike = {
    async newPage() {
      return {
        async setViewportSize() {},
        async route(_pattern, handler) {
          for (const url of ["data:image/png;base64,AA==", "blob:http://127.0.0.1/asset"]) {
            await handler({
              request: () => ({ url: () => url }),
              async abort() { dispositions[url] = "abort"; },
              async continue() { dispositions[url] = "continue"; },
            });
          }
        },
        async goto() { throw new Error("net::ERR_FAILED"); },
        async waitForTimeout() {},
        async screenshot() { return new Uint8Array([1]); },
      };
    },
    async close() {},
  };
  const result = await screenshot(
    { url: LAN_URL },
    { checkNetwork: () => false, workspaceRoot: tempWorkspace(), launch: async () => browser },
  );
  assert.equal(dispositions["data:image/png;base64,AA=="], "continue");
  assert.equal(dispositions["blob:http://127.0.0.1/asset"], "continue");
  assert.equal(result.ok, false);
  if (!result.ok) assert.notEqual(result.error, NETWORK_GATE_ERROR);
});
