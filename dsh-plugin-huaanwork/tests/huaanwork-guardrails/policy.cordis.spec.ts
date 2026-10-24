import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, test, vi } from "vitest";
import { readGuardMode, writeUnattendedAudit } from "../../src/huaanwork-guardrails/policy.ts";

// F-2 pin(2026-10-16 裁定):透明包装 spawnSync 以便计数,实际执行仍走原实现,
// 本文件既有用例(含 git init)行为不变。
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

import {
  guard as policyGuard,
  REASON_NEEDS_APPROVAL,
  REASON_PATH_ESCAPE,
  REASON_SHELL_HARD_DENY,
  reasonToolUnattached,
} from "@huaanwork/policy";
import { attachHostTool, attachAgentTools, emptyAttachments, isHostAttached } from "../../src/huaanwork-guardrails/agent-attachments.ts";

/** bundle 给判定原因加的前缀（policy.ts）：pre-execute deny / guard deny。 */
const POLICY = (reason: string) => `huaanwork-policy: ${reason}`;
const GUARD = (reason: string) => `huaanwork-guard: ${reason}`;
const GUARD_NEEDS_APPROVAL = GUARD(REASON_NEEDS_APPROVAL);

type PreExecute = (
  execution: {
    name: string;
    arguments: Record<string, unknown>;
    agent?: { id?: string; session?: { id?: string } };
    callId?: string;
  },
  next: () => Promise<{ kind: "allow" }>,
) => Promise<{ kind: string; reason?: string }>;

test("policy plugin lets pre-execute approval calls through its Cordis guard", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  let preExecute: PreExecute | undefined;
  let guard:
    | ((execution: { name: string; arguments: Record<string, unknown>; callId?: string }) => string | undefined)
    | undefined;

  apply({
    huaanworkWorkspaceRoot: { current: process.cwd() },
    on(event: string, listener: PreExecute) {
      if (event === "tools/pre-execute") preExecute = listener;
    },
    tools: {
      guard(listener: typeof guard) {
        guard = listener;
        return () => undefined;
      },
    },
  });

  assert.deepEqual(await preExecute?.({ name: "git_push", arguments: {} }, async () => ({ kind: "allow" })), {
    kind: "ask",
  });
  assert.deepEqual(await preExecute?.({ name: "web_search", arguments: {} }, async () => ({ kind: "allow" })), {
    kind: "deny",
    reason: POLICY(reasonToolUnattached("web_search")),
  });
  assert.deepEqual(
    await preExecute?.({ name: "read", arguments: { path: "../escape.txt" } }, async () => ({ kind: "allow" })),
    { kind: "deny", reason: POLICY(REASON_PATH_ESCAPE) },
  );
  assert.equal(guard?.({ name: "git_push", arguments: {}, callId: "unapproved" }), GUARD_NEEDS_APPROVAL);
  assert.equal(guard?.({ name: "web_search", arguments: {} }), GUARD(reasonToolUnattached("web_search")));
  assert.equal(guard?.({ name: "read", arguments: { path: "../escape.txt" } }), GUARD(REASON_PATH_ESCAPE));
});

