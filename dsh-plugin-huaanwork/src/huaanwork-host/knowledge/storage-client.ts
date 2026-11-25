/**
 * Storage Worker 的 Host 侧客户端（规格 §7.1 / 计划 Task 4）。
 *
 * 惰性拉起：0 次调用不创建线程。每次调用构造一个带自增 `id` 的
 * `StorageWorkerRequest`，按 `id` 匹配 `StorageWorkerResponse`；Worker 崩溃时
 * 所有在途 Promise 立即失败，绝不悬挂。
 *
 * 本文件只依赖 `node:worker_threads`（不导入 `node:sqlite`），Host 线程因此
 * 永远不接触 SQLite。相对导入保留 `.ts` 后缀以适配 type-stripping。
 */

import { Worker } from 'node:worker_threads'

import type { SingleKbCandidate } from './ranker.ts'
import type {
  StorageGetChunkResult,
  StorageResultMap,
  StorageWorkerRequest,
  StorageWorkerResponse,
} from './storage-protocol.ts'
import type {
  ChunkWindowItem,
  KnowledgeBaseStats,
  KnowledgeErrorCode,
  ListDocsFilter,
  ListDocsResult,
  PendingOrganizeBatch,
  UpsertDocumentInput,
} from './types.ts'
import { resolveKnowledgeWorkerUrl } from './worker-paths.ts'

/** 优雅退场预算：到期直接 `terminate()`（控制器裁决 M-18）。 */
export const STORAGE_CLIENT_DISPOSE_BUDGET_MS = 900

/** 提交点故障注入（进程内函数形态，客户端转成跨线程布尔钩子）。 */
export interface CommitRebuildTestOptions {
  readonly afterCommitBeforeReopenForTest?: () => void
  readonly failWikiResetOnceForTest?: () => void
  readonly failBeforeCommitPointForTest?: () => void
}

/** Worker 回传的操作错误，保留可路由的错误码。 */
export class KnowledgeStorageError extends Error {
  readonly code: KnowledgeErrorCode | 'rebuild-failed' | undefined

  constructor(message: string, code?: KnowledgeErrorCode | 'rebuild-failed') {
    super(message)
    this.name = 'KnowledgeStorageError'
    this.code = code
  }
}

export interface KnowledgeStorageClient {
  openKb(kbId: string, kbDir: string): Promise<StorageResultMap['openKb']>
  closeKb(kbId: string): Promise<void>
  upsertDocument(kbId: string, input: UpsertDocumentInput): Promise<StorageResultMap['upsertDocument']>
  updateDocumentMetadata(kbId: string, relPath: string, size: number, mtimeMs: number): Promise<void>
  renameDocument(kbId: string, input: { fromRelPath: string; toRelPath: string; toNormPath: string }): Promise<StorageResultMap['renameDocument']>
  deleteDocument(kbId: string, relPath: string): Promise<StorageResultMap['deleteDocument']>
  listDocs(kbId: string, filter?: ListDocsFilter): Promise<ListDocsResult>
  searchFts(kbId: string, kbName: string, query: string, limit?: number): Promise<readonly SingleKbCandidate[]>
  getChunk(kbId: string, query: { docId: string; ordinal: number; window: number; expectedSha256?: string; expectedExtractConfigHash?: string }): Promise<StorageGetChunkResult>
  beginRebuild(kbId: string, kbDir: string): Promise<StorageResultMap['beginRebuild']>
  upsertRebuildDocument(kbId: string, input: UpsertDocumentInput): Promise<StorageResultMap['upsertRebuildDocument']>
  commitRebuild(kbId: string, kbDir: string, opts?: CommitRebuildTestOptions): Promise<StorageResultMap['commitRebuild']>
  abortRebuild(kbId: string, kbDir: string): Promise<void>
  retryPendingWikiReset(kbId: string, kbDir: string): Promise<StorageResultMap['retryPendingWikiReset']>
  recordOrganizeFailure(kbId: string, docId: string, sha256: string, error: string, nowMs: number): Promise<StorageResultMap['recordOrganizeFailure']>
  resetOrganizeFailures(kbId: string, docId?: string): Promise<void>
  markOrganizedAtomic(kbId: string, docId: string, sha256: string, wikiNotePath: string, clearedTombstones?: readonly string[]): Promise<StorageResultMap['markOrganizedAtomic']>
  getPendingOrganizeBatch(kbId: string, nowMs: number, opts?: { maxDocs?: number; maxBytes?: number }): Promise<PendingOrganizeBatch>
  getDocChunks(kbId: string, docId: string, startOrdinal: number, limit: number): Promise<readonly ChunkWindowItem[]>
  getStats(kbId: string): Promise<KnowledgeBaseStats>
  checkpoint(kbId: string): Promise<void>
  putEmbedding(kbId: string, chunkId: string, modelKey: string, dims: number, vector: Uint8Array): Promise<void>
  countEmbeddings(kbId: string, docId: string): Promise<number>
  isRunning(): boolean
  dispose(budgetMs?: number): Promise<void>
}

