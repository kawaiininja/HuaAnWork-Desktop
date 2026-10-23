import { attachAgentTools, detachAgentTools, type AttachmentMaps } from '../../huaanwork-guardrails/agent-attachments.ts'
import { mountSessionMcp } from '../../huaanwork-guardrails/agent-mcp.ts'
import {
  beginAgentPackageUpdate,
  cancelAgentPackage,
  commitAgentPackage,
  loadAgentPackageDraft,
  proposeAgentPackage,
  type CommitResult,
  type ProposeResult,
} from './drafts.ts'
import { parseAgentPackageManifest } from './manifest.ts'
import {
  composeAgentPackagePersona,
  composeAgentPackageToolAllowList,
  createAgentPackageRuntimeRegistry,
  startAgentPackageProcesses,
  stopAgentPackageProcesses,
  type AgentPackageRuntimeRegistry,
  type AgentPackageSandbox,
  type StartAgentPackageProcessesOptions,
} from './runtime.ts'
import {
  agentPackageDir,
  listLocalAgentPackages,
  readAgentPackage,
  readAgentPackageFile,
  setAgentPackageEnabled,
} from './store.ts'
import type {
  AgentPackageDetail,
  AgentPackageManifest,
  AgentPackageSubagentRequest,
  AgentPackageListItem,
  AgentPackageProposalInput,
  AgentPackageTurnRuntime,
} from './types.ts'

/**
 * `@slug` dispatch 需要的运行时上下文(由 `sessions.ts` 传入真实 cordis Context)。
 *
 * 只声明本模块实际读取的成员:子代理启动、`sandbox` 服务查找、工作区根,以及
 * `skills.ts` 在 `subagents.start` 包装里消费的请求容器与附件表。
 */
export type AgentPackageDispatchContext = {
  get?(name: string): unknown
  huaanworkWorkspaceRoot?: { current: string }
  huaanworkAttachments?: AttachmentMaps
  huaanworkAgentPackageRequest?: { current: AgentPackageSubagentRequest | null }
  subagents?: {
    start?: (
      provider: string,
      request: {
        prompt: Array<{ type: string; text: string }>
        persona?: string
        parent?: unknown
        signal?: AbortSignal
        [key: string]: unknown
      },
    ) => Promise<unknown>
  }
}

export type AgentPackageDispatchInput = {
  ctx: AgentPackageDispatchContext
  /** 用户会话;运行时先绑定它,供工具在缺少子会话 id 时回落。 */
  sessionId: string
  pkg: AgentPackageDetail
  remainder: string
  /** 解析当前会话 agent 作为子代理 parent;失败时不启动子代理。 */
  resolveParent?: () => Promise<unknown>
}

/** 一次 `@slug` 回合的可见结果;`afterIdle` 是唯一的资源释放点。 */
export type AgentPackageDispatchResult = {
  text: string
  afterIdle: () => Promise<void>
}

/**
 * 智能体创建/管理与运行共用的宿主门面(计划 Task 3 基线;Task 6 追加运行方法,
 * Task 7 在同一导出类型上追加 legacy 方法)。
 *
 * 宿主自己持有每个会话的 `lastUserText` 与「同一轮已提出草稿」标记:
 * `noteUserText` 由创建入口在每一轮用户原句到达时调用(写入新原句并清除
 * 同轮标记),`propose` 成功后置位,`commit` 读取后拒绝同轮提交。写路径
 * 成功后的 `agent/changed` 事件由上层路由发出,本宿主不持有 hub。
 */
export type AgentPackageHost = {
  propose(sessionId: string, input: AgentPackageProposalInput): Promise<ProposeResult>
  commit(
    sessionId: string,
    draftId: string,
    rawUserText: string,
    opts?: { proposedThisTurn?: boolean },
  ): Promise<CommitResult>
  cancel(sessionId: string): Promise<boolean>
  hasDraft(sessionId: string): boolean
  beginUpdate(sessionId: string, slug: string): Promise<void>
  lastUserText(sessionId: string): string | undefined
  noteUserText(sessionId: string, text: string): void
  listLocal(): AgentPackageListItem[]
  detail(slug: string): AgentPackageDetail | undefined
  setEnabled(slug: string, enabled: boolean): void
  /** 本地包详情(含未启用与已损坏),用于 `@slug` 分流。 */
  findInvocable(slug: string): Promise<AgentPackageDetail | undefined>
  /** 启动一次包回合;调用方持有返回的 `afterIdle` 并在回合结束后调用。 */
  dispatch(input: AgentPackageDispatchInput): Promise<AgentPackageDispatchResult>
}

