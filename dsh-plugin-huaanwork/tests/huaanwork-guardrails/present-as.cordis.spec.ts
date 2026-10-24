import assert from "node:assert/strict";
import { test } from "vitest";

import { DEFAULT_AGENT_ALLOW } from "@huaanwork/policy/agent-catalog";
import { attachAgentTools, detachAgentTools, emptyAttachments } from "../../src/huaanwork-guardrails/agent-attachments.ts";
import { apply, refreshAgentRestrict } from "../../src/huaanwork-guardrails/present-as.ts";

type MockAgent = {
  id?: string;
  session?: { id?: string };
  ctx: {
    get(name: string): MockToolsService | undefined;
  };
  cancel?: (reason: unknown) => void;
  restrictCalls: Array<{ allow: readonly string[] }>;
};

type MockToolsService = {
  restrict(filter: { allow: readonly string[] }): () => void;
  schemas(): readonly { name?: string }[];
  getActiveAllow(): string[];
};

function createMockAgent(options: {
  id?: string;
  sessionId?: string;
  initialToolNames: string[];
}): MockAgent {
  const restrictions: Array<{ allow: readonly string[] }> = [];
  const restrictCalls: Array<{ allow: readonly string[] }> = [];

  const tools: MockToolsService = {
    schemas() {
      let names = [...options.initialToolNames];
      for (const r of restrictions) {
        names = names.filter((n) => r.allow.includes(n));
      }
      return names.map((name) => ({ name }));
    },
    restrict(filter: { allow: readonly string[] }) {
      restrictions.push(filter);
      restrictCalls.push(filter);
      return () => {
        const idx = restrictions.indexOf(filter);
        if (idx !== -1) restrictions.splice(idx, 1);
      };
    },
    getActiveAllow() {
      return this.schemas().map((s) => s.name!).filter(Boolean);
    },
  };

  const agent: MockAgent = {
    ...(options.id !== undefined ? { id: options.id } : {}),
    ...(options.sessionId !== undefined ? { session: { id: options.sessionId } } : {}),
    ctx: {
      get: (name: string) => (name === "tools" ? tools : undefined),
    },
    restrictCalls,
  };

  return agent;
}

function createMockContext(options: {
  agents?: MockAgent[];
  attachments?: ReturnType<typeof emptyAttachments>;
}) {
  const listeners: Record<string, Function[]> = {};
  const ctx = {
    huaanworkAttachments: options.attachments,
    agents: {
      list: () => options.agents ?? [],
    },
    tools: {
      presentAs: () => () => undefined,
      schemas: () => [],
    },
    on(event: string, listener: Function) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(listener);
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of listeners[event] ?? []) {
        fn(...args);
      }
    },
  };
  return ctx;
}

test("1. default huaanwork and dynamic huaanwork-deadbeef are restricted at startup and tools/change, allow contains call_host_tool but not send_message or list_agents", () => {
  const initialTools = ["read", "bash", "call_host_tool", "send_message", "list_agents"];
  const defaultAgent = createMockAgent({ id: "huaanwork", initialToolNames: initialTools });
  const dynamicAgent = createMockAgent({ sessionId: "huaanwork-deadbeef", initialToolNames: initialTools });

  const ctx = createMockContext({
    agents: [defaultAgent, dynamicAgent],
  });

  apply(ctx as never);

  assert.equal(defaultAgent.restrictCalls.length, 1, "default agent should be restricted on startup");
  assert.equal(dynamicAgent.restrictCalls.length, 1, "dynamic agent should be restricted on startup");

  const defaultAllow = defaultAgent.restrictCalls[0].allow;
  assert.ok(defaultAllow.includes("call_host_tool"), "default agent allow must include call_host_tool");
  assert.ok(defaultAllow.includes("read"), "default agent allow must include read");
  assert.ok(defaultAllow.includes("bash"), "default agent allow must include bash");
  assert.ok(!defaultAllow.includes("send_message"), "default agent allow must not include send_message");
  assert.ok(!defaultAllow.includes("list_agents"), "default agent allow must not include list_agents");

  const dynamicAllow = dynamicAgent.restrictCalls[0].allow;
  assert.ok(dynamicAllow.includes("call_host_tool"), "dynamic agent allow must include call_host_tool");
  assert.ok(dynamicAllow.includes("read"), "dynamic agent allow must include read");
  assert.ok(dynamicAllow.includes("bash"), "dynamic agent allow must include bash");
  assert.ok(!dynamicAllow.includes("send_message"), "dynamic agent allow must not include send_message");
  assert.ok(!dynamicAllow.includes("list_agents"), "dynamic agent allow must not include list_agents");

  // On tools/change: both are re-restricted
  ctx.emit("tools/change");
  assert.equal(defaultAgent.restrictCalls.length, 2, "default agent should be re-restricted on tools/change");
  assert.equal(dynamicAgent.restrictCalls.length, 2, "dynamic agent should be re-restricted on tools/change");

  const defaultAllowAfterChange = defaultAgent.restrictCalls[1].allow;
  assert.ok(defaultAllowAfterChange.includes("call_host_tool"));
  assert.ok(!defaultAllowAfterChange.includes("send_message"));

  const dynamicAllowAfterChange = dynamicAgent.restrictCalls[1].allow;
  assert.ok(dynamicAllowAfterChange.includes("call_host_tool"));
  assert.ok(!dynamicAllowAfterChange.includes("send_message"));
});

