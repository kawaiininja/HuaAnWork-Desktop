import { readFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'

import { capToolOutput } from '@huaanwork/policy/truncate'
import {
  failureMarkers,
  isShellTool,
  parseToolArguments,
  shellCommandOf,
} from '../client-huaanwork/logic/commandOutcome.ts'
import type { SessionDetailRecord, SessionSummary } from '../client-huaanwork/rpc-types.ts'

const ZSTD_MAGIC = 0xfd2fb528

/**
 * 会话日志的 zstd 容器是「拼接帧」:持久化层每个写批次追加一个完整帧。
 * 单次 zstdDecompressSync 只能解出首帧(只剩 header),必须逐帧解压后拼接。
 * 尾帧不完整(写入进行中被读到)时忽略该尾部,保证读历史不因并发写失败。
 */
export function decompressZstdFrames(buffer: Buffer): string {
  const parts: string[] = []
  let offset = 0
  while (offset < buffer.length) {
    const end = scanZstdFrameEnd(buffer, offset)
    if (end === undefined) break
    parts.push(zstdDecompressSync(buffer.subarray(offset, end)).toString('utf8'))
    offset = end
  }
  return parts.join('')
}

/**
 * 定位自 start 起的单个完整 zstd 帧的结束偏移(不解压数据块)。
 * 帧结构:4B magic + 帧头(descriptor + 可选 window/dictionary/FCS 字段)+ 数据块序列 + 可选 4B 校验。
 * 返回 undefined 表示尾帧不完整;帧结构非法(坏 magic / 保留位)抛错。
 */
function scanZstdFrameEnd(buffer: Buffer, start: number): number | undefined {
  let offset = start
  if (buffer.length - offset < 4) return undefined
  if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
    throw new Error(`corrupt zstd session log: invalid frame magic at byte ${offset}`)
  }
  offset += 4
  if (offset === buffer.length) return undefined
  const descriptor = buffer.readUInt8(offset)
  offset += 1
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 32) !== 0
  const checksum = (descriptor & 4) !== 0
  const dictionaryFlag = descriptor & 3
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  if (buffer.length - offset < headerBytes) return undefined
  offset += headerBytes
  for (;;) {
    if (buffer.length - offset < 3) return undefined
    const blockHeader = buffer.readUIntLE(offset, 3)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 3
    const blockSize = blockHeader >>> 3
    if (blockType === 3) throw new Error(`corrupt zstd session log: reserved block type at byte ${offset - 3}`)
    const payloadBytes = blockType === 1 ? 1 : blockSize
    if (buffer.length - offset < payloadBytes) return undefined
    offset += payloadBytes
    if (lastBlock) break
  }
  if (checksum) {
    if (buffer.length - offset < 4) return undefined
    offset += 4
  }
  return offset
}

/**
 * 会话日志 JSONL 的只读投影:把 dsh 的 append-only 事件日志变成
 * 「任务列表摘要」(session.list)与「可读会话记录」(session.open)。
 *
 * 事件行的既定形状(@deepseek-ai/dsh-session):
 * - header:`{ type: "session", version, id, createdAt, cwd?, origin?, parentSession?, delegationDepth }`
 * - `user/message`:data 即消息 `{ role: "user", content: [{ type: "text", text }], source?: { kind } }`
 * - `assistant/message`:`data.message.content` 为 `reasoning` / `text` / `tool-call` 块
 * - `tool/call`:`data: { turn, step, callId, name, arguments }`
 * - `tool/result`:`data.message.content[0]` 为 `tool-result` 块(含 isError 与文本)
 * - `session/title`:`data: { title, messageSeqs, source }`(取最后一条为准)
 *
 * 解析必须容错:未知事件、坏行、缺字段一律跳过,绝不让列表因单个
 * 损坏日志失败。
 */

