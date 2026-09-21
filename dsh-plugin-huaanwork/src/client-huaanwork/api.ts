import type { RpcEvent } from './rpc-types.ts'
export type { RpcEvent }

export type TreeNode = { name: string; path: string; isDir: boolean; children?: TreeNode[] }

const REQUEST_TIMEOUT_MS = 180_000 // 平移旧 sidecar.rs:102 的 RPC 超时

const DIRECTORY_PICKER_PATH = '/_dsh/desktop/pick-directory'

// —— 54 方法 → route 映射(与 huaanwork-host/routes.ts 的 ROUTE_TABLE 互为唯一事实源)——
// Task 4 的 GET route 均不取 query 参数,故 path 为常量;写类 route body 透传 params。
// Task 10 起 GET 类 route 定义 query contract:params 对象的键值编码为 query string
// (undefined 值跳过;空对象 → 无 query,path 不变)。服务端 routes.ts 同名参数直读。
type RouteHttp = 'GET' | 'POST' | 'PUT'
interface RouteDef {
  http: RouteHttp
  path: string
  body?: (params?: unknown) => unknown
  query?: (params?: unknown) => string
}

const post = (path: string): RouteDef => ({ http: 'POST', path, body: (params) => params })
const get = (path: string, query?: (params?: unknown) => string): RouteDef => ({ http: 'GET', path, query })

/** params 对象 → query string;非对象/空对象返回 ''。 */
function objectQuery(params?: unknown): string {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value === undefined || value === null) continue
    search.set(key, String(value))
  }
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ''
}

export const ROUTES: Record<string, RouteDef> = {
  // workspace
  'workspace.open': post('/huaanwork/workspace/open'),
  'workspace.close': post('/huaanwork/workspace/close'),

  // session
  'session.send': post('/huaanwork/session/send'),
  'session.cancel': post('/huaanwork/session/cancel'),
  'session.approve': post('/huaanwork/session/approve'),
  'session.reject': post('/huaanwork/session/reject'),
  'session.list': get('/huaanwork/session/list', objectQuery),
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
  'skill.get': get('/huaanwork/skill/get', objectQuery),
  'skill.create': post('/huaanwork/skill/create'),
  'skill.update': post('/huaanwork/skill/update'),
  'skill.remove': post('/huaanwork/skill/remove'),
  'skill.importPreview': post('/huaanwork/skill/importPreview'),
  'skill.import': post('/huaanwork/skill/import'),
  'skill.setEnabled': post('/huaanwork/skill/setEnabled'),

  // agent
  'agent.list': get('/huaanwork/agent/list'),
  'agent.get': get('/huaanwork/agent/get', objectQuery),
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
  'automation.list': get('/huaanwork/automation/list', objectQuery),
  'automation.create': post('/huaanwork/automation/create'),
  'automation.update': post('/huaanwork/automation/update'),
  'automation.remove': post('/huaanwork/automation/remove'),
  'automation.run': post('/huaanwork/automation/run'),
  'automation.runs': get('/huaanwork/automation/runs', objectQuery),
  'automation.pruneSessions': post('/huaanwork/automation/pruneSessions'),
  'automation.templates': get('/huaanwork/automation/templates'),

  // task
  'task.list': get('/huaanwork/task/list', objectQuery),
  'task.create': post('/huaanwork/task/create'),
  'task.remove': post('/huaanwork/task/remove'),
  'task.bindSession': post('/huaanwork/task/bindSession'),
  'task.rename': post('/huaanwork/task/rename'),
}

interface ErrorEnvelope { error?: { code?: string; message?: string } }

// —— workspace.open/close 的 generation 重启语义 ——
// 两方法会触发整代重启:fetch 撞上 webServer 关闭(连接 reset),不可能收到 HTTP 应答。
// 客户端特例:网络错误(非超时)→ 轮询 /huaanwork/status 至 200 → 按 { restarting: true } resolve,
// 与旧 sidecar 的 re-boot 等待等价;onSidecarExit 已驱动 UI 的「切换中」态。
const RESTART_METHODS = new Set(['workspace.open', 'workspace.close'])
const READY_POLL_INTERVAL_MS = 500

/** 轮询 GET /huaanwork/status 至 200 或超时;generation 重启后的就绪等待。 */
export async function waitForReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(ROUTES['status.get'].path, { method: 'GET' })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (err) {
      lastError = err
    }
    await new Promise((done) => setTimeout(done, READY_POLL_INTERVAL_MS))
  }
  throw new Error(
    `等待服务重启超时(${timeoutMs / 1000}s):${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

export async function rpcCall<T>(method: string, params?: unknown): Promise<T> {
  const route = ROUTES[method]
  if (!route) throw new Error(`unknown method: ${method}`)
  let response: Response
  try {
    const queryString = route.query ? route.query(params) : ''
    response = await fetch(route.path + queryString, {
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
    if (RESTART_METHODS.has(method)) {
      // generation 重启:连接中断是预期路径,等服务就绪后按重启语义 resolve。
      await waitForReady()
      return { restarting: true } as T
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
