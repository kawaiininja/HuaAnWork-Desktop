/**
 * Storage Worker 入口（规格 §7.1 / 计划 Task 4）。
 *
 * 唯一的 `node:sqlite` 持有者：Host 只发命令、收结果，SQLite 同步 API 全部在
 * 本线程串行执行（`DatabaseSync` 是同步的，天然串行化）。每个知识库一条连接，
 * 重建期间另有隔离的 `index.sqlite.rebuild` 暂存库。
 *
 * 首条执行语句必须是 `disableAsarArchiveView(import.meta.url)`：Worker 也会读
 * 用户目录，Electron 的 `.asar` 透明视图必须在这里关闭。
 *
 * 本文件会被测试以 `.ts` 源码直接加载（Node type-stripping），因此不得使用
 * `enum`、构造器参数属性或 `namespace`；纯类型导入必须写 `import type`，
 * 相对导入保留 `.ts` 后缀。
 */

import { existsSync, writeFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { parentPort } from 'node:worker_threads'

import { disableAsarArchiveView } from '../../asar-archive-policy.ts'
import {
  abortRebuildStaging,
  beginRebuildStaging,
  checkpoint,
  commitRebuildStaging,
  countEmbeddings,
  dbPath,
  deleteDocument,
  getChunkWithWindow,
  getDocChunks,
  getPendingOrganizeBatch,
  getStats,
  listDocs,
  markOrganizedAtomic,
  openCommittedKnowledgeDb,
  openKnowledgeDb,
  putEmbedding,
  recordOrganizeFailure,
  renameDocument,
  resetOrganizeFailures,
  retryPendingWikiReset,
  searchFts,
  updateDocumentMetadata,
  upsertDocumentWithChunks,
} from './storage-db.ts'
import type { CommitRebuildOptions, RebuildStaging } from './storage-db.ts'
import { KNOWLEDGE_TEST_CORRUPT_AFTER_COMMIT } from './storage-protocol.ts'
import type {
  StorageResultMap,
  StorageWorkerRequest,
  StorageWorkerResponse,
  StorageWorkerTestHooks,
} from './storage-protocol.ts'
import type { KnowledgeErrorCode } from './types.ts'

disableAsarArchiveView(import.meta.url)

interface OpenKbEntry {
  readonly db: DatabaseSync
  readonly kbDir: string
}

interface ActiveRebuild {
  readonly staging: RebuildStaging
  readonly kbDir: string
}

const openKbs = new Map<string, OpenKbEntry>()
const rebuilds = new Map<string, ActiveRebuild>()

function abortActiveRebuild(kbId: string): void {
  const active = rebuilds.get(kbId)
  if (active === undefined) return
  rebuilds.delete(kbId)
  try {
    abortRebuildStaging(active.kbDir, active.staging)
  } catch {
    // 关闭暂存库句柄尽力而为，避免阻断 closeKb / shutdown（I-4）。
  }
}

/** 带上可跨线程回传错误码的操作错误（不依赖 `Error.cause` 的形状）。 */
class StorageOperationError extends Error {
  readonly code: KnowledgeErrorCode | 'rebuild-failed'

  constructor(message: string, code: KnowledgeErrorCode | 'rebuild-failed') {
    super(message)
    this.name = 'StorageOperationError'
    this.code = code
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCodeOf(error: unknown): KnowledgeErrorCode | 'rebuild-failed' | undefined {
  return error instanceof StorageOperationError ? error.code : undefined
}

function respond(response: StorageWorkerResponse): void {
  parentPort?.postMessage(response)
}

function requireEntry(kbId: string): OpenKbEntry {
  const entry = openKbs.get(kbId)
  if (entry === undefined) {
    throw new StorageOperationError(`knowledge base ${kbId} is not open`, 'index-error')
  }
  return entry
}

function closeEntry(kbId: string, entry: OpenKbEntry): void {
  openKbs.delete(kbId)
  try {
    entry.db.close()
  } catch {
    // 已损坏或已关闭的连接不需要再次报错。
  }
}

function openKb(kbId: string, kbDir: string): StorageResultMap['openKb'] {
  const previous = openKbs.get(kbId)
  if (previous !== undefined) closeEntry(kbId, previous)
  const opened = openKnowledgeDb(kbDir)
  if (!opened.ok) return { ok: false, code: 'index-error', error: opened.error }
  openKbs.set(kbId, { db: opened.db, kbDir })
  return { ok: true, wikiResetPending: opened.wikiResetPending }
}

/**
 * 控制器裁决 M-1：跨线程只传布尔钩子，故障由 Worker 在 `VITEST` 环境下自行
 * 制造——Step 2 之后写入 ASCII 标记破坏新库、在 Wiki 重置里抛一次，或在
 * Step 1 之后、提交点之前抛一次。
 */
function resolveCommitTestOptions(
  kbDir: string,
  hooks: StorageWorkerTestHooks | undefined,
): CommitRebuildOptions | undefined {
  if (hooks === undefined || process.env['VITEST'] === undefined) return undefined
  const options: {
    failBeforeCommitPointForTest?: () => void
    afterCommitBeforeReopenForTest?: () => void
    failWikiResetOnceForTest?: () => void
  } = {}
  if (hooks.failBeforeCommitPoint === true) {
    options.failBeforeCommitPointForTest = (): void => {
      throw new Error('knowledge-test: forced pre-commit rebuild failure')
    }
  }
  if (hooks.afterCommitBeforeReopen === true) {
    options.afterCommitBeforeReopenForTest = (): void => {
      writeFileSync(dbPath(kbDir), KNOWLEDGE_TEST_CORRUPT_AFTER_COMMIT)
    }
  }
  if (hooks.failWikiResetOnce === true) {
    let fired = false
    options.failWikiResetOnceForTest = (): void => {
      if (fired) return
      fired = true
      throw new Error('knowledge-test: forced wiki reset failure')
    }
  }
  return options
}

async function dispatch(message: StorageWorkerRequest): Promise<StorageResultMap[keyof StorageResultMap]> {
  switch (message.op) {
    case 'openKb':
      return openKb(message.kbId, message.kbDir)
    case 'closeKb': {
      // I-4 修复：关库时同步释放该库仍在进行的重建暂存句柄，防止 Windows EBUSY 句柄泄漏。
      abortActiveRebuild(message.kbId)
      const entry = openKbs.get(message.kbId)
      if (entry !== undefined) closeEntry(message.kbId, entry)
      return undefined
    }
    case 'upsertDocument':
      return upsertDocumentWithChunks(requireEntry(message.kbId).db, message.input)
    case 'updateDocumentMetadata':
      updateDocumentMetadata(requireEntry(message.kbId).db, message.relPath, message.size, message.mtimeMs)
      return undefined
    case 'renameDocument':
      return renameDocument(requireEntry(message.kbId).db, {
        fromRelPath: message.fromRelPath,
        toRelPath: message.toRelPath,
        toNormPath: message.toNormPath,
      })
    case 'deleteDocument':
      return deleteDocument(requireEntry(message.kbId).db, message.relPath)
    case 'listDocs':
      return listDocs(requireEntry(message.kbId).db, message.filter)
    case 'searchFts':
      return searchFts(requireEntry(message.kbId).db, {
        kbId: message.kbId,
        kbName: message.kbName,
        query: message.query,
        ...(message.limit === undefined ? {} : { limit: message.limit }),
      })
    case 'getChunk':
      return getChunkWithWindow(requireEntry(message.kbId).db, {
        kbId: message.kbId,
        docId: message.docId,
        ordinal: message.ordinal,
        window: message.window,
        ...(message.expectedSha256 === undefined ? {} : { expectedSha256: message.expectedSha256 }),
        ...(message.expectedExtractConfigHash === undefined
          ? {}
          : { expectedExtractConfigHash: message.expectedExtractConfigHash }),
      })
    case 'beginRebuild': {
      abortActiveRebuild(message.kbId)
      // I-3 修复：复用已打开的 live 连接读旧库快照，避免另开只读连接受 WAL 锁冲突误判损坏。
      const liveDb = openKbs.get(message.kbId)?.db
      const staging = beginRebuildStaging(message.kbDir, liveDb)
      rebuilds.set(message.kbId, { staging, kbDir: message.kbDir })
      return { corruptRecovery: staging.corruptRecovery }
    }
    case 'upsertRebuildDocument': {
      const active = rebuilds.get(message.kbId)
      if (active === undefined) {
        throw new StorageOperationError(`knowledge rebuild for ${message.kbId} is not in progress`, 'rebuild-failed')
      }
      return active.staging.upsert(message.input)
    }
    case 'commitRebuild': {
      const active = rebuilds.get(message.kbId)
      if (active === undefined) {
        throw new StorageOperationError(`knowledge rebuild for ${message.kbId} is not in progress`, 'rebuild-failed')
      }
      const staging = active.staging
      rebuilds.delete(message.kbId)
      const entry = openKbs.get(message.kbId)
      const wasOpen = entry !== undefined
      if (entry !== undefined) {
        // Step 1 要在 Windows 上重命名主库，必须先释放本线程的旧连接。
        try {
          checkpoint(entry.db)
        } catch {
          // 旧库可能已损坏，checkpoint 失败不阻断重建。
        }
        closeEntry(message.kbId, entry)
      }
      const result = commitRebuildStaging(
        message.kbDir,
        staging,
        resolveCommitTestOptions(message.kbDir, message.testHooks),
      )
      if (result.ok) {
        const reopened = openCommittedKnowledgeDb(message.kbDir)
        if (!reopened.ok) return { ok: false, code: 'index-error', error: reopened.error }
        openKbs.set(message.kbId, { db: reopened.db, kbDir: message.kbDir })
        return result
      }
      if (result.code === 'rebuild-failed' && wasOpen && existsSync(dbPath(message.kbDir))) {
        // 规格 §6.4 step 3 / C-2：仅在旧库确实已回滚回盘上时才重新注册，绝不在主文件
        // 缺失时经 `DatabaseSync` 新建空库；回滚未完成时保留 `.bak` 与 `.rebuild` 待下次恢复。
        const reopened = openCommittedKnowledgeDb(message.kbDir)
        if (reopened.ok) openKbs.set(message.kbId, { db: reopened.db, kbDir: message.kbDir })
      }
      return result
    }
    case 'abortRebuild': {
      const active = rebuilds.get(message.kbId)
      rebuilds.delete(message.kbId)
      if (active !== undefined) abortRebuildStaging(message.kbDir, active.staging)
      return undefined
    }
    case 'retryPendingWikiReset':
      return retryPendingWikiReset(message.kbDir)
    case 'recordOrganizeFailure':
      return recordOrganizeFailure(requireEntry(message.kbId).db, {
        docId: message.docId,
        sha256: message.sha256,
        error: message.error,
        nowMs: message.nowMs,
      })
    case 'resetOrganizeFailures':
      resetOrganizeFailures(requireEntry(message.kbId).db, message.docId)
      return undefined
    case 'markOrganizedAtomic':
      return markOrganizedAtomic(requireEntry(message.kbId).db, {
        docId: message.docId,
        sha256: message.sha256,
        wikiNotePath: message.wikiNotePath,
        ...(message.clearedTombstones === undefined ? {} : { clearedTombstones: message.clearedTombstones }),
      })
    case 'getPendingOrganizeBatch':
      return getPendingOrganizeBatch(requireEntry(message.kbId).db, {
        nowMs: message.nowMs,
        ...(message.maxDocs === undefined ? {} : { maxDocs: message.maxDocs }),
        ...(message.maxBytes === undefined ? {} : { maxBytes: message.maxBytes }),
      })
    case 'getDocChunks':
      return getDocChunks(requireEntry(message.kbId).db, message.docId, message.startOrdinal, message.limit)
    case 'getStats':
      return getStats(requireEntry(message.kbId).db)
    case 'checkpoint':
      checkpoint(requireEntry(message.kbId).db)
      return undefined
    case 'putEmbedding':
      putEmbedding(
        requireEntry(message.kbId).db,
        message.chunkId,
        message.modelKey,
        message.dims,
        message.vector,
      )
      return undefined
    case 'countEmbeddings':
      return countEmbeddings(requireEntry(message.kbId).db, message.docId)
    case 'shutdown': {
      // I-4 修复：停机前必须先放弃并关闭所有在途重建暂存库，避免泄漏 SQLite 文件句柄。
      for (const kbId of [...rebuilds.keys()]) abortActiveRebuild(kbId)
      for (const kbId of [...openKbs.keys()]) {
        const entry = openKbs.get(kbId)
        if (entry !== undefined) closeEntry(kbId, entry)
      }
      // 先让响应离开，再结束本线程（这只终止 Worker，不影响宿主进程）。
      setImmediate(() => {
        process.exit(0)
      })
      return undefined
    }
    default:
      throw new StorageOperationError(`unsupported knowledge storage op: ${String((message as { op?: unknown }).op)}`, 'index-error')
  }
}

async function handle(message: StorageWorkerRequest): Promise<void> {
  try {
    const result = await dispatch(message)
    respond({ id: message.id, ok: true, result })
  } catch (error) {
    const code = errorCodeOf(error)
    respond({
      id: message.id,
      ok: false,
      ...(code === undefined ? {} : { code }),
      error: describeError(error),
    })
  }
}

// `node:sqlite` 的 API 是同步的，因此按消息到达顺序串行执行即可；
// 这里显式排队，保证异步收尾（如损坏恢复重建落盘 pending）也不会交错。
let queue: Promise<void> = Promise.resolve()

parentPort?.on('message', (message: StorageWorkerRequest) => {
  queue = queue.then(() => handle(message), () => handle(message)).catch(() => undefined)
})