test("policy plugin asks before checking out a dirty workspace", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  const workspaceRoot = mkdtempSync(join(tmpdir(), "huaanwork-policy-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q", "--template=/dev/null"], { cwd: workspaceRoot }).status, 0);
    writeFileSync(join(workspaceRoot, "dirty.txt"), "dirty\n");

    let preExecute: PreExecute | undefined;
    let guard: ((execution: { name: string; arguments: Record<string, unknown> }) => string | undefined) | undefined;
    apply({
      huaanworkWorkspaceRoot: { current: workspaceRoot },
      on(event: string, listener: PreExecute) {
        if (event === "tools/pre-execute") preExecute = listener;
      },
      tools: {
        guard(listener: typeof guard) {
          guard = listener;
          return () => undefined;
        },
      },
    });

    const checkout = { name: "git_checkout", arguments: {}, callId: "dirty-checkout" };
    assert.deepEqual(await preExecute?.(checkout, async () => ({ kind: "allow" })), { kind: "ask" });
    assert.equal(guard?.(checkout), GUARD_NEEDS_APPROVAL);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("policy plugin treats a non-repo workspace as clean for git_checkout", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  const workspaceRoot = mkdtempSync(join(tmpdir(), "huaanwork-policy-"));
  try {
    let preExecute: PreExecute | undefined;
    let guard: ((execution: { name: string; arguments: Record<string, unknown> }) => string | undefined) | undefined;
    apply({
      huaanworkWorkspaceRoot: { current: workspaceRoot },
      on(event: string, listener: PreExecute) {
        if (event === "tools/pre-execute") preExecute = listener;
      },
      tools: {
        guard(listener: typeof guard) {
          guard = listener;
          return () => undefined;
        },
      },
    });

    const checkout = { name: "git_checkout", arguments: {} };
    assert.deepEqual(await preExecute?.(checkout, async () => ({ kind: "allow" })), { kind: "allow" });
    assert.equal(guard?.(checkout), undefined);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("policy plugin probes git status only for git_checkout (F-2 narrowing pin)", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  const workspaceRoot = mkdtempSync(join(tmpdir(), "huaanwork-policy-probe-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q", "--template=/dev/null"], { cwd: workspaceRoot }).status, 0);
    writeFileSync(join(workspaceRoot, "dirty.txt"), "dirty\n");

    let preExecute: PreExecute | undefined;
    apply({
      huaanworkWorkspaceRoot: { current: workspaceRoot },
      on(event: string, listener: PreExecute) {
        if (event === "tools/pre-execute") preExecute = listener;
      },
      tools: {
        guard() {
          return () => undefined;
        },
      },
    });

    const statusProbes = () =>
      vi
        .mocked(spawnSync)
        .mock.calls.filter(([command, argv]) => command === "git" && Array.isArray(argv) && argv[0] === "status")
        .length;

    vi.mocked(spawnSync).mockClear();
    // 非 checkout 工具在脏仓库下:判定照常放行,且零 git status 探测。
    assert.deepEqual(
      await preExecute?.({ name: "read", arguments: { path: "dirty.txt" } }, async () => ({ kind: "allow" })),
      { kind: "allow" },
    );
    assert.equal(statusProbes(), 0);

    // git_checkout:恰好探测一次,脏树判定仍是 ask——与上一条共同钉死
    // 收窄与原语义在所有可达判定上等价(2026-10-16 裁定「保留收窄」)。
    assert.deepEqual(
      await preExecute?.({ name: "git_checkout", arguments: {} }, async () => ({ kind: "allow" })),
      { kind: "ask" },
    );
    assert.equal(statusProbes(), 1);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("isGitDirty bounds the blocking git status probe", async () => {
  const { isGitDirty } = await import("../../src/huaanwork-guardrails/policy.ts");
  vi.mocked(spawnSync).mockClear();
  isGitDirty(process.cwd());
  const calls = vi.mocked(spawnSync).mock.calls;
  assert.equal(calls.length, 1, "the probe issues exactly one git status call");
  const [command, argv, options] = calls[0]!;
  assert.equal(command, "git");
  assert.deepEqual(argv, ["status", "--porcelain"]);
  assert.equal(typeof options?.timeout, "number", "without a timeout a big tree can stall the Host loop");
  assert.ok((options?.timeout ?? 0) > 0 && (options?.timeout ?? 0) <= 1_500);
});

test("isGitDirty fails closed when the status probe times out or has no exit status", async () => {
  const { isGitDirty } = await import("../../src/huaanwork-guardrails/policy.ts");
  const mocked = vi.mocked(spawnSync);
  mocked.mockClear();
  // spawnSync reports a timeout as status: null plus an ETIMEDOUT error. Treating
  // that as clean would let a dirty git_checkout skip the ask in smart/ask modes.
  mocked.mockReturnValueOnce({
    pid: 1,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: null,
    signal: "SIGTERM",
    error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }),
  } as never);
  assert.equal(isGitDirty(process.cwd()), true, "a timed-out status is unknown, not clean");

  // No error object but still no exit status (e.g. killed by a signal we did not set).
  mocked.mockReturnValueOnce({
    pid: 1,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: null,
    signal: "SIGKILL",
  } as never);
  assert.equal(isGitDirty(process.cwd()), true, "an unknown status fails closed");

  // The pre-existing not-installed fallback stays clean: there is no repository to protect.
  mocked.mockReturnValueOnce({
    pid: 0,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: null,
    signal: null,
    error: Object.assign(new Error("spawnSync git ENOENT"), { code: "ENOENT" }),
  } as never);
  assert.equal(isGitDirty(process.cwd()), false, "git not installed keeps the clean fallback");
});

