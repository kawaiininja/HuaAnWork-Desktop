import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { compareAgentPackageVersions } from '@huaanwork/agent-package-format/manifest'
import type {
  AgentPackageSignatureInfo,
  AgentSource,
  RpcEvent,
  RunSummary,
} from '../client-huaanwork/rpc-types.ts'
import { readCachedCatalogPackages, refreshCatalogPackageCache, type AgentPackageSummary } from './agent-package/catalog-client.ts'
import {
  AGENT_PACKAGE_VERIFY_FAILURE,
  installCatalogAgentPackage,
  refreshInstalledCatalogPackageStatuses,
  removeCatalogAgentPackage,
  updateCatalogAgentPackage,
} from './agent-package/catalog-install.ts'
import {
  publishLocalAgentPackage,
  refreshLocalAgentPackagePublishStatus,
  requestLocalAgentPackageDelist,
} from './agent-package/catalog-publish.ts'
import type { AgentCatalogSecurity } from './agent-package/catalog-security.ts'
import type { AgentPackageHost, AgentPackageListResult as HostAgentPackageListResult } from './agent-package/host.ts'
import { isSameOriginLoopbackRequest } from './loopback.ts'
import { hasGit, listTree } from './native.ts'
import { addPlugin, listPlugins, PluginCommandError, removePlugin, type PluginPnpmCapability } from './plugins-host.ts'
import { getAgentPackageHost, getAgentsDirectory } from './sessions.ts'
import { removeSessionFilesById } from './session-sweep.ts'
import {
  createSkill,
  getSkill,
  importSkill,
  listExternalSkills,
  listUserSkills,
  previewSkillImport,
  removeSkill,
  setSkillEnabled,
  updateSkill,
  type SkillInput,
  type SkillSourceFilter,
  type SkillUpdateInput,
} from './skills-host.ts'
import { INTERNAL_BUNDLED_SKILLS, listBundledSkills, readSkillToggles, SYSTEM_SKILLS } from '../huaanwork-guardrails/skills.ts'
import {
  RUNS_LIMIT,
  RUN_STATUSES,
  findAutomation,
  listAutomations,
  listProjects,
  listTasks,
  createProject,
  createTask,
  bindTaskSession,
  recentRuns,
  removeAutomationsOfProject,
  removeProject,
  removeTask,
  removeTasksOfProject,
  renameProject,
  renameTask,
  readAutomationTemplates,
  touchProject,
} from './stores.ts'
import {
  agentsDirectoryErrors,
  mergeSettings,
  readHuaanworkSettings,
  writeHuaanworkSettings,
} from './settings.ts'
import {
  authChangePassword,
  authLogin,
  authLogout,
  authRegister,
  authStatus,
} from './auth.ts'
import {
  assertAutomationIdle,
  sessionAnswerApproval,
  sessionAnswerInput,
  sessionCancel,
  sessionExitPlanMode,
  sessionList,
  sessionNew,
  sessionOpen,
  releaseSessionRuntime,
  sessionRemove,
  sessionResume,
  sessionSend,
  type SessionRuntimeContext,
} from './sessions.ts'
import { closeWorkspace, openWorkspace } from './workspace.ts'
import {
  createAutomation,
  deleteAutomationRun,
  normalizeAutomationInput,
  pruneAutomationSessions,
  removeAutomation,
  updateAutomation,
} from './automations-store.ts'
import { agentIdle, automationCollector, automationRootDecision, enqueueAutomation, stopAutomation } from './automations-host.ts'

export interface RouteRequest {
  params: Record<string, string>
  body: unknown
  query: URLSearchParams
}

export interface RouteContext {
  dshHome: string
  profileDir: string
  workspaceRoot: { current: string }
  emit(event: RpcEvent): void
  logger(message: string): void
  /** cordis 运行时 ctx(agents/subagents/huaanworkApprovals 等 holders);Task 7 session 域消费。 */
  runtimeCtx?: SessionRuntimeContext
  /**
   * 插件安装/卸载的确认重启(index.ts 以 desktopRuntime.requestConfirmedRestart 提供)。
   * 工作区切换不走这里:open/close 在进程内改 holder。
   */
  requestRestart(): Promise<boolean>
  /**
   * 插件安装/卸载的 CLI 执行器(pnpm.ts runPlugin;Task 6.2 起 `run` 也被本地目录源
   * 的 `pnpm pack` 消费)。holders 在 desktopPnpm 已提供时挂上;缺席时写路径再向
   * runtimeCtx 查一次,仍没有则 503。
   */
  desktopPnpm?: PluginPnpmCapability
}

export type RouteHandler = (req: RouteRequest, ctx: RouteContext) => Promise<unknown>

export class RouteError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = 'RouteError'
  }
}

export const routeKey = (http: string, path: string): string => `${http} ${path}`

/**
 * 统一错误映射 wrapper 工厂 (N1 修复):
 * 旧 sidecar 的 RPC 错误面把用户可读消息(跨工作区拒绝、网络门禁文案、not found、
 * 校验失败等)直传前端;新 HTTP 面对非 RouteError 缺省只回 500 通用文案、
 * 真实错误消息对客户端不可达。
 * 该工厂把底层非 RouteError 的 Error 映射为 HTTP 400 + 指定业务错误码 + 原文字面量,
 * 确保旧用户可读错误面不丢失。非 Error 对象抛出仍放行至 dispatch 500 兜底。
 */
export const errorRoute = (code: string) => (fn: (req: RouteRequest, ctx: RouteContext) => unknown): RouteHandler => {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx)
    } catch (err) {
      if (err instanceof RouteError) throw err
      if (err instanceof Error) throw new RouteError(400, code, err.message)
      throw err
    }
  }
}

export const sessionRoute = errorRoute('session-error')

const requireRuntime = (ctx: RouteContext): SessionRuntimeContext => {
  if (!ctx.runtimeCtx) {
    throw new RouteError(503, 'runtime-unavailable', 'host runtime context is not available')
  }
  return ctx.runtimeCtx
}

/** 本地智能体包宿主由 `index.ts` 在装配时注入;缺席是装配错误,按 503 报告。 */
const requireAgentPackageHost = (): AgentPackageHost => {
  const host = getAgentPackageHost()
  if (host === undefined) {
    throw new RouteError(503, 'runtime-unavailable', 'agent package host is not initialized')
  }
  return host
}

export const workspaceRoute = errorRoute('workspace-error')
export const storeRoute = errorRoute('store-error')
const pluginRoute = errorRoute('plugin-error')

function rethrowPluginCommand(error: unknown): never {
  if (error instanceof PluginCommandError) {
    throw new RouteError(error.status, error.code, error.message)
  }
  throw error
}

/** GET query 参数直读(旧 host.ts case 语义的 params 直读平移;query contract 见 api.ts)。 */
function queryParam(req: RouteRequest, key: string): string | undefined {
  const value = req.query.get(key)
  return value === null ? undefined : value
}

/** POST body 字符串参数直读(旧 host.ts objectString 逐字:不 trim,空串由调用方判)。 */
function bodyParam(body: unknown, key: string): string | undefined {
  return body && typeof body === 'object' && typeof (body as Record<string, unknown>)[key] === 'string'
    ? (body as Record<string, string>)[key]
    : undefined
}

