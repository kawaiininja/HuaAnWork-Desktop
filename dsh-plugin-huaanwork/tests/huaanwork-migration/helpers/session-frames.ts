import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** 同 writeZstdSession 的逐帧容器,但日志行可自定义(legacy 布局与子代理 header)。 */
export function writeZstdLog(path: string, lines: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8')))))
}

/**
 * 首帧的字节终点(结构扫描,转写自上游 frame 遍历
 * session-persistence-jsonl/src/zstd.ts:48-104 的 block 步行:magic + 帧头 +
 * 数据块序列 + 可选校验)。拿到「独立可解码的第一帧」的明文范围,断言与上游
 * assertZstdHeaderFrame(同包 src/index.ts:74-79)同判据。
 */
export function firstZstdFrameEnd(buffer: Buffer): number {
  let offset = 4
  const descriptor = buffer.readUInt8(offset)
  offset += 1
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryFlag = descriptor & 0x03
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  for (;;) {
    const blockHeader = buffer.readUIntLE(offset, 3)
    offset += 3
    const blockType = (blockHeader >>> 1) & 0x03
    const blockSize = blockHeader >>> 3
    offset += blockType === 1 ? 1 : blockSize
    if ((blockHeader & 1) !== 0) break
  }
  return checksum ? offset + 4 : offset
}

/** 独立解码第一帧为文本(与上游 assertZstdHeaderFrame 面对同一段明文)。 */
export function firstZstdFrameText(buffer: Buffer): string {
  return zstdDecompressSync(buffer.subarray(0, firstZstdFrameEnd(buffer))).toString('utf8')
}
