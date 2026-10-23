import { Context } from '@deepseek-ai/cordis'
import type { RpcEvent } from '../client-huaanwork/rpc-types.ts'
import type { DesktopPnpm } from '../pnpm.ts'
import { emptyAttachments, type AttachmentMaps } from '../huaanwork-guardrails/agent-attachments.ts'
import type { AgentPackageHost } from './agent-package/host.ts'
import type { AgentPackageSubagentRequest } from './agent-package/types.ts'
import type { HuaanworkEventHub } from './events.ts'
import type { RouteContext } from './routes.ts'
import type { SessionRuntimeContext } from './sessions.ts'

export interface HuaanworkHostConfig {
  dshHome: string
  profileDir: string
  workspaceRoot: string
  checkpointUserDataDir?: string
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
    huaanworkRouteAgent: { current: unknown }
    huaanworkApprovals: Map<string, unknown>
    huaanworkPlanReviews: Map<string, () => boolean>
    huaanworkEmit: (event: RpcEvent) => void
    huaanworkAgentRequest: { current: unknown }
    /** 创建/运行共享的包宿主(apply 里注入);读取方一律经 sessions 的 getter 取同一实例。 */
    huaanworkAgentPackageHost: AgentPackageHost
    /** `@slug` 一次运行的子代理请求(技能插件在 subagents.startActivation 里消费)。 */
    huaanworkAgentPackageRequest: { current: AgentPackageSubagentRequest | null }
    /**
     * 智能体包回合当前绑定的子会话 id。policy 用它标记 `mcp__*` 调用来自包运行链路:
     * 子会话没有审批界面,自己挂载的 MCP 工具不能被 ask 自动拒绝。
     */
    huaanworkPackageChildSessions: Set<string>
    huaanworkCheckpointUserDataDir: string
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
  'huaanworkRouteAgent',
  'huaanworkApprovals',
  'huaanworkPlanReviews',
  'huaanworkEmit',
  'huaanworkAgentRequest',
  'huaanworkAgentPackageHost',
  'huaanworkAgentPackageRequest',
  'huaanworkPackageChildSessions',
  'huaanworkCheckpointUserDataDir',
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
  ctx.huaanworkCheckpointUserDataDir = config.checkpointUserDataDir ?? ''
  process.env.HUAANWORK_PROFILE_DIR = config.profileDir
  ctx.huaanworkAllowedOnce = new Set<string>()
  ctx.huaanworkApprovals = new Map()
  ctx.huaanworkPlanReviews = new Map()
  ctx.huaanworkUnattended = { current: null }
  ctx.huaanworkAttachments = emptyAttachments()
  ctx.huaanworkAgentRequest = { current: null }
  ctx.huaanworkAgentPackageRequest = { current: null }
  ctx.huaanworkPackageChildSessions = new Set<string>()
  ctx.huaanworkAgentCatalog = { current: { items: [] } }
  ctx.huaanworkRouteAgent = { current: null }
  ctx.huaanworkEmit = emit

  if (ctx.huaanworkEmit !== emit) {
    throw new Error(
      `[HuaAnWork Host] Context property assignment verification failed: ` +
      `ctx.huaanworkEmit does not match the injected emit function. ` +
      `Cordis Context property isolation or accessors may be misconfigured.`,
    )
  }

  const desktopPnpm = lookupDesktopPnpm(ctx)
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
    ...(desktopPnpm ? { desktopPnpm } : {}),
  }
}

function lookupDesktopPnpm(ctx: Context): Pick<DesktopPnpm, 'runPlugin'> | undefined {
  try {
    const service = ctx.get('desktopPnpm') as Pick<DesktopPnpm, 'runPlugin'> | undefined
    if (service && typeof service.runPlugin === 'function') return service
  } catch {
    // desktop-pnpm 尚未挂上时保持缺席;写路径请求期再查 runtimeCtx,仍没有则 503。
  }
  return undefined
}
