import { randomUUID } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { AGENT_NAME_RE } from '@huaanwork/policy/agent-catalog'

import { parseAgentPackageManifest } from './manifest.ts'
import type {
  AgentPackageDetail,
  AgentPackageListItem,
  AgentPackageManifest,
  AgentPackagePublishStatus,
  AgentPackageRevocation,
  AgentPackageSource,
  AgentPackageState,
  AgentPackageStateEntry,
  AgentPackageToolsMode,
} from './types.ts'

const TEMP_PREFIX = '.tmp-'
const OLD_PREFIX = '.old-'
const INSTALL_PREFIX = '.install-'
const CATALOG_TRANSACTION_FILE = 'transaction.json'
const DRAFTS_DIR = '.drafts'

// 单文件与集合上限。草稿 propose 从这里导入同一组值,校验与落盘不会各写一份。
export const MAX_PERSONA_BYTES = 32 * 1024
export const MAX_SKILL_BYTES = 32 * 1024
export const MAX_SCRIPT_BYTES = 256 * 1024
export const MAX_ENTRY_BYTES = 256 * 1024
export const MAX_SCRIPTS = 20
/** 整包(manifest 文本 + 人设 + 技能 + 脚本 + 工具入口)的字节上限。 */
export const MAX_PACKAGE_BYTES = 5 * 1024 * 1024

const SCRIPT_PATH_RE = /^[A-Za-z0-9._/-]+$/

export type WriteAgentPackageInput = {
  profileDir: string
  manifest: AgentPackageManifest
  persona: string
  skill: { markdown: string; scripts: Array<{ path: string; content: string }> } | null
  httpServer?: string
  mcpServer?: string
  replace: boolean
}

/** 一个包全部落盘文件的内容;字节合计由 `agentPackageBytes` 计算。 */
export type AgentPackageFileSet = Omit<WriteAgentPackageInput, 'profileDir' | 'replace'>

/**
 * 包内全部落盘文件的 UTF-8 字节合计。
 *
 * `writeAgentPackageAtomically` 的上限检查与草稿 propose 的预检共用这一处计算,
 * 两边不会各自漂移。
 */
export function agentPackageBytes(files: AgentPackageFileSet): number {
  let total = utf8Length(`${JSON.stringify(files.manifest, null, 2)}\n`) + utf8Length(files.persona)
  if (files.skill !== null) {
    total += utf8Length(files.skill.markdown)
    for (const script of files.skill.scripts) total += utf8Length(script.content)
  }
  if (files.httpServer !== undefined) total += utf8Length(files.httpServer)
  if (files.mcpServer !== undefined) total += utf8Length(files.mcpServer)
  return total
}

/** 本地智能体包的根目录 `{profileDir}/agents`。 */
export function agentPackagesRoot(profileDir: string): string {
  return join(profileDir, 'agents')
}

/** 单个包的目录 `{profileDir}/agents/{slug}`。 */
export function agentPackageDir(profileDir: string, slug: string): string {
  return join(agentPackagesRoot(profileDir), slug)
}

/** 启用状态的落点 `{profileDir}/agents-state.json`。 */
export function agentPackageStatePath(profileDir: string): string {
  return join(profileDir, 'agents-state.json')
}

const PUBLISH_STATUSES: ReadonlySet<AgentPackagePublishStatus> = new Set([
  'none',
  'pending-review',
  'published',
  'rejected',
  'delisted',
  'installed',
])

/**
 * 读取 `agents-state.json`。
 *
 * 缺失、无法解析或结构不符时返回空表。只保留键前缀与 `source` 一致的条目:
 * `local:` 必须 `source:'local'`,`catalog:` 必须 `source:'catalog'`;其余键与
 * 未知字段一律丢弃。本地条目缺省 `publishStatus:'none'`,目录条目缺省
 * `publishStatus:'installed'`;损坏条目的 `installedVersion` 回落为空串。
 */
export function readAgentPackageState(profileDir: string): AgentPackageState {
  const text = readText(agentPackageStatePath(profileDir))
  if (text === undefined) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (!isRecord(parsed)) return {}

  const entries: Array<[string, AgentPackageStateEntry]> = []
  for (const [key, value] of Object.entries(parsed)) {
    const entry = parseAgentPackageStateEntry(key, value)
    if (entry !== undefined) entries.push(entry)
  }
  return Object.fromEntries(entries)
}

