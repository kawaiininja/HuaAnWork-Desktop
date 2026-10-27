# HuaAnWork 子代理运行可观测性与定向终止 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为显式 legacy `@agent` 与智能体包 `@slug` 增加可信的运行卡、定向终止、重连对账与完整键盘/读屏体验，不改变父会话取消语义。

**Architecture:** Host `subagent-runs.ts` 是唯一权威运行状态面；legacy 与 package 执行链只向它上报事实，guardrails 把上游生命周期和 child 活动投影进去。客户端用独立 reducer 消费 WS/snapshot，用独立 UI Map 保存展开偏好，并用 `clientMessageId` 把卡片锚定到本次用户消息之后。

**Tech Stack:** TypeScript ESM、Cordis、DeepSeek Harness rc.1、React 18、Vitest/jsdom、Electron；不新增依赖。

## Global Constraints

- 设计真相源：`docs/superpowers/specs/2026-10-26-subagent-run-visibility-design.md`；基线外层 HEAD `692f12f507`，Harness pin `1600d8a1e140dcde43a1a0941940a0480712c011`。
- 不修改 `deepseek-harness/`、`dsh-plugin-desktop/src/`、`dsh-plugin-desktop-beta/src/`；不新增 variant 白名单。
- 使用 Node.js `^22.19.0` 或 `>=24.0.0`，经 Corepack 使用 Yarn `4.18.0`；所有测试和门禁保持 headless。
- Host `runId` 是取消与对账主键；`clientMessageId` 只是用户消息锚点，不是取消 capability，也不替代 `runId`。
- `subagent.cancel` 必须同时匹配 `parentSessionId + runId`；跨父会话按未找到处理且零副作用；禁止退化为父 Agent、`cancelBySessionId`、`cancelBySlug` 或全 children 取消。
- `stopped` 只有在真实执行终结与该路径所需清理确认后才能发布；RPC accepted、abort、dispose 发起都不是 stopped。
- 投影不携带 prompt、reasoning/token 正文、工具参数/输出、最终回答或原始错误堆栈。
- 600000ms 仍是父 idle 后的 activation 收尾预算，不是任务 SLA；本轮不新增自动任务超时、自动重试、强制 OS kill、嵌套子代理树或控制面持久化。
- 卡片、焦点、读屏、色彩、字阶、44×44 命中区、窄窗口与 reduced-motion 均以设计 §6.1 为准；运行卡提醒禁用琥珀。
- 所有 root 门禁串行执行，不并行跑 `corepack yarn check` / `corepack yarn test`，避免既有 lib 重建竞态。
- 每个任务的 commit 步骤只有在用户明确要求提交时才执行；否则跳过提交并保留工作树变更。图形应用只在最终人工验收且用户明确同意后启动。

---

## File Structure

**新增 Host / 契约**
- `dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts`：registry、状态机、精确取消、结构化提醒、snapshot 与有界历史。
- `dsh-plugin-huaanwork/tests/huaanwork-host/subagent-runs.spec.ts`：registry 全部状态与竞态测试。

**修改 Host 接线**
- `src/client-huaanwork/rpc-types.ts`：run 投影、snapshot、cancel 应答与 WS 事件类型。
- `src/huaanwork-host/{holders.ts,index.ts,routes.ts,sessions.ts,agent-invoke.ts,subagents-service.ts}`：registry 注入、RPC、legacy 执行链与调用元数据。
- `src/huaanwork-host/agent-package/{host.ts,types.ts}`：package 执行链、清理确认与 `runId` 传递。
- `src/huaanwork-guardrails/{skills.ts,bridge.ts}`：upstream start/end 配对、child 活动转投影并隔离父消息流。
- `src/client-huaanwork/api.ts`：`subagent.list/cancel` HTTP 映射。

**新增客户端**
- `src/client-huaanwork/logic/subagentRuns.ts`：reducer、对账、文案、计时、提醒与工具摘要纯函数。
- `src/client-huaanwork/SubagentRunCard.tsx`：活跃/终态/失效卡、二次确认、焦点与读屏。
- `tests/client-huaanwork/{subagentRuns.spec.ts,SubagentRunCard.spec.ts}`：客户端纯逻辑与 jsdom 组件测试。

**修改客户端与验收**
- `src/client-huaanwork/{App.tsx,styles.css}` 与生成物 `styles.generated.ts`。
- `tests/huaanwork-host/{route-contract.spec.ts,sessions.spec.ts}`、`tests/huaanwork-guardrails/{skills.spec.ts,bridge.spec.ts}`、`tests/client-huaanwork/styles-generated.spec.ts`。
- `docs/evidence/2026-10-26-subagent-run-visibility-verification.md`：真实组合与平台证据。

---

### Task 1: 共享契约与 registry 核心状态机

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts`
- Create: `dsh-plugin-huaanwork/tests/huaanwork-host/subagent-runs.spec.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`

**Interfaces:**
- Consumes: 现有 `RpcEvent` union 与 `SubagentActivationHandle.result`。
- Produces: `SubagentRunProjection`、`SubagentRunSnapshot`、`subagent/run[-remove]` WS 事件、`createSubagentRunRegistry()`，以及 Task 2 将扩展的 `SubagentRunRegistry`。

- [ ] **Step 1: 写核心状态机的失败测试**

```ts
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createSubagentRunRegistry } from '../../src/huaanwork-host/subagent-runs.ts'

test('child activity drives phases and result wins a conflicting upstream end', () => {
  let now = 1_000
  const events: unknown[] = []
  const registry = createSubagentRunRegistry({ now: () => now, activityFlushMs: 0, emit: (event) => events.push(event) })
  const runId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@review', clientMessageId: '42' })
  registry.reserveChild(runId, 'child-1')
  registry.noteReasoning('child-1')
  assert.equal(registry.get(runId)?.phase, 'reasoning')
  registry.startTool('child-1', { callId: 'call-1', name: 'read_file' })
  registry.startTool('child-1', { callId: 'call-2', name: 'grep' })
  registry.endTool('child-1', { callId: 'call-1', name: 'read_file' })
  assert.deepEqual(registry.get(runId)?.activeTools.map((tool) => tool.callId), ['call-2'])
  registry.endTool('child-1', { callId: 'call-2', name: 'grep' })
  assert.equal(registry.get(runId)?.phase, 'generating')
  registry.childIdle('child-1')
  assert.equal(registry.get(runId)?.phase, 'finalizing')
  registry.bindUpstreamStart({ hostRunId: runId, upstreamRunId: 'upstream-1', childId: 'child-1' })
  registry.settleResult(runId, { stopReason: 'completed' })
  registry.settleUpstreamEnd({ upstreamRunId: 'upstream-1', stopReason: 'error' })
  const run = registry.get(runId)
  assert.equal(run?.phase, 'completed')
  assert.equal(run?.stopReason, 'completed')
  assert.deepEqual(run?.cleanupWarnings, [{ code: 'upstream-end-error', severity: 'error' }])
  assert.equal(now, 1_000)
})
```

补 `end` 先到的反向顺序与 result rejection 两种顺序。`end` 先到只能保存候选结果，不得先发布 `failed` 再翻转：

```ts
test('upstream end first waits for result arbitration', () => {
  const registry = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined })
  const runId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@review' })
  registry.reserveChild(runId, 'child-end-first')
  registry.childIdle('child-end-first')
  registry.bindUpstreamStart({ hostRunId: runId, upstreamRunId: 'upstream-end-first', childId: 'child-end-first' })
  registry.settleUpstreamEnd({ upstreamRunId: 'upstream-end-first', stopReason: 'error' })
  assert.equal(registry.get(runId)?.phase, 'finalizing')
  assert.equal(registry.get(runId)?.endedAt, undefined)
  registry.settleResult(runId, { stopReason: 'completed' })
  assert.equal(registry.get(runId)?.phase, 'completed')
  assert.equal(registry.get(runId)?.stopReason, 'completed')
  assert.deepEqual(registry.get(runId)?.cleanupWarnings, [{ code: 'upstream-end-error', severity: 'error' }])
})

