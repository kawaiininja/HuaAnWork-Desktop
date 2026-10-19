import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { childrenOf, noteCallerSession } from "../../src/huaanwork-host/child-sessions.ts";
import { apply as applyLimits } from "../../src/huaanwork-guardrails/limits.ts";
import { emptyAttachments } from "../../src/huaanwork-guardrails/agent-attachments.ts";
import { apply as applyPresentAs } from "../../src/huaanwork-guardrails/present-as.ts";
import { SYSTEM_SKILLS, apply as applySkills, bundledSkillDir, exploreAllowList, getBundledSkill, listBundledSkills, parentVisibleExploreTranscript, parseSkillMarkdown, readSkillToggles, registerBundledSkill, scanBundledSkillEntries, serializeSkillMarkdown, setSkillToggle, shellToolName, testFixAllowList } from "../../src/huaanwork-guardrails/skills.ts";

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

test("scanBundledSkillEntries covers flat and directory forms, exactly 24 names", () => {
  const entries = scanBundledSkillEntries();
  const byName = new Map(
    entries.map((entry) => [parseSkillMarkdown(readFileSync(entry.path, "utf8")).name, entry.kind]),
  );
  assert.deepEqual(
    [...byName.keys()].sort(),
    [
      "brainstorming", "code-review", "darwin-skill", "deep-research",
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
});

test("listBundledSkills covers directory-form skills", () => {
  const names = listBundledSkills().map((skill) => skill.name);
  assert.equal(names.length, 24);
  assert.ok(names.includes("pdf") && names.includes("graph"));
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
