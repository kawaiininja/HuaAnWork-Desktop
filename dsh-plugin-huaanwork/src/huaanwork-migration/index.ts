/**
 * One-time migration of legacy Tauri HuaAnWork data into the Desktop profile layout.
 *
 * Failure policy (spec §8): never delete the legacy tree, rethrow so main.ts routes
 * the startup failure into the recovery window. The marker is written last, so a
 * crash mid-run simply re-runs; every step skips a destination that already exists.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMigrationReport, bumpCount, recordSkip, type HuaanworkMigrationReport } from './report.ts'
import { readMigrationMarker, writeMigrationMarker, MIGRATION_MARKER_VERSION, type HuaanworkMigrationMarker } from './marker.ts'
import { legacySourceExists, readLegacyJson, resolveLegacySource, type HuaanworkLegacySource, type HuaanworkMigrationTarget } from './paths.ts'
import { migrateSettingsStep, convertLegacySettings } from './settings.ts'
import { migrateAuthStep, isLegacyAccount } from './auth.ts'
import { migrateProjectsStep, migrateTasksStep } from './registries.ts'
import { migrateAutomationsStep, migrateAutomationRunsStep, stripLegacyChannel } from './runs.ts'
import { migrateSessionsStep, rewriteSessionHeader } from './sessions.ts'
import {
  migrateAgentsConfigStep,
  migrateSkillTogglesStep,
  migrateUserSkillsStep,
  migrateNeutralWorkspaceStep,
} from './extras.ts'

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

/** 旧 profile 清单:唯一记录「旧版装过哪些插件」的处所(plan D-M6-6)。 */
const LEGACY_PROFILE_MANIFEST = join('profiles', 'huaanwork', 'package.json')

/**
 * `dsh.profile.bundles` of a legacy profile manifest, or [] when the manifest is
 * missing / unparseable / an older shape.
 *
 * The legacy profile could be hand-edited, so every shape mismatch is a silent
 * empty result: a name list this migration cannot trust must not be invented.
 * Only non-empty string names survive, and duplicates collapse into one entry —
 * the list is user-facing copy in {@link describeMigrationForUser}, not raw data.
 */
export function parseLegacyPluginBundles(manifest: string | null): string[] {
  if (manifest === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(manifest) as unknown
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
  const dsh = (parsed as Record<string, unknown>).dsh
  if (typeof dsh !== 'object' || dsh === null || Array.isArray(dsh)) return []
  const profile = (dsh as Record<string, unknown>).profile
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return []
  const bundles = (profile as Record<string, unknown>).bundles
  if (!Array.isArray(bundles)) return []
  return [...new Set(bundles.filter((name): name is string => typeof name === 'string' && name.length > 0))]
}

/** Read the legacy profile manifest beside the old $DSH_HOME; absence is normal. */
async function readLegacyPluginBundles(dshHome: string): Promise<string[]> {
  try {
    return parseLegacyPluginBundles(await readFile(join(dshHome, LEGACY_PROFILE_MANIFEST), 'utf8'))
  } catch {
    return []
  }
}

export async function runHuaanworkLegacyMigration(
  input: RunHuaanworkLegacyMigrationInput,
): Promise<HuaanworkMigrationReport> {
  const report = createMigrationReport()
  report.notMigrated.push(...NOT_MIGRATED)
  // D-M6-6: the legacy profile's installed bundles cannot come along (plugin
  // provenance belongs to the new market now), so name them for the user.
  for (const name of await readLegacyPluginBundles(input.source.dshHome)) {
    if (!report.notMigrated.includes(name)) report.notMigrated.push(name)
  }

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

/** Every migration step, in dependency order. Do not reorder: see the plan's Task 2.9 ordering rationale. */
export const HUAANWORK_MIGRATION_STEPS: readonly HuaanworkMigrationStep[] = Object.freeze([
  migrateSettingsStep,
  migrateAuthStep,
  migrateSessionsStep,
  migrateProjectsStep,
  migrateTasksStep,
  migrateAutomationsStep,
  migrateAutomationRunsStep,
  migrateAgentsConfigStep,
  migrateSkillTogglesStep,
  migrateUserSkillsStep,
  migrateNeutralWorkspaceStep,
])

/**
 * One honest sentence per migrated class, plus what was deliberately left behind.
 *
 * The not-migrated list is stated rather than omitted: a user who had plugins
 * installed under the legacy profile needs to know they must reinstall them
 * from the market, and guessing that from a missing feature is worse than being
 * told (spec §14 第 33 条的诚实文案先例)。
 */
export function describeMigrationForUser(marker: HuaanworkMigrationMarker): string {
  const done = Object.entries(marker.counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key} ${String(count)}`)
  const parts = [
    done.length === 0
      ? '未找到可迁移的旧版数据。'
      : `已从旧版华安工作台迁移:${done.join('、')}。`,
  ]
  if (marker.skipped.length > 0) parts.push(`跳过 ${String(marker.skipped.length)} 项(已存在或不可解析)。`)
  parts.push('需要重新登录一次。旧数据目录未删除,可在确认无误后自行清理。')
  if (marker.notMigrated.length > 0) {
    parts.push(`未迁移:${marker.notMigrated.join('、')}。旧版安装的插件需在插件市场重新安装。`)
  }
  return parts.join(' ')
}

export { bumpCount, recordSkip, resolveLegacySource, legacySourceExists, readLegacyJson }
export { migrateSettingsStep, convertLegacySettings }
export { migrateAuthStep, isLegacyAccount }
export { migrateProjectsStep, migrateTasksStep }
export { migrateAutomationsStep, migrateAutomationRunsStep, stripLegacyChannel }
export { migrateSessionsStep, rewriteSessionHeader }
export {
  migrateAgentsConfigStep,
  migrateSkillTogglesStep,
  migrateUserSkillsStep,
  migrateNeutralWorkspaceStep,
}
export type { HuaanworkLegacySource, HuaanworkMigrationTarget, HuaanworkMigrationReport }
