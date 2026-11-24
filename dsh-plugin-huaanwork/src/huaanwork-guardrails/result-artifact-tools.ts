/**
 * `result_present`:普通父会话提交任务结果页的模型工具(设计 §「结果页」/ 计划 Task 2)。
 *
 * 工具全局注册,但可见性有三层:present-as 的会话附件、policy 的 attached 判定、
 * 工具执行体内的附件复核。附件不来自全局 ALLOWED_TOOLS,而是 `agent/inbox/claimed`
 * 里按共享回合锚点的 `origin` 同步:只有 advanced(普通用户在界面发送并已 claim)
 * 才挂载;automation / unknown(兼容回合、未登记包儿童)一律摘除。
 *
 * claim 发生在 prompt assembly 之前,因此工具能在**首请求**就进入模型面;挂载/摘除
 * 后同步 `refreshAgentRestrict`,不把这一状态留给下一次 `agent/pre-step`(它晚于
 * tools snapshot)。处理器本身不能 async,notification 抛错会被分发器吞掉,所以同步
 * 失败必须通过 `agent.cancel` 取消 driver 阻断本回合。
 *
 * 输入只有 title/format/content/downloadName?;运行时校验统一由 artifacts-host 的
 * `prepareArtifact` 执行,工具层不重复实现,只把具名错误透传给模型。
 *
 * 专家团回合的主 Artifact 提交在执行体内叠加团队校验(设计 §12.4.1):提交前按持久
 * 回合锚核对运行与预算豁免,commit 前复查取消与租约,commit 后按持久 manifest 锚
 * 封闭交付并幂等关联;同一 `callId` 重放只走幂等裁决与关联恢复。普通回合语义不变。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { sessionIdOfAgentRef } from '@huaanwork/policy/channels'

import type { ArtifactFormat, RpcEvent } from '../client-huaanwork/rpc-types.ts'
import {
  beginArtifactWrite,
  commitPreparedArtifact,
  discardPreparedArtifact,
  prepareArtifact,
} from '../huaanwork-host/artifacts-host.ts'
import {
  ExpertTeamCoordinatorError,
  type ExpertTeamCoordinator,
} from '../huaanwork-host/expert-team/coordinator.ts'
import { canSubmitPrimaryArtifact } from '../huaanwork-host/expert-team/orchestration.ts'
import type { ExpertTeamRunRegistry } from '../huaanwork-host/expert-team/runs.ts'
import type { TurnAnchorStore } from '../huaanwork-host/turn-anchors.ts'
import {
  attachAgentTools,
  detachAgentTools,
  isAgentToolAttached,
  type AttachmentMaps,
} from './agent-attachments.ts'
import { refreshAgentRestrict } from './present-as.ts'

/** 工具与附件名;全局 ALLOWED_TOOLS 不含它,只经会话附件可见。 */
export const RESULT_PRESENT_TOOL = 'result_present'

/** 模型指引逐字固定:报告形态选择、普通答复不调用、同一交付物只提交一次、回复不重复正文。 */
export const RESULT_PRESENT_DESCRIPTION = [
  '- 报告、分析、列表、表格、代码说明和线性文档优先使用 Markdown；',
  '- 需要非线性布局、图表或交互的可视化结果使用 HTML；',
  '- 普通对话答复不调用该工具；',
  '- 同一交付物只提交一次，不同时提交两种格式；',
  '- 工具成功后的最终助手回复只给简短说明，不重复完整 content。',
].join('\n')

type ResultPresentArgs = {
  title: string
  format: string
  content: string
  downloadName?: string
}

type ToolContext = {
  tools?: { register(definition: unknown): () => void }
  huaanworkEmit?: (event: RpcEvent) => void
  huaanworkAttachments?: AttachmentMaps
  huaanworkTurnAnchors?: Pick<TurnAnchorStore, 'current'>
  /** 团队回合按父会话 + 持久回合锚解析运行；生产由 Host `toolCtx` 注入同一实例。 */
  huaanworkExpertTeamRuns?: ExpertTeamRunRegistry
  huaanworkExpertTeamCoordinator?: Pick<ExpertTeamCoordinator, 'isLeaseValid' | 'hasInFlight'>
}

/** commit 成功但运行关联失败时的稳定标记;Artifact 与事件保留,团队按不完整交付结算。 */
const ARTIFACT_LINK_FAILED = 'expert-team-artifact-link-failed'

type ToolExec = { agent?: unknown; callId?: string }

