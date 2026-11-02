# 会话内工具面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变工具执行、审批和返回链路的前提下，把父会话普通工具调用投影为每个用户回合一个可折叠工具面板，并让实时、历史、断连和目标续轮共享诚实的状态语义。

**Architecture:** `ChatItem[]` 仍是唯一执行事实来源；新增纯逻辑模块负责实时工具卡更新、按回合渲染投影、`turnFinal` 结算和工具状态派生。App 只在最终渲染层用虚拟面板行替换普通工具行，审批、输入、待办和子代理卡继续消费扁平数组。新增受控 React 组件负责面板与单项详情交互，手动面板选择写回首工具条目。

**Tech Stack:** TypeScript ESM、React 18、Vitest 4 + jsdom、现有 `capToolOutput`（默认 32 KiB）、Yarn 4.18.0/Corepack；不新增依赖。

## Global Constraints

- 设计真相源：`docs/superpowers/specs/2026-11-01-chat-tool-panel-design.md`；评审校准：`docs/superpowers/specs/2026-11-01-chat-tool-panel-design-review.md`。基线外层 HEAD：`ff897f713c`。
- 只修改 `dsh-plugin-huaanwork/` 及本功能证据文档；不得修改 `deepseek-harness/` 子模组，不新增右侧“工具”页签，不改造“进度”页签。
- 扁平 `ChatItem[]` 继续供 `turnChecks`、`insertBeforeToolRow`、`contentItems`、思考收尾、审批关联和取消逻辑使用；虚拟 `tool-panel` 行不得加入持久化 `ChatItem` 联合。
- `connectionLost` 只能取 `sidecarDead`；`hostPhase` 不得直接改写工具状态。断连不写执行终态，连接恢复本身不等于工具成功。
- `turnFinal` 一旦为 `true` 不得被后续事件翻回 `false`；新用户条目开启新的非 final 回合。目标 `active` 的中间 `session/end` 不得收起或标未确认；后到的 `goal/state complete` 必须以真实 `reduceGoalTurn` 返回的 `outcome` 立即结算。
- 工具输出继续经过现有 `capToolOutput`；历史 shell 结果继续按“完整文本提取失败标记 → capped → 拼回未保留标记”的顺序生成。
- 通用说明只按工具名查闭合映射，不拼接参数、路径或命令，不增加模型调用。详情只使用文本节点/`<pre>`，不得注入 HTML。
- `HistoryDetailPane` 保持逐条日志；本功能只改变“继续此会话”、子任务历史恢复和运行记录回填后的可聊标签。
- 使用 Node.js `^22.19.0` 或 `>=24.0.0`，经 Corepack 使用 Yarn `4.18.0`。所有自动化测试和门禁保持 headless；root 门禁串行运行，避免既有 `verify:aa` 并发竞态。
- 每个任务的 commit 步骤只有在用户明确要求提交时才执行；否则跳过提交并保留工作树变更。图形应用只在最终人工验收且用户明确同意后启动。
- 局部测试、类型检查、完整门禁和真机验收分别记录，不得互相冒充；网络、环境或平台阻塞必须如实写入证据。

---

## File Structure

**共享事件与历史契约**
- `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`：客户端 `tool/start.args`、历史 `user.goalRound` 与 `tool-result.truncated`。
- `dsh-plugin-huaanwork/src/client-huaanwork/logic/commandOutcome.ts`：实时桥与历史共用的参数摘要纯函数。
- `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts`：宿主事件联合、实时参数摘要和始终携带文本的 `tool/end`。
- `dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts`：历史参数摘要复用、goal 续轮元数据、截断事实与既有失败标记拼回。
- `dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts`：goal 续轮 note 恢复、历史调用/结果配对与缺结果语义。

**新增客户端逻辑与展示**
- `dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts`：工具卡更新、状态派生、回合投影、`turnFinal`、断连与运行条辅助函数。
- `dsh-plugin-huaanwork/src/client-huaanwork/ToolPanel.tsx`：受控面板、多个单项详情、读屏状态迁移。
- `dsh-plugin-huaanwork/src/client-huaanwork/styles.css` 与生成物 `styles.generated.ts`：独立工具面板样式、40vh 内滚动、文本换行和焦点样式。

**App 接线**
- `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`：`ToolCard` 数据字段、实时/历史消费、按标签和用户条目保存 `turnFinal`、memoized 渲染投影、手动展开、回合条。

**测试与证据**
- 新增 `tests/client-huaanwork/toolPanel.spec.ts`、`tests/client-huaanwork/ToolPanel.spec.ts`。
- 扩展 `tests/huaanwork-guardrails/bridge.spec.ts`、`tests/huaanwork-host/session-view.spec.ts`、`tests/client-huaanwork/{sessionChannel,appWiring,goalRound,turnStatus,outcomeCheck,commandOutcome}.spec.ts`。
- 新建 `docs/evidence/2026-11-02-chat-tool-panel-verification.md`：实际门禁和图形/受控模拟验收记录。

---

### Task 1: 共享参数摘要与实时事件数据契约

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/commandOutcome.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`（`ToolCard`、`ChatItem` tool 变体、`ChatTab`）
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/commandOutcome.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/bridge.spec.ts`

**Interfaces:**
- Consumes: 现有 `parseToolArguments`、`TOOL_LABEL_MAX_CHARS`、`capToolOutput` 与 `ToolExecution.arguments`。
- Produces: `formatToolArguments(value: unknown): string | undefined`；两份 `tool/start` 联合均有 `args?: string`；`tool/end` 每次都有 `text: string`；后续任务使用 `ToolCard.args/hasResult/interrupted/unconfirmed/resultMissing`、tool 条目的 `panelToggled` 和标签的 `turnFinalByUserId`。

- [ ] **Step 1: 写共享格式化与实时载荷的失败测试**

在 `commandOutcome.spec.ts` 增加：

```ts
import { formatToolArguments } from "../../src/client-huaanwork/logic/commandOutcome.ts";

test("formatToolArguments matches history single-line labels and survives serialization failure", () => {
  assert.equal(formatToolArguments({ path: "a.md", note: "一  行\n换行" }), '{"path":"a.md","note":"一 行\\n换行"}');
  assert.equal(formatToolArguments('{"command":"pnpm test"}'), '{"command":"pnpm test"}');
  assert.equal(formatToolArguments("not json"), "not json");
  assert.equal(formatToolArguments(undefined), undefined);
  assert.equal(formatToolArguments(null), undefined);
  const long = { text: "x".repeat(201) };
  assert.equal(formatToolArguments(long), `${JSON.stringify(long).slice(0, 200)}…`);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.equal(formatToolArguments(circular), undefined);
});
```

在 `bridge.spec.ts` 增加独立用例，并更新既有 todo/bash start 的期望以包含 `args`：

```ts
test("bridge sends display args and always sends capped tool result text without changing execution results", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { ctx, listeners, emitted } = createCtx();
  apply(ctx as never);
  const execute = listeners["tools/execute"]?.[0] as Execute;

  const returned = await execute(
    { name: "read", callId: "r1", arguments: { path: "a.md" } },
    async () => ({ isError: false, content: [{ type: "text", text: "ordinary output" }] }),
  );
  assert.equal(returned.content[0]?.text, "ordinary output");
  assert.deepEqual(emitted[0], {
    event: "tool/start", name: "read", callId: "r1", args: '{"path":"a.md"}',
  });
  assert.deepEqual(emitted[1], {
    event: "tool/end", name: "read", callId: "r1", text: "ordinary output",
  });

  emitted.length = 0;
  await execute({ name: "read", callId: "empty", arguments: undefined }, async () => ({ isError: false, content: [] }));
  const emptyEnd = emitted.find((event) => (event as { event?: string }).event === "tool/end") as { text?: unknown };
  assert.equal(Object.hasOwn(emptyEnd, "text"), true);
  assert.equal(emptyEnd.text, "");

  emitted.length = 0;
  const circular: { self?: unknown } = {};
  circular.self = circular;
  await execute({ name: "read", callId: "circular", arguments: circular }, async () => ({ isError: false, content: [] }));
  assert.deepEqual(emitted[0], { event: "tool/start", name: "read", callId: "circular" });
});
```

既有 `bridge carries todo_write todos...` 用例的两个 start 期望同步改为以下精确对象，防止实现后才发现旧断言未更新：

```ts
assert.deepEqual(starts[0], {
  event: "tool/start",
  name: "todo_write",
  callId: "t1",
  args: '{"todos":[{"content":"写报告","status":"in_progress"},{"content":"核对","status":"weird"},{"content":3,"status":"pending"}]}',
  todos: [{ content: "写报告", status: "in_progress" }],
});
assert.deepEqual(starts[1], {
  event: "tool/start", name: "bash", callId: "b1", args: '{"command":"pnpm test"}', command: "pnpm test",
});
```

同一文件的 `bridge keeps an unregistered session unchanged while a registry is present` 用例（`bridge.spec.ts:714-716`）也对完整事件数组做精确断言；将其期望同步改为：

```ts
assert.deepEqual(emitted, [
  {
    event: "tool/start",
    name: "read",
    callId: "call-parent",
    sessionId: PARENT_SESSION,
    args: '{"path":"a.md"}',
  },
  {
    event: "tool/end",
    name: "read",
    callId: "call-parent",
    sessionId: PARENT_SESSION,
    text: "ok",
  },
]);
```

同一文件读取两份源码，钉住独立联合：

```ts
test("host and client tool-start unions both declare args without duplicating tool-end truncation", () => {
  const bridge = readFileSync(new URL("../../src/huaanwork-guardrails/bridge.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../../src/client-huaanwork/rpc-types.ts", import.meta.url), "utf8");
  for (const source of [bridge, client]) {
    const startAt = source.indexOf('event: "tool/start"');
    const endAt = source.indexOf('event: "tool/end"', startAt);
    assert.ok(startAt >= 0 && endAt > startAt);
    assert.match(source.slice(startAt, endAt), /args\?: string/);
    assert.equal((source.slice(endAt, endAt + 240).match(/truncated\?: boolean/g) ?? []).length, 1);
  }
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/commandOutcome.spec.ts tests/huaanwork-guardrails/bridge.spec.ts
```

Expected: FAIL，`formatToolArguments` 未导出，start 缺少 `args`，普通/空结果断言或类型联合断言失败。

- [ ] **Step 3: 实现共享格式化和契约字段**

在 `commandOutcome.ts` 增加下列函数；单行化和 200 字符上限与历史 `formatArgs` 完全一致：

```ts
export function formatToolArguments(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = parseToolArguments(value);
  let encoded: string;
  if (typeof parsed === "string") {
    encoded = parsed;
  } else {
    try {
      encoded = JSON.stringify(parsed) ?? "";
    } catch {
      return undefined;
    }
  }
  const flat = encoded.replace(/\s+/g, " ").trim();
  return flat.length <= TOOL_LABEL_MAX_CHARS ? flat : `${flat.slice(0, TOOL_LABEL_MAX_CHARS)}…`;
}
```

在 bridge 的导入中加入 `formatToolArguments`，宿主 `tool/start` 联合和客户端 `rpc-types.ts` 的 `tool/start` 联合都加入：

```ts
args?: string;
```

把 bridge `startDetail` 改为始终先计算可省略的摘要，再合并既有 todos/command：

```ts
function startDetail(execution: ToolExecution): Partial<Extract<RpcEvent, { event: "tool/start" }>> {
  const formattedArgs = formatToolArguments(execution.arguments);
  const args = formattedArgs === undefined ? {} : { args: formattedArgs };
  const objectArgs = objectValue(execution.arguments);
  if (execution.name === "todo_write" && Array.isArray(objectArgs.todos)) {
    const todos = objectArgs.todos.flatMap((entry) => {
      const todo = objectValue(entry);
      return typeof todo.content === "string" && typeof todo.status === "string" && TODO_STATUSES.has(todo.status)
        ? [{ content: todo.content, status: todo.status as "pending" | "in_progress" | "completed" }]
        : [];
    });
    return { ...args, todos };
  }
  const command = shellCommandOf(execution.name, execution.arguments);
  return { ...args, ...(command === undefined ? {} : { command }) };
}
```

