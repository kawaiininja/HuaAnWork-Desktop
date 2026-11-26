import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  abortRebuildStaging,
  beginRebuildStaging,
  commitRebuildStaging,
  deleteDocument,
  getChunkWithWindow,
  getDocChunks,
  getPendingOrganizeBatch,
  getStats,
  listDocs,
  markOrganizedAtomic,
  openCommittedKnowledgeDb,
  openKnowledgeDb,
  recordOrganizeFailure,
  recoverKnowledgeDbDir,
  renameDocument,
  retryPendingWikiReset,
  searchFts,
  upsertDocumentWithChunks,
} from '../../src/huaanwork-host/knowledge/storage-db.ts'
import { createKnowledgeStorageClient } from '../../src/huaanwork-host/knowledge/storage-client.ts'
import { tokenizeForFts } from '../../src/huaanwork-host/knowledge/tokenizer.ts'

const storageTempDirs: string[] = []
function makeStorageTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  storageTempDirs.push(dir)
  return dir
}

function sampleChunk(ordinal: number, content: string) {
  return {
    ordinal,
    headingPath: '第一章',
    locator: { kind: 'line' as const, startLine: ordinal + 1, endLine: ordinal + 2 },
    content,
    tokenized: tokenizeForFts(content),
    charCount: content.length,
  }
}

