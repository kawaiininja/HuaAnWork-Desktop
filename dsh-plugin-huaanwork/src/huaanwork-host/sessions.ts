import { existsSync, statSync } from 'node:fs'
import { readdir, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { AttachmentMaps } from '../huaanwork-guardrails/agent-attachments.ts'
import { forgetConfirmedTarget, settlePlanReview } from '../huaanwork-guardrails/question-answerer.ts'
import { answerRouteInput, cancelRouteInput, clearInvalidRoute, releaseRouteInput } from '../huaanwork-guardrails/route-tool-plugin.ts'
import type { SessionSummary } from '../client-huaanwork/rpc-types.ts'
import {
  attachCreationTools,
  detectAgentCreationIntent,
  detectCreateAgentCommand,
  detachCreationTools,
  getAgentPackageHost,
  injectCreateAgentSkill,
  noteCreationTurn,
} from './agent-package/creation.ts'
import { isAgentCancelText } from './agent-package/drafts.ts'
import type { AgentPackageActiveTurnRegistry } from './agent-package/host.ts'
import { dispatchAt, parseAtInvoke } from './agent-invoke.ts'
import { invokeSkillText } from './skill-invoke.ts'
import { resolveApproval, type ApprovalMap, type ApprovalResult } from './approvals.ts'
import type { AgentsHost } from './agents-host.ts'
import {
  childrenOf,
  forgetChildSession,
  forgetChildSessions,
} from './child-sessions.ts'
import { freshSessionIdFor, sessionIdFor } from './session-id.ts'
import { readHuaanworkSettings } from './settings.ts'
import { resolveSessionModel } from './session-models.ts'
import { listProjects, listTasks, setTaskModel } from './stores.ts'
import type { QueueItem, TurnScheduler } from './turn-scheduler.ts'
import { writableRootForSession } from './writable-root.ts'
import { detailRecords, readSessionHeader, readSessionText, summarizeSessionLog } from './session-view.ts'
import type { RouteContext } from './routes.ts'
import type { SubagentsService } from './subagents-service.ts'
import type { SubagentRunRegistry } from './subagent-runs.ts'

/**
 * 会话域主链路(旧 sidecar host.ts L1434-1740 移植)。
 * 定向改动(逐处,禁全局替换):
 * - `writer`/events 推送全部不存在于本层——事件由 guardrails/bridge.ts 经
 *   `ctx.huaanworkEmit` 间接层(Task 4 holders)推 WS;本层只留
 *   `// M4:automation run 归因` 挂点(旧 host.ts:315-326 的 runPendingApprovals
 *   归因属自动化,M4 移植);
 * - 网络门禁读 Task 5 的 readHuaanworkSettings(routeCtx.profileDir);
 * - sessionIdFor/freshSessionIdFor import 自 Task 3 的 session-id.ts(唯一事实源);
 * - settingsPath 概念不存在:旧 env.settingsPath → routeCtx.profileDir;
 *   旧 env.dshHome → routeCtx.dshHome;旧 env.agents → agentsDirectory(Task 10 前为
 *   空目录占位,见 agents-host.ts);
 * - 旧 DshContext → 内联 SessionRuntimeContext(同一 duck-type 风格,旧 host.ts:194 的
 *   风格延续);调用方传 routeCtx.runtimeCtx(holders.ts 注入真实 cordis ctx);
 * - console.warn/console.error → routeCtx.logger。
 */

export type SessionRuntimeContext = {
  huaanworkApprovals?: ApprovalMap
  /** question-answerer 登记的未回答 plan-review 结算器(holders.ts 注入容器)。 */
  huaanworkPlanReviews?: Map<string, () => boolean>
  /** 创建工具与 `@slug` 运行工具的会话附件表(holders.ts 注入)。 */
  huaanworkAttachments?: AttachmentMaps
  /** 工作区热切换时同步的沙箱根;缺席时只改 routeCtx.workspaceRoot holder。 */
  sandboxPolicy?: { workspaceRoot?: string }
  /** cordis Context.get。sandboxPolicy 未注入到本插件时,用它做全局查找。 */
  get?: (name: string) => unknown
  agents?: {
    get?: (id: string) => ListedAgent | undefined
    list?: () => ListedAgent[]
    /** 运行时动态创建 agent + 新会话(dsh-agent 注册表工厂委托)。 */
    create?: (options: AgentCreateOptions) => Promise<unknown>
    /** 从持久化日志恢复历史会话为 live agent(携带完整上下文)。 */
    resume?: (options: AgentResumeOptions) => Promise<unknown>
  }
  subagents?: SubagentsService
  /** 子代理 run 权威状态机(holders.ts 注入);执行链与 subagent.* 路由读同一实例。 */
  huaanworkSubagentRuns?: SubagentRunRegistry
  /** 会话 → 模型条目 id 的绑定表(holders.ts 注入);`followup` 受理后写入。 */
  huaanworkSessionModels?: Map<string, string>
  /** 会话 → 可写根(holders.ts 注入);创建/恢复前写入。 */
  huaanworkSessionRoots?: Map<string, string>
  /** 唯一回合调度器(holders.ts 注入);用户发送准入与排队出队共用。 */
  huaanworkTurnScheduler?: TurnScheduler
}

/** 一次已准入的用户回合:根与模型由 `sessionSend`/出队复检算好。 */
export type AgentTurnAdmission = {
  root: string
  modelId: string
  /** 本次准入的唯一释放器:`scheduler.release` → 消费 `drainQueue()`。 */
  release: () => void
  /** 出队后、followup 前的协作取消判据(排队项取消或删除会话时置真)。 */
  cancelled?: () => boolean
  /** followup 前中断且 `@` 激活已发布:名额归 idle 清理,调用方不得现在释放。 */
  deferRelease?: () => void
}

export type SendResult = {
  queued: true
  sessionId: string
  started: boolean
  /** 未启动的原因;排队出队据此填 queue-fail。取消路径没有前置 `agent/notice`,由客户端自行渲染。 */
  reason?: string
}

export async function sendToAgent(
  ctx: SessionRuntimeContext,
  routeCtx: RouteContext,
  params: unknown,
  admission?: AgentTurnAdmission,
): Promise<SendResult> {
  const explicitSessionId = objectString(params, 'sessionId')
  const sessionId = explicitSessionId ?? sessionIdFor(routeCtx.workspaceRoot.current)
  let skillName = objectString(params, 'skill')
  const rawAtName = objectAtName(params)
  const atClientMessageId = objectAtClientMessageId(params)
  if (skillName && rawAtName) {
    routeCtx.logger('session.send: at overrides skill')
    skillName = undefined
  }
  let text = objectString(params, 'text') ?? ''
  const parsedAt = skillName ? undefined : parseAtInvoke(text)
  const atName = rawAtName ?? parsedAt?.name
  if (!atName && !skillName && !text) {
    throw new Error('session.send requires params.text')
  }

  // 每一轮用户原句都记进宿主:同意门禁只认最近一轮,技能/@ 轮若旁路不记,
  // agent_commit 会读到更早那轮的「可以」(设计 §5)。创建门禁内的记录是同一句,
  // 重复写入无副作用。
  getAgentPackageHost()?.noteUserText(sessionId, text)

  let afterIdle: (() => Promise<void>) | undefined
  let cleanedUp = false
  const releaseOnce = admission?.release
  const cleanup = async () => {
    if (cleanedUp) return
    cleanedUp = true
    try {
      // @agent 的子代理可能仍在写根:先等它的清理收尾,再等被 `delivery: 'parent'`
      // 摘要回合唤醒的父会话重新 idle。finally 保证清理抛错也不会把根写者留在手上。
      if (afterIdle === undefined) return
      await afterIdle()
      await acceptedAgent?.whenIdle?.()
    } finally {
      releaseOnce?.()
    }
  }
  // followup 受理后立即返回。@ HTTP 工具的 detach 只在 idle 之后跑，
  // 成功路径和 finally 共用这一次登记，避免回合中途解绑或解绑两次。
  let detachScheduled = false
  let followupAccepted = false
  let acceptedAgent: { whenIdle?: () => Promise<void> } | undefined
  const scheduleDetachAfterIdle = () => {
    if (detachScheduled) return
    detachScheduled = true
    const idle = acceptedAgent?.whenIdle?.() ?? Promise.resolve()
    void idle.then(() => cleanup(), () => cleanup()).catch(() => undefined)
  }

  try {
    // 出队后已被取消(取消等待项或删除会话):不再创建/恢复 agent,名额由 finally 释放。
    if (admission?.cancelled?.()) return { queued: true, sessionId, started: false, reason: '已取消' }
    // 显式 sessionId(对话标签绑定独立会话):不在场的会话按需 create / resume;
    // 缺省走通道稳定会话(boot 时由 agent-loop config 固定)。
    // 惰性解析:skill/@ 的校验失败必须先于 agent 创建抛错;@agent 时 dispatchAt 在
    // startActivation 之前调 resolveAgent(),保证 parent 是当前会话 agent(spec 要求)。
    let agentPromise: Promise<ListedAgent & { followup: (message: unknown) => void }> | null = null
    const resolveAgent = () =>
      (agentPromise ??= (async () => {
        const resolved = explicitSessionId
          ? await ensureChannelAgent(ctx, routeCtx, sessionId, admission?.root)
          : await waitForAgent(ctx, sessionId)
        // create/resume 已经落盘,但取消发生在等待期间:抛错以阻止 @ 的 dispatchAt
        // 发布 activation,也阻止后续 followup。
        if (admission?.cancelled?.()) throw new Error('已取消')
        return resolved
      })())

    // 创建入口(设计 §6.1):规范说法、`/create-agent`(文本或 skill 参数)或已有草稿时,
    // 在技能/@ 分发与 agent 解析之前接管本轮。未注入宿主门面时整段旁路。
    const packageHost = getAgentPackageHost()
    const createSkillEntry = packageHost !== undefined && skillName === 'create-agent'
    if (createSkillEntry) skillName = undefined
    const creationIntent =
      !atName && !skillName
        ? createSkillEntry
          ? detectCreateAgentCommand(text)
          : detectAgentCreationIntent(text)
        : undefined
    const activeDraft = !atName && !skillName && packageHost?.hasDraft(sessionId) === true
    if (packageHost && (creationIntent !== undefined || activeDraft)) {
      noteCreationTurn(sessionId, text)
      if (isAgentCancelText(text) && (await packageHost.cancel(sessionId))) {
        detachCreationTools(ctx, sessionId)
        const notice = '已取消创建，没有写入智能体。'
        routeCtx.emit({ event: 'agent/notice', text: notice, sessionId })
        return { queued: true, sessionId, started: false, reason: notice }
      }
      if (creationIntent?.kind === 'update') {
        try {
          await packageHost.beginUpdate(sessionId, creationIntent.slug)
        } catch (error) {
          // 坏的 update 目标(不存在/已损坏)回一条会话提示,不把整次发送变成路由错误。
          const notice = `无法进入更新模式：${error instanceof Error ? error.message : String(error)}`
          routeCtx.emit({
            event: 'agent/notice',
            text: notice,
            sessionId,
          })
          return { queued: true, sessionId, started: false, reason: notice }
        }
      }
      const mode = creationIntent?.kind ?? 'continue'
      text = injectCreateAgentSkill(
        creationIntent ? creationIntent.initialText || text : text,
        mode,
        creationIntent?.kind === 'update' ? creationIntent.slug : undefined,
      )
      // 工具跨轮保持挂载,只在 commit 成功或取消时卸下(设计 §6.2):
      // 访谈首轮提出草稿前没有草稿,不能按「回合结束是否有草稿」判断。
      attachCreationTools(ctx, sessionId)
    }

    if (atName) {
      const parsedInText = parseAtInvoke(text)
      const remainder =
        rawAtName && parsedInText?.name === atName
          ? parsedInText.remainder
          : rawAtName
            ? text
            : (parsedAt?.remainder ?? '')
      const dispatched = await dispatchAt({
        host: agentsDirectory ?? EMPTY_AGENTS_HOST,
        ctx,
        sessionId,
        name: atName,
        remainder,
        resolveParent: resolveAgent,
        // 客户端在 session.send 时用 at.clientMessageId 带上本次用户消息 id;Host 只把
        // 它随 run 投影原样返回,用于把运行卡片锚定到这条消息之后。
        ...(atClientMessageId === undefined ? {} : { clientMessageId: atClientMessageId }),
        // `@slug` 先认本地包:目录快照里没有的 slug 也必须在 agentsHost 查找前分流。
        ...(packageHost === undefined ? {} : { packageHost, packageRuntime: packageHost }),
      })
      text = dispatched.parentText ?? dispatched.text
      afterIdle = dispatched.afterIdle
    } else if (skillName) {
      text = await invokeSkillText(routeCtx.profileDir, skillName, text)
    }

    const agent = await resolveAgent()
    acceptedAgent = agent
    // followup 前的最后一次检查(取消不经过任何 await 就能落到这一步):
    // `afterIdle` 已由 @ 激活登记时,finally 会把名额交给 idle 清理而不是提前释放,
    // 并通过 `deferRelease` 让调用方同样延后自己的释放。
    if (admission?.cancelled?.()) {
      return { queued: true, sessionId, started: false, reason: '已取消' }
    }
    clearInvalidRoute(sessionId)
    agent.followup({
      id: `huaanwork-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    followupAccepted = true
    if (admission !== undefined) {
      // 只在 followup 受理后公布绑定:创建取消/更新失败没有交给模型,不改旧绑定。
      ctx.huaanworkSessionModels?.set(sessionId, admission.modelId)
      if (ctx.huaanworkSessionRoots?.has(sessionId) !== true) {
        ctx.huaanworkSessionRoots?.set(sessionId, admission.root)
      }
    }
    scheduleDetachAfterIdle()
  } finally {
    // 已启动子代理时根写者归 idle 清理持有:立即释放会与仍在写根的子代理重叠。
    // 返回 `started: false` 与 followup 抛错都走同一出口,调用方经 `deferRelease` 得知延后。
    if (!followupAccepted) {
      if (afterIdle === undefined) releaseOnce?.()
      else admission?.deferRelease?.()
    }
    scheduleDetachAfterIdle()
  }
  return { queued: true, sessionId, started: true }
}

/** 按会话 id 精确定位 live agent(不做通道默认回落)。 */
function findAgentBySession(ctx: SessionRuntimeContext, sessionId: string): ListedAgent | undefined {
  const direct = ctx.agents?.get?.(sessionId)
  if (direct) return direct
  return ctx.agents?.list?.().find((agent) => agent.id === sessionId || agent.session?.id === sessionId)
}

/**
 * 确保指定会话有 live agent:
 * 已 live 直接复用;磁盘上有持久化日志则 resume(恢复完整上下文);否则以该 id 新建。
 * 根取调用方传入的 `admissionRoot`(准入时冻结的根),未传入才查 `huaanworkSessionRoots`,
 * 仍未命中才按项目/任务/header 推导;持久化会话的 `cwd` 必须存在且落在该根内,否则
 * 拒绝接管(缺 `cwd` 时工作目录不可验证,同样 fail closed;AGENTS.md 不变式 6)。两条
 * 路径都不读前台根。
 */
async function ensureChannelAgent(
  ctx: SessionRuntimeContext,
  routeCtx: RouteContext,
  sessionId: string,
  admissionRoot?: string,
): Promise<ListedAgent & { followup: (message: unknown) => void }> {
  const live = findAgentBySession(ctx, sessionId)
  if (typeof live?.followup === 'function') return live as ListedAgent & { followup: (message: unknown) => void }

  const agentOptions = { provider: 'deepseek-official', model: 'local' }
  const persisted = await findSessionHeader(join(routeCtx.dshHome, 'sessions'), sessionId)
  const roots = ctx.huaanworkSessionRoots
  let root = admissionRoot ?? roots?.get(sessionId)
  if (root === undefined) {
    const projects = await listProjects(routeCtx.profileDir)
    const tasks = await listTasks(routeCtx.profileDir)
    root = writableRootForSession({
      profileDir: routeCtx.profileDir,
      sessionId,
      projects,
      tasks,
      headerCwd: typeof persisted?.cwd === 'string' ? persisted.cwd : undefined,
    })
  }
  if (persisted) {
    const cwd = typeof persisted.cwd === 'string' ? persisted.cwd : ''
    if (!cwd || !isInside(root, cwd)) {
      throw new Error('该会话属于其他工作区，请先打开对应项目后再继续。')
    }
    if (typeof ctx.agents?.resume !== 'function') throw new Error('current dsh runtime cannot resume persisted sessions')
    roots?.set(sessionId, root)
    await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
  } else {
    if (typeof ctx.agents?.create !== 'function') throw new Error('current dsh runtime cannot create session agents')
    roots?.set(sessionId, root)
    await ctx.agents.create({ sessionId, meta: { cwd: root }, agentOptions })
  }

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const agent = findAgentBySession(ctx, sessionId)
    if (typeof agent?.followup === 'function') return agent as ListedAgent & { followup: (message: unknown) => void }
    await new Promise((done) => setTimeout(done, 25))
  }
  throw new Error(`agent for session ${sessionId} did not become ready`)
}

/** 「等于根或在根之内」,与 writable-root / sandbox-cwd 同规则。 */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function cancelAgent(ctx: SessionRuntimeContext, routeCtx: RouteContext, params: unknown): { accepted: true } {
  const sessionId = objectString(params, 'sessionId') ?? sessionIdFor(routeCtx.workspaceRoot.current)
  // 只取消绑定在该会话上的 agent;通道默认 agent 可能正在跑兄弟会话,不能替它按停止。
  const primary = findAgentBySession(ctx, sessionId)
  const childIds = new Set(childrenOf(sessionId))
  for (const agent of ctx.agents?.list?.() ?? []) {
    if (agent === primary) continue
    const id = agent.session?.id ?? agent.id
    if (id === undefined || !childIds.has(id)) continue
    agent.cancel?.({ kind: 'parent' })
  }
  primary?.cancel?.({ kind: 'user' })
  releaseRouteInput(sessionId)
  // Task 10:包回合的占位(pendingTurns)只在 record.cancel 的 cleanup 里释放,
  // 只等 agent 的 idle 会让同一会话一直无法开始新回合。这里同步发起取消
  // (record.cancel 会立刻 abort 并开始 dispose),不阻塞路由应答。
  if (agentPackageActiveTurns !== undefined) {
    void agentPackageActiveTurns.cancelBySessionId(sessionId, 'cancel').catch(() => undefined)
  }
  return { accepted: true }
}

export type ListedAgent = {
  id?: string
  session?: { id?: string }
  status?: string
  followup?: (message: unknown) => void
  whenIdle?: () => Promise<void>
  cancel?: (reason: { kind: 'parent' | 'user' }) => void
  ctx?: {
    get?: (name: string) =>
      | {
          restrict?: unknown
          schemas?: () => readonly { name?: string }[]
        }
      | undefined
  }
}

type AgentFactoryOptions = { provider: string; model: string }
type AgentCreateOptions = { sessionId: string; meta?: { cwd?: string }; agentOptions?: AgentFactoryOptions }
type AgentResumeOptions = { resumeSessionId: string; agentOptions?: AgentFactoryOptions }

export const AGENT_ID = 'huaanwork'

/** 主 agent-loop 配置的通道 agent(id='huaanwork'),带通道会话 id 回落匹配。 */
export function findSessionAgent(ctx: SessionRuntimeContext, sessionId: string): ListedAgent | undefined {
  const bySession = ctx.agents?.get?.(sessionId)
  if (typeof bySession?.followup === 'function' || typeof bySession?.cancel === 'function') return bySession
  const byId = ctx.agents?.get?.(AGENT_ID)
  if (typeof byId?.followup === 'function' || typeof byId?.cancel === 'function') return byId
  return ctx.agents?.list?.().find((agent) => {
    const id = agent.id
    const sid = agent.session?.id
    return sid === sessionId || id === sessionId || id === AGENT_ID
  })
}

async function waitForAgent(
  ctx: SessionRuntimeContext,
  sessionId: string,
): Promise<ListedAgent & { followup: (message: unknown) => void }> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const agent = findSessionAgent(ctx, sessionId)
    if (typeof agent?.followup === 'function') return agent as ListedAgent & { followup: (message: unknown) => void }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('session.send requires the Task 5 agent-loop plugins to be booted')
}

async function answerApproval(
  ctx: SessionRuntimeContext,
  routeCtx: RouteContext,
  params: unknown,
  result: ApprovalResult,
): Promise<{ handled: boolean }> {
  const approvals = ctx.huaanworkApprovals
  if (!approvals) return { handled: false }
  const approvalRequestId = objectString(params, 'approvalRequestId')
  if (!approvalRequestId || !resolveApproval(approvals, approvalRequestId, result)) {
    routeCtx.logger('Ignoring unknown sidecar approval request')
    return { handled: false }
  }
  return { handled: true }
}

// —— 会话日志存储(旧 host.ts:1373-1432;根由调用方传入,Task 10 复用)——

async function listSessions(sessionsRoot: string): Promise<SessionSummary[]> {
  const files = await sessionLogFiles(sessionsRoot)
  const summaries = await Promise.all(files.map(async (file) => summarizeSessionLog(await readSessionText(file))))
  return summaries
    .filter((summary): summary is SessionSummary => summary !== undefined)
    .sort((a, b) => b.lastTime - a.lastTime)
}

async function openSession(sessionsRoot: string, params: unknown): Promise<unknown> {
  const sessionId = objectString(params, 'sessionId')
  if (!sessionId) throw new Error('session.open requires params.sessionId')
  const located = await locateSessionFile(sessionsRoot, sessionId)
  if (!located) throw new Error(`session ${sessionId} was not found`)
  const text = await readSessionText(located.file)
  return {
    header: located.header,
    log: text,
    records: detailRecords(text),
    summary: summarizeSessionLog(text),
  }
}

/** 递归收集已登记的后代会话;父会话删除时它们的模型/根键一并清掉。 */
function descendantSessionIds(sessionId: string): string[] {
  const collected: string[] = []
  const seen = new Set<string>()
  const pending = [...childrenOf(sessionId)]
  while (pending.length > 0) {
    const id = pending.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    collected.push(id)
    pending.push(...childrenOf(id))
  }
  return collected
}

/**
 * 删除会话前必须先释放的运行态：等待中的卡片、绑定的 live agent、子会话登记、
 * 坏参数计数与上一份已确认的计划目标。`session.remove` 与 task/project 级联删除
 * 两条路径共用同一实现，避免只清文件、留下会继承到同名新会话的旧状态。
 */
export function releaseSessionRuntime(ctx: SessionRuntimeContext | undefined, sessionId: string): void {
  // 后代名单在 forgetChildSessions 之前快照:登记表清空后就查不到了。
  const descendants = descendantSessionIds(sessionId)
  releaseRouteInput(sessionId)
  if (ctx) findAgentBySession(ctx, sessionId)?.cancel?.({ kind: 'user' })
  // 等待项一并收掉:否则下一次 drain 会对已删除会话走 sendToAgent → ensureChannelAgent,
  // 无 header 后重新 create,已删除会话被复活并执行排队文本(最终评审 Important 2)。
  // 只动队列,不碰活动写者:删除会话不是对执行中回合的提前 release。
  ctx?.huaanworkTurnScheduler?.cancelQueuedItemsForSession(sessionId)
  forgetChildSessions(sessionId)
  forgetChildSession(sessionId)
  clearInvalidRoute(sessionId)
  forgetConfirmedTarget(sessionId)
  if (ctx) {
    for (const id of [sessionId, ...descendants]) {
      ctx.huaanworkSessionModels?.delete(id)
      ctx.huaanworkSessionRoots?.delete(id)
    }
  }
}

async function removeSession(
  ctx: SessionRuntimeContext | undefined,
  sessionsRoot: string,
  params: unknown,
): Promise<{ removed: true }> {
  const sessionId = objectString(params, 'sessionId')
  if (!sessionId) throw new Error('session.remove requires params.sessionId')
  const located = await locateSessionFile(sessionsRoot, sessionId)
  if (!located) throw new Error(`session ${sessionId} was not found`)
  // 删日志之前先把会话从运行态里摘出来（见 releaseSessionRuntime 的注释）。
  releaseSessionRuntime(ctx, sessionId)
  await unlink(located.file)
  return { removed: true }
}

/** 按 header.id 定位会话日志文件(含 .jsonl.zstd);不存在返回 undefined。 */
async function locateSessionFile(
  sessionsRoot: string,
  sessionId: string,
): Promise<{ file: string; header: Record<string, unknown> } | undefined> {
  for (const file of await sessionLogFiles(sessionsRoot)) {
    const header = await readSessionHeader(file)
    if (header?.id === sessionId) return { file, header }
  }
  return undefined
}

/** 只读定位会话头(ensureChannelAgent 用以判定 create 还是 resume)。 */
export async function findSessionHeader(
  sessionsRoot: string,
  sessionId: string,
): Promise<Record<string, unknown> | undefined> {
  const located = await locateSessionFile(sessionsRoot, sessionId)
  return located?.header
}

/** 递归枚举会话日志文件(含 `.jsonl.zstd`);sessions 根不存在返回空数组。 */
export async function sessionLogFiles(sessionsRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(sessionsRoot, { recursive: true, withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')))
      .map((entry) => join(entry.parentPath, entry.name))
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return []
    throw error
  }
}

/** 会话是否工作在指定项目目录(含子目录)内——项目隔离的会话过滤依据。 */
function sessionWithinRoot(session: SessionSummary, root: string): boolean {
  if (typeof session.cwd !== 'string' || !session.cwd) return false
  const cwd = resolve(session.cwd)
  const base = resolve(root)
  return cwd === base || cwd.startsWith(`${base}${sep}`)
}

function objectString(params: unknown, key: string): string | undefined {
  return params && typeof params === 'object' && typeof (params as Record<string, unknown>)[key] === 'string'
    ? (params as Record<string, string>)[key]
    : undefined
}

function objectAtName(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined
  const at = (params as Record<string, unknown>).at
  if (!at || typeof at !== 'object') return undefined
  const name = (at as Record<string, unknown>).name
  if (typeof name !== 'string') return undefined
  const trimmed = name.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * 本次 `session.send` 对应的用户消息 id(`at.clientMessageId`)。
 *
 * 只在 `at` 里读,与 `objectAtName` 同形(字符串、去空白后非空);它不是取消
 * capability,也不参与 runId 生成或权限判断,只用于把运行卡片锚定到这条消息。
 */
function objectAtClientMessageId(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined
  const at = (params as Record<string, unknown>).at
  if (!at || typeof at !== 'object') return undefined
  const clientMessageId = (at as Record<string, unknown>).clientMessageId
  if (typeof clientMessageId !== 'string') return undefined
  const trimmed = clientMessageId.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function objectBool(params: unknown, key: string): boolean {
  return Boolean(
    params && typeof params === 'object' && (params as Record<string, unknown>)[key] === true,
  )
}

// —— agents 目录(与 agent.list/get/refresh 路由及 @agent 分发共用同一实例,由 index.ts 注入)——

const EMPTY_AGENTS_HOST: AgentsHost = {
  list: () => ({ items: [] }),
  refresh: async () => ({ items: [] }),
  get: async () => undefined,
  setEnabled: () => {
    throw new Error('agentsDirectory is not initialized')
  },
  addEndpoint: () => ({
    ok: false,
    fieldErrors: [{ field: 'name', message: 'agentsDirectory is not initialized' }],
  }),
  removeEndpoint: () => {
    throw new Error('agentsDirectory is not initialized')
  },
  snapshotForRuntime: () => ({ items: [] }),
}

let agentsDirectory: AgentsHost | null = null

/** agents-host 真实实现接线时调用(与 agent.list/get 路由同一实例)。 */
export function setAgentsDirectory(directory: AgentsHost): void {
  agentsDirectory = directory
}

/** agent.list/get/refresh 路由与 @agent 分发共用同一目录实例(index.ts 注入)。 */
export function getAgentsDirectory(): AgentsHost {
  if (!agentsDirectory) {
    throw new Error('agentsDirectory is not initialized')
  }
  return agentsDirectory
}

/**
 * 智能体包宿主单例(创建入口与 Task 7 路由共用)。
 *
 * 实例由 `index.ts` 在 agentsHost 之后注入;实现住在 `agent-package/creation.ts`,
 * 这里按 `setAgentsDirectory` 的同一模式转出公开入口。
 */
export { getAgentPackageHost, setAgentPackageHost } from './agent-package/creation.ts'

/**
 * 在途包回合登记表(Task 10)。与 host、catalog-security 共用同一实例,
 * `session.cancel` 必须走它才能连同 `pendingTurns` 占位一起释放。
 */
let agentPackageActiveTurns: AgentPackageActiveTurnRegistry | undefined

/** index 在创建 host 之后注入;测试可直接换入自己的实例。 */
export function setAgentPackageActiveTurns(registry: AgentPackageActiveTurnRegistry | undefined): void {
  agentPackageActiveTurns = registry
}

// 审批归因在 automations-host.ingestAutomationEvent(approval/asked 的 sessionId → runId)。

// —— route handlers(旧 host.ts:978-1012 的 case 语义;错误消息逐字)——

// —— 回合调度接线(Task 6)——

/**
 * 到期自动化的一次评估(Task 8)。index.ts 注入 automation-scheduler 导出的
 * `evaluateDueAutomations`;sessions.ts 不反过来 import 调度器,避免循环依赖。
 */
let reevaluateDueAutomations: (() => void) | undefined

/** Task 8 在 index.ts 注入单次评估函数;传 undefined 恢复空实现。 */
export function setReevaluateDueAutomations(fn: (() => void) | undefined): void {
  reevaluateDueAutomations = fn
}

/**
 * 只消费一次用户队列,再评估一次到期自动化,不释放任何回合名额
 * (F1/GUI 3.4:settings.set 调大并发上限后的主动排空——等待项无需活动回合
 * release 即可出队;调度器按当前上限与根写者自检,名额已满时是 no-op)。
 * 与 `releaseAndDrain` 共用同一套顺序,不复制两份。
 */
export function drainUserQueue(ctx: SessionRuntimeContext, routeCtx: RouteContext): void {
  const scheduler = ctx.huaanworkTurnScheduler
  if (scheduler === undefined) return
  for (const item of scheduler.drainQueue()) void startQueuedItem(ctx, routeCtx, item)
  reevaluateDueAutomations?.()
}

/**
 * 释放一个回合名额,再消费一次用户队列,最后再评估一次到期自动化
 * (Task 8:automations-host 复用同一个释放器,不复制这套顺序)。
 */
export function releaseAndDrain(ctx: SessionRuntimeContext, routeCtx: RouteContext, sessionId: string): void {
  const scheduler = ctx.huaanworkTurnScheduler
  if (scheduler === undefined) return
  scheduler.release(sessionId)
  drainUserQueue(ctx, routeCtx)
}

/** 每次准入一个释放器:晚到的第二次 idle 回调不会放掉接手的那一回合。 */
function createReleaseOnce(
  ctx: SessionRuntimeContext,
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
 * 队列项出队后重新复检根目录、模型条目与网络门禁,通过才把同一组
 * text/skill/at 交给 `sendToAgent`。失败项只发 `session/queue-fail`,不重新入队,
 * 也不发 `session/queue-start`;名额由本函数释放,除非启动已延后给 `@` 激活的 idle 清理。
 * 启动受理(已发 `session/queue-start`)之后的失败只记日志:回合已在跑,名额不得回收。
 */
async function startQueuedItem(
  ctx: SessionRuntimeContext,
  routeCtx: RouteContext,
  item: QueueItem,
): Promise<void> {
  const scheduler = ctx.huaanworkTurnScheduler
  const releaseOnce = createReleaseOnce(ctx, routeCtx, item.sessionId)
  /** `@` 激活已发布时启动未完成(取消返回或 followup 抛错):名额归 idle 清理,`fail` 不得提前释放。 */
  let deferred = false
  /** followup 已受理:其后的事件或写回失败不得回退成失败项,名额归 idle 清理。 */
  let started = false
  const fail = (reason: string): void => {
    try {
      routeCtx.emit({
        event: 'session/queue-fail',
        sessionId: item.sessionId,
        tabId: item.tabId,
        queueItemId: item.queueItemId,
        reason,
      })
    } finally {
      // emit 抛错也必须让出名额,否则后续等待项永远起不来;延后的名额由 idle 清理释放。
      if (!deferred) releaseOnce()
    }
  }

  try {
    if (!existsSync(item.root) || !statSync(item.root).isDirectory()) {
      fail('可写根目录不存在')
      return
    }
    const settings = await readHuaanworkSettings(routeCtx.profileDir)
    const resolved = resolveSessionModel({
      sessionId: item.sessionId,
      table: new Map([[item.sessionId, item.modelId]]),
      models: settings.models,
      active: { base_url: settings.base_url, model: settings.model, api_key: settings.api_key },
      allowNetwork: settings.allow_network,
    })
    if (!resolved.ok) {
      fail(resolved.reason)
      return
    }
    const result = await sendToAgent(
      ctx,
      routeCtx,
      {
        text: item.text,
        sessionId: item.sessionId,
        ...(item.skill === undefined ? {} : { skill: item.skill }),
        ...(item.at === undefined ? {} : { at: item.at }),
      },
      {
        root: item.root,
        modelId: item.modelId,
        release: releaseOnce,
        cancelled: () => scheduler?.isStartCancelled(item.queueItemId) === true,
        // sendToAgent 在 `@` 激活已发布时(取消返回或 followup 抛错)回调此处,
        // 让 `fail` 跳过提前释放;名额由 idle 清理的唯一一次 `releaseOnce` 接手。
        deferRelease: () => {
          deferred = true
        },
      },
    )
    if (!result.started) {
      fail(result.reason ?? '排队回合未能启动')
      return
    }
    started = true
    // followup 受理即公布启动:其后的写回 await 会重新打开「取消找不着消息」的窗口。
    routeCtx.emit({
      event: 'session/queue-start',
      sessionId: item.sessionId,
      tabId: item.tabId,
      queueItemId: item.queueItemId,
    })
    // 出队且 followup 受理后才写回任务模型(排队期间不写)。
    await rememberTaskModel(routeCtx, item.sessionId, item.modelId)
  } catch (error) {
    if (started) {
      // 回合已经在跑:失败的只是启动后的事件/写回,不能回收名额或补发 queue-fail。
      routeCtx.logger(
        `session.send: 排队回合已启动,启动后事件失败(${item.sessionId}):${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    fail(error instanceof Error ? error.message : String(error))
  } finally {
    scheduler?.finishStart(item.queueItemId)
  }
}

/**
 * 子任务记住本次准入的模型:只在回合真正交给模型之后调用(排队期间不写,避免选择先于事实落盘)。
 * 已有 modelId 的任务不被改写;写盘失败只记日志——回合已经开始,不能把发送报告成失败。
 */
async function rememberTaskModel(routeCtx: RouteContext, sessionId: string, modelId: string): Promise<void> {
  try {
    const task = (await listTasks(routeCtx.profileDir)).find((item) => item.sessionId === sessionId)
    if (task === undefined || task.modelId !== undefined) return
    await setTaskModel(routeCtx.profileDir, { taskId: task.id, modelId })
  } catch (error) {
    routeCtx.logger(`session.send: 子任务模型写回失败(${sessionId}):${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 用户发送:先载入项目/任务/header 推导可写根,按本次 `modelId` 过门禁与调度器
 * 准入,然后交给 `sendToAgent`。只占名额不等待回合:已开始返回 `started: true`,
 * 排队返回 `waiting: true`。
 */
export async function sessionSend(ctx: SessionRuntimeContext, routeCtx: RouteContext, params: unknown): Promise<unknown> {
  const text = objectString(params, 'text') ?? ''
  const skillName = objectString(params, 'skill')
  const atName = objectAtName(params) ?? (skillName === undefined ? parseAtInvoke(text)?.name : undefined)
  if (!text && !skillName && !atName) throw new Error('session.send requires params.text')
  const tabId = objectString(params, 'tabId')
  if (!tabId) throw new Error('session.send 缺少标签')

  const sessionId = objectString(params, 'sessionId') ?? sessionIdFor(routeCtx.workspaceRoot.current)
  const projects = await listProjects(routeCtx.profileDir)
  const tasks = await listTasks(routeCtx.profileDir)
  const header = await findSessionHeader(join(routeCtx.dshHome, 'sessions'), sessionId)
  const root = writableRootForSession({
    profileDir: routeCtx.profileDir,
    sessionId,
    projects,
    tasks,
    headerCwd: typeof header?.cwd === 'string' ? header.cwd : undefined,
  })
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error('可写根目录不存在')
  }
  const settings = await readHuaanworkSettings(routeCtx.profileDir)
  const modelId = objectString(params, 'modelId') ?? settings.active_model_id
  const resolved = resolveSessionModel({
    sessionId,
    table: new Map([[sessionId, modelId]]),
    models: settings.models,
    active: { base_url: settings.base_url, model: settings.model, api_key: settings.api_key },
    allowNetwork: settings.allow_network,
  })
  if (!resolved.ok) throw new Error(resolved.reason)
  const scheduler = ctx.huaanworkTurnScheduler
  if (scheduler === undefined) throw new Error('回合调度器未初始化')

  const clientMessageId = objectAtClientMessageId(params)
  const admitted = scheduler.admitUserTurn({
    sessionId,
    tabId,
    text,
    modelId,
    root,
    ...(skillName === undefined ? {} : { skill: skillName }),
    ...(atName === undefined ? {} : { at: { name: atName, ...(clientMessageId === undefined ? {} : { clientMessageId }) } }),
  })
  if (admitted.kind === 'error') throw new Error(admitted.reason)
  if (admitted.kind === 'queued') {
    return { queued: true, waiting: true, started: false, sessionId, queueItemId: admitted.queueItemId }
  }

  const releaseOnce = createReleaseOnce(ctx, routeCtx, sessionId)
  const result = await sendToAgent(ctx, routeCtx, params, {
    root: admitted.root,
    modelId,
    release: releaseOnce,
  })
  if (result.started) await rememberTaskModel(routeCtx, sessionId, modelId)
  return { queued: true, waiting: false, started: result.started, sessionId }
}

export function sessionCancel(ctx: SessionRuntimeContext, routeCtx: RouteContext, params: unknown): unknown {
  const queueItemId = objectString(params, 'queueItemId')
  if (queueItemId !== undefined) {
    // 只移除等待项:活动写者仍在执行,不能顺手取消它的 agent 或释放名额。
    ctx.huaanworkTurnScheduler?.cancelQueuedItem(queueItemId)
    return { accepted: true }
  }
  return cancelAgent(ctx, routeCtx, params)
}

export async function sessionList(routeCtx: RouteContext, root: string | undefined): Promise<SessionSummary[]> {
  const sessions = await listSessions(join(routeCtx.dshHome, 'sessions'))
  const topLevel = sessions.filter((session) => session.origin !== 'subagent' && !session.parentSession)
  return root ? topLevel.filter((session) => sessionWithinRoot(session, root)) : topLevel
}

export async function sessionOpen(routeCtx: RouteContext, params: unknown): Promise<unknown> {
  return openSession(join(routeCtx.dshHome, 'sessions'), params)
}

export async function sessionRemove(
  ctx: SessionRuntimeContext | undefined,
  routeCtx: RouteContext,
  params: unknown,
): Promise<{ removed: true }> {
  return removeSession(ctx, join(routeCtx.dshHome, 'sessions'), params)
}

export function sessionNew(routeCtx: RouteContext, params: unknown): { sessionId: string; cwd: string } {
  // 请求带现存绝对目录时为新会话用它;否则仍用前台根。两种情况都不移动工作区。
  const requested = objectString(params, 'cwd')
  const cwd = requested !== undefined && isAbsolute(requested) && existsSync(requested) && statSync(requested).isDirectory()
    ? resolve(requested)
    : routeCtx.workspaceRoot.current
  const sessionId = objectBool(params, 'fresh')
    ? freshSessionIdFor(cwd)
    : sessionIdFor(cwd)
  return { sessionId, cwd }
}

export async function sessionResume(
  ctx: SessionRuntimeContext,
  routeCtx: RouteContext,
  params: unknown,
): Promise<{ sessionId: string; resumed: true }> {
  const sessionId = objectString(params, 'sessionId')
  if (!sessionId) throw new Error('session.resume requires params.sessionId')
  const persisted = await findSessionHeader(join(routeCtx.dshHome, 'sessions'), sessionId)
  if (!persisted) throw new Error(`session ${sessionId} was not found`)
  await ensureChannelAgent(ctx, routeCtx, sessionId)
  return { sessionId, resumed: true }
}

/**
 * 「退出计划模式」:先确认会话 agent 与 `planMode` 都在。缺一则不结算评审,
 * 返回 `{ exited: false }`,计划模式保持原样。两者都在时,先把未回答的 plan-review
 * 以取消结算,让等待中的 `exit_plan_mode` 结束回合,再 `planMode.set(agent, false)`。
 * 顺序不能反:先退出会让那次评审一直停住。
 * 没有可结算的评审而回合还在跑时停止这一回合,不让模型离开计划模式后接着写。
 */
export function sessionExitPlanMode(
  ctx: SessionRuntimeContext,
  routeCtx: RouteContext,
  params: unknown,
): { exited: boolean } {
  const sessionId = objectString(params, 'sessionId') ?? sessionIdFor(routeCtx.workspaceRoot.current)
  // 目标会话没有 live agent 时不能借通道默认 agent 退出计划模式——那可能是兄弟会话。
  const agent = findAgentBySession(ctx, sessionId)
  const planMode = ctx.get?.('planMode') as { set?: (agent: unknown, active: boolean) => unknown } | undefined
  if (!agent || typeof planMode?.set !== 'function') return { exited: false }
  const settled = settlePlanReview(ctx.huaanworkPlanReviews, sessionId)
  planMode.set(agent, false)
  if (!settled && agent.status === 'running') agent.cancel?.({ kind: 'user' })
  return { exited: true }
}

/** `request_input` 的对话卡片：提交的文字作为工具结果回到同一回合；`cancel: true` 结束这次调用并停止回合。 */
export function sessionAnswerInput(params: unknown): { handled: boolean } {
  const sessionId = objectString(params, 'sessionId')
  if (!sessionId) return { handled: false }
  if (objectBool(params, 'cancel')) return { handled: cancelRouteInput(sessionId) }
  const answer = objectString(params, 'answer')?.trim()
  if (!answer) return { handled: false }
  return { handled: answerRouteInput(sessionId, answer) }
}

export async function sessionAnswerApproval(
  ctx: SessionRuntimeContext,
  routeCtx: RouteContext,
  params: unknown,
  result: ApprovalResult,
): Promise<{ handled: boolean }> {
  return answerApproval(ctx, routeCtx, params, result)
}
