import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

import { apply as applyApproval } from "../../src/huaanwork-guardrails/approval.ts";
import { apply as applyGit } from "../../src/huaanwork-guardrails/git.ts";
import { apply as applyPolicy } from "../../src/huaanwork-guardrails/policy.ts";

type Decision = { kind: string; reason?: string };
type Execution = { name: string; arguments: Record<string, unknown> };
type ToolDefinition = {
  name: string;
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<{ stdout: string; stderr: string; status: number; dirty?: boolean }>;
};

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "huaanwork-git-plugin-"));
  assert.equal(spawnSync("git", ["init", "-q", "--template=/dev/null"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["config", "user.name", "Test"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root }).status, 0);
  return root;
}

function git(root: string, argv: string[]): string {
  const result = spawnSync("git", argv, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function createCtx(workspaceRoot: string) {
  const events: Record<string, (payload: never, next: () => Promise<unknown>) => Promise<unknown>> = {};
  const registered: ToolDefinition[] = [];
  const emitted: unknown[] = [];
  const approvals = new Map<string, (result: string) => void>();

  const ctx = {
    huaanworkWorkspaceRoot: workspaceRoot,
    huaanworkApprovals: approvals,
    huaanworkEmit(event: unknown) {
      emitted.push(event);
    },
    on(
      event: string,
      listener: (payload: never, next: () => Promise<unknown>) => Promise<unknown>,
      prepend?: boolean,
    ) {
      const previous = events[event];
      if (prepend) {
        events[event] = (payload, next) => listener(payload, () => (previous ? previous(payload, next) : next()));
        return;
      }
      events[event] = previous
        ? (payload, next) => previous(payload, () => listener(payload, next))
        : listener;
    },
    tools: {
      register(definition: ToolDefinition) {
        registered.push(definition);
        return () => undefined;
      },
      guard() {
        return () => undefined;
      },
    },
    approval: {
      setPolicy() {
        return undefined;
      },
    },
  };

  return {
    ctx,
    registered,
    emitted,
    approvals,
    async preExecute(execution: Execution, terminal: () => Promise<Decision> = async () => ({ kind: "allow" })) {
      const listener = events["tools/pre-execute"];
      assert.ok(listener);
      return listener(execution as never, terminal) as Promise<Decision>;
    },
    async requestApproval(request: { agent: unknown; toolName: string; callId?: string; reason?: string }) {
      const listener = events["approval/request"];
      assert.ok(listener);
      return listener(request as never, async () => "unavailable") as Promise<string>;
    },
  };
}

test("git plugin registers the local git tools", () => {
  const harness = createCtx(process.cwd());
  applyGit(harness.ctx as never);
  assert.deepEqual(
    harness.registered.map((tool) => tool.name).sort(),
    ["git_branch", "git_checkout", "git_commit", "git_diff", "git_push", "git_status"],
  );
});

test("git_commit execute creates git log -1", async () => {
  const root = initRepo();
  try {
    writeFileSync(join(root, "README.md"), "hello\n");
    git(root, ["add", "README.md"]);
    const harness = createCtx(root);
    applyGit(harness.ctx as never);
    const commit = harness.registered.find((tool) => tool.name === "git_commit");
    assert.ok(commit);
    const result = await commit.execute({ message: "feat: from tool" }, {});
    assert.equal(result.status, 0, result.stderr);
    assert.match(git(root, ["log", "-1", "--pretty=%s"]), /feat: from tool/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git_commit execute stages a new untracked file", async () => {
  const root = initRepo();
  try {
    writeFileSync(join(root, "untracked.txt"), "new file\n");
    const harness = createCtx(root);
    applyGit(harness.ctx as never);
    const commit = harness.registered.find((tool) => tool.name === "git_commit");
    assert.ok(commit);
    const result = await commit.execute({ message: "feat: add untracked" }, {});
    assert.equal(result.status, 0, result.stderr);
    assert.match(git(root, ["log", "-1", "--pretty=%s"]), /feat: add untracked/);
    assert.match(git(root, ["show", "--pretty=", "--name-only", "HEAD"]), /untracked\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git_checkout execute returns dirty: true on a dirty tree", async () => {
  const root = initRepo();
  try {
    writeFileSync(join(root, "tracked.txt"), "clean\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "init"]);
    writeFileSync(join(root, "tracked.txt"), "dirty\n");
    const harness = createCtx(root);
    applyGit(harness.ctx as never);
    const checkout = harness.registered.find((tool) => tool.name === "git_checkout");
    assert.ok(checkout);
    const result = await checkout.execute({ ref: "HEAD" }, {});
    assert.equal(result.dirty, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git_commit ask card includes the message and git diff --stat HEAD", async () => {
  const root = initRepo();
  try {
    writeFileSync(join(root, "tracked.txt"), "v1\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "init"]);
    writeFileSync(join(root, "tracked.txt"), "v2\n");
    git(root, ["add", "tracked.txt"]);
    writeFileSync(join(root, "untracked.txt"), "new\n");
    const stat = git(root, ["diff", "--stat", "HEAD"]).trim();
    const porcelain = git(root, ["status", "--porcelain", "-uall"]).trim();
    const harness = createCtx(root);
    applyPolicy(harness.ctx as never);
    applyGit(harness.ctx as never);
    applyApproval(harness.ctx as never);

    const decision = await harness.preExecute({ name: "git_commit", arguments: { message: "feat: update tracked" } });
    assert.equal(decision.kind, "ask");
    assert.match(decision.reason ?? "", /feat: update tracked/);
    assert.ok(stat.length > 0);
    assert.ok((decision.reason ?? "").includes(stat));
    assert.match(porcelain, /\?\? untracked\.txt/);
    assert.ok((decision.reason ?? "").includes(porcelain));

    const pending = harness.requestApproval({
      agent: {},
      toolName: "git_commit",
      callId: "commit-1",
      reason: decision.reason,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const event = harness.emitted[0] as {
      event: string;
      toolName: string;
      reason?: string;
      summary?: string;
      approvalRequestId: string;
    };
    assert.equal(event.event, "approval/asked");
    assert.equal(event.toolName, "git_commit");
    assert.equal(event.reason, decision.reason);
    assert.equal(event.summary, decision.reason);
    harness.approvals.get(event.approvalRequestId)?.("allowed-once");
    assert.equal(await pending, "allowed-once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git_push ask card summary is git status -sb", async () => {
  const root = initRepo();
  try {
    writeFileSync(join(root, "tracked.txt"), "v1\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "init"]);
    const status = git(root, ["status", "-sb"]).trim();
    const harness = createCtx(root);
    applyPolicy(harness.ctx as never);
    applyGit(harness.ctx as never);
    applyApproval(harness.ctx as never);

    const decision = await harness.preExecute({ name: "git_push", arguments: {} });
    assert.equal(decision.kind, "ask");
    assert.equal((decision.reason ?? "").trim(), status);

    const pending = harness.requestApproval({
      agent: {},
      toolName: "git_push",
      callId: "push-1",
      reason: decision.reason,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const event = harness.emitted[0] as { summary?: string; reason?: string; approvalRequestId: string };
    assert.equal(event.summary, decision.reason);
    assert.equal(event.reason, decision.reason);
    harness.approvals.get(event.approvalRequestId)?.("rejected");
    assert.equal(await pending, "rejected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git plugin registers tools without requiring git on PATH", () => {
  const harness = createCtx(process.cwd());
  applyGit(harness.ctx as never);
  assert.equal(harness.registered.length, 6);
});
