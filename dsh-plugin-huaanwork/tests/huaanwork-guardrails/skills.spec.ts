import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";

import { parseSkillMarkdown, serializeSkillMarkdown } from "@huaanwork/skill-format/markdown";

import type { AgentPackageSubagentRequest } from "../../src/huaanwork-host/agent-package/types.ts";
import * as childSessions from "../../src/huaanwork-host/child-sessions.ts";
import {
  childrenOf,
  forgetChildSession,
  parentSessionOf,
  registerChildSession,
  resetChildSessionRegistry,
} from "../../src/huaanwork-host/child-sessions.ts";
import { ACTIVATION_CLEANUP_TIMEOUT_MS } from "../../src/huaanwork-host/agent-package/host.ts";
import { sendToAgent } from "../../src/huaanwork-host/sessions.ts";
import { createSubagentRunRegistry } from "../../src/huaanwork-host/subagent-runs.ts";
import { createSystemSkillLeaseStore, systemSkillLeaseKindOf } from "../../src/huaanwork-host/system-skill-leases.ts";
import { createTurnAnchorStore } from "../../src/huaanwork-host/turn-anchors.ts";
import { createTurnScheduler } from "../../src/huaanwork-host/turn-scheduler.ts";
import {
  HUAANWORK_LEGACY_AGENT_REQUEST,
  HUAANWORK_SUBAGENT_RUN_ID,
} from "../../src/huaanwork-host/subagents-service.ts";
import { apply as applyLimits } from "../../src/huaanwork-guardrails/limits.ts";
import { emptyAttachments } from "../../src/huaanwork-guardrails/agent-attachments.ts";
import { apply as applyPresentAs } from "../../src/huaanwork-guardrails/present-as.ts";
import { SYSTEM_SKILLS, apply as applySkills, bundledSkillDir, currentDispatchSkillKind, exploreAllowList, getBundledSkill, listBundledSkills, parentVisibleExploreTranscript, readSkillToggles, registerBundledSkill, scanBundledSkillEntries, setBundledSkillRegistrar, setSkillToggle, shellToolName, testFixAllowList } from "../../src/huaanwork-guardrails/skills.ts";

// 这些插件把 registrar / 子会话登记放在模块级或进程级全局:用例之间要复位,
// 免得多份 harness 的 ctx 互相串(今天靠唯一 id 侥幸,不该依赖)。
afterEach(() => {
  setBundledSkillRegistrar(null);
  resetChildSessionRegistry();
});

type Schema = { name: string };

type ToolsService = {
  schemas: () => Schema[];
  restrict: (filter: { allow: readonly string[] }) => () => void;
  guard: (listener: (execution: { name: string; arguments: unknown }) => string | undefined) => () => void;
};

type Agent = {
  id: string;
  ctx: { get: (name: string) => ToolsService | undefined };
  cancel?: (reason: { kind: "parent" }) => void;
  inject?: (message: unknown) => void;
};

type SkillRegistration = {
  name: string;
  description: string;
  content: string;
  source?: string;
};

type Decision = { kind: string; reason?: string };

function createTools(names: readonly string[]): ToolsService & { visible: Schema[]; guards: Array<(execution: { name: string; arguments: unknown }) => string | undefined> } {
  const all = names.map((name) => ({ name }));
  // 相交层模型:schemas = 全部活跃层的交集;disposer 只移除本层。present-as 的
  // refresh 会先 lift 自己的旧层再按当前 schemas 重算,单层覆盖式 mock 无法把
  // 租约挂回来的 `subagent` 重新暴露。
  const layers: Array<readonly string[]> = [];
  const tools = {
    guards: [] as Array<(execution: { name: string; arguments: unknown }) => string | undefined>,
    get visible(): Schema[] {
      return all.filter((schema) => layers.every((allow) => allow.includes(schema.name)));
    },
    schemas() {
      return tools.visible;
    },
    restrict({ allow }: { allow: readonly string[] }) {
      layers.push(allow);
      return () => {
        const index = layers.indexOf(allow);
        if (index >= 0) layers.splice(index, 1);
      };
    },
    guard(listener: (execution: { name: string; arguments: unknown }) => string | undefined) {
      tools.guards.push(listener);
      return () => undefined;
    },
  };
  return tools;
}

const DEFAULT_TOOL_NAMES = [
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
  "git_push",
  "web_search",
] as const;

/** Task 1 已注册的 UUID 回合锚:system-skill run 的 clientMessageId 只来自它。 */
const TURN_MESSAGE_ID = "6f1c2b9e-3a7d-4f0e-9b8c-1d2e3f4a5b6c";

type ActivationSpec = {
  provider?: string;
  label?: string;
  childId?: string;
  request?: { prompt?: unknown[]; parent?: unknown };
  delivery?: string;
};

/** 释放 pending activation 时提供的上游句柄成员;缺省即正常 completed/dispose。 */
type ActivationRelease = {
  childId?: unknown;
  localAgent?: Agent;
  result?: Promise<unknown>;
  dispose?: () => Promise<void>;
  emitEvents?: boolean;
  upstreamRunId?: string;
};

type ActivationGate = {
  spec: ActivationSpec;
  gate: {
    promise: Promise<ActivationRelease | undefined>;
    resolve(release: ActivationRelease | undefined): void;
    reject(error: unknown): void;
  };
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness(options?: {
  childNames?: readonly string[];
  parentNames?: readonly string[];
  anchor?: { sessionId: string; clientMessageId: string; origin: "advanced" | "automation" | "unknown" };
  deferLeaseStore?: boolean;
  skipPresentAs?: boolean;
}) {
  const skills: SkillRegistration[] = [];
  const events: Record<string, ((payload: never, next?: () => Promise<unknown>, extra?: unknown) => unknown)[]> = {};
  const parentTools = createTools(options?.parentNames ?? DEFAULT_TOOL_NAMES);
  const childTools = createTools(options?.childNames ?? DEFAULT_TOOL_NAMES);
  const cancelled: string[] = [];
  const parent: Agent = {
    id: "main",
    ctx: { get: (name) => (name === "tools" ? parentTools : undefined) },
    cancel: () => cancelled.push("main"),
  };
  const child: Agent = {
    id: "child",
    ctx: { get: (name) => (name === "tools" ? childTools : undefined) },
    cancel: () => cancelled.push("child"),
  };
  const emitted: unknown[] = [];
  const activationGates: ActivationGate[] = [];
  const runs = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined });
  const attachments = emptyAttachments();
  const anchors = createTurnAnchorStore();
  const anchor =
    options?.anchor ?? { sessionId: "main", clientMessageId: TURN_MESSAGE_ID, origin: "advanced" as const };
  anchors.register(anchor);
  anchors.notePreStep(
    anchor.sessionId,
    [{ role: "user", id: anchor.clientMessageId, source: { kind: "user" } }],
    new Date().toISOString(),
  );
  const extraAgents = new Map<string, Agent>();
  const ctx: Record<string, unknown> = {
    huaanworkEmit(event: unknown) {
      emitted.push(event);
    },
    huaanworkAttachments: attachments,
    huaanworkUnattended: new Map(),
    huaanworkPackageChildAllow: new Map(),
    huaanworkTurnAnchors: anchors,
    huaanworkSubagentRuns: runs,
    skills: {
      register(skill: SkillRegistration) {
        skills.push(skill);
        return () => undefined;
      },
    },
    agents: {
      list: () => [parent, child, ...extraAgents.values()],
      get: (id: string) => extraAgents.get(id) ?? (id === child.id ? child : parent),
    },
    tools: {
      presentAs: () => () => undefined,
      schemas: () => [],
      guard() {
        return () => undefined;
      },
    },
    on(
      event: string,
      listener: (payload: never, next?: () => Promise<unknown>) => unknown,
      prepend?: boolean,
    ) {
      const list = events[event] ?? [];
      if (prepend) list.unshift(listener);
      else list.push(listener);
      events[event] = list;
    },
  };

  const emit = (event: string, payload: unknown, extra?: unknown) => {
    for (const listener of events[event] ?? []) listener(payload as never, undefined, extra as never);
  };

  // 上游两阶段派发的忠实 fake:调用发生在 tools/execute 的终止回调(body)内;
  // agent/created 与 subagent/start 在 fake 自己的异步续体内派发,startRun/spawnKind
  // 的 ALS 作用域因此仍然有效。gate 让用例在 activation 释放前观察 registry。
  ctx.subagents = {
    startActivation: async (...args: never[]) => {
      const gate = deferred<ActivationRelease | undefined>();
      activationGates.push({ spec: args[0] as ActivationSpec, gate });
      const release = await gate.promise;
      if (release === undefined) return undefined;
      const childId = release.childId;
      if (release.emitEvents !== false && childId !== undefined) {
        const known =
          typeof childId === "string"
            ? (extraAgents.get(childId) ?? (childId === child.id ? child : undefined))
            : undefined;
        const eventAgent =
          release.localAgent ??
          known ?? {
            id: String(childId),
            session: { header: {} },
            ctx: { get: () => undefined },
          };
        emit("agent/created", { agent: eventAgent });
        emit("subagent/start", {
          runId: release.upstreamRunId ?? `upstream-${String(childId)}`,
          id: String(childId),
          local: true,
        });
      }
      return {
        ...(childId === undefined ? {} : { childId }),
        ...(release.localAgent === undefined ? {} : { localAgent: release.localAgent }),
        result: release.result ?? Promise.resolve({ stopReason: "completed" }),
        dispose: release.dispose ?? (async () => undefined),
      };
    },
  };

  if (!options?.deferLeaseStore) {
    ctx.huaanworkSystemSkillLeases = createSystemSkillLeaseStore(ctx as never);
  }
  if (!options?.skipPresentAs) applyPresentAs(ctx as never);
  applySkills(ctx as never);
  applyLimits(ctx as never);

  async function emitWaterfall(
    event: string,
    execution: { name: string; arguments: unknown; agent?: Agent },
    terminal: () => Promise<Decision> = async () => ({ kind: "allow" }),
  ): Promise<Decision> {
    const listeners = events[event] ?? [];
    let index = 0;
    const next = async (): Promise<Decision> => {
      const listener = listeners[index];
      index += 1;
      if (!listener) return terminal();
      return (await listener(execution as never, next)) as Decision;
    };
    return next();
  }

  /**
   * 上游两阶段派发的忠实模拟:先 `tools/pre-execute` waterfall(终止回调只返回
   * `{kind:'allow'}`,不包 body),解析完后再 `tools/execute` waterfall,body 为终止回调。
   * `spawnKind` ALS 的覆盖必须在 body 阶段可见(PC-1)。
   */
  async function preExecute(agent: Agent, name: string, args: Record<string, unknown>) {
    const execution = { name, arguments: args, agent };
    const decision = await emitWaterfall("tools/pre-execute", execution);
    return { decision, execution };
  }

  async function runExecute(
    execution: { name: string; arguments: unknown; agent?: Agent },
    body: () => Promise<unknown> = async () => ({}),
  ): Promise<unknown> {
    const listeners = events["tools/execute"] ?? [];
    let index = 0;
    const next = async (): Promise<unknown> => {
      const listener = listeners[index];
      index += 1;
      if (!listener) return body();
      return await listener(execution as never, next);
    };
    return next();
  }

  async function dispatchTool(
    agent: Agent,
    name: string,
    args: Record<string, unknown>,
    body: () => Promise<unknown> = async () => ({}),
  ): Promise<Decision> {
    const { decision, execution } = await preExecute(agent, name, args);
    if (decision.kind !== "allow") return decision;
    await runExecute(execution, body);
    return decision;
  }

  function buildActivationSpec(parentSessionId: string, childId?: string): ActivationSpec {
    return {
      provider: "spawn",
      label: "system-skill",
      ...(childId === undefined ? {} : { childId }),
      request: { prompt: [{ type: "text", text: "look around" }], parent: { session: { id: parentSessionId } } },
      delivery: "parent",
    };
  }

  function callActivation(spec: ActivationSpec): Promise<unknown> {
    const subagents = ctx.subagents as { startActivation(spec: ActivationSpec): Promise<unknown> };
    return subagents.startActivation(spec);
  }

  function releaseActivation(release: ActivationRelease = {}, index = -1): void {
    const entry = activationGates.at(index);
    if (entry === undefined) throw new Error("no pending activation");
    entry.gate.resolve(release);
  }

  function failActivation(error: Error, index = -1): void {
    const entry = activationGates.at(index);
    if (entry === undefined) throw new Error("no pending activation");
    entry.gate.reject(error);
  }

  /**
   * 忠实两阶段派发里的 `subagent` body:startActivation 只在 `tools/execute` 的
   * 终止回调(body)内调用,不在任何 pre-execute `next()` 内触发。
   */
  async function startSubagentSpawn(agent: Agent, spec: ActivationSpec) {
    const { decision, execution } = await preExecute(agent, "subagent", { prompt: "look around" });
    if (decision.kind !== "allow") {
      return { decision, execution, executionDone: Promise.resolve(undefined), entry: undefined, call: undefined };
    }
    const started = deferred<void>();
    let call: Promise<unknown> | undefined;
    const executionDone = runExecute(execution, async () => {
      call = callActivation(spec);
      started.resolve();
      return call;
    });
    await started.promise;
    const entry = activationGates.at(-1);
    return { decision, execution, executionDone, entry, call: call as Promise<unknown> };
  }

  /** 建立 pending activation 并把释放时机交给用例。 */
  async function beginSubagentSpawn(
    agent: Agent,
    options?: {
      target?: Agent;
      /** `omit` 模拟上游 `tool-subagent` 不传 childId。 */
      specChildId?: string | "omit";
      parentSessionId?: string;
    },
  ) {
    const specChildId =
      options?.specChildId === "omit" ? undefined : (options?.specChildId ?? options?.target?.id);
    const started = await startSubagentSpawn(
      agent,
      buildActivationSpec(options?.parentSessionId ?? "main", specChildId),
    );
    if (started.decision.kind !== "allow" || started.entry === undefined) {
      throw new Error(`subagent dispatch ended with ${started.decision.kind}`);
    }
    return { ...started, entry: started.entry, call: started.call as Promise<unknown> };
  }

  return {
    skills,
    parent,
    child,
    parentTools,
    childTools,
    cancelled,
    emitted,
    activationGates,
    runs,
    ctx,
    events,
    attachments,
    anchors,
    emit,
    addAgent(agent: Agent) {
      extraAgents.set(agent.id, agent);
      return agent;
    },
    preExecute,
    runExecute,
    dispatchTool,
    beginSubagentSpawn,
    startSubagentSpawn,
    releaseActivation,
    failActivation,
    /** 下游 async hook(模拟 workspace-changes 等待后返回 allow / deny / 抛错)。 */
    onPreExecute(listener: (execution: { name: string; arguments: unknown; agent?: Agent }, next?: () => Promise<Decision>) => unknown) {
      (events["tools/pre-execute"] ??= []).push(listener as never);
    },
    async invokeSkill(agent: Agent, name: string) {
      return emitWaterfall("tools/pre-execute", { name: "skill", arguments: { name }, agent });
    },
    async invokeSubagent(agent: Agent, target: Agent = child, parentSessionId = "main") {
      const started = await startSubagentSpawn(agent, buildActivationSpec(parentSessionId, target.id));
      if (started.decision.kind !== "allow" || started.entry === undefined) return started.decision;
      releaseActivation({ childId: target.id, localAgent: target });
      await started.executionDone;
      return started.decision;
    },
    /** 显式 `@` 路径:宿主直接调 startActivation,不经过模型工具(无 ALS)。 */
    async activate(agent: Agent, parentSessionId = "main") {
      const call = callActivation({
        provider: "spawn",
        label: "@explicit",
        childId: agent.id,
        request: { prompt: [], parent: { session: { id: parentSessionId } } },
        delivery: "parent",
      });
      releaseActivation({ childId: agent.id, localAgent: agent });
      return call;
    },
    async callTool(agent: Agent, name: string, args: Record<string, unknown> = {}) {
      return emitWaterfall("tools/pre-execute", { name, arguments: args, agent });
    },
    result(agent: Agent, name: string, args: Record<string, unknown>, isError: boolean, text = "") {
      const exec = { name, arguments: args, agent };
      const outcome = isError
        ? { isError: true, content: [{ type: "text", text }] }
        : { isError: false, content: [{ type: "text", text }] };
      for (const listener of events["tools/result"] ?? []) {
        (listener as unknown as (exec: unknown, result: unknown) => void)(exec, outcome);
      }
    },
    guardReason(tools: ToolsService, name: string, args: Record<string, unknown> = {}) {
      for (const guard of (tools as ReturnType<typeof createTools>).guards) {
        const reason = guard({ name, arguments: args });
        if (reason) return reason;
      }
      return undefined;
    },
  };
}

