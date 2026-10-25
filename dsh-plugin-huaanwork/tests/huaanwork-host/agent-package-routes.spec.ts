import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { buildSignedAgentPackageBundle } from '@huaanwork/agent-package-format/bundle'
import { createAgentPackageDigest, type AgentPackageFile } from '@huaanwork/agent-package-format/digest'
import {
  fingerprintPublicKeyHex,
  generateKeyPair,
  signAgentPackageDigest,
  type GeneratedKeyPair,
} from '@huaanwork/catalog-signing'

import type { AgentDetail, AgentListItem, RpcEvent } from '../../src/client-huaanwork/rpc-types.ts'
import {
  configureAgentCatalog,
  refreshCatalogPackageCache,
  resetAgentCatalogForTests,
  type AgentCatalogClient,
  type AgentCatalogSettings,
  type AgentPackageMetadata,
  type AgentPackageSubmission,
  type AgentPackageSummary,
} from '../../src/huaanwork-host/agent-package/catalog-client.ts'
import { AGENT_CATALOG_KEYRING_FILE } from '../../src/huaanwork-host/agent-package/catalog-install.ts'
import type {
  AgentCatalogSecurity,
  AgentPackageVerification,
} from '../../src/huaanwork-host/agent-package/catalog-security.ts'
import { createAgentPackageHost } from '../../src/huaanwork-host/agent-package/host.ts'
import {
  agentPackageDir,
  readAgentPackageState,
  setAgentPackageEnabled,
  writeAgentPackageAtomically,
  writeAgentPackageState,
} from '../../src/huaanwork-host/agent-package/store.ts'
import type {
  AgentPackageManifest,
  AgentPackageRevocation,
  AgentPackageStateEntry,
} from '../../src/huaanwork-host/agent-package/types.ts'
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

const NOW = '2026-10-25T00:00:00.000Z'
const CATALOG_PACKAGE = 'plaza-agent'
const CATALOG_VERSION = '1.2.0'
const CATALOG_NEXT_VERSION = '1.3.0'
const SUBMISSION_ID = '11111111-1111-4111-8111-111111111111'
const DELIST_REQUEST_ID = 'delist-request-1'
const READ_TOKEN = 'test-read-token-0123456789abcdef'
const PUBLISH_TOKEN = 'test-publish-token-0123456789abcdef'

let roots: string[] = []
let profileDir: string
let emitted: RpcEvent[] = []
let legacy: FakeAgentsHost
let keyPair: GeneratedKeyPair
let catalog: CatalogFixture
let security: FakeSecurity

type FakeAgentsHost = AgentsHost & {
  setEnabledCalls: Array<{ name: string; enabled: boolean; confirmPermissions: boolean }>
  detailLookups: string[]
  refreshCalls: number
  listError: string | undefined
  refreshError: string | undefined
}

/** 假目录客户端:列表/元数据/提交/下架全部由用例直接编排,不触网络。 */
type CatalogFixture = {
  summaries: AgentPackageSummary[]
  bundles: Map<string, Buffer>
  metadataStatus: Map<string, 'published' | 'delisted' | 'revoked'>
  submissions: Map<string, AgentPackageSubmission>
  submitResponse: AgentPackageSubmission
  offline: boolean
  /** 调用顺序探针:refresh 必须按 legacy → cache → local → installed → revocations 执行。 */
  calls: string[]
}

type FakeSecurity = AgentCatalogSecurity & {
  stopped: Array<{ slug: string; reason: 'revoke' | 'update' | 'remove' }>
  verifyCalls: string[]
  refreshCalls: number
  verification: AgentPackageVerification
  revocation: AgentPackageRevocation | undefined
  revocationWarning: string | undefined
}

