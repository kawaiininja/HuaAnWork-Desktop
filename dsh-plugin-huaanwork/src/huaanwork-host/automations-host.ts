import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve as pathResolve } from 'node:path'

import type { AutomationInfo, RpcEvent, RunSummary } from '../client-huaanwork/rpc-types.ts'
import { releaseRouteInput } from '../huaanwork-guardrails/route-tool-plugin.ts'
import { inFlightRuns, inFlightRunsOf, startInFlightRun, type InFlightRun } from './automation-inflight.ts'
import { resolveApproval } from './approvals.ts'
import { automationRunSessionId } from './automation-session-ids.ts'
import {
  appendRun,
  clipOutput,
  consumeSkippedSlot,
  markAutomation,
  OUTPUT_MAX_CHARS,
  UNATTENDED_TOOL_NAMES,
  updateAutomation,
} from './automations-store.ts'
import type { RouteContext } from './routes.ts'
import { sessionIdFor } from './session-id.ts'
import {
  findSessionAgent,
  sendToAgent,
  sessionSendBlockers,
  type ListedAgent,
  type SessionRuntimeContext,
} from './sessions.ts'
import { readHuaanworkSettingsSync } from './settings.ts'
import { listProjects, recentRuns } from './stores.ts'
import { neutralWorkspaceRoot } from './workspace-state.ts'

/**
 * 自动化执行体与入队层(旧 host.ts 入队/执行体,方案①同根限定)。
 *
 * agent 任务走 automationTail 串行链(并发恒 1);script 走上限 2 的槽位池,两者互不阻塞。
 * 不移植 restoreUserRoot / 进程内热切换:到达执行体的任务在当前 workspaceRoot 下运行。
 * schedule/catchup 若目标根 ≠ 当前根,本入口直接返回、不入队(Task 5 调度器消费同一入口)。
 * 手动运行由路由先热切换到目标根再入队;调度跨根不入队。项目已删除不算跨根,放行执行体记失败。
 */

/** 绑定项目已不在当前根时,手动 run 的拒绝文案。 */
export const MANUAL_CROSS_PROJECT_MESSAGE = '请先切换到该项目再手动运行'
/** 中立任务的目标根(中立根)≠ 当前根时,手动 run 的拒绝文案。 */
export const MANUAL_CROSS_NEUTRAL_MESSAGE = '该任务未归属项目,请先回到默认工作区再运行'
/** 绑定项目已删除:执行体记一次失败运行,不顺延、不按跨根拒绝。 */
export const MISSING_PROJECT_OUTPUT = '任务所属项目不存在，已跳过执行'

const MERGED_PREFIX_MAX_CHARS = 4 * 1024

/**
 * runner 失败收尾追加的合成脚注(`\n（退出码 unknown）` / `\n（退出码 1）`)。
 * 取消结算只有它、没有真实产出时，正文应回落到「已停止」（规格 §8）。
 */
const RUNNER_EXIT_CODE_FOOTER = /\s*（退出码 (?:\d+|unknown)）\s*$/u

function stripRunnerExitCodeFooter(output: string): string {
  return output.replace(RUNNER_EXIT_CODE_FOOTER, '')
}

/** 自动化运行超时:局部 timedOut 标记决定抛出,catch 侧按类型归因。 */
class AutomationRunTimeoutError extends Error {}

export type AutomationTrigger = 'manual' | 'schedule' | 'catchup'

export type AutomationRunMeta = {
  trigger: AutomationTrigger
  coalescedCount?: number
  runId?: string
}

export type AutomationRootDecision =
  | { kind: 'same' }
  | { kind: 'missing-project' }
  | { kind: 'cross'; message: string }

type UnattendedScope = {
  runId: string
  automationId: string
  allow: Set<string>
  sessionId?: string
}

export type AutomationRuntime = SessionRuntimeContext & {
  huaanworkUnattended?: { current: UnattendedScope | undefined }
  huaanworkEmit?: (event: RpcEvent) => void
}

type BoundRuntime = {
  ctx: AutomationRuntime
  routeCtx: RouteContext
}

/** 后台 agent 任务运行期间按 sessionId 归集 token 流。Task 5/6 也读这张表。 */
export const automationCollector = new Map<string, { runId: string; text: string }>()

