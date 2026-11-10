/**
 * 调度器 tick(Task 5/8)。间隔只走 HUAANWORK_AUTOMATION_TICK_MS,不睡 60 秒。
 * agent 回合用进程内 double,不 boot lib/。Task 8 起直接入队的用例先准入:
 * enqueueAutomation 只执行已经占坑的运行,调度 tick 与 automation.run 才是准入点。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

import type { AutomationInfo, RpcEvent } from '../../src/client-huaanwork/rpc-types.ts'
import { inFlightRuns } from '../../src/huaanwork-host/automation-inflight.ts'
import { automationRunSessionId } from '../../src/huaanwork-host/automation-session-ids.ts'
import {
  evaluateDueAutomations,
  recoverInterruptedAutomation,
  startAutomationScheduler,
} from '../../src/huaanwork-host/automation-scheduler.ts'
import {
  MISSING_PROJECT_OUTPUT,
  automationAdmissionRoot,
  bindAutomationRuntime,
  enqueueAutomation,
  type AutomationRuntime,
  type AutomationTrigger,
} from '../../src/huaanwork-host/automations-host.ts'
import {
  MISSED_GRACE_MS,
  advanceNextRunAt,
  appendRun,
  createAutomation,
  markAutomation,
  normalizeAutomationInput,
} from '../../src/huaanwork-host/automations-store.ts'
import type { RouteContext } from '../../src/huaanwork-host/routes.ts'
import { freshSessionIdFor } from '../../src/huaanwork-host/session-id.ts'
import {
  sessionSend,
  setReevaluateDueAutomations,
  type ListedAgent,
} from '../../src/huaanwork-host/sessions.ts'
import {
  createAutomationRunTask,
  createProject,
  findAutomation,
  listAutomations,
  recentRuns,
  runsPath,
} from '../../src/huaanwork-host/stores.ts'
import { createTurnScheduler, type TurnScheduler } from '../../src/huaanwork-host/turn-scheduler.ts'
import { neutralWorkspaceRoot } from '../../src/huaanwork-host/workspace-state.ts'

const previousTick = process.env.HUAANWORK_AUTOMATION_TICK_MS
const dirs: string[] = []
const stops: Array<() => void> = []
const live: Harness[] = []
const scriptSlotWaiters: Array<() => void> = []

type State = { maxConcurrentTurns: number }

type Harness = {
  profileDir: string
  neutral: string
  events: RpcEvent[]
  followups: string[]
  runtime: AutomationRuntime
  routeCtx: RouteContext
  scheduler: TurnScheduler
  state: State
  releaseFiles: string[]
  release: (sessionId?: string) => void
  hang: () => void
  installUserAgent: (whenIdle: () => Promise<void>, sessionId?: string) => void
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
  const state: State = { maxConcurrentTurns: 3 }
  let hang = false
  const box: { routeCtx?: RouteContext } = {}
  const runtime = {
    huaanworkApprovals: new Map(),
    huaanworkUnattended: new Map(),
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
  bindAutomationRuntime(runtime, routeCtx)
  const scheduler = createTurnScheduler({
    maxConcurrentTurns: () => state.maxConcurrentTurns,
    modelExists: () => true,
  })
  runtime.huaanworkTurnScheduler = scheduler
  runtime.huaanworkSessionModels = new Map()
  runtime.huaanworkSessionRoots = new Map()
  const harness: Harness = {
    profileDir,
    neutral,
    events,
    followups,
    runtime,
    routeCtx,
    scheduler,
    state,
    releaseFiles: [],
    release(sessionId?: string) {
      if (sessionId === undefined) hang = false
      const ids = sessionId === undefined ? [...releases.keys()] : [sessionId]
      for (const id of ids) releases.get(id)?.()
    },
    hang() {
      hang = true
    },
    installUserAgent(whenIdle, sessionId) {
      const id = sessionId ?? `huaanwork-user-${agents.size}`
      let resolveIdle: (() => void) | undefined
      const idle = new Promise<void>((resolve) => {
        resolveIdle = resolve
      })
      // 工厂只用于观察/计数;占位由 h.release() 显式解除。
      void whenIdle()
      releases.set(id, () => resolveIdle?.())
      agents.set(id, {
        id,
        session: { id },
        followup() {},
        whenIdle: () => idle,
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
  setReevaluateDueAutomations(() => {
    void evaluateDueAutomations()
  })
  stops.push(startAutomationScheduler(h.runtime, h.routeCtx, opts))
}

function useTick(ms: number): void {
  process.env.HUAANWORK_AUTOMATION_TICK_MS = String(ms)
}

function holdCommand(mark: string, release: string): string {
  const script =
    'const fs=require("node:fs"); fs.writeFileSync(process.env.MARK,"1"); const end=Date.now()+8000; while(!fs.existsSync(process.env.RELEASE)&&Date.now()<end){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,40)}'
  return `MARK=${quote(mark)} RELEASE=${quote(release)} ${quote(process.execPath)} -e ${quote(script)}`
}

function cwdCommand(): string {
  return `${quote(process.execPath)} -e ${quote('process.stdout.write(process.cwd())')}`
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

/**
 * 自管准入的执行:直接入队前先占坑(调度 tick 与 automation.run 之外的唯一测试路径)。
 * 根与生产同源:项目根,或该任务自己的 workspace-automations 根(纯路径,不建目录)。
 */
