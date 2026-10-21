import { randomUUID } from "node:crypto";

import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
import { sessionIdOfAgentRef } from "@huaanwork/policy/channels";

import { AUTO_CONTINUE_LABEL, planNeedsConfirm } from "../client-huaanwork/logic/planConfirm.ts";
import { registerApproval, type ApprovalResult } from "../huaanwork-host/approvals.ts";
import type { AttachmentMaps } from "./agent-attachments.ts";
import { declaresAskTool, planTarget, targetChanged, type PlanTarget } from "./plan-signals.ts";
import { isGitDirty, readGuardMode } from "./policy.ts";

export const name = "huaanwork-question-answerer";
export const inject = ["userQuestions"];

/** 对话里没有可点击的回答者时显示这一句。不执行写入，也不交给官方到点放行。 */
export const UNANSWERED_TEXT = "这个问题还没有人接到";

type ApprovalMap = Map<string, (result: ApprovalResult) => void>;
/** sessionId → 把该会话未回答的 plan-review 以取消结算；没有可结算的评审时返回 false。 */
type PlanReviewMap = Map<string, () => boolean>;

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
  autoContinue?: boolean;
  /** false = 这张卡没有任何可提交的审批（没人接的提问），界面不得渲染批准/拒绝按钮。 */
  actionable?: false;
};

type Context = {
  huaanworkProfileDir?: string;
  huaanworkWorkspaceRoot?: { current: string };
  huaanworkAttachments?: AttachmentMaps;
  huaanworkApprovals?: ApprovalMap;
  huaanworkPlanReviews?: PlanReviewMap;
  /**
   * boot 时注入的容器;无人值守运行期间 `.current` 非空(policy.ts 同源)。
   * `sessionId` 是该运行自己的会话(automations-host 的 runAgentTurn 设置);
   * 没有它的旧形状只可能来自旧调用方,按全局作用域处理。
   */
  huaanworkUnattended?: { current?: UnattendedScope | null };
  huaanworkEmit?: (event: AskedEvent) => void;
  on(
    event: "user-questions/request",
    listener: (request: QuestionRequest, next: () => Promise<AnswerBatch>) => Promise<AnswerBatch>,
    options?: { global?: boolean; prepend?: boolean },
  ): void;
};

type UnattendedScope = { sessionId?: string }

type LiveReview = { approvalRequestId: string; approvals: ApprovalMap };

const livePlanReviews = new Map<string, LiveReview>();
/** sessionId → 上一份已确认计划的目标、收件人与写入范围。 */
const confirmedTargets = new Map<string, PlanTarget>();

/** 测试缝：清空跨用例共享的计划评审与已确认目标登记。 */
export function resetQuestionAnswererState(): void {
  livePlanReviews.clear();
  confirmedTargets.clear();
}

export function answererDecision(input: {
  hasListener: boolean;
  intent: "clarify" | "plan-review" | "ask_user_question";
  mode: "ask" | "smart" | "full";
  autoContinue: boolean;
}): "wait" | "auto-approve" | "unanswered" {
  // 失败方向的原语:没有回答者时绝不自动放行。本插件的 apply() 自己就是那个监听者,
  // 所以运行时传的是 true;这条分支是「没人接线」时的规格与测试锚,不要把 true 改成推导值。
  if (!input.hasListener) return "unanswered";
  if (input.intent === "plan-review" && input.autoContinue && input.mode !== "ask") return "auto-approve";
  return "wait";
}

export function apply(ctx: Context): void {
  // 官方瀑布名来自 @deepseek-ai/dsh-user-questions 的 Events['user-questions/request']。
  ctx.on("user-questions/request", async (request, next) => {
    const kind = requestKind(request);
    if (kind === "other") return next();

    // 无人值守自动化没有可点击的人:它自己会话里的计划评审一律按「保留计划」
    // 结算,不让 exit_plan_mode 等到一个永远不会来的点击(失败方向 = 不离开
    // 计划模式)。作用域带 sessionId 时只接管该会话——人在自动化运行期间发起的
    // 计划评审仍然走下面的正常通道;没有 sessionId 的旧形状退回全局判定。
    // request_input/clarify 在无人值守下同样没有回答者,但那是单独的后续项,
    // 本轮不在这里处理(保持现有行为)。
    const unattended = ctx.huaanworkUnattended?.current;
    if (kind === "plan-review" && unattendedOwns(unattended, request)) return declineAnswers(request);

    const mode = readGuardMode(ctx.huaanworkProfileDir);
    const decision = answererDecision({
      hasListener: true,
      intent: kind,
      mode,
      autoContinue: kind === "plan-review" && !planNeedsConfirm(confirmInput(ctx, request, mode)),
    });
    const approvals = mapOf(ctx.huaanworkApprovals);
    const canShow = typeof ctx.huaanworkEmit === "function";
    if (!canShow || !approvals) return unanswered(ctx, request);
    if (decision === "auto-approve") {
      const identity = reviewIdentity(request);
      if (identity) supersede(identity);
      showCard(ctx, request, randomUUID(), AUTO_CONTINUE_LABEL, { autoContinue: true });
      recordConfirmed(request);
      return approveAnswers(request);
    }
    return waitOnCard(ctx, approvals, request);
  }, { global: true, prepend: true });
}