test("Cordis guard allows git_push once after allowed-once and denies without approve", async () => {
  const { apply: applyPolicy } = await import("../../src/huaanwork-guardrails/policy.ts");
  const { apply: applyApproval } = await import("../../src/huaanwork-guardrails/approval.ts");
  let guard:
    | ((execution: { name: string; arguments: Record<string, unknown>; callId?: string }) => string | undefined)
    | undefined;
  let answerer:
    | ((request: { agent: unknown; toolName: string; callId?: string }, next: () => Promise<string>) => Promise<string>)
    | undefined;
  const approvals = new Map<string, (result: string) => void>();
  const events: unknown[] = [];
  let executions = 0;

  const ctx = {
    huaanworkWorkspaceRoot: { current: process.cwd() },
    huaanworkApprovals: approvals,
    huaanworkEmit(event: unknown) {
      events.push(event);
    },
    on(event: string, listener: unknown) {
      if (event === "tools/pre-execute") return;
      if (event === "approval/request") answerer = listener as typeof answerer;
    },
    tools: {
      guard(listener: typeof guard) {
        guard = listener;
        return () => undefined;
      },
      async execute(execution: { name: string; arguments: Record<string, unknown>; callId?: string }) {
        const reason = guard?.(execution);
        if (reason) return { isError: true as const, error: { message: reason } };
        executions += 1;
        return { isError: false as const };
      },
    },
  };

  applyPolicy(ctx as never);
  applyApproval(ctx as never);

  assert.equal(guard?.({ name: "git_push", arguments: {}, callId: "without-approve" }), GUARD_NEEDS_APPROVAL);
  assert.deepEqual(await ctx.tools.execute({ name: "git_push", arguments: {}, callId: "without-approve" }), {
    isError: true,
    error: { message: GUARD_NEEDS_APPROVAL },
  });
  assert.equal(executions, 0);

  const pending = answerer?.({ agent: {}, toolName: "git_push", callId: "with-approve" }, async () => "unavailable");
  await new Promise((resolve) => setImmediate(resolve));
  const [event] = events as [{ approvalRequestId: string }];
  approvals.get(event.approvalRequestId)?.("allowed-once");
  assert.equal(await pending, "allowed-once");
  assert.deepEqual(await ctx.tools.execute({ name: "git_push", arguments: {}, callId: "with-approve" }), {
    isError: false,
  });
  assert.equal(executions, 1);
  assert.deepEqual(await ctx.tools.execute({ name: "git_push", arguments: {}, callId: "with-approve" }), {
    isError: true,
    error: { message: GUARD_NEEDS_APPROVAL },
  });
  assert.equal(executions, 1);
  assert.equal(policyGuard({ name: "git_push", args: {}, workspaceRoot: process.cwd() }), "deny");
});

test("pure guard() still denies git_push", () => {
  assert.equal(policyGuard({ name: "git_push", args: {}, workspaceRoot: process.cwd() }), "deny");
});

// —— Phase 2（方案 A）：无人值守授权的 pre-execute 降级 ——

function applyPolicyWithUnattended(ctx: Record<string, unknown>) {
  const preExecuteListeners: PreExecute[] = [];
  let guard: ((execution: { name: string; arguments: Record<string, unknown>; callId?: string }) => string | undefined) | undefined;
  const merged = {
    huaanworkWorkspaceRoot: { current: process.cwd() },
    ...ctx,
    on(event: string, listener: PreExecute) {
      if (event === "tools/pre-execute") preExecuteListeners.push(listener);
    },
    tools: {
      guard(listener: typeof guard) {
        guard = listener;
        return () => undefined;
      },
    },
  };
  return {
    ctx: merged,
    preExecute: (execution: Parameters<PreExecute>[0]) =>
      preExecuteListeners[0]?.(execution, async () => ({ kind: "allow" })),
    guard: (execution: { name: string; arguments: Record<string, unknown>; callId?: string }) => guard?.(execution),
  };
}

test("unattended off (ctx.huaanworkUnattended.current unset): ask path is byte-for-byte identical to baseline", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  const allowedOnce = new Set<string>();
  const harness = applyPolicyWithUnattended({ huaanworkAllowedOnce: allowedOnce });
  apply(harness.ctx as never);

  const call = { name: "git_push", arguments: {}, callId: "call-off" };
  assert.deepEqual(await harness.preExecute(call), { kind: "ask" });
  assert.equal(harness.guard(call), GUARD_NEEDS_APPROVAL);
  assert.equal(allowedOnce.size, 0);
});

test("unattended holder in its boot shape (current: null): ask path is unchanged", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  const allowedOnce = new Set<string>();
  // holders.ts 装容器的初始值就是 null（既不是 undefined 也不是缺席）：类型必须如实
  // 写 `UnattendedScope | null`，运行时也必须与「未启用」逐字节同路径。
  const harness = applyPolicyWithUnattended({
    huaanworkAllowedOnce: allowedOnce,
    huaanworkUnattended: { current: null },
  });
  apply(harness.ctx as never);

  const call = { name: "git_push", arguments: {}, callId: "call-boot-null" };
  assert.deepEqual(await harness.preExecute(call), { kind: "ask" });
  assert.equal(harness.guard(call), GUARD_NEEDS_APPROVAL);
  assert.equal(allowedOnce.size, 0);
});

