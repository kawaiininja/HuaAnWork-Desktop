import assert from "node:assert/strict";
import { afterEach, test } from "vitest";

import { emptyAttachments } from "../../src/huaanwork-guardrails/agent-attachments.ts";
import { apply as applyPresentAs } from "../../src/huaanwork-guardrails/present-as.ts";
import { isUnmanagedChildSession, createSystemSkillLeaseStore, acquireExplicitSystemSkillLease, acquireSystemSkillLease, noteSystemSkillGoalPhase, releaseSystemSkillLease, releaseSystemSkillLeaseOnIdle, systemSkillLeaseKindOf, type SystemSkillLeaseContext, type SystemSkillLeaseHost, type SystemSkillLeaseStore } from "../../src/huaanwork-host/system-skill-leases.ts";
import { registerChildSession, resetChildSessionRegistry } from "../../src/huaanwork-host/child-sessions.ts";
import { createTurnAnchorStore } from "../../src/huaanwork-host/turn-anchors.ts";

afterEach(() => {
  resetChildSessionRegistry();
});

type LeaseFixtureCtx = SystemSkillLeaseContext &
  SystemSkillLeaseHost & {
    agents: { list(): unknown[] };
    tools: { presentAs: () => () => void; schemas: () => readonly { name?: string }[] };
    on(): void;
  };

type LeaseFixture = {
  ctx: LeaseFixtureCtx & { huaanworkSystemSkillLeases: SystemSkillLeaseStore };
  attachments: ReturnType<typeof emptyAttachments>;
  anchors: ReturnType<typeof createTurnAnchorStore>;
  restrictCalls: Array<{ allow: readonly string[] }>;
  invalidated: string[];
};

function seedAnchor(anchors: ReturnType<typeof createTurnAnchorStore>, sessionId: string, messageId = "user-1"): void {
  anchors.register({ sessionId, clientMessageId: messageId, origin: "advanced" });
  anchors.notePreStep(
    sessionId,
    [{ role: "user", id: messageId, source: { kind: "user" } }],
    new Date().toISOString(),
  );
}

function createFixture(options?: {
  unattended?: boolean;
  withAttachments?: boolean;
  packageChild?: boolean;
}): LeaseFixture {
  const attachments = emptyAttachments();
  const anchors = createTurnAnchorStore();
  seedAnchor(anchors, "s1");
  const restrictCalls: Array<{ allow: readonly string[] }> = [];
  const tools = {
    schemas: () => [{ name: "read" }, { name: "subagent" }, { name: "edit" }],
    restrict(filter: { allow: readonly string[] }) {
      restrictCalls.push(filter);
      return () => undefined;
    },
  };
  const agent = {
    id: "s1",
    session: { id: "s1" },
    ctx: { get: (name: string) => (name === "tools" ? tools : undefined) },
  };
  const packageAllow = new Map<string, readonly string[]>();
  if (options?.packageChild === true) packageAllow.set("pkg-child", ["read", "subagent"]);
  const ctx: LeaseFixtureCtx = {
    ...(options?.withAttachments === false ? {} : { huaanworkAttachments: attachments }),
    huaanworkUnattended: new Map(
      options?.unattended === true
        ? [["s1", { runId: "run", automationId: "auto", allow: new Set<string>() }]]
        : [],
    ),
    huaanworkPackageChildAllow: packageAllow,
    huaanworkTurnAnchors: anchors,
    agents: { list: () => [agent] },
    tools: { presentAs: () => () => undefined, schemas: () => [] },
    on() {},
  };
  applyPresentAs(ctx as never);
  ctx.huaanworkSystemSkillLeases = createSystemSkillLeaseStore(ctx);
  const invalidated: string[] = [];
  ctx.huaanworkSystemSkillLeases.onInvalidate((sessionId) => invalidated.push(sessionId));
  return {
    ctx: ctx as LeaseFixture["ctx"],
    attachments,
    anchors,
    restrictCalls,
    invalidated,
  };
}

test("acquire attaches subagent to the session and refreshes the effective allow", () => {
  const fixture = createFixture();
  // present-as 基线:全局 ALLOWED_TOOLS 不含 subagent。
  assert.equal(fixture.restrictCalls.at(-1)?.allow.includes("subagent"), false);
  assert.equal(acquireSystemSkillLease(fixture.ctx, "s1", "explore"), true);
  assert.equal(systemSkillLeaseKindOf(fixture.ctx, "s1"), "explore");
  assert.equal(fixture.attachments.sessionAgentTools.get("s1")?.has("subagent"), true);
  assert.equal(fixture.restrictCalls.at(-1)?.allow.includes("subagent"), true);

  // 重复 acquire 幂等:附件集合不膨胀,租约类型保持。
  assert.equal(acquireSystemSkillLease(fixture.ctx, "s1", "explore"), true);
  assert.equal(fixture.attachments.sessionAgentTools.get("s1")?.size, 1);
  assert.equal(systemSkillLeaseKindOf(fixture.ctx, "s1"), "explore");
});

