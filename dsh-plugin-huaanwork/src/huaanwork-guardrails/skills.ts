import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_AGENT_ALLOW as EXPLORE_TOOLS } from "@huaanwork/policy/agent-catalog";
import { SKILL_NAME_RE, parseSkillMarkdown } from "@huaanwork/skill-format/markdown";
import type { ParsedSkillMarkdown } from "@huaanwork/skill-format/markdown";
import type { SubagentCleanupWarning } from "../client-huaanwork/rpc-types.ts";
import { acceptanceCleanupTimeoutMs } from "../huaanwork-host/acceptance-hooks.ts";
import { ACTIVATION_CLEANUP_TIMEOUT_MS } from "../huaanwork-host/agent-package/host.ts";
import { errorText, stopReasonOf } from "../huaanwork-host/agent-invoke.ts";
import { forgetChildSession, registerChildSession } from "../huaanwork-host/child-sessions.ts";
import { disposeActivationWithTimeout, settleWithin, waitResultWithBudget } from "../huaanwork-host/subagent-cleanup.ts";
import {
  acquireSystemSkillLease,
  isUnmanagedChildSession,
  systemSkillLeaseKindOf,
  type SystemSkillLeaseStore,
} from "../huaanwork-host/system-skill-leases.ts";
import {
  AGENT_PACKAGE_CHILD_TOOLS,
  agentPackageChildAttachmentNames,
  attachAgentTools,
  type AttachmentMaps,
} from "./agent-attachments.ts";
import { isInactiveContextError, refreshAgentRestrict } from "./present-as.ts";
import type { AgentPackageSubagentRequest } from "../huaanwork-host/agent-package/types.ts";
import type { SubagentRunRegistry } from "../huaanwork-host/subagent-runs.ts";
import type { TurnAnchorStore } from "../huaanwork-host/turn-anchors.ts";
import {
  legacyAgentRequestOf,
  subagentRunIdOf,
  type LegacyAgentRequest,
} from "../huaanwork-host/subagents-service.ts";

export const name = "huaanwork-skills";
export const inject = ["skills", "agents", "tools", "subagents"];

export { EXPLORE_TOOLS };
export const TEST_FIX_BASE_TOOLS = [
  "read",
  "read_file",
  "glob",
  "grep",
  "edit",
  "write",
  "str_replace_editor",
] as const;

export type SkillKind = "explore" | "test-fix";

type ToolsService = { // 上游未导出;已逐字比对 0.1.6-alpha.2:core/tools/src/index.ts:485(ToolRestriction)
  restrict?(filter: { allow: readonly string[] }): () => void;
  schemas?(): readonly { name?: string }[];
  guard?(listener: (execution: { name: string; arguments: unknown }) => string | undefined): () => void;
};

type Agent = {
  ctx?: {
    get?(name: string): ToolsService | undefined;
  };
  session?: { header?: { parentSession?: unknown } };
};

type SkillRegistration = {
  name: string;
  description: string;
  content: string;
  source: "runtime" | "bundled";
  resourceBase?: { kind: "directory"; path: string };
};

/**
 * `startActivation` 返回值中包装消费的成员:子会话 id、本地子 agent、权威结果与释放。
 *
 * `childId` 保持 `unknown` 边界解析(由 `sessionIdOf` 校验);`result` 与 `dispose`
 * 是上游 receipt 恒有的成员,声明为必填后可直接传给只消费 `.dispose()` 的清理 helper。
 */
type ActivationRun = {
  childId?: unknown;
  localAgent?: Agent;
  /** 权威执行结果;resolve → `settleResult`,reject → `rejectResult`。 */
  result: Promise<unknown>;
  /** fail closed 时释放本次 activation。 */
  dispose(): Promise<void>;
};

type Context = { // 上游未导出;已逐字比对 0.1.6-alpha.2:Cordis ctx 跨 skills/agents/tools/subagents 四服务,无统一类型导出
  skills: {
    register(skill: SkillRegistration): () => void;
  };
  agents?: {
    get?(id: string): Agent | undefined;
    list?(): readonly Agent[];
  };
  subagents?: {
    start(...args: never[]): Promise<{ localAgent?: Agent }>;
    startActivation?(...args: never[]): Promise<ActivationRun | undefined>;
  };
  huaanworkAgentRequest?: {
    current?: LegacyAgentRequest | undefined;
  };
  /** `@slug` 包回合请求;dispatch 在 startActivation 之前写入,activation 包装消费。 */
  huaanworkAgentPackageRequest?: { current?: AgentPackageSubagentRequest | null };
  /**
   * 子代理 run 权威状态机(index 注入)。activation 包装把本次 Host runId 与上游
   * `subagent/start` 的 runId 对齐并核对三方 parent;系统技能派生在首个 await 前
   * 用同一 registry 建立 `system-skill` 运行并接线定向取消。缺席时 legacy 路径
   * 只保留原有登记与工具护栏,系统技能派生则响亮失败。
   */
  huaanworkSubagentRuns?: Pick<
    SubagentRunRegistry,
    | "begin"
    | "reserveChild"
    | "bindActivation"
    | "bindUpstreamStart"
    | "attachCancel"
    | "failRun"
    | "settleResult"
    | "rejectResult"
    | "confirmCleanup"
    | "noteCleanupBudget"
    | "settleUpstreamEnd"
    | "parentSessionIdOf"
  >;
  /** Task 1 的共享回合锚点:system-skill run 的 clientMessageId 只取自它,无锚不带。 */
  huaanworkTurnAnchors?: Pick<TurnAnchorStore, "current">;
  /** 会话工具附件表;包运行时工具与 MCP 名字按子会话挂载。 */
  huaanworkAttachments?: AttachmentMaps;
  /** 包回合血缘允许表(C2):孙代收窄继承读父条目、写同引用条目(C4)。 */
  huaanworkPackageChildAllow?: Map<string, readonly string[]>;
  /** 宿主创建的会话模型绑定表(Task 6 登记);这里只在子会话开始/结束时复制与删除。 */
  huaanworkSessionModels?: Map<string, string>;
  /** 宿主创建的会话可写根表(Task 6 登记);子会话开始/结束时同样复制与删除。 */
  huaanworkSessionRoots?: Map<string, string>;
  /** 系统技能回合租约(holders 注入);模型 `skill` 入口取租约,显式入口由 sessions 接线。 */
  huaanworkSystemSkillLeases?: SystemSkillLeaseStore;
  /** 租约注入可能晚于本插件 apply;holders 创建 store 后调用以注册失效清理。 */
  huaanworkRegisterSystemSkillLeaseInvalidation?: () => void;
  on(
    event:
      | "tools/pre-execute"
      | "tools/execute"
      | "tools/result"
      | "agent/created"
      | "agent/disposed"
      | "subagent/start"
      | "subagent/end"
      | "tools/change",
    listener: (...args: never[]) => unknown,
    prepend?: boolean,
  ): void;
};

