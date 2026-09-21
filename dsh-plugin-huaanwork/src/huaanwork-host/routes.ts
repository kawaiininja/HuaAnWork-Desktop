import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AgentSource, RpcEvent, RunSummary } from '../client-huaanwork/rpc-types.ts'
import { isSameOriginLoopbackRequest } from './loopback.ts'
import { hasGit, listTree } from './native.ts'
import { listPlugins } from './plugins-host.ts'
import { getAgentsDirectory } from './sessions.ts'
import { removeSessionFilesById } from './session-sweep.ts'
import {
  listUserSkills,
  listExternalSkills,
  getSkill,
  type SkillSourceFilter,
} from './skills-host.ts'
import { listBundledSkills, readSkillToggles, SYSTEM_SKILLS } from '../huaanwork-guardrails/skills.ts'
import {
  RUNS_LIMIT,
  RUN_STATUSES,
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
  sessionAnswerApproval,
  sessionCancel,
  sessionList,
  sessionNew,
  sessionOpen,
  sessionRemove,
  sessionResume,
  sessionSend,
  type SessionRuntimeContext,
} from './sessions.ts'
import { closeWorkspace, openWorkspace } from './workspace.ts'

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
  /** workspace.open/close 的 generation 重启注入(index.ts 以 desktopRuntime.requestRestart 提供)。 */
  requestRestart(): Promise<void>
  expectedOrigin?: string
}

export type RouteHandler = (req: RouteRequest, ctx: RouteContext) => Promise<unknown>

export class RouteError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = 'RouteError'
  }
}

export const routeKey = (http: string, path: string): string => `${http} ${path}`

const notImplemented = (method: string): RouteHandler => async () => {
  throw new RouteError(501, 'not-implemented', `M4 接入:${method}`)
}

/**
 * session 域错误映射:旧 sidecar 的 RPC 错误面把用户可读消息(跨工作区拒绝、
 * 网络门禁文案、not found 等)直传前端;新 HTTP 面对非 RouteError 只回 500 通用
 * 文案、消息不可达。这里把 session 域的 Error 映射为 400 + 原文,保留旧语义;
 * 非 Error 抛出仍走 500 + 服务端日志。
 */
const sessionRoute = (fn: (req: RouteRequest, ctx: RouteContext) => unknown): RouteHandler => {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx)
    } catch (err) {
      if (err instanceof RouteError) throw err
      if (err instanceof Error) throw new RouteError(400, 'session-error', err.message)
      throw err
    }
  }
}

const requireRuntime = (ctx: RouteContext): SessionRuntimeContext => {
  if (!ctx.runtimeCtx) {
    throw new RouteError(503, 'runtime-unavailable', 'host runtime context is not available')
  }
  return ctx.runtimeCtx
}

/**
 * workspace 域错误映射:与 sessionRoute 同理由——非 RouteError 的 Error(如
 * assertAutomationIdle 的「后台自动化任务运行中」)必须带着原文到客户端,
 * 否则 HTTP 面只回 500 通用文案,旧 sidecar 的用户可读错误面丢失。
 */
const workspaceRoute = (fn: (req: RouteRequest, ctx: RouteContext) => unknown): RouteHandler => {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx)
    } catch (err) {
      if (err instanceof RouteError) throw err
      if (err instanceof Error) throw new RouteError(400, 'workspace-error', err.message)
      throw err
    }
  }
}

/**
 * M4 域(项目/任务/自动化/技能/插件/智能体)错误映射:与 sessionRoute 同理——
 * 旧 RPC 面把用户可读消息(not found、校验文案等)直传前端;非 RouteError 的
 * Error 映射为 400 + 原文,保留旧语义。
 */
