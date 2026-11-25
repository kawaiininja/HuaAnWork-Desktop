/**
 * 知识库提取器分派入口（规格 §6.2 / 计划 Task 5）。
 *
 * 纯函数式分派：文本 / 代码 / 表格文本、现代 Office、文字 PDF；音视频在
 * M1 直接 `skipped: 'unsupported-media'`，图片留给 M2 视觉（记为
 * `needs-vision`），其余未知后缀 `skipped: 'unsupported-format'`。
 * 所有分支都产出带 `extractConfigHash` 的 `ExtractedDocument`，绝不抛出。
 *
 * 本文件会被 Worker / 测试以 `.ts` 源码直接加载（Node type-stripping），
 * 因此不得使用 `enum`、构造器参数属性或 `namespace`；纯类型导入必须写
 * `import type`，相对导入保留 `.ts` 后缀。
 */

import { MAX_DOC_TEXT_BYTES } from '../types.ts'
import type { ExtractedDocument } from '../types.ts'
import { computeExtractConfigHash } from './extract-config.ts'
import { extractOoxmlDocument } from './ooxml.ts'
import { extractPdfTextDocument } from './pdf-text.ts'
import { extractTextDocument, TEXT_EXTENSIONS } from './text.ts'

// M-10：哈希实现是零依赖叶子模块，这里仅再导出，供旧调用面使用。
export { computeExtractConfigHash } from './extract-config.ts'
export type { ExtractConfigOptions } from './extract-config.ts'
export { TEXT_EXTENSIONS } from './text.ts'

const OOXML_EXTENSIONS: ReadonlySet<string> = new Set(['.docx', '.xlsx', '.pptx'])

/** 音视频在 M1 无文字提取路径，直接跳过。 */
const AUDIO_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp3',
  '.mp4',
  '.m4a',
  '.m4v',
  '.wav',
  '.aac',
  '.flac',
  '.ogg',
  '.opus',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.wmv',
  '.3gp',
  '.wma',
  '.aiff',
  '.aif',
])

/** 位图在 M1 等待 M2 视觉转写。 */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
])

export interface ExtractFromBufferInput {
  readonly buffer: Buffer
  readonly ext: string
  /** 调用方已算好的配置指纹；缺省按当前默认配置计算。 */
  readonly extractConfigHash?: string
  /** 单文档文本字节上限，缺省 `MAX_DOC_TEXT_BYTES`。 */
  readonly maxDocTextBytes?: number
}

function normalizeExtension(ext: string): string {
  const lower = ext.trim().toLowerCase()
  if (lower === '') return ''
  return lower.startsWith('.') ? lower : `.${lower}`
}

/**
 * 按扩展名从内存缓冲提取一份文档。纯同步提取器也统一返回 Promise，便于
 * Worker 调用面保持一致；任何未预期异常都收敛为 `error` 文档，绝不 reject。
 */
export async function extractFromBuffer(input: ExtractFromBufferInput): Promise<ExtractedDocument> {
  const ext = normalizeExtension(input.ext)
  const extractConfigHash = input.extractConfigHash ?? computeExtractConfigHash()
  const requestedBudget = input.maxDocTextBytes ?? MAX_DOC_TEXT_BYTES
  const maxDocTextBytes = Number.isFinite(requestedBudget)
    ? Math.max(0, Math.floor(requestedBudget))
    : MAX_DOC_TEXT_BYTES
  const format = ext.replace(/^\./u, '')
  const base = { format, extractConfigHash }

  try {
    if (TEXT_EXTENSIONS.has(ext)) {
      return extractTextDocument({ buffer: input.buffer, ext, extractConfigHash, maxDocTextBytes })
    }
    if (OOXML_EXTENSIONS.has(ext)) {
      return extractOoxmlDocument({ buffer: input.buffer, ext, extractConfigHash, maxDocTextBytes })
    }
    if (ext === '.pdf') {
      return await extractPdfTextDocument({ buffer: input.buffer, extractConfigHash, maxDocTextBytes })
    }
  } catch {
    return {
      ...base,
      extractMode: 'none',
      status: 'error',
      statusReason: 'extract-failed',
      sections: [],
    }
  }
  if (AUDIO_VIDEO_EXTENSIONS.has(ext)) {
    return {
      ...base,
      extractMode: 'none',
      status: 'skipped',
      statusReason: 'unsupported-media',
      sections: [],
    }
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return {
      ...base,
      extractMode: 'vision',
      status: 'skipped',
      statusReason: 'needs-vision',
      sections: [],
    }
  }
  return {
    ...base,
    extractMode: 'none',
    status: 'skipped',
    statusReason: 'unsupported-format',
    sections: [],
  }
}

export { extractTextDocument, extractOoxmlDocument, extractPdfTextDocument }
export type { TextExtractionInput } from './text.ts'
export type { OoxmlExtractionInput } from './ooxml.ts'
export type { PdfTextExtractionInput } from './pdf-text.ts'
