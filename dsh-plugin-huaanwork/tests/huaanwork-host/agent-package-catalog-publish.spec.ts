import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  buildUnsignedAgentPackageBundle,
  inspectUnsignedAgentPackageBundle,
} from '@huaanwork/agent-package-format/bundle'
import { readUnsignedPackageFiles } from '@huaanwork/agent-package-format/digest'
import { parseAgentPackageManifest } from '@huaanwork/agent-package-format/manifest'
import { canonicalJson } from '@huaanwork/catalog-signing'

import {
  AGENT_CATALOG_AUTH_ERROR,
  AGENT_CATALOG_UNREACHABLE_ERROR,
  agentCatalogPackagesCachePath,
  configureAgentCatalog,
  getAgentCatalogClient,
  readCachedCatalogPackageSlugs,
  refreshCatalogPackageCache,
  resetAgentCatalogForTests,
  type AgentCatalogSettings,
} from '../../src/huaanwork-host/agent-package/catalog-client.ts'
import {
  logAgentPackageAction,
  publishLocalAgentPackage,
  refreshLocalAgentPackagePublishStatus,
  requestLocalAgentPackageDelist,
} from '../../src/huaanwork-host/agent-package/catalog-publish.ts'
import {
  agentPackageDir,
  agentPackageStatePath,
  listLocalAgentPackages,
  readAgentPackage,
  readAgentPackageState,
  setAgentPackageEnabled,
  writeAgentPackageAtomically,
  writeAgentPackageState,
} from '../../src/huaanwork-host/agent-package/store.ts'
import type { AgentPackageManifest, AgentPackageState } from '../../src/huaanwork-host/agent-package/types.ts'
import { beginAgentPackageUpdate, commitAgentPackage, loadAgentPackageDraft } from '../../src/huaanwork-host/agent-package/drafts.ts'
import { bootHuaanworkHost, hostConfig } from './startup-sweep-fixture.ts'

const READ_TOKEN = 'read-token-0123456789abcdef'
const PUBLISH_TOKEN = 'publish-token-0123456789abcdef'
const ADMIN_TOKEN = 'admin-token-never-sent'
const PRIVATE_KEY_MARKER = 'PRIVATE KEY MATERIAL'
const SUBMISSION_ID = '11111111-1111-4111-8111-111111111111'
const DELIST_REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const NOW = '2026-10-24T00:00:00.000Z'

const VALID = {
  schemaVersion: 1,
  slug: 'weekly-report',
  displayName: '周报小助手',
  description: '把一周工作整理成周报',
  version: '1.0.0',
  draftId: 'draft-catalog-publish',
  createdAt: NOW,
  updatedAt: NOW,
  persona: 'persona.md',
  skill: null,
  tools: { mode: 'none' },
  allowSkills: [],
}

type RecordedRequest = {
  method: string | undefined
  url: string | undefined
  authorization: string | undefined
  contentType: string | undefined
  contentLength: string | undefined
  idempotencyKey: string | undefined
  body: Buffer
}

let root = ''
let server: Server | undefined
let port = 0
let requests: RecordedRequest[] = []
let settings: AgentCatalogSettings
let loggerLines: string[] = []
let changedSlugs: Array<string | undefined> = []

let submissionStatus: 'pending-review' | 'published' | 'rejected' = 'pending-review'
let submissionReason: string | undefined
let submittedSlug = 'weekly-report'
let submittedVersion = '1.0.0'
let packageStatus: 'published' | 'delisted' | 'revoked' = 'published'
let bundleUrlOverride: string | undefined
let bundleRedirect: string | undefined
let bundleBytes = Buffer.from('test-bundle-bytes')
let bundleChunkedOverflow = false
let listItems: unknown[] = []
let listPadding = ''
let listStatus: number | undefined
let revocationItems: unknown[] = []
// 并发用例把网络请求挂在这里:请求到达并记录后才 release。
let submitGate: Promise<void> | undefined
let submissionPollGate: Promise<void> | undefined
let delistGate: Promise<void> | undefined

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'agent-package-catalog-publish-'))
  requests = []
  loggerLines = []
  changedSlugs = []
  submissionStatus = 'pending-review'
  submissionReason = undefined
  submittedSlug = 'weekly-report'
  submittedVersion = '1.0.0'
  packageStatus = 'published'
  bundleUrlOverride = undefined
  bundleRedirect = undefined
  bundleBytes = Buffer.from('test-bundle-bytes')
  bundleChunkedOverflow = false
  listItems = []
  listPadding = ''
  listStatus = undefined
  revocationItems = []
  submitGate = undefined
  submissionPollGate = undefined
  delistGate = undefined
  resetAgentCatalogForTests()

  server = createServer((request, response) => {
    void handleRequest(request, response)
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind a port')
  port = address.port
})

afterEach(async () => {
  resetAgentCatalogForTests()
  await stopCatalogServer()
  rmSync(root, { recursive: true, force: true })
})

