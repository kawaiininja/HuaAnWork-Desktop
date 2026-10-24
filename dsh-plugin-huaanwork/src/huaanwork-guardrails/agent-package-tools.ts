import { defineTool } from '@deepseek-ai/dsh-tools'
import { clampTimeoutMs } from '@huaanwork/policy/agent-catalog'
import { CATALOG_BODY_LIMIT, readCappedText } from '@huaanwork/policy/http-cap'
import { capToolOutput } from '@huaanwork/policy/truncate'
import { sessionIdOfAgentRef } from '@huaanwork/policy/channels'

import type { RpcEvent } from '../client-huaanwork/rpc-types.ts'
import type { AttachmentMaps } from './agent-attachments.ts'
import { detachCreationTools } from '../huaanwork-host/agent-package/creation.ts'
import type { AgentPackageHost } from '../huaanwork-host/agent-package/host.ts'
import type { AgentPackageRuntimeRegistry } from '../huaanwork-host/agent-package/runtime.ts'
import { currentCallerSession } from '../huaanwork-host/child-sessions.ts'
import type {
  AgentPackageProposalInput,
  AgentPackageToolsMode,
  AgentPackageTurnRuntime,
} from '../huaanwork-host/agent-package/types.ts'

/**
 * 本地智能体包的全部模型工具(设计 §6.2、§7.3)。
 *
 * 创建流程的 `agent_propose` / `agent_commit` 与 `@slug` 运行链路的
 * `agent_skill_run` / `agent_http` 都全局注册,可见性与执行权由
 * `sessionAgentTools` 附件 + present-as 的 restrict + policy 的 attached 判定
 * 三层控制(与 `call_host_tool` 同一纵深)。
 */

export const AGENT_PROPOSE_TOOL = 'agent_propose'
export const AGENT_COMMIT_TOOL = 'agent_commit'
export const AGENT_SKILL_RUN_TOOL = 'agent_skill_run'
export const AGENT_HTTP_TOOL = 'agent_http'

/** Default cooperative timeout for `agent_http`; `clampTimeoutMs` caps it at 150s. */
const DEFAULT_HTTP_TIMEOUT_MS = 60_000
/** The tool-call timeout policy's hard ceiling, shared by both runtime tools. */
const HARD_TOOL_TIMEOUT_MS = 150_000

type ToolContext = {
  tools?: { register(definition: unknown): () => void }
  huaanworkEmit?: (event: RpcEvent) => void
  huaanworkRouteAgent?: { current: unknown }
  huaanworkAttachments?: AttachmentMaps
  /**
   * `tools/result` 观察器。commit 成功后的解绑必须等工具结果定稿再做:
   * 上游会按工具名重新解析工具来归一化结果,执行体内解绑会把成功改写成
   * `UNKNOWN_TOOL`,连 `concludesTurn` 标记一起丢掉。
   */
  huaanworkOnToolResult?: (listener: (exec: { callId?: string }) => void) => () => void
  /** Test seam shared with `call_host_tool`: a fake transport for `agent_http`. */
  fetchImpl?: typeof fetch
  /** Test seam for the `agent_http` deadline; production always uses the default. */
  httpTimeoutMs?: number
  /** 工具子插件是桥接对象;present-as 的 restrict 状态挂在根 Context 上。 */
  root?: object
}

type ToolExec = { agent?: unknown; callId?: string; concludeTurn?: () => void }

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