// ---------------------------------------------------------------------------
// M2 智能体包生命周期路由共用面(Task 11)
// ---------------------------------------------------------------------------

/** Task 10 的安全面挂在 cordis holder 上;`runtimeCtx` 是同一 Context 的窄化视图。 */
type AgentCatalogSecurityContext = SessionRuntimeContext & {
  huaanworkAgentCatalogSecurity?: AgentCatalogSecurity
}

function optionalCatalogSecurity(ctx: RouteContext): AgentCatalogSecurity | undefined {
  return (ctx.runtimeCtx as AgentCatalogSecurityContext | undefined)?.huaanworkAgentCatalogSecurity
}

/** 安装/更新/移除/刷新缺少安全面是装配错误:不能在没有撤销与回合停止能力时改包。 */
function requireCatalogSecurity(ctx: RouteContext): AgentCatalogSecurity {
  const security = optionalCatalogSecurity(ctx)
  if (security === undefined) {
    throw new RouteError(503, 'runtime-unavailable', 'agent catalog security is not initialized')
  }
  return security
}

/** 桌面端不接收 admin token 与签名私钥;请求体/query 出现即拒绝,不进日志。 */
const AGENT_PACKAGE_SECRET_FIELD = /^(?:admin[_-]?token|private[_-]?key)$/iu

function assertNoAgentPackageSecrets(req: RouteRequest, method: string): void {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    for (const key of Object.keys(req.body)) {
      if (AGENT_PACKAGE_SECRET_FIELD.test(key)) {
        throw new RouteError(400, 'bad-request', `${method} does not accept ${key}`)
      }
    }
  }
  for (const key of req.query.keys()) {
    if (AGENT_PACKAGE_SECRET_FIELD.test(key)) {
      throw new RouteError(400, 'bad-request', `${method} does not accept ${key}`)
    }
  }
}

function requireAgentPackageBody(req: RouteRequest, method: string): Record<string, unknown> {
  assertNoAgentPackageSecrets(req, method)
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new RouteError(400, 'bad-request', `${method} requires object body`)
  }
  return req.body as Record<string, unknown>
}

function requireAgentPackageString(body: Record<string, unknown>, key: string, method: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new RouteError(400, 'bad-request', `${method} requires params.${key}`)
  }
  return value
}

/**
 * 详情页签名信息(C19):catalog 包每次经 Task 10 的运行前复验计算,local 包
 * 一律 `not-applicable`。`detail()` 保持同步契约,异步复验只在这一层组合。
 */
async function agentPackageSignatureInfo(
  ctx: RouteContext,
  slug: string,
  source: string,
): Promise<AgentPackageSignatureInfo> {
  const unsigned: AgentPackageSignatureInfo = {
    keyId: '',
    signedAt: '',
    slot: 1,
    verification: 'not-applicable',
  }
  if (source !== 'catalog') return unsigned
  const security = optionalCatalogSecurity(ctx)
  if (security === undefined) {
    // 没有复验面就不能声称签名有效;UI 按 invalid + 统一文案展示。
    return { ...unsigned, verification: 'invalid', reason: AGENT_PACKAGE_VERIFY_FAILURE }
  }
  try {
    const verification = await security.verifyInstalled(slug)
    if (!verification.ok) {
      return { ...unsigned, verification: 'invalid', reason: verification.reason }
    }
    return {
      keyId: verification.signature.keyId,
      signedAt: verification.signature.signedAt,
      slot: verification.signature.slot,
      verification: 'valid',
    }
  } catch (error) {
    return { ...unsigned, verification: 'invalid', reason: errorText(error) }
  }
}

type PublicationFields = {
  publishStatus?: string
  publishedVersion?: string
  submissionId?: string
  reviewReason?: string
  delistRequestId?: string
}

/** 本地发布字段的比较指纹;只关心对外可见字段,不比较时间戳。 */
function publicationSignature(value: PublicationFields): string {
  return JSON.stringify([
    value.publishStatus ?? '',
    value.publishedVersion ?? '',
    value.submissionId ?? '',
    value.reviewReason ?? '',
    value.delistRequestId ?? '',
  ])
}

/**
 * 刷新每个有发布身份的本地包的审查/下架状态。
 *
 * 单项失败保留已有卡片并把原因并入 warning;不回退成「未发布」。
 */
async function refreshLocalPublications(
  host: AgentPackageHost,
): Promise<{ changed: boolean; warning?: string }> {
  let changed = false
  const failures: string[] = []
  for (const item of host.listLocal()) {
    if (item.source !== 'local') continue
    if (item.submissionId === undefined && item.publishedVersion === undefined) continue
    try {
      const publication = await refreshLocalAgentPackagePublishStatus(item.slug)
      if (publicationSignature(publication) !== publicationSignature(item)) changed = true
    } catch (error) {
      failures.push(`${item.slug}: ${errorText(error)}`)
    }
  }
  return failures.length === 0
    ? { changed }
    : { changed, warning: `本地发布状态刷新失败：${failures.join('；')}` }
}

function mergeCatalogErrors(...values: Array<string | undefined>): string | undefined {
  const unique = [
    ...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0)),
  ]
  return unique.length === 0 ? undefined : unique.join('；')
}

/**
 * 列表载荷 + 广场摘要:已安装的 catalog 行补 `latestVersion`/`updateAvailable`。
 *
 * 版本比较只在 host 侧做(renderer 不导入 Node-only 包格式模块);非法版本按
 * 不可比较处理,不把损坏包误标成可更新。
 */
function withCatalogPackages(
  base: HostAgentPackageListResult,
  catalogPackages: AgentPackageSummary[],
): HostAgentPackageListResult & { catalogPackages: AgentPackageSummary[] } {
  const latestBySlug = new Map<string, string>()
  for (const summary of catalogPackages) {
    const current = latestBySlug.get(summary.slug)
    if (current === undefined || compareAgentVersions(summary.version, current) > 0) {
      latestBySlug.set(summary.slug, summary.version)
    }
  }
  return {
    ...base,
    packages: base.packages.map((item) => {
      if (item.source !== 'catalog') return item
      const latestVersion = latestBySlug.get(item.slug)
      if (latestVersion === undefined) return item
      return {
        ...item,
        latestVersion,
        updateAvailable: compareAgentVersions(latestVersion, item.version) > 0,
      }
    }),
    catalogPackages,
  }
}

function compareAgentVersions(left: string, right: string): -1 | 0 | 1 {
  try {
    return compareAgentPackageVersions(left, right)
  } catch {
    return 0
  }
}

function cachedCatalogPackages(): AgentPackageSummary[] {
  try {
    return readCachedCatalogPackages()
  } catch {
    // 目录绑定尚未初始化(早期启动/单元测试):广场摘要按空处理,本地包不受影响。
    return []
  }
}

