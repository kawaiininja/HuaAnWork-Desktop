/**
 * 知识库 Storage 数据库层（规格 §7.1 Schema / §6.4 重建提交点协议 / 计划 Task 4）。
 *
 * 本模块独占 `node:sqlite` 的 `DatabaseSync`，只允许被 Storage Worker 线程与
 * 存储级单元测试导入；Host 线程模块永不导入本文件（约束：`node:sqlite` 只
 * 存在于 Worker 内）。
 *
 * 三个不变量：
 * 1. `doc_id` 永久稳定：首次入库 `randomUUID()`，重索引、1 对 1 重命名与正常
 *    重建都继承旧值；只有旧库损坏不可读的损坏恢复重建才重新分配。
 * 2. `chunks_fts` 是独立 FTS5 表，不受 `chunks` 级联覆盖，因此每次文档替换 /
 *    删除 / 重命名都在同一事务内显式同步（杜绝僵尸全文条目）。
 * 3. 重建以 `rename(index.sqlite.rebuild, index.sqlite)` 为唯一提交点（Step 2）：
 *    提交前失败回到旧库，提交后失败绝不回滚新库。
 *
 * 本文件会被 Worker/测试以 `.ts` 源码直接加载（Node type-stripping），因此
 * 不得使用 `enum`、构造器参数属性或 `namespace`；纯类型导入必须写
 * `import type`，相对导入保留 `.ts` 后缀。
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'

import type { SingleKbCandidate } from './ranker.ts'
import type { StorageGetChunkResult } from './storage-protocol.ts'
import { buildSafeFtsQuery, tokenizeForFts } from './tokenizer.ts'
import { MAX_CHUNKS_PER_DOC, MAX_CHUNKS_PER_KB, MAX_WIKI_FILE_BYTES } from './types.ts'
import type {
  ChunkLocator,
  ChunkWindowItem,
  DocumentRecordSummary,
  KnowledgeBaseStats,
  ListDocsFilter,
  ListDocsResult,
  OrganizeTombstoneRecord,
  PendingOrganizeBatch,
  PendingOrganizeItem,
  UpsertDocumentInput,
} from './types.ts'

const DB_FILENAME = 'index.sqlite'
const REBUILD_SUFFIX = '.rebuild'
const BACKUP_SUFFIX = '.bak'
const WAL_SUFFIX = '-wal'
const SHM_SUFFIX = '-shm'
const WIKI_DIRNAME = 'wiki'
const WIKI_STALE_DIRNAME = 'wiki.stale'
const WIKI_DOCS_DIRNAME = 'docs'
const WIKI_RESET_PENDING_FILENAME = 'wiki-reset.pending'
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIR_MODE = 0o700

/** 存储 schema 版本（`PRAGMA user_version`）。 */
export const KNOWLEDGE_DB_SCHEMA_VERSION = 1
/** `listDocs` 缺省行数（规格 §7.2）。 */
export const LIST_DOCS_DEFAULT_LIMIT = 50
/** `listDocs` 硬上限（规格 §7.2）。 */
export const LIST_DOCS_MAX_LIMIT = 200
/** 单库检索候选池大小：单库内先取 Top-60，再交 Host 侧重排（规格 §7.2）。 */
export const SEARCH_FTS_DEFAULT_LIMIT = 60
/** 一批整理最多 10 份文档或 80 KB 切片文本（规格 §8.2）。 */
export const ORGANIZE_BATCH_MAX_DOCS = 10
export const ORGANIZE_BATCH_MAX_BYTES = 80 * 1024
/** 第 3 次整理失败后不再自动排期（规格 §8.1）。 */
export const ORGANIZE_MAX_ATTEMPTS = 3
/** 整理失败退避：第 1 次 1 分钟，第 2 次 5 分钟（规格 §8.1）。 */
export const ORGANIZE_RETRY_FIRST_DELAY_MS = 60_000
export const ORGANIZE_RETRY_SECOND_DELAY_MS = 300_000

/**
 * 可参与整理的文档筛选条件（规格 §6.3 / §8.1 / §10）：
 * `indexed` 与已产出有效切片的 `partial`（例如混合 PDF 文字页、截断长文档）
 * 都应进入待整理队列；0 切片文档与 `skipped`/`error` 不进入待整理。
 */
const ORGANIZE_ELIGIBLE_SQL = `d.status IN ('indexed', 'partial') AND EXISTS (SELECT 1 FROM chunks c WHERE c.doc_id = d.doc_id)`
/** 待整理：满足可整理条件、尚未按当前 sha256 整理，且未达到 3 次放弃阈值（含退避中文档）。 */
const ORGANIZE_PENDING_SQL = `${ORGANIZE_ELIGIBLE_SQL} AND (d.organized_sha256 IS NULL OR d.organized_sha256 <> d.sha256) AND d.organize_attempts < ${String(ORGANIZE_MAX_ATTEMPTS)}`
/** 已放弃整理（quarantined `organize-failed`，规格 §8.1：第 3 次失败后不再自动排期）。 */
const ORGANIZE_FAILED_SQL = `d.organize_attempts >= ${String(ORGANIZE_MAX_ATTEMPTS)}`

