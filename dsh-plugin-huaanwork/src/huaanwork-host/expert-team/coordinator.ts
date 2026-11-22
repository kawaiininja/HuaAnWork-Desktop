import { randomUUID } from 'node:crypto'

import type {
  ExpertTeam,
  ExpertTeamAgentRef,
  ExpertTeamMember,
  ExpertTeamResult,
  ExpertTeamRun,
} from '../../client-huaanwork/rpc-types.ts'
import { effectiveTeamMaxParallel } from '../../client-huaanwork/logic/expertTeamsLogic.ts'
import type { AgentPackageDetail } from '../agent-package/types.ts'
import { expertTeamMemberUnavailableReason } from './availability.ts'
import type { TeamMemberDispatchResult } from './dispatch.ts'
import {
  assertReviewScopeCurrent,
  resolveReviewScope,
  validateDispatchRule,
  type ExpertTeamDispatchRuleInput,
} from './orchestration.ts'
import { ExpertTeamRunNotFoundError, type ExpertTeamRunRegistry } from './runs.ts'
import { parseReviewVerdict } from './text-protocol.ts'

/**
 * 专家团运行协调器（设计 §10.2 / §10.3 / §10.4 / §12.2 / §12.3）。
 *
 * 协调器是团队派工的唯一入口，负责：
 * - 团队租约签发/失效：每父会话回合一个租约，`invalidateLease` 同步封死后续派工；
 * - 24 次派工预算：每次到达（无论最终成功、失败或校验拒绝）计一次；
 * - 每 run 与每 member 两个可取消信号量：等待队列不创建成员 run，但计入
 *   `hasInFlight`，出队后重验租约、取消、交付封闭、调度规则、审查 scope 与包实时可用性；
 * - 256 KiB UTF-8 派工输入预算（不含包 persona）；
 * - 在同一个同步 `registry.update` 临界区内校验规则、写入结果并推进
 *   `unifiedRevisionRounds`，保证并行返修不会重复开启同一周期；
 * - 成员失败/停止返回完整结果（保留 `resultId`），取消闭包排空队列并定向取消成员。
 *
 * 协调器不持久化任何状态；运行投影只经 `ExpertTeamRunRegistry` 发布。
 */

/** 每次团队运行最多 24 次 `expert_team_dispatch` 工具调用（含最终失败/拒绝的到达）。 */
export const EXPERT_TEAM_DISPATCH_BUDGET = 24

/** 每次派工输入（task、引用结果、职责、输出要求，不含包 persona）的 UTF-8 上限。 */
export const EXPERT_TEAM_PROMPT_MAX_BYTES = 256 * 1024

/** 单成员取消/整团取消后，成员结果与工具结果共用的停止错误码。 */
export const EXPERT_TEAM_MEMBER_CANCELLED = 'expert-team-member-cancelled'

/** 协调器具名拒绝码；禁止匿名错误字符串。Task 6 规则错误码原样透传。 */
export type ExpertTeamCoordinatorErrorCode =
  | 'expert-team-terminal'
  | 'expert-team-dispatch-context-missing'
  | 'expert-team-dispatch-budget'
  | 'expert-team-prompt-too-large'
  | 'expert-team-review-scope-changed'
  | 'expert-team-member-missing'
  | 'expert-team-member-revoked'
  | 'expert-team-member-broken'
  | 'expert-team-member-disabled'
  | 'expert-team-member-role-mismatch'
  | 'expert-team-review-disabled'
  | 'expert-team-empty-review-scope'
  | 'expert-team-review-scope'
  | 'expert-team-invalid-input-result'
  | 'expert-team-sequential-order'
  | 'expert-team-sequential-reference'
  | 'expert-team-invalid-supersede'
  | 'expert-team-revision-not-requested'
  | 'expert-team-revision-limit'

/** 协调器错误；`code` 是稳定拒绝码，文案保持可读但调用方不得解析。 */
export class ExpertTeamCoordinatorError extends Error {
  readonly code: string

  constructor(code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = 'ExpertTeamCoordinatorError'
    this.code = code
  }
}

/**
 * 团队租约（设计 §10.3 / §12.1）。
 *
 * 按 `parentSessionId + clientMessageId + teamRunId` 签发；`valid` 一旦被
 * `invalidateLease` 置 false 就不再恢复，即使上层摘除附件或刷新 restrict 抛错。
 */
