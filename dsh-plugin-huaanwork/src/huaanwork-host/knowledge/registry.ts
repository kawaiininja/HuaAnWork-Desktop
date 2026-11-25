/**
 * 知识库注册表 `knowledge-bases.json` 的读写（规格 §5.2）。
 *
 * 格式为 `{ knowledgeBases: KnowledgeBaseRecord[] }`，不另加版本信封。
 * 写入使用 `writeFileAtomic + 0o600`，并按 `profileDir` 串行排队，保证
 * 并发读改写不会互相覆盖；读取对缺失文件返回空数组，逐条字段校验后
 * 丢弃畸形记录。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { assertSafePathSegment } from '../workspace-state.ts'
import type { KnowledgeBaseRecord } from './types.ts'

const REGISTRY_FILENAME = 'knowledge-bases.json'
const REGISTRY_FILE_MODE = 0o600

/** 按注册表文件路径串行化写入（同 profileDir 的并发写排队，跨 profile 互不阻塞）。 */
const writeQueues = new Map<string, Promise<void>>()

function registryPath(profileDir: string): string {
  return join(profileDir, REGISTRY_FILENAME)
}

function parseRecord(raw: unknown): KnowledgeBaseRecord | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.id !== 'string') return null
  if (typeof rec.name !== 'string' || rec.name.trim() === '') return null
  if (typeof rec.sourceDir !== 'string' || rec.sourceDir === '') return null
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

/**
 * 读取注册表。文件缺失、无法解析或顶层形状不符时返回 `[]`；逐条字段
 * 校验，畸形记录被丢弃（读取不产生任何写副作用）。
 */
export async function readKnowledgeBases(profileDir: string): Promise<KnowledgeBaseRecord[]> {
  let content: string
  try {
    content = await readFile(registryPath(profileDir), 'utf8')
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return []
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const rawList = (parsed as { knowledgeBases?: unknown }).knowledgeBases
  if (!Array.isArray(rawList)) return []
  const records: KnowledgeBaseRecord[] = []
  for (const raw of rawList) {
    const record = parseRecord(raw)
    if (record !== null) records.push(record)
  }
  return records
}

/**
 * 原子写入注册表（`writeFileAtomic + 0o600`）。按注册表路径串行排队：
 * 后一次写入总是看到前一次完成的落盘结果；序列化内容在入队前快照，
 * 调用方事后修改数组不影响已排队的写入。
 */
export function writeKnowledgeBases(profileDir: string, records: readonly KnowledgeBaseRecord[]): Promise<void> {
  const filePath = registryPath(profileDir)
  const content = `${JSON.stringify({ knowledgeBases: records }, null, 2)}\n`
  const previous = writeQueues.get(filePath) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(() => writeFileAtomic(filePath, content, { mode: REGISTRY_FILE_MODE }))
  writeQueues.set(filePath, next)
  return next.finally(() => {
    if (writeQueues.get(filePath) === next) writeQueues.delete(filePath)
  })
}