function parseAgentPackageStateEntry(
  key: string,
  value: unknown,
): [string, AgentPackageStateEntry] | undefined {
  if (!isRecord(value)) return undefined
  let expected: AgentPackageSource
  if (key.startsWith('local:')) expected = 'local'
  else if (key.startsWith('catalog:')) expected = 'catalog'
  else return undefined
  const slug = key.slice(key.indexOf(':') + 1)
  if (!slug) return undefined
  if (value.source !== expected) return undefined

  const entry: AgentPackageStateEntry = {
    source: expected,
    enabled: value.enabled === true,
    installedVersion: typeof value.installedVersion === 'string' ? value.installedVersion : '',
    publishStatus:
      typeof value.publishStatus === 'string' && PUBLISH_STATUSES.has(value.publishStatus as AgentPackagePublishStatus)
        ? (value.publishStatus as AgentPackagePublishStatus)
        : expected === 'local'
          ? 'none'
          : 'installed',
  }
  if (typeof value.publishedVersion === 'string' && value.publishedVersion.length > 0) {
    entry.publishedVersion = value.publishedVersion
  }
  if (typeof value.submissionId === 'string' && value.submissionId.length > 0) {
    entry.submissionId = value.submissionId
  }
  if (typeof value.reviewReason === 'string' && value.reviewReason.length > 0) {
    entry.reviewReason = value.reviewReason
  }
  if (typeof value.delistRequestId === 'string' && value.delistRequestId.length > 0) {
    entry.delistRequestId = value.delistRequestId
  }
  const revoked = parseAgentPackageRevocation(value.revoked)
  if (revoked !== undefined) entry.revoked = revoked
  return [key, entry]
}

function parseAgentPackageRevocation(value: unknown): AgentPackageRevocation | undefined {
  if (!isRecord(value)) return undefined
  const { slug, version, reason, revokedAt } = value
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
    return undefined
  }
  return { slug, version, reason, revokedAt }
}

export type AgentPackageStateLookup =
  | { kind: 'none' }
  | { kind: 'local'; key: string; entry: AgentPackageStateEntry }
  | { kind: 'catalog'; key: string; entry: AgentPackageStateEntry }
  | { kind: 'corrupt'; reason: string }

/**
 * 按 slug 查一条 state。两个键同时存在时报状态损坏、不猜测来源。
 *
 * 读路径用 `broken` 卡片展示该原因;写路径(`setAgentPackageEnabled`)直接抛错。
 */
export function lookupAgentPackageState(state: AgentPackageState, slug: string): AgentPackageStateLookup {
  const localKey = `local:${slug}`
  const catalogKey = `catalog:${slug}`
  const local = state[localKey]
  const catalog = state[catalogKey]
  if (local !== undefined && catalog !== undefined) {
    return {
      kind: 'corrupt',
      reason: `状态损坏：智能体 @${slug} 同时存在 local: 与 catalog: 条目，无法判断来源`,
    }
  }
  if (catalog !== undefined) return { kind: 'catalog', key: catalogKey, entry: catalog }
  if (local !== undefined) return { kind: 'local', key: localKey, entry: local }
  return { kind: 'none' }
}

/** 状态文件整体重写:写 `agents-state.json.tmp`,再 rename 覆盖正式文件。 */
export function writeAgentPackageState(profileDir: string, state: AgentPackageState): void {
  const filePath = agentPackageStatePath(profileDir)
  const tempPath = `${filePath}.tmp`
  mkdirSync(dirname(filePath), { recursive: true })
  try {
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    renameSync(tempPath, filePath)
  } catch (error) {
    removeQuietly(tempPath)
    throw error
  }
}

