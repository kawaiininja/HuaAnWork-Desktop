import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { open, rm as removeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MAX_AGENT_PACKAGE_BUNDLE_BYTES } from '@huaanwork/agent-package-format/bundle'
import { catalogRootUrl } from '@huaanwork/policy/agent-catalog'
import { isLanEndpoint } from '@huaanwork/policy/network'

import type { AppSettings } from '../settings.ts'
import type { AgentPackageRevocation } from './types.ts'

/**
 * 桌面端签名广场 HTTP 客户端。
 *
 * 所有依赖(profileDir、settings 读取、client、logger、changed 事件)经
 * {@link configureAgentCatalog} 一次绑定;`index.ts` 在启动时绑定,测试在 setup
 * 里绑定。Task 9/10 复用同一绑定,不再各自注入。
 *
 * 安全边界:
 * - base URL 只从 `agents_host`/`agents_port` 经现有 LAN 校验构造,永不带 token
 *   请求其他 origin;
 * - read 操作使用 read token,submit/delist 使用 publish token;
 * - `bundleUrl` 必须解析到目录 root 的同源签名包路径,`redirect:'manual'`;
 * - 错误文案不附带 Authorization,也不回显服务端错误正文(服务端可能回显 token)。
 */

export const AGENT_CATALOG_AUTH_ERROR = '目录口令错误或权限不足'
export const AGENT_CATALOG_UNREACHABLE_ERROR = '目录不可达，请稍后重试；本地智能体不受影响'

export const DEFAULT_CATALOG_REQUEST_TIMEOUT_MS = 5_000
export const MAX_CATALOG_JSON_BYTES = 1024 * 1024

export type AgentCatalogSettings = Pick<
  AppSettings,
  'agents_host' | 'agents_port' | 'agents_catalog_token' | 'agents_catalog_publish_token'
>

/** `GET /v1/agent-packages` 的一项(客户端镜像,不从服务端包导入)。 */
export type AgentPackageSummary = {
  slug: string
  displayName: string
  description: string
  version: string
  size: number
  status: 'published'
  updatedAt: string
  migrationFrom?: string
}

/** `GET /v1/agent-packages/{slug}/{version}`。 */
export type AgentPackageMetadata = {
  slug: string
  version: string
  status: 'published' | 'delisted' | 'revoked'
  displayName: string
  description: string
  size: number
  updatedAt: string
  migrationFrom?: string
  bundleUrl?: string
  digest?: unknown
  signature?: unknown
}

export type AgentPackageSubmissionStatus = 'pending-review' | 'published' | 'rejected'

/** `POST /submissions` 与 `GET /submissions/{id}` 的客户端可见字段。 */
export type AgentPackageSubmission = {
  submissionId: string
  slug: string
  version: string
  status: AgentPackageSubmissionStatus
  submittedAt: string
  updatedAt: string
  reason?: string
}

export type AgentPackageDelistRequest = {
  id: string
  slug: string
  version: string
  status: 'pending' | 'approved' | 'rejected'
  reason: string
  createdAt: string
  resolvedAt?: string
}

export type AgentCatalogErrorCode =
  | 'auth'
  | 'unreachable'
  | 'http'
  | 'invalid-response'
  | 'response-too-large'
  | 'bundle-too-large'
  | 'cross-origin'
  | 'redirect'
  | 'not-downloadable'

export class AgentCatalogClientError extends Error {
  readonly code: AgentCatalogErrorCode
  readonly status: number | undefined

  constructor(message: string, code: AgentCatalogErrorCode, status?: number) {
    super(message)
    this.name = 'AgentCatalogClientError'
    this.code = code
    this.status = status
  }
}

export type AgentCatalogClient = {
  listPackages(): Promise<AgentPackageSummary[]>
  getPackage(slug: string, version: string): Promise<AgentPackageMetadata>
  /** 下载到调用方指定的临时文件;超过 5 MiB 立即中止并删除该文件。 */
  downloadBundleToFile(slug: string, version: string, destination: string): Promise<void>
  getRevocations(): Promise<AgentPackageRevocation[]>
  submit(bundle: Buffer): Promise<AgentPackageSubmission>
  getSubmission(submissionId: string): Promise<AgentPackageSubmission>
  requestDelist(slug: string, version: string, reason: string): Promise<AgentPackageDelistRequest>
}