test('result rejection uses upstream end in either arrival order', () => {
  for (const endFirst of [true, false]) {
    const registry = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined })
    const runId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@review' })
    registry.reserveChild(runId, 'child-rejection')
    registry.childIdle('child-rejection')
    registry.bindUpstreamStart({ hostRunId: runId, upstreamRunId: 'upstream-rejection', childId: 'child-rejection' })
    if (endFirst) {
      registry.settleUpstreamEnd({ upstreamRunId: 'upstream-rejection', stopReason: 'error' })
      assert.equal(registry.get(runId)?.phase, 'finalizing')
      registry.rejectResult(runId, 'activation infrastructure failed')
    } else {
      registry.rejectResult(runId, 'activation infrastructure failed')
      assert.equal(registry.get(runId)?.phase, 'finalizing')
      registry.settleUpstreamEnd({ upstreamRunId: 'upstream-rejection', stopReason: 'error' })
    }
    assert.equal(registry.get(runId)?.phase, 'failed')
    assert.equal(registry.get(runId)?.stopReason, 'error')
    assert.equal(registry.get(runId)?.failure, 'activation infrastructure failed')
  }
})
```

补停止闩、清理确认和自然终态后清理失败的状态机测试。`confirmCleanup(ok:true)` 本身不证明执行已终结：

```ts
test('stopping absorbs execution outcomes until execution and cleanup are both confirmed', async () => {
  for (const stopReason of ['completed', 'error', 'max-tokens', 'refusal', 'aborted']) {
    const registry = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined })
    const runId = registry.begin({ parentSessionId: 'parent', kind: 'package', label: '@pkg' })
    await registry.requestCancel('parent', runId)
    registry.settleResult(runId, { stopReason })
    assert.equal(registry.get(runId)?.phase, 'stopping')
    assert.equal(registry.get(runId)?.stopReason, stopReason)
    registry.confirmCleanup(runId, { ok: true, warnings: [] })
    assert.equal(registry.get(runId)?.phase, 'stopped')
  }

  const registry = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined })
  const rejectionId = registry.begin({ parentSessionId: 'parent', kind: 'package', label: '@pkg' })
  await registry.requestCancel('parent', rejectionId)
  registry.rejectResult(rejectionId, 'activation infrastructure failed')
  assert.equal(registry.get(rejectionId)?.phase, 'stopping')
  registry.confirmCleanup(rejectionId, {
    ok: false,
    warnings: [{ code: 'runtime-stop-failed', severity: 'error' }],
  })
  assert.equal(registry.get(rejectionId)?.phase, 'stopping')
  registry.confirmCleanup(rejectionId, { ok: true, warnings: [] })
  assert.equal(registry.get(rejectionId)?.phase, 'stopped')
  assert.equal(registry.get(rejectionId)?.failure, 'activation infrastructure failed')

  const startupFailureId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@legacy' })
  await registry.requestCancel('parent', startupFailureId)
  registry.failRun(startupFailureId, 'startup aborted')
  assert.equal(registry.get(startupFailureId)?.phase, 'stopping')
  registry.confirmCleanup(startupFailureId, { ok: true, warnings: [] })
  assert.equal(registry.get(startupFailureId)?.phase, 'stopped')

  const earlyCleanupId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@early-cleanup' })
  await registry.requestCancel('parent', earlyCleanupId)
  registry.confirmCleanup(earlyCleanupId, { ok: true, warnings: [] })
  assert.equal(registry.get(earlyCleanupId)?.phase, 'stopping')
  registry.settleResult(earlyCleanupId, { stopReason: 'aborted' })
  registry.confirmCleanup(earlyCleanupId, { ok: true, warnings: [] })
  assert.equal(registry.get(earlyCleanupId)?.phase, 'stopped')
})

test('cleanup failure after a natural terminal only appends warnings', () => {
  const registry = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined })
  const runId = registry.begin({ parentSessionId: 'parent', kind: 'package', label: '@pkg' })
  registry.settleResult(runId, { stopReason: 'completed' })
  registry.confirmCleanup(runId, {
    ok: false,
    warnings: [{ code: 'runtime-stop-failed', severity: 'error' }],
  })
  assert.equal(registry.get(runId)?.phase, 'completed')
  assert.deepEqual(registry.get(runId)?.cleanupWarnings, [{ code: 'runtime-stop-failed', severity: 'error' }])
})
```

补 Host `lastActivity` 写入边界；start/end/cancel/snapshot 与 child idle 不得刷新它：

```ts
test('lastActivity only tracks selected child execution activity', () => {
  let now = 1_000
  const registry = createSubagentRunRegistry({ now: () => now, activityFlushMs: 0, emit: () => undefined })
  const runId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@review' })
  assert.equal(registry.get(runId)?.lastActivity, undefined)
  registry.reserveChild(runId, 'child-activity')
  registry.bindUpstreamStart({ hostRunId: runId, upstreamRunId: 'upstream-activity', childId: 'child-activity' })
  assert.equal(registry.get(runId)?.lastActivity, undefined)
  now = 1_001
  registry.noteReasoning('child-activity')
  assert.equal(registry.get(runId)?.lastActivity, 1_001)
  now = 1_002
  registry.childIdle('child-activity')
  assert.equal(registry.get(runId)?.lastActivity, 1_001)
  now = 1_003
  registry.startTool('child-activity', { callId: 'call-activity', name: 'read_file' })
  assert.equal(registry.get(runId)?.lastActivity, 1_003)
  now = 1_004
  registry.endTool('child-activity', { callId: 'call-activity', name: 'read_file' })
  assert.equal(registry.get(runId)?.lastActivity, 1_004)
  now = 1_005
  registry.settleResult(runId, { stopReason: 'completed' })
  registry.snapshot('parent')
  assert.equal(registry.get(runId)?.lastActivity, 1_004)
})
```

在同一测试文件中加入以下断言，覆盖非成功原因与终态不复活：

```ts
for (const reason of ['max-tokens', 'refusal', 'future-unknown-reason']) {
  const id = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@other' })
  registry.settleResult(id, { stopReason: reason })
  assert.equal(registry.get(id)?.phase, 'failed')
}
const budgetId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@budget' })
registry.settleResult(budgetId, { stopReason: 'completed' })
registry.noteCleanupBudget(budgetId, 5000)
assert.equal(registry.get(budgetId)?.phase, 'completed')
assert.equal(registry.get(budgetId)?.cleanupBudgetMs, 5000)
const budgetCompletionId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@budget-completion' })
registry.noteCleanupBudget(budgetCompletionId, 5000)
assert.equal(registry.get(budgetCompletionId)?.phase, 'stopping')
registry.settleResult(budgetCompletionId, { stopReason: 'completed' })
assert.equal(registry.get(budgetCompletionId)?.phase, 'completed')
assert.equal(registry.get(budgetCompletionId)?.cleanupBudgetMs, 5000)
registry.noteToken('child-1')
assert.equal(registry.get(runId)?.phase, 'completed')
```

`普通父会话 idle 不得触发 finalizing` 在 Task 7 用 `agent/status` 的 parent/child 两个 payload 分别验证，避免在 registry 中发明一个并不存在的 parentIdle API。

- [ ] **Step 2: 运行测试并确认因实现不存在而失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/subagent-runs.spec.ts`
Expected: FAIL，错误为无法解析 `../../src/huaanwork-host/subagent-runs.ts`。

- [ ] **Step 3: 写共享类型与最小核心实现**

`rpc-types.ts` 增加：

```ts
export type SubagentRunPhase = 'starting' | 'reasoning' | 'generating' | 'tool' | 'finalizing' | 'stopping' | 'completed' | 'failed' | 'stopped'
export type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal' | 'unknown'
export type SubagentCleanupWarning = { code: string; severity: 'info' | 'error' }
export type SubagentToolActivity = { id: string; callId?: string; name: string; startedAt: number }
export type SubagentRunProjection = {
  runId: string
  parentSessionId: string
  clientMessageId?: string
  childId?: string
  upstreamRunId?: string
  kind: 'legacy' | 'package'
  label: string
  packageVersion?: string
  phase: SubagentRunPhase
  activeTools: SubagentToolActivity[]
  startedAt: number
  endedAt?: number
  lastActivity?: number
  stopRequestedAt?: number
  stopReason?: SubagentStopReason
  stopCause?: 'targeted-cancel' | 'cleanup-budget' | 'aborted'
  cleanupBudgetMs?: number
  cleanupWarnings: SubagentCleanupWarning[]
  failure?: string
  generation: string
  revision: number
}
export type SubagentRunSnapshot = { generation: string; revision: number; runs: SubagentRunProjection[] }
export type SubagentCancelResult = { status: 'accepted' | 'already-terminal'; runId: string }
```

`RpcEvent` 增加 `{ event: 'subagent/run'; run: SubagentRunProjection }` 与 `{ event: 'subagent/run-remove'; runId: string; parentSessionId: string; generation: string; revision: number }`。

`subagent-runs.ts` 先定义构造参数与核心 API：

```ts
export type SubagentRunRegistryOptions = {
  now?: () => number
  activityFlushMs?: number
  terminalPerParent?: number
  terminalGlobal?: number
  emit(event: RpcEvent): void
}

export interface SubagentRunRegistry {
  begin(input: { parentSessionId: string; kind: 'legacy' | 'package'; label: string; packageVersion?: string; clientMessageId?: string }): string
  get(runId: string): SubagentRunProjection | undefined
  parentSessionIdOf(runId: string): string | undefined
  reserveChild(runId: string, childId: string): void
  bindActivation(runId: string, input: { childId: string }): void
  bindUpstreamStart(input: { hostRunId?: string; upstreamRunId: string; childId: string }): void
  ownsChild(childId: string): boolean
  noteReasoning(childId: string): void
  noteToken(childId: string): void
  startTool(childId: string, tool: { callId?: string; name: string }): void
  endTool(childId: string, tool: { callId?: string; name: string }): void
  childIdle(childId: string): void
  noteChildError(childId: string, message: string): void
  settleResult(runId: string, result: { stopReason: string }): void
  rejectResult(runId: string, message: string): void
  settleUpstreamEnd(input: { upstreamRunId: string; stopReason: string }): void
  failRun(runId: string, message: string): void
  noteCleanupBudget(runId: string, budgetMs: number): void
  confirmCleanup(runId: string, input: { ok: boolean; warnings: SubagentCleanupWarning[] }): void
}
```

实现要求按以下规则固定，不得由实施者自行选择另一套终态语义：

