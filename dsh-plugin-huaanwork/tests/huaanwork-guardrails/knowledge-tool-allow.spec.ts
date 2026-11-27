import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";

import { guard as policyGuard, preExecuteExplained, reasonToolUnattached } from "@huaanwork/policy";

import { attachAgentTools, emptyAttachments } from "../../src/huaanwork-guardrails/agent-attachments.ts";
import { apply as applyPolicy } from "../../src/huaanwork-guardrails/policy.ts";
import { apply as applyPresentAs } from "../../src/huaanwork-guardrails/present-as.ts";
import { kbOrganizeSessionId } from "../../src/huaanwork-host/knowledge/session-ids.ts";

/**
 * 规格 §8.1 单槽整理白名单:6 个 fs 工具 + 3 个整理宿主工具。
 * 严禁包含 `str_replace_editor`。
 */
const ORGANIZER_TOOLS = [
  "read",
  "read_file",
  "glob",
  "grep",
  "write",
  "edit",
  "kb_org_get_delta",
  "kb_org_read_doc",
  "kb_org_mark_organized",
] as const;

const KB_ORG_TOOLS = ["kb_org_get_delta", "kb_org_read_doc", "kb_org_mark_organized"] as const;

const FORBIDDEN_ORGANIZER_TOOLS = [
  "bash",
  "pwsh",
  "str_replace_editor",
  "skill",
  "web_fetch",
  "request_input",
  "result_present",
] as const;

const SESSION_ID = kbOrganizeSessionId("kb-1");

const MODES = ["ask", "smart", "full"] as const;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 真实 wiki/ 根:`INDEX.md` 与 `docs/d1.md`(含唯一匹配串)已就位。 */
function createKnowledgeRoot(): { kbRoot: string; wiki: string } {
  const kbRoot = makeTemp("huaanwork-kb-org-");
  const wiki = join(kbRoot, "wiki");
  mkdirSync(join(wiki, "docs"), { recursive: true });
  writeFileSync(join(wiki, "INDEX.md"), "# 索引\n");
  writeFileSync(join(wiki, "docs", "d1.md"), "before unique after\n");
  return { kbRoot, wiki };
}

// ── present-as 桩 ───────────────────────────────────────────────────────────

type MockAgent = {
  id?: string;
  session?: { id?: string; header?: { parentSession?: unknown } };
  ctx: { get(name: string): MockToolsService | undefined };
  restrictCalls: Array<{ allow: readonly string[] }>;
};

type MockToolsService = {
  restrict(filter: { allow: readonly string[] }): () => void;
  schemas(): readonly { name?: string }[];
  getActiveAllow(): string[];
};

function createMockAgent(options: {
  sessionId?: string;
  headerParentSession?: string;
  toolNames: string[];
}): MockAgent {
  const restrictions: Array<{ allow: readonly string[] }> = [];
  const restrictCalls: Array<{ allow: readonly string[] }> = [];
  const tools: MockToolsService = {
    schemas() {
      let names = [...options.toolNames];
      for (const restriction of restrictions) {
        names = names.filter((name) => restriction.allow.includes(name));
      }
      return names.map((name) => ({ name }));
    },
    restrict(filter) {
      restrictions.push(filter);
      restrictCalls.push(filter);
      return () => {
        const index = restrictions.indexOf(filter);
        if (index !== -1) restrictions.splice(index, 1);
      };
    },
    getActiveAllow() {
      return this.schemas().map((schema) => schema.name!).filter(Boolean);
    },
  };
  return {
    ...(options.sessionId !== undefined
      ? {
          session: {
            id: options.sessionId,
            ...(options.headerParentSession !== undefined
              ? { header: { parentSession: options.headerParentSession } }
              : {}),
          },
        }
      : {}),
    ctx: { get: (name: string) => (name === "tools" ? tools : undefined) },
    restrictCalls,
  };
}

function createPresentAsContext(options: {
  agents: MockAgent[];
  attachments?: ReturnType<typeof emptyAttachments>;
  sessionToolAllow?: Map<string, readonly string[]>;
  packageChildAllow?: Map<string, readonly string[]>;
}) {
  const listeners: Record<string, Function[]> = {};
  const ctx = {
    huaanworkAttachments: options.attachments,
    ...(options.sessionToolAllow !== undefined ? { huaanworkSessionToolAllow: options.sessionToolAllow } : {}),
    ...(options.packageChildAllow !== undefined ? { huaanworkPackageChildAllow: options.packageChildAllow } : {}),
    agents: { list: () => options.agents },
    tools: { presentAs: () => () => undefined, schemas: () => [] },
    on(event: string, listener: Function) {
      (listeners[event] ??= []).push(listener);
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners[event] ?? []) listener(...args);
    },
  };
  return ctx;
}

