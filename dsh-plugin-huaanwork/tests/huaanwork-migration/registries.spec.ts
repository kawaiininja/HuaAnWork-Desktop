import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateProjectsStep, migrateTasksStep } from '../../src/huaanwork-migration/registries.ts'
import { createMigrationReport } from '../../src/huaanwork-migration/report.ts'
import { resolveLegacySource } from '../../src/huaanwork-migration/paths.ts'
import { sessionIdFor } from '../../src/huaanwork-host/session-id.ts'
import { neutralWorkspaceRoot } from '../../src/huaanwork-host/workspace-state.ts'

function fixture() {
  const userData = mkdtempSync(join(tmpdir(), 'mig-registries-src-'))
  const dshHome = join(userData, 'dsh')
  // 旧中性根目录必须存在(旧 <OLD_DSH>/workspace 是 sessionIdFor 的输入)。
  mkdirSync(join(dshHome, 'workspace'), { recursive: true })
  const homeDir = mkdtempSync(join(tmpdir(), 'mig-registries-home-'))
  const profileDir = join(homeDir, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  return { userData, dshHome, source: resolveLegacySource(userData), target: { homeDir, profileDir }, profileDir }
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('migrateProjectsStep', () => {
  it('copies the project registry verbatim (roots are absolute and do not move)', async () => {
    const f = fixture()
    const projects = [
      { id: 'p1', name: 'Alpha', root: '/abs/alpha', createdAt: 1, lastOpenedAt: 2, color: 'red' },
      { id: 'p2', name: 'Beta', root: '/abs/beta', createdAt: 3 },
    ]
    writeFileSync(join(f.dshHome, 'projects.json'), JSON.stringify({ projects }), 'utf8')
    const report = createMigrationReport()
    await migrateProjectsStep.run(f.source, f.target, report)
    expect(readJson(join(f.profileDir, 'projects.json'))).toEqual({ projects })
    expect(report.counts.projects).toBe(2)
    expect(report.skipped).toEqual([])
  })

  it('drops entries that are not project records', async () => {
    const f = fixture()
    const valid = { id: 'p1', name: 'Alpha', root: '/abs/alpha', createdAt: 1 }
    writeFileSync(join(f.dshHome, 'projects.json'), JSON.stringify({ projects: [valid, { id: 1 }, 'nope'] }), 'utf8')
    const report = createMigrationReport()
    await migrateProjectsStep.run(f.source, f.target, report)
    expect(readJson(join(f.profileDir, 'projects.json'))).toEqual({ projects: [valid] })
    expect(report.counts.projects).toBe(1)
    expect(report.skipped).toContain('projects.json: dropped 2 entries that are not project records')
  })

  it('never overwrites an existing registry', async () => {
    const f = fixture()
    writeFileSync(join(f.dshHome, 'projects.json'), JSON.stringify({ projects: [{ id: 'p1', name: 'A', root: '/a', createdAt: 1 }] }), 'utf8')
    const current = { projects: [{ id: 'cur', name: 'Current', root: '/cur', createdAt: 9 }] }
    writeFileSync(join(f.profileDir, 'projects.json'), JSON.stringify(current), 'utf8')
    const report = createMigrationReport()
    await migrateProjectsStep.run(f.source, f.target, report)
    expect(readJson(join(f.profileDir, 'projects.json'))).toEqual(current)
    expect(report.counts.projects).toBeUndefined()
    expect(report.skipped).toContain('projects.json: destination already exists')
  })

  it('is a silent no-op when the legacy registry is absent', async () => {
    const f = fixture()
    const report = createMigrationReport()
    await migrateProjectsStep.run(f.source, f.target, report)
    expect(existsSync(join(f.profileDir, 'projects.json'))).toBe(false)
    expect(report.counts.projects).toBeUndefined()
    expect(report.skipped).toEqual([])
  })

  it('reports an unparseable legacy registry instead of writing garbage', async () => {
    const f = fixture()
    writeFileSync(join(f.dshHome, 'projects.json'), '{ not json', 'utf8')
    const report = createMigrationReport()
    await migrateProjectsStep.run(f.source, f.target, report)
    expect(existsSync(join(f.profileDir, 'projects.json'))).toBe(false)
    expect(report.skipped).toContain('projects.json: unparseable, left in place')
  })

  it('reports an unrecognized registry document instead of writing junk', async () => {
    const f = fixture()
    writeFileSync(join(f.dshHome, 'projects.json'), JSON.stringify({ folders: [] }), 'utf8')
    const report = createMigrationReport()
    await migrateProjectsStep.run(f.source, f.target, report)
    expect(existsSync(join(f.profileDir, 'projects.json'))).toBe(false)
    expect(report.skipped).toContain('projects.json: unrecognized registry')
  })
})

describe('migrateTasksStep', () => {
  it('rebinds a task whose session lived under the neutral root', async () => {
    const f = fixture()
    const oldNeutralId = sessionIdFor(join(f.dshHome, 'workspace'))
    const newNeutralId = sessionIdFor(neutralWorkspaceRoot(f.profileDir))
    writeFileSync(join(f.dshHome, 'tasks.json'), JSON.stringify({ tasks: [
      { id: 't1', projectId: 'p1', name: 'Task', createdAt: 1, sessionId: oldNeutralId, pinned: true },
    ] }), 'utf8')
    const report = createMigrationReport()
    await migrateTasksStep.run(f.source, f.target, report)
    const written = readJson(join(f.profileDir, 'tasks.json')) as { tasks: Array<Record<string, unknown>> }
    expect(written.tasks[0]?.sessionId).toBe(newNeutralId)
    expect(written.tasks[0]?.pinned).toBe(true)
    expect(report.counts.tasks).toBe(1)
    expect(report.counts.tasksRebound).toBe(1)
  })

  it('leaves a project-rooted task session id alone', async () => {
    const f = fixture()
    writeFileSync(join(f.dshHome, 'tasks.json'), JSON.stringify({ tasks: [
      { id: 't1', projectId: 'p1', name: 'Task', createdAt: 1, sessionId: 'huaanwork-2222222222222222' },
    ] }), 'utf8')
    const report = createMigrationReport()
    await migrateTasksStep.run(f.source, f.target, report)
    const written = readJson(join(f.profileDir, 'tasks.json')) as { tasks: Array<Record<string, unknown>> }
    expect(written.tasks[0]?.sessionId).toBe('huaanwork-2222222222222222')
    expect(report.counts.tasks).toBe(1)
    expect(report.counts.tasksRebound).toBe(0)
  })

  it('carries a task without a sessionId (legacy tasks.json had no such field)', async () => {
    const f = fixture()
    writeFileSync(join(f.dshHome, 'tasks.json'), JSON.stringify({ tasks: [
      { id: 't1', projectId: 'p1', name: 'Task', createdAt: 1 },
    ] }), 'utf8')
    const report = createMigrationReport()
    await migrateTasksStep.run(f.source, f.target, report)
    const destination = join(f.profileDir, 'tasks.json')
    expect(readFileSync(destination, 'utf8')).not.toContain('sessionId')
    const written = readJson(destination) as { tasks: Array<Record<string, unknown>> }
    expect(written.tasks[0]).not.toHaveProperty('sessionId')
    expect(report.counts.tasks).toBe(1)
    expect(report.counts.tasksRebound).toBe(0)
  })

  it('drops entries that are not task records', async () => {
    const f = fixture()
    const valid = { id: 't1', projectId: 'p1', name: 'Task', createdAt: 1 }
    writeFileSync(join(f.dshHome, 'tasks.json'), JSON.stringify({ tasks: [valid, { id: 1 }] }), 'utf8')
    const report = createMigrationReport()
    await migrateTasksStep.run(f.source, f.target, report)
    expect(readJson(join(f.profileDir, 'tasks.json'))).toEqual({ tasks: [valid] })
    expect(report.counts.tasks).toBe(1)
    expect(report.skipped).toContain('tasks.json: dropped 1 entries that are not task records')
  })

  it('never overwrites an existing registry', async () => {
    const f = fixture()
    writeFileSync(join(f.dshHome, 'tasks.json'), JSON.stringify({ tasks: [{ id: 't1', projectId: 'p1', name: 'A', createdAt: 1 }] }), 'utf8')
    const current = { tasks: [{ id: 'cur', projectId: 'p1', name: 'Current', createdAt: 9 }] }
    writeFileSync(join(f.profileDir, 'tasks.json'), JSON.stringify(current), 'utf8')
    const report = createMigrationReport()
    await migrateTasksStep.run(f.source, f.target, report)
    expect(readJson(join(f.profileDir, 'tasks.json'))).toEqual(current)
    expect(report.counts.tasks).toBeUndefined()
    expect(report.skipped).toContain('tasks.json: destination already exists')
  })

  it('is a silent no-op when the legacy registry is absent', async () => {
    const f = fixture()
    const report = createMigrationReport()
    await migrateTasksStep.run(f.source, f.target, report)
    expect(existsSync(join(f.profileDir, 'tasks.json'))).toBe(false)
    expect(report.counts.tasks).toBeUndefined()
    expect(report.skipped).toEqual([])
  })
})
