import assert from "node:assert/strict";
import { afterEach, test } from "vitest";

import { resetChildSessionRegistry } from "../../src/huaanwork-host/child-sessions.ts";
import { HUAANWORK_LEGACY_AGENT_REQUEST } from "../../src/huaanwork-host/subagents-service.ts";
import { emptyAttachments } from "../../src/huaanwork-guardrails/agent-attachments.ts";
import { apply as applySkills } from "../../src/huaanwork-guardrails/skills.ts";

afterEach(() => {
  resetChildSessionRegistry();
});

type Schema = { name: string };
type ToolsService = {
  schemas: () => Schema[];
  restrict: (filter: { allow: readonly string[] }) => () => void;
};
type Agent = { id: string; ctx: { get: (name: string) => ToolsService | undefined } };

const BASE_NAMES = [
  "read", "read_file", "glob", "grep", "edit", "write",
  "bash", "pwsh", "skill", "subagent", "git_push", "web_search", "call_host_tool",
] as const;

/** 相交层 fake：每层 restrict 独立生效，schemas = 全部活跃层的交集；disposer 只移除本层。 */
function createComposingTools(names: readonly string[] = BASE_NAMES) {
  const all = names.map((name) => ({ name }));
  const layers: Array<readonly string[]> = [];
  const tools = {
    layers,
    schemas(): Schema[] {
      return all.filter((schema) => layers.every((allow) => allow.includes(schema.name)));
    },
    restrict({ allow }: { allow: readonly string[] }): () => void {
      layers.push(allow);
      return () => {
        const index = layers.indexOf(allow);
        if (index >= 0) layers.splice(index, 1);
      };
    },
  };
  return tools;
}

function agentOf(id: string, tools: ReturnType<typeof createComposingTools>): Agent {
  return { id, ctx: { get: (name) => (name === "tools" ? tools : undefined) } };
}

function lifecycleContext() {
  const listeners: Record<string, Array<(info: unknown) => void>> = {};
  const ctx: Record<string, unknown> = {
    skills: { register: () => () => undefined },
    on(event: string, listener: (info: unknown) => void) {
      (listeners[event] ??= []).push(listener);
    },
  };
  return {
    ctx,
    emit(event: string, info: unknown) {
      for (const listener of listeners[event] ?? []) listener(info);
    },
  };
}

function activateOf(ctx: Record<string, unknown>): (spec: unknown) => Promise<unknown> {
  return (ctx.subagents as { startActivation(spec: unknown): Promise<unknown> }).startActivation;
}

function liveParent(sessionId: string): { session: { id: string } } {
  return { session: { id: sessionId } };
}

const PKG_ALLOW: readonly string[] = ["read", "read_file", "glob", "grep", "bash", "subagent"];

/**
 * 通用血缘 harness：pkg-child 会话已在血缘表中（模拟 C3 bindChild 写入），
 * 模型从 pkg-child 自主派 subagent（无 Host runId、无包请求、无 legacy 符号）。
 */
function lineageHarness(options?: {
  allow?: readonly string[];
  parentSessionId?: string;
  grandchildId?: string;
  greatGrandchildId?: string;
}) {
  const allow = options?.allow ?? PKG_ALLOW;
  const parentSessionId = options?.parentSessionId ?? "pkg-child";
  const grandchildId = options?.grandchildId ?? "grandchild";
  const greatGrandchildId = options?.greatGrandchildId ?? "great-grandchild";
  const { ctx, emit } = lifecycleContext();
  const childAllow = new Map<string, readonly string[]>([[parentSessionId, allow]]);
  const attachments = emptyAttachments();
  const grandchildTools = createComposingTools();
  const grandchild = agentOf(grandchildId, grandchildTools);
  const greatGrandchildTools = createComposingTools();
  const greatGrandchild = agentOf(greatGrandchildId, greatGrandchildTools);
  const agentsById = new Map<string, Agent>([
    [grandchildId, grandchild],
    [greatGrandchildId, greatGrandchild],
  ]);
  Object.assign(ctx, {
    huaanworkAttachments: attachments,
    huaanworkPackageChildAllow: childAllow,
    huaanworkPackageChildSessions: new Set([parentSessionId]),
    agents: { get: (id: string) => agentsById.get(id) },
    subagents: {
      async startActivation(spec: { childId?: string }) {
        const id = spec.childId ?? grandchildId;
        emit("subagent/start", { provider: "spawn", id, local: true });
        return {
          childId: id,
          localAgent: agentsById.get(id),
          result: new Promise(() => undefined),
          dispose: async () => undefined,
        };
      },
      async start(_name: unknown, request: { parent?: unknown }) {
        const parentId = (request?.parent as { session?: { id?: string } })?.session?.id;
        const id = parentId === parentSessionId ? grandchildId : greatGrandchildId;
        return { localAgent: agentsById.get(id), result: Promise.resolve({}) };
      },
    },
  });
  applySkills(ctx as never);
  return {
    ctx, emit, childAllow, attachments, allow, agentsById,
    parentSessionId, grandchildId, greatGrandchildId,
    grandchildTools, greatGrandchildTools, grandchild, greatGrandchild,
    capturedFirstRequestToolNames: undefined as string[] | undefined,
    /** 本 harness 的首步组装：只读一次孙代 schemas()。收窄发生在 startActivation 的 restrict，模型请求读的是同一份表。 */
    driveFirstChildStep(this: { capturedFirstRequestToolNames?: string[] }) {
      this.capturedFirstRequestToolNames = grandchildTools.schemas().map((schema) => schema.name);
    },
  };
}

