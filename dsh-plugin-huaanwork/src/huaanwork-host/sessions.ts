import { readdir, unlink } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { workNetworkGateError } from '@huaanwork/policy/network'
import type { SessionSummary } from '../client-huaanwork/rpc-types.ts'
import { dispatchAt, parseAtInvoke } from './agent-invoke.ts'
import { invokeSkillText } from './skill-invoke.ts'
import { resolveApproval, type ApprovalMap, type ApprovalResult } from './approvals.ts'
import { createUnavailableAgentsDirectory, type AgentsHost } from './agents-host.ts'
import { freshSessionIdFor, sessionIdFor } from './session-id.ts'
import { readHuaanworkSettings } from './settings.ts'
import { detailRecords, readSessionHeader, readSessionText, summarizeSessionLog } from './session-view.ts'
import type { RouteContext } from './routes.ts'

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
  agents?: {
    get?: (id: string) => ListedAgent | undefined
    list?: () => ListedAgent[]
    /** 运行时动态创建 agent + 新会话(dsh-agent 注册表工厂委托)。 */
    create?: (options: AgentCreateOptions) => Promise<unknown>
    /** 从持久化日志恢复历史会话为 live agent(携带完整上下文)。 */
    resume?: (options: AgentResumeOptions) => Promise<unknown>
  }
  subagents?: {
    start?: (
      provider: string,
      request: {
        prompt: Array<{ type: string; text: string }>
        persona?: string
        [key: string]: unknown
      },
    ) => Promise<unknown>
  }
}

/**
 * 发送侧阻塞源(旧 host.ts:464-501 的 workspaceRoot/userRoot 位移与
 * agentAutomationActive/agentAutomationQueued 计数)。M3 无后台自动化引擎,
 * 各源恒为初始值;检查逻辑逐字保留,M4 调度器接入后由 automation 域写入这里。
 */
export const sessionSendBlockers = {
  /** 旧 `workspaceRoot !== userRoot || restoringUserRoot`(后台任务位移/恢复中)。 */
  workspaceDisplaced: false,
  /** 旧 agentAutomationQueued(入队即 +1,restore 完成后 -1)。 */
  agentAutomationQueued: 0,
  /** 旧 agentAutomationActive(agent 任务占用运行时的计数)。 */
  agentAutomationActive: 0,
}

/** 旧 host.ts:484。workspace.open/close 与 session.new 共用;M4 调度器接入后写入 blockers。 */
export const assertAutomationIdle = (): void => {
  if (sessionSendBlockers.agentAutomationQueued > 0 || sessionSendBlockers.workspaceDisplaced) {
    throw new Error('后台自动化任务运行中，请稍候再试')
  }
}

/**
 * 发送侧阻塞(旧 host.ts:498):
 * 1) 位移中(workspaceRoot ≠ userRoot:跨项目 agent 任务运行中,或恢复被跳过/进行中):
 *    任何会话的 send/cancel 都拒绝。
 * 2) 同项目 agent 任务运行期间阻塞会话发送。
 */
const assertSessionSendable = (): void => {
  if (sessionSendBlockers.workspaceDisplaced) throw new Error('后台任务正在其他项目运行，工作区切换中，请稍候再试')
  if (sessionSendBlockers.agentAutomationActive > 0) throw new Error('后台自动化任务运行中，请稍候再试')
}

