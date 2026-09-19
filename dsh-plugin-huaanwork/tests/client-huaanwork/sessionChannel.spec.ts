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

test("historyItemsFromRecords maps roles, tool calls and failed results", () => {
  const items = historyItemsFromRecords([
    { kind: "user", time: 1, text: "改一下 README" },
    { kind: "assistant", time: 2, text: "好的" },
    { kind: "tool-call", time: 3, name: "write", callId: "c1", args: "{}" },
    { kind: "tool-result", time: 4, callId: "c1", isError: false, text: "done" },
    { kind: "tool-call", time: 5, name: "bash", callId: "c2" },
    { kind: "tool-result", time: 6, callId: "c2", isError: true, text: "  权限不足\n请重试  " },
  ]);
  assert.deepEqual(items, [
    { kind: "user", text: "改一下 README" },
    { kind: "assistant", text: "好的" },
    { kind: "tool", name: "write", callId: "c1" },
    { kind: "tool", name: "bash", callId: "c2" },
    { kind: "note", text: "工具调用失败：权限不足 请重试" },
  ]);
  // 空记录与纯工具成功结果不产出噪声条目。
  assert.deepEqual(historyItemsFromRecords([]), []);
  assert.deepEqual(
    historyItemsFromRecords([{ kind: "tool-result", time: 1, isError: false, text: "ok" }]),
    [],
  );
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
