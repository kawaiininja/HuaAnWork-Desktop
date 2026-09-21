import { afterEach, describe, expect, test, vi } from 'vitest'
import { registerApproval, resolveApproval, type ApprovalMap, type ApprovalResult } from '../../src/huaanwork-host/approvals.ts'

// —— host 侧 registerApproval/resolveApproval(旧 sidecar approvals.ts 逐字语义):
// pending resolve、unknown id no-op;超时→unavailable / abort→cancelled 走
// guardrails/approval.ts 的 waitForApproval(其唯一实现处,旧 bundle approval.ts 逐字平移)——

describe('registerApproval / resolveApproval (host)', () => {
  test('resolves a pending approval exactly once', async () => {
    const pending = new Map() as ApprovalMap
    const promise = registerApproval(pending, 'req-1')
    expect(pending.has('req-1')).toBe(true)
    expect(resolveApproval(pending, 'req-1', 'allowed-once')).toBe(true)
    expect(pending.has('req-1')).toBe(false)
    await expect(promise).resolves.toBe('allowed-once')
    // 已解析的 id 再次 resolve 是 no-op(unknown id 语义,AGENTS.md 不变式 7)
    expect(resolveApproval(pending, 'req-1', 'rejected')).toBe(false)
  })

  test('unknown id resolves to false without touching the map', () => {
    const pending = new Map() as ApprovalMap
    expect(resolveApproval(pending, 'nope', 'rejected')).toBe(false)
    expect(pending.size).toBe(0)
  })

  test('rejects empty ids and duplicate pending ids', () => {
    const pending = new Map() as ApprovalMap
    expect(() => registerApproval(pending, '')).toThrow(/required/)
    registerApproval(pending, 'req-1')
    expect(() => registerApproval(pending, 'req-1')).toThrow(/already pending/)
  })
})

describe('approval/request 生命周期 (guardrails/approval.ts)', () => {
  type Answerer = (
    request: { agent: unknown; toolName: string; callId?: string; signal?: AbortSignal },
    next: () => Promise<ApprovalResult>,
  ) => Promise<ApprovalResult>

  function fakeApprovalContext() {
    let answerer: Answerer | undefined
    const approvals = new Map<string, (result: ApprovalResult) => void>()
    const allowedOnce = new Set<string>()
    const events: unknown[] = []
    const ctx = {
      huaanworkApprovals: approvals,
      huaanworkAllowedOnce: allowedOnce,
      huaanworkEmit(event: unknown) {
        events.push(event)
      },
      approval: {
        setPolicy: (_agent: unknown, _policy: string) => undefined,
      },
      on(event: string, listener: unknown) {
        if (event === 'approval/request') answerer = listener as Answerer
      },
    }
    return { ctx, approvals, allowedOnce, events, answererRef: () => answerer }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  test('pending resolve: emits approval/asked then resolves allowed-once and records the callId', async () => {
    const { ctx, approvals, allowedOnce, events, answererRef } = fakeApprovalContext()
    const { apply } = await import('../../src/huaanwork-guardrails/approval.ts')
    apply(ctx as never)
    const pending = answererRef()!({ agent: {}, toolName: 'bash', callId: 'call-1' }, async () => 'unavailable')
    await new Promise((resolve) => setImmediate(resolve))
    const [event] = events as [{ approvalRequestId: string; toolName: string; callId?: string }]
    approvals.get(event.approvalRequestId)?.('allowed-once' as ApprovalResult)
    await expect(pending).resolves.toBe('allowed-once')
    expect(allowedOnce.has('call-1')).toBe(true)
    expect(event.toolName).toBe('bash')
    expect(event.callId).toBe('call-1')
    // finally 清理:map 中不再残留
    expect(approvals.size).toBe(0)
  })

  test('120s 超时 → unavailable(假定时器)', async () => {
    vi.useFakeTimers()
    const { ctx, approvals, answererRef } = fakeApprovalContext()
    const { apply } = await import('../../src/huaanwork-guardrails/approval.ts')
    apply(ctx as never)
    const pending = answererRef()!({ agent: {}, toolName: 'bash' }, async () => 'unavailable')
    await vi.advanceTimersByTimeAsync(120_000)
    await expect(pending).resolves.toBe('unavailable')
    // 超时路径同样清理 pending 登记
    expect(approvals.size).toBe(0)
  })

  test('abort → cancelled', async () => {
    const { ctx, approvals, answererRef } = fakeApprovalContext()
    const { apply } = await import('../../src/huaanwork-guardrails/approval.ts')
    apply(ctx as never)
    const controller = new AbortController()
    const pending = answererRef()!({ agent: {}, toolName: 'bash', signal: controller.signal }, async () => 'unavailable')
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(approvals.size).toBe(0)
  })

  test('pre-aborted signal short-circuits to cancelled without emitting', async () => {
    const { ctx, events, answererRef } = fakeApprovalContext()
    const { apply } = await import('../../src/huaanwork-guardrails/approval.ts')
    apply(ctx as never)
    const controller = new AbortController()
    controller.abort()
    await expect(
      answererRef()!({ agent: {}, toolName: 'bash', signal: controller.signal }, async () => 'unavailable'),
    ).resolves.toBe('cancelled')
    expect(events).toHaveLength(0)
  })
})
