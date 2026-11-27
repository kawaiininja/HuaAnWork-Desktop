import { sessionIdOfAgentRef } from "@huaanwork/policy/channels";
import type { ToolPresentationMode } from "@deepseek-ai/dsh-tools";
import { parentSessionOf } from "../huaanwork-host/child-sessions.ts";

import type { AttachmentMaps } from "./agent-attachments.ts";

function isDisabledPresentationMode(mode: unknown): mode is "ptc" | "both" {
  return mode === "ptc" || mode === "both";
}

/** Agent disposal can race a scheduled tools/change; Cordis reports it as an inactive scope. */
export function isInactiveContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("inactive context");
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
  "todo_write",
  "get_goal",
  "create_goal",
  "update_goal",
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
  "exit_plan_mode",
]);

type ToolsService = { // 上游未导出;已逐字比对 0.1.6-alpha.2:core/tools/src/index.ts:584(ToolRuntime.presentAs)
  restrict(filter: { allow: readonly string[] }): () => void;
  schemas(): readonly { name?: string }[];
};

type Agent = {
  id?: string;
  session?: { id?: string; header?: { parentSession?: unknown } };
  ctx?: {
    get?(name: string): ToolsService | undefined;
  };
  cancel?: (reason: { kind: "parent" }) => void;
};

export type Context = { // 上游未导出;已逐字比对 0.1.6-alpha.2:core/tools/src/index.ts(Cordis ctx 无单独类型导出)
  huaanworkAttachments?: AttachmentMaps;
  huaanworkUnattended?: { has(sessionId: string): boolean };
  huaanworkPackageChildAllow?: Map<string, readonly string[]>;
  /**
   * 按会话的显式工具白名单(知识库整理槽等)。有条目时可见集 = 条目 ∩
   * (ALLOWED_TOOLS ∪ 附件);交集为空且 schema 已就绪时 `restrict({ allow: [] })`。
   *
   * 刻意不读 `huaanworkPackageChildAllow`(2026-11-27 owner 裁定 G-M1 方案一):
   * 该表只保留 `hideSkill` 判定语义,包儿童收窄仍由 `skills.ts` 的
   * `allow ∩ schemas` 完成,`@agent` 路径零改动。
   */
  huaanworkSessionToolAllow?: Map<string, readonly string[]>;
  huaanworkEmit?: (event: { event: "session/end"; ok: false; error: string; sessionId?: string }) => void;
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
  // Without an attachment table there is no session-level tool delta to merge;
  // mount-time and tools/change restrictions already cover the base allowlist.
  // Contexts such as the Windows acceptance fixture call this while disposing.
  if (ctx.huaanworkAttachments === undefined) return;
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
      // No sessionId here: emitting session/end would fall back to the live tab
      // and mark it failed. The mounting plugin's rejection is the whole signal.
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
    // 上游在子会话 header 记录 `parentSession`(父会话 id),早于 subagent/start 的
    // 登记表:创建期(agents.create 已发生、registerChildSession 尚未)也能判别儿童。
    const headerParent = agent.session?.header?.parentSession;
    const headerParentId =
      typeof headerParent === "string"
        ? headerParent.length > 0
          ? headerParent
          : undefined
        : sessionIdOfAgentRef(headerParent as { id?: string; session?: { id?: string } } | undefined);
    // R2:父会话可调用 `skill` 加载系统技能;无人值守自动化与 legacy/system-skill 儿童
    // 维持不可见(他们的派发只能走显式 @ / 包血缘 / 系统技能租约)。
    const hideSkill = sessionId !== undefined && (
      ctx.huaanworkUnattended?.has(sessionId) === true
      || ((parentSessionOf(sessionId) !== undefined || headerParentId !== undefined) && ctx.huaanworkPackageChildAllow?.has(sessionId) !== true)
    );
    const schemas = tools.schemas();
    const visible = schemas.flatMap((schema) => {
      const name = schema.name;
      if (!name) return [];
      if (name === "skill" && hideSkill) return [];
      if (ALLOWED_TOOLS.has(name) || extra?.has(name)) return [name];
      return [];
    });
    // 会话级显式白名单:只与上面算出的可见集取交集,不看 `huaanworkPackageChildAllow`。
    const sessionAllow = sessionId ? ctx.huaanworkSessionToolAllow?.get(sessionId) : undefined;
    const allowed = sessionAllow === undefined
      ? visible
      : visible.filter((name) => sessionAllow.includes(name));
    if (allowed.length === 0) {
      // 老行为:没有显式白名单且交集为空(通常是 schema 还没注册)时不动。
      if (sessionAllow === undefined) return;
      // schema 尚未注册时交集必然为空,此刻锁死会让随后注册的合法工具全部不可见;
      // 留待 `tools/change` 重放时再收窄。
      if (schemas.length === 0) return;
      // 有显式白名单、schema 已就绪、交集仍为空:必须 fail closed 成空集,
      // 否则 restrict 被跳过就退化成"基线白名单全放行"(原 L156 的 fail-open)。
    }
    let disposer: (() => void) | undefined;
    try {
      disposer = tools.restrict({ allow: allowed });
    } catch (error) {
      // The agent can be disposed between list() and restrict(); its tool scope
      // is gone, so there is nothing left to narrow.
      if (isInactiveContextError(error)) return;
      throw error;
    }
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
      const sessionId = sessionIdOfAgentRef(agent);
      ctx.huaanworkEmit?.({
        event: "session/end",
        ok: false,
        error: "Code mode is disabled",
        ...(sessionId ? { sessionId } : {}),
      });
      agent.cancel?.({ kind: "parent" });
      return { kind: "reject" };
    }
    return typeof next === "function" ? next() : undefined;
  });
}