/** 设置包的启用态;不存在的包也允许记录(界面在包落盘前可先写默认值)。 */
export function setAgentPackageEnabled(profileDir: string, slug: string, enabled: boolean): void {
  assertPackageSlug(slug)
  recoverAgentPackages(profileDir)
  const state = readAgentPackageState(profileDir)
  const lookup = lookupAgentPackageState(state, slug)
  if (lookup.kind === 'corrupt') throw new Error(lookup.reason)

  // 对称守卫:只要目录带 `.signature`,状态键就必须是 catalog:。stale local:
  // 键同样不能给签名包写启用态,否则 source(来自 .signature)与 enabled(来自
  // local 键)会来自不同的键。
  const signed = pathExists(join(agentPackageDir(profileDir, slug), '.signature'))
  if (signed && lookup.kind !== 'catalog') {
    throw new Error(`智能体 @${slug} 的签名包缺少 catalog 状态记录，请重新安装`)
  }

  let key: string
  if (lookup.kind === 'catalog') {
    key = lookup.key
  } else if (lookup.kind === 'local') {
    key = lookup.key
  } else {
    key = `local:${slug}`
  }

  const manifest = readManifestFromDir(agentPackageDir(profileDir, slug), slug)
  const previous = state[key]
  const installedVersion = manifest.ok ? manifest.manifest.version : previous?.installedVersion ?? ''
  const next: AgentPackageStateEntry = {
    ...previous,
    source: key.startsWith('catalog:') ? 'catalog' : 'local',
    enabled,
    installedVersion,
  }
  writeAgentPackageState(profileDir, {
    ...state,
    [key]: next,
  })
}

/**
 * 列出 `agents/` 下的本地包。损坏的包也返回卡片(`broken` 非空),供界面
 * 展示并禁止启用;读取前先做幂等恢复:清 `.tmp-*`,正式目录缺失时把 `.old-*`
 * 改回正式目录。
 */
export function listLocalAgentPackages(profileDir: string): AgentPackageListItem[] {
  recoverAgentPackages(profileDir)
  const state = readAgentPackageState(profileDir)
  let entries: Dirent[]
  try {
    entries = readdirSync(agentPackagesRoot(profileDir), { withFileTypes: true })
  } catch {
    return []
  }

  const items: AgentPackageListItem[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || !isValidAgentPackageSlug(entry.name)) continue
    const detail = readAgentPackageFromDir(profileDir, entry.name, state)
    if (detail === undefined) continue
    items.push(toListItem(detail))
  }
  return items.sort((left, right) => compareStrings(left.slug, right.slug))
}

/**
 * 读取一个本地包的详情。目录不存在或 slug 非法时返回 undefined;目录存在但
 * manifest/必需文件损坏时仍返回详情,并带 `broken.reason`——详情路由不能
 * 因为损坏就回落到同名的 legacy 目录条目。
 */
export function readAgentPackage(profileDir: string, slug: string): AgentPackageDetail | undefined {
  if (!isValidAgentPackageSlug(slug)) return undefined
  recoverAgentPackages(profileDir)
  try {
    if (!lstatSync(agentPackageDir(profileDir, slug)).isDirectory()) return undefined
  } catch {
    return undefined
  }
  return readAgentPackageFromDir(profileDir, slug, readAgentPackageState(profileDir))
}

/**
 * 原子写入一个包。
 *
 * 只写 manifest 声明的文件集:写 `agents/.tmp-{slug}-{random}/`,文件齐了再
 * rename 到 `agents/{slug}/`;`replace:true` 时先把旧目录 rename 到
 * `.old-{slug}-{random}`,新目录就位后删除旧目录,失败恢复旧目录。脚本路径
 * 只允许 `skill/scripts/` 下的相对路径,不允许 `..` 或符号链接。所有上限按
 * UTF-8 字节数在写盘前检查。
 */
