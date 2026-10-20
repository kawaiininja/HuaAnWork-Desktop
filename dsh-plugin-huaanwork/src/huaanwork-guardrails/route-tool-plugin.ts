import { defineTool } from "@deepseek-ai/dsh-tools";
import { sessionIdOfAgentRef } from "@huaanwork/policy/channels";

import { classifyToolCalls } from "./route-tools.ts";

export const name = "huaanwork-route-tools";
export const inject = ["tools", "planMode"];

const INVALID_ROUTE_TEXT = "没能理解这个请求";
const STOPPED_TEXT = "回合已停止，这个问题不再等待回答";

type Agent = {
  id?: string;
  session?: { id?: string };
  cancel?: (reason: { kind: "parent" }) => void;
};

type Exec = { agent?: unknown; signal?: AbortSignal };

type Context = {
  huaanworkRouteAgent?: { current: unknown };
  huaanworkEmit?: (
    event:
      | { event: "session/end"; ok: false; error: string; sessionId?: string }
      | { event: "input/asked"; question: string; sessionId: string },
  ) => void;
  planMode: { set(agent: Agent, active: boolean): unknown };
  tools: { register(definition: unknown): unknown };
};

const invalidRoutes = new Map<string, number>();

/** 下一次用户消息受理时清掉，让每个用户回合都能重修一次坏参数。 */
export function clearInvalidRoute(sessionId: string): void {
  invalidRoutes.delete(sessionId);
}

export function noteInvalidRoute(sessionId: string): { endTurn: boolean; text?: string } {
  const count = (invalidRoutes.get(sessionId) ?? 0) + 1;
  invalidRoutes.set(sessionId, count);
  return count < 2 ? { endTurn: false } : { endTurn: true, text: INVALID_ROUTE_TEXT };
}

type PendingInput = { agent: Agent; resolve(answer: string): void; reject(error: Error): void };
const pendingInputs = new Map<string, PendingInput>();

/** 对话卡片提交：答案作为这次 `request_input` 的工具结果回到同一回合。 */
export function answerRouteInput(sessionId: string, answer: string): boolean {
  const pending = pendingInputs.get(sessionId);
  if (!pending) return false;
  pendingInputs.delete(sessionId);
  pending.resolve(answer);
  return true;
}

/** 对话卡片取消：`request_input` 以工具错误结束，回合停止。 */
export function cancelRouteInput(sessionId: string): boolean {
  const pending = pendingInputs.get(sessionId);
  if (!pending) return false;
  pendingInputs.delete(sessionId);
  pending.reject(new Error("用户取消了这个问题"));
  pending.agent.cancel?.({ kind: "parent" });
  return true;
}

/** 停止回合：等待中的 `request_input` 立即结束，不再等卡片。 */
export function releaseRouteInput(sessionId: string): boolean {
  const pending = pendingInputs.get(sessionId);
  if (!pending) return false;
  pendingInputs.delete(sessionId);
  pending.reject(new Error(STOPPED_TEXT));
  return true;
}

const textOutput = {
  schema: {
    type: "object" as const,
    additionalProperties: false,
    properties: { text: { type: "string" as const, required: true as const } },
  },
  render(_args: unknown, value: { text: string }) {
    return [{ type: "text" as const, text: value.text }];
  },
};

export function apply(ctx: Context): void {
  // `huaanworkRouteAgent` 是单槽，后一次发送会覆盖它；执行上下文带了 agent 就以它为准。
  const currentAgent = (exec: Exec | undefined): Agent | undefined => {
    const agent = exec?.agent ?? ctx.huaanworkRouteAgent?.current;
    return agent && typeof agent === "object" ? (agent as Agent) : undefined;
  };

  const rejectInvalid = (agent: Agent, sessionId: string, reason: string): never => {
    const noted = noteInvalidRoute(sessionId);
    if (noted.endTurn) {
      ctx.huaanworkEmit?.({ event: "session/end", ok: false, error: noted.text ?? INVALID_ROUTE_TEXT, sessionId });
      agent.cancel?.({ kind: "parent" });
    }
    throw new Error(reason);
  };

  const waitForInput = (agent: Agent, sessionId: string, question: string, signal: AbortSignal | undefined) =>
    new Promise<string>((resolve, reject) => {
      const emit = ctx.huaanworkEmit;
      if (typeof emit !== "function") {
        reject(new Error("没有可以显示问题的对话"));
        return;
      }
      pendingInputs.get(sessionId)?.reject(new Error("这个问题已被新的问题替换"));
      const onAbort = () => {
        if (pendingInputs.get(sessionId) === pending) pendingInputs.delete(sessionId);
        reject(new Error(STOPPED_TEXT));
      };
      const pending: PendingInput = {
        agent,
        resolve(answer) {
          signal?.removeEventListener("abort", onAbort);
          resolve(answer);
        },
        reject(error) {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      pendingInputs.set(sessionId, pending);
      emit({ event: "input/asked", question, sessionId });
    });

  ctx.tools.register(
    defineTool({
      name: "propose_plan",
      description: "这件事需要先计划再动手时调用。只带一句话目标，计划正文之后再写。",
      // 不标 required：缺字段也要进 execute，才能按会话计数并返回可修正的原因。
      parameters: {
        objective: { type: "string", description: "必填，一句话目标。不要带其他字段。" },
      },
      output: textOutput,
      async execute(args, exec?: Exec) {
        const agent = currentAgent(exec);
        const sessionId = sessionIdOfAgentRef(agent);
        if (!agent || !sessionId) throw new Error("当前没有可以进入计划模式的会话");
        const decision = classifyToolCalls([{ name: "propose_plan", args }]);
        if (decision.kind !== "planned") {
          return rejectInvalid(agent, sessionId, "propose_plan 只接受一个非空字符串字段 objective，请修正后再调用一次。");
        }
        invalidRoutes.delete(sessionId);
        ctx.planMode.set(agent, true);
        return { text: `已进入计划模式。目标：${decision.objective}` };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "request_input",
      description: "缺少继续所需的信息时调用，向用户提一个问题并等待回答。",
      parameters: {
        question: { type: "string", description: "必填，只问一个问题。不要带其他字段。" },
      },
      output: textOutput,
      async execute(args, exec?: Exec) {
        const agent = currentAgent(exec);
        const sessionId = sessionIdOfAgentRef(agent);
        if (!agent || !sessionId) throw new Error("当前没有可以提问的会话");
        const decision = classifyToolCalls([{ name: "request_input", args }]);
        if (decision.kind !== "clarify") {
          return rejectInvalid(agent, sessionId, "request_input 只接受一个非空字符串字段 question，请修正后再调用一次。");
        }
        invalidRoutes.delete(sessionId);
        return { text: await waitForInput(agent, sessionId, decision.question, exec?.signal) };
      },
    }),
  );
}
