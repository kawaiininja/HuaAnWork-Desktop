import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";

import { createSubagentRunRegistry } from "../../src/huaanwork-host/subagent-runs.ts";

// Transparent spawnSync wrapper: the snapshot tests below assert the blocking
// budget on the real calls; every other test still executes the real binary.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

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
  execution: {
    name: string;
    callId?: string;
    arguments?: unknown;
    agent?: { id?: string; session?: { id?: string } };
  },
  next: () => Promise<ToolResult>,
) => Promise<ToolResult>;

type Runs = ReturnType<typeof createSubagentRunRegistry>;

const PARENT_SESSION = "huaanwork-parent-session";
const CHILD_SESSION = "huaanwork-child-session";
const parentAgent = { session: { id: PARENT_SESSION } };
const childAgent = { session: { id: CHILD_SESSION } };

function createRuns(): Runs {
  return createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined });
}

/**
 * 登记一个 @ 运行并把 child 会话绑到它:此后 `ownsChild(childId)` 为真。
 * 预留与上游绑定都走真实入口,不直接改 registry 内部索引。
 */
function registerChild(runs: Runs, childId = CHILD_SESSION, parentSessionId = PARENT_SESSION): string {
  const runId = runs.begin({ parentSessionId, kind: "legacy", label: "@review" });
  runs.reserveChild(runId, childId);
  runs.bindUpstreamStart({ hostRunId: runId, upstreamRunId: `upstream-${childId}`, childId });
  return runId;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createCtx(workspaceRoot = "/tmp/pinned", subagentRuns?: Runs) {
  const listeners: Record<string, ((...args: never[]) => unknown)[]> = {};
  const emitted: unknown[] = [];
  const ctx = {
    huaanworkWorkspaceRoot: { current: workspaceRoot },
    ...(subagentRuns === undefined ? {} : { huaanworkSubagentRuns: subagentRuns }),
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
  const cappedText = capped.content[0]?.text ?? "";
  assert.equal(cappedText.length < huge.length + 3, true);
  assert.match(cappedText, /已截断/);
  assert.equal(cappedText.endsWith("err"), true);
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

test("a large untracked tree stays within the per-call git timeout and the untracked-diff cap", async () => {
  const { workspaceDiff } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { createGitWorkBudget, GIT_SNAPSHOT_MAX_UNTRACKED_DIFFS } = await import(
    "../../src/huaanwork-guardrails/git-budget.ts"
  );
  const root = mkdtempSync(join(tmpdir(), "huaanwork-bridge-budget-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q", "--template=/dev/null"], { cwd: root }).status, 0);
    for (let index = 0; index <= GIT_SNAPSHOT_MAX_UNTRACKED_DIFFS; index += 1) {
      writeFileSync(join(root, `untracked-${index}.txt`), `body ${index}\n`);
    }
    vi.mocked(spawnSync).mockClear();
    const text = workspaceDiff(root, createGitWorkBudget(60_000));
    assert.ok(text?.includes("untracked-0.txt"), "the first untracked file still reaches the snapshot");

    const calls = vi.mocked(spawnSync).mock.calls;
    for (const [, , options] of calls) {
      assert.equal(typeof options?.timeout, "number", "every blocking git call needs a timeout");
      assert.ok((options?.timeout ?? 0) > 0 && (options?.timeout ?? 0) <= 1_500, "the timeout must stay under 1.5 s");
    }
    const untrackedDiffs = calls.filter(([command, argv]) =>
      command === "git" && Array.isArray(argv) && argv[0] === "diff" && argv[1] === "--no-index"
    );
    assert.equal(
      untrackedDiffs.length,
      GIT_SNAPSHOT_MAX_UNTRACKED_DIFFS,
      "the snapshot stops after the configured number of untracked diffs",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a spent git budget skips spawning instead of passing timeout: 0", async () => {
  const { workspaceDiff } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { createGitWorkBudget } = await import("../../src/huaanwork-guardrails/git-budget.ts");
  vi.mocked(spawnSync).mockClear();
  assert.equal(workspaceDiff(process.cwd(), createGitWorkBudget(0)), undefined);
  assert.equal(
    vi.mocked(spawnSync).mock.calls.length,
    0,
    "spawnSync reads timeout: 0 as 'no timeout', so a spent budget must not call it at all",
  );
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

test("compaction purpose does not emit reasoning or tokens", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { ctx, listeners, emitted } = createCtx();
  apply(ctx as never);
  const wrap = listeners["llm/stream"]?.[0] as (
    options: { purpose?: string },
    next: () => AsyncIterable<{ type: "reasoning-delta" | "text-delta"; index: number; text: string }>,
  ) => AsyncIterable<unknown>;
  async function* compact() {
    yield { type: "reasoning-delta" as const, index: 0, text: "压缩思考" };
    yield { type: "text-delta" as const, index: 1, text: "摘要" };
  }
  for await (const _chunk of wrap({ purpose: "compaction" }, compact)) {
    // drain
  }
  assert.equal(emitted.length, 0);
});

test("bridge tells the client when a compaction finished, and stays silent on failed or other session events", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { ctx, listeners, emitted } = createCtx();
  apply(ctx as never);
  const onSessionEvent = listeners["session/event"]?.[0] as (
    session: { id: string },
    event: { type: string; data?: { error?: string } },
  ) => void;
  assert.equal(typeof onSessionEvent, "function");
  const session = { id: "huaanwork-0123456789abcdef" };
  onSessionEvent(session, { type: "compaction/start", data: {} });
  onSessionEvent(session, { type: "compaction/summary", data: {} });
  onSessionEvent(session, { type: "compaction/end", data: { error: "summary failed" } });
  assert.deepEqual(emitted, []);
  onSessionEvent(session, { type: "compaction/end", data: {} });
  assert.deepEqual(emitted, [{ event: "compaction/done", sessionId: "huaanwork-0123456789abcdef" }]);
});

test("bridge reports goal rounds, every goal phase, and the round limit from official session events", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { ctx, listeners, emitted } = createCtx();
  apply(ctx as never);
  const onSessionEvent = listeners["session/event"]?.[0] as (
    session: { id: string },
    event: { type: string; data?: unknown },
  ) => void;
  const session = { id: "huaanwork-0123456789abcdef" };
  const sessionId = "huaanwork-0123456789abcdef";
  onSessionEvent(session, { type: "user/message", data: { source: { kind: "user" } } });
  onSessionEvent(session, { type: "user/message", data: { source: { kind: "goal", goalId: "g", revision: 1, round: 0 } } });
  assert.deepEqual(emitted, []);

  // All four official phases reach the client, with the round counter when present.
  onSessionEvent(session, { type: "goal/change", data: { goal: { phase: "active" }, roundsStarted: 1 } });
  onSessionEvent(session, { type: "goal/change", data: { goal: { phase: "paused" }, roundsStarted: 1 } });
  onSessionEvent(session, {
    type: "goal/change",
    data: { goal: { phase: "blocked", blockedReason: { code: "model-reported", message: "x" } }, roundsStarted: 2 },
  });
  onSessionEvent(session, { type: "goal/change", data: { goal: { phase: "complete" }, roundsStarted: 3 } });
  assert.deepEqual(emitted, [
    { event: "goal/state", phase: "active", roundsStarted: 1, sessionId },
    { event: "goal/state", phase: "paused", roundsStarted: 1, sessionId },
    { event: "goal/state", phase: "blocked", roundsStarted: 2, sessionId },
    { event: "goal/state", phase: "complete", roundsStarted: 3, sessionId },
  ]);

  // A clear tombstone ends the tracked goal instead of leaving the client stuck on `active`.
  emitted.length = 0;
  onSessionEvent(session, {
    type: "goal/change",
    data: { kind: "goal/change", version: 1, operation: "clear", cleared: { id: "g", revision: 5 }, clearedAt: 1 },
  });
  assert.deepEqual(emitted, [{ event: "goal/state", cleared: true, sessionId }]);

  // Continuation rounds keep their labels; the cap keeps the dedicated stop plus the blocked state.
  emitted.length = 0;
  onSessionEvent(session, { type: "user/message", data: { source: { kind: "goal", goalId: "g", revision: 1, round: 2 } } });
  onSessionEvent(session, {
    type: "goal/change",
    data: { goal: { phase: "blocked", blockedReason: { code: "round-limit", message: "x" } }, roundsStarted: 4 },
  });
  assert.deepEqual(emitted, [
    { event: "goal/round", round: 2, sessionId },
    { event: "goal/round-limit", round: 4, sessionId },
    { event: "goal/state", phase: "blocked", roundsStarted: 4, sessionId },
  ]);
});

test("bridge carries todo_write todos and shell commands on tool/start, and isError on tool/end", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { ctx, listeners, emitted } = createCtx();
  apply(ctx as never);
  const execute = listeners["tools/execute"]?.[0] as Execute;
  const ok = async (): Promise<ToolResult> => ({ isError: false, content: [{ type: "text", text: "ok" }] });
  const bad = async (): Promise<ToolResult> => ({ isError: true, content: [{ type: "text", text: "boom" }] });

  await execute(
    {
      name: "todo_write",
      callId: "t1",
      arguments: { todos: [{ content: "写报告", status: "in_progress" }, { content: "核对", status: "weird" }, { content: 3, status: "pending" }] },
    },
    ok,
  );
  await execute({ name: "bash", callId: "b1", arguments: { command: "pnpm test" } }, bad);

  const starts = emitted.filter((event) => (event as { event?: string }).event === "tool/start");
  assert.deepEqual(starts[0], {
    event: "tool/start",
    name: "todo_write",
    callId: "t1",
    todos: [{ content: "写报告", status: "in_progress" }],
  });
  assert.deepEqual(starts[1], { event: "tool/start", name: "bash", callId: "b1", command: "pnpm test" });
  const ends = emitted.filter((event) => (event as { event?: string }).event === "tool/end") as { isError?: boolean }[];
  assert.equal(ends[0]?.isError, undefined);
  assert.equal(ends[1]?.isError, true);
});

test("bridge reads failure markers from the uncapped shell result, past the 32 KiB head cap", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const { ctx, listeners, emitted } = createCtx();
  apply(ctx as never);
  const execute = listeners["tools/execute"]?.[0] as Execute;
  const text = (body: string) => async (): Promise<ToolResult> => ({ isError: false, content: [{ type: "text", text: body }] });

  await execute({ name: "bash", callId: "f1", arguments: { command: "pnpm test" } }, text("x".repeat(40 * 1024) + "\n[exit code: 1]"));
  await execute({ name: "bash", callId: "f2", arguments: { command: "pnpm lint" } }, text("fine\n[exit code: 0]"));
  await execute({ name: "read", callId: "f3", arguments: { path: "a.md" } }, text("quoted\n[exit code: 1]"));
  const ends = emitted.filter((event) => (event as { event?: string }).event === "tool/end") as { callId?: string; isError?: boolean }[];
  assert.equal(ends[0]?.isError, true);
  assert.equal(ends[1]?.isError, undefined);
  assert.equal(ends[2]?.isError, undefined);
});