test("registers explore and test-fix into ctx.skills from bundled markdown", () => {
  const harness = createHarness();
  assert.deepEqual(
    harness.skills.map((skill) => skill.name).sort(),
    ["explore", "test-fix"],
  );
  const explore = harness.skills.find((skill) => skill.name === "explore");
  const testFix = harness.skills.find((skill) => skill.name === "test-fix");
  assert.match(explore?.content ?? "", /subagent/);
  assert.match(explore?.content ?? "", /restrict/);
  assert.doesNotMatch(explore?.content ?? "", /\.huaanwork\/skills/);
  assert.match(testFix?.content ?? "", /subagent/);
  assert.match(testFix?.content ?? "", /5/);
});

test("explore goes through official subagent restrict and denies bash even if the model asks", async () => {
  const harness = createHarness();
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
  assert.ok(harness.parentTools.visible.some((schema) => schema.name === "bash"));
  assert.equal((await harness.invokeSubagent(harness.parent)).kind, "allow");
  assert.deepEqual(
    harness.childTools.visible.map((schema) => schema.name),
    ["read", "read_file", "glob", "grep"],
  );
  assert.equal((await harness.callTool(harness.child, "bash", { command: "npm test" })).kind, "deny");
  assert.equal((await harness.callTool(harness.child, "bash", { command: "ls" })).kind, "deny");
  assert.ok(harness.guardReason(harness.childTools, "bash", { command: "npm test" }));
});

test("explore child bash is denied and the parent only sees the conclusion", async () => {
  const harness = createHarness();
  await harness.invokeSkill(harness.parent, "explore");
  await harness.invokeSubagent(harness.parent);
  const denied = await harness.callTool(harness.child, "bash", { command: "ls" });
  assert.equal(denied.kind, "deny");
  const turn = [
    { scope: "child" as const, text: "secret-intermediate" },
    { scope: "parent" as const, text: "conclusion: empty workspace" },
  ];
  assert.match(turn.map((entry) => entry.text).join("\n"), /secret-intermediate/);
  const parentView = parentVisibleExploreTranscript(turn);
  assert.equal(parentView, "conclusion: empty workspace");
  assert.equal(parentView.includes("secret-intermediate"), false);
});

test("baseline without @ has no mcp__* and explore has no call_host_tool", async () => {
  const initialToolNames = [
    "read",
    "read_file",
    "glob",
    "grep",
    "bash",
    "write",
    "call_host_tool",
    "mcp__mock-mcp__calc",
  ];
  const restrictions: Array<{ allow: readonly string[] }> = [];
  const tools = {
    schemas() {
      let names = [...initialToolNames];
      for (const restriction of restrictions) names = names.filter((name) => restriction.allow.includes(name));
      return names.map((name) => ({ name }));
    },
    restrict(filter: { allow: readonly string[] }) {
      restrictions.push(filter);
      return () => undefined;
    },
    active() {
      return this.schemas().map((schema) => schema.name);
    },
  };
  const agent = {
    id: "huaanwork",
    session: { id: "huaanwork" },
    ctx: { get: (name: string) => (name === "tools" ? tools : undefined) },
  };
  applyPresentAs({
    huaanworkAttachments: emptyAttachments(),
    agents: { list: () => [agent] },
    tools: { presentAs: () => () => undefined, schemas: () => [] },
    on() {},
  } as never);
  const agentToolNames = tools.active();
  assert.equal(initialToolNames.some((name) => name.startsWith("mcp__")), true);
  assert.equal(agentToolNames.includes("call_host_tool"), true);
  assert.equal(agentToolNames.some((name) => name.startsWith("mcp__")), false);
  const exploreNames = exploreAllowList(initialToolNames);
  assert.equal(initialToolNames.includes("call_host_tool"), true);
  assert.equal(exploreNames.includes("call_host_tool"), false);
  assert.equal(exploreNames.some((name) => name.startsWith("mcp__")), false);
});

test("explore has no main-session fallback that skips restrict", async () => {
  const harness = createHarness();
  await harness.invokeSkill(harness.parent, "explore");
  assert.ok(harness.parentTools.visible.some((schema) => schema.name === "bash"));
  assert.equal((await harness.callTool(harness.parent, "bash", { command: "npm test" })).kind, "allow");
  assert.ok(harness.childTools.visible.some((schema) => schema.name === "bash"));
});

test("test-fix restrict denies git_push and web_search", async () => {
  const harness = createHarness();
  assert.equal((await harness.invokeSkill(harness.parent, "test-fix")).kind, "allow");
  await harness.invokeSubagent(harness.parent);
  const shell = shellToolName();
  assert.deepEqual(
    harness.childTools.visible.map((schema) => schema.name).sort(),
    ["edit", "glob", "grep", "read", "read_file", "str_replace_editor", "write", shell].sort(),
  );
  assert.equal((await harness.callTool(harness.child, "git_push", {})).kind, "deny");
  assert.equal((await harness.callTool(harness.child, "web_search", { query: "x" })).kind, "deny");
  assert.equal((await harness.callTool(harness.child, "subagent", { prompt: "nested" })).kind, "deny");
  assert.ok(harness.guardReason(harness.childTools, "git_push"));
  assert.ok(harness.guardReason(harness.childTools, "web_search"));
});

test("test-fix fails then write then pass without git tools", async () => {
  const harness = createHarness();
  assert.equal((await harness.invokeSkill(harness.parent, "test-fix")).kind, "allow");
  await harness.invokeSubagent(harness.parent);
  const shell = shellToolName();
  const testArgs = { command: "npm test" };
  assert.equal((await harness.callTool(harness.child, shell, testArgs)).kind, "allow");
  harness.result(harness.child, shell, testArgs, true, "failing: test_a");
  assert.equal((await harness.callTool(harness.child, "write", { path: "src/a.ts", content: "fix" })).kind, "allow");
  assert.equal((await harness.callTool(harness.child, shell, testArgs)).kind, "allow");
  harness.result(harness.child, shell, testArgs, false, "pass");
  assert.equal(harness.cancelled.includes("child"), false);
  assert.equal(harness.childTools.visible.some((schema) => schema.name.startsWith("git_")), false);
  assert.equal((await harness.callTool(harness.child, "git_push", {})).kind, "deny");
});

test("test-fix allow-list uses pwsh on win32 and bash otherwise", () => {
  const names = ["read", "bash", "pwsh", "edit", "git_push"];
  assert.deepEqual(testFixAllowList(names, "darwin"), ["read", "edit", "bash"]);
  assert.deepEqual(testFixAllowList(names, "win32"), ["read", "edit", "pwsh"]);
});

