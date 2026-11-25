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
const ZIP_EOCD_SIG = 0x06054b50
const ZIP_EOCD_SIZE = 22
const ZIP_MAX_COMMENT_BYTES = 0xffff
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

/** 提取所有 `<t>` / `<a:t>` 文本片段并反转义 XML 实体。 */
function collectTextRuns(xml: string, tagPattern: RegExp): string {
  const parts: string[] = []
  for (const match of xml.matchAll(tagPattern)) {
    parts.push(decodeHtmlEntities(match[1] ?? ''))
  }
  return parts.join('')
}

const WORD_TEXT_RUN = /<w:t\b[^>]*>([\s\S]*?)<\/w:t\s*>/gu
const WORD_PARAGRAPH = /<w:p\b[^>]*>([\s\S]*?)<\/w:p\s*>/gu
const WORD_SELF_CLOSING_PARAGRAPH = /<w:p\b[^>]*\/>/gu
const DRAWING_TEXT_RUN = /<a:t\b[^>]*>([\s\S]*?)<\/a:t\s*>/gu
const DRAWING_PARAGRAPH = /<a:p\b[^>]*>([\s\S]*?)<\/a:p\s*>/gu
const DRAWING_SELF_CLOSING_PARAGRAPH = /<a:p\b[^>]*\/>/gu
const SHEET_ROW = /<row\b[^>]*>([\s\S]*?)<\/row\s*>/gu
const SHEET_CELL = /<c\b([^>]*)>([\s\S]*?)<\/c\s*>/gu
const CELL_VALUE = /<v\b[^>]*>([\s\S]*?)<\/v\s*>/u
const INLINE_STRING = /<is\b[^>]*>([\s\S]*?)<\/is\s*>/u
const INLINE_STRING_TEXT = /<t\b[^>]*>([\s\S]*?)<\/t\s*>/u
const SHARED_STRING_ITEM = /<si\b[^>]*>([\s\S]*?)<\/si\s*>/gu
const SHARED_STRING_TEXT = /<t\b[^>]*>([\s\S]*?)<\/t\s*>/gu
const WORKBOOK_SHEET = /<sheet\b[^>]*>/gu
const SHEET_NAME_ATTR = /\bname="([^"]*)"/u
const CELL_TYPE_ATTR = /\bt="([^"]*)"/u

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
  const xml = read.xml.replace(WORD_SELF_CLOSING_PARAGRAPH, '<w:p></w:p>')
  const paragraphs: string[] = []
  for (const match of xml.matchAll(WORD_PARAGRAPH)) {
    const body = match[1] ?? ''
    const line = collectTextRuns(body, WORD_TEXT_RUN)
      .replace(/<w:tab\b[^>]*\/>/gu, '\t')
      .replace(/<w:br\b[^>]*\/>/gu, '\n')
    paragraphs.push(line)
  }
  if (paragraphs.length === 0) {
    const fallback = collectTextRuns(xml, WORD_TEXT_RUN)
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
): { ok: true; items: string[]; totalInflated: number } | { ok: false; reason: OoxmlSkipReason } {
  const entry = findEntry(entries, 'xl/sharedStrings.xml')
  if (entry === undefined) return { ok: true, items: [], totalInflated: 0 }
  const read = readXmlEntry(entry, 0)
  if (!read.ok) return { ok: false, reason: read.reason }
  const items: string[] = []
  for (const item of read.xml.matchAll(SHARED_STRING_ITEM)) {
    items.push(collectTextRuns(item[1] ?? '', SHARED_STRING_TEXT))
  }
  return { ok: true, items, totalInflated: read.totalInflated }
}

function parseSheetNames(
  entries: readonly AdmZipEntry[],
): { names: string[]; totalInflated: number } {
  const entry = findEntry(entries, 'xl/workbook.xml')
  if (entry === undefined) return { names: [], totalInflated: 0 }
  const read = readXmlEntry(entry, 0)
  if (!read.ok) return { names: [], totalInflated: 0 }
  const names: string[] = []
  for (const match of read.xml.matchAll(WORKBOOK_SHEET)) {
    const name = SHEET_NAME_ATTR.exec(match[0])
    if (name !== null) names.push(decodeHtmlEntities(name[1] ?? ''))
  }
  return { names, totalInflated: read.totalInflated }
}

function resolveCellValue(attributes: string, body: string, sharedStrings: readonly string[]): string {
  const type = CELL_TYPE_ATTR.exec(attributes)
  const inline = INLINE_STRING.exec(body)
  if (inline !== null) {
    const text = INLINE_STRING_TEXT.exec(inline[1] ?? '')
    return decodeHtmlEntities(text?.[1] ?? '')
  }
  const value = CELL_VALUE.exec(body)
  if (value === null) return ''
  const rawValue = decodeHtmlEntities(value[1] ?? '')
  if (type !== null && type[1] === 's') {
    const sharedIndex = Number.parseInt(rawValue, 10)
    return Number.isFinite(sharedIndex) ? (sharedStrings[sharedIndex] ?? '') : ''
  }
  return rawValue
}

