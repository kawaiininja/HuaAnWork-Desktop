import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, test } from "vitest";

import { parseSseToolCalls } from "@huaanwork/model";

import { apply, HuaAnWorkAdapter, isRegisteredToolName, loadSettings } from "../../src/huaanwork-guardrails/model.ts";
import { ToolCallId, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";

function userOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: "deepseek-official",
    model: "llama3",
    messages: [
      {
        id: "m1" as GenerateOptions["messages"][number]["id"],
        role: "user",
        content: [{ type: "text", text: "hello" }],
        source: { kind: "user" },
      },
    ],
    ...overrides,
  };
}

function sseResponse(payloads: unknown[]): Response {
  const body = payloads.map((payload) => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("loadSettings reads huaanwork-settings.json and allows empty api_key", () => {
  const root = mkdtempSync(join(tmpdir(), "huaanwork-settings-"));
  const profileDir = join(root, "profile");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "huaanwork-settings.json"), JSON.stringify({ base_url: "http://127.0.0.1:9/v1", model: "qwen", api_key: "" }));
  try {
    assert.deepEqual(loadSettings(profileDir), {
      base_url: "http://127.0.0.1:9/v1",
      model: "qwen",
      api_key: "",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadSettings prefers the active entry in models", () => {
  const root = mkdtempSync(join(tmpdir(), "huaanwork-settings-"));
  const profileDir = join(root, "profile");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, "huaanwork-settings.json"),
    JSON.stringify({
      base_url: "http://stale/v1",
      model: "stale",
      api_key: "old",
      active_model_id: "b",
      models: [
        { id: "a", name: "A", base_url: "http://a/v1", model: "alpha", api_key: "" },
        { id: "b", name: "B", base_url: "http://b/v1", model: "beta", api_key: "k" },
      ],
    }),
  );
  try {
    assert.deepEqual(loadSettings(profileDir), {
      base_url: "http://b/v1",
      model: "beta",
      api_key: "k",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply registers the existing deepseek-official route", () => {
  const registered: { providers?: string[]; adapter?: HuaAnWorkAdapter } = {};
  apply({
    llm: {
      registerAdapter(providers, adapter) {
        registered.providers = providers;
        registered.adapter = adapter as HuaAnWorkAdapter;
      },
    },
  });
  assert.deepEqual(registered.providers, ["deepseek-official"]);
  assert.ok(registered.adapter instanceof HuaAnWorkAdapter);
});

test("stream concatenates SSE tool_calls and does not execute unknown names", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sseResponse([
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: "read", arguments: '{"path":"a.ts"}' } }],
            },
          },
        ],
      },
      "[DONE]",
    ]);
  try {
    const chunks = await collect(new HuaAnWorkAdapter().stream(userOptions()));
    const end = chunks.find((chunk) => chunk.type === "block-end");
    assert.equal(end?.type, "block-end");
    if (end?.type === "block-end") {
      assert.equal(end.block.type, "tool-call");
      if (end.block.type === "tool-call") {
        assert.equal(end.block.name, "read");
        assert.equal(end.block.arguments, '{"path":"a.ts"}');
      }
    }
    assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "tool-calls" } });
  } finally {
    globalThis.fetch = original;
  }
});

