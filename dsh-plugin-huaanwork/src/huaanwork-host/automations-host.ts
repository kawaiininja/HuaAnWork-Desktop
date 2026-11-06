import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
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
import { resolveSessionModel } from './session-models.ts'
import {
  releaseAndDrain,
  sendToAgent,
  type ListedAgent,
  type SessionRuntimeContext,
} from './sessions.ts'
import { readHuaanworkSettingsSync } from './settings.ts'
import { listProjects, recentRuns } from './stores.ts'
import { neutralWorkspaceRoot } from './workspace-state.ts'

/**
 * 自动化执行体与入队层(旧 host.ts 入队/执行体)。
 *
 * Task 8 起 agent 与 script 都按目标根的写者名额互斥:准入只发生在调度 tick 与
 * `automation.run` 两处,`enqueueAutomation` 只执行已经占坑的运行。
 * agent 自动化直接调用执行体,不再串 `automationTail`;script 保留上限 2 的槽位池,
 * 槽位在该次准入成功之后获取。两类运行都用各自的准入根(项目根或中立根),不读前台根。
 * 项目已删除不算准入失败:执行体照旧记一次失败运行。
 */

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
  /** 准入时确定的运行 id;写者键由它派生,不再在入队时二次生成。 */
  runId: string
  /** 本次准入成功占下的可写根(项目根或中立根,已 resolve)。 */
  root: string
  coalescedCount?: number
}

/** 准入已占下的可写根与这次运行唯一的写者释放器。 */
export type AutomationAdmission = {
  root: string
  release: () => void
}

type UnattendedScope = {
  runId: string
  automationId: string
  allow: Set<string>
  sessionId?: string
}

export type AutomationRuntime = SessionRuntimeContext & {
  huaanworkUnattended?: Map<string, UnattendedScope>
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

/**
 * 单次到期评估需要的绑定(automation-scheduler 的 evaluateDueAutomations 消费)。
 * 未绑定时返回 undefined:调度器尚未接线不算错误。
 */
export function boundAutomationRuntime(): BoundRuntime | undefined {
  return bound
}

/**
 * 准入与执行体共用的目标根:项目根;项目不存在或无项目时用中立根。
 * 项目已删除仍按中立根准入,执行体照旧记一次 missing-project 失败。
 */
export async function automationAdmissionRoot(routeCtx: RouteContext, automation: AutomationInfo): Promise<string> {
  if (automation.projectId) {
    const project = (await listProjects(routeCtx.profileDir)).find((item) => item.id === automation.projectId)
    if (project) return pathResolve(project.root)
  }
  return pathResolve(neutralWorkspaceRoot(routeCtx.profileDir))
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
  admission: AutomationAdmission,
  onHandoff: () => void,
): Promise<string> {
  // 启动时快照全局当前模型:本次生成始终解析它,之后改选择不影响这一轮。
  const settings = readHuaanworkSettingsSync(routeCtx.profileDir)
  const activeModelId = settings.active_model_id
  const resolved = resolveSessionModel({
    sessionId,
    table: new Map([[sessionId, activeModelId]]),
    models: settings.models,
    active: { base_url: settings.base_url, model: settings.model, api_key: settings.api_key },
    allowNetwork: settings.allow_network,
  })
  // 模型绑定过不了门禁:按失败运行落盘(executeRun 的 catch),不能记成 admission skip,
  // 否则调度器会每个 tick 永久重试同一条。
  if (!resolved.ok) throw new Error(resolved.reason)
  const mergedPrefix = await mergedRunPrefix(routeCtx, automation)
  const body = [...(mergedPrefix ? ['上次成功运行的产出（截断至 4 KB）：', mergedPrefix] : []), automation.prompt ?? ''].join('\n')
  const missed = coalescedCount ?? 0
  const prompt = `<automation-fire name="${escapeXmlAttr(automation.name)}" trigger="${trigger}" missed="${missed}">\n${body}\n</automation-fire>`
  // 根表在 create/resume 与沙箱读取之前登记;模型表由 sendToAgent 在受理后写入。
  const root = pathResolve(admission.root)
  ctx.huaanworkSessionRoots?.set(sessionId, root)
  automationCollector.set(sessionId, { runId, text: '' })
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  // 无人值守范围只写本次运行的会话键;并发运行的其它会话各查各的键。
  const unattended = ctx.huaanworkUnattended
  const allow = automation.unattended?.enabled ? sanitizeUnattendedAllow(automation.unattended.allow) : undefined
  if (unattended && allow) {
    unattended.set(sessionId, { runId, automationId: automation.id, allow: new Set(allow), sessionId })
  }
  // sendToAgent 在 followup 受理后即返回;自动化要的是整轮产出,故 turn 还要等到 idle。
  // 超时与 drain 都作用在这个 turn 上。受理与 idle 两条路径都用同一个 releaseOnce。
  const turn = (async () => {
    onHandoff()
    await sendToAgent(
      ctx,
      routeCtx,
      { text: prompt, sessionId },
      { root, modelId: activeModelId, release: admission.release },
    )
    await automationSessionAgent(ctx, sessionId)?.whenIdle?.()
  })()
  // 本次运行的根/模型绑定只在 turn 真正 settle 时解除:drain 截止只是放弃等待,
  // 回合与其工具仍可能在跑,提前删除会让它们回落到前台根与全局模型。派生 promise
  // 的拒绝在这里消费(原 turn 的拒绝仍由 Promise.race / turn.catch 处理)。
  void turn
    .finally(() => {
      ctx.huaanworkSessionRoots?.delete(sessionId)
      ctx.huaanworkSessionModels?.delete(sessionId)
    })
    .catch(() => undefined)
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
      // 或卡在不可取消的回合)时 turn 可能永不 settle——无截止会让 collector/unattended
      // holder 泄漏,并让本根写者在回合真正结束前一直被这个超时轮占着。
      // 截止内 settle 保住「超时 turn 结束前下一个同根回合不启动」的串行意图;
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
    unattended?.delete(sessionId)
    // 写者释放由 sendToAgent 的准入释放器负责;根/模型绑定随 turn settle 解除(见上)。
  }
}

