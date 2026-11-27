/**
 * M1-2 Task 5: 单库单槽整理执行器（模型预检、inFlightOrganizeByKb、看门狗与失败计次退避）。
 *
 * 规格依据:docs/superpowers/specs/2026-11-24-knowledge-base-design.md §8.1–§8.3 / §11.1 第 6 项。
 * 本文件的 fake Host 只实现组织器消费的门面方法(批次、失败计次、相位、校验),
 * 真实 Storage/Host 的 1/5/3 落盘口径已由 knowledge-storage.spec.ts 与 org-tools 覆盖;
 * 这里验证执行器的驱动顺序、结算口径、看门狗与进程内纯墓碑退避。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'

import { createKnowledgeOrganizer } from '../../src/huaanwork-host/knowledge/organizer.ts'
import type {
  KnowledgeOrganizer,
  KnowledgeOrganizerDeps,
} from '../../src/huaanwork-host/knowledge/organizer.ts'
import { readKnowledgeEvents } from '../../src/huaanwork-host/knowledge/events.ts'
import {
  createKnowledgeHost,
  type KnowledgeHost as RealKnowledgeHost,
} from '../../src/huaanwork-host/knowledge/host.ts'
import type { KnowledgeHost } from '../../src/huaanwork-host/knowledge/host.ts'
import { noteKnowledgeOrganizerError } from '../../src/huaanwork-host/knowledge/organizer-activity.ts'
import { KB_ORG_ALLOWED_TOOLS, KB_ORG_TOOLS } from '../../src/huaanwork-host/knowledge/org-tools.ts'
import { kbOrganizeSessionId } from '../../src/huaanwork-host/knowledge/session-ids.ts'
import { KnowledgeSyncError } from '../../src/huaanwork-host/knowledge/sync-engine.ts'
import type {
  KnowledgeBaseRecord,
  KnowledgeBaseStats,
  KnowledgeOrganizerPhase,
  PendingOrganizeBatch,
} from '../../src/huaanwork-host/knowledge/types.ts'
import { setKnowledgeHost } from '../../src/huaanwork-host/knowledge/host-ref.ts'
import { registerKnowledgeOrgTools } from '../../src/huaanwork-host/knowledge/org-tools.ts'
import { ROUTE_TABLE } from '../../src/huaanwork-host/routes.ts'
import { emptyAttachments, type AttachmentMaps } from '../../src/huaanwork-guardrails/agent-attachments.ts'
import { createTurnScheduler } from '../../src/huaanwork-host/turn-scheduler.ts'
import type { TurnScheduler } from '../../src/huaanwork-host/turn-scheduler.ts'
import {
  neutralKnowledgeRootPath,
  neutralKnowledgeWikiRootPath,
} from '../../src/huaanwork-host/workspace-state.ts'

const sessionSweepMock = vi.hoisted(() => ({
  removeSessionFilesById: vi.fn(async (_root: string, _ids: readonly string[]): Promise<number> => 0),
}))

vi.mock('../../src/huaanwork-host/session-sweep.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/huaanwork-host/session-sweep.ts')>()
  return { ...actual, removeSessionFilesById: sessionSweepMock.removeSessionFilesById }
})

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(error: unknown): void
  readonly settled: boolean
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  let settled = false
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    reject = (error) => {
      if (settled) return
      settled = true
      rejectPromise(error)
    }
  })
  return {
    promise,
    resolve,
    reject,
    get settled() {
      return settled
    },
  }
}

function makeRecord(
  id: string,
  name: string,
  autoOrganize = true,
): KnowledgeBaseRecord {
  return {
    id,
    name,
    sourceDir: `/tmp/source-${id}`,
    autoOrganize,
    watchPaused: false,
    createdAt: '2026-11-27T00:00:00.000Z',
  }
}

interface FakeDocInput {
  readonly docId: string
  readonly sha256?: string
}

interface FakeTombstoneInput {
  readonly docId: string
  readonly deletedAt?: number
  readonly wikiNotePath?: string | null
}

function pendingBatch(
  docs: readonly FakeDocInput[] = [],
  tombstones: readonly FakeTombstoneInput[] = [],
): PendingOrganizeBatch {
  return {
    docs: docs.map(doc => ({
      docId: doc.docId,
      relPath: `${doc.docId}.md`,
      sha256: doc.sha256 ?? `sha-${doc.docId}`,
      wikiNotePath: `docs/${doc.docId}.md`,
      charCount: 10,
    })),
    tombstones: tombstones.map(item => ({
      docId: item.docId,
      relPath: `${item.docId}.md`,
      wikiNotePath: item.wikiNotePath ?? null,
      deletedAt: item.deletedAt ?? 1_000,
    })),
  }
}

function copyBatch(batch: PendingOrganizeBatch): PendingOrganizeBatch {
  return {
    docs: batch.docs.map(doc => ({ ...doc })),
    tombstones: batch.tombstones.map(item => ({ ...item })),
  }
}

interface FailureCall {
  readonly kbId: string
  readonly docId: string
  readonly sha256: string
  readonly error: string
  readonly nowMs: number
}

interface ResetCall {
  readonly kbId: string
  readonly docId?: string
}

interface PhaseLogEntry {
  readonly kbId: string
  readonly phase: KnowledgeOrganizerPhase | 'clear'
}

/**
 * 组织器消费的 KnowledgeHost 门面。其余 Host 方法不存在(执行器不得访问),
 * 测试在构造时断言为 KnowledgeHost。
 */
class FakeOrganizerHost {
  readonly records: KnowledgeBaseRecord[]
  readonly docs = new Map<string, FakeDocInput[]>()
  readonly tombstones = new Map<string, FakeTombstoneInput[]>()
  readonly organized = new Map<string, Set<string>>()
  readonly cleared = new Map<string, Set<string>>()
  readonly progressOrganized = new Map<string, Set<string>>()
  readonly progressCleared = new Map<string, Set<string>>()
  readonly attempts = new Map<string, { attempts: number; retryAfter: number | null; lastError: string | null }>()
  readonly openBatches = new Map<string, PendingOrganizeBatch>()
  readonly peekOverrides = new Map<string, PendingOrganizeBatch[]>()
  readonly openOverrides = new Map<string, PendingOrganizeBatch[]>()
  /** 每次 peek 都抛出的注入错误（模拟删除/维护/存储关闭），清掉后才恢复正常。 */
  readonly peekErrors = new Map<string, Error>()
  readonly phases = new Map<string, KnowledgeOrganizerPhase>()
  readonly phaseLog: PhaseLogEntry[] = []
  readonly failureCalls: FailureCall[] = []
  readonly resetCalls: ResetCall[] = []
  readonly assertionCalls: string[] = []
  readonly assertErrors = new Map<string, Error>()
  readonly deletedIds = new Set<string>()
  phaseReturnFalse = false

  constructor(records: readonly KnowledgeBaseRecord[]) {
    this.records = [...records]
    for (const record of records) {
      this.docs.set(record.id, [])
      this.tombstones.set(record.id, [])
      this.organized.set(record.id, new Set())
      this.cleared.set(record.id, new Set())
    }
  }

  setDocs(kbId: string, docs: readonly FakeDocInput[]): void {
    this.docs.set(kbId, [...docs])
  }

  setTombstones(kbId: string, tombstones: readonly FakeTombstoneInput[]): void {
    this.tombstones.set(kbId, [...tombstones])
  }

  markOrganized(kbId: string, docId: string): void {
    let set = this.progressOrganized.get(kbId)
    if (set === undefined) {
      set = new Set()
      this.progressOrganized.set(kbId, set)
    }
    set.add(docId)
  }

  clearTombstone(kbId: string, docId: string): void {
    let set = this.progressCleared.get(kbId)
    if (set === undefined) {
      set = new Set()
      this.progressCleared.set(kbId, set)
    }
    set.add(docId)
  }

  currentBatch(kbId: string, nowMs: number): PendingOrganizeBatch {
    const organized = this.organized.get(kbId) ?? new Set<string>()
    const cleared = this.cleared.get(kbId) ?? new Set<string>()
    const docs = (this.docs.get(kbId) ?? []).filter((doc) => {
      if (organized.has(doc.docId)) return false
      const attempt = this.attempts.get(`${kbId}\u0000${doc.docId}`)
      if (attempt === undefined) return true
      if (attempt.attempts >= 3) return false
      return attempt.retryAfter === null || attempt.retryAfter <= nowMs
    })
    const tombstones = (this.tombstones.get(kbId) ?? []).filter(item => !cleared.has(item.docId))
    return pendingBatch(docs, tombstones)
  }

  getRegisteredKnowledgeBaseIds(): ReadonlySet<string> {
    return new Set(this.records.filter(record => !this.deletedIds.has(record.id)).map(record => record.id))
  }

  listOrganizeCandidates(manualKbIds?: ReadonlySet<string>): readonly KnowledgeBaseRecord[] {
    return this.records.filter(record =>
      !this.deletedIds.has(record.id) && (record.autoOrganize || manualKbIds?.has(record.id) === true))
  }