test("bridge routes a known child's reasoning and text into the run projection only", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const runs = createRuns();
  const runId = registerChild(runs);
  const { ctx, listeners, emitted } = createCtx("/tmp/pinned", runs);
  apply(ctx as never);
  const wrap = listeners["llm/stream"]?.[0] as (
    options: { sessionId?: string; purpose?: string },
    next: () => AsyncIterable<StreamChunk>,
  ) => AsyncIterable<StreamChunk>;

  async function* reasoning() {
    yield { type: "reasoning-delta" as const, index: 0, text: "先想" };
    yield { type: "block-end" as const, index: 0, block: { type: "reasoning" as const, text: "先想" } };
  }
  const reasoningChunks: StreamChunk[] = [];
  for await (const chunk of wrap({ sessionId: CHILD_SESSION }, reasoning)) reasoningChunks.push(chunk);
  assert.equal(reasoningChunks.length, 2, "child chunks still pass through the stream unchanged");
  assert.equal(emitted.filter((event) => (event as { event?: string }).event === "reasoning").length, 0);
  assert.equal(runs.get(runId)?.phase, "reasoning");

  async function* answer() {
    yield { type: "text-delta" as const, index: 1, text: "答" };
    yield { type: "finish" as const, reason: { kind: "stop" } };
  }
  const answerChunks: StreamChunk[] = [];
  for await (const chunk of wrap({ sessionId: CHILD_SESSION }, answer)) answerChunks.push(chunk);
  assert.equal(answerChunks.length, 2);
  assert.equal(emitted.filter((event) => (event as { event?: string }).event === "token").length, 0);
  assert.equal(runs.get(runId)?.phase, "generating");
  assert.deepEqual(emitted, [], "a known child reaches the parent stream only through run projections");
});

