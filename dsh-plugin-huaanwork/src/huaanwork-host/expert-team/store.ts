import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { assertSafePathSegment } from '../workspace-state.ts'
import type {
  ExpertTeam,
  ExpertTeamRecord,
  ExpertTeamStore,
  ExpertTeamValidationErrors,
} from './types.ts'
import { validateExpertTeam } from './types.ts'

/**
 * 按 profile 隔离的专家团定义存储（spec §8.5）。
 *
 * 每个定义是 `<profileDir>/expert-teams/<id>.json` 的完整 `ExpertTeam`，写入走
 * 同目录 `.tmp-<uuid>` 完整写入 + `renameSync` 替换，读路径不恢复临时文件。单个
 * 文件损坏只让该团队 fail-closed（`{ id, error: 'expert-team-corrupt' }`），既不影响
 * 其他团队加载，也绝不自动覆盖原文件；显式 `remove` 才会删除它。
 */

const EXPERT_TEAMS_DIRNAME = 'expert-teams'
const TEAM_FILE_SUFFIX = '.json'

/** 存储层错误码；路由层据此映射 RPC 结果，`fieldErrors` 仅在定义校验失败时存在。 */
export type ExpertTeamStoreErrorCode =
  | 'expert-team-invalid'
  | 'expert-team-slug-exists'
  | 'expert-team-not-found'
  | 'expert-team-corrupt'

export class ExpertTeamStoreError extends Error {
  readonly code: ExpertTeamStoreErrorCode
  readonly fieldErrors?: ExpertTeamValidationErrors

  constructor(code: ExpertTeamStoreErrorCode, detail?: string, fieldErrors?: ExpertTeamValidationErrors) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = 'ExpertTeamStoreError'
    this.code = code
    if (fieldErrors !== undefined) this.fieldErrors = fieldErrors
  }
}

export type CreateExpertTeamStoreOptions = {
  /** ISO 时间源；测试注入固定时钟，生产默认系统时钟。 */
  now?: () => string
}

/** 规格允许通过 update 修改的字段；slug 创建后锁定，enabled 由 setEnabled 单独维护。 */
const EDITABLE_TEAM_FIELDS = [
  'name',
  'description',
  'scenarios',
  'members',
  'orchestration',
  'review',
  'summary',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expertTeamsRoot(profileDir: string): string {
  return join(profileDir, EXPERT_TEAMS_DIRNAME)
}

/** 所有按 id 的读写入口都先过安全路径段校验，拒绝 `../` 等穿越。 */
function resolveTeamFile(profileDir: string, id: string): { id: string; file: string } {
  const safeId = assertSafePathSegment(id, 'teamId')
  return { id: safeId, file: join(expertTeamsRoot(profileDir), `${safeId}${TEAM_FILE_SUFFIX}`) }
}

/**
 * 读取单个定义文件。JSON 损坏、字段非法或文件 id 与内容 id 不一致一律映射为
 * `expert-team-corrupt`，并保留文件 id；绝不修改文件。
 */
function readTeamRecord(file: string, id: string): ExpertTeamRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { id, error: 'expert-team-corrupt' }
  }
  const validated = validateExpertTeam(parsed)
  if (!validated.ok || validated.team.id !== id) return { id, error: 'expert-team-corrupt' }
  return { id, team: validated.team }
}

/** 同步枚举当前 profile 的全部定义；缺失目录等价于空列表。 */
function listTeamRecords(profileDir: string): ExpertTeamRecord[] {
  const root = expertTeamsRoot(profileDir)
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const records: ExpertTeamRecord[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) continue
    if (entry.name.startsWith('.tmp-') || entry.name.startsWith('.old-')) continue
    if (!entry.name.endsWith(TEAM_FILE_SUFFIX)) continue
    const id = entry.name.slice(0, -TEAM_FILE_SUFFIX.length)
    if (!id) continue
    records.push(readTeamRecord(join(root, entry.name), id))
  }
  return records
}

function validateOrThrow(candidate: Record<string, unknown>): ExpertTeam {
  const validated = validateExpertTeam(candidate)
  if (!validated.ok) {
    throw new ExpertTeamStoreError('expert-team-invalid', undefined, validated.errors)
  }
  return validated.team
}

function readExistingTeam(profileDir: string, id: string): { team: ExpertTeam; file: string } {
  const { id: safeId, file } = resolveTeamFile(profileDir, id)
  if (!existsSync(file)) throw new ExpertTeamStoreError('expert-team-not-found', safeId)
  const record = readTeamRecord(file, safeId)
  if (record.team === undefined) throw new ExpertTeamStoreError('expert-team-corrupt', safeId)
  return { team: record.team, file }
}

/** 同目录完整写入后 rename 替换；失败时清掉本次临时文件，不留下半成品。 */
function writeTeamFile(file: string, team: ExpertTeam): void {
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true })
  const tmp = join(directory, `.tmp-${randomUUID()}`)
  try {
    writeFileSync(tmp, `${JSON.stringify(team, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function pickEditableFields(patch: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const field of EDITABLE_TEAM_FIELDS) {
    const value = patch[field]
    if (value !== undefined) picked[field] = value
  }
  return picked
}

export function createExpertTeamStore(
  profileDir: string,
  options: CreateExpertTeamStoreOptions = {},
): ExpertTeamStore {
  const now = options.now ?? (() => new Date().toISOString())

  return {
    async list(): Promise<ExpertTeamRecord[]> {
      return listTeamRecords(profileDir)
    },

    async get(id: string): Promise<ExpertTeamRecord> {
      const { id: safeId, file } = resolveTeamFile(profileDir, id)
      if (!existsSync(file)) throw new ExpertTeamStoreError('expert-team-not-found', safeId)
      return readTeamRecord(file, safeId)
    },

    async create(input: unknown): Promise<ExpertTeam> {
      // envelope 由存储层决定：调用方提供的 id/时间戳一律不成为存储身份。
      const timestamp = now()
      const team = validateOrThrow({
        ...(isRecord(input) ? input : {}),
        id: randomUUID(),
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      const slugTaken = listTeamRecords(profileDir).some((record) => record.team?.slug === team.slug)
      if (slugTaken) throw new ExpertTeamStoreError('expert-team-slug-exists', team.slug)
      const { file } = resolveTeamFile(profileDir, team.id)
      writeTeamFile(file, team)
      return team
    },

    async update(id: string, patch: unknown): Promise<ExpertTeam> {
      const existing = readExistingTeam(profileDir, id)
      const editable = isRecord(patch) ? pickEditableFields(patch) : {}
      const team = validateOrThrow({
        ...existing.team,
        ...editable,
        id: existing.team.id,
        slug: existing.team.slug,
        createdAt: existing.team.createdAt,
        updatedAt: now(),
      })
      writeTeamFile(existing.file, team)
      return team
    },

    async setEnabled(id: string, enabled: boolean): Promise<ExpertTeam> {
      const existing = readExistingTeam(profileDir, id)
      const team = validateOrThrow({ ...existing.team, enabled, updatedAt: now() })
      writeTeamFile(existing.file, team)
      return team
    },

    async remove(id: string): Promise<void> {
      const { id: safeId, file } = resolveTeamFile(profileDir, id)
      try {
        unlinkSync(file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new ExpertTeamStoreError('expert-team-not-found', safeId)
        }
        throw error
      }
    },
  }
}