const textOutput = {
  schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: { text: { type: 'string' as const, required: true as const } },
  },
  render(_args: unknown, value: { text: string }) {
    return [{ type: 'text' as const, text: value.text }]
  },
}

function resultPresentTool(ctx: ToolContext, profileDir: string) {
  return defineTool({
    name: RESULT_PRESENT_TOOL,
    description: RESULT_PRESENT_DESCRIPTION,
    parameters: {
      title: { type: 'string', required: true, description: '结果页标题（不能为空，不能含换行）' },
      format: { type: 'string', required: true, description: '正文格式：markdown 或 html' },
      content: { type: 'string', required: true, description: '结果正文全文，Markdown 或 HTML 源码' },
      downloadName: { type: 'string', description: '另存为时的建议文件名；可省略，默认由标题生成' },
    },
    output: textOutput,
    async execute(args: ResultPresentArgs, exec: ToolExec) {
      const sessionId = sessionIdOfAgentRef(exec?.agent as { id?: string; session?: { id?: string } } | undefined)
      if (!sessionId || !exec.callId) throw new Error('result-present-context-missing')
      if (!isAgentToolAttached(ctx.huaanworkAttachments, sessionId, RESULT_PRESENT_TOOL)) {
        throw new Error('result-present-not-attached')
      }
      const runs = ctx.huaanworkExpertTeamRuns
      const coordinator = ctx.huaanworkExpertTeamCoordinator
      const anchor = ctx.huaanworkTurnAnchors?.current(sessionId)
      // 用持久回合锚查团队运行(而非 activeBySession):已终态/已封存的团队回合在
      // 同锚 goal 续拍中仍被命中;下一条普通用户回合查不到团队、保持普通语义。
      const teamRun = anchor === undefined ? undefined : runs?.byTurn(sessionId, anchor.clientMessageId)
      // 同一 callId 重放只进入幂等裁决与关联恢复,不因交付封闭/取消被二次拒绝。
      const isIdempotentReplay =
        teamRun !== undefined &&
        teamRun.primaryArtifactCallId !== undefined &&
        teamRun.primaryArtifactCallId === exec.callId
      if (teamRun !== undefined && !isIdempotentReplay) {
        if (coordinator === undefined) throw new Error('expert-team-coordinator-missing')
        if (!coordinator.isLeaseValid(teamRun.teamRunId)) {
          throw new ExpertTeamCoordinatorError('expert-team-lease-invalid')
        }
        const decision = canSubmitPrimaryArtifact(teamRun, {
          inFlight: coordinator.hasInFlight(teamRun.teamRunId),
          artifactFormat: args.format as ArtifactFormat,
          callId: exec.callId,
        })
        // 提交前拒绝发生在 ArtifactHost 之前,不改变 artifactStatus。
        if (!decision.ok) throw new Error(decision.error)
      }
      const write = beginArtifactWrite(profileDir, {
        sessionId,
        anchor: { kind: 'turn', ...(anchor?.clientMessageId !== undefined ? { clientMessageId: anchor.clientMessageId } : {}) },
        idempotency: { kind: 'tool', callId: exec.callId },
      })
      try {
        await prepareArtifact(write, {
          title: args.title,
          // 格式白名单由 prepareArtifact 运行时校验;工具层只透传具名错误。
          format: args.format as ArtifactFormat,
          content: args.content,
          ...(args.downloadName !== undefined ? { downloadName: args.downloadName } : {}),
        })
        if (teamRun !== undefined && !isIdempotentReplay) {
          // prepare 后、commit 前复查取消闩、交付封闭与团队租约;此刻已失效则绝不提交新 Artifact。
          const liveRun = runs?.byTurn(sessionId, teamRun.clientMessageId) ?? teamRun
          if (liveRun.status !== 'running') {
            await discardPreparedArtifact(write)
            throw new ExpertTeamCoordinatorError('expert-team-terminal')
          }
          if (liveRun.deliverySealed) {
            await discardPreparedArtifact(write)
            throw new Error('expert-team-delivery-sealed')
          }
          if (coordinator?.isLeaseValid(teamRun.teamRunId) !== true) {
            await discardPreparedArtifact(write)
            throw new ExpertTeamCoordinatorError('expert-team-lease-invalid')
          }
        }
        // created 在 profile 锁内裁决:并发/重放同 callId 只有一次 true,事件不重复。
        const { artifact, created } = await commitPreparedArtifact(write)
        // 关联目标一律以持久 manifest 锚为准,不用 goal 续拍时的当前锚。
        const persistedRun =
          artifact.anchor.kind === 'turn' && artifact.anchor.clientMessageId !== undefined
            ? runs?.byTurn(sessionId, artifact.anchor.clientMessageId)
            : undefined
        if (created) {
          if (teamRun !== undefined && runs !== undefined) {
            runs.sealDelivery(teamRun.teamRunId, exec.callId)
            const linked = runs.noteSessionArtifact(sessionId, exec.callId, artifact)
            // commit 已成功:关联失败只记残态,绝不删除 Artifact 或伪报未创建。
            if (!linked) runs.noteArtifactLinkError(teamRun.teamRunId, ARTIFACT_LINK_FAILED)
          }
          ctx.huaanworkEmit?.({ event: 'artifact/created', artifact, sessionId })
        } else if (persistedRun !== undefined && runs !== undefined) {
          // 同 callId 重放(即使当前锚已切走):只恢复持久锚运行,绝不封存当前锚对应运行。
          runs.sealDelivery(persistedRun.teamRunId, exec.callId)
          const linked = runs.noteSessionArtifact(sessionId, exec.callId, artifact)
          if (!linked) runs.noteArtifactLinkError(persistedRun.teamRunId, ARTIFACT_LINK_FAILED)
        }
        return { text: `已生成结果页“${artifact.title}”。artifactId: ${artifact.artifactId}` }
      } finally {
        await discardPreparedArtifact(write)
      }
    },
  })
}

