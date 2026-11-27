import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

import {
  drainUserQueue,
  sessionSend,
  setReevaluateDueAutomations,
  setReevaluateKbOrganize,
  type SessionRuntimeContext,
} from '../../src/huaanwork-host/sessions.ts'
import type { RouteContext } from '../../src/huaanwork-host/routes.ts'
import { writeHuaanworkSettings } from '../../src/huaanwork-host/settings.ts'
import { createTurnScheduler, type TurnScheduler } from '../../src/huaanwork-host/turn-scheduler.ts'
import type { ListedAgent } from '../../src/huaanwork-host/sessions.ts'
import type { RpcEvent } from '../../src/client-huaanwork/rpc-types.ts'

function scheduler(max = 3): TurnScheduler {
  let clock = 0
  let nextId = 0
  return createTurnScheduler({
    maxConcurrentTurns: () => max,
    modelExists: (id) => id === 'm1' || id === 'm2',
    now: () => {
      clock += 1
      return clock
    },
    createId: () => `q${++nextId}`,
  })
}

test('a cap-full user preempts the kb-organize writer and the organizer release is an idempotent no-op', () => {
  const turns = scheduler(1)
  const onPreempt = vi.fn()
  expect(turns.admitKbOrganize({
    kbId: 'kb1',
    sessionId: 'huaanwork-kb-org-kb1',
    root: '/wiki',
    onPreempt,
  })).toEqual({ kind: 'start', root: resolve('/wiki') })
  expect(turns.activeTurnCount()).toBe(1)

  const user = turns.admitUserTurn({ sessionId: 'u1', tabId: 't1', text: 'run', modelId: 'm1', root: '/proj' })
  expect(user).toEqual({ kind: 'start', root: resolve('/proj') })
  expect(onPreempt).toHaveBeenCalledTimes(1)
  expect(turns.activeTurnCount()).toBe(1)
  expect(turns.soleCapWriterSessionId()).toBe('u1')

  // 整理槽的 finally 晚到:写者已被移出 rootWriters,绝不能再扣一次名额。
  turns.release('huaanwork-kb-org-kb1')
  expect(turns.activeTurnCount()).toBe(1)
  expect(turns.soleCapWriterSessionId()).toBe('u1')
  turns.release('u1')
  expect(turns.activeTurnCount()).toBe(0)
})

test('a same-root busy user queues without preempting the organizer', () => {
  const turns = scheduler(2)
  const onPreempt = vi.fn()
  expect(turns.admitUserTurn({ sessionId: 'a', tabId: 'ta', text: 'run', modelId: 'm1', root: '/proj-r' }).kind)
    .toBe('start')
  expect(turns.admitKbOrganize({
    kbId: 'kb1',
    sessionId: 'huaanwork-kb-org-kb1',
    root: '/wiki',
    onPreempt,
  }).kind).toBe('start')
  expect(turns.activeTurnCount()).toBe(2)

  const queued = turns.admitUserTurn({ sessionId: 'b', tabId: 'tb', text: 'same root', modelId: 'm1', root: '/proj-r' })
  expect(queued).toEqual({ kind: 'queued', root: resolve('/proj-r'), queueItemId: 'q1' })
  expect(queued).not.toHaveProperty('drain')
  expect(onPreempt).not.toHaveBeenCalled()
  expect(turns.activeTurnCount()).toBe(2)
})

test('only one kb-organize writer exists globally and its root is exclusive', () => {
  const turns = scheduler(3)
  expect(turns.admitKbOrganize({
    kbId: 'kb1',
    sessionId: 'huaanwork-kb-org-kb1',
    root: '/wiki-1',
    onPreempt: () => undefined,
  }).kind).toBe('start')
  expect(turns.admitKbOrganize({
    kbId: 'kb2',
    sessionId: 'huaanwork-kb-org-kb2',
    root: '/wiki-2',
    onPreempt: () => undefined,
  })).toEqual({ kind: 'skip', reason: 'kb-busy' })
  expect(turns.activeTurnCount()).toBe(1)

  const rootBusy = scheduler(3)
  expect(rootBusy.admitKbOrganize({
    kbId: 'kb1',
    sessionId: 'huaanwork-kb-org-kb1',
    root: '/wiki',
    onPreempt: () => undefined,
  }).kind).toBe('start')
  expect(rootBusy.admitKbOrganize({
    kbId: 'kb1',
    sessionId: 'huaanwork-kb-org-kb1-retry',
    root: '/wiki',
    onPreempt: () => undefined,
  })).toEqual({ kind: 'skip', reason: 'root-busy' })
})