async function stopCatalogServer(): Promise<void> {
  const current = server
  server = undefined
  if (current === undefined) return
  await new Promise<void>((resolve) => {
    current.close(() => resolve())
    // 被中止的下载会留下半开连接;不等 keep-alive 超时,直接断开。
    current.closeAllConnections()
  })
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(`${JSON.stringify(body)}\n`)
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  response.on('error', () => undefined)
  request.on('error', () => undefined)
  try {
    const body = await readRequestBody(request)
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      contentType: request.headers['content-type'],
      contentLength: request.headers['content-length'],
      idempotencyKey: request.headers['x-agent-catalog-idempotency-key'] as string | undefined,
      body,
    })
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname

    if (request.method === 'POST' && pathname === '/v1/agent-packages/submissions') {
      if (submitGate !== undefined) await submitGate
      const inspected = await inspectUnsignedAgentPackageBundle(body)
      submittedSlug = inspected.manifest.slug
      submittedVersion = inspected.manifest.version
      sendJson(response, 201, {
        submissionId: SUBMISSION_ID,
        slug: submittedSlug,
        version: submittedVersion,
        status: 'pending-review',
        submittedAt: NOW,
        updatedAt: NOW,
      })
      return
    }

    if (request.method === 'GET' && pathname === `/v1/agent-packages/submissions/${SUBMISSION_ID}`) {
      if (submissionPollGate !== undefined) await submissionPollGate
      sendJson(response, 200, {
        submissionId: SUBMISSION_ID,
        slug: submittedSlug,
        version: submittedVersion,
        status: submissionStatus,
        submittedAt: NOW,
        updatedAt: NOW,
        ...(submissionReason === undefined ? {} : { reason: submissionReason }),
      })
      return
    }

    if (request.method === 'GET' && pathname === '/v1/agent-packages') {
      if (listStatus !== undefined) {
        sendJson(response, listStatus, { error: '拒绝', ...(listPadding === '' ? {} : { padding: listPadding }) })
        return
      }
      sendJson(response, 200, { items: listItems, padding: listPadding })
      return
    }

    if (request.method === 'GET' && pathname === '/v1/agent-packages/revocations') {
      sendJson(response, 200, { items: revocationItems })
      return
    }

    const delistMatch = /^\/v1\/agent-packages\/([^/]+)\/([^/]+)\/delist-requests$/.exec(pathname)
    if (request.method === 'POST' && delistMatch !== null) {
      if (delistGate !== undefined) await delistGate
      const payload = JSON.parse(body.toString('utf8')) as { reason?: unknown }
      sendJson(response, 201, {
        id: DELIST_REQUEST_ID,
        slug: decodeURIComponent(delistMatch[1] ?? ''),
        version: decodeURIComponent(delistMatch[2] ?? ''),
        status: 'pending',
        reason: typeof payload.reason === 'string' ? payload.reason : '',
        createdAt: NOW,
      })
      return
    }

    const bundleMatch = /^\/v1\/agent-packages\/([^/]+)\/([^/]+)\/bundle$/.exec(pathname)
    if (request.method === 'GET' && bundleMatch !== null) {
      if (bundleRedirect !== undefined) {
        response.writeHead(302, { location: bundleRedirect })
        response.end()
        return
      }
      if (bundleChunkedOverflow) {
        // 不声明 content-length:强制走流式读取分支,由客户端在中途中止并删除。
        response.writeHead(200, { 'content-type': 'application/gzip' })
        const chunk = Buffer.alloc(1024 * 1024, 0x61)
        for (let index = 0; index < 6 && !response.destroyed; index += 1) {
          response.write(chunk)
        }
        response.end()
        return
      }
      response.writeHead(200, {
        'content-type': 'application/gzip',
        'content-length': String(bundleBytes.byteLength),
      })
      response.end(bundleBytes)
      return
    }

    const metadataMatch = /^\/v1\/agent-packages\/([^/]+)\/([^/]+)$/.exec(pathname)
    if (request.method === 'GET' && metadataMatch !== null) {
      const slug = decodeURIComponent(metadataMatch[1] ?? '')
      const version = decodeURIComponent(metadataMatch[2] ?? '')
      sendJson(response, 200, {
        slug,
        version,
        status: packageStatus,
        displayName: '周报小助手',
        description: '把一周工作整理成周报',
        size: bundleBytes.byteLength,
        updatedAt: NOW,
        ...(packageStatus === 'published'
          ? {
              bundleUrl:
                bundleUrlOverride ?? `/v1/agent-packages/${encodeURIComponent(slug)}/${encodeURIComponent(version)}/bundle`,
            }
          : {}),
      })
      return
    }

    sendJson(response, 404, { error: 'Not Found', code: 'not-found' })
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    response.end()
  }
}

function configuredSettings(overrides: Partial<AgentCatalogSettings> = {}): AgentCatalogSettings {
  return {
    agents_host: '127.0.0.1',
    agents_port: port,
    agents_catalog_token: READ_TOKEN,
    agents_catalog_publish_token: PUBLISH_TOKEN,
    ...overrides,
  }
}

function configure(overrides: Partial<AgentCatalogSettings> = {}): void {
  settings = configuredSettings(overrides)
  loggerLines = []
  changedSlugs = []
  configureAgentCatalog({
    profileDir: root,
    readSettings: () => settings,
    logger: (line) => loggerLines.push(line),
    emitChanged: (slug) => changedSlugs.push(slug),
  })
}

function validManifest(slug = 'weekly-report', version = '1.0.0'): AgentPackageManifest {
  const parsed = parseAgentPackageManifest({ ...VALID, slug, version })
  if (!parsed.ok) throw new Error(`fixture manifest invalid: ${JSON.stringify(parsed.fieldErrors)}`)
  return parsed.manifest
}

function writeLocalPackage(slug = 'weekly-report', version = '1.0.0'): AgentPackageManifest {
  const manifest = validManifest(slug, version)
  writeAgentPackageAtomically({
    profileDir: root,
    manifest,
    persona: '# 周报小助手\n把一周工作整理成周报。',
    skill: null,
    replace: false,
  })
  return manifest
}

function writeSignedPackage(slug = 'weekly-report', version = '1.0.0'): void {
  writeLocalPackage(slug, version)
  const signatureDir = join(agentPackageDir(root, slug), '.signature')
  mkdirSync(signatureDir, { recursive: true })
  writeFileSync(join(signatureDir, 'package-digest.json'), '{}\n', 'utf8')
  writeFileSync(join(signatureDir, 'signature.json'), '{}\n', 'utf8')
}

function seedState(state: AgentPackageState): void {
  writeAgentPackageState(root, state)
}

const PENDING_SUBMISSIONS_FILE = 'agent-catalog-pending-submissions.json'
const IDEMPOTENCY_KEY = '33333333-3333-4333-8333-333333333333'

function pendingSubmissionsPath(): string {
  return join(root, PENDING_SUBMISSIONS_FILE)
}

function readPendingSubmissions(): Record<string, Record<string, unknown>> {
  try {
    return JSON.parse(readFileSync(pendingSubmissionsPath(), 'utf8')) as Record<string, Record<string, unknown>>
  } catch {
    return {}
  }
}

function seedPendingSubmission(slug: string, entry: Record<string, unknown>): void {
  writeFileSync(pendingSubmissionsPath(), `${JSON.stringify({ [slug]: entry }, null, 2)}\n`, 'utf8')
}

/**
 * 与 publish 完全相同的内容身份:sidecar 对账现在要求版本 + digest 都匹配
 * 当前内容,测试必须写入真实的摘要而不是占位值。
 */
async function localContentDigest(slug = 'weekly-report'): Promise<string> {
  const files = readUnsignedPackageFiles(agentPackageDir(root, slug))
  const bundle = await buildUnsignedAgentPackageBundle(files)
  const inspection = await inspectUnsignedAgentPackageBundle(bundle)
  return createHash('sha256').update(canonicalJson(inspection.digest), 'utf8').digest('hex')
}

