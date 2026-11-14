/**
 * Revisioned skill store (Task 4).
 *
 * Layout under the service data directory:
 *
 *   skills/state.json                        the entire skill state
 *   skills/archives/<name>/<revision>.tar.gz server-generated archive paths
 *
 * Durability follows the agent store sample (`store.ts`): state writes go
 * through one in-process queue, land as a same-directory temp file, fsync,
 * rename; archives are written and fsynced BEFORE the state that references
 * them, so a visible revision always has its bytes on disk. A corrupt state
 * file is an operator error: it is never repaired in place and `open` refuses.
 *
 * Concurrency: every mutation of one name runs through that name's queue, so
 * two publishes of the same skill cannot interleave their idempotency/owner/
 * revision checks. Different names may proceed concurrently.
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open as openFile, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { SKILL_NAME_RE } from '@huaanwork/skill-format/markdown'

import { DATA_DIRECTORY_MODE, STATE_FILE_MODE } from './store.ts'
import {
  emptySkillState,
  skillRevisionSummary,
  type SkillPublishInput,
  type SkillRevisionRecord,
  type SkillRevisionSummary,
  type SkillSeries,
  type SkillState,
} from './skill-types.ts'

const SKILLS_DIRECTORY = 'skills'
const ARCHIVES_DIRECTORY = 'archives'
const SKILL_STATE_FILE = 'state.json'
const SKILL_STATE_TEMP_PATTERN = /^state\.json\.tmp-\d+-[0-9a-f]+$/u

export type SkillStoreErrorCode =
  | 'invalid-skill'
  | 'invalid-cursor'
  | 'skill-already-exists'
  | 'skill-name-conflict'
  | 'skill-revision-conflict'

export class SkillStoreError extends Error {
  readonly code: SkillStoreErrorCode

  constructor(code: SkillStoreErrorCode, message: string) {
    super(message)
    this.name = 'SkillStoreError'
    this.code = code
  }
}

export class SkillStoreCorruptError extends Error {
  readonly path: string

  constructor(path: string, cause: Error) {
    super(
      `agent-catalog-server: skill state file ${path} is not valid SkillState: ${cause.message}. ` +
        'The file was left untouched; restore it from backup before restarting.',
    )
    this.name = 'SkillStoreCorruptError'
    this.path = path
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SkillStoreCorruptError(path, new Error(`${field} must be a non-empty string`))
  }
  return value
}

function requirePositiveInteger(value: unknown, field: string, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new SkillStoreCorruptError(path, new Error(`${field} must be a positive integer`))
  }
  return value
}

function parseSkillState(path: string, contents: string): SkillState {
  let document: unknown
  try {
    document = JSON.parse(contents)
  } catch (cause) {
    throw new SkillStoreCorruptError(path, cause as Error)
  }
  if (!isPlainObject(document)) {
    throw new SkillStoreCorruptError(path, new Error('the document must be a JSON object'))
  }
  if (document.schemaVersion !== 1) {
    throw new SkillStoreCorruptError(path, new Error('schemaVersion must be 1'))
  }
  if (!isPlainObject(document.skills)) {
    throw new SkillStoreCorruptError(path, new Error('skills must be an object'))
  }
  let lastMutation: SkillState['lastMutation']
  if (document.lastMutation !== undefined) {
    if (!isPlainObject(document.lastMutation)) {
      throw new SkillStoreCorruptError(path, new Error('lastMutation must be an object'))
    }
    lastMutation = {
      requestId: requireString(document.lastMutation.requestId, 'lastMutation.requestId', path),
      action: requireString(document.lastMutation.action, 'lastMutation.action', path),
      at: requireString(document.lastMutation.at, 'lastMutation.at', path),
    }
  }

  const skills: Record<string, SkillSeries> = {}
  for (const [name, rawSeries] of Object.entries(document.skills)) {
    if (!SKILL_NAME_RE.test(name)) {
      throw new SkillStoreCorruptError(path, new Error(`skills.${name}: invalid skill name`))
    }
    if (!isPlainObject(rawSeries)) {
      throw new SkillStoreCorruptError(path, new Error(`skills.${name} must be an object`))
    }
    if (rawSeries.name !== name) {
      throw new SkillStoreCorruptError(path, new Error(`skills.${name}.name must equal its key`))
    }
    const owner = requireString(rawSeries.owner, `skills.${name}.owner`, path)
    const latestRevision = requirePositiveInteger(rawSeries.latestRevision, `skills.${name}.latestRevision`, path)
    if (!isPlainObject(rawSeries.revisions)) {
      throw new SkillStoreCorruptError(path, new Error(`skills.${name}.revisions must be an object`))
    }
    const revisions: Record<string, SkillRevisionRecord> = {}
    for (const [key, rawRecord] of Object.entries(rawSeries.revisions)) {
      const field = `skills.${name}.revisions.${key}`
      if (!isPlainObject(rawRecord)) {
        throw new SkillStoreCorruptError(path, new Error(`${field} must be an object`))
      }
      const revision = requirePositiveInteger(rawRecord.revision, `${field}.revision`, path)
      if (String(revision) !== key) {
        throw new SkillStoreCorruptError(path, new Error(`${field}.revision must equal its key`))
      }
      if (rawRecord.name !== name) {
        throw new SkillStoreCorruptError(path, new Error(`${field}.name must equal the series name`))
      }
      if (rawRecord.whenToUse !== undefined && typeof rawRecord.whenToUse !== 'string') {
        throw new SkillStoreCorruptError(path, new Error(`${field}.whenToUse must be a string`))
      }
      if (typeof rawRecord.size !== 'number' || !Number.isFinite(rawRecord.size) || rawRecord.size < 0) {
        throw new SkillStoreCorruptError(path, new Error(`${field}.size must be a non-negative number`))
      }
      revisions[key] = {
        name,
        revision,
        description: requireString(rawRecord.description, `${field}.description`, path),
        ...(rawRecord.whenToUse !== undefined ? { whenToUse: rawRecord.whenToUse } : {}),
        publisher: requireString(rawRecord.publisher, `${field}.publisher`, path),
        digest: requireString(rawRecord.digest, `${field}.digest`, path),
        archivePath: requireString(rawRecord.archivePath, `${field}.archivePath`, path),
        size: rawRecord.size,
        createdAt: requireString(rawRecord.createdAt, `${field}.createdAt`, path),
      }
    }
    if (revisions[String(latestRevision)] === undefined) {
      throw new SkillStoreCorruptError(path, new Error(`skills.${name}.latestRevision has no record`))
    }
    skills[name] = { name, owner, latestRevision, revisions }
  }

  return { schemaVersion: 1, ...(lastMutation !== undefined ? { lastMutation } : {}), skills }
}

/** The latest revision record of a series. Missing means corrupt state. */
function latestOf(series: SkillSeries): SkillRevisionRecord {
  const record = series.revisions[String(series.latestRevision)]
  if (record === undefined) {
    throw new Error(`skill state: series ${series.name} is missing revision ${String(series.latestRevision)}`)
  }
  return record
}

