/**
 * 现代 Office（.docx / .xlsx / .pptx）纯 JS 提取器（规格 §6.2 / 计划 Task 5）。
 *
 * **B-1 防炸弹硬约束**：
 * - 绝不调用 `entry.getData()` / `entry.getDataAsync()`（它们按中央目录声明
 *   的尺寸一次性解压进堆，伪造 `header.size = 0` 的炸弹可借此 OOM）；
 * - 只允许 stored（0）与 deflated（8）两种压缩方法，加密 / WinZip AES
 *   直接 `skipped: 'encrypted'`；
 * - 解压经 `node:zlib` 的 `inflateRawSync(raw, { maxOutputLength })`，当前
 *   条目上限取 `min(MAX_ZIP_ENTRY_BYTES, MAX_ZIP_TOTAL_BYTES - 已解压)`，
 *   `ERR_BUFFER_TOO_LARGE` 映射为 `skipped: 'zip-limit-exceeded'`；
 * - 条目数受 `MAX_ZIP_ENTRIES` 约束；解密失败的 OLE2 容器（密码保护
 *   OOXML）按魔数 `D0 CF 11 E0 A1 B1 1A E1` 直接识别为加密。
 *
 * XML 解析是零依赖轻量正则提取：`<w:p>` / `<w:t>`、`<si><t>` +
 * `<row><c><v>`（随 section 保留表头行）、`<a:p>` / `<a:t>`。
 *
 * 本文件会被 Worker / 测试以 `.ts` 源码直接加载（Node type-stripping），
 * 因此不得使用 `enum`、构造器参数属性或 `namespace`；纯类型导入必须写
 * `import type`，相对导入保留 `.ts` 后缀。
 */

import { inflateRawSync } from 'node:zlib'

import AdmZip from 'adm-zip'

import { MAX_DOC_TEXT_BYTES, MAX_ZIP_ENTRIES, MAX_ZIP_ENTRY_BYTES, MAX_ZIP_TOTAL_BYTES } from '../types.ts'
import type { ExtractedDocument, ExtractedSection } from '../types.ts'
import { applySectionTextBudget, decodeHtmlEntities } from './text.ts'

type AdmZipEntry = AdmZip.IZipEntry

const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ZIP_METHOD_STORED = 0
const ZIP_METHOD_DEFLATED = 8
const ZIP_METHOD_WINZIP_AES = 99

/** 单 section 的段落 / 行数软上限。 */
const DOCX_SECTION_PARAGRAPHS = 100
const XLSX_SECTION_ROWS = 200

export interface OoxmlExtractionInput {
  readonly buffer: Buffer
  readonly ext: string
  readonly extractConfigHash: string
  readonly maxDocTextBytes: number
}

export type OoxmlSkipReason =
  | 'encrypted'
  | 'unsupported-compression'
  | 'zip-limit-exceeded'
  | 'corrupt-archive'

interface InflateFailure {
  readonly ok: false
  readonly reason: OoxmlSkipReason
  readonly error?: string
}

interface InflateSuccess {
  readonly ok: true
  readonly data: Buffer
  readonly totalInflated: number
}

type InflateResult = InflateSuccess | InflateFailure