把父会话 `tool/end` 的 capped 展开改为：

```ts
text: capped.text,
...(capped.truncated ? { truncated: true } : {}),
```

不得改最后的 `return { ...result, content: [{ type: "text", text: capped.text }] }`，也不得改子代理分支。

在 App 的 `ToolCard` 增加：

```ts
args?: string;
hasResult?: boolean;
interrupted?: boolean;
unconfirmed?: boolean;
resultMissing?: boolean;
```

把 tool 变体改为 `{ id: number; kind: "tool"; card: ToolCard; panelToggled?: "expand" | "collapse" }`，并在 `ChatTab` 增加：

```ts
turnFinalByUserId?: Readonly<Record<number, boolean>>;
```

- [ ] **Step 4: 运行定向测试与类型检查**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/commandOutcome.spec.ts tests/huaanwork-guardrails/bridge.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```

Expected: 两条命令均 PASS；已有 capped、失败标记和子代理测试不回归。

- [ ] **Step 5: 条件式提交**

仅在用户已明确要求提交时执行：

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/commandOutcome.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/tests/client-huaanwork/commandOutcome.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/bridge.spec.ts
git commit -m "feat: carry tool panel event details"
```

---

### Task 2: 历史截断、goal 续轮与同回合结果配对

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`（`historyToChatItems`）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/session-view.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/sessionChannel.spec.ts`

**Interfaces:**
- Consumes: Task 1 `formatToolArguments` 和 `ToolCard` 新字段；现有 `goalRoundLabel`。
- Produces: 历史 `user.goalRound?: number` 与 `tool-result.truncated?: boolean`；goal 续轮恢复为 note 而不切分用户回合；`HistoryChatItem` tool 变体包含 `args/command/output/hasResult/resultMissing/truncated/isError`；旧历史缺结果恢复为 `status="end" + hasResult=false + resultMissing=true`。

- [ ] **Step 1: 写历史截断和配对失败测试**

把 `session-view.spec.ts` 截断用例中既有的 `expect(record).toMatchObject({ kind: "tool-result", isError: true })` 扩展为以下断言；保留其后的既有 `record.text.split("[exit code: 1]")` 断言，不重复添加：

```ts
expect(record).toMatchObject({ kind: "tool-result", truncated: true, isError: true });
```

并在 `caps history results in UTF-8 bytes...` 的 `kept` 类型收窄后加入 `expect(kept).toMatchObject({ truncated: false })`，防止把“有字段”误写成“永远截断”。

在 `session-view.spec.ts` 增加 goal 续轮记录测试，证明只读历史仍保留原用户记录与正文，同时把续轮身份交给可聊恢复层：

```ts
test("retains goal continuation metadata without dropping the read-only user record", () => {
  const records = detailRecords(sessionLog([
    HEADER,
    userMessage("原始目标", 1, T0 + 3),
    userMessage("官方续轮提示", 2, T0 + 4, { kind: "goal", goalId: "g", round: 2 }),
  ]));
  expect(records).toEqual([
    { kind: "user", time: T0 + 3, text: "原始目标" },
    { kind: "user", time: T0 + 4, text: "官方续轮提示", goalRound: 2 },
  ]);
});
```

在 `sessionChannel.spec.ts` 增加恢复映射测试；该 note 与实时 `goal/round` 使用同一文案，不能再产生用户条目：

```ts
test("history maps goal continuation records to notes without splitting the user turn", () => {
  const items = historyItemsFromRecords([
    { kind: "user", time: 1, text: "完成目标" },
    { kind: "tool-call", time: 2, name: "read", callId: "r1" },
    { kind: "tool-result", time: 3, callId: "r1", isError: false, text: "第一轮结果" },
    { kind: "user", time: 4, text: "官方续轮提示", goalRound: 1 },
    { kind: "tool-call", time: 5, name: "grep", callId: "g1" },
  ]);
  assert.deepEqual(items.map((item) => item.kind), ["user", "tool", "note", "tool"]);
  assert.deepEqual(items[2], { kind: "note", text: "正在按目标继续，第 1/4 轮，这还不是验收结果" });
  assert.equal(items.filter((item) => item.kind === "user").length, 1);
});
```

把 `sessionChannel.spec.ts` 中既有 `historyItemsFromRecords maps roles, tool calls and failed results` 用例（`:30-52`）替换为以下三组可独立断言的用例；原有用例的空记录与孤立成功结果覆盖保留在下列测试中：

```ts
test("history pairs success, failure, empty and truncated results into their tool cards", () => {
  const items = historyItemsFromRecords([
    { kind: "user", time: 1, text: "读取并运行" },
    { kind: "tool-call", time: 2, name: "read", callId: "r1", args: '{"path":"a.md"}' },
    { kind: "tool-result", time: 3, callId: "r1", isError: false, text: "内容" },
    { kind: "tool-call", time: 4, name: "read", callId: "r2" },
    { kind: "tool-result", time: 5, callId: "r2", isError: false, text: "" },
    { kind: "tool-call", time: 6, name: "bash", callId: "b1", command: "pnpm test" },
    { kind: "tool-result", time: 7, callId: "b1", isError: true, truncated: true, text: "…（已截断） [exit code: 1]" },
  ]);
  const tools = items.filter((item) => item.kind === "tool");
  assert.deepEqual(tools.map((item) => item.kind === "tool" ? [item.hasResult, item.output, item.isError, item.truncated] : []), [
    [true, "内容", undefined, undefined],
    [true, "", undefined, undefined],
    [true, "…（已截断） [exit code: 1]", true, true],
  ]);
  assert.equal(tools[0]?.kind === "tool" ? tools[0].args : undefined, '{"path":"a.md"}');
  assert.equal(tools[2]?.kind === "tool" ? tools[2].command : undefined, "pnpm test");
  assert.equal(items.some((item) => item.kind === "note"), false, "paired failures do not become extra chat notes");
});

test("history pairs missing-callId results in order within one user turn only", () => {
  const items = historyItemsFromRecords([
    { kind: "user", time: 1, text: "第一回合" },
    { kind: "tool-call", time: 2, name: "grep", callId: "a" },
    { kind: "tool-call", time: 3, name: "grep", callId: "b" },
    { kind: "tool-result", time: 4, isError: false, text: "first" },
    { kind: "tool-result", time: 5, isError: false, text: "second" },
    { kind: "user", time: 6, text: "第二回合" },
    { kind: "tool-result", time: 7, isError: false, text: "must not cross a user boundary" },
    { kind: "tool-call", time: 8, name: "read", callId: "old" },
  ]);
  const tools = items.filter((item) => item.kind === "tool");
  assert.deepEqual(tools.map((item) => item.kind === "tool" ? item.output : undefined), ["first", "second", undefined]);
  assert.equal(tools[2]?.kind === "tool" && tools[2].resultMissing, true);
  assert.equal(items.some((item) => item.kind === "tool" && item.output === "must not cross a user boundary"), false);
});

test("history keeps unmatched failures as notes and marks unmatched calls as result missing", () => {
  assert.deepEqual(historyItemsFromRecords([]), []);
  const items = historyItemsFromRecords([
    { kind: "tool-call", time: 1, name: "read", callId: "old" },
    { kind: "tool-result", time: 2, callId: "unknown", isError: true, text: "  权限不足\n请重试  " },
    { kind: "tool-result", time: 3, callId: "also-unknown", isError: false, text: "orphan success" },
  ]);
  assert.deepEqual(items[0], {
    kind: "tool", name: "read", callId: "old", hasResult: false, resultMissing: true,
  });
  assert.deepEqual(items[1], { kind: "note", text: "工具调用失败：权限不足 请重试" });
  assert.equal(items.length, 2, "orphan success does not invent a tool call");
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/session-view.spec.ts tests/client-huaanwork/sessionChannel.spec.ts
```

Expected: FAIL，历史记录没有 `goalRound`/`truncated`，goal 续轮仍被当成用户回合，成功/空结果没有配入工具卡，缺结果字段缺失。

- [ ] **Step 3: 实现历史记录字段和配对算法**

给 `SessionDetailRecord` 的 `user` 变体增加 `goalRound?: number`，并给 `tool-result` 增加 `truncated?: boolean`：

```ts
| { kind: "user"; time: number; text: string; goalRound?: number }
| { kind: "tool-result"; time: number; callId?: string; isError: boolean; text: string; truncated?: boolean }
```

`session-view.ts` 的 `commandOutcome.ts` 导入改为 `failureMarkers, formatToolArguments, isShellTool, shellCommandOf`（移除已无消费方的 `TOOL_LABEL_MAX_CHARS` 和 `parseToolArguments`），并改用 Task 1 的 `formatToolArguments(data.arguments)`；删除私有 `formatArgs`，但保留供标题使用的私有 `clipText`。只修改 `detailRecords` 的 `user/message` 分支以保留 goal 续轮元数据，记录仍是 `kind="user"`，只读历史页继续显示原文：

```ts
case 'user/message': {
  const source = asObject(data.source)
  const kind = sourceKind(data)
  if (kind === 'plugin' || kind === 'tool') break
  const messageText = firstTextOfMessage(data)
  const goalRound = kind === 'goal' && typeof source.round === 'number' && source.round > 0
    ? source.round
    : undefined
  if (messageText) {
    records.push({
      kind: 'user',
      time,
      text: messageText,
      ...(goalRound === undefined ? {} : { goalRound }),
    })
  }
  break
}
```

在 `tool-result` 记录中增加：

```ts
truncated: capped.truncated,
```

不得改变 `markers → capped → unshownMarkers → text` 的既有顺序。

把 `HistoryChatItem` 的 tool 变体扩展为：

```ts
| {
    kind: "tool";
    name: string;
    callId?: string;
    args?: string;
    command?: string;
    output?: string;
    hasResult: boolean;
    resultMissing?: boolean;
    truncated?: boolean;
    isError?: boolean;
  }
```

在 `sessionChannel.ts` 顶部导入现有 `goalRoundLabel`：

```ts
import { goalRoundLabel } from "./goalRound.ts";
```

用下列完整算法替换 `historyItemsFromRecords`；goal 续轮只恢复 note，结果只更新一个调用，失败提示只留给无法配对的结果：

```ts
export function historyItemsFromRecords(records: readonly HistoryRecord[]): HistoryChatItem[] {
  const items: HistoryChatItem[] = [];
  for (const record of records) {
    if (record.kind === "user") {
      if (record.goalRound !== undefined) {
        items.push({ kind: "note", text: goalRoundLabel(record.goalRound) });
      } else {
        items.push({ kind: "user", text: record.text });
      }
      continue;
    }
    if (record.kind === "thinking") {
      items.push({ kind: "thinking", text: record.text });
      continue;
    }
    if (record.kind === "assistant") {
      items.push({ kind: "assistant", text: record.text });
      continue;
    }
    if (record.kind === "tool-call") {
      items.push({
        kind: "tool",
        name: record.name || "tool",
        ...(record.callId ? { callId: record.callId } : {}),
        ...(record.args === undefined ? {} : { args: record.args }),
        ...(record.command === undefined ? {} : { command: record.command }),
        hasResult: false,
        resultMissing: true,
      });
      continue;
    }

    let turnStart = 0;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index]?.kind === "user") {
        turnStart = index + 1;
        break;
      }
    }
    let match = -1;
    if (record.callId) {
      match = items.findIndex((item) => item.kind === "tool" && item.callId === record.callId && item.hasResult === false);
    } else {
      match = items.findIndex((item, index) => index >= turnStart && item.kind === "tool" && item.hasResult === false);
    }
    if (match >= 0) {
      const tool = items[match];
      if (tool?.kind !== "tool") continue;
      items[match] = {
        ...tool,
        output: record.text,
        hasResult: true,
        resultMissing: undefined,
        ...(record.truncated === true ? { truncated: true } : {}),
        ...(record.isError ? { isError: true } : {}),
      };
    } else if (record.isError) {
      const text = record.text.replace(/\s+/g, " ").trim().slice(0, 200);
      items.push({ kind: "note", text: `工具调用失败：${text || "未知错误"}` });
    }
  }
  return items;
}
```

`historyToChatItems` 的 tool 分支保留所有恢复字段：

