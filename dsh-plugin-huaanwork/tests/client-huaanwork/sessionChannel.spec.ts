import assert from "node:assert/strict";
import { test } from "vitest";

import { detailRecords } from "../../src/huaanwork-host/session-view.ts";
import {
  chatTabHasConversation,
  chatTabTitle,
  cwdWithinRoot,
  historyItemsFromRecords,
  isAutomationSessionId,
  RESULT_PRESENT_FAILURE_NOTE,
  RESULT_PRESENT_TOOL,
  sessionHasContent,
  unscopedSessions,
} from "../../src/client-huaanwork/logic/sessionChannel.ts";

test("chatTabTitle prefers the first user message", () => {
  assert.equal(
    chatTabTitle({
      label: "对话",
      items: [
        { kind: "note", text: "已打开项目" },
        { kind: "user", text: "  解释这个仓库  " },
      ],
    }),
    "解释这个仓库",
  );
  assert.equal(chatTabTitle({ label: "对话 2", items: [] }), "对话 2");
  assert.equal(chatTabHasConversation({ items: [{ kind: "note", text: "x" }] }), false);
  assert.equal(chatTabHasConversation({ items: [{ kind: "user", text: "hi" }] }), true);
});

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

test("history user items keep the host clientMessageId while goal rounds stay notes", () => {
  const items = historyItemsFromRecords([
    { kind: "user", time: 1, text: "开始", clientMessageId: "m1" },
    { kind: "assistant", time: 2, text: "好的" },
    { kind: "user", time: 3, text: "官方续轮提示", goalRound: 2, clientMessageId: "m2" },
  ]);
  assert.deepEqual(items, [
    { kind: "user", text: "开始", clientMessageId: "m1" },
    { kind: "assistant", text: "好的" },
    // 完成/续轮通知不得切出第二条用户回合:goal 续轮只成为 note。
    { kind: "note", text: "正在按目标继续，第 2/4 轮，这还不是验收结果" },
  ]);
  // 没有历史 id 的旧记录保持无字段,不凭空生成锚点。
  assert.deepEqual(historyItemsFromRecords([{ kind: "user", time: 1, text: "旧记录" }]), [
    { kind: "user", text: "旧记录" },
  ]);
});

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

test("synthetic interrupted and resultMissing records restore honest cards without failure", () => {
  const interrupted = historyItemsFromRecords([
    { kind: "user", time: 1, text: "运行命令" },
    { kind: "tool-call", time: 2, name: "bash", callId: "b1", command: "sleep 20" },
    {
      kind: "tool-result",
      time: 3,
      callId: "b1",
      isError: true,
      text: "The tool call was interrupted after it was recorded.",
      synthetic: "interrupted",
    },
  ]).find((item) => item.kind === "tool");
  assert.deepEqual(interrupted && interrupted.kind === "tool"
    ? [interrupted.hasResult, interrupted.interrupted, interrupted.resultMissing, interrupted.isError, interrupted.output]
    : [], [false, true, undefined, undefined, undefined]);

  const missing = historyItemsFromRecords([
    { kind: "user", time: 1, text: "运行命令" },
    { kind: "tool-call", time: 2, name: "bash", callId: "b1" },
    {
      kind: "tool-result",
      time: 3,
      callId: "b1",
      isError: true,
      text: "The tool call was interrupted after it was recorded.",
      synthetic: "resultMissing",
    },
  ]).find((item) => item.kind === "tool");
  assert.deepEqual(missing && missing.kind === "tool"
    ? [missing.hasResult, missing.interrupted, missing.resultMissing, missing.isError, missing.output]
    : [], [false, undefined, true, undefined, undefined]);
});

