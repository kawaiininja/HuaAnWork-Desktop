import type { ExpertTeam } from '../client-huaanwork/rpc-types.ts'
import type { AgentPackageHost } from './agent-package/host.ts'
import type { AgentPackageListItem } from './agent-package/types.ts'
import {
  expertTeamMemberCapabilities,
  expertTeamMemberUnavailableReason,
  resolveExpertTeamAvailability,
  type ExpertTeamAvailability,
  type ExpertTeamMemberCapabilities,
  type ExpertTeamPackageDetailLookup,
} from './expert-team/availability.ts'
import { ExpertTeamRunNotFoundError, type ExpertTeamRunRegistry } from './expert-team/runs.ts'
import { ExpertTeamStoreError } from './expert-team/store.ts'
import {
  validateExpertTeam,
  type ExpertTeamRecord,
  type ExpertTeamStore,
  type ExpertTeamValidationErrors,
  type ExpertTeamValidationField,
} from './expert-team/types.ts'
import { RouteError, type RouteContext, type RouteRequest, type RouteTableEntry } from './routes.ts'
import { getAgentPackageHost } from './sessions.ts'

/**
 * 专家团定义与运行的桌面自有 RPC（设计 §14）。
 *
 * 9 条路由都只读写当前 profile 的 store 或当前 Host generation 的内存运行表：
 *
 * - 定义可用性是算出来的，不落盘；成员匹配只消费
 *   `AgentPackageHost.listWithLegacy().packages`（`AgentPackageListItem[]`），
 *   企业目录 legacy 智能体（`catalogAgents`）与工具条目永远不进团队。
 * - `create` 在写入前同时校验定义字段与全部成员包；校验/重名失败以
 *   `{ ok: false, fieldErrors }` 回给编辑器按字段回显。
 * - `update` 按设计 §9.2 允许在成员失效时保存其他字段，但损坏原文件仍
 *   fail-closed 拒绝（`expert-team-corrupt`）。
 * - `remove` 先查该团队的活跃运行（`running` 与 `stopping` 都算），再删 JSON；
 *   损坏定义允许显式删除，删除不触碰智能体、会话或历史 Artifact。
 * - `cancel` 只接受 `parentSessionId + teamRunId`，未知或跨父会话一律映射为
 *   404 `expert-team-run-not-found`，绝不退化为按 slug 或会话级取消。
 */

/** 编辑器按字段回显的错误行；与 `AgentFieldError` 同形。 */
export type ExpertTeamFieldError = { field: string; message: string }

/** 列表/详情的一行：定义、损坏标记与实时可用性。 */
export type ExpertTeamListRow = {
  id: string
  team?: ExpertTeam
  error?: 'expert-team-corrupt'
  availability: ExpertTeamAvailability
}

/** 成员选择器的一项：当前健康、可作为成员的健康包及其原生能力摘要。 */
export type ExpertTeamSelectablePackage = {
  slug: string
  displayName: string
  source: 'local' | 'catalog'
  version: string
  description: string
  capabilities?: ExpertTeamMemberCapabilities
}

export type ExpertTeamListResult = {
  teams: ExpertTeamListRow[]
  packages: ExpertTeamSelectablePackage[]
}

export type ExpertTeamGetResult = ExpertTeamListRow

/** 写路径的字段错误结果；成功时携带写入后的完整定义。 */
export type ExpertTeamWriteResult =
  | { ok: true; team: ExpertTeam }
  | { ok: false; fieldErrors: ExpertTeamFieldError[] }

/** 校验器按编辑器字段顺序输出稳定错误顺序。 */
const VALIDATION_FIELD_ORDER: readonly ExpertTeamValidationField[] = [
  'slug',
  'name',
  'description',
  'scenarios',
  'members',
  'orchestration',
  'review',
  'summary',
]

/**
 * create 的 envelope 占位：存储层自己盖章 schemaVersion/id/时间戳，这里只为让
 * 共享校验器检查可编辑字段，placeholder 值不进入存储。
 */
const CREATE_VALIDATION_ENVELOPE = {
  schemaVersion: 1,
  id: 'pending-expert-team',
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
} as const

