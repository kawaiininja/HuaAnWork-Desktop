/**
 * Extraction Worker 入口（规格 §5.3(1) / §6.2 / 计划 Task 6）。
 *
 * 只做两件事：按安全只读链打开/校验源文件并计算 `sha256`（`hashOnly` 通道），
 * 或在内存里解析 + 切片后把结果回传 Host。不打开 SQLite、不碰 Electron
 * `nativeImage`，也不写任何文件。
 *
 * 首条执行语句必须是 `disableAsarArchiveView(import.meta.url)`：Worker 会读用户
 * 目录，Electron 的 `.asar` 透明视图必须在这里关闭（与 Storage Worker 对齐）。
 *
 * 本文件会被测试以 `.ts` 源码直接加载（Node type-stripping），因此不得使用
 * `enum`、构造器参数属性与 `namespace`；纯类型导入必须写 `import type`，
 * 相对导入保留 `.ts` 后缀。
 */

import { extname } from 'node:path'
import { parentPort } from 'node:worker_threads'

import { disableAsarArchiveView } from '../../asar-archive-policy.ts'
import { chunkExtractedDocument } from './chunker.ts'
import { extractFromBuffer } from './extractors/index.ts'
import { blockOptionalCanvasAddon } from './extractors/pdf-text.ts'
import { hashHandle, openVerifiedSourceFile, readAndHashHandle } from './safe-read.ts'
import { MAX_FILE_BYTES } from './types.ts'
import type {
  ExtractionFileRequest,
  ExtractionFileResult,
  ExtractionWorkerReadyMessage,
  ExtractionWorkerRequest,
  ExtractionWorkerResponse,
} from './extraction-pool.ts'

disableAsarArchiveView(import.meta.url)
blockOptionalCanvasAddon()

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 测试缝：同步占满 CPU，验证池的强制 `terminate()` 能回收线程。 */
function busyLoop(ms: number): void {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    // 忙等：故意不 yield，模拟解析器卡死。
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 单文件提取：安全打开 → 哈希（必要时解析 + 切片）→ 关闭句柄。 */
async function extractOne(request: ExtractionFileRequest): Promise<ExtractionFileResult> {
  // 测试缝仅在 VITEST 下生效，与 Storage Worker（M-1）一致，生产路径绝不执行。
  if (process.env['VITEST'] !== undefined) {
    const busyMs = request.debugBusyLoopMs
    if (busyMs !== undefined && Number.isFinite(busyMs) && busyMs > 0) busyLoop(busyMs)
    const delayMs = request.debugDelayMs
    if (delayMs !== undefined && Number.isFinite(delayMs) && delayMs > 0) await delay(delayMs)
  }

  const maxBytes = request.maxBytes
  const opened = await openVerifiedSourceFile(request.sourceRoot, request.filePath, {
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(request.caseSensitive === undefined ? {} : { caseSensitive: request.caseSensitive }),
  })
  if (!opened.ok) {
    return {
      ok: false,
      reason: opened.reason,
      ...(opened.error === undefined ? {} : { error: opened.error }),
    }
  }
  try {
    const size = Number(opened.stat.size)
    const mtimeMs = Number(opened.stat.mtimeMs)
    if (request.hashOnly === true) {
      // `hashOnly` 通道零缓冲流式算 SHA-256，避免把 50 MB 文件翻倍缓存在 256 MB Worker 堆上（I-8）。
      const hashed = await hashHandle(opened.handle, maxBytes ?? MAX_FILE_BYTES)
      if (!hashed.ok) return { ok: false, reason: 'file-too-large', error: 'file exceeds the byte budget' }
      return { ok: true, hashOnly: true, sha256: hashed.sha256, size, mtimeMs }
    }
    const read = await readAndHashHandle(opened.handle, maxBytes ?? MAX_FILE_BYTES)
    if (!read.ok) return { ok: false, reason: 'file-too-large', error: 'file exceeds the byte budget' }
    const maxDocTextBytes = request.maxDocTextBytes
    const doc = await extractFromBuffer({
      buffer: read.buffer,
      ext: extname(request.filePath),
      ...(maxDocTextBytes === undefined ? {} : { maxDocTextBytes }),
    })
    const chunked = chunkExtractedDocument(
      doc,
      maxDocTextBytes === undefined ? {} : { maxTextBytes: maxDocTextBytes },
    )
    // 切片触及 500 片 / 文本上限时把 `indexed` 提升为 `partial: 'text-truncated'`，绝不静默丢内容（I-6）。
    const finalDoc = chunked.truncated && doc.status === 'indexed'
      ? { ...doc, status: 'partial' as const, statusReason: 'text-truncated' }
      : doc
    return {
      ok: true,
      sha256: read.sha256,
      size,
      mtimeMs,
      doc: finalDoc,
      chunks: chunked.chunks,
      truncated: chunked.truncated,
    }
  } catch (error) {
    return { ok: false, reason: 'read-error', error: describeError(error) }
  } finally {
    await opened.handle.close().catch(() => undefined)
  }
}

async function handle(message: ExtractionWorkerRequest): Promise<void> {
  let result: ExtractionFileResult
  try {
    result = await extractOne(message.request)
  } catch (error) {
    result = { ok: false, reason: 'read-error', error: describeError(error) }
  }
  const response: ExtractionWorkerResponse = { id: message.id, ok: true, result }
  try {
    parentPort?.postMessage(response)
  } catch (error) {
    const fallback: ExtractionWorkerResponse = { id: message.id, ok: false, error: describeError(error) }
    parentPort?.postMessage(fallback)
  }
}

// 模块图（含提取器）加载完成后再宣布就绪：池从此刻起才计入单文件超时。
const readyMessage: ExtractionWorkerReadyMessage = { ready: true }
parentPort?.postMessage(readyMessage)

let queue: Promise<void> = Promise.resolve()
parentPort?.on('message', (message: ExtractionWorkerRequest) => {
  queue = queue.then(() => handle(message), () => handle(message)).catch(() => undefined)
})