/** 标题最长保留 80 字符,避免超长首条消息把列表/弹窗撑爆。 */
const TITLE_MAX_CHARS = 80
/** 工具调用参数在详情里最多展示 200 字符。 */
const ARGS_MAX_CHARS = 200
/** 工具结果在详情里最多展示 8000 字节(历史日志展示上限,非工具输出管道);截断形状与实时桥一致。 */
const RESULT_MAX_BYTES = 8000

type Json = Record<string, unknown>

/** 解析会话日志首行 header;非 `type: "session"` 行返回 undefined。 */
export function parseSessionHeader(line: string): Json | undefined {
  try {
    const value = JSON.parse(line) as Json
    return value.type === 'session' ? value : undefined
  } catch {
    return undefined
  }
}

/** 读取整份会话日志文本;.zstd 为拼接帧容器,逐帧解压拼接。 */
export async function readSessionText(path: string): Promise<string> {
  const contents = await readFile(path)
  return path.endsWith('.zstd') ? decompressZstdFrames(contents) : contents.toString('utf8')
}

/** 只读会话 header(首行)。 */
export async function readSessionHeader(path: string): Promise<Record<string, unknown> | undefined> {
  const [line] = (await readSessionText(path)).split('\n')
  return parseSessionHeader(line ?? '') as Record<string, unknown> | undefined
}

/**
 * 从整份日志文本提取列表摘要。标题优先级:
 * `session/title` 事件(最后一条)> 首条用户消息 > 「未命名 · M月D日」兜底。
 */
export function summarizeSessionLog(text: string): SessionSummary | undefined {
  const lines = text.split('\n')
  const header = parseSessionHeader(lines[0] ?? '')
  if (!header || typeof header.id !== 'string' || typeof header.createdAt !== 'number') return undefined

  let titledFromEvent = ''
  let firstUserText = ''
  let lastTime = header.createdAt
  let messageCount = 0
  let turnCount = 0

  for (const line of lines.slice(1)) {
    const event = parseJsonLine(line)
    if (!event) continue
    if (typeof event.time === 'number' && event.time > lastTime) lastTime = event.time
    const data = asObject(event.data)
    switch (event.type) {
      case 'session/title':
        if (typeof data.title === 'string' && data.title.trim()) titledFromEvent = data.title.trim()
        break
      case 'turn/start':
        turnCount += 1
        break
      case 'user/message': {
        if (sourceKind(data) === 'plugin' || sourceKind(data) === 'tool') break
        messageCount += 1
        if (!firstUserText) firstUserText = firstTextOfMessage(data)
        break
      }
      case 'assistant/message': {
        const message = asObject(data.message)
        if (messageHasVisibleText(message)) messageCount += 1
        break
      }
      default:
        break
    }
  }

  const createdAt = header.createdAt
  return {
    id: header.id,
    title: clipText(titledFromEvent || firstUserText || fallbackTitle(createdAt), TITLE_MAX_CHARS),
    createdAt,
    lastTime,
    ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
    ...(typeof header.origin === 'string' ? { origin: header.origin } : {}),
    ...(typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {}),
    messageCount,
    turnCount,
  }
}

