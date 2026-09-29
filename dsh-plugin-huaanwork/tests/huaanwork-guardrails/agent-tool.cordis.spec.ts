import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, test } from "vitest";

import { apply, readCatalogToken, registerCallHostTool } from "../../src/huaanwork-guardrails/agent-tool.ts";

type ToolDefinition = {
  name: string;
  description: string;
  parameters: unknown;
  output: unknown;
  execute: (args: { name: string; arguments?: Record<string, unknown> }, exec: { signal?: AbortSignal }) => Promise<{
    isError: boolean;
    status?: number;
    text?: string;
    result?: unknown;
    truncated?: boolean;
    content: Array<{ type: string; text: string }>;
  }>;
};

type PreExecuteListener = (
  execution: { name: string; arguments: Record<string, unknown> },
  next: () => Promise<{ kind: string; reason?: string }>,
) => Promise<{ kind: string; reason?: string }>;

function createMockCtx(options: { dshHome?: string; profileDir?: string; snapshot?: any; fetchImpl?: typeof fetch } = {}) {
  const registered: ToolDefinition[] = [];
  const events: Record<string, PreExecuteListener[]> = {};

  const ctx = {
    huaanworkDshHome: options.dshHome,
    huaanworkProfileDir: options.profileDir,
    huaanworkAgentCatalog: options.snapshot ? { current: options.snapshot } : { current: { items: [] } },
    tools: {
      register(def: ToolDefinition) {
        registered.push(def);
        return () => {
          const idx = registered.indexOf(def);
          if (idx !== -1) registered.splice(idx, 1);
        };
      },
    },
    on(event: string, listener: PreExecuteListener, prepend?: boolean) {
      events[event] ??= [];
      if (prepend) {
        events[event].unshift(listener);
      } else {
        events[event].push(listener);
      }
    },
  };

  return {
    ctx,
    registered,
    async runPreExecute(execution: { name: string; arguments: Record<string, unknown> }, terminal: () => Promise<{ kind: string; reason?: string }>) {
      const listeners = events["tools/pre-execute"] ?? [];
      let index = 0;
      const dispatch = async (): Promise<{ kind: string; reason?: string }> => {
        if (index >= listeners.length) return terminal();
        const nextFn = listeners[index++];
        return nextFn(execution, dispatch);
      };
      return dispatch();
    },
  };
}

test("1. 注册名是 call_host_tool；description 动态枚举已启用且未 broken 的 http 工具及 argumentsSchema", () => {
  const harness = createMockCtx();
  const snapshot = {
    items: [
      {
        name: "pdf-extract",
        source: "catalog" as const,
        kind: "tool" as const,
        entrypointKind: "http" as const,
        enabled: true,
        entrypoint: { kind: "http" as const, url: "http://127.0.0.1:18081/invoke" },
        argumentsSchema: { type: "object", properties: { file: { type: "string" } } },
      },
      {
        name: "broken-tool",
        source: "catalog" as const,
        kind: "tool" as const,
        entrypointKind: "http" as const,
        enabled: true,
        broken: { reason: "fail" },
        entrypoint: { kind: "http" as const, url: "http://127.0.0.1:18081/invoke" },
      },
      {
        name: "disabled-tool",
        source: "catalog" as const,
        kind: "tool" as const,
        entrypointKind: "http" as const,
        enabled: false,
        entrypoint: { kind: "http" as const, url: "http://127.0.0.1:18081/invoke" },
      },
      {
        name: "mcp-tool",
        source: "catalog" as const,
        kind: "tool" as const,
        entrypointKind: "mcp" as const,
        enabled: true,
        entrypoint: { kind: "mcp" as const, url: "http://127.0.0.1:18082/mcp" },
      },
      {
        name: "agent-helper",
        source: "catalog" as const,
        kind: "agent" as const,
        enabled: true,
      },
    ],
  };

  const unregister = registerCallHostTool(harness.ctx as any, snapshot);
  assert.equal(harness.registered.length, 1);
  const tool = harness.registered[0];
  assert.equal(tool.name, "call_host_tool");
  assert.ok(tool.description.includes("pdf-extract"));
  assert.ok(tool.description.includes("properties"));
  assert.ok(!tool.description.includes("broken-tool"));
  assert.ok(!tool.description.includes("disabled-tool"));
  assert.ok(!tool.description.includes("mcp-tool"));
  assert.ok(!tool.description.includes("agent-helper"));

  unregister?.();
  assert.equal(harness.registered.length, 0);
});