export type CreateAgentCatalogClientOptions = {
  readSettings: () => AgentCatalogSettings
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * 构造客户端。settings 每次请求重新读取:设置面修改 host/port/token 后无需重建。
 */
export function createAgentCatalogClient(options: CreateAgentCatalogClientOptions): AgentCatalogClient {
  const fetchFn = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_CATALOG_REQUEST_TIMEOUT_MS

  async function catalogRoot(): Promise<{ rootUrl: string; settings: AgentCatalogSettings }> {
    const settings = options.readSettings()
    const rootUrl = catalogRootUrl(settings.agents_host, settings.agents_port)
    if (rootUrl === null || !isLanEndpoint(rootUrl)) {
      throw new AgentCatalogClientError(AGENT_CATALOG_UNREACHABLE_ERROR, 'unreachable')
    }
    return { rootUrl, settings }
  }

  async function requestJson(
    url: string,
    token: string | undefined,
    init: RequestInit,
  ): Promise<{ status: number; body: unknown }> {
    let response: Response
    try {
      response = await fetchFn(url, buildInit(init, token, timeoutMs))
    } catch {
      throw new AgentCatalogClientError(AGENT_CATALOG_UNREACHABLE_ERROR, 'unreachable')
    }
    if (isRedirect(response.status)) {
      throw new AgentCatalogClientError('目录请求被重定向，已拒绝', 'redirect', response.status)
    }
    // 先按状态码分类再读正文:错误响应(401/403/其它非 2xx)的正文永远不参与
    // 大小判定,否则一个超大错误页会把「口令错误」误报成「响应超过 1 MiB」。
    if (response.status === 401 || response.status === 403) {
      throw new AgentCatalogClientError(AGENT_CATALOG_AUTH_ERROR, 'auth', response.status)
    }
    if (!response.ok) {
      // 不回显服务端错误正文:它可能包含服务端视角的 token 片段。
      throw new AgentCatalogClientError(`目录请求失败（HTTP ${response.status}）`, 'http', response.status)
    }
    let body: Buffer
    try {
      body = await readCappedBuffer(response, MAX_CATALOG_JSON_BYTES, '目录响应超过 1 MiB 上限', 'response-too-large')
    } catch (error) {
      if (error instanceof AgentCatalogClientError) throw error
      throw new AgentCatalogClientError(AGENT_CATALOG_UNREACHABLE_ERROR, 'unreachable')
    }
    try {
      return { status: response.status, body: JSON.parse(body.toString('utf8')) as unknown }
    } catch {
      throw new AgentCatalogClientError('目录响应不是合法 JSON', 'invalid-response', response.status)
    }
  }

  async function getPackageMetadata(slug: string, version: string): Promise<AgentPackageMetadata> {
    const { rootUrl, settings } = await catalogRoot()
    const { body } = await requestJson(
      `${rootUrl}/v1/agent-packages/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`,
      optionalToken(settings.agents_catalog_token),
      { method: 'GET' },
    )
    return normalizeMetadata(body, slug, version)
  }

  return {
    async listPackages() {
      const { rootUrl, settings } = await catalogRoot()
      const { body } = await requestJson(`${rootUrl}/v1/agent-packages`, optionalToken(settings.agents_catalog_token), {
        method: 'GET',
      })
      return normalizeSummaryList(body)
    },

    getPackage: getPackageMetadata,

    async downloadBundleToFile(slug, version, destination) {
      const metadata = await getPackageMetadata(slug, version)
      if (metadata.status !== 'published') {
        throw new AgentCatalogClientError(
          metadata.status === 'delisted' ? '版本已下架' : '版本已撤销',
          'not-downloadable',
        )
      }
      if (metadata.bundleUrl === undefined) {
        throw new AgentCatalogClientError('目录未提供下载地址', 'invalid-response')
      }
      const { rootUrl, settings } = await catalogRoot()
      const bundleUrl = resolveBundleUrl(rootUrl, slug, version, metadata.bundleUrl)
      let response: Response
      try {
        response = await fetchFn(
          bundleUrl,
          buildInit({ method: 'GET' }, optionalToken(settings.agents_catalog_token), timeoutMs),
        )
      } catch {
        throw new AgentCatalogClientError(AGENT_CATALOG_UNREACHABLE_ERROR, 'unreachable')
      }
      if (isRedirect(response.status)) {
        throw new AgentCatalogClientError('目录下载地址发生重定向，已拒绝', 'redirect', response.status)
      }
      if (response.status === 401 || response.status === 403) {
        throw new AgentCatalogClientError(AGENT_CATALOG_AUTH_ERROR, 'auth', response.status)
      }
      if (!response.ok) {
        throw new AgentCatalogClientError(`目录请求失败（HTTP ${response.status}）`, 'http', response.status)
      }
      await writeCappedFile(response, destination)
    },

    async getRevocations() {
      const { rootUrl, settings } = await catalogRoot()
      const { body } = await requestJson(
        `${rootUrl}/v1/agent-packages/revocations`,
        optionalToken(settings.agents_catalog_token),
        { method: 'GET' },
      )
      return normalizeRevocations(body)
    },

    async submit(bundle) {
      const { rootUrl, settings } = await catalogRoot()
      const publishToken = optionalToken(settings.agents_catalog_publish_token)
      if (publishToken === undefined) throw new AgentCatalogClientError(AGENT_CATALOG_AUTH_ERROR, 'auth')
      if (bundle.byteLength > MAX_AGENT_PACKAGE_BUNDLE_BYTES) {
        throw new AgentCatalogClientError('智能体包超过 5 MiB 上限', 'bundle-too-large')
      }
      const { body } = await requestJson(`${rootUrl}/v1/agent-packages/submissions`, publishToken, {
        method: 'POST',
        headers: { 'content-type': 'application/gzip' },
        body: new Uint8Array(bundle),
      })
      return normalizeSubmission(body)
    },

    async getSubmission(submissionId) {
      const { rootUrl, settings } = await catalogRoot()
      const publishToken = optionalToken(settings.agents_catalog_publish_token)
      if (publishToken === undefined) throw new AgentCatalogClientError(AGENT_CATALOG_AUTH_ERROR, 'auth')
      const { body } = await requestJson(
        `${rootUrl}/v1/agent-packages/submissions/${encodeURIComponent(submissionId)}`,
        publishToken,
        { method: 'GET' },
      )
      return normalizeSubmission(body)
    },

    async requestDelist(slug, version, reason) {
      const { rootUrl, settings } = await catalogRoot()
      const publishToken = optionalToken(settings.agents_catalog_publish_token)
      if (publishToken === undefined) throw new AgentCatalogClientError(AGENT_CATALOG_AUTH_ERROR, 'auth')
      const { body } = await requestJson(
        `${rootUrl}/v1/agent-packages/${encodeURIComponent(slug)}/${encodeURIComponent(version)}/delist-requests`,
        publishToken,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason }),
        },
      )
      return normalizeDelistRequest(body, slug, version)
    },
  }
}