function encodeCursor(name: string): string {
  return Buffer.from(JSON.stringify({ name }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): string {
  let document: unknown
  try {
    document = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new SkillStoreError('invalid-cursor', 'cursor is not valid base64url JSON')
  }
  if (!isPlainObject(document) || typeof document.name !== 'string' || !SKILL_NAME_RE.test(document.name)) {
    throw new SkillStoreError('invalid-cursor', 'cursor must carry a valid skill name')
  }
  return document.name
}

export class SkillStore {
  private readonly skillsDir: string
  private state: SkillState
  private writeTail: Promise<void> = Promise.resolve()
  private readonly nameLocks = new Map<string, Promise<void>>()

  private constructor(dataDir: string, state: SkillState) {
    this.skillsDir = join(dataDir, SKILLS_DIRECTORY)
    this.state = state
  }

  /**
   * Open (or initialize) the store. Callers pass the service data directory;
   * the store appends `skills/` itself. A corrupt state document is refused,
   * never reset to an empty catalog.
   */
  static async open(dataDir: string): Promise<SkillStore> {
    const skillsDir = join(dataDir, SKILLS_DIRECTORY)
    await mkdir(skillsDir, { recursive: true, mode: DATA_DIRECTORY_MODE })
    await chmod(skillsDir, DATA_DIRECTORY_MODE).catch(() => undefined)

    for (const file of await readdir(skillsDir)) {
      if (SKILL_STATE_TEMP_PATTERN.test(file)) {
        await unlink(join(skillsDir, file)).catch(() => undefined)
      }
    }

    const statePath = join(skillsDir, SKILL_STATE_FILE)
    let contents: string
    try {
      contents = await readFile(statePath, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        return new SkillStore(dataDir, emptySkillState())
      }
      throw cause
    }
    return new SkillStore(dataDir, parseSkillState(statePath, contents))
  }

  /** A deep copy of the committed state; callers may mutate it freely. */
  read(): SkillState {
    return structuredClone(this.state)
  }

  /** Every name's latest revision, name-sorted, one cursor page at a time. */
  listAfter(cursor: string | undefined, limit: number): { items: SkillRevisionSummary[]; nextCursor?: string } {
    const after = cursor === undefined ? undefined : decodeCursor(cursor)
    const names = Object.keys(this.state.skills)
      .filter(name => after === undefined || name > after)
      .sort()
    const page = names.slice(0, limit)
    const items = page.map((name) => skillRevisionSummary(latestOf(this.state.skills[name]!)))
    const last = page[page.length - 1]
    const nextCursor = names.length > page.length && last !== undefined ? encodeCursor(last) : undefined
    return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) }
  }

  /** One exact revision, or undefined. */
  get(name: string, revision: number): SkillRevisionRecord | undefined {
    if (!SKILL_NAME_RE.test(name) || !Number.isInteger(revision) || revision < 1) return undefined
    const record = this.state.skills[name]?.revisions[String(revision)]
    return record === undefined ? undefined : structuredClone(record)
  }

  /**
   * Publish one revision. Check order (inside the name lock):
   * same-publisher + same-digest idempotency on the latest revision, then
   * owner, then expected revision. The archive is written before the state
   * commit; the state commit is queued like every other mutation.
   */
  async publish(input: SkillPublishInput): Promise<{ skill: SkillRevisionSummary; created: boolean }> {
    if (!SKILL_NAME_RE.test(input.name)) {
      throw new SkillStoreError('invalid-skill', `skill name ${JSON.stringify(input.name)} is not kebab-case`)
    }
    return this.withNameLock(input.name, async () => {
      const series = this.state.skills[input.name]
      if (series !== undefined) {
        const latest = latestOf(series)
        if (latest.publisher === input.publisher && latest.digest === input.digest) {
          return { skill: skillRevisionSummary(latest), created: false }
        }
        if (series.owner !== input.publisher) {
          throw new SkillStoreError(
            'skill-name-conflict',
            `skill ${input.name} is owned by another publisher`,
          )
        }
        if (input.expectedRevision !== latest.revision) {
          throw new SkillStoreError(
            'skill-revision-conflict',
            `skill ${input.name} expected revision ${String(input.expectedRevision)}, latest is ${String(latest.revision)}`,
          )
        }
      } else if (input.expectedRevision !== undefined) {
        throw new SkillStoreError(
          'skill-revision-conflict',
          `skill ${input.name} does not exist; a first publish carries no expected revision`,
        )
      }

      const revision = series === undefined ? 1 : series.latestRevision + 1
      const archivePath = join(this.skillsDir, ARCHIVES_DIRECTORY, input.name, `${String(revision)}.tar.gz`)
      await this.writeArchive(archivePath, input.archive)
      const record: SkillRevisionRecord = {
        name: input.name,
        revision,
        description: input.description,
        ...(input.whenToUse !== undefined && input.whenToUse !== '' ? { whenToUse: input.whenToUse } : {}),
        publisher: input.publisher,
        digest: input.digest,
        archivePath,
        size: input.archive.byteLength,
        createdAt: input.createdAt,
      }
      await this.update((draft) => {
        draft.lastMutation = { requestId: input.requestId, action: 'skill.publish', at: new Date().toISOString() }
        const current = draft.skills[input.name]
        if (current === undefined) {
          draft.skills[input.name] = {
            name: input.name,
            owner: input.publisher,
            latestRevision: revision,
            revisions: { [String(revision)]: record },
          }
        } else {
          current.latestRevision = revision
          current.revisions[String(revision)] = record
        }
      })
      return { skill: skillRevisionSummary(record), created: true }
    })
  }

  /** Serialize a critical section for one skill name. */
  private withNameLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.nameLocks.get(name) ?? Promise.resolve()
    const run = previous.then(
      () => fn(),
      () => fn(),
    )
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.nameLocks.set(name, tail)
    void tail.finally(() => {
      if (this.nameLocks.get(name) === tail) this.nameLocks.delete(name)
    })
    return run
  }

  private update<T>(mutator: (draft: SkillState) => T | Promise<T>): Promise<T> {
    const run = this.writeTail.then(async () => {
      const draft = structuredClone(this.state)
      const result = await mutator(draft)
      await this.writeState(draft)
      this.state = draft
      return result
    })
    this.writeTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async writeArchive(archivePath: string, data: Buffer): Promise<void> {
    await mkdir(dirname(archivePath), { recursive: true, mode: DATA_DIRECTORY_MODE })
    const tempPath = `${archivePath}.tmp-${String(process.pid)}-${randomBytes(8).toString('hex')}`
    const handle = await openFile(tempPath, 'w', STATE_FILE_MODE)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } catch (cause) {
      await handle.close().catch(() => undefined)
      await unlink(tempPath).catch(() => undefined)
      throw cause
    }
    await handle.close()
    await rename(tempPath, archivePath)
  }

  private async writeState(state: SkillState): Promise<void> {
    const statePath = join(this.skillsDir, SKILL_STATE_FILE)
    const tempPath = join(
      this.skillsDir,
      `${SKILL_STATE_FILE}.tmp-${String(process.pid)}-${randomBytes(8).toString('hex')}`,
    )
    const payload = `${JSON.stringify(state, null, 2)}\n`
    const handle = await openFile(tempPath, 'w', STATE_FILE_MODE)
    try {
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tempPath, statePath)
    const directory = await openFile(this.skillsDir, 'r').catch(() => null)
    if (directory !== null) {
      try {
        await directory.sync()
      } catch {
        // Ignore: the file itself is already fsynced and renamed.
      } finally {
        await directory.close()
      }
    }
  }
}