function extractXlsx(
  entries: readonly AdmZipEntry[],
  base: DocumentBase,
  maxDocTextBytes: number,
  totalInflated: number,
): ExtractedDocument {
  const shared = parseSharedStrings(entries)
  if (!shared.ok) {
    return shared.reason === 'corrupt-archive'
      ? errorDocument(base, 'corrupt-archive')
      : skippedDocument(base, shared.reason)
  }
  const sheetNameInfo = parseSheetNames(entries)
  const sheetNames = sheetNameInfo.names
  const worksheets = sortedMatches(entries, /^xl\/worksheets\/sheet(\d+)\.xml$/u)
  if (worksheets.length === 0) return errorDocument(base, 'corrupt-archive')

  const drafts: SectionDraft[] = []
  // 共享字符串与工作簿元数据同样计入 ZIP 解压总量（规格 §2.3）。
  let inflated = totalInflated + shared.totalInflated + sheetNameInfo.totalInflated
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
    const sheetName = sheetNames[sheetIndex] ?? `Sheet${current.index}`
    const rows: string[] = []
    for (const rowMatch of read.xml.matchAll(SHEET_ROW)) {
      const cells: string[] = []
      for (const cellMatch of (rowMatch[1] ?? '').matchAll(SHEET_CELL)) {
        const value = resolveCellValue(cellMatch[1] ?? '', cellMatch[2] ?? '', shared.items)
        if (value !== '') cells.push(value)
      }
      rows.push(cells.join('\t'))
    }
    const headerRow = rows[0] ?? ''
    const windows = chunkLines(rows, XLSX_SECTION_ROWS)
    for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
      const window = windows[windowIndex] ?? []
      if (window.every(line => line.trim() === '')) continue
      drafts.push({
        headingPath: sheetName,
        locator: {
          kind: 'sheet',
          sheet: sheetName,
          rowStart: windowIndex * XLSX_SECTION_ROWS + 1,
          rowEnd: windowIndex * XLSX_SECTION_ROWS + window.length,
        },
        lines: window,
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
    const xml = read.xml.replace(DRAWING_SELF_CLOSING_PARAGRAPH, '<a:p></a:p>')
    const paragraphs: string[] = []
    for (const paragraph of xml.matchAll(DRAWING_PARAGRAPH)) {
      paragraphs.push(collectTextRuns(paragraph[1] ?? '', DRAWING_TEXT_RUN))
    }
    if (paragraphs.length === 0) {
      const fallback = collectTextRuns(xml, DRAWING_TEXT_RUN)
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

/**
 * 在中央目录解析前读取 EOCD 声明的条目总数：恶意超多条目 ZIP 的中央目录
 * 解析本身就会产生大量对象，先按声明的计数 fail-closed 更省内存。真实
 * 计数仍在 `getEntries()` 后复核一次。
 */
function declaredZipEntryCount(buffer: Buffer): number | undefined {
  const earliest = Math.max(0, buffer.byteLength - ZIP_EOCD_SIZE - ZIP_MAX_COMMENT_BYTES)
  for (let index = buffer.byteLength - ZIP_EOCD_SIZE; index >= earliest; index -= 1) {
    if (buffer.readUInt32LE(index) !== ZIP_EOCD_SIG) continue
    return buffer.readUInt16LE(index + 10)
  }
  return undefined
}

/** 提取一份 .docx / .xlsx / .pptx。所有异常都收敛为 `skipped` / `error` 结果。 */
export function extractOoxmlDocument(input: OoxmlExtractionInput): ExtractedDocument {
  const ext = input.ext.toLowerCase()
  const base: DocumentBase = { format: ext.slice(1), extractConfigHash: input.extractConfigHash }
  if (input.buffer.byteLength >= OLE2_MAGIC.byteLength && input.buffer.subarray(0, OLE2_MAGIC.byteLength).equals(OLE2_MAGIC)) {
    return skippedDocument(base, 'encrypted')
  }
  const declaredEntries = declaredZipEntryCount(input.buffer)
  if (declaredEntries !== undefined && declaredEntries > MAX_ZIP_ENTRIES) {
    return skippedDocument(base, 'zip-limit-exceeded')
  }
  let entries: AdmZipEntry[]
  try {
    entries = new AdmZip(input.buffer).getEntries()
  } catch (error) {
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
