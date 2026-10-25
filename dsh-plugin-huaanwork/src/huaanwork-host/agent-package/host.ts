import { randomUUID } from 'node:crypto'

import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

import {
  AGENT_PACKAGE_CHILD_TOOLS,
  agentPackageChildAttachmentNames,
  attachAgentTools,
  detachAgentTools,
  type AttachmentMaps,
} from '../../huaanwork-guardrails/agent-attachments.ts'
import { mountSessionMcp } from '../../huaanwork-guardrails/agent-mcp.ts'
import { refreshAgentRestrict } from '../../huaanwork-guardrails/present-as.ts'
import type { AgentListItem } from '../../client-huaanwork/rpc-types.ts'
import type { AgentsHost } from '../agents-host.ts'
import {
  resolveSubagents,
  type SubagentActivationHandle,
  type SubagentsService,
} from '../subagents-service.ts'
import { AGENT_PACKAGE_VERIFY_FAILURE, recoverCatalogPackageInstalls } from './catalog-install.ts'
import { agentPackageRevokedMessage, type AgentCatalogSecurity } from './catalog-security.ts'
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
  AgentPackageListItem,
  AgentPackageManifest,
  AgentPackageProposalInput,
  AgentPackageSubagentRequest,
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
  /** 包回合绑定的子会话 id;清理时逐一移除,供 policy 标记 `mcp__*` 的运行链路。 */
  huaanworkPackageChildSessions?: Set<string>
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

/** 取消来源:用户停止、撤销、更新、移除或应用退出。 */
export type AgentPackageTurnCancelReason = 'cancel' | 'revoke' | 'update' | 'remove' | 'dispose'

/**
 * 一条在途包回合。
 *
 * `runtime`/`activation` 在 dispatch 里异步产生,产生后写回**同一个** record;
 * `cancel` 由 dispatch 闭包实现(abort signal + 立即 dispose activation + 停 runtime
 * + 等待 cleanup),catalog-security 与 sessions 只能经 registry 间接调用它,
 * 不得反向访问 dispatch 闭包。
 */
export type AgentPackageActiveTurnRecord = {
  sessionId: string
  slug: string
  version: string
  controller: AbortController
  runtime?: AgentPackageTurnRuntime
  activation?: SubagentActivationHandle
  cancel(reason: AgentPackageTurnCancelReason): Promise<void>
  /**
   * 释放本回合在 dispatch 里同步占下的「每会话一个包回合」名额
   * (`pendingTurns`)。取消**请求**到达时就调用(先于等待 dispose/停进程),
   * 否则同一会话的下一条消息要等最长 600s 的 activation dispose 才能开始。
   * 实现内部按 sessionId + slug 身份校验,晚到的释放不会抹掉更新的回合。
   */
  releaseReservation?: () => void
}

/**
 * 在途回合登记表(index 只建一个,注入 host、catalog-security 与 sessions)。
 *
 * `register` 返回的 unregister 幂等,且只在表里仍是该 record 时删除它——晚到的
 * 清理不能抹掉同 session 的新回合。所有 cancel 方法等待**全部**匹配 record 的
 * `cancel`;单个回合清理失败不阻止其余回合。
 */
export type AgentPackageActiveTurnRegistry = {
  register(record: AgentPackageActiveTurnRecord): () => void
  cancelBySessionId(sessionId: string, reason: AgentPackageTurnCancelReason): Promise<void>
  cancelBySlug(slug: string, reason: AgentPackageTurnCancelReason): Promise<void>
  cancelAll(reason: AgentPackageTurnCancelReason): Promise<void>
}

/**
 * @returns 一个共享在途回合登记表;index 必须把同一实例交给 host、
 *   catalog-security 与 sessions,否则撤销/取消找不到正在跑的回合
 */
