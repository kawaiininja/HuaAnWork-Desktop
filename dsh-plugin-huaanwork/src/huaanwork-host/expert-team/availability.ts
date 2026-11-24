import type { ExpertTeam } from '../../client-huaanwork/rpc-types.ts'
import type { AgentPackageDetail, AgentPackageListItem } from '../agent-package/types.ts'
import type { ExpertTeamRecord } from './types.ts'
import { validateExpertTeam } from './types.ts'

/**
 * 专家团定义的实时可用性计算（设计 §7.2 / §8.5 / §9.2）。
 *
 * 输入只有定义记录与 `AgentPackageHost.listWithLegacy().packages`
 * （`AgentPackageListItem[]`）。这里是 R3 的唯一执行点：企业目录 legacy 智能体
 * （`catalogAgents` / `AgentListItem[]`）与工具条目一律不进入成员匹配，同名也
 * 不会被当成健康包。可调用状态不落盘，由本函数每次从定义与包实时状态推导。
 */

/** 成员包的原生能力摘要；来自包详情，不改变成员的工具/沙箱边界。 */
export type ExpertTeamMemberCapabilities = {
  tools: 'none' | 'http' | 'mcp' | 'both'
  skillScripts: string[]
}

/**
 * 一个团队定义的可用性投影。
 *
 * `kind` 与设计 §7.2 的四种状态一一对应：`invocable`（可调用）、`disabled`
 * （已停用）、`incomplete`（配置不完整/损坏定义）与 `member-invalid`（成员失效）。
 * `reasons` 只放稳定错误码，供 UI 映射文案；`members` 按定义顺序逐个给出成员
 * 状态，失效成员带稳定 `reason`，健康成员在包详情可用时附 `capabilities`。
 */
export type ExpertTeamAvailability = {
  kind: 'invocable' | 'disabled' | 'incomplete' | 'member-invalid'
  invocable: boolean
  reasons: string[]
  members: Array<{
    memberId: string
    displayName: string
    version?: string
    capabilities?: ExpertTeamMemberCapabilities
    reason?: string
  }>
}

/** 包详情读取器；路由传 `host.detail.bind(host)`，测试可省略。 */
export type ExpertTeamPackageDetailLookup = (slug: string) => AgentPackageDetail | undefined

/**
 * 成员包不可用的稳定原因；健康返回 `undefined`。
 *
 * 顺序固定为撤销 → 损坏 → 停用：撤销是安全优先的终态，损坏包不可运行，
 * 只有两项都缺席时才按停用归因。`enabled !== true` 覆盖未来新增的非布尔值。
 */
export function expertTeamMemberUnavailableReason(pkg: AgentPackageListItem): string | undefined {
  if (pkg.revoked !== undefined) return 'expert-team-member-revoked'
  if (pkg.broken !== undefined) return 'expert-team-member-broken'
  if (pkg.enabled !== true) return 'expert-team-member-disabled'
  return undefined
}

/** 包详情的原生能力摘要；`skill` 缺席等价于没有随包脚本。 */
export function expertTeamMemberCapabilities(detail: AgentPackageDetail): ExpertTeamMemberCapabilities {
  return { tools: detail.tools, skillScripts: detail.skill?.scripts ?? [] }
}

function availability(kind: ExpertTeamAvailability['kind'], reasons: string[]): ExpertTeamAvailability {
  return {
    kind,
    invocable: kind === 'invocable',
    reasons,
    members: [],
  }
}

function resolveMember(
  member: ExpertTeam['members'][number],
  packages: readonly AgentPackageListItem[],
  detailOf: ExpertTeamPackageDetailLookup | undefined,
): ExpertTeamAvailability['members'][number] {
  // 只按包自己的来源联合精确匹配：不允许按 slug 跨来源回退。
  const pkg = packages.find(
    (candidate) => candidate.source === member.agentRef.source && candidate.slug === member.agentRef.slug,
  )
  if (pkg === undefined) {
    return {
      memberId: member.memberId,
      displayName: member.agentRef.slug,
      reason: 'expert-team-member-missing',
    }
  }
  const reason = expertTeamMemberUnavailableReason(pkg)
  if (reason !== undefined) {
    return {
      memberId: member.memberId,
      displayName: pkg.displayName,
      version: pkg.version,
      reason,
    }
  }
  const resolved: ExpertTeamAvailability['members'][number] = {
    memberId: member.memberId,
    displayName: pkg.displayName,
    version: pkg.version,
  }
  if (detailOf !== undefined) {
    const detail = detailOf(pkg.slug)
    if (detail !== undefined) resolved.capabilities = expertTeamMemberCapabilities(detail)
  }
  return resolved
}

/**
 * 计算一个定义记录的可用性。
 *
 * 判定顺序固定：损坏 → 定义校验 → 停用 → 成员逐一匹配包宿主。成员判定只读
 * `packages` 参数，绝不查询 `catalogAgents`；全部成员健康时 `invocable: true`。
 */
export function resolveExpertTeamAvailability(
  record: ExpertTeamRecord,
  packages: readonly AgentPackageListItem[],
  detailOf?: ExpertTeamPackageDetailLookup,
): ExpertTeamAvailability {
  if (record.error === 'expert-team-corrupt') {
    return availability('incomplete', ['expert-team-corrupt'])
  }
  const team = record.team
  if (team === undefined) return availability('incomplete', ['expert-team-invalid'])
  if (!validateExpertTeam(team).ok) return availability('incomplete', ['expert-team-invalid'])
  if (!team.enabled) return availability('disabled', ['expert-team-disabled'])

  const members = team.members.map((member) => resolveMember(member, packages, detailOf))
  const reasons = [
    ...new Set(
      members
        .map((member) => member.reason)
        .filter((reason): reason is string => reason !== undefined),
    ),
  ]
  if (reasons.length > 0) {
    return { kind: 'member-invalid', invocable: false, reasons, members }
  }
  return { kind: 'invocable', invocable: true, reasons: [], members }
}
