import { MessageId, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  bindExpertTeamObserver,
  createExpertTeamTurnObserver,
  disposeExpertTeamObservers,
} from '../../src/huaanwork-host/expert-team/observer.ts'

/**
 * 团队回合观察器(设计 §12.1 / §12.4.2 / §16.10)。
 *
 * 上游 `agent-loop` 在消费收件箱时**先**发 `turn/start`、**再**发
 * `agent/inbox/claimed { agent, message, turn }`;观察器必须从 claim 载荷直接绑定
 * `activeTurn`,不能等 claim 之后的下一条 `turn/start`。以下工厂显式携带
 * `turn`/`step = 1` 与最小合法 data,不调用 `snapshotEvents()`、不触碰观察器内部状态。
 */

const PARENT = 's1'
const FOLLOWUP = 'm1'

const session = (id: string): { id: string } => ({ id })

function turnStart({ seq, turn }: { seq: number; turn: number }): SessionEvent {
  return { type: 'turn/start', seq: SessionSeq(seq), time: seq, data: { turn } }
}

function turnEnd({ seq, turn, reason }: { seq: number; turn: number; reason: TurnEndReason }): SessionEvent {
  return { type: 'turn/end', seq: SessionSeq(seq), time: seq, data: { turn, reason } }
}

function assistantMessage({
  seq,
  turn,
  text,
  blocks,
}: {
  seq: number
  turn: number
  text?: string
  blocks?: readonly ContentBlock[]
}): SessionEvent {
  return {
    type: 'assistant/message',
    seq: SessionSeq(seq),
    time: seq,
    surfaceOp: 'append',
    data: {
      turn,
      step: 1,
      message: {
        id: MessageId(`assistant-${seq}`),
        role: 'assistant',
        content: blocks ?? [{ type: 'text', text: text ?? '' }],
        source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
      },
      stream: [],
    },
  }
}

function toolResult({ seq, turn }: { seq: number; turn: number }): SessionEvent {
  const callId = ToolCallId(`call-${seq}`)
  return {
    type: 'tool/result',
    seq: SessionSeq(seq),
    time: seq,
    surfaceOp: 'append',
    data: {
      turn,
      step: 1,
      message: {
        id: MessageId(`tool-${seq}`),
        role: 'tool',
        content: [{ type: 'text', text: `result-${seq}` }],
        source: { kind: 'tool', callId },
        toolCallId: callId,
      },
    },
  }
}

/** 按真实上游顺序激活:先 `turn/start`,再 `claim({ message: { id: 'm1' }, turn })`。 */
function activeObserver({ turn }: { turn: number }) {
  const onTurnEnd = vi.fn()
  const onAbort = vi.fn()
  const observer = createExpertTeamTurnObserver({
    parentSessionId: PARENT,
    followupId: FOLLOWUP,
    onTurnEnd,
    onAbort,
  })
  observer.event(session(PARENT), turnStart({ seq: 1, turn }))
  observer.claim({ message: { id: FOLLOWUP }, turn })
  return Object.assign(observer, { onTurnEnd, onAbort })
}

function listenerContext() {
  const listeners: Record<string, ((...args: never[]) => unknown)[]> = {}
  const optionsSeen: Record<string, (boolean | { global?: boolean } | undefined)[]> = {}
  const ctx = {
    on(
      name: string,
      listener: (...args: never[]) => unknown,
      options?: boolean | { global?: boolean },
    ): () => void {
      ;(listeners[name] ??= []).push(listener)
      ;(optionsSeen[name] ??= []).push(options)
      return () => {
        const list = listeners[name]
        if (list === undefined) return
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
      }
    },
  }
  const dispatch = (name: string, ...args: unknown[]): void => {
    const listenersForName = listeners[name] ?? []
    for (const listener of [...listenersForName]) {
      ;(listener as (...callArgs: unknown[]) => unknown)(...args)
    }
  }
  return { ctx, listeners, optionsSeen, dispatch }
}

