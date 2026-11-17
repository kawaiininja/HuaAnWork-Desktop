import type { GoalPhase } from "../client-huaanwork/logic/goalRound.ts"
import { attachAgentTools, detachAgentTools, type AttachmentMaps } from "../huaanwork-guardrails/agent-attachments.ts"
import { refreshAgentRestrict } from "../huaanwork-guardrails/present-as.ts"
import { parentSessionOf } from "./child-sessions.ts"

/**
 * 系统技能回合租约(设计「subagent 默认隐藏」)。
 *
 * `explore` / `test-fix` 是唯一允许模型在普通父会话里看到 `subagent` 的入口:
 * 租约在回合内把 `subagent` 挂进会话附件表(present-as 的 `ALLOWED_TOOLS ∪ 附件`),
 * 并在回合结束、中断、异常、会话销毁时**无条件**解挂。租约实例由 holders 注入
 * `ctx.huaanworkSystemSkillLeases`,随宿主生命周期;所有状态都在实例内,没有模块级单槽。
 */
export type SystemSkillKind = "explore" | "test-fix"

/** 一条会话租约。`goalPhase` 只是从 `activeGoalSessions` 派生的快照。 */
type SystemSkillLease = { kind: SystemSkillKind; goalPhase?: GoalPhase }

/** 租约判定与挂载需要的最小上下文面(holders 注入的同一批容器)。 */
export type SystemSkillLeaseContext = {
  /** 无人值守自动化会话表(policy 的 UnattendedHolder);条目在场即本次运行。 */
  huaanworkUnattended?: { has(sessionId: string): boolean }
  /** 会话工具附件表;`subagent` 经此挂载。 */
  huaanworkAttachments?: AttachmentMaps
  /** 包回合血缘允许表:有条目的儿童是受管儿童。 */
  huaanworkPackageChildAllow?: Map<string, readonly string[]>
  /** 共享回合锚点;模型 `skill` 入口只在本回合有锚点时取租约。 */
  huaanworkTurnAnchors?: { current(sessionId: string): unknown }
}

/** 租约存储的公开面;`skills.ts` 通过 `onInvalidate` 同步清理待派发热缓存。 */
export type SystemSkillLeaseStore = {
  /**
   * 模型 `skill` 工具入口:无人值守、受管儿童、缺附件表或本回合无锚点时一律 false。
   */
  acquire(sessionId: string, kind: SystemSkillKind): boolean
  /**
   * 显式 `/explore`、`/test-fix` 入口:在 `agent.followup` 之前挂载,不要求锚点
   * (上游 systemPrompt.assemble() 在 pre-step 建锚点前采集工具列表)。
   */
  acquireExplicit(sessionId: string, kind: SystemSkillKind): boolean
  /** 幂等解挂;即使租约缺席也通知失效回调,确保不残留 pendingByAgent/槽位。 */
  release(sessionId: string, options?: { clearGoal?: boolean }): void
  kindOf(sessionId: string): SystemSkillKind | undefined
  /** goal/change 相位:active 记入独立集合,其余相位(含 clear)释放并清标记。 */
  noteGoalPhase(sessionId: string, phase: GoalPhase | undefined): void
  /** 正常完成轮次的轮间 idle:只有 active goal 保留租约。 */
  releaseOnIdle(sessionId: string): void
  onInvalidate(listener: (sessionId: string) => void): () => void
}

/** 读取租约的宿主面(store 捕获创建时的上下文,调用方只需持有同一实例)。 */
export type SystemSkillLeaseHost = { huaanworkSystemSkillLeases?: SystemSkillLeaseStore }

/**
 * 无包血缘条目的受管儿童(`parentSessionOf` 有父会话但血缘表没有条目)。
 *
 * legacy 儿童与 system-skill 派生的儿童一律落在这一类,都不能获取系统技能租约;
 * 受管儿童(包基因带 allow 条目)不受此限。命名固定为 `isUnmanagedChildSession`
 * (不叫 `isLegacyChild`),守卫语义见 `guardSystemSkillEligible`。
 */
export function isUnmanagedChildSession(
  ctx: { huaanworkPackageChildAllow?: Map<string, readonly string[]> },
  sessionId: string,
): boolean {
  return parentSessionOf(sessionId) !== undefined && ctx.huaanworkPackageChildAllow?.has(sessionId) !== true
}

