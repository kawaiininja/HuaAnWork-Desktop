import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { buildSignedAgentPackageBundle } from '@huaanwork/agent-package-format/bundle'
import {
  createAgentPackageDigest,
  type AgentPackageDigest,
  type AgentPackageFile,
} from '@huaanwork/agent-package-format/digest'
import type { AgentPackageManifest } from '@huaanwork/agent-package-format/manifest'
import {
  canonicalJson,
  fingerprintPublicKeyHex,
  generateKeyPair,
  signAgentPackageDigest,
  type CatalogSignature,
  type GeneratedKeyPair,
} from '@huaanwork/catalog-signing'

import {
  configureAgentCatalog,
  resetAgentCatalogForTests,
  type AgentCatalogClient,
  type AgentCatalogSettings,
} from '../../src/huaanwork-host/agent-package/catalog-client.ts'
import {
  AGENT_CATALOG_KEYRING_FILE,
  updateCatalogAgentPackage,
  type AgentPackageTurnStopper,
} from '../../src/huaanwork-host/agent-package/catalog-install.ts'
import { createAgentPackageHost } from '../../src/huaanwork-host/agent-package/host.ts'
import {
  createAgentPackageLifecycleLock,
  type AgentPackageLifecycleLock,
} from '../../src/huaanwork-host/agent-package/lifecycle.ts'
import {
  agentPackageDir,
  readAgentPackage,
  readAgentPackageState,
  writeAgentPackageState,
} from '../../src/huaanwork-host/agent-package/store.ts'
import type { AgentPackageState } from '../../src/huaanwork-host/agent-package/types.ts'

/**
 * Task 8:per-slug 生命周期门禁(I-11)。
 *
 * 更新/移除交易在**停止在途回合之前**占住 slug,直到 rename 与 state 提交
 * 全部结束;期间的 `@slug` dispatch 必须以「正在更新/移除」拒绝,而不是在
 * 半提交的目录上启动新回合。停止失败不触碰旧目录。
 */

const NOW = '2026-10-25T00:00:00.000Z'
const SLUG = 'weekly-report'

type Deferred = { promise: Promise<void>; resolve: () => void }