test("bridge ends concurrent child tools by callId and emits no tool or diff events", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const root = mkdtempSync(join(tmpdir(), "huaanwork-bridge-child-tools-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q", "--template=/dev/null"], { cwd: root }).status, 0);
    writeFileSync(join(root, "brand-new.txt"), "hello from child\n");
    vi.mocked(spawnSync).mockClear();
    const runs = createRuns();
    const runId = registerChild(runs);
    const { ctx, listeners, emitted } = createCtx(root, runs);
    apply(ctx as never);
    const execute = listeners["tools/execute"]?.[0] as Execute;

    const first = deferred<ToolResult>();
    const second = deferred<ToolResult>();
    const firstRun = execute({ name: "git_diff", callId: "call-a", agent: childAgent }, () => first.promise);
    const secondRun = execute(
      { name: "write", callId: "call-b", arguments: { path: "x.txt", content: "y" }, agent: childAgent },
      () => second.promise,
    );
    assert.deepEqual(runs.get(runId)?.activeTools.map((tool) => tool.callId), ["call-a", "call-b"]);
    assert.equal(runs.get(runId)?.phase, "tool");

    first.resolve({
      isError: false,
      value: { stdout: "diff --git a/a.txt b/a.txt\n", stderr: "" },
      content: [{ type: "text", text: "diff --git a/a.txt b/a.txt\n" }],
    });
    const firstResult = await firstRun;
    assert.deepEqual(firstResult.content, [{ type: "text", text: "diff --git a/a.txt b/a.txt\n" }]);
    assert.deepEqual(runs.get(runId)?.activeTools.map((tool) => tool.callId), ["call-b"]);

    second.resolve({ isError: false, content: [{ type: "text", text: "ok" }] });
    const secondResult = await secondRun;
    assert.deepEqual(secondResult.content, [{ type: "text", text: "ok" }]);
    assert.deepEqual(runs.get(runId)?.activeTools, []);
    assert.equal(runs.get(runId)?.phase, "generating");

    assert.deepEqual(emitted, [], "child tools must not reach the parent stream as tool/start, tool/end or diff");
    assert.equal(vi.mocked(spawnSync).mock.calls.length, 0, "a child tool must not take a git snapshot");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed child tool stays a per-tool fact and does not decide the run", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const runs = createRuns();
  const runId = registerChild(runs);
  const { ctx, listeners, emitted } = createCtx("/tmp/pinned", runs);
  apply(ctx as never);
  const execute = listeners["tools/execute"]?.[0] as Execute;
  await execute({ name: "bash", callId: "call-fail", arguments: { command: "pnpm test" }, agent: childAgent }, async () => ({
    isError: true,
    content: [{ type: "text", text: "boom" }],
  }));
  assert.deepEqual(emitted, []);
  assert.deepEqual(runs.get(runId)?.activeTools, []);
  assert.equal(runs.get(runId)?.phase, "generating");
  assert.equal(runs.get(runId)?.failure, undefined);
  assert.equal(runs.get(runId)?.stopReason, undefined);
});