describe('expert team turn observer', () => {
  it('binds to payload.turn when claimed after turn/start and ignores earlier turns and reasoning', () => {
    const observer = createExpertTeamTurnObserver({ parentSessionId: PARENT, followupId: FOLLOWUP, onTurnEnd: vi.fn() })
    // 上一普通回合：turn/start 先于 claimed，不匹配 followupId
    observer.event(session(PARENT), turnStart({ seq: 1, turn: 1 }))
    observer.claim({ message: { id: 'other' }, turn: 1 })
    observer.event(session(PARENT), assistantMessage({ seq: 2, turn: 1, text: '旧回合文本' }))
    observer.event(session(PARENT), turnEnd({ seq: 3, turn: 1, reason: { kind: 'completed' } }))

    // 目标团队回合：上游先发 turn/start(turn=2)，随后发 agent/inbox/claimed({ message: { id: 'm1' }, turn: 2 })
    observer.event(session(PARENT), turnStart({ seq: 4, turn: 2 }))
    observer.claim({ message: { id: FOLLOWUP }, turn: 2 })
    observer.event(session(PARENT), assistantMessage({ seq: 5, turn: 2, text: '先安排成员' }))
    observer.event(session(PARENT), toolResult({ seq: 6, turn: 2 }))
    observer.event(session(PARENT), assistantMessage({ seq: 7, turn: 2, blocks: [{ type: 'reasoning', text: '思考' }] }))
    expect(observer.finalSummaryPresent()).toBe(false)
    observer.event(session(PARENT), assistantMessage({ seq: 8, turn: 2, text: '最终汇总第一段' }))
    observer.event(session(PARENT), assistantMessage({ seq: 9, turn: 2, text: '最终汇总第二段' }))
    expect(observer.finalSummaryPresent()).toBe(true)
  })

  it('uses the last tool result boundary across multiple assistant messages and fails closed on non-monotonic seq', () => {
    const observer = activeObserver({ turn: 2 })
    observer.event(session(PARENT), assistantMessage({ seq: 10, turn: 2, text: '过渡语' }))
    observer.event(session(PARENT), toolResult({ seq: 11, turn: 2 }))
    observer.event(session(PARENT), assistantMessage({ seq: 12, turn: 2, text: '第一段' }))
    observer.event(session(PARENT), toolResult({ seq: 13, turn: 2 }))
    observer.event(session(PARENT), assistantMessage({ seq: 14, turn: 2, text: '第二段' }))
    observer.event(session(PARENT), assistantMessage({ seq: 15, turn: 2, text: '第三段' }))
    expect(observer.finalSummaryPresent()).toBe(true)
    observer.event(session(PARENT), turnEnd({ seq: 16, turn: 2, reason: { kind: 'completed' } }))
    expect(observer.turnEndFacts()).toMatchObject({ turn: 2, finalSummaryPresent: true, eventMissing: false })

    const corrupt = activeObserver({ turn: 3 })
    corrupt.event(session(PARENT), toolResult({ seq: 20, turn: 3 }))
    corrupt.event(session(PARENT), assistantMessage({ seq: 19, turn: 3, text: '乱序/回退 seq 必须 fail-closed' }))
    expect(corrupt.finalSummaryPresent()).toBe(false)
  })

  it('locks turn/end facts once, calls onAbort for an aborted turn, and ignores later goal turns', () => {
    const observer = activeObserver({ turn: 2 })
    observer.event(session(PARENT), toolResult({ seq: 2, turn: 2 }))
    observer.event(session(PARENT), assistantMessage({ seq: 3, turn: 2, text: '汇总' }))
    const aborted: TurnEndReason = { kind: 'aborted', reason: { kind: 'user' } }
    observer.event(session(PARENT), turnEnd({ seq: 4, turn: 2, reason: aborted }))

    expect(observer.onTurnEnd).toHaveBeenCalledTimes(1)
    expect(observer.onTurnEnd).toHaveBeenCalledWith({ turn: 2, finalSummaryPresent: true, eventMissing: false, reason: aborted })
    expect(observer.onAbort).toHaveBeenCalledTimes(1)
    expect(observer.onAbort.mock.calls[0]?.[0]).toMatchObject({ turn: 2, reason: { kind: 'aborted' } })

    // 目标续拍 / 迟到事件:同一目标回合只结算一次,后续 turn 不覆盖已锁定事实。
    observer.event(session(PARENT), turnStart({ seq: 5, turn: 3 }))
    observer.event(session(PARENT), toolResult({ seq: 6, turn: 3 }))
    observer.event(session(PARENT), assistantMessage({ seq: 7, turn: 3, text: '续拍输出' }))
    observer.event(session(PARENT), turnEnd({ seq: 8, turn: 3, reason: { kind: 'completed' } }))
    observer.afterIdle()
    expect(observer.onTurnEnd).toHaveBeenCalledTimes(1)
    expect(observer.onAbort).toHaveBeenCalledTimes(1)
    expect(observer.turnEndFacts()).toMatchObject({ turn: 2, finalSummaryPresent: true, eventMissing: false })
  })

  it('reports eventMissing from afterIdle when the active turn never saw turn/end', () => {
    const observer = activeObserver({ turn: 2 })
    observer.event(session(PARENT), toolResult({ seq: 2, turn: 2 }))
    observer.event(session(PARENT), assistantMessage({ seq: 3, turn: 2, text: '未结算汇总' }))
    observer.afterIdle()

    expect(observer.onTurnEnd).toHaveBeenCalledTimes(1)
    expect(observer.onTurnEnd).toHaveBeenCalledWith({ turn: 2, finalSummaryPresent: true, eventMissing: true })
    expect(observer.onAbort).not.toHaveBeenCalled()
    expect(observer.turnEndFacts()).toEqual({ turn: 2, finalSummaryPresent: true, eventMissing: true })

    // 第二次 afterIdle 与迟到的 turn/end 都不得再回调。
    observer.afterIdle()
    observer.event(session(PARENT), turnEnd({ seq: 4, turn: 2, reason: { kind: 'completed' } }))
    expect(observer.onTurnEnd).toHaveBeenCalledTimes(1)
    expect(observer.turnEndFacts()).toMatchObject({ eventMissing: true })
  })

  it('ignores other sessions, unmatched claims, and afterIdle before any claim', () => {
    const observer = activeObserver({ turn: 2 })
    // 兄弟子会话的事件不是本团队回合的事实:既不计边界,也不参与 seq 校验。
    observer.event(session('child-session'), toolResult({ seq: 99, turn: 2 }))
    observer.event(session('child-session'), assistantMessage({ seq: 100, turn: 2, text: '子会话文本' }))
    expect(observer.finalSummaryPresent()).toBe(false)
    observer.event(session(PARENT), toolResult({ seq: 2, turn: 2 }))
    observer.event(session(PARENT), assistantMessage({ seq: 3, turn: 2, text: '父会话最终汇总' }))
    expect(observer.finalSummaryPresent()).toBe(true)

    const idleObserver = createExpertTeamTurnObserver({ parentSessionId: PARENT, followupId: FOLLOWUP, onTurnEnd: vi.fn() })
    idleObserver.event(session(PARENT), turnStart({ seq: 1, turn: 2 }))
    idleObserver.afterIdle()
    idleObserver.claim({ message: { id: FOLLOWUP }, turn: 2 })
    idleObserver.event(session(PARENT), turnEnd({ seq: 2, turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }))
    // 未 claim 前 afterIdle 不结算;claim 之后仍按自己的回合正常锁定。
    expect(idleObserver.turnEndFacts()).toMatchObject({ turn: 2, eventMissing: false })
  })
})

