import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { GuardMode } from '@huaanwork/policy'
import { catalogRootUrl } from '@huaanwork/policy/agent-catalog'
import { isLanEndpoint } from '@huaanwork/policy/network'

export type ThemePref = 'light' | 'dark' | 'system'

export type ModelEntry = {
  id: string
  name: string
  base_url: string
  model: string
  api_key: string
}

export type AppSettings = {
  base_url: string
  model: string
  api_key: string
  theme: ThemePref
  models: ModelEntry[]
  active_model_id: string
  /** 公网开关（管理员）：缺省 false，仅本机+局域网；true 后放行公网端点。所有会话统一。 */
  allow_network: boolean
  /** 护栏策略档位：ask 修改前询问（缺省）/ smart 高危才询问 / full 完全访问；非法值回落 ask。 */
  guard_mode: GuardMode
  /** 单次自动化任务的执行超时（毫秒）；缺省 10 分钟。 */
  automation_timeout_ms: number
  /** 存在启用中的非手动任务时阻止系统睡眠：缺省 true（功能默认开，用户可关）。 */
  keep_awake: boolean
  /** 局域网智能体公用机主机名/IP：缺省 ""。 */
  agents_host: string
  /** 局域网智能体公用机端口：缺省 ""。 */
  agents_port: number | ''
  /** 局域网智能体目录 Bearer 鉴权 token：缺省 ""。 */
  agents_catalog_token: string
}

export const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1'
export const DEFAULT_AUTOMATION_TIMEOUT_MS = 10 * 60_000

const DEFAULT_ENTRY: ModelEntry = {
  id: 'default',
  name: '默认',
  base_url: DEFAULT_BASE_URL,
  model: '',
  api_key: '',
}

export const defaultSettings: AppSettings = {
  base_url: DEFAULT_BASE_URL,
  model: '',
  api_key: '',
  theme: 'system',
  models: [{ ...DEFAULT_ENTRY }],
  active_model_id: 'default',
  allow_network: false,
  guard_mode: 'ask',
  automation_timeout_ms: DEFAULT_AUTOMATION_TIMEOUT_MS,
  keep_awake: true,
  agents_host: '',
  agents_port: '',
  agents_catalog_token: '',
}

export function emptySettings(): AppSettings {
  return {
    ...defaultSettings,
    models: defaultSettings.models.map((entry) => ({ ...entry })),
  }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function parseTheme(value: unknown): ThemePref {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

/** 护栏档位白名单解析；缺失/非法一律回落 "ask"（安全方向）。 */
function parseGuardMode(value: unknown): GuardMode {
  return value === 'smart' || value === 'full' ? value : 'ask'
}

/** 正整数毫秒解析；非法值回落缺省（自动化超时）。 */
function parsePositiveMs(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** 智能体公用机端口解析：合法端口 1-65535（数字或纯数字字符串），""/null/undefined 返回 ""，其余非法值返回 fallback。 */
function parseAgentsPort(value: unknown, fallback: number | '' = ''): number | '' {
  if (value === '' || value === null) return ''
  if (value === undefined) return fallback
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 1 && value <= 65535) return value
    return fallback
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return ''
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed)
      if (n >= 1 && n <= 65535) return n
    }
    return fallback
  }
  return fallback
}

function parseEntry(raw: unknown, fallback: { base_url: string }): ModelEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  const id = asString(rec.id).trim()
  if (!id) return null
  const model = asString(rec.model)
  return {
    id,
    name: asString(rec.name).trim() || model || '未命名',
    base_url: asString(rec.base_url) || fallback.base_url,
    model,
    api_key: asString(rec.api_key),
  }
}

function synthesizeFromFlat(
  flat: { base_url: string; model: string; api_key: string },
  preferredId?: string,
): ModelEntry {
  return {
    id: preferredId && preferredId.length > 0 ? preferredId : 'default',
    name: flat.model || '默认',
    base_url: flat.base_url,
    model: flat.model,
    api_key: flat.api_key,
  }
}

function mirrorActive(
  models: ModelEntry[],
  activeId: string,
): Pick<AppSettings, 'base_url' | 'model' | 'api_key' | 'active_model_id'> {
  const active = models.find((entry) => entry.id === activeId) ?? models[0]
  if (!active) {
    return { base_url: DEFAULT_BASE_URL, model: '', api_key: '', active_model_id: '' }
  }
  return {
    base_url: active.base_url || DEFAULT_BASE_URL,
    model: active.model,
    api_key: active.api_key,
    active_model_id: active.id,
  }
}

export function parseSettings(raw: unknown): AppSettings {
  const rec = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const flat = {
    base_url: asString(rec.base_url) || DEFAULT_BASE_URL,
    model: asString(rec.model),
    api_key: asString(rec.api_key),
  }
  const rawModels = Array.isArray(rec.models) ? rec.models : null
  const parsedList = rawModels
    ? rawModels
        .map((item: unknown) => parseEntry(item, flat))
        .filter((item): item is ModelEntry => item !== null)
    : []
  const models = rawModels ? parsedList : [synthesizeFromFlat(flat, asString(rec.active_model_id) || 'default')]
  // 兼容旧 key：allow_network 缺失时读 work_allow_network（一次性兼容，不写回）。
  const allowNetwork =
    typeof rec.allow_network === 'boolean' ? rec.allow_network : rec.work_allow_network === true
  return {
    theme: parseTheme(rec.theme),
    models,
    allow_network: allowNetwork,
    guard_mode: parseGuardMode(rec.guard_mode),
    automation_timeout_ms: parsePositiveMs(rec.automation_timeout_ms, DEFAULT_AUTOMATION_TIMEOUT_MS),
    keep_awake: rec.keep_awake !== false,
    agents_host: typeof rec.agents_host === 'string' ? rec.agents_host.trim() : '',
    agents_port: parseAgentsPort(rec.agents_port),
    agents_catalog_token: typeof rec.agents_catalog_token === 'string' ? rec.agents_catalog_token.trim() : '',
    ...mirrorActive(models, asString(rec.active_model_id)),
  }
}