// ── policy 桩 ───────────────────────────────────────────────────────────────

type PolicyExecution = {
  name: string;
  arguments: Record<string, unknown>;
  agent?: { id?: string; session?: { id?: string } };
  callId?: string;
};

function createPolicyHarness(options: { sessionId: string; workspaceRoot: string }) {
  const profileDir = makeTemp("huaanwork-kb-org-profile-");
  const attachments = emptyAttachments();
  let preExecute:
    | ((
        execution: PolicyExecution,
        next: () => Promise<{ kind: "allow" }>,
      ) => Promise<{ kind: string; reason?: string }>)
    | undefined;
  let guard: ((execution: PolicyExecution) => string | undefined) | undefined;

  const ctx: Record<string, unknown> = {
    huaanworkProfileDir: profileDir,
    huaanworkAttachments: attachments,
    huaanworkSessionRoots: new Map([[options.sessionId, options.workspaceRoot]]),
    huaanworkSessionToolAllow: new Map([[options.sessionId, [...ORGANIZER_TOOLS]]]),
    on(event: string, listener: typeof preExecute) {
      if (event === "tools/pre-execute") preExecute = listener;
    },
    tools: {
      guard(listener: typeof guard) {
        guard = listener;
        return () => undefined;
      },
    },
  };
  applyPolicy(ctx as never);

  const execution = (name: string, args: Record<string, unknown>): PolicyExecution => ({
    name,
    arguments: args,
    agent: { session: { id: options.sessionId } },
    callId: `call-${name}`,
  });

  return {
    attachments,
    ctx,
    setMode(mode: (typeof MODES)[number]) {
      writeFileSync(join(profileDir, "huaanwork-settings.json"), JSON.stringify({ guard_mode: mode }), "utf8");
    },
    async preExecute(name: string, args: Record<string, unknown>) {
      assert.ok(preExecute, "the policy plugin must register a tools/pre-execute listener");
      return preExecute(execution(name, args), async () => ({ kind: "allow" as const }));
    },
    guard(name: string, args: Record<string, unknown>) {
      assert.ok(guard, "the policy plugin must register a tools.guard listener");
      return guard(execution(name, args));
    },
  };
}

// ── 1. present-as 空交集 fail-closed ─────────────────────────────────────────

test("explicit session allowlist with an empty intersection restricts to nothing once schemas exist", () => {
  const agent = createMockAgent({ sessionId: SESSION_ID, toolNames: ["read", "bash"] });
  const ctx = createPresentAsContext({
    agents: [agent],
    sessionToolAllow: new Map([[SESSION_ID, ["nonexistent"]]]),
  });

  applyPresentAs(ctx as never);

  assert.deepEqual(
    agent.restrictCalls,
    [{ allow: [] }],
    "an explicit allowlist whose intersection is empty must lock the agent down instead of leaking the baseline allow",
  );
});

test("an empty schema set is not locked down yet; tools/change narrows once schemas arrive", () => {
  const toolNames: string[] = [];
  const agent = createMockAgent({ sessionId: SESSION_ID, toolNames });
  const ctx = createPresentAsContext({
    agents: [agent],
    sessionToolAllow: new Map([[SESSION_ID, ["nonexistent"]]]),
  });

  applyPresentAs(ctx as never);
  assert.deepEqual(agent.restrictCalls, [], "schemas are not registered yet: restricting to [] would be a premature lockdown");

  // 上游随后注册 schema,tools/change 重放时交集仍为空 → 此时才锁死。
  toolNames.push("read", "bash");
  ctx.emit("tools/change");
  assert.deepEqual(agent.restrictCalls, [{ allow: [] }]);
});

