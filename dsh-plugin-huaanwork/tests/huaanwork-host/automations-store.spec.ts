import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { AutomationInfo, AutomationSchedule, RunSummary } from '../../src/client-huaanwork/rpc-types.ts'
import { inFlightRuns, startInFlightRun } from '../../src/huaanwork-host/automation-inflight.ts'
import {
  AUTOMATION_SESSION_RETAIN_LIMIT,
  MAX_AUTOMATIONS,
  MISSED_GRACE_MS,
  advanceNextRunAt,
  appendRun,
  createAutomation,
  deleteAutomationRun,
  markAutomation,
  dueAutomations,
  expiredAutomations,
  missedAutomations,
  normalizeAutomationInput,
  pruneAutomationSessions,
  removeAutomation,
  rewriteLastRunFromRuns,
  updateAutomation,
} from '../../src/huaanwork-host/automations-store.ts'
import { humanizeCron, nextFireAfter, parseCron, periodOf } from '../../src/huaanwork-host/schedule.ts'
import { ROUTE_TABLE } from '../../src/huaanwork-host/routes.ts'
import { RUNS_LIMIT, listAutomations, recentRuns, removeAutomationsOfProject } from '../../src/huaanwork-host/stores.ts'

// 写路径与纯函数用例移植自旧 sidecar automations.test.ts(属于本层的部分)
// 与 schedule.test.ts 15 例。node:test assert → vitest expect。

const T0 = Date.UTC(2026, 0, 15, 1, 0, 0)

let homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hw-auto-store-'))
  homes.push(home)
  return home
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
})

function agentInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 'p1',
    name: '每日早报',
    kind: 'agent',
    schedule: { kind: 'daily', time: '09:30' },
    prompt: '生成今日早报',
    widget: true,
    enabled: true,
    ...overrides,
  }
}

