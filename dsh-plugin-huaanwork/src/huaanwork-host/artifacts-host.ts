/**
 * 任务结果 Artifact 的有界持久化(设计 §5.3 / 计划 Task 1)。
 *
 * 布局固定为 `<profileDir>/artifacts/<sessionId>/<artifactId>/`，目录内是
 * `manifest.json` 与 `content.md|content.html`。所有运行时校验先于任何写盘；
 * 单文件上限 {@link MAX_ARTIFACT_BYTES}、单会话上限 {@link MAX_ARTIFACTS_PER_SESSION}，
 * 超限一律拒绝，不截断、不淘汰旧记录。
 *
 * 写入是两阶段协议：{@link beginArtifactWrite} 同步登记活跃 lease(不 I/O)，
 * {@link prepareArtifact} 只写会话最终目录之外的隐藏暂存根并核对字节/摘要，
 * {@link commitPreparedArtifact} 在 profile 锁内先重验 lease、再裁决幂等与数量，
 * 最后原子 rename。事件不属于本模块：只有 `created:true` 的调用方负责 emit。
 *
 * `ArtifactWrite` 是不透明句柄，内部状态只存在于模块级活跃映射；最后一个 lease
 * 在 discard 的 finally 中释放并删除映射，不保留已删除所有者的永久墓碑。
 * Task 8 的删除原语复用同一 profile 锁与活跃映射，在此文件内按 scope 失效 lease。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import type { ArtifactAnchor, ArtifactFormat, TaskArtifactSummary } from '../client-huaanwork/rpc-types.ts'
import { isSinglePathSegment } from '../path-segment.ts'

/** 单个 Artifact 正文的 UTF-8 字节上限；等于上限允许，超过拒绝。 */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024
/** 每个会话可保留的 Artifact 数量上限；超限拒绝新记录，不淘汰旧记录。 */
export const MAX_ARTIFACTS_PER_SESSION = 100

/** 隐藏暂存根：与最终目录同一 profile 文件系统，且不落在 `artifacts/<sessionId>` 内。 */
const STAGING_DIR_NAME = '.artifacts-staging'
const ARTIFACTS_DIR_NAME = 'artifacts'
const MANIFEST_FILE_NAME = 'manifest.json'
const DEVICE_TITLE_FALLBACK = '任务结果'

/** 稳定具名错误：调用方(工具、自动化、路由)按 message 映射错误码，不解析任意文本。 */
const ERROR_OWNER_DELETED = 'artifact-owner-deleted'
const ERROR_NOT_FOUND = 'artifact-not-found'
const ERROR_CORRUPT = 'artifact-corrupt'
const ERROR_TOO_LARGE = 'artifact-too-large'
const ERROR_SESSION_FULL = 'artifact-session-full'
const ERROR_INVALID_SCOPE = 'artifact-invalid-scope'
const ERROR_PATH_ESCAPE = 'artifact-path-escape'

export type ArtifactInput = {
  sessionId: string
  anchor: ArtifactAnchor
  idempotency:
    | { kind: 'tool'; callId: string }
    | { kind: 'automation-run'; automationId: string; runId: string }
  title: string
  format: ArtifactFormat
  content: string
  downloadName?: string
}
export type ArtifactWriteScope = Pick<ArtifactInput, 'sessionId' | 'anchor' | 'idempotency'>
declare const artifactWriteBrand: unique symbol
export type ArtifactWrite = { readonly [artifactWriteBrand]: true }

type ArtifactIdempotency = ArtifactInput['idempotency']

/** 落盘 manifest = 线上摘要 + 幂等键；幂等键不进入事件、列表与读取结果。 */
type ArtifactManifest = TaskArtifactSummary & { idempotency: ArtifactIdempotency }

type PreparedArtifact = {
  /** 隐藏暂存目录(绝对路径)；commit 成功后整个目录被 rename 到最终位置。 */
  stagingDir: string
  contentPath: string
  manifest: ArtifactManifest
}

