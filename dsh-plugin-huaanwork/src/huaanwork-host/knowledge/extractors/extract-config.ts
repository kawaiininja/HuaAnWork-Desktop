/**
 * 提取配置指纹（规格 §6.2 / 控制器裁决 M-10）。
 *
 * 本模块必须保持零 PDF / 提取器依赖：`sync-engine`（Task 6）直接导入叶子
 * 模块，避免为了一个哈希把 `pdfjs-dist` 拉进主线程模块图。canonical JSON
 * 的字段顺序固定，任一配置变化都会让 `extract_config_hash` 变化，从而触发
 * 「以前跳过的扫描件现在可以补」的重新提取。
 *
 * 本文件会被 Worker / 测试以 `.ts` 源码直接加载（Node type-stripping），
 * 因此不得使用 `enum`、构造器参数属性或 `namespace`；纯类型导入必须写
 * `import type`，相对导入保留 `.ts` 后缀。
 */

import { createHash } from 'node:crypto'

import { EXTRACTOR_PIPELINE_VERSION, MAX_VISION_PDF_PAGES } from '../types.ts'

export interface ExtractConfigOptions {
  /** 解析器流水线版本，缺省 `EXTRACTOR_PIPELINE_VERSION`。 */
  readonly pipelineVersion?: string
  /** 视觉转写开关，缺省 `false`。 */
  readonly visionEnabled?: boolean
  /** 视觉模型标识，缺省空串。 */
  readonly visionModelId?: string
  /** 单份 PDF 视觉页上限，缺省 `MAX_VISION_PDF_PAGES`。 */
  readonly maxVisionPdfPages?: number
}

/**
 * 对规范 JSON `{ pipelineVersion, visionEnabled, visionModelId,
 * maxVisionPdfPages }` 取 SHA-256 十六进制摘要。
 */
export function computeExtractConfigHash(opts: ExtractConfigOptions = {}): string {
  const config = {
    pipelineVersion: opts.pipelineVersion ?? EXTRACTOR_PIPELINE_VERSION,
    visionEnabled: opts.visionEnabled ?? false,
    visionModelId: opts.visionModelId ?? '',
    maxVisionPdfPages: opts.maxVisionPdfPages ?? MAX_VISION_PDF_PAGES,
  }
  return createHash('sha256').update(JSON.stringify(config), 'utf8').digest('hex')
}
