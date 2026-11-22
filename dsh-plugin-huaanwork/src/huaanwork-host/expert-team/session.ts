import { randomUUID } from 'node:crypto'

import type { ExpertTeam } from '../../client-huaanwork/rpc-types.ts'
import { detachAgentTools } from '../../huaanwork-guardrails/agent-attachments.ts'
import { EXPERT_TEAM_DISPATCH_TOOL } from '../../huaanwork-guardrails/expert-team-dispatch.ts'
import { refreshAgentRestrict } from '../../huaanwork-guardrails/present-as.ts'
import { getAgentPackageHost } from '../agent-package/creation.ts'
import type { RouteContext } from '../routes.ts'
import type { SessionRuntimeContext } from '../sessions.ts'
import { resolveExpertTeamAvailability } from './availability.ts'
import type { ExpertTeamCoordinator } from './coordinator.ts'
import {
  bindExpertTeamObserver,
  createExpertTeamTurnObserver,
  type ExpertTeamTurnEndFacts,
  type ExpertTeamTurnObserver,
} from './observer.ts'
import { computeExpertTeamTerminalStatus, currentEffectiveResultIds } from './orchestration.ts'
import type { ExpertTeamRunRegistry } from './runs.ts'
import type { ExpertTeamStore } from './types.ts'

/**
 * 专家团回合的会话启动与 `turn/end` 结算(设计 §11.3 / §12.1 / §12.4.2 / §13.3 / §17)。
 *
 * 本模块把「一次 typed 团队发送」接到唯一回合调度链路上:
 * - `dispatchExpertTeam` 在 `agent.followup` 之前校验并重验团队、创建运行与租约、
 *   绑定回合事件观察器,并组装团长提示词;它**不登记回合锚**(锚由 `sendToAgent`
 *   用同一个 `followupId` 登记),也不把 typed token 回退成同名智能体;
 * - 返回的 `afterIdle` 承担成员清理确认与缺失 `turn/end` 的 fail-closed 兜底,
 *   回合名额只在它完成并让出后交给下一条排队消息;
 * - `abortBeforeSend` 覆盖 `followup` 受理前的任何失败:原地置 `failed`、失效租约、
 *   摘除附件并释放观察器,防止 `finally` 里的 idle 清理二次结算;
 * - `settleExpertTeamTurn` 是当前团队 turn 的同步结算点:先失效租约,再独立摘附件/
 *   刷新 restrict,最后写终态。整个函数绝不向 `session/event` 监听器抛出,因为上游
 *   `invokeContainedSessionObservers` 只 `warn` 收容监听器异常,运行不能因此滞留
 *   `running`。
 */

/** `dispatchExpertTeam` 的启动输入;`followupId` 与 run/anchor/followup 共用同一值。 */
export type DispatchExpertTeamInput = {
  /** Host 运行态 holder;需要团队存储、运行注册表、协调器、附件表与 `ctx.on`。 */
  ctx: SessionRuntimeContext
  sessionId: string
  /** 本轮 `resolveFollowupClientMessageId(params)` 的唯一结果。 */
  followupId: string
  /** 客户端缓存里的团队调用名(`at.name`);Host 只把它当查询键,不信任其状态。 */
  slug: string
  /** 用户任务正文(已剥离 `@team:<slug>` token)。 */
  task: string
  logger?: RouteContext['logger']
}

/** 团队回合的发送结果;字段与 `dispatchAt` 的同名结果保持调用方对称。 */
export type ExpertTeamSessionStart = {
  /** 交给父会话的团长提示词。 */
  text: string
  /** 回合清理兜底与名额延迟释放;成功与失败路径共用同一个幂等调用。 */
  afterIdle: () => Promise<void>
  /** 团队分支跳过 `cleanup` 的第二次 `whenIdle()`,避免被后续 goal turn 拖住。 */
  skipPostCleanupIdle: true
  /** `followup` 未被受理时原地失败;可以重复调用。 */
  abortBeforeSend: (error: unknown) => void
}

/** `settleExpertTeamTurn` 的输入;`facts === undefined` 表示观察器从未观察到 `turn/end`。 */
export type SettleExpertTeamTurnInput = {
  ctx: SessionRuntimeContext
  sessionId: string
  teamRunId: string
  facts: ExpertTeamTurnEndFacts | undefined
  logger?: RouteContext['logger']
}