export function writeAgentPackageAtomically(input: WriteAgentPackageInput): void {
  const parsed = parseAgentPackageManifest(input.manifest)
  if (!parsed.ok) {
    throw new Error(`manifest 校验失败:${formatFieldErrors(parsed.fieldErrors)}`)
  }
  const manifest = parsed.manifest
  const slug = manifest.slug
  assertPackageSlug(slug)

  const persona = input.persona
  if (typeof persona !== 'string' || !persona.trim()) {
    throw new Error('persona.md 不能为空')
  }
  const personaBytes = utf8Length(persona)
  if (personaBytes > MAX_PERSONA_BYTES) {
    throw new Error(`persona.md 超过 ${MAX_PERSONA_BYTES} 字节上限`)
  }

  let skillMarkdown: string | undefined
  let skillScripts: Array<{ path: string; content: string }> = []
  if (manifest.skill !== null) {
    if (input.skill === null) {
      throw new Error('manifest 声明了 skill,缺少 skill/SKILL.md 内容')
    }
    if (typeof input.skill.markdown !== 'string' || !input.skill.markdown.trim()) {
      throw new Error('skill/SKILL.md 不能为空')
    }
    if (utf8Length(input.skill.markdown) > MAX_SKILL_BYTES) {
      throw new Error(`skill/SKILL.md 超过 ${MAX_SKILL_BYTES} 字节上限`)
    }
    if (!Array.isArray(input.skill.scripts)) {
      throw new Error('skill.scripts 必须是数组')
    }
    if (input.skill.scripts.length > MAX_SCRIPTS) {
      throw new Error(`技能脚本最多 ${MAX_SCRIPTS} 个`)
    }
    const seenPaths = new Set<string>()
    for (const script of input.skill.scripts) {
      if (!script || typeof script.path !== 'string' || typeof script.content !== 'string') {
        throw new Error('skill.scripts 的每一项必须包含 path 与 content')
      }
      assertSkillScriptPath(script.path)
      const normalizedKey = script.path.toLowerCase()
      if (seenPaths.has(normalizedKey)) {
        throw new Error(`重复的技能脚本路径:${script.path}`)
      }
      seenPaths.add(normalizedKey)
      if (utf8Length(script.content) > MAX_SCRIPT_BYTES) {
        throw new Error(`技能脚本 ${script.path} 超过 ${MAX_SCRIPT_BYTES} 字节上限`)
      }
    }
    skillMarkdown = input.skill.markdown
    skillScripts = input.skill.scripts
  } else if (input.skill !== null) {
    throw new Error('manifest 未声明 skill,不能写入 skill 文件')
  }

  const wantsHttp = manifest.tools.mode === 'http' || manifest.tools.mode === 'both'
  const wantsMcp = manifest.tools.mode === 'mcp' || manifest.tools.mode === 'both'
  let httpServer: string | undefined
  let mcpServer: string | undefined
  if (wantsHttp) {
    if (typeof input.httpServer !== 'string' || !input.httpServer.trim()) {
      throw new Error('缺少 tools/http/server.mjs 内容')
    }
    if (utf8Length(input.httpServer) > MAX_ENTRY_BYTES) {
      throw new Error(`tools/http/server.mjs 超过 ${MAX_ENTRY_BYTES} 字节上限`)
    }
    httpServer = input.httpServer
  } else if (input.httpServer !== undefined) {
    throw new Error('manifest 未选择 HTTP,不能写入 tools/http/server.mjs')
  }
  if (wantsMcp) {
    if (typeof input.mcpServer !== 'string' || !input.mcpServer.trim()) {
      throw new Error('缺少 tools/mcp/server.mjs 内容')
    }
    if (utf8Length(input.mcpServer) > MAX_ENTRY_BYTES) {
      throw new Error(`tools/mcp/server.mjs 超过 ${MAX_ENTRY_BYTES} 字节上限`)
    }
    mcpServer = input.mcpServer
  } else if (input.mcpServer !== undefined) {
    throw new Error('manifest 未选择 MCP,不能写入 tools/mcp/server.mjs')
  }

  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  const totalBytes = agentPackageBytes({
    manifest,
    persona,
    skill: skillMarkdown === undefined ? null : { markdown: skillMarkdown, scripts: skillScripts },
    ...(httpServer === undefined ? {} : { httpServer }),
    ...(mcpServer === undefined ? {} : { mcpServer }),
  })
  if (totalBytes > MAX_PACKAGE_BYTES) {
    throw new Error(`智能体包超过 ${MAX_PACKAGE_BYTES} 字节上限`)
  }

  recoverAgentPackages(input.profileDir)
  const root = agentPackagesRoot(input.profileDir)
  mkdirSync(root, { recursive: true })
  const finalDir = join(root, slug)
  if (!input.replace && pathExists(finalDir)) {
    throw new Error(`智能体 @${slug} 已存在`)
  }

  const tempDir = join(root, `${TEMP_PREFIX}${slug}-${randomSuffix()}`)
  let oldDir: string | undefined
  try {
    mkdirSync(tempDir)
    writeFileSync(join(tempDir, 'agent.json'), manifestText, 'utf8')
    writeFileSync(join(tempDir, 'persona.md'), persona, 'utf8')
    if (skillMarkdown !== undefined) {
      writePackageFile(tempDir, 'skill/SKILL.md', skillMarkdown)
      for (const script of skillScripts) {
        writePackageFile(tempDir, script.path, script.content)
        assertNoSymlinkSegments(tempDir, script.path)
      }
    }
    if (httpServer !== undefined) {
      writePackageFile(tempDir, 'tools/http/server.mjs', httpServer)
      assertNoSymlinkSegments(tempDir, 'tools/http/server.mjs')
    }
    if (mcpServer !== undefined) {
      writePackageFile(tempDir, 'tools/mcp/server.mjs', mcpServer)
      assertNoSymlinkSegments(tempDir, 'tools/mcp/server.mjs')
    }

    if (input.replace && pathExists(finalDir)) {
      oldDir = join(root, `${OLD_PREFIX}${slug}-${randomSuffix()}`)
      renameSync(finalDir, oldDir)
    }

    try {
      renameSync(tempDir, finalDir)
    } catch (error) {
      if (oldDir !== undefined) {
        try {
          renameSync(oldDir, finalDir)
          oldDir = undefined
        } catch (restoreError) {
          throw new Error(`写入 @${slug} 失败且无法恢复旧目录:${errorMessage(restoreError)}`, { cause: error })
        }
      }
      throw error
    }

    if (oldDir !== undefined) {
      try {
        rmSync(oldDir, { recursive: true, force: true })
      } catch {
        // 新目录已就位;残留 .old-* 由下一次读路径清理。
      }
    }
  } catch (error) {
    removeQuietly(tempDir)
    if (oldDir !== undefined && !pathExists(finalDir)) {
      try {
        renameSync(oldDir, finalDir)
      } catch {
        // 恢复失败时保留 .old-*;下一次读路径会重试。
      }
    }
    throw error
  }
}