test("unattended enabled and callId's tool is in allow: pre-execute degrades ask to allow, callId enters allowedOnce, guard passes, and an audit line is written", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  // decide() 按平台把 shell 工具二选一(win32 → pwsh,其余 → bash),硬编码 bash 在 Windows CI 会被平台规则先拒。
  const shellName = process.platform === "win32" ? "pwsh" : "bash";
  const profileDir = mkdtempSync(join(tmpdir(), "huaanwork-policy-audit-"));
  try {
    const allowedOnce = new Set<string>();
    const harness = applyPolicyWithUnattended({
      huaanworkAllowedOnce: allowedOnce,
      huaanworkProfileDir: profileDir,
      huaanworkUnattended: {
        current: {
          runId: "run-1",
          automationId: "auto-1",
          allow: new Set([shellName]),
          sessionId: "huaanwork-auto-auto-1-run-1",
        },
      },
    });
    apply(harness.ctx as never);

    const call = { name: shellName, arguments: { command: "ls -la" }, callId: "call-1" };
    assert.deepEqual(await harness.preExecute(call), { kind: "allow" });
    assert.ok(allowedOnce.has("call-1"), "callId must be recorded in huaanworkAllowedOnce");
    assert.equal(harness.guard(call), undefined, "guard() must pass the degraded callId through unchanged");
    assert.equal(allowedOnce.has("call-1"), false, "guard()'s existing delete branch consumes the one-time entry");

    const auditText = readFileSync(join(profileDir, "automations", "auto-1.audit.jsonl"), "utf8").trim();
    const [line, ...rest] = auditText.split("\n");
    assert.equal(rest.length, 0);
    const entry = JSON.parse(line) as Record<string, unknown>;
    assert.equal(entry.runId, "run-1");
    assert.equal(entry.sessionId, "huaanwork-auto-auto-1-run-1");
    assert.equal(entry.tool, shellName);
    assert.equal(entry.callId, "call-1");
    assert.equal(entry.decision, "ask→allow");
    assert.equal(typeof entry.at, "number");
    assert.equal(Object.hasOwn(entry, "arguments"), false, "audit line must not contain tool argument payloads");
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("audit file caps retained lines and trims the oldest ones on append (review finding 4)", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  const profileDir = mkdtempSync(join(tmpdir(), "huaanwork-policy-audit-cap-"));
  try {
    const auditPath = join(profileDir, "automations", "auto-cap.audit.jsonl");
    // 预先塞入 60 行审计记录（超过 50 行上限），模拟一个长期运行、积累了大量降级记录的任务。
    const seeded = Array.from({ length: 60 }, (_, index) =>
      JSON.stringify({ at: index, runId: `seed-${index}`, tool: "bash", callId: `seed-call-${index}`, decision: "ask→allow" }),
    );
    mkdirSync(join(profileDir, "automations"), { recursive: true });
    writeFileSync(auditPath, `${seeded.join("\n")}\n`, "utf8");

    const allowedOnce = new Set<string>();
    const shellName = process.platform === "win32" ? "pwsh" : "bash";
    const harness = applyPolicyWithUnattended({
      huaanworkAllowedOnce: allowedOnce,
      huaanworkProfileDir: profileDir,
      huaanworkUnattended: {
        current: { runId: "run-cap", automationId: "auto-cap", allow: new Set([shellName]) },
      },
    });
    apply(harness.ctx as never);

    const call = { name: shellName, arguments: { command: "ls -la" }, callId: "call-cap" };
    assert.deepEqual(await harness.preExecute(call), { kind: "allow" });

    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 50, "audit file must be capped at 50 lines, same order of magnitude as RUNS_LIMIT");
    const oldest = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(oldest.runId, "seed-11", "the 11 oldest seeded lines must be trimmed to make room for the cap");
    const newest = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    assert.equal(newest.callId, "call-cap", "the newly-written line must be the last (most recent) line");
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("unattended enabled but tool is outside allow: pre-execute still returns ask, guard still denies", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  const allowedOnce = new Set<string>();
  const harness = applyPolicyWithUnattended({
    huaanworkAllowedOnce: allowedOnce,
    huaanworkUnattended: { current: { runId: "run-2", automationId: "auto-2", allow: new Set(["read"]) } },
  });
  apply(harness.ctx as never);

  const call = { name: "git_push", arguments: {}, callId: "call-outside" };
  assert.deepEqual(await harness.preExecute(call), { kind: "ask" });
  assert.equal(harness.guard(call), GUARD_NEEDS_APPROVAL);
  assert.equal(allowedOnce.size, 0);
});

test("run_code stays denied regardless of unattended (present-as already rejects code mode; this is the second insurance)", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  const allowedOnce = new Set<string>();
  // 即便 allow 集合里混进了 run_code（正常情况下 normalize 早已剔除），decide.ts 对
  // run_code 的判定是 "deny"（不是 "ask"），永远不会进入降级分支。
  const harness = applyPolicyWithUnattended({
    huaanworkAllowedOnce: allowedOnce,
    huaanworkUnattended: { current: { runId: "run-3", automationId: "auto-3", allow: new Set(["run_code"]) } },
  });
  apply(harness.ctx as never);

  const call = { name: "run_code", arguments: {}, callId: "call-run-code" };
  assert.deepEqual(await harness.preExecute(call), {
    kind: "deny",
    reason: POLICY(reasonToolUnattached("run_code")),
  });
  assert.equal(harness.guard(call), GUARD(reasonToolUnattached("run_code")));
  assert.equal(allowedOnce.size, 0);
});

test("unattended degrade without callId does not enter allowedOnce and falls back to ask (guard cannot safely consume it)", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  const shellName = process.platform === "win32" ? "pwsh" : "bash";
  const allowedOnce = new Set<string>();
  const harness = applyPolicyWithUnattended({
    huaanworkAllowedOnce: allowedOnce,
    huaanworkUnattended: { current: { runId: "run-4", automationId: "auto-4", allow: new Set([shellName]) } },
  });
  apply(harness.ctx as never);

  const call = { name: shellName, arguments: { command: "ls -la" } }; // no callId
  assert.deepEqual(await harness.preExecute(call), { kind: "ask" });
  assert.equal(allowedOnce.size, 0);
});

