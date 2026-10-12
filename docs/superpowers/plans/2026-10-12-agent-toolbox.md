# Agent 工具箱扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 HuaAnWork agent 的工具面从 6 个 Git 工具扩展到 14 个（+read/write/edit/glob/grep/bash + web_fetch/screenshot），L1/L2 复挂上游已挂载但被 overlay 关闭的工具行，L3 自建 `packages/huaanwork-web-tools`。

**Architecture:** L1/L2 = 变体 compose 层（`dsh-plugin-huaanwork/src/profile.ts` 的 launcher 补丁序列）翻回 `tool-fs`/`tool-fs-search`/`tool-bash`（win 为 `tool-pwsh`）三行，零新增策略代码（`packages/huaanwork-policy/src/decide.ts` 已有对应 case）；L3 = 新建纯逻辑包 `@huaanwork/web-tools`（web_fetch/screenshot，依赖注入缝）+ `huaanwork-guardrails/web.ts` 薄接线（同 `git.ts` 模式）。

**Tech Stack:** TypeScript（NodeNext ESM）、Cordis 插件行、上游 `@deepseek-ai/dsh-tool-*`、`playwright-core`（channel: chrome，零下载）、vitest（dsh-plugin-huaanwork）、node:test（packages）。

**Spec:** `docs/superpowers/specs/2026-10-12-agent-toolbox-design.md`（+ 同目录 spike 报告、A/B 判据）

## Global Constraints

- 所有命令经 Corepack：`corepack yarn ...`；Node `^22.19.0` 或 `>=24.0.0`。
- **zero-touch 规则**：只动 `dsh-plugin-huaanwork/`、`packages/huaanwork-*`、root 清单与 `scripts/`；**不碰** `dsh-plugin-desktop/src`、`dsh-plugin-desktop-beta/src`（两包的 `tests/package.spec.ts` 清单同步是 A/B 判据 §4.3.1 批准的例外，只改 tests 不动 src）。
- **绝不编辑 `deepseek-harness/`**（上游 pin 子模块）。
- patch 行的 `config` 是**整块替换**语义（spike §4.2）；`tool-bash`/`tool-pwsh` 的 Config schema 两字段均有默认值（`enableRunInBackground`/`promoteOnTimeout`），单字段 config 合法。
- 提交前跑 `corepack yarn check:desktop-variants` 确认守卫仍绿。
- `corepack yarn check` 全量门禁里 `verify:aa` 有既有并发竞争（债表首行），各 workspace 单独跑；并行全仓跑遇 verify:aa 红不算本计划回归。
- packages 测试：`node --experimental-strip-types --test src/*.test.ts`；dsh-plugin-huaanwork 测试：vitest。

---

### Task 1: L1/L2 复挂上游工具行（profile 补丁 + 行断言）