test("2. session work-a with mcp__issue-tracker__search in attachments has it in allow, while session work-b does not", () => {
  const initialTools = ["read", "call_host_tool", "mcp__issue-tracker__search"];
  const agentA = createMockAgent({ sessionId: "work-a", initialToolNames: initialTools });
  const agentB = createMockAgent({ sessionId: "work-b", initialToolNames: initialTools });

  const attachments = emptyAttachments();
  attachAgentTools(attachments, "work-a", ["mcp__issue-tracker__search", "mcp__ghost__tool"]);

  const ctx = createMockContext({
    agents: [agentA, agentB],
    attachments,
  });

  apply(ctx as never);

  const allowA = agentA.restrictCalls[0].allow;
  assert.ok(allowA.includes("read"));
  assert.ok(allowA.includes("call_host_tool"));
  assert.ok(allowA.includes("mcp__issue-tracker__search"), "work-a must include attached tool");
  assert.ok(!allowA.includes("mcp__ghost__tool"), "unknown schemas must never be passed to restrict");

  const allowB = agentB.restrictCalls[0].allow;
  assert.ok(allowB.includes("read"));
  assert.ok(allowB.includes("call_host_tool"));
  assert.ok(!allowB.includes("mcp__issue-tracker__search"), "work-b must not include tool attached to work-a");
});

test("3. detaching attachment and firing tools/change returns allow back to baseline", () => {
  const initialTools = ["read", "call_host_tool", "mcp__issue-tracker__search"];
  const agentA = createMockAgent({ sessionId: "work-a", initialToolNames: initialTools });

  const attachments = emptyAttachments();
  attachAgentTools(attachments, "work-a", ["mcp__issue-tracker__search"]);

  const ctx = createMockContext({
    agents: [agentA],
    attachments,
  });

  apply(ctx as never);

  assert.ok(agentA.restrictCalls[0].allow.includes("mcp__issue-tracker__search"));

  // Detach attachment and fire tools/change
  detachAgentTools(attachments, "work-a", ["mcp__issue-tracker__search"]);
  ctx.emit("tools/change");

  assert.equal(agentA.restrictCalls.length, 2);
  const allowAfterDetach = agentA.restrictCalls[1].allow;
  assert.ok(allowAfterDetach.includes("read"));
  assert.ok(allowAfterDetach.includes("call_host_tool"));
  assert.ok(!allowAfterDetach.includes("mcp__issue-tracker__search"), "allow must return to baseline after detach");
});

test("4. every agent gets ALLOWED_TOOLS, including legacy huaanwork-chat session agents", async () => {
  const initialTools = ["read", "bash", "call_host_tool", "run_code", "send_message", "git_status"];
  const chatAgent = createMockAgent({
    sessionId: "huaanwork-chat-deadbeef",
    initialToolNames: initialTools,
  });

  const ctx = createMockContext({
    agents: [chatAgent],
  });

  apply(ctx as never);

  assert.equal(chatAgent.restrictCalls.length, 1, "chat agent should be restricted on startup");
  const allow = chatAgent.restrictCalls[0].allow;
  assert.ok(allow.includes("read"), "allow must include read");
  assert.ok(allow.includes("bash"), "allow must include bash");
  assert.ok(allow.includes("call_host_tool"), "allow must include call_host_tool");
  assert.ok(allow.includes("git_status"), "allow must include git_status");
  assert.ok(!allow.includes("run_code"), "allow must never include run_code");
  assert.ok(!allow.includes("send_message"), "allow must not include send_message");

  // Also test dynamic creation via agent/created
  const dynamicChatAgent = createMockAgent({
    sessionId: "huaanwork-chat-dynamic",
    initialToolNames: initialTools,
  });
  ctx.emit("agent/created", { agent: dynamicChatAgent });

  assert.equal(dynamicChatAgent.restrictCalls.length, 1, "dynamic chat agent should be restricted on agent/created");
  const dynamicAllow = dynamicChatAgent.restrictCalls[0].allow;
  assert.ok(dynamicAllow.includes("read"));
  assert.ok(dynamicAllow.includes("bash"));
  assert.ok(dynamicAllow.includes("call_host_tool"));
  assert.ok(!dynamicAllow.includes("run_code"));
  assert.ok(!dynamicAllow.includes("send_message"));
});

