import { sessionIdOfAgentRef } from '@huaanwork/policy/channels'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'

/**
 * 团队回合事件观察器(设计 §12.1 / §12.4.2 / §16.10)。
 *
 * 上游 `agent-loop` 消费收件箱时先写 `turn/start`、再发
 * `agent/inbox/claimed { agent, message, turn }`;claim 到达时该 turn 已经开始,
 * 观察器必须**直接从 claim 载荷绑定** `activeTurn = payload.turn`,不能在 claim 之后
 * 等待下一条 `turn/start`(那属于下一个 turn,永远等不到本回合)。
 *
 * 只处理父会话(`session.id === parentSessionId`)且归属 `activeTurn` 的事件:
 * - 每个 `tool/result` 用事件 `seq` 更新最后工具边界并清空此前摘要;
 * - 边界之后的 `assistant/message` 只拼接 `text` 块(忽略 reasoning),供
 *   `finalSummaryPresent()` 判定「仅会话模式」的非空最终汇总;
 * - 当前 turn 的 `turn/end` 同步锁定事实并只回调一次;`aborted` 同时回调 `onAbort`;
 * - `afterIdle()` 只在当前 turn 的 `turn/end` 从未出现时以 `eventMissing: true`
 *   兜底回调,绝不调用已弃用的同步 `snapshotEvents()`;
 * - `event.seq` 必须是严格递增的数字;缺失或非单调时 fail-closed:丢弃摘要并标异常,
 *   绝不猜测顺序,后续结算的 `finalSummaryPresent` 恒为 false。
 *
 * 观察器不跨回合复用:绑定只接受首个匹配 `followupId` 的 claim,结算后忽略所有
 * goal 续拍与迟到事件。
 */

/** `turn/end` 观察事实;`reason` 只在真实收到 `turn/end` 时存在(afterIdle 兜底没有原因)。 */
export type ExpertTeamTurnEndFacts = {
  turn: number
  /** 本轮最后一个 `tool/result` 之后是否有非空白助手 text(仅会话模式判定依据)。 */
  finalSummaryPresent: boolean
  /** 当前 turn 的 `turn/end` 从未出现,由 `afterIdle` fail-closed 结算。 */
  eventMissing: boolean
  reason?: TurnEndReason
}

export type ExpertTeamTurnObserverOptions = {
  parentSessionId: string
  /** 本轮 `agent.followup({ id })` 的持久消息 id;`agent/inbox/claimed` 据此绑定回合。 */
  followupId: string
  /** 当前 turn 结算回调;整个观察器生命周期最多一次。 */
  onTurnEnd?: (facts: ExpertTeamTurnEndFacts) => void
  /** 父回合以 `aborted` 结束时与 `onTurnEnd` 一起收到同一事实快照。 */
  onAbort?: (facts: ExpertTeamTurnEndFacts) => void
}

export type ExpertTeamTurnObserver = {
  readonly parentSessionId: string
  /** 认领本回合;只接受首个 `message.id === followupId` 的载荷,并直接绑定其 `turn`。 */
  claim(payload: { message: { id: string }; turn: number }): void
  /** 投递一条父会话事件;其它会话、未绑定回合、结算后事件一律忽略。 */
  event(session: { id?: string }, event: SessionEvent): void
  /** idle 兜底:当前 turn 未收到 `turn/end` 时以 `eventMissing: true` 结算一次。 */
  afterIdle(): void
  finalSummaryPresent(): boolean
  turnEndFacts(): ExpertTeamTurnEndFacts | undefined
  /**
   * 释放观察器。经 `bindExpertTeamObserver` 绑定时同步注销两条全局监听并从在途表摘除
   * (与绑定返回的注销闭包等价、互相幂等);未绑定时只做本地清理。
   */
  dispose(): void
}

/** 观察器订阅所需的最小 Cordis 面;`on` 的返回值在真实 Context 上是注销函数。 */
export type ExpertTeamObserverContext = {
  on?(
    name: string,
    listener: (...args: never[]) => unknown,
    options?: boolean | { global?: boolean },
  ): unknown
}