/**
 * 断言 slug 未被占用:`taken` 由调用方汇总本地工具名与 legacy 目录名;
 * 另拒绝已有包目录(含损坏包)。冲突时抛错。
 */
export function assertAgentPackageSlugFree(profileDir: string, slug: string, taken: readonly string[]): void {
  assertPackageSlug(slug)
  recoverAgentPackages(profileDir)
  if (taken.includes(slug)) {
    throw new Error(`智能体 @${slug} 与现有智能体或本地工具重名`)
  }
  if (pathExists(agentPackageDir(profileDir, slug))) {
    throw new Error(`智能体 @${slug} 已存在`)
  }
}

function readAgentPackageFromDir(
  profileDir: string,
  slug: string,
  state: AgentPackageState,
): AgentPackageDetail | undefined {
  const packageDir = agentPackageDir(profileDir, slug)
  const files = listPackageFiles(packageDir)
  const reasons: string[] = []
  const lookup = lookupAgentPackageState(state, slug)
  const signed = pathExists(join(packageDir, '.signature'))
  if (lookup.kind === 'corrupt') reasons.push(lookup.reason)
  if (signed && lookup.kind !== 'catalog') {
    reasons.push('签名包缺少 catalog: 状态记录，不能按本地包处理，请重新安装')
  }
  // 来源来自实际证据与 state 键:有 .signature 只能是目录包;否则看是否登记了
  // catalog: 键;都没有才是本地包。损坏状态不得回退成 local。
  const source: AgentPackageSource = signed ? 'catalog' : lookup.kind === 'catalog' ? 'catalog' : 'local'
  // 签名目录只认 catalog: 键;stale local: 键不得给签名包提供 enabled 或任何
  // 发布字段,否则 source 与 enabled 来自不同的键。
  const stateEntry = lookup.kind === 'local' || lookup.kind === 'catalog' ? lookup.entry : undefined
  const entry = signed && lookup.kind !== 'catalog' ? undefined : stateEntry
  const enabled = entry?.enabled === true
  const manifestRead = readManifestFromDir(packageDir, slug)
  const manifest = manifestRead.ok ? manifestRead.manifest : undefined

  let displayName = slug
  let description = ''
  let version = ''
  if (manifestRead.ok) {
    displayName = manifestRead.manifest.displayName
    description = manifestRead.manifest.description
    version = manifestRead.manifest.version
  } else {
    reasons.push(manifestRead.reason)
    if (manifestRead.raw !== undefined) {
      displayName = nonEmptyString(manifestRead.raw.displayName) ?? slug
      description = nonEmptyString(manifestRead.raw.description) ?? ''
      version = nonEmptyString(manifestRead.raw.version) ?? ''
    }
  }

  const persona = readPackageText(packageDir, 'persona.md') ?? ''
  if (manifest !== undefined && !persona.trim()) {
    reasons.push('persona.md 缺失或为空')
  }

  const scriptPaths = listSkillScripts(packageDir)
  let skill: AgentPackageDetail['skill'] = null
  if (manifest?.skill) {
    const markdown = readPackageText(packageDir, 'skill/SKILL.md') ?? ''
    if (!markdown.trim()) reasons.push('skill/SKILL.md 缺失或为空')
    skill = { summary: manifest.skill.summary, markdown, scripts: scriptPaths }
  } else if (manifest !== undefined) {
    if (pathExists(join(packageDir, 'skill', 'SKILL.md'))) {
      reasons.push('manifest 未声明 skill 但存在 skill/SKILL.md')
    } else if (scriptPaths.length > 0) {
      reasons.push('manifest 未声明 skill 但存在 skill/scripts 文件')
    }
  }

  let mode: AgentPackageToolsMode = manifest?.tools.mode ?? 'none'
  if (manifest !== undefined) {
    const wantsHttp = mode === 'http' || mode === 'both'
    const hasHttp = isRegularFile(join(packageDir, 'tools', 'http', 'server.mjs'))
    if (wantsHttp && !hasHttp) reasons.push('tools/http/server.mjs 缺失')
    if (!wantsHttp && pathExists(join(packageDir, 'tools', 'http', 'server.mjs'))) {
      reasons.push('未选择 HTTP 但存在 tools/http/server.mjs')
    }
    const wantsMcp = mode === 'mcp' || mode === 'both'
    const hasMcp = isRegularFile(join(packageDir, 'tools', 'mcp', 'server.mjs'))
    if (wantsMcp && !hasMcp) reasons.push('tools/mcp/server.mjs 缺失')
    if (!wantsMcp && pathExists(join(packageDir, 'tools', 'mcp', 'server.mjs'))) {
      reasons.push('未选择 MCP 但存在 tools/mcp/server.mjs')
    }
  } else {
    mode = 'none'
  }

  const publishStatus: AgentPackagePublishStatus | undefined =
    entry?.publishStatus ?? (source === 'local' ? 'none' : undefined)

  return {
    slug,
    displayName,
    description,
    version,
    source,
    enabled,
    ...(reasons.length > 0 ? { broken: { reason: reasons.join('；') } } : {}),
    ...(publishStatus === undefined ? {} : { publishStatus }),
    ...(entry?.publishedVersion === undefined ? {} : { publishedVersion: entry.publishedVersion }),
    ...(entry?.submissionId === undefined ? {} : { submissionId: entry.submissionId }),
    ...(entry?.reviewReason === undefined ? {} : { reviewReason: entry.reviewReason }),
    ...(entry?.delistRequestId === undefined ? {} : { delistRequestId: entry.delistRequestId }),
    ...(entry?.revoked === undefined ? {} : { revoked: entry.revoked }),
    persona,
    skill,
    tools: mode,
    files,
  }
}