test("5. explore subagent mask intersection: already restricted with DEFAULT_AGENT_ALLOW does not leak bash/write/edit after restrictAll / refreshAgentRestrict", () => {
  const allTools = ["read", "read_file", "glob", "grep", "edit", "write", "bash", "call_host_tool"];
  const exploreSubagent = createMockAgent({ sessionId: "work-a", initialToolNames: allTools });

  // Simulate skills.ts narrowing explore subagent to DEFAULT_AGENT_ALLOW
  exploreSubagent.ctx.get("tools")!.restrict({ allow: [...DEFAULT_AGENT_ALLOW] });
  assert.deepEqual(
    exploreSubagent.ctx.get("tools")!.getActiveAllow().sort(),
    [...DEFAULT_AGENT_ALLOW].sort(),
  );

  const ctx = createMockContext({
    agents: [exploreSubagent],
  });

  apply(ctx as never);

  // Present-as runs restrictAll(). It must only allow from schemas() currently visible on the agent.
  const activeAfterApply = exploreSubagent.ctx.get("tools")!.getActiveAllow();
  assert.ok(!activeAfterApply.includes("bash"), "active allow must not include bash");
  assert.ok(!activeAfterApply.includes("write"), "active allow must not include write");
  assert.ok(!activeAfterApply.includes("edit"), "active allow must not include edit");
  assert.ok(activeAfterApply.includes("read"), "active allow retains read");

  // Call refreshAgentRestrict with sessionId
  refreshAgentRestrict(ctx as never, "work-a");
  const activeAfterSessionRefresh = exploreSubagent.ctx.get("tools")!.getActiveAllow();
  assert.ok(!activeAfterSessionRefresh.includes("bash"));
  assert.ok(!activeAfterSessionRefresh.includes("write"));
  assert.ok(!activeAfterSessionRefresh.includes("edit"));

  // Call refreshAgentRestrict without sessionId (restrictAll)
  refreshAgentRestrict(ctx as never);
  const activeAfterGlobalRefresh = exploreSubagent.ctx.get("tools")!.getActiveAllow();
  assert.ok(!activeAfterGlobalRefresh.includes("bash"));
  assert.ok(!activeAfterGlobalRefresh.includes("write"));
  assert.ok(!activeAfterGlobalRefresh.includes("edit"));
});

test("refreshAgentRestrict with sessionId only targets matching agents", () => {
  const initialTools = ["read", "call_host_tool", "mcp__issue-tracker__search"];
  const agentA = createMockAgent({ sessionId: "work-a", initialToolNames: initialTools });
  const agentB = createMockAgent({ sessionId: "work-b", initialToolNames: initialTools });

  const attachments = emptyAttachments();
  const ctx = createMockContext({
    agents: [agentA, agentB],
    attachments,
  });

  apply(ctx as never);
  assert.equal(agentA.restrictCalls.length, 1);
  assert.equal(agentB.restrictCalls.length, 1);

  // Attach to work-a and refresh only work-a using refreshAgentRestrict
  attachAgentTools(attachments, "work-a", ["mcp__issue-tracker__search"]);
  refreshAgentRestrict(ctx as never, "work-a");

  assert.equal(agentA.restrictCalls.length, 2, "work-a was refreshed");
  assert.equal(agentB.restrictCalls.length, 1, "work-b was NOT touched");
  assert.ok(agentA.restrictCalls[1].allow.includes("mcp__issue-tracker__search"));

  // Refreshing with non-matching session does nothing
  refreshAgentRestrict(ctx as never, "work-nonexistent");
  assert.equal(agentA.restrictCalls.length, 2);
  assert.equal(agentB.restrictCalls.length, 1);
});

