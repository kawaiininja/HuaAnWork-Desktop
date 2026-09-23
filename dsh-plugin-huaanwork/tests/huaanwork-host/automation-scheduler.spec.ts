/**
 * 调度器 tick(Task 5)。间隔只走 HUAANWORK_AUTOMATION_TICK_MS,不睡 60 秒。
 * agent 回合用进程内 double,不 boot lib/。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import type { AutomationInfo, RpcEvent } from '../../src/client-huaanwork/rpc-types.ts'
import { startAutomationScheduler } from '../../src/huaanwork-host/automation-scheduler.ts'
import {
  MISSING_PROJECT_OUTPUT,
  automationTail,
  bindAutomationRuntime,
  type AutomationRuntime,
} from '../../src/huaanwork-host/automations-host.ts'
import {
  MISSED_GRACE_MS,
  advanceNextRunAt,
  createAutomation,
  markAutomation,
  normalizeAutomationInput,
} from '../../src/huaanwork-host/automations-store.ts'
import type { RouteContext } from '../../src/huaanwork-host/routes.ts'
import { sessionIdFor } from '../../src/huaanwork-host/session-id.ts'
import { sessionSendBlockers, type ListedAgent } from '../../src/huaanwork-host/sessions.ts'
import { createProject, findAutomation, listAutomations, recentRuns } from '../../src/huaanwork-host/stores.ts'
import { neutralWorkspaceRoot } from '../../src/huaanwork-host/workspace-state.ts'

const previousTick = process.env.HUAANWORK_AUTOMATION_TICK_MS
const dirs: string[] = []
const stops: Array<() => void> = []
const live: Harness[] = []

type Harness = {
  profileDir: string
  neutral: string
  events: RpcEvent[]
  followups: string[]
  runtime: AutomationRuntime
  routeCtx: RouteContext
  release: () => void
  hang: () => void
  installUserAgent: (whenIdle: () => Promise<void>) => void
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function makeHarness(current?: string): Harness {
  const profileDir = mkdtempSync(join(tmpdir(), 'hw-sched-profile-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'hw-sched-dsh-'))
  dirs.push(profileDir, dshHome)
  const neutral = neutralWorkspaceRoot(profileDir)
  const events: RpcEvent[] = []
  const followups: string[] = []
  const releases = new Map<string, () => void>()
  const agents = new Map<string, ListedAgent>()
  let hang = false
  const box: { routeCtx?: RouteContext } = {}
  const runtime = {
    huaanworkApprovals: new Map(),
    huaanworkUnattended: { current: undefined },
    agents: {
      async create(options: { sessionId: string }) {
        const sessionId = options.sessionId
        let idle = Promise.resolve()
        const agent: ListedAgent = {
          id: sessionId,
          session: { id: sessionId },
          followup(message: unknown) {
            followups.push(readText(message))
            if (!hang) {
              box.routeCtx?.emit({ event: 'token', text: 'stub-output', sessionId })
              return
            }
            idle = new Promise<void>((resolve) => {
              releases.set(sessionId, resolve)
            })
          },
          cancel() {
            releases.get(sessionId)?.()
          },
          whenIdle: () => idle,
        }
        agents.set(sessionId, agent)
        return agent
      },
      get: (id: string) => agents.get(id),
      list: () => [...agents.values()],
    },
  } as AutomationRuntime
  const routeCtx: RouteContext = {
    dshHome,
    profileDir,
    workspaceRoot: { current: current ?? neutral },
    emit(event) {
      events.push(event)
    },
    logger() {},
    runtimeCtx: runtime,
    requestRestart: async () => false,
  }
  box.routeCtx = routeCtx
  const harness: Harness = {
    profileDir,
    neutral,
    events,
    followups,
    runtime,
    routeCtx,
    release() {
      hang = false
      for (const resolve of releases.values()) resolve()
      releases.clear()
    },
    hang() {
      hang = true
    },
    installUserAgent(whenIdle) {
      const sessionId = sessionIdFor(routeCtx.workspaceRoot.current)
      agents.set(sessionId, {
        id: sessionId,
        session: { id: sessionId },
        followup() {},
        whenIdle,
      })
    },
  }
  live.push(harness)
  return harness
}

function readText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: Array<{ text?: string }> }).content
  return content?.[0]?.text ?? ''
}

function start(h: Harness, opts?: { disabled?: boolean }): void {
  bindAutomationRuntime(h.runtime, h.routeCtx)
  stops.push(startAutomationScheduler(h.runtime, h.routeCtx, opts))
}

function useTick(ms: number): void {
  process.env.HUAANWORK_AUTOMATION_TICK_MS = String(ms)
}

async function poll(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`poll timed out after ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

function runEvents(events: RpcEvent[], name: string, automationId: string): RpcEvent[] {
  return events.filter((event) => {
    if (!('automationId' in event)) return false
    return event.event === name && event.automationId === automationId
  })
}

async function makeTask(
  profileDir: string,
  patch: Record<string, unknown>,
): Promise<AutomationInfo> {
  return createAutomation(
    profileDir,
    normalizeAutomationInput({
      name: '任务',
      kind: 'script',
      schedule: { kind: 'interval', minutes: 1 },
      command: `${quote(process.execPath)} -e ${quote('process.stdout.write("tick-ok")')}`,
      ...patch,
    }),
  )
}

async function arm(profileDir: string, id: string, nextRunAt: number): Promise<void> {
  await advanceNextRunAt(profileDir, id, nextRunAt)
}

afterEach(async () => {
  for (const stop of stops.splice(0)) stop()
  for (const harness of live.splice(0)) harness.release()
  await Promise.race([automationTail, new Promise((resolve) => setTimeout(resolve, 3_000))])
  sessionSendBlockers.workspaceDisplaced = false
  sessionSendBlockers.agentAutomationQueued = 0
  sessionSendBlockers.agentAutomationActive = 0
  if (previousTick === undefined) delete process.env.HUAANWORK_AUTOMATION_TICK_MS
  else process.env.HUAANWORK_AUTOMATION_TICK_MS = previousTick
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

test('empty registry ticks do not write or displace the workspace', async () => {
  useTick(20)
  const h = makeHarness()
  start(h)
  await new Promise((resolve) => setTimeout(resolve, 120))
  expect(h.events).toEqual([])
  expect(await listAutomations(h.profileDir)).toEqual([])
  expect(sessionSendBlockers.workspaceDisplaced).toBe(false)
})

test('tick interval 0 and config disabled do not fire a due task', async () => {
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '同根' })
  const due = await makeTask(h.profileDir, { projectId: project.id, name: '到期' })
  await arm(h.profileDir, due.id, Date.now() - 1_000)

  useTick(0)
  start(h)
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(runEvents(h.events, 'automation/run-start', due.id)).toHaveLength(0)

  useTick(20)
  start(h, { disabled: true })
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(runEvents(h.events, 'automation/run-start', due.id)).toHaveLength(0)
  expect((await findAutomation(h.profileDir, due.id)).enabled).toBe(true)
  expect(sessionSendBlockers.workspaceDisplaced).toBe(false)
})

test('same-root due agents enqueue through the serial tail, grouped together', async () => {
  useTick(20)
  const h = makeHarness()
  h.hang()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '同根' })
  const first = await makeTask(h.profileDir, {
    projectId: project.id,
    kind: 'agent',
    prompt: '先做',
    name: '先做',
  })
  const second = await makeTask(h.profileDir, {
    projectId: project.id,
    kind: 'agent',
    prompt: '后做',
    name: '后做',
  })
  await arm(h.profileDir, first.id, Date.now() - 1_000)
  await arm(h.profileDir, second.id, Date.now() - 1_000)
  start(h)

  await poll(() => h.followups.length === 1 && sessionSendBlockers.agentAutomationQueued === 2)
  expect(h.followups[0]).toContain('<automation-fire')
  expect(h.followups[0]).toContain('trigger="schedule"')
  expect(sessionSendBlockers.workspaceDisplaced).toBe(false)
  h.release()
  await poll(() => runEvents(h.events, 'automation/run-end', second.id).length === 1)
  expect(h.followups).toHaveLength(2)
  const stored = await findAutomation(h.profileDir, first.id)
  expect(stored.lastStatus).toBe('ok')
  expect(stored.nextRunAt).toBeGreaterThan(Date.now())
})

test('cross-root due stays due and a deleted project still runs', async () => {
  useTick(20)
  const h = makeHarness()
  const elsewhere = mkdtempSync(join(tmpdir(), 'hw-sched-other-'))
  dirs.push(elsewhere)
  const other = await createProject(h.profileDir, { root: elsewhere, name: '别处' })
  const cross = await makeTask(h.profileDir, { projectId: other.id, name: '跨根' })
  const missing = await makeTask(h.profileDir, { projectId: 'deleted-project', name: '已删项目' })
  const crossAt = Date.now() - 1_000
  await arm(h.profileDir, cross.id, crossAt)
  await arm(h.profileDir, missing.id, Date.now() - 1_000)
  start(h)

  await poll(() => runEvents(h.events, 'automation/run-end', missing.id).length === 1)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const ended = runEvents(h.events, 'automation/run-end', missing.id)[0]
  expect(ended).toMatchObject({ ok: false })
  expect((await recentRuns(h.profileDir, missing.id))[0]?.output).toBe(MISSING_PROJECT_OUTPUT)
  const kept = await findAutomation(h.profileDir, cross.id)
  expect(kept.enabled).toBe(true)
  expect(kept.nextRunAt).toBe(crossAt)
  expect(runEvents(h.events, 'automation/run-start', cross.id)).toHaveLength(0)
  expect(sessionSendBlockers.workspaceDisplaced).toBe(false)
})

test('missed skip records a run, run-once catchup enqueues, cross-root catchup does not', async () => {
  useTick(20)
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '同根' })
  const elsewhere = mkdtempSync(join(tmpdir(), 'hw-sched-other-'))
  dirs.push(elsewhere)
  const other = await createProject(h.profileDir, { root: elsewhere, name: '别处' })
  const skipped = await makeTask(h.profileDir, { projectId: project.id, name: '跳过', missedPolicy: 'skip' })
  const catchup = await makeTask(h.profileDir, { projectId: project.id, name: '补跑', missedPolicy: 'run-once' })
  const remote = await makeTask(h.profileDir, { projectId: other.id, name: '跨根补跑', missedPolicy: 'run-once' })
  const stale = Date.now() - MISSED_GRACE_MS - 5_000
  await arm(h.profileDir, skipped.id, stale)
  await arm(h.profileDir, catchup.id, stale)
  await arm(h.profileDir, remote.id, stale)
  start(h)

  await poll(() => runEvents(h.events, 'automation/run-end', catchup.id).length === 1)
  await poll(() => runEvents(h.events, 'automation/missed', skipped.id).length >= 1)
  await poll(() => runEvents(h.events, 'automation/missed', remote.id).length >= 1)
  await new Promise((resolve) => setTimeout(resolve, 60))

  const skippedRun = (await recentRuns(h.profileDir, skipped.id)).at(-1)
  expect(skippedRun).toMatchObject({ status: 'missed', trigger: 'schedule' })
  expect(runEvents(h.events, 'automation/run-start', skipped.id)).toHaveLength(0)
  expect((await findAutomation(h.profileDir, skipped.id)).nextRunAt).toBeGreaterThan(Date.now() - 1_000)

  const catchupRun = (await recentRuns(h.profileDir, catchup.id)).at(-1)
  expect(catchupRun).toMatchObject({ trigger: 'catchup', ok: true })
  expect(catchupRun?.coalescedCount).toBeGreaterThan(0)
  const missed = runEvents(h.events, 'automation/missed', catchup.id)[0]
  expect(missed).toMatchObject({ event: 'automation/missed' })

  expect(runEvents(h.events, 'automation/run-start', remote.id)).toHaveLength(0)
  expect(await recentRuns(h.profileDir, remote.id)).toEqual([])
  expect((await findAutomation(h.profileDir, remote.id)).nextRunAt).toBe(stale)
  expect(runEvents(h.events, 'automation/missed', remote.id)).toHaveLength(1)
  expect(sessionSendBlockers.workspaceDisplaced).toBe(false)
})

test('cross-root run-once catchup emits missed once per scheduler and does not advance or enqueue', async () => {
  useTick(20)
  const h = makeHarness()
  const elsewhere = mkdtempSync(join(tmpdir(), 'hw-sched-other-'))
  dirs.push(elsewhere)
  const other = await createProject(h.profileDir, { root: elsewhere, name: '别处' })
  const remote = await makeTask(h.profileDir, { projectId: other.id, name: '跨根补跑一次', missedPolicy: 'run-once' })
  const stale = Date.now() - MISSED_GRACE_MS - 5_000
  await arm(h.profileDir, remote.id, stale)
  start(h)

  await poll(() => runEvents(h.events, 'automation/missed', remote.id).length === 1)
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(runEvents(h.events, 'automation/missed', remote.id)).toHaveLength(1)
  expect(runEvents(h.events, 'automation/run-start', remote.id)).toHaveLength(0)
  expect(await recentRuns(h.profileDir, remote.id)).toEqual([])
  expect((await findAutomation(h.profileDir, remote.id)).nextRunAt).toBe(stale)

  for (const stop of stops.splice(0)) stop()
  h.events.length = 0
  start(h)
  await poll(() => runEvents(h.events, 'automation/missed', remote.id).length === 1)
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(runEvents(h.events, 'automation/missed', remote.id)).toHaveLength(1)
  expect(runEvents(h.events, 'automation/run-start', remote.id)).toHaveLength(0)
  expect((await findAutomation(h.profileDir, remote.id)).nextRunAt).toBe(stale)

  for (const stop of stops.splice(0)) stop()
  h.events.length = 0
  h.routeCtx.workspaceRoot.current = elsewhere
  start(h)
  await poll(() => runEvents(h.events, 'automation/run-end', remote.id).length === 1)
  const catchupRun = (await recentRuns(h.profileDir, remote.id)).at(-1)
  expect(catchupRun).toMatchObject({ trigger: 'catchup', ok: true })
  expect((await findAutomation(h.profileDir, remote.id)).nextRunAt).toBeGreaterThan(stale)
  expect(sessionSendBlockers.workspaceDisplaced).toBe(false)
})

test('expired tasks disable without a missed record, and a missed once disables itself', async () => {
  useTick(20)
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '同根' })
  const expired = await makeTask(h.profileDir, {
    projectId: project.id,
    name: '过期',
    expiresAt: Date.now() - 1,
  })
  const once = await makeTask(h.profileDir, {
    projectId: project.id,
    name: '一次',
    schedule: { kind: 'once', at: Date.now() + 60_000 },
  })
  await arm(h.profileDir, expired.id, Date.now() - MISSED_GRACE_MS - 5_000)
  await arm(h.profileDir, once.id, Date.now() - MISSED_GRACE_MS - 5_000)
  start(h)

  await poll(async () => (await findAutomation(h.profileDir, expired.id)).enabled === false)
  await poll(async () => (await findAutomation(h.profileDir, once.id)).enabled === false)
  expect(await recentRuns(h.profileDir, expired.id)).toEqual([])
  expect(runEvents(h.events, 'automation/run-start', expired.id)).toHaveLength(0)
  const onceRun = (await recentRuns(h.profileDir, once.id)).at(-1)
  expect(onceRun).toMatchObject({ status: 'missed' })
  expect(onceRun?.output).toContain('自动停用')
  expect(runEvents(h.events, 'automation/run-start', once.id)).toHaveLength(0)
})

test('a new scheduler cancels residual running rows and leaves this generation alone', async () => {
  useTick(20)
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '同根' })
  const residual = await makeTask(h.profileDir, { projectId: project.id, name: '残留', schedule: { kind: 'manual' } })
  const current = await makeTask(h.profileDir, { projectId: project.id, name: '本代', schedule: { kind: 'manual' } })
  await markAutomation(h.profileDir, residual.id, { lastRunAt: Date.now() - 10_000, lastStatus: 'running' })
  start(h)
  await markAutomation(h.profileDir, current.id, { lastRunAt: Date.now(), lastStatus: 'running' })

  await poll(async () => (await recentRuns(h.profileDir, residual.id)).some((run) => run.status === 'cancelled'))
  await new Promise((resolve) => setTimeout(resolve, 80))
  const cancelled = (await recentRuns(h.profileDir, residual.id)).at(-1)
  expect(cancelled).toMatchObject({ status: 'cancelled', ok: false })
  expect(cancelled?.output).toContain('上次运行被中断')
  expect((await findAutomation(h.profileDir, residual.id)).lastStatus).toBe('error')
  expect(await recentRuns(h.profileDir, current.id)).toEqual([])
  expect((await findAutomation(h.profileDir, current.id)).lastStatus).toBe('running')
})

test('agentIdle between groups keeps the later group due', { timeout: 10_000 }, async () => {
  useTick(20)
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '同根' })
  const grouped = await makeTask(h.profileDir, { projectId: project.id, name: '同组' })
  const neutralTask = await makeTask(h.profileDir, { projectId: null, name: '中立下一组' })
  const dueAt = Date.now() - 1_000
  await arm(h.profileDir, grouped.id, dueAt)
  await arm(h.profileDir, neutralTask.id, dueAt)
  let idleCalls = 0
  h.installUserAgent(() => {
    idleCalls += 1
    if (idleCalls >= 3) return new Promise(() => {})
    return Promise.resolve()
  })
  start(h)

  await poll(() => runEvents(h.events, 'automation/run-end', grouped.id).length === 1)
  await poll(() => idleCalls >= 3, 3_000)
  for (const stop of stops.splice(0)) stop()
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  expect(runEvents(h.events, 'automation/run-start', neutralTask.id)).toHaveLength(0)
  expect((await findAutomation(h.profileDir, neutralTask.id)).nextRunAt).toBe(dueAt)
  expect(sessionSendBlockers.workspaceDisplaced).toBe(false)
})

test('neutral tasks run when the current root is the neutral root', async () => {
  useTick(20)
  const h = makeHarness()
  mkdirSync(h.neutral, { recursive: true })
  const task = await makeTask(h.profileDir, { projectId: null, name: '中立' })
  await arm(h.profileDir, task.id, Date.now() - 1_000)
  start(h)
  await poll(() => runEvents(h.events, 'automation/run-end', task.id).length === 1)
  expect((await recentRuns(h.profileDir, task.id))[0]?.output).toBe('tick-ok')
  expect(sessionSendBlockers.workspaceDisplaced).toBe(false)
})
