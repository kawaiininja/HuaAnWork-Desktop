import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalJson, verifyAgentPackageDigestSignature } from '@huaanwork/catalog-signing'
import type { CatalogKeyringEntry, CatalogSignature } from '@huaanwork/catalog-signing'

import { parseAgentPackageManifest } from './manifest.ts'
import type { AgentPackageManifest } from './manifest.ts'

/** 目录枚举上限:File/Directory 条目总数。归档解包(Task 3)共用同一预算。 */
export const MAX_AGENT_PACKAGE_ENTRIES = 1024
/** 目录枚举上限:单个规范化相对路径的 UTF-8 字节数。 */
export const MAX_AGENT_PACKAGE_PATH_BYTES = 512

const MAX_PERSONA_BYTES = 32 * 1024
const MAX_SKILL_BYTES = 32 * 1024
const MAX_SCRIPT_BYTES = 256 * 1024
const MAX_ENTRY_BYTES = 256 * 1024
const MAX_SCRIPTS = 20
const MAX_PACKAGE_BYTES = 5 * 1024 * 1024

const PACKAGE_PATH_RE = /^[A-Za-z0-9._/-]+$/
const RESERVED_SEGMENT_PREFIXES = ['.tmp-', '.old-', '.install-'] as const
const SIGNATURE_DIR = '.signature'
const SIGNATURE_FILES = new Set([`${SIGNATURE_DIR}/package-digest.json`, `${SIGNATURE_DIR}/signature.json`])

/** 目录验签失败时唯一对外文案:不区分缺文件、篡改或签名不符。 */
const DIRECTORY_VERIFY_FAILURE = '包校验失败，未安装或未运行。请联系管理员'

export type AgentPackageFile = { path: string; data: Buffer }

export type AgentPackageDigestFile = { path: string; size: number; sha256: string }

export type AgentPackageDigest = {
  schemaVersion: 1
  slug: string
  version: string
  manifestSha256: string
  files: AgentPackageDigestFile[]
}

export type VerifiedAgentPackageDirectory = {
  manifest: AgentPackageManifest
  digest: AgentPackageDigest
  signature: CatalogSignature
}

export type ReadPackageFilesOptions = {
  /**
   * 仅内部复验签名目录时使用:跳过 `.signature/package-digest.json` 与
   * `.signature/signature.json`,其余 `.signature/` 内容仍拒绝。
   * 公开的 unsigned 入口(`readUnsignedPackageFiles`)不开放此选项。
   */
  ignoreSignature?: boolean
}

/**
 * 读取待签名包目录里的全部文件,并完成结构校验。
 *
 * 遍历即计数、即检查路径预算,超帽立刻抛错而不是先收齐再判断;任何符号链接、
 * 非普通文件、保留前缀(`.tmp-`/`.old-`/`.install-`)与 `.signature/` 内容都拒绝。
 * 返回的文件已按目录顺序枚举,digest 生成时再排序。
 */
export function readPackageFiles(
  packageDir: string,
  options: ReadPackageFilesOptions = {},
): AgentPackageFile[] {
  return readPackageContents(packageDir, options).files
}

/** 公开的 unsigned 枚举入口:不允许跳过 `.signature/`。 */
export function readUnsignedPackageFiles(packageDir: string): AgentPackageFile[] {
  return readPackageContents(packageDir, { ignoreSignature: false }).files
}

/**
 * 按路径排序生成包 digest。
 *
 * `manifestSha256` 绑定 `agent.json` 的原始字节;`slug`/`version` 来自 manifest,
 * 因此替换清单或改版本都会让 digest 与既有签名不符。重复路径与缺少 `agent.json`
 * 同样视为非法包。
 */
export function createAgentPackageDigest(
  manifest: AgentPackageManifest,
  files: AgentPackageFile[],
): AgentPackageDigest {
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (new Set(sorted.map((file) => file.path)).size !== sorted.length) throw new Error('包结构非法：重复文件')
  const rows = sorted.map((file) => ({
    path: file.path, size: file.data.byteLength,
    sha256: createHash('sha256').update(file.data).digest('hex'),
  }))
  const manifestRow = rows.find((file) => file.path === 'agent.json')
  if (!manifestRow) throw new Error('包结构非法：缺少 agent.json')
  return { schemaVersion: 1, slug: manifest.slug, version: manifest.version, manifestSha256: manifestRow.sha256, files: rows }
}

/**
 * 用包内容复算 digest 并做 canonical 字节比较。
 *
 * 任何结构错误(重复路径、缺 `agent.json`)或字节不一致都归入 `包校验失败`。
 */
