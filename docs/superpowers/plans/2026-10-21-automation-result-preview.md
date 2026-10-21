# 自动化结果预览、运行记录删除与停止 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 华安高级模式的自动化运行对话把 JSON 产出折叠成「结果.md / 结果.html」附件，右侧「预览」可查看并下载到系统下载目录；运行记录支持单条删除（含会话目录）；「清理历史运行会话」保留条数降为 20；运行中的任务可从任务行与运行对话停止（排队轮跳过并消费到期档，已开始轮记「已取消」）。

**依据:** 规格 `docs/superpowers/specs/2026-10-21-automation-result-preview-design.md`（2026-10-21 终审通过）与规格评审 `docs/superpowers/specs/2026-10-21-automation-result-preview-design-review.md`（§七）。实施时不得偏离规格措辞；本计划只补代码级落点。

**状态:** 计划评审 `docs/superpowers/plans/2026-10-21-automation-result-preview-review.md` 的五条意见经复核**全部成立**（两条事实断言已独立核实：`listAutomations` 无锁读 `stores.ts:331-332`、`nextFireAfter` 对 once 的 `at > from` 语义 `schedule.ts:115`），五条处置均已落入本计划（第 1–4 条订正代码草图与用例、第 5 条订正引用与挂接锚点）。N2-O1 维持「接受窄窗口」。可以开始实施。

**Architecture:** 客户端纯逻辑进 `client-huaanwork/logic/`（折叠判定、块树、双渲染、文件名→保存路径），App.tsx 只做接线与持有预览选择；宿主侧在 `huaanwork-host/` 新增在途表模块（`automation-inflight.ts`，纯内存、被 host 与删除路径共用），`automations-host.ts` 承担 runId 前移 / 跳过 / 取消 / 停止，`automations-store.ts` 承担 prune 20 / 档位消费 / 删除与回写（注册表锁内**裸读改写**）；主窗口 `will-download` 只接管两个固定附件名。块树是 Markdown 与 HTML 的单一来源。

**Tech Stack:** TypeScript、Vitest、Electron（BrowserWindow session `will-download`）、现有 `dsh-plugin-huaanwork` 测试命令。

## Global Constraints

- 只改 `dsh-plugin-huaanwork`。不改 `deepseek-harness/`、`dsh-plugin-desktop/src/`、`dsh-plugin-desktop-beta/src/`、`dsh-desktop-next`。
- 变体守卫零新增：`src/huaanwork-host/` 是单侧前缀，`routes.ts` 不占 `allowedDifferences`；`src/electron-shell-generation.ts` 已是声明差异。两处改内容都不加白名单条目。提交前跑 `corepack yarn check:desktop-variants`。`will-download` 挂在 `mount()` 里 `renderer` 赋成 WebContents 之后。
- **锁不可重入**：`withAutomationRegistryLock` 是 promise 链互斥（`stores.ts:266-273`）。在它的锁内**禁止**调用 `updateAutomation` / `markAutomation` / `advanceNextRunAt` / `removeAutomation`（各自再取锁 = 自锁死）。锁内新代码（`consumeSkippedSlot`、`rewriteLastRunFromRuns`）一律 `readAutomationRegistry` → 原地改 → `writeAutomationRegistry`（`removeAutomationsOfProject` 是先例，`stores.ts:407-412`）。
- 注册表锁内不得获取运行记录锁（规格 §6；`recentRuns` 是裸读 `stores.ts:427-434`，锁内重读运行记录用它）。`withAppendRunLock` 与注册表锁保持顺序使用、不嵌套。
- 在途表纯内存（重启即失，无落盘、无迁移）；按 `runId` 索引，入队同步段写入。
- 执行体醒来后的**同步段不变量**（规格 §8 + 评审注记 2）：取消检查、阶段翻转、`run-start` 发射三者之间不得插入任何 `await`，实现处用注释钉住。
- 不改 `RUNS_LIMIT`（50）；不给任务行展开历史加删除按钮；不给纯排队轮单独做停止按钮；下载文件名不带时间戳、同名覆盖（规格 §2）。
- `ChatItem` / `ChatTab` 只在 `App.tsx` 内扩展；跨文件纯逻辑用结构化泛型（`chatTabs.ts` 先例），不导出 React 类型。
- 测试 headless-safe：不启动 Electron、不开真窗口。所有测试命令在仓库根目录执行，workspace 是 `dsh-plugin-huaanwork`。
- 样式改 `styles.css` 后必须 `corepack yarn workspace dsh-plugin-huaanwork gen:styles` 并连同 `styles.generated.ts` 一起提交。

## 登记的开口项（自评审文档 §7.3 移交）

| 编号 | 内容 | 处置 |
| --- | --- | --- |
| N2-O1 | stop 的档位消费声明同步、注册表写入异步。调度器读注册表不拿锁，写入让出事件循环时下一拍仍可能读到旧的 `nextRunAt` | **接受窄窗口，不闭**。`await Promise.all(consumptions)` 只推迟接口返回，关不掉这次读取。见计划评审第 1 条 |
| N2-O2 | 规格 §6「`finishAutomation` 先拿运行记录锁、再等注册表锁」实为**顺序**持锁非嵌套；「反过来嵌套会死锁」是假想嵌套下的前瞻约束，非当前代码事实 | 无需动作（措辞观察，防止后续评审者误报）。Task 8/9 的新锁内代码遵守其规则即可——即上方 Global Constraints 的锁不可重入条目 |

## File structure

| 文件 | 职责 |
| --- | --- |
| `dsh-plugin-huaanwork/src/client-huaanwork/logic/runResultAttachments.ts` | 折叠判定与折叠（strip think、JSON 判定、附件文件名常量） |
| `dsh-plugin-huaanwork/src/client-huaanwork/logic/runResultRender.ts` | 块树、Markdown、完整 HTML 文档 |
| `dsh-plugin-huaanwork/src/client-huaanwork/logic/attachmentDownload.ts` | 文件名是否附件、下载目录下的保存路径（主进程共用） |
| `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx` | `ChatItem`/`ChatTab` 扩展、两处折叠接线、附件按钮、预览面板、下载、标签关闭、运行对话停止按钮 |
| `dsh-plugin-huaanwork/src/client-huaanwork/AutomationsView.tsx` | 删除按钮与确认、任务行停止按钮、「上次」已取消覆盖、清理文案 50→20 |
| `dsh-plugin-huaanwork/src/client-huaanwork/logic/chatTabs.ts` | `closeRunTabsForSession`（删运行后关标签的纯逻辑） |
| `dsh-plugin-huaanwork/src/client-huaanwork/projects.ts` | `deleteAutomationRun` / `stopAutomation` 包装、prune 文档 20 |
| `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts` | 方法表加 `automation.deleteRun` / `automation.stop` |
| `dsh-plugin-huaanwork/src/huaanwork-host/automation-inflight.ts` | 在途表（类型、Map、按任务查询；无依赖、双向共用） |
| `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts` | runId 前移、同步段检查、取消覆盖、脚本 killer、`stopAutomation` |
| `dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts` | `AUTOMATION_SESSION_RETAIN_LIMIT=20`、`consumeSkippedSlot`、`deleteAutomationRun`、`rewriteLastRunFromRuns` |
| `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts` | `automation.stop` / `automation.deleteRun` 路由、prune 注释 20 |
| `dsh-plugin-huaanwork/src/electron-shell-generation.ts` | 主窗口会话 `will-download` 接管 |
| `dsh-plugin-huaanwork/src/client-huaanwork/styles.css`（+ `styles.generated.ts`） | 附件按钮、预览面板、下载按钮样式 |