/** 审批按 runId 归集:运行结束只拒绝本运行遗留的审批。 */
const runPendingApprovals = new Map<string, Set<string>>()

/**
 * agent 串行链。并发安全(blocker 账本)由这条链保证:绕过它则计数失效。
 * 链尾只归还两个计数,不调用 restoreUserRoot(方案①无进程内位移可恢复)。
 */
export let automationTail: Promise<void> = Promise.resolve()

export const SCRIPT_AUTOMATION_CONCURRENCY = 2
let scriptAutomationRunning = 0
/** 槽位满时排队;被唤醒的 waiter 直接持有槽位,计数不在唤醒侧再 +1。 */
export const scriptSlotWaiters: Array<() => void> = []

let bound: BoundRuntime | undefined

function requireBound(): BoundRuntime {
  if (!bound) throw new Error('automation runtime is not bound')
  return bound
}

function logFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  bound?.routeCtx.logger(`automation run failed: ${message}`)
}

/** 白名单过滤。run_code 不在 UNATTENDED_TOOL_NAMES 里,永远进不了 allow。 */
function sanitizeUnattendedAllow(list: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const item of list) {
    if (!(UNATTENDED_TOOL_NAMES as readonly string[]).includes(item)) continue
    seen.add(item)
  }
  return [...seen]
}

/**
 * token / approval/asked 归集。挂在 emit 上一次:不改 guardrails。
 * approval/asked 带 sessionId 时记入该运行的 runId;运行结束只拒绝这一组。
 */
function ingestAutomationEvent(event: RpcEvent): void {
  if (event.event === 'approval/asked' && event.sessionId) {
    const attributed = automationCollector.get(event.sessionId)
    if (!attributed) return
    let bucket = runPendingApprovals.get(attributed.runId)
    if (!bucket) {
      bucket = new Set()
      runPendingApprovals.set(attributed.runId, bucket)
    }
    bucket.add(event.approvalRequestId)
    return
  }
  if (event.event !== 'token') return
  if (event.sessionId !== undefined) {
    const attributed = automationCollector.get(event.sessionId)
    if (attributed) attributed.text += event.text
    return
  }
  if (automationCollector.size === 1) {
    for (const bucket of automationCollector.values()) bucket.text += event.text
  }
}

function rejectRunPendingApprovals(ctx: AutomationRuntime, runId: string): void {
  const bucket = runPendingApprovals.get(runId)
  if (!bucket) return
  runPendingApprovals.delete(runId)
  const approvals = ctx.huaanworkApprovals
  if (!approvals) return
  for (const approvalRequestId of bucket) {
    resolveApproval(approvals, approvalRequestId, 'rejected')
  }
}

/**
 * 把 collector 挂到 routeCtx.emit 与 ctx.huaanworkEmit(两者在组合期是同一个函数)。
 * 调度器不在这里启动;Task 5 调用同一 enqueueAutomation。
 */
export function bindAutomationRuntime(ctx: AutomationRuntime, routeCtx: RouteContext): void {
  const current = routeCtx.emit as ((event: RpcEvent) => void) & { __hwAutomationIngest?: boolean }
  if (!current.__hwAutomationIngest) {
    const rawEmit = routeCtx.emit.bind(routeCtx)
    const wrapped = (event: RpcEvent) => {
      ingestAutomationEvent(event)
      rawEmit(event)
    }
    ;(wrapped as { __hwAutomationIngest?: boolean }).__hwAutomationIngest = true
    routeCtx.emit = wrapped
    ctx.huaanworkEmit = wrapped
  }
  bound = { ctx, routeCtx }
}

/** 单 agent 是否空闲(旧 host.ts agentIdle)。不移植 liveAgentsIdle。 */
export async function agentIdle(routeCtx: RouteContext): Promise<boolean> {
  const runtime = routeCtx.runtimeCtx
  if (!runtime) return true
  const agent = findSessionAgent(runtime, sessionIdFor(routeCtx.workspaceRoot.current))
  if (typeof agent?.whenIdle !== 'function') return true
  try {
    return await Promise.race([
      agent.whenIdle().then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1_000)
        timer.unref?.()
      }),
    ])
  } catch {
    return true
  }
}

/**
 * 目标根 vs 当前根。项目已删除不算跨根;中立任务的目标根是 neutralWorkspaceRoot。
 */