**Files:**
- Modify: `dsh-plugin-huaanwork/src/profile.ts`（launcher 补丁序列，现状 `:1442-1458` 的 `patches.push(...)` 块）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/row-assertions.ts`（`HUAANWORK_ROW_ASSERTIONS`）
- Test: `dsh-plugin-huaanwork/tests/profile.spec.ts`（disable 矩阵所在用例，现状 `:1235-1262`）

**Interfaces:**
- Consumes: 既有 `patches.push(...)` 序列、`HUAANWORK_ROW_ASSERTIONS: readonly RowHitAssertion[]`、`rows.get(id)`（`{ disabled?, config? }`）。
- Produces: 组合后 profile 中 `tool-fs`/`tool-fs-search` = `disabled:false`；`tool-bash`（posix）或 `tool-pwsh`（win32）= `disabled:false` 且 `config.enableRunInBackground === false`；`jobs`/`tool-jobs` 保持 `disabled:true`。

- [ ] **Step 1: 写失败测试**

在 `dsh-plugin-huaanwork/tests/profile.spec.ts` 的 disable 矩阵用例（含 `for (const id of ['hmr','jobs',...])` 循环的那个 `it`）中，`for` 循环之后追加：

```ts
    // L1/L2 复挂钉：dsh-base 挂载、web-app overlay 关闭的三行被变体翻回启用。
    expect(rows.get('tool-fs')?.disabled).toBe(false)
    expect(rows.get('tool-fs-search')?.disabled).toBe(false)
    const shellRowId = process.platform === 'win32' ? 'tool-pwsh' : 'tool-bash'
    expect(rows.get(shellRowId)?.disabled).toBe(false)
    expect(rows.get(shellRowId)?.config).toMatchObject({ enableRunInBackground: false })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/profile.spec.ts`
Expected: FAIL（`tool-fs` 行为 disabled:true 或 undefined）

- [ ] **Step 3: profile.ts 加 enable 补丁**

在 `dsh-plugin-huaanwork/src/profile.ts` 的 `patches.push(` 块中，`{ id: 'agent-loop', ... }` 行之后、`{ id: 'hmr', disabled: true }` 行之前插入：

```ts
    // L1/L2 复挂：dsh-base 已挂载、dsh-web-app overlay 关闭的三行翻回启用
    //（docs/superpowers/specs/2026-10-12-agent-toolbox-design.md 裁定 5）。
    // tool-bash/tool-pwsh 平台二选一，与上游 base patch 的门控同形；
    // enableRunInBackground: false 使 run_in_background 不进 schema——
    // jobs/tool-jobs 硬锁定下该参数可见必败（收口裁定，spike §4.6）。
    { id: 'tool-fs', disabled: false },
    { id: 'tool-fs-search', disabled: false },
    process.platform === 'win32'
      ? { id: 'tool-pwsh', disabled: false, config: { enableRunInBackground: false } }
      : { id: 'tool-bash', disabled: false, config: { enableRunInBackground: false } },
```

- [ ] **Step 4: row-assertions.ts 同步断言**

在 `dsh-plugin-huaanwork/src/huaanwork-host/row-assertions.ts` 中，`HUAANWORK_ROW_ASSERTIONS` 声明之前加：

```ts
const shellToolAssertion: RowHitAssertion =
  process.platform === 'win32'
    ? { id: 'tool-pwsh', intent: 'override', expectConfig: { enableRunInBackground: false } }
    : { id: 'tool-bash', intent: 'override', expectConfig: { enableRunInBackground: false } }
```

并在数组中 `{ id: 'tool-jobs', intent: 'disable' },` 行之后追加：

```ts
  { id: 'tool-fs', intent: 'override' },
  { id: 'tool-fs-search', intent: 'override' },
  shellToolAssertion,
```

（`jobs`/`tool-jobs` 的 disable 断言**不动**。）

- [ ] **Step 5: 跑测试确认通过**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/profile.spec.ts`
Expected: PASS（含既有断言——若行断言在别处被 `assertHuaanworkRowIdsHit` 消费，同文件相关用例也应过）

- [ ] **Step 6: 跑守卫 + 提交**

Run: `corepack yarn check:desktop-variants`
Expected: PASS（profile.ts / row-assertions.ts 均在 huaanwork 单侧白名单前缀内）

```bash
git add dsh-plugin-huaanwork/src/profile.ts dsh-plugin-huaanwork/src/huaanwork-host/row-assertions.ts dsh-plugin-huaanwork/tests/profile.spec.ts
git commit -m "feat(huaanwork): 复挂上游 tool-fs/tool-fs-search/tool-bash 工具行（L1/L2）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: policy 两条 ALLOW case（web_fetch / screenshot）

**Files:**
- Modify: `packages/huaanwork-policy/src/decide.ts`（`decide()` switch，现状 `:92-94` 的 git_status/git_diff ALLOW 组之后）
- Test: `packages/huaanwork-policy/src/decide.test.ts`

**Interfaces:**
- Consumes: 既有 `preExecute(input, mode)` / `guard(input, mode)`，`ToolCall = { name; args; workspaceRoot; ... }`，`ALLOW` 常量。
- Produces: `web_fetch` / `screenshot` 在 ask/smart/full 三档均判定 allow（出网门控由 `allow_network` 总闸与工具内 `isLanEndpoint` 判定负责，不经审批缝）。

- [ ] **Step 1: 写失败测试**

在 `packages/huaanwork-policy/src/decide.test.ts` 末尾追加（import 沿用文件头部既有 `preExecute`/`guard`）：

```ts
test("web_fetch/screenshot 三档均 allow（出网由 allow_network 总闸负责）", () => {
  for (const mode of ["ask", "smart", "full"] as const) {
    for (const name of ["web_fetch", "screenshot"]) {
      assert.equal(preExecute({ name, args: {}, workspaceRoot: "/ws" }, mode), "allow");
      assert.equal(guard({ name, args: {}, workspaceRoot: "/ws" }, mode), "allow");
    }
  }
});
```

（若该文件用 vitest 风格则改为对应 `it/expect` 写法——先读文件头确认 runner。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/huaanwork-policy && corepack yarn test`
Expected: FAIL（两工具落 default 分支：未 attached ⇒ deny）

- [ ] **Step 3: decide.ts 加 case**

在 `decide()` 的 `case "git_status": case "git_diff": return ALLOW;` 组之后插入：

```ts
    // 出网工具：策略层不 ask（避免每次抓取弹审批），门控由 allow_network 总闸
    // 与工具内 isLanEndpoint 判定承担（spec 裁定 3 / policy 增量汇总）。
    case "web_fetch":
    case "screenshot":
      return ALLOW;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/huaanwork-policy && corepack yarn check`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/huaanwork-policy/src/decide.ts packages/huaanwork-policy/src/decide.test.ts
git commit -m "feat(policy): web_fetch/screenshot 三档 allow（出网由总闸负责）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 新建 `@huaanwork/web-tools` 包 + web_fetch 纯逻辑

**Files:**
- Create: `packages/huaanwork-web-tools/package.json`
- Create: `packages/huaanwork-web-tools/tsconfig.json`
- Create: `packages/huaanwork-web-tools/src/web.ts`
- Test: `packages/huaanwork-web-tools/src/web.test.ts`
- Modify: `package.json`（root：workspaces + test 链）
- Modify: `scripts/expected-root-gate-scripts.json`（test 条目）
- Modify: `scripts/verify-layout.mjs:44` 附近（workspace 清单）
- Modify: `scripts/market-dependency-direction.mjs:24` 附近（受检根清单）
- Modify: `dsh-plugin-desktop/tests/package.spec.ts` 与 `dsh-plugin-desktop-beta/tests/package.spec.ts`（EXPECTED_WORKSPACES 清单 + `toHaveLength(11)` → `(12)`；只改 tests，不动两包 src——zero-touch 例外经 A/B 判据 §4.3.1 批准）

**Interfaces:**
- Consumes: `@huaanwork/policy/network` 的 `isLanEndpoint(baseUrl: string): boolean`。
- Produces（Task 5 接线依赖这些签名）:
  - `webFetch(url: string, deps: { checkNetwork: () => boolean; rawFetch?: RawFetch; timeoutMs?: number }): Promise<WebFetchResult>`
  - `type RawFetch = (url: string, init: { redirect: "manual"; signal: AbortSignal }) => Promise<RawResponse>`
  - `type RawResponse = { status: number; headers: { get(name: string): string | null }; body: AsyncIterable<Uint8Array> | null }`
  - `type WebFetchResult = { ok: true; url: string; status: number; text: string; truncated: boolean } | { ok: false; error: string }`
  - `NETWORK_GATE_ERROR: string`、`htmlToText(html: string): string`
  - 常量 `MAX_RESPONSE_BYTES = 2MiB`、`MAX_REDIRECTS = 5`、`DEFAULT_TIMEOUT_MS = 30_000`、`MAX_OUTPUT_CHARS = 50_000`

- [ ] **Step 1: 包脚手架**

`packages/huaanwork-web-tools/package.json`：

```json
{
  "name": "@huaanwork/web-tools",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/web.ts",
    "./screenshot": "./src/screenshot.ts"
  },
  "scripts": {
    "test": "node --experimental-strip-types --test src/*.test.ts",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "check": "yarn test && yarn typecheck"
  },
  "dependencies": {
    "@huaanwork/policy": "*"
  },
  "devDependencies": {
    "@types/node": "^22.20.0",
    "typescript": "~5.6.3"
  }
}
```

`packages/huaanwork-web-tools/tsconfig.json`：逐字复制 `packages/huaanwork-git-tools/tsconfig.json`。

`packages/huaanwork-web-tools/src/screenshot.ts` 占位（Task 4 填充）：

```ts
export {};
```

- [ ] **Step 2: 写 web_fetch 失败测试**

`packages/huaanwork-web-tools/src/web.test.ts`：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { htmlToText, NETWORK_GATE_ERROR, webFetch, type RawFetch } from "./web.ts";

const PUBLIC_URL = "https://example.com/page";
const LAN_URL = "http://192.168.1.10:8080/docs";

function htmlFetch(html: string, status = 200): RawFetch {
  return async () => ({
    status,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    body: (async function* () { yield new TextEncoder().encode(html); })(),
  });
}

test("门控：allow_network=off 时公网被拒、错误指路设置", async () => {
  const result = await webFetch(PUBLIC_URL, { checkNetwork: () => false, rawFetch: htmlFetch("x") });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, NETWORK_GATE_ERROR);
  assert.match(NETWORK_GATE_ERROR, /设置 → 权限/);
});