---

### Task 1: 折叠判定纯逻辑

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/runResultAttachments.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/runResultAttachments.spec.ts`

**Interfaces:**
- Consumes: 无
- Produces: `RESULT_ATTACHMENT_FILES`（`readonly ["结果.md", "结果.html"]`）、`ResultAttachmentFile`、`stripThinkingForResult(text)`、`collectAssistantText(items)`、`isJsonResultText(text)`、`foldRunAssistantItems<T>(items, createAttachment)`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "vitest";

import {
  RESULT_ATTACHMENT_FILES,
  collectAssistantText,
  foldRunAssistantItems,
  isJsonResultText,
  stripThinkingForResult,
} from "../../src/client-huaanwork/logic/runResultAttachments.ts";

test("only object/array bodies fold; scalars, prose and empty text do not", () => {
  assert.equal(isJsonResultText('{"a":1}'), true);
  assert.equal(isJsonResultText("[1,2]"), true);
  assert.equal(isJsonResultText("{}"), true);
  assert.equal(isJsonResultText("[]"), true);
  assert.equal(isJsonResultText("null"), false);
  assert.equal(isJsonResultText("42"), false);
  assert.equal(isJsonResultText('"文本"'), false);
  assert.equal(isJsonResultText("true"), false);
  assert.equal(isJsonResultText("结果如下：{\"a\":1}"), false);
  assert.equal(isJsonResultText("   "), false);
});

test("think blocks are stripped with the same rule as the host store", () => {
  assert.equal(stripThinkingForResult('{"a":1}<think>隐藏</think>'), '{"a":1}');
  assert.equal(stripThinkingForResult('{"a":1}<think>没写完'), '{"a":1}');
  assert.equal(isJsonResultText('{"a":1}<think>x</think>'), true);
});

test("folding replaces every assistant item with one attachment at the first assistant position", () => {
  type Item = { id: number; kind: string; text?: string; sourceText?: string };
  const items: Item[] = [
    { id: 1, kind: "note", text: "自动化运行中…" },
    { id: 2, kind: "assistant", text: '{"a"' },
    { id: 3, kind: "tool", text: undefined },
    { id: 4, kind: "assistant", text: ":1}" },
  ];
  const folded = foldRunAssistantItems(items, (sourceText) => ({ id: 99, kind: "attachment", sourceText }));
  assert.equal(folded.length, 3);
  assert.equal(folded[1]?.kind, "attachment");
  assert.equal((folded[1] as { sourceText?: string }).sourceText, '{"a":1}');
  assert.equal(folded.some((item) => item.kind === "assistant"), false);
  assert.equal(folded.some((item) => item.kind === "tool"), true);
});

test("non-JSON bodies return the same array reference untouched", () => {
  const items = [{ id: 1, kind: "assistant", text: "普通句子" }];
  assert.equal(foldRunAssistantItems(items, () => ({ id: 99, kind: "attachment", sourceText: "" })), items);
});

test("attachment file names are exactly the two fixed names", () => {
  assert.deepEqual([...RESULT_ATTACHMENT_FILES], ["结果.md", "结果.html"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/runResultAttachments.spec.ts`
Expected: FAIL，找不到 `runResultAttachments.ts`

- [ ] **Step 3: Write minimal implementation**

```ts
/** 规格规格 §4.1/§4.2：整段助手回复是 JSON 对象或数组时收起为两份固定附件。 */
export const RESULT_ATTACHMENT_FILES = ["结果.md", "结果.html"] as const;
export type ResultAttachmentFile = (typeof RESULT_ATTACHMENT_FILES)[number];

/** 与宿主 automations-host.ts 的 stripModelThinking 同规则：去闭合块、丢未闭合块及其后文本。 */
export function stripThinkingForResult(text: string): string {
  const closed = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = closed.indexOf("<think>");
  return open >= 0 ? closed.slice(0, open) : closed;
}

export function collectAssistantText(items: readonly { kind: string; text?: string }[]): string {
  return items
    .filter((item) => item.kind === "assistant")
    .map((item) => item.text ?? "")
    .join("");
}

export function isJsonResultText(text: string): boolean {
  const stripped = stripThinkingForResult(text).trim();
  if (!stripped) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return false;
  }
  return typeof parsed === "object" && parsed !== null;
}

/** 不可折叠时原引用返回；可折叠时删掉全部 assistant，在第一个被删位置插入附件项。 */
export function foldRunAssistantItems<T extends { kind: string }>(
  items: readonly T[],
  createAttachment: (sourceText: string) => T,
): readonly T[] {
  if (!items.some((item) => item.kind === "assistant")) return items;
  const sourceText = stripThinkingForResult(
    collectAssistantText(items as readonly { kind: string; text?: string }[]),
  ).trim();
  if (!isJsonResultText(sourceText)) return items;
  const first = items.findIndex((item) => item.kind === "assistant");
  const rest = items.filter((item) => item.kind !== "assistant");
  return [...rest.slice(0, first), createAttachment(sourceText), ...rest.slice(first)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: 同 Step 2。Expected: PASS

### Task 2: 块树与 Markdown / HTML 双渲染

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/runResultRender.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/runResultRender.spec.ts`

**Interfaces:**
- Consumes: 无（不 import Task 1，渲染输入是已折叠的 `sourceText`）
- Produces: `ResultBlock`（heading/bold-label/paragraph/table/list/empty）、`jsonToBlocks(value)`、`blocksToMarkdown(blocks)`、`blocksToHtmlDocument(blocks)`、`renderResultMarkdown(sourceText)`、`renderResultHtml(sourceText)`

**块规则（规格 §4.3，逐条对应）:** 顶层对象字段→二级标题；嵌套对象逐级加一、最高四级、更深用加粗段落；全对象数组→表格（列按首次出现、跳过 `__proto__`，单元格压平：对象/数组一行 `JSON.stringify`、字符串换行→空格）；其他数组→列表；字符串按原文（不转义 `#`/反引号——表格单元格例外，`\|` 转义只在 Markdown 表格侧做）；数字/布尔/null→文本；`{}`/`[]`→（空对象）/（空数组）。HTML 用同一批块、同一份压平文本，再做 HTML 转义；完整文档含 doctype/utf-8/标题「结果」，无脚本、无外链。

- [ ] **Step 1: Write the failing test**（覆盖规格 §9 第 1、2 条测试要求）

