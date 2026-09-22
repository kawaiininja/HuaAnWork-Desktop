import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  ROUTE_TABLE,
  NATIVE_ROUTES,
  routeKey,
  handleHuaanworkRequest,
  type RouteContext,
} from '../../src/huaanwork-host/routes.ts'
import { hasGit, listTree } from '../../src/huaanwork-host/native.ts'
import { sessionSendBlockers } from '../../src/huaanwork-host/sessions.ts'
import { readPendingWorkspaceRoot } from '../../src/huaanwork-host/workspace-state.ts'
import type { RpcEvent } from '../../src/client-huaanwork/rpc-types.ts'

const ALL_METHODS = [
  'workspace.open', 'workspace.close',
  'session.send', 'session.cancel', 'session.approve', 'session.reject', 'session.list', 'session.open', 'session.remove', 'session.new', 'session.resume',
  'settings.get', 'settings.set',
  'auth.status', 'auth.register', 'auth.login', 'auth.logout', 'auth.changePassword',
  'plugin.add', 'plugin.remove', 'plugin.list',
  'skill.list', 'skill.get', 'skill.create', 'skill.update', 'skill.remove', 'skill.importPreview', 'skill.import', 'skill.setEnabled',
  'agent.list', 'agent.get', 'agent.refresh', 'agent.setEnabled', 'agent.addEndpoint', 'agent.removeEndpoint',
  'status.get',
  'project.list', 'project.create', 'project.open', 'project.remove', 'project.rename',
  'automation.list', 'automation.create', 'automation.update', 'automation.remove', 'automation.run', 'automation.runs', 'automation.pruneSessions', 'automation.templates',
  'task.list', 'task.create', 'task.remove', 'task.bindSession', 'task.rename',
]

describe('ROUTE_TABLE registry', () => {
  test('54 个方法全部登记,无遗漏无重复', () => {
    expect(ROUTE_TABLE.map((r) => r.method).sort()).toEqual([...ALL_METHODS].sort())
    expect(new Set(ROUTE_TABLE.map((r) => routeKey(r.http, r.path))).size).toBe(ROUTE_TABLE.length)
    expect(ROUTE_TABLE).toHaveLength(54)
  })

  test('status.get 返回 ready: true', async () => {
    const route = ROUTE_TABLE.find((r) => r.method === 'status.get')!
    expect(route).toBeDefined()
    expect(route.http).toBe('GET')
    expect(route.path).toBe('/huaanwork/status')
    await expect(route.handler({ params: {}, body: undefined, query: new URLSearchParams() } as any, {} as any))
      .resolves.toEqual({ ready: true })
  })

  test('NATIVE_ROUTES 登记两条 git 原生路由', () => {
    expect(NATIVE_ROUTES).toHaveLength(2)
    expect(NATIVE_ROUTES.map((r) => r.path)).toEqual([
      '/huaanwork/git/has-git',
      '/huaanwork/git/tree',
    ])
  })

  test('M4 域写操作诚实 501,不静默假成功(恰 16 个,测试即口径文档)', async () => {
    const notWired = [
      'automation.create', 'automation.update', 'automation.remove', 'automation.run', 'automation.pruneSessions',
      'skill.create', 'skill.update', 'skill.remove', 'skill.import', 'skill.importPreview', 'skill.setEnabled',
      'agent.setEnabled', 'agent.addEndpoint', 'agent.removeEndpoint',
      'plugin.add', 'plugin.remove',
    ]
    expect(notWired).toHaveLength(16)
    for (const method of notWired) {
      const route = ROUTE_TABLE.find((r) => r.method === method)!
      expect(route).toBeDefined()
      await expect(route.handler({ params: {}, body: undefined, query: new URLSearchParams() } as any, {} as any))
        .rejects.toMatchObject({
          status: 501,
          code: 'not-implemented',
          message: `M4 接入:${method}`,
        })
    }
  })

  test('除 Task 4/5/7/9/10 实现的 38 个方法外其余 16 个方法均返回 501', async () => {
    const implemented = new Set([
      'status.get',
      'settings.get',
      'settings.set',
      'auth.status',
      'auth.register',
      'auth.login',
      'auth.logout',
      'auth.changePassword',
      'session.send',
      'session.cancel',
      'session.approve',
      'session.reject',
      'session.list',
      'session.open',
      'session.remove',
      'session.new',
      'session.resume',
      'workspace.open',
      'workspace.close',
      // Task 10:M4 域读路径 + projects/tasks 低复杂度写
      'plugin.list',
      'skill.list',
      'skill.get',
      'agent.list',
      'agent.get',
      'agent.refresh',
      'project.list',
      'project.create',
      'project.open',
      'project.remove',
      'project.rename',
      'automation.list',
      'automation.runs',
      'automation.templates',
      'task.list',
      'task.create',
      'task.remove',
      'task.bindSession',
      'task.rename',
    ])
    expect(implemented).toHaveLength(38)
    let notImplementedCount = 0
    for (const route of ROUTE_TABLE) {
      if (implemented.has(route.method)) continue
      notImplementedCount += 1
      await expect(route.handler({ params: {}, body: undefined, query: new URLSearchParams() } as any, {} as any))
        .rejects.toMatchObject({
          status: 501,
          code: 'not-implemented',
        })
    }
    expect(notImplementedCount).toBe(16)
  })
})