const MEMBER_REASON_TEXT: Record<string, string> = {
  'expert-team-member-missing': '不存在或不是本地/广场智能体包',
  'expert-team-member-disabled': '已停用',
  'expert-team-member-broken': '已损坏',
  'expert-team-member-revoked': '已撤销',
}

function requireRuntime(ctx: RouteContext): NonNullable<RouteContext['runtimeCtx']> {
  if (ctx.runtimeCtx === undefined) {
    throw new RouteError(503, 'runtime-unavailable', 'host runtime context is not available')
  }
  return ctx.runtimeCtx
}

function requireExpertTeamStore(ctx: RouteContext): ExpertTeamStore {
  const store = requireRuntime(ctx).huaanworkExpertTeamStore
  if (store === undefined) {
    throw new RouteError(503, 'runtime-unavailable', 'expert team store is not initialized')
  }
  return store
}

function requireExpertTeamRuns(ctx: RouteContext): ExpertTeamRunRegistry {
  const runs = requireRuntime(ctx).huaanworkExpertTeamRuns
  if (runs === undefined) {
    throw new RouteError(503, 'runtime-unavailable', 'expert team run registry is not initialized')
  }
  return runs
}

/** 本地智能体包宿主由 `index.ts` 在装配时注入；缺席是装配错误，按 503 报告。 */
function requireAgentPackageHost(): AgentPackageHost {
  const host = getAgentPackageHost()
  if (host === undefined) {
    throw new RouteError(503, 'runtime-unavailable', 'agent package host is not initialized')
  }
  return host
}

function requireObjectBody(req: RouteRequest, method: string): Record<string, unknown> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new RouteError(400, 'bad-request', `${method} requires object body`)
  }
  return req.body as Record<string, unknown>
}

function requireBodyString(body: Record<string, unknown>, key: string, method: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new RouteError(400, 'bad-request', `${method} requires params.${key}`)
  }
  return value
}

function toFieldErrors(errors: ExpertTeamValidationErrors): ExpertTeamFieldError[] {
  const fieldErrors: ExpertTeamFieldError[] = []
  for (const field of VALIDATION_FIELD_ORDER) {
    const message = errors[field]
    if (message !== undefined) fieldErrors.push({ field, message })
  }
  return fieldErrors
}

/** 存储层在写路径内部再次校验失败时的兜底：字段错误仍按编辑器字段回显。 */
function invalidFieldErrors(error: ExpertTeamStoreError): ExpertTeamFieldError[] {
  const fieldErrors = error.fieldErrors === undefined ? [] : toFieldErrors(error.fieldErrors)
  return fieldErrors.length > 0 ? fieldErrors : [{ field: 'slug', message: error.message }]
}

/**
 * create 前的成员全量校验（设计 §9.2）：所有成员都必须存在于当前包列表且健康。
 * 只读 `packages`，不触及 legacy 目录；失败时不写任何文件。
 */
function memberFieldErrors(
  team: ExpertTeam,
  packages: readonly AgentPackageListItem[],
): ExpertTeamFieldError[] {
  const fieldErrors: ExpertTeamFieldError[] = []
  for (const member of team.members) {
    const pkg = packages.find(
      (candidate) => candidate.source === member.agentRef.source && candidate.slug === member.agentRef.slug,
    )
    const reason = pkg === undefined
      ? 'expert-team-member-missing'
      : expertTeamMemberUnavailableReason(pkg)
    if (reason === undefined) continue
    const displayName = pkg === undefined ? member.agentRef.slug : pkg.displayName
    fieldErrors.push({
      field: 'members',
      message: `成员「${displayName}」${MEMBER_REASON_TEXT[reason] ?? '不可用'}，请重新选择`,
    })
  }
  return fieldErrors
}

function toRouteError(error: ExpertTeamStoreError): RouteError {
  if (error.code === 'expert-team-not-found') return new RouteError(404, error.code, error.message)
  if (error.code === 'expert-team-corrupt') return new RouteError(409, error.code, error.message)
  if (error.code === 'expert-team-slug-exists') return new RouteError(409, error.code, error.message)
  return new RouteError(400, error.code, error.message)
}