export async function automationRootDecision(
  routeCtx: RouteContext,
  automation: AutomationInfo,
): Promise<AutomationRootDecision> {
  if (automation.projectId) {
    const project = (await listProjects(routeCtx.profileDir)).find((item) => item.id === automation.projectId)
    if (!project) return { kind: 'missing-project' }
    if (pathResolve(project.root) !== pathResolve(routeCtx.workspaceRoot.current)) {
      return { kind: 'cross', message: MANUAL_CROSS_PROJECT_MESSAGE }
    }
    return { kind: 'same' }
  }
  if (pathResolve(neutralWorkspaceRoot(routeCtx.profileDir)) !== pathResolve(routeCtx.workspaceRoot.current)) {
    return { kind: 'cross', message: MANUAL_CROSS_NEUTRAL_MESSAGE }
  }
  return { kind: 'same' }
}

const automationTimeout = (routeCtx: RouteContext): number =>
  readHuaanworkSettingsSync(routeCtx.profileDir).automation_timeout_ms

/**
 * test-only:超时后等待被取消 turn settle 的 drain 截止,单测注入毫秒级值。
 * 缺省 120s,与 guardrails approval.ts 的 APPROVAL_TIMEOUT_MS 同量级——审批卡点是
 * 取消生效前合法的有界延迟上限(见 M4 评审附录 D-1)。
 */
function timedOutTurnDrainMs(): number {
  return Number(process.env.HUAANWORK_TIMED_OUT_TURN_DRAIN_MS ?? 120_000)
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

function stripModelThinking(text: string): string {
  const closed = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const open = closed.indexOf('<think>')
  return open >= 0 ? closed.slice(0, open) : closed
}

/** 按会话 id 精确定位自动化会话的 agent,不回落到通道 agent。 */
function automationSessionAgent(ctx: AutomationRuntime, sessionId: string): ListedAgent | undefined {
  const direct = ctx.agents?.get?.(sessionId)
  return direct && (direct.id === sessionId || direct.session?.id === sessionId)
    ? direct
    : ctx.agents?.list?.().find((item) => item.id === sessionId || item.session?.id === sessionId)
}

/** 只取消这一条自动化会话,不顺带取消其它 live agent。 */
function cancelAutomationSession(ctx: AutomationRuntime, sessionId: string): void {
  automationSessionAgent(ctx, sessionId)?.cancel?.({ kind: 'user' })
  releaseRouteInput(sessionId)
}

async function mergedRunPrefix(routeCtx: RouteContext, automation: AutomationInfo): Promise<string | undefined> {
  if (automation.taskShape !== 'merged') return undefined
  const runs = await recentRuns(routeCtx.profileDir, automation.id)
  const lastOk = [...runs].reverse().find((run) => run.ok)
  return lastOk ? lastOk.output.slice(0, MERGED_PREFIX_MAX_CHARS) : undefined
}

async function runAgentTurn(
  ctx: AutomationRuntime,
  routeCtx: RouteContext,
  automation: AutomationInfo,
  sessionId: string,
  runId: string,
  trigger: AutomationTrigger,
  coalescedCount: number | undefined,
): Promise<string> {
  const mergedPrefix = await mergedRunPrefix(routeCtx, automation)
  const body = [...(mergedPrefix ? ['上次成功运行的产出（截断至 4 KB）：', mergedPrefix] : []), automation.prompt ?? ''].join('\n')
  const missed = coalescedCount ?? 0
  const prompt = `<automation-fire name="${escapeXmlAttr(automation.name)}" trigger="${trigger}" missed="${missed}">\n${body}\n</automation-fire>`
  automationCollector.set(sessionId, { runId, text: '' })
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  // 只 mutate 容器的 .current,不重新赋值 huaanworkUnattended 本身。
  const holder = ctx.huaanworkUnattended
  if (holder) {
    const allow = automation.unattended?.enabled ? sanitizeUnattendedAllow(automation.unattended.allow) : undefined
    holder.current = allow
      ? { runId, automationId: automation.id, allow: new Set(allow), sessionId }
      : undefined
  }
  // sendToAgent 在 followup 受理后即返回;自动化要的是整轮产出,故 turn 还要等到 idle。
  // 超时与 drain 都作用在这个 turn 上。
  const turn = (async () => {
    await sendToAgent(ctx, routeCtx, { text: prompt, sessionId })
    await automationSessionAgent(ctx, sessionId)?.whenIdle?.()
  })()
  try {
    await Promise.race([
      turn,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new Error('自动化任务执行超时'))
        }, automationTimeout(routeCtx))
        timer.unref?.()
      }),
    ])
    return stripModelThinking(automationCollector.get(sessionId)?.text ?? '').trim()
  } catch (error: unknown) {
    if (timedOut) {
      cancelAutomationSession(ctx, sessionId)
      // D1(出口级):超时后的 settle 等待必须有自身截止。取消未命中(agent 尚未建成、
      // 或卡在不可取消的回合)时 turn 可能永不 settle——无截止会把 automationTail
      // 楔死、sessionSendBlockers 计数悬挂、collector/unattended holder 泄漏。
      // 截止内 settle 保住「超时 turn 结束前下一个 agent 不启动」的串行意图;
      // 到期放弃 turn(其晚期 settle 因 collector 已清而为 no-op)并按 legacy 语义抛超时。
      let drainTimer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        turn.catch(() => undefined),
        new Promise<undefined>((resolve) => {
          drainTimer = setTimeout(() => resolve(undefined), timedOutTurnDrainMs())
          drainTimer.unref?.()
        }),
      ])
      if (drainTimer) clearTimeout(drainTimer)
      throw new AutomationRunTimeoutError(error instanceof Error ? error.message : String(error))
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    automationCollector.delete(sessionId)
    if (holder) holder.current = undefined
  }
}

