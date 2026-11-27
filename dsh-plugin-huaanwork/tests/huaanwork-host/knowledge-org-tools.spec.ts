/**
 * M1-2 Task 3: 三个整理宿主工具、唯一不可变批次与受控墓碑删除。
 *
 * 规格依据:docs/superpowers/specs/2026-11-24-knowledge-base-design.md §8.1 / §8.3 / §11.1。
 * 工具只认 `huaanwork-kb-org-<kbId>` 会话前缀,执行时经 `getKnowledgeHost()` 读取
 * 同一 Host 的 storage 门面;`kb_org_get_delta` 只返回 open 时的冻结快照,
 * `kb_org_mark_organized` 先完整校验再落副作用,墓碑先删文件后删行。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'

import {
  createKnowledgeHost,
  type CreateKnowledgeHostOptions,
  type KnowledgeHost,
} from '../../src/huaanwork-host/knowledge/host.ts'
import { getKnowledgeHost, setKnowledgeHost } from '../../src/huaanwork-host/knowledge/host-ref.ts'
import {
  KB_ORG_ALLOWED_TOOLS,
  KB_ORG_TOOLS,
  registerKnowledgeOrgTools,
  type KnowledgeOrgToolTestHooks,
} from '../../src/huaanwork-host/knowledge/org-tools.ts'
import { kbOrganizeSessionId } from '../../src/huaanwork-host/knowledge/session-ids.ts'
import {
  createKnowledgeStorageClient,
  type KnowledgeStorageClient,
} from '../../src/huaanwork-host/knowledge/storage-client.ts'
import { tokenizeForFts } from '../../src/huaanwork-host/knowledge/tokenizer.ts'
import {
  MAX_WIKI_FILE_BYTES,
  MAX_WIKI_TOTAL_BYTES,
  type DocumentRecordSummary,
  type UpsertDocumentInput,
} from '../../src/huaanwork-host/knowledge/types.ts'
import { neutralKnowledgeRootPath, neutralKnowledgeWikiRootPath } from '../../src/huaanwork-host/workspace-state.ts'

type AgentRef = { readonly session?: { readonly id?: string } }

interface ToolDefinition {
  readonly name: string
  execute(args: Record<string, unknown>, exec: { readonly agent?: AgentRef }): Promise<{ readonly text: string }>
}

interface OrgToolTestContext {
  tools: { register(definition: unknown): () => void }
  huaanworkProfileDir: string
  huaanworkKnowledgeOrgTestHooks?: KnowledgeOrgToolTestHooks
}

interface FixtureFile {
  readonly relPath: string
  readonly content: string
}

interface FixtureOptions {
  readonly prefix?: string
  readonly files?: readonly FixtureFile[]
  readonly autoOrganize?: boolean
  readonly storage?: KnowledgeStorageClient
  readonly hostOptions?: Omit<CreateKnowledgeHostOptions, 'profileDir' | 'storageOverrideForTest'>
  readonly testHooks?: KnowledgeOrgToolTestHooks
}

interface OrgFixture {
  readonly root: string
  readonly profileDir: string
  readonly sourceDir: string
  readonly host: KnowledgeHost
  readonly storage: KnowledgeStorageClient
  readonly kbId: string
  readonly wikiRoot: string
  readonly docs: readonly DocumentRecordSummary[]
  readonly registered: Map<string, ToolDefinition>
  readonly toolCtx: OrgToolTestContext
}

const dirs: string[] = []
const hosts: KnowledgeHost[] = []
let disposeTools: (() => void) | undefined
let clearHost: (() => void) | undefined

afterEach(async () => {
  disposeTools?.()
  disposeTools = undefined
  clearHost?.()
  clearHost = undefined
  for (const host of hosts.splice(0)) {
    try {
      await host.dispose()
    } catch {
      // 清理失败不掩盖测试结果。
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(root)
  return root
}

function bindHost(host: KnowledgeHost): void {
  clearHost = setKnowledgeHost(host)
}

function documentInput(relPath: string, sha256: string, content: string): UpsertDocumentInput {
  return {
    relPath,
    normPath: relPath,
    sha256,
    size: content.length,
    mtimeMs: Date.now(),
    format: 'md',
    extractMode: 'text',
    extractConfigHash: 'org-tools-test-config',
    status: 'indexed',
    chunks: [{
      ordinal: 0,
      headingPath: '',
      locator: { kind: 'file' },
      content,
      tokenized: tokenizeForFts(content),
      charCount: content.length,
    }],
  }
}

async function createFixture(options: FixtureOptions = {}): Promise<OrgFixture> {
  const root = makeRoot(options.prefix ?? 'kb-org-tools-')
  const profileDir = join(root, 'profile')
  const sourceDir = join(root, 'source')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })
  const files = options.files ?? [{ relPath: 'alpha.md', content: '# Alpha\n\n默认正文。' }]
  for (const file of files) writeFileSync(join(sourceDir, file.relPath), file.content)

  const storage = options.storage ?? createKnowledgeStorageClient()
  const host = createKnowledgeHost({
    profileDir,
    storageOverrideForTest: storage,
    ...(options.hostOptions ?? {}),
  })
  hosts.push(host)
  await host.start()
  const kb = await host.create({
    name: '整理库',
    sourceDir,
    autoOrganize: options.autoOrganize ?? true,
  })
  await host.sync(kb.id)
  const docs = (await host.listDocs(kb.id)).docs
  const wikiRoot = neutralKnowledgeWikiRootPath(profileDir, kb.id)
  mkdirSync(join(wikiRoot, 'docs'), { recursive: true })

  bindHost(host)
  const registered = new Map<string, ToolDefinition>()
  const toolCtx: OrgToolTestContext = {
    tools: {
      register(definition: unknown): () => void {
        const tool = definition as ToolDefinition
        registered.set(tool.name, tool)
        return () => {
          registered.delete(tool.name)
        }
      },
    },
    huaanworkProfileDir: profileDir,
    ...(options.testHooks === undefined ? {} : { huaanworkKnowledgeOrgTestHooks: options.testHooks }),
  }
  disposeTools = registerKnowledgeOrgTools(toolCtx)

  return { root, profileDir, sourceDir, host, storage, kbId: kb.id, wikiRoot, docs, registered, toolCtx }
}

function docByPath(fixture: OrgFixture, relPath: string): DocumentRecordSummary {
  const doc = fixture.docs.find(record => record.relPath === relPath)
  if (doc === undefined) throw new Error(`document ${relPath} is missing from fixture`)
  return doc
}

async function runTool(
  fixture: OrgFixture,
  name: string,
  args: Record<string, unknown>,
  agent: AgentRef = { session: { id: kbOrganizeSessionId(fixture.kbId) } },
): Promise<string> {
  const tool = fixture.registered.get(name)
  if (tool === undefined) throw new Error(`tool ${name} is not registered`)
  const result = await tool.execute(args, { agent })
  return result.text
}

async function markCard(fixture: OrgFixture, doc: DocumentRecordSummary, content = '# 卡片\n'): Promise<void> {
  await fixture.storage.markOrganizedAtomic(fixture.kbId, doc.docId, doc.sha256, `docs/${doc.docId}.md`)
  writeFileSync(join(fixture.wikiRoot, 'docs', `${doc.docId}.md`), content)
}

/** 只写卡片文件，不推进 organized 指纹(用于验证整次拒绝不产生副作用)。 */
function writeCard(fixture: OrgFixture, docId: string, content = '# 卡片\n'): void {
  writeFileSync(join(fixture.wikiRoot, 'docs', `${docId}.md`), content)
}

