import { AGENT_PACKAGE_CHILD_TOOLS, detachAgentTools, type AttachmentMaps } from '../../huaanwork-guardrails/agent-attachments.ts'
import { mountSessionMcp } from '../../huaanwork-guardrails/agent-mcp.ts'
import { refreshAgentRestrict } from '../../huaanwork-guardrails/present-as.ts'
import type { AgentListItem } from '../../client-huaanwork/rpc-types.ts'
import type { AgentsHost } from '../agents-host.ts'
import {
  resolveSubagents,
  type SubagentActivationHandle,
  type SubagentsService,
} from '../subagents-service.ts'
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
 * `skills.ts` 在 `subagents.startActivation` 包装里消费的请求容器与附件表。
 */
export type AgentPackageDispatchContext = {
  /** 全局服务查找:`sandbox`,以及 `subagents` 在直接属性缺席时的回落路径。 */
  get?(name: string): unknown
  huaanworkWorkspaceRoot?: { current: string }
  huaanworkAttachments?: AttachmentMaps
  huaanworkAgentPackageRequest?: { current: AgentPackageSubagentRequest | null }
  subagents?: SubagentsService
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
 * `agent.packageList` 载荷:本地包与 legacy 目录 agent 各自成列。
 *
 * `catalogAgents` 只按 `kind === 'agent'` 过滤,停用/损坏的目录条目仍列出
 * (行自报 `enabled`/`broken`);`catalogError` 原样透传目录读取结果。
 */
export type AgentPackageListResult = {
  packages: AgentPackageListItem[]
  catalogAgents: AgentListItem[]
  catalogError?: string
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
  /**
   * 本地包与 legacy 目录 agent 的合并列表(`agent.packageList`)。
   * 未注入 legacy 提供方时抛错:装配缺失不能表现为「目录里没有智能体」。
   */
  listWithLegacy(): Promise<AgentPackageListResult>
  /** 已启用且未损坏的本地包与 legacy 条目(agent 与 tool),映射为 `AgentListItem`。 */
  invocableWithLegacy(): Promise<{ items: AgentListItem[] }>
  /** 本地包详情(含未启用与已损坏),用于 `@slug` 分流。 */
  findInvocable(slug: string): Promise<AgentPackageDetail | undefined>
  /** 启动一次包回合;调用方持有返回的 `afterIdle` 并在回合结束后调用。 */
  dispatch(input: AgentPackageDispatchInput): Promise<AgentPackageDispatchResult>
}

export type CreateAgentPackageHostOptions = {
  profileDir: string
  /** 每次调用都读当前值:本地入口与已有智能体的占用名会随会话变化。 */
  takenSlugs: () => readonly string[]
  /**
   * legacy 智能体目录(公用机目录 + 本地端点)。回调形式让 `index.ts` 注入
   * 已建好的目录实例,`host.ts` 不必导入 `sessions.ts`。
   */
  legacy?: () => AgentsHost
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
 * 回合结束后等待子会话结果/释放的上限。
 *
 * 正常路径在宿主空闲时子会话已经结束,`result` 早已落定;这个上限只兜住
 * 「子进程卡住」的异常路径,避免父会话的 idle 清理被无限期挂起。
 */
const ACTIVATION_CLEANUP_TIMEOUT_MS = 10_000

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
  /** One live package turn per user session; the value is the slug that holds it. */
  const pendingTurns = new Map<string, string>()

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

    async listWithLegacy() {
      const legacyList = requireLegacyHost(options).list()
      return {
        packages: listLocalAgentPackages(profileDir),
        catalogAgents: legacyList.items.filter((item) => item.kind === 'agent'),
        ...(legacyList.catalogError === undefined ? {} : { catalogError: legacyList.catalogError }),
      }
    },

    async invocableWithLegacy() {
      const localItems = listLocalAgentPackages(profileDir)
        .filter((pkg) => pkg.enabled && pkg.broken === undefined)
        .map(toInvocableListItem)
      // 目录条目保留原 kind/source:tool 与 agent 都可能被 `@` 点名调用。
      const legacyItems = requireLegacyHost(options)
        .list()
        .items.filter((item) => item.enabled && item.broken === undefined)
      return { items: [...localItems, ...legacyItems] }
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
      const subagents = resolveSubagents(ctx)
      // Bind after the guard so the runtime method keeps its service receiver.
      const startActivation = subagents?.startActivation?.bind(subagents)
      if (subagents === undefined || startActivation === undefined) {
        throw new Error('current dsh runtime does not support subagents')
      }

      // Reserve synchronously, before the first await: two sends in one session must not
      // start two runtimes (and two subagent children) for the same turn.
      const runningSlug = pendingTurns.get(sessionId)
      if (runningSlug !== undefined) {
        throw new Error(
          `智能体「${pkg.slug}」无法开始：当前会话已有运行中的智能体包回合（@${runningSlug}）`,
        )
      }
      pendingTurns.set(sessionId, pkg.slug)
      let reservationReleased = false
      const releaseReservation = (): void => {
        if (reservationReleased) return
        reservationReleased = true
        if (pendingTurns.get(sessionId) === pkg.slug) pendingTurns.delete(sessionId)
      }

      let runtime: AgentPackageTurnRuntime | undefined
      let mcpDispose: (() => Promise<void>) | undefined
      let request: AgentPackageSubagentRequest | null = null
      let cleanupPromise: Promise<void> | undefined
      let cleanupStarted = false
      let activation: SubagentActivationHandle | undefined
      let activationAbort: AbortController | undefined
      const boundChildren = new Set<string>()

      const bindChild = (childSessionId: string): void => {
        if (runtime === undefined) return
        // `skills.ts` attaches the runtime tools and MCP names before calling this;
        // cleanup detaches them again from every bound child.
        boundChildren.add(childSessionId)
        registry.bind(childSessionId, runtime)
      }

      const cleanup = async (): Promise<void> => {
        // The reservation belongs to this turn and ends with the first cleanup call,
        // including every failure path that reaches `catch` below.
        releaseReservation()
        cleanupStarted = true
        if (cleanupPromise !== undefined) return cleanupPromise
        cleanupPromise = (async () => {
          // Finish the child before releasing what it can still call: the parent can go
          // idle while the child is still working, so aborting or stopping the runtime
          // first would truncate the answer. `result` settles only after the manager's
          // own teardown; capturing it here keeps a failed child turn from rejecting the
          // parent's idle cleanup. Both waits are bounded so a stuck child cannot block
          // that cleanup forever.
          const currentActivation = activation
          if (currentActivation !== undefined) {
            try {
              const settled = await settleWithin(currentActivation.result, ACTIVATION_CLEANUP_TIMEOUT_MS)
              // A child that did not settle within the bound is stuck: cancel it before
              // asking the manager to release the activation.
              if (!settled) activationAbort?.abort()
              await settleWithin(currentActivation.dispose(), ACTIVATION_CLEANUP_TIMEOUT_MS)
            } catch {
              // 释放是尽力而为:同步抛错的 dispose 不能阻止进程、MCP 与登记的清理。
            }
          }
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
            // Detach exactly what `skills.ts` attached to each child; `request.allow`
            // omits tools the package does not enable, so it cannot mirror the attachment.
            const childNames = [...new Set([...AGENT_PACKAGE_CHILD_TOOLS, ...(current.mcpNames ?? [])])]
            for (const childSessionId of boundChildren) {
              if (registry.get(childSessionId) === current) registry.delete(childSessionId)
              if (ctx.huaanworkAttachments !== undefined) {
                detachAgentTools(ctx.huaanworkAttachments, childSessionId, childNames)
              }
              refreshAgentRestrict(ctx as never, childSessionId)
            }
          }
          if (request !== null && ctx.huaanworkAgentPackageRequest?.current === request) {
            ctx.huaanworkAgentPackageRequest.current = null
          }
        })()
        return cleanupPromise
      }

      try {
        const manifest = readDispatchManifest(profileDir, pkg.slug)
        const packageDir = agentPackageDir(profileDir, pkg.slug)
        const persona = await composeAgentPackagePersona(packageDir, manifest, profileDir)
        const workspaceRoot = ctx.huaanworkWorkspaceRoot?.current ?? process.cwd()

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
            // The health budget can expire before the mount resolves; the turn is already
            // over, so release the scope here instead of leaving it (and its names) alive.
            if (cleanupStarted) {
              await mounted.dispose()
              return mounted.names
            }
            mcpDispose = mounted.dispose
            return mounted.names
          },
        })

        const mcpNames = runtime.mcpNames ?? []
        if (mcpNames.length > 0) {
          // The mount attaches the names to the parent only so discovery can see them;
          // after discovery they belong to the package child alone.
          if (ctx.huaanworkAttachments !== undefined) {
            detachAgentTools(ctx.huaanworkAttachments, sessionId, mcpNames)
          }
          refreshAgentRestrict(ctx as never, sessionId)
        }

        const allow = composeAgentPackageToolAllowList(manifest, mcpNames, runtime.skillScripts)
        request = { allow, persona, runtime, parentSessionId: sessionId, bindChild }
        registry.bind(sessionId, runtime)

        const prompt = input.remainder.trim() || pkg.description || '开始协助工作。'
        const parent = input.resolveParent === undefined ? undefined : await input.resolveParent()
        if (parent === undefined || parent === null) {
          throw new Error(`智能体「${pkg.slug}」无法开始：当前会话没有可用的父会话`)
        }
        // Publish the request synchronously before the call: the skills wrapper reads it
        // before its first await, so no sibling activation can claim this turn's request.
        if (ctx.huaanworkAgentPackageRequest !== undefined) {
          ctx.huaanworkAgentPackageRequest.current = request
        }
        activationAbort = new AbortController()
        activation = await startActivation({
          provider: 'spawn',
          label: `@${pkg.slug}`,
          request: {
            // rc.1 的 SubagentStartRequest 没有 persona 字段:人设作为带分隔的前缀
            // 并入子代理的首条用户消息,用户请求原样保留在后。
            prompt: [{ type: 'text', text: `${persona}\n\n---\n用户请求：\n${prompt}` }],
            parent,
          },
          signal: activationAbort.signal,
          delivery: 'parent',
        })
        // The registry binding must exist before the child can call agent_http/agent_skill_run.
        if (typeof activation.childId === 'string' && activation.childId.length > 0) {
          bindChild(activation.childId)
        }
        return { text: prompt, afterIdle: cleanup }
      } catch (error) {
        await cleanup()
        throw error
      }
    },
  }
}

