import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKnowledgeHost } from '../../src/huaanwork-host/knowledge/host.ts'
import { createExtractionPool } from '../../src/huaanwork-host/knowledge/extraction-pool.ts'
import { createKnowledgeStorageClient } from '../../src/huaanwork-host/knowledge/storage-client.ts'
import { KNOWLEDGE_TEST_CORRUPT_AFTER_COMMIT } from '../../src/huaanwork-host/knowledge/storage-protocol.ts'
import { MAX_KNOWLEDGE_BASES } from '../../src/huaanwork-host/knowledge/types.ts'
import { neutralKnowledgeRootPath, neutralKnowledgeWikiRootPath } from '../../src/huaanwork-host/workspace-state.ts'

const lifecycleTempDirs: string[] = []
function makeLifecycleTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  lifecycleTempDirs.push(dir)
  return dir
}

interface PersistedKnowledgeBase {
  readonly id: string
  readonly sourceDir: string
}

/** 读取落盘注册表（断言磁盘真值与内存成对）。 */
function readRegistryRecords(profileDir: string): PersistedKnowledgeBase[] {
  const parsed = JSON.parse(
    readFileSync(join(profileDir, 'knowledge-bases.json'), 'utf8'),
  ) as { knowledgeBases: PersistedKnowledgeBase[] }
  return parsed.knowledgeBases
}