const storeRoute = (fn: (req: RouteRequest, ctx: RouteContext) => unknown): RouteHandler => {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx)
    } catch (err) {
      if (err instanceof RouteError) throw err
      if (err instanceof Error) throw new RouteError(400, 'store-error', err.message)
      throw err
    }
  }
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
  // workspace(Task 9:写 pendingRoot → generation 重启;重启期连接中断,客户端 waitForReady 承接;
  // 已在目标根短路返回 { workspaceRoot },旧 host.ts:1013-1023 语义)
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
  { method: 'session.list', http: 'GET', path: '/huaanwork/session/list', handler: async (req, ctx) => sessionList(ctx, req.query.get('root') ?? undefined) }, // Task 7
  { method: 'session.open', http: 'POST', path: '/huaanwork/session/open', handler: sessionRoute(async (req, ctx) => sessionOpen(ctx, req.body)) }, // Task 7
  { method: 'session.remove', http: 'POST', path: '/huaanwork/session/remove', handler: sessionRoute(async (req, ctx) => sessionRemove(ctx, req.body)) }, // Task 7
  { method: 'session.new', http: 'POST', path: '/huaanwork/session/new', handler: async (req, ctx) => sessionNew(ctx, req.body) }, // Task 7
  { method: 'session.resume', http: 'POST', path: '/huaanwork/session/resume', handler: sessionRoute(async (req, ctx) => sessionResume(requireRuntime(ctx), ctx, req.body)) }, // Task 7

  // settings
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

  // auth
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
  { method: 'plugin.add', http: 'POST', path: '/huaanwork/plugin/add', handler: notImplemented('plugin.add') }, // M4
  { method: 'plugin.remove', http: 'POST', path: '/huaanwork/plugin/remove', handler: notImplemented('plugin.remove') }, // M4
  { method: 'plugin.list', http: 'GET', path: '/huaanwork/plugin/list', handler: async (_req, ctx) => listPlugins(ctx.profileDir) }, // Task 10

  // skill
  {
    method: 'skill.list',
    http: 'GET',
    path: '/huaanwork/skill/list',
    handler: async (_req, ctx) => {
      // 旧 host.ts:1182-1195 语义:toggles 只作用于内置技能,三源合并全局按名排序、同名不去重。
      const toggles = readSkillToggles(ctx.profileDir)
      const bundled = listBundledSkills().map((skill) => ({
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
    },
  }, // Task 10
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
  { method: 'skill.create', http: 'POST', path: '/huaanwork/skill/create', handler: notImplemented('skill.create') }, // M4
  { method: 'skill.update', http: 'POST', path: '/huaanwork/skill/update', handler: notImplemented('skill.update') }, // M4
  { method: 'skill.remove', http: 'POST', path: '/huaanwork/skill/remove', handler: notImplemented('skill.remove') }, // M4
  { method: 'skill.importPreview', http: 'POST', path: '/huaanwork/skill/importPreview', handler: notImplemented('skill.importPreview') }, // M4
  { method: 'skill.import', http: 'POST', path: '/huaanwork/skill/import', handler: notImplemented('skill.import') }, // M4
  { method: 'skill.setEnabled', http: 'POST', path: '/huaanwork/skill/setEnabled', handler: notImplemented('skill.setEnabled') }, // M4

  // agent
  { method: 'agent.list', http: 'GET', path: '/huaanwork/agent/list', handler: async () => getAgentsDirectory().list() }, // Task 10
  { method: 'agent.get', http: 'GET', path: '/huaanwork/agent/get', handler: storeRoute(async (req) => {
    const name = queryParam(req, 'name')
    if (!name) throw new Error('agent.get requires params.name')
    const source = queryParam(req, 'source') as AgentSource | undefined
    // 旧 RPC 面 undefined 序列化为 null;HTTP JSON 面显式落 null(空 body 无法解析)。
    return (await getAgentsDirectory().get(name, source)) ?? null
  }) }, // Task 10
  { method: 'agent.refresh', http: 'POST', path: '/huaanwork/agent/refresh', handler: async () => getAgentsDirectory().refresh() }, // Task 10
  { method: 'agent.setEnabled', http: 'POST', path: '/huaanwork/agent/setEnabled', handler: notImplemented('agent.setEnabled') }, // M4
  { method: 'agent.addEndpoint', http: 'POST', path: '/huaanwork/agent/addEndpoint', handler: notImplemented('agent.addEndpoint') }, // M4
  { method: 'agent.removeEndpoint', http: 'POST', path: '/huaanwork/agent/removeEndpoint', handler: notImplemented('agent.removeEndpoint') }, // M4

  // status
  { method: 'status.get', http: 'GET', path: '/huaanwork/status', handler: async () => ({ ready: true }) }, // Task 4

  // project
  { method: 'project.list', http: 'GET', path: '/huaanwork/project/list', handler: async (_req, ctx) => ({ projects: await listProjects(ctx.profileDir) }) }, // Task 10
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
    // 旧 host.ts:1033-1042 语义:assertAutomationIdle(openWorkspace 内)→ 查项目 →
    // 切工作区 → touchProject 排序戳。真重启路径 fetch 必然中断,客户端按重启承接。
    handler: workspaceRoute(async (req, ctx) => {
      const projectId = bodyParam(req.body, 'projectId')
      if (!projectId) throw new Error('project.open requires params.projectId')
      const project = (await listProjects(ctx.profileDir)).find((item) => item.id === projectId)
      if (!project) throw new Error(`project ${projectId} was not found`)
      const result = await openWorkspace(ctx, project.root)
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
      await removeAutomationsOfProject(ctx.profileDir, projectId, join(ctx.dshHome, 'sessions'))
      const cascadedSessionIds = await removeTasksOfProject(ctx.profileDir, projectId)
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

  // automation(读路径真实;写路径 create/update/remove/run/pruneSessions 牵动调度器,M4)
  {
    method: 'automation.list',
    http: 'GET',
    path: '/huaanwork/automation/list',
    // 旧 host.ts:1060-1075 语义:list 带最近 5 条运行,missed 汇总从全量(RUNS_LIMIT)筛,
    // 避免 missed 被「最近 5 条」窗口悄悄截掉。
    handler: async (req, ctx) => {
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
    },
  }, // Task 10
  { method: 'automation.create', http: 'POST', path: '/huaanwork/automation/create', handler: notImplemented('automation.create') }, // M4
  { method: 'automation.update', http: 'POST', path: '/huaanwork/automation/update', handler: notImplemented('automation.update') }, // M4
  { method: 'automation.remove', http: 'POST', path: '/huaanwork/automation/remove', handler: notImplemented('automation.remove') }, // M4
  { method: 'automation.run', http: 'POST', path: '/huaanwork/automation/run', handler: notImplemented('automation.run') }, // M4
  {
    method: 'automation.runs',
    http: 'GET',
    path: '/huaanwork/automation/runs',
    // 旧 host.ts:1116-1127 语义:limit 缺省/非法回 RUNS_LIMIT;status 非法忽略;
    // 全量读 RUNS_LIMIT 条再筛再截尾。
    handler: async (req, ctx) => {
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
    },
  }, // Task 10
  { method: 'automation.pruneSessions', http: 'POST', path: '/huaanwork/automation/pruneSessions', handler: notImplemented('automation.pruneSessions') }, // M4
  { method: 'automation.templates', http: 'GET', path: '/huaanwork/automation/templates', handler: async () => ({ templates: await readAutomationTemplates() }) }, // Task 10

  // task
  { method: 'task.list', http: 'GET', path: '/huaanwork/task/list', handler: async (req, ctx) => ({ tasks: await listTasks(ctx.profileDir, queryParam(req, 'projectId')) }) }, // Task 10
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

async function readJsonBody(
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
): Promise<void> {
  const expectedOrigin = ctx.expectedOrigin ?? (req.headers.host ? `http://${req.headers.host}` : 'http://127.0.0.1')
  const isMutating = req.method !== 'GET' && req.method !== 'HEAD'
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, isMutating)) {
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
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/huaanwork',
    handler: (req, res) => void handleHuaanworkRequest(req, res, routeCtx),
  })
}
