# 智能体包安全加固波次 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 关闭三智能体包评审登记的五项安全加固项（C4 childId fail-closed、holder required、M6 id 不对称、N-3 清理预算缺口、I3 maxDepth 字段级默认），全部落在 huaanwork 自有面，上游零修改。

**Architecture:** 五项均为既有 C1–C5 血缘沙箱的边界加固，不改主流时序行为。C4/holder 是 fail-closed 收紧；M6 经反证为 dormant（上游不变量封死），落 characterization 钉而非改读侧；N-3 把血缘/C5 条目清除延迟到子会话权威终结（`activation.result`），资源清理保持有界；I3 在组合后按字段补产品默认 maxDepth，且必须门控 config-editor 校验路径。每项 TDD（先红后绿），最终独立评审 + 全量门禁。

**Tech Stack:** TypeScript（cordis Context）、vitest、`@deepseek-ai/dsh-subagent`/`dsh-app-boot`（只读上游语义）。

**Spec:** 无独立 spec 文档；需求来源 = `docs/evidence/2026-11-11-three-agent-packages.md`〈评审修复波次〉与〈Task 11 独立评审〉、`AGENTS.md` 债表（I3/N-3 行）、本计划〈裁定与校准〉节。设计依据经只读调查反证（见各 Task 的机制锚点）。

## 裁定与校准（owner 2026-11-13）

- **I3 = 字段级合并**：组合后 subagent config 缺 `maxDepth` 时补产品默认 2，用户已写值保留。**必须门控 `hooks.profilePatches === undefined`**——否则破 config-editor 的 fail-closed 写入校验（`dsh-config-editor` :122 要求组合 config 逐字等于待写 raw config）。
- **N-3 = C5 条目延后到子会话终止**：资源清理仍按预算释放；血缘/C5 条目不在预算耗尽时清，改绑到 `activation.result` 权威结算。
- **M6 校准（重要）**：原评审列为「id 对齐」，经反证为 **dormant/不可达**——上游 `Session.id` 是 `header.id` 的 getter（`dsh-session` :1343-1346）、`agents.enter` 强制 `agent.id === session.id`（`dsh-agent` :514），真实注册 Agent 的写侧 header.id 与读侧 session.id??id 恒等。读侧 `sessionIdOfAgentRef` 被 9+ 模块消费、且在 `packages/huaanwork-policy/`（`dsh-plugin-huaanwork/src` 之外）。**故 M6 落 characterization 钉，不改读侧**；防御性对齐列为可选延后项（需 owner 另裁边界）。
- **范围 = 全 5 项一波**，按依赖/风险排序：C4 → holder → M6 → N-3 → I3 → 评审/门禁/登记。

## Global Constraints

- 上游 `deepseek-harness/` 子模块与 `@deepseek-ai/*` 包**零修改**；所有改动落 huaanwork 自有面（`dsh-plugin-huaanwork/src/**`、`dsh-plugin-huaanwork/tests/**`；M6 钉可落 `tests/huaanwork-guardrails/`）。
- 保持 C1–C5 既有不变量：直接包 child 正常时序零变化、legacy `@agent` 零变化、跨回合引用同一性隔离、清理幂等、孙代永不拿 call_host_tool/run_code。
- 每项先红后绿；最终门禁（`corepack yarn typecheck`/`test`/`check`）必须在最终代码树上执行，退出码落证据。
- 不改三包 SKILL 源文件、不改 manifest schema、不碰生产 profile/密钥/原目录（R6/R7/R-ACCEPT-1 边界）。
- 命名/文案沿用既有中文报错风格；fail-closed 报错须可诊断。

## File Structure