describe('KnowledgeHost lifecycle, remove, rebuild, source recovery, limits, stale stat, and 1s dispose', () => {
  afterEach(() => {
    for (const dir of lifecycleTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
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

      // 控制器裁决 M-1：跨线程只传布尔钩子，故障由 Storage Worker 在 VITEST 下自行注入（M-6 清理误导性死闭包）。
      const host2 = createKnowledgeHost({
        profileDir,
        failWikiResetOnceForTest: () => {},
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
        afterCommitBeforeReopenForTest: () => {},
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

  it('host.update({ sourceDir }) is the single registry writer and preserves docId/wiki assets across a moved source dir', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kb-host-rebind-')))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'docs')
    const movedDir = join(root, 'docs-moved')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'policy.md'), '重绑保留内容 2026')

    const host = createKnowledgeHost({ profileDir })
    await host.start()
    try {
      const kb = await host.create({ name: '重绑库', sourceDir })
      await host.update(kb.id, { watchPaused: true })
      await host.sync(kb.id)
      const docBefore = (await host.listDocs(kb.id)).docs.find(d => d.relPath === 'policy.md')
      expect(docBefore).toBeTruthy()
      const wikiCardDir = join(neutralKnowledgeWikiRootPath(profileDir, kb.id), 'docs')
      mkdirSync(wikiCardDir, { recursive: true })
      const wikiCardPath = join(wikiCardDir, `${docBefore!.docId}.md`)
      writeFileSync(wikiCardPath, '# 保留卡片')

      renameSync(sourceDir, movedDir)
      const updated = await host.update(kb.id, { sourceDir: movedDir })

      // 内存（get/list）、返回值与磁盘注册表三方一致。
      expect(updated.sourceDir).toBe(movedDir)
      expect(host.get(kb.id)).toMatchObject({ sourceDir: movedDir })
      expect((await host.list()).find(k => k.id === kb.id)).toMatchObject({ sourceDir: movedDir })
      expect(readRegistryRecords(profileDir).find(record => record.id === kb.id)).toMatchObject({ sourceDir: movedDir })

      // doc_id 与 wiki 卡片跨目录移动保持不变。
      expect((await host.listDocs(kb.id)).docs.find(d => d.relPath === 'policy.md')?.docId)
        .toBe(docBefore!.docId)
      expect(readFileSync(wikiCardPath, 'utf8')).toBe('# 保留卡片')
      expect((await host.getEvents(kb.id)).some(e => e.kind === 'source_rebound')).toBe(true)
    } finally {
      await host.dispose()
    }
  })

  it('rejects an invalid rebind with invalid-source-dir and leaves both memory and knowledge-bases.json on the old source dir', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kb-host-rebind-invalid-')))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'docs')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'policy.md'), '校验失败零副作用')

    const host = createKnowledgeHost({ profileDir })
    await host.start()
    try {
      const kb = await host.create({ name: '零副作用库', sourceDir })
      await host.sync(kb.id)
      const beforeDocs = (await host.listDocs(kb.id)).docs

      await expect(host.update(kb.id, { sourceDir: profileDir })).rejects.toThrow(/invalid-source-dir/u)

      expect(host.get(kb.id)?.sourceDir).toBe(sourceDir)
      expect(readRegistryRecords(profileDir).find(record => record.id === kb.id)?.sourceDir).toBe(sourceDir)
      expect((await host.listDocs(kb.id)).docs).toEqual(beforeDocs)
      expect((await host.getEvents(kb.id)).some(e => e.kind === 'source_rebound')).toBe(false)
    } finally {
      await host.dispose()
    }
  })

  it('keeps the new sourceDir on disk and in memory when post-persist convergence fails (never reverts)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kb-host-rebind-converge-')))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'docs')
    const movedDir = join(root, 'docs-moved')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'policy.md'), '收敛失败前内容')

    const realPool = createExtractionPool({ maxWorkers: 1 })
    const realExtract = realPool.extractFile.bind(realPool)
    let failConverge = false
    const extractSpy = vi.spyOn(realPool, 'extractFile').mockImplementation(async (kbId, req, signal) => {
      if (failConverge && req.relPath === 'policy.md') throw new Error('simulated-convergence-failure')
      return realExtract(kbId, req, signal)
    })
    const host = createKnowledgeHost({ profileDir, poolOverrideForTest: realPool })
    await host.start()
    try {
      const kb = await host.create({ name: '收敛失败库', sourceDir })
      await host.update(kb.id, { watchPaused: true })
      await host.sync(kb.id)
      const shaBefore = (await host.listDocs(kb.id)).docs.find(d => d.relPath === 'policy.md')?.sha256

      renameSync(sourceDir, movedDir)
      writeFileSync(join(movedDir, 'policy.md'), '收敛失败后新内容')
      const future = new Date(Date.now() + 120_000)
      utimesSync(join(movedDir, 'policy.md'), future, future)

      failConverge = true
      // 落盘已成功：收敛失败不抛错、不回滚，磁盘与内存都保持新 sourceDir。
      const updated = await host.update(kb.id, { sourceDir: movedDir })
      expect(updated.sourceDir).toBe(movedDir)
      expect(host.get(kb.id)?.sourceDir).toBe(movedDir)
      expect(readRegistryRecords(profileDir).find(record => record.id === kb.id)?.sourceDir).toBe(movedDir)
      expect((await host.getEvents(kb.id)).some(e => e.kind === 'source_rebound')).toBe(true)

      // 下一次对账基于已落盘的新目录自愈并索引新内容（下一次启动对账的等价验证）。
      failConverge = false
      await host.sync(kb.id)
      const healed = (await host.listDocs(kb.id)).docs.find(d => d.relPath === 'policy.md')
      expect(healed?.sha256).not.toBe(shaBefore)
    } finally {
      extractSpy.mockRestore()
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
    const originalTerminate = Worker.prototype.terminate
    let terminateSettled = false
    const terminateSpy = vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker) {
      return originalTerminate.call(this).then((code) => {
        terminateSettled = true
        return code
      })
    })
    const host = createKnowledgeHost({ profileDir, poolOverrideForTest: realPool })
    await host.start()
    try {
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
      // M-6：断言负责忙等线程的 terminate() Promise 在 dispose 返回前已真正落定。
      expect(terminateSettled).toBe(true)
      await expect(inFlight).resolves.toMatchObject({ ok: false })
    } finally {
      terminateSpy.mockRestore()
    }
  })

  it('defaults autoOrganize to true on create (spec §5.2/§9.3) while honouring explicit false', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-host-auto-org-'))
    const profileDir = join(root, 'profile')
    const dirDefault = join(root, 'docs-default')
    const dirExplicitFalse = join(root, 'docs-false')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(dirDefault, { recursive: true })
    mkdirSync(dirExplicitFalse, { recursive: true })

    const host = createKnowledgeHost({ profileDir })
    await host.start()
    try {
      const kbDefault = await host.create({ name: '默认开启自动整理', sourceDir: dirDefault })
      const kbFalse = await host.create({ name: '显式关闭自动整理', sourceDir: dirExplicitFalse, autoOrganize: false })
      expect(kbDefault.autoOrganize).toBe(true)
      expect(host.get(kbDefault.id)?.autoOrganize).toBe(true)
      expect(kbFalse.autoOrganize).toBe(false)
      expect(host.get(kbFalse.id)?.autoOrganize).toBe(false)
      const persisted = JSON.parse(readFileSync(join(profileDir, 'knowledge-bases.json'), 'utf8')) as {
        knowledgeBases: Array<{ id: string; autoOrganize: boolean }>
      }
      expect(persisted.knowledgeBases.find(k => k.id === kbDefault.id)?.autoOrganize).toBe(true)
      expect(persisted.knowledgeBases.find(k => k.id === kbFalse.id)?.autoOrganize).toBe(false)
    } finally {
      await host.dispose()
    }
  })

  it('preserves wiki-reset-pending across host.update({ sourceDir }) until sync completes the reset (spec §6.4)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kb-host-rebind-pending-')))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'docs')
    const movedDir = join(root, 'docs-moved')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'keep.md'), '恢复态重绑文档')

    const host = createKnowledgeHost({ profileDir })
    await host.start()
    let kbId = ''
    try {
      const kb = await host.create({ name: '恢复重绑库', sourceDir })
      kbId = kb.id
      await host.update(kbId, { watchPaused: true })
      await host.sync(kbId)
      const wikiDir = neutralKnowledgeWikiRootPath(profileDir, kbId)
      mkdirSync(wikiDir, { recursive: true })
      writeFileSync(join(wikiDir, 'INDEX.md'), '# 旧索引待重置')
    } finally {
      await host.dispose()
    }

    writeFileSync(join(neutralKnowledgeRootPath(profileDir, kbId), 'index.sqlite'), 'CORRUPT_DB_BYTES')
    const host2 = createKnowledgeHost({
      profileDir,
      failWikiResetOnceForTest: () => {},
    })
    await host2.start()
    try {
      expect(host2.get(kbId)?.phase).toBe('index-error')
      await host2.rebuild(kbId)
      expect(host2.get(kbId)?.phase).toBe('wiki-reset-pending')
      expect(existsSync(join(neutralKnowledgeRootPath(profileDir, kbId), 'wiki-reset.pending'))).toBe(true)

      renameSync(sourceDir, movedDir)
      await host2.update(kbId, { sourceDir: movedDir })
      // 重绑不得把未完成的 wiki-reset-pending 静默清成 watching / watch-paused。
      expect(host2.get(kbId)?.sourceDir).toBe(movedDir)
      expect(host2.get(kbId)?.phase).toBe('wiki-reset-pending')
      expect(existsSync(join(neutralKnowledgeRootPath(profileDir, kbId), 'wiki-reset.pending'))).toBe(true)

      await host2.sync(kbId)
      expect(existsSync(join(neutralKnowledgeRootPath(profileDir, kbId), 'wiki-reset.pending'))).toBe(false)
      expect(host2.get(kbId)?.phase).toBe('watch-paused')
    } finally {
      await host2.dispose()
    }
  })

  it('detects stale on search and getChunk without listDocs lookups even when >200 files share the target path substring', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-host-stale-200-'))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'docs')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    // 205 个按字典序排在 `a.md` 之前的同名子串文件，旧 lookupDocMeta(limit=200) 会把 `a.md` 截丢。
    for (let i = 0; i < 205; i += 1) {
      writeFileSync(join(sourceDir, `${String(i).padStart(3, '0')}-a.md`), `普通干扰文档 ${String(i)}`)
    }
    const targetPath = join(sourceDir, 'a.md')
    writeFileSync(targetPath, '唯一目标条款 华安专属密文九九八一')

    const storage = createKnowledgeStorageClient()
    const listDocsSpy = vi.spyOn(storage, 'listDocs')
    const host = createKnowledgeHost({ profileDir, storageOverrideForTest: storage })
    await host.start()
    try {
      const kb = await host.create({ name: '大库陈旧检测', sourceDir })
      await host.update(kb.id, { watchPaused: true })
      await host.sync(kb.id)
      listDocsSpy.mockClear()

      const freshHits = await host.search({ kbIds: [kb.id], query: '华安专属密文九九八一' })
      expect(freshHits).toHaveLength(1)
      expect(freshHits[0]).toMatchObject({ relPath: 'a.md', stale: false, sourceUnavailable: false })
      const docId = freshHits[0]!.docId

      writeFileSync(targetPath, '唯一目标条款 华安专属密文九九八一——盘上已修改')
      const staleHits = await host.search({ kbIds: [kb.id], query: '华安专属密文九九八一' })
      expect(staleHits[0]).toMatchObject({ relPath: 'a.md', stale: true, sourceUnavailable: false })

      const chunk = await host.getChunk({ kbId: kb.id, docId, ordinal: 0 })
      expect(chunk).toMatchObject({ status: 'ok', relPath: 'a.md', stale: true, sourceUnavailable: false })
      // 不得把内部 size/mtimeMs 字段透出到公开 GetChunkResult。
      expect('size' in chunk).toBe(false)
      expect('mtimeMs' in chunk).toBe(false)
      // search 与 getChunk 均不再额外调用 storage.listDocs。
      expect(listDocsSpy).not.toHaveBeenCalled()
    } finally {
      listDocsSpy.mockRestore()
      await host.dispose()
    }
  })

  it('handles combined { sourceDir, watchPaused: true } without restarting watcher and rolls back in-memory update on persist failure', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kb-host-update-rollback-')))
    const profileDir = join(root, 'profile')
    const sourceDir = join(root, 'docs')
    const movedDir = join(root, 'docs-moved')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'doc.md'), '组合更新与回滚验证')

    const host = createKnowledgeHost({ profileDir })
    await host.start()
    try {
      const kb = await host.create({ name: '原名称', sourceDir })
      await host.sync(kb.id)
      expect(host.isWatchingForTest(kb.id)).toBe(true)

      // 非重绑 update 落盘失败时必须回滚内存记录与监听状态（POSIX 非 root 可确定性复现）。
      if (process.platform !== 'win32' && process.getuid?.() !== 0) {
        chmodSync(profileDir, 0o500)
        try {
          await expect(host.update(kb.id, { name: '失败名称', watchPaused: true })).rejects.toThrow()
        } finally {
          chmodSync(profileDir, 0o700)
        }
        expect(host.get(kb.id)).toMatchObject({ name: '原名称', watchPaused: false })
        expect(host.isWatchingForTest(kb.id)).toBe(true)
      }

      // 同时重绑 sourceDir 与 watchPaused: true：单次原子落盘且重绑后不重启监听。
      renameSync(sourceDir, movedDir)
      const updated = await host.update(kb.id, { sourceDir: movedDir, watchPaused: true })
      expect(updated).toMatchObject({ sourceDir: movedDir, watchPaused: true })
      expect(host.isWatchingForTest(kb.id)).toBe(false)
      expect(host.get(kb.id)?.phase).toBe('watch-paused')
      expect(readRegistryRecords(profileDir).find(r => r.id === kb.id)).toMatchObject({ sourceDir: movedDir })
    } finally {
      await host.dispose()
    }
  })

  it('persists canonical realSourceDir so overlap checks survive symlink removal (I-6) and rolls back remove() record on registry persist failure (I-10)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kb-host-i6-i10-')))
    const profileDir = join(root, 'profile')
    const realDocs = join(root, 'real-docs')
    const nestedDocs = join(realDocs, 'nested')
    const linkDocs = join(root, 'link-docs')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(nestedDocs, { recursive: true })
    symlinkSync(realDocs, linkDocs, process.platform === 'win32' ? 'junction' : 'dir')

    const host = createKnowledgeHost({ profileDir })
    await host.start()
    try {
      const kb = await host.create({ name: '符号链接库', sourceDir: linkDocs })
      // I-6：注册表持久化规范化 realSourceDir，删除原符号链接后子目录仍被判重叠拒绝。
      expect(kb.sourceDir).toBe(realDocs)
      expect(readRegistryRecords(profileDir).find(r => r.id === kb.id)?.sourceDir).toBe(realDocs)
      rmSync(linkDocs, { force: true })
      await expect(host.create({ name: '嵌套子目录库', sourceDir: nestedDocs })).rejects.toThrow(/invalid-source-dir/u)

      // I-10：remove() 删目录后写注册表失败时，内存记录必须回滚以支持幂等重试。
      if (process.platform !== 'win32' && process.getuid?.() !== 0) {
        chmodSync(profileDir, 0o500)
        try {
          await expect(host.remove(kb.id)).rejects.toThrow()
        } finally {
          chmodSync(profileDir, 0o700)
        }
        expect(host.get(kb.id)?.id).toBe(kb.id)
        // 权限恢复后再次调用 remove() 幂等成功，不再报 knowledge-base-not-found。
        await host.remove(kb.id)
        expect(host.get(kb.id)).toBeUndefined()
        expect(readRegistryRecords(profileDir).some(r => r.id === kb.id)).toBe(false)
      }
    } finally {
      await host.dispose()
    }
  })

  it('guards start()/create()/dispose() races (I-1), serializes concurrent create + update(sourceDir) overlap (I-5), and fixes multi-KB search / chmod-000 sourceUnavailable / non-blocking resumeWatch (I-9)', async () => {
    const root = realpathSync(makeLifecycleTempDir('kb-host-i1-i5-i9-'))
    const profileDir = join(root, 'profile')
    const dirA = join(root, 'docs-a')
    const dirB = join(root, 'docs-b')
    const parentOverlap = join(root, 'overlap-parent')
    const childOverlap = join(parentOverlap, 'child')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    mkdirSync(childOverlap, { recursive: true })
    writeFileSync(join(dirA, 'a.md'), '健康库内容 唯一词条')
    writeFileSync(join(dirB, 'b.md'), '另一库内容')

    const storage = createKnowledgeStorageClient()
    const host = createKnowledgeHost({ profileDir, storageOverrideForTest: storage })
    try {
      // I-1：并发 start() 与 create() 绝不覆盖新创建的记录。
      const [_, kbA] = await Promise.all([
        host.start(),
        host.create({ name: '库A', sourceDir: dirA }),
      ])
      expect(host.get(kbA.id)?.id).toBe(kbA.id)
      const kbB = await host.create({ name: '库B', sourceDir: dirB })
      await host.update(kbA.id, { watchPaused: true })
      await host.update(kbB.id, { watchPaused: true })
      await host.sync(kbA.id)
      await host.sync(kbB.id)

      // I-5：并发 create(childOverlap) 与 update(kbB, { sourceDir: parentOverlap }) 经共享 bindingChain 串行，
      // 最多只有一方成功，磁盘上绝不会落盘父子重叠源目录。
      const raceResults = await Promise.allSettled([
        host.update(kbB.id, { sourceDir: parentOverlap }),
        host.create({ name: '子目录库', sourceDir: childOverlap }),
      ])
      const fulfilledCount = raceResults.filter(r => r.status === 'fulfilled').length
      expect(fulfilledCount).toBe(1)
      const persistedAfterRace = readRegistryRecords(profileDir)
      const hasParent = persistedAfterRace.some(r => r.sourceDir === parentOverlap)
      const hasChild = persistedAfterRace.some(r => r.sourceDir === childOverlap)
      expect(hasParent && hasChild).toBe(false)

      // I-9：多库检索「健康库 0 命中 + 另一库报错」返回 [] 而不是抛错，且去重重复 kbIds。
      const searchSpy = vi.spyOn(storage, 'searchFts').mockImplementation(async (kbId, kbName, q, limit) => {
        if (kbId === kbB.id) throw new Error('index-error: simulated broken kb')
        return await Object.getPrototypeOf(storage)?.searchFts?.call(storage, kbId, kbName, q, limit)
          ?? []
      })
      try {
        const res = await host.search({ kbIds: [kbA.id, kbA.id, kbB.id], query: '完全不命中的关键词' })
        expect(res).toEqual([])
        // kbA 去重后只查询了一次。
        expect(searchSpy.mock.calls.filter(call => call[0] === kbA.id)).toHaveLength(1)
      } finally {
        searchSpy.mockRestore()
      }

      // I-9：onSystemResume 委托给引擎，handleSystemResume 触发一次且返回有效取消函数。
      const resumeSpy = vi.fn()
      const unsub = host.onSystemResume(resumeSpy)
      await host.handleSystemResume()
      expect(resumeSpy).toHaveBeenCalledTimes(1)
      unsub()
      await host.handleSystemResume()
      expect(resumeSpy).toHaveBeenCalledTimes(1)

      // I-9：update({ watchPaused: false }) 先持久化 watchPaused: false 再异步后台对账，立即释放维护状态。
      const resumed = await host.update(kbA.id, { watchPaused: false })
      expect(resumed.watchPaused).toBe(false)
      expect(readRegistryRecords(profileDir).find(r => r.id === kbA.id)).toBeDefined()

      // I-9：chmod 000 不可读源目录时，search 与 getChunk 报 sourceUnavailable: true, stale: false。
      if (process.platform !== 'win32' && process.getuid?.() !== 0) {
        const hitBefore = await host.search({ kbIds: [kbA.id], query: '健康库内容' })
        expect(hitBefore).toHaveLength(1)
        chmodSync(dirA, 0o000)
        try {
          const hitNoPerm = await host.search({ kbIds: [kbA.id], query: '健康库内容' })
          expect(hitNoPerm[0]).toMatchObject({ sourceUnavailable: true, stale: false })
          const chunkNoPerm = await host.getChunk({ kbId: kbA.id, docId: hitBefore[0]!.docId, ordinal: 0 })
          expect(chunkNoPerm).toMatchObject({ status: 'ok', sourceUnavailable: true, stale: false })
        } finally {
          chmodSync(dirA, 0o700)
        }
      }

      // I-1：create() 在 startKb 失败回滚时，不残留僵尸 runtime / 目录。
      const openSpy = vi.spyOn(storage, 'openKb').mockRejectedValueOnce(new Error('simulated-open-crash'))
      const dirFail = join(root, 'docs-fail')
      mkdirSync(dirFail, { recursive: true })
      try {
        await expect(host.create({ name: '失败库', sourceDir: dirFail })).rejects.toThrow(/simulated-open-crash/u)
      } finally {
        openSpy.mockRestore()
      }
      expect((await host.list()).some(k => k.name === '失败库')).toBe(false)

      // I-1：dispose() 之后所有写操作显式报 knowledge-base-busy。
      await host.dispose()
      await expect(host.create({ name: '退场后', sourceDir: dirFail })).rejects.toThrow(/knowledge-base-busy/u)
      await expect(host.update(kbA.id, { name: '退场后' })).rejects.toThrow(/knowledge-base-busy/u)
      await expect(host.remove(kbA.id)).rejects.toThrow(/knowledge-base-busy/u)
      await expect(host.sync(kbA.id)).rejects.toThrow(/knowledge-base-busy/u)
      await expect(host.rebuild(kbA.id)).rejects.toThrow(/knowledge-base-busy/u)
    } finally {
      await host.dispose()
    }
  })
})