test("limits no longer cap the turn after 40 tool calls", async () => {
  const harness = createHarness();
  for (let i = 0; i < 41; i += 1) {
    assert.equal((await harness.callTool(harness.parent, "read", { path: `f${i}.ts` })).kind, "allow");
  }
  assert.equal(harness.cancelled.includes("main"), false);
  assert.equal(
    harness.emitted.some((event) => event && typeof event === "object" && (event as { event?: string }).event === "session/end"),
    false,
  );
  assert.equal(
    harness.emitted.some((event) => event && typeof event === "object" && (event as { event?: string }).event === "workspace/rollback"),
    false,
  );
});

test("limits stop after the same tool and key args fail three times in a row", async () => {
  const harness = createHarness();
  const args = { path: "same.ts", old_str: "a", new_str: "b" };
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await harness.callTool(harness.parent, "str_replace_editor", args)).kind, "allow");
    harness.result(harness.parent, "str_replace_editor", args, true, "not found");
  }
  const decision = await harness.callTool(harness.parent, "str_replace_editor", args);
  assert.equal(decision.kind, "deny");
  assert.ok(harness.cancelled.includes("main"));
});

test("main session npm test failures count toward the 3-fail cap", async () => {
  const harness = createHarness();
  const shell = shellToolName();
  const args = { command: "npm test" };
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await harness.callTool(harness.parent, shell, args)).kind, "allow");
    harness.result(harness.parent, shell, args, true, "failing");
  }
  const decision = await harness.callTool(harness.parent, shell, args);
  assert.equal(decision.kind, "deny");
  assert.ok(harness.cancelled.includes("main"));
});

test("test-fix stops after five test rounds and summarizes remaining failures", async () => {
  const harness = createHarness();
  await harness.invokeSkill(harness.parent, "test-fix");
  await harness.invokeSubagent(harness.parent);
  const shell = shellToolName();
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await harness.callTool(harness.child, shell, { command: "npm test" })).kind, "allow");
    harness.result(harness.child, shell, { command: "npm test" }, true, `failing: test_${i}`);
  }
  const decision = await harness.callTool(harness.child, shell, { command: "npm test" });
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason ?? "", /still-failing|test_/i);
  assert.ok(harness.cancelled.includes("child"));
});

test("parseSkillMarkdown round-trips managed fields and preserves unknown keys", () => {
  const raw = [
    "---",
    "name: demo",
    "description: 演示技能",
    "whenToUse: 需要演示时",
    "disable-model-invocation: true",
    "metadata:",
    "  author: someone",
    "x-custom: keep-me",
    "---",
    "",
    "正文内容",
    "",
  ].join("\n");
  const parsed = parseSkillMarkdown(raw);
  assert.equal(parsed.name, "demo");
  assert.equal(parsed.description, "演示技能");
  assert.equal(parsed.whenToUse, "需要演示时");
  assert.equal(parsed.disableModelInvocation, true);
  assert.equal(parsed.userInvocable, undefined);
  assert.equal(parsed.content, "正文内容");
  assert.deepEqual(parsed.extraLines, ["metadata:", "  author: someone", "x-custom: keep-me"]);
  // round-trip：序列化再解析结果不变（未知键保留）
  assert.deepEqual(parseSkillMarkdown(serializeSkillMarkdown(parsed)), parsed);
});

test("serializeSkillMarkdown emits managed fields then preserved extras", () => {
  const out = serializeSkillMarkdown({ name: "a", description: "b", content: "c", extraLines: ["metadata:", "  x: 1"] });
  assert.equal(out, "---\nname: a\ndescription: b\nmetadata:\n  x: 1\n---\n\nc\n");
});

test("getBundledSkill reads bundled content and rejects bad names", () => {
  assert.equal(getBundledSkill("../etc"), undefined);
  const explore = getBundledSkill("explore");
  assert.equal(explore?.name, "explore");
  assert.match(explore?.content ?? "", /subagent/);
});

test("scanBundledSkillEntries covers flat and directory forms, exactly 26 names", () => {
  const entries = scanBundledSkillEntries();
  const byName = new Map(
    entries.map((entry) => [parseSkillMarkdown(readFileSync(entry.path, "utf8")).name, entry.kind]),
  );
  assert.deepEqual(
    [...byName.keys()].sort(),
    [
      "brainstorming", "code-review", "create-agent", "create-skill", "darwin-skill",
      "deep-research", "dispatching-parallel-agents", "explore", "find-skills",
      "frontend-design", "frontend-dev", "graph", "grill-me", "humanizer", "investigate",
      "markitdown-skill", "nuwa-skill", "pdf", "pptx", "skill-creator",
      "skill-vetter", "subagent-driven-development", "systematic-debugging",
      "test-fix", "using-superpowers", "xlsx",
    ],
  );
  assert.equal(byName.get("pdf"), "bundle");
  assert.equal(byName.get("explore"), "flat");
  assert.equal(byName.get("investigate"), "bundle");
  assert.equal(byName.get("code-review"), "bundle");
  assert.equal(byName.get("create-agent"), "bundle");
  assert.equal(byName.get("create-skill"), "bundle");
});

test("listBundledSkills covers directory-form skills", () => {
  const names = listBundledSkills().map((skill) => skill.name);
  assert.equal(names.length, 26);
  assert.ok(names.includes("pdf") && names.includes("graph"));
  assert.ok(names.includes("create-agent"));
  assert.ok(names.includes("create-skill"));
  // 每个条目都有非空 description
  for (const skill of listBundledSkills()) assert.ok(skill.description.length > 0, skill.name);
});

test("getBundledSkill reads directory-form skills and bundledSkillDir resolves", () => {
  const pdf = getBundledSkill("pdf");
  assert.equal(pdf?.name, "pdf");
  assert.match(pdf?.content ?? "", /pdf/i);
  assert.ok(bundledSkillDir("pdf")?.endsWith(join("skills", "pdf")));
  // 扁平形态的 resourceBase 是内置根目录
  assert.ok(bundledSkillDir("explore")?.endsWith("skills"));
  assert.equal(bundledSkillDir("../etc"), undefined);
  assert.equal(bundledSkillDir("no-such-skill"), undefined);
});

