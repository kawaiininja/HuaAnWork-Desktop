import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  buildSignedAgentPackageBundle,
  buildUnsignedAgentPackageBundle,
  MAX_AGENT_PACKAGE_BUNDLE_BYTES,
} from '@huaanwork/agent-package-format/bundle'
import { createAgentPackageDigest, type AgentPackageFile } from '@huaanwork/agent-package-format/digest'
import type { AgentPackageManifest } from '@huaanwork/agent-package-format/manifest'
import {
  canonicalJson,
  fingerprintPublicKeyHex,
  generateKeyPair,
  signAgentPackageDigest,
  type GeneratedKeyPair,
} from '@huaanwork/catalog-signing'

import {
  configureAgentCatalog,
  resetAgentCatalogForTests,
  type AgentCatalogSettings,
} from '../../src/huaanwork-host/agent-package/catalog-client.ts'
import {
  AGENT_CATALOG_KEYRING_FILE,
  AGENT_PACKAGE_VERIFY_FAILURE,
  installCatalogAgentPackage,
  readCatalogKeyring,
  recoverCatalogPackageInstalls,
  refreshInstalledCatalogPackageStatuses,
  removeCatalogAgentPackage,
  updateCatalogAgentPackage,
  type AgentPackageTurnStopper,
} from '../../src/huaanwork-host/agent-package/catalog-install.ts'
import { createAgentPackageHost } from '../../src/huaanwork-host/agent-package/host.ts'
import {
  agentPackageDir,
  agentPackageStatePath,
  readAgentPackage,
  readAgentPackageState,
  readAgentPackageVersionFromDir,
  setAgentPackageEnabled,
  writeAgentPackageState,
} from '../../src/huaanwork-host/agent-package/store.ts'
import type { AgentPackageStateEntry } from '../../src/huaanwork-host/agent-package/types.ts'
import { agentsEnabledPath } from '../../src/huaanwork-host/agents-host.ts'

/**
 * Task 9:验签安装、更新、移除、legacy 迁移与崩溃恢复。
 *
 * 全部用真实 profile 目录 + 随机端口上的 HTTP 目录;签名用测试期生成的
 * Ed25519 密钥对,bundle 由共享 `@huaanwork/agent-package-format` 构造。
 * 生产私钥、生产 token 与真实目录不进 fixture。
 */

const NOW = '2026-10-25T00:00:00.000Z'
const READ_TOKEN = 'test-read-token-0123456789abcdef'
const PUBLISH_TOKEN = 'test-publish-token-0123456789abcdef'

type OfferedStatus = 'published' | 'delisted' | 'revoked'

type OfferedPackage = {
  slug: string
  version: string
  status: OfferedStatus
  migrationFrom?: string
  bundle: Buffer
}

type OfferOptions = {
  status?: OfferedStatus
  migrationFrom?: string
  signWith?: GeneratedKeyPair
  /** 篡改内容 / 额外文件:digest 按未篡改的文件计算,验签必须失败。 */
  tamper?: 'persona' | 'extra'
  bundleOverride?: Buffer
  versionInManifest?: string
}

let root = ''
let server: Server | undefined
let port = 0
let keyPair: GeneratedKeyPair
let packages: OfferedPackage[] = []
let revocations: unknown[] = []
let oversizedBundle = false
let bundleGate: Promise<void> | undefined
let loggerLines: string[] = []

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'agent-package-catalog-install-'))
  packages = []
  revocations = []
  oversizedBundle = false
  bundleGate = undefined
  loggerLines = []
  resetAgentCatalogForTests()
  keyPair = generateKeyPair()
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

  server = createServer((request, response) => {
    void handleRequest(request, response)
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind a port')
  port = address.port
  configureAgentCatalog({
    profileDir: root,
    readSettings: () => settings(),
    logger: (line) => loggerLines.push(line),
  })
})

afterEach(async () => {
  resetAgentCatalogForTests()
  await stopCatalogServer()
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 目录与服务端替身
// ---------------------------------------------------------------------------

function settings(): AgentCatalogSettings {
  return {
    agents_host: '127.0.0.1',
    agents_port: port,
    agents_catalog_token: READ_TOKEN,
    agents_catalog_publish_token: PUBLISH_TOKEN,
  }
}

async function stopCatalogServer(): Promise<void> {
  const current = server
  server = undefined
  if (current === undefined) return
  await new Promise<void>((resolve) => {
    current.close(() => resolve())
    current.closeAllConnections()
  })
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  response.on('error', () => undefined)
  request.on('error', () => undefined)
  for await (const _chunk of request) {
    // 读掉请求体;本测试的目录只有 GET。
  }
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname

  if (request.method === 'GET' && pathname === '/v1/agent-packages') {
    sendJson(response, 200, {
      items: packages
        .filter((pkg) => pkg.status === 'published')
        .map((pkg) => ({
          slug: pkg.slug,
          displayName: `${pkg.slug} 助手`,
          description: '来自签名广场',
          version: pkg.version,
          size: pkg.bundle.byteLength,
          status: 'published',
          updatedAt: NOW,
          ...(pkg.migrationFrom === undefined ? {} : { migrationFrom: pkg.migrationFrom }),
        })),
    })
    return
  }

  if (request.method === 'GET' && pathname === '/v1/agent-packages/revocations') {
    sendJson(response, 200, { items: revocations })
    return
  }

  const bundleMatch = /^\/v1\/agent-packages\/([^/]+)\/([^/]+)\/bundle$/.exec(pathname)
  if (request.method === 'GET' && bundleMatch !== null) {
    const slug = decodeURIComponent(bundleMatch[1] ?? '')
    const version = decodeURIComponent(bundleMatch[2] ?? '')
    const pkg = findOffered(slug, version)
    if (pkg === undefined || pkg.status !== 'published') {
      sendJson(response, 404, { error: 'Not Found', code: 'not-found' })
      return
    }
    if (bundleGate !== undefined) await bundleGate
    if (oversizedBundle) {
      response.writeHead(200, {
        'content-type': 'application/gzip',
        'content-length': String(MAX_AGENT_PACKAGE_BUNDLE_BYTES + 1),
      })
      response.end()
      return
    }
    response.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': String(pkg.bundle.byteLength),
    })
    response.end(pkg.bundle)
    return
  }

  const metadataMatch = /^\/v1\/agent-packages\/([^/]+)\/([^/]+)$/.exec(pathname)
  if (request.method === 'GET' && metadataMatch !== null) {
    const slug = decodeURIComponent(metadataMatch[1] ?? '')
    const version = decodeURIComponent(metadataMatch[2] ?? '')
    const pkg = findOffered(slug, version)
    if (pkg === undefined) {
      sendJson(response, 404, { error: 'Not Found', code: 'not-found' })
      return
    }
    sendJson(response, 200, {
      slug,
      version,
      status: pkg.status,
      displayName: `${slug} 助手`,
      description: '来自签名广场',
      size: pkg.bundle.byteLength,
      updatedAt: NOW,
      ...(pkg.migrationFrom === undefined ? {} : { migrationFrom: pkg.migrationFrom }),
      ...(pkg.status === 'published'
        ? { bundleUrl: `/v1/agent-packages/${encodeURIComponent(slug)}/${encodeURIComponent(version)}/bundle` }
        : {}),
    })
    return
  }

  sendJson(response, 404, { error: 'Not Found', code: 'not-found' })
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(`${JSON.stringify(body)}\n`)
}

