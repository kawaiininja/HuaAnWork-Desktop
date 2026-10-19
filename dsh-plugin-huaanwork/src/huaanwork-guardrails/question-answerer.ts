import { randomUUID } from "node:crypto";

import { sessionIdOfAgentRef } from "@huaanwork/policy/channels";

import { registerApproval, type ApprovalResult } from "../huaanwork-host/approvals.ts";
import { readGuardMode } from "./policy.ts";

export const name = "huaanwork-question-answerer";
export const inject = ["userQuestions"];

/** 对话里没有可点击的回答者时显示这一句。不执行写入，也不交给官方到点放行。 */
export const UNANSWERED_TEXT = "这个问题还没有人接到";
const AUTO_CONTINUE_TEXT = "按当前护栏自动继续";

type ApprovalMap = Map<string, (result: ApprovalResult) => void>;

type Question = {
  id: string;
  question: string;
  detail?: string;
  options?: { label: string }[];
  intent?: { kind: string; approve?: string; callId?: string };
};

type QuestionRequest = {
  questions?: Question[];
  agent?: { id?: string; session?: { id?: string } };
  signal?: AbortSignal;
};

type AnswerBatch = { answers: { id: string; selected: string[] }[] };

type AskedEvent = {
  event: "approval/asked";
  approvalRequestId: string;
  toolName: string;
  callId?: string;
  reason?: string;
  summary?: string;
  sessionId?: string;
};

type Context = {
  huaanworkProfileDir?: string;
  huaanworkApprovals?: ApprovalMap;
  huaanworkEmit?: (event: AskedEvent) => void;
  on(
    event: "user-questions/request",
    listener: (request: QuestionRequest, next: () => Promise<AnswerBatch>) => Promise<AnswerBatch>,
    options?: { global?: boolean; prepend?: boolean },
  ): void;
};

type LiveReview = { approvalRequestId: string; approvals: ApprovalMap };

const livePlanReviews = new Map<string, LiveReview>();

export function answererDecision(input: {
  hasListener: boolean;
  intent: "clarify" | "plan-review" | "ask_user_question";
  mode: "ask" | "smart" | "full";
  autoContinue: boolean;
}): "wait" | "auto-approve" | "unanswered" {
  if (!input.hasListener) return "unanswered";
  if (input.intent === "plan-review" && input.autoContinue && input.mode !== "ask") return "auto-approve";
  return "wait";
}

export function apply(ctx: Context): void {
  // 官方瀑布名来自 @deepseek-ai/dsh-user-questions 的 Events['user-questions/request']。
  ctx.on("user-questions/request", async (request, next) => {
    const kind = requestKind(request);
    if (kind === "other") return next();

    const mode = readGuardMode(ctx.huaanworkProfileDir);
    const decision = answererDecision({
      hasListener: true,
      intent: kind,
      mode,
      autoContinue: kind === "plan-review" && mode === "full",
    });
    const approvals = mapOf(ctx.huaanworkApprovals);
    const canShow = typeof ctx.huaanworkEmit === "function";
    if (!canShow || !approvals) return unanswered(ctx, request);
    if (decision === "auto-approve") {
      const identity = reviewIdentity(request);
      if (identity) supersede(identity);
      showCard(ctx, request, randomUUID(), AUTO_CONTINUE_TEXT);
      return approveAnswers(request);
    }
    return waitOnCard(ctx, approvals, request);
  }, { global: true, prepend: true });
}

function requestKind(request: QuestionRequest): "plan-review" | "ask_user_question" | "other" {
  const questions = request.questions ?? [];
  if (questions.length === 0) return "other";
  if (questions.some((question) => question.intent && question.intent.kind !== "plan-review")) return "other";
  if (questions.some((question) => question.intent?.kind === "plan-review")) return "plan-review";
  return "ask_user_question";
}

function mapOf(value: ApprovalMap | undefined): ApprovalMap | undefined {
  return value instanceof Map ? value : undefined;
}

