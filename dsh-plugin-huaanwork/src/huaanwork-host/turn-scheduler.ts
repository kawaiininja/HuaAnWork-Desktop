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
  /** 本次发送的持久回合锚(顶层 UUID / 自动化 runId);出队重建发送参数时原样带回。 */
  clientMessageId?: string
  skill?: string
  /**
   * `@` 调用目标。`kind: 'expert-team'` 是 typed 团队 token:排队出队必须原样
   * 保留,绝不回退成普通 `@<slug>` 智能体。
   */
  at?: { name: string; clientMessageId?: string; kind?: 'expert-team' }
}

export type AdmitUserResult =
  | { kind: 'start'; root: string }
  /**
   * `drain` 只在“抢占成功且调用前用户队列非空”的新到项上出现:该用户已入队,
   * `sessions.ts` 须在返回前调一次 `drainUserQueue`,把腾出的名额先给更早的等待者。
   * 普通排队省略它,保持既有应答深相等形状。
   */
  | { kind: 'queued'; root: string; queueItemId: string; drain?: true }
  | { kind: 'error'; reason: string }

export type AdmitAutomationResult = { kind: 'start'; root: string } | { kind: 'skip'; reason: 'root-busy' | 'cap-full' }

/** 整理槽准入:全局最多一个 `kb-organize` 写者,用户队列非空时让位。 */
export type AdmitKbOrganizeResult =
  | { kind: 'start'; root: string }
  | { kind: 'skip'; reason: 'root-busy' | 'cap-full' | 'kb-busy' | 'queue-non-empty' }

type RootWriter = {
  kind: 'user' | 'agent-automation' | 'script-automation' | 'kb-organize'
  sessionId: string
  runId?: string
  /** 自动化写者的来源任务 id;用户写者没有。供删除前的活跃快照覆盖 admit→enqueue 窗口。 */
  automationId?: string
  /** 直接启动的 `at.kind === 'expert-team'` 团队回合;运行创建前由它识别团队意图。 */
  expertTeam?: boolean
  /** 整理写者的知识库 id;全局单槽下只用于标识本次整理。 */
  kbId?: string
  /** 被用户回合抢占时调用:整理侧据此停止正在跑的组织回合。 */
  onPreempt?: () => void
}

