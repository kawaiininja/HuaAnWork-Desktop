/**
 * Storage Worker 的请求/结果协议（规格 §7.1 / 计划 Task 4）。
 *
 * SQLite 只存在于 Storage Worker 线程：Host 侧只构造 `StorageWorkerRequest`
 * 并按 `StorageResultMap` 消费 `StorageWorkerResponse`。本文件因此只含类型与
 * 一个 ASCII 测试标记常量，不导入 `node:sqlite`。
 *
 * 控制器裁决 M-2：`StorageGetChunkResult` 只是「存储可证明的事实」——它不带
 * `kbName` / `stale` / `sourceUnavailable` 这类 Host 运行态字段；Host（Task 7）
 * 再与 Task 1 的 `GetChunkResult` 组合。Task 1 的类型保持零修改。
 *
 * 本文件会被 Worker/测试以 `.ts` 源码直接加载（Node type-stripping），因此
 * 不得使用 `enum`、构造器参数属性或 `namespace`；纯类型导入必须写
 * `import type`。
 */

import type { SingleKbCandidate } from './ranker.ts'
import type {
  ChunkWindowItem,
  KnowledgeBaseStats,
  KnowledgeErrorCode,
  ListDocsFilter,
  ListDocsResult,
  PendingOrganizeBatch,
  UpsertDocumentInput,
} from './types.ts'

/**
 * 控制器裁决 M-1 的测试故障标记：`commitRebuild` 的 Step 2 提交点之后、
 * 重开新库之前写入 `index.sqlite`，用来确定性地制造「提交后重开失败」。
 * 仅在 `VITEST` 环境下由 Worker 自己写入，生产路径永不使用。
 */
export const KNOWLEDGE_TEST_CORRUPT_AFTER_COMMIT = 'knowledge-test-corrupt-post-commit'

/**
 * 存储层可证明的切片窗口结果（控制器裁决 M-2）：比 Task 1 的
 * `GetChunkResult` 少 `kbName`、`stale`、`sourceUnavailable` 三个 Host 运行态
 * 字段，错误分支保持一致。
 */
export type StorageGetChunkResult =
  | {
      readonly status: 'ok'
      readonly kbId: string
      readonly docId: string
      readonly relPath: string
      readonly sha256: string
      readonly extractConfigHash: string
      /** 文档索引时的字节大小与修改时间（Host 用于实时 `stale` 校验，不透出到公开 `GetChunkResult`）。 */
      readonly size: number
      readonly mtimeMs: number
      readonly targetOrdinal: number
      readonly chunks: readonly ChunkWindowItem[]
    }
  | {
      readonly status: 'kb-removed' | 'chunk-missing' | 'version-mismatch'
      readonly kbId: string
      readonly docId: string
      readonly currentSha256?: string
      readonly currentExtractConfigHash?: string
    }

/**
 * 控制器裁决 M-1：跨线程的测试注入只能是数据（`boolean`），函数留在进程内
 * 的 `storage-db.ts` API 上；Worker 在 `VITEST` 环境下按布尔自行制造故障。
 */
export interface StorageWorkerTestHooks {
  readonly afterCommitBeforeReopen?: boolean
  readonly failWikiResetOnce?: boolean
  /** Step 1 之后、Step 2 提交点之前抛出，模拟提交前重建失败。 */
  readonly failBeforeCommitPoint?: boolean
}

