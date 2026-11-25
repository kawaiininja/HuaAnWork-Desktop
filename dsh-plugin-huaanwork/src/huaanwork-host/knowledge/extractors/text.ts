/**
 * 文本 / 代码 / 表格文本提取器（规格 §6.2 M1 文本矩阵）。
 *
 * - 严格 UTF-8 解码，失败自动回退 GB18030（中文旧文档）；
 * - HTML 去 `<script>` / `<style>` 与全部标签，标题转成 Markdown 标题行以
 *   保留 `headingPath` 与行号坐标；
 * - CSV / TSV 每条 section 保留表头行（`headerRow`）；
 * - 文本总量受 `maxDocTextBytes` 约束，超限截断（绝不劈裂 UTF-8 字符）
 *   并置 `status: 'partial', statusReason: 'text-truncated'`。
 *
 * 本文件会被 Worker / 测试以 `.ts` 源码直接加载（Node type-stripping），
 * 因此不得使用 `enum`、构造器参数属性或 `namespace`；纯类型导入必须写
 * `import type`，相对导入保留 `.ts` 后缀。
 */

import type { ExtractedDocument, ExtractedSection } from '../types.ts'

/** M1 文本 / 代码 / 表格文本后缀（规格 §6.2 固定清单）。 */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.txt',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.htm',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.cpp',
  '.h',
  '.cs',
  '.rb',
  '.php',
  '.sql',
  '.sh',
  '.ps1',
  '.css',
  '.scss',
  '.ini',
  '.toml',
  '.log',
])

const HTML_EXTENSIONS: ReadonlySet<string> = new Set(['.html', '.htm'])
const DELIMITED_EXTENSIONS: ReadonlySet<string> = new Set(['.csv', '.tsv'])

/** 单 section 的行数与字符软上限：让行号定位既精确又不至于碎片化。 */
const MAX_SECTION_LINES = 80
const MAX_SECTION_CHARS = 1_200

export interface TextExtractionInput {
  readonly buffer: Buffer
  readonly ext: string
  readonly extractConfigHash: string
  readonly maxDocTextBytes: number
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
}

/** 反转义 HTML 实体（命名实体、十进制与十六进制数字实体）。 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/gu, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body.length > 1 && (body[1] === 'x' || body[1] === 'X')
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10_ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * 把 HTML 变成带 Markdown 标题的纯文本：块级标签成为换行，`<h1>`–`<h6>`
 * 成为 `#` 前缀标题行，脚本 / 样式整段丢弃，最后反转义实体。
 */
function htmlToText(html: string): string {
  let text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, '\n')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, '\n')
    .replace(/<!--[\s\S]*?-->/gu, '\n')
    .replace(/<h([1-6])\b[^>]*>/giu, (_match, level: string) => `\n${'#'.repeat(Number(level))} `)
    .replace(/<\/h[1-6]\s*>/giu, '\n')
    .replace(/<(?:br|hr)\b[^>]*\/?>/giu, '\n')
    .replace(/<\/(?:p|div|li|tr|section|article|header|footer|table|ul|ol|dl|blockquote|pre|body|html)\s*>/giu, '\n')
    .replace(/<(?:p|div|li|tr|section|article|header|footer|table|ul|ol|dl|blockquote|pre|body|html)\b[^>]*>/giu, '\n')
    .replace(/<[^>]*>/gu, '')
  text = decodeHtmlEntities(text)
  return text.replace(/\r\n?/gu, '\n')
}

/** 严格 UTF-8 解码；非法字节序列回退 GB18030（中文旧文档常见编码）。 */
function decodeTextBuffer(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('gb18030').decode(buffer)
  }
}

