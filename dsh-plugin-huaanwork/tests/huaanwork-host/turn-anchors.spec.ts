import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createTurnAnchorStore,
  installTurnAnchorHooks,
  type TurnAnchorStore,
} from '../../src/huaanwork-host/turn-anchors.ts'
import { registerChildSession, resetChildSessionRegistry } from '../../src/huaanwork-host/child-sessions.ts'
import type { RouteContext } from '../../src/huaanwork-host/routes.ts'
import {
  releaseSessionRuntime,
  resolveFollowupClientMessageId,
  sendToAgent,
  turnOriginForSession,
  type SessionRuntimeContext,
} from '../../src/huaanwork-host/sessions.ts'

const message = (id: string, kind = 'user') => ({ role: 'user', id, source: { kind } })

describe('turn anchor store', () => {
  it('registers pending state and exposes an anchor only after pre-step', () => {
    const store = createTurnAnchorStore()
    store.register({ sessionId: 's1', clientMessageId: 'm1', origin: 'advanced' })
    expect(store.current('s1')).toBeUndefined()
    expect(store.notePreStep('s1', [message('m1')], '2026-11-15T10:00:00.000Z')).toEqual({
      clientMessageId: 'm1', startedAt: '2026-11-15T10:00:00.000Z', origin: 'advanced',
    })
  })

  it('marks unregistered ordinary users unknown and keeps note idempotent', () => {
    const store = createTurnAnchorStore()
    const first = store.notePreStep('s1', [message('m1')], 't1')
    const replay = store.notePreStep('s1', [message('m1')], 't2')
    expect(first?.origin).toBe('unknown')
    expect(replay).toEqual(first)
    store.register({ sessionId: 's1', clientMessageId: 'm2', origin: 'advanced' })
    expect(store.notePreStep('s1', [message('m2')], 't3')).toMatchObject({ clientMessageId: 'm2', startedAt: 't3' })
    // 旧夹具缺 source.kind:role user 的无 source 消息仍按真实用户回合处理(降级 unknown)。
    expect(store.notePreStep('s3', [{ role: 'user', id: 'legacy' }], 't4')).toMatchObject({
      clientMessageId: 'legacy',
      startedAt: 't4',
      origin: 'unknown',
    })
  })

  it('keeps the original anchor across goal continuation and fails closed without one', () => {
    const store = createTurnAnchorStore()
    store.register({ sessionId: 's1', clientMessageId: 'm1', origin: 'advanced' })
    const original = store.notePreStep('s1', [message('m1')], 't1')
    expect(store.notePreStep('s1', [message('goal-2', 'goal')], 't9')).toEqual(original)
    expect(store.notePreStep('s2', [message('goal-1', 'goal')], 't2')).toBeUndefined()
  })

  it('keeps the anchor unchanged across subagent-settled and non-human notices while resolving paired human turns', () => {
    const store = createTurnAnchorStore()
    store.register({ sessionId: 's1', clientMessageId: 'm1', origin: 'advanced' })
    const original = store.notePreStep('s1', [message('m1')], 't1')
    // subagent-settled 完成通知与 agent-instructions 等系统消息不得换锚或写成 unknown
    expect(store.notePreStep('s1', [message('notice-1', 'subagent-settled')], 't2')).toEqual(original)
    expect(store.notePreStep('s1', [message('inst-1', 'agent-instructions')], 't3')).toEqual(original)
    // 同批次尾随系统通知时仍可从前向后扫到真实用户消息
    store.register({ sessionId: 's1', clientMessageId: 'm2', origin: 'advanced' })
    expect(store.notePreStep('s1', [message('m2'), message('notice-2', 'subagent-settled')], 't4')).toMatchObject({
      clientMessageId: 'm2',
      startedAt: 't4',
      origin: 'advanced',
    })
  })

  it('leaves the anchor unchanged for steps without a new user message', () => {
    const store = createTurnAnchorStore()
    store.notePreStep('s1', [message('m1')], 't1')
    expect(store.notePreStep('s1', [{ role: 'tool', id: 'tool-1' }], 't2')?.clientMessageId).toBe('m1')
  })

  it('evicts least-recently-used sessions and clears pending and anchors', () => {
    const store = createTurnAnchorStore({ limit: 1 })
    store.notePreStep('s1', [message('m1')], 't1')
    store.notePreStep('s2', [message('m2')], 't2')
    expect(store.current('s1')).toBeUndefined()
    store.clearSession('s2')
    expect(store.current('s2')).toBeUndefined()
  })

  it('rolls back only the current pending registration when followup fails', () => {
    const store = createTurnAnchorStore()
    store.notePreStep('s1', [message('old')], 't1')
    const rollback = store.register({ sessionId: 's1', clientMessageId: 'new', origin: 'advanced' })
    rollback()
    expect(store.current('s1')?.clientMessageId).toBe('old')
    expect(store.notePreStep('s1', [message('new')], 't2')?.origin).toBe('unknown')
  })
})