interface MarkResult {
  readonly organized: readonly string[]
  readonly stale: readonly string[]
  readonly clearedTombstones: readonly string[]
  readonly keptTombstones: readonly string[]
}

async function runMark(
  fixture: OrgFixture,
  args: { processed?: readonly string[]; clearedTombstones?: readonly string[]; summary?: string },
): Promise<MarkResult> {
  const text = await runTool(fixture, 'kb_org_mark_organized', {
    ...(args.processed === undefined ? {} : { processed: [...args.processed] }),
    ...(args.clearedTombstones === undefined ? {} : { clearedTombstones: [...args.clearedTombstones] }),
    summary: args.summary ?? '整理批次',
  })
  return JSON.parse(text) as MarkResult
}

function insertTombstoneRow(
  fixture: OrgFixture,
  row: { readonly docId: string; readonly relPath: string; readonly wikiNotePath: string | null },
): void {
  const db = new DatabaseSync(join(neutralKnowledgeRootPath(fixture.profileDir, fixture.kbId), 'index.sqlite'))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.prepare(
      'INSERT INTO organize_tombstones (doc_id, rel_path, wiki_note_path, deleted_at) VALUES (?, ?, ?, ?)',
    ).run(row.docId, row.relPath, row.wikiNotePath, Date.now())
  } finally {
    db.close()
  }
}

function tombstoneExists(dbFile: string, docId: string): boolean {
  const db = new DatabaseSync(dbFile)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    return db.prepare('SELECT 1 AS present FROM organize_tombstones WHERE doc_id = ?').get(docId) !== undefined
  } finally {
    db.close()
  }
}

function tombstoneIds(fixture: OrgFixture): Promise<readonly string[]> {
  return fixture.host
    .peekPendingOrganizeBatch(fixture.kbId, Date.now())
    .then(batch => batch.tombstones.map(tombstone => tombstone.docId))
}