/** 规格 §7.1 逐字锁定的 Schema（全部 `IF NOT EXISTS`，打开幂等）。 */
const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS documents (
    doc_id TEXT PRIMARY KEY,
    rel_path TEXT NOT NULL UNIQUE,
    norm_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    format TEXT NOT NULL,
    extract_mode TEXT NOT NULL,
    extract_config_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    status_reason TEXT,
    wiki_note_path TEXT,
    organized_sha256 TEXT,
    organize_attempts INTEGER NOT NULL DEFAULT 0,
    organize_retry_after INTEGER,
    last_organize_error TEXT,
    updated_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_documents_norm_path ON documents(norm_path)',
  `CREATE TABLE IF NOT EXISTS organize_tombstones (
    doc_id TEXT PRIMARY KEY,
    rel_path TEXT NOT NULL,
    wiki_note_path TEXT,
    deleted_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    heading_path TEXT NOT NULL DEFAULT '',
    locator_json TEXT NOT NULL,
    content TEXT NOT NULL,
    tokenized TEXT NOT NULL,
    char_count INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_chunks_doc_ordinal ON chunks(doc_id, ordinal)',
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_id UNINDEXED,
    rel_path,
    heading_path,
    tokenized,
    tokenize = 'unicode61'
  )`,
  `CREATE TABLE IF NOT EXISTS chunk_embeddings (
    chunk_id TEXT NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
    model_key TEXT NOT NULL,
    dims INTEGER NOT NULL,
    vector_blob BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chunk_id, model_key)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model ON chunk_embeddings(model_key)',
]

const CONNECTION_PRAGMAS: readonly string[] = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA journal_size_limit = 33554432',
  'PRAGMA wal_autocheckpoint = 1000',
]

export type OpenKnowledgeDbResult =
  | { readonly ok: true; readonly db: DatabaseSync; readonly wikiResetPending: boolean }
  | { readonly ok: false; readonly code: 'index-error'; readonly error: string }

export interface UpsertDocumentOptions {
  /** 单库切片硬上限（默认 `MAX_CHUNKS_PER_KB`，测试可注入小值）。 */
  readonly maxChunksPerKb?: number
}

export interface UpsertDocumentResult {
  readonly docId: string
  readonly chunkIds: readonly string[]
  readonly chunkCapExceeded: boolean
}

/** 重建暂存库句柄（控制器裁决 M-12）。 */
export interface RebuildStaging {
  /** 旧库不可读时为 true：提交前必须先落盘 `wiki-reset.pending`。 */
  readonly corruptRecovery: boolean
  upsert(input: UpsertDocumentInput): UpsertDocumentResult
  abort(): void
}

/** 提交点故障注入（仅进程内测试；跨线程版本是协议里的布尔钩子）。 */
export interface CommitRebuildOptions {
  /** Step 1 成功之后、Step 2 提交点之前抛出，模拟提交前重命名失败。 */
  readonly failBeforeCommitPointForTest?: () => void
  /** 提交点之后、清理暂存文件之前抛出，模拟 Windows 上删除 `.rebuild-wal` 失败。 */
  readonly afterCommitCleanupForTest?: () => void
  readonly afterCommitBeforeReopenForTest?: () => void
  readonly failWikiResetOnceForTest?: () => void
}

export type CommitRebuildResult =
  | { readonly ok: true; readonly corruptRecovery: boolean; readonly wikiResetPending: boolean }
  | { readonly ok: false; readonly code: 'index-error' | 'rebuild-failed'; readonly error: string }

export interface GetChunkWindowQuery {
  /** Worker 已知的库 ID；直接调用（测试）时可缺省，回填为空串。 */
  readonly kbId?: string
  readonly docId: string
  readonly ordinal: number
  readonly window: number
  readonly expectedSha256?: string
  readonly expectedExtractConfigHash?: string
}

export interface SearchFtsQuery {
  readonly kbId: string
  readonly kbName: string
  readonly query: string
  readonly limit?: number
}

export interface MarkOrganizedInput {
  readonly docId: string
  readonly sha256: string
  readonly wikiNotePath: string
  readonly clearedTombstones?: readonly string[]
}

export interface RecordOrganizeFailureInput {
  readonly docId: string
  readonly sha256: string
  readonly error: string
  readonly nowMs: number
}

export interface PendingOrganizeBatchQuery {
  readonly nowMs: number
  readonly maxDocs?: number
  readonly maxBytes?: number
}

/** 重建期间从旧库只读抽出的 `doc_id` / Wiki 语义快照（规格 §6.4）。 */
interface RebuildSnapshotDoc {
  readonly docId: string
  readonly wikiNotePath: string | null
  readonly organizedSha256: string | null
}

interface RebuildSnapshot {
  readonly corruptRecovery: boolean
  readonly docs: ReadonlyMap<string, RebuildSnapshotDoc>
}

/** 一次文档写入所需的全量文档级状态（调用方算出继承值）。 */
interface DocumentWritePlan {
  readonly docId: string
  readonly wikiNotePath: string | null
  readonly organizedSha256: string | null
  readonly organizeAttempts: number
  readonly organizeRetryAfter: number | null
  readonly lastOrganizeError: string | null
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function text(value: SQLOutputValue | undefined): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

function textOrNull(value: SQLOutputValue | undefined): string | null {
  return typeof value === 'string' ? value : null
}

function integer(value: SQLOutputValue | undefined): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function integerOrNull(value: SQLOutputValue | undefined): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return null
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const candidate = value === undefined || !Number.isFinite(value) ? fallback : Math.trunc(value)
  return Math.max(min, Math.min(candidate, max))
}

function removeIfExists(target: string): void {
  rmSync(target, { force: true, recursive: true })
}

function moveIfExists(from: string, to: string): void {
  if (!existsSync(from)) return
  removeIfExists(to)
  renameSync(from, to)
}

function parseLocator(raw: SQLOutputValue | undefined): ChunkLocator {
  if (typeof raw === 'string' && raw !== '') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { kind?: unknown }).kind === 'string') {
        return parsed as ChunkLocator
      }
    } catch {
      // 损坏的 locator_json 降级为文件级定位，绝不让读取失败。
    }
  }
  return { kind: 'file' }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, match => `\\${match}`)
}

function inImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 事务已不可回滚（如磁盘错误），把原始错误交给调用方。
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// 原子标记文件与 Wiki 幂等重置
// ---------------------------------------------------------------------------

/**
 * 同步原子替换，与 `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic` 同契约：
 * 同目录随机后缀临时文件独占创建 + `0o600`，`rename` 是唯一提交点，失败清理
 * 临时文件。该共享助手只有异步版本，而 Storage 调用链由 `DatabaseSync` 的同步
 * API 驱动、无法在同步函数里等待 Promise，因此保留逐字等价的同步实现；任何
 * 路径都不使用非原子的裸 `writeFile`。
 */
function writeFileAtomicSync(filename: string, content: string): void {
  const temp = `${filename}.${randomUUID()}.tmp`
  try {
    const handle = openSync(temp, 'wx', PRIVATE_FILE_MODE)
    try {
      writeFileSync(handle, content)
    } finally {
      closeSync(handle)
    }
    renameSync(temp, filename)
  } catch (error) {
    removeIfExists(temp)
    throw error
  }
}

export function dbPath(kbDir: string): string {
  return join(kbDir, DB_FILENAME)
}

export function rebuildDbPath(kbDir: string): string {
  return `${dbPath(kbDir)}${REBUILD_SUFFIX}`
}

export function wikiResetPendingPath(kbDir: string): string {
  return join(kbDir, WIKI_RESET_PENDING_FILENAME)
}

function wikiStalePath(kbDir: string): string {
  return join(kbDir, WIKI_STALE_DIRNAME)
}

function clearWikiStale(kbDir: string): void {
  let entries: string[]
  try {
    entries = readdirSync(kbDir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === WIKI_STALE_DIRNAME || entry.startsWith(`${WIKI_STALE_DIRNAME}.`)) {
      removeIfExists(join(kbDir, entry))
    }
  }
}

/**
 * Wiki 幂等重置（规格 §6.4 提交后收尾）：`wiki/` → `wiki.stale`、重建空
 * `wiki/`、删除 `wiki-reset.pending`，最后尽力删除 `wiki.stale`。任一步失败
 * 都返回 false 并保留 pending，调用方据此维持 `wiki-reset-pending`。
 */
function performWikiReset(kbDir: string): boolean {
  const wikiDir = join(kbDir, WIKI_DIRNAME)
  const staleDir = wikiStalePath(kbDir)
  try {
    if (existsSync(wikiDir) && !existsSync(staleDir)) renameSync(wikiDir, staleDir)
    mkdirSync(wikiDir, { recursive: true, mode: PRIVATE_DIR_MODE })
    removeIfExists(wikiResetPendingPath(kbDir))
    clearWikiStale(kbDir)
    return true
  } catch {
    return false
  }
}

function ensureWikiResetPendingSync(kbDir: string): void {
  const target = wikiResetPendingPath(kbDir)
  if (existsSync(target)) return
  mkdirSync(kbDir, { recursive: true, mode: PRIVATE_DIR_MODE })
  writeFileAtomicSync(target, `${JSON.stringify({ reason: 'corrupt-rebuild', at: new Date().toISOString() })}\n`)
}

/**
 * 幂等续做未完成的 Wiki 重置（提交后崩溃 / 用户「重试重置知识视图」入口）。
 * 无 pending 时视为已完成并只清扫残留 `wiki.stale*`。
 */
export function retryPendingWikiReset(kbDir: string): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  try {
    if (!existsSync(wikiResetPendingPath(kbDir))) {
      clearWikiStale(kbDir)
      return { ok: true }
    }
    return performWikiReset(kbDir) ? { ok: true } : { ok: false, error: 'wiki reset failed' }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

// ---------------------------------------------------------------------------
// 打开、PRAGMA、Schema 与崩溃恢复
// ---------------------------------------------------------------------------

function applyConnectionPragmas(db: DatabaseSync): void {
  for (const pragma of CONNECTION_PRAGMAS) db.exec(pragma)
}

function initializeSchema(db: DatabaseSync): void {
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement)
  db.exec(`PRAGMA user_version = ${String(KNOWLEDGE_DB_SCHEMA_VERSION)}`)
}

/** `PRAGMA quick_check` 必须返回 `ok`，否则按损坏处理（绝不抛出到调用方）。 */
function assertHealthy(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA quick_check').get()
  const verdict = text(row?.['quick_check'])
  if (verdict !== 'ok') throw new Error(`knowledge index quick_check failed: ${verdict}`)
}

/**
 * 重建三文件联合状态机的启动恢复（规格 §6.4「崩溃重启自动恢复」）：
 * - `index.sqlite.rebuild` 存在 → Step 2 从未成功：先恢复 `.bak*`（若主库缺失），
 *   再无条件下清理 `.rebuild*`、多余 `.bak*` 与未提交的 `wiki-reset.pending`；
 * - 否则进入已提交/常规分支：清理残留 `.bak*`，续做 pending Wiki 重置，最后
 *   清扫 `wiki.stale*`。
 * @returns 仍处于 `wiki-reset-pending`（重置失败）时为 true。
 */
export function recoverKnowledgeDbDir(kbDir: string): boolean {
  const main = dbPath(kbDir)
  const backup = `${main}${BACKUP_SUFFIX}`
  const rebuild = `${main}${REBUILD_SUFFIX}`
  const pending = wikiResetPendingPath(kbDir)

  if (existsSync(rebuild)) {
    if (!existsSync(main) && existsSync(backup)) {
      renameSync(backup, main)
      moveIfExists(`${backup}${WAL_SUFFIX}`, `${main}${WAL_SUFFIX}`)
      moveIfExists(`${backup}${SHM_SUFFIX}`, `${main}${SHM_SUFFIX}`)
    }
    removeIfExists(rebuild)
    removeIfExists(`${rebuild}${WAL_SUFFIX}`)
    removeIfExists(`${rebuild}${SHM_SUFFIX}`)
    removeIfExists(backup)
    removeIfExists(`${backup}${WAL_SUFFIX}`)
    removeIfExists(`${backup}${SHM_SUFFIX}`)
    // 未提交分支：`wiki-reset.pending` 属于这次被放弃的重建，必须清掉，
    // 否则下次启动会误重置完好的旧 `wiki/`。
    removeIfExists(pending)
    return false
  }

  removeIfExists(backup)
  removeIfExists(`${backup}${WAL_SUFFIX}`)
  removeIfExists(`${backup}${SHM_SUFFIX}`)
  const wikiResetPending = existsSync(pending) ? !performWikiReset(kbDir) : false
  clearWikiStale(kbDir)
  return wikiResetPending
}

function openVerifiedConnection(kbDir: string, ensureSchema: boolean): DatabaseSync {
  const db = new DatabaseSync(dbPath(kbDir))
  try {
    assertHealthy(db)
    applyConnectionPragmas(db)
    if (ensureSchema) initializeSchema(db)
    return db
  } catch (error) {
    try {
      db.close()
    } catch {
      // 关闭失败不改变结果：损坏库一律降级为 index-error。
    }
    throw error
  }
}

/**
 * 打开（必要时创建）知识库索引库：先跑崩溃恢复，再打开、`quick_check`、
 * 应用 5 个 PRAGMA 并幂等建 Schema。任何打开/校验异常都降级为
 * `{ ok: false, code: 'index-error' }`，绝不让 `SQLITE_CORRUPT` 打崩 Worker。
 */
export function openKnowledgeDb(kbDir: string): OpenKnowledgeDbResult {
  try {
    mkdirSync(kbDir, { recursive: true, mode: PRIVATE_DIR_MODE })
  } catch (error) {
    return { ok: false, code: 'index-error', error: errorMessage(error) }
  }
  let wikiResetPending: boolean
  try {
    wikiResetPending = recoverKnowledgeDbDir(kbDir)
  } catch (error) {
    return { ok: false, code: 'index-error', error: errorMessage(error) }
  }
  try {
    const db = openVerifiedConnection(kbDir, true)
    return { ok: true, db, wikiResetPending }
  } catch (error) {
    return { ok: false, code: 'index-error', error: errorMessage(error) }
  }
}

/**
 * 提交点之后由 Worker 接管刚切换成功的新库：只做健康校验与 PRAGMA，**不重跑
 * 启动恢复**。重跑恢复会立刻续做（或误清）刚写入的 `wiki-reset.pending`，
 * 让「重试重置知识视图」失去幂等入口。
 */
export function openCommittedKnowledgeDb(kbDir: string): OpenKnowledgeDbResult {
  try {
    const db = openVerifiedConnection(kbDir, true)
    return { ok: true, db, wikiResetPending: existsSync(wikiResetPendingPath(kbDir)) }
  } catch (error) {
    return { ok: false, code: 'index-error', error: errorMessage(error) }
  }
}

// ---------------------------------------------------------------------------
// 文档与切片写入
// ---------------------------------------------------------------------------

function deleteDocumentRow(
  db: DatabaseSync,
  docId: string,
  relPath: string,
  wikiNotePath: string | null,
  nowMs: number,
): boolean {
  db.prepare('DELETE FROM chunks_fts WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE doc_id = ?)').run(docId)
  db.prepare('DELETE FROM documents WHERE doc_id = ?').run(docId)
  if (wikiNotePath === null) return false
  db.prepare(
    `INSERT INTO organize_tombstones (doc_id, rel_path, wiki_note_path, deleted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(doc_id) DO UPDATE SET rel_path = excluded.rel_path,
       wiki_note_path = excluded.wiki_note_path, deleted_at = excluded.deleted_at`,
  ).run(docId, relPath, wikiNotePath, nowMs)
  return true
}

function planForExistingDocument(db: DatabaseSync, relPath: string, input: UpsertDocumentInput): DocumentWritePlan {
  const row = db.prepare(
    `SELECT doc_id, sha256, wiki_note_path, organized_sha256, organize_attempts,
            organize_retry_after, last_organize_error
       FROM documents WHERE rel_path = ?`,
  ).get(relPath)
  if (row === undefined) {
    return {
      docId: randomUUID(),
      wikiNotePath: null,
      organizedSha256: null,
      organizeAttempts: 0,
      organizeRetryAfter: null,
      lastOrganizeError: null,
    }
  }
  const sameContent = text(row['sha256']) === input.sha256
  return {
    docId: text(row['doc_id']),
    wikiNotePath: textOrNull(row['wiki_note_path']),
    organizedSha256: sameContent && textOrNull(row['organized_sha256']) === input.sha256 ? input.sha256 : null,
    organizeAttempts: sameContent ? integer(row['organize_attempts']) : 0,
    organizeRetryAfter: sameContent ? integerOrNull(row['organize_retry_after']) : null,
    lastOrganizeError: sameContent ? textOrNull(row['last_organize_error']) : null,
  }
}

/**
 * 单文档写入（文档行 + 切片 + FTS 行，同一 `BEGIN IMMEDIATE` 事务）。
 * 切片上限按「现有总量 - 本文件旧切片 + 新切片 ≤ maxChunksPerKb」判定，超限时
 * 只裁剪新切片并把状态降级为 `partial`，不破坏既有数据。
 */
function writeDocument(
  db: DatabaseSync,
  input: UpsertDocumentInput,
  plan: DocumentWritePlan,
  maxChunksPerKb: number,
): UpsertDocumentResult {
  const now = Date.now()
  return inImmediateTransaction(db, () => {
    // 同一 rel_path 被另一 doc_id 占用（重命名猜配失败等）时，先清掉旧占用者。
    const owner = db.prepare('SELECT doc_id, wiki_note_path FROM documents WHERE rel_path = ?').get(input.relPath)
    if (owner !== undefined && text(owner['doc_id']) !== plan.docId) {
      deleteDocumentRow(db, text(owner['doc_id']), input.relPath, textOrNull(owner['wiki_note_path']), now)
    }

    const currentChunkCount = integer(db.prepare('SELECT COUNT(*) AS total FROM chunks').get()?.['total'])
    const oldDocChunkCount = integer(
      db.prepare('SELECT COUNT(*) AS total FROM chunks WHERE doc_id = ?').get(plan.docId)?.['total'],
    )
    const allowance = Math.max(0, maxChunksPerKb - (currentChunkCount - oldDocChunkCount))
    const perDocCap = Math.min(allowance, MAX_CHUNKS_PER_DOC)
    const chunks = input.chunks.slice(0, perDocCap)
    const chunkCapExceeded = chunks.length < input.chunks.length

    db.prepare('DELETE FROM chunks_fts WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE doc_id = ?)').run(plan.docId)
    db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(plan.docId)

    const status = chunkCapExceeded ? 'partial' : input.status
    const statusReason = chunkCapExceeded ? 'chunk-cap-exceeded' : (input.statusReason ?? null)
    const exists = db.prepare('SELECT 1 AS present FROM documents WHERE doc_id = ?').get(plan.docId) !== undefined
    if (exists) {
      db.prepare(
        `UPDATE documents SET rel_path = ?, norm_path = ?, sha256 = ?, size = ?, mtime_ms = ?,
           format = ?, extract_mode = ?, extract_config_hash = ?, status = ?, status_reason = ?,
           wiki_note_path = ?, organized_sha256 = ?, organize_attempts = ?, organize_retry_after = ?,
           last_organize_error = ?, updated_at = ?
         WHERE doc_id = ?`,
      ).run(
        input.relPath, input.normPath, input.sha256, input.size, input.mtimeMs,
        input.format, input.extractMode, input.extractConfigHash, status, statusReason,
        plan.wikiNotePath, plan.organizedSha256, plan.organizeAttempts, plan.organizeRetryAfter,
        plan.lastOrganizeError, now, plan.docId,
      )
    } else {
      db.prepare(
        `INSERT INTO documents (doc_id, rel_path, norm_path, sha256, size, mtime_ms, format,
           extract_mode, extract_config_hash, status, status_reason, wiki_note_path,
           organized_sha256, organize_attempts, organize_retry_after, last_organize_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        plan.docId, input.relPath, input.normPath, input.sha256, input.size, input.mtimeMs,
        input.format, input.extractMode, input.extractConfigHash, status, statusReason,
        plan.wikiNotePath, plan.organizedSha256, plan.organizeAttempts, plan.organizeRetryAfter,
        plan.lastOrganizeError, now,
      )
    }

    const insertChunk = db.prepare(
      `INSERT INTO chunks (chunk_id, doc_id, ordinal, heading_path, locator_json, content, tokenized, char_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertFts = db.prepare(
      'INSERT INTO chunks_fts (chunk_id, rel_path, heading_path, tokenized) VALUES (?, ?, ?, ?)',
    )
    // 规格 §7.2：rel_path 与 heading_path 也写预处理结果；切片正文的 tokenized
    // 由调用方（Extraction Worker）给好，存储层逐字信任、不重复分词。
    const tokenizedRelPath = tokenizeForFts(input.relPath)
    const chunkIds: string[] = []
    for (const chunk of chunks) {
      const chunkId = randomUUID()
      chunkIds.push(chunkId)
      insertChunk.run(
        chunkId, plan.docId, chunk.ordinal, chunk.headingPath,
        JSON.stringify(chunk.locator), chunk.content, chunk.tokenized, chunk.charCount,
      )
      insertFts.run(chunkId, tokenizedRelPath, tokenizeForFts(chunk.headingPath), chunk.tokenized)
    }

    return { docId: plan.docId, chunkIds, chunkCapExceeded }
  })
}

/** 入库/重索引一份文档：`rel_path` 已存在时继承 `doc_id`、`wiki` 与整理状态。 */
export function upsertDocumentWithChunks(
  db: DatabaseSync,
  input: UpsertDocumentInput,
  opts?: UpsertDocumentOptions,
): UpsertDocumentResult {
  const maxChunksPerKb = clampInteger(opts?.maxChunksPerKb, MAX_CHUNKS_PER_KB, 0, Number.MAX_SAFE_INTEGER)
  const plan = planForExistingDocument(db, input.relPath, input)
  return writeDocument(db, input, plan, maxChunksPerKb)
}

/** 仅更新 `size` / `mtime_ms`（内容与提取配置均未变的快速路径）。 */
export function updateDocumentMetadata(db: DatabaseSync, relPath: string, size: number, mtimeMs: number): void {
  db.prepare('UPDATE documents SET size = ?, mtime_ms = ?, updated_at = ? WHERE rel_path = ?').run(
    size, mtimeMs, Date.now(), relPath,
  )
}

/**
 * 1 对 1 重命名：只更新 `rel_path` / `norm_path` 与该文档 FTS 行的 `rel_path`，
 * `doc_id`、切片、向量与 `wiki/docs/<docId>.md` 全部保持不变。
 */
export function renameDocument(
  db: DatabaseSync,
  input: { readonly fromRelPath: string; readonly toRelPath: string; readonly toNormPath: string },
): { readonly renamed: boolean; readonly docId?: string } {
  const source = db.prepare('SELECT doc_id FROM documents WHERE rel_path = ?').get(input.fromRelPath)
  if (source === undefined) return { renamed: false }
  const docId = text(source['doc_id'])
  const target = db.prepare('SELECT doc_id FROM documents WHERE rel_path = ?').get(input.toRelPath)
  if (target !== undefined && text(target['doc_id']) !== docId) return { renamed: false }

  inImmediateTransaction(db, () => {
    db.prepare('UPDATE documents SET rel_path = ?, norm_path = ?, updated_at = ? WHERE doc_id = ?').run(
      input.toRelPath, input.toNormPath, Date.now(), docId,
    )
    db.prepare(
      'UPDATE chunks_fts SET rel_path = ? WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE doc_id = ?)',
    ).run(tokenizeForFts(input.toRelPath), docId)
  })
  return { renamed: true, docId }
}

/** 删除文档；带 `wiki_note_path` 时写入整理墓碑，供下一批清理旧卡片。 */
export function deleteDocument(
  db: DatabaseSync,
  relPath: string,
): { readonly deleted: boolean; readonly tombstoneWritten: boolean } {
  const row = db.prepare('SELECT doc_id, wiki_note_path FROM documents WHERE rel_path = ?').get(relPath)
  if (row === undefined) return { deleted: false, tombstoneWritten: false }
  const tombstoneWritten = inImmediateTransaction(db, () => deleteDocumentRow(
    db, text(row['doc_id']), relPath, textOrNull(row['wiki_note_path']), Date.now(),
  ))
  return { deleted: true, tombstoneWritten }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

function documentSummary(row: Record<string, SQLOutputValue>): DocumentRecordSummary {
  return {
    docId: text(row['doc_id']),
    relPath: text(row['rel_path']),
    normPath: text(row['norm_path']),
    sha256: text(row['sha256']),
    size: integer(row['size']),
    mtimeMs: integer(row['mtime_ms']),
    format: text(row['format']),
    extractMode: text(row['extract_mode']) as DocumentRecordSummary['extractMode'],
    extractConfigHash: text(row['extract_config_hash']),
    status: text(row['status']) as DocumentRecordSummary['status'],
    statusReason: textOrNull(row['status_reason']),
    wikiNotePath: textOrNull(row['wiki_note_path']),
    organizedSha256: textOrNull(row['organized_sha256']),
    organizeAttempts: integer(row['organize_attempts']),
    organizeRetryAfter: integerOrNull(row['organize_retry_after']),
    lastOrganizeError: textOrNull(row['last_organize_error']),
    updatedAt: integer(row['updated_at']),
    chunkCount: integer(row['chunk_count']),
  }
}

/**
 * 文档列表：`limit` 缺省 50、硬上限 200（规格 §7.2），`offset` 缺省 0；
 * `total` 是同一筛选条件下的命中总数。
 */
export function listDocs(db: DatabaseSync, filter?: ListDocsFilter): ListDocsResult {
  const conditions: string[] = []
  const params: SQLInputValue[] = []
  if (filter?.status !== undefined) {
    conditions.push('d.status = ?')
    params.push(filter.status)
  }
  switch (filter?.organizeState) {
    case 'organized':
      conditions.push('d.organized_sha256 IS NOT NULL AND d.organized_sha256 = d.sha256')
      break
    case 'pending':
      conditions.push(ORGANIZE_PENDING_SQL)
      break
    case 'failed':
      conditions.push(ORGANIZE_FAILED_SQL)
      break
    default:
      break
  }
  const pathQuery = filter?.pathQuery
  if (pathQuery !== undefined && pathQuery !== '') {
    conditions.push("d.rel_path LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLikePattern(pathQuery)}%`)
  }
  const whereSql = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`

  const total = integer(db.prepare(`SELECT COUNT(*) AS total FROM documents d${whereSql}`).get(...params)?.['total'])
  const limit = clampInteger(filter?.limit, LIST_DOCS_DEFAULT_LIMIT, 1, LIST_DOCS_MAX_LIMIT)
  const offset = Math.max(0, Math.trunc(filter?.offset ?? 0))
  const rows = db.prepare(
    `SELECT d.doc_id, d.rel_path, d.norm_path, d.sha256, d.size, d.mtime_ms, d.format, d.extract_mode,
            d.extract_config_hash, d.status, d.status_reason, d.wiki_note_path, d.organized_sha256,
            d.organize_attempts, d.organize_retry_after, d.last_organize_error, d.updated_at,
            (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.doc_id) AS chunk_count
       FROM documents d${whereSql}
      ORDER BY d.rel_path ASC
      LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset)
  return { total, docs: rows.map(documentSummary) }
}