export type ExpertTeamLease = {
  teamRunId: string
  parentSessionId: string
  clientMessageId: string
  valid: boolean
}

/** `expert_team_dispatch` 到达协调器的完整输入；`teamRunId` 由 Host 绑定，模型不可传。 */
export type ExpertTeamDispatchInput = {
  callId: string
  parentSessionId: string
  clientMessageId: string
  memberId: string
  kind: 'execute' | 'review' | 'revision'
  task: string
  inputResultIds?: string[]
  supersedesResultId?: string
}

/** 返回给团长的逻辑结果；失败/停止同样携带 `resultId` 供显式重试。 */
export type ExpertTeamDispatchResult = {
  resultId: string
  memberId: string
  agentSlug: string
  kind: ExpertTeamDispatchInput['kind']
  inputResultIds: string[]
  status: 'completed' | 'failed' | 'stopped'
  output?: string
  reviewVerdict?: 'pass' | 'revise'
  reviewError?: 'invalid-verdict'
  error?: string
}

/** 一次团队成员派工请求；生产适配层把它转成 Task 7 `dispatchTeamMember` 输入。 */
export type ExpertTeamMemberDispatchRequest = {
  callId: string
  teamRunId: string
  parentSessionId: string
  clientMessageId: string
  member: ExpertTeamMember
  pkg: AgentPackageDetail
  prompt: string
  signal: AbortSignal
  onRunCreated: (info: { runId: string }) => void
}

/** Task 7 `dispatchTeamMember` 的调用方契约（类型与结果保持同构）。 */
export type ExpertTeamMemberDispatcher = (
  input: ExpertTeamMemberDispatchRequest,
) => Promise<TeamMemberDispatchResult>

/** 出队时实时解析成员包；`undefined` 表示包不存在，其它不可用原因由可用性规则判定。 */
export type ExpertTeamMemberPackageResolver = (
  agentRef: ExpertTeamAgentRef,
) => AgentPackageDetail | undefined | Promise<AgentPackageDetail | undefined>

export type ExpertTeamCoordinatorOptions = {
  runs: ExpertTeamRunRegistry
  /** 入口与出队都要重新读取的成员包实时状态（enabled/broken/revoked）。 */
  resolveMemberPackage: ExpertTeamMemberPackageResolver
  /** Task 7 团队派发桥；生产由 Host 适配 `AgentPackageHost.dispatchTeamMember`。 */
  dispatchMember: ExpertTeamMemberDispatcher
  /** 定向取消成员 run；生产接 `subagentRuns.requestCancel(parentSessionId, memberRunId)`。 */
  requestMemberCancel?: (parentSessionId: string, memberRunId: string) => unknown
  /** 单成员取消判定；成员 run 已被外部定向停止时把失败收敛为 `stopped`。 */
  isMemberCancelled?: (parentSessionId: string, memberRunId: string) => boolean
  now?: () => number
  newId?: () => string
}

export type ExpertTeamCoordinator = {
  readonly runs: ExpertTeamRunRegistry
  begin(input: { parentSessionId: string; clientMessageId: string; teamSnapshot: ExpertTeam }): ExpertTeamLease
  dispatch(input: ExpertTeamDispatchInput): Promise<ExpertTeamDispatchResult>
  /** 等待队列与已创建但尚未 settle 的成员 run 都算在途。 */
  hasInFlight(teamRunId: string): boolean
  isLeaseValid(teamRunId: string): boolean
  /** 同步失效且绝不抛出；即使上层清理抛错也不得回滚。 */
  invalidateLease(teamRunId: string): void
  /** 等待该运行全部在途派工与成员清理确认；任务结算与 afterIdle 共用。 */
  waitMemberCleanups(teamRunId: string): Promise<void>
  /** 整团取消：排空等待队列、中止在途成员、等待清理并收敛 `stopped`（幂等）。 */
  cancelRun(teamRunId: string): Promise<void>
}

export type ExpertTeamPromptReference = {
  resultId: string
  memberId: string
  output: string
}

export type ExpertTeamPromptInput = {
  member: ExpertTeamMember
  kind: ExpertTeamDispatchInput['kind']
  task: string
  references: readonly ExpertTeamPromptReference[]
}

const REVIEW_VERDICT_INSTRUCTION =
  '审查要求：完成审查后，最后一行必须单独输出 [VERDICT: PASS] 或 [VERDICT: REVISE]。'