test("two work agents in the same session keep independent restrict filters (no mutual clobber)", () => {
  const mainAgent = createMockAgent({ id: "agent-main", sessionId: "work-1", initialToolNames: ["read", "bash"] });
  const subAgent = createMockAgent({ id: "agent-sub", sessionId: "work-1", initialToolNames: ["read", "bash"] });
  const ctx = createMockContext({ agents: [mainAgent, subAgent], attachments: emptyAttachments() });

  apply(ctx as never);

  // 各自都被 restrict 过一次
  assert.equal(mainAgent.restrictCalls.length, 1);
  assert.equal(subAgent.restrictCalls.length, 1);

  // 同 session 的第二个 agent 再 restrict 不得顶掉第一个的 filter
  refreshAgentRestrict(ctx as never, "work-1");
  assert.ok(mainAgent.restrictCalls.length >= 2);
  const toolsOf = (a: MockAgent) => a.ctx.get("tools")!;
  assert.deepEqual(toolsOf(mainAgent).getActiveAllow(), ["read", "bash"]);
  assert.deepEqual(toolsOf(subAgent).getActiveAllow(), ["read", "bash"]);
});

test('presentAs("ptc") is rejected without emitting an unscoped session/end', () => {
  const emitted: Array<{ event: string; ok?: boolean; error?: string }> = [];
  const ctx = {
    huaanworkEmit: (e: { event: string; ok: boolean; error: string }) => { emitted.push(e); },
    tools: {
      presentAs: (_mode: string) => () => undefined,
      schemas: () => [],
    },
    agents: { list: () => [] },
    on: () => {},
  };

  apply(ctx as never);

  assert.throws(
    () => (ctx.tools.presentAs as (mode: string) => () => void)("ptc"),
    /disabled by HuaAnWork/,
  );
  assert.deepEqual(emitted, [], "a global presentation rejection must not fail the live tab");
});

test("a disposed agent's inactive-scope restrict is skipped without aborting the sweep", () => {
  const disposed = createMockAgent({ sessionId: "work-disposed", initialToolNames: ["read"] });
  disposed.ctx.get("tools")!.restrict = () => {
    throw new Error("cannot create effect on inactive context");
  };
  const live = createMockAgent({ sessionId: "work-live", initialToolNames: ["read"] });
  const ctx = createMockContext({ agents: [disposed, live], attachments: emptyAttachments() });

  assert.doesNotThrow(() => apply(ctx as never));
  assert.equal(live.restrictCalls.length, 1, "the live agent is still restricted after the disposed one throws");

  assert.doesNotThrow(() => ctx.emit("tools/change"));
  assert.equal(live.restrictCalls.length, 2);

  assert.doesNotThrow(() => refreshAgentRestrict(ctx as never));
  assert.equal(live.restrictCalls.length, 3);
});

test("refreshAgentRestrict skips contexts without an attachment table and stays loud with one", () => {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    refreshAgentRestrict(createMockContext({ agents: [] }) as never);
    assert.deepEqual(errors, [], "no attachment table means nothing to refresh");

    refreshAgentRestrict(createMockContext({ agents: [], attachments: emptyAttachments() }) as never);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]?.[0] ?? ""), /restrict state not found/);
  } finally {
    console.error = original;
  }
});

test("ALLOWED_TOOLS includes propose_plan and request_input", () => {
  const agent = createMockAgent({
    sessionId: "work-route",
    initialToolNames: ["read", "propose_plan", "request_input"],
  });
  const ctx = createMockContext({ agents: [agent] });
  apply(ctx as never);
  const allow = agent.restrictCalls[0].allow;
  assert.ok(allow.includes("propose_plan"));
  assert.ok(allow.includes("request_input"));
});

test("ALLOWED_TOOLS keeps the official exit_plan_mode and leaves ask_user_question out", () => {
  const agent = createMockAgent({
    sessionId: "work-plan",
    initialToolNames: ["read", "exit_plan_mode", "ask_user_question"],
  });
  const ctx = createMockContext({ agents: [agent] });
  apply(ctx as never);
  ctx.emit("tools/change");
  const allow = agent.restrictCalls.at(-1)!.allow;
  assert.ok(allow.includes("exit_plan_mode"));
  assert.ok(!allow.includes("ask_user_question"));
});

test("goal tools survive the allow list so tool-goal reaches the model", () => {
  const goalTools = ["get_goal", "create_goal", "update_goal"];
  const agent = createMockAgent({ id: "huaanwork", initialToolNames: ["read", "todo_write", ...goalTools, "send_message"] });
  const ctx = createMockContext({ agents: [agent] });

  apply(ctx as never);

  const allow = agent.restrictCalls[0].allow;
  for (const name of goalTools) assert.ok(allow.includes(name), `allow must include ${name}`);
  assert.ok(allow.includes("todo_write"));
  assert.ok(!allow.includes("send_message"));
});
