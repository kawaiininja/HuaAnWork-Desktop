import { randomUUID } from 'node:crypto'

import type {
  ExpertTeam,
  ExpertTeamCancelResult,
  ExpertTeamResult,
  ExpertTeamRun,
  ExpertTeamRunSnapshot,
  RpcEvent,
  TaskArtifactSummary,
} from '../../client-huaanwork/rpc-types.ts'

/**
 * 专家团运行的权威内存注册表（设计 §8.3 / §8.5）。
 *
 * 与 `subagent-runs.ts` 同构：registry 是运行投影的唯一事实源，RPC 投影与
 * React 客户端只读它，所有对外返回的对象都是副本。团队运行不持久化，也不写
 * 磁盘；Host generation 结束后旧快照全部失效。
 *
 * 状态机语义固定，不得被实施者替换：
 *
 * - `running` / `stopping` 是活跃状态，永不因容量淘汰；终态包括 `completed`、
 *   `completed_with_issues`、`partial`、`failed`、`stopped`。
 * - `requestCancel` 只同步闩停并触发取消闭包（最多一次），绝不在 RPC 句柄里等待
 *   清理收敛；`stopping → stopped` 由清理确认点调用 `markStopped` 收敛。
 * - `cancelBySession` / `cancelAll` 等待的是同一个已启动的取消闭包 promise，
 *   幂等且拒绝不冒泡为 unhandled rejection。
 * - 终态历史有界：每父会话默认 20 条、全局默认 100 条，按首次进入终态的顺序淘汰；
 *   淘汰只发布 `expertTeam/run-remove`，不删除会话消息或 Artifact。
 * - 主 Artifact 关联要求「先 seal 后关联」：`sealDelivery` 记录同一 commit 调用，
 *   `noteSessionArtifact` 只接受父会话、回合锚与运行一致的持久摘要。
 */

export type ExpertTeamRunRegistryOptions = {
  /** Host generation；缺省生成随机值，测试可注入。 */
  generation?: string
  now?: () => number
  /** 每个父会话保留的终态运行上限；默认 20，活跃/停止中运行永不裁剪。 */
  terminalPerParent?: number
  /** 全局保留的终态运行上限；默认 100，活跃/停止中运行永不裁剪。 */
  terminalGlobal?: number
  emit(event: RpcEvent): void
}

/** `expertTeam.cancel` 的运行不存在，或 `teamRunId` 不属于请求的父会话。 */
export class ExpertTeamRunNotFoundError extends Error {
  constructor() {
    super('expert team run not found')
    this.name = 'ExpertTeamRunNotFoundError'
  }
}

export interface ExpertTeamRunRegistry {
  begin(input: { parentSessionId: string; clientMessageId: string; teamSnapshot: ExpertTeam }): ExpertTeamRun
  get(teamRunId: string): ExpertTeamRun | undefined
  /** 仅返回当前 parentSessionId 仍处于 running 的唯一活动运行；不含 stopping/终态。 */
  activeBySession(parentSessionId: string): ExpertTeamRun | undefined
  /** 按父会话 + 持久回合锚精确查找未淘汰运行（含 stopping 与终态），供 result_present 与测试对账。 */
  byTurn(parentSessionId: string, clientMessageId: string): ExpertTeamRun | undefined
  list(input?: { sessionId?: string }): ExpertTeamRunSnapshot
  /** 应用一次受控变更：同步增加 registry revision 并发布一条运行事件；未知运行抛 NotFound。 */
  update(teamRunId: string, mutate: (run: ExpertTeamRun) => void): ExpertTeamRun
  /** running 或 stopping 均视为活跃，阻止团队删除或同会话第二次团队调用。 */
  hasActive(teamId: string): boolean
  hasActiveForSession(parentSessionId: string): boolean
  attachCancel(teamRunId: string, cancel: () => Promise<void>): void
  /** 同步置 stopping、触发取消闭包（最多一次）并立即返回，不阻塞 RPC 等待清理；未知/跨会话抛 NotFound。 */
  requestCancel(parentSessionId: string, teamRunId: string): ExpertTeamCancelResult
  /** 同步置 stopping 并触发该会话活跃运行的取消闭包（幂等，不抛未捕获 rejection）。 */
  cancelBySession(parentSessionId: string): Promise<void>
  /** Host teardown 专用：取消全部活跃/stopping 运行并等待其取消闭包收敛。 */
  cancelAll(): Promise<void>
  /** 在父回合与成员清理收敛后把 stopping 推进为 stopped（幂等，不覆盖已终态）。 */
  markStopped(teamRunId: string): ExpertTeamRun | undefined
  sealDelivery(teamRunId: string, callId: string): void
  noteSessionArtifact(parentSessionId: string, callId: string, artifact: TaskArtifactSummary): boolean
  noteArtifactLinkError(teamRunId: string, reason: string): void
}