it('freezes one authoritative batch across open/get_delta/close and never re-queries after open', async () => {
  const fixture = await createFixture({
    files: [
      { relPath: 'work.md', content: '# 待整理\n\n工作文档正文。' },
      { relPath: 'keep.md', content: '# 将被删除\n\n保留文档正文。' },
      { relPath: 'legacy.md', content: '# 旧文档\n\n旧文档正文。' },
      { relPath: 'legacyB.md', content: '# 另一旧文档\n\n另一旧文档正文。' },
    ],
  })
  const work = docByPath(fixture, 'work.md')
  const keep = docByPath(fixture, 'keep.md')
  const legacy = docByPath(fixture, 'legacy.md')
  const legacyB = docByPath(fixture, 'legacyB.md')

  for (const doc of [keep, legacy, legacyB]) await markCard(fixture, doc)
  for (const relPath of ['keep.md', 'legacy.md']) rmSync(join(fixture.sourceDir, relPath))
  await fixture.host.sync(fixture.kbId)

  const now = Date.now()
  const opened = await fixture.host.openOrganizeBatch(fixture.kbId, now)
  expect(opened.docs.map(item => item.docId)).toEqual([work.docId])
  expect([...opened.tombstones.map(item => item.docId)].sort()).toEqual([keep.docId, legacy.docId].sort())
  expect(Object.isFrozen(opened)).toBe(true)
  expect(Object.isFrozen(opened.docs)).toBe(true)

  await expect(fixture.host.openOrganizeBatch(fixture.kbId, now)).rejects.toThrow(/knowledge-base-busy/u)
  expect(fixture.host.getOpenOrganizeBatch(fixture.kbId)).toEqual(opened)
  expect(JSON.parse(await runTool(fixture, 'kb_org_get_delta', {}))).toEqual(opened)

  // open 之后再写入数据库的新文档和新墓碑都不得改动冻结快照。
  await fixture.storage.upsertDocument(fixture.kbId, documentInput('after-open.md', 'sha-after-open', 'open 之后新到文档'))
  await fixture.storage.deleteDocument(fixture.kbId, 'legacyB.md')
  expect(fixture.host.getOpenOrganizeBatch(fixture.kbId)).toEqual(opened)
  expect(JSON.parse(await runTool(fixture, 'kb_org_get_delta', {}))).toEqual(opened)

  const settled = fixture.host.closeOrganizeBatch(fixture.kbId)
  expect(settled.batch).toEqual(opened)
  expect(settled.organizedDocIds).toEqual([])
  expect(settled.clearedTombstoneIds).toEqual([])
  expect(() => fixture.host.closeOrganizeBatch(fixture.kbId)).toThrow(/knowledge-organize-batch-not-open/u)
  expect(() => fixture.host.getOpenOrganizeBatch(fixture.kbId)).toThrow(/knowledge-organize-batch-not-open/u)

  const reopened = await fixture.host.openOrganizeBatch(fixture.kbId, Date.now())
  expect(reopened.docs.map(item => item.relPath)).toContain('after-open.md')
  expect(reopened.tombstones.map(item => item.docId)).toContain(legacyB.docId)
})

it('returns only the current batch within 10 docs / 80 KB and pages doc chunks at limit 12', async () => {
  expect(MAX_WIKI_TOTAL_BYTES).toBe(50 * 1024 * 1024)
  expect([...KB_ORG_TOOLS]).toEqual(['kb_org_get_delta', 'kb_org_read_doc', 'kb_org_mark_organized'])
  expect([...KB_ORG_ALLOWED_TOOLS]).toEqual([
    'read',
    'read_file',
    'glob',
    'grep',
    'write',
    'edit',
    'kb_org_get_delta',
    'kb_org_read_doc',
    'kb_org_mark_organized',
  ])

  // 1. 本批最多 10 份到期文档；退避未到与已达 3 次失败的文档被跳过。
  const many = Array.from({ length: 13 }, (_, index) => ({
    relPath: `a${String(index + 1).padStart(2, '0')}.md`,
    content: `# 小文档 ${index}\n\n正文内容 ${index}。`,
  }))
  const batchFixture = await createFixture({ files: many })
  const failedPermanently = docByPath(batchFixture, 'a01.md')
  const retryBackoff = docByPath(batchFixture, 'a02.md')
  const now = Date.now()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await batchFixture.host.recordOrganizeFailure(
      batchFixture.kbId,
      failedPermanently.docId,
      failedPermanently.sha256,
      'test failure',
      now,
    )
  }
  await batchFixture.host.recordOrganizeFailure(
    batchFixture.kbId,
    retryBackoff.docId,
    retryBackoff.sha256,
    'test failure',
    now,
  )
  const opened = await batchFixture.host.openOrganizeBatch(batchFixture.kbId, now)
  expect(opened.docs).toHaveLength(10)
  expect(opened.docs.map(item => item.docId)).not.toContain(failedPermanently.docId)
  expect(opened.docs.map(item => item.docId)).not.toContain(retryBackoff.docId)
  const delta = JSON.parse(await runTool(batchFixture, 'kb_org_get_delta', {})) as { docs: unknown[] }
  expect(delta.docs).toHaveLength(10)

  // 2. 80 KB 切片文本预算：50 KB + 50 KB 只能放进第一份。
  const largeContent = `# 大文档\n\n${'x'.repeat(50 * 1024)}`
  const byteFixture = await createFixture({
    prefix: 'kb-org-tools-bytes-',
    files: [
      { relPath: 'b.md', content: largeContent },
      { relPath: 'c.md', content: largeContent },
    ],
  })
  const byteBatch = await byteFixture.host.openOrganizeBatch(byteFixture.kbId, Date.now())
  expect(byteBatch.docs).toHaveLength(1)
  expect(byteBatch.docs[0]!.charCount).toBeLessThanOrEqual(80 * 1024)

  // 3. kb_org_read_doc 默认且最大 limit = 12，startOrdinal 可继续分页。
  const longContent = Array.from(
    { length: 20 },
    (_, index) => `## 小节 ${index}\n${`第${index}段内容。`.repeat(120)}`,
  ).join('\n\n')
  const pagingFixture = await createFixture({
    prefix: 'kb-org-tools-paging-',
    files: [{ relPath: 'long.md', content: longContent }],
  })
  const longDoc = docByPath(pagingFixture, 'long.md')
  await pagingFixture.host.openOrganizeBatch(pagingFixture.kbId, Date.now())
  const firstPage = JSON.parse(await runTool(pagingFixture, 'kb_org_read_doc', { docId: longDoc.docId })) as {
    chunks: Array<{ ordinal: number }>
  }
  expect(firstPage.chunks).toHaveLength(12)
  expect(firstPage.chunks.map(chunk => chunk.ordinal)).toEqual(Array.from({ length: 12 }, (_, index) => index))
  const secondPage = JSON.parse(
    await runTool(pagingFixture, 'kb_org_read_doc', { docId: longDoc.docId, startOrdinal: 12 }),
  ) as { chunks: Array<{ ordinal: number }> }
  expect(secondPage.chunks.length).toBeGreaterThan(0)
  expect(secondPage.chunks.length).toBeLessThanOrEqual(12)
  expect(secondPage.chunks[0]!.ordinal).toBe(12)
  const cappedPage = JSON.parse(
    await runTool(pagingFixture, 'kb_org_read_doc', { docId: longDoc.docId, limit: 99 }),
  ) as { chunks: unknown[] }
  expect(cappedPage.chunks).toHaveLength(12)
  await expect(runTool(pagingFixture, 'kb_org_read_doc', { docId: 'not-in-batch' })).rejects.toThrow(
    /knowledge-organize-doc-not-in-batch/u,
  )
})

