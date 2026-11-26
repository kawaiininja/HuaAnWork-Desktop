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

/** 反转义 HTML 实体（命名实体、十进制与十六进制数字实体；防原型链污染与非法数字实体，I-8）。 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z][a-zA-Z0-9]*));/gu,
    (match, hexDigits: string | undefined, decDigits: string | undefined, named: string | undefined) => {
      if (hexDigits !== undefined || decDigits !== undefined) {
        const code = hexDigits !== undefined
          ? Number.parseInt(hexDigits, 16)
          : Number.parseInt(decDigits ?? '', 10)
        // 拒绝 NUL、超范围码点与 UTF-16 代理区。
        if (!Number.isFinite(code) || code <= 0 || code > 0x10_ffff || (code >= 0xd800 && code <= 0xdfff)) {
          return match
        }
        try {
          return String.fromCodePoint(code)
        } catch {
          return match
        }
      }
      if (named !== undefined) {
        const key = named.toLowerCase()
        if (Object.hasOwn(NAMED_ENTITIES, key)) return NAMED_ENTITIES[key] ?? match
      }
      return match
    },
  )
}

function isHtmlTagBoundary(code: number): boolean {
  return code === 32 || code === 9 || code === 13 || code === 10 || code === 62 /* '>' */ || code === 47 /* '/' */
}

/** O(N) 线性剥离 `<script>` / `<style>` / `<!-- -->`，消除未闭合标签引发的 ReDoS（I-8）。 */
function stripHtmlOpaqueBlocks(html: string): string {
  const lower = html.toLowerCase()
  const parts: string[] = []
  let pos = 0
  while (pos < html.length) {
    const nextLt = lower.indexOf('<', pos)
    if (nextLt === -1) {
      parts.push(html.slice(pos))
      break
    }
    if (lower.startsWith('<!--', nextLt)) {
      parts.push(html.slice(pos, nextLt), '\n')
      const closeIdx = lower.indexOf('-->', nextLt + 4)
      if (closeIdx === -1) break
      pos = closeIdx + 3
      continue
    }
    let matchedTag: 'script' | 'style' | undefined
    if (
      lower.startsWith('<script', nextLt)
      && nextLt + 7 < lower.length
      && isHtmlTagBoundary(lower.charCodeAt(nextLt + 7))
    ) {
      matchedTag = 'script'
    } else if (
      lower.startsWith('<style', nextLt)
      && nextLt + 6 < lower.length
      && isHtmlTagBoundary(lower.charCodeAt(nextLt + 6))
    ) {
      matchedTag = 'style'
    }
    if (matchedTag !== undefined) {
      const openEnd = lower.indexOf('>', nextLt + 1 + matchedTag.length)
      parts.push(html.slice(pos, nextLt), '\n')
      if (openEnd === -1) break
      const closePrefix = `</${matchedTag}`
      let search = openEnd + 1
      let closedAt = -1
      while (search < lower.length) {
        const closeIdx = lower.indexOf(closePrefix, search)
        if (closeIdx === -1) break
        let after = closeIdx + closePrefix.length
        while (after < lower.length && (lower.charCodeAt(after) === 32 || lower.charCodeAt(after) === 9 || lower.charCodeAt(after) === 13 || lower.charCodeAt(after) === 10)) {
          after += 1
        }
        if (after < lower.length && lower.charCodeAt(after) === 62 /* '>' */) {
          closedAt = after + 1
          break
        }
        search = closeIdx + closePrefix.length
      }
      if (closedAt === -1) break
      pos = closedAt
      continue
    }
    parts.push(html.slice(pos, nextLt + 1))
    pos = nextLt + 1
  }
  return parts.join('')
}