```ts
card: {
  key: callId ?? `tool-${allocId()}`,
  name: item.name,
  ...(callId ? { callId } : {}),
  status: "end",
  ...(item.args === undefined ? {} : { args: item.args }),
  ...(item.command === undefined ? {} : { command: item.command }),
  ...(item.output === undefined ? {} : { output: item.output }),
  hasResult: item.hasResult,
  ...(item.resultMissing === true ? { resultMissing: true } : {}),
  ...(item.truncated === true ? { truncated: true } : {}),
  ...(item.isError === true ? { isError: true } : {}),
},
```

- [ ] **Step 4: 运行历史测试与类型检查**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/session-view.spec.ts tests/client-huaanwork/sessionChannel.spec.ts tests/client-huaanwork/runResultAttachments.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```

Expected: PASS；goal 续轮元数据与 note 恢复均有覆盖，只读 `HistoryDetailPane` 组件不改，既有逐条日志断言和运行附件折叠测试不回归。

- [ ] **Step 5: 条件式提交**

仅在用户已明确要求提交时执行：

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/tests/huaanwork-host/session-view.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/sessionChannel.spec.ts
git commit -m "feat: restore tool results into history cards"
```

---

### Task 3: 实时工具卡更新与单工具状态纯函数

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`（`tool/start`、`tool/end`）
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/toolPanel.spec.ts`

**Interfaces:**
- Consumes: Task 1 实时事件和 `ToolCard` 字段。
- Produces: `ToolPanelCard`、`ToolPanelItem`、`ToolEntryStatus`、`toolEntryStatus(card, connectionLost)`、`applyToolEnd(items, event)`、`withToolPanelToggle(items, anchorId, next)`。Task 4/5/6 复用这些类型与状态定义。

- [ ] **Step 1: 写无 callId 并发、迟到终态和断连状态测试**

新建 `toolPanel.spec.ts`，先加入：

```ts
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  applyToolEnd,
  toolEntryStatus,
  withToolPanelToggle,
  type ToolPanelCard,
  type ToolPanelItem,
} from "../../src/client-huaanwork/logic/toolPanel.ts";

function tool(id: number, name: string, callId?: string): ToolPanelItem {
  return {
    id,
    kind: "tool",
    card: { key: callId ?? `key-${id}`, name, ...(callId ? { callId } : {}), status: "start" },
  };
}

function cardAt(items: readonly ToolPanelItem[], index: number) {
  const item = items[index];
  if (item?.kind !== "tool") throw new Error(`expected tool at ${index}`);
  return item.card;
}

test("same-name tools without callId end one earliest running card at a time", () => {
  const started: ToolPanelItem[] = [{ id: 1, kind: "user" }, tool(2, "bash"), tool(3, "bash")];
  const first = applyToolEnd(started, { name: "bash", text: "one" });
  assert.equal(cardAt(first, 1).status, "end");
  assert.equal(cardAt(first, 2).status, "start");
  const second = applyToolEnd(first, { name: "bash", text: "two" });
  assert.deepEqual(second.map((item) => item.kind === "tool" && item.card.output), [false, "one", "two"]);
});

test("a late real end wins over inferred flags and preserves empty-result truth", () => {
  const pending = tool(2, "read", "r1");
  if (pending.kind !== "tool") throw new Error("tool fixture");
  pending.card = { ...pending.card, interrupted: true, unconfirmed: true };
  const other = tool(3, "read", "r2");
  if (other.kind !== "tool") throw new Error("tool fixture");
  other.card = { ...other.card, interrupted: true };
  const ended = applyToolEnd([{ id: 1, kind: "user" }, pending, other], {
    name: "read", callId: "r1", text: "", truncated: true,
  });
  const card = cardAt(ended, 1);
  assert.equal(card?.status, "end");
  assert.equal(card?.hasResult, true);
  assert.equal(card?.output, "");
  assert.equal(card?.interrupted, undefined);
  assert.equal(card?.unconfirmed, undefined);
  assert.equal(card?.truncated, true);
  assert.equal(cardAt(ended, 2).interrupted, true);

  const acrossTurns = applyToolEnd([
    ended[0]!,
    ended[1]!,
    { id: 4, kind: "user" },
    ended[2]!,
  ], { name: "read", callId: "r2", text: "late after a new user" });
  assert.equal(cardAt(acrossTurns, 3).status, "end");
  assert.equal(cardAt(acrossTurns, 3).interrupted, undefined);

  const withoutId = tool(6, "read");
  if (withoutId.kind !== "tool") throw new Error("tool fixture");
  withoutId.card = { ...withoutId.card, unconfirmed: true };
  const noIdEnded = applyToolEnd([{ id: 5, kind: "user" }, withoutId], { name: "read", text: "late" });
  assert.equal(cardAt(noIdEnded, 1).status, "end");
  assert.equal(cardAt(noIdEnded, 1).unconfirmed, undefined);

  const oldWithoutId = tool(7, "read");
  const newWithoutId = tool(9, "read");
  const lateAcrossTurns = applyToolEnd([
    { id: 6, kind: "user" },
    oldWithoutId,
    { id: 8, kind: "user" },
    newWithoutId,
  ], { name: "read", text: "old turn result" });
  assert.equal(cardAt(lateAcrossTurns, 1).status, "end");
  assert.equal(cardAt(lateAcrossTurns, 1).output, "old turn result");
  assert.equal(cardAt(lateAcrossTurns, 3).status, "start", "a late end without callId must not claim the new turn's tool");
});

test("connection loss demotes only unresolved running tools without rewriting facts", () => {
  assert.equal(toolEntryStatus({ key: "1", name: "read", status: "start" }, false), "running");
  assert.equal(toolEntryStatus({ key: "1", name: "read", status: "start" }, true), "unconfirmed");
  assert.equal(toolEntryStatus({ key: "1", name: "read", status: "start", interrupted: true }, true), "interrupted");
  assert.equal(toolEntryStatus({ key: "1", name: "read", status: "end", isError: true }, true), "failed");
  assert.equal(toolEntryStatus({ key: "1", name: "read", status: "end", hasResult: false, resultMissing: true }, false), "resultMissing");
});

test("panel toggle is stored only on the anchor tool item", () => {
  const items = [tool(2, "read"), tool(3, "grep")];
  const changed = withToolPanelToggle(items, 2, "collapse");
  assert.equal(changed[0]?.panelToggled, "collapse");
  assert.equal(changed[1]?.panelToggled, undefined);
  assert.equal(withToolPanelToggle(items, 99, "expand"), items);
});
```

- [ ] **Step 2: 运行测试并确认模块不存在/行为未实现**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/toolPanel.spec.ts
```

Expected: FAIL，无法加载 `logic/toolPanel.ts`。

- [ ] **Step 3: 实现纯工具卡 helper 并接入实时事件**

在 `toolPanel.ts` 写入：

```ts
export type PanelToggle = "expand" | "collapse";

export type ToolPanelCard = {
  key: string;
  name: string;
  callId?: string;
  status: "start" | "end";
  args?: string;
  output?: string;
  command?: string;
  hasResult?: boolean;
  truncated?: boolean;
  isError?: boolean;
  interrupted?: boolean;
  unconfirmed?: boolean;
  resultMissing?: boolean;
};

export type ToolPanelItem =
  | { id: number; kind: "tool"; card: ToolPanelCard; panelToggled?: PanelToggle; text?: string }
  | {
      id: number;
      kind: "user" | "assistant" | "thinking" | "todo" | "ask" | "input" | "attachment" | "agent-confirm" | "subagent-run" | "note";
      card?: unknown;
      panelToggled?: PanelToggle;
      text?: string;
      sourceText?: string;
    };

export type ToolEntryStatus = "running" | "done" | "failed" | "interrupted" | "unconfirmed" | "resultMissing";

export function toolPanelCard(item: ToolPanelItem): ToolPanelCard | undefined {
  if (item.kind !== "tool" || item.card === null || typeof item.card !== "object") return undefined;
  return item.card as ToolPanelCard;
}

export function toolEntryStatus(card: ToolPanelCard, connectionLost: boolean): ToolEntryStatus {
  if (card.resultMissing === true) return "resultMissing";
  if (card.status === "end") return card.isError === true ? "failed" : "done";
  if (card.interrupted === true) return "interrupted";
  if (card.unconfirmed === true || connectionLost) return "unconfirmed";
  return "running";
}

function currentTurnStart(items: readonly ToolPanelItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === "user") return index + 1;
  }
  return 0;
}

export function applyToolEnd<T extends ToolPanelItem>(
  items: readonly T[],
  event: { name: string; callId?: string; text?: string; truncated?: boolean; isError?: true },
): T[] {
  // 无 callId 时也从全部条目选择最早同名开始态；迟到终态不能错套到新用户回合。
  let match = -1;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    const card = toolPanelCard(item);
    if (!card || card.status !== "start") continue;
    const matches = event.callId
      ? card.callId === event.callId
      : card.name === event.name;
    if (matches) {
      match = index;
      break;
    }
  }
  if (match < 0) return items as T[];
  const next = items.slice();
  const item = next[match];
  const card = item ? toolPanelCard(item) : undefined;
  if (!item || !card) return items as T[];
  const {
    interrupted: _interrupted,
    unconfirmed: _unconfirmed,
    resultMissing: _resultMissing,
    truncated: _truncated,
    isError: _isError,
    ...preserved
  } = card;
  next[match] = {
    ...item,
    card: {
      ...preserved,
      status: "end",
      hasResult: true,
      output: event.text ?? "",
      ...(event.truncated === true ? { truncated: true } : {}),
      ...(event.isError === true ? { isError: true } : {}),
    },
  } as T;
  return next;
}

export function withToolPanelToggle<T extends ToolPanelItem>(
  items: readonly T[],
  anchorId: number,
  panelToggled: PanelToggle,
): readonly T[] {
  const index = items.findIndex((item) => item.kind === "tool" && item.id === anchorId);
  if (index < 0) return items;
  const current = items[index];
  if (!current || current.panelToggled === panelToggled) return items;
  const next = items.slice();
  next[index] = { ...current, panelToggled };
  return next;
}
```

App 的 `tool/start` card 增加 `...(event.args === undefined ? {} : { args: event.args })`。把整个 `tool/end` 的 `setItems` 更新替换为：

```ts
setItems((prev) => applyToolEnd(prev, event), event.sessionId);
```

- [ ] **Step 4: 运行纯逻辑和既有接线测试**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/toolPanel.spec.ts tests/client-huaanwork/appWiring.spec.ts tests/client-huaanwork/outcomeCheck.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```

Expected: PASS；`turnChecks` 仍直接消费扁平工具卡。

- [ ] **Step 5: 条件式提交**

仅在用户已明确要求提交时执行：

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/tests/client-huaanwork/toolPanel.spec.ts
git commit -m "feat: update tool cards with truthful terminal facts"
```

---

### Task 4: 每回合工具面板纯投影、标题与通用说明

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/toolPanel.spec.ts`

**Interfaces:**
- Consumes: Task 3 `ToolPanelItem`、`ToolPanelCard`、`toolEntryStatus`。
- Produces: `ToolPanelView`、`ToolPanelRow<T>`、`projectToolPanels(items, options)`、`toolDescription(name)`。Task 7 只消费 `ToolPanelView`；Task 8 用 `projectToolPanels` 替换最终消息列表。

- [ ] **Step 1: 写分组、顺序、特殊卡、标题和默认展开测试**

在 `toolPanel.spec.ts` 增加以下测试；`contentItems` 是现有内容视图，附件测试显式用同 id 的 assistant 表示 `attachmentAsAssistant` 的结果：

