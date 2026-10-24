import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { createGunzip } from 'node:zlib'

import { canonicalJson, verifyAgentPackageDigestSignature } from '@huaanwork/catalog-signing'
import type { CatalogKeyringEntry, CatalogSignature } from '@huaanwork/catalog-signing'
import { c as createArchive, t as listArchive } from 'tar'
import type { Pack, Parser, ReadEntry } from 'tar'

import {
  MAX_AGENT_PACKAGE_ENTRIES,
  MAX_AGENT_PACKAGE_PATH_BYTES,
  createAgentPackageDigest,
  validateAgentPackageFiles,
  verifyAgentPackageDigest,
} from './digest.ts'
import type { AgentPackageDigest, AgentPackageFile } from './digest.ts'
import type { AgentPackageManifest } from './manifest.ts'

/** 单个 bundle(压缩后)与解包后文件总量的共同上限。 */
export const MAX_AGENT_PACKAGE_BUNDLE_BYTES = 5 * 1024 * 1024

/**
 * 解压后归档总量上限:内容预算 + 每条 512 字节头与最多 511 字节填充 + 两个 EOF 块。
 *
 * 这是内容预算之外唯一允许出现的字节;超过它就意味着文件内容必然顶破
 * {@link MAX_AGENT_PACKAGE_BUNDLE_BYTES},因此共用同一句错误文案。它同时兜住
 * 了不进入 `onentry` 的 body:目录头声明的 body(node-tar 会把目录 size 归零,
 * 那些字节被当作后续块读掉)、PAX/global 扩展头,以及 tar 未知类型的条目。
 *
 * PAX 头与条目头共用这份按条目计的余量:路径全部顶到 512 字节、内容又顶到
 * 5 MiB 的病态包会被保守地判超帽,普通包(两条头之和不到 2 KiB/条)不受影响。
 */
const MAX_AGENT_PACKAGE_UNPACKED_BYTES =
  MAX_AGENT_PACKAGE_BUNDLE_BYTES + MAX_AGENT_PACKAGE_ENTRIES * 1024 + 1024

/**
 * 单个 PAX/global 扩展头正文上限。
 *
 * 门限内的 meta 正文会整块进内存;包的路径上限是 512 字节,PAX 头所需远小于
 * 64 KiB。超过门限的 meta 条目被 tar 丢弃,其 body 仍由解压总量 meter 计数。
 */
const MAX_AGENT_PACKAGE_META_BYTES = 64 * 1024

const SIGNATURE_DIR = '.signature'
const DIGEST_PATH = `${SIGNATURE_DIR}/package-digest.json`
const SIGNATURE_PATH = `${SIGNATURE_DIR}/signature.json`
const SIGNATURE_FILES = new Set([DIGEST_PATH, SIGNATURE_PATH])

/** 验签/digest 失败时唯一对外文案:不区分缺文件、篡改或签名不符。 */
const BUNDLE_VERIFY_FAILURE = '包校验失败，未安装或未运行。请联系管理员'

const PACKAGE_PATH_RE = /^[A-Za-z0-9._/-]+$/
const DRIVE_PREFIX_RE = /^[A-Za-z]:/
const RESERVED_SEGMENT_PREFIXES = ['.tmp-', '.old-', '.install-'] as const

export type UnsignedAgentPackageInspection = {
  manifest: AgentPackageManifest
  files: AgentPackageFile[]
  digest: AgentPackageDigest
}

export type SignedAgentPackageInspection = UnsignedAgentPackageInspection & {
  signature: CatalogSignature
}

type UnpackedArchive = {
  files: AgentPackageFile[]
  directories: string[]
}

/**
 * 把同一批文件打成 unsigned `.tar.gz`。
 *
 * 内容先写入私有 staging 目录,由 `tar` 流式打包;整个过程不返回流,只在压缩
 * 输出完整且不超过 {@link MAX_AGENT_PACKAGE_BUNDLE_BYTES} 时 resolve。任何
 * 结构问题都抛 `包结构非法`,不把 staging 路径或文件内容带进错误。
 */
export async function buildUnsignedAgentPackageBundle(files: AgentPackageFile[]): Promise<Buffer> {
  return packArchive(files, false)
}

/**
 * 在 unsigned 内容之外追加 `.signature/package-digest.json`(canonical JSON
 * 的 UTF-8 字节)与 `.signature/signature.json`(`JSON.stringify`)后打包。
 */