/** registry 内部记录：停止闩与取消闭包不上 wire。 */
type RunRecord = {
  run: ExpertTeamRun
  /** 停止意图闩：首次 cancel 受理后固定为 true。 */
  stopLatched: boolean
  /** 取消闭包最多启动一次的幂等闩。 */
  cancelStarted: boolean
  /** 执行链绑定的精确取消闭包。 */
  cancel?: () => Promise<void>
  /** 已启动的取消闭包共享 promise；`cancelBySession` / `cancelAll` 只等待它。 */
  cancelPending?: Promise<void>
  /** 终态历史淘汰顺序；首次进入终态时分配，越小越旧。 */
  terminalOrder?: number
}

const DEFAULT_TERMINAL_PER_PARENT = 20
const DEFAULT_TERMINAL_GLOBAL = 100

function isTerminalStatus(status: ExpertTeamRun['status']): boolean {
  return status === 'completed' || status === 'completed_with_issues' || status === 'partial' || status === 'failed' || status === 'stopped'
}

function isActiveStatus(status: ExpertTeamRun['status']): boolean {
  return status === 'running' || status === 'stopping'
}

/** 团队快照深拷贝：成员与各配置段都是副本，调用方改写不影响运行内快照。 */
function cloneTeam(team: ExpertTeam): ExpertTeam {
  return {
    ...team,
    members: team.members.map((member) => {
      const cloned: ExpertTeam['members'][number] = {
        memberId: member.memberId,
        agentRef: { ...member.agentRef },
        role: member.role,
        responsibility: member.responsibility,
      }
      if (member.outputInstructions !== undefined) cloned.outputInstructions = member.outputInstructions
      return cloned
    }),
    orchestration: { ...team.orchestration },
    review: { ...team.review },
    summary: { ...team.summary },
  }
}

function cloneResult(result: ExpertTeamResult): ExpertTeamResult {
  return { ...result, agentRef: { ...result.agentRef }, inputResultIds: [...result.inputResultIds] }
}

/** 外部只拿到副本，避免调用方改写 registry 的权威状态。 */
function cloneRun(run: ExpertTeamRun): ExpertTeamRun {
  return { ...run, teamSnapshot: cloneTeam(run.teamSnapshot), results: run.results.map(cloneResult) }
}