```ts
import {
  projectToolPanels,
  toolDescription,
  type ToolPanelRow,
  type ToolPanelView,
} from "../../src/client-huaanwork/logic/toolPanel.ts";
import { attachmentAsAssistant } from "../../src/client-huaanwork/logic/runResultAttachments.ts";

const content = (items: readonly ToolPanelItem[]): readonly { id: number; kind: string; text?: string }[] => items;

function panelAt(rows: readonly ToolPanelRow<ToolPanelItem>[], index: number): ToolPanelView {
  const row = rows[index];
  if (row?.kind !== "panel") throw new Error(`expected panel at ${index}`);
  return row.panel;
}

test("projection creates one anchored panel per user turn and preserves every special row", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user", text: "第一回合" },
    { id: 2, kind: "thinking" },
    tool(3, "read"),
    { id: 4, kind: "ask" },
    tool(5, "todo_write"),
    { id: 6, kind: "input" },
    { id: 7, kind: "subagent-run" },
    { id: 8, kind: "todo" },
    { id: 9, kind: "user", text: "第二回合" },
    tool(10, "grep"),
  ];
  const rows = projectToolPanels(items, { contentItems: content(items), connectionLost: false });
  assert.deepEqual(rows.map((row) => row.kind === "panel" ? `panel:${row.id}` : `${row.item.kind}:${row.item.id}`), [
    "user:1", "thinking:2", "panel:3", "ask:4", "input:6", "subagent-run:7", "todo:8", "user:9", "panel:10",
  ]);
  assert.equal(panelAt(rows, 2).tools.length, 2);
  assert.equal(panelAt(rows, 2).tools[1]?.name, "todo_write", "a tool todo_write without event.todos is still a normal tool");
  assert.equal(projectToolPanels([{ id: 1, kind: "user" }], { contentItems: [], connectionLost: false }).length, 1);
});

test("panel titles use the specified priority and connection loss removes running from contention", () => {
  const cards = [
    { key: "1", name: "read", status: "start" as const },
    { key: "2", name: "bash", status: "end" as const, isError: true, hasResult: true },
    { key: "3", name: "read", status: "end" as const, hasResult: false, resultMissing: true },
  ];
  const items: ToolPanelItem[] = [{ id: 1, kind: "user" }, ...cards.map((card, index) => ({ id: index + 2, kind: "tool" as const, card }))];
  const live = projectToolPanels(items, { contentItems: content(items), connectionLost: false });
  assert.equal(panelAt(live, 1).title, "工具 · 执行中 · 3 项调用");
  const lost = projectToolPanels(items, { contentItems: content(items), connectionLost: true });
  assert.equal(panelAt(lost, 1).title, "工具 · 含失败调用 · 3 项调用");
  const onlyMissing = projectToolPanels([items[0]!, items[3]!], { contentItems: [], connectionLost: true });
  assert.equal(panelAt(onlyMissing, 1).title, "工具 · 结果未记录 · 1 项调用");
});

test("visible body, turnFinal, history and manual toggle control default expansion", () => {
  const base: ToolPanelItem[] = [{ id: 1, kind: "user" }, tool(2, "read")];
  const thinkOnly: ToolPanelItem[] = [...base, { id: 3, kind: "assistant", text: "<think>还在想</think>" }];
  const expanded = projectToolPanels(thinkOnly, { contentItems: content(thinkOnly), connectionLost: false });
  assert.equal(panelAt(expanded, 1).expanded, true);
  const visible: ToolPanelItem[] = [...base, { id: 3, kind: "assistant", text: "正文" }];
  const collapsed = projectToolPanels(visible, { contentItems: content(visible), connectionLost: false });
  assert.equal(panelAt(collapsed, 1).expanded, false);

  const attachment = { id: 3, kind: "attachment", sourceText: "运行结果" };
  const attachmentItems: ToolPanelItem[] = [...base, attachment];
  const attachmentRows = projectToolPanels(attachmentItems, {
    contentItems: [...base, attachmentAsAssistant(attachment)], connectionLost: false,
  });
  assert.equal(panelAt(attachmentRows, 1).expanded, false);

  const final = projectToolPanels(base, {
    contentItems: content(base), connectionLost: false, turnFinalByUserId: { 1: true },
  });
  assert.equal(panelAt(final, 1).expanded, false);
  const manual = withToolPanelToggle(base, 2, "expand");
  const overridden = projectToolPanels(manual, {
    contentItems: content(manual), connectionLost: false, turnFinalByUserId: { 1: true },
  });
  assert.equal(panelAt(overridden, 1).expanded, true);
  const manualCollapsed = projectToolPanels(withToolPanelToggle(base, 2, "collapse"), {
    contentItems: content(base), connectionLost: false,
  });
  assert.equal(panelAt(manualCollapsed, 1).expanded, false);

  const endedItems: ToolPanelItem[] = [
    { id: 1, kind: "user" },
    { id: 2, kind: "tool", card: { key: "done", name: "read", status: "end", hasResult: true, output: "ok" } },
  ];
  const endedFinal = projectToolPanels(endedItems, {
    contentItems: content(endedItems), connectionLost: false, turnFinalByUserId: { 1: true },
  });
  assert.equal(panelAt(endedFinal, 1).expanded, false, "all-ended tools without visible body still collapse on turnFinal");
});

test("an active goal round note and later tools reuse the same expanded panel", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user" },
    tool(2, "read"),
    { id: 3, kind: "note", text: "正在按目标继续，第 1/4 轮，这还不是验收结果" },
    tool(4, "grep"),
  ];
  const rows = projectToolPanels(items, { contentItems: content(items), connectionLost: false, turnFinalByUserId: {} });
  assert.equal(rows.filter((row) => row.kind === "panel").length, 1);
  assert.equal(panelAt(rows, 1).expanded, true);
  assert.equal(panelAt(rows, 1).count, 2);
  assert.equal(panelAt(rows, 1).tools.every((tool) => tool.status === "running"), true);
});

test("restored goal round notes keep one collapsed historical panel", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user", text: "完成目标" },
    { id: 2, kind: "tool", card: { key: "r1", name: "read", callId: "r1", status: "end", hasResult: true, output: "第一轮结果" } },
    { id: 3, kind: "note", text: "正在按目标继续，第 1/4 轮，这还不是验收结果" },
    { id: 4, kind: "tool", card: { key: "g1", name: "grep", callId: "g1", status: "end", hasResult: true, output: "续轮结果" } },
  ];
  const rows = projectToolPanels(items, {
    contentItems: content(items), connectionLost: false, turnFinalByUserId: { 1: true },
  });
  assert.equal(rows.filter((row) => row.kind === "panel").length, 1);
  assert.equal(panelAt(rows, 1).count, 2);
  assert.equal(panelAt(rows, 1).expanded, false);
});

test("all currently allowed tool names have closed generic descriptions and unknown names fall back", () => {
  const groups: Array<[readonly string[], string]> = [
    [["read", "read_file"], "正在读取文件"],
    [["glob", "grep"], "正在搜索内容"],
    [["edit", "write", "str_replace_editor"], "正在修改文件"],
    [["bash", "pwsh"], "正在运行命令"],
    [["skill"], "正在执行技能"],
    [["subagent"], "正在调用子代理"],
    [["todo_write"], "正在更新待办"],
    [["get_goal", "create_goal", "update_goal"], "正在处理目标"],
    [["git_status", "git_diff", "git_branch", "git_checkout", "git_commit", "git_push"], "正在执行 Git 操作"],
    [["web_fetch"], "正在读取网页"],
    [["screenshot"], "正在获取截图"],
    [["call_host_tool"], "正在调用宿主工具"],
    [["propose_plan", "exit_plan_mode"], "正在处理计划"],
    [["request_input"], "正在请求输入"],
  ];
  assert.equal(groups.flatMap(([names]) => names).length, 27);
  for (const [names, description] of groups) {
    for (const name of names) assert.equal(toolDescription(name), description, name);
  }
  assert.equal(toolDescription("future_tool"), "正在执行工具");
  assert.equal(toolDescription("read"), "正在读取文件");
});
```

再加完整的六态标题测试：

```ts
test("panel titles cover all six states with the exact Chinese label and count", () => {
  const cases: Array<[ToolPanelCard, string]> = [
    [{ key: "1", name: "read", status: "start" }, "执行中"],
    [{ key: "1", name: "read", status: "end", hasResult: true, isError: true }, "含失败调用"],
    [{ key: "1", name: "read", status: "start", interrupted: true }, "已中断"],
    [{ key: "1", name: "read", status: "start", unconfirmed: true }, "状态未确认"],
    [{ key: "1", name: "read", status: "end", hasResult: false, resultMissing: true }, "结果未记录"],
    [{ key: "1", name: "read", status: "end", hasResult: true, output: "ok" }, "已完成"],
  ];
  for (const [card, label] of cases) {
    const items: ToolPanelItem[] = [{ id: 1, kind: "user" }, { id: 2, kind: "tool", card }];
    assert.equal(panelAt(projectToolPanels(items, { contentItems: content(items), connectionLost: false }), 1).title, `工具 · ${label} · 1 项调用`);
  }
});
```

- [ ] **Step 2: 运行测试并确认投影接口未实现**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/toolPanel.spec.ts
```

Expected: FAIL，`projectToolPanels` 和 `toolDescription` 未导出。

- [ ] **Step 3: 实现完整投影**

在 `toolPanel.ts` 导入 `resolveThinking`，并增加以下类型与函数。`contentItems` 只用于可见正文判断；原始 `items` 用于分组和特殊卡渲染。

```ts
import { resolveThinking } from "./thinkingPanel.ts";

export type ToolEntryView = {
  id: number;
  key: string;
  name: string;
  description: string;
  status: ToolEntryStatus;
  statusText: string;
  args?: string;
  result: string;
  truncated: boolean;
};

export type ToolPanelView = {
  anchorId: number;
  count: number;
  status: ToolEntryStatus;
  title: string;
  expanded: boolean;
  panelToggled: PanelToggle | null;
  tools: ToolEntryView[];
};

export type ToolPanelRow<T extends ToolPanelItem> =
  | { kind: "item"; index: number; item: Exclude<T, { kind: "tool" }> }
  | { kind: "panel"; id: number; panel: ToolPanelView };

export type ToolPanelContentItem = { id: number; kind: string; text?: string };

const DESCRIPTION_GROUPS: Array<[readonly string[], string]> = [
  [["read", "read_file"], "正在读取文件"],
  [["glob", "grep"], "正在搜索内容"],
  [["edit", "write", "str_replace_editor"], "正在修改文件"],
  [["bash", "pwsh"], "正在运行命令"],
  [["skill"], "正在执行技能"],
  [["subagent"], "正在调用子代理"],
  [["todo_write"], "正在更新待办"],
  [["get_goal", "create_goal", "update_goal"], "正在处理目标"],
  [["git_status", "git_diff", "git_branch", "git_checkout", "git_commit", "git_push"], "正在执行 Git 操作"],
  [["web_fetch"], "正在读取网页"],
  [["screenshot"], "正在获取截图"],
  [["call_host_tool"], "正在调用宿主工具"],
  [["propose_plan", "exit_plan_mode"], "正在处理计划"],
  [["request_input"], "正在请求输入"],
];

const DESCRIPTIONS = new Map(DESCRIPTION_GROUPS.flatMap(([names, description]) => names.map((name) => [name, description] as const)));
const STATUS_TEXT: Record<ToolEntryStatus, string> = {
  running: "运行中",
  done: "完成",
  failed: "失败",
  interrupted: "已中断",
  unconfirmed: "状态未确认",
  resultMissing: "结果未记录",
};
const PANEL_TEXT: Record<ToolEntryStatus, string> = {
  running: "执行中",
  done: "已完成",
  failed: "含失败调用",
  interrupted: "已中断",
  unconfirmed: "状态未确认",
  resultMissing: "结果未记录",
};
const STATUS_PRIORITY: readonly ToolEntryStatus[] = ["running", "failed", "interrupted", "unconfirmed", "resultMissing", "done"];

export function toolDescription(name: string): string {
  return DESCRIPTIONS.get(name) ?? "正在执行工具";
}

function toolEntryView(id: number, card: ToolPanelCard, connectionLost: boolean): ToolEntryView {
  const status = toolEntryStatus(card, connectionLost);
  const result = status === "resultMissing"
    ? "历史记录未保存结果"
    : status === "running"
      ? "等待执行结果"
      : status === "interrupted" || status === "unconfirmed"
        ? STATUS_TEXT[status]
        : card.hasResult === true && card.output
          ? card.output
          : "无输出";
  return {
    id,
    key: card.key,
    name: card.name,
    description: toolDescription(card.name),
    status,
    statusText: STATUS_TEXT[status],
    ...(card.args === undefined ? {} : { args: card.args }),
    result,
    truncated: card.truncated === true,
  };
}

