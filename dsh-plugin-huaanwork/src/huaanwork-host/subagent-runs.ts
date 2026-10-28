import { randomUUID } from 'node:crypto'
import { setTimeout as setNodeTimeout } from 'node:timers'

import {
  acceptanceExtraWarnings,
  acceptanceHoldEndMs,
  acceptanceHoldFinalizingMs,
  acceptanceTerminalReason,
} from './acceptance-hooks.ts'
import type {
  RpcEvent,
  SubagentCancelResult,
  SubagentCleanupWarning,
  SubagentRunProjection,
  SubagentRunSnapshot,
  SubagentStopReason,
  SubagentToolActivity,
} from '../client-huaanwork/rpc-types.ts'

/**
 * 子代理 run 的权威状态机(设计 §5.2 / M 计划 Task 1)。
 *
 * 一次显式 @ 调用对应一个 Host `runId`;registry 是投影的唯一事实源,后续
 * Host 执行链(legacy `@agent`、包 `@slug`)、guardrail bridge、RPC 与 React
 * 客户端都只读它。三层身份各司其职:
 *
 * - Host `runId`:`begin` 生成,WS/snapshot/cancel 的主键;
 * - 预留 `childId`:最早的 token/tool 归因;activation 返回的实际 childId 不同时重绑定;
 * - `upstreamRunId`:收到 `subagent/start` 后绑定,严格配对其后的 `subagent/end`,
 *   避免旧 end 清掉新 run。
 *
 * 终态语义固定,不得被实施者替换:
 *
 * - `settleResult` 只表示权威 `activation.result` resolve,`rejectResult` 只表示
 *   该 promise reject,`failRun` 只表示启动/外层执行链失败;三者互不替代。
 * - 冲突按 D2 以 resolved result 为准:end 的 `error` 与 result 不一致时追加一次
 *   `upstream-end-error` 清理告警,不翻转已发布的终态。
 * - `subagent/end` 在 result 仍 pending 时只保存候选:保持当前非终态、不写
 *   `endedAt`、不提前发布 `failed`。
 * - 停止闩(定向取消)或已进入 `stopping` 后,result/rejection/failRun 只保留
 *   原始 `stopReason`/`failure` 与「执行已终结」事实;`stopped` 需要清理确认。
 * - 清理确认是状态而不是一次性事件:成功确认先于执行终结到达时保存在 record 上,
 *   之后进入 `stopping` 且执行已终结即收敛为 `stopped`,不要求第二次确认。
 * - 已终态 run 不因迟到活动/结果/end 复活或改相,只补缺失身份与清理告警。
 */

export type SubagentRunRegistryOptions = {
  now?: () => number
  activityFlushMs?: number
  /** 每个父会话保留的终态 run 上限;默认 20,活跃/停止中 run 永不裁剪。 */
  terminalPerParent?: number
  /** 全局保留的终态 run 上限;默认 200,活跃/停止中 run 永不裁剪。 */
  terminalGlobal?: number
  emit(event: RpcEvent): void
}

/** `subagent.cancel` 的 run 不存在,或 `runId` 不属于请求的父会话。 */
export class SubagentRunNotFoundError extends Error {
  constructor() {
    super('subagent run not found')
    this.name = 'SubagentRunNotFoundError'
  }
}

