import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { narrowArtifactNativeCapability, type ConfirmedRestartRuntime, type SystemResumeRuntime } from '../host-runtime-bridge.ts'
import { sweepLegacyChatAutoSessions } from './automation-sweep.ts'
import { createHuaanworkEventHub, HUAANWORK_EVENTS_PATH } from './events.ts'
import { installHuaanworkHolders } from './holders.ts'
import { createExpertTeamStore } from './expert-team/store.ts'
import { createExpertTeamRunRegistry } from './expert-team/runs.ts'
import { createExpertTeamCoordinator } from './expert-team/coordinator.ts'
import { disposeAllExpertTeamObservers } from './expert-team/observer.ts'
import { createSubagentRunRegistry } from './subagent-runs.ts'
import { createTurnScheduler } from './turn-scheduler.ts'
import { installTurnAnchorHooks } from './turn-anchors.ts'
import { installNetworkGate } from './net-gate.ts'
import { startAutomationScheduler, evaluateDueAutomations } from './automation-scheduler.ts'
import { bindAutomationRuntime, type AutomationRuntime } from './automations-host.ts'
import { registerKeepAwakeRoute } from './keep-awake-route.ts'
import { registerHuaanworkRoutes } from './routes.ts'
import { sweepProjectLegacySessionsOncePerProcess } from './session-sweep.ts'
import { ensureSkillCenterMigration } from './skill-center-migration.ts'
import { createAgentsHost } from './agents-host.ts'
import {
  setAgentPackageActiveTurns,
  setAgentPackageHost,
  setAgentsDirectory,
  setReevaluateDueAutomations,
} from './sessions.ts'
import { createAgentCatalogSecurity } from './agent-package/catalog-security.ts'
import { recoverCatalogPackageInstalls } from './agent-package/catalog-install.ts'
import {
  createAgentPackageActiveTurnRegistry,
  createAgentPackageHost,
  type AgentPackageActiveTurnRegistry,
  type AgentPackageDispatchContext,
} from './agent-package/host.ts'
import { createAgentPackageLifecycleLock } from './agent-package/lifecycle.ts'
import {
  configureAgentCatalog,
  readCachedCatalogPackageSlugs,
  refreshCatalogPackageCache,
} from './agent-package/catalog-client.ts'
import { createAgentPackageRuntimeRegistry, stopAllAgentPackageProcesses } from './agent-package/runtime.ts'
import { createSkillCreationHost, setSkillCreationHost } from './skill-creation.ts'
import { readHuaanworkSettingsSync } from './settings.ts'
import { configureSkillCatalog } from './skill-catalog-client.ts'
import { listProjects, listTasks, runsDir } from './stores.ts'
import { clearPendingWorkspaceRoot, neutralAutomationsBaseDir, neutralKnowledgeBaseDir, neutralSessionsBaseDir, neutralWorkspaceRoot } from './workspace-state.ts'
import { createKnowledgeHost } from './knowledge/host.ts'
import { registerCallHostTool } from '../huaanwork-guardrails/agent-tool.ts'
import {
  registerAgentPackageCreationTools,
  registerAgentPackageRuntimeTools,
} from '../huaanwork-guardrails/agent-package-tools.ts'
import {
  makeResultPresentClaimed,
  registerResultArtifactTools,
} from '../huaanwork-guardrails/result-artifact-tools.ts'
import {
  makeExpertTeamClaimed,
  registerExpertTeamDispatchTool,
} from '../huaanwork-guardrails/expert-team-dispatch.ts'
import { registerSkillCreationTools } from '../huaanwork-guardrails/skill-creation-tools.ts'

export const name = 'huaanwork-host'
export const inject = ['webServer', 'agents', 'subagents', 'desktopRuntime']

export interface HuaanworkHostConfig {
  dshHome: string
  profileDir: string
  workspaceRoot: string
  checkpointUserDataDir?: string
  /** profile 行 / profile-boot 桩可关调度器。测试缝是 HUAANWORK_AUTOMATION_TICK_MS,不是这个开关。 */
  automationScheduler?: {
    disabled?: boolean
  }
}

