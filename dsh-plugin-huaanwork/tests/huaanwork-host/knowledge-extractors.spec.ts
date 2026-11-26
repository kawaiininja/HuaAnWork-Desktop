import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExtractionPool } from '../../src/huaanwork-host/knowledge/extraction-pool.ts'
import { hashHandle, openVerifiedSourceFile, readAndHashHandle, walkSourceDirectory } from '../../src/huaanwork-host/knowledge/safe-read.ts'
import { computeExtractConfigHash, extractFromBuffer, TEXT_EXTENSIONS } from '../../src/huaanwork-host/knowledge/extractors/index.ts'
import { decodeHtmlEntities } from '../../src/huaanwork-host/knowledge/extractors/text.ts'
import {
  buildDocxWithTabsAndBreaks,
  buildEncryptedZipBuffer,
  buildForgedZeroSizeZipBombDocx,
  buildMinimalChineseCidPdf,
  buildMinimalDocx,
  buildMinimalPptx,
  buildMinimalXlsx,
  buildOverEntryLimitZipDocx,
  buildPasswordProtectedPdf,
  buildRichSelfClosingXlsx,
  buildValidZip64Docx,
  buildWorkbookBombXlsx,
  buildZipBuffer,
} from '../fixtures/knowledge/generators.ts'

const DIR_SYMLINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'
const extractorTempDirs: string[] = []
function makeExtractorTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  extractorTempDirs.push(dir)
  return dir
}