describe('native functions', () => {
  let tempDir: string

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'hw-native-test-'))
  })

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('hasGit 识别有效 git 仓库与非 git 目录', () => {
    expect(hasGit(process.cwd())).toBe(true)
    expect(hasGit(tempDir)).toBe(false)
  })

  test('listTree 正确遍历目录,过滤敏感路径并排序', () => {
    mkdirSync(join(tempDir, '.git'), { recursive: true })
    mkdirSync(join(tempDir, 'node_modules'), { recursive: true })
    writeFileSync(join(tempDir, '.DS_Store'), 'ds')
    mkdirSync(join(tempDir, 'src'), { recursive: true })
    writeFileSync(join(tempDir, 'src', 'index.ts'), 'export const x = 1')
    writeFileSync(join(tempDir, 'README.md'), '# Hello')

    const tree = listTree(tempDir, 2)
    const names = tree.map((t) => t.name)
    expect(names).not.toContain('.git')
    expect(names).not.toContain('node_modules')
    expect(names).not.toContain('.DS_Store')
    expect(names).toContain('src')
    expect(names).toContain('README.md')
    // 目录优先排序: src 应该在 README.md 之前
    expect(names.indexOf('src')).toBeLessThan(names.indexOf('README.md'))

    const srcNode = tree.find((t) => t.name === 'src')!
    expect(srcNode.isDir).toBe(true)
    expect(srcNode.children?.some((c) => c.name === 'index.ts')).toBe(true)
  })
})