| 文件 | 责任 | 涉及 Task |
| --- | --- | --- |
| `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts` | C4 血缘分支 childId 缺席 fail-closed（start + activation 两入口） | 1 |
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts` | dispatch context holder required；N-3 血缘延迟清（`clearTurnLineage` + `activationResultSettled`） | 2, 4 |
| `dsh-plugin-huaanwork/tests/huaanwork-guardrails/package-subagent-lineage.spec.ts` | C4 fail-closed 钉 + M6 characterization 钉 | 1, 3 |
| `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts` | holder required 钉 + N-3 延迟清钉 | 2, 4 |
| `dsh-plugin-huaanwork/src/profile.ts` | I3 组合后字段级 maxDepth 默认（门控 editor 路径） | 5 |
| `dsh-plugin-huaanwork/tests/profile.spec.ts` | I3 sibling-only 翻 2 + editor 门控钉 | 5 |
| `docs/evidence/2026-11-11-three-agent-packages.md` / `AGENTS.md` | 加固波次证据 + 债表闭环 | 6 |

---

### Task 1: C4 血缘 childId 缺席 fail-closed

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts`（activation 血缘分支 :484-501；start 血缘分支 :351-362）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/package-subagent-lineage.spec.ts`

**Interfaces:**
- Consumes: `ctx.huaanworkPackageChildAllow`（Map）、`sessionIdOf`（skills.ts:551-558）、`run.dispose?.()`（activation）。
- Produces: 血缘分支在 childId 不可解析时抛 `Error("subagent lineage child id missing")`（activation 先 dispose）；主流时序（childId 在场）行为逐字节不变。

机制：activation 血缘分支当前把 `childSessionId !== undefined` 放在分支条件里（:488），缺席即静默跳过收窄 ⇒ 孙代持基线工具。上游契约保证 childId（`dsh-subagent` childId 必填），故 mainstream 不可达；加固为 fail-closed，与 parent-mismatch（:417-430）同形。

- [ ] **Step 1: 写失败测试（activation 血缘 childId 缺席 ⇒ 拒绝而非静默放行）**

在 `package-subagent-lineage.spec.ts` 追加（复用既有 `lineageHarness`/fake provider 基建；构造父会话有血缘条目、子 run 无 childId）：

```ts
test("C4 hardening: a lineage activation with no resolvable child id fails closed", async () => {
  const h = lineageHarness();
  h.childAllow.set("parent-session", ["read", "glob", "grep"]);
  // 父在血缘表里，但本次 activation 的 run 不暴露任何可解析 childId。
  const run = { localAgent: { ctx: { get: () => undefined } } }; // 无 childId/header.id
  h.activationResult = run;
  await expect(h.activate({ parent: "parent-session", childId: undefined }))
    .rejects.toThrow("subagent lineage child id missing");
  // 不得写入血缘条目（静默跳过会让孙代拿基线工具）。
  expect(h.childAllow.has("parent-session")).toBe(true); // 父条目不被误清
});
```

（若 `lineageHarness` 的 activate 签名不同，按既有 :484 分支的调用形态对齐；关键是父在血缘表、run 无 childId。）

- [ ] **Step 2: 跑测试确认红**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-guardrails/package-subagent-lineage.spec.ts -t "fails closed"`
Expected: FAIL — 当前静默跳过，activate resolve 而非 reject。

- [ ] **Step 3: 实现 activation 分支 fail-closed**

把 :484-501 分支条件中的 `childSessionId !== undefined &&` 移除，并在 `inherited !== undefined` 内、收窄之前加：

```ts
if (
  !packageApplied &&
  legacy === undefined &&
  run !== undefined &&
  parentFromCall !== undefined
) {
  const inherited = ctx.huaanworkPackageChildAllow?.get(parentFromCall);
  if (inherited !== undefined) {
    // C4 加固:血缘子会话无可解析 id 必须 fail-closed,不能静默保留基线工具
    // (mainstream 不可达:上游契约保证 childId)。与 parent-mismatch 同形。
    if (childSessionId === undefined) {
      try {
        await run?.dispose?.();
      } catch {
        // 释放失败不能顶替不一致错误,也不能留下未处理 rejection。
      }
      throw new Error("subagent lineage child id missing");
    }
    const childAgent = ctx.agents?.get?.(childSessionId) ?? run.localAgent;
    const tools = childAgent?.ctx?.get?.("tools");
    const schemas = tools?.schemas?.() ?? [];
    const existing = schemas.flatMap((schema) => (schema.name ? [schema.name] : []));
    const allow = inherited.filter((name) => existing.includes(name));
    tools?.restrict?.({ allow });
    ctx.huaanworkPackageChildAllow?.set(childSessionId, inherited);
  }
}
```