it('rejects empty, oversized and symlinked cards, and keeps the sha256 fingerprint on source changes', async () => {
  const outsidePath = join(makeRoot('kb-org-tools-outside-'), 'outside.md')
  writeFileSync(outsidePath, '# outside\n')
  const fixture = await createFixture({
    files: [
      { relPath: 'good.md', content: '# 正常\n\n正常正文。' },
      { relPath: 'good2.md', content: '# 正常二\n\n正常正文二。' },
      { relPath: 'empty.md', content: '# 空\n\n空正文。' },
      { relPath: 'huge.md', content: '# 巨大\n\n巨大正文。' },
      { relPath: 'link.md', content: '# 链接\n\n链接正文。' },
    ],
  })
  const good = docByPath(fixture, 'good.md')
  const good2 = docByPath(fixture, 'good2.md')
  const empty = docByPath(fixture, 'empty.md')
  const huge = docByPath(fixture, 'huge.md')
  const link = docByPath(fixture, 'link.md')
  await fixture.host.openOrganizeBatch(fixture.kbId, Date.now())

  writeCard(fixture, good.docId, '# 正常卡片\n')
  writeCard(fixture, good2.docId, '# 正常卡片二\n')
  writeCard(fixture, empty.docId, '')
  writeCard(fixture, huge.docId, 'x'.repeat(MAX_WIKI_FILE_BYTES + 1))
  symlinkSync(outsidePath, join(fixture.wikiRoot, 'docs', `${link.docId}.md`))

  const accepted = await runMark(fixture, { processed: [good.docId], summary: '推进正常文档' })
  expect(accepted.organized).toEqual([good.docId])
  expect(accepted.stale).toEqual([])
  const afterGood = (await fixture.host.listDocs(fixture.kbId)).docs.find(doc => doc.docId === good.docId)
  expect(afterGood?.organizedSha256).toBe(good.sha256)
  expect(afterGood?.wikiNotePath).toBe(`docs/${good.docId}.md`)

  await expect(runMark(fixture, { processed: [empty.docId] })).rejects.toThrow(
    /knowledge-organize-wiki-card-invalid/u,
  )
  await expect(runMark(fixture, { processed: [huge.docId] })).rejects.toThrow(
    /knowledge-organize-wiki-card-invalid/u,
  )
  await expect(runMark(fixture, { processed: [link.docId] })).rejects.toThrow(
    /knowledge-organize-(?:path-invalid|wiki-card-invalid)/u,
  )

  // 同一调用里一份非法卡片会让整次拒绝：合法文档也不得被部分推进。
  await expect(runMark(fixture, { processed: [good2.docId, empty.docId] })).rejects.toThrow(
    /knowledge-organize-wiki-card-invalid/u,
  )
  const afterRejected = (await fixture.host.listDocs(fixture.kbId)).docs.find(doc => doc.docId === good2.docId)
  expect(afterRejected?.organizedSha256).toBeNull()

  // 整理途中源文件变化：open 快照的 sha256 不再命中，报告 stale-sha256 且不推进指纹。
  writeFileSync(join(fixture.sourceDir, 'good2.md'), '# 正常二\n\n整理途中被改写的正文。')
  await fixture.host.sync(fixture.kbId)
  const stale = await runMark(fixture, { processed: [good2.docId], summary: '源文件已变化' })
  expect(stale.organized).toEqual([])
  expect(stale.stale).toEqual([good2.docId])
  const staleDoc = (await fixture.host.listDocs(fixture.kbId)).docs.find(doc => doc.docId === good2.docId)
  expect(staleDoc?.organizedSha256).toBeNull()

  await expect(runMark(fixture, { processed: ['outside-batch-doc'] })).rejects.toThrow(
    /knowledge-organize-doc-not-in-batch/u,
  )
})