export function createAgentPackageActiveTurnRegistry(): AgentPackageActiveTurnRegistry {
  const records = new Set<AgentPackageActiveTurnRecord>()
  const cancelMatching = async (
    predicate: (record: AgentPackageActiveTurnRecord) => boolean,
    reason: AgentPackageTurnCancelReason,
  ): Promise<void> => {
    // 取调用瞬间的快照:取消期间新登记的回合由 dispatch 的撤销 generation
    // /运行前复验负责,不在这里补刀。
    const matching = [...records].filter(predicate)
    // 先同步释放名额:取消的收尾(`cancel` → dispose → 停 runtime)可能很慢,
    // 下一回合不应因此被拒。身份校验在 releaseReservation 内部完成。
    for (const record of matching) record.releaseReservation?.()
    await Promise.all(
      matching.map(async (record) => {
        try {
          await record.cancel(reason)
        } catch {
          // 单个回合的释放失败不影响其余同 slug/session 的回合。
        }
      }),
    )
  }
  return {
    register(record) {
      records.add(record)
      let registered = true
      return () => {
        if (!registered) return
        registered = false
        records.delete(record)
      }
    },
    cancelBySessionId(sessionId, reason) {
      return cancelMatching((record) => record.sessionId === sessionId, reason)
    },
    cancelBySlug(slug, reason) {
      return cancelMatching((record) => record.slug === slug, reason)
    },
    cancelAll(reason) {
      return cancelMatching(() => true, reason)
    },
  }
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
 * 宿主自己持有每个会话的 `lastUserText`、「同一轮已提出草稿」与「本轮命中创建入口」标记:
 * `noteUserText` 在每一轮用户原句到达时调用(写入新原句并清除两个标记),`noteCreationTurn`
 * 只在创建/继续创建分支调用;`propose` 成功后置位,`commit` 读取后拒绝同轮提交,并要求
 * 本轮命中创建流程。写路径成功后的 `agent/changed` 事件由上层路由发出,本宿主不持有 hub。
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
  /** 每轮用户发送都调用:记录原句并清除上一轮的创建流程标记。 */
  noteUserText(sessionId: string, text: string): void
  /** 只在创建/继续创建分支调用:标记本轮可以接受 `agent_commit`。 */
  noteCreationTurn(sessionId: string, text: string): void
  listLocal(): AgentPackageListItem[]
  detail(slug: string): AgentPackageDetail | undefined
  /** 损坏包只允许关闭;启用、更新与运行仍拒绝。 */
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
  /** 在途回合登记表;index 注入与 catalog-security/sessions 共用的实例。缺省时自建。 */
  activeTurns?: AgentPackageActiveTurnRegistry
  /**
   * 运行前复验与撤销状态(Task 10)。缺省时 catalog 包 fail closed
   * (`包校验失败`),本地包保持 M1 路径。
   */
  security?: AgentCatalogSecurity
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
 * 回合结束后等待子会话结果/释放的上限(10 分钟)。
 *
 * 父会话的 `whenIdle` 可能先于长子会话到达:HTTP/MCP 回合本来就会跑过父回合的
 * 空闲点,短上限会在子代理仍在工作时截断答案。这个上限只兜住「子进程卡住」
 * 的异常路径,避免父会话的 idle 清理被无限期挂起;超时后记一条错误并释放
 * activation(`dispose()` 负责发布后的取消),随后照常停止子进程。
 *
 * legacy `@agent` 的 `afterIdle` 复用同一上限与 `settleWithin`。
 */
export const ACTIVATION_CLEANUP_TIMEOUT_MS = 600_000

/**
 * 组装 `AgentPackageHost`。
 *
 * @param options profile 目录、`takenSlugs` 提供方,以及可选的原句回落读取
 * @returns 宿主门面
 */
export function createAgentPackageHost(options: CreateAgentPackageHostOptions): AgentPackageHost {
  const { profileDir, takenSlugs } = options
  const registry = options.registry ?? createAgentPackageRuntimeRegistry()
  const activeTurns = options.activeTurns ?? createAgentPackageActiveTurnRegistry()
  const security = options.security
  const createRuntime = options.createRuntime ?? startAgentPackageProcesses
  const stopRuntime = options.stopRuntime ?? stopAgentPackageProcesses
  const lastText = new Map<string, string>()
  const proposedThisTurn = new Set<string>()
  /**
   * 本轮是否命中创建/继续创建入口。
   *
   * 只在创建分支置位,`noteUserText` 每轮清除:技能/@ 轮即便原文是同意句,
   * 也不能用旧草稿的 draftId 提交。
   */
  const creationTurns = new Set<string>()
  /** 与 lastText 同一上限:长驻宿主不能按会话无限累积创建回合标记。 */
  const markCreationTurn = (sessionId: string): void => {
    creationTurns.delete(sessionId)
    creationTurns.add(sessionId)
    if (creationTurns.size > MAX_TRACKED_SESSIONS) {
      const oldest = creationTurns.values().next().value
      if (oldest !== undefined) creationTurns.delete(oldest)
    }
  }
  /** One live package turn per user session; the value is the slug that holds it. */
  const pendingTurns = new Map<string, string>()

  /**
   * 撤销派生:state 里的持久化撤销优先,其次内存撤销表。
   *
   * 撤销卡片的 `broken.reason` 与 dispatch 的拒绝文案同源,界面不需要自己拼。
   */
  const withRevoked = <T extends AgentPackageListItem>(item: T): T => {
    if (item.source !== 'catalog') return item
    // 有 security 时以它的版本匹配为准:state 里可能残留旧版本的 `revoked`
    // (更新到新版本后 Task 9 保留了该字段),不能据此把新版本误标成已撤销。
    const revoked = security === undefined ? item.revoked : security.revocationFor(item.slug)
    if (revoked === undefined) {
      // 旧版本撤销的残留字段不能带到卡片上,否则界面会显示「已撤销」但拒绝移除。
      return item.revoked === undefined ? item : { ...item, revoked: undefined }
    }
    return { ...item, revoked, broken: { reason: agentPackageRevokedMessage(revoked) } }
  }

  /**
   * 列表/`@` 分流共用的异步装饰:撤销与每次从磁盘复验。
   *
   * catalog 包在 verify 失败时保留详情(界面要能展示移除入口),只标 broken;
   * 未注入 security 时 fail closed,绝不把未复验的目录包放进可运行列表。
   */
  const decorateCatalogItem = async <T extends AgentPackageListItem>(item: T): Promise<T> => {
    if (item.source !== 'catalog') return item
    const decorated = withRevoked(item)
    if (decorated.broken !== undefined) return decorated
    if (security === undefined) {
      return { ...item, broken: { reason: AGENT_PACKAGE_VERIFY_FAILURE } }
    }
    const verification = await security.verifyInstalled(item.slug)
    // 保留 withRevoked 清掉的旧版本撤销残留;验证失败时在原条目上补 broken。
    return verification.ok ? decorated : { ...decorated, broken: { reason: verification.reason } }
  }

  return {
    async propose(sessionId, input) {
      // C17: 草稿校验会触发 store 的通用 `.old-*` 清理,catalog 恢复必须先跑。
      recoverCatalogPackageInstalls(profileDir)
      const result = await proposeAgentPackage(profileDir, sessionId, input, takenSlugs())
      if (result.ok) proposedThisTurn.add(sessionId)
      return result
    },

    async commit(sessionId, draftId, rawUserText, opts) {
      // C17: 提交路径会列出/覆盖包目录,必须在通用清理之前恢复广场交易。
      recoverCatalogPackageInstalls(profileDir)
      // 测试钩子:路由不得把 proposedThisTurn 从线上透传,否则同一轮门禁可被 false 关闭。
      const result = await commitAgentPackage(profileDir, sessionId, draftId, rawUserText, takenSlugs(), {
        proposedThisTurn: opts?.proposedThisTurn ?? proposedThisTurn.has(sessionId),
        creationTurn: creationTurns.has(sessionId),
      })
      if (result.ok) proposedThisTurn.delete(sessionId)
      return result
    },

    async cancel(sessionId) {
      recoverCatalogPackageInstalls(profileDir)
      proposedThisTurn.delete(sessionId)
      return cancelAgentPackage(profileDir, sessionId)
    },

    hasDraft(sessionId) {
      // 每轮消息都会走这里;广场安装的崩溃恢复同样必须先于 store 的通用清理。
      recoverCatalogPackageInstalls(profileDir)
      return loadAgentPackageDraft(profileDir, sessionId) !== undefined
    },

    async beginUpdate(sessionId, slug) {
      // C17: 读取更新基底会走 store 的通用恢复。
      recoverCatalogPackageInstalls(profileDir)
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
      creationTurns.delete(sessionId)
    },

    noteCreationTurn(sessionId, text) {
      rememberLastText(lastText, sessionId, text)
      proposedThisTurn.delete(sessionId)
      markCreationTurn(sessionId)
    },

    listLocal() {
      // C17: 广场安装的崩溃恢复必须先于 store 的通用 `.old-*` 清理。
      recoverCatalogPackageInstalls(profileDir)
      // 同步列表只派生撤销(不读 keyring);运行前复验在 dispatch 每次执行。
      return listLocalAgentPackages(profileDir).map((item) => withRevoked(item))
    },

    detail(slug) {
      recoverCatalogPackageInstalls(profileDir)
      const detail = readAgentPackage(profileDir, slug)
      return detail === undefined ? undefined : withRevoked(detail)
    },

    setEnabled(slug, enabled) {
      recoverCatalogPackageInstalls(profileDir)
      const stored = readAgentPackage(profileDir, slug)
      if (stored === undefined) throw new Error(`智能体 @${slug} 不存在`)
      // 已撤销的目录包只允许关闭,不允许再启用(移除/重装才是出路)。
      const detail = withRevoked(stored)
      if (enabled && detail.broken !== undefined) throw new Error(`智能体 @${slug} 已损坏:${detail.broken.reason}`)
      setAgentPackageEnabled(profileDir, slug, enabled)
    },

    async listWithLegacy() {
      recoverCatalogPackageInstalls(profileDir)
      const legacyList = requireLegacyHost(options).list()
      const packages = await Promise.all(listLocalAgentPackages(profileDir).map((item) => decorateCatalogItem(item)))
      return {
        packages,
        catalogAgents: legacyList.items.filter((item) => item.kind === 'agent'),
        ...(legacyList.catalogError === undefined ? {} : { catalogError: legacyList.catalogError }),
      }
    },

    async invocableWithLegacy() {
      recoverCatalogPackageInstalls(profileDir)
      // 撤销已在同步列表里派生为 broken;@ 补全因此不会出现已撤销的包。
      const localItems = listLocalAgentPackages(profileDir)
        .map((item) => withRevoked(item))
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
      recoverCatalogPackageInstalls(profileDir)
      const detail = readAgentPackage(profileDir, slug)
      if (detail === undefined) return undefined
      // 目录包每次进 @ 分流都从磁盘复验;失败保留详情并按 broken 拒绝运行。
      return decorateCatalogItem(detail)
    },

    async dispatch(input) {
      recoverCatalogPackageInstalls(profileDir)
      const { ctx, sessionId, pkg } = input
      // 目录包的撤销状态先看一眼:详情可能在撤销前取得(stale pkg),这里也要
      // 得到撤销文案,而不是「未启用或不存在」。
      if (pkg.source === 'catalog') {
        const revoked = security === undefined ? pkg.revoked : security.revocationFor(pkg.slug)
        if (revoked !== undefined) throw new Error(agentPackageRevokedMessage(revoked))
        // 没有复验面就不能声称目录包可运行;本地包不经过这条。
        if (security === undefined) throw new Error(AGENT_PACKAGE_VERIFY_FAILURE)
      }
      if (!pkg.enabled) throw new Error(`智能体「${pkg.slug}」未启用或不存在`)
      if (pkg.broken !== undefined) throw new Error(`智能体「${pkg.slug}」已损坏：${pkg.broken.reason}`)
      const subagents = resolveSubagents(ctx, 'startActivation')
      if (subagents === undefined) {
        throw new Error('current dsh runtime does not support subagents')
      }
      // Bind after the guard so the runtime method keeps its service receiver.
      const startActivation = subagents.startActivation.bind(subagents)

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
      /**
       * 取消状态(本回合唯一的取消源)。
       *
       * `cancelRequested`/`cancelReason` 在第一次 cancel 时写入;`cancelPromise`
       * 让并发 cancel 与 dispose 重入共享同一收尾;`cancelGate` 让 M1 的
       * 「先等 activation.result」在取消到达时立刻放行。
       */
      const controller = new AbortController()
      const signal = controller.signal
      let cancelRequested = false
      let cancelReason: AgentPackageTurnCancelReason | undefined
      let cancelPromise: Promise<void> | undefined
      /** 收尾链路正在同步建立(共享 promise 尚未赋值)时的重入标志。 */
      let cancelling = false
      let disposePromise: Promise<void> | undefined
      let stopRuntimePromise: Promise<void> | undefined
      let unregister: (() => void) | undefined
      let openCancelGate: () => void = () => undefined
      const cancelGate = new Promise<void>((resolve) => {
        openCancelGate = resolve
      })
      const boundChildren = new Set<string>()
      /** 本回合登记进 `huaanworkPackageChildSessions` 的 id;清理时逐一移除。 */
      const packageChildSessions = new Set<string>()

      /**
       * 取消/失败的统一错误。
       *
       * 撤销优先取当前生效的撤销记录,让 rejection 文案与撤销卡片一致
       * (`该版本已被管理员撤销：<原因>`);其余来源给出可定位的停止原因。
       */
      const cancelError = (): Error => {
        if (cancelReason === 'revoke') {
          const revoked = security === undefined ? pkg.revoked : security.revocationFor(pkg.slug)
          return revoked === undefined
            ? new Error('该版本已被管理员撤销')
            : new Error(agentPackageRevokedMessage(revoked))
        }
        if (cancelReason === 'update') return new Error(`智能体「${pkg.slug}」正在更新，本回合已停止`)
        if (cancelReason === 'remove') return new Error(`智能体「${pkg.slug}」已移除，本回合已停止`)
        if (cancelReason === 'dispose') return new Error(`智能体「${pkg.slug}」的回合已停止：应用正在退出`)
        return new Error(`智能体「${pkg.slug}」的回合已取消`)
      }

      /** 取消/abort 已生效时抛出取消原因;每个 await 之后都要重新过一遍。 */
      const assertLive = (): void => {
        if (cancelRequested || signal.aborted) throw cancelError()
      }

      /** dispose 只调用一次;取消与 cleanup 共享同一 promise。 */
      const disposeActivation = (handle: SubagentActivationHandle): Promise<void> => {
        disposePromise ??= (async () => {
          try {
            await handle.dispose()
          } catch {
            // 释放是尽力而为:dispose 同步抛错不能阻止进程与登记的清理。
          }
        })()
        return disposePromise
      }

      /** 停 runtime 只调用一次;晚到的 runtime 与 cleanup 共享同一 promise。 */
      const stopTurnRuntime = (current: AgentPackageTurnRuntime): Promise<void> => {
        stopRuntimePromise ??= (async () => {
          try {
            await stopRuntime(current)
          } catch {
            // 释放是尽力而为:单个子进程拒绝退出不阻塞其余清理。
          }
        })()
        return stopRuntimePromise
      }

      const bindChild = (childSessionId: string): void => {
        // Record even before the runtime exists: cleanup must clear every id this turn
        // added, and a later turn reusing the id must not inherit the package flag.
        ctx.huaanworkPackageChildSessions?.add(childSessionId)
        packageChildSessions.add(childSessionId)
        if (runtime === undefined) return
        // `skills.ts` attaches the runtime tools and MCP names before calling this;
        // cleanup detaches them again from every bound child.
        boundChildren.add(childSessionId)
        registry.bind(childSessionId, runtime)
      }

      /**
       * Undo everything this turn attached to a child session: the registry binding,
       * the tool attachments, `present-as`'s restrict and the policy's package-runtime
       * marker.
       *
       * Repeatable by design. When cancellation lands while `startActivation` is still
       * pending, `skills.ts` resumes after the first cleanup pass and calls `bindChild`,
       * which re-adds the child to every one of those places. The late-activation branch
       * disposes the activation and then runs this once more, so a revoked turn cannot
       * leave behind a stale policy exemption for an id the policy treats as dead.
       */
      const releaseChildBindings = (): void => {
        const current = runtime
        // Detach exactly what `skills.ts` attached to each child; `request.allow`
        // omits tools the package does not enable, so it cannot mirror the attachment.
        const childNames = [...new Set([...AGENT_PACKAGE_CHILD_TOOLS, ...(current?.mcpNames ?? [])])]
        for (const childSessionId of boundChildren) {
          if (current !== undefined && registry.get(childSessionId) === current) registry.delete(childSessionId)
          if (ctx.huaanworkAttachments !== undefined) {
            detachAgentTools(ctx.huaanworkAttachments, childSessionId, childNames)
          }
          refreshAgentRestrict(ctx as never, childSessionId)
        }
        boundChildren.clear()
        // Clear the policy's marker for every id this turn bound. `Set.delete` is
        // idempotent and only ever removes this turn's ids, so repeated passes cannot
        // strip a newer turn's markers.
        for (const childSessionId of packageChildSessions) {
          ctx.huaanworkPackageChildSessions?.delete(childSessionId)
        }
        packageChildSessions.clear()
      }

      const cleanup = async (): Promise<void> => {
        // The reservation belongs to this turn and ends with the first cleanup call,
        // including every failure path that reaches `catch` below.
        releaseReservation()
        cleanupStarted = true
        if (cleanupPromise !== undefined) return cleanupPromise
        cleanupPromise = (async () => {
          try {
            // Finish the child before releasing what it can still call: the parent can go
            // idle while the child is still working, so aborting or stopping the runtime
            // first would truncate the answer. `result` settles only after the manager's
            // own teardown; capturing it here keeps a failed child turn from rejecting the
            // parent's idle cleanup. Both waits are bounded so a stuck child cannot block
            // that cleanup forever.
            //
            // 取消是例外:它必须立刻 dispose 并停止进程,绝不能先等一个可能永不结算的
            // graceful result。`cancelGate` 让已经开始的 M1 等待在取消到达时立即放行。
            const currentActivation = activation
            if (currentActivation !== undefined) {
              if (cancelRequested) {
                await settleWithin(disposeActivation(currentActivation), ACTIVATION_CLEANUP_TIMEOUT_MS)
              } else {
                const settled = await Promise.race([
                  settleWithin(currentActivation.result, ACTIVATION_CLEANUP_TIMEOUT_MS),
                  cancelGate.then(() => false),
                ])
                if (!settled && !cancelRequested) {
                  // 发布后的取消归 dispose();这里只记录卡住的事实,不 abort signal。
                  console.error(
                    `智能体「${pkg.slug}」的子代理在 ${String(ACTIVATION_CLEANUP_TIMEOUT_MS / 60_000)} 分钟内未结束，释放 activation`,
                  )
                }
                await settleWithin(disposeActivation(currentActivation), ACTIVATION_CLEANUP_TIMEOUT_MS)
              }
            }
            const current = runtime
            if (current !== undefined) {
              await stopTurnRuntime(current)
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
            }
            releaseChildBindings()
            if (request !== null && ctx.huaanworkAgentPackageRequest?.current === request) {
              ctx.huaanworkAgentPackageRequest.current = null
            }
          } finally {
            // 清理完成后注销登记:unregister 幂等,且只在表里仍是本 record 时删除,
            // 晚到的清理不会抹掉同 session 的新回合登记。
            unregister?.()
          }
        })()
        return cleanupPromise
      }

      /**
       * 取消本回合:先 abort(阻止后续 spawn),再立即 dispose 已运行的
       * activation(不等 graceful result),最后停 runtime 并等待 cleanup。
       * 并发/重入共享同一 cancelPromise,不会双停,也不会删除更新的登记。
       */
      const cancelTurn = (reason: AgentPackageTurnCancelReason): Promise<void> => {
        if (cancelPromise !== undefined) return cancelPromise
        // `abort` 可能同步触发监听器重入本函数:共享 promise 必须先于 abort 建立,
        // 并且用 `cancelling` 覆盖「收尾链路同步建立中」的窗口,否则会起两条收尾
        // 链路,后到的 reason 覆盖先到的。
        if (cancelling) return Promise.resolve().then(() => cancelPromise ?? Promise.resolve())
        cancelling = true
        cancelRequested = true
        cancelReason = reason
        const error = cancelError()
        const teardown = (async () => {
          const currentActivation = activation
          if (currentActivation !== undefined) {
            await settleWithin(disposeActivation(currentActivation), ACTIVATION_CLEANUP_TIMEOUT_MS)
          }
          const currentRuntime = runtime
          if (currentRuntime !== undefined) await stopTurnRuntime(currentRuntime)
          await cleanup()
        })()
        cancelPromise = teardown
        openCancelGate()
        controller.abort(error)
        return cancelPromise
      }

      const record: AgentPackageActiveTurnRecord = {
        sessionId,
        slug: pkg.slug,
        version: pkg.version,
        controller,
        cancel: (reason) => cancelTurn(reason),
        releaseReservation,
      }
      // 登记必须早于第一次 await(尤其 security.assertRunnable):撤销刷新据此
      // 找到正在启动的回合,并 abort 同一个 signal。
      unregister = activeTurns.register(record)

      try {
        assertLive()
        const manifest = readDispatchManifest(profileDir, pkg.slug)
        const packageDir = agentPackageDir(profileDir, pkg.slug)
        const persona = await composeAgentPackagePersona(packageDir, manifest, profileDir)
        assertLive()
        const workspaceRoot = ctx.huaanworkWorkspaceRoot?.current ?? process.cwd()

        // 运行前复验(第一次,createRuntime 之前):目录包每次 dispatch 都重验,
        // 撤销/篡改在这里 fail closed。record 已登记,期间到达的撤销也能 abort。
        if (pkg.source === 'catalog' && security !== undefined) {
          await security.assertRunnable(pkg.slug, pkg.version)
        }
        assertLive()

        runtime = await createRuntime({
          manifest,
          packageDir,
          workspaceRoot,
          signal,
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
        // 晚到 runtime:取消可能发生在 createRuntime 期间。先写回 record,再停掉它
        // 并 cleanup,禁止继续 startActivation。
        record.runtime = runtime
        if (cancelRequested || signal.aborted) {
          await stopTurnRuntime(runtime)
          await cleanup()
          throw cancelError()
        }
        // 运行前复验(第二次,runtime 之后):createRuntime 期间到达的撤销即使
        // abort 了 signal,也以撤销文案结束而不是笼统的取消。
        if (pkg.source === 'catalog' && security !== undefined) {
          await security.assertRunnable(pkg.slug, pkg.version)
        }
        assertLive()

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
        const prompt = input.remainder.trim() || pkg.description || '开始协助工作。'
        const parent = input.resolveParent === undefined ? undefined : await input.resolveParent()
        assertLive()
        if (parent === undefined || parent === null) {
          throw new Error(`智能体「${pkg.slug}」无法开始：当前会话没有可用的父会话`)
        }
        // 子代理的首条模型请求在 `skills.ts` 的 activation 包装运行之前就已组装工具清单,
        // 所以预留子会话 id、按它预先挂载并先登记运行时;包装在 activation 之后做同批
        // 挂载只是幂等安全网。预留 id 进 request 与 activation spec,provider 必须沿用。
        const reservedChildId: SessionId = brandString<SessionId>(randomUUID())
        const childToolNames = agentPackageChildAttachmentNames(allow, mcpNames)
        if (ctx.huaanworkAttachments !== undefined && childToolNames.length > 0) {
          attachAgentTools(ctx.huaanworkAttachments, reservedChildId, childToolNames)
        }
        bindChild(reservedChildId)
        request = { allow, persona, runtime, parentSessionId: sessionId, childId: reservedChildId, bindChild }
        registry.bind(sessionId, runtime)

        // Publish the request synchronously before the call: the skills wrapper reads it
        // before its first await, so no sibling activation can claim this turn's request.
        if (ctx.huaanworkAgentPackageRequest !== undefined) {
          ctx.huaanworkAgentPackageRequest.current = request
        }
        assertLive()
        activation = await startActivation({
          provider: 'spawn',
          label: `@${pkg.slug}`,
          // 预留 id 让首条请求就带上包工具;spawn 后端支持续接故接受该字段。
          childId: reservedChildId,
          request: {
            // rc.1 的 SubagentStartRequest 没有 persona 字段:人设作为带分隔的前缀
            // 并入子代理的首条用户消息,用户请求原样保留在后。
            prompt: [{ type: 'text', text: `${persona}\n\n---\n用户请求：\n${prompt}` }],
            parent,
          },
          // 与 createRuntime 同一个 signal:撤销/取消在 spawn 前生效,
          // runtime.ts 的每次 spawn 也会检查 aborted。
          signal,
          delivery: 'parent',
        })
        // 晚到 activation:取消发生在 startActivation 期间时,必须立即 dispose 这个
        // 新 activation 并 cleanup,不能留下「取消时还没 activation,所以永不 dispose」
        // 的活回合。
        record.activation = activation
        // 取消路径不会等 graceful result;这里仍挂一个观察者,避免子代理迟到的
        // rejection 在没人 await 时变成 unhandled rejection。
        void activation.result.catch(() => undefined)
        if (cancelRequested || signal.aborted) {
          await settleWithin(disposeActivation(activation), ACTIVATION_CLEANUP_TIMEOUT_MS)
          // The wrapper resumes during `startActivation` and may bind the child after the
          // first cleanup pass already unbound it; dispose the late activation and clear
          // whatever it re-added before failing the turn.
          releaseChildBindings()
          await cleanup()
          throw cancelError()
        }
        // The registry binding must exist before the child can call agent_http/agent_skill_run.
        const activationChildId = activation.childId
        if (typeof activationChildId === 'string' && activationChildId.length > 0) {
          if (activationChildId !== reservedChildId && ctx.huaanworkAttachments !== undefined && childToolNames.length > 0) {
            // provider 忽略预留 id 时,同一批名字也要挂在它实际分配的 id 上。
            attachAgentTools(ctx.huaanworkAttachments, activationChildId, childToolNames)
          }
          bindChild(activationChildId)
        }
        return { text: prompt, afterIdle: cleanup }
      } catch (error) {
        await cleanup()
        // 取消/撤销期间任何启动失败都以取消原因结束:用户看到的应是撤销或停止,
        // 而不是被 abort 触发的底层错误(如「智能体启动已取消」)。
        if (cancelRequested || signal.aborted) throw cancelError()
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

/** 本地/已安装包 → 可调用条目;`name` 取 slug,`permissions` 由调用方的审批护栏负责。 */
function toInvocableListItem(pkg: AgentPackageListItem): AgentListItem {
  return {
    name: pkg.slug,
    displayName: pkg.displayName,
    source: pkg.source,
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
export function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
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
