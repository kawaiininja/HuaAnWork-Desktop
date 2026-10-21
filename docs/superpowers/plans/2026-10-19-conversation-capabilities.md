# HuaAnWork 会话分流、思考面板与长任务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在华安高级模式对话里展示模型思考，发送不再等到会话空闲，复杂请求经华安分流进入官方计划模式，并用已有工具结果核对产物。

**Architecture:** 纯逻辑放在 `client-huaanwork/logic/` 与 `huaanwork-guardrails/`，界面只消费这些函数。思考数据从现有 `reasoning-delta` 经 bridge 转发。分流工具由华安注册，并同时进入 `present-as` 白名单和 `isRegisteredToolName`。计划模式、提问、待办、结果裁剪、压缩在宿主平面按任务顺序重新启用。官方 `ui-*` 与 `jobs` / 工作流 / Ralph / 官方联网 / `hmr` / 官方模型行保持关闭。目标续轮是最后一项，发送解耦完成前不得启用 `tool-goal`。

**Tech Stack:** TypeScript、Vitest、Cordis 插件、Electron utilityProcess、现有 `dsh-plugin-huaanwork` 测试命令。

## Global Constraints

- 运行时基线是 HuaAnWork 声明的 `0.2.1-rc.1`。不改 `deepseek-harness/`，不改 `dsh-plugin-desktop/src/` 与 `dsh-plugin-desktop-beta/src/`。
- 不新建 Run Coordinator、动作账本、工作区指纹、只读沙箱切换、崩溃后续跑。
- 不启用 `jobs`、`tool-jobs`、`workflow-ptc`、`tool-workflow`、`tool-ralph`、官方 `web`、`web-search-deepseek`、`tool-web`、`hmr`，不恢复官方 `llm-deepseek` 行。
- 不启用官方 `subagent` / `subagent_fork`、`tool-schedule`、官方 `tool-skill`、`present`。
- 不启用任何官方 `ui-*`，包括 `ui-plan`、`ui-goal`、`ui-trajectory`、`ui-user-questions`。
- 不把思考过程复制到会话日志以外的新账本，也不提供单独导出。
- 模型单次请求上限保持 `600_000` 毫秒。不打开 `run_in_background`。
- `propose_plan` 只收必填非空 `objective`。`request_input` 只收必填非空 `question`。多余字段视为无法解析。
- 思考提示用 `ctx.systemPrompt.section` 注册常量正文，order 不得为 `500`。
- 探活是独立短超时 IPC，Host 主事件循环 2 秒内应答。进程仍在、端口仍开、stderr 仍有输出都不算应答。
- 无新结果满 5 分钟才醒目提示。Host 约 15 秒无应答只提示，约 60 秒且有未结束回合才允许结束进程，确认框写明会话数量。
- 目标续轮最多 4 轮，且排在发送解耦之后。
- 提交前跑 `corepack yarn check:desktop-variants`。`main.ts` 与 `host-process.ts` 已在允许差异内，不新增名额。
- 测试命令都在仓库根目录执行，包名是 `dsh-plugin-huaanwork`。

## File structure

| 文件 | 职责 |
| --- | --- |
| `dsh-plugin-huaanwork/src/client-huaanwork/logic/thinkingPanel.ts` | 思考文本合并、`<think>` 抽取、收起规则、中断标记 |
| `dsh-plugin-huaanwork/src/client-huaanwork/ThinkingPanel.tsx` | 对话区内的思考面板 |
| `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts` | 把用户回合的 reasoning 发成事件 |
| `dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts` | 从助手消息里取出 reasoning 块；从 bash/pwsh 调用里取出 command |
| `dsh-plugin-huaanwork/src/huaanwork-guardrails/route-tool-plugin.ts` | 注册并消费两个分流工具 |
| `dsh-plugin-huaanwork/src/huaanwork-host/child-sessions.ts` | 父会话到子会话的登记，供取消使用 |
| `dsh-plugin-huaanwork/src/huaanwork-guardrails/thinking-prompt.ts` | 常量中文思考提示 |
| `dsh-plugin-huaanwork/src/client-huaanwork/logic/turnStatus.ts` | 「正在思考 / 正在执行工具 / 已 N 秒没有新结果」 |
| `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts` | 受理后返回；取消只打当前会话 |
| `dsh-plugin-huaanwork/src/host-liveness.ts` | 探活状态机，不含 Electron |
| `dsh-plugin-huaanwork/src/huaanwork-guardrails/route-tools.ts` | `propose_plan` / `request_input` 的解析与优先级 |
| `dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts` | `isRegisteredToolName` 放行 |
| `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts` | 白名单 |
| `dsh-plugin-huaanwork/src/client-huaanwork/logic/planConfirm.ts` | 护栏档位决定确认还是自动继续 |
| `dsh-plugin-huaanwork/src/client-huaanwork/logic/outcomeCheck.ts` | 只读已有工具结果与文件是否存在 |
| `dsh-plugin-huaanwork/src/profile.ts` | 按任务启用宿主行 |
| `dsh-plugin-huaanwork/src/huaanwork-host/row-assertions.ts` | 启用后从「必须关闭」清单移除对应行 |

---

### Task 1: 思考面板的纯逻辑

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/thinkingPanel.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/thinkingPanel.spec.ts`

**Interfaces:**
- Consumes: 无
- Produces: `extractThinkBlocks(text: string): { visible: string; thought: string }`、`resolveThinking(input: { reasoning: string; assistantText: string }): { thought: string; visible: string }`、`thinkingChrome(input: { thought: string; hasAssistantText: boolean; userToggled: "expand" | "collapse" | null; interrupted: boolean }): { title: string; expanded: boolean }`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "vitest";
import { extractThinkBlocks, resolveThinking, thinkingChrome } from "../../src/client-huaanwork/logic/thinkingPanel.ts";

test("reasoning wins and think tags stay out of the answer", () => {
  const resolved = resolveThinking({
    reasoning: "先看文件",
    assistantText: "正文<think>不要出现</think>",
  });
  assert.equal(resolved.thought, "先看文件");
  assert.equal(resolved.visible, "正文");
});

test("think tags fill the panel only when reasoning is empty", () => {
  const resolved = resolveThinking({
    reasoning: "   ",
    assistantText: "答案<think>内部</think>结尾",
  });
  assert.equal(resolved.thought, "内部");
  assert.equal(resolved.visible, "答案结尾");
  assert.equal(extractThinkBlocks("<think>内部</think>").thought, "内部");
});

test("an unclosed think tag stays out of the answer bubble", () => {
  const resolved = resolveThinking({
    reasoning: "",
    assistantText: "答案<think>还没完",
  });
  assert.equal(resolved.visible, "答案");
  assert.equal(resolved.thought, "还没完");
  assert.equal(extractThinkBlocks("答案<thi").visible, "答案");
});

test("panel collapses when answer text arrives unless the user toggled it", () => {
  assert.deepEqual(
    thinkingChrome({ thought: "先看文件", hasAssistantText: true, userToggled: null, interrupted: false }),
    { title: "思考 · 已生成", expanded: false },
  );
  assert.equal(
    thinkingChrome({ thought: "先看文件", hasAssistantText: true, userToggled: "expand", interrupted: false }).expanded,
    true,
  );
  assert.equal(
    thinkingChrome({ thought: "先看文件", hasAssistantText: false, userToggled: null, interrupted: true }).title,
    "思考 · 已中断",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/thinkingPanel.spec.ts`
Expected: FAIL，找不到 `thinkingPanel.ts`

- [ ] **Step 3: Write minimal implementation**

