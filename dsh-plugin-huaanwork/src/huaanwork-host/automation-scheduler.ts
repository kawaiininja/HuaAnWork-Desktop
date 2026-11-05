import { randomUUID } from 'node:crypto'

import type { AutomationInfo, RpcEvent } from '../client-huaanwork/rpc-types.ts'
import { automationRunSessionId } from './automation-session-ids.ts'
import {
  advanceNextRunAt,
  appendRun,
  dueAutomations,
  expiredAutomations,
  markAutomation,
  MISSED_GRACE_MS,
  missedAutomations,
  updateAutomation,
} from './automations-store.ts'
import {
  automationAdmissionRoot,
  boundAutomationRuntime,
  bindAutomationRuntime,
  enqueueAutomation,
  type AutomationRuntime,
} from './automations-host.ts'
import type { RouteContext } from './routes.ts'
import { listAutomations } from './stores.ts'
import type { TurnScheduler } from './turn-scheduler.ts'

/**
 * 进程内自动化调度器(旧 scheduler.ts 的 unref ticker + host.ts tick 状态机)。
 *
 * 每条到期项单独做一次 `admitAutomation`:根忙或名额满就跳过,不落 missed、
 * 不推进、不停用,留给后续 tick 或 releaseAndDrain 触发的评估重试。
 * 执行体只执行已经占坑的运行,调度器不再按组串行,也不再要求前台 agent 空闲。
 */

/**
 * test-only:单测注入毫秒级 tick。缺省 60s。
 * `HUAANWORK_AUTOMATION_TICK_MS=0` 是 disabled 语义(verify 脚本关闭调度器用),不是另一条测试缝。
 */
function tickIntervalMs(): number {
  return Number(process.env.HUAANWORK_AUTOMATION_TICK_MS ?? 60_000)
}

function emitAutomation(ctx: AutomationRuntime, routeCtx: RouteContext, event: RpcEvent): void {
  // bind 之后两者是同一个函数,只发一次。分叉时走容器上的 emit,避免双播。
  if (ctx.huaanworkEmit && ctx.huaanworkEmit !== routeCtx.emit) {
    ctx.huaanworkEmit(event)
    return
  }
  routeCtx.emit(event)
}

function logEnqueueFailure(error: unknown): void {
  console.error('automation scheduler enqueue failed:', error)
}

type Candidate = {
  automation: AutomationInfo
  trigger: 'schedule' | 'catchup'
  /** catchup 的合并次数与准入成功后要推进的下一档。 */
  coalescedCount?: number
  nextRunAt?: number
}

/** 一次评估链:释放触发的评估排在正在进行的扫描之后,不丢这一次重试机会。 */
let evaluationTail: Promise<void> = Promise.resolve()

/**
 * 单次到期评估(规格 §5.5)。Task 6 的 `releaseAndDrain` 在用户队列出完后调用一次,
 * tick 复用同一段:列出到期项 → 每条准入一次 → 成功才启动执行体。
 */
