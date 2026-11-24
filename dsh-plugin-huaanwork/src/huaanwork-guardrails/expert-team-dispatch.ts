/**
 * `expert_team_dispatch`:团长在团队回合内派工成员的模型工具(设计 §10.3 / §12.1 / §12.3)。
 *
 * 工具全局注册,但只在一个「进行中的团队回合」里可见:
 * - `makeExpertTeamClaimed` 在 `agent/inbox/claimed`(首步工具快照之前)同步判定:
 *   父会话有且只有一个 `running` 团队运行、本次用户消息 id 与该运行的
 *   `clientMessageId` 相同、且协调器租约仍有效时才挂载;普通回合、goal 续拍与
 *   已结算的团队回合一律对称摘除。mid-turn 注入的 notice/context claim
 *   (`source.kind` 不在回合边界白名单内)不改变挂载。摘除/挂载后同步 `refreshAgentRestrict`,
 *   因为 claim 早于 prompt assembly,把状态留给下一次 pre-step 会让首个请求看不到工具。
 * - 执行体再按同一附件与当前回合锚复核,并补上 `exec.callId`、父会话与
 *   `clientMessageId`;模型只提供 `memberId/kind/task/inputResultIds?/supersedesResultId?`,
 *   运行由 Host 依据父会话与回合锚绑定,`teamRunId` 永远不来自模型。
 *
 * 模型名放行见 `model.ts` 的 `isRegisteredToolName`:真实 SSE / 文本协议工具调用
 * 只有名字在白名单里才会被适配器透传,执行权限仍由附件与 policy 双重兜底。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { sessionIdOfAgentRef } from '@huaanwork/policy/channels'

import type {
  ExpertTeamCoordinator,
  ExpertTeamDispatchInput,
  ExpertTeamDispatchResult,
} from '../huaanwork-host/expert-team/coordinator.ts'
import type { ExpertTeamRunRegistry } from '../huaanwork-host/expert-team/runs.ts'
import { isTurnBoundaryMessage, type TurnAnchorStore } from '../huaanwork-host/turn-anchors.ts'
import {
  attachAgentTools,
  detachAgentTools,
  isAgentToolAttached,
  type AttachmentMaps,
} from './agent-attachments.ts'
import { refreshAgentRestrict } from './present-as.ts'

/** 工具与附件名;全局 ALLOWED_TOOLS 不含它,只在团队回合按附件与租约可见。 */
export const EXPERT_TEAM_DISPATCH_TOOL = 'expert_team_dispatch'

/** 模型指引:只派工,不替成员做事;重复派工前先看已有结果;引用只给 resultId。 */
const EXPERT_TEAM_DISPATCH_DESCRIPTION = [
  '在当前专家团运行中派工一名成员执行、审查或返修任务。',
  '- 只能派工本轮名册里的成员,按职责与调度规则选择执行者或审查者；',
  '- inputResultIds 只填已完成结果的 resultId,由 Host 渲染为引用正文；',
  '- revision 必须携带 supersedesResultId；execute 只在重试同一成员失败/停止的执行时携带；',
  '- 一次调用只派一名成员；等待返回结果后再决定下一步。',
].join('\n')

/**
 * 参数只允许模型提供派工内容:运行绑定(parentSessionId / clientMessageId / teamRunId)
 * 全由 Host 依据父会话、回合锚与有效租约补齐,模型无法指定或切换运行。
 */
const EXPERT_TEAM_DISPATCH_PARAMETERS = {
  memberId: { type: 'string', required: true, description: '本轮名册中的成员 id' },
  kind: {
    type: 'string',
    enum: ['execute', 'review', 'revision'],
    required: true,
    description: '派工类型:execute 执行、review 审查、revision 返修',
  },
  task: { type: 'string', required: true, description: '交给该成员的任务说明' },
  inputResultIds: {
    type: 'array',
    items: { type: 'string' },
    description: '引用的已完成结果 resultId 列表；没有引用就不传',
  },
  supersedesResultId: {
    type: 'string',
    description: '返修时必须填写被替代的结果 resultId；执行重试可选',
  },
} as const

const EXPERT_TEAM_DISPATCH_OUTPUT = {
  schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: { text: { type: 'string' as const, required: true as const } },
  },
  render(_args: unknown, value: { text: string }) {
    return [{ type: 'text' as const, text: value.text }]
  },
}

