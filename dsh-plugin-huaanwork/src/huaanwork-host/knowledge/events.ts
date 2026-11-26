/**
 * 知识库事件日志 `events.jsonl` 的脱敏、UTF-8 安全截断、上限裁剪与胶囊筛选
 * （规格 §2.3 / §8.3）。
 *
 * 每条记录先经 `maskSecrets()` 脱敏，再按 UTF-8 字节边界安全截断
 * `summary`（≤ 512 B）与 `detail`（≤ 4 KB），绝不劈裂多字节字符。追加通过
 * 按 `kbDir` 串行化的 Promise 链完成读改写：从头部丢弃最旧条目直到
 * `lines.length <= 500 && payload <= 512 KB`，再以 `writeFileAtomic + 0o600`
 * 落盘。筛选只有 `matchesEventFilter(kind, filter)` 一个映射权威
 * （控制器裁决 M-15：不另建 `EVENT_FILTER_BY_KIND` 副本）。
 *
 * 本文件会被 Worker/测试以 `.ts` 源码直接加载（Node type-stripping），因此
 * 不得使用 `enum`、构造器参数属性或 `namespace`；纯类型导入必须写
 * `import type`，相对导入保留 `.ts` 后缀。
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { maskSecrets } from '../../mask-secrets.ts'
import type { KnowledgeEventKind, KnowledgeEventLevel, KnowledgeEventRecord } from './types.ts'

export const EVENT_MAX_LINES = 500
export const EVENT_MAX_BYTES = 512 * 1024
export const EVENT_SUMMARY_MAX_BYTES = 512
export const EVENT_DETAIL_MAX_BYTES = 4 * 1024

const EVENTS_FILENAME = 'events.jsonl'
const EVENTS_FILE_MODE = 0o600

export type KnowledgeEventFilter = 'all' | 'alerts' | 'organize' | 'sync'

/** 追加输入：记录身份与时间戳可由调用方注入（测试确定性），缺省自动生成。 */
export type AppendKnowledgeEventInput = Omit<KnowledgeEventRecord, 'id' | 'at'> & {
  readonly id?: string
  readonly at?: string
}

export interface ReadKnowledgeEventsOptions {
  /** 返回最近 N 条（保持时间升序）；缺省返回全部命中记录。 */
  readonly limit?: number
  readonly filter?: KnowledgeEventFilter
}

/**
 * 事件种类到胶囊的唯一映射权威（控制器裁决 M-15，规格 §8.3）：
 * 用 `Record<KnowledgeEventKind, ...>` 在编译期锁死全部 19 种事件的覆盖，
 * 避免新增 `KnowledgeEventKind` 时漏掉胶囊或读取白名单。
 */
const EVENT_FILTERS: Readonly<Record<KnowledgeEventKind, readonly Exclude<KnowledgeEventFilter, 'all'>[]>> = {
  sync_started: ['sync'],
  sync_completed: ['sync'],
  file_indexed: ['sync'],
  file_renamed: ['sync'],
  file_deleted: ['sync'],
  file_skipped: ['alerts'],
  file_error: ['alerts'],
  source_rebound: ['sync'],
  rebuild_completed: ['sync'],
  rebuild_failed: ['alerts'],
  wiki_reset_failed: ['alerts'],
  organize_started: ['organize'],
  organize_completed: ['organize'],
  organize_failed: ['alerts', 'organize'],
  organize_cancelled: ['organize'],
  source_unavailable: ['alerts'],
  source_restored: ['sync'],
  watch_failed: ['alerts'],
  cloud_probe_unavailable: ['sync'],
}

/** 读取侧合法种类集合：由 `EVENT_FILTERS` 派生，保证与筛选权威单一来源。 */
const KNOWN_EVENT_KINDS: ReadonlySet<string> = new Set<string>(Object.keys(EVENT_FILTERS))

/**
 * 唯一的事件胶囊映射权威（控制器裁决 M-15，规格 §8.3）：
 * - `'all'` 全命中；
 * - `'alerts'` 命中 `file_skipped | file_error | rebuild_failed |
 *   wiki_reset_failed | organize_failed | source_unavailable | watch_failed`；
 * - `'organize'` 命中全部 `organize_*`（`organize_failed` 同时属于两个胶囊）；
 * - `'sync'` 命中 `sync_started | sync_completed | file_indexed | file_renamed |
 *   file_deleted | source_rebound | rebuild_completed | source_restored |
 *   cloud_probe_unavailable`。
 */
export function matchesEventFilter(kind: KnowledgeEventKind, filter: KnowledgeEventFilter): boolean {
  if (filter === 'all') return true
  return EVENT_FILTERS[kind].includes(filter)
}

/**
 * 先脱敏再按 UTF-8 字节上限截断，且绝不劈裂多字节字符：若上限位置落在
 * 续字节（`10xxxxxx`）上，则回退到该字符的起始字节。
 */
function sanitizeText(text: string, maxBytes: number): string {
  const masked = maskSecrets(text)
  const bytes = Buffer.from(masked, 'utf8')
  if (bytes.byteLength <= maxBytes) return masked
  let end = maxBytes
  while (end > 0) {
    const byte = bytes[end]
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) break
    end -= 1
  }
  return bytes.subarray(0, end).toString('utf8')
}

