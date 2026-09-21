import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

import {
  guard as policyGuard,
  REASON_NEEDS_APPROVAL,
  REASON_PATH_ESCAPE,
  REASON_SHELL_HARD_DENY,
  reasonToolUnattached,
} from "@huaanwork/policy";
import { attachHostTool, emptyAttachments, isHostAttached } from "../../src/huaanwork-guardrails/agent-attachments.ts";

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
    huaanworkWorkspaceRoot: process.cwd(),
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
      huaanworkWorkspaceRoot: workspaceRoot,
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
      huaanworkWorkspaceRoot: workspaceRoot,
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
    huaanworkWorkspaceRoot: process.cwd(),
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
    huaanworkWorkspaceRoot: process.cwd(),
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

test("unattended enabled and callId's tool is in allow: pre-execute degrades ask to allow, callId enters allowedOnce, guard passes, and an audit line is written", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  // decide() 按平台把 shell 工具二选一(win32 → pwsh,其余 → bash),硬编码 bash 在 Windows CI 会被平台规则先拒。
  const shellName = process.platform === "win32" ? "pwsh" : "bash";
  const dshHome = mkdtempSync(join(tmpdir(), "huaanwork-policy-audit-"));
  try {
    const allowedOnce = new Set<string>();
    const harness = applyPolicyWithUnattended({
      huaanworkAllowedOnce: allowedOnce,
      huaanworkDshHome: dshHome,
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

    const auditText = readFileSync(join(dshHome, "automations", "auto-1.audit.jsonl"), "utf8").trim();
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
    rmSync(dshHome, { recursive: true, force: true });
  }
});

test("audit file caps retained lines and trims the oldest ones on append (review finding 4)", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  const dshHome = mkdtempSync(join(tmpdir(), "huaanwork-policy-audit-cap-"));
  try {
    const auditPath = join(dshHome, "automations", "auto-cap.audit.jsonl");
    // 预先塞入 60 行审计记录（超过 50 行上限），模拟一个长期运行、积累了大量降级记录的任务。
    const seeded = Array.from({ length: 60 }, (_, index) =>
      JSON.stringify({ at: index, runId: `seed-${index}`, tool: "bash", callId: `seed-call-${index}`, decision: "ask→allow" }),
    );
    mkdirSync(join(dshHome, "automations"), { recursive: true });
    writeFileSync(auditPath, `${seeded.join("\n")}\n`, "utf8");

    const allowedOnce = new Set<string>();
    const shellName = process.platform === "win32" ? "pwsh" : "bash";
    const harness = applyPolicyWithUnattended({
      huaanworkAllowedOnce: allowedOnce,
      huaanworkDshHome: dshHome,
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
    rmSync(dshHome, { recursive: true, force: true });
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
  assert.deepEqual(events, [{ event: "session/end", ok: false, error: "Code mode is disabled" }]);
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

function applyPolicyWithHome(home: string | undefined) {
  const preExecuteListeners: PreExecute[] = [];
  let guard:
    | ((execution: { name: string; arguments: Record<string, unknown>; callId?: string }) => string | undefined)
    | undefined;
  const ctx = {
    huaanworkWorkspaceRoot: process.cwd(),
    ...(home === undefined ? {} : { huaanworkDshHome: home }),
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
  const base = mkdtempSync(join(tmpdir(), "huaanwork-guard-mode-"));
  const home = join(base, "dsh");
  const settingsPath = join(base, "settings.json");
  try {
    // 缺失 settings.json → ask 语义：git_push pre-execute ask、guard deny
    const missing = applyPolicyWithHome(home);
    apply(missing.ctx as never);
    const push = { name: "git_push", arguments: {}, callId: "p1" };
    assert.deepEqual(await missing.preExecute(push), { kind: "ask" });
    assert.equal(missing.guard(push), GUARD_NEEDS_APPROVAL);

    // full → pre-execute 放行，guard 无 allowedOnce 也放行；硬 deny 仍拦
    writeFileSync(settingsPath, JSON.stringify({ guard_mode: "full" }));
    const full = applyPolicyWithHome(home);
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
    const smart = applyPolicyWithHome(home);
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
    rmSync(base, { recursive: true, force: true });
  }
});

test("guard is fail-closed for would-be-ask calls in every mode", async () => {
  const { apply } = await import("../../src/huaanwork-guardrails/policy.ts");
  const base = mkdtempSync(join(tmpdir(), "huaanwork-guard-failclosed-"));
  const home = join(base, "dsh");
  const settingsPath = join(base, "settings.json");
  const shellName = process.platform === "win32" ? "pwsh" : "bash";
  try {
    // ask 档：普通命令 pre-execute ask → guard 无核销即 deny
    writeFileSync(settingsPath, JSON.stringify({ guard_mode: "ask" }));
    const askHarness = applyPolicyWithHome(home);
    apply(askHarness.ctx as never);
    const plain = { name: shellName, arguments: { command: "ls -la" }, callId: "fc-ask" };
    assert.deepEqual(await askHarness.preExecute(plain), { kind: "ask" });
    assert.equal(askHarness.guard(plain), GUARD_NEEDS_APPROVAL);

    // smart 档：高危命令 pre-execute ask → guard 无核销即 deny
    writeFileSync(settingsPath, JSON.stringify({ guard_mode: "smart" }));
    const smartHarness = applyPolicyWithHome(home);
    apply(smartHarness.ctx as never);
    const risky = { name: shellName, arguments: { command: "git push" }, callId: "fc-smart" };
    assert.deepEqual(await smartHarness.preExecute(risky), { kind: "ask" });
    assert.equal(smartHarness.guard(risky), GUARD_NEEDS_APPROVAL);

    // full 档：硬 deny 经 guard 仍 deny
    writeFileSync(settingsPath, JSON.stringify({ guard_mode: "full" }));
    const fullHarness = applyPolicyWithHome(home);
    apply(fullHarness.ctx as never);
    const catastrophic = { name: shellName, arguments: { command: "echo x && rm -rf y" }, callId: "fc-full" };
    assert.deepEqual(await fullHarness.preExecute(catastrophic), {
    kind: "deny",
    reason: POLICY(REASON_SHELL_HARD_DENY),
  });
    assert.equal(fullHarness.guard(catastrophic), GUARD(REASON_SHELL_HARD_DENY));
  } finally {
    rmSync(base, { recursive: true, force: true });
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
    huaanworkWorkspaceRoot: process.cwd(),
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

test("re-created attachments maps are empty (reboot contract)", () => {
  const maps = emptyAttachments();
  attachHostTool(maps, "s", "pdf-extract");
  const rebooted = emptyAttachments();
  assert.equal(isHostAttached(rebooted, "s", "pdf-extract"), false);
});