test("readSkillToggles falls back to empty on missing/corrupt; setSkillToggle deletes key on disable", () => {
  const home = mkdtempSync(join(tmpdir(), "huaanwork-toggles-"));
  try {
    assert.deepEqual(readSkillToggles(home), {});
    setSkillToggle(home, "pdf", true);
    setSkillToggle(home, "xlsx", true);
    setSkillToggle(home, "pdf", false); // disable = 删键
    assert.deepEqual(readSkillToggles(home), { xlsx: true });
    // 非 true 值与非法名被过滤
    writeFileSync(join(home, "skill-toggles.json"), JSON.stringify({ pdf: true, junk: "yes", "Bad_Name": true }));
    assert.deepEqual(readSkillToggles(home), { pdf: true });
    // 损坏文件回退
    writeFileSync(join(home, "skill-toggles.json"), "not json");
    assert.deepEqual(readSkillToggles(home), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("registerBundledSkill registers with bundled source and directory resourceBase", () => {
  const registered: Array<{ name: string; source?: string; resourceBase?: { kind: string; path: string } }> = [];
  const ctx = { skills: { register(skill: (typeof registered)[number]) { registered.push(skill); return () => undefined; } } };
  const dispose = registerBundledSkill(ctx, "pdf");
  assert.equal(typeof dispose, "function");
  const skill = registered.find((item) => item.name === "pdf");
  assert.equal(skill?.source, "bundled");
  assert.equal(skill?.resourceBase?.kind, "directory");
  assert.ok(skill?.resourceBase?.path.endsWith(join("skills", "pdf")));
  assert.equal(registerBundledSkill(ctx, "no-such-skill"), undefined);
  assert.equal(registerBundledSkill(ctx, "../etc"), undefined);
});

test("apply keeps registering only system skills regardless of toggles helpers", () => {
  // boot 按-toggles 注册已由 host skills-bridge 承担（单一注册源）；apply() 行为不变
  const harness = createHarness();
  assert.deepEqual(
    harness.skills.map((skill) => skill.name).sort(),
    ["explore", "test-fix"],
  );
  assert.ok(SYSTEM_SKILLS.has("explore") && SYSTEM_SKILLS.has("test-fix"));
});

test("huaanworkAgentRequest restricts the started subagent and clears current", async () => {
  const childTools = createTools(["read", "glob", "edit", "bash"]);
  const childAgent: Agent = {
    id: "child",
    ctx: { get: (name) => (name === "tools" ? childTools : undefined) },
  };
  let originalCalls = 0;
  const ctx = {
    skills: { register: () => () => undefined },
    on: () => undefined,
    huaanworkAgentRequest: {
      current: {
        name: "code-reviewer",
        allow: ["read", "glob", "non_existent"],
        persona: "只读审查者",
      },
    },
    subagents: {
      start: async () => {
        originalCalls += 1;
        return { localAgent: childAgent };
      },
    },
  };

  applySkills(ctx as never);
  const run = await ctx.subagents.start();

  assert.equal(originalCalls, 1);
  assert.equal(run.localAgent, childAgent);
  assert.deepEqual(
    childTools.visible.map((schema) => schema.name),
    ["read", "glob"],
  );
  assert.equal(ctx.huaanworkAgentRequest.current, undefined);
});

test("empty persona does not start a subagent", async () => {
  for (const emptyPersona of ["", "   "]) {
    let originalCalls = 0;
    const ctx = {
      skills: { register: () => () => undefined },
      on: () => undefined,
      huaanworkAgentRequest: {
        current: {
          name: "code-reviewer",
          allow: ["read", "glob"],
          persona: emptyPersona,
        },
      },
      subagents: {
        start: async () => {
          originalCalls += 1;
          return { localAgent: {} };
        },
      },
    };

    applySkills(ctx as never);
    await assert.rejects(
      async () => {
        await ctx.subagents.start();
      },
      { message: "智能体人设为空" },
    );

    assert.equal(originalCalls, 0);
    assert.equal(ctx.huaanworkAgentRequest.current, undefined);
  }
});

test("overlapping startActivation calls register each child under its own parent", async () => {
  const startListeners: Array<(info: unknown) => void> = [];
  const gates = new Map<string, () => void>();
  const ctx = {
    skills: { register: () => () => undefined },
    on(event: string, listener: (info: unknown) => void) {
      if (event === "subagent/start") startListeners.push(listener);
    },
    subagents: {
      start: async () => ({}),
      async startActivation(spec: { request: { parent: { session: { id: string } } }; childId: string }) {
        await new Promise<void>((resolve) => gates.set(spec.childId, resolve));
        for (const listener of startListeners) listener({ id: spec.childId, local: true });
        return { childId: spec.childId };
      },
    },
  };
  applySkills(ctx as never);
  const activate = ctx.subagents.startActivation as (spec: unknown) => Promise<unknown>;
  const first = activate({ request: { parent: { session: { id: "huaanwork-overlap-a" } } }, childId: "overlap-child-a" });
  const second = activate({ request: { parent: { session: { id: "huaanwork-overlap-b" } } }, childId: "overlap-child-b" });
  await new Promise((resolve) => setImmediate(resolve));
  gates.get("overlap-child-a")?.();
  await first;
  gates.get("overlap-child-b")?.();
  await second;
  assert.deepEqual(childrenOf("huaanwork-overlap-a"), ["overlap-child-a"]);
  assert.deepEqual(childrenOf("huaanwork-overlap-b"), ["overlap-child-b"]);
});

test("a global legacy request alone does not attribute an activation", async () => {
  const childTools = createTools(["read", "glob"]);
  const childAgent: Agent = {
    id: "child",
    ctx: { get: (name) => (name === "tools" ? childTools : undefined) },
  };
  const request = { name: "code-reviewer", allow: ["read"], persona: "只读审查者" };
  const holder: { current: typeof request | undefined } = { current: request };
  const ctx = {
    skills: { register: () => () => undefined },
    on: () => undefined,
    huaanworkAgentRequest: holder,
    subagents: {
      start: async () => ({ localAgent: childAgent }),
      startActivation: async () => ({ childId: "child", result: Promise.resolve({}), dispose: async () => undefined }),
    },
  };

  applySkills(ctx as never);
  await (ctx.subagents.startActivation as (spec: unknown) => Promise<unknown>)({
    provider: "spawn",
    label: "@legacy-assistant",
    request: { prompt: [], parent: { session: { id: "parent-session" } } },
    delivery: "parent",
  });

  // spec 没有调用级标记:包装不认领全局容器里的请求,也不清它。
  assert.deepEqual(
    childTools.visible.map((schema) => schema.name),
    ["read", "glob"],
  );
  assert.equal(holder.current, request);
});

test("subagent end drops the child registration so a finished child is never canceled", () => {
  const startListeners: Array<(info: unknown) => void> = [];
  const endListeners: Array<(info: unknown) => void> = [];
  // 真实 subagent/start 载荷只有 { runId, provider, id, local }:父会话从子会话 header 读。
  const children = new Map<string, unknown>([
    ["end-child", { session: { header: { parentSession: "end-parent" } } }],
    ["end-child-2", { session: { header: { parentSession: "end-parent-2" } } }],
  ]);
  const ctx = {
    skills: { register: () => () => undefined },
    on(event: string, listener: (info: unknown) => void) {
      if (event === "subagent/start") startListeners.push(listener);
      if (event === "subagent/end") endListeners.push(listener);
    },
    agents: { get: (id: string) => children.get(id) },
  };
  applySkills(ctx as never);
  const emitStart = (id: string) => {
    for (const listener of startListeners) listener({ runId: `run-${id}`, provider: "spawn", id, local: true });
  };
  const emitEnd = (payload: unknown) => {
    for (const listener of endListeners) listener(payload);
  };

  emitStart("end-child");
  emitStart("end-child-2");
  assert.deepEqual(childrenOf("end-parent"), ["end-child"]);
  assert.deepEqual(childrenOf("end-parent-2"), ["end-child-2"]);

  // 与 start 成对的结束事件:载荷 id 就是子会话 id,登记表必须随之收缩。
  emitEnd({ runId: "run-end-child", id: "end-child", stopReason: "completed" });
  assert.deepEqual(childrenOf("end-parent"), []);

  // 空 id / 缺 id 的结束事件不改动任何登记。
  emitEnd({ id: "" });
  emitEnd({});
  emitEnd({ id: 42 });
  assert.deepEqual(childrenOf("end-parent-2"), ["end-child-2"]);
  forgetChildSession("end-child-2");
});

test("a cold-resumed child stays on its header parent and a header-less child registers nowhere", () => {
  const startListeners: Array<(info: unknown) => void> = [];
  const agents = new Map<string, unknown>([
    ["cold-child-with-header", { session: { header: { parentSession: "huaanwork-cold-a" } } }],
    ["cold-child-no-header", { session: { header: {} } }],
  ]);
  const ctx = {
    skills: { register: () => () => undefined },
    on(event: string, listener: (info: unknown) => void) {
      if (event === "subagent/start") startListeners.push(listener);
    },
    agents: { get: (id: string) => agents.get(id) },
  };
  applySkills(ctx as never);
  for (const listener of startListeners) listener({ id: "cold-child-with-header", local: true });
  for (const listener of startListeners) listener({ id: "cold-child-no-header", local: true });
  assert.deepEqual(childrenOf("huaanwork-cold-a"), ["cold-child-with-header"]);
  // 没有 header parent 的子会话不登记到任何会话:没有调用槽可回落。
  assert.equal(parentSessionOf("cold-child-no-header"), undefined);
});

test("a no-parent subagent never inherits a model, root, or registration from another session", async () => {
  // 模型自主创建的嵌套子代理:args 不带 parent,子会话 header 也没有 parentSession。
  // 种子只走真实发送路径:修复前 sendToAgent 会把发起的会话写进进程级调用槽,
  // 修复后不再写;这里不直接碰任何槽 API,旧码靠生产写入留下可被继承的父会话。
  // 这类子代理不得继承任何会话的模型/可写根,也不得登记到那个会话名下。
  const startListeners: Array<(info: unknown) => void> = [];
  const models = new Map<string, string>([["sentinel-parent", "model-sentinel"]]);
  const roots = new Map<string, string>([["sentinel-parent", "/tmp/sentinel-root"]]);
  const agents = new Map<string, unknown>([
    [
      "sentinel-parent",
      {
        id: "sentinel-parent",
        session: { id: "sentinel-parent" },
        followup: () => undefined,
        whenIdle: async () => undefined,
      },
    ],
    ["nested-child", { session: { header: {} } }],
  ]);
  const ctx = {
    skills: { register: () => () => undefined },
    on(event: string, listener: (info: unknown) => void) {
      if (event === "subagent/start") startListeners.push(listener);
    },
    agents: { get: (id: string) => agents.get(id) },
    huaanworkSessionModels: models,
    huaanworkSessionRoots: roots,
    huaanworkTurnScheduler: createTurnScheduler({ maxConcurrentTurns: () => 64, modelExists: () => true }),
    subagents: {
      async startActivation(): Promise<unknown> {
        for (const listener of startListeners) {
          listener({ runId: "upstream-nested", provider: "spawn", id: "nested-child", local: true });
        }
        return { childId: "nested-child", result: new Promise(() => undefined), dispose: async () => undefined };
      },
    },
  };
  applySkills(ctx as never);

  const root = mkdtempSync(join(tmpdir(), "huaanwork-no-parent-"));
  try {
    // 不带 admission:槽写入(旧码)发生在准入之前,这里只关心发起会话是谁。
    await sendToAgent(
      ctx as never,
      {
        dshHome: join(root, "dsh"),
        profileDir: root,
        workspaceRoot: { current: join(root, "workspace") },
        emit: () => undefined,
        logger: () => undefined,
        requestRestart: async () => true,
      },
      { text: "seed", sessionId: "sentinel-parent" },
    );
    await (ctx.subagents.startActivation as () => Promise<unknown>)();

    assert.equal(models.has("nested-child"), false);
    assert.equal(roots.has("nested-child"), false);
    assert.equal(parentSessionOf("nested-child"), undefined);
    // 槽本身不存在:没有「最后发送的会话」可回落。
    assert.equal("noteCallerSession" in childSessions, false);
    assert.equal("currentCallerSession" in childSessions, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit parent in the activation args still inherits the model and root", async () => {
  // 去掉调用槽不得连带压掉正常的继承:activation 的 args 带 parent、子会话 header
  // 没有 parentSession 时,子会话仍复制父会话的模型/可写根并登记在父会话名下。
  const startListeners: Array<(info: unknown) => void> = [];
  const models = new Map<string, string>([["explicit-parent", "model-sentinel"]]);
  const roots = new Map<string, string>([["explicit-parent", "/tmp/sentinel-root"]]);
  const agents = new Map<string, unknown>([
    ["explicit-child", { session: { header: {} } }],
  ]);
  const ctx = {
    skills: { register: () => () => undefined },
    on(event: string, listener: (info: unknown) => void) {
      if (event === "subagent/start") startListeners.push(listener);
    },
    agents: { get: (id: string) => agents.get(id) },
    huaanworkSessionModels: models,
    huaanworkSessionRoots: roots,
    subagents: {
      async startActivation(): Promise<unknown> {
        for (const listener of startListeners) {
          listener({ runId: "upstream-explicit", provider: "spawn", id: "explicit-child", local: true });
        }
        return { childId: "explicit-child", result: new Promise(() => undefined), dispose: async () => undefined };
      },
    },
  };
  applySkills(ctx as never);

  await (ctx.subagents.startActivation as (spec: unknown) => Promise<unknown>)({
    request: { parent: "explicit-parent" },
  });

  assert.equal(models.get("explicit-child"), "model-sentinel");
  assert.equal(roots.get("explicit-child"), "/tmp/sentinel-root");
  assert.equal(parentSessionOf("explicit-child"), "explicit-parent");
  assert.deepEqual(childrenOf("explicit-parent"), ["explicit-child"]);
});

test("subagent start error still clears current request", async () => {
  const ctx = {
    skills: { register: () => () => undefined },
    on: () => undefined,
    huaanworkAgentRequest: {
      current: {
        name: "code-reviewer",
        allow: ["read"],
        persona: "valid persona",
      },
    },
    subagents: {
      start: async () => {
        throw new Error("subprocess crash");
      },
    },
  };

  applySkills(ctx as never);
  await assert.rejects(
    async () => {
      await ctx.subagents.start();
    },
    { message: "subprocess crash" },
  );
  assert.equal(ctx.huaanworkAgentRequest.current, undefined);
});

// ── 上游 start/end 与 Host run 的配对(Task 6)────────────────────────────────
// `startActivation` 包装把本次 Host runId 放进第二条 ALS,`subagent/start` 在同一个
// 异步作用域里派发,监听器据此绑定 upstream run;`subagent/end` 严格按 upstreamRunId
// 结算。模型自主创建的嵌套子代理没有 Host runId,只保留原有 parent-child 登记。

type ActivationFixture = {
  childId: string;
  localAgent?: Agent;
  result: Promise<unknown>;
  dispose: () => Promise<void>;
};

/** 只收集 subagent 生命周期监听器的 ctx;用例各自补齐服务面后再 apply。 */
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

test("subagent/start binds the activation host run id through AsyncLocalStorage", async () => {
  const registry = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined });
  const { ctx, emit } = lifecycleContext();
  const runId = registry.begin({ parentSessionId: "parent-1", kind: "legacy", label: "@reviewer" });
  let disposeCalls = 0;
  Object.assign(ctx, {
    huaanworkSubagentRuns: registry,
    subagents: {
      async startActivation(spec: { childId: string }): Promise<ActivationFixture> {
        emit("subagent/start", { runId: "upstream-1", provider: "spawn", id: spec.childId, local: true });
        return {
          childId: spec.childId,
          result: new Promise(() => undefined),
          dispose: async () => {
            disposeCalls += 1;
          },
        };
      },
    },
  });
  applySkills(ctx as never);

  await activateOf(ctx)({
    provider: "spawn",
    label: "@reviewer",
    childId: "child-1",
    request: { prompt: [], parent: liveParent("parent-1") },
    delivery: "parent",
    [HUAANWORK_SUBAGENT_RUN_ID]: runId,
  });

  assert.equal(registry.get(runId)?.upstreamRunId, "upstream-1");
  assert.equal(registry.get(runId)?.childId, "child-1");
  assert.equal(disposeCalls, 0);

  // ALS 作用域不外溢:activation 结束后同一 child 的 start 不再改写已绑定的 run。
  emit("subagent/start", { runId: "upstream-late", provider: "spawn", id: "child-1", local: true });
  assert.equal(registry.get(runId)?.upstreamRunId, "upstream-1");
});

test("a package activation binds the upstream start through its package request run id", async () => {
  const registry = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined });
  const { ctx, emit } = lifecycleContext();
  const runId = registry.begin({
    parentSessionId: "parent-1",
    kind: "package",
    label: "@pkg",
    packageVersion: "1.0.0",
  });
  const pkg: AgentPackageSubagentRequest = {
    runId,
    allow: [],
    persona: "包人设",
    runtime: {
      slug: "pkg",
      packageDir: "/tmp/pkg",
      workspaceRoot: "/tmp",
      skillScripts: [],
      runSkillScript: async () => ({ text: "" }),
    },
    parentSessionId: "parent-1",
    childId: "reserved-1",
    bindChild: () => undefined,
  };
  Object.assign(ctx, {
    huaanworkSubagentRuns: registry,
    huaanworkAgentPackageRequest: { current: pkg },
    subagents: {
      async startActivation(): Promise<ActivationFixture> {
        emit("subagent/start", { runId: "upstream-pkg", provider: "spawn", id: "child-9", local: true });
        return {
          childId: "child-9",
          result: new Promise(() => undefined),
          dispose: async () => undefined,
        };
      },
    },
  });
  applySkills(ctx as never);

  await activateOf(ctx)({
    provider: "spawn",
    label: "@pkg",
    childId: "reserved-1",
    request: { prompt: [], parent: liveParent("parent-1") },
    delivery: "parent",
  });

  // activation spec 没有 legacy 符号键:Host runId 取自包请求(Task 5 的 runId)。
  assert.equal(registry.get(runId)?.upstreamRunId, "upstream-pkg");
  // provider 另分配 childId 时包装不套用包工具;upstream 绑定仍落在本 run。
  assert.equal(registry.get(runId)?.childId, "child-9");
});

test("a foreign activation during a published package request never claims the package run", async () => {
  const registry = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined });
  const { ctx, emit } = lifecycleContext();
  const runId = registry.begin({ parentSessionId: "session-a", kind: "package", label: "@pkg" });
  registry.reserveChild(runId, "reserved-1");
  const pkg: AgentPackageSubagentRequest = {
    runId,
    allow: [],
    persona: "包人设",
    runtime: {
      slug: "pkg",
      packageDir: "/tmp/pkg",
      workspaceRoot: "/tmp",
      skillScripts: [],
      runSkillScript: async () => ({ text: "" }),
    },
    parentSessionId: "session-a",
    childId: "reserved-1",
    bindChild: () => undefined,
  };
  let disposeCalls = 0;
  Object.assign(ctx, {
    huaanworkSubagentRuns: registry,
    huaanworkAgentPackageRequest: { current: pkg },
    subagents: {
      async startActivation(spec: { childId: string }): Promise<ActivationFixture> {
        // 并发落进包发行窗口、且 spec 不带任何 run 标记的 activation(模型 subagent 工具):
        // 包请求是全局容器,不得把它的 runId 当成这次调用的 Host run。
        emit("subagent/start", { runId: "upstream-foreign", provider: "spawn", id: spec.childId, local: true });
        return {
          childId: spec.childId,
          result: new Promise(() => undefined),
          dispose: async () => {
            disposeCalls += 1;
          },
        };
      },
    },
  });
  applySkills(ctx as never);
  const activate = activateOf(ctx);

  // 另一会话的 activation:父会话与 pkg.parentSessionId 不同。
  await activate({
    provider: "spawn",
    label: "@foreign",
    childId: "foreign-child",
    request: { prompt: [], parent: liveParent("session-b") },
    delivery: "parent",
  });
  // 没有 parent 的 activation:调用方会话同样不是 session-a。包装会清掉本次快照,
  // 重新发布以保持第二段仍在包发行窗口内。
  (ctx.huaanworkAgentPackageRequest as { current: AgentPackageSubagentRequest | null }).current = pkg;
  await activate({
    provider: "spawn",
    label: "@foreign-no-parent",
    childId: "foreign-child-2",
    request: { prompt: [], parent: undefined },
    delivery: "parent",
  });

  // 包 run 保持原预留 identity,既没被重绑定,也没被伪 parent mismatch 释放。
  assert.equal(disposeCalls, 0);
  assert.equal(registry.get(runId)?.childId, "reserved-1");
  assert.equal(registry.get(runId)?.upstreamRunId, undefined);
  assert.equal(registry.get(runId)?.phase, "starting");
  assert.equal(registry.ownsChild("foreign-child"), false);
  assert.equal(registry.ownsChild("foreign-child-2"), false);

  // 外来 activation 的 end 也不得结算包 run 的候选。
  emit("subagent/end", {
    runId: "upstream-foreign",
    provider: "spawn",
    id: "foreign-child",
    local: true,
    stopReason: "error",
  });
  assert.equal(registry.get(runId)?.phase, "starting");
  assert.equal(registry.get(runId)?.stopReason, undefined);
  assert.deepEqual(registry.get(runId)?.cleanupWarnings, []);
});

