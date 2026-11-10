import { resolve } from 'node:path'
import { expect, test } from 'vitest'

import { createTurnScheduler } from '../../src/huaanwork-host/turn-scheduler.ts'

function scheduler(max = 3) {
  return createTurnScheduler({
    maxConcurrentTurns: () => max,
    modelExists: (id) => id === 'm1' || id === 'm2',
    now: () => 1,
    createId: (() => {
      let n = 0
      return () => `q${++n}`
    })(),
  })
}

test('two roots start together and the same root queues', () => {
  const turns = scheduler()
  expect(turns.admitUserTurn({ sessionId: 'a1', tabId: 't1', text: 'one', modelId: 'm1', root: '/proj-a' }).kind).toBe('start')
  expect(turns.admitUserTurn({ sessionId: 'b1', tabId: 't2', text: 'two', modelId: 'm2', root: '/proj-b' }).kind).toBe('start')
  const third = turns.admitUserTurn({ sessionId: 'a2', tabId: 't3', text: 'three', modelId: 'm1', root: '/proj-a' })
  expect(third).toMatchObject({ kind: 'queued', root: resolve('/proj-a'), queueItemId: 'q1' })
  expect(turns.activeTurnCount()).toBe(2)
})

test('a second turn on the same root queues even though the cap has room', () => {
  const turns = scheduler(3)
  expect(turns.admitUserTurn({ sessionId: 'a1', tabId: 't1', text: 'run', modelId: 'm1', root: '/proj-a' }).kind).toBe('start')
  const second = turns.admitUserTurn({ sessionId: 'a2', tabId: 't2', text: 'same root', modelId: 'm1', root: '/proj-a' })
  expect(second).toMatchObject({ kind: 'queued', root: resolve('/proj-a') })
  expect(turns.activeTurnCount()).toBe(1)
})

test('drain starts a later free root before a busy-root head and does not requeue', () => {
  const turns = scheduler(2)
  turns.admitUserTurn({ sessionId: 'a1', tabId: 't1', text: 'run', modelId: 'm1', root: '/proj-a' })
  turns.admitUserTurn({ sessionId: 'c1', tabId: 't0', text: 'cap', modelId: 'm1', root: '/proj-c' })
  turns.admitUserTurn({ sessionId: 'a2', tabId: 't2', text: 'wait-a', modelId: 'm1', root: '/proj-a' })
  turns.admitUserTurn({ sessionId: 'b1', tabId: 't3', text: 'wait-b', modelId: 'm2', root: '/proj-b' })
  turns.release('c1')
  const started = turns.drainQueue()
  expect(started.map((item) => item.sessionId)).toEqual(['b1'])
  expect(turns.drainQueue()).toEqual([])
  expect(turns.activeTurnCount()).toBe(2)
})

test('drain stops when the cap is full', () => {
  const turns = scheduler(1)
  turns.admitUserTurn({ sessionId: 'a1', tabId: 't1', text: 'run', modelId: 'm1', root: '/proj-a' })
  turns.admitUserTurn({ sessionId: 'b1', tabId: 't2', text: 'wait-b', modelId: 'm1', root: '/proj-b' })
  turns.admitUserTurn({ sessionId: 'c1', tabId: 't3', text: 'wait-c', modelId: 'm2', root: '/proj-c' })
  turns.release('a1')
  expect(turns.drainQueue().map((item) => item.sessionId)).toEqual(['b1'])
  expect(turns.activeTurnCount()).toBe(1)
  expect(turns.admitUserTurn({ sessionId: 'd', tabId: 't4', text: 'no', modelId: 'missing', root: '/proj-d' })).toMatchObject({
    kind: 'error',
    reason: '模型不存在',
  })
})

test('cancel removes one queued item and cap drop does not cancel a running turn', () => {
  let max = 2
  const turns = createTurnScheduler({
    maxConcurrentTurns: () => max,
    modelExists: () => true,
    createId: () => 'only',
  })
  turns.admitUserTurn({ sessionId: 'a', tabId: 'ta', text: 'run', modelId: 'm', root: '/same' })
  const queued = turns.admitUserTurn({ sessionId: 'a2', tabId: 'ta2', text: 'wait', modelId: 'm', root: '/same' })
  max = 1
  turns.cancelQueuedItem(queued.kind === 'queued' ? queued.queueItemId : '')
  const capped = turns.admitUserTurn({ sessionId: 'b', tabId: 'tb', text: 'wait for cap', modelId: 'm', root: '/other' })
  expect(capped).toMatchObject({ kind: 'queued' })
  expect(turns.drainQueue()).toEqual([])
  expect(turns.activeTurnCount()).toBe(1)
})