/**
 * 全局注册 `result_present`。
 *
 * @param ctx tools 服务与 holder 的桥接对象(工具子插件内构建)
 * @param profileDir Host `apply()` 的 config.profileDir;Artifact 存储根
 * @returns 卸下工具的 disposer;缺少 tools 服务时为空 disposer
 */
export function registerResultArtifactTools(ctx: unknown, profileDir: string): () => void {
  const c = ctx as ToolContext
  if (!c.tools?.register) return () => undefined
  return c.tools.register(resultPresentTool(c, profileDir))
}

type ResultPresentClaimedContext = {
  huaanworkTurnAnchors?: TurnAnchorStore
  huaanworkAttachments: AttachmentMaps
  huaanworkExpertTeamRuns?: Pick<ExpertTeamRunRegistry, 'byTurn'>
}

type ResultPresentClaimedPayload = { agent: Agent; message: UserMessage }

/**
 * `agent/inbox/claimed` 的同步附件切换(通知模式:payload 为 `{agent,message}`,无
 * `next`)。claim 早于 prompt assembly,所以这里必须同步完成 attach/detach + restrict。
 *
 * 只有 advanced 回合保留工具;无新用户消息的 goal 续轮沿用原锚点因此状态不变;
 * register 只登记 pending,不触碰当前附件。
 *
 * @param ctx Host ctx;`refreshAgentRestrict` 复用同一 Context 上 present-as 的 state
 * @returns 同步通知处理器
 */
export function makeResultPresentClaimed(ctx: ResultPresentClaimedContext) {
  return function noteResultPresentAttachment({ agent, message }: ResultPresentClaimedPayload): void {
    const sessionId = sessionIdOfAgentRef(agent)
    if (!sessionId) return
    try {
      const anchor = ctx.huaanworkTurnAnchors?.notePreStep(sessionId, [message], new Date().toISOString())
      // 仅会话模式的团队回合不挂 result_present;Artifact 模式团队与普通高级会话保持原行为。
      const teamRun = anchor === undefined
        ? undefined
        : ctx.huaanworkExpertTeamRuns?.byTurn(sessionId, anchor.clientMessageId)
      const messageDeliveryTeam = teamRun?.teamSnapshot.summary.delivery === 'message'
      const wantAttached = anchor?.origin === 'advanced' && !messageDeliveryTeam
      const attached = isAgentToolAttached(ctx.huaanworkAttachments, sessionId, RESULT_PRESENT_TOOL)
      if (wantAttached === attached) return
      if (wantAttached) attachAgentTools(ctx.huaanworkAttachments, sessionId, [RESULT_PRESENT_TOOL])
      else detachAgentTools(ctx.huaanworkAttachments, sessionId, [RESULT_PRESENT_TOOL])
      refreshAgentRestrict(ctx as never, sessionId)
    } catch {
      // notification 的异常会被分发器吞掉;必须取消 driver,不能靠 throw 阻断请求。
      agent.cancel({ kind: 'hook', reason: 'result-present-attachment-sync-failed' })
    }
  }
}
