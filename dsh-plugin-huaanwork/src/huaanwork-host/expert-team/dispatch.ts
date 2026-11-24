import type { SessionId } from '@deepseek-ai/dsh-session'

import type { AgentPackageDispatchContext } from '../agent-package/host.ts'
import type { AgentPackageDetail } from '../agent-package/types.ts'
import type { MemberTextResult } from './text-protocol.ts'

/**
 * 团队 MCP 服务名与活动成员冲突。
 *
 * 团队成员的 MCP 挂载按预留子会话隔离：每个成员一个 `serverName`，总长受上游
 * 32 字符上限约束。活动名集合在派发前登记、清理时释放；同一名字被两个在途成员
 * 使用时 fail-closed，而不是让上游注册冲突回滚一半的挂载。
 */
export const EXPERT_TEAM_MCP_SERVER_NAME_CONFLICT = 'expert-team-mcp-server-name-conflict'

/** 上游 MCP `serverName` 允许的最大长度（`deepseek-harness` mcp-client 的公开契约）。 */
export const EXPERT_TEAM_MCP_SERVER_NAME_MAX_LENGTH = 32

/**
 * 团队成员的 MCP `serverName`：slug 截断至 22 字符 + `__` + 预留子会话 id 前 8 个
 * 十六进制字符，总长恒 ≤32。普通 `@智能体` 仍按 slug 命名，不受这里影响。
 *
 * @param slug - 成员包 slug
 * @param reservedChildId - 派发在 activation 之前预留的子会话 id
 * @returns 团队路径专属且长度合法的服务名
 */
export function teamMcpServerName(slug: string, reservedChildId: string): string {
  return `${slug.slice(0, 22)}__${reservedChildId.replaceAll('-', '').slice(0, 8)}`
}

/**
 * 团队成员被取消（单成员定向取消、整团取消或外部 abort）时 Task 7 抛出的稳定错误码。
 *
 * 协调器按该 `code` 把成员派工归类为 `stopped`，不解析可能随本地化变化的文案；
 * 普通 `@智能体` `dispatch()` 的取消错误不携带该码，行为保持不变。
 */
export const EXPERT_TEAM_MEMBER_CANCELLED = 'expert-team-member-cancelled'

/** 活动名冲突的稳定错误码 + 可读文案；调用方按 `code` 映射，不解析文本。 */
export function teamMcpServerNameConflict(name: string): Error {
  const error = new Error(
    `${EXPERT_TEAM_MCP_SERVER_NAME_CONFLICT}: 团队 MCP 服务名「${name}」与活动成员冲突`,
  ) as Error & { code: string }
  error.code = EXPERT_TEAM_MCP_SERVER_NAME_CONFLICT
  return error
}

/**
 * 团队成员派工(`expert_team_dispatch` 适配层)的输入。
 *
 * 与普通 `AgentPackageDispatchInput` 的区别是团队专属的隔离要求：
 * - `teamRunId` 写入成员 run 投影，主聊流据此跳过独立运行卡；
 * - `onRunCreated` 在 `begin` 之后、任何 `await` 之前同步回调，协调器可立即写入
 *   `memberRunId` 并支持单成员/整团取消；
 * - `signal` 是运行级取消闩，与内部 controller 联动触发 `cancelTurn('cancel')`；
 * - `mcpServerName` 只供协调器覆盖默认命名(默认见 {@link teamMcpServerName})。
 */
export type TeamMemberDispatchInput = {
  ctx: AgentPackageDispatchContext
  sessionId: string
  teamRunId: string
  pkg: AgentPackageDetail
  remainder: string
  clientMessageId?: string
  signal?: AbortSignal
  onRunCreated?: (info: { runId: string; reservedChildId: SessionId }) => void
  resolveParent?: () => Promise<unknown>
  mcpServerName?: string
}

/**
 * 一次团队成员派工的 caller 结果。
 *
 * 成员 activation 使用 `delivery: 'caller'` 且不传 `outputSchema`：上游不会给父会话
 * 追加结算消息，团长工具直接拿到渲染后的文本结果。`cleanupPromise` 是本成员资源
 * (activation/runtime/MCP/绑定)的收尾确认，父回合 `afterIdle` 在取消竞态下应等待它。
 */
export type TeamMemberDispatchResult = {
  runId: string
  reservedChildId: SessionId
  actualChildId: SessionId
  stopReason: string
  diagnostic?: string
  output: MemberTextResult
  cleanupPromise: Promise<void>
}