describe('knowledge SQLite storage, rebuild commit-point, and Storage Worker', () => {
  afterEach(() => {
    for (const dir of storageTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  it('preserves UUID doc_id across reindex & rename, avoids FTS5 zombie rows, supports non-unique norm_path, and enforces chunk cap', () => {
    const kbDir = mkdtempSync(join(tmpdir(), 'kb-db-'))
    const opened = openKnowledgeDb(kbDir)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const { db } = opened

    const first = upsertDocumentWithChunks(db, {
      relPath: 'Readme.md',
      normPath: 'readme.md',
      sha256: 'sha-v1',
      size: 100,
      mtimeMs: 1000,
      format: 'md',
      extractMode: 'text',
      extractConfigHash: 'cfg-1',
      status: 'indexed',
      chunks: [sampleChunk(0, '旧内容 赎回费率')],
    })
    expect(first.docId).toMatch(/^[0-9a-f-]{36}$/u)

    // Reindex same relPath keeps doc_id and removes old FTS tokens
    const second = upsertDocumentWithChunks(db, {
      relPath: 'Readme.md',
      normPath: 'readme.md',
      sha256: 'sha-v2',
      size: 120,
      mtimeMs: 2000,
      format: 'md',
      extractMode: 'text',
      extractConfigHash: 'cfg-1',
      status: 'indexed',
      chunks: [sampleChunk(0, '新内容 基金税率')],
    })
    expect(second.docId).toBe(first.docId)
    expect(searchFts(db, { kbId: 'k1', kbName: 'K1', query: '赎回费率' })).toHaveLength(0)
    expect(searchFts(db, { kbId: 'k1', kbName: 'K1', query: '税' })).toHaveLength(1)

    // Case-sensitive volume: two files sharing norm_path coexist (no UNIQUE on norm_path)
    const sibling = upsertDocumentWithChunks(db, {
      relPath: 'README.md',
      normPath: 'readme.md',
      sha256: 'sha-upper',
      size: 80,
      mtimeMs: 2500,
      format: 'md',
      extractMode: 'text',
      extractConfigHash: 'cfg-1',
      status: 'indexed',
      chunks: [sampleChunk(0, '大写文件')],
    })
    expect(sibling.docId).not.toBe(first.docId)

    // 1-to-1 rename updates rel_path + FTS path without changing doc_id
    renameDocument(db, { fromRelPath: 'Readme.md', toRelPath: '合规指引.md', toNormPath: '合规指引.md' })
    expect(searchFts(db, { kbId: 'k1', kbName: 'K1', query: '合规指引' })).toHaveLength(1)

    // Version fingerprint check on getChunkWithWindow
    expect(getChunkWithWindow(db, { docId: first.docId, ordinal: 0, window: 1, expectedSha256: 'sha-v2', expectedExtractConfigHash: 'cfg-1' }).status).toBe('ok')
    expect(getChunkWithWindow(db, { docId: first.docId, ordinal: 0, window: 1, expectedSha256: 'sha-v1', expectedExtractConfigHash: 'cfg-1' }).status).toBe('version-mismatch')
    expect(getChunkWithWindow(db, { docId: first.docId, ordinal: 0, window: 1, expectedSha256: 'sha-v2', expectedExtractConfigHash: 'cfg-2' }).status).toBe('version-mismatch')

    // Single-KB chunk cap (injectable small limit)
    const overCap = upsertDocumentWithChunks(db, {
      relPath: 'big.md',
      normPath: 'big.md',
      sha256: 'sha-big',
      size: 500,
      mtimeMs: 3000,
      format: 'md',
      extractMode: 'text',
      extractConfigHash: 'cfg-1',
      status: 'indexed',
      chunks: [sampleChunk(0, 'a'), sampleChunk(1, 'b'), sampleChunk(2, 'c')],
    }, { maxChunksPerKb: 3 })
    expect(overCap.chunkCapExceeded).toBe(true)

    // Delete doc with wiki_note_path writes organize_tombstones and clears chunks_fts
    markOrganizedAtomic(db, { docId: first.docId, sha256: 'sha-v2', wikiNotePath: `docs/${first.docId}.md` })
    deleteDocument(db, '合规指引.md')
    expect(searchFts(db, { kbId: 'k1', kbName: 'K1', query: '基金税率' })).toHaveLength(0)
    const tombs = db.prepare('SELECT doc_id, wiki_note_path FROM organize_tombstones').all() as Array<{ doc_id: string; wiki_note_path: string | null }>
    expect(tombs).toEqual([{ doc_id: first.docId, wiki_note_path: `docs/${first.docId}.md` }])
    db.close()
  })

  it('defaults listDocs to 50 rows and clamps limit above 200', () => {
    const kbDir = mkdtempSync(join(tmpdir(), 'kb-list-'))
    const opened = openKnowledgeDb(kbDir)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    for (let index = 0; index < 230; index += 1) {
      upsertDocumentWithChunks(opened.db, {
        relPath: `file-${String(index)}.md`,
        normPath: `file-${String(index)}.md`,
        sha256: `h-${String(index)}`,
        size: 1,
        mtimeMs: index,
        format: 'md',
        extractMode: 'text',
        extractConfigHash: 'c1',
        status: 'indexed',
        chunks: [sampleChunk(0, `doc ${String(index)}`)],
      })
    }
    expect(listDocs(opened.db).docs).toHaveLength(50)
    expect(listDocs(opened.db).total).toBe(230)
    expect(listDocs(opened.db, { limit: 500 }).docs).toHaveLength(200)
    expect(listDocs(opened.db, { limit: 10, offset: 225 }).docs).toHaveLength(5)
    opened.db.close()
  })

  it('normal rebuild preserves organized_sha256 only when wiki/docs/<docId>.md is a valid non-empty regular file', () => {
    const kbDir = mkdtempSync(join(tmpdir(), 'kb-rebuild-normal-'))
    mkdirSync(join(kbDir, 'wiki', 'docs'), { recursive: true })
    const opened = openKnowledgeDb(kbDir)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return

    const dKeep = upsertDocumentWithChunks(opened.db, {
      relPath: 'keep.md', normPath: 'keep.md', sha256: 'h-keep', size: 10, mtimeMs: 1,
      format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, 'keep')],
    })
    const dMissingWiki = upsertDocumentWithChunks(opened.db, {
      relPath: 'missing.md', normPath: 'missing.md', sha256: 'h-miss', size: 10, mtimeMs: 1,
      format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, 'miss')],
    })
    const dSymlinkWiki = upsertDocumentWithChunks(opened.db, {
      relPath: 'sym.md', normPath: 'sym.md', sha256: 'h-sym', size: 10, mtimeMs: 1,
      format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, 'sym')],
    })
    markOrganizedAtomic(opened.db, { docId: dKeep.docId, sha256: 'h-keep', wikiNotePath: `docs/${dKeep.docId}.md` })
    markOrganizedAtomic(opened.db, { docId: dMissingWiki.docId, sha256: 'h-miss', wikiNotePath: `docs/${dMissingWiki.docId}.md` })
    markOrganizedAtomic(opened.db, { docId: dSymlinkWiki.docId, sha256: 'h-sym', wikiNotePath: `docs/${dSymlinkWiki.docId}.md` })

    writeFileSync(join(kbDir, 'wiki', 'docs', `${dKeep.docId}.md`), '# valid card')
    // dMissingWiki file intentionally omitted; dSymlinkWiki is a symlink
    symlinkSync(join(kbDir, 'wiki', 'docs', `${dKeep.docId}.md`), join(kbDir, 'wiki', 'docs', `${dSymlinkWiki.docId}.md`))
    opened.db.close()

    const staging = beginRebuildStaging(kbDir)
    expect(staging.corruptRecovery).toBe(false)
    staging.upsert({ relPath: 'keep.md', normPath: 'keep.md', sha256: 'h-keep', size: 10, mtimeMs: 2, format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, 'keep')] })
    staging.upsert({ relPath: 'missing.md', normPath: 'missing.md', sha256: 'h-miss', size: 10, mtimeMs: 2, format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, 'miss')] })
    staging.upsert({ relPath: 'sym.md', normPath: 'sym.md', sha256: 'h-sym', size: 10, mtimeMs: 2, format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, 'sym')] })
    const committed = commitRebuildStaging(kbDir, staging)
    expect(committed.ok).toBe(true)

    const reopened = openKnowledgeDb(kbDir)
    expect(reopened.ok).toBe(true)
    if (!reopened.ok) return
    const rows = reopened.db.prepare('SELECT rel_path, doc_id, organized_sha256 FROM documents ORDER BY rel_path').all() as Array<{ rel_path: string; doc_id: string; organized_sha256: string | null }>
    expect(rows).toEqual([
      { rel_path: 'keep.md', doc_id: dKeep.docId, organized_sha256: 'h-keep' },
      { rel_path: 'missing.md', doc_id: dMissingWiki.docId, organized_sha256: null },
      { rel_path: 'sym.md', doc_id: dSymlinkWiki.docId, organized_sha256: null },
    ])
    reopened.db.close()
  })

  it('degrades corrupt DB to index-error on boot and handles Step 1 / Step 2 / wiki-reset.pending crash recovery', () => {
    // 1. Corrupt DB returns index-error without crashing
    const corruptDir = mkdtempSync(join(tmpdir(), 'kb-corrupt-'))
    writeFileSync(join(corruptDir, 'index.sqlite'), 'NOT A SQLITE DATABASE')
    expect(openKnowledgeDb(corruptDir)).toMatchObject({ ok: false, code: 'index-error' })

    // 2. Step 1 crash recovery (index.sqlite missing + .bak + uncheckpointed .bak-wal + .rebuild + wiki-reset.pending present)
    const step1Dir = mkdtempSync(join(tmpdir(), 'kb-step1-'))
    mkdirSync(join(step1Dir, 'wiki'), { recursive: true })
    writeFileSync(join(step1Dir, 'wiki', 'INDEX.md'), '# old wiki')
    const init1 = openKnowledgeDb(step1Dir)
    expect(init1.ok).toBe(true)
    if (init1.ok) {
      // Disable autocheckpoint so the inserted row lives in index.sqlite-wal before simulated crash
      init1.db.exec('PRAGMA wal_autocheckpoint = 0')
      upsertDocumentWithChunks(init1.db, {
        relPath: 'old.md', normPath: 'old.md', sha256: 'h-old', size: 1, mtimeMs: 1,
        format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, '旧数据 WAL')],
      })
      // Snapshot index.sqlite + index.sqlite-wal into .bak / .bak-wal before closing truncates WAL
      writeFileSync(join(step1Dir, 'index.sqlite.bak'), readFileSync(join(step1Dir, 'index.sqlite')))
      expect(existsSync(join(step1Dir, 'index.sqlite-wal'))).toBe(true)
      writeFileSync(join(step1Dir, 'index.sqlite.bak-wal'), readFileSync(join(step1Dir, 'index.sqlite-wal')))
      init1.db.close()
      rmSync(join(step1Dir, 'index.sqlite'), { force: true })
      rmSync(join(step1Dir, 'index.sqlite-wal'), { force: true })
      rmSync(join(step1Dir, 'index.sqlite-shm'), { force: true })
    }
    writeFileSync(join(step1Dir, 'index.sqlite.rebuild'), 'partial-rebuild')
    writeFileSync(join(step1Dir, 'wiki-reset.pending'), '{}')
    const recovered1 = openKnowledgeDb(step1Dir)
    expect(recovered1.ok).toBe(true)
    if (recovered1.ok) {
      expect(searchFts(recovered1.db, { kbId: 'k', kbName: 'K', query: '旧数据' })).toHaveLength(1)
      expect(existsSync(join(step1Dir, 'index.sqlite.rebuild'))).toBe(false)
      expect(existsSync(join(step1Dir, 'index.sqlite.bak-wal'))).toBe(false)
      expect(existsSync(join(step1Dir, 'wiki-reset.pending'))).toBe(false)
      expect(readFileSync(join(step1Dir, 'wiki', 'INDEX.md'), 'utf8')).toBe('# old wiki')
      recovered1.db.close()
    }

    // 3. Step 2 post-commit crash recovery (index.sqlite present + .rebuild absent + .bak + wiki-reset.pending present)
    const step2Dir = mkdtempSync(join(tmpdir(), 'kb-step2-'))
    mkdirSync(join(step2Dir, 'wiki'), { recursive: true })
    writeFileSync(join(step2Dir, 'wiki', 'INDEX.md'), '# stale wiki')
    const init2 = openKnowledgeDb(step2Dir)
    expect(init2.ok).toBe(true)
    if (init2.ok) init2.db.close()
    writeFileSync(join(step2Dir, 'index.sqlite.bak'), 'old-bak')
    writeFileSync(join(step2Dir, 'wiki-reset.pending'), '{}')
    const recovered2 = openKnowledgeDb(step2Dir)
    expect(recovered2.ok).toBe(true)
    if (recovered2.ok) {
      expect(existsSync(join(step2Dir, 'index.sqlite.bak'))).toBe(false)
      expect(existsSync(join(step2Dir, 'wiki-reset.pending'))).toBe(false)
      expect(existsSync(join(step2Dir, 'wiki', 'INDEX.md'))).toBe(false)
      expect(existsSync(join(step2Dir, 'wiki.stale'))).toBe(false)
      recovered2.db.close()
    }

    // 4. Post-commit reopen failure keeps new index.sqlite (NEVER rolls back to .bak) and returns index-error
    const reopenFailDir = mkdtempSync(join(tmpdir(), 'kb-reopen-fail-'))
    const initReopen = openKnowledgeDb(reopenFailDir)
    expect(initReopen.ok).toBe(true)
    if (initReopen.ok) {
      upsertDocumentWithChunks(initReopen.db, {
        relPath: 'v1.md', normPath: 'v1.md', sha256: 'h-v1', size: 1, mtimeMs: 1,
        format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, '旧版本')],
      })
      initReopen.db.close()
    }
    const stagingFail = beginRebuildStaging(reopenFailDir)
    stagingFail.upsert({
      relPath: 'v2.md', normPath: 'v2.md', sha256: 'h-v2', size: 1, mtimeMs: 2,
      format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, '新版本')],
    })
    const commitFailRes = commitRebuildStaging(reopenFailDir, stagingFail, {
      afterCommitBeforeReopenForTest: () => {
        // Corrupt the newly committed index.sqlite after Step 2 to force reopen failure
        writeFileSync(join(reopenFailDir, 'index.sqlite'), 'CORRUPT_AFTER_COMMIT')
      },
    })
    expect(commitFailRes).toMatchObject({ ok: false, code: 'index-error' })
    expect(readFileSync(join(reopenFailDir, 'index.sqlite'), 'utf8')).toBe('CORRUPT_AFTER_COMMIT')

    // 5. retryPendingWikiReset idempotently recovers when previous rename failed
    const retryDir = mkdtempSync(join(tmpdir(), 'kb-wiki-retry-'))
    mkdirSync(join(retryDir, 'wiki'), { recursive: true })
    writeFileSync(join(retryDir, 'wiki', 'INDEX.md'), '# mismatched')
    writeFileSync(join(retryDir, 'wiki-reset.pending'), '{}')
    expect(retryPendingWikiReset(retryDir)).toEqual({ ok: true })
    expect(existsSync(join(retryDir, 'wiki-reset.pending'))).toBe(false)
    expect(existsSync(join(retryDir, 'wiki', 'INDEX.md'))).toBe(false)
  })

  it('runs Storage Worker over worker_threads lazily and disposes cleanly within 900 ms', async () => {
    const client = createKnowledgeStorageClient()
    expect(client.isRunning()).toBe(false)
    const kbDir = mkdtempSync(join(tmpdir(), 'kb-worker-'))
    const opened = await client.openKb('kb-1', kbDir)
    expect(opened.ok).toBe(true)
    expect(client.isRunning()).toBe(true)
    await client.closeKb('kb-1')
    const t0 = performance.now()
    await client.dispose(900)
    expect(performance.now() - t0).toBeLessThan(900)
    rmSync(kbDir, { recursive: true, force: true })
  })

  it('honours the VITEST commit-point fault hooks across the Worker boundary', async () => {
    const client = createKnowledgeStorageClient()
    const document = (relPath: string, sha256: string, content: string) => ({
      relPath,
      normPath: relPath,
      sha256,
      size: content.length,
      mtimeMs: 1,
      format: 'md',
      extractMode: 'text' as const,
      extractConfigHash: 'cfg-1',
      status: 'indexed' as const,
      chunks: [sampleChunk(0, content)],
    })

    // 1. Step 2 之后故意损坏新库 → 提交返回 index-error，且绝不回滚旧库。
    const liveDir = mkdtempSync(join(tmpdir(), 'kb-worker-commit-'))
    expect((await client.openKb('kb-commit', liveDir)).ok).toBe(true)
    await client.upsertDocument('kb-commit', document('a.md', 'sha-a1', '第一版内容'))
    expect(await client.beginRebuild('kb-commit', liveDir)).toEqual({ corruptRecovery: false })
    await client.upsertRebuildDocument('kb-commit', document('a.md', 'sha-a2', '第二版内容'))
    const failed = await client.commitRebuild('kb-commit', liveDir, { afterCommitBeforeReopenForTest: () => {} })
    expect(failed).toMatchObject({ ok: false, code: 'index-error' })
    expect(readFileSync(join(liveDir, 'index.sqlite'), 'utf8')).toBe('knowledge-test-corrupt-post-commit')
    await client.dispose(900)
    rmSync(liveDir, { recursive: true, force: true })

    // 2. 损坏恢复重建：pending 在提交前落盘；Wiki 重置失败一次 → wikiResetPending，
    //    再经 retryPendingWikiReset 幂等收尾。
    const corruptClient = createKnowledgeStorageClient()
    const corruptDir = mkdtempSync(join(tmpdir(), 'kb-worker-corrupt-'))
    writeFileSync(join(corruptDir, 'index.sqlite'), 'NOT A SQLITE DATABASE')
    expect(await corruptClient.openKb('kb-corrupt', corruptDir)).toMatchObject({ ok: false, code: 'index-error' })
    expect(await corruptClient.beginRebuild('kb-corrupt', corruptDir)).toEqual({ corruptRecovery: true })
    expect(existsSync(join(corruptDir, 'wiki-reset.pending'))).toBe(true)
    await corruptClient.upsertRebuildDocument('kb-corrupt', document('b.md', 'sha-b', '损坏后重建'))
    const committed = await corruptClient.commitRebuild('kb-corrupt', corruptDir, { failWikiResetOnceForTest: () => {} })
    expect(committed).toEqual({ ok: true, corruptRecovery: true, wikiResetPending: true })
    expect(existsSync(join(corruptDir, 'wiki-reset.pending'))).toBe(true)
    expect(await corruptClient.retryPendingWikiReset('kb-corrupt', corruptDir)).toEqual({ ok: true })
    expect(existsSync(join(corruptDir, 'wiki-reset.pending'))).toBe(false)
    await corruptClient.dispose(900)
    expect(corruptClient.isRunning()).toBe(false)
    rmSync(corruptDir, { recursive: true, force: true })
  })

  it('reopens the rolled-back old DB and reports rebuild-failed when the commit fails before Step 2', async () => {
    const client = createKnowledgeStorageClient()
    const document = (relPath: string, sha256: string, content: string) => ({
      relPath,
      normPath: relPath,
      sha256,
      size: content.length,
      mtimeMs: 1,
      format: 'md',
      extractMode: 'text' as const,
      extractConfigHash: 'cfg-1',
      status: 'indexed' as const,
      chunks: [sampleChunk(0, content)],
    })
    const kbDir = mkdtempSync(join(tmpdir(), 'kb-worker-precommit-'))
    expect((await client.openKb('kb-precommit', kbDir)).ok).toBe(true)
    await client.upsertDocument('kb-precommit', document('old.md', 'sha-old', '旧版内容 赎回费率'))
    expect(await client.beginRebuild('kb-precommit', kbDir)).toEqual({ corruptRecovery: false })
    await client.upsertRebuildDocument('kb-precommit', document('old.md', 'sha-new', '新版内容 基金税率'))

    // Step 1 已移动旧库，Step 2 提交点之前抛出 → 回滚并返回 rebuild-failed。
    const failed = await client.commitRebuild('kb-precommit', kbDir, { failBeforeCommitPointForTest: () => {} })
    expect(failed).toMatchObject({ ok: false, code: 'rebuild-failed' })

    // 回滚后的旧库必须被 Worker 重新注册：读取继续可用且看到旧数据（而不是
    // 后续每次操作都失败 `knowledge base … is not open`）。
    const listed = await client.listDocs('kb-precommit')
    expect(listed.docs.map(doc => doc.relPath)).toEqual(['old.md'])
    expect(await client.searchFts('kb-precommit', 'kb-precommit', '赎回费率')).toHaveLength(1)
    expect(await client.searchFts('kb-precommit', 'kb-precommit', '基金税率')).toHaveLength(0)
    // 连接确实可写：回滚后继续同步新文档。
    await client.upsertDocument('kb-precommit', document('later.md', 'sha-later', '回滚后继续写入'))
    expect((await client.listDocs('kb-precommit')).total).toBe(2)
    expect(existsSync(join(kbDir, 'index.sqlite.rebuild'))).toBe(false)

    await client.dispose(900)
    expect(client.isRunning()).toBe(false)
    rmSync(kbDir, { recursive: true, force: true })
  })

  it('treats a post-commit staging cleanup failure as a warning and keeps wiki-reset.pending on corrupt recovery', () => {
    const kbDir = mkdtempSync(join(tmpdir(), 'kb-cleanup-fail-'))
    writeFileSync(join(kbDir, 'index.sqlite'), 'NOT A SQLITE DATABASE')
    const staging = beginRebuildStaging(kbDir)
    expect(staging.corruptRecovery).toBe(true)
    expect(existsSync(join(kbDir, 'wiki-reset.pending'))).toBe(true)
    staging.upsert({
      relPath: 'b.md', normPath: 'b.md', sha256: 'h-b', size: 3, mtimeMs: 1,
      format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed',
      chunks: [sampleChunk(0, '损坏后重建')],
    })

    // 提交点之后的暂存清理抛错（模拟 Windows 删除 `.rebuild-wal` 的 EPERM/EBUSY）
    // 必须只算警告：提交仍然成功、新库保留、pending 绝不被误删。
    const committed = commitRebuildStaging(kbDir, staging, {
      afterCommitCleanupForTest: () => {
        throw new Error('kb-test: EPERM staging cleanup')
      },
      failWikiResetOnceForTest: () => {
        throw new Error('kb-test: forced wiki reset failure')
      },
    })
    expect(committed).toEqual({ ok: true, corruptRecovery: true, wikiResetPending: true })
    expect(existsSync(join(kbDir, 'index.sqlite.rebuild'))).toBe(false)
    expect(existsSync(join(kbDir, 'wiki-reset.pending'))).toBe(true)
    expect(existsSync(join(kbDir, 'index.sqlite.bak'))).toBe(false)

    // 新库就是提交成功的产物，且仍能按原样重开读取。
    const reopened = openCommittedKnowledgeDb(kbDir)
    expect(reopened.ok).toBe(true)
    if (reopened.ok) {
      expect(searchFts(reopened.db, { kbId: 'k', kbName: 'K', query: '损坏后重建' })).toHaveLength(1)
      reopened.db.close()
    }
    // 保留下来的 pending 仍可由幂等入口收尾（Host 的 wiki-reset-pending 阶段）。
    expect(retryPendingWikiReset(kbDir)).toEqual({ ok: true })
    expect(existsSync(join(kbDir, 'wiki-reset.pending'))).toBe(false)
  })

  it('keeps backoff-retrying and partial-with-chunks docs in pendingOrganizeDocs without double-counting failedOrganizeDocs', () => {
    const kbDir = mkdtempSync(join(tmpdir(), 'kb-org-sql-'))
    const opened = openKnowledgeDb(kbDir)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const { db } = opened
    try {
      const docIndexed = upsertDocumentWithChunks(db, {
        relPath: 'indexed.md', normPath: 'indexed.md', sha256: 'sha-i', size: 20, mtimeMs: 1,
        format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed',
        chunks: [sampleChunk(0, '正常索引文档内容')],
      })
      const docPartial = upsertDocumentWithChunks(db, {
        relPath: 'hybrid.pdf', normPath: 'hybrid.pdf', sha256: 'sha-p', size: 40, mtimeMs: 2,
        format: 'pdf', extractMode: 'mixed', extractConfigHash: 'c1', status: 'partial',
        statusReason: 'pdf-image-pages-pending',
        chunks: [sampleChunk(0, '混合 PDF 已提取文字页')],
      })
      // 0 切片文档与 skipped 文档绝不进入待整理队列。
      upsertDocumentWithChunks(db, {
        relPath: 'empty.md', normPath: 'empty.md', sha256: 'sha-e', size: 0, mtimeMs: 3,
        format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed',
        chunks: [],
      })
      upsertDocumentWithChunks(db, {
        relPath: 'huge.bin', normPath: 'huge.bin', sha256: '', size: 99, mtimeMs: 4,
        format: 'bin', extractMode: 'none', extractConfigHash: 'c1', status: 'skipped',
        statusReason: 'file-too-large',
        chunks: [],
      })

      expect(getStats(db)).toMatchObject({
        totalDocs: 4,
        indexedDocs: 2,
        partialDocs: 1,
        skippedDocs: 1,
        pendingOrganizeDocs: 2,
        failedOrganizeDocs: 0,
      })
      expect(listDocs(db, { organizeState: 'pending' }).docs.map(d => d.docId).sort())
        .toEqual([docIndexed.docId, docPartial.docId].sort())
      expect(listDocs(db, { organizeState: 'failed' }).total).toBe(0)
      expect(getPendingOrganizeBatch(db, { nowMs: 1_000 }).docs.map(d => d.docId).sort())
        .toEqual([docIndexed.docId, docPartial.docId].sort())

      // 第 1 次失败（退避 60 s）：仍属 pending（不得从待整理消失，也不得误计入 failed）。
      const fail1 = recordOrganizeFailure(db, {
        docId: docIndexed.docId, sha256: 'sha-i', error: 'temporary 503', nowMs: 10_000,
      })
      expect(fail1).toEqual({ attempts: 1, retryAfter: 70_000 })
      expect(getStats(db)).toMatchObject({ pendingOrganizeDocs: 2, failedOrganizeDocs: 0 })
      expect(listDocs(db, { organizeState: 'pending' }).total).toBe(2)
      expect(listDocs(db, { organizeState: 'failed' }).total).toBe(0)
      // 退避期内排期跳过 docIndexed，只调度 docPartial；过退避期后两者都可调度。
      expect(getPendingOrganizeBatch(db, { nowMs: 20_000 }).docs.map(d => d.docId)).toEqual([docPartial.docId])
      expect(getPendingOrganizeBatch(db, { nowMs: 70_001 }).docs.map(d => d.docId).sort())
        .toEqual([docIndexed.docId, docPartial.docId].sort())

      // 第 2 次失败（退避 300 s）：仍属 pending，不计入 failed。
      const fail2 = recordOrganizeFailure(db, {
        docId: docIndexed.docId, sha256: 'sha-i', error: 'temporary 503 #2', nowMs: 80_000,
      })
      expect(fail2).toEqual({ attempts: 2, retryAfter: 380_000 })
      expect(getStats(db)).toMatchObject({ pendingOrganizeDocs: 2, failedOrganizeDocs: 0 })
      expect(listDocs(db, { organizeState: 'failed' }).total).toBe(0)

      // 第 3 次失败：正式进入 quarantined failed，从 pending 移除（严格互斥）。
      const fail3 = recordOrganizeFailure(db, {
        docId: docIndexed.docId, sha256: 'sha-i', error: 'permanent failure', nowMs: 400_000,
      })
      expect(fail3).toEqual({ attempts: 3, retryAfter: null })
      expect(getStats(db)).toMatchObject({ pendingOrganizeDocs: 1, failedOrganizeDocs: 1 })
      expect(listDocs(db, { organizeState: 'pending' }).docs.map(d => d.docId)).toEqual([docPartial.docId])
      expect(listDocs(db, { organizeState: 'failed' }).docs.map(d => d.docId)).toEqual([docIndexed.docId])
      expect(getPendingOrganizeBatch(db, { nowMs: 999_999 }).docs.map(d => d.docId)).toEqual([docPartial.docId])
    } finally {
      db.close()
      rmSync(kbDir, { recursive: true, force: true })
    }
  })

  it('preserves .bak and .rebuild on double rollback failure without creating an empty DB (C-2)', () => {
    const kbDir = mkdtempSync(join(tmpdir(), 'kb-c2-double-fail-'))
    try {
      const opened = openKnowledgeDb(kbDir)
      expect(opened.ok).toBe(true)
      if (!opened.ok) return
      upsertDocumentWithChunks(opened.db, {
        relPath: 'precious.md', normPath: 'precious.md', sha256: 'sha-precious', size: 12, mtimeMs: 1,
        format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed',
        chunks: [sampleChunk(0, '珍贵历史索引不可丢失')],
      })
      opened.db.close()

      const staging = beginRebuildStaging(kbDir)
      staging.upsert({
        relPath: 'new.md', normPath: 'new.md', sha256: 'sha-new', size: 8, mtimeMs: 2,
        format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed',
        chunks: [sampleChunk(0, '新内容')],
      })

      // Step 2 提交点失败 + restoreOldIndex 同时抛错：绝不能删掉 .rebuild/.bak，也不能新建空主库。
      const res = commitRebuildStaging(kbDir, staging, {
        failBeforeCommitPointForTest: () => { throw new Error('simulated step 2 rename EBUSY') },
        failRestoreOldIndexForTest: () => { throw new Error('simulated restore .bak EBUSY') },
      })
      expect(res).toMatchObject({ ok: false, code: 'rebuild-failed' })
      expect(existsSync(join(kbDir, 'index.sqlite'))).toBe(false)
      expect(existsSync(join(kbDir, 'index.sqlite.bak'))).toBe(true)
      expect(existsSync(join(kbDir, 'index.sqlite.rebuild'))).toBe(true)

      // openCommittedKnowledgeDb 绝不能在主文件缺失时新建空库。
      expect(openCommittedKnowledgeDb(kbDir)).toMatchObject({ ok: false, code: 'index-error' })
      expect(existsSync(join(kbDir, 'index.sqlite'))).toBe(false)

      // 下次启动 openKnowledgeDb 走恢复分支完整还回旧库数据。
      const recovered = openKnowledgeDb(kbDir)
      expect(recovered.ok).toBe(true)
      if (recovered.ok) {
        expect(searchFts(recovered.db, { kbId: 'k', kbName: 'K', query: '珍贵历史索引' })).toHaveLength(1)
        expect(existsSync(join(kbDir, 'index.sqlite.bak'))).toBe(false)
        expect(existsSync(join(kbDir, 'index.sqlite.rebuild'))).toBe(false)
        recovered.db.close()
      }
    } finally {
      rmSync(kbDir, { recursive: true, force: true })
    }
  })

  it('rejects missing targetOrdinal in getChunkWithWindow (I-8), resets non-empty wiki when wiki.stale exists (I-9), copies existing tombstones on normal rebuild (I-12), and clamps searchFts limit to 60 (M-7)', () => {
    const kbDir = mkdtempSync(join(tmpdir(), 'kb-i8-i9-i12-m7-'))
    try {
      const opened = openKnowledgeDb(kbDir)
      expect(opened.ok).toBe(true)
      if (!opened.ok) return
      const doc = upsertDocumentWithChunks(opened.db, {
        relPath: 'two-chunks.md', normPath: 'two-chunks.md', sha256: 'sha-2', size: 10, mtimeMs: 1,
        format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed',
        chunks: [sampleChunk(0, '第一片 公共词条'), sampleChunk(1, '第二片 公共词条')],
      })
      // I-8：窗口为 3 时请求不存在的 ordinal=2 必须返回 chunk-missing，而非拿 ordinal=1 顶替 ok。
      expect(getChunkWithWindow(opened.db, { docId: doc.docId, ordinal: 1, window: 3 }).status).toBe('ok')
      expect(getChunkWithWindow(opened.db, { docId: doc.docId, ordinal: 2, window: 3 }).status).toBe('chunk-missing')

      // M-7：插入 70 份命中文档，searchFts(limit=200) 钳制到 60。
      for (let i = 0; i < 70; i += 1) {
        upsertDocumentWithChunks(opened.db, {
          relPath: `cap-${String(i).padStart(2, '0')}.md`, normPath: `cap-${String(i).padStart(2, '0')}.md`,
          sha256: `sha-cap-${String(i)}`, size: 10, mtimeMs: i, format: 'md', extractMode: 'text',
          extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, `限量检索公共词条 ${String(i)}`)],
        })
      }
      expect(searchFts(opened.db, { kbId: 'k', kbName: 'K', query: '限量检索公共词条', limit: 200 })).toHaveLength(60)

      // I-12：先删除一个带 Wiki 卡片的文档生成墓碑，再跑正常重建，原有墓碑必须保留在新库中。
      const deletedDoc = upsertDocumentWithChunks(opened.db, {
        relPath: 'deleted-before-rebuild.md', normPath: 'deleted-before-rebuild.md',
        sha256: 'sha-del', size: 10, mtimeMs: 99, format: 'md', extractMode: 'text',
        extractConfigHash: 'c1', status: 'indexed', chunks: [sampleChunk(0, '待删卡片文档')],
      })
      markOrganizedAtomic(opened.db, { docId: deletedDoc.docId, sha256: 'sha-del', wikiNotePath: `docs/${deletedDoc.docId}.md` })
      deleteDocument(opened.db, 'deleted-before-rebuild.md')
      opened.db.close()

      const staging = beginRebuildStaging(kbDir)
      staging.upsert({
        relPath: 'two-chunks.md', normPath: 'two-chunks.md', sha256: 'sha-2', size: 10, mtimeMs: 1,
        format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed',
        chunks: [sampleChunk(0, '第一片 公共词条')],
      })
      expect(commitRebuildStaging(kbDir, staging)).toMatchObject({ ok: true })
      const reopened = openKnowledgeDb(kbDir)
      expect(reopened.ok).toBe(true)
      if (reopened.ok) {
        const batch = getPendingOrganizeBatch(reopened.db, { nowMs: Date.now() })
        expect(batch.tombstones.some(t => t.docId === deletedDoc.docId && t.wikiNotePath === `docs/${deletedDoc.docId}.md`)).toBe(true)
        reopened.db.close()
      }

      // I-9：当 wiki/ 非空且残留 wiki.stale 也存在时，retryPendingWikiReset 必须挪走 wiki/ 并清掉 pending。
      mkdirSync(join(kbDir, 'wiki', 'docs'), { recursive: true })
      writeFileSync(join(kbDir, 'wiki', 'docs', 'mismatched.md'), '# 失配旧卡片')
      mkdirSync(join(kbDir, 'wiki.stale'), { recursive: true })
      writeFileSync(join(kbDir, 'wiki.stale', 'old.md'), '# 上次残留 stale')
      writeFileSync(join(kbDir, 'wiki-reset.pending'), '{"reason":"corrupt-rebuild"}\n')

      expect(retryPendingWikiReset(kbDir)).toEqual({ ok: true })
      expect(existsSync(join(kbDir, 'wiki-reset.pending'))).toBe(false)
      expect(existsSync(join(kbDir, 'wiki', 'docs', 'mismatched.md'))).toBe(false)
      expect(existsSync(join(kbDir, 'wiki.stale'))).toBe(false)
    } finally {
      rmSync(kbDir, { recursive: true, force: true })
    }
  })

  it('restores .bak on retry beginRebuildStaging & protects .rebuild in abortRebuildStaging after double rollback failure (C-2), and preserves WAL-before-main recovery (C-2)', () => {
    // 1. C-2 Part A：双失败后 abortRebuildStaging 不删 .rebuild，且重试 beginRebuildStaging 先还原 .bak 再继承 doc_id。
    const kbDir = makeStorageTempDir('kb-c2-retry-')
    const opened = openKnowledgeDb(kbDir)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const original = upsertDocumentWithChunks(opened.db, {
      relPath: 'history.md', normPath: 'history.md', sha256: 'sha-hist', size: 10, mtimeMs: 1,
      format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed',
      chunks: [sampleChunk(0, '历史珍贵数据')],
    })
    opened.db.close()

    const failedStaging = beginRebuildStaging(kbDir)
    failedStaging.upsert({
      relPath: 'history.md', normPath: 'history.md', sha256: 'sha-hist', size: 10, mtimeMs: 2,
      format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed',
      chunks: [sampleChunk(0, '历史珍贵数据')],
    })
    expect(commitRebuildStaging(kbDir, failedStaging, {
      failBeforeCommitPointForTest: () => { throw new Error('step2-ebusy') },
      failRestoreOldIndexForTest: () => { throw new Error('restore-ebusy') },
    })).toMatchObject({ ok: false, code: 'rebuild-failed' })
    // 未活跃的 staging 调用 abortRebuildStaging 绝不能删掉 .rebuild 恢复标志。
    abortRebuildStaging(kbDir, failedStaging)
    expect(existsSync(join(kbDir, 'index.sqlite.rebuild'))).toBe(true)
    expect(existsSync(join(kbDir, 'index.sqlite.bak'))).toBe(true)

    // 重试 beginRebuildStaging 自动先还原 .bak 并继承原有 docId（不会变成空快照！）。
    const retryStaging = beginRebuildStaging(kbDir)
    expect(retryStaging.corruptRecovery).toBe(false)
    const retried = retryStaging.upsert({
      relPath: 'history.md', normPath: 'history.md', sha256: 'sha-hist', size: 10, mtimeMs: 3,
      format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed',
      chunks: [sampleChunk(0, '历史珍贵数据')],
    })
    expect(retried.docId).toBe(original.docId)
    expect(commitRebuildStaging(kbDir, retryStaging)).toMatchObject({ ok: true, corruptRecovery: false })

    // 2. C-2 Part B：半还原态（主库已搬回、主库无 WAL 但 .bak-wal 留存未 checkpoint 行）经 recoverKnowledgeDbDir 完整找回 WAL。
    const walDir = makeStorageTempDir('kb-c2-wal-half-')
    const initWal = openKnowledgeDb(walDir)
    expect(initWal.ok).toBe(true)
    if (initWal.ok) {
      initWal.db.exec('PRAGMA wal_autocheckpoint = 0')
      upsertDocumentWithChunks(initWal.db, {
        relPath: 'wal-doc.md', normPath: 'wal-doc.md', sha256: 'sha-wal', size: 10, mtimeMs: 1,
        format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed',
        chunks: [sampleChunk(0, '未落盘增量 WAL 数据')],
      })
      const mainBytes = readFileSync(join(walDir, 'index.sqlite'))
      const walBytes = readFileSync(join(walDir, 'index.sqlite-wal'))
      initWal.db.close()
      rmSync(join(walDir, 'index.sqlite-wal'), { force: true })
      rmSync(join(walDir, 'index.sqlite-shm'), { force: true })
      writeFileSync(join(walDir, 'index.sqlite'), mainBytes)
      writeFileSync(join(walDir, 'index.sqlite.bak-wal'), walBytes)
      writeFileSync(join(walDir, 'index.sqlite.rebuild'), 'aborted')
    }
    recoverKnowledgeDbDir(walDir)
    const afterWal = openKnowledgeDb(walDir)
    expect(afterWal.ok).toBe(true)
    if (afterWal.ok) {
      expect(searchFts(afterWal.db, { kbId: 'k', kbName: 'K', query: '增量' })).toHaveLength(1)
      afterWal.db.close()
    }

    // 3. N-1：已提交分支（无 .rebuild）残留旧库 .bak + 未 checkpoint 的 .bak-wal 时，绝不嫁接旧 WAL 到新主库。
    const oldWalSourceDir = makeStorageTempDir('kb-n1-old-wal-')
    let oldBakBytes: Buffer = Buffer.alloc(0)
    let oldWalBytes: Buffer = Buffer.alloc(0)
    const oldOpened = openKnowledgeDb(oldWalSourceDir)
    expect(oldOpened.ok).toBe(true)
    if (oldOpened.ok) {
      oldOpened.db.exec('PRAGMA wal_autocheckpoint = 0')
      upsertDocumentWithChunks(oldOpened.db, {
        relPath: 'old-wal.md', normPath: 'old-wal.md', sha256: 'sha-old-wal', size: 12, mtimeMs: 1,
        format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed',
        chunks: [sampleChunk(0, '旧库未落盘回滚数据')],
      })
      oldBakBytes = readFileSync(join(oldWalSourceDir, 'index.sqlite'))
      oldWalBytes = readFileSync(join(oldWalSourceDir, 'index.sqlite-wal'))
      expect(oldWalBytes.byteLength).toBeGreaterThan(0)
      oldOpened.db.close()
    }

    const committedDir = makeStorageTempDir('kb-n1-committed-')
    const committedStaging = beginRebuildStaging(committedDir)
    committedStaging.upsert({
      relPath: 'fresh-commit.md', normPath: 'fresh-commit.md', sha256: 'sha-fresh', size: 12, mtimeMs: 2,
      format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed',
      chunks: [sampleChunk(0, '新提交权威索引数据')],
    })
    expect(commitRebuildStaging(committedDir, committedStaging)).toMatchObject({ ok: true })
    // 模拟 Step 2 提交后、removeBackups 前崩溃：新 index.sqlite 无 -wal、无 .rebuild，盘上残留旧 .bak 与 .bak-wal。
    rmSync(join(committedDir, 'index.sqlite-wal'), { force: true })
    rmSync(join(committedDir, 'index.sqlite-shm'), { force: true })
    writeFileSync(join(committedDir, 'index.sqlite.bak'), oldBakBytes)
    writeFileSync(join(committedDir, 'index.sqlite.bak-wal'), oldWalBytes)

    const afterCommittedCrash = openKnowledgeDb(committedDir)
    expect(afterCommittedCrash.ok).toBe(true)
    if (afterCommittedCrash.ok) {
      expect(searchFts(afterCommittedCrash.db, { kbId: 'k', kbName: 'K', query: '新提交权威' })).toHaveLength(1)
      expect(searchFts(afterCommittedCrash.db, { kbId: 'k', kbName: 'K', query: '旧库未落盘' })).toHaveLength(0)
      expect(existsSync(join(committedDir, 'index.sqlite.bak'))).toBe(false)
      expect(existsSync(join(committedDir, 'index.sqlite.bak-wal'))).toBe(false)
      afterCommittedCrash.db.close()
    }

    // 4. N-1 二次路径：上次提交清扫失败残留过期 .bak-wal 时，下一次 beginRebuildStaging 先清扫再建 .rebuild。
    rmSync(join(committedDir, 'index.sqlite-wal'), { force: true })
    rmSync(join(committedDir, 'index.sqlite-shm'), { force: true })
    writeFileSync(join(committedDir, 'index.sqlite.bak-wal'), oldWalBytes)
    const secondStaging = beginRebuildStaging(committedDir)
    expect(existsSync(join(committedDir, 'index.sqlite.bak-wal'))).toBe(false)
    secondStaging.abort()
    const afterSecondAbort = openKnowledgeDb(committedDir)
    expect(afterSecondAbort.ok).toBe(true)
    if (afterSecondAbort.ok) {
      expect(searchFts(afterSecondAbort.db, { kbId: 'k', kbName: 'K', query: '新提交权威' })).toHaveLength(1)
      expect(searchFts(afterSecondAbort.db, { kbId: 'k', kbName: 'K', query: '旧库未落盘' })).toHaveLength(0)
      afterSecondAbort.db.close()
    }
  })

  it('preserves committed wiki-reset.pending across later uncommitted rebuild crash (I-3), guards negative/NaN chunk inputs (I-6), aligns FTS rowid & supports relaxed Chinese search (I-7), and checks extractConfigHash + UTF-8 organize budget (M-3)', () => {
    // I-3：已过提交点的 committed wiki-reset.pending 不被后续未提交重建崩溃清掉。
    const i3Dir = makeStorageTempDir('kb-i3-pending-')
    mkdirSync(join(i3Dir, 'wiki'), { recursive: true })
    writeFileSync(join(i3Dir, 'wiki', 'STALE.md'), '# must reset')
    writeFileSync(join(i3Dir, 'index.sqlite'), 'NOT_SQLITE')
    const corruptStaging = beginRebuildStaging(i3Dir)
    corruptStaging.upsert({
      relPath: 'fresh.md', normPath: 'fresh.md', sha256: 'sha-f', size: 5, mtimeMs: 1,
      format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed',
      chunks: [sampleChunk(0, '重建后新库')],
    })
    const committed = commitRebuildStaging(i3Dir, corruptStaging, {
      failWikiResetOnceForTest: () => { throw new Error('ebusy') },
    })
    expect(committed).toEqual({ ok: true, corruptRecovery: true, wikiResetPending: true })
    // 模拟下一次重建在提交前崩溃留下 index.sqlite.rebuild。
    writeFileSync(join(i3Dir, 'index.sqlite.rebuild'), 'uncommitted')
    const recovered = openKnowledgeDb(i3Dir)
    expect(recovered.ok).toBe(true)
    if (recovered.ok) {
      expect(existsSync(join(i3Dir, 'wiki-reset.pending'))).toBe(false)
      expect(existsSync(join(i3Dir, 'wiki', 'STALE.md'))).toBe(false)
      recovered.db.close()
    }

    // I-6 + I-7 + M-3：单库综合回归。
    const dbDir = makeStorageTempDir('kb-i6-i7-m3-')
    const opened = openKnowledgeDb(dbDir)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const { db } = opened
    try {
      const doc = upsertDocumentWithChunks(db, {
        relPath: 'fund.md', normPath: 'fund.md', sha256: 'sha-fund', size: 40, mtimeMs: 1,
        format: 'md', extractMode: 'text', extractConfigHash: 'cfg-v1', status: 'indexed',
        chunks: [
          sampleChunk(0, '该基金的赎回税率为1.5%，持有满两年免收'),
          sampleChunk(1, '片段一'),
          sampleChunk(2, '片段二'),
          sampleChunk(3, '片段三'),
          sampleChunk(4, '片段四'),
          sampleChunk(5, '片段五'),
          sampleChunk(6, '片段六'),
        ],
      })
      // I-7：rowid 对齐 + 无空格中文查询「基金税率」降级命中。
      const misaligned = db.prepare(
        'SELECT COUNT(*) AS cnt FROM chunks c JOIN chunks_fts f ON f.chunk_id = c.chunk_id WHERE c.rowid <> f.rowid',
      ).get() as { cnt: number }
      expect(misaligned.cnt).toBe(0)
      expect(searchFts(db, { kbId: 'k', kbName: 'K', query: '基金税率' })).toHaveLength(1)
      expect(searchFts(db, { kbId: 'k', kbName: 'K', query: '不存在的词' })).toHaveLength(0)

      // I-6：负值与 NaN ordinal 返回 chunk-missing，window 钳制在 5 以内。
      expect(getChunkWithWindow(db, { docId: doc.docId, ordinal: -1, window: 3 }).status).toBe('chunk-missing')
      expect(getChunkWithWindow(db, { docId: doc.docId, ordinal: Number.NaN, window: 3 }).status).toBe('chunk-missing')
      const clampedWindow = getChunkWithWindow(db, { docId: doc.docId, ordinal: 3, window: 99 })
      expect(clampedWindow.status).toBe('ok')
      if (clampedWindow.status === 'ok') expect(clampedWindow.chunks.length).toBeLessThanOrEqual(5)
      expect(getDocChunks(db, doc.docId, Number.NaN, Number.NaN).length).toBe(7)
      expect(listDocs(db, { offset: Number.NaN }).docs).toHaveLength(1)

      // M-3：extractConfigHash 变化时即使 sha256 相同也重置 organized_sha256。
      markOrganizedAtomic(db, { docId: doc.docId, sha256: 'sha-fund', wikiNotePath: `docs/${doc.docId}.md` })
      upsertDocumentWithChunks(db, {
        relPath: 'fund.md', normPath: 'fund.md', sha256: 'sha-fund', size: 40, mtimeMs: 2,
        format: 'md', extractMode: 'mixed', extractConfigHash: 'cfg-v2', status: 'indexed',
        chunks: [sampleChunk(0, '该基金的赎回税率为1.5%')],
      })
      expect(listDocs(db, { organizeState: 'pending' }).docs.some(d => d.docId === doc.docId)).toBe(true)

      // M-3：getPendingOrganizeBatch 按 UTF-8 字节数（中文 3 字节/字）而非 charCount 控预算。
      const cnDir = makeStorageTempDir('kb-m3-utf8-budget-')
      const cnOpened = openKnowledgeDb(cnDir)
      expect(cnOpened.ok).toBe(true)
      if (cnOpened.ok) {
        try {
          // 每份文档 20 个汉字 = 60 UTF-8 字节（charCount = 20）；maxBytes = 100 时只应放行 1 份（60 + 60 = 120 > 100）。
          upsertDocumentWithChunks(cnOpened.db, {
            relPath: 'cn-1.md', normPath: 'cn-1.md', sha256: 's1', size: 60, mtimeMs: 1,
            format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed',
            chunks: [sampleChunk(0, '中'.repeat(20))],
          })
          upsertDocumentWithChunks(cnOpened.db, {
            relPath: 'cn-2.md', normPath: 'cn-2.md', sha256: 's2', size: 60, mtimeMs: 2,
            format: 'md', extractMode: 'text', extractConfigHash: 'c1', status: 'indexed',
            chunks: [sampleChunk(0, '文'.repeat(20))],
          })
          const batch = getPendingOrganizeBatch(cnOpened.db, { nowMs: Date.now(), maxBytes: 100 })
          expect(batch.docs).toHaveLength(1)
        } finally {
          cnOpened.db.close()
        }
      }
    } finally {
      db.close()
    }
  })

  it('cleans active rebuild staging on closeKb/shutdown, memoizes concurrent dispose(), and auto-reopens KBs after Worker crash without cross-killing new requests (I-4)', async () => {
    // 1. closeKb 与 shutdown 在活跃重建期间关闭并清理 .rebuild* 句柄，且并发 dispose() 共享同一退场 Promise。
    const kbDir = makeStorageTempDir('kb-i4-rebuild-close-')
    const client = createKnowledgeStorageClient()
    expect((await client.openKb('kb-a', kbDir)).ok).toBe(true)
    await client.beginRebuild('kb-a', kbDir)
    expect(existsSync(join(kbDir, 'index.sqlite.rebuild'))).toBe(true)
    await client.closeKb('kb-a')
    expect(existsSync(join(kbDir, 'index.sqlite.rebuild'))).toBe(false)
    const [d1, d2] = await Promise.all([client.dispose(900), client.dispose(900)])
    expect(d1).toBeUndefined()
    expect(d2).toBeUndefined()

    // 2. Worker 崩溃后拉起新实例：自动重开已打开库，且旧 Worker 延迟退出不会误杀新 Worker 在途请求。
    const crashDir = makeStorageTempDir('kb-i4-crash-respawn-')
    const stubWorkerPath = join(crashDir, 'flaky-storage-worker.mjs')
    writeFileSync(
      stubWorkerPath,
      [
        "import { parentPort } from 'node:worker_threads'",
        'const opened = new Map()',
        'let sawCrashTrigger = false',
        "parentPort.on('message', (msg) => {",
        "  if (msg.op === 'openKb') {",
        '    opened.set(msg.kbId, msg.kbDir)',
        '    parentPort.postMessage({ id: msg.id, ok: true, result: { ok: true, wikiResetPending: false } })',
        '    return',
        '  }',
        "  if (msg.op === 'listDocs') {",
        "    if (msg.kbId === 'kb-trigger-crash' && !sawCrashTrigger) {",
        '      sawCrashTrigger = true',
        '      process.exit(1)',
        '    }',
        '    if (!opened.has(msg.kbId)) {',
        "      parentPort.postMessage({ id: msg.id, ok: false, code: 'index-error', error: `${msg.kbId} is not open` })",
        '      return',
        '    }',
        '    parentPort.postMessage({ id: msg.id, ok: true, result: { total: 0, docs: [] } })',
        '    return',
        '  }',
        "  if (msg.op === 'shutdown') {",
        '    parentPort.postMessage({ id: msg.id, ok: true, result: undefined })',
        '    setImmediate(() => process.exit(0))',
        '    return',
        '  }',
        '  parentPort.postMessage({ id: msg.id, ok: true, result: undefined })',
        '})',
      ].join('\n'),
    )
    const flaky = createKnowledgeStorageClient({ workerUrl: pathToFileURL(stubWorkerPath) })
    try {
      expect((await flaky.openKb('kb-idle', crashDir)).ok).toBe(true)
      expect((await flaky.openKb('kb-trigger-crash', crashDir)).ok).toBe(true)
      await expect(flaky.listDocs('kb-trigger-crash')).rejects.toThrow(/exited/u)
      // 新 Worker 自动重开先前已打开的 kb-idle，不再永久报 `is not open`！
      await expect(flaky.listDocs('kb-idle')).resolves.toEqual({ total: 0, docs: [] })
    } finally {
      await flaky.dispose(900)
    }
  })
})