/**
 * 让下一次 `writeAgentPackageState` 失败:它的 tmp 路径被一个目录占住,
 * `writeFileSync` 抛 EISDIR 且 rename 不会执行。比 mock ESM 导出更接近真实
 * 磁盘故障,也能在同一个测试里恢复后重试。
 */
function blockStateWrite(): string {
  const blocker = `${agentPackageStatePath(root)}.tmp`
  mkdirSync(blocker)
  return blocker
}

function rawStateFile(): string {
  return readFileSync(agentPackageStatePath(root), 'utf8')
}

function summaryFor(slug: string): Record<string, unknown> {
  return {
    slug,
    displayName: `广场 ${slug}`,
    description: '来自签名广场',
    version: '1.0.0',
    size: 10,
    status: 'published',
    updatedAt: NOW,
  }
}

async function commitExistingUpdate(slug = 'weekly-report'): Promise<void> {
  const sessionId = 'session-update'
  await beginAgentPackageUpdate(root, sessionId, slug)
  const draft = loadAgentPackageDraft(root, sessionId)
  if (draft === undefined) throw new Error('update draft was not written')
  const result = await commitAgentPackage(root, sessionId, draft.draftId, '可以', [])
  if (!result.ok) throw new Error(result.error)
}

function bodyText(body: Buffer): string {
  return body.toString('latin1')
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

describe('agent package state model', () => {
  test('keeps whitelisted M2 fields, drops unknown fields, and defaults publish status by source', () => {
    seedState({
      'local:local-one': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'published',
        publishedVersion: '0.9.0',
        submissionId: 'submission-1',
        reviewReason: '补充说明',
        delistRequestId: 'delist-1',
        revoked: {
          slug: 'local-one',
          version: '0.9.0',
          reason: '不安全',
          revokedAt: NOW,
          actor: 'admin',
        },
        unknownField: 'dropped',
      } as never,
      'catalog:catalog-one': {
        source: 'catalog',
        enabled: false,
        installedVersion: '2.0.0',
      } as never,
      'local:wrong-source': { source: 'catalog', enabled: true, installedVersion: '1.0.0' } as never,
      'catalog:wrong-source': { source: 'local', enabled: true, installedVersion: '1.0.0' } as never,
      'other:elsewhere': { source: 'local', enabled: true, installedVersion: '1.0.0' } as never,
    })

    const state = readAgentPackageState(root)
    expect(state['local:local-one']).toEqual({
      source: 'local',
      enabled: true,
      installedVersion: '1.0.0',
      publishStatus: 'published',
      publishedVersion: '0.9.0',
      submissionId: 'submission-1',
      reviewReason: '补充说明',
      delistRequestId: 'delist-1',
      revoked: { slug: 'local-one', version: '0.9.0', reason: '不安全', revokedAt: NOW },
    })
    expect(state['catalog:catalog-one']).toEqual({
      source: 'catalog',
      enabled: false,
      installedVersion: '2.0.0',
      publishStatus: 'installed',
    })
    expect(state['local:wrong-source']).toBeUndefined()
    expect(state['catalog:wrong-source']).toBeUndefined()
    expect(state['other:elsewhere']).toBeUndefined()
  })

  test('local enable toggle preserves every M2 field and never writes a second key', () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'published',
        publishedVersion: '0.9.0',
        submissionId: 'submission-1',
        reviewReason: '补充说明',
        delistRequestId: 'delist-1',
        revoked: { slug: 'weekly-report', version: '0.9.0', reason: '不安全', revokedAt: NOW },
      },
    })

    setAgentPackageEnabled(root, 'weekly-report', false)

    const state = readAgentPackageState(root)
    expect(Object.keys(state)).toEqual(['local:weekly-report'])
    expect(state['local:weekly-report']).toEqual({
      source: 'local',
      enabled: false,
      installedVersion: '1.0.0',
      publishStatus: 'published',
      publishedVersion: '0.9.0',
      submissionId: 'submission-1',
      reviewReason: '补充说明',
      delistRequestId: 'delist-1',
      revoked: { slug: 'weekly-report', version: '0.9.0', reason: '不安全', revokedAt: NOW },
    })
    expect(readAgentPackage(root, 'weekly-report')).toMatchObject({
      source: 'local',
      enabled: false,
      publishStatus: 'published',
      publishedVersion: '0.9.0',
    })
  })

  test('catalog enable toggle writes the catalog key only and keeps M2 fields', () => {
    writeSignedPackage()
    seedState({
      'catalog:weekly-report': {
        source: 'catalog',
        enabled: false,
        installedVersion: '1.0.0',
        publishStatus: 'installed',
        publishedVersion: '0.9.0',
        submissionId: 'submission-1',
        reviewReason: '补充说明',
        delistRequestId: 'delist-1',
        revoked: { slug: 'weekly-report', version: '0.9.0', reason: '不安全', revokedAt: NOW },
      },
    })

    setAgentPackageEnabled(root, 'weekly-report', true)

    const raw = JSON.parse(rawStateFile()) as Record<string, unknown>
    expect(Object.keys(raw)).toEqual(['catalog:weekly-report'])
    expect(readAgentPackageState(root)['catalog:weekly-report']).toEqual({
      source: 'catalog',
      enabled: true,
      installedVersion: '1.0.0',
      publishStatus: 'installed',
      publishedVersion: '0.9.0',
      submissionId: 'submission-1',
      reviewReason: '补充说明',
      delistRequestId: 'delist-1',
      revoked: { slug: 'weekly-report', version: '0.9.0', reason: '不安全', revokedAt: NOW },
    })
    expect(readAgentPackage(root, 'weekly-report')).toMatchObject({
      source: 'catalog',
      enabled: true,
      publishStatus: 'installed',
    })
    expect(listLocalAgentPackages(root)[0]).toMatchObject({ source: 'catalog', enabled: true })
  })

  test('a signed directory without catalog state is catalog-broken and never local', () => {
    writeSignedPackage()

    const detail = readAgentPackage(root, 'weekly-report')
    expect(detail?.source).toBe('catalog')
    expect(detail?.enabled).toBe(false)
    expect(detail?.broken?.reason).toMatch(/catalog/)

    const listed = listLocalAgentPackages(root)[0]
    expect(listed?.source).toBe('catalog')
    expect(listed?.broken?.reason).toMatch(/catalog/)

    expect(() => setAgentPackageEnabled(root, 'weekly-report', true)).toThrow(/catalog/)
  })

  test('a stale local: key cannot enable or publish-field a signed directory', () => {
    writeSignedPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'published',
        publishedVersion: '1.0.0',
        submissionId: 'submission-1',
      },
    })

    const detail = readAgentPackage(root, 'weekly-report')
    expect(detail?.source).toBe('catalog')
    // source 来自 .signature;enabled/发布字段不得来自 stale local: 键。
    expect(detail?.enabled).toBe(false)
    expect(detail?.publishStatus).toBeUndefined()
    expect(detail?.publishedVersion).toBeUndefined()
    expect(detail?.submissionId).toBeUndefined()
    expect(detail?.broken?.reason).toMatch(/catalog/)

    const before = rawStateFile()
    expect(() => setAgentPackageEnabled(root, 'weekly-report', false)).toThrow(/catalog/)
    expect(() => setAgentPackageEnabled(root, 'weekly-report', true)).toThrow(/catalog/)
    expect(rawStateFile()).toBe(before)
  })

  test('two state keys for one slug report corruption instead of guessing', () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': { source: 'local', enabled: true, installedVersion: '1.0.0' },
      'catalog:weekly-report': { source: 'catalog', enabled: false, installedVersion: '1.0.0' },
    })

    expect(readAgentPackage(root, 'weekly-report')?.broken?.reason).toMatch(/状态损坏/)
    expect(listLocalAgentPackages(root)[0]?.broken?.reason).toMatch(/状态损坏/)
    expect(() => setAgentPackageEnabled(root, 'weekly-report', true)).toThrow(/状态损坏/)
    expect(() => setAgentPackageEnabled(root, 'weekly-report', false)).toThrow(/状态损坏/)
  })
})

