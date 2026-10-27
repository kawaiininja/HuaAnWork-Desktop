import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";

import type { AgentPackageSubagentRequest } from "../../src/huaanwork-host/agent-package/types.ts";
import {
  childrenOf,
  forgetChildSession,
  noteCallerSession,
  resetChildSessionRegistry,
} from "../../src/huaanwork-host/child-sessions.ts";
import { createSubagentRunRegistry } from "../../src/huaanwork-host/subagent-runs.ts";
import {
  HUAANWORK_LEGACY_AGENT_REQUEST,
  HUAANWORK_SUBAGENT_RUN_ID,
} from "../../src/huaanwork-host/subagents-service.ts";
import { apply as applyLimits } from "../../src/huaanwork-guardrails/limits.ts";
import { emptyAttachments } from "../../src/huaanwork-guardrails/agent-attachments.ts";
import { apply as applyPresentAs } from "../../src/huaanwork-guardrails/present-as.ts";
import { SYSTEM_SKILLS, apply as applySkills, bundledSkillDir, exploreAllowList, getBundledSkill, listBundledSkills, parentVisibleExploreTranscript, parseSkillMarkdown, readSkillToggles, registerBundledSkill, scanBundledSkillEntries, serializeSkillMarkdown, setBundledSkillRegistrar, setSkillToggle, shellToolName, testFixAllowList } from "../../src/huaanwork-guardrails/skills.ts";

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
  const tools = {
    visible: [...all],
    guards: [] as Array<(execution: { name: string; arguments: unknown }) => string | undefined>,
    schemas() {
      return tools.visible;
    },
    restrict({ allow }: { allow: readonly string[] }) {
      tools.visible = all.filter((schema) => allow.includes(schema.name));
      return () => undefined;
    },
    guard(listener: (execution: { name: string; arguments: unknown }) => string | undefined) {
      tools.guards.push(listener);
      return () => undefined;
    },
  };
  return tools;
}

function createHarness(options?: { childNames?: readonly string[]; parentNames?: readonly string[] }) {
  const skills: SkillRegistration[] = [];
  const events: Record<string, ((payload: never, next?: () => Promise<unknown>, extra?: unknown) => unknown)[]> = {};
  const parentTools = createTools(
    options?.parentNames ?? [
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
    ],
  );
  const childTools = createTools(
    options?.childNames ?? [
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
    ],
  );
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
  const ctx = {
    huaanworkEmit(event: unknown) {
      emitted.push(event);
    },
    skills: {
      register(skill: SkillRegistration) {
        skills.push(skill);
        return () => undefined;
      },
    },
    agents: {
      list: () => [parent],
      get: (id: string) => (id === child.id ? child : parent),
    },
    tools: {
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

  function emit(event: string, payload: unknown, extra?: unknown) {
    for (const listener of events[event] ?? []) listener(payload as never, undefined, extra as never);
  }

  return {
    skills,
    parent,
    child,
    parentTools,
    childTools,
    cancelled,
    emitted,
    emit,
    async invokeSkill(agent: Agent, name: string) {
      return emitWaterfall("tools/pre-execute", { name: "skill", arguments: { name }, agent });
    },
    async invokeSubagent(agent: Agent) {
      const decision = await emitWaterfall("tools/pre-execute", {
        name: "subagent",
        arguments: { prompt: "look around" },
        agent,
      });
      emit("agent/created", { agent: child });
      emit("subagent/start", { id: child.id, local: true });
      return decision;
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

test("scanBundledSkillEntries covers flat and directory forms, exactly 25 names", () => {
  const entries = scanBundledSkillEntries();
  const byName = new Map(
    entries.map((entry) => [parseSkillMarkdown(readFileSync(entry.path, "utf8")).name, entry.kind]),
  );
  assert.deepEqual(
    [...byName.keys()].sort(),
    [
      "brainstorming", "code-review", "create-agent", "darwin-skill", "deep-research",
      "dispatching-parallel-agents", "explore", "find-skills", "frontend-design",
      "frontend-dev", "graph", "grill-me", "humanizer", "investigate",
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
});

test("listBundledSkills covers directory-form skills", () => {
  const names = listBundledSkills().map((skill) => skill.name);
  assert.equal(names.length, 25);
  assert.ok(names.includes("pdf") && names.includes("graph"));
  assert.ok(names.includes("create-agent"));
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

test("a cold-resumed child stays on its own parent, never the last sibling send", () => {
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
  noteCallerSession("huaanwork-cold-b");
  try {
    for (const listener of startListeners) listener({ id: "cold-child-with-header", local: true });
    for (const listener of startListeners) listener({ id: "cold-child-no-header", local: true });
    assert.deepEqual(childrenOf("huaanwork-cold-a"), ["cold-child-with-header"]);
    assert.deepEqual(childrenOf("huaanwork-cold-b"), []);
  } finally {
    noteCallerSession(undefined);
  }
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