function toListItem(detail: AgentPackageDetail): AgentPackageListItem {
  return {
    slug: detail.slug,
    displayName: detail.displayName,
    description: detail.description,
    version: detail.version,
    source: detail.source,
    enabled: detail.enabled,
    ...(detail.broken === undefined ? {} : { broken: detail.broken }),
    ...(detail.publishStatus === undefined ? {} : { publishStatus: detail.publishStatus }),
    ...(detail.publishedVersion === undefined ? {} : { publishedVersion: detail.publishedVersion }),
    ...(detail.submissionId === undefined ? {} : { submissionId: detail.submissionId }),
    ...(detail.reviewReason === undefined ? {} : { reviewReason: detail.reviewReason }),
    ...(detail.delistRequestId === undefined ? {} : { delistRequestId: detail.delistRequestId }),
    ...(detail.revoked === undefined ? {} : { revoked: detail.revoked }),
  }
}

type ManifestReadResult =
  | { ok: true; manifest: AgentPackageManifest }
  | { ok: false; reason: string; raw?: Record<string, unknown> }

function readManifestFromDir(packageDir: string, slug: string): ManifestReadResult {
  const text = readPackageText(packageDir, 'agent.json')
  if (text === undefined) {
    return { ok: false, reason: 'manifest 不可读:agent.json 缺失' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, reason: `manifest 无法解析:${errorMessage(error)}` }
  }
  const parsed = parseAgentPackageManifest(raw)
  if (!parsed.ok) {
    return {
      ok: false,
      reason: `manifest 校验失败:${formatFieldErrors(parsed.fieldErrors)}`,
      ...(isRecord(raw) ? { raw } : {}),
    }
  }
  if (parsed.manifest.slug !== slug) {
    return {
      ok: false,
      reason: `manifest 的 slug(${parsed.manifest.slug})与目录名(${slug})不一致`,
      raw: raw as Record<string, unknown>,
    }
  }
  return { ok: true, manifest: parsed.manifest }
}

