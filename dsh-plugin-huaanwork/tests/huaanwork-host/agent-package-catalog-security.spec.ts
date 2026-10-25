import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import type { AgentPackageManifest } from '@huaanwork/agent-package-format/manifest'
import {
  createAgentPackageDigest,
  type AgentPackageDigest,
  type AgentPackageFile,
} from '@huaanwork/agent-package-format/digest'
import {
  canonicalJson,
  fingerprintPublicKeyHex,
  generateKeyPair,
  signAgentPackageDigest,
  type CatalogSignature,
  type GeneratedKeyPair,
} from '@huaanwork/catalog-signing'

import { attachAgentTools, emptyAttachments, type AttachmentMaps } from '../../src/huaanwork-guardrails/agent-attachments.ts'
import {
  AGENT_CATALOG_UNREACHABLE_ERROR,
  AgentCatalogClientError,
  configureAgentCatalog,
  createAgentCatalogClient,
  resetAgentCatalogForTests,
  type AgentCatalogClient,
  type AgentCatalogSettings,
} from '../../src/huaanwork-host/agent-package/catalog-client.ts'
import {
  AGENT_CATALOG_KEYRING_FILE,
  AGENT_PACKAGE_VERIFY_FAILURE,
  refreshInstalledCatalogPackageStatuses,
} from '../../src/huaanwork-host/agent-package/catalog-install.ts'
import {
  agentCatalogRevocationsPath,
  createAgentCatalogSecurity,
  type AgentCatalogSecurity,
  type AgentPackageVerification,
} from '../../src/huaanwork-host/agent-package/catalog-security.ts'
import {
  createAgentPackageActiveTurnRegistry,
  createAgentPackageHost,
  type AgentPackageActiveTurnRegistry,
  type AgentPackageDispatchResult,
  type AgentPackageHost,
} from '../../src/huaanwork-host/agent-package/host.ts'
import {
  createAgentPackageRuntimeRegistry,
  type AgentPackageRuntimeRegistry,
  type StartAgentPackageProcessesOptions,
} from '../../src/huaanwork-host/agent-package/runtime.ts'
import {
  agentPackageDir,
  readAgentPackageState,
  writeAgentPackageState,
} from '../../src/huaanwork-host/agent-package/store.ts'
import type {
  AgentPackageDetail,
  AgentPackageRevocation,
  AgentPackageState,
  AgentPackageSubagentRequest,
  AgentPackageTurnRuntime,
} from '../../src/huaanwork-host/agent-package/types.ts'
import type { AgentsHost } from '../../src/huaanwork-host/agents-host.ts'
import type { RouteContext } from '../../src/huaanwork-host/routes.ts'
import { sessionCancel, setAgentPackageActiveTurns } from '../../src/huaanwork-host/sessions.ts'

/**
 * Task 10:撤销缓存、运行前复验与在途回合中止。
 *
 * 全部用真实 profile 目录与测试期生成的 Ed25519 密钥对;签名包目录按
 * catalog-install 的落盘形态构造(内容文件 + `.signature/` 两份文档)。
 * 目录网络用注入的 fake client,不碰真实目录,也没有后台推送。
 */

const NOW = '2026-10-25T00:00:00.000Z'
const SLUG = 'weekly-report'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-package-catalog-security-'))
  keyPair = generateKeyPair()
  writeKeyring(keyPair)
})

