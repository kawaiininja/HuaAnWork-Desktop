/**
 * 知识库 Host 门面（规格 §5.2 / §6 / §7 / §10 / §11.1；计划 Task 7）。
 *
 * 本门面只做编排：注册表原子读写、0 库惰性启动、20 库上限、命中 `stale` /
 * `sourceUnavailable` 的实时 `stat` 组合，以及 ≤ 1 秒的并行退场。所有同步状态机
 * 都在 Task 6 `sync-engine` 内（`startKb` / `stopKb` / `shutdownKbForDelete` /
 * `pauseWatch` / `resumeWatch` / `syncNow` / `rebindSourceDir` / `rebuildIndex` /
 * `acquireLifecycleLock`），本文件绝不复制停机序列或重建状态机。
 *
 * 惰性启动：`start()` 只读取 `knowledge-bases.json`；注册表为空时不创建
 * Storage Worker 或 Extraction Worker 线程，`dispose()` 因此立即完成。
 *
 * 本文件会在 Host 线程以 `.ts` 源码/构建产物两种形态加载，保持可擦除
 * TypeScript 语法；纯类型导入必须写 `import type`，相对导入保留 `.ts` 后缀。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { readKnowledgeEvents } from './events.ts'
import type { KnowledgeEventFilter } from './events.ts'
import {
  createExtractionPool,
  EXTRACTION_POOL_DISPOSE_BUDGET_MS,
} from './extraction-pool.ts'
import type { ExtractionPool } from './extraction-pool.ts'
import { validateSourceDir } from './paths.ts'
import { mergeMultiKbResults, rerankSingleKbCandidates } from './ranker.ts'
import type { SingleKbCandidate } from './ranker.ts'
import { readKnowledgeBases, writeKnowledgeBases } from './registry.ts'
import { createKnowledgeStorageClient } from './storage-client.ts'
import type { KnowledgeStorageClient } from './storage-client.ts'
import { createKnowledgeSyncEngine, KnowledgeSyncError } from './sync-engine.ts'
import type { KnowledgeSyncEngine, SyncWatchFactory } from './sync-engine.ts'
import { MAX_KNOWLEDGE_BASES } from './types.ts'
import type {
  ChunkLocator,
  DocumentRecordSummary,
  GetChunkResult,
  KnowledgeBaseRecord,
  KnowledgeBaseStats,
  KnowledgeBaseSummary,
  KnowledgeEventRecord,
  ListDocsFilter,
  ListDocsResult,
} from './types.ts'
import { neutralKnowledgeRootPath } from '../workspace-state.ts'

/** 退场外层兜底：单库停机 + 存储关库 + Worker terminate 必须在 1,000 ms 内落定。 */
export const DEFAULT_KNOWLEDGE_DISPOSE_BUDGET_MS = 950
/** Storage Worker 优雅关库预算（控制器裁决 M-18：800 ms）。 */
const STORAGE_DISPOSE_BUDGET_MS = 800
/** `getChunk` 缺省窗口大小（目标 ordinal 前后各取一部分）。 */
const DEFAULT_GET_CHUNK_WINDOW = 3
/** 单库检索召回上限（服务端重排前）。 */
const SEARCH_FTS_LIMIT = 200
/** 搜索建议摘录长度（字符）。 */
const SEARCH_EXCERPT_MAX_CHARS = 200
/** 按 `pathQuery` 反查文档元数据时的分页上限（listDocs 硬上限 200）。 */
const DOC_LOOKUP_LIMIT = 200

const ZERO_STATS: KnowledgeBaseStats = {
  totalDocs: 0,
  indexedDocs: 0,
  partialDocs: 0,
  skippedDocs: 0,
  errorDocs: 0,
  pendingOrganizeDocs: 0,
  failedOrganizeDocs: 0,
  totalChunks: 0,
}