```ts
const CLOSED_THINK = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
const OPEN_THINK = /<think(?:ing)?>[\s\S]*$/i;
const THINK_TAGS = ["<think>", "<thinking>", "</think>", "</thinking>"];

function holdIncompleteThinkTag(text: string): string {
  const lt = text.lastIndexOf("<");
  if (lt < 0) return text;
  const suffix = text.slice(lt);
  if (suffix.includes(">")) return text;
  const lower = suffix.toLowerCase();
  return THINK_TAGS.some((tag) => tag.startsWith(lower)) ? text.slice(0, lt) : text;
}

export function extractThinkBlocks(text: string): { visible: string; thought: string } {
  const head = holdIncompleteThinkTag(text);
  const parts: string[] = [];
  const withoutClosed = head.replace(CLOSED_THINK, (block) => {
    parts.push(block.replace(/<\/?think(?:ing)?>/gi, "").trim());
    return "";
  });
  const open = OPEN_THINK.exec(withoutClosed);
  const visible = open ? withoutClosed.slice(0, open.index) : withoutClosed;
  if (open) parts.push(open[0].replace(/<think(?:ing)?>/i, "").trim());
  return { visible, thought: parts.filter((part) => part.length > 0).join("\n") };
}

export function resolveThinking(input: { reasoning: string; assistantText: string }): { thought: string; visible: string } {
  const extracted = extractThinkBlocks(input.assistantText);
  const reasoning = input.reasoning.trim();
  if (reasoning.length > 0) return { thought: reasoning, visible: extracted.visible };
  return extracted;
}

export function thinkingChrome(input: {
  thought: string;
  hasAssistantText: boolean;
  userToggled: "expand" | "collapse" | null;
  interrupted: boolean;
}): { title: string; expanded: boolean } {
  const title = input.interrupted
    ? "思考 · 已中断"
    : input.hasAssistantText
      ? "思考 · 已生成"
      : "思考";
  if (input.userToggled === "expand") return { title, expanded: true };
  if (input.userToggled === "collapse") return { title, expanded: false };
  return { title, expanded: !input.hasAssistantText };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/thinkingPanel.spec.ts`
Expected: PASS，3 tests

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/thinkingPanel.ts dsh-plugin-huaanwork/tests/client-huaanwork/thinkingPanel.spec.ts
git commit -m "feat(huaanwork): fold reasoning and think tags into one panel model"
```

### Task 2: 对话区渲染思考面板

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/ThinkingPanel.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx` 的 `ChatItem` 与 `ChatRow`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/thinkingPanel.spec.ts`（Task 1 已覆盖规则；本任务补一条「没有思考就不渲染」的纯函数）

**Interfaces:**
- Consumes: `resolveThinking`、`thinkingChrome`
- Produces: `ThinkingPanel` 组件，props 为 `{ thought: string; hasAssistantText: boolean; interrupted: boolean }`

- [ ] **Step 1: Write the failing test**

在 `thinkingPanel.spec.ts` 追加：

```ts
import { shouldRenderThinking } from "../../src/client-huaanwork/logic/thinkingPanel.ts";

