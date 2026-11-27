/**
 * M1-2 Task 5: `KnowledgeSyncEngine` 整理相位窄接口。
 *
 * 规格依据:docs/superpowers/specs/2026-11-24-knowledge-base-design.md §8.2 / §8.3。
 * 真实 SyncEngine 加注入的 storage/watcher/pool,只验证相位状态机:
 * `setOrganizerPhase` 的 live/维护/删除/recovery 门闩、`clearOrganizerPhase` 的窄恢复,
 * 以及 `settlePhase` / `pauseWatch` / `resumeWatch` 不覆盖四个整理相位。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { ExtractionPool } from '../../src/huaanwork-host/knowledge/extraction-pool.ts'
import type { KnowledgeStorageClient } from '../../src/huaanwork-host/knowledge/storage-client.ts'
import {
  createKnowledgeSyncEngine,
  type KnowledgeSyncEngine,
  type SyncWatcherHandle,
} from '../../src/huaanwork-host/knowledge/sync-engine.ts'
import type {
  KnowledgeBaseRecord,
  KnowledgeOrganizerPhase,
  KnowledgePhase,
  KnowledgeBaseStats,
} from '../../src/huaanwork-host/knowledge/types.ts'

const ORGANIZER_PHASES: readonly KnowledgeOrganizerPhase[] = [
  'waiting-turn-slot',
  'organizing',
  'blocked-no-model',
  'blocked-network',
]

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

interface Gate {
  readonly promise: Promise<void>
  release(): void
}

function gate(): Gate {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

/** 注入的 Storage 只提供 SyncEngine 实际调用的最小面；其余方法在类型断言后访问即失败。 */
class PhaseStorage {
  readonly openResults = new Map<string, Awaited<ReturnType<KnowledgeStorageClient['openKb']>>>()
  readonly listDocsErrors: Error[] = []
  listDocsGate: Gate | undefined
  beginRebuildGate: Gate | undefined
  listDocsCalls = 0
  beginRebuildCalls = 0

  async openKb(kbId: string): Promise<Awaited<ReturnType<KnowledgeStorageClient['openKb']>>> {
    return this.openResults.get(kbId) ?? { ok: true, wikiResetPending: false }
  }

  async closeKb(): Promise<void> {
    return undefined
  }

  async listDocs(): Promise<{ total: number; docs: [] }> {
    this.listDocsCalls += 1
    if (this.listDocsGate !== undefined) await this.listDocsGate.promise
    const error = this.listDocsErrors.shift()
    if (error !== undefined) throw error
    return { total: 0, docs: [] }
  }

  async beginRebuild(): Promise<{ corruptRecovery: boolean }> {
    this.beginRebuildCalls += 1
    if (this.beginRebuildGate !== undefined) await this.beginRebuildGate.promise
    return { corruptRecovery: false }
  }

  async commitRebuild(): Promise<{ ok: true; corruptRecovery: boolean; wikiResetPending: boolean }> {
    return { ok: true, corruptRecovery: false, wikiResetPending: false }
  }

  async abortRebuild(): Promise<void> {
    return undefined
  }

  async retryPendingWikiReset(): Promise<{ ok: true }> {
    return { ok: true }
  }

  async getStats(): Promise<KnowledgeBaseStats> {
    return ZERO_STATS
  }

  isRunning(): boolean {
    return true
  }

  async dispose(): Promise<void> {
    return undefined
  }
}

function createFakeWatcher(): SyncWatcherHandle & {
  emitError(error: Error): void
  closed: boolean
} {
  const handlers = new Map<string, Array<(...args: never[]) => void>>()
  const watcher = {
    closed: false,
    on(event: string, listener: (...args: never[]) => void): unknown {
      const list = handlers.get(event) ?? []
      list.push(listener)
      handlers.set(event, list)
      return watcher
    },
    close(): void {
      watcher.closed = true
      handlers.clear()
    },
    emitError(error: Error): void {
      if (watcher.closed) return
      for (const listener of handlers.get('error') ?? []) listener(error as never)
    },
  }
  return watcher
}

interface PhaseFixture {
  readonly root: string
  readonly profileDir: string
  readonly sourceDir: string
  readonly engine: KnowledgeSyncEngine
  readonly storage: PhaseStorage
  readonly watchers: Array<ReturnType<typeof createFakeWatcher>>
}

