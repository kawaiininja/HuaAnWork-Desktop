/**
 * 知识库源文件安全只读校验链（规格 §5.3(1)）。
 *
 * 单用户本地威胁模型下的四步校验：
 * 1. 入口先 `realpath(sourceRoot)`，消除 macOS `/var` → `/private/var`、
 *    符号链接形式的源目录等差异；
 * 2. 从源根逐段 `lstat({ bigint: true })`，对符号链接 / Windows junction
 *    做 `realpath` 归属检查，并用 `${dev}:${ino}` 已访集合阻断目录环；
 * 3. 对目标再做一次 `realpath` 归属校验与 `lstat`（必须是普通文件），
 *    POSIX 上以 `O_RDONLY | O_NOFOLLOW` 打开；
 * 4. 对已打开的 `FileHandle` 复核 `(dev, ino)` 与 `size`，后续哈希与
 *    解析只消费这一个句柄，绝不按路径二次打开。
 *
 * 本文件会被 Worker / 测试以 `.ts` 源码直接加载（Node type-stripping），
 * 因此不得使用 `enum`、构造器参数属性或 `namespace`；纯类型导入必须写
 * `import type`，相对导入保留 `.ts` 后缀。
 */

import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'

import { MAX_FILE_BYTES } from './types.ts'

/** 公开的打开失败原因（M-17：包含 `symlink-loop`）。 */
export type SafeReadFailureReason =
  | 'symlink-outside-source'
  | 'symlink-loop'
  | 'not-regular-file'
  | 'file-too-large'
  | 'inode-replaced'
  | 'read-error'

export interface OpenVerifiedSourceFileOptions {
  /** 单文件字节上限，缺省 `MAX_FILE_BYTES`。 */
  readonly maxBytes?: number
  /**
   * 归属比较是否区分大小写。缺省按平台保守判断（Windows 不区分，其余
   * 区分）；调用方可用源卷探测结果覆盖。
   */
  readonly caseSensitive?: boolean
  /** 测试缝：在 pre-lstat 之后、`open()` 之前执行，用于模拟 TOCTOU 替换。 */
  readonly beforeOpenHook?: () => Promise<void> | void
}

export type OpenVerifiedSourceFileResult =
  | {
      readonly ok: true
      readonly handle: FileHandle
      readonly stat: BigIntStats
      readonly realPath: string
    }
  | {
      readonly ok: false
      readonly reason: SafeReadFailureReason
      readonly error?: string
    }

export type ReadAndHashHandleResult =
  | { readonly ok: true; readonly buffer: Buffer; readonly sha256: string }
  | { readonly ok: false; readonly reason: 'file-too-large' }

/** 目录遍历跳过条目的公开形状（M-17 钉死 `{ relPath, reason }`）。 */
export interface WalkSkippedEntry {
  readonly relPath: string
  readonly reason: SafeReadDirectorySkipReason
}

export type SafeReadDirectorySkipReason =
  | 'symlink-outside-source'
  | 'symlink-loop'
  | 'not-regular-file'
  | 'read-error'

/** 目录遍历产出的普通文件条目（对账用 size / mtimeMs）。 */
export interface WalkedSourceFile {
  readonly relPath: string
  readonly absPath: string
  readonly size: number
  readonly mtimeMs: number
}

export interface WalkSourceDirectoryOptions {
  /** 归属比较是否区分大小写，缺省按平台保守判断。 */
  readonly caseSensitive?: boolean
  /** 逐项忽略回调（对应规格 §6.1 的忽略清单，由同步引擎注入）。 */
  readonly shouldIgnore?: (relPath: string, name: string, isDir: boolean) => boolean
}

export interface WalkSourceDirectoryResult {
  readonly files: readonly WalkedSourceFile[]
  readonly skipped: readonly WalkSkippedEntry[]
}

const READ_CHUNK_BYTES = 64 * 1024
const O_NOFOLLOW = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function defaultCaseSensitive(): boolean {
  return process.platform !== 'win32'
}

function dirKey(info: BigIntStats): string {
  return `${info.dev.toString()}:${info.ino.toString()}`
}

/**
 * `target` 是否等于 `root` 或位于其下。两侧都应已是 `realpath` 结果；
 * 大小写不敏感的卷上允许调用方折叠大小写后比较。
 */