function isBufferTooLarge(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 按防炸弹协议读取一个 ZIP 条目的原始字节：只允许 stored / deflated，
 * 单条与累计解压量都受硬上限约束，绝不触碰 `getData()`。
 */
function inflateEntry(entry: AdmZipEntry, totalInflated: number): InflateResult {
  const header = entry.header
  if (header.encrypted === true || header.method === ZIP_METHOD_WINZIP_AES) {
    return { ok: false, reason: 'encrypted' }
  }
  if (header.method !== ZIP_METHOD_STORED && header.method !== ZIP_METHOD_DEFLATED) {
    return { ok: false, reason: 'unsupported-compression' }
  }
  const raw = entry.getCompressedData()
  const limit = Math.min(MAX_ZIP_ENTRY_BYTES, MAX_ZIP_TOTAL_BYTES - totalInflated)
  if (limit <= 0) return { ok: false, reason: 'zip-limit-exceeded' }
  if (header.method === ZIP_METHOD_STORED) {
    if (raw.byteLength > limit) return { ok: false, reason: 'zip-limit-exceeded' }
    return { ok: true, data: raw, totalInflated: totalInflated + raw.byteLength }
  }
  try {
    const inflated = inflateRawSync(raw, { maxOutputLength: limit })
    return { ok: true, data: inflated, totalInflated: totalInflated + inflated.byteLength }
  } catch (error) {
    if (isBufferTooLarge(error)) return { ok: false, reason: 'zip-limit-exceeded' }
    return { ok: false, reason: 'corrupt-archive', error: errorMessage(error) }
  }
}

interface DocumentBase {
  readonly format: string
  readonly extractConfigHash: string
}

function skippedDocument(
  base: DocumentBase,
  reason: OoxmlSkipReason,
  extractMode: ExtractedDocument['extractMode'] = 'none',
): ExtractedDocument {
  return {
    format: base.format,
    extractMode,
    extractConfigHash: base.extractConfigHash,
    status: 'skipped',
    statusReason: reason,
    sections: [],
  }
}

function errorDocument(base: DocumentBase, reason: string): ExtractedDocument {
  return {
    format: base.format,
    extractMode: 'none',
    extractConfigHash: base.extractConfigHash,
    status: 'error',
    statusReason: reason,
    sections: [],
  }
}

interface XmlElementMatch {
  readonly attrs: string
  readonly body: string
  readonly selfClosing: boolean
}

function isXmlWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 13 || code === 10
}

function isTagNameBoundary(code: number): boolean {
  return isXmlWhitespace(code) || code === 62 /* '>' */ || code === 47 /* '/' */
}

/**
 * 线性定位开始标签的 `>`（跳过单/双引号属性值中的 `/` 与 `>`），并判定是否自闭合。
 */
function findTagOpenEnd(xml: string, afterNamePos: number): { readonly end: number; readonly selfClosing: boolean } {
  let quote = 0
  for (let index = afterNamePos; index < xml.length; index += 1) {
    const code = xml.charCodeAt(index)
    if (quote !== 0) {
      if (code === quote) quote = 0
      continue
    }
    if (code === 34 /* '"' */ || code === 39 /* '\'' */) {
      quote = code
      continue
    }
    if (code === 62 /* '>' */) {
      let prev = index - 1
      while (prev >= afterNamePos && isXmlWhitespace(xml.charCodeAt(prev))) prev -= 1
      return { end: index, selfClosing: prev >= afterNamePos && xml.charCodeAt(prev) === 47 /* '/' */ }
    }
  }
  return { end: -1, selfClosing: false }
}

/** 线性查找 `</tagName>`（允许闭合标签名与 `>` 之间存在空白）。 */
function findClosingTag(
  xml: string,
  closePrefix: string,
  fromIndex: number,
): { readonly contentEnd: number; readonly tagEnd: number } | null {
  let pos = fromIndex
  while (pos < xml.length) {
    const idx = xml.indexOf(closePrefix, pos)
    if (idx === -1) return null
    let after = idx + closePrefix.length
    while (after < xml.length && isXmlWhitespace(xml.charCodeAt(after))) after += 1
    if (after < xml.length && xml.charCodeAt(after) === 62 /* '>' */) {
      return { contentEnd: idx, tagEnd: after + 1 }
    }
    pos = idx + closePrefix.length
  }
  return null
}

/**
 * O(N) 线性扫描指定 XML 标签（C-3 + I-8 修复）：
 * - 正确识别自闭合标签（`<c r="A1" s="3"/>`、`<row/>`、`<w:t/>`），绝不跨标签吞噬后续兄弟节点；
 * - 遇未闭合恶意标签时 `findClosingTag` 首次返回 `null` 即退出，彻底消除 O(N²) 正则回溯 DoS。
 */
