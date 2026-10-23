import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { AgentDetail, AgentListItem, RpcEvent } from '../../src/client-huaanwork/rpc-types.ts'
import { createAgentPackageHost } from '../../src/huaanwork-host/agent-package/host.ts'
import {
  agentPackageDir,
  readAgentPackageState,
  setAgentPackageEnabled,
  writeAgentPackageAtomically,
} from '../../src/huaanwork-host/agent-package/store.ts'
import type { AgentPackageManifest } from '../../src/huaanwork-host/agent-package/types.ts'
import type { AgentsHost } from '../../src/huaanwork-host/agents-host.ts'
import { ROUTE_TABLE, type RouteContext } from '../../src/huaanwork-host/routes.ts'
import { setAgentPackageHost, setAgentsDirectory } from '../../src/huaanwork-host/sessions.ts'

/**
 * Task 7 路由:T1 四个本地智能体包 RPC(列表/详情/启停/可调用列表)。
 *
 * 宿主用真实 `createAgentPackageHost`(本地包读写落临时 profile 目录),
 * legacy 目录用手写 `AgentsHost` 桩:这些用例验证的是两条数据源的合并与
 * 分支选择,不是目录抓取本身(目录抓取由 agents-host.spec.ts 覆盖)。
 */

const LOCAL_ENABLED = 'weekly-report'
const LOCAL_DISABLED = 'draft-agent'
const LOCAL_BROKEN = 'broken-agent'
const LEGACY_AGENT = 'pdf-extract'
const LEGACY_DISABLED_AGENT = 'off-agent'
const LEGACY_BROKEN_AGENT = 'broken-legacy'
const LEGACY_TOOL = 'translator'

let roots: string[] = []
let profileDir: string
let emitted: RpcEvent[] = []
let legacy: FakeAgentsHost

type FakeAgentsHost = AgentsHost & {
  setEnabledCalls: Array<{ name: string; enabled: boolean; confirmPermissions: boolean }>
  detailLookups: string[]
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-package-routes-'))
  roots.push(root)
  return root
}

function manifestFor(slug: string): AgentPackageManifest {
  return {
    schemaVersion: 1,
    slug,
    displayName: `显示名 ${slug}`,
    description: `${slug} 的说明`,
    version: '1.0.0',
    draftId: `draft-${slug}`,
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    persona: 'persona.md',
    skill: null,
    tools: { mode: 'none' },
    allowSkills: [],
  }
}

function writeLocalPackage(root: string, slug: string, enabled = false): void {
  writeAgentPackageAtomically({
    profileDir: root,
    manifest: manifestFor(slug),
    persona: `# ${slug}\n负责 ${slug}。`,
    skill: null,
    replace: false,
  })
  if (enabled) setAgentPackageEnabled(root, slug, true)
}

/** 目录存在但 agent.json 无法解析 ⇒ listLocal 返回带 broken 的卡片。 */
function writeBrokenPackage(root: string, slug: string): void {
  mkdirSync(agentPackageDir(root, slug), { recursive: true })
  writeFileSync(join(agentPackageDir(root, slug), 'agent.json'), '{ not json', 'utf8')
}

function legacyItem(overrides: Partial<AgentListItem> & { name: string }): AgentListItem {
  const { name, ...rest } = overrides
  return {
    name,
    source: 'catalog',
    kind: 'agent',
    description: `${name} 的说明`,
    version: '2.0.0',
    permissions: ['network'],
    enabled: true,
    ...rest,
  }
}

function catalogDetail(name: string): AgentDetail {
  return {
    ...legacyItem({ name }),
    persona: `你是 ${name}。`,
  }
}

function fakeAgentsHost(items: AgentListItem[], details: AgentDetail[] = []): FakeAgentsHost {
  const setEnabledCalls: FakeAgentsHost['setEnabledCalls'] = []
  const detailLookups: string[] = []
  return {
    setEnabledCalls,
    detailLookups,
    list: () => ({ items, catalogError: '目录拉取失败' }),
    refresh: async () => ({ items, catalogError: '目录拉取失败' }),
    get: async (name) => {
      detailLookups.push(name)
      return details.find((detail) => detail.name === name)
    },
    setEnabled: (name, enabled, confirmPermissions) => {
      setEnabledCalls.push({ name, enabled, confirmPermissions })
    },
    addEndpoint: () => ({ ok: true }),
    removeEndpoint: () => {},
    snapshotForRuntime: () => ({ items: [] }),
  }
}

