import { defineTool } from "@deepseek-ai/dsh-tools";
import { sessionIdOfAgentRef } from "@huaanwork/policy/channels";

import { classifyToolCalls } from "./route-tools.ts";

export const name = "huaanwork-route-tools";
export const inject = ["tools", "planMode"];

const INVALID_ROUTE_TEXT = "没能理解这个请求";
const STOPPED_TEXT = "回合已停止，这个问题不再等待回答";
/** 无人值守运行没有可点击的人：request_input 必须立刻失败，不能停到自动化超时。 */
export const UNATTENDED_NO_ANSWERER_TEXT = "无人值守运行没有可以回答这个问题的人";

/** 与 question-answerer 同一作用域语义：带 sessionId 时只接管该会话，旧形状按全局处理。 */
function unattendedOwnsInput(scope: { sessionId?: string } | null | undefined, sessionId: string): boolean {
  if (!scope) return false;
  if (scope.sessionId === undefined) return true;
  return scope.sessionId === sessionId;
}

type Agent = {
  id?: string;
  session?: { id?: string };
  cancel?: (reason: { kind: "parent" }) => void;
};

type Exec = { agent?: unknown; signal?: AbortSignal };

type Context = {
  huaanworkRouteAgent?: { current: unknown };
  /** boot 时注入的容器；无人值守运行期间 `.current` 非空，boot 时初始化为 null（policy.ts / question-answerer 同源）。 */
  huaanworkUnattended?: { current?: { sessionId?: string } | null };
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

/** 测试缝：清空按会话登记的运行态（坏参数计数 / 等待中的卡片），避免跨用例残留。 */
export function resetRouteToolState(): void {
  invalidRoutes.clear();
  pendingInputs.clear();
}

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

  const waitForInput = (agent: Agent, sessionId: string, question: string, signal: AbortSignal | undefined) => {
    // 无人值守自动化没有人类卡片：立刻以工具错误结束，而不是把整轮停到超时。
    if (unattendedOwnsInput(ctx.huaanworkUnattended?.current, sessionId)) {
      return Promise.reject(new Error(UNATTENDED_NO_ANSWERER_TEXT));
    }
    let pending: PendingInput | undefined;
    const waiting = new Promise<string>((resolve, reject) => {
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
      pending = {
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
      // 显示失败时 Promise 会被动 reject;登记表必须跟着清掉,否则这张卡会一直算作等待。
      emit({ event: "input/asked", question, sessionId });
    });
    return waiting.finally(() => {
      if (pending && pendingInputs.get(sessionId) === pending) pendingInputs.delete(sessionId);
    });
  };

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