- [ ] **Step 4: start 分支同形加固**

把 :351-362 的 `if (childSessionId !== undefined) { ... }` 改为缺席即抛（start 路径无 activation.dispose，throw 由调用方错误路径收尾）：

```ts
if (!packageApplied && run?.localAgent && parentFromCall !== undefined && inherited !== undefined) {
  const childSessionId =
    sessionIdOf(run.localAgent.session?.header ?? run.localAgent) ?? sessionIdOf(run.localAgent);
  if (childSessionId === undefined) {
    throw new Error("subagent lineage child id missing");
  }
  const tools = run.localAgent.ctx?.get?.("tools");
  const schemas = tools?.schemas?.() ?? [];
  const existing = schemas.flatMap((s: { name?: string }) => (s.name ? [s.name] : []));
  const allow = inherited.filter((name) => existing.includes(name));
  tools?.restrict?.({ allow });
  ctx.huaanworkPackageChildAllow?.set(childSessionId, inherited);
}
```

- [ ] **Step 5: 跑新测试 + 既有矩阵确认绿**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-guardrails/package-subagent-lineage.spec.ts tests/huaanwork-guardrails/skills.spec.ts`
Expected: PASS — 新钉绿；既有八项矩阵与 skills.spec.ts 零改动全绿（childId 在场路径不变）。

- [ ] **Step 6: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/package-subagent-lineage.spec.ts
git commit -m "fix(guardrails): fail closed when a lineage child id is unresolvable (C4 hardening)"
```

---

### Task 2: dispatch context holder required

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts`（`AgentPackageDispatchContext` :70-85；dispatch 入口）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts`

**Interfaces:**
- Consumes: `installHuaanworkHolders`（holders.ts:172 恒初始化 `huaanworkPackageChildAllow`）。
- Produces: `AgentPackageDispatchContext.huaanworkPackageChildAllow` 由 optional 改 required；dispatch 入口断言 holder 在场（缺席响亮拒绝，与 `huaanworkSubagentRuns` 缺席拒绝同形）。

机制：cordis Context（holders.ts:50）已声明 required 且恒初始化，但 dispatch context 类型（host.ts:78）声明 optional，bindChild/releaseChildBindings/skills/policy 用 `?.` 防御 ⇒ 未来重构漏装 holder 会静默退化为「C1 允许 subagent 但 C4/C5 不生效」的沙箱绕过。加固为 required + 入口断言。

- [ ] **Step 1: 写失败测试（holder 缺席 ⇒ dispatch 响亮拒绝）**

```ts
test("dispatch refuses when the lineage allow holder is absent", async () => {
  const harness = runHarness({});
  // 抹掉 holder（模拟未来重构漏装），其余就绪。
  delete (harness.ctx as Record<string, unknown>).huaanworkPackageChildAllow;
  await expect(harness.dispatch("parent-session")).rejects.toThrow(/huaanworkPackageChildAllow/);
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/agent-package-runtime.spec.ts -t "holder is absent"`
Expected: FAIL — 当前 `?.` 静默 no-op，dispatch 不拒绝。

- [ ] **Step 3: 类型改 required + 入口断言**

host.ts:78 改为：

```ts
  /** 包回合血缘允许表(C2);恒由 installHuaanworkHolders 初始化,缺席即调用方装配回归。 */
  huaanworkPackageChildAllow: Map<string, readonly string[]>
```

在 dispatch 入口（`huaanworkSubagentRuns` 缺席拒绝的同一处）加：

```ts
if (ctx.huaanworkPackageChildAllow === undefined) {
  throw new Error("智能体包 dispatch 缺少 huaanworkPackageChildAllow holder（装配回归）");
}
```

（bindChild :738 / releaseChildBindings :779 的 `?.` 可保留为防御，但入口断言保证主流恒在场；类型 required 后编译期消费方需保证注入。）

- [ ] **Step 4: 跑测试确认绿 + 修编译消费方**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/agent-package-runtime.spec.ts && corepack yarn workspace dsh-plugin-huaanwork typecheck`
Expected: PASS。若 typecheck 报某消费方未注入 holder，按真实装配补注入（sessions.ts 传真实 cordis Context，恒含 holder）。

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts
git commit -m "fix(agent-package): require the lineage allow holder at dispatch (C2 hardening)"
```