export type CreateAgentPackageHostOptions = {
  profileDir: string
  /** 每次调用都读当前值:本地入口与已有智能体的占用名会随会话变化。 */
  takenSlugs: () => readonly string[]
  /** 会话 → 回合运行时登记表(与 `agent_skill_run` / `agent_http` 共用);缺省时自建。 */
  registry?: AgentPackageRuntimeRegistry
  /** 测试缝:替换真实进程启动。 */
  createRuntime?: (options: StartAgentPackageProcessesOptions) => Promise<AgentPackageTurnRuntime>
  /** 测试缝:替换真实进程停止。 */
  stopRuntime?: (runtime: AgentPackageTurnRuntime) => Promise<void>
  /** 兼容旧调用方的回落来源;`noteUserText` 写入的原句优先。 */
  lastUserText?: (sessionId: string) => string | undefined
}

/** 每会话原句只保留最近一条;上限防止长驻宿主按会话无限增长。 */
const MAX_TRACKED_SESSIONS = 256

/**
 * 组装 `AgentPackageHost`。
 *
 * @param options profile 目录、`takenSlugs` 提供方,以及可选的原句回落读取
 * @returns 宿主门面
 */
export function createAgentPackageHost(options: CreateAgentPackageHostOptions): AgentPackageHost {
  const { profileDir, takenSlugs } = options
  const registry = options.registry ?? createAgentPackageRuntimeRegistry()
  const createRuntime = options.createRuntime ?? startAgentPackageProcesses
  const stopRuntime = options.stopRuntime ?? stopAgentPackageProcesses
  const lastText = new Map<string, string>()
  const proposedThisTurn = new Set<string>()

  return {
    async propose(sessionId, input) {
      const result = await proposeAgentPackage(profileDir, sessionId, input, takenSlugs())
      if (result.ok) proposedThisTurn.add(sessionId)
      return result
    },

    async commit(sessionId, draftId, rawUserText, opts) {
      // 测试钩子:路由不得把 proposedThisTurn 从线上透传,否则同一轮门禁可被 false 关闭。
      const result = await commitAgentPackage(profileDir, sessionId, draftId, rawUserText, takenSlugs(), {
        proposedThisTurn: opts?.proposedThisTurn ?? proposedThisTurn.has(sessionId),
      })
      if (result.ok) proposedThisTurn.delete(sessionId)
      return result
    },

    async cancel(sessionId) {
      proposedThisTurn.delete(sessionId)
      return cancelAgentPackage(profileDir, sessionId)
    },

    hasDraft(sessionId) {
      return loadAgentPackageDraft(profileDir, sessionId) !== undefined
    },

    async beginUpdate(sessionId, slug) {
      await beginAgentPackageUpdate(profileDir, sessionId, slug)
      proposedThisTurn.delete(sessionId)
    },

    lastUserText(sessionId) {
      const noted = lastText.get(sessionId)
      if (noted !== undefined) return noted
      return options.lastUserText?.(sessionId)
    },

    noteUserText(sessionId, text) {
      rememberLastText(lastText, sessionId, text)
      proposedThisTurn.delete(sessionId)
    },

    listLocal() {
      return listLocalAgentPackages(profileDir)
    },

    detail(slug) {
      return readAgentPackage(profileDir, slug)
    },

    setEnabled(slug, enabled) {
      const detail = readAgentPackage(profileDir, slug)
      if (detail === undefined) throw new Error(`智能体 @${slug} 不存在`)
      if (detail.broken !== undefined) throw new Error(`智能体 @${slug} 已损坏:${detail.broken.reason}`)
      setAgentPackageEnabled(profileDir, slug, enabled)
    },

    async findInvocable(slug) {
      // 已停用/已损坏也要返回详情:分流先认出「这是本地包」,再由 dispatch 给出
      // 规范错误,而不是落回 agentsHost 的「不存在」分支。
      return readAgentPackage(profileDir, slug)
    },

    async dispatch(input) {
      const { ctx, sessionId, pkg } = input
      if (!pkg.enabled) throw new Error(`智能体「${pkg.slug}」未启用或不存在`)
      if (pkg.broken !== undefined) throw new Error(`智能体「${pkg.slug}」已损坏：${pkg.broken.reason}`)
      const startSubagent = ctx.subagents?.start
      if (typeof startSubagent !== 'function') throw new Error('current dsh runtime does not support subagents')

      const manifest = readDispatchManifest(profileDir, pkg.slug)
      const packageDir = agentPackageDir(profileDir, pkg.slug)
      const persona = await composeAgentPackagePersona(packageDir, manifest, profileDir)
      const workspaceRoot = ctx.huaanworkWorkspaceRoot?.current ?? process.cwd()

      let runtime: AgentPackageTurnRuntime | undefined
      let mcpDispose: (() => Promise<void>) | undefined
      let request: AgentPackageSubagentRequest | null = null
      let cleanupPromise: Promise<void> | undefined
      const boundChildren = new Set<string>()

      const bindChild = (childSessionId: string): void => {
        if (runtime === undefined) return
        boundChildren.add(childSessionId)
        registry.bind(childSessionId, runtime)
        // MCP 工具在子代理启动前挂到父会话(健康检查要求先拿到工具名);
        // 子会话要执行 mcp__* 还需自己的附件,否则 policy 的 attached 判定会拒绝。
        if (runtime.mcpNames !== undefined && ctx.huaanworkAttachments !== undefined) {
          attachAgentTools(ctx.huaanworkAttachments, childSessionId, runtime.mcpNames)
        }
      }

      const cleanup = async (): Promise<void> => {
        if (cleanupPromise !== undefined) return cleanupPromise
        cleanupPromise = (async () => {
          const current = runtime
          if (current !== undefined) {
            try {
              await stopRuntime(current)
            } catch {
              // 释放是尽力而为:afterIdle 不能因为某个子进程拒绝退出而卡住整轮收尾。
            }
          }
          if (mcpDispose !== undefined) {
            try {
              await mcpDispose()
            } catch {
              // MCP 客户端 scope 可能已随子进程退出;失败不阻止其余清理。
            }
          }
          if (current !== undefined) {
            // A late afterIdle must not delete a newer turn's binding for the same session.
            if (registry.get(sessionId) === current) registry.delete(sessionId)
            for (const childSessionId of boundChildren) {
              if (registry.get(childSessionId) === current) registry.delete(childSessionId)
              if (current.mcpNames !== undefined && ctx.huaanworkAttachments !== undefined) {
                detachAgentTools(ctx.huaanworkAttachments, childSessionId, current.mcpNames)
              }
            }
          }
          if (request !== null && ctx.huaanworkAgentPackageRequest?.current === request) {
            ctx.huaanworkAgentPackageRequest.current = null
          }
        })()
        return cleanupPromise
      }

      try {
        runtime = await createRuntime({
          manifest,
          packageDir,
          workspaceRoot,
          getSandbox: () => ctx.get?.('sandbox') as AgentPackageSandbox | undefined,
          mountMcp: async (port) => {
            const mounted = await mountSessionMcp({
              ctx: ctx as never,
              sessionId,
              serverName: pkg.slug,
              url: `http://127.0.0.1:${String(port)}/mcp`,
            })
            mcpDispose = mounted.dispose
            return mounted.names
          },
        })

        const allow = composeAgentPackageToolAllowList(manifest, runtime.mcpNames ?? [], runtime.skillScripts)
        request = { allow, persona, runtime, bindChild }
        if (ctx.huaanworkAgentPackageRequest !== undefined) {
          ctx.huaanworkAgentPackageRequest.current = request
        }
        registry.bind(sessionId, runtime)

        const prompt = input.remainder.trim() || pkg.description || '开始协助工作。'
        const parent = input.resolveParent === undefined ? undefined : await input.resolveParent()
        await startSubagent('spawn', {
          prompt: [{ type: 'text', text: prompt }],
          persona,
          ...(parent === undefined ? {} : { parent }),
          signal: new AbortController().signal,
        })
        return { text: prompt, afterIdle: cleanup }
      } catch (error) {
        await cleanup()
        throw error
      }
    },
  }
}

/** Re-read the on-disk manifest; dispatch only runs for a package the store did not mark broken. */
function readDispatchManifest(profileDir: string, slug: string): AgentPackageManifest {
  const text = readAgentPackageFile(profileDir, slug, 'agent.json')
  if (text === undefined) throw new Error(`智能体「${slug}」已损坏：agent.json 不可读`)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`智能体「${slug}」已损坏：agent.json 无法解析`, { cause: error })
  }
  const parsed = parseAgentPackageManifest(raw)
  if (!parsed.ok) {
    const detail = parsed.fieldErrors.map((fieldError) => `${fieldError.field}: ${fieldError.message}`).join('；')
    throw new Error(`智能体「${slug}」已损坏：manifest 校验失败（${detail}）`)
  }
  return parsed.manifest
}

function rememberLastText(lastText: Map<string, string>, sessionId: string, text: string): void {
  lastText.delete(sessionId)
  lastText.set(sessionId, text)
  if (lastText.size <= MAX_TRACKED_SESSIONS) return
  const oldest = lastText.keys().next().value
  if (oldest !== undefined) lastText.delete(oldest)
}