afterEach(() => {
  resetAgentCatalogForTests()
  setAgentPackageActiveTurns(undefined)
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 签名包 fixture
// ---------------------------------------------------------------------------

function writeKeyring(pair: GeneratedKeyPair): void {
  writeFileSync(
    join(root, AGENT_CATALOG_KEYRING_FILE),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        keys: [{ keyId: fingerprintPublicKeyHex(pair.publicKeyHex), publicKeyHex: pair.publicKeyHex, slot: 1 }],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

function manifestFor(slug: string, version = '1.0.0'): AgentPackageManifest {
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

type SignedPackage = {
  manifest: AgentPackageManifest
  digest: AgentPackageDigest
  signature: CatalogSignature
  packageDir: string
}

function packageFiles(manifest: AgentPackageManifest): AgentPackageFile[] {
  return [
    { path: 'agent.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    { path: 'persona.md', data: Buffer.from(`你是 ${manifest.slug}。\n`, 'utf8') },
  ]
}

/** 与 {@link writeSignedPackage} 同一输入形状的 digest,供 verify seam 构造真实结果。 */
function digestFor(slug: string, version = '1.0.0'): AgentPackageDigest {
  const manifest = manifestFor(slug, version)
  return createAgentPackageDigest(manifest, packageFiles(manifest))
}

/**
 * 按 catalog-install 的最终落盘形态写一个已验签目录(不含安装暂存区)。
 *
 * `directorySlug` 用来制造「签名包属于别的 slug,却落在这个目录」的身份不符。
 */
function writeSignedPackage(slug: string, version = '1.0.0', directorySlug = slug): SignedPackage {
  const manifest = manifestFor(slug, version)
  const files = packageFiles(manifest)
  const digest = createAgentPackageDigest(manifest, files)
  const signature = signAgentPackageDigest(digest, { privateKeyPem: keyPair.privateKeyPem, slot: 1, signedAt: NOW })
  const packageDir = agentPackageDir(root, directorySlug)
  for (const file of files) {
    const target = join(packageDir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.data)
  }
  mkdirSync(join(packageDir, '.signature'), { recursive: true })
  writeFileSync(join(packageDir, '.signature', 'package-digest.json'), canonicalJson(digest), 'utf8')
  writeFileSync(join(packageDir, '.signature', 'signature.json'), JSON.stringify(signature), 'utf8')
  return { manifest, digest, signature, packageDir }
}

function writeLocalPackage(slug: string): void {
  const packageDir = agentPackageDir(root, slug)
  mkdirSync(packageDir, { recursive: true })
  const manifest = manifestFor(slug)
  writeFileSync(join(packageDir, 'agent.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(join(packageDir, 'persona.md'), `你是 ${slug}。\n`, 'utf8')
  const state = readAgentPackageState(root)
  state[`local:${slug}`] = {
    source: 'local',
    enabled: true,
    installedVersion: manifest.version,
    publishStatus: 'none',
  }
  writeAgentPackageState(root, state)
}

function installEnabledCatalogPackage(slug: string = SLUG, version = '1.0.0'): SignedPackage {
  const signed = writeSignedPackage(slug, version)
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
  return signed
}

function revocation(slug: string, version: string, reason: string): AgentPackageRevocation {
  return { slug, version, reason, revokedAt: NOW }
}

function seedRevocationCache(items: AgentPackageRevocation[]): void {
  writeFileSync(
    agentCatalogRevocationsPath(root),
    `${JSON.stringify({ schemaVersion: 1, fetchedAt: NOW, items }, null, 2)}\n`,
    'utf8',
  )
}

// ---------------------------------------------------------------------------
// fake catalog client
// ---------------------------------------------------------------------------

const SETTINGS: AgentCatalogSettings = {
  agents_host: '127.0.0.1',
  agents_port: 1,
  agents_catalog_token: 'read-token',
  agents_catalog_publish_token: 'publish-token',
}

function fakeCatalogClient(overrides: Partial<AgentCatalogClient> = {}): AgentCatalogClient {
  return {
    listPackages: async () => [],
    getPackage: async (slug, version) => ({
      slug,
      version,
      status: 'published',
      displayName: `${slug} 助手`,
      description: '',
      size: 0,
      updatedAt: NOW,
    }),
    downloadBundleToFile: async () => {
      throw new Error('unused')
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
    ...overrides,
  }
}

function unreachableClient(): AgentCatalogClient {
  return fakeCatalogClient({
    getRevocations: async () => {
      throw new AgentCatalogClientError(AGENT_CATALOG_UNREACHABLE_ERROR, 'unreachable')
    },
  })
}

function configureCatalogBinding(client: AgentCatalogClient): void {
  configureAgentCatalog({
    profileDir: root,
    readSettings: () => SETTINGS,
    logger: () => undefined,
    client,
  })
}

/**
 * The REAL catalog client, backed by canned JSON pages instead of a socket, so
 * pagination and response normalization are exercised end to end. Pages are
 * served in order; the last one repeats if the client asks for more.
 */
function pagedCatalogClient(pages: ReadonlyArray<unknown>): {
  client: AgentCatalogClient
  requests: string[]
} {
  const requests: string[] = []
  let index = 0
  const client = createAgentCatalogClient({
    readSettings: () => SETTINGS,
    fetchImpl: async (input) => {
      requests.push(String(input))
      const body = pages[Math.min(index, pages.length - 1)]
      index += 1
      return new Response(`${JSON.stringify(body)}\n`, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    },
  })
  return { client, requests }
}

// ---------------------------------------------------------------------------
// host / turn fixtures
// ---------------------------------------------------------------------------

const EMPTY_AGENTS: AgentsHost = {
  list: () => ({ items: [] }),
  refresh: async () => ({ items: [] }),
  get: async () => undefined,
  setEnabled: () => {
    throw new Error('unused')
  },
  addEndpoint: () => {
    throw new Error('unused')
  },
  removeEndpoint: () => {
    throw new Error('unused')
  },
  snapshotForRuntime: () => ({ items: [] }),
}

type FakeActivation = {
  childId: string
  result: Promise<unknown>
  dispose: () => Promise<void>
}

type TurnHarness = {
  host: AgentPackageHost
  turns: AgentPackageActiveTurnRegistry
  runtimes: AgentPackageRuntimeRegistry
  ctx: unknown
  stopCalls: () => number
  activationStarts: () => number
  dispatchPkg: (pkg: AgentPackageDetail, sessionId?: string) => Promise<AgentPackageDispatchResult>
  dispatch: (sessionId?: string) => Promise<AgentPackageDispatchResult>
  pkg: () => Promise<AgentPackageDetail>
}

/**
 * `startActivation` 收到的启动面:足够让假 activation 像 `skills.ts` 的包装一样
 * 在同一段 await 里把预留子会话绑定回宿主。
 */
type FakeActivationStart = {
  /** 宿主传给 `startActivation` 的预留子会话 id;provider 沿用它时才走包包装。 */
  childId: string | undefined
  /** 包装在第一个 await 之前快照的包请求;`bindChild` 就在这个对象上。 */
  packageRequest: AgentPackageSubagentRequest | null
  /** 宿主与包装共享的附件表,包装在这里挂包工具。 */
  attachments: AttachmentMaps
}

type TurnHarnessOptions = {
  slug?: string
  security?: AgentCatalogSecurity
  turns?: AgentPackageActiveTurnRegistry
  createRuntime?: (options: StartAgentPackageProcessesOptions) => Promise<AgentPackageTurnRuntime>
  stopRuntime?: (runtime: AgentPackageTurnRuntime) => Promise<void>
  startActivation?: (start: FakeActivationStart) => Promise<FakeActivation>
}

function makeTurnHarness(options: TurnHarnessOptions = {}): TurnHarness {
  const slug = options.slug ?? SLUG
  const turns = options.turns ?? createAgentPackageActiveTurnRegistry()
  const runtimes = createAgentPackageRuntimeRegistry()
  let stopCalls = 0
  let activationStarts = 0
  const workspaceRoot = join(root, 'workspace')

  const host = createAgentPackageHost({
    profileDir: root,
    takenSlugs: () => [],
    legacy: () => EMPTY_AGENTS,
    registry: runtimes,
    activeTurns: turns,
    ...(options.security === undefined ? {} : { security: options.security }),
    createRuntime:
      options.createRuntime ??
      (async (startOptions) => ({
        slug: startOptions.manifest.slug,
        packageDir: startOptions.packageDir,
        workspaceRoot: startOptions.workspaceRoot,
        skillScripts: [],
        runSkillScript: async () => ({ text: '' }),
      })),
    stopRuntime:
      options.stopRuntime ??
      (async () => {
        stopCalls += 1
      }),
  })

  const ctx = {
    get: () => undefined,
    huaanworkWorkspaceRoot: { current: workspaceRoot },
    huaanworkAttachments: emptyAttachments(),
    huaanworkAgentPackageRequest: { current: null },
    huaanworkPackageChildSessions: new Set<string>(),
    subagents: {
      startActivation: async (spec: { childId?: string } = {}) => {
        activationStarts += 1
        // 与 `skills.ts` 一致:包请求在第一个 await 之前快照,activation 返回前
        // 由包装调用 `bindChild` —— 这正是取消期间晚到绑定的来源。
        const packageRequest = ctx.huaanworkAgentPackageRequest?.current ?? null
        if (options.startActivation !== undefined) {
          return options.startActivation({
            childId: spec.childId,
            packageRequest,
            attachments: ctx.huaanworkAttachments,
          })
        }
        return {
          childId: `child-${String(activationStarts)}`,
          result: Promise.resolve({}),
          dispose: async () => undefined,
        }
      },
    },
  }

  const dispatchPkg = (pkg: AgentPackageDetail, sessionId = 'parent-session') =>
    host.dispatch({
      ctx,
      sessionId,
      pkg,
      remainder: '写一份周报',
      resolveParent: async () => ({ id: 'parent-agent' }),
    } as never)

  const pkg = async () => {
    const found = await host.findInvocable(slug)
    if (found === undefined) throw new Error(`missing package ${slug}`)
    return found
  }

  return {
    host,
    turns,
    runtimes,
    ctx,
    stopCalls: () => stopCalls,
    activationStarts: () => activationStarts,
    dispatchPkg,
    dispatch: async (sessionId) => dispatchPkg(await pkg(), sessionId),
    pkg,
  }
}

function catalogSecurity(client: AgentCatalogClient, turns?: AgentPackageActiveTurnRegistry): AgentCatalogSecurity {
  return createAgentCatalogSecurity({
    profileDir: root,
    registry: turns ?? createAgentPackageActiveTurnRegistry(),
    client,
  })
}

function routeContext(): RouteContext {
  return {
    dshHome: join(root, 'dsh'),
    profileDir: root,
    workspaceRoot: { current: join(root, 'workspace') },
    emit: () => undefined,
    logger: () => undefined,
    requestRestart: async () => true,
  }
}

// ---------------------------------------------------------------------------
// 运行前复验
// ---------------------------------------------------------------------------

describe('catalog dispatch verification', () => {
  test('every catalog dispatch re-verifies the signed directory', async () => {
    const signed = installEnabledCatalogPackage()
    const harness = makeTurnHarness({ security: catalogSecurity(fakeCatalogClient()) })
    const stalePkg = await harness.pkg()
    expect(stalePkg.broken).toBeUndefined()

    const first = await harness.dispatchPkg(stalePkg)
    expect(first.text).toBe('写一份周报')
    await first.afterIdle()

    // 篡改人设:签名 digest 不再匹配,下一次 dispatch 必须重新验签并拒绝。
    writeFileSync(join(signed.packageDir, 'persona.md'), '被篡改的人设\n', 'utf8')
    await expect(harness.dispatchPkg(stalePkg)).rejects.toThrow(new RegExp(AGENT_PACKAGE_VERIFY_FAILURE))

    const refreshed = await harness.pkg()
    expect(refreshed.broken?.reason).toBe(AGENT_PACKAGE_VERIFY_FAILURE)
    await expect(harness.dispatch()).rejects.toThrow(new RegExp(AGENT_PACKAGE_VERIFY_FAILURE))
  })

  test('local packages run without a signature or a keyring', async () => {
    rmSync(join(root, AGENT_CATALOG_KEYRING_FILE))
    writeLocalPackage('local-agent')
    const harness = makeTurnHarness({ slug: 'local-agent', security: catalogSecurity(fakeCatalogClient()) })

    const dispatched = await harness.dispatch()
    expect(dispatched.text).toBe('写一份周报')
    await dispatched.afterIdle()
  })

  test('a missing keyring fails catalog packages closed and leaves local packages runnable', async () => {
    installEnabledCatalogPackage()
    writeLocalPackage('local-agent')
    rmSync(join(root, AGENT_CATALOG_KEYRING_FILE))
    const security = catalogSecurity(fakeCatalogClient())

    const catalogHarness = makeTurnHarness({ security })
    const catalogPkg = await catalogHarness.pkg()
    expect(catalogPkg.broken?.reason).toBe(AGENT_PACKAGE_VERIFY_FAILURE)
    await expect(catalogHarness.dispatch()).rejects.toThrow(new RegExp(AGENT_PACKAGE_VERIFY_FAILURE))

    const localHarness = makeTurnHarness({ slug: 'local-agent', security })
    const local = await localHarness.dispatch()
    expect(local.text).toBe('写一份周报')
    await local.afterIdle()
  })
})

// ---------------------------------------------------------------------------
// 运行前身份绑定
// ---------------------------------------------------------------------------

describe('catalog installed identity binding', () => {
  test('refuses to run when the directory is a valid signed v2 but state says v1', async () => {
    installEnabledCatalogPackage(SLUG, '1.0.0')
    // 目录被换成一份**验签通过**的 1.0.1:签名本身没问题,但 state 仍说 1.0.0。
    writeSignedPackage(SLUG, '1.0.1')

    const security = catalogSecurity(fakeCatalogClient())
    await expect(security.assertRunnable(SLUG, '1.0.0')).rejects.toThrow(
      new RegExp(AGENT_PACKAGE_VERIFY_FAILURE),
    )
  })

  test('refuses to run when the disk version is requested but state names another version', async () => {
    installEnabledCatalogPackage(SLUG, '1.0.0')
    // dispatch 传进来的版本来自磁盘(`findInvocable` → `host.dispatch`),所以
    // 未更新的 state 会让请求身份与已安装身份错位:这里请求 1.0.1、磁盘也是
    // 验签通过的 1.0.1,但 state 仍说 1.0.0 ⇒ 必须拒绝,而不是只靠 digest 版本腿。
    writeSignedPackage(SLUG, '1.0.1')
    expect(readAgentPackageState(root)[`catalog:${SLUG}`]?.installedVersion).toBe('1.0.0')

    const security = catalogSecurity(fakeCatalogClient())
    await expect(security.assertRunnable(SLUG, '1.0.1')).rejects.toThrow(
      new RegExp(AGENT_PACKAGE_VERIFY_FAILURE),
    )
  })

  test('refuses to run a valid directory with no catalog state entry', async () => {
    // 目录本身验签通过,但 state 里没有 `catalog:<slug>` 条目:没有可绑定的
    // 已安装身份 ⇒ fail closed,不能把「目录看起来没问题」当成可运行。
    writeSignedPackage(SLUG, '1.0.0')
    expect(readAgentPackageState(root)[`catalog:${SLUG}`]).toBeUndefined()

    const security = catalogSecurity(fakeCatalogClient())
    await expect(security.assertRunnable(SLUG, '1.0.0')).rejects.toThrow(
      new RegExp(AGENT_PACKAGE_VERIFY_FAILURE),
    )
  })

  test('refuses to run a revoked version even when state and directory agree', async () => {
    installEnabledCatalogPackage(SLUG, '1.0.1')
    const security = catalogSecurity(
      fakeCatalogClient({ getRevocations: async () => [revocation(SLUG, '1.0.1', '新版脚本外传数据')] }),
    )
    await security.refreshRevocations()

    await expect(security.assertRunnable(SLUG, '1.0.1')).rejects.toThrow(/该版本已被管理员撤销：新版脚本外传数据/)
  })

  test('refuses to run a signed package whose digest belongs to another slug', async () => {
    // 另一个 slug 的合法签名包落在本 slug 的正式目录里:digest.slug 对不上。
    writeSignedPackage('other-agent', '1.0.0', SLUG)
    writeAgentPackageState(root, {
      ...readAgentPackageState(root),
      [`catalog:${SLUG}`]: {
        source: 'catalog',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'installed',
      },
    })

    const security = catalogSecurity(fakeCatalogClient())
    await expect(security.assertRunnable(SLUG, '1.0.0')).rejects.toThrow(
      new RegExp(AGENT_PACKAGE_VERIFY_FAILURE),
    )
  })

  test('refuses to run when the verified digest changes between the two checks', async () => {
    installEnabledCatalogPackage(SLUG, '1.0.0')
    const v1 = digestFor(SLUG, '1.0.0')
    const v2 = digestFor(SLUG, '1.0.1')
    let verifyCalls = 0
    const security = createAgentCatalogSecurity({
      profileDir: root,
      registry: createAgentPackageActiveTurnRegistry(),
      client: fakeCatalogClient(),
      verify: async (): Promise<AgentPackageVerification> => {
        verifyCalls += 1
        if (verifyCalls === 1) return { ok: true, digest: v1, signature: {} as CatalogSignature }
        // 第一次与第二次复验之间目录被换成 1.0.1:digest 必须逐字节一致。
        writeSignedPackage(SLUG, '1.0.1')
        return { ok: true, digest: v2, signature: {} as CatalogSignature }
      },
    })

    await expect(security.assertRunnable(SLUG, '1.0.0')).rejects.toThrow(
      new RegExp(AGENT_PACKAGE_VERIFY_FAILURE),
    )
    expect(verifyCalls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 撤销
// ---------------------------------------------------------------------------

describe('catalog revocations', () => {
  test('unconfigured catalog root skips the refresh without a false warning', async () => {
    let getRevocationCalls = 0
    const client = fakeCatalogClient({
      getRevocations: async () => {
        getRevocationCalls += 1
        return []
      },
    })
    // M1-only 用户:设置面从未配置 agents_host/agents_port。绑定仍在(client 可
    // 用),但安全面必须按「未配置」跳过 —— 否则每轮刷新都报「目录不可达」。
    configureAgentCatalog({
      profileDir: root,
      readSettings: () => ({
        agents_host: '',
        agents_port: 0,
        agents_catalog_token: '',
        agents_catalog_publish_token: '',
      }),
      logger: () => undefined,
      client,
    })
    const security = createAgentCatalogSecurity({
      profileDir: root,
      registry: createAgentPackageActiveTurnRegistry(),
    })

    const result = await security.refreshRevocations()
    expect(result).toEqual({})
    expect(getRevocationCalls).toBe(0)
    // 未配置不等于出错:没有 warning,也没有落盘缓存。
    expect(readdirSync(root).filter((name) => name.startsWith('agent-catalog-revocations'))).toEqual([])
  })

  test('a cancel request releases the session reservation before dispose settles', async () => {
    installEnabledCatalogPackage()
    const turns = createAgentPackageActiveTurnRegistry()
    const security = catalogSecurity(fakeCatalogClient(), turns)
    const disposeGate = deferred<void>()
    let disposeCalls = 0
    let activationIndex = 0
    const harness = makeTurnHarness({
      security,
      turns,
      startActivation: async () => {
        activationIndex += 1
        const index = activationIndex
        return {
          childId: `child-${String(index)}`,
          result: index === 1 ? new Promise(() => undefined) : Promise.resolve({}),
          dispose: async () => {
            disposeCalls += 1
            if (index === 1) await disposeGate.promise
          },
        }
      },
    })

    const first = await harness.dispatch()
    expect(first.afterIdle).toBeTypeOf('function')

    // 取消请求(不 await):收尾会卡在 activation dispose 上。名额必须在
    // 请求时刻同步释放,否则下一条消息会被「已有运行中的智能体包回合」拒绝。
    const cancelling = harness.turns.cancelBySessionId('parent-session', 'cancel')
    const second = await harness.dispatch()
    expect(second.text).toContain('写一份周报')

    disposeGate.resolve()
    await cancelling
    expect(disposeCalls).toBeGreaterThanOrEqual(1)
    await second.afterIdle()
  })

  test('revocation aborts an in-flight dispatch with the revocation reason', async () => {
    installEnabledCatalogPackage()
    const activationGate = deferred<FakeActivation>()
    const turns = createAgentPackageActiveTurnRegistry()
    const security = catalogSecurity(
      fakeCatalogClient({ getRevocations: async () => [revocation(SLUG, '1.0.0', '不安全脚本')] }),
      turns,
    )
    let disposeCalls = 0
    const harness = makeTurnHarness({
      security,
      turns,
      startActivation: async () => {
        const activation = await activationGate.promise
        return activation
      },
    })

    const running = harness.dispatch()
    await waitFor(() => harness.activationStarts() === 1, 'startActivation 被调用')

    await security.refreshRevocations()
    // 取消发生在 activation 返回前;晚到的 activation 必须被立即 dispose。
    activationGate.resolve({
      childId: 'child-late',
      result: new Promise(() => undefined),
      dispose: async () => {
        disposeCalls += 1
      },
    })

    await expect(running).rejects.toThrow(/该版本已被管理员撤销：不安全脚本/)
    expect(harness.stopCalls()).toBe(1)
    expect(disposeCalls).toBe(1)
    expect(readAgentPackageState(root)[`catalog:${SLUG}`]?.enabled).toBe(false)
    expect(readAgentPackageState(root)[`catalog:${SLUG}`]?.revoked?.reason).toBe('不安全脚本')

    await expect(harness.dispatch()).rejects.toThrow(/该版本已被管理员撤销：不安全脚本/)
  })

  test('revocation disposes a live activation without waiting for its graceful result', async () => {
    installEnabledCatalogPackage()
    const turns = createAgentPackageActiveTurnRegistry()
    const security = catalogSecurity(
      fakeCatalogClient({ getRevocations: async () => [revocation(SLUG, '1.0.0', '不安全脚本')] }),
      turns,
    )
    let disposeCalls = 0
    const harness = makeTurnHarness({
      security,
      turns,
      startActivation: async () => ({
        childId: 'child',
        // 永不结算:若取消链路先等 graceful result,这个用例会挂到超时。
        result: new Promise(() => undefined),
        dispose: async () => {
          disposeCalls += 1
        },
      }),
    })
    const dispatched = await harness.dispatch()
    expect(disposeCalls).toBe(0)

    const startedAt = Date.now()
    await security.refreshRevocations()
    expect(Date.now() - startedAt).toBeLessThan(2_000)

    expect(disposeCalls).toBe(1)
    expect(harness.stopCalls()).toBe(1)
    expect(harness.runtimes.get('parent-session')).toBeUndefined()
    expect(readAgentPackageState(root)[`catalog:${SLUG}`]?.enabled).toBe(false)

    // afterIdle 幂等,且不会因为未结算的 result 再次等待。
    await dispatched.afterIdle()
  })

  test('a runtime that resolves after cancellation is stopped and never activated', async () => {
    installEnabledCatalogPackage()
    const runtimeGate = deferred<AgentPackageTurnRuntime>()
    let createStarted = false
    const turns = createAgentPackageActiveTurnRegistry()
    const security = catalogSecurity(
      fakeCatalogClient({ getRevocations: async () => [revocation(SLUG, '1.0.0', '不安全脚本')] }),
      turns,
    )
    const harness = makeTurnHarness({
      security,
      turns,
      createRuntime: async () => {
        createStarted = true
        return runtimeGate.promise
      },
    })

    const running = harness.dispatch()
    await waitFor(() => createStarted, 'createRuntime 被调用')
    await security.refreshRevocations()
    runtimeGate.resolve({
      slug: SLUG,
      packageDir: agentPackageDir(root, SLUG),
      workspaceRoot: join(root, 'workspace'),
      skillScripts: [],
      runSkillScript: async () => ({ text: '' }),
    })

    await expect(running).rejects.toThrow(/该版本已被管理员撤销：不安全脚本/)
    expect(harness.stopCalls()).toBe(1)
    expect(harness.activationStarts()).toBe(0)
    expect(harness.runtimes.get('parent-session')).toBeUndefined()

    // 占位已释放;下一次 dispatch 在撤销后按规范拒绝,而不是「回合运行中」。
    await expect(harness.dispatch()).rejects.toThrow(/该版本已被管理员撤销/)
  })

  test('a cancel during startActivation clears the wrapper’s late child binding', async () => {
    installEnabledCatalogPackage()
    const turns = createAgentPackageActiveTurnRegistry()
    const security = catalogSecurity(
      fakeCatalogClient({ getRevocations: async () => [revocation(SLUG, '1.0.0', '不安全脚本')] }),
      turns,
    )
    const activationStarted = deferred<void>()
    const resumeWrapper = deferred<void>()
    let disposeCalls = 0
    let lateChildId: string | undefined
    let attachedDuringWrapper = false
    const harness = makeTurnHarness({
      security,
      turns,
      startActivation: async ({ childId, packageRequest, attachments }) => {
        lateChildId = childId
        activationStarted.resolve()
        await resumeWrapper.promise
        // 包装恢复:与 skills.ts 同序 —— 先挂工具,再 bindChild(childSessionId)。
        if (childId !== undefined) {
          attachAgentTools(attachments, childId, ['agent_http'])
          packageRequest?.bindChild(childId)
          attachedDuringWrapper = attachments.sessionAgentTools.has(childId)
        }
        return {
          childId: childId ?? 'child',
          result: new Promise(() => undefined),
          dispose: async () => {
            disposeCalls += 1
          },
        }
      },
    })

    const running = harness.dispatch()
    await activationStarted.promise

    // 取消落在 startActivation 期间:第一次 cleanup 跑完时 activation 还不存在,
    // 预留子会话的解绑与标记清除已经发生过一次。
    await security.refreshRevocations()
    expect(disposeCalls).toBe(0)

    // 包装此刻才恢复,把已被清掉的预留子会话重新挂回宿主(这就是泄漏形状)。
    resumeWrapper.resolve()
    await expect(running).rejects.toThrow(/该版本已被管理员撤销：不安全脚本/)

    expect(attachedDuringWrapper).toBe(true)
    expect(lateChildId).toBeDefined()
    const childId = lateChildId as string
    // 晚到 activation 只 dispose 一次;它的绑定必须在抛出前被再清一遍。
    expect(disposeCalls).toBe(1)
    expect(harness.stopCalls()).toBe(1)
    const ctx = harness.ctx as {
      huaanworkPackageChildSessions: Set<string>
      huaanworkAttachments: AttachmentMaps
    }
    expect(ctx.huaanworkPackageChildSessions.has(childId)).toBe(false)
    expect(ctx.huaanworkAttachments.sessionAgentTools.has(childId)).toBe(false)
    expect(harness.runtimes.get(childId)).toBeUndefined()
    expect(harness.runtimes.get('parent-session')).toBeUndefined()
  })

  test('a revocation that lands while verifying is not missed (generation re-check)', async () => {
    installEnabledCatalogPackage()
    const verifiedDigest = digestFor(SLUG)
    const verifyStarted = deferred<void>()
    const verifyGate = deferred<void>()
    let verifyCalls = 0
    const security = createAgentCatalogSecurity({
      profileDir: root,
      registry: createAgentPackageActiveTurnRegistry(),
      client: fakeCatalogClient({ getRevocations: async () => [revocation(SLUG, '1.0.0', '竞态撤销')] }),
      verify: async (): Promise<AgentPackageVerification> => {
        verifyCalls += 1
        if (verifyCalls === 1) {
          verifyStarted.resolve()
          await verifyGate.promise
        }
        return { ok: true, digest: verifiedDigest, signature: {} as CatalogSignature }
      },
    })

    const pending = security.assertRunnable(SLUG, '1.0.0')
    await verifyStarted.promise
    // 复验进行中到达撤销:state 与 generation 同步落地。
    await security.refreshRevocations()
    verifyGate.resolve()

    // 复验本身返回 ok;是复检 generation 后的撤销检查让这次运行被拒绝。
    // 每次尝试先验签再复验 digest,所以这里看到两次 verify。
    await expect(pending).rejects.toThrow(/该版本已被管理员撤销：竞态撤销/)
    expect(verifyCalls).toBe(2)
  })

  test('offline refresh uses the cached revocations and reports a warning', async () => {
    installEnabledCatalogPackage()
    seedRevocationCache([revocation(SLUG, '1.0.0', '缓存撤销')])
    const security = catalogSecurity(unreachableClient())

    const result = await security.refreshRevocations()
    expect(result.warning ?? '').toMatch(/目录不可达/)
    await expect(security.assertRunnable(SLUG, '1.0.0')).rejects.toThrow(/缓存撤销/)
    expect(readAgentPackageState(root)[`catalog:${SLUG}`]?.enabled).toBe(false)
  })

  test('follows every revocation page before the list counts as complete', async () => {
    const { client, requests } = pagedCatalogClient([
      {
        items: [{ slug: 'alpha', version: '1.0.0', reason: '第一页', revokedAt: NOW, actor: 'admin-hash' }],
        nextCursor: 'page-two',
      },
      {
        items: [
          { slug: 'bravo', version: '1.0.0', reason: '第二页', revokedAt: NOW },
          { slug: 'charlie', version: '1.0.0', reason: '第二页', revokedAt: NOW },
        ],
      },
    ])

    await expect(client.getRevocations()).resolves.toEqual([
      { slug: 'alpha', version: '1.0.0', reason: '第一页', revokedAt: NOW },
      { slug: 'bravo', version: '1.0.0', reason: '第二页', revokedAt: NOW },
      { slug: 'charlie', version: '1.0.0', reason: '第二页', revokedAt: NOW },
    ])
    // One page per cursor round trip, never a single unpaginated request.
    expect(requests).toHaveLength(2)
    expect(requests[0]).toContain('limit=200')
    expect(requests[0]).not.toContain('cursor=')
    expect(requests[1]).toContain(`cursor=${encodeURIComponent('page-two')}`)
  })

  test('rejects any malformed revocation item instead of truncating the list', async () => {
    const malformed = [
      // Missing field.
      { slug: 'missing-field', version: '1.0.0', reason: 'x' },
      // Wrong type.
      { slug: 'wrong-type', version: 1, reason: 'x', revokedAt: NOW },
      // Empty required string.
      { slug: 'empty-reason', version: '1.0.0', reason: '', revokedAt: NOW },
      { slug: '', version: '1.0.0', reason: 'x', revokedAt: NOW },
      // Not an object at all.
      'not-a-revocation',
    ]
    for (const item of malformed) {
      const { client } = pagedCatalogClient([{ items: [item] }])
      await expect(client.getRevocations()).rejects.toThrow('目录响应格式错误')
    }
  })

  test('rejects a server that never stops paginating', async () => {
    // Same page every time: the client must stop at its page bound instead of
    // looping forever (an unbounded refresh would hang the startup path).
    const { client, requests } = pagedCatalogClient([
      {
        items: [{ slug: 'alpha', version: '1.0.0', reason: '永远下一页', revokedAt: NOW }],
        nextCursor: 'always-more',
      },
    ])
    await expect(client.getRevocations()).rejects.toThrow('撤销列表分页超过上限')
    expect(requests).toHaveLength(500)
  })

  test('keeps the previous revocation cache when any page is malformed', async () => {
    installEnabledCatalogPackage()
    // A successful refresh establishes the bytes this test protects.
    const first = catalogSecurity(
      fakeCatalogClient({ getRevocations: async () => [revocation(SLUG, '1.0.0', '首次成功')] }),
    )
    expect(await first.refreshRevocations()).toEqual({})
    const cachePath = agentCatalogRevocationsPath(root)
    const cacheBefore = readFileSync(cachePath)

    // Page 1 is valid and carries a cursor; the client must follow it and hit
    // the malformed second page, which rejects the whole refresh.
    const { client } = pagedCatalogClient([
      {
        items: [{ slug: 'delta', version: '1.0.0', reason: '第一页', revokedAt: NOW }],
        nextCursor: 'next-page',
      },
      { items: [{ slug: 'x', version: 1, reason: '坏条目', revokedAt: NOW }] },
    ])
    configureCatalogBinding(client)
    const second = createAgentCatalogSecurity({
      profileDir: root,
      registry: createAgentPackageActiveTurnRegistry(),
    })
    const result = await second.refreshRevocations()

    expect(result.warning ?? '').toMatch(/撤销列表刷新失败/)
    expect(result.warning ?? '').toMatch(/目录响应格式错误/)
    // Fail closed: the cache bytes are untouched and the earlier revocation
    // still blocks the installed version.
    expect(readFileSync(cachePath).equals(cacheBefore)).toBe(true)
    const state = readAgentPackageState(root)[`catalog:${SLUG}`]
    expect(state?.enabled).toBe(false)
    expect(state?.revoked?.reason).toBe('首次成功')
    await expect(second.assertRunnable(SLUG, '1.0.0')).rejects.toThrow(/首次成功/)
  })

  test('a corrupt cache is backed up with a warning instead of being treated as empty', async () => {
    installEnabledCatalogPackage()
    seedRevocationCache([revocation(SLUG, '1.0.0', '旧撤销')])
    const security = catalogSecurity(fakeCatalogClient())
    expect(security.loadCachedRevocations().warning).toBeUndefined()
    await expect(security.assertRunnable(SLUG, '1.0.0')).rejects.toThrow(/旧撤销/)

    // 缓存被改坏:必须备份并告警,且不能把内存/状态里的撤销当成空列表清掉。
    writeFileSync(agentCatalogRevocationsPath(root), '{ not json', 'utf8')
    const loaded = security.loadCachedRevocations()
    expect(loaded.warning ?? '').toMatch(/备份/)
    const backups = readdirSync(root).filter((name) => name.includes('.corrupt-'))
    expect(backups).toHaveLength(1)
    await expect(security.assertRunnable(SLUG, '1.0.0')).rejects.toThrow(/旧撤销/)
  })

  test('delisted only changes publishStatus, does not abort, and still runs', async () => {
    installEnabledCatalogPackage()
    configureCatalogBinding(
      fakeCatalogClient({
        getPackage: async (slug, version) => ({
          slug,
          version,
          status: 'delisted',
          displayName: `${slug} 助手`,
          description: '',
          size: 0,
          updatedAt: NOW,
        }),
      }),
    )
    const refreshed = await refreshInstalledCatalogPackageStatuses()
    expect(refreshed.changed).toBe(true)
    expect(readAgentPackageState(root)[`catalog:${SLUG}`]).toMatchObject({
      enabled: true,
      publishStatus: 'delisted',
    })

    const security = catalogSecurity(fakeCatalogClient())
    const harness = makeTurnHarness({ security })
    const dispatched = await harness.dispatch()
    expect(dispatched.text).toBe('写一份周报')
    await dispatched.afterIdle()
  })

  test('cancelBySlug cancels every matching record, not just the first', async () => {
    installEnabledCatalogPackage()
    const turns = createAgentPackageActiveTurnRegistry()
    const security = catalogSecurity(fakeCatalogClient(), turns)
    let disposeCalls = 0
    const harness = makeTurnHarness({
      security,
      turns,
      startActivation: async () => ({
        childId: 'child',
        result: new Promise(() => undefined),
        dispose: async () => {
          disposeCalls += 1
        },
      }),
    })

    await harness.dispatch('session-a')
    await harness.dispatch('session-b')
    expect(harness.runtimes.get('session-a')).toBeDefined()
    expect(harness.runtimes.get('session-b')).toBeDefined()

    const stopPromise = security.stopAgentPackageTurnsForSlug(SLUG, 'remove')
    await stopPromise

    expect(disposeCalls).toBe(2)
    expect(harness.stopCalls()).toBe(2)
    expect(harness.runtimes.get('session-a')).toBeUndefined()
    expect(harness.runtimes.get('session-b')).toBeUndefined()

    // 两条登记都已注销:同一 session 可以开始新回合。
    const again = await harness.dispatch('session-a')
    expect(again.text).toBe('写一份周报')
    await security.stopAgentPackageTurnsForSlug(SLUG, 'remove')
  })

  test('a revocation recorded for an older installed version does not block the updated package', async () => {
    installEnabledCatalogPackage()
    // 更新到 1.0.0 后 state 里仍残留 0.9.9 的 revoked(Task 9 的更新保留 M2 字段)。
    const state = readAgentPackageState(root)
    state[`catalog:${SLUG}`] = { ...state[`catalog:${SLUG}`]!, revoked: revocation(SLUG, '0.9.9', '旧版本撤销') }
    writeAgentPackageState(root, state)

    const harness = makeTurnHarness({ security: catalogSecurity(fakeCatalogClient()) })
    const pkg = await harness.pkg()
    expect(pkg.broken).toBeUndefined()
    expect(pkg.revoked).toBeUndefined()

    const dispatched = await harness.dispatch()
    expect(dispatched.text).toBe('写一份周报')
    await dispatched.afterIdle()
  })

  test('revocation removes the package from the @ completion list', async () => {
    installEnabledCatalogPackage()
    const turns = createAgentPackageActiveTurnRegistry()
    const security = catalogSecurity(
      fakeCatalogClient({ getRevocations: async () => [revocation(SLUG, '1.0.0', '不安全脚本')] }),
      turns,
    )
    const harness = makeTurnHarness({ security, turns })
    const before = await harness.host.invocableWithLegacy()
    expect(before.items.map((item) => item.name)).toContain(SLUG)

    await security.refreshRevocations()

    const after = await harness.host.invocableWithLegacy()
    expect(after.items.map((item) => item.name)).not.toContain(SLUG)
    const listed = await harness.host.listWithLegacy()
    expect(listed.packages.find((item) => item.slug === SLUG)?.broken?.reason).toMatch(/已被管理员撤销/)
    // 详情仍然可读(界面需要展示撤销卡片与移除入口),但不能重新启用。
    expect(await harness.host.findInvocable(SLUG)).toBeDefined()
    expect(() => harness.host.setEnabled(SLUG, true)).toThrow(/已被管理员撤销/)
  })
})

// ---------------------------------------------------------------------------
// session.cancel 走同一 registry
// ---------------------------------------------------------------------------

describe('session cancellation', () => {
  test('session.cancel releases the package turn through the shared registry', async () => {
    installEnabledCatalogPackage()
    const turns = createAgentPackageActiveTurnRegistry()
    setAgentPackageActiveTurns(turns)
    const security = catalogSecurity(fakeCatalogClient(), turns)
    let disposeCalls = 0
    const harness = makeTurnHarness({
      security,
      turns,
      startActivation: async () => ({
        childId: 'child',
        result: new Promise(() => undefined),
        dispose: async () => {
          disposeCalls += 1
        },
      }),
    })
    await harness.dispatch('parent-session')

    sessionCancel({} as never, routeContext(), { sessionId: 'parent-session' })
    await waitFor(() => disposeCalls === 1 && harness.stopCalls() === 1, 'session.cancel 释放回合')

    // 占位已释放:同一 session 可以立刻开新回合,不需要等 afterIdle。
    const next = await harness.dispatch('parent-session')
    expect(next.text).toBe('写一份周报')
    await security.stopAgentPackageTurnsForSlug(SLUG, 'remove')
  })
})