export async function buildSignedAgentPackageBundle(
  files: AgentPackageFile[],
  digest: AgentPackageDigest,
  signature: CatalogSignature,
): Promise<Buffer> {
  return packArchive(
    [
      ...files,
      { path: DIGEST_PATH, data: Buffer.from(encodeCanonicalDocument(digest), 'utf8') },
      { path: SIGNATURE_PATH, data: Buffer.from(encodeSignatureDocument(signature), 'utf8') },
    ],
    true,
  )
}

/**
 * 解包并检查一个 unsigned bundle。
 *
 * 只接受普通文件与目录,任何签名目录内容都拒绝;返回的 digest 由包内文件
 * 重新计算,调用方不得相信提交方自报的 digest。
 */
export async function inspectUnsignedAgentPackageBundle(
  bundle: Buffer,
): Promise<UnsignedAgentPackageInspection> {
  const archive = await unpackCapped(bundle)
  if ([...archive.files.map((file) => file.path), ...archive.directories].some(isSignaturePath)) {
    throw structureError('提交包不得包含签名')
  }
  const manifest = validateAgentPackageFiles(archive.files)
  return {
    manifest,
    files: archive.files,
    digest: createAgentPackageDigest(manifest, archive.files),
  }
}

/**
 * 解包并验证一个 signed bundle。
 *
 * 只允许内容文件外加 `.signature/package-digest.json` 与
 * `.signature/signature.json`;签名文件不进入返回的 `files` 与 `digest`。
 * 先逐文件复算 digest,再用 keyring 验签;两类失败都收敛为同一句对外文案。
 */
export async function inspectSignedAgentPackageBundle(
  bundle: Buffer,
  keyring: readonly CatalogKeyringEntry[],
  now?: number,
): Promise<SignedAgentPackageInspection> {
  const archive = await unpackCapped(bundle)
  for (const directory of archive.directories) {
    // 显式 `.signature/` 目录条目只是签名文件的父目录,不是额外内容;
    // 它下面的任何其他目录(以及任何其他签名文件)仍然拒绝。
    if (isSignaturePath(directory) && directory !== SIGNATURE_DIR) {
      throw structureError('不接受额外的签名目录内容')
    }
  }

  const content: AgentPackageFile[] = []
  let digestFile: AgentPackageFile | undefined
  let signatureFile: AgentPackageFile | undefined
  for (const file of archive.files) {
    if (file.path === DIGEST_PATH) {
      digestFile = file
      continue
    }
    if (file.path === SIGNATURE_PATH) {
      signatureFile = file
      continue
    }
    if (isSignaturePath(file.path)) throw structureError('不接受额外的签名目录内容')
    content.push(file)
  }
  if (digestFile === undefined || signatureFile === undefined) {
    throw structureError('缺少签名文件')
  }

  const manifest = validateAgentPackageFiles(content)

  let digest: AgentPackageDigest
  let signature: CatalogSignature
  try {
    const parsedDigest = JSON.parse(digestFile.data.toString('utf8')) as unknown
    const parsedSignature = JSON.parse(signatureFile.data.toString('utf8')) as unknown
    verifyAgentPackageDigest(manifest, content, parsedDigest)
    const verdict = now === undefined
      ? verifyAgentPackageDigestSignature(parsedDigest, parsedSignature, keyring)
      : verifyAgentPackageDigestSignature(parsedDigest, parsedSignature, keyring, now)
    if (!verdict.ok) throw new Error('signature rejected')
    digest = parsedDigest as AgentPackageDigest
    signature = parsedSignature as CatalogSignature
  } catch {
    throw new Error(BUNDLE_VERIFY_FAILURE)
  }

  return { manifest, files: content, digest, signature }
}

async function packArchive(input: AgentPackageFile[], allowSignatureFiles: boolean): Promise<Buffer> {
  const files = normalizeBuildFiles(input, allowSignatureFiles)
  const totalBytes = files.reduce((sum, file) => sum + file.data.byteLength, 0)
  if (totalBytes > MAX_AGENT_PACKAGE_BUNDLE_BYTES) {
    throw packageTooLargeError()
  }

  const staging = mkdtempSync(join(tmpdir(), 'huaanwork-agent-package-'))
  try {
    const paths: string[] = []
    for (const file of files) {
      const target = join(staging, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.data)
      paths.push(file.path)
    }
    const stream = createArchive({ cwd: staging, gzip: true, portable: true, noMtime: true }, paths)
    return await collectCapped(stream)
  } catch (error) {
    throw toStructureError(error, '打包失败')
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {
      // 清理失败不得覆盖打包结果或把 staging 绝对路径带进错误。
    }
  }
}

