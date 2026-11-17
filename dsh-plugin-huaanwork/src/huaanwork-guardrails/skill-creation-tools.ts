import { defineTool } from '@deepseek-ai/dsh-tools'
import { sessionIdOfAgentRef } from '@huaanwork/policy/channels'

import type { RpcEvent, SkillConfirmCard } from '../client-huaanwork/rpc-types.ts'
import { trackSessionPendingDetach, type AttachmentMaps } from './agent-attachments.ts'
import {
  CorruptSkillCreationDraftError,
  contentPreviewOf,
  type SkillCommitResult,
  type SkillProposalInput,
  type SkillProposeResult,
} from '../huaanwork-host/skill-creation-drafts.ts'
import {
  SKILL_COMMIT_TOOL,
  SKILL_PROPOSE_TOOL,
  detachSkillCreationTools,
  type SkillCreationHost,
} from '../huaanwork-host/skill-creation.ts'

export { SKILL_COMMIT_TOOL, SKILL_CREATION_TOOLS, SKILL_PROPOSE_TOOL } from '../huaanwork-host/skill-creation.ts'

/**
 * 对话创建技能的两个模型工具(设计 §6.2、§8.2)。
 *
 * 两个工具全局注册;可见性与执行权由 `sessionAgentTools` 附件 + present-as 的
 * restrict + policy 的 attached 判定三层控制,与智能体创建链路同一纵深。
 * 工具只投影提案的四个字段与一个 `draftId`,不接受路径、脚本、URL 或启用标记。
 */

type ToolContext = {
  tools?: { register(definition: unknown): () => void }
  huaanworkEmit?: (event: RpcEvent) => void
  huaanworkAttachments?: AttachmentMaps
  /**
   * `tools/result` 观察器。commit 成功后的解绑必须等工具结果定稿再做:
   * 上游会按工具名重新解析工具来归一化结果,执行体内解绑会把成功改写成
   * `UNKNOWN_TOOL`,连 `concludesTurn` 标记一起丢掉。
   */
  huaanworkOnToolResult?: (listener: (exec: { callId?: string }) => void) => () => void
  /** 工具子插件是桥接对象;present-as 的 restrict 状态挂在根 Context 上。 */
  root?: object
}

type ToolExec = { agent?: unknown; callId?: string; concludeTurn?: () => void }

type AgentRef = { id?: string; session?: { id?: string } }

type SkillProposeArgs = {
  name: string
  description: string
  whenToUse?: string
  body: string
}

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

const SUCCESS_TEXT = (name: string): string => `已保存技能 ${name}，请在“我的技能”中启用`

/** 损坏草稿的对外口径:给出可执行的恢复入口,不携带内部路径或异常正文。 */
const CORRUPT_DRAFT_TEXT =
  '技能创建草稿已损坏，无法继续；请发送 `/create-skill cancel` 清理草稿后重新开始。'

/**
 * 会话只来自本次执行上下文里的 agent;没有 agent 时该次工具调用直接失败,
 * 不写回任何会话。
 */
function sessionIdOf(exec: ToolExec | undefined): string {
  const sessionId = sessionIdOfAgentRef(exec?.agent as AgentRef | undefined)
  if (!sessionId) throw new Error('当前没有可用于创建技能的会话')
  return sessionId
}

function emit(ctx: ToolContext, event: RpcEvent): void {
  ctx.huaanworkEmit?.(event)
}

/** 工具参数 → 宿主入参:只投影声明过的字段,可选字段缺席时保持缺席。 */
function proposalFromArgs(args: SkillProposeArgs): SkillProposalInput {
  return {
    name: args.name,
    description: args.description,
    ...(args.whenToUse !== undefined ? { whenToUse: args.whenToUse } : {}),
    body: args.body,
  }
}

function cardTextOf(card: SkillConfirmCard): string {
  return [
    `技能名称：${card.name}`,
    `描述：${card.description}`,
    ...(card.whenToUse !== undefined ? [`触发场景：${card.whenToUse}`] : []),
    `正文摘要：${card.contentPreview}`,
    '确认创建：回复「确认」；继续修改：直接说明要改的地方；取消：回复「取消」。',
  ].join('\n')
}

function fieldErrorsText(fieldErrors: readonly { field: string; message: string }[]): string {
  return fieldErrors.map((error) => `${error.field}: ${error.message}`).join('\n')
}

/** 损坏草稿:发一条可执行提示并抛模型可读错误,绝不泄漏原始内部异常。 */
function throwCorruptDraft(ctx: ToolContext, sessionId: string): never {
  emit(ctx, { event: 'skill/notice', text: CORRUPT_DRAFT_TEXT, sessionId })
  throw new Error(CORRUPT_DRAFT_TEXT)
}