function findOffered(slug: string, version: string): OfferedPackage | undefined {
  return packages.find((pkg) => pkg.slug === slug && pkg.version === version)
}

type Deferred = { promise: Promise<void>; release: () => void }

function deferred(): Deferred {
  let release = (): void => undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`等待超时:${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// ---------------------------------------------------------------------------
// 签名包 fixture
// ---------------------------------------------------------------------------

function manifestFor(slug: string, version: string): AgentPackageManifest {
  return {
    schemaVersion: 1,
    slug,
    displayName: `${slug} 助手`,
    description: '来自签名广场的测试智能体',
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
    { path: 'persona.md', data: Buffer.from(`# ${manifest.displayName}\n\n来自签名广场。\n`, 'utf8') },
  ]
}

async function signedBundle(slug: string, version: string, options: OfferOptions = {}): Promise<Buffer> {
  const manifest = manifestFor(slug, options.versionInManifest ?? version)
  const files = filesFor(manifest)
  const digest = createAgentPackageDigest(manifest, files)
  const signer = options.signWith ?? keyPair
  const signature = signAgentPackageDigest(digest, {
    privateKeyPem: signer.privateKeyPem,
    slot: 1,
    signedAt: NOW,
  })
  let bundled: AgentPackageFile[] = files
  if (options.tamper === 'extra') bundled = [...files, { path: 'notes.txt', data: Buffer.from('额外文件\n') }]
  if (options.tamper === 'persona') {
    bundled = files.map((file) =>
      file.path === 'persona.md' ? { path: 'persona.md', data: Buffer.from('被篡改的人设\n') } : file,
    )
  }
  return buildSignedAgentPackageBundle(bundled, digest, signature)
}

/**
 * 旧服务端能产出的 signed bundle:签名前不做安装条目预算预检,所以 1022 个内容
 * 文件(安装后 1025 个条目)的包曾经可以发布。当前 builder 会在签名前拒绝该输入,
 * 因此这里用公共 builder 打 unsigned 归档,再在 tar 的两个 EOF 块前追加签名
 * 文件;digest 与签名仍是真实有效的,安装侧必须自行拒绝。
 */
async function makeBundleWithFileCount(
  slug: string,
  version: string,
  count: number,
): Promise<Buffer> {
  const manifest = manifestFor(slug, version)
  const files: AgentPackageFile[] = [
    ...filesFor(manifest),
    ...Array.from({ length: count - 2 }, (_, index) => ({
      path: `filler-${String(index).padStart(4, '0')}.md`,
      data: Buffer.alloc(0),
    })),
  ]
  const digest = createAgentPackageDigest(manifest, files)
  const signature = signAgentPackageDigest(digest, {
    privateKeyPem: keyPair.privateKeyPem,
    slot: 1,
    signedAt: NOW,
  })
  const raw = gunzipSync(await buildUnsignedAgentPackageBundle(files))
  const trailer = Buffer.alloc(1024)
  if (!raw.subarray(raw.byteLength - trailer.byteLength).equals(trailer)) {
    throw new Error('unexpected tar trailer')
  }
  return gzipSync(Buffer.concat([
    raw.subarray(0, raw.byteLength - trailer.byteLength),
    tarFileBlocks('.signature/package-digest.json', Buffer.from(canonicalJson(digest), 'utf8')),
    tarFileBlocks('.signature/signature.json', Buffer.from(JSON.stringify(signature), 'utf8')),
    trailer,
  ]))
}