test("no explicit session allowlist keeps the existing baseline behaviour", () => {
  const agent = createMockAgent({
    sessionId: SESSION_ID,
    toolNames: ["read", "bash", "call_host_tool", "send_message"],
  });
  const ctx = createPresentAsContext({ agents: [agent], attachments: emptyAttachments() });

  applyPresentAs(ctx as never);

  const allow = agent.restrictCalls[0]!.allow;
  assert.ok(allow.includes("read"));
  assert.ok(allow.includes("bash"));
  assert.ok(allow.includes("call_host_tool"));
  assert.ok(!allow.includes("send_message"));

  // 老语义逐字保留:没有显式白名单、可见集为空(如 run_code 独占)时依旧不动,
  // 新加的 fail-closed 只属于"有显式白名单"的会话。
  const legacyEmpty = createMockAgent({ sessionId: SESSION_ID, toolNames: ["send_message"] });
  applyPresentAs(createPresentAsContext({ agents: [legacyEmpty], attachments: emptyAttachments() }) as never);
  assert.deepEqual(legacyEmpty.restrictCalls, []);
});

// ── 2. packageChildAllow 不改可见集(G-M1 方案一)─────────────────────────────

test("huaanworkPackageChildAllow alone changes nothing in the present-as visible set", () => {
  const toolNames = ["read", "bash", "glob"];
  const baselineAgent = createMockAgent({ sessionId: "work-plain", toolNames });
  applyPresentAs(createPresentAsContext({ agents: [baselineAgent], attachments: emptyAttachments() }) as never);
  const baseline = baselineAgent.restrictCalls[0]!.allow;

  const packageAgent = createMockAgent({ sessionId: "work-pkg", toolNames });
  applyPresentAs(
    createPresentAsContext({
      agents: [packageAgent],
      attachments: emptyAttachments(),
      packageChildAllow: new Map([["work-pkg", ["read"]]]),
    }) as never,
  );

  assert.deepEqual(
    packageAgent.restrictCalls[0]!.allow,
    baseline,
    "huaanworkPackageChildAllow must never take part in the visible-set intersection",
  );
});

test("when both maps exist only huaanworkSessionToolAllow decides the visible set", () => {
  const toolNames = ["read", "bash", "glob"];

  const narrowBySession = createMockAgent({ sessionId: "work-both-a", toolNames });
  applyPresentAs(
    createPresentAsContext({
      agents: [narrowBySession],
      attachments: emptyAttachments(),
      sessionToolAllow: new Map([["work-both-a", ["read"]]]),
      // 包白名单更宽:若被消费会把 bash/glob 放回可见集。
      packageChildAllow: new Map([["work-both-a", ["read", "bash", "glob"]]]),
    }) as never,
  );
  assert.deepEqual(narrowBySession.restrictCalls[0]!.allow, ["read"]);

  const narrowByPackageOnly = createMockAgent({ sessionId: "work-both-b", toolNames });
  applyPresentAs(
    createPresentAsContext({
      agents: [narrowByPackageOnly],
      attachments: emptyAttachments(),
      sessionToolAllow: new Map([["work-both-b", ["read", "bash"]]]),
      packageChildAllow: new Map([["work-both-b", ["read"]]]),
    }) as never,
  );
  assert.deepEqual(narrowByPackageOnly.restrictCalls[0]!.allow, ["read", "bash"]);
});

test("packageChildAllow keeps its existing hideSkill meaning only", () => {
  const visibleSkill = (packageChildAllow: Map<string, readonly string[]>) => {
    const agent = createMockAgent({
      sessionId: "work-skill-child",
      headerParentSession: "work-skill-parent",
      toolNames: ["read", "skill"],
    });
    applyPresentAs(
      createPresentAsContext({
        agents: [agent],
        attachments: emptyAttachments(),
        packageChildAllow,
      }) as never,
    );
    return agent.restrictCalls.at(-1)!.allow.includes("skill");
  };

  assert.equal(visibleSkill(new Map([["work-skill-child", []]])), true, "a managed package child keeps skill");
  assert.equal(visibleSkill(new Map()), false, "an unmanaged child still hides skill");
});

// ── 3. 整理白名单三档 allow,永不 ask ────────────────────────────────────────

