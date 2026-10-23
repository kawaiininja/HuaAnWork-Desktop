import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ConfirmedRestartRuntime } from '../host-runtime-bridge.ts'
import { sweepLegacyChatAutoSessions } from './automation-sweep.ts'
import { createHuaanworkEventHub, HUAANWORK_EVENTS_PATH } from './events.ts'
import { installHuaanworkHolders } from './holders.ts'
import { installNetworkGate } from './net-gate.ts'
import { startAutomationScheduler } from './automation-scheduler.ts'
import { bindAutomationRuntime, type AutomationRuntime } from './automations-host.ts'
import { registerKeepAwakeRoute } from './keep-awake-route.ts'
import { registerHuaanworkRoutes } from './routes.ts'
import { sweepProjectLegacySessionsOncePerProcess } from './session-sweep.ts'
import { restoreEnabledBundledSkills } from './skills-host.ts'
import { createAgentsHost } from './agents-host.ts'
import { setAgentPackageHost, setAgentsDirectory } from './sessions.ts'
import { createAgentPackageHost } from './agent-package/host.ts'
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
    takenSlugs: () => agentsHost.snapshotForRuntime().items.map((item) => item.name),
    registry: agentPackageRegistry,
  })
  setAgentPackageHost(agentPackageHost)
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
          // 插件卸载(应用退出/热替换)时杀掉所有包进程;afterIdle 只管单轮。
          void stopAllAgentPackageProcesses()
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