/**
 * 渲染派工提示词。只包含任务、成员团内职责与输出要求、Host 解析后的引用结果，
 * 以及审查任务所需的末行结论要求；成员包 `persona` 由 Task 7 独立拼接，不在此计数。
 */
export function renderExpertTeamDispatchPrompt(input: ExpertTeamPromptInput): string {
  const { member, kind, task, references } = input
  const lines: string[] = [
    `专家团成员：${member.memberId}`,
    `成员职责：${member.responsibility}`,
  ]
  if (member.outputInstructions !== undefined) lines.push(`输出要求：${member.outputInstructions}`)
  if (kind === 'review') lines.push(REVIEW_VERDICT_INSTRUCTION)
  lines.push('任务：', task)
  if (references.length > 0) {
    lines.push('已完成的引用结果：')
    for (const reference of references) {
      lines.push(`--- ${reference.resultId}（${reference.memberId}） ---`, reference.output)
    }
  }
  return lines.join('\n')
}

type SemaphoreWaiter = {
  resolve: () => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

type Semaphore = {
  acquire(signal: AbortSignal): Promise<void>
  release(): void
}

type DispatchOperation = {
  controller: AbortController
  started: boolean
  done: Promise<void>
  resolveDone: () => void
}

type RunState = {
  lease: ExpertTeamLease
  runSemaphore: Semaphore
  memberSemaphores: Map<string, Semaphore>
  pending: Set<DispatchOperation>
  cleanupPromises: Set<Promise<void>>
  memberRunIds: Set<string>
  cancelRequested: boolean
}

function terminalError(): ExpertTeamCoordinatorError {
  return new ExpertTeamCoordinatorError('expert-team-terminal')
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Task 7 定向取消以普通 Error 结束（`cancelError()` 文案固定为
 * `智能体「<slug>」的回合已取消`），没有稳定 code 可读；这里按该文案的精确
 * 后缀兜底，revoked/update/remove 等其它取消文案仍按技术失败返回。
 * 生产接线应优先提供 `isMemberCancelled`，此判断只覆盖适配层遗漏。
 */
function isMemberCancelMessage(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('智能体「') && error.message.endsWith('」的回合已取消')
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 可取消信号量：排队等待不占并发位，`release` 直接把槽位交给队首。 */
function createSemaphore(capacity: number): Semaphore {
  let active = 0
  const waiters: SemaphoreWaiter[] = []
  return {
    acquire(signal) {
      if (signal.aborted) return Promise.reject(abortError())
      if (active < capacity) {
        active += 1
        return Promise.resolve()
      }
      return new Promise<void>((resolve, reject) => {
        const waiter: SemaphoreWaiter = { resolve, reject }
        const onAbort = (): void => {
          const index = waiters.indexOf(waiter)
          if (index < 0) return
          waiters.splice(index, 1)
          reject(abortError())
        }
        waiter.signal = signal
        waiter.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
        waiters.push(waiter)
      })
    },
    release() {
      const next = waiters.shift()
      if (next === undefined) {
        active = Math.max(0, active - 1)
        return
      }
      if (next.signal !== undefined && next.onAbort !== undefined) {
        next.signal.removeEventListener('abort', next.onAbort)
      }
      // 槽位直接移交队首，`active` 保持占用。
      next.resolve()
    },
  }
}

function createOperation(): DispatchOperation {
  const controller = new AbortController()
  let resolveDone: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  return { controller, started: false, done, resolveDone }
}

function ruleInputOf(input: ExpertTeamDispatchInput): ExpertTeamDispatchRuleInput {
  const ruleInput: ExpertTeamDispatchRuleInput = {
    memberId: input.memberId,
    kind: input.kind,
    task: input.task,
  }
  if (input.inputResultIds !== undefined) ruleInput.inputResultIds = [...input.inputResultIds]
  if (input.supersedesResultId !== undefined) ruleInput.supersedesResultId = input.supersedesResultId
  return ruleInput
}

function collectReferences(
  run: ExpertTeamRun,
  inputResultIds: readonly string[],
): ExpertTeamPromptReference[] {
  const references: ExpertTeamPromptReference[] = []
  for (const resultId of inputResultIds) {
    const result = run.results.find((item) => item.resultId === resultId)
    if (result === undefined) continue
    references.push({ resultId, memberId: result.memberId, output: result.output ?? '' })
  }
  return references
}

export function createExpertTeamCoordinator(
  options: ExpertTeamCoordinatorOptions,
): ExpertTeamCoordinator {
  const clock = options.now ?? Date.now
  const newId = options.newId ?? (() => randomUUID())
  const leases = new Map<string, ExpertTeamLease>()
  const states = new Map<string, RunState>()
  const cancellationPromises = new Map<string, Promise<void>>()

  function nowIso(): string {
    return new Date(clock()).toISOString()
  }

  /**
   * 终态运行不再需要协调器内部状态；与 registry 的有界终态历史同步淘汰，
   * 防止长驻 Host 按团队调用次数无限增长。活跃/stopping 永不淘汰。
   */
  function pruneState(teamRunId: string): void {
    const run = options.runs.get(teamRunId)
    if (run !== undefined && (run.status === 'running' || run.status === 'stopping')) return
    states.delete(teamRunId)
    leases.delete(teamRunId)
    cancellationPromises.delete(teamRunId)
  }

  function pruneTerminalStates(): void {
    for (const teamRunId of [...states.keys()]) pruneState(teamRunId)
  }

  function requireMember(run: ExpertTeamRun, memberId: string): ExpertTeamMember {
    const member = run.teamSnapshot.members.find((item) => item.memberId === memberId)
    if (member === undefined) throw new ExpertTeamCoordinatorError('expert-team-member-missing')
    return member
  }

  /** 入口与出队共用的包实时可用性判定；不可用按稳定原因拒绝。 */
  async function requirePackage(agentRef: ExpertTeamAgentRef): Promise<AgentPackageDetail> {
    const pkg = await options.resolveMemberPackage(agentRef)
    if (pkg === undefined) throw new ExpertTeamCoordinatorError('expert-team-member-missing')
    const reason = expertTeamMemberUnavailableReason(pkg)
    if (reason !== undefined) throw new ExpertTeamCoordinatorError(reason)
    return pkg
  }

  function renderPrompt(
    run: ExpertTeamRun,
    member: ExpertTeamMember,
    input: ExpertTeamDispatchInput,
    resolvedInputResultIds: readonly string[],
  ): string {
    return renderExpertTeamDispatchPrompt({
      member,
      kind: input.kind,
      task: input.task,
      references: collectReferences(run, resolvedInputResultIds),
    })
  }

  function memberSemaphoreOf(state: RunState, memberId: string): Semaphore {
    let semaphore = state.memberSemaphores.get(memberId)
    if (semaphore === undefined) {
      semaphore = createSemaphore(1)
      state.memberSemaphores.set(memberId, semaphore)
    }
    return semaphore
  }

  /** 只更新本运行的结果副本；运行被淘汰/移除时静默跳过，不影响成员结算。 */
  function writeResult(
    teamRunId: string,
    resultId: string,
    mutate: (result: ExpertTeamResult) => void,
  ): void {
    try {
      options.runs.update(teamRunId, (run) => {
        const result = run.results.find((item) => item.resultId === resultId)
        if (result !== undefined) mutate(result)
      })
    } catch (error) {
      if (!(error instanceof ExpertTeamRunNotFoundError)) throw error
    }
  }

  function requestMemberCancel(parentSessionId: string, memberRunId: string): void {
    const cancel = options.requestMemberCancel
    if (cancel === undefined) return
    try {
      void Promise.resolve(cancel(parentSessionId, memberRunId)).catch(() => undefined)
    } catch {
      // 已终结或未知 member run 不阻断整团取消。
    }
  }

  /**
   * 等待该运行全部在途派工与成员清理确认。派工 promise 本身已包含 Task 7 的
   * `cleanupPromise` 收尾；额外记录返回的 cleanupPromise 覆盖取消竞态的晚到清理。
   */
  async function waitMemberCleanups(teamRunId: string): Promise<void> {
    const state = states.get(teamRunId)
    if (state === undefined) return
    const awaited = new Set<Promise<unknown>>()
    for (;;) {
      const pending: Promise<unknown>[] = []
      for (const operation of state.pending) {
        if (awaited.has(operation.done)) continue
        awaited.add(operation.done)
        pending.push(operation.done)
      }
      for (const cleanup of state.cleanupPromises) {
        if (awaited.has(cleanup)) continue
        awaited.add(cleanup)
        pending.push(cleanup)
      }
      if (pending.length === 0) return
      await Promise.allSettled(pending)
    }
  }

  /** 取消闭包：同步封租约与取消闩，再排空队列、定向取消成员并等待清理。 */
  function performCancel(teamRunId: string): Promise<void> {
    const existing = cancellationPromises.get(teamRunId)
    if (existing !== undefined) return existing
    const cancellation = (async () => {
      const lease = leases.get(teamRunId)
      if (lease !== undefined) lease.valid = false
      const state = states.get(teamRunId)
      if (state !== undefined) state.cancelRequested = true
      const run = options.runs.get(teamRunId)
      const memberRunIds = new Set<string>(state?.memberRunIds ?? [])
      if (run !== undefined) {
        for (const result of run.results) {
          if (result.memberRunId !== undefined) memberRunIds.add(result.memberRunId)
        }
      }
      if (state !== undefined) {
        for (const operation of state.pending) operation.controller.abort()
      }
      if (run !== undefined) {
        for (const memberRunId of memberRunIds) {
          requestMemberCancel(run.parentSessionId, memberRunId)
        }
      }
      await waitMemberCleanups(teamRunId)
      options.runs.markStopped(teamRunId)
      pruneState(teamRunId)
    })().catch(() => undefined)
    cancellationPromises.set(teamRunId, cancellation)
    return cancellation
  }

  return {
    runs: options.runs,

    begin(input) {
      pruneTerminalStates()
      const run = options.runs.begin(input)
      const lease: ExpertTeamLease = {
        teamRunId: run.teamRunId,
        parentSessionId: input.parentSessionId,
        clientMessageId: input.clientMessageId,
        valid: true,
      }
      leases.set(run.teamRunId, lease)
      states.set(run.teamRunId, {
        lease,
        // sequential 的有效执行并发固定为 1，与配置的 maxParallel 无关。
        runSemaphore: createSemaphore(effectiveTeamMaxParallel(run.teamSnapshot)),
        memberSemaphores: new Map(),
        pending: new Set(),
        cleanupPromises: new Set(),
        memberRunIds: new Set(),
        cancelRequested: false,
      })
      options.runs.attachCancel(run.teamRunId, () => performCancel(run.teamRunId))
      return { ...lease }
    },

    async dispatch(input) {
      if (typeof input.callId !== 'string' || input.callId.trim() === '') {
        throw new ExpertTeamCoordinatorError('expert-team-dispatch-context-missing')
      }
      // 到达绑定：parentSession + clientMessage + 有效租约，唯一 running 且未封闭。
      const boundRun = options.runs.byTurn(input.parentSessionId, input.clientMessageId)
      if (boundRun === undefined) throw terminalError()
      const state = states.get(boundRun.teamRunId)
      if (state === undefined || !state.lease.valid) throw terminalError()
      if (
        state.lease.parentSessionId !== input.parentSessionId ||
        state.lease.clientMessageId !== input.clientMessageId
      ) {
        throw terminalError()
      }
      if (boundRun.status !== 'running' || boundRun.deliverySealed) throw terminalError()
      const teamRunId = boundRun.teamRunId

      let attempts: number
      try {
        attempts = options.runs.update(teamRunId, (run) => {
          run.dispatchAttempts += 1
        }).dispatchAttempts
      } catch (error) {
        if (error instanceof ExpertTeamRunNotFoundError) throw terminalError()
        throw error
      }
      if (attempts > EXPERT_TEAM_DISPATCH_BUDGET) {
        throw new ExpertTeamCoordinatorError('expert-team-dispatch-budget')
      }

      const operation = createOperation()
      state.pending.add(operation)
      try {
        // 入口校验：规则、审查 scope、包实时状态、输入字节。
        const arrivalRun = options.runs.get(teamRunId)
        if (arrivalRun === undefined) throw terminalError()
        if (!state.lease.valid) throw terminalError()
        if (arrivalRun.status !== 'running' || arrivalRun.deliverySealed) throw terminalError()
        const rule = validateDispatchRule(arrivalRun, ruleInputOf(input))
        if (!rule.ok) throw new ExpertTeamCoordinatorError(rule.error)
        const scope = resolveReviewScope(arrivalRun, ruleInputOf(input))
        if (!scope.ok) throw new ExpertTeamCoordinatorError(scope.error)
        const member = requireMember(arrivalRun, input.memberId)
        const resolvedInputResultIds = scope.inputResultIds
        await requirePackage(member.agentRef)
        const arrivalPrompt = renderPrompt(arrivalRun, member, input, resolvedInputResultIds)
        if (Buffer.byteLength(arrivalPrompt, 'utf8') > EXPERT_TEAM_PROMPT_MAX_BYTES) {
          throw new ExpertTeamCoordinatorError('expert-team-prompt-too-large')
        }

        try {
          await state.runSemaphore.acquire(operation.controller.signal)
        } catch {
          throw terminalError()
        }
        try {
          const memberSemaphore = memberSemaphoreOf(state, member.memberId)
          try {
            await memberSemaphore.acquire(operation.controller.signal)
          } catch {
            throw terminalError()
          }
          try {
            // ── 出队重验 + 同步提交 ──────────────────────────────────
            // `requirePackage` 是最后一个 await；此后到 `registry.update` 返回前的
            // 规则/scope 重验、结果写入与 `unifiedRevisionRounds` 递增都在同一同步
            // 临界区内完成，并行返修只有首条能开启新周期。
            const signal = operation.controller.signal
            const current = options.runs.get(teamRunId)
            if (current === undefined || current.status !== 'running' || current.deliverySealed) {
              throw terminalError()
            }
            if (!state.lease.valid || state.cancelRequested || signal.aborted) throw terminalError()
            const liveRule = validateDispatchRule(current, ruleInputOf(input))
            if (!liveRule.ok) throw new ExpertTeamCoordinatorError(liveRule.error)
            if (input.kind === 'review') {
              const stale = assertReviewScopeCurrent(current, resolvedInputResultIds)
              if (stale !== undefined) throw new ExpertTeamCoordinatorError(stale)
            }
            const prompt = renderPrompt(current, member, input, resolvedInputResultIds)
            if (Buffer.byteLength(prompt, 'utf8') > EXPERT_TEAM_PROMPT_MAX_BYTES) {
              throw new ExpertTeamCoordinatorError('expert-team-prompt-too-large')
            }
            const pkg = await requirePackage(member.agentRef)

            let resultId: string | undefined
            options.runs.update(teamRunId, (run) => {
              if (run.status !== 'running' || run.deliverySealed) throw terminalError()
              if (!state.lease.valid || state.cancelRequested || signal.aborted) throw terminalError()
              const committedRule = validateDispatchRule(run, ruleInputOf(input))
              if (!committedRule.ok) throw new ExpertTeamCoordinatorError(committedRule.error)
              if (input.kind === 'review') {
                const stale = assertReviewScopeCurrent(run, resolvedInputResultIds)
                if (stale !== undefined) throw new ExpertTeamCoordinatorError(stale)
              }
              const allocated = newId()
              const result: ExpertTeamResult = {
                resultId: allocated,
                dispatchId: input.callId,
                memberId: member.memberId,
                agentRef: { ...member.agentRef },
                packageVersion: pkg.version,
                kind: input.kind,
                inputResultIds: [...resolvedInputResultIds],
                status: 'starting',
                startedAt: nowIso(),
              }
              if (input.supersedesResultId !== undefined) {
                result.supersedesResultId = input.supersedesResultId
              }
              run.results.push(result)
              if (committedRule.opensUnifiedRevisionCycle === true) {
                run.unifiedRevisionRounds += 1
              }
              resultId = allocated
            })
            if (resultId === undefined) throw terminalError()
            const committedResultId = resultId
            operation.started = true

            let memberRunId: string | undefined
            const onRunCreated = (info: { runId: string }): void => {
              memberRunId = info.runId
              state.memberRunIds.add(info.runId)
              writeResult(teamRunId, committedResultId, (result) => {
                result.memberRunId = info.runId
                if (result.status === 'starting') result.status = 'running'
              })
              // 取消与成员创建竞态：成员已存在但取消闸先到，立刻按 memberRunId 定向停止。
              if (signal.aborted || state.cancelRequested) {
                requestMemberCancel(input.parentSessionId, info.runId)
              }
            }

            const baseResult = (status: ExpertTeamDispatchResult['status']): ExpertTeamDispatchResult => ({
              resultId: committedResultId,
              memberId: member.memberId,
              agentSlug: member.agentRef.slug,
              kind: input.kind,
              inputResultIds: [...resolvedInputResultIds],
              status,
            })

            let dispatched: TeamMemberDispatchResult
            try {
              dispatched = await options.dispatchMember({
                callId: input.callId,
                teamRunId,
                parentSessionId: input.parentSessionId,
                clientMessageId: input.clientMessageId,
                member,
                pkg,
                prompt,
                signal,
                onRunCreated,
              })
            } catch (error) {
              const cancelled =
                signal.aborted ||
                state.cancelRequested ||
                isCancellationError(error) ||
                isMemberCancelMessage(error) ||
                (memberRunId !== undefined &&
                  options.isMemberCancelled?.(input.parentSessionId, memberRunId) === true)
              const status: ExpertTeamDispatchResult['status'] = cancelled ? 'stopped' : 'failed'
              const message = cancelled ? EXPERT_TEAM_MEMBER_CANCELLED : errorMessageOf(error)
              writeResult(teamRunId, committedResultId, (result) => {
                result.status = status
                result.endedAt = nowIso()
                result.error = message
              })
              const view = baseResult(status)
              view.error = message
              return view
            }

            state.cleanupPromises.add(dispatched.cleanupPromise)
            const output = dispatched.output
            let status: ExpertTeamDispatchResult['status']
            let message: string | undefined
            if (dispatched.stopReason === 'aborted') {
              status = 'stopped'
              message = EXPERT_TEAM_MEMBER_CANCELLED
            } else if (dispatched.stopReason === 'completed' && output.ok) {
              status = 'completed'
            } else {
              status = 'failed'
              if (dispatched.diagnostic !== undefined) message = dispatched.diagnostic
              else if (!output.ok) message = output.error
              else message = `成员停止原因：${dispatched.stopReason}`
            }
            let reviewVerdict: 'pass' | 'revise' | undefined
            let reviewError: 'invalid-verdict' | undefined
            if (status === 'completed' && output.ok && input.kind === 'review') {
              const verdict = parseReviewVerdict(output.text)
              if (verdict.reviewVerdict !== undefined) reviewVerdict = verdict.reviewVerdict
              if (verdict.reviewError !== undefined) reviewError = verdict.reviewError
            }
            writeResult(teamRunId, committedResultId, (result) => {
              result.status = status
              result.endedAt = nowIso()
              if (output.ok) result.output = output.text
              if (reviewVerdict !== undefined) result.reviewVerdict = reviewVerdict
              if (reviewError !== undefined) result.reviewError = reviewError
              if (message !== undefined) result.error = message
            })
            const view = baseResult(status)
            if (status === 'completed' && output.ok) view.output = output.text
            if (reviewVerdict !== undefined) view.reviewVerdict = reviewVerdict
            if (reviewError !== undefined) view.reviewError = reviewError
            if (message !== undefined) view.error = message
            return view
          } finally {
            memberSemaphore.release()
          }
        } finally {
          state.runSemaphore.release()
        }
      } finally {
        state.pending.delete(operation)
        operation.resolveDone()
      }
    },

    hasInFlight(teamRunId) {
      const state = states.get(teamRunId)
      return state !== undefined && state.pending.size > 0
    },

    isLeaseValid(teamRunId) {
      const lease = leases.get(teamRunId)
      if (lease === undefined || !lease.valid) return false
      return options.runs.get(teamRunId) !== undefined
    },

    invalidateLease(teamRunId) {
      try {
        const lease = leases.get(teamRunId)
        if (lease !== undefined) lease.valid = false
        const state = states.get(teamRunId)
        if (state === undefined) return
        for (const operation of state.pending) {
          // 已启动的成员由 `cancelRun`/运行级取消负责；租约失效只拒绝未启动派工。
          if (!operation.started) operation.controller.abort()
        }
      } catch {
        // 规格 §10.3：租约失效绝不被上层清理异常回滚，也不向调用方抛出。
      }
    },

    waitMemberCleanups(teamRunId) {
      return waitMemberCleanups(teamRunId)
    },

    async cancelRun(teamRunId) {
      const run = options.runs.get(teamRunId)
      if (run === undefined) return
      if (run.status === 'running') {
        try {
          options.runs.requestCancel(run.parentSessionId, teamRunId)
        } catch {
          // 终态竞态：状态闩已收敛，仍执行剩余清理。
        }
      }
      await performCancel(teamRunId)
    },
  }
}
