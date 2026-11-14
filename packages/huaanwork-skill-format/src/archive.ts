/**
 * Safe `.tar.gz` skill archive shared by the desktop Host and the intranet
 * skill catalog.
 *
 * Shape: the archive root contains `SKILL.md` directly plus any resources
 * (`scripts/`, references, assets). A skill archive carries no manifest,
 * signature, or keyring: the digest proves byte equality for idempotency and
 * integrity, never authorship or review.
 *
 * Safety model (mirrors the verified agent-package reader):
 *
 * - only regular files and directories; symlinks, hard links, devices, FIFOs
 *   and unknown tar typeflags are rejected;
 * - relative POSIX paths only: no absolute paths, `..`, backslashes, drive
 *   prefixes, NUL or ASCII control characters, duplicates, or file/directory
 *   conflicts. Paths are bounded by UTF-8 bytes, not by alphabet, so any other
 *   Unicode text (CJK resource names included) is a valid segment;
 * - the gzip output is metered before tar parses it, and nested
 *   gzip/zstd payloads are rejected before node-tar can decompress them
 *   outside that meter;
 * - gzip bytes, summed file bytes, entry count, and path length each have a
 *   fixed budget.
 *
 * @module archive
 */

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { createGunzip } from 'node:zlib'

import { c as createArchive, t as listArchive } from 'tar'
import type { Pack, Parser, ReadEntry } from 'tar'

import { SKILL_NAME_RE, parseSkillMarkdown } from './markdown.ts'
import type { ParsedSkillMarkdown } from './markdown.ts'

/** Compressed archive cap. */
export const MAX_SKILL_ARCHIVE_BYTES = 5 * 1024 * 1024
/** Summed file-content cap (uncompressed). */
export const MAX_SKILL_ARCHIVE_CONTENT_BYTES = 5 * 1024 * 1024
/** File plus directory entry cap. */
export const MAX_SKILL_ENTRIES = 256
/** UTF-8 byte cap for one normalized entry path. */
export const MAX_SKILL_PATH_BYTES = 512

/** Existing SKILL.md body budget (matches the Host write path). */
const MAX_SKILL_MARKDOWN_BYTES = 64 * 1024
/** Existing description budget (matches the Host write path). */
const MAX_SKILL_DESCRIPTION_CHARS = 1024
/** Existing skill-name length budget. */
const MAX_SKILL_NAME_CHARS = 64

/**
 * Gunzip output cap: the content budget plus per-entry header/padding slack and
 * the two EOF blocks. Directory headers (whose declared body node-tar drops)
 * and in-budget PAX headers are counted here, so the sum can never exceed the
 * documented content budget without being detected.
 */
const MAX_UNPACKED_BYTES = MAX_SKILL_ARCHIVE_CONTENT_BYTES + MAX_SKILL_ENTRIES * 1024 + 1024

/** A single PAX/global extension header body cap; skill paths are far smaller. */
const MAX_META_BYTES = 64 * 1024

const SKILL_MARKDOWN_PATH = 'SKILL.md'

/**
 * Paths are bounded by UTF-8 bytes, not by alphabet: CJK resource names such as
 * `参考资料.md` are legitimate. Only ASCII control characters are forbidden;
 * the structural rules (absolute paths, `..`, backslashes, drive prefixes,
 * duplicates, conflicts, links) are enforced separately.
 */
const ASCII_CONTROL_RE = /[\u0000-\u001f\u007f]/u
const DRIVE_PREFIX_RE = /^[A-Za-z]:/u
const RESERVED_SEGMENT_PREFIXES = ['.tmp-', '.old-', '.install-'] as const

/**
 * Compression magic node-tar would sniff and decompress on its own. The inner
 * layer would run after this module's meter, so the prefix is rejected.
 */
const NESTED_COMPRESSION_MAGIC = [
  Buffer.from([0x1f, 0x8b]),
  Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
] as const
const NESTED_COMPRESSION_PREFIX_BYTES = Math.max(
  ...NESTED_COMPRESSION_MAGIC.map((magic) => magic.byteLength),
)

export type SkillArchiveFile = { path: string; data: Buffer }

export type InspectedSkillArchive = {
  name: string
  description: string
  whenToUse?: string
  files: SkillArchiveFile[]
  digest: string
  skillMarkdown: string
}

type UnpackedArchive = {
  files: SkillArchiveFile[]
  directories: string[]
}