---

### Task 3: M6 id 不对称 characterization 钉（dormant，不改读侧）

**Files:**
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/package-subagent-lineage.spec.ts`
- Read-only 参照: `packages/huaanwork-policy/src/channels.ts:2-7`（`sessionIdOfAgentRef`）、`skills.ts:551-558`（`sessionIdOf`）

**Interfaces:**
- Consumes: `sessionIdOfAgentRef`（`@huaanwork/policy/channels`）。
- Produces: 两条 characterization 钉——真实 Agent 形状写读恒等；合成 ref 的潜在不对称（真实不可达）。**不改读侧**（blast radius 9+ 模块、dormant）。

机制（反证已坐实）：`Session.id` 是 `header.id` getter（dsh-session:1343-1346）、`agents.enter` 强制 `agent.id === session.id`（dsh-agent:514）⇒ 真实注册 Agent 写侧 header.id 与读侧 session.id??id 恒等，C5 lookup 不会因 id 形状 miss。

- [ ] **Step 1: 写 characterization 钉（先确认其描述当前行为）**

```ts
import { sessionIdOfAgentRef } from "@huaanwork/policy/channels";

test("M6 characterization: writer header.id and reader session.id converge for a real Agent", () => {
  const header = { id: "child-uuid" };
  const session = { header, get id() { return this.header.id; } };
  const agent = { id: "child-uuid", session };
  expect(sessionIdOfAgentRef(agent as never)).toBe("child-uuid");
  expect(header.id).toBe(session.id); // 上游不变量 ⇒ 无 miss
});

test("M6 latent asymmetry only manifests for a synthetic ref no registered Agent can take", () => {
  const synthetic = { id: "other", session: { header: { id: "real-child" } } };
  expect(sessionIdOfAgentRef(synthetic as never)).toBe("other"); // 读侧 miss real-child（真实不可达）
});
```

- [ ] **Step 2: 跑测试确认绿（characterization 钉描述既有行为，应直接绿）**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-guardrails/package-subagent-lineage.spec.ts -t "M6"`
Expected: PASS。若第二钉不绿，说明读侧形状与调查不符，停止并复核 channels.ts（不静默改钉）。

- [ ] **Step 3: 在钉注释登记 dormant 结论与延后项**

注释写明：上游不变量封死、读侧对齐为可选延后（需 owner 裁边界，因 `sessionIdOfAgentRef` 在 `packages/huaanwork-policy/` 且 9+ 模块消费）。

- [ ] **Step 4: Commit**

```bash
git add dsh-plugin-huaanwork/tests/huaanwork-guardrails/package-subagent-lineage.spec.ts
git commit -m "test(guardrails): pin M6 id-resolution invariant (dormant; reader unchanged)"
```

---

### Task 4: N-3 血缘/C5 条目延迟到子会话权威终结

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts`（`turnAllow` :620；`releaseChildBindings` :757-785；result 观察者 :1076-1087）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts`

**Interfaces:**
- Consumes: `activation.result`（权威终结信号，结算晚于 manager teardown，注释 :807-808）、`turnAllow` 引用同一性。
- Produces: 具名闭包 `clearTurnLineage()`；flag `activationResultSettled`；`releaseChildBindings` 仅在 `activation === undefined || activationResultSettled` 时清血缘；result 观察者两分支置 flag + 清血缘。资源清理（dispose/stop/detach/registry）一律不动、仍有界。

机制：子会话熬过 result 预算（10min）+ dispose 预算（10min）后，:850 仍按引用清其 C5 条目 ⇒ 余生失去执行期拒绝。`refreshAgentRestrict` 不读血缘表（schema 收窄独立相交层），故只需延迟血缘表清除这一步。

- [ ] **Step 1: 写失败测试（子会话熬过预算 ⇒ C5 条目保留 ⇒ 终结后才清）**