export function projectToolPanels<T extends ToolPanelItem>(
  items: readonly T[],
  options: {
    contentItems: readonly ToolPanelContentItem[];
    turnFinalByUserId?: Readonly<Record<number, boolean>>;
    connectionLost: boolean;
  },
): ToolPanelRow<T>[] {
  type Segment = { start: number; end: number; userId?: number; final: boolean };
  const segments: Segment[] = [];
  let start = 0;
  let userId: number | undefined;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item?.kind !== "user") continue;
    if (index > start || userId !== undefined) segments.push({ start, end: index, userId, final: true });
    start = index;
    userId = item.id;
  }
  segments.push({
    start,
    end: items.length,
    userId,
    final: userId !== undefined && options.turnFinalByUserId?.[userId] === true,
  });

  const rows: ToolPanelRow<T>[] = [];
  for (const segment of segments) {
    const ids = new Set<number>();
    const toolIndexes: number[] = [];
    for (let index = segment.start; index < segment.end; index += 1) {
      const item = items[index];
      if (!item) continue;
      ids.add(item.id);
      if (item.kind === "tool") toolIndexes.push(index);
    }
    const hasVisibleAssistant = options.contentItems.some((item) =>
      ids.has(item.id)
      && item.kind === "assistant"
      && resolveThinking({ reasoning: "", assistantText: item.text ?? "" }).visible.trim().length > 0
    );
    const anchorIndex = toolIndexes[0];
    for (let index = segment.start; index < segment.end; index += 1) {
      const item = items[index];
      if (!item) continue;
      if (index === anchorIndex) {
        const anchor = item;
        const tools = toolIndexes.flatMap((toolIndex) => {
          const source = items[toolIndex];
          const card = source ? toolPanelCard(source) : undefined;
          return source && card ? [toolEntryView(source.id, card, options.connectionLost)] : [];
        });
        const statuses = tools.map((tool) => tool.status);
        const status = STATUS_PRIORITY.find((candidate) => statuses.includes(candidate)) ?? "done";
        const panelToggled = anchor.panelToggled ?? null;
        rows.push({
          kind: "panel",
          id: anchor.id,
          panel: {
            anchorId: anchor.id,
            count: tools.length,
            status,
            title: `工具 · ${PANEL_TEXT[status]} · ${tools.length} 项调用`,
            expanded: panelToggled === "expand"
              ? true
              : panelToggled === "collapse"
                ? false
                : !segment.final && !hasVisibleAssistant,
            panelToggled,
            tools,
          },
        });
        continue;
      }
      if (item.kind === "tool") continue;
      rows.push({ kind: "item", index, item: item as Exclude<T, { kind: "tool" }> });
    }
  }
  return rows;
}
```

- [ ] **Step 4: 运行纯逻辑测试与类型检查**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/toolPanel.spec.ts tests/client-huaanwork/thinkingPanel.spec.ts tests/client-huaanwork/runResultAttachments.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```

Expected: PASS；27 个工具名全部逐项断言，附件/think 可见正文口径与现有思考面板一致。

- [ ] **Step 5: 条件式提交**

仅在用户已明确要求提交时执行：

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts dsh-plugin-huaanwork/tests/client-huaanwork/toolPanel.spec.ts
git commit -m "feat: project per-turn tool panels"
```

---

### Task 5: `turnFinal` 纯状态机与按标签原子结算

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/toolPanel.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/goalRound.spec.ts`

**Interfaces:**
- Consumes: 现有 `GoalPhase`、`GoalTurnAction`、`reduceGoalTurn`。
- Produces: `TurnFinalEvent`、`reduceTurnFinal(current, event, phase)`、`applyTurnFinalToTabs(tabs, tabId, event, phase)`、`historicalTurnFinalByUserId(items)`。Task 6 将这些函数接到真实 App 事件。

- [ ] **Step 1: 写结束顺序、幂等和当前回合边界测试**

在 `toolPanel.spec.ts` 增加：

```ts
import { INITIAL_GOAL_TURN_STATE, reduceGoalTurn, type GoalTurnEvent, type GoalTurnState } from "../../src/client-huaanwork/logic/goalRound.ts";
import {
  applyTurnFinalToTabs,
  historicalTurnFinalByUserId,
  reduceTurnFinal,
  type TurnFinalEvent,
} from "../../src/client-huaanwork/logic/toolPanel.ts";

test("turnFinal is monotonic and active continuation ends stay non-final", () => {
  assert.equal(reduceTurnFinal(undefined, { kind: "session-end", ok: true, cancelled: false }, "active"), false);
  for (const phase of [undefined, "paused", "blocked", "complete"] as const) {
    assert.equal(reduceTurnFinal(undefined, { kind: "session-end", ok: true, cancelled: false }, phase), true);
  }
  assert.equal(reduceTurnFinal(undefined, { kind: "session-end", ok: false, cancelled: false }, "active"), true);
  assert.equal(reduceTurnFinal(undefined, { kind: "session-end", ok: true, cancelled: true }, "active"), true);
  assert.equal(reduceTurnFinal(true, { kind: "session-end", ok: true, cancelled: false }, "active"), true);
  assert.equal(reduceTurnFinal(true, { kind: "goal-action", action: { kind: "none" } }, undefined), true);
});

test("real goal actions settle completeFirst and endFirst without requiring a second session end", () => {
  for (const order of ["completeFirst", "endFirst"] as const) {
    let state: GoalTurnState = INITIAL_GOAL_TURN_STATE;
    let final = false;
    const events: GoalTurnEvent[] = order === "completeFirst"
      ? [
          { kind: "turn-started", sessionId: "s" },
          { kind: "goal-state", phase: "active", sessionId: "s" },
          { kind: "goal-state", phase: "complete", sessionId: "s" },
          { kind: "session-end", sessionId: "s", ok: true },
        ]
      : [
          { kind: "turn-started", sessionId: "s" },
          { kind: "goal-state", phase: "active", sessionId: "s" },
          { kind: "session-end", sessionId: "s", ok: true },
          { kind: "goal-state", phase: "complete", sessionId: "s" },
          { kind: "goal-state", phase: "complete", sessionId: "s" },
          { kind: "session-end", sessionId: "s", ok: true },
        ];
    const observed: boolean[] = [];
    for (const event of events) {
      const result = reduceGoalTurn(state, event);
      state = result.state;
      const input: TurnFinalEvent = event.kind === "session-end"
        ? { kind: "session-end", ok: event.ok, cancelled: event.cancelled === true }
        : event.kind === "goal-state" || event.kind === "goal-round-limit"
          ? { kind: "goal-action", action: result.action }
          : { kind: "goal-action", action: { kind: "none" } };
      final = reduceTurnFinal(final, input, state.phases[event.sessionId ?? ""]);
      observed.push(final);
    }
    if (order === "endFirst") {
      assert.equal(observed[2], false, "active intermediate end does not settle");
      assert.equal(observed[3], true, "the actual complete outcome settles immediately");
    }
    assert.equal(final, true);
    assert.equal(observed.at(-1), true, "later duplicate events never reopen the turn");
  }
});

test("tab settlement interrupts or unconfirms only the current turn on the owning tab", () => {
  const oldTool = tool(2, "bash", "old");
  const doneTool = tool(4, "read", "done");
  const pendingTool = tool(5, "bash", "pending");
  if (doneTool.kind === "tool") doneTool.card = { ...doneTool.card, status: "end", hasResult: true, output: "kept" };
  const tabs = [
    { id: "a", items: [{ id: 1, kind: "user" } as ToolPanelItem, oldTool, { id: 3, kind: "user" } as ToolPanelItem, doneTool, pendingTool] },
    { id: "b", items: [{ id: 11, kind: "user" } as ToolPanelItem, tool(12, "bash")] },
  ];
  const cancelled = applyTurnFinalToTabs(tabs, "a", { kind: "session-end", ok: false, cancelled: false }, "active");
  assert.deepEqual(cancelled[0]?.turnFinalByUserId, { 3: true });
  assert.equal(cardAt(cancelled[0]!.items, 1).interrupted, undefined);
  assert.equal(cardAt(cancelled[0]!.items, 3).output, "kept");
  assert.equal(cardAt(cancelled[0]!.items, 4).interrupted, true);
  assert.equal(cancelled[1], tabs[1], "background tab is untouched");

  const active = applyTurnFinalToTabs(tabs, "a", { kind: "session-end", ok: true, cancelled: false }, "active");
  assert.equal(active, tabs, "active intermediate end neither stores final nor marks tools");
  const normal = applyTurnFinalToTabs(tabs, "a", { kind: "session-end", ok: true, cancelled: false }, undefined);
  assert.equal(cardAt(normal[0]!.items, 4).unconfirmed, true);
  assert.equal(cardAt(normal[0]!.items, 4).interrupted, undefined);
});

test("history seed marks every restored user turn final", () => {
  assert.deepEqual(historicalTurnFinalByUserId([{ id: 1, kind: "user" }, tool(2, "read"), { id: 3, kind: "user" }]), { 1: true, 3: true });
});
```

- [ ] **Step 2: 运行测试并确认接口未实现**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/toolPanel.spec.ts tests/client-huaanwork/goalRound.spec.ts
```

Expected: FAIL，三个新函数未导出；既有 `goalRound` 测试本身应保持 PASS。

- [ ] **Step 3: 实现单调 final 与原子 tab 更新**

在 `toolPanel.ts` 导入 goal 类型并增加：

```ts
import type { GoalPhase, GoalTurnAction } from "./goalRound.ts";

export type TurnFinalEvent =
  | { kind: "session-end"; ok: boolean; cancelled: boolean }
  | { kind: "goal-action"; action: GoalTurnAction };

export function reduceTurnFinal(
  current: boolean | undefined,
  event: TurnFinalEvent,
  phase: GoalPhase | undefined,
): boolean {
  if (current === true) return true;
  if (event.kind === "goal-action") return event.action.kind !== "none";
  if (!event.ok || event.cancelled) return true;
  return phase !== "active";
}

function finalizeTurnTools<T extends ToolPanelItem>(items: readonly T[], mode: "interrupted" | "unconfirmed"): T[] {
  const start = currentTurnStart(items);
  let changed = false;
  const next = items.map((item, index) => {
    const card = index >= start ? toolPanelCard(item) : undefined;
    if (!card || card.status !== "start") return item;
    if (mode === "interrupted") {
      if (card.interrupted === true) return item;
      changed = true;
      const { unconfirmed: _unconfirmed, ...preserved } = card;
      return { ...item, card: { ...preserved, interrupted: true } } as T;
    }
    if (card.interrupted === true || card.unconfirmed === true) return item;
    changed = true;
    return { ...item, card: { ...card, unconfirmed: true } } as T;
  });
  return changed ? next : items as T[];
}

export function applyTurnFinalToTabs<
  I extends ToolPanelItem,
  T extends { id: string; items: I[]; turnFinalByUserId?: Readonly<Record<number, boolean>> },
>(
  tabs: readonly T[],
  tabId: string | undefined,
  event: TurnFinalEvent,
  phase: GoalPhase | undefined,
): T[] {
  if (!tabId) return tabs as T[];
  const tab = tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return tabs as T[];
  let userId: number | undefined;
  for (let index = tab.items.length - 1; index >= 0; index -= 1) {
    if (tab.items[index]?.kind === "user") {
      userId = tab.items[index]?.id;
      break;
    }
  }
  if (userId === undefined) return tabs as T[];
  const wasFinal = tab.turnFinalByUserId?.[userId] === true;
  const final = reduceTurnFinal(wasFinal, event, phase);
  if (!final) return tabs as T[];
  const items = wasFinal
    ? tab.items
    : finalizeTurnTools(tab.items, event.kind === "session-end" && (!event.ok || event.cancelled) ? "interrupted" : "unconfirmed");
  if (wasFinal && items === tab.items) return tabs as T[];
  return tabs.map((candidate) => candidate.id === tabId
    ? {
        ...candidate,
        items,
        turnFinalByUserId: { ...candidate.turnFinalByUserId, [userId]: true },
      }
    : candidate);
}

