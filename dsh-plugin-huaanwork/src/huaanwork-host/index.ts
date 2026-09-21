import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createHuaanworkEventHub, HUAANWORK_EVENTS_PATH } from './events.ts'
import { installHuaanworkHolders } from './holders.ts'
import { installNetworkGate } from './net-gate.ts'
import { registerHuaanworkRoutes } from './routes.ts'
import { clearPendingWorkspaceRoot } from './workspace-state.ts'

export const name = 'huaanwork-host'
export const inject = ['webServer', 'agents', 'subagents', 'desktopRuntime']

export interface HuaanworkHostConfig {
  dshHome: string
  profileDir: string
  workspaceRoot: string
}

export const Config: z<HuaanworkHostConfig> = z.object({
  dshHome: z.string(),
  profileDir: z.string(),
  workspaceRoot: z.string(),
})

export function apply(ctx: Context, config: HuaanworkHostConfig) {
  // generation 重启防循环:组合期已消费 pendingRoot,首个 effect 立即清除——
  // 此后 boot 失败时,下次组合回中立根,恢复窗口可达(spec §9)。
  ctx.effect(() => {
    clearPendingWorkspaceRoot(config.profileDir)
    return () => {}
  }, 'huaanwork: clear pending workspace root')
  const hub = createHuaanworkEventHub()
  const routeCtx = installHuaanworkHolders(ctx, config, hub, () => ctx.desktopRuntime.requestRestart())
  // 统一网络门禁第二层(llm/stream 前置全局监听;AGENTS.md 不变式 9)。
  installNetworkGate(ctx, routeCtx)
  ctx.effect(() => {
    const disposeRoute = registerHuaanworkRoutes(ctx, routeCtx)
    const disposeUpgrade = ctx.webServer.registerUpgrade({
      path: HUAANWORK_EVENTS_PATH,
      handler: (req, socket, head) =>
        hub.server.handleUpgrade(req, socket, head, (ws) => hub.server.emit('connection', ws, req)),
    })
    return () => {
      disposeRoute()
      disposeUpgrade()
      hub.dispose()
    }
  }, 'huaanwork: routes and events')
}