test("门控：allow_network=off 时局域网照常放行", async () => {
  const result = await webFetch(LAN_URL, { checkNetwork: () => false, rawFetch: htmlFetch("<p>内网文档</p>") });
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.text, /内网文档/);
});

test("门控：allow_network=on 时公网放行", async () => {
  const result = await webFetch(PUBLIC_URL, { checkNetwork: () => true, rawFetch: htmlFetch("<p>hello</p>") });
  assert.equal(result.ok, true);
});

test("重定向：超过 5 次报错；off 档下重定向到公网同样被门控", async () => {
  let calls = 0;
  const loopFetch: RawFetch = async (url) => {
    calls++;
    return { status: 302, headers: { get: () => url }, body: null };
  };
  const result = await webFetch(LAN_URL, { checkNetwork: () => true, rawFetch: loopFetch });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /重定向/);
  assert.ok(calls <= 6);

  const toPublic: RawFetch = async () => ({
    status: 302, headers: { get: () => PUBLIC_URL }, body: null,
  });
  const gated = await webFetch(LAN_URL, { checkNetwork: () => false, rawFetch: toPublic });
  assert.equal(gated.ok, false);
  if (!gated.ok) assert.equal(gated.error, NETWORK_GATE_ERROR);
});

test("HTML 提取：剥 script/style/标签，折叠空白", () => {
  const text = htmlToText(`<html><head><style>body{color:red}</style><script>evil()</script></head>
    <body><h1>标题</h1><p>正文 &amp; 更多</p></body></html>`);
  assert.match(text, /标题/);
  assert.match(text, /正文 & 更多/);
  assert.doesNotMatch(text, /evil|color:red/);
});