test("unattended automations, unmanaged children, missing anchors and missing attachments never acquire", () => {
  const unattended = createFixture({ unattended: true });
  assert.equal(acquireSystemSkillLease(unattended.ctx, "s1", "explore"), false);
  assert.equal(systemSkillLeaseKindOf(unattended.ctx, "s1"), undefined);
  assert.equal(unattended.attachments.sessionAgentTools.has("s1"), false);

  resetChildSessionRegistry();
  registerChildSession("legacy-parent", "child");
  const legacy = createFixture();
  assert.equal(isUnmanagedChildSession(legacy.ctx, "child"), true);
  assert.equal(acquireSystemSkillLease(legacy.ctx, "child", "explore"), false);
  assert.equal(legacy.attachments.sessionAgentTools.has("child"), false);

  const unanchored = createFixture();
  assert.equal(acquireSystemSkillLease(unanchored.ctx, "s-unknown", "explore"), false);
  assert.equal(systemSkillLeaseKindOf(unanchored.ctx, "s-unknown"), undefined);

  const noAttachments = createFixture({ withAttachments: false });
  assert.equal(acquireSystemSkillLease(noAttachments.ctx, "s1", "explore"), false);

  // 包儿童的 allow 表条目 = 受管;锚点在场时可以获取租约。
  resetChildSessionRegistry();
  registerChildSession("pkg-parent", "pkg-child");
  const pkg = createFixture({ packageChild: true });
  seedAnchor(pkg.anchors, "pkg-child", "pkg-user");
  assert.equal(isUnmanagedChildSession(pkg.ctx, "pkg-child"), false);
  assert.equal(acquireSystemSkillLease(pkg.ctx, "pkg-child", "explore"), true);
  assert.equal(pkg.attachments.sessionAgentTools.get("pkg-child")?.has("subagent"), true);
});

test("explicit acquire needs no anchor and invalidates stale caches before committing", () => {
  const fixture = createFixture();
  const seenDuringInvalidate: Array<string | undefined> = [];
  fixture.ctx.huaanworkSystemSkillLeases.onInvalidate((sessionId) => {
    seenDuringInvalidate.push(fixture.ctx.huaanworkSystemSkillLeases.kindOf(sessionId));
  });
  // 无锚点也可用(显式 /explore 在 pre-step 之前挂载)。
  assert.equal(acquireExplicitSystemSkillLease(fixture.ctx, "s-unknown", "test-fix"), true);
  assert.equal(systemSkillLeaseKindOf(fixture.ctx, "s-unknown"), "test-fix");
  // 失效回调先于新租约写入:回调看到的是清理后的空状态(QR-I2)。
  assert.deepEqual(seenDuringInvalidate, [undefined]);
  assert.deepEqual(fixture.invalidated, ["s-unknown"]);
});

test("release detaches and refreshes; a release without a lease still invalidates and stays idempotent", () => {
  const fixture = createFixture();
  assert.equal(acquireSystemSkillLease(fixture.ctx, "s1", "explore"), true);
  fixture.restrictCalls.length = 0;
  releaseSystemSkillLease(fixture.ctx, "s1");
  assert.equal(systemSkillLeaseKindOf(fixture.ctx, "s1"), undefined);
  assert.equal(fixture.attachments.sessionAgentTools.has("s1"), false);
  assert.equal(fixture.restrictCalls.at(-1)?.allow.includes("subagent"), false);
  assert.deepEqual(fixture.invalidated, ["s1"]);

  // 租约缺席(先前 acquire 返回 false)也通知失效回调,保证 pendingByAgent/槽位被清。
  releaseSystemSkillLease(fixture.ctx, "s1");
  assert.deepEqual(fixture.invalidated, ["s1", "s1"]);
});

test("normal idle keeps a goal-active lease, while terminal goal phases release it", () => {
  const fixture = createFixture();
  // 先 goal/change(active) 后取租约:activeGoalSessions 独立记录,commitLease 继承 active。
  noteSystemSkillGoalPhase(fixture.ctx, "s1", "active");
  assert.equal(acquireSystemSkillLease(fixture.ctx, "s1", "explore"), true);
  releaseSystemSkillLeaseOnIdle(fixture.ctx, "s1");
  assert.equal(systemSkillLeaseKindOf(fixture.ctx, "s1"), "explore");

  // 正常完成轮次的 inactive 相位(complete/paused/blocked/clear)释放并清标记。
  noteSystemSkillGoalPhase(fixture.ctx, "s1", "complete");
  assert.equal(systemSkillLeaseKindOf(fixture.ctx, "s1"), undefined);
  assert.equal(fixture.attachments.sessionAgentTools.has("s1"), false);

  // 无 active goal 的正常轮间 idle 解挂。
  assert.equal(acquireSystemSkillLease(fixture.ctx, "s1", "test-fix"), true);
  releaseSystemSkillLeaseOnIdle(fixture.ctx, "s1");
  assert.equal(systemSkillLeaseKindOf(fixture.ctx, "s1"), undefined);
});