```ts
import assert from "node:assert/strict";
import { test } from "vitest";

import { blocksToHtmlDocument, blocksToMarkdown, jsonToBlocks, renderResultHtml, renderResultMarkdown } from "../../src/client-huaanwork/logic/runResultRender.ts";

test("top-level object fields become level-2 sections with plain text values", () => {
  const md = renderResultMarkdown('{"标题":"值","数量":3,"开关":true,"空":null}');
  assert.ok(md.includes("## 标题"));
  assert.ok(md.includes("值"));
  assert.ok(md.includes("3"));
  assert.ok(md.includes("true"));
  assert.ok(md.includes("null"));
});

test("array of objects becomes a table with first-seen column order and __proto__ skipped", () => {
  const md = renderResultMarkdown('[{"b":1,"a":2},{"a":3,"c":4,"__proto__":9}]');
  const header = md.split("\n").find((line) => line.startsWith("|")) ?? "";
  assert.ok(header.includes("b"));
  assert.ok(header.indexOf("b") < header.indexOf("a"));
  assert.ok(header.includes("c"));
  assert.ok(!header.includes("__proto__"));
});

test("table cells escape pipes and flatten newlines; prose strings outside tables do not escape", () => {
  const table = renderResultMarkdown('[{"文本":"a|b\nc"}]');
  assert.ok(table.includes("a\\|b c"));
  const prose = renderResultMarkdown('{"说明":"x|y # 不是标题"}');
  assert.ok(prose.includes("x|y"));
  assert.ok(prose.includes("# 不是标题"));
});

test("plain arrays become lists; nested objects climb headings then fall to bold labels", () => {
  const md = renderResultMarkdown('{"l1":{"l2":{"l3":{"l4":{"l5":"深"}}}},"arr":[1,2]}');
  assert.ok(md.includes("## l1"));
  assert.ok(md.includes("### l2"));
  assert.ok(md.includes("#### l4"));
  assert.ok(md.includes("**l5**"));
  assert.ok(md.includes("- 1"));
});

test("empty object and array get their fixed labels", () => {
  const md = renderResultMarkdown('{"a":{},"b":[]}');
  assert.ok(md.includes("（空对象）"));
  assert.ok(md.includes("（空数组）"));
});

test("html document is complete, escaped, script-free", () => {
  const html = renderResultHtml('{"x":"<script>alert(1)</script>"}');
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.ok(html.includes('<meta charset="utf-8">'));
  assert.ok(html.includes("<title>结果</title>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("http://") && !html.includes("https://"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/runResultRender.spec.ts`
Expected: FAIL，找不到模块

- [ ] **Step 3: Write minimal implementation**

