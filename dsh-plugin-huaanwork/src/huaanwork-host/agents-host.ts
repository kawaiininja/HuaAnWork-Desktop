import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  AGENT_NAME_RE,
  catalogRootUrl,
  parseCatalogItem,
  type ParsedCatalogItem,
} from '@huaanwork/policy/agent-catalog'
import { CATALOG_BODY_LIMIT, readCappedText } from '@huaanwork/policy/http-cap'
import { isLanEndpoint } from '@huaanwork/policy/network'

import type { AppSettings } from './settings.ts'
import type {
  AgentDetail,
  AgentFieldError,
  AgentKind,
  AgentListItem,
  AgentListResult,
  AgentSource,
  AgentWriteResult,
  EntrypointKind,
} from '../client-huaanwork/rpc-types.ts'

/**
 * 智能体目录宿主(Task 10 全量移植):@agent 分发(agent-invoke.ts)与
 * agent.list/get/refresh 路由共用的真实目录实现(fetch 公用机目录 + 本地
 * endpoints + 快照同步),逐字移植自旧 sidecar agents-host.ts。
 *
 * 存储根:旧 sidecar 传 $DSH_HOME(agents-enabled.json / agents-endpoints.json
 * 落在 $DSH_HOME 下);Desktop 组合下存于 profileDir,调用方传 routeCtx.profileDir。
 * fetch 语义逐字:5s 超时 / 1 MiB 封顶 / TTL 60s / Bearer 头。
 */

export const CATALOG_CACHE_TTL_MS = 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 5000

export type AgentCatalogSnapshot = {
  items: Array<{
    name: string
    source: AgentSource
    kind: AgentKind
    entrypointKind?: EntrypointKind
    enabled: boolean
    description: string
    broken?: { reason: string }
    entrypoint?: { kind: EntrypointKind; url: string }
    timeoutMs?: number
    argumentsSchema?: unknown
  }>
}

export type AgentsHost = {
  list(): AgentListResult
  refresh(): Promise<AgentListResult>
  get(name: string, source?: AgentSource): Promise<AgentDetail | undefined>
  setEnabled(name: string, enabled: boolean, confirmPermissions: boolean): void
  addEndpoint(input: {
    name: string
    kind: AgentKind
    entrypoint: { kind: EntrypointKind; url: string }
    description?: string
    argumentsSchema?: unknown
  }): AgentWriteResult
  removeEndpoint(name: string): void
  snapshotForRuntime(): AgentCatalogSnapshot
}

type LocalEndpointEntry = {
  name: string
  kind: AgentKind
  entrypoint: { kind: EntrypointKind; url: string }
  /** 用户填写的用途说明;缺省时列表/快照回落「本地调试入口」 */
  description?: string
  /** 提示模型组装参数的 JSON Schema(仅注入 call_host_tool 描述,不做运行时校验) */
  argumentsSchema?: unknown
  broken?: { reason: string }
}

function readEnabledMap(filePath: string): Record<string, boolean> {
  try {
    if (!existsSync(filePath)) return {}
    const text = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>
    }
    return {}
  } catch {
    return {}
  }
}

function writeEnabledMap(filePath: string, map: Record<string, boolean>): void {
  const tmp = `${filePath}.tmp`
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, 'utf8')
  renameSync(tmp, filePath)
}

function readEndpoints(filePath: string): LocalEndpointEntry[] {
  try {
    if (!existsSync(filePath)) return []
    const text = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).entries)) {
      return []
    }
    const rawEntries = (parsed as { entries: unknown[] }).entries
    const result: LocalEndpointEntry[] = []
    for (const item of rawEntries) {
      if (!item || typeof item !== 'object') continue
      const obj = item as Record<string, unknown>
      if (typeof obj.name !== 'string' || !obj.name) continue
      const kind: AgentKind = obj.kind === 'agent' ? 'agent' : 'tool'
      const ep = obj.entrypoint as Record<string, unknown> | undefined
      if (!ep || typeof ep !== 'object') continue
      const epKind: EntrypointKind = ep.kind === 'mcp' ? 'mcp' : 'http'
      const epUrl = typeof ep.url === 'string' ? ep.url : ''
      if (!epUrl) continue
      // 读路径同样复检 LAN:手改 agents-endpoints.json 不得绕过写路径的校验
      let broken: { reason: string } | undefined
      try {
        const u = new URL(epUrl)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          broken = { reason: '入口地址协议必须是 http 或 https' }
        } else if (!isLanEndpoint(epUrl)) {
          broken = { reason: '入口地址必须是局域网 URL' }
        }
      } catch {
        broken = { reason: '入口地址必须是合法 URL' }
      }
      result.push({
        name: obj.name,
        kind,
        entrypoint: { kind: epKind, url: epUrl },
        ...(typeof obj.description === 'string' && obj.description.trim()
          ? { description: obj.description }
          : {}),
        ...(obj.argumentsSchema && typeof obj.argumentsSchema === 'object' && !Array.isArray(obj.argumentsSchema)
          ? { argumentsSchema: obj.argumentsSchema }
          : {}),
        ...(broken ? { broken } : {}),
      })
    }
    return result
  } catch {
    return []
  }
}