- 构造 registry 时生成一次 `generation`，该 registry 的所有 run 共享；`begin` 只生成新的 Host `runId`；revision 全 registry 单调递增。工具活动使用内部 `id`，`callId` 缺席时生成；`tool/end` 有 callId 精确匹配、无 callId 只结束同名最早在途项。预留 childId 与 activation 实际 childId 不同时重绑定并迁移活动。
- 内部独立记录 `resultState: 'pending' | 'resolved' | 'rejected'`、待仲裁 upstream end、执行已终结与清理已确认；这些内部状态不上 wire。`settleResult` 表示权威 result **resolve**，`rejectResult` 只表示 `activation.result` **reject**，`failRun` 只表示启动/外层执行链失败，三者不得混用。
- `settleResult`、`rejectResult` 与 `settleUpstreamEnd` 幂等，冲突始终按 D2 以 resolved result 为准。`settleUpstreamEnd` 在 result 仍 pending 时只保存候选 end，保持当前非终态且不写 `endedAt`；resolved result 到达后再定终态。result 已 resolved 时，后到的 end 只补身份与告警。`end.stopReason === 'error'` 与 resolved result 不一致时追加一次 `upstream-end-error` error warning；不得把 result rejection 自带的 error 误记成清理冲突。已发布的终态不得因后到 end 翻转。
- `rejectResult` 记录 `failure` 与执行已终结；无停止闩且 run 尚未终态时，已有候选 end 则按 end 的 stopReason 结算，已绑定 upstreamRunId 但 end 未到则保持非终态并等待 end，未绑定 upstreamRunId 才由 rejection 单独定为 `failed`。`failRun` 不等待 upstream end：非终态且无停止闩时定为 `failed`，有停止闩时只记录 failure 与执行已终结。
- 定向停止闩已存在时，`settleResult`（包括 completed）、`rejectResult` 与 `failRun` 都只保留原始 stopReason/failure 和执行终结事实，不得退出 `stopping`。其他原因已进入 `stopping` 时，非 completed 结果同样不得把它改为 `failed`；收尾预算路径若收到权威 completed，则按自然执行结果定为 `completed`，清理告警独立保留。已终态 run 不因迟到 activity、result、rejection、failRun 或 upstream end 复活或改相，只允许按规则补缺失身份与清理告警。
- `confirmCleanup({ok:false})` 只追加结构化 warnings；在 `stopping` 下保持 `stopping`，在 completed/failed/stopped 下不得改变 phase。`confirmCleanup({ok:true})` 在 `stopping` 下还必须看到执行已终结或启动已因取消拒绝，才能转为 `stopped`；仅有 cancel 闭包 resolve、abort 或 dispose 发起不够。晚到的成功确认可以在此前失败后继续收敛。
- `noteCleanupBudget` 保存实际 `cleanupBudgetMs`，未终态进入 `stopping`，已终态只追加 `cleanup-budget-exceeded` info warning。
- `lastActivity` 只由已绑定选中 child 的 `noteReasoning/noteToken/startTool/endTool` 写入 `now()`；begin、三层 ID 绑定、childIdle、noteChildError、上游 start/end、result resolve/reject、failRun、cancel、cleanup、snapshot 均不得刷新。没有执行活动时保持 `undefined`，由客户端从 `startedAt` 计算静默时长。
- `activityFlushMs: 0` 时同步发投影，默认 1000ms 合并高频 token/reasoning；终态前 flush。

- [ ] **Step 4: 运行核心测试**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/subagent-runs.spec.ts`
Expected: PASS；无未处理 rejection。

- [ ] **Step 5: 可选提交**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts dsh-plugin-huaanwork/tests/huaanwork-host/subagent-runs.spec.ts
git commit -m "feat: add authoritative subagent run registry"
```

### Task 2: 定向取消、停止时间、snapshot 与有界历史

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/subagent-runs.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `SubagentRunProjection` 与 registry 核心方法。
- Produces: `attachCancel()`、`requestCancel()`、`snapshot()`、`SubagentRunNotFoundError`。

- [ ] **Step 1: 写取消与对账失败测试**

```ts
test('cancel is exact, latched once, and does not wait for cleanup', async () => {
  let now = 10_000
  let release!: () => void
  const registry = createSubagentRunRegistry({ now: () => now, activityFlushMs: 0, emit: () => undefined })
  const runId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@review' })
  registry.reserveChild(runId, 'cancel-child')
  registry.noteToken('cancel-child')
  let calls = 0
  registry.attachCancel(runId, () => { calls += 1; return new Promise<void>((resolve) => { release = resolve }) })
  const first = await registry.requestCancel('parent', runId)
  assert.deepEqual(first, { status: 'accepted', runId })
  assert.equal(registry.get(runId)?.phase, 'stopping')
  assert.equal(registry.get(runId)?.stopRequestedAt, 10_000)
  now = 20_000
  assert.deepEqual(await registry.requestCancel('parent', runId), { status: 'accepted', runId })
  assert.equal(registry.get(runId)?.stopRequestedAt, 10_000)
  assert.equal(registry.get(runId)?.lastActivity, 10_000)
  assert.equal(calls, 1)
  release()
  await Promise.resolve()
  registry.settleResult(runId, { stopReason: 'aborted' })
  assert.equal(registry.get(runId)?.phase, 'stopping')
  registry.confirmCleanup(runId, { ok: true, warnings: [] })
  assert.equal(registry.get(runId)?.phase, 'stopped')
  assert.deepEqual(await registry.requestCancel('parent', runId), { status: 'already-terminal', runId })
  await assert.rejects(registry.requestCancel('other-parent', runId), /subagent run not found/)
})
```

父会话等其他来源的 `aborted` 也必须走严格停止确认：

```ts
const parentStoppedId = registry.begin({ parentSessionId: 'parent', kind: 'package', label: '@pkg' })
registry.settleResult(parentStoppedId, { stopReason: 'aborted' })
assert.equal(registry.get(parentStoppedId)?.phase, 'stopping')
registry.confirmCleanup(parentStoppedId, { ok: true, warnings: [] })
assert.equal(registry.get(parentStoppedId)?.phase, 'stopped')
const earlyId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@early' })
await registry.requestCancel('parent', earlyId)
let earlyCalls = 0
registry.attachCancel(earlyId, async () => { earlyCalls += 1 })
await Promise.resolve()
assert.equal(earlyCalls, 1)
```

再加入 snapshot 形状与有界历史断言；旧 snapshot/新 run 竞态在 Task 8 的客户端 reducer 中验证：

```ts
const activeId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@active' })
for (let index = 0; index < 25; index += 1) {
  const id = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: `@done-${index}` })
  registry.settleResult(id, { stopReason: 'completed' })
}
const snapshot = registry.snapshot('parent')
assert.equal(snapshot.runs.filter((run) => run.phase === 'completed').length, 20)
assert.ok(snapshot.runs.some((run) => run.runId === activeId))
assert.ok(snapshot.runs.every((run) => run.parentSessionId === 'parent'))
assert.ok(snapshot.revision >= 25)

for (let index = 0; index < 205; index += 1) {
  const id = registry.begin({ parentSessionId: `parent-${index}`, kind: 'legacy', label: '@global' })
  registry.settleResult(id, { stopReason: 'completed' })
}
assert.ok(registry.snapshot('parent').runs.some((run) => run.runId === activeId))
```

全局 200 的裁剪只检查活跃 run 仍保留与 `subagent/run-remove` 只针对终态；不要断言某个并发 Map 实现未规定的淘汰顺序。

- [ ] **Step 2: 运行新增测试并确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/subagent-runs.spec.ts`
Expected: FAIL，`registry.attachCancel is not a function` 或 `registry.snapshot is not a function`。

- [ ] **Step 3: 实现取消与 snapshot API**

把以下成员加入 Task 1 的 `SubagentRunRegistry`，不要另建同名接口：

```ts
export class SubagentRunNotFoundError extends Error {
  constructor() { super('subagent run not found') }
}

export interface SubagentRunRegistry {
  attachCancel(runId: string, cancel: () => Promise<void>): void
  requestCancel(parentSessionId: string, runId: string): Promise<SubagentCancelResult>
  snapshot(parentSessionId: string): SubagentRunSnapshot
}
```

`requestCancel` 的顺序固定为：校验 parent/run → 终态返回 `already-terminal` → 首次同步写 stopping、`stopRequestedAt`、`stopCause: 'targeted-cancel'` 并 `void cancel()` → 立即返回 accepted。`attachCancel` 若晚于停止意图注册且 run 仍非终态，也必须看到已 latch 的 `stopRequestedAt` 并启动一次清理；registry 用独立 `cancelStarted` 防止 request 与 attach 两条路径双发。cancel 闭包 resolve 只表示该闭包返回，registry 不得据此自动确认 stopped；执行链仍须按 Task 1 规则分别上报执行终结与 `confirmCleanup`。后台 cancel rejection 转成 `cleanup-failed` error warning，不得变成 unhandled rejection。`snapshot` 返回同一 projection 形状与捕获时的 generation/revision，只读对账不得更新 `lastActivity`；历史裁剪只针对终态，裁剪时发 `subagent/run-remove`。

- [ ] **Step 4: 运行全部 registry 测试**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/subagent-runs.spec.ts`
Expected: PASS，包含跨父会话零副作用与 20/200 边界。