function activationSpec(childId: string, parentSessionId: string) {
  return {
    provider: "spawn",
    label: "lane",
    childId,
    request: { prompt: [], parent: liveParent(parentSessionId) },
    delivery: "parent",
  };
}

// 矩阵 2：孙代 schemas 收窄为 继承allow ∩ schemas；不挂包运行时附件。
test("grandchild schemas narrow to inherited allow intersected with its tool table", async () => {
  const h = lineageHarness();
  await activateOf(h.ctx)(activationSpec(h.grandchildId, h.parentSessionId));
  const names = h.grandchildTools.schemas().map((schema) => schema.name);
  assert.deepEqual(names, ["read", "read_file", "glob", "grep", "bash", "subagent"]);
  assert.equal(names.includes("write"), false);
  assert.equal(names.includes("call_host_tool"), false);
  // 孙代不挂包运行时附件（v1）：附件表里只有父会话，没有孙代条目。
  assert.equal(h.attachments.sessionAgentTools.has(h.grandchildId), false);
  // 传递绑定：孙代条目与父条目同一引用。
  assert.equal(h.childAllow.get(h.grandchildId), h.allow);
});

// 矩阵 2b（终审 P1）：首步模型可见工具表。
// 本 harness 不启动真实 provider。driveFirstChildStep 是命名过的那一次 schemas() 读取；
// 测试只断言它记下的名字。矩阵 2 仍直接断言注册表视图，两者不要混用。
// 执行期拒绝见 Task 4，本测试不重复。
test("grandchild first model request carries only the inherited allow", async () => {
  const h = lineageHarness();
  await activateOf(h.ctx)(activationSpec(h.grandchildId, h.parentSessionId));
  h.driveFirstChildStep();
  assert.deepEqual(
    h.capturedFirstRequestToolNames,
    ["read", "read_file", "glob", "grep", "bash", "subagent"],
  );
});

// 矩阵 3：传递性——曾孙代同样收窄。
test("great-grandchild inherits the same narrowing transitively", async () => {
  const h = lineageHarness();
  await activateOf(h.ctx)(activationSpec(h.grandchildId, h.parentSessionId));
  await activateOf(h.ctx)(activationSpec(h.greatGrandchildId, h.grandchildId));
  const names = h.greatGrandchildTools.schemas().map((schema) => schema.name);
  assert.deepEqual(names, ["read", "read_file", "glob", "grep", "bash", "subagent"]);
  assert.equal(h.childAllow.get(h.greatGrandchildId), h.allow);
});

// 矩阵 7（基线）：无血缘条目的主会话 subagent 行为零变化。
test("a session without a lineage entry keeps its baseline tools", async () => {
  const h = lineageHarness();
  h.childAllow.clear();
  await activateOf(h.ctx)(activationSpec(h.grandchildId, h.parentSessionId));
  const names = h.grandchildTools.schemas().map((schema) => schema.name);
  assert.deepEqual(names, [...BASE_NAMES]);
  assert.equal(h.childAllow.has(h.grandchildId), false);
});

// 矩阵 7（legacy）：legacy 符号在场时不走血缘分支。
test("legacy activation skips the lineage branch", async () => {
  const h = lineageHarness();
  const spec = {
    ...activationSpec(h.grandchildId, h.parentSessionId),
    [HUAANWORK_LEGACY_AGENT_REQUEST]: { allow: ["read"], persona: "legacy" },
  };
  await activateOf(h.ctx)(spec);
  const names = h.grandchildTools.schemas().map((schema) => schema.name);
  assert.deepEqual(names, ["read"]);
  assert.equal(h.childAllow.has(h.grandchildId), false);
});

