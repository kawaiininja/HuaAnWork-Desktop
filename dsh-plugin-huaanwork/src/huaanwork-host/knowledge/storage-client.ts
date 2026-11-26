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
  readonly worker: Worker
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

/**
 * 创建 Storage Worker 客户端。Worker 直到第一次真实调用才创建；同一客户端
 * 的调用按 `id` 与归属 Worker 一一对应，互不串扰（I-4 修复）。Worker 意外
 * 崩溃重启后自动重开先前已打开的知识库连接，并记忆化 `disposePromise`。
 */
export function createKnowledgeStorageClient(opts?: { workerUrl?: URL }): KnowledgeStorageClient {
  const workerUrl = opts?.workerUrl
  let worker: Worker | undefined
  let disposed = false
  let disposePromise: Promise<void> | undefined
  let nextId = 1
  const pending = new Map<number, PendingCall>()
  /** 已成功打开的库目录映射：Worker 意外崩溃拉起新实例时自动重开（I-4）。 */
  const openedKbs = new Map<string, string>()
  let needsReopen = false
  let reopenPromise: Promise<void> | undefined

  function failCallsForWorker(target: Worker, error: Error): void {
    const victims: PendingCall[] = []
    for (const [id, call] of pending) {
      if (call.worker !== target) continue
      pending.delete(id)
      victims.push(call)
    }
    for (const call of victims) call.reject(error)
  }

  function failAll(error: Error): void {
    const calls = [...pending.values()]
    pending.clear()
    for (const call of calls) call.reject(error)
  }

  function ensureWorker(): { readonly target: Worker; readonly ready: Promise<void> | undefined } {
    if (worker !== undefined) return { target: worker, ready: reopenPromise }
    const created = new Worker(workerUrl ?? resolveKnowledgeWorkerUrl('storage-worker'), {
      name: 'dsh-knowledge-storage',
    })
    created.on('message', (message: StorageWorkerResponse) => {
      const call = pending.get(message.id)
      if (call === undefined || call.worker !== created) return
      pending.delete(message.id)
      if (message.ok) {
        call.resolve(message.result)
        return
      }
      call.reject(new KnowledgeStorageError(message.error, message.code))
    })
    created.on('error', (error: Error) => {
      if (worker === created) {
        worker = undefined
        reopenPromise = undefined
        if (!disposed && openedKbs.size > 0) needsReopen = true
      }
      failCallsForWorker(created, error)
    })
    created.on('exit', (code: number) => {
      if (worker === created) {
        worker = undefined
        reopenPromise = undefined
        if (!disposed && openedKbs.size > 0) needsReopen = true
      }
      failCallsForWorker(created, new KnowledgeStorageError(`knowledge storage worker exited with code ${String(code)}`))
    })
    worker = created
    if (needsReopen && openedKbs.size > 0) {
      needsReopen = false
      const snapshot = [...openedKbs.entries()]
      const restoring = (async () => {
        for (const [kbId, kbDir] of snapshot) {
          if (disposed || worker !== created) return
          if (openedKbs.get(kbId) !== kbDir) continue
          try {
            const reopened = await send(created, id => ({ id, op: 'openKb', kbId, kbDir }))
            if (!reopened.ok && openedKbs.get(kbId) === kbDir) openedKbs.delete(kbId)
          } catch {
            // 新 Worker 在恢复途中再次崩溃时交给外层请求失败。
            return
          }
        }
      })().finally(() => {
        if (reopenPromise === restoring) reopenPromise = undefined
      })
      reopenPromise = restoring
    }
    return { target: created, ready: reopenPromise }
  }

  function send<K extends keyof StorageResultMap>(
    target: Worker,
    build: (id: number) => Extract<StorageWorkerRequest, { op: K }>,
  ): Promise<StorageResultMap[K]> {
    const id = nextId
    nextId += 1
    return new Promise<StorageResultMap[K]>((resolve, reject) => {
      pending.set(id, { worker: target, resolve: resolve as (value: unknown) => void, reject })
      try {
        target.postMessage(build(id))
      } catch (error) {
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async function request<K extends keyof StorageResultMap>(
    build: (id: number) => Extract<StorageWorkerRequest, { op: K }>,
    options?: { readonly skipReopen?: boolean },
  ): Promise<StorageResultMap[K]> {
    // 退场后绝不再拉起新线程：Host 的并行退场会与引擎停机序列交叉调用，
    // 重新 spawn 会留下永不回收的 Storage Worker。
    if (disposed) {
      throw new KnowledgeStorageError('knowledge storage client disposed')
    }
    const { target, ready } = ensureWorker()
    if (options?.skipReopen !== true && ready !== undefined) {
      await ready
      if (disposed) throw new KnowledgeStorageError('knowledge storage client disposed')
      if (worker !== target) {
        // 恢复期间新 Worker 再次退出：回退给本次调用方，不静默死循环。
        throw new KnowledgeStorageError('knowledge storage worker exited during recovery')
      }
    }
    return send(target, build)
  }

  return {
    async openKb(kbId, kbDir) {
      const result = await request(id => ({ id, op: 'openKb', kbId, kbDir }))
      if (!disposed) {
        if (result.ok) openedKbs.set(kbId, kbDir)
        else openedKbs.delete(kbId)
      }
      return result
    },
    async closeKb(kbId) {
      openedKbs.delete(kbId)
      await request(id => ({ id, op: 'closeKb', kbId }))
    },
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
    async commitRebuild(kbId, kbDir, commitOpts) {
      // 控制器裁决 M-1：函数留在 Host 进程内，跨线程只传「是否注入」的布尔。
      const testHooks = commitOpts === undefined
        ? undefined
        : {
            ...(commitOpts.afterCommitBeforeReopenForTest === undefined ? {} : { afterCommitBeforeReopen: true }),
            ...(commitOpts.failWikiResetOnceForTest === undefined ? {} : { failWikiResetOnce: true }),
            ...(commitOpts.failBeforeCommitPointForTest === undefined ? {} : { failBeforeCommitPoint: true }),
          }
      const result = await request(id => ({
        id,
        op: 'commitRebuild',
        kbId,
        kbDir,
        ...(testHooks === undefined ? {} : { testHooks }),
      }))
      if (!disposed) {
        if (result.ok) openedKbs.set(kbId, kbDir)
        else if (result.code === 'index-error') openedKbs.delete(kbId)
      }
      return result
    },
    abortRebuild: (kbId, kbDir) => request(id => ({ id, op: 'abortRebuild', kbId, kbDir })),
    retryPendingWikiReset: (kbId, kbDir) => request(id => ({ id, op: 'retryPendingWikiReset', kbId, kbDir }), { skipReopen: true }),
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
    dispose(budgetMs: number = STORAGE_CLIENT_DISPOSE_BUDGET_MS): Promise<void> {
      if (disposePromise !== undefined) return disposePromise
      disposed = true
      const current = worker
      worker = undefined
      reopenPromise = undefined
      needsReopen = false
      openedKbs.clear()
      if (current === undefined) {
        failAll(new KnowledgeStorageError('knowledge storage client disposed'))
        disposePromise = Promise.resolve()
        return disposePromise
      }
      const budget = Number.isFinite(budgetMs)
        ? Math.max(0, Math.trunc(budgetMs))
        : STORAGE_CLIENT_DISPOSE_BUDGET_MS
      disposePromise = (async () => {
        const deadline = performance.now() + budget
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
        // M-8：在总预算 `budgetMs` 内等待 `terminate()`；预算耗尽时仍立即发 `terminate()`，不超预算阻塞退场。
        const terminating = current.terminate().catch(() => undefined)
        const remaining = Math.max(0, Math.ceil(deadline - performance.now()))
        if (remaining > 0) {
          let termTimer: NodeJS.Timeout | undefined
          try {
            await Promise.race([
              terminating,
              new Promise<void>((resolve) => {
                termTimer = setTimeout(resolve, remaining)
              }),
            ])
          } finally {
            if (termTimer !== undefined) clearTimeout(termTimer)
          }
        }
      })()
      return disposePromise
    },
  }
}