- [ ] **Step 5: 可选提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts dsh-plugin-huaanwork/tests/huaanwork-host/subagent-runs.spec.ts
git commit -m "feat: add targeted subagent cancellation and snapshots"
```

### Task 3: Host 注入与 list/cancel RPC 契约

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/{holders.ts,index.ts,routes.ts,sessions.ts}`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/api.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts`
- Create: `dsh-plugin-huaanwork/tests/huaanwork-host/subagent-routes.spec.ts`

**Interfaces:**
- Consumes: Task 2 的 `snapshot()`、`requestCancel()` 与 `SubagentRunNotFoundError`。
- Produces: `GET /huaanwork/subagent/list?parentSessionId=...`、`POST /huaanwork/subagent/cancel`，以及 `ctx.huaanworkSubagentRuns`。

- [ ] **Step 1: 写路由契约与权限失败测试**

在 `route-contract.spec.ts` 的客户端/服务端必选键中加入：

```ts
'subagent.list': ['runs', 'generation', 'revision'],
'subagent.cancel': ['status', 'runId'],
```

新增 `subagent-routes.spec.ts`，通过 `ROUTE_TABLE` 找到 handler 后直接调用，覆盖：

```ts
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createSubagentRunRegistry } from '../../src/huaanwork-host/subagent-runs.ts'
import { ROUTE_TABLE, RouteError } from '../../src/huaanwork-host/routes.ts'

test('cancel validates parent and returns accepted before deferred cleanup finishes', async () => {
  let finish!: () => void
  const registry = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined })
  const runId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@review' })
  registry.attachCancel(runId, () => new Promise<void>((resolve) => { finish = resolve }))
  const entry = ROUTE_TABLE.find((route) => route.method === 'subagent.cancel')!
  const result = await entry.handler({ params: {}, query: new URLSearchParams(), body: { parentSessionId: 'parent', runId } }, routeCtx)
  assert.deepEqual(result, { status: 'accepted', runId })
  await assert.rejects(
    entry.handler({ params: {}, query: new URLSearchParams(), body: { parentSessionId: 'other', runId } }, routeCtx),
    (error: unknown) => error instanceof RouteError && error.status === 404 && error.code === 'subagent-run-not-found',
  )
  finish()
})
```

再添加一个 `subagent.list` 的缺省参数用例：`body` 为空且 query 无 `parentSessionId` 时，`RouteError.status === 400`。`routeCtx` 复用 `sessions.spec.ts` 的 `makeRouteCtx`，并把 `runtimeCtx.huaanworkSubagentRuns` 设为上面的 registry。

- [ ] **Step 2: 运行契约测试并确认缺少路由**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/route-contract.spec.ts tests/huaanwork-host/subagent-routes.spec.ts`
Expected: FAIL，提示 `subagent.list` / `subagent.cancel` 未注册。

- [ ] **Step 3: 注入 registry 并实现 HTTP 路由**

`holders.ts` 的 Context 声明与 `HUAANWORK_CONTEXT_PROPS` 增加 `huaanworkSubagentRuns: SubagentRunRegistry`。`index.ts` 在 `installHuaanworkHolders()` 后创建并赋值：

```ts
const subagentRuns = createSubagentRunRegistry({ emit: routeCtx.emit })
ctx.huaanworkSubagentRuns = subagentRuns
```

`SessionRuntimeContext` 与 `AgentInvokeContext` 增加同一类型属性。`api.ts` 增加：

```ts
'subagent.list': get('/huaanwork/subagent/list', objectQuery),
'subagent.cancel': post('/huaanwork/subagent/cancel'),
```

`routes.ts` 的 handler 必须复用 `requireRuntime()` 取同一 registry；`subagent.list` 直接返回 `snapshot(parentSessionId)`；`subagent.cancel` 只读 body 的 `parentSessionId/runId`，把 `SubagentRunNotFoundError` 映射为 404，不在 handler 中 await 清理。将 `api.ts` 与 `route-contract.spec.ts` 中所有 69 方法计数注释、计数测试名及两端 `toBe(69)` 硬断言同步更新为 71，不能只改其中一处注释。

- [ ] **Step 4: 运行路由与既有 session 回归**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/route-contract.spec.ts tests/huaanwork-host/subagent-routes.spec.ts tests/huaanwork-host/routes.spec.ts tests/huaanwork-host/sessions.spec.ts`
Expected: PASS；既有 `session.cancel` 行为不变。

- [ ] **Step 5: 可选提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host dsh-plugin-huaanwork/src/client-huaanwork/api.ts dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/subagent-routes.spec.ts
git commit -m "feat: expose subagent run list and cancel routes"
```

### Task 4: legacy `@agent` 运行链接线

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/{sessions.ts,agent-invoke.ts,subagents-service.ts}`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts`

**Interfaces:**
- Consumes: Task 2 registry、Task 3 `ctx.huaanworkSubagentRuns`。
- Produces: `clientMessageId` 传递、`HUAANWORK_SUBAGENT_RUN_ID`、legacy 保存的 AbortController 与晚到 activation dispose。

- [ ] **Step 1: 写 legacy 启动中/运行中取消测试**

在现有 `@agent` fixture 上补充 `huaanworkSubagentRuns`，把 `activationSpecs` 的元素类型扩展为包含 `childId?: string`，并在 Vitest 导入中加入 `vi`。新增：

```ts
test('legacy cancel aborts before activation and disposes a late activation', async () => {
  let resolveActivation!: (value: SubagentActivationHandle) => void
  const activationPromise = new Promise<SubagentActivationHandle>((resolve) => { resolveActivation = resolve })
  let disposeCalls = 0
  const registry = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined })
  const ctx = {
    agents: { get: (id: string) => (id === sessionId ? live : undefined), list: () => [live] },
    subagents: { startActivation: () => activationPromise },
    huaanworkSubagentRuns: registry,
  } as unknown as SessionRuntimeContext
  const sent = sessionSend(ctx, routeCtx, {
    text: '整理本周进展', sessionId, at: { name: 'legacy-assistant', clientMessageId: '42' },
  })
  let runId = ''
  await vi.waitFor(() => {
    runId = registry.snapshot(sessionId).runs[0]?.runId ?? ''
    expect(runId).toBeTruthy()
  })
  expect((await registry.requestCancel(sessionId, runId)).status).toBe('accepted')
  expect(registry.get(runId)?.phase).toBe('stopping')
  resolveActivation({
    childId: 'legacy-child',
    result: Promise.resolve({ stopReason: 'aborted' }),
    dispose: async () => { disposeCalls += 1 },
  })
  await expect(sent).rejects.toThrow(/取消/)
  expect(disposeCalls).toBe(1)
  expect(registry.get(runId)?.phase).toBe('stopped')
  expect(registry.get(runId)?.clientMessageId).toBe('42')
})
```

另加两个针对现有 fixture 的断言：`activationSpecs[0]!.childId` 匹配 UUID 文本；把 activation.childId 改为 `'provider-assigned-child'` 后，`registry.get(runId)?.childId === 'provider-assigned-child'`，再发一个 rejection 的 `activation.result`，测试结束时无 unhandled rejection。

再补三组执行链测试，不能只测 registry：

1. **activation 从未发布且启动因取消拒绝**：startActivation 在 abort 后 reject、始终不返回 activation；dispatch 按取消收尾后必须为 `stopped`，`disposeCalls === 0`，不得仍等待 afterIdle。
2. **activation 已发布的取消**：deferred dispose 未释放、activation.result 已上报 aborted 时仍为 `stopping`；释放 dispose 后才为 `stopped`，且兄弟 activation 的 dispose 次数为零。
3. **正常 afterIdle**：真实 result 与 dispose 完成后上报清理确认；若 dispose reject，自然 completed/failed 不被改写，只追加 `activation-dispose-failed` error warning。
4. **短预算 afterIdle（A-08）**：用已建立的 legacy fixture 直接取得 `afterIdle`，在调用前以 `vi.useFakeTimers()` 接管计时器；父未 idle 时推进 `ACTIVATION_CLEANUP_TIMEOUT_MS` 不得写 `cleanupBudgetMs`。调用 afterIdle 后推进同一常量，断言 `cleanupBudgetMs === ACTIVATION_CLEANUP_TIMEOUT_MS`、出现 `cleanup-budget-exceeded` info warning 且进入 `stopping`；让 dispose fixture 同时结算 aborted result 并成功返回后，最终收敛为 `stopped`。测试 `finally` 必须 `vi.useRealTimers()`。

