/**
 * 知识库共享类型与硬上限（规格 §7 / 计划 Task 1）。
 *
 * 本目录的模块会被 Worker 入口以 `.ts` 源码形式直接加载（Vitest / Node
 * type-stripping），因此这里只允许可擦除的 TypeScript 语法：不得使用
 * `enum`、构造器参数属性与 `namespace`，纯类型导入必须写 `import type`。
 */

export const MAX_KNOWLEDGE_BASES = 20
export const MAX_FILES_PER_KB = 2_000
export const MAX_FILE_BYTES = 50 * 1024 * 1024
export const MAX_DOC_TEXT_BYTES = 10 * 1024 * 1024
export const MAX_CHUNKS_PER_DOC = 500
export const MAX_CHUNKS_PER_KB = 50_000
export const MAX_ZIP_TOTAL_BYTES = 50 * 1024 * 1024
export const MAX_ZIP_ENTRY_BYTES = 20 * 1024 * 1024
export const MAX_ZIP_ENTRIES = 2_000
export const MAX_WIKI_FILE_BYTES = 256 * 1024
export const MAX_WIKI_TOTAL_BYTES = 50 * 1024 * 1024
export const MAX_VISION_PDF_PAGES = 50
export const EXTRACTOR_PIPELINE_VERSION = 'm1-v1'

export interface KnowledgeBaseRecord {
  readonly id: string
  readonly name: string
  readonly sourceDir: string
  readonly autoOrganize: boolean
  readonly watchPaused: boolean
  readonly createdAt: string
}

export type KnowledgePhase =
  | 'watching'
  | 'syncing'
  | 'rebuilding'
  | 'watch-paused'
  | 'watch-failed'
  | 'source-unavailable'
  | 'index-error'
  | 'wiki-reset-pending'
  | 'waiting-turn-slot'
  | 'organizing'
  | 'blocked-no-model'
  | 'blocked-network'
  | 'quarantined-errors'

export type KnowledgeErrorCode =
  | 'knowledge-base-not-found'
  | 'knowledge-base-busy'
  | 'knowledge-base-deleting'
  | 'knowledge-base-limit-reached'
  | 'source-unavailable'
  | 'wiki-reset-pending'
  | 'index-error'
  | 'invalid-source-dir'

export type KnowledgeEventLevel = 'info' | 'warn' | 'error'

export type KnowledgeEventKind =
  | 'sync_started'
  | 'sync_completed'
  | 'file_indexed'
  | 'file_renamed'
  | 'file_deleted'
  | 'file_skipped'
  | 'file_error'
  | 'source_rebound'
  | 'rebuild_completed'
  | 'rebuild_failed'
  | 'wiki_reset_failed'
  | 'organize_started'
  | 'organize_completed'
  | 'organize_failed'
  | 'organize_cancelled'
  | 'source_unavailable'
  | 'source_restored'
  | 'watch_failed'
  | 'cloud_probe_unavailable'

export interface KnowledgeEventRecord {
  readonly id: string
  readonly at: string
  readonly kind: KnowledgeEventKind
  readonly level: KnowledgeEventLevel
  readonly summary: string
  readonly detail?: string
  readonly relPath?: string
  readonly count?: number
}

export type ChunkLocator =
  | { readonly kind: 'line'; readonly startLine: number; readonly endLine: number }
  | { readonly kind: 'section'; readonly section: string }
  | { readonly kind: 'sheet'; readonly sheet: string; readonly rowStart: number; readonly rowEnd: number }
  | { readonly kind: 'slide'; readonly slide: number }
  | { readonly kind: 'page'; readonly page: number; readonly mode: 'text' | 'vision' }
  | { readonly kind: 'image' }
  | { readonly kind: 'file' }

export interface ExtractedSection {
  readonly headingPath: string
  readonly locator: ChunkLocator
  readonly text: string
  readonly headerRow?: string
}