type PreStepListener = (payload: unknown, next: () => unknown) => unknown
type DisposedListener = (session: { id?: string }) => void

/** 只收集本模块注册的两类监听器;`on` 形状与 installTurnAnchorHooks 的窄契约一致。 */
function hooksContext(store: TurnAnchorStore) {
  const preStep: PreStepListener[] = []
  const disposed: DisposedListener[] = []
  const ctx: {
    huaanworkTurnAnchors?: TurnAnchorStore
    on(event: string, listener: (...args: never[]) => unknown, options?: { global?: boolean }): void
  } = {
    huaanworkTurnAnchors: store,
    on(event, listener) {
      if (event === 'agent/pre-step') preStep.push(listener as unknown as PreStepListener)
      if (event === 'session/disposed') disposed.push(listener as unknown as DisposedListener)
    },
  }
  return { ctx, preStep, disposed }
}

/** 按 A→B / B→A 顺序跑一次 waterfall:每个 listener 都必须调用自己的 `next()` 才能继续。 */
function runWaterfall(listeners: PreStepListener[], payload: unknown) {
  const nextCalls = listeners.map(() => 0)
  const run = (index: number): unknown => {
    const listener = listeners[index]
    if (listener === undefined) return 'end'
    return listener(payload, () => {
      nextCalls[index] = (nextCalls[index] ?? 0) + 1
      return run(index + 1)
    })
  }
  return { result: run(0), nextCalls }
}

describe('turn anchor pre-step hook', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns next() so every listener sees the same idempotent anchor in both orders', () => {
    // 时钟固定:安装的监听器与附加监听器各自传自己的 startedAt,幂等语义要求结果一致。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-15T10:00:00.000Z'))
    const startedAt = '2026-11-15T10:00:00.000Z'
    const messages = [message('m1')]
    const extra = (store: TurnAnchorStore): PreStepListener => (_payload, next) => {
      store.notePreStep('s1', messages, startedAt)
      return next()
    }
    const payload = { agent: { id: 's1', session: { id: 's1' } }, messages, turn: 0, signal: undefined }

    for (const order of [0, 1]) {
      const store = createTurnAnchorStore()
      const hooks = hooksContext(store)
      installTurnAnchorHooks(hooks.ctx)
      const installed = hooks.preStep[0]
      expect(installed).toBeDefined()
      const listeners = order === 0
        ? [installed!, extra(store)]
        : [extra(store), installed!]
      const { result, nextCalls } = runWaterfall(listeners, payload)
      expect(result).toBe('end')
      expect(nextCalls).toEqual([1, 1])
      expect(store.current('s1')).toEqual({ clientMessageId: 'm1', startedAt, origin: 'unknown' })
    }
  })

  it('clears the session anchor and pending registration on session/disposed', () => {
    const store = createTurnAnchorStore()
    const hooks = hooksContext(store)
    installTurnAnchorHooks(hooks.ctx)
    expect(hooks.disposed).toHaveLength(1)

    store.notePreStep('s1', [message('m1')], 't1')
    store.register({ sessionId: 's1', clientMessageId: 'm2', origin: 'automation' })
    hooks.disposed[0]!({ id: 's1' })
    expect(store.current('s1')).toBeUndefined()
    // pending 同时清掉:再次观察 m2 只能降级为 unknown,不能继承已删会话的写注册。
    expect(store.notePreStep('s1', [message('m2')], 't2')?.origin).toBe('unknown')
  })
})