/**
 * 在跑脚本的 kill 句柄,按 runId 索引(规格 §8「脚本结束对应子进程」)。
 * 只登记到 `finish` 为止:`finish` 等 `close`(spawn 失败没有进程可等,随即结算),
 * 停止侧命中即杀进程树。
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

/**
 * 运行脚本并等到子进程真正 `close`。超时只负责杀进程树,完成 Promise 仍等 `close`:
 * 释放根写者必须发生在进程树退出之后,否则下一轮会在尚未收尾的目录里并发写。
 * 只有启动失败(`error` 且 Node 未赋 `pid`)没有可等的进程,按启动失败结算;
 * spawn 成功之后的 error(如 kill 失败)进程可能仍活着,同样等 `close`。
 */
export function runScript(
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
    let timedOut = false
    let spawnError: Error | undefined
    const finish = (ok: boolean, output: string) => {
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
      timedOut = true
      killProcessTree(child)
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < OUTPUT_MAX_CHARS * 2) stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < OUTPUT_MAX_CHARS * 2) stderr += chunk.toString()
    })
    // spawn 失败时 Node 不给 `pid`:没有可等的进程,立即结算。spawn 成功之后的
    // error(如 kill 失败)进程可能仍在写,先存下错误、等 close 再结算。
    child.on('error', (error) => {
      if (child.pid === undefined) finish(false, `${stdout}${stderr}\n${error.message}`)
      else spawnError ??= error
    })
    child.on('close', (code) => {
      if (timedOut) finish(false, `${stdout}${stderr}\n（任务超时，已终止）`)
      else if (spawnError !== undefined) finish(false, `${stdout}${stderr}\n${spawnError.message}\n（退出码 ${code ?? 'unknown'}）`)
      else if (code === 0) finish(true, stdout)
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
 * 执行体。写者名额由调用方(调度 tick / automation.run)在准入时占上;
 * 本函数只负责执行与释放:交接给子进程/模型回合之前的所有 return 与拒绝都释放,
 * 交接之后由子进程 `close` 或 `sendToAgent` 的回合结束释放。
 * ctx 必须穿透到 sendToAgent 的首参。
 */
export async function executeRun(
  ctx: AutomationRuntime,
  routeCtx: RouteContext,
  automation: AutomationInfo,
  trigger: AutomationTrigger,
  runId: string,
  admission: AutomationAdmission,
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
    admission.release()
    return
  }
  if (entry) entry.phase = 'started'
  const startedAt = Date.now()
  const sessionId = automation.kind === 'agent' ? automationRunSessionId(automation.id, runId) : undefined
  // agent 一旦把回合交给 sendToAgent 就由它负责释放;脚本与所有早退在下面统一释放。
  // 释放必须覆盖发射与 markAutomation 本身:准入方已经占坑,执行体在这里拒绝
  // (注册表不可写、磁盘满)时没有回合接手,不释放就会把根写者与 started 条目永久留在表里。
  let handedOff = false
  try {
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
        output = await runAgentTurn(
          ctx,
          routeCtx,
          automation,
          sessionId!,
          runId,
          trigger,
          coalescedCount,
          admission,
          () => {
            handedOff = true
          },
        )
      } else {
        const result = await runScript(
          automation.command ?? '',
          admission.root,
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
  } finally {
    // 脚本:runScript 只在 close 后返回,这里释放正好落在进程树退出之后。
    // 早退(排队期间被停、项目已删除)、执行体拒绝(如 markAutomation 写盘失败)
    // 与启动失败同样经过这里。未交接就摘条目:否则 stop 会命中一条永远不会结束的轮。
    if (!handedOff) {
      inFlightRuns.delete(runId)
      admission.release()
    }
  }
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

/** 一次准入唯一的写者释放器:释放根 → 消费用户队列 → 再评估到期自动化。 */
function createAdmissionRelease(
  ctx: AutomationRuntime,
  routeCtx: RouteContext,
  sessionId: string,
): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    releaseAndDrain(ctx, routeCtx, sessionId)
  }
}

/**
 * agent 自动化执行。写者已由准入方占上,这里直接跑;不再串 `automationTail`,
 * 也不再写全局 blocker 计数。释放只经过 `createAdmissionRelease` 的一个实例。
 */
export function enqueueAgentAutomation(automation: AutomationInfo, meta: AutomationRunMeta): Promise<void> {
  const { ctx, routeCtx } = requireBound()
  const admission: AutomationAdmission = {
    root: pathResolve(meta.root),
    release: createAdmissionRelease(ctx, routeCtx, automationRunSessionId(automation.id, meta.runId)),
  }
  return executeRun(ctx, routeCtx, automation, meta.trigger, meta.runId, admission, meta.coalescedCount).catch(
    (error: unknown) => {
      logFailure(error)
    },
  )
}

/** script 不占并发名额;槽位在准入成功后才获取,进程 `close` 后才释放根。 */
export function enqueueScriptAutomation(automation: AutomationInfo, meta: AutomationRunMeta): Promise<void> {
  const { ctx, routeCtx } = requireBound()
  const admission: AutomationAdmission = {
    root: pathResolve(meta.root),
    release: createAdmissionRelease(ctx, routeCtx, `script:${meta.runId}`),
  }
  return (async () => {
    await acquireScriptSlot()
    try {
      await executeRun(ctx, routeCtx, automation, meta.trigger, meta.runId, admission, meta.coalescedCount)
    } catch (error: unknown) {
      logFailure(error)
    } finally {
      releaseScriptSlot()
    }
  })()
}

/**
 * 已准入运行的唯一分派入口。写者名额与目标根由调用方(调度 tick / automation.run)
 * 占上;这里不再判定跨根,也不再自己准入。
 */
export function enqueueAutomation(automation: AutomationInfo, meta: AutomationRunMeta): Promise<void> {
  startInFlightRun({
    automationId: automation.id,
    runId: meta.runId,
    trigger: meta.trigger,
    kind: automation.kind,
    phase: 'queued',
    cancelRequested: false,
    slotConsumed: false,
  })
  return automation.kind === 'agent'
    ? enqueueAgentAutomation(automation, meta)
    : enqueueScriptAutomation(automation, meta)
}