export function historicalTurnFinalByUserId(items: readonly { id: number; kind: string }[]): Record<number, true> {
  return Object.fromEntries(items.flatMap((item) => item.kind === "user" ? [[item.id, true] as const] : []));
}
```

不得用 `turnActive` 或工具 `start` 数量推导 final；不得把 `resultMissing` 与 `unconfirmed` 互换。

- [ ] **Step 4: 运行纯状态与既有 goal 测试**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/toolPanel.spec.ts tests/client-huaanwork/goalRound.spec.ts tests/client-huaanwork/outcomeCheck.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```

Expected: PASS；`completeFirst/endFirst`、重复 complete 和后续结束均幂等。

- [ ] **Step 5: 条件式提交**

仅在用户已明确要求提交时执行：

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts dsh-plugin-huaanwork/tests/client-huaanwork/toolPanel.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/goalRound.spec.ts
git commit -m "feat: settle tool panel turns on real goal edges"
```

---

### Task 6: App 回合结算、断连回合条与历史 final 接线

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/turnStatus.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/turnStatus.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/outcomeCheck.spec.ts`

**Interfaces:**
- Consumes: Task 5 的 final helper、真实 `noteGoalEvent` 动作、`targetTabFor` 和 `goalTurnRef.current.phases`。
- Produces: `runningToolName(items, connectionLost)`、`toolsUnconfirmed(items, connectionLost)`；`turnStatus` 新增可选 `toolsUnconfirmed` 输入；App 的 `showTurnLine` 在断连且 `turnActive=false` 时仍可见。

- [ ] **Step 1: 写回合条、命令核对并列和 App 接线失败测试**

在 `turnStatus.spec.ts` 增加：

```ts
import { runningToolName, toolsUnconfirmed, type ToolPanelItem } from "../../src/client-huaanwork/logic/toolPanel.ts";

test("unconfirmed tools have a dedicated status and never fall back to running or thinking", () => {
  assert.deepEqual(
    turnStatus({ latest: "reasoning", runningTool: null, toolsUnconfirmed: true, quietMs: 0 }),
    { text: "工具状态未确认", alert: false },
  );
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user" },
    { id: 2, kind: "tool", card: { key: "a", name: "bash", status: "start" } },
    { id: 3, kind: "tool", card: { key: "b", name: "read", status: "start", interrupted: true } },
  ];
  assert.equal(runningToolName(items, true), null);
  assert.equal(toolsUnconfirmed(items, true), true);
  assert.equal(runningToolName(items, false), "bash");
  const inferred = items.map((item) => item.kind === "tool"
    ? { ...item, card: { ...item.card, unconfirmed: true } }
    : item);
  assert.equal(runningToolName(inferred, false), null);
  assert.equal(toolsUnconfirmed(inferred, false), true);
});
```

在 `outcomeCheck.spec.ts` 增加，生产核对算法不改：

```ts
test("interrupted and unconfirmed required commands remain not-pass alongside panel states", () => {
  for (const flag of ["interrupted", "unconfirmed"] as const) {
    const checks = turnChecks([
      { kind: "user", text: "跑 `pnpm test`" },
      { kind: "tool", card: { name: "bash", command: "pnpm test", status: "start", [flag]: true } },
    ]);
    assert.deepEqual(turnOutcomeNotes(checks, []), ["命令未通过：pnpm test"]);
  }
});
```

在 `appWiring.spec.ts` 增加以下导入、真实 `endFirst` goal action 序列与静态接线钉；行为断言必须消费 `reduceGoalTurn` 的实际返回动作：

```ts
import {
  INITIAL_GOAL_TURN_STATE,
  reduceGoalTurn,
  type GoalTurnEvent,
  type GoalTurnState,
} from "../../src/client-huaanwork/logic/goalRound.ts";
import { reduceTurnFinal, type TurnFinalEvent } from "../../src/client-huaanwork/logic/toolPanel.ts";

test("App turn final wiring consumes actual goal actions and sidecarDead only", () => {
  let state: GoalTurnState = INITIAL_GOAL_TURN_STATE;
  let final = false;
  const observed: boolean[] = [];
  const events: GoalTurnEvent[] = [
    { kind: "turn-started", sessionId: "s" },
    { kind: "goal-state", phase: "active", sessionId: "s" },
    { kind: "session-end", sessionId: "s", ok: true },
    { kind: "goal-state", phase: "complete", sessionId: "s" },
  ];
  for (const event of events) {
    const result = reduceGoalTurn(state, event);
    state = result.state;
    const input: TurnFinalEvent = event.kind === "session-end"
      ? { kind: "session-end", ok: event.ok, cancelled: event.cancelled === true }
      : { kind: "goal-action", action: result.action };
    final = reduceTurnFinal(final, input, state.phases[event.sessionId ?? ""]);
    observed.push(final);
  }
  assert.deepEqual(observed, [false, false, false, true], "only the real complete outcome settles endFirst");

  assert.match(APP_SOURCE, /applyTurnFinalToTabs\(prev, tabId, event, goalTurnRef\.current\.phases\[sessionId \?\? ""\]\)/);
  assert.equal((APP_SOURCE.match(/applyFinalForTab\(targetTabFor\(/g) ?? []).length, 3);
  assert.match(APP_SOURCE, /setItems\(\(prev\) => applyToolEnd\(prev, event\), event\.sessionId\)/);
  assert.match(APP_SOURCE, /applyFinalForTab\(tabId, ticket\.sessionId, \{ kind: "session-end", ok: false, cancelled: true \}\)/);
  assert.match(APP_SOURCE, /kind: "goal-action", action/);
  assert.match(APP_SOURCE, /kind: "session-end", ok: event\.ok, cancelled: event\.cancelled === true \|\| userStopped/);
  assert.match(APP_SOURCE, /runningToolName\(items, sidecarDead\)/);
  assert.match(APP_SOURCE, /toolsUnconfirmed\(items, sidecarDead\)/);
  assert.match(APP_SOURCE, /hasActiveChild \|\| unconfirmedTools \|\| \(turnActive && turnPulse\.tabId === activeChat\.id\)/);
  assert.doesNotMatch(APP_SOURCE, /runningToolName\(items, hostPhase\)/);

  const exitAt = APP_SOURCE.indexOf("await onSidecarExit((payload) => {");
  const exitEnd = APP_SOURCE.indexOf("hostExitNotice(hostStoppedByUserRef.current)", exitAt);
  assert.ok(exitAt >= 0 && exitEnd > exitAt);
  const exitBody = APP_SOURCE.slice(exitAt, exitEnd);
  assert.match(exitBody, /setSidecarDead\(true\)/);
  assert.doesNotMatch(exitBody, /applyTurnFinal|applyFinalForTab|turnFinalByUserId/);
});

test("all three history consumers seed final turns and read-only history is not projected", () => {
  assert.equal((APP_SOURCE.match(/historicalTurnFinalByUserId\(items\)/g) ?? []).length, 3);
  const history = readFileSync(new URL("../../src/client-huaanwork/HistoryDetailPane.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(history, /ToolPanel|projectToolPanels/);
});
```

同时把既有 `resuming an existing session tab...` 测试中的 `/items: historyToChatItems\(view\)/` 改为 `/\bitems,/`，保留 `historyToChatItems(view)` 在新标签分支只计算一次的断言；这项修改是为复用同一 items 计算 final map，不是放宽“已有标签不得回放”的约束。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/turnStatus.spec.ts tests/client-huaanwork/outcomeCheck.spec.ts tests/client-huaanwork/appWiring.spec.ts
```

Expected: FAIL，新 helper/输入不存在，App 尚未传入真实 action 和 `sidecarDead`。

- [ ] **Step 3: 实现状态 helper 与真实 App 接线**

在 `toolPanel.ts` 增加：

```ts
export function runningToolName(items: readonly ToolPanelItem[], connectionLost: boolean): string | null {
  const start = currentTurnStart(items);
  for (let index = items.length - 1; index >= start; index -= 1) {
    const item = items[index];
    const card = item ? toolPanelCard(item) : undefined;
    if (card && toolEntryStatus(card, connectionLost) === "running") return card.name;
  }
  return null;
}

export function toolsUnconfirmed(items: readonly ToolPanelItem[], connectionLost: boolean): boolean {
  const start = currentTurnStart(items);
  return items.some((item, index) => {
    const card = index >= start ? toolPanelCard(item) : undefined;
    return card !== undefined && toolEntryStatus(card, connectionLost) === "unconfirmed";
  });
}
```

`turnStatus.ts` 的输入增加 `toolsUnconfirmed?: boolean`，并在 runningTool 分支之前加入：

```ts
if (input.toolsUnconfirmed === true) {
  return { text: "工具状态未确认", alert: input.quietMs >= ALERT_MS };
}
```

在 App 组件内新增一个可供 effect 与停止流程共同调用的函数：

```ts
function applyFinalForTab(tabId: string | undefined, sessionId: string | undefined, event: TurnFinalEvent) {
  if (!tabId) return;
  setChatTabs((prev) => applyTurnFinalToTabs(prev, tabId, event, goalTurnRef.current.phases[sessionId ?? ""]));
}
```

在 `applyEvent` 的三个既有分支中，先取得 `noteGoalEvent` 的真实 action，再调用 final helper，然后保留既有 outcome 行为：

```ts
// goal/state，在 if (action.kind === "outcome") 之前
applyFinalForTab(targetTabFor(event.sessionId), event.sessionId, { kind: "goal-action", action });

// goal/round-limit，在 if (action.kind === "goal-stopped") 之前
applyFinalForTab(targetTabFor(eventSessionId), eventSessionId, { kind: "goal-action", action });

// session/end，在 if (action.kind === "outcome") 之前
applyFinalForTab(targetTabFor(eventSessionId), eventSessionId, {
  kind: "session-end",
  ok: event.ok,
  cancelled: event.cancelled === true || userStopped,
});
```

在 `settleStop` 已成功取消且 `settled.arm && tabId` 的现有分支中，先用同一 helper 结算用户停止，再保留 `interruptTurnItems` 与“已停止”note：

```ts
applyFinalForTab(tabId, ticket.sessionId, { kind: "session-end", ok: false, cancelled: true });
```

在 App 渲染派生处改为：

```ts
const unconfirmedTools = toolsUnconfirmed(items, sidecarDead);
const showTurnLine = hasActiveChild || unconfirmedTools || (turnActive && turnPulse.tabId === activeChat.id);
const turnLine = parentTurnLine({
  hasActiveChild,
  current: turnStatus({
    latest: turnPulse.latest,
    runningTool: runningToolName(items, sidecarDead),
    toolsUnconfirmed: unconfirmedTools,
    quietMs: Math.max(0, now - turnPulse.at),
  }),
});
```

删除 App 底部旧的本地 `runningToolName`，改从 `toolPanel.ts` 导入新 helper。

在三处历史消费点给回填 items 计算 `historicalTurnFinalByUserId(items)`：
1. `selectSubtask` 新标签增加 `turnFinalByUserId: historicalTurnFinalByUserId(items)`。
2. 运行记录回填的 `setChatTabs` 同时写 `turnFinalByUserId: historicalTurnFinalByUserId(items)`。
3. `resumeFromView` 新标签先只计算一次 `const items = historyToChatItems(view)`，再写 `items` 和同一 final map；已有标签分支不得回放历史或覆盖 final map。

- [ ] **Step 4: 运行接线、goal、思考和核对测试**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/appWiring.spec.ts tests/client-huaanwork/turnStatus.spec.ts tests/client-huaanwork/outcomeCheck.spec.ts tests/client-huaanwork/goalRound.spec.ts tests/client-huaanwork/thinkingPanel.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```

Expected: PASS；目标续轮、取消、后台标签和既有 22 个顶层 App 接线测试（其中 17 个读取 `APP_SOURCE`）不回归。

- [ ] **Step 5: 条件式提交**

仅在用户已明确要求提交时执行：

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/turnStatus.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/turnStatus.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/outcomeCheck.spec.ts
git commit -m "feat: wire tool panel turn and connection states"
```

---

### Task 7: `ToolPanel` 组件、可访问性与样式

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/ToolPanel.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/styles.css`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/styles.generated.ts`（生成）
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/ToolPanel.spec.ts`