function isWithinRoot(root: string, target: string, caseSensitive: boolean): boolean {
  const fold = (value: string): string => (caseSensitive ? value : value.toLowerCase())
  const rel = relative(fold(root), fold(target))
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

function fileEntry(relPath: string, absPath: string, info: BigIntStats): WalkedSourceFile {
  return {
    relPath,
    absPath,
    size: Number(info.size),
    mtimeMs: Number(info.mtimeMs),
  }
}

interface SegmentCheckFailure {
  readonly ok: false
  readonly reason: 'symlink-outside-source' | 'symlink-loop'
}

/**
 * 从 `realSourceRoot` 沿候选路径的词法相对路径逐段 `lstat`：符号链接先做
 * 归属检查，再用目标的 `${dev}:${ino}` 查已访集合，命中即判定目录环。
 *
 * 相对段按调用方传入的 `lexicalSourceRoot`（未 `realpath` 的源根）计算，
 * 避免 macOS `/var` → `/private/var` 差异让所有候选路径都被当成词法越界
 * 而跳过环检。词法上确实越出源根的候选路径不逐段检查，留给 `realpath`
 * 归属校验统一处理。
 */
async function checkPathSegments(
  lexicalSourceRoot: string,
  realSourceRoot: string,
  candidatePath: string,
  caseSensitive: boolean,
): Promise<{ ok: true } | SegmentCheckFailure> {
  const rootResolved = resolve(realSourceRoot)
  const candidateResolved = resolve(candidatePath)
  const rel = relative(resolve(lexicalSourceRoot), candidateResolved)
  if (rel === '') return { ok: true }
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return { ok: true }

  const rootInfo = await lstat(rootResolved, { bigint: true })
  const visited = new Set<string>([dirKey(rootInfo)])
  let current = rootResolved
  for (const segment of rel.split(sep)) {
    if (segment === '') continue
    current = join(current, segment)
    const info = await lstat(current, { bigint: true })
    if (info.isSymbolicLink()) {
      const target = await realpath(current)
      if (!isWithinRoot(realSourceRoot, target, caseSensitive)) {
        return { ok: false, reason: 'symlink-outside-source' }
      }
      const targetInfo = await lstat(target, { bigint: true })
      if (targetInfo.isDirectory()) {
        const key = dirKey(targetInfo)
        if (visited.has(key)) return { ok: false, reason: 'symlink-loop' }
        visited.add(key)
      }
    } else if (info.isDirectory()) {
      // 普通目录无法形成环（目录不能硬链接），只记录以命中真实 junction 环。
      visited.add(dirKey(info))
    }
  }
  return { ok: true }
}

/** 数值选项收敛：非有限值（NaN / Infinity）回退到给定上限，绝不 fail-open。 */
function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value))
}

/**
 * 校验并只读打开源目录内的单个文件（规格 §5.3(1)）。
 *
 * 入口 `realpath` 源根；逐段 `lstat` + `${dev}:${ino}` 环检；目标
 * `realpath` 归属核验 → `lstat` 必须为普通文件；`beforeOpenHook` 测试缝；
 * `open(O_RDONLY | O_NOFOLLOW[POSIX])`；`handle.stat` 复核
 * `isFile() && dev && ino && size`。任何不匹配都 fail-closed 返回失败，
 * 绝不对失败路径保持打开的句柄。
 */
export async function openVerifiedSourceFile(
  sourceRoot: string,
  candidatePath: string,
  opts: OpenVerifiedSourceFileOptions = {},
): Promise<OpenVerifiedSourceFileResult> {
  const maxBytes = normalizeLimit(opts.maxBytes, MAX_FILE_BYTES)
  const caseSensitive = opts.caseSensitive ?? defaultCaseSensitive()
  let openedHandle: FileHandle | undefined
  try {
    const realSourceRoot = await realpath(sourceRoot)

    const segments = await checkPathSegments(sourceRoot, realSourceRoot, candidatePath, caseSensitive)
    if (!segments.ok) return segments

    const resolvedTarget = await realpath(candidatePath)
    if (!isWithinRoot(realSourceRoot, resolvedTarget, caseSensitive)) {
      return { ok: false, reason: 'symlink-outside-source' }
    }

    const preInfo = await lstat(resolvedTarget, { bigint: true })
    if (preInfo.isSymbolicLink() || !preInfo.isFile()) {
      return { ok: false, reason: 'not-regular-file' }
    }
    if (preInfo.size > BigInt(maxBytes)) {
      return { ok: false, reason: 'file-too-large' }
    }

    await opts.beforeOpenHook?.()

    openedHandle = await open(resolvedTarget, constants.O_RDONLY | O_NOFOLLOW)
    const stat = await openedHandle.stat({ bigint: true })
    if (!stat.isFile()) {
      await openedHandle.close()
      openedHandle = undefined
      return { ok: false, reason: 'not-regular-file' }
    }
    if (stat.size > BigInt(maxBytes)) {
      await openedHandle.close()
      openedHandle = undefined
      return { ok: false, reason: 'file-too-large' }
    }
    if (stat.dev !== preInfo.dev || stat.ino !== preInfo.ino) {
      await openedHandle.close()
      openedHandle = undefined
      return { ok: false, reason: 'inode-replaced' }
    }
    const handle = openedHandle
    openedHandle = undefined
    return { ok: true, handle, stat, realPath: resolvedTarget }
  } catch (error) {
    if (openedHandle !== undefined) {
      await openedHandle.close().catch(() => undefined)
    }
    const code = errorCode(error)
    if (code === 'ELOOP') return { ok: false, reason: 'symlink-loop', error: errorMessage(error) }
    return { ok: false, reason: 'read-error', error: errorMessage(error) }
  }
}

/**
 * 仅消费已校验的 `FileHandle` 分块读出全部字节并计算 SHA-256；一旦超过
 * `maxBytes` 立即中止（不再继续读盘），避免把超限文件读进堆。
 */