/** O(N) 将多行 `<h1..6>...</h1..6>` 折叠到单行 `# 标题`，避免标题被换行截断。 */
function normalizeHtmlHeadings(html: string): string {
  const lower = html.toLowerCase()
  const parts: string[] = []
  let pos = 0
  while (pos < html.length) {
    const lt = lower.indexOf('<h', pos)
    if (lt === -1) {
      parts.push(html.slice(pos))
      break
    }
    const levelChar = lower.charCodeAt(lt + 2)
    const boundaryChar = lower.charCodeAt(lt + 3)
    if (levelChar < 49 /* '1' */ || levelChar > 54 /* '6' */ || !isHtmlTagBoundary(boundaryChar)) {
      parts.push(html.slice(pos, lt + 2))
      pos = lt + 2
      continue
    }
    const openEnd = lower.indexOf('>', lt + 3)
    if (openEnd === -1) {
      parts.push(html.slice(pos))
      break
    }
    const level = levelChar - 48
    const closePrefix = `</h${String(level)}`
    let search = openEnd + 1
    let closeStart = -1
    let closeEnd = -1
    while (search < lower.length) {
      const idx = lower.indexOf(closePrefix, search)
      if (idx === -1) break
      let after = idx + closePrefix.length
      while (after < lower.length && (lower.charCodeAt(after) === 32 || lower.charCodeAt(after) === 9 || lower.charCodeAt(after) === 13 || lower.charCodeAt(after) === 10)) {
        after += 1
      }
      if (after < lower.length && lower.charCodeAt(after) === 62 /* '>' */) {
        closeStart = idx
        closeEnd = after + 1
        break
      }
      search = idx + closePrefix.length
    }
    parts.push(html.slice(pos, lt))
    if (closeStart === -1) {
      parts.push(`\n${'#'.repeat(level)} `)
      pos = openEnd + 1
      continue
    }
    const inner = html
      .slice(openEnd + 1, closeStart)
      .replace(/<[^>]*>/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
    parts.push(`\n${'#'.repeat(level)} ${inner}\n`)
    pos = closeEnd
  }
  return parts.join('')
}

/**
 * 把 HTML 变成带 Markdown 标题的纯文本：块级标签成为换行，`<h1>`–`<h6>`
 * 成为 `#` 前缀标题行，脚本 / 样式 / 注释线性丢弃，最后反转义实体。
 */
function htmlToText(html: string): string {
  const stripped = normalizeHtmlHeadings(stripHtmlOpaqueBlocks(html))
  let text = stripped
    .replace(/<(?:br|hr)\b[^>]*\/?>/giu, '\n')
    .replace(/<\/(?:p|div|li|tr|section|article|header|footer|table|ul|ol|dl|blockquote|pre|body|html)\s*>/giu, '\n')
    .replace(/<(?:p|div|li|tr|section|article|header|footer|table|ul|ol|dl|blockquote|pre|body|html)\b[^>]*>/giu, '\n')
    .replace(/<[^>]*>/gu, '')
  text = decodeHtmlEntities(text)
  return text.replace(/\r\n?/gu, '\n')
}

const BINARY_PROBE_BYTES = 64 * 1024

type DecodedTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'binary-content' }

/**
 * 解码文本字节（I-8 + M-5 修复）：
 * - 优先识别 UTF-16LE / UTF-16BE BOM（Windows 记事本 / PowerShell 常见输出）；
 * - 拒绝 UTF-32 BOM 与含 NUL 字节的伪装二进制文件；
 * - 其余按严格 UTF-8 解码，失败回退 GB18030。
 */
function decodeTextBuffer(buffer: Buffer): DecodedTextResult {
  if (buffer.byteLength >= 4) {
    const b0 = buffer[0]
    const b1 = buffer[1]
    const b2 = buffer[2]
    const b3 = buffer[3]
    if ((b0 === 0xff && b1 === 0xfe && b2 === 0x00 && b3 === 0x00)
      || (b0 === 0x00 && b1 === 0x00 && b2 === 0xfe && b3 === 0xff)) {
      return { ok: false, reason: 'binary-content' }
    }
  }
  if (buffer.byteLength >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return { ok: true, text: new TextDecoder('utf-16le').decode(buffer) }
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      return { ok: true, text: new TextDecoder('utf-16be').decode(buffer) }
    }
  }
  const probeEnd = Math.min(buffer.byteLength, BINARY_PROBE_BYTES)
  if (buffer.subarray(0, probeEnd).includes(0)) {
    return { ok: false, reason: 'binary-content' }
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
  } catch {
    return { ok: true, text: new TextDecoder('gb18030').decode(buffer) }
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
  readonly respectCodeFences: boolean
  readonly captureHeaderRow: boolean
  readonly maxDocTextBytes: number
}

/** 惰性按 `\n` / `\r\n` / `\r` 迭代行，避免对 50 MB 文本一次性 `.split()` 放大堆内存（I-8）。 */
function* iterateTextLines(text: string): Generator<string> {
  if (text === '') return
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 10 /* '\n' */) {
      yield text.slice(start, index)
      start = index + 1
    } else if (code === 13 /* '\r' */) {
      yield text.slice(start, index)
      if (index + 1 < text.length && text.charCodeAt(index + 1) === 10) index += 1
      start = index + 1
    }
  }
  if (start <= text.length) {
    yield text.slice(start)
  }
}

/**
 * 把逐行文本分组为带行号坐标的 section；标题行开启新 section。
 * - Markdown 围栏代码块（`` ``` `` / `~~~`）内的 `#` 注释不再误判为标题（M-5）；
 * - 累计产出字节超出 `maxDocTextBytes` 时立即早停截断，避免对超大文件构建多余 section（I-8）。
 */