it('clears only registered tombstone cards, deletes files before rows, and isolates per-id unlink failures', async () => {
  const fixture = await createFixture({
    files: [{ relPath: 'gone.md', content: '# 已删除\n\n删除前正文。' }],
  })
  const gone = docByPath(fixture, 'gone.md')
  await markCard(fixture, gone)
  rmSync(join(fixture.sourceDir, 'gone.md'))
  await fixture.host.sync(fixture.kbId)
  expect(await tombstoneIds(fixture)).toEqual([gone.docId])

  const dbFile = join(neutralKnowledgeRootPath(fixture.profileDir, fixture.kbId), 'index.sqlite')
  insertTombstoneRow(fixture, { docId: 'tomb-missing', relPath: 'missing.md', wikiNotePath: 'docs/tomb-missing.md' })
  insertTombstoneRow(fixture, { docId: 'tomb-null', relPath: 'null.md', wikiNotePath: null })
  insertTombstoneRow(fixture, { docId: 'tomb-topic', relPath: 'topic.md', wikiNotePath: 'topics/evil.md' })
  insertTombstoneRow(fixture, { docId: 'tomb-valid', relPath: 'valid.md', wikiNotePath: 'docs/tomb-valid.md' })
  insertTombstoneRow(fixture, { docId: 'tomb-fail', relPath: 'fail.md', wikiNotePath: 'docs/tomb-fail.md' })
  writeFileSync(join(fixture.wikiRoot, 'docs', 'tomb-valid.md'), '# 可删\n')
  writeFileSync(join(fixture.wikiRoot, 'docs', 'tomb-fail.md'), '# 删除失败\n')
  mkdirSync(join(fixture.wikiRoot, 'topics'), { recursive: true })
  writeFileSync(join(fixture.wikiRoot, 'topics', 'evil.md'), '# 专题\n')

  const unlinkCalls: string[] = []
  const rowExistedDuringUnlink: Record<string, boolean> = {}
  fixture.toolCtx.huaanworkKnowledgeOrgTestHooks = {
    unlinkFile: async path => {
      unlinkCalls.push(path)
      rowExistedDuringUnlink[basename(path, '.md')] = tombstoneExists(dbFile, basename(path, '.md'))
      if (path.endsWith('tomb-fail.md')) throw new Error('forced-unlink-failure')
      await unlink(path)
    },
  }

  const markSpy = vi.spyOn(fixture.host, 'markOrganizeProcessed')

  // 纯墓碑批：processed 为空，不调用 markOrganizedAtomic；墓碑文件先删、行后删。
  await fixture.host.openOrganizeBatch(fixture.kbId, Date.now())
  const pure = await runMark(fixture, { processed: [], clearedTombstones: [gone.docId] })
  expect(pure.organized).toEqual([])
  expect(pure.clearedTombstones).toEqual([gone.docId])
  expect(markSpy).not.toHaveBeenCalled()
  expect(existsSync(join(fixture.wikiRoot, 'docs', `${gone.docId}.md`))).toBe(false)
  expect(rowExistedDuringUnlink[gone.docId]).toBe(true)
  const pureSettlement = fixture.host.closeOrganizeBatch(fixture.kbId)
  expect(pureSettlement.organizedDocIds).toEqual([])
  expect(pureSettlement.clearedTombstoneIds).toEqual([gone.docId])
  expect(await tombstoneIds(fixture)).not.toContain(gone.docId)

  // 卡片文件已不存在：墓碑仍可清行。
  await fixture.host.openOrganizeBatch(fixture.kbId, Date.now())
  const missing = await runMark(fixture, { processed: [], clearedTombstones: ['tomb-missing'] })
  expect(missing.clearedTombstones).toEqual(['tomb-missing'])
  expect(unlinkCalls.some(path => path.endsWith('tomb-missing.md'))).toBe(false)
  fixture.host.closeOrganizeBatch(fixture.kbId)
  expect(await tombstoneIds(fixture)).not.toContain('tomb-missing')

  // wikiNotePath = null：无卡片可删，直接清行。
  await fixture.host.openOrganizeBatch(fixture.kbId, Date.now())
  const nullPath = await runMark(fixture, { processed: [], clearedTombstones: ['tomb-null'] })
  expect(nullPath.clearedTombstones).toEqual(['tomb-null'])
  expect(unlinkCalls.some(path => path.endsWith('tomb-null.md'))).toBe(false)
  fixture.host.closeOrganizeBatch(fixture.kbId)
  expect(await tombstoneIds(fixture)).not.toContain('tomb-null')

  // 单个 unlink 失败只保留该 id 行；同批其它墓碑照常清除。
  await fixture.host.openOrganizeBatch(fixture.kbId, Date.now())
  const partial = await runMark(fixture, { processed: [], clearedTombstones: ['tomb-fail', 'tomb-valid'] })
  expect(partial.clearedTombstones).toEqual(['tomb-valid'])
  expect(partial.keptTombstones).toEqual(['tomb-fail'])
  expect(existsSync(join(fixture.wikiRoot, 'docs', 'tomb-fail.md'))).toBe(true)
  expect(existsSync(join(fixture.wikiRoot, 'docs', 'tomb-valid.md'))).toBe(false)
  const partialSettlement = fixture.host.closeOrganizeBatch(fixture.kbId)
  expect(partialSettlement.clearedTombstoneIds).toEqual(['tomb-valid'])
  const remaining = await tombstoneIds(fixture)
  expect(remaining).toContain('tomb-fail')
  expect(remaining).not.toContain('tomb-valid')

  // 专题路径墓碑与快照外 docId 一律整次拒绝，合法 id 也不得被部分删除。
  insertTombstoneRow(fixture, { docId: 'tomb-valid2', relPath: 'valid2.md', wikiNotePath: 'docs/tomb-valid2.md' })
  writeFileSync(join(fixture.wikiRoot, 'docs', 'tomb-valid2.md'), '# 合法二\n')
  await fixture.host.openOrganizeBatch(fixture.kbId, Date.now())
  await expect(
    runMark(fixture, { processed: [], clearedTombstones: ['tomb-topic', 'tomb-valid2'] }),
  ).rejects.toThrow(/knowledge-organize-path-invalid/u)
  expect(existsSync(join(fixture.wikiRoot, 'topics', 'evil.md'))).toBe(true)
  expect(existsSync(join(fixture.wikiRoot, 'docs', 'tomb-valid2.md'))).toBe(true)
  const afterReject = await tombstoneIds(fixture)
  expect(afterReject).toContain('tomb-topic')
  expect(afterReject).toContain('tomb-valid2')
  fixture.host.closeOrganizeBatch(fixture.kbId)

  await fixture.host.openOrganizeBatch(fixture.kbId, Date.now())
  await expect(runMark(fixture, { processed: [], clearedTombstones: ['unknown-tombstone'] })).rejects.toThrow(
    /knowledge-organize-tombstone-not-in-batch/u,
  )
  fixture.host.closeOrganizeBatch(fixture.kbId)
})