```ts
export type ResultBlock =
  | { kind: "heading"; text: string; level: 2 | 3 | 4 }
  | { kind: "bold-label"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "list"; items: string[] }
  | { kind: "empty"; text: string };

/** 单元格/列表项的压平文本（规格 §4.3）：换行→空格；对象/数组一行 JSON.stringify；其余 String()。 */
function flattenCell(value: unknown): string {
  if (typeof value === "string") return value.replace(/\r?\n/g, " ");
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function objectKeysOf(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => key !== "__proto__");
}

function valueBlocks(key: string, child: unknown, level: number): ResultBlock[] {
  if (child !== null && typeof child === "object") {
    const label: ResultBlock = level <= 4 ? { kind: "heading", text: key, level: level as 2 | 3 | 4 } : { kind: "bold-label", text: key };
    return [label, ...jsonToBlocks(child)];
  }
  if (level <= 4) return [{ kind: "heading", text: key, level: level as 2 | 3 | 4 }, { kind: "paragraph", text: flattenCell(child) }];
  return [{ kind: "bold-label", text: key }, { kind: "paragraph", text: flattenCell(child) }];
}

export function jsonToBlocks(value: unknown): ResultBlock[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ kind: "empty", text: "（空数组）" }];
    if (value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) {
      const columns: string[] = [];
      for (const row of value as Record<string, unknown>[]) {
        for (const key of objectKeysOf(row)) if (!columns.includes(key)) columns.push(key);
      }
      return [{
        kind: "table",
        columns,
        rows: (value as Record<string, unknown>[]).map((row) => columns.map((col) => flattenCell(row[col]))),
      }];
    }
    return [{ kind: "list", items: value.map(flattenCell) }];
  }
  if (value !== null && typeof value === "object") {
    const entries = objectKeysOf(value as Record<string, unknown>);
    if (entries.length === 0) return [{ kind: "empty", text: "（空对象）" }];
    const blocks: ResultBlock[] = [];
    for (const key of entries) blocks.push(...valueBlocks(key, (value as Record<string, unknown>)[key], 2));
    return blocks;
  }
  return [{ kind: "paragraph", text: String(value) }];
}

const escapeCell = (text: string): string => text.replace(/\|/g, "\\|");

export function blocksToMarkdown(blocks: readonly ResultBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "heading": lines.push(`${"#".repeat(block.level)} ${block.text}`, ""); break;
      case "bold-label": lines.push(`**${block.text}**`, ""); break;
      case "paragraph": lines.push(block.text, ""); break;
      case "table": {
        lines.push(`| ${block.columns.map(escapeCell).join(" | ")} |`);
        lines.push(`| ${block.columns.map(() => "---").join(" | ")} |`);
        for (const row of block.rows) lines.push(`| ${row.map(escapeCell).join(" | ")} |`);
        lines.push("");
        break;
      }
      case "list": for (const item of block.items) lines.push(`- ${item}`); lines.push(""); break;
      case "empty": lines.push(block.text, ""); break;
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function blocksToHtmlDocument(blocks: readonly ResultBlock[]): string {
  const body: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "heading": body.push(`<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`); break;
      case "bold-label": body.push(`<p><strong>${escapeHtml(block.text)}</strong></p>`); break;
      case "paragraph": body.push(`<p>${escapeHtml(block.text)}</p>`); break;
      case "table": {
        body.push("<table><thead><tr>");
        for (const col of block.columns) body.push(`<th>${escapeHtml(col)}</th>`);
        body.push("</tr></thead><tbody>");
        for (const row of block.rows) {
          body.push("<tr>");
          for (const cell of row) body.push(`<td>${escapeHtml(cell)}</td>`);
          body.push("</tr>");
        }
        body.push("</tbody></table>");
        break;
      }
      case "list": body.push(`<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`); break;
      case "empty": body.push(`<p>${escapeHtml(block.text)}</p>`); break;
    }
  }
  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>结果</title>",
    "<style>body{font-family:system-ui,-apple-system,sans-serif;margin:24px;color:#1f2328}table{border-collapse:collapse;margin:8px 0}th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left}h2,h3,h4{margin:20px 0 8px}</style>",
    "</head>",
    `<body>${body.join("")}</body>`,
    "</html>",
  ].join("");
}

export function renderResultMarkdown(sourceText: string): string {
  return blocksToMarkdown(jsonToBlocks(JSON.parse(sourceText)));
}

export function renderResultHtml(sourceText: string): string {
  return blocksToHtmlDocument(jsonToBlocks(JSON.parse(sourceText)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: 同 Step 2。Expected: PASS

### Task 3: ChatItem 附件种类与 App 两处折叠接线

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`（`ChatItem` `:194-202`、run-end 分支 `:997-1009`、回填效果 `:1339-1342`、`ChatRow` `:3118` 及其调用处）
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`（扩展）

**Interfaces:**
- Consumes: `foldRunAssistantItems`、`RESULT_ATTACHMENT_FILES`
- Produces: `ChatItem` 新联合成员 `{ id: number; kind: "attachment"; sourceText: string }`；`ChatRow` 新 prop `onOpenAttachment?: (file: ResultAttachmentFile) => void`

- [ ] **Step 1: Write the failing test**（沿用 appWiring 的「驱动生产函数 + 钉调用点」模式）

```ts
test("run tabs fold assistant JSON into one attachment at both call sites", () => {
  const items = [
    { id: 1, kind: "note", text: "自动化运行中…" },
    { id: 2, kind: "assistant", text: '{"a":1}' },
    { id: 3, kind: "tool", text: undefined },
  ];
  const folded = foldRunAssistantItems(items, (sourceText) => ({ id: 9, kind: "attachment", sourceText }));
  assert.equal(folded[1]?.kind, "attachment");

  const app = readFileSync(join(import.meta.dirname, "../../src/client-huaanwork/App.tsx"), "utf8");
  // 两处调用：run-end 分支与回填效果。删任一处接线即红（helper 全绿但 App 不调用的回归门）。
  assert.equal(app.split("foldRunAssistantItems").length - 1, 2);
  // 脚注必须接在折叠之后（脚注仍在末尾）。
  const backfill = app.indexOf("historyToChatItems(view)");
  assert.ok(backfill >= 0 && app.indexOf("foldRunAssistantItems", backfill) > backfill);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/appWiring.spec.ts`
Expected: FAIL（App.tsx 尚无调用点）

- [ ] **Step 3: Implement**

1. `ChatItem` 联合追加 `{ id: number; kind: "attachment"; sourceText: string }`。
2. run-end 分支（`:1002-1008`）：在追加脚注**之前**对目标标签折叠：

```tsx
setChatTabs((prev) =>
  prev.map((tab) =>
    tab.id === target
      ? {
          ...tab,
          items: [
            ...foldRunAssistantItems(tab.items, (sourceText) => ({ id: allocId(), kind: "attachment" as const, sourceText })),
            { id: allocId(), kind: "note" as const, text: resultLabel },
          ],
        }
      : tab,
  ),
);
```

3. 回填效果（`:1339-1342`）：`historyToChatItems` 之后、脚注 push 之前折叠：

```tsx
const items = foldRunAssistantItems(
  historyToChatItems(view),
  (sourceText) => ({ id: allocId(), kind: "attachment" as const, sourceText }),
);
```

4. `ChatRow` 增加 `attachment` 分支：一行两个按钮（`RESULT_ATTACHMENT_FILES.map`），点击调 `onOpenAttachment?.(file)`；把该 prop 从 App 的聊天区渲染处穿下去（同 `onAnswer`/`onInput` 的既有穿法）。

- [ ] **Step 4: Run test to verify it passes**

Run: 同 Step 2。Expected: PASS

### Task 4: 预览面板与客户端下载

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`（`ChatTab` `:217-234`、右侧预览分支 `:2633-2638`、新增 `handleOpenAttachment` / `downloadAttachment`）、`styles.css`
- Run: `corepack yarn workspace dsh-plugin-huaanwork gen:styles`

**Interfaces:**
- Consumes: `renderResultMarkdown` / `renderResultHtml`、`RESULT_ATTACHMENT_FILES`
- Produces: `ChatTab.previewFile?: ResultAttachmentFile`（预览选择记在标签上，规格 §5）

**Behaviors（规格 §5 逐条）:** 点附件→留在当前对话、右侧切「预览」、收起则展开；换标签再回来显示该标签上次的选择；未点过保持空占位；md 显示原文（`<pre>`）、html 是 `sandbox=""` iframe + 完整文档 `srcDoc`；已打开附件时标题旁有「下载」，只下载当前这一份；空占位无下载按钮。

- [ ] **Step 1: Implement**

```tsx
// ChatTab 追加字段
previewFile?: ResultAttachmentFile;

function handleOpenAttachment(file: ResultAttachmentFile) {
  setChatTabs((prev) => prev.map((tab) => (tab.id === activeTab ? { ...tab, previewFile: file } : tab)));
  setRightTab("preview");
  setRightCollapsed(false);
}

function downloadAttachment(file: ResultAttachmentFile, sourceText: string) {
  const content = file === "结果.md" ? renderResultMarkdown(sourceText) : renderResultHtml(sourceText);
  const blob = new Blob([content], { type: file === "结果.md" ? "text/markdown" : "text/html" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file;
  anchor.click();
  URL.revokeObjectURL(url);
}
```

右侧预览分支（替换 `:2633-2638` 的空占位为条件渲染）：

```tsx
const activeAttachment = items.find((item) => item.kind === "attachment");
// rightTab === "preview" 时:
activeAttachment && activeChat.previewFile ? (
  <div className="panel-card preview-card">
    <p className="h preview-head">
      <span>{activeChat.previewFile}</span>
      <button type="button" className="side-action" onClick={() => downloadAttachment(activeChat.previewFile!, activeAttachment.sourceText)}>
        下载
      </button>
    </p>
    {activeChat.previewFile === "结果.md" ? (
      <pre className="preview-md">{renderResultMarkdown(activeAttachment.sourceText)}</pre>
    ) : (
      <iframe className="preview-frame" sandbox="" title="结果" srcDoc={renderResultHtml(activeAttachment.sourceText)} />
    )}
  </div>
) : (
  /* 既有空占位原样保留 */
)
```

`styles.css` 增加 `.attachment-row` / `.attachment-file` / `.preview-card` / `.preview-head` / `.preview-md` / `.preview-frame`（iframe 撑满面板高度、`pre` 横向滚动），然后 `gen:styles`。

- [ ] **Step 2: Verify**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/ && corepack yarn workspace dsh-plugin-huaanwork gen:styles`
Expected: 既有客户端测试全绿；`styles.generated.ts` 更新且无 diff 残留（提交时一并带上）

### Task 5: 主窗口下载接管

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/attachmentDownload.ts`
- Modify: `dsh-plugin-huaanwork/src/electron-shell-generation.ts`（`mount()` 内、`this.renderer = renderer` 赋值之后（`:343` 附近）；`renderer` 在 `:341` 是 **WebContents**（`this.compatibilityShell?.webContents ?? window.webContents`），`renderer.session` 才是挂接点——不要挂在 `:319` 刚构造的 `BrowserWindow` 上，它没有 `.session`；现有 `renderer.session.webRequest` 先例在 `:144`）
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/attachmentDownload.spec.ts`

**Interfaces:**
- Consumes: `RESULT_ATTACHMENT_FILES`
- Produces: `isResultAttachmentFilename(filename)`、`attachmentSavePath(filename, downloadsDir): string | undefined`（undefined = 不接管）

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

import { attachmentSavePath } from "../../src/client-huaanwork/logic/attachmentDownload.ts";

test("the two attachment names map into the downloads dir; everything else is untouched", () => {
  assert.equal(attachmentSavePath("结果.md", "/dl"), "/dl/结果.md");
  assert.equal(attachmentSavePath("结果.html", "/dl"), "/dl/结果.html");
  assert.equal(attachmentSavePath("其他.txt", "/dl"), undefined);
  assert.equal(attachmentSavePath("结果.md.exe", "/dl"), undefined);
});

test("the main window session owns the will-download interception (wiring contract)", () => {
  const source = readFileSync(join(import.meta.dirname, "../../src/electron-shell-generation.ts"), "utf8");
  assert.ok(source.includes("will-download"));
  assert.ok(source.includes("attachmentSavePath"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/attachmentDownload.spec.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```ts
import { join } from "node:path";

import { RESULT_ATTACHMENT_FILES, type ResultAttachmentFile } from "./runResultAttachments.ts";

export function isResultAttachmentFilename(filename: string): filename is ResultAttachmentFile {
  return (RESULT_ATTACHMENT_FILES as readonly string[]).includes(filename);
}

/** 规格规格 §5：仅两个固定附件名接管，保存到下载目录同名文件；其他下载不接管。 */
export function attachmentSavePath(filename: string, downloadsDir: string): string | undefined {
  return isResultAttachmentFilename(filename) ? join(downloadsDir, filename) : undefined;
}
```

`electron-shell-generation.ts`（`mount()` 内、`renderer` 确定后；`app` 并入既有 electron import）：

```ts
// 结果附件下载接管（规格 2026-10-21 §5）：只认两个固定名，其余下载保持默认行为。
renderer.session.on('will-download', (_event, item) => {
  const savePath = attachmentSavePath(item.getFilename(), app.getPath('downloads'))
  if (savePath !== undefined) item.setSavePath(savePath)
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: 同 Step 2。Expected: PASS

### Task 6: 清理会话保留 20 条

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts`（`pruneAutomationSessions` `:443-486`）、`routes.ts`（注释 `:678`）、`client-huaanwork/projects.ts`（文档 `:79`）、`client-huaanwork/AutomationsView.tsx`（确认文案 `:551`）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-store.spec.ts`（扩展）

**Interfaces:**
- Produces: `export const AUTOMATION_SESSION_RETAIN_LIMIT = 20`（与 `RUNS_LIMIT` 分列）；`pruneAutomationSessions` 的保留集改读该常量

- [ ] **Step 1: Write the failing test**（沿用该 spec 既有 tmpdir 造目录模式；覆盖规格 §9「保留最近 20 条的会话和进行中会话，第 21 条的目录被删除，运行记录文件不变」）

测试要点：
- 造 21 条带 `sessionId` 的运行记录 + 对应 21 个会话目录（`sessionsRoot/<cwd>/<sessionId>` 布局同 prune 实现）+ 1 个进行中会话（`activeSessionIds`）。
- 断言：21 条里最新 20 条的目录仍在 + 进行中会话仍在；最旧 1 条目录被删；`<id>.runs.jsonl` 仍 21 行不变。

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/automations-store.spec.ts`
Expected: FAIL（当前保留 50 ⇒ 第 21 条目录不会被删）

- [ ] **Step 3: Implement**

`automations-store.ts`：新常量 + `pruneAutomationSessions` 内 `recentRuns(storageRoot, automation.id, RUNS_LIMIT)` 改 `AUTOMATION_SESSION_RETAIN_LIMIT`；注释同步。三处文案/注释改 20（`AutomationsView.tsx:551`「将删除最近 50 条运行之外的会话目录」→ 20；`routes.ts:678`；`projects.ts:79`）。

- [ ] **Step 4: Run test to verify it passes**

Run: 同 Step 2。Expected: PASS

### Task 7: 在途表与 runId 前移

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/automation-inflight.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts`（`dispatchEnqueue` `:576-578`、`runBound` `:507-518`、`executeRun` `:425-443`、`finishAutomation` `:397`）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts`（扩展，沿用 `makeHarness`）

**Interfaces:**
- Produces（`automation-inflight.ts`，无依赖、纯内存）:

```ts
export type InFlightRun = {
  automationId: string
  runId: string
  trigger: 'schedule' | 'catchup' | 'manual'
  phase: 'queued' | 'started'
  cancelRequested: boolean
  slotConsumed: boolean
}
export const inFlightRuns = new Map<string, InFlightRun>()
export function startInFlightRun(entry: InFlightRun): void
export function inFlightRunsOf(automationId: string): InFlightRun[]
```

- [ ] **Step 1: Write the failing test**（规格 §9「调度入队之后、执行体醒来之前，在途表里已有 runId；调用方传入的 runId 不变；跨根放弃入队时表中没有条目」）

测试要点（`makeHarness` 模式）：
1. **入队即在途**：agent 任务 A 用 `state.mode='hang'` 占住串行链，再 `enqueueAutomation` 任务 B（schedule 触发）→ `inFlightRuns` 有 B 的条目、`phase==='queued'`；B 的记录落盘后 runId 与条目一致（"调用方传入的 runId 不变"用手动路径断言：`automation.run` 已传 runId，条目与记录同 id）。
2. **跨根不留条目**：任务绑定项目、当前根在中立根（harness 现有跨根测试的布置）→ 非 manual `enqueueAutomation` → gate 落定后 `inFlightRunsOf(id)` 为空。
3. **phase 翻转与删除**：任务跑完 → 事件含 `run-start` → 落盘后条目已删。
4. **同步段行为**：本任务只落检查代码，行为测试全部在 Task 8 的停止用例闭环——先入队、再停止、再放执行体。**不要**写「预置 `cancelRequested: true` 的条目再入队同一 runId」的用例：`startInFlightRun` 是 `Map.set`，入队会把预置标记覆盖成 `false`，该写法结构性测不了（计划评审第 4 条）。

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/automations-host.spec.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

`automations-host.ts`：

```ts
// dispatchEnqueue：runId 在真正入队的同步段确定并写表（规格 §8；跨根放弃在到达这里之前已 return）。
function dispatchEnqueue(automation: AutomationInfo, meta: AutomationRunMeta): Promise<void> {
  const runId = meta.runId ?? randomUUID()
  startInFlightRun({ automationId: automation.id, runId, trigger: meta.trigger, phase: 'queued', cancelRequested: false, slotConsumed: false })
  const withRunId = { ...meta, runId }
  return automation.kind === 'agent' ? enqueueAgentAutomation(automation, withRunId) : enqueueScriptAutomation(automation, withRunId)
}

// runBound：只使用已确定的 runId，不再生成另一个（规格 §8）。
async function runBound(automation, meta): Promise<void> {
  const { ctx, routeCtx } = requireBound()
  if (meta.runId === undefined) throw new Error('automation run reached the executor without a runId')
  ... // 其余不变，runId 直接用 meta.runId
}
```

`executeRun` 顶部（**同步段不变量，注释钉住**）：

```ts
export async function executeRun(...) {
  // ── 同步段不变量（规格 §8 / 评审注记 2）────────────────────────────
  // 取消检查、阶段翻转与 run-start 发射三者之间不得插入任何 await：stop 的
  // 同步声明依赖事件循环单线程在此段内不可交错。谁在这里加 await 谁就重新
  // 打开「stop 插不进 queued 与 started 之间」的窗口。本段之后的第一个
  // await 只能是下面的 markAutomation（发射之后）——同步段结束标记也钉在
  // 那里，不钉在阶段翻转后（计划评审第 3 条）。
  const entry = inFlightRuns.get(runId)
  if (entry?.cancelRequested) {
    inFlightRuns.delete(runId) // 档位已由停止侧消费（slotConsumed），执行体不再消费
    return
  }
  if (entry) entry.phase = 'started'
  const startedAt = Date.now()
  const sessionId = automation.kind === 'agent' ? automationRunSessionId(automation.id, runId) : undefined
  routeCtx.emit({
    event: 'automation/run-start',
    automationId: automation.id,
    runId,
    projectId: automation.projectId,
    trigger,
    ...(sessionId === undefined ? {} : { sessionId }),
  })
  // ── 同步段结束（以上不得有 await）────────────────────────────────
  await markAutomation(routeCtx.profileDir, automation.id, { lastRunAt: startedAt, lastStatus: 'running' })
  ... // 其余原有逻辑
}
```

`finishAutomation`：`await appendRun(...)` 之后立刻 `inFlightRuns.delete(run.runId)`（记录落盘即摘条目——stop 的「记录已落盘 ⇒ 未停止」由条目消失自然成立）。

- [ ] **Step 4: Run test to verify it passes**

Run: 同 Step 2。Expected: PASS（含既有用例不回归——`executeRun` 对无条目的旧调用路径保持原行为）

### Task 8: automation.stop（排队跳过 + 档位消费 + 已开始取消）

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts`（`runScript` `:329-366`、`executeRun` 结算段 `:459-486`、新 `stopAutomation`）、`automations-store.ts`（新 `consumeSkippedSlot`）、`routes.ts`、`client-huaanwork/rpc-types.ts`、`client-huaanwork/projects.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts`、`tests/huaanwork-host/routes.spec.ts`（扩展）

**Interfaces:**
- Produces: `stopAutomation(automationId): Promise<{ stopped: boolean }>`（automations-host 导出，routes 调用）；`consumeSkippedSlot(storageRoot, automationId, trigger, now)`（store 导出）；RPC `automation.stop` 参数 `{ id }`；客户端 `stopAutomation(id)` 包装

- [ ] **Step 1: Write the failing test**（规格 §9 全部停止相关条目）

测试要点：
1. **已开始 agent 停止**：`state.mode='hang'` 起一轮，`stopAutomation` → 一条 `status:'cancelled'` 记录、注册表 `lastStatus==='error'`、事件一条 `run-end`。
2. **已开始 script 停止**：命令 `sleep 5`（现有 spec 的 script 用法），停止 → `cancelled` 而非 `timeout`，产出为已收集文本。
3. **取消早于 agent 建成**：stop 在 `run-start` 之后、`followup` 之前到达（harness 可用 `noWhenIdle`/时序钩子构造），落盘仍是 `cancelled`。
4. **记录已落盘再停止**：跑完一轮后 `stopAutomation` → `{ stopped: false }`、记录仍一条。
5. **排队跳过 + 档位消费**：A 占链（hang），B（interval schedule）排队；`stopAutomation(B)` → B 无 `run-start`、无记录、`nextRunAt` 恰好推进一次；**再次 stop**（B 仍排队时）不二次推进（`slotConsumed` 所有权）；catchup 触发的排队轮不再推进；manual 触发不改 `nextRunAt`；once 任务排队轮跳过 → `enabled===false` 且无 `nextRunAt`。
6. **同任务 started + queued 并存**：一次 stop 两处都处理。
7. routes.spec：`automation.stop` 路由注册与参数校验。

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/automations-host.spec.ts tests/huaanwork-host/routes.spec.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

`automations-store.ts`（**锁内裸读改写**，Global Constraints 的不可重入条目）：

```ts
/**
 * 被停止跳过的排队轮消费自己的到期档（规格 §8 档位消费规则 1/2；3/4 是 no-op）。
 * 锁不可重入：禁在此调用 updateAutomation/markAutomation/advanceNextRunAt。
 */
export async function consumeSkippedSlot(
  storageRoot: string,
  automationId: string,
  trigger: 'schedule' | 'catchup' | 'manual',
  now: number,
): Promise<void> {
  return withAutomationRegistryLock(async () => {
    const registry = await readAutomationRegistry(storageRoot)
    const automation = registry.automations.find((item) => item.id === automationId)
    if (!automation) return
    if (automation.schedule.kind === 'once') {
      // 规格规格 §8 规则 1 的字面语义：停用任务并去掉 nextRunAt，不再推进别的档。
      // 不镜像 updateAutomation 的重算——「未到期 once 的手动轮被停」边角下重算会写回
      // 未来档，但任务已停用、该值是死数据，按规格字面删（计划评审第 2 条）。
      automation.enabled = false
      delete automation.nextRunAt
    } else if (trigger === 'schedule') {
      const next = nextFireAfter(automation.schedule, now)
      if (next === undefined) delete automation.nextRunAt
      else automation.nextRunAt = next
    }
    await writeAutomationRegistry(storageRoot, registry)
  })
}
```

`automations-host.ts`：

```ts
const scriptRunKillers = new Map<string, () => void>()

// runScript 增加 runId 参数：spawn 后注册 kill 句柄、finish 时摘除（规格 §8「脚本结束对应子进程」）。
async function runScript(command: string, cwd: string, timeoutMs: number, runId?: string) {
  return new Promise((resolve) => {
    const child = spawn(...)
    const finish = (ok, output, timedOut = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (runId !== undefined) scriptRunKillers.delete(runId)
      resolve({ ok, output: clipOutput(output), timedOut })
    }
    if (runId !== undefined) scriptRunKillers.set(runId, () => child.kill())
    ... // 其余不变
  })
}

export async function stopAutomation(automationId: string): Promise<{ stopped: boolean }> {
  const { ctx, routeCtx } = requireBound()
  const entries = inFlightRunsOf(automationId)
  if (entries.length === 0) return { stopped: false }
  const startedEntries: InFlightRun[] = []
  // ── 同步段：所有标记在任何 await 之前落表（规格 §8；评审注记 2）──
  for (const entry of entries) {
    entry.cancelRequested = true
    if (entry.phase === 'queued') {
      if (!entry.slotConsumed) {
        entry.slotConsumed = true // 单次所有权：后到的停止看见已声明就不再消费
        // 档位写入按规格 §8「可以异步」放后台；失败记日志，不混进停止应答。
        // N2-O1 维持「接受窄窗口」（开口项表）：listAutomations 是无锁读
        // （stores.ts:331-332），tick 与本函数的返回时序无关——在此等待
        // 闭不掉复燃窗口，只会把消费失败错误混进停止应答（计划评审第 1 条）。
        void consumeSkippedSlot(routeCtx.profileDir, automationId, entry.trigger, Date.now())
          .catch((error: unknown) => logFailure(error))
      }
    } else {
      startedEntries.push(entry)
    }
  }
  // ── 同步段结束 ──
  if (startedEntries.length > 0) {
    const automation = await findAutomation(routeCtx.profileDir, automationId)
    for (const entry of startedEntries) {
      if (automation?.kind === 'agent') {
        // agent 尚未建成时这里是空操作，标记仍然有效（规格 §8）。
        cancelAutomationSession(ctx, automationRunSessionId(automationId, entry.runId))
      } else {
        scriptRunKillers.get(entry.runId)?.()
      }
    }
  }
  return { stopped: true }
}
```

`executeRun` 结算段（try/catch 之后、`finishAutomation` 之前；`finishAutomation` 的 run 参数 `status` 联合扩 `'cancelled'`）：

```ts
// 停止覆盖（规格 §8）：标记在落盘前即生效——模型回合后来自己跑完也写 cancelled，不写 ok。
if (inFlightRuns.get(runId)?.cancelRequested === true) {
  ok = false
  status = 'cancelled'
  if (!output.trim()) output = '已停止'
}
```

script 分支调用改为 `runScript(automation.command ?? '', routeCtx.workspaceRoot.current, automationTimeout(routeCtx), runId)`。

`routes.ts`（`automation.remove` 附近，storeRoute——不触碰工作区）：

```ts
{
  method: 'automation.stop',
  http: 'POST',
  path: '/huaanwork/automation/stop',
  handler: storeRoute(async (req) => {
    const id = bodyParam(req.body, 'id')
    if (!id) throw new Error('automation.stop requires params.id')
    return await stopAutomation(id)
  }),
}
```

`rpc-types.ts` 方法表加 `"automation.stop"`；`projects.ts` 加 `export function stopAutomation(id: string): Promise<{ stopped: boolean }> { return rpcCall("automation.stop", { id }) }`。

- [ ] **Step 4: Run test to verify it passes**

Run: 同 Step 2。Expected: PASS

### Task 9: automation.deleteRun（删行 + 释放 + 目录 + 锁内回写）

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts`（新 `deleteAutomationRun` / `rewriteLastRunFromRuns` / `removeSessionDir`）、`routes.ts`、`client-huaanwork/rpc-types.ts`、`client-huaanwork/projects.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-store.spec.ts`、`tests/huaanwork-host/routes.spec.ts`（扩展）

**Interfaces:**
- Produces:

```ts
export async function deleteAutomationRun(
  storageRoot: string,
  automationId: string,
  runId: string,
  opts: { sessionsRoot: string; releaseSession?: (sessionId: string) => void },
): Promise<{ removed: boolean; sessionDirRemoved: boolean }>
```

RPC `automation.deleteRun` 参数 `{ id, runId }`；客户端 `deleteAutomationRun(automationId, runId)`。

- [ ] **Step 1: Write the failing test**（规格 §9 删除相关全部条目；**测试不得把运行记录锁套进注册表锁**）

测试要点：
1. 删一条 → jsonl 少该行、对应会话目录消失、`releaseSession` 回调**在目录删除之前**被调（用记录调用顺序的数组断言次序）。
2. 在途表中的 runId → 抛「运行中的记录不能删除」。
3. 删掉最新一条 → `lastRunAt`/`lastStatus` 回退到剩余最新真实运行的 `endedAt`/ok 映射；剩余最新是 `missed` → 跳过它取更早的真实运行；删光真实运行 → 两字段不存在。
4. 注册表锁内读到 `running` → 两字段不动。
5. **锁内重读**：`rewriteLastRunFromRuns` 在删行之后被调用前又有新运行落盘（测试直接：删 R2 行 → `appendRun(R3)` → 调 `rewriteLastRunFromRuns`）→ 回写看到 R3，不用旧快照。
6. 行不存在 → `{ removed: false, sessionDirRemoved: true }`（幂等）；目录不存在 → `sessionDirRemoved: true`；目录删除失败（chmod 只读等手段，或注入 rm 失败）→ `removed: true, sessionDirRemoved: false`。
7. routes.spec：路由注册、参数校验、`releaseSessionRuntime` 接线。

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/automations-store.spec.ts tests/huaanwork-host/routes.spec.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```ts
export async function deleteAutomationRun(
  storageRoot: string,
  automationId: string,
  runId: string,
  opts: { sessionsRoot: string; releaseSession?: (sessionId: string) => void },
): Promise<{ removed: boolean; sessionDirRemoved: boolean }> {
  if (inFlightRuns.has(runId)) throw new Error('运行中的记录不能删除')
  const removed = await withAppendRunLock(storageRoot, automationId, async () => {
    const existing = await recentRuns(storageRoot, automationId)
    const target = existing.find((run) => run.runId === runId)
    if (!target) return undefined
    const lines = existing.filter((run) => run.runId !== runId).map((entry) => JSON.stringify(entry))
    await mkdir(dirname(runsPath(storageRoot, automationId)), { recursive: true })
    await writeFile(runsPath(storageRoot, automationId), lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
    return target
  })
  if (removed === undefined) return { removed: false, sessionDirRemoved: true }
  let sessionDirRemoved = true
  if (removed.sessionId) {
    opts.releaseSession?.(removed.sessionId) // 先释放运行态，再删目录（规格 §6；session.remove 同序）
    sessionDirRemoved = await removeSessionDir(opts.sessionsRoot, removed.sessionId)
  }
  await rewriteLastRunFromRuns(storageRoot, automationId)
  return { removed: true, sessionDirRemoved }
}

/**
 * 注册表锁内重读运行记录重算 lastRunAt/lastStatus（评审 N-P3-1 的闭洞设计，规格 §6）。
 * 锁不可重入：禁调 markAutomation；运行记录用 recentRuns 裸读（不取运行记录锁）。
 */
export async function rewriteLastRunFromRuns(storageRoot: string, automationId: string): Promise<void> {
  return withAutomationRegistryLock(async () => {
    const registry = await readAutomationRegistry(storageRoot)
    const automation = registry.automations.find((item) => item.id === automationId)
    if (!automation || automation.lastStatus === 'running') return
    const real = (await recentRuns(storageRoot, automationId))
      .filter((run) => run.status !== 'missed')
      .sort((a, b) => b.startedAt - a.startedAt)[0]
    if (real) {
      automation.lastRunAt = real.endedAt
      automation.lastStatus = real.ok ? 'ok' : 'error'
    } else {
      delete automation.lastRunAt
      delete automation.lastStatus
    }
    await writeAutomationRegistry(storageRoot, registry)
  })
}

/** prune 同款扫描定位会话目录并删除；找不到视为已删，rm 失败返回 false。 */
async function removeSessionDir(sessionsRoot: string, sessionId: string): Promise<boolean> {
  let cwds: string[]
  try {
    cwds = await readdir(sessionsRoot)
  } catch {
    return true
  }
  for (const cwd of cwds) {
    const cwdDir = join(sessionsRoot, cwd)
    let entries: string[]
    try {
      entries = await readdir(cwdDir)
    } catch {
      continue
    }
    if (!entries.includes(sessionId)) continue
    try {
      await rm(join(cwdDir, sessionId), { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }
  return true
}
```

注意：`deleteAutomationRun` 从 `automation-inflight.ts` import `inFlightRuns`（不 import automations-host，避免环依赖）。`routes.ts` 路由（`automation.remove` 旁）传 `releaseSessionRuntime(ctx.runtimeCtx, ...)` 与 `join(ctx.dshHome, 'sessions')`（同 `automation.remove` `:624` 的接线）。`rpc-types.ts` 加 `"automation.deleteRun"`；`projects.ts` 加包装。

- [ ] **Step 4: Run test to verify it passes**

Run: 同 Step 2。Expected: PASS

### Task 10: 运行记录删除 UI 与运行标签关闭

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/chatTabs.ts`、`App.tsx`、`AutomationsView.tsx`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/chatTabs.spec.ts`（扩展）

**Interfaces:**
- Produces（`chatTabs.ts`，纯逻辑）:

```ts
export function closeRunTabsForSession<T extends { id: string; sessionId?: string; automationId?: string }>(
  tabs: readonly T[],
  sessionId: string,
  activeId: string,
): { tabs: T[]; nextActiveId: string }
```

- [ ] **Step 1: Write the failing test**

```ts
test("deleting a run closes only that session's run tabs and picks the adjacent tab", () => {
  const tabs = [
    { id: "default", label: "默认" },                                   // 无 sessionId：永不关（规格 §6）
    { id: "t1", sessionId: "s-1", automationId: "a" },                  // 命中
    { id: "t2", sessionId: "s-2", automationId: "a" },                  // 保留，被紧挨选中
    { id: "t3", sessionId: "s-1", automationId: "a", other: true },     // 同会话第二张也关
  ];
  const result = closeRunTabsForSession(tabs, "s-1", "t1");
  assert.deepEqual(result.tabs.map((tab) => tab.id), ["default", "t2"]);
  assert.equal(result.nextActiveId, "t2"); // 关的是当前标签 → 紧挨它的一个（先右后左）
});

test("no match is a no-op keeping the active id", () => {
  const tabs = [{ id: "t1", sessionId: "s-2", automationId: "a" }];
  assert.equal(closeRunTabsForSession(tabs, "s-9", "t1").nextActiveId, "t1");
});

test("a non-run tab with the same sessionId is never closed", () => {
  const tabs = [{ id: "user", sessionId: "s-1" }]; // 无 automationId：默认对话标签
  assert.equal(closeRunTabsForSession(tabs, "s-1", "user").tabs.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/chatTabs.spec.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

1. `chatTabs.ts` 实现 `closeRunTabsForSession`（只关 `automationId !== undefined && sessionId === sessionId` 的标签；关的是当前标签时取 `tabs[at + 1] ?? tabs[at - 1]` 中未被关的一个，否则 `kept[0]?.id ?? activeId`）。
2. `App.tsx`：`handleRunDeleted(sessionId)` → `closeRunTabsForSession(chatTabsRef.current, sessionId, activeTab)` → `setChatTabs` + `setActiveTab`；作为 `onRunDeleted` 传给 `AutomationsView`。
3. `AutomationsView.tsx` Props 加 `onRunDeleted?: (sessionId: string) => void`；`RunsPanel` 每行加「删除」按钮 + 确认对话框（文案说明会话目录一并删除，复用 `automation.remove` 的 `settings-overlay`/`confirm-modal` 形态 `:293-313`）+ **在飞守卫**（`deletingRunId` state——M26 P2-3 的连点教训：不能只靠按钮 disabled）；成功后：`sessionDirRemoved === false` 时提示「会话目录未能删除」、刷新 `fullRuns` 与 `onChanged()`、`detail?.sessionId === run.sessionId` 时 `setDetail(null)`、`run.sessionId` 存在时调 `onRunDeleted?.(run.sessionId)`。

- [ ] **Step 4: Run test to verify it passes**

Run: 同 Step 2。Expected: PASS

### Task 11: 停止按钮与「上次 · 已取消」显示

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/AutomationsView.tsx`（`AutomationRow` `:373-375`、`lastRunLabel` `:408-413`）、`App.tsx`（composer `:2602-2609`）

**Interfaces:**
- Consumes: `stopAutomation`（Task 8 包装）

**Behaviors（规格 §8）:**
- 任务行：`running` 时原「立即运行」位置显示「停止」，调 `stopAutomation(id)`，无论返回值都 `onChanged()` 刷新（`stopped:false` 竞态靠刷新收敛）。
- 运行对话：`runTabLive` 时输入区显示停止按钮，调 `stopAutomation(activeChat.automationId)` 后 `refreshAutomations()`；**不走**普通用户回合的 `stopTurn`。composer 的按钮三分支：`turnActive && activeTab === turnTabRef.current` → 既有 stopTurn；`runTabLive` → 新分支；否则发送。
- 「上次」：仍由 `lastRunLabel` 读注册表时刻与 `lastStatus`；仅当该任务已加载的 `runs` 里 `startedAt` 最新一条的 `runStatusOf(...) === "cancelled"` 时状态词显示「已取消」（时刻不变；missed/timeout 不连带——规格 §8 末段）。

- [ ] **Step 1: Implement**（无规格 §9 强制单测；验收 #7 人工核对 + 既有套件回归）

- [ ] **Step 2: Verify**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/`
Expected: PASS（含 appWiring 既有钉）

### Task 12: 收口 gate 与验收走查

- [ ] **Step 1: 样式产物一致**

Run: `corepack yarn workspace dsh-plugin-huaanwork gen:styles && git -C dsh-plugin-huaanwork diff --stat -- src/client-huaanwork/styles.generated.ts`
Expected: 生成器无 diff 残留（有则说明手改了生成物）

- [ ] **Step 2: 全量单测 + 类型检查**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run` → PASS；`corepack yarn typecheck`（根）→ PASS

- [ ] **Step 3: 变体守卫**

Run: `corepack yarn check:desktop-variants`
Expected: PASS（零新增条目；`electron-shell-generation.ts`/`routes.ts` 只在既有声明差异内变更）

- [ ] **Step 4: 完整 headless gate**

Run: `corepack yarn check`
Expected: PASS。已知：`verify:aa` 在三 workspace 并行时偶发红（债表既有项）——若红，先单独重跑该 workspace 确认，再判定是否本计划引入。

- [ ] **Step 5: 验收对照走查（规格 §10）**

| # | 验收 | 覆盖 |
| --- | --- | --- |
| 1 | JSON 折叠、工具行与脚注仍在 | Task 1/3（appWiring 两处调用点钉） |
| 2 | 预览原文/渲染页、下载入下载目录同名覆盖、项目目录无文件 | Task 2/4/5 |
| 3 | 普通句子不折叠 | Task 1（isJsonResultText 负例） |
| 4 | 重启回填仍显示附件 | Task 3（回填接线 + 同一折叠函数） |
| 5 | 删除记录/目录/详情回列表/运行中拒删 | Task 9/10 |
| 6 | 清理保留 20、更早记录仍在 | Task 6 |
| 7 | 停止→已取消、排队轮无记录、档位不复燃 | Task 7/8/11 |

## 执行注意（给实施 agent）

- Task 7 与 Task 8 共享在途表与同步段：Task 7 先落地表与检查（同步段注释钉到 `run-start` 发射之后）、Task 8 落地 stop 语义与档位消费（后台写 + `logFailure`，不 await）；**不要**把两者并成一个任务。
- `findAutomation` 现有定义在 `stores.ts:337`（`automation.run` 路由已用它）；`stopAutomation` 放 automations-host 时从 `./stores.ts` import（automations-host 已有该来源的 import）。
- 既有测试大量直接调 `executeRun`/`enqueueAutomation`：`executeRun` 对无在途条目的调用必须保持原行为（entry 查不到即跳过新逻辑），否则旧套件连片红。
- 规格措辞优先：本计划的代码草图若与规格 v3 冲突，以规格为准并在 PR 里指出本计划对应行。
