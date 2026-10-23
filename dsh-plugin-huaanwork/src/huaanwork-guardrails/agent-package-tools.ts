import { defineTool } from '@deepseek-ai/dsh-tools'
import { sessionIdOfAgentRef } from '@huaanwork/policy/channels'

import type { RpcEvent } from '../client-huaanwork/rpc-types.ts'
import type { AttachmentMaps } from './agent-attachments.ts'
import { detachCreationTools } from '../huaanwork-host/agent-package/creation.ts'
import type { AgentPackageHost } from '../huaanwork-host/agent-package/host.ts'
import type { AgentPackageProposalInput, AgentPackageToolsMode } from '../huaanwork-host/agent-package/types.ts'

/**
 * 创建流程的两个模型工具(设计 §6.2)。
 *
 * 工具全局注册,可见性由 `sessionAgentTools` 附件 + present-as 的 restrict 控制
 * (与 `call_host_tool` 同一纵深):未挂载的会话既看不到,pre-execute 也会拒绝。
 * 真正的字段校验在宿主 `propose`/`commit`,这里只做工具参数到宿主入参的形状投影。
 */

export const AGENT_PROPOSE_TOOL = 'agent_propose'
export const AGENT_COMMIT_TOOL = 'agent_commit'

type ToolContext = {
  tools?: { register(definition: unknown): () => void }
  huaanworkEmit?: (event: RpcEvent) => void
  huaanworkRouteAgent?: { current: unknown }
  huaanworkAttachments?: AttachmentMaps
  /** 工具子插件是桥接对象;present-as 的 restrict 状态挂在根 Context 上。 */
  root?: object
}

type ToolExec = { agent?: unknown }

type AgentRef = { id?: string; session?: { id?: string } }