/** legacy 目录提供方缺失是装配错误:`index.ts` 总是传入已建好的 `agentsHost`。 */
function requireLegacyHost(options: CreateAgentPackageHostOptions): AgentsHost {
  const host = options.legacy?.()
  if (host === undefined) throw new Error('agents directory is not initialized')
  return host
}

/** 本地包 → 可调用条目;`name` 取 slug,`permissions` 由调用方的审批护栏负责。 */
function toInvocableListItem(pkg: AgentPackageListItem): AgentListItem {
  return {
    name: pkg.slug,
    displayName: pkg.displayName,
    source: 'local',
    kind: 'agent',
    description: pkg.description,
    version: pkg.version,
    permissions: [],
    enabled: pkg.enabled,
    ...(pkg.broken === undefined ? {} : { broken: pkg.broken }),
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

/**
 * Wait for `promise` to settle or for `timeoutMs` to elapse, whichever is first.
 *
 * A rejection is treated exactly like a resolution: cleanup records neither and
 * must not fail the caller's idle path.
 *
 * @param promise — the result or disposal to observe
 * @param timeoutMs — upper bound for the wait
 * @returns `true` when the promise settled first, `false` on timeout; never rejects
 */
function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false)
    }, timeoutMs)
    const finish = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    promise.then(finish, finish)
  })
}

function rememberLastText(lastText: Map<string, string>, sessionId: string, text: string): void {
  lastText.delete(sessionId)
  lastText.set(sessionId, text)
  if (lastText.size <= MAX_TRACKED_SESSIONS) return
  const oldest = lastText.keys().next().value
  if (oldest !== undefined) lastText.delete(oldest)
}