export function verifyAgentPackageDigest(
  manifest: AgentPackageManifest,
  files: AgentPackageFile[],
  digest: unknown,
): void {
  let matches = false
  try {
    matches = canonicalJson(digest) === canonicalJson(createAgentPackageDigest(manifest, files))
  } catch {
    matches = false
  }
  if (!matches) throw new Error('包校验失败：digest 与包内容不一致')
}

/**
 * 验签一个已安装的包目录。
 *
 * 只从磁盘额外读取 `.signature/package-digest.json` 与 `.signature/signature.json`;
 * 先复算文件 digest,再按 keyring 验证签名。签名目录里的任何额外文件、缺失文件、
 * 篡改内容或未知/退休密钥都统一抛同一句对外文案。
 */
export function verifyAgentPackageDirectory(
  packageDir: string,
  keyring: readonly CatalogKeyringEntry[],
  now?: number,
): VerifiedAgentPackageDirectory {
  try {
    const { manifest, files } = readPackageContents(packageDir, { ignoreSignature: true })
    const digest = readSignatureDocument(packageDir, 'package-digest.json')
    const signature = readSignatureDocument(packageDir, 'signature.json')
    verifyAgentPackageDigest(manifest, files, digest)
    const verdict = now === undefined
      ? verifyAgentPackageDigestSignature(digest, signature, keyring)
      : verifyAgentPackageDigestSignature(digest, signature, keyring, now)
    if (!verdict.ok) throw new Error(`signature rejected: ${verdict.reason}`)
    return {
      manifest,
      digest: digest as AgentPackageDigest,
      signature: signature as CatalogSignature,
    }
  } catch {
    throw new Error(DIRECTORY_VERIFY_FAILURE)
  }
}

function readPackageContents(
  packageDir: string,
  options: ReadPackageFilesOptions,
): { manifest: AgentPackageManifest; files: AgentPackageFile[] } {
  let rootStat
  try {
    rootStat = lstatSync(packageDir)
  } catch {
    throw structureError('包目录不存在')
  }
  if (rootStat.isSymbolicLink()) throw structureError('包目录不得是符号链接')
  if (!rootStat.isDirectory()) throw structureError('包路径必须是目录')

  const state: { entries: number; bytes: number; files: AgentPackageFile[] } = { entries: 0, bytes: 0, files: [] }
  walkPackageDir(packageDir, '', options, state)
  const manifest = validatePackageStructure(state.files)
  return { manifest, files: state.files }
}

function walkPackageDir(
  packageDir: string,
  relativeDir: string,
  options: ReadPackageFilesOptions,
  state: { entries: number; bytes: number; files: AgentPackageFile[] },
): void {
  const absoluteDir = relativeDir === '' ? packageDir : join(packageDir, relativeDir)
  const dirents = readdirSync(absoluteDir, { withFileTypes: true })

  for (const dirent of dirents) {
    const relativePath = relativeDir === '' ? dirent.name : `${relativeDir}/${dirent.name}`
    const absolutePath = join(packageDir, relativePath)
    const stat = lstatSync(absolutePath)

    if (stat.isSymbolicLink()) throw structureError(`不得包含符号链接：${relativePath}`)
    if (!stat.isDirectory() && !stat.isFile()) throw structureError(`只允许普通文件与目录：${relativePath}`)
    if (relativePath === SIGNATURE_DIR && !stat.isDirectory()) {
      throw structureError(`${SIGNATURE_DIR} 必须是目录`)
    }

    state.entries += 1
    if (state.entries > MAX_AGENT_PACKAGE_ENTRIES) {
      throw structureError(`条目数超过${MAX_AGENT_PACKAGE_ENTRIES}`)
    }
    assertAllowedPath(relativePath, options)
    assertPathBudget(relativePath)

    if (stat.isDirectory()) {
      walkPackageDir(packageDir, relativePath, options, state)
      continue
    }
    if (options.ignoreSignature === true && SIGNATURE_FILES.has(relativePath)) continue
    // 先用 lstat 的声明大小累计总量,避免把超大文件整块读进内存后才判超帽。
    state.bytes += stat.size
    if (state.bytes > MAX_PACKAGE_BYTES) {
      throw structureError(`智能体包超过${MAX_PACKAGE_BYTES}字节上限`)
    }
    state.files.push({ path: relativePath, data: readFileSync(absolutePath) })
  }
}

