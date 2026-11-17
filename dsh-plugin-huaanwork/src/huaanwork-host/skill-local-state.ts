import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { SKILL_NAME_RE } from '@huaanwork/skill-format/markdown'
import type {
  SkillLocalEntry,
  SkillLocalStateDocument,
  SkillOrigin,
} from '../client-huaanwork/rpc-types.ts'

/**
 * 本地技能状态的两个独立文档:
 *
 * - `user-skill-toggles.json`:只保存 enabled=true 的本地技能名;缺失键即禁用。
 *   迁移后的普通内置副本也走这张表(旧 `skill-toggles.json` 只作为迁移输入)。
 * - `skill-local-state.json`:本地来源、当前内容摘要与发布快照。
 *
 * 两个文档都采用同目录临时文件 + rename 原子写。损坏的文档必须抛具名错误,
 * 不能静默解释成“全部禁用”——否则一次坏文件就会把所有显式 `/` 调用关掉。
 */

export const USER_SKILL_TOGGLES_FILE = 'user-skill-toggles.json'
export const SKILL_LOCAL_STATE_FILE = 'skill-local-state.json'

export class CorruptUserSkillTogglesError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CorruptUserSkillTogglesError'
  }
}

export class CorruptSkillLocalStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CorruptSkillLocalStateError'
  }
}

export function userSkillTogglesPath(profileDir: string): string {
  return join(profileDir, USER_SKILL_TOGGLES_FILE)
}

