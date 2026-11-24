import type { ExpertTeam } from '../../client-huaanwork/rpc-types.ts'

export type { ExpertTeam, ExpertTeamAgentRef, ExpertTeamMember } from '../../client-huaanwork/rpc-types.ts'
export type {
  ExpertTeamValidationErrors,
  ExpertTeamValidationField,
  ExpertTeamValidationResult,
} from '../../client-huaanwork/logic/expertTeamsLogic.ts'
export { validateExpertTeam } from '../../client-huaanwork/logic/expertTeamsLogic.ts'

/**
 * 一条团队定义的读取投影。
 *
 * `error` 只表示该文件本身不可用（JSON 损坏、字段非法或文件 id 与内容 id 不一致）；
 * 此时不提供 `team`，但保留文件 id 供列表展示与显式删除。可选键只在有值时出现，
 * 不写显式 `undefined`（`exactOptionalPropertyTypes`）。
 */
export type ExpertTeamRecord = { id: string; team?: ExpertTeam; error?: 'expert-team-corrupt' }

/** 按 profile 隔离的团队定义存储；所有按 id 的入口都拒绝路径穿越。 */
export type ExpertTeamStore = {
  list(): Promise<ExpertTeamRecord[]>
  get(id: string): Promise<ExpertTeamRecord>
  create(input: unknown): Promise<ExpertTeam>
  update(id: string, patch: unknown): Promise<ExpertTeam>
  setEnabled(id: string, enabled: boolean): Promise<ExpertTeam>
  remove(id: string): Promise<void>
}