/** 一次配置的所有依赖;Task 9/10 复用同一对象。 */
export type AgentCatalogBinding = {
  profileDir: string
  readSettings: () => AgentCatalogSettings
  client: AgentCatalogClient
  logger: (message: string) => void
  /** 状态变化后发 `agent/changed`;由 `index.ts` 接到事件 hub。 */
  emitChanged?: (slug?: string) => void
}

export type ConfigureAgentCatalogOptions = Omit<AgentCatalogBinding, 'client'> & {
  /** 测试可直接注入 fake client;省略时按 readSettings 构造真实 HTTP 客户端。 */
  client?: AgentCatalogClient
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

let activeBinding: AgentCatalogBinding | undefined

/**
 * 初始化桌面端目录绑定的唯一入口。
 *
 * @returns 实际使用的 client,供 `ctx.huaanworkAgentCatalogClient` holder 保存
 */
export function configureAgentCatalog(options: ConfigureAgentCatalogOptions): AgentCatalogClient {
  const client =
    options.client ??
    createAgentCatalogClient({
      readSettings: options.readSettings,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
  const binding: AgentCatalogBinding = {
    profileDir: options.profileDir,
    readSettings: options.readSettings,
    client,
    logger: options.logger,
    ...(options.emitChanged === undefined ? {} : { emitChanged: options.emitChanged }),
  }
  activeBinding = binding
  return client
}

export function getAgentCatalogBinding(): AgentCatalogBinding {
  if (activeBinding === undefined) {
    throw new Error('智能体目录客户端尚未初始化（configureAgentCatalog 未调用）')
  }
  return activeBinding
}

export function getAgentCatalogClient(): AgentCatalogClient {
  return getAgentCatalogBinding().client
}

/**
 * 当前设置是否配置了可用的目录根(`agents_host`/`agents_port` 经现有 LAN 校验)。
 *
 * M1-only 用户(从未配置公用机目录)没有目录根:目录请求只会抛出
 * `目录不可达…`,不应每轮刷新都产生一条撤销告警。调用方据此跳过刷新。
 */
export function isAgentCatalogConfigured(): boolean {
  return catalogRootUrlOrUndefined(getAgentCatalogBinding().readSettings()) !== undefined
}

/** 测试隔离用;生产代码只在 `index.ts` 启动时配置一次。 */
export function resetAgentCatalogForTests(): void {
  activeBinding = undefined
}

/** `{profileDir}/agent-catalog-packages-cache.json`。 */
export function agentCatalogPackagesCachePath(profileDir: string): string {
  return join(profileDir, 'agent-catalog-packages-cache.json')
}

export type CatalogPackageCacheRefresh = {
  items: AgentPackageSummary[]
  warning?: string
}

/**
 * 拉取签名广场列表并替换缓存(tmp+rename)。失败保留旧缓存并返回 warning;
 * 目录未配置时既不请求也不告警,只返回已有缓存。
 */
export async function refreshCatalogPackageCache(): Promise<CatalogPackageCacheRefresh> {
  const binding = getAgentCatalogBinding()
  const cached = readCatalogPackageCache(binding.profileDir)
  const settings = binding.readSettings()
  if (catalogRootUrlOrUndefined(settings) === undefined) return { items: cached }
  try {
    const items = await binding.client.listPackages()
    writeCatalogPackageCache(binding.profileDir, items)
    return { items }
  } catch (error) {
    return { items: cached, warning: errorMessage(error) }
  }
}

/**
 * 最近一次成功缓存的签名广场 slug。缺失/损坏的缓存按空表处理;用于
 * `takenSlugs` 拒绝已知广场 slug,离线时无法声称完成全局唯一性验证。
 */
export function readCachedCatalogPackageSlugs(): string[] {
  const binding = getAgentCatalogBinding()
  return [...new Set(readCatalogPackageCache(binding.profileDir).map((item) => item.slug))]
}

/**
 * 最近一次成功缓存的签名广场摘要。`agent.packageList` 用它填
 * `catalogPackages`;离线/目录未配置时返回上次成功的快照,缺失/损坏按空表处理。
 *
 * 与 {@link readCachedCatalogPackageSlugs} 共用同一个磁盘读取与归一化,
 * 缓存写入方(`writeCatalogPackageCache`)是唯一事实源。
 */
export function readCachedCatalogPackages(): AgentPackageSummary[] {
  const binding = getAgentCatalogBinding()
  return readCatalogPackageCache(binding.profileDir)
}

function readCatalogPackageCache(profileDir: string): AgentPackageSummary[] {
  let text: string
  try {
    text = readFileSync(agentCatalogPackagesCachePath(profileDir), 'utf8')
  } catch {
    return []
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.items)) return []
  const items: AgentPackageSummary[] = []
  for (const item of raw.items) {
    const summary = normalizeSummary(item)
    if (summary !== undefined) items.push(summary)
  }
  return items
}

function writeCatalogPackageCache(profileDir: string, items: AgentPackageSummary[]): void {
  const filePath = agentCatalogPackagesCachePath(profileDir)
  const tempPath = `${filePath}.tmp`
  try {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      tempPath,
      `${JSON.stringify({ schemaVersion: 1, fetchedAt: new Date().toISOString(), items }, null, 2)}\n`,
      'utf8',
    )
    renameSync(tempPath, filePath)
  } catch (error) {
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // 尽力而为:残留临时文件由下一次写入覆盖。
    }
    throw error
  }
}

