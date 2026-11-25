import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  beginRebuildStaging,
  commitRebuildStaging,
  deleteDocument,
  getChunkWithWindow,
  listDocs,
  markOrganizedAtomic,
  openKnowledgeDb,
  renameDocument,
  retryPendingWikiReset,
  searchFts,
  upsertDocumentWithChunks,
} from '../../src/huaanwork-host/knowledge/storage-db.ts'
import { createKnowledgeStorageClient } from '../../src/huaanwork-host/knowledge/storage-client.ts'
import { tokenizeForFts } from '../../src/huaanwork-host/knowledge/tokenizer.ts'

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
    expect(performance.now() - t0).toBeLessThan(1_000)
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
})
