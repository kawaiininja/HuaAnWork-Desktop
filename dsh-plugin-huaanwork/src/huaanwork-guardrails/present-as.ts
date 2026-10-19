import { sessionIdOfAgentRef } from "@huaanwork/policy/channels";
import type { ToolPresentationMode } from "@deepseek-ai/dsh-tools";

import type { AttachmentMaps } from "./agent-attachments.ts";

function isDisabledPresentationMode(mode: unknown): mode is "ptc" | "both" {
  return mode === "ptc" || mode === "both";
}

const ALLOWED_TOOLS = new Set([
  "read",
  "read_file",
  "glob",
  "grep",
  "edit",
  "write",
  "str_replace_editor",
  "bash",
  "pwsh",
  "skill",
  "subagent",
  "todo_write",
  "git_status",
  "git_diff",
  "git_branch",
  "git_checkout",
  "git_commit",
  "git_push",
  "web_fetch",
  "screenshot",
  "call_host_tool",
  "propose_plan",
  "request_input",
]);

type ToolsService = { // 上游未导出;已逐字比对 0.1.6-alpha.2:core/tools/src/index.ts:584(ToolRuntime.presentAs)
  restrict(filter: { allow: readonly string[] }): () => void;
  schemas(): readonly { name?: string }[];
};

type Agent = {
  id?: string;
  session?: { id?: string };
  ctx?: {
    get?(name: string): ToolsService | undefined;
  };
  cancel?: (reason: { kind: "parent" }) => void;
};

export type Context = { // 上游未导出;已逐字比对 0.1.6-alpha.2:core/tools/src/index.ts(Cordis ctx 无单独类型导出)
  huaanworkAttachments?: AttachmentMaps;
  huaanworkEmit?: (event: { event: "session/end"; ok: false; error: string }) => void;
  tools: {
    presentAs(mode: ToolPresentationMode): () => void;
    schemas?(): readonly { name?: string }[];
  };
  agents?: {
    list(): readonly Agent[];
  };
  on(
    event: "agent/created" | "agent/pre-step" | "tools/change",
    listener: (event: { agent?: Agent }, next?: () => unknown) => unknown,
  ): void;
};

export const inject = ["agents", "tools"];

type ContextState = {
  restrict: (agent: Agent) => void;
  restrictAll: () => void;
  restrictSession: (sessionId: string) => void;
};

const RESTRICT_STATE = Symbol.for("huaanwork.presentAs.restrictState");
const contextStates = new WeakMap<object, ContextState>();

export function refreshAgentRestrict(ctx: Context, sessionId?: string): void {
  const root = (ctx as unknown as { root?: object }).root;
  const state =
    (ctx as unknown as Record<symbol, ContextState | undefined>)[RESTRICT_STATE] ??
    contextStates.get(ctx) ??
    (root ? (root as unknown as Record<symbol, ContextState | undefined>)[RESTRICT_STATE] : undefined) ??
    (root && typeof root === "object" ? contextStates.get(root) : undefined);
  if (!state) {
    console.error("refreshAgentRestrict: restrict state not found (ctx/root 均未注册 present-as state)");
    return;
  }
  if (!sessionId) {
    state.restrictAll();
    return;
  }
  state.restrictSession(sessionId);
}

export function apply(ctx: Context): void {
  // D3(0.1.6-alpha.2):presentAs 需 agent.ctx;全局呈现锁走 tools row 的 mode: native
  const presentAs = ctx.tools.presentAs.bind(ctx.tools);
  ctx.tools.presentAs = (mode) => {
    if (isDisabledPresentationMode(mode)) {
      ctx.huaanworkEmit?.({
        event: "session/end",
        ok: false,
        error: "Code mode is disabled",
      });
      throw new Error(`tools.presentAs("${mode}") is disabled by HuaAnWork`);
    }
    return presentAs(mode);
  };

  // 按 agent 对象持有 disposer（键随 agent 回收）：同 session 的主/子代理互不顶掉，
  // 也不会随会话数无界增长。sessionId 仅用于查附件集，不作键。
  const lifted = new WeakMap<Agent, () => void>();
  let applying = false;

  const restrictInternal = (agent: Agent) => {
    const tools = agent.ctx?.get?.("tools");
    if (!tools) return;
    lifted.get(agent)?.();
    lifted.delete(agent);
    const sessionId = sessionIdOfAgentRef(agent);
    const extra = sessionId ? ctx.huaanworkAttachments?.sessionAgentTools.get(sessionId) : undefined;
    const allowed = tools.schemas().flatMap((schema) => {
      const name = schema.name;
      if (!name) return [];
      if (ALLOWED_TOOLS.has(name) || extra?.has(name)) return [name];
      return [];
    });
    if (allowed.length === 0) return;
    const disposer = tools.restrict({ allow: allowed });
    lifted.set(agent, disposer);
  };

  const runWithApplying = (fn: () => void) => {
    if (applying) return;
    applying = true;
    try {
      fn();
    } finally {
      applying = false;
    }
  };

  const restrict = (agent: Agent) => {
    runWithApplying(() => restrictInternal(agent));
  };

  const restrictAll = () => {
    runWithApplying(() => {
      for (const agent of ctx.agents?.list?.() ?? []) restrictInternal(agent);
    });
  };

  const restrictSession = (sessionId: string) => {
    runWithApplying(() => {
      for (const agent of ctx.agents?.list?.() ?? []) {
        if (sessionIdOfAgentRef(agent) === sessionId) restrictInternal(agent);
      }
    });
  };

  const state: ContextState = { restrict, restrictAll, restrictSession };
  contextStates.set(ctx, state);
  try {
    (ctx as unknown as Record<symbol, unknown>)[RESTRICT_STATE] = state;
  } catch {
    // ignore
  }
  const root = (ctx as unknown as { root?: object }).root;
  if (root && typeof root === "object") {
    contextStates.set(root, state);
    try {
      (root as unknown as Record<symbol, unknown>)[RESTRICT_STATE] = state;
    } catch {
      // ignore
    }
  }

  restrictAll();
  ctx.on("agent/created", ({ agent }) => {
    if (!agent) return;
    restrict(agent);
  });
  ctx.on("tools/change", () => restrictAll());
  ctx.on("agent/pre-step", (event, next) => {
    const agent = event?.agent ?? ctx.agents?.list()[0];
    if (agent?.ctx?.get?.("tools")?.schemas().some((schema) => schema.name === "run_code")) {
      ctx.huaanworkEmit?.({
        event: "session/end",
        ok: false,
        error: "Code mode is disabled",
      });
      agent.cancel?.({ kind: "parent" });
      return { kind: "reject" };
    }
    return typeof next === "function" ? next() : undefined;
  });
}