function catalogRootUrlOrUndefined(settings: AgentCatalogSettings): string | undefined {
  const rootUrl = catalogRootUrl(settings.agents_host, settings.agents_port)
  return rootUrl !== null && isLanEndpoint(rootUrl) ? rootUrl : undefined
}

function buildInit(init: RequestInit, token: string | undefined, timeoutMs: number): RequestInit {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  return {
    ...init,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  }
}

function optionalToken(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

async function readCappedBuffer(
  response: Response,
  cap: number,
  tooLargeMessage: string,
  tooLargeCode: AgentCatalogErrorCode,
): Promise<Buffer> {
  const body = response.body
  if (body === null) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > cap) {
        await reader.cancel().catch(() => undefined)
        throw new AgentCatalogClientError(tooLargeMessage, tooLargeCode)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof AgentCatalogClientError) throw error
    throw new AgentCatalogClientError(AGENT_CATALOG_UNREACHABLE_ERROR, 'unreachable')
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  )
}

async function writeCappedFile(response: Response, destination: string): Promise<void> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_AGENT_PACKAGE_BUNDLE_BYTES) {
    // 不读取响应体;调用方指定的临时文件也不得留下任何旧内容。
    await removeFile(destination).catch(() => undefined)
    throw new AgentCatalogClientError('智能体包超过 5 MiB 上限', 'bundle-too-large')
  }
  const handle = await open(destination, 'w')
  let total = 0
  try {
    const body = response.body
    if (body !== null) {
      const reader = body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        total += value.byteLength
        if (total > MAX_AGENT_PACKAGE_BUNDLE_BYTES) {
          await reader.cancel().catch(() => undefined)
          throw new AgentCatalogClientError('智能体包超过 5 MiB 上限', 'bundle-too-large')
        }
        await handle.write(Buffer.from(value))
      }
    }
    await handle.close()
  } catch (error) {
    try {
      await handle.close()
    } catch {
      // 已关闭或关闭失败:统一走下面的删除。
    }
    try {
      await removeFile(destination)
    } catch {
      // 文件可能尚未创建;调用方只看得到原始错误。
    }
    if (error instanceof AgentCatalogClientError) throw error
    throw new AgentCatalogClientError(AGENT_CATALOG_UNREACHABLE_ERROR, 'unreachable')
  }
}

