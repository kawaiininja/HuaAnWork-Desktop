import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import {
  detectCloudPlaceholder,
  WIN32_FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
} from '../../src/huaanwork-host/knowledge/cloud-placeholder.ts'
import { createExtractionPool } from '../../src/huaanwork-host/knowledge/extraction-pool.ts'
import { createKnowledgeStorageClient } from '../../src/huaanwork-host/knowledge/storage-client.ts'
import { createKnowledgeSyncEngine, type SyncWatcherHandle } from '../../src/huaanwork-host/knowledge/sync-engine.ts'
import { readKnowledgeEvents } from '../../src/huaanwork-host/knowledge/events.ts'
import { readKnowledgeBases, writeKnowledgeBases } from '../../src/huaanwork-host/knowledge/registry.ts'
import { neutralKnowledgeRootPath, neutralKnowledgeWikiRootPath } from '../../src/huaanwork-host/workspace-state.ts'

function createFakeWatcher(): SyncWatcherHandle & { emitChange: (name: string) => void; emitError: (err: Error) => void; closed: boolean } {
  const ee = new EventEmitter()
  const watcher = {
    closed: false,
    on: (ev: 'change' | 'error', fn: (...args: any[]) => void) => ee.on(ev, fn),
    close: () => { watcher.closed = true; ee.removeAllListeners() },
    emitChange: (name: string) => { if (!watcher.closed) ee.emit('change', 'rename', name) },
    emitError: (err: Error) => { if (!watcher.closed) ee.emit('error', err) },
  }
  return watcher
}

