import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ConfirmedRestartRuntime } from '../host-runtime-bridge.ts'
import { sweepLegacyChatAutoSessions } from './automation-sweep.ts'
import { createHuaanworkEventHub, HUAANWORK_EVENTS_PATH } from './events.ts'
import { installHuaanworkHolders } from './holders.ts'
import { createSubagentRunRegistry } from './subagent-runs.ts'
import { installNetworkGate } from './net-gate.ts'
import { startAutomationScheduler } from './automation-scheduler.ts'
import { bindAutomationRuntime, type AutomationRuntime } from './automations-host.ts'
import { registerKeepAwakeRoute } from './keep-awake-route.ts'
import { registerHuaanworkRoutes } from './routes.ts'
import { sweepProjectLegacySessionsOncePerProcess } from './session-sweep.ts'
import { restoreEnabledBundledSkills } from './skills-host.ts'
import { createAgentsHost } from './agents-host.ts'
import { setAgentPackageActiveTurns, setAgentPackageHost, setAgentsDirectory } from './sessions.ts'
import { createAgentCatalogSecurity } from './agent-package/catalog-security.ts'
import { recoverCatalogPackageInstalls } from './agent-package/catalog-install.ts'
import {
  createAgentPackageActiveTurnRegistry,
  createAgentPackageHost,
  type AgentPackageActiveTurnRegistry,
} from './agent-package/host.ts'
import { createAgentPackageLifecycleLock } from './agent-package/lifecycle.ts'
import {
  configureAgentCatalog,
  readCachedCatalogPackageSlugs,
  refreshCatalogPackageCache,
} from './agent-package/catalog-client.ts'
import { createAgentPackageRuntimeRegistry, stopAllAgentPackageProcesses } from './agent-package/runtime.ts'
import { readHuaanworkSettingsSync } from './settings.ts'
import { listProjects, listTasks, runsDir } from './stores.ts'
import { clearPendingWorkspaceRoot, neutralWorkspaceRoot } from './workspace-state.ts'
import { registerCallHostTool } from '../huaanwork-guardrails/agent-tool.ts'
import {
  registerAgentPackageCreationTools,
  registerAgentPackageRuntimeTools,
} from '../huaanwork-guardrails/agent-package-tools.ts'

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
  // 子代理 run 权威状态机(设计 §5.2):holders 安装后创建一次,经 ctx 注入;
  // 事件与路由共用同一个 hub.broadcast(routeCtx.emit)。
  const subagentRuns = createSubagentRunRegistry({ emit: routeCtx.emit })
  ctx.huaanworkSubagentRuns = subagentRuns
  // 执行体与 collector 接线。调度 tick 走同一 enqueueAutomation,不直接调 executeRun。
  const runtime = ctx as unknown as AutomationRuntime
  bindAutomationRuntime(runtime, routeCtx)
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
    const sweptProjectLegacy = await sweepProjectLegacySessionsOncePerProcess(
      join(config.dshHome, 'sessions'),
      registeredProjectRoots,
      referencedSessionIds,
      [neutralWorkspaceRoot(config.profileDir)],
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
        const toolCtx = {
          tools: (pc as unknown as { tools?: unknown }).tools,
          huaanworkAgentCatalog: ctx.huaanworkAgentCatalog,
          huaanworkProfileDir: config.profileDir,
          // 创建工具发事件、读附件与按会话刷新 restrict 所需的 holder 桥接。
          huaanworkEmit: ctx.huaanworkEmit,
          huaanworkAgentPackageHost: agentPackageHost,
          huaanworkAttachments: ctx.huaanworkAttachments,
          huaanworkRouteAgent: ctx.huaanworkRouteAgent,
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
        syncHostToolDescription = () => {
          unregister?.()
          unregister = registerCallHostTool(toolCtx, agentsHost.snapshotForRuntime())
        }
        return () => {
          syncHostToolDescription = undefined
          unregisterRuntimeTools()
          unregisterPackageTools()
          unregister?.()
          // 插件卸载(应用退出/热替换):先同步启动进程 kill 路径,再取消在途包
          // 回合(释放 activation 并停 runtime),最后等 kill 结算。这里必须
          // **直接调用**收尾并返回 promise——返回工厂函数会被 Cordis 当作
          // disposer 保存而不执行,收尾永远不会跑(最终评审 Critical 回归)。
          return disposeAgentPackageHostRuntime(agentPackageTurns)
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
  // D2 修复:boot/generation 重启后按 skill-toggles.json 恢复已启用 bundled skills
  // 的运行时注册(legacy host.ts:411-421 同构)。内联插件等 skills 服务就绪后激活,
  // 不把 'skills' 加进本插件 inject——避免隔离挂载 huaanwork-host 的环境被依赖楔死。
  ctx.plugin({
    inject: ['skills'],
    apply: (pc: Context) => {
      restoreEnabledBundledSkills(config.profileDir, pc)
    },
  })
}
