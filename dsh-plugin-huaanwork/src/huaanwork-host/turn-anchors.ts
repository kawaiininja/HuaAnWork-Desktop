import { sessionIdOfAgentRef } from '@huaanwork/policy/channels'

/**
 * 共享回合锚点(设计 §「回合归属」)。
 *
 * 一个会话的「当前回合」只由两类可信信号确定:
 * 1. Host 受理用户发送时 `register` 的 pending(`clientMessageId` 为 UUID 或自动化 runId);
 * 2. `agent/pre-step` 里最后一条真实人类用户消息的 `id`。
 *
 * 完成通知(`subagent-settled`)、`agent-instructions`、`runtime-context`、技能目录/
 * 调用等系统 `user/message` 不是回合边界;goal 续轮沿用原锚点与 `startedAt`。
 * 没有任何可信信号时一律 fail closed(返回 undefined),不猜测「最后一条用户消息」。
 */

/** 一个会话当前回合的持久锚点。`clientMessageId` 只来自 Host 生成的 UUID / 自动化 runId。 */
export type TurnAnchor = { clientMessageId: string; startedAt: string; origin: 'advanced' | 'automation' | 'unknown' }

export type TurnAnchorStore = {
  /**
   * 一次用户发送被 Host 受理前登记的待消费锚点。返回精确回滚闭包:只有 pending 仍属于
   * 本次登记时才移除,不清上一回合已生效的 anchor。
   */
  register(input: { sessionId: string; clientMessageId: string; origin: TurnAnchor['origin'] }): () => void
  /**
   * 把一次 `agent/pre-step` 的 messages 归约到当前锚点:只有真实用户消息可换锚,
   * goal 续轮与系统通知保持原锚点,找不到回合边界时原样返回当前锚点。
   */
  notePreStep(sessionId: string, messages: readonly unknown[], startedAt: string): TurnAnchor | undefined
  current(sessionId: string): TurnAnchor | undefined
  /** 删除会话 / Host 侧释放运行态时同时清掉 anchor 与未消费的 pending。 */
  clearSession(sessionId: string): void
}

/** 单进程同时活跃的会话锚点上限;超出后按最久未用淘汰。 */
const DEFAULT_LIMIT = 256

type PendingTurn = { messageId: string; origin: TurnAnchor['origin'] }

type TurnBoundary = { kind: 'goal' } | { kind: 'user'; id: string } | { kind: 'invalid' }

export function createTurnAnchorStore(options: { limit?: number } = {}): TurnAnchorStore {
  const limit = options.limit ?? DEFAULT_LIMIT
  /** 已生效的锚点(实例内,禁止模块级全局单槽)。 */
  const anchors = new Map<string, TurnAnchor>()
  /** 已受理但尚未在 pre-step 中出现的发送(messages 里出现后才写 anchor)。 */
  const pending = new Map<string, PendingTurn>()
  /** 会话最近使用次序(最久在前);anchors 与 pending 共用一份,淘汰时两表一起清。 */
  const order = new Map<string, true>()

  const touch = (sessionId: string): void => {
    order.delete(sessionId)
    order.set(sessionId, true)
  }

  const evictOverflow = (): void => {
    while (order.size > limit) {
      const oldest = order.keys().next().value
      if (oldest === undefined) return
      order.delete(oldest)
      anchors.delete(oldest)
      pending.delete(oldest)
    }
  }

  const current = (sessionId: string): TurnAnchor | undefined => {
    const anchor = anchors.get(sessionId)
    if (anchor === undefined) return undefined
    touch(sessionId)
    return anchor
  }

  return {
    register(input) {
      const entry: PendingTurn = { messageId: input.clientMessageId, origin: input.origin }
      pending.set(input.sessionId, entry)
      touch(input.sessionId)
      evictOverflow()
      let rolledBack = false
      return () => {
        if (rolledBack) return
        rolledBack = true
        // 仅撤回本次登记:期间被后续发送覆盖的 pending 不属于本次,上一回合的 anchor 也不动。
        if (pending.get(input.sessionId) === entry) pending.delete(input.sessionId)
      }
    },

    notePreStep(sessionId, messages, startedAt) {
      const observed = scanTurnBoundary(messages)
      // 没有回合边界 / goal 续轮:锚点保持原样(fail closed,不写 unknown)。
      if (observed === undefined || observed.kind === 'goal') return current(sessionId)
      // 真实人类消息缺字符串 id:清除上一回合旧锚与未消费 pending,避免新回合工具/待办误归旧回合。
      if (observed.kind === 'invalid') {
        anchors.delete(sessionId)
        pending.delete(sessionId)
        order.delete(sessionId)
        return undefined
      }
      const existing = anchors.get(sessionId)
      if (existing !== undefined && existing.clientMessageId === observed.id) {
        // 同一消息的重复 pre-step(或多次 listener 调用)不得刷新 startedAt。
        touch(sessionId)
        return existing
      }
      const registration = pending.get(sessionId)
      const registered = registration !== undefined && registration.messageId === observed.id
      const anchor: TurnAnchor = {
        clientMessageId: observed.id,
        startedAt,
        // 未登记的普通用户消息照常降级为 unknown;已登记的发送保留其来源。
        origin: registered ? registration.origin : 'unknown',
      }
      anchors.set(sessionId, anchor)
      if (registered) pending.delete(sessionId)
      touch(sessionId)
      evictOverflow()
      return anchor
    },

    current,

    clearSession(sessionId) {
      anchors.delete(sessionId)
      pending.delete(sessionId)
      order.delete(sessionId)
    },
  }
}