function rethrowStoreError(error: unknown): never {
  if (error instanceof ExpertTeamStoreError) throw toRouteError(error)
  throw error
}

function toTeamRow(
  record: ExpertTeamRecord,
  packages: readonly AgentPackageListItem[],
  detailOf: ExpertTeamPackageDetailLookup | undefined,
): ExpertTeamListRow {
  const row: ExpertTeamListRow = {
    id: record.id,
    availability: resolveExpertTeamAvailability(record, packages, detailOf),
  }
  if (record.team !== undefined) row.team = record.team
  if (record.error !== undefined) row.error = record.error
  return row
}

/** 成员选择器只列健康包，并附上包原生脚本/HTTP/MCP 能力摘要。 */
function selectablePackages(
  packages: readonly AgentPackageListItem[],
  detailOf: ExpertTeamPackageDetailLookup,
): ExpertTeamSelectablePackage[] {
  const options: ExpertTeamSelectablePackage[] = []
  for (const pkg of packages) {
    if (expertTeamMemberUnavailableReason(pkg) !== undefined) continue
    const option: ExpertTeamSelectablePackage = {
      slug: pkg.slug,
      displayName: pkg.displayName,
      source: pkg.source,
      version: pkg.version,
      description: pkg.description,
    }
    const detail = detailOf(pkg.slug)
    if (detail !== undefined) option.capabilities = expertTeamMemberCapabilities(detail)
    options.push(option)
  }
  return options
}

function emitChanged(ctx: RouteContext, teamId: string): void {
  ctx.emit({ event: 'expertTeam/changed', teamId })
}