/**
 * 归一化并校验待打包路径。
 *
 * 打包输入虽由本地流程生成,仍在写 staging 前套用与解包相同的路径规则,
 * 避免把绝对路径、`..` 或反斜杠写进归档。
 */
function normalizeBuildFiles(
  files: AgentPackageFile[],
  allowSignatureFiles: boolean,
): AgentPackageFile[] {
  const seen = new Set<string>()
  const normalized: AgentPackageFile[] = []
  for (const file of files) {
    const path = normalizeEntryPath(file.path, 'file')
    if (isSignaturePath(path) && !(allowSignatureFiles && SIGNATURE_FILES.has(path))) {
      throw structureError('提交包不得包含签名')
    }
    if (seen.has(path)) throw structureError('重复条目')
    seen.add(path)
    normalized.push({ path, data: file.data })
  }
  if (normalized.length === 0) throw structureError('归档为空')
  if (normalized.length > MAX_AGENT_PACKAGE_ENTRIES) {
    throw structureError(`条目数超过${MAX_AGENT_PACKAGE_ENTRIES}`)
  }
  assertNoFileAncestors(
    normalized.map((file) => file.path),
    new Set(normalized.map((file) => file.path)),
  )
  return normalized.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * 流式解包到内存。
 *
 * 解压由本模块自己完成:gzip 输出先过一道计量 `Transform`,解压总量超过
 * {@link MAX_AGENT_PACKAGE_UNPACKED_BYTES} 立刻中止。这道计量兜住了所有不会
 * 经过 `onentry` 的字节(目录头声明的 body、PAX/global 扩展头、tar 未知类型),
 * 因为 tar 只把 File/Directory 送进 `onentry`,而目录头的 size 会被 tar 归零。
 *
 * `onentry` 先把条目计数加一并在超帽时立即中止,再检查路径、按声明大小预扣
 * 内容预算;每个文件只在条目 `end` 后进入结果数组,因此超帽归档不会保留第
 * 1025 条及之后的内容。
 */
function unpackCapped(bundle: Buffer): Promise<UnpackedArchive> {
  if (bundle.byteLength > MAX_AGENT_PACKAGE_BUNDLE_BYTES) {
    return Promise.reject(packageTooLargeError())
  }

  return new Promise((resolve, reject) => {
    const files: AgentPackageFile[] = []
    const directories: string[] = []
    const entryTypes = new Map<string, 'file' | 'directory'>()
    let entries = 0
    let declaredBytes = 0
    let settled = false
    let parser: Parser | undefined

    const source = Readable.from([bundle])
    const gunzip = createGunzip()
    let unpackedBytes = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        unpackedBytes += chunk.byteLength
        if (unpackedBytes > MAX_AGENT_PACKAGE_UNPACKED_BYTES) {
          callback(packageTooLargeError())
          return
        }
        callback(null, chunk)
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
      if (entries > MAX_AGENT_PACKAGE_ENTRIES) {
        fail(structureError(`条目数超过${MAX_AGENT_PACKAGE_ENTRIES}`))
        return
      }
      if (entry.type !== 'File' && entry.type !== 'Directory') {
        fail(structureError('只允许普通文件与目录'))
        return
      }

      let path: string
      try {
        path = normalizeEntryPath(entry.path, entry.type === 'Directory' ? 'directory' : 'file')
      } catch (error) {
        fail(error instanceof Error ? error : structureError('路径非法'))
        return
      }

      if (entryTypes.has(path)) {
        fail(structureError('重复条目'))
        return
      }

      // 每个条目的声明大小都预扣内容预算——包括目录条目:tar 头里的 size 字段
      // 对它同样有意义,不能因为目录通常没有 body 就跳过记账。
      declaredBytes += entry.size
      if (declaredBytes > MAX_AGENT_PACKAGE_BUNDLE_BYTES) {
        fail(packageTooLargeError())
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
          fail(structureError('归档条目大小不一致'))
          return
        }
        chunks.push(chunk)
      })
      entry.on('end', () => {
        if (settled) return
        if (actualBytes !== entry.size) {
          fail(structureError('归档条目被截断'))
          return
        }
        files.push({ path, data: Buffer.concat(chunks, actualBytes) })
      })
      entry.on('error', () => fail(structureError('归档条目无法读取')))
    }

    parser = listArchive({
      gzip: false,
      maxMetaEntrySize: MAX_AGENT_PACKAGE_META_BYTES,
      onentry,
    }) as Parser
    parser.on('error', () => fail(structureError('归档无法解析')))
    parser.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(finalizeArchive(files, directories))
      } catch (error) {
        reject(error instanceof Error ? error : structureError('归档无法解析'))
      }
    })
    source.on('error', () => fail(structureError('归档无法读取')))
    gunzip.on('error', () => fail(structureError('归档无法解析')))
    meter.on('error', (error: Error) => fail(toStructureError(error, '归档无法解析')))
    source.pipe(gunzip).pipe(meter).pipe(parser)
  })
}