function* iterateXmlElements(xml: string, tagName: string): Generator<XmlElementMatch> {
  const openPrefix = `<${tagName}`
  const closePrefix = `</${tagName}`
  let pos = 0
  while (pos < xml.length) {
    const openIdx = xml.indexOf(openPrefix, pos)
    if (openIdx === -1) break
    const afterName = openIdx + openPrefix.length
    if (afterName >= xml.length || !isTagNameBoundary(xml.charCodeAt(afterName))) {
      pos = afterName
      continue
    }
    const { end: openEnd, selfClosing } = findTagOpenEnd(xml, afterName)
    if (openEnd === -1) break
    const attrsEnd = selfClosing
      ? xml.lastIndexOf('/', openEnd - 1)
      : openEnd
    const attrs = attrsEnd > afterName ? xml.slice(afterName, attrsEnd) : ''
    if (selfClosing) {
      yield { attrs, body: '', selfClosing: true }
      pos = openEnd + 1
      continue
    }
    const close = findClosingTag(xml, closePrefix, openEnd + 1)
    if (close === null) break
    yield { attrs, body: xml.slice(openEnd + 1, close.contentEnd), selfClosing: false }
    pos = close.tagEnd
  }
}

/** 提取指定标签名（如 `a:t` / `t`）的全部文本片段并反转义 XML 实体。 */
function collectTagTexts(xml: string, tagName: string): string {
  const parts: string[] = []
  for (const el of iterateXmlElements(xml, tagName)) {
    if (!el.selfClosing && el.body !== '') parts.push(decodeHtmlEntities(el.body))
  }
  return parts.join('')
}

/**
 * 按文档顺序单遍扫描 Word 段落中的 `<w:t>`、`<w:tab/>`、`<w:br/>` / `<w:cr/>`（I-8 修复）：
 * 只对 `<w:t>` 正文解码实体，真实制表符与软换行原位输出，且绝不误改字面文本 `&lt;w:br/&gt;`。
 */
function extractWordParagraphText(xml: string): string {
  const parts: string[] = []
  let pos = 0
  while (pos < xml.length) {
    const idx = xml.indexOf('<w:', pos)
    if (idx === -1) break
    const afterPrefix = idx + 3
    // 识别 `<w:t`、`<w:tab`、`<w:br`、`<w:cr`
    if (xml.startsWith('t', afterPrefix) && afterPrefix + 1 < xml.length && isTagNameBoundary(xml.charCodeAt(afterPrefix + 1))) {
      const { end: openEnd, selfClosing } = findTagOpenEnd(xml, afterPrefix + 1)
      if (openEnd === -1) break
      if (selfClosing) {
        pos = openEnd + 1
        continue
      }
      const close = findClosingTag(xml, '</w:t', openEnd + 1)
      if (close === null) break
      if (close.contentEnd > openEnd + 1) {
        parts.push(decodeHtmlEntities(xml.slice(openEnd + 1, close.contentEnd)))
      }
      pos = close.tagEnd
      continue
    }
    if (xml.startsWith('tab', afterPrefix) && afterPrefix + 3 < xml.length && isTagNameBoundary(xml.charCodeAt(afterPrefix + 3))) {
      const { end: openEnd, selfClosing } = findTagOpenEnd(xml, afterPrefix + 3)
      if (openEnd === -1) break
      parts.push('\t')
      if (selfClosing) {
        pos = openEnd + 1
      } else {
        const close = findClosingTag(xml, '</w:tab', openEnd + 1)
        pos = close === null ? openEnd + 1 : close.tagEnd
      }
      continue
    }
    if (
      (xml.startsWith('br', afterPrefix) || xml.startsWith('cr', afterPrefix))
      && afterPrefix + 2 < xml.length
      && isTagNameBoundary(xml.charCodeAt(afterPrefix + 2))
    ) {
      const tag = xml.slice(afterPrefix, afterPrefix + 2)
      const { end: openEnd, selfClosing } = findTagOpenEnd(xml, afterPrefix + 2)
      if (openEnd === -1) break
      parts.push('\n')
      if (selfClosing) {
        pos = openEnd + 1
      } else {
        const close = findClosingTag(xml, `</w:${tag}`, openEnd + 1)
        pos = close === null ? openEnd + 1 : close.tagEnd
      }
      continue
    }
    pos = afterPrefix
  }
  return parts.join('')
}

const ATTR_NAME = /(?:^|\s)name\s*=\s*(?:"([^"]*)"|'([^']*)')/u
const ATTR_RID = /(?:^|\s)r:id\s*=\s*(?:"([^"]*)"|'([^']*)')/u
const ATTR_ID = /(?:^|\s)Id\s*=\s*(?:"([^"]*)"|'([^']*)')/u
const ATTR_TARGET = /(?:^|\s)Target\s*=\s*(?:"([^"]*)"|'([^']*)')/u
const ATTR_CELL_TYPE = /(?:^|\s)t\s*=\s*(?:"([^"]*)"|'([^']*)')/u
const ATTR_ROW_NUM = /(?:^|\s)r\s*=\s*(?:"(\d+)"|'(\d+)')/u