  async peekPendingOrganizeBatch(kbId: string, nowMs: number): Promise<PendingOrganizeBatch> {
    const injected = this.peekErrors.get(kbId)
    if (injected !== undefined) throw injected
    const overrides = this.peekOverrides.get(kbId)
    if (overrides !== undefined && overrides.length > 0) return copyBatch(overrides.shift()!)
    return this.currentBatch(kbId, nowMs)
  }

  async openOrganizeBatch(kbId: string, nowMs: number): Promise<PendingOrganizeBatch> {
    const overrides = this.openOverrides.get(kbId)
    const batch = overrides !== undefined && overrides.length > 0
      ? copyBatch(overrides.shift()!)
      : this.currentBatch(kbId, nowMs)
    this.openBatches.set(kbId, batch)
    return batch
  }

  getOpenOrganizeBatch(kbId: string): PendingOrganizeBatch {
    const batch = this.openBatches.get(kbId)
    if (batch === undefined) throw new Error(`knowledge-organize-batch-not-open: ${kbId}`)
    return batch
  }

  closeOrganizeBatch(kbId: string): { batch: PendingOrganizeBatch; organizedDocIds: string[]; clearedTombstoneIds: string[] } {
    const batch = this.openBatches.get(kbId)
    if (batch === undefined) throw new Error(`knowledge-organize-batch-not-open: ${kbId}`)
    this.openBatches.delete(kbId)
    const docIds = new Set(batch.docs.map(doc => doc.docId))
    const tombstoneIds = new Set(batch.tombstones.map(item => item.docId))
    const organizedDocIds = [...(this.progressOrganized.get(kbId) ?? new Set<string>())].filter(id => docIds.has(id))
    const clearedTombstoneIds = [...(this.progressCleared.get(kbId) ?? new Set<string>())].filter(id => tombstoneIds.has(id))
    for (const id of organizedDocIds) this.organized.get(kbId)?.add(id)
    for (const id of clearedTombstoneIds) this.cleared.get(kbId)?.add(id)
    this.progressOrganized.delete(kbId)
    this.progressCleared.delete(kbId)
    return { batch, organizedDocIds, clearedTombstoneIds }
  }

  async readOrganizeDoc(): Promise<[]> {
    return []
  }

  async markOrganizeProcessed(kbId: string, docId: string): Promise<{ updated: boolean }> {
    this.markOrganized(kbId, docId)
    return { updated: true }
  }

  async clearOrganizeTombstones(kbId: string, docIds: readonly string[]): Promise<readonly string[]> {
    for (const docId of docIds) this.clearTombstone(kbId, docId)
    return docIds
  }

  async recordOrganizeFailure(
    kbId: string,
    docId: string,
    sha256: string,
    error: string,
    nowMs: number,
  ): Promise<{ attempts: number; retryAfter: number | null }> {
    const key = `${kbId}\u0000${docId}`
    const attempts = (this.attempts.get(key)?.attempts ?? 0) + 1
    const retryAfter = attempts === 1 ? nowMs + 60_000 : attempts === 2 ? nowMs + 300_000 : null
    this.attempts.set(key, { attempts, retryAfter, lastError: error })
    this.failureCalls.push({ kbId, docId, sha256, error, nowMs })
    return { attempts, retryAfter }
  }

  async resetOrganizeFailures(kbId: string, docId?: string): Promise<void> {
    this.resetCalls.push({ kbId, ...(docId === undefined ? {} : { docId }) })
    if (docId === undefined) {
      for (const key of [...this.attempts.keys()]) {
        if (key.startsWith(`${kbId}\u0000`)) this.attempts.delete(key)
      }
      return
    }
    this.attempts.delete(`${kbId}\u0000${docId}`)
  }

  assertOrganizeAllowed(kbId: string): void {
    this.assertionCalls.push(kbId)
    const custom = this.assertErrors.get(kbId)
    if (custom !== undefined) throw custom
    if (!this.records.some(record => record.id === kbId)) {
      throw new KnowledgeSyncError('knowledge-base-not-found', `knowledge base ${kbId} is not registered`)
    }
  }

  setOrganizerPhase(kbId: string, phase: KnowledgeOrganizerPhase): boolean {
    if (this.phaseReturnFalse) return false
    this.phases.set(kbId, phase)
    this.phaseLog.push({ kbId, phase })
    return true
  }

  clearOrganizerPhase(kbId: string): void {
    if (this.phases.has(kbId)) {
      this.phases.delete(kbId)
      this.phaseLog.push({ kbId, phase: 'clear' })
    }
  }

  attemptsFor(kbId: string, docId: string): { attempts: number; retryAfter: number | null; lastError: string | null } | undefined {
    return this.attempts.get(`${kbId}\u0000${docId}`)
  }

  asHost(): KnowledgeHost {
    return this as unknown as KnowledgeHost
  }
}

/** 真实 Host 的整理门面测试只需要 open/list/stats；其余方法经类型断言不访问。 */
class HostFacadeStorage {
  readonly openResults: Array<
    | { readonly ok: true; readonly wikiResetPending: boolean }
    | { readonly ok: false; readonly code: 'index-error'; readonly error: string }
  > = []

  async openKb(): Promise<
    | { readonly ok: true; readonly wikiResetPending: boolean }
    | { readonly ok: false; readonly code: 'index-error'; readonly error: string }
  > {
    return this.openResults.shift() ?? { ok: true, wikiResetPending: false }
  }

  async closeKb(): Promise<void> {
    return undefined
  }

  async listDocs(): Promise<{ total: number; docs: [] }> {
    return { total: 0, docs: [] }
  }

  async getStats(): Promise<KnowledgeBaseStats> {
    return {
      totalDocs: 0,
      indexedDocs: 0,
      partialDocs: 0,
      skippedDocs: 0,
      errorDocs: 0,
      pendingOrganizeDocs: 0,
      failedOrganizeDocs: 0,
      totalChunks: 0,
    }
  }

  async retryPendingWikiReset(): Promise<{ ok: false; error: string }> {
    return { ok: false, error: 'still pending' }
  }

  isRunning(): boolean {
    return true
  }

  async dispose(): Promise<void> {
    return undefined
  }
}

interface AgentHarness {  readonly agent: Agent
  readonly handle: AgentHandle
  readonly idle: Deferred<void>
  readonly followup: ReturnType<typeof vi.fn>
  readonly whenIdle: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
  readonly dispose: ReturnType<typeof vi.fn>
  readonly cancelCauses: Array<{ kind: string; reason?: string }>
  disposed: boolean
}

interface HarnessOptions {
  readonly records?: readonly KnowledgeBaseRecord[]
  readonly settings?: Record<string, unknown>
  readonly maxConcurrentTurns?: number
  readonly timeoutMs?: number
  readonly createGate?: (callIndex: number) => Promise<void> | undefined
  readonly disposeGate?: (callIndex: number) => Promise<void> | undefined
  readonly followupError?: (callIndex: number) => Error | undefined
  readonly idleError?: (callIndex: number) => Error | undefined
  readonly onCreate?: (callIndex: number, host: FakeOrganizerHost) => void
}

interface Harness {
  readonly root: string
  readonly profileDir: string
  readonly dshHome: string
  readonly clock: { now: number }
  readonly host: FakeOrganizerHost
  readonly scheduler: TurnScheduler
  readonly organizer: KnowledgeOrganizer
  readonly deps: KnowledgeOrganizerDeps
  readonly createAgent: ReturnType<typeof vi.fn>
  readonly releaseSlot: ReturnType<typeof vi.fn>
  readonly agents: AgentHarness[]
  readonly promptContexts: Array<Record<string, unknown>>
  readonly queueStarted: string[]
  readonly sessionRoots: Map<string, string>
  readonly sessionToolAllow: Map<string, readonly string[]>
  readonly sessionModels: Map<string, string>
  readonly attachments: AttachmentMaps
}

const tempDirs: string[] = []
const activeOrganizers: KnowledgeOrganizer[] = []
const realHosts: RealKnowledgeHost[] = []
let clearHost: (() => void) | undefined

beforeEach(() => {
  sessionSweepMock.removeSessionFilesById.mockClear()
  sessionSweepMock.removeSessionFilesById.mockImplementation(async () => 0)
})

