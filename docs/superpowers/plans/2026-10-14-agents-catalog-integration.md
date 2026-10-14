# 三个智能体接入侧边栏「智能体」模块 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把错别字检测、代码审查、任务编排三个智能体以 HTTP 小工具形态接入 HuaAnWork 侧边栏「智能体」模块(公用机目录下发,@点名调用)。

**Architecture:** 公用机上跑四个常驻服务:新建的目录服务(M-A0,`GET /v1/catalog` 下发条目)+ 三个智能体的 HTTP 适配(M-A1 code-review 作业化重构 / M-A2 typo-check 新建 FastAPI 包装 / M-A3 task-orch 新增 `/agent-invoke` 路由)。异步作业统一 `submit/status/result` 三 action;同步操作秒回。桌面端零改动。

**Tech Stack:** Node 22+(零依赖 `node:http` + `node:test`,M-A0/M-A1)、TypeScript + `node:sqlite`(M-A3)、Python 3.11+ FastAPI + uvicorn + pytest(M-A2)。

**设计依据:** `docs/superpowers/specs/2026-10-13-agents-catalog-integration-design.md`(两轮评审通过)。下文引用为「设计 §x」。

**执行状态(2026-10-14):** M-A0~M-A3 已实现并通过代码评审——**以各仓 commit 链为执行凭证,checkbox 不逐项回勾**:agent-catalog-server(`9fceb61`→`d405fe8`)、代码审查智能体(`68ada9d`→`60b6b52`)、错别字检测智能体(`ff782e9`→`942ff91`)、任务编排智能体(`29c396c`→`3f54ddb`)。评审与处置记录见 `2026-10-14-agents-catalog-integration-code-review.md`(8/8 修复闭环,四仓回归 308/308)。A4-0 部署 runbook 已交付(`agent-catalog-server/docs/deployment-runbook.md`,预联调后已订正 Node 版本边界与 DEMO_API_TOKEN 前置);**M-A4 预联调(机器可执行部分)已完成**——证据 `docs/evidence/2026-10-14-agents-catalog-integration-precheck.md`(用例归档 `docs/evidence/assets/a4-precheck-2026-10-14/`);剩余 A4-1 GUI 联调与 A4-2 公用机切目录为人工真机两段。

**执行顺序:** M-A0 / M-A1 / M-A2 / M-A3 互不依赖,可四条线并行(建议每线一个子代理);M-A4 依赖前四者全部完成。

## Global Constraints

- 统一请求契约:`POST <entrypoint.url>`,body `{"arguments": {...}}`,头 `content-type: application/json` + `Authorization: Bearer <目录口令>`(设计 §2)。
- 统一响应约定:逻辑成功 `200 {"ok": true, "result": ...}`;逻辑失败 `200 {"ok": false, "error": "中文原因"}`;非 2xx 仅用于传输级失败(401/413/405/500)。`ok:false` 只表达失败/拒绝语义(桌面端会解析为 isError);流程态走 `ok:true` + `state` 字段(设计 §2)。
- 所有 action 必须在 150s 硬顶内返回,设计上全部秒回;长任务一律异步作业(设计 §3.2)。
- 响应分片纪律:text 切片 ≤ 20KiB,且组装后 `JSON.stringify(响应)` UTF-8 字节数 ≤ 24KiB,超出自动缩短本片(设计 §3.2,防平台 32KiB 截成不合法 JSON)。
- Bearer 比较必须 timing-safe;目录口令统一经环境变量 `AGENT_CATALOG_TOKEN` 注入(设计 §4)。
- 401 响应体统一中文(如 `{"error":"口令错误"}`,提升模型可读性)(设计 §5)。
- 作业状态机:`queued → running → done / failed`;重启时 `queued/running → interrupted`;终态保留 24h 后物理删除(无 `expired` 状态);jobId = `jr_` + 12 位 base62(设计 §3.2)。
- 条目 `entrypoint.url` 必须是 LAN/本机地址(桌面端强制校验,公网地址会被标 broken)(设计 §2)。
- 桌面端仓库 `HuaAnWork-Desktop` 零改动(设计 §6)。

---

## Part M-A0:目录服务端(新建)

**仓库位置(新建):** `/Users/amonmiao/Downloads/cursor/agent-catalog-server/`(与三个智能体仓库平级的独立目录,零三方依赖,纯 `.mjs` ESM)。

**契约真相源(实现前先读):**
- 桌面端解析器:`HuaAnWork-Desktop/packages/huaanwork-policy/src/agent-catalog.ts:73-188`(`parseCatalogItem` 校验规则:name 小写 slug ≤64、description ≤1024、tool 必须有 entrypoint、entrypoint.url 必须 LAN)。
- 客户端拉取:`HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/agents-host.ts:270-300`(列表,期望 `{"items":[...]}`)与 `:405-430`(详情,期望单条目 JSON);两者都带 `Accept: application/json` 与可选 Bearer。
- 条目形状参照:`HuaAnWork/scripts/agent-catalog-mock.mjs`(开发 mock,仅参考形状)。

### Task A0-1: Bearer 认证模块

**Files:**
- Create: `/Users/amonmiao/Downloads/cursor/agent-catalog-server/auth.mjs`
- Test: `/Users/amonmiao/Downloads/cursor/agent-catalog-server/test/auth.test.mjs`

**Interfaces:**
- Produces: `bearerOk(req: IncomingMessage, token: string): boolean` —— 被 Task A0-3 的路由处理器消费。

- [ ] **Step 1: 写失败测试**

```js
// test/auth.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { bearerOk } from "../auth.mjs";

function reqWith(header) {
  return { headers: header === undefined ? {} : { authorization: header } };
}

test("缺 Authorization 头拒绝", () => {
  assert.equal(bearerOk(reqWith(undefined), "secret"), false);
});

test("非 Bearer 方案拒绝", () => {
  assert.equal(bearerOk(reqWith("Basic abc"), "secret"), false);
});

test("口令错误拒绝", () => {
  assert.equal(bearerOk(reqWith("Bearer wrong"), "secret"), false);
});

test("口令正确放行", () => {
  assert.equal(bearerOk(reqWith("Bearer secret"), "secret"), true);
});

test("长度不同的口令不抛异常(timing-safe 等长保护)", () => {
  assert.equal(bearerOk(reqWith("Bearer a"), "much-longer-secret"), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/amonmiao/Downloads/cursor/agent-catalog-server && node --test test/auth.test.mjs`
Expected: FAIL,`Cannot find module '../auth.mjs'`

- [ ] **Step 3: 实现**

```js
// auth.mjs
import { timingSafeEqual, createHash } from "node:crypto";

/**
 * 校验 Authorization: Bearer <token>。
 * 先对两侧做 SHA-256 归一(等长),再 timingSafeEqual,避免长度泄漏与计时侧信道。
 */
export function bearerOk(req, token) {
  const header = req.headers?.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length);
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/auth.test.mjs`
Expected: 5 pass

- [ ] **Step 5: Commit**

```bash
cd /Users/amonmiao/Downloads/cursor/agent-catalog-server && git init -q 2>/dev/null; git add auth.mjs test/auth.test.mjs && git commit -m "feat: timing-safe Bearer 校验模块"
```