async function admitAndEnqueue(
  h: Harness,
  automation: AutomationInfo,
  opts: { trigger: AutomationTrigger; runId?: string; coalescedCount?: number },
): Promise<{ runId: string; root: string; done: Promise<void> }> {
  const runId = opts.runId ?? randomUUID()
  const root = await automationAdmissionRoot(h.routeCtx, automation)
  const sessionId =
    automation.kind === 'agent' ? automationRunSessionId(automation.id, runId) : `script:${runId}`
  const admitted = h.scheduler.admitAutomation({
    automationId: automation.id,
    sessionId,
    root,
    runId,
    countsTowardCap: automation.kind === 'agent',
  })
  expect(admitted).toEqual({ kind: 'start', root })
  const done = enqueueAutomation(automation, {
    trigger: opts.trigger,
    runId,
    root,
    ...(opts.coalescedCount === undefined ? {} : { coalescedCount: opts.coalescedCount }),
  })
  return { runId, root, done }
}

afterEach(async () => {
  for (const stop of stops.splice(0)) stop()
  for (const harness of live.splice(0)) {
    harness.release()
    for (const file of harness.releaseFiles) {
      try {
        writeFileSync(file, '1')
      } catch {
        // 目录可能已不在;槽位脚本最多再等到自身超时。
      }
    }
  }
  setReevaluateDueAutomations(undefined)
  const deadline = Date.now() + 3_000
  while ((inFlightRuns.size > 0 || scriptSlotWaiters.length > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  inFlightRuns.clear()
  if (previousTick === undefined) delete process.env.HUAANWORK_AUTOMATION_TICK_MS
  else process.env.HUAANWORK_AUTOMATION_TICK_MS = previousTick
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})
test('scheduler tick records a missed run for stale automations without executing', async () => {
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
  await poll(() => runEvents(h.events, 'automation/run-end', remote.id).length === 1)
  await poll(() => runEvents(h.events, 'automation/missed', skipped.id).length >= 1)
  await new Promise((resolve) => setTimeout(resolve, 60))

  const skippedRun = (await recentRuns(h.profileDir, skipped.id)).at(-1)
  expect(skippedRun).toMatchObject({ status: 'missed', trigger: 'schedule' })
  expect(runEvents(h.events, 'automation/run-start', skipped.id)).toHaveLength(0)
  expect((await findAutomation(h.profileDir, skipped.id)).nextRunAt).toBeGreaterThan(Date.now() - 1_000)

  const catchupRun = (await recentRuns(h.profileDir, catchup.id)).at(-1)
  expect(catchupRun).toMatchObject({ trigger: 'catchup', ok: true })
  expect(catchupRun?.coalescedCount).toBeGreaterThan(0)
  expect(runEvents(h.events, 'automation/missed', catchup.id)).toHaveLength(1)

  const remoteRun = (await recentRuns(h.profileDir, remote.id)).at(-1)
  expect(remoteRun).toMatchObject({ trigger: 'catchup', ok: true })
  expect((await findAutomation(h.profileDir, remote.id)).nextRunAt).toBeGreaterThan(stale)
  expect(runEvents(h.events, 'automation/missed', remote.id)).toHaveLength(1)
})

test('empty registry ticks do not write or displace the workspace', async () => {
  useTick(20)
  const h = makeHarness()
  start(h)
  await new Promise((resolve) => setTimeout(resolve, 120))
  expect(h.events).toEqual([])
  expect(await listAutomations(h.profileDir)).toEqual([])
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
})

test('same-root due agents start one at a time and the other stays due until release', async () => {
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
  const dueAt = Date.now() - 1_000
  await arm(h.profileDir, first.id, dueAt)
  await arm(h.profileDir, second.id, dueAt)
  start(h)

  await poll(() => h.followups.length === 1)
  expect(h.followups[0]).toContain('<automation-fire')
  expect(h.followups[0]).toContain('trigger="schedule"')
  // 同根第二条不 followup、保持到期、不落 missed。
  expect(runEvents(h.events, 'automation/run-start', second.id)).toHaveLength(0)
  expect((await findAutomation(h.profileDir, second.id)).nextRunAt).toBe(dueAt)
  expect((await recentRuns(h.profileDir, second.id)).some((run) => run.status === 'missed')).toBe(false)

  h.release()
  await poll(() => h.followups.length === 2 && runEvents(h.events, 'automation/run-end', second.id).length === 1)
  const stored = await findAutomation(h.profileDir, first.id)
  expect(stored.lastStatus).toBe('ok')
  expect(stored.nextRunAt).toBeGreaterThan(Date.now())
})

test('a due task on another project root runs there, and a deleted project still records its failure', async () => {
  useTick(20)
  const h = makeHarness()
  const elsewhere = mkdtempSync(join(tmpdir(), 'hw-sched-other-'))
  dirs.push(elsewhere)
  const other = await createProject(h.profileDir, { root: elsewhere, name: '别处' })
  const cross = await makeTask(h.profileDir, { projectId: other.id, name: '跨根', command: cwdCommand() })
  const missing = await makeTask(h.profileDir, { projectId: 'deleted-project', name: '已删项目' })
  await arm(h.profileDir, cross.id, Date.now() - 1_000)
  await arm(h.profileDir, missing.id, Date.now() - 1_000)
  start(h)

  await poll(() => runEvents(h.events, 'automation/run-end', cross.id).length === 1)
  await poll(() => runEvents(h.events, 'automation/run-end', missing.id).length === 1)
  expect((await recentRuns(h.profileDir, cross.id))[0]?.output).toBe(await realpath(elsewhere))
  const ended = runEvents(h.events, 'automation/run-end', missing.id)[0]
  expect(ended).toMatchObject({ ok: false })
  expect((await recentRuns(h.profileDir, missing.id))[0]?.output).toBe(MISSING_PROJECT_OUTPUT)
  expect(h.routeCtx.workspaceRoot.current).toBe(h.neutral)
})

test('catchup waits for the root writer and the concurrent cap', { timeout: 15_000 }, async () => {
  useTick(20)
  const h = makeHarness()
  h.state.maxConcurrentTurns = 1
  h.hang()
  const elsewhere = mkdtempSync(join(tmpdir(), 'hw-sched-busy-'))
  dirs.push(elsewhere)
  const other = await createProject(h.profileDir, { root: elsewhere, name: '占用' })
  const capProject = await createProject(h.profileDir, { root: h.neutral, name: '名额' })
  const catchup = await makeTask(h.profileDir, {
    projectId: other.id,
    kind: 'agent',
    prompt: '补跑',
    name: '补跑',
    missedPolicy: 'run-once',
  })
  const holder = await makeTask(h.profileDir, {
    projectId: capProject.id,
    kind: 'agent',
    prompt: '占名额',
    name: '占名额',
    schedule: { kind: 'manual' },
  })
  const mark = join(elsewhere, 'catchup-script-mark')
  const release = join(elsewhere, 'catchup-script-release')
  h.releaseFiles.push(release)
  // 脚本写者占住 catchup 的根,但不占并发名额。
  const script = await makeTask(h.profileDir, {
    projectId: other.id,
    name: '占根脚本',
    schedule: { kind: 'manual' },
    command: holdCommand(mark, release),
  })
  const stale = Date.now() - MISSED_GRACE_MS - 5_000
  await arm(h.profileDir, catchup.id, stale)

  const scriptRun = await admitAndEnqueue(h, script, { trigger: 'manual' })
  await poll(() => existsSync(mark))
  const { runId: holderRunId } = await admitAndEnqueue(h, holder, { trigger: 'manual' })
  await poll(() => h.followups.length === 1)
  start(h)

  // 根上有写者且名额已满:逾期 run-once 不执行、不记失败运行、不推进。
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(runEvents(h.events, 'automation/run-start', catchup.id)).toHaveLength(0)
  expect(await recentRuns(h.profileDir, catchup.id)).toEqual([])
  expect((await findAutomation(h.profileDir, catchup.id)).nextRunAt).toBe(stale)

  // 释放根写者后名额仍被占用:继续跳过,仍不落 missed。
  writeFileSync(release, '1')
  await poll(() => runEvents(h.events, 'automation/run-end', script.id).length === 1)
  await scriptRun.done
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(runEvents(h.events, 'automation/run-start', catchup.id)).toHaveLength(0)
  expect((await recentRuns(h.profileDir, catchup.id)).some((run) => run.status === 'missed')).toBe(false)
  expect((await findAutomation(h.profileDir, catchup.id)).nextRunAt).toBe(stale)

  // 名额释放后的后续 tick 才补跑。
  h.release(automationRunSessionId(holder.id, holderRunId))
  await poll(() => runEvents(h.events, 'automation/run-start', catchup.id).length === 1)
  await poll(() => runEvents(h.events, 'automation/missed', catchup.id).length === 1)
  expect((await findAutomation(h.profileDir, catchup.id)).nextRunAt).toBeGreaterThan(stale)
})

test('a busy foreground channel agent does not keep another project root due', async () => {
  useTick(20)
  const h = makeHarness()
  const elsewhere = mkdtempSync(join(tmpdir(), 'hw-sched-other-'))
  dirs.push(elsewhere)
  const other = await createProject(h.profileDir, { root: elsewhere, name: '别处' })
  const grouped = await makeTask(h.profileDir, { projectId: other.id, name: '别组' })
  const neutralTask = await makeTask(h.profileDir, { projectId: null, name: '中立下一组' })
  const dueAt = Date.now() - 1_000
  await arm(h.profileDir, grouped.id, dueAt)
  await arm(h.profileDir, neutralTask.id, dueAt)
  h.installUserAgent(() => new Promise<void>(() => undefined))
  start(h)

  await poll(() => runEvents(h.events, 'automation/run-end', grouped.id).length === 1)
  await poll(() => runEvents(h.events, 'automation/run-end', neutralTask.id).length === 1)
  expect(runEvents(h.events, 'automation/run-start', neutralTask.id)).toHaveLength(1)
})

test('unbound tasks run in their own workspace-automations root, not the neutral root', async () => {
  useTick(20)
  const h = makeHarness()
  mkdirSync(h.neutral, { recursive: true })
  const task = await makeTask(h.profileDir, { projectId: null, name: '中立' })
  await arm(h.profileDir, task.id, Date.now() - 1_000)
  start(h)
  await poll(() => runEvents(h.events, 'automation/run-end', task.id).length === 1)
  expect((await recentRuns(h.profileDir, task.id))[0]?.output).toBe('tick-ok')
})

test('a due task still runs while a script task holds another root', async () => {
  useTick(20)
  const h = makeHarness()
  const elsewhere = mkdtempSync(join(tmpdir(), 'hw-sched-other-'))
  dirs.push(elsewhere)
  const other = await createProject(h.profileDir, { root: elsewhere, name: '别处' })
  const project = await createProject(h.profileDir, { root: h.neutral, name: '同根' })
  const mark = join(elsewhere, 'script-mark')
  const release = join(elsewhere, 'script-release')
  const script = await makeTask(h.profileDir, {
    projectId: other.id,
    name: '慢脚本',
    schedule: { kind: 'manual' },
    command: holdCommand(mark, release),
  })
  const agent = await makeTask(h.profileDir, {
    projectId: project.id,
    kind: 'agent',
    prompt: '生成产出',
    name: '到期 agent',
  })
  await arm(h.profileDir, agent.id, Date.now() - 1_000)
  const { done } = await admitAndEnqueue(h, script, { trigger: 'manual' })
  try {
    await poll(() => existsSync(mark) && runEvents(h.events, 'automation/run-start', script.id).length === 1)
    start(h)

    await poll(() => runEvents(h.events, 'automation/run-end', agent.id).length === 1)
    expect(runEvents(h.events, 'automation/run-end', script.id)).toHaveLength(0)
    expect((await recentRuns(h.profileDir, agent.id))[0]?.trigger).toBe('schedule')
  } finally {
    writeFileSync(release, '1')
  }
  await poll(() => runEvents(h.events, 'automation/run-end', script.id).length === 1)
  await done
}, 15_000)

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

async function boundAgentForRecovery(h: Harness): Promise<AutomationInfo> {
  const root = mkdtempSync(join(tmpdir(), 'hw-recovery-project-'))
  dirs.push(root)
  const project = await createProject(h.profileDir, { root, name: '恢复项目' })
  return createAutomation(h.profileDir, normalizeAutomationInput({
    projectId: project.id, name: '恢复任务', kind: 'agent',
    schedule: { kind: 'manual' }, prompt: '恢复测试',
  }))
}

test('recovery reconciles an already persisted successful run without duplicating it', async () => {
  const h = makeHarness()
  const created = await boundAgentForRecovery(h)
  await markAutomation(h.profileDir, created.id, {
    lastRunAt: 1000, lastStatus: 'running', activeRunId: 'original-1',
  })
  await appendRun(h.profileDir, created.id, {
    runId: 'original-1', startedAt: 1000, endedAt: 1200, ok: true,
    output: 'done', status: 'ok', durationMs: 200,
  })
  const running = await findAutomation(h.profileDir, created.id)
  await recoverInterruptedAutomation(h.routeCtx, running, 2000)
  const runs = await recentRuns(h.profileDir, created.id)
  expect(runs).toHaveLength(1)
  expect(runs[0]?.runId).toBe('original-1')
  expect((await findAutomation(h.profileDir, created.id)).lastStatus).toBe('ok')
})

test('recovery reuses the persisted run task instead of matching timestamps', async () => {
  const h = makeHarness()
  const created = await boundAgentForRecovery(h)
  const sessionId = automationRunSessionId(created.id, 'original-2')
  const task = await createAutomationRunTask(h.profileDir, {
    projectId: created.projectId!, name: '原运行', createdAt: 1000,
    automationId: created.id, runId: 'original-2', sessionId,
  })
  await markAutomation(h.profileDir, created.id, {
    lastRunAt: 1000, lastStatus: 'running', activeRunId: 'original-2',
  })
  const running = await findAutomation(h.profileDir, created.id)
  await recoverInterruptedAutomation(h.routeCtx, running, 2000)
  const run = (await recentRuns(h.profileDir, created.id))[0]!
  expect(run.runId).toBe('original-2')
  expect(run.taskId).toBe(task.id)
  expect(run.sessionId).toBe(sessionId)
  expect(run.status).toBe('cancelled')
})

test('one failing recovery leaves its row running and does not block the rest', async () => {
  useTick(20)
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '隔离' })
  const broken = await makeTask(h.profileDir, { projectId: project.id, name: '损坏', schedule: { kind: 'manual' } })
  const healthy = await makeTask(h.profileDir, { projectId: project.id, name: '正常', schedule: { kind: 'manual' } })
  await markAutomation(h.profileDir, broken.id, {
    lastRunAt: Date.now() - 10_000, lastStatus: 'running', activeRunId: 'broken-1',
  })
  await markAutomation(h.profileDir, healthy.id, {
    lastRunAt: Date.now() - 10_000, lastStatus: 'running', activeRunId: 'healthy-1',
  })
  // runs 文件位置被目录占住:该条恢复在 appendRun 前读取就抛错(EISDIR)。
  mkdirSync(runsPath(h.profileDir, broken.id), { recursive: true })
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    start(h)
    await poll(async () => (await recentRuns(h.profileDir, healthy.id)).some((run) => run.runId === 'healthy-1'))
  } finally {
    logged.mockRestore()
  }
  const recovered = (await recentRuns(h.profileDir, healthy.id))[0]!
  expect(recovered).toMatchObject({ status: 'cancelled', ok: false })
  const stuck = await findAutomation(h.profileDir, broken.id)
  expect(stuck.lastStatus).toBe('running')
  expect(stuck.activeRunId).toBe('broken-1')
})