const tempDirs: string[] = []
const engines: KnowledgeSyncEngine[] = []

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(async () => {
  for (const engine of engines.splice(0).reverse()) {
    try {
      await engine.dispose()
    } catch {
      // 清理失败不掩盖测试结果。
    }
  }
  vi.useRealTimers()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function createPhaseFixture(options: { readonly missingSource?: boolean } = {}): PhaseFixture {
  const root = mkdtempSync(join(tmpdir(), 'kb-organizer-phase-'))
  tempDirs.push(root)
  const profileDir = join(root, 'profile')
  const sourceDir = join(root, 'source')
  mkdirSync(profileDir, { recursive: true })
  if (options.missingSource !== true) {
    mkdirSync(sourceDir, { recursive: true })
  }
  const storage = new PhaseStorage()
  const watchers: Array<ReturnType<typeof createFakeWatcher>> = []
  const pool = {
    abortAndDrainKb: vi.fn(async () => undefined),
    extractFile: vi.fn(async () => ({ ok: false, reason: 'not-used' })),
  } as unknown as ExtractionPool
  const engine = createKnowledgeSyncEngine({
    profileDir,
    storage: storage as unknown as KnowledgeStorageClient,
    pool,
    debounceMs: 5,
    writeStableMs: 1,
    reconcileIntervalMs: 600_000,
    watchFactory: () => {
      const watcher = createFakeWatcher()
      watchers.push(watcher)
      return watcher
    },
  })
  engines.push(engine)
  return { root, profileDir, sourceDir, engine, storage, watchers }
}

function record(kbId: string, sourceDir: string, watchPaused: boolean): KnowledgeBaseRecord {
  return {
    id: kbId,
    name: `相位库 ${kbId}`,
    sourceDir,
    autoOrganize: true,
    watchPaused,
    createdAt: '2026-11-27T00:00:00.000Z',
  }
}

async function startWatching(fixture: PhaseFixture, kbId: string): Promise<void> {
  await fixture.engine.startKb(record(kbId, fixture.sourceDir, false))
  await fixture.engine.syncNow(kbId)
  expect(fixture.engine.getState(kbId)?.phase).toBe('watching')
}

async function startPaused(fixture: PhaseFixture, kbId: string): Promise<void> {
  await fixture.engine.startKb(record(kbId, fixture.sourceDir, true))
  expect(fixture.engine.getState(kbId)?.phase).toBe('watch-paused')
}

async function noChangeReconcile(fixture: PhaseFixture, kbId: string, expected: KnowledgePhase): Promise<void> {
  await fixture.engine.syncNow(kbId).catch(() => undefined)
  expect(fixture.engine.getState(kbId)?.phase).toBe(expected)
}

// ---------------------------------------------------------------------------
// 四个整理相位在无变更对账后保持
// ---------------------------------------------------------------------------

it('preserves every organizer phase through a no-change reconcile', async () => {
  for (const base of ['watching', 'watch-paused', 'watch-failed', 'source-unavailable'] as const) {
    const fixture = createPhaseFixture({ missingSource: base === 'source-unavailable' })
    const kbId = `kb-${base}`
    if (base === 'watching') {
      await startWatching(fixture, kbId)
    } else if (base === 'watch-paused') {
      await startPaused(fixture, kbId)
    } else {
      await fixture.engine.startKb(record(kbId, fixture.sourceDir, false))
      if (base === 'watch-failed') {
        fixture.engine.simulateWatchErrorForTest(kbId, new Error('watch failure'))
      }
      expect(fixture.engine.getState(kbId)?.phase).toBe(base)
    }

    for (const phase of ORGANIZER_PHASES) {
      expect(fixture.engine.setOrganizerPhase(kbId, phase)).toBe(true)
      expect(fixture.engine.getState(kbId)?.phase).toBe(phase)
      await noChangeReconcile(fixture, kbId, phase)
    }
  }
})

it('restores watching / watch-paused / watch-failed / source-unavailable when clearing an organizer phase', async () => {
  const cases: Array<{
    readonly base: 'watching' | 'watch-paused' | 'watch-failed' | 'source-unavailable'
    readonly start: (fixture: PhaseFixture, kbId: string) => Promise<void>
  }> = [
    { base: 'watching', start: startWatching },
    { base: 'watch-paused', start: startPaused },
    {
      base: 'watch-failed',
      start: async (fixture, kbId) => {
        await startWatching(fixture, kbId)
        fixture.engine.simulateWatchErrorForTest(kbId, new Error('watch failure'))
      },
    },
    {
      base: 'source-unavailable',
      start: async (fixture, kbId) => {
        await fixture.engine.startKb(record(kbId, fixture.sourceDir, false))
      },
    },
  ]

  for (const item of cases) {
    const fixture = createPhaseFixture({ missingSource: item.base === 'source-unavailable' })
    const kbId = `kb-clear-${item.base}`
    await item.start(fixture, kbId)
    expect(fixture.engine.getState(kbId)?.phase).toBe(item.base)
    expect(fixture.engine.setOrganizerPhase(kbId, 'organizing')).toBe(true)
    fixture.engine.clearOrganizerPhase(kbId)
    expect(fixture.engine.getState(kbId)?.phase).toBe(item.base)
  }
})

// ---------------------------------------------------------------------------
// setOrganizerPhase 的拒绝条件
// ---------------------------------------------------------------------------

it('rejects setting an organizer phase when the runtime is absent, locked, or in recovery', async () => {
  const fixture = createPhaseFixture()
  expect(fixture.engine.setOrganizerPhase('kb-absent', 'organizing')).toBe(false)
  expect(fixture.engine.getState('kb-absent')).toBeUndefined()

  const watchingKb = 'kb-locked'
  await startWatching(fixture, watchingKb)
  const maintain = await fixture.engine.acquireLifecycleLock(watchingKb, 'maintain')
  try {
    expect(fixture.engine.setOrganizerPhase(watchingKb, 'organizing')).toBe(false)
    expect(fixture.engine.getState(watchingKb)?.phase).toBe('watching')
  } finally {
    maintain()
  }

  const deleteKb = 'kb-delete-lock'
  await startWatching(fixture, deleteKb)
  const deletion = await fixture.engine.acquireLifecycleLock(deleteKb, 'delete')
  try {
    expect(fixture.engine.setOrganizerPhase(deleteKb, 'blocked-network')).toBe(false)
    expect(fixture.engine.getState(deleteKb)?.phase).toBe('watching')
  } finally {
    deletion()
  }

  const resetKb = 'kb-reset'
  fixture.storage.openResults.set(resetKb, { ok: true, wikiResetPending: true })
  await fixture.engine.startKb(record(resetKb, fixture.sourceDir, true))
  expect(fixture.engine.getState(resetKb)?.phase).toBe('wiki-reset-pending')
  expect(fixture.engine.setOrganizerPhase(resetKb, 'organizing')).toBe(false)
  expect(fixture.engine.getState(resetKb)?.phase).toBe('wiki-reset-pending')

  const errorKb = 'kb-index-error'
  fixture.storage.openResults.set(errorKb, { ok: false, code: 'index-error', error: 'corrupt' })
  await fixture.engine.startKb(record(errorKb, fixture.sourceDir, true))
  expect(fixture.engine.getState(errorKb)?.phase).toBe('index-error')
  expect(fixture.engine.setOrganizerPhase(errorKb, 'organizing')).toBe(false)
  expect(fixture.engine.getState(errorKb)?.phase).toBe('index-error')
})

// ---------------------------------------------------------------------------
// clear 不覆盖后续同步态与恢复态
// ---------------------------------------------------------------------------

it('clearOrganizerPhase never overwrites syncing, rebuilding, recovery, or a later organizer phase', async () => {
  const fixture = createPhaseFixture()
  const kbId = 'kb-clear-sync'
  await startWatching(fixture, kbId)

  // syncing: 让一次无变更对账停在 listDocs 前。
  const syncGate = gate()
  fixture.storage.listDocsGate = syncGate
  const syncing = fixture.engine.syncNow(kbId)
  await vi.waitFor(() => {
    expect(fixture.engine.getState(kbId)?.phase).toBe('syncing')
  })
  fixture.engine.clearOrganizerPhase(kbId)
  expect(fixture.engine.getState(kbId)?.phase).toBe('syncing')
  syncGate.release()
  fixture.storage.listDocsGate = undefined
  await syncing

  // rebuilding: 让 rebuild 停在 beginRebuild 前。
  const rebuildGate = gate()
  fixture.storage.beginRebuildGate = rebuildGate
  const rebuilding = fixture.engine.rebuildIndex(kbId)
  await vi.waitFor(() => {
    expect(fixture.engine.getState(kbId)?.phase).toBe('rebuilding')
  })
  fixture.engine.clearOrganizerPhase(kbId)
  expect(fixture.engine.getState(kbId)?.phase).toBe('rebuilding')
  rebuildGate.release()
  fixture.storage.beginRebuildGate = undefined
  await rebuilding

  // 整理相位先进,随后对账失败进入 index-error;clear 不得抹掉 recovery。
  expect(fixture.engine.setOrganizerPhase(kbId, 'organizing')).toBe(true)
  fixture.storage.listDocsErrors.push(new Error('SQLITE_CORRUPT'))
  await fixture.engine.syncNow(kbId).catch(() => undefined)
  expect(fixture.engine.getState(kbId)?.phase).toBe('index-error')
  fixture.engine.clearOrganizerPhase(kbId)
  expect(fixture.engine.getState(kbId)?.phase).toBe('index-error')
})

// ---------------------------------------------------------------------------
// pauseWatch / resumeWatch 不覆盖整理相位
// ---------------------------------------------------------------------------

it('pauseWatch and resumeWatch do not overwrite an organizer phase', async () => {
  const fixture = createPhaseFixture()
  const kbId = 'kb-watch'
  await startWatching(fixture, kbId)
  expect(fixture.engine.setOrganizerPhase(kbId, 'organizing')).toBe(true)

  await fixture.engine.pauseWatch(kbId)
  expect(fixture.engine.getState(kbId)?.phase).toBe('organizing')
  await fixture.engine.resumeWatch(kbId, { awaitReconcile: false })
  expect(fixture.engine.getState(kbId)?.phase).toBe('organizing')

  fixture.engine.clearOrganizerPhase(kbId)
  expect(fixture.engine.getState(kbId)?.phase).toBe('watching')
})