describe('local publication lifecycle', () => {
  test('submit stores pending status and never uses read/admin credentials', async () => {
    writeLocalPackage()
    configure()

    const result = await publishLocalAgentPackage('weekly-report')
    expect(result.submissionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(readAgentPackageState(root)['local:weekly-report']?.publishStatus).toBe('pending-review')
    expect(readAgentPackageState(root)['local:weekly-report']?.submissionId).toBe(result.submissionId)

    const submitRequest = requests.find(
      (request) => request.method === 'POST' && request.url === '/v1/agent-packages/submissions',
    )
    expect(submitRequest).toBeDefined()
    expect(submitRequest?.authorization).toBe(`Bearer ${PUBLISH_TOKEN}`)
    expect(submitRequest?.contentType).toBe('application/gzip')
    expect(submitRequest?.body.subarray(0, 2).toString('hex')).toBe('1f8b')

    const text = bodyText(submitRequest?.body ?? Buffer.alloc(0))
    for (const secret of [READ_TOKEN, PUBLISH_TOKEN, ADMIN_TOKEN, PRIVATE_KEY_MARKER, 'Authorization']) {
      expect(text.includes(secret)).toBe(false)
    }

    expect(changedSlugs).toEqual(['weekly-report'])
    expect(loggerLines.some((line) => line.includes('publish.submit') && line.includes('outcome=ok'))).toBe(true)
    for (const line of loggerLines) {
      expect(line.includes(READ_TOKEN)).toBe(false)
      expect(line.includes(PUBLISH_TOKEN)).toBe(false)
      expect(line.includes(ADMIN_TOKEN)).toBe(false)
      expect(line.includes('Authorization')).toBe(false)
    }
  })

  test('local content commit resets publication but preserves enabled', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'published',
        publishedVersion: '1.0.0',
        submissionId: 'submission-1',
        reviewReason: '旧说明',
        delistRequestId: 'delist-1',
        revoked: { slug: 'weekly-report', version: '1.0.0', reason: '旧撤销', revokedAt: NOW },
      },
    })

    await commitExistingUpdate()

    const state = readAgentPackageState(root)['local:weekly-report']
    expect(state?.enabled).toBe(true)
    expect(state?.installedVersion).toBe('1.0.1')
    expect(state?.publishStatus).toBe('none')
    expect(state?.submissionId).toBeUndefined()
    expect(state?.reviewReason).toBeUndefined()
    expect(state?.delistRequestId).toBeUndefined()
    expect(state?.revoked).toBeUndefined()
    expect(state?.publishedVersion).toBe('1.0.0')
  })

  test('a rejected submission records the review reason', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'pending-review',
        submissionId: SUBMISSION_ID,
      },
    })
    submissionStatus = 'rejected'
    submissionReason = '脚本权限过大'
    configure()

    const publication = await refreshLocalAgentPackagePublishStatus('weekly-report')

    expect(publication.publishStatus).toBe('rejected')
    expect(publication.reviewReason).toBe('脚本权限过大')
    const state = readAgentPackageState(root)['local:weekly-report']
    expect(state?.publishStatus).toBe('rejected')
    expect(state?.reviewReason).toBe('脚本权限过大')
    expect(state?.submissionId).toBe(SUBMISSION_ID)
    expect(state?.enabled).toBe(true)
    const statusRequest = requests.find(
      (request) => request.method === 'GET' && request.url === `/v1/agent-packages/submissions/${SUBMISSION_ID}`,
    )
    expect(statusRequest?.authorization).toBe(`Bearer ${PUBLISH_TOKEN}`)
  })

  test('an approved submission becomes published with the manifest version', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'pending-review',
        submissionId: SUBMISSION_ID,
      },
    })
    submissionStatus = 'published'
    configure()

    const publication = await refreshLocalAgentPackagePublishStatus('weekly-report')

    expect(publication.publishStatus).toBe('published')
    expect(publication.publishedVersion).toBe('1.0.0')
    const state = readAgentPackageState(root)['local:weekly-report']
    expect(state?.publishStatus).toBe('published')
    expect(state?.publishedVersion).toBe('1.0.0')
    expect(state?.reviewReason).toBeUndefined()
    expect(state?.enabled).toBe(true)
  })

  test('delisted catalog metadata flips an already published local package', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'published',
        publishedVersion: '1.0.0',
      },
    })
    packageStatus = 'delisted'
    configure()

    const publication = await refreshLocalAgentPackagePublishStatus('weekly-report')

    expect(publication.publishStatus).toBe('delisted')
    expect(readAgentPackageState(root)['local:weekly-report']?.publishStatus).toBe('delisted')
    expect(readAgentPackageState(root)['local:weekly-report']?.enabled).toBe(true)
    const metadataRequest = requests.find(
      (request) => request.method === 'GET' && request.url === '/v1/agent-packages/weekly-report/1.0.0',
    )
    expect(metadataRequest?.authorization).toBe(`Bearer ${READ_TOKEN}`)
  })

  test('delist requires a published package and stores the request id', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'published',
        publishedVersion: '1.0.0',
      },
    })
    configure()

    const result = await requestLocalAgentPackageDelist('weekly-report', '  内容有误  ')

    expect(result.requestId).toBe(DELIST_REQUEST_ID)
    expect(readAgentPackageState(root)['local:weekly-report']?.delistRequestId).toBe(DELIST_REQUEST_ID)
    expect(readAgentPackageState(root)['local:weekly-report']?.publishStatus).toBe('published')
    const delistRequest = requests.find(
      (request) =>
        request.method === 'POST' &&
        request.url === '/v1/agent-packages/weekly-report/1.0.0/delist-requests',
    )
    expect(delistRequest?.authorization).toBe(`Bearer ${PUBLISH_TOKEN}`)
    expect(delistRequest?.contentType).toBe('application/json')
    expect(JSON.parse(delistRequest?.body.toString('utf8') ?? '{}')).toEqual({ reason: '内容有误' })

    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'none',
      },
    })
    await expect(requestLocalAgentPackageDelist('weekly-report', '内容有误')).rejects.toThrow(/已发布/)
  })

  test('missing publish token reports the auth error and leaves state unchanged', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: false,
        installedVersion: '1.0.0',
        publishStatus: 'none',
      },
    })
    configure({ agents_catalog_publish_token: '' })

    await expect(publishLocalAgentPackage('weekly-report')).rejects.toThrow(AGENT_CATALOG_AUTH_ERROR)
    expect(requests).toHaveLength(0)
    expect(readAgentPackageState(root)['local:weekly-report']?.publishStatus).toBe('none')
    expect(readAgentPackageState(root)['local:weekly-report']?.submissionId).toBeUndefined()
  })

  test('network failure preserves the previous publication state', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'published',
        publishedVersion: '1.0.0',
        submissionId: SUBMISSION_ID,
      },
    })
    configure()
    const before = rawStateFile()
    await stopCatalogServer()

    await expect(refreshLocalAgentPackagePublishStatus('weekly-report')).rejects.toThrow(
      AGENT_CATALOG_UNREACHABLE_ERROR,
    )
    expect(rawStateFile()).toBe(before)
  })

  test('a duplicate pending submission is not sent again', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'pending-review',
        submissionId: SUBMISSION_ID,
      },
    })
    configure()

    await expect(publishLocalAgentPackage('weekly-report')).rejects.toThrow(/审查中/)
    expect(requests).toHaveLength(0)
    expect(readAgentPackageState(root)['local:weekly-report']?.submissionId).toBe(SUBMISSION_ID)
  })

  test('a commit during the upload leaves the new content unpublished', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'none',
      },
    })
    configure()
    const gate = deferred()
    submitGate = gate.promise

    const publishing = publishLocalAgentPackage('weekly-report')
    await waitFor(
      () =>
        requests.some(
          (request) => request.method === 'POST' && request.url === '/v1/agent-packages/submissions',
        ),
      'submit request',
    )
    // 上传还挂着时提交一次内容更新:版本 1.0.0 → 1.0.1,发布状态复位。
    // Task 10 起 commit 会排在 publish lock 后面,必须先放行上传才能收敛。
    const committing = commitExistingUpdate()
    submitGate = undefined
    gate.release()

    await expect(publishing).resolves.toEqual({ submissionId: SUBMISSION_ID })
    await committing

    const state = readAgentPackageState(root)['local:weekly-report']
    expect(state?.installedVersion).toBe('1.0.1')
    expect(state?.publishStatus).toBe('none')
    expect(state?.submissionId).toBeUndefined()
    // 旧内容的提交确实创建了远端记录(并发出一次 changed),但随后的 commit
    // 改变内容并把发布状态复位,新内容仍是「未发布」。
    expect(changedSlugs).toEqual(['weekly-report'])
    expect(loggerLines.some((line) => line.includes('publish.submit') && line.includes('outcome=ok'))).toBe(true)
  })

  test('records the remote submission before a local state failure and reuses it on retry', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'none',
      },
    })
    configure()
    const blocker = blockStateWrite()

    await expect(publishLocalAgentPackage('weekly-report')).rejects.toThrow()

    // 远端事实先落 sidecar:state 没写成也必须留下 submissionId 与幂等键。
    const pending = readPendingSubmissions()['weekly-report']
    expect(pending?.submissionId).toBe(SUBMISSION_ID)
    expect(pending?.version).toBe('1.0.0')
    expect(pending?.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(pending?.digestSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(readAgentPackageState(root)['local:weekly-report']?.publishStatus).toBe('none')

    rmSync(blocker, { recursive: true, force: true })
    const retried = await publishLocalAgentPackage('weekly-report')

    expect(retried.submissionId).toBe(SUBMISSION_ID)
    // 重试复用 sidecar,不再发第二次提交。
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    const state = readAgentPackageState(root)['local:weekly-report']
    expect(state?.publishStatus).toBe('pending-review')
    expect(state?.submissionId).toBe(SUBMISSION_ID)
    expect(readPendingSubmissions()['weekly-report']).toBeUndefined()
  })

  test('recovers a lost 201 by resubmitting with the recorded key', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'none',
      },
    })
    configure()
    const blocker = blockStateWrite()
    await expect(publishLocalAgentPackage('weekly-report')).rejects.toThrow()
    rmSync(blocker, { recursive: true, force: true })

    // 模拟 201 在返回途中丢失:sidecar 留下键,但没有 submissionId。
    const recorded = readPendingSubmissions()['weekly-report']
    if (recorded === undefined) throw new Error('sidecar was not written')
    seedPendingSubmission('weekly-report', {
      version: recorded.version,
      digestSha256: recorded.digestSha256,
      idempotencyKey: recorded.idempotencyKey,
      createdAt: recorded.createdAt,
    })

    const retried = await publishLocalAgentPackage('weekly-report')

    expect(retried.submissionId).toBe(SUBMISSION_ID)
    const submits = requests.filter((request) => request.method === 'POST')
    expect(submits).toHaveLength(2)
    // 第二次提交必须复用同一个幂等键,服务端才能返回原记录。
    expect(submits[1]?.idempotencyKey).toBe(submits[0]?.idempotencyKey)
    expect(submits[1]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(readPendingSubmissions()['weekly-report']).toBeUndefined()
  })

  test('warns without touching state when the sidecar has no remote id', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'none',
      },
    })
    seedPendingSubmission('weekly-report', {
      version: '1.0.0',
      digestSha256: await localContentDigest(),
      idempotencyKey: IDEMPOTENCY_KEY,
      createdAt: NOW,
    })
    const before = rawStateFile()
    configure()

    const publication = await refreshLocalAgentPackagePublishStatus('weekly-report')

    expect(publication.publishStatus).toBe('none')
    expect(publication.warning).toContain(IDEMPOTENCY_KEY)
    expect(readPendingSubmissions()['weekly-report']?.idempotencyKey).toBe(IDEMPOTENCY_KEY)
    expect(requests).toHaveLength(0)
    expect(rawStateFile()).toBe(before)
  })

  test('keeps the stale sidecar and names the pending submission when content changed', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'none',
      },
    })
    configure()
    const blocker = blockStateWrite()
    await expect(publishLocalAgentPackage('weekly-report')).rejects.toThrow()
    rmSync(blocker, { recursive: true, force: true })

    // 本地内容变化(1.0.0 → 1.0.1)后,旧 sidecar 不能再被新内容覆盖提交。
    await commitExistingUpdate()

    await expect(publishLocalAgentPackage('weekly-report')).rejects.toThrow(
      new RegExp(`上一次提交 ${SUBMISSION_ID} 仍在对账，请先刷新状态`),
    )
    expect(readPendingSubmissions()['weekly-report']?.submissionId).toBe(SUBMISSION_ID)
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    expect(readAgentPackageState(root)['local:weekly-report']?.publishStatus).toBe('none')
  })

  test('reconciles a recorded pending submission through getSubmission on refresh', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'none',
      },
    })
    seedPendingSubmission('weekly-report', {
      submissionId: SUBMISSION_ID,
      version: '1.0.0',
      digestSha256: await localContentDigest(),
      idempotencyKey: IDEMPOTENCY_KEY,
      createdAt: NOW,
    })
    submissionStatus = 'published'
    configure()

    const publication = await refreshLocalAgentPackagePublishStatus('weekly-report')

    expect(publication.publishStatus).toBe('published')
    expect(publication.publishedVersion).toBe('1.0.0')
    expect(publication.submissionId).toBe(SUBMISSION_ID)
    const state = readAgentPackageState(root)['local:weekly-report']
    expect(state?.publishStatus).toBe('published')
    expect(state?.publishedVersion).toBe('1.0.0')
    expect(state?.submissionId).toBe(SUBMISSION_ID)
    expect(readPendingSubmissions()['weekly-report']).toBeUndefined()
    const statusRequest = requests.find(
      (request) => request.method === 'GET' && request.url === `/v1/agent-packages/submissions/${SUBMISSION_ID}`,
    )
    expect(statusRequest?.authorization).toBe(`Bearer ${PUBLISH_TOKEN}`)
  })

  test('does not apply a stale sidecar to newer content after a commit', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'none',
      },
    })
    configure()
    const blocker = blockStateWrite()
    await expect(publishLocalAgentPackage('weekly-report')).rejects.toThrow()
    rmSync(blocker, { recursive: true, force: true })
    // state 写失败留下 sidecar(v1.0.0 的远端提交);随后 commit 把本地内容改成
    // 1.0.1,但 manifest 永久保留旧 draftId ⇒ 旧提交仍能被解析出来。
    await commitExistingUpdate()
    submissionStatus = 'published'

    const publication = await refreshLocalAgentPackagePublishStatus('weekly-report')

    expect(publication.publishStatus).toBe('none')
    expect(publication.publishedVersion).toBeUndefined()
    expect(publication.warning).toBe(
      `上一次提交 ${SUBMISSION_ID} 针对 v1.0.0，当前内容为 v1.0.1；请先处理该提交。`,
    )
    const state = readAgentPackageState(root)['local:weekly-report']
    expect(state?.installedVersion).toBe('1.0.1')
    expect(state?.publishStatus).toBe('none')
    expect(state?.publishedVersion).toBeUndefined()
    expect(state?.submissionId).toBeUndefined()
    // sidecar 保留给用户处理,旧提交没有被查询、更没有写到新内容上。
    expect(readPendingSubmissions()['weekly-report']?.submissionId).toBe(SUBMISSION_ID)
    expect(
      requests.filter(
        (request) => request.method === 'GET' && request.url?.startsWith('/v1/agent-packages/submissions/'),
      ),
    ).toHaveLength(0)
  })

  test('does not apply a sidecar from different content at the same version', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'none',
      },
    })
    seedPendingSubmission('weekly-report', {
      submissionId: SUBMISSION_ID,
      version: '1.0.0',
      digestSha256: await localContentDigest(),
      idempotencyKey: IDEMPOTENCY_KEY,
      createdAt: NOW,
    })
    // 版本号没变、内容变了:digest 必须单独把关。
    writeFileSync(
      join(agentPackageDir(root, 'weekly-report'), 'persona.md'),
      '# 周报小助手\n把一周工作整理成周报。改过的人设。',
      'utf8',
    )
    submissionStatus = 'published'
    configure()

    const publication = await refreshLocalAgentPackagePublishStatus('weekly-report')

    expect(publication.publishStatus).toBe('none')
    expect(publication.warning).toBe(
      `上一次提交 ${SUBMISSION_ID} 针对 v1.0.0，内容已变化；请先处理该提交。`,
    )
    expect(readPendingSubmissions()['weekly-report']?.submissionId).toBe(SUBMISSION_ID)
    expect(readAgentPackageState(root)['local:weekly-report']?.publishStatus).toBe('none')
    expect(requests).toHaveLength(0)
  })

  test('keeps the sidecar and returns a warning when reconciliation is unreachable', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'none',
      },
    })
    seedPendingSubmission('weekly-report', {
      submissionId: SUBMISSION_ID,
      version: '1.0.0',
      digestSha256: await localContentDigest(),
      idempotencyKey: IDEMPOTENCY_KEY,
      createdAt: NOW,
    })
    configure()
    await stopCatalogServer()

    const publication = await refreshLocalAgentPackagePublishStatus('weekly-report')

    expect(publication.publishStatus).toBe('none')
    expect(publication.warning).toContain(SUBMISSION_ID)
    expect(readPendingSubmissions()['weekly-report']?.submissionId).toBe(SUBMISSION_ID)
    expect(readAgentPackageState(root)['local:weekly-report']?.publishStatus).toBe('none')
  })

  test('a commit during the upload waits for the publish lock and is not submitted twice', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'none',
      },
    })
    configure()
    const gate = deferred()
    submitGate = gate.promise

    const publishing = publishLocalAgentPackage('weekly-report')
    await waitFor(
      () =>
        requests.some(
          (request) => request.method === 'POST' && request.url === '/v1/agent-packages/submissions',
        ),
      'submit request',
    )
    let commitDone = false
    const committing = commitExistingUpdate().then(() => {
      commitDone = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    // 同一 slug 的 publish 与 commit 共用 publish lock:上传在飞时 commit 必须等待。
    expect(commitDone).toBe(false)

    submitGate = undefined
    gate.release()
    await expect(publishing).resolves.toEqual({ submissionId: SUBMISSION_ID })
    await committing

    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    const state = readAgentPackageState(root)['local:weekly-report']
    expect(state?.installedVersion).toBe('1.0.1')
    expect(state?.publishStatus).toBe('none')
    expect(state?.submissionId).toBeUndefined()
    expect(readPendingSubmissions()['weekly-report']).toBeUndefined()
  })

  test('a commit during a status refresh does not resurrect the cleared submission', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'pending-review',
        submissionId: SUBMISSION_ID,
      },
    })
    configure()
    const gate = deferred()
    submissionPollGate = gate.promise

    const refreshing = refreshLocalAgentPackagePublishStatus('weekly-report')
    await waitFor(
      () =>
        requests.some(
          (request) =>
            request.method === 'GET' && request.url === `/v1/agent-packages/submissions/${SUBMISSION_ID}`,
        ),
      'status request',
    )
    await commitExistingUpdate()
    submissionPollGate = undefined
    gate.release()

    const publication = await refreshing
    expect(publication.publishStatus).toBe('none')
    expect(publication.submissionId).toBeUndefined()

    const state = readAgentPackageState(root)['local:weekly-report']
    expect(state?.installedVersion).toBe('1.0.1')
    expect(state?.publishStatus).toBe('none')
    expect(state?.submissionId).toBeUndefined()
    expect(state?.reviewReason).toBeUndefined()
    expect(state?.delistRequestId).toBeUndefined()
  })

  test('a commit during a delist request refuses to attach the request id', async () => {
    writeLocalPackage()
    seedState({
      'local:weekly-report': {
        source: 'local',
        enabled: true,
        installedVersion: '1.0.0',
        publishStatus: 'published',
        publishedVersion: '1.0.0',
      },
    })
    configure()
    const gate = deferred()
    delistGate = gate.promise

    const requesting = requestLocalAgentPackageDelist('weekly-report', '内容有误')
    await waitFor(
      () =>
        requests.some(
          (request) =>
            request.method === 'POST' &&
            request.url === '/v1/agent-packages/weekly-report/1.0.0/delist-requests',
        ),
      'delist request',
    )
    await commitExistingUpdate()
    delistGate = undefined
    gate.release()

    await expect(requesting).rejects.toThrow('智能体状态已变化，请刷新后重试')

    const state = readAgentPackageState(root)['local:weekly-report']
    expect(state?.installedVersion).toBe('1.0.1')
    expect(state?.publishStatus).toBe('none')
    expect(state?.delistRequestId).toBeUndefined()
  })
})