### Task A0-2: 条目存储(entries/ 目录现读)

**Files:**
- Create: `/Users/amonmiao/Downloads/cursor/agent-catalog-server/entries-store.mjs`
- Test: `/Users/amonmiao/Downloads/cursor/agent-catalog-server/test/entries-store.test.mjs`

**Interfaces:**
- Produces:
  - `loadEntries(dir: string): unknown[]` —— 读 `dir` 下全部 `.json`,逐文件 `JSON.parse`;解析失败的文件跳过并 `console.error` 警告(不因一个坏文件拖垮整个目录);
  - `findEntry(dir: string, name: string): unknown | undefined` —— 在 `loadEntries` 结果中按 `entry.name === name` 找第一个。
- 两个函数均为**每次调用现读磁盘**(不缓存),设计 §3.4「改文件即生效」。

- [ ] **Step 1: 写失败测试**(用 `fs.mkdtempSync` 造临时 entries 目录)

```js
// test/entries-store.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEntries, findEntry } from "../entries-store.mjs";

function withEntries(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "entries-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("读出全部合法条目,忽略非 .json 文件", () => {
  withEntries(
    {
      "a.json": JSON.stringify({ name: "alpha", kind: "tool" }),
      "b.json": JSON.stringify({ name: "beta", kind: "tool" }),
      "README.md": "不是条目",
    },
    (dir) => {
      const items = loadEntries(dir);
      assert.equal(items.length, 2);
      assert.deepEqual(items.map((i) => i.name).sort(), ["alpha", "beta"]);
    },
  );
});

test("坏 JSON 文件跳过不拖垮目录", () => {
  withEntries(
    { "bad.json": "{oops", "good.json": JSON.stringify({ name: "good", kind: "tool" }) },
    (dir) => {
      const items = loadEntries(dir);
      assert.equal(items.length, 1);
      assert.equal(items[0].name, "good");
    },
  );
});

test("每次调用现读磁盘(改文件即生效)", () => {
  const dir = mkdtempSync(join(tmpdir(), "entries-"));
  try {
    writeFileSync(join(dir, "x.json"), JSON.stringify({ name: "x", kind: "tool" }));
    assert.equal(loadEntries(dir).length, 1);
    writeFileSync(join(dir, "y.json"), JSON.stringify({ name: "y", kind: "tool" }));
    assert.equal(loadEntries(dir).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findEntry 按 name 命中与未命中", () => {
  withEntries({ "a.json": JSON.stringify({ name: "alpha" }) }, (dir) => {
    assert.equal(findEntry(dir, "alpha").name, "alpha");
    assert.equal(findEntry(dir, "nope"), undefined);
  });
});

test("目录不存在返回空数组", () => {
  assert.deepEqual(loadEntries("/nonexistent-entries-dir"), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/entries-store.test.mjs`
Expected: FAIL,`Cannot find module '../entries-store.mjs'`

- [ ] **Step 3: 实现**

```js
// entries-store.mjs
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** 现读 dir 下全部 .json 条目;坏文件跳过并警告。 */
export function loadEntries(dir) {
  if (!existsSync(dir)) return [];
  const items = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    try {
      items.push(JSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
      console.error(`条目文件解析失败,已跳过: ${path} (${err.message})`);
    }
  }
  return items;
}

export function findEntry(dir, name) {
  return loadEntries(dir).find((item) => item && item.name === name);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/entries-store.test.mjs`
Expected: 5 pass

- [ ] **Step 5: Commit**

```bash
git add entries-store.mjs test/entries-store.test.mjs && git commit -m "feat: entries/ 目录现读存储"
```

### Task A0-3: HTTP 路由与启动入口

**Files:**
- Create: `/Users/amonmiao/Downloads/cursor/agent-catalog-server/server.mjs`
- Create: `/Users/amonmiao/Downloads/cursor/agent-catalog-server/bin.mjs`
- Test: `/Users/amonmiao/Downloads/cursor/agent-catalog-server/test/server.test.mjs`

**Interfaces:**
- Consumes: `bearerOk`(A0-1)、`loadEntries`/`findEntry`(A0-2)。
- Produces:
  - `createCatalogServer(opts: { entriesDir: string, token: string }): http.Server` —— 不 listen,交由调用方;
  - 路由:`GET /v1/catalog` → `200 {"items":[...]}`;`GET /v1/catalog/<name>` → `200 <条目>`;未认证 `401 {"error":"口令错误"}`;未命中 `404 {"error":"条目不存在"}`;非 GET `405 {"error":"只支持 GET"}`。全部 JSON + `charset=utf-8`。

- [ ] **Step 1: 写失败测试**(起 ephemeral 端口真实 HTTP 打)

```js
// test/server.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCatalogServer } from "../server.mjs";

let server, base, dir;
const TOKEN = "test-token";

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "entries-"));
  writeFileSync(
    join(dir, "typo-check.json"),
    JSON.stringify({
      name: "typo-check",
      version: "0.1.0",
      kind: "tool",
      description: "检测 docx 错别字",
      entrypoint: { kind: "http", url: "http://192.168.1.10:18081/invoke" },
    }),
  );
  server = createCatalogServer({ entriesDir: dir, token: TOKEN });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("无口令 401 且中文文案", async () => {
  const res = await fetch(`${base}/v1/catalog`);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "口令错误");
});

test("列表返回 items 包装", async () => {
  const res = await fetch(`${base}/v1/catalog`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].name, "typo-check");
});

test("详情命中与 404", async () => {
  const ok = await fetch(`${base}/v1/catalog/typo-check`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).version, "0.1.0");
  const miss = await fetch(`${base}/v1/catalog/nope`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(miss.status, 404);
});

test("POST 405;未知路径 404", async () => {
  const post = await fetch(`${base}/v1/catalog`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(post.status, 405);
  const other = await fetch(`${base}/elsewhere`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(other.status, 404);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/server.test.mjs`
Expected: FAIL,`Cannot find module '../server.mjs'`

- [ ] **Step 3: 实现 server.mjs 与 bin.mjs**

```js
// server.mjs
import { createServer } from "node:http";
import { bearerOk } from "./auth.mjs";
import { loadEntries, findEntry } from "./entries-store.mjs";

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

export function createCatalogServer({ entriesDir, token }) {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (!bearerOk(req, token)) {
      return sendJson(res, 401, { error: "口令错误" });
    }
    if (req.method !== "GET") {
      return sendJson(res, 405, { error: "只支持 GET" });
    }
    if (path === "/v1/catalog") {
      return sendJson(res, 200, { items: loadEntries(entriesDir) });
    }
    const prefix = "/v1/catalog/";
    if (path.startsWith(prefix)) {
      const name = decodeURIComponent(path.slice(prefix.length));
      const entry = findEntry(entriesDir, name);
      if (entry) return sendJson(res, 200, entry);
      return sendJson(res, 404, { error: "条目不存在" });
    }
    return sendJson(res, 404, { error: "Not Found" });
  });
}
```

