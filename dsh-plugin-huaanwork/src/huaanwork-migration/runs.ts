/** Migration of the legacy automation registry, run logs and audit trails into the profile layout. */

import { access, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { bumpCount, recordSkip, type HuaanworkMigrationReport } from './report.ts'
import { buildSessionIdRewritePlan, rewriteSessionId, type SessionIdRewritePlan } from './session-id.ts'
import type { HuaanworkMigrationStep } from './index.ts'
import type { HuaanworkLegacySource, HuaanworkMigrationTarget } from './paths.ts'
import { neutralWorkspaceRoot } from '../huaanwork-host/workspace-state.ts'

const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700
const AUTOMATIONS_FILENAME = 'automations.json'
const AUTOMATIONS_DIR = 'automations'
const RUNS_SUFFIX = '.runs.jsonl'
const AUDIT_SUFFIX = '.audit.jsonl'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Required-key validation only, mirroring the legacy `isAutomationInfo`
 * (huaanwork-host/stores.ts:279-291) — deliberately loose: unknown extra keys
 * survive the copy. `projectId` is string | null (issue #2), `schedule` is only
 * checked to be a non-null object, and `kind` is the two-value union.
 */
function isAutomationRecord(entry: unknown): entry is Record<string, unknown> {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false
  const candidate = entry as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    (typeof candidate.projectId === 'string' || candidate.projectId === null) &&
    typeof candidate.name === 'string' &&
    (candidate.kind === 'agent' || candidate.kind === 'script') &&
    candidate.schedule !== null &&
    typeof candidate.schedule === 'object' &&
    typeof candidate.createdAt === 'number'
  )
}

/**
 * Strip the pre-unify `channel` field (D-M6-8, spec §14 第 28 条).
 *
 * The legacy reader ignored it (旧 automations.ts:122) and
 * `normalizeAutomationInput` (旧 automations.ts:95-131) never produced it, so one
 * `updateAutomation` read-modify-write would silently drop it anyway. Removing it
 * here keeps the migrated document shaped exactly like the one the new side
 * writes. Returns a copy; the caller's record is never mutated.
 */
export function stripLegacyChannel(automation: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(automation)) {
    if (key === 'channel') continue
    stripped[key] = value
  }
  return stripped
}

export const migrateAutomationsStep: HuaanworkMigrationStep = {
  name: 'automations',
  async run(source: HuaanworkLegacySource, target: HuaanworkMigrationTarget, report: HuaanworkMigrationReport): Promise<void> {
    const destination = join(target.profileDir, AUTOMATIONS_FILENAME)
    if (await exists(destination)) {
      recordSkip(report, `${AUTOMATIONS_FILENAME}: destination already exists`)
      return
    }
    // F2: like the registries, the automation registry lives inside $DSH_HOME.
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(join(source.dshHome, AUTOMATIONS_FILENAME), 'utf8')) as unknown
    } catch (cause) {
      if ((cause as { code?: string }).code === 'ENOENT') return
      recordSkip(report, `${AUTOMATIONS_FILENAME}: unparseable, left in place`)
      return
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      recordSkip(report, `${AUTOMATIONS_FILENAME}: unrecognized registry`)
      return
    }
    const entries = (raw as Record<string, unknown>).automations
    if (!Array.isArray(entries)) {
      recordSkip(report, `${AUTOMATIONS_FILENAME}: unrecognized registry`)
      return
    }
    const valid = entries.filter(isAutomationRecord)
    const dropped = entries.length - valid.length
    if (dropped > 0) {
      recordSkip(report, `${AUTOMATIONS_FILENAME}: dropped ${dropped} entries that are not automation records`)
    }
    let stripped = 0
    const kept = valid.map((entry) => {
      if (!('channel' in entry)) return entry
      stripped += 1
      return stripLegacyChannel(entry)
    })
    await writeFileAtomic(destination, `${JSON.stringify({ automations: kept }, null, 2)}\n`, {
      mode: FILE_MODE,
      dirMode: DIRECTORY_MODE,
    })
    bumpCount(report, 'automations', kept.length)
    bumpCount(report, 'automationsChannelStripped', stripped)
  },
}

/**
 * Required-field check the legacy `recentRuns` applied before listing a run
 * (rpc-types.ts RunSummary): a line missing any of the five fields is not a run
 * summary. Optional fields are carried through untouched.
 */
function isRunSummaryRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.runId === 'string' &&
    typeof candidate.startedAt === 'number' &&
    typeof candidate.endedAt === 'number' &&
    typeof candidate.ok === 'boolean' &&
    typeof candidate.output === 'string'
  )
}

interface RunCopy {
  /** Destination lines, in source order; unparseable lines keep their exact text. */
  readonly lines: string[]
  /** Valid run summaries written. */
  readonly written: number
  /** Records whose sessionId pointed at the moved neutral root. */
  readonly rebound: number
  /** Run lines discarded by the required-field check. */
  readonly dropped: number
}