// 矩阵 5（包优先）：包请求命中时走既有 pkg 分支，不写血缘 map（bindChild 负责）。
test("a matching package request takes precedence over the lineage branch", async () => {
  const h = lineageHarness();
  let bindCalls: string[] = [];
  const pkg = {
    runId: "run-1",
    allow: ["read", "glob"],
    persona: "包人设",
    runtime: { slug: "pkg", packageDir: "/tmp/pkg", workspaceRoot: "/tmp", skillScripts: [], runSkillScript: async () => ({ text: "" }) },
    parentSessionId: h.parentSessionId,
    childId: h.grandchildId,
    bindChild: (id: string) => { bindCalls.push(id); },
  };
  (h.ctx as Record<string, unknown>).huaanworkAgentPackageRequest = { current: pkg };
  await activateOf(h.ctx)(activationSpec(h.grandchildId, h.parentSessionId));
  assert.deepEqual(bindCalls, [h.grandchildId]);
  const names = h.grandchildTools.schemas().map((schema) => schema.name);
  assert.deepEqual(names, ["read", "glob"]);
  // 血缘 map 不被 C4 写入（pkg 分支的绑定由 host bindChild 负责，fake 里只记录调用）：
  // 孙代条目不存在，map 里只剩 harness 播种的父条目。
  assert.equal(h.childAllow.has(h.grandchildId), false);
  assert.equal(h.childAllow.get(h.parentSessionId), h.allow);
  assert.equal(h.childAllow.size, 1);
});

// 矩阵 2（start 旧签名回落）：start 包装同形收窄。
test("the legacy start wrapper narrows grandchildren identically", async () => {
  const h = lineageHarness();
  const start = (h.ctx.subagents as { start: (...args: never[]) => Promise<unknown> }).start;
  await start("lane" as never, { parent: liveParent(h.parentSessionId), prompt: [] } as never);
  const names = h.grandchildTools.schemas().map((schema) => schema.name);
  assert.deepEqual(names, ["read", "read_file", "glob", "grep", "bash", "subagent"]);
  assert.equal(h.childAllow.get(h.grandchildId), h.allow);
});

// 矩阵 8：tools/change 触发基线 lift/re-restrict 后，血缘层保持（相交语义）。
test("baseline re-restrict on tools/change preserves the lineage layer", async () => {
  const h = lineageHarness();
  // 模拟 present-as 基线层：先装一层宽基线，拿到其 disposer。
  const liftBaseline = h.grandchildTools.restrict({ allow: [...BASE_NAMES] });
  await activateOf(h.ctx)(activationSpec(h.grandchildId, h.parentSessionId));
  assert.deepEqual(
    h.grandchildTools.schemas().map((schema) => schema.name),
    ["read", "read_file", "glob", "grep", "bash", "subagent"],
  );
  // present-as 的 restrictAll：解除自己的基线层、再装一层新基线；血缘层不在其追踪内。
  liftBaseline();
  h.grandchildTools.restrict({ allow: [...BASE_NAMES] });
  h.emit("tools/change", {});
  assert.deepEqual(
    h.grandchildTools.schemas().map((schema) => schema.name),
    ["read", "read_file", "glob", "grep", "bash", "subagent"],
  );
});

// 矩阵 5（跨包隔离）：A 包血缘不拿 B 包 allow；两引用互不串。
test("two package lineages stay isolated by reference", async () => {
  const h = lineageHarness();
  const allowB: readonly string[] = ["read", "grep"];
  h.childAllow.set("pkg-child-b", allowB);
  const toolsB = createComposingTools();
  const childB = agentOf("grandchild-b", toolsB);
  // 既有 fake startActivation 按 agentsById 解析 localAgent，登记新孙代即可，
  // 不重新 apply（重复 apply 会叠加事件监听器，造成双重收窄）。
  h.agentsById.set("grandchild-b", childB);
  await activateOf(h.ctx)(activationSpec(h.grandchildId, h.parentSessionId));
  await activateOf(h.ctx)(activationSpec("grandchild-b", "pkg-child-b"));
  assert.deepEqual(
    h.grandchildTools.schemas().map((schema) => schema.name),
    ["read", "read_file", "glob", "grep", "bash", "subagent"],
  );
  assert.deepEqual(toolsB.schemas().map((schema) => schema.name), ["read", "grep"]);
  assert.equal(h.childAllow.get(h.grandchildId), h.allow);
  assert.equal(h.childAllow.get("grandchild-b"), allowB);
});
