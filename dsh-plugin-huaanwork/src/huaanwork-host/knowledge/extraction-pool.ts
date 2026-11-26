/**
 * Extraction Worker 池（规格 §6.2 / 计划 Task 6）。
 *
 * 默认并发 1、封顶 2（`R3-B3`）：每个 Worker 独立线程、`maxOldGenerationSizeMb`
 * 固定 256 MB，惰性拉起（0 次提取不创建线程）。单文件超时后立即
 * `worker.terminate()` 并另起 Worker，该文件记 `extract-timeout`；暂停监听时
 * `abortAndDrainKb` 除落定在途 job 外还**等待责任 Worker 退出**（小预算封顶），
 * 保证暂停应答返回时源目录 `FileHandle` 已全部关闭（Windows 上可移动目录）；
 * 退场 `dispose` 同样以 terminate + 等待退出为兜底，绝不遗留空转 CPU 线程。
 *
 * Worker 协议只承载数据；`debugDelayMs`（异步延时）与 `debugBusyLoopMs`
 * （同步忙等）是测试缝：前者验证超时隔离，后者验证强制 terminate。
 *
 * 本文件会被 Worker / 测试以 `.ts` 源码直接加载（Node type-stripping），
 * 因此不得使用 `enum`、构造器参数属性与 `namespace`；纯类型导入必须写
 * `import type`，相对导入保留 `.ts` 后缀。
 */

import { Worker } from 'node:worker_threads'

import type { ChunkDraft, ExtractedDocument } from './types.ts'
import { resolveKnowledgeWorkerUrl } from './worker-paths.ts'

export const DEFAULT_EXTRACTION_WORKERS = 1
export const MAX_EXTRACTION_WORKERS = 2
export const DEFAULT_EXTRACTION_TIMEOUT_MS = 60_000
export const EXTRACTION_WORKER_MAX_OLD_GEN_MB = 256
/** 退场预算：到期直接放弃等待（terminate 已发出）。 */
export const EXTRACTION_POOL_DISPOSE_BUDGET_MS = 300
/**
 * 暂停监听排空预算（规格 §6.1）：暂停应答返回前等待在途 Worker 真正退出，
 * 让它们持有的源文件 `FileHandle` 随线程退出关闭（Windows 上目录可移动）。
 * 到期同样放弃等待，但 `terminate()` 早已发出。
 */
export const EXTRACTION_POOL_DRAIN_BUDGET_MS = 300

export interface ExtractionFileRequest {
  readonly sourceRoot: string
  readonly filePath: string
  readonly relPath: string
  readonly caseSensitive?: boolean
  readonly maxBytes?: number
  readonly maxDocTextBytes?: number
  /**
   * 只算 `sha256` / `size` / `mtimeMs`，不解析正文、不切片（控制器裁决 M-9）。
   * 重绑对 `rel_path` 匹配且 `mtime_ms` 变化的文件先走本通道比对内容。
   */
  readonly hashOnly?: boolean
  /** 测试缝：在 Worker 内延时（毫秒），验证异步超时隔离。 */
  readonly debugDelayMs?: number
  /** 测试缝：在 Worker 内同步占满 CPU（毫秒），验证强制 worker.terminate()。 */
  readonly debugBusyLoopMs?: number
}

/** Extraction Worker 的公开失败原因（M-17：与安全只读链一致，含 `symlink-loop`）。 */
export type ExtractionFailureReason =
  | 'extract-timeout'
  | 'aborted'
  | 'symlink-outside-source'
  | 'symlink-loop'
  | 'not-regular-file'
  | 'file-too-large'
  | 'inode-replaced'
  | 'read-error'
  | 'worker-crashed'

export type ExtractionFileResult =
  | { readonly ok: true; readonly hashOnly: true; readonly sha256: string; readonly size: number; readonly mtimeMs: number }
  | {
      readonly ok: true
      readonly hashOnly?: false
      readonly sha256: string
      readonly size: number
      readonly mtimeMs: number
      readonly doc: ExtractedDocument
      readonly chunks: readonly ChunkDraft[]
      readonly truncated: boolean
    }
  | { readonly ok: false; readonly reason: ExtractionFailureReason; readonly error?: string }

/** Worker 就绪握手：模块图（含提取器）加载完成后再开始计时单文件超时。 */
export interface ExtractionWorkerReadyMessage {
  readonly ready: true
}

/** 池 → Worker 的请求消息（Worker 只以 `import type` 引用，不加载本模块运行时）。 */
export interface ExtractionWorkerRequest {
  readonly id: number
  readonly request: ExtractionFileRequest
}

