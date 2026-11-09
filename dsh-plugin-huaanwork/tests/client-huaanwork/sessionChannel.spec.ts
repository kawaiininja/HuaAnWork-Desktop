import assert from "node:assert/strict";
import { test } from "vitest";

import {
  chatTabHasConversation,
  chatTabTitle,
  cwdWithinRoot,
  historyItemsFromRecords,
  isAutomationSessionId,
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