interface AuditCopy {
  /** Destination lines, in source order; unparseable lines keep their exact text. */
  readonly lines: string[]
  /** Every line copied, bad ones included (audit lines carry no validator). */
  readonly copied: number
}

/**
 * Copy one run log line by line, rewriting `sessionId` back-references.
 *
 * A line that does not parse is kept verbatim: the legacy
 * `filterLegacyChatAutoRuns` precedent is that one bad line must not cost the
 * whole file. A line that parses but fails the required-field check is dropped
 * and counted, exactly like the legacy `recentRuns` reader.
 */
function copyRunLines(text: string, plan: SessionIdRewritePlan): RunCopy {
  const lines: string[] = []
  let written = 0
  let rebound = 0
  let dropped = 0
  for (const line of text.split('\n')) {
    if (line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      lines.push(line)
      continue
    }
    if (!isRunSummaryRecord(parsed)) {
      dropped += 1
      continue
    }
    written += 1
    const sessionId = parsed.sessionId
    if (typeof sessionId !== 'string') {
      lines.push(JSON.stringify(parsed))
      continue
    }
    const rewritten = rewriteSessionId(sessionId, plan)
    if (rewritten === sessionId) {
      lines.push(JSON.stringify(parsed))
      continue
    }
    rebound += 1
    lines.push(JSON.stringify({ ...parsed, sessionId: rewritten }))
  }
  return { lines, written, rebound, dropped }
}

/**
 * Copy one audit trail line by line, rewriting `sessionId` back-references only.
 *
 * No field validation: the audit trail is the record of what ran unattended, and
 * dropping a trace would cost more than a malformed line does. Every line copied
 * counts, bad ones included.
 */
function copyAuditLines(text: string, plan: SessionIdRewritePlan): AuditCopy {
  const lines: string[] = []
  let copied = 0
  for (const line of text.split('\n')) {
    if (line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      lines.push(line)
      copied += 1
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      lines.push(line)
      copied += 1
      continue
    }
    const record = parsed as Record<string, unknown>
    const sessionId = record.sessionId
    if (typeof sessionId === 'string') {
      const rewritten = rewriteSessionId(sessionId, plan)
      lines.push(rewritten === sessionId ? JSON.stringify(record) : JSON.stringify({ ...record, sessionId: rewritten }))
    } else {
      lines.push(JSON.stringify(record))
    }
    copied += 1
  }
  return { lines, copied }
}

/** One JSON object per line with a trailing newline, the legacy `appendRun` rewrite format. */
function renderJsonl(lines: readonly string[]): string {
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

/**
 * Copy the run logs and audit trails into `<profileDir>/automations`, the exact
 * layout `runsPath` / `auditPath` (huaanwork-host/stores.ts:344-353) read from,
 * so the migrated history does not become a dead link.
 */
export const migrateAutomationRunsStep: HuaanworkMigrationStep = {
  name: 'automation-runs',
  async run(source: HuaanworkLegacySource, target: HuaanworkMigrationTarget, report: HuaanworkMigrationReport): Promise<void> {
    const sourceDir = join(source.dshHome, AUTOMATIONS_DIR)
    let names: string[]
    try {
      names = await readdir(sourceDir)
    } catch (cause) {
      if ((cause as { code?: string }).code === 'ENOENT') return
      throw cause
    }
    const destinationDir = join(target.profileDir, AUTOMATIONS_DIR)
    const pending: string[] = []
    for (const name of [...names].sort()) {
      if (!name.endsWith(RUNS_SUFFIX) && !name.endsWith(AUDIT_SUFFIX)) continue
      if (await exists(join(destinationDir, name))) {
        recordSkip(report, `${AUTOMATIONS_DIR}/${name}: destination already exists`)
        continue
      }
      pending.push(name)
    }
    if (pending.length === 0) return
    // Built once and reused for every file: only the neutral root's digest moves.
    const plan = buildSessionIdRewritePlan(
      join(source.dshHome, 'workspace'),
      neutralWorkspaceRoot(target.profileDir),
    )
    for (const name of pending) {
      const text = await readFile(join(sourceDir, name), 'utf8')
      if (name.endsWith(AUDIT_SUFFIX)) {
        const copy = copyAuditLines(text, plan)
        await writeFileAtomic(join(destinationDir, name), renderJsonl(copy.lines), {
          mode: FILE_MODE,
          dirMode: DIRECTORY_MODE,
        })
        bumpCount(report, 'audit', copy.copied)
        continue
      }
      const copy = copyRunLines(text, plan)
      await writeFileAtomic(join(destinationDir, name), renderJsonl(copy.lines), {
        mode: FILE_MODE,
        dirMode: DIRECTORY_MODE,
      })
      bumpCount(report, 'runs', copy.written)
      bumpCount(report, 'runsRebound', copy.rebound)
      if (copy.dropped > 0) {
        recordSkip(report, `${AUTOMATIONS_DIR}/${name}: dropped ${copy.dropped} run lines missing a required RunSummary field`)
      }
    }
  },
}