export const expertTeamRoutes: readonly RouteTableEntry[] = [
  {
    method: 'expertTeam.list',
    http: 'GET',
    path: '/huaanwork/expert-team/list',
    handler: async (_req, ctx) => {
      const store = requireExpertTeamStore(ctx)
      const host = requireAgentPackageHost()
      const records = await store.list()
      const { packages } = await host.listWithLegacy()
      const detailOf = (slug: string) => host.detail(slug)
      return {
        teams: records.map((record) => toTeamRow(record, packages, detailOf)),
        packages: selectablePackages(packages, detailOf),
      } satisfies ExpertTeamListResult
    },
  },
  {
    method: 'expertTeam.get',
    http: 'GET',
    path: '/huaanwork/expert-team/get',
    handler: async (req, ctx) => {
      const id = req.query.get('id')
      if (!id) throw new RouteError(400, 'bad-request', 'expertTeam.get requires params.id')
      const store = requireExpertTeamStore(ctx)
      const host = requireAgentPackageHost()
      let record: ExpertTeamRecord
      try {
        record = await store.get(id)
      } catch (error) {
        return rethrowStoreError(error)
      }
      const { packages } = await host.listWithLegacy()
      return toTeamRow(record, packages, (slug) => host.detail(slug)) satisfies ExpertTeamGetResult
    },
  },
  {
    method: 'expertTeam.create',
    http: 'POST',
    path: '/huaanwork/expert-team/create',
    handler: async (req, ctx) => {
      const store = requireExpertTeamStore(ctx)
      const host = requireAgentPackageHost()
      const body = requireObjectBody(req, 'expertTeam.create')
      const validated = validateExpertTeam({ ...body, ...CREATE_VALIDATION_ENVELOPE })
      if (!validated.ok) return { ok: false, fieldErrors: toFieldErrors(validated.errors) }
      const { packages } = await host.listWithLegacy()
      const memberErrors = memberFieldErrors(validated.team, packages)
      if (memberErrors.length > 0) return { ok: false, fieldErrors: memberErrors }
      try {
        const team = await store.create(body)
        emitChanged(ctx, team.id)
        return { ok: true, team }
      } catch (error) {
        if (error instanceof ExpertTeamStoreError) {
          if (error.code === 'expert-team-invalid') {
            return { ok: false, fieldErrors: invalidFieldErrors(error) }
          }
          if (error.code === 'expert-team-slug-exists') {
            return {
              ok: false,
              fieldErrors: [{ field: 'slug', message: `调用名「${validated.team.slug}」已被使用` }],
            }
          }
        }
        return rethrowStoreError(error)
      }
    },
  },
  {
    method: 'expertTeam.update',
    http: 'POST',
    path: '/huaanwork/expert-team/update',
    handler: async (req, ctx) => {
      const store = requireExpertTeamStore(ctx)
      const body = requireObjectBody(req, 'expertTeam.update')
      const id = requireBodyString(body, 'id', 'expertTeam.update')
      try {
        // id/slug/createdAt 由存储层保留；成员失效不阻止保存其他字段（§9.2）。
        const team = await store.update(id, body)
        emitChanged(ctx, team.id)
        return { ok: true, team }
      } catch (error) {
        if (error instanceof ExpertTeamStoreError && error.code === 'expert-team-invalid') {
          return { ok: false, fieldErrors: invalidFieldErrors(error) }
        }
        return rethrowStoreError(error)
      }
    },
  },
  {
    method: 'expertTeam.setEnabled',
    http: 'POST',
    path: '/huaanwork/expert-team/setEnabled',
    handler: async (req, ctx) => {
      const store = requireExpertTeamStore(ctx)
      const body = requireObjectBody(req, 'expertTeam.setEnabled')
      const id = requireBodyString(body, 'id', 'expertTeam.setEnabled')
      if (typeof body.enabled !== 'boolean') {
        throw new RouteError(400, 'bad-request', 'expertTeam.setEnabled requires params.enabled')
      }
      try {
        const team = await store.setEnabled(id, body.enabled)
        emitChanged(ctx, team.id)
        return { ok: true, team }
      } catch (error) {
        return rethrowStoreError(error)
      }
    },
  },
  {
    method: 'expertTeam.remove',
    http: 'POST',
    path: '/huaanwork/expert-team/remove',
    handler: async (req, ctx) => {
      const store = requireExpertTeamStore(ctx)
      const runs = requireExpertTeamRuns(ctx)
      const body = requireObjectBody(req, 'expertTeam.remove')
      const id = requireBodyString(body, 'id', 'expertTeam.remove')
      // running 与 stopping 都算活跃：必须先终止运行才能删除定义。
      if (runs.hasActive(id)) {
        throw new RouteError(409, 'expert-team-active', 'expert-team-active: 专家团有进行中的运行，请先终止')
      }
      try {
        await store.remove(id)
      } catch (error) {
        return rethrowStoreError(error)
      }
      emitChanged(ctx, id)
      return { removed: true }
    },
  },
  {
    method: 'expertTeam.invocableList',
    http: 'GET',
    path: '/huaanwork/expert-team/invocable',
    handler: async (_req, ctx) => {
      const store = requireExpertTeamStore(ctx)
      const host = requireAgentPackageHost()
      const records = await store.list()
      const { packages } = await host.listWithLegacy()
      const teams: ExpertTeam[] = []
      for (const record of records) {
        const team = record.team
        if (team === undefined) continue
        if (!resolveExpertTeamAvailability(record, packages).invocable) continue
        teams.push(team)
      }
      return { teams }
    },
  },
  {
    method: 'expertTeam.runList',
    http: 'GET',
    path: '/huaanwork/expert-team/run/list',
    handler: async (req, ctx) => {
      const sessionId = req.query.get('sessionId')
      if (!sessionId) throw new RouteError(400, 'bad-request', 'expertTeam.runList requires params.sessionId')
      return requireExpertTeamRuns(ctx).list({ sessionId })
    },
  },
  {
    method: 'expertTeam.cancel',
    http: 'POST',
    path: '/huaanwork/expert-team/cancel',
    handler: async (req, ctx) => {
      const runs = requireExpertTeamRuns(ctx)
      const body = requireObjectBody(req, 'expertTeam.cancel')
      const parentSessionId = requireBodyString(body, 'parentSessionId', 'expertTeam.cancel')
      const teamRunId = requireBodyString(body, 'teamRunId', 'expertTeam.cancel')
      try {
        return runs.requestCancel(parentSessionId, teamRunId)
      } catch (error) {
        if (error instanceof ExpertTeamRunNotFoundError) {
          throw new RouteError(404, 'expert-team-run-not-found', `expert-team-run-not-found: ${teamRunId}`)
        }
        throw error
      }
    },
  },
]