/**
 * 在跑脚本的 kill 句柄,按 runId 索引(规格 §8「脚本结束对应子进程」)。
 * 只登记到 `finish`(exit/error/timeout 任一先到)为止;停止侧命中即杀进程树。
 */
export const scriptRunKillers = new Map<string, () => void>()

/** SIGKILL 前留给进程处理 SIGTERM 的宽限;定时器 unref,不拖住宿主退出。 */
const KILL_GRACE_MS = 2_000

/**
 * 结束脚本的整棵进程树。`bash -lc` / `pwsh -Command` 只是外壳:管道、后台
 * 孙进程都属于它派生出的进程组,只杀外壳会让它们继续写文件、跑完整个超时窗口。
 *
 * - POSIX:子进程以 `detached` 启动,自成一个进程组(`pgid = child.pid`),
 *   负 pid 即整组;先 SIGTERM,2 秒后探测整组仍存活再 SIGKILL(组长先退出不豁免
 *   忽略 SIGTERM 的孙进程)。组不存在时回落到只杀外壳。停止与超时两条路径共用。
 * - Windows:`taskkill /T /F` 按 pid 树杀;spawn 失败或没有 pid 时回落 `child.kill()`。
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => {
        try {
          child.kill()
        } catch {
          // 进程已退出
        }
      })
      killer.unref()
    } catch {
      child.kill()
    }
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  const timer = setTimeout(() => {
    // 组长退出不代表组里的后台孙进程也退出:它们可能忽略 SIGTERM 继续写文件。
    // 因此探测整组是否还活着(kill 0),只有整组 ESRCH 才跳过 SIGKILL。
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if ((error as { code?: string }).code === 'ESRCH') return
      // EPERM 等探测失败:组可能仍存在,保守地继续按组发 SIGKILL。
    }
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // 进程已退出
      }
    }
  }, KILL_GRACE_MS)
  timer.unref?.()
}

function runScript(
  command: string,
  cwd: string,
  timeoutMs: number,
  runId?: string,
): Promise<{ ok: boolean; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32'
    const child = spawn(isWindows ? 'pwsh' : 'bash', isWindows ? ['-NoLogo', '-Command', command] : ['-lc', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX:独立进程组,停止/超时按组杀,后台孙进程不会漏网。
      detached: !isWindows,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (ok: boolean, output: string, timedOut = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (runId !== undefined) scriptRunKillers.delete(runId)
      resolve({ ok, output: clipOutput(output), timedOut })
    }
    if (runId !== undefined) {
      scriptRunKillers.set(runId, () => killProcessTree(child))
      // stop 可能已经落在 run-start 与 spawn 之间：登记句柄的同一同步段补杀一次，
      // 否则进程会跑完整个脚本/超时窗口（规格 §8「脚本结束对应子进程」）。
      if (inFlightRuns.get(runId)?.cancelRequested === true) killProcessTree(child)
    }
    const timer = setTimeout(() => {
      killProcessTree(child)
      finish(false, `${stdout}${stderr}\n（任务超时，已终止）`, true)
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < OUTPUT_MAX_CHARS * 2) stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < OUTPUT_MAX_CHARS * 2) stderr += chunk.toString()
    })
    child.on('error', (error) => finish(false, `${stdout}${stderr}\n${error.message}`))
    child.on('close', (code) => {
      if (code === 0) finish(true, stdout)
      else finish(false, `${stdout}${stderr ? `\n${stderr}` : ''}\n（退出码 ${code ?? 'unknown'}）`)
    })
  })
}

async function finishAutomation(
  routeCtx: RouteContext,
  automation: AutomationInfo,
  run: {
    runId: string
    startedAt: number
    ok: boolean
    output: string
    status?: 'ok' | 'error' | 'timeout' | 'cancelled'
    sessionId?: string
  },
  trigger: AutomationTrigger,
  coalescedCount: number | undefined,
): Promise<void> {
  const endedAt = Date.now()
  const status = run.status ?? (run.ok ? 'ok' : 'error')
  const durationMs = endedAt - run.startedAt
  const summary: RunSummary = {
    runId: run.runId,
    startedAt: run.startedAt,
    endedAt,
    ok: run.ok,
    output: clipOutput(run.output),
    status,
    trigger,
    durationMs,
  }
  if (coalescedCount !== undefined) summary.coalescedCount = coalescedCount
  if (run.sessionId !== undefined) summary.sessionId = run.sessionId
  await appendRun(routeCtx.profileDir, automation.id, summary)
  // 记录落盘即摘条目:之后到达的 stop 看到「无条目」,自然归于「记录已落盘 ⇒ 未停止」。
  inFlightRuns.delete(run.runId)
  // 完成时不再推进 nextRunAt:进入 running 时已经按 startedAt 算过一次。
  await markAutomation(routeCtx.profileDir, automation.id, {
    lastRunAt: endedAt,
    lastStatus: run.ok ? 'ok' : 'error',
  })
  if (automation.schedule.kind === 'once') {
    await updateAutomation(routeCtx.profileDir, automation.id, { enabled: false })
  }
  if (automation.widget) {
    routeCtx.emit({ event: 'automation/widget', automationId: automation.id, projectId: automation.projectId, time: endedAt })
  }
  routeCtx.emit({
    event: 'automation/run-end',
    automationId: automation.id,
    runId: run.runId,
    projectId: automation.projectId,
    ok: run.ok,
    status,
    durationMs,
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
  })
}

/**
 * 执行体。不含跨根热切换:调用方已保证同根,或项目已删除(记失败后 return)。
 * ctx 必须穿透到 sendToAgent 的首参。
 */
