import assert from "node:assert/strict";
import { test, vi } from "vitest";

import { emptyAttachments, isMcpAttached } from "../../src/huaanwork-guardrails/agent-attachments.ts";
import { mountSessionMcp } from "../../src/huaanwork-guardrails/agent-mcp.ts";
import { apply as applyPresentAs, refreshAgentRestrict } from "../../src/huaanwork-guardrails/present-as.ts";

// The packaged client connects to a real server; the fallback tests replace it
// so they can observe which client `mountSessionMcp` resolved.
const defaultClient = vi.hoisted(() => ({
  inject: ["tools"],
  configs: [] as Array<{ serverName: string; url: string }>,
  apply: async (fiber: any, config: { serverName: string; url: string }) => {
    defaultClient.configs.push(config);
    const unregister = fiber.tools.register({ name: `mcp__${config.serverName}__ping` });
    return {
      dispose: async () => {
        unregister();
      },
    };
  },
}));

vi.mock("@deepseek-ai/dsh-mcp-client", () => defaultClient);

function createFakeClient(toolName: string) {
  const calls: string[] = [];
  return {
    calls,
    inject: ["tools"],
    apply: async (fiber: any) => {
      calls.push(toolName);
      const unregister = fiber.tools.register({ name: toolName });
      return {
        dispose: async () => {
          unregister();
        },
      };
    },
  };
}

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
  initialTools?: Array<{ name: string }>;
}) {
  const registeredTools: Array<{ name: string }> = [...(options.initialTools ?? [])];
  const listeners: Record<string, Function[]> = {};

  const ctx = {
    huaanworkAttachments: options.attachments,
    agents: {
      list: () => options.agents ?? [],
    },
    tools: {
      presentAs: () => () => undefined,
      schemas: () => registeredTools,
      register: (tool: { name: string }) => {
        registeredTools.push(tool);
        ctx.emit("tools/change");
        return () => {
          const idx = registeredTools.findIndex((t) => t.name === tool.name);
          if (idx !== -1) registeredTools.splice(idx, 1);
          ctx.emit("tools/change");
        };
      },
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
    plugin: async (pluginDef: { inject?: string[]; apply: (fiber: any) => any }) => {
      let disposed = false;
      const fiber = {
        tools: ctx.tools,
      };
      const ret = await pluginDef.apply(fiber);
      return {
        dispose: async () => {
          if (disposed) return;
          disposed = true;
          await ret?.dispose?.();
        },
      };
    },
  };
  return ctx;
}

test("1. per-session isolation and lifecycle: session A gets attached mcp tool, session B does not; dispose cleans up", async () => {
  const attachments = emptyAttachments();
  const ctx = createMockContext({ attachments });

  const fakeToolName = "mcp__github__search_repos";
  let unregister: (() => void) | undefined;

  const mockClient = {
    inject: ["tools"],
    apply: async (fiber: any) => {
      unregister = fiber.tools.register({ name: fakeToolName });
      return {
        dispose: async () => {
          unregister?.();
        },
      };
    },
  };

  const res = await mountSessionMcp({
    ctx: ctx as any,
    sessionId: "session-a",
    serverName: "github",
    url: "http://127.0.0.1:8000/sse",
    mcpClientImpl: mockClient,
  });

  assert.deepEqual(res.names, [fakeToolName]);
  assert.equal(isMcpAttached(attachments, "session-a", fakeToolName), true);
  assert.equal(isMcpAttached(attachments, "session-b", fakeToolName), false);

  // Dispose
  await res.dispose();
  assert.equal(isMcpAttached(attachments, "session-a", fakeToolName), false);
  assert.equal(isMcpAttached(attachments, "session-b", fakeToolName), false);
  // Unregistered from tools
  assert.equal(ctx.tools.schemas().some((s) => s.name === fakeToolName), false);
});

test("2. startup error or 0 tools throws and does NOT write to attachments maps", async () => {
  const attachments = emptyAttachments();
  const ctx = createMockContext({ attachments });

  // Case A: Startup error in apply
  const failingClient = {
    inject: ["tools"],
    apply: async () => {
      throw new Error("connection failed");
    },
  };

  await assert.rejects(
    mountSessionMcp({
      ctx: ctx as any,
      sessionId: "session-a",
      serverName: "failing-server",
      url: "http://127.0.0.1:8000/sse",
      mcpClientImpl: failingClient,
    }),
    /connection failed/,
  );
  assert.equal(attachments.sessionAgentTools.size, 0);

  // Case B: 0 tools registered by server
  let disposedCalled = false;
  const zeroToolsClient = {
    inject: ["tools"],
    apply: async () => {
      return {
        dispose: async () => {
          disposedCalled = true;
        },
      };
    },
  };

  await assert.rejects(
    mountSessionMcp({
      ctx: ctx as any,
      sessionId: "session-a",
      serverName: "empty-server",
      url: "http://127.0.0.1:8000/sse",
      mcpClientImpl: zeroToolsClient,
    }),
    /MCP 服务「empty-server」未提供任何工具/,
  );
  assert.equal(attachments.sessionAgentTools.size, 0);
  assert.equal(disposedCalled, true, "scope.dispose() must be called when 0 tools found");
});

test("3. timing assertion with refreshAgentRestrict: agent allow list includes mcp tool only with refresh, and drops it after dispose", async () => {
  const attachments = emptyAttachments();
  const fakeToolName = "mcp__demo__echo";

  const agentA = createMockAgent({ sessionId: "work-session", initialToolNames: ["read", "bash"] });
  const ctx = createMockContext({
    agents: [agentA],
    attachments,
    initialTools: [{ name: "read" }, { name: "bash" }],
  });

  // Apply present-as plugin
  applyPresentAs(ctx as never);

  // Initially, agentA has only read and bash
  assert.deepEqual(agentA.ctx.get("tools")!.getActiveAllow().sort(), ["bash", "read"]);

  let unregisterTool: (() => void) | undefined;
  const mockClient = {
    inject: ["tools"],
    apply: async (fiber: any) => {
      // Register tool, which fires tools/change
      // At this moment, present-as restrictAll() runs, but attachments map is still empty!
      // Also update agent's own tool schemas so it can discover the registered tool
      (agentA.ctx.get("tools") as any).schemas = () => {
        const base = [{ name: "read" }, { name: "bash" }];
        if (unregisterTool) base.push({ name: fakeToolName });
        return base;
      };
      unregisterTool = fiber.tools.register({ name: fakeToolName });
      return {
        dispose: async () => {
          unregisterTool?.();
          unregisterTool = undefined;
        },
      };
    },
  };

  // Contrast verification:
  // If we simulate what happens without refreshAgentRestrict:
  // After mockClient.apply runs, tools/change fired, but agentA's last restrict call still lacked fakeToolName
  // Let's verify that mountSessionMcp properly refreshes the agent:
  const res = await mountSessionMcp({
    ctx: ctx as any,
    sessionId: "work-session",
    serverName: "demo",
    url: "http://127.0.0.1:8000/sse",
    mcpClientImpl: mockClient,
  });

  assert.deepEqual(res.names, [fakeToolName]);

  // After mountSessionMcp completes, agentA's latest restrict call MUST include the mcp tool!
  const lastRestrictCall = agentA.restrictCalls[agentA.restrictCalls.length - 1];
  assert.ok(
    lastRestrictCall.allow.includes(fakeToolName),
    `Agent restrict allow must include ${fakeToolName}, got: ${JSON.stringify(lastRestrictCall.allow)}`,
  );

  // Contrast: if we only attached to map without calling refreshAgentRestrict,
  // the previous restrict call (triggered by tools/change during apply) did NOT have fakeToolName
  const prevRestrictCall = agentA.restrictCalls[agentA.restrictCalls.length - 2];
  assert.ok(
    !prevRestrictCall.allow.includes(fakeToolName),
    `Previous restrict call during tools/change must NOT have included ${fakeToolName}`,
  );

  // Now dispose:
  await res.dispose();

  // After dispose, agentA's latest restrict call MUST NOT include fakeToolName
  const afterDisposeCall = agentA.restrictCalls[agentA.restrictCalls.length - 1];
  assert.ok(
    !afterDisposeCall.allow.includes(fakeToolName),
    `Agent restrict allow after dispose must NOT include ${fakeToolName}`,
  );
});

test("4. a context without mcpClientImpl and without get mounts the packaged default client", async () => {
  const attachments = emptyAttachments();
  const ctx = createMockContext({ attachments });
  assert.equal("get" in ctx, false, "test context must not expose get");

  defaultClient.configs.length = 0;
  const res = await mountSessionMcp({
    ctx: ctx as any,
    sessionId: "session-default",
    serverName: "echo",
    url: "http://127.0.0.1:8765/mcp",
  });

  assert.deepEqual(res.names, ["mcp__echo__ping"]);
  assert.equal(defaultClient.configs.length, 1);
  assert.equal(defaultClient.configs[0]!.url, "http://127.0.0.1:8765/mcp");
  assert.equal(isMcpAttached(attachments, "session-default", "mcp__echo__ping"), true);

  await res.dispose();
  assert.equal(isMcpAttached(attachments, "session-default", "mcp__echo__ping"), false);
});

test("5. a Cordis context that throws on the mcpClientImpl property falls back instead of crashing", async () => {
  // A real Cordis Context throws on undeclared property reads; the guardrail
  // must never read `ctx.mcpClientImpl` as a property.
  const throwingContext = () => {
    const ctx = createMockContext({ attachments: emptyAttachments() });
    Object.defineProperty(ctx, "mcpClientImpl", {
      get() {
        throw new Error('cannot get property "mcpClientImpl" without inject');
      },
    });
    return ctx;
  };

  defaultClient.configs.length = 0;

  // `get` returns no service: the packaged client is the fallback.
  const emptyGetCtx = Object.assign(throwingContext(), { get: (_name: string) => undefined });
  const fromEmptyGet = await mountSessionMcp({
    ctx: emptyGetCtx as any,
    sessionId: "session-empty-get",
    serverName: "echo",
    url: "http://127.0.0.1:8765/mcp",
  });
  assert.deepEqual(fromEmptyGet.names, ["mcp__echo__ping"]);
  assert.equal(defaultClient.configs.length, 1);
  await fromEmptyGet.dispose();

  // `get` throws for an unregistered optional service: still the fallback.
  const throwingGetCtx = Object.assign(throwingContext(), {
    get: (name: string) => {
      throw new Error(`service "${name}" is not provided`);
    },
  });
  const fromThrowingGet = await mountSessionMcp({
    ctx: throwingGetCtx as any,
    sessionId: "session-throwing-get",
    serverName: "echo",
    url: "http://127.0.0.1:8765/mcp",
  });
  assert.deepEqual(fromThrowingGet.names, ["mcp__echo__ping"]);
  assert.equal(defaultClient.configs.length, 2);
  await fromThrowingGet.dispose();
});

test("6. an mcpClientImpl service read through ctx.get is used", async () => {
  const attachments = emptyAttachments();
  const ctx = createMockContext({ attachments });
  const serviceClient = createFakeClient("mcp__from-service__ping");
  const withGet = Object.assign(ctx, {
    get: (name: string) => (name === "mcpClientImpl" ? serviceClient : undefined),
  });

  defaultClient.configs.length = 0;
  const res = await mountSessionMcp({
    ctx: withGet as any,
    sessionId: "session-service",
    serverName: "from-service",
    url: "http://127.0.0.1:8765/mcp",
  });

  assert.deepEqual(serviceClient.calls, ["mcp__from-service__ping"]);
  assert.deepEqual(res.names, ["mcp__from-service__ping"]);
  assert.equal(defaultClient.configs.length, 0, "the packaged client must not run when the service resolves");

  await res.dispose();
});

test("7. an explicit mcpClientImpl option wins over the service and is never read as a property", async () => {
  const attachments = emptyAttachments();
  const ctx = createMockContext({ attachments });
  Object.defineProperty(ctx, "mcpClientImpl", {
    get() {
      throw new Error('cannot get property "mcpClientImpl" without inject');
    },
  });
  const optionClient = createFakeClient("mcp__from-option__ping");
  const serviceClient = createFakeClient("mcp__from-service__ping");
  const withGet = Object.assign(ctx, {
    get: (name: string) => (name === "mcpClientImpl" ? serviceClient : undefined),
  });

  defaultClient.configs.length = 0;
  const res = await mountSessionMcp({
    ctx: withGet as any,
    sessionId: "session-option",
    serverName: "from-option",
    url: "http://127.0.0.1:8765/mcp",
    mcpClientImpl: optionClient,
  });

  assert.deepEqual(optionClient.calls, ["mcp__from-option__ping"]);
  assert.deepEqual(serviceClient.calls, [], "the service must not run when the option is given");
  assert.equal(defaultClient.configs.length, 0);
  assert.deepEqual(res.names, ["mcp__from-option__ping"]);

  await res.dispose();
});

test("8. a plain-object context still reads the tools service from the tools property", async () => {
  const ctx = {
    tools: {
      schemas: () => [
        { name: "mcp__plain__ping" },
        { name: "mcp__other__ping" },
        { name: "read" },
      ],
    },
  };
  assert.equal("get" in ctx, false, "the direct property path must work without get");

  const scopes: string[] = [];
  const client = {
    inject: ["tools"],
    apply: async () => ({
      dispose: async () => {
        scopes.push("scope");
      },
    }),
  };

  const res = await mountSessionMcp({
    ctx: ctx as any,
    sessionId: "session-plain",
    serverName: "plain",
    url: "http://127.0.0.1:8765/mcp",
    mcpClientImpl: client,
  });

  assert.deepEqual(res.names, ["mcp__plain__ping"], "only the server-prefixed tool is attached");

  await res.dispose();
  assert.deepEqual(scopes, ["scope"]);
});

test("9. a Cordis-like context whose tools property throws resolves the service through ctx.get", async () => {
  const toolsService = {
    schemas: () => [{ name: "mcp__guarded__ping" }, { name: "mcp__guarded__extra" }],
  };
  const ctx: { get(name: string): unknown } = {
    get(name: string) {
      return name === "tools" ? toolsService : undefined;
    },
  };
  Object.defineProperty(ctx, "tools", {
    get() {
      throw new Error('cannot get property "tools" without inject');
    },
  });

  const scopes: string[] = [];
  const client = {
    inject: ["tools"],
    apply: async () => ({
      dispose: async () => {
        scopes.push("scope");
      },
    }),
  };

  const res = await mountSessionMcp({
    ctx: ctx as any,
    sessionId: "session-guarded",
    serverName: "guarded",
    url: "http://127.0.0.1:8765/mcp",
    mcpClientImpl: client,
  });

  assert.deepEqual(res.names, ["mcp__guarded__ping", "mcp__guarded__extra"]);

  await res.dispose();
  assert.deepEqual(scopes, ["scope"]);
});

test("10. a context with neither tools nor get uses no schemas and still rejects empty tools", async () => {
  const ctx = {};
  assert.equal("tools" in ctx, false);
  assert.equal("get" in ctx, false);

  let disposed = false;
  const client = {
    inject: ["tools"],
    apply: async () => ({
      dispose: async () => {
        disposed = true;
      },
    }),
  };

  await assert.rejects(
    mountSessionMcp({
      ctx: ctx as any,
      sessionId: "session-no-tools",
      serverName: "no-tools",
      url: "http://127.0.0.1:8765/mcp",
      mcpClientImpl: client,
    }),
    /MCP 服务「no-tools」未提供任何工具/,
  );
  assert.equal(disposed, true, "the mount scope is released when no tool name resolves");
});
