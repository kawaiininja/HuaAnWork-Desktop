import assert from 'node:assert/strict'

import { describe, expect, test } from 'vitest'

import type { RpcEvent } from '../../src/client-huaanwork/rpc-types.ts'
import { createSubagentRunRegistry, SubagentRunNotFoundError } from '../../src/huaanwork-host/subagent-runs.ts'

/**
 * 子代理 run 状态机的核心语义(Task 1)。
 *
 * 这里只断言投影(phase / stopReason / cleanupWarnings / lastActivity)与终态仲裁:
 * - 权威 `activation.result` resolve 与上游 `subagent/end` 冲突时以 result 为准;
 * - result 仍 pending 时先到的 end 只保存候选,不提前发布 `failed`、不写 `endedAt`;
 * - 停止闩存在时,后续 result/rejection/failRun 都不得退出 `stopping`;
 * - `lastActivity` 只由选中 child 的执行活动刷新。
 */

function recordingRegistry(clock: { now: number }): { registry: ReturnType<typeof createSubagentRunRegistry>; events: RpcEvent[] } {
  const events: RpcEvent[] = []
  const registry = createSubagentRunRegistry({
    now: () => clock.now,
    activityFlushMs: 0,
    emit: (event) => events.push(event),
  })
  return { registry, events }
}