test("a same-session activation without the reserved child id never adopts the package run", async () => {
  const registry = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined });
  const { ctx, emit } = lifecycleContext();
  const runId = registry.begin({ parentSessionId: "session-a", kind: "package", label: "@pkg" });
  registry.reserveChild(runId, "reserved-child");
  let bindChildCalls = 0;
  const pkg: AgentPackageSubagentRequest = {
    runId,
    allow: [],
    persona: "包人设",
    runtime: {
      slug: "pkg",
      packageDir: "/tmp/pkg",
      workspaceRoot: "/tmp",
      skillScripts: [],
      runSkillScript: async () => ({ text: "" }),
    },
    parentSessionId: "session-a",
    childId: "reserved-child",
    bindChild: () => {
      bindChildCalls += 1;
    },
  };
  let disposeCalls = 0;
  Object.assign(ctx, {
    huaanworkSubagentRuns: registry,
    huaanworkAgentPackageRequest: { current: pkg },
    subagents: {
      async startActivation(spec: { childId?: string }): Promise<ActivationFixture> {
        // 父会话谓词成立,但这次 activation 没有 Host runId 符号键、childId 也不是预留值:
        // 包请求只属于携带预留子会话 id 的那次 activation,不得被这里借用。
        const childId = spec.childId ?? "provider-assigned";
        emit("subagent/start", { runId: "upstream-foreign", provider: "spawn", id: childId, local: true });
        return {
          childId,
          result: new Promise(() => undefined),
          dispose: async () => {
            disposeCalls += 1;
          },
        };
      },
    },
  });
  applySkills(ctx as never);
  const activate = activateOf(ctx);

  // 同一父会话(session-a),childId 不同。
  await activate({
    provider: "spawn",
    label: "@same-session-other-child",
    childId: "foreign-child",
    request: { prompt: [], parent: liveParent("session-a") },
    delivery: "parent",
  });
  // 同一父会话,spec 不带 childId;provider 自行分配 id。
  (ctx.huaanworkAgentPackageRequest as { current: AgentPackageSubagentRequest | null }).current = pkg;
  await activate({
    provider: "spawn",
    label: "@same-session-no-child",
    request: { prompt: [], parent: liveParent("session-a") },
    delivery: "parent",
  });

  // 包 run 保持预留 identity:没被重绑定,也没有被伪 parent mismatch 释放。
  assert.equal(disposeCalls, 0);
  assert.equal(registry.get(runId)?.childId, "reserved-child");
  assert.equal(registry.get(runId)?.upstreamRunId, undefined);
  assert.equal(registry.get(runId)?.phase, "starting");
  // 外来 activation 没有被当成包回合:包绑定与工具限制都不执行。
  assert.equal(bindChildCalls, 0);
  assert.equal(registry.ownsChild("reserved-child"), true);
  assert.equal(registry.ownsChild("foreign-child"), false);
  assert.equal(registry.ownsChild("provider-assigned"), false);
  assert.deepEqual(registry.get(runId)?.cleanupWarnings, []);
});

test("an old upstream end settles only the run that owns its upstream run id", async () => {
  const registry = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined });
  const { ctx, emit } = lifecycleContext();
  const oldRunId = registry.begin({ parentSessionId: "parent-1", kind: "legacy", label: "@old" });
  const newRunId = registry.begin({ parentSessionId: "parent-1", kind: "legacy", label: "@new" });
  let upstream = "";
  Object.assign(ctx, {
    huaanworkSubagentRuns: registry,
    subagents: {
      async startActivation(spec: { childId: string }): Promise<ActivationFixture> {
        emit("subagent/start", { runId: upstream, provider: "spawn", id: spec.childId, local: true });
        return {
          childId: spec.childId,
          result: new Promise(() => undefined),
          dispose: async () => undefined,
        };
      },
    },
  });
  applySkills(ctx as never);
  const activate = activateOf(ctx);
  const specFor = (runId: string, childId: string) => ({
    provider: "spawn",
    label: "@legacy",
    childId,
    request: { prompt: [], parent: liveParent("parent-1") },
    delivery: "parent",
    [HUAANWORK_SUBAGENT_RUN_ID]: runId,
  });

  upstream = "upstream-old";
  await activate(specFor(oldRunId, "child-a"));
  registry.settleResult(oldRunId, { stopReason: "completed" });
  upstream = "upstream-new";
  await activate(specFor(newRunId, "child-b"));
  assert.equal(registry.get(oldRunId)?.upstreamRunId, "upstream-old");
  assert.equal(registry.get(newRunId)?.upstreamRunId, "upstream-new");

  // 旧 run 的 end 迟到:只结算旧 run(result 已 completed ⇒ 只补 upstream-end-error)。
  emit("subagent/end", { runId: "upstream-old", provider: "spawn", id: "child-a", local: true, stopReason: "error" });
  assert.deepEqual(registry.get(oldRunId)?.cleanupWarnings, [{ code: "upstream-end-error", severity: "error" }]);
  // 新 run 不被旧 end 改写或清理。
  assert.equal(registry.get(newRunId)?.phase, "starting");
  assert.equal(registry.get(newRunId)?.stopReason, undefined);
  assert.deepEqual(registry.get(newRunId)?.cleanupWarnings, []);
  assert.equal(registry.get(newRunId)?.upstreamRunId, "upstream-new");
});

test("a nested subagent without a host run id only keeps the parent-child registration", async () => {
  const registry = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined });
  const { ctx, emit } = lifecycleContext();
  Object.assign(ctx, {
    huaanworkSubagentRuns: registry,
    agents: {
      get: (id: string) =>
        id === "nested-child" ? { session: { header: { parentSession: "nested-parent" } } } : undefined,
    },
    subagents: {
      startActivation: async (): Promise<ActivationFixture> => {
        throw new Error("this fixture has no activation");
      },
    },
  });
  applySkills(ctx as never);

  // 模型自主创建的嵌套子代理:没有 Host runId(不在任何 activation 的 ALS 作用域里)。
  emit("subagent/start", { runId: "upstream-nested", provider: "spawn", id: "nested-child", local: true });

  assert.deepEqual(childrenOf("nested-parent"), ["nested-child"]);
  assert.equal(registry.ownsChild("nested-child"), false);
  assert.deepEqual(registry.snapshot("nested-parent").runs, []);
});

test("a nested activation inside an outer run shadows the host run id", async () => {
  const registry = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined });
  const { ctx, emit } = lifecycleContext();
  const runId = registry.begin({ parentSessionId: "parent-1", kind: "legacy", label: "@outer" });
  Object.assign(ctx, {
    huaanworkSubagentRuns: registry,
    subagents: {
      // 模型自主的嵌套子代理走同一个被包装的入口;包装以 undefined 覆盖 ALS,
      // 嵌套 start 因此不会绑定到外层 run。
      async startActivation(spec: { label: string; childId: string }): Promise<ActivationFixture> {
        if (spec.label === "@outer") {
          await activateOf(ctx)({
            provider: "spawn",
            label: "@nested",
            childId: "nested-child",
            request: { prompt: [], parent: liveParent("child-1") },
            delivery: "parent",
          });
          emit("subagent/start", { runId: "upstream-outer", provider: "spawn", id: spec.childId, local: true });
        } else {
          emit("subagent/start", { runId: "upstream-nested", provider: "spawn", id: spec.childId, local: true });
        }
        return {
          childId: spec.childId,
          result: new Promise(() => undefined),
          dispose: async () => undefined,
        };
      },
    },
  });
  applySkills(ctx as never);

  await activateOf(ctx)({
    provider: "spawn",
    label: "@outer",
    childId: "child-1",
    request: { prompt: [], parent: liveParent("parent-1") },
    delivery: "parent",
    [HUAANWORK_SUBAGENT_RUN_ID]: runId,
  });

  assert.equal(registry.get(runId)?.upstreamRunId, "upstream-outer");
  assert.equal(registry.get(runId)?.childId, "child-1");
  assert.equal(registry.ownsChild("nested-child"), false);
});