export const Config: z<HuaanworkHostConfig> = z.object({
  dshHome: z.string(),
  profileDir: z.string(),
  workspaceRoot: z.string(),
  checkpointUserDataDir: z.string(),
  automationScheduler: z.object({
    disabled: z.boolean().default(false),
  }).default({ disabled: false }),
})

/**
 * 应用退出时的智能体包收尾(最终评审 I2)。
 *
 * `cancelAll('dispose')` 会等每个回合的 `activation.dispose()`(上限 600s)和
 * runtime 停止;若只 `void` 发起整条链路,应用可能在 SIGTERM 到达 detached
 * 子进程之前就退出,留下孤儿进程。因此:
 *
 *   1. **同步启动**进程 kill 路径(`stopAll`)——信号在本次 tick 内发出;
 *   2. 等待 `cancelAll('dispose')`(保留「先取消回合、再等停止完成」的顺序);
 *   3. 等第 1 步的 kill 路径结算。
 *
 * 返回的 promise 作为 effect disposer 的返回值,Cordis 在 fiber 卸载时会 await
 * 它(`Disposable<Promise<void>>`),所以 `ctx.fiber.dispose()` 也等到收尾完成。
 */
export async function disposeAgentPackageRuntime(
  activeTurns: AgentPackageActiveTurnRegistry,
  stopAll: () => Promise<void> = stopAllAgentPackageProcesses,
): Promise<void> {
  let stopFailure: unknown
  // Attach the catch immediately: cancellation may take up to 600s, and an
  // early rejection of `stopAll` must not surface as an unhandled rejection
  // while we are still waiting for it.
  const stopping = stopAll().catch((cause: unknown) => {
    stopFailure = cause
  })
  try {
    await activeTurns.cancelAll('dispose')
  } catch (error) {
    // Task 8:cancelAll 在任一回合清理失败时抛聚合错误。退出路径没有调用方接
    // 这个 rejection,而且此时进程 kill 已经发起:只记录,不制造 unhandled
    // rejection,也不跳过对 stopAll 的等待。
    console.error(error instanceof Error ? error.message : String(error))
  }
  await stopping
  if (stopFailure !== undefined) throw stopFailure
}

/** 与 effect disposer 同形的工厂(测试缝可替换 `stopAll`)。 */
export function createAgentPackageRuntimeDisposer(
  activeTurns: AgentPackageActiveTurnRegistry,
  stopAll?: () => Promise<void>,
): () => Promise<void> {
  return () => disposeAgentPackageRuntime(activeTurns, stopAll)
}

/**
 * effect cleanup 实际调用的收尾入口(最终评审 Critical 回归修复)。
 *
 * `ctx.effect` 的 cleanup 返回值会被 Cordis 当成 disposer **保存**;返回
 * `createAgentPackageRuntimeDisposer(...)`(一个函数)等于把收尾本身又包了一层
 * 函数,Cordis 不会调用它 ⇒ `cancelAll('dispose')` 与
 * `stopAllAgentPackageProcesses()` 在应用退出/热替换时从不执行。
 * 因此这里必须**直接发起**收尾并返回 promise。
 */
export function disposeAgentPackageHostRuntime(
  activeTurns: AgentPackageActiveTurnRegistry,
  stopAll?: () => Promise<void>,
): Promise<void> {
  return disposeAgentPackageRuntime(activeTurns, stopAll)
}

/**
 * 团队成员 activation 的 parent:必须是该会话的同一个 live agent 对象。
 *
 * 与 sessions 的 `findAgentBySession` 同序:`agents.get(sessionId)` 优先,再按
 * `id`/`session.id` 精确匹配;找不到时返回 `undefined`,由包派发给出「当前会话
 * 没有可用的父会话」,不猜测别的会话。
 */
function findLiveAgentForSession(ctx: Context, sessionId: string): unknown {
  const agents = (
    ctx as unknown as {
      agents?: {
        get?: (id: string) => unknown
        list?: () => readonly { id?: string; session?: { id?: string } }[]
      }
    }
  ).agents
  const direct = agents?.get?.(sessionId)
  if (direct !== undefined && direct !== null) return direct
  return agents?.list?.().find((agent) => agent.id === sessionId || agent.session?.id === sessionId)
}

