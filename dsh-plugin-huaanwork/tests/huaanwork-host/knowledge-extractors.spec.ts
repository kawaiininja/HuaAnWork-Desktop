import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openVerifiedSourceFile, readAndHashHandle, walkSourceDirectory } from '../../src/huaanwork-host/knowledge/safe-read.ts'
import { computeExtractConfigHash, extractFromBuffer, TEXT_EXTENSIONS } from '../../src/huaanwork-host/knowledge/extractors/index.ts'
import {
  buildEncryptedZipBuffer,
  buildForgedZeroSizeZipBombDocx,
  buildMinimalChineseCidPdf,
  buildMinimalDocx,
  buildMinimalPptx,
  buildMinimalXlsx,
  buildOverEntryLimitZipDocx,
} from '../fixtures/knowledge/generators.ts'

const DIR_SYMLINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

describe('knowledge safe-read chain and document extractors', () => {
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
})