export async function executeRun(
  ctx: AutomationRuntime,
  routeCtx: RouteContext,
  automation: AutomationInfo,
  trigger: AutomationTrigger,
  runId: string,
  coalescedCount?: number,
): Promise<void> {
  // ── 同步段不变量(规格 §8 / 评审注记 2)────────────────────────────
  // 取消检查、阶段翻转与 run-start 发射三者之间不得插入任何 await：stop 的
  // 同步声明依赖事件循环单线程在此段内不可交错。谁在这里加 await 谁就重新
  // 打开「stop 插不进 queued 与 started 之间」的窗口。本段之后的第一个
  // await 只能是下面的 markAutomation（发射之后）——同步段结束标记也钉在
  // 那里，不钉在阶段翻转后（计划评审第 3 条）。
  const entry = inFlightRuns.get(runId)
  if (entry?.cancelRequested) {
    inFlightRuns.delete(runId) // 档位已由停止侧消费（slotConsumed），执行体不再消费
    return
  }
  if (entry) entry.phase = 'started'
  const startedAt = Date.now()
  const sessionId = automation.kind === 'agent' ? automationRunSessionId(automation.id, runId) : undefined
  routeCtx.emit({
    event: 'automation/run-start',
    automationId: automation.id,
    runId,
    projectId: automation.projectId,
    trigger,
    ...(sessionId === undefined ? {} : { sessionId }),
  })
  // ── 同步段结束（以上不得有 await）────────────────────────────────
  await markAutomation(routeCtx.profileDir, automation.id, { lastRunAt: startedAt, lastStatus: 'running' })

  const project = automation.projectId
    ? (await listProjects(routeCtx.profileDir)).find((item) => item.id === automation.projectId)
    : null
  if (automation.projectId && !project) {
    // 已 started 且被停止的轮次同样按 cancelled 落盘；否则任务行会把它显示成失败。
    const cancelled = inFlightRuns.get(runId)?.cancelRequested === true
    await finishAutomation(
      routeCtx,
      automation,
      {
        runId,
        startedAt,
        ok: false,
        output: cancelled ? '已停止' : MISSING_PROJECT_OUTPUT,
        ...(cancelled ? { status: 'cancelled' as const } : {}),
        ...(sessionId === undefined ? {} : { sessionId }),
      },
      trigger,
      coalescedCount,
    )
    return
  }

  let ok = true
  let output = ''
  let status: 'ok' | 'error' | 'timeout' | 'cancelled' = 'ok'
  try {
    if (automation.kind === 'agent') {
      output = await runAgentTurn(ctx, routeCtx, automation, sessionId!, runId, trigger, coalescedCount)
    } else {
      const result = await runScript(
        automation.command ?? '',
        routeCtx.workspaceRoot.current,
        automationTimeout(routeCtx),
        runId,
      )
      ok = result.ok
      output = result.output
      if (result.timedOut) status = 'timeout'
      else if (!result.ok) status = 'error'
    }
  } catch (error: unknown) {
    ok = false
    status = error instanceof AutomationRunTimeoutError ? 'timeout' : 'error'
    output = error instanceof Error ? error.message : String(error)
  } finally {
    rejectRunPendingApprovals(ctx, runId)
  }
  // 停止覆盖(规格 §8):标记在落盘前即生效——模型回合后来自己跑完也写 cancelled,
  // 不写 ok;脚本被杀不记 timeout;产出保留已收集文本,什么都没有时正文为「已停止」。
  // 被杀脚本的 runner 脚注是合成文本,不算产出:先剥掉再判空。
  if (inFlightRuns.get(runId)?.cancelRequested === true) {
    ok = false
    status = 'cancelled'
    output = stripRunnerExitCodeFooter(output)
    if (!output.trim()) output = '已停止'
  }
  await finishAutomation(
    routeCtx,
    automation,
    { runId, startedAt, ok, output, status, ...(sessionId === undefined ? {} : { sessionId }) },
    trigger,
    coalescedCount,
  )
}