describe('subagent run registry', () => {
  test('child activity drives phases and result wins a conflicting upstream end', () => {
    const clock = { now: 1_000 }
    const { registry } = recordingRegistry(clock)
    const runId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@review', clientMessageId: '42' })
    registry.reserveChild(runId, 'child-1')
    registry.noteReasoning('child-1')
    expect(registry.get(runId)?.phase).toBe('reasoning')
    registry.startTool('child-1', { callId: 'call-1', name: 'read_file' })
    registry.startTool('child-1', { callId: 'call-2', name: 'grep' })
    registry.endTool('child-1', { callId: 'call-1', name: 'read_file' })
    expect(registry.get(runId)?.activeTools.map((tool) => tool.callId)).toEqual(['call-2'])
    registry.endTool('child-1', { callId: 'call-2', name: 'grep' })
    expect(registry.get(runId)?.phase).toBe('generating')
    registry.childIdle('child-1')
    expect(registry.get(runId)?.phase).toBe('finalizing')
    registry.bindUpstreamStart({ hostRunId: runId, upstreamRunId: 'upstream-1', childId: 'child-1' })
    registry.settleResult(runId, { stopReason: 'completed' })
    registry.settleUpstreamEnd({ upstreamRunId: 'upstream-1', stopReason: 'error' })
    const run = registry.get(runId)
    expect(run?.phase).toBe('completed')
    expect(run?.stopReason).toBe('completed')
    expect(run?.cleanupWarnings).toEqual([{ code: 'upstream-end-error', severity: 'error' }])
    expect(clock.now).toBe(1_000)
  })

  test('upstream end first waits for result arbitration', () => {
    const { registry } = recordingRegistry({ now: 2_000 })
    const runId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@review' })
    registry.reserveChild(runId, 'child-end-first')
    registry.childIdle('child-end-first')
    registry.bindUpstreamStart({ hostRunId: runId, upstreamRunId: 'upstream-end-first', childId: 'child-end-first' })
    registry.settleUpstreamEnd({ upstreamRunId: 'upstream-end-first', stopReason: 'error' })
    expect(registry.get(runId)?.phase).toBe('finalizing')
    expect(registry.get(runId)?.endedAt).toBeUndefined()
    registry.settleResult(runId, { stopReason: 'completed' })
    expect(registry.get(runId)?.phase).toBe('completed')
    expect(registry.get(runId)?.stopReason).toBe('completed')
    expect(registry.get(runId)?.cleanupWarnings).toEqual([{ code: 'upstream-end-error', severity: 'error' }])
  })

  test('result rejection uses upstream end in either arrival order', () => {
    for (const endFirst of [true, false]) {
      const { registry } = recordingRegistry({ now: 3_000 })
      const runId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@review' })
      registry.reserveChild(runId, 'child-rejection')
      registry.childIdle('child-rejection')
      registry.bindUpstreamStart({ hostRunId: runId, upstreamRunId: 'upstream-rejection', childId: 'child-rejection' })
      if (endFirst) {
        registry.settleUpstreamEnd({ upstreamRunId: 'upstream-rejection', stopReason: 'error' })
        expect(registry.get(runId)?.phase).toBe('finalizing')
        registry.rejectResult(runId, 'activation infrastructure failed')
      } else {
        registry.rejectResult(runId, 'activation infrastructure failed')
        expect(registry.get(runId)?.phase).toBe('finalizing')
        registry.settleUpstreamEnd({ upstreamRunId: 'upstream-rejection', stopReason: 'error' })
      }
      expect(registry.get(runId)?.phase).toBe('failed')
      expect(registry.get(runId)?.stopReason).toBe('error')
      expect(registry.get(runId)?.failure).toBe('activation infrastructure failed')
    }
  })

  test('rejection without an upstream binding fails the run immediately', () => {
    const { registry } = recordingRegistry({ now: 4_000 })
    const runId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@review' })
    registry.rejectResult(runId, 'activation infrastructure failed')
    expect(registry.get(runId)?.phase).toBe('failed')
    expect(registry.get(runId)?.stopReason).toBe('error')
    expect(registry.get(runId)?.failure).toBe('activation infrastructure failed')
    expect(registry.get(runId)?.endedAt).toBeDefined()
  })

  test('stopping absorbs execution outcomes until execution and cleanup are both confirmed', async () => {
    for (const stopReason of ['completed', 'error', 'max-tokens', 'refusal', 'aborted']) {
      const { registry } = recordingRegistry({ now: 5_000 })
      const runId = registry.begin({ parentSessionId: 'parent', kind: 'package', label: '@pkg' })
      await registry.requestCancel('parent', runId)
      registry.settleResult(runId, { stopReason })
      expect(registry.get(runId)?.phase).toBe('stopping')
      expect(registry.get(runId)?.stopReason).toBe(stopReason)
      registry.confirmCleanup(runId, { ok: true, warnings: [] })
      expect(registry.get(runId)?.phase).toBe('stopped')
    }

    const { registry } = recordingRegistry({ now: 5_000 })
    const rejectionId = registry.begin({ parentSessionId: 'parent', kind: 'package', label: '@pkg' })
    await registry.requestCancel('parent', rejectionId)
    registry.rejectResult(rejectionId, 'activation infrastructure failed')
    expect(registry.get(rejectionId)?.phase).toBe('stopping')
    registry.confirmCleanup(rejectionId, {
      ok: false,
      warnings: [{ code: 'runtime-stop-failed', severity: 'error' }],
    })
    expect(registry.get(rejectionId)?.phase).toBe('stopping')
    registry.confirmCleanup(rejectionId, { ok: true, warnings: [] })
    expect(registry.get(rejectionId)?.phase).toBe('stopped')
    expect(registry.get(rejectionId)?.failure).toBe('activation infrastructure failed')

    const startupFailureId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@legacy' })
    await registry.requestCancel('parent', startupFailureId)
    registry.failRun(startupFailureId, 'startup aborted')
    expect(registry.get(startupFailureId)?.phase).toBe('stopping')
    registry.confirmCleanup(startupFailureId, { ok: true, warnings: [] })
    expect(registry.get(startupFailureId)?.phase).toBe('stopped')

    const earlyCleanupId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@early-cleanup' })
    await registry.requestCancel('parent', earlyCleanupId)
    registry.confirmCleanup(earlyCleanupId, { ok: true, warnings: [] })
    expect(registry.get(earlyCleanupId)?.phase).toBe('stopping')
    registry.settleResult(earlyCleanupId, { stopReason: 'aborted' })
    // 早到的成功确认是持久事实:执行已终结,进入 stopping 的同一拍就收敛,不需要第二次确认。
    expect(registry.get(earlyCleanupId)?.phase).toBe('stopped')
    registry.confirmCleanup(earlyCleanupId, { ok: true, warnings: [] })
    expect(registry.get(earlyCleanupId)?.phase).toBe('stopped')
  })

  test('a confirmation remembered before execution ends converges when the end arrives later', () => {
    const clock = { now: 5_500 }
    const { registry } = recordingRegistry(clock)
    const runId = registry.begin({ parentSessionId: 'parent', kind: 'package', label: '@pkg' })
    registry.reserveChild(runId, 'child-inverted')
    registry.bindUpstreamStart({ hostRunId: runId, upstreamRunId: 'upstream-inverted', childId: 'child-inverted' })
    // 确认早于执行终结:只保存事实,不写终态、不写 endedAt、不写停止原因。
    registry.confirmCleanup(runId, { ok: true, warnings: [] })
    expect(registry.get(runId)?.phase).toBe('starting')
    expect(registry.get(runId)?.endedAt).toBeUndefined()
    expect(registry.get(runId)?.stopCause).toBeUndefined()
    registry.rejectResult(runId, 'activation infrastructure failed')
    expect(registry.get(runId)?.phase).toBe('starting')
    // result 已 rejected,后到的 aborted end 把 run 带入 stopping:执行已终结 + 已保存的
    // 确认必须直接收敛,不依赖调用方再发一次确认。
    registry.settleUpstreamEnd({ upstreamRunId: 'upstream-inverted', stopReason: 'aborted' })
    expect(registry.get(runId)?.phase).toBe('stopped')
    expect(registry.get(runId)?.stopCause).toBe('aborted')
    expect(registry.get(runId)?.endedAt).toBe(5_500)
    expect(registry.get(runId)?.failure).toBe('activation infrastructure failed')
  })

  test('a second end after convergence neither strands nor rewrites the stopped run', () => {
    const clock = { now: 5_600 }
    const { registry } = recordingRegistry(clock)
    const runId = registry.begin({ parentSessionId: 'parent', kind: 'package', label: '@pkg' })
    registry.reserveChild(runId, 'child-second-end')
    registry.bindUpstreamStart({ hostRunId: runId, upstreamRunId: 'upstream-second-end', childId: 'child-second-end' })
    registry.confirmCleanup(runId, { ok: true, warnings: [] })
    registry.rejectResult(runId, 'activation infrastructure failed')
    registry.settleUpstreamEnd({ upstreamRunId: 'upstream-second-end', stopReason: 'aborted' })
    expect(registry.get(runId)?.phase).toBe('stopped')
    const endedAt = registry.get(runId)?.endedAt
    expect(endedAt).toBe(5_600)
    clock.now = 90_000
    registry.settleUpstreamEnd({ upstreamRunId: 'upstream-second-end', stopReason: 'error' })
    expect(registry.get(runId)?.phase).toBe('stopped')
    expect(registry.get(runId)?.endedAt).toBe(endedAt)
    // 已收敛 run 上的第二个收尾来源只追加 info 告警,不再回到 stopping。
    registry.noteCleanupBudget(runId, 600_000)
    expect(registry.get(runId)?.phase).toBe('stopped')
    expect(registry.get(runId)?.cleanupWarnings).toEqual([{ code: 'cleanup-budget-exceeded', severity: 'info' }])
  })

  test('a failed confirmation never sets the durable success and a later success still converges', () => {
    const clock = { now: 5_700 }
    const { registry } = recordingRegistry(clock)
    const runId = registry.begin({ parentSessionId: 'parent', kind: 'package', label: '@pkg' })
    registry.reserveChild(runId, 'child-late-ok')
    registry.bindUpstreamStart({ hostRunId: runId, upstreamRunId: 'upstream-late-ok', childId: 'child-late-ok' })
    registry.confirmCleanup(runId, {
      ok: false,
      warnings: [{ code: 'runtime-stop-failed', severity: 'error' }],
    })
    registry.rejectResult(runId, 'activation infrastructure failed')
    registry.settleUpstreamEnd({ upstreamRunId: 'upstream-late-ok', stopReason: 'aborted' })
    expect(registry.get(runId)?.phase).toBe('stopping')
    expect(registry.get(runId)?.endedAt).toBeUndefined()
    registry.confirmCleanup(runId, { ok: false, warnings: [{ code: 'activation-dispose-failed', severity: 'error' }] })
    expect(registry.get(runId)?.phase).toBe('stopping')
    registry.confirmCleanup(runId, { ok: true, warnings: [] })
    expect(registry.get(runId)?.phase).toBe('stopped')
    expect(registry.get(runId)?.endedAt).toBe(5_700)
    // 告警是历史事实,成功确认不抹掉。
    expect(registry.get(runId)?.cleanupWarnings).toEqual([
      { code: 'runtime-stop-failed', severity: 'error' },
      { code: 'activation-dispose-failed', severity: 'error' },
    ])
  })

  test('a successful confirmation never rewrites an already-terminal run', () => {
    const { registry } = recordingRegistry({ now: 5_800 })
    const completedId = registry.begin({ parentSessionId: 'parent', kind: 'package', label: '@pkg' })
    registry.settleResult(completedId, { stopReason: 'completed' })
    registry.confirmCleanup(completedId, { ok: true, warnings: [] })
    expect(registry.get(completedId)?.phase).toBe('completed')
    expect(registry.get(completedId)?.stopReason).toBe('completed')

    const failedId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@legacy' })
    registry.rejectResult(failedId, 'activation infrastructure failed')
    registry.confirmCleanup(failedId, { ok: true, warnings: [] })
    expect(registry.get(failedId)?.phase).toBe('failed')
  })

  test('cleanup failure after a natural terminal only appends warnings', () => {
    const { registry } = recordingRegistry({ now: 6_000 })
    const runId = registry.begin({ parentSessionId: 'parent', kind: 'package', label: '@pkg' })
    registry.settleResult(runId, { stopReason: 'completed' })
    registry.confirmCleanup(runId, {
      ok: false,
      warnings: [{ code: 'runtime-stop-failed', severity: 'error' }],
    })
    expect(registry.get(runId)?.phase).toBe('completed')
    expect(registry.get(runId)?.cleanupWarnings).toEqual([{ code: 'runtime-stop-failed', severity: 'error' }])
  })

  test('lastActivity only tracks selected child execution activity', () => {
    const clock = { now: 1_000 }
    const { registry } = recordingRegistry(clock)
    const runId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@review' })
    expect(registry.get(runId)?.lastActivity).toBeUndefined()
    registry.reserveChild(runId, 'child-activity')
    registry.bindUpstreamStart({ hostRunId: runId, upstreamRunId: 'upstream-activity', childId: 'child-activity' })
    expect(registry.get(runId)?.lastActivity).toBeUndefined()
    clock.now = 1_001
    registry.noteReasoning('child-activity')
    expect(registry.get(runId)?.lastActivity).toBe(1_001)
    clock.now = 1_002
    registry.childIdle('child-activity')
    expect(registry.get(runId)?.lastActivity).toBe(1_001)
    clock.now = 1_003
    registry.startTool('child-activity', { callId: 'call-activity', name: 'read_file' })
    expect(registry.get(runId)?.lastActivity).toBe(1_003)
    clock.now = 1_004
    registry.endTool('child-activity', { callId: 'call-activity', name: 'read_file' })
    expect(registry.get(runId)?.lastActivity).toBe(1_004)
    clock.now = 1_005
    registry.settleResult(runId, { stopReason: 'completed' })
    registry.snapshot('parent')
    expect(registry.get(runId)?.lastActivity).toBe(1_004)
  })

  test('non-success stop reasons fail the run', () => {
    const { registry } = recordingRegistry({ now: 7_000 })
    for (const reason of ['max-tokens', 'refusal', 'future-unknown-reason']) {
      const id = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@other' })
      registry.settleResult(id, { stopReason: reason })
      expect(registry.get(id)?.phase).toBe('failed')
    }
  })

  test('cleanup budget bookkeeping never rewrites a terminal outcome', () => {
    const { registry } = recordingRegistry({ now: 8_000 })
    const budgetId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@budget' })
    registry.settleResult(budgetId, { stopReason: 'completed' })
    registry.noteCleanupBudget(budgetId, 5_000)
    expect(registry.get(budgetId)?.phase).toBe('completed')
    expect(registry.get(budgetId)?.cleanupBudgetMs).toBe(5_000)

    const budgetCompletionId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@budget-completion' })
    registry.noteCleanupBudget(budgetCompletionId, 5_000)
    expect(registry.get(budgetCompletionId)?.phase).toBe('stopping')
    registry.settleResult(budgetCompletionId, { stopReason: 'completed' })
    expect(registry.get(budgetCompletionId)?.phase).toBe('completed')
    expect(registry.get(budgetCompletionId)?.cleanupBudgetMs).toBe(5_000)
  })

  test('a terminal run does not revive on a late token', () => {
    const { registry } = recordingRegistry({ now: 9_000 })
    const runId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@review' })
    registry.reserveChild(runId, 'child-1')
    registry.settleResult(runId, { stopReason: 'completed' })
    registry.noteToken('child-1')
    expect(registry.get(runId)?.phase).toBe('completed')
  })

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
    assert.equal(registry.get(runId)?.stopCause, 'targeted-cancel')
    now = 20_000
    assert.deepEqual(await registry.requestCancel('parent', runId), { status: 'accepted', runId })
    assert.equal(registry.get(runId)?.stopRequestedAt, 10_000)
    assert.equal(registry.get(runId)?.lastActivity, 10_000)
    assert.equal(calls, 1)
    release()
    await Promise.resolve()
    // The cancel closure returning is not cleanup confirmation.
    assert.equal(registry.get(runId)?.phase, 'stopping')
    registry.settleResult(runId, { stopReason: 'aborted' })
    assert.equal(registry.get(runId)?.phase, 'stopping')
    registry.confirmCleanup(runId, { ok: true, warnings: [] })
    assert.equal(registry.get(runId)?.phase, 'stopped')
    assert.deepEqual(await registry.requestCancel('parent', runId), { status: 'already-terminal', runId })
    await assert.rejects(registry.requestCancel('other-parent', runId), /subagent run not found/)
  })

  test('an unlatched aborted run still requires cleanup confirmation and a late cancel attachment starts once', async () => {
    const { registry } = recordingRegistry({ now: 30_000 })
    const parentStoppedId = registry.begin({ parentSessionId: 'parent', kind: 'package', label: '@pkg' })
    registry.settleResult(parentStoppedId, { stopReason: 'aborted' })
    assert.equal(registry.get(parentStoppedId)?.phase, 'stopping')
    assert.equal(registry.get(parentStoppedId)?.stopCause, 'aborted')
    assert.equal(registry.get(parentStoppedId)?.stopRequestedAt, undefined)
    registry.confirmCleanup(parentStoppedId, { ok: true, warnings: [] })
    assert.equal(registry.get(parentStoppedId)?.phase, 'stopped')

    const earlyId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@early' })
    assert.deepEqual(await registry.requestCancel('parent', earlyId), { status: 'accepted', runId: earlyId })
    let earlyCalls = 0
    registry.attachCancel(earlyId, async () => { earlyCalls += 1 })
    await Promise.resolve()
    assert.equal(earlyCalls, 1)
    registry.attachCancel(earlyId, async () => { earlyCalls += 1 })
    await Promise.resolve()
    assert.equal(earlyCalls, 1)
    // A late attachment starts cleanup but never confirms stopped by itself.
    assert.equal(registry.get(earlyId)?.phase, 'stopping')
    assert.equal(registry.get(earlyId)?.stopRequestedAt, 30_000)
  })

  test('cancel rejects unknown and cross-parent runs with no side effects', async () => {
    const { registry, events } = recordingRegistry({ now: 40_000 })
    const runId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@review' })
    const siblingId = registry.begin({ parentSessionId: 'other-parent', kind: 'legacy', label: '@sibling' })
    const revision = registry.snapshot('parent').revision
    const emitted = events.length
    for (const [parentSessionId, targetRunId] of [
      ['other-parent', runId],
      ['parent', 'missing-run'],
    ] as const) {
      await assert.rejects(
        registry.requestCancel(parentSessionId, targetRunId),
        (error: unknown) =>
          error instanceof SubagentRunNotFoundError && error.message === 'subagent run not found',
      )
    }
    assert.equal(registry.snapshot('parent').revision, revision)
    assert.equal(events.length, emitted)
    assert.equal(registry.get(runId)?.phase, 'starting')
    assert.equal(registry.get(runId)?.stopRequestedAt, undefined)
    assert.equal(registry.get(siblingId)?.phase, 'starting')
    assert.equal(registry.get(siblingId)?.stopRequestedAt, undefined)
  })

  test('background cancel failures become one cleanup-failed warning instead of a rejection', async () => {
    const { registry } = recordingRegistry({ now: 50_000 })
    const rejectedId = registry.begin({ parentSessionId: 'parent', kind: 'package', label: '@pkg' })
    registry.attachCancel(rejectedId, () => Promise.reject(new Error('runtime stop failed')))
    await registry.requestCancel('parent', rejectedId)
    const thrownId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@sync-throw' })
    registry.attachCancel(thrownId, () => { throw new Error('sync stop failed') })
    await registry.requestCancel('parent', thrownId)
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    for (const runId of [rejectedId, thrownId]) {
      assert.equal(registry.get(runId)?.phase, 'stopping')
      assert.deepEqual(registry.get(runId)?.cleanupWarnings, [{ code: 'cleanup-failed', severity: 'error' }])
    }
    registry.settleResult(rejectedId, { stopReason: 'aborted' })
    registry.confirmCleanup(rejectedId, { ok: true, warnings: [] })
    assert.equal(registry.get(rejectedId)?.phase, 'stopped')
    assert.deepEqual(registry.get(rejectedId)?.cleanupWarnings, [{ code: 'cleanup-failed', severity: 'error' }])
  })

  test('snapshot is parent-scoped and terminal history is bounded with run-remove events', () => {
    const clock = { now: 60_000 }
    const { registry, events } = recordingRegistry(clock)
    const activeId = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: '@active' })
    registry.reserveChild(activeId, 'active-child')
    registry.noteToken('active-child')
    const lastActivity = registry.get(activeId)?.lastActivity
    assert.equal(lastActivity, 60_000)
    const stoppingId = registry.begin({ parentSessionId: 'parent', kind: 'package', label: '@stopping' })
    registry.noteCleanupBudget(stoppingId, 5_000)
    assert.equal(registry.get(stoppingId)?.phase, 'stopping')
    clock.now = 90_000

    for (let index = 0; index < 25; index += 1) {
      const id = registry.begin({ parentSessionId: 'parent', kind: 'legacy', label: `@done-${index}` })
      registry.settleResult(id, { stopReason: 'completed' })
    }
    const snapshot = registry.snapshot('parent')
    assert.equal(snapshot.runs.filter((run) => run.phase === 'completed').length, 20)
    assert.ok(snapshot.runs.some((run) => run.runId === activeId))
    assert.ok(snapshot.runs.every((run) => run.parentSessionId === 'parent'))
    assert.ok(snapshot.revision >= 25)
    // Snapshot uses the same projection shape as `get`, and reconciliation is read-only:
    // it never refreshes lastActivity.
    assert.deepEqual(snapshot.runs.find((run) => run.runId === activeId), registry.get(activeId))
    assert.equal(registry.get(activeId)?.lastActivity, lastActivity)
    assert.equal(snapshot.runs.find((run) => run.runId === activeId)?.lastActivity, lastActivity)

    for (let index = 0; index < 205; index += 1) {
      const id = registry.begin({ parentSessionId: `parent-${index}`, kind: 'legacy', label: '@global' })
      registry.settleResult(id, { stopReason: 'completed' })
    }
    const finalSnapshot = registry.snapshot('parent')
    assert.ok(finalSnapshot.runs.some((run) => run.runId === activeId))
    assert.ok(finalSnapshot.runs.some((run) => run.runId === stoppingId && run.phase === 'stopping'))

    const latestRevision = new Map<string, number>()
    const latestParent = new Map<string, string>()
    const terminalIds = new Set<string>()
    const removedIds = new Set<string>()
    for (const event of events) {
      if (event.event === 'subagent/run') {
        latestRevision.set(event.run.runId, event.run.revision)
        latestParent.set(event.run.runId, event.run.parentSessionId)
        if (event.run.phase === 'completed' || event.run.phase === 'failed' || event.run.phase === 'stopped') {
          terminalIds.add(event.run.runId)
        }
        continue
      }
      if (event.event !== 'subagent/run-remove') continue
      removedIds.add(event.runId)
      assert.ok(terminalIds.has(event.runId), 'pruning must only target terminal runs')
      assert.notEqual(event.runId, activeId)
      assert.notEqual(event.runId, stoppingId)
      assert.equal(event.generation, snapshot.generation)
      assert.equal(event.revision, latestRevision.get(event.runId))
      assert.equal(event.parentSessionId, latestParent.get(event.runId))
    }
    assert.equal(terminalIds.size, 230)
    assert.equal(terminalIds.size - removedIds.size, 200)
  })
})