it('rejects marks that exceed the wiki total-size limit, without any database advance', async () => {
  const fixture = await createFixture({
    files: [{ relPath: 'card.md', content: '# 卡片文档\n\n正文。' }],
  })
  const card = docByPath(fixture, 'card.md')
  await fixture.host.openOrganizeBatch(fixture.kbId, Date.now())
  writeCard(fixture, card.docId, '# 卡片\n\n超过注入上限的正文……')

  fixture.toolCtx.huaanworkKnowledgeOrgTestHooks = { maxWikiTotalBytes: 8 }
  await expect(runMark(fixture, { processed: [card.docId] })).rejects.toThrow(
    /knowledge-organize-wiki-too-large/u,
  )
  const blocked = (await fixture.host.listDocs(fixture.kbId)).docs.find(doc => doc.docId === card.docId)
  expect(blocked?.organizedSha256).toBeNull()

  fixture.toolCtx.huaanworkKnowledgeOrgTestHooks = {}
  const accepted = await runMark(fixture, { processed: [card.docId] })
  expect(accepted.organized).toEqual([card.docId])

  // 跨库 docId 不得进入当前批：read_doc / processed 都拒绝且无副作用。
  const otherSourceDir = join(fixture.root, 'other-source')
  mkdirSync(otherSourceDir, { recursive: true })
  writeFileSync(join(otherSourceDir, 'other.md'), '# 另一个库\n\n另一个库正文。')
  const otherKb = await fixture.host.create({ name: '另一个整理库', sourceDir: otherSourceDir })
  await fixture.host.sync(otherKb.id)
  const otherDoc = (await fixture.host.listDocs(otherKb.id)).docs[0]!
  await expect(runTool(fixture, 'kb_org_read_doc', { docId: otherDoc.docId })).rejects.toThrow(
    /knowledge-organize-doc-not-in-batch/u,
  )
  await expect(runMark(fixture, { processed: [otherDoc.docId] })).rejects.toThrow(
    /knowledge-organize-doc-not-in-batch/u,
  )
  expect((await fixture.host.listDocs(otherKb.id)).docs[0]!.organizedSha256).toBeNull()
})

it('denies non-organizer sessions and denies cleanly when no knowledge host is bound', async () => {
  const fixture = await createFixture({ files: [{ relPath: 'scope.md', content: '# 作用域\n\n正文。' }] })
  await fixture.host.openOrganizeBatch(fixture.kbId, Date.now())

  const userSession = { session: { id: 'plain-user-session' } }
  const validArgs = (name: string): Record<string, unknown> => name === 'kb_org_read_doc'
    ? { docId: fixture.docs[0]!.docId }
    : name === 'kb_org_mark_organized'
      ? { processed: [], summary: '越权调用' }
      : {}
  for (const name of KB_ORG_TOOLS) {
    await expect(runTool(fixture, name, validArgs(name), userSession)).rejects.toThrow(
      /knowledge-organize-session-required/u,
    )
  }

  clearHost?.()
  clearHost = undefined
  expect(getKnowledgeHost()).toBeUndefined()
  for (const name of KB_ORG_TOOLS) {
    await expect(runTool(fixture, name, validArgs(name))).rejects.toThrow(/knowledge-base-unavailable/u)
  }
})

it('clears tombstone rows through the real Storage Worker and never unlinks wiki files there', async () => {
  const client = createKnowledgeStorageClient()
  const kbDir = makeRoot('kb-org-tools-worker-')
  expect((await client.openKb('kb-worker', kbDir)).ok).toBe(true)
  const inserted = await client.upsertDocument(
    'kb-worker',
    documentInput('worker.md', 'sha-worker', 'Worker 墓碑正文'),
  )
  await client.markOrganizedAtomic('kb-worker', inserted.docId, 'sha-worker', `docs/${inserted.docId}.md`)
  expect(await client.deleteDocument('kb-worker', 'worker.md')).toEqual({ deleted: true, tombstoneWritten: true })
  const cardPath = join(kbDir, 'wiki', 'docs', `${inserted.docId}.md`)
  mkdirSync(join(kbDir, 'wiki', 'docs'), { recursive: true })
  writeFileSync(cardPath, '# Worker 卡片\n')

  const cleared = await client.clearOrganizeTombstones('kb-worker', ['missing-tombstone', inserted.docId])
  expect(cleared).toEqual([inserted.docId])
  expect(existsSync(cardPath)).toBe(true)
  expect((await client.getPendingOrganizeBatch('kb-worker', Date.now())).tombstones).toEqual([])
  await client.dispose(900)

  // Worker 与 db 层绝不 import unlink，也不操作 Wiki 文件。
  for (const file of ['storage-worker.ts', 'storage-db.ts']) {
    const source = readFileSync(join(import.meta.dirname, '../../src/huaanwork-host/knowledge', file), 'utf8')
    expect(source).not.toMatch(/\bunlink(?:Sync)?\b/u)
  }
})

