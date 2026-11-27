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

import { R_OK } from 'node:constants'
import { randomUUID } from 'node:crypto'
import { access, mkdir, rm, stat } from 'node:fs/promises'
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
  ChunkWindowItem,
  DocumentRecordSummary,
  GetChunkResult,
  KnowledgeBaseRecord,
  KnowledgeBaseStats,
  KnowledgeBaseSummary,
  KnowledgeEventRecord,
  KnowledgeOrganizerPhase,
  ListDocsFilter,
  ListDocsResult,
  PendingOrganizeBatch,
} from './types.ts'
import { neutralKnowledgeRootPath } from '../workspace-state.ts'

/** 退场外层兜底：单库停机 + 存储关库 + Worker terminate 必须在 1,000 ms 内落定。 */
export const DEFAULT_KNOWLEDGE_DISPOSE_BUDGET_MS = 950
/** Storage Worker 优雅关库预算（控制器裁决 M-18：800 ms）。 */
const STORAGE_DISPOSE_BUDGET_MS = 800
/** `getChunk` 缺省窗口大小（目标 ordinal 前后各取一部分）。 */
const DEFAULT_GET_CHUNK_WINDOW = 3
/** 单库检索召回上限（服务端重排前，规格 §7.2 Top-60）。 */
const SEARCH_FTS_LIMIT = 60
/** 搜索建议摘录长度（字符）。 */
const SEARCH_EXCERPT_MAX_CHARS = 200

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

/** 一批整理结算：冻结快照 + 真正推进的文档 + 真正删除的墓碑行。 */
export interface KnowledgeOrganizeBatchSettlement {
  readonly batch: PendingOrganizeBatch
  readonly organizedDocIds: readonly string[]
  readonly clearedTombstoneIds: readonly string[]
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
  /** M1-3 注入：删库已提交后的 best-effort 清理钩子（如会话挂载清理），异常仅记告警不撤销删库。 */
  setRemovalHook(hook: (kbId: string) => Promise<void>): void
  /** 已登记且不在删除中的知识库 id 副本；调用方 mutate 不影响 Host 注册表。 */
  getRegisteredKnowledgeBaseIds(): ReadonlySet<string>
  /** 手动整理前置校验：未知/删除/维护/recovery 相位拒绝；不检查 autoOrganize。 */
  assertOrganizeAllowed(kbId: string): void
  /** 写入四个整理相位之一；runtime 不 live、维护/删除锁或 recovery 时返回 false。 */
  setOrganizerPhase(kbId: string, phase: KnowledgeOrganizerPhase): boolean
  /** 仅当当前仍是整理相位时恢复空闲相位；绝不覆盖同步/恢复相位。 */
  clearOrganizerPhase(kbId: string): void
  /** 阶段 2 候选：自动开启库或本次手动集合中的库，排除删除/维护与两种恢复相位。 */
  listOrganizeCandidates(manualKbIds?: ReadonlySet<string>): readonly KnowledgeBaseRecord[]
  /** 只读查询下一批（不写任何状态），供调度器在准入前判断空批与退避。 */
  peekPendingOrganizeBatch(kbId: string, nowMs: number): Promise<PendingOrganizeBatch>
  /** 重新查询并冻结唯一的 open 批次；已有 open 批时抛 `knowledge-base-busy`。 */
  openOrganizeBatch(kbId: string, nowMs: number): Promise<PendingOrganizeBatch>
  /** 当前冻结快照；没有 open 批时抛 `knowledge-organize-batch-not-open`。 */
  getOpenOrganizeBatch(kbId: string): PendingOrganizeBatch
  /** 原子取出并删除当前批，返回真正推进文档与真正删行的墓碑 id。 */
  closeOrganizeBatch(kbId: string): KnowledgeOrganizeBatchSettlement
  readOrganizeDoc(kbId: string, docId: string, startOrdinal: number, limit: number): Promise<readonly ChunkWindowItem[]>
  markOrganizeProcessed(kbId: string, docId: string, sha256: string): Promise<{ readonly updated: boolean }>
  clearOrganizeTombstones(kbId: string, docIds: readonly string[]): Promise<readonly string[]>
  recordOrganizeFailure(kbId: string, docId: string, sha256: string, error: string, nowMs: number): Promise<{ readonly attempts: number; readonly retryAfter: number | null }>
  resetOrganizeFailures(kbId: string, docId?: string): Promise<void>
  isWorkersRunning(): boolean
  isWatchingForTest(kbId: string): boolean
  dispose(): Promise<void>
}