```ts
test("N-3: a child outliving the cleanup budget keeps its C5 lineage entry until it terminates", async () => {
  const result = deferred<unknown>();
  const childAllow = new Map<string, readonly string[]>();
  const harness = runHarness({
    cleanupTimeoutMs: 20,
    startActivation: async (spec) => ({
      childId: spec.childId ?? "child",
      result: result.promise, // 清理期间永不结算
      dispose: async () => { await new Promise((r) => setTimeout(r, 60)); }, // 熬过 20ms dispose 预算
    }),
  });
  harness.ctx.huaanworkPackageChildAllow = childAllow;
  const dispatched = await harness.dispatch("parent-session");
  const request = (harness.ctx.huaanworkAgentPackageRequest as { current: { childId: string; allow: readonly string[] } }).current!;
  const childId = request.childId, allow = request.allow;
  expect(childAllow.get(childId)).toBe(allow);

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try { await dispatched.afterIdle(); } finally { errorSpy.mockRestore(); }

  expect(childAllow.get(childId)).toBe(allow); // 旧实现此处已被清 ⇒ 红
  result.resolve({ stopReason: "completed" }); // 真正终结
  await flushMicrotasks(() => !childAllow.has(childId));
  expect(childAllow.has(childId)).toBe(false); // 观察者延迟清
});
```

（`runHarness`/`deferred`/`flushMicrotasks` 为既有基建 :1335-1381/:1292/:1312；若字段名不同按现值对齐。）

- [ ] **Step 2: 跑测试确认红**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/agent-package-runtime.spec.ts -t "N-3"`
Expected: FAIL — `afterIdle()` 后条目已被清（`childAllow.get(childId)` 为 undefined）。

- [ ] **Step 3: 抽 clearTurnLineage + flag**

在 :620 `turnAllow` 旁加：

```ts
let turnAllow: readonly string[] | undefined
// N-3: 权威 activation.result 是否已结算(子会话真正终结)。未结算前,预算耗尽的清理不得清血缘。
let activationResultSettled = false
```

在 `releaseChildBindings` 之前加具名闭包：

```ts
const clearTurnLineage = (): void => {
  const allowTable = ctx.huaanworkPackageChildAllow
  if (allowTable !== undefined && turnAllow !== undefined) {
    for (const [childSessionId, bound] of allowTable) {
      if (bound === turnAllow) allowTable.delete(childSessionId)
    }
  }
}
```

- [ ] **Step 4: releaseChildBindings 条件清 + 观察者延迟清**

把 releaseChildBindings 内 :779-784 替换为：

```ts
// N-3: 子会话已终结(或从未启动)才现在清血缘;熬过预算仍在跑的子会话保留 C5 条目,
// 由 activation.result 观察者在真正终结时清。引用同一性保跨回合隔离。
if (activation === undefined || activationResultSettled) clearTurnLineage()
```

result 观察者 :1076-1087 两分支各加 flag + 清理：

```ts
void activation.result.then(
  (result) => {
    activationResultSettled = true
    clearTurnLineage()
    subagentRuns.settleResult(runId, { stopReason: stopReasonOfResult(result) })
    confirmObservedCleanup()
  },
  (error) => {
    activationResultSettled = true
    clearTurnLineage()
    subagentRuns.rejectResult(runId, error instanceof Error ? error.message : String(error))
    confirmObservedCleanup()
  },
)
```

- [ ] **Step 5: 补跨回合隔离钉（延迟清不误删复用 id 的新回合）**

仿既有 :1604，但首回合 result 熬过预算、第二回合先跑并写新引用；首回合 result 后结算 ⇒ 只清首回合引用。断言 `childAllow.get(secondChildId) === secondAllow`。

- [ ] **Step 6: 跑新测试 + 既有预算/血缘测试确认绿**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/agent-package-runtime.spec.ts`
Expected: PASS — N-3 两钉绿；既有 :929（result 立即 resolve）、:1604、A-08 :1735 全绿（runHarness 默认 ctx 不含 holder，预算类测试不受影响）。