/** 单个普通文件的 POSIX ustar 头 + 512 字节对齐正文。 */
function tarFileBlocks(path: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512)
  header.write(path, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(`${data.byteLength.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii')
  header.fill(0x20, 148, 156)
  header.write('0', 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  const body = Buffer.alloc(Math.ceil(data.byteLength / 512) * 512)
  data.copy(body)
  return Buffer.concat([header, body])
}

async function offer(slug: string, version: string, options: OfferOptions = {}): Promise<void> {
  const bundle = options.bundleOverride ?? (await signedBundle(slug, version, options))
  packages = packages.filter((pkg) => !(pkg.slug === slug && pkg.version === version))
  packages.push({
    slug,
    version,
    status: options.status ?? 'published',
    ...(options.migrationFrom === undefined ? {} : { migrationFrom: options.migrationFrom }),
    bundle,
  })
}

// ---------------------------------------------------------------------------
// profile / 状态辅助
// ---------------------------------------------------------------------------

function formalDir(slug: string): string {
  return agentPackageDir(root, slug)
}

function agentsRoot(): string {
  return join(root, 'agents')
}

function suffixedDirs(prefix: string): string[] {
  try {
    return readdirSync(agentsRoot())
      .filter((name) => name.startsWith(prefix))
      .sort()
  } catch {
    return []
  }
}

function installDirs(): string[] {
  return suffixedDirs('.install-')
}

function removeDirs(): string[] {
  return suffixedDirs('.remove-')
}

function oldDirs(): string[] {
  return suffixedDirs('.old-')
}

function stateText(): string {
  try {
    return readFileSync(agentPackageStatePath(root), 'utf8')
  } catch {
    return ''
  }
}

function writeLegacyEnabled(map: Record<string, boolean>): void {
  writeFileSync(agentsEnabledPath(root), `${JSON.stringify(map, null, 2)}\n`, 'utf8')
}

function readLegacyEnabled(): Record<string, boolean> {
  try {
    return JSON.parse(readFileSync(agentsEnabledPath(root), 'utf8')) as Record<string, boolean>
  } catch {
    return {}
  }
}

function seedLocalPackage(slug: string): void {
  const dir = formalDir(slug)
  mkdirSync(dir, { recursive: true })
  const manifest = manifestFor(slug, '1.0.0')
  writeFileSync(join(dir, 'agent.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'persona.md'), '# 本地创建\n', 'utf8')
  const entry: AgentPackageStateEntry = {
    source: 'local',
    enabled: true,
    installedVersion: '1.0.0',
    publishStatus: 'none',
  }
  writeAgentPackageState(root, { ...readAgentPackageState(root), [`local:${slug}`]: entry })
}

function seedLocalTool(name: string): void {
  writeFileSync(
    join(root, 'agents-endpoints.json'),
    JSON.stringify({
      entries: [{ name, kind: 'tool', description: '本地工具', entrypoint: { kind: 'http', url: 'http://127.0.0.1:9000/invoke' } }],
    }),
    'utf8',
  )
}

/** 目录内全部相对路径与内容哈希;用于断言「旧目录字节不变」。 */
function snapshotDir(dir: string): Record<string, string> {
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

async function install(slug: string, version: string): Promise<void> {
  await installCatalogAgentPackage(slug, version)
}

async function seedInstalled(slug: string, version: string, enabled: boolean): Promise<void> {
  await offer(slug, version)
  await install(slug, version)
  if (enabled) setAgentPackageEnabled(root, slug, true)
}

function collectingStopper(): { calls: string[]; stopTurns: AgentPackageTurnStopper } {
  const calls: string[] = []
  return {
    calls,
    stopTurns: async (slug, reason) => {
      calls.push(`${slug}:${reason}`)
    },
  }
}

/** 模拟一次崩溃留下的暂存区:`package/` + `transaction.json`。 */
function seedStaging(options: {
  name: string
  slug: string
  targetVersion: string
  previousState?: AgentPackageStateEntry
  migrationFrom?: string
  packageVersion?: string
}): string {
  const staging = join(agentsRoot(), options.name)
  mkdirSync(join(staging, 'package'), { recursive: true })
  const manifest = manifestFor(options.slug, options.packageVersion ?? options.targetVersion)
  writeFileSync(join(staging, 'package', 'agent.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(join(staging, 'package', 'persona.md'), '# 暂存包\n', 'utf8')
  writeFileSync(
    join(staging, 'transaction.json'),
    `${JSON.stringify(
      {
        slug: options.slug,
        targetVersion: options.targetVersion,
        ...(options.previousState === undefined ? {} : { previousState: options.previousState }),
        ...(options.migrationFrom === undefined ? {} : { migrationFrom: options.migrationFrom }),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return staging
}

// ---------------------------------------------------------------------------
// 安装
// ---------------------------------------------------------------------------

describe('verified catalog install', () => {
  test('first install is disabled and keeps the bundle and transaction out of the package', async () => {
    await offer('weekly-report', '1.0.0')
    const result = await installCatalogAgentPackage('weekly-report', '1.0.0')

    expect(result.manifest).toMatchObject({ slug: 'weekly-report', version: '1.0.0' })
    expect(result.files.map((file) => file.path).sort()).toEqual(['agent.json', 'persona.md'])
    expect(readAgentPackageState(root)['catalog:weekly-report']).toEqual({
      source: 'catalog',
      enabled: false,
      installedVersion: '1.0.0',
      publishStatus: 'installed',
    })

    const dir = formalDir('weekly-report')
    for (const file of ['agent.json', 'persona.md', '.signature/package-digest.json', '.signature/signature.json']) {
      expect(existsSync(join(dir, file)), file).toBe(true)
    }
    expect(existsSync(join(dir, 'bundle.tgz'))).toBe(false)
    expect(existsSync(join(dir, 'transaction.json'))).toBe(false)
    expect(installDirs()).toEqual([])
    expect(oldDirs()).toEqual([])

    const detail = readAgentPackage(root, 'weekly-report')
    expect(detail).toMatchObject({ slug: 'weekly-report', source: 'catalog', enabled: false, version: '1.0.0' })
    expect(detail?.broken).toBeUndefined()
    expect(detail?.files.map((file) => file.path)).toEqual(['agent.json', 'persona.md'])
  })

  test('legacy migration preserves enabled and deletes only the migrated key', async () => {
    writeLegacyEnabled({ 'catalog:legacy-assistant': true, 'catalog:other-agent': true })
    await offer('legacy-assistant', '1.0.0', { migrationFrom: 'legacy-assistant' })

    await installCatalogAgentPackage('legacy-assistant', '1.0.0')

    expect(readAgentPackageState(root)['catalog:legacy-assistant']).toMatchObject({
      source: 'catalog',
      enabled: true,
      installedVersion: '1.0.0',
      publishStatus: 'installed',
    })
    expect(readLegacyEnabled()).toEqual({ 'catalog:other-agent': true })
    expect(installDirs()).toEqual([])
  })

  test('ordinary legacy conflicts never auto-migrate', async () => {
    writeLegacyEnabled({ 'catalog:legacy-assistant': true })
    await offer('legacy-assistant', '1.0.0')
    await expect(install('legacy-assistant', '1.0.0')).rejects.toThrow(/旧目录智能体重名/)
    expect(existsSync(formalDir('legacy-assistant'))).toBe(false)
    expect(readLegacyEnabled()).toEqual({ 'catalog:legacy-assistant': true })

    // migrationFrom 指向别的 slug 同样不算「同一目录同一 slug 的迁移」。
    writeLegacyEnabled({ 'catalog:shared-name': true })
    await offer('shared-name', '1.0.0', { migrationFrom: 'other-name' })
    await expect(install('shared-name', '1.0.0')).rejects.toThrow(/旧目录智能体重名/)
    expect(readLegacyEnabled()).toEqual({ 'catalog:shared-name': true })
    expect(installDirs()).toEqual([])
  })

  test('local packages, local tools, and installed packages block install', async () => {
    seedLocalPackage('local-one')
    await offer('local-one', '1.0.0')
    await expect(install('local-one', '1.0.0')).rejects.toThrow(/与本地创建的智能体重名/)

    seedLocalTool('translator')
    await offer('translator', '1.0.0')
    await expect(install('translator', '1.0.0')).rejects.toThrow(/与现有智能体或本地工具重名/)

    await seedInstalled('weekly-report', '1.0.0', false)
    await expect(install('weekly-report', '1.0.0')).rejects.toThrow(/已安装/)
    expect(readAgentPackageState(root)['local:weekly-report']).toBeUndefined()
    expect(installDirs()).toEqual([])
  })

  test('rejects bad signatures, tampered content, extra files, and a mismatched manifest', async () => {
    const otherKey = generateKeyPair()
    await offer('wrong-signature', '1.0.0', { signWith: otherKey })
    await expect(install('wrong-signature', '1.0.0')).rejects.toThrow(AGENT_PACKAGE_VERIFY_FAILURE)

    await offer('tampered', '1.0.0', { tamper: 'persona' })
    await expect(install('tampered', '1.0.0')).rejects.toThrow('包校验失败')

    await offer('extra-file', '1.0.0', { tamper: 'extra' })
    await expect(install('extra-file', '1.0.0')).rejects.toThrow('包校验失败')

    // 目录把另一个 slug 的签名包放到本 slug 的下载地址:清单必须与请求一致。
    const foreign = await signedBundle('other-agent', '1.0.0')
    await offer('weekly-report', '1.0.0', { bundleOverride: foreign })
    await expect(install('weekly-report', '1.0.0')).rejects.toThrow(AGENT_PACKAGE_VERIFY_FAILURE)

    for (const slug of ['wrong-signature', 'tampered', 'extra-file', 'weekly-report']) {
      expect(existsSync(formalDir(slug)), slug).toBe(false)
      expect(readAgentPackageState(root)[`catalog:${slug}`], slug).toBeUndefined()
    }
    expect(installDirs()).toEqual([])
    expect(loggerLines.some((line) => line.includes('outcome=error'))).toBe(true)
  })

  test('fails closed when the keyring is missing or invalid', async () => {
    await offer('weekly-report', '1.0.0')
    rmSync(join(root, AGENT_CATALOG_KEYRING_FILE))
    await expect(install('weekly-report', '1.0.0')).rejects.toThrow(AGENT_PACKAGE_VERIFY_FAILURE)
    expect(() => readCatalogKeyring(root)).toThrow(AGENT_PACKAGE_VERIFY_FAILURE)

    writeFileSync(join(root, AGENT_CATALOG_KEYRING_FILE), '{"schemaVersion":2,"keys":[]}', 'utf8')
    expect(() => readCatalogKeyring(root)).toThrow(AGENT_PACKAGE_VERIFY_FAILURE)
    await expect(install('weekly-report', '1.0.0')).rejects.toThrow(AGENT_PACKAGE_VERIFY_FAILURE)
    expect(existsSync(formalDir('weekly-report'))).toBe(false)
    expect(installDirs()).toEqual([])
  })

  test('rejects a revoked version and reports the administrator reason', async () => {
    await offer('weekly-report', '1.0.0')
    revocations = [
      { slug: 'weekly-report', version: '1.0.0', reason: '脚本会外传数据', revokedAt: NOW, actor: 'ignored' },
    ]
    await expect(install('weekly-report', '1.0.0')).rejects.toThrow('该版本已被管理员撤销：脚本会外传数据')
    expect(existsSync(formalDir('weekly-report'))).toBe(false)
    expect(readAgentPackageState(root)['catalog:weekly-report']).toBeUndefined()
    expect(installDirs()).toEqual([])
  })

  test('aborts an oversized bundle and removes the staging directory', async () => {
    await offer('weekly-report', '1.0.0')
    oversizedBundle = true
    await expect(install('weekly-report', '1.0.0')).rejects.toThrow(/5 MiB/)
    expect(existsSync(formalDir('weekly-report'))).toBe(false)
    expect(installDirs()).toEqual([])
  })

  test('refuses a signed bundle that overflows the installed entry budget', async () => {
    // Control: the same appended-signature layout is valid at exactly 1024
    // installed entries (1021 content), so the fixture itself is well-formed.
    await offer('boundary-agent', '1.0.0', {
      bundleOverride: await makeBundleWithFileCount('boundary-agent', '1.0.0', 1021),
    })
    await install('boundary-agent', '1.0.0')
    expect(existsSync(formalDir('boundary-agent'))).toBe(true)

    // 1022 content + 2 signature files + `.signature` = 1025 installed entries;
    // the archive itself has only 1024 file entries, so the install-side signed
    // projection has to reject it before anything reaches the formal directory.
    await offer('weekly-report', '1.0.0', {
      bundleOverride: await makeBundleWithFileCount('weekly-report', '1.0.0', 1022),
    })
    await expect(install('weekly-report', '1.0.0')).rejects.toThrow(/条目数超过1024/)
    expect(existsSync(formalDir('weekly-report'))).toBe(false)
    expect(readAgentPackageState(root)['catalog:weekly-report']).toBeUndefined()
    expect(installDirs()).toEqual([])
  })

  test('rejects replaying an older version', async () => {
    await offer('weekly-report', '1.0.0')
    await offer('weekly-report', '1.0.1')
    await expect(install('weekly-report', '1.0.0')).rejects.toThrow(/不是目录中的最新版本/)
    expect(existsSync(formalDir('weekly-report'))).toBe(false)
    expect(readAgentPackageState(root)['catalog:weekly-report']).toBeUndefined()

    await install('weekly-report', '1.0.1')
    expect(readAgentPackageState(root)['catalog:weekly-report']?.installedVersion).toBe('1.0.1')
  })

  test('aborts before any rename when the state file cannot be read', async () => {
    await offer('weekly-report', '1.0.0')
    // 状态路径是目录 ⇒ readFileSync 报 EISDIR(非 ENOENT):快照不得当成空表。
    mkdirSync(agentPackageStatePath(root))

    await expect(install('weekly-report', '1.0.0')).rejects.toThrow(/智能体状态不可读/)

    expect(existsSync(formalDir('weekly-report'))).toBe(false)
    expect(installDirs()).toEqual([])
    expect(oldDirs()).toEqual([])
    expect(readdirSync(agentPackageStatePath(root))).toEqual([])
  })

  test('logs install outcomes without tokens or bundle content', async () => {
    await offer('weekly-report', '1.0.0')
    await install('weekly-report', '1.0.0')
    expect(loggerLines).toContain('[agent-package] install slug=weekly-report version=1.0.0 outcome=ok')

    await offer('weekly-report', '1.0.1', { tamper: 'persona' })
    const stopper = collectingStopper()
    await expect(updateCatalogAgentPackage('weekly-report', stopper.stopTurns)).rejects.toThrow('包校验失败')
    const failures = loggerLines.filter((line) => line.includes('update') && line.includes('outcome=error'))
    expect(failures).toHaveLength(1)
    for (const line of loggerLines) {
      expect(line).not.toContain(READ_TOKEN)
      expect(line).not.toContain(PUBLISH_TOKEN)
      expect(line).not.toContain('Bearer')
      expect(line).not.toContain('来自签名广场。')
    }
  })
})

// ---------------------------------------------------------------------------
// 更新
// ---------------------------------------------------------------------------

describe('verified catalog update', () => {
  test('requires a higher version, preserves enabled, and stops turns before any rename', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    const renameChecks: Array<{ reason: string; version: string | undefined; installDirs: number; oldDirs: number }> = []
    const stopTurns: AgentPackageTurnStopper = async (slug, reason) => {
      expect(slug).toBe('weekly-report')
      renameChecks.push({
        reason,
        version: readAgentPackageVersionFromDir(formalDir('weekly-report')),
        installDirs: installDirs().length,
        oldDirs: oldDirs().length,
      })
    }

    // 目录里仍是 1.0.0:没有更高版本,不得停止回合也不得下载。
    await expect(updateCatalogAgentPackage('weekly-report', stopTurns)).rejects.toThrow(
      /没有更高版本|版本低于已安装版本/,
    )
    expect(renameChecks).toEqual([])

    await offer('weekly-report', '1.0.1')
    await updateCatalogAgentPackage('weekly-report', stopTurns)

    expect(renameChecks).toEqual([{ reason: 'update', version: '1.0.0', installDirs: 0, oldDirs: 0 }])
    expect(readAgentPackageState(root)['catalog:weekly-report']).toMatchObject({
      source: 'catalog',
      enabled: true,
      installedVersion: '1.0.1',
      publishStatus: 'installed',
    })
    expect(readAgentPackageVersionFromDir(formalDir('weekly-report'))).toBe('1.0.1')
    expect(installDirs()).toEqual([])
    expect(oldDirs()).toEqual([])
  })

  test('rejects a downgrade when the catalog no longer offers the installed version', async () => {
    await seedInstalled('weekly-report', '1.0.1', true)
    packages = packages.filter((pkg) => pkg.version !== '1.0.1')
    await offer('weekly-report', '1.0.0')
    const stopper = collectingStopper()
    await expect(updateCatalogAgentPackage('weekly-report', stopper.stopTurns)).rejects.toThrow(
      '版本低于已安装版本，已拒绝更新',
    )
    expect(stopper.calls).toEqual([])
    expect(readAgentPackageState(root)['catalog:weekly-report']?.installedVersion).toBe('1.0.1')
    expect(readAgentPackageVersionFromDir(formalDir('weekly-report'))).toBe('1.0.1')
  })

  test('rejects a delisted latest version without downloading', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    // 已下架版本不再出现在目录列表里,当前可安装的最高版本仍是已装版本。
    await offer('weekly-report', '1.0.1', { status: 'delisted' })
    const stopper = collectingStopper()
    await expect(updateCatalogAgentPackage('weekly-report', stopper.stopTurns)).rejects.toThrow(
      /没有更高版本|版本低于已安装版本|已下架或撤销/,
    )
    expect(stopper.calls).toEqual([])
    expect(readAgentPackageVersionFromDir(formalDir('weekly-report'))).toBe('1.0.0')
  })

  test('a failing stopTurns leaves the installed package untouched', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    await offer('weekly-report', '1.0.1')
    const beforeState = stateText()
    const beforeFiles = snapshotDir(formalDir('weekly-report'))

    await expect(
      updateCatalogAgentPackage('weekly-report', async () => {
        throw new Error('回合无法停止')
      }),
    ).rejects.toThrow('回合无法停止')

    expect(stateText()).toBe(beforeState)
    expect(snapshotDir(formalDir('weekly-report'))).toEqual(beforeFiles)
    expect(installDirs()).toEqual([])
    expect(readAgentPackageVersionFromDir(formalDir('weekly-report'))).toBe('1.0.0')
  })

  test('a bad bundle during update restores the old directory and state byte-for-byte', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    const beforeState = stateText()
    const beforeFiles = snapshotDir(formalDir('weekly-report'))
    await offer('weekly-report', '1.0.1', { tamper: 'persona' })

    const stopper = collectingStopper()
    await expect(updateCatalogAgentPackage('weekly-report', stopper.stopTurns)).rejects.toThrow('包校验失败')
    expect(stopper.calls).toEqual(['weekly-report:update'])
    expect(stateText()).toBe(beforeState)
    expect(snapshotDir(formalDir('weekly-report'))).toEqual(beforeFiles)
    expect(installDirs()).toEqual([])
    expect(oldDirs()).toEqual([])
  })

  test('a commit failure after the rename restores the old directory and state', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    const beforeState = stateText()
    const beforeFiles = snapshotDir(formalDir('weekly-report'))
    await offer('weekly-report', '1.0.1')

    // 用同名目录占住 state 的 tmp 路径:rename 完成后写 state 必失败。
    mkdirSync(`${agentPackageStatePath(root)}.tmp`, { recursive: true })

    await expect(updateCatalogAgentPackage('weekly-report', async () => undefined)).rejects.toThrow()

    expect(stateText()).toBe(beforeState)
    expect(snapshotDir(formalDir('weekly-report'))).toEqual(beforeFiles)
    expect(readAgentPackageVersionFromDir(formalDir('weekly-report'))).toBe('1.0.0')
    expect(installDirs()).toEqual([])
    expect(oldDirs()).toEqual([])
  })

  test('keeps the transaction when the rollback cannot restore the old state', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    const beforeState = stateText()
    const beforeFiles = snapshotDir(formalDir('weekly-report'))
    await offer('weekly-report', '1.0.1')

    // 占住 state 写入与回滚恢复的两个临时路径:提交失败后回滚也恢复不了 state。
    mkdirSync(`${agentPackageStatePath(root)}.tmp`)
    mkdirSync(`${agentPackageStatePath(root)}.restore-tmp`)

    await expect(updateCatalogAgentPackage('weekly-report', async () => undefined)).rejects.toThrow()

    // 目录已回滚,但 state 恢复失败 ⇒ 交易必须保留给下一次读路径继续对账。
    expect(readAgentPackageVersionFromDir(formalDir('weekly-report'))).toBe('1.0.0')
    expect(snapshotDir(formalDir('weekly-report'))).toEqual(beforeFiles)
    expect(stateText()).toBe(beforeState)
    expect(oldDirs()).toEqual([])
    expect(installDirs()).toHaveLength(1)
    const [stagingName] = installDirs()
    expect(existsSync(join(agentsRoot(), stagingName!, 'transaction.json'))).toBe(true)

    // 下一次读路径的恢复清掉残留暂存区,目录/state 保持不变。
    recoverCatalogPackageInstalls(root)
    expect(installDirs()).toEqual([])
    expect(readAgentPackageVersionFromDir(formalDir('weekly-report'))).toBe('1.0.0')
    expect(stateText()).toBe(beforeState)
  })
})

