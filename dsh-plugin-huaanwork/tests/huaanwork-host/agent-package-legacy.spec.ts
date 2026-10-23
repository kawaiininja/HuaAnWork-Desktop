import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import type { AgentListItem, RpcEvent } from '../../src/client-huaanwork/rpc-types.ts'
import { createAgentPackageHost } from '../../src/huaanwork-host/agent-package/host.ts'
import type { AgentPackageProposalInput } from '../../src/huaanwork-host/agent-package/types.ts'
import { agentsEnabledPath, createAgentsHost } from '../../src/huaanwork-host/agents-host.ts'
import { ROUTE_TABLE, type RouteContext } from '../../src/huaanwork-host/routes.ts'
import { setAgentPackageHost, setAgentsDirectory } from '../../src/huaanwork-host/sessions.ts'

/**
 * catalog-legacy 兼容(Task 9):旧启用表 `agents-enabled.json` 里的
 * `catalog:<name>` 条目必须继续出现在 `agent.packageList` 的 `catalogAgents`,
 * 可经 `agent.packageSetEnabled` 关闭,且不得把它物化成 `agents/<slug>/`。
 *
 * 这里用真实 `createAgentsHost`(假 fetch 代替公用机)与真实包宿主,验证两条
 * 数据源在路由层的合并与旧表读写;目录抓取本身由 agents-host.spec.ts 覆盖。
 */

const LEGACY_NAME = 'legacy-assistant'
const LEGACY_KEY = `catalog:${LEGACY_NAME}`

let roots: string[] = []