const kinds = new WeakMap<object, SkillKind>();

export function skillKindOf(agent: object | undefined): SkillKind | undefined {
  return agent ? kinds.get(agent) : undefined;
}

/**
 * 只读测试钩:当前 `tools/execute` 派发作用域内的技能类型(`spawnKind.getStore()`)。
 *
 * 必须由当前 apply 实例注册探针;没有实例时返回 undefined。钉住 PC-1:kind 在 body
 * 阶段可见——若把 ALS 错挂到 `tools/pre-execute`,这里必然为 undefined。
 */
let currentSpawnKindProbe: (() => SkillKind | undefined) | undefined;

export function currentDispatchSkillKind(): SkillKind | undefined {
  return currentSpawnKindProbe?.();
}

export function shellToolName(platform = process.platform): "pwsh" | "bash" {
  return platform === "win32" ? "pwsh" : "bash";
}

export function exploreAllowList(existing: readonly string[]): string[] {
  return EXPLORE_TOOLS.filter((name) => existing.includes(name));
}

export type ExploreTurnEntry = { scope: "child" | "parent"; text: string };

/** 子代理中间步骤留在 child 日志;父会话只拼接 parent 范围的结论。 */
export function parentVisibleExploreTranscript(entries: readonly ExploreTurnEntry[]): string {
  return entries.filter((entry) => entry.scope === "parent").map((entry) => entry.text).join("");
}

export function testFixAllowList(existing: readonly string[], platform = process.platform): string[] {
  return [...TEST_FIX_BASE_TOOLS, shellToolName(platform)].filter((name) => existing.includes(name));
}

export function wantedTools(kind: SkillKind, platform = process.platform): readonly string[] {
  return kind === "explore" ? EXPLORE_TOOLS : [...TEST_FIX_BASE_TOOLS, shellToolName(platform)];
}

let bundledSkillContext: Context | null = null;

export function getBundledSkillRegistrar(): Context | null {
  return bundledSkillContext;
}

export function setBundledSkillRegistrar(ctx: Context | null): void {
  bundledSkillContext = ctx;
}