export function skillLocalStatePath(profileDir: string): string {
  return join(profileDir, SKILL_LOCAL_STATE_FILE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读取 JSON 文档:缺失返回 undefined,其余读取/解析错误由调用方转成具名错误。 */
function readJsonDocument(path: string, label: string, ErrorType: new (message: string) => Error): unknown {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new ErrorType(`${label}无法读取(${path}):${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new ErrorType(`${label}不是合法 JSON:${path}`)
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 清理临时文件失败不得遮蔽原始写入错误
    }
    throw error
  }
}

export function readUserSkillToggles(profileDir: string): Record<string, true> {
  const path = userSkillTogglesPath(profileDir)
  const parsed = readJsonDocument(path, '用户技能启用状态', CorruptUserSkillTogglesError)
  if (parsed === undefined) return {}
  if (!isRecord(parsed)) {
    throw new CorruptUserSkillTogglesError(`用户技能启用状态必须是 JSON 对象:${path}`)
  }
  const toggles: Record<string, true> = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (!SKILL_NAME_RE.test(name)) {
      throw new CorruptUserSkillTogglesError(`用户技能启用状态包含非法技能名 ${JSON.stringify(name)}:${path}`)
    }
    if (value !== true) {
      throw new CorruptUserSkillTogglesError(
        `用户技能启用状态只能保存 enabled=true 的技能名,发现 ${JSON.stringify(name)} 的值不是 true:${path}`,
      )
    }
    toggles[name] = true
  }
  return toggles
}

export function setUserSkillToggle(profileDir: string, name: string, enabled: boolean): void {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`invalid skill name: ${name}`)
  const toggles = readUserSkillToggles(profileDir)
  if (enabled) toggles[name] = true
  else if (Object.hasOwn(toggles, name)) delete toggles[name]
  writeJsonAtomic(userSkillTogglesPath(profileDir), toggles)
}

function requireString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CorruptSkillLocalStateError(`本地技能状态 ${field} 必须是非空字符串:${path}`)
  }
  return value
}

function validateOrigin(value: unknown, name: string, path: string): SkillOrigin {
  if (!isRecord(value)) {
    throw new CorruptSkillLocalStateError(`本地技能状态 ${name}.origin 必须是对象:${path}`)
  }
  switch (value.kind) {
    case 'created':
    case 'imported':
    case 'bundled':
      return { kind: value.kind }
    case 'catalog': {
      const originName = requireString(value.name, `${name}.origin.name`, path)
      const publisher = requireString(value.publisher, `${name}.origin.publisher`, path)
      const digest = requireString(value.digest, `${name}.origin.digest`, path)
      if (!SKILL_NAME_RE.test(originName)) {
        throw new CorruptSkillLocalStateError(`本地技能状态 ${name}.origin.name 不是合法技能名:${path}`)
      }
      if (typeof value.revision !== 'number' || !Number.isInteger(value.revision) || value.revision < 1) {
        throw new CorruptSkillLocalStateError(`本地技能状态 ${name}.origin.revision 必须是正整数:${path}`)
      }
      return { kind: 'catalog', name: originName, revision: value.revision, publisher, digest }
    }
    default:
      throw new CorruptSkillLocalStateError(`本地技能状态 ${name}.origin.kind 非法:${path}`)
  }
}

function validateEntry(name: string, value: unknown, path: string): SkillLocalEntry {
  if (!isRecord(value)) {
    throw new CorruptSkillLocalStateError(`本地技能状态 ${name} 必须是对象:${path}`)
  }
  const entry: SkillLocalEntry = {
    origin: validateOrigin(value.origin, name, path),
    contentDigest: requireString(value.contentDigest, `${name}.contentDigest`, path),
  }
  if (value.publishedRevision !== undefined) {
    if (
      typeof value.publishedRevision !== 'number' ||
      !Number.isInteger(value.publishedRevision) ||
      value.publishedRevision < 1
    ) {
      throw new CorruptSkillLocalStateError(`本地技能状态 ${name}.publishedRevision 必须是正整数:${path}`)
    }
    entry.publishedRevision = value.publishedRevision
  }
  if (value.publishedDigest !== undefined) {
    entry.publishedDigest = requireString(value.publishedDigest, `${name}.publishedDigest`, path)
  }
  if (value.creationDraftId !== undefined) {
    entry.creationDraftId = requireString(value.creationDraftId, `${name}.creationDraftId`, path)
  }
  if (value.creationSessionId !== undefined) {
    entry.creationSessionId = requireString(value.creationSessionId, `${name}.creationSessionId`, path)
  }
  if ((value.creationDraftId === undefined) !== (value.creationSessionId === undefined)) {
    throw new CorruptSkillLocalStateError(`本地技能状态 creationDraftId 与 creationSessionId 必须同时存在:${path}`)
  }
  return entry
}

export function readSkillLocalState(profileDir: string): SkillLocalStateDocument {
  const path = skillLocalStatePath(profileDir)
  const parsed = readJsonDocument(path, '本地技能状态', CorruptSkillLocalStateError)
  if (parsed === undefined) return { schemaVersion: 1, skills: {} }
  if (!isRecord(parsed)) {
    throw new CorruptSkillLocalStateError(`本地技能状态必须是 JSON 对象:${path}`)
  }
  if (parsed.schemaVersion !== 1) {
    throw new CorruptSkillLocalStateError(`本地技能状态 schemaVersion 必须为 1:${path}`)
  }
  if (!isRecord(parsed.skills)) {
    throw new CorruptSkillLocalStateError(`本地技能状态 skills 必须是 JSON 对象:${path}`)
  }

  const skills: Record<string, SkillLocalEntry> = {}
  for (const [name, value] of Object.entries(parsed.skills)) {
    if (!SKILL_NAME_RE.test(name)) {
      throw new CorruptSkillLocalStateError(`本地技能状态包含非法技能名 ${JSON.stringify(name)}:${path}`)
    }
    skills[name] = validateEntry(name, value, path)
  }

  const document: SkillLocalStateDocument = { schemaVersion: 1, skills }
  if (parsed.migration !== undefined) {
    if (!isRecord(parsed.migration) || parsed.migration.version !== 1) {
      throw new CorruptSkillLocalStateError(`本地技能状态 migration 必须是 { version: 1 } 记录:${path}`)
    }
    document.migration = {
      version: 1,
      completedAt: requireString(parsed.migration.completedAt, 'migration.completedAt', path),
    }
  }
  if (parsed.migrationWarnings !== undefined) {
    if (!Array.isArray(parsed.migrationWarnings) || !parsed.migrationWarnings.every((item) => typeof item === 'string')) {
      throw new CorruptSkillLocalStateError(`本地技能状态 migrationWarnings 必须是字符串数组:${path}`)
    }
    document.migrationWarnings = [...parsed.migrationWarnings]
  }
  return document
}

export function writeSkillLocalEntry(profileDir: string, name: string, entry: SkillLocalEntry): void {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`invalid skill name: ${name}`)
  const state = readSkillLocalState(profileDir)
  state.skills[name] = entry
  writeJsonAtomic(skillLocalStatePath(profileDir), state)
}

export function removeSkillLocalEntry(profileDir: string, name: string): void {
  const state = readSkillLocalState(profileDir)
  if (!Object.hasOwn(state.skills, name)) return
  delete state.skills[name]
  writeJsonAtomic(skillLocalStatePath(profileDir), state)
}

/**
 * 写一次性迁移完成标记。只有所有副本与状态写成功后才调用;文档本身仍是
 * 原子替换,失败不会留下半个标记。
 */
export function markSkillCenterMigrationComplete(profileDir: string, warnings: readonly string[] = []): void {
  const state = readSkillLocalState(profileDir)
  const document: SkillLocalStateDocument = {
    schemaVersion: 1,
    skills: state.skills,
    migration: { version: 1, completedAt: new Date().toISOString() },
    ...(warnings.length > 0 ? { migrationWarnings: [...warnings] } : {}),
  }
  writeJsonAtomic(skillLocalStatePath(profileDir), document)
}