- [ ] **Step 2: 运行 legacy 测试并确认当前无法定向取消**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/sessions.spec.ts`
Expected: FAIL，匿名 signal 无保存 controller，且 activation spec 无 `childId/clientMessageId` 关联。

- [ ] **Step 3: 实现 legacy 运行记录与精确取消**

`sendToAgent()` 读取 `at.clientMessageId` 并传入 `dispatchAt({clientMessageId})`。`subagents-service.ts` 增加：

```ts
export const HUAANWORK_SUBAGENT_RUN_ID: unique symbol = Symbol.for('huaanwork.subagent-run-id')
export function subagentRunIdOf(spec: unknown): string | undefined
```

legacy 分支在 `host.get()` 前建立 run，用 try/catch 覆盖整个启动分支；启动/外层错误调用 `failRun`，activation.result rejection 则按下文单独调用 `rejectResult`：

```ts
const subagentRuns = ctx.huaanworkSubagentRuns
if (subagentRuns === undefined) throw new Error('subagent run registry is not initialized')
const runId = subagentRuns.begin({
  parentSessionId: opts.sessionId,
  kind: 'legacy',
  label: `@${opts.name}`,
  ...(opts.clientMessageId === undefined ? {} : { clientMessageId: opts.clientMessageId }),
})
```

在 spec 前保存：

```ts
const controller = new AbortController()
const reservedChildId = randomUUID()
let activation: SubagentActivationHandle | undefined
let cancelRequested = false
let cleanupPromise: Promise<void> | undefined
subagentRuns.reserveChild(runId, reservedChildId)
subagentRuns.attachCancel(runId, async () => {
  cancelRequested = true
  controller.abort()
  if (activation !== undefined) await cleanupLegacyRun('cancel')
})
```

spec 增加 `childId: reservedChildId`、`signal: controller.signal`、`[HUAANWORK_SUBAGENT_RUN_ID]: runId`。activation 返回后立即 `bindActivation`，并以 `settleResult` 观察 resolve、以 `rejectResult` 观察 rejection；不得把 result rejection 送进只表示启动/外层失败的 `failRun`。

legacy 分支的 try/catch 覆盖整个启动分支。只有未返回 activation 的启动/外层错误调用 `failRun`；该调用记录启动已终结后，仍须完成局部请求清理并调用 `confirmCleanup`。若 activation 晚到且 `cancelRequested` 已 latch，则先绑定并观察 result，再立即走取消清理，不继续执行，也不依赖 `sendToAgent` 的 afterIdle——dispatchAt 抛错时该闭包根本不会发布。

`confirmCleanup` 的四条路径必须显式共用一个每次调用的局部函数 `cleanupLegacyRun(mode: 'idle' | 'cancel'): Promise<void>`。该函数在本任务中定义，内部只创建一个实际清理 Promise 并保存到上面的 `cleanupPromise`；取消 gate 必须能唤醒已经开始的 idle 等待。不得让四条路径各自发明一套状态：

1. **activation 已发布后取消**：cancel 闭包 abort 后调用 `cleanupLegacyRun('cancel')`，不等待 graceful result；dispose 已在进行时复用同一 Promise。
2. **activation 从未发布即取消**：cancel 闭包只 latch `cancelRequested` 并 abort，不得提前确认 stopped。startActivation 因取消 reject 时，catch 先 `failRun` 记录启动终结，再无 activation 地完成局部清理并 `confirmCleanup`；若 activation 晚到，则立即 dispose，待 result 观察与 dispose 均已结束后确认。
3. **正常 afterIdle**：dispatch 成功返回的 `afterIdle` 直接调用 `cleanupLegacyRun('idle')`；等待真实 result、dispose 完成后确认，成功结果不因后续清理告警改写。
4. **超时 afterIdle**：result 等待到期先 `noteCleanupBudget(runId, ACTIVATION_CLEANUP_TIMEOUT_MS)`，再 dispose 并确认；dispose 超时不得当成成功确认。

`cleanupLegacyRun` 在 dispose fulfilled 时以 `ok:true` 确认；reject/超时分别以 `activation-dispose-failed` / `activation-dispose-timeout` error warning 和 `ok:false` 确认。它在 `finally` 中继续 `clearLegacyRequest`，清理失败不得变成未处理 rejection。afterIdle 的 graceful result 等待必须带取消 gate；定向取消接管后不得再等待完整预算或误加 `cleanup-budget-exceeded`。重复 afterIdle/cancel 共享同一清理 Promise，confirmCleanup 幂等且不重复追加 warning。

- [ ] **Step 4: 运行 legacy 与 package 相邻回归**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/sessions.spec.ts tests/huaanwork-host/agent-package-lifecycle.spec.ts`
Expected: PASS；父 `session.cancel` 与原有 afterIdle 语义不回归。

- [ ] **Step 5: 可选提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/{sessions.ts,agent-invoke.ts,subagents-service.ts} dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts
git commit -m "feat: make legacy subagent runs visible and cancellable"
```

### Task 5: package `@slug` 运行链与清理确认

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/{host.ts,types.ts}`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/{agent-package-lifecycle.spec.ts,agent-package-runtime.spec.ts}`

**Interfaces:**
- Consumes: Task 4 的 run 元数据与 registry。
- Produces: `AgentPackageDispatchInput.clientMessageId`、`AgentPackageSubagentRequest.runId`、结构化 package cleanup warnings。

- [ ] **Step 1: 写 package 定向清理与晚到资源测试**

新增覆盖：`createRuntime()` 在途取消、`startActivation()` 在途取消、晚到 runtime/activation 各只停选中 run；deferred dispose/runtime stop 未确认时 phase 保持 stopping，确认后才 stopped；另一个 package runtime 的 stop 调用次数为零。另加定向取消后 `activation.result` rejection：不得提前变成 `failed`，须保留 failure、等待清理确认后转为 `stopped`。关键断言使用真实 `dispatch()` 与 deferred fixture：

```ts
const accepted = await registry.requestCancel(sessionId, runId)
assert.equal(accepted.status, 'accepted')
assert.equal(registry.get(runId)?.phase, 'stopping')
releaseStopRuntime()
for (let attempt = 0; attempt < 20 && registry.get(runId)?.phase !== 'stopped'; attempt += 1) {
  await Promise.resolve()
}
assert.equal(registry.get(runId)?.phase, 'stopped')
assert.equal(otherRuntimeStopCalls, 0)
```

这里的轮询只跨受控 fixture 的 Promise 链，没有真实文件 I/O，保留微任务即可；不得复制到 Task 4 的 `readHuaanworkSettings` 启动路径。

补 package 的 A-08 短预算集成用例：利用 `createAgentPackageHost({ cleanupTimeoutMs: 20 })` 既有构造参数与 deferred activation.result，父未 idle 时等待超过 20ms 不得写 `cleanupBudgetMs`；调用 afterIdle 并触发预算到期后，断言 `cleanupBudgetMs === 20`、`stopCause === 'cleanup-budget'`、存在 `cleanup-budget-exceeded` info warning，且 dispose/runtime 清理确认前不得伪报 stopped。随后完成真实 fixture 清理并断言最终状态。

清理失败 fixture 必须断言结构化输出；另加未启用包用例：`dispatch()` reject 后 phase 为 `failed` 而非 `starting`。

```ts
assert.deepEqual(run.cleanupWarnings, [
  { code: 'activation-dispose-timeout', severity: 'error' },
  { code: 'runtime-stop-failed', severity: 'error' },
])
```

- [ ] **Step 2: 运行 package 测试并确认缺少 run 投影**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-lifecycle.spec.ts tests/huaanwork-host/agent-package-runtime.spec.ts`
Expected: FAIL，当前 `AgentPackageActiveTurnRecord` 不发布 UI run，且 cleanupFailures 只是 Error[]。

- [ ] **Step 3: 接入统一 run 并保留既有取消原语**

`AgentPackageDispatchInput` 只增加 `clientMessageId?: string`，由 `dispatchAt` 传入；`runId` 一律由 package `dispatch()` 在启动校验前创建，避免 dispatchAt 与 dispatch 各建一张卡。`AgentPackageSubagentRequest` 增加 `runId: string`。

在 `dispatch()` 开头使用独立变量名，**不得覆盖现有 `registry = AgentPackageRuntimeRegistry`**：

```ts
const subagentRuns = ctx.huaanworkSubagentRuns
if (subagentRuns === undefined) throw new Error('subagent run registry is not initialized')
const runId = subagentRuns.begin({
  parentSessionId: sessionId,
  kind: 'package',
  label: `@${pkg.slug}`,
  packageVersion: pkg.version,
  ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
})
```

在 `cancelTurn` 定义后 `subagentRuns.attachCancel(runId, () => cancelTurn('cancel'))`；预留 childId 后 `subagentRuns.reserveChild`；activation 返回后 `subagentRuns.bindActivation`。`begin` 之后用外层 try/catch 包住现有全部校验与执行：启动校验或外层 dispatch 错误先 `subagentRuns.failRun(runId, message)` 再原样抛出；activation.result rejection 只能走下方 `rejectResult`，不得重复送 `failRun`。既有内层 cleanup 与 `cancelError()` 不变，避免校验失败留下永久 starting。activation 返回后用以下方式观察：

```ts
void activation.result.then(
  (result) => subagentRuns.settleResult(runId, result),
  (error) => subagentRuns.rejectResult(runId, error instanceof Error ? error.message : String(error)),
)
```

将 `cleanupFailures` 改为带 code 的集合：`activation-dispose-failed`、`activation-dispose-timeout`、`runtime-stop-failed`、`runtime-stop-timeout`。保留原聚合抛出与日志语义。`cleanup()` 在 `await cleanupPromise` 后调用：

```ts
subagentRuns.confirmCleanup(runId, {
  ok: cleanupFailures.length === 0,
  warnings: cleanupFailures.map(({ code }) => ({ code, severity: 'error' })),
})
```

result 等待超时时只调用 `subagentRuns.noteCleanupBudget(runId, cleanupTimeoutMs)`，不得塞进 cleanupFailures。现有 `registry.bind(sessionId, runtime)` 与 `registry.get/delete` 全部保持 AgentPackageRuntimeRegistry 原义；`pendingTurns`、cancelGate、晚到绑定、撤销与 `cancelBySessionId` 全部保留。

