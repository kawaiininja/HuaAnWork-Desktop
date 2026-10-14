# Agent 工具箱扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 HuaAnWork agent 的工具面从 6 个 Git 工具扩展到 14 个（+read/write/edit/glob/grep/bash + web_fetch/screenshot），L1/L2 复挂上游已挂载但被 overlay 关闭的工具行，L3 自建 `packages/huaanwork-web-tools`。

**Architecture:** L1/L2 = 变体 compose 层（`dsh-plugin-huaanwork/src/profile.ts` 的 launcher 补丁序列）翻回 `tool-fs`/`tool-fs-search`/`tool-bash`（win 为 `tool-pwsh`）三行，零新增策略代码（`packages/huaanwork-policy/src/decide.ts` 已有对应 case）；L3 = 新建纯逻辑包 `@huaanwork/web-tools`（web_fetch/screenshot，依赖注入缝）+ `huaanwork-guardrails/web.ts` 薄接线（同 `git.ts` 模式）。

**Tech Stack:** TypeScript（NodeNext ESM）、Cordis 插件行、上游 `@deepseek-ai/dsh-tool-*`、`playwright-core`（channel: chrome，零下载）、vitest（dsh-plugin-huaanwork）、node:test（packages）。

**Spec:** `docs/superpowers/specs/2026-10-12-agent-toolbox-design.md`（+ 同目录 spike 报告、A/B 判据）

> **审查记录（2026-10-12）**：本计划经初审 + 独立对抗性检查，结论已并入下列任务。修订要点：`@huaanwork/web-tools` 留 **devDependencies**（tsdown 只 external prod/peer）；`playwright-core` 提升为 **dsh-plugin-huaanwork 的 dependencies**；Task 4 测试期望值与 `slugHost` 实现对齐；清单同步补 `dsh-plugin-huaanwork/tests/package.spec.ts`；隔离验收交付脚本入仓；`check:desktop-variants` 的既有红为基线状态。
>
> **二审记录（2026-10-12，对照设计文档复核 + 代码实测）**：6 项修订已并入任务正文与末尾〈二审修订汇总〉：Task 3 补全 `htmlToText` 实现；Task 2 锚点文本订正；Task 4 playwright-core 改精确 pin `1.63.0`（range 描述符会重新解析，零新下载面的断言只对精确 pin 成立）；Task 6 补 bash ask/元字符 deny 验收项、Windows 侧覆盖说明、门禁改跑完整 `corepack yarn check`。
>
> **三审修订（2026-10-12，对照代码再审）**：下列项已并入任务正文与末尾〈三审修订汇总〉。Task 4 的运行时依赖写在 `dsh-plugin-huaanwork` 的 `dependencies`，同一精确 pin 再写入 `@huaanwork/web-tools` 的 `devDependencies`（只给该包 `tsc` 解析 `import("playwright-core")`），提交清单带上插件 `package.json`。Task 3 补 `readCappedBytes` 的测试与实现，`webFetch` 把 `res.body` 原样交进去。Task 5 用 `ctx.inject(['attachments'])` 记下 store，截断提示只留在正文。`screenshot` 在公网关闭时用 `page.route` 拦截非局域网请求。Task 6 的三份验收脚本以本计划正文为准入仓，不再指向 spike 报告未收录的 `/tmp` 文件。威胁模型补链路本地元数据地址。

## Global Constraints

- 所有命令经 Corepack：`corepack yarn ...`；Node `^22.19.0` 或 `>=24.0.0`。
- **zero-touch 规则**：只动 `dsh-plugin-huaanwork/`、`packages/huaanwork-*`、root 清单与 `scripts/`；**不碰** `dsh-plugin-desktop/src`、`dsh-plugin-desktop-beta/src`（三份 `tests/package.spec.ts` 清单同步是批准的例外，只改 tests 不动 src）。
- **绝不编辑 `deepseek-harness/`**（上游 pin 子模块）。
- patch 行的 `config` 是**整块替换**语义（spike §4.2）；`tool-bash`/`tool-pwsh` 的 Config schema 两字段均有默认值（`enableRunInBackground`/`promoteOnTimeout`），单字段 config 合法。
- **tsdown 打包语义（实测定论）**：只有 **prod/peer dependencies 才 external**，devDependencies 一律内联。故 `@huaanwork/*` 包必须待在 `dsh-plugin-huaanwork` 的 **devDependencies**（`:379-381` 族）；`playwright-core` 这类需要真 node_modules 的运行时依赖必须声明在 **dsh-plugin-huaanwork 的 dependencies**（external 化后由打包清单携带）。
- **`check:desktop-variants` 在当前 HEAD 已红**（债表末行 `electron-shell-generation.ts` 未登记漂移）——本计划各处该命令的预期是"**不新增失败**"，不是"PASS"；红在 diff 里出现 `src/electron-shell-generation.ts` 之外的条目才算回归。
- 工作树基线：69 项未提交删除（`assets/`、`_deprecated/`）——Task 6 全量门禁需在验收记录里注明基线脏度，且**不得**把这些删除混进本计划的提交。
- 提交前跑 `corepack yarn check:desktop-variants` 确认不新增失败。
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
Expected: **不新增失败**（基线已有 1 项红：债表末行 `electron-shell-generation.ts` 漂移；本任务的 `profile.ts`/`row-assertions.ts` 在 huaanwork 单侧白名单前缀内，不应出现在新增失败里）