test('a due once task disables itself after firing and does not record missed', async () => {
  useTick(20)
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '一次' })
  const at = Date.now() + 80
  const once = await makeTask(h.profileDir, {
    projectId: project.id,
    name: '一次性',
    schedule: { kind: 'once', at },
    command: `${quote(process.execPath)} -e ${quote('process.stdout.write("once-ok")')}`,
  })
  await arm(h.profileDir, once.id, at)
  start(h)

  await poll(() => runEvents(h.events, 'automation/run-end', once.id).length === 1)
  expect(runEvents(h.events, 'automation/run-end', once.id)[0]).toMatchObject({ ok: true })
  const stored = await findAutomation(h.profileDir, once.id)
  expect(stored.enabled).toBe(false)
  expect(stored.nextRunAt).toBeUndefined()
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect((await recentRuns(h.profileDir, once.id)).some((run) => run.status === 'missed')).toBe(false)
})

test('an admission skip survives the missed grace window', async () => {
  useTick(20)
  const h = makeHarness()
  const elsewhere = mkdtempSync(join(tmpdir(), 'hw-sched-busy-'))
  dirs.push(elsewhere)
  const project = await createProject(h.profileDir, { root: elsewhere, name: '占用' })
  const due = await makeTask(h.profileDir, { projectId: project.id, kind: 'agent', prompt: '稍后', name: '稍后' })
  const firstDue = Date.now() - 1_000
  await arm(h.profileDir, due.id, firstDue)
  const userSession = freshSessionIdFor(elsewhere)
  h.installUserAgent(() => new Promise(() => undefined), userSession)
  await sessionSend(h.runtime, h.routeCtx, {
    text: '占住这个根',
    sessionId: userSession,
    tabId: 'tab-root',
    modelId: 'default',
  })
  start(h)
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(runEvents(h.events, 'automation/run-start', due.id)).toHaveLength(0)
  expect((await recentRuns(h.profileDir, due.id)).some((run) => run.status === 'missed')).toBe(false)
  const lateDue = Date.now() - MISSED_GRACE_MS - 5_000
  await arm(h.profileDir, due.id, lateDue)
  await new Promise((resolve) => setTimeout(resolve, 80))
  const stored = await findAutomation(h.profileDir, due.id)
  expect(stored.enabled).toBe(true)
  expect(stored.nextRunAt).toBe(lateDue)
  expect((await recentRuns(h.profileDir, due.id)).some((run) => run.status === 'missed')).toBe(false)
  h.release()
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(runEvents(h.events, 'automation/run-start', due.id)).toHaveLength(1)
})