export function apply(ctx: Context): void {
  bundledSkillContext = ctx;
  const pendingByAgent = new WeakMap<object, SkillKind>();
  /** 写过 pendingByAgent 的父代理按会话登记:租约失效/释放时精确清理,不依赖跨监听次序。 */
  const pendingAgentsBySession = new Map<string, Set<Agent>>();
  const tracked = new Set<Agent>();
  const lifted = new WeakMap<Agent, () => void>();
  let restricting = false;

  const forget = (agent: Agent) => {
    tracked.delete(agent);
    kinds.delete(agent);
    lifted.delete(agent);
  };

  // spawnKind:技能类型跨越 `tools/pre-execute` → `tools/execute` → body 的唯一载体。
  //
  // 上游事实(PC-1):`execute = prepareExecution(exec, prepared => completeScheduledExecution(prepared))`
  // (core/tools/src/index.ts:1377-1379);`prepareExecution` 的 `tools/pre-execute`
  // waterfall 终止回调只返回 `{kind:'allow'}`(:1513-1516),解析完后才
  // `next({kind:'dispatch', exec})`(:1543);body 在 `dispatchScheduledExecution` 的
  // `tools/execute` waterfall 终止回调 `dispatchToolBody` 里执行(:1609-1616 →
  // :1572-1600 → `tool.execute` :1589)。**pre-execute 里建立的 ALS 作用域到 body
  // 阶段已出栈,读不到技能类型** —— 唯一修法是把 kind 挂到 tools/execute。
  type PendingSpawnSlot = { kind: SkillKind; token: symbol; agent?: object };
  const spawnKind = new AsyncLocalStorage<SkillKind | undefined>();
  currentSpawnKindProbe = () => spawnKind.getStore();
  let pendingSpawn: PendingSpawnSlot | undefined;
  const slotByExecution = new WeakMap<object, PendingSpawnSlot>();
  const slotsByParent = new WeakMap<object, PendingSpawnSlot[]>();

  // 兼容槽的精确消费:token 相同才清。并发重叠时另一路写入的槽不归本次调用。
  const releaseOwnedSlot = (slot: PendingSpawnSlot | undefined) => {
    if (slot !== undefined && pendingSpawn?.token === slot.token) pendingSpawn = undefined;
  };

  const removeSlotFromParent = (agent: object | undefined, slot: PendingSpawnSlot) => {
    if (agent === undefined) return;
    const queue = slotsByParent.get(agent);
    if (queue === undefined) return;
    const idx = queue.indexOf(slot);
    if (idx >= 0) queue.splice(idx, 1);
    if (queue.length === 0) slotsByParent.delete(agent);
  };

  const clearExecutionSlot = (execution: object, agent?: object) => {
    const slot = slotByExecution.get(execution);
    if (slot === undefined) return;
    slotByExecution.delete(execution);
    removeSlotFromParent(agent ?? slot.agent, slot);
    releaseOwnedSlot(slot);
  };

  const takeSlotForExecute = (execution: { agent?: object }): PendingSpawnSlot | undefined => {
    const byExec = slotByExecution.get(execution);
    if (byExec !== undefined) {
      slotByExecution.delete(execution);
      removeSlotFromParent(execution.agent ?? byExec.agent, byExec);
      return byExec;
    }
    return execution.agent === undefined ? undefined : slotsByParent.get(execution.agent)?.shift();
  };

  // subagent/start 在 start 的异步链内同步派发且载荷不带 parent；按调用隔离，重叠的 start 不会互相覆盖。
  const startParent = new AsyncLocalStorage<string | undefined>();
  // startActivation 的 Host runId 作用域：subagent/start 在同一异步链里派发，
  // 监听器据此把上游 run 绑定到本次 @ 的运行卡；没有 runId 时显式覆盖为 undefined。
  // R1/R5：普通父会话的模型面已不可达 `subagent`；仍走嵌套派发的只剩 system-skill
  // 运行(Task 3)与包 lane 血缘(一期不独立建卡)，没有 Host runId 时都不误绑外层 run。
  const startRun = new AsyncLocalStorage<string | undefined>();

  ctx.skills.register(loadSkill("explore.md"));
  ctx.skills.register(loadSkill("test-fix.md"));

  const rememberSkill = (execution: { name: string; arguments: unknown; agent?: object }) => {
    if (execution.name !== "skill" || !execution.agent) return;
    const skillName = stringArg(execution.arguments, "name");
    if (skillName === "explore" || skillName === "test-fix") {
      pendingByAgent.set(execution.agent, skillName);
      // 按会话登记持有 pendingByAgent 的父代理:租约失效/释放时精确清理(QR-I2)。
      const sessionId = sessionIdOf(execution.agent);
      if (sessionId !== undefined) {
        const agents = pendingAgentsBySession.get(sessionId) ?? new Set<Agent>();
        agents.add(execution.agent as Agent);
        pendingAgentsBySession.set(sessionId, agents);
      }
    }
  };

  const rememberSubagentSpawn = (execution: { name: string; arguments: unknown; agent?: object }) => {
    if (execution.name !== "subagent") return;
    // 技能类型来源:同 agent 的模型 skill 缓存优先;显式 /explore、/test-fix 回合
    // 只有共享租约,按会话回落到 kindOf。
    const sessionId = sessionIdOf(execution.agent);
    const kind =
      (execution.agent === undefined ? undefined : pendingByAgent.get(execution.agent)) ??
      (sessionId === undefined ? undefined : systemSkillLeaseKindOf(ctx, sessionId));
    if (kind === undefined) return;
    const slot: PendingSpawnSlot = {
      kind,
      token: Symbol(),
      ...(execution.agent === undefined ? {} : { agent: execution.agent }),
    };
    slotByExecution.set(execution, slot);
    if (execution.agent !== undefined) {
      const queue = slotsByParent.get(execution.agent);
      if (queue === undefined) slotsByParent.set(execution.agent, [slot]);
      else queue.push(slot);
    }
    // 模块内兼容槽:无 ALS 的消费点(startActivation 包装)仍按最近一次派发回落。
    pendingSpawn = slot;
  };

  const restrictKind = (agent: Agent, kind: SkillKind) => {
    const tools = agent.ctx?.get?.("tools");
    if (!tools) return;
    lifted.get(agent)?.();
    const existing = (tools.schemas?.() ?? []).flatMap((schema) => (schema.name ? [schema.name] : []));
    const allow = kind === "explore" ? exploreAllowList(existing) : testFixAllowList(existing);
    if (allow.length === 0) return;
    try {
      lifted.set(agent, tools.restrict?.({ allow }) ?? (() => undefined));
    } catch (error) {
      // A disposed child must not poison the activation that triggered tools/change.
      if (isInactiveContextError(error)) {
        forget(agent);
        return;
      }
      throw error;
    }
  };

  const applyKind = (agent: Agent, kind: SkillKind) => {
    if (kinds.has(agent)) return;
    kinds.set(agent, kind);
    tracked.add(agent);
    try {
      restrictKind(agent, kind);
      const tools = agent.ctx?.get?.("tools");
      const allowed = new Set(wantedTools(kind));
      tools?.guard?.((execution) => (allowed.has(execution.name) ? undefined : `huaanwork-${kind}`));
    } catch (error) {
      if (isInactiveContextError(error)) {
        forget(agent);
        return;
      }
      throw error;
    }
  };

  const consumePendingSpawn = (agent: Agent) => {
    const fromAls = spawnKind.getStore();
    const kind = fromAls ?? pendingSpawn?.kind;
    if (!kind) return;
    if (pendingByAgent.has(agent)) return;
    applyKind(agent, kind);
    // 只有无 ALS 覆盖的回落路径消费完单槽时清零。
    if (fromAls === undefined) pendingSpawn = undefined;
  };

  /** 租约释放/显式重挂:清掉该会话父代理的 pendingByAgent 与残留派发槽。 */
  const invalidateSessionSpawnState = (sessionId: string) => {
    const agents = pendingAgentsBySession.get(sessionId);
    if (agents === undefined) return;
    pendingAgentsBySession.delete(sessionId);
    for (const agent of agents) {
      pendingByAgent.delete(agent);
      const queue = slotsByParent.get(agent);
      if (queue === undefined) continue;
      // 并行 runGroup 兄弟异常可能跳过 tools/result:这里按父代理兜底清槽,不留陈旧
      // kind 污染后续显式 @;兼容单槽只在 token 匹配时释放。
      for (const slot of queue) releaseOwnedSlot(slot);
      slotsByParent.delete(agent);
    }
  };
  const invalidationStores = new WeakSet<object>();
  const registerLeaseInvalidation = () => {
    const store = ctx.huaanworkSystemSkillLeases;
    if (store === undefined || invalidationStores.has(store)) return;
    invalidationStores.add(store);
    store.onInvalidate(invalidateSessionSpawnState);
  };
  ctx.huaanworkRegisterSystemSkillLeaseInvalidation = registerLeaseInvalidation;
  registerLeaseInvalidation();

  ctx.on(
    "tools/pre-execute",
    (async (
      execution: { name: string; arguments: unknown; agent?: object },
      next: () => Promise<{ kind: string; reason?: string }>,
    ) => {
      const requestedSkill = execution.name === "skill" ? stringArg(execution.arguments, "name") : "";
      if (requestedSkill === "explore" || requestedSkill === "test-fix") {
        const sessionId = sessionIdOf(execution.agent);
        if (sessionId !== undefined) {
          // 受管儿童判别必须在 rememberSkill **之前**:拒绝或无锚/无人值守返回 false 时
          // 都不得在 pendingByAgent 留下陈旧缓存。
          if (isUnmanagedChildSession(ctx, sessionId)) {
            return { kind: "deny", reason: "unmanaged-child-system-skill" };
          }
          // 仅当租约真正挂载成功才写 pendingByAgent;false 时技能仍按现有规则执行,
          // 但模型看不到 `subagent`。
          if (acquireSystemSkillLease(ctx, sessionId, requestedSkill)) rememberSkill(execution);
        }
      } else {
        rememberSkill(execution);
      }
      // 已收窄的子代理(explore/test-fix)先拒绝越权工具,再考虑生成派发槽。
      const kind = skillKindOf(execution.agent);
      if (kind && !wantedTools(kind).includes(execution.name)) {
        return { kind: "deny", reason: `huaanwork-${kind}` };
      }
      rememberSubagentSpawn(execution);
      const slot = slotByExecution.get(execution);
      if (slot === undefined) return next();
      // 下游拒绝/抛错(含 workspace-changes 等待后的取消与 tools.guard 拒绝)按同一
      // execution 对象精确回收,不按 FIFO 误拿其他调用的槽。
      try {
        const decision = await next();
        if (decision.kind !== "allow") clearExecutionSlot(execution, execution.agent);
        return decision;
      } catch (error) {
        clearExecutionSlot(execution, execution.agent);
        throw error;
      }
    }) as never,
    true,
  );

  // PC-1 唯一修法:技能类型随 `tools/execute` 的 around-dispatch 进入 body 阶段。
  // 优先取本次调用的精确槽,其次同 agent 的模型 skill 缓存,最后回落共享租约
  // (显式 /explore、/test-fix 回合没有 skill 工具调用)。
  ctx.on(
    "tools/execute",
    ((execution: { name: string; agent?: object }, next: () => Promise<unknown>) => {
      if (execution.name !== "subagent") return next();
      const slot = takeSlotForExecute(execution);
      // 进入 ALS 作用域前立即释放归属本次调用的兼容槽(若已被他方无 ALS 路径覆写则
      // token 不等、不误清)。
      releaseOwnedSlot(slot);
      const sessionId = sessionIdOf(execution.agent);
      const kind =
        slot?.kind ??
        (execution.agent === undefined ? undefined : pendingByAgent.get(execution.agent)) ??
        (sessionId === undefined ? undefined : systemSkillLeaseKindOf(ctx, sessionId));
      return spawnKind.run(kind, () => next());
    }) as never,
    true,
  );

  // QR-I1:tools/pre-execute 返回 allow 后,若等待期(如 workspace-changes recorder.settled())
  // 发生取消或被 tools.guard 拒绝,上游 prepareExecution 直接返回 post-result 跳过
  // tools/execute 并触发 tools/result。这里同步按同一 execution 对象精确幂等清理,
  // 不按 FIFO 误拿其他调用的槽;正常派发下已在 takeSlotForExecute 摘除,此处为 no-op。
  ctx.on(
    "tools/result",
    ((execution: { name?: string; agent?: object }) => {
      if (execution?.name !== "subagent") return;
      clearExecutionSlot(execution, execution.agent);
    }) as never,
    true,
  );

  ctx.on("agent/created", (({ agent }: { agent: Agent }) => {
    consumePendingSpawn(agent);
  }) as never);

  ctx.on("agent/disposed", (({ agent }: { agent: Agent }) => {
    forget(agent);
  }) as never);

  ctx.on("subagent/start", ((info: { id?: string; runId?: string }) => {
    if (!info.id) return;
    // Host runId 由 startActivation 包装经 ALS 带到这里。上游 runId 与 childId 都非空
    // 才绑定:模型自主创建的嵌套子代理没有 Host runId,不绑运行卡;父会话登记只看
    // 子会话 header 与本次 activation 的父会话(见下),两处都没有就不登记。
    const hostRunId = startRun.getStore();
    if (hostRunId !== undefined && typeof info.runId === "string" && info.runId.length > 0) {
      // 登记表 parent 已知时只认与本次 activation 父会话一致的那次 start:不一致的
      // 绑定会被下面的包装判为 parent mismatch 并 dispose,而 rebind 已经改写了 run 的
      // identity。parent 未知(测试里 start 可能先于登记)仍交给 registry 按 runId 查。
      const registryParent = ctx.huaanworkSubagentRuns?.parentSessionIdOf(hostRunId);
      const activationParent = startParent.getStore();
      if (registryParent === undefined || registryParent === activationParent) {
        ctx.huaanworkSubagentRuns?.bindUpstreamStart({
          hostRunId,
          upstreamRunId: info.runId,
          childId: info.id,
        });
      }
    }
    const child = ctx.agents?.get?.(info.id);
    // 事件载荷只有 { runId, provider, id, local },没有 parent;父会话取自子会话 header,
    // 冷恢复路径靠它,start 包装路径靠下面的 AsyncLocalStorage。两者都没有就不登记:
    // R1 下普通父会话模型面已不可达 `subagent`,仍可能无父会话的嵌套派发(system-skill
    // 运行 Task 3 / 包 lane 血缘)不继承任何进程级会话的模型或可写根。
    const parentId = sessionIdOf(child?.session?.header?.parentSession) ?? startParent.getStore();
    if (parentId && parentId !== info.id) {
      registerChildSession(parentId, info.id);
      inheritSessionModel(ctx.huaanworkSessionModels, parentId, info.id);
      inheritSessionRoot(ctx.huaanworkSessionRoots, parentId, info.id);
    }
    if (child) consumePendingSpawn(child);
  }) as never);

  // 与 subagent/start 成对的结束事件(载荷 id 即子会话 id):子会话结束后从登记表摘掉,
  // 否则取消父会话时会对已经退出的会话重复发起取消,登记表也无界增长。
  ctx.on("subagent/end", ((info: { id?: string; runId?: string; stopReason?: string }) => {
    // 严格按 upstreamRunId 配对:旧 end 只结算旧 run,未知 id 由 registry 忽略,
    // 不得按 childId 或「最近一次 start」改写新 run 的状态或登记。
    if (typeof info.runId === "string" && info.runId.length > 0) {
      ctx.huaanworkSubagentRuns?.settleUpstreamEnd({
        upstreamRunId: info.runId,
        stopReason: info.stopReason ?? "unknown",
      });
    }
    if (typeof info.id === "string" && info.id.length > 0) {
      forgetChildSession(info.id);
      ctx.huaanworkSessionModels?.delete(info.id);
      ctx.huaanworkSessionRoots?.delete(info.id);
    }
  }) as never);

  ctx.on("tools/change", (() => {
    if (restricting) return;
    restricting = true;
    try {
      for (const agent of tracked) {
        const kind = kinds.get(agent);
        if (kind) restrictKind(agent, kind);
      }
    } finally {
      restricting = false;
    }
  }) as never);

  const start = ctx.subagents?.start;
  if (start && ctx.subagents) {
    const original = start.bind(ctx.subagents);
    ctx.subagents.start = async (...args: never[]) => {
      // 在 await 之前取快照:dispatch 的 finally 会在 run 结束后清空容器。
      const pkg = ctx.huaanworkAgentPackageRequest?.current;
      const current = ctx.huaanworkAgentRequest?.current;
      // 调用形态以探针 3 核实的 (name, request) 签名为准（dispatchAt 显式传 parent/signal），直通不改写。
      // 事件载荷没有 parent；父会话只取这次 start 的 parent，缺省即无父会话。
      const parentFromCall = sessionIdOf(parentFromStartArgs(args));
      // 血缘条目与父会话同在 await 之前取快照。`current` 是进程级 legacy marker，可能属于
      // 另一会话的在途 `@agent` 回合；本次派发的父会话已有血缘条目时，血缘条目是权威的
      // (C4 与 activation 路径同形)，不能被那个回合的 allow 求交、也不得因此跳过收窄。
      const inherited =
        parentFromCall === undefined ? undefined : ctx.huaanworkPackageChildAllow?.get(parentFromCall);
      const legacyApplies = current !== undefined && inherited === undefined;
      try {
        if (legacyApplies && current) {
          if (!current.persona || current.persona.trim() === "") {
            throw new Error("智能体人设为空");
          }
        }
        const run: any = await startParent.run(parentFromCall, () => original(...args));
        let packageApplied = false;
        if (legacyApplies && current && run?.localAgent) {
          const tools = run.localAgent.ctx?.get?.("tools");
          const schemas = tools?.schemas?.() ?? [];
          const existing = schemas.flatMap((s: { name?: string }) => (s.name ? [s.name] : []));
          const allow = current.allow.filter((name) => existing.includes(name));
          tools?.restrict?.({ allow });
        }
        // Package requests are keyed to the session that dispatched them: a subagent
        // started by any other session while this turn is in flight keeps its own tools
        // and attachments instead of inheriting this package's runtime.
        if (pkg && run?.localAgent && parentFromCall !== undefined && pkg.parentSessionId === parentFromCall) {
          packageApplied = true;
          // header.id 是真实子会话 id;某些 provider 只填 agent/session id,故再回落一次。
          const childSessionId =
            sessionIdOf(run.localAgent.session?.header ?? run.localAgent) ?? sessionIdOf(run.localAgent);
          if (childSessionId) {
            if (ctx.huaanworkAttachments) {
              // PM-2:start 包装(旧 start 签名)按原始常量**无条件** attach,不经 allow
              // 过滤;rc.1 下该路径 dormant,allow 过滤只发生在 activation 包装的
              // agentPackageChildAttachmentNames 路径。真正的可见性收敛在 present-as
              // (`ALLOWED_TOOLS ∪ 附件`)与下面的 `pkg.allow ∩ schemas` 交集。
              // MCP 名字在挂载时先落在父会话上(健康检查要求先拿到工具名),发现后由
              // host 从父会话摘掉;子会话要执行 mcp__* 仍需自己的附件,否则 policy 的
              // attached 判定会拒绝。
              attachAgentTools(ctx.huaanworkAttachments, childSessionId, [
                ...AGENT_PACKAGE_CHILD_TOOLS,
                ...(pkg.runtime.mcpNames ?? []),
              ]);
            }
            // 绑定必须与附件同批完成,且先于 refreshAgentRestrict:present-as 只在附件里
            // 找非 ALLOWED_TOOLS 的名字,晚挂会让它先前算出的 restrict 继续遮住 mcp__*。
            pkg.bindChild(childSessionId);
            refreshAgentRestrict(ctx as never, childSessionId);
          }
          const tools = run.localAgent.ctx?.get?.("tools");
          const schemas = tools?.schemas?.() ?? [];
          const existing = schemas.flatMap((s: { name?: string }) => (s.name ? [s.name] : []));
          const allow = pkg.allow.filter((name) => existing.includes(name));
          tools?.restrict?.({ allow });
        }
        // 血缘分支(C4,start 旧签名回落):与 activation 路径同形。
        // C4 加固:无可解析 childId 先 dispose 再抛,与 activation 路径同形。
        if (!packageApplied && run?.localAgent && parentFromCall !== undefined && inherited !== undefined) {
          const childSessionId =
            sessionIdOf(run.localAgent.session?.header ?? run.localAgent) ?? sessionIdOf(run.localAgent);
          if (childSessionId === undefined) {
            try {
              await run?.dispose?.();
            } catch {
              // 释放失败不能顶替不一致错误,也不能留下未处理的 rejection。
            }
            throw new Error("subagent lineage child id missing");
          }
          const tools = run.localAgent.ctx?.get?.("tools");
          const schemas = tools?.schemas?.() ?? [];
          const existing = schemas.flatMap((s: { name?: string }) => (s.name ? [s.name] : []));
          const allow = inherited.filter((name) => existing.includes(name));
          tools?.restrict?.({ allow });
          ctx.huaanworkPackageChildAllow?.set(childSessionId, inherited);
        }
        if (run?.localAgent) {
          consumePendingSpawn(run.localAgent);
        }
        if (run && typeof run.result?.then === "function") {
          await run.result;
        }
        return run;
      } finally {
        // 只清本次快照:重叠的 activation 不能清掉别处新写入的包/legacy 请求。
        if (
          ctx.huaanworkAgentPackageRequest &&
          pkg !== undefined &&
          pkg !== null &&
          ctx.huaanworkAgentPackageRequest.current === pkg
        ) {
          ctx.huaanworkAgentPackageRequest.current = null;
        }
        if (ctx.huaanworkAgentRequest && current !== undefined && ctx.huaanworkAgentRequest.current === current) {
          ctx.huaanworkAgentRequest.current = undefined;
        }
      }
    };
  }

  const activation = ctx.subagents?.startActivation;
  if (activation && ctx.subagents) {
    const originalActivation = activation.bind(ctx.subagents);
    ctx.subagents.startActivation = async (...args: never[]) => {
      // 在 await 之前取快照:包请求是宿主在 startActivation 之前发布的全局容器;
      // legacy 请求挂在本次调用的 spec 符号键上,不读全局容器。
      const pkg = ctx.huaanworkAgentPackageRequest?.current;
      const legacy = legacyAgentRequestOf(args[0]);
      const parentFromCall = sessionIdOf(parentFromStartArgs(args));
      // Host runId 与请求同一批快照:legacy 写在 spec 符号键上,包写在请求对象上。
      // 符号键随本次 spec 走,直接采信;全局包请求只属于发布它、且带着预留子会话 id
      // 的那次 activation —— 同一窗口里别的 activation(模型 subagent 工具、同会话
      // 并发发起的其他子代理)没带符号或 childId 不符时不得继承它的 run,否则监听器
      // 会改写该 run 的 childId/upstreamRunId。
      const specChildId = (args[0] as { childId?: unknown } | undefined)?.childId;
      const hostRunId =
        subagentRunIdOf(args[0]) ??
        (pkg !== undefined &&
        pkg !== null &&
        pkg.parentSessionId === parentFromCall &&
        specChildId === pkg.childId
          ? pkg.runId
          : undefined);

      // 系统技能派生在第一个 await 之前建立 Host run:客户端要在启动中就看到并定向取消。
      // 包 lane 有血缘条目,不是系统技能运行;上游 `tool-subagent` 的嵌套派发没有
      // Host runId 也没有技能类型,不纳管。
      const skillKind = spawnKind.getStore();
      const registry = ctx.huaanworkSubagentRuns;
      let systemRunId: string | undefined;
      if (
        hostRunId === undefined &&
        parentFromCall !== undefined &&
        skillKind !== undefined &&
        ctx.huaanworkPackageChildAllow?.has(parentFromCall) !== true
      ) {
        if (registry === undefined || typeof registry.begin !== "function") {
          // 装配错误要响亮:禁止 ?.begin 静默派发一个不受管、不可取消的子代理。
          throw new Error("subagent run registry is not initialized");
        }
        const anchor = ctx.huaanworkTurnAnchors?.current(parentFromCall);
        systemRunId = registry.begin({
          parentSessionId: parentFromCall,
          kind: "system-skill",
          label: skillKind,
          ...(anchor?.clientMessageId !== undefined ? { clientMessageId: anchor.clientMessageId } : {}),
        });
      }
      const effectiveRunId = hostRunId ?? systemRunId;

      // 以下生命周期只属于 system-skill(R2):legacy/package 的取消闭包与清理路径不变。
      const system =
        systemRunId === undefined || registry === undefined ? undefined : { runId: systemRunId, registry };
      const controller = new AbortController();
      let activationHandle: ActivationRun | undefined;
      let cancelRequested = false;
      let cancelledAfterPublish = false;
      let cleanupPromise: Promise<void> | undefined;
      let resultObserved: Promise<void> | undefined;
      let failedReported = false;
      /** 验收注入缝:主开关关闭时恒等于 ACTIVATION_CLEANUP_TIMEOUT_MS。 */
      const cleanupTimeoutMs = acceptanceCleanupTimeoutMs(ACTIVATION_CLEANUP_TIMEOUT_MS);

      /** 观察权威 result:resolve → settleResult,reject → rejectResult(绝不是只表示启动失败的 failRun)。 */
      const observeResult = (handle: ActivationRun): Promise<void> =>
        (resultObserved ??= handle.result.then(
          (value) => {
            if (system !== undefined) system.registry.settleResult(system.runId, { stopReason: stopReasonOf(value) });
          },
          (error) => {
            if (system !== undefined) system.registry.rejectResult(system.runId, errorText(error));
          },
        ));

      /**
       * 本次 system-skill 派生唯一的清理实现(`cleanupPromise ??=` 去重):
       *
       * - idle:按 `cleanupTimeoutMs` 等真实 result,超时记收尾预算后转 dispose;
       * - cancel:跳过 graceful 等待,直接 dispose;result 由 `observeResult` 另行观察;
       * - 从未发布 activation:没有资源要释放,局部清理即全部清理;
       * - 只有 dispose fulfilled 才算清理确认;reject/超时追加 error 告警且不确认;
       * - dispose 后的结算观察窗使用独立超时,不吃已 abort 的 `controller.signal`;
       *   超窗用 `rejectResult` 补 `executionEnded`。
       */
      const cleanup = (mode: "idle" | "cancel"): Promise<void> =>
        (cleanupPromise ??= (async () => {
          const warnings: SubagentCleanupWarning[] = [];
          let ok = false;
          try {
            if (system === undefined) return;
            if (activationHandle === undefined) {
              ok = true;
              return;
            }
            if (mode === "idle" && !cancelRequested) {
              const waited = await waitResultWithBudget(
                observeResult(activationHandle),
                controller.signal,
                cleanupTimeoutMs,
              );
              if (waited === "timeout") {
                system.registry.noteCleanupBudget(system.runId, cleanupTimeoutMs);
                console.error(
                  `系统技能子代理在 ${String(cleanupTimeoutMs / 60_000)} 分钟内未结束，释放 activation`,
                );
              }
            }
            const disposal = await disposeActivationWithTimeout(activationHandle, cleanupTimeoutMs);
            if (disposal === "fulfilled") {
              ok = true;
            } else if (disposal === "rejected") {
              warnings.push({ code: "activation-dispose-failed", severity: "error" });
            } else {
              warnings.push({ code: "activation-dispose-timeout", severity: "error" });
            }
            // 后处置观察窗:不得复用已 abort 的 controller.signal(否则 0ms 短路),
            // 也不得传 undefined(settleWithin 会直接在 promise.then 上抛 TypeError)。
            if (resultObserved !== undefined) {
              const settled = await settleWithin(resultObserved, cleanupTimeoutMs);
              if (!settled) system.registry.rejectResult(system.runId, "execution result missing after dispose");
            }
          } finally {
            if (system !== undefined) system.registry.confirmCleanup(system.runId, { ok, warnings });
          }
        })());

      if (system !== undefined) {
        // 预留了非空 childId 时必须在首个 await 之前归因,provider 沿用即最早的活动。
        if (typeof specChildId === "string" && specChildId.length > 0) {
          system.registry.reserveChild(system.runId, specChildId);
        }
        // 提前挂载取消闭包:覆盖 startActivation pending 期受理的取消。未发布
        // activation 时只 latch + abort,由启动返回/失败分支统一清理并确认。
        system.registry.attachCancel(system.runId, async () => {
          cancelRequested = true;
          controller.abort();
          if (activationHandle !== undefined) await cleanup("cancel");
        });
      }

      try {
        const run = await startRun.run(effectiveRunId, () =>
          startParent.run(parentFromCall, () => originalActivation(...args)),
        );
        // fail closed:激活的父会话与登记表里的 run parent 必须是同一个。三方 parent
        // 不一致时先释放本次 activation,再拒绝启动;后续 restrict/refresh/bindChild
        // 一律不执行。没有 Host runId 的嵌套子代理不在本检查范围内。
        if (effectiveRunId !== undefined) {
          const activationParent = sessionIdOf(parentFromStartArgs(args));
          const registryParent = ctx.huaanworkSubagentRuns?.parentSessionIdOf(effectiveRunId);
          if (
            registryParent !== undefined &&
            (activationParent !== registryParent || parentFromCall !== registryParent)
          ) {
            if (system !== undefined) {
              // 吸收本次 activation 后统一走 cleanup:避免内部吞掉 dispose 失败、外层
              // catch 又以 ok: true 二次确认。
              activationHandle = run;
              failedReported = true;
              system.registry.failRun(system.runId, "subagent activation parent mismatch");
              await cleanup("cancel");
            } else {
              try {
                await run?.dispose();
              } catch {
                // 释放失败不能顶替不一致错误,也不能留下未处理的 rejection。
              }
            }
            throw new Error("subagent activation parent mismatch");
          }
        }
        const childSessionId = run === undefined ? undefined : sessionIdOf(run.childId);
        if (system !== undefined) {
          const reservedChildId =
            typeof specChildId === "string" && specChildId.length > 0 ? specChildId : undefined;
          if (
            run === undefined ||
            childSessionId === undefined ||
            (reservedChildId !== undefined && childSessionId !== reservedChildId)
          ) {
            // childId 不可解析(或与预留 id 不符):fail closed。先标记失败,有 activation
            // 时释放并确认清理,再抛错;外层 catch 因 failedReported 不再重复 failRun。
            activationHandle = run;
            failedReported = true;
            const message =
              childSessionId === undefined
                ? "subagent activation child id missing"
                : "subagent activation child mismatch";
            system.registry.failRun(system.runId, message);
            if (run !== undefined) await cleanup("cancel");
            throw new Error(message);
          }
          activationHandle = run;
          system.registry.bindActivation(system.runId, { childId: childSessionId });
          // `result` 必填:无需可选跳过,它同时提供 executionEnded。
          observeResult(run);
          // 正常完成(未取消)后按同一收尾预算释放 activation;取消路径由 cancel 闭包
          // 或下面的晚到取消分支负责。清理 promise 必须回链到这里:游离的 cleanup
          // 若 reject 会成为未处理的拒绝。
          void resultObserved
            ?.then(() => {
              if (cancelRequested) return undefined;
              return cleanup("idle");
            })
            .catch(() => undefined);
          if (cancelRequested) {
            // 启动期受理的取消:已发布 activation 立即释放,不再向上游返回已处置句柄。
            cancelledAfterPublish = true;
            await cleanup("cancel");
            throw new Error(`系统技能「${skillKind ?? "unknown"}」的子代理回合已取消`);
          }
        }
        // 包请求只认宿主预留的子会话 id:provider 沿用预留 id 才在包装里接线。
        // 另分配的 id 由 host 的 activation 返回后路径补挂;同会话并发发起的
        // legacy 子代理因此不会命中另一回合的包请求。
        let packageApplied = false;
        if (
          pkg !== undefined &&
          pkg !== null &&
          run !== undefined &&
          childSessionId !== undefined &&
          parentFromCall !== undefined &&
          pkg.parentSessionId === parentFromCall &&
          pkg.childId === childSessionId
        ) {
          packageApplied = true;
          if (ctx.huaanworkAttachments) {
            // host 已按预留子会话 id 预先挂载;这里按同一 id 再挂一次是幂等安全网,
            // 覆盖 provider 沿用预留 id 但 host 预挂之后工具表变化的场景。
            // MCP 名字在挂载时先落在父会话上(健康检查要求先拿到工具名),发现后由
            // host 从父会话摘掉;子会话要执行 mcp__* 仍需自己的附件,否则 policy 的
            // attached 判定会拒绝。
            attachAgentTools(
              ctx.huaanworkAttachments,
              childSessionId,
              agentPackageChildAttachmentNames(pkg.allow, pkg.runtime.mcpNames ?? []),
            );
          }
          // 绑定必须与附件同批完成,且先于 refreshAgentRestrict:present-as 只在附件里
          // 找非 ALLOWED_TOOLS 的名字,晚挂会让它先前算出的 restrict 继续遮住 mcp__*。
          pkg.bindChild(childSessionId);
          refreshAgentRestrict(ctx as never, childSessionId);
          const childAgent = ctx.agents?.get?.(childSessionId) ?? run.localAgent;
          const tools = childAgent?.ctx?.get?.("tools");
          const schemas = tools?.schemas?.() ?? [];
          const existing = schemas.flatMap((schema) => (schema.name ? [schema.name] : []));
          const allow = pkg.allow.filter((name) => existing.includes(name));
          tools?.restrict?.({ allow });
        }
        // legacy `@agent` 没有智能体包的运行时工具、附件或 registry:只按目录条目
        // 声明的 allow 收窄子会话工具,交集与旧 `start` 包装一致。
        if (!packageApplied && legacy !== undefined && run !== undefined) {
          const childAgent =
            (childSessionId === undefined ? undefined : ctx.agents?.get?.(childSessionId)) ?? run.localAgent;
          const tools = childAgent?.ctx?.get?.("tools");
          const schemas = tools?.schemas?.() ?? [];
          const existing = schemas.flatMap((schema) => (schema.name ? [schema.name] : []));
          const allow = legacy.allow.filter((name) => existing.includes(name));
          tools?.restrict?.({ allow });
        }
        // 血缘分支(C4):本次 activation 未命中包请求与 legacy,且父会话在血缘表中
        // ⇒ 孙代按 继承allow ∩ schemas 收窄,并写同引用条目供曾孙代继续继承。
        // 不挂包运行时附件(v1);allow ∩ schemas 自然滤掉未挂载的运行时工具名。
        if (
          !packageApplied &&
          legacy === undefined &&
          run !== undefined &&
          parentFromCall !== undefined
        ) {
          const inherited = ctx.huaanworkPackageChildAllow?.get(parentFromCall);
          if (inherited !== undefined) {
            // C4 加固:血缘子会话无可解析 id 必须 fail-closed,不能静默保留基线工具
            // (mainstream 不可达:上游契约保证 childId)。与 parent-mismatch 同形。
            if (childSessionId === undefined) {
              try {
                await run.dispose();
              } catch {
                // 释放失败不能顶替不一致错误,也不能留下未处理 rejection。
              }
              throw new Error("subagent lineage child id missing");
            }
            const childAgent = ctx.agents?.get?.(childSessionId) ?? run.localAgent;
            const tools = childAgent?.ctx?.get?.("tools");
            const schemas = tools?.schemas?.() ?? [];
            const existing = schemas.flatMap((schema) => (schema.name ? [schema.name] : []));
            const allow = inherited.filter((name) => existing.includes(name));
            tools?.restrict?.({ allow });
            ctx.huaanworkPackageChildAllow?.set(childSessionId, inherited);
          }
        }
        if (run?.localAgent) {
          consumePendingSpawn(run.localAgent);
        }
        return run;
      } catch (error) {
        // 启动/外层失败:记录「启动已终结」并完成清理确认。晚到取消不污染 failure 字段;
        // pending 期取消且 dispose 成功时也必须收敛(不因 cleanupOk 缺失永停 stopping)。
        if (system !== undefined) {
          if (!cancelledAfterPublish && !failedReported) {
            failedReported = true;
            system.registry.failRun(system.runId, errorText(error));
          }
          await cleanup(cancelRequested ? "cancel" : "idle");
        }
        throw error;
      } finally {
        // 只清本次快照:重叠的 activation 不能清掉别处新写入的包/legacy 请求。
        if (
          ctx.huaanworkAgentPackageRequest &&
          pkg !== undefined &&
          pkg !== null &&
          ctx.huaanworkAgentPackageRequest.current === pkg
        ) {
          ctx.huaanworkAgentPackageRequest.current = null;
        }
        if (ctx.huaanworkAgentRequest && legacy !== undefined && ctx.huaanworkAgentRequest.current === legacy) {
          ctx.huaanworkAgentRequest.current = undefined;
        }
      }
    };
  }
}