/** 把日志事件流映射为按顺序排列的可读记录(用户消息、助手回复、工具调用与结果)。 */
export function detailRecords(text: string): SessionDetailRecord[] {
  const records: SessionDetailRecord[] = []
  const toolNames = new Map<string, string>()
  const lines = text.split('\n')
  for (const line of lines.slice(1)) {
    const event = parseJsonLine(line)
    if (!event) continue
    const data = asObject(event.data)
    const time = typeof event.time === 'number' ? event.time : 0
    switch (event.type) {
      case 'user/message': {
        const kind = sourceKind(data)
        if (kind === 'plugin' || kind === 'tool') break
        const messageText = firstTextOfMessage(data)
        if (messageText) records.push({ kind: 'user', time, text: messageText })
        break
      }
      case 'assistant/message': {
        const message = asObject(data.message)
        const blocks = Array.isArray(message.content) ? message.content : []
        const reasoningParts: string[] = []
        const textParts: string[] = []
        for (const block of blocks.map((entry) => asObject(entry))) {
          if (block.type === 'reasoning' && typeof block.text === 'string') reasoningParts.push(block.text)
          else if (block.type === 'text' && typeof block.text === 'string') textParts.push(block.text)
        }
        const thought = reasoningParts.map((part) => part.trim()).filter((part) => part.length > 0).join('\n\n')
        const messageText = textParts.join('\n\n').trim()
        if (thought) records.push({ kind: 'thinking', time, text: thought })
        if (messageText) records.push({ kind: 'assistant', time, text: messageText })
        break
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' ? data.name : ''
        const args = formatArgs(data.arguments)
        const command = shellCommandOf(name, data.arguments)
        if (typeof data.callId === 'string') toolNames.set(data.callId, name)
        records.push({
          kind: 'tool-call',
          time,
          name,
          ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
          ...(args !== undefined ? { args } : {}),
          ...(command !== undefined ? { command } : {}),
        })
        break
      }
      case 'tool/result': {
        const message = asObject(data.message)
        const block = Array.isArray(message.content)
          ? message.content.map(asObject).find((entry) => entry.type === 'tool-result')
          : undefined
        const content = Array.isArray(block?.content) ? block.content : []
        const resultText = content
          .map(asObject)
          .filter((entry) => entry.type === 'text' && typeof entry.text === 'string')
          .map((entry) => entry.text as string)
          .join('\n')
          .trim()
        const source = asObject(message.source)
        // 失败标记在未截断的结果文本里解析(截断会丢掉中段);
        // 只对 shell 工具解析,避免读到文件里引用的标记文字。
        const markers = typeof source.callId === 'string' && isShellTool(toolNames.get(source.callId) ?? '')
          ? failureMarkers(resultText)
          : []
        // 与实时桥同一截断形状:保留头、尾和中间的截断标记。
        const capped = capToolOutput(resultText, '', false, RESULT_MAX_BYTES)
        const unshownMarkers = markers.filter((marker) => !capped.text.includes(marker))
        const text = unshownMarkers.length > 0 ? `${capped.text} ${unshownMarkers.join(' ')}` : capped.text
        records.push({
          kind: 'tool-result',
          time,
          ...(typeof source.callId === 'string' ? { callId: source.callId } : {}),
          isError: block?.isError === true || markers.length > 0,
          text,
        })
        break
      }
      default:
        break
    }
  }
  return records
}

function parseJsonLine(line: string): Json | undefined {
  if (!line) return undefined
  try {
    const value = JSON.parse(line) as Json
    return typeof value.type === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

function asObject(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

function sourceKind(message: Json): string {
  const source = asObject(message.source)
  return typeof source.kind === 'string' ? source.kind : ''
}

function firstTextOfMessage(message: Json): string {
  const blocks = Array.isArray(message.content) ? message.content : []
  return blocks
    .map(asObject)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim()
}

function messageHasVisibleText(message: Json): boolean {
  return firstTextOfMessage(message).length > 0
}

function formatArgs(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const parsed = parseToolArguments(value)
  let encoded: string
  if (typeof parsed === 'string') {
    // 不是合法 JSON 的字符串原样展示,避免多包一层引号。
    encoded = parsed
  } else {
    try {
      encoded = JSON.stringify(parsed) ?? ''
    } catch {
      return undefined
    }
  }
  return clipText(encoded, ARGS_MAX_CHARS, '…')
}

/** 单行化并按需截断;超长时追加省略标记。 */
function clipText(text: string, maxChars: number, suffix = '…'): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, maxChars)}${suffix}`
}

function fallbackTitle(createdAt: number): string {
  const date = new Date(createdAt)
  return `未命名 · ${date.getMonth() + 1}月${date.getDate()}日`
}