function proposeTool(ctx: ToolContext, host: SkillCreationHost) {
  return defineTool({
    name: SKILL_PROPOSE_TOOL,
    description:
      '提交对话创建技能的草稿。先按 create-skill 访谈收集名称、描述、触发场景与正文；本工具只写草稿，不创建技能。成功后返回确认卡信息与一段「草稿编号：…」；该编号只供模型使用，不要贴给用户。用户下一轮明确同意后，把该编号原样传给 skill_commit。',
    parameters: {
      name: { type: 'string', required: true, description: 'kebab-case 技能名，1-64 字符' },
      description: { type: 'string', required: true, description: '单行描述，不超过 1024 字符' },
      whenToUse: { type: 'string', description: '单行触发场景；没有就不传' },
      body: { type: 'string', required: true, description: 'SKILL.md 正文（不含 frontmatter 附加行）' },
    },
    output: textOutput,
    async execute(args: SkillProposeArgs, exec: { agent?: unknown }) {
      const sessionId = sessionIdOf(exec)
      let result: SkillProposeResult
      try {
        result = await host.propose(sessionId, proposalFromArgs(args))
      } catch (error) {
        if (error instanceof CorruptSkillCreationDraftError) throwCorruptDraft(ctx, sessionId)
        throw error
      }
      if (!result.ok) {
        const details = fieldErrorsText(result.fieldErrors)
        const text = details ? `技能提案未通过（草稿未写入）：\n${details}` : '技能提案未通过（草稿未写入）。'
        emit(ctx, { event: 'skill/notice', text, sessionId })
        // 抛出走运行时的错误结果路径(isError:true),让模型明确知道这次提案失败。
        throw new Error(text)
      }
      const card: SkillConfirmCard = {
        name: result.proposal.name,
        description: result.proposal.description,
        ...(result.proposal.whenToUse !== undefined ? { whenToUse: result.proposal.whenToUse } : {}),
        contentPreview: contentPreviewOf(result.proposal.body),
      }
      emit(ctx, { event: 'skill/confirm', card, sessionId })
      return { text: `${cardTextOf(card)}\n草稿编号：${result.draftId}` }
    },
  })
}

function commitTool(ctx: ToolContext, host: SkillCreationHost, pendingDetach: Map<string, string>) {
  return defineTool({
    name: SKILL_COMMIT_TOOL,
    description:
      '把当前会话的技能创建草稿写入本地技能。只在用户整句明确同意（可以/确认/同意/就这样/按这个建）、且本轮仍处于技能创建或继续创建流程时调用；draftId 必须用 skill_propose 结果里「草稿编号：」后面的编号，不要自己编造。同一轮刚 propose 不能立即 commit。',
    parameters: {
      draftId: { type: 'string', required: true, description: 'skill_propose 返回的草稿 id' },
    },
    output: textOutput,
    async execute(args: { draftId: string }, exec: ToolExec) {
      const sessionId = sessionIdOf(exec)
      let result: SkillCommitResult
      try {
        result = await host.commit(sessionId, args.draftId, host.lastUserText(sessionId) ?? '')
      } catch (error) {
        if (error instanceof CorruptSkillCreationDraftError) throwCorruptDraft(ctx, sessionId)
        throw error
      }
      if (!result.ok) {
        const details = fieldErrorsText(result.fieldErrors)
        const text = details ? `技能未保存：\n${details}` : '技能未保存。'
        emit(ctx, { event: 'skill/notice', text, sessionId })
        // 失败不设置 pendingDetach:后续 tools/result 到达也不得解绑,模型可据此修正后重试。
        throw new Error(text)
      }

      const text = SUCCESS_TEXT(result.name)
      // 成功卡只走 skill/success(客户端按 draftId 去重);notice 不再承载成功文案。
      emit(ctx, { event: 'skill/success', text, draftId: result.draftId, name: result.name, sessionId })
      emit(ctx, { event: 'skill/changed', name: result.name, origin: { kind: 'created' } })
      // 同进程已有首次成功的在途结果时,重放不设置第二个 pendingDetach;但重启后
      // pending map 为空,首个 alreadyCommitted 重放必须登记自己的结果后解绑。
      const hasPendingForSession = [...pendingDetach.values()].includes(sessionId)
      if (!result.alreadyCommitted || !hasPendingForSession) {
        if (ctx.huaanworkOnToolResult !== undefined && exec.callId !== undefined) {
          pendingDetach.set(exec.callId, sessionId)
        } else {
          // 没有结果通道的嵌入(单测)也至少让当前调用栈走完再解绑。
          setTimeout(() => detachSkillCreationTools(ctx, sessionId), 0)
        }
      }
      // The commit is terminal; stop the loop here so the model cannot retry
      // a detached tool and report a false failure.
      exec.concludeTurn?.()
      return { text }
    },
  })
}

/**
 * 注册 `skill_propose` / `skill_commit`。
 *
 * @param ctx tools 服务与 holder 的桥接对象(工具子插件内构建)
 * @param host 技能创建草稿的宿主门面
 * @returns 同时卸下两个工具的 disposer;缺少 tools 服务时为空 disposer
 */
export function registerSkillCreationTools(ctx: unknown, host: SkillCreationHost): () => void {
  const c = ctx as ToolContext
  if (!c.tools?.register) return () => undefined
  const pendingDetach = new Map<string, string>()
  const stopCleanup = trackSessionPendingDetach(c.huaanworkAttachments, pendingDetach)
  const stopToolResults = c.huaanworkOnToolResult?.((exec) => {
    const sessionId = exec.callId === undefined ? undefined : pendingDetach.get(exec.callId)
    if (sessionId === undefined || exec.callId === undefined) return
    pendingDetach.delete(exec.callId)
    detachSkillCreationTools(c, sessionId)
  })
  const disposers = [
    c.tools.register(proposeTool(c, host)),
    c.tools.register(commitTool(c, host, pendingDetach)),
  ]
  return () => {
    stopToolResults?.()
    stopCleanup()
    for (const dispose of disposers.reverse()) dispose()
  }
}
