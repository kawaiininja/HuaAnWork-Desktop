import { Context } from '@deepseek-ai/cordis'
import type { RpcEvent } from '../client-huaanwork/rpc-types.ts'
import type { DesktopPnpm } from '../pnpm.ts'
import { emptyAttachments, type AttachmentMaps } from '../huaanwork-guardrails/agent-attachments.ts'
import type { UnattendedScope } from '../huaanwork-guardrails/policy.ts'
import type { AgentPackageHost } from './agent-package/host.ts'
import type { AgentCatalogClient } from './agent-package/catalog-client.ts'
import type { AgentCatalogSecurity } from './agent-package/catalog-security.ts'
import type { AgentPackageSubagentRequest, AgentPackageTeamRequests } from './agent-package/types.ts'
import type { HuaanworkEventHub } from './events.ts'
import type { ExpertTeamRunRegistry } from './expert-team/runs.ts'
import type { ExpertTeamCoordinator } from './expert-team/coordinator.ts'
import type { ExpertTeamStore } from './expert-team/types.ts'
import type { RouteContext } from './routes.ts'
import type { SessionRuntimeContext } from './sessions.ts'
import type { SubagentRunRegistry } from './subagent-runs.ts'
import { createSystemSkillLeaseStore, type SystemSkillLeaseStore } from './system-skill-leases.ts'
import { createTurnAnchorStore, type TurnAnchorStore } from './turn-anchors.ts'
import type { TurnScheduler } from './turn-scheduler.ts'

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
    /**
     * 按会话保存的无人值守范围（`runAgentTurn` 写入本次运行的会话，运行结束删除）。
     * 读取方一律只查本次执行所属会话，不再有进程级单槽。
     */
    huaanworkUnattended: Map<string, UnattendedScope>
    huaanworkAttachments: AttachmentMaps
    huaanworkAgentCatalog: { current: { items: unknown[] } }
    huaanworkApprovals: Map<string, unknown>
    huaanworkPlanReviews: Map<string, () => boolean>
    huaanworkEmit: (event: RpcEvent) => void
    huaanworkAgentRequest: { current: unknown }
    /** 创建/运行共享的包宿主(apply 里注入);读取方一律经 sessions 的 getter 取同一实例。 */
    huaanworkAgentPackageHost: AgentPackageHost
    /** `@slug` 一次运行的子代理请求(技能插件在 subagents.startActivation 里消费)。 */
    huaanworkAgentPackageRequest: { current: AgentPackageSubagentRequest | null }
    /**
     * 团队成员请求表(`reservedChildId → 请求`)。团队并行成员不能共享单槽：
     * `skills.ts` 的 activation 包装按预留子会话 id 精确消费，未命中才回落单槽。
     */
    huaanworkAgentPackageTeamRequests: AgentPackageTeamRequests
    /**
     * 智能体包回合当前绑定的子会话 id。policy 用它标记 `mcp__*` 调用来自包运行链路:
     * 子会话没有审批界面,自己挂载的 MCP 工具不能被 ask 自动拒绝。
     */
    huaanworkPackageChildSessions: Set<string>
    /** 包回合血缘允许表：会话 id → 本回合 allow 数组引用（孙代收窄继承用，C2）。 */
    huaanworkPackageChildAllow: Map<string, readonly string[]>
    huaanworkCheckpointUserDataDir: string
    /** 签名广场 HTTP 客户端(发布/安装共用同一绑定);index 启动时注入。 */
    huaanworkAgentCatalogClient: AgentCatalogClient
    /**
     * 运行前安全面(Task 10):keyring、撤销缓存、运行前复验与回合停止。
     * index 在 host 之前创建并注入;holder 只读,不参与构造。
     */
    huaanworkAgentCatalogSecurity: AgentCatalogSecurity
    /** 子代理 run 权威状态机(设计 §5.2);index 在 holders 安装后创建并注入。 */
    huaanworkSubagentRuns: SubagentRunRegistry
    /** 按 profile 隔离的专家团定义存储(设计 §8.5);index 启动时创建一次。 */
    huaanworkExpertTeamStore: ExpertTeamStore
    /** 专家团运行权威状态机(设计 §8.3);index 启动时创建一次,运行期只 mutate。 */
    huaanworkExpertTeamRuns: ExpertTeamRunRegistry
    /**
     * 专家团运行协调器(设计 §10.2 / §12.1);index 顶层 apply 创建一次并挂上:
     * 工具、claim 附件判定与后续 turn/end 结算读到的都是同一实例。
     */
    huaanworkExpertTeamCoordinator: ExpertTeamCoordinator
    /** 会话 → 模型条目 id 的绑定表(Task 6);模型适配器与网络门禁共读同一实例。 */
    huaanworkSessionModels: Map<string, string>
    /** 会话 → 可写根(Task 6);沙箱、工具执行与排队出队共用同一实例。 */
    huaanworkSessionRoots: Map<string, string>
    /**
     * 会话 → 本会话的显式工具白名单(知识库整理槽等按会话收窄的会话使用)。
     *
     * 只收窄工具可见性与可执行性,不是存活性信号:无条目即"不按会话收窄",既有
     * 会话行为不变。消费方有且仅有两处——`present-as.ts` 收窄模型面可见集、
     * `policy.ts` 在 `tools/pre-execute` / `tools.guard` 各自再判一次;两面互相
     * 独立 fail closed,任何一面被跳过都不会放行名单外的工具。
     */
    huaanworkSessionToolAllow: Map<string, readonly string[]>
    /** 唯一回合调度器(Task 6);用户发送与自动化准入共用。 */
    huaanworkTurnScheduler: TurnScheduler
    /** 会话 → 当前回合锚点(设计「回合归属」);pre-step 钩子与后续进度投影共读同一实例。 */
    huaanworkTurnAnchors: TurnAnchorStore
    /**
     * 系统技能回合租约(`explore` / `test-fix` 在回合内把 `subagent` 挂进会话附件)。
     * 实例随宿主生命周期;guardrails 侧与 sessions/bridge 读同一引用。
     */
    huaanworkSystemSkillLeases: SystemSkillLeaseStore
    /** 租约失效清理的延迟注册入口;guardrails 注入,holders 创建 store 后调用。 */
    huaanworkRegisterSystemSkillLeaseInvalidation?: () => void
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
  'huaanworkPlanReviews',
  'huaanworkEmit',
  'huaanworkAgentRequest',
  'huaanworkAgentPackageHost',
  'huaanworkAgentPackageRequest',
  'huaanworkAgentPackageTeamRequests',
  'huaanworkPackageChildSessions',
  'huaanworkPackageChildAllow',
  'huaanworkCheckpointUserDataDir',
  'huaanworkAgentCatalogClient',
  'huaanworkAgentCatalogSecurity',
  'huaanworkSubagentRuns',
  'huaanworkExpertTeamStore',
  'huaanworkExpertTeamRuns',
  'huaanworkExpertTeamCoordinator',
  'huaanworkSessionModels',
  'huaanworkSessionRoots',
  'huaanworkSessionToolAllow',
  'huaanworkTurnScheduler',
  'huaanworkTurnAnchors',
  'huaanworkSystemSkillLeases',
  'huaanworkRegisterSystemSkillLeaseInvalidation',
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
  ctx.huaanworkUnattended = new Map()
  ctx.huaanworkAttachments = emptyAttachments()
  ctx.huaanworkAgentRequest = { current: null }
  ctx.huaanworkAgentPackageRequest = { current: null }
  ctx.huaanworkAgentPackageTeamRequests = new Map<string, AgentPackageSubagentRequest>()
  ctx.huaanworkPackageChildSessions = new Set<string>()
  ctx.huaanworkPackageChildAllow = new Map<string, readonly string[]>()
  ctx.huaanworkSessionToolAllow = new Map<string, readonly string[]>()
  ctx.huaanworkAgentCatalog = { current: { items: [] } }
  ctx.huaanworkEmit = emit
  ctx.huaanworkTurnAnchors = createTurnAnchorStore()
  // 系统技能租约在其余 holder 之后创建:store 捕获同一批容器(无人值守/附件/血缘/锚点)。
  ctx.huaanworkSystemSkillLeases = createSystemSkillLeaseStore(ctx)
  // guardrails 的失效清理在此刻注册,避免 skills apply 先于 store 创建时漏挂 onInvalidate。
  ctx.huaanworkRegisterSystemSkillLeaseInvalidation?.()

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
