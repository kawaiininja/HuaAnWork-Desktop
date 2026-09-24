import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ConfirmedRestartRuntime } from '../host-runtime-bridge.ts'
import { createHuaanworkEventHub, HUAANWORK_EVENTS_PATH } from './events.ts'
import { installHuaanworkHolders } from './holders.ts'
import { installNetworkGate } from './net-gate.ts'
import { startAutomationScheduler } from './automation-scheduler.ts'
import { bindAutomationRuntime, type AutomationRuntime } from './automations-host.ts'
import { registerKeepAwakeRoute } from './keep-awake-route.ts'
import { registerHuaanworkRoutes } from './routes.ts'
import { restoreEnabledBundledSkills } from './skills-host.ts'
import { createAgentsHost } from './agents-host.ts'
import { setAgentsDirectory } from './sessions.ts'
import { readHuaanworkSettingsSync } from './settings.ts'
import { clearPendingWorkspaceRoot } from './workspace-state.ts'

export const name = 'huaanwork-host'
export const inject = ['webServer', 'agents', 'subagents', 'desktopRuntime']

export interface HuaanworkHostConfig {
  dshHome: string
  profileDir: string
  workspaceRoot: string
  /** profile 行 / profile-boot 桩可关调度器。测试缝是 HUAANWORK_AUTOMATION_TICK_MS,不是这个开关。 */
  automationScheduler?: {
    disabled?: boolean
  }
}

export const Config: z<HuaanworkHostConfig> = z.object({
  dshHome: z.string(),
  profileDir: z.string(),
  workspaceRoot: z.string(),
  automationScheduler: z.object({
    disabled: z.boolean().default(false),
  }).default({ disabled: false }),
})

export function apply(ctx: Context, config: HuaanworkHostConfig) {
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
      throw new Error('huaanwork-host: desktopRuntime 缺少 requestConfirmedRestart()(工作区切换需要原生确认回传能力;请使用 ElectronDesktopRuntime)')
    }
    return runtime.requestConfirmedRestart()
  })
  // 执行体与 collector 接线。调度 tick 走同一 enqueueAutomation,不直接调 executeRun。
  const runtime = ctx as unknown as AutomationRuntime
  bindAutomationRuntime(runtime, routeCtx)
  // ticker 不是 TCP/UDP listener,不进 post-boot listener 门禁。
  // effect 在 compose 之后首次执行,与 gates 的 listener 基线窗口错开。
  ctx.effect(() => {
    return startAutomationScheduler(runtime, routeCtx, {
      disabled: config.automationScheduler?.disabled === true,
    })
  }, 'huaanwork: automation scheduler')
  // 智能体目录真实接线(Task 10):fetch 公用机目录 + 本地 endpoints,存储根 = profileDir;
  // 目录快照同步进 huaanworkAgentCatalog holder(agent-invoke 的 @agent 分发消费)。
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
    },
  })
  setAgentsDirectory(agentsHost)
  ctx.huaanworkAgentCatalog.current = agentsHost.snapshotForRuntime()
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