/**
 * 单库全文检索的候选池（规格 §7.2）：查询经 `buildSafeFtsQuery` 剥掉运算符并
 * 逐词加引号，结果按 BM25 升序取前 `limit`（缺省 60）。
 */
export function searchFts(db: DatabaseSync, query: SearchFtsQuery): readonly SingleKbCandidate[] {
  const match = buildSafeFtsQuery(query.query)
  if (match === '') return []
  const limit = clampInteger(query.limit, SEARCH_FTS_DEFAULT_LIMIT, 1, LIST_DOCS_MAX_LIMIT)
  const rows = db.prepare(
    `SELECT c.chunk_id AS chunk_id, c.doc_id AS doc_id, c.ordinal AS ordinal,
            c.heading_path AS heading_path, c.locator_json AS locator_json, c.content AS content,
            d.rel_path AS rel_path, d.sha256 AS sha256, d.extract_config_hash AS extract_config_hash,
            d.size AS doc_size, d.mtime_ms AS doc_mtime_ms,
            bm25(chunks_fts) AS bm25
       FROM chunks_fts
       JOIN chunks c ON c.chunk_id = chunks_fts.chunk_id
       JOIN documents d ON d.doc_id = c.doc_id
      WHERE chunks_fts MATCH ?
      ORDER BY bm25 ASC, d.rel_path ASC, c.ordinal ASC
      LIMIT ?`,
  ).all(match, limit)
  return rows.map((row) => ({
    kbId: query.kbId,
    kbName: query.kbName,
    docId: text(row['doc_id']),
    relPath: text(row['rel_path']),
    sha256: text(row['sha256']),
    extractConfigHash: text(row['extract_config_hash']),
    chunkId: text(row['chunk_id']),
    ordinal: integer(row['ordinal']),
    headingPath: text(row['heading_path']),
    locator: parseLocator(row['locator_json']),
    content: text(row['content']),
    bm25: typeof row['bm25'] === 'number' ? row['bm25'] : Number(row['bm25'] ?? 0),
    docSize: integer(row['doc_size']),
    docMtimeMs: integer(row['doc_mtime_ms']),
  }))
}

