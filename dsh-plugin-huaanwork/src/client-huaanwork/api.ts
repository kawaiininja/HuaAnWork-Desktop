import type { RpcEvent } from './rpc-types.ts'
export type { RpcEvent }

export type TreeNode = { name: string; path: string; isDir: boolean; children?: TreeNode[] }

const REQUEST_TIMEOUT_MS = 180_000 // 平移旧 sidecar.rs:102 的 RPC 超时

const DIRECTORY_PICKER_PATH = '/_dsh/desktop/pick-directory'

// —— 54 方法 → route 映射(与 huaanwork-host/routes.ts 的 ROUTE_TABLE 互为唯一事实源)——
// Task 4 的 GET route 均不取 query 参数,故 path 为常量;写类 route body 透传 params。
type RouteHttp = 'GET' | 'POST' | 'PUT'
interface RouteDef {
  http: RouteHttp
  path: string
  body?: (params?: unknown) => unknown
}

const post = (path: string): RouteDef => ({ http: 'POST', path, body: (params) => params })
const get = (path: string): RouteDef => ({ http: 'GET', path })

export const ROUTES: Record<string, RouteDef> = {
  // workspace
  'workspace.open': post('/huaanwork/workspace/open'),
  'workspace.close': post('/huaanwork/workspace/close'),

  // session
  'session.send': post('/huaanwork/session/send'),
  'session.cancel': post('/huaanwork/session/cancel'),
  'session.approve': post('/huaanwork/session/approve'),
  'session.reject': post('/huaanwork/session/reject'),
  'session.list': get('/huaanwork/session/list'),
  'session.open': post('/huaanwork/session/open'),
  'session.remove': post('/huaanwork/session/remove'),
  'session.new': post('/huaanwork/session/new'),
  'session.resume': post('/huaanwork/session/resume'),

  // settings
  'settings.get': get('/huaanwork/settings'),
  'settings.set': { http: 'PUT', path: '/huaanwork/settings', body: (params) => params },

  // auth
  'auth.status': post('/huaanwork/auth/status'),
  'auth.register': post('/huaanwork/auth/register'),
  'auth.login': post('/huaanwork/auth/login'),
  'auth.logout': post('/huaanwork/auth/logout'),
  'auth.changePassword': post('/huaanwork/auth/changePassword'),

  // plugin
  'plugin.add': post('/huaanwork/plugin/add'),
  'plugin.remove': post('/huaanwork/plugin/remove'),
  'plugin.list': get('/huaanwork/plugin/list'),

  // skill
  'skill.list': get('/huaanwork/skill/list'),
  'skill.get': get('/huaanwork/skill/get'),
  'skill.create': post('/huaanwork/skill/create'),
  'skill.update': post('/huaanwork/skill/update'),
  'skill.remove': post('/huaanwork/skill/remove'),
  'skill.importPreview': post('/huaanwork/skill/importPreview'),
  'skill.import': post('/huaanwork/skill/import'),
  'skill.setEnabled': post('/huaanwork/skill/setEnabled'),

  // agent
  'agent.list': get('/huaanwork/agent/list'),
  'agent.get': get('/huaanwork/agent/get'),
  'agent.refresh': post('/huaanwork/agent/refresh'),
  'agent.setEnabled': post('/huaanwork/agent/setEnabled'),
  'agent.addEndpoint': post('/huaanwork/agent/addEndpoint'),
  'agent.removeEndpoint': post('/huaanwork/agent/removeEndpoint'),

  // status
  'status.get': get('/huaanwork/status'),

  // project
  'project.list': get('/huaanwork/project/list'),
  'project.create': post('/huaanwork/project/create'),
  'project.open': post('/huaanwork/project/open'),
  'project.remove': post('/huaanwork/project/remove'),
  'project.rename': post('/huaanwork/project/rename'),

  // automation
  'automation.list': get('/huaanwork/automation/list'),
  'automation.create': post('/huaanwork/automation/create'),
  'automation.update': post('/huaanwork/automation/update'),
  'automation.remove': post('/huaanwork/automation/remove'),
  'automation.run': post('/huaanwork/automation/run'),
  'automation.runs': get('/huaanwork/automation/runs'),
  'automation.pruneSessions': post('/huaanwork/automation/pruneSessions'),
  'automation.templates': get('/huaanwork/automation/templates'),

  // task
  'task.list': get('/huaanwork/task/list'),
  'task.create': post('/huaanwork/task/create'),
  'task.remove': post('/huaanwork/task/remove'),
  'task.bindSession': post('/huaanwork/task/bindSession'),
  'task.rename': post('/huaanwork/task/rename'),
}