function readXmlAttr(attrs: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(attrs)
  if (match === null) return undefined
  return match[1] ?? match[2]
}

/** ZIP 条目名与目标路径的比较统一按 `/` 分隔（ZIP 规范只允许 `/`）。 */
function isTargetName(name: string, candidate: string): boolean {
  return name.replace(/\\/gu, '/') === candidate
}

function findEntry(entries: readonly AdmZipEntry[], name: string): AdmZipEntry | undefined {
  return entries.find(entry => isTargetName(entry.entryName, name))
}

/** 按文件名中的数字排序（sheet2.xml 必须排在 sheet10.xml 之前）。 */
function numericSuffix(name: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(name)
  if (match === null) return undefined
  return Number.parseInt(match[1] ?? '', 10)
}

function sortedMatches(
  entries: readonly AdmZipEntry[],
  pattern: RegExp,
): Array<{ entry: AdmZipEntry; index: number }> {
  const found: Array<{ entry: AdmZipEntry; index: number }> = []
  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/gu, '/')
    const index = numericSuffix(name, pattern)
    if (index !== undefined && Number.isFinite(index)) found.push({ entry, index })
  }
  found.sort((a, b) => a.index - b.index)
  return found
}

/** 读取单个目标 XML 条目；失败原因原样上抛给统一映射。 */
function readXmlEntry(
  entry: AdmZipEntry | undefined,
  totalInflated: number,
): { ok: true; xml: string; totalInflated: number } | { ok: false; reason: OoxmlSkipReason } {
  if (entry === undefined) return { ok: false, reason: 'corrupt-archive' }
  const inflated = inflateEntry(entry, totalInflated)
  if (!inflated.ok) return { ok: false, reason: inflated.reason }
  return { ok: true, xml: inflated.data.toString('utf8'), totalInflated: inflated.totalInflated }
}

interface SectionDraft {
  readonly headingPath: string
  readonly locator: ExtractedSection['locator']
  readonly lines: string[]
  readonly headerRow?: string
}

function draftsToSections(
  drafts: readonly SectionDraft[],
  maxDocTextBytes: number,
): { sections: ExtractedSection[]; truncated: boolean } {
  const sections: ExtractedSection[] = []
  for (const draft of drafts) {
    const text = draft.lines.join('\n')
    if (text.trim() === '') continue
    sections.push({
      headingPath: draft.headingPath,
      locator: draft.locator,
      text,
      ...(draft.headerRow === undefined || draft.headerRow === '' ? {} : { headerRow: draft.headerRow }),
    })
  }
  return applySectionTextBudget(sections, maxDocTextBytes)
}

function chunkLines(lines: readonly string[], size: number): string[][] {
  const windows: string[][] = []
  for (let start = 0; start < lines.length; start += size) {
    windows.push(lines.slice(start, start + size))
  }
  return windows
}

function extractDocx(
  entries: readonly AdmZipEntry[],
  base: DocumentBase,
  maxDocTextBytes: number,
): ExtractedDocument {
  const target = findEntry(entries, 'word/document.xml')
  const read = readXmlEntry(target, 0)
  if (!read.ok) {
    return read.reason === 'corrupt-archive'
      ? errorDocument(base, 'corrupt-archive')
      : skippedDocument(base, read.reason)
  }
  const paragraphs: string[] = []
  for (const paragraph of iterateXmlElements(read.xml, 'w:p')) {
    if (paragraph.selfClosing) {
      paragraphs.push('')
      continue
    }
    paragraphs.push(extractWordParagraphText(paragraph.body))
  }
  if (paragraphs.length === 0) {
    const fallback = extractWordParagraphText(read.xml)
    if (fallback.trim() !== '') paragraphs.push(...fallback.split('\n'))
  }
  const drafts: SectionDraft[] = chunkLines(paragraphs, DOCX_SECTION_PARAGRAPHS)
    .map((window, index) => ({
      headingPath: '',
      locator: { kind: 'section', section: index === 0 ? '正文' : `正文 ${index + 1}` },
      lines: window,
    }))
  const budgeted = draftsToSections(drafts, maxDocTextBytes)
  return {
    format: base.format,
    extractMode: 'text',
    extractConfigHash: base.extractConfigHash,
    status: budgeted.truncated ? 'partial' : 'indexed',
    ...(budgeted.truncated ? { statusReason: 'text-truncated' } : {}),
    sections: budgeted.sections,
  }
}

