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

  /**
   * Cordis 内部结构依赖说明 (评审 D4):
   * 1. 结构依赖: 本处实现依赖 Cordis ReflectService 的实例级 props (cordis-reflect 运行时行为)。
   * 2. 执行时机: 必须在 Context 构建期进行 mixin 拦截，且仅在模块顶层单例执行点调用一次。
   * 3. 验证基线: 当前基于 @deepseek-ai/cordis@4.0.2 验证通过。
   * 4. 破坏表现: 若上游 Cordis 升级破坏 (如 proxy 拦截策略改变、props 结构调整),
   *    在首次向 Context 赋值自定义属性时会触发 Context.set trap 抛错:
   *    `cannot set property "..." without provide`。
   * 5. 排查与修复指引: 若出现此类报错，检查 Cordis 是否修改了 ReflectService 原型结构
   *    或 Context proxy 的 set trap 实现；应同步调整 ReflectProto.mixin 拦截策略或迁移至官方 Context.service 机制。
   */
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
  requestRestart: () => Promise<boolean>,
): RouteContext {
  installContextHolders()

  const workspaceRootRef = { current: config.workspaceRoot }
  const emit = (event: RpcEvent) => hub.broadcast(event)

  try {
    ctx.huaanworkWorkspaceRoot = workspaceRootRef
  } catch (err) {
    throw new Error(
      `[HuaAnWork Host] Failed to assign ctx.huaanworkWorkspaceRoot on Cordis Context. ` +
      `This indicates that the cordis ReflectService prototype monkey-patch failed ` +
      `(verified against @deepseek-ai/cordis@4.0.2). Error: ${err instanceof Error ? err.message : String(err)}. ` +
      `Check dsh-plugin-huaanwork/src/huaanwork-host/holders.ts and cordis reflect proxy set trap.`,
      { cause: err },
    )
  }
  ctx.huaanworkDshHome = config.dshHome
  ctx.huaanworkProfileDir = config.profileDir
  ctx.huaanworkAllowedOnce = new Set<string>()
  ctx.huaanworkApprovals = new Map()
  ctx.huaanworkUnattended = { current: null }
  ctx.huaanworkAttachments = emptyAttachments()
  ctx.huaanworkAgentRequest = { current: null }
  ctx.huaanworkAgentCatalog = { current: { items: [] } }
  ctx.huaanworkEmit = emit

  if (ctx.huaanworkEmit !== emit) {
    throw new Error(
      `[HuaAnWork Host] Context property assignment verification failed: ` +
      `ctx.huaanworkEmit does not match the injected emit function. ` +
      `Cordis Context property isolation or accessors may be misconfigured.`,
    )
  }

  return {
    dshHome: config.dshHome,
    profileDir: config.profileDir,
    workspaceRoot: workspaceRootRef,
    emit,
    logger: (message: string) => {
      ctx.logger?.info?.(message) ?? console.log(message)
    },
    runtimeCtx: ctx as unknown as SessionRuntimeContext,
    requestRestart,
  }
}