test('a non-empty user queue blocks organizer admission', () => {
  const turns = scheduler(3)
  expect(turns.admitUserTurn({ sessionId: 'holder', tabId: 't1', text: 'run', modelId: 'm1', root: '/busy' }).kind)
    .toBe('start')
  expect(turns.admitUserTurn({ sessionId: 'waiter', tabId: 't2', text: 'wait', modelId: 'm1', root: '/busy' }).kind)
    .toBe('queued')

  expect(turns.admitKbOrganize({
    kbId: 'kb1',
    sessionId: 'huaanwork-kb-org-kb1',
    root: '/wiki',
    onPreempt: () => undefined,
  })).toEqual({ kind: 'skip', reason: 'queue-non-empty' })
  expect(turns.activeTurnCount()).toBe(1)
})

test('soleCapWriterSessionId ignores a sole kb-organize writer', () => {
  const turns = scheduler(3)
  expect(turns.admitKbOrganize({
    kbId: 'kb1',
    sessionId: 'huaanwork-kb-org-kb1',
    root: '/wiki',
    onPreempt: () => undefined,
  }).kind).toBe('start')
  expect(turns.activeTurnCount()).toBe(1)
  expect(turns.soleCapWriterSessionId()).toBeUndefined()
})

test('soleCapWriterSessionId still names the user when a kb-organize writer shares the cap', () => {
  const turns = scheduler(3)
  expect(turns.admitUserTurn({ sessionId: 'u1', tabId: 't1', text: 'run', modelId: 'm1', root: '/proj' }).kind)
    .toBe('start')
  expect(turns.admitKbOrganize({
    kbId: 'kb1',
    sessionId: 'huaanwork-kb-org-kb1',
    root: '/wiki',
    onPreempt: () => undefined,
  }).kind).toBe('start')
  expect(turns.soleCapWriterSessionId()).toBe('u1')
})

let tmpRoot: string | undefined

function freshTmp(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'huaanwork-kb-organize-spec-'))
  return tmpRoot
}

function makeRouteCtx(root: string): RouteContext {
  return {
    dshHome: join(root, 'dsh'),
    profileDir: root,
    workspaceRoot: { current: join(root, 'workspace') },
    emit: () => undefined,
    logger: () => undefined,
    requestRestart: async () => true,
  }
}

afterEach(() => {
  setReevaluateDueAutomations(undefined)
  setReevaluateKbOrganize(undefined)
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true })
    tmpRoot = undefined
  }
})

test('drainUserQueue runs drainQueue, due-automation evaluation, then kb-organize re-evaluation', () => {
  const root = freshTmp()
  const queuedRoot = join(root, 'queued-root')
  mkdirSync(queuedRoot, { recursive: true })
  const calls: string[] = []
  const base = scheduler(1)
  expect(base.admitUserTurn({ sessionId: 'active', tabId: 't1', text: 'run', modelId: 'm1', root: '/a' }).kind)
    .toBe('start')
  expect(base.admitUserTurn({
    sessionId: 'queued',
    tabId: 't2',
    text: 'wait',
    modelId: 'm1',
    root: queuedRoot,
  })).toMatchObject({ kind: 'queued', queueItemId: 'q1' })
  base.release('active')
  const wrapped: TurnScheduler = {
    ...base,
    drainQueue: () => {
      calls.push('drain')
      return base.drainQueue()
    },
  }
  const ctx: SessionRuntimeContext = { huaanworkTurnScheduler: wrapped }
  setReevaluateDueAutomations(() => calls.push('automation'))
  setReevaluateKbOrganize(() => calls.push('kb-organize'))

  // startQueuedItem 在第一个 await 前只做同步检查;根存在 ⇒ 后置评估先完成,
  // 排空结果的返回值在异步启动继续之前就能断言。
  const drained = drainUserQueue(ctx, makeRouteCtx(root))
  expect(calls).toEqual(['drain', 'automation', 'kb-organize'])
  expect(drained).toEqual(['q1'])
  expect(base.activeTurnCount()).toBe(1)
})