test("organizer allowlist tools allow in ask/smart/full without huaanworkUnattended", async () => {
  const { wiki } = createKnowledgeRoot();
  const harness = createPolicyHarness({ sessionId: SESSION_ID, workspaceRoot: wiki });
  attachAgentTools(harness.attachments, SESSION_ID, [...KB_ORG_TOOLS]);
  assert.equal(
    "huaanworkUnattended" in harness.ctx,
    false,
    "the organizer slot must never be registered as unattended",
  );

  const fsCalls: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: "read", args: { path: "INDEX.md" } },
    { name: "read_file", args: { path: "docs/d1.md" } },
    { name: "glob", args: { pattern: "docs/*.md" } },
    { name: "grep", args: { pattern: "unique" } },
    { name: "write", args: { path: "docs/new.md", content: "新笔记\n" } },
    { name: "edit", args: { path: "docs/d1.md", old_string: "unique", new_string: "only" } },
    ...KB_ORG_TOOLS.map((name) => ({ name, args: { kbId: "kb-1" } })),
  ];

  for (const mode of MODES) {
    harness.setMode(mode);
    for (const call of fsCalls) {
      assert.deepEqual(
        await harness.preExecute(call.name, call.args),
        { kind: "allow" },
        `${call.name} ${mode} pre-execute`,
      );
      assert.equal(harness.guard(call.name, call.args), undefined, `${call.name} ${mode} guard`);
    }
  }
});

test("organizer kb_org_* tools never reach ask when unattached", async () => {
  const { wiki } = createKnowledgeRoot();
  const harness = createPolicyHarness({ sessionId: SESSION_ID, workspaceRoot: wiki });

  for (const mode of MODES) {
    harness.setMode(mode);
    for (const name of KB_ORG_TOOLS) {
      const result = await harness.preExecute(name, {});
      assert.equal(result.kind, "deny", `${name} ${mode} pre-execute`);
      assert.equal(harness.guard(name, {}), `huaanwork-guard: ${reasonToolUnattached(name)}`);
    }
  }
});

// ── 4. 白名单外的工具:present-as 不可见 + policy 双层拒绝 ────────────────────

test("organizer sessions never see bash/pwsh/str_replace_editor/skill/web_fetch/request_input/result_present", () => {
  const attachments = emptyAttachments();
  attachAgentTools(attachments, SESSION_ID, [...KB_ORG_TOOLS, "result_present"]);
  const agent = createMockAgent({
    sessionId: SESSION_ID,
    toolNames: ["read", "write", ...KB_ORG_TOOLS, "result_present", ...FORBIDDEN_ORGANIZER_TOOLS],
  });
  const ctx = createPresentAsContext({
    agents: [agent],
    attachments,
    sessionToolAllow: new Map([[SESSION_ID, [...ORGANIZER_TOOLS]]]),
  });

  applyPresentAs(ctx as never);

  const allow = agent.restrictCalls.at(-1)!.allow;
  for (const name of FORBIDDEN_ORGANIZER_TOOLS) {
    assert.ok(!allow.includes(name), `${name} must stay invisible to the organizer session`);
  }
  assert.ok(allow.includes("read"));
  assert.ok(allow.includes("write"));
  for (const name of KB_ORG_TOOLS) assert.ok(allow.includes(name), `${name} must stay visible once attached`);
});

test("organizer sessions are denied the non-allowlisted tools in both policy seams", async () => {
  const { wiki } = createKnowledgeRoot();
  const harness = createPolicyHarness({ sessionId: SESSION_ID, workspaceRoot: wiki });
  attachAgentTools(harness.attachments, SESSION_ID, ["result_present", ...KB_ORG_TOOLS]);

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [
    // 平台 shell 在整理会话同样被拒:白名单在执行期生效,不依赖 present-as 的收窄时序。
    { name: "bash", args: { command: "npm test" } },
    { name: "pwsh", args: { command: "npm test" } },
    // str_replace_editor 即使 old_str 唯一命中(decide 会 allow)也必须被白名单拒绝。
    { name: "str_replace_editor", args: { path: "docs/d1.md", old_str: "before", new_str: "after" } },
    { name: "skill", args: {} },
    { name: "web_fetch", args: {} },
    { name: "request_input", args: {} },
    // result_present 已挂载,decide 会放行,白名单必须仍然拒绝。
    { name: "result_present", args: {} },
  ];

  for (const mode of MODES) {
    harness.setMode(mode);
    for (const call of calls) {
      const result = await harness.preExecute(call.name, call.args);
      assert.equal(result.kind, "deny", `${call.name} ${mode} pre-execute`);
      assert.match(String(result.reason ?? ""), /^huaanwork-policy: /, `${call.name} reason prefix`);
      assert.equal(typeof harness.guard(call.name, call.args), "string", `${call.name} ${mode} guard`);
    }
  }
});

