import assert from "node:assert/strict";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { answererDecision, apply, forgetConfirmedTarget, settlePlanReview } from "../../src/huaanwork-guardrails/question-answerer.ts";

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

function reviewWith(callId: string, plan: string) {
  return { ...planQuestion(callId), detail: plan };
}

function modeDir(mode: "ask" | "smart" | "full"): string {
  const dir = mkdtempSync(join(tmpdir(), "huaanwork-qa-"));
  writeFileSync(join(dir, "huaanwork-settings.json"), JSON.stringify({ guard_mode: mode }));
  return dir;
}

function answerer(mode: "ask" | "smart" | "full") {
  const events: (Asked & { autoContinue?: boolean })[] = [];
  const approvals = new Map<string, (result: ApprovalResult) => void>();
  const reviews = new Map<string, () => boolean>();
  let listener: Listener | undefined;
  apply({
    huaanworkProfileDir: modeDir(mode),
    huaanworkWorkspaceRoot: { current: tmpdir() },
    huaanworkApprovals: approvals,
    huaanworkPlanReviews: reviews,
    huaanworkEmit(event) {
      if (event.event === "approval/asked") events.push(event);
    },
    on(_name, fn) {
      listener = fn as Listener;
    },
  });
  const ask = (sessionId: string, callId: string, plan: string) =>
    listener!({ questions: [reviewWith(callId, plan)], agent: { session: { id: sessionId } } }, async () => {
      throw new Error("next");
    });
  return { events, approvals, reviews, ask };
}

async function pendingAfter(promise: Promise<unknown>): Promise<string> {
  return Promise.race([
    promise.then(() => "settled", () => "settled"),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 30)),
  ]);
}

test("smart auto-continues a read-only plan and confirms one that pushes", async () => {
  const { events, approvals, ask } = answerer("smart");
  const reads = await ask("smart-1", "c1", "# 汇总\n\n1. 读 `docs/a.md`\n2. 运行 `npm test`");
  assert.deepEqual(reads.answers, [{ id: "plan-review", selected: ["Approve"] }]);
  assert.equal(events[0]?.autoContinue, true);
  assert.equal(events[0]?.reason, "按当前护栏自动继续");

  const push = ask("smart-1", "c2", "# 发布\n\n1. `git push origin main`");
  assert.equal(await pendingAfter(push), "pending");
  assert.equal(events[1]?.autoContinue, undefined);
  approvals.get(events[1]!.approvalRequestId)!("allowed-once");
  assert.deepEqual((await push).answers, [{ id: "plan-review", selected: ["Approve"] }]);
});

test("ask mode always waits for the plan card", async () => {
  const { events, approvals, ask } = answerer("ask");
  const pending = ask("ask-1", "c1", "# 汇总\n\n读 `docs/a.md`");
  assert.equal(await pendingAfter(pending), "pending");
  approvals.get(events[0]!.approvalRequestId)!("rejected");
  assert.deepEqual((await pending).answers, [{ id: "plan-review", selected: ["Keep planning"] }]);
});

test("full mode confirms only when the target changed from the last confirmed plan", async () => {
  const { events, approvals, ask } = answerer("full");
  const first = await ask("full-1", "c1", "# 周报\n\n写入 `out/report.md`，收件人：张三");
  assert.deepEqual(first.answers, [{ id: "plan-review", selected: ["Approve"] }]);
  const same = await ask("full-1", "c2", "# 周报\n\n先读材料，再写入 `out/report.md`，收件人：张三");
  assert.deepEqual(same.answers, [{ id: "plan-review", selected: ["Approve"] }]);

  const changed = ask("full-1", "c3", "# 周报\n\n写入 `out/report.md`，收件人：李四");
  assert.equal(await pendingAfter(changed), "pending");
  approvals.get(events[2]!.approvalRequestId)!("allowed-once");
  await changed;
});

test("forgetting a removed session drops its last confirmed plan target", async () => {
  const { events, approvals, ask } = answerer("full");
  const first = await ask("full-forget", "c1", "# 周报\n\n写入 `out/report.md`，收件人：张三");
  assert.deepEqual(first.answers, [{ id: "plan-review", selected: ["Approve"] }]);
  assert.equal(events[0]?.autoContinue, true);

  // 目标变了就再确认一次,并把这第二份记为新的已确认目标。
  const second = ask("full-forget", "c2", "# 月报\n\n写入 `out/report.md`，收件人：李四");
  assert.equal(await pendingAfter(second), "pending");
  approvals.get(events[1]!.approvalRequestId)!("allowed-once");
  await second;

  // 记忆还在:再换目标仍要确认。
  const third = ask("full-forget", "c3", "# 季报\n\n写入 `out/report.md`，收件人：王五");
  assert.equal(await pendingAfter(third), "pending");
  approvals.get(events[2]!.approvalRequestId)!("allowed-once");
  await third;

  // 会话删除后忘掉目标:同名会话再出现按「没有上一份」处理,新目标不再触发确认。
  forgetConfirmedTarget("full-forget");
  forgetConfirmedTarget("never-confirmed");
  const afterRemoval = await ask("full-forget", "c4", "# 月报\n\n写入 `out/report.md`，收件人：李四");
  assert.deepEqual(afterRemoval.answers, [{ id: "plan-review", selected: ["Approve"] }]);
  assert.equal(events[3]?.autoContinue, true);
  assert.equal(events.length, 4);
});

test("exit settles an unanswered plan review as cancelled so exit_plan_mode can finish", async () => {
  const { events, approvals, reviews, ask } = answerer("ask");
  const pending = ask("exit-1", "c1", "# 汇总");
  assert.equal(await pendingAfter(pending), "pending");
  assert.equal(settlePlanReview(reviews, "exit-1"), true);
  await assert.rejects(pending, (error: unknown) =>
    error instanceof UserQuestionError && error.code === "ASK_CANCELLED");
  assert.equal(approvals.has(events[0]!.approvalRequestId), false);
  assert.equal(reviews.has("exit-1"), false);
  assert.equal(settlePlanReview(reviews, "exit-1"), false);
});