```js
// bin.mjs
import { createCatalogServer } from "./server.mjs";

const token = process.env.AGENT_CATALOG_TOKEN?.trim();
if (!token) {
  console.error("缺少环境变量 AGENT_CATALOG_TOKEN,拒绝启动");
  process.exit(1);
}
const port = Number(process.env.PORT || 18080);
const host = process.env.HOST || "127.0.0.1"; // 公用机部署时设为 LAN 地址
const entriesDir = process.env.ENTRIES_DIR || new URL("./entries/", import.meta.url).pathname;

createCatalogServer({ entriesDir, token }).listen(port, host, () => {
  console.error(`agent-catalog-server listening on http://${host}:${port}, entries: ${entriesDir}`);
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test`
Expected: 全部 pass(A0-1/A0-2/A0-3 共 14 条)

- [ ] **Step 5: Commit**

```bash
git add server.mjs bin.mjs test/server.test.mjs && git commit -m "feat: 目录服务路由与启动入口"
```

### Task A0-4: 首批三个条目文件 + 启动自检

**Files:**
- Create: `/Users/amonmiao/Downloads/cursor/agent-catalog-server/entries/typo-check.json`
- Create: `/Users/amonmiao/Downloads/cursor/agent-catalog-server/entries/code-review.json`
- Create: `/Users/amonmiao/Downloads/cursor/agent-catalog-server/entries/task-orch.json`
- Create: `/Users/amonmiao/Downloads/cursor/agent-catalog-server/README.md`

**Interfaces:**
- Consumes: A0-3 的服务。
- Produces: 三个条目文件,字段对桌面端 `parseCatalogItem` 合法(name 小写 slug、description ≤1024、entrypoint.url 为 LAN 占位)。**端口占位 `<LAN_IP>` 在部署时替换**;`argumentsSchema` 的 action 枚举必须与 M-A1/M-A2/M-A3 各自实现的 action 完全一致(交叉引用:typo-check/code-review = `submit/status/result`;task-orch = `run/list/runs/show/pause/resume/alerts/health`)。

- [ ] **Step 1: 写三个条目文件**

`entries/typo-check.json`(description 含防轮询与 jobId 复述引导,指令压短——它同时是面板 UI 文案,设计 §3.4 R2-2):

```json
{
  "name": "typo-check",
  "version": "0.1.0",
  "kind": "tool",
  "entrypoint": { "kind": "http", "url": "http://<LAN_IP>:18081/invoke" },
  "description": "检测 docx 错别字。异步:submit 提交(文档须在公用机共享目录)→ status 查进度 → result 分页取报告。submit 后把 jobId 告诉用户;status 为 running 时告知预计时长后结束回合,勿连续轮询。",
  "whenToUse": "用户要检查一份文档的错别字、用词错误时。",
  "argumentsSchema": {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["submit", "status", "result"] },
      "path": { "type": "string", "description": "submit:共享目录内 docx 绝对路径" },
      "jobId": { "type": "string", "description": "status/result:作业号" },
      "offset": { "type": "number", "description": "result:分页偏移字符数" }
    },
    "required": ["action"]
  },
  "permissions": ["读取共享目录内的文档", "调用大模型"]
}
```

`entries/code-review.json`:

```json
{
  "name": "code-review",
  "version": "1.0.0",
  "kind": "tool",
  "entrypoint": { "kind": "http", "url": "http://<LAN_IP>:18082/invoke" },
  "description": "审查目录源码(安全>规范>性能>可维护性)。异步:submit 提交 → status 查进度 → result 分页取报告。submit 后把 jobId 告诉用户;status 为 running 时结束回合,勿连续轮询。",
  "whenToUse": "用户要审查某目录下的代码质量与安全问题时。",
  "argumentsSchema": {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["submit", "status", "result"] },
      "root": { "type": "string", "description": "submit:待审父目录绝对路径" },
      "include": { "type": "string", "description": "submit:逗号分隔子文件夹名,最多3个" },
      "task": { "type": "string", "description": "submit:审查重点(可选)" },
      "jobId": { "type": "string", "description": "status/result:作业号" },
      "offset": { "type": "number", "description": "result:分页偏移字符数" }
    },
    "required": ["action"]
  },
  "permissions": ["读取本机目录源码", "调用大模型"]
}
```

`entries/task-orch.json`(schema 序列化后必须 < 1024 字符,逐字段短句,设计 §3.4 P3-4):

```json
{
  "name": "task-orch",
  "version": "0.1.0",
  "kind": "tool",
  "entrypoint": { "kind": "http", "url": "http://<LAN_IP>:8787/agent-invoke" },
  "description": "定时任务编排:手动触发、查任务/执行记录/告警、暂停恢复调度。",
  "whenToUse": "用户要触发或查看定时任务、查告警时。",
  "argumentsSchema": {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["run", "list", "runs", "show", "pause", "resume", "alerts", "health"] },
      "taskId": { "type": "string", "description": "run/pause/resume 用" },
      "execId": { "type": "string", "description": "show 用" },
      "limit": { "type": "number", "description": "runs/alerts 用,默认10上限50" }
    },
    "required": ["action"]
  },
  "permissions": ["触发与查看定时任务", "调用任务配置的 HTTP 端点"]
}
```

- [ ] **Step 2: 验证条目对桌面端解析器合法**

在 `HuaAnWork-Desktop` 仓库跑一段一次性脚本(不留文件):

```bash
cd /Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop && node --input-type=module -e "
import { parseCatalogItem } from './packages/huaanwork-policy/src/agent-catalog.ts';
" 2>/dev/null || echo '注意: .ts 需经 tsx/构建产物加载,改用 lib 产物或逐条人肉对照 parseCatalogItem 规则'
```

若直接加载 `.ts` 不可行,逐条对照 `parseCatalogItem`(`agent-catalog.ts:73-188`)人肉核对:name 匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` 且 ≤64、description 非空且 ≤1024、`entrypoint.kind === "http"`、url 协议 http 且为 LAN 形态(`<LAN_IP>` 占位在部署时替换为实际内网 IP 后再核一次)。
Expected: 三条目全部不产生 brokenReason。

- [ ] **Step 3: 验证 task-orch schema 注入长度 < 1024**

```bash
node -e "
const e = require('/Users/amonmiao/Downloads/cursor/agent-catalog-server/entries/task-orch.json');
const s = JSON.stringify(e.argumentsSchema);
console.log('schema chars:', s.length);
if (s.length >= 1024) { console.error('超限!'); process.exit(1); }
"
```
Expected: 输出字符数 < 1024。

- [ ] **Step 4: 写 README**(启动命令、环境变量 `AGENT_CATALOG_TOKEN`/`PORT`/`HOST`/`ENTRIES_DIR`、发布纪律「质检通过才把条目放进 entries/、改文件即生效、客户端目录缓存 60s TTL 最迟 60s 或手动刷新可见」)

- [ ] **Step 5: Commit**

```bash
git add entries/ README.md && git commit -m "feat: 首批三个智能体条目 + README"
```

---

## Part M-A1:code-review 作业化重构

**仓库:** `/Users/amonmiao/Downloads/cursor/代码审查智能体/`(纯 ESM,`"type":"module"`;server.mjs 只用 node: 内置模块;测试 `npm test` = `node --import tsx --test "test/*.test.ts" "test/*.test.mjs"`)。

