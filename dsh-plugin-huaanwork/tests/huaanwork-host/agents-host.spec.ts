import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAgentsHost, type AgentsHost } from '../../src/huaanwork-host/agents-host.ts'

// 用例移植自旧 sidecar agents-host.test.ts 用例 1-4、14、19、20:
// 未配置即空、TTL 60s、失败退避保留旧清单、LAN 复检 broken、addEndpoint 拒 kind=agent。
// fetch 语义逐字:5s 超时 / 1 MiB 封顶 / Bearer 头(经 settings.agents_catalog_token)。

let dirs: Array<{ dir: string; server?: Server }> = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hw-agents-host-'))
  dirs.push({ dir })
  return dir
}

function startTestServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      dirs.push({ dir: '', server })
      resolve({ server, port })
    })
  })
}

afterEach(async () => {
  while (dirs.length > 0) {
    const entry = dirs.pop()!
    if (entry.server) {
      await new Promise<void>((resolve) => entry.server!.close(() => resolve()))
    }
    if (entry.dir) rmSync(entry.dir, { recursive: true, force: true })
  }
})

function unconfigured(): Pick<import('../../src/huaanwork-host/settings.ts').AppSettings, 'agents_host' | 'agents_port' | 'agents_catalog_token'> {
  return { agents_host: '', agents_port: '', agents_catalog_token: '' }
}

const CATALOG_ITEM = {
  name: 'pdf-extract',
  version: '1.0.0',
  kind: 'tool',
  description: 'PDF 提取',
  permissions: ['network'],
  entrypoint: { kind: 'http', url: 'http://127.0.0.1:9000/invoke' },
}

describe('agents-host(旧 agents-host.test.ts 用例 1-4)', () => {
  test('1. 未配置 host/port:list() 立即返回 { items: [] },fetchImpl 调用次数 0', () => {
    const storageRoot = makeTempDir()
    let fetchCalls = 0
    const mockFetch: typeof fetch = async () => {
      fetchCalls += 1
      throw new Error('should not be called')
    }

    const host = createAgentsHost({ storageRoot, readSettings: unconfigured, fetchImpl: mockFetch })

    const result = host.list()
    expect(result.items).toEqual([])
    expect(result.catalogError).toBeUndefined()
    expect(fetchCalls).toBe(0)
  })

  test('2. 缓存空:list() 立即返回;后台拉取完成后第二次 list() 有 catalog 项', async () => {
    const storageRoot = makeTempDir()
    const { port } = await startTestServer((req, res) => {
      if (req.url === '/v1/catalog') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ items: [CATALOG_ITEM] }))
      } else {
        res.writeHead(404).end()
      }
    })

    const host = createAgentsHost({
      storageRoot,
      readSettings: () => ({ agents_host: '127.0.0.1', agents_port: port, agents_catalog_token: '' }),
    })

    const start = Date.now()
    const first = host.list()
    expect(Date.now() - start).toBeLessThan(20)
    expect(first.items).toEqual([])

    // 轮询等到后台拉取完成(最多 1000ms)
    let second = host.list()
    const deadline = Date.now() + 1000
    while (second.items.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
      second = host.list()
    }

    expect(second.items).toHaveLength(1)
    expect(second.items[0]!.name).toBe('pdf-extract')
    expect(second.items[0]!.source).toBe('catalog')
    expect(second.items[0]!.enabled).toBe(false)
  })

  test('3. 服务器 hang(不写响应):list() 仍立即返回;refresh() 以 catalogError 结束', async () => {
    const storageRoot = makeTempDir()
    const { port } = await startTestServer(() => {
      // 故意不写响应
    })

    const host = createAgentsHost({
      storageRoot,
      readSettings: () => ({ agents_host: '127.0.0.1', agents_port: port, agents_catalog_token: '' }),
      requestTimeoutMs: 100, // 快速超时
    })

    const start = Date.now()
    const immediate = host.list()
    expect(Date.now() - start).toBeLessThan(20)
    expect(immediate.items).toEqual([])

    const refreshResult = await host.refresh()
    expect(refreshResult.catalogError).toBeTruthy()
    expect(refreshResult.items).toEqual([])
  })

  test('4. 第一次成功、第二次 500:refresh() 后 items 仍是旧清单,且有 catalogError', async () => {
    const storageRoot = makeTempDir()
    let fail = false
    const { port } = await startTestServer((_req, res) => {
      if (fail) {
        res.writeHead(500).end('Internal Server Error')
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ items: [CATALOG_ITEM] }))
      }
    })

    const host = createAgentsHost({
      storageRoot,
      readSettings: () => ({ agents_host: '127.0.0.1', agents_port: port, agents_catalog_token: '' }),
    })

    const res1 = await host.refresh()
    expect(res1.catalogError).toBeUndefined()
    expect(res1.items).toHaveLength(1)
    expect(res1.items[0]!.name).toBe('pdf-extract')

    fail = true
    const res2 = await host.refresh()
    expect(res2.catalogError).toBeTruthy()
    expect(res2.items).toHaveLength(1)
    expect(res2.items[0]!.name).toBe('pdf-extract')

    const listRes = host.list()
    expect(listRes.items).toHaveLength(1)
    expect(listRes.catalogError).toBeTruthy()
  })
})