test("2. snapshot 有 pdf-extract，huaanwork-settings.json 有 agents_catalog_token 时，execute 发送 POST 并携带 Bearer token 与 arguments", async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "agent-tool-test-"));
  writeFileSync(
    join(profileDir, "huaanwork-settings.json"),
    JSON.stringify({ agents_catalog_token: "secret-token-123" }),
    "utf8",
  );

  const snapshot = {
    items: [
      {
        name: "pdf-extract",
        source: "catalog" as const,
        kind: "tool" as const,
        entrypointKind: "http" as const,
        enabled: true,
        entrypoint: { kind: "http" as const, url: "http://127.0.0.1:18081/invoke" },
      },
    ],
  };

  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  const fakeFetch: typeof fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(JSON.stringify({ ok: true, result: { pages: 3 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const harness = createMockCtx({ profileDir, snapshot });
    registerCallHostTool(harness.ctx as any, snapshot, { fetchImpl: fakeFetch });
    const tool = harness.registered[0];
    assert.ok(tool);

    const res = await tool.execute(
      { name: "pdf-extract", arguments: { file: "a.pdf" } },
      { signal: new AbortController().signal },
    );

    assert.equal(capturedUrl, "http://127.0.0.1:18081/invoke");
    assert.equal(capturedInit?.method, "POST");
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer secret-token-123");
    assert.equal(headers["content-type"], "application/json");
    assert.equal(capturedInit?.body, JSON.stringify({ arguments: { file: "a.pdf" } }));

    assert.equal(res.isError, false);
    assert.equal(res.status, 200);
    assert.deepEqual(res.result, { pages: 3 });
    assert.equal(res.truncated, false);
    assert.equal(res.content[0].text, JSON.stringify({ ok: true, result: { pages: 3 } }));
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("3. 未在 snapshot 或已禁用的工具 → isError，fetch 次数 0", async () => {
  const snapshot = {
    items: [
      {
        name: "pdf-extract",
        source: "catalog" as const,
        kind: "tool" as const,
        entrypointKind: "http" as const,
        enabled: false,
        entrypoint: { kind: "http" as const, url: "http://127.0.0.1:18081/invoke" },
      },
    ],
  };

  let fetchCalls = 0;
  const fakeFetch: typeof fetch = async () => {
    fetchCalls++;
    return new Response("ok");
  };

  const harness = createMockCtx({ snapshot });
  registerCallHostTool(harness.ctx as any, snapshot, { fetchImpl: fakeFetch });
  const tool = harness.registered[0];

  const resNotFound = await tool.execute({ name: "unknown-tool" }, {});
  assert.equal(resNotFound.isError, true);
  assert.equal(resNotFound.text, "未挂载或不存在的小工具");
  assert.equal(resNotFound.content[0].text, "未挂载或不存在的小工具");
  assert.equal(fetchCalls, 0);

  const resDisabled = await tool.execute({ name: "pdf-extract" }, {});
  assert.equal(resDisabled.isError, true);
  assert.equal(resDisabled.text, "未挂载或不存在的小工具");
  assert.equal(fetchCalls, 0);
});

test("4. 超时：触发 timeout → isError，不抛异常", async () => {
  const snapshot = {
    items: [
      {
        name: "slow-tool",
        source: "catalog" as const,
        kind: "tool" as const,
        entrypointKind: "http" as const,
        enabled: true,
        timeoutMs: 1000,
        entrypoint: { kind: "http" as const, url: "http://127.0.0.1:18081/invoke" },
      },
    ],
  };

  const fakeFetch: typeof fetch = async (_url, init) => {
    return new Promise((_resolve, reject) => {
      // AbortSignal.timeout 的内部定时器是 unref'd;若本 Promise 只等 abort 事件,
      // 事件循环会被判空,测试运行器以 "event loop has already resolved" 级联取消
      // 后续全部用例(Node 22 行为)。用一个 ref'd 兜底定时器显式保持事件循环,
      // 其时长(5s)远大于被测超时(1s),不影响竞态结果。
      const hold = setTimeout(() => reject(new Error("fakeFetch outlived the tool timeout")), 5000);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(hold);
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        reject(err);
      });
    });
  };

  const harness = createMockCtx({ snapshot });
  registerCallHostTool(harness.ctx as any, snapshot, { fetchImpl: fakeFetch });
  const tool = harness.registered[0];

  const res = await tool.execute({ name: "slow-tool" }, {});
  assert.equal(res.isError, true);
  assert.match(res.text ?? "", /公用机小工具「slow-tool」调用超时（TIMEOUT）/);
  assert.match(res.content[0].text, /公用机小工具「slow-tool」调用超时（TIMEOUT）/);
});

test("5. 非 2xx：isError，text 含不超过 500 字的 body", async () => {
  const snapshot = {
    items: [
      {
        name: "failing-tool",
        source: "catalog" as const,
        kind: "tool" as const,
        entrypointKind: "http" as const,
        enabled: true,
        entrypoint: { kind: "http" as const, url: "http://127.0.0.1:18081/invoke" },
      },
    ],
  };

  const longBody = "error: ".repeat(200); // 1400 chars
  const fakeFetch: typeof fetch = async () => {
    return new Response(longBody, { status: 502 });
  };

  const harness = createMockCtx({ snapshot });
  registerCallHostTool(harness.ctx as any, snapshot, { fetchImpl: fakeFetch });
  const tool = harness.registered[0];

  const res = await tool.execute({ name: "failing-tool" }, {});
  assert.equal(res.isError, true);
  assert.equal(res.status, 502);
  assert.ok(res.text?.startsWith("HTTP 502: error: "));
  // Detail capped at 500 chars (+ "HTTP 502: " which is 10 chars)
  assert.ok((res.text?.length ?? 0) <= 515);
});

test("6. 响应体 > 1 MiB：先截断到 1 MiB 并标记 truncated，再被 cap 到 32 KiB", async () => {
  const snapshot = {
    items: [
      {
        name: "huge-tool",
        source: "catalog" as const,
        kind: "tool" as const,
        entrypointKind: "http" as const,
        enabled: true,
        entrypoint: { kind: "http" as const, url: "http://127.0.0.1:18081/invoke" },
      },
    ],
  };

  // 1.5 MiB string
  const chunk = "x".repeat(1024);
  const bigString = chunk.repeat(1536);

  const fakeFetch: typeof fetch = async () => {
    return new Response(bigString, { status: 200 });
  };

  const harness = createMockCtx({ snapshot });
  registerCallHostTool(harness.ctx as any, snapshot, { fetchImpl: fakeFetch });
  const tool = harness.registered[0];

  const res = await tool.execute({ name: "huge-tool" }, {});
  assert.equal(res.isError, false);
  assert.equal(res.truncated, true);
  assert.ok(Buffer.byteLength(res.text ?? "", "utf8") <= 32 * 1024);
});

test("7. apply() 之后 ctx.tools.register 调用次数为 0（只挂 listener），registerCallHostTool 才产生一次 register", () => {
  const harness = createMockCtx();
  apply(harness.ctx as any);
  assert.equal(harness.registered.length, 0);

  const unregister = registerCallHostTool(harness.ctx as any, { items: [] });
  assert.equal(harness.registered.length, 1);
  unregister?.();
  assert.equal(harness.registered.length, 0);
});

test("8. caller aborted → isError: true 且返回 ABORTED 文案", async () => {
  const snapshot = {
    items: [
      {
        name: "my-tool",
        source: "catalog" as const,
        kind: "tool" as const,
        entrypointKind: "http" as const,
        enabled: true,
        entrypoint: { kind: "http" as const, url: "http://127.0.0.1:18081/invoke" },
      },
    ],
  };

  const controller = new AbortController();
  controller.abort();

  const fakeFetch: typeof fetch = async () => {
    throw new Error("aborted");
  };

  const harness = createMockCtx({ snapshot });
  registerCallHostTool(harness.ctx as any, snapshot, { fetchImpl: fakeFetch });
  const tool = harness.registered[0];

  const res = await tool.execute({ name: "my-tool" }, { signal: controller.signal });
  assert.equal(res.isError, true);
  assert.equal(res.text, "公用机小工具「my-tool」调用已取消（ABORTED）");
});

test("9. 网络传输错误 → isError: true 且返回 TRANSPORT 文案，不抛异常", async () => {
  const snapshot = {
    items: [
      {
        name: "my-tool",
        source: "catalog" as const,
        kind: "tool" as const,
        entrypointKind: "http" as const,
        enabled: true,
        entrypoint: { kind: "http" as const, url: "http://127.0.0.1:18081/invoke" },
      },
    ],
  };

  const fakeFetch: typeof fetch = async () => {
    throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:18081");
  };

  const harness = createMockCtx({ snapshot });
  registerCallHostTool(harness.ctx as any, snapshot, { fetchImpl: fakeFetch });
  const tool = harness.registered[0];

  const res = await tool.execute({ name: "my-tool" }, {});
  assert.equal(res.isError, true);
  assert.match(res.text ?? "", /公用机小工具「my-tool」网络请求失败（TRANSPORT）/);
  assert.match(res.text ?? "", /ECONNREFUSED/);
});

test("10. 2xx 响应体为 JSON { ok: false, error } 时判定为 isError: true", async () => {
  const snapshot = {
    items: [
      {
        name: "my-tool",
        source: "catalog" as const,
        kind: "tool" as const,
        entrypointKind: "http" as const,
        enabled: true,
        entrypoint: { kind: "http" as const, url: "http://127.0.0.1:18081/invoke" },
      },
    ],
  };

  const fakeFetch: typeof fetch = async () => {
    return new Response(JSON.stringify({ ok: false, error: "file not found" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const harness = createMockCtx({ snapshot });
  registerCallHostTool(harness.ctx as any, snapshot, { fetchImpl: fakeFetch });
  const tool = harness.registered[0];

  const res = await tool.execute({ name: "my-tool" }, {});
  assert.equal(res.isError, true);
  assert.equal(res.text, "file not found");
});

test("11. apply() 的 tools/pre-execute listener 为 call_host_tool 补全 ask reason", async () => {
  const harness = createMockCtx();
  apply(harness.ctx as any);

  // When policy returns ask:
  const decision = await harness.runPreExecute(
    { name: "call_host_tool", arguments: { name: "pdf-extract" } },
    async () => ({ kind: "ask" }),
  );
  assert.equal(decision.kind, "ask");
  assert.equal(decision.reason, "调用公用机小工具「pdf-extract」");

  // When policy returns allow, keep allow:
  const allowDecision = await harness.runPreExecute(
    { name: "call_host_tool", arguments: { name: "pdf-extract" } },
    async () => ({ kind: "allow" }),
  );
  assert.equal(allowDecision.kind, "allow");

  // When other tool, pass through:
  const otherDecision = await harness.runPreExecute(
    { name: "other_tool", arguments: {} },
    async () => ({ kind: "ask", reason: "other reason" }),
  );
  assert.equal(otherDecision.kind, "ask");
  assert.equal(otherDecision.reason, "other reason");
});

test("description 带条目描述，超长 argumentsSchema 截断到 1 KiB", () => {
  const harness = createMockCtx();
  const snapshot = {
    items: [
      {
        name: "described-tool",
        source: "catalog" as const,
        kind: "tool" as const,
        entrypointKind: "http" as const,
        enabled: true,
        description: "把 PDF 抽成纯文本",
        entrypoint: { kind: "http" as const, url: "http://127.0.0.1:18081/invoke" },
        argumentsSchema: { type: "object", properties: { blob: { type: "string", description: "x".repeat(4096) } } },
      },
    ],
  };

  const unregister = registerCallHostTool(harness.ctx as any, snapshot);
  const tool = harness.registered[0];
  assert.ok(tool.description.includes("described-tool: 把 PDF 抽成纯文本"));
  const schemaIdx = tool.description.indexOf("(参数:");
  assert.ok(schemaIdx > 0);
  assert.ok(tool.description.length - schemaIdx <= 1024 + 16, "schema 段必须截断");
  unregister?.();
});

describe('agents catalog token reads the profile settings document', () => {
  it('returns the configured token', () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'catalog-token-'))
    writeFileSync(join(profileDir, 'huaanwork-settings.json'), JSON.stringify({ agents_catalog_token: 'tok-123' }), 'utf8')
    expect(readCatalogToken(profileDir)).toBe('tok-123')
  })

  it('returns an empty token rather than reading above the profile directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'catalog-token-home-'))
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ agents_catalog_token: 'leaked' }), 'utf8')
    expect(readCatalogToken(join(home, '.huaanwork'))).toBe('')
  })

  it('returns an empty token when nothing was injected', () => {
    expect(readCatalogToken(undefined)).toBe('')
  })
})