**现状关键事实(已核实):** `server.mjs` 218 行,导出 `validateArgs`/`createServer`;模块级 `let busy` 串行锁;无路径检查(任意路径的 POST 都进处理)、无鉴权、`HOST` 硬编码 `127.0.0.1:27-28`;`runReview` spawn `npx tsx src/index.ts --root … --include … --out <tmpdir>`(`server.mjs:92-107`),汇总 outDir 下 `.md` 报告并截断到 `MAX_REPORT_CHARS = 28*1024`(`:33,128-151`);真实单份报告可达 40KB(`reports_typo/_.md`),截断是真风险;mock 模式 `CODE_REVIEW_MOCK=1`(`:101`)。CLI 对部分子文件夹失败返回退出码 0(`src/index.ts:129-132`)。

**目标形状:** 保留 CLI 不动,server 层改为作业模式;报告全文落盘、result 时分页(不再在收集时截断)。

### Task A1-1: 分片助手(序列化字节守帽)

**Files:**
- Create: `paginate.mjs`
- Test: `test/paginate.test.mjs`

**Interfaces:**
- Produces: `slicePage(text: string, offset: number): { text: string, offset: number, nextOffset: number, totalChars: number, hasMore: boolean }` —— 按字符切片,初始 ≤ 20000 字符,再模拟包进 `{"ok":true,"result":{...}}` 校验 `Buffer.byteLength(JSON.stringify(...))` ≤ 24*1024,超则递减至 1024 起步重切。M-A3 的 task-orch 不动态分页(它用降 limit 兜底),本模块仅本仓用。

- [ ] **Step 1: 写失败测试**

```js
// test/paginate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { slicePage } from "../paginate.mjs";

test("短文本单片返回", () => {
  const r = slicePage("你好世界", 0);
  assert.equal(r.text, "你好世界");
  assert.equal(r.hasMore, false);
  assert.equal(r.totalChars, 4);
});

test("长文本分页且 offset 连续", () => {
  const text = "x".repeat(45000);
  const p1 = slicePage(text, 0);
  assert.equal(p1.hasMore, true);
  const p2 = slicePage(text, p1.nextOffset);
  const p3 = slicePage(text, p2.nextOffset);
  assert.equal(p1.text.length + p2.text.length + p3.text.length, 45000);
  assert.equal(p3.hasMore, false);
});

test("换行密集文本序列化后仍 ≤24KiB", () => {
  const text = "错别字报告行\n".repeat(4000); // 约 28000 字符,JSON 膨胀明显
  const r = slicePage(text, 0);
  const wire = JSON.stringify({ ok: true, result: { state: "done", text: r.text, offset: r.offset, totalChars: r.totalChars, hasMore: r.hasMore } });
  assert.ok(Buffer.byteLength(wire, "utf8") <= 24 * 1024, `wire=${Buffer.byteLength(wire, "utf8")}`);
});

test("offset 越界返回空片", () => {
  const r = slicePage("abc", 99);
  assert.equal(r.text, "");
  assert.equal(r.hasMore, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/amonmiao/Downloads/cursor/代码审查智能体 && node --test test/paginate.test.mjs`
Expected: FAIL,`Cannot find module '../paginate.mjs'`

- [ ] **Step 3: 实现**

```js
// paginate.mjs
const SLICE_CHARS = 20_000;
const WIRE_CAP_BYTES = 24 * 1024;

/**
 * 按字符切片,再校验模拟线上响应的 UTF-8 字节数 ≤ 24KiB,超则缩短本片。
 * 纪律来自设计 §3.2:32KiB 平台帽作用在整个 JSON 响应上,超帽会被截成不合法 JSON。
 */
export function slicePage(text, offset) {
  const totalChars = text.length;
  const start = Math.min(Math.max(0, offset | 0), totalChars);
  let end = Math.min(start + SLICE_CHARS, totalChars);
  const envelope = (slice) =>
    JSON.stringify({ ok: true, result: { state: "done", text: slice, offset: start, totalChars, hasMore: start + slice.length < totalChars } });
  let slice = text.slice(start, end);
  while (slice.length > 1024 && Buffer.byteLength(envelope(slice), "utf8") > WIRE_CAP_BYTES) {
    slice = slice.slice(0, Math.floor(slice.length * 0.9));
  }
  return { text: slice, offset: start, nextOffset: start + slice.length, totalChars, hasMore: start + slice.length < totalChars };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/paginate.test.mjs`
Expected: 4 pass

- [ ] **Step 5: Commit**

```bash
cd /Users/amonmiao/Downloads/cursor/代码审查智能体 && git add paginate.mjs test/paginate.test.mjs && git commit -m "feat: 分片助手,按序列化字节守 24KiB 帽"
```

### Task A1-2: 作业存储(job-store)

**Files:**
- Create: `job-store.mjs`
- Test: `test/job-store.test.mjs`

**Interfaces:**
- Produces:
  - `createJob(dir: string, params: object): string` —— 生成 `jr_` + 12 位 base62 jobId,写 `<dir>/<jobId>.json`(`{jobId, state:"queued", params, createdAt, updatedAt}`),原子写( tmp + rename);
  - `readJob(dir: string, jobId: string): object | undefined`;
  - `updateJob(dir: string, jobId: string, patch: object): void`(合并写,刷新 updatedAt);
  - `countActive(dir: string): number`(state 为 queued/running 的作业数);
  - `cleanupExpired(dir: string, maxAgeMs = 24*3600*1000, now = Date.now()): number`(删除终态且 updatedAt 超龄的作业 json 与配套 `<jobId>.report.md`,返回清理数);
  - `markInterruptedOnBoot(dir: string): number`(把 queued/running 改 interrupted,返回数);
  - 作业报告全文存 `<dir>/<jobId>.report.md`(由 server  runner 写,job-store 不管内容)。
- 并发写安全:单进程内所有写经原子 rename;server 单进程运行,无跨进程写(设计 §3.2;WAL 非必需——JSON 文件方案)。

- [ ] **Step 1: 写失败测试**(mkdtemp 隔离;覆盖 create/read/update/countActive/cleanup/boot-interrupt/jobId 格式与唯一性/原子写不残留 tmp)

- [ ] **Step 2: 跑测试确认失败** — Expected: module not found

- [ ] **Step 3: 实现 `job-store.mjs`**(要点:`randomInt` 或 `randomBytes` 生成 base62;`writeFileSync(tmp)` + `renameSync` 原子替换;`cleanupExpired` 只删 `state ∈ {done,failed,interrupted}` 且 `now - updatedAt > maxAgeMs` 的;`markInterruptedOnBoot` 遍历改写)

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: Commit** — `feat: 作业存储,状态机 + 24h 清理 + 重启 interrupted`

### Task A1-3: server.mjs 作业化重写

**Files:**
- Modify: `server.mjs`(整体重写;保留 `validateArgs` 导出与原校验规则,`runReview` 改为「spawn + 收集全文落盘」的异步版)
- Test: `test/server.test.mjs`(改写;保留 mock 模式端到端,新增作业流用例)

