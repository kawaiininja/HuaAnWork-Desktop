import { randomUUID } from "node:crypto";

import { sessionIdOfAgentRef } from "@huaanwork/policy/channels";

type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";
type ApprovalMap = Map<string, (result: ApprovalOutcome) => void>;

type ApprovalRequest = {
  agent: unknown;
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
};

type Context = {
  huaanworkApprovals?: ApprovalMap;
  huaanworkAllowedOnce?: Set<string>;
  huaanworkEmit?: (event: {
    event: "approval/asked";
    approvalRequestId: string;
    toolName: string;
    callId?: string;
    reason?: string;
    summary?: string;
    sessionId?: string;
  }) => void;
  approval?: {
    setPolicy(agent: unknown, policy: "ask" | "never"): void;
  };
  on(
    event: "approval/request",
    listener: (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>,
  ): void;
};

const APPROVAL_TIMEOUT_MS = 120_000;

export const inject = ["approval"];

export function apply(ctx: Context): void {
  ctx.huaanworkAllowedOnce ??= new Set();
  ctx.on("approval/request", async (request) => {
    if (request.signal?.aborted) return "cancelled";
    const approvals = ctx.huaanworkApprovals;
    const emit = ctx.huaanworkEmit;
    if (!approvals || !emit) return "unavailable";

    ctx.approval?.setPolicy(request.agent, "ask");
    const approvalRequestId = randomUUID();
    // sessionId 是运行侧把审批归因到自动化运行的依据（运行结束只拒绝本运行的审批）。
    const approvalSessionId = agentSessionIdOf(request.agent);
    emit({
      event: "approval/asked",
      approvalRequestId,
      toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.reason === undefined ? {} : { reason: request.reason, summary: request.reason }),
      ...(approvalSessionId === undefined ? {} : { sessionId: approvalSessionId }),
    });

    const outcome = await waitForApproval(approvals, approvalRequestId, request.signal);
    if (outcome === "allowed-once" && typeof request.callId === "string") {
      ctx.huaanworkAllowedOnce?.add(request.callId);
    }
    return outcome;
  });
}

/** agent 引用的会话身份（session.id 优先，回落 agent.id）；无身份返回 undefined。 */
function agentSessionIdOf(agent: unknown): string | undefined {
  return agent && typeof agent === "object"
    ? sessionIdOfAgentRef(agent as { id?: string; session?: { id?: string } })
    : undefined;
}

function waitForApproval(
  approvals: ApprovalMap,
  approvalRequestId: string,
  signal: AbortSignal | undefined,
): Promise<ApprovalOutcome> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const pending = new Promise<ApprovalOutcome>((resolve) => {
    if (approvals.has(approvalRequestId)) {
      throw new Error(`approval request ${approvalRequestId} is already pending`);
    }
    approvals.set(approvalRequestId, resolve);
  });
  const unavailable = new Promise<ApprovalOutcome>((resolve) => {
    timeout = setTimeout(() => resolve("unavailable"), APPROVAL_TIMEOUT_MS);
  });
  const cancelled = new Promise<ApprovalOutcome>((resolve) => {
    onAbort = () => resolve("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  return Promise.race([pending, unavailable, cancelled]).finally(() => {
    approvals.delete(approvalRequestId);
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  });
}