function createDeferred(): Deferred {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`等待超时:${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

let root = ''
let keyPair: GeneratedKeyPair
let lifecycle: AgentPackageLifecycleLock
let offered = new Map<string, Buffer>()

const SETTINGS: AgentCatalogSettings = {
  agents_host: '127.0.0.1',
  agents_port: 1,
  agents_catalog_token: 'read-token',
  agents_catalog_publish_token: 'publish-token',
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-package-lifecycle-'))
  keyPair = generateKeyPair()
  offered = new Map()
  resetAgentCatalogForTests()
  writeFileSync(
    join(root, AGENT_CATALOG_KEYRING_FILE),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        keys: [{ keyId: fingerprintPublicKeyHex(keyPair.publicKeyHex), publicKeyHex: keyPair.publicKeyHex, slot: 1 }],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  lifecycle = createAgentPackageLifecycleLock()
  configureAgentCatalog({
    profileDir: root,
    readSettings: () => SETTINGS,
    logger: () => undefined,
    client: fakeCatalogClient(),
    lifecycle,
  })
})

afterEach(() => {
  resetAgentCatalogForTests()
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

function manifestFor(slug: string, version: string): AgentPackageManifest {
  return {
    schemaVersion: 1,
    slug,
    displayName: `${slug} 助手`,
    description: '签名广场的测试智能体',
    version,
    draftId: `draft-${slug}`,
    createdAt: NOW,
    updatedAt: NOW,
    persona: 'persona.md',
    skill: null,
    tools: { mode: 'none' },
    allowSkills: [],
  }
}

function filesFor(manifest: AgentPackageManifest): AgentPackageFile[] {
  return [
    { path: 'agent.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    { path: 'persona.md', data: Buffer.from(`你是 ${manifest.displayName}。\n`, 'utf8') },
  ]
}

/** 目录当前提供的版本:更新路径真正下载并验签这份 bundle。 */
async function offer(slug: string, version: string): Promise<void> {
  const manifest = manifestFor(slug, version)
  const files = filesFor(manifest)
  const digest = createAgentPackageDigest(manifest, files)
  const signature = signAgentPackageDigest(digest, {
    privateKeyPem: keyPair.privateKeyPem,
    slot: 1,
    signedAt: NOW,
  })
  offered.set(`${slug}@${version}`, await buildSignedAgentPackageBundle(files, digest, signature))
}

/** 按 catalog-install 的最终落盘形态写一个已验签目录(不含安装暂存区)。 */
function writeSignedPackage(slug: string, version: string): void {
  const manifest = manifestFor(slug, version)
  const files = filesFor(manifest)
  const digest: AgentPackageDigest = createAgentPackageDigest(manifest, files)
  const signature: CatalogSignature = signAgentPackageDigest(digest, {
    privateKeyPem: keyPair.privateKeyPem,
    slot: 1,
    signedAt: NOW,
  })
  const packageDir = agentPackageDir(root, slug)
  for (const file of files) {
    const target = join(packageDir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.data)
  }
  mkdirSync(join(packageDir, '.signature'), { recursive: true })
  writeFileSync(join(packageDir, '.signature', 'package-digest.json'), canonicalJson(digest), 'utf8')
  writeFileSync(join(packageDir, '.signature', 'signature.json'), JSON.stringify(signature), 'utf8')
}

function seedInstalled(slug: string, version: string): void {
  writeSignedPackage(slug, version)
  const state: AgentPackageState = {
    ...readAgentPackageState(root),
    [`catalog:${slug}`]: {
      source: 'catalog',
      enabled: true,
      installedVersion: version,
      publishStatus: 'installed',
    },
  }
  writeAgentPackageState(root, state)
}

function fakeCatalogClient(): AgentCatalogClient {
  return {
    listPackages: async () =>
      [...offered.keys()]
        .filter((key) => key.startsWith(`${SLUG}@`))
        .map((key) => {
          const [slug, version] = key.split('@') as [string, string]
          return {
            slug,
            displayName: `${slug} 助手`,
            description: '来自签名广场',
            version,
            size: offered.get(key)?.byteLength ?? 0,
            status: 'published' as const,
            updatedAt: NOW,
          }
        }),
    getPackage: async (slug, version) => {
      if (!offered.has(`${slug}@${version}`)) throw new Error(`目录中没有 ${slug}@${version}`)
      return {
        slug,
        version,
        status: 'published',
        displayName: `${slug} 助手`,
        description: '来自签名广场',
        size: offered.get(`${slug}@${version}`)?.byteLength ?? 0,
        updatedAt: NOW,
        bundleUrl: `/v1/agent-packages/${slug}/${version}/bundle`,
      }
    },
    downloadBundleToFile: async (slug, version, destination) => {
      const bundle = offered.get(`${slug}@${version}`)
      if (bundle === undefined) throw new Error(`目录中没有 ${slug}@${version}`)
      writeFileSync(destination, bundle)
    },
    getRevocations: async () => [],
    submit: async () => {
      throw new Error('unused')
    },
    getSubmission: async () => {
      throw new Error('unused')
    },
    requestDelist: async () => {
      throw new Error('unused')
    },
  }
}

/** 正式目录的完整快照(相对路径 → 内容哈希),用于断言「停止失败不 rename」。 */
function snapshotTree(dir: string): Record<string, string> {
  const result: Record<string, string> = {}
  const walk = (relative: string): void => {
    for (const entry of readdirSync(relative === '' ? dir : join(dir, relative), { withFileTypes: true })) {
      const current = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        result[current] = '<dir>'
        walk(current)
        continue
      }
      result[current] = createHash('sha256').update(readFileSync(join(dir, current))).digest('hex')
    }
  }
  walk('')
  return result
}

function makeHost(): ReturnType<typeof createAgentPackageHost> {
  return createAgentPackageHost({
    profileDir: root,
    takenSlugs: () => [],
    lifecycle,
  })
}

function dispatchInput(): {
  ctx: never
  sessionId: string
  pkg: NonNullable<ReturnType<typeof readAgentPackage>>
  remainder: string
  resolveParent: () => Promise<unknown>
} {
  const pkg = readAgentPackage(root, SLUG)
  if (pkg === undefined) throw new Error('fixture package missing')
  return {
    ctx: {
      huaanworkWorkspaceRoot: { current: join(root, 'workspace') },
      subagents: {
        startActivation: async () => {
          throw new Error('dispatch must be rejected by the lifecycle gate')
        },
      },
    } as never,
    sessionId: 'parent-session',
    pkg,
    remainder: '写一份周报',
    resolveParent: async () => ({ id: 'parent-agent' }),
  }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('agent package lifecycle gate', () => {
  test('a same-slug update blocks a new dispatch until the whole transaction finishes', async () => {
    seedInstalled(SLUG, '1.0.0')
    await offer(SLUG, '1.0.1')
    const host = makeHost()
    const deferred = createDeferred()
    let busyDuringStop = false
    const stopTurns: AgentPackageTurnStopper = async () => {
      busyDuringStop = lifecycle.isBusy(SLUG)
      await deferred.promise
    }

    const update = updateCatalogAgentPackage(SLUG, stopTurns)
    await waitFor(() => busyDuringStop, 'update reaches stopTurns')
    expect(lifecycle.isBusy(SLUG)).toBe(true)

    await expect(host.dispatch(dispatchInput())).rejects.toThrow(/正在更新/)

    deferred.resolve()
    await update
    expect(readAgentPackageState(root)[`catalog:${SLUG}`]?.installedVersion).toBe('1.0.1')
    expect(lifecycle.isBusy(SLUG)).toBe(false)
  })

  test('a rejected stopTurns aborts update before the directory is renamed', async () => {
    seedInstalled(SLUG, '1.0.0')
    await offer(SLUG, '1.0.1')
    const before = snapshotTree(agentPackageDir(root, SLUG))

    await expect(
      updateCatalogAgentPackage(SLUG, async () => {
        throw new Error('stop failed')
      }),
    ).rejects.toThrow(/stop failed|停止/)

    expect(snapshotTree(agentPackageDir(root, SLUG))).toEqual(before)
    expect(readAgentPackageState(root)[`catalog:${SLUG}`]?.installedVersion).toBe('1.0.0')
    expect(lifecycle.isBusy(SLUG)).toBe(false)
  })
})