export interface SubagentRunRegistry {
  begin(input: {
    parentSessionId: string
    kind: 'legacy' | 'package'
    label: string
    packageVersion?: string
    clientMessageId?: string
  }): string
  get(runId: string): SubagentRunProjection | undefined
  parentSessionIdOf(runId: string): string | undefined
  reserveChild(runId: string, childId: string): void
  bindActivation(runId: string, input: { childId: string }): void
  bindUpstreamStart(input: { hostRunId?: string; upstreamRunId: string; childId: string }): void
  ownsChild(childId: string): boolean
  noteReasoning(childId: string): void
  noteToken(childId: string): void
  startTool(childId: string, tool: { callId?: string; name: string }): void
  endTool(childId: string, tool: { callId?: string; name: string }): void
  childIdle(childId: string): void
  noteChildError(childId: string, message: string): void
  settleResult(runId: string, result: { stopReason: string }): void
  rejectResult(runId: string, message: string): void
  settleUpstreamEnd(input: { upstreamRunId: string; stopReason: string }): void
  failRun(runId: string, message: string): void
  noteCleanupBudget(runId: string, budgetMs: number): void
  confirmCleanup(runId: string, input: { ok: boolean; warnings: SubagentCleanupWarning[] }): void
  /**
   * 绑定该 run 的精确取消闭包。若停止意图已 latch 且 run 仍非终态,立即启动
   * 一次后台清理;重复绑定不会二次调用。闭包 resolve 不代表清理已确认。
   */
  attachCancel(runId: string, cancel: () => Promise<void>): void
  /** 只取消 `parentSessionId + runId` 精确匹配的 run;不接受会话级/同级取消。 */
  requestCancel(parentSessionId: string, runId: string): Promise<SubagentCancelResult>
  /** 该父会话的只读对账快照;不刷新 `lastActivity`,不含其他父会话的 run。 */
  snapshot(parentSessionId: string): SubagentRunSnapshot
}

/** registry 内部记录:内部仲裁状态不上 wire。 */
type RunRecord = {
  run: SubagentRunProjection
  resultState: 'pending' | 'resolved' | 'rejected'
  /** 结果仍 pending 时先到的 `subagent/end`,只作候选,不参与终态发布。 */
  candidateEnd?: SubagentStopReason
  /** 权威执行已终结(result resolve/reject 或 failRun);`stopped` 的必要条件之一。 */
  executionEnded: boolean
  /**
   * owner 最近一次清理确认的结论;`stopped` 的另一必要条件。
   *
   * 确认是状态而非事件:成功先于执行终结到达时照样保存,进入 `stopping` 后直接收敛;
   * `{ok:false}` 只表示「这次没有确认」,不得留下成功。
   */
  cleanupOk: boolean
  /** 定向停止闩:首次 `requestCancel` 受理后固定为 true。 */
  stopLatched: boolean
  /** `subagent/end` 幂等闩。 */
  endSeen: boolean
  /** 清理过的 child 错误文案;只在权威 error 失败且无显式 failure 时作为原因呈现。 */
  childError?: string
  /** 执行链绑定的精确取消闭包;只在定向停止受理后调用。 */
  cancel?: () => Promise<void>
  /** request 与 attach 两条路径共用的幂等闩,保证取消闭包最多调用一次。 */
  cancelStarted: boolean
  /** 终态历史淘汰顺序;首次进入终态时分配,越小越旧。 */
  terminalOrder?: number
  /** 验收钩子暂存的延迟结果;只在 `HOLD_END`/`HOLD_FINALIZING` 打开时使用。 */
  pendingResult?: { stopReason: string }
}

const DEFAULT_ACTIVITY_FLUSH_MS = 1_000
const DEFAULT_TERMINAL_PER_PARENT = 20
const DEFAULT_TERMINAL_GLOBAL = 200
const CHILD_ERROR_TEXT_LIMIT = 500

function isTerminalPhase(phase: SubagentRunProjection['phase']): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'stopped'
}

/** 无法识别的 stopReason 一律 `unknown`,不得当作成功。 */
function normalizeStopReason(reason: string): SubagentStopReason {
  switch (reason) {
    case 'completed':
    case 'aborted':
    case 'error':
    case 'max-tokens':
    case 'refusal':
      return reason
    default:
      return 'unknown'
  }
}

/** 清理过的 message:折行、去首尾空白并截断,任意错误堆栈不进入投影。 */
function sanitizeChildError(message: string): string | undefined {
  const text = message.replace(/\s+/g, ' ').trim()
  if (text === '') return undefined
  return text.slice(0, CHILD_ERROR_TEXT_LIMIT)
}

/** 外部只拿到副本,避免调用方改写 registry 的权威状态。 */
function cloneProjection(run: SubagentRunProjection): SubagentRunProjection {
  return {
    ...run,
    activeTools: run.activeTools.map((tool) => ({ ...tool })),
    cleanupWarnings: run.cleanupWarnings.map((warning) => ({ ...warning })),
  }
}