export type StorageWorkerRequest =
  | { readonly id: number; readonly op: 'openKb'; readonly kbId: string; readonly kbDir: string }
  | { readonly id: number; readonly op: 'closeKb'; readonly kbId: string }
  | { readonly id: number; readonly op: 'upsertDocument'; readonly kbId: string; readonly input: UpsertDocumentInput }
  | { readonly id: number; readonly op: 'updateDocumentMetadata'; readonly kbId: string; readonly relPath: string; readonly size: number; readonly mtimeMs: number }
  | { readonly id: number; readonly op: 'renameDocument'; readonly kbId: string; readonly fromRelPath: string; readonly toRelPath: string; readonly toNormPath: string }
  | { readonly id: number; readonly op: 'deleteDocument'; readonly kbId: string; readonly relPath: string }
  | { readonly id: number; readonly op: 'listDocs'; readonly kbId: string; readonly filter?: ListDocsFilter }
  | { readonly id: number; readonly op: 'searchFts'; readonly kbId: string; readonly kbName: string; readonly query: string; readonly limit?: number }
  | { readonly id: number; readonly op: 'getChunk'; readonly kbId: string; readonly docId: string; readonly ordinal: number; readonly window: number; readonly expectedSha256?: string; readonly expectedExtractConfigHash?: string }
  | { readonly id: number; readonly op: 'beginRebuild'; readonly kbId: string; readonly kbDir: string }
  | { readonly id: number; readonly op: 'upsertRebuildDocument'; readonly kbId: string; readonly input: UpsertDocumentInput }
  | { readonly id: number; readonly op: 'commitRebuild'; readonly kbId: string; readonly kbDir: string; readonly testHooks?: StorageWorkerTestHooks }
  | { readonly id: number; readonly op: 'abortRebuild'; readonly kbId: string; readonly kbDir: string }
  | { readonly id: number; readonly op: 'retryPendingWikiReset'; readonly kbId: string; readonly kbDir: string }
  | { readonly id: number; readonly op: 'recordOrganizeFailure'; readonly kbId: string; readonly docId: string; readonly sha256: string; readonly error: string; readonly nowMs: number }
  | { readonly id: number; readonly op: 'resetOrganizeFailures'; readonly kbId: string; readonly docId?: string }
  | { readonly id: number; readonly op: 'markOrganizedAtomic'; readonly kbId: string; readonly docId: string; readonly sha256: string; readonly wikiNotePath: string; readonly clearedTombstones?: readonly string[] }
  | { readonly id: number; readonly op: 'getPendingOrganizeBatch'; readonly kbId: string; readonly nowMs: number; readonly maxDocs?: number; readonly maxBytes?: number }
  | { readonly id: number; readonly op: 'getDocChunks'; readonly kbId: string; readonly docId: string; readonly startOrdinal: number; readonly limit: number }
  | { readonly id: number; readonly op: 'getStats'; readonly kbId: string }
  | { readonly id: number; readonly op: 'checkpoint'; readonly kbId: string }
  | { readonly id: number; readonly op: 'putEmbedding'; readonly kbId: string; readonly chunkId: string; readonly modelKey: string; readonly dims: number; readonly vector: Uint8Array }
  | { readonly id: number; readonly op: 'countEmbeddings'; readonly kbId: string; readonly docId: string }
  | { readonly id: number; readonly op: 'shutdown' }

export interface StorageResultMap {
  readonly openKb: { readonly ok: true; readonly wikiResetPending: boolean } | { readonly ok: false; readonly code: 'index-error'; readonly error: string }
  readonly closeKb: void
  readonly upsertDocument: { readonly docId: string; readonly chunkIds: readonly string[]; readonly chunkCapExceeded: boolean }
  readonly updateDocumentMetadata: void
  readonly renameDocument: { readonly renamed: boolean; readonly docId?: string }
  readonly deleteDocument: { readonly deleted: boolean; readonly tombstoneWritten: boolean }
  readonly listDocs: ListDocsResult
  readonly searchFts: readonly SingleKbCandidate[]
  readonly getChunk: StorageGetChunkResult
  readonly beginRebuild: { readonly corruptRecovery: boolean }
  readonly upsertRebuildDocument: { readonly docId: string; readonly chunkCapExceeded: boolean }
  readonly commitRebuild: { readonly ok: true; readonly corruptRecovery: boolean; readonly wikiResetPending: boolean } | { readonly ok: false; readonly code: 'index-error' | 'rebuild-failed'; readonly error: string }
  readonly abortRebuild: void
  readonly retryPendingWikiReset: { readonly ok: true } | { readonly ok: false; readonly error: string }
  readonly recordOrganizeFailure: { readonly attempts: number; readonly retryAfter: number | null }
  readonly resetOrganizeFailures: void
  readonly markOrganizedAtomic: { readonly updated: boolean }
  readonly getPendingOrganizeBatch: PendingOrganizeBatch
  readonly getDocChunks: readonly ChunkWindowItem[]
  readonly getStats: KnowledgeBaseStats
  readonly checkpoint: void
  readonly putEmbedding: void
  readonly countEmbeddings: number
  readonly shutdown: void
}

export type StorageWorkerResponse<K extends keyof StorageResultMap = keyof StorageResultMap> =
  | { readonly id: number; readonly ok: true; readonly result: StorageResultMap[K] }
  | { readonly id: number; readonly ok: false; readonly code?: KnowledgeErrorCode | 'rebuild-failed'; readonly error: string }