function resolveBundleUrl(rootUrl: string, slug: string, version: string, raw: string): URL {
  let url: URL
  try {
    url = new URL(raw, rootUrl)
  } catch {
    throw new AgentCatalogClientError('目录返回的下载地址无效，已拒绝', 'cross-origin')
  }
  const root = new URL(rootUrl)
  if (url.origin !== root.origin || url.username !== '' || url.password !== '') {
    throw new AgentCatalogClientError('目录返回的下载地址指向其他来源，已拒绝', 'cross-origin')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AgentCatalogClientError('目录返回的下载地址协议不被支持，已拒绝', 'cross-origin')
  }
  const expectedPath = `/v1/agent-packages/${encodeURIComponent(slug)}/${encodeURIComponent(version)}/bundle`
  if (url.pathname !== expectedPath || url.search !== '' || url.hash !== '') {
    throw new AgentCatalogClientError('目录返回的下载地址不是本目录的签名包路径，已拒绝', 'cross-origin')
  }
  return url
}

function normalizeSummaryList(body: unknown): AgentPackageSummary[] {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new AgentCatalogClientError('目录响应缺少 items 列表', 'invalid-response')
  }
  const items: AgentPackageSummary[] = []
  for (const raw of body.items) {
    const summary = normalizeSummary(raw)
    if (summary !== undefined) items.push(summary)
  }
  return items
}

function normalizeSummary(raw: unknown): AgentPackageSummary | undefined {
  if (!isRecord(raw)) return undefined
  const { slug, displayName, description, version, size, status, updatedAt, migrationFrom } = raw
  if (
    typeof slug !== 'string' ||
    slug.length === 0 ||
    typeof displayName !== 'string' ||
    typeof description !== 'string' ||
    typeof version !== 'string' ||
    version.length === 0 ||
    typeof size !== 'number' ||
    !Number.isFinite(size) ||
    status !== 'published' ||
    typeof updatedAt !== 'string' ||
    updatedAt.length === 0
  ) {
    return undefined
  }
  return {
    slug,
    displayName,
    description,
    version,
    size: Math.max(0, Math.floor(size)),
    status: 'published',
    updatedAt,
    ...(typeof migrationFrom === 'string' && migrationFrom.length > 0 ? { migrationFrom } : {}),
  }
}

