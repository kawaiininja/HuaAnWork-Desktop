import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

type StreamChunk =
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | { type: "block-end"; index: number; block: { type: "reasoning"; text: string } }
  | { type: "finish"; reason: { kind: string } };

type ToolResult = {
  isError: boolean;
  value?: unknown;
  content: { type: string; text?: string }[];
  error?: unknown;
};

type Execute = (
  execution: { name: string; callId?: string; arguments?: unknown },
  next: () => Promise<ToolResult>,
) => Promise<ToolResult>;

function createCtx(workspaceRoot = "/tmp/pinned") {
  const listeners: Record<string, ((...args: never[]) => unknown)[]> = {};
  const emitted: unknown[] = [];
  const ctx = {
    huaanworkWorkspaceRoot: { current: workspaceRoot },
    huaanworkEmit(event: unknown) {
      emitted.push(event);
    },
    on(event: string, listener: (...args: never[]) => unknown) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(listener);
    },
  };
  return { ctx, listeners, emitted };
}

test("bridge emits tokens from llm/stream without writing stdout", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { ctx, listeners, emitted } = createCtx();
  const originalWrite = process.stdout.write;
  const writes: unknown[] = [];
  process.stdout.write = ((chunk: unknown) => {
    writes.push(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    apply(ctx as never);
    const wrap = listeners["llm/stream"]?.[0] as (
      options: unknown,
      next: () => AsyncIterable<StreamChunk>,
    ) => AsyncIterable<StreamChunk>;
    async function* next() {
      yield { type: "text-delta" as const, index: 0, text: "Hel" };
      yield { type: "text-delta" as const, index: 0, text: "lo" };
      yield { type: "finish" as const, reason: { kind: "stop" } };
    }
    const chunks: StreamChunk[] = [];
    for await (const chunk of wrap({}, next)) chunks.push(chunk);
    assert.deepEqual(
      emitted.filter((event) => (event as { event?: string }).event === "token"),
      [
        { event: "token", text: "Hel" },
        { event: "token", text: "lo" },
      ],
    );
    assert.equal(chunks.length, 3);
    assert.equal(writes.length, 0);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("bridge caps tool output on tool/end and does not grow already truncated payloads", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { ctx, listeners, emitted } = createCtx();
  apply(ctx as never);
  const execute = listeners["tools/execute"]?.[0] as Execute;

  const huge = "x".repeat(32 * 1024 + 8);
  const capped = await execute(
    { name: "bash", callId: "big" },
    async () => ({
      isError: false,
      value: { stdout: huge, stderr: "err" },
      content: [{ type: "text", text: huge + "err" }],
    }),
  );
  assert.equal((capped.content[0]?.text ?? "").length < huge.length + 3, true);
  assert.deepEqual(
    emitted.find((event) => (event as { event?: string }).event === "tool/start"),
    { event: "tool/start", name: "bash", callId: "big" },
  );
  const ended = emitted.find(
    (event) => (event as { event?: string; name?: string }).event === "tool/end" && (event as { name?: string }).name === "bash",
  ) as { truncated?: boolean };
  assert.equal(ended.truncated, true);

  emitted.length = 0;
  const already = await execute(
    { name: "bash", callId: "trunc" },
    async () => ({
      isError: false,
      value: { stdout: "payload", stderr: "ignored", truncated: true },
      content: [{ type: "text", text: "payload" }],
    }),
  );
  assert.equal(already.content[0]?.text, "payload");
  assert.notEqual(already.content[0]?.text, "payloadignored");
  const truncatedEnd = emitted.find((event) => (event as { event?: string }).event === "tool/end") as {
    truncated?: boolean;
  };
  assert.equal(truncatedEnd.truncated, true);
});

test("bridge emits a diff event from git_diff stdout", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { ctx, listeners, emitted } = createCtx();
  apply(ctx as never);
  const execute = listeners["tools/execute"]?.[0] as Execute;
  await execute(
    { name: "git_diff", callId: "d1" },
    async () => ({
      isError: false,
      value: { stdout: "diff --git a/a.txt b/a.txt\n", stderr: "" },
      content: [{ type: "text", text: "diff --git a/a.txt b/a.txt\n" }],
    }),
  );
  assert.deepEqual(
    emitted.find((event) => (event as { event?: string }).event === "diff"),
    { event: "diff", text: "diff --git a/a.txt b/a.txt\n" },
  );
});

test("bridge diff snapshot includes untracked new files", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const root = mkdtempSync(join(tmpdir(), "huaanwork-bridge-diff-"));
  const originalWrite = process.stdout.write;
  const writes: unknown[] = [];
  process.stdout.write = ((chunk: unknown) => {
    writes.push(chunk);
    return true;
  }) as typeof process.stdout.write;

  try {
    assert.equal(spawnSync("git", ["init", "-q", "--template=/dev/null"], { cwd: root }).status, 0);
    writeFileSync(join(root, "brand-new.txt"), "hello from write\n");
    const { ctx, listeners, emitted } = createCtx(root);
    apply(ctx as never);
    const execute = listeners["tools/execute"]?.[0] as Execute;
    await execute(
      { name: "write", callId: "w1" },
      async () => ({
        isError: false,
        content: [{ type: "text", text: "ok" }],
      }),
    );
    const diff = emitted.find((event) => (event as { event?: string }).event === "diff") as { text?: string };
    assert.ok(diff?.text?.includes("brand-new.txt"), diff?.text);
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    assert.match(status.stdout, /\?\? brand-new\.txt/);
    assert.equal(writes.length, 0);
  } finally {
    process.stdout.write = originalWrite;
    rmSync(root, { recursive: true, force: true });
  }
});

test("write lands on disk and the diff snapshot is nonempty", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const root = mkdtempSync(join(tmpdir(), "huaanwork-bridge-write-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q", "--template=/dev/null"], { cwd: root }).status, 0);
    const { ctx, listeners, emitted } = createCtx(root);
    apply(ctx as never);
    const execute = listeners["tools/execute"]?.[0] as Execute;
    await execute({ name: "write", callId: "w-land", arguments: { path: "a.txt", content: "hi" } }, async () => {
      writeFileSync(join(root, "a.txt"), "hi");
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    });
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "hi");
    const diff = emitted.find((event) => (event as { event?: string }).event === "diff") as { text?: string };
    assert.ok(diff?.text && diff.text.length > 0, "diff snapshot must be nonempty");
    assert.ok(diff.text.includes("a.txt"), diff.text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge maps idle and error agent status to session/end", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { ctx, listeners, emitted } = createCtx();
  apply(ctx as never);
  const status = listeners["agent/status"]?.[0] as (payload: { status: string }) => void;
  const error = listeners["agent/error"]?.[0] as (payload: { error: unknown }) => void;
  status({ status: "idle" });
  error({ error: new Error("boom") });
  error({ error: Object.assign(new Error("HuaAnWork model request aborted by caller"), { code: "ABORTED" }) });
  assert.deepEqual(
    emitted.filter((event) => (event as { event?: string }).event === "session/end"),
    [
      { event: "session/end", ok: true },
      { event: "session/end", ok: false, error: "boom" },
      { event: "session/end", ok: true, cancelled: true },
    ],
  );
});