test("bridge keeps a known child's goal and compaction session events out of the parent stream", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const runs = createRuns();
  registerChild(runs);
  const { ctx, listeners, emitted } = createCtx("/tmp/pinned", runs);
  apply(ctx as never);
  const onSessionEvent = listeners["session/event"]?.[0] as (
    session: { id: string },
    event: { type: string; data?: unknown },
  ) => void;

  const child = { id: CHILD_SESSION };
  onSessionEvent(child, { type: "compaction/end", data: {} });
  onSessionEvent(child, { type: "user/message", data: { source: { kind: "goal", goalId: "g", revision: 1, round: 2 } } });
  onSessionEvent(child, { type: "goal/change", data: { goal: { phase: "active" }, roundsStarted: 1 } });
  onSessionEvent(child, { type: "goal/change", data: { operation: "clear" } });
  onSessionEvent(child, {
    type: "goal/change",
    data: { goal: { phase: "blocked", blockedReason: { code: "round-limit", message: "x" } }, roundsStarted: 3 },
  });
  assert.deepEqual(emitted, [], "child goal and compaction projections must not reach the parent session");

  onSessionEvent({ id: PARENT_SESSION }, { type: "goal/change", data: { goal: { phase: "active" }, roundsStarted: 1 } });
  assert.deepEqual(emitted, [{ event: "goal/state", phase: "active", roundsStarted: 1, sessionId: PARENT_SESSION }]);
});

