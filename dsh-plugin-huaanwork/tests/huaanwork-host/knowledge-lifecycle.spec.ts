import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { createKnowledgeHost } from '../../src/huaanwork-host/knowledge/host.ts'
import { createExtractionPool } from '../../src/huaanwork-host/knowledge/extraction-pool.ts'
import { KNOWLEDGE_TEST_CORRUPT_AFTER_COMMIT } from '../../src/huaanwork-host/knowledge/storage-protocol.ts'
import { MAX_KNOWLEDGE_BASES } from '../../src/huaanwork-host/knowledge/types.ts'
import { neutralKnowledgeRootPath, neutralKnowledgeWikiRootPath } from '../../src/huaanwork-host/workspace-state.ts'

describe('KnowledgeHost lifecycle, remove, rebuild, source recovery, limits, stale stat, and 1s dispose', () => {
  it('stays lazy with zero Workers when no KBs are registered and disposes immediately', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'kb-host-lazy-'))
    const host = createKnowledgeHost({ profileDir })
    await host.start()
    expect(host.isWorkersRunning()).toBe(false)
    const t0 = performance.now()
    await host.dispose()
    expect(performance.now() - t0).toBeLessThan(100)
  })

  it('enforces MAX_KNOWLEDGE_BASES = 20 limit on create', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-host-cap-'))
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir, { recursive: true })
    const host = createKnowledgeHost({ profileDir, maxKnowledgeBases: 2 })
    await host.start()
    try {
      const d1 = join(root, 'd1'); const d2 = join(root, 'd2'); const d3 = join(root, 'd3')
      mkdirSync(d1); mkdirSync(d2); mkdirSync(d3)
      await host.create({ name: 'K1', sourceDir: d1 })
      await host.create({ name: 'K2', sourceDir: d2 })
      await expect(host.create({ name: 'K3', sourceDir: d3 })).rejects.toThrow(/knowledge-base-limit-reached/u)
      expect(MAX_KNOWLEDGE_BASES).toBe(20)
    } finally {
      await host.dispose()
    }
  })

  it('remove(kbId) cancels organizer, closes DB, deletes isolated dir, invokes removal hook, rejects concurrent ops, and never modifies sourceDir bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-host-remove-'))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'docs')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    const filePath = join(sourceDir, 'policy.md')
    writeFileSync(filePath, '重要风控条款 2026')
    const hashBefore = createHash('sha256').update(readFileSync(filePath)).digest('hex')

    let releaseCancel!: () => void
    const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve })
    const cancelSpy = vi.fn(async () => { await cancelGate })
    const removedHook = vi.fn(async () => {})
    const host = createKnowledgeHost({ profileDir })
    host.setOrganizerHooks({ cancelForKb: cancelSpy, cancelAll: async () => {} })
    host.setRemovalHook(removedHook)
    await host.start()

    try {
      const created = await host.create({ name: '风控', sourceDir })
      await host.sync(created.id)
      const kbRoot = neutralKnowledgeRootPath(profileDir, created.id)
      expect(existsSync(join(kbRoot, 'index.sqlite'))).toBe(true)

      const removing = host.remove(created.id)
      // 控制器裁决 M-20：确定性等到停机序列已拿到删库门闩（整理取消被调用）再断言互斥。
      await vi.waitFor(() => { expect(cancelSpy).toHaveBeenCalledWith(created.id) })
      await expect(host.sync(created.id)).rejects.toThrow(/knowledge-base-(?:deleting|busy)/u)
      await expect(host.rebuild(created.id)).rejects.toThrow(/knowledge-base-(?:deleting|busy)/u)
      await expect(host.update(created.id, { name: '改名' })).rejects.toThrow(/knowledge-base-(?:deleting|busy)/u)
      releaseCancel()
      await removing

      expect(cancelSpy).toHaveBeenCalledWith(created.id)
      expect(removedHook).toHaveBeenCalledWith(created.id)
      expect(existsSync(kbRoot)).toBe(false)
      expect((await host.list()).some(k => k.id === created.id)).toBe(false)
      expect(createHash('sha256').update(readFileSync(filePath)).digest('hex')).toBe(hashBefore)
    } finally {
      await host.dispose()
    }
  })

  it('host.rebuild() executes normal rebuild, corrupt-DB rebuild with wiki reset, concurrent busy guard, and fault recovery branches (R3-I2)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-host-rebuild-'))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'docs')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'keep.md'), '保留文档内容')
    writeFileSync(join(sourceDir, 'gone.md'), '即将删除文档')

    let releaseCancel!: () => void
    let holdCancel = false
    const cancelSpy = vi.fn(async () => {
      if (holdCancel) await new Promise<void>(resolve => { releaseCancel = resolve })
    })
    const host = createKnowledgeHost({ profileDir })
    host.setOrganizerHooks({ cancelForKb: cancelSpy, cancelAll: async () => {} })
    await host.start()

    try {
      const kb = await host.create({ name: '重建库', sourceDir })
      await host.update(kb.id, { watchPaused: true })
      await host.sync(kb.id)
      const initialDocs = (await host.listDocs(kb.id)).docs
      const keepId = initialDocs.find(d => d.relPath === 'keep.md')!.docId

      const wikiDir = neutralKnowledgeWikiRootPath(profileDir, kb.id)
      mkdirSync(join(wikiDir, 'docs'), { recursive: true })
      writeFileSync(join(wikiDir, 'docs', `${keepId}.md`), '# Keep 卡片')
      rmSync(join(sourceDir, 'gone.md'))

      // 1. Normal rebuild: rejects concurrent sync/rebuild/update(sourceDir), preserves keepId & wiki card, resets organizeAttempts, writes tombstone for gone.md
      holdCancel = true
      const rebuilding = host.rebuild(kb.id)
      // 控制器裁决 M-20：先确定性等到维护门闩已持有时（整理取消被调用）再断言忙碌拒绝。
      await vi.waitFor(() => { expect(cancelSpy).toHaveBeenCalledWith(kb.id) })
      await expect(host.sync(kb.id)).rejects.toThrow(/knowledge-base-busy/u)
      await expect(host.update(kb.id, { sourceDir })).rejects.toThrow(/knowledge-base-busy/u)
      holdCancel = false
      releaseCancel()
      await rebuilding

      expect(cancelSpy).toHaveBeenCalledWith(kb.id)
      const afterNormal = (await host.listDocs(kb.id)).docs
      expect(afterNormal.find(d => d.relPath === 'keep.md')).toMatchObject({ docId: keepId, organizeAttempts: 0 })
      expect(afterNormal.find(d => d.relPath === 'gone.md')).toBeUndefined()
      expect(existsSync(join(wikiDir, 'docs', `${keepId}.md`))).toBe(true)
      expect((await host.getEvents(kb.id)).some(e => e.kind === 'rebuild_completed')).toBe(true)
      // 控制器裁决 M-21：从未整理过的消失文件（无 wiki_note_path）不得写整理墓碑。
      const db = new DatabaseSync(join(neutralKnowledgeRootPath(profileDir, kb.id), 'index.sqlite'))
      try {
        expect(db.prepare('SELECT rel_path FROM organize_tombstones').all()).toEqual([])
      } finally {
        db.close()
      }

      // 2. Pre-commit rebuild failure (sourceDir missing -> refused before commit, old DB & wiki intact)
      const tempMove = `${sourceDir}-moved-aside`
      renameSync(sourceDir, tempMove)
      await expect(host.rebuild(kb.id)).rejects.toThrow(/source-unavailable/u)
      expect((await host.listDocs(kb.id)).docs.find(d => d.relPath === 'keep.md')?.docId).toBe(keepId)
      renameSync(tempMove, sourceDir)

      // 3. Corrupt DB rebuild + wiki reset EBUSY -> wiki-reset-pending -> host.sync() idempotently finishes reset
      await host.dispose()
      writeFileSync(join(neutralKnowledgeRootPath(profileDir, kb.id), 'index.sqlite'), 'CORRUPT_BYTES')

      let failWikiOnce = true
      const host2 = createKnowledgeHost({
        profileDir,
        failWikiResetOnceForTest: () => {
          if (failWikiOnce) {
            failWikiOnce = false
            throw new Error('simulated-ebusy-wiki-rename')
          }
        },
      })
      await host2.start()
      try {
        expect(host2.get(kb.id)?.phase).toBe('index-error')
        await host2.rebuild(kb.id)
        expect(host2.get(kb.id)?.phase).toBe('wiki-reset-pending')
        expect(existsSync(join(neutralKnowledgeRootPath(profileDir, kb.id), 'wiki-reset.pending'))).toBe(true)
        expect((await host2.getEvents(kb.id)).some(e => e.kind === 'wiki_reset_failed')).toBe(true)

        // Calling host2.sync() idempotently finishes pending wiki reset and recovers
        await host2.sync(kb.id)
        expect(existsSync(join(neutralKnowledgeRootPath(profileDir, kb.id), 'wiki-reset.pending'))).toBe(false)
        expect(existsSync(join(wikiDir, 'docs', `${keepId}.md`))).toBe(false)
        const afterCorrupt = (await host2.listDocs(kb.id)).docs
        expect(afterCorrupt.find(d => d.relPath === 'keep.md')?.docId).not.toBe(keepId)
      } finally {
        await host2.dispose()
      }

      // 4. Post-commit reopen failure keeps new index.sqlite (no rollback) and marks phase index-error
      const host3 = createKnowledgeHost({
        profileDir,
        afterCommitBeforeReopenForTest: () => {
          writeFileSync(join(neutralKnowledgeRootPath(profileDir, kb.id), 'index.sqlite'), 'CORRUPT_POST_COMMIT')
        },
      })
      await host3.start()
      try {
        await expect(host3.rebuild(kb.id)).rejects.toThrow(/index-error/u)
        expect(host3.get(kb.id)?.phase).toBe('index-error')
        // 控制器裁决 M-1：故障字节由 Storage Worker 自己写（VITEST 下的布尔钩子），
        // 断言导出标记而不期待测试传入的任意字节串。
        expect(readFileSync(join(neutralKnowledgeRootPath(profileDir, kb.id), 'index.sqlite'), 'utf8'))
          .toBe(KNOWLEDGE_TEST_CORRUPT_AFTER_COMMIT)
      } finally {
        await host3.dispose()
      }
    } finally {
      await host.dispose()
    }
  })

  it('sets stale on file mutation, closes Watcher & preserves DB/wiki on sourceDir loss, and emits source_restored on recovery (R3-I8)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-host-stale-'))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'docs')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    const docPath = join(sourceDir, 'rate.md')
    writeFileSync(docPath, 'C类基金税率标准条款')

    const host = createKnowledgeHost({ profileDir })
    await host.start()
    try {
      const kb = await host.create({ name: '税率', sourceDir })
      await host.sync(kb.id)
      const wikiDir = neutralKnowledgeWikiRootPath(profileDir, kb.id)
      mkdirSync(wikiDir, { recursive: true })
      writeFileSync(join(wikiDir, 'INDEX.md'), '# 索引')
      expect(host.isWatchingForTest(kb.id)).toBe(true)

      const fresh = await host.search({ kbIds: [kb.id], query: '基金税率' })
      expect(fresh[0]).toMatchObject({ stale: false, sourceUnavailable: false })
      const docId = fresh[0]!.docId
      expect(await host.getChunk({ kbId: kb.id, docId, ordinal: 0 })).toMatchObject({ status: 'ok', stale: false, sourceUnavailable: false })

      // Mutate file on disk while watchPaused -> both search and getChunk report stale: true
      await host.update(kb.id, { watchPaused: true })
      writeFileSync(docPath, 'C类基金税率标准条款——盘上已修改但未同步')
      expect((await host.search({ kbIds: [kb.id], query: '基金税率' }))[0]).toMatchObject({ stale: true, sourceUnavailable: false })
      expect(await host.getChunk({ kbId: kb.id, docId, ordinal: 0 })).toMatchObject({ status: 'ok', stale: true, sourceUnavailable: false })

      // Re-enable watch, remove sourceDir -> closes watcher, preserves index.sqlite & wiki/, logs source_unavailable
      await host.update(kb.id, { watchPaused: false })
      rmSync(sourceDir, { recursive: true, force: true })
      await host.sync(kb.id)
      expect(host.isWatchingForTest(kb.id)).toBe(false)
      expect(host.get(kb.id)?.phase).toBe('source-unavailable')
      expect(existsSync(join(neutralKnowledgeRootPath(profileDir, kb.id), 'index.sqlite'))).toBe(true)
      expect(readFileSync(join(wikiDir, 'INDEX.md'), 'utf8')).toBe('# 索引')
      expect((await host.getEvents(kb.id)).some(e => e.kind === 'source_unavailable')).toBe(true)
      expect((await host.search({ kbIds: [kb.id], query: '基金税率' }))[0]).toMatchObject({ sourceUnavailable: true })
      expect(await host.getChunk({ kbId: kb.id, docId, ordinal: 0 })).toMatchObject({ status: 'ok', sourceUnavailable: true })

      // Restore sourceDir -> sync re-attaches watcher and logs source_restored
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(docPath, 'C类基金税率标准条款')
      await host.sync(kb.id)
      expect(host.isWatchingForTest(kb.id)).toBe(true)
      expect(host.get(kb.id)?.phase).toBe('watching')
      expect((await host.getEvents(kb.id)).some(e => e.kind === 'source_restored')).toBe(true)
    } finally {
      await host.dispose()
    }
  })

  it('terminates a real CPU-stuck Extraction Worker and finishes host.dispose() within 1,000 ms (R3-B3)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-host-dispose-'))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'docs')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'stuck.md'), '触发忙等')

    const realPool = createExtractionPool({ maxWorkers: 1, timeoutMs: 60_000 })
    const host = createKnowledgeHost({ profileDir, poolOverrideForTest: realPool })
    await host.start()
    // Kick off a genuine CPU-blocking extraction inside the real Extraction Worker
    const inFlight = realPool.extractFile('kb-stuck', {
      sourceRoot: sourceDir,
      filePath: join(sourceDir, 'stuck.md'),
      relPath: 'stuck.md',
      debugBusyLoopMs: 30_000,
    })
    await vi.waitFor(() => { expect(realPool.activeWorkerCount()).toBe(1) }, { timeout: 2_000 })

    const start = performance.now()
    await host.dispose()
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(1_000)
    expect(realPool.activeWorkerCount()).toBe(0)
    await expect(inFlight).resolves.toMatchObject({ ok: false })
  })
})
