/** Migration of the legacy project and task registries into the profile layout. */

import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { bumpCount, recordSkip, type HuaanworkMigrationReport } from './report.ts'
import { buildSessionIdRewritePlan, rewriteSessionId } from './session-id.ts'
import type { HuaanworkMigrationStep } from './index.ts'
import type { HuaanworkLegacySource, HuaanworkMigrationTarget } from './paths.ts'
import { neutralWorkspaceRoot } from '../huaanwork-host/workspace-state.ts'

const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700

interface RegistryFile {
  readonly filename: string
  /** The single top-level array key the registry document defines. */
  readonly key: string
  /** Human label used in the dropped-entries skip, e.g. 'project records'. */
  readonly label: string
  readonly isValid: (entry: unknown) => entry is Record<string, unknown>
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** The array a registry document carries, or null when the shape is unrecognized. */
function registryEntries(raw: unknown, key: string): unknown[] | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const entries = (raw as Record<string, unknown>)[key]
  return Array.isArray(entries) ? entries : null
}

/**
 * Required-key validation only: unknown extra keys survive the copy.
 *
 * The legacy `isAutomationInfo` precedent is deliberately loose, and a
 * read-modify-write migration must not drop user data it merely does not know.
 */
function isProjectRecord(entry: unknown): entry is Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
  const candidate = entry as Record<string, unknown>
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.root === 'string'
    && typeof candidate.createdAt === 'number'
    && (candidate.lastOpenedAt === undefined || typeof candidate.lastOpenedAt === 'number')
}

function isTaskRecord(entry: unknown): entry is Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
  const candidate = entry as Record<string, unknown>
  return typeof candidate.id === 'string'
    && typeof candidate.projectId === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.createdAt === 'number'
    && (candidate.sessionId === undefined || typeof candidate.sessionId === 'string')
}

/**
 * Read one legacy registry and validate its entries.
 *
 * Returns null when the destination already exists (idempotent re-run), when
 * the legacy file is absent (silent no-op) or when it cannot be trusted; in the
 * latter two cases it records the reason instead of writing anything.
 */
async function loadRegistryEntries(
  source: HuaanworkLegacySource,
  target: HuaanworkMigrationTarget,
  report: HuaanworkMigrationReport,
  file: RegistryFile,
): Promise<Record<string, unknown>[] | null> {
  const destination = join(target.profileDir, file.filename)
  if (await exists(destination)) {
    recordSkip(report, `${file.filename}: destination already exists`)
    return null
  }
  // F2: unlike settings/account, the registries live inside $DSH_HOME.
  const legacyPath = join(source.dshHome, file.filename)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(legacyPath, 'utf8')) as unknown
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT') return null
    recordSkip(report, `${file.filename}: unparseable, left in place`)
    return null
  }
  const entries = registryEntries(raw, file.key)
  if (entries === null) {
    recordSkip(report, `${file.filename}: unrecognized registry`)
    return null
  }
  const valid = entries.filter(file.isValid)
  const dropped = entries.length - valid.length
  if (dropped > 0) {
    recordSkip(report, `${file.filename}: dropped ${dropped} entries that are not ${file.label}`)
  }
  return valid
}

function registryDocument(file: RegistryFile, entries: readonly Record<string, unknown>[]): string {
  return `${JSON.stringify({ [file.key]: entries }, null, 2)}\n`
}

const PROJECTS_FILE: RegistryFile = {
  filename: 'projects.json',
  key: 'projects',
  label: 'project records',
  isValid: isProjectRecord,
}

const TASKS_FILE: RegistryFile = {
  filename: 'tasks.json',
  key: 'tasks',
  label: 'task records',
  isValid: isTaskRecord,
}

/**
 * `projects.json` needs no rewrite: project roots are absolute paths that do not
 * move, so their derived session ids (and the `projectKey` directory names) are
 * already stable across the migration.
 */
export const migrateProjectsStep: HuaanworkMigrationStep = {
  name: 'projects',
  async run(source, target, report): Promise<void> {
    const projects = await loadRegistryEntries(source, target, report, PROJECTS_FILE)
    if (projects === null) return
    await writeFileAtomic(join(target.profileDir, PROJECTS_FILE.filename), registryDocument(PROJECTS_FILE, projects), {
      mode: FILE_MODE,
      dirMode: DIRECTORY_MODE,
    })
    bumpCount(report, 'projects', projects.length)
  },
}

export const migrateTasksStep: HuaanworkMigrationStep = {
  name: 'tasks',
  async run(source, target, report): Promise<void> {
    const tasks = await loadRegistryEntries(source, target, report, TASKS_FILE)
    if (tasks === null) return
    // Built once and reused for every task: only the neutral root's digest moves.
    const plan = buildSessionIdRewritePlan(
      join(source.dshHome, 'workspace'),
      neutralWorkspaceRoot(target.profileDir),
    )
    let rebound = 0
    const kept = tasks.map((task) => {
      const sessionId = task.sessionId
      if (typeof sessionId !== 'string') return task
      const rewritten = rewriteSessionId(sessionId, plan)
      if (rewritten === sessionId) return task
      rebound += 1
      return { ...task, sessionId: rewritten }
    })
    await writeFileAtomic(join(target.profileDir, TASKS_FILE.filename), registryDocument(TASKS_FILE, kept), {
      mode: FILE_MODE,
      dirMode: DIRECTORY_MODE,
    })
    bumpCount(report, 'tasks', kept.length)
    bumpCount(report, 'tasksRebound', rebound)
  },
}