type BoundObserverEntry = {
  ctx: ExpertTeamObserverContext
  parentSessionId: string
  release: () => void
}

/** 父会话 → 已绑定观察器条目;`releaseSessionRuntime` 与 Host teardown 按会话/上下文整体卸载。 */
const boundObservers = new Map<string, Set<BoundObserverEntry>>()

/** Host Context → 已绑定观察器条目;Host 卸载时只释放本实例,不误伤同进程其它 Host。 */
const boundObserversByCtx = new Map<ExpertTeamObserverContext, Set<BoundObserverEntry>>()

/** 已绑定观察器 → 其绑定注销闭包;`observer.dispose()` 依赖它取消全局监听,避免遗留。 */
const observerReleases = new WeakMap<ExpertTeamTurnObserver, () => void>()

function addBoundObserver(entry: BoundObserverEntry): void {
  let bySession = boundObservers.get(entry.parentSessionId)
  if (bySession === undefined) {
    bySession = new Set()
    boundObservers.set(entry.parentSessionId, bySession)
  }
  bySession.add(entry)
  let byCtx = boundObserversByCtx.get(entry.ctx)
  if (byCtx === undefined) {
    byCtx = new Set()
    boundObserversByCtx.set(entry.ctx, byCtx)
  }
  byCtx.add(entry)
}

function removeBoundObserver(entry: BoundObserverEntry): void {
  const bySession = boundObservers.get(entry.parentSessionId)
  if (bySession !== undefined) {
    bySession.delete(entry)
    if (bySession.size === 0) boundObservers.delete(entry.parentSessionId)
  }
  const byCtx = boundObserversByCtx.get(entry.ctx)
  if (byCtx !== undefined) {
    byCtx.delete(entry)
    if (byCtx.size === 0) boundObserversByCtx.delete(entry.ctx)
  }
}

/**
 * 同步卸载一个父会话的全部在途观察器。
 *
 * 会话删除与级联清理(`releaseSessionRuntime`)用它在删除日志之前停掉事件观察,
 * 避免已删会话的迟到事件继续聚合并回调结算。传入 `ctx` 时仅卸载该 Host 实例
 * 绑定的观察器,避免同进程多 Host 互相误伤。
 *
 * @param parentSessionId - 父会话 id
 * @param ctx - 可选的 Host Context 过滤条件
 */
export function disposeExpertTeamObservers(
  parentSessionId: string,
  ctx?: ExpertTeamObserverContext,
): void {
  const entries = boundObservers.get(parentSessionId)
  if (entries === undefined) return
  const targets =
    ctx === undefined ? [...entries] : [...entries].filter((entry) => entry.ctx === ctx)
  for (const entry of targets) entry.release()
}

/**
 * 同步卸载指定 Host Context(或缺省时全部)的在途观察器。
 *
 * Host teardown(`index.ts` disposer)调用它兜底释放模块级注册表与全局监听,
 * 防止 pre-claim 或异常退出路径残留闭包引用(设计 §12.1)。
 *
 * @param ctx - 可选的 Host Context;传入时只释放该实例的观察器
 */
export function disposeAllExpertTeamObservers(ctx?: ExpertTeamObserverContext): void {
  if (ctx !== undefined) {
    const entries = boundObserversByCtx.get(ctx)
    if (entries === undefined) return
    for (const entry of [...entries]) entry.release()
    return
  }
  for (const entries of [...boundObservers.values()]) {
    for (const entry of [...entries]) entry.release()
  }
}

function snapshotFacts(facts: ExpertTeamTurnEndFacts): ExpertTeamTurnEndFacts {
  return {
    turn: facts.turn,
    finalSummaryPresent: facts.finalSummaryPresent,
    eventMissing: facts.eventMissing,
    ...(facts.reason === undefined ? {} : { reason: facts.reason }),
  }
}

