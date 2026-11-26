/**
 * 知识库注册表 `knowledge-bases.json` 的读写（规格 §5.2）。
 *
 * 格式为 `{ knowledgeBases: KnowledgeBaseRecord[] }`，不另加版本信封。
 * 写入使用 `writeFileAtomic + 0o600`，并按 `profileDir` 串行排队，保证
 * 并发读改写不会互相覆盖；读取对缺失文件返回空数组，逐条字段校验后
 * 丢弃畸形记录。顶层 JSON 解析失败或形状不符时，原文件被隔离为
 * `knowledge-bases.json.corrupt-<UTC 时间戳>`（`rename` 保持原 0o600 权限）
 * 并返回空数组，避免下一次写入静默抹掉用户的全部绑定。
 */

import { randomBytes } from 'node:crypto'
import { readFile, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { assertSafePathSegment } from '../workspace-state.ts'
import { foldAsciiPath, isUncOrDevicePath } from './paths.ts'
import type { KnowledgeBaseRecord } from './types.ts'

const REGISTRY_FILENAME = 'knowledge-bases.json'
const REGISTRY_FILE_MODE = 0o600

/** 按规范化注册表文件路径串行化写与损坏隔离（同 profileDir 排队，跨 profile 互不阻塞）。 */
const writeQueues = new Map<string, Promise<void>>()

function registryPath(profileDir: string): string {
  return join(profileDir, REGISTRY_FILENAME)
}

function registryQueueKey(profileDir: string): string {
  const full = resolve(registryPath(profileDir))
  return process.platform === 'win32' ? foldAsciiPath(full) : full
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function parseRecord(raw: unknown): KnowledgeBaseRecord | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.id !== 'string') return null
  if (typeof rec.name !== 'string' || rec.name.trim() === '') return null
  if (typeof rec.sourceDir !== 'string' || rec.sourceDir.trim() === '' || isUncOrDevicePath(rec.sourceDir)) return null
  if (typeof rec.autoOrganize !== 'boolean') return null
  if (typeof rec.watchPaused !== 'boolean') return null
  if (typeof rec.createdAt !== 'string' || rec.createdAt === '') return null
  let id: string
  try {
    id = assertSafePathSegment(rec.id, 'kbId')
  } catch {
    return null
  }
  return {
    id,
    name: rec.name,
    sourceDir: rec.sourceDir,
    autoOrganize: rec.autoOrganize,
    watchPaused: rec.watchPaused,
    createdAt: rec.createdAt,
  }
}

function parseRegistryContent(content: string): { readonly ok: true; readonly records: KnowledgeBaseRecord[] } | { readonly ok: false } {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { ok: false }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false }
  }
  const rawList = (parsed as { knowledgeBases?: unknown }).knowledgeBases
  if (!Array.isArray(rawList)) {
    return { ok: false }
  }
  const records: KnowledgeBaseRecord[] = []
  const seenIds = new Set<string>()
  for (const raw of rawList) {
    const record = parseRecord(raw)
    if (record === null) {
      const id = typeof (raw as { id?: unknown } | null)?.id === 'string'
        ? (raw as { id: string }).id
        : '<unknown>'
      console.warn(`[knowledge] dropped invalid knowledge base record ${id} from knowledge-bases.json`)
      continue
    }
    if (seenIds.has(record.id)) {
      console.warn(`[knowledge] dropped duplicate knowledge base record ${record.id} from knowledge-bases.json`)
      continue
    }
    seenIds.add(record.id)
    records.push(record)
  }
  return { ok: true, records }
}

function enqueueRegistryMutation<T>(profileDir: string, task: () => Promise<T>): Promise<T> {
  const key = registryQueueKey(profileDir)
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(task)
  const tracked = next.then(() => undefined, () => undefined)
  writeQueues.set(key, tracked)
  return next.finally(() => {
    if (writeQueues.get(key) === tracked) writeQueues.delete(key)
  })
}

/**
 * 在同路径串行队列内隔离无法解析的注册表（I-10）：
 * 进队列后复读文件，若并发写已将其替换为合法 JSON 则直接返回合法记录、绝不误删；
 * 若并发读已将其隔离（`ENOENT`）则返回空数组；真实隔离失败仍 fail-closed 抛出。
 */
function quarantineCorruptRegistrySerialized(profileDir: string): Promise<KnowledgeBaseRecord[]> {
  return enqueueRegistryMutation(profileDir, async (): Promise<KnowledgeBaseRecord[]> => {
    const source = registryPath(profileDir)
    let latestContent: string
    try {
      latestContent = await readFile(source, 'utf8')
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') return []
      throw error
    }
    const reparsed = parseRegistryContent(latestContent)
    if (reparsed.ok) return reparsed.records

    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    const suffix = randomBytes(4).toString('hex')
    const target = `${source}.corrupt-${stamp}-${suffix}`
    try {
      await rename(source, target)
      console.warn(`[knowledge] quarantined corrupt knowledge-bases.json: ${source} -> ${target}`)
      return []
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      console.warn(
        `[knowledge] failed to quarantine corrupt knowledge-bases.json ${source}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  })
}

/**
 * 读取注册表。文件缺失返回 `[]`；顶层 JSON 解析失败或形状不符时串行隔离原
 * 文件（`knowledge-bases.json.corrupt-<UTC 时间戳>`）后返回 `[]`；逐条字段
 * 校验并按 `id` 去重，畸形记录被丢弃并逐条告警。
 */
export async function readKnowledgeBases(profileDir: string): Promise<KnowledgeBaseRecord[]> {
  let content: string
  try {
    content = await readFile(registryPath(profileDir), 'utf8')
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
  const parsed = parseRegistryContent(content)
  if (!parsed.ok) {
    return await quarantineCorruptRegistrySerialized(profileDir)
  }
  return parsed.records
}

/**
 * 原子写入注册表（`writeFileAtomic + 0o600`）。按规范化路径串行排队：
 * 后一次写入总是看到前一次完成的落盘结果；序列化内容在入队前快照，
 * 调用方事后修改数组不影响已排队的写入。
 */
export function writeKnowledgeBases(profileDir: string, records: readonly KnowledgeBaseRecord[]): Promise<void> {
  const filePath = registryPath(profileDir)
  const content = `${JSON.stringify({ knowledgeBases: records }, null, 2)}\n`
  return enqueueRegistryMutation(profileDir, () => writeFileAtomic(filePath, content, { mode: REGISTRY_FILE_MODE }))
}