test("抓取失败与非 2xx 返回结构化错误", async () => {
  const boom: RawFetch = async () => { throw new Error("ECONNREFUSED"); };
  const failed = await webFetch(LAN_URL, { checkNetwork: () => true, rawFetch: boom });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.match(failed.error, /ECONNREFUSED/);

  const notFound: RawFetch = async () => ({ status: 404, headers: { get: () => null }, body: null });
  const res = await webFetch(LAN_URL, { checkNetwork: () => true, rawFetch: notFound });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /404/);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/huaanwork-web-tools && corepack yarn install && corepack yarn test`
Expected: FAIL（`./web.ts` 不存在 / 导出缺失）

注：若 root 尚未把本包列入 workspaces（Step 5 才做），本步用 `corepack yarn install` 前先完成 Step 5 的 root 清单编辑，或临时在包目录直接 `node --experimental-strip-types --test src/web.test.ts`（`@huaanwork/policy` 解析依赖 workspaces 注册，所以**先做完 Step 5 再回来跑本步**是合法顺序）。

- [ ] **Step 4: 实现 web.ts**

`packages/huaanwork-web-tools/src/web.ts`：

```ts
import { isLanEndpoint } from "@huaanwork/policy/network";

export type CheckNetwork = () => boolean;

export type RawResponse = {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
};

export type RawFetch = (
  url: string,
  init: { redirect: "manual"; signal: AbortSignal },
) => Promise<RawResponse>;

export type WebFetchResult =
  | { ok: true; url: string; status: number; text: string; truncated: boolean }
  | { ok: false; error: string };

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_CHARS = 50_000;

/** 与 huaanwork-host/net-gate.ts 的门控文案同族：指路 设置→权限。 */
export const NETWORK_GATE_ERROR =
  "当前为仅局域网模式，禁止抓取公网地址；请在 设置 → 权限 中开启「允许接入公网」，或改为抓取本机 / 局域网地址。";

const defaultRawFetch: RawFetch = async (url, init) => {
  const res = await fetch(url, { redirect: init.redirect, signal: init.signal });
  return {
    status: res.status,
    headers: res.headers,
    body: res.body as unknown as AsyncIterable<Uint8Array> | null,
  };
};

export async function webFetch(
  url: string,
  deps: { checkNetwork: CheckNetwork; rawFetch?: RawFetch; timeoutMs?: number },
): Promise<WebFetchResult> {
  if (!deps.checkNetwork() && !isLanEndpoint(url)) return { ok: false, error: NETWORK_GATE_ERROR };
  const rawFetch = deps.rawFetch ?? defaultRawFetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let current = url;
  for (let hops = 0; ; hops++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: RawResponse;
    try {
      res = await rawFetch(current, { redirect: "manual", signal: controller.signal });
    } catch (error) {
      return { ok: false, error: `抓取失败：${error instanceof Error ? error.message : String(error)}` };
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { ok: false, error: `HTTP ${res.status} 重定向缺少 Location 头` };
      if (hops >= MAX_REDIRECTS) return { ok: false, error: `重定向次数超过上限（${MAX_REDIRECTS}）` };
      const next = new URL(location, current).toString();
      // 重定向目标同样过门控：内网页 302 到公网在 off 档下必须被拦。
      if (!deps.checkNetwork() && !isLanEndpoint(next)) return { ok: false, error: NETWORK_GATE_ERROR };
      current = next;
      continue;
    }
    if (res.status < 200 || res.status >= 300) return { ok: false, error: `HTTP ${res.status}` };

    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    if (res.body) {
      for await (const chunk of res.body) {
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          truncated = true;
          break;
        }
        chunks.push(chunk);
      }
    }
    const size = chunks.reduce((n, c) => n + c.byteLength, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const contentType = res.headers.get("content-type") ?? "";
    const decoded = new TextDecoder("utf-8").decode(bytes);
    const body = contentType.includes("html") ? htmlToText(decoded) : decoded;
    const overChars = body.length > MAX_OUTPUT_CHARS;
    const text = overChars ? `${body.slice(0, MAX_OUTPUT_CHARS)}\n…[截断]` : body;
    return { ok: true, url: current, status: res.status, text, truncated: truncated || overChars };
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
```

（注意 `&amp;` 必须最后替换，避免 `&amp;lt;` 被双重解码。）

- [ ] **Step 5: 全仓清单同步**

1. root `package.json`：`workspaces` 数组在 `"packages/huaanwork-git-tools",` 后加 `"packages/huaanwork-web-tools",`；`scripts.test` 在 `yarn workspace @huaanwork/git-tools test` 后追加 ` && yarn workspace @huaanwork/web-tools test`。
2. `scripts/expected-root-gate-scripts.json`：`test` 条目改成与 root `package.json` 完全一致的新字符串。
3. `scripts/verify-layout.mjs:44`：`'packages/huaanwork-git-tools',` 后加 `'packages/huaanwork-web-tools',`。
4. `scripts/market-dependency-direction.mjs:24`：`'packages/huaanwork-git-tools/src',` 后加 `'packages/huaanwork-web-tools/src',`。
5. `dsh-plugin-desktop/tests/package.spec.ts` 与 `dsh-plugin-desktop-beta/tests/package.spec.ts`：`EXPECTED_WORKSPACES` 数组在 `'packages/huaanwork-git-tools',` 后加 `'packages/huaanwork-web-tools',`，`toHaveLength(11)` 改 `toHaveLength(12)`。

- [ ] **Step 6: 跑测试确认通过 + 清单守卫**

Run: `corepack yarn install && cd packages/huaanwork-web-tools && corepack yarn check`
Expected: PASS

Run: `corepack yarn test:gate-scripts && node scripts/verify-layout.mjs && corepack yarn workspace dsh-plugin-desktop exec vitest run tests/package.spec.ts && corepack yarn workspace dsh-plugin-desktop-beta exec vitest run tests/package.spec.ts`
Expected: PASS（若 gate-scripts 红，说明 JSON 与 root package.json 字符串不一致，逐字对齐后重跑）

- [ ] **Step 7: 提交**

```bash
git add packages/huaanwork-web-tools package.json scripts/expected-root-gate-scripts.json scripts/verify-layout.mjs scripts/market-dependency-direction.mjs dsh-plugin-desktop/tests/package.spec.ts dsh-plugin-desktop-beta/tests/package.spec.ts yarn.lock
git commit -m "feat(web-tools): 新建 @huaanwork/web-tools 包，web_fetch 纯逻辑 + 门控

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: screenshot 纯逻辑（playwright-core + attachment 缝）

**Files:**
- Modify: `packages/huaanwork-web-tools/src/screenshot.ts`（Task 3 的占位）
- Modify: `packages/huaanwork-web-tools/package.json`（加 playwright-core 依赖）
- Test: `packages/huaanwork-web-tools/src/screenshot.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `CheckNetwork`、`NETWORK_GATE_ERROR`（从 `./web.ts` import）。
- Produces（Task 5 接线依赖）:
  - `screenshot(args: ScreenshotArgs, deps: ScreenshotDeps): Promise<ScreenshotResult>`
  - `type ScreenshotArgs = { url: string; width?: number; height?: number; fullPage?: boolean; waitMs?: number }`
  - `type ScreenshotDeps = { checkNetwork: CheckNetwork; workspaceRoot: string; launch?: LaunchLike; saveImage?: SaveImage; now?: () => number }`
  - `type LaunchLike = () => Promise<BrowserLike>`；`BrowserLike = { newPage(): Promise<PageLike>; close(): Promise<unknown> }`；`PageLike = { setViewportSize(v: { width: number; height: number }): Promise<unknown>; goto(url: string, o: { waitUntil: "load"; timeout: number }): Promise<unknown>; waitForTimeout(ms: number): Promise<unknown>; screenshot(o: { type: "png"; fullPage: boolean }): Promise<Uint8Array> }`
  - `type SaveImage = (png: Uint8Array, name: string) => Promise<unknown | undefined>`（返回 attachment ref；接线侧不可达 attachment 服务时传 undefined → 只走路径兜底）
  - `type ScreenshotResult = { ok: true; path: string; bytes: number; imageRef?: unknown } | { ok: false; error: string }`
  - `CHROME_MISSING_ERROR: string`、`MAX_WAIT_MS = 10_000`

- [ ] **Step 1: 写失败测试**

`packages/huaanwork-web-tools/src/screenshot.test.ts`：

```ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CHROME_MISSING_ERROR, screenshot, type BrowserLike } from "./screenshot.ts";
import { NETWORK_GATE_ERROR } from "./web.ts";

const LAN_URL = "http://127.0.0.1:3000/preview";

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/huaanwork-web-tools && corepack yarn test`
Expected: FAIL（`./screenshot.ts` 只有占位导出）

- [ ] **Step 3: 实现 screenshot.ts + 加依赖**

`packages/huaanwork-web-tools/package.json` 的 `dependencies` 加 `"playwright-core": "^1.49.0"`，然后 `corepack yarn install`（更新 lockfile）。

`packages/huaanwork-web-tools/src/screenshot.ts`：

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isLanEndpoint } from "@huaanwork/policy/network";

import { NETWORK_GATE_ERROR, type CheckNetwork } from "./web.ts";

export type PageLike = {
  setViewportSize(viewport: { width: number; height: number }): Promise<unknown>;
  goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<unknown>;
  screenshot(options: { type: "png"; fullPage: boolean }): Promise<Uint8Array>;
};

export type BrowserLike = {
  newPage(): Promise<PageLike>;
  close(): Promise<unknown>;
};

export type LaunchLike = () => Promise<BrowserLike>;

export type SaveImage = (png: Uint8Array, name: string) => Promise<unknown | undefined>;

export type ScreenshotArgs = {
  url: string;
  width?: number;
  height?: number;
  fullPage?: boolean;
  waitMs?: number;
};

export type ScreenshotDeps = {
  checkNetwork: CheckNetwork;
  workspaceRoot: string;
  launch?: LaunchLike;
  saveImage?: SaveImage;
  now?: () => number;
};

export type ScreenshotResult =
  | { ok: true; path: string; bytes: number; imageRef?: unknown }
  | { ok: false; error: string };

export const MAX_WAIT_MS = 10_000;
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
export const GOTO_TIMEOUT_MS = 30_000;

export const CHROME_MISSING_ERROR =
  "截图失败：未找到可用的系统 Chrome/Chromium（playwright channel: chrome）。请在本机安装 Chrome 后重试；或改用 web_fetch 抓取文本。";

/** 动态 import：测试注入 launch 时不加载 playwright-core。 */
const defaultLaunch: LaunchLike = async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  return {
    newPage: () => browser.newPage(),
    close: () => browser.close(),
  };
};

export async function screenshot(args: ScreenshotArgs, deps: ScreenshotDeps): Promise<ScreenshotResult> {
  if (!deps.checkNetwork() && !isLanEndpoint(args.url)) return { ok: false, error: NETWORK_GATE_ERROR };

  const launch = deps.launch ?? defaultLaunch;
  let browser: BrowserLike;
  try {
    browser = await launch();
  } catch {
    return { ok: false, error: CHROME_MISSING_ERROR };
  }

  try {
    const page = await browser.newPage();
    await page.setViewportSize({
      width: args.width ?? DEFAULT_VIEWPORT.width,
      height: args.height ?? DEFAULT_VIEWPORT.height,
    });
    await page.goto(args.url, { waitUntil: "load", timeout: GOTO_TIMEOUT_MS });
    const waitMs = Math.min(Math.max(args.waitMs ?? 0, 0), MAX_WAIT_MS);
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    const png = await page.screenshot({ type: "png", fullPage: args.fullPage ?? false });

    const now = deps.now ?? Date.now;
    const dir = join(deps.workspaceRoot, ".huaanwork", "screenshots");
    await mkdir(dir, { recursive: true });
    const name = `${now()}-${slugHost(args.url)}.png`;
    const path = join(dir, name);
    await writeFile(path, png);

    const imageRef = deps.saveImage ? await deps.saveImage(png, name) : undefined;
    return { ok: true, path, bytes: png.byteLength, ...(imageRef === undefined ? {} : { imageRef }) };
  } catch (error) {
    return { ok: false, error: `截图失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await browser.close();
  }
}