interface PendingCall {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

/**
 * 创建 Storage Worker 客户端。Worker 直到第一次真实调用才创建；同一客户端
 * 的调用按 `id` 一一对应，互不阻塞。
 */
export function createKnowledgeStorageClient(opts?: { workerUrl?: URL }): KnowledgeStorageClient {
  const workerUrl = opts?.workerUrl
  let worker: Worker | undefined
  let disposed = false
  let nextId = 1
  const pending = new Map<number, PendingCall>()

  function failAll(error: Error): void {
    const calls = [...pending.values()]
    pending.clear()
    for (const call of calls) call.reject(error)
  }

  function ensureWorker(): Worker {
    if (worker !== undefined) return worker
    const created = new Worker(workerUrl ?? resolveKnowledgeWorkerUrl('storage-worker'), {
      name: 'dsh-knowledge-storage',
    })
    created.on('message', (message: StorageWorkerResponse) => {
      const call = pending.get(message.id)
      if (call === undefined) return
      pending.delete(message.id)
      if (message.ok) {
        call.resolve(message.result)
        return
      }
      call.reject(new KnowledgeStorageError(message.error, message.code))
    })
    created.on('error', (error: Error) => {
      if (worker === created) worker = undefined
      failAll(error)
    })
    created.on('exit', (code: number) => {
      if (worker === created) worker = undefined
      failAll(new KnowledgeStorageError(`knowledge storage worker exited with code ${String(code)}`))
    })
    worker = created
    return created
  }

  function send<K extends keyof StorageResultMap>(
    target: Worker,
    build: (id: number) => Extract<StorageWorkerRequest, { op: K }>,
  ): Promise<StorageResultMap[K]> {
    const id = nextId
    nextId += 1
    return new Promise<StorageResultMap[K]>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      try {
        target.postMessage(build(id))
      } catch (error) {
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  function request<K extends keyof StorageResultMap>(
    build: (id: number) => Extract<StorageWorkerRequest, { op: K }>,
  ): Promise<StorageResultMap[K]> {
    // 退场后绝不再拉起新线程：Host 的并行退场会与引擎停机序列交叉调用，
    // 重新 spawn 会留下永不回收的 Storage Worker。
    if (disposed) {
      return Promise.reject(new KnowledgeStorageError('knowledge storage client disposed'))
    }
    return send(ensureWorker(), build)
  }

  return {
    openKb: (kbId, kbDir) => request(id => ({ id, op: 'openKb', kbId, kbDir })),
    closeKb: (kbId) => request(id => ({ id, op: 'closeKb', kbId })),
    upsertDocument: (kbId, input) => request(id => ({ id, op: 'upsertDocument', kbId, input })),
    updateDocumentMetadata: (kbId, relPath, size, mtimeMs) => request(
      id => ({ id, op: 'updateDocumentMetadata', kbId, relPath, size, mtimeMs }),
    ),
    renameDocument: (kbId, input) => request(id => ({
      id,
      op: 'renameDocument',
      kbId,
      fromRelPath: input.fromRelPath,
      toRelPath: input.toRelPath,
      toNormPath: input.toNormPath,
    })),
    deleteDocument: (kbId, relPath) => request(id => ({ id, op: 'deleteDocument', kbId, relPath })),
    listDocs: (kbId, filter) => request(id => ({
      id,
      op: 'listDocs',
      kbId,
      ...(filter === undefined ? {} : { filter }),
    })),
    searchFts: (kbId, kbName, query, limit) => request(id => ({
      id,
      op: 'searchFts',
      kbId,
      kbName,
      query,
      ...(limit === undefined ? {} : { limit }),
    })),
    getChunk: (kbId, query) => request(id => ({
      id,
      op: 'getChunk',
      kbId,
      docId: query.docId,
      ordinal: query.ordinal,
      window: query.window,
      ...(query.expectedSha256 === undefined ? {} : { expectedSha256: query.expectedSha256 }),
      ...(query.expectedExtractConfigHash === undefined
        ? {}
        : { expectedExtractConfigHash: query.expectedExtractConfigHash }),
    })),
    beginRebuild: (kbId, kbDir) => request(id => ({ id, op: 'beginRebuild', kbId, kbDir })),
    upsertRebuildDocument: (kbId, input) => request(id => ({ id, op: 'upsertRebuildDocument', kbId, input })),
    commitRebuild: (kbId, kbDir, commitOpts) => {
      // 控制器裁决 M-1：函数留在 Host 进程内，跨线程只传「是否注入」的布尔。
      const testHooks = commitOpts === undefined
        ? undefined
        : {
            ...(commitOpts.afterCommitBeforeReopenForTest === undefined ? {} : { afterCommitBeforeReopen: true }),
            ...(commitOpts.failWikiResetOnceForTest === undefined ? {} : { failWikiResetOnce: true }),
            ...(commitOpts.failBeforeCommitPointForTest === undefined ? {} : { failBeforeCommitPoint: true }),
          }
      return request(id => ({
        id,
        op: 'commitRebuild',
        kbId,
        kbDir,
        ...(testHooks === undefined ? {} : { testHooks }),
      }))
    },
    abortRebuild: (kbId, kbDir) => request(id => ({ id, op: 'abortRebuild', kbId, kbDir })),
    retryPendingWikiReset: (kbId, kbDir) => request(id => ({ id, op: 'retryPendingWikiReset', kbId, kbDir })),
    recordOrganizeFailure: (kbId, docId, sha256, error, nowMs) => request(id => ({
      id,
      op: 'recordOrganizeFailure',
      kbId,
      docId,
      sha256,
      error,
      nowMs,
    })),
    resetOrganizeFailures: (kbId, docId) => request(id => ({
      id,
      op: 'resetOrganizeFailures',
      kbId,
      ...(docId === undefined ? {} : { docId }),
    })),
    markOrganizedAtomic: (kbId, docId, sha256, wikiNotePath, clearedTombstones) => request(id => ({
      id,
      op: 'markOrganizedAtomic',
      kbId,
      docId,
      sha256,
      wikiNotePath,
      ...(clearedTombstones === undefined ? {} : { clearedTombstones }),
    })),
    getPendingOrganizeBatch: (kbId, nowMs, batchOpts) => request(id => ({
      id,
      op: 'getPendingOrganizeBatch',
      kbId,
      nowMs,
      ...(batchOpts?.maxDocs === undefined ? {} : { maxDocs: batchOpts.maxDocs }),
      ...(batchOpts?.maxBytes === undefined ? {} : { maxBytes: batchOpts.maxBytes }),
    })),
    getDocChunks: (kbId, docId, startOrdinal, limit) => request(id => ({
      id,
      op: 'getDocChunks',
      kbId,
      docId,
      startOrdinal,
      limit,
    })),
    getStats: (kbId) => request(id => ({ id, op: 'getStats', kbId })),
    checkpoint: (kbId) => request(id => ({ id, op: 'checkpoint', kbId })),
    putEmbedding: (kbId, chunkId, modelKey, dims, vector) => request(id => ({
      id,
      op: 'putEmbedding',
      kbId,
      chunkId,
      modelKey,
      dims,
      vector,
    })),
    countEmbeddings: (kbId, docId) => request(id => ({ id, op: 'countEmbeddings', kbId, docId })),
    isRunning: () => worker !== undefined,
    async dispose(budgetMs: number = STORAGE_CLIENT_DISPOSE_BUDGET_MS): Promise<void> {
      if (disposed) return
      disposed = true
      const current = worker
      if (current === undefined) return
      worker = undefined
      const budget = Math.max(0, Math.trunc(budgetMs))
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budget)
      })
      try {
        await Promise.race([
          send(current, id => ({ id, op: 'shutdown' })).catch(() => undefined),
          timeout,
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      failAll(new KnowledgeStorageError('knowledge storage client disposed'))
      await current.terminate().catch(() => undefined)
    },
  }
}