export function createSubagentRunRegistry(options: SubagentRunRegistryOptions): SubagentRunRegistry {
  const clock = options.now ?? Date.now
  const activityFlushMs = Math.max(0, options.activityFlushMs ?? DEFAULT_ACTIVITY_FLUSH_MS)
  const terminalPerParent = Math.max(0, options.terminalPerParent ?? DEFAULT_TERMINAL_PER_PARENT)
  const terminalGlobal = Math.max(0, options.terminalGlobal ?? DEFAULT_TERMINAL_GLOBAL)
  const generation = randomUUID()

  const records = new Map<string, RunRecord>()
  const childIndex = new Map<string, string>()
  const upstreamIndex = new Map<string, string>()
  /** revision 全 registry 单调递增:每次状态变化 +1,投影携带最新值。 */
  let revision = 0
  /** 终态进入顺序;只用于有界历史淘汰,不对外发布。 */
  let terminalSequence = 0

  const pendingEmits = new Set<string>()
  let flushTimer: ReturnType<typeof setNodeTimeout> | undefined

  function touch(record: RunRecord): void {
    revision += 1
    record.run.revision = revision
    if (isTerminalPhase(record.run.phase) && record.terminalOrder === undefined) {
      terminalSequence += 1
      record.terminalOrder = terminalSequence
    }
  }

  function emitRecord(record: RunRecord): void {
    pendingEmits.delete(record.run.runId)
    options.emit({ event: 'subagent/run', run: cloneProjection(record.run) })
  }

  function compareTerminalOrder(left: RunRecord, right: RunRecord): number {
    return (left.terminalOrder ?? 0) - (right.terminalOrder ?? 0)
  }

  /** 从 registry 与三层索引中移除一个已终态 run,并对客户端发布带代际/revision 的移除事件。 */
  function removeRecord(record: RunRecord): void {
    records.delete(record.run.runId)
    pendingEmits.delete(record.run.runId)
    if (record.run.childId !== undefined && childIndex.get(record.run.childId) === record.run.runId) {
      childIndex.delete(record.run.childId)
    }
    if (record.run.upstreamRunId !== undefined && upstreamIndex.get(record.run.upstreamRunId) === record.run.runId) {
      upstreamIndex.delete(record.run.upstreamRunId)
    }
    options.emit({
      event: 'subagent/run-remove',
      runId: record.run.runId,
      parentSessionId: record.run.parentSessionId,
      generation: record.run.generation,
      revision: record.run.revision,
    })
  }

  /**
   * 终态历史有界:每父会话 20 条、全局 200 条。活跃与 `stopping` 永不裁剪;
   * 淘汰按首次进入终态的顺序,并发 run 的淘汰顺序不构成契约。
   */
  function pruneTerminalHistory(): void {
    const byParent = new Map<string, RunRecord[]>()
    for (const record of records.values()) {
      if (!isTerminalPhase(record.run.phase)) continue
      const list = byParent.get(record.run.parentSessionId)
      if (list === undefined) byParent.set(record.run.parentSessionId, [record])
      else list.push(record)
    }
    for (const list of byParent.values()) {
      if (list.length <= terminalPerParent) continue
      list.sort(compareTerminalOrder)
      for (const record of list.slice(0, list.length - terminalPerParent)) removeRecord(record)
    }

    const terminal = [...records.values()].filter((record) => isTerminalPhase(record.run.phase))
    if (terminal.length <= terminalGlobal) return
    terminal.sort(compareTerminalOrder)
    for (const record of terminal.slice(0, terminal.length - terminalGlobal)) removeRecord(record)
  }

  /**
   * 启动该 run 的精确取消闭包,最多一次。闭包 resolve 只表示它自己返回;拒绝转成
   * 一条 `cleanup-failed` 告警,绝不冒泡为 unhandled rejection。
   */
  function startCancel(record: RunRecord): void {
    if (record.cancelStarted) return
    const cancel = record.cancel
    if (cancel === undefined) return
    record.cancelStarted = true
    let pending: Promise<void>
    try {
      pending = Promise.resolve(cancel())
    } catch (error) {
      pending = Promise.reject(error)
    }
    void pending.catch(() => {
      const current = records.get(record.run.runId)
      if (current === undefined) return
      if (!appendWarning(current, { code: 'cleanup-failed', severity: 'error' })) return
      touch(current)
      publish(current)
    })
  }

  function flushPending(): void {
    const ids = [...pendingEmits]
    pendingEmits.clear()
    for (const id of ids) {
      const record = records.get(id)
      if (record !== undefined) emitRecord(record)
    }
  }

  function scheduleFlush(): void {
    if (flushTimer !== undefined) return
    flushTimer = setNodeTimeout(() => {
      flushTimer = undefined
      flushPending()
    }, activityFlushMs)
    flushTimer.unref()
  }

  /** 生命周期/工具/清理变化立即发布;高频 token/reasoning 按 `activityFlushMs` 合并。 */
  function publish(record: RunRecord): void {
    emitRecord(record)
    // 终态帧先到达客户端,再淘汰更旧的终态历史(若有),避免发布已移除的 run。
    pruneTerminalHistory()
  }

  /** 高频活动:0 时同步发布,默认约 1 秒合并;终态发布前由 `publish` 覆盖最新投影。 */
  function publishCoalesced(record: RunRecord): void {
    if (activityFlushMs === 0) {
      emitRecord(record)
      return
    }
    pendingEmits.add(record.run.runId)
    scheduleFlush()
  }

  function recordOfChild(childId: string): RunRecord | undefined {
    const runId = childIndex.get(childId)
    if (runId === undefined) return undefined
    return records.get(runId)
  }

  /** 返回仍可接受执行活动的记录;终态 run 的迟到活动一律丢弃。 */
  function activeRecordOfChild(childId: string): RunRecord | undefined {
    const record = recordOfChild(childId)
    if (record === undefined || isTerminalPhase(record.run.phase)) return undefined
    return record
  }

  /** 把 childId 归因到该 run;旧预留 id 的映射随之移除(活动本体挂在 record 上)。 */
  function rebindChild(record: RunRecord, childId: string): boolean {
    const previous = record.run.childId
    if (previous === childId) return false
    if (previous !== undefined) childIndex.delete(previous)
    record.run.childId = childId
    childIndex.set(childId, record.run.runId)
    return true
  }

  function appendWarning(record: RunRecord, warning: SubagentCleanupWarning): boolean {
    const duplicate = record.run.cleanupWarnings.some(
      (existing) => existing.code === warning.code && existing.severity === warning.severity,
    )
    if (duplicate) return false
    record.run.cleanupWarnings.push({ code: warning.code, severity: warning.severity })
    return true
  }

  /**
   * 终止条件只在这里求值:已进入 `stopping`,执行已终结,且 owner 最近的清理确认
   * 为成功。`confirmCleanup` 早于执行终结到达时只保存事实,在此不依赖第二次确认;
   * 已终态 run(含自然终态)不满足 `stopping` 前提,不会被翻转。
   *
   * @returns 本次调用是否把 run 发布为 `stopped`。
   */
  function settleStopped(record: RunRecord): boolean {
    if (record.run.phase !== 'stopping' || !record.executionEnded || !record.cleanupOk) return false
    record.run.phase = 'stopped'
    record.run.endedAt = clock()
    return true
  }

  function enterStopping(record: RunRecord, cause: NonNullable<SubagentRunProjection['stopCause']>): void {
    record.run.phase = 'stopping'
    if (record.run.stopCause === undefined) record.run.stopCause = cause
    // 进入 stopping 本身就可能满足终止条件(确认早于执行终结):同一拍收敛。
    settleStopped(record)
  }

  function terminalize(record: RunRecord, stopReason: SubagentStopReason): void {
    record.run.stopReason = stopReason
    record.run.phase = stopReason === 'completed' ? 'completed' : 'failed'
    record.run.endedAt = clock()
    if (stopReason === 'error' && record.run.failure === undefined && record.childError !== undefined) {
      record.run.failure = record.childError
    }
  }

  /**
   * 按权威结果定相位。停止闩或已进入 `stopping` 时保持 `stopping`;唯一的例外是
   * 收尾预算路径收到权威 completed —— 按自然执行结果定为 completed。已保存的清理
   * 确认在这里补一次终止判定,覆盖 result 驱动的终止(含已停止闩的 run)。
   */
  function applyOutcome(record: RunRecord, stopReason: SubagentStopReason): void {
    if (!record.stopLatched) {
      if (record.run.phase === 'stopping') {
        if (stopReason === 'completed' && record.run.stopCause === 'cleanup-budget') terminalize(record, stopReason)
      } else if (stopReason === 'completed') {
        terminalize(record, stopReason)
      } else if (stopReason === 'aborted') {
        enterStopping(record, 'aborted')
      } else {
        terminalize(record, stopReason)
      }
    }
    settleStopped(record)
  }

  function findToolIndex(tools: SubagentToolActivity[], tool: { callId?: string; name: string }): number {
    if (tool.callId !== undefined) return tools.findIndex((activity) => activity.callId === tool.callId)
    return tools.findIndex((activity) => activity.name === tool.name)
  }

  /**
   * 应用权威 resolved result。验收钩子可在此替换终态原因或追加告警;正常路径与
   * 延迟路径都经由此处,保证 `stopLatched`/`stopping` 语义不被注入改变。
   */
  function settleResultNow(record: RunRecord, result: { stopReason: string }): void {
    if (isTerminalPhase(record.run.phase)) return
    if (record.resultState !== 'pending') return
    const stopReason = acceptanceTerminalReason() ?? normalizeStopReason(result.stopReason)
    record.resultState = 'resolved'
    record.executionEnded = true
    record.run.stopReason = stopReason
    applyOutcome(record, stopReason)
    for (const warning of acceptanceExtraWarnings()) appendWarning(record, warning)
    if (record.candidateEnd === 'error' && stopReason !== 'error') {
      appendWarning(record, { code: 'upstream-end-error', severity: 'error' })
    }
    touch(record)
    publish(record)
  }

  function activityPhase(record: RunRecord, idlePhase: 'reasoning' | 'generating'): void {
    if (record.run.phase === 'stopping') return
    record.run.phase = record.run.activeTools.length > 0 ? 'tool' : idlePhase
  }

  return {
    begin(input) {
      const runId = randomUUID()
      const startedAt = clock()
      revision += 1
      const run: SubagentRunProjection = {
        runId,
        parentSessionId: input.parentSessionId,
        kind: input.kind,
        label: input.label,
        phase: 'starting',
        activeTools: [],
        startedAt,
        cleanupWarnings: [],
        generation,
        revision,
      }
      if (input.packageVersion !== undefined) run.packageVersion = input.packageVersion
      if (input.clientMessageId !== undefined) run.clientMessageId = input.clientMessageId
      const record: RunRecord = {
        run,
        resultState: 'pending',
        executionEnded: false,
        cleanupOk: false,
        stopLatched: false,
        endSeen: false,
        cancelStarted: false,
      }
      records.set(runId, record)
      publish(record)
      return runId
    },

    get(runId) {
      const record = records.get(runId)
      return record === undefined ? undefined : cloneProjection(record.run)
    },

    parentSessionIdOf(runId) {
      return records.get(runId)?.run.parentSessionId
    },

    reserveChild(runId, childId) {
      const record = records.get(runId)
      if (record === undefined) return
      if (!rebindChild(record, childId)) return
      touch(record)
      publish(record)
    },

    bindActivation(runId, input) {
      const record = records.get(runId)
      if (record === undefined) return
      // 活动本体挂在 record 上,重绑定即完成迁移;旧预留 id 的映射被移除。
      if (!rebindChild(record, input.childId)) return
      touch(record)
      publish(record)
    },

    bindUpstreamStart(input) {
      const record = input.hostRunId === undefined ? recordOfChild(input.childId) : records.get(input.hostRunId)
      if (record === undefined) return
      let changed = rebindChild(record, input.childId)
      if (record.run.upstreamRunId !== input.upstreamRunId) {
        record.run.upstreamRunId = input.upstreamRunId
        changed = true
      }
      upstreamIndex.set(input.upstreamRunId, record.run.runId)
      if (!changed) return
      touch(record)
      publish(record)
    },

    ownsChild(childId) {
      return childIndex.has(childId)
    },

    noteReasoning(childId) {
      const record = activeRecordOfChild(childId)
      if (record === undefined) return
      record.run.lastActivity = clock()
      activityPhase(record, 'reasoning')
      touch(record)
      publishCoalesced(record)
    },

    noteToken(childId) {
      const record = activeRecordOfChild(childId)
      if (record === undefined) return
      record.run.lastActivity = clock()
      activityPhase(record, 'generating')
      touch(record)
      publishCoalesced(record)
    },

    startTool(childId, tool) {
      const record = activeRecordOfChild(childId)
      if (record === undefined) return
      const startedAt = clock()
      const activity: SubagentToolActivity = { id: randomUUID(), name: tool.name, startedAt }
      if (tool.callId !== undefined) activity.callId = tool.callId
      record.run.activeTools.push(activity)
      record.run.lastActivity = startedAt
      if (record.run.phase !== 'stopping') record.run.phase = 'tool'
      touch(record)
      publish(record)
    },

    endTool(childId, tool) {
      const record = activeRecordOfChild(childId)
      if (record === undefined) return
      const index = findToolIndex(record.run.activeTools, tool)
      if (index < 0) return
      record.run.activeTools.splice(index, 1)
      record.run.lastActivity = clock()
      if (record.run.activeTools.length === 0 && record.run.phase !== 'stopping') {
        record.run.phase = 'generating'
      }
      touch(record)
      publish(record)
    },

    childIdle(childId) {
      const record = activeRecordOfChild(childId)
      if (record === undefined) return
      if (record.run.phase === 'finalizing' || record.run.phase === 'stopping') return
      record.run.phase = 'finalizing'
      touch(record)
      publish(record)
    },

    noteChildError(childId, message) {
      const record = activeRecordOfChild(childId)
      if (record === undefined) return
      // 只记录清理过的文案,不改相位、不改 lastActivity:工具失败不决定 run 终态。
      const text = sanitizeChildError(message)
      if (text !== undefined) record.childError = text
    },

    settleResult(runId, result) {
      const record = records.get(runId)
      if (record === undefined) return
      if (isTerminalPhase(record.run.phase)) return
      if (record.resultState !== 'pending') return
      const holdMs =
        acceptanceHoldEndMs() > 0
          ? acceptanceHoldEndMs()
          : record.run.phase === 'finalizing'
            ? acceptanceHoldFinalizingMs()
            : 0
      if (holdMs > 0) {
        if (record.pendingResult === undefined) {
          record.pendingResult = result
          setNodeTimeout(() => {
            const current = records.get(runId)
            if (current === undefined || current.pendingResult === undefined) return
            const pending = current.pendingResult
            delete current.pendingResult
            settleResultNow(current, pending)
          }, holdMs)
        }
        return
      }
      settleResultNow(record, result)
    },

    rejectResult(runId, message) {
      const record = records.get(runId)
      if (record === undefined) return
      if (isTerminalPhase(record.run.phase)) return
      if (record.resultState !== 'pending') return
      record.resultState = 'rejected'
      record.executionEnded = true
      record.run.failure = message
      if (record.stopLatched || record.run.phase === 'stopping') {
        // 停止闩/停止路径已存在:只保留 failure 与执行终结事实。
      } else if (record.candidateEnd !== undefined) {
        applyOutcome(record, record.candidateEnd)
      } else if (record.run.upstreamRunId !== undefined) {
        // 已绑定 upstream 但 end 未到:保持非终态,等 end 仲裁。
      } else {
        terminalize(record, 'error')
      }
      settleStopped(record)
      touch(record)
      publish(record)
    },

    settleUpstreamEnd(input) {
      const runId = upstreamIndex.get(input.upstreamRunId)
      if (runId === undefined) return
      const record = records.get(runId)
      if (record === undefined || record.endSeen) return
      record.endSeen = true
      const stopReason = normalizeStopReason(input.stopReason)
      record.candidateEnd = stopReason
      let changed = false
      if (isTerminalPhase(record.run.phase)) {
        // 已发布终态不翻转;只有 resolved result 与 end 的 error 冲突才补告警。
        if (record.resultState === 'resolved' && stopReason === 'error' && record.run.stopReason !== 'error') {
          changed = appendWarning(record, { code: 'upstream-end-error', severity: 'error' })
        }
      } else if (record.resultState === 'resolved') {
        if (stopReason === 'error' && record.run.stopReason !== 'error') {
          changed = appendWarning(record, { code: 'upstream-end-error', severity: 'error' })
        }
      } else if (record.resultState === 'rejected') {
        applyOutcome(record, stopReason)
        changed = true
      }
      // result 仍 pending:候选已保存,保持当前非终态且不写 endedAt。
      changed = settleStopped(record) || changed
      if (!changed) return
      touch(record)
      publish(record)
    },

    failRun(runId, message) {
      const record = records.get(runId)
      if (record === undefined) return
      if (isTerminalPhase(record.run.phase)) return
      let changed =
        record.run.failure !== message ||
        !record.executionEnded ||
        (record.run.phase !== 'stopping' && record.run.phase !== 'failed')
      record.run.failure = message
      record.executionEnded = true
      if (!record.stopLatched && record.run.phase !== 'stopping') {
        if (record.run.stopReason === undefined) record.run.stopReason = 'error'
        record.run.phase = 'failed'
        record.run.endedAt = clock()
      }
      // 停止路径上的启动失败只补「执行已终结」事实:清理已确认时同样收敛为 stopped。
      changed = settleStopped(record) || changed
      if (!changed) return
      touch(record)
      publish(record)
    },

    noteCleanupBudget(runId, budgetMs) {
      const record = records.get(runId)
      if (record === undefined) return
      let changed = record.run.cleanupBudgetMs !== budgetMs
      record.run.cleanupBudgetMs = budgetMs
      if (isTerminalPhase(record.run.phase)) {
        // 执行已终态:收尾超时只追加 info 告警,不回切 stopping。
        changed = appendWarning(record, { code: 'cleanup-budget-exceeded', severity: 'info' }) || changed
      } else {
        enterStopping(record, 'cleanup-budget')
        changed = true
      }
      if (!changed) return
      touch(record)
      publish(record)
    },

    confirmCleanup(runId, input) {
      const record = records.get(runId)
      if (record === undefined) return
      let changed = false
      for (const warning of input.warnings) changed = appendWarning(record, warning) || changed
      // 确认是持久状态:`{ok:true}` 在执行终结前到达也照样保存,`{ok:false}` 只撤销
      // 成功、不得留下成功。成功先到、执行后终结时由统一的终止判定收敛;`cleanupOk`
      // 本身不上 wire,只有告警追加与相位变化才发布。
      record.cleanupOk = input.ok
      changed = settleStopped(record) || changed
      if (!changed) return
      touch(record)
      publish(record)
    },

    attachCancel(runId, cancel) {
      const record = records.get(runId)
      if (record === undefined) return
      if (isTerminalPhase(record.run.phase) || record.cancelStarted) return
      record.cancel = cancel
      // 停止意图先于闭包到达:晚绑定时补启动一次,不重复确认 stopped。
      if (record.stopLatched) startCancel(record)
    },

    async requestCancel(parentSessionId, runId) {
      const record = records.get(runId)
      if (record === undefined || record.run.parentSessionId !== parentSessionId) {
        // 父会话不匹配与不存在同形处理,零副作用,绝不退化为会话级取消。
        throw new SubagentRunNotFoundError()
      }
      if (isTerminalPhase(record.run.phase)) return { status: 'already-terminal', runId }
      if (!record.stopLatched) {
        record.stopLatched = true
        record.run.stopRequestedAt = clock()
        // 正常路径由本次受理进入 stopping 并写入 targeted-cancel;若已因
        // aborted/cleanup-budget 处于 stopping,保留既有原因,不覆盖首个停止来源。
        enterStopping(record, 'targeted-cancel')
        touch(record)
        publish(record)
      }
      // 不 await:取消闭包只表示「已发起」,执行终结与清理确认由执行链分别上报。
      startCancel(record)
      return { status: 'accepted', runId }
    },

    snapshot(parentSessionId) {
      const runs = [...records.values()]
        .filter((record) => record.run.parentSessionId === parentSessionId)
        .map((record) => cloneProjection(record.run))
      // revision 在调用时捕获;快照只读,不刷新 lastActivity,不触发淘汰。
      return { generation, revision, runs }
    },
  }
}