function installedPackageState(slug: string, version: string): {
  ok: true
  slug: string
  version: string
  enabled: boolean
  publishStatus: string
} {
  const detail = requireAgentPackageHost().detail(slug)
  return {
    ok: true,
    slug,
    version,
    enabled: detail?.enabled ?? false,
    publishStatus: detail?.publishStatus ?? 'installed',
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 刷新已安装 metadata 与撤销列表,并保证**撤销刷新不被 installed 失败跳过**。
 *
 * `agent.packageRefresh` 的撤销刷新是安全相关的(撤销要尽快禁用/中止在途回合),
 * 而 installed metadata 刷新只是发布状态展示。最终评审 M8:先把 installed 的
 * 异常记下来,照常执行撤销刷新,再把原异常抛回调用方(路由错误文案不变)。
 */
export async function refreshInstalledThenRevocations(
  refreshInstalled: () => Promise<{ warning?: string; changed: boolean }>,
  refreshRevocations: () => Promise<{ warning?: string }>,
): Promise<{
  installed: { warning?: string; changed: boolean }
  revocations: { warning?: string }
}> {
  let installed: { warning?: string; changed: boolean } | undefined
  let installedFailure: unknown
  try {
    installed = await refreshInstalled()
  } catch (cause) {
    installedFailure = cause
  }
  const revocations = await refreshRevocations()
  if (installed === undefined) throw installedFailure
  return { installed, revocations }
}

export interface RouteTableEntry {
  method: string
  http: 'GET' | 'POST' | 'PUT'
  path: string
  handler: RouteHandler
}

export interface NativeRouteEntry {
  http: 'GET' | 'POST' | 'PUT'
  path: string
  handler: RouteHandler
}

export const ROUTE_TABLE: readonly RouteTableEntry[] = [
  // workspace:进程内热切换 holder,应答 { workspaceRoot },不重启。
  // 已在目标根短路返回当前根。
  {
    method: 'workspace.open',
    http: 'POST',
    path: '/huaanwork/workspace/open',
    handler: workspaceRoute(async (req, ctx) => {
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
      return openWorkspace(ctx, typeof body.root === 'string' ? body.root : '')
    }),
  },
  { method: 'workspace.close', http: 'POST', path: '/huaanwork/workspace/close', handler: workspaceRoute(async (_req, ctx) => closeWorkspace(ctx)) },

  // session
  { method: 'session.send', http: 'POST', path: '/huaanwork/session/send', handler: sessionRoute(async (req, ctx) => sessionSend(requireRuntime(ctx), ctx, req.body)) }, // Task 7
  { method: 'session.cancel', http: 'POST', path: '/huaanwork/session/cancel', handler: sessionRoute(async (req, ctx) => sessionCancel(requireRuntime(ctx), ctx, req.body)) }, // Task 7
  { method: 'session.approve', http: 'POST', path: '/huaanwork/session/approve', handler: sessionRoute(async (req, ctx) => sessionAnswerApproval(requireRuntime(ctx), ctx, req.body, 'allowed-once')) }, // Task 7
  { method: 'session.reject', http: 'POST', path: '/huaanwork/session/reject', handler: sessionRoute(async (req, ctx) => sessionAnswerApproval(requireRuntime(ctx), ctx, req.body, 'rejected')) }, // Task 7
  { method: 'session.exitPlanMode', http: 'POST', path: '/huaanwork/session/exitPlanMode', handler: sessionRoute(async (req, ctx) => sessionExitPlanMode(requireRuntime(ctx), ctx, req.body)) },
  { method: 'session.answerInput', http: 'POST', path: '/huaanwork/session/answerInput', handler: sessionRoute(async (req) => sessionAnswerInput(req.body)) },
  { method: 'session.list', http: 'GET', path: '/huaanwork/session/list', handler: sessionRoute(async (req, ctx) => sessionList(ctx, req.query.get('root') ?? undefined)) }, // Task 7 (文件 I/O 读会话列表)
  { method: 'session.open', http: 'POST', path: '/huaanwork/session/open', handler: sessionRoute(async (req, ctx) => sessionOpen(ctx, req.body)) }, // Task 7
  { method: 'session.remove', http: 'POST', path: '/huaanwork/session/remove', handler: sessionRoute(async (req, ctx) => sessionRemove(ctx.runtimeCtx, ctx, req.body)) }, // Task 7
  // 纯内存 handler: 仅根据 workspaceRoot 字符串生成或复用 session ID, 无 I/O
  { method: 'session.new', http: 'POST', path: '/huaanwork/session/new', handler: async (req, ctx) => sessionNew(ctx, req.body) }, // Task 7
  { method: 'session.resume', http: 'POST', path: '/huaanwork/session/resume', handler: sessionRoute(async (req, ctx) => sessionResume(requireRuntime(ctx), ctx, req.body)) }, // Task 7

  // settings (纯配置读/写: 读路径内部已容错 ENOENT/SyntaxError 回退 emptySettings; 写路径先手抛校验后持久化)
  { method: 'settings.get', http: 'GET', path: '/huaanwork/settings', handler: async (_req, ctx) => readHuaanworkSettings(ctx.profileDir) },
  {
    method: 'settings.set',
    http: 'PUT',
    path: '/huaanwork/settings',
    handler: async (req, ctx) => {
      const paramObj = typeof req.body === 'object' && req.body !== null ? (req.body as Record<string, unknown>) : {}
      if ('agents_host' in paramObj || 'agents_port' in paramObj) {
        const current = await readHuaanworkSettings(ctx.profileDir)
        const next = mergeSettings(current, req.body)
        const fieldErrors = agentsDirectoryErrors(next)
        if (fieldErrors.length > 0) {
          throw new RouteError(400, 'validation', fieldErrors.map((e) => e.message).join('; '))
        }
      }
      return writeHuaanworkSettings(ctx.profileDir, req.body)
    },
  },

  // auth (认证探测与清除内部已捕获 ENOENT; 注册/登录/改密显式 try-catch 映射 auth-failed)
  { method: 'auth.status', http: 'POST', path: '/huaanwork/auth/status', handler: async (_req, ctx) => authStatus(ctx.profileDir) },
  {
    method: 'auth.register',
    http: 'POST',
    path: '/huaanwork/auth/register',
    handler: async (req, ctx) => {
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
      const username = typeof body.username === 'string' ? body.username : ''
      const password = typeof body.password === 'string' ? body.password : ''
      try {
        return await authRegister(ctx.profileDir, username, password)
      } catch (err) {
        if (err instanceof RouteError) throw err
        throw new RouteError(400, 'auth-failed', err instanceof Error ? err.message : String(err))
      }
    },
  },
  {
    method: 'auth.login',
    http: 'POST',
    path: '/huaanwork/auth/login',
    handler: async (req, ctx) => {
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
      const username = typeof body.username === 'string' ? body.username : ''
      const password = typeof body.password === 'string' ? body.password : ''
      try {
        return await authLogin(ctx.profileDir, username, password)
      } catch (err) {
        if (err instanceof RouteError) throw err
        throw new RouteError(400, 'auth-failed', err instanceof Error ? err.message : String(err))
      }
    },
  },
  // 纯状态清除: 仅 unlink 会话文件并读取状态, 内部已捕获 ENOENT
  { method: 'auth.logout', http: 'POST', path: '/huaanwork/auth/logout', handler: async (_req, ctx) => authLogout(ctx.profileDir) },
  {
    method: 'auth.changePassword',
    http: 'POST',
    path: '/huaanwork/auth/changePassword',
    handler: async (req, ctx) => {
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
      const current = typeof body.current === 'string' ? body.current : ''
      const next = typeof body.next === 'string' ? body.next : ''
      try {
        return await authChangePassword(ctx.profileDir, current, next)
      } catch (err) {
        if (err instanceof RouteError) throw err
        throw new RouteError(400, 'auth-failed', err instanceof Error ? err.message : String(err))
      }
    },
  },

  // plugin
  // 安装/卸载走 desktopPnpm.runPlugin,确认后 generation 重启。boot 失败不是自动回滚:
  // routeDesktopStartupFailure(main.ts:1776-1812)转入启动恢复窗口,用户选 slot 还原
  // (profile-checkpoint.ts:642 restoreSlot;健康快照 captureHealthy 在 profile-checkpoint.ts:564)。
  {
    method: 'plugin.add',
    http: 'POST',
    path: '/huaanwork/plugin/add',
    handler: pluginRoute(async (req, ctx) => {
      const source = bodyParam(req.body, 'source')
      if (!source) throw new RouteError(400, 'bad-request', 'plugin.add requires params.source')
      try {
        return await addPlugin(ctx, source)
      } catch (error) {
        rethrowPluginCommand(error)
      }
    }),
  },
  {
    method: 'plugin.remove',
    http: 'POST',
    path: '/huaanwork/plugin/remove',
    handler: pluginRoute(async (req, ctx) => {
      const name = bodyParam(req.body, 'name')
      if (!name) throw new RouteError(400, 'bad-request', 'plugin.remove requires params.name')
      try {
        return await removePlugin(ctx, name)
      } catch (error) {
        rethrowPluginCommand(error)
      }
    }),
  },
  { method: 'plugin.list', http: 'GET', path: '/huaanwork/plugin/list', handler: storeRoute(async (_req, ctx) => listPlugins(ctx.profileDir)) }, // Task 10 (文件 I/O 读 package.json bundles)

  // skill
  {
    method: 'skill.list',
    http: 'GET',
    path: '/huaanwork/skill/list',
    handler: storeRoute(async (_req, ctx) => {
      // 旧 host.ts:1182-1195 语义:toggles 只作用于内置技能,三源合并全局按名排序、同名不去重。
      const toggles = readSkillToggles(ctx.profileDir)
      // 内部技能(create-agent)由创建入口注入,不进技能中心;仍留 listBundledSkills 供重名检查。
      const bundled = listBundledSkills()
        .filter((skill) => !INTERNAL_BUNDLED_SKILLS.has(skill.name))
        .map((skill) => ({
          ...skill,
          source: 'bundled' as const,
          enabled: SYSTEM_SKILLS.has(skill.name) || toggles[skill.name] === true,
        }))
      const user = await listUserSkills(ctx.profileDir)
      const external = await listExternalSkills()
      // 全局按名称排序;跨来源同名不去重(前端以 source:name 为 key 双卡展示,所见即运行时遮蔽关系)
      const skills = [...bundled, ...user, ...external]
      skills.sort((a, b) => a.name.localeCompare(b.name))
      return { skills }
    }),
  }, // Task 10 (文件 I/O 读技能目录与配置)
  {
    method: 'skill.get',
    http: 'GET',
    path: '/huaanwork/skill/get',
    handler: storeRoute(async (req, ctx) => {
      const name = queryParam(req, 'name')
      if (!name) throw new Error('skill.get requires params.name')
      const sourceParam = queryParam(req, 'source')
      let source: SkillSourceFilter | undefined
      if (sourceParam !== undefined) {
        if (sourceParam !== 'bundled' && sourceParam !== 'user' && sourceParam !== 'external') {
          throw new Error(`skill.get source must be one of bundled | user | external, got ${sourceParam}`)
        }
        source = sourceParam
      }
      const skill = await getSkill(ctx.profileDir, name, source)
      if (!skill) throw new Error(`skill ${name} was not found`)
      return { skill }
    }),
  }, // Task 10
  {
    method: 'skill.create',
    http: 'POST',
    path: '/huaanwork/skill/create',
    handler: storeRoute(async (req, ctx) => {
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
      const name = typeof body.name === 'string' ? body.name : undefined
      if (!name) throw new RouteError(400, 'bad-request', 'skill.create requires params.name')
      return await createSkill(ctx.profileDir, body as unknown as SkillInput)
    }),
  },
  {
    method: 'skill.update',
    http: 'POST',
    path: '/huaanwork/skill/update',
    handler: storeRoute(async (req, ctx) => {
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
      const name = typeof body.name === 'string' ? body.name : undefined
      if (!name) throw new RouteError(400, 'bad-request', 'skill.update requires params.name')
      return await updateSkill(ctx.profileDir, name, body as unknown as SkillUpdateInput)
    }),
  },
  {
    method: 'skill.remove',
    http: 'POST',
    path: '/huaanwork/skill/remove',
    handler: storeRoute(async (req, ctx) => {
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
      const name = typeof body.name === 'string' ? body.name : undefined
      if (!name) throw new RouteError(400, 'bad-request', 'skill.remove requires params.name')
      await removeSkill(ctx.profileDir, name)
      return { removed: true }
    }),
  },
  {
    method: 'skill.importPreview',
    http: 'POST',
    path: '/huaanwork/skill/importPreview',
    handler: storeRoute(async (req, ctx) => {
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
      const path = typeof body.path === 'string' ? body.path : undefined
      if (!path) throw new RouteError(400, 'bad-request', 'skill.importPreview requires params.path')
      const preview = await previewSkillImport(ctx.profileDir, body as { path: string })
      if (!preview.ok) return preview
      return {
        ...preview,
        ...preview.preview,
      }
    }),
  },
  {
    method: 'skill.import',
    http: 'POST',
    path: '/huaanwork/skill/import',
    handler: storeRoute(async (req, ctx) => {
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
      const path = typeof body.path === 'string' ? body.path : undefined
      if (!path) throw new RouteError(400, 'bad-request', 'skill.import requires params.path')
      return await importSkill(ctx.profileDir, body as { path: string })
    }),
  },
  {
    method: 'skill.setEnabled',
    http: 'POST',
    path: '/huaanwork/skill/setEnabled',
    handler: storeRoute(async (req, ctx) => {
      const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>
      const name = typeof body.name === 'string' ? body.name : undefined
      if (!name) throw new RouteError(400, 'bad-request', 'skill.setEnabled requires params.name')
      const enabled = body.enabled === true
      return await setSkillEnabled(ctx.profileDir, name, enabled)
    }),
  },

  // agent
  { method: 'agent.list', http: 'GET', path: '/huaanwork/agent/list', handler: storeRoute(async () => getAgentsDirectory().list()) }, // Task 10 (文件 I/O 读智能体快照)
  { method: 'agent.get', http: 'GET', path: '/huaanwork/agent/get', handler: storeRoute(async (req) => {
    const name = queryParam(req, 'name')
    if (!name) throw new Error('agent.get requires params.name')
    const source = queryParam(req, 'source') as AgentSource | undefined
    // 旧 RPC 面 undefined 序列化为 null;HTTP JSON 面显式落 null(空 body 无法解析)。
    return (await getAgentsDirectory().get(name, source)) ?? null
  }) }, // Task 10
  { method: 'agent.refresh', http: 'POST', path: '/huaanwork/agent/refresh', handler: storeRoute(async () => getAgentsDirectory().refresh()) }, // Task 10 (网络请求拉取目录 + 本地扫描)
  {
    method: 'agent.setEnabled',
    http: 'POST',
    path: '/huaanwork/agent/setEnabled',
    handler: storeRoute(async (req) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new RouteError(400, 'bad-request', 'agent.setEnabled requires object body')
      }
      const body = req.body as Record<string, unknown>
      const name = typeof body.name === 'string' && body.name ? body.name : undefined
      if (!name) throw new RouteError(400, 'bad-request', 'agent.setEnabled requires params.name')
      getAgentsDirectory().setEnabled(name, Boolean(body.enabled), Boolean(body.confirmPermissions))
      return { ok: true }
    }),
  }, // Task 2 (M4)
  {
    method: 'agent.addEndpoint',
    http: 'POST',
    path: '/huaanwork/agent/addEndpoint',
    handler: storeRoute(async (req) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new RouteError(400, 'bad-request', 'agent.addEndpoint requires object body')
      }
      const name = (req.body as Record<string, unknown>).name
      // 包在 `@` 分流里先于本地工具命中:同名工具会永远不可达,写路径直接拒绝。
      if (typeof name === 'string' && name && getAgentPackageHost()?.listLocal().some((pkg) => pkg.slug === name)) {
        throw new RouteError(400, 'bad-request', `智能体 @${name} 与现有智能体包重名，请换一个名称`)
      }
      return getAgentsDirectory().addEndpoint(req.body as Parameters<ReturnType<typeof getAgentsDirectory>['addEndpoint']>[0])
    }),
  }, // Task 2 (M4)
  {
    method: 'agent.removeEndpoint',
    http: 'POST',
    path: '/huaanwork/agent/removeEndpoint',
    handler: storeRoute(async (req) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new RouteError(400, 'bad-request', 'agent.removeEndpoint requires object body')
      }
      const body = req.body as Record<string, unknown>
      const name = typeof body.name === 'string' && body.name ? body.name : undefined
      if (!name) throw new RouteError(400, 'bad-request', 'agent.removeEndpoint requires params.name')
      getAgentsDirectory().removeEndpoint(name)
      return { ok: true }
    }),
  }, // Task 2 (M4)
  // agent package(Task 7):本地包与 legacy 目录两条来源。写路径按 `listLocal()`
  // 判定归属(含损坏包);损坏包只允许关闭,启用仍抛错并由 storeRoute 映射为 400。
  // Task 11:列表并上签名广场缓存摘要,已安装 catalog 行补 latestVersion/updateAvailable。
  { method: 'agent.packageList', http: 'GET', path: '/huaanwork/agent/package/list', handler: storeRoute(async () => withCatalogPackages(await requireAgentPackageHost().listWithLegacy(), cachedCatalogPackages())) },
  {
    method: 'agent.packageDetail',
    http: 'GET',
    path: '/huaanwork/agent/package/detail',
    handler: storeRoute(async (req, ctx) => {
      const slug = queryParam(req, 'slug') ?? ''
      if (!slug) throw new RouteError(400, 'bad-request', 'agent.packageDetail requires params.slug')
      const local = requireAgentPackageHost().detail(slug)
      if (local !== undefined) {
        // C19:签名结果只在这一层组合,host.detail() 保持同步契约。
        return { ...local, signature: await agentPackageSignatureInfo(ctx, slug, local.source) }
      }
      const legacy = await getAgentsDirectory().get(slug)
      if (legacy === undefined) throw new RouteError(400, 'not-found', `智能体「${slug}」不存在`)
      return legacy
    }),
  },
  {
    method: 'agent.packageSetEnabled',
    http: 'POST',
    path: '/huaanwork/agent/package/setEnabled',
    handler: storeRoute(async (req, ctx) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new RouteError(400, 'bad-request', 'agent.packageSetEnabled requires object body')
      }
      const body = req.body as Record<string, unknown>
      const slug = typeof body.slug === 'string' ? body.slug : ''
      if (!slug) throw new RouteError(400, 'bad-request', 'agent.packageSetEnabled requires params.slug')
      const enabled = body.enabled === true
      const host = requireAgentPackageHost()
      if (host.listLocal().some((pkg) => pkg.slug === slug)) {
        host.setEnabled(slug, enabled)
      } else {
        getAgentsDirectory().setEnabled(slug, enabled, body.confirmPermissions === true)
      }
      // 两条分支都只在写入成功后发事件:客户端据此刷新列表。
      ctx.emit({ event: 'agent/changed', slug })
      return { ok: true }
    }),
  },
  { method: 'agent.invocableList', http: 'GET', path: '/huaanwork/agent/invocable', handler: storeRoute(async () => requireAgentPackageHost().invocableWithLegacy()) },

  // agent package M2(Task 11):签名广场生命周期。事件沿用 `agent/changed`:
  // 发布提交由 Task 8 在成功路径发出;其余成功写路径由本层各发一次。
  {
    method: 'agent.packagePublish',
    http: 'POST',
    path: '/huaanwork/agent/package/publish',
    handler: storeRoute(async (req) => {
      const body = requireAgentPackageBody(req, 'agent.packagePublish')
      const slug = requireAgentPackageString(body, 'slug', 'agent.packagePublish')
      // Task 8 已在写盘成功后发 `agent/changed`;这里不重复。
      return publishLocalAgentPackage(slug)
    }),
  },
  {
    method: 'agent.packagePublishStatus',
    http: 'GET',
    path: '/huaanwork/agent/package/publish/status',
    handler: storeRoute(async (req, ctx) => {
      assertNoAgentPackageSecrets(req, 'agent.packagePublishStatus')
      const slug = queryParam(req, 'slug') ?? ''
      if (!slug) throw new RouteError(400, 'bad-request', 'agent.packagePublishStatus requires params.slug')
      // 状态未变化时不发事件:客户端已从应答里拿到最新 publication。
      const before = requireAgentPackageHost().detail(slug)
      const publication = await refreshLocalAgentPackagePublishStatus(slug)
      if (before === undefined || publicationSignature(publication) !== publicationSignature(before)) {
        ctx.emit({ event: 'agent/changed', slug })
      }
      return publication
    }),
  },
  {
    method: 'agent.packageRequestDelist',
    http: 'POST',
    path: '/huaanwork/agent/package/delist-request',
    handler: storeRoute(async (req, ctx) => {
      const body = requireAgentPackageBody(req, 'agent.packageRequestDelist')
      const slug = requireAgentPackageString(body, 'slug', 'agent.packageRequestDelist')
      const reason = requireAgentPackageString(body, 'reason', 'agent.packageRequestDelist')
      if (reason.trim().length === 0) {
        throw new RouteError(400, 'bad-request', 'agent.packageRequestDelist requires a non-empty params.reason')
      }
      const result = await requestLocalAgentPackageDelist(slug, reason)
      ctx.emit({ event: 'agent/changed', slug })
      return result
    }),
  },
  {
    method: 'agent.packageInstall',
    http: 'POST',
    path: '/huaanwork/agent/package/install',
    handler: storeRoute(async (req, ctx) => {
      // 安装不停止任何在途回合(Task 9 首次安装没有旧版本);安全面只在需要时取。
      const body = requireAgentPackageBody(req, 'agent.packageInstall')
      const slug = requireAgentPackageString(body, 'slug', 'agent.packageInstall')
      const version = requireAgentPackageString(body, 'version', 'agent.packageInstall')
      const installed = await installCatalogAgentPackage(slug, version)
      ctx.emit({ event: 'agent/changed', slug })
      return installedPackageState(slug, installed.manifest.version)
    }),
  },
  {
    method: 'agent.packageUpdate',
    http: 'POST',
    path: '/huaanwork/agent/package/update',
    handler: storeRoute(async (req, ctx) => {
      const body = requireAgentPackageBody(req, 'agent.packageUpdate')
      const slug = requireAgentPackageString(body, 'slug', 'agent.packageUpdate')
      // 参数校验先于安全面读取:畸形请求始终是 400,不会因装配缺失变成 503。
      const security = requireCatalogSecurity(ctx)
      // Task 9 在任何 rename 之前以 `update` 原因停止该 slug 的在途回合。
      const updated = await updateCatalogAgentPackage(slug, (target, reason) =>
        security.stopAgentPackageTurnsForSlug(target, reason),
      )
      ctx.emit({ event: 'agent/changed', slug })
      return installedPackageState(slug, updated.manifest.version)
    }),
  },
  {
    method: 'agent.packageRemove',
    http: 'POST',
    path: '/huaanwork/agent/package/remove',
    handler: storeRoute(async (req, ctx) => {
      const body = requireAgentPackageBody(req, 'agent.packageRemove')
      const slug = requireAgentPackageString(body, 'slug', 'agent.packageRemove')
      const security = requireCatalogSecurity(ctx)
      // 本地包由 Task 9 以 `本地创建的智能体不能通过广场移除` 拒绝(400);
      // 目录包在 rename 之前以 `remove` 原因停止在途回合。
      await removeCatalogAgentPackage(slug, (target, reason) =>
        security.stopAgentPackageTurnsForSlug(target, reason),
      )
      ctx.emit({ event: 'agent/changed', slug })
      return { ok: true, removed: true, slug }
    }),
  },
  {
    method: 'agent.packageRefresh',
    http: 'POST',
    path: '/huaanwork/agent/package/refresh',
    handler: storeRoute(async (req, ctx) => {
      assertNoAgentPackageSecrets(req, 'agent.packageRefresh')
      const security = requireCatalogSecurity(ctx)
      const host = requireAgentPackageHost()
      // 顺序固定:legacy 目录 → 广场缓存 → 本地发布状态 → 已安装 metadata → 撤销。
      // 撤销最后应用,返回的卡片已反映本次撤销;刷新失败由 Task 10 保留缓存。
      const legacyRefresh = await getAgentsDirectory().refresh()
      const cache = await refreshCatalogPackageCache()
      const local = await refreshLocalPublications(host)
      const { installed, revocations } = await refreshInstalledThenRevocations(
        refreshInstalledCatalogPackageStatuses,
        () => security.refreshRevocations(),
      )
      // 一批状态变化只发一次统一事件(installed metadata 的 changed 与本地发布
      // 状态变化合并),避免按条目刷屏;客户端据此整表刷新。
      if (installed.changed || local.changed) {
        ctx.emit({ event: 'agent/changed' })
      }
      const list = await host.listWithLegacy()
      const catalogError = mergeCatalogErrors(
        legacyRefresh.catalogError,
        cache.warning,
        local.warning,
        installed.warning,
        list.catalogError,
      )
      return {
        ...withCatalogPackages(list, cache.items),
        ...(catalogError === undefined ? {} : { catalogError }),
        ...(revocations.warning === undefined ? {} : { revocationWarning: revocations.warning }),
      }
    }),
  },

  // status (纯内存 handler: 恒返回 { ready: true }, 无 I/O 或异常路径)
  { method: 'status.get', http: 'GET', path: '/huaanwork/status', handler: async () => ({ ready: true }) }, // Task 4

  // project
  { method: 'project.list', http: 'GET', path: '/huaanwork/project/list', handler: storeRoute(async (_req, ctx) => ({ projects: await listProjects(ctx.profileDir) })) }, // Task 10 (文件 I/O 读 projects.json)
  {
    method: 'project.create',
    http: 'POST',
    path: '/huaanwork/project/create',
    handler: storeRoute(async (req, ctx) => {
      const root = bodyParam(req.body, 'root')
      if (!root) throw new Error('project.create requires params.root')
      const name = bodyParam(req.body, 'name')
      const project = await createProject(ctx.profileDir, { root, ...(name !== undefined ? { name } : {}) })
      return { project }
    }),
  }, // Task 10
  {
    method: 'project.open',
    http: 'POST',
    path: '/huaanwork/project/open',
    // 查项目 → 进程内切工作区 → touchProject 排序戳。应答恒带 workspaceRoot。
    // 若切换后的根与项目根不一致,报 restart-cancelled,调用方应撤销刚写入的项目。
    handler: workspaceRoute(async (req, ctx) => {
      const projectId = bodyParam(req.body, 'projectId')
      if (!projectId) throw new Error('project.open requires params.projectId')
      const project = (await listProjects(ctx.profileDir)).find((item) => item.id === projectId)
      if (!project) throw new Error(`project ${projectId} was not found`)
      const result = await openWorkspace(ctx, project.root)
      if (!('restarting' in result) && resolve(result.workspaceRoot) !== resolve(project.root)) {
        throw new RouteError(400, 'restart-cancelled', '已取消工作区切换,项目未打开')
      }
      await touchProject(ctx.profileDir, projectId)
      return { ...result, project }
    }),
  }, // Task 10
  {
    method: 'project.remove',
    http: 'POST',
    path: '/huaanwork/project/remove',
    // 旧 host.ts:1050-1059 语义:级联清理该项目下全部自动化任务(含运行历史)与
    // 子任务(不触碰项目目录与普通会话日志);子任务绑定会话日志经 removeSessionFilesById 级联删。
    handler: storeRoute(async (req, ctx) => {
      const projectId = bodyParam(req.body, 'projectId')
      if (!projectId) throw new Error('project.remove requires params.projectId')
      const removed = await removeProject(ctx.profileDir, projectId)
      // 自动化运行会话也是会话日志:删目录前同样释放运行态(等待中的输入、live agent、
      // 子会话登记、坏参数计数与已确认计划目标),与 session.remove / 任务级联同口径。
      await removeAutomationsOfProject(ctx.profileDir, projectId, join(ctx.dshHome, 'sessions'), (sessionId) =>
        releaseSessionRuntime(ctx.runtimeCtx, sessionId),
      )
      const cascadedSessionIds = await removeTasksOfProject(ctx.profileDir, projectId)
      // 与 session.remove 同一运行态释放:删文件前先摘掉卡片、live agent、子会话与计划目标。
      for (const sessionId of cascadedSessionIds) releaseSessionRuntime(ctx.runtimeCtx, sessionId)
      await removeSessionFilesById(join(ctx.dshHome, 'sessions'), cascadedSessionIds)
      return { removed: true, project: removed }
    }),
  }, // Task 10
  {
    method: 'project.rename',
    http: 'POST',
    path: '/huaanwork/project/rename',
    handler: storeRoute(async (req, ctx) => {
      const projectId = bodyParam(req.body, 'projectId')
      const name = bodyParam(req.body, 'name')
      if (!projectId) throw new Error('project.rename requires params.projectId')
      if (!name) throw new Error('project.rename requires params.name')
      return { project: await renameProject(ctx.profileDir, projectId, name) }
    }),
  }, // Task 10

  // automation(读路径、注册表写、手动 run 与 pruneSessions 真实;调度 tick 属 Task 5)
  {
    method: 'automation.list',
    http: 'GET',
    path: '/huaanwork/automation/list',
    // 旧 host.ts:1060-1075 语义:list 带最近 5 条运行,missed 汇总从全量(RUNS_LIMIT)筛,
    // 避免 missed 被「最近 5 条」窗口悄悄截掉。
    handler: storeRoute(async (req, ctx) => {
      const projectId = queryParam(req, 'projectId')
      const automations = await listAutomations(ctx.profileDir, projectId)
      const runs: Record<string, RunSummary[]> = {}
      const missed: Record<string, RunSummary[]> = {}
      await Promise.all(
        automations.map(async (automation) => {
          const all = await recentRuns(ctx.profileDir, automation.id, RUNS_LIMIT)
          runs[automation.id] = all.slice(-5)
          missed[automation.id] = all.filter((run) => run.status === 'missed')
        }),
      )
      return { automations, runs, missed }
    }),
  }, // Task 10 (文件 I/O 读自动化表与运行历史)
  {
    method: 'automation.create',
    http: 'POST',
    path: '/huaanwork/automation/create',
    // 旧 host.ts:1078-1087:规范化入参;仅显式绑定时校验项目存在,null(中立)直接放行。
    handler: storeRoute(async (req, ctx) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new Error('automation.create requires an object params')
      }
      const input = normalizeAutomationInput(req.body as Record<string, unknown>)
      if (input.projectId !== null) {
        const projects = await listProjects(ctx.profileDir)
        if (!projects.some((project) => project.id === input.projectId)) {
          throw new Error(`project ${input.projectId} was not found`)
        }
      }
      return { automation: await createAutomation(ctx.profileDir, input) }
    }),
  }, // Task 3 (M4)
  {
    method: 'automation.update',
    http: 'POST',
    path: '/huaanwork/automation/update',
    handler: storeRoute(async (req, ctx) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new Error('automation.update requires an object params')
      }
      const id = bodyParam(req.body, 'id')
      if (!id) throw new Error('automation.update requires params.id')
      return { automation: await updateAutomation(ctx.profileDir, id, req.body as Record<string, unknown>) }
    }),
  }, // Task 3 (M4)
  {
    method: 'automation.remove',
    http: 'POST',
    path: '/huaanwork/automation/remove',
    handler: storeRoute(async (req, ctx) => {
      const id = bodyParam(req.body, 'id')
      if (!id) throw new Error('automation.remove requires params.id')
      // 运行会话随任务一并删除:删日志前先释放它的运行态(与 project.remove 同一接线段)。
      await removeAutomation(ctx.profileDir, id, join(ctx.dshHome, 'sessions'), (sessionId) =>
        releaseSessionRuntime(ctx.runtimeCtx, sessionId),
      )
      return { removed: true }
    }),
  }, // Task 3 (M4)
  {
    method: 'automation.stop',
    http: 'POST',
    path: '/huaanwork/automation/stop',
    // 停止在途轮:不触碰工作区,只需 profileDir 与运行态。没有在途轮时回 stopped:false。
    handler: storeRoute(async (req) => {
      const id = bodyParam(req.body, 'id')
      if (!id) throw new Error('automation.stop requires params.id')
      return await stopAutomation(id)
    }),
  }, // Task 8
  {
    method: 'automation.deleteRun',
    http: 'POST',
    path: '/huaanwork/automation/deleteRun',
    // 删一条已结束的运行记录:删行 → 释放会话运行态 → 删对应会话目录(规格 §6)。
    // 会话目录在 dshHome/sessions,与 automation.remove 同一接线。
    handler: storeRoute(async (req, ctx) => {
      const id = bodyParam(req.body, 'id')
      if (!id) throw new Error('automation.deleteRun requires params.id')
      const runId = bodyParam(req.body, 'runId')
      if (!runId) throw new Error('automation.deleteRun requires params.runId')
      return await deleteAutomationRun(ctx.profileDir, id, runId, {
        sessionsRoot: join(ctx.dshHome, 'sessions'),
        releaseSession: (sessionId) => releaseSessionRuntime(ctx.runtimeCtx, sessionId),
      })
    }),
  }, // Task 9
  {
    method: 'automation.run',
    http: 'POST',
    path: '/huaanwork/automation/run',
    // 手动运行先热切换到任务所属目录（未归属项目则回到中立根），再入队。
    // 调度跨根仍不入队。fire-and-forget:不得 await 执行体。
    handler: workspaceRoute(async (req, ctx) => {
      assertAutomationIdle()
      if (!(await agentIdle(ctx))) throw new Error('当前对话仍在进行，请先完成或停止后再运行任务')
      const id = bodyParam(req.body, 'id')
      if (!id) throw new Error('automation.run requires params.id')
      const automation = await findAutomation(ctx.profileDir, id)
      if (automation.projectId) {
        const project = (await listProjects(ctx.profileDir)).find((item) => item.id === automation.projectId)
        if (project) await openWorkspace(ctx, project.root)
      } else {
        await closeWorkspace(ctx)
      }
      const decision = await automationRootDecision(ctx, automation)
      if (decision.kind === 'cross') throw new Error(decision.message)
      const runId = randomUUID()
      void enqueueAutomation(automation, { trigger: 'manual', runId })
      return { queued: true, runId, workspaceRoot: ctx.workspaceRoot.current }
    }),
  }, // Task 4 (M4)
  {
    method: 'automation.runs',
    http: 'GET',
    path: '/huaanwork/automation/runs',
    // 旧 host.ts:1116-1127 语义:limit 缺省/非法回 RUNS_LIMIT;status 非法忽略;
    // 全量读 RUNS_LIMIT 条再筛再截尾。
    handler: storeRoute(async (req, ctx) => {
      const id = queryParam(req, 'id')
      if (!id) throw new RouteError(400, 'store-error', 'automation.runs requires params.id')
      const limitRaw = req.query.get('limit')
      const limitParsed = limitRaw !== null ? Number(limitRaw) : NaN
      const limit = Number.isInteger(limitParsed) && limitParsed > 0 ? limitParsed : RUNS_LIMIT
      const statusRaw = queryParam(req, 'status')
      const status = statusRaw !== undefined && RUN_STATUSES.has(statusRaw) ? (statusRaw as RunSummary['status']) : undefined
      const all = await recentRuns(ctx.profileDir, id, RUNS_LIMIT)
      const filtered = status === undefined ? all : all.filter((run) => run.status === status)
      return { runs: filtered.slice(-limit) }
    }),
  }, // Task 10 (文件 I/O 读任务运行日志)
  {
    method: 'automation.pruneSessions',
    http: 'POST',
    path: '/huaanwork/automation/pruneSessions',
    // keep = collector 中的在途会话 ∪ 每任务最近 20 条 runs 的 sessionId
    // (runs 侧由 pruneAutomationSessions 并入)。会话目录在 dshHome/sessions。
    handler: storeRoute(async (_req, ctx) => {
      const removed = await pruneAutomationSessions(
        ctx.profileDir,
        new Set(automationCollector.keys()),
        join(ctx.dshHome, 'sessions'),
      )
      return { removed }
    }),
  }, // Task 4 (M4)
  { method: 'automation.templates', http: 'GET', path: '/huaanwork/automation/templates', handler: storeRoute(async () => ({ templates: await readAutomationTemplates() })) }, // Task 10 (文件 I/O 读模板文件)

  // task
  { method: 'task.list', http: 'GET', path: '/huaanwork/task/list', handler: storeRoute(async (req, ctx) => ({ tasks: await listTasks(ctx.profileDir, queryParam(req, 'projectId')) })) }, // Task 10 (文件 I/O 读 tasks.json)
  {
    method: 'task.create',
    http: 'POST',
    path: '/huaanwork/task/create',
    handler: storeRoute(async (req, ctx) => {
      const projectId = bodyParam(req.body, 'projectId')
      const name = bodyParam(req.body, 'name')
      if (!projectId) throw new Error('task.create requires params.projectId')
      if (!name) throw new Error('task.create requires params.name')
      const projects = await listProjects(ctx.profileDir)
      if (!projects.some((project) => project.id === projectId)) {
        throw new Error(`project ${projectId} was not found`)
      }
      return { task: await createTask(ctx.profileDir, { projectId, name }) }
    }),
  }, // Task 10
  {
    method: 'task.remove',
    http: 'POST',
    path: '/huaanwork/task/remove',
    // 旧 host.ts:1148-1155 语义:级联——删子任务即删其对话历史(规格 §1.4)。
    handler: storeRoute(async (req, ctx) => {
      const id = bodyParam(req.body, 'id')
      if (!id) throw new Error('task.remove requires params.id')
      const removedTask = await removeTask(ctx.profileDir, id)
      if (removedTask.sessionId) {
        releaseSessionRuntime(ctx.runtimeCtx, removedTask.sessionId)
        await removeSessionFilesById(join(ctx.dshHome, 'sessions'), [removedTask.sessionId])
      }
      return { removed: true }
    }),
  }, // Task 10
  {
    method: 'task.bindSession',
    http: 'POST',
    path: '/huaanwork/task/bindSession',
    handler: storeRoute(async (req, ctx) => {
      const taskId = bodyParam(req.body, 'taskId')
      const sessionId = bodyParam(req.body, 'sessionId')
      if (!taskId) throw new Error('task.bindSession requires params.taskId')
      if (!sessionId) throw new Error('task.bindSession requires params.sessionId')
      return { task: await bindTaskSession(ctx.profileDir, { taskId, sessionId }) }
    }),
  }, // Task 10
  {
    method: 'task.rename',
    http: 'POST',
    path: '/huaanwork/task/rename',
    handler: storeRoute(async (req, ctx) => {
      const taskId = bodyParam(req.body, 'taskId')
      const name = bodyParam(req.body, 'name')
      if (!taskId) throw new Error('task.rename requires params.taskId')
      if (!name) throw new Error('task.rename requires params.name')
      return { task: await renameTask(ctx.profileDir, { taskId, name }) }
    }),
  }, // Task 10
]