function parseSharedStrings(
  entries: readonly AdmZipEntry[],
  totalInflated: number,
): { ok: true; items: string[]; totalInflated: number } | { ok: false; reason: OoxmlSkipReason } {
  const entry = findEntry(entries, 'xl/sharedStrings.xml')
  if (entry === undefined) return { ok: true, items: [], totalInflated }
  const read = readXmlEntry(entry, totalInflated)
  if (!read.ok) return { ok: false, reason: read.reason }
  const items: string[] = []
  for (const item of iterateXmlElements(read.xml, 'si')) {
    items.push(item.selfClosing ? '' : collectTagTexts(item.body, 't'))
  }
  return { ok: true, items, totalInflated: read.totalInflated }
}

/** 将 `workbook.xml.rels` 的 Target 规范化成 ZIP 条目路径（相对 `xl/` 或根路径）。 */
function resolveWorkbookRelTarget(rawTarget: string): string {
  const cleaned = rawTarget.replace(/\\/gu, '/').replace(/^\/+/u, '')
  const segments = (cleaned.startsWith('xl/') ? cleaned : `xl/${cleaned}`).split('/')
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      resolved.pop()
      continue
    }
    resolved.push(segment)
  }
  return resolved.join('/')
}

interface ParsedWorkbookSheets {
  readonly ok: true
  readonly orderedNames: string[]
  readonly nameByEntryPath: ReadonlyMap<string, string>
  readonly totalInflated: number
}

/**
 * 解析 `xl/workbook.xml`（及可选 `xl/_rels/workbook.xml.rels`）：
 * 传递累计解压预算，错误不再静默吞掉（I-8），并按 `r:id` 精确映射工作表名（M-5）。
 */
function parseWorkbookSheets(
  entries: readonly AdmZipEntry[],
  totalInflated: number,
): ParsedWorkbookSheets | { readonly ok: false; readonly reason: OoxmlSkipReason } {
  let inflated = totalInflated
  const relTargets = new Map<string, string>()
  const relsEntry = findEntry(entries, 'xl/_rels/workbook.xml.rels')
  if (relsEntry !== undefined) {
    const relsRead = readXmlEntry(relsEntry, inflated)
    if (!relsRead.ok) return { ok: false, reason: relsRead.reason }
    inflated = relsRead.totalInflated
    for (const rel of iterateXmlElements(relsRead.xml, 'Relationship')) {
      const id = readXmlAttr(rel.attrs, ATTR_ID)
      const target = readXmlAttr(rel.attrs, ATTR_TARGET)
      if (id !== undefined && target !== undefined) {
        relTargets.set(decodeHtmlEntities(id), resolveWorkbookRelTarget(decodeHtmlEntities(target)))
      }
    }
  }

  const entry = findEntry(entries, 'xl/workbook.xml')
  if (entry === undefined) {
    return { ok: true, orderedNames: [], nameByEntryPath: new Map(), totalInflated: inflated }
  }
  const read = readXmlEntry(entry, inflated)
  if (!read.ok) return { ok: false, reason: read.reason }
  inflated = read.totalInflated

  const orderedNames: string[] = []
  const nameByEntryPath = new Map<string, string>()
  for (const sheet of iterateXmlElements(read.xml, 'sheet')) {
    const rawName = readXmlAttr(sheet.attrs, ATTR_NAME)
    if (rawName === undefined) continue
    const decodedName = decodeHtmlEntities(rawName)
    orderedNames.push(decodedName)
    const rId = readXmlAttr(sheet.attrs, ATTR_RID)
    if (rId !== undefined) {
      const targetPath = relTargets.get(decodeHtmlEntities(rId))
      if (targetPath !== undefined) nameByEntryPath.set(targetPath, decodedName)
    }
  }
  return { ok: true, orderedNames, nameByEntryPath, totalInflated: inflated }
}