function assertAllowedPath(relativePath: string, options: ReadPackageFilesOptions): void {
  if (relativePath.startsWith('/')) throw structureError(`路径必须是相对路径：${relativePath}`)
  if (relativePath.includes('\\')) throw structureError(`路径不得包含反斜杠：${relativePath}`)
  if (relativePath.includes('\0')) throw structureError(`路径不得包含 NUL：${relativePath}`)
  if (!PACKAGE_PATH_RE.test(relativePath)) throw structureError(`路径包含不允许的字符：${relativePath}`)

  const segments = relativePath.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw structureError(`路径不得包含 . 或 .. 段：${relativePath}`)
  }
  if (segments.some((segment) => RESERVED_SEGMENT_PREFIXES.some((prefix) => segment.startsWith(prefix)))) {
    throw structureError(`路径使用了保留前缀：${relativePath}`)
  }

  const signatureIndex = segments.indexOf(SIGNATURE_DIR)
  if (signatureIndex !== -1) {
    const allowed = options.ignoreSignature === true
      && signatureIndex === 0
      && (relativePath === SIGNATURE_DIR || SIGNATURE_FILES.has(relativePath))
    if (!allowed) throw structureError(`不接受签名目录内容：${relativePath}`)
  }
}

function assertPathBudget(relativePath: string): void {
  const bytes = Buffer.byteLength(relativePath, 'utf8')
  if (bytes > MAX_AGENT_PACKAGE_PATH_BYTES) {
    throw structureError(`路径超过${MAX_AGENT_PACKAGE_PATH_BYTES}字节：${relativePath}`)
  }
}

/**
 * 解析 `agent.json` 并核对声明与预算。
 *
 * 校验器负责字段形状;这里再核对声明的人设/技能/工具入口确实存在,并落实
 * 脚本数量、单文件与整包字节上限。任何不符都抛 `包结构非法`。
 */
function validatePackageStructure(files: AgentPackageFile[]): AgentPackageManifest {
  const byPath = new Map<string, AgentPackageFile>()
  for (const file of files) byPath.set(file.path, file)

  const agentJson = byPath.get('agent.json')
  if (agentJson === undefined) throw structureError('缺少 agent.json')

  let raw: unknown
  try {
    raw = JSON.parse(agentJson.data.toString('utf8'))
  } catch {
    throw structureError('agent.json 不是合法 JSON')
  }
  const parsed = parseAgentPackageManifest(raw)
  if (!parsed.ok) {
    const detail = parsed.fieldErrors.map((error) => `${error.field}: ${error.message}`).join('；')
    throw structureError(`agent.json 未通过校验（${detail}）`)
  }

  const manifest = parsed.manifest

  const persona = byPath.get(manifest.persona)
  if (persona === undefined) throw structureError(`缺少 ${manifest.persona}`)
  assertWithinBudget(manifest.persona, persona.data.byteLength, MAX_PERSONA_BYTES)

  if (manifest.skill !== null) {
    const skillFile = byPath.get(manifest.skill.entry)
    if (skillFile === undefined) throw structureError(`缺少 ${manifest.skill.entry}`)
    assertWithinBudget(manifest.skill.entry, skillFile.data.byteLength, MAX_SKILL_BYTES)
  }
  if (manifest.tools.http !== undefined) {
    const entry = byPath.get(manifest.tools.http.entry)
    if (entry === undefined) throw structureError(`缺少 ${manifest.tools.http.entry}`)
    assertWithinBudget(manifest.tools.http.entry, entry.data.byteLength, MAX_ENTRY_BYTES)
  }
  if (manifest.tools.mcp !== undefined) {
    const entry = byPath.get(manifest.tools.mcp.entry)
    if (entry === undefined) throw structureError(`缺少 ${manifest.tools.mcp.entry}`)
    assertWithinBudget(manifest.tools.mcp.entry, entry.data.byteLength, MAX_ENTRY_BYTES)
  }

  const scripts = files.filter((file) => file.path.startsWith('skill/scripts/'))
  if (scripts.length > MAX_SCRIPTS) throw structureError(`脚本数超过${MAX_SCRIPTS}`)
  for (const script of scripts) assertWithinBudget(script.path, script.data.byteLength, MAX_SCRIPT_BYTES)

  let total = 0
  for (const file of files) total += file.data.byteLength
  if (total > MAX_PACKAGE_BYTES) throw structureError(`智能体包超过${MAX_PACKAGE_BYTES}字节上限`)

  return manifest
}

function assertWithinBudget(path: string, size: number, limit: number): void {
  if (size > limit) throw structureError(`${path} 超过${limit}字节上限`)
}

function readSignatureDocument(packageDir: string, name: 'package-digest.json' | 'signature.json'): unknown {
  return JSON.parse(readFileSync(join(packageDir, SIGNATURE_DIR, name), 'utf8')) as unknown
}

function structureError(message: string): Error {
  return new Error(`包结构非法：${message}`)
}