test("bridge projects a known child's idle as finalizing while the parent idle still ends the turn", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const runs = createRuns();
  const runId = registerChild(runs);
  const { ctx, listeners, emitted } = createCtx("/tmp/pinned", runs);
  apply(ctx as never);
  const status = listeners["agent/status"]?.[0] as (payload: { status: string; agent?: { session?: { id?: string } } }) => void;

  status({ status: "idle", agent: childAgent });
  assert.equal(runs.get(runId)?.phase, "finalizing");
  assert.equal(emitted.filter((event) => (event as { event?: string }).event === "session/end").length, 0);

  status({ status: "idle", agent: parentAgent });
  assert.deepEqual(
    emitted.filter((event) => (event as { event?: string }).event === "session/end"),
    [{ event: "session/end", ok: true, sessionId: PARENT_SESSION }],
  );
});

test("bridge records a cleaned child error without ending the turn or failing the run", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const runs = createRuns();
  const runId = registerChild(runs);
  const { ctx, listeners, emitted } = createCtx("/tmp/pinned", runs);
  apply(ctx as never);
  const error = listeners["agent/error"]?.[0] as (payload: { error: unknown; agent?: { session?: { id?: string } } }) => void;

  error({
    error: Object.assign(new Error("HuaAnWork model request aborted by caller"), { code: "ABORTED" }),
    agent: childAgent,
  });
  assert.deepEqual(emitted, [], "a child abort must not end the parent turn");

  const noisy = new Error(`child failed\n    at handler (/tmp/x.ts:1:1)\n    at run (/tmp/x.ts:2:2) ${"detail ".repeat(80)}`);
  error({ error: noisy, agent: childAgent });
  assert.equal(emitted.filter((event) => (event as { event?: string }).event === "session/end").length, 0);
  assert.equal(runs.get(runId)?.phase, "starting", "a child error must not change the run phase");
  assert.equal(runs.get(runId)?.failure, undefined);

  // 只有权威 result 决定终态;错误文案此时才作为原因出现,且已折行并截断。
  runs.settleResult(runId, { stopReason: "error" });
  const failure = runs.get(runId)?.failure ?? "";
  assert.equal(failure.includes("\n"), false);
  assert.equal(failure.length, 200);
  assert.match(failure, /^child failed at handler \(\/tmp\/x\.ts:1:1\) at run \(\/tmp\/x\.ts:2:2\) detail /);
});

test("bridge keeps an unregistered session unchanged while a registry is present", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/bridge.ts");
  const runs = createRuns();
  const runId = registerChild(runs);
  const { ctx, listeners, emitted } = createCtx("/tmp/pinned", runs);
  apply(ctx as never);

  const wrap = listeners["llm/stream"]?.[0] as (
    options: { sessionId?: string },
    next: () => AsyncIterable<StreamChunk>,
  ) => AsyncIterable<StreamChunk>;
  async function* ordinary() {
    yield { type: "reasoning-delta" as const, index: 0, text: "想" };
    yield { type: "block-end" as const, index: 0, block: { type: "reasoning" as const, text: "想" } };
    yield { type: "text-delta" as const, index: 1, text: "答" };
  }
  for await (const _chunk of wrap({ sessionId: PARENT_SESSION }, ordinary)) {
    // drain
  }
  assert.deepEqual(emitted, [
    { event: "reasoning", text: "想", sessionId: PARENT_SESSION },
    { event: "reasoning", text: "想", sessionId: PARENT_SESSION, final: true },
    { event: "token", text: "答", sessionId: PARENT_SESSION },
  ]);

  emitted.length = 0;
  const execute = listeners["tools/execute"]?.[0] as Execute;
  await execute({ name: "read", callId: "call-parent", arguments: { path: "a.md" }, agent: parentAgent }, async () => ({
    isError: false,
    content: [{ type: "text", text: "ok" }],
  }));
  assert.deepEqual(emitted, [
    { event: "tool/start", name: "read", callId: "call-parent", sessionId: PARENT_SESSION },
    { event: "tool/end", name: "read", callId: "call-parent", sessionId: PARENT_SESSION },
  ]);

  emitted.length = 0;
  const status = listeners["agent/status"]?.[0] as (payload: { status: string; agent?: { session?: { id?: string } } }) => void;
  status({ status: "idle", agent: parentAgent });
  assert.deepEqual(emitted, [{ event: "session/end", ok: true, sessionId: PARENT_SESSION }]);
  assert.equal(runs.get(runId)?.phase, "starting", "parent activity must not touch the child run");
});