afterEach(() => {
  setAgentPackageHost(undefined)
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-package-legacy-'))
  roots.push(root)
  return root
}

function configuredCatalog(): () => {
  agents_host: string
  agents_port: number | ''
  agents_catalog_token: string
} {
  return () => ({ agents_host: '127.0.0.1', agents_port: 8787, agents_catalog_token: '' })
}

function unconfiguredCatalog(): () => {
  agents_host: string
  agents_port: number | ''
  agents_catalog_token: string
} {
  return () => ({ agents_host: '', agents_port: '', agents_catalog_token: '' })
}

/** 公用机目录的假实现:列表与详情返回同一条 persona 条目。 */
function catalogFetch(shouldFail: () => boolean): typeof fetch {
  return (async (input: string | URL | Request) => {
    if (shouldFail()) {
      return new Response('catalog down', { status: 500 })
    }
    const url = String(input)
    const item = {
      name: LEGACY_NAME,
      version: '2.0.0',
      kind: 'agent',
      description: '旧目录里的智能体',
      persona: '你是旧目录助手。',
      permissions: ['network'],
    }
    if (url.endsWith(`/v1/catalog/${LEGACY_NAME}`)) {
      return new Response(JSON.stringify(item), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ items: [item] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

async function callRoute(
  method: string,
  options: { query?: Record<string, string>; body?: unknown } = {},
  emitted: RpcEvent[] = [],
): Promise<unknown> {
  const entry = ROUTE_TABLE.find((route) => route.method === method)
  if (entry === undefined) throw new Error(`route ${method} is not registered`)
  const ctx = {
    emit: (event: RpcEvent) => {
      emitted.push(event)
    },
  } as unknown as RouteContext
  return entry.handler(
    { params: {}, body: options.body, query: new URLSearchParams(options.query ?? {}) },
    ctx,
  )
}

function readLegacyEnabledMap(profileDir: string): Record<string, boolean> {
  return JSON.parse(readFileSync(agentsEnabledPath(profileDir), 'utf8')) as Record<string, boolean>
}

function wireRealHosts(options: {
  profileDir: string
  legacy: ReturnType<typeof createAgentsHost>
}): ReturnType<typeof createAgentPackageHost> {
  const host = createAgentPackageHost({
    profileDir: options.profileDir,
    // 与 index.ts 同形:占用名来自目录快照(公用机条目 + 本地工具)。
    takenSlugs: () => options.legacy.snapshotForRuntime().items.map((item) => item.name),
    legacy: () => options.legacy,
  })
  setAgentsDirectory(options.legacy)
  setAgentPackageHost(host)
  return host
}

function catalogAgentsOf(result: unknown): AgentListItem[] {
  return (result as { catalogAgents: AgentListItem[] }).catalogAgents
}

describe('catalog-legacy compatibility', () => {
  test('keeps the old enabled entry, exposes it, disables it, and never materializes a package', async () => {
    const profileDir = makeRoot()
    writeFileSync(agentsEnabledPath(profileDir), `${JSON.stringify({ [LEGACY_KEY]: true })}\n`, 'utf8')
    const legacy = createAgentsHost({
      storageRoot: profileDir,
      readSettings: configuredCatalog(),
      fetchImpl: catalogFetch(() => false),
    })
    const refreshed = await legacy.refresh()
    expect(refreshed.catalogError).toBeUndefined()
    wireRealHosts({ profileDir, legacy })

    const list = await callRoute('agent.packageList')
    expect((list as { packages: unknown[] }).packages).toEqual([])
    expect(catalogAgentsOf(list)).toEqual([
      expect.objectContaining({ name: LEGACY_NAME, source: 'catalog', kind: 'agent', enabled: true }),
    ])
    expect((list as { catalogError?: string }).catalogError).toBeUndefined()

    // 详情仍回到旧 persona 条目,而不是本地包详情。
    const detail = await callRoute('agent.packageDetail', { query: { slug: LEGACY_NAME } })
    expect(detail).toMatchObject({
      name: LEGACY_NAME,
      source: 'catalog',
      kind: 'agent',
      persona: '你是旧目录助手。',
    })

    // 启用态来自旧表:可调用列表因此包含它(`@slug` 补全同源)。
    const invocableWhileEnabled = await callRoute('agent.invocableList')
    expect((invocableWhileEnabled as { items: AgentListItem[] }).items.map((item) => item.name)).toContain(LEGACY_NAME)

    const emitted: RpcEvent[] = []
    await expect(
      callRoute('agent.packageSetEnabled', { body: { slug: LEGACY_NAME, enabled: false } }, emitted),
    ).resolves.toEqual({ ok: true })
    expect(emitted).toEqual([{ event: 'agent/changed', slug: LEGACY_NAME }])
    expect(readLegacyEnabledMap(profileDir)).toEqual({})

    const afterDisable = await callRoute('agent.packageList')
    expect(catalogAgentsOf(afterDisable)[0]?.enabled).toBe(false)
    const invocableWhileDisabled = await callRoute('agent.invocableList')
    expect((invocableWhileDisabled as { items: AgentListItem[] }).items.map((item) => item.name)).not.toContain(LEGACY_NAME)

    // 兼容不等于迁移:M1 不下载、不物化旧条目。
    expect(existsSync(join(profileDir, 'agents', LEGACY_NAME))).toBe(false)
  })

  test('keeps the enabled state and cached row when the catalog is unreachable, and reports catalogError', async () => {
    const profileDir = makeRoot()
    writeFileSync(agentsEnabledPath(profileDir), `${JSON.stringify({ [LEGACY_KEY]: true })}\n`, 'utf8')
    let fail = false
    const legacy = createAgentsHost({
      storageRoot: profileDir,
      readSettings: configuredCatalog(),
      fetchImpl: catalogFetch(() => fail),
    })
    expect((await legacy.refresh()).catalogError).toBeUndefined()
    wireRealHosts({ profileDir, legacy })

    fail = true
    const failed = await legacy.refresh()
    expect(failed.catalogError).toContain('500')

    const offline = await callRoute('agent.packageList')
    expect((offline as { catalogError?: string }).catalogError).toBeTruthy()
    // 旧启用态没有被改写,缓存行也仍然以 enabled 呈现。
    expect(readLegacyEnabledMap(profileDir)).toEqual({ [LEGACY_KEY]: true })
    expect(catalogAgentsOf(offline)[0]).toMatchObject({ name: LEGACY_NAME, enabled: true })

    // 目录恢复后同一键继续生效,证明离线期间没有丢状态。
    fail = false
    expect((await legacy.refresh()).catalogError).toBeUndefined()
    const online = await callRoute('agent.packageList')
    expect((online as { catalogError?: string }).catalogError).toBeUndefined()
    expect(catalogAgentsOf(online)[0]).toMatchObject({ name: LEGACY_NAME, enabled: true })
  })

  test('rejects a package slug that collides with a local tool name', async () => {
    const profileDir = makeRoot()
    writeFileSync(
      join(profileDir, 'agents-endpoints.json'),
      JSON.stringify({
        entries: [
          {
            name: 'translator',
            kind: 'tool',
            description: '翻译本地入口',
            entrypoint: { kind: 'http', url: 'http://127.0.0.1:9000/invoke' },
          },
        ],
      }),
      'utf8',
    )
    const legacy = createAgentsHost({ storageRoot: profileDir, readSettings: unconfiguredCatalog() })
    expect(legacy.snapshotForRuntime().items.map((item) => item.name)).toContain('translator')
    const host = wireRealHosts({ profileDir, legacy })

    const proposal: AgentPackageProposalInput = {
      mode: 'create',
      displayName: '翻译助手',
      slug: 'translator',
      description: '把中文翻成英文',
      persona: '你是翻译助手。',
      personaSummary: '翻译',
      skillSummary: '无专属技能包',
      tools: 'none',
    }
    const result = await host.propose('session-tool-conflict', proposal)
    expect(result.ok).toBe(false)
    if (result.ok) return
    const slugError = result.fieldErrors.find((error) => error.field === 'slug')
    expect(slugError?.message).toContain('本地工具')
    expect(existsSync(join(profileDir, 'agents', 'translator'))).toBe(false)
  })
})