describe('catalog cache and taken slugs', () => {
  test('cache refresh writes the documented shape and keeps the previous cache on failure', async () => {
    configure()
    listItems = [summaryFor('plaza-agent'), summaryFor('plaza-second')]

    const refreshed = await refreshCatalogPackageCache()
    expect(refreshed.warning).toBeUndefined()
    expect(refreshed.items.map((item) => item.slug)).toEqual(['plaza-agent', 'plaza-second'])
    expect(readCachedCatalogPackageSlugs()).toEqual(['plaza-agent', 'plaza-second'])

    const cachePath = agentCatalogPackagesCachePath(root)
    const written = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      schemaVersion: number
      fetchedAt: string
      items: Array<{ slug: string }>
    }
    expect(written.schemaVersion).toBe(1)
    expect(written.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(written.items.map((item) => item.slug)).toEqual(['plaza-agent', 'plaza-second'])
    expect(requests[0]?.authorization).toBe(`Bearer ${READ_TOKEN}`)

    const before = readFileSync(cachePath, 'utf8')
    await stopCatalogServer()
    const failed = await refreshCatalogPackageCache()
    expect(failed.warning).toMatch(/目录不可达/)
    expect(failed.items.map((item) => item.slug)).toEqual(['plaza-agent', 'plaza-second'])
    expect(readFileSync(cachePath, 'utf8')).toBe(before)
  })

  test('cached plaza slugs are rejected by the host takenSlugs', async () => {
    const config = hostConfig(root)
    const cachePath = agentCatalogPackagesCachePath(config.profileDir)
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(
      cachePath,
      `${JSON.stringify({ schemaVersion: 1, fetchedAt: NOW, items: [summaryFor('plaza-agent')] }, null, 2)}\n`,
      'utf8',
    )

    const booted = await bootHuaanworkHost(config)
    try {
      const result = await booted.ctx.huaanworkAgentPackageHost.propose('session-plaza', {
        mode: 'create',
        displayName: '广场重名',
        slug: 'plaza-agent',
        description: '与广场条目重名',
        persona: '你是广场助手。',
        tools: 'none',
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.fieldErrors.some((error) => error.field === 'slug' && /重名/.test(error.message))).toBe(true)
    } finally {
      await booted.ctx.fiber.dispose()
    }
  })

  test('cache readers ignore corrupt files', () => {
    configure()
    writeFileSync(agentCatalogPackagesCachePath(root), '{ not json', 'utf8')
    expect(readCachedCatalogPackageSlugs()).toEqual([])
  })
})

describe('catalog client transport limits', () => {
  test('read operations use the read token and drop audit-only revocation actors', async () => {
    configure()
    listItems = [summaryFor('plaza-agent')]
    revocationItems = [
      { slug: 'plaza-agent', version: '1.0.0', reason: '不安全', revokedAt: NOW, actor: 'admin' },
    ]

    const client = getAgentCatalogClient()
    const packages = await client.listPackages()
    expect(packages.map((item) => item.slug)).toEqual(['plaza-agent'])
    const revocations = await client.getRevocations()
    expect(revocations).toEqual([{ slug: 'plaza-agent', version: '1.0.0', reason: '不安全', revokedAt: NOW }])
    for (const request of requests) {
      expect(request.authorization).toBe(`Bearer ${READ_TOKEN}`)
    }
  })

  test('a cross-origin bundleUrl is rejected without sending the token', async () => {
    const altRequests: string[] = []
    const altServer = createServer((request, response) => {
      altRequests.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'application/gzip' })
      response.end('stolen')
    })
    await new Promise<void>((resolve) => altServer.listen(0, '127.0.0.1', resolve))
    const address = altServer.address()
    if (address === null || typeof address === 'string') throw new Error('alt server did not bind')
    const altUrl = `http://127.0.0.1:${address.port}`

    try {
      configure()
      bundleUrlOverride = `${altUrl}/v1/agent-packages/weekly-report/1.0.0/bundle`
      const destination = join(root, 'bundle.tgz')

      await expect(
        getAgentCatalogClient().downloadBundleToFile('weekly-report', '1.0.0', destination),
      ).rejects.toThrow(/下载地址|其他来源|拒绝/)
      expect(altRequests).toEqual([])
      expect(existsSync(destination)).toBe(false)
      expect(
        requests.every((request) => request.authorization !== `Bearer ${READ_TOKEN}` || !request.url?.startsWith(altUrl)),
      ).toBe(true)
    } finally {
      await new Promise<void>((resolve) => altServer.close(() => resolve()))
    }
  })

  test('a redirect on the bundle route is refused without following it', async () => {
    const altRequests: string[] = []
    const altServer = createServer((request, response) => {
      altRequests.push(request.url ?? '')
      response.writeHead(200)
      response.end('stolen')
    })
    await new Promise<void>((resolve) => altServer.listen(0, '127.0.0.1', resolve))
    const address = altServer.address()
    if (address === null || typeof address === 'string') throw new Error('alt server did not bind')

    try {
      configure()
      bundleRedirect = `http://127.0.0.1:${address.port}/v1/agent-packages/weekly-report/1.0.0/bundle`
      const destination = join(root, 'bundle.tgz')
      await expect(
        getAgentCatalogClient().downloadBundleToFile('weekly-report', '1.0.0', destination),
      ).rejects.toThrow(/重定向/)
      expect(altRequests).toEqual([])
      expect(existsSync(destination)).toBe(false)
    } finally {
      await new Promise<void>((resolve) => altServer.close(() => resolve()))
    }
  })

  test('a bundle download writes the file and sends the read token', async () => {
    configure()
    const destination = join(root, 'bundle.tgz')

    await getAgentCatalogClient().downloadBundleToFile('weekly-report', '1.0.0', destination)

    expect(readFileSync(destination)).toEqual(bundleBytes)
    const bundleRequest = requests.find(
      (request) => request.method === 'GET' && request.url === '/v1/agent-packages/weekly-report/1.0.0/bundle',
    )
    expect(bundleRequest?.authorization).toBe(`Bearer ${READ_TOKEN}`)
  })

  test('a bundle larger than 5 MiB aborts and deletes the partial file', async () => {
    configure()
    bundleBytes = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61)
    const destination = join(root, 'bundle.tgz')

    await expect(
      getAgentCatalogClient().downloadBundleToFile('weekly-report', '1.0.0', destination),
    ).rejects.toThrow(/5 MiB/)
    expect(existsSync(destination)).toBe(false)
  })

  test('a chunked bundle without content-length aborts mid-stream and deletes the partial file', async () => {
    configure()
    bundleChunkedOverflow = true
    const destination = join(root, 'bundle.tgz')

    await expect(
      getAgentCatalogClient().downloadBundleToFile('weekly-report', '1.0.0', destination),
    ).rejects.toThrow(/5 MiB/)
    expect(existsSync(destination)).toBe(false)
    const bundleRequest = requests.find(
      (request) => request.method === 'GET' && request.url === '/v1/agent-packages/weekly-report/1.0.0/bundle',
    )
    expect(bundleRequest?.authorization).toBe(`Bearer ${READ_TOKEN}`)
    expect(bundleRequest?.contentLength).toBeUndefined()
  })

  test('a JSON response larger than 1 MiB is rejected', async () => {
    configure()
    listPadding = 'x'.repeat(1024 * 1024 + 1)

    await expect(getAgentCatalogClient().listPackages()).rejects.toThrow(/1 MiB/)
  })

  test('401 and 403 map to the auth message and other statuses stay generic', async () => {
    configure()
    const client = getAgentCatalogClient()

    for (const status of [401, 403]) {
      listStatus = status
      await expect(client.listPackages()).rejects.toThrow(AGENT_CATALOG_AUTH_ERROR)
    }

    listStatus = 500
    await expect(client.listPackages()).rejects.toThrow(/HTTP 500/)
  })

  test('a 401 with an oversized body still maps to the auth message', async () => {
    configure()
    listStatus = 401
    listPadding = 'x'.repeat(1024 * 1024 + 1)

    await expect(getAgentCatalogClient().listPackages()).rejects.toThrow(AGENT_CATALOG_AUTH_ERROR)
  })

  test('logAgentPackageAction only emits whitelisted fields', () => {
    const lines: string[] = []
    const forged = {
      slug: 'weekly-report',
      version: '1.0.0',
      submissionId: SUBMISSION_ID,
      outcome: 'error' as const,
      reason: '目录不可达',
      token: PUBLISH_TOKEN,
      adminToken: ADMIN_TOKEN,
      authorization: `Bearer ${READ_TOKEN}`,
      privateKey: PRIVATE_KEY_MARKER,
    }
    logAgentPackageAction(
      (line) => lines.push(line),
      'publish.submit',
      forged as unknown as Parameters<typeof logAgentPackageAction>[2],
    )

    expect(lines).toHaveLength(1)
    const line = lines[0] ?? ''
    expect(line).toContain('publish.submit')
    expect(line).toContain('slug=weekly-report')
    expect(line).toContain(`submissionId=${SUBMISSION_ID}`)
    for (const secret of [READ_TOKEN, PUBLISH_TOKEN, ADMIN_TOKEN, PRIVATE_KEY_MARKER, 'Bearer']) {
      expect(line.includes(secret)).toBe(false)
    }
  })
})