export type TurnScheduler = {
  admitUserTurn(input: {
    sessionId: string
    tabId: string
    text: string
    modelId: string
    root: string
    /** 顶层回合锚;排队期间原样保存,出队后由 `startQueuedItem` 重建进发送参数。 */
    clientMessageId?: string
    skill?: string
    /** 见 {@link QueueItem.at};`kind: 'expert-team'` 在排队期间不得丢失。 */
    at?: { name: string; clientMessageId?: string; kind?: 'expert-team' }
  }): AdmitUserResult
  /**
   * 整理回合准入:全局最多一个 `kb-organize` 写者,且它的可写根独占。
   * 用户队列非空时直接让位,不插队;`cap-full` 只在其它条件都满足时报告。
   */
  admitKbOrganize(input: {
    kbId: string
    sessionId: string
    root: string
    /** 用户回合因全局名额满而抢占时调用,整理侧据此停止当前组织回合。 */
    onPreempt: () => void
  }): AdmitKbOrganizeResult
  admitAutomation(input: {
    automationId: string
    sessionId: string
    root: string
    runId?: string
    countsTowardCap: boolean
    /**
     * 跳过时是否登记 `admissionSkips`(默认 true)。定时调度靠它把跳过项留在待准入列表、
     * 不落 missed;手动运行没有重评估队列,须传 false 以免污染定时触发的豁免。
     */
    recordSkip?: boolean
  }): AdmitAutomationResult
  release(sessionId: string): void
  cancelQueuedItem(queueItemId: string): void
  /** 删除会话时收掉它的全部等待项,并把该会话在途启动标记为取消;只动队列,不碰任何活动写者。返回移除的等待项条数,在途启动只标记、不计入。 */
  cancelQueuedItemsForSession(sessionId: string): number
  /** 出队后、启动完成前(取消标记置真)是否已被取消;供 `sendToAgent` 的准入判据。 */
  isStartCancelled(queueItemId: string): boolean
  /** 一次出队启动结束(成功、失败或取消都算):清掉 starting 与取消标记。 */
  finishStart(queueItemId: string): void
  clearAdmissionSkip(automationId: string): void
  drainQueue(): QueueItem[]
  /**
   * 该会话是否已有团队回合占用等待队列、正在出队启动,或持有根写者。
   *
   * 调用方在 `admitUserTurn` 前的同步点据此拒绝第二次团队调用(设计 §11.2 / §17):
   * 运行创建跨越多个 await,单看运行注册表会漏掉「仅排队/正在启动」的团队回合。
   * 普通回合排队不受影响,单个团队项排在普通回合之后仍允许。
   */
  hasPendingTeamTurn(sessionId: string): boolean
  isAdmissionSkipped(automationId: string): boolean
  activeTurnCount(): number
  soleCapWriterSessionId(): string | undefined
  /** 只读活跃快照:写者、已出队启动中、等待队列里的全部 sessionId(规格 §9.1)。 */
  activeSessionIds(): ReadonlySet<string>
  /** 只读活跃快照:自动化写者登记的 automationId,覆盖 admit→enqueue 尚未入 inFlight 的窗口。 */
  activeAutomationIds(): ReadonlySet<string>
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
  /** 已出队、尚未完成启动的项:取消与删除据此拦住在途启动;`expertTeam` 保留团队意图。 */
  const starting = new Map<string, { sessionId: string; expertTeam?: boolean }>()
  /** 启动途中被取消的 queueItemId;`finishStart` 统一清除。 */
  const cancelledStarts = new Set<string>()
  /** 定时调度最近一次准入被跳过的自动化;成功准入或显式清除时移除。手动运行不写这里。 */
  const admissionSkips = new Set<string>()
  /** 执行中的占名额回合数(用户回合 + 会调用模型的自动化 + 整理回合)。 */
  let activeTurns = 0

  /** 当前活跃的整理写者;全局单槽,不存在时返回 undefined。 */
  function activeKbOrganize(): { root: string; writer: RootWriter } | undefined {
    for (const [root, writer] of rootWriters) {
      if (writer.kind === 'kb-organize') return { root, writer }
    }
    return undefined
  }

  /** 入队一条用户消息;`enqueuedAt` 取当前时刻,出队按它排先后。 */
  function enqueueUser(input: {
    sessionId: string
    tabId: string
    text: string
    modelId: string
    clientMessageId?: string
    skill?: string
    at?: { name: string; clientMessageId?: string; kind?: 'expert-team' }
  }, root: string): QueueItem {
    const item: QueueItem = {
      queueItemId: createId(),
      sessionId: input.sessionId,
      tabId: input.tabId,
      text: input.text,
      root,
      modelId: input.modelId,
      enqueuedAt: now(),
      ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
      ...(input.skill === undefined ? {} : { skill: input.skill }),
      ...(input.at === undefined ? {} : { at: input.at }),
    }
    queue.push(item)
    return item
  }

  return {
    admitUserTurn(input) {
      const root = resolvePath(input.root)
      if (!options.modelExists(input.modelId)) return { kind: 'error', reason: '模型不存在' }
      const hadQueuedItems = queue.length > 0
      let preempted = false
      // 只有“用户自己的根空闲、但全局名额满”才是被整理写者挡住的理由;同根忙碌只排队,
      // 不无谓取消整理(规格 §8.2(3))。
      if (!rootWriters.has(root) && activeTurns >= options.maxConcurrentTurns()) {
        const organizer = activeKbOrganize()
        if (organizer !== undefined) {
          // 已接受的窗口:整理写者在这里移出 rootWriters,但旧 agent 的 dispose 还没完成;
          // 随后 drainQueue 可以把与它同根的用户回合准入,不另加根锁(inFlightOrganizeByKb
          // 只串行整理槽的 create/delete,不挡用户回合)。
          organizer.writer.onPreempt?.()
          rootWriters.delete(organizer.root)
          activeTurns -= 1
          preempted = true
        }
      }
      // FIFO(2026-11-26):抢占腾出的名额先给更早入队的用户;只有调用前队列为空时,
      // 新用户才在本调用内直接开始。已出队项的启动与本次入队项的归属由 sessions.ts
      // 调一次 drainUserQueue 决定。
      if (preempted && hadQueuedItems) {
        const item = enqueueUser(input, root)
        return { kind: 'queued', root, queueItemId: item.queueItemId, drain: true }
      }
      if (rootWriters.has(root) || activeTurns >= options.maxConcurrentTurns()) {
        const item = enqueueUser(input, root)
        return { kind: 'queued', root, queueItemId: item.queueItemId }
      }
      rootWriters.set(root, {
        kind: 'user',
        sessionId: input.sessionId,
        ...(input.at?.kind === 'expert-team' ? { expertTeam: true } : {}),
      })
      activeTurns += 1
      return { kind: 'start', root }
    },

    admitKbOrganize(input) {
      const root = resolvePath(input.root)
      if (queue.length > 0) return { kind: 'skip', reason: 'queue-non-empty' }
      if (rootWriters.has(root)) return { kind: 'skip', reason: 'root-busy' }
      if (activeKbOrganize() !== undefined) return { kind: 'skip', reason: 'kb-busy' }
      if (activeTurns >= options.maxConcurrentTurns()) return { kind: 'skip', reason: 'cap-full' }
      rootWriters.set(root, {
        kind: 'kb-organize',
        sessionId: input.sessionId,
        kbId: input.kbId,
        onPreempt: input.onPreempt,
      })
      activeTurns += 1
      return { kind: 'start', root }
    },

    admitAutomation(input) {
      const root = resolvePath(input.root)
      const recordSkip = input.recordSkip !== false
      if (rootWriters.has(root)) {
        if (recordSkip) admissionSkips.add(input.automationId)
        return { kind: 'skip', reason: 'root-busy' }
      }
      if (input.countsTowardCap && activeTurns >= options.maxConcurrentTurns()) {
        if (recordSkip) admissionSkips.add(input.automationId)
        return { kind: 'skip', reason: 'cap-full' }
      }
      rootWriters.set(root, {
        kind: input.countsTowardCap ? 'agent-automation' : 'script-automation',
        sessionId: input.sessionId,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.automationId === undefined ? {} : { automationId: input.automationId }),
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
        const expertTeam = item.at?.kind === 'expert-team'
        rootWriters.set(item.root, {
          kind: 'user',
          sessionId: item.sessionId,
          ...(expertTeam ? { expertTeam: true } : {}),
        })
        activeTurns += 1
        starting.set(item.queueItemId, {
          sessionId: item.sessionId,
          ...(expertTeam ? { expertTeam: true } : {}),
        })
        started.push(item)
      }
      return started
    },

    hasPendingTeamTurn(sessionId) {
      for (const writer of rootWriters.values()) {
        if (writer.sessionId === sessionId && writer.expertTeam === true) return true
      }
      for (const item of starting.values()) {
        if (item.sessionId === sessionId && item.expertTeam === true) return true
      }
      return queue.some((item) => item.sessionId === sessionId && item.at?.kind === 'expert-team')
    },

    isAdmissionSkipped(automationId) {
      return admissionSkips.has(automationId)
    },

    activeTurnCount() {
      return activeTurns
    },

    soleCapWriterSessionId() {
      const sessionIds = [...rootWriters.values()]
        // 整理写者占名额但不是“唯一能力写者”:它不能让能力槽被当成唯一用户回合。
        .filter((writer) => countsTowardCap(writer.kind) && writer.kind !== 'kb-organize')
        .map((writer) => writer.sessionId)
      return sessionIds.length === 1 ? sessionIds[0] : undefined
    },

    activeSessionIds() {
      return new Set([
        ...[...rootWriters.values()].map((writer) => writer.sessionId),
        ...[...starting.values()].map((item) => item.sessionId),
        ...queue.map((item) => item.sessionId),
      ])
    },

    activeAutomationIds() {
      return new Set(
        [...rootWriters.values()]
          .filter((writer) => writer.kind !== 'user' && writer.automationId !== undefined)
          .map((writer) => writer.automationId!),
      )
    },
  }
}