function slugHost(url: string): string {
  try {
    return new URL(url).host.replace(/[^a-zA-Z0-9.-]/g, "_") || "page";
  } catch {
    return "page";
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + 许可/闭包守卫**

Run: `cd packages/huaanwork-web-tools && corepack yarn check`
Expected: PASS

Run: `corepack yarn workspace dsh-plugin-huaanwork verify:licenses`
Expected: PASS（playwright-core 为 Apache-2.0；若红，按其输出补许可清单登记）

- [ ] **Step 5: 提交**

```bash
git add packages/huaanwork-web-tools yarn.lock
git commit -m "feat(web-tools): screenshot 纯逻辑（playwright-core channel:chrome + attachment 缝）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: guardrails/web.ts 接线 + 注册 + 白名单

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-guardrails/web.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts`（`ALLOWED_TOOLS` 加两个名字）
- Modify: `dsh-plugin-huaanwork/src/profile.ts`（insert 列表 `:1467` 的 huaanwork-git 行之后）
- Modify: `dsh-plugin-huaanwork/package.json`（exports map + dependencies）
- Modify: `dsh-plugin-huaanwork/tsdown.config.ts`（entry `:42` 的 git 行之后）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/web.cordis.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/profile.spec.ts`（`expectedOrder` 数组 `'huaanwork-git'` 后加 `'huaanwork-web'`）

**Interfaces:**
- Consumes: Task 3/4 的 `webFetch` / `screenshot` / `NETWORK_GATE_ERROR` / `CHROME_MISSING_ERROR`；`ctx.huaanworkProfileDir`（`guardrails/policy.ts:141` 已有的 holder 约定）；`ctx.huaanworkWorkspaceRoot: { current: string }`（`git.ts` 同款）；`ctx.attachments`（上游 `AttachmentStore` service，`attachment-local` 行在 dsh-base 挂载且本变体未禁用，`saveImages(inputs)` 返回 `ImageAttachmentRef[]`）。
- Produces: agent 工具面新增 `web_fetch(url, timeoutMs?)` 与 `screenshot(url, width?, height?, fullPage?, waitMs?)`；`present-as` 白名单放行这两个名字。

- [ ] **Step 1: 写失败 cordis 测试**

`dsh-plugin-huaanwork/tests/huaanwork-guardrails/web.cordis.spec.ts`（骨架同 `git.cordis.spec.ts` 的 `createCtx`，精简版）：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-guardrails/web.cordis.spec.ts`
Expected: FAIL（`web.ts` 不存在）

- [ ] **Step 3: 实现 web.ts 接线**

`dsh-plugin-huaanwork/src/huaanwork-guardrails/web.ts`：

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { defineTool } from "@deepseek-ai/dsh-tools";
import { webFetch } from "@huaanwork/web-tools";
import { screenshot } from "@huaanwork/web-tools/screenshot";

type Context = {
  huaanworkProfileDir?: string;
  huaanworkWorkspaceRoot?: { current: string };
  attachments?: {
    saveImages(
      inputs: readonly { data: Uint8Array; mediaType: "image/png"; name?: string }[],
    ): Promise<readonly unknown[]>;
  };
  tools: {
    register(definition: unknown): () => void;
  };
};

const fetchOutput = {
  schema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" as const, required: true as const },
      url: { type: "string" as const },
      status: { type: "integer" as const },
      text: { type: "string" as const },
      truncated: { type: "boolean" as const },
      error: { type: "string" as const },
    },
  },
  render(_args: unknown, value: { ok: boolean; text?: string; error?: string; truncated?: boolean; url?: string }) {
    if (!value.ok) return [{ type: "text" as const, text: value.error ?? "web_fetch failed" }];
    const note = value.truncated ? "\n[内容已截断]" : "";
    return [{ type: "text" as const, text: `${value.text ?? ""}${note}`.trimEnd() }];
  },
};

