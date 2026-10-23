import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ROUTES, hasGit, listTree, onSidecarEvent, onSidecarExit, pickDirectory, rpcCall, setKeepAwake, waitForReady } from '../../src/client-huaanwork/api.ts'

// —— 最小 fake fetch / WebSocket:记录调用,可编程应答与事件 ——
class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((message: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  emitFrame(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) })
  }

  closeFrame(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }
}

let fetchMock: ReturnType<typeof vi.fn>

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

/** 最近一次 fetch 调用的 (url, init)。 */
function lastFetchCall(): { url: string; init: RequestInit } {
  const calls = fetchMock.mock.calls
  const call = calls[calls.length - 1]
  return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit }
}

const unsubs: Array<() => void> = []

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('location', { host: '127.0.0.1:8000' })
  FakeWebSocket.instances = []
})

afterEach(() => {
  while (unsubs.length > 0) unsubs.pop()?.()
  // 先退订 handler 再关 socket,避免 onclose 调度重连。
  for (const instance of FakeWebSocket.instances) {
    if (instance.readyState <= FakeWebSocket.OPEN) instance.closeFrame()
  }
  FakeWebSocket.instances = []
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// —— 与 huaanwork-host/routes.ts ROUTE_TABLE 一一对应的期望表(62 项)——
const EXPECTED_ROUTES: Record<string, { http: string; path: string }> = {
  'workspace.open': { http: 'POST', path: '/huaanwork/workspace/open' },
  'workspace.close': { http: 'POST', path: '/huaanwork/workspace/close' },
  'session.send': { http: 'POST', path: '/huaanwork/session/send' },
  'session.cancel': { http: 'POST', path: '/huaanwork/session/cancel' },
  'session.approve': { http: 'POST', path: '/huaanwork/session/approve' },
  'session.reject': { http: 'POST', path: '/huaanwork/session/reject' },
  'session.exitPlanMode': { http: 'POST', path: '/huaanwork/session/exitPlanMode' },
  'session.answerInput': { http: 'POST', path: '/huaanwork/session/answerInput' },
  'session.list': { http: 'GET', path: '/huaanwork/session/list' },
  'session.open': { http: 'POST', path: '/huaanwork/session/open' },
  'session.remove': { http: 'POST', path: '/huaanwork/session/remove' },
  'session.new': { http: 'POST', path: '/huaanwork/session/new' },
  'session.resume': { http: 'POST', path: '/huaanwork/session/resume' },
  'settings.get': { http: 'GET', path: '/huaanwork/settings' },
  'settings.set': { http: 'PUT', path: '/huaanwork/settings' },
  'auth.status': { http: 'POST', path: '/huaanwork/auth/status' },
  'auth.register': { http: 'POST', path: '/huaanwork/auth/register' },
  'auth.login': { http: 'POST', path: '/huaanwork/auth/login' },
  'auth.logout': { http: 'POST', path: '/huaanwork/auth/logout' },
  'auth.changePassword': { http: 'POST', path: '/huaanwork/auth/changePassword' },
  'plugin.add': { http: 'POST', path: '/huaanwork/plugin/add' },
  'plugin.remove': { http: 'POST', path: '/huaanwork/plugin/remove' },
  'plugin.list': { http: 'GET', path: '/huaanwork/plugin/list' },
  'skill.list': { http: 'GET', path: '/huaanwork/skill/list' },
  'skill.get': { http: 'GET', path: '/huaanwork/skill/get' },
  'skill.create': { http: 'POST', path: '/huaanwork/skill/create' },
  'skill.update': { http: 'POST', path: '/huaanwork/skill/update' },
  'skill.remove': { http: 'POST', path: '/huaanwork/skill/remove' },
  'skill.importPreview': { http: 'POST', path: '/huaanwork/skill/importPreview' },
  'skill.import': { http: 'POST', path: '/huaanwork/skill/import' },
  'skill.setEnabled': { http: 'POST', path: '/huaanwork/skill/setEnabled' },
  'agent.list': { http: 'GET', path: '/huaanwork/agent/list' },
  'agent.get': { http: 'GET', path: '/huaanwork/agent/get' },
  'agent.refresh': { http: 'POST', path: '/huaanwork/agent/refresh' },
  'agent.setEnabled': { http: 'POST', path: '/huaanwork/agent/setEnabled' },
  'agent.addEndpoint': { http: 'POST', path: '/huaanwork/agent/addEndpoint' },
  'agent.removeEndpoint': { http: 'POST', path: '/huaanwork/agent/removeEndpoint' },
  'agent.packageList': { http: 'GET', path: '/huaanwork/agent/package/list' },
  'agent.packageDetail': { http: 'GET', path: '/huaanwork/agent/package/detail' },
  'agent.packageSetEnabled': { http: 'POST', path: '/huaanwork/agent/package/setEnabled' },
  'agent.invocableList': { http: 'GET', path: '/huaanwork/agent/invocable' },
  'status.get': { http: 'GET', path: '/huaanwork/status' },
  'project.list': { http: 'GET', path: '/huaanwork/project/list' },
  'project.create': { http: 'POST', path: '/huaanwork/project/create' },
  'project.open': { http: 'POST', path: '/huaanwork/project/open' },
  'project.remove': { http: 'POST', path: '/huaanwork/project/remove' },
  'project.rename': { http: 'POST', path: '/huaanwork/project/rename' },
  'automation.list': { http: 'GET', path: '/huaanwork/automation/list' },
  'automation.create': { http: 'POST', path: '/huaanwork/automation/create' },
  'automation.update': { http: 'POST', path: '/huaanwork/automation/update' },
  'automation.remove': { http: 'POST', path: '/huaanwork/automation/remove' },
  'automation.stop': { http: 'POST', path: '/huaanwork/automation/stop' },
  'automation.deleteRun': { http: 'POST', path: '/huaanwork/automation/deleteRun' },
  'automation.run': { http: 'POST', path: '/huaanwork/automation/run' },
  'automation.runs': { http: 'GET', path: '/huaanwork/automation/runs' },
  'automation.pruneSessions': { http: 'POST', path: '/huaanwork/automation/pruneSessions' },
  'automation.templates': { http: 'GET', path: '/huaanwork/automation/templates' },
  'task.list': { http: 'GET', path: '/huaanwork/task/list' },
  'task.create': { http: 'POST', path: '/huaanwork/task/create' },
  'task.remove': { http: 'POST', path: '/huaanwork/task/remove' },
  'task.bindSession': { http: 'POST', path: '/huaanwork/task/bindSession' },
  'task.rename': { http: 'POST', path: '/huaanwork/task/rename' },
}

describe('rpcCall 路由映射', () => {
  test('全表 62 项与 ROUTE_TABLE 一一对应', () => {
    expect(Object.keys(ROUTES)).toHaveLength(62)
    const actual = Object.fromEntries(
      Object.entries(ROUTES).map(([method, route]) => [method, { http: route.http, path: route.path }]),
    )
    expect(actual).toEqual(EXPECTED_ROUTES)
  })

  test('agent.packageSetEnabled 声明 body 透传 params(宿主拒绝空 body)', () => {
    const route = ROUTES['agent.packageSetEnabled']
    expect(route?.http).toBe('POST')
    expect(route?.path).toBe('/huaanwork/agent/package/setEnabled')
    const params = { slug: 'weekly-report', enabled: true }
    expect(route?.body?.(params)).toEqual(params)
  })

  test('agent.packageSetEnabled 经 rpcCall 发出 JSON body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }))
    await rpcCall('agent.packageSetEnabled', { slug: 'weekly-report', enabled: true })
    const { url, init } = lastFetchCall()
    expect(url).toBe('/huaanwork/agent/package/setEnabled')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(String(init.body))).toEqual({ slug: 'weekly-report', enabled: true })
  })

  test('GET 方法:settings.get → GET /huaanwork/settings', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ allow_network: false }))
    await rpcCall('settings.get')
    const { url, init } = lastFetchCall()
    expect(url).toBe('/huaanwork/settings')
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
  })

  test('POST 写方法:session.send → POST /huaanwork/session/send,body 透传 params', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }))
    const params = { text: 'hi', sessionId: 's1' }
    await rpcCall('session.send', params)
    const { url, init } = lastFetchCall()
    expect(url).toBe('/huaanwork/session/send')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(String(init.body))).toEqual(params)
  })

  test('PUT 写方法:settings.set → PUT /huaanwork/settings', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }))
    await rpcCall('settings.set', { allow_network: true })
    const { url, init } = lastFetchCall()
    expect(url).toBe('/huaanwork/settings')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ allow_network: true })
  })

  test('其余域抽查:workspace / auth / plugin / skill / agent / status / project / automation / task', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const spots: Array<[string, unknown]> = [
      ['workspace.open', { root: '/tmp/x' }],
      ['auth.login', { username: 'dev', password: 'password1' }],
      ['plugin.list', undefined],
      ['skill.setEnabled', { name: 's', enabled: true }],
      ['agent.refresh', undefined],
      ['status.get', undefined],
      ['project.rename', { id: 'p', name: 'n' }],
      ['automation.run', { id: 'a' }],
      ['task.bindSession', { id: 't', sessionId: 's' }],
      ['session.list', undefined],
      ['automation.templates', undefined],
      ['skill.get', undefined],
    ]
    for (const [method, params] of spots) await rpcCall(method, params)
    expect(fetchMock).toHaveBeenCalledTimes(spots.length)
    const calls = fetchMock.mock.calls.map((call) => `${call[1].method} ${call[0]}`)
    expect(calls).toEqual([
      'POST /huaanwork/workspace/open',
      'POST /huaanwork/auth/login',
      'GET /huaanwork/plugin/list',
      'POST /huaanwork/skill/setEnabled',
      'POST /huaanwork/agent/refresh',
      'GET /huaanwork/status',
      'POST /huaanwork/project/rename',
      'POST /huaanwork/automation/run',
      'POST /huaanwork/task/bindSession',
      'GET /huaanwork/session/list',
      'GET /huaanwork/automation/templates',
      'GET /huaanwork/skill/get',
    ])
  })

  test('未知方法直接拒绝,不发请求', async () => {
    await expect(rpcCall('nope.method')).rejects.toThrow('unknown method: nope.method')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('GET query contract:params 编码为 query string(undefined 跳过,空对象无 query)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    await rpcCall('skill.get', { name: 'demo', source: 'user' })
    expect(lastFetchCall().url).toBe('/huaanwork/skill/get?name=demo&source=user')

    await rpcCall('automation.list', { projectId: 'p1' })
    expect(lastFetchCall().url).toBe('/huaanwork/automation/list?projectId=p1')

    await rpcCall('automation.runs', { id: 'a1', limit: 5, status: 'missed' })
    expect(lastFetchCall().url).toBe('/huaanwork/automation/runs?id=a1&limit=5&status=missed')

    await rpcCall('task.list', { projectId: 'p2' })
    expect(lastFetchCall().url).toBe('/huaanwork/task/list?projectId=p2')

    await rpcCall('session.list', { root: '/tmp/ws' })
    expect(lastFetchCall().url).toBe(`/huaanwork/session/list?root=${encodeURIComponent('/tmp/ws')}`)

    await rpcCall('agent.get', { name: 'pdf-extract' })
    expect(lastFetchCall().url).toBe('/huaanwork/agent/get?name=pdf-extract')

    await rpcCall('agent.packageDetail', { slug: 'weekly-report' })
    expect(lastFetchCall().url).toBe('/huaanwork/agent/package/detail?slug=weekly-report')

    // 空对象与 undefined:path 不带 query。
    await rpcCall('automation.list', {})
    expect(lastFetchCall().url).toBe('/huaanwork/automation/list')
    await rpcCall('skill.get')
    expect(lastFetchCall().url).toBe('/huaanwork/skill/get')
  })

  test('2xx 返回 JSON payload', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ state: 'logged-in', username: 'dev' }))
    await expect(rpcCall('auth.login', { username: 'dev', password: 'password1' })).resolves.toEqual({
      state: 'logged-in',
      username: 'dev',
    })
  })
})