// ── 5. 整理会话禁写 OS 临时目录与符号链接(含悬空)──────────────────────────

test("organizer sessions cannot write into the OS temp directory outside the knowledge root", async () => {
  const { wiki } = createKnowledgeRoot();
  const harness = createPolicyHarness({ sessionId: SESSION_ID, workspaceRoot: wiki });

  for (const mode of MODES) {
    harness.setMode(mode);
    for (const name of ["write", "edit"]) {
      const target = join(tmpdir(), "huaanwork-kb-org-escape.md");
      const result = await harness.preExecute(name, { path: target, content: "escape" });
      assert.equal(result.kind, "deny", `${name} ${mode} pre-execute`);
      assert.match(String(result.reason ?? ""), /临时目录/, `${name} ${mode} must be denied by the organizer temp rule`);
      assert.match(String(harness.guard(name, { path: target }) ?? ""), /临时目录/, `${name} ${mode} guard`);
    }
  }
});

test("organizer sessions cannot write through a dangling symlink that points outside the knowledge root", async () => {
  const { wiki } = createKnowledgeRoot();
  const outside = makeTemp("huaanwork-kb-outside-");
  // 链接本身在库内,目标是「父目录存在、文件尚不存在」的库外路径:
  // `resolveInside` 的 forWrite 分支沿悬空链接退到父目录,因此必须由 lstat 兜住。
  const linkName = "docs/dangling.md";
  symlinkSync(join(outside, "not-yet.md"), join(wiki, linkName), "file");

  const harness = createPolicyHarness({ sessionId: SESSION_ID, workspaceRoot: wiki });
  for (const mode of MODES) {
    harness.setMode(mode);
    for (const name of ["write", "edit"]) {
      const result = await harness.preExecute(name, { path: linkName, content: "escape" });
      assert.equal(result.kind, "deny", `${name} ${mode} pre-execute`);
      assert.equal(typeof harness.guard(name, { path: linkName }), "string", `${name} ${mode} guard`);
    }
  }
});

test("an organizer session without a registered root gets a named denial in both policy seams", async () => {
  const { wiki } = createKnowledgeRoot();
  const harness = createPolicyHarness({ sessionId: SESSION_ID, workspaceRoot: wiki });
  // 整理会话根表缺条目在主链路不可达(执行器在 createAgent 前写根、dispose 后才清);这里只钉
  // 异常路径的错误契约:所有白名单工具都是结构化拒绝,而不是让 `sessionWorkspaceRoot`
  // 的缺根异常穿过 tools/pre-execute 与 guard。
  (harness.ctx.huaanworkSessionRoots as Map<string, string>).delete(SESSION_ID);

  for (const mode of MODES) {
    harness.setMode(mode);
    for (const name of ["write", "edit", "read", ...KB_ORG_TOOLS]) {
      const result = await harness.preExecute(name, { path: "docs/d1.md" });
      assert.equal(result.kind, "deny", `${name} ${mode} pre-execute`);
      assert.match(String(result.reason ?? ""), /knowledge-organize-root-missing/, `${name} ${mode} pre-execute reason`);
      assert.match(
        String(harness.guard(name, { path: "docs/d1.md" }) ?? ""),
        /knowledge-organize-root-missing/,
        `${name} ${mode} guard`,
      );
    }
  }
});

// ── policy 直接判定:三个整理工具永不返回 ask ───────────────────────────────

test("kb_org_* decide branches never ask, attached or not", () => {
  for (const name of KB_ORG_TOOLS) {
    for (const mode of MODES) {
      assert.equal(
        preExecuteExplained({ name, args: {}, workspaceRoot: "/ws", attached: true }, mode).decision,
        "allow",
        `${name} ${mode} attached`,
      );
      assert.equal(
        preExecuteExplained({ name, args: {}, workspaceRoot: "/ws" }, mode).decision,
        "deny",
        `${name} ${mode} unattached`,
      );
      assert.equal(policyGuard({ name, args: {}, workspaceRoot: "/ws", attached: true }, mode), "allow");
      assert.equal(policyGuard({ name, args: {}, workspaceRoot: "/ws" }, mode), "deny");
    }
  }
});