/**
 * 停止任务的全部在途轮(规格 §8),供 `automation.stop` 路由调用。
 *
 * - 没有条目:{ stopped: false } —— 界面据此把按钮恢复为「立即运行」。
 * - `queued`:同步段标记取消并声明档位由本次停止消费,条目**留在表里**给执行体
 *   醒来后观察并删除;在此删除会让执行体看到「无条目」而照常执行。
 * - `started`:标记取消后按任务种类取消会话或杀掉脚本子进程;agent 尚未建成时
 *   取消调用是空操作,标记仍然有效,收尾照常写一条 `cancelled` 记录。
 */
export async function stopAutomation(automationId: string): Promise<{ stopped: boolean }> {
  const { ctx, routeCtx } = requireBound()
  const entries = inFlightRunsOf(automationId)
  if (entries.length === 0) return { stopped: false }
  const startedEntries: InFlightRun[] = []
  // ── 同步段:取消标记与档位所有权必须在任何 await 之前落表(规格 §8)。──
  // 后到的停止看见 slotConsumed 已声明就不会二次消费;执行体与 stop 之间因此
  // 不可能交错出「还是 queued / 已经 started」的缝隙。
  for (const entry of entries) {
    entry.cancelRequested = true
    if (entry.phase === 'queued') {
      if (!entry.slotConsumed) {
        entry.slotConsumed = true
        // 档位写入允许异步:失败只记日志,不混进停止应答(N2-O1 接受的窄窗口)。
        void consumeSkippedSlot(routeCtx.profileDir, automationId, entry.trigger, Date.now())
          .catch((error: unknown) => logFailure(error))
      }
    } else {
      startedEntries.push(entry)
    }
  }
  // ── 同步段结束 ──
  if (startedEntries.length > 0) {
    for (const entry of startedEntries) {
      // 按入队时的种类选通道:注册表里的 kind 可能已被改写、任务也可能已被删除,
      // 回读注册表会让已开始的运行既不被取消也不被杀,而 stop 仍返回 stopped:true。
      if (entry.kind === 'agent') {
        cancelAutomationSession(ctx, automationRunSessionId(entry.automationId, entry.runId))
      } else {
        // 脚本结束对应整棵子进程树;agent 任务不会登记 kill 句柄,这里是空操作。
        scriptRunKillers.get(entry.runId)?.()
      }
    }
  }
  return { stopped: true }
}

