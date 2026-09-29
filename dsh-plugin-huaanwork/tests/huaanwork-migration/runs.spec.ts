import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  migrateAutomationsStep,
  migrateAutomationRunsStep,
  stripLegacyChannel,
} from '../../src/huaanwork-migration/runs.ts'
import { createMigrationReport } from '../../src/huaanwork-migration/report.ts'
import { resolveLegacySource } from '../../src/huaanwork-migration/paths.ts'
import { sessionIdFor } from '../../src/huaanwork-host/session-id.ts'
import { neutralWorkspaceRoot } from '../../src/huaanwork-host/workspace-state.ts'
import { auditPath, runsPath } from '../../src/huaanwork-host/stores.ts'

function fixture() {
  const userData = mkdtempSync(join(tmpdir(), 'mig-runs-src-'))
  const dshHome = join(userData, 'dsh')
  // 旧中性根目录必须存在(旧 <OLD_DSH>/workspace 是 sessionIdFor 的输入)。
  mkdirSync(join(dshHome, 'workspace'), { recursive: true })
  const homeDir = mkdtempSync(join(tmpdir(), 'mig-runs-home-'))
  const profileDir = join(homeDir, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  return { userData, dshHome, source: resolveLegacySource(userData), target: { homeDir, profileDir }, profileDir }
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line !== '')
}

function readLine(path: string, index: number): Record<string, unknown> {
  const line = readLines(path)[index]
  if (line === undefined) throw new Error(`${path}: no line ${index}`)
  return JSON.parse(line) as Record<string, unknown>
}

function runSummary(overrides: Record<string, unknown>): Record<string, unknown> {
  return { runId: 'r1', startedAt: 10, endedAt: 20, ok: true, output: 'done', ...overrides }
}

describe('stripLegacyChannel', () => {
  it('removes the pre-unify channel field', () => {
    expect(stripLegacyChannel({ id: 'a', name: 'n', channel: 'chat' })).toEqual({ id: 'a', name: 'n' })
  })

  it('leaves a record without the field untouched', () => {
    expect(stripLegacyChannel({ id: 'a' })).toEqual({ id: 'a' })
  })

  it('preserves every other key including unattended and missedPolicy', () => {
    const raw = { id: 'a', unattended: { enabled: true, allow: ['x'] }, missedPolicy: 'run-once', channel: 'chat' }
    expect(stripLegacyChannel(raw)).toEqual({ id: 'a', unattended: { enabled: true, allow: ['x'] }, missedPolicy: 'run-once' })
  })

  it('returns a copy and never mutates its input', () => {
    const raw = { id: 'a', channel: 'chat' }
    stripLegacyChannel(raw)
    expect(raw).toEqual({ id: 'a', channel: 'chat' })
  })
})