describe('rpcCall 错误处理', () => {
  test('envelope { error: { code, message } } → reject Error(message) 且 err.code === code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'validation', message: '字段不合法' } }, { status: 400 }))
    const err = await rpcCall('settings.set', { agents_port: 'x' }).catch((e: unknown) => e) as Error & { code?: string }
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('字段不合法')
    expect(err.code).toBe('validation')
  })

  test('非 2xx 无 envelope → reject 含 HTTP status', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 405 }))
    await expect(rpcCall('skill.list')).rejects.toThrow('HTTP 405')
  })

  test('fetch 收到 180s AbortSignal', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    await rpcCall('status.get')
    const { init } = lastFetchCall()
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  test('AbortError/TimeoutError 映射为超时文案', async () => {
    const abortError = new DOMException('The operation timed out', 'TimeoutError')
    fetchMock.mockRejectedValue(abortError)
    await expect(rpcCall('session.list')).rejects.toThrow('请求超时(180s)')

    const legacyAbort = new Error('aborted')
    legacyAbort.name = 'AbortError'
    fetchMock.mockRejectedValue(legacyAbort)
    await expect(rpcCall('session.list')).rejects.toThrow('请求超时(180s)')
  })

  test('非中止类网络错误原样抛出', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    await expect(rpcCall('status.get')).rejects.toThrow('fetch failed')
  })
})

