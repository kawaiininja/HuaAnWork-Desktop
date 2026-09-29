/** Migration of the legacy app settings document into the profile layout. */

import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { bumpCount, recordSkip, type HuaanworkMigrationReport } from './report.ts'
import type { HuaanworkMigrationStep } from './index.ts'
import type { HuaanworkLegacySource, HuaanworkMigrationTarget } from './paths.ts'

const SETTINGS_FILENAME = 'huaanwork-settings.json'
const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700

/** The thirteen keys the legacy AppSettings document defined (sidecar settings.ts:7-38). */
const CARRIED_KEYS = [
  'base_url', 'model', 'api_key', 'theme', 'models', 'active_model_id', 'allow_network',
  'guard_mode', 'automation_timeout_ms', 'keep_awake', 'agents_host', 'agents_port',
  'agents_catalog_token',
] as const

/**
 * Convert one legacy settings document.
 *
 * `work_allow_network` is read once as a fallback and never written back - the
 * same one-shot rule the legacy parser applied (sidecar settings.ts:170-172).
 * Unknown keys are dropped rather than smuggled into the new document.
 */
export function convertLegacySettings(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const record = raw as Record<string, unknown>
  const converted: Record<string, unknown> = {}
  for (const key of CARRIED_KEYS) {
    if (record[key] !== undefined) converted[key] = record[key]
  }
  if (typeof record.allow_network !== 'boolean') {
    converted.allow_network = record.work_allow_network === true
  }
  return converted
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export const migrateSettingsStep: HuaanworkMigrationStep = {
  name: 'settings',
  async run(
    source: HuaanworkLegacySource,
    target: HuaanworkMigrationTarget,
    report: HuaanworkMigrationReport,
  ): Promise<void> {
    const destination = join(target.profileDir, SETTINGS_FILENAME)
    if (await exists(destination)) {
      recordSkip(report, 'settings.json: destination already exists')
      return
    }
    // F2: the legacy settings document lives in dirname($DSH_HOME), not inside it.
    const legacyPath = join(source.configDir, 'settings.json')
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(legacyPath, 'utf8')) as unknown
    } catch (cause) {
      if ((cause as { code?: string }).code === 'ENOENT') return
      recordSkip(report, 'settings.json: unparseable, left in place')
      return
    }
    await writeFileAtomic(destination, `${JSON.stringify(convertLegacySettings(raw), null, 2)}\n`, {
      mode: FILE_MODE,
      dirMode: DIRECTORY_MODE,
    })
    bumpCount(report, 'settings')
  },
}