it('binds host-ref by ownership and exposes registry id copies excluding deleting ids', async () => {
  const profileA = join(makeRoot('kb-org-tools-ref-a-'), 'profile')
  const profileB = join(makeRoot('kb-org-tools-ref-b-'), 'profile')
  mkdirSync(profileA, { recursive: true })
  mkdirSync(profileB, { recursive: true })
  const hostA = createKnowledgeHost({ profileDir: profileA })
  const hostB = createKnowledgeHost({ profileDir: profileB })
  hosts.push(hostA, hostB)

  const clearA = setKnowledgeHost(hostA)
  const clearB = setKnowledgeHost(hostB)
  expect(getKnowledgeHost()).toBe(hostB)
  clearA()
  expect(getKnowledgeHost()).toBe(hostB)
  clearB()
  expect(getKnowledgeHost()).toBeUndefined()
  clearB()
  expect(getKnowledgeHost()).toBeUndefined()

  const root = makeRoot('kb-org-tools-registry-')
  const profileDir = join(root, 'profile')
  mkdirSync(profileDir, { recursive: true })
  const host = createKnowledgeHost({ profileDir })
  hosts.push(host)
  await host.start()
  const sourceA = join(root, 'source-a')
  const sourceB = join(root, 'source-b')
  mkdirSync(sourceA)
  mkdirSync(sourceB)
  const kbA = await host.create({ name: '库 A', sourceDir: sourceA })
  const kbB = await host.create({ name: '库 B', sourceDir: sourceB })

  const ids = host.getRegisteredKnowledgeBaseIds()
  expect([...ids].sort()).toEqual([kbA.id, kbB.id].sort())
  ;(ids as Set<string>).delete(kbA.id)
  ;(ids as Set<string>).add('mutated-outside')
  expect([...host.getRegisteredKnowledgeBaseIds()].sort()).toEqual([kbA.id, kbB.id].sort())

  let releaseRemove!: () => void
  const removeGate = new Promise<void>(resolve => {
    releaseRemove = resolve
  })
  const cancelSpy = vi.fn(async () => {
    await removeGate
  })
  host.setOrganizerHooks({ cancelForKb: cancelSpy, cancelAll: async () => undefined })
  const removing = host.remove(kbB.id)
  await vi.waitFor(() => {
    expect(cancelSpy).toHaveBeenCalledWith(kbB.id)
  })
  expect(host.getRegisteredKnowledgeBaseIds().has(kbB.id)).toBe(false)
  expect(host.getRegisteredKnowledgeBaseIds().has(kbA.id)).toBe(true)
  releaseRemove()
  await removing
  expect([...host.getRegisteredKnowledgeBaseIds()]).toEqual([kbA.id])
})