/**
 * 子会话继承父会话的模型绑定:父会话没有绑定时不写。
 * 父会话 id 只来自调用方显式传入的 parent,不读任何进程级调用槽。
 */
function inheritSessionModel(
  table: Map<string, string> | undefined,
  parentSessionId: string,
  childSessionId: string,
): void {
  if (!table) return;
  const bound = table.get(parentSessionId);
  if (bound === undefined) return;
  table.set(childSessionId, bound);
}

/** 子代理继承父会话的可写根:父根缺失时不写,避免凭空造出一个根。 */
function inheritSessionRoot(
  table: Map<string, string> | undefined,
  parentSessionId: string,
  childSessionId: string,
): void {
  if (!table) return;
  const root = table.get(parentSessionId);
  if (root === undefined) return;
  table.set(childSessionId, root);
}

function sessionIdOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as { id?: unknown; session?: { id?: unknown } };
  if (typeof record.session?.id === "string" && record.session.id.length > 0) return record.session.id;
  if (typeof record.id === "string" && record.id.length > 0 && record.id !== "huaanwork") return record.id;
  return undefined;
}

function parentFromStartArgs(args: readonly unknown[]): unknown {
  const second = args[1];
  if (second && typeof second === "object" && "parent" in second) return (second as { parent?: unknown }).parent;
  const first = args[0];
  if (!first || typeof first !== "object") return undefined;
  const spec = first as { parent?: unknown; request?: { parent?: unknown } };
  return spec.request?.parent ?? spec.parent;
}

