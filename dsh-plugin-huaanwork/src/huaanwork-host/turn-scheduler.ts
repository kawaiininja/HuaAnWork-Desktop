import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'

/**
 * 回合调度器(规格 §5.5)。纯内存:不读项目文件、不读会话日志、不 stat。
 *
 * 调用方传入已经算好的可写根,调度器只负责按根保证单写者、按上限占用名额、
 * 保存用户消息队列并支持自动化准入。启动 agent、重新推导根、失败回滚都属于调用方。
 */
export type QueueItem = {
  queueItemId: string
  sessionId: string
  tabId: string
  text: string
  root: string
  modelId: string
  enqueuedAt: number
  skill?: string
  at?: { name: string; clientMessageId?: string }
}

export type AdmitUserResult =
  | { kind: 'start'; root: string }
  | { kind: 'queued'; root: string; queueItemId: string }
  | { kind: 'error'; reason: string }

export type AdmitAutomationResult = { kind: 'start'; root: string } | { kind: 'skip'; reason: 'root-busy' | 'cap-full' }

type RootWriter = {
  kind: 'user' | 'agent-automation' | 'script-automation'
  sessionId: string
  runId?: string
}

export type TurnScheduler = {
  admitUserTurn(input: {
    sessionId: string
    tabId: string
    text: string
    modelId: string
    root: string
    skill?: string
    at?: { name: string; clientMessageId?: string }
  }): AdmitUserResult
  admitAutomation(input: {
    automationId: string
    sessionId: string
    root: string
    runId?: string
    countsTowardCap: boolean
  }): AdmitAutomationResult
  release(sessionId: string): void
  cancelQueuedItem(queueItemId: string): void
  /** 删除会话时收掉它的全部等待项,并把该会话在途启动标记为取消;只动队列,不碰任何活动写者。返回取消条数。 */
  cancelQueuedItemsForSession(sessionId: string): number
  /** 出队后、启动完成前(取消标记置真)是否已被取消;供 `sendToAgent` 的准入判据。 */
  isStartCancelled(queueItemId: string): boolean
  /** 一次出队启动结束(成功、失败或取消都算):清掉 starting 与取消标记。 */
  finishStart(queueItemId: string): void
  clearAdmissionSkip(automationId: string): void
  drainQueue(): QueueItem[]
  isAdmissionSkipped(automationId: string): boolean
  activeTurnCount(): number
  soleCapWriterSessionId(): string | undefined
}

const countsTowardCap = (kind: RootWriter['kind']): boolean => kind !== 'script-automation'

export function createTurnScheduler(options: {
  maxConcurrentTurns: () => number
  modelExists: (modelId: string) => boolean
  now?: () => number
  createId?: () => string
}): TurnScheduler {
  const now = options.now ?? (() => Date.now())
  const createId = options.createId ?? (() => randomUUID())
  /** 每个可写根的当前写者;无写者时键不存在。 */
  const rootWriters = new Map<string, RootWriter>()
  /** 用户消息等待队列,按入队时间扫描。 */
  const queue: QueueItem[] = []
  /** 已出队、尚未完成启动的项:取消与删除据此拦住在途启动。 */
  const starting = new Map<string, { sessionId: string }>()
  /** 启动途中被取消的 queueItemId;`finishStart` 统一清除。 */
  const cancelledStarts = new Set<string>()
  /** 最近一次准入被跳过的自动化;成功准入或显式清除时移除。 */
  const admissionSkips = new Set<string>()
  /** 执行中的占名额回合数(用户回合 + 会调用模型的自动化)。 */
  let activeTurns = 0

  return {
    admitUserTurn(input) {
      const root = resolvePath(input.root)
      if (!options.modelExists(input.modelId)) return { kind: 'error', reason: '模型不存在' }
      if (rootWriters.has(root) || activeTurns >= options.maxConcurrentTurns()) {
        const item: QueueItem = {
          queueItemId: createId(),
          sessionId: input.sessionId,
          tabId: input.tabId,
          text: input.text,
          root,
          modelId: input.modelId,
          enqueuedAt: now(),
          ...(input.skill === undefined ? {} : { skill: input.skill }),
          ...(input.at === undefined ? {} : { at: input.at }),
        }
        queue.push(item)
        return { kind: 'queued', root, queueItemId: item.queueItemId }
      }
      rootWriters.set(root, { kind: 'user', sessionId: input.sessionId })
      activeTurns += 1
      return { kind: 'start', root }
    },

    admitAutomation(input) {
      const root = resolvePath(input.root)
      if (rootWriters.has(root)) {
        admissionSkips.add(input.automationId)
        return { kind: 'skip', reason: 'root-busy' }
      }
      if (input.countsTowardCap && activeTurns >= options.maxConcurrentTurns()) {
        admissionSkips.add(input.automationId)
        return { kind: 'skip', reason: 'cap-full' }
      }
      rootWriters.set(root, {
        kind: input.countsTowardCap ? 'agent-automation' : 'script-automation',
        sessionId: input.sessionId,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
      })
      if (input.countsTowardCap) activeTurns += 1
      admissionSkips.delete(input.automationId)
      return { kind: 'start', root }
    },

    release(sessionId) {
      for (const [root, writer] of [...rootWriters]) {
        if (writer.sessionId !== sessionId) continue
        rootWriters.delete(root)
        if (countsTowardCap(writer.kind)) activeTurns -= 1
      }
    },

    cancelQueuedItem(queueItemId) {
      const index = queue.findIndex((item) => item.queueItemId === queueItemId)
      if (index >= 0) {
        // 还在等待队列里:直接移除,从未启动,不产生取消标记。
        queue.splice(index, 1)
        return
      }
      if (starting.has(queueItemId)) cancelledStarts.add(queueItemId)
    },

    cancelQueuedItemsForSession(sessionId) {
      let removed = 0
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const item = queue[index]
        if (item === undefined || item.sessionId !== sessionId) continue
        queue.splice(index, 1)
        removed += 1
      }
      for (const [queueItemId, item] of starting) {
        if (item.sessionId === sessionId) cancelledStarts.add(queueItemId)
      }
      return removed
    },

    isStartCancelled(queueItemId) {
      return cancelledStarts.has(queueItemId)
    },

    finishStart(queueItemId) {
      starting.delete(queueItemId)
      cancelledStarts.delete(queueItemId)
    },

    clearAdmissionSkip(automationId) {
      admissionSkips.delete(automationId)
    },

    drainQueue() {
      const started: QueueItem[] = []
      const pending = [...queue].sort((left, right) => left.enqueuedAt - right.enqueuedAt)
      for (const item of pending) {
        if (activeTurns >= options.maxConcurrentTurns()) break
        if (rootWriters.has(item.root)) continue
        const index = queue.indexOf(item)
        if (index < 0) continue
        queue.splice(index, 1)
        rootWriters.set(item.root, { kind: 'user', sessionId: item.sessionId })
        activeTurns += 1
        starting.set(item.queueItemId, { sessionId: item.sessionId })
        started.push(item)
      }
      return started
    },

    isAdmissionSkipped(automationId) {
      return admissionSkips.has(automationId)
    },

    activeTurnCount() {
      return activeTurns
    },

    soleCapWriterSessionId() {
      const sessionIds = [...rootWriters.values()]
        .filter((writer) => countsTowardCap(writer.kind))
        .map((writer) => writer.sessionId)
      return sessionIds.length === 1 ? sessionIds[0] : undefined
    },
  }
}