export function createExpertTeamRunRegistry(options: ExpertTeamRunRegistryOptions): ExpertTeamRunRegistry {
  const clock = options.now ?? Date.now
  const terminalPerParent = Math.max(0, options.terminalPerParent ?? DEFAULT_TERMINAL_PER_PARENT)
  const terminalGlobal = Math.max(0, options.terminalGlobal ?? DEFAULT_TERMINAL_GLOBAL)
  const generation = options.generation ?? randomUUID()

  const records = new Map<string, RunRecord>()
  /** revision 全 registry 单调递增：每次状态变化 +1，投影携带最新值。 */
  let revision = 0
  /** 终态进入顺序；只用于有界历史淘汰，不对外发布。 */
  let terminalSequence = 0

  function nowIso(): string {
    return new Date(clock()).toISOString()
  }

  function touch(record: RunRecord): void {
    revision += 1
    record.run.revision = revision
    if (isTerminalStatus(record.run.status) && record.terminalOrder === undefined) {
      terminalSequence += 1
      record.terminalOrder = terminalSequence
    }
  }

  function emitRun(record: RunRecord): void {
    options.emit({ event: 'expertTeam/run', generation, run: cloneRun(record.run) })
  }

  function compareTerminalOrder(left: RunRecord, right: RunRecord): number {
    return (left.terminalOrder ?? 0) - (right.terminalOrder ?? 0)
  }

  /** 从 registry 移除一个已终态运行，并发布带 generation/revision 的移除事件。 */
  function removeRecord(record: RunRecord): void {
    records.delete(record.run.teamRunId)
    options.emit({
      event: 'expertTeam/run-remove',
      generation,
      revision: record.run.revision,
      teamRunId: record.run.teamRunId,
      parentSessionId: record.run.parentSessionId,
    })
  }

  /**
   * 终态历史有界：每父会话默认 20 条、全局默认 100 条。活跃与 `stopping` 永不裁剪；
   * 淘汰按首次进入终态的顺序，并发运行的淘汰顺序不构成契约。
   */
  function pruneTerminalHistory(): void {
    const byParent = new Map<string, RunRecord[]>()
    for (const record of records.values()) {
      if (!isTerminalStatus(record.run.status)) continue
      const list = byParent.get(record.run.parentSessionId)
      if (list === undefined) byParent.set(record.run.parentSessionId, [record])
      else list.push(record)
    }
    for (const list of byParent.values()) {
      if (list.length <= terminalPerParent) continue
      list.sort(compareTerminalOrder)
      for (const record of list.slice(0, list.length - terminalPerParent)) removeRecord(record)
    }

    const terminal = [...records.values()].filter((record) => isTerminalStatus(record.run.status))
    if (terminal.length <= terminalGlobal) return
    terminal.sort(compareTerminalOrder)
    for (const record of terminal.slice(0, terminal.length - terminalGlobal)) removeRecord(record)
  }

  /** 生命周期变化立即发布；终态帧先到达客户端，再淘汰更旧的终态历史。 */
  function publish(record: RunRecord): void {
    emitRun(record)
    pruneTerminalHistory()
  }

  /**
   * 启动该运行的取消闭包，最多一次。闭包 resolve 只表示它自己返回；拒绝被吸收成
   * 已收敛，绝不冒泡为 unhandled rejection。共享 promise 供会话级/全局取消等待。
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
    record.cancelPending = pending.catch(() => undefined)
  }

  /**
   * 同步把运行闩入 `stopping` 并启动取消闭包；`stopped` 由清理确认点单独收敛。
   * @returns 本次调用是否把运行从非 stopping 推进到 stopping（有变更才发布）。
   */
  function latchStopping(record: RunRecord): boolean {
    if (isTerminalStatus(record.run.status)) return false
    record.stopLatched = true
    const changed = record.run.status !== 'stopping'
    if (changed) {
      record.run.status = 'stopping'
      touch(record)
      publish(record)
    }
    startCancel(record)
    return changed
  }

  /**
   * 同步闩停所有匹配的活跃运行，再等待已启动取消闭包收敛。先闩全部再 await，
   * 保证调用返回 promise 前所有运行都已是 `stopping`。
   */
  async function cancelMatching(predicate: (record: RunRecord) => boolean): Promise<void> {
    const pending: Promise<void>[] = []
    for (const record of records.values()) {
      if (!predicate(record)) continue
      if (!isActiveStatus(record.run.status)) continue
      latchStopping(record)
      if (record.cancelPending !== undefined) pending.push(record.cancelPending)
    }
    if (pending.length > 0) await Promise.all(pending)
  }

  return {
    begin(input) {
      revision += 1
      const run: ExpertTeamRun = {
        teamRunId: randomUUID(),
        parentSessionId: input.parentSessionId,
        clientMessageId: input.clientMessageId,
        teamId: input.teamSnapshot.id,
        teamSnapshot: cloneTeam(input.teamSnapshot),
        status: 'running',
        results: [],
        artifactStatus: input.teamSnapshot.summary.delivery === 'artifact' ? 'pending' : 'not-required',
        deliverySealed: false,
        unifiedRevisionRounds: 0,
        dispatchAttempts: 0,
        startedAt: nowIso(),
        revision,
      }
      const record: RunRecord = { run, stopLatched: false, cancelStarted: false }
      records.set(run.teamRunId, record)
      publish(record)
      return cloneRun(run)
    },

    get(teamRunId) {
      const record = records.get(teamRunId)
      return record === undefined ? undefined : cloneRun(record.run)
    },

    activeBySession(parentSessionId) {
      for (const record of records.values()) {
        if (record.run.parentSessionId !== parentSessionId) continue
        if (record.run.status !== 'running') continue
        return cloneRun(record.run)
      }
      return undefined
    },

    byTurn(parentSessionId, clientMessageId) {
      // 同一回合只应有一个运行；倒序遍历优先返回最新登记的那条。
      const all = [...records.values()]
      for (let index = all.length - 1; index >= 0; index -= 1) {
        const record = all[index]
        if (record === undefined) continue
        if (record.run.parentSessionId !== parentSessionId) continue
        if (record.run.clientMessageId !== clientMessageId) continue
        return cloneRun(record.run)
      }
      return undefined
    },

    list(input) {
      const runs: ExpertTeamRun[] = []
      for (const record of records.values()) {
        if (input?.sessionId !== undefined && record.run.parentSessionId !== input.sessionId) continue
        runs.push(cloneRun(record.run))
      }
      // revision 在调用时捕获；快照只读，不触发淘汰。
      return { generation, revision, runs }
    },

    update(teamRunId, mutate) {
      const record = records.get(teamRunId)
      if (record === undefined) throw new ExpertTeamRunNotFoundError()
      mutate(record.run)
      touch(record)
      publish(record)
      return cloneRun(record.run)
    },

    hasActive(teamId) {
      for (const record of records.values()) {
        if (record.run.teamId !== teamId) continue
        if (isActiveStatus(record.run.status)) return true
      }
      return false
    },

    hasActiveForSession(parentSessionId) {
      for (const record of records.values()) {
        if (record.run.parentSessionId !== parentSessionId) continue
        if (isActiveStatus(record.run.status)) return true
      }
      return false
    },

    attachCancel(teamRunId, cancel) {
      const record = records.get(teamRunId)
      if (record === undefined) return
      if (isTerminalStatus(record.run.status) || record.cancelStarted) return
      record.cancel = cancel
      // 停止意图先于闭包到达：晚绑定补启动一次，不重复确认 stopped。
      if (record.stopLatched) startCancel(record)
    },

    requestCancel(parentSessionId, teamRunId) {
      const record = records.get(teamRunId)
      if (record === undefined || record.run.parentSessionId !== parentSessionId) {
        // 父会话不匹配与不存在同形处理，零副作用，绝不退化为会话级取消。
        throw new ExpertTeamRunNotFoundError()
      }
      if (isTerminalStatus(record.run.status)) return { status: 'already-terminal', teamRunId }
      latchStopping(record)
      return { status: 'accepted', teamRunId }
    },

    async cancelBySession(parentSessionId) {
      await cancelMatching((record) => record.run.parentSessionId === parentSessionId)
    },

    async cancelAll() {
      await cancelMatching(() => true)
    },

    markStopped(teamRunId) {
      const record = records.get(teamRunId)
      if (record === undefined) return undefined
      // 幂等：已终态（含 stopped）不被覆盖；running 不在此路径收敛。
      if (record.run.status === 'stopping') {
        record.run.status = 'stopped'
        record.run.endedAt = nowIso()
        touch(record)
        publish(record)
      }
      return cloneRun(record.run)
    },

    sealDelivery(teamRunId, callId) {
      const record = records.get(teamRunId)
      if (record === undefined) return
      // 「首次 commit」封闩：后续 commit 不替换已记录的主报告调用。
      if (record.run.deliverySealed) return
      record.run.primaryArtifactCallId = callId
      record.run.deliverySealed = true
      touch(record)
      publish(record)
    },

    noteSessionArtifact(parentSessionId, callId, artifact) {
      // 只接受本会话的持久回合锚；自动化锚与缺少 clientMessageId 的锚不参与关联。
      if (artifact.anchor.kind !== 'turn') return false
      if (artifact.anchor.clientMessageId === undefined) return false
      if (artifact.sessionId !== parentSessionId) return false
      const all = [...records.values()]
      for (let index = all.length - 1; index >= 0; index -= 1) {
        const record = all[index]
        if (record === undefined) continue
        const run = record.run
        // 扫描含 stopping/stopped：覆盖 commit 与取消竞态；淘汰的运行不再关联。
        if (run.parentSessionId !== parentSessionId) continue
        if (run.primaryArtifactCallId !== callId) continue
        if (run.clientMessageId !== artifact.anchor.clientMessageId) continue
        let changed = false
        if (run.primaryArtifactId !== artifact.artifactId) {
          run.primaryArtifactId = artifact.artifactId
          changed = true
        }
        if (run.artifactStatus !== 'created') {
          run.artifactStatus = 'created'
          changed = true
        }
        // 关联成功覆盖首次关联失败后的同 callId 重放恢复。
        if (run.artifactLinkError !== undefined) {
          delete run.artifactLinkError
          changed = true
        }
        if (changed) {
          touch(record)
          publish(record)
        }
        return true
      }
      return false
    },

    noteArtifactLinkError(teamRunId, reason) {
      const record = records.get(teamRunId)
      if (record === undefined) return
      // 已关联成功的不再标错；同一原因重复记录不产生新 revision。
      if (record.run.artifactStatus === 'created') return
      if (record.run.artifactLinkError === reason) return
      record.run.artifactLinkError = reason
      touch(record)
      publish(record)
    },
  }
}