it('selects only eligible organize candidates across auto/manual, paused, unavailable, maintaining, deleting and recovery phases', async () => {
  const root = makeRoot('kb-org-tools-candidates-')
  const profileDir = join(root, 'profile')
  mkdirSync(profileDir, { recursive: true })
  const host = createKnowledgeHost({ profileDir })
  hosts.push(host)
  await host.start()
  const makeSource = (name: string): string => {
    const dir = join(root, name)
    mkdirSync(dir)
    writeFileSync(join(dir, 'doc.md'), `# ${name}\n\n正文。`)
    return dir
  }

  const auto = await host.create({ name: '自动库', sourceDir: makeSource('auto') })
  const manual = await host.create({ name: '手动库', sourceDir: makeSource('manual'), autoOrganize: false })
  const paused = await host.create({ name: '暂停库', sourceDir: makeSource('paused') })
  await host.update(paused.id, { watchPaused: true })
  const missingSource = makeSource('missing')
  const missing = await host.create({ name: '失联库', sourceDir: missingSource })
  renameSync(missingSource, `${missingSource}-away`)
  await expect(host.rebuild(missing.id)).rejects.toThrow(/source-unavailable/u)
  expect(host.get(paused.id)?.phase).toBe('watch-paused')
  expect(host.get(missing.id)?.phase).toBe('source-unavailable')

  expect(host.listOrganizeCandidates().map(candidate => candidate.id).sort()).toEqual(
    [auto.id, paused.id, missing.id].sort(),
  )
  expect(host.listOrganizeCandidates(new Set([manual.id])).map(candidate => candidate.id).sort()).toEqual(
    [auto.id, manual.id, paused.id, missing.id].sort(),
  )

  // 维护中：重绑持有 maintainingIds 时不入选，释放后恢复。
  let releaseMaintain!: () => void
  const maintainGate = new Promise<void>(resolve => {
    releaseMaintain = resolve
  })
  const maintainSpy = vi.fn(async () => {
    await maintainGate
  })
  host.setOrganizerHooks({ cancelForKb: maintainSpy, cancelAll: async () => undefined })
  const rebindSource = makeSource('rebind-target')
  const updating = host.update(auto.id, { sourceDir: rebindSource })
  await vi.waitFor(() => {
    expect(maintainSpy).toHaveBeenCalledWith(auto.id)
  })
  expect(host.listOrganizeCandidates().map(candidate => candidate.id)).not.toContain(auto.id)
  releaseMaintain()
  await updating
  expect(host.listOrganizeCandidates().map(candidate => candidate.id)).toContain(auto.id)

  // 删除中：deletingIds 中的 id 不入选，注册 id 副本同样排除。
  let releaseRemove!: () => void
  const removeGate = new Promise<void>(resolve => {
    releaseRemove = resolve
  })
  const removeSpy = vi.fn(async () => {
    await removeGate
  })
  host.setOrganizerHooks({ cancelForKb: removeSpy, cancelAll: async () => undefined })
  const removing = host.remove(paused.id)
  await vi.waitFor(() => {
    expect(removeSpy).toHaveBeenCalledWith(paused.id)
  })
  expect(host.listOrganizeCandidates().map(candidate => candidate.id)).not.toContain(paused.id)
  expect(host.getRegisteredKnowledgeBaseIds().has(paused.id)).toBe(false)
  releaseRemove()
  await removing

  // watch-failed 不阻断阶段 2。
  const failingRoot = makeRoot('kb-org-tools-watch-failed-')
  const failingProfile = join(failingRoot, 'profile')
  mkdirSync(failingProfile, { recursive: true })
  const failingSource = join(failingRoot, 'source')
  mkdirSync(failingSource)
  writeFileSync(join(failingSource, 'doc.md'), '# 监听失败\n\n正文。')
  const failingHost = createKnowledgeHost({
    profileDir: failingProfile,
    watchFactory: () => {
      throw new Error('watch-unavailable-for-test')
    },
  })
  hosts.push(failingHost)
  await failingHost.start()
  const failing = await failingHost.create({ name: '监听失败库', sourceDir: failingSource })
  await failingHost.sync(failing.id)
  expect(failingHost.get(failing.id)?.phase).toBe('watch-failed')
  expect(failingHost.listOrganizeCandidates().map(candidate => candidate.id)).toContain(failing.id)

  // index-error 与 wiki-reset-pending 一律排除。
  const recoveryRoot = makeRoot('kb-org-tools-recovery-')
  const recoveryProfile = join(recoveryRoot, 'profile')
  mkdirSync(recoveryProfile, { recursive: true })
  const recoverySource = join(recoveryRoot, 'source')
  mkdirSync(recoverySource)
  writeFileSync(join(recoverySource, 'doc.md'), '# 恢复\n\n正文。')
  const firstHost = createKnowledgeHost({ profileDir: recoveryProfile })
  hosts.push(firstHost)
  await firstHost.start()
  const recoveryKb = await firstHost.create({ name: '恢复库', sourceDir: recoverySource })
  await firstHost.sync(recoveryKb.id)
  await firstHost.dispose()
  writeFileSync(join(neutralKnowledgeRootPath(recoveryProfile, recoveryKb.id), 'index.sqlite'), 'CORRUPT_FOR_TEST')
  const recoveryHost = createKnowledgeHost({
    profileDir: recoveryProfile,
    failWikiResetOnceForTest: () => undefined,
  })
  hosts.push(recoveryHost)
  await recoveryHost.start()
  expect(recoveryHost.get(recoveryKb.id)?.phase).toBe('index-error')
  expect(recoveryHost.listOrganizeCandidates().map(candidate => candidate.id)).not.toContain(recoveryKb.id)
  await recoveryHost.rebuild(recoveryKb.id)
  expect(recoveryHost.get(recoveryKb.id)?.phase).toBe('wiki-reset-pending')
  expect(recoveryHost.listOrganizeCandidates().map(candidate => candidate.id)).not.toContain(recoveryKb.id)
})

it('does not resurrect a batch when the knowledge base is removed during the storage query', async () => {
  const root = makeRoot('kb-org-tools-open-race-')
  const profileDir = join(root, 'profile')
  const sourceDir = join(root, 'source')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(join(sourceDir, 'race.md'), '# 竞态\n\n正文。')

  const realClient = createKnowledgeStorageClient()
  let releaseQuery!: () => void
  let signalQueried!: () => void
  const queryGate = new Promise<void>(resolve => {
    releaseQuery = resolve
  })
  const queried = new Promise<void>(resolve => {
    signalQueried = resolve
  })
  const racingClient: KnowledgeStorageClient = {
    ...realClient,
    async getPendingOrganizeBatch(kbId, nowMs, opts) {
      const result = await realClient.getPendingOrganizeBatch(kbId, nowMs, opts)
      signalQueried()
      await queryGate
      return result
    },
  }
  const host = createKnowledgeHost({ profileDir, storageOverrideForTest: racingClient })
  hosts.push(host)
  await host.start()
  const kb = await host.create({ name: '竞态库', sourceDir })
  await host.sync(kb.id)

  const opening = host.openOrganizeBatch(kb.id, Date.now())
  await queried
  await host.remove(kb.id)
  releaseQuery()
  await expect(opening).rejects.toThrow(/knowledge-base-not-found/u)
  expect(() => host.getOpenOrganizeBatch(kb.id)).toThrow(/knowledge-organize-batch-not-open/u)
})