function chunkWindowItem(row: Record<string, SQLOutputValue>): ChunkWindowItem {
  return {
    chunkId: text(row['chunk_id']),
    ordinal: integer(row['ordinal']),
    headingPath: text(row['heading_path']),
    locator: parseLocator(row['locator_json']),
    content: text(row['content']),
  }
}

/**
 * 带版本指纹校验的切片窗口读取（规格 §9.1）：指纹不符返回
 * `version-mismatch` 并回传当前值，文档或切片缺失返回 `chunk-missing`。
 * 结果只含存储可证明的事实（控制器裁决 M-2）。
 */
export function getChunkWithWindow(db: DatabaseSync, query: GetChunkWindowQuery): StorageGetChunkResult {
  const kbId = query.kbId ?? ''
  const row = db.prepare(
    'SELECT doc_id, rel_path, sha256, extract_config_hash, size, mtime_ms FROM documents WHERE doc_id = ?',
  ).get(query.docId)
  if (row === undefined) return { status: 'chunk-missing', kbId, docId: query.docId }

  const sha256 = text(row['sha256'])
  const extractConfigHash = text(row['extract_config_hash'])
  const shaMismatch = query.expectedSha256 !== undefined && query.expectedSha256 !== sha256
  const configMismatch = query.expectedExtractConfigHash !== undefined
    && query.expectedExtractConfigHash !== extractConfigHash
  if (shaMismatch || configMismatch) {
    return { status: 'version-mismatch', kbId, docId: query.docId, currentSha256: sha256, currentExtractConfigHash: extractConfigHash }
  }

  const window = Math.max(1, Math.trunc(query.window))
  const targetOrdinal = Math.max(0, Math.trunc(query.ordinal))
  const start = Math.max(0, targetOrdinal - Math.floor(window / 2))
  const chunks = db.prepare(
    `SELECT chunk_id, ordinal, heading_path, locator_json, content
       FROM chunks WHERE doc_id = ? AND ordinal >= ? ORDER BY ordinal ASC LIMIT ?`,
  ).all(query.docId, start, window).map(chunkWindowItem)
  if (chunks.length === 0) return { status: 'chunk-missing', kbId, docId: query.docId }

  return {
    status: 'ok',
    kbId,
    docId: query.docId,
    relPath: text(row['rel_path']),
    sha256,
    extractConfigHash,
    size: integer(row['size']),
    mtimeMs: integer(row['mtime_ms']),
    targetOrdinal,
    chunks,
  }
}