/** 单库当前 open 批次：冻结快照与结算时真实推进/删行 id。 */
interface OpenOrganizeBatchState {
  readonly batch: PendingOrganizeBatch
  readonly organizedDocIds: Set<string>
  readonly clearedTombstoneIds: Set<string>
}

/** 未 open 批次时的具名错误；工具与执行器按稳定 message 前缀匹配。 */
class KnowledgeOrganizeBatchNotOpenError extends Error {
  constructor(kbId: string) {
    super(`knowledge-organize-batch-not-open: ${kbId}`)
    this.name = 'KnowledgeOrganizeBatchNotOpenError'
  }
}

/** 深拷贝后逐层冻结：open 快照不可被调用方改写。 */
function freezeBatchSnapshot<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freezeBatchSnapshot(child)
    Object.freeze(value)
  }
  return value
}

function copyPendingOrganizeBatch(batch: PendingOrganizeBatch): PendingOrganizeBatch {
  return freezeBatchSnapshot({
    docs: batch.docs.map(item => ({ ...item })),
    tombstones: batch.tombstones.map(item => ({ ...item })),
  })
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
  /** 每库唯一 open 批次；`open` 后冻结，`close` 原子取出并删除。 */
  const openOrganizeBatches = new Map<string, OpenOrganizeBatchState>()

  let organizerHooks: KnowledgeOrganizerHooks | undefined
  let removalHook: ((kbId: string) => Promise<void>) | undefined
  let disposed = false
  let registryLoadedPromise: Promise<void> | undefined
  let startPromise: Promise<void> | undefined
  let disposePromise: Promise<void> | undefined
  /** `records` 变更代际号：用于 `update()` 前置无锁校验后的并发变更检测（M-9）。 */
  let recordsVersion = 0
  /** 注册表写入串行化：任务执行时才快照 `records`，后一次写总带上前一次的内存变更。 */
  let registryChain: Promise<unknown> = Promise.resolve()
  /** 源目录绑定与创建共享串行链：彻底杜绝并发 `create` 与 `update(sourceDir)` 互相越过父子重叠校验（I-5）。 */
  let bindingChain: Promise<unknown> = Promise.resolve()

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

  function assertNotDisposed(): void {
    if (disposed) {
      throw new KnowledgeSyncError('knowledge-base-busy', 'knowledge host is disposed')
    }
  }

  function serializeBinding<T>(task: () => Promise<T>): Promise<T> {
    const run = bindingChain.then(task, task)
    bindingChain = run.then(() => undefined, () => undefined)
    return run
  }

  async function waitRegistryLoaded(): Promise<void> {
    if (registryLoadedPromise !== undefined) await registryLoadedPromise
  }

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

  /**
   * 在 `registryChain` 串行槽内变更内存并原子落盘；若落盘失败则立刻在槽内回滚内存，
   * 杜绝并发写将未提交记录刷盘，也避免失败路径需要二次写盘回滚。
   */
  function commitRegistryChange(mutate: () => void, rollback: () => void): Promise<void> {
    const step = async (): Promise<void> => {
      assertNotDisposed()
      mutate()
      try {
        await writeKnowledgeBases(profileDir, [...records.values()])
      } catch (error) {
        rollback()
        throw error
      }
    }
    const run = registryChain.then(step, step)
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

  /** 源目录是否已不可访问（缺失/非目录/无读权限）：`stat` + `access(R_OK)`，绝不读内容（I-9）。 */
  async function sourceUnavailableFor(record: KnowledgeBaseRecord): Promise<boolean> {
    try {
      const info = await stat(record.sourceDir)
      if (!info.isDirectory()) return true
      await access(record.sourceDir, R_OK)
      return false
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

  async function start(): Promise<void> {
    if (startPromise !== undefined) return startPromise
    if (disposed) return
    let resolveLoaded: () => void = () => undefined
    registryLoadedPromise = new Promise<void>((resolve) => {
      resolveLoaded = resolve
    })
    startPromise = (async (): Promise<void> => {
      let persisted: KnowledgeBaseRecord[]
      try {
        persisted = await readKnowledgeBases(profileDir)
        if (!disposed) {
          for (const record of persisted) {
            if (deletingIds.has(record.id) || records.has(record.id)) continue
            records.set(record.id, record)
            if (!statsCache.has(record.id)) statsCache.set(record.id, ZERO_STATS)
          }
          recordsVersion += 1
        }
      } finally {
        resolveLoaded()
      }
      // 0 库惰性启动：注册表为空时不触碰 storage / pool，线程数保持 0。
      for (const record of persisted) {
        if (disposed) return
        // I-1 修复：每轮启动前复核实时状态，跳过并发删库/维护中或已由 API 启动的库。
        if (deletingIds.has(record.id) || maintainingIds.has(record.id)) continue
        const live = records.get(record.id)
        if (live === undefined) continue
        if (engine.getState(live.id) !== undefined) continue
        try {
          await engine.startKb(live)
        } catch {
          // 单个库启动失败（目录不可写/Worker 崩溃）只影响该库；后续库继续启动，
          // 阶段由引擎按 index-error 呈现。
        }
      }
    })()
    return startPromise
  }

  async function list(): Promise<readonly KnowledgeBaseSummary[]> {
    await waitRegistryLoaded()
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
    await waitRegistryLoaded()
    return serializeBinding(() => createInner(input))
  }

  async function createInner(input: { name: string; sourceDir: string; autoOrganize?: boolean }): Promise<KnowledgeBaseRecord> {
    assertNotDisposed()
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
    assertNotDisposed()
    const id = randomUUID()
    // I-6：持久化 `validation.realSourceDir`，确保原符号链接删除后嵌套/重叠校验依然成立。
    const record: KnowledgeBaseRecord = {
      id,
      name: input.name,
      sourceDir: validation.realSourceDir,
      autoOrganize: input.autoOrganize ?? true,
      watchPaused: false,
      createdAt: new Date().toISOString(),
    }
    const kbRoot = neutralKnowledgeRootPath(profileDir, id)
    await mkdir(kbRoot, { recursive: true, mode: 0o700 })
    try {
      await engine.startKb(record)
      await commitRegistryChange(
        () => {
          records.set(id, record)
          recordsVersion += 1
          statsCache.set(id, ZERO_STATS)
        },
        () => {
          records.delete(id)
          recordsVersion += 1
          statsCache.delete(id)
        },
      )
    } catch (error) {
      // 先 `startKb` 再在串行写槽内原子登记并落盘：`startKb` 或写盘任一步失败都不会在磁盘留孤儿注册项，
      // 只需停机释放 runtime/Watcher/SQLite 并删除中立目录（I-1 / Minor 2）。
      await engine.stopKb(id).catch(() => undefined)
      await rm(kbRoot, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    return record
  }

  async function update(
    kbId: string,
    patch: { name?: string; sourceDir?: string; autoOrganize?: boolean; watchPaused?: boolean },
  ): Promise<KnowledgeBaseRecord> {
    await waitRegistryLoaded()
    assertNotDisposed()
    const initialRecord = requireRecord(kbId)
    assertNotDeleting(kbId)
    assertNotMaintaining(kbId)
    if (patch.name !== undefined && (typeof patch.name !== 'string' || patch.name.trim() === '')) {
      throw new KnowledgeSyncError('invalid-source-dir', 'knowledge base name must not be empty')
    }
    // M-9 / 规格 §6.4(1)：重绑源目录的前置校验在占 `maintainingIds` 之前执行，
    // 校验失败时完全零副作用，也不阻塞并发 `sync`。
    let prevalidatedRealSourceDir: string | undefined
    const versionBeforeValidate = recordsVersion
    if (patch.sourceDir !== undefined && patch.sourceDir !== initialRecord.sourceDir) {
      const validation = await validateSourceDir({
        sourceDir: patch.sourceDir,
        profileDir,
        existing: [...records.values()],
        ignoreKbId: kbId,
      })
      if (!validation.ok) {
        throw new KnowledgeSyncError('invalid-source-dir', validation.reason)
      }
      prevalidatedRealSourceDir = validation.realSourceDir
    }
    assertNotDisposed()
    const record = requireRecord(kbId)
    assertNotDeleting(kbId)
    assertNotMaintaining(kbId)
    maintainingIds.add(kbId)
    try {
      let next: KnowledgeBaseRecord = record
      /** 已经随重绑落盘并同步进内存的记录（避免重复写同一内容）。 */
      let persistedNext: KnowledgeBaseRecord = record
      if (patch.name !== undefined) next = { ...next, name: patch.name }
      if (patch.autoOrganize !== undefined) next = { ...next, autoOrganize: patch.autoOrganize }
      if (patch.sourceDir !== undefined && patch.sourceDir !== next.sourceDir) {
        let canonicalSourceDir = prevalidatedRealSourceDir
        // 若前置校验 await 期间其它库发生增删改，加锁后再复核一次杜绝 TOCTOU。
        if (canonicalSourceDir === undefined || recordsVersion !== versionBeforeValidate) {
          const recheck = await validateSourceDir({
            sourceDir: patch.sourceDir,
            profileDir,
            existing: [...records.values()],
            ignoreKbId: kbId,
          })
          if (!recheck.ok) {
            throw new KnowledgeSyncError('invalid-source-dir', recheck.reason)
          }
          canonicalSourceDir = recheck.realSourceDir
        }
        // 若同时传入 `watchPaused: true`，先暂停监听再重绑，避免重绑期间短暂重启无用监听。
        let pausedBeforeRebind = false
        if (patch.watchPaused === true && !next.watchPaused) {
          await engine.pauseWatch(kbId)
          pausedBeforeRebind = true
          next = { ...next, watchPaused: true }
        }
        // I-6：重绑同样持久化规范化 `realSourceDir`。
        let rebound: KnowledgeBaseRecord = { ...next, sourceDir: canonicalSourceDir }
        // 2/3. 引擎取维护门闩 + 停机序列；Host 在共享 bindingChain 内复核重叠后原子
        //      落盘并更新内存（I-5 杜绝与并发 create/update 的父子重叠竞态）。
        try {
          await engine.rebindSourceDir(kbId, canonicalSourceDir, canonicalSourceDir, async () => {
            await serializeBinding(async () => {
              assertNotDisposed()
              const finalCheck = await validateSourceDir({
                sourceDir: canonicalSourceDir,
                profileDir,
                existing: [...records.values()],
                ignoreKbId: kbId,
              })
              if (!finalCheck.ok) {
                throw new KnowledgeSyncError('invalid-source-dir', finalCheck.reason)
              }
              rebound = { ...next, sourceDir: finalCheck.realSourceDir }
              const previous = records.get(kbId)
              records.set(kbId, rebound)
              recordsVersion += 1
              try {
                await persistRegistry()
              } catch (error) {
                if (previous === undefined) records.delete(kbId)
                else records.set(kbId, previous)
                recordsVersion += 1
                throw error
              }
            })
          })
        } catch (error) {
          if (pausedBeforeRebind) await engine.resumeWatch(kbId, { awaitReconcile: false }).catch(() => undefined)
          throw error
        }
        next = rebound
        persistedNext = rebound
      }

      const wantPause = patch.watchPaused === true && !next.watchPaused
      const wantResume = patch.watchPaused === false && next.watchPaused
      if (wantPause) {
        await engine.pauseWatch(kbId)
        next = { ...next, watchPaused: true }
      } else if (wantResume) {
        // I-9 修复：恢复监听时先原子落盘 `watchPaused: false`，再非阻塞启动后台对账，
        // 避免全量对账期间长时间占用 `maintainingIds` 与延迟落盘。
        next = { ...next, watchPaused: false }
      }
      if (next !== persistedNext) {
        const previous = records.get(kbId)
        records.set(kbId, next)
        recordsVersion += 1
        try {
          await persistRegistry()
        } catch (error) {
          if (previous === undefined) records.delete(kbId)
          else records.set(kbId, previous)
          recordsVersion += 1
          if (wantPause) await engine.resumeWatch(kbId, { awaitReconcile: false }).catch(() => undefined)
          throw error
        }
      }
      if (wantResume) {
        await engine.resumeWatch(kbId, { awaitReconcile: false })
      }
      return next
    } finally {
      maintainingIds.delete(kbId)
    }
  }

  async function remove(kbId: string): Promise<void> {
    await waitRegistryLoaded()
    assertNotDisposed()
    const previousRecord = requireRecord(kbId)
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
      const previousStats = statsCache.get(kbId)
      records.delete(kbId)
      statsCache.delete(kbId)
      recordsVersion += 1
      try {
        await persistRegistry()
      } catch (error) {
        // I-10：注册表写失败时恢复内存记录，允许调用方幂等重试 `remove(kbId)`，避免下次启动建出空库。
        records.set(kbId, previousRecord)
        if (previousStats !== undefined) statsCache.set(kbId, previousStats)
        recordsVersion += 1
        throw error
      }
      // 删库已提交：该库不可能再有整理批次，丢弃残留 open 状态。
      openOrganizeBatches.delete(kbId)
      if (removalHook !== undefined) {
        try {
          await removalHook(kbId)
        } catch (hookError) {
          // 删库已落盘提交：提交后通知钩子失败仅记告警，避免调用方误以为删库失败而重试得 not-found。
          console.warn(`[knowledge] post-remove hook failed for ${kbId}: ${String(hookError)}`)
        }
      }
    } finally {
      release?.()
      deletingIds.delete(kbId)
    }
  }

  async function sync(kbId: string): Promise<void> {
    await waitRegistryLoaded()
    assertNotDisposed()
    requireRecord(kbId)
    assertNotDeleting(kbId)
    assertNotMaintaining(kbId)
    await engine.syncNow(kbId)
    await refreshStats(kbId)
  }

  async function rebuild(kbId: string): Promise<void> {
    await waitRegistryLoaded()
    assertNotDisposed()
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
    await waitRegistryLoaded()
    requireRecord(kbId)
    assertNotDeleting(kbId)
    return await storage.listDocs(kbId, filter)
  }

  function getRegisteredKnowledgeBaseIds(): ReadonlySet<string> {
    return new Set([...records.keys()].filter(kbId => !deletingIds.has(kbId)))
  }

  /**
   * 手动整理前置校验（M1-2 Task 5）：直接复用既有记录与锁集合，不复制状态机；
   * recovery 相位按同名 `KnowledgeSyncError` 拒绝。`autoOrganize` 不参与判断。
   */
  function assertOrganizeAllowed(kbId: string): void {
    requireRecord(kbId)
    assertNotDeleting(kbId)
    assertNotMaintaining(kbId)
    const phase = engine.getState(kbId)?.phase
    if (phase === 'wiki-reset-pending' || phase === 'index-error') {
      throw new KnowledgeSyncError(phase, `knowledge base ${kbId} is in ${phase}`)
    }
  }

  /** 整理相位窄接口只做委托，状态机留在 SyncEngine。 */
  function setOrganizerPhase(kbId: string, phase: KnowledgeOrganizerPhase): boolean {
    return engine.setOrganizerPhase(kbId, phase)
  }

  function clearOrganizerPhase(kbId: string): void {
    engine.clearOrganizerPhase(kbId)
  }

  /**
   * 阶段 2 候选（规格 §8.1）：只按注册表与运行相位筛选，不读 Storage。
   * `watch-paused` / `watch-failed` / `source-unavailable` 不阻断整理；只有
   * 删除、维护与 `wiki-reset-pending` / `index-error` 被排除。
   */
  function listOrganizeCandidates(manualKbIds?: ReadonlySet<string>): readonly KnowledgeBaseRecord[] {
    const candidates: KnowledgeBaseRecord[] = []
    for (const record of records.values()) {
      if (deletingIds.has(record.id) || maintainingIds.has(record.id)) continue
      const phase = engine.getState(record.id)?.phase
      if (phase === 'wiki-reset-pending' || phase === 'index-error') continue
      if (!record.autoOrganize && manualKbIds?.has(record.id) !== true) continue
      candidates.push(record)
    }
    return candidates
  }

  async function peekPendingOrganizeBatch(kbId: string, nowMs: number): Promise<PendingOrganizeBatch> {
    await waitRegistryLoaded()
    requireRecord(kbId)
    assertNotDeleting(kbId)
    assertNotMaintaining(kbId)
    return await storage.getPendingOrganizeBatch(kbId, nowMs)
  }

  /**
   * 再查询一次并冻结唯一当前批。查询期间若记录被删除或进入维护，绝不把批次写回
   * Map（不复活已删库的整理回合）。
   */
  async function openOrganizeBatch(kbId: string, nowMs: number): Promise<PendingOrganizeBatch> {
    await waitRegistryLoaded()
    assertNotDisposed()
    requireRecord(kbId)
    assertNotDeleting(kbId)
    assertNotMaintaining(kbId)
    if (openOrganizeBatches.has(kbId)) {
      throw new KnowledgeSyncError('knowledge-base-busy', `knowledge base ${kbId} already has an open organize batch`)
    }
    const fetched = await storage.getPendingOrganizeBatch(kbId, nowMs)
    assertNotDisposed()
    if (records.get(kbId) === undefined) {
      throw new KnowledgeSyncError(
        'knowledge-base-not-found',
        `knowledge base ${kbId} was removed while opening its organize batch`,
      )
    }
    assertNotDeleting(kbId)
    assertNotMaintaining(kbId)
    if (openOrganizeBatches.has(kbId)) {
      throw new KnowledgeSyncError('knowledge-base-busy', `knowledge base ${kbId} already has an open organize batch`)
    }
    const batch = copyPendingOrganizeBatch(fetched)
    openOrganizeBatches.set(kbId, { batch, organizedDocIds: new Set(), clearedTombstoneIds: new Set() })
    return batch
  }

  function getOpenOrganizeBatch(kbId: string): PendingOrganizeBatch {
    const open = openOrganizeBatches.get(kbId)
    if (open === undefined) throw new KnowledgeOrganizeBatchNotOpenError(kbId)
    return open.batch
  }

  function closeOrganizeBatch(kbId: string): KnowledgeOrganizeBatchSettlement {
    const open = openOrganizeBatches.get(kbId)
    if (open === undefined) throw new KnowledgeOrganizeBatchNotOpenError(kbId)
    openOrganizeBatches.delete(kbId)
    return {
      batch: open.batch,
      organizedDocIds: [...open.organizedDocIds],
      clearedTombstoneIds: [...open.clearedTombstoneIds],
    }
  }

  async function readOrganizeDoc(
    kbId: string,
    docId: string,
    startOrdinal: number,
    limit: number,
  ): Promise<readonly ChunkWindowItem[]> {
    await waitRegistryLoaded()
    requireRecord(kbId)
    assertNotDeleting(kbId)
    return await storage.getDocChunks(kbId, docId, startOrdinal, limit)
  }

  async function markOrganizeProcessed(
    kbId: string,
    docId: string,
    sha256: string,
  ): Promise<{ readonly updated: boolean }> {
    await waitRegistryLoaded()
    requireRecord(kbId)
    assertNotDeleting(kbId)
    // 固定卡片路径；`markOrganizedAtomic` 仍只按 `doc_id = ? AND sha256 = ?` 原子推进。
    const result = await storage.markOrganizedAtomic(kbId, docId, sha256, `docs/${docId}.md`)
    if (result.updated) openOrganizeBatches.get(kbId)?.organizedDocIds.add(docId)
    return result
  }

  async function clearOrganizeTombstones(kbId: string, docIds: readonly string[]): Promise<readonly string[]> {
    await waitRegistryLoaded()
    requireRecord(kbId)
    assertNotDeleting(kbId)
    const deleted = await storage.clearOrganizeTombstones(kbId, docIds)
    const open = openOrganizeBatches.get(kbId)
    if (open !== undefined) {
      for (const docId of deleted) open.clearedTombstoneIds.add(docId)
    }
    return deleted
  }

  async function recordOrganizeFailure(
    kbId: string,
    docId: string,
    sha256: string,
    error: string,
    nowMs: number,
  ): Promise<{ readonly attempts: number; readonly retryAfter: number | null }> {
    await waitRegistryLoaded()
    requireRecord(kbId)
    assertNotDeleting(kbId)
    return await storage.recordOrganizeFailure(kbId, docId, sha256, error, nowMs)
  }

  async function resetOrganizeFailures(kbId: string, docId?: string): Promise<void> {
    await waitRegistryLoaded()
    requireRecord(kbId)
    assertNotDeleting(kbId)
    await storage.resetOrganizeFailures(kbId, docId)
  }

  async function search(input: {
    kbIds: readonly string[]
    query: string
    topK?: number
  }): Promise<readonly KnowledgeSearchHit[]> {
    await waitRegistryLoaded()
    const query = input.query.trim()
    if (query === '') return []
    const perKb: Array<SingleKbCandidate[]> = []
    let firstError: unknown
    let attempted = 0
    let succeeded = 0
    // I-9 修复：对 `kbIds` 去重，且只要至少有一个库查询成功（即便 0 命中）就返回结果而不误抛异常。
    for (const kbId of new Set(input.kbIds)) {
      const record = records.get(kbId)
      if (record === undefined || deletingIds.has(kbId)) continue
      attempted += 1
      try {
        const raw = await storage.searchFts(kbId, record.name, query, SEARCH_FTS_LIMIT)
        succeeded += 1
        perKb.push(rerankSingleKbCandidates(raw, query))
      } catch (error) {
        firstError = firstError ?? error
        perKb.push([])
      }
    }
    if (attempted === 0) return []
    if (succeeded === 0 && firstError !== undefined) throw firstError

    const merged = mergeMultiKbResults(perKb, query, input.topK)
    if (merged.length === 0) return []

    const sourceStatus = new Map<string, boolean>()
    const staleByDoc = new Map<string, boolean>()
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
      let stale = staleByDoc.get(docKey)
      if (stale === undefined) {
        stale = candidate.docSize !== undefined && candidate.docMtimeMs !== undefined
          ? await staleForDoc(
              record,
              {
                docId: candidate.docId,
                relPath: candidate.relPath,
                size: candidate.docSize,
                mtimeMs: candidate.docMtimeMs,
              },
              unavailable,
            )
          : false
        staleByDoc.set(docKey, stale)
      }
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
    await waitRegistryLoaded()
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
    const stale = await staleForDoc(record, result, unavailable)
    return {
      status: 'ok',
      kbId: result.kbId,
      kbName: record.name,
      docId: result.docId,
      relPath: result.relPath,
      sha256: result.sha256,
      extractConfigHash: result.extractConfigHash,
      stale,
      sourceUnavailable: unavailable,
      targetOrdinal: result.targetOrdinal,
      chunks: result.chunks,
    }
  }

  async function getEvents(
    kbId: string,
    eventsOpts?: { limit?: number; filter?: KnowledgeEventFilter },
  ): Promise<readonly KnowledgeEventRecord[]> {
    await waitRegistryLoaded()
    if (!records.has(kbId)) return []
    return await readKnowledgeEvents(neutralKnowledgeRootPath(profileDir, kbId), eventsOpts)
  }

  async function handleSystemResume(): Promise<void> {
    if (disposed) return
    await engine.handleSystemResume()
  }

  /** I-9 修复：直接委托给同步引擎，使 powerMonitor 与时钟跳变两条唤醒路径均触达监听者。 */
  function onSystemResume(listener: () => void): () => void {
    return engine.onSystemResume(listener)
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
    const tasks: Array<Promise<unknown>> = []
    // 同步部分先置 disposing 并关闭全部 Watcher（engine.dispose 的首个同步段）。
    tasks.push(engine.dispose())
    tasks.push(pool.dispose(EXTRACTION_POOL_DISPOSE_BUDGET_MS))
    tasks.push(storage.dispose(STORAGE_DISPOSE_BUDGET_MS))
    // I-1 修复：等待正在进行的原子注册表写入落盘，避免退场中途中断。
    tasks.push(registryChain.catch(() => undefined))
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
    getRegisteredKnowledgeBaseIds,
    assertOrganizeAllowed,
    setOrganizerPhase,
    clearOrganizerPhase,
    listOrganizeCandidates,
    peekPendingOrganizeBatch,
    openOrganizeBatch,
    getOpenOrganizeBatch,
    closeOrganizeBatch,
    readOrganizeDoc,
    markOrganizeProcessed,
    clearOrganizeTombstones,
    recordOrganizeFailure,
    resetOrganizeFailures,
    isWorkersRunning,
    isWatchingForTest,
    dispose,
  }
}
