/**
 * 知识库源目录绑定校验与卷大小写敏感性只读探测（规格 §5.2）。
 *
 * `validateSourceDir` 只做只读探测，零副作用，且对任何非法输入都返回
 * `{ ok: false, reason }` 而绝不抛出——路由层据此直接回传用户可读错误。
 */

import { R_OK } from 'node:constants'
import { access, lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

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
 * 判断字符串是否为 Windows UNC 共享或设备路径（`\\server\share`、`\\.\`、
 * `\\?\`）以及 POSIX 双斜杠形式。这类路径会触发对外凭据协商，一律拒绝。
 */
export function isUncOrDevicePath(rawPath: string): boolean {
  return /^\\\\/u.test(rawPath) || /^\/\//u.test(rawPath)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** 找到 basename 中首个 ASCII 字母并翻转其大小写；无 ASCII 字母时返回 null。 */
function toggleFirstAsciiLetter(name: string): string | null {
  const index = name.search(/[A-Za-z]/u)
  if (index < 0) return null
  const char = name.charAt(index)
  const toggled = char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()
  return `${name.slice(0, index)}${toggled}${name.slice(index + 1)}`
}

/**
 * 只读探测 `dirPath` 所在卷是否区分大小写：从该目录逐级向上找到第一个
 * basename 含 ASCII 字母的已存在目录，构造仅大小写不同的变体路径，比较
 * 变体与真实路径的 `(dev, ino)`。相同 → 不区分；`ENOENT` 或不同 → 区分。
 * 整条祖先链无 ASCII 字母或探测异常时，按 `platform === 'linux'` 保守回退。
 * 绝不创建、写入或删除任何文件。
 */
export async function probeCaseSensitiveDir(
  dirPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  try {
    let current = await realpath(dirPath)
    for (;;) {
      const variantName = toggleFirstAsciiLetter(basename(current))
      if (variantName !== null) {
        const variantPath = join(dirname(current), variantName)
        try {
          const original = await lstat(current, { bigint: true })
          const variant = await lstat(variantPath, { bigint: true })
          return !(variant.dev === original.dev && variant.ino === original.ino)
        } catch (error) {
          // 变体不存在说明大小写敏感；其它错误交给外层保守回退。
          if (errorCode(error) === 'ENOENT') return true
          throw error
        }
      }
      const parent = dirname(current)
      if (parent === current) break
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
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 两条规范化路径相同或互为祖先/子目录。 */
function overlaps(a: string, b: string): boolean {
  return isSameOrAncestor(a, b) || isSameOrAncestor(b, a)
}

/** 已存在时用 `realpath`，已不可用（被移动/删除）时回退 `resolve`。 */
async function canonicalizePath(rawPath: string): Promise<string> {
  try {
    return await realpath(rawPath)
  } catch {
    return resolve(rawPath)
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

  let realSourceDir: string
  try {
    realSourceDir = await realpath(rawSourceDir)
    const info = await stat(realSourceDir)
    if (!info.isDirectory()) return invalid('sourceDir 不是目录')
    await access(realSourceDir, R_OK)
  } catch (error) {
    return invalid(`sourceDir 不可访问: ${errorMessage(error)}`)
  }

  // 规范化大小写后比较：按源目录所在卷的实际大小写敏感性收窄（规格 §5.2）。
  const caseSensitive = await probeCaseSensitiveDir(realSourceDir, platform)
  const fold = caseSensitive ? (value: string): string => value : (value: string): string => value.toLowerCase()
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