type AgentProposeArgs = {
  mode: string
  displayName?: string
  slug?: string
  description?: string
  persona?: string
  personaSummary?: string
  skillSummary?: string
  skill?: Record<string, unknown>
  allowSkills?: string[]
  tools?: string
  httpServer?: string
  mcpServer?: string
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

function sessionIdOf(ctx: ToolContext, exec: ToolExec | undefined): string {
  const agent = (exec?.agent ?? ctx.huaanworkRouteAgent?.current) as AgentRef | undefined
  const sessionId = sessionIdOfAgentRef(agent)
  if (!sessionId) throw new Error('当前没有可用于创建智能体的会话')
  return sessionId
}

function emit(ctx: ToolContext, event: RpcEvent): void {
  ctx.huaanworkEmit?.(event)
}

function toolsModeOf(value: string): AgentPackageToolsMode {
  if (value === 'none' || value === 'http' || value === 'mcp' || value === 'both') return value
  throw new Error('tools 必须是 none / http / mcp / both')
}

function skillOf(value: Record<string, unknown>): NonNullable<AgentPackageProposalInput['skill']> {
  const summary = value.summary
  const markdown = value.markdown
  const scripts = value.scripts
  if (typeof summary !== 'string' || typeof markdown !== 'string' || !Array.isArray(scripts)) {
    throw new Error('skill 必须是 { summary, markdown, scripts: [{ path, content }] }')
  }
  return {
    summary,
    markdown,
    scripts: scripts.map((script, index) => {
      const record = script as Record<string, unknown> | null
      if (!record || typeof record !== 'object' || typeof record.path !== 'string' || typeof record.content !== 'string') {
        throw new Error(`skill.scripts[${index}] 必须是 { path, content }`)
      }
      return { path: record.path, content: record.content }
    }),
  }
}

/** 工具参数 → 宿主入参:只投影声明过的字段,可选字段缺席时保持缺席。 */
function proposalFromArgs(args: AgentProposeArgs): AgentPackageProposalInput {
  if (args.mode !== 'create' && args.mode !== 'update') throw new Error('mode 必须是 create 或 update')
  const input: AgentPackageProposalInput = { mode: args.mode }
  if (args.displayName !== undefined) input.displayName = args.displayName
  if (args.slug !== undefined) input.slug = args.slug
  if (args.description !== undefined) input.description = args.description
  if (args.persona !== undefined) input.persona = args.persona
  if (args.personaSummary !== undefined) input.personaSummary = args.personaSummary
  if (args.skillSummary !== undefined) input.skillSummary = args.skillSummary
  if (args.skill !== undefined) input.skill = skillOf(args.skill)
  if (args.allowSkills !== undefined) input.allowSkills = args.allowSkills
  if (args.tools !== undefined) input.tools = toolsModeOf(args.tools)
  if (args.httpServer !== undefined) input.httpServer = args.httpServer
  if (args.mcpServer !== undefined) input.mcpServer = args.mcpServer
  return input
}

function proposeTool(ctx: ToolContext, host: AgentPackageHost) {
  return defineTool({
    name: AGENT_PROPOSE_TOOL,
    description:
      '提交本地智能体的创建/更新草稿。先按 create-agent 访谈收集字段；宿主校验并返回一段确认卡正文，必须原样贴回会话。结果末尾另有一行「草稿编号：…」，只供模型使用，不要贴给用户；用户下一轮明确同意后，把该编号原样传给 agent_commit。本工具只写草稿，不创建智能体包目录。',
    parameters: {
      mode: { type: 'string', required: true, description: 'create 或 update' },
      displayName: { type: 'string', description: '显示名，1-40 字' },
      slug: { type: 'string', description: '小写字母、数字与连字符组成的 @ 标识，1-32 字' },
      description: { type: 'string', description: '能力简介，1-200 字' },
      persona: { type: 'string', description: 'persona.md 全文（人设边界）' },
      personaSummary: { type: 'string', description: '确认卡上的人设要点，1-200 字' },
      skillSummary: { type: 'string', description: '确认卡上的技能包要点，1-200 字' },
      skill: {
        type: 'object',
        additionalProperties: true,
        description: '专属技能包 { summary, markdown, scripts: [{ path, content }] }；没有就不传',
      },
      allowSkills: { type: 'array', items: { type: 'string' }, description: '允许附加正文的已有技能名' },
      tools: { type: 'string', description: 'none / http / mcp / both' },
      httpServer: { type: 'string', description: 'tools/http/server.mjs 全文；只在 tools 为 http 或 both 时提供' },
      mcpServer: { type: 'string', description: 'tools/mcp/server.mjs 全文；只在 tools 为 mcp 或 both 时提供' },
    },
    output: textOutput,
    async execute(args: AgentProposeArgs, exec: { agent?: unknown }) {
      const sessionId = sessionIdOf(ctx, exec)
      const result = await host.propose(sessionId, proposalFromArgs(args))
      if (!result.ok) {
        const details = result.fieldErrors.map((error) => `${error.field}: ${error.message}`).join('\n')
        const text = details ? `提案未通过（草稿未写入）：\n${details}` : '提案未通过（草稿未写入）。'
        emit(ctx, { event: 'agent/notice', text, sessionId })
        // 抛出走运行时的错误结果路径(isError:true),让模型明确知道这次提案失败。
        throw new Error(text)
      }
      emit(ctx, { event: 'agent/confirm', card: result.card, sessionId })
      return { text: `${result.cardText}\n草稿编号：${result.draftId}` }
    },
  })
}

function commitTool(ctx: ToolContext, host: AgentPackageHost) {
  return defineTool({
    name: AGENT_COMMIT_TOOL,
    description:
      '把当前会话的待确认草稿写入本地智能体包。只在用户整句明确同意（可以/确认/同意/就这样/按这个建）后调用；draftId 必须用 agent_propose 结果里「草稿编号：」后面的编号，不要自己编造。同一轮刚 propose 不能立即 commit。',
    parameters: {
      draftId: { type: 'string', required: true, description: 'agent_propose 返回的草稿 id' },
    },
    output: textOutput,
    async execute(args: { draftId: string }, exec: { agent?: unknown }) {
      const sessionId = sessionIdOf(ctx, exec)
      const result = await host.commit(sessionId, args.draftId, host.lastUserText(sessionId) ?? '')
      if (!result.ok) throw new Error(`智能体未写入：${result.error}`)

      const text = result.alreadyCommitted
        ? `智能体 @${result.slug} 已在之前写入。`
        : result.mode === 'update'
          ? `已更新智能体 @${result.slug}；原有启用状态保持不变。`
          : `已写入智能体 @${result.slug}。新建的智能体默认关闭；在「我的智能体」启用后即可 @ 调用。`
      emit(ctx, { event: 'agent/notice', text, sessionId })
      emit(ctx, { event: 'agent/changed', slug: result.slug })
      detachCreationTools(ctx, sessionId)
      return { text }
    },
  })
}

/**
 * 注册 `agent_propose` / `agent_commit`。
 *
 * @param ctx tools 服务与 holder 的桥接对象(工具子插件内构建)
 * @param host 创建草稿的宿主门面
 * @returns 同时卸下两个工具的 disposer;缺少 tools 服务时为空 disposer
 */
export function registerAgentPackageCreationTools(ctx: unknown, host: AgentPackageHost): () => void {
  const c = ctx as ToolContext
  if (!c.tools?.register) return () => undefined
  const disposers = [c.tools.register(proposeTool(c, host)), c.tools.register(commitTool(c, host))]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