type InternalWrite = {
  /** 已 resolve 的 profile 根；锁与目录定位共用同一规范值。 */
  profileDir: string
  sessionId: string
  anchor: ArtifactAnchor
  idempotency: ArtifactIdempotency
  prepared?: PreparedArtifact
  committed?: TaskArtifactSummary
  /** Task 8 删除原语按 scope 失效；失效后 commit 必须报 artifact-owner-deleted。 */
  invalid: boolean
  released: boolean
}

/**
 * 活跃 lease 映射：只在持有句柄期间存在。句柄对象身份是唯一键，discard 释放时删除；
 * 被删除所有者失效的旧句柄在释放前仍留在映射里(带 invalid)，但不会产生新墓碑。
 */
const activeWrites = new Map<ArtifactWrite, InternalWrite>()

/** 每个 profileDir 一条 Promise 互斥链；commit 与 Task 8 的删除原语共用。 */
const profileLocks = new Map<string, Promise<unknown>>()

function namedError(code: string): Error {
  return new Error(code)
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeAnchor(value: unknown, fail: () => Error): ArtifactAnchor {
  if (!isRecord(value)) throw fail()
  if (value.kind === 'turn') {
    if (value.clientMessageId === undefined) return { kind: 'turn' }
    if (typeof value.clientMessageId !== 'string' || value.clientMessageId.length === 0) throw fail()
    return { kind: 'turn', clientMessageId: value.clientMessageId }
  }
  if (value.kind === 'automation-run') {
    if (!isSinglePathSegment(value.automationId) || !isSinglePathSegment(value.runId)) throw fail()
    return { kind: 'automation-run', automationId: value.automationId, runId: value.runId }
  }
  throw fail()
}

function normalizeIdempotency(value: unknown, fail: () => Error): ArtifactIdempotency {
  if (!isRecord(value)) throw fail()
  if (value.kind === 'tool') {
    if (typeof value.callId !== 'string' || value.callId.length === 0) throw fail()
    return { kind: 'tool', callId: value.callId }
  }
  if (value.kind === 'automation-run') {
    if (!isSinglePathSegment(value.automationId) || !isSinglePathSegment(value.runId)) throw fail()
    return { kind: 'automation-run', automationId: value.automationId, runId: value.runId }
  }
  throw fail()
}

function sameIdempotency(left: ArtifactIdempotency, right: ArtifactIdempotency): boolean {
  if (left.kind === 'tool' && right.kind === 'tool') return left.callId === right.callId
  if (left.kind === 'automation-run' && right.kind === 'automation-run') {
    return left.automationId === right.automationId && left.runId === right.runId
  }
  return false
}

function profileKey(profileDir: string, errorCode: string): string {
  if (typeof profileDir !== 'string' || !profileDir.trim()) throw namedError(errorCode)
  return resolve(profileDir)
}

function withProfileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = profileLocks.get(key) ?? Promise.resolve()
  const run = previous.then(() => fn(), () => fn())
  // 锁链永不因操作失败而断裂；空闲时删除键，避免按 profile 永久积累。
  const tail = run.then(() => undefined, () => undefined)
  profileLocks.set(key, tail)
  void tail.then(() => {
    if (profileLocks.get(key) === tail) profileLocks.delete(key)
  })
  return run
}

/** 防御性路径约束：段校验已排除 `..`/分隔符，这里仍确认结果没有逃出根目录。 */
function resolveInside(root: string, ...segments: string[]): string {
  const base = resolve(root)
  const path = resolve(join(base, ...segments))
  if (path !== base && !path.startsWith(`${base}${sep}`)) throw namedError(ERROR_NOT_FOUND)
  return path
}

function artifactsRoot(profileDir: string): string {
  return resolveInside(profileDir, ARTIFACTS_DIR_NAME)
}

function sessionDirPath(profileDir: string, sessionId: string): string {
  return resolveInside(artifactsRoot(profileDir), sessionId)
}

function artifactDirPath(profileDir: string, sessionId: string, artifactId: string): string {
  return resolveInside(sessionDirPath(profileDir, sessionId), artifactId)
}