test('admission skip is remembered until release of that automation', () => {
  const turns = scheduler(1)
  turns.admitUserTurn({ sessionId: 'a1', tabId: 't', text: 'run', modelId: 'm1', root: '/proj-a' })
  const skipped = turns.admitAutomation({
    automationId: 'auto-1',
    sessionId: 'auto-session',
    root: '/proj-b',
    countsTowardCap: true,
  })
  expect(skipped).toEqual({ kind: 'skip', reason: 'cap-full' })
  expect(turns.isAdmissionSkipped('auto-1')).toBe(true)
  turns.clearAdmissionSkip('auto-1')
  expect(turns.isAdmissionSkipped('auto-1')).toBe(false)
})

test('a manual admission skip is not remembered for the missed-grace exemption', () => {
  const turns = scheduler(1)
  turns.admitUserTurn({ sessionId: 'a1', tabId: 't', text: 'run', modelId: 'm1', root: '/proj-a' })
  // 同根忙:手动运行跳过,返回 skip 但不登记 admissionSkips。
  expect(turns.admitAutomation({
    automationId: 'manual-1',
    sessionId: 'auto-session',
    root: '/proj-a',
    countsTowardCap: true,
    recordSkip: false,
  })).toEqual({ kind: 'skip', reason: 'root-busy' })
  expect(turns.isAdmissionSkipped('manual-1')).toBe(false)
  // 名额满(目标根空闲)同样不登记。
  expect(turns.admitAutomation({
    automationId: 'manual-2',
    sessionId: 'auto-session-2',
    root: '/proj-b',
    countsTowardCap: true,
    recordSkip: false,
  })).toEqual({ kind: 'skip', reason: 'cap-full' })
  expect(turns.isAdmissionSkipped('manual-2')).toBe(false)
})

test('a scheduled skip is remembered and a later successful admission clears it', () => {
  const turns = scheduler(1)
  turns.admitUserTurn({ sessionId: 'a1', tabId: 't', text: 'run', modelId: 'm1', root: '/proj-a' })
  expect(turns.admitAutomation({
    automationId: 'auto-1',
    sessionId: 'auto-session',
    root: '/proj-b',
    countsTowardCap: true,
  })).toEqual({ kind: 'skip', reason: 'cap-full' })
  expect(turns.isAdmissionSkipped('auto-1')).toBe(true)
  turns.release('a1')
  expect(turns.admitAutomation({
    automationId: 'auto-1',
    sessionId: 'auto-session',
    root: '/proj-b',
    runId: 'r1',
    countsTowardCap: true,
  })).toEqual({ kind: 'start', root: resolve('/proj-b') })
  expect(turns.isAdmissionSkipped('auto-1')).toBe(false)
})

test('automation start occupies the root and release frees it', () => {
  const turns = scheduler(3)
  expect(turns.admitAutomation({
    automationId: 'agent-1',
    sessionId: 'agent-session',
    root: '/proj-a',
    runId: 'r1',
    countsTowardCap: true,
  })).toEqual({ kind: 'start', root: resolve('/proj-a') })
  expect(turns.activeTurnCount()).toBe(1)
  expect(turns.admitUserTurn({ sessionId: 'u', tabId: 't', text: 'x', modelId: 'm1', root: '/proj-a' }).kind).toBe('queued')
  turns.release('agent-session')
  expect(turns.activeTurnCount()).toBe(0)
  const script = turns.admitAutomation({
    automationId: 'script-1',
    sessionId: 'script:r2',
    root: '/proj-a',
    runId: 'r2',
    countsTowardCap: false,
  })
  expect(script.kind).toBe('start')
  expect(turns.activeTurnCount()).toBe(0)
  expect(turns.soleCapWriterSessionId()).toBeUndefined()
  expect(turns.admitAutomation({
    automationId: 'script-2',
    sessionId: 'script:r3',
    root: '/proj-a',
    countsTowardCap: false,
  })).toEqual({ kind: 'skip', reason: 'root-busy' })
  turns.release('script:r2')
  expect(turns.admitUserTurn({ sessionId: 'u2', tabId: 't2', text: 'y', modelId: 'm1', root: '/proj-a' }).kind).toBe('start')
})

