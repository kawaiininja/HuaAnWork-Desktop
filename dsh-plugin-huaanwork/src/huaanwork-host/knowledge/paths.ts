/**
 * 知识库源目录绑定校验与卷大小写敏感性只读探测（规格 §5.2）。
 *
 * `validateSourceDir` 只做只读探测，零副作用，且对任何非法输入都返回
 * `{ ok: false, reason }` 而绝不抛出——路由层据此直接回传用户可读错误。
 */

import { R_OK } from 'node:constants'
import { access, lstat, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { KnowledgeBaseRecord } from './types.ts'

export interface ValidateSourceDirInput {
  readonly sourceDir: string
  readonly profileDir: string
  readonly existing: readonly KnowledgeBaseRecord[]
  /** 重绑场景跳过自身记录，避免与自己的旧源目录判重。 */
  readonly ignoreKbId?: string
  /** 可注入平台（测试确定性）；缺省 `process.platform`。 */
  readonly platform?: NodeJS.Platform
}

export type ValidateSourceDirResult =
  | { readonly ok: true; readonly realSourceDir: string }
  | { readonly ok: false; readonly reason: string }

/**
 * 与进程 locale 无关的 ASCII 大小写折叠（M-4 修复）：
 * 土耳其语等 locale 下 `String.prototype.toLowerCase()` 对 `I` / `i` 的折叠
 * 偏离文件系统语义，路径比较统一只折叠 ASCII `A-Z`。
 */
export function foldAsciiPath(value: string): string {
  return value.replace(/[A-Z]/gu, char => String.fromCharCode(char.charCodeAt(0) + 32))
}

/**
 * 判断原始输入是否为 Windows UNC 共享、混合斜杠 UNC、设备路径（`\\server\share`、
 * `\/server/share`、`/\server\share`、`\\.\`、`\\?\`、`\??\`）或 POSIX 双斜杠形式。
 * 这类路径会触发对外凭据协商，一律拒绝（D11 / C-4）。
 */
export function isUncOrDevicePath(rawPath: string): boolean {
  return /^[\\/]{2}/u.test(rawPath) || /^[\\/]\?\?[\\/]/iu.test(rawPath)
}

/**
 * 校验 `readlink` / `realpath` 产出的目标是否为 UNC 共享或设备路径（D11 / C-4）。
 * Windows 上 libuv / junction 返回的本地扩展盘符路径 `\\?\C:\...`（及 NT 对象前缀
 * `\??\C:\...`）允许剥离该前缀；`\\?\UNC\...`、`\??\UNC\...`、`\\.\...`、
 * `\\server\...`、`//server/...` 与混合斜杠变体一律拒绝。
 */
export function isUncOrDeviceTarget(candidate: string): boolean {
  if (/^[\\/]{2}\?[\\/]UNC[\\/]/iu.test(candidate)) return true
  if (/^[\\/]\?\?[\\/]UNC[\\/]/iu.test(candidate)) return true
  if (/^[\\/]{2}\.[\\/]/u.test(candidate)) return true
  if (/^[\\/]\?\?[\\/]/iu.test(candidate) && !/^[\\/]\?\?[\\/][A-Za-z]:[\\/]/u.test(candidate)) return true
  if (/^[\\/]{2}/u.test(candidate) && !/^\\\\\?\\[A-Za-z]:[\\/]/u.test(candidate)) return true
  return false
}

export function normalizeResolvedLocalPath(candidate: string): string | null {
  if (isUncOrDeviceTarget(candidate)) return null
  if (/^\\\\\?\\[A-Za-z]:[\\/]/u.test(candidate)) return candidate.slice(4)
  if (/^[\\/]\?\?[\\/][A-Za-z]:[\\/]/u.test(candidate)) return candidate.slice(4)
  return candidate
}

const MAX_SYMLINK_INSPECT_HOPS = 32

/** 将路径拆为（根前缀，词法段列表），不提前折叠 `..` 以免跨符号链接漏检。 */
function splitRawPathTopDown(rawPath: string): { readonly root: string; readonly segments: string[] } {
  const driveMatch = /^([A-Za-z]:)([\\/]*)(.*)$/u.exec(rawPath)
  if (driveMatch !== null) {
    const drive = driveMatch[1] ?? ''
    const slashes = driveMatch[2] ?? ''
    const rest = driveMatch[3] ?? ''
    if (slashes.length > 0) {
      return { root: `${drive}${sep}`, segments: rest.split(/[\\/]+/u).filter(seg => seg !== '') }
    }
    const base = resolve(drive)
    return splitRawPathTopDown(`${base}${base.endsWith(sep) ? '' : sep}${rest}`)
  }
  if (rawPath.startsWith('/') || rawPath.startsWith('\\')) {
    return { root: sep, segments: rawPath.slice(1).split(/[\\/]+/u).filter(seg => seg !== '') }
  }
  const cwd = resolve('.')
  const cwdSplit = splitRawPathTopDown(cwd)
  return {
    root: cwdSplit.root,
    segments: [...cwdSplit.segments, ...rawPath.split(/[\\/]+/u).filter(seg => seg !== '')],
  }
}

export type UncInspectVerdict = 'ok' | 'unc-target' | 'too-many-hops'

/**
 * 在 `realpath()` 之前自顶向下逐段检查源路径中的符号链接 / Windows junction（C-4）：
 * - 从根向叶逐段 `lstat`，先检父段再进子段，避免 Windows 内核对子路径调用
 *   `lstat("C:\\local\\uncLink\\nested")` 时提前解析 `uncLink` 触发 SMB 凭据协商；
 * - 不预先用 `resolve()` 折叠 `..`，防止 `${uncLink}/../other` 逃过预检；
 * - 符号链接跳数超过上限或成环时 fail-closed 拒绝，绝不放行给 `realpath()`。
 */
export async function inspectUncSymlinkTargetsTopDown(rawPath: string): Promise<UncInspectVerdict> {
  const initial = splitRawPathTopDown(rawPath)
  let current = initial.root
  const queue: string[] = [...initial.segments]
  let hops = 0
  const expandedLinks = new Set<string>()

  while (queue.length > 0) {
    const segment = queue.shift()
    if (segment === undefined || segment === '' || segment === '.') continue
    if (segment === '..') {
      current = dirname(current)
      continue
    }
    const next = join(current, segment)
    let info
    try {
      info = await lstat(next)
    } catch {
      // 缺失或不可读段留给后续 `realpath` / `stat` 报告标准错误；此前已检祖先均非 UNC。
      return 'ok'
    }
    if (!info.isSymbolicLink()) {
      current = next
      continue
    }
    const linkKey = `${current}\u0000${segment}\u0000${queue.join('/')}`
    if (expandedLinks.has(linkKey) || hops >= MAX_SYMLINK_INSPECT_HOPS) {
      return 'too-many-hops'
    }
    expandedLinks.add(linkKey)
    hops += 1

    let target: string
    try {
      target = await readlink(next)
    } catch {
      return 'ok'
    }
    if (isUncOrDeviceTarget(target)) return 'unc-target'
    const normalizedTarget = normalizeResolvedLocalPath(target)
    if (normalizedTarget === null) return 'unc-target'

    const remaining = queue.splice(0)
    if (isAbsolute(normalizedTarget) || /^[A-Za-z]:[\\/]/u.test(normalizedTarget)) {
      const targetSplit = splitRawPathTopDown(normalizedTarget)
      current = targetSplit.root
      queue.push(...targetSplit.segments, ...remaining)
    } else {
      const targetSegs = normalizedTarget.split(/[\\/]+/u).filter(seg => seg !== '')
      queue.push(...targetSegs, ...remaining)
    }
  }
  return 'ok'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** 找到名称中首个 ASCII 字母并翻转其大小写；无 ASCII 字母时返回 null。 */
function toggleFirstAsciiLetter(name: string): string | null {
  const index = name.search(/[A-Za-z]/u)
  if (index < 0) return null
  const char = name.charAt(index)
  const toggled = char >= 'a' && char <= 'z'
    ? String.fromCharCode(char.charCodeAt(0) - 32)
    : String.fromCharCode(char.charCodeAt(0) + 32)
  return `${name.slice(0, index)}${toggled}${name.slice(index + 1)}`
}

/**
 * 只读探测 `dirPath` 所在目录/卷是否区分大小写（I-5 / Registry I-3）：
 * 1. 优先在 `dirPath` 内部寻找已有且含 ASCII 字母的直接子项，用大小写变体比较
 *    `(dev, ino)`——可准确识别跨挂载点（如 macOS `/Volumes/CaseSensitive`）与
 *    Windows 单目录大小写敏感属性；
 * 2. 若目录为空或无 ASCII 子项，再沿同一设备（`parent.dev === dirDev`）向上探测
 *    祖先段名称，绝不跨挂载点误测父卷；
 * 3. 仍无 ASCII 字母或探测异常时，按 `platform === 'linux'` 保守回退。
 * 绝不创建、写入或删除任何文件。
 */
export async function probeCaseSensitiveDir(
  dirPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  try {
    const resolved = await realpath(dirPath)
    let current = normalizeResolvedLocalPath(resolved) ?? resolved
    const startInfo = await lstat(current, { bigint: true })
    const targetDev = startInfo.dev

    // 1. 优先在目标目录内部只读探测，避免跨挂载点或 Windows 单目录属性误判。
    try {
      const children = await readdir(current)
      for (const child of children) {
        const variantName = toggleFirstAsciiLetter(child)
        if (variantName === null) continue
        const originalPath = join(current, child)
        const variantPath = join(current, variantName)
        try {
          const original = await lstat(originalPath, { bigint: true })
          const variant = await lstat(variantPath, { bigint: true })
          return !(variant.dev === original.dev && variant.ino === original.ino)
        } catch (error) {
          if (errorCode(error) === 'ENOENT') return true
          break
        }
      }
    } catch {
      // 读目录失败时退回同设备祖先探测。
    }

    // 2. 无可用子项：沿同一 dev 向上探测，遇到挂载点边界（parent.dev !== targetDev）即停止。
    for (;;) {
      const parent = dirname(current)
      if (parent === current) break
      let parentInfo
      try {
        parentInfo = await lstat(parent, { bigint: true })
      } catch {
        break
      }
      if (parentInfo.dev !== targetDev) break
      const variantName = toggleFirstAsciiLetter(basename(current))
      if (variantName !== null) {
        const variantPath = join(parent, variantName)
        try {
          const original = await lstat(current, { bigint: true })
          const variant = await lstat(variantPath, { bigint: true })
          return !(variant.dev === original.dev && variant.ino === original.ino)
        } catch (error) {
          if (errorCode(error) === 'ENOENT') return true
          throw error
        }
      }
      current = parent
    }
  } catch {
    // 探测失败：按平台保守回退（Linux 默认大小写敏感）。
  }
  return platform === 'linux'
}

/** `parent` 等于 `child` 或为其祖先目录（两路径均已规范化）。 */
function isSameOrAncestor(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  if (rel === '') return true
  // 跨盘符（Windows）时 `relative` 返回绝对路径，无法判定为后代。
  if (isAbsolute(rel)) return false
  // 只有 `..` 本身或以 `..<sep>` 开头的相对路径才是向上逃逸；`..hidden`
  // 这类真实目录名是后代，不能被当成 `..` 前缀而误判（否则隔离守卫 fail-open）。
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** 两条规范化路径相同或互为祖先/子目录。 */
function overlaps(a: string, b: string): boolean {
  return isSameOrAncestor(a, b) || isSameOrAncestor(b, a)
}

/** 已存在时用 `realpath` 并剥离 Windows `\\?\` 扩展前缀，已不可用时回退 `resolve`（I-5）。 */
async function canonicalizePath(rawPath: string): Promise<string> {
  try {
    const resolved = await realpath(rawPath)
    return normalizeResolvedLocalPath(resolved) ?? resolved
  } catch {
    const resolved = resolve(rawPath)
    return normalizeResolvedLocalPath(resolved) ?? resolved
  }
}

function invalid(reason: string): ValidateSourceDirResult {
  return { ok: false, reason }
}

async function validateSourceDirInner(input: ValidateSourceDirInput): Promise<ValidateSourceDirResult> {
  const platform = input.platform ?? process.platform
  const rawSourceDir = input.sourceDir
  if (typeof rawSourceDir !== 'string') {
    return invalid('sourceDir 必须是字符串')
  }
  if (rawSourceDir.trim() === '') {
    return invalid('sourceDir 为空')
  }
  if (isUncOrDevicePath(rawSourceDir)) {
    return invalid('sourceDir 不能是 UNC 共享或 Windows 设备路径')
  }
  const uncVerdict = await inspectUncSymlinkTargetsTopDown(rawSourceDir)
  if (uncVerdict === 'unc-target') {
    return invalid('sourceDir 符号链接目标不能是 UNC 共享或 Windows 设备路径')
  }
  if (uncVerdict === 'too-many-hops') {
    return invalid('sourceDir 符号链接层级过深或存在循环')
  }

  let realSourceDir: string
  try {
    const resolved = await realpath(rawSourceDir)
    const normalized = normalizeResolvedLocalPath(resolved)
    if (normalized === null) {
      return invalid('sourceDir 规范化路径不能是 UNC 共享或 Windows 设备路径')
    }
    realSourceDir = normalized
    const info = await stat(realSourceDir)
    if (!info.isDirectory()) return invalid('sourceDir 不是目录')
    await access(realSourceDir, R_OK)
  } catch (error) {
    return invalid(`sourceDir 不可访问: ${errorMessage(error)}`)
  }

  // 规范化大小写后比较：按源目录所在卷的实际大小写敏感性收窄（规格 §5.2，M-4 ASCII 折叠）。
  const caseSensitive = await probeCaseSensitiveDir(realSourceDir, platform)
  const fold = caseSensitive ? (value: string): string => value : foldAsciiPath
  const sourceCmp = fold(realSourceDir)
  const profileCmp = fold(await canonicalizePath(input.profileDir))
  if (overlaps(profileCmp, sourceCmp)) {
    return invalid('sourceDir 不能与 profile 目录相同、位于 profile 内或包含 profile')
  }

  const existing = Array.isArray(input.existing) ? input.existing : []
  for (const record of existing) {
    if (record === null || typeof record !== 'object') continue
    if (input.ignoreKbId !== undefined && record.id === input.ignoreKbId) continue
    if (typeof record.sourceDir !== 'string' || record.sourceDir.trim() === '') continue
    const otherCmp = fold(await canonicalizePath(record.sourceDir))
    if (overlaps(otherCmp, sourceCmp)) {
      const label = typeof record.name === 'string' && record.name !== '' ? record.name : record.id
      return invalid(`sourceDir 与知识库 ${label} 的源目录相同或互为父子目录`)
    }
  }

  return { ok: true, realSourceDir }
}

/**
 * 校验知识库源目录绑定（规格 §5.2）：
 * - 拒绝空串、UNC / Windows 设备路径；
 * - `realpath` 后必须是可读目录；
 * - 拒绝与 `profileDir` 相同、为其子目录或为其祖先目录；
 * - 拒绝与其它已登记知识库源目录相同或互为父子（`ignoreKbId` 跳过自身）；
 * - 允许与已注册项目目录重叠。
 *
 * 只读探测，零副作用；任何非法输入都返回 `{ ok: false, reason }`，绝不抛出。
 */
export async function validateSourceDir(input: ValidateSourceDirInput): Promise<ValidateSourceDirResult> {
  try {
    return await validateSourceDirInner(input)
  } catch (error) {
    return invalid(`sourceDir 校验失败: ${errorMessage(error)}`)
  }
}