**Interfaces:**
- Consumes: Task 4 `ToolPanelView`。
- Produces: 默认导出 `ToolPanel({ panel, onToggle })`；`onToggle(anchorId, next)` 由 App 持久化；单项展开只存在组件内 `Set<number>`。

- [ ] **Step 1: 写 jsdom 组件与样式失败测试**

新建 `ToolPanel.spec.ts`，首行使用 `// @vitest-environment jsdom`。先写以下完整 Harness；panel 由生产投影生成，避免测试复制状态规则：

```tsx
import { act, createElement, useState } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ToolPanel from "../../src/client-huaanwork/ToolPanel.tsx";
import {
  projectToolPanels,
  type PanelToggle,
  type ToolPanelCard,
  type ToolPanelItem,
  type ToolPanelView,
} from "../../src/client-huaanwork/logic/toolPanel.ts";

const START_READ: ToolPanelCard = { key: "read", name: "read", status: "start" };
const START_GREP: ToolPanelCard = { key: "grep", name: "grep", status: "start" };

function panelFor(cards: readonly ToolPanelCard[], panelToggled: PanelToggle | null = null): ToolPanelView {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user" },
    ...cards.map((card, index) => ({ id: index + 2, kind: "tool" as const, card })),
  ];
  if (panelToggled && items[1]?.kind === "tool") items[1] = { ...items[1], panelToggled };
  const rows = projectToolPanels(items, {
    contentItems: items,
    connectionLost: false,
    turnFinalByUserId: panelToggled ? { 1: true } : undefined,
  });
  const row = rows[1];
  if (row?.kind !== "panel") throw new Error("expected one panel");
  return row.panel;
}

function Harness(): ReactElement {
  const [toggle, setToggle] = useState<PanelToggle | null>(null);
  return createElement(ToolPanel, {
    panel: panelFor([START_READ, START_GREP], toggle),
    onToggle: (_anchorId: number, next: PanelToggle) => setToggle(next),
  });
}

const DETAIL_CARDS: readonly ToolPanelCard[] = [
  START_READ,
  { key: "empty", name: "read", status: "end", hasResult: true, output: "" },
  { key: "missing", name: "read", status: "end", hasResult: false, resultMissing: true },
  { key: "failed", name: "bash", status: "end", hasResult: true, output: "bad", isError: true },
  { key: "truncated", name: "read", status: "end", hasResult: true, output: "<img src=x onerror=alert(1)>", truncated: true },
  { key: "interrupted", name: "bash", status: "start", interrupted: true },
  { key: "unconfirmed", name: "read", status: "start", unconfirmed: true },
];

function StaticPanelHarness(): ReactElement {
  return createElement(ToolPanel, { panel: panelFor(DETAIL_CARDS), onToggle: () => undefined });
}

function TransitionHarness({ status, count = 1 }: { status: "running" | "done"; count?: number }): ReactElement {
  const card: ToolPanelCard = status === "running"
    ? START_READ
    : { key: "done", name: "read", status: "end", hasResult: true, output: "ok" };
  const cards = Array.from({ length: count }, (_, index) => ({ ...card, key: `${card.key}-${index}` }));
  return createElement(ToolPanel, { panel: panelFor(cards), onToggle: () => undefined });
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function mount(element: ReactElement): Promise<HTMLDivElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(element); });
  return container;
}

async function rerender(element: ReactElement): Promise<void> {
  await act(async () => { root!.render(element); });
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => { button.click(); });
}

function buttonByClass(view: ParentNode, className: string): HTMLButtonElement {
  const button = view.querySelector<HTMLButtonElement>(`button.${className}`);
  if (!button) throw new Error(`button not found: ${className}`);
  return button;
}

function statusRegion(view: ParentNode): HTMLElement {
  const region = view.querySelector<HTMLElement>('[role="status"]');
  if (!region) throw new Error("status region not found");
  return region;
}

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
});
```

在相同文件中覆盖：

```ts
it("toggles the controlled panel and independently expands multiple tool details", async () => {
  const view = await mount(createElement(Harness));
  const title = buttonByClass(view, "tool-panel-title");
  expect(title.getAttribute("aria-expanded")).toBe("true");
  title.focus();
  expect(document.activeElement).toBe(title);
  await click(title); // 原生 button 的 click 与 Enter/Space 共用 activation behavior；真机任务另走实际键盘。
  expect(buttonByClass(view, "tool-panel-title").getAttribute("aria-expanded")).toBe("false");
  await click(buttonByClass(view, "tool-panel-title"));
  const entries = view.querySelectorAll<HTMLButtonElement>(".tool-panel-entry-title");
  expect(entries).toHaveLength(2);
  await click(entries[0]!);
  await click(entries[1]!);
  expect(entries[0]?.getAttribute("aria-expanded")).toBe("true");
  expect(entries[1]?.getAttribute("aria-expanded")).toBe("true");
  expect(view.querySelectorAll(".tool-panel-detail")).toHaveLength(2);
  expect(view.textContent).toContain("未记录参数");
});

it("renders waiting, empty, missing, failed, truncated, interrupted and unconfirmed results as plain text", async () => {
  const view = await mount(createElement(StaticPanelHarness));
  for (const entry of view.querySelectorAll<HTMLButtonElement>(".tool-panel-entry-title")) await click(entry);
  expect(view.textContent).toContain("等待执行结果");
  expect(view.textContent).toContain("无输出");
  expect(view.textContent).toContain("历史记录未保存结果");
  expect(view.textContent).toContain("失败");
  expect(view.textContent).toContain("已截断");
  expect(view.textContent).toContain("已中断");
  expect(view.textContent).toContain("状态未确认");
  expect(view.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(view.querySelector("img")).toBeNull();
  expect(view.querySelector("script")).toBeNull();
});

it("keeps one status region and announces only title transitions", async () => {
  const view = await mount(createElement(TransitionHarness, { status: "running" }));
  const region = statusRegion(view);
  expect(region.textContent).toBe("");
  await rerender(createElement(TransitionHarness, { status: "running" }));
  expect(statusRegion(view)).toBe(region);
  expect(region.textContent).toBe("");
  await rerender(createElement(TransitionHarness, { status: "done" }));
  expect(statusRegion(view)).toBe(region);
  expect(region.textContent).toBe("工具 · 已完成 · 1 项调用");
  await rerender(createElement(TransitionHarness, { status: "done" }));
  expect(region.textContent).toBe("工具 · 已完成 · 1 项调用");
  await rerender(createElement(TransitionHarness, { status: "done", count: 2 }));
  expect(buttonByClass(view, "tool-panel-title").textContent).toBe("工具 · 已完成 · 2 项调用");
  expect(region.textContent).toBe("工具 · 已完成 · 1 项调用", "a count-only change is not a new status announcement");
});
```

样式契约直接读取 `styles.css` 的 `/* ---- 工具面板 ---- */` 段，并加入真实断言：

```ts
it("caps long content inside a scrollable tokenized panel body", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../../src/client-huaanwork/styles.css"), "utf8");
  const section = css.split("/* ---- 工具面板 ---- */")[1]?.split("/* ----")[0] ?? "";
  expect(section).toContain(".tool-panel-body");
  expect(section).toContain("max-height: 40vh");
  expect(section).toContain("overflow: auto");
  expect(section).toContain("white-space: pre-wrap");
  expect(section).toContain("overflow-wrap: anywhere");
  expect(section).toContain(".tool-panel-entry-title:focus-visible");
  expect(section).not.toMatch(/#[0-9a-f]{3,8}\b/i);
});
```

- [ ] **Step 2: 运行组件测试并确认失败**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/ToolPanel.spec.ts
```

Expected: FAIL，`ToolPanel.tsx` 和样式段不存在。

- [ ] **Step 3: 实现组件和 CSS**

`ToolPanel.tsx` 使用以下完整结构（Harness 通过父状态更新 `panel.panelToggled/expanded`）：

```tsx
import { useEffect, useRef, useState } from "react";
import type { PanelToggle, ToolPanelView } from "./logic/toolPanel.ts";

