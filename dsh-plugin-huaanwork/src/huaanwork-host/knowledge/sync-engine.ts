/**
 * 知识库同步引擎（规格 §6.1 / §6.4 / 计划 Task 6，R3-I1 自动监听与对账状态机）。
 *
 * 每个未暂停监听的知识库一个 `fs.watch(sourceDir, { recursive: true })`：
 * 变更进入 `dirtyPaths`，静默 `debounceMs` 后做 `writeStableMs` 写稳复核再对账；
 * Watcher `'error'` 立即关闭坏句柄、降级为 `watch-failed`，但**保留**周期对账与
 * 手动同步。周期对账默认 5 分钟、只覆盖 `!watchPaused` 的库（含降级库）；
 * 系统休眠恢复与墙钟/单调时钟大跳变会为 `!watchPaused` 的库重建 Watcher 并补
 * 一次对账。
 *
 * 重命名复用只在一批里「恰好 1 条消失 + 1 条新增且 sha256 相同、无内容重复」
 * 时生效；多对多/重复内容按删除 + 新增处理，绝不把副本认成重命名。
 *
 * 重绑源目录（§6.4）先做零副作用校验（由 Host 调用 `validateSourceDir` 后传入
 * `realSourceDir`），再进维护门闩 + 停机序列、由 Host 原子写回
 * `knowledge-bases.json` 并更新内存、重探大小写、保留 `index.sqlite` 与 `wiki/`，
 * 最后做禁用跨目录重命名猜配的全量对账：同 `rel_path` 且 `sha256` +
 * `extract_config_hash` 均一致的文件直接元数据短路（零重切、零清向量、零清
 * `organized_sha256`）。注册表唯一写者是 Host，本引擎绝不写注册表。
 *
 * 本文件会被测试以 `.ts` 源码直接加载（Node type-stripping），因此不得使用
 * `enum`、构造器参数属性与 `namespace`；纯类型导入必须写 `import type`，
 * 相对导入保留 `.ts` 后缀。
 */

import { R_OK } from 'node:constants'
import { watch } from 'node:fs'
import { access, lstat, mkdir } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'

import { detectCloudPlaceholder } from './cloud-placeholder.ts'
import type { CloudPlaceholderState } from './cloud-placeholder.ts'
import { appendKnowledgeEvent } from './events.ts'
import type { AppendKnowledgeEventInput } from './events.ts'
import { computeExtractConfigHash } from './extractors/extract-config.ts'
import { probeCaseSensitiveDir } from './paths.ts'
import { readKnowledgeBases } from './registry.ts'
import { walkSourceDirectory } from './safe-read.ts'
import type { WalkedSourceFile } from './safe-read.ts'
import { MAX_FILES_PER_KB } from './types.ts'
import type {
  DocumentRecordSummary,
  KnowledgeBaseRecord,
  KnowledgeErrorCode,
  KnowledgePhase,
  UpsertDocumentInput,
} from './types.ts'
import { neutralKnowledgeRootPath } from '../workspace-state.ts'
import type { ExtractionFileRequest, ExtractionFileResult, ExtractionPool } from './extraction-pool.ts'
import type { KnowledgeStorageClient } from './storage-client.ts'

export const DEFAULT_DEBOUNCE_MS = 3_000
export const DEFAULT_WRITE_STABLE_MS = 300
export const DEFAULT_RECONCILE_INTERVAL_MS = 300_000
export const DEFAULT_CLOCK_JUMP_MS = 30_000

/** 写稳复核最多重排次数（规格 §6.1）。 */
const WRITE_STABLE_MAX_ATTEMPTS = 5
/** 单批同步变更超过该数量时折叠为一条 `sync_completed` 汇总事件。 */
const BATCH_EVENT_FOLD_THRESHOLD = 5
/** 时钟跳变检测周期（墙钟 vs 单调时钟）。 */
const CLOCK_CHECK_INTERVAL_MS = 30_000
/** 多库错峰：第 N 个库延迟 N * 该值后再对账。 */
const STAGGER_STEP_MS = 25
/** 单次 `listDocs` 分页上限（规格 §7.2 硬上限 200）。 */
const LIST_DOCS_PAGE = 200

/** `status_reason` 机器值（M-16：同样的值写进事件 `detail`）。 */
const CLOUD_DEHYDRATED_REASON = 'cloud-placeholder-dehydrated'
const FILE_TOO_LARGE_REASON = 'file-too-large'
const MAX_FILES_EXCEEDED_REASON = 'max-files-exceeded'

const IGNORED_FILE_NAMES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
const IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(['.git', 'node_modules', '__pycache__', '.hg', '.svn'])
const IGNORED_FILE_SUFFIXES: readonly string[] = ['.tmp', '.part', '.crdownload']

/** 同步引擎的统一错误（`code` 供 Host 路由直接回传）。 */
export class KnowledgeSyncError extends Error {
  readonly code: KnowledgeErrorCode

  constructor(code: KnowledgeErrorCode, message: string) {
    // 错误码前缀让 `toThrow(/knowledge-base-busy/)` 这类按码断言在跨层传播后仍成立。
    super(`${code}: ${message}`)
    this.name = 'KnowledgeSyncError'
    this.code = code
  }
}

