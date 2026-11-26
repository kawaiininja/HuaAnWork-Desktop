/**
 * 带 CMaps 的文字层 PDF 提取器（规格 §6.2 / 计划 Task 5，I-2 打包态红线）。
 *
 * 打包态陷阱与对策：
 * - `GlobalWorkerOptions.workerSrc` 必须显式指向 `pdfjs-dist/legacy/build/
 *   pdf.worker.mjs` 的 `file://` URL，否则假 Worker 动态 import 失败；
 * - `cMapUrl` / `standardFontDataUrl` 用 `dirname(require.resolve(
 *   'pdfjs-dist/package.json'))` 定位，并以**本地路径 + 尾部 `/`** 形式
 *   传入：pdfjs v6 的 `NodeBinaryDataFactory` 直接 `fs.readFile(baseUrl +
 *   filename)`，`file://` 字符串会被当成字面路径；
 * - `isEvalSupported: false`、`useSystemFonts: false`，并关闭 Offscreen
 *   Canvas / ImageDecoder，避免 Node 端走到 `@napi-rs/canvas` 渲染依赖。
 *
 * 页级策略（M1）：非空白字符少于 30 的页视为需要视觉；全篇无文字 →
 * `skipped: 'needs-vision'`，混合 PDF → `partial: 'partial-needs-vision'`
 * 并记录 `parsedPages` / `totalPages`。文本总量受 `maxDocTextBytes`
 * 约束，截断置 `partial: 'text-truncated'`。
 *
 * 本文件会被 Worker / 测试以 `.ts` 源码直接加载（Node type-stripping），
 * 因此不得使用 `enum`、构造器参数属性或 `namespace`；纯类型导入必须写
 * `import type`，相对导入保留 `.ts` 后缀。
 */

import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { MAX_DOC_TEXT_BYTES } from '../types.ts'
import type { ExtractedDocument, ExtractedSection } from '../types.ts'
import { truncateToUtf8Bytes } from './text.ts'

const require = createRequire(import.meta.url)

let canvasHookInstalled = false

/**
 * 阻断 `pdfjs-dist` 在 Node 下无条件 `require('@napi-rs/canvas')`（D4 / I-1）：
 * 生产安装包已通过 `build.files` 排除 `@napi-rs/canvas*`，此处使用 Node 官方
 * `module.registerHooks` 确保开发态、Vitest 与可 `terminate()` 的 Extraction Worker
 * 同样绝不加载该原生插件；`pdf.mjs` 对加载失败有内置降级，文字提取不受影响。
 */
export function blockOptionalCanvasAddon(): void {
  if (canvasHookInstalled || typeof registerHooks !== 'function') return
  canvasHookInstalled = true
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        specifier === '@napi-rs/canvas'
        || specifier.startsWith('@napi-rs/canvas/')
        || specifier.startsWith('@napi-rs/canvas-')
      ) {
        const error = new Error(`@napi-rs/canvas is disabled in knowledge extraction (${specifier})`) as NodeJS.ErrnoException
        error.code = 'MODULE_NOT_FOUND'
        throw error
      }
      return nextResolve(specifier, context)
    },
  })
}

/** 文字页判定阈值：非空白字符少于该值视为需要视觉（规格 §6.3）。 */
export const MIN_TEXT_PAGE_CHARS = 30

export interface PdfTextExtractionInput {
  readonly buffer: Buffer
  readonly extractConfigHash: string
  readonly maxDocTextBytes: number
}

interface PdfTextItem {
  readonly str?: string
  readonly hasEOL?: boolean
}

interface PdfTextContent {
  readonly items: readonly PdfTextItem[]
}

interface PdfPageProxy {
  getTextContent(): Promise<PdfTextContent>
  cleanup(): void
}

interface PdfDocumentProxy {
  readonly numPages: number
  getPage(pageNumber: number): Promise<PdfPageProxy>
}

interface PdfLoadingTask {
  readonly promise: Promise<PdfDocumentProxy>
  destroy(): Promise<void>
}

interface PdfJsModule {
  getDocument(options: Record<string, unknown>): PdfLoadingTask
  GlobalWorkerOptions: { workerSrc: string }
}

let pdfjsModulePromise: Promise<PdfJsModule> | undefined

/**
 * 惰性加载 pdfjs-dist 并一次性设置 `workerSrc`。惰性化让文本 / OOXML 提取
 * 不承担 pdfjs 的加载成本，也让单元测试可在不触碰 PDF 时跳过。
 */