function writeEndpoints(filePath: string, entries: LocalEndpointEntry[]): void {
  const tmp = `${filePath}.tmp`
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(tmp, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8')
  renameSync(tmp, filePath)
}

export function createAgentsHost(opts: {
  storageRoot: string
  readSettings: () => Pick<AppSettings, 'agents_host' | 'agents_port' | 'agents_catalog_token'>
  fetchImpl?: typeof fetch
  now?: () => number
  requestTimeoutMs?: number
  onCatalogChange?: () => void
}): AgentsHost {
  const enabledPath = join(opts.storageRoot, 'agents-enabled.json')
  const endpointsPath = join(opts.storageRoot, 'agents-endpoints.json')
  const now = opts.now ?? Date.now

  let cachedCatalogItems: ParsedCatalogItem[] = []
  // 缓存归属的目录根 URL;与当前配置不匹配即视为失效(换机/清空后不得再服务旧目录)
  let cachedRootUrl: string | null = null
  let catalogError: string | undefined = undefined
  // 最近一次拉取尝试(含失败)的时间与目标:失败也记录,保证失败后按 TTL 退避而不是每次 list() 重试
  let lastAttemptAt: number | undefined = undefined
  let lastAttemptRootUrl: string | null = null
  let inFlightRefresh: Promise<AgentListResult> | null = null
  const detailCache = new Map<string, AgentDetail>()

  function currentRootUrl(): string | null {
    const settings = opts.readSettings()
    return catalogRootUrl(settings.agents_host, settings.agents_port)
  }

  function catalogCacheMatches(): boolean {
    const rootUrl = currentRootUrl()
    return cachedRootUrl !== null && rootUrl !== null && cachedRootUrl === rootUrl
  }

  function clearCatalogCache(): void {
    cachedCatalogItems = []
    cachedRootUrl = null
    catalogError = undefined
    detailCache.clear()
  }

  function isCatalogEnabled(name: string): boolean {
    const map = readEnabledMap(enabledPath)
    return map[`catalog:${name}`] === true
  }

  function getMergedItems(): AgentListItem[] {
    const enabledMap = readEnabledMap(enabledPath)
    const catalogNames = new Set<string>()
    const items: AgentListItem[] = []

    for (const item of catalogCacheMatches() ? cachedCatalogItems : []) {
      catalogNames.add(item.name)
      items.push({
        name: item.name,
        source: 'catalog',
        kind: item.kind,
        ...(item.entrypoint?.kind ? { entrypointKind: item.entrypoint.kind } : {}),
        description: item.description,
        ...(item.whenToUse ? { whenToUse: item.whenToUse } : {}),
        version: item.version,
        permissions: item.permissions,
        enabled: enabledMap[`catalog:${item.name}`] === true,
        ...(item.broken ? { broken: item.broken } : {}),
      })
    }

    const endpoints = readEndpoints(endpointsPath)
    const seenLocalNames = new Set<string>()
    for (const ep of endpoints) {
      const isDup = catalogNames.has(ep.name) || seenLocalNames.has(ep.name)
      seenLocalNames.add(ep.name)
      items.push({
        name: ep.name,
        source: 'local',
        kind: ep.kind,
        entrypointKind: ep.entrypoint.kind,
        description: ep.description?.trim() || '本地调试入口',
        version: 'local',
        permissions: [],
        enabled: true,
        ...(isDup ? { broken: { reason: `重名条目：${ep.name}` } } : ep.broken ? { broken: ep.broken } : {}),
      })
    }

    return items
  }

  async function doRefresh(): Promise<AgentListResult> {
    const settings = opts.readSettings()
    const rootUrl = catalogRootUrl(settings.agents_host, settings.agents_port)
    if (!rootUrl) {
      clearCatalogCache()
      opts.onCatalogChange?.()
      return { items: getMergedItems() }
    }

    // 失败也计入尝试时间与目标:失败后退避一个 TTL,而不是每次 list() 都重新打 5s 请求
    lastAttemptAt = now()
    lastAttemptRootUrl = rootUrl

    const fetchFn = opts.fetchImpl ?? fetch
    const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const headers: Record<string, string> = {
      Accept: 'application/json',
    }
    if (settings.agents_catalog_token) {
      headers['Authorization'] = `Bearer ${settings.agents_catalog_token}`
    }

    try {
      const res = await fetchFn(`${rootUrl}/v1/catalog`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!res.ok) {
        catalogError = `公用机响应状态错误: ${res.status}`
        return { items: getMergedItems(), catalogError }
      }

      const { text, truncated } = await readCappedText(res.body, CATALOG_BODY_LIMIT)
      if (truncated) {
        catalogError = '公用机目录响应超过 1 MiB 上限'
        return { items: getMergedItems(), catalogError }
      }

      let data: unknown
      try {
        data = JSON.parse(text)
      } catch {
        catalogError = '公用机目录响应不是合法 JSON'
        return { items: getMergedItems(), catalogError }
      }

      if (!data || typeof data !== 'object' || !Array.isArray((data as Record<string, unknown>).items)) {
        catalogError = '公用机目录数据格式错误（缺少 items 数组）'
        return { items: getMergedItems(), catalogError }
      }

      const rawItems = (data as { items: unknown[] }).items
      const seenNames = new Set<string>()
      const parsedList: ParsedCatalogItem[] = []
      for (const raw of rawItems) {
        const parsed = parseCatalogItem(raw, seenNames)
        if (parsed) {
          parsedList.push(parsed)
        }
      }

      cachedCatalogItems = parsedList
      cachedRootUrl = rootUrl
      catalogError = undefined
      detailCache.clear()
      opts.onCatalogChange?.()

      return { items: getMergedItems() }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      catalogError = `公用机目录请求失败: ${msg}`
      return { items: getMergedItems(), catalogError }
    } finally {
      inFlightRefresh = null
    }
  }

  return {
    list(): AgentListResult {
      const rootUrl = currentRootUrl()
      if (!rootUrl) {
        // 未配置公用机:清掉可能残留的旧目录缓存,只保留本地入口
        if (cachedRootUrl !== null) clearCatalogCache()
        return { items: getMergedItems() }
      }

      const currentTime = now()
      // 换机(上次尝试的目标与当前配置不符)立即视为过期;失败退避由 lastAttemptAt 保证
      const isExpiredOrEmpty =
        lastAttemptRootUrl !== rootUrl || lastAttemptAt === undefined || currentTime - lastAttemptAt >= CATALOG_CACHE_TTL_MS
      if (isExpiredOrEmpty && !inFlightRefresh) {
        inFlightRefresh = doRefresh()
      }

      return {
        items: getMergedItems(),
        ...(catalogError ? { catalogError } : {}),
      }
    },

    refresh(): Promise<AgentListResult> {
      if (inFlightRefresh) return inFlightRefresh
      inFlightRefresh = doRefresh()
      return inFlightRefresh
    },

    async get(name: string, source?: AgentSource): Promise<AgentDetail | undefined> {
      const merged = getMergedItems()
      const target = merged.find((i) => {
        if (source && i.source !== source) return false
        return i.name === name
      })

      if (!target) return undefined

      if (target.source === 'local') {
        const endpoints = readEndpoints(endpointsPath)
        const ep = endpoints.find((e) => e.name === name)
        if (!ep) return undefined
        return {
          name: ep.name,
          source: 'local',
          kind: ep.kind,
          entrypointKind: ep.entrypoint.kind,
          description: target.description,
          version: target.version,
          permissions: target.permissions,
          enabled: true,
          ...(target.broken ? { broken: target.broken } : {}),
          entrypoint: ep.entrypoint,
          timeoutMs: 60_000,
          ...(ep.argumentsSchema ? { argumentsSchema: ep.argumentsSchema } : {}),
        }
      }

      // Catalog item
      const cached = detailCache.get(name)
      if (cached) {
        return {
          ...cached,
          enabled: isCatalogEnabled(name),
        }
      }

      const settings = opts.readSettings()
      const rootUrl = catalogRootUrl(settings.agents_host, settings.agents_port)
      if (!rootUrl) {
        throw new Error('公用机未配置')
      }

      const fetchFn = opts.fetchImpl ?? fetch
      const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
      const headers: Record<string, string> = {
        Accept: 'application/json',
      }
      if (settings.agents_catalog_token) {
        headers['Authorization'] = `Bearer ${settings.agents_catalog_token}`
      }

      let res: Response
      try {
        res = await fetchFn(`${rootUrl}/v1/catalog/${encodeURIComponent(name)}`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err: unknown) {
        throw new Error(`公用机详情请求失败: ${err instanceof Error ? err.message : String(err)}`)
      }

      if (!res.ok) {
        throw new Error(`公用机返回错误: ${res.status}`)
      }

      const { text, truncated } = await readCappedText(res.body, CATALOG_BODY_LIMIT)
      if (truncated) {
        throw new Error('公用机条目详情响应超过 1 MiB 上限')
      }

      let data: unknown
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error('公用机条目详情响应不是合法 JSON')
      }

      const parsed = parseCatalogItem(data)
      if (!parsed) {
        throw new Error('公用机条目详情数据格式错误')
      }

      let persona = parsed.persona
      let broken = parsed.broken

      if (parsed.personaUrl && !persona) {
        if (!isLanEndpoint(parsed.personaUrl)) {
          broken = { reason: '人设地址不是局域网地址' }
        } else {
          let personaRes: Response
          try {
            personaRes = await fetchFn(parsed.personaUrl, {
              method: 'GET',
              headers,
              signal: AbortSignal.timeout(timeoutMs),
            })
          } catch (err: unknown) {
            throw new Error(`公用机人设请求失败: ${err instanceof Error ? err.message : String(err)}`)
          }

          if (!personaRes.ok) {
            throw new Error(`公用机人设返回错误: ${personaRes.status}`)
          }

          const pCap = await readCappedText(personaRes.body, CATALOG_BODY_LIMIT)
          if (pCap.truncated) {
            throw new Error('公用机人设响应超过 1 MiB 上限')
          }

          const pText = pCap.text
          try {
            const pj = JSON.parse(pText)
            if (pj && typeof pj === 'object' && typeof (pj as Record<string, unknown>).persona === 'string') {
              persona = (pj as { persona: string }).persona
            } else {
              persona = pText
            }
          } catch {
            persona = pText
          }
        }
      }

      if (parsed.kind === 'agent') {
        if (!persona || !persona.trim()) {
          broken = { reason: '人设缺失' }
        }
      }

      const detail: AgentDetail = {
        name: parsed.name,
        source: 'catalog',
        kind: parsed.kind,
        ...(parsed.entrypoint?.kind ? { entrypointKind: parsed.entrypoint.kind } : {}),
        description: parsed.description,
        ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
        version: parsed.version,
        permissions: parsed.permissions,
        enabled: isCatalogEnabled(parsed.name),
        ...(broken ? { broken } : {}),
        ...(parsed.entrypoint ? { entrypoint: parsed.entrypoint } : {}),
        timeoutMs: parsed.timeoutMs,
        ...(parsed.argumentsSchema ? { argumentsSchema: parsed.argumentsSchema } : {}),
        ...(parsed.allow && parsed.allow.length > 0 ? { allow: parsed.allow } : {}),
        ...(persona ? { persona } : {}),
      }

      detailCache.set(name, detail)
      return detail
    },

    setEnabled(name: string, enabled: boolean, confirmPermissions: boolean): void {
      const endpoints = readEndpoints(endpointsPath)
      const isLocal = endpoints.some((e) => e.name === name)
      const isCatalog = catalogCacheMatches() && cachedCatalogItems.some((i) => i.name === name)

      if (isCatalog) {
        if (enabled && !confirmPermissions) {
          throw new Error('启用智能体必须确认权限')
        }
        const map = readEnabledMap(enabledPath)
        const key = `catalog:${name}`
        if (enabled) {
          map[key] = true
        } else {
          delete map[key]
        }
        writeEnabledMap(enabledPath, map)
        opts.onCatalogChange?.()
        return
      }

      if (isLocal) {
        throw new Error('不能手动更改本地调试入口的启用状态')
      }

      throw new Error(`条目不存在: ${name}`)
    },

    addEndpoint(input: {
      name: string
      kind: AgentKind
      entrypoint: { kind: EntrypointKind; url: string }
      description?: string
      argumentsSchema?: unknown
    }): AgentWriteResult {
      const fieldErrors: AgentFieldError[] = []
      const { name, kind, entrypoint, description, argumentsSchema } = input

      if (!name || typeof name !== 'string' || !AGENT_NAME_RE.test(name) || name.length > 64) {
        fieldErrors.push({
          field: 'name',
          message: '名称必须匹配 /^[a-z0-9]+(?:-[a-z0-9]+)*$/ 且不超过 64 字符',
        })
      } else if (entrypoint?.kind === 'mcp' && name.length > 32) {
        fieldErrors.push({
          field: 'name',
          message: 'MCP 工具名称不能超过 32 字符',
        })
      }

      // 本地入口没有 persona 来源,kind=agent 永远无法 @:写路径直接拒绝
      if (kind === 'agent') {
        fieldErrors.push({
          field: 'kind',
          message: '本地入口仅支持小工具；智能体的人设由公用机目录下发',
        })
      }

      if (description !== undefined) {
        if (typeof description !== 'string') {
          fieldErrors.push({ field: 'description', message: '描述必须是字符串' })
        } else if (description.trim().length > 200) {
          fieldErrors.push({ field: 'description', message: '描述不超过 200 字符' })
        }
      }

      if (
        argumentsSchema !== undefined &&
        (!argumentsSchema || typeof argumentsSchema !== 'object' || Array.isArray(argumentsSchema))
      ) {
        fieldErrors.push({ field: 'argumentsSchema', message: '参数 schema 必须是 JSON 对象' })
      }

      if (!entrypoint || typeof entrypoint.url !== 'string') {
        fieldErrors.push({ field: 'url', message: '入口地址必填' })
      } else {
        try {
          const u = new URL(entrypoint.url)
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            fieldErrors.push({ field: 'url', message: '入口地址协议必须是 http 或 https' })
          } else if (!isLanEndpoint(entrypoint.url)) {
            fieldErrors.push({ field: 'url', message: '入口地址必须是局域网 URL' })
          }
        } catch {
          fieldErrors.push({ field: 'url', message: '入口地址必须是合法 URL' })
        }
      }

      if (fieldErrors.length > 0) {
        return { ok: false, fieldErrors }
      }

      const entries = readEndpoints(endpointsPath)
      if (entries.some((e) => e.name === name)) {
        return {
          ok: false,
          fieldErrors: [{ field: 'name', message: '同名本地入口已存在' }],
        }
      }

      entries.push({
        name,
        kind,
        entrypoint: {
          kind: entrypoint.kind,
          url: entrypoint.url,
        },
        ...(typeof description === 'string' && description.trim()
          ? { description: description.trim() }
          : {}),
        ...(argumentsSchema !== undefined ? { argumentsSchema } : {}),
      })

      writeEndpoints(endpointsPath, entries)
      opts.onCatalogChange?.()
      return { ok: true }
    },

    removeEndpoint(name: string): void {
      const entries = readEndpoints(endpointsPath)
      const nextEntries = entries.filter((e) => e.name !== name)
      writeEndpoints(endpointsPath, nextEntries)
      opts.onCatalogChange?.()
    },

    snapshotForRuntime(): AgentCatalogSnapshot {
      const enabledMap = readEnabledMap(enabledPath)
      const catalogNames = new Set<string>()
      const snapshotItems: AgentCatalogSnapshot['items'] = []

      for (const item of catalogCacheMatches() ? cachedCatalogItems : []) {
        catalogNames.add(item.name)
        snapshotItems.push({
          name: item.name,
          source: 'catalog',
          kind: item.kind,
          ...(item.entrypoint?.kind ? { entrypointKind: item.entrypoint.kind } : {}),
          enabled: enabledMap[`catalog:${item.name}`] === true,
          description: item.description,
          ...(item.broken ? { broken: { reason: item.broken.reason } } : {}),
          ...(item.entrypoint ? { entrypoint: { kind: item.entrypoint.kind, url: item.entrypoint.url } } : {}),
          timeoutMs: item.timeoutMs,
          ...(item.argumentsSchema ? { argumentsSchema: item.argumentsSchema } : {}),
        })
      }

      const endpoints = readEndpoints(endpointsPath)
      const seenLocalNames = new Set<string>()
      for (const ep of endpoints) {
        const isDup = catalogNames.has(ep.name) || seenLocalNames.has(ep.name)
        seenLocalNames.add(ep.name)
        snapshotItems.push({
          name: ep.name,
          source: 'local',
          kind: ep.kind,
          entrypointKind: ep.entrypoint.kind,
          enabled: true,
          description: ep.description?.trim() || '本地调试入口',
          ...(isDup ? { broken: { reason: `重名条目：${ep.name}` } } : ep.broken ? { broken: ep.broken } : {}),
          entrypoint: { kind: ep.entrypoint.kind, url: ep.entrypoint.url },
          timeoutMs: 60_000,
          ...(ep.argumentsSchema ? { argumentsSchema: ep.argumentsSchema } : {}),
        })
      }

      return { items: snapshotItems }
    },
  }
}