// ---------------------------------------------------------------------------
// 移除
// ---------------------------------------------------------------------------

describe('catalog remove', () => {
  test('stops turns before the rename and removes only catalog packages', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    const observations: Array<{ reason: string; formal: boolean; state: boolean; removeDirs: number }> = []
    const stopTurns: AgentPackageTurnStopper = async (slug, reason) => {
      expect(slug).toBe('weekly-report')
      observations.push({
        reason,
        formal: existsSync(formalDir('weekly-report')),
        state: readAgentPackageState(root)['catalog:weekly-report'] !== undefined,
        removeDirs: removeDirs().length,
      })
    }

    await removeCatalogAgentPackage('weekly-report', stopTurns)

    expect(observations).toEqual([{ reason: 'remove', formal: true, state: true, removeDirs: 0 }])
    expect(existsSync(formalDir('weekly-report'))).toBe(false)
    expect(readAgentPackageState(root)['catalog:weekly-report']).toBeUndefined()
    expect(removeDirs()).toEqual([])
    expect(snapshotDir(agentsRoot())).toEqual({})

    const stopper = collectingStopper()
    await expect(removeCatalogAgentPackage('weekly-report', stopper.stopTurns)).rejects.toThrow(/未安装/)
    expect(stopper.calls).toEqual([])
  })

  test('local packages cannot be removed through the catalog', async () => {
    seedLocalPackage('local-one')
    const stopper = collectingStopper()
    await expect(removeCatalogAgentPackage('local-one', stopper.stopTurns)).rejects.toThrow(
      '本地创建的智能体不能通过广场移除',
    )
    expect(stopper.calls).toEqual([])
    expect(existsSync(formalDir('local-one'))).toBe(true)
    expect(readAgentPackageState(root)['local:local-one']?.enabled).toBe(true)
  })

  test('a failing state deletion rolls the rename back', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    const beforeState = stateText()
    const beforeFiles = snapshotDir(formalDir('weekly-report'))

    // 占住 state 的 tmp 路径:删 state 必失败,rename 必须回滚。
    mkdirSync(`${agentPackageStatePath(root)}.tmp`, { recursive: true })

    await expect(removeCatalogAgentPackage('weekly-report', async () => undefined)).rejects.toThrow()

    expect(existsSync(formalDir('weekly-report'))).toBe(true)
    expect(snapshotDir(formalDir('weekly-report'))).toEqual(beforeFiles)
    expect(stateText()).toBe(beforeState)
    expect(removeDirs()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 下架状态同步
// ---------------------------------------------------------------------------

describe('installed catalog status refresh', () => {
  test('only publishStatus changes for a delisted installed version', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    const seeded = readAgentPackageState(root)['catalog:weekly-report']
    if (seeded === undefined) throw new Error('installed state missing')
    writeAgentPackageState(root, {
      ...readAgentPackageState(root),
      'catalog:weekly-report': {
        ...seeded,
        revoked: { slug: 'weekly-report', version: '0.9.0', reason: '旧版本不安全', revokedAt: NOW },
        delistRequestId: 'delist-keep',
      },
    })

    packages = packages.map((pkg) => (pkg.slug === 'weekly-report' ? { ...pkg, status: 'delisted' } : pkg))
    const delisted = await refreshInstalledCatalogPackageStatuses()
    expect(delisted).toEqual({ changed: true })

    const entry = readAgentPackageState(root)['catalog:weekly-report']
    expect(entry).toMatchObject({
      source: 'catalog',
      enabled: true,
      installedVersion: '1.0.0',
      publishStatus: 'delisted',
      delistRequestId: 'delist-keep',
      revoked: { slug: 'weekly-report', version: '0.9.0', reason: '旧版本不安全', revokedAt: NOW },
    })
    const detail = readAgentPackage(root, 'weekly-report')
    expect(detail?.publishStatus).toBe('delisted')
    expect(detail?.enabled).toBe(true)
    expect(detail?.broken).toBeUndefined()

    packages = packages.map((pkg) => (pkg.slug === 'weekly-report' ? { ...pkg, status: 'published' } : pkg))
    const restored = await refreshInstalledCatalogPackageStatuses()
    expect(restored).toEqual({ changed: true })
    expect(readAgentPackageState(root)['catalog:weekly-report']?.publishStatus).toBe('installed')

    // 无变化时不重写 state。
    const stable = stateText()
    expect(await refreshInstalledCatalogPackageStatuses()).toEqual({ changed: false })
    expect(stateText()).toBe(stable)
  })

  test('leaves revoked metadata to Task 10 and never writes broken', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    packages = packages.map((pkg) => (pkg.slug === 'weekly-report' ? { ...pkg, status: 'revoked' } : pkg))
    const before = stateText()
    const result = await refreshInstalledCatalogPackageStatuses()
    expect(result).toEqual({ changed: false })
    expect(stateText()).toBe(before)
    const detail = readAgentPackage(root, 'weekly-report')
    expect(detail?.publishStatus).toBe('installed')
    expect(detail?.revoked).toBeUndefined()
    expect(detail?.broken).toBeUndefined()
  })

  test('keeps state and returns a warning when the catalog is unreachable', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    const before = stateText()
    await stopCatalogServer()
    const result = await refreshInstalledCatalogPackageStatuses()
    expect(result.changed).toBe(false)
    expect(result.warning).toMatch(/状态同步失败/)
    expect(stateText()).toBe(before)
  })

  test('a 404 for the installed version keeps the old state and warns', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    const before = stateText()
    packages = []
    const result = await refreshInstalledCatalogPackageStatuses()
    expect(result.changed).toBe(false)
    expect(result.warning).toMatch(/状态同步失败/)
    expect(stateText()).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// 崩溃恢复
// ---------------------------------------------------------------------------

describe('catalog install crash recovery', () => {
  test('restores the old directory when the old rename happened but the new formal did not', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    const formal = formalDir('weekly-report')
    const old = join(agentsRoot(), '.old-weekly-report-crash')
    renameSync(formal, old)
    const staging = seedStaging({
      name: '.install-weekly-report-crash',
      slug: 'weekly-report',
      targetVersion: '1.0.1',
      previousState: {
        source: 'catalog',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'installed',
      },
    })

    // 读路径(host.listLocal)必须先跑恢复,而不是让通用 `.old-*` 清理抢先。
    const host = createAgentPackageHost({ profileDir: root, takenSlugs: () => [] })
    const listed = host.listLocal()

    expect(listed.map((item) => item.slug)).toEqual(['weekly-report'])
    expect(existsSync(formal)).toBe(true)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(staging)).toBe(false)
    expect(readAgentPackageVersionFromDir(formal)).toBe('1.0.0')
    expect(readAgentPackageState(root)['catalog:weekly-report']).toMatchObject({
      enabled: true,
      installedVersion: '1.0.0',
    })
    expect(installDirs()).toEqual([])
  })

  test('discards a new formal that was renamed before its state was written', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    // 模拟提交顺序:formal 换成 1.0.1、旧目录在 `.old-*`,state 仍是 1.0.0。
    const staging = seedStaging({
      name: '.install-weekly-report-half',
      slug: 'weekly-report',
      targetVersion: '1.0.1',
      previousState: {
        source: 'catalog',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'installed',
      },
    })
    const old = join(agentsRoot(), '.old-weekly-report-half')
    const formal = formalDir('weekly-report')
    renameSync(formal, old)
    renameSync(join(staging, 'package'), formal)

    recoverCatalogPackageInstalls(root)

    expect(readAgentPackageVersionFromDir(formal)).toBe('1.0.0')
    expect(existsSync(old)).toBe(false)
    expect(existsSync(staging)).toBe(false)
    expect(readAgentPackageState(root)['catalog:weekly-report']?.installedVersion).toBe('1.0.0')
  })

  test('cleans a staging directory without a transaction', () => {
    const staging = join(agentsRoot(), '.install-orphan-abcd1234')
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, 'bundle.tgz'), 'partial', 'utf8')
    recoverCatalogPackageInstalls(root)
    expect(existsSync(staging)).toBe(false)
  })

  test('only clears the staging directory when the old formal was never renamed', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    const beforeState = stateText()
    const beforeFiles = snapshotDir(formalDir('weekly-report'))
    const staging = seedStaging({
      name: '.install-weekly-report-download',
      slug: 'weekly-report',
      targetVersion: '1.0.1',
      previousState: {
        source: 'catalog',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'installed',
      },
    })

    recoverCatalogPackageInstalls(root)

    expect(existsSync(staging)).toBe(false)
    expect(readAgentPackageVersionFromDir(formalDir('weekly-report'))).toBe('1.0.0')
    expect(snapshotDir(formalDir('weekly-report'))).toEqual(beforeFiles)
    expect(stateText()).toBe(beforeState)
    expect(oldDirs()).toEqual([])
  })

  test('deletes a first install whose formal landed before its state', async () => {
    const staging = seedStaging({
      name: '.install-fresh-agent-first',
      slug: 'fresh-agent',
      targetVersion: '1.0.0',
    })
    renameSync(join(staging, 'package'), formalDir('fresh-agent'))

    recoverCatalogPackageInstalls(root)

    expect(existsSync(formalDir('fresh-agent'))).toBe(false)
    expect(existsSync(staging)).toBe(false)
    expect(readAgentPackageState(root)['catalog:fresh-agent']).toBeUndefined()
  })

  test('does not delete the staging directory of an install still in flight', async () => {
    await offer('weekly-report', '1.0.0')
    const gate = deferred()
    bundleGate = gate.promise
    const pending = install('weekly-report', '1.0.0')
    await waitFor(() => installDirs().length === 1, 'staging created')

    // 列表/详情读路径会跑恢复,但在途安装的暂存区必须被跳过。
    recoverCatalogPackageInstalls(root)
    expect(installDirs()).toHaveLength(1)

    gate.release()
    await pending
    expect(existsSync(formalDir('weekly-report'))).toBe(true)
    expect(installDirs()).toEqual([])
  })

  test('keeps the legacy key and transaction when no package or backup can be restored', async () => {
    // 先完成一次正常迁移,再模拟「state 已提交、legacy 未删、正式目录与暂存包都没了」。
    writeLegacyEnabled({ 'catalog:weekly-report': true })
    await offer('weekly-report', '1.0.0', { migrationFrom: 'weekly-report' })
    await install('weekly-report', '1.0.0')
    const formal = formalDir('weekly-report')
    const backup = join(root, 'weekly-report-backup')
    cpSync(formal, backup, { recursive: true })
    rmSync(formal, { recursive: true, force: true })
    writeLegacyEnabled({ 'catalog:weekly-report': true })
    const staging = seedStaging({
      name: '.install-weekly-report-nopkg',
      slug: 'weekly-report',
      targetVersion: '1.0.0',
      migrationFrom: 'weekly-report',
    })
    rmSync(join(staging, 'package'), { recursive: true, force: true })

    recoverCatalogPackageInstalls(root)

    // 没有任何可重建的包:legacy 旧键与交易记录都必须保留,供下次恢复。
    expect(readLegacyEnabled()).toEqual({ 'catalog:weekly-report': true })
    expect(existsSync(join(staging, 'transaction.json'))).toBe(true)
    expect(existsSync(formal)).toBe(false)
    expect(readAgentPackageState(root)['catalog:weekly-report']?.installedVersion).toBe('1.0.0')
    expect(readAgentPackageState(root)['catalog:weekly-report']?.enabled).toBe(true)
    expect(loggerLines.some((line) => line.includes('recover.missing'))).toBe(true)

    // 包被找回后,下一次恢复才允许删 legacy 并清理交易。
    cpSync(backup, formal, { recursive: true })
    recoverCatalogPackageInstalls(root)

    expect(readLegacyEnabled()).toEqual({})
    expect(existsSync(staging)).toBe(false)
    expect(readAgentPackageVersionFromDir(formal)).toBe('1.0.0')
    expect(readAgentPackageState(root)['catalog:weekly-report']?.enabled).toBe(true)
  })

  test('deletes the legacy key when a migration committed but had not deleted it', async () => {
    // 先完成一次正常迁移(旧键已在安装时删除、state 为 enabled:true),再把旧键
    // 写回去,模拟「state 已提交、legacy 删除尚未执行」的崩溃窗口。
    writeLegacyEnabled({ 'catalog:legacy-assistant': true })
    await offer('legacy-assistant', '1.0.0', { migrationFrom: 'legacy-assistant' })
    await install('legacy-assistant', '1.0.0')
    expect(readAgentPackageState(root)['catalog:legacy-assistant']?.enabled).toBe(true)
    writeLegacyEnabled({ 'catalog:legacy-assistant': true, 'catalog:other-agent': true })
    const staging = seedStaging({
      name: '.install-legacy-crash',
      slug: 'legacy-assistant',
      targetVersion: '1.0.0',
      migrationFrom: 'legacy-assistant',
    })

    recoverCatalogPackageInstalls(root)

    expect(readLegacyEnabled()).toEqual({ 'catalog:other-agent': true })
    expect(readAgentPackageState(root)['catalog:legacy-assistant']).toMatchObject({
      source: 'catalog',
      enabled: true,
      installedVersion: '1.0.0',
    })
    expect(existsSync(staging)).toBe(false)
    expect(installDirs()).toEqual([])
    // 不得出现 legacy + catalog 双份启用。
    expect(readLegacyEnabled()['catalog:legacy-assistant']).toBeUndefined()
  })

  test('rolls a committed migration back when the legacy key cannot be deleted', async () => {
    writeLegacyEnabled({ 'catalog:legacy-assistant': true })
    await offer('legacy-assistant', '1.0.0', { migrationFrom: 'legacy-assistant' })
    await install('legacy-assistant', '1.0.0')
    expect(readAgentPackageState(root)['catalog:legacy-assistant']?.enabled).toBe(true)
    writeLegacyEnabled({ 'catalog:legacy-assistant': true, 'catalog:other-agent': true })
    seedStaging({
      name: '.install-legacy-blocked',
      slug: 'legacy-assistant',
      targetVersion: '1.0.0',
      migrationFrom: 'legacy-assistant',
    })

    // 占住旧启用表的 tmp 路径:补删 legacy 键必失败。
    mkdirSync(`${agentsEnabledPath(root)}.tmp`, { recursive: true })

    recoverCatalogPackageInstalls(root)

    // 回滚新 formal/state,保留 legacy 旧键。
    expect(readLegacyEnabled()).toEqual({ 'catalog:legacy-assistant': true, 'catalog:other-agent': true })
    expect(existsSync(formalDir('legacy-assistant'))).toBe(false)
    expect(readAgentPackageState(root)['catalog:legacy-assistant']).toBeUndefined()
    expect(installDirs()).toEqual([])
  })

  test('rolls a committed migration back when agents-enabled.json is corrupt', async () => {
    writeLegacyEnabled({ 'catalog:legacy-assistant': true })
    await offer('legacy-assistant', '1.0.0', { migrationFrom: 'legacy-assistant' })
    await install('legacy-assistant', '1.0.0')
    // 崩溃窗口:state 已提交为迁移态、legacy 旧键尚未删除。
    writeLegacyEnabled({ 'catalog:legacy-assistant': true })
    const staging = seedStaging({
      name: '.install-legacy-corrupt',
      slug: 'legacy-assistant',
      targetVersion: '1.0.0',
      migrationFrom: 'legacy-assistant',
    })
    // 旧启用表损坏:宽空表会把「读不出来」误判成「键不存在」而直接清交易。
    const corrupt = '{"catalog:legacy-assistant":'
    writeFileSync(agentsEnabledPath(root), corrupt, 'utf8')

    recoverCatalogPackageInstalls(root)

    // 补删失败 ⇒ 按安装失败回滚新 formal/state,保留损坏的旧表原样。
    expect(existsSync(formalDir('legacy-assistant'))).toBe(false)
    expect(readAgentPackageState(root)['catalog:legacy-assistant']).toBeUndefined()
    expect(readFileSync(agentsEnabledPath(root), 'utf8')).toBe(corrupt)
    expect(existsSync(staging)).toBe(false)
    expect(installDirs()).toEqual([])
    expect(loggerLines.some((line) => line.includes('recover.migration'))).toBe(true)
  })

  test('a direct store read leaves a pending catalog backup to catalog recovery', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    const staging = seedStaging({
      name: '.install-weekly-report-pending',
      slug: 'weekly-report',
      targetVersion: '1.0.1',
      previousState: {
        source: 'catalog',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'installed',
      },
    })
    const old = join(agentsRoot(), '.old-weekly-report-pending')
    renameSync(formalDir('weekly-report'), old)
    renameSync(join(staging, 'package'), formalDir('weekly-report'))

    // catalog-publish 等直接读路径只经过 store 的通用恢复:不得先删掉唯一备份。
    readAgentPackage(root, 'weekly-report')

    expect(oldDirs()).toEqual(['.old-weekly-report-pending'])
    expect(readAgentPackageVersionFromDir(formalDir('weekly-report'))).toBe('1.0.1')
    expect(existsSync(staging)).toBe(true)

    recoverCatalogPackageInstalls(root)

    expect(readAgentPackageVersionFromDir(formalDir('weekly-report'))).toBe('1.0.0')
    expect(readAgentPackageState(root)['catalog:weekly-report']?.installedVersion).toBe('1.0.0')
    expect(oldDirs()).toEqual([])
    expect(installDirs()).toEqual([])
  })

  test('host.propose reconciles an interrupted update before the generic .old-* sweep', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    const staging = seedStaging({
      name: '.install-weekly-report-window',
      slug: 'weekly-report',
      targetVersion: '1.0.1',
      previousState: {
        source: 'catalog',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'installed',
      },
    })
    const old = join(agentsRoot(), '.old-weekly-report-window')
    renameSync(formalDir('weekly-report'), old)
    // 新 formal 已就位、state 仍是旧版本、`.old-*` 尚在:通用清理若先跑会删掉备份。
    renameSync(join(staging, 'package'), formalDir('weekly-report'))

    const host = createAgentPackageHost({ profileDir: root, takenSlugs: () => [] })
    const result = await host.propose('session-1', {
      mode: 'create',
      slug: 'another-agent',
      displayName: '另一个智能体',
      description: '用于验证恢复顺序',
      persona: '你是另一个智能体。',
    })

    expect(result.ok).toBe(true)
    expect(readAgentPackageVersionFromDir(formalDir('weekly-report'))).toBe('1.0.0')
    expect(readAgentPackageState(root)['catalog:weekly-report']).toMatchObject({
      enabled: true,
      installedVersion: '1.0.0',
    })
    expect(existsSync(staging)).toBe(false)
    expect(oldDirs()).toEqual([])
    expect(installDirs()).toEqual([])
    expect(host.listLocal().map((item) => item.slug)).toEqual(['weekly-report'])
  })

  test('reverts or finishes .remove-* leftovers by whether the state still exists', async () => {
    await seedInstalled('weekly-report', '1.0.0', true)
    const formal = formalDir('weekly-report')
    const trash = join(agentsRoot(), '.remove-weekly-report-crash')
    renameSync(formal, trash)

    recoverCatalogPackageInstalls(root)

    expect(existsSync(formal)).toBe(true)
    expect(existsSync(trash)).toBe(false)
    expect(readAgentPackageState(root)['catalog:weekly-report']?.installedVersion).toBe('1.0.0')

    // state 已删:残留只清理,不再改回正式目录。
    renameSync(formal, trash)
    writeAgentPackageState(root, {})
    recoverCatalogPackageInstalls(root)
    expect(existsSync(trash)).toBe(false)
    expect(existsSync(formal)).toBe(false)
  })
})