/** 按 `ordinal` 升序读取一段切片（`kb_org_read_doc` 的存储侧实现）。 */
export function getDocChunks(
  db: DatabaseSync,
  docId: string,
  startOrdinal: number,
  limit: number,
): readonly ChunkWindowItem[] {
  const start = Math.max(0, Math.trunc(startOrdinal))
  const take = Math.max(1, Math.trunc(limit))
  return db.prepare(
    `SELECT chunk_id, ordinal, heading_path, locator_json, content
       FROM chunks WHERE doc_id = ? AND ordinal >= ? ORDER BY ordinal ASC LIMIT ?`,
  ).all(docId, start, take).map(chunkWindowItem)
}

export function getStats(db: DatabaseSync): KnowledgeBaseStats {
  const counts: Record<string, number> = {}
  for (const row of db.prepare('SELECT status, COUNT(*) AS total FROM documents GROUP BY status').all()) {
    counts[text(row['status'])] = integer(row['total'])
  }
  const totalChunks = integer(db.prepare('SELECT COUNT(*) AS total FROM chunks').get()?.['total'])
  const pendingOrganizeDocs = integer(
    db.prepare(`SELECT COUNT(*) AS total FROM documents d WHERE ${ORGANIZE_PENDING_SQL}`).get()?.['total'],
  )
  const failedOrganizeDocs = integer(
    db.prepare(`SELECT COUNT(*) AS total FROM documents d WHERE ${ORGANIZE_FAILED_SQL}`).get()?.['total'],
  )
  const summary = counts['indexed'] ?? 0
  const partial = counts['partial'] ?? 0
  const skipped = counts['skipped'] ?? 0
  const errors = counts['error'] ?? 0
  return {
    totalDocs: summary + partial + skipped + errors,
    indexedDocs: summary,
    partialDocs: partial,
    skippedDocs: skipped,
    errorDocs: errors,
    pendingOrganizeDocs,
    failedOrganizeDocs,
    totalChunks,
  }
}

