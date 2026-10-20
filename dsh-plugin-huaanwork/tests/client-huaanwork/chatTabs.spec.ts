import assert from "node:assert/strict";
import { test } from "vitest";
import { hasPendingAsk, resolveActiveTab } from "../../src/client-huaanwork/logic/chatTabs.ts";

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