interface ErrorEnvelope { error?: { code?: string; message?: string } }

export async function rpcCall<T>(method: string, params?: unknown): Promise<T> {
  const route = ROUTES[method]
  if (!route) throw new Error(`unknown method: ${method}`)
  let response: Response
  try {
    response = await fetch(route.path, {
      method: route.http,
      headers: route.body ? { 'content-type': 'application/json' } : undefined,
      body: route.body ? JSON.stringify(route.body(params) ?? null) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    const name = (err as { name?: string } | null)?.name
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new Error(`请求超时(${REQUEST_TIMEOUT_MS / 1000}s)`)
    }
    throw err
  }
  const payload = await response.json().catch(() => undefined) as ErrorEnvelope | undefined
  if (!response.ok) {
    const message = payload?.error?.message ?? `HTTP ${response.status}`
    const error = new Error(message) as Error & { code?: string }
    error.code = payload?.error?.code
    throw error
  }
  return payload as T
}

// —— 事件客户端:模块级共享单 socket,指数退避 1 s → 30 s ——
const eventHandlers = new Set<(event: RpcEvent) => void>()
const exitHandlers = new Set<(state: { ready: boolean }) => void>()
let socket: WebSocket | undefined
let retryMs = 1000

function ensureSocket(): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return
  socket = new WebSocket(`ws://${location.host}/huaanwork/events`)
  socket.onopen = () => {
    retryMs = 1000
    for (const handler of eventHandlers) handler({ event: 'sidecar/status', ready: true })
  }
  socket.onmessage = (message) => {
    const event = JSON.parse(String(message.data)) as RpcEvent
    for (const handler of eventHandlers) handler(event)
  }
  socket.onclose = () => {
    socket = undefined
    for (const handler of exitHandlers) handler({ ready: false })
    if (eventHandlers.size > 0) setTimeout(ensureSocket, retryMs)
    retryMs = Math.min(retryMs * 2, 30_000)
  }
}

export async function onSidecarEvent(handler: (event: RpcEvent) => void): Promise<() => void> {
  eventHandlers.add(handler)
  ensureSocket()
  return () => { eventHandlers.delete(handler) }
}

export async function onSidecarExit(handler: (state: { ready: boolean }) => void): Promise<() => void> {
  exitHandlers.add(handler)
  return () => { exitHandlers.delete(handler) }
}

// —— 原生桥(与 M2 同签名)——
export async function hasGit(root: string): Promise<boolean> {
  const response = await fetch(`/huaanwork/git/has-git?root=${encodeURIComponent(root)}`, { method: 'GET' })
  if (!response.ok) return false
  return Boolean(await response.json().catch(() => false))
}

export async function listTree(root: string, depth = 2): Promise<TreeNode[]> {
  const response = await fetch(`/huaanwork/git/tree?root=${encodeURIComponent(root)}&depth=${depth}`, { method: 'GET' })
  if (!response.ok) return []
  return (await response.json().catch(() => [])) as TreeNode[]
}

export async function setKeepAwake(_hold: boolean): Promise<boolean> {
  // M3 未注册 keep-awake route,诚实降级为 false(不发起请求);技术债见 Task 10 Step 5。
  return false
}

export async function pickDirectory(): Promise<string | null> {
  // 取消与非 2xx(如 macOS 上 route 未注册时 frontend-static fallback 的 405)同语义:resolve null。
  const response = await fetch(DIRECTORY_PICKER_PATH, { method: 'POST' })
  if (!response.ok) return null
  const payload = (await response.json().catch(() => undefined)) as { path?: unknown } | undefined
  return typeof payload?.path === 'string' ? payload.path : null
}

export function notifyRunFailed(title: string, body: string): void {
  try {
    new Notification(title, { body })
  } catch {
    // 静默降级
  }
}