function listPackageFiles(packageDir: string): Array<{ path: string; size: number }> {
  const result: Array<{ path: string; size: number }> = []
  walkFiles(packageDir, (relativePath) => {
    try {
      result.push({ path: relativePath, size: statSync(join(packageDir, relativePath)).size })
    } catch {
      // 扫描后文件消失:不把已消失的文件列入清单。
    }
  })
  return result.sort((left, right) => compareStrings(left.path, right.path))
}

function listSkillScripts(packageDir: string): string[] {
  const result: string[] = []
  walkFiles(join(packageDir, 'skill', 'scripts'), (relativePath) => {
    result.push(`skill/scripts/${relativePath}`)
  })
  return result.sort((left, right) => compareStrings(left, right))
}

function walkFiles(rootDir: string, visit: (relativePath: string) => void, relativeDir = ''): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(join(rootDir, relativeDir), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === '.signature') continue
    const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
    if (entry.isDirectory()) {
      walkFiles(rootDir, visit, relativePath)
      continue
    }
    if (entry.isFile()) visit(relativePath)
  }
}

function recoverAgentPackages(profileDir: string): void {
  const root = agentPackagesRoot(profileDir)
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }

  // C17:`catalog-publish` 等直接读路径只经过这里,不经过 host 的 catalog 恢复。
  // 一笔未完成的广场安装/更新把旧目录放在 `.old-*` 里,通用清理的
  // 「formal 已存在就删备份」会先毁掉唯一能还原的旧目录。先让位给
  // `recoverCatalogPackageInstalls`,由它按 transaction.json 决定去留。
  const pendingCatalogSlugs = pendingCatalogTransactionSlugs(root, entries)
  for (const entry of entries) {
    if (entry.name === DRAFTS_DIR) continue
    if (entry.name.startsWith(TEMP_PREFIX)) {
      removeQuietly(join(root, entry.name))
      continue
    }
    if (!entry.name.startsWith(OLD_PREFIX)) continue

    const slug = slugFromSuffixedName(entry.name, OLD_PREFIX)
    if (slug === undefined) continue
    if (pendingCatalogSlugs.has(slug)) continue
    const oldDir = join(root, entry.name)
    const finalDir = join(root, slug)
    try {
      if (!entry.isDirectory() || pathExists(finalDir)) {
        removeQuietly(oldDir)
        continue
      }
      renameSync(oldDir, finalDir)
    } catch {
      // 恢复失败时保留 .old-*;下一次读路径会重试。
    }
  }
}

/**
 * 有未完成 catalog 安装交易的 slug。
 *
 * 判定标准是暂存区里已有 `transaction.json`:此时才存在一笔可恢复的
 * 「旧目录已 rename、state 未/已写」交易。没有交易记录的 `.install-*` 只是
 * 下载中途的残留,不影响通用 `.old-*` 清理。
 */
function pendingCatalogTransactionSlugs(root: string, entries: readonly Dirent[]): Set<string> {
  const slugs = new Set<string>()
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(INSTALL_PREFIX)) continue
    const slug = slugFromSuffixedName(entry.name, INSTALL_PREFIX)
    if (slug === undefined) continue
    if (pathExists(join(root, entry.name, CATALOG_TRANSACTION_FILE))) slugs.add(slug)
  }
  return slugs
}