export type BundledSkillInfo = { name: string; description: string };

/** List bundled skills (name + description from frontmatter) for the 技能中心 UI. */
export function listBundledSkills(): BundledSkillInfo[] {
  const skills: BundledSkillInfo[] = [];
  for (const entry of scanBundledSkillEntries()) {
    try {
      const parsed = parseSkillMarkdown(readFileSync(entry.path, "utf8"));
      if (!parsed.name || !parsed.description) continue;
      skills.push({ name: parsed.name, description: parsed.description });
    } catch {
      // 不可读条目跳过（与 skills-host 的 warn+skip 语义对齐）
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function loadSkill(fileName: string): SkillRegistration {
  const raw = readFileSync(join(BUNDLED_SKILLS_ROOT, fileName), "utf8");
  const parsed = parseSkillMarkdown(raw);
  return {
    name: parsed.name || fileName.replace(/\.md$/, ""),
    description: parsed.description,
    content: parsed.content,
    source: "runtime",
  };
}

function stringArg(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : "";
}

function resolveBundledSkillsRoot(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  const oneUp = join(dir, "..", "skills");
  if (existsSync(oneUp)) return oneUp;
  const twoUp = join(dir, "..", "..", "skills");
  if (existsSync(twoUp)) return twoUp;
  return oneUp;
}

const BUNDLED_SKILLS_ROOT = resolveBundledSkillsRoot();

export type BundledSkillEntry = { path: string; kind: "bundle" | "flat" };

/** 扫描内置技能根：目录包（<dir>/SKILL.md）与扁平 <name>.md 双形态；跳过点开头条目。 */
export function scanBundledSkillEntries(): BundledSkillEntry[] {
  const found: BundledSkillEntry[] = [];
  for (const entry of readdirSync(BUNDLED_SKILLS_ROOT, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      const skillFile = join(BUNDLED_SKILLS_ROOT, entry.name, "SKILL.md");
      if (existsSync(skillFile)) found.push({ path: skillFile, kind: "bundle" });
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push({ path: join(BUNDLED_SKILLS_ROOT, entry.name), kind: "flat" });
    }
  }
  return found;
}

/** 按 frontmatter name 找内置条目（name 是唯一事实来源，与文件/目录名无关）。 */
export function findBundledEntry(name: string): BundledSkillEntry | undefined {
  if (!SKILL_NAME_RE.test(name)) return undefined;
  for (const entry of scanBundledSkillEntries()) {
    try {
      if (parseSkillMarkdown(readFileSync(entry.path, "utf8")).name === name) return entry;
    } catch {
      // 跳过不可读条目
    }
  }
  return undefined;
}

/** 技能的 resourceBase 目录：目录形态为技能目录，扁平形态为内置技能根。 */
export function bundledSkillDir(name: string): string | undefined {
  const entry = findBundledEntry(name);
  if (!entry) return undefined;
  return entry.kind === "bundle" ? dirname(entry.path) : BUNDLED_SKILLS_ROOT;
}

/** 系统技能：始终启用，不参与开关（承载 explore/test-fix 的 restrict/guard 机制）。 */
export const SYSTEM_SKILLS: ReadonlySet<string> = new Set(["explore", "test-fix"]);

/**
 * 宿主内部技能:正文由创建入口直接注入,不注册进全局技能目录,也不在技能中心列出。
 * `listBundledSkills` 仍返回它们,供新增/导入技能的重名检查。
 */
export const INTERNAL_BUNDLED_SKILLS: ReadonlySet<string> = new Set(["create-agent", "create-skill"]);

/** 开关表落点(dshHome = $DSH_HOME/旧, Desktop 组合下是 profileDir);导出给迁移侧同源引用。 */
export function skillTogglesPath(dshHome: string): string {
  return join(dshHome, "skill-toggles.json");
}

export function readSkillToggles(dshHome: string): Record<string, boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(skillTogglesPath(dshHome), "utf8"));
  } catch {
    return {}; // 缺失/损坏：全部禁用
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const toggles: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (SKILL_NAME_RE.test(key) && value === true) toggles[key] = true;
  }
  return toggles;
}