test("blank thought does not render a panel", () => {
  assert.equal(shouldRenderThinking("  "), false);
  assert.equal(shouldRenderThinking("先看文件"), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/thinkingPanel.spec.ts`
Expected: FAIL，`shouldRenderThinking` 未导出

- [ ] **Step 3: Write minimal implementation**

在 `thinkingPanel.ts` 末尾：

```ts
export function shouldRenderThinking(thought: string): boolean {
  return thought.trim().length > 0;
}
```

新建 `ThinkingPanel.tsx`：

```tsx
import { useState } from "react";
import { thinkingChrome } from "./logic/thinkingPanel.ts";

export function ThinkingPanel({
  thought,
  hasAssistantText,
  interrupted,
}: {
  thought: string;
  hasAssistantText: boolean;
  interrupted: boolean;
}) {
  const [userToggled, setUserToggled] = useState<"expand" | "collapse" | null>(null);
  const chrome = thinkingChrome({ thought, hasAssistantText, userToggled, interrupted });
  return (
    <section className="thinking-panel">
      <button
        type="button"
        aria-expanded={chrome.expanded}
        onClick={() => setUserToggled(chrome.expanded ? "collapse" : "expand")}
      >
        {chrome.expanded && !hasAssistantText && !interrupted ? `${chrome.title} · 进行中` : chrome.title}
      </button>
      {chrome.expanded ? (
        <pre className="thinking-body">{thought}</pre>
      ) : null}
    </section>
  );
}
```

在 `App.tsx` 的 `ChatItem` 增加 `{ id: number; kind: "thinking"; thought: string; interrupted: boolean }`。`ChatRow` 在助手气泡之前渲染 `ThinkingPanel`。助手气泡继续使用 `resolveThinking(...).visible`，不要把 reasoning 拼进气泡。给 `.thinking-body` 设 `max-height: 40vh; overflow: auto; white-space: pre-wrap`，颜色用现有次要文字色。面板内用 `<pre>` 纯文本，不把思考交给 Markdown 渲染器。

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/thinkingPanel.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/ThinkingPanel.tsx dsh-plugin-huaanwork/src/client-huaanwork/logic/thinkingPanel.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/tests/client-huaanwork/thinkingPanel.spec.ts
git commit -m "feat(huaanwork): show a collapsible thinking panel above the answer"
```

### Task 3: bridge 转发 reasoning，历史能恢复

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts` 的 `mapTokens`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts` 的 `detailRecords`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/bridge.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/session-view.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/sessionChannel.spec.ts`

**Interfaces:**
- Consumes: `StreamChunk` 里已有的 `reasoning-delta` 与 `block-end`
- Produces: 事件 `{ event: "reasoning"; text: string; sessionId?: string; final?: true }`。历史条目 `{ kind: "thinking"; text: string }`

- [ ] **Step 1: Write the failing test**

在 `bridge.spec.ts` 追加。`StreamChunk` 联合类型补上 `{ type: "reasoning-delta"; index: number; text: string }` 与 `{ type: "block-end"; index: number; block: { type: "reasoning"; text: string } }`。

```ts
test("bridge forwards user-turn reasoning and skips purposed calls", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { ctx, listeners, emitted } = createCtx();
  apply(ctx as never);
  const wrap = listeners["llm/stream"]?.[0] as (
    options: { sessionId?: string; purpose?: string },
    next: () => AsyncIterable<StreamChunk>,
  ) => AsyncIterable<StreamChunk>;
  async function* userTurn() {
    yield { type: "reasoning-delta" as const, index: 0, text: "先" };
    yield { type: "reasoning-delta" as const, index: 0, text: "看" };
    yield { type: "block-end" as const, index: 0, block: { type: "reasoning" as const, text: "先看" } };
  }
  for await (const _chunk of wrap({ sessionId: "huaanwork-0123456789abcdef" }, userTurn)) {
    // drain
  }
  async function* titled() {
    yield { type: "reasoning-delta" as const, index: 0, text: "标题思考" };
    yield { type: "text-delta" as const, index: 1, text: "标题" };
  }
  for await (const _chunk of wrap({ purpose: "session-title" }, titled)) {
    // drain
  }
  assert.deepEqual(
    emitted.filter((event) => (event as { event?: string }).event === "reasoning"),
    [
      { event: "reasoning", text: "先", sessionId: "huaanwork-0123456789abcdef" },
      { event: "reasoning", text: "看", sessionId: "huaanwork-0123456789abcdef" },
      { event: "reasoning", text: "先看", sessionId: "huaanwork-0123456789abcdef", final: true },
    ],
  );
  assert.deepEqual(
    emitted.filter((event) => (event as { event?: string }).event === "token"),
    [],
  );
});
```

在 `sessionChannel.spec.ts` 追加：

```ts
test("history restores a collapsed thinking record", () => {
  const items = historyItemsFromRecords([
    { kind: "user", time: 1, text: "问" },
    { kind: "thinking", time: 2, text: "先看文件" },
    { kind: "assistant", time: 3, text: "好的" },
  ]);
  assert.deepEqual(items[1], { kind: "thinking", text: "先看文件" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/bridge.spec.ts tests/client-huaanwork/sessionChannel.spec.ts`
Expected: FAIL。reasoning 事件为空；`HistoryRecord` 不接受 `thinking`

- [ ] **Step 3: Write minimal implementation**

`mapTokens` 在现有 `text-delta` 分支旁增加：

```ts
if (purpose === undefined && chunk?.type === "reasoning-delta" && typeof chunk.text === "string" && chunk.text.length > 0) {
  emit(ctx, { event: "reasoning", text: chunk.text, ...(sessionId === undefined ? {} : { sessionId }) });
}
if (
  purpose === undefined
  && chunk?.type === "block-end"
  && chunk.block?.type === "reasoning"
  && typeof chunk.block.text === "string"
) {
  emit(ctx, {
    event: "reasoning",
    text: chunk.block.text,
    final: true,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
}
```

`purpose !== undefined` 的压缩与标题调用保持不发 `token` 和 `reasoning`。

实时面板仍只消费 bridge 的 `reasoning` 事件。重开不靠 bridge 写日志：bridge 只有 `huaanworkEmit`，没有会话日志写入接口。

主路是扩展 `session-view.ts` 的 `detailRecords`。`assistant/message` 现在只收集 `type === "text"` 的块，`type === "reasoning"` 的块被丢掉。处理该事件时，把 reasoning 块按原顺序收成一条 `{ kind: "thinking", time, text }`，文本块仍是 `{ kind: "assistant" }`。没有 reasoning 块就不造思考记录。

`HistoryRecord` 与 `HistoryChatItem` 增加这两种 thinking 形状。`historyItemsFromRecords` 遇到 `thinking` 就原样推入。历史面板默认收起。补一条 `session-view` 测试：同一条 `assistant/message` 里先有 reasoning 块、后有 text 块，`detailRecords` 先给出 thinking，再给出 assistant。

`App.tsx` 收到非 final 的 `reasoning` 就追加到当前回合思考草稿；收到 `final: true` 就用全文覆盖同一块，不追加第二块。

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/bridge.spec.ts tests/client-huaanwork/sessionChannel.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/tests/huaanwork-guardrails/bridge.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/session-view.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/sessionChannel.spec.ts
git commit -m "feat(huaanwork): forward user-turn reasoning into the session transcript"
```

### Task 4: 注册不变的中文思考提示

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-guardrails/thinking-prompt.ts`
- Modify: `dsh-plugin-huaanwork/src/profile.ts` 的 huaanwork insert 列表，放在 `huaanwork-model` 之后
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/thinking-prompt.spec.ts`

**Interfaces:**
- Consumes: `ctx.systemPrompt.section({ name, order, text })`
- Produces: `THINKING_PROMPT_NAME = "huaanwork:thinking-language"`、`THINKING_PROMPT_ORDER = 40`、`THINKING_PROMPT_TEXT`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "vitest";
import { apply, THINKING_PROMPT_NAME, THINKING_PROMPT_ORDER, THINKING_PROMPT_TEXT } from "../../src/huaanwork-guardrails/thinking-prompt.ts";

test("thinking prompt is a constant section and does not use plan-policy order", () => {
  const registered: { name: string; order: number; text: string }[] = [];
  apply({
    systemPrompt: {
      section(entry: { name: string; order: number; text: string }) {
        registered.push(entry);
      },
    },
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0]?.name, THINKING_PROMPT_NAME);
  assert.equal(registered[0]?.order, 40);
  assert.notEqual(THINKING_PROMPT_ORDER, 500);
  assert.equal(registered[0]?.text, THINKING_PROMPT_TEXT);
  assert.match(THINKING_PROMPT_TEXT, /简体中文/);
  assert.match(THINKING_PROMPT_TEXT, /回答语言跟随用户/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/thinking-prompt.spec.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: Write minimal implementation**

```ts
export const THINKING_PROMPT_NAME = "huaanwork:thinking-language";
export const THINKING_PROMPT_ORDER = 40;
export const THINKING_PROMPT_TEXT = "思考过程使用简体中文。回答语言跟随用户。";

export function apply(ctx: {
  systemPrompt: { section(entry: { name: string; order: number; text: string }): void };
}): void {
  ctx.systemPrompt.section({
    name: THINKING_PROMPT_NAME,
    order: THINKING_PROMPT_ORDER,
    text: THINKING_PROMPT_TEXT,
  });
}
```

在 `profile.ts` 的 insert 数组里，`huaanwork-model` 下一项加入 `{ id: "huaanwork-thinking-prompt", name: "dsh-plugin-huaanwork/huaanwork-guardrails/thinking-prompt" }`。不要把这段提示写进每条用户消息。

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/thinking-prompt.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/thinking-prompt.ts dsh-plugin-huaanwork/src/profile.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/thinking-prompt.spec.ts
git commit -m "feat(huaanwork): ask the model to think in simplified Chinese"
```

### Task 5: 发送受理后返回

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts` 的 `sendToAgent`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts`（沿用该文件已有的 agent mock 风格；若没有「等到 idle」的用例，就新增下面这一条）

**Interfaces:**
- Consumes: `agent.followup`、`agent.whenIdle`
- Produces: `sendToAgent` 在 `followup` 之后立即 resolve `{ queued: true, sessionId }`，即使 `whenIdle` 从未 resolve

- [ ] **Step 1: Write the failing test**

```ts
test("sendToAgent returns after followup and detaches @ tools only after idle", async () => {
  let releaseIdle: () => void = () => {};
  const idle = new Promise<void>((resolve) => {
    releaseIdle = resolve;
  });
  let detached = false;
  const agent = {
    followup() {},
    whenIdle() {
      return idle;
    },
  };
  const pending = sendToAgent(
    ctxWith(agent, {
      afterIdle: async () => {
        detached = true;
      },
    }),
    routeCtx,
    { text: "@tool 查询", sessionId: "huaanwork-0123456789abcdef" },
  );
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), 50)),
  ]);
  assert.deepEqual(result, { queued: true, sessionId: "huaanwork-0123456789abcdef" });
  assert.equal(detached, false);
  releaseIdle();
  await idle.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(detached, true);
});
```

按 `sessions.spec.ts` 现有 helper 构造 ctx。`@tool` 要走真实的 `dispatchAt` HTTP 工具分支，或把 `afterIdle` 桩成把 `detached` 设为 true 的函数。断言两段都要有：50 毫秒内返回，以及 idle resolve 之前 `detached` 仍为 false。只测纯文本、不挂 `afterIdle` 的用例不够，它会在 `@` 提前解绑时仍然通过。

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/sessions.spec.ts -t "without waiting for idle"`
Expected: FAIL，结果是 `timed-out`

- [ ] **Step 3: Write minimal implementation**

删除 `await agent.whenIdle?.()` 和它后面的 `await cleanup()`。`followup` 成功后改为不等待的登记：

```ts
void agent.whenIdle?.().then(() => cleanup())
return { queued: true, sessionId }
```

`cleanup` 里的 `afterIdle` 就是 `@` HTTP 工具的 `detachHostTool`。提前调用会让回合中的 `call_host_tool` 变成未挂载并被 policy 拒绝。`finally` 里现有的 `await cleanup()` 也要改成同一套「只在 idle 之后跑一次」的登记，避免成功路径和异常路径各解绑一次。HTTP 连接断开不调用 `cancel`。

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/sessions.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts
git commit -m "fix(huaanwork): accept a chat send without waiting for the agent to go idle"
```

### Task 6: 回合状态文案

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/turnStatus.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`，在对话区回合未结束时显示返回的句子
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/turnStatus.spec.ts`

**Interfaces:**
- Consumes: 无
- Produces: `turnStatus(input: { latest: "reasoning" | "text" | "tool" | "quiet"; runningTool: string | null; quietMs: number }): { text: string; alert: boolean }`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "vitest";
import { turnStatus } from "../../src/client-huaanwork/logic/turnStatus.ts";

test("turn status names thinking only while reasoning is current", () => {
  assert.deepEqual(turnStatus({ latest: "reasoning", runningTool: null, quietMs: 0 }), {
    text: "正在思考",
    alert: false,
  });
  assert.deepEqual(turnStatus({ latest: "reasoning", runningTool: "bash", quietMs: 0 }), {
    text: "正在执行工具 bash",
    alert: false,
  });
  assert.equal(
    turnStatus({ latest: "reasoning", runningTool: null, quietMs: 1_500 }).text,
    "正在思考",
  );
  assert.equal(
    turnStatus({ latest: "reasoning", runningTool: null, quietMs: 2_000 }).text,
    "已 2 秒没有新结果",
  );
  assert.equal(turnStatus({ latest: "quiet", runningTool: null, quietMs: 300_000 }).alert, true);
  assert.equal(turnStatus({ latest: "text", runningTool: null, quietMs: 299_000 }).alert, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/turnStatus.spec.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: Write minimal implementation**

```ts
const ALERT_MS = 5 * 60 * 1000;

const THINKING_GRACE_MS = 2_000;

export function turnStatus(input: {
  latest: "reasoning" | "text" | "tool" | "quiet";
  runningTool: string | null;
  quietMs: number;
}): { text: string; alert: boolean } {
  if (input.runningTool) return { text: `正在执行工具 ${input.runningTool}`, alert: false };
  if (input.latest === "reasoning" && input.quietMs < THINKING_GRACE_MS) {
    return { text: "正在思考", alert: false };
  }
  const seconds = Math.max(1, Math.floor(input.quietMs / 1000));
  return { text: `已 ${seconds} 秒没有新结果`, alert: input.quietMs >= ALERT_MS };
}
```

`quietMs` 是距离上一次 reasoning 增量、正文增量或工具结果的时间。2 秒内的增量间隙仍显示「正在思考」，避免每个 token 间隔都闪成「已 1 秒」。超过 2 秒改成「已 N 秒没有新结果」，不要因为本回合曾经出现过 reasoning 就一直显示「正在思考」。满 5 分钟只把 `alert` 设为 true。状态条不显示百分比。

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/turnStatus.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/turnStatus.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/tests/client-huaanwork/turnStatus.spec.ts
git commit -m "feat(huaanwork): show whether a turn is thinking, running a tool, or quiet"
```

### Task 7: 取消只打当前会话

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts` 的 `cancelAgent`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts`

**Interfaces:**
- Consumes: `findSessionAgent`、本任务新建的 `registerChildSession` / `childrenOf`
- Produces: `cancelAgent` 只取消目标会话和已登记的子会话。`ListedAgent` 不增加没有来源的 `parentSessionId`

- [ ] **Step 1: Write the failing test**

```ts
test("cancelAgent does not cancel a sibling session", () => {
  const reasons: string[] = [];
  const target = { session: { id: "huaanwork-aaaaaaaaaaaaaaaa" }, cancel(reason: { kind: string }) { reasons.push(`target:${reason.kind}`); } };
  const child = { session: { id: "child" }, cancel(reason: { kind: string }) { reasons.push(`child:${reason.kind}`); } };
  const sibling = { session: { id: "huaanwork-bbbbbbbbbbbbbbbb" }, cancel() { reasons.push("sibling"); } };
  registerChildSession("huaanwork-aaaaaaaaaaaaaaaa", "child");
  cancelAgent(ctxListing([target, child, sibling]), routeCtx, { sessionId: "huaanwork-aaaaaaaaaaaaaaaa" });
  assert.deepEqual(reasons.sort(), ["child:parent", "target:user"]);
});
```
```

若 `cancelAgent` 未导出，测试改为走现有 `session.cancel` 路由包装，断言相同。

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/sessions.spec.ts -t "sibling session"`
Expected: FAIL，`reasons` 含 `sibling`

- [ ] **Step 3: Write minimal implementation**

新建 `dsh-plugin-huaanwork/src/huaanwork-host/child-sessions.ts`：

```ts
const children = new Map<string, Set<string>>();

export function registerChildSession(parentSessionId: string, childSessionId: string): void {
  const set = children.get(parentSessionId) ?? new Set<string>();
  set.add(childSessionId);
  children.set(parentSessionId, set);
}

export function childrenOf(parentSessionId: string): readonly string[] {
  return [...(children.get(parentSessionId) ?? [])];
}
```

在现有 `subagent/start` 监听里调用 `registerChildSession`。父会话 id 取这次 `subagents.start` 的 parent 参数；事件本身没有 parent 时，用发起调用的当前用户会话 id。没有登记的 agent 不取消。

`cancelAgent` 改为：

```ts
const childIds = new Set(childrenOf(sessionId))
for (const agent of ctx.agents?.list?.() ?? []) {
  if (agent === primary) continue
  const id = agent.session?.id ?? agent.id
  if (id === undefined || !childIds.has(id)) continue
  agent.cancel?.({ kind: 'parent' })
}
primary?.cancel?.({ kind: 'user' })
```

不要给 `ListedAgent` 加 `parentSessionId`。取消不删除已写文件，不调用回滚。

界面在 `session/end` 且本回合已有思考时，把该面板标成 `interrupted: true`，标题走 `thinkingChrome` 的「思考 · 已中断」。

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/sessions.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts dsh-plugin-huaanwork/src/huaanwork-host/child-sessions.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts
git commit -m "fix(huaanwork): cancel only the requested session and its children"
```

### Task 8: Host 探活状态机

**Files:**
- Create: `dsh-plugin-huaanwork/src/host-liveness.ts`
- Modify: `dsh-plugin-huaanwork/src/host-process.ts`，在独立 Host 上每 2 秒发一次探活；应答必须由 Host 主事件循环里的 `rpc.handle` 完成
- Test: `dsh-plugin-huaanwork/tests/host-liveness.spec.ts`

**Interfaces:**
- Consumes: 无
- Produces: `reduceLiveness(state: Liveness, event: { kind: "probe-ok" | "probe-miss" | "turn-count"; atMs: number; turns?: number }): Liveness`，其中 `Liveness = { phase: "ok" | "suspect" | "stoppable"; turns: number; lastOkMs: number }`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "vitest";
import { reduceLiveness, type Liveness } from "../src/host-liveness.ts";

const start: Liveness = { phase: "ok", turns: 1, lastOkMs: 0 };

test("fifteen seconds without an answer is suspect, sixty with a live turn is stoppable", () => {
  const suspect = reduceLiveness(start, { kind: "probe-miss", atMs: 15_000 });
  assert.equal(suspect.phase, "suspect");
  const idle = reduceLiveness({ ...suspect, turns: 0 }, { kind: "probe-miss", atMs: 60_000 });
  assert.equal(idle.phase, "suspect");
  const stoppable = reduceLiveness(suspect, { kind: "probe-miss", atMs: 60_000 });
  assert.equal(stoppable.phase, "stoppable");
  assert.equal(reduceLiveness(stoppable, { kind: "probe-ok", atMs: 61_000 }).phase, "ok");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/host-liveness.spec.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: Write minimal implementation**

```ts
export type Liveness = { phase: "ok" | "suspect" | "stoppable"; turns: number; lastOkMs: number };

export function reduceLiveness(
  state: Liveness,
  event: { kind: "probe-ok" | "probe-miss" | "turn-count"; atMs: number; turns?: number },
): Liveness {
  if (event.kind === "turn-count") return { ...state, turns: event.turns ?? 0 };
  if (event.kind === "probe-ok") return { phase: "ok", turns: state.turns, lastOkMs: event.atMs };
  const silent = event.atMs - state.lastOkMs;
  if (silent >= 60_000 && state.turns > 0) return { ...state, phase: "stoppable" };
  if (silent >= 15_000) return { ...state, phase: "suspect" };
  return state;
}
```

`host-process.ts` 用一条新的 `rpc.handle("liveness", ...)`，Host 入口在主事件循环里立即返回 `{ ok: true }`。主进程每 2 秒调用它，超时就是 2 秒，超时走 `probe-miss`。不要用 `child.pid` 仍存在、端口可连或 stderr 有输出来调用 `probe-ok`。`phase === "suspect"` 时界面向所有标签显示「执行进程无响应」，并拒绝新的 `session.send`。`phase === "stoppable"` 时确认框文本为 `将终止 ${turns} 个未结束会话`。确认后 `child.kill()`。不要在同进程模式注册这条探活，也不要写「已有进程外监督」。

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/host-liveness.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/host-liveness.ts dsh-plugin-huaanwork/src/host-process.ts dsh-plugin-huaanwork/tests/host-liveness.spec.ts
git commit -m "feat(huaanwork): suspect a host that stops answering a two-second probe"
```

### Task 9: 分流工具过两道名字门

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts` 的 `isRegisteredToolName`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts` 的 `ALLOWED_TOOLS`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/model.spec.ts`（已有文件则追加；没有就新建）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/present-as.cordis.spec.ts` 追加断言

**Interfaces:**
- Consumes: `parseSseToolCalls(payloads, isRegisteredToolName)`
- Produces: 名字 `propose_plan` 与 `request_input` 在两处都被接受

- [ ] **Step 1: Write the failing test**

在 model 测试里构造一条只含 `propose_plan` 的 SSE tool call，断言 `parseSseToolCalls` 使用 `isRegisteredToolName` 后长度为 1。对 `request_input` 再断言一次。未放行时现有实现会得到长度 0。

```ts
test("route tool names survive the static tool filter", () => {
  const payloads = [
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "propose_plan", arguments: "{\"objective\":\"汇总三份材料\"}" } }] } }],
    }),
  ];
  assert.equal(parseSseToolCalls(payloads, isRegisteredToolName).length, 1);
});
```

若 `isRegisteredToolName` 未导出，改为导出它再测。present-as 测试断言 `ALLOWED_TOOLS` 含这两个字符串。

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/model.spec.ts tests/huaanwork-guardrails/present-as.cordis.spec.ts`
Expected: FAIL，解析结果长度为 0

- [ ] **Step 3: Write minimal implementation**

```ts
function isRegisteredToolName(name: string): boolean {
  return KNOWN_TOOL_NAMES.has(name)
    || name === "call_host_tool"
    || name === "web_fetch"
    || name === "screenshot"
    || name === "propose_plan"
    || name === "request_input"
    || name.startsWith("mcp__");
}
```

`ALLOWED_TOOLS` 增加 `"propose_plan"` 与 `"request_input"`。本任务不要加入 `exit_plan_mode`、`get_goal`、`create_goal`、`update_goal` 或 `ask_user_question`。前四个随启用它们的任务再加，`ask_user_question` 保持不加入。

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/model.spec.ts tests/huaanwork-guardrails/present-as.cordis.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/model.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/present-as.cordis.spec.ts
git commit -m "feat(huaanwork): let the model name the two route tools"
```

### Task 10: 分流判定

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-guardrails/route-tools.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/route-tools.spec.ts`

**Interfaces:**
- Consumes: 无
- Produces: `classifyToolCalls(calls: readonly { name: string; args: unknown }[]): RouteDecision`

```ts
export type RouteDecision =
  | { kind: "answer" }
  | { kind: "direct"; call: { name: string; args: unknown } }
  | { kind: "planned"; objective: string }
  | { kind: "clarify"; question: string }
  | { kind: "invalid" };
```

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "vitest";
import { classifyToolCalls } from "../../src/huaanwork-guardrails/route-tools.ts";

test("control tools win and only the declared fields parse", () => {
  assert.deepEqual(classifyToolCalls([]), { kind: "answer" });
  assert.deepEqual(classifyToolCalls([{ name: "read", args: { file_path: "a.md" } }]), {
    kind: "direct",
    call: { name: "read", args: { file_path: "a.md" } },
  });
  assert.deepEqual(
    classifyToolCalls([
      { name: "read", args: {} },
      { name: "propose_plan", args: { objective: "汇总三份材料" } },
    ]),
    { kind: "planned", objective: "汇总三份材料" },
  );
  assert.deepEqual(classifyToolCalls([{ name: "request_input", args: { question: "目标目录是哪一个？" } }]), {
    kind: "clarify",
    question: "目标目录是哪一个？",
  });
  assert.deepEqual(classifyToolCalls([{ name: "propose_plan", args: { objective: "汇总", steps: [] } }]), {
    kind: "invalid",
  });
  assert.deepEqual(classifyToolCalls([{ name: "request_input", args: { question: "  " } }]), { kind: "invalid" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/route-tools.spec.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: Write minimal implementation**

```ts
export type RouteDecision =
  | { kind: "answer" }
  | { kind: "direct"; call: { name: string; args: unknown } }
  | { kind: "planned"; objective: string }
  | { kind: "clarify"; question: string }
  | { kind: "invalid" };

function exactString(args: unknown, key: "objective" | "question"): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  if (Object.keys(record).some((name) => name !== key)) return undefined;
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.trim();
}

export function classifyToolCalls(calls: readonly { name: string; args: unknown }[]): RouteDecision {
  const control = calls.find((call) => call.name === "propose_plan" || call.name === "request_input");
  if (control?.name === "propose_plan") {
    const objective = exactString(control.args, "objective");
    return objective === undefined ? { kind: "invalid" } : { kind: "planned", objective };
  }
  if (control?.name === "request_input") {
    const question = exactString(control.args, "question");
    return question === undefined ? { kind: "invalid" } : { kind: "clarify", question };
  }
  const first = calls[0];
  if (!first) return { kind: "answer" };
  return { kind: "direct", call: first };
}
```

执行侧不要写在本任务里。工具注册、`classifyToolCalls` 的调用、invalid 重修、clarify 挂起都属于 Task 10b。本任务只交付纯函数。`@` 与 `/skill` 继续在 `sendToAgent` 里先于模型处理。

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/route-tools.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/route-tools.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/route-tools.spec.ts
git commit -m "feat(huaanwork): classify a turn without a second model call"
```

### Task 10b: 把分流工具接进运行时

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-guardrails/route-tool-plugin.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts` 的 `finishModelStream`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/route-tools.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts`，在 `followup` 之前写入 `huaanworkRouteAgent.current`
- Modify: `dsh-plugin-huaanwork/src/profile.ts` 的 insert 列表
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/route-tool-plugin.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/model.spec.ts`

**Interfaces:**
- Consumes: `classifyToolCalls`、`defineTool`、`ctx.planMode.set(agent, active)`
- Produces: `preferControlCalls(calls)`。SSE 和文本协议两条 `emitToolCalls` 之前都先过它。`propose_plan` 的 `execute` 调用 `planMode.set`。`request_input` 的 `execute` 自己等待答案。官方 `user-questions/request` 不参与这条等待

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "vitest";
import { preferControlCalls } from "../../src/huaanwork-guardrails/route-tools.ts";
import { apply, noteInvalidRoute } from "../../src/huaanwork-guardrails/route-tool-plugin.ts";

test("a control call drops sibling ordinary calls before they are emitted", () => {
  assert.deepEqual(
    preferControlCalls([
      { name: "read", args: { file_path: "a.md" } },
      { name: "propose_plan", args: { objective: "汇总三份材料" } },
    ]).map((call) => call.name),
    ["propose_plan"],
  );
});

test("propose_plan execute enters plan mode for the current agent", async () => {
  const agent = { id: "huaanwork-0123456789abcdef" };
  const seen: unknown[] = [];
  const tools = new Map<string, { execute: (args: unknown) => Promise<unknown> }>();
  apply({
    huaanworkRouteAgent: { current: agent },
    planMode: { set(next: unknown, active: boolean) { seen.push([next, active]); return "queued"; } },
    tools: { register(definition: { name: string; execute: (args: unknown) => Promise<unknown> }) { tools.set(definition.name, definition); } },
  });
  await tools.get("propose_plan")?.execute({ objective: "汇总三份材料" });
  assert.deepEqual(seen, [[agent, true]]);
});

test("the second invalid route call ends the turn", () => {
  assert.equal(noteInvalidRoute("s1").endTurn, false);
  assert.equal(noteInvalidRoute("s1").endTurn, true);
  assert.equal(noteInvalidRoute("s1").text, "没能理解这个请求");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/route-tool-plugin.spec.ts`
Expected: FAIL，`preferControlCalls` 未导出

- [ ] **Step 3: Write minimal implementation**

在 `route-tools.ts` 增加：

```ts
export function preferControlCalls<T extends { name: string }>(calls: readonly T[]): T[] {
  const control = calls.find((call) => call.name === "propose_plan" || call.name === "request_input");
  return control ? [control] : [...calls];
}
```

`finishModelStream` 的两处 `emitToolCalls` 都先过滤。文本协议那条也不能漏：

```ts
const toolCalls = preferControlCalls(parseSseToolCalls(read.payloads, isRegisteredToolName));
if (toolCalls.length > 0) {
  yield* emitToolCalls(toolCalls, read.nextIndex);
  return;
}
const textCall = parseTextProtocol(read.text, isRegisteredToolName);
const textCalls = textCall ? preferControlCalls([textCall]) : [];
if (textCalls.length > 0) {
  yield* emitToolCalls(textCalls, read.nextIndex);
  return;
}
```

这样 agent 循环看不到被丢掉的 `read` 或 `bash`，B25 由这条单测覆盖。

`propose_plan` 的 `execute` 读取 `ctx.huaanworkRouteAgent.current`。宿主在 `followup` 之前把当前会话 agent 写入这个 holder，写法和 `call_host_tool` 读 `huaanworkAgentCatalog` 相同。然后调用 `ctx.planMode.set(agent, true)`。没有 agent 时返回工具错误，不假装已经进入计划模式。

`request_input` 的 `execute` 自己挂起，直到对话卡片提交或取消。提交把答案作为这次工具的结果返回。取消返回工具错误并结束回合。不要把这次等待交给 Task 11 的 `user-questions/request`。那条瀑布只回答官方的 `plan-review` 和 `ask_user_question`。

参数无法解析时，`execute` 返回 `isError: true`，正文是可修正的原因，让模型再发一次。`noteInvalidRoute(sessionId)` 按会话计数：第一次 `{ endTurn: false }`，第二次 `{ endTurn: true, text: "没能理解这个请求" }`。第二次由 `route-tool-plugin` 调用 `ctx.huaanworkEmit` 发这条 note，并取消该会话的继续生成。不要把这件事交给 `bridge.ts`。同一个会话出现一次合法的 `propose_plan` 或 `request_input` 后，计数清零。

`sessions.ts` 在 `agent.followup` 之前执行 `ctx.huaanworkRouteAgent.current = agent`。插件 insert 放在 `huaanwork-present-as` 之后。

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/route-tool-plugin.spec.ts tests/huaanwork-guardrails/model.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/route-tool-plugin.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/route-tools.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/model.ts dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts dsh-plugin-huaanwork/src/profile.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/route-tool-plugin.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/model.spec.ts
git commit -m "feat(huaanwork): drop sibling tool calls and enter plan mode from propose_plan"
```

### Task 11: 启用提问服务，没有回答者就停下

**Files:**
- Modify: `dsh-plugin-huaanwork/src/profile.ts`，删除 `{ id: 'user-questions', disabled: true }`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/row-assertions.ts`，删除 `user-questions` 的 disable 断言
- Modify: `dsh-plugin-huaanwork/tests/profile.spec.ts` 约 1280 行的关闭清单，去掉 `user-questions`
- Create: `dsh-plugin-huaanwork/src/huaanwork-guardrails/question-answerer.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/question-answerer.spec.ts`
- 不启用 `ui-user-questions`

**Interfaces:**
- Consumes: 官方 `user-questions/request` 瀑布，只处理 `plan-review` 与 `ask_user_question`
- Produces: `answererDecision(...)`。不把 `request_input` 的答案写回这条瀑布

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "vitest";
import { answererDecision } from "../../src/huaanwork-guardrails/question-answerer.ts";

test("a missing answerer never releases a write", () => {
  assert.equal(answererDecision({ hasListener: false, intent: "clarify", mode: "full", autoContinue: true }), "unanswered");
  assert.equal(answererDecision({ hasListener: true, intent: "plan-review", mode: "ask", autoContinue: false }), "wait");
  assert.equal(answererDecision({ hasListener: true, intent: "plan-review", mode: "smart", autoContinue: true }), "auto-approve");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/question-answerer.spec.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: Write minimal implementation**

```ts
export function answererDecision(input: {
  hasListener: boolean;
  intent: "clarify" | "plan-review";
  mode: "ask" | "smart" | "full";
  autoContinue: boolean;
}): "wait" | "auto-approve" | "unanswered" {
  if (!input.hasListener) return "unanswered";
  if (input.intent === "plan-review" && input.autoContinue && input.mode !== "ask") return "auto-approve";
  return "wait";
}
```

`unanswered` 时界面对话显示「这个问题还没有人接到」，不执行写入，不调用官方的到点放行。`wait` 复用现有审批卡的提交和取消按钮。这条瀑布上的 `wait` 只用于 `plan-review` 和官方 `ask_user_question`。`request_input` 的等待、提交和取消在 Task 10b 的 `execute` 里完成，不要在这里把答案塞回 `request_input`。过期的 `plan-review` id 不复用。

回答者必须挂上官方瀑布，否则 `ask()` 以 `NO_PROVIDER` 失败，`exit_plan_mode` 无法退出。在插件 `apply` 里：

```ts
ctx.on("user-questions/request", (request, next) => {
  if (request.intent !== "plan-review") return next();
  const decision = answererDecision({
    hasListener: true,
    intent: "plan-review",
    mode: currentGuardMode(),
    autoContinue: autoContinueForCurrentPlan(),
  });
  if (decision === "unanswered") return next();
  if (decision === "auto-approve") return approvePlanReview(request);
  return showChatCard(request);
});
```

`hasListener: false` 只用于还没挂上这个 `on` 的测试。挂上之后，卡片没人点不等于没有回答者。没有挂上 `on` 时不要自动提交同意。

`profile.ts` 去掉 `user-questions` 的 disable 行。`row-assertions.ts` 去掉对应 disable 断言。`tests/profile.spec.ts` 的关闭清单同步去掉该 id。不要给 `ui-user-questions` 写 `disabled: false`。

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/question-answerer.spec.ts tests/profile.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/question-answerer.ts dsh-plugin-huaanwork/src/profile.ts dsh-plugin-huaanwork/src/huaanwork-host/row-assertions.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/question-answerer.spec.ts dsh-plugin-huaanwork/tests/profile.spec.ts
git commit -m "feat(huaanwork): answer user questions in the existing chat card"
```

### Task 12: 计划模式与计划卡

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/planConfirm.ts`
- Modify: `dsh-plugin-huaanwork/src/profile.ts`，增加 `{ id: "plan-mode", disabled: false }`。不要启用 `ui-plan`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts` 与 `model.ts`，放行 `exit_plan_mode`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`，计划卡与常备按钮
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/planConfirm.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/present-as.cordis.spec.ts`

**Interfaces:**
- Consumes: `answererDecision`
- Produces: `planNeedsConfirm(input: { mode: "ask" | "smart" | "full"; declaresAskTool: boolean; changesTarget: boolean }): boolean`、`PLAN_CARD_NOTE = "计划确认前，模型仍可能读取工作区；写入和命令继续走现有权限。"`、`AUTO_CONTINUE_LABEL = "按当前护栏自动继续"`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "vitest";
import { AUTO_CONTINUE_LABEL, PLAN_CARD_NOTE, planNeedsConfirm } from "../../src/client-huaanwork/logic/planConfirm.ts";

test("ask always confirms, smart confirms only the ask-set, full confirms target changes", () => {
  assert.equal(planNeedsConfirm({ mode: "ask", declaresAskTool: false, changesTarget: false }), true);
  assert.equal(planNeedsConfirm({ mode: "smart", declaresAskTool: false, changesTarget: true }), false);
  assert.equal(planNeedsConfirm({ mode: "smart", declaresAskTool: true, changesTarget: false }), true);
  assert.equal(planNeedsConfirm({ mode: "full", declaresAskTool: true, changesTarget: false }), false);
  assert.equal(planNeedsConfirm({ mode: "full", declaresAskTool: false, changesTarget: true }), true);
  assert.match(PLAN_CARD_NOTE, /仍可能读取工作区/);
  assert.equal(AUTO_CONTINUE_LABEL, "按当前护栏自动继续");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/planConfirm.spec.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: Write minimal implementation**

```ts
export const PLAN_CARD_NOTE = "计划确认前，模型仍可能读取工作区；写入和命令继续走现有权限。";
export const AUTO_CONTINUE_LABEL = "按当前护栏自动继续";

export function planNeedsConfirm(input: {
  mode: "ask" | "smart" | "full";
  declaresAskTool: boolean;
  changesTarget: boolean;
}): boolean {
  if (input.mode === "ask") return true;
  if (input.mode === "smart") return input.declaresAskTool;
  return input.changesTarget;
}
```

`declaresAskTool` 为真的条件沿用现有 policy：高危命令、`git_push`、脏树 `git_checkout`、附加的 host/MCP 工具、外发或删除。`changesTarget` 为真的条件是目标、收件人或写入范围相对上一份已确认计划发生了变化。

进入计划模式的调用点在 Task 10b：`propose_plan` 的 `execute` 调用 `ctx.planMode.set(agent, true)`。本任务不在渲染器里再调一次 `set`。方法签名是 `set(agent, active)`。若进入发生在同一会话已经执行过 direct 工具之后，保留那些工具结果，不重新执行它们。不要注册 `/plan`。模型稍后调用 `exit_plan_mode` 时，把计划 Markdown 画在该回合工具行之前，并显示 `PLAN_CARD_NOTE`。`planNeedsConfirm` 为真时按钮是「按这个计划执行」和「继续改计划」，点击值必须等于官方 `plan-review` 的 approve / keep-planning 选项。为假时计划卡显示 `AUTO_CONTINUE_LABEL`，回答者提交同意且不等待点击。这个自动同意只结束 `exit_plan_mode`，随后的 `git_push` 等调用仍走工具级询问。

「继续改计划」把 keep-planning 反馈交回模型，不执行计划中的写入。「退出计划模式」按钮先把未回答的 `plan-review` 以拒绝结算，使 `exit_plan_mode` 结束，再调用 `ctx.planMode.set(agent, false)`。顺序不能反。按钮在评审卡没出现时也能点。

`profile.ts` 只加 `{ id: "plan-mode", disabled: false }`。不要改 `ui-plan` 的 `disabled: true`。

`present-as` 在 `tools/change` 时会按 `ALLOWED_TOOLS` 重新限制全部 agent。`exit_plan_mode` 不在现有名单里，计划模式一行启用后这个工具会注册成功，随即被剥掉，模型看不到它。本任务把 `"exit_plan_mode"` 加入 `ALLOWED_TOOLS`，并加入 `isRegisteredToolName`。`present-as.cordis.spec.ts` 断言这个名字在白名单里。不要加入 `ask_user_question`。澄清继续走 `request_input`。

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/planConfirm.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/planConfirm.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/src/profile.ts dsh-plugin-huaanwork/tests/client-huaanwork/planConfirm.spec.ts
git commit -m "feat(huaanwork): show plan review in the chat and keep the official plan row"
```

### Task 13: 待办进度与读侧核对

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/outcomeCheck.ts`
- Modify: `dsh-plugin-huaanwork/src/profile.ts`，增加 `{ id: "tool-todo", disabled: false, config: { allowParallelInProgress: false } }`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`，把 todo 事件画成待做 / 进行中 / 已勾选
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/outcomeCheck.spec.ts`

**Interfaces:**
- Consumes: 本回合工具结果 `{ name: string; isError: boolean; exitCode?: number; text: string }[]` 与文件存在检查 `(path: string) => boolean`
- Produces: `outcomeGaps(input: { requiredFiles: readonly string[]; requiredCommands: readonly string[]; toolResults: readonly { name: string; command?: string; isError: boolean }[]; fileExists: (path: string) => boolean }): string[]`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "vitest";
import { outcomeGaps } from "../../src/client-huaanwork/logic/outcomeCheck.ts";

test("missing files and commands are gaps even when every todo is checked", () => {
  const gaps = outcomeGaps({
    requiredFiles: ["报告.md"],
    requiredCommands: ["pnpm test"],
    toolResults: [{ name: "bash", command: "pnpm test", isError: true }],
    fileExists: () => false,
  });
  assert.deepEqual(gaps, ["缺少文件：报告.md", "命令未通过：pnpm test"]);
  assert.deepEqual(
    outcomeGaps({
      requiredFiles: ["报告.md"],
      requiredCommands: ["pnpm test"],
      toolResults: [{ name: "bash", command: "pnpm test", isError: false }],
      fileExists: (path) => path === "报告.md",
    }),
    [],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/outcomeCheck.spec.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: Write minimal implementation**

```ts
export function outcomeGaps(input: {
  requiredFiles: readonly string[];
  requiredCommands: readonly string[];
  toolResults: readonly { name: string; command?: string; isError: boolean }[];
  fileExists: (path: string) => boolean;
}): string[] {
  const gaps: string[] = [];
  for (const file of input.requiredFiles) {
    if (!input.fileExists(file)) gaps.push(`缺少文件：${file}`);
  }
  for (const command of input.requiredCommands) {
    const result = input.toolResults.find((item) => item.command === command);
    if (!result || result.isError) gaps.push(`命令未通过：${command}`);
  }
  return gaps;
}
```

`requiredFiles` 与 `requiredCommands` 来自用户原文里明确写出的路径和命令，加上计划卡里写明的产物路径。命令文本从配对的 `tool/call` 参数里取：`bash` / `pwsh` 的 `command` 字段。`tool/result` 现有记录没有 `command` 和 `exitCode`，不要假设它们已经在 `session-view.ts` 里。`detailRecords` 在 `tool-call` 上增加可选 `command?: string`。核对时用这个字段匹配 `requiredCommands`。没有配对调用，或结果 `isError === true`，就算缺项。日志里没有数字退出码时，不要编一个 `exitCode`。函数不调用 `bash` 重跑。`gaps.length > 0` 时回合结果列出这些句子，不显示「已完成」。待办三项中文标签只随 `todo_write` 的 `pending` / `in_progress` / `completed` 变化，勾选不参与 `outcomeGaps`。

开放式写作没有 `requiredFiles` 和 `requiredCommands` 时，结果写「没有自动核对项，需要你自己看」。

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/outcomeCheck.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/outcomeCheck.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/src/profile.ts dsh-plugin-huaanwork/tests/client-huaanwork/outcomeCheck.spec.ts
git commit -m "feat(huaanwork): check files and recorded command results before calling a turn done"
```

### Task 14: 结果裁剪与压缩不进思考面板

**Files:**
- Modify: `dsh-plugin-huaanwork/src/profile.ts`，增加 `{ id: "tool-result-pruner", disabled: false }` 与 `{ id: "compaction-basic", disabled: false }`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/bridge.spec.ts` 已有 Task 3 的 purpose 过滤。再追加一条 purpose 为 `compaction` 的用例
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`，当本回合 note 来自压缩时显示固定句

**Interfaces:**
- Consumes: bridge 已忽略 `purpose !== undefined` 的 token 与 reasoning
- Produces: 压缩后的固定提示「更早的工具输出已被压缩」

- [ ] **Step 1: Write the failing test**

```ts
test("compaction purpose does not emit reasoning or tokens", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { ctx, listeners, emitted } = createCtx();
  apply(ctx as never);
  const wrap = listeners["llm/stream"]?.[0] as (
    options: { purpose?: string },
    next: () => AsyncIterable<{ type: "reasoning-delta" | "text-delta"; index: number; text: string }>,
  ) => AsyncIterable<unknown>;
  async function* compact() {
    yield { type: "reasoning-delta" as const, index: 0, text: "压缩思考" };
    yield { type: "text-delta" as const, index: 1, text: "摘要" };
  }
  for await (const _chunk of wrap({ purpose: "compaction" }, compact)) {
    // drain
  }
  assert.equal(emitted.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/bridge.spec.ts -t "compaction purpose"`
Expected: 若 Task 3 已按 `purpose === undefined` 过滤，此测试应 PASS。若 FAIL，就停在 Step 3 补上 `purpose` 判断，不要放宽过滤。

- [ ] **Step 3: Write minimal implementation**

`profile.ts` 的护栏补丁数组加入：

```ts
{ id: "tool-result-pruner", disabled: false },
{ id: "compaction-basic", disabled: false },
```

不要改 `REQUEST_TIMEOUT_MS`。不要启用 `jobs`。工具结果已有 `truncated: true` 时，界面保留现有 `truncated` 标记。压缩完成后往该会话追加 note「更早的工具输出已被压缩」。这句 note 不是思考面板内容。

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/bridge.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/profile.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/tests/huaanwork-guardrails/bridge.spec.ts
git commit -m "feat(huaanwork): prune tool output and keep compaction text out of the chat"
```

### Task 15: 目标续轮

这一项只在 Task 5 的发送解耦测试已经通过之后开始。

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/goalRound.ts`
- Modify: `dsh-plugin-huaanwork/src/profile.ts`，此时才加入 `{ id: "tool-goal", disabled: false }`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts` 与 `model.ts`，放行 `get_goal`、`create_goal`、`update_goal`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/goalRound.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/present-as.cordis.spec.ts`

**Interfaces:**
- Consumes: 官方 `goal-round-driver` 已在宿主上。本任务不改驱动器源码
- Produces: `goalRoundLabel(round: number): string`、`GOAL_ROUND_LIMIT = 4`、`goalRoundStopped(round: number, gaps: readonly string[]): string`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "vitest";
import { GOAL_ROUND_LIMIT, goalRoundLabel, goalRoundStopped } from "../../src/client-huaanwork/logic/goalRound.ts";

test("goal rounds stop at four and keep the gaps", () => {
  assert.equal(GOAL_ROUND_LIMIT, 4);
  assert.equal(goalRoundLabel(2), "正在按目标继续，第 2/4 轮，这还不是验收结果");
  assert.equal(goalRoundStopped(4, ["缺少文件：报告.md"]), "已停在第 4/4 轮。尚未核对：缺少文件：报告.md");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/goalRound.spec.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: Write minimal implementation**

```ts
export const GOAL_ROUND_LIMIT = 4;

export function goalRoundLabel(round: number): string {
  return `正在按目标继续，第 ${round}/${GOAL_ROUND_LIMIT} 轮，这还不是验收结果`;
}

export function goalRoundStopped(round: number, gaps: readonly string[]): string {
  const pending = gaps.length > 0 ? gaps.join("；") : "无";
  return `已停在第 ${round}/${GOAL_ROUND_LIMIT} 轮。尚未核对：${pending}`;
}
```

启用模型入口时同时改宿主上已有的 `goal` 行，不要改 `goal-round-driver` 源码：

```ts
{ id: "tool-goal", disabled: false },
{ id: "goal", config: { defaultMaxGoalRounds: 4 } },
```

同时把 `"get_goal"`、`"create_goal"`、`"update_goal"` 加入 `ALLOWED_TOOLS` 和 `isRegisteredToolName`，并在 `present-as.cordis.spec.ts` 断言这三个名字。不加入的话，`tool-goal` 注册之后会被 `tools/change` 上的 `restrictAll` 剥掉，B19 到不了模型。`todo_write` 已经在白名单和 `KNOWN_TOOL_NAMES` 里，启用 `tool-todo` 时不要再加一次。

`defaultMaxGoalRounds` 是 `GoalService.Config` 的字段，缺省 256。模型工具上的参数名是 `max_goal_rounds`，不是 `maxGoalRounds`。创建或编辑时如果带了大于 4 的 `max_goal_rounds`，在 `tools/pre-execute` 拒绝，错误文本为 `目标最多自动续 4 轮`。不要另写续跑器。续轮开始时界面显示 `goalRoundLabel`。第 4 轮结束后显示 `goalRoundStopped`，并把 `outcomeGaps` 的结果传进去。不自动创建下一个 goal。取消当前会话时不重新启动续轮。权限询问仍按原 policy 出现。

在 Task 15 改 `profile.ts` 之前，测试断言组成结果里 `tool-goal` 不是 `disabled: false`。本任务把该断言改成 `tool-goal` 已启用，且 `goal` 行的 `defaultMaxGoalRounds` 为 4。

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/goalRound.spec.ts tests/profile.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/goalRound.ts dsh-plugin-huaanwork/src/profile.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/tests/client-huaanwork/goalRound.spec.ts dsh-plugin-huaanwork/tests/profile.spec.ts
git commit -m "feat(huaanwork): continue one goal for at most four rounds"
```

### Task 16: 锁回归与桌面核对

**Files:**
- Modify: `dsh-plugin-huaanwork/tests/profile.spec.ts`，断言下列 id 仍为 `disabled: true`：`jobs`、`tool-jobs`、`workflow-ptc`、`tool-workflow`、`tool-ralph`、`web`、`web-search-deepseek`、`tool-web`、`hmr`、`llm-deepseek`、`ui-plan`、`ui-trajectory`、`ui-user-questions`
- 不改这些行的产品行为

- [ ] **Step 1: Write the failing test**

若 `profile.spec.ts` 已有等价断言，不要新写失败用例。把缺失的 id 加进现有关闭清单。新增的断言在实现已经满足时应直接 PASS。如果某次任务误把 `ui-plan` 设成 `disabled: false`，这个测试必须 FAIL。

- [ ] **Step 2: Run the lock test**

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/profile.spec.ts`
Expected: PASS

- [ ] **Step 3: Run the variant check**

Run: `corepack yarn check:desktop-variants`
Expected: 退出码 0。失败时停下来报告文件名，不要新增 `allowedDifferences`。`main.ts` 和 `host-process.ts` 已经在允许差异里，只改这两处应能通过。其他文件失败不是扩大白名单的理由。

- [ ] **Step 4: Desktop pass**

单测和真机分开。下面这些单测已经覆盖规则，真机不再重复造同样的表格：

| 单测为准 | 必须真机 |
| --- | --- |
| B02、B03、B04、B12、B14 的文案阈值、B15、B18、B20、B25 | B01、B05、B06、B07、B08、B09、B10、B11、B13、B16、B17、B19、B21、B22、B23、B24、B26 |

真机用显式启动的高级模式和真实模型。B16 只能在独立 Host 上核对。Windows 没有真机时把杀进程记为未验证，不要写成全平台通过。B07、B08、B11、B21 不能只用 `classifyToolCalls` 或 `noteInvalidRoute` 的单测代替。B21 的单测只证明第二次计数会结束回合；真机要看到连续两次坏参数之后，对话里出现「没能理解这个请求」。

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/tests/profile.spec.ts
git commit -m "test(huaanwork): keep the conversation work from reopening locked rows"
```

只有 `profile.spec.ts` 有改动时才提交。桌面核对不产生提交。