describe('HTTP dispatch & security checks', () => {
  let server: Server
  let baseUrl: string
  let host: string
  let routeCtx: RouteContext
  let profileTempDir: string
  let lastLogged = ''

  beforeAll(async () => {
    profileTempDir = mkdtempSync(join(tmpdir(), 'hw-route-profile-'))
    routeCtx = {
      dshHome: join(profileTempDir, 'dsh'),
      profileDir: profileTempDir,
      workspaceRoot: { current: join(profileTempDir, 'workspace') },
      emit: (_event: RpcEvent) => {},
      logger: (msg: string) => {
        lastLogged = msg
      },
      requestRestart: async () => true,
    }

    server = createServer((req, res) => {
      void handleHuaanworkRequest(req, res, routeCtx)
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })

    const port = (server.address() as AddressInfo).port
    host = `127.0.0.1:${port}`
    baseUrl = `http://${host}`
  })

  afterAll(async () => {
    rmSync(profileTempDir, { recursive: true, force: true })
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  })

  test('拒绝非 loopback / 跨域伪造请求 (403)', async () => {
    const res = await fetch(`${baseUrl}/huaanwork/status`, {
      headers: {
        Origin: 'http://malicious.attacker.com',
      },
    })
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json).toEqual({ error: { code: 'forbidden', message: 'Forbidden' } })
  })

  test('允许同源 loopback GET 请求', async () => {
    const res = await fetch(`${baseUrl}/huaanwork/status`, {
      headers: {
        Host: host,
        Origin: baseUrl,
      },
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ ready: true })
  })

  test('M4 501 路由返回统一信封 { error: { code, message } }', async () => {
    const res = await fetch(`${baseUrl}/huaanwork/automation/create`, {
      method: 'POST',
      headers: {
        Host: host,
        Origin: baseUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'test' }),
    })
    expect(res.status).toBe(501)
    const json = await res.json()
    expect(json).toEqual({
      error: { code: 'not-implemented', message: 'M4 接入:automation.create' },
    })
  })

  test('未匹配的路由返回 404 信封', async () => {
    const res = await fetch(`${baseUrl}/huaanwork/non-existent`, {
      headers: {
        Host: host,
        Origin: baseUrl,
      },
    })
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json).toEqual({
      error: { code: 'not-found', message: 'Not Found' },
    })
  })

  test('坏 JSON 请求返回 400 信封', async () => {
    const res = await fetch(`${baseUrl}/huaanwork/workspace/open`, {
      method: 'POST',
      headers: {
        Host: host,
        Origin: baseUrl,
        'Content-Type': 'application/json',
      },
      body: '{ broken json',
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toEqual({
      error: { code: 'bad-request', message: 'Invalid JSON' },
    })
  })

  test('超 1 MiB 载荷返回 413 信封', async () => {
    const bigBody = JSON.stringify({ data: 'x'.repeat(1024 * 1024 + 10) })
    const res = await fetch(`${baseUrl}/huaanwork/workspace/open`, {
      method: 'POST',
      headers: {
        Host: host,
        Origin: baseUrl,
        'Content-Type': 'application/json',
      },
      body: bigBody,
    })
    expect(res.status).toBe(413)
    const json = await res.json()
    expect(json).toEqual({
      error: { code: 'payload-too-large', message: 'Payload Too Large' },
    })
  })

  test('分块流式传输超 1 MiB 载荷返回 413 信封 (Transfer-Encoding: chunked)', async () => {
    const chunk = 'x'.repeat(64 * 1024)
    const res = await new Promise<{ status: number; json: any }>((resolve, reject) => {
      const clientReq = httpRequest(
        `${baseUrl}/huaanwork/workspace/open`,
        {
          method: 'POST',
          headers: {
            Host: host,
            Origin: baseUrl,
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked',
          },
        },
        (clientRes) => {
          let data = ''
          clientRes.on('data', (c) => {
            data += c
          })
          clientRes.on('end', () => {
            try {
              resolve({ status: clientRes.statusCode ?? 0, json: JSON.parse(data) })
            } catch (err) {
              reject(err)
            }
          })
        },
      )
      clientReq.on('error', reject)
      // Send 17 chunks of 64KB = 1088KB > 1024KB
      for (let i = 0; i < 17; i++) {
        clientReq.write(chunk)
      }
      clientReq.end()
    })

    expect(res.status).toBe(413)
    expect(res.json).toEqual({
      error: { code: 'payload-too-large', message: 'Payload Too Large' },
    })
  })

  test('workspace.open 同根短路:200 返回 { workspaceRoot },不触发重启', async () => {
    const current = join(profileTempDir, 'workspace')
    mkdirSync(current, { recursive: true })
    const res = await fetch(`${baseUrl}/huaanwork/workspace/open`, {
      method: 'POST',
      headers: {
        Host: host,
        Origin: baseUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ root: current }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ workspaceRoot: current })
  })

  test('workspace 域非 RouteError 错误以 400 + 原文信封抵达客户端(automation-idle)', async () => {
    sessionSendBlockers.agentAutomationQueued = 1
    try {
      const res = await fetch(`${baseUrl}/huaanwork/workspace/close`, {
        method: 'POST',
        headers: {
          Host: host,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json).toEqual({
        error: { code: 'workspace-error', message: '后台自动化任务运行中，请稍候再试' },
      })
    } finally {
      sessionSendBlockers.agentAutomationQueued = 0
    }
  })

  test('原生 git 路由分发', async () => {
    const gitRes = await fetch(
      `${baseUrl}/huaanwork/git/has-git?root=${encodeURIComponent(process.cwd())}`,
      {
        headers: { Host: host, Origin: baseUrl },
      },
    )
    expect(gitRes.status).toBe(200)
    expect(await gitRes.json()).toBe(true)

    const treeRes = await fetch(
      `${baseUrl}/huaanwork/git/tree?root=${encodeURIComponent(process.cwd())}&depth=1`,
      {
        headers: { Host: host, Origin: baseUrl },
      },
    )
    expect(treeRes.status).toBe(200)
    const tree = await treeRes.json()
    expect(Array.isArray(tree)).toBe(true)
    expect(tree.length).toBeGreaterThan(0)
  })

  test('GET /huaanwork/settings 返回缺省配置', async () => {
    const res = await fetch(`${baseUrl}/huaanwork/settings`, {
      headers: { Host: host, Origin: baseUrl },
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.theme).toBe('system')
    expect(json.allow_network).toBe(false)
    expect(json.guard_mode).toBe('ask')
    expect(json.models).toHaveLength(1)
  })

  test('PUT /huaanwork/settings 遇到公网公用机地址返回 400 validation', async () => {
    const res = await fetch(`${baseUrl}/huaanwork/settings`, {
      method: 'PUT',
      headers: {
        Host: host,
        Origin: baseUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agents_host: '8.8.8.8', agents_port: 8080 }),
    })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toEqual({
      error: {
        code: 'validation',
        message: '公用机地址必须是本机或局域网（含 .local），禁止公网主机名',
      },
    })
  })

  test('PUT /huaanwork/settings 有效设置更新并返回最新配置', async () => {
    const res = await fetch(`${baseUrl}/huaanwork/settings`, {
      method: 'PUT',
      headers: {
        Host: host,
        Origin: baseUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ theme: 'dark', allow_network: true }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.theme).toBe('dark')
    expect(json.allow_network).toBe(true)

    const getRes = await fetch(`${baseUrl}/huaanwork/settings`, {
      headers: { Host: host, Origin: baseUrl },
    })
    const getJson = await getRes.json()
    expect(getJson.theme).toBe('dark')
    expect(getJson.allow_network).toBe(true)
  })

  test('auth 域全生命周期: 状态 -> 注册 -> 登出 -> 错密拒绝 -> 正确登录 -> 改密', async () => {
    // 1. 初始状态 needs-register
    const status1 = await fetch(`${baseUrl}/huaanwork/auth/status`, {
      method: 'POST',
      headers: { Host: host, Origin: baseUrl },
    })
    expect(status1.status).toBe(200)
    expect(await status1.json()).toEqual({ state: 'needs-register' })

    // 2. 注册
    const regRes = await fetch(`${baseUrl}/huaanwork/auth/register`, {
      method: 'POST',
      headers: { Host: host, Origin: baseUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'password123' }),
    })
    expect(regRes.status).toBe(200)
    expect(await regRes.json()).toEqual({ state: 'logged-in', username: 'alice' })

    // 3. 登出
    const logoutRes = await fetch(`${baseUrl}/huaanwork/auth/logout`, {
      method: 'POST',
      headers: { Host: host, Origin: baseUrl },
    })
    expect(logoutRes.status).toBe(200)
    expect(await logoutRes.json()).toEqual({ state: 'logged-out', username: 'alice' })

    // 4. 错误密码登录返回 400 auth-failed
    const failLogin = await fetch(`${baseUrl}/huaanwork/auth/login`, {
      method: 'POST',
      headers: { Host: host, Origin: baseUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'wrongpassword' }),
    })
    expect(failLogin.status).toBe(400)
    expect(await failLogin.json()).toEqual({
      error: { code: 'auth-failed', message: '用户名或密码错误' },
    })

    // 5. 正确密码登录
    const okLogin = await fetch(`${baseUrl}/huaanwork/auth/login`, {
      method: 'POST',
      headers: { Host: host, Origin: baseUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'password123' }),
    })
    expect(okLogin.status).toBe(200)
    expect(await okLogin.json()).toEqual({ state: 'logged-in', username: 'alice' })

    // 6. 修改密码
    const changeRes = await fetch(`${baseUrl}/huaanwork/auth/changePassword`, {
      method: 'POST',
      headers: { Host: host, Origin: baseUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: 'password123', next: 'newpassword456' }),
    })
    expect(changeRes.status).toBe(200)
    expect(await changeRes.json()).toEqual({ state: 'logged-in', username: 'alice' })

    // 登出后用新密码验证
    await fetch(`${baseUrl}/huaanwork/auth/logout`, {
      method: 'POST',
      headers: { Host: host, Origin: baseUrl },
    })
    const newLogin = await fetch(`${baseUrl}/huaanwork/auth/login`, {
      method: 'POST',
      headers: { Host: host, Origin: baseUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'newpassword456' }),
    })
    expect(newLogin.status).toBe(200)
    expect(await newLogin.json()).toEqual({ state: 'logged-in', username: 'alice' })
  })

  test('非 RouteError 异常触发 500 internal 回退并记录日志', async () => {
    const originalProfile = routeCtx.profileDir
    const conflictFile = join(profileTempDir, 'conflict-file')
    writeFileSync(conflictFile, 'blocking file', 'utf8')
    routeCtx.profileDir = conflictFile

    try {
      const res = await fetch(`${baseUrl}/huaanwork/settings`, {
        method: 'PUT',
        headers: {
          Host: host,
          Origin: baseUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ theme: 'dark' }),
      })
      expect(res.status).toBe(500)
      const json = await res.json()
      expect(json).toEqual({
        error: { code: 'internal', message: 'Internal Server Error' },
      })
      expect(lastLogged).toContain('Internal error handling PUT /huaanwork/settings')
    } finally {
      routeCtx.profileDir = originalProfile
    }
  })
})