test("a mismatched activation parent is disposed and rejected before any tool restrict", async () => {
  const registry = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined });
  const { ctx, emit } = lifecycleContext();
  const runId = registry.begin({ parentSessionId: "parent-a", kind: "legacy", label: "@legacy" });
  const childTools = createTools(["read", "glob"]);
  const originalRestrict = childTools.restrict.bind(childTools);
  let restrictCalls = 0;
  childTools.restrict = (filter) => {
    restrictCalls += 1;
    return originalRestrict(filter);
  };
  const localAgent: Agent = {
    id: "child-1",
    ctx: { get: (name) => (name === "tools" ? childTools : undefined) },
  };
  let disposeCalls = 0;
  Object.assign(ctx, {
    huaanworkSubagentRuns: registry,
    subagents: {
      // 上游正常发布 activation:测试证明的是包装层 fail closed,不是上游拒绝。
      startActivation: async (): Promise<ActivationFixture> => {
        emit("subagent/start", { runId: "upstream-mismatch", provider: "spawn", id: "child-1", local: true });
        return {
          childId: "child-1",
          localAgent,
          result: new Promise(() => undefined),
          dispose: async () => {
            disposeCalls += 1;
          },
        };
      },
    },
  });
  applySkills(ctx as never);

  await assert.rejects(
    activateOf(ctx)({
      provider: "spawn",
      label: "@legacy",
      childId: "child-1",
      // 另一个 live Agent 作父会话:ALS/activation parent 都是 parent-b,registry 是 parent-a。
      request: { prompt: [], parent: liveParent("parent-b") },
      delivery: "parent",
      // 带 legacy 请求 ⇒ 若校验晚于 restrict,restrictCalls 会大于 0。
      [HUAANWORK_LEGACY_AGENT_REQUEST]: { name: "legacy", allow: ["read"], persona: "只读审查者" },
      [HUAANWORK_SUBAGENT_RUN_ID]: runId,
    }),
    { message: "subagent activation parent mismatch" },
  );

  assert.equal(disposeCalls, 1);
  assert.equal(restrictCalls, 0);
  assert.deepEqual(childTools.visible.map((schema) => schema.name), ["read", "glob"]);
  assert.equal(registry.get(runId)?.phase, "starting");
  // 监听器在登记表 parent 与 activation parent 不一致时不绑定:run 的 identity 不变。
  assert.equal(registry.get(runId)?.upstreamRunId, undefined);
  assert.equal(registry.get(runId)?.childId, undefined);
});

test("a dispose failure never replaces the parent mismatch error", async () => {
  const registry = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined });
  const { ctx } = lifecycleContext();
  const runId = registry.begin({ parentSessionId: "parent-a", kind: "legacy", label: "@legacy" });
  let disposeCalls = 0;
  Object.assign(ctx, {
    huaanworkSubagentRuns: registry,
    subagents: {
      startActivation: async (): Promise<ActivationFixture> => ({
        childId: "child-1",
        result: new Promise(() => undefined),
        dispose: async () => {
          disposeCalls += 1;
          throw new Error("dispose failed");
        },
      }),
    },
  });
  applySkills(ctx as never);

  await assert.rejects(
    activateOf(ctx)({
      provider: "spawn",
      label: "@legacy",
      childId: "child-1",
      request: { prompt: [], parent: liveParent("parent-b") },
      delivery: "parent",
      [HUAANWORK_SUBAGENT_RUN_ID]: runId,
    }),
    { message: "subagent activation parent mismatch" },
  );
  assert.equal(disposeCalls, 1);
});

// ── Task 2: 系统技能租约可见性 + spawnKind ALS(token 精确消费) ────────────────

function agentWithTools(id: string, tools: ReturnType<typeof createTools>, sessionId?: string): Agent {
  return {
    id,
    ...(sessionId === undefined ? {} : { session: { id: sessionId } }),
    ctx: { get: (name) => (name === "tools" ? tools : undefined) },
  };
}

test("a system-skill turn acquires the lease, makes subagent visible, and is idempotent", async () => {
  const harness = createHarness();
  // present-as 基线不再放行 subagent；租约把附件挂回来后模型才看得到。
  assert.equal(harness.parentTools.visible.some((schema) => schema.name === "subagent"), false);
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
  assert.equal(harness.parentTools.visible.some((schema) => schema.name === "subagent"), true);
  assert.equal(harness.attachments.sessionAgentTools.get("main")?.has("subagent"), true);
  assert.equal(systemSkillLeaseKindOf(harness.ctx as never, "main"), "explore");

  // 重复 acquire 幂等：附件集合不膨胀，租约类型保持。
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
  assert.equal(harness.attachments.sessionAgentTools.get("main")?.size, 1);
  assert.equal(systemSkillLeaseKindOf(harness.ctx as never, "main"), "explore");
});

test("an unattended automation turn never acquires the lease or caches a skill kind", async () => {
  const harness = createHarness();
  (harness.ctx.huaanworkUnattended as Map<string, unknown>).set("main", {
    runId: "r",
    automationId: "a",
    allow: new Set(),
  });
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
  assert.equal(harness.attachments.sessionAgentTools.has("main"), false);
  assert.equal(systemSkillLeaseKindOf(harness.ctx as never, "main"), undefined);

  // acquire 返回 false 时不得写入 pendingByAgent：派生的子代理保持基线（可写），
  // 不是 explore 的只读工具表。
  await harness.invokeSubagent(harness.parent);
  assert.ok(harness.childTools.visible.some((schema) => schema.name === "edit"));
  assert.equal(harness.guardReason(harness.childTools, "edit"), undefined);
});

test("a legacy child is denied before any cache write; a managed package child can acquire", async () => {
  const harness = createHarness();
  registerChildSession("legacy-parent", "child");
  const denied = (await harness.invokeSkill(harness.child, "explore")) as Decision;
  assert.equal(denied.kind, "deny");
  assert.equal(denied.reason, "unmanaged-child-system-skill");
  assert.equal(harness.attachments.sessionAgentTools.has("child"), false);

  // 包儿童：血缘 allow 表有条目 ⇒ 受管，可以获取租约（锚点在场）。
  const pkgTools = createTools(DEFAULT_TOOL_NAMES);
  const pkgChild = agentWithTools("pkg-child", pkgTools);
  harness.addAgent(pkgChild);
  registerChildSession("pkg-parent", "pkg-child");
  (harness.ctx.huaanworkPackageChildAllow as Map<string, readonly string[]>).set("pkg-child", ["read", "subagent"]);
  harness.anchors.register({ sessionId: "pkg-child", clientMessageId: "pkg-user", origin: "advanced" });
  harness.anchors.notePreStep(
    "pkg-child",
    [{ role: "user", id: "pkg-user", source: { kind: "user" } }],
    new Date().toISOString(),
  );
  assert.equal((await harness.invokeSkill(pkgChild, "explore")).kind, "allow");
  assert.equal(harness.attachments.sessionAgentTools.get("pkg-child")?.has("subagent"), true);
  assert.equal(systemSkillLeaseKindOf(harness.ctx as never, "pkg-child"), "explore");
});

test("PC-1: the dispatch kind rides tools/execute into the body and never leaks into a later explicit @", async () => {
  const harness = createHarness();
  const atTools = createTools(DEFAULT_TOOL_NAMES);
  const atChild = agentWithTools("at-child", atTools);
  harness.addAgent(atChild);

  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
  assert.equal(harness.parentTools.visible.some((schema) => schema.name === "subagent"), true);
  let kindInBody: string | undefined;
  const decision = await harness.dispatchTool(harness.parent, "subagent", { prompt: "look" }, async () => {
    kindInBody = currentDispatchSkillKind();
    harness.emit("agent/created", { agent: harness.child });
    harness.emit("subagent/start", { id: harness.child.id, local: true });
    return { ok: true };
  });
  assert.equal(decision.kind, "allow");
  // PC-1 防假绿：kind 必须在 body 阶段可见；错挂到 pre-execute 时这里是 undefined。
  assert.equal(kindInBody, "explore");
  assert.deepEqual(
    harness.childTools.visible.map((schema) => schema.name),
    ["read", "read_file", "glob", "grep"],
  );

  // 派发结束（takeSlotForExecute 已精确释放本次兼容槽）：显式 @ 走 startActivation，
  // 无 ALS、无残留槽，不得被继承成 explore 只读子代理。
  await harness.activate(atChild);
  assert.ok(atTools.visible.some((schema) => schema.name === "write"));
  assert.equal(harness.guardReason(atTools, "write"), undefined);
});

test("QP-I1: a deny or throw after pre-execute never pollutes a later explicit @", async () => {
  for (const mode of ["deny", "throw"] as const) {
    resetChildSessionRegistry();
    const harness = createHarness();
    const atTools = createTools(DEFAULT_TOOL_NAMES);
    const atChild = agentWithTools(`at-child-${mode}`, atTools);
    harness.addAgent(atChild);
    assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");

    let armed = true;
    harness.onPreExecute((_execution, next) => {
      if (!armed) return next?.();
      armed = false;
      if (mode === "deny") return { kind: "deny", reason: "downstream-deny" };
      throw new Error("downstream boom");
    });

    if (mode === "deny") {
      assert.deepEqual(await harness.invokeSubagent(harness.parent), { kind: "deny", reason: "downstream-deny" });
    } else {
      await assert.rejects(() => harness.invokeSubagent(harness.parent), /downstream boom/);
    }

    await harness.activate(atChild);
    assert.ok(atTools.visible.some((schema) => schema.name === "write"), `${mode}: explicit @ stays baseline`);
    assert.equal(harness.guardReason(atTools, "write"), undefined, `${mode}: no explore guard leaks`);
  }
});

test("QR-I1: an allow that later settles through tools/result cleans the pending slot idempotently", async () => {
  const harness = createHarness();
  const atTools = createTools(DEFAULT_TOOL_NAMES);
  const atChild = agentWithTools("at-child-result", atTools);
  harness.addAgent(atChild);
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");

  const { decision, execution } = await harness.preExecute(harness.parent, "subagent", { prompt: "cancelled" });
  assert.equal(decision.kind, "allow");
  // 等待期取消：上游 prepareExecution 直接返回 post-result，跳过 tools/execute。
  harness.emit("tools/result", execution);
  harness.emit("tools/result", execution); // 幂等

  await harness.activate(atChild);
  assert.ok(atTools.visible.some((schema) => schema.name === "write"));
  assert.equal(harness.guardReason(atTools, "write"), undefined);
});

test("QR-I1: a downstream guard rejection after allow also leaves no slot behind", async () => {
  const harness = createHarness();
  const atTools = createTools(DEFAULT_TOOL_NAMES);
  const atChild = agentWithTools("at-child-guard", atTools);
  harness.addAgent(atChild);
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");

  let guardArmed = true;
  harness.parentTools.guard(() => {
    if (!guardArmed) return undefined;
    guardArmed = false;
    return "policy-guard";
  });
  const { decision, execution } = await harness.preExecute(harness.parent, "subagent", { prompt: "guarded" });
  assert.equal(decision.kind, "allow");
  assert.equal(harness.guardReason(harness.parentTools, "subagent"), "policy-guard");
  harness.emit("tools/result", execution);

  await harness.activate(atChild);
  assert.ok(atTools.visible.some((schema) => schema.name === "write"));
  assert.equal(harness.guardReason(atTools, "write"), undefined);
});