export default function ToolPanel({
  panel,
  onToggle,
}: {
  panel: ToolPanelView;
  onToggle: (anchorId: number, next: PanelToggle) => void;
}) {
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<number>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  const previousStatus = useRef(panel.status);
  useEffect(() => {
    if (previousStatus.current === panel.status) return;
    previousStatus.current = panel.status;
    setAnnouncement(panel.title);
  }, [panel.status, panel.title]);

  const toggleTool = (id: number) => {
    setExpandedTools((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className={`tool-panel tool-panel-${panel.status}`}>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
      <button
        type="button"
        className="tool-panel-title"
        aria-expanded={panel.expanded}
        aria-controls={`tool-panel-body-${panel.anchorId}`}
        onClick={() => onToggle(panel.anchorId, panel.expanded ? "collapse" : "expand")}
      >
        {panel.title}
      </button>
      {panel.expanded ? (
        <div className="tool-panel-body" id={`tool-panel-body-${panel.anchorId}`}>
          {panel.tools.map((tool) => {
            const expanded = expandedTools.has(tool.id);
            const detailId = `tool-detail-${panel.anchorId}-${tool.id}`;
            return (
              <div className="tool-panel-entry" key={tool.id}>
                <button
                  type="button"
                  className="tool-panel-entry-title"
                  aria-expanded={expanded}
                  aria-controls={detailId}
                  onClick={() => toggleTool(tool.id)}
                >
                  <span>{tool.description}</span>
                  <code>{tool.name}</code>
                  <span className={`tool-entry-status tool-entry-${tool.status}`}>{tool.statusText}</span>
                  {tool.truncated ? <span className="badge">已截断</span> : null}
                </button>
                {expanded ? (
                  <div className="tool-panel-detail" id={detailId}>
                    <h4>参数</h4>
                    <pre>{tool.args?.trim() ? tool.args : "未记录参数"}</pre>
                    <h4>结果</h4>
                    <pre>{tool.result}</pre>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
```

在 `styles.css` 新增独立段，不复用 `.tool-row`：

```css
/* ---- 工具面板 ---- */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.tool-panel {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
}
.tool-panel-title,
.tool-panel-entry-title {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  text-align: left;
}
.tool-panel-entry-title:focus-visible,
.tool-panel-title:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.tool-panel-body {
  max-height: 40vh;
  overflow: auto;
}
.tool-panel-detail pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.tool-entry-failed,
.tool-panel-failed .tool-panel-title {
  color: var(--error);
}
```

颜色、半径和焦点样式只取上述现有 token。随后运行生成器：

```bash
corepack yarn workspace dsh-plugin-huaanwork gen:styles
```

- [ ] **Step 4: 运行组件、样式新鲜度与类型检查**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/ToolPanel.spec.ts tests/client-huaanwork/styles-generated.spec.ts tests/client-huaanwork/SubagentRunCard.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```

Expected: PASS；多个详情可并存、HTML 不生成元素、读屏只随标题迁移更新，生成样式与 CSS 一致。

- [ ] **Step 5: 条件式提交**

仅在用户已明确要求提交时执行：

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/ToolPanel.tsx dsh-plugin-huaanwork/src/client-huaanwork/styles.css dsh-plugin-huaanwork/src/client-huaanwork/styles.generated.ts dsh-plugin-huaanwork/tests/client-huaanwork/ToolPanel.spec.ts
git commit -m "feat: add accessible chat tool panel"
```

---

### Task 8: App 最终渲染投影与跨标签手动展开

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/toolPanel.spec.ts`

**Interfaces:**
- Consumes: Task 4 投影、Task 7 `ToolPanel`、Task 3 `withToolPanelToggle`、Task 6 final map 和 `sidecarDead`。
- Produces: 最终消息区只渲染虚拟面板，不渲染散落普通工具行；`contentView`、扁平 `items` 和其他消费方保持原样。

- [ ] **Step 1: 写 App 投影与手动选择接线失败测试**

在 `appWiring.spec.ts` 增加：

```ts
test("App projects only the final chat rows and persists panel toggle on the anchor item", () => {
  assert.match(APP_SOURCE, /const toolRows = useMemo\(\(\) => projectToolPanels\(items, \{/);
  assert.match(APP_SOURCE, /contentItems: contentView/);
  assert.match(APP_SOURCE, /turnFinalByUserId: activeChat\.turnFinalByUserId/);
  assert.match(APP_SOURCE, /connectionLost: sidecarDead/);
  assert.match(APP_SOURCE, /withToolPanelToggle\(tab\.items, anchorId, next\)/);
  assert.match(APP_SOURCE, /toolRows\.map\(\(row\) =>/);
  assert.doesNotMatch(APP_SOURCE, /items\.map\(\(item, index\) => \(\s*<ChatRow/);
  assert.match(APP_SOURCE, /turnChecks\(contentItems\(items\)\)/);
  assert.match(APP_SOURCE, /insertBeforeToolRow\(prev, ask, event\.callId\)/);
});
```

在 `toolPanel.spec.ts` 增加实际的多回合/重投影测试：

```ts
test("a later user closes the old panel, starts non-final, and preserves the old manual choice", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user" },
    tool(2, "read"),
    { id: 3, kind: "user" },
    tool(4, "grep"),
  ];
  const rows = projectToolPanels(items, { contentItems: content(items), connectionLost: false });
  const panels = rows.flatMap((row) => row.kind === "panel" ? [row.panel] : []);
  assert.equal(panels.length, 2);
  assert.equal(panels[0]?.expanded, false, "the previous user turn is implicitly final");
  assert.equal(panels[1]?.expanded, true, "the new user turn starts non-final");

  const manual = withToolPanelToggle(items, 2, "expand");
  const rerendered = projectToolPanels(manual, { contentItems: content(manual), connectionLost: false });
  const manualPanels = rerendered.flatMap((row) => row.kind === "panel" ? [row.panel] : []);
  assert.equal(manualPanels[0]?.expanded, true, "manual expand survives tab-style reconstruction");
  assert.equal(manualPanels[1]?.expanded, true);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/appWiring.spec.ts tests/client-huaanwork/toolPanel.spec.ts
```

Expected: FAIL，App 仍直接 `items.map`，没有 `toggleToolPanel`。

- [ ] **Step 3: 接入 memoized 渲染视图**

在 `contentView` 之后增加：

```ts
const toolRows = useMemo(() => projectToolPanels(items, {
  contentItems: contentView,
  turnFinalByUserId: activeChat.turnFinalByUserId,
  connectionLost: sidecarDead,
}), [items, contentView, activeChat.turnFinalByUserId, sidecarDead]);
```

在 `toggleThinking` 后增加：

```ts
function toggleToolPanel(anchorId: number, next: PanelToggle) {
  setChatTabs((prev) => prev.map((tab) => {
    const items = withToolPanelToggle(tab.items, anchorId, next);
    return items === tab.items ? tab : { ...tab, items: [...items] };
  }));
}
```

把最终 `items.map` 替换为以下结构；非工具行继续使用原始 `row.index` 取思考前文，避免投影后下标错位：

```tsx
{toolRows.map((row) => row.kind === "panel" ? (
  <ToolPanel key={row.id} panel={row.panel} onToggle={toggleToolPanel} />
) : (
  <ChatRow
    key={row.item.id}
    item={row.item}
    blocked={blocked}
    subagent={subagentChat}
    onAnswer={answer}
    onInput={answerInput}
    onThinkingToggle={toggleThinking}
    onOpenAttachment={handleOpenAttachment}
    reasoning={row.item.kind === "assistant" ? (thinkingBefore(items, row.index)?.thought ?? "") : ""}
    hasAssistantText={
      row.item.kind === "thinking"
        ? hasAssistantTextAfter(contentView, contentIndexById.get(row.item.id) ?? -1)
        : false
    }
  />
))}
```

将 `ChatRow` 的 `item` prop 收窄为 `Exclude<ChatItem, { kind: "tool" }>`，删除其普通 tool 渲染分支和已无消费方的 `toolRowIcon` 导入。不得删除 `ChatItem` 的 tool 变体。

- [ ] **Step 4: 运行渲染相关回归和类型检查**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/appWiring.spec.ts tests/client-huaanwork/toolPanel.spec.ts tests/client-huaanwork/ToolPanel.spec.ts tests/client-huaanwork/thinkingPanel.spec.ts tests/client-huaanwork/planConfirm.spec.ts tests/client-huaanwork/SubagentRunCard.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```

Expected: PASS；审批、输入、待办、附件和子代理行仍在原相对位置，工具行只从面板出现。

- [ ] **Step 5: 条件式提交**

仅在用户已明确要求提交时执行：

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/toolPanel.spec.ts
git commit -m "feat: render one tool panel per chat turn"
```

---

### Task 9: 全量受影响面自动回归

**Files:**
- Modify only when a regression is reproduced: the owning source/test files from Tasks 1–8
- Test: all existing suites listed below

**Interfaces:**
- Consumes: Tasks 1–8 的全部接口。
- Produces: 可复核的受影响测试清单与实际通过/失败结果；不以局部结果代替 root 门禁。

- [ ] **Step 1: 运行本功能全部定向测试**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/bridge.spec.ts tests/huaanwork-host/session-view.spec.ts tests/client-huaanwork/commandOutcome.spec.ts tests/client-huaanwork/sessionChannel.spec.ts tests/client-huaanwork/toolPanel.spec.ts tests/client-huaanwork/ToolPanel.spec.ts tests/client-huaanwork/appWiring.spec.ts tests/client-huaanwork/goalRound.spec.ts tests/client-huaanwork/turnStatus.spec.ts tests/client-huaanwork/outcomeCheck.spec.ts
```

Expected: PASS。若失败，记录完整失败输出并回到拥有该行为的任务，不通过删除断言或放宽文案绕过。

- [ ] **Step 2: 运行特殊卡与相邻消费方回归**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork tests/huaanwork-guardrails
```

Expected: PASS，覆盖思考、审批、自由文本、待办、子代理、目标续轮和扁平消息消费方。

- [ ] **Step 3: 运行 workspace 全量测试与类型检查**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork test
corepack yarn workspace dsh-plugin-huaanwork typecheck
```

Expected: PASS。任何既有环境失败也要保留原始输出并区分“本功能回归”与“环境/基线问题”。

- [ ] **Step 4: 条件式提交回归修复（仅有修复时）**

若本任务产生修复且用户明确要求提交，按实际文件执行 `git add`，提交信息使用：

```bash
git commit -m "test: close chat tool panel regressions"
```

---

### Task 10: Root 完整门禁与可审计证据

**Files:**
- Create: `docs/evidence/2026-11-02-chat-tool-panel-verification.md`

**Interfaces:**
- Consumes: Task 9 的通过基线。
- Produces: 三条 root 命令的真实结果、环境限制和剩余未验证项；证据不得预先写“通过”。

- [ ] **Step 1: 串行运行 root 测试**

Run:

```bash
corepack yarn test
```

记录实际 exit code、测试汇总和任何失败全文。不得与其他 root 门禁并行。

- [ ] **Step 2: 串行运行 root 类型检查**

Run:

```bash
corepack yarn typecheck
```

记录实际 exit code 与失败全文（若有）。

- [ ] **Step 3: 串行运行完整 headless gate**

Run:

```bash
corepack yarn check
```

记录实际 exit code、执行到的阶段和阻塞原因。若 npm/network/AA/market 环境导致失败，不得改写为代码测试通过。

- [ ] **Step 4: 写证据文档并核对工作树**

证据文档逐条记录：执行日期、Node/Yarn 版本、三条命令、真实结果、失败日志指针、未执行项。随后运行：

```bash
git status --short
git diff --check
```

Expected: `git diff --check` 无输出且 exit 0；`git status` 只包含本功能和用户原有未跟踪文件，不得把 `.gstack/`、`.qoder/` 或既有设计评审文件误加入功能提交。

- [ ] **Step 5: 条件式提交证据**

仅在用户明确要求提交时执行：

```bash
git add docs/evidence/2026-11-02-chat-tool-panel-verification.md
git commit -m "docs: record chat tool panel verification"
```

---

### Task 11: 真实图形界面与受控异常验收

**Files:**
- Modify: `docs/evidence/2026-11-02-chat-tool-panel-verification.md`

**Interfaces:**
- Consumes: Tasks 1–10 的实现与自动化证据。
- Produces: 真实 UI 走查结果；模拟场景明确标注“模拟”，未执行项明确标注“未验收”。

- [ ] **Step 1: 取得明确许可后启动开发版**

只有用户明确同意图形启动后执行：

```bash
corepack yarn dev
```

若用户未同意，保留“真机未验收”，不得用 jsdom/typecheck 代替。

- [ ] **Step 2: 走查基本聚合、详情和键盘**

1. 同一回合连续调用 `read`、`grep`、`bash`：会话区只有一个面板，无散落工具行或自动展开长输出。
2. 展开两个单项详情：参数/结果对应正确，长输出只在面板内部滚动；参数和结果自动换行。
3. 用 Tab 聚焦面板标题与工具行，分别用 Enter、Space 操作，核对 `aria-expanded` 与可见内容一致。
4. 用读屏或辅助功能树确认状态区域只播报状态迁移，不随计时/重复渲染重复播报。

- [ ] **Step 3: 走查自动收起、手动优先和多回合**

1. 尚无正文时面板默认展开；正文出现后默认收起，后续工具不强制重新展开。
2. 手动展开后切换标签再返回，仍展开；手动收起同理。
3. 自动化运行回复折叠为附件时也默认收起。
4. 连续两个用户回合各保留独立面板；后台标签结束事件不改变当前标签。

- [ ] **Step 4: 走查失败、取消和特殊卡**

1. 工具失败但回合继续：只有该工具和面板摘要显示失败；必要时“命令未通过”脚注可与具体状态并存。
2. 运行中取消：当前回合未结束工具显示已中断，已完成输出/失败/截断不变；旧回合不受影响。
3. 全部工具已结束且无正文时，取消/失败/正常 final 都能默认收起。
4. 分别触发并操作审批（批准与拒绝）、`request_input`（底部回答与取消）、携带空/非空 `todos` 的 `todo_write`、显式子代理（运行卡更新与既有终止流程）。
5. 不带 `todos` 的 `todo_write` 作为普通工具进入面板；特殊卡均不进入面板。

- [ ] **Step 5: 走查历史恢复**

1. 从只读历史页选择“继续此会话”：新历史面板默认收起，成功、失败、空输出和截断结果可展开查看。
2. 旧历史只有调用无结果：单项和标题显示“结果未记录”，结果区显示“历史记录未保存结果”，不得显示完成或无输出。
3. 分别经子任务恢复和运行记录回填确认同样的历史 final/结果语义。
4. 含 goal 续轮的历史恢复为与实时相同的续轮 note，续轮前后工具仍只有一个默认收起的面板；只读历史页仍逐条显示 goal 原始用户消息。
5. 返回只读 `HistoryDetailPane`，确认仍是逐条 `tool-call/tool-result` 日志。

- [ ] **Step 6: 用受控模拟覆盖断连和目标顺序，并明确标注模拟**

1. Host 断连：受影响标题/单项显示“状态未确认”，回合条显示“工具状态未确认”，不显示“正在执行工具”或“正在思考”；完成/失败事实保留。
2. ready 后：未标终态的开始态工具恢复真实执行展示，迟到 `tool/end` 按 callId 更新；连接恢复本身不补成功。
3. `hostPhase=suspect/stoppable` 且套接字未断：只显示既有探活横幅，不改工具状态；`stopped` 本身不算断连。
4. 目标 `active` 中间 `session/end`：不收起、不标未确认，后续 `goal/round` 复用同一面板。
5. `endFirst`：active 中间结束后，由 `goal/state complete` 的真实 `outcome` 立即 final，无需第二次 `session/end`；重复 complete 和后续结束保持 final。

- [ ] **Step 7: 记录真实结果并条件式提交**

在证据文档逐项写“真实 UI / 受控模拟 / 未执行”、实际观察、截图或日志路径和问题。未执行项目不得写通过。仅在用户明确要求提交时执行：

```bash
git add docs/evidence/2026-11-02-chat-tool-panel-verification.md
git commit -m "docs: record chat tool panel UI acceptance"
```
