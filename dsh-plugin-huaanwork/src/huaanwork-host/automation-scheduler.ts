import { randomUUID } from 'node:crypto'

import type { AutomationInfo, RpcEvent } from '../client-huaanwork/rpc-types.ts'
import {
  agentIdle,
  automationRootDecision,
  bindAutomationRuntime,
  enqueueAutomation,
  type AutomationRuntime,
} from './automations-host.ts'
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
import type { RouteContext } from './routes.ts'
import { sessionSendBlockers } from './sessions.ts'
import { listAutomations } from './stores.ts'

/**
 * 进程内自动化调度器(旧 scheduler.ts 的 unref ticker + host.ts tick 状态机)。
 *
 * 不调用 executeRun:due / catchup 只经 enqueueAutomation,以免绕过 automationTail 与 blocker 账本。
 * 跨根 due / catchup 在入队前按目标根过滤;不读写 sessionSendBlockers.workspaceDisplaced。
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
      // 放在队列门之前:只写注册表,队列忙也必须完成。
      if (!automationRecoveredResidual) {
        automationRecoveredResidual = true
        await recoverResidualRunningRuns().catch((error: unknown) => {
          console.error('automation residual recovery failed:', error)
        })
      }
      // R1 兜底恢复(userRoot)不移植:旧 host.ts:828-830 的 restoreUserRoot 依赖进程内热切换。
      // Desktop 换根由 pendingRoot 生命周期承接,换根即 generation 重启,tick 内没有可调用的恢复。
      if (sessionSendBlockers.agentAutomationQueued > 0) return
      if (!(await agentIdle(routeCtx))) return
      const now = Date.now()
      const list = await listAutomations(routeCtx.profileDir)
      const expired = expiredAutomations(list, now)
      for (const automation of expired) {
        await updateAutomation(routeCtx.profileDir, automation.id, { enabled: false })
      }
      const expiredIds = new Set(expired.map((item) => item.id))
      const activeList = expired.length > 0 ? list.filter((item) => !expiredIds.has(item.id)) : list
      for (const { automation, nextRunAt, disable, policy, coalescedCount } of missedAutomations(activeList, now)) {
        if (policy === 'run-once' && !disable && nextRunAt !== undefined) {
          // 一律先广播。跨根同样顺延不入队:不推进 nextRunAt,下一 tick 再记 missed,
          // 切到该根后仍能补跑。advanceNextRunAt 只配合同根入队。
          emitAutomation(ctx, routeCtx, {
            event: 'automation/missed',
            automationId: automation.id,
            projectId: automation.projectId,
            coalescedCount,
            missedAt: now,
          })
          if ((await automationRootDecision(routeCtx, automation)).kind === 'cross') continue
          await advanceNextRunAt(routeCtx.profileDir, automation.id, nextRunAt)
          void enqueueAutomation(automation, { trigger: 'catchup', coalescedCount }).catch(logEnqueueFailure)
          continue
        }
        // 错过记录与根无关。skip / once 自停照常写 runs;执行才受同根限定。
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
      const due = dueAutomations(activeList, now)
      // 同根才入队。项目已删除不算跨根;中立任务的目标根是中立根。跨根保持 due。
      const sameRootDue: AutomationInfo[] = []
      for (const automation of due) {
        if ((await automationRootDecision(routeCtx, automation)).kind === 'cross') continue
        sameRootDue.push(automation)
      }
      // 按 projectId 分组(首次出现顺序)。null(中立)是合法分组键。
      const groups: AutomationInfo[][] = []
      const groupIndexByProject = new Map<string | null, number>()
      for (const automation of sameRootDue) {
        const index = groupIndexByProject.get(automation.projectId)
        if (index === undefined) {
          groupIndexByProject.set(automation.projectId, groups.length)
          groups.push([automation])
        } else {
          const bucket = groups[index]
          if (bucket) bucket.push(automation)
        }
      }
      // agentIdle 放在每组入队前,不放在组内:同组必须整体入队。
      // break 只挡住后续组,被挡住的组保持 due,由后续 tick 拾取。
      for (const group of groups) {
        if (!(await agentIdle(routeCtx))) break
        for (const automation of group) {
          void enqueueAutomation(automation).catch(logEnqueueFailure)
        }
      }
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
