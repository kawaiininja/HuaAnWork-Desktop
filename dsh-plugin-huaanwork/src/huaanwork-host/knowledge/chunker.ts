/**
 * 知识库文档切片器（规格 §7.2 / 计划 Task 3）。
 *
 * 目标 500–800 字、相邻切片约 100 字重叠；`sheet` 切片每片头部预置
 * `headerRow`，保证表格行离开表头后仍可理解。两个硬上限：每文档
 * `maxChunks`（默认 `MAX_CHUNKS_PER_DOC = 500`）与
 * `maxTextBytes`（默认 `MAX_DOC_TEXT_BYTES = 10 MB`）。
 *
 * 字节预算按「产出的切片文本 UTF-8 字节」计，包含表头重复与重叠部分；
 * 因此原始文本实际消费量必然不超过预算。触到任一上限即置
 * `truncated: true` 并停止继续产出。
 *
 * 每个 `ChunkDraft.tokenized` 由本模块逐片调用 `tokenizeForFts(content)`
 * 填充（控制器裁决 M-8）：下游存储直接信任该字段，不再重新分词。
 *
 * 本文件会被 Worker/测试以 `.ts` 源码直接加载（Node type-stripping），因此
 * 不得使用 `enum`、构造器参数属性或 `namespace`；纯类型导入必须写
 * `import type`，相对导入保留 `.ts` 后缀。
 */

import { tokenizeForFts } from './tokenizer.ts'
import { MAX_CHUNKS_PER_DOC, MAX_DOC_TEXT_BYTES } from './types.ts'
import type { ChunkDraft, ExtractedDocument, ExtractedSection } from './types.ts'

const CHUNK_MIN_CHARS = 500
const CHUNK_MAX_CHARS = 800
const CHUNK_OVERLAP_CHARS = 100

/** 切片窗口内的自然断点：段落、换行、中英文句读与空白。 */
const BREAK_CHARS: ReadonlySet<string> = new Set([
  '\n',
  '。',
  '！',
  '？',
  '；',
  '.',
  '!',
  '?',
  ';',
  '，',
  ',',
  ' ',
])

export interface ChunkExtractedDocumentOptions {
  readonly maxChunks?: number
  readonly maxTextBytes?: number
}

export interface ChunkExtractedDocumentResult {
  readonly chunks: ChunkDraft[]
  readonly truncated: boolean
}

/** 不劈裂 UTF-16 代理对：若切点前是高位代理，则回退（退到 start 及之前则前移）。 */
function safeChunkEnd(text: string, end: number, start: number = 0): number {
  if (end <= 0 || end >= text.length) return end
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) {
    return end - 1 > start ? end - 1 : Math.min(text.length, end + 1)
  }
  return end
}

/** 不从 UTF-16 低代理码元开启下一片重叠，避免产生孤立低代理 / U+FFFD（I-11）。 */
function safeChunkStart(text: string, candidate: number, prevStart: number): number {
  let start = Math.max(prevStart + 1, candidate)
  if (start < text.length) {
    const code = text.charCodeAt(start)
    if (code >= 0xdc00 && code <= 0xdfff) {
      start = start - 1 > prevStart ? start - 1 : start + 1
    }
  }
  return start
}

/** 在 `[minEnd, hardEnd]` 之间回扫最近的自然断点，返回切片结束位置。 */
function findBreakEnd(text: string, minEnd: number, hardEnd: number, start: number): number {
  for (let index = hardEnd - 1; index >= minEnd; index -= 1) {
    const char = text[index]
    if (char !== undefined && BREAK_CHARS.has(char)) return safeChunkEnd(text, index + 1, start)
  }
  return -1
}

/** 按 500–800 字滑窗惰性切分单段文本，相邻切片重叠约 100 字。 */
function* iterateSectionPieces(text: string): Generator<string> {
  if (text.length <= CHUNK_MAX_CHARS) {
    yield text
    return
  }
  let start = 0
  while (start < text.length) {
    const hardEnd = Math.min(start + CHUNK_MAX_CHARS, text.length)
    let end = hardEnd
    if (hardEnd < text.length) {
      const minEnd = Math.min(start + CHUNK_MIN_CHARS, hardEnd)
      const breakEnd = findBreakEnd(text, minEnd, hardEnd, start)
      end = breakEnd > minEnd ? breakEnd : safeChunkEnd(text, hardEnd, start)
    }
    const piece = text.slice(start, end)
    if (piece.trim() !== '') yield piece
    if (end >= text.length) break
    start = safeChunkStart(text, end - CHUNK_OVERLAP_CHARS, start)
  }
}

/** 按 UTF-8 字节上限截断，且绝不劈裂多字节字符（与事件日志同一策略）。 */
function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength <= maxBytes) return text
  let end = maxBytes
  while (end > 0) {
    const byte = bytes[end]
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) break
    end -= 1
  }
  return bytes.subarray(0, end).toString('utf8')
}

function buildChunk(ordinal: number, section: ExtractedSection, content: string): ChunkDraft {
  return {
    ordinal,
    headingPath: section.headingPath,
    locator: section.locator,
    content,
    // 控制器裁决 M-8：下游存储直接信任 tokenized，不再重新分词。
    tokenized: tokenizeForFts(content),
    charCount: content.length,
  }
}

/**
 * 把提取结果切成带定位信息的切片草稿。空白 section 不产出空切片；触到
 * 切片数或文本字节上限时提前停止并返回 `truncated: true`。
 */
export function chunkExtractedDocument(
  doc: ExtractedDocument,
  opts: ChunkExtractedDocumentOptions = {},
): ChunkExtractedDocumentResult {
  const maxChunks = opts.maxChunks !== undefined && Number.isFinite(opts.maxChunks)
    ? Math.max(1, Math.floor(opts.maxChunks))
    : MAX_CHUNKS_PER_DOC
  const maxTextBytes = opts.maxTextBytes !== undefined && Number.isFinite(opts.maxTextBytes)
    ? Math.max(0, Math.floor(opts.maxTextBytes))
    : MAX_DOC_TEXT_BYTES
  const chunks: ChunkDraft[] = []
  let producedBytes = 0
  let truncated = false
  let ordinal = 0

  outer: for (const section of doc.sections) {
    if (section.text.trim() === '') continue
    const rawHeaderRow = (section.locator.kind === 'sheet' || section.locator.kind === 'line')
      && section.headerRow !== undefined
      && section.headerRow !== ''
      ? section.headerRow
      : ''
    for (const piece of iterateSectionPieces(section.text)) {
      if (piece.trim() === '') continue
      if (chunks.length >= maxChunks) {
        truncated = true
        break outer
      }
      // 已以表头行开头的首片不再重复预置表头（M-5）；后续分片补齐表头上下文。
      const needsHeader = rawHeaderRow !== ''
        && piece !== rawHeaderRow
        && !piece.startsWith(`${rawHeaderRow}\n`)
      const header = needsHeader ? `${rawHeaderRow}\n` : ''
      const headerBytes = header === '' ? 0 : Buffer.byteLength(header, 'utf8')
      let body = piece
      if (producedBytes + headerBytes + Buffer.byteLength(body, 'utf8') > maxTextBytes) {
        body = truncateToUtf8Bytes(piece, maxTextBytes - producedBytes - headerBytes)
        truncated = true
      }
      if (body.trim() === '') break outer
      const content = header + body
      chunks.push(buildChunk(ordinal, section, content))
      ordinal += 1
      producedBytes += Buffer.byteLength(content, 'utf8')
      if (truncated) break outer
    }
  }

  return { chunks, truncated }
}