test("invariant 4: with an active unattended scope, guard() alone still denies a would-be-ask call when pre-execute is stripped (never registered/invoked)", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  const allowedOnce = new Set<string>();
  // Active unattended scope whose allow includes ask-class tools — same shape a real
  // automation run would set on ctx.huaanworkUnattended.current. The degrade only ever
  // happens inside the tools/pre-execute handler (it's the only place that writes to
  // huaanworkAllowedOnce); if a boot-overlay strips/never wires up pre-execute, guard()
  // must still fall back to its own decide()-based deny — it can never express "ask" and
  // must never independently consult ctx.huaanworkUnattended.
  const shellName = process.platform === "win32" ? "pwsh" : "bash";
  const harness = applyPolicyWithUnattended({
    huaanworkAllowedOnce: allowedOnce,
    huaanworkUnattended: {
      current: { runId: "run-5", automationId: "auto-5", allow: new Set(["git_push", shellName]) },
    },
  });
  apply(harness.ctx as never);

  // Deliberately never call harness.preExecute(...) — simulates pre-execute being
  // stripped by a boot-overlay patch. Only tools.guard() is exercised.
  const gitCall = { name: "git_push", arguments: {}, callId: "call-stripped-git" };
  assert.equal(harness.guard(gitCall), GUARD_NEEDS_APPROVAL);

  const bashCall = { name: shellName, arguments: { command: "ls -la" }, callId: "call-stripped-bash" };
  assert.equal(harness.guard(bashCall), GUARD_NEEDS_APPROVAL);

  assert.equal(allowedOnce.size, 0, "guard() alone must never populate huaanworkAllowedOnce");
});

test("approval plugin emits a bridge request and waits for host approval", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/approval.ts");
  let answerer:
    | ((request: { agent: unknown; toolName: string; callId?: string }, next: () => Promise<string>) => Promise<string>)
    | undefined;
  const approvals = new Map<string, (result: string) => void>();
  const events: unknown[] = [];

  apply({
    huaanworkApprovals: approvals,
    huaanworkEmit(event: unknown) {
      events.push(event);
    },
    on(event: string, listener: typeof answerer) {
      if (event === "approval/request") answerer = listener;
    },
  });

  const pending = answerer?.({ agent: {}, toolName: "git_push", callId: "call-1" }, async () => "unavailable");
  await new Promise((resolve) => setImmediate(resolve));
  const [event] = events as [{ event: string; approvalRequestId: string; toolName: string; callId: string }];
  assert.equal(event.event, "approval/asked");
  assert.equal(event.toolName, "git_push");
  assert.equal(event.callId, "call-1");
  approvals.get(event.approvalRequestId)?.("allowed-once");
  assert.equal(await pending, "allowed-once");
});

test("presentation plugin rejects code mode and preserves native mode", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/present-as.ts");
  const events: unknown[] = [];
  let mode: string | undefined;

  const tools = {
    presentAs(nextMode: string) {
      mode = nextMode;
      return () => undefined;
    },
  };
  apply({
    huaanworkEmit(event: unknown) {
      events.push(event);
    },
    tools,
    on() {
      return undefined;
    },
  });

  assert.doesNotThrow(() => tools.presentAs("native"));
  assert.equal(mode, "native");
  assert.throws(() => tools.presentAs("ptc"), /disabled/i);
  assert.deepEqual(events, [], "a disabled global presentation must not emit an unscoped session/end");
});