export async function evaluateDueAutomations(now = Date.now()): Promise<void> {
  const binding = boundAutomationRuntime()
  if (!binding) return
  try {
    await evaluateWith(binding.ctx, binding.routeCtx, now)
  } catch (error: unknown) {
    binding.routeCtx.logger(
      `automation evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function evaluateWith(ctx: AutomationRuntime, routeCtx: RouteContext, now: number): Promise<void> {
  const scheduler = ctx.huaanworkTurnScheduler
  if (!scheduler) {
    routeCtx.logger('automation evaluation skipped: turn scheduler is not initialized')
    return Promise.resolve()
  }
  const run = evaluationTail.then(() => admitDueAutomations(ctx, routeCtx, scheduler, now))
  evaluationTail = run.catch(() => undefined)
  return run
}

async function admitDueAutomations(
  ctx: AutomationRuntime,
  routeCtx: RouteContext,
  scheduler: TurnScheduler,
  now: number,
): Promise<void> {
  const list = await listAutomations(routeCtx.profileDir)
  const expired = expiredAutomations(list, now)
  for (const automation of expired) {
    // 过期停用与「被禁用」同口径:清掉上一次准入留下的跳过标记。
    scheduler.clearAdmissionSkip(automation.id)
    await updateAutomation(routeCtx.profileDir, automation.id, { enabled: false })
  }
  const expiredIds = new Set(expired.map((item) => item.id))
  const activeList = expired.length > 0 ? list.filter((item) => !expiredIds.has(item.id)) : list
  const candidates = new Map<string, Candidate>()

  for (const item of missedAutomations(activeList, now)) {
    const { automation, nextRunAt, disable, policy, coalescedCount } = item
    if (scheduler.isAdmissionSkipped(automation.id)) {
      // 跳过中的项不落 missed、不停用、不推进;run-once 仍留在待准入列表里。
      if (policy === 'run-once' && !disable && nextRunAt !== undefined) {
        candidates.set(automation.id, { automation, trigger: 'catchup', coalescedCount, nextRunAt })
      }
      continue
    }
    if (policy === 'run-once' && !disable && nextRunAt !== undefined) {
      // 补跑与到期项走同一次准入:成功前不广播、不推进、不执行。
      candidates.set(automation.id, { automation, trigger: 'catchup', coalescedCount, nextRunAt })
      continue
    }
    // 错过记录与根无关。skip / once 自停照常写 runs。
    emitAutomation(ctx, routeCtx, {
      event: 'automation/missed',
      automationId: automation.id,
      projectId: automation.projectId,
      coalescedCount,
      missedAt: now,
    })
    await appendRun(routeCtx.profileDir, automation.id, {
      runId: randomUUID(),
      startedAt: now,
      endedAt: now,
      ok: false,
      output: disable
        ? '一次性任务错过触发时间（超过宽限），任务已自动停用'
        : `错过宽限（超过 ${MISSED_GRACE_MS / 60_000} 分钟），已跳过`,
      status: 'missed',
      trigger: 'schedule',
      coalescedCount,
      durationMs: 0,
    })
    if (disable) {
      await updateAutomation(routeCtx.profileDir, automation.id, { enabled: false })
    } else if (nextRunAt !== undefined) {
      await advanceNextRunAt(routeCtx.profileDir, automation.id, nextRunAt)
    }
  }

  for (const automation of dueAutomations(activeList, now)) {
    if (!candidates.has(automation.id)) {
      candidates.set(automation.id, { automation, trigger: 'schedule' })
    }
  }
  // 被准入跳过的项即使已经超出宽限也留在待准入列表:不落 missed、不停用,
  // 直到成功启动或任务被禁用/删除/改期。
  for (const automation of activeList) {
    if (!automation.enabled || automation.schedule.kind === 'manual') continue
    if (automation.nextRunAt === undefined || automation.nextRunAt > now) continue
    if (!scheduler.isAdmissionSkipped(automation.id)) continue
    if (!candidates.has(automation.id)) {
      candidates.set(automation.id, { automation, trigger: 'schedule' })
    }
  }

  for (const candidate of candidates.values()) {
    await admitCandidate(ctx, routeCtx, scheduler, candidate, now)
  }
}

async function admitCandidate(
  ctx: AutomationRuntime,
  routeCtx: RouteContext,
  scheduler: TurnScheduler,
  candidate: Candidate,
  now: number,
): Promise<void> {
  const { automation, trigger, coalescedCount } = candidate
  const runId = randomUUID()
  const root = await automationAdmissionRoot(routeCtx, automation)
  const sessionId =
    automation.kind === 'agent' ? automationRunSessionId(automation.id, runId) : `script:${runId}`
  const admitted = scheduler.admitAutomation({
    automationId: automation.id,
    sessionId,
    root,
    runId,
    countsTowardCap: automation.kind === 'agent',
  })
  if (admitted.kind === 'skip') return
  if (trigger === 'catchup') {
    emitAutomation(ctx, routeCtx, {
      event: 'automation/missed',
      automationId: automation.id,
      projectId: automation.projectId,
      coalescedCount: coalescedCount ?? 1,
      missedAt: now,
    })
    if (candidate.nextRunAt !== undefined) {
      // 准入已经占坑:推进失败也不能让写者没有执行体来释放。
      await advanceNextRunAt(routeCtx.profileDir, automation.id, candidate.nextRunAt).catch((error: unknown) => {
        logEnqueueFailure(error)
      })
    }
  }
  void enqueueAutomation(automation, {
    trigger,
    runId,
    root: admitted.root,
    ...(coalescedCount === undefined ? {} : { coalescedCount }),
  }).catch(logEnqueueFailure)
}

/**
 * 启动 unref ticker。返回停止函数,给 apply effect 的 dispose。
 * `opts.disabled`(config `automationScheduler.disabled`)或间隔 ≤ 0 时不启动。
 */
export function startAutomationScheduler(
  ctx: AutomationRuntime,
  routeCtx: RouteContext,
  opts: { disabled?: boolean } = {},
): () => void {
  // 入队走这一代已绑定的执行体。apply 里也会 bind;这里再绑一次,保证调度器拿到的 ctx 就是入队用的 ctx。
  bindAutomationRuntime(ctx, routeCtx)
  if (opts.disabled) return () => {}
  const intervalMs = tickIntervalMs()
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {}

  const hostStartedAt = Date.now()
  let automationTicking = false
  let automationRecoveredResidual = false

  const recoverResidualRunningRuns = async (): Promise<void> => {
    const now = Date.now()
    const list = await listAutomations(routeCtx.profileDir)
    for (const automation of list) {
      // lastRunAt 不早于启动时刻 = 本次 generation 发起的在途运行,不是上次的残留。
      if (automation.lastStatus !== 'running' || (automation.lastRunAt ?? 0) >= hostStartedAt) continue
      const startedAt = automation.lastRunAt ?? now
      await appendRun(routeCtx.profileDir, automation.id, {
        runId: randomUUID(),
        startedAt,
        endedAt: now,
        ok: false,
        output: 'sidecar 重启，上次运行被中断',
        status: 'cancelled',
        trigger: 'schedule',
        durationMs: Math.max(0, now - startedAt),
      })
      await markAutomation(routeCtx.profileDir, automation.id, { lastRunAt: now, lastStatus: 'error' })
    }
  }

  const tickAutomations = async (): Promise<void> => {
    // 重入护栏:上一次 tick 的 missed/due 扫描尚未落盘时跳过本次。
    if (automationTicking) return
    automationTicking = true
    try {
      // 重启残留恢复只在首个 tick:补 cancelled 记录并把 lastStatus 改成 error。
      if (!automationRecoveredResidual) {
        automationRecoveredResidual = true
        await recoverResidualRunningRuns().catch((error: unknown) => {
          console.error('automation residual recovery failed:', error)
        })
      }
      // 每一条到期项各自准入;前台是否有 live 回合不再决定整次 tick。
      await evaluateWith(ctx, routeCtx, Date.now())
    } finally {
      automationTicking = false
    }
  }

  const timer = setInterval(() => {
    void Promise.resolve(tickAutomations()).catch((error: unknown) => {
      console.error('automation scheduler tick failed:', error)
    })
  }, intervalMs)
  timer.unref?.()
  return () => {
    clearInterval(timer)
  }
}