/** 检索结果（锁定 M1-3 引用面消费契约）。 */
export interface KnowledgeSearchHit {
  readonly kbId: string
  readonly kbName: string
  readonly docId: string
  readonly relPath: string
  readonly sha256: string
  readonly extractConfigHash: string
  readonly chunkId: string
  readonly ordinal: number
  readonly headingPath: string
  readonly locator: ChunkLocator
  readonly excerpt: string
  readonly score: number
  readonly stale: boolean
  readonly sourceUnavailable: boolean
  readonly searchMode: 'fts' | 'fts-backfilling' | 'fts-fallback' | 'hybrid'
}

export interface CreateKnowledgeHostOptions {
  readonly profileDir: string
  readonly maxKnowledgeBases?: number
  readonly disposeBudgetMs?: number
  readonly debounceMs?: number
  readonly writeStableMs?: number
  readonly reconcileIntervalMs?: number
  readonly watchFactory?: SyncWatchFactory
  readonly storageOverrideForTest?: KnowledgeStorageClient
  readonly poolOverrideForTest?: ExtractionPool
  readonly afterCommitBeforeReopenForTest?: () => void
  readonly failWikiResetOnceForTest?: () => void
}

/** M1-2 注入的整理钩子（本任务只负责在维护/删库/退场时回调）。 */
export interface KnowledgeOrganizerHooks {
  cancelForKb(kbId: string): Promise<void>
  cancelAll(): Promise<void>
  notifyPending?(kbId: string): void
}

export interface KnowledgeHost {
  start(): Promise<void>
  list(): Promise<readonly KnowledgeBaseSummary[]>
  get(kbId: string): KnowledgeBaseSummary | undefined
  create(input: { name: string; sourceDir: string; autoOrganize?: boolean }): Promise<KnowledgeBaseRecord>
  update(kbId: string, patch: { name?: string; sourceDir?: string; autoOrganize?: boolean; watchPaused?: boolean }): Promise<KnowledgeBaseRecord>
  remove(kbId: string): Promise<void>
  sync(kbId: string): Promise<void>
  rebuild(kbId: string): Promise<void>
  listDocs(kbId: string, filter?: ListDocsFilter): Promise<ListDocsResult>
  search(input: { kbIds: readonly string[]; query: string; topK?: number }): Promise<readonly KnowledgeSearchHit[]>
  getChunk(input: { kbId: string; docId: string; ordinal: number; window?: number; expectedSha256?: string; expectedExtractConfigHash?: string }): Promise<GetChunkResult>
  getEvents(kbId: string, opts?: { limit?: number; filter?: KnowledgeEventFilter }): Promise<readonly KnowledgeEventRecord[]>
  handleSystemResume(): Promise<void>
  onSystemResume(listener: () => void): () => void
  /** M1-2 注入：维护/删库/退场时取消该库在途整理并 await 单槽释放。 */
  setOrganizerHooks(hooks: KnowledgeOrganizerHooks): void
  /** M1-3 注入：删库完成后清理会话挂载。 */
  setRemovalHook(hook: (kbId: string) => Promise<void>): void
  isWorkersRunning(): boolean
  isWatchingForTest(kbId: string): boolean
  dispose(): Promise<void>
}

function normalizeCap(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_KNOWLEDGE_BASES
  return Math.max(0, Math.trunc(value))
}

/**
 * 创建知识库 Host 门面。构造本身零副作用（除 sync-engine 的周期计时器外）：
 * Worker 线程直到 `start()` 遇到已注册知识库或首个 API 调用才按需拉起。
 */