/** 按 UTF-8 字节上限截断，且绝不劈裂多字节字符（与切片器同一策略）。 */
export function truncateToUtf8Bytes(text: string, maxBytes: number): string {
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

interface LineSectionOptions {
  readonly detectHeadings: boolean
  readonly headerRow?: string
}

/** 把逐行文本分组为带行号坐标的 section；标题行开启新 section。 */
function buildLineSections(lines: readonly string[], opts: LineSectionOptions): ExtractedSection[] {
  const sections: ExtractedSection[] = []
  const headingStack: Array<{ readonly level: number; readonly text: string }> = []
  let headingPath = ''
  let buffer: string[] = []
  let bufferChars = 0
  let startLine = 1
  let endLine = 1

  const flush = (): void => {
    if (buffer.length === 0) return
    const text = buffer.join('\n')
    if (text.trim() !== '') {
      sections.push({
        headingPath,
        locator: { kind: 'line', startLine, endLine },
        text,
        ...(opts.headerRow === undefined ? {} : { headerRow: opts.headerRow }),
      })
    }
    buffer = []
    bufferChars = 0
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (opts.detectHeadings) {
      const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line)
      if (heading !== null) {
        flush()
        const level = heading[1]?.length ?? 1
        const text = heading[2] ?? ''
        while (headingStack.length > 0 && (headingStack[headingStack.length - 1]?.level ?? 0) >= level) {
          headingStack.pop()
        }
        headingStack.push({ level, text })
        headingPath = headingStack.map(entry => entry.text).join(' > ')
      }
    }
    if (buffer.length === 0) startLine = index + 1
    const wouldOverflow = buffer.length >= MAX_SECTION_LINES
      || (buffer.length > 0 && bufferChars + line.length > MAX_SECTION_CHARS)
    if (wouldOverflow) {
      flush()
      startLine = index + 1
    }
    buffer.push(line)
    bufferChars += line.length + 1
    endLine = index + 1
  }
  flush()
  return sections
}

/** 应用整篇文本字节预算；返回截断后的 section 与是否发生截断。 */
export function applySectionTextBudget(
  sections: readonly ExtractedSection[],
  maxDocTextBytes: number,
): { sections: ExtractedSection[]; truncated: boolean } {
  const budget = Math.max(0, maxDocTextBytes)
  const kept: ExtractedSection[] = []
  let used = 0
  for (const section of sections) {
    const sectionBytes = Buffer.byteLength(section.text, 'utf8')
    if (used + sectionBytes <= budget) {
      kept.push(section)
      used += sectionBytes
      continue
    }
    const tail = truncateToUtf8Bytes(section.text, budget - used)
    if (tail !== '') kept.push({ ...section, text: tail })
    return { sections: kept, truncated: true }
  }
  return { sections: kept, truncated: false }
}

/**
 * 提取一份文本 / 代码 / 表格文本文件。空文档返回 `indexed` 且无 section。
 */
export function extractTextDocument(input: TextExtractionInput): ExtractedDocument {
  const ext = input.ext.toLowerCase()
  const decoded = decodeTextBuffer(input.buffer)
  const normalized = decoded.replace(/\r\n?/gu, '\n')
  const html = HTML_EXTENSIONS.has(ext)
  const rawLines = html ? htmlToText(decoded).split('\n') : normalized.split('\n')
  const lines = rawLines.length === 1 && rawLines[0] === '' ? [] : rawLines
  const headerRow = DELIMITED_EXTENSIONS.has(ext) && lines.length > 0 ? lines[0] : undefined
  const sections = buildLineSections(lines, {
    detectHeadings: html || ext === '.md',
    ...(headerRow === undefined ? {} : { headerRow }),
  })
  const budgeted = applySectionTextBudget(sections, Math.max(0, input.maxDocTextBytes))
  return {
    format: ext.slice(1),
    extractMode: 'text',
    extractConfigHash: input.extractConfigHash,
    status: budgeted.truncated ? 'partial' : 'indexed',
    ...(budgeted.truncated ? { statusReason: 'text-truncated' } : {}),
    sections: budgeted.sections,
  }
}