/** Worker → 池的响应消息。 */
export type ExtractionWorkerResponse =
  | { readonly id: number; readonly ok: true; readonly result: ExtractionFileResult }
  | { readonly id: number; readonly ok: false; readonly error: string }

export interface ExtractionPoolConfig {
  readonly maxWorkers: 1 | 2
  readonly timeoutMs: number
  readonly maxOldGenerationSizeMb: number
}

export interface ExtractionPoolOptions {
  readonly workerUrl?: URL
  /** 期望并发；钳制到 `[1, MAX_EXTRACTION_WORKERS]`。 */
  readonly maxWorkers?: number
  readonly timeoutMs?: number
}

export interface ExtractionPool {
  readonly config: ExtractionPoolConfig
  extractFile(kbId: string, req: ExtractionFileRequest, signal?: AbortSignal): Promise<ExtractionFileResult>
  /**
   * 中止该库排队/运行中的提取，terminate 责任 Worker，并等待线程退出
   * （受 `EXTRACTION_POOL_DRAIN_BUDGET_MS` 预算封顶）后才返回，
   * 保证暂停应答返回时在途源文件 `FileHandle` 已随 Worker 退出关闭。
   */
  abortAndDrainKb(kbId: string): Promise<void>
  isRunning(): boolean
  activeWorkerCount(): number
  /** 立即向全部 Extraction Worker 发 terminate() 并等待退出，受 budgetMs（默认 300 ms）竞态兜底。 */
  dispose(budgetMs?: number): Promise<void>
}

interface WorkerSlot {
  readonly worker: Worker
  readonly ready: Promise<void>
  /** 线程真正触发 `'exit'` 后落定，供排空与退场精确等待全部未退出线程（I-4 / M-1）。 */
  readonly exitPromise: Promise<void>
  /** `worker.terminate()` 返回的 Promise（测试 spy 可能延后其落定）。 */
  terminatePromise: Promise<void> | undefined
  dead: boolean
  exited: boolean
}

interface PendingJob {
  readonly kbId: string
  readonly id: number
  readonly slot: WorkerSlot
  readonly drainWaiters: Array<() => void>
  settled: boolean
  settle(result: ExtractionFileResult): void
}