/**
 * Canonical SHA-256 over `{ schemaVersion: 1, files: [{ path, size, sha256 }] }`
 * with rows sorted by path. Returned as `sha256:<64 hex>`.
 */
export function createSkillDigest(files: readonly SkillArchiveFile[]): string {
  const rows = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({
      path: file.path,
      size: file.data.byteLength,
      sha256: createHash('sha256').update(file.data).digest('hex'),
    }))
  const digest = createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, files: rows }), 'utf8')
    .digest('hex')
  return `sha256:${digest}`
}

/**
 * Read a skill directory into archive files, sorted by path.
 *
 * Links are rejected rather than followed, so reading cannot pull files from
 * outside the skill root. Hidden files are ordinary resources; the caller's
 * budgets reject anything oversized.
 */
export function readSkillDirectory(root: string): SkillArchiveFile[] {
  const rootPath = resolve(root)
  const files: SkillArchiveFile[] = []
  let entries = 0
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort((a, b) => a.localeCompare(b))) {
      const full = join(directory, name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) throw archiveError(`不允许符号链接：${name}`)
      entries += 1
      if (entries > MAX_SKILL_ENTRIES) throw archiveError(`条目数超过${MAX_SKILL_ENTRIES}`)
      if (stat.isDirectory()) {
        walk(full)
        continue
      }
      if (!stat.isFile()) throw archiveError('只允许普通文件与目录')
      if (stat.nlink > 1) throw archiveError(`不允许硬链接：${name}`)
      const path = normalizeEntryPath(relative(rootPath, full).split(sep).join('/'), 'file')
      files.push({ path, data: readFileSync(full) })
    }
  }
  walk(rootPath)
  return files.sort(byPath)
}

/**
 * Write a validated file set under `root`, creating parent directories.
 *
 * Existing symlinks (on the target or any parent) and hard-linked targets are
 * rejected so a write can never escape the root or mutate a second path.
 */
export async function writeSkillDirectory(root: string, files: readonly SkillArchiveFile[]): Promise<void> {
  const validated = validateSkillFiles(files)
  const rootPath = resolve(root)
  mkdirSync(rootPath, { recursive: true })
  for (const file of validated) {
    assertContainedPath(rootPath, file.path)
    assertNoSymlinkedParents(rootPath, file.path)
    const target = resolve(rootPath, file.path)
    assertWritableTarget(target)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.data)
  }
}

/**
 * Pack a validated file set into a portable, deterministic `.tar.gz`.
 *
 * Rejects the same structural problems as inspection and both budgets before
 * writing anything; the compressed output is capped while it streams.
 */
export async function buildSkillArchive(files: readonly SkillArchiveFile[]): Promise<Buffer> {
  const validated = validateSkillFiles(files)
  const staging = mkdtempSync(join(tmpdir(), 'huaanwork-skill-archive-'))
  try {
    await writeSkillDirectory(staging, validated)
    const stream = createArchive(
      { cwd: staging, gzip: true, portable: true, noMtime: true },
      validated.map((file) => file.path),
    )
    return await collectCapped(stream)
  } catch (error) {
    throw toArchiveError(error, '打包失败')
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {
      // Cleanup must not replace the archive result or leak the staging path.
    }
  }
}

/**
 * Inspect a `.tar.gz` skill archive.
 *
 * Returns the parsed SKILL.md metadata, the sorted content files (excluding
 * explicit directory entries), the canonical digest, and the raw SKILL.md text.
 * When `expectedName` is provided the frontmatter name must equal it.
 */
export async function inspectSkillArchive(
  bundle: Buffer,
  expectedName?: string,
): Promise<InspectedSkillArchive> {
  const archive = await unpackCapped(bundle)
  const markdown = archive.files.find((file) => file.path === SKILL_MARKDOWN_PATH)
  if (markdown === undefined) throw archiveError('缺少 SKILL.md')
  const skillMarkdown = markdown.data.toString('utf8')
  const parsed = parseSkillMarkdown(skillMarkdown)
  assertSkillMetadata(parsed, expectedName)
  const files = archive.files.sort(byPath)
  return {
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
    files,
    digest: createSkillDigest(files),
    skillMarkdown,
  }
}