function reviewedPlan(request: QuestionRequest): string {
  return request.questions?.find((question) => question.intent?.kind === "plan-review")?.detail ?? "";
}

/**
 * 无人值守作用域是否接管这次请求。带 `sessionId` 时只接管同一会话,自动化运行
 * 期间人在别的会话里的计划评审照常等人;没有 `sessionId`(旧形状)时保持原有
 * 全局判定,失败方向仍是「不自动批准」。
 */
function unattendedOwns(scope: UnattendedScope | null | undefined, request: QuestionRequest): boolean {
  if (!scope) return false;
  if (scope.sessionId === undefined) return true;
  const sessionId = sessionIdOfAgentRef(request.agent);
  return sessionId !== undefined && sessionId === scope.sessionId;
}

function confirmInput(ctx: Context, request: QuestionRequest, mode: "ask" | "smart" | "full") {
  const plan = reviewedPlan(request);
  const sessionId = sessionIdOfAgentRef(request.agent);
  const workspaceRoot = ctx.huaanworkWorkspaceRoot?.current ?? process.cwd();
  const attachedTools = sessionId
    ? [
        ...(ctx.huaanworkAttachments?.sessionHostTools.get(sessionId) ?? []),
        ...(ctx.huaanworkAttachments?.sessionAgentTools.get(sessionId) ?? []),
      ]
    : [];
  return {
    mode,
    declaresAskTool: mode === "smart" && declaresAskTool(plan, { workspaceRoot, gitDirty: () => isGitDirty(workspaceRoot), attachedTools }),
    changesTarget: mode === "full" && targetChanged(sessionId ? confirmedTargets.get(sessionId) : undefined, planTarget(plan)),
  };
}

function recordConfirmed(request: QuestionRequest): void {
  const sessionId = sessionIdOfAgentRef(request.agent);
  if (sessionId && reviewIdentity(request)) confirmedTargets.set(sessionId, planTarget(reviewedPlan(request)));
}

/** 会话删除后忘掉它上一份已确认的计划目标;同名会话再出现时按「没有上一份」处理。 */
export function forgetConfirmedTarget(sessionId: string): void {
  confirmedTargets.delete(sessionId);
}

/** 「退出计划模式」作废评审时抛给提问服务的错误；官方 `exit_plan_mode` 用 instanceof 认出取消。 */
function exitCancelled(): UserQuestionError {
  return new UserQuestionError("用户退出了计划模式", "ASK_CANCELLED");
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

/** 卡片选项：用具名字段替代两个位置布尔（autoContinue 默认 false、actionable 默认 true）。 */
type CardOptions = { autoContinue?: boolean; actionable?: boolean };

function showCard(
  ctx: Context,
  request: QuestionRequest,
  approvalRequestId: string,
  reason: string,
  options: CardOptions = {},
): void {
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
    ...(options.autoContinue ? { autoContinue: true } : {}),
    ...(options.actionable === false ? { actionable: false as const } : {}),
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
  const sessionId = sessionIdOfAgentRef(request.agent);
  const reviews = identity && sessionId && ctx.huaanworkPlanReviews instanceof Map ? ctx.huaanworkPlanReviews : undefined;
  let settleExit: (() => boolean) | undefined;
  const exited = new Promise<never>((_resolve, reject) => {
    settleExit = () => {
      if (!approvals.delete(approvalRequestId)) return false;
      reject(exitCancelled());
      return true;
    };
  });
  if (reviews && sessionId && settleExit) reviews.set(sessionId, settleExit);
  try {
    const result = await Promise.race([waitForDecision(approvals, approvalRequestId, request.signal), exited]);
    if (result !== "allowed-once") return declineAnswers(request);
    recordConfirmed(request);
    return approveAnswers(request);
  } finally {
    if (reviews && sessionId && reviews.get(sessionId) === settleExit) reviews.delete(sessionId);
    if (identity && livePlanReviews.get(identity)?.approvalRequestId === approvalRequestId) {
      livePlanReviews.delete(identity);
    }
  }
}

/** 「退出计划模式」第一步：把该会话未回答的 plan-review 以取消结算。返回是否结算了一份评审。 */
export function settlePlanReview(reviews: PlanReviewMap | undefined, sessionId: string): boolean {
  const settle = reviews?.get(sessionId);
  if (!settle) return false;
  reviews?.delete(sessionId);
  return settle();
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
  // 没有任何审批登记:卡片只能是一句说明,不能带批准/拒绝按钮(点击只会静默失败)。
  if (typeof ctx.huaanworkEmit === "function") {
    showCard(ctx, request, randomUUID(), UNANSWERED_TEXT, { actionable: false });
  }
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