function finalizeArchive(files: AgentPackageFile[], directories: string[]): UnpackedArchive {
  if (files.length === 0) throw structureError('归档为空')
  assertNoFileAncestors(
    [...files.map((file) => file.path), ...directories],
    new Set(files.map((file) => file.path)),
  )
  return { files, directories }
}

/** 拒绝任何路径的祖先同时是普通文件(文件与目录不能共享同一前缀)。 */
function assertNoFileAncestors(paths: readonly string[], filePaths: ReadonlySet<string>): void {
  for (const path of paths) {
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      if (filePaths.has(segments.slice(0, index).join('/'))) {
        throw structureError('目录与文件冲突')
      }
    }
  }
}

/**
 * 归一化并校验条目路径。
 *
 * 目录条目按 tar 规范以 `/` 结尾(node-tar/GNU tar 都这么写),去掉且只去掉
 * 一个结尾 `/` 后再做空段检查;写成 `a//` 的文件或目录仍然非法。
 */
function normalizeEntryPath(rawPath: string, kind: 'file' | 'directory'): string {
  let path = rawPath
  while (path.startsWith('./')) path = path.slice(2)
  if (kind === 'directory' && path.endsWith('/')) path = path.slice(0, -1)
  if (path === '') throw structureError('路径为空')
  if (path.startsWith('/')) throw structureError('路径必须是相对路径')
  if (DRIVE_PREFIX_RE.test(path)) throw structureError('路径不得包含盘符')
  if (path.includes('\\')) throw structureError('路径不得包含反斜杠')
  if (path.includes('\0')) throw structureError('路径不得包含 NUL')
  if (!PACKAGE_PATH_RE.test(path)) throw structureError('路径包含不允许的字符')

  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw structureError('路径不得包含 . 或 .. 段')
  }
  if (segments.some((segment) => RESERVED_SEGMENT_PREFIXES.some((prefix) => segment.startsWith(prefix)))) {
    throw structureError('路径使用了保留前缀')
  }
  if (Buffer.byteLength(path, 'utf8') > MAX_AGENT_PACKAGE_PATH_BYTES) {
    throw structureError(`路径超过${MAX_AGENT_PACKAGE_PATH_BYTES}字节`)
  }
  return path
}

function isSignaturePath(path: string): boolean {
  return path.split('/').includes(SIGNATURE_DIR)
}

function encodeCanonicalDocument(value: unknown): string {
  try {
    return canonicalJson(value)
  } catch {
    throw structureError('签名清单无法序列化')
  }
}

function encodeSignatureDocument(value: unknown): string {
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(value)
  } catch {
    encoded = undefined
  }
  if (encoded === undefined) throw structureError('签名记录无法序列化')
  return encoded
}

/** 收集压缩流,超过 bundle 上限立即 destroy 并拒绝。 */
function collectCapped(stream: Pack): Promise<Buffer> {
  return new Promise((resolve, reject) => {
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
      if (total > MAX_AGENT_PACKAGE_BUNDLE_BYTES) {
        fail(packageTooLargeError())
        return
      }
      chunks.push(chunk)
    })
    stream.on('error', () => fail(structureError('打包失败')))
    stream.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks, total))
    })
  })
}

function toStructureError(error: unknown, fallback: string): Error {
  if (error instanceof Error && error.message.startsWith('包结构非法：')) return error
  return structureError(fallback)
}

function structureError(message: string): Error {
  return new Error(`包结构非法：${message}`)
}

/** 压缩字节、声明内容或解压总量任一超帽时共用的错误。 */
function packageTooLargeError(): Error {
  return structureError(`智能体包超过${MAX_AGENT_PACKAGE_BUNDLE_BYTES}字节上限`)
}
