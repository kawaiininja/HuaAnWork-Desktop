/**
 * Intranet skill catalog client (Task 6).
 *
 * Plain read client for `/v1/skills`: no signature, no keyring, no install
 * semantics. Settings are re-read on EVERY request, so saving a new host/port/
 * token in the UI takes effect without restarting the Host. The upload token is
 * deliberately NOT used here — reads use the shared catalog token.
 */

import { MAX_SKILL_ARCHIVE_BYTES } from '@huaanwork/skill-format'
import { catalogRootUrl } from '@huaanwork/policy/agent-catalog'
import { isLanEndpoint } from '@huaanwork/policy/network'

import {
  createCatalogTransport,
  optionalCatalogToken,
  type CatalogErrorFactory,
  type CatalogTransportErrorCode,
} from './catalog-transport.ts'
import type { AppSettings } from './settings.ts'

export type SkillRevisionSummary = {
  name: string
  revision: number
  description: string
  whenToUse?: string
  publisher: string
  digest: string
  size: number
  updatedAt: string
}

export type SkillCatalogSettings = Pick<
  AppSettings,
  'agents_host' | 'agents_port' | 'agents_catalog_token' | 'agents_skill_upload_token'
>

export type SkillCatalogErrorCode =
  | CatalogTransportErrorCode
  | 'not-found'
  | 'page-limit'
  | 'skill-already-exists'
  | 'skill-name-conflict'
  | 'skill-revision-conflict'
  | 'invalid-skill'
  | 'skill-too-large'

export class SkillCatalogClientError extends Error {
  readonly code: SkillCatalogErrorCode
  readonly status: number | undefined