/** 构造一条脱敏并裁剪后的完整记录；可选字段缺省时不出现在 JSON 中。 */
function buildRecord(input: AppendKnowledgeEventInput): KnowledgeEventRecord {
  const summary = sanitizeText(input.summary, EVENT_SUMMARY_MAX_BYTES)
  const detail = input.detail === undefined
    ? undefined
    : sanitizeText(input.detail, EVENT_DETAIL_MAX_BYTES)
  const relPath = input.relPath === undefined ? undefined : maskSecrets(input.relPath)
  return {
    id: input.id ?? randomUUID(),
    at: input.at ?? new Date().toISOString(),
    kind: input.kind,
    level: input.level,
    summary,
    ...(detail === undefined ? {} : { detail }),
    ...(relPath === undefined ? {} : { relPath }),
    ...(input.count === undefined ? {} : { count: input.count }),
  }
}

function isEventLevel(value: unknown): value is KnowledgeEventLevel {
  return value === 'info' || value === 'warn' || value === 'error'
}

/** 逐字段校验一行 JSON；畸形记录返回 `null`，读取侧静默丢弃。 */
function parseEventRecord(raw: unknown): KnowledgeEventRecord | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.id !== 'string' || rec.id === '') return null
  if (typeof rec.at !== 'string' || rec.at === '') return null
  if (typeof rec.kind !== 'string' || !KNOWN_EVENT_KINDS.has(rec.kind)) return null
  if (!isEventLevel(rec.level)) return null
  if (typeof rec.summary !== 'string') return null
  if (rec.detail !== undefined && typeof rec.detail !== 'string') return null
  if (rec.relPath !== undefined && typeof rec.relPath !== 'string') return null
  if (rec.count !== undefined && (typeof rec.count !== 'number' || !Number.isFinite(rec.count))) return null
  const detail = typeof rec.detail === 'string' ? rec.detail : undefined
  const relPath = typeof rec.relPath === 'string' ? rec.relPath : undefined
  const count = typeof rec.count === 'number' ? rec.count : undefined
  return {
    id: rec.id,
    at: rec.at,
    kind: rec.kind as KnowledgeEventKind,
    level: rec.level,
    summary: rec.summary,
    ...(detail === undefined ? {} : { detail }),
    ...(relPath === undefined ? {} : { relPath }),
    ...(count === undefined ? {} : { count }),
  }
}

function eventsPath(kbDir: string): string {
  return join(kbDir, EVENTS_FILENAME)
}

async function readEventRecords(filePath: string): Promise<KnowledgeEventRecord[]> {
  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return []
    throw error
  }
  const records: KnowledgeEventRecord[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    const record = parseEventRecord(parsed)
    if (record !== null) records.push(record)
  }
  return records
}

/**
 * 把记录序列化为受 500 行 / 512 KB 双上限约束的 JSONL 载荷：从头部丢弃
 * 最旧条目直到满足上限，且始终至少保留最新一条（单条记录本身已有
 * `summary` / `detail` 上限，必然低于文件上限）。
 */
function boundedPayload(records: readonly KnowledgeEventRecord[]): string {
  const lines = records.map(record => JSON.stringify(record))
  let totalBytes = 0
  for (const line of lines) totalBytes += Buffer.byteLength(line, 'utf8') + 1
  let dropped = 0
  while (
    lines.length - dropped > 1
    && (lines.length - dropped > EVENT_MAX_LINES || totalBytes > EVENT_MAX_BYTES)
  ) {
    const line = lines[dropped]
    if (line !== undefined) totalBytes -= Buffer.byteLength(line, 'utf8') + 1
    dropped += 1
  }
  const kept = dropped === 0 ? lines : lines.slice(dropped)
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`
}

async function appendRecord(filePath: string, record: KnowledgeEventRecord): Promise<void> {
  const existing = await readEventRecords(filePath)
  existing.push(record)
  await writeFileAtomic(filePath, boundedPayload(existing), { mode: EVENTS_FILE_MODE })
}

/** 按事件文件路径串行化读改写（同 kbDir 排队，跨库互不阻塞）。 */
const appendQueues = new Map<string, Promise<void>>()

/**
 * 追加一条事件：先脱敏/截断，再入队串行读改写 `events.jsonl`，最后以
 * `writeFileAtomic + 0o600` 落盘。返回实际写入（或前端可见）的记录。
 */
export function appendKnowledgeEvent(
  kbDir: string,
  input: AppendKnowledgeEventInput,
): Promise<KnowledgeEventRecord> {
  const filePath = eventsPath(kbDir)
  const record = buildRecord(input)
  const previous = appendQueues.get(filePath) ?? Promise.resolve()
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      await appendRecord(filePath, record)
      return record
    })
  const tracked = run.then(() => undefined, () => undefined)
  appendQueues.set(filePath, tracked)
  return run.finally(() => {
    if (appendQueues.get(filePath) === tracked) appendQueues.delete(filePath)
  })
}

/**
 * 读取事件日志（时间升序）。筛选一律经 `matchesEventFilter` 单一映射；
 * `limit` 返回最近 N 条并保持升序。文件缺失或行损坏时降级为空/丢弃。
 */
export async function readKnowledgeEvents(
  kbDir: string,
  opts?: ReadKnowledgeEventsOptions,
): Promise<KnowledgeEventRecord[]> {
  const records = await readEventRecords(eventsPath(kbDir))
  const filter = opts?.filter ?? 'all'
  const matched = records.filter(record => matchesEventFilter(record.kind, filter))
  const limit = opts?.limit
  if (limit === undefined || !Number.isFinite(limit)) return matched
  const bounded = Math.max(0, Math.floor(limit))
  return bounded >= matched.length ? matched : matched.slice(matched.length - bounded)
}