function byPath(a: SkillArchiveFile, b: SkillArchiveFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

/**
 * Normalize and validate a build/inspect file set: paths, duplicates,
 * file/directory conflicts, entry and content budgets, and the root SKILL.md.
 */
function validateSkillFiles(files: readonly SkillArchiveFile[]): SkillArchiveFile[] {
  const seen = new Set<string>()
  const normalized: SkillArchiveFile[] = []
  for (const file of files) {
    const path = normalizeEntryPath(file.path, 'file')
    if (seen.has(path)) throw archiveError('重复条目')
    seen.add(path)
    normalized.push({ path, data: file.data })
  }
  if (normalized.length === 0) throw archiveError('归档为空')
  // Count the installed layout, not just explicit archive entries: implicit
  // parent directories are enumerated on disk too.
  if (countEntries(normalized.map((file) => file.path)) > MAX_SKILL_ENTRIES) {
    throw archiveError(`条目数超过${MAX_SKILL_ENTRIES}`)
  }
  assertNoFileAncestors(normalized.map((file) => file.path), seen)
  const totalBytes = normalized.reduce((sum, file) => sum + file.data.byteLength, 0)
  if (totalBytes > MAX_SKILL_ARCHIVE_CONTENT_BYTES) throw contentTooLargeError()
  const markdown = normalized.find((file) => file.path === SKILL_MARKDOWN_PATH)
  if (markdown === undefined) throw archiveError('缺少 SKILL.md')
  assertSkillMetadata(parseSkillMarkdown(markdown.data.toString('utf8')))
  return normalized.sort(byPath)
}

function assertSkillMetadata(parsed: ParsedSkillMarkdown, expectedName?: string): void {
  if (parsed.name.length === 0 || parsed.name.length > MAX_SKILL_NAME_CHARS || !SKILL_NAME_RE.test(parsed.name)) {
    throw archiveError('SKILL.md 名称非法')
  }
  if (expectedName !== undefined && expectedName !== parsed.name) {
    throw archiveError('SKILL.md 名称不一致')
  }
  if (parsed.description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    throw archiveError(`描述超过${MAX_SKILL_DESCRIPTION_CHARS}字符`)
  }
  if (Buffer.byteLength(parsed.content, 'utf8') > MAX_SKILL_MARKDOWN_BYTES) {
    throw archiveError(`正文超过${MAX_SKILL_MARKDOWN_BYTES}字节`)
  }
}

/** Reject any path whose ancestor is a regular file in the same set. */
function assertNoFileAncestors(paths: readonly string[], filePaths: ReadonlySet<string>): void {
  for (const path of paths) {
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      if (filePaths.has(segments.slice(0, index).join('/'))) {
        throw archiveError('目录与文件冲突')
      }
    }
  }
}

/**
 * Installed entry count: each file/directory plus every unique implicit parent
 * directory. An archive can omit directory headers while extraction still
 * creates those parents, so both sides charge the same layout.
 */
function countEntries(paths: Iterable<string>): number {
  const entries = new Set<string>()
  for (const path of paths) {
    const segments = path.split('/')
    for (let index = 1; index <= segments.length; index += 1) {
      entries.add(segments.slice(0, index).join('/'))
    }
  }
  return entries.size
}

/**
 * Normalize one entry path.
 *
 * Directory entries use a trailing `/` by tar convention; exactly one is
 * removed before checking for empty segments.
 */
function normalizeEntryPath(rawPath: string, kind: 'file' | 'directory'): string {
  let path = rawPath
  while (path.startsWith('./')) path = path.slice(2)
  if (kind === 'directory' && path.endsWith('/')) path = path.slice(0, -1)
  if (path === '') throw archiveError('路径为空')
  if (path.startsWith('/')) throw archiveError('路径必须是相对路径')
  if (DRIVE_PREFIX_RE.test(path)) throw archiveError('路径不得包含盘符')
  if (path.includes('\\')) throw archiveError('路径不得包含反斜杠')
  if (path.includes('\0')) throw archiveError('路径不得包含 NUL')
  if (ASCII_CONTROL_RE.test(path)) throw archiveError('路径包含控制字符')
  // An unpaired surrogate has no UTF-8 encoding: it would be replaced with
  // U+FFFD on disk and in tar headers, silently changing the name (and with it
  // the digest) between build and inspect.
  if (Buffer.from(path, 'utf8').toString('utf8') !== path) {
    throw archiveError('路径不是合法的 Unicode 文本')
  }

  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw archiveError('路径不得包含 . 或 .. 段')
  }
  if (segments.some((segment) => RESERVED_SEGMENT_PREFIXES.some((prefix) => segment.startsWith(prefix)))) {
    throw archiveError('路径使用了保留前缀')
  }
  if (Buffer.byteLength(path, 'utf8') > MAX_SKILL_PATH_BYTES) {
    throw archiveError(`路径超过${MAX_SKILL_PATH_BYTES}字节`)
  }
  return path
}