test('preemption with a non-empty queue enqueues the newcomer and starts the earlier startable user first', () => {
  const turns = scheduler(1)
  const onPreempt = vi.fn()
  expect(turns.admitAutomation({
    automationId: 'script-1',
    sessionId: 'script:1',
    root: '/blocked',
    countsTowardCap: false,
  }).kind).toBe('start')
  expect(turns.admitKbOrganize({
    kbId: 'kb1',
    sessionId: 'huaanwork-kb-org-kb1',
    root: '/wiki',
    onPreempt,
  }).kind).toBe('start')
  expect(turns.admitUserTurn({ sessionId: 'jia', tabId: 't1', text: '甲', modelId: 'm1', root: '/blocked' }))
    .toMatchObject({ kind: 'queued', queueItemId: 'q1' })
  // 释放脚本写者只腾出根,不排空队列:甲已入队且根空闲、整理仍占满名额。
  turns.release('script:1')

  const yi = turns.admitUserTurn({ sessionId: 'yi', tabId: 't2', text: '乙', modelId: 'm1', root: '/free' })
  expect(yi).toEqual({ kind: 'queued', root: resolve('/free'), queueItemId: 'q2', drain: true })
  expect(onPreempt).toHaveBeenCalledTimes(1)

  expect(turns.drainQueue().map((item) => item.sessionId)).toEqual(['jia'])
  expect(turns.activeTurnCount()).toBe(1)
  expect(turns.drainQueue()).toEqual([])

  turns.release('jia')
  expect(turns.drainQueue().map((item) => item.sessionId)).toEqual(['yi'])
})

test('preemption with a still-busy earlier head starts the newcomer in that drain exactly once', () => {
  const turns = scheduler(1)
  const onPreempt = vi.fn()
  expect(turns.admitAutomation({
    automationId: 'script-1',
    sessionId: 'script:1',
    root: '/blocked',
    countsTowardCap: false,
  }).kind).toBe('start')
  expect(turns.admitKbOrganize({
    kbId: 'kb1',
    sessionId: 'huaanwork-kb-org-kb1',
    root: '/wiki',
    onPreempt,
  }).kind).toBe('start')
  expect(turns.admitUserTurn({ sessionId: 'jia', tabId: 't1', text: '甲', modelId: 'm1', root: '/blocked' }))
    .toMatchObject({ kind: 'queued', queueItemId: 'q1' })

  const yi = turns.admitUserTurn({ sessionId: 'yi', tabId: 't2', text: '乙', modelId: 'm1', root: '/free' })
  expect(yi).toEqual({ kind: 'queued', root: resolve('/free'), queueItemId: 'q2', drain: true })
  expect(onPreempt).toHaveBeenCalledTimes(1)

  const started = turns.drainQueue()
  expect(started.map((item) => item.sessionId)).toEqual(['yi'])
  expect(turns.drainQueue()).toEqual([])
  expect(turns.activeTurnCount()).toBe(1)
  expect(turns.soleCapWriterSessionId()).toBe('yi')
})

/** 真实 sessionSend 的最小宿主:登记根 + live agent,不写项目/任务文件。 */
function makeSendHarness() {
  const profile = freshTmp()
  const jiaRoot = join(profile, 'project-jia')
  const yiRoot = join(profile, 'project-yi')
  const wikiRoot = join(profile, 'wiki')
  const workspace = join(profile, 'workspace')
  for (const dir of [jiaRoot, yiRoot, wikiRoot, workspace]) mkdirSync(dir, { recursive: true })
  const events: RpcEvent[] = []
  const routeCtx: RouteContext = {
    dshHome: join(profile, 'dsh'),
    profileDir: profile,
    workspaceRoot: { current: workspace },
    emit: (event) => {
      events.push(event)
    },
    logger: () => undefined,
    requestRestart: async () => true,
  }
  const roots = new Map<string, string>([
    ['jia', jiaRoot],
    ['yi', yiRoot],
  ])
  const models = new Map<string, string>()
  const followups: { sessionId: string; text: string }[] = []
  const live = new Map<string, ListedAgent & { followup: (message: unknown) => void }>()
  const textOf = (message: unknown): string => {
    const content = (message as { content?: { text?: string }[] }).content ?? []
    return content.map((block) => block.text ?? '').join('')
  }
  const addAgent = (sessionId: string, whenIdle: () => Promise<void> = async () => undefined): void => {
    live.set(sessionId, {
      id: sessionId,
      session: { id: sessionId },
      followup: (message) => {
        followups.push({ sessionId, text: textOf(message) })
      },
      whenIdle,
      cancel: () => undefined,
    })
  }
  const scheduler = createTurnScheduler({
    maxConcurrentTurns: () => 1,
    modelExists: () => true,
  })
  const ctx: SessionRuntimeContext = {
    huaanworkTurnScheduler: scheduler,
    huaanworkSessionRoots: roots,
    huaanworkSessionModels: models,
    agents: {
      get: (id) => live.get(id),
      list: () => [...live.values()],
    },
  }
  return { profile, jiaRoot, yiRoot, wikiRoot, routeCtx, ctx, scheduler, events, followups, addAgent }
}