// ---------------------------------------------------------------------------
// 整理状态机
// ---------------------------------------------------------------------------

/**
 * 记录一次整理失败（规格 §8.1）：只有 `doc_id` 与 `sha256` 都命中才计数，
 * 第 1 次退避 60 s、第 2 次 300 s、第 3 次进入放弃状态（`retry_after = null`）。
 */
export function recordOrganizeFailure(
  db: DatabaseSync,
  input: RecordOrganizeFailureInput,
): { readonly attempts: number; readonly retryAfter: number | null } {
  const row = db.prepare(
    'SELECT sha256, organize_attempts, organize_retry_after FROM documents WHERE doc_id = ?',
  ).get(input.docId)
  if (row === undefined || text(row['sha256']) !== input.sha256) {
    return { attempts: integer(row?.['organize_attempts']), retryAfter: integerOrNull(row?.['organize_retry_after']) }
  }
  const attempts = integer(row['organize_attempts']) + 1
  let retryAfter: number | null = null
  if (attempts === 1) retryAfter = input.nowMs + ORGANIZE_RETRY_FIRST_DELAY_MS
  else if (attempts === 2) retryAfter = input.nowMs + ORGANIZE_RETRY_SECOND_DELAY_MS
  db.prepare(
    `UPDATE documents SET organize_attempts = ?, organize_retry_after = ?,
       last_organize_error = ?, updated_at = ? WHERE doc_id = ? AND sha256 = ?`,
  ).run(attempts, retryAfter, input.error, input.nowMs, input.docId, input.sha256)
  return { attempts, retryAfter }
}

/** 清零整理失败计数：给定 `docId` 只清该文档，否则清全库。 */
export function resetOrganizeFailures(db: DatabaseSync, docId?: string): void {
  const now = Date.now()
  if (docId === undefined) {
    db.prepare(
      `UPDATE documents SET organize_attempts = 0, organize_retry_after = NULL,
         last_organize_error = NULL, updated_at = ?`,
    ).run(now)
    return
  }
  db.prepare(
    `UPDATE documents SET organize_attempts = 0, organize_retry_after = NULL,
       last_organize_error = NULL, updated_at = ? WHERE doc_id = ?`,
  ).run(now, docId)
}

/**
 * `kb_org_mark_organized` 的原子落盘（规格 §8.1）：只接受
 * `docs/<docId>.md` 这个固定卡片路径，且只在 `sha256` 仍匹配时推进指纹；
 * 条件不中则不推进。墓碑只清 Agent 显式声明已处理的那几个。
 */
export function markOrganizedAtomic(db: DatabaseSync, input: MarkOrganizedInput): { readonly updated: boolean } {
  if (input.wikiNotePath !== `${WIKI_DOCS_DIRNAME}/${input.docId}.md`) return { updated: false }
  return inImmediateTransaction(db, () => {
    const changes = db.prepare(
      `UPDATE documents SET organized_sha256 = ?, wiki_note_path = ?, organize_attempts = 0,
         organize_retry_after = NULL, last_organize_error = NULL, updated_at = ?
       WHERE doc_id = ? AND sha256 = ?`,
    ).run(input.sha256, input.wikiNotePath, Date.now(), input.docId, input.sha256)
    if (input.clearedTombstones !== undefined) {
      const removeTombstone = db.prepare('DELETE FROM organize_tombstones WHERE doc_id = ?')
      for (const tombstone of input.clearedTombstones) removeTombstone.run(tombstone)
    }
    return { updated: Number(changes.changes) > 0 }
  })
}

/**
 * 下一批待整理文档（规格 §8.1/§8.2）：跳过未到退避时间或已 3 次失败的，
 * 每批最多 10 份或 80 KB 切片文本，并随批返回全部删除墓碑。
 */
export function getPendingOrganizeBatch(db: DatabaseSync, query: PendingOrganizeBatchQuery): PendingOrganizeBatch {
  const maxDocs = clampInteger(query.maxDocs, ORGANIZE_BATCH_MAX_DOCS, 1, LIST_DOCS_MAX_LIMIT)
  const maxBytes = clampInteger(query.maxBytes, ORGANIZE_BATCH_MAX_BYTES, 0, Number.MAX_SAFE_INTEGER)
  const rows = db.prepare(
    `SELECT d.doc_id AS doc_id, d.rel_path AS rel_path, d.sha256 AS sha256,
            d.wiki_note_path AS wiki_note_path,
            COALESCE((SELECT SUM(c.char_count) FROM chunks c WHERE c.doc_id = d.doc_id), 0) AS char_count
       FROM documents d
      WHERE ${ORGANIZE_PENDING_SQL}
        AND (d.organize_retry_after IS NULL OR d.organize_retry_after <= ?)
      ORDER BY d.updated_at ASC, d.rel_path ASC
      LIMIT ?`,
  ).all(query.nowMs, maxDocs)

  const docs: PendingOrganizeItem[] = []
  let bytes = 0
  for (const row of rows) {
    const charCount = integer(row['char_count'])
    if (docs.length > 0 && bytes + charCount > maxBytes) break
    bytes += charCount
    docs.push({
      docId: text(row['doc_id']),
      relPath: text(row['rel_path']),
      sha256: text(row['sha256']),
      wikiNotePath: textOrNull(row['wiki_note_path']),
      charCount,
    })
  }

  const tombstones = db.prepare(
    'SELECT doc_id, rel_path, wiki_note_path, deleted_at FROM organize_tombstones ORDER BY deleted_at ASC',
  ).all().map((row): OrganizeTombstoneRecord => ({
    docId: text(row['doc_id']),
    relPath: text(row['rel_path']),
    wikiNotePath: textOrNull(row['wiki_note_path']),
    deletedAt: integer(row['deleted_at']),
  }))

  return { docs, tombstones }
}