describe('workspace.open/close 热切换', () => {
  test('200 应答原样返回 workspaceRoot,不轮询 status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ workspaceRoot: '/tmp/x' }))
    await expect(rpcCall('workspace.open', { root: '/tmp/x' }))
      .resolves.toEqual({ workspaceRoot: '/tmp/x' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('open 连接失败按普通请求抛出,不伪装成重启成功', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(rpcCall('workspace.open', { root: '/tmp/x' })).rejects.toThrow('fetch failed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('close 连接失败按普通请求抛出', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(rpcCall('workspace.close')).rejects.toThrow('fetch failed')
  })

  test('waitForReady:已是 200 时立即返回,不发额外请求之外的重试', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ready: true }))
    await expect(waitForReady(5_000)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastFetchCall().url).toBe('/huaanwork/status')
  })
})

describe('事件客户端(WebSocket)', () => {
  test('订阅后建连 ws://<host>/huaanwork/events,open 补发 sidecar/status ready', async () => {
    const events: unknown[] = []
    unsubs.push(await onSidecarEvent((event) => events.push(event)))
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0]?.url).toBe('ws://127.0.0.1:8000/huaanwork/events')
    expect(events).toEqual([])
    FakeWebSocket.instances[0]?.open()
    expect(events).toEqual([{ event: 'sidecar/status', ready: true }])
  })

  test('事件帧按同负载派发给所有 handler', async () => {
    const first: unknown[] = []
    const second: unknown[] = []
    unsubs.push(await onSidecarEvent((event) => first.push(event)))
    unsubs.push(await onSidecarEvent((event) => second.push(event)))
    const socket = FakeWebSocket.instances[0]
    socket?.open()
    socket?.emitFrame({ event: 'token', text: 'hello', sessionId: 's1' })
    expect(first).toContainEqual({ event: 'token', text: 'hello', sessionId: 's1' })
    expect(second).toContainEqual({ event: 'token', text: 'hello', sessionId: 's1' })
  })

  test('退订后不再接收事件', async () => {
    const events: unknown[] = []
    const unsub = await onSidecarEvent((event) => events.push(event))
    const socket = FakeWebSocket.instances[0]
    socket?.open()
    unsub()
    socket?.emitFrame({ event: 'token', text: 'x' })
    expect(events).toEqual([{ event: 'sidecar/status', ready: true }])
  })

  test('close 通知 exit handlers { ready: false }', async () => {
    const exits: unknown[] = []
    unsubs.push(await onSidecarEvent(() => {}))
    unsubs.push(await onSidecarExit((state) => exits.push(state)))
    const socket = FakeWebSocket.instances[0]
    socket?.open()
    socket?.closeFrame()
    expect(exits).toEqual([{ ready: false }])
  })

  test('close 后无订阅者不再重连', async () => {
    const events: unknown[] = []
    const unsub = await onSidecarEvent((event) => events.push(event))
    const socket = FakeWebSocket.instances[0]
    socket?.open()
    unsub()
    vi.useFakeTimers()
    socket?.closeFrame()
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  test('重连(指数退避):1s 后新 socket,open 再次补发 ready', async () => {
    vi.useFakeTimers()
    const events: unknown[] = []
    unsubs.push(await onSidecarEvent((event) => events.push(event)))
    FakeWebSocket.instances[0]?.open()
    expect(events).toEqual([{ event: 'sidecar/status', ready: true }])

    FakeWebSocket.instances[0]?.closeFrame()
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(FakeWebSocket.instances).toHaveLength(2)

    FakeWebSocket.instances[1]?.open()
    expect(events).toEqual([
      { event: 'sidecar/status', ready: true },
      { event: 'sidecar/status', ready: true },
    ])
  })

  test('连续断连退避翻倍,上限 30s;open 成功后退避重置', async () => {
    vi.useFakeTimers()
    unsubs.push(await onSidecarEvent(() => {}))
    // open 成功将 retryMs 重置为 1000(模块级状态跨用例保留,先归一化再断言绝对值)。
    const first = FakeWebSocket.instances[0]!
    first.open()
    first.closeFrame()
    vi.advanceTimersByTime(999)
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    const second = FakeWebSocket.instances[1]!
    second.closeFrame()
    vi.advanceTimersByTime(1999)
    expect(FakeWebSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(3)

    // 连续失败:4s → 8s → 16s → 30s 封顶
    let socket = FakeWebSocket.instances[2]!
    for (const wait of [4000, 8000, 16000, 30000, 30000]) {
      socket.closeFrame()
      vi.advanceTimersByTime(wait - 1)
      const count = FakeWebSocket.instances.length
      vi.advanceTimersByTime(1)
      expect(FakeWebSocket.instances).toHaveLength(count + 1)
      socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
    }

    // open 成功后 close:退避重置回 1s
    socket.open()
    socket.closeFrame()
    vi.advanceTimersByTime(999)
    const count = FakeWebSocket.instances.length
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(count + 1)
  })
})

describe('原生桥', () => {
  test('hasGit → GET /huaanwork/git/has-git?root=encodeURIComponent(root)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(true))
    await expect(hasGit('/tmp/工作 目录')).resolves.toBe(true)
    const { url, init } = lastFetchCall()
    expect(url).toBe(`/huaanwork/git/has-git?root=${encodeURIComponent('/tmp/工作 目录')}`)
    expect(init.method).toBe('GET')
  })

  test('listTree → GET /huaanwork/git/tree?root=...&depth=N', async () => {
    const tree = [{ name: 'src', path: 'src', isDir: true, children: [] }]
    fetchMock.mockResolvedValue(jsonResponse(tree))
    await expect(listTree('/repo', 3)).resolves.toEqual(tree)
    expect(lastFetchCall().url).toBe(`/huaanwork/git/tree?root=${encodeURIComponent('/repo')}&depth=3`)
    // 缺省 depth=2
    fetchMock.mockResolvedValue(jsonResponse([]))
    await listTree('/repo')
    expect(lastFetchCall().url).toBe('/huaanwork/git/tree?root=%2Frepo&depth=2')
  })

  test('pickDirectory → POST /_dsh/desktop/pick-directory,选中返回 path', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ path: 'C:\\work' }))
    await expect(pickDirectory()).resolves.toBe('C:\\work')
    const { url, init } = lastFetchCall()
    expect(url).toBe('/_dsh/desktop/pick-directory')
    expect(init.method).toBe('POST')
  })

  test('pickDirectory 取消(path:null)→ null', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ path: null }))
    await expect(pickDirectory()).resolves.toBeNull()
  })

  test('pickDirectory route 未注册(如 Linux,405 空 body/frontend-static fallback)→ null', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 405 }))
    await expect(pickDirectory()).resolves.toBeNull()
  })

  test('pickDirectory 404 对照 → null', async () => {
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }))
    await expect(pickDirectory()).resolves.toBeNull()
  })

  test('pickDirectory 其余非 2xx → null(与取消同语义)', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }))
    await expect(pickDirectory()).resolves.toBeNull()
  })

  test('setKeepAwake posts { hold } and returns the boolean', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(true))
    await expect(setKeepAwake(true)).resolves.toBe(true)
    const held = lastFetchCall()
    expect(held.url).toBe('/huaanwork/keep-awake')
    expect(held.init.method).toBe('POST')
    expect(held.init.headers).toEqual({ 'content-type': 'application/json' })
    expect(held.init.body).toBe(JSON.stringify({ hold: true }))

    fetchMock.mockResolvedValueOnce(jsonResponse(false))
    await expect(setKeepAwake(false)).resolves.toBe(false)
    expect(lastFetchCall().init.body).toBe(JSON.stringify({ hold: false }))
  })

  test('setKeepAwake 非 2xx 抛出服务端 message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(
      { error: { code: 'keep-awake-unavailable', message: '缺少 setKeepAwake()' } },
      { status: 503 },
    ))
    await expect(setKeepAwake(true)).rejects.toThrow('缺少 setKeepAwake()')
  })
})