async function loadPdfjs(): Promise<PdfJsModule> {
  if (pdfjsModulePromise === undefined) {
    blockOptionalCanvasAddon()
    pdfjsModulePromise = (async () => {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as PdfJsModule
      const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href
      return pdfjs
    })()
  }
  return pdfjsModulePromise
}

/** `pdfjs-dist` 包根（cmaps 与 standard_fonts 的父目录）。 */
function pdfPackageRoot(): string {
  return dirname(require.resolve('pdfjs-dist/package.json'))
}

function countNonWhitespace(text: string): number {
  let count = 0
  for (const char of text) {
    if (!/\s/u.test(char)) count += 1
  }
  return count
}

/** 把 pdfjs 的 text items 拼成一个字符串（保留显式换行标记）。 */
function joinTextItems(items: readonly PdfTextItem[]): string {
  let text = ''
  for (const item of items) {
    if (typeof item.str === 'string') text += item.str
    if (item.hasEOL === true) text += '\n'
  }
  return text
}

/**
 * 提取一份 PDF 的文字层。pdfjs 初始化 / 解析失败收敛为 `error` 结果，
 * 绝不把异常抛给 Worker 主循环。
 */
export async function extractPdfTextDocument(input: PdfTextExtractionInput): Promise<ExtractedDocument> {
  const base = { format: 'pdf', extractConfigHash: input.extractConfigHash }
  let pdfjs: PdfJsModule
  try {
    pdfjs = await loadPdfjs()
  } catch {
    return {
      ...base,
      extractMode: 'none',
      status: 'error',
      statusReason: 'pdfjs-unavailable',
      sections: [],
    }
  }

  const budget = Number.isFinite(input.maxDocTextBytes)
    ? Math.max(0, Math.floor(input.maxDocTextBytes))
    : MAX_DOC_TEXT_BYTES
  let loadingTask: PdfLoadingTask
  try {
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(input.buffer),
      cMapUrl: `${join(pdfPackageRoot(), 'cmaps')}/`,
      cMapPacked: true,
      standardFontDataUrl: `${join(pdfPackageRoot(), 'standard_fonts')}/`,
      isEvalSupported: false,
      useSystemFonts: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
    })
  } catch {
    return {
      ...base,
      extractMode: 'none',
      status: 'error',
      statusReason: 'corrupt-pdf',
      sections: [],
    }
  }

  try {
    const pdf = await loadingTask.promise
    const totalPages = pdf.numPages
    const sections: ExtractedSection[] = []
    let textPages = 0
    let needsVisionPages = 0
    let truncated = false
    let usedBytes = 0

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      let text: string
      try {
        text = joinTextItems((await page.getTextContent()).items)
      } finally {
        page.cleanup()
      }
      if (countNonWhitespace(text) < MIN_TEXT_PAGE_CHARS) {
        needsVisionPages += 1
        continue
      }
      if (usedBytes >= budget) {
        truncated = true
        break
      }
      let pageText = text
      const pageBytes = Buffer.byteLength(pageText, 'utf8')
      if (usedBytes + pageBytes > budget) {
        pageText = truncateToUtf8Bytes(pageText, budget - usedBytes)
        truncated = true
      }
      if (pageText !== '') {
        sections.push({
          headingPath: '',
          locator: { kind: 'page', page: pageNumber, mode: 'text' },
          text: pageText,
        })
        usedBytes += Buffer.byteLength(pageText, 'utf8')
        textPages += 1
      }
      if (truncated) break
    }

    if (textPages === 0 && !truncated) {
      return {
        ...base,
        extractMode: 'vision',
        status: 'skipped',
        statusReason: 'needs-vision',
        sections: [],
        totalPages,
        parsedPages: 0,
      }
    }
    if (needsVisionPages > 0 && !truncated) {
      return {
        ...base,
        extractMode: 'mixed',
        status: 'partial',
        statusReason: 'partial-needs-vision',
        sections,
        totalPages,
        parsedPages: textPages,
      }
    }
    if (truncated) {
      return {
        ...base,
        extractMode: 'text',
        status: 'partial',
        statusReason: 'text-truncated',
        sections,
        totalPages,
        parsedPages: textPages,
      }
    }
    return {
      ...base,
      extractMode: 'text',
      status: 'indexed',
      sections,
      totalPages,
      parsedPages: textPages,
    }
  } catch {
    return {
      ...base,
      extractMode: 'none',
      status: 'error',
      statusReason: 'corrupt-pdf',
      sections: [],
    }
  } finally {
    await loadingTask.destroy().catch(() => undefined)
  }
}