export interface SyncWatcherHandle {
  on(event: 'change', listener: (eventType: string, filename: string | Buffer | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  close(): void
}

export type SyncWatchFactory = (sourceDir: string) => SyncWatcherHandle

export interface KnowledgeSyncEngineOptions {
  readonly profileDir: string
  readonly storage: KnowledgeStorageClient
  readonly pool: ExtractionPool
  readonly maxFilesPerKb?: number
  readonly debounceMs?: number
  readonly writeStableMs?: number
  readonly reconcileIntervalMs?: number
  readonly clockJumpThresholdMs?: number
  readonly nowWall?: () => number
  readonly nowMono?: () => number
  readonly watchFactory?: SyncWatchFactory
  readonly detectCloudPlaceholder?: (filePath: string) => 'local' | 'dehydrated' | 'probe-unavailable'
  readonly cancelOrganizerForKb?: (kbId: string) => Promise<void>
  readonly afterCommitBeforeReopenForTest?: () => void
  readonly failWikiResetOnceForTest?: () => void
}

export interface KnowledgeRuntimeState {
  readonly id: string
  readonly sourceDir: string
  readonly phase: KnowledgePhase
  readonly watchPaused: boolean
  readonly watching: boolean
  readonly lastSyncedAt?: string
  readonly lastError?: string
}

export interface SyncEngineMetrics {
  readonly fullRechunkCount: number
  readonly periodicReconcileCount: number
}

export interface KnowledgeSyncEngine {
  startKb(kb: KnowledgeBaseRecord): Promise<void>
  stopKb(kbId: string): Promise<void>
  /**
   * 删库专用停机序列（控制器裁决 M-4）：先完成常规停机（关 Watcher、清防抖与
   * dirty、排空提取 Worker 并等 FileHandle 关闭、等链尾），再取消该库在途整理，
   * 最后关闭 SQLite。Host 只负责随后的中立目录删除与注册表原子写。
   */
  shutdownKbForDelete(kbId: string): Promise<void>
  pauseWatch(kbId: string): Promise<void>
  resumeWatch(kbId: string): Promise<void>
  syncNow(kbId: string): Promise<void>
  /**
   * 重绑源目录运行态收敛（规格 §6.4；控制器终审裁决：注册表唯一写者为 Host）。
   * Host 先零副作用校验并拿到 `realSourceDir`，本方法再取维护门闩 + 停机序列，
   * 调用 `persist` 让 Host 原子写回注册表并更新内存（失败则完全保留旧绑定与
   * 旧数据），随后重探大小写、保留索引/wiki 做禁用跨目录重命名猜配的全量对账，
   * 最后更新 runtime 记录。落盘后收敛失败不回滚：磁盘与内存都保持新
   * `sourceDir`，由下次启动对账自愈。
   */
  rebindSourceDir(
    kbId: string,
    newSourceDir: string,
    realSourceDir: string,
    persist: () => Promise<void>,
  ): Promise<void>
  rebuildIndex(kbId: string): Promise<void>
  handleSystemResume(): Promise<void>
  onSystemResume(listener: () => void): () => void
  checkClockJump(): Promise<boolean>
  acquireLifecycleLock(kbId: string, mode: 'maintain' | 'delete'): Promise<() => void>
  getState(kbId: string): KnowledgeRuntimeState | undefined
  getMetricsForTest(kbId: string): SyncEngineMetrics
  setCaseSensitiveForTest(kbId: string, caseSensitive: boolean): void
  simulateWatchErrorForTest(kbId: string, err: Error): void
  dispose(): Promise<void>
}

type ReconcileTrigger = 'startup' | 'debounce' | 'periodic' | 'manual' | 'resume' | 'rebind'

interface ReconcileOptions {
  /** 重绑对账必须禁用跨目录 1 对 1 重命名猜配（规格 §6.4）。 */
  readonly allowRename: boolean
  readonly trigger: ReconcileTrigger
}

interface Runtime {
  record: KnowledgeBaseRecord
  phase: KnowledgePhase
  watchPaused: boolean
  caseSensitive: boolean
  watcher: SyncWatcherHandle | undefined
  watchFailed: boolean
  sourceUnavailable: boolean
  dirtyPaths: Set<string>
  debounceTimer: NodeJS.Timeout | undefined
  staggerCancels: Set<() => void>
  lastSyncedAt?: string
  lastError?: string
  chain: Promise<void>
  epoch: number
  maintaining: boolean
  stopped: boolean
  metrics: { fullRechunkCount: number; periodicReconcileCount: number }
}

/** 目录遍历的内置忽略规则（规格 §6.1）。 */
function shouldIgnoreSourceEntry(_relPath: string, name: string, isDir: boolean): boolean {
  if (isDir) return IGNORED_DIRECTORY_NAMES.has(name)
  if (IGNORED_FILE_NAMES.has(name)) return true
  if (name.startsWith('~$')) return true
  const lower = name.toLowerCase()
  return IGNORED_FILE_SUFFIXES.some(suffix => lower.endsWith(suffix))
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function normalizeNumber(value: number | undefined, fallback: number, min: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.trunc(value))
}

function normalizeCap(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_FILES_PER_KB
  return Math.max(0, Math.trunc(value))
}

function formatFromRelPath(relPath: string): string {
  return extname(relPath).replace(/^\./u, '')
}

function isSteadyPhase(phase: KnowledgePhase): boolean {
  return phase === 'watching'
    || phase === 'syncing'
    || phase === 'watch-paused'
    || phase === 'watch-failed'
    || phase === 'source-unavailable'
}

function needsRecovery(phase: KnowledgePhase): boolean {
  return phase === 'wiki-reset-pending' || phase === 'index-error'
}

function isSourceMissingError(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM'
}

/** 单文件处理结果（`indexed` 已写库，`skipped`/`failed` 只产生告警）。 */
type FileOutcome =
  | { readonly kind: 'indexed'; readonly status: string }
  | { readonly kind: 'short-circuit' }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string; readonly error?: string }
  | { readonly kind: 'aborted' }

/** 一次对账的变更计划。 */
interface ReconcilePlan {
  readonly deletes: DocumentRecordSummary[]
  readonly upserts: Array<{ readonly file: WalkedSourceFile; readonly existing?: DocumentRecordSummary }>
  readonly caseRenames: Array<{ readonly doc: DocumentRecordSummary; readonly file: WalkedSourceFile }>
  rename?: { readonly doc: DocumentRecordSummary; readonly file: WalkedSourceFile }
  readonly capSkipped: number
}

/** 事件缓冲：大批量变更时只保留一条 `sync_completed` 汇总，库级通知与告警始终逐条记。 */
interface SyncReport {
  changeCount: number
  probeLogged: boolean
  readonly infoEvents: AppendKnowledgeEventInput[]
  readonly systemEvents: AppendKnowledgeEventInput[]
  readonly alertEvents: AppendKnowledgeEventInput[]
}

/**
 * 创建同步引擎。所有外部效应（存储、提取、注册表、事件）都通过注入的客户端完成，
 * 计时器与磁盘监听只在显式 `startKb` / `resumeWatch` 后启动，`dispose` 幂等。
 */
export function createKnowledgeSyncEngine(opts: KnowledgeSyncEngineOptions): KnowledgeSyncEngine {
  const profileDir = opts.profileDir
  const storage = opts.storage
  const pool = opts.pool
  const debounceMs = normalizeNumber(opts.debounceMs, DEFAULT_DEBOUNCE_MS, 0)
  const writeStableMs = normalizeNumber(opts.writeStableMs, DEFAULT_WRITE_STABLE_MS, 0)
  const reconcileIntervalMs = normalizeNumber(opts.reconcileIntervalMs, DEFAULT_RECONCILE_INTERVAL_MS, 1)
  const clockJumpThresholdMs = normalizeNumber(opts.clockJumpThresholdMs, DEFAULT_CLOCK_JUMP_MS, 0)
  const maxFilesPerKb = normalizeCap(opts.maxFilesPerKb)
  const nowWall = opts.nowWall ?? ((): number => Date.now())
  const nowMono = opts.nowMono ?? ((): number => performance.now())
  const watchFactory: SyncWatchFactory = opts.watchFactory
    ?? ((sourceDir: string) => watch(sourceDir, { recursive: true }))
  const probeCloud = opts.detectCloudPlaceholder ?? ((filePath: string) => detectCloudPlaceholder(filePath))
  const cancelOrganizerForKb = opts.cancelOrganizerForKb

  const runtimes = new Map<string, Runtime>()
  const locks = new Map<string, { readonly mode: 'maintain' | 'delete' }>()
  const listeners = new Set<() => void>()
  const staggerTimers = new Set<NodeJS.Timeout>()
  let lastWall = nowWall()
  let lastMono = nowMono()
  let disposed = false

  function kbDirOf(kbId: string): string {
    return neutralKnowledgeRootPath(profileDir, kbId)
  }

  function idlePhase(runtime: Runtime): KnowledgePhase {
    if (runtime.watchPaused) return 'watch-paused'
    if (runtime.sourceUnavailable) return 'source-unavailable'
    if (runtime.watchFailed) return 'watch-failed'
    return 'watching'
  }

  function settlePhase(runtime: Runtime): void {
    if (runtime.maintaining) return
    if (needsRecovery(runtime.phase)) return
    runtime.phase = idlePhase(runtime)
  }

  function requireRuntime(kbId: string): Runtime {
    const runtime = runtimes.get(kbId)
    if (runtime === undefined) {
      throw new KnowledgeSyncError('knowledge-base-not-found', `knowledge base ${kbId} is not started`)
    }
    return runtime
  }

  function enqueue(runtime: Runtime, task: () => Promise<void>): Promise<void> {
    const run = runtime.chain.then(task, task)
    runtime.chain = run.then(() => undefined, () => undefined)
    return run
  }

  async function appendEvent(kbDir: string, input: AppendKnowledgeEventInput): Promise<void> {
    try {
      await appendKnowledgeEvent(kbDir, input)
    } catch {
      // 事件日志写失败绝不阻断同步主流程。
    }
  }

  function closeWatcher(runtime: Runtime): void {
    const watcher = runtime.watcher
    runtime.watcher = undefined
    if (watcher === undefined) return
    try {
      watcher.close()
    } catch {
      // 句柄可能已自行关闭。
    }
  }

  function isRuntimeLive(runtime: Runtime): boolean {
    return !disposed && !runtime.stopped && runtimes.get(runtime.record.id) === runtime
  }

  function canRunBackgroundSync(runtime: Runtime): boolean {
    return isRuntimeLive(runtime)
      && !runtime.watchPaused
      && !runtime.maintaining
      && !locks.has(runtime.record.id)
  }

  function cancelRuntimeStaggerTimers(runtime: Runtime): void {
    for (const cancel of [...runtime.staggerCancels]) cancel()
    runtime.staggerCancels.clear()
  }

  function scheduleRuntimeStagger(
    runtime: Runtime,
    delayMs: number,
    action: () => void,
    onCancel?: () => void,
  ): void {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      staggerTimers.delete(timer)
      runtime.staggerCancels.delete(cancel)
      action()
    }, delayMs)
    const cancel = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      staggerTimers.delete(timer)
      runtime.staggerCancels.delete(cancel)
      onCancel?.()
    }
    staggerTimers.add(timer)
    runtime.staggerCancels.add(cancel)
  }

  function ensureWatcher(runtime: Runtime): void {
    if (!isRuntimeLive(runtime) || runtime.watchPaused || runtime.sourceUnavailable || runtime.maintaining || locks.has(runtime.record.id)) return
    if (runtime.watcher !== undefined) return
    try {
      const watcher = watchFactory(runtime.record.sourceDir)
      watcher.on('change', (_eventType: string, filename: string | Buffer | null) => {
        onWatcherEvent(runtime, filename)
      })
      watcher.on('error', (error: Error) => {
        onWatcherError(runtime, error)
      })
      runtime.watcher = watcher
      runtime.watchFailed = false
    } catch (error) {
      runtime.watchFailed = true
      runtime.lastError = describeError(error)
      settlePhase(runtime)
      void appendEvent(kbDirOf(runtime.record.id), {
        kind: 'watch_failed',
        level: 'warn',
        summary: `文件监听不可用，已降级为定时/手动同步: ${describeError(error)}`,
      })
    }
  }

  function onWatcherError(runtime: Runtime, error: Error): void {
    closeWatcher(runtime)
    runtime.watchFailed = true
    runtime.lastError = describeError(error)
    settlePhase(runtime)
    void appendEvent(kbDirOf(runtime.record.id), {
      kind: 'watch_failed',
      level: 'warn',
      summary: `文件监听失败，已降级为定时/手动同步: ${describeError(error)}`,
    })
  }

  function clearDebounce(runtime: Runtime): void {
    if (runtime.debounceTimer === undefined) return
    clearTimeout(runtime.debounceTimer)
    runtime.debounceTimer = undefined
  }

  function onWatcherEvent(runtime: Runtime, filename: string | Buffer | null): void {
    if (!canRunBackgroundSync(runtime)) return
    const name = typeof filename === 'string' ? filename : filename === null ? '' : filename.toString()
    if (name !== '') runtime.dirtyPaths.add(name)
    clearDebounce(runtime)
    runtime.debounceTimer = setTimeout(() => {
      runtime.debounceTimer = undefined
      void enqueue(runtime, async () => {
        if (!canRunBackgroundSync(runtime)) {
          runtime.dirtyPaths.clear()
          return
        }
        await waitForWriteStable(runtime)
        runtime.dirtyPaths.clear()
        // I-3：写稳等待期间若发生暂停、维护、删库或退场，绝不继续发起全量对账。
        if (!canRunBackgroundSync(runtime)) return
        await enqueueReconcileNow(runtime, { allowRename: true, trigger: 'debounce' })
      }).catch(() => undefined)
    }, debounceMs)
  }

  async function statSnapshot(runtime: Runtime, names: readonly string[]): Promise<Map<string, string>> {
    const snapshot = new Map<string, string>()
    for (const name of names) {
      if (name === '' || isAbsolute(name) || name.includes('..')) {
        snapshot.set(name, '')
        continue
      }
      try {
        const info = await lstat(join(runtime.record.sourceDir, name))
        snapshot.set(name, `${String(info.size)}:${String(info.mtimeMs)}`)
      } catch {
        snapshot.set(name, 'missing')
      }
    }
    return snapshot
  }

  function sameSnapshot(left: Map<string, string>, right: Map<string, string>): boolean {
    if (left.size !== right.size) return false
    for (const [key, value] of left) {
      if (right.get(key) !== value) return false
    }
    return true
  }

  async function waitForWriteStable(runtime: Runtime): Promise<void> {
    const names = [...runtime.dirtyPaths]
    if (names.length === 0 || writeStableMs === 0) return
    let previous = await statSnapshot(runtime, names)
    for (let attempt = 0; attempt < WRITE_STABLE_MAX_ATTEMPTS; attempt += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, writeStableMs)
      })
      if (!canRunBackgroundSync(runtime)) return
      const next = await statSnapshot(runtime, names)
      if (sameSnapshot(previous, next)) return
      previous = next
    }
  }

  async function listAllDocs(kbId: string): Promise<DocumentRecordSummary[]> {
    const all: DocumentRecordSummary[] = []
    let offset = 0
    for (;;) {
      const page = await storage.listDocs(kbId, { limit: LIST_DOCS_PAGE, offset })
      all.push(...page.docs)
      offset += page.docs.length
      if (page.docs.length === 0 || all.length >= page.total) return all
    }
  }

  async function ensureStorageReady(runtime: Runtime): Promise<void> {
    if (!needsRecovery(runtime.phase)) return
    const kbId = runtime.record.id
    const kbDir = kbDirOf(kbId)
    if (runtime.phase === 'index-error') {
      const opened = await storage.openKb(kbId, kbDir)
      if (!opened.ok) {
        runtime.phase = 'index-error'
        runtime.lastError = opened.error
        throw new KnowledgeSyncError('index-error', opened.error)
      }
      runtime.phase = opened.wikiResetPending ? 'wiki-reset-pending' : idlePhase(runtime)
    }
    if (runtime.phase === 'wiki-reset-pending') {
      const reset = await storage.retryPendingWikiReset(kbId, kbDir)
      if (!reset.ok) {
        runtime.phase = 'wiki-reset-pending'
        runtime.lastError = reset.error
        await appendEvent(kbDir, {
          kind: 'wiki_reset_failed',
          level: 'error',
          summary: `知识视图重置失败，等待重试: ${reset.error}`,
        })
        throw new KnowledgeSyncError('wiki-reset-pending', reset.error)
      }
      runtime.phase = idlePhase(runtime)
    }
  }

  function normalizeRelPath(runtime: Runtime, relPath: string): string {
    return runtime.caseSensitive ? relPath : relPath.toLowerCase()
  }

  function skippedInput(runtime: Runtime, file: WalkedSourceFile, reason: string): UpsertDocumentInput {
    return {
      relPath: file.relPath,
      normPath: normalizeRelPath(runtime, file.relPath),
      sha256: '',
      size: file.size,
      mtimeMs: file.mtimeMs,
      format: formatFromRelPath(file.relPath),
      extractMode: 'none',
      extractConfigHash: computeExtractConfigHash(),
      status: 'skipped',
      statusReason: reason,
      chunks: [],
    }
  }

  /** 重建时的单文件提取失败行：保留文件元数据，`status_reason` 记机器原因。 */
  function errorInput(runtime: Runtime, file: WalkedSourceFile, reason: string): UpsertDocumentInput {
    return {
      relPath: file.relPath,
      normPath: normalizeRelPath(runtime, file.relPath),
      sha256: '',
      size: file.size,
      mtimeMs: file.mtimeMs,
      format: formatFromRelPath(file.relPath),
      extractMode: 'none',
      extractConfigHash: computeExtractConfigHash(),
      status: 'error',
      statusReason: reason,
      chunks: [],
    }
  }

  /**
   * 单文件失败分类（规格 §2.3 / §5.3(1) / §6.2 / §10）：
   * - `aborted`：维护/退场中止（重建必须放弃并回滚）；
   * - `record-too-large`：超 50 MB 预算，落 `skipped` 行并记告警；
   * - `skip`：越界符号链接 / 环 / 非普通文件，不落 `documents` 行，只记跳过告警；
   * - `retryable`：`inode-replaced` 属并发替换瞬态失败，不锁死为 `error` 行，
   *   只记 `file_error` 告警，由下一次防抖/对账自动重试；
   * - `record-error`：`extract-timeout` / `worker-crashed` / `read-error` 等
   *   单文件失败（含确定性 OOM / 崩溃文件），落 `error` 行（保留 `(size, mtimeMs)`
   *   避免 5 分钟周期对账反复超时或打崩 Worker）并记告警。
   */
  function classifyFailure(
    reason: string,
  ): 'skip' | 'record-too-large' | 'aborted' | 'retryable' | 'record-error' {
    if (reason === 'file-too-large') return 'record-too-large'
    if (reason === 'symlink-outside-source' || reason === 'symlink-loop' || reason === 'not-regular-file') return 'skip'
    if (reason === 'aborted') return 'aborted'
    if (reason === 'inode-replaced') return 'retryable'
    return 'record-error'
  }

  async function prepareFile(
    runtime: Runtime,
    file: WalkedSourceFile,
    existing: DocumentRecordSummary | undefined,
    report: SyncReport,
  ): Promise<FileOutcome> {
    const kbId = runtime.record.id
    const probe: CloudPlaceholderState = probeCloud(file.absPath)
    if (probe === 'dehydrated') {
      // 规格 §6.1：未水合占位文件绝不 open() / 解析，只记 skipped。
      await storage.upsertDocument(kbId, skippedInput(runtime, file, CLOUD_DEHYDRATED_REASON))
      return { kind: 'skipped', reason: CLOUD_DEHYDRATED_REASON }
    }
    if (probe === 'probe-unavailable' && !report.probeLogged) {
      report.probeLogged = true
      report.systemEvents.push({
        kind: 'cloud_probe_unavailable',
        level: 'info',
        summary: '云盘占位属性探针不可用，按普通本地文件继续索引',
        detail: 'cloud-placeholder-probe-unavailable',
      })
    }

    const request: ExtractionFileRequest = {
      sourceRoot: runtime.record.sourceDir,
      filePath: file.absPath,
      relPath: file.relPath,
      caseSensitive: runtime.caseSensitive,
    }

    if (existing !== undefined) {
      // 先算 sha256（M-9 hash-only 通道）：内容与提取配置都没变时只更新元数据，
      // 零重切、零清向量、零清 organized_sha256（重绑短路即依赖这条路径）。
      const hashProbe = await pool.extractFile(kbId, { ...request, hashOnly: true })
      if (!hashProbe.ok) {
        const action = classifyFailure(hashProbe.reason)
        if (action === 'record-too-large') {
          await storage.upsertDocument(kbId, skippedInput(runtime, file, FILE_TOO_LARGE_REASON))
          return { kind: 'skipped', reason: FILE_TOO_LARGE_REASON }
        }
        if (action === 'skip') return { kind: 'skipped', reason: hashProbe.reason }
        if (action === 'aborted') return { kind: 'aborted' }
        if (action === 'record-error') {
          await storage.upsertDocument(kbId, errorInput(runtime, file, hashProbe.reason))
        }
        return {
          kind: 'failed',
          reason: hashProbe.reason,
          ...(hashProbe.error === undefined ? {} : { error: hashProbe.error }),
        }
      }
      if (hashProbe.hashOnly === true
        && existing.sha256 === hashProbe.sha256
        && existing.extractConfigHash === computeExtractConfigHash()) {
        await storage.updateDocumentMetadata(kbId, file.relPath, hashProbe.size, hashProbe.mtimeMs)
        return { kind: 'short-circuit' }
      }
    }

    const extracted: ExtractionFileResult = await pool.extractFile(kbId, request)
    if (!extracted.ok) {
      const action = classifyFailure(extracted.reason)
      if (action === 'record-too-large') {
        await storage.upsertDocument(kbId, skippedInput(runtime, file, FILE_TOO_LARGE_REASON))
        return { kind: 'skipped', reason: FILE_TOO_LARGE_REASON }
      }
      if (action === 'skip') return { kind: 'skipped', reason: extracted.reason }
      if (action === 'aborted') return { kind: 'aborted' }
      if (action === 'record-error') {
        await storage.upsertDocument(kbId, errorInput(runtime, file, extracted.reason))
      }
      return {
        kind: 'failed',
        reason: extracted.reason,
        ...(extracted.error === undefined ? {} : { error: extracted.error }),
      }
    }
    if (extracted.hashOnly === true) return { kind: 'failed', reason: 'read-error' }

    const input: UpsertDocumentInput = {
      relPath: file.relPath,
      normPath: normalizeRelPath(runtime, file.relPath),
      sha256: extracted.sha256,
      size: extracted.size,
      mtimeMs: extracted.mtimeMs,
      format: extracted.doc.format,
      extractMode: extracted.doc.extractMode,
      extractConfigHash: extracted.doc.extractConfigHash,
      status: extracted.doc.status,
      ...(extracted.doc.statusReason === undefined ? {} : { statusReason: extracted.doc.statusReason }),
      chunks: extracted.chunks,
    }
    await storage.upsertDocument(kbId, input)
    // 控制器裁决 M-9：只有真正完整提取 + 写库才 +1，短路路径不增计数。
    runtime.metrics.fullRechunkCount += 1
    return { kind: 'indexed', status: input.status }
  }

  async function planReconcile(
    runtime: Runtime,
    opts: ReconcileOptions,
    docs: readonly DocumentRecordSummary[],
    walked: readonly WalkedSourceFile[],
    report: SyncReport,
  ): Promise<ReconcilePlan> {
    const norm = (relPath: string): string => normalizeRelPath(runtime, relPath)
    const existingByKey = new Map<string, DocumentRecordSummary>()
    for (const doc of docs) existingByKey.set(norm(doc.relPath), doc)

    const accepted: WalkedSourceFile[] = []
    const retained: WalkedSourceFile[] = []
    let capSkipped = 0
    for (const file of walked) {
      if (accepted.length < maxFilesPerKb) {
        accepted.push(file)
        continue
      }
      // 超限但已入库的文件保留原记录（不删不改），只有新文件被跳过并计入汇总。
      if (existingByKey.has(norm(file.relPath))) {
        retained.push(file)
        continue
      }
      capSkipped += 1
    }

    // 已入库的超限文件同样进入 diskByKey：它们仍在盘上，绝不是「消失」，
    // 只是本周期不再重切/重写元数据（retainedKeys 在文档循环里跳过）。
    const diskByKey = new Map<string, WalkedSourceFile>()
    for (const file of accepted) diskByKey.set(norm(file.relPath), file)
    for (const file of retained) diskByKey.set(norm(file.relPath), file)
    const retainedKeys = new Set(retained.map((file) => norm(file.relPath)))

    const deletes: DocumentRecordSummary[] = []
    const upserts: Array<{ readonly file: WalkedSourceFile; readonly existing?: DocumentRecordSummary }> = []
    const caseRenames: Array<{ readonly doc: DocumentRecordSummary; readonly file: WalkedSourceFile }> = []
    const added: WalkedSourceFile[] = []

    for (const doc of docs) {
      const key = norm(doc.relPath)
      const file = diskByKey.get(key)
      if (file === undefined) {
        deletes.push(doc)
        continue
      }
      // 超限但已入库的文件本周期完全不动：不重切、不重写元数据、不参与大小写
      // 重命名（下一次它排序进入上限内时再恢复正常对账）。
      if (retainedKeys.has(key)) continue
      if (file.relPath !== doc.relPath) {
        // 大小写不敏感卷上的仅大小写重命名：同 norm 键、不同拼写。
        caseRenames.push({ doc, file })
        continue
      }
      if (file.size !== doc.size || file.mtimeMs !== doc.mtimeMs) {
        upserts.push({ file, existing: doc })
      }
    }
    for (const file of accepted) {
      if (!existingByKey.has(norm(file.relPath))) added.push(file)
    }

    let rename: { readonly doc: DocumentRecordSummary; readonly file: WalkedSourceFile } | undefined
    const onlyVanished = deletes[0]
    const onlyAdded = added[0]
    if (opts.allowRename
      && deletes.length === 1
      && added.length === 1
      && onlyVanished !== undefined
      && onlyAdded !== undefined) {
      // I-2（规格 §6.1）：1:1 重命名哈希探针之前必须先查云占位属性，
      // 脱水占位文件绝不 open() 读内容，留给删除 + `cloud-placeholder-dehydrated` 分支。
      const cloudProbe = probeCloud(onlyAdded.absPath)
      if (cloudProbe === 'probe-unavailable' && !report.probeLogged) {
        report.probeLogged = true
        report.systemEvents.push({
          kind: 'cloud_probe_unavailable',
          level: 'info',
          summary: '云盘占位属性探针不可用，按普通本地文件继续索引',
          detail: 'cloud-placeholder-probe-unavailable',
        })
      }
      if (cloudProbe !== 'dehydrated') {
        // 严格 1 对 1：sha256 相同且该哈希没有其它文档共享（否则视为副本，按删+增处理）。
        const probe = await pool.extractFile(runtime.record.id, {
          sourceRoot: runtime.record.sourceDir,
          filePath: onlyAdded.absPath,
          relPath: onlyAdded.relPath,
          caseSensitive: runtime.caseSensitive,
          hashOnly: true,
        })
        const sharedHash = docs.some(doc => doc.docId !== onlyVanished.docId && doc.sha256 === onlyVanished.sha256)
        if (probe.ok
          && probe.hashOnly === true
          && onlyVanished.sha256 !== ''
          && probe.sha256 === onlyVanished.sha256
          && !sharedHash) {
          rename = { doc: onlyVanished, file: onlyAdded }
          deletes.length = 0
          added.length = 0
        }
      }
    }

    for (const file of added) upserts.push({ file })
    return {
      deletes,
      upserts,
      caseRenames,
      ...(rename === undefined ? {} : { rename }),
      capSkipped,
    }
  }

  async function reconcileInner(
    runtime: Runtime,
    opts: ReconcileOptions,
    report: SyncReport,
  ): Promise<void> {
    const kb = runtime.record
    const kbId = kb.id
    const kbDir = kbDirOf(kbId)
    const epoch = runtime.epoch
    if (isSteadyPhase(runtime.phase)) runtime.phase = 'syncing'

    const walked = await walkSourceDirectory(kb.sourceDir, {
      caseSensitive: runtime.caseSensitive,
      shouldIgnore: shouldIgnoreSourceEntry,
    })
    if (runtime.epoch !== epoch) return
    const sourceBroken = walked.skipped.some(entry => entry.relPath === ''
      && (entry.reason === 'read-error' || entry.reason === 'not-regular-file'))
    if (sourceBroken) {
      if (!runtime.sourceUnavailable) {
        runtime.sourceUnavailable = true
        runtime.lastError = 'source directory is not readable'
        closeWatcher(runtime)
        settlePhase(runtime)
        await appendEvent(kbDir, {
          kind: 'source_unavailable',
          level: 'warn',
          summary: `源目录不可读，已保留索引与知识视图: ${kb.sourceDir}`,
        })
      }
      return
    }
    if (runtime.sourceUnavailable) {
      runtime.sourceUnavailable = false
      await appendEvent(kbDir, { kind: 'source_restored', level: 'info', summary: `源目录恢复可读: ${kb.sourceDir}` })
      ensureWatcher(runtime)
    }
    if (opts.trigger !== 'periodic' && opts.trigger !== 'debounce') {
      // 遍历层跳过（越界符号链接 / 环 / 非普通文件）只在启动、手动同步与重绑时
      // 逐条记录，避免每 5 分钟周期对账把事件日志刷满。
      for (const skipped of walked.skipped) {
        report.alertEvents.push({
          kind: 'file_skipped',
          level: 'warn',
          summary: `跳过不受支持或不安全的文件（${skipped.reason}）`,
          detail: skipped.reason,
          ...(skipped.relPath === '' ? {} : { relPath: skipped.relPath }),
        })
      }
    }

    let docs: DocumentRecordSummary[]
    try {
      docs = await listAllDocs(kbId)
    } catch (error) {
      runtime.phase = 'index-error'
      runtime.lastError = describeError(error)
      await appendEvent(kbDir, {
        kind: 'file_error',
        level: 'error',
        summary: `索引暂不可用: ${describeError(error)}`,
      })
      return
    }
    if (runtime.epoch !== epoch) return

    const plan = await planReconcile(runtime, opts, docs, walked.files, report)
    if (runtime.epoch !== epoch) return

    if (plan.capSkipped > 0) {
      report.alertEvents.push({
        kind: 'file_skipped',
        level: 'warn',
        summary: `超过单库有效文件上限（${String(maxFilesPerKb)}），已跳过 ${String(plan.capSkipped)} 个文件`,
        detail: `${MAX_FILES_EXCEEDED_REASON}: ${String(plan.capSkipped)} file(s) exceed the per-KB cap of ${String(maxFilesPerKb)}`,
        count: plan.capSkipped,
      })
    }

    if (plan.rename !== undefined) {
      const renamed = await storage.renameDocument(kbId, {
        fromRelPath: plan.rename.doc.relPath,
        toRelPath: plan.rename.file.relPath,
        toNormPath: normalizeRelPath(runtime, plan.rename.file.relPath),
      })
      if (renamed.renamed) {
        report.changeCount += 1
        report.infoEvents.push({
          kind: 'file_renamed',
          level: 'info',
          summary: `文件重命名: ${plan.rename.doc.relPath} → ${plan.rename.file.relPath}`,
          detail: plan.rename.doc.relPath,
          relPath: plan.rename.file.relPath,
        })
      } else {
        // 猜配失败按删除 + 新增处理，绝不留下指向旧 rel_path 的僵尸记录。
        plan.deletes.push(plan.rename.doc)
        plan.upserts.push({ file: plan.rename.file })
      }
    }

    for (const entry of plan.caseRenames) {
      const renamed = await storage.renameDocument(kbId, {
        fromRelPath: entry.doc.relPath,
        toRelPath: entry.file.relPath,
        toNormPath: normalizeRelPath(runtime, entry.file.relPath),
      })
      if (renamed.renamed) {
        report.changeCount += 1
        report.infoEvents.push({
          kind: 'file_renamed',
          level: 'info',
          summary: `文件大小写重命名: ${entry.doc.relPath} → ${entry.file.relPath}`,
          detail: entry.doc.relPath,
          relPath: entry.file.relPath,
        })
      } else {
        plan.deletes.push(entry.doc)
        plan.upserts.push({ file: entry.file })
      }
    }

    for (const doc of plan.deletes) {
      if (runtime.epoch !== epoch) return
      const deleted = await storage.deleteDocument(kbId, doc.relPath)
      if (!deleted.deleted) continue
      report.changeCount += 1
      report.infoEvents.push({
        kind: 'file_deleted',
        level: 'info',
        summary: `文件已删除: ${doc.relPath}`,
        relPath: doc.relPath,
      })
    }

    for (const entry of plan.upserts) {
      if (runtime.epoch !== epoch) return
      const outcome = await prepareFile(runtime, entry.file, entry.existing, report)
      if (outcome.kind === 'aborted') return
      if (outcome.kind === 'short-circuit') continue
      if (outcome.kind === 'indexed') {
        report.changeCount += 1
        report.infoEvents.push({
          kind: 'file_indexed',
          level: 'info',
          summary: `已索引: ${entry.file.relPath}`,
          detail: outcome.status,
          relPath: entry.file.relPath,
        })
        continue
      }
      if (outcome.kind === 'skipped') {
        report.alertEvents.push({
          kind: 'file_skipped',
          level: 'warn',
          summary: `跳过文件（${outcome.reason}）: ${entry.file.relPath}`,
          detail: outcome.reason,
          relPath: entry.file.relPath,
        })
        continue
      }
      report.alertEvents.push({
        kind: 'file_error',
        level: 'error',
        summary: `提取失败（${outcome.reason}）: ${entry.file.relPath}`,
        detail: outcome.error ?? outcome.reason,
        relPath: entry.file.relPath,
      })
    }

    if (runtime.epoch !== epoch) return
    await flushReport(kbDir, report)
    runtime.lastSyncedAt = new Date(nowWall()).toISOString()
    settlePhase(runtime)
  }

  async function flushReport(kbDir: string, report: SyncReport): Promise<void> {
    if (report.changeCount > BATCH_EVENT_FOLD_THRESHOLD) {
      // 单批 > 5 个变更折叠为一条汇总事件；告警与错误仍逐条记录。
      await appendEvent(kbDir, {
        kind: 'sync_completed',
        level: 'info',
        summary: `同步完成，共处理 ${String(report.changeCount)} 个变更`,
        count: report.changeCount,
      })
    } else {
      for (const event of report.infoEvents) await appendEvent(kbDir, event)
      if (report.changeCount > 0) {
        await appendEvent(kbDir, {
          kind: 'sync_completed',
          level: 'info',
          summary: `同步完成，共处理 ${String(report.changeCount)} 个变更`,
          count: report.changeCount,
        })
      }
    }
    for (const event of report.systemEvents) await appendEvent(kbDir, event)
    for (const event of report.alertEvents) await appendEvent(kbDir, event)
  }

  async function reconcile(runtime: Runtime, opts: ReconcileOptions): Promise<void> {
    const report: SyncReport = {
      changeCount: 0,
      probeLogged: false,
      infoEvents: [],
      systemEvents: [],
      alertEvents: [],
    }
    try {
      await reconcileInner(runtime, opts, report)
    } catch (error) {
      runtime.lastError = describeError(error)
      settlePhase(runtime)
      if (opts.trigger === 'manual' || opts.trigger === 'rebind') throw error
    }
  }

  /** 在已排队的任务里先做幂等恢复（wiki-reset-pending / index-error）再对账。 */
  async function enqueueReconcileNow(runtime: Runtime, opts: ReconcileOptions): Promise<void> {
    if (!isRuntimeLive(runtime)) return
    if (opts.trigger !== 'manual' && opts.trigger !== 'rebind') {
      // C-1 / I-3 / I-4：后台触发（startup/debounce/periodic/resume）在维护、暂停或停机时立即早退。
      if (!canRunBackgroundSync(runtime)) return
    } else if (opts.trigger === 'manual' && (runtime.maintaining || locks.has(runtime.record.id))) {
      throw new KnowledgeSyncError('knowledge-base-busy', `knowledge base ${runtime.record.id} is under maintenance`)
    }
    const epoch = runtime.epoch
    try {
      await ensureStorageReady(runtime)
    } catch (error) {
      runtime.lastError = describeError(error)
      if (opts.trigger === 'manual') throw error
      return
    }
    if (runtime.epoch !== epoch || !isRuntimeLive(runtime)) return
    await reconcile(runtime, opts)
  }

  function enqueueReconcile(runtime: Runtime, opts: ReconcileOptions): Promise<void> {
    return enqueue(runtime, () => enqueueReconcileNow(runtime, opts))
  }

  async function startKb(kb: KnowledgeBaseRecord): Promise<void> {
    if (disposed) throw new KnowledgeSyncError('knowledge-base-busy', 'knowledge sync engine is disposed')
    if (runtimes.has(kb.id)) await stopKb(kb.id)
    const kbDir = kbDirOf(kb.id)
    await mkdir(kbDir, { recursive: true, mode: 0o700 })
    let caseSensitive = process.platform !== 'win32'
    try {
      caseSensitive = await probeCaseSensitiveDir(kb.sourceDir)
    } catch {
      // 探测失败按平台保守回退。
    }
    const runtime: Runtime = {
      record: kb,
      phase: 'watching',
      watchPaused: kb.watchPaused,
      caseSensitive,
      watcher: undefined,
      watchFailed: false,
      sourceUnavailable: false,
      dirtyPaths: new Set<string>(),
      debounceTimer: undefined,
      staggerCancels: new Set<() => void>(),
      chain: Promise.resolve(),
      epoch: 0,
      maintaining: false,
      stopped: false,
      metrics: { fullRechunkCount: 0, periodicReconcileCount: 0 },
    }
    runtimes.set(kb.id, runtime)

    const opened = await storage.openKb(kb.id, kbDir)
    if (!opened.ok) {
      runtime.phase = 'index-error'
      runtime.lastError = opened.error
      return
    }
    runtime.phase = opened.wikiResetPending ? 'wiki-reset-pending' : idlePhase(runtime)
    if (kb.watchPaused) {
      // 恢复阶段（wiki-reset-pending / index-error）不能被「暂停监听」覆盖，
      // 否则手动同步会丢失幂等恢复入口。
      if (!needsRecovery(runtime.phase)) runtime.phase = 'watch-paused'
      return
    }
    try {
      await access(kb.sourceDir, R_OK)
    } catch (error) {
      if (isSourceMissingError(error)) {
        runtime.sourceUnavailable = true
        if (!needsRecovery(runtime.phase)) runtime.phase = 'source-unavailable'
        runtime.lastError = describeError(error)
        await appendEvent(kbDir, {
          kind: 'source_unavailable',
          level: 'warn',
          summary: `源目录不可读，已保留索引与知识视图: ${kb.sourceDir}`,
        })
        return
      }
    }
    ensureWatcher(runtime)
    if (!needsRecovery(runtime.phase)) runtime.phase = idlePhase(runtime)
    // 启动自动全量对账：多库按注册顺序错峰，避免同时扫盘与同时抢 Worker。
    const stagger = (runtimes.size - 1) * STAGGER_STEP_MS
    if (stagger === 0) {
      void enqueueReconcile(runtime, { allowRename: true, trigger: 'startup' }).catch(() => undefined)
      return
    }
    scheduleRuntimeStagger(runtime, stagger, () => {
      if (!canRunBackgroundSync(runtime)) return
      void enqueueReconcile(runtime, { allowRename: true, trigger: 'startup' }).catch(() => undefined)
    })
  }

  /**
   * 停机序列的共享内核：注销运行态、置 `stopped`、取消全部错峰定时器、递增 epoch、
   * 关 Watcher、清防抖与 dirty、中止并排空该库 Extraction Worker（等待句柄随线程退出
   * 关闭），最后等链尾。调用方负责随后的整理取消与 SQLite 关闭，绝不复制这段顺序。
   */
  async function haltRuntime(kbId: string): Promise<boolean> {
    const runtime = runtimes.get(kbId)
    if (runtime === undefined) return false
    runtime.stopped = true
    runtimes.delete(kbId)
    runtime.epoch += 1
    cancelRuntimeStaggerTimers(runtime)
    closeWatcher(runtime)
    clearDebounce(runtime)
    runtime.dirtyPaths.clear()
    await pool.abortAndDrainKb(kbId)
    await runtime.chain.catch(() => undefined)
    return true
  }

  async function closeStorageQuietly(kbId: string): Promise<void> {
    try {
      await storage.closeKb(kbId)
    } catch {
      // 关闭失败不影响停机结果。
    }
  }

  async function stopKb(kbId: string): Promise<void> {
    if (!(await haltRuntime(kbId))) return
    await closeStorageQuietly(kbId)
  }

  /**
   * 删库停机（控制器裁决 M-4 / 规格 §5.2(6)）：常规停机后取消在途整理，再关
   * SQLite。Host 只在之后删除 `workspace-knowledge/<kbId>` 与原子更新注册表。
   */
  async function shutdownKbForDelete(kbId: string): Promise<void> {
    await haltRuntime(kbId)
    if (cancelOrganizerForKb !== undefined) {
      try {
        await cancelOrganizerForKb(kbId)
      } catch {
        // 整理回合取消失败不阻断删库停机。
      }
    }
    await closeStorageQuietly(kbId)
  }

  async function pauseWatch(kbId: string): Promise<void> {
    const runtime = requireRuntime(kbId)
    if (runtime.watchPaused) return
    runtime.watchPaused = true
    if (!needsRecovery(runtime.phase)) runtime.phase = 'watch-paused'
    runtime.epoch += 1
    closeWatcher(runtime)
    clearDebounce(runtime)
    runtime.dirtyPaths.clear()
    // 规格 §6.1：暂停应答返回前必须让在途 FileHandle 全部关闭。
    await pool.abortAndDrainKb(kbId)
    await runtime.chain.catch(() => undefined)
    if (!runtime.maintaining && !needsRecovery(runtime.phase)) runtime.phase = 'watch-paused'
  }

  async function resumeWatch(kbId: string): Promise<void> {
    const runtime = requireRuntime(kbId)
    runtime.watchPaused = false
    runtime.watchFailed = false
    closeWatcher(runtime)
    ensureWatcher(runtime)
    if (!needsRecovery(runtime.phase)) runtime.phase = idlePhase(runtime)
    await enqueueReconcile(runtime, { allowRename: true, trigger: 'resume' })
  }

  async function syncNow(kbId: string): Promise<void> {
    const runtime = await ensureRuntime(kbId)
    if (locks.has(kbId) || runtime.maintaining) {
      throw new KnowledgeSyncError('knowledge-base-busy', `knowledge base ${kbId} is under maintenance`)
    }
    await enqueueReconcile(runtime, { allowRename: true, trigger: 'manual' })
  }

  async function ensureRuntime(kbId: string): Promise<Runtime> {
    const existing = runtimes.get(kbId)
    if (existing !== undefined) return existing
    const records = await readKnowledgeBases(profileDir)
    const record = records.find(entry => entry.id === kbId)
    if (record === undefined) {
      throw new KnowledgeSyncError('knowledge-base-not-found', `knowledge base ${kbId} is not registered`)
    }
    await startKb(record)
    const started = runtimes.get(kbId)
    if (started === undefined) {
      throw new KnowledgeSyncError('index-error', `knowledge base ${kbId} could not be started`)
    }
    return started
  }

  async function acquireLifecycleLock(kbId: string, mode: 'maintain' | 'delete'): Promise<() => void> {
    if (locks.has(kbId)) {
      throw new KnowledgeSyncError('knowledge-base-busy', `knowledge base ${kbId} is busy`)
    }
    const entry: { readonly mode: 'maintain' | 'delete' } = { mode }
    locks.set(kbId, entry)
    return () => {
      if (locks.get(kbId) === entry) locks.delete(kbId)
    }
  }

  /** 维护/重建共用的停机序列：取消错峰 → 停 Watcher → 清防抖与 dirty → 取消整理 → 排空提取。 */
  async function stopSequence(runtime: Runtime): Promise<void> {
    runtime.epoch += 1
    cancelRuntimeStaggerTimers(runtime)
    closeWatcher(runtime)
    clearDebounce(runtime)
    runtime.dirtyPaths.clear()
    if (cancelOrganizerForKb !== undefined) {
      try {
        await cancelOrganizerForKb(runtime.record.id)
      } catch {
        // 整理回合取消失败不阻断停机序列。
      }
    }
    await pool.abortAndDrainKb(runtime.record.id)
    await runtime.chain.catch(() => undefined)
  }

  async function rebindSourceDir(
    kbId: string,
    newSourceDir: string,
    realSourceDir: string,
    persist: () => Promise<void>,
  ): Promise<void> {
    const runtime = await ensureRuntime(kbId)
    const release = await acquireLifecycleLock(kbId, 'maintain')
    try {
      runtime.maintaining = true
      await stopSequence(runtime)
      // 注册表唯一写者是 Host：先落盘并更新 Host 内存，再收敛运行态与索引。
      // `persist` 失败时完全保留旧 sourceDir、旧索引与旧 wiki（运行态在 finally
      // 用旧记录恢复 Watcher）。
      await persist()
      runtime.record = { ...runtime.record, sourceDir: newSourceDir }
      runtime.sourceUnavailable = false
      runtime.watchFailed = false
      try {
        runtime.caseSensitive = await probeCaseSensitiveDir(realSourceDir)
      } catch {
        runtime.caseSensitive = process.platform !== 'win32'
      }
      // 恢复阶段（wiki-reset-pending / index-error）不能被重绑静默抹除：
      // 保留该阶段直到显式重试/重建完成（规格 §6.4）。
      if (!needsRecovery(runtime.phase)) runtime.phase = idlePhase(runtime)
      // 保留 index.sqlite 与 wiki/，禁用跨目录重命名猜配做全量对账。
      try {
        await enqueue(runtime, () => reconcile(runtime, { allowRename: false, trigger: 'rebind' }))
      } catch (error) {
        // 落盘已成功：收敛失败不回滚、不重写旧目录，磁盘与内存都保持新
        // `sourceDir`，由下次启动对账自愈（规格 §6.4 失败与中断恢复）。
        runtime.lastError = describeError(error)
      }
      await appendEvent(kbDirOf(kbId), {
        kind: 'source_rebound',
        level: 'info',
        summary: `源目录已重绑: ${newSourceDir}`,
        detail: newSourceDir,
      })
      settlePhase(runtime)
    } finally {
      runtime.maintaining = false
      release()
      ensureWatcher(runtime)
      settlePhase(runtime)
    }
  }

  async function rebuildIndex(kbId: string): Promise<void> {
    const runtime = await ensureRuntime(kbId)
    if (runtime.sourceUnavailable) {
      throw new KnowledgeSyncError('source-unavailable', 'source directory is unavailable; rebind it first')
    }
    const release = await acquireLifecycleLock(kbId, 'maintain')
    // C-1：拿到维护锁后立刻置 `maintaining = true`（早于 `access()`），挡住周期/休眠/防抖对账。
    runtime.maintaining = true
    const kbDir = kbDirOf(kbId)
    let committed = false
    try {
      try {
        await access(runtime.record.sourceDir, R_OK)
      } catch (error) {
        throw new KnowledgeSyncError('source-unavailable', `source directory is not readable: ${describeError(error)}`)
      }
      await stopSequence(runtime)
      // C-1：重建主体串行挂入 `runtime.chain`，彻底杜绝与任何后台对账并发写入活库连接。
      await enqueue(runtime, async () => {
        runtime.phase = 'rebuilding'
        // I-7：正常重建前先读取既有文档键集，保留排在上限外但已入库且仍在盘上的文件，
        // 避免重建撤销对账保留语义并给盘上存活文件误写墓碑。
        let existingKeys = new Set<string>()
        try {
          const existingDocs = await listAllDocs(kbId)
          existingKeys = new Set(existingDocs.map(doc => normalizeRelPath(runtime, doc.relPath)))
        } catch {
          // 旧库已损坏时进入损坏恢复重建，不继承旧文档集合。
        }
        await storage.beginRebuild(kbId, kbDir)
        const walked = await walkSourceDirectory(runtime.record.sourceDir, {
          caseSensitive: runtime.caseSensitive,
          shouldIgnore: shouldIgnoreSourceEntry,
        })
        const sourceBroken = walked.skipped.some(entry => entry.relPath === ''
          && (entry.reason === 'read-error' || entry.reason === 'not-regular-file'))
        if (sourceBroken) {
          throw new KnowledgeSyncError('source-unavailable', 'source directory became unreadable during rebuild')
        }
        const accepted: WalkedSourceFile[] = []
        const retained: WalkedSourceFile[] = []
        let capSkipped = 0
        for (const file of walked.files) {
          if (accepted.length < maxFilesPerKb) {
            accepted.push(file)
            continue
          }
          if (existingKeys.has(normalizeRelPath(runtime, file.relPath))) {
            retained.push(file)
            continue
          }
          capSkipped += 1
        }
        const files = [...accepted, ...retained]
        const alertEvents: AppendKnowledgeEventInput[] = []
        if (capSkipped > 0) {
          alertEvents.push({
            kind: 'file_skipped',
            level: 'warn',
            summary: `超过单库有效文件上限（${String(maxFilesPerKb)}），已跳过 ${String(capSkipped)} 个文件`,
            detail: `${MAX_FILES_EXCEEDED_REASON}: ${String(capSkipped)} file(s) exceed the per-KB cap of ${String(maxFilesPerKb)}`,
            count: capSkipped,
          })
        }
        for (const skipped of walked.skipped) {
          alertEvents.push({
            kind: 'file_skipped',
            level: 'warn',
            summary: `跳过不受支持或不安全的文件（${skipped.reason}）`,
            detail: skipped.reason,
            ...(skipped.relPath === '' ? {} : { relPath: skipped.relPath }),
          })
        }
        let rebuilt = 0
        let skippedFiles = capSkipped
        let failedFiles = 0
        let probeLogged = false
        for (const file of files) {
          const probe = probeCloud(file.absPath)
          if (probe === 'dehydrated') {
            await storage.upsertRebuildDocument(kbId, skippedInput(runtime, file, CLOUD_DEHYDRATED_REASON))
            skippedFiles += 1
            alertEvents.push({
              kind: 'file_skipped',
              level: 'warn',
              summary: `跳过文件（${CLOUD_DEHYDRATED_REASON}）: ${file.relPath}`,
              detail: CLOUD_DEHYDRATED_REASON,
              relPath: file.relPath,
            })
            continue
          }
          if (probe === 'probe-unavailable' && !probeLogged) {
            probeLogged = true
            alertEvents.push({
              kind: 'cloud_probe_unavailable',
              level: 'info',
              summary: '云盘占位属性探针不可用，按普通本地文件继续索引',
              detail: 'cloud-placeholder-probe-unavailable',
            })
          }
          const extracted = await pool.extractFile(kbId, {
            sourceRoot: runtime.record.sourceDir,
            filePath: file.absPath,
            relPath: file.relPath,
            caseSensitive: runtime.caseSensitive,
          })
          if (!extracted.ok) {
            const action = classifyFailure(extracted.reason)
            if (action === 'aborted') {
              // 维护中止/退场：重建必须放弃并回滚旧库（规格 §6.4 提交前失败）。
              throw new KnowledgeSyncError('rebuild-failed', `${file.relPath}: ${extracted.reason}`)
            }
            if (action === 'record-too-large') {
              await storage.upsertRebuildDocument(kbId, skippedInput(runtime, file, FILE_TOO_LARGE_REASON))
              skippedFiles += 1
              alertEvents.push({
                kind: 'file_skipped',
                level: 'warn',
                summary: `跳过文件（${FILE_TOO_LARGE_REASON}）: ${file.relPath}`,
                detail: FILE_TOO_LARGE_REASON,
                relPath: file.relPath,
              })
              continue
            }
            if (action === 'skip') {
              // 越界符号链接 / 环 / 非普通文件与常规对账一致：不写入 documents，仅记告警。
              skippedFiles += 1
              alertEvents.push({
                kind: 'file_skipped',
                level: 'warn',
                summary: `跳过文件（${extracted.reason}）: ${file.relPath}`,
                detail: extracted.reason,
                relPath: file.relPath,
              })
              continue
            }
            if (action === 'record-error') {
              // 规格 §2.3 / §10 单文件失败隔离：记 error 行后继续重建，避免周期对账无限重试。
              await storage.upsertRebuildDocument(kbId, errorInput(runtime, file, extracted.reason))
            }
            // `retryable`（inode-replaced）不写 error 行，使下次同步自动重试。
            failedFiles += 1
            alertEvents.push({
              kind: 'file_error',
              level: 'error',
              summary: `提取失败（${extracted.reason}）: ${file.relPath}`,
              detail: extracted.error ?? extracted.reason,
              relPath: file.relPath,
            })
            continue
          }
          if (extracted.hashOnly === true) continue
          await storage.upsertRebuildDocument(kbId, {
            relPath: file.relPath,
            normPath: normalizeRelPath(runtime, file.relPath),
            sha256: extracted.sha256,
            size: extracted.size,
            mtimeMs: extracted.mtimeMs,
            format: extracted.doc.format,
            extractMode: extracted.doc.extractMode,
            extractConfigHash: extracted.doc.extractConfigHash,
            status: extracted.doc.status,
            ...(extracted.doc.statusReason === undefined ? {} : { statusReason: extracted.doc.statusReason }),
            chunks: extracted.chunks,
          })
          rebuilt += 1
        }
        for (const event of alertEvents) await appendEvent(kbDir, event)
        const commitOptions = {
          ...(opts.afterCommitBeforeReopenForTest === undefined
            ? {}
            : { afterCommitBeforeReopenForTest: opts.afterCommitBeforeReopenForTest }),
          ...(opts.failWikiResetOnceForTest === undefined
            ? {}
            : { failWikiResetOnceForTest: opts.failWikiResetOnceForTest }),
        }
        const result = await storage.commitRebuild(kbId, kbDir, commitOptions)
        if (!result.ok) {
          if (result.code === 'index-error') runtime.phase = 'index-error'
          throw new KnowledgeSyncError(
            result.code === 'index-error' ? 'index-error' : 'rebuild-failed',
            result.error,
          )
        }
        committed = true
        if (result.wikiResetPending) {
          // 提交已成功但 Wiki 重置失败：保留 pending 与 `wiki-reset-pending` 阶段，
          // 由后续 sync（ensureStorageReady）幂等续做（规格 §6.4）。
          runtime.phase = 'wiki-reset-pending'
          await appendEvent(kbDir, {
            kind: 'wiki_reset_failed',
            level: 'error',
            summary: '知识视图重置失败，等待重试: wiki reset failed',
          })
        } else {
          runtime.phase = idlePhase(runtime)
        }
        await appendEvent(kbDir, {
          kind: 'rebuild_completed',
          level: 'info',
          summary: skippedFiles === 0 && failedFiles === 0
            ? `索引重建完成，共 ${String(rebuilt)} 个文件`
            : `索引重建完成，共 ${String(rebuilt)} 个文件（跳过 ${String(skippedFiles)}，失败 ${String(failedFiles)}）`,
          count: rebuilt,
        })
      })
    } catch (error) {
      if (!committed) {
        try {
          await storage.abortRebuild(kbId, kbDir)
        } catch {
          // 放弃暂存库失败由启动恢复清理。
        }
      }
      runtime.lastError = describeError(error)
      await appendEvent(kbDir, {
        kind: 'rebuild_failed',
        level: 'error',
        summary: `索引重建失败: ${describeError(error)}`,
      })
      if (!needsRecovery(runtime.phase)) settlePhase(runtime)
      throw error instanceof KnowledgeSyncError
        ? error
        : new KnowledgeSyncError('rebuild-failed', describeError(error))
    } finally {
      runtime.maintaining = false
      release()
      ensureWatcher(runtime)
      settlePhase(runtime)
    }
  }

  async function handleSystemResume(): Promise<void> {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // 监听者异常相互隔离。
      }
    }
    const tasks: Array<Promise<void>> = []
    let index = 0
    for (const runtime of runtimes.values()) {
      if (!canRunBackgroundSync(runtime)) continue
      const delay = index * STAGGER_STEP_MS
      index += 1
      tasks.push(new Promise<void>((resolve) => {
        const run = (): void => {
          if (!canRunBackgroundSync(runtime)) {
            resolve()
            return
          }
          // 规格 §6.1：休眠恢复为 !watchPaused 且非维护中的存活库重建 Watcher 并补一次对账。
          if (!runtime.sourceUnavailable) {
            closeWatcher(runtime)
            ensureWatcher(runtime)
          }
          void enqueueReconcile(runtime, { allowRename: true, trigger: 'resume' })
            .then(() => resolve(), () => resolve())
        }
        if (delay === 0) {
          run()
          return
        }
        scheduleRuntimeStagger(runtime, delay, run, () => resolve())
      }))
    }
    await Promise.all(tasks)
  }

  function onSystemResume(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  async function checkClockJump(): Promise<boolean> {
    const wall = nowWall()
    const mono = nowMono()
    const wallDelta = wall - lastWall
    const monoDelta = mono - lastMono
    lastWall = wall
    lastMono = mono
    const drift = Math.abs(wallDelta - monoDelta)
    if (drift <= clockJumpThresholdMs) return false
    await handleSystemResume()
    return true
  }

  const periodicTimer = setInterval(() => {
    if (disposed) return
    let index = 0
    for (const runtime of runtimes.values()) {
      if (!canRunBackgroundSync(runtime)) continue
      // 周期对账计数在调度时刻 +1（暂停或维护中的库不再计数）。
      runtime.metrics.periodicReconcileCount += 1
      const delay = index * STAGGER_STEP_MS
      index += 1
      const run = (): void => {
        if (!canRunBackgroundSync(runtime)) return
        void enqueueReconcile(runtime, { allowRename: true, trigger: 'periodic' }).catch(() => undefined)
      }
      if (delay === 0) {
        run()
        continue
      }
      scheduleRuntimeStagger(runtime, delay, run)
    }
  }, reconcileIntervalMs)
  const clockTimer = setInterval(() => {
    if (disposed) return
    void checkClockJump().catch(() => undefined)
  }, CLOCK_CHECK_INTERVAL_MS)

  return {
    startKb,
    stopKb,
    shutdownKbForDelete,
    pauseWatch,
    resumeWatch,
    syncNow,
    rebindSourceDir,
    rebuildIndex,
    handleSystemResume,
    onSystemResume,
    checkClockJump,
    acquireLifecycleLock,
    getState(kbId: string): KnowledgeRuntimeState | undefined {
      const runtime = runtimes.get(kbId)
      if (runtime === undefined) return undefined
      return {
        id: runtime.record.id,
        sourceDir: runtime.record.sourceDir,
        phase: runtime.phase,
        watchPaused: runtime.watchPaused,
        watching: runtime.watcher !== undefined,
        ...(runtime.lastSyncedAt === undefined ? {} : { lastSyncedAt: runtime.lastSyncedAt }),
        ...(runtime.lastError === undefined ? {} : { lastError: runtime.lastError }),
      }
    },
    getMetricsForTest(kbId: string): SyncEngineMetrics {
      const runtime = runtimes.get(kbId)
      if (runtime === undefined) return { fullRechunkCount: 0, periodicReconcileCount: 0 }
      return {
        fullRechunkCount: runtime.metrics.fullRechunkCount,
        periodicReconcileCount: runtime.metrics.periodicReconcileCount,
      }
    },
    setCaseSensitiveForTest(kbId: string, caseSensitive: boolean): void {
      requireRuntime(kbId).caseSensitive = caseSensitive
    },
    simulateWatchErrorForTest(kbId: string, err: Error): void {
      onWatcherError(requireRuntime(kbId), err)
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      clearInterval(periodicTimer)
      clearInterval(clockTimer)
      for (const runtime of runtimes.values()) cancelRuntimeStaggerTimers(runtime)
      for (const timer of staggerTimers) clearTimeout(timer)
      staggerTimers.clear()
      listeners.clear()
      const ids = [...runtimes.keys()]
      await Promise.all(ids.map(async (kbId) => {
        try {
          await stopKb(kbId)
        } catch {
          // 退场尽力而为：单个库停机失败不阻断其它库。
        }
      }))
    },
  }
}