test("QP-I1: an overlapping compatible dispatch never clears another call's pending slot", async () => {
  for (const finish of ["execute", "result"] as const) {
    resetChildSessionRegistry();
    const harness = createHarness();
    const otherTools = createTools(DEFAULT_TOOL_NAMES);
    const other = agentWithTools("other", otherTools, "other-session");
    harness.addAgent(other);
    const store = harness.ctx.huaanworkSystemSkillLeases as ReturnType<typeof createSystemSkillLeaseStore>;
    assert.equal(store.acquireExplicit("other-session", "explore"), true);
    assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");

    // A 完成 pre-execute；B（兼容路径、无 ALS）随后写入自己的 pendingSpawn。
    const a = await harness.preExecute(harness.parent, "subagent", { prompt: "a" });
    const b = await harness.preExecute(other, "subagent", { prompt: "b" });
    assert.equal(a.decision.kind, "allow");
    assert.equal(b.decision.kind, "allow");

    if (finish === "execute") {
      let kindA: string | undefined;
      await harness.runExecute(a.execution, async () => {
        kindA = currentDispatchSkillKind();
        return {};
      });
      assert.equal(kindA, "explore");
    } else {
      harness.emit("tools/result", a.execution);
    }

    // B 的兼容槽仍有效：显式 @（无 ALS）消费到 explore 收窄。
    const otherChildTools = createTools(DEFAULT_TOOL_NAMES);
    const otherChild = agentWithTools(`other-child-${finish}`, otherChildTools);
    harness.addAgent(otherChild);
    await harness.activate(otherChild, "other-session");
    assert.deepEqual(
      otherChildTools.visible.map((schema) => schema.name).sort(),
      ["glob", "grep", "read", "read_file"].sort(),
      `${finish}: B's compatibility slot survives A's cleanup`,
    );
  }
});

test("QR-I2: an explicit system skill switch invalidates the stale skill cache and the lease kind wins", async () => {
  const harness = createHarness();
  assert.equal((await harness.invokeSkill(harness.parent, "test-fix")).kind, "allow");

  const fixChildTools = createTools(DEFAULT_TOOL_NAMES);
  const fixChild = agentWithTools("fix-child", fixChildTools);
  harness.addAgent(fixChild);
  await harness.invokeSubagent(harness.parent, fixChild);
  assert.ok(fixChildTools.visible.some((schema) => schema.name === "write"));

  // 显式 /explore 重挂租约：同一父 agent 的旧 test-fix 缓存被同步失效。
  const store = harness.ctx.huaanworkSystemSkillLeases as ReturnType<typeof createSystemSkillLeaseStore>;
  assert.equal(store.acquireExplicit("main", "explore"), true);
  assert.equal(systemSkillLeaseKindOf(harness.ctx as never, "main"), "explore");
  const exploreChildTools = createTools(DEFAULT_TOOL_NAMES);
  const exploreChild = agentWithTools("explore-child", exploreChildTools);
  harness.addAgent(exploreChild);
  await harness.invokeSubagent(harness.parent, exploreChild);
  assert.deepEqual(
    exploreChildTools.visible.map((schema) => schema.name),
    ["read", "read_file", "glob", "grep"],
  );

  // 反向 /test-fix：允许写工具。
  assert.equal(store.acquireExplicit("main", "test-fix"), true);
  const fixAgainTools = createTools(DEFAULT_TOOL_NAMES);
  const fixAgain = agentWithTools("fix-again", fixAgainTools);
  harness.addAgent(fixAgain);
  await harness.invokeSubagent(harness.parent, fixAgain);
  assert.ok(fixAgainTools.visible.some((schema) => schema.name === "write"));
  assert.equal(harness.guardReason(fixAgainTools, "write"), undefined);
});

// ── Task 3: system-skill 运行进入 registry 并支持定向取消 ─────────────────────

function otherParentAgent(harness: ReturnType<typeof createHarness>, id: string, sessionId: string): Agent {
  const agent = agentWithTools(id, createTools(DEFAULT_TOOL_NAMES), sessionId);
  harness.addAgent(agent);
  const store = harness.ctx.huaanworkSystemSkillLeases as ReturnType<typeof createSystemSkillLeaseStore>;
  assert.equal(store.acquireExplicit(sessionId, "explore"), true);
  return agent;
}

test("a system-skill spawn is visible in the registry before the activation releases", async () => {
  const harness = createHarness();
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
  const disposed: string[] = [];
  const { executionDone } = await harness.beginSubagentSpawn(harness.parent, { target: harness.child });

  const runs = harness.runs.snapshot("main").runs;
  assert.equal(runs.length, 1);
  const run = runs[0]!;
  assert.ok(run.runId.length > 0);
  assert.deepEqual(
    {
      kind: run.kind,
      phase: run.phase,
      label: run.label,
      parentSessionId: run.parentSessionId,
      clientMessageId: run.clientMessageId,
    },
    {
      kind: "system-skill",
      phase: "starting",
      label: "explore",
      parentSessionId: "main",
      clientMessageId: TURN_MESSAGE_ID,
    },
  );

  harness.releaseActivation({
    childId: "child",
    localAgent: harness.child,
    dispose: async () => {
      disposed.push("child");
    },
  });
  await executionDone;
  await vi.waitFor(() => {
    assert.equal(harness.runs.get(run.runId)?.phase, "completed");
    assert.deepEqual(disposed, ["child"]);
  });
  const settled = harness.runs.get(run.runId)!;
  assert.equal(settled.childId, "child");
  assert.equal(settled.upstreamRunId, "upstream-child");
  assert.deepEqual(settled.cleanupWarnings, []);
});

test("an automation turn anchors its system-skill run to the automation run id", async () => {
  const harness = createHarness({
    anchor: { sessionId: "main", clientMessageId: "automation-run-7", origin: "automation" },
  });
  assert.equal((await harness.invokeSkill(harness.parent, "test-fix")).kind, "allow");
  const { executionDone } = await harness.beginSubagentSpawn(harness.parent, { target: harness.child });
  const run = harness.runs.snapshot("main").runs[0]!;
  assert.equal(run.kind, "system-skill");
  assert.equal(run.label, "test-fix");
  assert.equal(run.clientMessageId, "automation-run-7");
  harness.releaseActivation({ childId: "child", localAgent: harness.child });
  await executionDone;
});

test("a missing run registry fails the system-skill spawn loudly before any activation", async () => {
  const harness = createHarness();
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
  harness.ctx.huaanworkSubagentRuns = undefined;
  const started = await harness.startSubagentSpawn(harness.parent, {
    provider: "spawn",
    label: "system-skill",
    childId: "child",
    request: { prompt: [], parent: { session: { id: "main" } } },
    delivery: "parent",
  });
  assert.equal(started.entry, undefined);
  await assert.rejects(started.executionDone, { message: "subagent run registry is not initialized" });
  assert.equal(harness.activationGates.length, 0);
});

test("an unresolvable activation child id disposes, fails, confirms cleanup, and throws", async () => {
  const harness = createHarness();
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
  const disposed: string[] = [];
  const { executionDone } = await harness.beginSubagentSpawn(harness.parent);
  const runId = harness.runs.snapshot("main").runs[0]!.runId;
  harness.releaseActivation({
    childId: "",
    emitEvents: false,
    dispose: async () => {
      disposed.push("empty-child");
    },
  });
  await assert.rejects(executionDone, /subagent activation child id missing/);
  assert.deepEqual(disposed, ["empty-child"]);
  const run = harness.runs.get(runId)!;
  assert.equal(run.phase, "failed");
  assert.match(run.failure ?? "", /child id missing/);
  assert.deepEqual(run.cleanupWarnings, []);
});

test("a reserved spec child id the activation does not reuse fails closed without binding", async () => {
  const harness = createHarness();
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
  const disposed: string[] = [];
  const bound: string[] = [];
  const bindActivation = harness.runs.bindActivation.bind(harness.runs);
  harness.runs.bindActivation = (runId, input) => {
    bound.push(input.childId);
    bindActivation(runId, input);
  };
  const { executionDone } = await harness.beginSubagentSpawn(harness.parent, {
    specChildId: "reserved-1",
    target: harness.child,
  });
  const runId = harness.runs.snapshot("main").runs[0]!.runId;
  assert.equal(harness.runs.get(runId)?.childId, "reserved-1");
  harness.releaseActivation({
    childId: "child",
    localAgent: harness.child,
    dispose: async () => {
      disposed.push("mismatch");
    },
  });
  await assert.rejects(executionDone, /subagent activation child mismatch/);
  assert.deepEqual(disposed, ["mismatch"]);
  assert.deepEqual(bound, []);
  const run = harness.runs.get(runId)!;
  assert.equal(run.phase, "failed");
  assert.match(run.failure ?? "", /child mismatch/);
});

test("an activation without a reserved child id binds the provider-assigned child id", async () => {
  const harness = createHarness();
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
  const { executionDone } = await harness.beginSubagentSpawn(harness.parent, { specChildId: "omit" });
  const runId = harness.runs.snapshot("main").runs[0]!.runId;
  harness.releaseActivation({ childId: "provider-child", localAgent: harness.child });
  await executionDone;
  await vi.waitFor(() => assert.equal(harness.runs.get(runId)?.phase, "completed"));
  assert.equal(harness.runs.get(runId)?.childId, "provider-child");
});

test("an activation rejection fails the system-skill run and confirms cleanup", async () => {
  const harness = createHarness();
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
  const { executionDone } = await harness.beginSubagentSpawn(harness.parent, { target: harness.child });
  const runId = harness.runs.snapshot("main").runs[0]!.runId;
  harness.failActivation(new Error("activation refused"));
  await assert.rejects(executionDone, /activation refused/);
  const run = harness.runs.get(runId)!;
  assert.equal(run.phase, "failed");
  assert.equal(run.failure, "activation refused");
  assert.deepEqual(run.cleanupWarnings, []);
});

test("a targeted cancel stops only the selected system-skill run", async () => {
  const harness = createHarness();
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
  const disposed: string[] = [];

  let resolveRunA!: (value: { stopReason: string }) => void;
  const resultA = new Promise<{ stopReason: string }>((resolve) => {
    resolveRunA = resolve;
  });
  const runASpawn = await harness.beginSubagentSpawn(harness.parent, { target: harness.child });
  harness.releaseActivation({
    childId: "child",
    localAgent: harness.child,
    result: resultA,
    dispose: async () => {
      disposed.push("a");
    },
  });
  await runASpawn.executionDone;
  const runA = harness.runs.snapshot("main").runs[0]!.runId;

  const sibling = agentWithTools("sibling-child", createTools(DEFAULT_TOOL_NAMES));
  harness.addAgent(sibling);
  const runBSpawn = await harness.beginSubagentSpawn(harness.parent, { target: sibling });
  harness.releaseActivation({
    childId: "sibling-child",
    localAgent: sibling,
    upstreamRunId: "upstream-sibling",
    result: new Promise(() => undefined),
    dispose: async () => {
      disposed.push("b");
    },
  });
  await runBSpawn.executionDone;
  const runB = harness.runs.snapshot("main").runs.find((run) => run.runId !== runA)!.runId;

  const other = otherParentAgent(harness, "other-parent-child", "other-session");
  const runCSpawn = await harness.beginSubagentSpawn(other, { parentSessionId: "other-session" });
  harness.releaseActivation({
    childId: "other-parent-child",
    localAgent: other,
    upstreamRunId: "upstream-other",
    result: new Promise(() => undefined),
    dispose: async () => {
      disposed.push("c");
    },
  });
  await runCSpawn.executionDone;
  const runC = harness.runs.snapshot("other-session").runs[0]!.runId;

  assert.deepEqual(await harness.runs.requestCancel("main", runA), { status: "accepted", runId: runA });
  resolveRunA({ stopReason: "aborted" });
  await vi.waitFor(() => assert.equal(harness.runs.get(runA)?.phase, "stopped"));
  assert.deepEqual(disposed, ["a"]);
  assert.equal(harness.runs.get(runA)?.stopReason, "aborted");
  assert.equal(harness.runs.get(runB)?.phase, "starting");
  assert.equal(harness.runs.get(runC)?.phase, "starting");
  assert.equal(harness.runs.get(runC)?.stopRequestedAt, undefined);
  await assert.rejects(harness.runs.requestCancel("main", runC), /subagent run not found/);
  await assert.rejects(harness.runs.requestCancel("other-session", runA), /subagent run not found/);
});

