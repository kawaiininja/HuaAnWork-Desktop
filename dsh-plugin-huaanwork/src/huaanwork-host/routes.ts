import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { RpcEvent } from '../client-huaanwork/rpc-types.ts'
import { isSameOriginLoopbackRequest } from './loopback.ts'
import { hasGit, listTree } from './native.ts'
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
  // workspace
  { method: 'workspace.open', http: 'POST', path: '/huaanwork/workspace/open', handler: notImplemented('workspace.open') }, // Task 9
  { method: 'workspace.close', http: 'POST', path: '/huaanwork/workspace/close', handler: notImplemented('workspace.close') }, // Task 9

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
  { method: 'plugin.add', http: 'POST', path: '/huaanwork/plugin/add', handler: notImplemented('plugin.add') }, // Task 10
  { method: 'plugin.remove', http: 'POST', path: '/huaanwork/plugin/remove', handler: notImplemented('plugin.remove') }, // Task 10
  { method: 'plugin.list', http: 'GET', path: '/huaanwork/plugin/list', handler: notImplemented('plugin.list') }, // Task 10

  // skill
  { method: 'skill.list', http: 'GET', path: '/huaanwork/skill/list', handler: notImplemented('skill.list') }, // Task 10
  { method: 'skill.get', http: 'GET', path: '/huaanwork/skill/get', handler: notImplemented('skill.get') }, // Task 10
  { method: 'skill.create', http: 'POST', path: '/huaanwork/skill/create', handler: notImplemented('skill.create') }, // Task 10
  { method: 'skill.update', http: 'POST', path: '/huaanwork/skill/update', handler: notImplemented('skill.update') }, // Task 10
  { method: 'skill.remove', http: 'POST', path: '/huaanwork/skill/remove', handler: notImplemented('skill.remove') }, // Task 10
  { method: 'skill.importPreview', http: 'POST', path: '/huaanwork/skill/importPreview', handler: notImplemented('skill.importPreview') }, // Task 10
  { method: 'skill.import', http: 'POST', path: '/huaanwork/skill/import', handler: notImplemented('skill.import') }, // Task 10
  { method: 'skill.setEnabled', http: 'POST', path: '/huaanwork/skill/setEnabled', handler: notImplemented('skill.setEnabled') }, // Task 10

  // agent
  { method: 'agent.list', http: 'GET', path: '/huaanwork/agent/list', handler: notImplemented('agent.list') }, // Task 10
  { method: 'agent.get', http: 'GET', path: '/huaanwork/agent/get', handler: notImplemented('agent.get') }, // Task 10
  { method: 'agent.refresh', http: 'POST', path: '/huaanwork/agent/refresh', handler: notImplemented('agent.refresh') }, // Task 10
  { method: 'agent.setEnabled', http: 'POST', path: '/huaanwork/agent/setEnabled', handler: notImplemented('agent.setEnabled') }, // Task 10
  { method: 'agent.addEndpoint', http: 'POST', path: '/huaanwork/agent/addEndpoint', handler: notImplemented('agent.addEndpoint') }, // Task 10
  { method: 'agent.removeEndpoint', http: 'POST', path: '/huaanwork/agent/removeEndpoint', handler: notImplemented('agent.removeEndpoint') }, // Task 10

  // status
  { method: 'status.get', http: 'GET', path: '/huaanwork/status', handler: async () => ({ ready: true }) }, // Task 4

  // project
  { method: 'project.list', http: 'GET', path: '/huaanwork/project/list', handler: notImplemented('project.list') }, // Task 10
  { method: 'project.create', http: 'POST', path: '/huaanwork/project/create', handler: notImplemented('project.create') }, // Task 10
  { method: 'project.open', http: 'POST', path: '/huaanwork/project/open', handler: notImplemented('project.open') }, // Task 10
  { method: 'project.remove', http: 'POST', path: '/huaanwork/project/remove', handler: notImplemented('project.remove') }, // Task 10
  { method: 'project.rename', http: 'POST', path: '/huaanwork/project/rename', handler: notImplemented('project.rename') }, // Task 10

  // automation
  { method: 'automation.list', http: 'GET', path: '/huaanwork/automation/list', handler: notImplemented('automation.list') }, // Task 10
  { method: 'automation.create', http: 'POST', path: '/huaanwork/automation/create', handler: notImplemented('automation.create') }, // Task 10
  { method: 'automation.update', http: 'POST', path: '/huaanwork/automation/update', handler: notImplemented('automation.update') }, // Task 10
  { method: 'automation.remove', http: 'POST', path: '/huaanwork/automation/remove', handler: notImplemented('automation.remove') }, // Task 10
  { method: 'automation.run', http: 'POST', path: '/huaanwork/automation/run', handler: notImplemented('automation.run') }, // Task 10
  { method: 'automation.runs', http: 'GET', path: '/huaanwork/automation/runs', handler: notImplemented('automation.runs') }, // Task 10
  { method: 'automation.pruneSessions', http: 'POST', path: '/huaanwork/automation/pruneSessions', handler: notImplemented('automation.pruneSessions') }, // Task 10
  { method: 'automation.templates', http: 'GET', path: '/huaanwork/automation/templates', handler: notImplemented('automation.templates') }, // Task 10

  // task
  { method: 'task.list', http: 'GET', path: '/huaanwork/task/list', handler: notImplemented('task.list') }, // Task 10
  { method: 'task.create', http: 'POST', path: '/huaanwork/task/create', handler: notImplemented('task.create') }, // Task 10
  { method: 'task.remove', http: 'POST', path: '/huaanwork/task/remove', handler: notImplemented('task.remove') }, // Task 10
  { method: 'task.bindSession', http: 'POST', path: '/huaanwork/task/bindSession', handler: notImplemented('task.bindSession') }, // Task 10
  { method: 'task.rename', http: 'POST', path: '/huaanwork/task/rename', handler: notImplemented('task.rename') }, // Task 10
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