test("bridge skips token events for auxiliary streams (purpose compaction/session-title)", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { ctx, listeners, emitted } = createCtx();
  apply(ctx as never);
  const wrap = listeners["llm/stream"]?.[0] as (
    options: unknown,
    next: () => AsyncIterable<StreamChunk>,
  ) => AsyncIterable<StreamChunk>;
  async function* auxChunks() {
    yield { type: "text-delta" as const, index: 0, text: "summary-text" };
    yield { type: "finish" as const, reason: { kind: "stop" } };
  }
  // purpose 携带的辅助流（compaction / session-title）：text-delta 仍流经管道，但不发 token 事件。
  const compacted: StreamChunk[] = [];
  for await (const chunk of wrap({ purpose: "compaction", sessionId: "huaanwork-auto-x-y" }, auxChunks)) {
    compacted.push(chunk);
  }
  assert.equal(compacted.length, 2);
  const titled: StreamChunk[] = [];
  for await (const chunk of wrap({ purpose: "session-title" }, auxChunks)) titled.push(chunk);
  assert.equal(titled.length, 2);
  assert.deepEqual(
    emitted.filter((event) => (event as { event?: string }).event === "token"),
    [],
    "auxiliary streams must not emit token events",
  );
  // 普通回合流不受影响：仍发 token。
  const normal: StreamChunk[] = [];
  for await (const chunk of wrap({}, auxChunks)) normal.push(chunk);
  assert.equal(normal.length, 2);
  assert.equal(
    emitted.filter((event) => (event as { event?: string }).event === "token").length,
    1,
  );
});

test("bridge forwards user-turn reasoning and skips purposed calls", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { ctx, listeners, emitted } = createCtx();
  apply(ctx as never);
  const wrap = listeners["llm/stream"]?.[0] as (
    options: { sessionId?: string; purpose?: string },
    next: () => AsyncIterable<StreamChunk>,
  ) => AsyncIterable<StreamChunk>;
  async function* userTurn() {
    yield { type: "reasoning-delta" as const, index: 0, text: "先" };
    yield { type: "reasoning-delta" as const, index: 0, text: "看" };
    yield { type: "block-end" as const, index: 0, block: { type: "reasoning" as const, text: "先看" } };
  }
  for await (const _chunk of wrap({ sessionId: "huaanwork-0123456789abcdef" }, userTurn)) {
    // drain
  }
  async function* titled() {
    yield { type: "reasoning-delta" as const, index: 0, text: "标题思考" };
    yield { type: "text-delta" as const, index: 1, text: "标题" };
  }
  for await (const _chunk of wrap({ purpose: "session-title" }, titled)) {
    // drain
  }
  assert.deepEqual(
    emitted.filter((event) => (event as { event?: string }).event === "reasoning"),
    [
      { event: "reasoning", text: "先", sessionId: "huaanwork-0123456789abcdef" },
      { event: "reasoning", text: "看", sessionId: "huaanwork-0123456789abcdef" },
      { event: "reasoning", text: "先看", sessionId: "huaanwork-0123456789abcdef", final: true },
    ],
  );
  assert.deepEqual(
    emitted.filter((event) => (event as { event?: string }).event === "token"),
    [],
  );
});