describe('knowledge Extraction Worker pool, cloud probe, and sync engine', () => {
  it('enforces spec defaults (1 worker, capped at 2, 60s timeout, 256 MB heap) and classifies cloud placeholders', () => {
    const defPool = createExtractionPool()
    expect(defPool.config).toEqual({ maxWorkers: 1, timeoutMs: 60_000, maxOldGenerationSizeMb: 256 })
    const clampedPool = createExtractionPool({ maxWorkers: 8 })
    expect(clampedPool.config).toEqual({ maxWorkers: 2, timeoutMs: 60_000, maxOldGenerationSizeMb: 256 })

    expect(detectCloudPlaceholder('C:\\a.txt', { platform: 'win32', readWin32Attributes: () => 0x20 })).toBe('local')
    expect(detectCloudPlaceholder('C:\\a.txt', { platform: 'win32', readWin32Attributes: () => WIN32_FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS })).toBe('dehydrated')
    expect(detectCloudPlaceholder('C:\\a.txt', { platform: 'win32', readWin32Attributes: () => 0xffffffff })).toBe('probe-unavailable')
    expect(detectCloudPlaceholder('/tmp/a.txt', { platform: 'darwin' })).toBe('probe-unavailable')
  })

  it('handles broken .asar files inside Extraction Worker and isolates single-file extraction timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-ext-worker-'))
    writeFileSync(join(dir, 'corrupt.asar'), 'NOT_AN_ASAR_ARCHIVE')
    writeFileSync(join(dir, 'ok.md'), '# 标题\n正文内容')

    const pool = createExtractionPool({ maxWorkers: 1, timeoutMs: 150 })
    expect(pool.isRunning()).toBe(false)
    try {
      const okRes = await pool.extractFile('kb-1', { sourceRoot: dir, filePath: join(dir, 'ok.md'), relPath: 'ok.md' })
      expect(okRes.ok).toBe(true)
      const asarRes = await pool.extractFile('kb-1', { sourceRoot: dir, filePath: join(dir, 'corrupt.asar'), relPath: 'corrupt.asar' })
      expect(asarRes.ok).toBe(true)
      const timedOut = await pool.extractFile('kb-1', { sourceRoot: dir, filePath: join(dir, 'ok.md'), relPath: 'ok.md', debugDelayMs: 1_000 })
      expect(timedOut).toMatchObject({ ok: false, reason: 'extract-timeout' })
      const afterRecover = await pool.extractFile('kb-1', { sourceRoot: dir, filePath: join(dir, 'ok.md'), relPath: 'ok.md' })
      expect(afterRecover.ok).toBe(true)
    } finally {
      await pool.dispose()
    }
    expect(pool.isRunning()).toBe(false)
    expect(pool.activeWorkerCount()).toBe(0)
  })

  it('answers hash-only requests with sha256/size/mtime and no document payload (M-9)', async () => {    const dir = mkdtempSync(join(tmpdir(), 'kb-ext-hash-'))
    writeFileSync(join(dir, 'hash.md'), '# 仅哈希\n正文不应被解析')

    const pool = createExtractionPool({ maxWorkers: 1 })
    try {
      const res = await pool.extractFile('kb-h', { sourceRoot: dir, filePath: join(dir, 'hash.md'), relPath: 'hash.md', hashOnly: true })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.hashOnly).toBe(true)
      expect(res.sha256).toMatch(/^[0-9a-f]{64}$/u)
      expect(res.size).toBeGreaterThan(0)
      expect(res.mtimeMs).toBeGreaterThan(0)
      expect('doc' in res).toBe(false)
      expect('chunks' in res).toBe(false)
    } finally {
      await pool.dispose()
    }
  })

  it('force-terminates a CPU-bound Extraction Worker and recovers on the next file (debugBusyLoopMs)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-ext-busy-'))
    writeFileSync(join(dir, 'spin.md'), '# 忙等\n正文')

    const pool = createExtractionPool({ maxWorkers: 1, timeoutMs: 150 })
    try {
      const busy = await pool.extractFile('kb-b', {
        sourceRoot: dir,
        filePath: join(dir, 'spin.md'),
        relPath: 'spin.md',
        debugBusyLoopMs: 60_000,
      })
      expect(busy).toMatchObject({ ok: false, reason: 'extract-timeout' })
      // 同步占满线程的 Worker 已被 terminate 回收，绝不遗留空转 CPU 线程。
      expect(pool.activeWorkerCount()).toBe(0)
      const recovered = await pool.extractFile('kb-b', {
        sourceRoot: dir,
        filePath: join(dir, 'spin.md'),
        relPath: 'spin.md',
      })
      expect(recovered.ok).toBe(true)
    } finally {
      await pool.dispose()
    }
  })

  it('awaits responsible Extraction Worker exit before abortAndDrainKb (pause) resolves (spec §6.1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-ext-drain-'))
    writeFileSync(join(dir, 'slow.md'), '# 慢文件\n正文')

    const pool = createExtractionPool({ maxWorkers: 1, timeoutMs: 30_000 })
    const originalTerminate = Worker.prototype.terminate
    const exitDelayMs = 150
    const terminateSpy = vi.spyOn(Worker.prototype, 'terminate')
    terminateSpy.mockImplementation(function (this: Worker): Promise<number> {
      // 真实发出 terminate（线程确实开始退出），但把「退出完成」推迟 exitDelayMs：
      // 只有池真的等待线程退出，暂停耗时才会覆盖这段延迟；旧实现会立刻返回。
      const real = originalTerminate.call(this)
      return new Promise<number>((resolve, reject) => {
        setTimeout(() => {
          real.then(resolve, reject)
        }, exitDelayMs)
      })
    })
    try {
      const inflight = pool.extractFile('kb-drain', {
        sourceRoot: dir,
        filePath: join(dir, 'slow.md'),
        relPath: 'slow.md',
        debugDelayMs: 10_000,
      })
      await vi.waitFor(() => {
        expect(pool.activeWorkerCount()).toBe(1)
      }, { timeout: 2_000 })

      const startedAt = Date.now()
      await pool.abortAndDrainKb('kb-drain')
      const elapsed = Date.now() - startedAt

      // 暂停返回时：job 已落定为 aborted，负责它的 Worker 也已确认退出（等待了退出耗时）。
      expect(await inflight).toMatchObject({ ok: false, reason: 'aborted' })
      expect(terminateSpy).toHaveBeenCalledTimes(1)
      expect(elapsed).toBeGreaterThanOrEqual(100)
      expect(pool.activeWorkerCount()).toBe(0)
      expect(pool.isRunning()).toBe(false)
    } finally {
      terminateSpy.mockRestore()
      await pool.dispose()
    }
  })

  it('aborts a paused KB queued extraction without touching the worker busy with another KB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-ext-queue-'))
    writeFileSync(join(dir, 'a.md'), '# A\n正文')
    writeFileSync(join(dir, 'b.md'), '# B\n正文')

    const pool = createExtractionPool({ maxWorkers: 1, timeoutMs: 30_000 })
    const running = pool.extractFile('kb-busy', {
      sourceRoot: dir,
      filePath: join(dir, 'b.md'),
      relPath: 'b.md',
      debugDelayMs: 30_000,
    })
    try {
      await vi.waitFor(() => {
        expect(pool.activeWorkerCount()).toBe(1)
      }, { timeout: 2_000 })
      const queued = pool.extractFile('kb-queued', {
        sourceRoot: dir,
        filePath: join(dir, 'a.md'),
        relPath: 'a.md',
      })
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50)
      })
      // 暂停排队中的库：排队任务以 aborted 落定（从未打开文件），忙碌 Worker 不受影响。
      await pool.abortAndDrainKb('kb-queued')
      expect(await queued).toMatchObject({ ok: false, reason: 'aborted' })
      expect(pool.activeWorkerCount()).toBe(1)
    } finally {
      await pool.dispose()
    }
    expect(await running).toMatchObject({ ok: false, reason: 'aborted' })
  })

  it('skips dehydrated cloud placeholders without opening or invoking Extraction pool while indexing sibling local files (R3-I6)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-cloud-e2e-'))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'src')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'cloud-only.md'), 'SHOULD_NOT_BE_READ')
    writeFileSync(join(sourceDir, 'local.md'), '本地正常文档')

    const storage = createKnowledgeStorageClient()
    const pool = createExtractionPool({ maxWorkers: 1 })
    const extractSpy = vi.spyOn(pool, 'extractFile')
    const engine = createKnowledgeSyncEngine({
      profileDir,
      storage,
      pool,
      debounceMs: 30,
      writeStableMs: 10,
      reconcileIntervalMs: 60_000,
      watchFactory: () => createFakeWatcher(),
      detectCloudPlaceholder: (p) => (p.endsWith('cloud-only.md') ? 'dehydrated' : 'local'),
    })
    try {
      await engine.startKb({ id: 'kb-c', name: '云盘', sourceDir, autoOrganize: false, watchPaused: true, createdAt: '2026-11-25T00:00:00.000Z' })
      await engine.syncNow('kb-c')

      expect(extractSpy.mock.calls.some(([, req]) => req.relPath === 'cloud-only.md')).toBe(false)
      expect(extractSpy.mock.calls.some(([, req]) => req.relPath === 'local.md')).toBe(true)
      const { docs } = await storage.listDocs('kb-c')
      expect(docs.find(d => d.relPath === 'cloud-only.md')).toMatchObject({ status: 'skipped', statusReason: 'cloud-placeholder-dehydrated' })
      expect(docs.find(d => d.relPath === 'local.md')).toMatchObject({ status: 'indexed' })
    } finally {
      await engine.dispose()
      await pool.dispose()
      await storage.dispose(900)
    }
  })

  it('drives automatic startup/debounce/periodic/resume reconcile and keeps periodic reconcile running in watch-failed (R3-I1)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-auto-watch-'))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'src')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'init.md'), '初始文档')

    const watchers: ReturnType<typeof createFakeWatcher>[] = []
    let fakeWall = 1_000_000
    let fakeMono = 1_000
    const storage = createKnowledgeStorageClient()
    const pool = createExtractionPool({ maxWorkers: 1 })
    const resumeSpy = vi.fn()
    const engine = createKnowledgeSyncEngine({
      profileDir,
      storage,
      pool,
      debounceMs: 40,
      writeStableMs: 15,
      reconcileIntervalMs: 120,
      nowWall: () => fakeWall,
      nowMono: () => fakeMono,
      watchFactory: () => {
        const w = createFakeWatcher()
        watchers.push(w)
        return w
      },
      detectCloudPlaceholder: () => 'local',
    })
    engine.onSystemResume(resumeSpy)
    try {
      // 1. Startup on non-paused KB triggers automatic initial reconcile without manual syncNow()
      await engine.startKb({ id: 'kb-a', name: '自动库', sourceDir, autoOrganize: false, watchPaused: false, createdAt: '2026-11-25T00:00:00.000Z' })
      await vi.waitFor(async () => {
        expect((await storage.listDocs('kb-a')).docs.some(d => d.relPath === 'init.md')).toBe(true)
      }, { timeout: 2_000 })

      // 2. Real-time watcher event -> 40ms debounce + 15ms write-stable -> automatic 1-to-1 rename
      const initId = (await storage.listDocs('kb-a')).docs.find(d => d.relPath === 'init.md')?.docId
      renameSync(join(sourceDir, 'init.md'), join(sourceDir, 'init-rt.md'))
      watchers.at(-1)?.emitChange('init.md')
      watchers.at(-1)?.emitChange('init-rt.md')
      await vi.waitFor(async () => {
        expect((await storage.listDocs('kb-a')).docs.find(d => d.relPath === 'init-rt.md')?.docId).toBe(initId)
      }, { timeout: 2_000 })

      // 3. Watcher error -> watch-failed, yet 120ms periodic reconcile STILL discovers new files automatically
      watchers.at(-1)?.emitError(new Error('EMFILE'))
      expect(engine.getState('kb-a')?.phase).toBe('watch-failed')
      writeFileSync(join(sourceDir, 'periodic.md'), '定时发现')
      const countBefore = engine.getMetricsForTest('kb-a').periodicReconcileCount
      await vi.waitFor(async () => {
        expect(engine.getMetricsForTest('kb-a').periodicReconcileCount).toBeGreaterThan(countBefore)
        expect((await storage.listDocs('kb-a')).docs.some(d => d.relPath === 'periodic.md')).toBe(true)
      }, { timeout: 2_000 })

      // 3b. M-22: handleSystemResume fires listeners, rebuilds Watcher for non-paused KB, and reconciles
      const watchersBeforeResume = watchers.length
      writeFileSync(join(sourceDir, 'after-resume.md'), '休眠恢复补齐')
      await engine.handleSystemResume()
      expect(resumeSpy).toHaveBeenCalledTimes(1)
      expect(watchers.length).toBeGreaterThan(watchersBeforeResume)
      expect(watchers.at(-2)?.closed).toBe(true)
      expect(watchers.at(-1)?.closed).toBe(false)
      expect(engine.getState('kb-a')?.phase).toBe('watching')
      expect((await storage.listDocs('kb-a')).docs.some(d => d.relPath === 'after-resume.md')).toBe(true)

      // 4. pauseWatch stops periodic & resume reconcile; resumeWatch rebuilds watcher & triggers immediate reconcile
      await engine.pauseWatch('kb-a')
      expect(engine.getState('kb-a')?.phase).toBe('watch-paused')
      expect(watchers.at(-1)?.closed).toBe(true)
      const pausedPeriodic = engine.getMetricsForTest('kb-a').periodicReconcileCount
      writeFileSync(join(sourceDir, 'while-paused.md'), '暂停期新增')
      fakeWall += 60_000
      fakeMono += 100
      await engine.checkClockJump()
      await new Promise(r => setTimeout(r, 200))
      expect(engine.getMetricsForTest('kb-a').periodicReconcileCount).toBe(pausedPeriodic)
      expect((await storage.listDocs('kb-a')).docs.some(d => d.relPath === 'while-paused.md')).toBe(false)

      await engine.resumeWatch('kb-a')
      await vi.waitFor(async () => {
        expect(engine.getState('kb-a')?.phase).toBe('watching')
        expect((await storage.listDocs('kb-a')).docs.some(d => d.relPath === 'while-paused.md')).toBe(true)
      }, { timeout: 2_000 })
    } finally {
      await engine.dispose()
      await pool.dispose()
      await storage.dispose(900)
    }
  })

  it('integrates real fs.watch with debounced auto-indexing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-real-fswatch-'))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'src')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })

    const storage = createKnowledgeStorageClient()
    const pool = createExtractionPool({ maxWorkers: 1 })
    const engine = createKnowledgeSyncEngine({
      profileDir,
      storage,
      pool,
      debounceMs: 80,
      writeStableMs: 25,
      reconcileIntervalMs: 300_000,
    })
    try {
      await engine.startKb({ id: 'kb-rw', name: '真实监听', sourceDir, autoOrganize: false, watchPaused: false, createdAt: '2026-11-25T00:00:00.000Z' })
      writeFileSync(join(sourceDir, 'live.md'), '真实 fs.watch 命中')
      await vi.waitFor(async () => {
        expect((await storage.listDocs('kb-rw')).docs.some(d => d.relPath === 'live.md')).toBe(true)
      }, { timeout: 3_000 })
    } finally {
      await engine.dispose()
      await pool.dispose()
      await storage.dispose(900)
    }
  })

  it('rebuilds the index through the staging commit point, keeps doc_id, and stays usable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-rebuild-'))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'src')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'doc.md'), '重建内容')

    const kbDir = neutralKnowledgeRootPath(profileDir, 'kb-rb')
    const storage = createKnowledgeStorageClient()
    const pool = createExtractionPool({ maxWorkers: 1 })
    const engine = createKnowledgeSyncEngine({
      profileDir,
      storage,
      pool,
      debounceMs: 30,
      writeStableMs: 10,
      reconcileIntervalMs: 300_000,
    })
    try {
      await engine.startKb({ id: 'kb-rb', name: '重建库', sourceDir, autoOrganize: false, watchPaused: true, createdAt: '2026-11-25T00:00:00.000Z' })
      await engine.syncNow('kb-rb')
      const before = (await storage.listDocs('kb-rb')).docs
      expect(before).toHaveLength(1)
      const docIdBefore = before[0]?.docId

      await engine.rebuildIndex('kb-rb')
      const after = (await storage.listDocs('kb-rb')).docs
      expect(after).toHaveLength(1)
      expect(after[0]?.docId).toBe(docIdBefore)
      expect(existsSync(join(kbDir, 'index.sqlite'))).toBe(true)
      expect(existsSync(join(kbDir, 'index.sqlite.rebuild'))).toBe(false)
      const rebuildEvents = await readKnowledgeEvents(kbDir)
      expect(rebuildEvents.some(e => e.kind === 'rebuild_completed')).toBe(true)

      // 提交点之后 Storage Worker 已重开新主库，同步引擎仍可继续索引。
      writeFileSync(join(sourceDir, 'doc-2.md'), '重建后新增')
      await engine.syncNow('kb-rb')
      expect((await storage.listDocs('kb-rb')).docs.some(d => d.relPath === 'doc-2.md')).toBe(true)
    } finally {
      await engine.dispose()
      await pool.dispose()
      await storage.dispose(900)
    }
  })

  it('supports 1-to-1 & case-only rename without duplicate false positives, >5 batch folding, maxFilesPerKb cap, and rebind preserving doc_id/organized_sha256/wiki/embeddings (R3-I7)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-sync-'))
    const profileDir = join(root, 'profile')
    const sourceA = join(root, 'src-a')
    const sourceAMoved = join(root, 'src-a-moved')
    const sourceUnrelated = join(root, 'src-unrelated')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceA, { recursive: true })
    mkdirSync(sourceAMoved, { recursive: true })
    mkdirSync(sourceUnrelated, { recursive: true })

    writeFileSync(join(sourceA, 'a.md'), '唯一内容 Alpha')
    writeFileSync(join(sourceA, 'dup1.md'), '重复内容 Same')
    writeFileSync(join(sourceA, 'dup2.md'), '重复内容 Same')

    const kb = { id: 'kb-1', name: '测试库', sourceDir: sourceA, autoOrganize: true, watchPaused: false, createdAt: '2026-11-25T00:00:00.000Z' }
    await writeKnowledgeBases(profileDir, [kb])

    let fakeWall = 1_000_000
    let fakeMono = 1_000
    const storage = createKnowledgeStorageClient()
    const pool = createExtractionPool({ maxWorkers: 1 })
    const resumeSpy = vi.fn()
    const engine = createKnowledgeSyncEngine({
      profileDir,
      storage,
      pool,
      maxFilesPerKb: 10,
      debounceMs: 50,
      writeStableMs: 20,
      reconcileIntervalMs: 300_000,
      nowWall: () => fakeWall,
      nowMono: () => fakeMono,
      watchFactory: () => createFakeWatcher(),
      detectCloudPlaceholder: () => 'probe-unavailable',
    })
    engine.onSystemResume(resumeSpy)

    try {
      await engine.startKb(kb)
      await engine.syncNow('kb-1')

      // Probe unavailable logged info event and indexed all 3 files
      const events1 = await readKnowledgeEvents(neutralKnowledgeRootPath(profileDir, 'kb-1'))
      expect(events1.some(e => e.kind === 'cloud_probe_unavailable' && e.level === 'info')).toBe(true)

      const { docs: docsBefore } = await storage.listDocs('kb-1')
      const alphaDoc = docsBefore.find(d => d.relPath === 'a.md')
      const alphaId = alphaDoc?.docId
      const dup1Id = docsBefore.find(d => d.relPath === 'dup1.md')?.docId
      const dup2Id = docsBefore.find(d => d.relPath === 'dup2.md')?.docId
      expect(alphaId).toBeTruthy()
      expect(dup1Id).toBeTruthy()
      expect(dup2Id).toBeTruthy()

      // 1-to-1 rename in its OWN batch preserves doc_id
      renameSync(join(sourceA, 'a.md'), join(sourceA, 'a-renamed.md'))
      await engine.syncNow('kb-1')
      let docsAfterRename = (await storage.listDocs('kb-1')).docs
      expect(docsAfterRename.find(d => d.relPath === 'a-renamed.md')?.docId).toBe(alphaId)
      expect(docsAfterRename.some(d => d.relPath === 'a.md')).toBe(false)

      // Duplicate content (shared hash) must NOT false-bind a 1-to-1 rename
      renameSync(join(sourceA, 'dup1.md'), join(sourceA, 'dup3.md'))
      await engine.syncNow('kb-1')
      docsAfterRename = (await storage.listDocs('kb-1')).docs
      expect(docsAfterRename.find(d => d.relPath === 'dup3.md')?.docId).not.toBe(dup1Id)
      expect(docsAfterRename.find(d => d.relPath === 'dup3.md')?.docId).not.toBe(dup2Id)
      const dup3Id = docsAfterRename.find(d => d.relPath === 'dup3.md')?.docId
      expect(dup3Id).toBeTruthy()
      renameSync(join(sourceA, 'dup2.md'), join(sourceA, 'dup4.md'))
      await engine.syncNow('kb-1')
      docsAfterRename = (await storage.listDocs('kb-1')).docs
      expect(docsAfterRename.find(d => d.relPath === 'dup4.md')?.docId).not.toBe(dup1Id)
      expect(docsAfterRename.find(d => d.relPath === 'dup4.md')?.docId).not.toBe(dup2Id)
      const dup4Id = docsAfterRename.find(d => d.relPath === 'dup4.md')?.docId
      expect(dup4Id).toBeTruthy()

      // Multi-vanish / multi-add batch must not reuse doc_id either (rename rule is exactly 1 + 1)
      writeFileSync(join(sourceA, 'multi-1.md'), '多对多甲')
      writeFileSync(join(sourceA, 'multi-2.md'), '多对多乙')
      await engine.syncNow('kb-1')
      const multiDocs = (await storage.listDocs('kb-1')).docs
      const multi1Id = multiDocs.find(d => d.relPath === 'multi-1.md')?.docId
      const multi2Id = multiDocs.find(d => d.relPath === 'multi-2.md')?.docId
      expect(multi1Id).toBeTruthy()
      expect(multi2Id).toBeTruthy()
      renameSync(join(sourceA, 'multi-1.md'), join(sourceA, 'multi-a.md'))
      renameSync(join(sourceA, 'multi-2.md'), join(sourceA, 'multi-b.md'))
      await engine.syncNow('kb-1')
      const docsAfterMulti = (await storage.listDocs('kb-1')).docs
      expect(docsAfterMulti.find(d => d.relPath === 'multi-a.md')?.docId).not.toBe(multi1Id)
      expect(docsAfterMulti.find(d => d.relPath === 'multi-b.md')?.docId).not.toBe(multi2Id)
      const multiAId = docsAfterMulti.find(d => d.relPath === 'multi-a.md')?.docId
      const multiBId = docsAfterMulti.find(d => d.relPath === 'multi-b.md')?.docId
      expect(multiAId).toBeTruthy()
      expect(multiBId).toBeTruthy()

      // Case-only rename on case-insensitive volume reuses doc_id (spec §6.1)
      engine.setCaseSensitiveForTest('kb-1', false)
      renameSync(join(sourceA, 'a-renamed.md'), join(sourceA, 'A-RENAMED.md'))
      await engine.syncNow('kb-1')
      expect((await storage.listDocs('kb-1')).docs.find(d => d.relPath === 'A-RENAMED.md')?.docId).toBe(alphaId)
      renameSync(join(sourceA, 'A-RENAMED.md'), join(sourceA, 'a-renamed.md'))
      await engine.syncNow('kb-1')

      // > 5 files batch folds into single sync_completed summary & enforces maxFilesPerKb (10).
      // 字典序前 10 名为 a-renamed + batch-0/1/10/11/2..6；dup3/dup4/multi-a/multi-b 排序
      // 在上限之外但已入库，必须保留原行与 doc_id（旧实现会把它们当「消失」删掉）。
      for (let i = 0; i < 12; i += 1) writeFileSync(join(sourceA, `batch-${i}.md`), `批量文档 ${i}`)
      await engine.syncNow('kb-1')
      const eventsAfterBatch = await readKnowledgeEvents(neutralKnowledgeRootPath(profileDir, 'kb-1'))
      expect(eventsAfterBatch.some(e => e.kind === 'sync_completed' && (e.count ?? 0) > 5)).toBe(true)

      const capEvent = eventsAfterBatch.find(e => e.kind === 'file_skipped' && (e.detail ?? '').startsWith('max-files-exceeded'))
      // 汇总只统计真正的新文件（字典序在外的 batch-7/8/9），已入库的超限文档不算新跳过。
      expect(capEvent?.count).toBe(3)
      const docsAfterBatch = (await storage.listDocs('kb-1')).docs
      expect(docsAfterBatch.find(d => d.relPath === 'dup3.md')?.docId).toBe(dup3Id)
      expect(docsAfterBatch.find(d => d.relPath === 'dup4.md')?.docId).toBe(dup4Id)
      expect(docsAfterBatch.find(d => d.relPath === 'multi-a.md')?.docId).toBe(multiAId)
      expect(docsAfterBatch.find(d => d.relPath === 'multi-b.md')?.docId).toBe(multiBId)
      expect(docsAfterBatch).toHaveLength(14)

      // Seed organized_sha256, wiki card, and chunk_embeddings BEFORE rebind (R3-I7)
      const alphaBeforeRebind = (await storage.listDocs('kb-1')).docs.find(d => d.relPath === 'a-renamed.md')!
      const wikiCardPath = join(neutralKnowledgeWikiRootPath(profileDir, 'kb-1'), 'docs', `${alphaId}.md`)
      mkdirSync(join(neutralKnowledgeWikiRootPath(profileDir, 'kb-1'), 'docs'), { recursive: true })
      writeFileSync(wikiCardPath, '# Alpha 卡片正文')
      await storage.markOrganizedAtomic('kb-1', alphaId!, alphaBeforeRebind.sha256, `docs/${alphaId}.md`)
      const alphaChunks = await storage.getDocChunks('kb-1', alphaId!, 0, 10)
      await storage.putEmbedding('kb-1', alphaChunks[0]!.chunkId, 'model-k1', 4, new Uint8Array([1, 2, 3, 4]))
      expect(await storage.countEmbeddings('kb-1', alphaId!)).toBe(1)

      // Rebind to moved copy with changed mtimeMs short-circuits via sha256 (keeps doc_id, organized_sha256, wiki card, embeddings)
      writeFileSync(join(sourceAMoved, 'a-renamed.md'), '唯一内容 Alpha')
      const future = new Date(Date.now() + 120_000)
      utimesSync(join(sourceAMoved, 'a-renamed.md'), future, future)
      const rebindExtractCountBefore = engine.getMetricsForTest('kb-1').fullRechunkCount
      await engine.rebindSourceDir('kb-1', sourceAMoved)
      const alphaAfterRebind = (await storage.listDocs('kb-1')).docs.find(d => d.relPath === 'a-renamed.md')
      expect(alphaAfterRebind?.docId).toBe(alphaId)
      expect(alphaAfterRebind?.organizedSha256).toBe(alphaBeforeRebind.sha256)
      expect(readFileSync(wikiCardPath, 'utf8')).toBe('# Alpha 卡片正文')
      expect(await storage.countEmbeddings('kb-1', alphaId!)).toBe(1)
      expect(engine.getMetricsForTest('kb-1').fullRechunkCount).toBe(rebindExtractCountBefore)
      expect((await readKnowledgeBases(profileDir))[0]?.sourceDir).toBe(sourceAMoved)
      const eventsAfterRebind = await readKnowledgeEvents(neutralKnowledgeRootPath(profileDir, 'kb-1'))
      expect(eventsAfterRebind.some(e => e.kind === 'source_rebound')).toBe(true)

      // Rebind to unrelated dir disables cross-dir rename guessing and deletes disappeared docs
      writeFileSync(join(sourceUnrelated, 'other-name.md'), '唯一内容 Alpha')
      await engine.rebindSourceDir('kb-1', sourceUnrelated)
      expect((await storage.listDocs('kb-1')).docs.find(d => d.relPath === 'other-name.md')?.docId).not.toBe(alphaId)

      // Invalid rebind path has zero side-effect
      await expect(engine.rebindSourceDir('kb-1', profileDir)).rejects.toThrow()
      expect(engine.getState('kb-1')?.sourceDir).toBe(sourceUnrelated)
      expect(existsSync(join(neutralKnowledgeRootPath(profileDir, 'kb-1'), 'index.sqlite'))).toBe(true)
    } finally {
      await engine.dispose()
      await pool.dispose()
      await storage.dispose(900)
    }
  })
})