describe('migrateAutomationsStep', () => {
  it('copies the registry and counts stripped channel fields', async () => {
    const f = fixture()
    const automations = [
      { id: 'a1', projectId: 'p1', name: 'Alpha', kind: 'agent', schedule: { kind: 'manual' }, createdAt: 1, prompt: 'hi' },
      {
        id: 'a2', projectId: null, name: 'Beta', kind: 'script', schedule: { kind: 'cron', expr: '0 9 * * *' },
        createdAt: 2, command: 'echo hi', channel: 'chat',
        unattended: { enabled: true, allow: ['read'] }, missedPolicy: 'run-once',
      },
      { id: 'a3', projectId: 'p1', name: 'Gamma', kind: 'agent', schedule: { kind: 'manual' }, createdAt: 3 },
    ]
    writeFileSync(join(f.dshHome, 'automations.json'), JSON.stringify({ automations }), 'utf8')
    const report = createMigrationReport()
    await migrateAutomationsStep.run(f.source, f.target, report)
    const destination = join(f.profileDir, 'automations.json')
    expect(readFileSync(destination, 'utf8')).not.toContain('channel')
    expect(readJson(destination)).toEqual({
      automations: [
        automations[0],
        {
          id: 'a2', projectId: null, name: 'Beta', kind: 'script', schedule: { kind: 'cron', expr: '0 9 * * *' },
          createdAt: 2, command: 'echo hi',
          unattended: { enabled: true, allow: ['read'] }, missedPolicy: 'run-once',
        },
        automations[2],
      ],
    })
    expect(report.counts.automations).toBe(3)
    expect(report.counts.automationsChannelStripped).toBe(1)
    expect(report.skipped).toEqual([])
  })

  it('drops entries failing the loose legacy validator', async () => {
    const f = fixture()
    const valid = { id: 'a1', projectId: null, name: 'Alpha', kind: 'agent', schedule: { kind: 'manual' }, createdAt: 1 }
    writeFileSync(join(f.dshHome, 'automations.json'), JSON.stringify({ automations: [
      valid,
      { id: 'a2', projectId: 'p1', name: 'Beta', kind: 'agent', schedule: { kind: 'manual' } },
      { id: 'a3', projectId: 'p1', name: 'Gamma', kind: 'chat', schedule: { kind: 'manual' }, createdAt: 3 },
      { id: 'a4', projectId: 7, name: 'Delta', kind: 'script', schedule: {}, createdAt: 4 },
      { id: 'a5', projectId: 'p1', name: 'Eps', kind: 'script', schedule: 'daily', createdAt: 5 },
      'nope',
    ] }), 'utf8')
    const report = createMigrationReport()
    await migrateAutomationsStep.run(f.source, f.target, report)
    expect(readJson(join(f.profileDir, 'automations.json'))).toEqual({ automations: [valid] })
    expect(report.counts.automations).toBe(1)
    expect(report.counts.automationsChannelStripped).toBe(0)
    expect(report.skipped).toContain('automations.json: dropped 5 entries that are not automation records')
  })

  it('never overwrites an existing registry', async () => {
    const f = fixture()
    writeFileSync(join(f.dshHome, 'automations.json'), JSON.stringify({ automations: [
      { id: 'a1', projectId: null, name: 'Alpha', kind: 'agent', schedule: { kind: 'manual' }, createdAt: 1 },
    ] }), 'utf8')
    const current = { automations: [{ id: 'cur', projectId: null, name: 'Current', kind: 'agent', schedule: {}, createdAt: 9 }] }
    writeFileSync(join(f.profileDir, 'automations.json'), JSON.stringify(current), 'utf8')
    const report = createMigrationReport()
    await migrateAutomationsStep.run(f.source, f.target, report)
    expect(readJson(join(f.profileDir, 'automations.json'))).toEqual(current)
    expect(report.counts.automations).toBeUndefined()
    expect(report.skipped).toContain('automations.json: destination already exists')
  })

  it('is a silent no-op when the legacy registry is absent', async () => {
    const f = fixture()
    const report = createMigrationReport()
    await migrateAutomationsStep.run(f.source, f.target, report)
    expect(existsSync(join(f.profileDir, 'automations.json'))).toBe(false)
    expect(report.counts.automations).toBeUndefined()
    expect(report.skipped).toEqual([])
  })

  it('reports an unparseable legacy registry instead of writing garbage', async () => {
    const f = fixture()
    writeFileSync(join(f.dshHome, 'automations.json'), '{ not json', 'utf8')
    const report = createMigrationReport()
    await migrateAutomationsStep.run(f.source, f.target, report)
    expect(existsSync(join(f.profileDir, 'automations.json'))).toBe(false)
    expect(report.skipped).toContain('automations.json: unparseable, left in place')
  })

  it('reports an unrecognized registry document instead of writing junk', async () => {
    const f = fixture()
    writeFileSync(join(f.dshHome, 'automations.json'), JSON.stringify({ rules: [] }), 'utf8')
    const report = createMigrationReport()
    await migrateAutomationsStep.run(f.source, f.target, report)
    expect(existsSync(join(f.profileDir, 'automations.json'))).toBe(false)
    expect(report.skipped).toContain('automations.json: unrecognized registry')
  })
})