// ---------------------------------------------------------------------------
// 向量（M2 写入路径，M1-1 先把表与读写打通）
// ---------------------------------------------------------------------------

export function putEmbedding(
  db: DatabaseSync,
  chunkId: string,
  modelKey: string,
  dims: number,
  vector: Uint8Array,
): void {
  db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model_key, dims, vector_blob, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chunk_id, model_key) DO UPDATE SET
       dims = excluded.dims, vector_blob = excluded.vector_blob, updated_at = excluded.updated_at`,
  ).run(chunkId, modelKey, dims, vector, Date.now())
}

export function countEmbeddings(db: DatabaseSync, docId: string): number {
  return integer(db.prepare(
    `SELECT COUNT(*) AS total FROM chunk_embeddings e
       JOIN chunks c ON c.chunk_id = e.chunk_id WHERE c.doc_id = ?`,
  ).get(docId)?.['total'])
}

/** `wal_checkpoint(TRUNCATE)`：重建切换与停机前把 WAL 收进主库。 */
export function checkpoint(db: DatabaseSync): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
}

// ---------------------------------------------------------------------------
// 重建：暂存库、提交点与回滚
// ---------------------------------------------------------------------------

interface StagingState {
  readonly kbDir: string
  readonly db: DatabaseSync
  readonly snapshot: ReadonlyMap<string, RebuildSnapshotDoc>
  readonly relPaths: Set<string>
  closed: boolean
  pendingWritten: boolean
}

const stagingStates = new WeakMap<RebuildStaging, StagingState>()

/**
 * 从旧库只读抽取重建快照。旧库缺失视为「无旧映射」（正常新建）；旧库存在但
 * 打不开 / `quick_check` 失败则标记为损坏恢复重建。
 */
function readRebuildSnapshot(kbDir: string): RebuildSnapshot {
  const main = dbPath(kbDir)
  if (!existsSync(main)) return { corruptRecovery: false, docs: new Map() }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(main, { readOnly: true })
    assertHealthy(db)
    const docs = new Map<string, RebuildSnapshotDoc>()
    for (const row of db.prepare(
      'SELECT doc_id, rel_path, wiki_note_path, organized_sha256 FROM documents',
    ).all()) {
      docs.set(text(row['rel_path']), {
        docId: text(row['doc_id']),
        wikiNotePath: textOrNull(row['wiki_note_path']),
        organizedSha256: textOrNull(row['organized_sha256']),
      })
    }
    return { corruptRecovery: false, docs }
  } catch {
    return { corruptRecovery: true, docs: new Map() }
  } finally {
    if (db !== undefined) {
      try {
        db.close()
      } catch {
        // 损坏库可能无法正常关闭，忽略。
      }
    }
  }
}

/** `wiki/docs/<docId>.md` 是否为可继承 `organized_sha256` 的非空常规文件。 */
function isUsableWikiCard(kbDir: string, docId: string): boolean {
  try {
    const info = lstatSync(join(kbDir, WIKI_DIRNAME, WIKI_DOCS_DIRNAME, `${docId}.md`))
    return info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= MAX_WIKI_FILE_BYTES
  } catch {
    return false
  }
}

function removeStagingFiles(kbDir: string): void {
  const staging = rebuildDbPath(kbDir)
  removeIfExists(staging)
  removeIfExists(`${staging}${WAL_SUFFIX}`)
  removeIfExists(`${staging}${SHM_SUFFIX}`)
}

function closeStaging(state: StagingState): void {
  if (state.closed) return
  state.closed = true
  try {
    checkpoint(state.db)
  } catch {
    // 收尾 checkpoint 失败不阻断：关闭仍会尝试把 WAL 落盘。
  }
  state.db.close()
}

/**
 * 开始一次重建：在隔离文件 `index.sqlite.rebuild` 上建同 Schema/PRAGMA 的暂存
 * 库，并只读抽取旧库快照供 `doc_id` / `wiki_note_path` / `organized_sha256`
 * 继承。损坏恢复重建在返回前落盘 `wiki-reset.pending`（提交前必备）。
 */
export function beginRebuildStaging(kbDir: string): RebuildStaging {
  mkdirSync(kbDir, { recursive: true, mode: PRIVATE_DIR_MODE })
  const snapshot = readRebuildSnapshot(kbDir)
  removeStagingFiles(kbDir)
  const stagingFile = rebuildDbPath(kbDir)
  const db = new DatabaseSync(stagingFile)
  try {
    applyConnectionPragmas(db)
    initializeSchema(db)
  } catch (error) {
    try {
      db.close()
    } catch {
      // 忽略关闭失败，下面统一清理文件。
    }
    removeStagingFiles(kbDir)
    throw error
  }

  const state: StagingState = {
    kbDir,
    db,
    snapshot: snapshot.docs,
    relPaths: new Set<string>(),
    closed: false,
    pendingWritten: false,
  }

  const staging: RebuildStaging = {
    corruptRecovery: snapshot.corruptRecovery,
    upsert(input: UpsertDocumentInput): UpsertDocumentResult {
      if (state.closed) throw new Error('knowledge rebuild staging is closed')
      const inherited = state.snapshot.get(input.relPath)
      const docId = inherited?.docId ?? randomUUID()
      const plan: DocumentWritePlan = {
        docId,
        wikiNotePath: inherited?.wikiNotePath ?? null,
        organizedSha256: inherited !== undefined
          && inherited.organizedSha256 !== null
          && inherited.organizedSha256 === input.sha256
          && isUsableWikiCard(kbDir, docId)
          ? inherited.organizedSha256
          : null,
        organizeAttempts: 0,
        organizeRetryAfter: null,
        lastOrganizeError: null,
      }
      const result = writeDocument(db, input, plan, MAX_CHUNKS_PER_KB)
      state.relPaths.add(input.relPath)
      return result
    },
    abort(): void {
      abortStaging(state)
      stagingStates.delete(staging)
    },
  }
  stagingStates.set(staging, state)

  if (snapshot.corruptRecovery) {
    // 规格 §6.4：损坏恢复重建必须在进入提交点前落盘 pending。
    ensureWikiResetPendingSync(kbDir)
    state.pendingWritten = true
  }
  return staging
}

function abortStaging(state: StagingState): void {
  try {
    closeStaging(state)
  } catch {
    // 暂存库已被关闭或损坏，忽略。
  }
  removeStagingFiles(state.kbDir)
  if (state.pendingWritten) removeIfExists(wikiResetPendingPath(state.kbDir))
}

/** 放弃重建：关闭并删除暂存文件；未提交的 pending 标记一并清理。 */
export function abortRebuildStaging(kbDir: string, staging: RebuildStaging): void {
  const state = stagingStates.get(staging)
  if (state === undefined) {
    removeStagingFiles(kbDir)
    return
  }
  abortStaging(state)
  stagingStates.delete(staging)
}

/** 快照里消失且带 Wiki 卡片的文档，写入新库 `organize_tombstones`。 */
function insertVanishedTombstones(state: StagingState): void {
  const now = Date.now()
  const insert = state.db.prepare(
    `INSERT INTO organize_tombstones (doc_id, rel_path, wiki_note_path, deleted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(doc_id) DO UPDATE SET rel_path = excluded.rel_path,
       wiki_note_path = excluded.wiki_note_path, deleted_at = excluded.deleted_at`,
  )
  for (const [relPath, doc] of state.snapshot) {
    if (state.relPaths.has(relPath)) continue
    if (doc.wikiNotePath === null) continue
    insert.run(doc.docId, relPath, doc.wikiNotePath, now)
  }
}

/** Step 1：旧主库与伴随 WAL/SHM 一并移为 `.bak*`（提交前回滚零数据损失）。 */
function moveOldIndexToBackup(kbDir: string): void {
  const main = dbPath(kbDir)
  moveIfExists(main, `${main}${BACKUP_SUFFIX}`)
  moveIfExists(`${main}${WAL_SUFFIX}`, `${main}${BACKUP_SUFFIX}${WAL_SUFFIX}`)
  moveIfExists(`${main}${SHM_SUFFIX}`, `${main}${BACKUP_SUFFIX}${SHM_SUFFIX}`)
}

/** 提交前失败：把 `.bak*` 搬回主库并清掉暂存文件。 */
function restoreOldIndex(kbDir: string): void {
  const main = dbPath(kbDir)
  const backup = `${main}${BACKUP_SUFFIX}`
  if (!existsSync(main) && existsSync(backup)) {
    renameSync(backup, main)
    moveIfExists(`${backup}${WAL_SUFFIX}`, `${main}${WAL_SUFFIX}`)
    moveIfExists(`${backup}${SHM_SUFFIX}`, `${main}${SHM_SUFFIX}`)
  }
  removeIfExists(backup)
  removeIfExists(`${backup}${WAL_SUFFIX}`)
  removeIfExists(`${backup}${SHM_SUFFIX}`)
}

function removeBackups(kbDir: string): void {
  const backup = `${dbPath(kbDir)}${BACKUP_SUFFIX}`
  removeIfExists(backup)
  removeIfExists(`${backup}${WAL_SUFFIX}`)
  removeIfExists(`${backup}${SHM_SUFFIX}`)
}

function rebuildFailure(
  code: 'index-error' | 'rebuild-failed',
  error: unknown,
): CommitRebuildResult {
  return { ok: false, code, error: errorMessage(error) }
}

/**
 * 提交前失败后的收尾：暂存状态必须释放（否则下一次 begin/commit 误判重建仍在
 * 进行），文件与 pending 清理尽力而为——清理再失败也绝不能把 `rebuild-failed`
 * 变成未编码异常。残留的 `.rebuild*` 由下一次 `beginRebuildStaging` 或启动恢复
 * 清理，残留的未提交 pending 由启动恢复的未提交分支清理。
 */
function discardStagingAfterFailure(state: StagingState, staging: RebuildStaging): void {
  stagingStates.delete(staging)
  try {
    closeStaging(state)
  } catch {
    // 暂存连接已关闭或已损坏，忽略。
  }
  try {
    removeStagingFiles(state.kbDir)
  } catch {
    // 清理失败不改变提交前语义：旧库已回滚（或尽力回滚）。
  }
  if (state.pendingWritten) {
    try {
      removeIfExists(wikiResetPendingPath(state.kbDir))
    } catch {
      // 未提交的 pending 由启动恢复的未提交分支清理。
    }
  }
}

/**
 * 提交一次重建（规格 §6.4 提交点协议）：
 * 1. 暂存库 `wal_checkpoint(TRUNCATE)` 并关闭；补写消失文件的整理墓碑；
 * 2. 损坏恢复重建在提交前落盘 `wiki-reset.pending`（`0o600`）；
 * 3. Step 1 把旧 `index.sqlite(-wal/-shm)` 移为 `.bak*`；
 * 4. Step 2 `rename(index.sqlite.rebuild, index.sqlite)` 是唯一提交点；
 * 5. 提交前任何失败都回滚旧库并返回 `rebuild-failed`；
 * 6. 提交后：暂存清理只是尽力而为的警告（日志），Wiki 幂等重置 / 清理备份 /
 *    重开新库；重开失败绝不回滚旧库，返回 `index-error`。
 */
export function commitRebuildStaging(
  kbDir: string,
  staging: RebuildStaging,
  opts?: CommitRebuildOptions,
): CommitRebuildResult {
  const state = stagingStates.get(staging)
  if (state === undefined) return rebuildFailure('rebuild-failed', 'knowledge rebuild staging is not active')

  let corruptRecovery: boolean
  try {
    corruptRecovery = staging.corruptRecovery
    insertVanishedTombstones(state)
    closeStaging(state)
    if (corruptRecovery) {
      ensureWikiResetPendingSync(kbDir)
      state.pendingWritten = true
    }
  } catch (error) {
    discardStagingAfterFailure(state, staging)
    return rebuildFailure('rebuild-failed', error)
  }

  try {
    moveOldIndexToBackup(kbDir)
    opts?.failBeforeCommitPointForTest?.()
    renameSync(rebuildDbPath(kbDir), dbPath(kbDir))
  } catch (error) {
    // 提交点之前的任何失败：回滚旧库与旧 `wiki/`，清理未提交的 pending。
    try {
      restoreOldIndex(kbDir)
    } catch {
      // 回滚尽力而为；失败时仍返回明确错误由 Host 记 rebuild_failed。
    }
    discardStagingAfterFailure(state, staging)
    return rebuildFailure('rebuild-failed', error)
  }

  // Step 2 已成功：以下收尾绝不回滚新库，清理错误也不得改判为提交失败。
  stagingStates.delete(staging)
  try {
    opts?.afterCommitCleanupForTest?.()
    removeStagingFiles(kbDir)
  } catch (error) {
    // 暂存清理是提交后的 best-effort 收尾：只记录警告细节，结果仍为提交成功。
    console.warn(`[knowledge] staging cleanup failed after commit: ${errorMessage(error)}`)
  }

  opts?.afterCommitBeforeReopenForTest?.()

  let wikiResetPending = false
  if (existsSync(wikiResetPendingPath(kbDir))) {
    let resetAllowed = true
    try {
      opts?.failWikiResetOnceForTest?.()
    } catch {
      resetAllowed = false
    }
    wikiResetPending = !(resetAllowed && performWikiReset(kbDir))
  }
  try {
    removeBackups(kbDir)
    // 控制器裁决 M-31：提交返回前同步清掉任何残留 `wiki.stale*`。
    clearWikiStale(kbDir)
  } catch (error) {
    // 备份清扫同样是提交后收尾；残留 `.bak*` 由启动恢复清理。
    console.warn(`[knowledge] backup sweep failed after commit: ${errorMessage(error)}`)
  }

  let reopened: DatabaseSync
  try {
    reopened = openVerifiedConnection(kbDir, true)
  } catch (error) {
    return { ok: false, code: 'index-error', error: errorMessage(error) }
  }
  reopened.close()
  return { ok: true, corruptRecovery, wikiResetPending }
}