export const NATIVE_ROUTES: readonly NativeRouteEntry[] = [
  {
    http: 'GET',
    path: '/huaanwork/git/has-git',
    handler: async (req) => {
      const root = req.query.get('root') ?? ''
      return hasGit(root)
    },
  },
  {
    http: 'GET',
    path: '/huaanwork/git/tree',
    handler: async (req) => {
      const root = req.query.get('root') ?? ''
      const depthParam = req.query.get('depth')
      const depth = depthParam !== null ? parseInt(depthParam, 10) : 2
      return listTree(root, Number.isNaN(depth) ? 2 : depth)
    },
  },
]

const MAX_BODY_BYTES = 1024 * 1024 // 1 MiB

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } })
}

/**
 * 读取 JSON 请求体:上限 1 MiB,超限(声明长度/流式)先 `req.resume()` drain 再抛
 * 413;JSON 不可解析抛 400 bad-request。keep-awake-route 等 54 表外路由复用
 * (M4 评审 C1:body 处理只此一份,上限与 drain 语义随之统一)。
 */
export async function readJsonBody(
  req: IncomingMessage,
): Promise<unknown> {
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength)) {
      throw new RouteError(400, 'bad-request', 'Invalid Content-Length')
    }
    if (Number(declaredLength) > MAX_BODY_BYTES) {
      req.resume()
      throw new RouteError(413, 'payload-too-large', 'Payload Too Large')
    }
  }

  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      throw new RouteError(413, 'payload-too-large', 'Payload Too Large')
    }
    chunks.push(buffer)
  }

  if (chunks.length === 0) return undefined
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw.length === 0) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new RouteError(400, 'bad-request', 'Invalid JSON')
  }
}

