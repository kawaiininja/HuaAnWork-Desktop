import assert from "node:assert/strict";
import { test } from "vitest";
import {
  askCardWaitsForClick,
  closeRunTabsForSession,
  hasPendingAsk,
  markApprovalAnswered,
  resolveActiveTab,
} from "../../src/client-huaanwork/logic/chatTabs.ts";

test("a removed tab selection falls back to a tab that exists", () => {
  assert.equal(resolveActiveTab("gone", [{ id: "work-1" }, { id: "work-2" }]), "work-1");
  assert.equal(resolveActiveTab("work-2", [{ id: "work-1" }, { id: "work-2" }]), "work-2");
  assert.equal(resolveActiveTab("gone", []), "gone");
});

test("an unanswered ask card still waits for the user", () => {
  assert.equal(
    hasPendingAsk([
      { items: [{ kind: "ask", card: { approvalRequestId: "a1", toolName: "plan-review" } }] },
    ]),
    true,
  );
});

test("an auto-continue plan card does not wait for the user", () => {
  assert.equal(
    hasPendingAsk([
      {
        items: [
          {
            kind: "ask",
            card: { approvalRequestId: "a2", toolName: "plan-review", autoContinue: true },
          },
        ],
      },
    ]),
    false,
  );
});

test("an answered ask card and a closed input card no longer wait", () => {
  assert.equal(
    hasPendingAsk([
      {
        items: [
          { kind: "ask", card: { approvalRequestId: "a3", toolName: "plan-review", answered: "approve" } },
          { kind: "input", card: { question: "发给谁？", sessionId: "s1", state: "closed" } },
        ],
      },
    ]),
    false,
  );
});

test("an open request_input card keeps waiting", () => {
  assert.equal(
    hasPendingAsk([
      { items: [{ kind: "input", card: { question: "发给谁？", sessionId: "s1", state: "open" } }] },
    ]),
    true,
  );
});

test("a non-actionable notice card neither waits nor accepts a click", () => {
  const card = { approvalRequestId: "a4", toolName: "plan-review", actionable: false };
  assert.equal(hasPendingAsk([{ items: [{ kind: "ask", card }] }]), false);
  assert.equal(askCardWaitsForClick(card), false);
  assert.equal(askCardWaitsForClick({ approvalRequestId: "a5", toolName: "plan-review" }), true);
});

test("answering marks the card in the tab that holds it, not the current live tab", () => {
  type TestItem = { kind: string; text?: string; card?: { approvalRequestId?: string; toolName?: string; answered?: "approve" | "reject" } };
  const tabs: { id: string; items: TestItem[] }[] = [
    { id: "live", items: [{ kind: "user", text: "在另一张标签提问" }] },
    {
      id: "card",
      items: [
        { kind: "ask", card: { approvalRequestId: "req-1", toolName: "plan-review" } },
        { kind: "ask", card: { approvalRequestId: "req-2", toolName: "ask_user_question" } },
      ],
    },
  ];
  // 与 App 的 setChatTabs 同一写法:逐标签按 approvalRequestId 回写。
  const next = tabs.map((tab) => {
    const items = markApprovalAnswered(tab.items, "req-1", "approve");
    return items === tab.items ? tab : { ...tab, items };
  });
  assert.equal(next[0], tabs[0]);
  assert.notEqual(next[1], tabs[1]);
  assert.equal(next[1]!.items[0]!.card?.answered, "approve");
  assert.equal(next[1]!.items[1]!.card?.answered, undefined);
  // 未命中返回原数组,调用方不产生多余状态更新。
  assert.equal(markApprovalAnswered(tabs[1]!.items, "missing", "reject"), tabs[1]!.items);
});

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
  const result = closeRunTabsForSession(tabs, "s-9", "t1");
  assert.equal(result.nextActiveId, "t1");
  // 没有命中时连数组引用都不变，调用方不会产生多余状态更新。
  assert.equal(result.tabs, tabs);
});

test("a non-run tab with the same sessionId is never closed", () => {
  const tabs = [{ id: "user", sessionId: "s-1" }]; // 无 automationId：默认对话标签
  assert.equal(closeRunTabsForSession(tabs, "s-1", "user").tabs.length, 1);
});

test("a closed immediate right neighbour is skipped for the next surviving tab", () => {
  const tabs = [
    { id: "default" },
    { id: "t1", sessionId: "s-1", automationId: "a" }, // 当前标签，关
    { id: "t2", sessionId: "s-1", automationId: "a" }, // 紧右邻居，也关
    { id: "t3", sessionId: "s-1", automationId: "a" }, // 也关
    { id: "t4", sessionId: "s-4", automationId: "a" }, // 第一个存活
    { id: "t5", sessionId: "s-5", automationId: "a" },
  ];
  const result = closeRunTabsForSession(tabs, "s-1", "t1");
  assert.deepEqual(result.tabs.map((tab) => tab.id), ["default", "t4", "t5"]);
  assert.equal(result.nextActiveId, "t4");
});

test("with no survivor on the right the nearest surviving left tab wins", () => {
  const tabs = [
    { id: "default" },
    { id: "t1", sessionId: "s-1", automationId: "a" }, // 左邻居，存活
    { id: "t2", sessionId: "s-2", automationId: "a" }, // 当前标签，关
    { id: "t3", sessionId: "s-2", automationId: "a" }, // 右邻居，也关
  ];
  const result = closeRunTabsForSession(tabs, "s-2", "t2");
  assert.equal(result.nextActiveId, "t1");
});

test("a surviving active tab stays active while its siblings close", () => {
  const tabs = [
    { id: "t1", sessionId: "s-1", automationId: "a" },
    { id: "t2", sessionId: "s-9", automationId: "a" },
  ];
  const result = closeRunTabsForSession(tabs, "s-9", "t1");
  assert.deepEqual(result.tabs.map((tab) => tab.id), ["t1"]);
  assert.equal(result.nextActiveId, "t1");
});