/** 等待并发信号量的排队提取：暂停/退场/AbortSignal 时可直接撤销（false），尚未打开任何文件。 */
interface QueuedExtraction {
  readonly kbId: string
  readonly grant: (granted: boolean) => void
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 以 `budgetMs` 封顶等待一组 Worker 退出；`terminate()` 已发出，绝不无限挂起暂停/退场。 */
async function waitForWorkerExitUnderBudget(exits: readonly Promise<void>[], budgetMs: number): Promise<void> {
  if (exits.length === 0) return
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      Promise.all(exits).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function clampWorkers(value: number | undefined): 1 | 2 {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_EXTRACTION_WORKERS
  const truncated = Math.trunc(value)
  if (truncated < 1) return 1
  if (truncated > MAX_EXTRACTION_WORKERS) return MAX_EXTRACTION_WORKERS
  return truncated === 2 ? 2 : 1
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_EXTRACTION_TIMEOUT_MS
  return Math.max(1, Math.trunc(value))
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function isReadyMessage(message: ExtractionWorkerReadyMessage | ExtractionWorkerResponse): message is ExtractionWorkerReadyMessage {
  return (message as { ready?: unknown }).ready === true
}

/**
 * 创建 Extraction Worker 池。默认 1 个 Worker、单文件 60 秒超时、堆上限 256 MB；
 * Worker 惰性拉起，空闲复用，超时/中止即 terminate 后重建。
 */
export function createExtractionPool(opts: ExtractionPoolOptions = {}): ExtractionPool {
  const config: ExtractionPoolConfig = {
    maxWorkers: clampWorkers(opts.maxWorkers),
    timeoutMs: normalizeTimeout(opts.timeoutMs),
    maxOldGenerationSizeMb: EXTRACTION_WORKER_MAX_OLD_GEN_MB,
  }
  const workerUrl = opts.workerUrl

  let disposed = false
  let disposePromise: Promise<void> | undefined
  let activeCount = 0
  const semaphoreWaiters: QueuedExtraction[] = []
  const idleSlots: WorkerSlot[] = []
  const slots = new Set<WorkerSlot>()
  /** 全部尚未收到 `'exit'` 事件的 OS 线程集合（含正在退出中的槽位，I-4 / M-1）。 */
  const liveWorkers = new Set<WorkerSlot>()
  /** 按 `kbId` 递增的代际号：`abortAndDrainKb` 递增后拦截微任务空窗期刚获槽的新任务（I-2）。 */
  const kbEpochs = new Map<string, number>()
  const pending = new Map<number, PendingJob>()
  const jobsByKb = new Map<string, Set<PendingJob>>()
  let nextId = 1

  function currentKbEpoch(kbId: string): number {
    return kbEpochs.get(kbId) ?? 0
  }

  function acquireSlot(kbId: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted === true) return Promise.resolve(false)
    if (activeCount < config.maxWorkers) {
      activeCount += 1
      return Promise.resolve(true)
    }
    return new Promise<boolean>((resolve) => {
      let finished = false
      const finish = (granted: boolean): void => {
        if (finished) return
        finished = true
        signal?.removeEventListener('abort', onAbort)
        resolve(granted)
      }
      const waiter: QueuedExtraction = { kbId, grant: finish }
      const onAbort = (): void => {
        const index = semaphoreWaiters.indexOf(waiter)
        if (index >= 0) semaphoreWaiters.splice(index, 1)
        finish(false)
      }
      semaphoreWaiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  function releaseSlot(): void {
    const next = semaphoreWaiters.shift()
    if (next !== undefined) {
      next.grant(true)
      return
    }
    if (activeCount > 0) activeCount -= 1
  }

  /** 撤销该库仍在排队的提取（尚未占用 Worker、也未打开任何文件）；返回撤销数量。 */
  function abortQueuedExtractions(kbId: string): number {
    let aborted = 0
    for (let index = semaphoreWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = semaphoreWaiters[index]
      if (waiter === undefined || waiter.kbId !== kbId) continue
      semaphoreWaiters.splice(index, 1)
      waiter.grant(false)
      aborted += 1
    }
    return aborted
  }

  function removeFromIdle(slot: WorkerSlot): void {
    const index = idleSlots.indexOf(slot)
    if (index >= 0) idleSlots.splice(index, 1)
  }

  function failJobsForSlot(slot: WorkerSlot, message: string): void {
    for (const job of [...pending.values()]) {
      if (job.slot === slot) job.settle({ ok: false, reason: 'worker-crashed', error: message })
    }
  }

  /**
   * 标记槽位不可复用并发出 `terminate()`；返回的 Promise 在线程真正 `'exit'` 后
   * 落定。即便此前 `'error'` 已置 `dead = true`，仍会补发 `terminate()` 并等待
   * 真正退出（I-4 修复）。
   */
  function killSlot(slot: WorkerSlot): Promise<void> {
    slot.dead = true
    slots.delete(slot)
    removeFromIdle(slot)
    if (slot.terminatePromise === undefined && !slot.exited) {
      slot.terminatePromise = slot.worker.terminate().then(() => undefined, () => undefined)
    }
    return slot.terminatePromise === undefined
      ? slot.exitPromise
      : Promise.all([slot.exitPromise, slot.terminatePromise]).then(() => undefined)
  }

  function spawnSlot(): WorkerSlot {
    const worker = new Worker(workerUrl ?? resolveKnowledgeWorkerUrl('extraction-worker'), {
      name: 'dsh-knowledge-extraction',
      resourceLimits: { maxOldGenerationSizeMb: config.maxOldGenerationSizeMb },
    })
    let resolveReady: () => void = () => undefined
    let rejectReady: (error: Error) => void = () => undefined
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    // 空闲 Worker 崩溃时无人 await `ready`：吞掉拒绝，避免 unhandledRejection。
    void ready.catch(() => undefined)
    let resolveExit: () => void = () => undefined
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    const slot: WorkerSlot = {
      worker,
      ready,
      exitPromise,
      terminatePromise: undefined,
      dead: false,
      exited: false,
    }

    worker.on('message', (message: ExtractionWorkerReadyMessage | ExtractionWorkerResponse) => {
      if (isReadyMessage(message)) {
        resolveReady()
        return
      }
      const job = pending.get(message.id)
      if (job === undefined) return
      if (message.ok) {
        job.settle(message.result)
        return
      }
      job.settle({ ok: false, reason: 'read-error', error: message.error })
    })
    worker.on('error', (error: Error) => {
      slot.dead = true
      slots.delete(slot)
      removeFromIdle(slot)
      rejectReady(error)
      failJobsForSlot(slot, describeError(error))
    })
    worker.on('exit', (code: number) => {
      slot.dead = true
      slot.exited = true
      slots.delete(slot)
      liveWorkers.delete(slot)
      removeFromIdle(slot)
      resolveExit()
      rejectReady(new Error(`extraction worker exited with code ${String(code)}`))
      failJobsForSlot(slot, `extraction worker exited with code ${String(code)}`)
    })
    slots.add(slot)
    liveWorkers.add(slot)
    return slot
  }

  function takeSlot(): WorkerSlot {
    for (;;) {
      const slot = idleSlots.pop()
      if (slot === undefined) return spawnSlot()
      if (!slot.dead) return slot
    }
  }

  function releaseSlotValue(slot: WorkerSlot): void {
    if (slot.dead || disposed) return
    idleSlots.push(slot)
  }

  function trackJob(job: PendingJob): void {
    pending.set(job.id, job)
    const set = jobsByKb.get(job.kbId)
    if (set === undefined) jobsByKb.set(job.kbId, new Set([job]))
    else set.add(job)
  }

  function untrackJob(job: PendingJob): void {
    pending.delete(job.id)
    const set = jobsByKb.get(job.kbId)
    if (set === undefined) return
    set.delete(job)
    if (set.size === 0) jobsByKb.delete(job.kbId)
  }

  async function runJob(
    kbId: string,
    entryEpoch: number,
    req: ExtractionFileRequest,
    signal?: AbortSignal,
  ): Promise<ExtractionFileResult> {
    let slot: WorkerSlot
    try {
      slot = takeSlot()
    } catch (error) {
      // `new Worker(...)` 同步失败（如资源耗尽/路径无效）单文件隔离为 worker-crashed（I-11）。
      return { ok: false, reason: 'worker-crashed', error: describeError(error) }
    }
    const id = nextId
    nextId += 1
    let resolveOutcome: (result: ExtractionFileResult) => void = () => undefined
    const outcome = new Promise<ExtractionFileResult>((resolve) => {
      resolveOutcome = resolve
    })
    // 计时器与取消监听先声明再被 settle 引用，避免 TDZ 与调用顺序耦合。
    let timer: NodeJS.Timeout | undefined
    let posted = false
    const clearJobTimer = (): void => {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
    }
    const removeAbortListener = (): void => {
      signal?.removeEventListener('abort', abortListener)
    }
    const abortListener = (): void => {
      // 只有消息已投递给 Worker（可能已打开文件）才杀线程；未投递前健康空闲槽可安全归还（I-11）。
      if (posted) killSlot(slot)
      job.settle({ ok: false, reason: 'aborted', error: 'knowledge base extraction aborted' })
    }
    const job: PendingJob = {
      kbId,
      id,
      slot,
      drainWaiters: [],
      settled: false,
      settle: (result: ExtractionFileResult): void => {
        if (job.settled) return
        job.settled = true
        clearJobTimer()
        removeAbortListener()
        untrackJob(job)
        releaseSlotValue(slot)
        for (const waiter of job.drainWaiters.splice(0)) waiter()
        resolveOutcome(result)
      },
    }
    trackJob(job)
    signal?.addEventListener('abort', abortListener, { once: true })

    let timedOut = false
    const settleTimeoutAfterKill = (errorText: string): void => {
      if (timedOut || job.settled) return
      timedOut = true
      clearJobTimer()
      removeAbortListener()
      // 从 pending 摘除，防止在等待线程退出期间晚到消息抢先落定为成功。
      pending.delete(job.id)
      const exiting = killSlot(slot)
      void waitForWorkerExitUnderBudget([exiting], EXTRACTION_POOL_DRAIN_BUDGET_MS).then(() => {
        job.settle({ ok: false, reason: 'extract-timeout', error: errorText })
      })
    }

    if (isSignalAborted(signal) || disposed || currentKbEpoch(kbId) !== entryEpoch) {
      job.settle({ ok: false, reason: 'aborted', error: 'knowledge base extraction aborted before start' })
      return outcome
    }

    // Worker 首次拉起的 ready 握手同样受启动超时与取消保护（I-11）。
    const readyTimer = setTimeout(() => {
      settleTimeoutAfterKill(`extraction worker startup exceeded ${String(config.timeoutMs)} ms`)
    }, config.timeoutMs)
    try {
      await Promise.race([slot.ready, outcome.then(() => undefined)])
    } catch (error) {
      if (!timedOut && !job.settled) {
        killSlot(slot)
        job.settle({ ok: false, reason: 'worker-crashed', error: describeError(error) })
      }
      return outcome
    } finally {
      clearTimeout(readyTimer)
    }
    if (timedOut || job.settled) return outcome
    if (slot.dead) {
      job.settle({ ok: false, reason: 'worker-crashed', error: 'extraction worker exited before the request' })
      return outcome
    }
    if (isSignalAborted(signal) || disposed || currentKbEpoch(kbId) !== entryEpoch) {
      // 尚未向该 Worker 投递请求，不误杀健康空闲 Worker。
      job.settle({ ok: false, reason: 'aborted' })
      return outcome
    }

    timer = setTimeout(() => {
      settleTimeoutAfterKill(`extraction exceeded ${String(config.timeoutMs)} ms`)
    }, config.timeoutMs)

    try {
      posted = true
      slot.worker.postMessage({ id, request: req } satisfies ExtractionWorkerRequest)
    } catch (error) {
      killSlot(slot)
      job.settle({ ok: false, reason: 'worker-crashed', error: describeError(error) })
    }
    return outcome
  }

  async function extractFile(
    kbId: string,
    req: ExtractionFileRequest,
    signal?: AbortSignal,
  ): Promise<ExtractionFileResult> {
    if (disposed) return { ok: false, reason: 'aborted', error: 'extraction pool disposed' }
    if (isSignalAborted(signal)) return { ok: false, reason: 'aborted' }
    const entryEpoch = currentKbEpoch(kbId)
    const granted = await acquireSlot(kbId, signal)
    // 排队期间被暂停/退场/signal 撤销：尚未打开任何文件，直接以 aborted 落定。
    if (!granted) return { ok: false, reason: 'aborted', error: 'knowledge base extraction aborted before start' }
    try {
      if (disposed || isSignalAborted(signal) || currentKbEpoch(kbId) !== entryEpoch) {
        return { ok: false, reason: 'aborted', error: 'knowledge base extraction aborted before start' }
      }
      return await runJob(kbId, entryEpoch, req, signal)
    } finally {
      releaseSlot()
    }
  }

  return {
    config,
    extractFile,
    /**
     * 规格 §6.1：暂停应答返回前必须让在途提取的源文件 `FileHandle` 全部关闭。
     * 因此这里先递增该库代际号（阻断微任务空窗内刚获槽的请求，I-2）并撤销仍在
     * 排队的提取，再同步落定其在途 job 为 `aborted`，并对负责它们的 Worker 发
     * `terminate()` 且等待线程真正退出（受 `EXTRACTION_POOL_DRAIN_BUDGET_MS` 封顶）。
     */
    async abortAndDrainKb(kbId: string): Promise<void> {
      kbEpochs.set(kbId, currentKbEpoch(kbId) + 1)
      abortQueuedExtractions(kbId)
      const jobs = [...(jobsByKb.get(kbId) ?? [])]
      if (jobs.length === 0) return
      const settlements: Array<Promise<void>> = []
      const exits: Array<Promise<void>> = []
      const killed = new Set<WorkerSlot>()
      for (const job of jobs) {
        settlements.push(new Promise<void>((resolve) => {
          job.drainWaiters.push(resolve)
        }))
        if (!killed.has(job.slot)) {
          killed.add(job.slot)
          exits.push(killSlot(job.slot))
        }
        job.settle({ ok: false, reason: 'aborted', error: 'knowledge base watch paused' })
      }
      await Promise.all(settlements)
      await waitForWorkerExitUnderBudget(exits, EXTRACTION_POOL_DRAIN_BUDGET_MS)
    },
    isRunning: (): boolean => liveWorkers.size > 0,
    activeWorkerCount: (): number => liveWorkers.size,
    dispose(budgetMs: number = EXTRACTION_POOL_DISPOSE_BUDGET_MS): Promise<void> {
      if (disposePromise !== undefined) return disposePromise
      disposed = true
      idleSlots.length = 0
      for (const waiter of semaphoreWaiters.splice(0)) waiter.grant(false)
      for (const job of [...pending.values()]) {
        job.settle({ ok: false, reason: 'aborted', error: 'extraction pool disposed' })
      }
      const budget = Number.isFinite(budgetMs) ? Math.max(0, Math.trunc(budgetMs)) : EXTRACTION_POOL_DISPOSE_BUDGET_MS
      const terminations = [...liveWorkers].map((slot) => killSlot(slot))
      disposePromise = waitForWorkerExitUnderBudget(terminations, budget)
      return disposePromise
    },
  }
}