export async function acquireScriptSlot(): Promise<void> {
  if (scriptAutomationRunning >= SCRIPT_AUTOMATION_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      scriptSlotWaiters.push(resolve)
    })
    return
  }
  scriptAutomationRunning += 1
}

export function releaseScriptSlot(): void {
  const waiter = scriptSlotWaiters.shift()
  if (waiter) {
    waiter()
    return
  }
  scriptAutomationRunning -= 1
}

async function runBound(
  automation: AutomationInfo,
  meta: AutomationRunMeta,
): Promise<void> {
  const { ctx, routeCtx } = requireBound()
  if (meta.runId === undefined) throw new Error('automation run reached the executor without a runId')
  const runId = meta.runId
  if (meta.coalescedCount === undefined) {
    await executeRun(ctx, routeCtx, automation, meta.trigger, runId)
  } else {
    await executeRun(ctx, routeCtx, automation, meta.trigger, runId, meta.coalescedCount)
  }
}

/** agent 并发恒 1。两计数在本次 run 完成时归位,中间没有 restore 时点。 */
export function enqueueAgentAutomation(automation: AutomationInfo, meta: AutomationRunMeta): Promise<void> {
  // workspaceDisplaced 不写:非 P1-4 未收口的恒假死检查,而是 Desktop 无进程内位移的必然结果(方案①,评审 P1-7)。
  sessionSendBlockers.agentAutomationQueued += 1
  sessionSendBlockers.agentAutomationActive += 1
  const run = automationTail.then(() => runBound(automation, meta))
  const settled = run.catch((error: unknown) => {
    logFailure(error)
  })
  automationTail = settled.then(() => {
    sessionSendBlockers.agentAutomationQueued -= 1
    sessionSendBlockers.agentAutomationActive -= 1
  })
  return settled
}

/** script 不位移、不占 agent 计数,排空后也不恢复工作区。 */
export function enqueueScriptAutomation(automation: AutomationInfo, meta: AutomationRunMeta): Promise<void> {
  return (async () => {
    await acquireScriptSlot()
    try {
      await runBound(automation, meta)
    } catch (error: unknown) {
      logFailure(error)
    } finally {
      releaseScriptSlot()
    }
  })()
}

let enqueueGate: Promise<void> = Promise.resolve()

/**
 * 手动触发与调度触发的唯一分派入口。
 * schedule/catchup 跨根:不入队、不执行(保持 due 由调用方负责)。manual 不再次判定。
 */
export function enqueueAutomation(
  automation: AutomationInfo,
  meta: AutomationRunMeta = { trigger: 'schedule' },
): Promise<void> {
  if (meta.trigger !== 'manual') {
    const { routeCtx } = requireBound()
    let runPromise: Promise<void> | undefined
    const step = enqueueGate.then(async () => {
      const decision = await automationRootDecision(routeCtx, automation)
      if (decision.kind === 'cross') return
      runPromise = dispatchEnqueue(automation, meta)
    })
    enqueueGate = step.catch((error: unknown) => {
      logFailure(error)
    })
    return step.then(() => runPromise)
  }
  return dispatchEnqueue(automation, meta)
}

function dispatchEnqueue(automation: AutomationInfo, meta: AutomationRunMeta): Promise<void> {
  // runId 在真正入队的同步段确定并写表(规格 §8;跨根放弃在到达这里之前已 return)。
  const runId = meta.runId ?? randomUUID()
  startInFlightRun({
    automationId: automation.id,
    runId,
    trigger: meta.trigger,
    kind: automation.kind,
    phase: 'queued',
    cancelRequested: false,
    slotConsumed: false,
  })
  const withRunId = { ...meta, runId }
  return automation.kind === 'agent'
    ? enqueueAgentAutomation(automation, withRunId)
    : enqueueScriptAutomation(automation, withRunId)
}

