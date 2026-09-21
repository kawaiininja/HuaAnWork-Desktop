import { createServer, type Server } from 'node:http'
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
  RouteError,
} from '../../src/huaanwork-host/routes.ts'
import { hasGit, listTree } from '../../src/huaanwork-host/native.ts'
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

  test('M4 域写操作诚实 501,不静默假成功', async () => {
    const notWired = [
      'project.create', 'project.open', 'project.remove', 'project.rename',
      'task.create', 'task.remove', 'task.bindSession', 'task.rename',
      'automation.create', 'automation.update', 'automation.remove', 'automation.run', 'automation.pruneSessions',
      'skill.create', 'skill.update', 'skill.remove', 'skill.import', 'skill.importPreview', 'skill.setEnabled',
      'agent.setEnabled', 'agent.addEndpoint', 'agent.removeEndpoint',
      'plugin.add', 'plugin.remove',
    ]
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

  test('除 status.get 外其余 53 个方法均返回 501', async () => {
    for (const route of ROUTE_TABLE) {
      if (route.method === 'status.get') continue
      await expect(route.handler({ params: {}, body: undefined, query: new URLSearchParams() } as any, {} as any))
        .rejects.toThrow(RouteError)
    }
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

  beforeAll(async () => {
    routeCtx = {
      dshHome: '/tmp/dsh-home',
      profileDir: '/tmp/profile',
      workspaceRoot: { current: '/tmp/workspace' },
      emit: (_event: RpcEvent) => {},
      logger: (_msg: string) => {},
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
    const res = await fetch(`${baseUrl}/huaanwork/project/create`, {
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
      error: { code: 'not-implemented', message: 'M4 接入:project.create' },
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
})