export function createExpertTeamTurnObserver(options: ExpertTeamTurnObserverOptions): ExpertTeamTurnObserver {
  /** 已观察到的最大事件 seq;严格递增校验与「最后工具边界」共用同一序列。 */
  let lastSeq: number | undefined
  /** claim 绑定的团队回合;只设一次。 */
  let activeTurn: number | undefined
  /** 最后一个 `tool/result` 的 seq;边界之前的助手 text 不算最终汇总。 */
  let lastToolResultSeq: number | undefined
  /** 最后工具边界之后累计的助手 text 块。 */
  let summary = ''
  /** seq 缺失/回退后永久 fail-closed:摘要不可信,结算必报 false。 */
  let seqAnomaly = false
  let settled = false
  let disposed = false
  let facts: ExpertTeamTurnEndFacts | undefined

  const computeSummary = (): boolean => (seqAnomaly ? false : summary.trim().length > 0)

  const settle = (input: ExpertTeamTurnEndFacts): void => {
    if (settled || disposed) return
    // 先锁定事实再回调:回调内重入 event/afterIdle 也不得二次结算或改写事实。
    settled = true
    facts = snapshotFacts(input)
    const view = snapshotFacts(input)
    // 回调异常不能穿透上游 `session/event` 监听器(它只 warn 收容):事实已锁定,
    // 派工封闭与终态写入由结算回调自身保证,这里只隔离,避免一次 throw 跳过 onAbort。
    try {
      options.onTurnEnd?.(view)
    } catch {
      // 结算回调失败已由观察器隔离;上游监听器保持静默。
    } finally {
      if (view.reason?.kind === 'aborted') {
        try {
          options.onAbort?.(view)
        } catch {
          // abort 联动同样隔离,不影响已锁定的回合事实。
        }
      }
    }
  }

  const markSeqAnomaly = (): void => {
    seqAnomaly = true
    summary = ''
  }

  /** 只做本地清理;绑定注销在摘除 `observerReleases` 后回到这里,不会递归。 */
  const disposeLocal = (): void => {
    if (disposed) return
    disposed = true
    summary = ''
  }

  const observer: ExpertTeamTurnObserver = {
    parentSessionId: options.parentSessionId,

    claim(payload) {
      if (disposed || settled || activeTurn !== undefined) return
      if (payload.message.id !== options.followupId) return
      // 上游先 turn/start 后 claimed:此处直接锁定载荷 turn,不等待下一条 turn/start。
      activeTurn = payload.turn
    },

    event(session, event) {
      if (disposed) return
      if (session.id !== options.parentSessionId) return
      const seq = event.seq
      const seqInvalid =
        typeof seq !== 'number' || !Number.isFinite(seq) || (lastSeq !== undefined && seq <= lastSeq)
      if (seqInvalid) {
        markSeqAnomaly()
        // 即使 turn/end 自身或之前出现 seq 异常，命中当前回合 turn/end 时仍须同步封闭并保留 abort 原因，
        // 避免把租约失效推迟到 afterIdle；finalSummaryPresent 按 seqAnomaly 强制 fail-closed 为 false。
        if (!settled && activeTurn !== undefined && event.type === 'turn/end' && event.data.turn === activeTurn) {
          settle({
            turn: activeTurn,
            finalSummaryPresent: false,
            eventMissing: false,
            reason: event.data.reason,
          })
        }
        return
      }
      lastSeq = seq
      // 结算后忽略一切迟到/续拍事件;seq 仍参与单调校验,避免回退被当作新事实。
      if (settled || activeTurn === undefined) return

      if (event.type === 'tool/result') {
        if (event.data.turn !== activeTurn) return
        lastToolResultSeq = seq
        summary = ''
        return
      }
      if (event.type === 'assistant/message') {
        if (event.data.turn !== activeTurn) return
        // 没有工具边界(或文本在边界之前)时不累计:过渡语与工具前说明不是最终汇总。
        if (lastToolResultSeq === undefined || seq <= lastToolResultSeq) return
        for (const block of event.data.message.content) {
          if (block.type === 'text') summary += block.text
        }
        return
      }
      if (event.type === 'turn/end') {
        if (event.data.turn !== activeTurn) return
        settle({
          turn: activeTurn,
          finalSummaryPresent: computeSummary(),
          eventMissing: false,
          reason: event.data.reason,
        })
      }
    },

    afterIdle() {
      if (disposed || settled || activeTurn === undefined) return
      settle({ turn: activeTurn, finalSummaryPresent: computeSummary(), eventMissing: true })
    },

    finalSummaryPresent() {
      if (settled) return facts?.finalSummaryPresent === true
      if (disposed) return false
      return computeSummary()
    },

    turnEndFacts() {
      return facts === undefined ? undefined : snapshotFacts(facts)
    },

    dispose() {
      // 已绑定时走绑定注销:同步移除两条全局监听与在途表条目,而不是只翻本地标志。
      const release = observerReleases.get(observer)
      if (release !== undefined) {
        release()
        return
      }
      disposeLocal()
    },
  }
  return observer
}