test("presentation plugin restricts the main agent's scoped tools and detects run_code", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/present-as.ts");
  const disabledNames = ["web_search", "run_code"];
  const allSchemas = [
    { name: "read" },
    { name: "git_status" },
    ...disabledNames.map((name) => ({ name })),
  ];
  let visibleSchemas = allSchemas;
  let preStep: ((event: { agent: { ctx: { get(name: string): unknown }; cancel(reason: unknown): void } }) => unknown) | undefined;
  let cancelled = false;
  const scopedTools = {
    schemas: () => visibleSchemas,
    restrict({ allow }: { allow: readonly string[] }) {
      visibleSchemas = allSchemas.filter((schema) => allow.includes(schema.name ?? ""));
      return () => undefined;
    },
  };
  const agent = {
    ctx: { get: (name: string) => (name === "tools" ? scopedTools : undefined) },
    cancel: () => {
      cancelled = true;
    },
  };

  apply({
    tools: {
      presentAs: () => () => undefined,
    },
    agents: {
      list: () => [agent],
    },
    on(event: string, listener: unknown) {
      if (event === "agent/pre-step") preStep = listener as typeof preStep;
    },
  } as never);

  assert.deepEqual(
    visibleSchemas.map((schema) => schema.name),
    ["read", "git_status"],
  );
  const codeAgent = {
    ctx: {
      get: (name: string) =>
        name === "tools"
          ? { schemas: () => [{ name: "run_code" }], restrict: () => () => undefined }
          : undefined,
    },
    cancel: () => {
      cancelled = true;
    },
  };
  assert.deepEqual(preStep?.({ agent: codeAgent as never }), { kind: "reject" });
  assert.equal(cancelled, true);
});

test("presentation plugin gives ALLOWED_TOOLS to legacy chat agent", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/present-as.ts");
  const allSchemas = [{ name: "read" }, { name: "bash" }, { name: "git_status" }];
  let visibleSchemas = allSchemas;
  const scopedTools = {
    schemas: () => visibleSchemas,
    restrict({ allow }: { allow: readonly string[] }) {
      visibleSchemas = allSchemas.filter((schema) => allow.includes(schema.name ?? ""));
      return () => undefined;
    },
  };
  const chatAgent = {
    id: "huaanwork-chat",
    ctx: { get: (name: string) => (name === "tools" ? scopedTools : undefined) },
  };

  apply({
    tools: { presentAs: () => () => undefined },
    agents: { list: () => [chatAgent] },
    on() {
      return undefined;
    },
  } as never);

  assert.deepEqual(
    visibleSchemas.map((schema) => schema.name),
    ["read", "bash", "git_status"],
  );
});

// —— 护栏三档模式：settings.json 直读 + seam fail-closed ——

function applyPolicyWithHome(profileDir: string | undefined) {
  const preExecuteListeners: PreExecute[] = [];
  let guard:
    | ((execution: { name: string; arguments: Record<string, unknown>; callId?: string }) => string | undefined)
    | undefined;
  const ctx = {
    huaanworkWorkspaceRoot: { current: process.cwd() },
    ...(profileDir === undefined ? {} : { huaanworkProfileDir: profileDir }),
    on(event: string, listener: PreExecute) {
      if (event === "tools/pre-execute") preExecuteListeners.push(listener);
    },
    tools: {
      guard(listener: typeof guard) {
        guard = listener;
        return () => undefined;
      },
    },
  };
  return {
    ctx,
    preExecute: (execution: Parameters<PreExecute>[0]) =>
      preExecuteListeners[0]?.(execution, async () => ({ kind: "allow" })),
    guard: (execution: { name: string; arguments: Record<string, unknown>; callId?: string }) => guard?.(execution),
  };
}