  constructor(message: string, code: SkillCatalogErrorCode, status?: number) {
    super(message)
    this.name = 'SkillCatalogClientError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export interface SkillCatalogClient {
  listSharedSkills(): Promise<SkillRevisionSummary[]>
  getSkillRevision(name: string, revision: number): Promise<SkillRevisionSummary>
  downloadSkillArchive(name: string, revision: number): Promise<Buffer>
  publishSkill(
    name: string,
    archive: Buffer,
    expectedRevision: number | undefined,
  ): Promise<{ skill: SkillRevisionSummary; created: boolean }>
}

export type CreateSkillCatalogClientOptions = {
  readSettings: () => SkillCatalogSettings
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export const SKILL_CATALOG_PAGE_LIMIT = 100
export const MAX_SKILL_CATALOG_PAGES = 1000
export const SKILL_CATALOG_ARCHIVE_TOO_LARGE = '技能归档超过 5 MiB 上限'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeSummary(raw: unknown): SkillRevisionSummary {
  if (!isRecord(raw)) throw new SkillCatalogClientError('技能目录响应格式错误', 'invalid-response')
  const { name, revision, description, publisher, digest, size, updatedAt, whenToUse } = raw
  if (
    typeof name !== 'string' || name === ''
    || typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1
    || typeof description !== 'string'
    || typeof publisher !== 'string' || publisher === ''
    || typeof digest !== 'string' || digest === ''
    || typeof size !== 'number' || !Number.isFinite(size) || size < 0
    || typeof updatedAt !== 'string' || updatedAt === ''
    || (whenToUse !== undefined && typeof whenToUse !== 'string')
  ) {
    throw new SkillCatalogClientError('技能目录响应格式错误', 'invalid-response')
  }
  return {
    name,
    revision,
    description,
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    publisher,
    digest,
    size,
    updatedAt,
  }
}

function normalizePage(raw: unknown): { items: SkillRevisionSummary[]; nextCursor?: string } {
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new SkillCatalogClientError('技能目录响应格式错误', 'invalid-response')
  }
  const items = raw.items.map(normalizeSummary)
  if (raw.nextCursor !== undefined && (typeof raw.nextCursor !== 'string' || raw.nextCursor === '')) {
    throw new SkillCatalogClientError('技能目录响应格式错误', 'invalid-response')
  }
  return { items, ...(raw.nextCursor !== undefined ? { nextCursor: raw.nextCursor as string } : {}) }
}

/**
 * Build one client. The root URL is re-derived (and LAN-checked) on every
 * call, mirroring the agent client: a settings change never needs a rebuild.
 */
export function createSkillCatalogClient(options: CreateSkillCatalogClientOptions): SkillCatalogClient {
  const makeError: CatalogErrorFactory = (message, code, status) =>
    new SkillCatalogClientError(message, code as SkillCatalogErrorCode, status)
  const transport = createCatalogTransport({
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    makeError,
  })

  function catalogRoot(): { rootUrl: string; token: string | undefined } {
    const settings = options.readSettings()
    const rootUrl = catalogRootUrl(settings.agents_host, settings.agents_port)
    if (rootUrl === null || !isLanEndpoint(rootUrl)) {
      throw new SkillCatalogClientError('共享技能库不可用，当前显示内置技能与已缓存内容', 'unreachable')
    }
    return { rootUrl, token: optionalCatalogToken(settings.agents_catalog_token) }
  }

  async function requestSummary(name: string, revision: number): Promise<SkillRevisionSummary> {
    const { rootUrl, token } = catalogRoot()
    try {
      const { body } = await transport.requestJson(
        `${rootUrl}/v1/skills/${encodeURIComponent(name)}/${String(revision)}`,
        token,
        { method: 'GET' },
      )
      const record = isRecord(body) ? body.skill : undefined
      return normalizeSummary(record)
    } catch (cause) {
      if (cause instanceof SkillCatalogClientError && cause.status === 404) {
        throw new SkillCatalogClientError('技能不存在', 'not-found', 404)
      }
      throw cause
    }
  }

  return {
    async listSharedSkills() {
      const { rootUrl, token } = catalogRoot()
      const all: SkillRevisionSummary[] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_SKILL_CATALOG_PAGES; page += 1) {
        const query = new URLSearchParams({ limit: String(SKILL_CATALOG_PAGE_LIMIT) })
        if (cursor !== undefined) query.set('cursor', cursor)
        const { body } = await transport.requestJson(
          `${rootUrl}/v1/skills?${query.toString()}`,
          token,
          { method: 'GET' },
        )
        const normalized = normalizePage(body)
        all.push(...normalized.items)
        cursor = normalized.nextCursor
        // Only a page WITHOUT nextCursor proves the listing is complete.
        if (cursor === undefined) return all
      }
      // A truncated listing must never be presented as the full catalog.
      throw new SkillCatalogClientError(
        '技能目录分页超过 1000 页上限',
        'page-limit',
      )
    },

    getSkillRevision: requestSummary,

    async downloadSkillArchive(name, revision) {
      const { rootUrl, token } = catalogRoot()
      try {
        return await transport.requestBuffer(
          `${rootUrl}/v1/skills/${encodeURIComponent(name)}/${String(revision)}/archive`,
          token,
          { method: 'GET' },
          MAX_SKILL_ARCHIVE_BYTES,
          SKILL_CATALOG_ARCHIVE_TOO_LARGE,
        )
      } catch (cause) {
        if (cause instanceof SkillCatalogClientError && cause.status === 404) {
          throw new SkillCatalogClientError('技能不存在', 'not-found', 404)
        }
        throw cause
      }
    },

    async publishSkill(name, archive, expectedRevision) {
      const { rootUrl } = catalogRoot()
      const settings = options.readSettings()
      const uploadToken = optionalCatalogToken(settings.agents_skill_upload_token)
      if (uploadToken === undefined) {
        throw new SkillCatalogClientError('技能上传口令未配置，无法上传', 'auth')
      }
      const headers: Record<string, string> = { 'content-type': 'application/gzip' }
      if (expectedRevision !== undefined) {
        headers['x-skill-expected-revision'] = String(expectedRevision)
      }
      const { status, body } = await transport.requestJsonResult(
        `${rootUrl}/v1/skills/${encodeURIComponent(name)}`,
        uploadToken,
        { method: 'POST', headers, body: new Uint8Array(archive) },
      )
      if (status === 401 || status === 403) {
        throw new SkillCatalogClientError('技能上传口令错误或权限不足', 'auth', status)
      }
      if (status === 409) {
        const code = isRecord(body) && typeof body.code === 'string' ? body.code : undefined
        const known = code === 'skill-already-exists'
          || code === 'skill-name-conflict'
          || code === 'skill-revision-conflict'
        throw new SkillCatalogClientError(
          isRecord(body) && typeof body.error === 'string' ? body.error : '技能发布冲突',
          known ? code : 'http',
          status,
        )
      }
      if (status === 400) {
        const code = isRecord(body) && (body.code === 'invalid-skill' || body.code === 'skill-too-large')
          ? body.code
          : 'invalid-skill'
        throw new SkillCatalogClientError(
          isRecord(body) && typeof body.error === 'string' ? body.error : '技能归档无效',
          code,
          status,
        )
      }
      if (status !== 200 && status !== 201) {
        throw new SkillCatalogClientError(`目录请求失败（HTTP ${status}）`, 'http', status)
      }
      const skillRaw = isRecord(body) ? body.skill : undefined
      const created = isRecord(body) && body.created === true
      return { skill: normalizeSummary(skillRaw), created }
    },
  }
}

// ---------------------------------------------------------------------------
// Host-wide binding (configured by index.ts at startup)
// ---------------------------------------------------------------------------

export type SkillCatalogBinding = {
  readSettings: () => SkillCatalogSettings
  client: SkillCatalogClient
}

export type ConfigureSkillCatalogOptions = {
  readSettings: () => SkillCatalogSettings
  /** Test seam; production derives the client from `readSettings`. */
  client?: SkillCatalogClient
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

let activeBinding: SkillCatalogBinding | undefined

export function configureSkillCatalog(options: ConfigureSkillCatalogOptions): SkillCatalogClient {
  const client = options.client ?? createSkillCatalogClient({
    readSettings: options.readSettings,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  activeBinding = { readSettings: options.readSettings, client }
  return client
}

export function getSkillCatalogBinding(): SkillCatalogBinding {
  if (activeBinding === undefined) {
    throw new Error('技能目录客户端尚未初始化（configureSkillCatalog 未调用）')
  }
  return activeBinding
}

export function getSkillCatalogClient(): SkillCatalogClient {
  return getSkillCatalogBinding().client
}

export function resetSkillCatalogForTests(): void {
  activeBinding = undefined
}