function normalizeMetadata(raw: unknown, slug: string, version: string): AgentPackageMetadata {
  if (!isRecord(raw)) throw new AgentCatalogClientError('目录响应格式错误', 'invalid-response')
  const status = raw.status
  if (status !== 'published' && status !== 'delisted' && status !== 'revoked') {
    throw new AgentCatalogClientError('目录响应格式错误', 'invalid-response')
  }
  if (raw.slug !== slug || raw.version !== version) {
    throw new AgentCatalogClientError('目录返回的条目与请求不一致', 'invalid-response')
  }
  const displayName = raw.displayName
  const description = raw.description
  const size = raw.size
  const updatedAt = raw.updatedAt
  const bundleUrl = raw.bundleUrl
  if (
    typeof displayName !== 'string' ||
    typeof description !== 'string' ||
    typeof size !== 'number' ||
    !Number.isFinite(size) ||
    typeof updatedAt !== 'string' ||
    updatedAt.length === 0 ||
    (bundleUrl !== undefined && typeof bundleUrl !== 'string')
  ) {
    throw new AgentCatalogClientError('目录响应格式错误', 'invalid-response')
  }
  const migrationFrom = raw.migrationFrom
  return {
    slug,
    version,
    status,
    displayName,
    description,
    size: Math.max(0, Math.floor(size)),
    updatedAt,
    ...(typeof bundleUrl === 'string' && bundleUrl.length > 0 ? { bundleUrl } : {}),
    ...(typeof migrationFrom === 'string' && migrationFrom.length > 0 ? { migrationFrom } : {}),
    ...(raw.digest === undefined ? {} : { digest: raw.digest }),
    ...(raw.signature === undefined ? {} : { signature: raw.signature }),
  }
}

function normalizeSubmission(raw: unknown): AgentPackageSubmission {
  if (!isRecord(raw)) throw new AgentCatalogClientError('目录响应格式错误', 'invalid-response')
  const { submissionId, slug, version, status, submittedAt, updatedAt, reason } = raw
  if (
    typeof submissionId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(submissionId) ||
    typeof slug !== 'string' ||
    slug.length === 0 ||
    typeof version !== 'string' ||
    version.length === 0 ||
    (status !== 'pending-review' && status !== 'published' && status !== 'rejected') ||
    typeof submittedAt !== 'string' ||
    typeof updatedAt !== 'string' ||
    (reason !== undefined && typeof reason !== 'string')
  ) {
    throw new AgentCatalogClientError('目录响应格式错误', 'invalid-response')
  }
  return {
    submissionId,
    slug,
    version,
    status,
    submittedAt,
    updatedAt,
    ...(typeof reason === 'string' && reason.length > 0 ? { reason } : {}),
  }
}

function normalizeDelistRequest(raw: unknown, slug: string, version: string): AgentPackageDelistRequest {
  if (!isRecord(raw)) throw new AgentCatalogClientError('目录响应格式错误', 'invalid-response')
  const { id, status, reason, createdAt, resolvedAt } = raw
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    raw.slug !== slug ||
    raw.version !== version ||
    (status !== 'pending' && status !== 'approved' && status !== 'rejected') ||
    typeof reason !== 'string' ||
    typeof createdAt !== 'string' ||
    (resolvedAt !== undefined && typeof resolvedAt !== 'string')
  ) {
    throw new AgentCatalogClientError('目录响应格式错误', 'invalid-response')
  }
  return {
    id,
    slug,
    version,
    status,
    reason,
    createdAt,
    ...(typeof resolvedAt === 'string' && resolvedAt.length > 0 ? { resolvedAt } : {}),
  }
}

function normalizeRevocations(body: unknown): AgentPackageRevocation[] {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new AgentCatalogClientError('目录响应缺少 items 列表', 'invalid-response')
  }
  const items: AgentPackageRevocation[] = []
  for (const raw of body.items) {
    if (!isRecord(raw)) continue
    const { slug, version, reason, revokedAt } = raw
    if (
      typeof slug !== 'string' ||
      slug.length === 0 ||
      typeof version !== 'string' ||
      version.length === 0 ||
      typeof reason !== 'string' ||
      reason.length === 0 ||
      typeof revokedAt !== 'string' ||
      revokedAt.length === 0
    ) {
      continue
    }
    // 服务端 `actor` 只用于审计,不进入桌面状态。
    items.push({ slug, version, reason, revokedAt })
  }
  return items
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