**Interfaces:**
- Consumes: `slicePage`(A1-1)、`job-store`(A1-2)。
- Produces(`POST /invoke` 且仅此路径;其余 404;非 POST 405):
  - `submit`:`validateArgs` 原有规则(root 绝对路径且存在、include 一级目录名 ≤3 个、task ≤2000)→ `countActive ≥ 1` 返回 `{ok:false,error:"正在审查中,请稍后重试"}`(沿用现文案);否则 `createJob` 并**异步**启动 runner(spawn CLI,`stdio` pipe,close 后收集 `.md` 全文写入 `<jobId>.report.md`,成功 `done` 失败 `failed`),立即返回 `{ok:true,result:{jobId,state:"queued"}}`(code-review 不承诺预计时长,**省略 `estimatedMinutes`**——设计允许「给不了就省略」);
  - `status`:`{ok:true,result:{jobId,state,elapsedSeconds}}`;`running` 时附 `progress`(低成本实现:数作业 outDir 已落盘的 `.md` 份数对比 include 个数,拼「已产出 N/M 份报告」);不存在 → `{ok:false,error:"作业不存在或已过期"}`;
  - **部分失败诚实化**:CLI 对单个子文件夹失败返回退出码 0(`src/index.ts:129-132`),runner 须解析 CLI stdout 汇总行「成功/失败」计数,失败数 >0 时在作业记录写 `note:"N 个子文件夹审查失败:<名单>"` 并拼进 result 首片开头——与 interrupted 诚实标记同一精神,不允许报告静默缺角;
  - `result`:state≠done → `{ok:false,error:"作业尚未完成,当前状态:<state>"}`(failed/interrupted 时在 error 附原因);done → 读 report 文件经 `slicePage` 分页返回;
  - 认证:`AGENT_CATALOG_TOKEN` 未配置**拒绝启动**(与目录服务同口径);配置后所有请求须过 timing-safe Bearer(复用 sha256 归一 + timingSafeEqual 写法,本仓新建 `auth.mjs`,与 A0-1 同形);
  - `HOST` 改读 `process.env.HOST || "127.0.0.1"`;
  - 启动时 `markInterruptedOnBoot(JOBS_DIR)`;每 10 分钟 `cleanupExpired`(计时器 `unref()`);
  - `JOBS_DIR` 默认 `<repo>/data/jobs`(新增 .gitignore 行),可用 `JOBS_DIR` env 覆盖;
  - `CODE_REVIEW_MOCK=1` 行为不变(透传 `--mock`)。

- [ ] **Step 1: 改写测试**:mock 模式下 submit → 轮询 status 至 done(mock 秒级)→ result 分页取全;无口令 401;GET /invoke 405;POST /other 404;busy 时第二个 submit ok:false;bad jobId;result 未完成态拒绝。
- [ ] **Step 2: 跑测试确认失败**(新用例对旧 server 全失败)
- [ ] **Step 3: 重写 server.mjs**
- [ ] **Step 4: 跑测试确认通过**(`npm test` 全绿,含既有 reviewer/report/config/filewalk/spec/mailer 测试不受影响)
- [ ] **Step 5: 真 CLI 冒烟**:`CODE_REVIEW_MOCK=1 PORT=18765 AGENT_CATALOG_TOKEN=t node server.mjs`,`curl` 走 submit→status→result 全链。
- [ ] **Step 6: Commit** — `refactor: server.mjs 作业化(submit/status/result)+ Bearer + HOST 可配置 + /invoke 路径匹配`

### Task A1-4: 文档与质检脚本

- [ ] **Step 1:** 更新 `README.md`:server 模式改为作业模式的用法、`AGENT_CATALOG_TOKEN`/`HOST`/`JOBS_DIR` 环境变量、新契约示例;订正 README 里「本地入口调用超时 60 秒」与 server 头注释 150s 的不一致表述(两处都改成「平台单次调用超时 60–150s,作业模式不受其约束」)。
- [ ] **Step 2:** 新增 `scripts/smoke_http.sh`:起服务(mock)→ submit 最小 fixture → status → result → 断言 ok:true → 关服务,输出 PASS/FAIL。
- [ ] **Step 3:** 跑 smoke 确认 PASS。
- [ ] **Step 4: Commit** — `docs: 作业模式 README + smoke 脚本`

---

## Part M-A3:task-orch `/agent-invoke` 适配路由

**仓库:** `/Users/amonmiao/Downloads/cursor/任务编排智能体/`(TS,`module: NodeNext`,零运行时依赖,`npm run build` = `tsc`;**无测试框架**,`test/` 只有手工探针;`.graph/probe4-web.mjs` 有「build 后 import dist 起真实 HTTP 探测」的先例——本计划新增 `node --test` 的 `.mjs` 测试,同样跑在 dist 产物上,新增 `test` script:`"test": "npm run build && node --test test/*.test.mjs"`;既有 `test/mock-api.mjs` 等探针资产保留不改)。

**现状关键事实(已核实):** `startServer(store, {port, host?, token?, allowQueryToken?})` 返回 void(`src/server.ts:22-25`);`handle()` 私有、全 GET 路由(`:62-106`);`/health` 在认证前;`index.ts:76-79` 守护模式先 `new Scheduler(store, alerter, concurrency)` 再 `startServer(store, {...})`(不传 scheduler);`Scheduler.runNow` await 全链(`scheduler.ts:86-94`),`runTask` 私有、`execId` 在 `await executeTask` 前生成(`:149-169`),三条记录创建分支(互斥 skipped/上限 skipped/正常 running);告警推送已是 fire-and-forget(`alerter.ts:55-57`),守护进程不退出故触发即回不丢推送;防抖 `task.last_manual_at` 持久化(`scheduler.ts:89-90`)。

### Task A3-1: Scheduler 新增 triggerNow(触发即回)

**Files:**
- Modify: `src/scheduler.ts:97-231`(runTask 增 `onStarted` 回调)+ `:86-94` 下方新增 `triggerNow`
- Test: `test/trigger-now.test.mjs`(新建,import dist)

**Interfaces:**
- Produces:
  - `Scheduler.triggerNow(taskId: string): Promise<{ outcome: "triggered", execId: string } | { outcome: "debounced" } | { outcome: "skipped", execId: string } | { outcome: "not-found" }>` —— 1s 防抖照旧(DB 持久化);内部 `void this.runTask(..., { onStarted }).catch(...)` 不等待执行完成;`onStarted(execId)` 在 runTask 三条「插记录」分支各自插入成功后同步调用;runTask 的 `.catch` 必须落 `console.error`(防浮动 promise 静默,设计 R2-1)。
  - runTask 签名变为 `private async runTask(task, scheduledAt, trigger, hooks?: { onStarted?: (execId: string) => void })`;既有调用点(tick `void this.runTask(...)`:54-56、runNow:92)不传 hooks,行为不变。

- [ ] **Step 1:** `npm run build` 确认基线绿。
- [ ] **Step 2: 写失败测试**(dist 产物 + `new Store(":memory:")` + 假 task 直指 `http://127.0.0.1:1`(立刻 ECONNREFUSED,执行快败)):
  - triggerNow 返回 `outcome:"triggered"` 且有 execId,**耗时应 < 500ms**(证明没等执行完);
  - 1s 内第二次同 taskId → `debounced`;
  - 不存在 → `not-found`;
  - 等 2s 后 `store.getExecution(execId)` 可见且 status 为终态(证明后台真跑了)。