describe('expert team observer binding', () => {
  it('subscribes claimed and session/event globally and unregisters both through one disposer', () => {
    const { ctx, listeners, optionsSeen, dispatch } = listenerContext()
    const observer = createExpertTeamTurnObserver({ parentSessionId: PARENT, followupId: FOLLOWUP, onTurnEnd: vi.fn() })
    const dispose = bindExpertTeamObserver(ctx, observer)

    expect(optionsSeen['agent/inbox/claimed']).toEqual([{ global: true }])
    expect(optionsSeen['session/event']).toEqual([{ global: true }])
    expect(listeners['agent/inbox/claimed']).toHaveLength(1)
    expect(listeners['session/event']).toHaveLength(1)

    // 其它父会话的 claim 不触发绑定;本会话匹配 followupId 的 claim 直接绑定载荷 turn。
    dispatch('agent/inbox/claimed', {
      agent: { session: { id: 'other-session' } },
      message: { id: FOLLOWUP },
      turn: 2,
    })
    dispatch('agent/inbox/claimed', {
      agent: { session: { id: PARENT } },
      message: { id: FOLLOWUP },
      turn: 2,
    })
    dispatch('session/event', session('child-session'), toolResult({ seq: 1, turn: 2 }))
    dispatch('session/event', session(PARENT), toolResult({ seq: 2, turn: 2 }))
    dispatch('session/event', session(PARENT), assistantMessage({ seq: 3, turn: 2, text: '最终汇总' }))
    expect(observer.finalSummaryPresent()).toBe(true)

    dispose()
    expect(listeners['agent/inbox/claimed']).toEqual([])
    expect(listeners['session/event']).toEqual([])
    // 卸载后事件与 claim 均不再生效。
    dispatch('session/event', session(PARENT), turnEnd({ seq: 4, turn: 2, reason: { kind: 'completed' } }))
    expect(observer.turnEndFacts()).toBeUndefined()
  })

  it('disposes every in-flight observer of a parent session exactly once', () => {
    const { ctx, listeners } = listenerContext()
    const first = createExpertTeamTurnObserver({ parentSessionId: PARENT, followupId: 'm1', onTurnEnd: vi.fn() })
    const second = createExpertTeamTurnObserver({ parentSessionId: PARENT, followupId: 'm2', onTurnEnd: vi.fn() })
    bindExpertTeamObserver(ctx, first)
    bindExpertTeamObserver(ctx, second)
    expect(listeners['agent/inbox/claimed']).toHaveLength(2)

    disposeExpertTeamObservers(PARENT)
    expect(listeners['agent/inbox/claimed']).toEqual([])
    expect(listeners['session/event']).toEqual([])
    // 已释放后再调用绑定 disposer 是幂等的。
    disposeExpertTeamObservers(PARENT)
    expect(first.turnEndFacts()).toBeUndefined()
    expect(second.turnEndFacts()).toBeUndefined()
  })
})