async function writeSendSettings(profile: string): Promise<void> {
  await writeHuaanworkSettings(profile, {
    models: [{ id: 'm1', name: 'M1', base_url: 'http://127.0.0.1:11434/v1', model: 'm1', api_key: '' }],
    active_model_id: 'm1',
  })
}

test('a preempted queued send reports waiting while the earlier user takes the freed slot', async () => {
  const h = makeSendHarness()
  await writeSendSettings(h.profile)
  const idleJia = (() => {
    let resolveIdle: () => void = () => undefined
    const promise = new Promise<void>((done) => {
      resolveIdle = done
    })
    return { promise, resolve: resolveIdle }
  })()
  h.addAgent('jia', () => idleJia.promise)
  h.addAgent('yi')

  expect(h.scheduler.admitAutomation({
    automationId: 'script-1',
    sessionId: 'script:1',
    root: h.jiaRoot,
    countsTowardCap: false,
  }).kind).toBe('start')
  const onPreempt = vi.fn()
  expect(h.scheduler.admitKbOrganize({
    kbId: 'kb1',
    sessionId: 'huaanwork-kb-org-kb1',
    root: h.wikiRoot,
    onPreempt,
  }).kind).toBe('start')

  const jia = (await sessionSend(h.ctx, h.routeCtx, {
    text: '甲',
    sessionId: 'jia',
    tabId: 'tab-jia',
    modelId: 'm1',
  })) as Record<string, unknown>
  expect(jia).toMatchObject({ queued: true, waiting: true, started: false })
  h.scheduler.release('script:1')

  const yi = (await sessionSend(h.ctx, h.routeCtx, {
    text: '乙',
    sessionId: 'yi',
    tabId: 'tab-yi',
    modelId: 'm1',
  })) as Record<string, unknown>
  expect(yi).toMatchObject({ queued: true, waiting: true, started: false, sessionId: 'yi' })
  expect(typeof yi.queueItemId).toBe('string')
  expect(onPreempt).toHaveBeenCalledTimes(1)
  // 抢占腾出的名额被更早入队且根已空闲的甲拿走;乙仍在队列里。
  expect(h.scheduler.activeTurnCount()).toBe(1)
  await vi.waitFor(() => expect(h.followups).toEqual([{ sessionId: 'jia', text: '甲' }]))
  expect(h.events.some((event) => event.event === 'session/queue-start' && 'sessionId' in event && event.sessionId === 'yi'))
    .toBe(false)

  idleJia.resolve()
  await vi.waitFor(() => expect(h.followups).toEqual([
    { sessionId: 'jia', text: '甲' },
    { sessionId: 'yi', text: '乙' },
  ]))
})

test('a preempted send starts through startQueuedItem once and never fakes started before the followup', async () => {
  const h = makeSendHarness()
  await writeSendSettings(h.profile)
  h.addAgent('jia')
  h.addAgent('yi')

  expect(h.scheduler.admitAutomation({
    automationId: 'script-1',
    sessionId: 'script:1',
    root: h.jiaRoot,
    countsTowardCap: false,
  }).kind).toBe('start')
  const onPreempt = vi.fn()
  expect(h.scheduler.admitKbOrganize({
    kbId: 'kb1',
    sessionId: 'huaanwork-kb-org-kb1',
    root: h.wikiRoot,
    onPreempt,
  }).kind).toBe('start')
  expect((await sessionSend(h.ctx, h.routeCtx, {
    text: '甲',
    sessionId: 'jia',
    tabId: 'tab-jia',
    modelId: 'm1',
  }))).toMatchObject({ queued: true, waiting: true, started: false })

  const yi = (await sessionSend(h.ctx, h.routeCtx, {
    text: '乙',
    sessionId: 'yi',
    tabId: 'tab-yi',
    modelId: 'm1',
  })) as Record<string, unknown>
  // 甲的头仍被脚本写者占着根:本轮只启动乙,且启动所有权已交给 startQueuedItem。
  expect(yi).toMatchObject({ queued: true, waiting: false, started: false, sessionId: 'yi' })
  expect(typeof yi.queueItemId).toBe('string')
  expect(onPreempt).toHaveBeenCalledTimes(1)

  await vi.waitFor(() => expect(h.followups).toEqual([{ sessionId: 'yi', text: '乙' }]))
  expect(h.events.filter(
    (event) => event.event === 'session/queue-start' && 'sessionId' in event && event.sessionId === 'yi',
  )).toHaveLength(1)
  expect(h.events.some((event) => event.event === 'session/queue-fail')).toBe(false)
  // 甲仍留在队列:头项根忙被跳过,不会被这一轮顺手放走。
  expect(h.scheduler.activeSessionIds().has('jia')).toBe(true)
})
