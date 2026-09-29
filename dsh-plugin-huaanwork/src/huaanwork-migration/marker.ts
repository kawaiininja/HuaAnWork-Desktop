/** One-time migration marker living in the profile directory. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export const MIGRATION_MARKER_FILENAME = 'huaanwork-migration.json'
export const MIGRATION_MARKER_VERSION = 1

const MARKER_DIRECTORY_MODE = 0o700
const MARKER_FILE_MODE = 0o600

export interface HuaanworkMigrationMarker {
  readonly version: number
  readonly migratedAt: string
  readonly source: { readonly configDir: string; readonly dshHome: string }
  readonly counts: Readonly<Record<string, number>>
  readonly skipped: readonly string[]
  readonly notMigrated: readonly string[]
}

function isMarker(value: unknown): value is HuaanworkMigrationMarker {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.version !== MIGRATION_MARKER_VERSION || typeof record.migratedAt !== 'string') return false
  if (typeof record.source !== 'object' || record.source === null) return false
  const source = record.source as Record<string, unknown>
  if (typeof source.configDir !== 'string' || typeof source.dshHome !== 'string') return false
  if (typeof record.counts !== 'object' || record.counts === null || Array.isArray(record.counts)) return false
  return Array.isArray(record.skipped) && Array.isArray(record.notMigrated)
}

/** Read the marker, treating an absent / corrupt / newer-version marker as "not migrated yet". */
export async function readMigrationMarker(profileDir: string): Promise<HuaanworkMigrationMarker | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(profileDir, MIGRATION_MARKER_FILENAME), 'utf8'))
    return isMarker(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Persist the marker last, so a crash mid-migration re-runs it (per-file skips make re-runs safe). */
export async function writeMigrationMarker(profileDir: string, marker: HuaanworkMigrationMarker): Promise<void> {
  await writeFileAtomic(join(profileDir, MIGRATION_MARKER_FILENAME), `${JSON.stringify(marker)}\n`, {
    mode: MARKER_FILE_MODE,
    dirMode: MARKER_DIRECTORY_MODE,
  })
}