function buildLineSectionsFromText(
  text: string,
  opts: LineSectionOptions,
): { readonly sections: ExtractedSection[]; readonly truncated: boolean } {
  const budget = Math.max(0, opts.maxDocTextBytes)
  const sections: ExtractedSection[] = []
  const headingStack: Array<{ readonly level: number; readonly text: string }> = []
  let headingPath = ''
  let headerRow: string | undefined
  let buffer: string[] = []
  let bufferChars = 0
  let startLine = 1
  let endLine = 1
  let usedBytes = 0
  let truncated = false
  let fenceChar: '`' | '~' | null = null
  let fenceLength = 0

  const flush = (): boolean => {
    if (buffer.length === 0) return false
    const joined = buffer.join('\n')
    buffer = []
    bufferChars = 0
    if (joined.trim() === '') return false
    const sectionBytes = Buffer.byteLength(joined, 'utf8')
    if (usedBytes + sectionBytes <= budget) {
      sections.push({
        headingPath,
        locator: { kind: 'line', startLine, endLine },
        text: joined,
        ...(headerRow === undefined ? {} : { headerRow }),
      })
      usedBytes += sectionBytes
      return false
    }
    const tail = truncateToUtf8Bytes(joined, budget - usedBytes)
    if (tail.trim() !== '') {
      sections.push({
        headingPath,
        locator: { kind: 'line', startLine, endLine },
        text: tail,
        ...(headerRow === undefined ? {} : { headerRow }),
      })
    }
    usedBytes = budget
    truncated = true
    return true
  }

  let lineNumber = 0
  for (const line of iterateTextLines(text)) {
    lineNumber += 1
    if (opts.captureHeaderRow && lineNumber === 1) {
      headerRow = line
    }
    if (opts.respectCodeFences) {
      if (fenceChar === null) {
        const openFence = /^\s{0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
        if (openFence !== null) {
          const marker = openFence[1] ?? ''
          const info = openFence[2] ?? ''
          const ch = marker[0]
          if (ch === '~' || (ch === '`' && !info.includes('`'))) {
            fenceChar = ch
            fenceLength = marker.length
          }
        }
      } else {
        const closeFence = fenceChar === '`'
          ? /^\s{0,3}(`{3,})\s*$/u.exec(line)
          : /^\s{0,3}(~{3,})\s*$/u.exec(line)
        if (closeFence !== null && (closeFence[1]?.length ?? 0) >= fenceLength) {
          fenceChar = null
          fenceLength = 0
        }
      }
    }
    if (opts.detectHeadings && fenceChar === null) {
      const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line)
      if (heading !== null) {
        if (flush()) return { sections, truncated: true }
        const level = heading[1]?.length ?? 1
        const headingText = heading[2] ?? ''
        while (headingStack.length > 0 && (headingStack[headingStack.length - 1]?.level ?? 0) >= level) {
          headingStack.pop()
        }
        headingStack.push({ level, text: headingText })
        headingPath = headingStack.map(entry => entry.text).join(' > ')
      }
    }
    if (buffer.length === 0) startLine = lineNumber
    const wouldOverflow = buffer.length >= MAX_SECTION_LINES
      || (buffer.length > 0 && bufferChars + line.length > MAX_SECTION_CHARS)
    if (wouldOverflow) {
      if (flush()) return { sections, truncated: true }
      startLine = lineNumber
    }
    buffer.push(line)
    bufferChars += line.length + 1
    endLine = lineNumber
  }
  flush()
  return { sections, truncated }
}

/** 应用整篇文本字节预算；返回截断后的 section 与是否发生截断。 */
export function applySectionTextBudget(
  sections: readonly ExtractedSection[],
  maxDocTextBytes: number,
): { sections: ExtractedSection[]; truncated: boolean } {
  const budget = Number.isFinite(maxDocTextBytes) ? Math.max(0, Math.floor(maxDocTextBytes)) : 0
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
 * 提取一份文本 / 代码 / 表格文本文件。空文档返回 `indexed` 且无 section；
 * 含 NUL 字节的伪装二进制文件返回 `skipped: 'binary-content'`。
 */
export function extractTextDocument(input: TextExtractionInput): ExtractedDocument {
  const ext = input.ext.toLowerCase()
  const decoded = decodeTextBuffer(input.buffer)
  if (!decoded.ok) {
    return {
      format: ext.slice(1),
      extractMode: 'none',
      extractConfigHash: input.extractConfigHash,
      status: 'skipped',
      statusReason: decoded.reason,
      sections: [],
    }
  }
  const html = HTML_EXTENSIONS.has(ext)
  const sourceText = html ? htmlToText(decoded.text) : decoded.text
  const budget = Number.isFinite(input.maxDocTextBytes)
    ? Math.max(0, Math.floor(input.maxDocTextBytes))
    : 0
  const budgeted = buildLineSectionsFromText(sourceText, {
    detectHeadings: html || ext === '.md',
    respectCodeFences: ext === '.md',
    captureHeaderRow: DELIMITED_EXTENSIONS.has(ext),
    maxDocTextBytes: budget,
  })
  return {
    format: ext.slice(1),
    extractMode: 'text',
    extractConfigHash: input.extractConfigHash,
    status: budgeted.truncated ? 'partial' : 'indexed',
    ...(budgeted.truncated ? { statusReason: 'text-truncated' } : {}),
    sections: budgeted.sections,
  }
}
