/**
 * Extraction Worker 池（规格 §6.2 / 计划 Task 6）。
 *
 * 默认并发 1、封顶 2（`R3-B3`）：每个 Worker 独立线程、`maxOldGenerationSizeMb`
 * 固定 256 MB，惰性拉起（0 次提取不创建线程）。单文件超时后立即
 * `worker.terminate()` 并另起 Worker，该文件记 `extract-timeout`；暂停监听 /
 * 退场时 `abortAndDrainKb` / `dispose` 同样以 terminate 为兜底，保证绝不遗留
 * 空转 CPU 线程，也保证源目录 `FileHandle` 全部关闭（Windows 上可移动目录）。
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
  abortAndDrainKb(kbId: string): Promise<void>
  isRunning(): boolean
  activeWorkerCount(): number
  /** 立即向全部 Extraction Worker 发 terminate() 并等待退出，受 budgetMs（默认 300 ms）竞态兜底。 */
  dispose(budgetMs?: number): Promise<void>
}

interface WorkerSlot {
  readonly worker: Worker
  readonly ready: Promise<void>
  dead: boolean
}

interface PendingJob {
  readonly kbId: string
  readonly id: number
  readonly slot: WorkerSlot
  readonly drainWaiters: Array<() => void>
  settled: boolean
  settle(result: ExtractionFileResult): void
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  let activeCount = 0
  const semaphoreWaiters: Array<() => void> = []
  const idleSlots: WorkerSlot[] = []
  const slots = new Set<WorkerSlot>()
  const pending = new Map<number, PendingJob>()
  const jobsByKb = new Map<string, Set<PendingJob>>()
  let nextId = 1

  function acquireSlot(): Promise<void> {
    if (activeCount < config.maxWorkers) {
      activeCount += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      semaphoreWaiters.push(resolve)
    })
  }

  function releaseSlot(): void {
    const next = semaphoreWaiters.shift()
    if (next !== undefined) {
      next()
      return
    }
    if (activeCount > 0) activeCount -= 1
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

  function killSlot(slot: WorkerSlot): void {
    if (slot.dead) return
    slot.dead = true
    slots.delete(slot)
    removeFromIdle(slot)
    void slot.worker.terminate().catch(() => undefined)
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
    const slot: WorkerSlot = { worker, ready, dead: false }

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
      slots.delete(slot)
      removeFromIdle(slot)
      rejectReady(new Error(`extraction worker exited with code ${String(code)}`))
      failJobsForSlot(slot, `extraction worker exited with code ${String(code)}`)
    })
    slots.add(slot)
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

  async function runJob(kbId: string, req: ExtractionFileRequest, signal?: AbortSignal): Promise<ExtractionFileResult> {
    const slot = takeSlot()
    const id = nextId
    nextId += 1
    let resolveOutcome: (result: ExtractionFileResult) => void = () => undefined
    const outcome = new Promise<ExtractionFileResult>((resolve) => {
      resolveOutcome = resolve
    })
    // 计时器与取消监听先声明再被 settle 引用，避免 TDZ 与调用顺序耦合。
    let timer: NodeJS.Timeout | undefined
    const clearJobTimer = (): void => {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
    }
    const removeAbortListener = (): void => {
      signal?.removeEventListener('abort', abortListener)
    }
    const abortListener = (): void => {
      killSlot(slot)
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

    try {
      await slot.ready
    } catch (error) {
      killSlot(slot)
      job.settle({ ok: false, reason: 'worker-crashed', error: describeError(error) })
      return outcome
    }
    if (job.settled) return outcome
    if (slot.dead) {
      job.settle({ ok: false, reason: 'worker-crashed', error: 'extraction worker exited before the request' })
      return outcome
    }
    if (signal?.aborted === true) {
      killSlot(slot)
      job.settle({ ok: false, reason: 'aborted' })
      return outcome
    }

    timer = setTimeout(() => {
      killSlot(slot)
      job.settle({
        ok: false,
        reason: 'extract-timeout',
        error: `extraction exceeded ${String(config.timeoutMs)} ms`,
      })
    }, config.timeoutMs)
    signal?.addEventListener('abort', abortListener, { once: true })

    try {
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
    if (signal?.aborted === true) return { ok: false, reason: 'aborted' }
    await acquireSlot()
    try {
      if (disposed) return { ok: false, reason: 'aborted', error: 'extraction pool disposed' }
      return await runJob(kbId, req, signal)
    } finally {
      releaseSlot()
    }
  }

  return {
    config,
    extractFile,
    async abortAndDrainKb(kbId: string): Promise<void> {
      const jobs = [...(jobsByKb.get(kbId) ?? [])]
      if (jobs.length === 0) return
      await Promise.all(jobs.map(job => new Promise<void>((resolve) => {
        job.drainWaiters.push(resolve)
        killSlot(job.slot)
        job.settle({ ok: false, reason: 'aborted', error: 'knowledge base watch paused' })
      })))
    },
    isRunning: (): boolean => slots.size > 0,
    activeWorkerCount: (): number => slots.size,
    async dispose(budgetMs: number = EXTRACTION_POOL_DISPOSE_BUDGET_MS): Promise<void> {
      if (disposed) return
      disposed = true
      const live = [...slots]
      slots.clear()
      idleSlots.length = 0
      for (const job of [...pending.values()]) {
        job.settle({ ok: false, reason: 'aborted', error: 'extraction pool disposed' })
      }
      const budget = Number.isFinite(budgetMs) ? Math.max(0, Math.trunc(budgetMs)) : EXTRACTION_POOL_DISPOSE_BUDGET_MS
      const terminations = live.map((slot) => {
        slot.dead = true
        return slot.worker.terminate().catch(() => undefined)
      })
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          Promise.all(terminations).then(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, budget)
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
  }
}