const TEAM_TOKEN_RE = /^@team:([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/

/**
 * 本轮团队任务正文。
 *
 * 客户端会把 `@team:<slug>` token 留在正文开头;发送参数也显式携带 `at.kind/
 * at.name`。这里剥离 token 只影响任务正文与空任务判定,不参与团队身份判断(身份
 * 只来自 `at`)。
 *
 * @param text - 用户发送的完整正文
 * @returns 去掉团队 token 后的任务正文(已去首尾空白)
 */
export function expertTeamTaskText(text: string): string {
  const trimmed = text.trim()
  const match = TEAM_TOKEN_RE.exec(trimmed)
  if (match === null) return trimmed
  return (match[2] ?? '').trim()
}

/**
 * 本次 `session.send` 顶层携带的持久回合锚(`clientMessageId`,客户端 UUID 或自动化 runId)。
 *
 * 与 `at.clientMessageId` 分开解析:顶层值是回合锚的唯一来源,后者只是旧 @ 卡的
 * 本地展示兼容值。
 *
 * @param params - 原始 `session.send` 参数
 * @returns 去空白后的顶层 `clientMessageId`;缺失或空串时返回 undefined
 */
export function objectTopLevelClientMessageId(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined
  const clientMessageId = (params as Record<string, unknown>).clientMessageId
  if (typeof clientMessageId !== 'string') return undefined
  const trimmed = clientMessageId.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * 本轮 followup 的稳定消息 id:顶层 `clientMessageId` 优先,缺失时由 Host 生成 UUID。
 *
 * **不读 `at.clientMessageId` 兜底**:那个值是客户端 `allocId()` 分配的本地条目 id,
 * 刷新历史后会重复,不能作为持久回合锚。普通回合、团队运行、turn anchor 与 followup
 * 共用本函数的**单次**结果,不得分别计算(设计 §11.3 / §17)。
 *
 * @param params - 原始 `session.send` 参数
 * @returns 本轮唯一且稳定的 followup 消息 id
 */
export function resolveFollowupClientMessageId(params: unknown): string {
  return objectTopLevelClientMessageId(params) ?? randomUUID()
}

function teamError(code: string, detail?: string): Error {
  return new Error(detail === undefined ? code : `${code}: ${detail}`)
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 团长提示词:任务、成员名册与职责、结构化调度规则、审查标记和交付模式。
 *
 * Artifact 模式指示团长最终调用 `result_present`;仅会话模式明确禁止该工具并要求
 * 直接输出最终汇总。不包含团队只读/写入配置,也不改变成员包原生工具边界。
 *
 * @param team - 本轮运行使用的团队快照
 * @param task - 去掉 typed token 后的用户任务
 * @returns 注入父会话的团队回合提示词
 */
export function renderExpertTeamLeaderPrompt(team: ExpertTeam, task: string): string {
  const { orchestration, review, summary } = team
  const lines: string[] = [
    '你正在以专家团团长身份处理本轮任务。',
    `专家团：${team.name}（@team:${team.slug}）`,
    '',
    '用户任务：',
    task,
    '',
    '成员名册：',
  ]
  for (const member of team.members) {
    const role = member.role === 'executor' ? '执行' : '审查'
    lines.push(`- ${member.memberId}｜${role}｜@${member.agentRef.slug}：${member.responsibility}`)
    if (member.outputInstructions !== undefined) lines.push(`  输出要求：${member.outputInstructions}`)
  }
  lines.push('', '派工规则：')
  lines.push('- 只能使用 expert_team_dispatch 派工，一次只派一名名册内成员。')
  lines.push('- kind 取 execute（执行）、review（审查）或 revision（返修）；revision 必须携带 supersedesResultId。')
  lines.push('- inputResultIds 只填已完成成员结果的 resultId；引用正文由 Host 渲染。')
  lines.push('- 成员失败或停止时如实披露，不要伪造结果或自行追加未派工成员的结论。')
  lines.push('', '调度规则：')
  const assignment =
    orchestration.assignmentMode === 'broadcast' ? 'broadcast（每位执行成员都必须派工）' : '按职责分配'
  lines.push(`- 分配方式：${assignment}`)
  lines.push(`- 执行顺序：${orchestration.executionOrder}`)
  lines.push(`- 最大并行：${orchestration.maxParallel}`)
  if (orchestration.instructions !== undefined) lines.push(`- 补充说明：${orchestration.instructions}`)
  if (review.mode === 'none') {
    lines.push('- 审查：本轮不设审查环节')
  } else {
    const reviewMode = review.mode === 'unified' ? '统一审查（审查当前全部有效结果）' : '逐结果审查'
    lines.push(`- 审查方式：${reviewMode}，返修上限 ${review.maxRevisionRounds} 轮`)
    if (review.criteria !== undefined) lines.push(`- 审查标准：${review.criteria}`)
    lines.push('- 审查成员的最后一行必须单独输出 [VERDICT: PASS] 或 [VERDICT: REVISE]。')
  }
  lines.push('', '交付要求：')
  if (summary.delivery === 'artifact') {
    lines.push(
      `- 交付方式：Artifact（${summary.artifactFormat}）。完成派工与审查后，最终必须调用 result_present 提交主报告。`,
      `- 汇总方式：${summary.mode}。提交主报告后不得再派工。`,
    )
  } else {
    lines.push(
      '- 交付方式：仅会话消息。禁止调用 result_present。',
      `- 汇总方式：${summary.mode}。完成派工与审查后，直接输出非空的最终汇总文本。`,
    )
  }
  if (summary.instructions !== undefined) lines.push(`- 汇总重点：${summary.instructions}`)
  return lines.join('\n')
}

/** 从当前 profile 定义中按 slug 取回一个可调用团队;缺失/损坏/停用/成员失效都 fail-closed。 */
async function loadInvocableTeam(store: ExpertTeamStore | undefined, slug: string): Promise<ExpertTeam> {
  if (store === undefined) throw teamError('expert-team-store-missing')
  const host = getAgentPackageHost()
  if (host === undefined) throw teamError('expert-team-package-host-missing')
  const records = await store.list()
  const record = records.find((item) => item.team?.slug === slug)
  if (record?.team === undefined) throw teamError('expert-team-not-found', slug)
  const { packages } = await host.listWithLegacy()
  const availability = resolveExpertTeamAvailability(record, packages)
  if (!availability.invocable) {
    const code = availability.reasons[0] ?? `expert-team-${availability.kind}`
    throw teamError(code, slug)
  }
  return record.team
}

/**
 * 摘除 `expert_team_dispatch` 附件并同步刷新 restrict;失败只回报稳定协议错误码。
 *
 * @returns 成功时 undefined;抛错时返回 `expert-team-attachment-detach-failed`
 */
function detachTeamDispatch(ctx: SessionRuntimeContext, sessionId: string): string | undefined {
  try {
    if (ctx.huaanworkAttachments !== undefined) {
      detachAgentTools(ctx.huaanworkAttachments, sessionId, [EXPERT_TEAM_DISPATCH_TOOL])
    }
    refreshAgentRestrict(ctx as never, sessionId)
    return undefined
  } catch {
    return 'expert-team-attachment-detach-failed'
  }
}

/** 结算写入的稳定失败事实;事件缺失、附件摘除失败与异常 turn 结束都不得折叠成成功。 */
function settlementFailure(reasons: readonly string[]): string | undefined {
  return reasons.length === 0 ? undefined : reasons.join('; ')
}

/**
 * 当前团队 turn 的同步结算(设计 §12.4.2)。
 *
 * 顺序固定且 fail-closed:
 * 1. 无条件同步 `invalidateLease`(绝不抛出,先封死后续派工);
 * 2. 独立 `try/catch` 摘除团队附件并刷新 restrict,失败记录
 *    `expert-team-attachment-detach-failed` 而不回滚租约;
 * 3. 封闭派工并写终态:取消/abort 只同步闩 `stopping`,由 `afterIdle` 等待成员清理后
 *    `markStopped`;其它路径用 Task 6 纯函数写一次终态。外层兜底保证结算计算自身
 *    异常时仍落地 `partial`/`failed`,运行不会滞留 `running`。
 *
 * 迟到派工由失效租约与终态共同拒绝;本函数**不**写 `deliverySealed`(它是 Artifact
 * 交付闩,不能代替回合终态)。重复调用幂等:已终态运行不再改写、不再发布 revision。
 *
 * @param input - 会话、运行与观察事实;`facts === undefined` 表示本轮缺失 `turn/end`
 */
export function settleExpertTeamTurn(input: SettleExpertTeamTurnInput): void {
  const { ctx, sessionId, teamRunId, facts } = input
  const runs = ctx.huaanworkExpertTeamRuns
  const coordinator = ctx.huaanworkExpertTeamCoordinator
  // ① 同步封死派工:租约失效绝不抛出,也绝不因后续清理失败被回滚。
  try {
    coordinator?.invalidateLease(teamRunId)
  } catch (error) {
    input.logger?.(`expert-team: invalidateLease failed (${teamRunId}):${errorMessageOf(error)}`)
  }
  // ② 独立失败域:摘附件与 restrict 刷新失败只记录协议错误。
  const detachError = detachTeamDispatch(ctx, sessionId)
  try {
    if (runs === undefined) return
    const run = runs.get(teamRunId)
    if (run === undefined) return
    const eventMissing = facts?.eventMissing === true
    const cancelLatched = facts?.reason?.kind === 'aborted' || run.status === 'stopping'
    if (cancelLatched) {
      // 取消路径:同步闩 stopping(幂等),终态由 afterIdle 等待成员清理后发布 stopped。
      if (run.status === 'running') {
        try {
          runs.requestCancel(sessionId, teamRunId)
        } catch (error) {
          input.logger?.(`expert-team: requestCancel failed (${teamRunId}):${errorMessageOf(error)}`)
        }
      }
      return
    }
    // 已终态(abortBeforeSend / 重复结算)不再改写,避免 revision 抖动。
    if (run.status !== 'running') return
    // 事件缺失本身是协议错误:即使已有有效结果与助手文本,也只能 partial/failed。
    const reasons: string[] = []
    let protocolError: string | undefined
    const addProtocolError = (code: string | undefined): void => {
      if (code === undefined) return
      reasons.push(code)
      protocolError ??= code
    }
    if (eventMissing) addProtocolError('expert-team-turn-end-missing')
    addProtocolError(detachError)
    if (facts?.reason !== undefined && facts.reason.kind !== 'completed') {
      addProtocolError(`expert-team-turn-${facts.reason.kind}`)
    }
    let status: 'completed' | 'completed_with_issues' | 'partial' | 'failed'
    try {
      status = computeExpertTeamTerminalStatus({
        run,
        finalSummaryPresent: facts?.finalSummaryPresent === true,
        ...(protocolError === undefined ? {} : { protocolError }),
      })
    } catch (error) {
      input.logger?.(`expert-team: terminal computation failed (${teamRunId}):${errorMessageOf(error)}`)
      status = currentEffectiveResultIds(run).length > 0 ? 'partial' : 'failed'
    }
    const failure = settlementFailure(reasons)
    runs.update(teamRunId, (live) => {
      if (live.status !== 'running') return
      live.status = status
      live.endedAt = new Date().toISOString()
      if (failure !== undefined) live.failure = failure
    })
  } catch (error) {
    // ③ 外层兜底:结算本身异常也必须写终态,绝不让运行滞留 running。
    try {
      if (runs === undefined) return
      const run = runs.get(teamRunId)
      if (run === undefined || run.status !== 'running') return
      const fallback = currentEffectiveResultIds(run).length > 0 ? 'partial' : 'failed'
      runs.update(teamRunId, (live) => {
        if (live.status !== 'running') return
        live.status = fallback
        live.endedAt = new Date().toISOString()
        live.failure = `expert-team-settle-failed: ${errorMessageOf(error)}`
      })
    } catch (fallbackError) {
      // 运行已被淘汰或终态历史裁剪:租约已失效,迟到派工仍被拒绝。
      input.logger?.(`expert-team: fallback settlement failed (${teamRunId}):${errorMessageOf(fallbackError)}`)
    }
  }
}

/** `followup` 受理前失败:原地置 failed,并清掉观察器/附件,绝不留 running 或待结算。 */
function markRunFailedBeforeSend(
  runs: ExpertTeamRunRegistry,
  teamRunId: string,
  error: unknown,
): void {
  if (runs.get(teamRunId) === undefined) return
  const detail = error === undefined ? '' : errorMessageOf(error).trim()
  const failure =
    detail === '' ? 'expert-team-followup-not-accepted' : `expert-team-followup-not-accepted: ${detail}`
  try {
    runs.update(teamRunId, (run) => {
      if (run.status !== 'running' && run.status !== 'stopping') return
      run.status = 'failed'
      run.endedAt = new Date().toISOString()
      run.failure = failure
    })
  } catch {
    // 运行已淘汰/已终态:租约失效仍是本路径的派工封闭保证。
  }
}

/**
 * 启动一次团队回合:重验团队 → 创建运行/租约 → 绑定观察器 → 组装团长提示词。
 *
 * 必须在 `agent.followup` 之前调用,运行才能在 claim 时被识别;`afterIdle` 同时
 * 承担「缺失 turn/end 的 fail-closed 结算 + 成员清理确认 + observer 释放」。
 * 任何启动期异常都由本函数自行清理(不把 running 运行留给 `sendToAgent` 的 finally)。
 *
 * @param input - 会话、唯一 followup id、团队 slug 与任务正文
 * @returns 父会话提示词、`afterIdle`、`skipPostCleanupIdle` 与 `abortBeforeSend`
 */
export async function dispatchExpertTeam(input: DispatchExpertTeamInput): Promise<ExpertTeamSessionStart> {
  const { ctx, sessionId, followupId, slug } = input
  const task = input.task.trim()
  if (task === '') throw teamError('expert-team-task-empty', slug)
  const runs = ctx.huaanworkExpertTeamRuns
  const coordinator: ExpertTeamCoordinator | undefined = ctx.huaanworkExpertTeamCoordinator
  if (runs === undefined) throw teamError('expert-team-runs-missing')
  if (coordinator === undefined) throw teamError('expert-team-coordinator-missing')
  const team = await loadInvocableTeam(ctx.huaanworkExpertTeamStore, slug)
  // 出队/启动前再验一次:活跃(running/stopping)团队绝不并发启动第二个。放在异步读取
  // 之后、begin 之前,与协调器 begin 的同步守卫共同覆盖准入跨 await 的竞态。
  if (runs.hasActiveForSession(sessionId)) throw teamError('expert-team-session-busy', slug)

  const lease = coordinator.begin({
    parentSessionId: sessionId,
    clientMessageId: followupId,
    teamSnapshot: team,
  })
  const teamRunId = lease.teamRunId

  let observer: ExpertTeamTurnObserver | undefined
  let aborted = false
  let afterIdlePromise: Promise<void> | undefined

  const abortBeforeSend = (error: unknown): void => {
    if (aborted) return
    aborted = true
    try {
      coordinator.invalidateLease(teamRunId)
    } catch (leaseError) {
      input.logger?.(`expert-team: invalidateLease failed (${teamRunId}):${errorMessageOf(leaseError)}`)
    }
    markRunFailedBeforeSend(runs, teamRunId, error)
    detachTeamDispatch(ctx, sessionId)
    try {
      observer?.dispose()
    } catch (disposeError) {
      input.logger?.(`expert-team: observer dispose failed (${teamRunId}):${errorMessageOf(disposeError)}`)
    }
  }

  /** `afterIdle`:缺失 turn/end 兜底、观察器释放、取消路径等待成员清理并收敛 stopped。 */
  const finalizeAfterIdle = async (): Promise<void> => {
    try {
      observer?.afterIdle()
      if (observer?.turnEndFacts() === undefined) {
        settleExpertTeamTurn({
          ctx,
          sessionId,
          teamRunId,
          facts: undefined,
          ...(input.logger === undefined ? {} : { logger: input.logger }),
        })
      }
    } catch (error) {
      input.logger?.(`expert-team: afterIdle settlement failed (${teamRunId}):${errorMessageOf(error)}`)
    }
    try {
      observer?.dispose()
    } catch (error) {
      input.logger?.(`expert-team: observer dispose failed (${teamRunId}):${errorMessageOf(error)}`)
    }
    const run = runs.get(teamRunId)
    if (run?.status !== 'stopping') return
    try {
      await coordinator.waitMemberCleanups(teamRunId)
    } catch (error) {
      input.logger?.(`expert-team: member cleanup wait failed (${teamRunId}):${errorMessageOf(error)}`)
    }
    try {
      runs.markStopped(teamRunId)
    } catch (error) {
      input.logger?.(`expert-team: markStopped failed (${teamRunId}):${errorMessageOf(error)}`)
    }
  }

  try {
    observer = createExpertTeamTurnObserver({
      parentSessionId: sessionId,
      followupId,
      onTurnEnd: (facts) => {
        settleExpertTeamTurn({
          ctx,
          sessionId,
          teamRunId,
          facts,
          ...(input.logger === undefined ? {} : { logger: input.logger }),
        })
      },
    })
    bindExpertTeamObserver(ctx, observer)
  } catch (error) {
    abortBeforeSend(error)
    throw error
  }

  const afterIdle = (): Promise<void> => {
    afterIdlePromise ??= finalizeAfterIdle().catch((error: unknown) => {
      input.logger?.(`expert-team: afterIdle cleanup failed (${teamRunId}):${errorMessageOf(error)}`)
    })
    return afterIdlePromise
  }

  return {
    text: renderExpertTeamLeaderPrompt(team, task),
    afterIdle,
    skipPostCleanupIdle: true,
    abortBeforeSend,
  }
}