test("a cancel accepted while the activation is pending converges to stopped after the late dispose", async () => {
  const harness = createHarness();
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
  const disposed: string[] = [];
  const { executionDone } = await harness.beginSubagentSpawn(harness.parent, { target: harness.child });
  const runId = harness.runs.snapshot("main").runs[0]!.runId;

  assert.deepEqual(await harness.runs.requestCancel("main", runId), { status: "accepted", runId });
  assert.equal(harness.runs.get(runId)?.phase, "stopping");

  harness.releaseActivation({
    childId: "child",
    localAgent: harness.child,
    result: Promise.resolve({ stopReason: "aborted" }),
    dispose: async () => {
      disposed.push("late");
    },
  });
  await assert.rejects(executionDone, /已取消/);
  await vi.waitFor(() => assert.equal(harness.runs.get(runId)?.phase, "stopped"));
  assert.deepEqual(disposed, ["late"]);
  assert.equal(harness.runs.get(runId)?.stopReason, "aborted");
});

test("a cancel accepted while pending still converges when the activation rejects", async () => {
  const harness = createHarness();
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
  const { executionDone } = await harness.beginSubagentSpawn(harness.parent, { target: harness.child });
  const runId = harness.runs.snapshot("main").runs[0]!.runId;

  assert.deepEqual(await harness.runs.requestCancel("main", runId), { status: "accepted", runId });
  harness.failActivation(new Error("启动被取消"));
  await assert.rejects(executionDone, /启动被取消/);
  const run = harness.runs.get(runId)!;
  assert.equal(run.phase, "stopped");
  assert.equal(run.failure, "启动被取消");
  assert.deepEqual(run.cleanupWarnings, []);
});

test("a cancel accepted while pending still converges when the activation returns an empty child id", async () => {
  const harness = createHarness();
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
  const disposed: string[] = [];
  const { executionDone } = await harness.beginSubagentSpawn(harness.parent);
  const runId = harness.runs.snapshot("main").runs[0]!.runId;

  assert.deepEqual(await harness.runs.requestCancel("main", runId), { status: "accepted", runId });
  harness.releaseActivation({
    childId: "",
    emitEvents: false,
    dispose: async () => {
      disposed.push("empty");
    },
  });
  await assert.rejects(executionDone, /subagent activation child id missing/);
  assert.deepEqual(disposed, ["empty"]);
  const run = harness.runs.get(runId)!;
  assert.equal(run.phase, "stopped");
  assert.match(run.failure ?? "", /child id missing/);
});

test("the post-dispose result window uses an independent budget instead of the aborted signal", async () => {
  vi.useFakeTimers();
  try {
    const harness = createHarness();
    assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
    const disposed: string[] = [];

    const runA = await harness.beginSubagentSpawn(harness.parent, { target: harness.child });
    harness.releaseActivation({
      childId: "child",
      localAgent: harness.child,
      result: new Promise(() => undefined),
      dispose: async () => {
        disposed.push("a");
      },
    });
    await runA.executionDone;
    const runAId = harness.runs.snapshot("main").runs[0]!.runId;

    const sibling = agentWithTools("sibling-window", createTools(DEFAULT_TOOL_NAMES));
    harness.addAgent(sibling);
    const runB = await harness.beginSubagentSpawn(harness.parent, { target: sibling });
    harness.releaseActivation({
      childId: "sibling-window",
      localAgent: sibling,
      result: new Promise(() => undefined),
    });
    await runB.executionDone;
    const runBId = harness.runs.snapshot("main").runs.find((run) => run.runId !== runAId)!.runId;

    const other = otherParentAgent(harness, "other-window", "other-session");
    const runC = await harness.beginSubagentSpawn(other, { parentSessionId: "other-session" });
    harness.releaseActivation({
      childId: "other-window",
      localAgent: other,
      result: new Promise(() => undefined),
    });
    await runC.executionDone;
    const runCId = harness.runs.snapshot("other-session").runs[0]!.runId;

    assert.deepEqual(await harness.runs.requestCancel("main", runAId), { status: "accepted", runId: runAId });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(harness.runs.get(runAId)?.phase, "stopping");
    assert.equal(
      harness.runs.get(runAId)?.failure,
      undefined,
      "the aborted controller signal must not short-circuit the window",
    );
    await vi.advanceTimersByTimeAsync(ACTIVATION_CLEANUP_TIMEOUT_MS - 1);
    assert.equal(harness.runs.get(runAId)?.phase, "stopping");
    assert.equal(harness.runs.get(runAId)?.failure, undefined);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(harness.runs.get(runAId)?.failure, "execution result missing after dispose");
    assert.equal(harness.runs.get(runAId)?.phase, "stopped");
    assert.deepEqual(disposed, ["a"]);
    assert.equal(harness.runs.get(runBId)?.phase, "starting");
    assert.equal(harness.runs.get(runCId)?.phase, "starting");
  } finally {
    vi.useRealTimers();
  }
});

test("a dispose rejection keeps the cancelled run stopping with an activation-dispose-failed warning", async () => {
  const harness = createHarness();
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
  let resolveResult!: (value: { stopReason: string }) => void;
  const result = new Promise<{ stopReason: string }>((resolve) => {
    resolveResult = resolve;
  });
  const { executionDone } = await harness.beginSubagentSpawn(harness.parent, { target: harness.child });
  harness.releaseActivation({
    childId: "child",
    localAgent: harness.child,
    result,
    dispose: async () => {
      throw new Error("释放失败");
    },
  });
  await executionDone;
  const runId = harness.runs.snapshot("main").runs[0]!.runId;

  assert.deepEqual(await harness.runs.requestCancel("main", runId), { status: "accepted", runId });
  resolveResult({ stopReason: "error" });
  await vi.waitFor(() => {
    assert.deepEqual(harness.runs.get(runId)?.cleanupWarnings, [
      { code: "activation-dispose-failed", severity: "error" },
    ]);
  });
  const run = harness.runs.get(runId)!;
  assert.equal(run.phase, "stopping");
  assert.equal(run.stopReason, "error");
  assert.equal(run.failure, undefined);
  assert.equal(run.endedAt, undefined);
});

test("a dispose timeout keeps the cancelled run stopping with an activation-dispose-timeout warning", async () => {
  vi.useFakeTimers();
  try {
    const harness = createHarness();
    assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
    const { executionDone } = await harness.beginSubagentSpawn(harness.parent, { target: harness.child });
    harness.releaseActivation({
      childId: "child",
      localAgent: harness.child,
      result: new Promise(() => undefined),
      dispose: () => new Promise<void>(() => undefined),
    });
    await executionDone;
    const runId = harness.runs.snapshot("main").runs[0]!.runId;

    assert.deepEqual(await harness.runs.requestCancel("main", runId), { status: "accepted", runId });
    await vi.advanceTimersByTimeAsync(ACTIVATION_CLEANUP_TIMEOUT_MS);
    assert.equal(harness.runs.get(runId)?.phase, "stopping");
    assert.deepEqual(harness.runs.get(runId)?.cleanupWarnings, []);
    await vi.advanceTimersByTimeAsync(ACTIVATION_CLEANUP_TIMEOUT_MS);
    const run = harness.runs.get(runId)!;
    assert.equal(run.phase, "stopping");
    assert.deepEqual(run.cleanupWarnings, [{ code: "activation-dispose-timeout", severity: "error" }]);
    assert.equal(run.failure, "execution result missing after dispose");
    assert.equal(run.endedAt, undefined);
  } finally {
    vi.useRealTimers();
  }
});

test("a cancelled run whose execution ended and dispose succeeded converges to stopped", async () => {
  const harness = createHarness();
  assert.equal((await harness.invokeSkill(harness.parent, "explore")).kind, "allow");
  let resolveResult!: (value: { stopReason: string }) => void;
  const result = new Promise<{ stopReason: string }>((resolve) => {
    resolveResult = resolve;
  });
  const { executionDone } = await harness.beginSubagentSpawn(harness.parent, { target: harness.child });
  harness.releaseActivation({
    childId: "child",
    localAgent: harness.child,
    result,
  });
  await executionDone;
  const runId = harness.runs.snapshot("main").runs[0]!.runId;

  assert.deepEqual(await harness.runs.requestCancel("main", runId), { status: "accepted", runId });
  resolveResult({ stopReason: "error" });
  await vi.waitFor(() => assert.equal(harness.runs.get(runId)?.phase, "stopped"));
  const run = harness.runs.get(runId)!;
  assert.equal(run.phase, "stopped");
  assert.equal(run.stopReason, "error");
  assert.deepEqual(run.cleanupWarnings, []);
  assert.notEqual(run.endedAt, undefined);
});

test("disposed system-skill children are not re-restricted on later tools/change", async () => {
  const harness = createHarness({ skipPresentAs: true });
  await harness.invokeSkill(harness.parent, "explore");
  const firstTools = createTools(DEFAULT_TOOL_NAMES);
  const restrict = firstTools.restrict;
  let disposed = false;
  let exploreRestrictCalls = 0;
  firstTools.restrict = (filter) => {
    if (filter.allow.join(",") === "read,read_file,glob,grep") {
      exploreRestrictCalls += 1;
      if (disposed) throw new Error("cannot create effect on inactive context");
    }
    return restrict(filter);
  };
  const first = harness.addAgent({
    id: "child-dispose",
    ctx: { get: (name) => (name === "tools" ? firstTools : undefined) },
  });

  await harness.invokeSubagent(harness.parent, first);
  assert.equal(exploreRestrictCalls, 1);

  disposed = true;
  harness.emit("agent/disposed", { agent: first });
  harness.emit("tools/change", {});
  assert.equal(exploreRestrictCalls, 1);

  const second = harness.addAgent({
    id: "child-after-dispose",
    ctx: { get: (name) => (name === "tools" ? createTools(DEFAULT_TOOL_NAMES) : undefined) },
  });
  const decision = await harness.invokeSubagent(harness.parent, second);
  assert.equal(decision.kind, "allow");
});

test("a lease store injected after apply still invalidates stale skill kinds on explicit re-acquire", async () => {
  const harness = createHarness({ deferLeaseStore: true });
  harness.ctx.huaanworkSystemSkillLeases = createSystemSkillLeaseStore(harness.ctx as never);
  await harness.invokeSkill(harness.parent, "explore");
  await harness.invokeSubagent(harness.parent, harness.child);

  (harness.ctx as { huaanworkRegisterSystemSkillLeaseInvalidation?: () => void })
    .huaanworkRegisterSystemSkillLeaseInvalidation?.();
  harness.ctx.huaanworkSystemSkillLeases.acquireExplicit("main", "test-fix");

  await harness.invokeSubagent(harness.parent, harness.child);
  const run = harness.runs.snapshot("main").runs.at(-1)!;
  assert.equal(run.label, "test-fix");
});

test("restricting a child that is already unloading does not poison the next activation", async () => {
  const harness = createHarness();
  await harness.invokeSkill(harness.parent, "explore");
  const childTools = createTools(DEFAULT_TOOL_NAMES);
  childTools.restrict = (filter) => {
    if (filter.allow.join(",") === "read,read_file,glob,grep") {
      throw new Error("cannot create effect on inactive context");
    }
    return createTools(DEFAULT_TOOL_NAMES).restrict(filter);
  };
  const child = harness.addAgent({
    id: "child-inactive",
    ctx: { get: (name) => (name === "tools" ? childTools : undefined) },
  });

  await harness.invokeSubagent(harness.parent, child);
  harness.emit("tools/change", {});
});