export function createSystemSkillLeaseStore(ctx: SystemSkillLeaseContext): SystemSkillLeaseStore {
  const leases = new Map<string, SystemSkillLease>()
  /**
   * 独立于 leases 记录当前处于 `goal.phase === 'active'` 的会话,避免「goal 先激活、
   * 后续轮次才取技能租约」时 commitLease 丢失 active 状态并在正常轮间 idle 提前解挂。
   */
  const activeGoalSessions = new Set<string>()
  const invalidateListeners = new Set<(sessionId: string) => void>()

  const notifyInvalidate = (sessionId: string): void => {
    // 快照后再通知:监听器内部增删订阅不影响本轮回调。
    for (const listener of [...invalidateListeners]) listener(sessionId)
  }

  const guardSystemSkillEligible = (sessionId: string): boolean => {
    // 守卫内「无人值守 → 受管儿童 → 附件/锚点」的早退顺序是**正确守卫**:
    // 受管儿童命中第二跳是有意覆盖(legacy 与 system-skill 派生儿童一律不得取租约),
    // 不是顺序缺陷,禁止改成排除 system-skill 儿童。
    if (ctx.huaanworkUnattended?.has(sessionId) === true) return false
    if (isUnmanagedChildSession(ctx, sessionId)) return false
    if (ctx.huaanworkAttachments === undefined) return false
    return true
  }

  const commitLease = (sessionId: string, kind: SystemSkillKind): boolean => {
    const existing = leases.get(sessionId)
    const goalActive = activeGoalSessions.has(sessionId) || existing?.goalPhase === "active"
    // 遵循 exactOptionalPropertyTypes: true,不向可选属性写入 explicit undefined。
    leases.set(sessionId, { kind, ...(goalActive ? { goalPhase: "active" as const } : {}) })
    attachAgentTools(ctx.huaanworkAttachments!, sessionId, ["subagent"])
    refreshAgentRestrict(ctx as never, sessionId)
    return true
  }

  const release = (sessionId: string, options?: { clearGoal?: boolean }): void => {
    if (options?.clearGoal === true) activeGoalSessions.delete(sessionId)
    // 即使 leases 缺席(如先前 acquire 返回 false / 从未挂载)仍通知失效回调并幂等
    // 卸除附件,确保不残留 pendingByAgent 与派发槽位。
    notifyInvalidate(sessionId)
    if (leases.delete(sessionId)) {
      if (ctx.huaanworkAttachments !== undefined) {
        detachAgentTools(ctx.huaanworkAttachments, sessionId, ["subagent"])
      }
      refreshAgentRestrict(ctx as never, sessionId)
    }
  }

  return {
    acquire(sessionId, kind) {
      if (!guardSystemSkillEligible(sessionId)) return false
      if (ctx.huaanworkTurnAnchors?.current(sessionId) === undefined) return false
      return commitLease(sessionId, kind)
    },

    acquireExplicit(sessionId, kind) {
      if (!guardSystemSkillEligible(sessionId)) return false
      // QR-I2:显式入口写入新租约前先失效旧缓存,同步清掉同一父 agent 上残留的
      // 旧 pendingByAgent 与残留槽(不依赖跨监听次序)。
      notifyInvalidate(sessionId)
      return commitLease(sessionId, kind)
    },

    release,

    kindOf(sessionId) {
      return leases.get(sessionId)?.kind
    },

    noteGoalPhase(sessionId, phase) {
      if (phase === "active") {
        activeGoalSessions.add(sessionId)
        const existing = leases.get(sessionId)
        if (existing !== undefined) leases.set(sessionId, { ...existing, goalPhase: "active" })
        return
      }
      // clear / paused / blocked / complete:释放并清 active 标记(已 disarm 的 goal
      // 绝不泄漏到下一回合)。
      release(sessionId, { clearGoal: true })
    },

    releaseOnIdle(sessionId) {
      if (activeGoalSessions.has(sessionId) || leases.get(sessionId)?.goalPhase === "active") return
      release(sessionId)
    },

    onInvalidate(listener) {
      invalidateListeners.add(listener)
      return () => {
        invalidateListeners.delete(listener)
      }
    },
  }
}

/** 模型 `skill` 工具入口的租约获取;宿主未注入 store 时 false(fail closed)。 */
export function acquireSystemSkillLease(
  host: SystemSkillLeaseHost,
  sessionId: string,
  kind: SystemSkillKind,
): boolean {
  return host.huaanworkSystemSkillLeases?.acquire(sessionId, kind) ?? false
}

/** 显式 `/explore`、`/test-fix` 入口的租约获取(不要求回合锚点)。 */
export function acquireExplicitSystemSkillLease(
  host: SystemSkillLeaseHost,
  sessionId: string,
  kind: SystemSkillKind,
): boolean {
  return host.huaanworkSystemSkillLeases?.acquireExplicit(sessionId, kind) ?? false
}

export function releaseSystemSkillLease(
  host: SystemSkillLeaseHost,
  sessionId: string,
  options?: { clearGoal?: boolean },
): void {
  host.huaanworkSystemSkillLeases?.release(sessionId, options)
}

export function systemSkillLeaseKindOf(
  host: SystemSkillLeaseHost,
  sessionId: string,
): SystemSkillKind | undefined {
  return host.huaanworkSystemSkillLeases?.kindOf(sessionId)
}

export function noteSystemSkillGoalPhase(
  host: SystemSkillLeaseHost,
  sessionId: string,
  phase: GoalPhase | undefined,
): void {
  host.huaanworkSystemSkillLeases?.noteGoalPhase(sessionId, phase)
}

export function releaseSystemSkillLeaseOnIdle(host: SystemSkillLeaseHost, sessionId: string): void {
  host.huaanworkSystemSkillLeases?.releaseOnIdle(sessionId)
}