test("stream emits only the route call when the model also calls read", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sseResponse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "read", arguments: '{"path":"a.md"}' } },
                { index: 1, id: "c2", function: { name: "propose_plan", arguments: '{"objective":"汇总三份材料"}' } },
              ],
            },
          },
        ],
      },
      "[DONE]",
    ]);
  try {
    const chunks = await collect(new HuaAnWorkAdapter().stream(userOptions()));
    const names = chunks.flatMap((chunk) =>
      chunk.type === "block-end" && chunk.block.type === "tool-call" ? [chunk.block.name] : [],
    );
    assert.deepEqual(names, ["propose_plan"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("stream parses XML text protocol when SSE has no tool_calls", async () => {
  const original = globalThis.fetch;
  const xml = `<tool_call name="read">\n<arg name="path">src/main.rs</arg>\n</tool_call>`;
  globalThis.fetch = async () =>
    sseResponse([{ choices: [{ delta: { content: xml } }] }, "[DONE]"]);
  try {
    const chunks = await collect(new HuaAnWorkAdapter().stream(userOptions()));
    const end = chunks.find((chunk) => chunk.type === "block-end");
    assert.equal(end?.type, "block-end");
    if (end?.type === "block-end" && end.block.type === "tool-call") {
      assert.equal(end.block.name, "read");
      assert.equal(end.block.arguments, '{"path":"src/main.rs"}');
    }
    assert.equal(
      chunks.some((chunk) => chunk.type === "text-delta"),
      false,
    );
    const finish = chunks.at(-1);
    assert.equal(finish?.type, "finish");
    if (finish?.type === "finish") assert.equal(finish.reason.kind, "tool-calls");
  } finally {
    globalThis.fetch = original;
  }
});

test("stream yields text-delta before the SSE body ends", async () => {
  const original = globalThis.fetch;
  const encoder = new TextEncoder();
  let bodyEnded = false;
  let releaseSecond: () => void = () => {};
  const secondEvent = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });

  const hello = `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`;
  const rest = `data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}\n\ndata: [DONE]\n\n`;

  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(hello));
          await Promise.race([secondEvent, new Promise((resolve) => setTimeout(resolve, 200))]);
          controller.enqueue(encoder.encode(rest));
          controller.close();
          bodyEnded = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );

  try {
    const iter = new HuaAnWorkAdapter().stream(userOptions())[Symbol.asyncIterator]();
    let firstDelta: StreamChunk | undefined;
    const found = await Promise.race([
      (async () => {
        while (true) {
          const { done, value } = await iter.next();
          if (done) return false;
          if (value.type === "text-delta") {
            firstDelta = value;
            return true;
          }
        }
      })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150)),
    ]);

    assert.equal(found, true);
    assert.equal(bodyEnded, false);
    assert.equal(firstDelta?.type, "text-delta");
    if (firstDelta?.type === "text-delta") assert.equal(firstDelta.text, "Hello");

    releaseSecond();
    const remaining: StreamChunk[] = [];
    while (true) {
      const { done, value } = await iter.next();
      if (done) break;
      remaining.push(value);
    }
    assert.equal(bodyEnded, true);
    assert.ok(remaining.some((chunk) => chunk.type === "text-delta" && chunk.text === " world"));
  } finally {
    releaseSecond();
    globalThis.fetch = original;
  }
});

test("stream treats garbage model text as the final assistant reply", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sseResponse([{ choices: [{ delta: { content: "All done." } }] }, "[DONE]"]);
  try {
    const chunks = await collect(new HuaAnWorkAdapter().stream(userOptions()));
    assert.deepEqual(
      chunks.filter((chunk) => chunk.type === "text-delta" || chunk.type === "finish"),
      [
        { type: "text-delta", index: 0, text: "All done." },
        { type: "finish", reason: { kind: "stop" } },
      ],
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("POST chat/completions is streamed with 120s timeout and empty api_key is valid", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const originalProfileDir = process.env.HUAANWORK_PROFILE_DIR;
  const root = mkdtempSync(join(tmpdir(), "huaanwork-llm-"));
  const profileDir = join(root, "profile");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "huaanwork-settings.json"), JSON.stringify({ api_key: "", model: "qwen" }));
  process.env.HUAANWORK_PROFILE_DIR = profileDir;

  let timeoutMs: number | undefined;
  let init: RequestInit | undefined;
  let url: string | undefined;
  AbortSignal.timeout = ((ms: number) => {
    timeoutMs = ms;
    return originalTimeout(ms);
  }) as typeof AbortSignal.timeout;
  globalThis.fetch = async (input, requestInit) => {
    url = String(input);
    init = requestInit;
    return sseResponse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"]);
  };

  try {
    await collect(new HuaAnWorkAdapter().stream(userOptions({ signal: new AbortController().signal })));
    assert.equal(url, "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(timeoutMs, 600_000);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), null);
    assert.ok(headers.get("user-agent"));
    const body = JSON.parse(String(init?.body)) as { stream?: boolean; model?: string };
    assert.equal(body.stream, true);
    assert.equal(body.model, "qwen");
    assert.equal(init?.signal?.aborted, false);
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    if (originalProfileDir === undefined) delete process.env.HUAANWORK_PROFILE_DIR;
    else process.env.HUAANWORK_PROFILE_DIR = originalProfileDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("stream yields reasoning blocks from reasoning_content before tool calls", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sseResponse([
      { choices: [{ delta: { reasoning_content: "need explore" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: "skill", arguments: '{"name":"explore"}' } }],
            },
          },
        ],
      },
      "[DONE]",
    ]);
  try {
    const chunks = await collect(new HuaAnWorkAdapter().stream(userOptions()));
    assert.deepEqual(
      chunks.filter((chunk) => chunk.type === "reasoning-delta" || chunk.type === "block-start"),
      [
        { type: "block-start", index: 0, blockType: "reasoning" },
        { type: "reasoning-delta", index: 0, text: "need explore" },
        { type: "block-start", index: 1, blockType: "tool-call" },
      ],
    );
    const reasoningEnd = chunks.find((chunk) => chunk.type === "block-end" && chunk.block.type === "reasoning");
    assert.equal(reasoningEnd?.type, "block-end");
    if (reasoningEnd?.type === "block-end" && reasoningEnd.block.type === "reasoning") {
      assert.equal(reasoningEnd.block.text, "need explore");
    }
    assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "tool-calls" } });
  } finally {
    globalThis.fetch = original;
  }
});