export async function readAndHashHandle(
  handle: FileHandle,
  maxBytes: number = MAX_FILE_BYTES,
): Promise<ReadAndHashHandleResult> {
  const budget = normalizeLimit(maxBytes, MAX_FILE_BYTES)
  const hash = createHash('sha256')
  const chunks: Buffer[] = []
  let total = 0
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    total += bytesRead
    if (total > budget) return { ok: false, reason: 'file-too-large' }
    const slice = buffer.subarray(0, bytesRead)
    hash.update(slice)
    chunks.push(Buffer.from(slice))
  }
  return { ok: true, buffer: Buffer.concat(chunks, total), sha256: hash.digest('hex') }
}

/**
 * 只读递归遍历源目录（规格 §5.3(1) / §6.1 对账前置）。
 *
 * 逐项 `lstat({ bigint: true })`：符号链接先 `realpath` 归属检查，目录
 * 目标的 `${dev}:${ino}` 与已访集合比较以阻断链接环 / junction 环；普通
 * 目录与文件按广度优先展开。忽略清单由 `shouldIgnore` 注入。
 * 源根不可读时返回一条 `relPath: ''` 的 `read-error` 跳过记录，绝不抛出。
 */
export async function walkSourceDirectory(
  sourceDir: string,
  opts: WalkSourceDirectoryOptions = {},
): Promise<WalkSourceDirectoryResult> {
  const files: WalkedSourceFile[] = []
  const skippedEntries: WalkSkippedEntry[] = []
  const caseSensitive = opts.caseSensitive ?? defaultCaseSensitive()

  let realRoot: string
  try {
    realRoot = await realpath(sourceDir)
  } catch {
    skippedEntries.push({ relPath: '', reason: 'read-error' })
    return { files, skipped: skippedEntries }
  }

  let rootInfo: BigIntStats
  try {
    rootInfo = await lstat(realRoot, { bigint: true })
  } catch {
    skippedEntries.push({ relPath: '', reason: 'read-error' })
    return { files, skipped: skippedEntries }
  }
  if (!rootInfo.isDirectory()) {
    skippedEntries.push({ relPath: '', reason: 'not-regular-file' })
    return { files, skipped: skippedEntries }
  }

  const visitedDirs = new Set<string>([dirKey(rootInfo)])
  const queue: Array<{ readonly absPath: string; readonly relPath: string }> = [
    { absPath: realRoot, relPath: '' },
  ]

  while (queue.length > 0) {
    const dir = queue.shift()
    if (dir === undefined) break
    let names: string[]
    try {
      names = await readdir(dir.absPath)
    } catch {
      skippedEntries.push({ relPath: dir.relPath, reason: 'read-error' })
      continue
    }
    names.sort()
    for (const name of names) {
      const absPath = join(dir.absPath, name)
      const relPath = dir.relPath === '' ? name : `${dir.relPath}/${name}`
      let info: BigIntStats
      try {
        info = await lstat(absPath, { bigint: true })
      } catch (error) {
        skippedEntries.push({
          relPath,
          reason: errorCode(error) === 'ELOOP' ? 'symlink-loop' : 'read-error',
        })
        continue
      }

      if (info.isSymbolicLink()) {
        let target: string
        try {
          target = await realpath(absPath)
        } catch (error) {
          skippedEntries.push({
            relPath,
            reason: errorCode(error) === 'ELOOP' ? 'symlink-loop' : 'read-error',
          })
          continue
        }
        if (!isWithinRoot(realRoot, target, caseSensitive)) {
          skippedEntries.push({ relPath, reason: 'symlink-outside-source' })
          continue
        }
        let targetInfo: BigIntStats
        try {
          targetInfo = await lstat(target, { bigint: true })
        } catch {
          skippedEntries.push({ relPath, reason: 'read-error' })
          continue
        }
        if (targetInfo.isDirectory()) {
          const key = dirKey(targetInfo)
          if (visitedDirs.has(key)) {
            skippedEntries.push({ relPath, reason: 'symlink-loop' })
            continue
          }
          if (opts.shouldIgnore?.(relPath, name, true) === true) continue
          visitedDirs.add(key)
          queue.push({ absPath, relPath })
          continue
        }
        if (targetInfo.isFile()) {
          if (opts.shouldIgnore?.(relPath, name, false) === true) continue
          files.push(fileEntry(relPath, absPath, targetInfo))
          continue
        }
        skippedEntries.push({ relPath, reason: 'not-regular-file' })
        continue
      }

      if (info.isDirectory()) {
        if (opts.shouldIgnore?.(relPath, name, true) === true) continue
        queue.push({ absPath, relPath })
        continue
      }
      if (info.isFile()) {
        if (opts.shouldIgnore?.(relPath, name, false) === true) continue
        files.push(fileEntry(relPath, absPath, info))
        continue
      }
      skippedEntries.push({ relPath, reason: 'not-regular-file' })
    }
  }

  return { files, skipped: skippedEntries }
}
