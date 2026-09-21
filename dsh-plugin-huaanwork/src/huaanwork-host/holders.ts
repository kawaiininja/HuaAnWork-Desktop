import { Context } from '@deepseek-ai/cordis'
import type { RpcEvent } from '../client-huaanwork/rpc-types.ts'
import { emptyAttachments, type AttachmentMaps } from '../huaanwork-guardrails/agent-attachments.ts'
import type { HuaanworkEventHub } from './events.ts'
import type { RouteContext } from './routes.ts'
import type { SessionRuntimeContext } from './sessions.ts'

export interface HuaanworkHostConfig {
  dshHome: string
  profileDir: string
  workspaceRoot: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    huaanworkWorkspaceRoot: { current: string }
    huaanworkAllowedOnce: Set<string>
    huaanworkDshHome: string
    huaanworkProfileDir: string
    huaanworkUnattended: { current: unknown }
    huaanworkAttachments: AttachmentMaps
    huaanworkAgentCatalog: { current: { items: unknown[] } }
    huaanworkApprovals: Map<string, unknown>
    huaanworkEmit: (event: RpcEvent) => void
    huaanworkAgentRequest: { current: unknown }
  }
}

export const HUAANWORK_CONTEXT_PROPS = [
  'huaanworkWorkspaceRoot',
  'huaanworkAllowedOnce',
  'huaanworkDshHome',
  'huaanworkProfileDir',
  'huaanworkUnattended',
  'huaanworkAttachments',
  'huaanworkAgentCatalog',
  'huaanworkApprovals',
  'huaanworkEmit',
  'huaanworkAgentRequest',
] as const

let installed = false

export function installContextHolders(): void {
  if (installed) return
  installed = true

  const dummy = new Context()
  const ReflectProto = Object.getPrototypeOf(dummy.reflect)
  const originalMixin = ReflectProto.mixin

  ReflectProto.mixin = function (source: any, mixins: any) {
    for (const prop of HUAANWORK_CONTEXT_PROPS) {
      if (!this.props[prop]) {
        const privateKey = `_${prop}`
        this.props[prop] = {
          type: 'accessor',
          get() {
            return (this as any).root[privateKey]
          },
          set(value: any) {
            ;(this as any).root[privateKey] = value
            return true
          },
        }
      }
    }
    return originalMixin.call(this, source, mixins)
  }
}

installContextHolders()

export function installHuaanworkHolders(
  ctx: Context,
  config: HuaanworkHostConfig,
  hub: HuaanworkEventHub,
): RouteContext {
  installContextHolders()

  const workspaceRootRef = { current: config.workspaceRoot }
  const emit = (event: RpcEvent) => hub.broadcast(event)

  ctx.huaanworkWorkspaceRoot = workspaceRootRef
  ctx.huaanworkDshHome = config.dshHome
  ctx.huaanworkProfileDir = config.profileDir
  ctx.huaanworkAllowedOnce = new Set<string>()
  ctx.huaanworkApprovals = new Map()
  ctx.huaanworkUnattended = { current: null }
  ctx.huaanworkAttachments = emptyAttachments()
  ctx.huaanworkAgentRequest = { current: null }
  ctx.huaanworkAgentCatalog = { current: { items: [] } }
  ctx.huaanworkEmit = emit

  return {
    dshHome: config.dshHome,
    profileDir: config.profileDir,
    workspaceRoot: workspaceRootRef,
    emit,
    logger: (message: string) => {
      ctx.logger?.info?.(message) ?? console.log(message)
    },
    runtimeCtx: ctx as unknown as SessionRuntimeContext,
  }
}