function keyOf(slug: string, version: string): string {
  return `${slug}@${version}`
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

function packageFiles(manifest: AgentPackageManifest): AgentPackageFile[] {
  return [
    { path: 'agent.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    { path: 'persona.md', data: Buffer.from(`# ${manifest.displayName}\n`, 'utf8') },
  ]
}

function summaryFor(slug: string, version: string): AgentPackageSummary {
  return {
    slug,
    displayName: `${slug} 助手`,
    description: '来自签名广场',
    version,
    size: 1024,
    status: 'published',
    updatedAt: NOW,
  }
}

/** 生成并登记一个可用目录包(签名密钥来自本次用例的 keyring)。 */
async function offerPackage(slug: string, version: string): Promise<void> {
  const manifest = manifestFor(slug)
  manifest.version = version
  const files = packageFiles(manifest)
  const digest = createAgentPackageDigest(manifest, files)
  const signature = signAgentPackageDigest(digest, {
    privateKeyPem: keyPair.privateKeyPem,
    slot: 1,
    signedAt: NOW,
  })
  catalog.bundles.set(keyOf(slug, version), await buildSignedAgentPackageBundle(files, digest, signature))
  catalog.summaries = [
    ...catalog.summaries.filter((summary) => summary.slug !== slug),
    summaryFor(slug, version),
  ]
}

function writeKeyring(profileDir: string, keys: GeneratedKeyPair): void {
  writeFileSync(
    join(profileDir, AGENT_CATALOG_KEYRING_FILE),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        keys: [{ keyId: fingerprintPublicKeyHex(keys.publicKeyHex), publicKeyHex: keys.publicKeyHex, slot: 1 }],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

function catalogSettings(): AgentCatalogSettings {
  return {
    agents_host: '127.0.0.1',
    agents_port: 18080,
    agents_catalog_token: READ_TOKEN,
    agents_catalog_publish_token: PUBLISH_TOKEN,
  }
}

function fakeCatalogClient(fixture: CatalogFixture): AgentCatalogClient {
  return {
    async listPackages() {
      fixture.calls.push('catalog.list')
      if (fixture.offline) throw new Error('目录不可达')
      return fixture.summaries
    },
    async getPackage(slug, version) {
      fixture.calls.push(`catalog.metadata:${slug}@${version}`)
      const status = fixture.metadataStatus.get(keyOf(slug, version)) ?? 'published'
      const metadata: AgentPackageMetadata = {
        slug,
        version,
        status,
        displayName: `${slug} 助手`,
        description: '来自签名广场',
        size: fixture.bundles.get(keyOf(slug, version))?.byteLength ?? 1024,
        updatedAt: NOW,
        ...(status === 'published'
          ? { bundleUrl: `/v1/agent-packages/${encodeURIComponent(slug)}/${encodeURIComponent(version)}/bundle` }
          : {}),
      }
      return metadata
    },
    async downloadBundleToFile(slug, version, destination) {
      fixture.calls.push(`catalog.download:${slug}@${version}`)
      const bundle = fixture.bundles.get(keyOf(slug, version))
      if (bundle === undefined) throw new Error(`missing bundle ${slug}@${version}`)
      writeFileSync(destination, bundle)
    },
    async getRevocations() {
      fixture.calls.push('catalog.revocations')
      return []
    },
    async submit() {
      fixture.calls.push('catalog.submit')
      return fixture.submitResponse
    },
    async getSubmission(submissionId) {
      fixture.calls.push(`catalog.submission:${submissionId}`)
      const submission = fixture.submissions.get(submissionId)
      if (submission === undefined) throw new Error(`missing submission ${submissionId}`)
      return submission
    },
    async requestDelist(slug, version, reason) {
      fixture.calls.push(`catalog.delist:${slug}@${version}`)
      return {
        id: DELIST_REQUEST_ID,
        slug,
        version,
        status: 'pending',
        reason,
        createdAt: NOW,
      }
    },
  }
}

function fakeSecurity(keys: GeneratedKeyPair): FakeSecurity {
  const digest = {
    schemaVersion: 1 as const,
    slug: CATALOG_PACKAGE,
    version: CATALOG_VERSION,
    manifestSha256: '0'.repeat(64),
    files: [],
  }
  const signature = signAgentPackageDigest(digest, {
    privateKeyPem: keys.privateKeyPem,
    slot: 2,
    signedAt: NOW,
  })
  return {
    stopped: [],
    verifyCalls: [],
    refreshCalls: 0,
    verification: { ok: true, digest, signature },
    revocation: undefined,
    revocationWarning: undefined,
    loadCachedRevocations: () => ({ items: [] }),
    async refreshRevocations() {
      this.refreshCalls += 1
      return this.revocationWarning === undefined ? {} : { warning: this.revocationWarning }
    },
    async verifyInstalled(slug) {
      this.verifyCalls.push(slug)
      return this.verification
    },
    async assertRunnable() {},
    async stopAgentPackageTurnsForSlug(slug, reason) {
      this.stopped.push({ slug, reason })
    },
    revocationFor() {
      return this.revocation
    },
  }
}

/** 落一个已安装的目录包目录 + `catalog:<slug>` 状态(不依赖真实签名)。 */
function seedInstalledCatalogPackage(
  root: string,
  slug: string,
  version: string,
  entry: Partial<AgentPackageStateEntry> = {},
): void {
  const dir = agentPackageDir(root, slug)
  mkdirSync(dir, { recursive: true })
  const manifest = manifestFor(slug)
  manifest.version = version
  writeFileSync(join(dir, 'agent.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'persona.md'), `# ${slug}\n负责 ${slug}。`, 'utf8')
  const state = readAgentPackageState(root)
  state[`catalog:${slug}`] = {
    source: 'catalog',
    enabled: false,
    installedVersion: version,
    publishStatus: 'installed',
    ...entry,
  }
  writeAgentPackageState(root, state)
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
  const host: FakeAgentsHost = {
    setEnabledCalls: [],
    detailLookups: [],
    refreshCalls: 0,
    listError: '目录拉取失败',
    refreshError: '目录拉取失败',
    list: () => ({
      items,
      ...(host.listError === undefined ? {} : { catalogError: host.listError }),
    }),
    refresh: async () => {
      host.refreshCalls += 1
      catalog.calls.push('legacy.refresh')
      return {
        items,
        ...(host.refreshError === undefined ? {} : { catalogError: host.refreshError }),
      }
    },
    get: async (name) => {
      host.detailLookups.push(name)
      return details.find((detail) => detail.name === name)
    },
    setEnabled: (name, enabled, confirmPermissions) => {
      host.setEnabledCalls.push({ name, enabled, confirmPermissions })
      // Mirrors `agents-host.ts`: enabling a catalog entry requires disclosure.
      if (enabled && !confirmPermissions) throw new Error('启用智能体必须确认权限')
    },
    addEndpoint: () => ({ ok: true }),
    removeEndpoint: () => {},
    snapshotForRuntime: () => ({ items: [] }),
  }
  return host
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
    // Task 10 的安全面经 cordis holder 注入;路由测试用同形 holder 传假实现。
    runtimeCtx: { huaanworkAgentCatalogSecurity: security },
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

  keyPair = generateKeyPair()
  writeKeyring(profileDir, keyPair)
  catalog = {
    summaries: [],
    bundles: new Map(),
    metadataStatus: new Map(),
    submissions: new Map(),
    submitResponse: {
      submissionId: SUBMISSION_ID,
      slug: LOCAL_ENABLED,
      version: '1.0.0',
      status: 'pending-review',
      submittedAt: NOW,
      updatedAt: NOW,
    },
    offline: false,
    calls: [],
  }
  security = fakeSecurity(keyPair)
  configureAgentCatalog({
    profileDir,
    readSettings: catalogSettings,
    client: fakeCatalogClient(catalog),
    logger: () => {},
    emitChanged: (slug) => {
      emitted.push(slug === undefined ? { event: 'agent/changed' } : { event: 'agent/changed', slug })
    },
  })

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
      security,
    }),
  )
})

afterEach(() => {
  setAgentPackageHost(undefined)
  resetAgentCatalogForTests()
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
    await expect(
      callRoute('agent.packageSetEnabled', { body: { slug: LEGACY_AGENT, enabled: false, confirmPermissions: true } }),
    ).resolves.toEqual({ ok: true })

    expect(legacy.setEnabledCalls).toEqual([
      { name: LEGACY_AGENT, enabled: false, confirmPermissions: true },
    ])
    expect(emitted).toEqual([{ event: 'agent/changed', slug: LEGACY_AGENT }])
  })

  test('legacy 启用缺少 confirmPermissions ⇒ 400 且不发事件', async () => {
    await expect(callRoute('agent.packageSetEnabled', { body: { slug: LEGACY_DISABLED_AGENT, enabled: true } }))
      .rejects.toMatchObject({ status: 400, code: 'store-error', message: '启用智能体必须确认权限' })

    expect(legacy.setEnabledCalls).toEqual([
      { name: LEGACY_DISABLED_AGENT, enabled: true, confirmPermissions: false },
    ])
    expect(emitted).toEqual([])
  })

  test('损坏的本地包允许关闭,但不回退 legacy 分支', async () => {
    await expect(callRoute('agent.packageSetEnabled', { body: { slug: LOCAL_BROKEN, enabled: false } }))
      .resolves.toEqual({ ok: true })

    expect(readAgentPackageState(profileDir)[`local:${LOCAL_BROKEN}`]?.enabled).toBe(false)
    expect(emitted).toEqual([{ event: 'agent/changed', slug: LOCAL_BROKEN }])
    expect(legacy.setEnabledCalls).toEqual([])
  })

  test('损坏的本地包启用 ⇒ 400 store-error 且不发事件', async () => {
    await expect(callRoute('agent.packageSetEnabled', { body: { slug: LOCAL_BROKEN, enabled: true } }))
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

describe('agent.addEndpoint', () => {
  test('拒绝与现有智能体包重名的本地工具(否则 @ 永远命中包)', async () => {
    await expect(
      callRoute('agent.addEndpoint', {
        body: {
          name: LOCAL_ENABLED,
          kind: 'tool',
          entrypoint: { kind: 'http', url: 'http://192.168.1.2:9/invoke' },
        },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'bad-request',
      message: `智能体 @${LOCAL_ENABLED} 与现有智能体包重名，请换一个名称`,
    })
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

// ---------------------------------------------------------------------------
// M2(Task 11):七个签名广场生命周期 RPC
// ---------------------------------------------------------------------------

describe('agent.packageList (M2)', () => {
  test('returns cached catalog summaries and update availability for installed catalog packages', async () => {
    await offerPackage(CATALOG_PACKAGE, CATALOG_NEXT_VERSION)
    const refreshed = await refreshCatalogPackageCache()
    expect(refreshed.warning).toBeUndefined()
    seedInstalledCatalogPackage(profileDir, CATALOG_PACKAGE, CATALOG_VERSION)

    const result = (await callRoute('agent.packageList')) as {
      packages: Array<{
        slug: string
        source: string
        latestVersion?: string
        updateAvailable?: boolean
        publishStatus?: string
      }>
      catalogPackages: AgentPackageSummary[]
    }

    expect(result.catalogPackages).toEqual([
      expect.objectContaining({ slug: CATALOG_PACKAGE, version: CATALOG_NEXT_VERSION }),
    ])
    const installed = result.packages.find((pkg) => pkg.slug === CATALOG_PACKAGE)
    expect(installed).toMatchObject({
      source: 'catalog',
      latestVersion: CATALOG_NEXT_VERSION,
      updateAvailable: true,
      publishStatus: 'installed',
    })
    // 本地包不参与广场版本比较。
    expect(result.packages.find((pkg) => pkg.slug === LOCAL_ENABLED)?.latestVersion).toBeUndefined()
  })

  test('returns no updateAvailable when the cache is empty (offline, never refreshed)', async () => {
    seedInstalledCatalogPackage(profileDir, CATALOG_PACKAGE, CATALOG_VERSION)
    const result = (await callRoute('agent.packageList')) as {
      packages: Array<{ slug: string; latestVersion?: string; updateAvailable?: boolean }>
      catalogPackages: AgentPackageSummary[]
    }
    expect(result.catalogPackages).toEqual([])
    expect(result.packages.find((pkg) => pkg.slug === CATALOG_PACKAGE)?.latestVersion).toBeUndefined()
  })
})

describe('agent.packagePublish', () => {
  test('submits the local package and lets Task 8 emit exactly one agent/changed', async () => {
    catalog.submissions.set(SUBMISSION_ID, catalog.submitResponse)

    await expect(callRoute('agent.packagePublish', { body: { slug: LOCAL_ENABLED } }))
      .resolves.toEqual({ submissionId: SUBMISSION_ID })

    expect(readAgentPackageState(profileDir)[`local:${LOCAL_ENABLED}`]).toMatchObject({
      publishStatus: 'pending-review',
      submissionId: SUBMISSION_ID,
    })
    expect(emitted).toEqual([{ event: 'agent/changed', slug: LOCAL_ENABLED }])
    expect(catalog.calls).toContain('catalog.submit')
  })

  test('missing slug / non-object body → 400 without submitting', async () => {
    await expect(callRoute('agent.packagePublish', { body: {} }))
      .rejects.toMatchObject({ status: 400, code: 'bad-request' })
    await expect(callRoute('agent.packagePublish', { body: ['nope'] }))
      .rejects.toMatchObject({ status: 400, code: 'bad-request' })
    expect(catalog.calls).not.toContain('catalog.submit')
    expect(emitted).toEqual([])
  })
})

describe('agent.packagePublishStatus', () => {
  test('refreshes the submission status and emits agent/changed', async () => {
    writeAgentPackageState(profileDir, {
      ...readAgentPackageState(profileDir),
      [`local:${LOCAL_ENABLED}`]: {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'pending-review',
        submissionId: SUBMISSION_ID,
      },
    })
    catalog.submissions.set(SUBMISSION_ID, {
      ...catalog.submitResponse,
      status: 'published',
      updatedAt: NOW,
    })

    const result = (await callRoute('agent.packagePublishStatus', { query: { slug: LOCAL_ENABLED } })) as {
      slug: string
      publishStatus: string
      publishedVersion?: string
      submissionId?: string
    }

    expect(result).toMatchObject({
      slug: LOCAL_ENABLED,
      publishStatus: 'published',
      publishedVersion: '1.0.0',
      submissionId: SUBMISSION_ID,
    })
    expect(emitted).toEqual([{ event: 'agent/changed', slug: LOCAL_ENABLED }])

    // 再次查询但状态未变:不发事件。
    emitted = []
    await callRoute('agent.packagePublishStatus', { query: { slug: LOCAL_ENABLED } })
    expect(emitted).toEqual([])
  })

  test('missing slug → 400', async () => {
    await expect(callRoute('agent.packagePublishStatus'))
      .rejects.toMatchObject({ status: 400, code: 'bad-request' })
    expect(emitted).toEqual([])
  })
})

describe('agent.packageRequestDelist', () => {
  function seedPublishedLocal(): void {
    writeAgentPackageState(profileDir, {
      ...readAgentPackageState(profileDir),
      [`local:${LOCAL_ENABLED}`]: {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'published',
        publishedVersion: '1.0.0',
        submissionId: SUBMISSION_ID,
      },
    })
  }

  test('submits {slug, reason} and returns the request id', async () => {
    seedPublishedLocal()

    await expect(
      callRoute('agent.packageRequestDelist', { body: { slug: LOCAL_ENABLED, reason: '暂时下架' } }),
    ).resolves.toEqual({ requestId: DELIST_REQUEST_ID })

    expect(readAgentPackageState(profileDir)[`local:${LOCAL_ENABLED}`]?.delistRequestId).toBe(DELIST_REQUEST_ID)
    expect(emitted).toEqual([{ event: 'agent/changed', slug: LOCAL_ENABLED }])
    expect(catalog.calls).toContain(`catalog.delist:${LOCAL_ENABLED}@1.0.0`)
  })

  test('blank reason → 400 before any network call', async () => {
    seedPublishedLocal()
    await expect(
      callRoute('agent.packageRequestDelist', { body: { slug: LOCAL_ENABLED, reason: '   ' } }),
    ).rejects.toMatchObject({ status: 400, code: 'bad-request' })
    expect(catalog.calls).not.toContain(`catalog.delist:${LOCAL_ENABLED}@1.0.0`)
    expect(emitted).toEqual([])
  })

  test('missing reason → 400', async () => {
    seedPublishedLocal()
    await expect(callRoute('agent.packageRequestDelist', { body: { slug: LOCAL_ENABLED } }))
      .rejects.toMatchObject({ status: 400, code: 'bad-request' })
  })
})

describe('agent.packageInstall', () => {
  test('installs {slug, version} and returns the resulting state', async () => {
    await offerPackage(CATALOG_PACKAGE, CATALOG_VERSION)

    const result = (await callRoute('agent.packageInstall', {
      body: { slug: CATALOG_PACKAGE, version: CATALOG_VERSION },
    })) as { ok: boolean; slug: string; version: string; enabled: boolean; publishStatus: string }

    expect(result).toEqual({
      ok: true,
      slug: CATALOG_PACKAGE,
      version: CATALOG_VERSION,
      enabled: false,
      publishStatus: 'installed',
    })
    expect(readAgentPackageState(profileDir)[`catalog:${CATALOG_PACKAGE}`]).toMatchObject({
      installedVersion: CATALOG_VERSION,
      publishStatus: 'installed',
      enabled: false,
    })
    expect(existsSync(agentPackageDir(profileDir, CATALOG_PACKAGE))).toBe(true)
    expect(emitted).toEqual([{ event: 'agent/changed', slug: CATALOG_PACKAGE }])
  })

  test('missing version → 400 without downloading anything', async () => {
    await offerPackage(CATALOG_PACKAGE, CATALOG_VERSION)
    await expect(callRoute('agent.packageInstall', { body: { slug: CATALOG_PACKAGE } }))
      .rejects.toMatchObject({ status: 400, code: 'bad-request' })
    expect(catalog.calls).not.toContain(`catalog.download:${CATALOG_PACKAGE}@${CATALOG_VERSION}`)
    expect(emitted).toEqual([])
  })
})

describe('agent.packageUpdate', () => {
  test('passes the security stopper with reason update and emits once', async () => {
    await offerPackage(CATALOG_PACKAGE, CATALOG_VERSION)
    await callRoute('agent.packageInstall', { body: { slug: CATALOG_PACKAGE, version: CATALOG_VERSION } })
    emitted = []
    security.stopped = []
    await offerPackage(CATALOG_PACKAGE, CATALOG_NEXT_VERSION)

    const result = (await callRoute('agent.packageUpdate', { body: { slug: CATALOG_PACKAGE } })) as {
      ok: boolean
      version: string
      publishStatus: string
    }

    expect(result).toMatchObject({
      ok: true,
      slug: CATALOG_PACKAGE,
      version: CATALOG_NEXT_VERSION,
      publishStatus: 'installed',
    })
    expect(security.stopped).toEqual([{ slug: CATALOG_PACKAGE, reason: 'update' }])
    expect(readAgentPackageState(profileDir)[`catalog:${CATALOG_PACKAGE}`]?.installedVersion)
      .toBe(CATALOG_NEXT_VERSION)
    expect(emitted).toEqual([{ event: 'agent/changed', slug: CATALOG_PACKAGE }])
  })

  test('missing slug → 400', async () => {
    await expect(callRoute('agent.packageUpdate', { body: {} }))
      .rejects.toMatchObject({ status: 400, code: 'bad-request' })
  })
})

describe('agent.packageRemove', () => {
  test('passes the security stopper with reason remove and deletes the installed package', async () => {
    await offerPackage(CATALOG_PACKAGE, CATALOG_VERSION)
    await callRoute('agent.packageInstall', { body: { slug: CATALOG_PACKAGE, version: CATALOG_VERSION } })
    emitted = []
    security.stopped = []

    await expect(callRoute('agent.packageRemove', { body: { slug: CATALOG_PACKAGE } }))
      .resolves.toEqual({ ok: true, removed: true, slug: CATALOG_PACKAGE })

    expect(security.stopped).toEqual([{ slug: CATALOG_PACKAGE, reason: 'remove' }])
    expect(readAgentPackageState(profileDir)[`catalog:${CATALOG_PACKAGE}`]).toBeUndefined()
    expect(existsSync(agentPackageDir(profileDir, CATALOG_PACKAGE))).toBe(false)
    expect(emitted).toEqual([{ event: 'agent/changed', slug: CATALOG_PACKAGE }])
  })

  test('local package remove → 400 本地创建的智能体不能通过广场移除', async () => {
    await expect(callRoute('agent.packageRemove', { body: { slug: LOCAL_ENABLED } }))
      .rejects.toMatchObject({
        status: 400,
        code: 'store-error',
        message: '本地创建的智能体不能通过广场移除',
      })
    expect(emitted).toEqual([])
  })

  test('missing slug → 400', async () => {
    await expect(callRoute('agent.packageRemove', { body: {} }))
      .rejects.toMatchObject({ status: 400, code: 'bad-request' })
  })
})

describe('agent.packageRefresh', () => {
  function seedPendingLocal(): void {
    writeAgentPackageState(profileDir, {
      ...readAgentPackageState(profileDir),
      [`local:${LOCAL_ENABLED}`]: {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'pending-review',
        submissionId: SUBMISSION_ID,
      },
    })
    catalog.submissions.set(SUBMISSION_ID, {
      ...catalog.submitResponse,
      status: 'published',
      updatedAt: NOW,
    })
  }

  test('refreshes legacy, cache, local publications, installed metadata and revocations in order', async () => {
    legacy.refreshError = undefined
    legacy.listError = undefined
    await offerPackage(CATALOG_PACKAGE, CATALOG_VERSION)
    await callRoute('agent.packageInstall', { body: { slug: CATALOG_PACKAGE, version: CATALOG_VERSION } })
    // 已安装版本在广场被下架;同时广场出现更高版本。
    catalog.metadataStatus.set(keyOf(CATALOG_PACKAGE, CATALOG_VERSION), 'delisted')
    await offerPackage(CATALOG_PACKAGE, CATALOG_NEXT_VERSION)
    seedPendingLocal()
    security.revocationWarning = '撤销列表刷新失败：离线'
    emitted = []
    catalog.calls = []
    security.refreshCalls = 0

    const result = (await callRoute('agent.packageRefresh')) as {
      packages: Array<{
        slug: string
        source: string
        publishStatus?: string
        publishedVersion?: string
        latestVersion?: string
        updateAvailable?: boolean
      }>
      catalogAgents: AgentListItem[]
      catalogPackages: AgentPackageSummary[]
      catalogError?: string
      revocationWarning?: string
    }

    const installed = result.packages.find((pkg) => pkg.slug === CATALOG_PACKAGE)
    expect(installed).toMatchObject({
      source: 'catalog',
      publishStatus: 'delisted',
      latestVersion: CATALOG_NEXT_VERSION,
      updateAvailable: true,
    })
    const local = result.packages.find((pkg) => pkg.slug === LOCAL_ENABLED)
    expect(local).toMatchObject({ publishStatus: 'published', publishedVersion: '1.0.0' })
    expect(result.catalogPackages).toEqual([
      expect.objectContaining({ slug: CATALOG_PACKAGE, version: CATALOG_NEXT_VERSION }),
    ])
    expect(result.catalogError).toBeUndefined()
    expect(result.revocationWarning).toBe('撤销列表刷新失败：离线')
    // installed metadata + local publication 都变化,仍只发一次统一事件。
    expect(emitted).toEqual([{ event: 'agent/changed' }])
    expect(security.refreshCalls).toBe(1)
    expect(legacy.refreshCalls).toBe(1)

    const order = catalog.calls
    expect(order[0]).toBe('legacy.refresh')
    expect(order.indexOf('catalog.list')).toBeGreaterThan(order.indexOf('legacy.refresh'))
    expect(order.indexOf(`catalog.submission:${SUBMISSION_ID}`)).toBeGreaterThan(order.indexOf('catalog.list'))
    expect(order.filter((call) => call === `catalog.metadata:${CATALOG_PACKAGE}@${CATALOG_VERSION}`).length)
      .toBeGreaterThan(0)

    // 第二次刷新没有状态变化:不再发事件。
    emitted = []
    await callRoute('agent.packageRefresh')
    expect(emitted).toEqual([])
  })

  test('offline refresh keeps local packages, the cached catalog and reports catalogError + revocationWarning', async () => {
    legacy.refreshError = '目录拉取失败'
    legacy.listError = '目录拉取失败'
    await offerPackage(CATALOG_PACKAGE, CATALOG_NEXT_VERSION)
    await refreshCatalogPackageCache()
    catalog.calls = []
    catalog.offline = true
    security.revocationWarning = '撤销列表刷新失败：离线'

    const result = (await callRoute('agent.packageRefresh')) as {
      packages: Array<{ slug: string }>
      catalogPackages: AgentPackageSummary[]
      catalogError?: string
      revocationWarning?: string
    }

    expect(result.packages.map((pkg) => pkg.slug)).toContain(LOCAL_ENABLED)
    // 安全刷新失败不清缓存:上次成功的目录摘要仍在响应里。
    expect(result.catalogPackages).toEqual([
      expect.objectContaining({ slug: CATALOG_PACKAGE, version: CATALOG_NEXT_VERSION }),
    ])
    expect(result.catalogError).toContain('目录拉取失败')
    expect(result.revocationWarning).toBe('撤销列表刷新失败：离线')
  })

  test('a single local publication failure keeps the local cards and adds a warning', async () => {
    legacy.refreshError = undefined
    legacy.listError = undefined
    writeAgentPackageState(profileDir, {
      ...readAgentPackageState(profileDir),
      [`local:${LOCAL_ENABLED}`]: {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'pending-review',
        submissionId: SUBMISSION_ID,
      },
    })
    // 没有对应 submission ⇒ 单项刷新失败。
    const result = (await callRoute('agent.packageRefresh')) as {
      packages: Array<{ slug: string; publishStatus?: string }>
      catalogError?: string
    }
    expect(result.packages.map((pkg) => pkg.slug)).toContain(LOCAL_ENABLED)
    expect(result.packages.find((pkg) => pkg.slug === LOCAL_ENABLED)?.publishStatus).toBe('pending-review')
    expect(result.catalogError).toContain('本地发布状态刷新失败')
  })
})

describe('agent.packageDetail (M2)', () => {
  test('catalog package composes the security verification result', async () => {
    seedInstalledCatalogPackage(profileDir, CATALOG_PACKAGE, CATALOG_VERSION)
    const expectedKeyId = fingerprintPublicKeyHex(keyPair.publicKeyHex)

    const detail = (await callRoute('agent.packageDetail', { query: { slug: CATALOG_PACKAGE } })) as {
      slug: string
      source: string
      signature: {
        keyId: string
        signedAt: string
        slot: number
        verification: string
        reason?: string
      }
    }

    expect(detail.source).toBe('catalog')
    expect(detail.signature).toEqual({
      keyId: expectedKeyId,
      signedAt: NOW,
      slot: 2,
      verification: 'valid',
    })
    expect(security.verifyCalls).toEqual([CATALOG_PACKAGE])
  })

  test('catalog package with a failed verification reports invalid + reason', async () => {
    seedInstalledCatalogPackage(profileDir, CATALOG_PACKAGE, CATALOG_VERSION)
    security.verification = { ok: false, reason: '包校验失败，未安装或未运行。请联系管理员' }

    const detail = (await callRoute('agent.packageDetail', { query: { slug: CATALOG_PACKAGE } })) as {
      signature: { verification: string; reason?: string }
    }

    expect(detail.signature).toMatchObject({
      verification: 'invalid',
      reason: '包校验失败，未安装或未运行。请联系管理员',
    })
  })

  test('local package is not-applicable and never calls verifyInstalled', async () => {
    const detail = (await callRoute('agent.packageDetail', { query: { slug: LOCAL_ENABLED } })) as {
      signature: { verification: string }
    }
    expect(detail.signature.verification).toBe('not-applicable')
    expect(security.verifyCalls).toEqual([])
  })
})

describe('M2 security guards', () => {
  test('packageSetEnabled rejects enabling a revoked catalog package but allows disabling while keeping M2 fields', async () => {
    const revocation: AgentPackageRevocation = {
      slug: CATALOG_PACKAGE,
      version: CATALOG_VERSION,
      reason: '管理员撤销',
      revokedAt: NOW,
    }
    seedInstalledCatalogPackage(profileDir, CATALOG_PACKAGE, CATALOG_VERSION, {
      enabled: true,
      publishStatus: 'delisted',
      submissionId: 'submission-1',
      delistRequestId: 'delist-1',
      revoked: revocation,
    })
    security.revocation = revocation

    await expect(
      callRoute('agent.packageSetEnabled', { body: { slug: CATALOG_PACKAGE, enabled: true } }),
    ).rejects.toMatchObject({ status: 400, code: 'store-error' })
    expect(emitted).toEqual([])

    await expect(
      callRoute('agent.packageSetEnabled', { body: { slug: CATALOG_PACKAGE, enabled: false } }),
    ).resolves.toEqual({ ok: true })

    expect(readAgentPackageState(profileDir)[`catalog:${CATALOG_PACKAGE}`]).toMatchObject({
      enabled: false,
      publishStatus: 'delisted',
      submissionId: 'submission-1',
      delistRequestId: 'delist-1',
      revoked: revocation,
    })
    expect(emitted).toEqual([{ event: 'agent/changed', slug: CATALOG_PACKAGE }])
  })

  test('packageSetEnabled rejects enabling a broken catalog package but allows disabling', async () => {
    seedInstalledCatalogPackage(profileDir, CATALOG_PACKAGE, CATALOG_VERSION, {
      enabled: true,
      publishStatus: 'installed',
      submissionId: 'submission-2',
    })
    writeFileSync(join(agentPackageDir(profileDir, CATALOG_PACKAGE), 'agent.json'), '{ not json', 'utf8')

    await expect(
      callRoute('agent.packageSetEnabled', { body: { slug: CATALOG_PACKAGE, enabled: true } }),
    ).rejects.toMatchObject({ status: 400, code: 'store-error' })
    await expect(
      callRoute('agent.packageSetEnabled', { body: { slug: CATALOG_PACKAGE, enabled: false } }),
    ).resolves.toEqual({ ok: true })

    expect(readAgentPackageState(profileDir)[`catalog:${CATALOG_PACKAGE}`]).toMatchObject({
      enabled: false,
      publishStatus: 'installed',
      submissionId: 'submission-2',
    })
  })

  test('every M2 handler rejects admin token and privateKey fields', async () => {
    const cases: Array<[string, { body?: unknown; query?: Record<string, string> }]> = [
      ['agent.packagePublish', { body: { slug: LOCAL_ENABLED, adminToken: 'secret' } }],
      ['agent.packagePublishStatus', { query: { slug: LOCAL_ENABLED, privateKey: 'secret' } }],
      ['agent.packageRequestDelist', { body: { slug: LOCAL_ENABLED, reason: 'x', admin_token: 'secret' } }],
      ['agent.packageInstall', { body: { slug: CATALOG_PACKAGE, version: CATALOG_VERSION, privateKey: 'secret' } }],
      ['agent.packageUpdate', { body: { slug: CATALOG_PACKAGE, private_key: 'secret' } }],
      ['agent.packageRemove', { body: { slug: CATALOG_PACKAGE, adminToken: 'secret' } }],
      ['agent.packageRefresh', { body: { privateKey: 'secret' } }],
    ]
    for (const [method, options] of cases) {
      await expect(callRoute(method, options)).rejects.toMatchObject({
        status: 400,
        code: 'bad-request',
      })
    }
    expect(emitted).toEqual([])
    expect(catalog.calls).toEqual([])
  })
})