function contentFileName(format: ArtifactFormat): string {
  return format === 'markdown' ? 'content.md' : 'content.html'
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function toSummary(manifest: ArtifactManifest): TaskArtifactSummary {
  const anchor: ArtifactAnchor = manifest.anchor.kind === 'turn'
    ? {
        kind: 'turn',
        ...(manifest.anchor.clientMessageId === undefined ? {} : { clientMessageId: manifest.anchor.clientMessageId }),
      }
    : { kind: 'automation-run', automationId: manifest.anchor.automationId, runId: manifest.anchor.runId }
  return {
    artifactId: manifest.artifactId,
    sessionId: manifest.sessionId,
    title: manifest.title,
    format: manifest.format,
    downloadName: manifest.downloadName,
    sizeBytes: manifest.sizeBytes,
    sha256: manifest.sha256,
    createdAt: manifest.createdAt,
    anchor,
  }
}

function byCreatedAt(left: TaskArtifactSummary, right: TaskArtifactSummary): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1
  if (left.artifactId === right.artifactId) return 0
  return left.artifactId < right.artifactId ? -1 : 1
}

function parseManifest(raw: string, sessionId: string, artifactId: string): ArtifactManifest {
  const corrupt = () => namedError(ERROR_CORRUPT)
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw corrupt()
  }
  if (!isRecord(value)) throw corrupt()
  if (value.artifactId !== artifactId || value.sessionId !== sessionId) throw corrupt()

  const title = value.title
  if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title)) throw corrupt()
  if (value.format !== 'markdown' && value.format !== 'html') throw corrupt()
  if (typeof value.downloadName !== 'string' || value.downloadName.length === 0) throw corrupt()
  if (
    typeof value.sizeBytes !== 'number' ||
    !Number.isInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    value.sizeBytes > MAX_ARTIFACT_BYTES
  ) {
    throw corrupt()
  }
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) throw corrupt()
  if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) throw corrupt()

  return {
    artifactId,
    sessionId,
    title,
    format: value.format,
    downloadName: value.downloadName,
    sizeBytes: value.sizeBytes,
    sha256: value.sha256,
    createdAt: value.createdAt,
    anchor: normalizeAnchor(value.anchor, corrupt),
    idempotency: normalizeIdempotency(value.idempotency, corrupt),
  }
}

/** 读取并严格校验一条记录；读侧重新核对实际字节与 sha256，不符即 fail closed。 */
async function loadRecord(
  profileDir: string,
  sessionId: string,
  artifactId: string,
): Promise<{ manifest: ArtifactManifest; content: Buffer }> {
  if (!isSinglePathSegment(sessionId) || !isSinglePathSegment(artifactId)) throw namedError(ERROR_NOT_FOUND)
  const dir = artifactDirPath(profileDir, sessionId, artifactId)

  let manifestText: string
  try {
    manifestText = await readFile(join(dir, MANIFEST_FILE_NAME), 'utf8')
  } catch (error) {
    if (isMissingPathError(error)) throw namedError(ERROR_NOT_FOUND)
    throw error
  }
  const manifest = parseManifest(manifestText, sessionId, artifactId)

  let content: Buffer
  try {
    content = await readFile(join(dir, contentFileName(manifest.format)))
  } catch (error) {
    if (isMissingPathError(error)) throw namedError(ERROR_CORRUPT)
    throw error
  }
  if (content.byteLength !== manifest.sizeBytes || sha256Hex(content) !== manifest.sha256) {
    throw namedError(ERROR_CORRUPT)
  }
  return { manifest, content }
}

/**
 * 只读取会话内全部 manifest(不读正文)：commit 的幂等与数量裁决使用它，
 * 命中记录后再经 {@link loadRecord} 核对实际字节。损坏 manifest 一律 fail closed。
 */
async function readSessionManifests(profileDir: string, sessionId: string): Promise<ArtifactManifest[]> {
  if (!isSinglePathSegment(sessionId)) throw namedError(ERROR_NOT_FOUND)
  const dir = sessionDirPath(profileDir, sessionId)
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw error
  }

  const manifests: ArtifactManifest[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // Artifact 目录名必须是单路径段；异常目录视为损坏记录，不能静默跳过。
    if (!isSinglePathSegment(entry.name)) throw namedError(ERROR_CORRUPT)
    let raw: string
    try {
      raw = await readFile(join(dir, entry.name, MANIFEST_FILE_NAME), 'utf8')
    } catch (error) {
      if (isMissingPathError(error)) throw namedError(ERROR_CORRUPT)
      throw error
    }
    manifests.push(parseManifest(raw, sessionId, entry.name))
  }
  return manifests
}