test("bundle policy reads guard_mode per call, falls back to ask, and switches mid-session", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  const profileDir = mkdtempSync(join(tmpdir(), "huaanwork-guard-mode-"));
  const settingsPath = join(profileDir, "huaanwork-settings.json");
  try {
    // 缺失 settings.json → ask 语义：git_push pre-execute ask、guard deny
    const missing = applyPolicyWithHome(profileDir);
    apply(missing.ctx as never);
    const push = { name: "git_push", arguments: {}, callId: "p1" };
    assert.deepEqual(await missing.preExecute(push), { kind: "ask" });
    assert.equal(missing.guard(push), GUARD_NEEDS_APPROVAL);

    // full → pre-execute 放行，guard 无 allowedOnce 也放行；硬 deny 仍拦
    writeFileSync(settingsPath, JSON.stringify({ guard_mode: "full" }));
    const full = applyPolicyWithHome(profileDir);
    apply(full.ctx as never);
    assert.deepEqual(await full.preExecute(push), { kind: "allow" });
    assert.equal(full.guard({ name: "git_push", arguments: {}, callId: "p2" }), undefined);
    const shellName = process.platform === "win32" ? "pwsh" : "bash";
    assert.deepEqual(
      await full.preExecute({ name: shellName, arguments: { command: "echo x && rm -rf y" } }),
      { kind: "deny", reason: POLICY(REASON_SHELL_HARD_DENY) },
    );

    // smart → git_push 仍 ask、guard deny；git_commit 放行
    writeFileSync(settingsPath, JSON.stringify({ guard_mode: "smart" }));
    const smart = applyPolicyWithHome(profileDir);
    apply(smart.ctx as never);
    assert.deepEqual(await smart.preExecute(push), { kind: "ask" });
    assert.equal(smart.guard(push), GUARD_NEEDS_APPROVAL);
    assert.deepEqual(await smart.preExecute({ name: "git_commit", arguments: {} }), { kind: "allow" });

    // 中途切档即时生效：同一 harness 下改写 settings.json，下一个调用即用新档（双向）
    writeFileSync(settingsPath, JSON.stringify({ guard_mode: "full" }));
    assert.deepEqual(await smart.preExecute(push), { kind: "allow" });
    writeFileSync(settingsPath, JSON.stringify({ guard_mode: "ask" }));
    assert.deepEqual(await smart.preExecute(push), { kind: "ask" });
    // 非法值回落 ask
    writeFileSync(settingsPath, JSON.stringify({ guard_mode: "bypass" }));
    assert.deepEqual(await smart.preExecute(push), { kind: "ask" });
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("guard is fail-closed for would-be-ask calls in every mode", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  const profileDir = mkdtempSync(join(tmpdir(), "huaanwork-guard-failclosed-"));
  const settingsPath = join(profileDir, "huaanwork-settings.json");
  const shellName = process.platform === "win32" ? "pwsh" : "bash";
  try {
    // ask 档：普通命令 pre-execute ask → guard 无核销即 deny
    writeFileSync(settingsPath, JSON.stringify({ guard_mode: "ask" }));
    const askHarness = applyPolicyWithHome(profileDir);
    apply(askHarness.ctx as never);
    const plain = { name: shellName, arguments: { command: "ls -la" }, callId: "fc-ask" };
    assert.deepEqual(await askHarness.preExecute(plain), { kind: "ask" });
    assert.equal(askHarness.guard(plain), GUARD_NEEDS_APPROVAL);

    // smart 档：高危命令 pre-execute ask → guard 无核销即 deny
    writeFileSync(settingsPath, JSON.stringify({ guard_mode: "smart" }));
    const smartHarness = applyPolicyWithHome(profileDir);
    apply(smartHarness.ctx as never);
    const risky = { name: shellName, arguments: { command: "git push" }, callId: "fc-smart" };
    assert.deepEqual(await smartHarness.preExecute(risky), { kind: "ask" });
    assert.equal(smartHarness.guard(risky), GUARD_NEEDS_APPROVAL);

    // full 档：硬 deny 经 guard 仍 deny
    writeFileSync(settingsPath, JSON.stringify({ guard_mode: "full" }));
    const fullHarness = applyPolicyWithHome(profileDir);
    apply(fullHarness.ctx as never);
    const catastrophic = { name: shellName, arguments: { command: "echo x && rm -rf y" }, callId: "fc-full" };
    assert.deepEqual(await fullHarness.preExecute(catastrophic), {
      kind: "deny",
      reason: POLICY(REASON_SHELL_HARD_DENY),
    });
    assert.equal(fullHarness.guard(catastrophic), GUARD(REASON_SHELL_HARD_DENY));
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("toToolCall is fail-closed without execution.agent", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  const attachments = emptyAttachments();
  attachHostTool(attachments, "work-a", "pdf-extract");

  let preExecute: PreExecute | undefined;
  let guard:
    | ((execution: {
        name: string;
        arguments: Record<string, unknown>;
        agent?: { id?: string; session?: { id?: string } };
        callId?: string;
      }) => string | undefined)
    | undefined;

  apply({
    huaanworkWorkspaceRoot: { current: process.cwd() },
    huaanworkAttachments: attachments,
    on(event: string, listener: PreExecute) {
      if (event === "tools/pre-execute") preExecute = listener;
    },
    tools: {
      guard(listener: typeof guard) {
        guard = listener;
        return () => undefined;
      },
    },
  });

  const withoutAgent = { name: "call_host_tool", arguments: { name: "pdf-extract" } };
  assert.deepEqual(await preExecute?.(withoutAgent, async () => ({ kind: "allow" })), {
    kind: "deny",
    reason: POLICY(reasonToolUnattached("call_host_tool")),
  });
  assert.equal(guard?.(withoutAgent), GUARD(reasonToolUnattached("call_host_tool")));

  const sessionA = {
    name: "call_host_tool",
    arguments: { name: "pdf-extract" },
    agent: { session: { id: "work-a" } },
  };
  assert.deepEqual(await preExecute?.(sessionA, async () => ({ kind: "allow" })), {
    kind: "ask",
  });

  const sessionB = {
    name: "call_host_tool",
    arguments: { name: "pdf-extract" },
    agent: { session: { id: "work-b" } },
  };
  assert.deepEqual(await preExecute?.(sessionB, async () => ({ kind: "allow" })), {
    kind: "deny",
    reason: POLICY(reasonToolUnattached("call_host_tool")),
  });
  assert.equal(guard?.(sessionB), GUARD(reasonToolUnattached("call_host_tool")));
});

test("attached mcp tools allow for a package runtime child and still ask for a normal session", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  const profileDir = mkdtempSync(join(tmpdir(), "huaanwork-policy-mcp-"));
  const toolName = "mcp__weekly-report__echo";
  try {
    writeFileSync(join(profileDir, "huaanwork-settings.json"), JSON.stringify({ guard_mode: "smart" }), "utf8");
    const attachments = emptyAttachments();
    attachAgentTools(attachments, "package-child", [toolName]);
    attachAgentTools(attachments, "normal-session", [toolName]);
    const packageChildSessions = new Set(["package-child"]);

    let preExecute: PreExecute | undefined;
    let guard:
      | ((execution: {
          name: string;
          arguments: Record<string, unknown>;
          agent?: { id?: string; session?: { id?: string } };
          callId?: string;
        }) => string | undefined)
      | undefined;

    apply({
      huaanworkWorkspaceRoot: { current: process.cwd() },
      huaanworkProfileDir: profileDir,
      huaanworkAttachments: attachments,
      huaanworkPackageChildSessions: packageChildSessions,
      on(event: string, listener: PreExecute) {
        if (event === "tools/pre-execute") preExecute = listener;
      },
      tools: {
        guard(listener: typeof guard) {
          guard = listener;
          return () => undefined;
        },
      },
    });

    const call = (sessionId: string, callId: string) => ({
      name: toolName,
      arguments: {},
      agent: { session: { id: sessionId } },
      callId,
    });

    // smart 档：包运行子会话没有审批界面，自己挂载的 MCP 工具直接放行（guard 同判定）。
    const packageChild = call("package-child", "pkg-1");
    assert.deepEqual(await preExecute?.(packageChild, async () => ({ kind: "allow" })), { kind: "allow" });
    assert.equal(guard?.(packageChild), undefined);

    // 普通会话保持原有行为：pre-execute ask，guard 无核销时 deny。
    const normal = call("normal-session", "normal-1");
    assert.deepEqual(await preExecute?.(normal, async () => ({ kind: "allow" })), { kind: "ask" });
    assert.equal(guard?.(normal), GUARD_NEEDS_APPROVAL);

    // 清理后（id 移出集合）同一会话回到普通询问，标记不是永久的。
    packageChildSessions.delete("package-child");
    assert.deepEqual(await preExecute?.(call("package-child", "pkg-2"), async () => ({ kind: "allow" })), {
      kind: "ask",
    });
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("re-created attachments maps are empty (reboot contract)", () => {
  const maps = emptyAttachments();
  attachHostTool(maps, "s", "pdf-extract");
  const rebooted = emptyAttachments();
  assert.equal(isHostAttached(rebooted, "s", "pdf-extract"), false);
});

describe('guard mode reads the profile settings document', () => {
  it('honours a non-default guard_mode written by the settings route', () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'guard-mode-'))
    writeFileSync(join(profileDir, 'huaanwork-settings.json'), JSON.stringify({ guard_mode: 'full' }), 'utf8')
    expect(readGuardMode(profileDir)).toBe('full')
  })

  it('falls back to ask when the profile has no settings document', () => {
    expect(readGuardMode(mkdtempSync(join(tmpdir(), 'guard-mode-empty-')))).toBe('ask')
  })

  it('falls back to ask when no profile dir was injected', () => {
    expect(readGuardMode(undefined)).toBe('ask')
  })

  it('rejects an unknown guard_mode rather than trusting it', () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'guard-mode-bad-'))
    writeFileSync(join(profileDir, 'huaanwork-settings.json'), JSON.stringify({ guard_mode: 'yolo' }), 'utf8')
    expect(readGuardMode(profileDir)).toBe('ask')
  })

  it('never reads a settings.json above the profile directory', () => {
    // B1 regression gate: dirname(dshHome) used to push reading to user HOME.
    const home = mkdtempSync(join(tmpdir(), 'guard-mode-home-'))
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ guard_mode: 'full' }), 'utf8')
    const dshHome = join(home, '.huaanwork')
    mkdirSync(join(dshHome, 'profiles', 'desktop'), { recursive: true })
    expect(readGuardMode(dshHome)).toBe('ask')
  })
})

describe('unattended audit lands where the cascade deleter looks', () => {
  it('writes <profileDir>/automations/<id>.audit.jsonl', () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'audit-'))
    writeUnattendedAudit({ huaanworkProfileDir: profileDir }, { runId: 'r1', automationId: 'a1', sessionId: 's1' }, 'run_code', 'call-1')
    const path = join(profileDir, 'automations', 'a1.audit.jsonl')
    expect(existsSync(path)).toBe(true)
    const line = JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>
    expect(line).toMatchObject({ runId: 'r1', sessionId: 's1', tool: 'run_code', callId: 'call-1', decision: 'ask→allow' })
    expect(typeof line.at).toBe('number')
  })
})