- [ ] **Step 4: 运行 package 全套测试**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-lifecycle.spec.ts tests/huaanwork-host/agent-package-runtime.spec.ts tests/huaanwork-host/agent-package-catalog-security.spec.ts`
Expected: PASS；撤销、更新、移除仍等待原有清理失败语义。

- [ ] **Step 5: 可选提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/agent-package dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-*.spec.ts
git commit -m "feat: project package turn lifecycle into subagent runs"
```

### Task 6: upstream start/end 配对与 fail-closed 启动绑定

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts`

**Interfaces:**
- Consumes: Task 4 `subagentRunIdOf()`、Task 5 `AgentPackageSubagentRequest.runId`、registry 的 `bindUpstreamStart/settleUpstreamEnd/parentSessionIdOf`。
- Produces: 第二条 `AsyncLocalStorage` Host runId 作用域与严格 upstreamRunId 配对。

- [ ] **Step 1: 写 start/end 配对与父会话不一致测试**

新增：Host runId 经 ALS 绑定到 `subagent/start.runId`；旧 upstream end 只结算旧 run；模型自主嵌套子代理没有 Host runId 时不建卡；ALS parent、activation parent、registry parent 不一致时调用 activation.dispose 并抛错，不执行 restrict/refresh。parent mismatch 用例直接调用包装后的 `ctx.subagents.startActivation(spec)`：

```ts
await expect(ctx.subagents.startActivation(spec)).rejects.toThrow('subagent activation parent mismatch')
assert.equal(disposeCalls, 1)
assert.equal(restrictCalls, 0)
```

`spec` 的 parent 使用 harness 中另一个 live Agent；`originalActivation` 仍返回 `childId: 'child-1'` 与 pending result，确保测试证明的是包装层 fail closed，而不是上游拒绝。

- [ ] **Step 2: 运行 skills 测试并确认缺少绑定**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-guardrails/skills.spec.ts`
Expected: FAIL，start 当前只做 parent→child 登记，没有 upstreamRunId 对账。

- [ ] **Step 3: 实现独立 runId ALS 与生命周期消费**

保留现有 `startParent`，新增：

```ts
const startRun = new AsyncLocalStorage<string | undefined>()
```

在 `startActivation` 包装中同步取 `subagentRunIdOf(args[0]) ?? pkg?.runId`，并嵌套 `startRun.run(hostRunId, () => originalActivation(...args))`。activation 返回后、任何工具 restrict 前校验三方 parent；不一致时 `await run.dispose()` 并抛出 `subagent activation parent mismatch`。

`subagent/start` listener 增加：

```ts
ctx.huaanworkSubagentRuns.bindUpstreamStart({
  hostRunId: startRun.getStore(),
  upstreamRunId: info.runId,
  childId: info.id,
})
```

`subagent/end` listener 用 `info.runId` 调 `settleUpstreamEnd`，同时保留 `forgetChildSession(info.id)`。未知 upstreamRunId 不得清新 run；没有 Host runId 的嵌套子代理只保留原 parent-child 登记与工具护栏。

- [ ] **Step 4: 运行 skills 与 registry 联合测试**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-host/subagent-runs.spec.ts`
Expected: PASS；parent mismatch 为 fail closed 且有 dispose 证据。

- [ ] **Step 5: 可选提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts
git commit -m "feat: pair upstream subagent lifecycle with host runs"
```

### Task 7: bridge child 活动投影与父消息流隔离

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/bridge.spec.ts`

**Interfaces:**
- Consumes: registry 的 `ownsChild/noteReasoning/noteToken/startTool/endTool/childIdle/noteChildError`。
- Produces: 已知 child 不再向全局 WS 发原 token/tool/diff/goal/compaction/session-end。

- [ ] **Step 1: 写父子隔离测试**

使用 `createCtx()` 增加 `huaanworkSubagentRuns`，注册 parent/child。断言：child text-delta 不 emit `token`，只更新 run；两个并发工具按 callId 结束；child `agent/status idle` 不 emit `session/end`；child git_diff、DIFF_AFTER、goal/compaction 不触发父事件；未登记普通会话的现有 token/tool/session-end 断言保持原样。关键断言：

```ts
assert.equal(emitted.filter((event) => (event as { event?: string }).event === 'token').length, 0)
assert.equal(registry.get(runId)?.phase, 'reasoning')
await listeners['agent/status']?.[0]?.({ status: 'idle', agent: childAgent } as never)
assert.equal(emitted.filter((event) => (event as { event?: string }).event === 'session/end').length, 0)
await listeners['agent/status']?.[0]?.({ status: 'idle', agent: parentAgent } as never)
assert.equal(emitted.filter((event) => (event as { event?: string }).event === 'session/end').length, 1)
```

- [ ] **Step 2: 运行 bridge 测试并确认当前仍广播 child 事件**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-guardrails/bridge.spec.ts`
Expected: FAIL，现有 `mapTokens()` 与 `tools/execute` 对 child 仍 emit 原事件。

- [ ] **Step 3: 实现按 child 的分流**

`mapTokens()` 在 purpose 为空且 `sessionId !== undefined && ownsChild(sessionId)` 时只调用 registry：reasoning-delta/block-end → `noteReasoning`，text-delta → `noteToken`，chunks 原样 `yield`。`tools/execute` 对已知 child 仍执行 `next()` 和 capResult，但 tool/start/end 改调 registry，不再 emit diff 或调用 `emitGitDiff`。`session/event` 对已知 child 直接跳过 goal/compaction 投影。`agent/status idle` 调 `childIdle`；`agent/error` 只 `noteChildError` 记录清理过的 message，终态仍由 result/end 决定。工具失败不直接决定 run 失败。

- [ ] **Step 4: 运行 bridge 与父会话回归**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-guardrails/bridge.spec.ts tests/huaanwork-guardrails/skills.spec.ts`
Expected: PASS；普通会话事件逐字节保持原形状。

- [ ] **Step 5: 可选提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/bridge.spec.ts
git commit -m "feat: isolate subagent activity from parent transcript"
```

### Task 8: 客户端 run reducer 与 WS/snapshot 对账

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/subagentRuns.ts`
- Create: `dsh-plugin-huaanwork/tests/client-huaanwork/subagentRuns.spec.ts`

**Interfaces:**
- Consumes: `SubagentRunProjection`、`SubagentRunSnapshot`、`subagent/run[-remove]`。
- Produces: `SubagentRunsState`、`reduceSubagentRuns()`、`isSubagentRunActive()`、`TERMINAL_RUN_PHASES`。

- [ ] **Step 1: 写对账失败测试**

覆盖：同代旧 snapshot 不覆盖新 WS；snapshot 后高 revision 新 run 不删；不同 generation 时旧非终态变 `stale` 且不可取消、旧终态保留为历史；disconnected 设置 frozenAt，snapshot 到达后清除；run-remove 只删匹配代际/revision 的终态历史；展开状态不在 reducer 的 run 对象中。

```ts
const next = reduceSubagentRuns(before, { type: 'snapshot', snapshot: { generation: 'g2', revision: 8, runs: [] } })
assert.equal(next.runs.get('old-active')?.stale, true)
assert.equal(next.runs.get('old-terminal')?.stale, false)
assert.equal(next.generation, 'g2')
```

- [ ] **Step 2: 运行 reducer 测试并确认实现不存在**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/subagentRuns.spec.ts`
Expected: FAIL，无法解析 `logic/subagentRuns.ts`。

- [ ] **Step 3: 实现 reducer**

```ts
export const TERMINAL_RUN_PHASES = new Set(['completed', 'failed', 'stopped'])
export type SubagentRunsAction =
  | { type: 'event'; event: Extract<RpcEvent, { event: 'subagent/run' | 'subagent/run-remove' }> }
  | { type: 'snapshot'; snapshot: SubagentRunSnapshot }
  | { type: 'disconnect'; at: number }
export type SubagentRunsState = {
  generation?: string
  revision: number
  runs: Map<string, SubagentRunProjection & { stale?: boolean }>
  connection: 'live' | 'disconnected'
  frozenAt?: number
}
export function isSubagentRunActive(run: SubagentRunProjection & { stale?: boolean }): boolean
export function reduceSubagentRuns(state: SubagentRunsState, action: SubagentRunsAction): SubagentRunsState
```

同代 snapshot：逐 run 按 revision 合并；缺项只有在其 revision ≤ snapshot.revision 且非活跃时才可删除，高 revision 新 run 必须保留。新 generation：旧非终态转 stale，旧终态保留，之后插入新 snapshot；不得把 stale 当成活跃。活跃/stopping 永不因历史裁剪删除；其他历史沿用 20/父会话、200 全局上限。`expanded` 不进入 run 对象。

- [ ] **Step 4: 运行 reducer 测试**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/subagentRuns.spec.ts`
Expected: PASS，包含多 tab parent 隔离和 generation 切换。

- [ ] **Step 5: 可选提交**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/subagentRuns.ts dsh-plugin-huaanwork/tests/client-huaanwork/subagentRuns.spec.ts
git commit -m "feat: reconcile subagent runs across websocket snapshots"
```