async function callRoute(
  method: string,
  options: { query?: Record<string, string>; body?: unknown } = {},
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

beforeEach(() => {
  emitted = []
  profileDir = makeRoot()
  writeLocalPackage(profileDir, LOCAL_ENABLED, true)
  writeLocalPackage(profileDir, LOCAL_DISABLED, false)
  writeBrokenPackage(profileDir, LOCAL_BROKEN)
  // 损坏包即便状态表里是启用,也不得进入可调用列表。
  setAgentPackageEnabled(profileDir, LOCAL_BROKEN, true)

  legacy = fakeAgentsHost(
    [
      legacyItem({ name: LEGACY_AGENT }),
      legacyItem({ name: LEGACY_DISABLED_AGENT, enabled: false }),
      legacyItem({ name: LEGACY_BROKEN_AGENT, broken: { reason: '入口不可达' } }),
      legacyItem({ name: LEGACY_TOOL, kind: 'tool' }),
      legacyItem({ name: 'off-tool', kind: 'tool', enabled: false }),
      legacyItem({ name: 'dev-entry', source: 'local' }),
    ],
    [catalogDetail(LEGACY_AGENT)],
  )
  setAgentsDirectory(legacy)
  setAgentPackageHost(
    createAgentPackageHost({
      profileDir,
      takenSlugs: () => [],
      legacy: () => legacy,
    }),
  )
})

afterEach(() => {
  setAgentPackageHost(undefined)
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe('agent.packageList', () => {
  test('返回本地包 + 目录中的 agent(不含 tool)+ catalogError', async () => {
    const result = (await callRoute('agent.packageList')) as {
      packages: Array<{ slug: string; source: string; enabled: boolean; broken?: { reason: string } }>
      catalogAgents: Array<{ name: string; enabled: boolean }>
      catalogError?: string
    }

    expect(result.packages.map((pkg) => pkg.slug)).toEqual([LOCAL_BROKEN, LOCAL_DISABLED, LOCAL_ENABLED])
    expect(result.packages.every((pkg) => pkg.source === 'local')).toBe(true)
    expect(result.packages.find((pkg) => pkg.slug === LOCAL_ENABLED)?.enabled).toBe(true)
    expect(result.packages.find((pkg) => pkg.slug === LOCAL_DISABLED)?.enabled).toBe(false)
    expect(result.packages.find((pkg) => pkg.slug === LOCAL_BROKEN)?.broken?.reason).toContain('无法解析')

    // 只按 kind 过滤:停用的目录 agent 仍在列表里(row 自报 enabled)。
    expect(result.catalogAgents.map((item) => item.name)).toEqual([
      LEGACY_AGENT,
      LEGACY_DISABLED_AGENT,
      LEGACY_BROKEN_AGENT,
      'dev-entry',
    ])
    expect(result.catalogError).toBe('目录拉取失败')
  })
})

describe('agent.packageDetail', () => {
  test('本地包返回 AgentPackageDetail(含 persona 与文件清单)', async () => {
    const detail = (await callRoute('agent.packageDetail', { query: { slug: LOCAL_ENABLED } })) as {
      slug: string
      source: string
      persona: string
      tools: string
      files: Array<{ path: string }>
    }

    expect(detail.slug).toBe(LOCAL_ENABLED)
    expect(detail.source).toBe('local')
    expect(detail.persona).toContain(`负责 ${LOCAL_ENABLED}`)
    expect(detail.tools).toBe('none')
    expect(detail.files.map((file) => file.path)).toEqual(['agent.json', 'persona.md'])
    expect(legacy.detailLookups).toEqual([])
  })

  test('本地没有时回退 legacy 目录详情', async () => {
    const detail = (await callRoute('agent.packageDetail', { query: { slug: LEGACY_AGENT } })) as AgentDetail

    expect(legacy.detailLookups).toEqual([LEGACY_AGENT])
    expect(detail).toMatchObject({
      name: LEGACY_AGENT,
      source: 'catalog',
      kind: 'agent',
      persona: `你是 ${LEGACY_AGENT}。`,
    })
  })

  test('两侧都没有 ⇒ 400 not-found,消息带 slug', async () => {
    await expect(callRoute('agent.packageDetail', { query: { slug: 'ghost' } })).rejects.toMatchObject({
      status: 400,
      code: 'not-found',
      message: '智能体「ghost」不存在',
    })
  })

  test('缺失 slug ⇒ 400 bad-request,不查目录', async () => {
    await expect(callRoute('agent.packageDetail')).rejects.toMatchObject({
      status: 400,
      code: 'bad-request',
    })
    expect(legacy.detailLookups).toEqual([])
  })
})

describe('agent.packageSetEnabled', () => {
  test('本地包写 agents-state.json 并发 agent/changed', async () => {
    await expect(callRoute('agent.packageSetEnabled', { body: { slug: LOCAL_DISABLED, enabled: true } }))
      .resolves.toEqual({ ok: true })

    const state = readAgentPackageState(profileDir)
    expect(state[`local:${LOCAL_DISABLED}`]?.enabled).toBe(true)
    expect(emitted).toEqual([{ event: 'agent/changed', slug: LOCAL_DISABLED }])
    expect(legacy.setEnabledCalls).toEqual([])
  })

  test('legacy 条目写目录启用表(confirmPermissions=true)并发 agent/changed', async () => {
    await expect(callRoute('agent.packageSetEnabled', { body: { slug: LEGACY_AGENT, enabled: false } }))
      .resolves.toEqual({ ok: true })

    expect(legacy.setEnabledCalls).toEqual([
      { name: LEGACY_AGENT, enabled: false, confirmPermissions: true },
    ])
    expect(emitted).toEqual([{ event: 'agent/changed', slug: LEGACY_AGENT }])
  })

  test('损坏的本地包 ⇒ 400 store-error 且不发事件(不回退 legacy 分支)', async () => {
    await expect(callRoute('agent.packageSetEnabled', { body: { slug: LOCAL_BROKEN, enabled: false } }))
      .rejects.toMatchObject({ status: 400, code: 'store-error' })
    expect(legacy.setEnabledCalls).toEqual([])
    expect(emitted).toEqual([])
  })

  test('缺 slug / 非对象 body ⇒ 400 bad-request', async () => {
    await expect(callRoute('agent.packageSetEnabled', { body: { slug: '', enabled: true } }))
      .rejects.toMatchObject({ status: 400, code: 'bad-request' })
    await expect(callRoute('agent.packageSetEnabled', { body: ['nope'] }))
      .rejects.toMatchObject({ status: 400, code: 'bad-request' })
    expect(emitted).toEqual([])
  })
})

describe('agent.invocableList', () => {
  test('只返回已启用且未损坏的本地包与 legacy 条目(agent 与 tool)', async () => {
    const result = (await callRoute('agent.invocableList')) as { items: AgentListItem[] }

    expect(result.items.map((item) => item.name)).toEqual([LOCAL_ENABLED, LEGACY_AGENT, LEGACY_TOOL, 'dev-entry'])
  })

  test('本地包映射成 AgentListItem(name=slug、source=local、permissions 为空)', async () => {
    const result = (await callRoute('agent.invocableList')) as { items: AgentListItem[] }
    const local = result.items.find((item) => item.name === LOCAL_ENABLED)

    expect(local).toEqual({
      name: LOCAL_ENABLED,
      displayName: `显示名 ${LOCAL_ENABLED}`,
      source: 'local',
      kind: 'agent',
      description: `${LOCAL_ENABLED} 的说明`,
      version: '1.0.0',
      permissions: [],
      enabled: true,
    })
  })

  test('legacy 条目原样透传(保留 kind/source/enabled)', async () => {
    const result = (await callRoute('agent.invocableList')) as { items: AgentListItem[] }

    expect(result.items.find((item) => item.name === LEGACY_AGENT)).toMatchObject({
      kind: 'agent',
      source: 'catalog',
      enabled: true,
    })
    expect(result.items.find((item) => item.name === LEGACY_TOOL)).toMatchObject({ kind: 'tool' })
  })
})