test('trailing slash and dotdot share one writer across user and automation', () => {
  const turns = scheduler(3)
  expect(turns.admitUserTurn({ sessionId: 'u', tabId: 't', text: 'run', modelId: 'm1', root: '/tmp/proj/' }).kind).toBe('start')
  expect(turns.admitAutomation({
    automationId: 'auto',
    sessionId: 's',
    root: '/tmp/proj/../proj',
    countsTowardCap: false,
  })).toEqual({ kind: 'skip', reason: 'root-busy' })
})

test('sole cap writer is absent at zero and at two', () => {
  const turns = scheduler(3)
  expect(turns.soleCapWriterSessionId()).toBeUndefined()
  turns.admitUserTurn({ sessionId: 'a', tabId: 'ta', text: 'run', modelId: 'm1', root: '/a' })
  expect(turns.soleCapWriterSessionId()).toBe('a')
  turns.admitAutomation({
    automationId: 'script-only',
    sessionId: 'script:1',
    root: '/scripts',
    countsTowardCap: false,
  })
  expect(turns.soleCapWriterSessionId()).toBe('a')
  turns.admitUserTurn({ sessionId: 'b', tabId: 'tb', text: 'run', modelId: 'm1', root: '/b' })
  expect(turns.soleCapWriterSessionId()).toBeUndefined()
})

test('cancelQueuedItemsForSession removes only that session’s queued items', () => {
  const turns = scheduler(1)
  // 名额 1：a 占坑执行，其余全部排队。
  expect(turns.admitUserTurn({ sessionId: 'a', tabId: 'ta', text: 'run', modelId: 'm1', root: '/proj-a' }).kind).toBe('start')
  const victimFirst = turns.admitUserTurn({ sessionId: 'victim', tabId: 'tv1', text: 'first', modelId: 'm1', root: '/proj-a' })
  const other = turns.admitUserTurn({ sessionId: 'b', tabId: 'tb', text: 'other', modelId: 'm1', root: '/proj-b' })
  const victimSecond = turns.admitUserTurn({ sessionId: 'victim', tabId: 'tv2', text: 'second', modelId: 'm2', root: '/proj-a' })
  expect(victimFirst).toMatchObject({ kind: 'queued', queueItemId: 'q1' })
  expect(other).toMatchObject({ kind: 'queued', queueItemId: 'q2' })
  expect(victimSecond).toMatchObject({ kind: 'queued', queueItemId: 'q3' })

  // 删除会话只收它自己的等待项;活动写者与其他会话的等待项原样保留。
  expect(turns.cancelQueuedItemsForSession('victim')).toBe(2)
  expect(turns.activeTurnCount()).toBe(1)
  expect(turns.cancelQueuedItemsForSession('never-enqueued')).toBe(0)

  turns.release('a')
  // 出队只剩 b:victim 的两条绝不能被 drain 复活。
  expect(turns.drainQueue().map((item) => item.sessionId)).toEqual(['b'])
  expect(turns.activeTurnCount()).toBe(1)
})

test('a drained item is not cancelled until cancelQueuedItem marks it, and finishStart clears both maps', () => {
  const turns = scheduler(1)
  turns.admitUserTurn({ sessionId: 'a', tabId: 'ta', text: 'run', modelId: 'm1', root: '/proj-a' })
  expect(turns.admitUserTurn({ sessionId: 'b', tabId: 'tb', text: 'wait', modelId: 'm1', root: '/proj-b' })).toMatchObject({
    kind: 'queued',
    queueItemId: 'q1',
  })
  turns.release('a')
  // 出队即登记为 starting:默认未取消,取消后置真。
  expect(turns.drainQueue().map((item) => item.queueItemId)).toEqual(['q1'])
  expect(turns.isStartCancelled('q1')).toBe(false)
  turns.cancelQueuedItem('q1')
  expect(turns.isStartCancelled('q1')).toBe(true)

  // finishStart 清掉 starting 与取消标记:此后再取消同一 id 是 no-op。
  turns.finishStart('q1')
  expect(turns.isStartCancelled('q1')).toBe(false)
  turns.cancelQueuedItem('q1')
  expect(turns.isStartCancelled('q1')).toBe(false)
})