- [ ] **Step 3: 跑测试确认失败**(triggerNow 不存在)
- [ ] **Step 4: 实现** runTask hooks + triggerNow。
- [ ] **Step 5:** `npm run build && node --test test/trigger-now.test.mjs` 全绿。
- [ ] **Step 6: Commit** — `feat: Scheduler.triggerNow 触发即回(onStarted 回调拿 execId)`

### Task A3-2: agent-invoke 路由模块与接线

**Files:**
- Create: `src/agent-invoke.ts`
- Modify: `src/server.ts:22-32,62-68`(opts 加 `scheduler?: Scheduler`、`agentToken?: string`;handle 形参加两者;新增 POST `/agent-invoke` 分支,在 dashboard authOk 之外独立校验目录口令)
- Modify: `src/index.ts:79`(传 `scheduler` 与 `process.env.AGENT_CATALOG_TOKEN`)
- Test: `test/agent-invoke.test.mjs`

**Interfaces:**
- Consumes: `Scheduler.triggerNow`(A3-1)、`Store` 既有方法(`listTasks/listExecutions/getExecution/listAlerts/setTaskEnabled`)。
- Produces:
  - `handleAgentInvoke(req, res, store, scheduler, agentToken): Promise<void>` —— 认证:agentToken 未配置 → `503 {"error":"agent-invoke 未启用(缺 AGENT_CATALOG_TOKEN)"}` 并启动时 `console.error` 警告(守护主功能是调度,不因缺口令拒启);配置了则 timing-safe Bearer 校验(sha256 归一 + timingSafeEqual),失败 `401 {"error":"口令错误"}`;
  - body 上限 64KiB(超 413);`arguments.action` 分发:
    - `health` → `{ok:true,result:{status:"ok"}}`(复用 store.listTasks() 探活);
    - `list` → `{ok:true,result:{tasks}}`;
    - `run {taskId}` → triggerNow 结果映射:triggered `{ok:true,result:{outcome,execId,note:"已触发,用 runs/show 查结果"}}`;debounced `{ok:false,error:"触发过于频繁(1s 防抖),请稍后"}`;not-found `{ok:false,error:"任务不存在:<taskId>"}`;
    - `runs {taskId?,limit?}` / `alerts {limit?}` → 默认 limit=10、上限 50,**序列化字节兜底**:组装后 `Buffer.byteLength(JSON.stringify(...)) > 24*1024` 则 limit 减半重试至 1;
    - `show {execId}` → `store.getExecution`,缺失 `{ok:false,error:"执行记录不存在"}`;
    - `pause`/`resume {taskId}` → `setTaskEnabled` 返回 false → `{ok:false,error:"任务不存在"}`;
    - 未知 action → `{ok:false,error:"未知 action:<值>,支持 run/list/runs/show/pause/resume/alerts/health"}`。

- [ ] **Step 1: 写失败测试**(dist 起服务,`AGENT_CATALOG_TOKEN` 经 startServer 新 opts 注入;覆盖:无口令 401、错口令 401、health/list/run(指假端点快败)/runs/show/pause/resume/alerts、未知 action、超 64KiB body 413)
- [ ] **Step 2:** build + 跑测试确认失败
- [ ] **Step 3: 实现** `agent-invoke.ts` + server.ts/index.ts 接线
- [ ] **Step 4:** build + `node --test` 全绿
- [ ] **Step 5: Commit** — `feat: POST /agent-invoke 适配路由(目录 Bearer 独立校验)`

### Task A3-3: 冒烟与文档

- [ ] **Step 1:** 用 `examples/tasks.json` 配一个指向 `test/mock-api.mjs`(端口 9100)的任务,起守护:`AGENT_CATALOG_TOKEN=t DASHBOARD_TOKEN=d node dist/index.js --config tasks.json --db /tmp/orch-smoke.db --port 18787`;curl 带 Bearer 走 run→runs→show 全链;确认看板 `?token=` 在非回环绑定时自动禁用(既有行为,回归确认即可)。
- [ ] **Step 2:** 更新 `README.md` 与 `AGENTS.md` 的「路由面登记」一节(新增 `/agent-invoke` 一行,注明双 token 隔离与 LAN 绑定的姿态变化——设计 §4 第 2 条)。
- [ ] **Step 3: Commit** — `docs: /agent-invoke 路由登记与冒烟`

---

---

## Part M-A2:typo-check FastAPI 包装服务(新建)

**仓库:** `/Users/amonmiao/Downloads/cursor/错别字检测智能体/`(Python ≥3.11,`src/typoguard`,pytest `pythonpath=["src"]`;**零 HTTP 代码**,依赖仅 python-docx + openai)。

**现状关键事实(已核实):** 无「传文件路径返回结果」的库入口——形态是 **inbox 轮询守护**:docx 放进 `data/inbox/` → `Orchestrator.tick()` 取件(`orchestrator.py:272`)→ `process_task` 跑管线 → 产物(`report.md`/`report.json`/`verdicts.csv`)落 `pending_human/`;M1 冒烟脚本即用「循环 tick 直到 pending_human 非空」驱动(`scripts/run_m1_acceptance.sh:28-42`)。进度唯一外露 = `data/queue_status.json` 心跳(`{current:{blocks_done,blocks_total,eta_s}}`,`status/queue_status.py`)。`TYPOGUARD_VERIFIER_MOCK` 只 mock 校验器,A/B 车道仍真实调 LLM(`config.py:52`、`orchestrator.py:92-100`)。块级续扫能力真实存在(`Orchestrator.recover()` + `lane_cache/`,`dual_lane.py:54-64`),但 `lane_cache` 位于任务目录内(`orchestrator.py:202`),本计划的每作业独立数据目录意味着 **cache 只在同作业目录内 recover 时生效,跨作业不复用**——不要预期「重交同文档会变快」;本设计仍默认 interrupted(设计 §3.2)。典型报告 7–16KB(实测 `data/archive/…/report.md` 7.3KB),通常单片可返,但分页仍按纪律实现。

**总体形态:** 新文件全部放仓库根的 `api/` 包(与 `src/typoguard` 平级,不进 typoguard 包——它是上游管线,零改动):每作业一个独立 `Orchestrator` 实例 + 独立 `TYPOGUARD_DATA_DIR`(=`jobs/<jobId>/tg-data/`),跑在后台线程;并发 2(两个 Orchestrator 各自的 LaneLimiter 独立,合计 LLM 并发 ≤4,接受)。

### Task A2-1: 依赖与作业存储

**Files:**
- Modify: `pyproject.toml`(dependencies 加 `fastapi>=0.115`、`uvicorn>=0.30`)
- Create: `api/__init__.py`(空)、`api/jobstore.py`
- Test: `tests/test_api_jobstore.py`

**Interfaces:**
- Produces(与 M-A1 `job-store.mjs` 语义一一对应,Python 版):
  - `create_job(jobs_dir: Path, params: dict) -> str`(jobId = `"jr_"` + 12 位 base62,`secrets.choice`;原子写 `tmp` + `os.replace`);
  - `read_job(jobs_dir, job_id) -> dict | None`;
  - `update_job(jobs_dir, job_id, **patch) -> None`(刷新 `updated_at`);
  - `count_active(jobs_dir) -> int`;
  - `cleanup_expired(jobs_dir, max_age_s=86400, now=None) -> int`(删终态作业 json + `<jobId>.report.md` + `<jobId>/tg-data/` 整目录);
  - `mark_interrupted_on_boot(jobs_dir) -> int`。