function routeCtxForTest(): RouteContext {
  return {
    dshHome: '/tmp/huaanwork-turn-anchors-dsh',
    profileDir: '/tmp/huaanwork-turn-anchors-profile',
    workspaceRoot: { current: '/tmp/huaanwork-turn-anchors-workspace' },
    emit: () => undefined,
    logger: () => undefined,
    requestRestart: async () => true,
  }
}

describe('followup identity and turn origin', () => {
  it('resolves the followup id from the top-level clientMessageId only', () => {
    expect(resolveFollowupClientMessageId({ clientMessageId: 'top', at: { clientMessageId: 'at-id' } })).toBe('top')
    // 旧的 at.clientMessageId 只是本地卡片兼容值,绝不能当持久回合锚。
    const generated = resolveFollowupClientMessageId({ at: { clientMessageId: 'at-id' } })
    expect(generated).not.toBe('at-id')
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    const missing = resolveFollowupClientMessageId(undefined)
    expect(missing).toMatch(/^[0-9a-f-]{36}$/i)
    expect(missing).not.toBe(generated)
  })

  it('classifies automation run sessions by their session prefix', () => {
    expect(turnOriginForSession('huaanwork-auto-x-y')).toBe('automation')
    expect(turnOriginForSession('huaanwork-0123456789abcdef')).toBe('advanced')
  })
})

describe('sendToAgent anchor wiring', () => {
  it('registers an accepted send so its first pre-step resolves the advanced origin', async () => {
    const anchors = createTurnAnchorStore()
    const ctx: SessionRuntimeContext = {
      huaanworkTurnAnchors: anchors,
      agents: {
        get: (id) => (id === 's1' ? { id: 's1', session: { id: 's1' }, followup: () => undefined } : undefined),
      },
    }
    await expect(
      sendToAgent(ctx, routeCtxForTest(), { sessionId: 's1', text: '你好', clientMessageId: 'm1' }),
    ).resolves.toMatchObject({ queued: true, sessionId: 's1', started: true })
    expect(anchors.notePreStep('s1', [message('m1')], 't1')).toEqual({
      clientMessageId: 'm1',
      startedAt: 't1',
      origin: 'advanced',
    })
  })

  it('rolls back the pending anchor when the followup is rejected', async () => {
    const anchors = createTurnAnchorStore()
    anchors.notePreStep('s1', [message('old')], 't1')
    const ctx: SessionRuntimeContext = {
      huaanworkTurnAnchors: anchors,
      agents: {
        get: (id) =>
          id === 's1'
            ? {
                id: 's1',
                session: { id: 's1' },
                followup: () => {
                  throw new Error('followup rejected')
                },
              }
            : undefined,
      },
    }
    await expect(
      sendToAgent(ctx, routeCtxForTest(), { sessionId: 's1', text: '新问题', clientMessageId: 'new' }),
    ).rejects.toThrow('followup rejected')
    // 上一回合的 anchor 保持不变;本次 pending 已撤回,再次观察只能降级为 unknown。
    expect(anchors.current('s1')?.clientMessageId).toBe('old')
    expect(anchors.notePreStep('s1', [message('new')], 't2')?.origin).toBe('unknown')
  })

  it('clears anchors for the session and its descendants on releaseSessionRuntime', () => {
    resetChildSessionRegistry()
    try {
      const anchors = createTurnAnchorStore()
      anchors.notePreStep('parent', [message('p1')], 't1')
      anchors.notePreStep('child', [message('c1')], 't2')
      anchors.notePreStep('grandchild', [message('g1')], 't3')
      anchors.notePreStep('sibling', [message('s1')], 't4')
      registerChildSession('parent', 'child')
      registerChildSession('child', 'grandchild')

      releaseSessionRuntime({ huaanworkTurnAnchors: anchors }, 'parent')

      expect(anchors.current('parent')).toBeUndefined()
      expect(anchors.current('child')).toBeUndefined()
      expect(anchors.current('grandchild')).toBeUndefined()
      // 不在删除名单里的会话不受牵连。
      expect(anchors.current('sibling')?.clientMessageId).toBe('s1')
    } finally {
      resetChildSessionRegistry()
    }
  })
})