export function mergeSettings(current: AppSettings, params: unknown): AppSettings {
  const rec = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {}
  let models = current.models.map((entry) => ({ ...entry }))
  let activeId = current.active_model_id
  const theme = rec.theme !== undefined ? parseTheme(rec.theme) : current.theme
  const allowNetwork =
    typeof rec.allow_network === 'boolean' ? rec.allow_network : current.allow_network
  const keepAwake = typeof rec.keep_awake === 'boolean' ? rec.keep_awake : current.keep_awake
  const guardMode: GuardMode =
    rec.guard_mode === 'ask' || rec.guard_mode === 'smart' || rec.guard_mode === 'full'
      ? rec.guard_mode
      : current.guard_mode
  const automationTimeoutMs =
    typeof rec.automation_timeout_ms === 'number' &&
    Number.isFinite(rec.automation_timeout_ms) &&
    rec.automation_timeout_ms > 0
      ? Math.floor(rec.automation_timeout_ms)
      : current.automation_timeout_ms
  const agentsHost = typeof rec.agents_host === 'string' ? rec.agents_host.trim() : current.agents_host
  const agentsPort =
    rec.agents_port !== undefined ? parseAgentsPort(rec.agents_port, current.agents_port) : current.agents_port
  const agentsCatalogToken =
    typeof rec.agents_catalog_token === 'string' ? rec.agents_catalog_token.trim() : current.agents_catalog_token

  if (Array.isArray(rec.models)) {
    models = []
    for (const item of rec.models) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const row = item as Record<string, unknown>
      const parsed = parseEntry({ ...row, id: asString(row.id).trim() || randomUUID() }, current)
      if (parsed) models.push(parsed)
    }
  }

  if (typeof rec.active_model_id === 'string' && models.some((entry) => entry.id === rec.active_model_id)) {
    activeId = rec.active_model_id
  }

  const hasFieldUpdate =
    typeof rec.base_url === 'string' || typeof rec.model === 'string' || typeof rec.api_key === 'string'
  if (hasFieldUpdate) {
    if (models.length === 0) {
      const entry = synthesizeFromFlat({
        base_url: typeof rec.base_url === 'string' ? rec.base_url : current.base_url,
        model: typeof rec.model === 'string' ? rec.model : current.model,
        api_key: typeof rec.api_key === 'string' ? rec.api_key : current.api_key,
      })
      models = [entry]
      activeId = entry.id
    } else {
      const target = models.find((entry) => entry.id === activeId) ?? models[0]
      if (target) {
        if (typeof rec.base_url === 'string') target.base_url = rec.base_url
        if (typeof rec.model === 'string') {
          if (target.name === target.model || target.name === '默认' || target.name === '未命名') {
            target.name = rec.model || '默认'
          }
          target.model = rec.model
        }
        if (typeof rec.api_key === 'string') target.api_key = rec.api_key
      }
    }
  }

  return {
    theme,
    models,
    allow_network: allowNetwork,
    guard_mode: guardMode,
    automation_timeout_ms: automationTimeoutMs,
    keep_awake: keepAwake,
    agents_host: agentsHost,
    agents_port: agentsPort,
    agents_catalog_token: agentsCatalogToken,
    ...mirrorActive(models, activeId),
  }
}

/**
 * 校验公用机目录网络设置。
 * host 与 port 都非空时，才拼 URL 校验；如果 URL 为 null 或不是局域网地址，返回错误提示。
 * 只填一个字段（未配置全）或者全空时，返回空数组，不报错。
 */
export function agentsDirectoryErrors(settings: AppSettings): { field: string; message: string }[] {
  if (!settings.agents_host.trim() || settings.agents_port === '') {
    return []
  }
  const url = catalogRootUrl(settings.agents_host, settings.agents_port)
  if (!url || !isLanEndpoint(url)) {
    return [{ field: 'agents_host', message: '公用机地址必须是本机或局域网（含 .local），禁止公网主机名' }]
  }
  return []
}

export async function readHuaanworkSettings(profileDir: string): Promise<AppSettings> {
  const filePath = join(profileDir, 'huaanwork-settings.json')
  try {
    const content = await readFile(filePath, 'utf8')
    return parseSettings(JSON.parse(content))
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT' || error instanceof SyntaxError) {
      return emptySettings()
    }
    throw error
  }
}

export function readHuaanworkSettingsSync(profileDir: string): AppSettings {
  const filePath = join(profileDir, 'huaanwork-settings.json')
  try {
    const content = readFileSync(filePath, 'utf8')
    return parseSettings(JSON.parse(content))
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT' || error instanceof SyntaxError) {
      return emptySettings()
    }
    throw error
  }
}

export async function writeHuaanworkSettings(profileDir: string, patch: unknown): Promise<AppSettings> {
  const filePath = join(profileDir, 'huaanwork-settings.json')
  const current = await readHuaanworkSettings(profileDir)
  const next = mergeSettings(current, patch)
  await mkdir(profileDir, { recursive: true })
  await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}