test("unmatched synthetic results never become an English failure note", () => {
  for (const synthetic of ["interrupted", "resultMissing", "hidden"] as const) {
    const items = historyItemsFromRecords([
      { kind: "tool-result", time: 1, isError: true, text: "The tool call was interrupted before the Harness recorded it as started.", synthetic },
    ]);
    assert.deepEqual(items, [], synthetic);
  }
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

test("history restores a collapsed thinking record", () => {
  const items = historyItemsFromRecords([
    { kind: "user", time: 1, text: "问" },
    { kind: "thinking", time: 2, text: "先看文件" },
    { kind: "assistant", time: 3, text: "好的" },
  ]);
  assert.deepEqual(items[1], { kind: "thinking", text: "先看文件" });
});

test("sessionHasContent hides empty shell sessions from history lists", () => {
  // 项目打开时铸造的空壳会话：只有初始化事件，不算历史条目。
  assert.equal(sessionHasContent({ messageCount: 0, turnCount: 0 }), false);
  assert.equal(sessionHasContent({}), false);
  // 有真实消息或轮次的会话保留。
  assert.equal(sessionHasContent({ messageCount: 2, turnCount: 1 }), true);
  assert.equal(sessionHasContent({ messageCount: 0, turnCount: 1 }), true);
});

test("isAutomationSessionId marks both run prefixes, never user sessions", () => {
  assert.equal(isAutomationSessionId("huaanwork-auto-abc123-run1"), true);
  // 旧 chat 通道运行会话：即便清扫失败残留，也按运行会话过滤，不进侧栏常规列表。
  assert.equal(isAutomationSessionId("huaanwork-chat-auto-abc123-run1"), true);
  assert.equal(isAutomationSessionId("huaanwork-aabbccdd00112233"), false);
  assert.equal(isAutomationSessionId("huaanwork-chat-aabbccdd00112233"), false);
  assert.equal(isAutomationSessionId(undefined), false);
});

test("cwdWithinRoot matches the directory itself and subdirectories only", () => {
  assert.equal(cwdWithinRoot("/repo/app", "/repo/app"), true);
  assert.equal(cwdWithinRoot("/repo/app/packages/web", "/repo/app"), true);
  assert.equal(cwdWithinRoot("/repo/app/", "/repo/app"), true);
  assert.equal(cwdWithinRoot("C:\\repo\\app\\pkg", "C:\\repo\\app"), true);
  // 兄弟目录与同名前缀目录不算归属。
  assert.equal(cwdWithinRoot("/repo/app2", "/repo/app"), false);
  assert.equal(cwdWithinRoot("/repo", "/repo/app"), false);
  assert.equal(cwdWithinRoot(undefined, "/repo/app"), false);
  assert.equal(cwdWithinRoot("/repo/app", undefined), false);
  assert.equal(cwdWithinRoot("/repo/app", ""), false);
});

test("unscopedSessions keeps only neutral non-project sessions, drops automation and empty rows", () => {
  const projects = [
    { id: "p1", root: "/repo/alpha" },
    { id: "p2", root: "/repo/beta" },
  ];
  const sessions = [
    { id: "huaanwork-aaaa", cwd: "/repo/alpha", messageCount: 3 }, // p1 主会话 (项目 cwd -> 排除)
    { id: "huaanwork-aaaa-1", cwd: "/repo/alpha/packages", messageCount: 1 }, // p1 子目录会话 (排除)
    { id: "huaanwork-bbbb", cwd: "/repo/beta", messageCount: 2 }, // p2 (排除)
    { id: "huaanwork-cccc", cwd: "/neutral/workspace", messageCount: 4 }, // 未归属 → 保留
    { id: "huaanwork-auto-a1-r1", cwd: "/neutral/workspace", messageCount: 9 }, // 自动化运行 → 不入列
    { id: "huaanwork-chat-auto-a1-r1", cwd: "/neutral/workspace", messageCount: 8 }, // 旧自动化 → 不入列
    { id: "huaanwork-dddd", cwd: "/neutral/workspace", messageCount: 0, turnCount: 0 }, // 空壳 → 不入列
  ];
  const result = unscopedSessions(sessions, projects);
  assert.deepEqual(
    result.map((row) => row.id),
    ["huaanwork-cccc"],
  );
});

test("unscopedSessions treats legacy huaanwork-chat-* ids as normal sessions", () => {
  const projects = [{ id: "p1", root: "/repo/a" }];
  const sessions = [
    { id: "huaanwork-chat-deadbeef", cwd: "/repo/a", messageCount: 3 },
    { id: "huaanwork-chat-0123456789abcdef-abcd1234", cwd: "/elsewhere", messageCount: 2 },
  ];
  const result = unscopedSessions(sessions, projects);
  assert.deepEqual(
    result.map((row) => row.id),
    ["huaanwork-chat-0123456789abcdef-abcd1234"],
  );
});

test("history maps todo_write calls to a todo card and skips the paired result", () => {
  const items = historyItemsFromRecords([
    { kind: "user", time: 1, text: "规划实施", clientMessageId: "m1" },
    { kind: "tool-call", time: 2, name: "todo_write", callId: "t1", roundKey: 6, clientMessageId: "m1", todos: [
      { content: "分析", status: "completed" },
      { content: "实施", status: "in_progress" },
    ] },
    { kind: "tool-result", time: 3, callId: "t1", isError: false, text: "updated" },
    { kind: "assistant", time: 4, text: "继续", roundKey: 6 },
  ]);
  assert.deepEqual(items, [
    { kind: "user", text: "规划实施", clientMessageId: "m1" },
    { kind: "todo", todos: [
      { content: "分析", status: "completed" },
      { content: "实施", status: "in_progress" },
    ], roundKey: 6, clientMessageId: "m1" },
    { kind: "assistant", text: "继续", roundKey: 6 },
  ]);
});

test("history keeps the empty todo snapshot legal and never expands a failed todo result", () => {
  const items = historyItemsFromRecords([
    { kind: "tool-call", time: 1, name: "todo_write", callId: "t1", todos: [] },
    { kind: "tool-result", time: 2, callId: "t1", isError: true, text: "boom" },
  ]);
  assert.deepEqual(items, [{ kind: "todo", todos: [] }]);
});

test("history replaces an unparseable todo_write with a safe note instead of the raw arguments", () => {
  const items = historyItemsFromRecords([
    { kind: "user", time: 1, text: "规划", clientMessageId: "m1" },
    { kind: "tool-call", time: 2, name: "todo_write", callId: "t1", args: '{"todos":"坏参数"}' },
    { kind: "tool-result", time: 3, callId: "t1", isError: true, text: "invalid arguments" },
  ]);
  assert.deepEqual(items, [
    { kind: "user", text: "规划", clientMessageId: "m1" },
    { kind: "note", text: "历史待办无法解析" },
  ]);
});

test("history todo cards stay anchored across goal continuation notices", () => {
  const items = historyItemsFromRecords([
    { kind: "user", time: 1, text: "修好构建", clientMessageId: "m1" },
    { kind: "tool-call", time: 2, name: "todo_write", callId: "t1", roundKey: 6, clientMessageId: "m1", todos: [
      { content: "复现", status: "completed" },
    ] },
    { kind: "tool-result", time: 3, callId: "t1", isError: false, text: "updated" },
    { kind: "user", time: 4, text: "官方续轮提示", goalRound: 1 },
    { kind: "tool-call", time: 5, name: "todo_write", callId: "t2", roundKey: 10, clientMessageId: "m1", todos: [
      { content: "复现", status: "completed" },
      { content: "修复", status: "in_progress" },
    ] },
    { kind: "tool-result", time: 6, callId: "t2", isError: false, text: "updated" },
  ]);
  assert.equal(items.filter((item) => item.kind === "user").length, 1);
  const todos = items.filter((item) => item.kind === "todo");
  assert.deepEqual(todos.map((item) => (item.kind === "todo" ? [item.clientMessageId, item.roundKey] : [])), [
    ["m1", 6],
    ["m1", 10],
  ]);
});

test("historyItemsFromRecords passes roundKey through thinking, assistant and tool items", () => {
  const items = historyItemsFromRecords([
    { kind: "user", time: 1, text: "问题" },
    { kind: "thinking", time: 2, text: "想", roundKey: 6 },
    { kind: "assistant", time: 3, text: "答", roundKey: 6 },
    { kind: "tool-call", time: 4, name: "read", callId: "c1", roundKey: 6 },
    { kind: "tool-result", time: 5, callId: "c1", isError: false, text: "ok" },
    { kind: "tool-call", time: 6, name: "bash", callId: "c2", roundKey: 9 },
    { kind: "tool-result", time: 7, callId: "c2", isError: false, text: "ok" },
  ]);
  const thinking = items.find((i) => i.kind === "thinking");
  const assistant = items.find((i) => i.kind === "assistant");
  const tools = items.filter((i) => i.kind === "tool");
  assert.equal(thinking?.kind === "thinking" ? thinking.roundKey : undefined, 6);
  assert.equal(assistant?.kind === "assistant" ? assistant.roundKey : undefined, 6);
  assert.equal(tools[0]?.kind === "tool" ? tools[0].roundKey : undefined, 6);
  assert.equal(tools[1]?.kind === "tool" ? tools[1].roundKey : undefined, 9);
});

test("result_present never becomes a history tool card and its body never reaches the client", () => {
  const log = [
    JSON.stringify({ type: "session", version: 1, id: "s1", createdAt: 1 }),
    JSON.stringify({
      type: "tool/call",
      time: 2,
      data: {
        turn: 1,
        step: 1,
        callId: "call-1",
        name: RESULT_PRESENT_TOOL,
        arguments: { title: "报告", format: "markdown", content: "完整结果正文" },
      },
    }),
    JSON.stringify({
      type: "tool/result",
      time: 3,
      data: {
        turn: 1,
        message: { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "已生成结果页" }] },
      },
    }),
  ].join("\n");
  const records = detailRecords(log);
  const call = records.find((record) => record.kind === "tool-call");
  // 历史投影不调用通用 formatToolArguments：记录保留身份与配对，参数正文不落进可读记录。
  assert.equal(call && call.kind === "tool-call" ? call.args : "missing", undefined);
  assert.equal(JSON.stringify(records).includes("完整结果正文"), false);
  const items = historyItemsFromRecords(records);
  assert.deepEqual(items, []);
});

test("a failed result_present result becomes one compact note without its arguments", () => {
  const items = historyItemsFromRecords([
    { kind: "user", time: 1, text: "生成报告" },
    {
      kind: "tool-call",
      time: 2,
      name: RESULT_PRESENT_TOOL,
      callId: "call-1",
      args: '{"title":"报告","content":"完整结果正文"}',
    },
    { kind: "tool-result", time: 3, callId: "call-1", isError: true, text: "artifact-write-failed" },
    { kind: "assistant", time: 4, text: "保存失败了" },
  ]);
  assert.deepEqual(items, [
    { kind: "user", text: "生成报告" },
    { kind: "note", text: RESULT_PRESENT_FAILURE_NOTE },
    { kind: "assistant", text: "保存失败了" },
  ]);
  assert.equal(JSON.stringify(items).includes("完整结果正文"), false);
});

test("a result_present call without a paired result leaves no tool card", () => {
  const items = historyItemsFromRecords([
    { kind: "user", time: 1, text: "生成报告" },
    { kind: "tool-call", time: 2, name: RESULT_PRESENT_TOOL, callId: "call-1", args: '{"content":"完整结果正文"}' },
  ]);
  assert.deepEqual(items, [{ kind: "user", text: "生成报告" }]);
});