- [ ] **Step 7: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts
git commit -m "fix(agent-package): defer lineage C5 cleanup to child termination (N-3)"
```

---

### Task 5: I3 subagent.maxDepth 字段级产品默认（门控 editor 路径）

**Files:**
- Modify: `dsh-plugin-huaanwork/src/profile.ts`（:1660 `assertPtcPresetPresentation(rows)` 之后）
- Test: `dsh-plugin-huaanwork/tests/profile.spec.ts`

**Interfaces:**
- Consumes: `rows`（组合后 Map）、`rowConfig()`（:1082-1087）、`DESKTOP_SUBAGENT_MAX_DEPTH`（:121 = 2）、`hooks.profilePatches`（editor 校验路径标志）。
- Produces: 真实 boot/HMR/包操作路径（`hooks.profilePatches === undefined`）下，组合后 subagent config 缺 maxDepth 时追加 `{ id:'subagent', config:{ ...existing, maxDepth:2 } }`；editor 校验路径跳过。弱默认行 :1540 保留。

机制：上游 `applyEntryPatches` 整条替换 config（dsh-app-boot:104-107），用户只存同族字段时弱默认行被替换掉 ⇒ maxDepth 回落 schema 默认 1。**关键约束**：无条件 fixup 会破 config-editor fail-closed 校验（dsh-config-editor:122 要求组合 config 逐字等于待写 raw config）⇒ 必须门控 `hooks.profilePatches === undefined`（profile.ts:1694/:1709 已用此模式）。

- [ ] **Step 1: 写失败测试（磁盘/boot 路径 sibling-only ⇒ 翻 2）**

把既有 :211-222「drops the product default ... sibling field」用例从 profilePatches 路径改写为磁盘/boot 路径（真实 bug 形态）：

```ts
it("fills the product default maxDepth when a persisted user row carries only a sibling field", () => {
  const home = temporaryHome();
  const dir = ensureDesktopProfile(home);
  writeFileSync(join(dir, "cordis.patch.yml"), "- id: subagent\n  config:\n    maxActiveSubagents: 4\n");
  const prepared = prepareDesktopProfile(undefined, home, "darwin"); // 无 profilePatches ⇒ boot 路径
  expect(effectiveSubagentMaxDepth(prepared)).toBe(2); // 旧实现为 1 ⇒ 红
  const row = composeEntries([prepared.patches]).find((e) => e.id === "subagent");
  expect((row?.config as Record<string, unknown>).maxActiveSubagents).toBe(4); // 同族字段保留
});
```

（`effectiveSubagentMaxDepth` 为既有助手 :95-100；`temporaryHome`/`ensureDesktopProfile` 按现值对齐。）

- [ ] **Step 2: 跑测试确认红**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/profile.spec.ts -t "sibling field"`
Expected: FAIL — 有效值为 1。

- [ ] **Step 3: 实现门控 fixup**

在 profile.ts:1660 `assertPtcPresetPresentation(rows)` 之后、:1661 读 settings 行之前加：

```ts
// I3: subagent.maxDepth 字段级产品默认。上游 applyEntryPatches 对 config 整条替换,
// 用户只存同族字段时会丢弱默认行、回落 schema 默认 1。仅在 maxDepth 缺席时补 2,
// 保留用户已写的每个字段。门控:config editor 的 pending-write 校验(hooks.profilePatches)
// 必须跳过——其 fail-closed 判据(dsh-config-editor:122)要求组合 config 逐字等于待写 raw
// config,补默认会让清除写入被判 "overridden by a home patch"。真实 boot/HMR/包操作才应用。
if (hooks.profilePatches === undefined) {
  const subagentRow = rows.get("subagent");
  const subagentConfig = rowConfig(subagentRow);
  if (subagentRow !== undefined && subagentConfig.maxDepth === undefined) {
    patches.push({ id: "subagent", config: { ...subagentConfig, maxDepth: DESKTOP_SUBAGENT_MAX_DEPTH } });
  }
}
```

- [ ] **Step 4: 补 editor 门控钉**

```ts
it("skips the maxDepth fixup on the config-editor pending-write composition", () => {
  const home = temporaryHome();
  const pending = prepareDesktopProfile(undefined, home, "darwin", "desktop", undefined, undefined, {
    profilePatches: [{ id: "subagent", config: { maxActiveSubagents: 4 } }],
  });
  expect(effectiveSubagentMaxDepth(pending)).toBe(1); // editor 校验路径不得补默认
});
```

