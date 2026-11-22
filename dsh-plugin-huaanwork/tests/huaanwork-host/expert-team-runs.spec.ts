import { describe, expect, it } from 'vitest'
import type { RpcEvent } from '../../src/client-huaanwork/rpc-types.ts'
import { createExpertTeamRunRegistry } from '../../src/huaanwork-host/expert-team/runs.ts'
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
})