describe('knowledge safe-read chain and document extractors', () => {
  afterEach(() => {
    for (const dir of extractorTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  it('blocks outside symlinks/junctions, loops, inode replacement, and oversized files; allows in-source links via single FileHandle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-safe-'))
    const sourceDir = join(root, 'src')
    const outsideDir = join(root, 'outside')
    mkdirSync(join(sourceDir, 'sub', 'inner'), { recursive: true })
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(join(outsideDir, 'secret.txt'), 'TOP_SECRET')
    writeFileSync(join(sourceDir, 'ok.txt'), 'hello')
    writeFileSync(join(sourceDir, 'sub', 'inner', 'inside.txt'), 'in-source-target')
    writeFileSync(join(sourceDir, 'big.txt'), 'x'.repeat(2_048))

    symlinkSync(outsideDir, join(sourceDir, 'escape-dir'), DIR_SYMLINK_TYPE)
    symlinkSync(sourceDir, join(sourceDir, 'sub', 'loop'), DIR_SYMLINK_TYPE)
    // In-source valid directory link / Windows junction (R3-I4)
    symlinkSync(join(sourceDir, 'sub', 'inner'), join(sourceDir, 'inside-dir-link'), DIR_SYMLINK_TYPE)

    let hasFileSymlinks = true
    try {
      symlinkSync(join(outsideDir, 'secret.txt'), join(sourceDir, 'escape-file.txt'))
      symlinkSync(join(sourceDir, 'ok.txt'), join(sourceDir, 'inside-file-link.txt'))
    } catch (err) {
      if (process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'EPERM') {
        hasFileSymlinks = false
      } else {
        throw err
      }
    }

    const walked = await walkSourceDirectory(sourceDir)
    expect(walked.skipped.some(s => s.reason === 'symlink-outside-source')).toBe(true)
    expect(walked.skipped.some(s => s.reason === 'symlink-loop')).toBe(true)
    // M-17: skipped entries are the documented public shape { relPath, reason }.
    for (const entry of walked.skipped) {
      expect(Object.keys(entry).sort()).toEqual(['reason', 'relPath'])
    }
    expect(walked.files.some(f => f.relPath === 'ok.txt')).toBe(true)

    if (hasFileSymlinks) {
      const outsideRes = await openVerifiedSourceFile(sourceDir, join(sourceDir, 'escape-file.txt'))
      expect(outsideRes).toMatchObject({ ok: false, reason: 'symlink-outside-source' })

      // In-source valid file symlink opens once and reads strictly from the verified FileHandle
      const insideFileRes = await openVerifiedSourceFile(sourceDir, join(sourceDir, 'inside-file-link.txt'))
      expect(insideFileRes.ok).toBe(true)
      if (insideFileRes.ok) {
        try {
          const read = await readAndHashHandle(insideFileRes.handle, 1_024)
          expect(read.ok).toBe(true)
          if (read.ok) expect(read.buffer.toString('utf8')).toBe('hello')
        } finally {
          await insideFileRes.handle.close()
        }
      }
    }

    // Outside directory junction/symlink target is also blocked at openVerifiedSourceFile
    const outsideDirRes = await openVerifiedSourceFile(sourceDir, join(sourceDir, 'escape-dir', 'secret.txt'))
    expect(outsideDirRes).toMatchObject({ ok: false, reason: 'symlink-outside-source' })

    // In-source directory junction/symlink target succeeds via single FileHandle
    const insideDirRes = await openVerifiedSourceFile(sourceDir, join(sourceDir, 'inside-dir-link', 'inside.txt'))
    expect(insideDirRes.ok).toBe(true)
    if (insideDirRes.ok) {
      try {
        const read = await readAndHashHandle(insideDirRes.handle, 1_024)
        expect(read.ok).toBe(true)
        if (read.ok) expect(read.buffer.toString('utf8')).toBe('in-source-target')
      } finally {
        await insideDirRes.handle.close()
      }
    }

    const bigRes = await openVerifiedSourceFile(sourceDir, join(sourceDir, 'big.txt'), { maxBytes: 1_024 })
    expect(bigRes).toMatchObject({ ok: false, reason: 'file-too-large' })

    // M-17: a path through a directory link loop is rejected at open time.
    const loopRes = await openVerifiedSourceFile(sourceDir, join(sourceDir, 'sub', 'loop', 'ok.txt'))
    expect(loopRes).toMatchObject({ ok: false, reason: 'symlink-loop' })

    // readAndHashHandle only consumes the verified handle and aborts over budget.
    const bigOpen = await openVerifiedSourceFile(sourceDir, join(sourceDir, 'big.txt'), { maxBytes: 4_096 })
    expect(bigOpen.ok).toBe(true)
    if (bigOpen.ok) {
      try {
        expect(await readAndHashHandle(bigOpen.handle, 1_024)).toMatchObject({ ok: false, reason: 'file-too-large' })
      } finally {
        await bigOpen.handle.close()
      }
    }

    // Simulate TOCTOU replacement between pre-lstat and open
    const target = join(sourceDir, 'swap.txt')
    const replacement = join(sourceDir, 'swap-new.txt')
    writeFileSync(target, 'v1')
    writeFileSync(replacement, 'v2')
    const swapped = await openVerifiedSourceFile(sourceDir, target, {
      beforeOpenHook: () => { renameSync(replacement, target) },
    })
    expect(swapped).toMatchObject({ ok: false, reason: 'inode-replaced' })
  })

  it.each([
    ['.md', '# 标题\n正文'],
    ['.txt', '纯文本说明'],
    ['.csv', 'code,rate\n001,1.5%'],
    ['.tsv', 'code\trate\n001\t1.5%'],
    ['.json', '{"fund":"A","rate":0.015}'],
    ['.yaml', 'fund: A\nrate: 0.015'],
    ['.yml', 'fund: B\nrate: 0.02'],
    ['.xml', '<policy><rule>合规</rule></policy>'],
    ['.html', '<h1>风控规则</h1><p>禁止越权</p>'],
    ['.htm', '<p>旧版页面</p>'],
    ['.ts', 'export const rate = 0.015\n'],
    ['.py', 'def calc_rate():\n    return 0.015\n'],
    ['.sql', 'SELECT rate FROM funds;\n'],
  ] as const)('extracts M1 text/code/table format %s with line locator', async (ext, content) => {
    const doc = await extractFromBuffer({ buffer: Buffer.from(content, 'utf8'), ext })
    expect(doc.status).toBe('indexed')
    expect(doc.sections[0]?.locator.kind).toBe('line')
    expect(doc.sections.map(s => s.text).join('\n').length).toBeGreaterThan(0)
  })

  it('extracts GB18030, HTML, DOCX/XLSX/PPTX, Chinese CID PDF, skips audio/video, and blocks forged size=0 zip bombs & encrypted archives', async () => {
    const cfg1 = computeExtractConfigHash()
    const cfg2 = computeExtractConfigHash({ visionEnabled: true, visionModelId: 'vlm-1' })
    expect(cfg1).not.toBe(cfg2)

    // GB18030 Chinese text (bytes for "合规审查" in GB18030: ba cf b9 e6 c9 f3 b2 e9)
    const gbBuf = Buffer.from([0xba, 0xcf, 0xb9, 0xe6, 0xc9, 0xf3, 0xb2, 0xe9])
    const gbDoc = await extractFromBuffer({ buffer: gbBuf, ext: '.txt' })
    expect(gbDoc.status).toBe('indexed')
    expect(gbDoc.sections[0]?.text).toContain('合规审查')

    // HTML strips tags and keeps heading + line locator
    const htmlDoc = await extractFromBuffer({
      buffer: Buffer.from('<html><body><h1>风控规则</h1><p>禁止越权</p></body></html>'),
      ext: '.html',
    })
    expect(htmlDoc.sections.map(s => s.text).join(' ')).toContain('禁止越权')
    expect(htmlDoc.sections[0]?.locator.kind).toBe('line')
    // R3-I5: headings survive tag stripping and stay in headingPath.
    expect(htmlDoc.sections.some(s => s.headingPath.includes('风控规则'))).toBe(true)

    // OOXML normal extraction
    const docx = await extractFromBuffer({ buffer: buildMinimalDocx('产品合规说明书'), ext: '.docx' })
    expect(docx.status).toBe('indexed')
    expect(docx.sections.map(s => s.text).join('\n')).toContain('产品合规说明书')

    const xlsx = await extractFromBuffer({ buffer: buildMinimalXlsx('表1', [['代码', '税率'], ['001', '1.5%']]), ext: '.xlsx' })
    expect(xlsx.status).toBe('indexed')
    expect(xlsx.sections[0]?.headerRow).toContain('代码')
    expect(xlsx.sections[0]?.locator.kind).toBe('sheet')

    const pptx = await extractFromBuffer({ buffer: buildMinimalPptx(['第一页 基金概览']), ext: '.pptx' })
    expect(pptx.status).toBe('indexed')
    expect(pptx.sections[0]?.locator).toEqual({ kind: 'slide', slide: 1 })

    // B-1 regression: forged Central Directory header.size = 0 zip bomb inflating > 20 MB MUST fail-closed without OOM
    const forgedBomb = await extractFromBuffer({ buffer: buildForgedZeroSizeZipBombDocx(25 * 1024 * 1024), ext: '.docx' })
    expect(forgedBomb).toMatchObject({ status: 'skipped', statusReason: 'zip-limit-exceeded' })

    const overEntries = await extractFromBuffer({ buffer: buildOverEntryLimitZipDocx(2_005), ext: '.docx' })
    expect(overEntries).toMatchObject({ status: 'skipped', statusReason: 'zip-limit-exceeded' })

    const encryptedZip = await extractFromBuffer({ buffer: buildEncryptedZipBuffer(), ext: '.docx' })
    expect(encryptedZip).toMatchObject({ status: 'skipped', statusReason: 'encrypted' })

    // Password-protected Office OOXML is wrapped in OLE2 (magic D0 CF 11 E0 A1 B1 1A E1)
    const ole2EncryptedDocx = await extractFromBuffer({ buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]), ext: '.docx' })
    expect(ole2EncryptedDocx).toMatchObject({ status: 'skipped', statusReason: 'encrypted' })

    // Real Chinese CID PDF with CMap
    const pdfDoc = await extractFromBuffer({ buffer: buildMinimalChineseCidPdf(), ext: '.pdf' })
    expect(pdfDoc.status).toBe('indexed')
    expect(pdfDoc.sections[0]?.locator).toEqual({ kind: 'page', page: 1, mode: 'text' })
    expect(pdfDoc.sections.map(s => s.text).join('')).toMatch(/[\u4e00-\u9fff]/u)

    // Audio / video directly skipped
    expect(await extractFromBuffer({ buffer: Buffer.from('000'), ext: '.mp4' })).toMatchObject({ status: 'skipped', statusReason: 'unsupported-media' })
    expect(await extractFromBuffer({ buffer: Buffer.from('000'), ext: '.mp3' })).toMatchObject({ status: 'skipped', statusReason: 'unsupported-media' })
  })

  it('covers the whole M1 TEXT_EXTENSIONS matrix', async () => {
    for (const ext of TEXT_EXTENSIONS) {
      const doc = await extractFromBuffer({ buffer: Buffer.from('合规审查 2026', 'utf8'), ext })
      expect(doc.status, ext).toBe('indexed')
      expect(doc.sections[0]?.locator.kind, ext).toBe('line')
    }
  })

  it('caps text at maxDocTextBytes with a partial status and never splits UTF-8 characters', async () => {
    const content = '合规审查'.repeat(1_000)
    const budget = 1_001
    const doc = await extractFromBuffer({ buffer: Buffer.from(content, 'utf8'), ext: '.txt', maxDocTextBytes: budget })
    expect(doc.status).toBe('partial')
    expect(doc.statusReason).toBe('text-truncated')
    const text = doc.sections.map(s => s.text).join('\n')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(budget)
    expect(text).not.toContain('\uFFFD')
  })

  it('blocks @napi-rs/canvas in Extraction Worker & dev/test (I-1) and decodes Chinese CID PDF without inline ToUnicode (M-5)', async () => {
    const pdfBytes = buildMinimalChineseCidPdf()
    // M-5：样本不含内联 /ToUnicode，强制依赖 pdfjs 预定义 CMap（UniGB-UCS2-H + Adobe-GB1-UCS2）。
    expect(pdfBytes.toString('latin1')).not.toContain('/ToUnicode')

    const dir = mkdtempSync(join(tmpdir(), 'kb-pdf-no-canvas-'))
    const pdfPath = join(dir, 'cid-only.pdf')
    writeFileSync(pdfPath, pdfBytes)

    const pool = createExtractionPool({ maxWorkers: 1 })
    try {
      const extracted = await pool.extractFile('kb-pdf', {
        sourceRoot: dir,
        filePath: pdfPath,
        relPath: 'cid-only.pdf',
      })
      expect(extracted.ok).toBe(true)
      if (extracted.ok && extracted.hashOnly !== true) {
        const text = extracted.doc.sections.map(s => s.text).join('')
        expect(text).toContain('产品合规说明书')
      }
    } finally {
      await pool.dispose()
    }

    // I-1：当前进程执行过 pdf-text 后，@napi-rs/canvas 解析被 registerHooks 拦截且未进入 require.cache。
    const req = createRequire(import.meta.url)
    expect(() => req('@napi-rs/canvas')).toThrow(/MODULE_NOT_FOUND|disabled/u)
    expect(Object.keys(req.cache).filter(key => key.includes('@napi-rs/canvas'))).toEqual([])
  })

  it('handles self-closing OOXML tags (C-3), tabs/breaks, ZIP64, workbook bombs, ReDoS, entities, UTF-16 BOM, code fences, and encrypted PDF (I-8 / M-5)', async () => {
    // C-3 + M-5：自闭合 <c/> / <row/> / <t/>、多 <t> 内联串、单引号属性与 workbook.xml.rels 映射。
    const richXlsx = await extractFromBuffer({ buffer: buildRichSelfClosingXlsx(), ext: '.xlsx' })
    expect(richXlsx.status).toBe('indexed')
    const sheet1Section = richXlsx.sections.find(s => s.headingPath === '附表甲')
    const sheet2Section = richXlsx.sections.find(s => s.headingPath === '风控总表')
    expect(sheet1Section).toBeDefined()
    expect(sheet1Section?.text).toContain('列头甲')
    expect(sheet1Section?.text).toContain('第一条关键数据')
    expect(sheet1Section?.text).toContain('合规')
    expect(sheet1Section?.locator).toEqual({ kind: 'sheet', sheet: '附表甲', rowStart: 1, rowEnd: 5 })
    expect(sheet2Section?.text).toContain('空后拼接')

    // I-8：DOCX 真实 <w:tab/> / <w:br/> 与字面 &lt;w:br/&gt; 不串扰。
    const tabDocx = await extractFromBuffer({ buffer: buildDocxWithTabsAndBreaks(), ext: '.docx' })
    expect(tabDocx.status).toBe('indexed')
    const tabText = tabDocx.sections.map(s => s.text).join('\n')
    expect(tabText).toContain('列一\t列二\n字面<w:br/>保持原样')

    // I-8：xl/workbook.xml 炸弹不再被吞掉。
    const wbBomb = await extractFromBuffer({ buffer: buildWorkbookBombXlsx(), ext: '.xlsx' })
    expect(wbBomb).toMatchObject({ status: 'skipped', statusReason: 'zip-limit-exceeded' })

    // I-8：合法 ZIP64 归档（EOCD 0xFFFF）正常解析。
    const zip64Doc = await extractFromBuffer({ buffer: buildValidZip64Docx('ZIP64 正常内容'), ext: '.docx' })
    expect(zip64Doc.status).toBe('indexed')
    expect(zip64Doc.sections[0]?.text).toContain('ZIP64 正常内容')

    // I-8：未闭合标签恶意输入保持 O(N) 线性耗时（无 ReDoS 回溯）。
    const t0 = performance.now()
    const malformedDocx = buildZipBuffer([
      { name: 'word/document.xml', data: Buffer.from('<w:p>'.repeat(30_000), 'utf8') },
    ])
    const malformedRes = await extractFromBuffer({ buffer: malformedDocx, ext: '.docx' })
    expect(malformedRes.status).toBe('indexed')
    const malformedHtml = await extractFromBuffer({
      buffer: Buffer.from(`${'<!--'.repeat(20_000)}${'<script>'.repeat(20_000)}<p>正文</p>`, 'utf8'),
      ext: '.html',
    })
    expect(malformedHtml.status).toBe('indexed')
    expect(performance.now() - t0).toBeLessThan(1_000)

    // I-8：HTML 实体解码拒绝原型链属性、畸形十进制与孤立代理。
    expect(decodeHtmlEntities('&constructor; &toString; &#12abc; &#0; &#xD800; &amp; &#65; &#x4E2D;'))
      .toBe('&constructor; &toString; &#12abc; &#0; &#xD800; & A 中')

    // I-8 / M-5：UTF-16LE / UTF-16BE BOM 解码与二进制 NUL 检测。
    const utf16Le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文UTF16LE', 'utf16le')])
    const leDoc = await extractFromBuffer({ buffer: utf16Le, ext: '.txt' })
    expect(leDoc.status).toBe('indexed')
    expect(leDoc.sections[0]?.text).toContain('中文UTF16LE')
    const utf16BePayload = Buffer.from('中文UTF16BE', 'utf16le')
    for (let i = 0; i + 1 < utf16BePayload.length; i += 2) {
      const lo = utf16BePayload[i]!
      utf16BePayload[i] = utf16BePayload[i + 1]!
      utf16BePayload[i + 1] = lo
    }
    const beDoc = await extractFromBuffer({ buffer: Buffer.concat([Buffer.from([0xfe, 0xff]), utf16BePayload]), ext: '.txt' })
    expect(beDoc.status).toBe('indexed')
    expect(beDoc.sections[0]?.text).toContain('中文UTF16BE')
    expect(await extractFromBuffer({ buffer: Buffer.from([0x41, 0x00, 0x42, 0x00]), ext: '.txt' }))
      .toMatchObject({ status: 'skipped', statusReason: 'binary-content' })

    // M-5：Markdown 代码块内的 # 注释不污染 headingPath；HTML 多行标题折叠为单行。
    const mdFence = await extractFromBuffer({
      buffer: Buffer.from('# 真标题\n```bash\n# 代码注释不是标题\necho ok\n```\n正文\n', 'utf8'),
      ext: '.md',
    })
    expect(mdFence.sections.every(s => !s.headingPath.includes('代码注释不是标题'))).toBe(true)
    const multiLineH1 = await extractFromBuffer({
      buffer: Buffer.from('<h1>第一行\n第二行</h1><p>内容</p>', 'utf8'),
      ext: '.html',
    })
    expect(multiLineH1.sections.some(s => s.headingPath === '第一行 第二行')).toBe(true)

    // I-8：密码保护 PDF 归类为 skipped: 'encrypted'（与 OOXML 对齐）。
    const encPdf = await extractFromBuffer({ buffer: buildPasswordProtectedPdf(), ext: '.pdf' })
    expect(encPdf).toMatchObject({ status: 'skipped', statusReason: 'encrypted' })
  })

  it('blocks in-source UNC symlinks (C-4), stops subdir loops on hop 1 and realpath-mismatched checkPathSegments (I-5), streams hashHandle (I-8), maps open ELOOP to inode-replaced (M-5), and marks 500-chunk truncation as partial (I-6)', async () => {
    const root = makeExtractorTempDir('kb-safe-c4-i5-')
    const src = join(root, 'src')
    mkdirSync(join(src, 'sub', 'child'), { recursive: true })
    writeFileSync(join(src, 'sub', 'child', 'doc.txt'), 'hello-stream')
    symlinkSync(join(src, 'sub'), join(src, 'sub', 'child', 'loop-back'), DIR_SYMLINK_TYPE)

    if (process.platform !== 'win32') {
      symlinkSync('\\\\evil\\share\\secret.txt', join(src, 'unc-inside.txt'))
    }

    // I-5：非根子目录环 sub/child/loop-back -> sub 在首跳即被阻断，不重复产出 doc.txt。
    const walked = await walkSourceDirectory(src)
    expect(walked.files.filter(f => f.relPath.endsWith('doc.txt'))).toHaveLength(1)
    expect(walked.skipped.some(s => s.relPath === 'sub/child/loop-back' && s.reason === 'symlink-loop')).toBe(true)
    if (process.platform !== 'win32') {
      expect(walked.skipped.some(s => s.relPath === 'unc-inside.txt' && s.reason === 'symlink-outside-source')).toBe(true)
      await expect(openVerifiedSourceFile(src, join(src, 'unc-inside.txt')))
        .resolves.toMatchObject({ ok: false, reason: 'symlink-outside-source' })
    }

    // I-5：sourceRoot 为词法符号链接而 candidatePath 已是 realpath 时，checkPathSegments 仍有效拦住目录环。
    const realSrc = realpathSync(src)
    const lexicalSrcLink = join(root, 'lexical-src')
    symlinkSync(realSrc, lexicalSrcLink, DIR_SYMLINK_TYPE)
    await expect(openVerifiedSourceFile(lexicalSrcLink, join(realSrc, 'sub', 'child', 'loop-back', 'child', 'doc.txt')))
      .resolves.toMatchObject({ ok: false, reason: 'symlink-loop' })

    // I-8：hashHandle 与 readAndHashHandle 结果一致。
    const docFile = join(src, 'sub', 'child', 'doc.txt')
    const h1 = await openVerifiedSourceFile(src, docFile)
    const h2 = await openVerifiedSourceFile(src, docFile)
    expect(h1.ok && h2.ok).toBe(true)
    if (h1.ok && h2.ok) {
      try {
        const full = await readAndHashHandle(h1.handle)
        const streamed = await hashHandle(h2.handle)
        expect(full.ok && streamed.ok).toBe(true)
        if (full.ok && streamed.ok) expect(streamed.sha256).toBe(full.sha256)
      } finally {
        await h1.handle.close()
        await h2.handle.close()
      }
    }

    // M-5：beforeOpenHook 将普通文件替换为符号链接时，POSIX open(O_NOFOLLOW) 的 ELOOP 映射为 inode-replaced。
    if (process.platform !== 'win32') {
      const swapFile = join(src, 'toctou-link.txt')
      writeFileSync(swapFile, 'original')
      const res = await openVerifiedSourceFile(src, swapFile, {
        beforeOpenHook: () => {
          unlinkSync(swapFile)
          symlinkSync(docFile, swapFile)
        },
      })
      expect(res).toMatchObject({ ok: false, reason: 'inode-replaced' })
    }

    // I-6：超过 500 切片但未超 10 MB 文本上限的大文件必须提升为 status: 'partial', statusReason: 'text-truncated'。
    const hugeMd = join(src, 'over-500-chunks.md')
    writeFileSync(hugeMd, Array.from({ length: 520 }, (_, i) => `# 章节 ${String(i)}\n段落内容 ${'甲'.repeat(20)}`).join('\n'))
    const pool = createExtractionPool({ maxWorkers: 1 })
    try {
      const extracted = await pool.extractFile('kb-500', {
        sourceRoot: src,
        filePath: hugeMd,
        relPath: 'over-500-chunks.md',
      })
      expect(extracted.ok).toBe(true)
      if (extracted.ok && extracted.hashOnly !== true) {
        expect(extracted.truncated).toBe(true)
        expect(extracted.chunks).toHaveLength(500)
        expect(extracted.doc.status).toBe('partial')
        expect(extracted.doc.statusReason).toBe('text-truncated')
      }
    } finally {
      await pool.dispose()
    }
  })
})