### Task 9: 运行卡文案、计时、提醒与工具摘要纯函数

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/subagentRuns.ts`
- Modify: `dsh-plugin-huaanwork/tests/client-huaanwork/subagentRuns.spec.ts`

**Interfaces:**
- Consumes: Task 8 state 与 projection。
- Produces: `subagentStatusText()`、`subagentElapsedMs()`、`subagentAlert()`、`subagentToolSummary()`、`subagentNeedsStartTime()`。

- [ ] **Step 1: 写固定文案与 60 秒边界测试**

逐项断言：finalizing 为「正在确认执行结果」；`error/max-tokens/refusal/unknown` 使用 §6.1 文案；`stopRequestedAt = 1000` 时，61000 不出现 60 秒提醒、62000 出现；重连使用同一 timestamp 不重新计时；清理未确认/失败 > 收尾预算 > 无活动；completed + cleanup warning 不变成 failed；同名才显示 `HH:MM:SS`；`cleanupBudgetMs = 5000` 时提示「父会话空闲后等待收尾超过 5 秒，已开始强制释放」，600000 时显示「10 分钟」而非前端写死。

- [ ] **Step 2: 运行新增测试并确认函数不存在**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/subagentRuns.spec.ts`
Expected: FAIL，`subagentAlert is not a function`。

- [ ] **Step 3: 实现纯展示函数**

```ts
export function subagentStatusText(run: SubagentRunProjection): string
export function subagentElapsedMs(run: SubagentRunProjection, now: number, frozenAt?: number): number
export function subagentAlert(run: SubagentRunProjection, now: number): { code: string; severity: 'info' | 'error'; text: string } | undefined
export function subagentToolSummary(tools: SubagentToolActivity[]): { visible: SubagentToolActivity[]; hiddenCount: number; text: string }
export function subagentNeedsStartTime(run: SubagentRunProjection, allRuns: readonly SubagentRunProjection[]): boolean
export function formatRunStartedAt(startedAt: number): string // 本地时区 HH:MM:SS
export function formatCleanupBudget(ms: number): string // 600000 → '10 分钟'；5000 → '5 秒'
```

计时使用 `Math.max(0, Math.min(now, endedAt ?? now, frozenAt ?? now) - startedAt)` 的显示冻结语义，真实 endedAt 不改写；工具按 startedAt 与内部 `id` 稳定排序，最多前 2 个 + `+N`；warning code 未识别时用「清理状态需要关注」并保留 severity；收尾预算文案用 `formatCleanupBudget(run.cleanupBudgetMs)`，缺该字段时只显示无数字的「等待收尾超时」，不得编造数值；60 秒只看 Host `stopRequestedAt`。

- [ ] **Step 4: 运行全部客户端逻辑测试**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/subagentRuns.spec.ts`
Expected: PASS，无 Date.now 依赖造成的边界抖动。

- [ ] **Step 5: 可选提交**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/logic/subagentRuns.ts dsh-plugin-huaanwork/tests/client-huaanwork/subagentRuns.spec.ts
git commit -m "feat: add honest subagent run presentation logic"
```

### Task 10: SubagentRunCard 组件、可访问性与样式

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/SubagentRunCard.tsx`
- Create: `dsh-plugin-huaanwork/tests/client-huaanwork/SubagentRunCard.spec.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/styles.css`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/styles.generated.ts`（只能由生成器更新）

**Interfaces:**
- Consumes: Task 9 纯函数与 Task 8 `isSubagentRunActive`。
- Produces: `SubagentRunCard` 及 `SubagentRunCardProps`。

- [ ] **Step 1: 写 jsdom 组件失败测试**

沿用 `agent-confirm-card.spec.ts` 的 `createRoot + act` 模式，覆盖：首次点击不发回调；确认区初始焦点在取消；window dispatch Escape 后取消且焦点还原；确认前 run 已终态则关闭且零 RPC；`aria-expanded`、`role=status`、计时不在 live region；同名显示开始时间；长名称有 title；终态为单行且展开不被外部 run 更新重置；stale/frozen 禁止终止。Esc 的关键断言：

```ts
await click(buttonByText(view, '终止'))
expect(onConfirmCancel).not.toHaveBeenCalled()
expect(document.activeElement?.textContent).toBe('取消')
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
expect(onDismissCancel).toHaveBeenCalledWith('run-1')
expect(onConfirmCancel).not.toHaveBeenCalled()
expect((document.activeElement as HTMLButtonElement).textContent).toBe('终止')
```

- [ ] **Step 2: 运行组件测试并确认组件不存在**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/SubagentRunCard.spec.ts`
Expected: FAIL，无法解析 `SubagentRunCard.tsx`。

- [ ] **Step 3: 实现组件**

```ts
import type { ReactElement } from 'react'

export type SubagentRunCardProps = {
  run: SubagentRunProjection & { stale?: boolean }
  now: number
  frozenAt?: number
  duplicateLabel: boolean
  expanded: boolean
  confirming: boolean
  cancelBusy: boolean
  cancelError?: string
  onToggleExpanded(runId: string): void
  onRequestCancel(runId: string): void
  onConfirmCancel(runId: string): void
  onDismissCancel(runId: string): void
}
export default function SubagentRunCard(props: SubagentRunCardProps): ReactElement
```

活跃使用三行卡，终态使用单行 + 可展开详情；stale 显示「状态不可恢复 · Host 已重启，结果未确认」；frozenAt 显示「连接中断，状态可能滞后」。终止按钮的可访问名称为 `终止 ${run.label} 本次运行`，同名时追加 `，开始于 ${formatRunStartedAt(run.startedAt)}`；确认区出现时用 ref 聚焦取消并注册 window keydown，卸载移除；phase 变终态时只调用 `onDismissCancel`，不得调用 `onConfirmCancel`。终止与确认按钮在 `!isSubagentRunActive(run) || cancelBusy || frozenAt !== undefined` 时禁用。真实 `severity: 'error'` 的新 warning 只用 `role=alert` 一次；状态/工具变化使用单独 `role=status aria-live=polite aria-atomic=true`。

- [ ] **Step 4: 写 token 化样式并重新生成**

`styles.css` 新增 `.subagent-run-card`、`.subagent-run-header/status/meta`、`.subagent-run-compact`、`.subagent-run-alert`、`.subagent-run-terminate`、`.subagent-run-tools`：全部引用既有变量；活跃脉冲只用于指定相位；`@media (prefers-reduced-motion: reduce)` 关闭；最小 280px 无横滚；控件命中区至少 44×44 且不重叠；长名称 ellipsis + `:focus-visible` accent ring。

Run: `corepack yarn workspace dsh-plugin-huaanwork gen:styles`
Expected: 仅 `styles.generated.ts` 被生成器改写。

- [ ] **Step 5: 运行组件与样式测试**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/SubagentRunCard.spec.ts tests/client-huaanwork/styles-generated.spec.ts`
Expected: PASS；无裸 hex、无 12px 字阶外尺寸。

- [ ] **Step 6: 可选提交**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/SubagentRunCard.tsx dsh-plugin-huaanwork/src/client-huaanwork/styles.css dsh-plugin-huaanwork/src/client-huaanwork/styles.generated.ts dsh-plugin-huaanwork/tests/client-huaanwork/SubagentRunCard.spec.ts
git commit -m "feat: add accessible subagent run cards"
```

### Task 11: App 消息锚点、事件接入、定向取消与父状态分工

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/subagentRuns.ts`
- Modify: `dsh-plugin-huaanwork/tests/client-huaanwork/subagentRuns.spec.ts`

**Interfaces:**
- Consumes: Task 8 reducer、Task 10 卡片、`subagent.list/cancel`。
- Produces: `ChatItem` 的 `subagent-run` 分支、`insertSubagentRunCard()`、`reconcileSubagentRuns()`、`parentTurnLine()`。

- [ ] **Step 1: 写消息锚点与父状态失败测试**

新增纯函数测试：两个 tab 各有 `userMsg.id=41/42`，同 parent 的 run 携带 `clientMessageId:'42'` 时只插入第二个 tab；重复 upsert 不产生第二张卡；当前 active tab 是另一个 tab 也不得改变归属。`parentTurnLine({hasActiveChild:true})` 返回「主会话运行中」，无活跃卡时保留原 turnStatus 输出。锚点断言：

```ts
const firstTab = [{ id: 41, kind: 'user' }]
const secondTab = [{ id: 42, kind: 'user' }]
const anchored = insertSubagentRunCard(secondTab, { runId: 'run-1', clientMessageId: '42', allocateId: () => 43 })
assert.deepEqual(anchored.map((item) => item.kind), ['user', 'subagent-run'])
assert.equal(insertSubagentRunCard(firstTab, { runId: 'run-1', clientMessageId: '42', allocateId: () => 44 }).length, 1)
assert.deepEqual(
  insertSubagentRunCard(firstTab, { runId: 'run-1', clientMessageId: '42', allowSnapshotFallback: true, allocateId: () => 44 }).map((item) => item.kind),
  ['user', 'subagent-run'],
)
assert.equal(insertSubagentRunCard(anchored, { runId: 'run-1', clientMessageId: '42', allocateId: () => 45 }), anchored)
```

- [ ] **Step 2: 运行测试并确认 helper 不存在**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/subagentRuns.spec.ts`
Expected: FAIL，`insertSubagentRunCard is not a function` 或 `parentTurnLine is not a function`。

- [ ] **Step 3: 实现消息锚点 helper**

```ts
export type SubagentRunCardItem = { id: number; kind: 'subagent-run'; runId: string }