function writeRun(home: string, automationId: string, run: Record<string, unknown>): void {
  const dir = join(home, 'automations')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${automationId}.runs.jsonl`), `${JSON.stringify(run)}\n`, 'utf8')
}

describe('automations-store 写路径与纯函数', () => {
  test('normalizeAutomationInput validates required fields and schedule shapes', () => {
    const input = normalizeAutomationInput(agentInput(), T0)
    expect(input.kind).toBe('agent')
    expect(input.widget).toBe(true)
    expect(input.schedule).toEqual({ kind: 'daily', time: '09:30' })

    expect(normalizeAutomationInput(agentInput({ projectId: '' })).projectId).toBe(null)
    expect(() => normalizeAutomationInput(agentInput({ projectId: 42 }))).toThrow(/projectId/)
    expect(() => normalizeAutomationInput(agentInput({ name: ' ' }))).toThrow(/name/)
    expect(() => normalizeAutomationInput(agentInput({ kind: 'wat' }))).toThrow(/agent.*script/)
    expect(() => normalizeAutomationInput(agentInput({ prompt: '' }))).toThrow(/prompt/)
    expect(() => normalizeAutomationInput(agentInput({ kind: 'script', command: '' }))).toThrow(/command/)
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'interval', minutes: 0 } }))).toThrow(/minutes/)
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'daily', time: '9:30' } }))).toThrow(/HH:MM/)
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'daily', time: '25:00' } }))).toThrow(/范围/)
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'cron' } }))).toThrow(/cron/)
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'wat' } }))).toThrow(
      /manual.*once.*interval.*hourly.*daily.*weekly.*monthly.*cron/,
    )
    expect(normalizeAutomationInput(agentInput({ enabled: undefined, widget: undefined })).enabled).toBe(true)
    expect(normalizeAutomationInput(agentInput({ enabled: undefined, widget: undefined })).widget).toBe(false)
  })

  test('dueAutomations matches items within grace; stale ones land in missedAutomations', () => {
    const base = (overrides: Partial<AutomationInfo>): AutomationInfo => ({
      id: 'a1',
      projectId: 'p1',
      name: 'task',
      kind: 'agent',
      schedule: { kind: 'interval', minutes: 10 },
      widget: false,
      enabled: true,
      createdAt: T0,
      ...overrides,
    })

    const now = T0 + 20 * 60_000
    const list = [
      base({ id: 'hit', nextRunAt: T0 + 15 * 60_000 }),
      base({ id: 'edge', nextRunAt: now - MISSED_GRACE_MS }),
      base({ id: 'just-over', nextRunAt: now - MISSED_GRACE_MS - 1 }),
      base({ id: 'stale', nextRunAt: T0 - 3 * 24 * 3600_000 }),
      base({ id: 'future', nextRunAt: T0 + 30 * 60_000 }),
      base({ id: 'disabled', enabled: false, nextRunAt: T0 }),
      base({ id: 'manual', schedule: { kind: 'manual' } }),
      base({ id: 'never-ran' }),
    ]

    expect(dueAutomations(list, now).map((item) => item.id)).toEqual(['hit', 'edge'])
    const missed = missedAutomations(list, now)
    expect(missed.map((entry) => entry.automation.id)).toEqual(['just-over', 'stale'])
    expect(missed[0]?.nextRunAt).toBe(now + 10 * 60_000)
    expect(missed[0]?.nextRunAt).toBeGreaterThan(now)
    expect(missedAutomations(list, now, 60_000).map((entry) => entry.automation.id)).toEqual([
      'hit',
      'edge',
      'just-over',
      'stale',
    ])
    expect(dueAutomations(list, now, 60_000).map((item) => item.id)).toEqual([])
  })

  test('normalizeSchedule accepts all 8 kinds with per-kind validation', () => {
    const at = T0 + 60_000
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'once', at: T0 - 1 } }), T0)).toThrow(/已过去/)
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'once', at: T0 } }), T0)).toThrow(/已过去/)
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'once' } }), T0)).toThrow(/at/)
    expect(normalizeAutomationInput(agentInput({ schedule: { kind: 'once', at } }), T0).schedule).toEqual({ kind: 'once', at })

    expect(normalizeAutomationInput(agentInput({ schedule: { kind: 'hourly', minute: 0 } }), T0).schedule).toEqual({
      kind: 'hourly',
      minute: 0,
    })
    expect(normalizeAutomationInput(agentInput({ schedule: { kind: 'hourly', minute: 59 } }), T0).schedule).toEqual({
      kind: 'hourly',
      minute: 59,
    })
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'hourly', minute: 60 } }), T0)).toThrow(/minute/)
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'hourly', minute: -1 } }), T0)).toThrow(/minute/)

    expect(
      normalizeAutomationInput(agentInput({ schedule: { kind: 'weekly', days: [7, 1, 0, 3, 1], time: '09:30' } }), T0).schedule,
    ).toEqual({ kind: 'weekly', days: [0, 1, 3], time: '09:30' })
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'weekly', days: [8], time: '09:30' } }), T0)).toThrow(/days/)
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'weekly', days: [], time: '09:30' } }), T0)).toThrow(/days/)
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'weekly', days: [1], time: '9:30' } }), T0)).toThrow(/HH:MM/)
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'weekly', days: [1], time: '24:00' } }), T0)).toThrow(/范围/)

    expect(
      normalizeAutomationInput(agentInput({ schedule: { kind: 'monthly', dates: [31, 1, 15, 1], time: '08:00' } }), T0).schedule,
    ).toEqual({ kind: 'monthly', dates: [1, 15, 31], time: '08:00' })
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'monthly', dates: [0], time: '08:00' } }), T0)).toThrow(/dates/)
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'monthly', dates: [32], time: '08:00' } }), T0)).toThrow(/dates/)
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'monthly', dates: [], time: '08:00' } }), T0)).toThrow(/dates/)

    expect(
      normalizeAutomationInput(agentInput({ schedule: { kind: 'cron', expr: ' */15 9-18 * * 1-5 ' } }), T0).schedule,
    ).toEqual({ kind: 'cron', expr: '*/15 9-18 * * 1-5' })
    expect(() => normalizeAutomationInput(agentInput({ schedule: { kind: 'cron', expr: 'every minute' } }), T0)).toThrow(/cron/)
  })

  test('normalizeAutomationInput enforces a UTF-8 prompt limit of 8 KB', () => {
    const atLimit = 'a'.repeat(8 * 1024)
    expect(normalizeAutomationInput(agentInput({ prompt: atLimit })).prompt).toBe(atLimit)
    expect(() => normalizeAutomationInput(agentInput({ prompt: `${atLimit}b` }))).toThrow(/提示词/)
    expect(() => normalizeAutomationInput(agentInput({ prompt: '汉'.repeat(3000) }))).toThrow(/提示词/)
  })

  test('createAutomation refuses the 51st automation', async () => {
    const home = makeHome()
    for (let i = 0; i < 50; i += 1) {
      await createAutomation(home, normalizeAutomationInput(agentInput({ name: `任务-${i}` }), T0), T0)
    }
    expect(await listAutomations(home)).toHaveLength(MAX_AUTOMATIONS)
    await expect(
      createAutomation(home, normalizeAutomationInput(agentInput({ name: '第 51 个' }), T0), T0),
    ).rejects.toThrow(/上限/)
    expect(await listAutomations(home)).toHaveLength(50)
  })

  test('new optional fields persist on create and update via whitelist patch branches', async () => {
    const home = makeHome()
    const created = await createAutomation(
      home,
      normalizeAutomationInput(
        agentInput({ expiresAt: T0 + 86_400_000, missedPolicy: 'run-once', taskShape: 'merged' }),
        T0,
      ),
      T0,
    )
    expect(created.expiresAt).toBe(T0 + 86_400_000)
    expect(created.missedPolicy).toBe('run-once')
    expect(created.taskShape).toBe('merged')
    expect(created.unattended).toBeUndefined()

    const updated = await updateAutomation(
      home,
      created.id,
      { expiresAt: T0 + 2 * 86_400_000, missedPolicy: 'skip', taskShape: 'independent' },
      T0,
    )
    expect(updated.expiresAt).toBe(T0 + 2 * 86_400_000)
    expect(updated.missedPolicy).toBe('skip')
    expect(updated.taskShape).toBe('independent')

    const cleared = await updateAutomation(home, created.id, { expiresAt: '', missedPolicy: '', taskShape: '' }, T0)
    expect(cleared.expiresAt).toBeUndefined()
    expect(cleared.missedPolicy).toBeUndefined()
    expect(cleared.taskShape).toBeUndefined()

    const ignored = await updateAutomation(home, created.id, { missedPolicy: 'banana', expiresAt: 'tomorrow' }, T0)
    expect(ignored.missedPolicy).toBeUndefined()
    expect(ignored.expiresAt).toBeUndefined()

    const unattended = await updateAutomation(
      home,
      created.id,
      { unattended: { enabled: true, allow: ['a', 'read', 'bash', 'run_code', 'read'] } },
      T0,
    )
    expect(unattended.unattended).toEqual({ enabled: true, allow: ['read', 'bash'] })

    const clearedUnattended = await updateAutomation(home, created.id, { unattended: '' }, T0)
    expect(clearedUnattended.unattended).toBeUndefined()
  })

  test('normalizeAutomationInput normalizes unattended: defaults, run_code strip', () => {
    expect(normalizeAutomationInput(agentInput({ unattended: { enabled: true } }), T0).unattended).toEqual({
      enabled: true,
      allow: ['read', 'read_file', 'glob', 'grep', 'edit', 'write', 'str_replace_editor'],
    })
    expect(normalizeAutomationInput(agentInput({ unattended: { enabled: false } }), T0).unattended).toEqual({
      enabled: false,
      allow: [],
    })
    expect(
      normalizeAutomationInput(
        agentInput({ unattended: { enabled: true, allow: ['read', 'bash', 'run_code', 'not-a-tool', 'bash'] } }),
        T0,
      ).unattended,
    ).toEqual({ enabled: true, allow: ['read', 'bash'] })
    expect(
      normalizeAutomationInput(
        agentInput({
          unattended: { enabled: true, allow: ['read', 'git_commit', 'git_push', 'git_checkout', 'pwsh'] },
        }),
        T0,
      ).unattended,
    ).toEqual({ enabled: true, allow: ['read', 'pwsh'] })
    expect(() => normalizeAutomationInput(agentInput({ unattended: 'yes' }), T0)).toThrow(/unattended/)
  })

  test('updateAutomation can enable unattended on any automation', async () => {
    const home = makeHome()
    const task = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    const updated = await updateAutomation(home, task.id, { unattended: { enabled: true } }, T0)
    expect(updated.unattended).toEqual({
      enabled: true,
      allow: ['read', 'read_file', 'glob', 'grep', 'edit', 'write', 'str_replace_editor'],
    })
  })

  test('automation CRUD persists, filters by project, and cascades on project removal', async () => {
    const home = makeHome()
    const created = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    expect(created.nextRunAt).toBeGreaterThan(T0)
    const other = await createAutomation(
      home,
      normalizeAutomationInput(agentInput({ projectId: 'p2', name: '抓取行情', kind: 'script', command: 'node task.mjs' }), T0),
      T0,
    )

    expect(await listAutomations(home)).toHaveLength(2)
    expect((await listAutomations(home, 'p1')).map((item) => item.id)).toEqual([created.id])

    const updated = await updateAutomation(home, created.id, { schedule: { kind: 'interval', minutes: 5 } }, T0 + 1_000)
    expect(updated.nextRunAt).toBe(T0 + 1_000 + 5 * 60_000)
    await expect(updateAutomation(home, created.id, { prompt: '' })).rejects.toThrow(/prompt/)

    writeRun(home, other.id, { runId: 'r1', startedAt: T0, endedAt: T0 + 1, ok: true, output: 'ok' })
    await removeAutomationsOfProject(home, 'p2')
    expect(await listAutomations(home)).toHaveLength(1)
    expect(await recentRuns(home, other.id)).toEqual([])

    await removeAutomation(home, created.id)
    expect(await listAutomations(home)).toEqual([])
    await expect(removeAutomation(home, created.id)).rejects.toThrow(/was not found/)
  })

  test('pruneAutomationSessions keeps recorded and active sessions and does not touch runs files', async () => {
    const home = makeHome()
    const automation = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    const id = automation.id
    const runsPath = join(home, 'automations', `${id}.runs.jsonl`)
    const runsBody = `${JSON.stringify({
      runId: 'r51',
      startedAt: T0,
      endedAt: T0 + 1,
      ok: true,
      output: 'ok',
      status: 'ok',
      trigger: 'schedule',
      sessionId: `huaanwork-auto-${id}-r51`,
    })}\n`
    mkdirSync(join(home, 'automations'), { recursive: true })
    writeFileSync(runsPath, runsBody, 'utf8')

    const sessionsCwd = join(home, 'sessions', 'some-cwd')
    mkdirSync(join(sessionsCwd, `huaanwork-auto-${id}-r1`), { recursive: true })
    mkdirSync(join(sessionsCwd, `huaanwork-auto-${id}-r51`), { recursive: true })
    mkdirSync(join(sessionsCwd, `huaanwork-auto-${id}-live`), { recursive: true })
    mkdirSync(join(sessionsCwd, 'huaanwork-user'), { recursive: true })

    const removed = await pruneAutomationSessions(home, new Set([`huaanwork-auto-${id}-live`]))
    expect(removed).toBe(1)
    expect(readdirSync(sessionsCwd).sort()).toEqual(
      [`huaanwork-auto-${id}-live`, `huaanwork-auto-${id}-r51`, 'huaanwork-user'].sort(),
    )
    expect(readFileSync(runsPath, 'utf8')).toBe(runsBody)

    const removedAll = await pruneAutomationSessions(home)
    expect(removedAll).toBe(1)
    expect(readdirSync(sessionsCwd).sort()).toEqual([`huaanwork-auto-${id}-r51`, 'huaanwork-user'].sort())
    expect(readFileSync(runsPath, 'utf8')).toBe(runsBody)
    expect(existsSync(runsPath)).toBe(true)
  })

  test('pruneAutomationSessions keeps only the newest 20 run sessions plus active ones', async () => {
    const home = makeHome()
    const automation = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    const id = automation.id
    const sessionIds = Array.from({ length: AUTOMATION_SESSION_RETAIN_LIMIT + 1 }, (_, index) => `huaanwork-auto-${id}-r${index + 1}`)
    const runsBody = sessionIds
      .map((sessionId, index) =>
        JSON.stringify({
          runId: `r${index + 1}`,
          startedAt: T0 + index,
          endedAt: T0 + index + 1,
          ok: true,
          output: 'ok',
          status: 'ok',
          trigger: 'schedule',
          sessionId,
        }),
      )
      .join('\n')
    const runsPath = join(home, 'automations', `${id}.runs.jsonl`)
    mkdirSync(join(home, 'automations'), { recursive: true })
    writeFileSync(runsPath, `${runsBody}\n`, 'utf8')

    const sessionsCwd = join(home, 'sessions', 'some-cwd')
    for (const sessionId of sessionIds) mkdirSync(join(sessionsCwd, sessionId), { recursive: true })
    const activeSessionId = `huaanwork-auto-${id}-live`
    mkdirSync(join(sessionsCwd, activeSessionId), { recursive: true })
    mkdirSync(join(sessionsCwd, 'huaanwork-user'), { recursive: true })

    // 会话保留条数与运行记录上限是两件事:运行记录仍留 50 条,会话目录只留 20 条。
    expect(AUTOMATION_SESSION_RETAIN_LIMIT).toBe(20)
    expect(AUTOMATION_SESSION_RETAIN_LIMIT).not.toBe(RUNS_LIMIT)

    const removed = await pruneAutomationSessions(home, new Set([activeSessionId]))
    expect(removed).toBe(1)
    expect(existsSync(join(sessionsCwd, sessionIds[0]!))).toBe(false)
    expect(readdirSync(sessionsCwd).sort()).toEqual(
      [...sessionIds.slice(1), activeSessionId, 'huaanwork-user'].sort(),
    )
    const afterPrune = readFileSync(runsPath, 'utf8')
    expect(afterPrune).toBe(`${runsBody}\n`)
    expect(afterPrune.trimEnd().split('\n')).toHaveLength(21)
  })

  test('normalizeAutomationInput creates a script automation', async () => {
    const input = normalizeAutomationInput(agentInput({ kind: 'script', command: 'echo hi' }), T0)
    expect(input.kind).toBe('script')
    expect(input.command).toBe('echo hi')

    const home = makeHome()
    const automation = await createAutomation(home, input, T0)
    expect(automation.kind).toBe('script')
    expect(automation.command).toBe('echo hi')
    const updated = await updateAutomation(home, automation.id, { command: 'echo done' }, T0)
    expect(updated.command).toBe('echo done')
  })

  test('automations.json rows survive registry rewrite', async () => {
    const home = makeHome()
    await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    const raw = JSON.parse(readFileSync(join(home, 'automations.json'), 'utf8')) as { automations: AutomationInfo[] }
    expect(raw.automations).toHaveLength(1)
    expect(raw.automations[0]?.name).toBe('每日早报')
  })

  test('once-missed is returned with disable instead of falling into the anomaly branch', () => {
    const now = T0 + 3 * 24 * 3600_000
    const once: AutomationInfo = {
      id: 'once1',
      projectId: 'p1',
      name: '一次性任务',
      kind: 'agent',
      schedule: { kind: 'once', at: T0 },
      widget: false,
      enabled: true,
      createdAt: T0,
      nextRunAt: T0,
    }
    const missed = missedAutomations([once], now)
    expect(missed).toHaveLength(1)
    expect(missed[0]?.automation.id).toBe('once1')
    expect(missed[0]?.disable).toBe(true)
    expect(missed[0]?.nextRunAt).toBeUndefined()
    expect(missed[0]?.policy).toBe('skip')
    expect(missed[0]?.coalescedCount).toBe(1)
  })

  test('missedAutomations splits by missedPolicy and derives coalescedCount from periodOf', () => {
    const now = T0 + 35 * 60_000
    const base = (overrides: Partial<AutomationInfo>): AutomationInfo => ({
      id: 'a1',
      projectId: 'p1',
      name: 'task',
      kind: 'agent',
      schedule: { kind: 'interval', minutes: 10 },
      widget: false,
      enabled: true,
      createdAt: T0,
      nextRunAt: T0,
      ...overrides,
    })
    const missed = missedAutomations([base({ id: 'skip-default' }), base({ id: 'run-once', missedPolicy: 'run-once' })], now)
    expect(missed.map((entry) => entry.automation.id)).toEqual(['skip-default', 'run-once'])
    expect(missed[0]?.policy).toBe('skip')
    expect(missed[0]?.coalescedCount).toBe(4)
    expect(missed[0]?.nextRunAt).toBe(now + 10 * 60_000)
    expect(missed[1]?.policy).toBe('run-once')
    expect(missed[1]?.coalescedCount).toBe(4)

    const daily = base({
      id: 'daily',
      schedule: { kind: 'daily', time: '09:00' },
      nextRunAt: now - (3 * 24 * 3600_000 + 3600_000),
    })
    expect(missedAutomations([daily], now)[0]?.coalescedCount).toBe(4)
  })

  test('expiredAutomations flags enabled tasks past expiresAt (boundary inclusive)', () => {
    const base = (overrides: Partial<AutomationInfo>): AutomationInfo => ({
      id: 'a1',
      projectId: 'p1',
      name: 'task',
      kind: 'agent',
      schedule: { kind: 'interval', minutes: 10 },
      widget: false,
      enabled: true,
      createdAt: T0,
      ...overrides,
    })
    const list = [
      base({ id: 'expired', expiresAt: T0 - 1 }),
      base({ id: 'boundary', expiresAt: T0 }),
      base({ id: 'future', expiresAt: T0 + 1 }),
      base({ id: 'disabled', enabled: false, expiresAt: T0 - 1 }),
      base({ id: 'no-expires' }),
    ]
    expect(expiredAutomations(list, T0).map((item) => item.id)).toEqual(['expired', 'boundary'])
  })

  test('removeAutomation cascades to huaanwork-auto-<id>-* session directories', async () => {
    const home = makeHome()
    const created = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    const id = created.id
    const cwdA = join(home, 'sessions', 'cwd-a')
    const cwdB = join(home, 'sessions', 'cwd-b')
    mkdirSync(join(cwdA, `huaanwork-auto-${id}-abc123`), { recursive: true })
    mkdirSync(join(cwdA, `huaanwork-auto-${id}-def456`, 'nested'), { recursive: true })
    mkdirSync(join(cwdB, 'huaanwork-auto-other-zzz'), { recursive: true })
    mkdirSync(join(cwdB, 'regular-session'), { recursive: true })

    await removeAutomation(home, id)
    expect(readdirSync(cwdA).filter((name) => name.startsWith(`huaanwork-auto-${id}-`))).toEqual([])
    expect(readdirSync(cwdB).sort()).toEqual(['huaanwork-auto-other-zzz', 'regular-session'])

    const bare = makeHome()
    const bareTask = await createAutomation(bare, normalizeAutomationInput(agentInput({ name: '无会话' }), T0), T0)
    await removeAutomation(bare, bareTask.id)
    expect(await listAutomations(bare)).toEqual([])
  })

  test('removeAutomationsOfProject cascades sessions of all project automations', async () => {
    const home = makeHome()
    const first = await createAutomation(home, normalizeAutomationInput(agentInput({ name: 'A' }), T0), T0)
    const second = await createAutomation(home, normalizeAutomationInput(agentInput({ name: 'B' }), T0), T0)
    const other = await createAutomation(home, normalizeAutomationInput(agentInput({ projectId: 'p2', name: 'C' }), T0), T0)
    const cwd = join(home, 'sessions', 'cwd-x')
    mkdirSync(join(cwd, `huaanwork-auto-${first.id}-s1`), { recursive: true })
    mkdirSync(join(cwd, `huaanwork-auto-${second.id}-s2`), { recursive: true })
    mkdirSync(join(cwd, `huaanwork-auto-${other.id}-s3`), { recursive: true })

    await removeAutomationsOfProject(home, 'p1')
    expect(readdirSync(cwd)).toEqual([`huaanwork-auto-${other.id}-s3`])
  })

  test('removeAutomation and removeAutomationsOfProject also delete the unattended audit file', async () => {
    const home = makeHome()
    const solo = await createAutomation(home, normalizeAutomationInput(agentInput({ name: '单删' }), T0), T0)
    const automationsDir = join(home, 'automations')
    mkdirSync(automationsDir, { recursive: true })
    const soloAudit = join(automationsDir, `${solo.id}.audit.jsonl`)
    writeFileSync(soloAudit, `${JSON.stringify({ at: T0, runId: 'r1', tool: 'bash' })}\n`, 'utf8')
    await removeAutomation(home, solo.id)
    expect(existsSync(soloAudit)).toBe(false)

    const first = await createAutomation(home, normalizeAutomationInput(agentInput({ name: '项目删-A' }), T0), T0)
    const second = await createAutomation(home, normalizeAutomationInput(agentInput({ name: '项目删-B' }), T0), T0)
    const other = await createAutomation(home, normalizeAutomationInput(agentInput({ projectId: 'p2', name: '别的项目' }), T0), T0)
    const firstAudit = join(automationsDir, `${first.id}.audit.jsonl`)
    const secondAudit = join(automationsDir, `${second.id}.audit.jsonl`)
    const otherAudit = join(automationsDir, `${other.id}.audit.jsonl`)
    for (const path of [firstAudit, secondAudit, otherAudit]) {
      writeFileSync(path, `${JSON.stringify({ at: T0, runId: 'r', tool: 'bash' })}\n`, 'utf8')
    }
    await removeAutomationsOfProject(home, 'p1')
    expect(existsSync(firstAudit)).toBe(false)
    expect(existsSync(secondAudit)).toBe(false)
    expect(readFileSync(otherAudit, 'utf8').length).toBeGreaterThan(0)
  })

  test('concurrent updates on the shared registry lock both stick', async () => {
    const home = makeHome()
    const created = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    const other = await createAutomation(
      home,
      normalizeAutomationInput(agentInput({ projectId: 'p2', name: '别的', kind: 'script', command: 'echo hi' }), T0),
      T0,
    )
    await Promise.all([
      updateAutomation(home, created.id, { name: '改名了', widget: false }, T0),
      removeAutomationsOfProject(home, 'p2'),
    ])
    const left = await listAutomations(home)
    expect(left.map((item) => item.id)).toEqual([created.id])
    expect(left[0]?.name).toBe('改名了')
    expect(left[0]?.widget).toBe(false)
    expect(left.some((item) => item.id === other.id)).toBe(false)
  })

  test('advanceNextRunAt writes nextRunAt and leaves last status untouched', async () => {
    const home = makeHome()
    const created = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    await advanceNextRunAt(home, created.id, T0 + 999)
    const item = (await listAutomations(home))[0]
    expect(item?.nextRunAt).toBe(T0 + 999)
    expect(item?.lastStatus).toBeUndefined()
    expect(item?.lastRunAt).toBeUndefined()
    expect(item?.name).toBe('每日早报')
    await advanceNextRunAt(home, 'missing', 1)
    expect(await listAutomations(home)).toHaveLength(1)
  })

  test('issue #2: projectId is optional — defaults to neutral (null) and persists', async () => {
    const home = makeHome()
    const unbound = await createAutomation(home, normalizeAutomationInput(agentInput({ projectId: undefined }), T0), T0)
    expect(unbound.projectId).toBe(null)
    const alsoUnbound = await createAutomation(
      home,
      normalizeAutomationInput(agentInput({ projectId: null, name: '闲聊' }), T0),
      T0,
    )
    expect(alsoUnbound.projectId).toBe(null)
    expect(normalizeAutomationInput(agentInput({ projectId: '' }), T0).projectId).toBe(null)
    const bound = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    expect(bound.projectId).toBe('p1')
    expect(await listAutomations(home)).toHaveLength(3)
    expect((await listAutomations(home, 'p1')).map((item) => item.id)).toEqual([bound.id])
  })

  test('issue #2: updateAutomation ignores projectId — binding is immutable after creation', async () => {
    const home = makeHome()
    const bound = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    const rebound = await updateAutomation(home, bound.id, { projectId: 'p2', name: '改名' }, T0 + 1)
    expect(rebound.projectId).toBe('p1')
    expect(rebound.name).toBe('改名')
    const unbound = await updateAutomation(home, bound.id, { projectId: null }, T0 + 2)
    expect(unbound.projectId).toBe('p1')
    const neutral = await createAutomation(home, normalizeAutomationInput(agentInput({ projectId: undefined }), T0), T0)
    const patched = await updateAutomation(home, neutral.id, { projectId: 'p1' }, T0 + 3)
    expect(patched.projectId).toBe(null)
  })

  test('issue #2: removeAutomationsOfProject leaves unbound automations intact', async () => {
    const home = makeHome()
    const bound = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    const neutral = await createAutomation(
      home,
      normalizeAutomationInput(agentInput({ projectId: null, name: '中立任务' }), T0),
      T0,
    )
    writeRun(home, neutral.id, { runId: 'r1', startedAt: T0, endedAt: T0 + 1, ok: true, output: 'ok' })
    await removeAutomationsOfProject(home, 'p1')
    expect((await listAutomations(home)).map((item) => item.id)).toEqual([neutral.id])
    expect(await recentRuns(home, neutral.id)).toHaveLength(1)
    await expect(removeAutomation(home, bound.id)).rejects.toThrow(/was not found/)
  })

  test('CRUD routes return automation / removed', async () => {
    const home = makeHome()
    const releasedSessions: string[] = []
    const ctx = {
      dshHome: home,
      profileDir: home,
      workspaceRoot: { current: home },
      emit: () => {},
      logger: () => {},
      requestRestart: async () => false,
      runtimeCtx: {
        agents: {
          get: (id: string) => {
            releasedSessions.push(id)
            return undefined
          },
        },
      },
    }
    const create = ROUTE_TABLE.find((route) => route.method === 'automation.create')
    const update = ROUTE_TABLE.find((route) => route.method === 'automation.update')
    const remove = ROUTE_TABLE.find((route) => route.method === 'automation.remove')
    expect(create).toBeDefined()
    expect(update).toBeDefined()
    expect(remove).toBeDefined()

    const created = await create!.handler(
      {
        params: {},
        body: { name: '每日早报', kind: 'agent', schedule: { kind: 'manual' }, prompt: 'hi' },
        query: new URLSearchParams(),
      },
      ctx,
    )
    expect(Object.keys(created as object).sort()).toEqual(['automation'])
    const automation = (created as { automation: AutomationInfo }).automation
    expect(automation.projectId).toBe(null)
    expect(automation.name).toBe('每日早报')

    await expect(
      create!.handler(
        {
          params: {},
          body: { projectId: 'missing', name: 'x', kind: 'agent', schedule: { kind: 'manual' }, prompt: 'x' },
          query: new URLSearchParams(),
        },
        ctx,
      ),
    ).rejects.toThrow(/was not found/)

    const updated = await update!.handler(
      {
        params: {},
        body: { id: automation.id, name: '改名' },
        query: new URLSearchParams(),
      },
      ctx,
    )
    expect(Object.keys(updated as object).sort()).toEqual(['automation'])
    expect((updated as { automation: AutomationInfo }).automation.name).toBe('改名')

    // 运行会话日志随任务删除:路由必须在删目录前把会话交给 releaseSessionRuntime。
    const runSessionId = `huaanwork-auto-${automation.id}-r1`
    const runSessionDir = join(home, 'sessions', 'cwd-x', runSessionId)
    mkdirSync(runSessionDir, { recursive: true })
    expect(existsSync(runSessionDir)).toBe(true)

    const removed = await remove!.handler(
      { params: {}, body: { id: automation.id }, query: new URLSearchParams() },
      ctx,
    )
    expect(removed).toEqual({ removed: true })
    expect(await listAutomations(home)).toEqual([])
    expect(existsSync(runSessionDir)).toBe(false)
    expect(releasedSessions).toEqual([runSessionId])
  })

  test('project.remove releases automation run sessions before deleting their logs', async () => {
    // dshHome 与 profileDir 必须是两个目录:removeAutomationsOfProject 的 sessionsRoot
    // 默认值是 `join(storageRoot, 'sessions')`,而真实会话日志在 `dshHome/sessions`。
    // 若路由漏传显式的 dshHome 根,默认根搜不到 cwd-x 下的运行日志、目录也不会被删,
    // 本用例随之变红（两个目录相同时这个探针会失效）。
    const dshHome = makeHome()
    const profileDir = join(dshHome, 'profiles', 'huaanwork')
    mkdirSync(profileDir, { recursive: true })
    const automation = await createAutomation(profileDir, normalizeAutomationInput(agentInput(), T0), T0)
    writeFileSync(join(profileDir, 'projects.json'), JSON.stringify({
      projects: [{ id: 'p1', name: 'P1', root: join(dshHome, 'p1'), createdAt: T0 }],
    }))

    const runSessionId = `huaanwork-auto-${automation.id}-r1`
    const runSessionDir = join(dshHome, 'sessions', 'cwd-x', runSessionId)
    mkdirSync(runSessionDir, { recursive: true })

    const releasedSessions: string[] = []
    const ctx = {
      dshHome,
      profileDir,
      workspaceRoot: { current: dshHome },
      emit: () => {},
      logger: () => {},
      requestRestart: async () => false,
      runtimeCtx: {
        agents: {
          get: (id: string) => {
            // 释放必须发生在目录还在的时候:路由要把 releaseSession 透传给
            // removeAutomationsOfProject,而不是删完文件再补一次空回调。
            expect(existsSync(join(dshHome, 'sessions', 'cwd-x', id))).toBe(true)
            releasedSessions.push(id)
            return undefined
          },
        },
      },
    }
    const remove = ROUTE_TABLE.find((route) => route.method === 'project.remove')
    expect(remove).toBeDefined()

    const removed = await remove!.handler(
      { params: {}, body: { projectId: 'p1' }, query: new URLSearchParams() },
      ctx,
    )
    expect(removed).toMatchObject({ removed: true })
    // 显式根与回调任一从路由里消失:releasedSessions 为空,且真实日志目录留在原地——
    // 下面两条断言同时变红。
    expect(releasedSessions).toEqual([runSessionId])
    expect(existsSync(runSessionDir)).toBe(false)
    expect(await listAutomations(profileDir)).toEqual([])
  })

  test('markAutomation advances nextRunAt only when entering running', async () => {
    const home = makeHome()
    const created = await createAutomation(
      home,
      normalizeAutomationInput(
        agentInput({ kind: 'script', command: 'true', schedule: { kind: 'interval', minutes: 1 } }),
        T0,
      ),
      T0,
    )
    const startedAt = T0 + 10_000
    await markAutomation(home, created.id, { lastRunAt: startedAt, lastStatus: 'running' })
    const afterStart = (await listAutomations(home)).find((item) => item.id === created.id)
    expect(afterStart?.nextRunAt).toBe(startedAt + 60_000)

    const endedAt = startedAt + 90_000
    await markAutomation(home, created.id, { lastRunAt: endedAt, lastStatus: 'ok' })
    const afterEnd = (await listAutomations(home)).find((item) => item.id === created.id)
    expect(afterEnd?.lastRunAt).toBe(endedAt)
    expect(afterEnd?.lastStatus).toBe('ok')
    expect(afterEnd?.nextRunAt).toBe(startedAt + 60_000)
  })

  test('concurrent appendRun calls keep every record for one automation', async () => {
    const home = makeHome()
    const created = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    const count = 24
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        appendRun(home, created.id, {
          runId: `r${index}`,
          startedAt: T0 + index,
          endedAt: T0 + index + 1,
          ok: true,
          output: `out-${index}`,
          status: 'ok',
          trigger: 'manual',
        }),
      ),
    )
    const runs = await recentRuns(home, created.id, count)
    expect(runs.map((run) => run.runId).sort()).toEqual(Array.from({ length: count }, (_, index) => `r${index}`).sort())
  })
})

describe('schedule.ts (旧 schedule.test.ts 15 例)', () => {
  const localT0 = new Date(2026, 0, 15, 1, 0, 0).getTime()
  const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime()
  const DAY = 24 * 3600_000

  test('parseCron expands all five field forms', () => {
    const all = parseCron('* * * * *')
    expect(all.minute).toEqual(Array.from({ length: 60 }, (_, i) => i))
    expect(all.hour).toEqual(Array.from({ length: 24 }, (_, i) => i))
    expect(all.dom).toBe('*')
    expect(all.month).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
    expect(all.dow).toBe('*')

    const mixed = parseCron('*/15 9-17 1,15 3,6 0,6')
    expect(mixed.minute).toEqual([0, 15, 30, 45])
    expect(mixed.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect(mixed.dom).toEqual([1, 15])
    expect(mixed.month).toEqual([3, 6])
    expect(mixed.dow).toEqual([0, 6])

    expect(parseCron('30 8 * * *').minute).toEqual([30])
    expect(parseCron('30 8 * * *').hour).toEqual([8])
    expect(parseCron('0 0 * * 7').dow).toEqual([0])
    expect(parseCron('0 0 * * 5-7').dow).toEqual([0, 5, 6])
    expect(parseCron('0 0 * * 0,7').dow).toEqual([0])
    expect(parseCron('0 0 * * 6,1,1').dow).toEqual([1, 6])
  })

  test('parseCron rejects unsupported or malformed expressions', () => {
    expect(() => parseCron('')).toThrow(/不能为空/)
    expect(() => parseCron('   ')).toThrow(/不能为空/)
    expect(() => parseCron('0 0 0 0 0 0')).toThrow(/5 个字段/)
    expect(() => parseCron('* * * *')).toThrow(/5 个字段/)
    expect(() => parseCron('0 0 L * *')).toThrow(/不支持/)
    expect(() => parseCron('0 0 15W * *')).toThrow(/不支持/)
    expect(() => parseCron('0 0 ? * *')).toThrow(/不支持/)
    expect(() => parseCron('0 0 * * MON')).toThrow(/不支持/)
    expect(() => parseCron('0 0 * * 1-5/2')).toThrow(/不支持/)
    expect(() => parseCron('*/0 * * * *')).toThrow(/步进/)
    expect(() => parseCron('61 * * * *')).toThrow(/范围/)
    expect(() => parseCron('* 24 * * *')).toThrow(/范围/)
    expect(() => parseCron('* * 0 * *')).toThrow(/范围/)
    expect(() => parseCron('* * * 13 *')).toThrow(/范围/)
    expect(() => parseCron('* * * * 8')).toThrow(/范围/)
  })

  test('nextFireAfter: once returns at only when strictly in the future', () => {
    expect(nextFireAfter({ kind: 'once', at: localT0 + 1000 }, localT0)).toBe(localT0 + 1000)
    expect(nextFireAfter({ kind: 'once', at: localT0 }, localT0)).toBeUndefined()
    expect(nextFireAfter({ kind: 'once', at: localT0 - 1 }, localT0)).toBeUndefined()
  })

  test('nextFireAfter: manual/interval/hourly', () => {
    expect(nextFireAfter({ kind: 'manual' }, localT0)).toBeUndefined()
    expect(nextFireAfter({ kind: 'interval', minutes: 30 }, localT0)).toBe(localT0 + 30 * 60_000)
    expect(nextFireAfter({ kind: 'interval', minutes: 1 }, localT0)).toBe(localT0 + 60_000)
    expect(nextFireAfter({ kind: 'hourly', minute: 30 }, at(2026, 0, 15, 10, 20))).toBe(at(2026, 0, 15, 10, 30))
    expect(nextFireAfter({ kind: 'hourly', minute: 30 }, at(2026, 0, 15, 10, 30))).toBe(at(2026, 0, 15, 11, 30))
    expect(nextFireAfter({ kind: 'hourly', minute: 30 }, at(2026, 0, 15, 10, 40))).toBe(at(2026, 0, 15, 11, 30))
    expect(nextFireAfter({ kind: 'hourly', minute: 5 }, at(2026, 0, 15, 23, 59))).toBe(at(2026, 0, 16, 0, 5))
  })

  test('nextFireAfter: daily keeps the three legacy boundary assertions', () => {
    expect(nextFireAfter({ kind: 'daily', time: '09:30' }, at(2026, 0, 15, 8, 0))).toBe(at(2026, 0, 15, 9, 30))
    expect(nextFireAfter({ kind: 'daily', time: '09:30' }, at(2026, 0, 15, 10, 0))).toBe(at(2026, 0, 15, 9, 30) + DAY)
    expect(nextFireAfter({ kind: 'daily', time: '09:30' }, at(2026, 0, 15, 9, 30))).toBe(at(2026, 0, 15, 9, 30) + DAY)
  })

  test('nextFireAfter: weekly multi-day and sunday normalization', () => {
    const weekly: AutomationSchedule = { kind: 'weekly', days: [1, 4], time: '09:00' }
    expect(nextFireAfter(weekly, at(2026, 0, 15, 10, 0))).toBe(at(2026, 0, 19, 9, 0))
    expect(nextFireAfter(weekly, at(2026, 0, 15, 8, 0))).toBe(at(2026, 0, 15, 9, 0))
    expect(nextFireAfter(weekly, at(2026, 0, 12, 9, 0))).toBe(at(2026, 0, 15, 9, 0))
    expect(nextFireAfter({ kind: 'weekly', days: [7], time: '09:00' }, at(2026, 0, 15, 10, 0))).toBe(at(2026, 0, 18, 9, 0))
  })

  test('nextFireAfter: monthly skips months without the date', () => {
    const monthly: AutomationSchedule = { kind: 'monthly', dates: [31], time: '09:00' }
    expect(nextFireAfter(monthly, at(2026, 0, 31, 10, 0))).toBe(at(2026, 2, 31, 9, 0))
    expect(nextFireAfter(monthly, at(2026, 3, 30, 8, 0))).toBe(at(2026, 4, 31, 9, 0))
    expect(nextFireAfter({ kind: 'monthly', dates: [1, 15], time: '09:00' }, at(2026, 0, 15, 10, 0))).toBe(at(2026, 1, 1, 9, 0))
  })

  test('nextFireAfter: cron 0 9 * * 1-5 walks to the next weekday', () => {
    const cron: AutomationSchedule = { kind: 'cron', expr: '0 9 * * 1-5' }
    expect(nextFireAfter(cron, at(2026, 0, 12, 8, 0))).toBe(at(2026, 0, 12, 9, 0))
    expect(nextFireAfter(cron, at(2026, 0, 12, 10, 0))).toBe(at(2026, 0, 13, 9, 0))
    expect(nextFireAfter(cron, at(2026, 0, 16, 10, 0))).toBe(at(2026, 0, 19, 9, 0))
  })

  test('nextFireAfter: cron dom/dow combination rules (Vixie union)', () => {
    const union: AutomationSchedule = { kind: 'cron', expr: '0 9 13 * 5' }
    expect(nextFireAfter(union, at(2026, 0, 12, 10, 0))).toBe(at(2026, 0, 13, 9, 0))
    expect(nextFireAfter(union, at(2026, 0, 13, 10, 0))).toBe(at(2026, 0, 16, 9, 0))
    expect(nextFireAfter(union, at(2026, 0, 16, 10, 0))).toBe(at(2026, 0, 23, 9, 0))
    expect(nextFireAfter({ kind: 'cron', expr: '0 9 13 * *' }, at(2026, 0, 13, 10, 0))).toBe(at(2026, 1, 13, 9, 0))
    expect(nextFireAfter({ kind: 'cron', expr: '0 9 * * 1' }, at(2026, 0, 12, 9, 0))).toBe(at(2026, 0, 19, 9, 0))
  })

  test('nextFireAfter: cron step/range/list and year boundary', () => {
    expect(nextFireAfter({ kind: 'cron', expr: '*/20 * * * *' }, at(2026, 0, 15, 10, 7))).toBe(at(2026, 0, 15, 10, 20))
    expect(nextFireAfter({ kind: 'cron', expr: '*/20 * * * *' }, at(2026, 0, 15, 10, 20))).toBe(at(2026, 0, 15, 10, 40))
    expect(nextFireAfter({ kind: 'cron', expr: '0 0 1 1 *' }, at(2026, 5, 1, 12, 0))).toBe(at(2027, 0, 1, 0, 0))
  })

  test('nextFireAfter: cron keeps the cursor minute when from carries a seconds component', () => {
    expect(nextFireAfter({ kind: 'cron', expr: '0 9 * * 1-5' }, at(2026, 0, 12, 8, 59) + 30_000)).toBe(at(2026, 0, 12, 9, 0))
    expect(nextFireAfter({ kind: 'cron', expr: '*/20 * * * *' }, at(2026, 0, 15, 10, 19) + 30_000)).toBe(at(2026, 0, 15, 10, 20))
    expect(nextFireAfter({ kind: 'cron', expr: '0 9 * * 1-5' }, at(2026, 0, 12, 9, 0))).toBe(at(2026, 0, 13, 9, 0))
  })

  test('nextFireAfter: impossible cron returns undefined within the 1462-day cap; leap-day cron fires', () => {
    expect(nextFireAfter({ kind: 'cron', expr: '0 0 30 2 *' }, at(2026, 0, 1, 0, 0))).toBeUndefined()
    expect(nextFireAfter({ kind: 'cron', expr: '0 0 29 2 *' }, at(2026, 0, 1, 0, 0))).toBe(at(2028, 1, 29, 0, 0))
    expect(nextFireAfter({ kind: 'cron', expr: '0 0 29 2 *' }, at(2028, 1, 29, 0, 0))).toBe(at(2032, 1, 29, 0, 0))
  })

  test('periodOf derives fixed periods and consecutive-fire diffs', () => {
    expect(periodOf({ kind: 'daily', time: '09:30' })).toBe(DAY)
    expect(periodOf({ kind: 'interval', minutes: 10 })).toBe(10 * 60_000)
    expect(periodOf({ kind: 'hourly', minute: 0 })).toBe(3600_000)
    expect(periodOf({ kind: 'once', at: localT0 })).toBeUndefined()
    expect(periodOf({ kind: 'manual' })).toBeUndefined()
    expect(periodOf({ kind: 'weekly', days: [1, 4], time: '09:00' })).toBe(4 * DAY)
    expect(periodOf({ kind: 'weekly', days: [3], time: '09:00' })).toBe(7 * DAY)
    expect(periodOf({ kind: 'cron', expr: '0 9 * * 1-5' })).toBe(DAY)
    expect(periodOf({ kind: 'monthly', dates: [1], time: '09:00' })).toBe(28 * DAY)
  })

  test('coalescedCount math uses periodOf', () => {
    const count = (schedule: AutomationSchedule, nextRunAt: number, now: number) => {
      const period = periodOf(schedule)
      expect(period).toBeTruthy()
      return Math.floor((now - nextRunAt) / period!) + 1
    }
    expect(count({ kind: 'daily', time: '09:30' }, localT0, localT0 + 3 * DAY - 1)).toBe(3)
    expect(count({ kind: 'interval', minutes: 10 }, localT0, localT0 + 25 * 60_000)).toBe(3)
  })

  test('humanizeCron renders Chinese descriptions', () => {
    expect(humanizeCron('0 10 * * 1')).toBe('每周一 10:00')
    expect(humanizeCron('0 9 * * 1-5')).toBe('每周一、周二、周三、周四、周五 09:00')
    expect(humanizeCron('30 8 * * *')).toBe('每天 08:30')
    expect(humanizeCron('*/15 * * * *')).toBe('每 15 分钟')
    expect(humanizeCron('0 9 13 * 5')).toBe('每月 13 日或每周五 09:00')
    expect(humanizeCron('0 9 13 * *')).toBe('每月 13 日 09:00')
    expect(humanizeCron('0 0 29 2 *')).toBe('每年 2 月 29 日 00:00')
    expect(() => humanizeCron('0 0 * * MON')).toThrow(/不支持/)
  })
})

function runSummary(runId: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId,
    startedAt: T0,
    endedAt: T0 + 1,
    ok: true,
    output: `out-${runId}`,
    status: 'ok',
    trigger: 'schedule',
    ...overrides,
  }
}

describe('automation.deleteRun (Task 9)', () => {
  test('removes one row, releases the session before deleting its directory', async () => {
    const home = makeHome()
    const automation = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    const id = automation.id
    const sessionId = `huaanwork-auto-${id}-r1`
    const sessionDir = join(home, 'sessions', 'cwd-b', sessionId)
    mkdirSync(sessionDir, { recursive: true })
    // 会话目录可能落在任意 cwd 下:扫描不是只看第一个条目。
    mkdirSync(join(home, 'sessions', 'cwd-a'), { recursive: true })
    await appendRun(home, id, runSummary('r1', { endedAt: T0 + 10, sessionId }))
    await appendRun(home, id, runSummary('r2', { startedAt: T0 + 20, endedAt: T0 + 30, ok: false, status: 'error' }))

    const observed: Array<{ sessionId: string; dirExisted: boolean }> = []
    const result = await deleteAutomationRun(home, id, 'r1', {
      sessionsRoot: join(home, 'sessions'),
      releaseSession: (released) => {
        observed.push({ sessionId: released, dirExisted: existsSync(sessionDir) })
      },
    })

    expect(result).toEqual({ removed: true, sessionDirRemoved: true })
    // 释放必须发生在目录还在的时候(session.remove / automation.remove 同序)。
    expect(observed).toEqual([{ sessionId, dirExisted: true }])
    expect(existsSync(sessionDir)).toBe(false)
    expect((await recentRuns(home, id)).map((run) => run.runId)).toEqual(['r2'])
    expect(readFileSync(join(home, 'automations', `${id}.runs.jsonl`), 'utf8').trimEnd().split('\n')).toHaveLength(1)
  })

  test('rejects a runId that is still in the in-flight table', async () => {
    const home = makeHome()
    const automation = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    const id = automation.id
    await appendRun(home, id, runSummary('r1'))

    startInFlightRun({
      automationId: id,
      runId: 'r1',
      trigger: 'manual',
      phase: 'queued',
      cancelRequested: false,
      slotConsumed: false,
    })
    try {
      await expect(deleteAutomationRun(home, id, 'r1', { sessionsRoot: join(home, 'sessions') })).rejects.toThrow(
        '运行中的记录不能删除',
      )
    } finally {
      inFlightRuns.delete('r1')
    }
    // 拒绝发生在删行之前:记录原样保留。
    expect((await recentRuns(home, id)).map((run) => run.runId)).toEqual(['r1'])
  })

  test('rolls lastRunAt/lastStatus back to the latest remaining real run and skips missed', async () => {
    const home = makeHome()
    const automation = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    const id = automation.id
    await appendRun(home, id, runSummary('r1', { startedAt: T0 + 1, endedAt: T0 + 10 }))
    await appendRun(home, id, runSummary('r2', { startedAt: T0 + 20, endedAt: T0 + 30, ok: false, status: 'error' }))
    await appendRun(home, id, runSummary('r3', { startedAt: T0 + 40, endedAt: T0 + 50, ok: false, status: 'missed' }))
    await markAutomation(home, id, { lastRunAt: T0 + 30, lastStatus: 'error' })

    const find = async () => (await listAutomations(home)).find((item) => item.id === id)

    await deleteAutomationRun(home, id, 'r2', { sessionsRoot: join(home, 'sessions') })
    // 剩余最新是 missed 的 r3 ⇒ 跳过它,回退到 r1。
    expect(await find()).toMatchObject({ lastRunAt: T0 + 10, lastStatus: 'ok' })

    await deleteAutomationRun(home, id, 'r1', { sessionsRoot: join(home, 'sessions') })
    // 只剩 missed:两字段都不存在(任务行显示「从未运行」)。
    const cleared = await find()
    expect(cleared?.lastRunAt).toBeUndefined()
    expect(cleared?.lastStatus).toBeUndefined()
  })

  test('leaves both last-run fields untouched when the registry says running', async () => {
    const home = makeHome()
    const automation = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    const id = automation.id
    await appendRun(home, id, runSummary('r1', { endedAt: T0 + 10 }))
    const runningAt = T0 + 500
    await markAutomation(home, id, { lastRunAt: runningAt, lastStatus: 'running' })

    await rewriteLastRunFromRuns(home, id)

    const row = (await listAutomations(home)).find((item) => item.id === id)
    expect(row?.lastRunAt).toBe(runningAt)
    expect(row?.lastStatus).toBe('running')
  })

  test('rewriteLastRunFromRuns rereads the runs file inside the registry lock (no stale snapshot)', async () => {
    const home = makeHome()
    const automation = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    const id = automation.id
    await appendRun(home, id, runSummary('r1', { startedAt: T0 + 1, endedAt: T0 + 10 }))
    await appendRun(home, id, runSummary('r2', { startedAt: T0 + 20, endedAt: T0 + 30, ok: false, status: 'error' }))
    await markAutomation(home, id, { lastRunAt: T0 + 30, lastStatus: 'error' })

    // deleteAutomationRun 自己的回写把基准落到 r1 之后,又有新运行 r3 落盘。
    await deleteAutomationRun(home, id, 'r2', { sessionsRoot: join(home, 'sessions') })
    await appendRun(
      home,
      id,
      runSummary('r3', { startedAt: T0 + 40, endedAt: T0 + 50, ok: false, status: 'cancelled' }),
    )

    await rewriteLastRunFromRuns(home, id)

    const row = (await listAutomations(home)).find((item) => item.id === id)
    // 若用删行时的旧快照回写,这里会停在 r1 的 T0+10。
    expect(row?.lastRunAt).toBe(T0 + 50)
    expect(row?.lastStatus).toBe('error')
  })

  test('is idempotent for a missing row and does not rewrite the registry', async () => {
    const home = makeHome()
    const automation = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    const id = automation.id
    await appendRun(home, id, runSummary('r1', { endedAt: T0 + 10 }))
    await markAutomation(home, id, { lastRunAt: T0 + 10, lastStatus: 'ok' })
    const registryBefore = readFileSync(join(home, 'automations.json'), 'utf8')

    const result = await deleteAutomationRun(home, id, 'no-such-run', { sessionsRoot: join(home, 'sessions') })

    expect(result).toEqual({ removed: false, sessionDirRemoved: true })
    expect(readFileSync(join(home, 'automations.json'), 'utf8')).toBe(registryBefore)
    expect((await recentRuns(home, id)).map((run) => run.runId)).toEqual(['r1'])
  })

  test('treats a missing session directory as already removed', async () => {
    const home = makeHome()
    const automation = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    const id = automation.id
    await appendRun(home, id, runSummary('r1', { sessionId: `huaanwork-auto-${id}-gone` }))

    const result = await deleteAutomationRun(home, id, 'r1', { sessionsRoot: join(home, 'sessions') })

    expect(result).toEqual({ removed: true, sessionDirRemoved: true })
    expect(await recentRuns(home, id)).toEqual([])
  })

  test('keeps the row deleted when removing the session directory fails', async () => {
    const home = makeHome()
    const automation = await createAutomation(home, normalizeAutomationInput(agentInput(), T0), T0)
    const id = automation.id
    const sessionId = `huaanwork-auto-${id}-r1`
    const cwdDir = join(home, 'sessions', 'cwd-x')
    const sessionDir = join(cwdDir, sessionId)
    mkdirSync(sessionDir, { recursive: true })
    await appendRun(home, id, runSummary('r1', { endedAt: T0 + 10, sessionId }))

    chmodSync(cwdDir, 0o555)
    let result: Awaited<ReturnType<typeof deleteAutomationRun>>
    try {
      result = await deleteAutomationRun(home, id, 'r1', { sessionsRoot: join(home, 'sessions') })
    } finally {
      chmodSync(cwdDir, 0o755)
    }

    expect(result).toEqual({ removed: true, sessionDirRemoved: false })
    // 删行成功优先:目录还在,列表里已没有这一条。
    expect(existsSync(sessionDir)).toBe(true)
    expect(await recentRuns(home, id)).toEqual([])
  })

  test('rewriteLastRunFromRuns silently ignores a missing automation', async () => {
    const home = makeHome()
    await expect(rewriteLastRunFromRuns(home, 'missing')).resolves.toBeUndefined()
    expect(await listAutomations(home)).toEqual([])
  })

  test('automation.deleteRun route releases the session before deleting its directory', async () => {
    // dshHome 与 profileDir 分列:路由必须把 dshHome/sessions 作为会话根传入,
    // 用默认的 profileDir/sessions 会找不到目录,本用例随之变红。
    const dshHome = makeHome()
    const profileDir = join(dshHome, 'profiles', 'huaanwork')
    mkdirSync(profileDir, { recursive: true })
    const automation = await createAutomation(profileDir, normalizeAutomationInput(agentInput(), T0), T0)
    const sessionId = `huaanwork-auto-${automation.id}-r1`
    const runSessionDir = join(dshHome, 'sessions', 'cwd-x', sessionId)
    mkdirSync(runSessionDir, { recursive: true })
    await appendRun(profileDir, automation.id, runSummary('r1', { endedAt: T0 + 10, sessionId }))
    await markAutomation(profileDir, automation.id, { lastRunAt: T0 + 10, lastStatus: 'ok' })

    const releasedSessions: string[] = []
    const ctx = {
      dshHome,
      profileDir,
      workspaceRoot: { current: dshHome },
      emit: () => {},
      logger: () => {},
      requestRestart: async () => false,
      runtimeCtx: {
        agents: {
          get: (id: string) => {
            // 释放必须发生在目录还在的时候:路由要把 releaseSession 透传给 deleteAutomationRun。
            expect(existsSync(join(dshHome, 'sessions', 'cwd-x', id))).toBe(true)
            releasedSessions.push(id)
            return undefined
          },
        },
      },
    }
    const route = ROUTE_TABLE.find((entry) => entry.method === 'automation.deleteRun')
    expect(route).toBeDefined()

    const result = await route!.handler(
      { params: {}, body: { id: automation.id, runId: 'r1' }, query: new URLSearchParams() },
      ctx,
    )

    expect(result).toEqual({ removed: true, sessionDirRemoved: true })
    expect(releasedSessions).toEqual([sessionId])
    expect(existsSync(runSessionDir)).toBe(false)
    const row = (await listAutomations(profileDir)).find((item) => item.id === automation.id)
    expect(row?.lastRunAt).toBeUndefined()
    expect(row?.lastStatus).toBeUndefined()
  })
})