const shotOutput = {
  schema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" as const, required: true as const },
      path: { type: "string" as const },
      bytes: { type: "integer" as const },
      imageRef: { type: "object" as const },
      error: { type: "string" as const },
    },
  },
  render(_args: unknown, value: { ok: boolean; path?: string; error?: string; imageRef?: unknown }) {
    if (!value.ok) return [{ type: "text" as const, text: value.error ?? "screenshot failed" }];
    const blocks = [{ type: "text" as const, text: `截图已保存：${value.path}` }];
    if (value.imageRef !== undefined) blocks.push({ type: "image", attachment: value.imageRef } as never);
    return blocks;
  },
};

/** 每次调用直读 settings（与 guardrails/policy.ts 的 readGuardMode 同模式），fail-closed。 */
function readAllowNetwork(profileDir: string | undefined): boolean {
  if (!profileDir) return false;
  try {
    const parsed = JSON.parse(readFileSync(join(profileDir, "huaanwork-settings.json"), "utf8")) as Record<string, unknown>;
    if (typeof parsed.allow_network === "boolean") return parsed.allow_network;
    return parsed.work_allow_network === true; // 旧 key 一次性兼容，与 huaanwork-host/settings.ts 的 parse 一致
  } catch {
    return false;
  }
}

export const inject = ["tools"];