describe('migrateAutomationRunsStep', () => {
  it('copies every *.runs.jsonl and rewrites sessionId back-references', async () => {
    const f = fixture()
    const oldNeutralId = sessionIdFor(join(f.dshHome, 'workspace'))
    const newNeutralId = sessionIdFor(neutralWorkspaceRoot(f.profileDir))
    mkdirSync(join(f.dshHome, 'automations'), { recursive: true })
    writeFileSync(join(f.dshHome, 'automations', 'a1.runs.jsonl'), [
      JSON.stringify(runSummary({ runId: 'r1', sessionId: oldNeutralId, status: 'ok', trigger: 'schedule' })),
      JSON.stringify(runSummary({ runId: 'r2', sessionId: 'huaanwork-auto-a1-r2' })),
    ].join('\n') + '\n', 'utf8')
    const report = createMigrationReport()
    await migrateAutomationRunsStep.run(f.source, f.target, report)
    const destination = runsPath(f.profileDir, 'a1')
    expect(destination).toBe(join(f.profileDir, 'automations', 'a1.runs.jsonl'))
    expect(readFileSync(destination, 'utf8').endsWith('\n')).toBe(true)
    const written = readLines(destination)
    expect(written).toHaveLength(2)
    expect(readLine(destination, 0)).toEqual(runSummary({ runId: 'r1', sessionId: newNeutralId, status: 'ok', trigger: 'schedule' }))
    expect(readLine(destination, 1)).toEqual(runSummary({ runId: 'r2', sessionId: 'huaanwork-auto-a1-r2' }))
    expect(report.counts.runs).toBe(2)
    expect(report.counts.runsRebound).toBe(1)
    expect(report.skipped).toEqual([])
  })

  it('copies every run log in the directory and aggregates the counts', async () => {
    const f = fixture()
    const oldNeutralId = sessionIdFor(join(f.dshHome, 'workspace'))
    mkdirSync(join(f.dshHome, 'automations'), { recursive: true })
    writeFileSync(join(f.dshHome, 'automations', 'a1.runs.jsonl'), `${JSON.stringify(runSummary({ sessionId: oldNeutralId }))}\n`, 'utf8')
    writeFileSync(join(f.dshHome, 'automations', 'a2.runs.jsonl'), `${JSON.stringify(runSummary({ runId: 'r2' }))}\n`, 'utf8')
    const report = createMigrationReport()
    await migrateAutomationRunsStep.run(f.source, f.target, report)
    expect(existsSync(runsPath(f.profileDir, 'a1'))).toBe(true)
    expect(existsSync(runsPath(f.profileDir, 'a2'))).toBe(true)
    expect(report.counts.runs).toBe(2)
    expect(report.counts.runsRebound).toBe(1)
  })

  it('drops run lines missing a required RunSummary field and keeps unparseable lines verbatim', async () => {
    const f = fixture()
    const valid = runSummary({ runId: 'r1' })
    mkdirSync(join(f.dshHome, 'automations'), { recursive: true })
    writeFileSync(join(f.dshHome, 'automations', 'a1.runs.jsonl'), [
      JSON.stringify(valid),
      '{ this is not json',
      JSON.stringify({ runId: 'r3', startedAt: 1, endedAt: 2, ok: true }),
    ].join('\n') + '\n', 'utf8')
    const report = createMigrationReport()
    await migrateAutomationRunsStep.run(f.source, f.target, report)
    const destination = runsPath(f.profileDir, 'a1')
    expect(readLines(destination)).toEqual([JSON.stringify(valid), '{ this is not json'])
    expect(report.counts.runs).toBe(1)
    expect(report.counts.runsRebound).toBe(0)
    expect(report.skipped).toContain('automations/a1.runs.jsonl: dropped 1 run lines missing a required RunSummary field')
  })

  it('copies *.audit.jsonl alongside the runs, into the profile directory (G5)', async () => {
    const f = fixture()
    const oldNeutralId = sessionIdFor(join(f.dshHome, 'workspace'))
    const newNeutralId = sessionIdFor(neutralWorkspaceRoot(f.profileDir))
    mkdirSync(join(f.dshHome, 'automations'), { recursive: true })
    writeFileSync(join(f.dshHome, 'automations', 'a1.audit.jsonl'), `${JSON.stringify({
      at: 1, runId: 'r1', sessionId: oldNeutralId, tool: 'write', callId: 'c1', decision: 'ask→allow',
    })}\n`, 'utf8')
    const report = createMigrationReport()
    await migrateAutomationRunsStep.run(f.source, f.target, report)
    const destination = auditPath(f.profileDir, 'a1')
    expect(destination).toBe(join(f.profileDir, 'automations', 'a1.audit.jsonl'))
    expect(readLine(destination, 0)).toEqual({
      at: 1, runId: 'r1', sessionId: newNeutralId, tool: 'write', callId: 'c1', decision: 'ask→allow',
    })
    expect(report.counts.audit).toBe(1)
    expect(report.counts.runs).toBeUndefined()
  })

  it('counts every copied audit line without validating its shape', async () => {
    const f = fixture()
    mkdirSync(join(f.dshHome, 'automations'), { recursive: true })
    writeFileSync(join(f.dshHome, 'automations', 'a1.audit.jsonl'), [
      JSON.stringify({ at: 1, runId: 'r1', tool: 'write', callId: 'c1', decision: 'ask→allow' }),
      '[ not a record',
    ].join('\n') + '\n', 'utf8')
    const report = createMigrationReport()
    await migrateAutomationRunsStep.run(f.source, f.target, report)
    const destination = auditPath(f.profileDir, 'a1')
    expect(readLines(destination)).toHaveLength(2)
    expect(readLines(destination)[1]).toBe('[ not a record')
    expect(report.counts.audit).toBe(2)
  })

  it('preserves an empty runs directory without creating stray files', async () => {
    const f = fixture()
    const report = createMigrationReport()
    await migrateAutomationRunsStep.run(f.source, f.target, report)
    expect(existsSync(join(f.profileDir, 'automations'))).toBe(false)
    expect(readdirSync(f.profileDir)).toEqual([])
    expect(report.counts.runs).toBeUndefined()
    expect(report.skipped).toEqual([])
  })

  it('never overwrites an existing run or audit log', async () => {
    const f = fixture()
    mkdirSync(join(f.dshHome, 'automations'), { recursive: true })
    writeFileSync(join(f.dshHome, 'automations', 'a1.runs.jsonl'), `${JSON.stringify(runSummary({}))}\n`, 'utf8')
    mkdirSync(join(f.profileDir, 'automations'), { recursive: true })
    const current = '{"runId":"cur"}\n'
    writeFileSync(runsPath(f.profileDir, 'a1'), current, 'utf8')
    const report = createMigrationReport()
    await migrateAutomationRunsStep.run(f.source, f.target, report)
    expect(readFileSync(runsPath(f.profileDir, 'a1'), 'utf8')).toBe(current)
    expect(report.counts.runs).toBeUndefined()
    expect(report.skipped).toContain('automations/a1.runs.jsonl: destination already exists')
  })

  it('ignores entries that are neither run logs nor audit trails', async () => {
    const f = fixture()
    mkdirSync(join(f.dshHome, 'automations'), { recursive: true })
    writeFileSync(join(f.dshHome, 'automations', 'a1.runs.jsonl'), `${JSON.stringify(runSummary({}))}\n`, 'utf8')
    writeFileSync(join(f.dshHome, 'automations', 'notes.txt'), 'keep me out\n', 'utf8')
    writeFileSync(join(f.dshHome, 'automations', 'a1.runs.jsonl.bak'), 'stale\n', 'utf8')
    const report = createMigrationReport()
    await migrateAutomationRunsStep.run(f.source, f.target, report)
    expect(readdirSync(join(f.profileDir, 'automations'))).toEqual(['a1.runs.jsonl'])
    expect(report.counts.runs).toBe(1)
  })
})