```bash
git add dsh-plugin-huaanwork/src/profile.ts dsh-plugin-huaanwork/src/huaanwork-host/row-assertions.ts dsh-plugin-huaanwork/tests/profile.spec.ts
git commit -m "feat(huaanwork): 复挂上游 tool-fs/tool-fs-search/tool-bash 工具行（L1/L2）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: policy 两条 ALLOW case（web_fetch / screenshot）

**Files:**
- Modify: `packages/huaanwork-policy/src/decide.ts`（`decide()` switch，现状 `:89-94` 的 `skill`/`todo_write`/`subagent`/`git_status`/`git_diff` 五 case 共享 `return ALLOW` 组之后）
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

在 `decide()` 的五 case 组（`case "skill":` / `case "todo_write":` / `case "subagent":` / `case "git_status":` / `case "git_diff":` 共享的 `return ALLOW;`）之后插入：

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
- Modify: `packages/huaanwork-policy/src/http-cap.ts`（新增 `readCappedBytes` 导出；`readCappedText` 改为其上的 UTF-8 封装，保持原签名）
- Modify: `packages/huaanwork-policy/src/http-cap.test.ts`（`readCappedBytes` 截断/边界用例）
- Create: `packages/huaanwork-web-tools/package.json`
- Create: `packages/huaanwork-web-tools/tsconfig.json`
- Create: `packages/huaanwork-web-tools/src/web.ts`
- Test: `packages/huaanwork-web-tools/src/web.test.ts`
- Modify: `package.json`（root：workspaces + test 链）
- Modify: `scripts/expected-root-gate-scripts.json`（test 条目）
- Modify: `scripts/verify-layout.mjs:44` 附近（workspace 清单）
- Modify: `scripts/market-dependency-direction.mjs:24` 附近（受检根清单；**非红项**：该守卫的测试只断言"包含"，漏加不红——加它是补覆盖空窗，与 M14 盲区 B 的修复意图一致）
- Modify: `dsh-plugin-huaanwork/tests/package.spec.ts`（`EXPECTED_WORKSPACES` 清单 + `toHaveLength(11)` → `(12)`；**本包自己的测试，最易漏，root `test` 链必跑**）
- Modify: `dsh-plugin-desktop/tests/package.spec.ts` 与 `dsh-plugin-desktop-beta/tests/package.spec.ts`（EXPECTED_WORKSPACES 清单 + `toHaveLength(11)` → `(12)`；只改 tests，不动两包 src——zero-touch 例外经 A/B 判据 §4.3.1 批准）

**Interfaces:**
- Consumes: `@huaanwork/policy/network` 的 `isLanEndpoint(baseUrl: string): boolean`；`@huaanwork/policy/http-cap` 的 **新增导出** `readCappedBytes(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }>`。把现有 `readCappedText` 的读循环原样抽出（含超额时 `value.subarray` 与 `reader.cancel()`），**不要**把 `trimIncompleteUtf8` 放进 `readCappedBytes`。`readCappedText` 改为调用它，仅在 `truncated` 时做 UTF-8 边界修整再 `new TextDecoder("utf-8")`，原签名与既有测试保持不变。`webFetch` **直接传入 `res.body`**，不要再包一层重新分块的流：那一层会把单个大 chunk 整段拷进内存，而且取消的是包装流，停不掉原始 body。
- Produces（Task 5 接线依赖这些签名）:
  - `webFetch(url: string, deps: { checkNetwork: () => boolean; rawFetch?: RawFetch; timeoutMs?: number }): Promise<WebFetchResult>`
  - `type RawFetch = (url: string, init: { redirect: "manual"; signal: AbortSignal }) => Promise<RawResponse>`
  - `type RawResponse = { status: number; headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null }`
  - `type WebFetchResult = { ok: true; url: string; status: number; text: string; truncated: boolean } | { ok: false; error: string }`
  - `NETWORK_GATE_ERROR: string`、`htmlToText(html: string): string`
  - 常量 `MAX_RESPONSE_BYTES = 2MiB`、`MAX_REDIRECTS = 5`、`DEFAULT_TIMEOUT_MS = 30_000`、`MAX_OUTPUT_CHARS = 50_000`、`USER_AGENT`（显式产品标识，不伪装浏览器）

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

注：若 root 尚未把本包列入 workspaces（Step 6 才做），本步用 `corepack yarn install` 前先完成 Step 6 的 root 清单编辑，或临时在包目录直接 `node --experimental-strip-types --test src/web.test.ts`（`@huaanwork/policy` 解析依赖 workspaces 注册，所以**先做完 Step 6 再回来跑本步**是合法顺序）。

- [ ] **Step 4: 抽出 `readCappedBytes`，保持 `readCappedText` 行为**

在 `packages/huaanwork-policy/src/http-cap.test.ts` 末尾追加（`readCappedBytes` 从 `./http-cap.ts` 一起 import）：

```ts
test("readCappedBytes 按额度截原始字节并取消 reader", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
      controller.enqueue(new Uint8Array([6, 7, 8]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await readCappedBytes(stream, 4);
  assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
  assert.equal(result.truncated, true);
  assert.equal(cancelled, true);
});

test("readCappedText 仍修掉被截断的半个 UTF-8 序列", async () => {
  // "a" + "€"(e2 82 ac)；上限 2 字节会切在欧元的首字节上。
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0x61, 0xe2, 0x82, 0xac]));
      controller.close();
    },
  });
  const result = await readCappedText(stream, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.text, "a");
  assert.ok(Buffer.byteLength(result.text) <= 2);
});
```

Run: `cd packages/huaanwork-policy && corepack yarn test`
Expected: FAIL（`readCappedBytes` 未导出）

然后把 `http-cap.ts` 的读循环抽成 `readCappedBytes`，`readCappedText` 只保留 UTF-8 修整与解码。`trimIncompleteUtf8` 留在本文件、不导出：

```ts
export async function readCappedBytes(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (stream === null) return { bytes: new Uint8Array(), truncated: false };
  if (maxBytes <= 0) {
    try { await stream.cancel(); } catch { /* 忽略取消异常 */ }
    return { bytes: new Uint8Array(), truncated: true };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (totalBytes + value.byteLength > maxBytes) {
        const needed = maxBytes - totalBytes;
        if (needed > 0) {
          chunks.push(value.subarray(0, needed));
          totalBytes += needed;
        }
        truncated = true;
        try { await reader.cancel(); } catch { /* 忽略取消异常 */ }
        break;
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

export async function readCappedText(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const capped = await readCappedBytes(stream, maxBytes);
  const bytes = capped.truncated ? trimIncompleteUtf8(capped.bytes) : capped.bytes;
  return { text: new TextDecoder("utf-8").decode(bytes), truncated: capped.truncated };
}
```

Run: `cd packages/huaanwork-policy && corepack yarn test`
Expected: PASS（含既有 `readCappedText` 用例）

- [ ] **Step 5: 实现 web.ts**

`packages/huaanwork-web-tools/src/web.ts`：

```ts
import { isLanEndpoint } from "@huaanwork/policy/network";
import { readCappedBytes } from "@huaanwork/policy/http-cap";

export type CheckNetwork = () => boolean;

export type RawResponse = {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
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
/** 显式产品标识：不伪装浏览器（与上游 web-fetch-http 的取向一致）。 */
export const USER_AGENT = "huaanwork-desktop/0.1.0 (+local)";

/** 与 huaanwork-host/net-gate.ts 的门控文案同族：指路 设置→权限。 */
export const NETWORK_GATE_ERROR =
  "当前为仅局域网模式，禁止抓取公网地址；请在 设置 → 权限 中开启「允许接入公网」，或改为抓取本机 / 局域网地址。";

const TRUNCATION_NOTE = "\n…[截断]";

const defaultRawFetch: RawFetch = async (url, init) => {
  const res = await fetch(url, {
    redirect: init.redirect,
    signal: init.signal,
    headers: { "user-agent": USER_AGENT },
  });
  return { status: res.status, headers: res.headers, body: res.body };
};

/** content-type 的 charset 参数；缺失或非法回退 utf-8。 */
function resolveDecoder(contentType: string): TextDecoder {
  const match = /charset=["']?([\w-]+)/i.exec(contentType);
  if (!match) return new TextDecoder("utf-8");
  try {
    return new TextDecoder(match[1]!.toLowerCase());
  } catch {
    return new TextDecoder("utf-8");
  }
}

/**
 * HTML → 正文文本：先剥 script/style 整块（含内容）与注释，再去标签，
 * 解码常见命名实体（`&amp;` 必须最后替换，避免 `&amp;lt;` 被双重解码），折叠空白。
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

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
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { ok: false, error: `重定向 Location 非法：${location}` };
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        return { ok: false, error: `重定向目标协议不受支持：${next.protocol}` };
      }
      // HTTPS → HTTP 降级不跟随（凭据/内容暴露面；内网常见，但应由调用方显式发起）。
      if (new URL(current).protocol === "https:" && next.protocol === "http:") {
        return { ok: false, error: `不跟随 HTTPS → HTTP 降级重定向：${next.toString()}` };
      }
      // 重定向目标同样过门控：内网页 302 到公网在 off 档下必须被拦。
      // 同 host 换端口 / http→https 升级不额外放行，只看目标是否在门控放行范围内。
      if (!deps.checkNetwork() && !isLanEndpoint(next.toString())) return { ok: false, error: NETWORK_GATE_ERROR };
      current = next.toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) return { ok: false, error: `HTTP ${res.status}` };

    const contentType = res.headers.get("content-type") ?? "";
    const decoder = resolveDecoder(contentType); // 读体前解析：不支持的编码标签在此提前失败
    try {
      // 直接把响应体交给 policy 的按额度截断。readCappedBytes 自己 subarray + reader.cancel()。
      const capped = await readCappedBytes(res.body, MAX_RESPONSE_BYTES);
      const decoded = decoder.decode(capped.bytes);
      const overChars = decoded.length > MAX_OUTPUT_CHARS;
      const truncated = capped.truncated || overChars;
      // 字节截断但字符未超限（大标记小正文）也要带标记——接线层 render 不追加第二句，正文是唯一出口。
      const clipped = (overChars ? decoded.slice(0, MAX_OUTPUT_CHARS) : decoded) + (truncated ? TRUNCATION_NOTE : "");
      return {
        ok: true,
        url: current,
        status: res.status,
        text: contentType.includes("html") ? htmlToText(clipped) : clipped,
        truncated,
      };
    } catch (error) {
      return { ok: false, error: `读取响应失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
```
（htmlToText 的实体解码顺序：`&amp;` 必须最后替换，避免 `&amp;lt;` 被双重解码；script/style 必须先于标签剥除整体移除，否则标签没了内容残留。）

> **审查修订说明（2026-10-12，初审 + 对抗性检查；三审去掉包装流）**：初稿用"整块入存再丢弃跨限 chunk"的手写循环与硬编码 utf-8；修订版改为 ①复用 policy 的**字节级**按额度截断（`readCappedBytes` 抽出既有读循环，超额 `subarray` 后 `reader.cancel()`；`trimIncompleteUtf8` 只留在 `readCappedText`）；②按 `content-type` charset 解码（读体前解析；中文内网页面 GBK 不再乱码）；③显式 `USER_AGENT`；④重定向白名单 = http/https + 不跟随 HTTPS→HTTP 降级 + 重定向目标同步过门控（**不照抄上游"同源全等"策略**——那会连带拒掉内网常见的换端口与 http→https 升级）。`webFetch` 把 `res.body` 原样传入，截断提示 `…[截断]` 只写进 `text`，接线层 `render` 不再追加第二句。

- [ ] **Step 6: 全仓清单同步**

1. root `package.json`：`workspaces` 数组在 `"packages/huaanwork-git-tools",` 后加 `"packages/huaanwork-web-tools",`；`scripts.test` 在 `yarn workspace @huaanwork/git-tools test` 后追加 ` && yarn workspace @huaanwork/web-tools test`。
2. `scripts/expected-root-gate-scripts.json`：`test` 条目改成与 root `package.json` 完全一致的新字符串。
3. `scripts/verify-layout.mjs:44`：`'packages/huaanwork-git-tools',` 后加 `'packages/huaanwork-web-tools',`。
4. `scripts/market-dependency-direction.mjs:24`：`'packages/huaanwork-git-tools/src',` 后加 `'packages/huaanwork-web-tools/src',`（补覆盖空窗；`market-dependency-direction.test.mjs` 无需改——它只断言"包含"）。
5. **三份** `tests/package.spec.ts` 的 `EXPECTED_WORKSPACES` 数组在 `'packages/huaanwork-git-tools',` 后加 `'packages/huaanwork-web-tools',`，`toHaveLength(11)` 改 `toHaveLength(12)`：
   - `dsh-plugin-desktop/tests/package.spec.ts`
   - `dsh-plugin-desktop-beta/tests/package.spec.ts`
   - `dsh-plugin-huaanwork/tests/package.spec.ts`（**易漏项**：本包自己的测试，漏改则 Task 6 `yarn test` 必红）

- [ ] **Step 7: 跑测试确认通过 + 清单守卫**

Run: `corepack yarn install && cd packages/huaanwork-web-tools && corepack yarn check`
Expected: PASS

Run: `corepack yarn test:gate-scripts && node scripts/verify-layout.mjs && corepack yarn workspace dsh-plugin-desktop exec vitest run tests/package.spec.ts && corepack yarn workspace dsh-plugin-desktop-beta exec vitest run tests/package.spec.ts && corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/package.spec.ts`
Expected: PASS（若 gate-scripts 红，说明 JSON 与 root package.json 字符串不一致，逐字对齐后重跑）

> **Task 4 前置说明**：`playwright-core` 的**运行时**声明只在 `dsh-plugin-huaanwork` 的 **dependencies**（见 Task 4 Step 3）。`packages/huaanwork-web-tools/package.json` 只在 **devDependencies** 放同一个精确 pin，供该包 `tsc` 解析；不要放进它的 `dependencies`，否则许可检查看不到插件声明图上的真正归属。

- [ ] **Step 8: 提交**

```bash
git add packages/huaanwork-policy/src/http-cap.ts packages/huaanwork-policy/src/http-cap.test.ts packages/huaanwork-web-tools package.json scripts/expected-root-gate-scripts.json scripts/verify-layout.mjs scripts/market-dependency-direction.mjs dsh-plugin-desktop/tests/package.spec.ts dsh-plugin-desktop-beta/tests/package.spec.ts dsh-plugin-huaanwork/tests/package.spec.ts yarn.lock
git commit -m "feat(web-tools): 新建 @huaanwork/web-tools 包，web_fetch 纯逻辑 + 门控

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: screenshot 纯逻辑（playwright-core + attachment 缝）

**Files:**
- Modify: `packages/huaanwork-web-tools/src/screenshot.ts`（Task 3 的占位）
- Modify: `packages/huaanwork-web-tools/package.json`（**devDependencies** 加 `playwright-core` 精确 pin，只给本包 `tsc` 解析 `import("playwright-core")`）
- Modify: `dsh-plugin-huaanwork/package.json`（**dependencies** 加同一个精确 pin；这是运行时归属，tsdown 据此 external）
- Test: `packages/huaanwork-web-tools/src/screenshot.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `CheckNetwork`、`NETWORK_GATE_ERROR`（从 `./web.ts` import）。
- Produces（Task 5 接线依赖）:
  - `screenshot(args: ScreenshotArgs, deps: ScreenshotDeps): Promise<ScreenshotResult>`
  - `type ScreenshotArgs = { url: string; width?: number; height?: number; fullPage?: boolean; waitMs?: number }`
  - `type ScreenshotDeps = { checkNetwork: CheckNetwork; workspaceRoot: string; launch?: LaunchLike; saveImage?: SaveImage; now?: () => number }`
  - `type LaunchLike = () => Promise<BrowserLike>`；`BrowserLike = { newPage(): Promise<PageLike>; close(): Promise<unknown> }`
  - `type PageLike = { setViewportSize(v: { width: number; height: number }): Promise<unknown>; goto(url: string, o: { waitUntil: "load"; timeout: number }): Promise<unknown>; waitForTimeout(ms: number): Promise<unknown>; screenshot(o: { type: "png"; fullPage: boolean }): Promise<Uint8Array>; route?(pattern: string, handler: (route: RouteLike) => Promise<void>): Promise<void> }`
  - `type RouteLike = { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }`
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/huaanwork-web-tools && corepack yarn test`
Expected: FAIL（`./screenshot.ts` 只有占位导出）

- [ ] **Step 3: 实现 screenshot.ts + 声明 playwright-core（在 plugin 包）**

1. `dsh-plugin-huaanwork/package.json` 的 **`dependencies`** 加 `"playwright-core": "1.63.0",`（**精确 pin，不要用 range**：锁文件既有条目是精确描述符 `playwright-core@npm:1.63.0`，由 `playwright@1.63.0` transitive 带入；精确 pin 命中同一描述符 ⇒ 零新下载面。若写 `^1.49.0` 之类 range 则生成新描述符、yarn 走 registry 重新解析——可联网时可能漂移到 >1.63.0 引入新下载与版本分叉，离线时解析失败）。这是运行时归属：tsdown 只 external 本插件的 prod/peer，`import("playwright-core")` 才能留在打包产物里，`verify:licenses` 也只走这条声明图。
2. `packages/huaanwork-web-tools/package.json` 的 **`devDependencies`** 加同一个 `"playwright-core": "1.63.0",`。该包的 `tsc`（NodeNext）从包目录解析 `import("playwright-core")`；不声明的话，依赖若只落在 `dsh-plugin-huaanwork/node_modules`，本包 `yarn check` 会报找不到模块。**不要**放进这个包的 `dependencies`：它会被 tsdown 内联，prod 声明不会进入插件的许可图，造成假绿。
3. `corepack yarn install`（更新 lockfile；插件的 prod dep ⇒ tsdown external）。
4. **本任务不要**改 `@huaanwork/web-tools` 在插件上的依赖。那条放在 Task 5，且必须是插件的 **devDependencies**（与 `:379-381` 的 `@huaanwork/*` 族同处）。放进插件 `dependencies` 会被 tsdown external，而该包 exports 指向 `./src/web.ts`（运行时无 TS 剥离）⇒ 启动即崩。

`packages/huaanwork-web-tools/src/screenshot.ts`：

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isLanEndpoint } from "@huaanwork/policy/network";

import { NETWORK_GATE_ERROR, type CheckNetwork } from "./web.ts";

export type RouteLike = {
  request(): { url(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
};

export type PageLike = {
  setViewportSize(viewport: { width: number; height: number }): Promise<unknown>;
  goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<unknown>;
  screenshot(options: { type: "png"; fullPage: boolean }): Promise<Uint8Array>;
  route?(pattern: string, handler: (route: RouteLike) => Promise<void>): Promise<void>;
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
  } catch (error) {
    // 启动失败按消息分流：只有"找不到可执行文件"才是缺 Chrome 的指路文案；
    // 其他启动错误（权限、profile 锁、协议不支持）按原样报出，避免误导排查方向。
    const message = error instanceof Error ? error.message : String(error);
    if (/executable|doesn't exist|ENOENT|channel/i.test(message)) {
      return { ok: false, error: CHROME_MISSING_ERROR };
    }
    return { ok: false, error: `截图失败：${message}` };
  }

  let blockedPublic = false;
  try {
    const page = await browser.newPage();
    await page.setViewportSize({
      width: args.width ?? DEFAULT_VIEWPORT.width,
      height: args.height ?? DEFAULT_VIEWPORT.height,
    });
    // 首跳已在函数入口检查。Playwright goto 会自己跟随 302，子资源也会打到公网。
    // 公网开关关闭时，任一非局域网请求都中止，避免局域网地址跳到公网仍被画进 PNG。
    if (!deps.checkNetwork() && page.route) {
      await page.route("**/*", async (route) => {
        const url = route.request().url();
        if (isLanEndpoint(url)) {
          await route.continue();
          return;
        }
        blockedPublic = true;
        await route.abort();
      });
    }
    await page.goto(args.url, { waitUntil: "load", timeout: GOTO_TIMEOUT_MS });
    if (blockedPublic) return { ok: false, error: NETWORK_GATE_ERROR };
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
    if (blockedPublic) return { ok: false, error: NETWORK_GATE_ERROR };
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
git add packages/huaanwork-web-tools dsh-plugin-huaanwork/package.json yarn.lock
git commit -m "feat(web-tools): screenshot 纯逻辑（playwright-core channel:chrome + attachment 缝）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: guardrails/web.ts 接线 + 注册 + 白名单

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-guardrails/web.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts`（`ALLOWED_TOOLS` 加两个名字）
- Modify: `dsh-plugin-huaanwork/src/profile.ts`（insert 列表 `:1467` 的 huaanwork-git 行之后）
- Modify: `dsh-plugin-huaanwork/package.json`（exports map + **devDependencies** 的 `@huaanwork/web-tools`；`playwright-core` 已由 Task 4 放进 dependencies）
- Modify: `dsh-plugin-huaanwork/tsdown.config.ts`（entry `:42` 的 git 行之后）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/web.cordis.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/profile.spec.ts`（`expectedOrder` 数组 `'huaanwork-git'` 后加 `'huaanwork-web'`）

**Interfaces:**
- Consumes: Task 3/4 的 `webFetch` / `screenshot` / `NETWORK_GATE_ERROR` / `CHROME_MISSING_ERROR`；`ctx.huaanworkProfileDir`（`guardrails/policy.ts:141` 已有的 holder 约定）；`ctx.huaanworkWorkspaceRoot: { current: string }`（`git.ts` 同款）；attachment 服务不读 `ctx.attachments`。`apply` 里 `ctx.inject(['attachments'], …)`，回调中 `inner.get('attachments')`（与 `tool-fs` 的 `ctx.inject(['attachments'])` + `read-image.ts` 的 `ctx.get('attachments')` 同形）。`saveImages(inputs)` 返回 `ImageAttachmentRef[]`。`attachment-local` 行在 dsh-base 挂载且本变体未禁用；inject 回调没跑到时 `saveImage` 留空，只走路径兜底。
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

type AttachmentStore = {
  saveImages(
    inputs: readonly { data: Uint8Array; mediaType: "image/png"; name?: string }[],
  ): Promise<readonly unknown[]>;
};

type Context = {
  huaanworkProfileDir?: string;
  huaanworkWorkspaceRoot?: { current: string };
  /** Cordis：未 inject 的服务不会挂在 ctx 上。attachments 用 inject 回调记下。 */
  inject?(names: readonly string[], callback: (inner: { get?(name: string): AttachmentStore | undefined; attachments?: AttachmentStore }): void): void;
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
  render(_args: unknown, value: { ok: boolean; text?: string; error?: string; url?: string }) {
    if (!value.ok) return [{ type: "text" as const, text: value.error ?? "web_fetch failed" }];
    // 截断提示已在 webFetch 的 text 里（…[截断]），这里不要再加一句。
    return [{ type: "text" as const, text: (value.text ?? "").trimEnd() }];
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
  // tool-fs 用 ctx.inject(['attachments']) 才拿得到 store（deepseek-harness/.../tool-fs/src/index.ts）。
  // 直接读 ctx.attachments 在只 inject 了 tools 的插件上是空的，图片块永远不会出现。
  // 工具本身始终注册：服务未挂载时 saveImage 留空，只走路径兜底。
  let attachments: AttachmentStore | undefined;
  ctx.inject?.(["attachments"], (inner) => {
    attachments = inner.get?.("attachments") ?? inner.attachments;
  });

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
        const saveImage = attachments
          ? async (png: Uint8Array, name: string) =>
              (await attachments!.saveImages([{ data: png, mediaType: "image/png", name }]))[0]
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
   **`devDependencies`**（不是 `dependencies`）加 `"@huaanwork/web-tools": "*",`——与 `:379-381` 的 `@huaanwork/*` 族同处。**这是硬约束**：tsdown 只 external prod/peer deps，放进 `dependencies` 会被 external，而该包的 exports 指向 `./src/web.ts`（运行时无 TS 剥离）⇒ 启动即崩；**playwright-core 反过来必须在 `dependencies`**（Task 4 Step 3）。
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
Expected: **不新增失败**（基线已有 1 项红：`electron-shell-generation.ts` 漂移；`src/huaanwork-guardrails/` 在 oneSidedPrefixes 白名单内，profile.ts/present-as.ts 已在既有 `allowedDifferences` 清单内，新增行不改变在册状态——只核对新增失败里没有本任务的四个文件）

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/web.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts dsh-plugin-huaanwork/src/profile.ts dsh-plugin-huaanwork/package.json dsh-plugin-huaanwork/tsdown.config.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/web.cordis.spec.ts dsh-plugin-huaanwork/tests/profile.spec.ts yarn.lock
git commit -m "feat(huaanwork): 接线 web_fetch/screenshot 进 agent 工具面（L3）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 威胁模型登记 + 全门禁验收

**Files:**
- Modify: `docs/superpowers/specs/2026-10-12-agent-toolbox-design.md`（追加威胁模型节）

- [ ] **Step 1: 威胁模型四条登记**

在设计文档〈范围外 / 延后项〉之后追加：

```markdown
## 威胁模型登记（2026-10-12 工具箱扩展）

1. **bash 出网旁路**：`allow_network` 总闸只管 web_fetch/screenshot/模型端点；`bash` 执行的命令（如 curl）不受其门控，由 `decideShell` 三档护栏负责（full 档下 curl 直接放行，ask/smart 档弹审批或按元字符规则拒绝）。
2. **write/edit 沙箱越级参数**：上游 tool-fs 在 `fs-sandbox`(workspace-write) 下给 write/edit 展开 `sandbox_permissions`/`justification` 参数；实测只能越过沙箱、越不过 huaanwork-policy 的 pre-execute 判定（spike §4.5），deny 即终局。
3. **nohup/& 自管后台**：后台任务管理面本轮不开放（jobs/tool-jobs 硬锁定），但 full 档下模型可用 `nohup … &` 自管后台进程（spike §4.6 实测），产物无管理面可回收；开放 job_* 管理面是后续独立裁定。
4. **链路本地元数据地址**：`isLanEndpoint` 把整段 `169.254.0.0/16`（含 `169.254.169.254`）和 `*.local` 视为局域网。`allow_network=off` 时 `web_fetch` / `screenshot` 仍放行这些地址。这是复用模型端点谓词的结果，本轮不改谓词；云主机上 agent 因此可以 GET 实例元数据服务。
```

- [ ] **Step 2: 全量门禁（各 workspace 串行）**

Run: `corepack yarn test && corepack yarn typecheck && corepack yarn check`
Expected: test/typecheck PASS；`check` 唯一允许的红 = `check:layout` 链路内 `check:desktop-variants` 的既有漂移（`electron-shell-generation.ts`，见债表末行；root `check` 经 `check:layout` 间接包含 `check:desktop-variants`）。因 `&&` 短路被跳过的后续步骤（各 workspace check）须单独补跑确认。本计划新增/修改的文件不得出现在任何失败清单；`check:whitespace` 对新增源码文件的尾部空白敏感，属本计划真实相关面。

（工作树基线：69 项未提交删除——`assets/`、`_deprecated/`。全量门禁需在验收记录里注明该基线脏度，且不得把这些删除混进本计划的提交；`icons:check`/`check:layout` 若因它们红，先 `git stash` 或单独核实再归因。）

Run: `corepack yarn workspace dsh-plugin-huaanwork check`
Expected: PASS（含 verify:licenses / verify:closure 等；`verify:aa` 若因既有并发竞争红，单独重跑该步确认——债表首行的 pre-existing flakiness，不算本计划回归）

- [ ] **Step 3: 隔离实例验收（人工，沿用 spike 方法）**

**前置交付（本步骤的一部分）**：把下面三份脚本写入 `scripts/spike/`。spike 报告「证据文件位置」只点了 `/tmp/huaanwork-spike/rows.mjs`，没有 `cdp.mjs` / `probe.mjs` 的正文，那些临时文件不能当来源。脚本以本节代码为准。

`scripts/spike/rows.mjs`（先 `corepack yarn workspace dsh-plugin-huaanwork build`，再 `DSH_HOME=... node scripts/spike/rows.mjs`）：

```js
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../../dsh-plugin-huaanwork/package.json", import.meta.url));
// composeEntries 由 dsh-app-boot 导出（profile.ts/profile.spec.ts 同源）；
// cordis-plugin-loader 不导出它（实测 undefined），写错包名会在调用处 TypeError。
const { composeEntries } = require("@deepseek-ai/dsh-app-boot");
const { prepareDesktopProfile } = await import(pathToFileURL(new URL("../../dsh-plugin-huaanwork/lib/profile.js", import.meta.url)).href);

const home = process.env.DSH_HOME;
if (!home) {
  console.error("DSH_HOME is required");
  process.exit(1);
}
const prepared = prepareDesktopProfile(process.env.DSH_TELEMETRY_DISABLED, home, process.platform);
const rows = new Map(composeEntries([prepared.patches]).map((row) => [row.id, row]));
const shell = process.platform === "win32" ? "tool-pwsh" : "tool-bash";
for (const id of ["tool-fs", "tool-fs-search", shell, "jobs", "tool-jobs"]) {
  const row = rows.get(id);
  console.log(JSON.stringify({ id, disabled: row?.disabled ?? null, config: row?.config ?? null }));
}
```

`scripts/spike/cdp.mjs`（`node scripts/spike/cdp.mjs <port> '<expression>'`，在第一个 page target 里 `Runtime.evaluate`）：

```js
const port = process.argv[2] ?? "9223";
const expression = process.argv[3];
if (!expression) {
  console.error("usage: node scripts/spike/cdp.mjs <port> <js expression>");
  process.exit(1);
}
const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const page = list.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) {
  console.error("no page target");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let nextId = 0;
function send(method, params) {
  const messageId = ++nextId;
  ws.send(JSON.stringify({ id: messageId, method, params }));
  return new Promise((resolve) => {
    const onMessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id !== messageId) return;
      ws.removeEventListener("message", onMessage);
      resolve(data);
    };
    ws.addEventListener("message", onMessage);
  });
}
const evaluated = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(evaluated.result, null, 2));
ws.close();
```

`scripts/spike/probe.mjs`（`node scripts/spike/probe.mjs <port> <prompt>`，页面内 `POST /huaanwork/session/send`）：

```js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const port = process.argv[2] ?? "9223";
const text = process.argv.slice(3).join(" ");
if (!text) {
  console.error("usage: node scripts/spike/probe.mjs <port> <prompt>");
  process.exit(1);
}
const expression = `fetch('/huaanwork/session/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:${JSON.stringify(text)}})}).then(async (response)=>({status:response.status,body:await response.text()}))`;
const child = spawn(process.execPath, [fileURLToPath(new URL("./cdp.mjs", import.meta.url)), port, expression], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
```

- `rows.mjs` 覆盖下方第 1 项。
- `cdp.mjs` + `probe.mjs` 覆盖第 2/4/5/6 项。发完消息后到隔离实例的会话里看 `request/header` 与 `tool/result`（spike 报告 §3 的读法）。

按 spike 报告 §2 的隔离骨架起实例（**不带**机器级 patch——本轮验收的是仓库内改动生效；DSH_HOME 用临时目录 + `--user-data-dir` 隔离 + wizard-skipped 标记）：

- [ ] 行状态直读：`tool-fs`/`tool-fs-search`/`tool-bash`（win 为 `tool-pwsh`）= `disabled:false`，`tool-bash.config.enableRunInBackground === false`，`jobs`/`tool-jobs` 保持 `disabled:true`；
- [ ] 会话 `request/header` 工具目录 = 14 个（6 git + read/write/edit/glob/grep/bash + web_fetch + screenshot）；若只合到 Task 1（L1/L2）则为 12 个——按实际合入点写清预期；
- [ ] `bash` 的 schema 参数表**不含** `run_in_background`；
- [ ] 越界 `read /etc/passwd` → deny（REASON_PATH_ESCAPE 文案）；
- [ ] `bash` 审批回归（spike 三组实验之第三组，设计〈测试策略〉明确要求）：ask 档下 `bash curl …` 弹审批、元字符命令按规则拒绝；
- [ ] `web_fetch` 在 allow_network=off 抓公网 → 指路错误；抓局域网 → 放行；
- [ ] `screenshot` 对一个本地可起的服务页出 PNG，且会话内可见图片块（若模型不支持视觉则至少路径兜底可见）。

**Windows 侧覆盖说明（设计〈实施验证项 3〉）**：`tool-pwsh` 分支（Task 1 的 win32 行断言）与 playwright `channel: "chrome"` 在 Windows 目标机的可用性，在任何 CI 通道都无测试执行——`desktop-windows` job（`ci.yml:158-169`）只跑 `check:win-package:platform`/`dist:win`/`dist:win-portable`，不跑 vitest。登记为**人类真机核对项**，与债表「Windows 发行面制品校验零证据」同批触发（有一台 Windows 主机可用时执行）：① Windows 上起实例直读 `tool-pwsh` = `disabled:false` 且 `enableRunInBackground === false`；② Windows + 系统 Chrome 下跑一条 `screenshot` 验收。

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/specs/2026-10-12-agent-toolbox-design.md scripts/spike/rows.mjs scripts/spike/cdp.mjs scripts/spike/probe.mjs
git commit -m "docs: 工具箱扩展威胁模型登记，并入库隔离验收脚本

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review 记录

- **Spec 覆盖**：复挂（Task 1）✓、policy 2 case（Task 2）✓、web-tools 包+清单同步（Task 3）✓、screenshot（Task 4）✓、接线+白名单+注册（Task 5）✓、威胁模型四条+验收脚本（Task 6）✓。范围外项（web_search/后台任务/完整浏览器控制）无任务，符合 spec。
- **行号漂移**：文中行号为写作时实测值，实施时以符号名/锚点文本为准（A/B 判据 §4 同约定）。
- **类型一致性**：Task 3/4 的 Produces 签名与 Task 5 的 Consumes 已逐条对齐（`CheckNetwork`/`SaveImage`/`WebFetchResult`/`ScreenshotResult`）。

## 审查修订汇总（2026-10-12，初审 + 独立对抗性检查）

**已并入本计划的修订**（修订点见各任务内联说明）：

| 修订 | 位置 | 依据 |
|---|---|---|
| 清单同步补第 6 处：`dsh-plugin-huaanwork/tests/package.spec.ts` | Task 3 Step 6/7 + 提交清单 | P0-1（对抗检查确认为必红项） |
| `@huaanwork/web-tools` 归 **devDependencies**（external 语义） | Task 5 Step 4 | N1（tsdown 只 external prod/peer） |
| `playwright-core` 运行时归 **plugin 的 dependencies**；三审补：**同一精确 pin 再放 web-tools 的 devDependencies**（只给 tsc，不进该包 dependencies） | Task 4 Step 3 | P0-3②；三审补类型解析 |
| Task 4 测试与实现对齐（`slugHost` 带端口 → 用例 URL 改无端口） | Task 4 Step 1 | N2（原断言必失败） |
| 三处 `check:desktop-variants` 预期从 PASS 改为"不新增失败" | Global Constraints / Task 1·5·6 | N3（基线已有 1 项红） |
| 工作树基线脏度（69 项删除）写入验收前提 | Task 6 Step 2 | N4 |
| 隔离验收脚本以计划正文入仓（不引用 `/tmp` 原稿） | Task 6 Step 3/4 | P2-1；三审：证据节没有 cdp/probe 正文 |
| web_fetch 改用 policy 新增的 `readCappedBytes`（字节级截断）+ charset 解码 + UA + 重定向白名单 | Task 3 Interfaces/Step 4 + `http-cap.ts/.test.ts` | P1-1 成立 + P1-2 部分成立（不照抄上游同源全等） |
| `market-dependency-direction.mjs` 的改动降级为"补覆盖空窗"（非红项） | Task 3 Files/Step 6 | P0-2 证伪 |
| 市场依赖守卫测试**不改**（只断言包含） | Task 3 Step 6 | P0-2 证伪 |

**对抗检查证伪、未进入计划的项**（避免实施时被误导）：

- 「代理面未处理」——伪阳性：本变体在 Host 启动前已通过 `installProxyFromEnvironment` 接管 undici 全局 dispatcher，裸 `globalThis.fetch` 已走代理。
- 「screenshot 缺 `isConcurrencySafe` 是疏漏」——撤回：`git.ts` 仅 2/6 声明且均为只读，缺省即 exclusive，是符合上游约定的保守选择。
- 「license/closure 因 playwright-core 走样」——撤回：`verify-licenses` 只走声明依赖图、`runtime-closure` 只查 `@deepseek-ai` 首方；真问题在依赖**归属**（已按上表修订）。
- 「照抄上游同源重定向策略」——撤回该建议：同源 = scheme+host+port 全等，会误伤内网常见的换端口与 http→https 升级。

**实施时仍需留意**（低优先，不阻塞）：

- `screenshot` 的 PNG 落盘路径不经 policy 的 forWrite 检查，实施时在 `screenshot.ts` 落一行注释说明该边界（当前 `workspaceRoot` 被 sandbox 钉死，风险低）。
- Task 5 的 cordis 测试里 `lan` 用例依赖 `127.0.0.1:9` 不可达产生失败路径——属预期（证明门控放行而非拦截），断言只检查"不是门控文案"，不要把具体网络错误写死。

## 二审修订汇总（2026-10-12，对照设计文档复核 + 代码实测）

评审方法：设计 ↔ 计划逐节对照，计划中 20+ 处代码引用逐条对仓实测（上游 `deepseek-harness` bundle patch / tool Config schema，本仓 policy / settings / profile / spec / 清单守卫 / lockfile / CI workflow）。结论：计划对设计的覆盖基本完整、事实准确性高；以下 6 项修订已全部并入任务正文。

| # | 修订 | 位置 | 依据（实测） |
|---|---|---|---|
| 1 | 补全 `htmlToText` 实现（原代码块留白，仅有一句 `&amp;` 顺序提示；测试 import 它、Interfaces 承诺导出它、`webFetch` 调用它，缺失则 typecheck/test 双红） | Task 3 Step 5 | 计划里 `web.ts` 代码块 imports 仅 2 条，无该函数 |
| 2 | 锚点文本订正：`git_status`/`git_diff` 不是独立 case 组，而是与 `skill`/`todo_write`/`subagent` 五 case 共享一个 `return ALLOW` | Task 2 Files/Step 3 | `packages/huaanwork-policy/src/decide.ts:89-94` |
| 3 | playwright-core 由 `^1.49.0` 改**精确 pin `1.63.0`**：range 生成新 lockfile 描述符 → yarn 重新解析（联网漂移 / 离线失败）；「零新下载面」只对精确 pin 成立 | Task 4 Step 3 | `yarn.lock:20215` 既有描述符为 `playwright-core@npm:1.63.0`（精确） |
| 4 | 补「bash ask/元字符 deny」隔离验收项——设计〈测试策略〉明确要求沿用 spike 三组实验，原清单只有前两组 | Task 6 Step 3 | 设计文档〈测试策略〉L1/L2 段 |
| 5 | 补 Windows 侧覆盖说明：`tool-pwsh` 断言与 playwright `channel:chrome` 的 win 可用性在任何 CI 通道都无测试执行，登记为人类真机核对项 | Task 6 Step 3 | `ci.yml:158-169` desktop-windows 只打包不跑 vitest |
| 6 | 全量门禁由 `test && typecheck && check:desktop-variants` 改为完整 `corepack yarn check`（对齐设计〈测试策略〉承诺；`check:whitespace` 对新增文件真实相关；既有 variant 红经 `check:layout` 间接出现，`&&` 短路的后续步骤须单独补跑） | Task 6 Step 2 | `package.json:1357-1358` root check 构成 |

**二审抽查确认无问题、无需修订的关键引用**（防止后续评审重复消耗）：`RowHitAssertion` 的 `intent:'override'`+`expectConfig` 形状；`profile.spec.ts:1235` disable 矩阵与 `:1268` expectedOrder；`http-cap.ts` 的 `readCappedText` 确为 UTF-8 专用（`readCappedBytes` 重构前提成立）；`isLanEndpoint` 含回环/RFC1918（Task 5 的 `127.0.0.1:9` 用例成立）；settings 文件名/主键/旧 key 兼容与 `readAllowNetwork` 逐字对应；`present-as.ts` 的 `"git_push"` 锚点；上游 dsh-base 挂载四行 + attachment-local、web-app overlay 关闭四行、`enableRunInBackground` zod default；三份 `package.spec.ts` 的 `toHaveLength(11)`；root test 链与 `expected-root-gate-scripts.json` 字符串一致。

## 三审修订汇总（2026-10-12，对照代码再审）

| # | 修订 | 位置 |
|---|---|---|
| 1 | Task 4 文件头、依赖说明与 `git add` 对齐：`playwright-core@1.63.0` 运行时在插件 `dependencies`，同一 pin 再写入 web-tools `devDependencies` 供 `tsc`；`@huaanwork/web-tools` 的插件 devDependency 仍只在 Task 5 | Task 4 Files / Step 3 / Step 5 |
| 2 | 补 `readCappedBytes` 的失败测试与实现；`trimIncompleteUtf8` 留在 `readCappedText`；删掉 `streamChunks`，`webFetch` 直接传入 `res.body` | Task 3 Step 4 / Step 5 |
| 3 | `screenshot` 用 `ctx.inject(['attachments'])` 记下 store，cordis 测试钉住这次订阅；工具仍始终注册 | Task 5 Interfaces / Step 1 / Step 3 |
| 4 | 公网关闭时 `page.route("**/*")` 中止非局域网请求，并补一条会失败的测试 | Task 4 Interfaces / Step 1 / Step 3 |
| 5 | 截断提示只留在 `text` 的 `…[截断]`，接线 `render` 不再追加第二句 | Task 3 Step 5 / Task 5 Step 3 |
| 6 | 验收脚本改为计划内全文；`git add` 包含 `scripts/spike/`。威胁模型补 `169.254.169.254` / `*.local` | Task 6 Step 1 / Step 3 / Step 4 |

**三审复核订正（2026-10-12，对本轮改动再实测）**：

1. `rows.mjs` 原稿从 `@deepseek-ai/cordis-plugin-loader` 取 `composeEntries`——实测该包**不导出**它（`undefined`），真正来源是 `@deepseek-ai/dsh-app-boot`（`profile.ts:19-33`、`profile.spec.ts:16` 同源）；已订正，原写法跑到调用处即 TypeError。
2. 截断提示改为「只写进 `text`」后丢了**字节级截断**情形的标记（`capped.truncated` 而字符未超限时正文无 `…[截断]`）；已改为 `capped.truncated || overChars` 任一成立即追加。
3. 复核确认本轮其余改动成立：`ctx.inject(['attachments'])` 与上游 `tool-fs/src/index.ts:70` 同形（static inject 只含 `['tools','fs','systemPrompt']`，attachments 靠运行时 inject）；去掉 `streamChunks` 修掉了「取消只到包装流、停不掉原始 `res.body`」的真实缺陷；`page.route` 不拦 `data:`/`about:blank`（非网络请求不过 handler），无误伤面；威胁模型第 4 条与 `isLanEndpoint` 的链路本地判定一致。
4. 一处论证夸大（结论不变）：「web-tools 不声明 playwright-core 则 `yarn check` 报找不到模块」——node-modules linker 下该包已被 hoist 到根 `node_modules`，tsc 今天能幻影解析到；声明 devDependency 仍是正确纪律，但失败模式不是必然。