test('cancelling a still-queued item removes it without marking a start', () => {
  const turns = scheduler(1)
  turns.admitUserTurn({ sessionId: 'a', tabId: 'ta', text: 'run', modelId: 'm1', root: '/proj-a' })
  expect(turns.admitUserTurn({ sessionId: 'b', tabId: 'tb', text: 'wait', modelId: 'm1', root: '/proj-b' })).toMatchObject({
    kind: 'queued',
    queueItemId: 'q1',
  })
  turns.cancelQueuedItem('q1')
  // 从未启动过:移除等待项不等于取消一次在途启动。
  expect(turns.isStartCancelled('q1')).toBe(false)
  turns.release('a')
  expect(turns.drainQueue()).toEqual([])
})

test('cancelQueuedItemsForSession marks a starting item and still returns the queued count', () => {
  const turns = scheduler(2)
  turns.admitUserTurn({ sessionId: 'a', tabId: 'ta', text: 'run', modelId: 'm1', root: '/proj-a' })
  turns.admitUserTurn({ sessionId: 'b', tabId: 'tb', text: 'run', modelId: 'm1', root: '/proj-b' })
  expect(turns.admitUserTurn({ sessionId: 'victim', tabId: 'tv1', text: 'start', modelId: 'm1', root: '/proj-a' })).toMatchObject({
    kind: 'queued',
    queueItemId: 'q1',
  })
  expect(turns.admitUserTurn({ sessionId: 'other', tabId: 'to', text: 'other', modelId: 'm1', root: '/proj-c' })).toMatchObject({
    kind: 'queued',
    queueItemId: 'q2',
  })
  expect(turns.admitUserTurn({ sessionId: 'victim', tabId: 'tv2', text: 'wait', modelId: 'm1', root: '/proj-d' })).toMatchObject({
    kind: 'queued',
    queueItemId: 'q3',
  })

  // 让 victim 的第一条出队(进入 starting),另一条仍在队列。
  turns.release('a')
  expect(turns.drainQueue().map((item) => item.queueItemId)).toEqual(['q1'])
  expect(turns.isStartCancelled('q1')).toBe(false)

  // 删除会话:starting 项被标记取消,返回值仍是移除的等待项条数。
  expect(turns.cancelQueuedItemsForSession('victim')).toBe(1)
  expect(turns.isStartCancelled('q1')).toBe(true)
  // q3 从未启动过,不进 cancelledStarts。
  expect(turns.isStartCancelled('q3')).toBe(false)

  turns.finishStart('q1')
  expect(turns.isStartCancelled('q1')).toBe(false)
})

test('cancelQueuedItemsForSession does not release an active writer of that session', () => {
  const turns = scheduler(3)
  // 同一会话在同根上一条执行、一条排队;删除会话只应收掉等待项。
  expect(turns.admitUserTurn({ sessionId: 's', tabId: 't1', text: 'run', modelId: 'm1', root: '/proj-a' }).kind).toBe('start')
  expect(turns.admitUserTurn({ sessionId: 's', tabId: 't2', text: 'wait', modelId: 'm1', root: '/proj-a' })).toMatchObject({ kind: 'queued' })

  // 批量取消只动等待项:活动写者不释放、名额不提前让出(删除会话≠提前 release 活动回合)。
  expect(turns.cancelQueuedItemsForSession('s')).toBe(1)
  expect(turns.activeTurnCount()).toBe(1)
  expect(turns.soleCapWriterSessionId()).toBe('s')
  expect(turns.drainQueue()).toEqual([])
})

test('activeSessionIds covers writers, queued sessions, and starting sessions', () => {
  const turns = createTurnScheduler({ maxConcurrentTurns: () => 1, modelExists: () => true })
  turns.admitUserTurn({ sessionId: 's1', tabId: 't1', text: '一', modelId: 'm', root: '/a' })
  const queued = turns.admitUserTurn({ sessionId: 's2', tabId: 't2', text: '二', modelId: 'm', root: '/b' })
  if (queued.kind !== 'queued') throw new Error('expected queued admission')
  expect(turns.activeSessionIds()).toEqual(new Set(['s1', 's2']))
  turns.release('s1')
  turns.drainQueue()
  expect(turns.activeSessionIds()).toEqual(new Set(['s2']))
  turns.finishStart(queued.queueItemId)
})

test('activeAutomationIds covers admit-to-enqueue before an in-flight entry exists', () => {
  const turns = createTurnScheduler({ maxConcurrentTurns: () => 3, modelExists: () => true })
  turns.admitAutomation({
    automationId: 'auto-catchup', sessionId: 'huaanwork-auto-auto-catchup-r1',
    root: '/project', runId: 'r1', countsTowardCap: true,
  })
  expect(turns.activeAutomationIds()).toEqual(new Set(['auto-catchup']))
})