- [ ] **Step 5: 跑测试确认绿（含既有开箱/保存值钉）**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/profile.spec.ts`
Expected: PASS — sibling-only 翻 2、editor 门控钉绿；开箱=2（:153-163）、saved maxDepth=3（:195-209）、depth 算术（:184-193）零改动全绿（maxDepth 已在 ⇒ fixup 跳过）。

- [ ] **Step 6: Commit**

```bash
git add dsh-plugin-huaanwork/src/profile.ts dsh-plugin-huaanwork/tests/profile.spec.ts
git commit -m "fix(profile): field-level product default for subagent.maxDepth, gated off editor validation (I3)"
```

---

### Task 6: 独立评审 + 最终门禁 + 证据/债表闭环

**Files:**
- Modify: `docs/evidence/2026-11-11-three-agent-packages.md`（追加〈安全加固波次〉节）、`AGENTS.md`（I3/N-3 债行标闭环 + C4/holder/M6 登记）

- [ ] **Step 1: 独立评审**

对 skills.ts/host.ts/profile.ts 改动走 requesting-code-review，结论经反证与严重度校准；重点核 C4/holder 主流时序零变化、N-3 跨回合隔离与永久卡死残余、I3 editor 门控正确性。

- [ ] **Step 2: 最终门禁（最终代码树）**

Run: `corepack yarn typecheck && corepack yarn test && corepack yarn check`
Expected: 三条 exit 0；退出码/计数落证据。`verify:aa` 竞态若现，隔离重跑并如实记录。

- [ ] **Step 3: I3 瞬态集成核实（条件允许时）**

真实走 ConfigEditor.edit 清除 maxDepth（同族字段在场），断言不抛 "overridden by a home patch"；并核实「清除后立即派 lane」是否撞短暂 maxDepth=1（editor 写后到下次磁盘重组的窗口）。无环境则记 BLOCKED，不声称已验证。

- [ ] **Step 4: 回填证据 + 债表闭环**

证据追加〈安全加固波次〉：五项 commit/测试/退出码、M6 dormant 反证、N-3 永久卡死残余登记、I3 瞬态窗口结论。AGENTS.md：I3/N-3 行标「已加固（计划链接）」，C4/holder 登记为已闭环，M6 登记 characterization（防御性对齐延后）。

- [ ] **Step 5: Commit**

```bash
git add docs/evidence/2026-11-11-three-agent-packages.md AGENTS.md
git commit -m "docs(evidence): record security hardening wave gates and close I3/N-3 debts"
```

---

## Self-Review

**1. 需求覆盖**：C4 childId（Task 1）、holder required（Task 2）、M6（Task 3，校准为 characterization）、N-3（Task 4）、I3（Task 5）、评审/门禁/登记（Task 6）——五项全覆盖。

**2. 占位符扫描**：各 Task 含实际代码与测试断言；少数 harness 字段名注明「按现值对齐」（因测试基建签名需执行期核对），非行为占位。

**3. 类型/命名一致**：`clearTurnLineage`/`activationResultSettled`（Task 4）前后一致；`huaanworkPackageChildAllow` required（Task 2）与消费方一致；`DESKTOP_SUBAGENT_MAX_DEPTH`/`rowConfig`/`hooks.profilePatches`（Task 5）与 profile.ts 现值一致。

**4. 已知残余（如实登记，非阻断）**：
- N-3：永久卡死（result 永不结算）子会话的血缘条目常驻至 Host teardown——安全正确取舍，条目数受真实存活子会话数上界约束。
- I3：editor 清除后到下次磁盘重组的瞬态 maxDepth=1 窗口——需 Task 6 Step 3 集成/真机核实。
- M6：防御性读侧对齐延后（dormant、blast radius 大、模块在 src 之外），需 owner 另裁。

## Execution Handoff

计划已落盘。两种执行方式：
1. **Subagent-Driven（推荐）**：每 Task 派新 subagent 实现 + 两阶段评审，快速迭代。
2. **Inline Execution**：本会话按 executing-plans 批量执行 + 检查点评审。