/**
 * 运行时正文校验(TypeScript 类型不构成验证)。顺序固定为 title → format →
 * content → downloadName → 字节预算，错误码与设计 §5.1 一致。
 */
function validateBody(input: Omit<ArtifactInput, keyof ArtifactWriteScope>): {
  title: string
  format: ArtifactFormat
  contentBytes: Buffer
  sha256: string
  downloadName: string
} {
  const raw = (input ?? {}) as Partial<ArtifactInput>
  if (typeof raw.title !== 'string') throw namedError('artifact-invalid-title')
  const title = raw.title.trim()
  if (!title || /[\r\n]/.test(raw.title)) throw namedError('artifact-invalid-title')

  if (raw.format !== 'markdown' && raw.format !== 'html') throw namedError('artifact-invalid-format')
  if (typeof raw.content !== 'string') throw namedError('artifact-invalid-content')
  if (raw.downloadName !== undefined && typeof raw.downloadName !== 'string') {
    throw namedError('artifact-invalid-download-name')
  }

  const contentBytes = Buffer.from(raw.content, 'utf8')
  if (contentBytes.byteLength > MAX_ARTIFACT_BYTES) throw namedError(ERROR_TOO_LARGE)

  return {
    title,
    format: raw.format,
    contentBytes,
    sha256: sha256Hex(contentBytes),
    downloadName: sanitizeArtifactDownloadName(title, raw.format, raw.downloadName),
  }
}

/**
 * 下载名清理：Windows 非法字符、控制字符与路径分隔符统一替换为 `-`；
 * 保留设备名按首个点前的名称识别并加安全前缀；扩展名强制与 format 一致。
 */