function assertContainedPath(rootPath: string, path: string): void {
  const target = resolve(rootPath, path)
  if (target === rootPath || !target.startsWith(rootPath + sep)) {
    throw archiveError('路径逃逸出技能目录')
  }
}

/** Refuse to write through an existing symlink or non-directory parent. */
function assertNoSymlinkedParents(rootPath: string, path: string): void {
  const segments = path.split('/')
  let current = rootPath
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment)
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (stat.isSymbolicLink()) throw archiveError(`不允许符号链接：${segment}`)
    if (!stat.isDirectory()) throw archiveError('目录与文件冲突')
  }
}

/** Refuse to overwrite a symlink, non-file, or hard-linked target. */
function assertWritableTarget(target: string): void {
  let stat
  try {
    stat = lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) throw archiveError('不允许符号链接')
  if (!stat.isFile()) throw archiveError('目录与文件冲突')
  if (stat.nlink > 1) throw archiveError('不允许硬链接')
}

/**
 * Stream the archive through gunzip into memory.
 *
 * The meter sits before tar: it caps the gunzip output and inspects the first
 * bytes for nested compression. tar itself only sees plain tar bytes.
 */
function unpackCapped(bundle: Buffer): Promise<UnpackedArchive> {
  if (bundle.byteLength > MAX_SKILL_ARCHIVE_BYTES) {
    return Promise.reject(archiveTooLargeError())
  }

  return new Promise((resolvePromise, reject) => {
    const files: SkillArchiveFile[] = []
    const directories: string[] = []
    const entryTypes = new Map<string, 'file' | 'directory'>()
    let entries = 0
    let declaredBytes = 0
    let settled = false
    let parser: Parser | undefined

    const source = Readable.from([bundle])
    const gunzip = createGunzip()
    let unpackedBytes = 0
    let prefixChunks: Buffer[] = []
    let prefixBytes = 0
    let prefixChecked = false
    const emitPrefix = (callback: (error?: Error | null, data?: Buffer) => void) => {
      const prefix = Buffer.concat(prefixChunks, prefixBytes)
      prefixChunks = []
      prefixBytes = 0
      prefixChecked = true
      if (hasNestedCompressionMagic(prefix)) {
        callback(archiveError('不支持嵌套压缩'))
        return
      }
      if (prefix.byteLength === 0) callback()
      else callback(null, prefix)
    }
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        unpackedBytes += chunk.byteLength
        if (unpackedBytes > MAX_UNPACKED_BYTES) {
          callback(archiveTooLargeError())
          return
        }
        if (prefixChecked) {
          callback(null, chunk)
          return
        }
        prefixChunks.push(chunk)
        prefixBytes += chunk.byteLength
        if (prefixBytes < NESTED_COMPRESSION_PREFIX_BYTES) {
          callback()
          return
        }
        emitPrefix(callback)
      },
      flush(callback) {
        if (prefixChecked) callback()
        else emitPrefix(callback)
      },
    })

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      source.destroy()
      gunzip.destroy()
      meter.destroy()
      parser?.abort(error)
      reject(error)
    }

    const onentry = (entry: ReadEntry) => {
      if (settled) return
      entries += 1
      if (entries > MAX_SKILL_ENTRIES) {
        fail(archiveError(`条目数超过${MAX_SKILL_ENTRIES}`))
        return
      }
      if (entry.type !== 'File' && entry.type !== 'Directory') {
        fail(archiveError('只允许普通文件与目录'))
        return
      }

      // tar normalizes `entry.path` on win32 before this callback; validate the
      // raw header path (PAX-overridden) so a backslash is rejected everywhere.
      const rawHeaderPath = (entry as { header?: { path?: unknown } }).header?.path
      if (typeof rawHeaderPath === 'string') {
        if (rawHeaderPath.includes('\\')) {
          fail(archiveError('路径不得包含反斜杠'))
          return
        }
        if (rawHeaderPath.includes('\0')) {
          fail(archiveError('路径不得包含 NUL'))
          return
        }
      }

      let path: string
      try {
        path = normalizeEntryPath(entry.path, entry.type === 'Directory' ? 'directory' : 'file')
      } catch (error) {
        fail(error instanceof Error ? error : archiveError('路径非法'))
        return
      }

      if (entryTypes.has(path)) {
        fail(archiveError('重复条目'))
        return
      }

      declaredBytes += entry.size
      if (declaredBytes > MAX_SKILL_ARCHIVE_CONTENT_BYTES) {
        fail(contentTooLargeError())
        return
      }

      if (entry.type === 'Directory') {
        entryTypes.set(path, 'directory')
        directories.push(path)
        return
      }

      entryTypes.set(path, 'file')

      const chunks: Buffer[] = []
      let actualBytes = 0
      entry.on('data', (chunk: Buffer) => {
        if (settled) return
        actualBytes += chunk.byteLength
        if (actualBytes > entry.size) {
          fail(archiveError('归档条目大小不一致'))
          return
        }
        chunks.push(chunk)
      })
      entry.on('end', () => {
        if (settled) return
        if (actualBytes !== entry.size) {
          fail(archiveError('归档条目被截断'))
          return
        }
        files.push({ path, data: Buffer.concat(chunks, actualBytes) })
      })
      entry.on('error', () => fail(archiveError('归档条目无法读取')))
    }

    parser = listArchive({
      gzip: false,
      // node-tar still sniffs gzip (it cannot be disabled); turn off zstd and
      // brotli so the magic check is the only decompression gate.
      zstd: false,
      brotli: false,
      strict: true,
      maxMetaEntrySize: MAX_META_BYTES,
      onentry,
    }) as Parser
    // Unknown typeflags arrive as `ignoredEntry`, never as `onentry`.
    parser.on('ignoredEntry', () => fail(archiveError('归档包含未知或不支持的条目')))
    parser.on('warn', (_code, message) => fail(archiveError(`归档解析警告：${String(message)}`)))
    parser.on('error', () => fail(archiveError('归档无法解析')))
    parser.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolvePromise(finalizeArchive(files, directories))
      } catch (error) {
        reject(error instanceof Error ? error : archiveError('归档无法解析'))
      }
    })
    source.on('error', () => fail(archiveError('归档无法读取')))
    gunzip.on('error', () => fail(archiveError('归档无法解析')))
    meter.on('error', (error: Error) => fail(toArchiveError(error, '归档无法解析')))
    source.pipe(gunzip).pipe(meter).pipe(parser)
  })
}

