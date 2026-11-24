import { describe, expect, it } from 'vitest'
import type { RpcEvent } from '../../src/client-huaanwork/rpc-types.ts'
import {
  createExpertTeamRunRegistry,
  ExpertTeamRunNotFoundError,
} from '../../src/huaanwork-host/expert-team/runs.ts'
import { artifact, validTeam } from '../fixtures/expert-team/team.ts'

describe('expert team run registry', () => {
  it('projects generation and monotonic revision with bounded terminal history', () => {
    const events: RpcEvent[] = []
    const registry = createExpertTeamRunRegistry({ generation: 'g1', terminalPerParent: 1, terminalGlobal: 2, emit: (event) => events.push(event) })
    const run = registry.begin({ parentSessionId: 's1', clientMessageId: 'm1', teamSnapshot: validTeam() })
    expect(registry.list({ sessionId: 's1' })).toMatchObject({ generation: 'g1', revision: 1, runs: [{ teamRunId: run.teamRunId, revision: 1 }] })
    registry.update(run.teamRunId, (current) => { current.dispatchAttempts = 1 })
    expect(events.at(-1)).toMatchObject({ event: 'expertTeam/run', generation: 'g1', run: { revision: 2, dispatchAttempts: 1 } })
    registry.update(run.teamRunId, (current) => { current.status = 'completed'; current.endedAt = new Date(0).toISOString() })
    const second = registry.begin({ parentSessionId: 's1', clientMessageId: 'm2', teamSnapshot: validTeam() })
    registry.update(second.teamRunId, (current) => { current.status = 'failed'; current.endedAt = new Date(0).toISOString() })
    expect(registry.list({ sessionId: 's1' }).runs.map((item) => item.teamRunId)).toEqual([second.teamRunId])
    expect(events.some((event) => event.event === 'expertTeam/run-remove' && typeof event.revision === 'number')).toBe(true)
  })

  it('latches stopping immediately without blocking RPC, converges via markStopped, and associates matching persisted turn anchors', async () => {
    const registry = createExpertTeamRunRegistry({ generation: 'g1', emit: () => undefined })
    const run = registry.begin({ parentSessionId: 's1', clientMessageId: 'm1', teamSnapshot: validTeam() })
    let calls = 0
    let releaseCancel!: () => void
    registry.attachCancel(run.teamRunId, () => {
      calls += 1
      return new Promise<void>((resolve) => { releaseCancel = resolve })
    })
    const first = registry.requestCancel('s1', run.teamRunId)
    const second = registry.requestCancel('s1', run.teamRunId)
    expect(first).toEqual({ status: 'accepted', teamRunId: run.teamRunId })
    expect(second).toEqual({ status: 'accepted', teamRunId: run.teamRunId })
    expect(calls).toBe(1)
    expect(registry.get(run.teamRunId)?.status).toBe('stopping')
    expect(registry.hasActive(run.teamId)).toBe(true)
    expect(registry.hasActiveForSession('s1')).toBe(true)
    releaseCancel()
    registry.markStopped(run.teamRunId)
    expect(registry.get(run.teamRunId)?.status).toBe('stopped')
    expect(registry.hasActive(run.teamId)).toBe(false)
    expect(registry.noteSessionArtifact('s1', 'call-1', artifact({ anchor: { kind: 'turn', clientMessageId: 'other' } }))).toBe(false)
    expect(registry.noteSessionArtifact('s1', 'call-1', artifact({ anchor: { kind: 'turn', clientMessageId: 'm1' } }))).toBe(false) // 未先 seal
    registry.sealDelivery(run.teamRunId, 'call-1')
    expect(registry.noteSessionArtifact('s1', 'call-1', artifact({ anchor: { kind: 'turn', clientMessageId: 'm1' } }))).toBe(true)
    expect(registry.get(run.teamRunId)).toMatchObject({ primaryArtifactCallId: 'call-1', artifactStatus: 'created', deliverySealed: true })
  })

  it('enforces default 20-per-parent and 100-global terminal eviction without evicting active runs, converges cancelAll, and isolates registries', async () => {
    const regA = createExpertTeamRunRegistry({ generation: 'g1', emit: () => undefined })
    const regB = createExpertTeamRunRegistry({ generation: 'g1', emit: () => undefined })
    // 单会话默认最多保留 20 条终态；活跃/stopping 不被淘汰
    const activeRun = regA.begin({ parentSessionId: 's-keep', clientMessageId: 'm-active', teamSnapshot: validTeam() })
    for (let i = 0; i < 21; i += 1) {
      const r = regA.begin({ parentSessionId: 's-keep', clientMessageId: `m-t-${i}`, teamSnapshot: validTeam() })
      regA.update(r.teamRunId, (cur) => { cur.status = 'completed'; cur.endedAt = new Date(i * 1000).toISOString() })
    }
    const keepRuns = regA.list({ sessionId: 's-keep' }).runs
    expect(keepRuns.some((item) => item.teamRunId === activeRun.teamRunId)).toBe(true)
    expect(keepRuns.filter((item) => item.status === 'completed')).toHaveLength(20)

    // 全局默认最多保留 100 条终态（跨 6 个会话合计 > 100 条终态）
    for (let s = 0; s < 5; s += 1) {
      for (let i = 0; i < 20; i += 1) {
        const r = regA.begin({ parentSessionId: `s-bulk-${s}`, clientMessageId: `m-${s}-${i}`, teamSnapshot: validTeam() })
        regA.update(r.teamRunId, (cur) => { cur.status = 'completed'; cur.endedAt = new Date((s * 20 + i + 100) * 1000).toISOString() })
      }
    }
    const allA = regA.list().runs
    expect(allA.filter((item) => item.status === 'completed')).toHaveLength(100)
    expect(allA.some((item) => item.teamRunId === activeRun.teamRunId)).toBe(true)
    // 不同 Host/profile 的 registry 投影严格隔离
    expect(regB.list().runs).toEqual([])

    // cancelAll 触发全部活跃/stopping 取消闭包并等待收敛
    const otherActive = regA.begin({ parentSessionId: 's-other', clientMessageId: 'm-other', teamSnapshot: validTeam() })
    const settled: string[] = []
    regA.attachCancel(activeRun.teamRunId, async () => { settled.push(activeRun.teamRunId) })
    regA.attachCancel(otherActive.teamRunId, async () => { settled.push(otherActive.teamRunId) })
    await regA.cancelAll()
    expect(settled).toEqual(expect.arrayContaining([activeRun.teamRunId, otherActive.teamRunId]))
    expect(regA.get(activeRun.teamRunId)?.status).toBe('stopping')
    expect(regA.get(otherActive.teamRunId)?.status).toBe('stopping')
  })

  it('distinguishes activeBySession (running only) from hasActiveForSession (running or stopping)', () => {
    const registry = createExpertTeamRunRegistry({ generation: 'g1', emit: () => undefined })
    const run = registry.begin({ parentSessionId: 's1', clientMessageId: 'm1', teamSnapshot: validTeam() })
    expect(registry.activeBySession('s1')?.teamRunId).toBe(run.teamRunId)
    expect(registry.hasActiveForSession('s1')).toBe(true)
    expect(registry.activeBySession('s2')).toBeUndefined()
    expect(registry.hasActiveForSession('s2')).toBe(false)

    registry.attachCancel(run.teamRunId, async () => undefined)
    expect(registry.requestCancel('s1', run.teamRunId)).toEqual({ status: 'accepted', teamRunId: run.teamRunId })
    // stopping 仍占用会话（阻止同会话第二次团队调用），但不再是唯一活动运行的派发锚点。
    expect(registry.activeBySession('s1')).toBeUndefined()
    expect(registry.hasActiveForSession('s1')).toBe(true)
    expect(registry.hasActive(run.teamId)).toBe(true)

    registry.markStopped(run.teamRunId)
    expect(registry.activeBySession('s1')).toBeUndefined()
    expect(registry.hasActiveForSession('s1')).toBe(false)
    expect(registry.hasActive(run.teamId)).toBe(false)

    const other = registry.begin({ parentSessionId: 's2', clientMessageId: 'm2', teamSnapshot: validTeam() })
    expect(registry.activeBySession('s2')?.teamRunId).toBe(other.teamRunId)
    expect(registry.activeBySession('s1')).toBeUndefined()
  })

  it('finds runs by parent turn anchor across running, stopping, and terminal states', () => {
    const registry = createExpertTeamRunRegistry({ generation: 'g1', emit: () => undefined })
    const run = registry.begin({ parentSessionId: 's1', clientMessageId: 'm1', teamSnapshot: validTeam() })
    expect(registry.byTurn('s1', 'm1')).toMatchObject({ teamRunId: run.teamRunId, status: 'running', clientMessageId: 'm1' })
    expect(registry.byTurn('s2', 'm1')).toBeUndefined()
    expect(registry.byTurn('s1', 'm2')).toBeUndefined()

    registry.attachCancel(run.teamRunId, async () => undefined)
    registry.requestCancel('s1', run.teamRunId)
    expect(registry.byTurn('s1', 'm1')?.status).toBe('stopping')

    registry.markStopped(run.teamRunId)
    expect(registry.byTurn('s1', 'm1')?.status).toBe('stopped')

    const second = registry.begin({ parentSessionId: 's1', clientMessageId: 'm2', teamSnapshot: validTeam() })
    expect(registry.byTurn('s1', 'm2')?.teamRunId).toBe(second.teamRunId)
    // 终态运行未被淘汰前仍可对账。
    expect(registry.byTurn('s1', 'm1')?.teamRunId).toBe(run.teamRunId)
  })

  it('marks artifact link failure while pending and clears it on same-callId replay', () => {
    const events: RpcEvent[] = []
    const registry = createExpertTeamRunRegistry({ generation: 'g1', emit: (event) => events.push(event) })
    const run = registry.begin({ parentSessionId: 's1', clientMessageId: 'm1', teamSnapshot: validTeam() })
    registry.sealDelivery(run.teamRunId, 'call-1')

    registry.noteArtifactLinkError(run.teamRunId, 'artifact not found')
    expect(registry.get(run.teamRunId)).toMatchObject({
      artifactStatus: 'pending',
      artifactLinkError: 'artifact not found',
      primaryArtifactCallId: 'call-1',
    })
    expect(events.at(-1)).toMatchObject({
      event: 'expertTeam/run',
      run: { artifactStatus: 'pending', artifactLinkError: 'artifact not found' },
    })

    // 同 callId 重放关联成功：写入 Artifact 并清除先前的关联失败残态。
    expect(registry.noteSessionArtifact('s1', 'call-1', artifact())).toBe(true)
    const linked = registry.get(run.teamRunId)
    expect(linked).toMatchObject({ artifactStatus: 'created', primaryArtifactId: 'artifact-1' })
    expect(linked?.artifactLinkError).toBeUndefined()

    // 已成功关联后迟到的错误不复活残态。
    registry.noteArtifactLinkError(run.teamRunId, 'late failure')
    expect(registry.get(run.teamRunId)).toMatchObject({ artifactStatus: 'created', primaryArtifactId: 'artifact-1' })
    expect(registry.get(run.teamRunId)?.artifactLinkError).toBeUndefined()
  })

  it('reports already-terminal cancels without mutation and rejects unknown or cross-session runs', () => {
    const registry = createExpertTeamRunRegistry({ generation: 'g1', emit: () => undefined })
    const settled = registry.begin({ parentSessionId: 's1', clientMessageId: 'm1', teamSnapshot: validTeam() })
    registry.update(settled.teamRunId, (current) => {
      current.status = 'completed'
      current.endedAt = new Date(0).toISOString()
    })
    const settledRevision = registry.get(settled.teamRunId)?.revision

    expect(registry.requestCancel('s1', settled.teamRunId)).toEqual({ status: 'already-terminal', teamRunId: settled.teamRunId })
    expect(registry.get(settled.teamRunId)?.status).toBe('completed')
    expect(registry.get(settled.teamRunId)?.revision).toBe(settledRevision)

    let cancelCalls = 0
    const running = registry.begin({ parentSessionId: 's2', clientMessageId: 'm2', teamSnapshot: validTeam() })
    registry.attachCancel(running.teamRunId, async () => {
      cancelCalls += 1
    })
    expect(() => registry.requestCancel('s1', running.teamRunId)).toThrow(ExpertTeamRunNotFoundError)
    expect(() => registry.requestCancel('s2', 'missing-run')).toThrow(ExpertTeamRunNotFoundError)
    // 跨会话取消零副作用：不退化为会话级取消，运行保持 running。
    expect(cancelCalls).toBe(0)
    expect(registry.get(running.teamRunId)?.status).toBe('running')
  })

  it('starts a late-bound cancel closure once after the stop latch', async () => {
    const registry = createExpertTeamRunRegistry({ generation: 'g1', emit: () => undefined })
    const run = registry.begin({ parentSessionId: 's1', clientMessageId: 'm1', teamSnapshot: validTeam() })
    expect(registry.requestCancel('s1', run.teamRunId)).toEqual({ status: 'accepted', teamRunId: run.teamRunId })
    expect(registry.get(run.teamRunId)?.status).toBe('stopping')

    let firstCalls = 0
    let secondCalls = 0
    registry.attachCancel(run.teamRunId, async () => {
      firstCalls += 1
    })
    expect(firstCalls).toBe(1)
    // 已启动的取消闭包不被晚到的替换覆盖。
    registry.attachCancel(run.teamRunId, async () => {
      secondCalls += 1
    })
    expect(secondCalls).toBe(0)
    await registry.cancelBySession('s1')
    expect(firstCalls).toBe(1)
    expect(registry.get(run.teamRunId)?.status).toBe('stopping')

    registry.markStopped(run.teamRunId)
    expect(registry.requestCancel('s1', run.teamRunId)).toEqual({ status: 'already-terminal', teamRunId: run.teamRunId })
    expect(firstCalls).toBe(1)
  })

  it('keeps the first delivery seal when a different callId tries to re-seal', () => {
    const events: RpcEvent[] = []
    const registry = createExpertTeamRunRegistry({ generation: 'g1', emit: (event) => events.push(event) })
    const run = registry.begin({ parentSessionId: 's1', clientMessageId: 'm1', teamSnapshot: validTeam() })
    registry.sealDelivery(run.teamRunId, 'call-1')
    const sealedRevision = registry.get(run.teamRunId)?.revision
    const sealedEventCount = events.length

    registry.sealDelivery(run.teamRunId, 'call-2')
    expect(registry.get(run.teamRunId)).toMatchObject({ primaryArtifactCallId: 'call-1', deliverySealed: true })
    expect(registry.get(run.teamRunId)?.revision).toBe(sealedRevision)
    expect(events.length).toBe(sealedEventCount)

    // 只有首次 commit 的 callId 能完成 Artifact 关联。
    expect(registry.noteSessionArtifact('s1', 'call-2', artifact())).toBe(false)
    expect(registry.noteSessionArtifact('s1', 'call-1', artifact())).toBe(true)
    expect(registry.get(run.teamRunId)).toMatchObject({
      primaryArtifactCallId: 'call-1',
      primaryArtifactId: 'artifact-1',
      artifactStatus: 'created',
    })
  })
})