/**
 * 从 messages 末尾向前找最近一条回合边界消息。
 *
 * - 只有 `role === 'user'` 且 `source.kind` 为 `'user'` / 缺失(旧夹具 `''`)的消息才是
 *   真实用户回合;`goal` 是续轮标记;
 * - `subagent-settled`、`agent-instructions`、`runtime-context`、技能目录/调用、
 *   `user-question-reply`、`user-approval`、`working-directory`、`compact-checkpoint`、
 *   `plugin`、`tool` 等一切非人类/系统通知直接跳过;
 * - 真实用户消息缺字符串 id 时返回 `invalid`:清掉旧锚与未消费 pending 并 fail closed,不沿用旧锚也不继续向前猜旧消息。
 */
function scanTurnBoundary(messages: readonly unknown[]): TurnBoundary | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const boundary = turnBoundaryOf(messages[index])
    if (boundary !== undefined) return boundary
  }
  return undefined
}

function turnBoundaryOf(raw: unknown): TurnBoundary | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const message = raw as { role?: unknown; id?: unknown; source?: { kind?: unknown } }
  if (message.role !== 'user') return undefined
  const kind = typeof message.source?.kind === 'string' ? message.source.kind : ''
  if (kind === 'goal') return { kind: 'goal' }
  // 白名单之外的 kind 都是系统/注入消息,不得换锚。
  if (kind !== '' && kind !== 'user') return undefined
  return typeof message.id === 'string' && message.id.length > 0 ? { kind: 'user', id: message.id } : { kind: 'invalid' }
}

/**
 * 一次 claim 的消息是否构成回合边界(与 `turnBoundaryOf` 同一判定)。
 *
 * `agent/inbox/claimed` 在每次 next-step 认领时逐条触发,不只在回合边界触发:
 * `repeat-tool-reminder` 等插件会在 post-execute 后向 `next-step` 注入 `UserMessage`,
 * 它们的 `source.kind` 不在白名单内,既不能换锚,也**不得改变回合级附件**。
 * goal 续拍与真实用户消息(含缺 id 的 invalid)才是边界,调用方须按边界语义处理。
 *
 * @param raw - claim 载荷里的消息
 * @returns 是否为回合边界消息
 */
export function isTurnBoundaryMessage(raw: unknown): boolean {
  return turnBoundaryOf(raw) !== undefined
}

/**
 * Host 侧接线:`agent/pre-step` 写锚点、`session/disposed` 清理锚点。
 *
 * pre-step 是 waterfall:监听器必须显式 `return next()`,否则其余 pre-step 监听器
 * (工具可见性、拒发校验)不会执行。两个监听器都按各自载荷幂等调用 `notePreStep`,
 * 调用顺序不影响最终锚点与 `startedAt`。
 */
export function installTurnAnchorHooks(ctx: {
  huaanworkTurnAnchors?: TurnAnchorStore
  on(event: string, listener: (...args: never[]) => unknown, options?: { global?: boolean }): void
}): void {
  ctx.on(
    'agent/pre-step',
    ((payload: { agent?: unknown; messages?: unknown }, next: () => unknown) => {
      const sessionId = sessionIdOfAgentRef(payload?.agent as { id?: string; session?: { id?: string } } | undefined)
      if (sessionId !== undefined) {
        const messages = Array.isArray(payload?.messages) ? (payload.messages as readonly unknown[]) : []
        ctx.huaanworkTurnAnchors?.notePreStep(sessionId, messages, new Date().toISOString())
      }
      return typeof next === 'function' ? next() : undefined
    }) as never,
    { global: true },
  )
  ctx.on(
    'session/disposed',
    ((session: { id?: string }) => {
      const sessionId = session?.id
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        ctx.huaanworkTurnAnchors?.clearSession(sessionId)
      }
    }) as never,
    { global: true },
  )
}