function finalizeArchive(files: SkillArchiveFile[], directories: string[]): UnpackedArchive {
  if (files.length === 0) throw archiveError('归档为空')
  assertNoFileAncestors(
    [...files.map((file) => file.path), ...directories],
    new Set(files.map((file) => file.path)),
  )
  if (countEntries([...files.map((file) => file.path), ...directories]) > MAX_SKILL_ENTRIES) {
    throw archiveError(`条目数超过${MAX_SKILL_ENTRIES}`)
  }
  return { files, directories }
}

/** The first gunzip bytes are a compression format node-tar would decompress again. */
function hasNestedCompressionMagic(prefix: Buffer): boolean {
  return NESTED_COMPRESSION_MAGIC.some(
    (magic) =>
      prefix.byteLength >= magic.byteLength && prefix.subarray(0, magic.byteLength).equals(magic),
  )
}

/** Collect a pack stream, destroying it as soon as the compressed cap is crossed. */
function collectCapped(stream: Pack): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      stream.destroy()
      reject(error)
    }

    stream.on('data', (chunk: Buffer) => {
      if (settled) return
      total += chunk.byteLength
      if (total > MAX_SKILL_ARCHIVE_BYTES) {
        fail(archiveTooLargeError())
        return
      }
      chunks.push(chunk)
    })
    stream.on('error', () => fail(archiveError('打包失败')))
    stream.on('end', () => {
      if (settled) return
      settled = true
      resolvePromise(Buffer.concat(chunks, total))
    })
  })
}

function toArchiveError(error: unknown, fallback: string): Error {
  if (error instanceof Error && error.message.startsWith('技能归档非法：')) return error
  return archiveError(fallback)
}

function archiveError(message: string): Error {
  return new Error(`技能归档非法：${message}`)
}

/** Shared by the compressed cap, the unpacked meter, and the content budget. */
function archiveTooLargeError(): Error {
  return archiveError(`技能归档超过${MAX_SKILL_ARCHIVE_BYTES}字节上限`)
}

function contentTooLargeError(): Error {
  return archiveError(`文件内容超过${MAX_SKILL_ARCHIVE_CONTENT_BYTES}字节上限`)
}