describe('agents-host TTL / LAN 复检 / addEndpoint(旧用例 14、19、20)', () => {
  test('14. TTL 缓存到期:60s 内不重拉,超过 60s 后 list() 触发后台重拉', async () => {
    const storageRoot = makeTempDir()
    let currentTime = 1_000_000
    let fetchCount = 0

    const { port } = await startTestServer((req, res) => {
      if (req.url === '/v1/catalog') {
        fetchCount += 1
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ items: [{
          name: 'test-tool',
          version: '1.0.0',
          kind: 'tool',
          description: `版本 ${fetchCount}`,
          permissions: [],
          entrypoint: { kind: 'http', url: 'http://127.0.0.1:9000/invoke' },
        }] }))
      } else {
        res.writeHead(404).end()
      }
    })

    const host = createAgentsHost({
      storageRoot,
      readSettings: () => ({ agents_host: '127.0.0.1', agents_port: port, agents_catalog_token: '' }),
      now: () => currentTime,
    })

    await host.refresh()
    expect(fetchCount).toBe(1)
    expect(host.list().items[0]!.description).toBe('版本 1')

    // 30 秒后未过期,不应拉取
    currentTime += 30_000
    host.list()
    expect(fetchCount).toBe(1)

    // 61 秒后已过期,list() 触发后台重拉
    currentTime += 31_000
    host.list()

    // 等待后台刷新
    const deadline = Date.now() + 1000
    while (fetchCount === 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(fetchCount).toBe(2)
    expect(host.list().items[0]!.description).toBe('版本 2')
  })

  test('19. 手改 agents-endpoints.json 为公网 URL:读路径复检标 broken,不进可用快照', () => {
    const storageRoot = makeTempDir()
    writeFileSync(
      join(storageRoot, 'agents-endpoints.json'),
      JSON.stringify({ entries: [
        { name: 'evil-tool', kind: 'tool', entrypoint: { kind: 'http', url: 'https://api.openai.com/invoke' } },
        { name: 'good-tool', kind: 'tool', entrypoint: { kind: 'http', url: 'http://127.0.0.1:9000/invoke' } },
      ] }),
    )

    const host = createAgentsHost({ storageRoot, readSettings: unconfigured })

    const items = host.list().items
    const evil = items.find((i) => i.name === 'evil-tool')
    expect(evil?.broken).toBeTruthy()
    expect(evil?.broken?.reason).toMatch(/局域网/)
    expect(items.find((i) => i.name === 'good-tool')?.broken).toBeUndefined()

    const snap = host.snapshotForRuntime()
    expect(snap.items.find((i) => i.name === 'evil-tool')?.broken).toBeTruthy()
  })

  test('20. addEndpoint 拒绝 kind=agent 的本地入口(无 persona 来源,永远无法 @)', () => {
    const storageRoot = makeTempDir()
    const host: AgentsHost = createAgentsHost({ storageRoot, readSettings: unconfigured })

    const result = host.addEndpoint({
      name: 'local-agent',
      kind: 'agent',
      entrypoint: { kind: 'http', url: 'http://127.0.0.1:9000/invoke' },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.fieldErrors.some((e) => e.field === 'kind')).toBe(true)
    }
    expect(host.list().items).toEqual([])
  })

  test('8. setEnabled: 对 local 报错; catalog 启用需确认权限; 未确认抛错', async () => {
    const storageRoot = makeTempDir()
    const catalogItem = {
      name: 'pdf-extract',
      version: '1.0.0',
      kind: 'tool',
      description: 'PDF',
      permissions: ['network'],
      entrypoint: { kind: 'http', url: 'http://127.0.0.1:9000/invoke' },
    }

    const { port } = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ items: [catalogItem] }))
    })

    const host = createAgentsHost({
      storageRoot,
      readSettings: () => ({
        agents_host: '127.0.0.1',
        agents_port: port,
        agents_catalog_token: '',
      }),
    })

    await host.refresh()
    host.addEndpoint({
      name: 'my-local',
      kind: 'tool',
      entrypoint: { kind: 'http', url: 'http://127.0.0.1:9000/invoke' },
    })

    // 对 local 报错
    expect(() => host.setEnabled('my-local', true, true)).toThrow(/不能手动更改本地调试入口的启用状态/)
    expect(() => host.setEnabled('my-local', false, false)).toThrow(/不能手动更改本地调试入口的启用状态/)

    // 不存在的条目报错
    expect(() => host.setEnabled('non-existent', true, true)).toThrow(/条目不存在/)

    // catalog 启用未确认权限报错
    expect(() => host.setEnabled('pdf-extract', true, false)).toThrow(/启用智能体必须确认权限/)

    // catalog 确认权限后启用成功
    host.setEnabled('pdf-extract', true, true)
    expect(host.list().items.find((i) => i.name === 'pdf-extract')?.enabled).toBe(true)

    // 禁用无需确认权限
    host.setEnabled('pdf-extract', false, false)
    expect(host.list().items.find((i) => i.name === 'pdf-extract')?.enabled).toBe(false)

    // 检查 agents-enabled.json
    host.setEnabled('pdf-extract', true, true)
    const enabledRaw = JSON.parse(readFileSync(join(storageRoot, 'agents-enabled.json'), 'utf8'))
    expect(enabledRaw['catalog:pdf-extract']).toBe(true)

    host.setEnabled('pdf-extract', false, false)
    const disabledRaw = JSON.parse(readFileSync(join(storageRoot, 'agents-enabled.json'), 'utf8'))
    expect(disabledRaw['catalog:pdf-extract']).toBeUndefined()
  })

  test('7. addEndpoint 校验矩阵: AGENT_NAME_RE/kind/URL/重名校验与合法写入', () => {
    const storageRoot = makeTempDir()
    const host = createAgentsHost({ storageRoot, readSettings: unconfigured })

    // AGENT_NAME_RE 校验: 非法字符、大写字母、超长、空名称
    const invalidNameRes = host.addEndpoint({
      name: 'Invalid_Name',
      kind: 'tool',
      entrypoint: { kind: 'http', url: 'http://127.0.0.1:9000/invoke' },
    })
    expect(invalidNameRes.ok).toBe(false)
    if (!invalidNameRes.ok) {
      expect(invalidNameRes.fieldErrors.some((e) => e.field === 'name')).toBe(true)
    }

    const longMcpRes = host.addEndpoint({
      name: 'a-very-long-mcp-tool-name-exceeding-thirty-two-chars',
      kind: 'tool',
      entrypoint: { kind: 'mcp', url: 'http://127.0.0.1:9000/mcp' },
    })
    expect(longMcpRes.ok).toBe(false)
    if (!longMcpRes.ok) {
      expect(longMcpRes.fieldErrors.some((e) => e.field === 'name' && /MCP 工具名称不能超过 32 字符/.test(e.message))).toBe(true)
    }

    // kind === 'agent' 拒绝
    const agentKindRes = host.addEndpoint({
      name: 'my-agent',
      kind: 'agent',
      entrypoint: { kind: 'http', url: 'http://127.0.0.1:9000/invoke' },
    })
    expect(agentKindRes.ok).toBe(false)
    if (!agentKindRes.ok) {
      expect(agentKindRes.fieldErrors.some((e) => e.field === 'kind' && /本地入口仅支持小工具/.test(e.message))).toBe(true)
    }

    // URL 协议与局域网校验: 公网 URL 拒绝, 非 http/https 协议拒绝, 非法 URL 拒绝
    const publicUrlRes = host.addEndpoint({
      name: 'public-tool',
      kind: 'tool',
      entrypoint: { kind: 'http', url: 'https://api.openai.com/v1' },
    })
    expect(publicUrlRes.ok).toBe(false)
    if (!publicUrlRes.ok) {
      expect(publicUrlRes.fieldErrors.some((e) => e.field === 'url' && /局域网/.test(e.message))).toBe(true)
    }

    const badProtocolRes = host.addEndpoint({
      name: 'bad-proto',
      kind: 'tool',
      entrypoint: { kind: 'http' as any, url: 'ftp://127.0.0.1:9000/invoke' },
    })
    expect(badProtocolRes.ok).toBe(false)
    if (!badProtocolRes.ok) {
      expect(badProtocolRes.fieldErrors.some((e) => e.field === 'url' && /http 或 https/.test(e.message))).toBe(true)
    }

    const badUrlRes = host.addEndpoint({
      name: 'bad-url',
      kind: 'tool',
      entrypoint: { kind: 'http', url: 'not-a-valid-url' },
    })
    expect(badUrlRes.ok).toBe(false)
    if (!badUrlRes.ok) {
      expect(badUrlRes.fieldErrors.some((e) => e.field === 'url' && /合法 URL/.test(e.message))).toBe(true)
    }

    // 合法写入
    const validRes = host.addEndpoint({
      name: 'my-local-tool',
      kind: 'tool',
      entrypoint: { kind: 'http', url: 'http://127.0.0.1:9000/invoke' },
      description: '本地测试工具',
    })
    expect(validRes.ok).toBe(true)

    // 同名重名拒绝
    const dupRes = host.addEndpoint({
      name: 'my-local-tool',
      kind: 'tool',
      entrypoint: { kind: 'http', url: 'http://127.0.0.1:9000/invoke' },
    })
    expect(dupRes.ok).toBe(false)
    if (!dupRes.ok) {
      expect(dupRes.fieldErrors.some((e) => e.field === 'name' && /同名本地入口已存在/.test(e.message))).toBe(true)
    }

    // 验证 list() 与文件持久化
    const list = host.list()
    expect(list.items).toHaveLength(1)
    expect(list.items[0]!.name).toBe('my-local-tool')
    expect(list.items[0]!.source).toBe('local')
    expect(list.items[0]!.enabled).toBe(true)

    const raw = JSON.parse(readFileSync(join(storageRoot, 'agents-endpoints.json'), 'utf8'))
    expect(raw.entries).toHaveLength(1)
    expect(raw.entries[0].name).toBe('my-local-tool')
  })

  test('12. removeEndpoint: 删除本地入口并持久化更新', () => {
    const storageRoot = makeTempDir()
    const host = createAgentsHost({ storageRoot, readSettings: unconfigured })

    host.addEndpoint({
      name: 'tool-a',
      kind: 'tool',
      entrypoint: { kind: 'http', url: 'http://127.0.0.1:9001/invoke' },
    })
    host.addEndpoint({
      name: 'tool-b',
      kind: 'tool',
      entrypoint: { kind: 'http', url: 'http://127.0.0.1:9002/invoke' },
    })

    expect(host.list().items).toHaveLength(2)

    host.removeEndpoint('tool-a')
    expect(host.list().items).toHaveLength(1)
    expect(host.list().items[0]!.name).toBe('tool-b')

    // 验证持久化
    const raw = JSON.parse(readFileSync(join(storageRoot, 'agents-endpoints.json'), 'utf8'))
    expect(raw.entries).toHaveLength(1)
    expect(raw.entries[0].name).toBe('tool-b')
  })
})