export async function apply(ctx: Context, config: HuaanworkHostConfig): Promise<void> {
  ctx.huaanworkCheckpointUserDataDir = config.checkpointUserDataDir ?? ''
  // generation 重启防循环:组合期已消费 pendingRoot,首个 effect 立即清除——
  // 此后 boot 失败时,下次组合回中立根,恢复窗口可达(spec §9)。
  ctx.effect(() => {
    clearPendingWorkspaceRoot(config.profileDir)
    return () => {}
  }, 'huaanwork: clear pending workspace root')
  const hub = createHuaanworkEventHub()
  // 评审 R3:能力守卫——非 ElectronDesktopRuntime 提供的 desktopRuntime(测试桩/
  // 第三方 Host)缺确认回传方法时,抛出可定位的具名错误,而不是裸 TypeError
  // 「requestConfirmedRestart is not a function」。
  const routeCtx = installHuaanworkHolders(ctx, config, hub, () => {
    const runtime = ctx.desktopRuntime as ConfirmedRestartRuntime
    if (typeof runtime.requestConfirmedRestart !== 'function') {
      throw new Error('huaanwork-host: desktopRuntime 缺少 requestConfirmedRestart()(插件安装确认重启需要原生确认回传能力;请使用 ElectronDesktopRuntime)')
    }
    return runtime.requestConfirmedRestart()
  })
  // Artifact 原生能力同样是窄接口:三个方法齐备才注入;测试桩/第三方 Host 缺席时
  // 路由明确报 artifact-native-unavailable,而不是在调用点抛裸 TypeError。
  const artifactNative = narrowArtifactNativeCapability(ctx.desktopRuntime)
  if (artifactNative !== undefined) routeCtx.artifactNative = artifactNative
  // 共享回合锚点:holders 注入实例,这里挂 pre-step 写锚点与 session/disposed 清理。
  installTurnAnchorHooks(ctx)
  // result_present 的会话附件切换:claim 早于 prompt assembly,通知处理器必须同步完成
  // attach/detach + restrict,工具的首次可见性才成立(顶层 inject 不含 'tools',只注册通知)。
  ctx.on('agent/inbox/claimed', makeResultPresentClaimed(ctx), { global: true })
  // 专家团团长的 expert_team_dispatch 附件同样在 claim 同步切换(设计 §12.1):只在
  // 「运行中团队 + 匹配 clientMessageId + 有效租约」的回合挂载。与 result_present
  // 紧邻注册、同在顶层 apply(不在 tools effect 内),`tools` 重提供时不会重复挂监听。
  ctx.on('agent/inbox/claimed', makeExpertTeamClaimed(ctx), { global: true })
  // 技能中心一次性迁移必须在技能路由可用前完成:旧用户技能与旧启用的普通内置
  // 技能都要先变成“本地副本 + user-skill-toggles.json”。失败不写完成标记,
  // 下次启动重入;错误只记录,不阻塞桌面其余部分。
  try {
    for (const warning of await ensureSkillCenterMigration(config.profileDir)) {
      routeCtx.logger(`[skills] ${warning}`)
    }
  } catch (cause) {
    routeCtx.logger(
      `[skills] 本地技能状态迁移失败，将在下次启动重试:${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  // 子代理 run 权威状态机(设计 §5.2):holders 安装后创建一次,经 ctx 注入;
  // 事件与路由共用同一个 hub.broadcast(routeCtx.emit)。
  const subagentRuns = createSubagentRunRegistry({ emit: routeCtx.emit })
  ctx.huaanworkSubagentRuns = subagentRuns
  // 专家团:定义存储与运行注册表各创建一次,运行期只 mutate;expertTeam.* 路由与
  // 后续协调器读到的都是这里的同一引用。
  ctx.huaanworkExpertTeamStore = createExpertTeamStore(config.profileDir)
  ctx.huaanworkExpertTeamRuns = createExpertTeamRunRegistry({ emit: routeCtx.emit })
  // Task 6:唯一回合调度器与两张会话表。routeCtx.runtimeCtx 就是同一个 ctx,
  // sessionSend、出队、模型适配器、沙箱与工具执行读到的都是这里的同一引用。
  const turnScheduler = createTurnScheduler({
    maxConcurrentTurns: () => readHuaanworkSettingsSync(config.profileDir).max_concurrent_turns,
    modelExists: (modelId) =>
      readHuaanworkSettingsSync(config.profileDir).models.some((model) => model.id === modelId),
  })
  ctx.huaanworkSessionModels = new Map()
  ctx.huaanworkSessionRoots = new Map()
  ctx.huaanworkTurnScheduler = turnScheduler
  // 执行体与 collector 接线。调度 tick 走同一 enqueueAutomation,不直接调 executeRun。
  const runtime = ctx as unknown as AutomationRuntime
  bindAutomationRuntime(runtime, routeCtx)
  // Task 8:用户队列出完(或脚本进程 close)后按同一段「列出到期项并准入」再评估一次。
  setReevaluateDueAutomations(() => {
    void evaluateDueAutomations()
  })
  // —— 启动存量清扫(G6,Task 6.12;旧 host.ts:922/936 同位置语义;裁定 D-M6-24 / R-6.12-1)——
  // 在 apply() 内执行 ⇒ 每次进程启动都会跑,天然晚于
  // main.ts 的一次性迁移钩子:迁移搬进来的 legacy chat-auto 日志由同一次启动清掉。
  // 两侧都幂等;清扫失败只记日志,不把启动拖下水——存量垃圾的 IO 故障不该让 boot 失败。
  // 分工(R-6.12-1):chat-auto 清扫每代都跑(廉价:readdir + 前缀判据,不解压任何日志;
  // D-M6-24 的迁移时序论证针对的正是它);项目存量清扫要解压会话日志读 cwd 判归属,
  // 按旧 host.ts:936 的「进程启动只扫一次」语义用进程级门闩(实现与理由见 session-sweep.ts)。
  try {
    const sweptChatAuto = await sweepLegacyChatAutoSessions(join(config.dshHome, 'sessions'), runsDir(config.profileDir))
    if (sweptChatAuto > 0) {
      routeCtx.logger(`[automations] swept ${sweptChatAuto} legacy chat-auto session directories`)
    }
  } catch (cause) {
    routeCtx.logger(`[automations] legacy chat-auto sweep failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  try {
    const referencedSessionIds = new Set(
      (await listTasks(config.profileDir))
        .map((task) => task.sessionId)
        .filter((id): id is string => typeof id === 'string'),
    )
    const registeredProjectRoots = (await listProjects(config.profileDir)).map((project) => project.root)
    // 中立根排除在 protectedRoots:registeredProjectRoots 可能是中立根的祖先目录(项目根注册在
    // profileDir 之上),此时 cwd 前缀比较会误命中中立根下的游离会话——规格 §1.3 要求它们永不清扫。
    // 平级的中立命名空间同理(独立会话根 / 存量未绑定自动化根):它们与项目根只差一层目录名,
    // 祖先项目根的前缀比较会一并命中,必须逐个排除,否则启动即删掉刚铸造的独立会话目录。
    const sweptProjectLegacy = await sweepProjectLegacySessionsOncePerProcess(
      join(config.dshHome, 'sessions'),
      registeredProjectRoots,
      referencedSessionIds,
      [
        neutralWorkspaceRoot(config.profileDir),
        neutralSessionsBaseDir(config.profileDir),
        neutralAutomationsBaseDir(config.profileDir),
        // M1-1：知识库中立根是 wiki/整理会话的 cwd 归属地；登记项目根可能是它的
        // 祖先（profileDir 之上），前缀比较会误命中——规格 §1.3 要求永不清扫。
        neutralKnowledgeBaseDir(config.profileDir),
      ],
    )
    if (sweptProjectLegacy.ran && (sweptProjectLegacy.removed > 0 || sweptProjectLegacy.skipped > 0)) {
      routeCtx.logger(`[sessions] swept ${sweptProjectLegacy.removed} project legacy session logs, skipped ${sweptProjectLegacy.skipped}`)
    }
  } catch (cause) {
    routeCtx.logger(`[sessions] project legacy sweep failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  // ticker 不是 TCP/UDP listener,不进 post-boot listener 门禁。
  // effect 在 compose 之后首次执行,与 gates 的 listener 基线窗口错开。
  ctx.effect(() => {
    return startAutomationScheduler(runtime, routeCtx, {
      disabled: config.automationScheduler?.disabled === true,
    })
  }, 'huaanwork: automation scheduler')
  // M1-1 知识库宿主：顶层独立 effect（绝不放进 tools effect）。0 库启动只读注册表；
  // 系统休眠恢复经窄接口可选订阅，退场 disposer 先取消订阅、再 ≤1s 并行退场。
  // 生产接线必须自己 start（不依赖任何测试调用）。
  ctx.effect(() => {
    const knowledgeHost = createKnowledgeHost({ profileDir: config.profileDir })
    void knowledgeHost.start().catch((cause: unknown) => {
      routeCtx.logger(
        `[knowledge] host start failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    })
    const desktopRuntime = ctx.desktopRuntime as SystemResumeRuntime | undefined
    let unsubscribeSystemResume: (() => void) | undefined
    if (typeof desktopRuntime?.subscribeSystemResume === 'function') {
      try {
        const release = desktopRuntime.subscribeSystemResume(() => {
          void knowledgeHost.handleSystemResume().catch((cause: unknown) => {
            routeCtx.logger(
              `[knowledge] system resume failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            )
          })
        })
        if (typeof release === 'function') unsubscribeSystemResume = release
      } catch (cause) {
        routeCtx.logger(
          `[knowledge] system resume subscription failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
    }
    return async () => {
      try {
        unsubscribeSystemResume?.()
      } finally {
        await knowledgeHost.dispose()
      }
    }
  }, 'huaanwork: knowledge host')
  // 智能体目录真实接线(Task 10):fetch 公用机目录 + 本地 endpoints,存储根 = profileDir;
  // 目录快照同步进 huaanworkAgentCatalog holder(agent-invoke 的 @agent 分发消费)。
  // P1 修复(2026-10-14,A4-1 证据 §二):目录变更时同步重注册 call_host_tool,
  // 刷新其描述中的可用小工具清单(execute 本就读 live holder,不受陈旧描述影响)。
  let syncHostToolDescription: (() => void) | undefined
  // M2(Task 8):发布/安装共用同一个目录绑定。profileDir、settings 读取、client、
  // logger 与 changed 事件都从这里进入;Task 9/10 复用同一单例,不再各自接线。
  // Task 10 启动顺序:恢复广场交易 → 唯一的在途回合登记表 → 目录绑定 →
  // 安全面(keyring + 缓存撤销应用)→ 异步刷新 → 注入 host/sessions。
  recoverCatalogPackageInstalls(config.profileDir)
  const agentPackageTurns = createAgentPackageActiveTurnRegistry()
  // Task 8:同一个 per-slug 门禁交给目录绑定(install/update/remove)与 host
  // (dispatch),交易期间的同 slug `@slug` 因此在同步阶段被拒。
  const agentPackageLifecycle = createAgentPackageLifecycleLock()
  const catalogClient = configureAgentCatalog({
    profileDir: config.profileDir,
    readSettings: () => readHuaanworkSettingsSync(config.profileDir),
    logger: routeCtx.logger,
    lifecycle: agentPackageLifecycle,
    emitChanged: (slug) => {
      ctx.huaanworkEmit(slug === undefined ? { event: 'agent/changed' } : { event: 'agent/changed', slug })
    },
  })
  ctx.huaanworkAgentCatalogClient = catalogClient
  // 技能目录客户端:每次请求重新读取 settings,保存后无需重启 Host。
  configureSkillCatalog({ readSettings: () => readHuaanworkSettingsSync(config.profileDir) })
  // 运行前安全面:keyring 缺失/非法只让 catalog 包 fail closed;缓存的撤销在构造
  // 后立刻应用(启动时还没有在途回合),随后异步刷新一次并保留失败告警。
  const agentCatalogSecurity = createAgentCatalogSecurity({
    profileDir: config.profileDir,
    registry: agentPackageTurns,
  })
  ctx.huaanworkAgentCatalogSecurity = agentCatalogSecurity
  const cachedRevocations = agentCatalogSecurity.loadCachedRevocations()
  if (cachedRevocations.warning !== undefined) {
    routeCtx.logger(`[agent-catalog] ${cachedRevocations.warning}`)
  }
  void agentCatalogSecurity
    .refreshRevocations()
    .then((result) => {
      if (result.warning !== undefined) routeCtx.logger(`[agent-catalog] ${result.warning}`)
    })
    .catch((cause: unknown) => {
      routeCtx.logger(
        `[agent-catalog] 撤销列表刷新失败:${cause instanceof Error ? cause.message : String(cause)}`,
      )
    })
  // 启动时后台拉一次签名广场缓存;失败只记日志并保留旧缓存,不阻塞 boot。
  void refreshCatalogPackageCache()
    .then((result) => {
      if (result.warning !== undefined) routeCtx.logger(`[agent-catalog] ${result.warning}`)
    })
    .catch((cause: unknown) => {
      routeCtx.logger(
        `[agent-catalog] 目录缓存刷新失败:${cause instanceof Error ? cause.message : String(cause)}`,
      )
    })
  const agentsHost = createAgentsHost({
    storageRoot: config.profileDir,
    readSettings: () => {
      const settings = readHuaanworkSettingsSync(config.profileDir)
      return {
        agents_host: settings.agents_host,
        agents_port: settings.agents_port,
        agents_catalog_token: settings.agents_catalog_token,
      }
    },
    onCatalogChange: () => {
      ctx.huaanworkAgentCatalog.current = agentsHost.snapshotForRuntime()
      syncHostToolDescription?.()
    },
  })
  setAgentsDirectory(agentsHost)
  ctx.huaanworkAgentCatalog.current = agentsHost.snapshotForRuntime()
  // 本地智能体包宿主:创建入口(sessions.ts)、`@slug` 分流(agent-invoke)、
  // agent_propose/agent_commit、agent_skill_run/agent_http 与 Task 7 路由共用同一
  // 实例与会话级运行时登记表。takenSlugs 每次读当前目录快照(公用机条目 + 本地工具),
  // 目录变化后无需重建宿主;host 自己持有 per-session 原句与「同一轮已 propose」标记。
  const agentPackageRegistry = createAgentPackageRuntimeRegistry()
  const agentPackageHost = createAgentPackageHost({
    profileDir: config.profileDir,
    // 本地工具/已有智能体 + 最近一次成功拉取的签名广场 slug:离线时也能拒绝
    // 已知的广场重名;服务端提交/批准仍做权威冲突检查。
    takenSlugs: () => [
      ...agentsHost.snapshotForRuntime().items.map((item) => item.name),
      ...readCachedCatalogPackageSlugs(),
    ],
    // 包列表/详情/可调用列表与启停路由经同一目录实例合并 legacy 条目。
    legacy: () => agentsHost,
    registry: agentPackageRegistry,
    // Task 10:撤销/取消与 catalog-security、sessions 共用同一在途回合登记表。
    activeTurns: agentPackageTurns,
    // Task 8:与目录绑定共享同一 per-slug 门禁。
    lifecycle: agentPackageLifecycle,
    security: agentCatalogSecurity,
  })
  setAgentPackageHost(agentPackageHost)
  setAgentPackageActiveTurns(agentPackageTurns)
  ctx.huaanworkAgentPackageHost = agentPackageHost
  // 专家团运行协调器(设计 §10.2 / §12.1):顶层 apply 只创建一次并挂到 holder,
  // 使 `expert_team_dispatch`、claim 附件判定与 Task 12 的 result_present 交付校验
  // 共享同一实例与同一批租约/信号量。成员包在入口与出队都由包宿主实时解析;
  // 派工走 Task 7 的 `dispatchTeamMember`(团队路径,不改普通 `@slug` 的语义)。
  const expertTeamCoordinator = createExpertTeamCoordinator({
    runs: ctx.huaanworkExpertTeamRuns,
    resolveMemberPackage: async (agentRef) => {
      // 与可用性规则一致:只按包自身来源 + slug 精确匹配,不跨来源回退;
      // 经 findInvocable 对 catalog 包做异步磁盘验签,排队/运行中途损坏提前在入口或出队阻断。
      const pkg = await agentPackageHost.findInvocable(agentRef.slug)
      return pkg === undefined || pkg.source !== agentRef.source ? undefined : pkg
    },
    dispatchMember: (request) =>
      agentPackageHost.dispatchTeamMember({
        ctx: ctx as unknown as AgentPackageDispatchContext,
        sessionId: request.parentSessionId,
        teamRunId: request.teamRunId,
        pkg: request.pkg,
        // 协调器已按成员职责/输出要求/引用结果/审查标记渲染成完整提示词。
        remainder: request.prompt,
        clientMessageId: request.clientMessageId,
        signal: request.signal,
        onRunCreated: (info) => request.onRunCreated({ runId: info.runId }),
        resolveParent: () => Promise.resolve(findLiveAgentForSession(ctx, request.parentSessionId)),
      }),
    // 定向取消只作用于该父会话下的成员 run(registry 自身校验归属)。
    requestMemberCancel: (parentSessionId, memberRunId) =>
      subagentRuns.requestCancel(parentSessionId, memberRunId),
    // 终止整团同时取消团长回合(§13.3)：找当前 live agent 发起 user 取消；已终结或
    // 不支持的 agent 不阻断成员清理。
    cancelParentTurn: (parentSessionId) => {
      const agent = findLiveAgentForSession(ctx, parentSessionId)
      if (agent === undefined || agent === null) return
      const cancel = (agent as { cancel?: (cause: { kind: 'user' }) => void }).cancel
      if (typeof cancel !== 'function') return
      try {
        cancel.call(agent, { kind: 'user' })
      } catch {
        // 父回合已结算时取消无效果；成员清理照常继续。
      }
    },
    // 成员被外部定向停止时把失败收敛为 stopped:读 run 投影的停止相,不解析文案。
    isMemberCancelled: (parentSessionId, memberRunId) => {
      const run = subagentRuns.get(memberRunId)
      if (run === undefined || run.parentSessionId !== parentSessionId) return false
      return run.phase === 'stopping' || run.phase === 'stopped'
    },
  })
  ctx.huaanworkExpertTeamCoordinator = expertTeamCoordinator
  // 对话创建技能宿主:发送入口(sessions.ts)、skill_propose/skill_commit 与“我的技能”
  // 刷新共用同一实例;宿主自己持有 per-session 原句与回合标记,`hasDraft` 读磁盘草稿。
  const skillCreationHost = createSkillCreationHost({ profileDir: config.profileDir })
  setSkillCreationHost(skillCreationHost)
  // call_host_tool 注册接线(P1 修复):旧 sidecar 的生产调用在桌面移植时遗失,
  // @点名 HTTP 小工具链路因此断裂。工具全局注册单实例,执行边界在 policy 的会话
  // 附件门禁(decide.ts:111-112:unattached → deny),可见性由 present-as 的
  // ALLOWED_TOOLS(present-as.ts:27)放行——与旧 sidecar 同构的纵深防御。
  // 经桥接对象显式持有 tools 服务、目录 holder 与 profileDir:
  // registerCallHostTool 按鸭子类型消费(agent-tool.ts:127 ctx: unknown),
  // 不依赖子上下文对 holder 属性的原型链可见性。
  ctx.plugin({
    inject: ['tools'],
    apply: (pc: Context) => {
      pc.effect(() => {
        // 门面在父作用域创建;tools 服务重提供会让本 effect 重跑,而旧 disposer 已把它
        // 清空。每次注册前重新注入,保证工具重新挂载期间 getSkillCreationHost() 仍可用。
        setSkillCreationHost(skillCreationHost)
        const toolCtx = {
          tools: (pc as unknown as { tools?: unknown }).tools,
          huaanworkAgentCatalog: ctx.huaanworkAgentCatalog,
          huaanworkProfileDir: config.profileDir,
          // 创建工具发事件、读附件与按会话刷新 restrict 所需的 holder 桥接。
          huaanworkEmit: ctx.huaanworkEmit,
          huaanworkAgentPackageHost: agentPackageHost,
          huaanworkAttachments: ctx.huaanworkAttachments,
          // result_present 用共享回合锚点把每次提交归到当前真实用户回合。
          huaanworkTurnAnchors: ctx.huaanworkTurnAnchors,
          // 团队工具与 Task 12 的交付校验必须读同一协调器/运行注册表实例。
          huaanworkExpertTeamCoordinator: ctx.huaanworkExpertTeamCoordinator,
          huaanworkExpertTeamRuns: ctx.huaanworkExpertTeamRuns,
          // commit 成功后的解绑要等工具结果定稿:上游归一化结果时会按名字重解析工具。
          huaanworkOnToolResult: (listener: (exec: { callId?: string }) => void) =>
            (pc as unknown as { on(name: string, callback: (exec: { callId?: string }) => void): () => void })
              .on('tools/result', listener),
          root: ctx.root,
        }
        let unregister = registerCallHostTool(toolCtx, agentsHost.snapshotForRuntime())
        const unregisterPackageTools = registerAgentPackageCreationTools(toolCtx, agentPackageHost)
        // 运行链路工具全局注册;可见性/执行权由子会话的 sessionAgentTools 附件控制。
        const unregisterRuntimeTools = registerAgentPackageRuntimeTools(toolCtx, agentPackageRegistry)
        // 对话创建技能:两个工具全局注册,可见性/执行权同样由会话附件与 policy 门禁控制。
        const unregisterSkillTools = registerSkillCreationTools(toolCtx, skillCreationHost)
        // 结果页工具全局注册;普通父会话经 claimed 附件获得模型面,自动化/包儿童不可见。
        const unregisterResultArtifactTools = registerResultArtifactTools(toolCtx, config.profileDir)
        // 团长派工工具全局注册;只有团队回合经 claimed 附件与租约获得模型面。
        const unregisterExpertTeamDispatch = registerExpertTeamDispatchTool(toolCtx)
        syncHostToolDescription = () => {
          unregister?.()
          unregister = registerCallHostTool(toolCtx, agentsHost.snapshotForRuntime())
        }
        return () => {
          // 先注销团长派工工具:随后的团队取消期间不得再有新的工具调用进入。
          unregisterExpertTeamDispatch()
          syncHostToolDescription = undefined
          // 先注销创建工具再清空门面:卸载后不能再有持有门面的工具在途。
          unregisterSkillTools()
          setSkillCreationHost(undefined)
          unregisterRuntimeTools()
          unregisterResultArtifactTools()
          unregisterPackageTools()
          unregister?.()
          // 插件卸载(应用退出/热替换):先同步启动进程 kill 路径,再取消在途包
          // 回合(释放 activation 并停 runtime),最后等 kill 结算。这里必须
          // **直接调用**收尾并返回 promise——返回工厂函数会被 Cordis 当作
          // disposer 保存而不执行,收尾永远不会跑(最终评审 Critical 回归)。
          // 团队运行先于包运行时取消:成员的 activation/runtime 收尾依赖包宿主
          // 仍在,取消链结束时才释放进程;同时释放本 Host 实例绑定的回合观察器,
          // 防止 pre-claim 或异常退出路径残留全局监听与模块级闭包(设计 §12.1)。
          disposeAllExpertTeamObservers(ctx)
          return ctx.huaanworkExpertTeamRuns
            .cancelAll()
            .finally(() => disposeAgentPackageHostRuntime(agentPackageTurns))
        }
      }, 'huaanwork: host and creation tools registration')
    },
  })
  // 统一网络门禁第二层(llm/stream 前置全局监听;AGENTS.md 不变式 9)。
  installNetworkGate(ctx, routeCtx)
  ctx.effect(() => {
    const disposeRoute = registerHuaanworkRoutes(ctx, routeCtx)
    const disposeKeepAwake = registerKeepAwakeRoute(ctx)
    const disposeUpgrade = ctx.webServer.registerUpgrade({
      path: HUAANWORK_EVENTS_PATH,
      handler: (req, socket, head) =>
        hub.server.handleUpgrade(req, socket, head, (ws) => hub.server.emit('connection', ws, req)),
    })
    return () => {
      disposeRoute()
      disposeKeepAwake()
      disposeUpgrade()
      hub.dispose()
    }
  }, 'huaanwork: routes and events')
}