/** 模型可提供的派工参数;运行身份不在其中。 */
type ExpertTeamDispatchArgs = {
  memberId: string
  kind: 'execute' | 'review' | 'revision'
  task: string
  inputResultIds?: string[]
  supersedesResultId?: string
}

type ExpertTeamDispatchToolOutput = { text: string }

type ToolExec = { agent?: unknown; callId?: string }

type ToolContext = {
  tools?: { register(definition: unknown): () => void }
  huaanworkAttachments?: AttachmentMaps
  huaanworkTurnAnchors?: Pick<TurnAnchorStore, 'current'>
  huaanworkExpertTeamCoordinator?: Pick<ExpertTeamCoordinator, 'dispatch'>
}

/** 团长可见的派工结果文本:resultId 用于后续引用/返修,正文原样回给模型。 */
function dispatchResultText(result: ExpertTeamDispatchResult): string {
  const lines = [
    `派工结果：${result.resultId}`,
    `成员：${result.memberId}（@${result.agentSlug}）`,
    `类型：${result.kind}`,
    `状态：${result.status}`,
  ]
  if (result.inputResultIds.length > 0) lines.push(`引用结果：${result.inputResultIds.join('、')}`)
  if (result.reviewVerdict !== undefined) lines.push(`审查结论：${result.reviewVerdict}`)
  if (result.reviewError !== undefined) lines.push(`审查标记无效：${result.reviewError}`)
  if (result.error !== undefined) lines.push(`错误：${result.error}`)
  if (result.output !== undefined) lines.push('成员输出：', result.output)
  return lines.join('\n')
}

/** 把模型参数投影成协调器输入的可选字段;缺席保持缺席(exactOptionalPropertyTypes)。 */
function dispatchInputOf(
  args: ExpertTeamDispatchArgs,
  identity: { callId: string; parentSessionId: string; clientMessageId: string },
): ExpertTeamDispatchInput {
  return {
    callId: identity.callId,
    parentSessionId: identity.parentSessionId,
    clientMessageId: identity.clientMessageId,
    memberId: args.memberId,
    kind: args.kind,
    task: args.task,
    ...(args.inputResultIds !== undefined ? { inputResultIds: [...args.inputResultIds] } : {}),
    ...(args.supersedesResultId !== undefined ? { supersedesResultId: args.supersedesResultId } : {}),
  }
}

/**
 * 工具定义(授权级 spec,尚未编译)。
 *
 * 注册时才交给 `defineTool` 编译,因此这里的 `parameters` 保持作者面向的属性映射:
 * 测试与订阅方可以据此核对「模型可传哪些字段」,不必反解编译后的 JSON Schema。
 *
 * @param ctx tools 服务与 holder 的桥接对象
 * @returns 团长派工工具定义
 */
export function expertTeamDispatchDefinition(ctx: ToolContext) {
  return {
    name: EXPERT_TEAM_DISPATCH_TOOL,
    description: EXPERT_TEAM_DISPATCH_DESCRIPTION,
    parameters: EXPERT_TEAM_DISPATCH_PARAMETERS,
    output: EXPERT_TEAM_DISPATCH_OUTPUT,
    /** 派工可并行进入上游池:团队信号量、顺序与单成员限制在协调器入口独立强制。 */
    isConcurrencySafe(_args: unknown): boolean {
      return true
    },
    async execute(args: ExpertTeamDispatchArgs, exec: ToolExec): Promise<ExpertTeamDispatchToolOutput> {
      const sessionId = sessionIdOfAgentRef(exec?.agent as { id?: string; session?: { id?: string } } | undefined)
      const callId = exec?.callId
      if (!sessionId || callId === undefined || callId.trim() === '') {
        throw new Error('expert-team-dispatch-context-missing')
      }
      if (!isAgentToolAttached(ctx.huaanworkAttachments, sessionId, EXPERT_TEAM_DISPATCH_TOOL)) {
        throw new Error('expert-team-dispatch-not-attached')
      }
      const clientMessageId = ctx.huaanworkTurnAnchors?.current(sessionId)?.clientMessageId
      const coordinator = ctx.huaanworkExpertTeamCoordinator
      if (clientMessageId === undefined || coordinator === undefined) {
        throw new Error('expert-team-dispatch-context-missing')
      }
      const result = await coordinator.dispatch(
        dispatchInputOf(args, { callId, parentSessionId: sessionId, clientMessageId }),
      )
      return { text: dispatchResultText(result) }
    },
  }
}