function resolveCellValue(attributes: string, body: string, sharedStrings: readonly string[]): string {
  if (body === '') return ''
  const cellType = readXmlAttr(attributes, ATTR_CELL_TYPE)
  for (const inline of iterateXmlElements(body, 'is')) {
    if (!inline.selfClosing) return collectTagTexts(inline.body, 't')
    return ''
  }
  for (const valueEl of iterateXmlElements(body, 'v')) {
    if (valueEl.selfClosing) return ''
    const rawValue = decodeHtmlEntities(valueEl.body)
    if (cellType === 's') {
      const sharedIndex = Number.parseInt(rawValue, 10)
      return Number.isFinite(sharedIndex) ? (sharedStrings[sharedIndex] ?? '') : ''
    }
    return rawValue
  }
  return ''
}

interface SheetRowDraft {
  readonly rowNumber: number
  readonly text: string
}

function extractXlsx(
  entries: readonly AdmZipEntry[],
  base: DocumentBase,
  maxDocTextBytes: number,
  totalInflated: number,
): ExtractedDocument {
  const shared = parseSharedStrings(entries, totalInflated)
  if (!shared.ok) {
    return shared.reason === 'corrupt-archive'
      ? errorDocument(base, 'corrupt-archive')
      : skippedDocument(base, shared.reason)
  }
  const workbook = parseWorkbookSheets(entries, shared.totalInflated)
  if (!workbook.ok) {
    return workbook.reason === 'corrupt-archive'
      ? errorDocument(base, 'corrupt-archive')
      : skippedDocument(base, workbook.reason)
  }
  const worksheets = sortedMatches(entries, /^xl\/worksheets\/sheet(\d+)\.xml$/u)
  if (worksheets.length === 0) return errorDocument(base, 'corrupt-archive')

  const drafts: SectionDraft[] = []
  let inflated = workbook.totalInflated
  for (let sheetIndex = 0; sheetIndex < worksheets.length; sheetIndex += 1) {
    const current = worksheets[sheetIndex]
    if (current === undefined) continue
    const read = readXmlEntry(current.entry, inflated)
    if (!read.ok) {
      return read.reason === 'corrupt-archive'
        ? errorDocument(base, 'corrupt-archive')
        : skippedDocument(base, read.reason)
    }
    inflated = read.totalInflated
    const normalizedEntryName = current.entry.entryName.replace(/\\/gu, '/')
    const sheetName = workbook.nameByEntryPath.get(normalizedEntryName)
      ?? workbook.orderedNames[sheetIndex]
      ?? `Sheet${current.index}`
    const rows: SheetRowDraft[] = []
    let fallbackRowNumber = 0
    for (const rowEl of iterateXmlElements(read.xml, 'row')) {
      fallbackRowNumber += 1
      const rawRowNum = readXmlAttr(rowEl.attrs, ATTR_ROW_NUM)
      const parsedRowNum = rawRowNum === undefined ? Number.NaN : Number.parseInt(rawRowNum, 10)
      const rowNumber = Number.isFinite(parsedRowNum) && parsedRowNum > 0 ? parsedRowNum : fallbackRowNumber
      if (rowEl.selfClosing) {
        rows.push({ rowNumber, text: '' })
        continue
      }
      const cells: string[] = []
      for (const cellEl of iterateXmlElements(rowEl.body, 'c')) {
        if (cellEl.selfClosing) continue
        const value = resolveCellValue(cellEl.attrs, cellEl.body, shared.items)
        if (value !== '') cells.push(value)
      }
      rows.push({ rowNumber, text: cells.join('\t') })
    }
    const headerRow = rows[0]?.text ?? ''
    for (let start = 0; start < rows.length; start += XLSX_SECTION_ROWS) {
      const slice = rows.slice(start, start + XLSX_SECTION_ROWS)
      const lines = slice.map(row => row.text)
      if (lines.every(line => line.trim() === '')) continue
      const rowStart = slice[0]?.rowNumber ?? (start + 1)
      const rowEnd = slice[slice.length - 1]?.rowNumber ?? (start + slice.length)
      drafts.push({
        headingPath: sheetName,
        locator: {
          kind: 'sheet',
          sheet: sheetName,
          rowStart,
          rowEnd,
        },
        lines,
        ...(headerRow === '' ? {} : { headerRow }),
      })
    }
  }
  const budgeted = draftsToSections(drafts, maxDocTextBytes)
  return {
    format: base.format,
    extractMode: 'text',
    extractConfigHash: base.extractConfigHash,
    status: budgeted.truncated ? 'partial' : 'indexed',
    ...(budgeted.truncated ? { statusReason: 'text-truncated' } : {}),
    sections: budgeted.sections,
  }
}