test("follow-up request echoes reasoning_content after a tool call", async () => {
  const original = globalThis.fetch;
  let body: { messages?: { role?: string; reasoning_content?: string; tool_calls?: unknown[] }[] } | undefined;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as typeof body;
    return sseResponse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"]);
  };
  try {
    await collect(
      new HuaAnWorkAdapter().stream(
        userOptions({
          messages: [
            {
              id: "m1" as GenerateOptions["messages"][number]["id"],
              role: "user",
              content: [{ type: "text", text: "explore the repo" }],
              source: { kind: "user" },
            },
            {
              id: "m2" as GenerateOptions["messages"][number]["id"],
              role: "assistant",
              content: [
                { type: "reasoning", text: "I should call explore" },
                {
                  type: "tool-call",
                  id: ToolCallId("call_skill"),
                  name: "skill",
                  arguments: '{"name":"explore"}',
                },
              ],
              source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
            },
            {
              id: "m3" as GenerateOptions["messages"][number]["id"],
              role: "user",
              content: [
                {
                  type: "tool-result",
                  toolCallId: ToolCallId("call_skill"),
                  content: [{ type: "text", text: "skill done" }],
                },
              ],
              source: { kind: "user" },
            },
          ],
        }),
      ),
    );
    const assistant = body?.messages?.find((message) => message.role === "assistant");
    assert.equal(assistant?.reasoning_content, "I should call explore");
    assert.equal(assistant?.tool_calls?.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("HTTP error includes the provider response body", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "reasoning_content must be passed back" } }), {
      status: 400,
    });
  try {
    await assert.rejects(
      () => collect(new HuaAnWorkAdapter().stream(userOptions())),
      /reasoning_content must be passed back/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("stream passes through native call_host_tool and mcp__* calls (runtime-registered tools)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sseResponse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: "call_host_tool", arguments: '{"name":"code-review","arguments":{"root":"/x","include":"src"}}' } },
                { index: 1, function: { name: "mcp__calc__add", arguments: '{"a":1,"b":2}' } },
              ],
            },
          },
        ],
      },
      "[DONE]",
    ]);
  try {
    const chunks = await collect(new HuaAnWorkAdapter().stream(userOptions()));
    const toolEnds = chunks.filter(
      (chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call",
    );
    assert.equal(toolEnds.length, 2);
    if (toolEnds[0]?.type === "block-end" && toolEnds[0].block.type === "tool-call") {
      assert.equal(toolEnds[0].block.name, "call_host_tool");
    }
    if (toolEnds[1]?.type === "block-end" && toolEnds[1].block.type === "tool-call") {
      assert.equal(toolEnds[1].block.name, "mcp__calc__add");
    }
    assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "tool-calls" } });
  } finally {
    globalThis.fetch = original;
  }
});