/**
 * 全局注册 `expert_team_dispatch`。
 *
 * @param ctx tools 服务与 holder 的桥接对象(工具子插件内构建)
 * @returns 卸下工具的 disposer;缺少 tools 服务时为空 disposer
 */
export function registerExpertTeamDispatchTool(ctx: unknown): () => void {
  const c = ctx as ToolContext
  if (!c.tools?.register) return () => undefined
  return c.tools.register(defineTool(expertTeamDispatchDefinition(c)))
}

type ExpertTeamClaimedContext = {
  huaanworkAttachments: AttachmentMaps
  huaanworkTurnAnchors?: Pick<TurnAnchorStore, 'notePreStep'>
  huaanworkExpertTeamRuns?: Pick<ExpertTeamRunRegistry, 'activeBySession'>
  huaanworkExpertTeamCoordinator?: Pick<ExpertTeamCoordinator, 'isLeaseValid'>
}

type ExpertTeamClaimedPayload = { agent: Agent; message: UserMessage; turn: number }

/**
 * `agent/inbox/claimed` 的同步团队附件切换(设计 §12.1 第 3/4 条)。
 *
 * 判定只有一种「挂载」事实:父会话存在 `running` 团队运行、本次 claim 的用户消息 id
 * 等于运行登记的 `clientMessageId`、且租约有效。goal 续拍(沿用旧锚、消息 id 不同)
 * 与普通回合因此都不命中,必须对称摘除,避免过期团队回合继续派工。
 *
 * `agent/inbox/claimed` 对每条 next-step 认领都触发,不只在回合边界:第 1 步之后
 * `repeat-tool-reminder` 等插件会经 `additionalContexts` 向 `next-step` 注入
 * `UserMessage`(如 `source.kind: 'repeat-tool-reminder'`)。这些注入不是回合边界,
 * 只有回合边界 claim 才改变挂载,否则一次注入就会把进行中的团队回合派工工具摘掉。
 *
 * 先幂等登记回合锚(与 `makeResultPresentClaimed` 共享 `notePreStep`,重复调用不刷新),
 * 不依赖两个监听器的注册先后。同步异常不能只 throw——notification 的异常会被分发器
 * 吞掉——必须 `agent.cancel` 取消 driver,阻断本回合。
 *
 * @param ctx Host ctx;`refreshAgentRestrict` 复用同一 Context 上 present-as 的 state
 * @returns 同步通知处理器
 */
export function makeExpertTeamClaimed(ctx: ExpertTeamClaimedContext) {
  return function noteExpertTeamAttachment({ agent, message }: ExpertTeamClaimedPayload): void {
    const sessionId = sessionIdOfAgentRef(agent)
    if (!sessionId) return
    try {
      ctx.huaanworkTurnAnchors?.notePreStep(sessionId, [message], new Date().toISOString())
      // mid-turn 注入(notice/context)不是回合边界:保持当前挂载,不重新判定。
      if (!isTurnBoundaryMessage(message)) return
      const active = ctx.huaanworkExpertTeamRuns?.activeBySession(sessionId)
      const wantAttached =
        active !== undefined &&
        active.status === 'running' &&
        message.id === active.clientMessageId &&
        ctx.huaanworkExpertTeamCoordinator?.isLeaseValid(active.teamRunId) === true
      const attached = isAgentToolAttached(ctx.huaanworkAttachments, sessionId, EXPERT_TEAM_DISPATCH_TOOL)
      if (wantAttached === attached) return
      if (wantAttached) attachAgentTools(ctx.huaanworkAttachments, sessionId, [EXPERT_TEAM_DISPATCH_TOOL])
      else detachAgentTools(ctx.huaanworkAttachments, sessionId, [EXPERT_TEAM_DISPATCH_TOOL])
      refreshAgentRestrict(ctx as never, sessionId)
    } catch {
      // notification 的异常会被分发器吞掉;必须取消 driver,不能靠 throw 阻断请求。
      agent.cancel({ kind: 'hook', reason: 'expert-team-attachment-sync-failed' })
    }
  }
}