function writePackageFile(packageDir: string, relativePath: string, content: string): void {
  const target = join(packageDir, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

function assertNoSymlinkSegments(packageDir: string, relativePath: string): void {
  let current = packageDir
  for (const segment of relativePath.split('/')) {
    current = join(current, segment)
    let stat
    try {
      stat = lstatSync(current)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`文件路径不得经过符号链接:${relativePath}`)
    }
  }
}

function assertSkillScriptPath(scriptPath: string): void {
  if (!SCRIPT_PATH_RE.test(scriptPath)) {
    throw new Error(`技能脚本路径只能包含字母、数字、点、下划线、斜杠与连字符:${scriptPath}`)
  }
  if (!isAgentPackageScriptPath(scriptPath)) {
    throw new Error(`技能脚本必须位于 skill/scripts/ 下且不得包含 . 或 .. 段:${scriptPath}`)
  }
}

/** 技能脚本路径只允许 `skill/scripts/` 下的相对路径,不含 `.` 或 `..` 段。 */
export function isAgentPackageScriptPath(scriptPath: string): boolean {
  if (!SCRIPT_PATH_RE.test(scriptPath)) return false
  const segments = scriptPath.split('/')
  return (
    segments.length >= 3 &&
    segments[0] === 'skill' &&
    segments[1] === 'scripts' &&
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  )
}

function assertPackageSlug(slug: string): void {
  if (!isValidAgentPackageSlug(slug)) {
    throw new Error(`智能体 @标识「${slug}」无效`)
  }
}

/**
 * slug 形状校验。目录名、状态键与广场安装请求共用这一条规则。
 *
 * 导出给 catalog 安装/恢复使用:解析 `.install-*`/`.remove-*` 目录名与交易
 * 记录时不能各自复制一份正则。
 */
export function isValidAgentPackageSlug(slug: string): boolean {
  return slug.length <= 32 && AGENT_NAME_RE.test(slug)
}

function slugFromSuffixedName(name: string, prefix: string): string | undefined {
  const rest = name.slice(prefix.length)
  const separator = rest.lastIndexOf('-')
  if (separator <= 0) return undefined
  const slug = rest.slice(0, separator)
  return isValidAgentPackageSlug(slug) ? slug : undefined
}

function randomSuffix(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12)
}

function pathExists(filePath: string): boolean {
  try {
    lstatSync(filePath)
    return true
  } catch {
    return false
  }
}

/** 清理失败不能覆盖调用方的原始结果;残留由下一次读路径重试。 */
function removeQuietly(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true })
  } catch {
    // 尽力而为。
  }
}

function isRegularFile(filePath: string): boolean {
  try {
    return lstatSync(filePath).isFile()
  } catch {
    return false
  }
}

function readText(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 读取包内的普通文件。
 *
 * 含空段、`.`、`..` 或反斜杠的路径,任一段是符号链接,或最终不是普通文件时
 * 返回 undefined;草稿的更新种子复用同一守卫。
 */
export function readAgentPackageFile(
  profileDir: string,
  slug: string,
  relativePath: string,
): string | undefined {
  if (!isValidAgentPackageSlug(slug) || relativePath.includes('\\')) return undefined
  const segments = relativePath.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined
  return readPackageText(agentPackageDir(profileDir, slug), relativePath)
}

/** 只读取包内普通文件;路径任一段是符号链接、或最终不是普通文件时返回 undefined。 */
function readPackageText(packageDir: string, relativePath: string): string | undefined {
  if (pathHasSymlinkSegment(packageDir, relativePath)) return undefined
  const target = join(packageDir, relativePath)
  if (!isRegularFile(target)) return undefined
  try {
    return readFileSync(target, 'utf8')
  } catch {
    return undefined
  }
}

function pathHasSymlinkSegment(baseDir: string, relativePath: string): boolean {
  let current = baseDir
  try {
    if (lstatSync(current).isSymbolicLink()) return true
  } catch {
    return true
  }
  for (const segment of relativePath.split('/')) {
    current = join(current, segment)
    try {
      if (lstatSync(current).isSymbolicLink()) return true
    } catch {
      return false
    }
  }
  return false
}

/**
 * 只读取一个包目录的 manifest 版本,不做任何恢复扫描。
 *
 * catalog 安装恢复必须在 M1 的通用 `.old-*` 清理**之前**判断磁盘版本是否已是
 * 事务的目标版本;`readAgentPackage` 会先跑通用恢复,因此不能用它。
 * manifest 损坏时仍返回 `version` 原文(恢复只做字符串比较,不解析清单)。
 */
export function readAgentPackageVersionFromDir(packageDir: string): string | undefined {
  const text = readPackageText(packageDir, 'agent.json')
  if (text === undefined) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  return typeof raw.version === 'string' && raw.version.length > 0 ? raw.version : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function formatFieldErrors(fieldErrors: ReadonlyArray<{ field: string; message: string }>): string {
  return fieldErrors.map((error) => `${error.field}: ${error.message}`).join('；')
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
