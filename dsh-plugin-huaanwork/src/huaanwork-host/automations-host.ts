import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve as pathResolve } from 'node:path'

import type { AutomationInfo, RpcEvent, RunSummary } from '../client-huaanwork/rpc-types.ts'
import { resolveApproval } from './approvals.ts'
import { automationRunSessionId } from './automation-session-ids.ts'
import {
  appendRun,
  clipOutput,
  markAutomation,
  OUTPUT_MAX_CHARS,
  UNATTENDED_TOOL_NAMES,
  updateAutomation,
} from './automations-store.ts'
import type { RouteContext } from './routes.ts'
import { sessionIdFor } from './session-id.ts'
import { findSessionAgent, sendToAgent, sessionSendBlockers, type SessionRuntimeContext } from './sessions.ts'
import { readHuaanworkSettingsSync } from './settings.ts'
import { listProjects, recentRuns } from './stores.ts'
import { neutralWorkspaceRoot } from './workspace-state.ts'

/**
 * 自动化执行体与入队层(旧 host.ts 入队/执行体,方案①同根限定)。
 *
 * agent 任务走 automationTail 串行链(并发恒 1);script 走上限 2 的槽位池,两者互不阻塞。
 * 不移植 restoreUserRoot / 进程内热切换:到达执行体的任务在当前 workspaceRoot 下运行。
 * schedule/catchup 若目标根 ≠ 当前根,本入口直接返回、不入队(Task 5 调度器消费同一入口)。
 * 手动跨根由 automation.run 在入队前具名拒绝;项目已删除不算跨根,放行执行体记失败。
 */

/** 绑定项目已不在当前根时,手动 run 的拒绝文案。 */
export const MANUAL_CROSS_PROJECT_MESSAGE = '请先切换到该项目再手动运行'
/** 中立任务的目标根(中立根)≠ 当前根时,手动 run 的拒绝文案。 */
export const MANUAL_CROSS_NEUTRAL_MESSAGE = '该任务未归属项目,请先回到默认工作区再运行'
/** 绑定项目已删除:执行体记一次失败运行,不顺延、不按跨根拒绝。 */
export const MISSING_PROJECT_OUTPUT = '任务所属项目不存在，已跳过执行'

const MERGED_PREFIX_MAX_CHARS = 4 * 1024

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

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

function stripModelThinking(text: string): string {
  const closed = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const open = closed.indexOf('<think>')
  return open >= 0 ? closed.slice(0, open) : closed
}

/** 只取消这一条自动化会话,不回落到通道 agent,也不顺带取消其它 live agent。 */
function cancelAutomationSession(ctx: AutomationRuntime, sessionId: string): void {
  const direct = ctx.agents?.get?.(sessionId)
  const agent =
    direct && (direct.id === sessionId || direct.session?.id === sessionId)
      ? direct
      : ctx.agents?.list?.().find((item) => item.id === sessionId || item.session?.id === sessionId)
  agent?.cancel?.({ kind: 'user' })
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
  const turn = sendToAgent(ctx, routeCtx, { text: prompt, sessionId })
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
      await turn.catch(() => undefined)
      throw new AutomationRunTimeoutError(error instanceof Error ? error.message : String(error))
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    automationCollector.delete(sessionId)
    if (holder) holder.current = undefined
  }
}

function runScript(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32'
    const child = spawn(isWindows ? 'pwsh' : 'bash', isWindows ? ['-NoLogo', '-Command', command] : ['-lc', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (ok: boolean, output: string, timedOut = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, output: clipOutput(output), timedOut })
    }
    const timer = setTimeout(() => {
      child.kill()
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
    status?: 'ok' | 'error' | 'timeout'
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
  await markAutomation(routeCtx.profileDir, automation.id, { lastRunAt: startedAt, lastStatus: 'running' })

  const project = automation.projectId
    ? (await listProjects(routeCtx.profileDir)).find((item) => item.id === automation.projectId)
    : null
  if (automation.projectId && !project) {
    await finishAutomation(
      routeCtx,
      automation,
      { runId, startedAt, ok: false, output: MISSING_PROJECT_OUTPUT, ...(sessionId === undefined ? {} : { sessionId }) },
      trigger,
      coalescedCount,
    )
    return
  }

  let ok = true
  let output = ''
  let status: 'ok' | 'error' | 'timeout' = 'ok'
  try {
    if (automation.kind === 'agent') {
      output = await runAgentTurn(ctx, routeCtx, automation, sessionId!, runId, trigger, coalescedCount)
    } else {
      const result = await runScript(automation.command ?? '', routeCtx.workspaceRoot.current, automationTimeout(routeCtx))
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
  await finishAutomation(
    routeCtx,
    automation,
    { runId, startedAt, ok, output, status, ...(sessionId === undefined ? {} : { sessionId }) },
    trigger,
    coalescedCount,
  )
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
  const runId = meta.runId ?? randomUUID()
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
    return automationRootDecision(routeCtx, automation).then((decision) => {
      if (decision.kind === 'cross') return
      return dispatchEnqueue(automation, meta)
    })
  }
  return dispatchEnqueue(automation, meta)
}

function dispatchEnqueue(automation: AutomationInfo, meta: AutomationRunMeta): Promise<void> {
  return automation.kind === 'agent' ? enqueueAgentAutomation(automation, meta) : enqueueScriptAutomation(automation, meta)
}