/** enable 写 true、disable 删键（与"缺省=禁用"严格单态）；同目录 .tmp + rename 原子写。 */
export function setSkillToggle(dshHome: string, name: string, enabled: boolean): void {
  const toggles = readSkillToggles(dshHome);
  if (enabled) toggles[name] = true;
  else delete toggles[name];
  const target = skillTogglesPath(dshHome);
  const tmp = `${target}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(toggles, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
}

/** 注册一个内置技能到运行时（带目录 resourceBase，模型可解析 scripts/ 相对路径）。 */
export function registerBundledSkill(
  ctx: { skills?: { register(skill: SkillRegistration): () => void } },
  name: string,
): (() => void) | undefined {
  const entry = findBundledEntry(name); // SKILL_NAME_RE 校验已内含
  if (!entry) return undefined;
  let parsed: ParsedSkillMarkdown;
  try {
    parsed = parseSkillMarkdown(readFileSync(entry.path, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed.name || !parsed.description) return undefined;
  return ctx.skills?.register({
    name: parsed.name,
    description: parsed.description,
    content: parsed.content,
    source: "bundled",
    resourceBase: { kind: "directory", path: entry.kind === "bundle" ? dirname(entry.path) : BUNDLED_SKILLS_ROOT },
  });
}

/** 读取内置技能完整内容（供 skill.get）。name 不合规直接返回 undefined，防路径穿越。 */
export function getBundledSkill(
  name: string,
): { name: string; description: string; content: string; disableModelInvocation?: boolean; userInvocable?: boolean } | undefined {
  const entry = findBundledEntry(name);
  if (!entry) return undefined;
  let raw: string;
  try {
    raw = readFileSync(entry.path, "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseSkillMarkdown(raw);
  return {
    name: parsed.name || name,
    description: parsed.description,
    content: parsed.content,
    ...(parsed.disableModelInvocation !== undefined ? { disableModelInvocation: parsed.disableModelInvocation } : {}),
    ...(parsed.userInvocable !== undefined ? { userInvocable: parsed.userInvocable } : {}),
  };
}

