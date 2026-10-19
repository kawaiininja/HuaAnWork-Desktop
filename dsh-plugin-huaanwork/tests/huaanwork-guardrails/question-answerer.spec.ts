import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { answererDecision, apply } from "../../src/huaanwork-guardrails/question-answerer.ts";

test("a missing answerer never releases a write", () => {
  assert.equal(answererDecision({ hasListener: false, intent: "clarify", mode: "full", autoContinue: true }), "unanswered");
  assert.equal(answererDecision({ hasListener: true, intent: "plan-review", mode: "ask", autoContinue: false }), "wait");
  assert.equal(answererDecision({ hasListener: true, intent: "plan-review", mode: "smart", autoContinue: true }), "auto-approve");
});

type ApprovalResult = "allowed-once" | "rejected" | "cancelled" | "unavailable";

type Asked = {
  event: "approval/asked";
  approvalRequestId: string;
  toolName: string;
  reason?: string;
  summary?: string;
};

type Listener = (
  request: unknown,
  next: () => Promise<unknown>,
) => Promise<{ answers: { id: string; selected: string[] }[] }>;

function planQuestion(callId: string) {
  return {
    id: "plan-review",
    question: "Approve this plan and leave plan mode?",
    detail: "# Ship",
    options: [{ label: "Approve" }, { label: "Keep planning" }],
    intent: { kind: "plan-review" as const, approve: "Approve", callId },
  };
}

test("plan review waits on the approval card and does not reuse an expired id", async () => {
  const events: Asked[] = [];
  const approvals = new Map<string, (result: ApprovalResult) => void>();
  let eventName = "";
  let listener: Listener | undefined;
  apply({
    huaanworkApprovals: approvals,
    huaanworkEmit(event) {
      if (event.event === "approval/asked") events.push(event);
    },
    on(name, fn) {
      eventName = name;
      listener = fn as Listener;
    },
  });
  assert.equal(eventName, "user-questions/request");
  assert.equal(typeof listener, "function");

  const first = listener!({ questions: [planQuestion("call-1")], agent: { session: { id: "s1" } } }, async () => {
    throw new Error("next");
  });
  assert.equal(events.length, 1);
  assert.notEqual(events[0]!.approvalRequestId, "plan-review");
  approvals.get(events[0]!.approvalRequestId)!("allowed-once");
  assert.deepEqual((await first).answers, [{ id: "plan-review", selected: ["Approve"] }]);

  const second = listener!(
    { questions: [planQuestion("call-2")], agent: { session: { id: "s1" } } },
    async () => {
      throw new Error("next");
    },
  );
  approvals.get(events[0]!.approvalRequestId)?.("allowed-once");
  const raced = await Promise.race([
    second.then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 30)),
  ]);
  assert.equal(raced, "pending");
  assert.equal(events.length, 2);
  assert.notEqual(events[1]!.approvalRequestId, events[0]!.approvalRequestId);
  assert.notEqual(events[1]!.approvalRequestId, "plan-review");
  approvals.get(events[1]!.approvalRequestId)!("rejected");
  assert.deepEqual((await second).answers, [{ id: "plan-review", selected: ["Keep planning"] }]);
});

test("official ask_user_question waits on the same approval card", async () => {
  const events: Asked[] = [];
  const approvals = new Map<string, (result: ApprovalResult) => void>();
  let listener: Listener | undefined;
  apply({
    huaanworkApprovals: approvals,
    huaanworkEmit(event) {
      if (event.event === "approval/asked") events.push(event);
    },
    on(_name, fn) {
      listener = fn as Listener;
    },
  });
  const pending = listener!(
    {
      questions: [{
        id: "q1",
        question: "用哪一份？",
        options: [{ label: "甲" }, { label: "乙" }],
      }],
      agent: { session: { id: "s1" } },
    },
    async () => {
      throw new Error("next");
    },
  );
  assert.equal(events[0]?.toolName, "ask_user_question");
  approvals.get(events[0]!.approvalRequestId)!("rejected");
  assert.deepEqual((await pending).answers, [{ id: "q1", selected: ["乙"] }]);
});

test("full mode without a chat answerer shows the unanswered notice and does not approve", async () => {
  const dir = mkdtempSync(join(tmpdir(), "huaanwork-qa-"));
  writeFileSync(join(dir, "huaanwork-settings.json"), JSON.stringify({ guard_mode: "full" }));
  const events: Asked[] = [];
  let listener: Listener | undefined;
  apply({
    huaanworkProfileDir: dir,
    huaanworkEmit(event) {
      if (event.event === "approval/asked") events.push(event);
    },
    on(_name, fn) {
      listener = fn as Listener;
    },
  });
  const controller = new AbortController();
  const pending = listener!(
    {
      questions: [planQuestion("call-full")],
      agent: { session: { id: "s1" } },
      signal: controller.signal,
    },
    async () => {
      throw new Error("next");
    },
  );
  const raced = await Promise.race([
    pending.then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 30)),
  ]);
  assert.equal(raced, "pending");
  assert.equal(events.some((event) => event.reason === "这个问题还没有人接到"), true);
  controller.abort();
  await assert.rejects(pending);
});