function extractPptx(
  entries: readonly AdmZipEntry[],
  base: DocumentBase,
  maxDocTextBytes: number,
): ExtractedDocument {
  const slides = sortedMatches(entries, /^ppt\/slides\/slide(\d+)\.xml$/u)
  if (slides.length === 0) return errorDocument(base, 'corrupt-archive')
  const drafts: SectionDraft[] = []
  let inflated = 0
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    const current = slides[slideIndex]
    if (current === undefined) continue
    const read = readXmlEntry(current.entry, inflated)
    if (!read.ok) {
      return read.reason === 'corrupt-archive'
        ? errorDocument(base, 'corrupt-archive')
        : skippedDocument(base, read.reason)
    }
    inflated = read.totalInflated
    const paragraphs: string[] = []
    for (const paragraph of iterateXmlElements(read.xml, 'a:p')) {
      paragraphs.push(paragraph.selfClosing ? '' : collectTagTexts(paragraph.body, 'a:t'))
    }
    if (paragraphs.length === 0) {
      const fallback = collectTagTexts(read.xml, 'a:t')
      if (fallback.trim() !== '') paragraphs.push(fallback)
    }
    drafts.push({
      headingPath: '',
      locator: { kind: 'slide', slide: current.index },
      lines: paragraphs,
    })
  }
  const budgeted = draftsToSections(drafts, maxDocTextBytes)
  return {
    format: base.format,
    extractMode: 'text',
    extractConfigHash: base.extractConfigHash,
    status: budgeted.truncated ? 'partial' : 'indexed',
    ...(budgeted.truncated ? { statusReason: 'text-truncated' } : {}),
    sections: budgeted.sections,
  }
}

/** 提取一份 .docx / .xlsx / .pptx。所有异常都收敛为 `skipped` / `error` 结果。 */
export function extractOoxmlDocument(input: OoxmlExtractionInput): ExtractedDocument {
  const ext = input.ext.toLowerCase()
  const base: DocumentBase = { format: ext.slice(1), extractConfigHash: input.extractConfigHash }
  if (input.buffer.byteLength >= OLE2_MAGIC.byteLength && input.buffer.subarray(0, OLE2_MAGIC.byteLength).equals(OLE2_MAGIC)) {
    return skippedDocument(base, 'encrypted')
  }
  let entries: AdmZipEntry[]
  try {
    const zip = new AdmZip(input.buffer)
    // O(1) 读取 ZIP64 感知的条目数（ENDSUB），在 `getEntries()` 分配数组前拦截恶意条目炸弹（I-8）。
    const declaredEntries = typeof (zip as { getEntryCount?: unknown }).getEntryCount === 'function'
      ? (zip as { getEntryCount(): number }).getEntryCount()
      : undefined
    if (declaredEntries !== undefined && declaredEntries > MAX_ZIP_ENTRIES) {
      return skippedDocument(base, 'zip-limit-exceeded')
    }
    entries = zip.getEntries()
  } catch {
    return errorDocument(base, 'corrupt-archive')
  }
  if (entries.length > MAX_ZIP_ENTRIES) return skippedDocument(base, 'zip-limit-exceeded')

  const maxDocTextBytes = Number.isFinite(input.maxDocTextBytes)
    ? Math.max(0, Math.floor(input.maxDocTextBytes))
    : MAX_DOC_TEXT_BYTES
  try {
    if (ext === '.xlsx') return extractXlsx(entries, base, maxDocTextBytes, 0)
    if (ext === '.pptx') return extractPptx(entries, base, maxDocTextBytes)
    return extractDocx(entries, base, maxDocTextBytes)
  } catch {
    // 条目内的解析异常（例如本地头缺失导致 getCompressedData 抛错）同样
    // 收敛为损坏归档，绝不把异常抛给 Worker 主循环。
    return errorDocument(base, 'corrupt-archive')
  }
}