test("stream still drops genuinely unknown native tool names", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sseResponse([
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: "run_code", arguments: '{}' } }],
            },
          },
        ],
      },
      "[DONE]",
    ]);
  try {
    const chunks = await collect(new HuaAnWorkAdapter().stream(userOptions()));
    const toolEnds = chunks.filter(
      (chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call",
    );
    assert.equal(toolEnds.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("follow-up request sends empty reasoning_content for tool-call turns without reasoning", async () => {
  const original = globalThis.fetch;
  let body: { messages?: { role?: string; reasoning_content?: string; tool_calls?: unknown[] }[] } | undefined;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as typeof body;
    return sseResponse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"]);
  };
  try {
    await collect(
      new HuaAnWorkAdapter().stream(
        userOptions({
          messages: [
            {
              id: "m1" as GenerateOptions["messages"][number]["id"],
              role: "user",
              content: [{ type: "text", text: "call the tool" }],
              source: { kind: "user" },
            },
            {
              id: "m2" as GenerateOptions["messages"][number]["id"],
              role: "assistant",
              content: [
                { type: "text", text: "calling now" },
                {
                  type: "tool-call",
                  id: ToolCallId("call_tool"),
                  name: "call_host_tool",
                  arguments: '{"name":"code-review"}',
                },
              ],
              source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
            },
            {
              id: "m3" as GenerateOptions["messages"][number]["id"],
              role: "user",
              content: [
                {
                  type: "tool-result",
                  toolCallId: ToolCallId("call_tool"),
                  content: [{ type: "text", text: "done" }],
                },
              ],
              source: { kind: "user" },
            },
          ],
        }),
      ),
    );
    const assistant = body?.messages?.find((message) => message.role === "assistant");
    // DeepSeek 思考模式：带 tool_calls 的 assistant 消息必须回传 reasoning_content（空串合法），否则 400
    assert.equal(assistant?.reasoning_content, "");
    assert.equal(assistant?.tool_calls?.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("request never sends a max_tokens budget below the reasoning floor", async () => {
  const original = globalThis.fetch;
  const bodies: { max_tokens?: number }[] = [];
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as { max_tokens?: number });
    return sseResponse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"]);
  };
  try {
    await collect(new HuaAnWorkAdapter().stream(userOptions()));
    await collect(new HuaAnWorkAdapter().stream(userOptions({ maxTokens: 4096 })));
    assert.equal(bodies[0]?.max_tokens, 16_384);
    assert.equal(bodies[1]?.max_tokens, 16_384);
  } finally {
    globalThis.fetch = original;
  }
});

test("reasoning-only stop is asked to continue and then accepts the real answer", async () => {
  const original = globalThis.fetch;
  const bodies: { messages?: { role?: string; content?: string }[] }[] = [];
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as { messages?: { role?: string; content?: string }[] });
    if (bodies.length === 1) {
      return sseResponse([
        { choices: [{ delta: { reasoning_content: "Let me take the screenshot now." } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        "[DONE]",
      ]);
    }
    return sseResponse([
      { choices: [{ delta: { content: "采集结果已整理。" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ]);
  };
  try {
    const chunks = await collect(new HuaAnWorkAdapter().stream(userOptions()));
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1]?.messages?.at(-1)?.content, "请继续完成这一步：需要工具就直接发起工具调用，否则输出正文结果。不要只输出思考。");
    const finish = chunks.at(-1);
    assert.equal(finish?.type, "finish");
    if (finish?.type === "finish") assert.equal(finish.reason.kind, "stop");
    assert.ok(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text.includes("采集结果已整理")));
  } finally {
    globalThis.fetch = original;
  }
});

test("reasoning-only stop with finish_reason=length reports the token budget, not a bare empty response", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    sseResponse([
      { choices: [{ delta: { reasoning_content: "long thinking with no room left" } }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
      "[DONE]",
    ]);
  try {
    const chunks = await collect(new HuaAnWorkAdapter().stream(userOptions()));
    const finish = chunks.at(-1);
    assert.equal(finish?.type, "finish");
    if (finish?.type === "finish" && finish.reason.kind === "error") {
      assert.equal(finish.reason.failure.code, "EMPTY_RESPONSE");
      assert.match(finish.reason.failure.message, /max_tokens/);
      assert.match(finish.reason.failure.message, /length/);
    } else {
      assert.fail("expected a finish error");
    }
  } finally {
    globalThis.fetch = original;
  }
});

describe('model settings resolve from the injected profile directory', () => {
  it('reads the endpoint the settings route wrote, under a non-default profile', () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'model-nondefault-'))
    writeFileSync(join(profileDir, 'huaanwork-settings.json'), JSON.stringify({
      base_url: 'http://127.0.0.1:1234/v1', model: 'm', api_key: '', models: [], active_model_id: '',
    }), 'utf8')
    expect(loadSettings(profileDir).base_url).toBe('http://127.0.0.1:1234/v1')
  })

  it('does not hardcode the desktop profile name', () => {
    const home = mkdtempSync(join(tmpdir(), 'model-home-'))
    const desktopProfile = join(home, 'profiles', 'desktop')
    mkdirSync(desktopProfile, { recursive: true })
    writeFileSync(join(desktopProfile, 'huaanwork-settings.json'), JSON.stringify({ base_url: 'http://127.0.0.1:9999/v1' }), 'utf8')
    // 传的是 home 而非 profileDir:不得再从 home 拼出 profiles/desktop 读到这份文件。
    expect(loadSettings(home).base_url).not.toBe('http://127.0.0.1:9999/v1')
  })
})

test("route tool names survive the static tool filter", () => {
  const payloads = [
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "propose_plan", arguments: "{\"objective\":\"汇总三份材料\"}" } }] } }],
    }),
  ];
  assert.equal(parseSseToolCalls(payloads, isRegisteredToolName).length, 1);

  const requestInput = [
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "c2", function: { name: "request_input", arguments: "{\"prompt\":\"还缺哪一份\"}" } }] } }],
    }),
  ];
  assert.equal(parseSseToolCalls(requestInput, isRegisteredToolName).length, 1);
});