function showCard(ctx: Context, request: QuestionRequest, approvalRequestId: string, reason: string): void {
  const question = request.questions?.[0];
  const sessionId = sessionIdOfAgentRef(request.agent);
  const callId = question?.intent?.callId;
  const summary = question?.intent?.kind === "plan-review" ? question.detail : question?.question;
  ctx.huaanworkEmit?.({
    event: "approval/asked",
    approvalRequestId,
    toolName: question?.intent?.kind === "plan-review" ? "plan-review" : "ask_user_question",
    reason,
    ...(summary ? { summary } : {}),
    ...(callId ? { callId } : {}),
    ...(sessionId ? { sessionId } : {}),
  });
}

function approveAnswers(request: QuestionRequest): AnswerBatch {
  return {
    answers: (request.questions ?? []).map((question) => {
      if (question.intent?.kind === "plan-review" && question.intent.approve) {
        return { id: question.id, selected: [question.intent.approve] };
      }
      const label = question.options?.[0]?.label;
      return { id: question.id, selected: label ? [label] : [] };
    }),
  };
}

function declineAnswers(request: QuestionRequest): AnswerBatch {
  return {
    answers: (request.questions ?? []).map((question) => {
      if (question.intent?.kind === "plan-review") {
        const other = question.options?.find((option) => option.label !== question.intent?.approve)?.label;
        return { id: question.id, selected: other ? [other] : [] };
      }
      const other = question.options?.[1]?.label;
      return { id: question.id, selected: other ? [other] : [] };
    }),
  };
}

function reviewIdentity(request: QuestionRequest): string | undefined {
  const question = request.questions?.find((item) => item.intent?.kind === "plan-review");
  if (!question) return undefined;
  return `${question.id}:${question.intent?.callId ?? ""}`;
}

function supersede(identity: string): void {
  const previous = livePlanReviews.get(identity);
  if (!previous) return;
  livePlanReviews.delete(identity);
  const resolve = previous.approvals.get(previous.approvalRequestId);
  if (!resolve) return;
  previous.approvals.delete(previous.approvalRequestId);
  resolve("cancelled");
}

async function waitOnCard(ctx: Context, approvals: ApprovalMap, request: QuestionRequest): Promise<AnswerBatch> {
  const identity = reviewIdentity(request);
  if (identity) supersede(identity);
  const approvalRequestId = randomUUID();
  if (identity) livePlanReviews.set(identity, { approvalRequestId, approvals });
  const reason = request.questions?.map((question) => question.question).filter(Boolean).join("\n") || "ask_user_question";
  showCard(ctx, request, approvalRequestId, reason);
  try {
    const result = await waitForDecision(approvals, approvalRequestId, request.signal);
    return result === "allowed-once" ? approveAnswers(request) : declineAnswers(request);
  } finally {
    if (identity && livePlanReviews.get(identity)?.approvalRequestId === approvalRequestId) {
      livePlanReviews.delete(identity);
    }
  }
}

function waitForDecision(
  approvals: ApprovalMap,
  approvalRequestId: string,
  signal: AbortSignal | undefined,
): Promise<ApprovalResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      approvals.delete(approvalRequestId);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    registerApproval(approvals, approvalRequestId).then((result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      approvals.delete(approvalRequestId);
      resolve(result);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

async function unanswered(ctx: Context, request: QuestionRequest): Promise<never> {
  if (typeof ctx.huaanworkEmit === "function") showCard(ctx, request, randomUUID(), UNANSWERED_TEXT);
  await hangUntilRealCancel(request.signal);
  const reason = request.signal?.reason;
  throw reason instanceof Error ? reason : new Error(UNANSWERED_TEXT);
}

function hangUntilRealCancel(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return isTimedRelease(signal.reason) ? new Promise(() => {}) : Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => {
      if (!isTimedRelease(signal.reason)) resolve();
    }, { once: true });
  });
}

function isTimedRelease(reason: unknown): boolean {
  return Boolean(reason && typeof reason === "object" && (reason as { code?: string }).code === "ASK_TIMED_OUT");
}