export interface ExtractedDocument {
  readonly format: string
  readonly extractMode: 'text' | 'vision' | 'mixed' | 'none'
  readonly extractConfigHash: string
  readonly status: 'indexed' | 'partial' | 'skipped' | 'error'
  readonly statusReason?: string
  readonly sections: readonly ExtractedSection[]
  readonly totalPages?: number
  readonly parsedPages?: number
}

export interface ChunkDraft {
  readonly ordinal: number
  readonly headingPath: string
  readonly locator: ChunkLocator
  readonly content: string
  readonly tokenized: string
  readonly charCount: number
}

export interface UpsertDocumentInput {
  readonly relPath: string
  readonly normPath: string
  readonly sha256: string
  readonly size: number
  readonly mtimeMs: number
  readonly format: string
  readonly extractMode: 'text' | 'vision' | 'mixed' | 'none'
  readonly extractConfigHash: string
  readonly status: 'indexed' | 'partial' | 'skipped' | 'error'
  readonly statusReason?: string
  readonly chunks: readonly ChunkDraft[]
}

export interface DocumentRecordSummary {
  readonly docId: string
  readonly relPath: string
  readonly normPath: string
  readonly sha256: string
  readonly size: number
  readonly mtimeMs: number
  readonly format: string
  readonly extractMode: 'text' | 'vision' | 'mixed' | 'none'
  readonly extractConfigHash: string
  readonly status: 'indexed' | 'partial' | 'skipped' | 'error'
  readonly statusReason: string | null
  readonly wikiNotePath: string | null
  readonly organizedSha256: string | null
  readonly organizeAttempts: number
  readonly organizeRetryAfter: number | null
  readonly lastOrganizeError: string | null
  readonly updatedAt: number
  readonly chunkCount: number
}

export interface ListDocsFilter {
  readonly status?: 'indexed' | 'partial' | 'skipped' | 'error'
  readonly organizeState?: 'pending' | 'organized' | 'failed'
  readonly pathQuery?: string
  /** 默认 50，硬上限 200（规格 §7.2）。 */
  readonly limit?: number
  readonly offset?: number
}

export interface ListDocsResult {
  readonly total: number
  readonly docs: readonly DocumentRecordSummary[]
}

export interface ChunkWindowItem {
  readonly chunkId: string
  readonly ordinal: number
  readonly headingPath: string
  readonly locator: ChunkLocator
  readonly content: string
}

export type GetChunkResult =
  | {
      readonly status: 'ok'
      readonly kbId: string
      readonly kbName: string
      readonly docId: string
      readonly relPath: string
      readonly sha256: string
      readonly extractConfigHash: string
      readonly stale: boolean
      readonly sourceUnavailable: boolean
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

export interface KnowledgeBaseStats {
  readonly totalDocs: number
  readonly indexedDocs: number
  readonly partialDocs: number
  readonly skippedDocs: number
  readonly errorDocs: number
  readonly pendingOrganizeDocs: number
  readonly failedOrganizeDocs: number
  readonly totalChunks: number
}

export interface KnowledgeBaseSummary extends KnowledgeBaseRecord {
  readonly phase: KnowledgePhase
  readonly stats: KnowledgeBaseStats
  readonly lastSyncedAt?: string
  readonly lastError?: string
  readonly syncingProgress?: { readonly completed: number; readonly total: number }
  readonly organizeProgress?: { readonly currentBatch: number; readonly totalBatches: number }
}

export interface OrganizeTombstoneRecord {
  readonly docId: string
  readonly relPath: string
  readonly wikiNotePath: string | null
  readonly deletedAt: number
}

export interface PendingOrganizeItem {
  readonly docId: string
  readonly relPath: string
  readonly sha256: string
  readonly wikiNotePath: string | null
  readonly charCount: number
}

export interface PendingOrganizeBatch {
  readonly docs: readonly PendingOrganizeItem[]
  readonly tombstones: readonly OrganizeTombstoneRecord[]
}