- 时间字段统一 ISO8601 字符串 + 内部用 `time.time()` 比较。

- [ ] **Step 1: 写失败测试**(tmp_path 隔离;覆盖六函数 + jobId 格式 `^jr_[0-9A-Za-z]{12}$` + 原子写不残留 tmp + cleanup 连带删 tg-data)
- [ ] **Step 2: 跑测试确认失败** — `pytest tests/test_api_jobstore.py`,Expected: `ModuleNotFoundError: api.jobstore`
- [ ] **Step 3: 实现 `api/jobstore.py`**
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** — `feat(api): 作业存储(状态机 + 24h 清理 + 重启 interrupted)`

### Task A2-2: 路径安全、分片、认证三个纯函数模块

**Files:**
- Create: `api/security.py`、`api/paginate.py`、`api/auth.py`
- Test: `tests/test_api_security.py`、`tests/test_api_paginate.py`、`tests/test_api_auth.py`

**Interfaces:**
- Produces:
  - `resolve_under_root(raw_path: str, root: Path) -> Path` —— `Path(raw_path).resolve()` 后校验 `is_relative_to(root.resolve())`(防 `../` 与符号链接穿越);越界/不存在/非 `.docx` 抛 `ValueError(中文文案)`(设计 §3.3.1 根目录约束);
  - `slice_page(text: str, offset: int) -> dict` —— 与 A1-1 同纪律:切 ≤20000 字符,模拟 `json.dumps({"ok":True,"result":{...}}, ensure_ascii=False)` 的 `len(...encode("utf-8"))` ≤ 24*1024,超则 0.9 递减重切(下限 1024);返回 `{text, offset, next_offset, total_chars, has_more}`(序列化进线上响应时转 camelCase,见 Global Constraints 下方约定);
  - `bearer_ok(header: str | None, token: str) -> bool` —— sha256 归一 + `hmac.compare_digest`。

- [ ] **Step 1: 写失败测试**(路径:根内合法/`..` 穿越/符号链接穿越/不存在/`.txt` 后缀;分片:短文本/长文本连续 offset/换行密集字节守帽/越界;认证:缺头/非 Bearer/错误/正确/长度不同)
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现三个模块**
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** — `feat(api): 根目录约束 + 分片守帽 + timing-safe Bearer`

### Task A2-3: FastAPI 应用与作业 runner

**Files:**
- Create: `api/app.py`(FastAPI 应用 + `POST /invoke`)、`api/runner.py`(作业执行线程)
- Test: `tests/test_api_app.py`(FastAPI `TestClient` + 假 runner)

**Interfaces:**
- Consumes: A2-1/A2-2 全部;`typoguard.config.load_config`、`typoguard.orchestrator.Orchestrator`。
- Produces:
  - `create_app(*, jobs_dir: Path, allowed_root: Path, token: str, runner_factory=None) -> FastAPI` —— `runner_factory` 可注入假 runner(测试/冒烟用);默认 `real_runner`;
  - `real_runner(jobs_dir: Path, job_id: str, path: Path) -> None` —— 在 `jobs_dir/<jobId>/tg-data/` 建数据目录,`shutil.copy` 文档进 `inbox/`;`load_config({**(load_dotenv(str(p)) if (p := Path("<repo>/.env")).exists() else {}), **os.environ, "TYPOGUARD_DATA_DIR": str(tg_data)})`(`load_dotenv` 用 `typoguard.config:72` 的既有实现——仓内先例 `run_m1_acceptance.sh:30` 就是 `.env` 兜底 + 环境变量优先,密钥按仓惯例放 `.env`;**注意 `config.py:75` 的 `Path(path).read_text()` 对缺失文件抛 `FileNotFoundError`、并非返回空 dict,故组装式并入 `.env` 存在性守卫(存在才读入,不存在用空 dict)——launchd/systemd-only 注入与 `.env` 两种部署口径由此才真兼容**)→ `Orchestrator(cfg)` → 循环 `tick()`(间隔 5s)直至 `pending_human/` 出现产物;把 `report.md` 复制为 `jobs_dir/<jobId>.report.md`,`update_job(state="done")`;异常 `update_job(state="failed", error=str)`;每个作业跑在 `threading.Thread(daemon=True)`;
  - `POST /invoke` 行为:Bearer 失败 `401 {"error":"口令错误"}`;`submit`:`resolve_under_root` 校验 → `count_active >= 2` 返回 busy(`{ok:false,error:"当前有 2 个任务在跑,请稍后再提交"}`)→ `create_job` + 起线程 → `{ok:true,result:{jobId,state:"queued",estimatedMinutes:40}}`(`estimatedMinutes` 先写死 40——真实耗时 17–75min 量级,条目 description 承诺了「告知预计时长」,必须有字段承载;后续可按 queue_status 的 eta_s 演进);`status`:读作业 json,`running` 时附带读 `tg-data/queue_status.json` 的 `blocks_done/blocks_total/eta_s` 拼 `progress`(**注意 idle 时该文件 `current` 是空对象而非缺文件,空态省略 progress 字段**);`result`:`done` 才返,经 `slice_page` 分页;未完成 `ok:false`;jobId 不存在 `ok:false "作业不存在或已过期"`。

- [ ] **Step 1: 写失败测试**(TestClient;假 runner 直接写 `<jobId>.report.md` + `state=done`;覆盖:401 三态、submit 成功/越界路径/busy(并发=2)、status 三态、result 分页与未完成拒绝、坏 jobId)
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `api/runner.py` 与 `api/app.py`**
- [ ] **Step 4: 跑测试确认通过**(`pytest` 全绿,既有 38 个测试不受影响)
- [ ] **Step 5: Commit** — `feat(api): FastAPI /invoke(submit/status/result)+ 作业 runner`

### Task A2-4: 启动入口、冒烟与文档

**Files:**
- Create: `api/__main__.py`(uvicorn 启动)、`scripts/smoke_http.sh`;Modify: `README.md`、`.gitignore`(加 `data/jobs-api/`)

- [ ] **Step 1:** `api/__main__.py`:`AGENT_CATALOG_TOKEN` 缺失拒绝启动;`TYPOGUARD_ALLOWED_ROOT` 必填(共享目录);`HOST` 默认 `127.0.0.1`、`PORT` 默认 18081、`JOBS_DIR` 默认 `data/jobs-api`;启动时 `mark_interrupted_on_boot` + 每 10 分钟 `cleanup_expired`(后台 daemon 线程)。
- [ ] **Step 2:** `scripts/smoke_http.sh`:起服务(`TYPOGUARD_FAKE_RUNNER=1` 走假 runner 秒回,`api/__main__.py` 读此 env 注入假 runner——这是 wrapper 层自有的桩,与 `TYPOGUARD_VERIFIER_MOCK` 无关)→ curl 全链 submit→status→result → 断言 → PASS/FAIL。
- [ ] **Step 3:** 跑 smoke 确认 PASS;再跑 `pytest` 全仓绿。
- [ ] **Step 4:** README 新增「HTTP 服务形态」一节(env 清单、curl 示例、质检口径:CI 用 fake runner,公用机质检用最短 fixture 文档走真车道、接受单次耗时)。
- [ ] **Step 5: Commit** — `feat(api): 启动入口 + smoke + README`

