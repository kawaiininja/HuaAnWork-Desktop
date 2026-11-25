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
import { openVerifiedSourceFile, readAndHashHandle } from './safe-read.ts'
import { MAX_FILE_BYTES } from './types.ts'
import type {
  ExtractionFileRequest,
  ExtractionFileResult,
  ExtractionWorkerReadyMessage,
  ExtractionWorkerRequest,
  ExtractionWorkerResponse,
} from './extraction-pool.ts'

disableAsarArchiveView(import.meta.url)

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
  const busyMs = request.debugBusyLoopMs
  if (busyMs !== undefined && Number.isFinite(busyMs) && busyMs > 0) busyLoop(busyMs)
  const delayMs = request.debugDelayMs
  if (delayMs !== undefined && Number.isFinite(delayMs) && delayMs > 0) await delay(delayMs)

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
    const read = await readAndHashHandle(opened.handle, maxBytes ?? MAX_FILE_BYTES)
    if (!read.ok) return { ok: false, reason: 'file-too-large', error: 'file exceeds the byte budget' }
    const size = Number(opened.stat.size)
    const mtimeMs = Number(opened.stat.mtimeMs)
    if (request.hashOnly === true) {
      return { ok: true, hashOnly: true, sha256: read.sha256, size, mtimeMs }
    }
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
    return {
      ok: true,
      sha256: read.sha256,
      size,
      mtimeMs,
      doc,
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
  parentPort?.postMessage(response)
}

// 模块图（含提取器）加载完成后再宣布就绪：池从此刻起才计入单文件超时。
const readyMessage: ExtractionWorkerReadyMessage = { ready: true }
parentPort?.postMessage(readyMessage)

let queue: Promise<void> = Promise.resolve()
parentPort?.on('message', (message: ExtractionWorkerRequest) => {
  queue = queue.then(() => handle(message), () => handle(message)).catch(() => undefined)
})