export function apply(ctx: Context): void {
  const checkNetwork = () => readAllowNetwork(ctx.huaanworkProfileDir);
  const workspaceRoot = () => ctx.huaanworkWorkspaceRoot?.current ?? process.cwd();

  ctx.tools.register(
    defineTool({
      name: "web_fetch",
      description: "Fetch a URL and return its text content. LAN addresses always work; public internet requires 设置→权限 的公网开关。",
      parameters: {
        url: { type: "string", required: true, description: "The URL to fetch." },
        timeoutMs: { type: "number", description: "Request timeout in ms (default 30000)." },
      },
      output: fetchOutput,
      isConcurrencySafe: () => true,
      async execute(args) {
        return webFetch(args.url, { checkNetwork, timeoutMs: args.timeoutMs });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "screenshot",
      description: "Render a URL in headless system Chrome and save a PNG screenshot into the workspace.",
      parameters: {
        url: { type: "string", required: true, description: "The URL to render (typically a local dev server)." },
        width: { type: "number", description: "Viewport width (default 1280)." },
        height: { type: "number", description: "Viewport height (default 800)." },
        fullPage: { type: "boolean", description: "Capture the full scrollable page (default false)." },
        waitMs: { type: "number", description: "Extra wait after load, max 10000." },
      },
      output: shotOutput,
      async execute(args) {
        const saveImage = ctx.attachments
          ? async (png: Uint8Array, name: string) =>
              (await ctx.attachments!.saveImages([{ data: png, mediaType: "image/png", name }]))[0]
          : undefined;
        return screenshot(args, {
          checkNetwork,
          workspaceRoot: workspaceRoot(),
          ...(saveImage ? { saveImage } : {}),
        });
      },
    }),
  );
}
```

- [ ] **Step 4: 注册四处 + 白名单**

1. `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts` 的 `ALLOWED_TOOLS`：在 `"git_push",` 后加 `"web_fetch",` 与 `"screenshot",`。
2. `dsh-plugin-huaanwork/src/profile.ts` insert 列表（`:1467` 附近）：`{ id: 'huaanwork-git', ... }` 行之后加：
   ```ts
        { id: 'huaanwork-web', name: 'dsh-plugin-huaanwork/huaanwork-guardrails/web' },
   ```
3. `dsh-plugin-huaanwork/package.json`：`exports` 加（位置随既有 guardrails 条目族）：
   ```json
    "./huaanwork-guardrails/web": {
      "types": "./lib/types/huaanwork-guardrails/web.d.ts",
      "default": "./lib/huaanwork-guardrails/web.js"
    },
   ```
   `dependencies` 加 `"@huaanwork/web-tools": "*",`（随 `:379-381` 的 `@huaanwork/*` 族）。
4. `dsh-plugin-huaanwork/tsdown.config.ts` entry（`:42` git 行之后）加：
   ```ts
      'huaanwork-guardrails/web': 'src/huaanwork-guardrails/web.ts',
   ```
5. `dsh-plugin-huaanwork/tests/profile.spec.ts` 的 `expectedOrder` 数组：`'huaanwork-git',` 后加 `'huaanwork-web',`。

- [ ] **Step 5: 跑测试确认通过**

Run: `corepack yarn install && corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-guardrails/web.cordis.spec.ts tests/huaanwork-guardrails/present-as.cordis.spec.ts tests/profile.spec.ts`
Expected: PASS（present-as 既有用例不因白名单扩张而红；profile.spec 的 expectedOrder 钉同步更新后过）

- [ ] **Step 6: typecheck + 守卫 + 提交**

Run: `corepack yarn workspace dsh-plugin-huaanwork typecheck && corepack yarn check:desktop-variants`
Expected: PASS（`src/huaanwork-guardrails/` 在 oneSidedPrefixes 白名单内；profile.ts/present-as.ts 若触发守卫 diff，按守卫输出核对是否落在既有 `allowedDifferences`——两文件本就在 22 项清单内，新增行不改变文件的在册状态）

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/web.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts dsh-plugin-huaanwork/src/profile.ts dsh-plugin-huaanwork/package.json dsh-plugin-huaanwork/tsdown.config.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/web.cordis.spec.ts dsh-plugin-huaanwork/tests/profile.spec.ts yarn.lock
git commit -m "feat(huaanwork): 接线 web_fetch/screenshot 进 agent 工具面（L3）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 威胁模型登记 + 全门禁验收

**Files:**
- Modify: `docs/superpowers/specs/2026-10-12-agent-toolbox-design.md`（追加威胁模型节）

- [ ] **Step 1: 威胁模型三条登记**

在设计文档〈范围外 / 延后项〉之后追加：

```markdown
## 威胁模型登记（2026-10-12 工具箱扩展）

1. **bash 出网旁路**：`allow_network` 总闸只管 web_fetch/screenshot/模型端点；`bash` 执行的命令（如 curl）不受其门控，由 `decideShell` 三档护栏负责（full 档下 curl 直接放行，ask/smart 档弹审批或按元字符规则拒绝）。
2. **write/edit 沙箱越级参数**：上游 tool-fs 在 `fs-sandbox`(workspace-write) 下给 write/edit 展开 `sandbox_permissions`/`justification` 参数；实测只能越过沙箱、越不过 huaanwork-policy 的 pre-execute 判定（spike §4.5），deny 即终局。
3. **nohup/& 自管后台**：后台任务管理面本轮不开放（jobs/tool-jobs 硬锁定），但 full 档下模型可用 `nohup … &` 自管后台进程（spike §4.6 实测），产物无管理面可回收；开放 job_* 管理面是后续独立裁定。
```

- [ ] **Step 2: 全量门禁（各 workspace 串行）**

Run: `corepack yarn test && corepack yarn typecheck && corepack yarn check:desktop-variants`
Expected: PASS

Run: `corepack yarn workspace dsh-plugin-huaanwork check`
Expected: PASS（含 verify:licenses / verify:closure 等；`verify:aa` 若因既有并发竞争红，单独重跑该步确认——债表首行的 pre-existing flakiness，不算本计划回归）

- [ ] **Step 3: 隔离实例验收（人工，沿用 spike 方法）**

按 `docs/superpowers/specs/2026-10-12-agent-toolbox-spike-report.md` §2 的隔离骨架起实例（**不带**机器级 patch——本轮验收的是仓库内改动生效）：

- [ ] 行状态直读：`tool-fs`/`tool-fs-search`/`tool-bash`（win 为 `tool-pwsh`）= `disabled:false`，`tool-bash.config.enableRunInBackground === false`，`jobs`/`tool-jobs` 保持 `disabled:true`；
- [ ] 会话 `request/header` 工具目录 = 14 个（6 git + read/write/edit/glob/grep/bash + web_fetch + screenshot）；
- [ ] `bash` 的 schema 参数表**不含** `run_in_background`；
- [ ] 越界 `read /etc/passwd` → deny（REASON_PATH_ESCAPE 文案）；
- [ ] `web_fetch` 在 allow_network=off 抓公网 → 指路错误；抓局域网 → 放行；
- [ ] `screenshot` 对一个本地可起的服务页出 PNG，且会话内可见图片块（若模型不支持视觉则至少路径兜底可见）。

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/specs/2026-10-12-agent-toolbox-design.md
git commit -m "docs: 工具箱扩展威胁模型三条登记（bash 出网旁路/沙箱越级/nohup 旁路）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review 记录

- **Spec 覆盖**：复挂（Task 1）✓、policy 2 case（Task 2）✓、web-tools 包+清单同步（Task 3）✓、screenshot（Task 4）✓、接线+白名单+注册（Task 5）✓、威胁模型三条+验收（Task 6）✓。范围外项（web_search/后台任务/完整浏览器控制）无任务，符合 spec。
- **行号漂移**：文中行号为写作时实测值，实施时以符号名/锚点文本为准（A/B 判据 §4 同约定）。
- **类型一致性**：Task 3/4 的 Produces 签名与 Task 5 的 Consumes 已逐条对齐（`CheckNetwork`/`SaveImage`/`WebFetchResult`/`ScreenshotResult`）。