---

## Part M-A4:联调与真机验收(人工,依赖 M-A0~M-A3)

**位置:** 开发机 + 公用机。**前置:** 四服务已部署到公用机(launchd/systemd,端口:目录 18080 / typo-check 18081 / code-review 18082 / task-orch 8787),`AGENT_CATALOG_TOKEN` 已统一配置,三个条目文件的 `<LAN_IP>` 已替换为公用机实际内网地址并复核 `parseCatalogItem` 不产生 brokenReason。

### Task A4-0: 部署工件与 runbook(先行,其余 A4 任务的前置)

**Files:**
- Create: `/Users/amonmiao/Downloads/cursor/agent-catalog-server/docs/deployment-runbook.md`

- [ ] **Step 1:** 写部署 runbook,覆盖四个服务的:launchd plist(或 systemd unit)模板各一(ExecStart/EnvironmentVariables 含 `AGENT_CATALOG_TOKEN`、`HOST`、各服务专属 env——typo-check 的 `TYPOGUARD_ALLOWED_ROOT`、code-review 的 `JOBS_DIR`、task-orch 的 `DASHBOARD_TOKEN`/`WEBHOOK_URL`)、端口分配表(18080/18081/18082/8787)、日志位置、重启策略(keepalive)、质检与发布纪律(「质检通过才放 entries/」「改文件即生效但客户端目录缓存 60s」)。
- [ ] **Step 2:** 四个仓库 README 各加一行指向该 runbook。
- [ ] **Step 3: Commit** — `docs: 公用机部署 runbook(四服务 unit 模板)`

### Task A4-1: 本地入口联调(绕开目录,先行验证)

- [ ] **Step 1:** 桌面端「智能体」面板「＋ 添加入口」登记 `code-review`:`http://<LAN_IP>:18082/invoke`,schema 从 `entries/code-review.json` 复制。
- [ ] **Step 2:** 聊天输入 `@code-review submit 审查 <公用机上某小仓库路径>` → 预期:模型调 call_host_tool,返回 jobId;`@code-review 查下 <jobId>` → running;完成后 result 分页取全报告(报告 >20KiB 时确认 hasMore 续拉完整)。
- [ ] **Step 3:** 同样流程登记并验证 `typo-check`(真 docx 放共享目录;40 分钟级任务确认 submit 秒回、status 有 progress)。
- [ ] **Step 4:** 登记并验证 `task-orch` 八个 action(run 确认「触发即回」< 2s 返回 execId,runs/show 能查到执行结果)。
- [ ] **Step 5:** 面板启停/删除三个入口表现正常;错口令场景确认 401 中文文案。

### Task A4-2: 切目录下发

- [ ] **Step 1:** 质检:四服务 smoke 脚本全 PASS,记录留档。**typo-check 真车道质检的前提**:公用机须配齐 `TYPOGUARD_LLM_API_KEY` 及 verifier 三件套,且 verifier 不得与 A/B 车道同厂商(`config.py:62-68` 的启动校验);不满足时用 `TYPOGUARD_VERIFIER_MOCK=true` 降级(只 mock 校验器,A/B 车道仍真实调用),否则现场撞 `StartupError`。
- [ ] **Step 2:** 条目文件放入公用机 `entries/`;面板填公用机地址/端口/口令,保存。
- [ ] **Step 3:** 「发现」页出现三条目(注意 60s 缓存 TTL,不见先点「刷新」);逐条「启用」确认权限弹窗文案正确。
- [ ] **Step 4:** 删除 A4-1 的三个本地入口,@点名重跑三个智能体各一次,确认目录路径与本地入口行为等价。
- [ ] **Step 5:** 验收记录写进 `docs/evidence/`(截图 + 请求样例),三个智能体仓库与 `agent-catalog-server` 各自打 tag/合并。

---

## 自查记录(写完即检)

- **Spec 覆盖:** 设计 §3.2 作业协议 → A1-1/A1-2/A2-1/A2-2;§3.3.1 → A2 全;§3.3.2 → A1 全;§3.3.3 → A3 全;§3.4 目录服务 → A0 全;§4 部署质检 → A4;§5 错误表 → 各 Task 错误用例;§7 测试清单 → 各 Task Step(24h 清理 A1-2/A2-1、并发写=原子 rename A1-2/A2-1、Bearer A0-1/A1-3/A2-2/A3-2)。
- **占位符:** `<LAN_IP>` 为部署期替换的刻意占位(已在 A0-4/A4 写明复核动作);无 TBD/TODO。
- **类型一致:** 三端 jobId 格式(`jr_`+12 位 base62)、state 枚举(queued/running/done/failed/interrupted)、action 词汇与 A0-4 条目 schema 已交叉核对;分片字段线上 JSON 统一 camelCase(`offset`/`totalChars`/`hasMore`),Python 内部 snake_case 在序列化时转换。

## 计划修订记录

- 2026-10-14:按 GLM 实施计划评审(复审 §10.3)修订——F1 删除「lane_cache 跨作业命中」错误声明(实为任务目录内,跨作业不复用);F2 runner env 组装补 `load_dotenv('.env')` 兜底(仓内先例 `run_m1_acceptance.sh:30`,两部署口径兼容);F3 typo-check submit 补 `estimatedMinutes` 字段(code-review 省略,设计允许);F4 code-review status 补低成本 progress(数已落盘报告份数),偏差就此登记;F5 runner 解析 CLI 汇总行,部分子文件夹失败写 note 并拼进 result 首片;F6 新增 Task A4-0 部署 runbook 与 unit 模板;F7 杂项(queue_status 空 `current` 态、措辞、符号化引用、A4 质检的 LLM key/verifier 前提)。
- 2026-10-14(评审方代笔,§10.6 复核遗留):修正 F2 补丁文本自身的错误声明——`config.py:75` 的 `load_dotenv` 对缺失文件抛 `FileNotFoundError` 而非返回空 dict;runner 组装式并入 `.env` 存在性守卫。至此 F1–F7 全部闭环,计划最终通过。
- 2026-10-14(实施后回执,SDD 最终整支评审 I-1):Global Constraints 虽以散文固定了统一请求信封(`body {"arguments": {...}}`),但各任务的测试指引各自编码了不同的具体请求体(code-review 顶层 `action`+`arguments` 混用、typo-check 全平铺、task-orch 正确嵌套)⇒ 四个任务级评审各自通过、信封漂移直到跨仓终审才暴露(code-review/typo-check 与桌面端 `agent-tool.ts:197` 的真实信封不兼容,真机调用 100% 失败)。已修(两仓统一读 `arguments` + 全部测试/冒烟改用真信封,提交 代码审查`d6fd300`、错别字`baa929b`)。**教训与后续计划纪律**:跨服务契约类全局约束必须附一个 canonical 信封示例(请求+响应各一),并强制所有服务的测试/冒烟脚本逐字使用该示例;任务级评审无法替代跨服务端到端契约核对,此类约束应在计划层显式登记「终审必查项」。