async function sendToAgent(
  ctx: SessionRuntimeContext,
  routeCtx: RouteContext,
  params: unknown,
): Promise<{ queued: true; sessionId: string }> {
  const explicitSessionId = objectString(params, 'sessionId')
  const sessionId = explicitSessionId ?? sessionIdFor(routeCtx.workspaceRoot.current)
  let skillName = objectString(params, 'skill')
  const rawAtName = objectAtName(params)
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

  // 联网门禁:未开公网时仅允许本机与局域网模型端点。
  const settings = await readHuaanworkSettings(routeCtx.profileDir)
  const blocked = workNetworkGateError({ allowNetwork: settings.allow_network, baseUrl: settings.base_url })
  if (blocked) throw new Error(blocked)

  let afterIdle: (() => Promise<void>) | undefined
  let cleanedUp = false
  const cleanup = async () => {
    if (cleanedUp) return
    cleanedUp = true
    await afterIdle?.()
  }

  try {
    // 显式 sessionId(对话标签绑定独立会话):不在场的会话按需 create / resume;
    // 缺省走通道稳定会话(boot 时由 agent-loop config 固定)。
    // 惰性解析:skill/@ 的校验失败必须先于 agent 创建抛错;@agent 时 dispatchAt 在
    // subagents.start 之前调 resolveAgent(),保证 parent 是当前会话 agent(spec 要求)。
    let agentPromise: Promise<ListedAgent & { followup: (message: unknown) => void }> | null = null
    const resolveAgent = () =>
      (agentPromise ??= explicitSessionId
        ? ensureChannelAgent(ctx, routeCtx, sessionId)
        : waitForAgent(ctx, sessionId))

    if (atName) {
      const parsedInText = parseAtInvoke(text)
      const remainder =
        rawAtName && parsedInText?.name === atName
          ? parsedInText.remainder
          : rawAtName
            ? text
            : (parsedAt?.remainder ?? '')
      const dispatched = await dispatchAt({
        host: agentsDirectory,
        ctx,
        sessionId,
        name: atName,
        remainder,
        resolveParent: resolveAgent,
      })
      text = dispatched.text
      afterIdle = dispatched.afterIdle
    } else if (skillName) {
      text = await invokeSkillText(routeCtx.profileDir, skillName, text)
    }

    const agent = await resolveAgent()
    agent.followup({
      id: `huaanwork-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    await agent.whenIdle?.()
    await cleanup()
  } finally {
    await cleanup()
  }
  return { queued: true, sessionId }
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
 * 跨工作区防护:持久化会话的 cwd 与当前工作区不一致时拒绝接管(AGENTS.md 不变式 6)。
 */
async function ensureChannelAgent(
  ctx: SessionRuntimeContext,
  routeCtx: RouteContext,
  sessionId: string,
): Promise<ListedAgent & { followup: (message: unknown) => void }> {
  const live = findAgentBySession(ctx, sessionId)
  if (typeof live?.followup === 'function') return live as ListedAgent & { followup: (message: unknown) => void }

  const agentOptions = { provider: 'deepseek-official', model: 'local' }
  const persisted = await findSessionHeader(join(routeCtx.dshHome, 'sessions'), sessionId)
  if (persisted) {
    const cwd = typeof persisted.cwd === 'string' ? persisted.cwd : ''
    if (cwd && resolve(cwd) !== resolve(routeCtx.workspaceRoot.current)) {
      throw new Error('该会话属于其他工作区，请先打开对应项目后再继续。')
    }
    if (typeof ctx.agents?.resume !== 'function') throw new Error('current dsh runtime cannot resume persisted sessions')
    await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
  } else {
    if (typeof ctx.agents?.create !== 'function') throw new Error('current dsh runtime cannot create session agents')
    await ctx.agents.create({ sessionId, meta: { cwd: routeCtx.workspaceRoot.current }, agentOptions })
  }

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const agent = findAgentBySession(ctx, sessionId)
    if (typeof agent?.followup === 'function') return agent as ListedAgent & { followup: (message: unknown) => void }
    await new Promise((done) => setTimeout(done, 25))
  }
  throw new Error(`agent for session ${sessionId} did not become ready`)
}

function cancelAgent(ctx: SessionRuntimeContext, routeCtx: RouteContext, params: unknown): { accepted: true } {
  const sessionId = objectString(params, 'sessionId') ?? sessionIdFor(routeCtx.workspaceRoot.current)
  const primary = findSessionAgent(ctx, sessionId)
  for (const agent of ctx.agents?.list?.() ?? []) {
    if (agent === primary) continue
    agent.cancel?.({ kind: 'parent' })
  }
  primary?.cancel?.({ kind: 'user' })
  return { accepted: true }
}

export type ListedAgent = {
  id?: string
  session?: { id?: string }
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

async function removeSession(sessionsRoot: string, params: unknown): Promise<{ removed: true }> {
  const sessionId = objectString(params, 'sessionId')
  if (!sessionId) throw new Error('session.remove requires params.sessionId')
  const located = await locateSessionFile(sessionsRoot, sessionId)
  if (!located) throw new Error(`session ${sessionId} was not found`)
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

async function sessionLogFiles(sessionsRoot: string): Promise<string[]> {
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

function objectBool(params: unknown, key: string): boolean {
  return Boolean(
    params && typeof params === 'object' && (params as Record<string, unknown>)[key] === true,
  )
}

// —— agents 目录(Task 10 真实接线前为空目录占位,见 agents-host.ts)——

let agentsDirectory: AgentsHost = createUnavailableAgentsDirectory()

/** Task 10 的 agents-host 真实实现接线时调用(与 agent.list/get 路由同一实例)。 */
export function setAgentsDirectory(directory: AgentsHost): void {
  agentsDirectory = directory
}

/** agent.list/get/refresh 路由与 @agent 分发共用同一目录实例(index.ts 注入)。 */
export function getAgentsDirectory(): AgentsHost {
  return agentsDirectory
}

// M4:automation run 归因 —— 旧 host.ts:315-326 的 runPendingApprovals(approval/asked
// 事件带运行会话 id 时记入该 runId 的集合,运行结束只拒绝本运行自己产生的审批)
// 属自动化引擎,M4 随 automations 域移植;此处为事件归因挂点。

// —— route handlers(旧 host.ts:978-1012 的 case 语义;错误消息逐字)——

export async function sessionSend(ctx: SessionRuntimeContext, routeCtx: RouteContext, params: unknown): Promise<unknown> {
  assertSessionSendable()
  return sendToAgent(ctx, routeCtx, params)
}

export function sessionCancel(ctx: SessionRuntimeContext, routeCtx: RouteContext, params: unknown): unknown {
  assertSessionSendable()
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

export async function sessionRemove(routeCtx: RouteContext, params: unknown): Promise<{ removed: true }> {
  return removeSession(join(routeCtx.dshHome, 'sessions'), params)
}

export function sessionNew(routeCtx: RouteContext, params: unknown): { sessionId: string } {
  const sessionId = objectBool(params, 'fresh')
    ? freshSessionIdFor(routeCtx.workspaceRoot.current)
    : sessionIdFor(routeCtx.workspaceRoot.current)
  return { sessionId }
}

export async function sessionResume(
  ctx: SessionRuntimeContext,
  routeCtx: RouteContext,
  params: unknown,
): Promise<{ sessionId: string; resumed: true }> {
  assertAutomationIdle()
  const sessionId = objectString(params, 'sessionId')
  if (!sessionId) throw new Error('session.resume requires params.sessionId')
  const persisted = await findSessionHeader(join(routeCtx.dshHome, 'sessions'), sessionId)
  if (!persisted) throw new Error(`session ${sessionId} was not found`)
  await ensureChannelAgent(ctx, routeCtx, sessionId)
  return { sessionId, resumed: true }
}

export async function sessionAnswerApproval(
  ctx: SessionRuntimeContext,
  routeCtx: RouteContext,
  params: unknown,
  result: ApprovalResult,
): Promise<{ handled: boolean }> {
  return answerApproval(ctx, routeCtx, params, result)
}