export function createKnowledgeHost(opts: CreateKnowledgeHostOptions): KnowledgeHost {
  const profileDir = opts.profileDir
  const maxKnowledgeBases = normalizeCap(opts.maxKnowledgeBases)
  const disposeBudgetMs = Math.max(1, Math.trunc(opts.disposeBudgetMs ?? DEFAULT_KNOWLEDGE_DISPOSE_BUDGET_MS))

  const storage: KnowledgeStorageClient = opts.storageOverrideForTest ?? createKnowledgeStorageClient()
  const pool: ExtractionPool = opts.poolOverrideForTest ?? createExtractionPool()

  const records = new Map<string, KnowledgeBaseRecord>()
  const statsCache = new Map<string, KnowledgeBaseStats>()
  const deletingIds = new Set<string>()
  const maintainingIds = new Set<string>()
  const resumeListeners = new Set<() => void>()

  let organizerHooks: KnowledgeOrganizerHooks | undefined
  let removalHook: ((kbId: string) => Promise<void>) | undefined
  let disposed = false
  let startPromise: Promise<void> | undefined
  let disposePromise: Promise<void> | undefined
  /** 注册表写入串行化：任务执行时才快照 `records`，后一次写总带上前一次的内存变更。 */
  let registryChain: Promise<unknown> = Promise.resolve()
  /** create 串行化：限制检查与注册表写入不被并发 create 绕过/覆盖。 */
  let createChain: Promise<unknown> = Promise.resolve()

  const engine: KnowledgeSyncEngine = createKnowledgeSyncEngine({
    profileDir,
    storage,
    pool,
    // 控制器裁决 M-4：整理取消也委托引擎停机序列；钩子可在 start 前后注入。
    cancelOrganizerForKb: async (kbId: string) => {
      await organizerHooks?.cancelForKb(kbId)
    },
    ...(opts.debounceMs === undefined ? {} : { debounceMs: opts.debounceMs }),
    ...(opts.writeStableMs === undefined ? {} : { writeStableMs: opts.writeStableMs }),
    ...(opts.reconcileIntervalMs === undefined ? {} : { reconcileIntervalMs: opts.reconcileIntervalMs }),
    ...(opts.watchFactory === undefined ? {} : { watchFactory: opts.watchFactory }),
    ...(opts.afterCommitBeforeReopenForTest === undefined
      ? {}
      : { afterCommitBeforeReopenForTest: opts.afterCommitBeforeReopenForTest }),
    ...(opts.failWikiResetOnceForTest === undefined
      ? {}
      : { failWikiResetOnceForTest: opts.failWikiResetOnceForTest }),
  })

  function requireRecord(kbId: string): KnowledgeBaseRecord {
    const record = records.get(kbId)
    if (record === undefined) {
      throw new KnowledgeSyncError('knowledge-base-not-found', `knowledge base ${kbId} is not registered`)
    }
    return record
  }

  function assertNotDeleting(kbId: string): void {
    if (deletingIds.has(kbId)) {
      throw new KnowledgeSyncError('knowledge-base-deleting', `knowledge base ${kbId} is being deleted`)
    }
  }

  function assertNotMaintaining(kbId: string): void {
    if (maintainingIds.has(kbId)) {
      throw new KnowledgeSyncError('knowledge-base-busy', `knowledge base ${kbId} is under maintenance`)
    }
  }

  /** 原子写回 `knowledge-bases.json`：执行时快照内存记录，按宿主队列串行。 */
  function persistRegistry(): Promise<void> {
    const run = registryChain.then(
      () => writeKnowledgeBases(profileDir, [...records.values()]),
      () => writeKnowledgeBases(profileDir, [...records.values()]),
    )
    registryChain = run.catch(() => undefined)
    return run
  }

  function composeSummary(record: KnowledgeBaseRecord): KnowledgeBaseSummary {
    const state = engine.getState(record.id)
    const stats = statsCache.get(record.id) ?? ZERO_STATS
    return {
      ...record,
      phase: state?.phase ?? (record.watchPaused ? 'watch-paused' : 'watching'),
      stats,
      ...(state?.lastSyncedAt === undefined ? {} : { lastSyncedAt: state.lastSyncedAt }),
      ...(state?.lastError === undefined ? {} : { lastError: state.lastError }),
    }
  }

  async function refreshStats(kbId: string): Promise<KnowledgeBaseStats> {
    try {
      const stats = await storage.getStats(kbId)
      statsCache.set(kbId, stats)
      return stats
    } catch {
      const cached = statsCache.get(kbId) ?? ZERO_STATS
      return cached
    }
  }

  /** 源目录是否已不可访问（缺失/非目录/无权限）：`stat` 一次，绝不读内容。 */
  async function sourceUnavailableFor(record: KnowledgeBaseRecord): Promise<boolean> {
    try {
      const info = await stat(record.sourceDir)
      return !info.isDirectory()
    } catch {
      return true
    }
  }

  /**
   * 命中切片的实时 `stale` 判定：先查索引记录的 `(size, trunc(mtimeMs))`，再对
   * 源文件做一次异步 `stat` 比较；源目录不可访问时只报 `sourceUnavailable`，
   * 仍返回已索引片段（控制器裁决 M-2 / 规格 §7.2）。
   */
  async function staleForDoc(
    record: KnowledgeBaseRecord,
    doc: Pick<DocumentRecordSummary, 'docId' | 'relPath' | 'size' | 'mtimeMs'>,
    sourceUnavailable: boolean,
  ): Promise<boolean> {
    if (sourceUnavailable) return false
    try {
      const info = await stat(join(record.sourceDir, doc.relPath))
      if (!info.isFile()) return true
      return info.size !== doc.size || Math.trunc(info.mtimeMs) !== Math.trunc(doc.mtimeMs)
    } catch {
      return true
    }
  }

  /** 按 `rel_path` 反查文档元数据（Storage 侧只暴露 listDocs 的聚合计）。 */
  async function lookupDocMeta(
    kbId: string,
    docId: string,
    relPath: string,
  ): Promise<DocumentRecordSummary | undefined> {
    try {
      const listed = await storage.listDocs(kbId, { pathQuery: relPath, limit: DOC_LOOKUP_LIMIT })
      return listed.docs.find(doc => doc.docId === docId)
    } catch {
      return undefined
    }
  }

  async function start(): Promise<void> {
    if (startPromise !== undefined) return startPromise
    if (disposed) return
    startPromise = (async (): Promise<void> => {
      const persisted = await readKnowledgeBases(profileDir)
      records.clear()
      for (const record of persisted) {
        records.set(record.id, record)
        if (!statsCache.has(record.id)) statsCache.set(record.id, ZERO_STATS)
      }
      // 0 库惰性启动：注册表为空时不触碰 storage / pool，线程数保持 0。
      for (const record of persisted) {
        if (disposed) return
        try {
          await engine.startKb(record)
        } catch {
          // 单个库启动失败（目录不可写/Worker 崩溃）只影响该库；后续库继续启动，
          // 阶段由引擎按 index-error 呈现。
        }
      }
    })()
    return startPromise
  }

  async function list(): Promise<readonly KnowledgeBaseSummary[]> {
    const summaries: KnowledgeBaseSummary[] = []
    for (const record of records.values()) {
      if (records.get(record.id) !== record) continue
      const stats = await refreshStats(record.id)
      const summary = composeSummary(record)
      summaries.push({ ...summary, stats })
    }
    return summaries
  }

  function get(kbId: string): KnowledgeBaseSummary | undefined {
    const record = records.get(kbId)
    return record === undefined ? undefined : composeSummary(record)
  }

  async function create(input: { name: string; sourceDir: string; autoOrganize?: boolean }): Promise<KnowledgeBaseRecord> {
    const run = createChain.then(
      () => createInner(input),
      () => createInner(input),
    )
    createChain = run.then(() => undefined, () => undefined)
    return run
  }

  async function createInner(input: { name: string; sourceDir: string; autoOrganize?: boolean }): Promise<KnowledgeBaseRecord> {
    if (disposed) throw new KnowledgeSyncError('knowledge-base-busy', 'knowledge host is disposed')
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw new KnowledgeSyncError('invalid-source-dir', 'knowledge base name must not be empty')
    }
    if (records.size >= maxKnowledgeBases) {
      throw new KnowledgeSyncError(
        'knowledge-base-limit-reached',
        `knowledge base limit of ${String(maxKnowledgeBases)} reached`,
      )
    }
    const validation = await validateSourceDir({
      sourceDir: input.sourceDir,
      profileDir,
      existing: [...records.values()],
    })
    if (!validation.ok) {
      throw new KnowledgeSyncError('invalid-source-dir', validation.reason)
    }
    const id = randomUUID()
    const record: KnowledgeBaseRecord = {
      id,
      name: input.name,
      sourceDir: input.sourceDir,
      autoOrganize: input.autoOrganize ?? false,
      watchPaused: false,
      createdAt: new Date().toISOString(),
    }
    const kbRoot = neutralKnowledgeRootPath(profileDir, id)
    await mkdir(kbRoot, { recursive: true, mode: 0o700 })
    records.set(id, record)
    statsCache.set(id, ZERO_STATS)
    try {
      await persistRegistry()
      await engine.startKb(record)
    } catch (error) {
      // 注册表与磁盘保持成对：启动失败时回滚记录与刚创建的中立目录。
      records.delete(id)
      statsCache.delete(id)
      await persistRegistry().catch(() => undefined)
      await rm(kbRoot, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    return record
  }

  async function update(
    kbId: string,
    patch: { name?: string; sourceDir?: string; autoOrganize?: boolean; watchPaused?: boolean },
  ): Promise<KnowledgeBaseRecord> {
    const record = requireRecord(kbId)
    assertNotDeleting(kbId)
    assertNotMaintaining(kbId)
    if (patch.name !== undefined && (typeof patch.name !== 'string' || patch.name.trim() === '')) {
      throw new KnowledgeSyncError('invalid-source-dir', 'knowledge base name must not be empty')
    }
    maintainingIds.add(kbId)
    try {
      let next: KnowledgeBaseRecord = record
      if (patch.name !== undefined) next = { ...next, name: patch.name }
      if (patch.autoOrganize !== undefined) next = { ...next, autoOrganize: patch.autoOrganize }
      if (patch.sourceDir !== undefined && patch.sourceDir !== next.sourceDir) {
        // 控制器裁决 M-4：重绑委托引擎（零副作用校验 → 维护门闩 → 停机序列 →
        // 原子写注册表 → 保留索引/wiki → 禁用跨目录重命名猜配的全量对账）。
        await engine.rebindSourceDir(kbId, patch.sourceDir)
        next = { ...next, sourceDir: patch.sourceDir }
      }
      if (patch.watchPaused !== undefined && patch.watchPaused !== next.watchPaused) {
        if (patch.watchPaused) await engine.pauseWatch(kbId)
        else await engine.resumeWatch(kbId)
        next = { ...next, watchPaused: patch.watchPaused }
      }
      if (next !== record) {
        records.set(kbId, next)
        await persistRegistry()
      }
      return next
    } finally {
      maintainingIds.delete(kbId)
    }
  }

  async function remove(kbId: string): Promise<void> {
    requireRecord(kbId)
    assertNotDeleting(kbId)
    assertNotMaintaining(kbId)
    deletingIds.add(kbId)
    let release: (() => void) | undefined
    try {
      // 单库互斥：并发的 sync/rebuild/update(sourceDir) 立即得到 knowledge-base-busy。
      release = await engine.acquireLifecycleLock(kbId, 'delete')
      // 停机序列（关 Watcher、清防抖/dirty、中止并等待 Extraction Worker 释放
      // FileHandle、取消整理、关 SQLite）全部委托引擎。
      await engine.shutdownKbForDelete(kbId)
      try {
        await storage.closeKb(kbId)
      } catch {
        // 引擎停机已尝试关库；这里只做兜底，失败不阻断删库。
      }
      // 严禁触碰 sourceDir：只删除本库的中立数据根。
      await rm(neutralKnowledgeRootPath(profileDir, kbId), { recursive: true, force: true })
      records.delete(kbId)
      statsCache.delete(kbId)
      await persistRegistry()
      if (removalHook !== undefined) {
        await removalHook(kbId)
      }
    } finally {
      release?.()
      deletingIds.delete(kbId)
    }
  }

  async function sync(kbId: string): Promise<void> {
    requireRecord(kbId)
    assertNotDeleting(kbId)
    assertNotMaintaining(kbId)
    await engine.syncNow(kbId)
    await refreshStats(kbId)
  }

  async function rebuild(kbId: string): Promise<void> {
    requireRecord(kbId)
    assertNotDeleting(kbId)
    assertNotMaintaining(kbId)
    maintainingIds.add(kbId)
    try {
      await engine.rebuildIndex(kbId)
    } finally {
      maintainingIds.delete(kbId)
    }
    await refreshStats(kbId)
  }

  async function listDocs(kbId: string, filter?: ListDocsFilter): Promise<ListDocsResult> {
    requireRecord(kbId)
    assertNotDeleting(kbId)
    return await storage.listDocs(kbId, filter)
  }

  async function search(input: {
    kbIds: readonly string[]
    query: string
    topK?: number
  }): Promise<readonly KnowledgeSearchHit[]> {
    const query = input.query.trim()
    if (query === '') return []
    const perKb: Array<SingleKbCandidate[]> = []
    let firstError: unknown
    let attempted = 0
    for (const kbId of input.kbIds) {
      const record = records.get(kbId)
      if (record === undefined || deletingIds.has(kbId)) continue
      attempted += 1
      try {
        const raw = await storage.searchFts(kbId, record.name, query, SEARCH_FTS_LIMIT)
        perKb.push(rerankSingleKbCandidates(raw, query))
      } catch (error) {
        firstError = firstError ?? error
        perKb.push([])
      }
    }
    if (attempted === 0) return []
    if (perKb.every(list => list.length === 0) && firstError !== undefined) throw firstError

    const merged = mergeMultiKbResults(perKb, query, input.topK)
    if (merged.length === 0) return []

    const sourceStatus = new Map<string, boolean>()
    const docMeta = new Map<string, DocumentRecordSummary | undefined>()
    const hits: KnowledgeSearchHit[] = []
    for (const candidate of merged) {
      const record = records.get(candidate.kbId)
      if (record === undefined) continue
      let unavailable = sourceStatus.get(candidate.kbId)
      if (unavailable === undefined) {
        unavailable = await sourceUnavailableFor(record)
        sourceStatus.set(candidate.kbId, unavailable)
      }
      const docKey = `${candidate.kbId}\u0000${candidate.docId}`
      let doc = docMeta.get(docKey)
      if (doc === undefined && !docMeta.has(docKey)) {
        doc = await lookupDocMeta(candidate.kbId, candidate.docId, candidate.relPath)
        docMeta.set(docKey, doc)
      }
      const stale = doc === undefined ? false : await staleForDoc(record, doc, unavailable)
      hits.push({
        kbId: candidate.kbId,
        kbName: candidate.kbName,
        docId: candidate.docId,
        relPath: candidate.relPath,
        sha256: candidate.sha256,
        extractConfigHash: candidate.extractConfigHash,
        chunkId: candidate.chunkId,
        ordinal: candidate.ordinal,
        headingPath: candidate.headingPath,
        locator: candidate.locator,
        excerpt: candidate.content.slice(0, SEARCH_EXCERPT_MAX_CHARS),
        score: candidate.score,
        stale,
        sourceUnavailable: unavailable,
        // M1-1 只有 FTS5 一路召回；向量回填/混合模式由 M1-2 之后启用。
        searchMode: 'fts',
      })
    }
    return hits
  }

  async function getChunk(input: {
    kbId: string
    docId: string
    ordinal: number
    window?: number
    expectedSha256?: string
    expectedExtractConfigHash?: string
  }): Promise<GetChunkResult> {
    const record = records.get(input.kbId)
    if (record === undefined || deletingIds.has(input.kbId)) {
      return { status: 'kb-removed', kbId: input.kbId, docId: input.docId }
    }
    const result = await storage.getChunk(input.kbId, {
      docId: input.docId,
      ordinal: input.ordinal,
      window: input.window ?? DEFAULT_GET_CHUNK_WINDOW,
      ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
      ...(input.expectedExtractConfigHash === undefined
        ? {}
        : { expectedExtractConfigHash: input.expectedExtractConfigHash }),
    })
    if (result.status !== 'ok') return result
    // 控制器裁决 M-2：Host 在存储可证明事实之外补齐 kbName / stale / sourceUnavailable。
    const unavailable = await sourceUnavailableFor(record)
    const doc = await lookupDocMeta(record.id, result.docId, result.relPath)
    const stale = doc === undefined ? false : await staleForDoc(record, doc, unavailable)
    return {
      ...result,
      kbName: record.name,
      stale,
      sourceUnavailable: unavailable,
    }
  }

  async function getEvents(
    kbId: string,
    eventsOpts?: { limit?: number; filter?: KnowledgeEventFilter },
  ): Promise<readonly KnowledgeEventRecord[]> {
    if (!records.has(kbId)) return []
    return await readKnowledgeEvents(neutralKnowledgeRootPath(profileDir, kbId), eventsOpts)
  }

  async function handleSystemResume(): Promise<void> {
    if (disposed) return
    for (const listener of [...resumeListeners]) {
      try {
        listener()
      } catch {
        // 监听者异常相互隔离。
      }
    }
    await engine.handleSystemResume()
  }

  function onSystemResume(listener: () => void): () => void {
    resumeListeners.add(listener)
    return () => {
      resumeListeners.delete(listener)
    }
  }

  function setOrganizerHooks(hooks: KnowledgeOrganizerHooks): void {
    organizerHooks = hooks
  }

  function setRemovalHook(hook: (kbId: string) => Promise<void>): void {
    removalHook = hook
  }

  function isWorkersRunning(): boolean {
    return storage.isRunning() || pool.isRunning()
  }

  function isWatchingForTest(kbId: string): boolean {
    return engine.getState(kbId)?.watching ?? false
  }

  function dispose(): Promise<void> {
    if (disposePromise !== undefined) return disposePromise
    disposed = true
    resumeListeners.clear()
    const tasks: Array<Promise<unknown>> = []
    // 同步部分先置 disposing 并关闭全部 Watcher（engine.dispose 的首个同步段）。
    tasks.push(engine.dispose())
    tasks.push(pool.dispose(EXTRACTION_POOL_DISPOSE_BUDGET_MS))
    tasks.push(storage.dispose(STORAGE_DISPOSE_BUDGET_MS))
    const hooks = organizerHooks
    if (hooks !== undefined) {
      tasks.push(Promise.resolve().then(() => hooks.cancelAll()).catch(() => undefined))
    }
    if (startPromise !== undefined) tasks.push(startPromise.catch(() => undefined))
    const settled = Promise.allSettled(tasks).then(() => undefined)
    let timer: NodeJS.Timeout | undefined
    disposePromise = Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, disposeBudgetMs)
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
    return disposePromise
  }

  return {
    start,
    list,
    get,
    create,
    update,
    remove,
    sync,
    rebuild,
    listDocs,
    search,
    getChunk,
    getEvents,
    handleSystemResume,
    onSystemResume,
    setOrganizerHooks,
    setRemovalHook,
    isWorkersRunning,
    isWatchingForTest,
    dispose,
  }
}