export async function handleHuaanworkRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  expectedOrigin: string | (() => string) = () => 'http://127.0.0.1',
): Promise<void> {
  // [::1] 等回环形式由 expectedLoopbackOrigin 放行,不再经 Host 头推导
  const origin = typeof expectedOrigin === 'function' ? expectedOrigin() : expectedOrigin
  const isMutating = req.method !== 'GET' && req.method !== 'HEAD'
  if (!isSameOriginLoopbackRequest(req, origin, isMutating)) {
    sendError(res, 403, 'forbidden', 'Forbidden')
    return
  }

  const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
  const pathname = parsedUrl.pathname
  const query = parsedUrl.searchParams

  let body: unknown
  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      body = await readJsonBody(req)
    } catch (err) {
      if (err instanceof RouteError) {
        sendError(res, err.status, err.code, err.message)
        return
      }
      throw err
    }
  }

  const matched = ROUTE_TABLE.find((entry) => entry.http === req.method && entry.path === pathname)
    ?? NATIVE_ROUTES.find((entry) => entry.http === req.method && entry.path === pathname)

  if (matched === undefined) {
    sendError(res, 404, 'not-found', 'Not Found')
    return
  }

  try {
    const result = await matched.handler({ params: {}, body, query }, ctx)
    sendJson(res, 200, result)
  } catch (err) {
    if (err instanceof RouteError) {
      sendError(res, err.status, err.code, err.message)
    } else {
      ctx.logger(`Internal error handling ${req.method ?? ''} ${pathname}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
      sendError(res, 500, 'internal', 'Internal Server Error')
    }
  }
}

export function registerHuaanworkRoutes(ctx: Context, routeCtx: RouteContext): () => void {
  const expectedOrigin = () => `http://127.0.0.1:${ctx.webServer.port}`
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/huaanwork',
    handler: (req, res) => void handleHuaanworkRequest(req, res, routeCtx, expectedOrigin),
  })
}