export function insertSubagentRunCard<T extends { id: number; kind: string }>(
  items: T[],
  input: { runId: string; clientMessageId?: string; allowSnapshotFallback?: boolean; allocateId(): number },
): T[] {
  if (items.some((item) => item.kind === 'subagent-run' && 'runId' in item && item.runId === input.runId)) return items
  const exactIndex = input.clientMessageId === undefined
    ? -1
    : items.findIndex((item) => item.kind === 'user' && item.id === Number(input.clientMessageId))
  const fallbackIndex = input.allowSnapshotFallback === true
    ? items.findLastIndex((item) => item.kind === 'user')
    : -1
  const index = exactIndex >= 0 ? exactIndex : fallbackIndex
  if (index < 0) return items
  const card = { id: input.allocateId(), kind: 'subagent-run', runId: input.runId } as T
  return [...items.slice(0, index + 1), card, ...items.slice(index + 1)]
}

export function parentTurnLine(input: { hasActiveChild: boolean; current: { text: string; alert: boolean } }): { text: string; alert: boolean }
```

helper 在 logic 文件中保持 generic，不得反向 import `App.tsx` 的私有 `ChatItem`。实时事件只在 `clientMessageId` 精确匹配当前 parent tab 的 `userMsg.id` 时插入；`allowSnapshotFallback` 只能由 snapshot 对账传入，此时才在该 parent tab 内回退到最后一个用户消息。两条路径都不得跨 tab 查找。

- [ ] **Step 4: 接入 App 事件、snapshot 与 send**

`ChatItem` 增加 `{id:number; kind:'subagent-run'; runId:string}`。`send()` 在 `userMsg` 创建后发送：

```ts
at: { name: invokedAt.name, clientMessageId: String(userMsg.id) }
```

`session.send` 必须捕获应答，不得保持现在的裸 `await rpcCall(...)`：把返回值保存到 `sent`，并将应答泛型声明为 `{ queued: true; sessionId: string }`。以发送前捕获的 `chatId` 和本次真实 `sent.sessionId` 调 `reconcileSubagentRuns`。正常 mint 成功时的局部 sessionId 可用于发送，但对账仍以应答为准；mint 失败回退、请求未显式携带 sessionId 时不得拿 `undefined` 或当前 active tab 的 sessionId 代替。该函数调用 `subagent.list`，dispatch snapshot，并以 `allowSnapshotFallback: true` 确保该 parent 的卡片锚定；实时 `subagent/run` 事件不传 fallback。

在既有 `onSidecarExit` 订阅中处理 WS close：`state.ready === false` 时 dispatch `{ type: 'disconnect', at: Date.now() }`，让全部 run 保留最后已知归属并冻结计时；只有后续 snapshot 对账完成才清除 `frozenAt`，onopen/ready 本身不得提前恢复。WS ready 后对所有绑定 parent 做同样对账；`subagent/run[-remove]` 在 `handleEvent` 前拦截并 return，避免进入父消息流。

App 保存 `expandedByRunId`、`confirmingRunId`、`cancelBusyByRunId`、`cancelErrorByRunId`，并用 `subagentRunsRef` 镜像最新 reducer state；这些状态与 reducer run 对象分离。切 tab 取消确认；run 变终态关闭确认。`onConfirmCancel` 先从 `subagentRunsRef.current` 重读最新 run，若已终态或 stale 则关闭确认且零 RPC；仍需取消时只调用 `subagent.cancel({parentSessionId,runId})`，错误写对应 run 的 `cancelError`，不调用 `session.cancel`，不改 `turnActive/stopPendingRef`。

- [ ] **Step 5: 接入卡片渲染与父状态摘要**

`ChatRow` 增加 `subagent-run` 渲染，使用现有共享 `now` 驱动所有卡。`ContentChatItem` 的 `Exclude` 同步加入 `'subagent-run'`，确保运行卡不进入父 `runningTool/outcome` 计算。`showTurnLine` 的计算改为：当前 activeChat 的 parentSessionId 有非终态且非 stale 的运行卡时显示「主会话运行中」；否则保留原 `turnStatus()`。断连保留最后已知归属，Host 失效不计活跃。

- [ ] **Step 6: 运行客户端全套测试与 typecheck**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork`
Run: `corepack yarn workspace dsh-plugin-huaanwork typecheck`
Expected: PASS；无新 TS error，无每卡 interval。

- [ ] **Step 7: 可选提交**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork dsh-plugin-huaanwork/tests/client-huaanwork
git commit -m "feat: integrate subagent run cards into chat"
```

### Task 12: 全量门禁、真实组合验收与视觉 QA

**Files:**
- Create: `docs/evidence/2026-10-26-subagent-run-visibility-verification.md`
- Modify: `docs/superpowers/specs/2026-10-26-subagent-run-visibility-design.md`（只填实际验收记录，不改已批准行为）

**Interfaces:**
- Consumes: Tasks 1–11 的全部实现。
- Produces: 可审查的自动化与真机证据；未执行项明确 Blocked。

- [ ] **Step 1: 串行运行定向测试**

```bash
corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/subagent-runs.spec.ts tests/huaanwork-host/route-contract.spec.ts tests/huaanwork-host/subagent-routes.spec.ts tests/huaanwork-host/sessions.spec.ts tests/huaanwork-host/agent-package-lifecycle.spec.ts tests/huaanwork-host/agent-package-runtime.spec.ts tests/huaanwork-host/agent-package-catalog-security.spec.ts tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-guardrails/bridge.spec.ts tests/client-huaanwork
```

Expected: 全 PASS；若失败，记录完整命令、失败用例与输出，不得静默跳过后继续宣称通过。

- [ ] **Step 2: 串行运行仓库门禁**

```bash
corepack yarn typecheck
corepack yarn test
corepack yarn check:desktop-variants
corepack yarn check
```

Expected: 全 PASS；不并行执行。若 `verify:aa` 出现既有并发 flake，单独串行复跑对应 workspace 并保留两轮输出，不能把假红写真红，也不能把真红写成 flake。

- [ ] **Step 3: 经用户同意后启动真实应用并验收两条路径**

Run（只有用户明确同意图形启动后）: `corepack yarn dev`

分别选择一个**实际可调用**的 legacy `@agent` 与 package `@slug`，记录名称、版本、Desktop SHA、Harness pin、平台、构建类型、测试人。若任一类不可用，在证据文件标 Blocked，不用 mock 代替真实验收。

每条路径都执行并截图/记录：
1. 启动 → 真实工具活动 → 完成，核对三行卡、工具名、耗时与终态单行。
2. 启动中定向终止与运行中定向终止，核对卡内二次确认、accepted→stopping→stopped，父/兄弟不受影响。
3. 父 idle 后子代理仍运行，核对卡片更新与终止入口。
4. 同名并发、多 tab、长名称、并发工具、断连重连、Host 重启失效视图。
5. 清理未确认与 60 秒提醒；真实清理失败不伪报 stopped。
6. A-08 收尾预算：分别引用 Task 4/5 的短预算执行链证据，核对实际 `cleanupBudgetMs`、提醒文案和清理确认前不伪报 stopped。真机只有在存在受控短预算注入通道时才执行该场景；没有通道时把两条真机子项明确标为 Blocked，不改生产常量、不把 Task 9 的文案单测或另一平台的证据冒充真机通过。
7. 键盘完整路径、window Esc、焦点返回、44×44 命中区、reduced-motion、280px 窄窗口、浅色/深色与读屏抽查。

- [ ] **Step 4: 写证据文件并执行视觉 QA**

证据文件每项标 PASS / FAIL / Blocked，附截图或日志路径；macOS 与 Windows 分开记录，未执行平台不得写通过。设计 §10.1 的 A–D 与 E-01～E-05 必须全部满足后才能宣布功能验收完成。

实现完成后按用户要求运行 `/design-review` 做真实视觉 QA；发现的问题另开修复任务，不回写“已通过”。

- [ ] **Step 5: 可选提交**

```bash
git add dsh-plugin-huaanwork docs/evidence/2026-10-26-subagent-run-visibility-verification.md docs/superpowers/specs/2026-10-26-subagent-run-visibility-design.md
git commit -m "test: verify subagent run visibility and targeted cancellation"
```

---

## 验收追踪

| 设计要求 | 实施任务 |
| --- | --- |
| R1 每次显式 @ 独立可信运行卡 | Tasks 1, 3–6, 8, 10, 11 |
| R2 真实相位与当前工具 | Tasks 1, 6, 7, 9, 10 |
| R3 耗时、静默、收尾预算 | Tasks 1, 4, 5, 8–10 |
| R4 定向终止与严格 stopped | Tasks 2, 4, 5, 10, 11 |
| D2 result/end 冲突仲裁 | Tasks 1, 6 |
| clientMessageId 精确消息锚点 | Tasks 3–5, 8, 11 |
| generation/revision 与失效视图 | Tasks 2, 8, 10, 11 |
| stopRequestedAt 与 60 秒提醒 | Tasks 2, 9, 10 |
| structured cleanupWarnings | Tasks 1, 5, 9, 10 |
| 父子消息流隔离 | Tasks 7, 11 |
| 键盘、读屏、窄窗口、reduced-motion | Tasks 10–12 |
| 真实 legacy/package 验收与平台诚实 | Task 12 |

## 实施顺序与并行边界

先完成 Tasks 1–3 的契约和 RPC；Tasks 4/5 可并行，Task 6 必须在两者后接线；Task 7 可在 Task 6 后独立进行。Tasks 8–10 可在 Task 3 后与 Host 执行链并行，但 Task 11 必须等 Tasks 4–10 全部完成。Task 12 永远最后，不与任何实现任务并行。