afterEach(async () => {
  for (const organizer of activeOrganizers.splice(0).reverse()) {
    try {
      await organizer.cancelAll()
    } catch {
      // 清理失败不掩盖测试结果。
    }
  }
  for (const host of realHosts.splice(0).reverse()) {
    try {
      await host.dispose()
    } catch {
      // 清理失败不掩盖测试结果。
    }
  }
  clearHost?.()
  clearHost = undefined
  vi.useRealTimers()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const DEFAULT_SETTINGS: Record<string, unknown> = {
  models: [{
    id: 'm1',
    name: '测试模型',
    base_url: 'http://127.0.0.1:11434/v1',
    model: 'deepseek-chat',
    api_key: '',
  }],
  active_model_id: 'm1',
  allow_network: false,
}

function writeSettings(profileDir: string, settings: Record<string, unknown> = DEFAULT_SETTINGS): void {
  writeFileSync(join(profileDir, 'huaanwork-settings.json'), `${JSON.stringify(settings, null, 2)}\n`)
}

function createHarness(options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'kb-organizer-'))
  tempDirs.push(root)
  const profileDir = join(root, 'profile')
  const dshHome = join(root, 'dsh')
  mkdirSync(profileDir, { recursive: true })
  writeSettings(profileDir, options.settings ?? DEFAULT_SETTINGS)

  const records = options.records ?? [makeRecord('kb1', '季度知识库')]
  const host = new FakeOrganizerHost(records)
  for (const record of records) {
    mkdirSync(neutralKnowledgeRootPath(profileDir, record.id), { recursive: true })
  }

  const clock = { now: 1_000_000 }
  const scheduler = createTurnScheduler({
    maxConcurrentTurns: () => options.maxConcurrentTurns ?? 1,
    modelExists: () => true,
    now: () => clock.now,
  })

  const agents: AgentHarness[] = []
  const promptContexts: Array<Record<string, unknown>> = []
  const queueStarted: string[] = []
  const createAgent = vi.fn(async (createOptions: CreateAgentOptions) => {
    const callIndex = agents.length
    const idle = deferred<void>()
    // 延迟拒绝可能在 whenIdle 挂接前发生；先挂空处理器，避免测试进程误报未处理拒绝。
    void idle.promise.catch(() => undefined)
    const followup = vi.fn((_message: unknown) => {
      const error = options.followupError?.(callIndex)
      if (error !== undefined) throw error
    })
    const cancelCauses: Array<{ kind: string; reason?: string }> = []
    const agentRef = {
      id: createOptions.sessionId,
      followup,
      whenIdle: vi.fn(() => {
        const idleError = options.idleError?.(callIndex)
        if (idleError !== undefined) return Promise.reject(idleError)
        return idle.promise
      }),
      cancel: vi.fn((cause: { kind: string; reason?: string }) => {
        cancelCauses.push(cause)
        if (!idle.settled) idle.reject(new Error('agent-canceled'))
      }),
    } as unknown as Agent
    const whenIdle = agentRef.whenIdle as unknown as ReturnType<typeof vi.fn>
    const cancel = agentRef.cancel as unknown as ReturnType<typeof vi.fn>
    const dispose = vi.fn(async () => {
      const gate = options.disposeGate?.(callIndex)
      if (gate !== undefined) await gate
      harnessDisposed = true
    })
    let harnessDisposed = false
    const harness: AgentHarness = {
      agent: agentRef,
      handle: { agent: agentRef, dispose: dispose as unknown as () => Promise<void> },
      idle,
      followup,
      whenIdle,
      cancel,
      dispose,
      cancelCauses,
      get disposed() {
        return harnessDisposed
      },
      set disposed(value: boolean) {
        harnessDisposed = value
      },
    }
    agents.push(harness)
    options.onCreate?.(callIndex, host)

    const agentCtx = {
      systemPrompt: {
        context: vi.fn((context: Record<string, unknown>) => {
          if (typeof context.order !== 'number' || !Number.isFinite(context.order)) {
            throw new TypeError('prompt context order must be a finite number')
          }
          promptContexts.push(context)
          return () => undefined
        }),
      },
    }
    await createOptions.setup?.(agentCtx as never, agentRef)
    const gate = options.createGate?.(callIndex)
    if (gate !== undefined) await gate
    return harness.handle
  })

  const releaseSlot = vi.fn((sessionId: string) => {
    scheduler.release(sessionId)
    for (const item of scheduler.drainQueue()) queueStarted.push(item.queueItemId)
  })

  const sessionRoots = new Map<string, string>()
  const sessionToolAllow = new Map<string, readonly string[]>()
  const sessionModels = new Map<string, string>()
  const attachments = emptyAttachments()
  const deps: KnowledgeOrganizerDeps = {
    profileDir,
    dshHome,
    host: host.asHost(),
    scheduler,
    sessionRoots,
    sessionToolAllow,
    sessionModels,
    attachments,
    createAgent: createAgent as unknown as (options: CreateAgentOptions) => Promise<AgentHandle>,
    releaseSlot,
    now: () => clock.now,
    timeoutMs: () => options.timeoutMs ?? 600_000,
  }
  const organizer = createKnowledgeOrganizer(deps)
  activeOrganizers.push(organizer)
  return {
    root,
    profileDir,
    dshHome,
    clock,
    host,
    scheduler,
    organizer,
    deps,
    createAgent,
    releaseSlot,
    agents,
    promptContexts,
    queueStarted,
    sessionRoots,
    sessionToolAllow,
    sessionModels,
    attachments,
  }
}

function resolveIdle(harness: Harness, index = 0): void {
  const agent = harness.agents[index]
  if (agent === undefined) throw new Error(`agent ${index} is missing`)
  agent.idle.resolve()
}

async function eventsFor(harness: Harness, kbId = 'kb1'): Promise<readonly { kind: string; level: string; summary: string }[]> {
  return await readKnowledgeEvents(neutralKnowledgeRootPath(harness.profileDir, kbId))
}

async function waitForFollowup(harness: Harness, count = 1, index = 0): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.agents[index]?.followup).toHaveBeenCalledTimes(count)
  })
}

function advanceClock(harness: Harness, ms: number): Promise<void> {
  harness.clock.now += ms
  return vi.advanceTimersByTimeAsync(ms).then(() => undefined)
}

// ---------------------------------------------------------------------------
// 1. 模型预检 / 网络门禁
// ---------------------------------------------------------------------------