function commitTool(ctx: ToolContext, host: AgentPackageHost, pendingDetach: Map<string, string>) {
  return defineTool({
    name: AGENT_COMMIT_TOOL,
    description:
      '把当前会话的待确认草稿写入本地智能体包。只在用户整句明确同意（可以/确认/同意/就这样/按这个建）、且本轮仍处于创建/继续创建流程时调用；draftId 必须用 agent_propose 结果里「草稿编号：」后面的编号，不要自己编造。同一轮刚 propose 不能立即 commit。',
    parameters: {
      draftId: { type: 'string', required: true, description: 'agent_propose 返回的草稿 id' },
    },
    output: textOutput,
    async execute(args: { draftId: string }, exec: ToolExec) {
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
      // 解绑留到工具结果定稿之后;执行体内解绑会让上游的结果归一化找不到工具。
      if (ctx.huaanworkOnToolResult !== undefined && exec.callId !== undefined) {
        pendingDetach.set(exec.callId, sessionId)
      } else {
        // 没有结果通道的嵌入(单测)也至少让当前调用栈走完再解绑。
        setTimeout(() => detachCreationTools(ctx, sessionId), 0)
      }
      // The commit is terminal; stop the loop here so the model cannot retry
      // a detached tool and report a false failure.
      exec.concludeTurn?.()
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
  const pendingDetach = new Map<string, string>()
  const stopToolResults = c.huaanworkOnToolResult?.((exec) => {
    const sessionId = exec.callId === undefined ? undefined : pendingDetach.get(exec.callId)
    if (sessionId === undefined || exec.callId === undefined) return
    pendingDetach.delete(exec.callId)
    detachCreationTools(c, sessionId)
  })
  const disposers = [
    c.tools.register(proposeTool(c, host)),
    c.tools.register(commitTool(c, host, pendingDetach)),
  ]
  return () => {
    stopToolResults?.()
    for (const dispose of disposers.reverse()) dispose()
  }
}

// —— `@slug` 运行链路(设计 §7.3)——

type RuntimeExec = ToolExec & { signal?: AbortSignal }

/** Sessions resolve from the executing subagent, then the last user send as a fallback. */
function runtimeSessionId(ctx: ToolContext, exec: RuntimeExec | undefined): string | undefined {
  const agent = (exec?.agent ?? ctx.huaanworkRouteAgent?.current) as AgentRef | undefined
  return sessionIdOfAgentRef(agent) ?? currentCallerSession()
}

function runtimeFor(registry: AgentPackageRuntimeRegistry, sessionId: string | undefined): AgentPackageTurnRuntime {
  const runtime = sessionId === undefined ? undefined : registry.get(sessionId)
  if (runtime === undefined) throw new Error('当前会话没有运行中的智能体包')
  return runtime
}

function skillRunTool(ctx: ToolContext, registry: AgentPackageRuntimeRegistry) {
  return defineTool({
    name: AGENT_SKILL_RUN_TOOL,
    description:
      '运行当前本地智能体包声明过的技能脚本。script 必须精确写成包内 skill/scripts/ 下的相对路径；args 会作为 JSON 传给脚本。脚本在本机沙箱内以子进程运行，工作目录是当前工作区，单次输出上限 32 KiB，非零退出会返回脚本的错误输出。',
    parameters: {
      script: { type: 'string', required: true, description: '技能脚本路径，例如 skill/scripts/report.mjs' },
      args: { type: 'object', additionalProperties: true, description: '作为 AGENT_SCRIPT_ARGS 传给脚本的参数对象' },
    },
    output: textOutput,
    timeoutMs: HARD_TOOL_TIMEOUT_MS,
    async execute(args: { script: string; args?: Record<string, unknown> }, exec: RuntimeExec) {
      const runtime = runtimeFor(registry, runtimeSessionId(ctx, exec))
      const result = await runtime.runSkillScript(args.script, args.args ?? {}, exec.signal)
      if (result.isError === true) throw new Error(result.text)
      return { text: result.text }
    },
  })
}

function httpTool(ctx: ToolContext, registry: AgentPackageRuntimeRegistry) {
  return defineTool({
    name: AGENT_HTTP_TOOL,
    description:
      '调用当前本地智能体包的 HTTP 工具：把 arguments 对象 POST 到包内服务。服务返回 {ok:true,result} 时本工具返回 result 文本；返回 {ok:false,error}、非 2xx 或连接失败时本次调用失败。默认 60 秒超时，响应读入上限 1 MiB，输出上限 32 KiB。',
    parameters: {
      arguments: { type: 'object', additionalProperties: true, description: '传给智能体 HTTP 工具的 arguments 对象；缺省为空对象' },
    },
    output: textOutput,
    timeoutMs: HARD_TOOL_TIMEOUT_MS,
    async execute(args: { arguments?: Record<string, unknown> }, exec: RuntimeExec) {
      const runtime = runtimeFor(registry, runtimeSessionId(ctx, exec))
      const port = runtime.httpPort
      if (port === undefined) throw new Error(`智能体 @${runtime.slug} 没有启用 HTTP 工具`)

      const timeoutSignal = AbortSignal.timeout(clampTimeoutMs(ctx.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS))
      const signal = exec.signal === undefined ? timeoutSignal : AbortSignal.any([exec.signal, timeoutSignal])
      const fetcher = ctx.fetchImpl ?? globalThis.fetch

      let response: Response
      try {
        response = await fetcher(`http://127.0.0.1:${String(port)}/invoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ arguments: args.arguments ?? {} }),
          signal,
        })
      } catch (error) {
        throw httpFailure(runtime.slug, error, exec.signal, timeoutSignal)
      }

      if (!response.ok) {
        let detail = ''
        try {
          detail = (await readCappedText(response.body, CATALOG_BODY_LIMIT)).text.trim().slice(0, 500)
        } catch {
          // 错误详情读不到时仍报状态码,不让读取失败掩盖传输错误。
        }
        throw new Error(`智能体 @${runtime.slug} 的 HTTP 工具返回 HTTP ${String(response.status)}${detail ? `: ${detail}` : ''}`)
      }

      let capped: { text: string; truncated: boolean }
      try {
        capped = await readCappedText(response.body, CATALOG_BODY_LIMIT)
      } catch (error) {
        throw new Error(`智能体 @${runtime.slug} 的 HTTP 工具响应读取失败：${errorMessage(error).slice(0, 500)}`)
      }
      if (capped.truncated) {
        throw new Error(
          `智能体 @${runtime.slug} 的 HTTP 工具响应超过 ${String(CATALOG_BODY_LIMIT / (1024 * 1024))} MiB`,
        )
      }
      const text = capped.text

      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error(`智能体 @${runtime.slug} 的 HTTP 工具返回了无法解析的响应`)
      }
      if (!isRecord(parsed)) throw new Error(`智能体 @${runtime.slug} 的 HTTP 工具返回了无法解析的响应`)

      if (parsed.ok === false) {
        const detail = typeof parsed.error === 'string' && parsed.error.length > 0
          ? parsed.error
          : JSON.stringify(parsed.error ?? '执行失败')
        throw new Error(detail.slice(0, 500))
      }
      if (parsed.ok !== true) throw new Error(`智能体 @${runtime.slug} 的 HTTP 工具返回了无法解析的响应`)

      const result = parsed.result
      const body = typeof result === 'string' ? result : result === undefined ? '' : JSON.stringify(result, null, 2)
      return { text: capToolOutput(body, '').text }
    },
  })
}

function httpFailure(
  slug: string,
  error: unknown,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): Error {
  if (callerSignal?.aborted === true) return new Error(`智能体 @${slug} 的 HTTP 工具调用已取消`)
  if (timeoutSignal.aborted || (error as { name?: unknown } | undefined)?.name === 'TimeoutError') {
    return new Error(`智能体 @${slug} 的 HTTP 工具调用超时`)
  }
  return new Error(`智能体 @${slug} 的 HTTP 工具网络请求失败：${errorMessage(error).slice(0, 500)}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 注册 `agent_skill_run` / `agent_http`。
 *
 * 两个工具全局注册,但只有 `skills.ts` 在 `@slug` 子代理启动后把名字挂进子会话
 * 的 `sessionAgentTools` 才可见、可执行(Task 4 的 policy 门禁覆盖四个包工具名)。
 *
 * @param ctx tools 服务与 holder 的桥接对象(工具子插件内构建)
 * @param registry 当前进程的会话 → 回合运行时登记表
 * @returns 同时卸下两个工具的 disposer;缺少 tools 服务时为空 disposer
 */
export function registerAgentPackageRuntimeTools(
  ctx: unknown,
  registry: AgentPackageRuntimeRegistry,
): () => void {
  const c = ctx as ToolContext
  if (!c.tools?.register) return () => undefined
  const disposers = [c.tools.register(skillRunTool(c, registry)), c.tools.register(httpTool(c, registry))]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
