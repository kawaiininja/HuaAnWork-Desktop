import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createHuaanworkEventHub, HUAANWORK_EVENTS_PATH } from './events.ts'
import { installHuaanworkHolders } from './holders.ts'
import { registerHuaanworkRoutes } from './routes.ts'

export const name = 'huaanwork-host'
export const inject = ['webServer']

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
  const hub = createHuaanworkEventHub()
  const routeCtx = installHuaanworkHolders(ctx, config, hub)
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