describe('model precheck and network gate', () => {
  it('blocks a missing active model without creating an Agent, counting failures, or idling', async () => {
    vi.useFakeTimers()
    const harness = createHarness({
      settings: { models: [], active_model_id: 'missing' },
    })
    harness.host.setDocs('kb1', [{ docId: 'd1' }])

    await harness.organizer.scheduleEvaluate()

    expect(harness.createAgent).not.toHaveBeenCalled()
    expect(harness.host.failureCalls).toHaveLength(0)
    expect(harness.host.phases.get('kb1')).toBe('blocked-no-model')
    expect(harness.scheduler.activeTurnCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(harness.createAgent).not.toHaveBeenCalled()
    expect(harness.host.failureCalls).toHaveLength(0)
  })

  it('blocks an empty resolved model string as blocked-no-model', async () => {
    const harness = createHarness({
      settings: {
        models: [{ id: 'm1', name: '空模型', base_url: 'http://127.0.0.1:11434/v1', model: '', api_key: '' }],
        active_model_id: 'm1',
        allow_network: false,
      },
    })
    harness.host.setDocs('kb1', [{ docId: 'd1' }])

    await harness.organizer.scheduleEvaluate()

    expect(harness.createAgent).not.toHaveBeenCalled()
    expect(harness.host.phases.get('kb1')).toBe('blocked-no-model')
    expect(harness.host.failureCalls).toHaveLength(0)
  })

  it('blocks a public endpoint under LAN-only mode as blocked-network', async () => {
    const harness = createHarness({
      settings: {
        models: [{ id: 'm1', name: '公网', base_url: 'https://api.example.com/v1', model: 'deepseek-chat', api_key: '' }],
        active_model_id: 'm1',
        allow_network: false,
      },
    })
    harness.host.setDocs('kb1', [{ docId: 'd1' }])

    await harness.organizer.scheduleEvaluate()

    expect(harness.createAgent).not.toHaveBeenCalled()
    expect(harness.host.phases.get('kb1')).toBe('blocked-network')
    expect(harness.host.failureCalls).toHaveLength(0)
  })

  it('re-reads the active model for every batch and recovers after settings change', async () => {
    const harness = createHarness({
      settings: { models: [], active_model_id: 'missing' },
    })
    harness.host.setDocs('kb1', [{ docId: 'd1' }])

    await harness.organizer.scheduleEvaluate()
    expect(harness.createAgent).not.toHaveBeenCalled()
    expect(harness.host.phases.get('kb1')).toBe('blocked-no-model')

    writeSettings(harness.profileDir)
    const run = harness.organizer.scheduleEvaluate()
    await waitForFollowup(harness)
    expect(harness.host.phases.get('kb1')).toBe('organizing')
    resolveIdle(harness)
    await run
    expect(harness.createAgent).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 2. 单槽生命周期与 inFlightOrganizeByKb
// ---------------------------------------------------------------------------

describe('single-slot lifecycle and inFlightOrganizeByKb', () => {
  it('waits for the previous dispose + session-file cleanup before reusing the same slot', async () => {
    vi.useFakeTimers()
    const disposeGate = deferred<void>()
    const removeGate = deferred<void>()
    const removeCalls: number[] = []
    const removeCallsAtCreate: number[] = []
    sessionSweepMock.removeSessionFilesById.mockImplementation(async () => {
      const call = removeCalls.length + 1
      removeCalls.push(call)
      // 第一批退场清理（第 2 次）延迟到显式放行，证明复用槽等待的是完整清理。
      if (call === 2) await removeGate.promise
      return 0
    })

    const harness = createHarness({
      disposeGate: (index) => (index === 0 ? disposeGate.promise : undefined),
      onCreate: (index) => {
        removeCallsAtCreate.push(removeCalls.length)
        void index
      },
    })
    harness.host.setDocs('kb1', [{ docId: 'd1' }])

    const firstRun = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)

    const userAdmission = harness.scheduler.admitUserTurn({
      sessionId: 'user-1',
      tabId: 'tab-1',
      text: '用户抢占',
      modelId: 'm1',
      root: join(harness.root, 'user-root'),
    })
    expect(userAdmission.kind).toBe('start')
    harness.scheduler.release('user-1')

    let slotIdle = false
    const idleWait = harness.organizer.waitForKbSlotIdle('kb1').then(() => {
      slotIdle = true
    })
    const secondRun = harness.organizer.triggerManual('kb1').catch(() => undefined)

    await vi.advanceTimersByTimeAsync(0)
    expect(harness.createAgent).toHaveBeenCalledTimes(1)
    expect(slotIdle).toBe(false)

    disposeGate.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.createAgent).toHaveBeenCalledTimes(1)
    expect(slotIdle).toBe(false)

    removeGate.resolve()
    await idleWait
    expect(slotIdle).toBe(true)
    await firstRun
    await waitForFollowup(harness, 1, 1)
    resolveIdle(harness, 1)
    await secondRun

    expect(harness.createAgent).toHaveBeenCalledTimes(2)
    expect(harness.agents[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(harness.agents[1]?.followup).toHaveBeenCalledTimes(1)
    // 第一批预清 + 第一批退场清理 + 第二批预清都必须先于第二批 create。
    expect(removeCallsAtCreate[1]).toBeGreaterThanOrEqual(3)
    expect(harness.agents[1]?.disposed).toBe(true)
  })

  it('removes crash residue before create and cleans it again only after dispose', async () => {
    const order: string[] = []
    const harness = createHarness({
      onCreate: () => order.push('create'),
    })
    harness.host.setDocs('kb1', [{ docId: 'd1' }])
    sessionSweepMock.removeSessionFilesById.mockImplementation(async () => {
      order.push('remove')
      return 0
    })
    const run = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    order.push('followup')
    resolveIdle(harness)
    await run
    order.push('done')

    expect(order.slice(0, 3)).toEqual(['remove', 'create', 'followup'])
    expect(order.filter(entry => entry === 'remove').length).toBe(2)
    expect(order.lastIndexOf('remove')).toBeLessThan(order.indexOf('done'))
    expect(order.indexOf('done')).toBe(order.length - 1)
    expect(harness.releaseSlot).toHaveBeenCalledTimes(1)
  })

  it('settles the round and drops every slot entry when peek rejects mid-round', async () => {
    const harness = createHarness({
      records: [
        makeRecord('kb1', '空库'),
        makeRecord('kb2', '删除中库'),
        makeRecord('kb3', '正常库'),
      ],
    })
    // 三个候选：kb1 空批先结算，kb2 在 peek 抛删除错误，kb3 是抛错之后才开始/占位的候选。
    harness.host.setDocs('kb2', [{ docId: 'd2' }])
    harness.host.setDocs('kb3', [{ docId: 'd3' }])
    harness.host.markOrganized('kb3', 'd3')
    harness.host.peekErrors.set(
      'kb2',
      new KnowledgeSyncError('knowledge-base-deleting', 'deleted during the round'),
    )

    const round = harness.organizer.scheduleEvaluate()
    await waitForFollowup(harness, 1, 0)
    resolveIdle(harness, 0)
    await round

    // 抛错候选不建 Agent、不写事件、不计次；其后的正常候选仍然完成。
    expect(harness.createAgent).toHaveBeenCalledTimes(1)
    expect(harness.host.attemptsFor('kb2', 'd2')).toBeUndefined()
    expect(await eventsFor(harness, 'kb2')).toHaveLength(0)
    expect((await eventsFor(harness, 'kb3')).map(event => event.kind)).toEqual([
      'organize_started',
      'organize_completed',
    ])

    // 两个库都必须从 inFlightOrganizeByKb 退场，后续等待与整轮评估才能结算。
    await harness.organizer.waitForKbSlotIdle('kb2')
    await harness.organizer.waitForKbSlotIdle('kb3')
    await harness.organizer.scheduleEvaluate()

    // 抛错消失后的再一轮必须能正常 create/followup。
    harness.host.peekErrors.delete('kb2')
    harness.host.markOrganized('kb2', 'd2')
    const retry = harness.organizer.triggerManual('kb2')
    await waitForFollowup(harness, 1, 1)
    resolveIdle(harness, 1)
    await retry
    expect(harness.createAgent).toHaveBeenCalledTimes(2)
    expect((await eventsFor(harness, 'kb2')).map(event => event.kind)).toEqual([
      'organize_started',
      'organize_completed',
    ])
  })
})

// ---------------------------------------------------------------------------
// 3. 提示词防插值
// ---------------------------------------------------------------------------

describe('organizer prompt registration', () => {
  it('registers a non-interpolated PromptContext with finite name/order for a name containing {{...}}', async () => {
    const harness = createHarness({
      records: [makeRecord('kb1', '季度{{报告}}库')],
    })
    harness.host.setDocs('kb1', [{ docId: 'd1' }])

    const run = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    resolveIdle(harness)
    await run

    expect(harness.promptContexts).toHaveLength(1)
    const context = harness.promptContexts[0]!
    expect(context.name).toBe('huaanwork:kb-organizer')
    expect(context.order).toBe(40)
    expect(context.required).toBe(true)
    expect(context.interpolate).toBe(false)
    const text = String(context.text)
    expect(text).toContain('季度{{报告}}库')
    expect(text).toContain('wiki/')
    expect(text).toContain('INDEX.md')
    expect(text).toContain('topics/')
    expect(text).toContain('docs/')
    expect(text).toContain('不要附加 #锚点')
    expect(text).toContain('clearedTombstones')
    expect(text.indexOf('INDEX.md')).toBeLessThan(text.indexOf('clearedTombstones'))
  })
})

// ---------------------------------------------------------------------------
// 4. 失败计次严格口径
// ---------------------------------------------------------------------------

describe('failure counting rules', () => {
  it('counts every unmarked doc once with knowledge-organize-unmarked and writes organize_failed', async () => {
    const harness = createHarness()
    harness.host.setDocs('kb1', [{ docId: 'd1' }, { docId: 'd2' }])
    harness.host.markOrganized('kb1', 'd1')

    const run = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    resolveIdle(harness)
    await run

    expect(harness.host.failureCalls).toHaveLength(1)
    expect(harness.host.failureCalls[0]).toMatchObject({
      kbId: 'kb1',
      docId: 'd2',
      sha256: 'sha-d2',
      error: 'knowledge-organize-unmarked',
      nowMs: harness.clock.now,
    })
    expect(harness.host.attemptsFor('kb1', 'd2')).toMatchObject({
      attempts: 1,
      retryAfter: harness.clock.now + 60_000,
    })
    const events = await eventsFor(harness)
    expect(events.map(event => event.kind)).toEqual(['organize_started', 'organize_failed'])
  })

  it('applies 60s / 300s / failed retry_after through host.recordOrganizeFailure across three batches', async () => {
    const harness = createHarness()
    harness.host.setDocs('kb1', [{ docId: 'd1' }])

    for (let batch = 1; batch <= 3; batch += 1) {
      const run = harness.organizer.scheduleEvaluate()
      await waitForFollowup(harness, 1, batch - 1)
      resolveIdle(harness, batch - 1)
      await run
      const state = harness.host.attemptsFor('kb1', 'd1')
      expect(state?.attempts).toBe(batch)
      if (batch === 1) {
        expect(state?.retryAfter).toBe(harness.clock.now + 60_000)
        harness.clock.now += 60_000
      } else if (batch === 2) {
        expect(state?.retryAfter).toBe(harness.clock.now + 300_000)
        harness.clock.now += 300_000
      } else {
        expect(state?.retryAfter).toBeNull()
      }
    }

    expect(harness.createAgent).toHaveBeenCalledTimes(3)
    const after = harness.organizer.scheduleEvaluate()
    await after
    expect(harness.createAgent).toHaveBeenCalledTimes(3)
  })

  it('stops auto-retry when recordOrganizeFailure keeps rejecting and settles the failed batch once', async () => {
    const harness = createHarness()
    harness.host.setDocs('kb1', [{ docId: 'd1' }])
    const peekSpy = vi.spyOn(harness.host, 'peekPendingOrganizeBatch')
    const failureSpy = vi
      .spyOn(harness.host, 'recordOrganizeFailure')
      .mockRejectedValue(new Error('SQLITE_FULL: database or disk is full'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const run = harness.organizer.triggerManual('kb1')
      await waitForFollowup(harness)
      resolveIdle(harness)
      await run

      expect(failureSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls.map(call => String(call[0])).some(
        message => message.includes('kb1') && message.includes('SQLITE_FULL'),
      )).toBe(true)
      expect((await eventsFor(harness)).map(event => event.kind)).toEqual([
        'organize_started',
        'organize_failed',
      ])

      // 计次落盘失败后同一文档仍在待整理批次里:本轮不得立刻再烧一个模型回合,
      // 也不得把全局名额留在占用状态(交给周期对账重试)。
      expect(harness.scheduler.activeTurnCount()).toBe(0)
      expect(harness.scheduler.activeSessionIds().has(kbOrganizeSessionId('kb1'))).toBe(false)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(peekSpy).toHaveBeenCalledTimes(1)
      expect(harness.createAgent).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('does not increment attempts for preempt, user-stop, maintenance, or dispose cancellations', async () => {
    const reasons = ['preempt', 'user-stop', 'maintenance', 'dispose'] as const
    for (const reason of reasons) {
      const harness = createHarness()
      harness.host.setDocs('kb1', [{ docId: 'd1' }])
      const run = harness.organizer.triggerManual('kb1')
      await waitForFollowup(harness)

      if (reason === 'dispose') {
        await harness.organizer.cancelAll()
      } else {
        const cancel = harness.organizer.cancelForKb('kb1', reason)
        await cancel
      }
      await run

      expect(harness.host.failureCalls, reason).toHaveLength(0)
      expect(harness.host.attemptsFor('kb1', 'd1'), reason).toBeUndefined()
      expect(harness.agents[0]?.dispose, reason).toHaveBeenCalledTimes(1)
      const expectedCause = reason === 'user-stop'
        ? { kind: 'user' }
        : reason === 'dispose'
          ? { kind: 'disposed' }
          : { kind: 'hook', reason: `knowledge-organize-${reason}` }
      expect(harness.agents[0]?.cancelCauses, reason).toEqual([expectedCause])
      expect((await eventsFor(harness)).map(event => event.kind)).toEqual(['organize_started', 'organize_cancelled'])
    }
  })

  it('counts a followup throw as a model/turn failure with a sanitized single-line terminalError', async () => {
    const harness = createHarness({
      followupError: () => new Error('model boom\nsecond line'),
    })
    harness.host.setDocs('kb1', [{ docId: 'd1' }])

    const run = harness.organizer.triggerManual('kb1')
    await run

    expect(harness.host.failureCalls).toHaveLength(1)
    expect(harness.host.failureCalls[0]?.error).toBe('model boom second line')
    expect(harness.host.failureCalls[0]?.error).not.toContain('\n')
    expect((await eventsFor(harness)).map(event => event.kind)).toEqual(['organize_started', 'organize_failed'])
  })

  it('counts a whenIdle rejection as a model/turn failure', async () => {
    const harness = createHarness({
      idleError: () => new Error('stream broken'),
    })
    harness.host.setDocs('kb1', [{ docId: 'd1' }])

    const run = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    await run

    expect(harness.host.failureCalls).toHaveLength(1)
    expect(harness.host.failureCalls[0]?.error).toBe('stream broken')
    expect((await eventsFor(harness)).map(event => event.kind)).toEqual(['organize_started', 'organize_failed'])
  })

  it('counts an idle-watchdog timeout with knowledge-organize-idle-timeout and cancels the Agent', async () => {
    vi.useFakeTimers()
    const harness = createHarness({ timeoutMs: 600_000 })
    harness.host.setDocs('kb1', [{ docId: 'd1' }])

    const run = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    await advanceClock(harness, 600_000)
    await run

    expect(harness.agents[0]?.cancel).toHaveBeenCalledWith({
      kind: 'hook',
      reason: 'knowledge-organize-idle-timeout',
    })
    expect(harness.host.failureCalls).toHaveLength(1)
    expect(harness.host.failureCalls[0]?.error).toBe('knowledge-organize-idle-timeout')
    expect((await eventsFor(harness)).map(event => event.kind)).toEqual(['organize_started', 'organize_failed'])
  })

  it('settles mkdir(wikiRoot) failure as knowledge-organize-wiki-root-unwritable without creating an Agent', async () => {
    const harness = createHarness()
    harness.host.setDocs('kb1', [{ docId: 'd1' }, { docId: 'd2' }])
    const wikiRoot = neutralKnowledgeWikiRootPath(harness.profileDir, 'kb1')
    mkdirSync(join(wikiRoot, '..'), { recursive: true })
    writeFileSync(wikiRoot, 'not a directory')

    await harness.organizer.triggerManual('kb1')

    expect(harness.createAgent).not.toHaveBeenCalled()
    expect(harness.host.failureCalls).toHaveLength(2)
    expect(harness.host.failureCalls.map(call => call.error)).toEqual([
      'knowledge-organize-wiki-root-unwritable',
      'knowledge-organize-wiki-root-unwritable',
    ])
    expect(harness.releaseSlot).toHaveBeenCalledTimes(1)
    const events = await eventsFor(harness)
    expect(events.map(event => event.kind)).toEqual(['organize_failed'])
  })

  it('triggerManual({ docId }) and { retryFailed: true } reset failure counters before scheduling', async () => {
    const harness = createHarness()
    harness.host.setDocs('kb1', [{ docId: 'd1' }, { docId: 'd2' }])
    const first = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    resolveIdle(harness)
    await first
    expect(harness.host.resetCalls).toHaveLength(0)
    expect(harness.host.failureCalls).toHaveLength(2)

    harness.clock.now += 1_000
    const retryOne = harness.organizer.triggerManual('kb1', { docId: 'd1' })
    await waitForFollowup(harness, 1, 1)
    expect(harness.host.resetCalls).toEqual([{ kbId: 'kb1', docId: 'd1' }])
    expect(harness.host.attemptsFor('kb1', 'd1')).toBeUndefined()
    resolveIdle(harness, 1)
    await retryOne

    harness.clock.now += 1_000
    const retryAll = harness.organizer.triggerManual('kb1', { retryFailed: true })
    await waitForFollowup(harness, 1, 2)
    expect(harness.host.resetCalls[1]).toEqual({ kbId: 'kb1' })
    resolveIdle(harness, 2)
    await retryAll
  })
})

// ---------------------------------------------------------------------------
// 5. 休眠时钟跳变豁免
// ---------------------------------------------------------------------------

describe('sleep clock jump watchdog exemption', () => {
  it('touches the deps.now baseline only, so a 20 minute jump plus noteSystemResume does not time out', async () => {
    vi.useFakeTimers()
    const harness = createHarness({ timeoutMs: 600_000 })
    harness.host.setDocs('kb1', [{ docId: 'd1' }])
    harness.host.markOrganized('kb1', 'd1')

    const run = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)

    // 钉死顺序：只拨 deps.now（不推进 fake timer）→ noteSystemResume 重设基准 → 再推进不足 timeout。
    harness.clock.now += 20 * 60_000
    harness.organizer.noteSystemResume()
    await vi.advanceTimersByTimeAsync(9 * 60_000)

    expect(harness.host.failureCalls).toHaveLength(0)
    expect(harness.agents[0]?.cancel).not.toHaveBeenCalled()
    resolveIdle(harness)
    await run
    expect((await eventsFor(harness)).map(event => event.kind)).toEqual(['organize_started', 'organize_completed'])
  })

  it('times out at the timer wake when the same jump skips noteSystemResume', async () => {
    vi.useFakeTimers()
    const harness = createHarness({ timeoutMs: 600_000 })
    harness.host.setDocs('kb1', [{ docId: 'd1' }])

    const run = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)

    harness.clock.now += 20 * 60_000
    await vi.advanceTimersByTimeAsync(600_000)
    await run

    expect(harness.agents[0]?.cancel).toHaveBeenCalledWith({
      kind: 'hook',
      reason: 'knowledge-organize-idle-timeout',
    })
    expect(harness.host.failureCalls).toHaveLength(1)
    expect(harness.host.failureCalls[0]?.error).toBe('knowledge-organize-idle-timeout')
  })

  it('re-arms instead of timing out when only the fake timer advances past timeoutMs', async () => {
    vi.useFakeTimers()
    const harness = createHarness({ timeoutMs: 600_000 })
    harness.host.setDocs('kb1', [{ docId: 'd1' }])

    const run = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)

    // 纯定时器实现会在第一次唤醒就拒绝；正确实现唤醒后比较 deps.now()，未超时按剩余时间重新武装。
    await vi.advanceTimersByTimeAsync(600_000)
    expect(harness.agents[0]?.cancel).not.toHaveBeenCalled()
    expect(harness.host.failureCalls).toHaveLength(0)
    // 第二次唤醒同样未超时，证明重新武装的定时器仍然存活且每次都走基准比较。
    await vi.advanceTimersByTimeAsync(600_000)
    expect(harness.agents[0]?.cancel).not.toHaveBeenCalled()
    expect(harness.host.failureCalls).toHaveLength(0)

    // 重新武装的定时器必须保持有效：deps.now 也越过超时后，下一次唤醒拒绝并计次。
    harness.clock.now += 600_000
    await vi.advanceTimersByTimeAsync(600_000)
    await run
    expect(harness.agents[0]?.cancel).toHaveBeenCalledWith({
      kind: 'hook',
      reason: 'knowledge-organize-idle-timeout',
    })
    expect(harness.host.failureCalls).toHaveLength(1)
    expect(harness.host.failureCalls[0]?.error).toBe('knowledge-organize-idle-timeout')
  })
})

// ---------------------------------------------------------------------------
// 6. 不操作 session_projcache / 不登记 huaanworkUnattended
// ---------------------------------------------------------------------------

describe('isolation guarantees', () => {
  it('never references session_projcache or huaanworkUnattended and only attaches the three kb_org tools', async () => {
    const source = readFileSync(new URL('../../src/huaanwork-host/knowledge/organizer.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('session_projcache')
    expect(source).not.toContain('huaanworkUnattended')
    expect(source).not.toContain('knowledge/changed')
    expect(source).not.toContain('knowledge/event')

    const harness = createHarness()
    harness.host.setDocs('kb1', [{ docId: 'd1' }])
    const run = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    const sessionId = kbOrganizeSessionId('kb1')
    expect([...(harness.attachments.sessionAgentTools.get(sessionId) ?? [])]).toEqual([...KB_ORG_TOOLS])
    expect(harness.attachments.sessionHostTools.size).toBe(0)
    expect(harness.sessionToolAllow.get(sessionId)).toEqual(KB_ORG_ALLOWED_TOOLS)
    expect(harness.sessionRoots.get(sessionId)).toBe(neutralKnowledgeWikiRootPath(harness.profileDir, 'kb1'))
    expect(harness.sessionModels.get(sessionId)).toBe('m1')
    resolveIdle(harness)
    await run
    expect(harness.sessionRoots.has(sessionId)).toBe(false)
    expect(harness.sessionToolAllow.has(sessionId)).toBe(false)
    expect(harness.sessionModels.has(sessionId)).toBe(false)
    expect(harness.attachments.sessionAgentTools.has(sessionId)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. 事件与相位
// ---------------------------------------------------------------------------

describe('events and phases', () => {
  it('shows only waiting-turn-slot while the slot is unavailable and writes no organize event', async () => {
    const harness = createHarness()
    harness.host.setDocs('kb1', [{ docId: 'd1' }])
    const wikiRoot = neutralKnowledgeWikiRootPath(harness.profileDir, 'kb1')
    const scriptAdmission = harness.scheduler.admitAutomation({
      automationId: 'script-a',
      sessionId: 'script-session',
      root: wikiRoot,
      countsTowardCap: false,
      recordSkip: false,
    })
    expect(scriptAdmission.kind).toBe('start')

    await harness.organizer.scheduleEvaluate()

    expect(harness.host.phases.get('kb1')).toBe('waiting-turn-slot')
    expect(harness.createAgent).not.toHaveBeenCalled()
    expect(await eventsFor(harness)).toHaveLength(0)
    harness.scheduler.release('script-session')
  })

  it('writes organize_started with organizing phase, then organize_completed, and clears the phase', async () => {
    const harness = createHarness()
    harness.host.setDocs('kb1', [{ docId: 'd1' }])
    harness.host.markOrganized('kb1', 'd1')

    const run = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    expect(harness.host.phases.get('kb1')).toBe('organizing')
    expect((await eventsFor(harness)).map(event => event.kind)).toEqual(['organize_started'])
    resolveIdle(harness)
    await run

    expect(harness.host.phases.has('kb1')).toBe(false)
    expect((await eventsFor(harness)).map(event => event.kind)).toEqual(['organize_started', 'organize_completed'])
  })

  it('writes organize_failed for an unmarked normal end', async () => {
    const harness = createHarness()
    harness.host.setDocs('kb1', [{ docId: 'd1' }])
    const run = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    resolveIdle(harness)
    await run
    expect((await eventsFor(harness)).map(event => event.kind)).toEqual(['organize_started', 'organize_failed'])
  })

  it('writes organize_cancelled for an external cancel and leaves the phase cleared', async () => {
    const harness = createHarness()
    harness.host.setDocs('kb1', [{ docId: 'd1' }])
    const run = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    const cancel = harness.organizer.cancelForKb('kb1', 'user-stop')
    await run
    await cancel
    expect((await eventsFor(harness)).map(event => event.kind)).toEqual(['organize_started', 'organize_cancelled'])
    expect(harness.host.phases.has('kb1')).toBe(false)
  })

  it('does not register knowledge/changed or knowledge/event and leaves ROUTE_TABLE at 92', () => {
    expect(ROUTE_TABLE).toHaveLength(92)
  })
})

// ---------------------------------------------------------------------------
// 8. 结束后唤醒排队用户
// ---------------------------------------------------------------------------

describe('post-batch drain wakeup', () => {
  it('starts an already queued user whose root is free after the organizer releases the slot', async () => {
    const harness = createHarness({ maxConcurrentTurns: 1 })
    harness.host.setDocs('kb1', [{ docId: 'd1' }])
    harness.host.markOrganized('kb1', 'd1')
    const wikiRoot = neutralKnowledgeWikiRootPath(harness.profileDir, 'kb1')

    // 前置构造(同 Task 4 测试 7):用户与整理写者同根,只排队、不触发抢占。
    const run = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    const userAdmission = harness.scheduler.admitUserTurn({
      sessionId: 'user-queued',
      tabId: 'tab-queued',
      text: '排队用户',
      modelId: 'm1',
      root: wikiRoot,
    })
    expect(userAdmission.kind).toBe('queued')
    if (userAdmission.kind !== 'queued') throw new Error('user must be queued')

    resolveIdle(harness)
    await run

    expect(harness.queueStarted).toEqual([userAdmission.queueItemId])
    expect(harness.releaseSlot).toHaveBeenCalledTimes(1)
    expect(harness.scheduler.activeSessionIds().has('user-queued')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 9. 纯墓碑零进展 1/5/3
// ---------------------------------------------------------------------------

describe('pure-tombstone zero-progress backoff', () => {
  it('backs off 60s then 300s then stops, never holding a slot or creating a fourth Agent', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.host.setTombstones('kb1', [{ docId: 't1' }])

    const first = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness, 1, 0)
    resolveIdle(harness, 0)
    await first
    expect(harness.host.failureCalls).toHaveLength(0)
    expect((await eventsFor(harness)).map(event => event.kind)).toEqual(['organize_started', 'organize_failed'])
    expect(harness.createAgent).toHaveBeenCalledTimes(1)
    expect(harness.scheduler.activeSessionIds().has(kbOrganizeSessionId('kb1'))).toBe(false)
    expect(harness.scheduler.activeTurnCount()).toBe(0)

    await advanceClock(harness, 60_000)
    await vi.waitFor(() => {
      expect(harness.createAgent).toHaveBeenCalledTimes(2)
    })
    resolveIdle(harness, 1)
    await vi.waitFor(() => {
      expect(harness.agents[1]?.dispose).toHaveBeenCalledTimes(1)
    })

    await advanceClock(harness, 300_000)
    await vi.waitFor(() => {
      expect(harness.createAgent).toHaveBeenCalledTimes(3)
    })
    resolveIdle(harness, 2)
    await vi.waitFor(() => {
      expect(harness.agents[2]?.dispose).toHaveBeenCalledTimes(1)
    })

    await advanceClock(harness, 300_000)
    await advanceClock(harness, 600_000)
    expect(harness.createAgent).toHaveBeenCalledTimes(3)
  })

  it('enters the same backoff after a loop error and after a watchdog timeout', async () => {
    vi.useFakeTimers()
    const errorHarness = createHarness({
      followupError: () => new Error('organizer model down'),
    })
    errorHarness.host.setTombstones('kb1', [{ docId: 't1' }])
    await errorHarness.organizer.triggerManual('kb1')
    expect((await eventsFor(errorHarness)).map(event => event.kind)).toEqual(['organize_started', 'organize_failed'])
    expect(errorHarness.host.failureCalls).toHaveLength(0)
    await advanceClock(errorHarness, 60_000)
    await vi.waitFor(() => expect(errorHarness.createAgent).toHaveBeenCalledTimes(2))

    const timeoutHarness = createHarness({ timeoutMs: 600_000 })
    timeoutHarness.host.setTombstones('kb1', [{ docId: 't1' }])
    const run = timeoutHarness.organizer.triggerManual('kb1')
    await waitForFollowup(timeoutHarness)
    await advanceClock(timeoutHarness, 600_000)
    await run
    expect((await eventsFor(timeoutHarness)).map(event => event.kind)).toEqual(['organize_started', 'organize_failed'])
    expect(timeoutHarness.host.failureCalls).toHaveLength(0)
    await advanceClock(timeoutHarness, 60_000)
    await vi.waitFor(() => expect(timeoutHarness.createAgent).toHaveBeenCalledTimes(2))
  })

  it('resets after clearing at least one tombstone and treats the cleared batch as completed', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.host.setTombstones('kb1', [{ docId: 't1' }])
    harness.host.clearTombstone('kb1', 't1')

    const run = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    resolveIdle(harness)
    await run

    expect((await eventsFor(harness)).map(event => event.kind)).toEqual(['organize_started', 'organize_completed'])
    await advanceClock(harness, 600_000)
    expect(harness.createAgent).toHaveBeenCalledTimes(1)
  })

  it('does not reset on a no-change scheduleEvaluate and still retries on the 60s timer', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.host.setTombstones('kb1', [{ docId: 't1' }])
    const first = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    resolveIdle(harness)
    await first

    await harness.organizer.scheduleEvaluate()
    expect(harness.createAgent).toHaveBeenCalledTimes(1)
    await advanceClock(harness, 60_000)
    await vi.waitFor(() => expect(harness.createAgent).toHaveBeenCalledTimes(2))
  })

  it('resets immediately on real new work or a changed tombstone set', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.host.setTombstones('kb1', [{ docId: 't1', deletedAt: 1_000 }])
    const first = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    resolveIdle(harness)
    await first

    harness.host.setDocs('kb1', [{ docId: 'd-new' }])
    const secondRun = harness.organizer.scheduleEvaluate()
    await vi.waitFor(() => expect(harness.createAgent).toHaveBeenCalledTimes(2))
    await waitForFollowup(harness, 1, 1)
    resolveIdle(harness, 1)
    await secondRun
    expect(harness.agents[1]?.dispose).toHaveBeenCalledTimes(1)

    const tombstoneHarness = createHarness()
    tombstoneHarness.host.setTombstones('kb1', [{ docId: 't1', deletedAt: 1_000 }])
    const tombstoneFirst = tombstoneHarness.organizer.triggerManual('kb1')
    await waitForFollowup(tombstoneHarness)
    resolveIdle(tombstoneHarness)
    await tombstoneFirst

    tombstoneHarness.host.setTombstones('kb1', [{ docId: 't1', deletedAt: 2_000 }])
    const tombstoneSecond = tombstoneHarness.organizer.scheduleEvaluate()
    await vi.waitFor(() => expect(tombstoneHarness.createAgent).toHaveBeenCalledTimes(2))
    await waitForFollowup(tombstoneHarness, 1, 1)
    resolveIdle(tombstoneHarness, 1)
    await tombstoneSecond
    expect(tombstoneHarness.agents[1]?.dispose).toHaveBeenCalledTimes(1)
  })

  it('manual trigger during an in-flight pure-tombstone batch survives the re-armed backoff', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.host.setTombstones('kb1', [{ docId: 't1' }])

    const first = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    // 在途批次尚未结算:零进展 +1 与 60s 退避都将在它的 settle 里发生。
    const manual = harness.organizer.triggerManual('kb1')

    resolveIdle(harness)
    await first

    // 手动触发必须等到在途批次结算,再清掉刚挂上的退避并真的重新整理。
    await vi.waitFor(() => expect(harness.createAgent).toHaveBeenCalledTimes(2))
    await waitForFollowup(harness, 1, 1)

    resolveIdle(harness, 1)
    await manual
  })

  it('triggerManual cancels the backoff timer and re-evaluates without waiting', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.host.setTombstones('kb1', [{ docId: 't1' }])
    const first = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    resolveIdle(harness)
    await first
    expect(harness.createAgent).toHaveBeenCalledTimes(1)

    const retry = harness.organizer.triggerManual('kb1')
    await vi.waitFor(() => expect(harness.createAgent).toHaveBeenCalledTimes(2))
    resolveIdle(harness, 1)
    await retry
    await advanceClock(harness, 600_000)
    expect(harness.createAgent).toHaveBeenCalledTimes(2)
  })

  it('cancelForKb clears a backoff timer without counting for every non-dispose reason', async () => {
    vi.useFakeTimers()
    for (const reason of ['preempt', 'user-stop', 'maintenance'] as const) {
      const harness = createHarness()
      harness.host.setTombstones('kb1', [{ docId: 't1' }])
      const first = harness.organizer.triggerManual('kb1')
      await waitForFollowup(harness)
      resolveIdle(harness)
      await first
      await harness.organizer.cancelForKb('kb1', reason)
      await advanceClock(harness, 60_000)
      expect(harness.createAgent, reason).toHaveBeenCalledTimes(1)
      expect(harness.host.failureCalls, reason).toHaveLength(0)
    }
  })

  it('cancelAll clears a backoff timer and blocks scheduleEvaluate and stale timer callbacks', async () => {
    vi.useFakeTimers()
    const all = createHarness()
    all.host.setTombstones('kb1', [{ docId: 't1' }])
    const second = all.organizer.triggerManual('kb1')
    await waitForFollowup(all)
    resolveIdle(all)
    await second
    await all.organizer.cancelAll()
    await all.organizer.scheduleEvaluate()
    await advanceClock(all, 60_000)
    expect(all.createAgent).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 10. 真实 Agent 驱动
// ---------------------------------------------------------------------------

describe('real agent driving', () => {
  it('follows up exactly once, waits for whenIdle, then disposes, closes and releases exactly once', async () => {
    const harness = createHarness()
    harness.host.setDocs('kb1', [{ docId: 'd1' }])
    harness.host.markOrganized('kb1', 'd1')

    const run = harness.organizer.triggerManual('kb1')
    await vi.waitFor(() => {
      expect(harness.agents[0]?.followup).toHaveBeenCalledTimes(1)
    })
    const agent = harness.agents[0]!
    expect(agent.dispose).not.toHaveBeenCalled()
    expect(harness.releaseSlot).not.toHaveBeenCalled()
    expect(agent.whenIdle).toHaveBeenCalledTimes(1)
    const message = agent.followup.mock.calls[0]?.[0] as { content: Array<{ text: string }> } | undefined
    expect(message?.content[0]?.text).toContain('kb_org_get_delta')

    resolveIdle(harness)
    await run
    expect(agent.dispose).toHaveBeenCalledTimes(1)
    expect(harness.releaseSlot).toHaveBeenCalledTimes(1)
    expect(harness.host.failureCalls).toHaveLength(0)
  })

  it('skips followup and counts nothing when cancelForKb arrives while create is pending', async () => {
    const createGate = deferred<void>()
    const harness = createHarness({
      createGate: (index) => (index === 0 ? createGate.promise : undefined),
    })
    harness.host.setDocs('kb1', [{ docId: 'd1' }])

    const run = harness.organizer.triggerManual('kb1')
    await vi.waitFor(() => expect(harness.createAgent).toHaveBeenCalledTimes(1))
    const cancelPromise = harness.organizer.cancelForKb('kb1', 'preempt')
    createGate.resolve()
    await cancelPromise
    await run

    expect(harness.agents[0]?.followup).not.toHaveBeenCalled()
    expect(harness.host.failureCalls).toHaveLength(0)
    expect(harness.agents[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(harness.releaseSlot).toHaveBeenCalledTimes(1)
    expect((await eventsFor(harness)).map(event => event.kind)).toEqual(['organize_cancelled'])
  })

  it('fails the batch when noteError arrives after every doc was marked', async () => {
    const harness = createHarness()
    harness.host.setDocs('kb1', [{ docId: 'd1' }, { docId: 'd2' }])
    harness.host.markOrganized('kb1', 'd1')
    harness.host.markOrganized('kb1', 'd2')

    const run = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    noteKnowledgeOrganizerError(kbOrganizeSessionId('kb1'), 'model boom')
    resolveIdle(harness)
    await run

    expect(harness.host.failureCalls).toHaveLength(0)
    expect((await eventsFor(harness)).map(event => event.kind)).toEqual(['organize_started', 'organize_failed'])
  })

  it('does not read a stale cancel reason after a backoff-only cancelForKb and later triggerManual', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.host.setTombstones('kb1', [{ docId: 't1' }])
    const first = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    resolveIdle(harness)
    await first
    await harness.organizer.cancelForKb('kb1', 'user-stop')

    harness.host.clearTombstone('kb1', 't1')
    const retry = harness.organizer.triggerManual('kb1')
    await vi.waitFor(() => expect(harness.agents[1]?.followup).toHaveBeenCalledTimes(1))
    resolveIdle(harness, 1)
    await retry
    expect((await eventsFor(harness)).map(event => event.kind)).toEqual([
      'organize_started',
      'organize_failed',
      'organize_started',
      'organize_completed',
    ])
  })
})

// ---------------------------------------------------------------------------
// 11. 唯一权威批次
// ---------------------------------------------------------------------------

describe('single authoritative batch', () => {
  it('uses the open snapshot B for tools and settlement, ignoring peek A and late C', async () => {
    const harness = createHarness()
    const batchA = pendingBatch([{ docId: 'a1' }])
    const batchB = pendingBatch(
      [{ docId: 'b1' }, { docId: 'b2' }],
      [{ docId: 't-b' }],
    )
    harness.host.peekOverrides.set('kb1', [batchA])
    harness.host.openOverrides.set('kb1', [batchB])
    harness.host.markOrganized('kb1', 'b1')
    harness.host.clearTombstone('kb1', 't-b')

    const releaseHost = setKnowledgeHost(harness.host.asHost())
    const registered = new Map<string, { execute(args: Record<string, unknown>, exec: unknown): Promise<{ text: string }> }>()
    const disposeTools = registerKnowledgeOrgTools({
      tools: {
        register(definition: unknown) {
          const tool = definition as { name: string; execute(args: Record<string, unknown>, exec: unknown): Promise<{ text: string }> }
          registered.set(tool.name, tool)
          return () => registered.delete(tool.name)
        },
      },
      huaanworkProfileDir: harness.profileDir,
    } as never)

    try {
      const run = harness.organizer.triggerManual('kb1')
      await waitForFollowup(harness)
      // open 之后数据库才出现 C，且 peek A 只用于准入判断。
      harness.host.setDocs('kb1', [{ docId: 'b1' }, { docId: 'b2' }, { docId: 'c1' }])
      const deltaTool = registered.get('kb_org_get_delta')
      if (deltaTool === undefined) throw new Error('kb_org_get_delta missing')
      const delta = await deltaTool.execute({}, { agent: { session: { id: kbOrganizeSessionId('kb1') } } })
      expect(JSON.parse(delta.text)).toEqual(batchB)

      resolveIdle(harness)
      await run

      const failedIds = harness.host.failureCalls.map(call => call.docId)
      expect(failedIds).toEqual(['b2'])
      expect(failedIds).not.toContain('a1')
      expect(failedIds).not.toContain('c1')
    } finally {
      disposeTools()
      releaseHost()
    }
  })

  it('uses only settlement.clearedTombstoneIds for pure-tombstone progress, not model self-report', async () => {
    const harness = createHarness()
    harness.host.setTombstones('kb1', [{ docId: 't1' }, { docId: 't2' }])
    harness.host.clearTombstone('kb1', 't1')

    const run = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    // fake Agent 的文本/工具结果不在组织器里被解析；只有 close 结算算进展。
    resolveIdle(harness)
    await run

    expect((await eventsFor(harness)).map(event => event.kind)).toEqual(['organize_started', 'organize_failed'])
    expect(harness.host.failureCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 12. Host 整理门面：assertOrganizeAllowed 与相位委托
// ---------------------------------------------------------------------------

describe('real KnowledgeHost organizer facade', () => {
  it('rejects unknown/index-error and delegates organizer phases to SyncEngine', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-organizer-host-'))
    tempDirs.push(root)
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'source')
    const sourceDir2 = join(root, 'source-2')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(sourceDir2, { recursive: true })
    const storage = new HostFacadeStorage()
    const watcher = { on: () => watcher, close: () => undefined }
    const host = createKnowledgeHost({
      profileDir,
      storageOverrideForTest: storage as never,
      poolOverrideForTest: { abortAndDrainKb: async () => undefined } as never,
      reconcileIntervalMs: 600_000,
      watchFactory: () => watcher as never,
    })
    realHosts.push(host)
    await host.start()
    const kb = await host.create({ name: '宿主门面', sourceDir })
    await host.sync(kb.id)

    expect(() => host.assertOrganizeAllowed(kb.id)).not.toThrow()
    expect(() => host.assertOrganizeAllowed('missing-kb')).toThrow(/knowledge-base-not-found/u)
    expect(host.setOrganizerPhase(kb.id, 'organizing')).toBe(true)
    expect(host.get(kb.id)?.phase).toBe('organizing')
    host.clearOrganizerPhase(kb.id)
    expect(host.get(kb.id)?.phase).toBe('watching')

    storage.openResults.push({ ok: false, code: 'index-error', error: 'corrupt' })
    const broken = await host.create({ name: '坏索引', sourceDir: sourceDir2 })
    expect(host.get(broken.id)?.phase).toBe('index-error')
    expect(() => host.assertOrganizeAllowed(broken.id)).toThrow(/index-error/u)
    expect(host.setOrganizerPhase(broken.id, 'organizing')).toBe(false)
    expect(host.get(broken.id)?.phase).toBe('index-error')
  })
})

// ---------------------------------------------------------------------------
// 13. 手动整理校验与自动开关
// ---------------------------------------------------------------------------

describe('manual organize checks and auto switch', () => {
  it('does not create for autoOrganize=false with no manual request', async () => {
    const harness = createHarness({
      records: [makeRecord('kb-manual', '手动库', false)],
    })
    harness.host.setDocs('kb-manual', [{ docId: 'd1' }])

    await harness.organizer.scheduleEvaluate()

    expect(harness.createAgent).not.toHaveBeenCalled()
    expect(harness.scheduler.activeTurnCount()).toBe(0)
  })

  it('triggerManual starts the manual kb and lets other auto kbs participate through admitKbOrganize', async () => {
    const harness = createHarness({
      records: [makeRecord('kb-auto', '自动库'), makeRecord('kb-manual', '手动库', false)],
    })
    harness.host.setDocs('kb-auto', [{ docId: 'd-auto' }])
    harness.host.setDocs('kb-manual', [{ docId: 'd-manual' }])
    const admitSpy = vi.spyOn(harness.scheduler, 'admitKbOrganize')

    const autoRun = harness.organizer.scheduleEvaluate()
    await waitForFollowup(harness, 1, 0)
    const firstManualRun = harness.organizer.triggerManual('kb-manual')

    expect(harness.createAgent).toHaveBeenCalledTimes(1)
    expect(admitSpy.mock.calls.map(call => call[0].kbId)).toContain('kb-auto')

    harness.host.markOrganized('kb-auto', 'd-auto')
    resolveIdle(harness, 0)
    await autoRun
    await waitForFollowup(harness, 1, 1)
    harness.host.markOrganized('kb-manual', 'd-manual')
    resolveIdle(harness, 1)
    await firstManualRun

    expect(admitSpy.mock.calls.map(call => call[0].kbId)).toContain('kb-manual')
    expect(harness.createAgent).toHaveBeenCalledTimes(2)
  })

  it('rejects maintenance, deleting, recovery and unknown kb before any reset, timer, or create', async () => {
    const cases: Array<{ code: string; error: KnowledgeSyncError }> = [
      { code: 'knowledge-base-busy', error: new KnowledgeSyncError('knowledge-base-busy', 'maintenance') },
      { code: 'knowledge-base-deleting', error: new KnowledgeSyncError('knowledge-base-deleting', 'deleting') },
      { code: 'wiki-reset-pending', error: new KnowledgeSyncError('wiki-reset-pending', 'reset') },
      { code: 'index-error', error: new KnowledgeSyncError('index-error', 'index') },
      { code: 'knowledge-base-not-found', error: new KnowledgeSyncError('knowledge-base-not-found', 'missing') },
    ]
    vi.useFakeTimers()
    const harness = createHarness()
    harness.host.setTombstones('kb1', [{ docId: 't1' }])
    const first = harness.organizer.triggerManual('kb1')
    await waitForFollowup(harness)
    resolveIdle(harness)
    await first
    expect(harness.createAgent).toHaveBeenCalledTimes(1)

    for (const item of cases) {
      harness.host.assertErrors.set('kb1', item.error)
      await expect(harness.organizer.triggerManual('kb1')).rejects.toThrow(item.code)
      expect(harness.host.resetCalls, item.code).toHaveLength(0)
      expect(harness.createAgent, item.code).toHaveBeenCalledTimes(1)
    }

    harness.host.assertErrors.delete('kb1')
    await advanceClock(harness, 60_000)
    await vi.waitFor(() => expect(harness.createAgent).toHaveBeenCalledTimes(2))
  })

  it('lets autoOrganize=false be organized manually even when failures were previously recorded', async () => {
    const harness = createHarness({
      records: [makeRecord('kb-manual', '手动库', false)],
    })
    harness.host.setDocs('kb-manual', [{ docId: 'd1' }])
    harness.host.attempts.set('kb-manual\u0000d1', { attempts: 3, retryAfter: null, lastError: 'old' })

    const run = harness.organizer.triggerManual('kb-manual', { retryFailed: true })
    await vi.waitFor(() => expect(harness.agents[0]?.followup).toHaveBeenCalledTimes(1))
    resolveIdle(harness)
    await run
    expect(harness.host.resetCalls).toEqual([{ kbId: 'kb-manual' }])
    expect(harness.createAgent).toHaveBeenCalledTimes(1)
  })
})
