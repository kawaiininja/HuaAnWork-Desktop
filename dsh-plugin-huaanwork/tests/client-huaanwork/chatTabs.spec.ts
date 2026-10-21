import assert from "node:assert/strict";
import { test } from "vitest";
import { askCardWaitsForClick, hasPendingAsk, markApprovalAnswered, resolveActiveTab } from "../../src/client-huaanwork/logic/chatTabs.ts";

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