export function sanitizeArtifactDownloadName(
  title: string,
  format: 'markdown' | 'html',
  requested?: string,
): string {
  const cleaned = (typeof requested === 'string' ? requested.trim() : '') || title.trim() || DEVICE_TITLE_FALLBACK
  const safe = cleaned
    .replace(/[:*?"<>|/\\\x00-\x1f]/g, '-')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '')
  const deviceStem = (safe.split('.')[0] || '').trim()
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(deviceStem)
  const withPrefix = reserved ? `_${safe}` : safe
  const lastDot = withPrefix.lastIndexOf('.')
  const withoutExtension = (lastDot > 0 ? withPrefix.slice(0, lastDot) : withPrefix) || DEVICE_TITLE_FALLBACK
  return `${withoutExtension}.${format === 'markdown' ? 'md' : 'html'}`
}

/**
 * 同步登记一次写入的所有权。校验 scope、捕获不可变副本；不做任何 I/O 或 await。
 * 同一 scope 可同时持有多个 lease(并发重放由 commit 在锁内裁决)。
 */
export function beginArtifactWrite(profileDir: string, scope: ArtifactWriteScope): ArtifactWrite {
  const invalid = () => namedError(ERROR_INVALID_SCOPE)
  const key = profileKey(profileDir, ERROR_INVALID_SCOPE)
  const raw = (scope ?? {}) as Partial<ArtifactWriteScope>
  const sessionId = raw.sessionId
  if (!isSinglePathSegment(sessionId)) throw invalid()
  const anchor = normalizeAnchor(raw.anchor, invalid)
  const idempotency = normalizeIdempotency(raw.idempotency, invalid)

  const handle = Object.freeze({}) as unknown as ArtifactWrite
  activeWrites.set(handle, {
    profileDir: key,
    sessionId,
    anchor: Object.freeze(anchor),
    idempotency: Object.freeze(idempotency),
    invalid: false,
    released: false,
  })
  return handle
}

/**
 * 写隐藏暂存并核对实际字节/sha256；不创建 `artifacts/<sessionId>`、不进入列表、不发事件。
 * 失败时清理本句柄的暂存目录，lease 仍由调用方 finally discard 释放。
 */
export async function prepareArtifact(
  write: ArtifactWrite,
  input: Omit<ArtifactInput, keyof ArtifactWriteScope>,
): Promise<void> {
  const state = activeWrites.get(write)
  if (!state || state.released || state.invalid) throw namedError(ERROR_OWNER_DELETED)
  if (state.prepared || state.committed) throw namedError('artifact-already-prepared')

  const body = validateBody(input)
  const artifactId = randomUUID()
  const createdAt = new Date().toISOString()
  const manifest: ArtifactManifest = {
    artifactId,
    sessionId: state.sessionId,
    title: body.title,
    format: body.format,
    downloadName: body.downloadName,
    sizeBytes: body.contentBytes.byteLength,
    sha256: body.sha256,
    createdAt,
    anchor: state.anchor.kind === 'turn'
      ? {
          kind: 'turn',
          ...(state.anchor.clientMessageId === undefined ? {} : { clientMessageId: state.anchor.clientMessageId }),
        }
      : { kind: 'automation-run', automationId: state.anchor.automationId, runId: state.anchor.runId },
    idempotency: state.idempotency,
  }
  const stagingDir = resolveInside(state.profileDir, STAGING_DIR_NAME, artifactId)
  const contentPath = join(stagingDir, contentFileName(body.format))

  try {
    await mkdir(stagingDir, { recursive: true })
    await writeFile(contentPath, body.contentBytes)
    await writeFile(join(stagingDir, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    const stored = await readFile(contentPath)
    if (stored.byteLength !== manifest.sizeBytes || sha256Hex(stored) !== manifest.sha256) {
      throw namedError(ERROR_CORRUPT)
    }
  } catch (error) {
    // 暂存清理失败不能掩盖原始失败；lease 由调用方 discard 释放。
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  state.prepared = { stagingDir, contentPath, manifest }
}

/**
 * 锁内裁决并原子发布：先重验 lease(失效优先报 artifact-owner-deleted，含已有幂等记录)，
 * 再查幂等键、复验数量与暂存字节/摘要，最后 rename。并发同 scope 只有一个 created:true。
 */
export async function commitPreparedArtifact(write: ArtifactWrite): Promise<{ artifact: TaskArtifactSummary; created: boolean }> {
  const state = activeWrites.get(write)
  if (!state) throw namedError(ERROR_OWNER_DELETED)

  return withProfileLock(state.profileDir, async () => {
    // lease 重验必须先于一切幂等/数量判断：删除失效的旧句柄不得因已有记录而“成功”。
    if (state.released || state.invalid || !activeWrites.has(write)) throw namedError(ERROR_OWNER_DELETED)
    if (state.committed) return { artifact: state.committed, created: false }

    const prepared = state.prepared
    if (!prepared) throw namedError('artifact-not-prepared')

    const manifests = await readSessionManifests(state.profileDir, state.sessionId)
    const existing = manifests.find((manifest) => sameIdempotency(manifest.idempotency, state.idempotency))
    if (existing) {
      const record = await loadRecord(state.profileDir, state.sessionId, existing.artifactId)
      return { artifact: toSummary(record.manifest), created: false }
    }
    if (manifests.length >= MAX_ARTIFACTS_PER_SESSION) throw namedError(ERROR_SESSION_FULL)

    const stored = await readFile(prepared.contentPath)
    if (stored.byteLength !== prepared.manifest.sizeBytes || sha256Hex(stored) !== prepared.manifest.sha256) {
      throw namedError(ERROR_CORRUPT)
    }
    // 暂存 manifest 也必须能按最终读取路径解析，避免把半写记录 rename 成“成功”。
    const stagedManifest = await readFile(join(prepared.stagingDir, MANIFEST_FILE_NAME), 'utf8').catch((error: unknown) => {
      if (isMissingPathError(error)) throw namedError(ERROR_CORRUPT)
      throw error
    })
    const reparsed = parseManifest(stagedManifest, state.sessionId, prepared.manifest.artifactId)
    if (JSON.stringify(reparsed) !== JSON.stringify(prepared.manifest)) throw namedError(ERROR_CORRUPT)

    const sessionDir = sessionDirPath(state.profileDir, state.sessionId)
    const finalDir = artifactDirPath(state.profileDir, state.sessionId, prepared.manifest.artifactId)
    await mkdir(sessionDir, { recursive: true })
    await rename(prepared.stagingDir, finalDir)

    delete state.prepared
    state.committed = toSummary(prepared.manifest)
    return { artifact: state.committed, created: true }
  })
}

/**
 * 幂等丢弃暂存并释放 lease。已 commit 的句柄绝不删除最终正文；
 * 清理 I/O 失败也在 finally 释放 lease，但错误向调用方报告。重复调用无操作。
 */
export async function discardPreparedArtifact(write: ArtifactWrite): Promise<void> {
  const state = activeWrites.get(write)
  if (!state || state.released) return
  let failure: unknown
  try {
    if (state.prepared) {
      const stagingDir = state.prepared.stagingDir
      delete state.prepared
      await rm(stagingDir, { recursive: true, force: true })
    }
  } catch (error) {
    failure = error
  } finally {
    state.released = true
    activeWrites.delete(write)
  }
  if (failure !== undefined) throw failure
}

/** 组合两阶段入口的普通调用：返回摘要，不负责 emit。 */
export async function createArtifact(profileDir: string, input: ArtifactInput): Promise<TaskArtifactSummary> {
  const raw = (input ?? {}) as Partial<ArtifactInput>
  const write = beginArtifactWrite(profileDir, {
    sessionId: raw.sessionId as string,
    anchor: raw.anchor as ArtifactAnchor,
    idempotency: raw.idempotency as ArtifactIdempotency,
  })
  try {
    await prepareArtifact(write, {
      title: raw.title as string,
      format: raw.format as ArtifactFormat,
      content: raw.content as string,
      ...(raw.downloadName === undefined ? {} : { downloadName: raw.downloadName }),
    })
    const committed = await commitPreparedArtifact(write)
    return committed.artifact
  } finally {
    await discardPreparedArtifact(write)
  }
}

/** 读取单条摘要；实际字节与摘要不符时报 artifact-corrupt，跨会话/未知 ID 报 artifact-not-found。 */
export async function getArtifact(profileDir: string, sessionId: string, artifactId: string): Promise<TaskArtifactSummary> {
  const key = profileKey(profileDir, ERROR_NOT_FOUND)
  const record = await loadRecord(key, sessionId, artifactId)
  return toSummary(record.manifest)
}

/** 按需读取原始字节；校验规则与 {@link getArtifact} 相同。 */
export async function readArtifactContent(profileDir: string, sessionId: string, artifactId: string): Promise<Buffer> {
  const key = profileKey(profileDir, ERROR_NOT_FOUND)
  const record = await loadRecord(key, sessionId, artifactId)
  return record.content
}

/** 一次读取摘要与正文：content/download 路由共用同一次字节/摘要核对，避免单请求双读双哈希。 */
export async function readArtifactRecord(
  profileDir: string,
  sessionId: string,
  artifactId: string,
): Promise<{ artifact: TaskArtifactSummary; content: Buffer }> {
  const key = profileKey(profileDir, ERROR_NOT_FOUND)
  const record = await loadRecord(key, sessionId, artifactId)
  return { artifact: toSummary(record.manifest), content: record.content }
}

/** 会话摘要列表：按 createdAt/artifactId 确定性排序；损坏记录 fail closed(不返回空列表)。 */
export async function listArtifacts(profileDir: string, sessionId: string): Promise<TaskArtifactSummary[]> {
  const key = profileKey(profileDir, ERROR_NOT_FOUND)
  const manifests = await readSessionManifests(key, sessionId)
  const summaries: TaskArtifactSummary[] = []
  for (const manifest of manifests) {
    const record = await loadRecord(key, sessionId, manifest.artifactId)
    summaries.push(toSummary(record.manifest))
  }
  return summaries.sort(byCreatedAt)
}

/**
 * 按运行精确定位结果：manifest 的自动化锚点与幂等键必须同时匹配
 * `automationId + runId`，不按标题、下载名或目录名猜测。
 */
export async function findArtifactByRun(
  profileDir: string,
  automationId: string,
  runId: string,
): Promise<TaskArtifactSummary | undefined> {
  const key = profileKey(profileDir, ERROR_NOT_FOUND)
  if (!isSinglePathSegment(automationId) || !isSinglePathSegment(runId)) throw namedError(ERROR_NOT_FOUND)

  const root = artifactsRoot(key)
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }

  const sessionIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  for (const sessionId of sessionIds) {
    const manifests = await readSessionManifests(key, sessionId)
    const match = manifests.find((manifest) => manifest.anchor.kind === 'automation-run' &&
      manifest.anchor.automationId === automationId &&
      manifest.anchor.runId === runId &&
      manifest.idempotency.kind === 'automation-run' &&
      manifest.idempotency.automationId === automationId &&
      manifest.idempotency.runId === runId)
    if (match) {
      const record = await loadRecord(key, sessionId, match.artifactId)
      return toSummary(record.manifest)
    }
  }
  return undefined
}

/** 记录删除之后结果文件未能全部清理时的用户可见说明；路由原样透传。 */
export const ARTIFACT_CLEANUP_INCOMPLETE_MESSAGE = '记录已删除、结果文件未能完全清理'

/** 删除原语的磁盘清理报告：记录删除已完成，`complete:false` 只描述结果文件残余。 */
export type ArtifactCleanupReport = {
  complete: boolean
  message?: string
}

/** 结果文件清理不完整：权威记录已删除，调用方只报告、不回滚。 */
export function incompleteArtifactCleanup(): ArtifactCleanupReport {
  return { complete: false, message: ARTIFACT_CLEANUP_INCOMPLETE_MESSAGE }
}

/** 只读 manifest 扫描记录：不含正文、不含下载名之外的展示信息。 */
export type ArtifactManifestRecord = {
  sessionId: string
  artifactId: string
  anchor: ArtifactAnchor
  idempotency: ArtifactIdempotency
}

/**
 * 在锁内按 scope 失效匹配的活跃 lease。被失效的句柄仍由调用方 finally discard 释放；
 * 映射条目只在最后一个 lease 释放时删除，不保留永久删除标记。
 */
function invalidateMatchingWrites(profileDir: string, match: (state: InternalWrite) => boolean): void {
  for (const state of activeWrites.values()) {
    if (state.released || state.invalid) continue
    if (state.profileDir !== profileDir) continue
    if (match(state)) state.invalid = true
  }
}

/**
 * 删除前的符号链接逃逸检查：以 profile 的真实路径为根，目标解析结果必须仍在根内。
 * 目标不存在时放行(幂等删除会由 `rm(force)` 收尾)，链接指向根外一律拒绝。
 */
async function assertRemovalTargetInside(profileDir: string, target: string): Promise<void> {
  let realRoot: string
  try {
    realRoot = await realpath(profileDir)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }
  let realTarget: string
  try {
    realTarget = await realpath(target)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
    throw namedError(ERROR_PATH_ESCAPE)
  }
}

/** 删除单个目录：逃逸检查后无条件 `rm(force)`，目标缺失也是成功。 */
async function removeDirectoryInside(profileDir: string, target: string): Promise<void> {
  await assertRemovalTargetInside(profileDir, target)
  await rm(target, { recursive: true, force: true })
}

/**
 * 只读扫描 profile 内全部 manifest，供自动化/项目级联删除与测试仪器化使用。
 * 目录名必须仍是单路径段；损坏 manifest 与列表读取一样 fail closed。
 */
export async function scanArtifactManifests(profileDir: string): Promise<ArtifactManifestRecord[]> {
  const key = profileKey(profileDir, ERROR_NOT_FOUND)
  let entries: Dirent[]
  try {
    entries = await readdir(artifactsRoot(key), { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw error
  }
  const records: ArtifactManifestRecord[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!isSinglePathSegment(entry.name)) throw namedError(ERROR_CORRUPT)
    for (const manifest of await readSessionManifests(key, entry.name)) {
      records.push({
        sessionId: manifest.sessionId,
        artifactId: manifest.artifactId,
        anchor: manifest.anchor,
        idempotency: manifest.idempotency,
      })
    }
  }
  return records
}

/**
 * 删除整个会话的结果目录(Task 8)。进入锁后、删除 I/O 前同步失效该会话的全部活跃
 * lease；锁内 finally 再失效一次，覆盖删除等待期间同步 begin 的新 lease。即使最终目录
 * 不存在或 `rm` 失败，两次失效都会执行。调用方仍需在自己的 finally discard 句柄。
 */
export async function removeArtifactsOfSession(profileDir: string, sessionId: string): Promise<void> {
  const key = profileKey(profileDir, ERROR_NOT_FOUND)
  if (!isSinglePathSegment(sessionId)) throw namedError(ERROR_NOT_FOUND)
  const invalidate = () => invalidateMatchingWrites(key, (state) => state.sessionId === sessionId)
  return withProfileLock(key, async () => {
    invalidate()
    try {
      await removeDirectoryInside(key, sessionDirPath(key, sessionId))
    } finally {
      invalidate()
    }
  })
}

/**
 * 删除单次运行的结果文件(Task 8)。只检查 `sessionId` 对应会话的 manifest，不扫描全
 * profile；`sessionId` 缺失时只按已知 automationId/runId 失效活跃 write，不猜目录。
 * 与 commit 共用 profile 锁，失效配对与 {@link removeArtifactsOfSession} 相同。
 */
export async function removeArtifactOfRun(
  profileDir: string,
  sessionId: string | undefined,
  automationId: string,
  runId: string,
): Promise<void> {
  const key = profileKey(profileDir, ERROR_NOT_FOUND)
  if (!isSinglePathSegment(automationId) || !isSinglePathSegment(runId)) throw namedError(ERROR_NOT_FOUND)
  if (sessionId !== undefined && !isSinglePathSegment(sessionId)) throw namedError(ERROR_NOT_FOUND)
  const matchesRun = (state: InternalWrite) =>
    state.anchor.kind === 'automation-run' &&
    state.anchor.automationId === automationId &&
    state.anchor.runId === runId
  const invalidate = () => invalidateMatchingWrites(key, matchesRun)
  return withProfileLock(key, async () => {
    invalidate()
    try {
      if (sessionId === undefined) return
      for (const manifest of await readSessionManifests(key, sessionId)) {
        if (manifest.anchor.kind !== 'automation-run' ||
          manifest.anchor.automationId !== automationId ||
          manifest.anchor.runId !== runId) continue
        if (manifest.idempotency.kind !== 'automation-run' ||
          manifest.idempotency.automationId !== automationId ||
          manifest.idempotency.runId !== runId) continue
        await removeDirectoryInside(key, artifactDirPath(key, sessionId, manifest.artifactId))
      }
    } finally {
      invalidate()
    }
  })
}

/**
 * 删除一个自动化的全部结果文件(Task 8)：允许扫描全部 manifest，但只按
 * `automation-run` 锚点的 automationId 精确匹配，不按标题、下载名或目录名猜测。
 * lease 失效同样发生在进入锁与锁内 finally 两个同步段。
 */
export async function removeArtifactsOfAutomation(profileDir: string, automationId: string): Promise<void> {
  const key = profileKey(profileDir, ERROR_NOT_FOUND)
  if (!isSinglePathSegment(automationId)) throw namedError(ERROR_NOT_FOUND)
  const invalidate = () => invalidateMatchingWrites(
    key,
    (state) => state.anchor.kind === 'automation-run' && state.anchor.automationId === automationId,
  )
  return withProfileLock(key, async () => {
    invalidate()
    try {
      for (const record of await scanArtifactManifests(key)) {
        if (record.anchor.kind !== 'automation-run' || record.anchor.automationId !== automationId) continue
        await removeDirectoryInside(key, artifactDirPath(key, record.sessionId, record.artifactId))
      }
    } finally {
      invalidate()
    }
  })
}