/** `ctx.on` 的真实返回值是注销函数;fixture 上下文可以不返回,归一成空闭包。 */
function normalizeDisposer(handle: unknown): () => void {
  if (typeof handle !== 'function') return () => undefined
  const off = handle as () => unknown
  return () => {
    off()
  }
}

type ClaimedPayload = { agent?: { id?: string; session?: { id?: string } }; message?: { id?: unknown }; turn?: unknown }

/**
 * 把观察器接到 `{ global: true }` 的两条上游事件上,返回统一注销闭包。
 *
 * - `agent/inbox/claimed`:按 `sessionIdOfAgentRef(payload.agent)` 过滤父会话后
 *   交给 `observer.claim({ message, turn })`;
 * - `session/event`:父会话过滤在 `observer.event` 内完成(它还要绑定单回合状态)。
 *
 * 注销闭包同步移除两条监听并 `observer.dispose()`,同时从按会话索引的在途表中
 * 摘除,防止跨回合/跨会话泄漏。重复调用注销闭包是幂等的;`observer.dispose()`
 * 在绑定时走同一条注销路径,因此两种释放方式可以任意混用。
 *
 * @param ctx - Host Context(至少提供 `on`;真实 Context 返回注销函数)
 * @param observer - 待绑定的回合观察器
 * @returns 同步注销两条监听与观察器的幂等闭包
 */
export function bindExpertTeamObserver(ctx: ExpertTeamObserverContext, observer: ExpertTeamTurnObserver): () => void {
  const subscribe = (name: string, listener: (...args: never[]) => unknown): (() => void) => {
    const on = ctx.on
    if (on === undefined) throw new Error('expert-team-observer requires ctx.on')
    // 保留真实 Cordis 方法的 this;fixture 的纯函数 on 不依赖 this。
    return normalizeDisposer(on.call(ctx, name, listener, { global: true }))
  }
  let disposed = false
  const offClaimed = subscribe(
    'agent/inbox/claimed',
    ((payload: ClaimedPayload) => {
      if (disposed) return
      if (sessionIdOfAgentRef(payload?.agent) !== observer.parentSessionId) return
      const messageId = payload?.message?.id
      if (typeof messageId !== 'string' || typeof payload?.turn !== 'number') return
      observer.claim({ message: { id: messageId }, turn: payload.turn })
    }) as never,
  )
  let offEvent: () => void
  try {
    offEvent = subscribe(
      'session/event',
      ((session: { id?: string } | undefined, event: SessionEvent | undefined) => {
        if (disposed || event === undefined) return
        observer.event(session ?? {}, event)
      }) as never,
    )
  } catch (error) {
    // 第二条订阅失败时先撤掉第一条,不留半绑定监听器。
    offClaimed()
    throw error
  }
  const release = (): void => {
    if (disposed) return
    disposed = true
    // 先摘注册表与在途表再注销:observer.dispose() 回到 release 时不再递归。
    observerReleases.delete(observer)
    removeBoundObserver(entry)
    offClaimed()
    offEvent()
    observer.dispose()
  }
  const entry: BoundObserverEntry = { ctx, parentSessionId: observer.parentSessionId, release }
  observerReleases.set(observer, release)
  addBoundObserver(entry)
  return release
}