describe('M4 域读路径路由(Task 10 真实化)', () => {
  let server: Server
  let baseUrl: string
  let host: string
  let routeCtx: RouteContext
  let profileTempDir: string

  const authed = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { Host: host, Origin: baseUrl, ...(init.headers ?? {}) },
  })

  beforeAll(async () => {
    profileTempDir = mkdtempSync(join(tmpdir(), 'hw-route-m4-'))
    routeCtx = {
      dshHome: join(profileTempDir, 'dsh'),
      profileDir: profileTempDir,
      workspaceRoot: { current: join(profileTempDir, 'workspace') },
      emit: (_event: RpcEvent) => {},
      logger: () => {},
      requestRestart: async () => true,
    }
    mkdirSync(routeCtx.workspaceRoot.current, { recursive: true })

    server = createServer((req, res) => {
      void handleHuaanworkRequest(req, res, routeCtx)
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const port = (server.address() as AddressInfo).port
    host = `127.0.0.1:${port}`
    baseUrl = `http://${host}`
  })

  afterAll(async () => {
    rmSync(profileTempDir, { recursive: true, force: true })
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  })

  test('project 域:list → create → rename → open(同根短路)→ remove 级联', async () => {
    // list 初始空表。
    const list0 = await fetch(`${baseUrl}/huaanwork/project/list`, authed())
    expect(list0.status).toBe(200)
    expect(await list0.json()).toEqual({ projects: [] })

    // create:新目录入库;重复 root 400 + 旧中文文案。
    const projectRoot = join(profileTempDir, 'repo-x')
    mkdirSync(projectRoot, { recursive: true })
    const created = await fetch(`${baseUrl}/huaanwork/project/create`, authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: projectRoot }),
    }))
    expect(created.status).toBe(200)
    const { project } = await created.json()
    expect(project.name).toBe('repo-x')

    const dup = await fetch(`${baseUrl}/huaanwork/project/create`, authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: projectRoot }),
    }))
    expect(dup.status).toBe(400)
    expect(await dup.json()).toEqual({
      error: { code: 'store-error', message: '该目录已是项目：repo-x' },
    })

    // rename。
    const renamed = await fetch(`${baseUrl}/huaanwork/project/rename`, authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, name: '投研平台' }),
    }))
    expect(renamed.status).toBe(200)
    expect((await renamed.json()).project.name).toBe('投研平台')

    // open:当前工作区即项目根时短路 { workspaceRoot, project },不触发重启。
    routeCtx.workspaceRoot.current = projectRoot
    const opened = await fetch(`${baseUrl}/huaanwork/project/open`, authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id }),
    }))
    expect(opened.status).toBe(200)
    const openedJson = await opened.json()
    expect(openedJson.workspaceRoot).toBe(projectRoot)
    expect(openedJson.project.id).toBe(project.id)

    // open 不存在项目:400 + 原文。
    const missing = await fetch(`${baseUrl}/huaanwork/project/open`, authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'nope' }),
    }))
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({
      error: { code: 'workspace-error', message: 'project nope was not found' },
    })

    // open 异根 + 确认重启:200 恒带 workspaceRoot(评审 D1),pendingRoot 落盘。
    const otherRoot = join(profileTempDir, 'repo-y')
    mkdirSync(otherRoot, { recursive: true })
    const createdY = await fetch(`${baseUrl}/huaanwork/project/create`, authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: otherRoot }),
    }))
    const { project: projectY } = await createdY.json()
    routeCtx.workspaceRoot.current = join(profileTempDir, 'workspace')
    routeCtx.requestRestart = async () => true
    const openedY = await fetch(`${baseUrl}/huaanwork/project/open`, authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: projectY.id }),
    }))
    expect(openedY.status).toBe(200)
    const openedYJson = await openedY.json()
    expect(openedYJson).toMatchObject({ restarting: true, workspaceRoot: otherRoot })
    expect(openedYJson.project.id).toBe(projectY.id)
    expect(readPendingWorkspaceRoot(profileTempDir)).toBe(otherRoot)

    // open 异根 + 确认框取消:400 restart-cancelled,pendingRoot 已清(评审 D2)。
    routeCtx.requestRestart = async () => false
    const cancelled = await fetch(`${baseUrl}/huaanwork/project/open`, authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: projectY.id }),
    }))
    expect(cancelled.status).toBe(400)
    expect(await cancelled.json()).toEqual({
      error: { code: 'restart-cancelled', message: '已取消工作区切换,项目未打开' },
    })
    expect(readPendingWorkspaceRoot(profileTempDir)).toBeNull()
    routeCtx.requestRestart = async () => true

    // 清理 repo-y,不影响下方级联删除的空表断言。
    await fetch(`${baseUrl}/huaanwork/project/remove`, authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: projectY.id }),
    }))

    // remove 级联:项目下任务与自动化一并清理。
    writeFileSync(join(profileTempDir, 'tasks.json'), JSON.stringify({
      tasks: [
        { id: 't1', projectId: project.id, name: '子任务', createdAt: 1 },
        { id: 't2', projectId: 'other', name: '保留', createdAt: 2 },
      ],
    }))
    writeFileSync(join(profileTempDir, 'automations.json'), JSON.stringify({
      automations: [{
        id: 'a1', projectId: project.id, name: '自动化', kind: 'agent',
        schedule: { kind: 'manual' }, widget: false, enabled: true, createdAt: 1,
      }],
    }))
    mkdirSync(join(profileTempDir, 'automations'), { recursive: true })
    writeFileSync(join(profileTempDir, 'automations', 'a1.runs.jsonl'), `${JSON.stringify({
      runId: 'r1', startedAt: 1, endedAt: 2, ok: true, output: 'x',
    })}\n`)

    const removed = await fetch(`${baseUrl}/huaanwork/project/remove`, authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id }),
    }))
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ removed: true })

    const list1 = await (await fetch(`${baseUrl}/huaanwork/project/list`, authed())).json()
    expect(list1.projects).toEqual([])
    const tasks1 = await (await fetch(`${baseUrl}/huaanwork/task/list`, authed())).json()
    expect(tasks1.tasks.map((t: { id: string }) => t.id)).toEqual(['t2'])
    const auto1 = await (await fetch(`${baseUrl}/huaanwork/automation/list`, authed())).json()
    expect(auto1.automations).toEqual([])
  })

  test('task 域:list 支持 projectId query;create 校验项目存在;bindSession/rename/remove', async () => {
    writeFileSync(join(profileTempDir, 'projects.json'), JSON.stringify({
      projects: [{ id: 'p1', name: 'P1', root: '/tmp/p1', createdAt: 1 }],
    }))

    const created = await fetch(`${baseUrl}/huaanwork/task/create`, authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'p1', name: '任务甲' }),
    }))
    expect(created.status).toBe(200)
    const { task } = await created.json()

    // list?projectId= 过滤(query contract 的服务端直读)。
    const scoped = await fetch(`${baseUrl}/huaanwork/task/list?projectId=p1`, authed())
    expect((await scoped.json()).tasks.map((t: { id: string }) => t.id)).toEqual([task.id])
    const empty = await fetch(`${baseUrl}/huaanwork/task/list?projectId=no-such-project`, authed())
    expect((await empty.json()).tasks).toEqual([])

    // create 挂在不存在的项目:400 + 原文。
    const bad = await fetch(`${baseUrl}/huaanwork/task/create`, authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'missing', name: 'x' }),
    }))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({
      error: { code: 'store-error', message: 'project missing was not found' },
    })

    // bindSession 幂等 + rename + remove。
    const bound = await fetch(`${baseUrl}/huaanwork/task/bindSession`, authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: task.id, sessionId: 'sess-1' }),
    }))
    expect((await bound.json()).task.sessionId).toBe('sess-1')
    const rebound = await fetch(`${baseUrl}/huaanwork/task/bindSession`, authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: task.id, sessionId: 'sess-1' }),
    }))
    expect(rebound.status).toBe(200)

    const renamed = await fetch(`${baseUrl}/huaanwork/task/rename`, authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: task.id, name: '新任务名' }),
    }))
    expect((await renamed.json()).task.name).toBe('新任务名')

    const removed = await fetch(`${baseUrl}/huaanwork/task/remove`, authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: task.id }),
    }))
    expect(await removed.json()).toEqual({ removed: true })
  })

  test('automation 域:list(带 runs/missed 汇总)→ runs(query id/limit/status)→ templates', async () => {
    writeFileSync(join(profileTempDir, 'automations.json'), JSON.stringify({
      automations: [{
        id: 'a1', projectId: null, name: '巡检', kind: 'agent',
        schedule: { kind: 'hourly', minute: 0 }, widget: false, enabled: true, createdAt: 1,
      }],
    }))
    mkdirSync(join(profileTempDir, 'automations'), { recursive: true })
    const runsFixture = [
      { runId: 'r1', startedAt: 1, endedAt: 2, ok: true, output: 'fine' },
      { runId: 'r2', startedAt: 3, endedAt: 4, ok: false, output: 'boom', status: 'missed' },
      { runId: 'r3', startedAt: 5, endedAt: 6, ok: false, output: 'late', status: 'missed' },
    ]
    writeFileSync(join(profileTempDir, 'automations', 'a1.runs.jsonl'), `${runsFixture.map((r) => JSON.stringify(r)).join('\n')}\n`)

    // list:runs 带最近 5 条;missed 从全量筛。
    const listed = await fetch(`${baseUrl}/huaanwork/automation/list`, authed())
    const listJson = await listed.json()
    expect(listJson.automations).toHaveLength(1)
    expect(listJson.runs.a1.map((r: { runId: string }) => r.runId)).toEqual(['r1', 'r2', 'r3'])
    expect(listJson.missed.a1.map((r: { runId: string }) => r.runId)).toEqual(['r2', 'r3'])

    // runs?id= 全量;limit 截尾;status 筛选。
    const all = await fetch(`${baseUrl}/huaanwork/automation/runs?id=a1`, authed())
    expect((await all.json()).runs).toHaveLength(3)
    const limited = await fetch(`${baseUrl}/huaanwork/automation/runs?id=a1&limit=2`, authed())
    expect((await limited.json()).runs.map((r: { runId: string }) => r.runId)).toEqual(['r2', 'r3'])
    const missedOnly = await fetch(`${baseUrl}/huaanwork/automation/runs?id=a1&status=missed`, authed())
    expect((await missedOnly.json()).runs.map((r: { runId: string }) => r.runId)).toEqual(['r2', 'r3'])

    // 缺 id:400。
    const noId = await fetch(`${baseUrl}/huaanwork/automation/runs`, authed())
    expect(noId.status).toBe(400)
    expect(await noId.json()).toEqual({
      error: { code: 'store-error', message: 'automation.runs requires params.id' },
    })

    // templates:随包模板数组。
    const templates = await fetch(`${baseUrl}/huaanwork/automation/templates`, authed())
    expect(templates.status).toBe(200)
    const templateJson = await templates.json()
    expect(Array.isArray(templateJson.templates)).toBe(true)
    expect(templateJson.templates.length).toBeGreaterThan(0)
  })

  test('skill 域:list 三源合并(bundled 带 enabled)→ get 按 name/source query', async () => {
    // 用户技能直接落盘(写路径 M4,这里只准备读 fixture)。
    mkdirSync(join(profileTempDir, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(profileTempDir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: 演示\n---\n\n正文\n')

    const listed = await fetch(`${baseUrl}/huaanwork/skill/list`, authed())
    const { skills } = await listed.json()
    const byName = (name: string) => skills.find((s: { name: string }) => s.name === name)
    // bundled 系统技能始终启用;用户技能入列;全局按名排序。
    expect(byName('explore').source).toBe('bundled')
    expect(byName('explore').enabled).toBe(true)
    expect(byName('demo')).toMatchObject({ source: 'user', description: '演示' })
    const names = skills.map((s: { name: string }) => s.name)
    expect([...names].sort((a: string, b: string) => a.localeCompare(b))).toEqual(names)

    // get:source 定向 + 未找到 400 原文。
    const got = await fetch(`${baseUrl}/huaanwork/skill/get?name=demo&source=user`, authed())
    expect(got.status).toBe(200)
    expect((await got.json()).skill.content).toBe('正文')

    const bundledGot = await fetch(`${baseUrl}/huaanwork/skill/get?name=explore&source=bundled`, authed())
    expect((await bundledGot.json()).skill.source).toBe('bundled')

    const missing = await fetch(`${baseUrl}/huaanwork/skill/get?name=missing`, authed())
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({
      error: { code: 'store-error', message: 'skill missing was not found' },
    })

    const noName = await fetch(`${baseUrl}/huaanwork/skill/get`, authed())
    expect(noName.status).toBe(400)
    expect(await noName.json()).toEqual({
      error: { code: 'store-error', message: 'skill.get requires params.name' },
    })
  })

  test('agent 域:未配置 agents_host 时 list/get 均为空(占位目录语义)', async () => {
    const listed = await fetch(`${baseUrl}/huaanwork/agent/list`, authed())
    expect(await listed.json()).toEqual({ items: [] })

    const got = await fetch(`${baseUrl}/huaanwork/agent/get?name=anyone`, authed())
    expect(got.status).toBe(200)
    expect(await got.json()).toBeNull()

    const refreshed = await fetch(`${baseUrl}/huaanwork/agent/refresh`, authed({ method: 'POST' }))
    expect(await refreshed.json()).toEqual({ items: [] })
  })

  test('plugin.list:manifest 缺失时回落 REQUIRED_BUNDLES(web 模板前导)', async () => {
    const listed = await fetch(`${baseUrl}/huaanwork/plugin/list`, authed())
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] })
  })

  test('IMMUTABLE_BUNDLES 与 desktop-plugins.ts 同口径:含 web carrier;回落清单不含 dsh-plugin-huaanwork', async () => {
    const { IMMUTABLE_BUNDLES, fallbackProfileBundles } = await import('../../src/huaanwork-host/plugins-host.ts')
    // 真实的 dsh.profile.bundles composition(REQUIRED_BUNDLES 前导)必须不可移除。
    expect(IMMUTABLE_BUNDLES.has('@deepseek-ai/dsh-base')).toBe(true)
    expect(IMMUTABLE_BUNDLES.has('@deepseek-ai/dsh-web-app')).toBe(true)
    // 回落 bundle 清单 = REQUIRED_BUNDLES;dsh-plugin-huaanwork 是 DESKTOP_PACKAGE_NAME
    // (走 patch 行组合),不得伪装成 bundle 清单成员(IMMUTABLE 集含它是桌面包名语义)。
    expect(fallbackProfileBundles()).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(fallbackProfileBundles()).not.toContain('dsh-plugin-huaanwork')
  })
})
