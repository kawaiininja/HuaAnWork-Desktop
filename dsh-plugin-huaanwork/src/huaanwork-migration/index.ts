/**
 * One-time migration of legacy Tauri HuaAnWork data into the Desktop profile layout.
 *
 * Failure policy (spec §8): never delete the legacy tree, rethrow so main.ts routes
 * the startup failure into the recovery window. The marker is written last, so a
 * crash mid-run simply re-runs; every step skips a destination that already exists.
 */

import { createMigrationReport, bumpCount, recordSkip, type HuaanworkMigrationReport } from './report.ts'
import { readMigrationMarker, writeMigrationMarker, MIGRATION_MARKER_VERSION, type HuaanworkMigrationMarker } from './marker.ts'
import { legacySourceExists, readLegacyJson, resolveLegacySource, type HuaanworkLegacySource, type HuaanworkMigrationTarget } from './paths.ts'

/** One class of legacy data, migrated independently and idempotently. */
export interface HuaanworkMigrationStep {
  readonly name: string
  run(source: HuaanworkLegacySource, target: HuaanworkMigrationTarget, report: HuaanworkMigrationReport): Promise<void>
}

export interface RunHuaanworkLegacyMigrationInput {
  readonly source: HuaanworkLegacySource
  readonly target: HuaanworkMigrationTarget
  readonly steps: readonly HuaanworkMigrationStep[]
}

/**
 * Data the new build deliberately does not carry over.
 *
 * Recorded verbatim in the marker and surfaced to the user on first launch, so
 * "we did not migrate this" is a statement rather than a silent omission.
 */
export const NOT_MIGRATED: readonly string[] = Object.freeze([
  'cordis.yml',
  'cordis.patch.yml',
  'logs/plugin.log',
  'logs/sidecar.log',
  'auth-session.json',
  'profiles/huaanwork',
])

export async function runHuaanworkLegacyMigration(
  input: RunHuaanworkLegacyMigrationInput,
): Promise<HuaanworkMigrationReport> {
  const report = createMigrationReport()
  report.notMigrated.push(...NOT_MIGRATED)

  const existing = await readMigrationMarker(input.target.profileDir)
  if (existing !== null) {
    report.marker = existing
    return report
  }
  if (!(await legacySourceExists(input.source))) return report

  for (const step of input.steps) {
    await step.run(input.source, input.target, report)
  }

  const marker: HuaanworkMigrationMarker = {
    version: MIGRATION_MARKER_VERSION,
    migratedAt: new Date().toISOString(),
    source: { configDir: input.source.configDir, dshHome: input.source.dshHome },
    counts: { ...report.counts },
    skipped: [...report.skipped],
    notMigrated: [...report.notMigrated],
  }
  await writeMigrationMarker(input.target.profileDir, marker)
  report.performed = true
  report.marker = marker
  return report
}

export { bumpCount, recordSkip, resolveLegacySource, legacySourceExists, readLegacyJson }
export { migrateSettingsStep, convertLegacySettings } from './settings.ts'
export { migrateAuthStep, isLegacyAccount } from './auth.ts'
export { migrateProjectsStep, migrateTasksStep } from './registries.ts'
export { migrateAutomationsStep, migrateAutomationRunsStep, stripLegacyChannel } from './runs.ts'
export { migrateSessionsStep, rewriteSessionHeader } from './sessions.ts'
export type { HuaanworkLegacySource, HuaanworkMigrationTarget, HuaanworkMigrationReport }

