/**
 * 自动化执行体(Task 4/8)。agent 回合用进程内 agent double(followup/whenIdle),
 * 不启动真实模型,也不 boot 未构建的 lib/。token 经 bind 后的 emit 归集。
 *
 * Task 8 起 enqueueAutomation 假定写者名额已由调度 tick 或 automation.run 占上:
 * 直接入队的用例先经本地 `startAutomation` 准入;需要路由语义的用例走 `automation.run`。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import type { AutomationInfo, ProjectInfo, RpcEvent, RunSummary } from '../../src/client-huaanwork/rpc-types.ts'
import { inFlightRuns, inFlightRunsOf } from '../../src/huaanwork-host/automation-inflight.ts'
import { automationRunSessionId } from '../../src/huaanwork-host/automation-session-ids.ts'
import {
  MISSING_PROJECT_OUTPUT,
  automationAdmissionRoot,
  automationCollector,
  bindAutomationRuntime,
  enqueueAutomation,
  hasInFlightAutomationRun,
  scriptRunKillers,
  scriptSlotWaiters,
  stopAutomation,
  type AutomationRuntime,
  type AutomationTrigger,
} from '../../src/huaanwork-host/automations-host.ts'
import { createAutomation, normalizeAutomationInput, updateAutomation } from '../../src/huaanwork-host/automations-store.ts'
import { ROUTE_TABLE, type RouteContext, type RouteHandler, type RouteRequest } from '../../src/huaanwork-host/routes.ts'
import { sessionIdFor } from '../../src/huaanwork-host/session-id.ts'
import { AGENT_ID, sessionSend, type ListedAgent } from '../../src/huaanwork-host/sessions.ts'
import { createProject, listAutomations, recentRuns } from '../../src/huaanwork-host/stores.ts'
import { createTurnScheduler, type TurnScheduler } from '../../src/huaanwork-host/turn-scheduler.ts'
import { neutralAutomationRootPath, neutralWorkspaceRoot } from '../../src/huaanwork-host/workspace-state.ts'

type Mode = 'immediate' | 'hang' | 'throw'

type Harness = {
  profileDir: string
  dshHome: string
  neutral: string
  events: RpcEvent[]
  followups: { sessionId: string; text: string }[]
  runtime: AutomationRuntime
  routeCtx: RouteContext
  scheduler: TurnScheduler
  state: {
    mode: Mode
    reply: string
    cancelDelayMs: number
    ignoreCancel: boolean
    noWhenIdle: boolean
    cancels: string[]
    inFlight: number
    maxInFlight: number
    maxConcurrentTurns: number
    /** 事件钩子:在 emit 返回前观察事件(测试用 run-start 同步触发 stop)。 */
    onEvent: ((event: RpcEvent) => void) | undefined
  }
  release: (sessionId?: string) => void
  installUserAgent: (sessionId: string, whenIdle?: () => Promise<void>) => void
  userFollowups: unknown[]
  releaseFiles: string[]
}

const dirs: string[] = []
const live: Harness[] = []
const previousDrain = process.env.HUAANWORK_TIMED_OUT_TURN_DRAIN_MS

/** 注入超时后 turn settle 的 drain 截止(M4 评审 D1 用例)。 */
function useDrain(ms: number): void {
  process.env.HUAANWORK_TIMED_OUT_TURN_DRAIN_MS = String(ms)
}

function makeHarness(current?: string): Harness {
  const profileDir = mkdtempSync(join(tmpdir(), 'hw-auto-profile-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'hw-auto-dsh-'))
  dirs.push(profileDir, dshHome)
  const neutral = neutralWorkspaceRoot(profileDir)
  const events: RpcEvent[] = []
  const followups: { sessionId: string; text: string }[] = []
  const userFollowups: unknown[] = []
  const releases = new Map<string, () => void>()
  const agents = new Map<string, ListedAgent>()
  const state: Harness['state'] = {
    mode: 'immediate' as Mode,
    reply: 'stub-output',
    cancelDelayMs: 0,
    ignoreCancel: false,
    noWhenIdle: false,
    cancels: [] as string[],
    inFlight: 0,
    maxInFlight: 0,
    maxConcurrentTurns: 3,
    onEvent: undefined,
  }
  const box: { routeCtx: RouteContext | undefined } = { routeCtx: undefined }

  const runtime = {
    huaanworkApprovals: new Map(),
    huaanworkUnattended: new Map(),
    huaanworkAllowedOnce: new Set<string>(),
    huaanworkDshHome: profileDir,
    agents: {
      async create(options: { sessionId: string }) {
        const sessionId = options.sessionId
        let idle = Promise.resolve()
        const agent: ListedAgent = {
          id: sessionId,
          session: { id: sessionId },
          followup(message: unknown) {
            const text = readText(message)
            followups.push({ sessionId, text })
            if (state.mode === 'throw') throw new Error('agent boom')
            if (state.mode === 'immediate') {
              box.routeCtx?.emit({ event: 'token', text: state.reply, sessionId })
            }
            if (state.mode === 'hang') {
              state.inFlight += 1
              state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
              let settled = false
              idle = new Promise<void>((resolve) => {
                releases.set(sessionId, () => {
                  if (settled) return
                  settled = true
                  state.inFlight -= 1
                  resolve()
                })
              })
            }
          },
          cancel() {
            state.cancels.push(sessionId)
            // ignoreCancel:模拟「取消被调用但对回合无效」(生产对应:agent 尚未建成、
            // 或卡在不可取消的工具调用里)——cancel 记录在案,release 不触发。
            if (state.ignoreCancel) return
            const finish = releases.get(sessionId)
            if (!finish) return
            if (state.cancelDelayMs > 0) setTimeout(finish, state.cancelDelayMs)
            else finish()
          },
          whenIdle: () => idle,
        }
        if (state.noWhenIdle) delete agent.whenIdle
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
      // 在途表阶段与事件发射由同一同步段完成:钩子内联调用 stop 就能命中「已 started、
      // agent 尚未建成」的窗口,不必靠 sleep 猜时序。
      state.onEvent?.(event)
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
    dshHome,
    neutral,
    events,
    followups,
    runtime,
    routeCtx,
    scheduler,
    state,
    userFollowups,
    releaseFiles: [],
    release(sessionId?: string) {
      const ids = sessionId ? [sessionId] : [...releases.keys()]
      for (const id of ids) releases.get(id)?.()
    },
    installUserAgent(sessionId: string, whenIdle?: () => Promise<void>) {
      agents.set(sessionId, {
        id: sessionId,
        session: { id: sessionId },
        followup(message: unknown) {
          userFollowups.push(message)
        },
        whenIdle: whenIdle ?? (() => Promise.resolve()),
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

function handler(method: string): RouteHandler {
  const found = ROUTE_TABLE.find((item) => item.method === method)
  if (!found) throw new Error(`missing route ${method}`)
  return found.handler
}

function body(value: unknown): RouteRequest {
  return { params: {}, body: value, query: new URLSearchParams() }
}

async function poll(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`poll timed out after ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

function runEnds(events: RpcEvent[], automationId: string): RpcEvent[] {
  return events.filter((event) => event.event === 'automation/run-end' && event.automationId === automationId)
}

async function waitRunEnd(events: RpcEvent[], automationId: string, count = 1): Promise<RpcEvent> {
  await poll(() => runEnds(events, automationId).length >= count)
  const ended = runEnds(events, automationId).at(-1)
  if (!ended) throw new Error('run-end missing')
  return ended
}

async function agentTask(profileDir: string, patch: Record<string, unknown> = {}): Promise<AutomationInfo> {
  return createAutomation(
    profileDir,
    normalizeAutomationInput({
      name: '任务',
      kind: 'agent',
      schedule: { kind: 'manual' },
      prompt: '做点事',
      ...patch,
    }),
  )
}

async function scriptTask(profileDir: string, command: string, patch: Record<string, unknown> = {}): Promise<AutomationInfo> {
  return createAutomation(
    profileDir,
    normalizeAutomationInput({
      name: '脚本',
      kind: 'script',
      schedule: { kind: 'manual' },
      command,
      ...patch,
    }),
  )
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function nodeEval(code: string): string {
  return `${quote(process.execPath)} -e ${quote(code)}`
}

function holdCommand(mark: string, release: string): string {
  const script =
    'const fs=require("node:fs"); fs.writeFileSync(process.env.MARK,"1"); const end=Date.now()+8000; while(!fs.existsSync(process.env.RELEASE)&&Date.now()<end){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,40)}'
  return `MARK=${quote(mark)} RELEASE=${quote(release)} ${quote(process.execPath)} -e ${quote(script)}`
}

function shellName(): string {
  return process.platform === 'win32' ? 'pwsh' : 'bash'
}

/** 与生产准入同一判据:项目根,或该任务自己的 workspace-automations 根(纯路径,不建目录)。 */
async function admissionRoot(h: Harness, automation: AutomationInfo): Promise<string> {
  return await automationAdmissionRoot(h.routeCtx, automation)
}

/**
 * 先占坑再入队:调度 tick 与 automation.run 之外的测试路径必须自己准入,
 * 否则执行体会在没人持有的根上调用 releaseAndDrain。
 */
async function startAutomation(
  h: Harness,
  automation: AutomationInfo,
  opts: { trigger?: AutomationTrigger; runId?: string; coalescedCount?: number } = {},
): Promise<{ runId: string; root: string; done: Promise<void> }> {
  const runId = opts.runId ?? randomUUID()
  const root = await admissionRoot(h, automation)
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
    trigger: opts.trigger ?? 'manual',
    runId,
    root,
    ...(opts.coalescedCount === undefined ? {} : { coalescedCount: opts.coalescedCount }),
  })
  return { runId, root, done }
}

afterEach(async () => {
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
  const deadline = Date.now() + 3_000
  while ((inFlightRuns.size > 0 || scriptSlotWaiters.length > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  automationCollector.clear()
  scriptRunKillers.clear()
  inFlightRuns.clear()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
  if (previousDrain === undefined) delete process.env.HUAANWORK_TIMED_OUT_TURN_DRAIN_MS
  else process.env.HUAANWORK_TIMED_OUT_TURN_DRAIN_MS = previousDrain
}, 15_000)

test('script task emits widget between run-start and run-end', async () => {
  const h = makeHarness()
  writeFileSync(join(h.neutral, 'task.mjs'), 'process.stdout.write("widget-data-123");\n')
  const project = await createProject(h.profileDir, { root: h.neutral, name: '行情' })
  const automation = await scriptTask(h.profileDir, `${quote(process.execPath)} ${quote(join(h.neutral, 'task.mjs'))}`, {
    projectId: project.id,
    name: '抓取行情',
    widget: true,
  })
  const accepted = await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
  expect(accepted).toMatchObject({ queued: true, workspaceRoot: h.neutral })
  const ended = await waitRunEnd(h.events, automation.id)
  expect(ended).toMatchObject({ ok: true })
  const runs = await recentRuns(h.profileDir, automation.id)
  expect(runs[0]?.output).toBe('widget-data-123')
  expect(runs[0]?.ok).toBe(true)
  expect(h.events.filter((event) => event.event.startsWith('automation/')).map((event) => event.event)).toEqual([
    'automation/run-start',
    'automation/widget',
    'automation/run-end',
  ])
})

test('a second manual run on one root waits until the first releases', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  const project = await createProject(h.profileDir, { root: h.neutral, name: '同根' })
  const first = await agentTask(h.profileDir, { projectId: project.id, name: '先跑' })
  const second = await agentTask(h.profileDir, { projectId: project.id, name: '后跑' })

  const accepted = (await Promise.race([
    handler('automation.run')(body({ id: first.id }), h.routeCtx),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('handler blocked on execution')), 1_000)),
  ])) as { queued: boolean; runId: string; workspaceRoot: string }
  expect(accepted).toMatchObject({ queued: true, workspaceRoot: h.neutral })
  expect(accepted.runId).toEqual(expect.any(String))
  expect(runEnds(h.events, first.id)).toHaveLength(0)
  await poll(() => h.followups.length === 1)

  // 同根第二条不再抛「后台自动化任务运行中」,而是等待:不 followup、没有在途条目。
  const skipped = await handler('automation.run')(body({ id: second.id }), h.routeCtx)
  expect(skipped).toMatchObject({ queued: false, waiting: true, reason: 'root-busy', workspaceRoot: h.neutral })
  expect((skipped as { runId: string }).runId).toEqual(expect.any(String))
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(h.followups).toHaveLength(1)
  expect(inFlightRunsOf(second.id)).toEqual([])

  h.release()
  await waitRunEnd(h.events, first.id)
  const retried = await handler('automation.run')(body({ id: second.id }), h.routeCtx)
  expect(retried).toMatchObject({ queued: true })
  await poll(() => h.followups.length === 2)
  h.release()
  await waitRunEnd(h.events, second.id)
  expect(h.scheduler.activeTurnCount()).toBe(0)
})

test('agents on different roots overlap while the same root keeps one writer', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  const other = mkdtempSync(join(tmpdir(), 'hw-auto-overlap-'))
  dirs.push(other)
  const projectA = await createProject(h.profileDir, { root: h.neutral, name: 'A' })
  const projectB = await createProject(h.profileDir, { root: other, name: 'B' })
  const first = await agentTask(h.profileDir, { projectId: projectA.id, name: 'A1' })
  const sameRoot = await agentTask(h.profileDir, { projectId: projectA.id, name: 'A2' })
  const elsewhere = await agentTask(h.profileDir, { projectId: projectB.id, name: 'B1' })

  await handler('automation.run')(body({ id: first.id }), h.routeCtx)
  await poll(() => h.followups.length === 1)
  const firstSession = h.followups[0]!.sessionId
  // 项目级 agent 自动化在 followup 时根键已是项目根,不是中立工作区。
  expect(h.runtime.huaanworkSessionRoots?.get(firstSession)).toBe(resolve(h.neutral))

  // 同一 project.root 的第二条在第一条 release 之前不 followup。
  expect(await handler('automation.run')(body({ id: sameRoot.id }), h.routeCtx)).toMatchObject({
    queued: false,
    waiting: true,
    reason: 'root-busy',
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(h.followups).toHaveLength(1)

  // 另一个 project.root 直接开始:两个不同根的 agent 运行重叠。
  await handler('automation.run')(body({ id: elsewhere.id }), h.routeCtx)
  await poll(() => h.followups.length === 2)
  const elsewhereSession = h.followups[1]!.sessionId
  expect(h.runtime.huaanworkSessionRoots?.get(elsewhereSession)).toBe(resolve(other))
  expect(runEnds(h.events, elsewhere.id)).toHaveLength(0)
  // 脚本自动化的目标根已有写者时,不调用脚本执行函数。
  const mark = join(h.neutral, 'blocked-script-mark')
  const blocked = await scriptTask(h.profileDir, nodeEval(`require("node:fs").writeFileSync(${JSON.stringify(mark)}, "1")`), {
    projectId: projectA.id,
    name: '被挡脚本',
  })
  expect(await handler('automation.run')(body({ id: blocked.id }), h.routeCtx)).toMatchObject({
    queued: false,
    waiting: true,
    reason: 'root-busy',
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(existsSync(mark)).toBe(false)

  h.release(firstSession)
  await waitRunEnd(h.events, first.id)
  // 运行结束并释放之后,本次运行的根键与模型键都不在。
  expect(h.runtime.huaanworkSessionRoots?.has(firstSession)).toBe(false)
  expect(h.runtime.huaanworkSessionModels?.has(firstSession)).toBe(false)

  // 根释放后同根第二条重新准入。
  await handler('automation.run')(body({ id: sameRoot.id }), h.routeCtx)
  await poll(() => h.followups.length === 3)
  h.release()
  await waitRunEnd(h.events, sameRoot.id)
  await waitRunEnd(h.events, elsewhere.id)
})

test('automation binds its startup model before dispatch and confirms it at followup', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  const project = await createProject(h.profileDir, { root: h.neutral, name: '模型' })
  writeFileSync(
    join(h.profileDir, 'huaanwork-settings.json'),
    JSON.stringify({
      models: [
        { id: 'model-a', name: 'A', base_url: 'http://127.0.0.1:11434/v1', model: 'a', api_key: '' },
        { id: 'model-b', name: 'B', base_url: 'http://127.0.0.1:11434/v1', model: 'b', api_key: '' },
      ],
      active_model_id: 'model-a',
      base_url: 'http://127.0.0.1:11434/v1',
      model: 'a',
      api_key: '',
    }),
  )
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '模型任务' })
  let modelAtFollowup: string | undefined
  let rootAtFollowup: string | undefined
  const create = h.runtime.agents!.create!
  h.runtime.agents!.create = async (options) => {
    const agent = (await create(options)) as ListedAgent & { followup: (message: unknown) => void }
    const followup = agent.followup
    agent.followup = (message: unknown) => {
      modelAtFollowup = h.runtime.huaanworkSessionModels?.get(options.sessionId)
      rootAtFollowup = h.runtime.huaanworkSessionRoots?.get(options.sessionId)
      followup.call(agent, message)
    }
    return agent
  }

  const accepted = (await handler('automation.run')(body({ id: automation.id }), h.routeCtx)) as { runId: string }
  await poll(() => h.followups.length === 1)
  const sessionId = `huaanwork-auto-${automation.id}-${accepted.runId}`
  // followup 入口:模型键已在 dispatch 前写入,根键已是目标项目。
  expect(modelAtFollowup).toBe('model-a')
  expect(rootAtFollowup).toBe(resolve(h.neutral))
  // 受理后保留 dispatch 前写入的启动时快照;之后改全局当前模型不影响本次运行。
  expect(h.runtime.huaanworkSessionModels?.get(sessionId)).toBe('model-a')
  writeFileSync(join(h.profileDir, 'huaanwork-settings.json'), JSON.stringify({ active_model_id: 'model-b' }))
  expect(h.runtime.huaanworkSessionModels?.get(sessionId)).toBe('model-a')

  h.release()
  await waitRunEnd(h.events, automation.id)
  expect(h.runtime.huaanworkSessionRoots?.has(sessionId)).toBe(false)
  expect(h.runtime.huaanworkSessionModels?.has(sessionId)).toBe(false)
})

test('an unaccepted followup leaves no model binding and releases the root', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '早退' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '早退任务' })
  const create = h.runtime.agents!.create!
  let fail = true
  h.runtime.agents!.create = async (options) => {
    const agent = (await create(options)) as ListedAgent & { followup: (message: unknown) => void }
    const followup = agent.followup
    agent.followup = (message: unknown) => {
      if (fail) throw new Error('followup rejected')
      followup.call(agent, message)
    }
    return agent
  }

  const accepted = (await handler('automation.run')(body({ id: automation.id }), h.routeCtx)) as { runId: string }
  const sessionId = `huaanwork-auto-${automation.id}-${accepted.runId}`
  const ended = await waitRunEnd(h.events, automation.id)
  expect(ended).toMatchObject({ ok: false, status: 'error' })
  expect((await recentRuns(h.profileDir, automation.id))[0]?.output).toContain('followup rejected')
  expect(h.runtime.huaanworkSessionModels?.has(sessionId)).toBe(false)
  expect(h.runtime.huaanworkSessionRoots?.has(sessionId)).toBe(false)

  // 写者已通过同一个 releaseOnce 释放:同根下一次手动运行仍可开始。
  fail = false
  await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
  await poll(() => h.followups.length === 1)
  await waitRunEnd(h.events, automation.id)
})

test('the script slot pool caps at two across roots and one root keeps one writer', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const roots = [0, 1, 2].map((index) => mkdtempSync(join(tmpdir(), `hw-auto-slot-${index}-`)))
  dirs.push(...roots)
  const projects: ProjectInfo[] = []
  for (let index = 0; index < roots.length; index += 1) {
    projects.push(await createProject(h.profileDir, { root: roots[index]!, name: `槽位-${index}` }))
  }
  const marks = roots.map((root, index) => join(root, `mark-${index}`))
  const releases = roots.map((root, index) => join(root, `release-${index}`))
  h.releaseFiles.push(...releases)
  const tasks = await Promise.all(
    marks.map((mark, index) =>
      scriptTask(h.profileDir, holdCommand(mark, releases[index]!), {
        projectId: projects[index]!.id,
        name: `槽位-${index}`,
      }),
    ),
  )
  for (const task of tasks) await handler('automation.run')(body({ id: task.id }), h.routeCtx)
  await poll(() => marks.filter((mark) => existsSync(mark)).length === 2 && scriptSlotWaiters.length === 1)
  expect(existsSync(marks[2]!)).toBe(false)

  // 同根第二个写者被拒:即使槽位还有空也不启动。
  const sameRoot = await scriptTask(h.profileDir, nodeEval('process.stdout.write("same-root")'), {
    projectId: projects[0]!.id,
    name: '同根再一个',
  })
  expect(await handler('automation.run')(body({ id: sameRoot.id }), h.routeCtx)).toMatchObject({
    queued: false,
    waiting: true,
    reason: 'root-busy',
  })
  expect(inFlightRunsOf(sameRoot.id)).toEqual([])

  writeFileSync(releases[0]!, '1')
  await poll(() => existsSync(marks[2]!))
  for (const release of releases) writeFileSync(release, '1')
  for (const task of tasks) await waitRunEnd(h.events, task.id)
  expect(scriptSlotWaiters).toHaveLength(0)
  expect(runEnds(h.events, sameRoot.id)).toHaveLength(0)
})

test('a script holding a root makes a same-root send wait while another root sends immediately', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const otherRoot = mkdtempSync(join(tmpdir(), 'hw-auto-free-'))
  dirs.push(otherRoot)
  const busyProject = await createProject(h.profileDir, { root: h.neutral, name: '占用' })
  await createProject(h.profileDir, { root: otherRoot, name: '空闲' })
  const release = join(h.neutral, 'script-release')
  const mark = join(h.neutral, 'script-mark')
  h.releaseFiles.push(release)
  const script = await scriptTask(h.profileDir, holdCommand(mark, release), { projectId: busyProject.id, name: '慢脚本' })
  const busySession = sessionIdFor(h.neutral)
  const freeSession = sessionIdFor(otherRoot)
  h.installUserAgent(busySession)
  h.installUserAgent(freeSession)
  await handler('automation.run')(body({ id: script.id }), h.routeCtx)
  await poll(() =>
    h.events.some(
      (event) => event.event === 'automation/run-start' && event.automationId === script.id,
    ),
  )

  const waiting = await handler('session.send')(
    body({ text: 'same-root', sessionId: busySession, tabId: 'tab-busy' }),
    h.routeCtx,
  )
  expect(waiting).toMatchObject({ queued: true, waiting: true, started: false })
  expect(h.userFollowups).toHaveLength(0)

  const sent = await handler('session.send')(
    body({ text: 'other-root', sessionId: freeSession, tabId: 'tab-free' }),
    h.routeCtx,
  )
  expect(sent).toMatchObject({ queued: true, waiting: false, started: true })
  expect(h.userFollowups).toHaveLength(1)

  // 脚本不占名额:取消与其它会话不受影响。
  await expect(handler('session.cancel')(body({ sessionId: freeSession }), h.routeCtx)).resolves.toEqual({
    accepted: true,
  })

  writeFileSync(release, '1')
  await waitRunEnd(h.events, script.id)
  // 根释放后,同根等待项经 drainQueue 开始。
  await poll(() => h.userFollowups.length === 2)
})

test('tokens attribute to the run session and approvals stay isolated across a concurrent script', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  const scriptRoot = mkdtempSync(join(tmpdir(), 'hw-auto-attr-'))
  dirs.push(scriptRoot)
  const agentProject = await createProject(h.profileDir, { root: h.neutral, name: '归因' })
  const scriptProject = await createProject(h.profileDir, { root: scriptRoot, name: '并发脚本' })
  const agent = await agentTask(h.profileDir, { projectId: agentProject.id, name: '归因任务' })
  const release = join(scriptRoot, 'slow-release')
  h.releaseFiles.push(release)
  const script = await scriptTask(h.profileDir, holdCommand(join(scriptRoot, 'slow-mark'), release), {
    projectId: scriptProject.id,
    name: '并发脚本',
  })
  await handler('automation.run')(body({ id: script.id }), h.routeCtx)
  await handler('automation.run')(body({ id: agent.id }), h.routeCtx)
  await poll(() => h.followups.length === 1)
  const started = h.events.find((event) => event.event === 'automation/run-start' && event.automationId === agent.id)
  if (!started || started.event !== 'automation/run-start' || !started.sessionId) throw new Error('run-start missing')
  const sessionId = started.sessionId
  expect(sessionId).toMatch(new RegExp(`^huaanwork-auto-${agent.id}-`))

  h.routeCtx.emit({ event: 'token', text: 'work-main ', sessionId })
  h.routeCtx.emit({ event: 'token', text: 'OTHER-LEAK', sessionId: 'someone-else' })
  h.routeCtx.emit({ event: 'token', text: 'legacy-work' })

  let outcome: string | undefined
  h.runtime.huaanworkApprovals?.set('approval-of-agent-run', (result) => {
    outcome = result
  })
  h.routeCtx.emit({
    event: 'approval/asked',
    approvalRequestId: 'approval-of-agent-run',
    toolName: 'bash',
    sessionId,
  })
  writeFileSync(release, '1')
  await waitRunEnd(h.events, script.id)
  expect(h.runtime.huaanworkApprovals?.has('approval-of-agent-run')).toBe(true)
  expect(outcome).toBeUndefined()

  h.release()
  await waitRunEnd(h.events, agent.id)
  expect(h.runtime.huaanworkApprovals?.has('approval-of-agent-run')).toBe(false)
  expect(outcome).toBe('rejected')
  const runs = await recentRuns(h.profileDir, agent.id)
  expect(runs[0]?.output).toBe('work-main legacy-work')
})

test('unattended allow degrades an ask, writes an audit line, and never admits run_code', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  const shell = shellName()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '无人' })
  const automation = await agentTask(h.profileDir, {
    projectId: project.id,
    name: '无人值守',
    unattended: { enabled: true, allow: [shell, 'run_code', 'read'] },
  })
  expect(automation.unattended?.allow).not.toContain('run_code')
  expect(automation.unattended?.allow).toContain(shell)

  await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
  await poll(() => h.followups.length === 1)
  const sessionId = h.followups[0]?.sessionId ?? ''
  const scope = h.runtime.huaanworkUnattended?.get(sessionId)
  expect(scope?.automationId).toBe(automation.id)
  expect(scope?.allow.has('run_code')).toBe(false)
  expect(scope?.allow.has(shell)).toBe(true)
  expect(scope?.allow.has('read')).toBe(true)
  // 只写入本次运行的会话:其它会话查不到无人值守范围。
  expect(h.runtime.huaanworkUnattended?.get('someone-else')).toBeUndefined()

  const { apply } = await import('../../src/huaanwork-guardrails/policy.ts')
  type PreExecute = (
    execution: { name: string; arguments: unknown; agent?: { session?: { id?: string } }; callId?: string },
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string }>
  const listeners: PreExecute[] = []
  apply({
    huaanworkUnattended: h.runtime.huaanworkUnattended,
    huaanworkProfileDir: h.profileDir, huaanworkDshHome: h.profileDir,
    huaanworkAllowedOnce: new Set<string>(),
    huaanworkWorkspaceRoot: h.routeCtx.workspaceRoot,
    on(event: string, listener: PreExecute) {
      if (event === 'tools/pre-execute') listeners.push(listener)
    },
    tools: { guard: () => () => undefined },
  } as never)
  const decision = await listeners[0]?.(
    { name: shell, arguments: { command: 'ls -la' }, agent: { session: { id: sessionId } }, callId: 'call-1' },
    async () => ({ kind: 'allow' }),
  )
  expect(decision).toEqual({ kind: 'allow' })
  const audit = readFileSync(join(h.profileDir, 'automations', `${automation.id}.audit.jsonl`), 'utf8').trim()
  const entry = JSON.parse(audit.split('\n')[0] ?? '') as { tool?: string; decision?: string; runId?: string }
  expect(entry.tool).toBe(shell)
  expect(entry.decision).toBe('ask→allow')
  expect(entry.runId).toBe(scope?.runId)

  h.release()
  await waitRunEnd(h.events, automation.id)
  expect(h.runtime.huaanworkUnattended?.get(sessionId)).toBeUndefined()
  expect(h.runtime.huaanworkUnattended?.size).toBe(0)
})

test('legacy channel:chat record can enable unattended and mint a huaanwork-auto- session', async () => {
  const h = makeHarness()
  const id = 'legacy-chat-task'
  writeFileSync(
    join(h.profileDir, 'automations.json'),
    `${JSON.stringify({
      automations: [
        {
          id,
          projectId: null,
          name: '旧 chat 自动化',
          kind: 'agent',
          schedule: { kind: 'manual' },
          prompt: '生成早报',
          command: 'echo hi',
          widget: false,
          enabled: true,
          createdAt: Date.now(),
          channel: 'chat',
        },
      ],
    })}\n`,
  )
  const asScript = await updateAutomation(h.profileDir, id, { kind: 'script', command: 'echo hi' })
  expect(asScript.kind).toBe('script')
  const withUnattended = await updateAutomation(h.profileDir, id, { unattended: { enabled: true } })
  expect(withUnattended.unattended?.enabled).toBe(true)
  expect(withUnattended.unattended?.allow).not.toContain('run_code')
  const asAgent = await updateAutomation(h.profileDir, id, { kind: 'agent' })
  expect(asAgent.kind).toBe('agent')

  h.state.reply = 'legacy-ok'
  await handler('automation.run')(body({ id }), h.routeCtx)
  const ended = await waitRunEnd(h.events, id)
  expect(ended).toMatchObject({ ok: true })
  const started = h.events.find((event) => event.event === 'automation/run-start' && event.automationId === id)
  expect(started && started.event === 'automation/run-start' && started.sessionId?.startsWith(`huaanwork-auto-${id}-`)).toBe(true)
})

test('automation-fire envelope and merged 4KB prefix', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '信封' })
  const daily = await agentTask(h.profileDir, { projectId: project.id, name: '每日早报', prompt: '生成今日早报' })
  h.state.reply = '早报正文'
  await handler('automation.run')(body({ id: daily.id }), h.routeCtx)
  await waitRunEnd(h.events, daily.id)
  const envelope = h.followups[0]?.text ?? ''
  expect(envelope.startsWith('<automation-fire name="每日早报" trigger="manual" missed="0">')).toBe(true)
  expect(envelope).toContain('生成今日早报')
  expect(envelope.trimEnd().endsWith('</automation-fire>')).toBe(true)

  const merged = await agentTask(h.profileDir, {
    projectId: project.id,
    name: '合并形态',
    prompt: '继续分析',
    taskShape: 'merged',
  })
  h.state.reply = 'P'.repeat(6000)
  await handler('automation.run')(body({ id: merged.id }), h.routeCtx)
  await waitRunEnd(h.events, merged.id)
  h.state.reply = 'second-output'
  await handler('automation.run')(body({ id: merged.id }), h.routeCtx)
  await waitRunEnd(h.events, merged.id, 2)
  const secondPrompt = h.followups.at(-1)?.text ?? ''
  expect(secondPrompt).toContain('P'.repeat(4096))
  expect(secondPrompt.includes('P'.repeat(4200))).toBe(false)
  expect(secondPrompt).toContain('继续分析')
  expect(secondPrompt).toContain('上次成功运行的产出（截断至 4 KB）：')
  const runs = await recentRuns(h.profileDir, merged.id)
  expect(runs[1]?.output).toBe('second-output')
})

test('timeout is status timeout for a hung agent, a hung script, and a plain error stays error', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  writeFileSync(join(h.profileDir, 'huaanwork-settings.json'), JSON.stringify({ automation_timeout_ms: 200 }))
  const project = await createProject(h.profileDir, { root: h.neutral, name: '超时' })

  h.state.mode = 'hang'
  const hung = await agentTask(h.profileDir, { projectId: project.id, name: '超时任务', prompt: '生成产出' })
  await handler('automation.run')(body({ id: hung.id }), h.routeCtx)
  await waitRunEnd(h.events, hung.id)
  const timed = (await recentRuns(h.profileDir, hung.id))[0] as RunSummary
  expect(timed.status).toBe('timeout')
  expect(timed.ok).toBe(false)
  expect(timed.output).toContain('自动化任务连续 200 毫秒无活动')

  const slow = await scriptTask(h.profileDir, nodeEval('setTimeout(() => {}, 30000)'), {
    projectId: project.id,
    name: '超时脚本',
  })
  await handler('automation.run')(body({ id: slow.id }), h.routeCtx)
  await waitRunEnd(h.events, slow.id)
  const scriptRun = (await recentRuns(h.profileDir, slow.id))[0] as RunSummary
  expect(scriptRun.status).toBe('timeout')
  expect(scriptRun.output).toContain('任务连续 200 毫秒无输出，已终止')

  h.state.mode = 'throw'
  const broken = await agentTask(h.profileDir, { projectId: project.id, name: '失败任务' })
  await handler('automation.run')(body({ id: broken.id }), h.routeCtx)
  await waitRunEnd(h.events, broken.id)
  const failed = (await recentRuns(h.profileDir, broken.id))[0] as RunSummary
  expect(failed.status).toBe('error')
  expect(failed.output).toContain('agent boom')
})

test('a manual run uses the task project root without moving the foreground root', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const other = mkdtempSync(join(tmpdir(), 'hw-auto-other-'))
  dirs.push(other)
  const project = await createProject(h.profileDir, { root: other, name: '别的项目' })
  const bound = await scriptTask(h.profileDir, nodeEval('process.stdout.write(process.cwd())'), {
    projectId: project.id,
    name: '跨根',
  })
  const accepted = await handler('automation.run')(body({ id: bound.id }), h.routeCtx)
  expect(accepted).toMatchObject({ queued: true, workspaceRoot: h.neutral })
  expect(h.routeCtx.workspaceRoot.current).toBe(h.neutral)
  const ended = await waitRunEnd(h.events, bound.id)
  expect(ended).toMatchObject({ ok: true })
  expect((await recentRuns(h.profileDir, bound.id))[0]?.output).toBe(await realpath(other))

  const neutralTask = await agentTask(h.profileDir, { name: '中立', prompt: '冷知识' })
  const neutralRun = await handler('automation.run')(body({ id: neutralTask.id }), h.routeCtx)
  expect(neutralRun).toMatchObject({ queued: true, workspaceRoot: h.neutral })
  expect(h.routeCtx.workspaceRoot.current).toBe(h.neutral)
  await waitRunEnd(h.events, neutralTask.id)
})

test('unbound automation runs in its own workspace-automations root and a vanished project still queues a failed run', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.reply = '中立产出'
  const neutralAgent = await agentTask(h.profileDir, { name: '每天一个为什么', prompt: '讲个冷知识' })
  expect(neutralAgent.projectId).toBeNull()
  const accepted = await handler('automation.run')(body({ id: neutralAgent.id }), h.routeCtx)
  expect(accepted).toMatchObject({ queued: true })
  const ended = await waitRunEnd(h.events, neutralAgent.id)
  expect(ended).toMatchObject({ ok: true, projectId: null })
  const started = h.events.find((event) => event.event === 'automation/run-start' && event.automationId === neutralAgent.id)
  expect(started && started.event === 'automation/run-start' && started.sessionId?.startsWith('huaanwork-auto-')).toBe(true)
  expect((await recentRuns(h.profileDir, neutralAgent.id))[0]?.output).toBe('中立产出')

  const script = await scriptTask(h.profileDir, nodeEval('process.stdout.write(process.cwd())'), { name: '中立脚本' })
  await handler('automation.run')(body({ id: script.id }), h.routeCtx)
  await waitRunEnd(h.events, script.id)
  // 存量 projectId: null 的脚本在自己的 workspace-automations 根里跑,不再占用中立根。
  expect((await recentRuns(h.profileDir, script.id))[0]?.output).toBe(
    await realpath(neutralAutomationRootPath(h.profileDir, script.id)),
  )

  // 前台默认会话正占着 <profileDir>/workspace 时,无项目的任务仍可立即准入并跑完:
  // 它有自己的根,不和前台默认会话抢中立根(root-busy 不应出现在这条路径上)。
  expect(
    h.scheduler.admitAutomation({
      automationId: 'work-1-probe',
      sessionId: 'work-1',
      root: h.neutral,
      runId: 'work-1-probe',
      countsTowardCap: true,
    }),
  ).toEqual({ kind: 'start', root: h.neutral })
  try {
    const whileBusy = await agentTask(h.profileDir, { name: '前台占用时的冷知识', prompt: '讲个冷知识' })
    expect(whileBusy.projectId).toBeNull()
    expect(await handler('automation.run')(body({ id: whileBusy.id }), h.routeCtx)).toMatchObject({ queued: true })
    await waitRunEnd(h.events, whileBusy.id)
    expect((await recentRuns(h.profileDir, whileBusy.id))[0]).toMatchObject({ ok: true, output: '中立产出' })
  } finally {
    // 释放的是准入时登记的 sessionId('work-1'),不是 runId:release 按会话摘 rootWriters,
    // 写错键等于没释放,后面的用例会继承被占的中立根。
    h.scheduler.release('work-1')
  }

  const project = await createProject(h.profileDir, { root: h.neutral, name: '将消失' })
  const ghost = await scriptTask(h.profileDir, nodeEval("process.stdout.write('x')"), {
    projectId: project.id,
    name: '绑定脚本',
  })
  writeFileSync(join(h.profileDir, 'projects.json'), `${JSON.stringify({ projects: [] })}\n`)
  const queued = await handler('automation.run')(body({ id: ghost.id }), h.routeCtx)
  expect(queued).toMatchObject({ queued: true })
  const failed = await waitRunEnd(h.events, ghost.id)
  expect(failed).toMatchObject({ ok: false })
  expect((await recentRuns(h.profileDir, ghost.id))[0]?.output).toBe(MISSING_PROJECT_OUTPUT)
  // 准入只推导路径:已删项目的失败运行不留下空目录。
  expect(existsSync(neutralAutomationRootPath(h.profileDir, ghost.id))).toBe(false)
})

test('an unbound automation whose root path is blocked by a file fails the run and releases admission', async () => {
  const h = makeHarness()
  const script = await scriptTask(h.profileDir, 'echo never', { name: '被文件挡住' })
  expect(script.projectId).toBeNull()
  // 在 <profileDir>/workspace-automations/<id> 上先放一个同名文件:
  // neutralAutomationRoot 的 mkdirSync(recursive) 对它必抛。
  const blocked = neutralAutomationRootPath(h.profileDir, script.id)
  mkdirSync(dirname(blocked), { recursive: true })
  writeFileSync(blocked, 'not a directory', 'utf8')

  // startAutomation 先真实准入,再返回可等待执行完成的 done;本文件没有 runOnce。
  const { root, done } = await startAutomation(h, script)
  await done

  const [run] = await recentRuns(h.profileDir, script.id)
  expect(run?.ok).toBe(false)
  // 挡住 mkdir 的形态随平台/Node 而异:目标本身是文件 → EEXIST,中间段是文件 → ENOTDIR。
  expect(run?.output).toMatch(/EEXIST|ENOTDIR/)
  expect((await listAutomations(h.profileDir)).find((item) => item.id === script.id)?.lastStatus).not.toBe('running')
  // 准入已释放:同一根可以再次准入。
  // 注意不能用 activeTurnCount() 证明释放——脚本不计入 cap
  // (turn-scheduler.ts:72 `countsTowardCap = kind !== 'script-automation'`,
  //  :135 只在 countsTowardCap 时 +1,:206-208 返回 activeTurns),
  // 本用例全程 activeTurns 恒为 0,那条断言无论释放与否都会通过。
  // 直接探测 rootWriters:用 startAutomation 返回的同一个 root 键。
  const probe = h.scheduler.admitAutomation({
    automationId: script.id,
    sessionId: 'probe-after-failure',
    root,
    runId: 'probe-after-failure',
    countsTowardCap: false,
    recordSkip: false,
  })
  expect(probe).toEqual({ kind: 'start', root })
  h.scheduler.release('probe-after-failure')
})

test('pruneSessions keeps collector and recorded sessions', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  const project = await createProject(h.profileDir, { root: h.neutral, name: '清理' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '会话清理' })
  await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
  await poll(() => h.followups.length === 1)
  const started = h.events.find((event) => event.event === 'automation/run-start')
  const live = started && started.event === 'automation/run-start' ? started.sessionId : undefined
  expect(live).toBeTruthy()
  const recorded = `huaanwork-auto-${automation.id}-kept`
  const stale = `huaanwork-auto-${automation.id}-stale`
  const cwd = join(h.dshHome, 'sessions', 'some-cwd')
  mkdirSync(join(cwd, live!), { recursive: true })
  mkdirSync(join(cwd, recorded), { recursive: true })
  mkdirSync(join(cwd, stale), { recursive: true })
  mkdirSync(join(cwd, 'huaanwork-user'), { recursive: true })
  mkdirSync(join(h.profileDir, 'automations'), { recursive: true })
  writeFileSync(
    join(h.profileDir, 'automations', `${automation.id}.runs.jsonl`),
    `${JSON.stringify({
      runId: 'kept',
      startedAt: 1,
      endedAt: 2,
      ok: true,
      output: 'ok',
      status: 'ok',
      trigger: 'manual',
      sessionId: recorded,
    })}\n`,
  )
  const removed = await handler('automation.pruneSessions')(body({}), h.routeCtx)
  expect(removed).toEqual({ removed: 1 })
  expect(readdirSync(cwd).sort()).toEqual([live!, recorded, 'huaanwork-user'].sort())
  h.release()
  await waitRunEnd(h.events, automation.id)
})

test('a busy foreground turn skips its own root but not another project root', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const other = mkdtempSync(join(tmpdir(), 'hw-auto-busy-'))
  dirs.push(other)
  const otherProject = await createProject(h.profileDir, { root: other, name: '别的项目' })
  const neutralProject = await createProject(h.profileDir, { root: h.neutral, name: '同根' })
  const elsewhereTask = await agentTask(h.profileDir, { projectId: otherProject.id })
  const sameRootTask = await agentTask(h.profileDir, { projectId: neutralProject.id })
  const userSession = sessionIdFor(h.neutral)
  h.installUserAgent(userSession, () => new Promise<void>(() => undefined))
  await sessionSend(h.runtime, h.routeCtx, {
    text: '占住前台',
    sessionId: userSession,
    tabId: 'tab-user',
    modelId: 'default',
  })

  // 前台根有写者,但另一项目根的手动运行仍可开始。
  const accepted = await handler('automation.run')(body({ id: elsewhereTask.id }), h.routeCtx)
  expect(accepted).toMatchObject({ queued: true })
  await waitRunEnd(h.events, elsewhereTask.id)

  // 同根才跳过。
  const skipped = await handler('automation.run')(body({ id: sameRootTask.id }), h.routeCtx)
  expect(skipped).toMatchObject({ queued: false, waiting: true, reason: 'root-busy', workspaceRoot: h.neutral })
  expect(inFlightRunsOf(sameRootTask.id)).toEqual([])
})

test('a manual run on another root reports cap-full when the global cap is full', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.maxConcurrentTurns = 1
  const other = mkdtempSync(join(tmpdir(), 'hw-auto-cap-'))
  dirs.push(other)
  const otherProject = await createProject(h.profileDir, { root: other, name: '别的项目' })
  const elsewhereTask = await agentTask(h.profileDir, { projectId: otherProject.id })
  const userSession = sessionIdFor(h.neutral)
  h.installUserAgent(userSession, () => new Promise<void>(() => undefined))
  await sessionSend(h.runtime, h.routeCtx, {
    text: '占住名额',
    sessionId: userSession,
    tabId: 'tab-user',
    modelId: 'default',
  })

  // 目标根没有写者,但全局名额已被前台回合占满:跳过原因必须是 cap-full。
  const skipped = await handler('automation.run')(body({ id: elsewhereTask.id }), h.routeCtx)
  expect(skipped).toMatchObject({
    queued: false,
    waiting: true,
    reason: 'cap-full',
    workspaceRoot: h.neutral,
  })
  expect((skipped as { runId: string }).runId).toEqual(expect.any(String))
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(h.followups).toHaveLength(0)
  expect(inFlightRunsOf(elsewhereTask.id)).toEqual([])
})

test('interval run keeps the nextRunAt computed at start', async () => {
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '间隔' })
  const automation = await scriptTask(
    h.profileDir,
    nodeEval('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,40)'),
    { projectId: project.id, name: '间隔脚本', schedule: { kind: 'interval', minutes: 1 } },
  )
  await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
  await waitRunEnd(h.events, automation.id)
  const run = (await recentRuns(h.profileDir, automation.id))[0]
  const stored = (await listAutomations(h.profileDir)).find((item) => item.id === automation.id)
  expect(run?.endedAt).toBeGreaterThan(run?.startedAt ?? 0)
  expect(stored?.nextRunAt).toBe((run?.startedAt ?? 0) + 60_000)
})

test('agent enqueue resolves when the run record cannot be written', async () => {
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '磁盘' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '写盘失败' })
  writeFileSync(join(h.profileDir, 'automations'), 'not-a-directory')
  const rejections: unknown[] = []
  const onRejection = (error: unknown) => {
    rejections.push(error)
  }
  process.on('unhandledRejection', onRejection)
  try {
    const { done } = await startAutomation(h, automation, { trigger: 'manual', runId: 'disk-1' })
    await expect(done).resolves.toBeUndefined()
    const queued = await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
    expect(queued).toMatchObject({ queued: true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(rejections).toEqual([])
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

test('a rejected running marker releases the root before any handoff', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  const project = await createProject(h.profileDir, { root: h.neutral, name: '标记失败' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '标记失败' })
  // 注册表读仍然正常:把原子写用的临时文件位置占成目录,markAutomation 的 writeFile
  // 以 EISDIR 拒绝——等价于 automations.json 不可写/磁盘满。
  mkdirSync(join(h.profileDir, 'automations.json.tmp'))

  const accepted = await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
  expect(accepted).toMatchObject({ queued: true })
  // run-start 在 mark 之前发射;mark 拒绝后执行体必须释放写者并摘掉在途条目。
  await poll(() => h.scheduler.soleCapWriterSessionId() === undefined && inFlightRunsOf(automation.id).length === 0)
  // 没有交接:回合未启动,也没有运行记录。
  expect(h.followups).toHaveLength(0)
  expect(await recentRuns(h.profileDir, automation.id)).toEqual([])

  // 同一项目根的下一次用户发送不再排在这个写者后面。
  const userSession = sessionIdFor(h.neutral)
  h.installUserAgent(userSession)
  await expect(
    sessionSend(h.runtime, h.routeCtx, {
      text: '写盘失败后继续',
      sessionId: userSession,
      tabId: 'tab-user',
      modelId: 'default',
    }),
  ).resolves.toMatchObject({ started: true })
})

test('an agent run keeps going past the configured window while attributed output keeps arriving', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  writeFileSync(join(h.profileDir, 'huaanwork-settings.json'), JSON.stringify({ automation_timeout_ms: 180 }))
  const project = await createProject(h.profileDir, { root: h.neutral, name: '持续活动' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '持续活动' })

  const run = await startAutomation(h, automation, { trigger: 'manual', runId: 'activity-1' })
  const startedAt = Date.now()
  await poll(() => h.followups.length === 1)
  const sessionId = h.followups[0]!.sessionId
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 60))
    h.routeCtx.emit({ event: 'token', text: `part-${index}`, sessionId })
  }
  expect(Date.now() - startedAt).toBeGreaterThan(180)
  h.release(sessionId)
  await run.done

  expect(await recentRuns(h.profileDir, automation.id)).toMatchObject([
    { status: 'ok', output: 'part-0part-1part-2part-3part-4part-5' },
  ])
})

test('reasoning and tool lifecycle events keep an agent run alive', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  writeFileSync(join(h.profileDir, 'huaanwork-settings.json'), JSON.stringify({ automation_timeout_ms: 180 }))
  const project = await createProject(h.profileDir, { root: h.neutral, name: '阶段活动' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '阶段活动' })

  const run = await startAutomation(h, automation, { trigger: 'manual', runId: 'activity-events' })
  await poll(() => h.followups.length === 1)
  const sessionId = h.followups[0]!.sessionId
  const events: RpcEvent[] = [
    { event: 'reasoning', text: 'plan', sessionId },
    { event: 'tool/start', name: 'read', callId: 'call-1', sessionId },
    { event: 'tool/end', name: 'read', callId: 'call-1', sessionId },
    { event: 'diff', text: 'changed', sessionId },
  ]
  for (let round = 0; round < 2; round += 1) {
    for (const event of events) {
      await new Promise((resolve) => setTimeout(resolve, 40))
      h.routeCtx.emit(event)
    }
  }
  h.release(sessionId)
  await run.done

  expect((await recentRuns(h.profileDir, automation.id)).at(-1)).toMatchObject({ status: 'ok' })
})

test('subagent progress from the same parent session keeps an agent run alive', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  writeFileSync(join(h.profileDir, 'huaanwork-settings.json'), JSON.stringify({ automation_timeout_ms: 180 }))
  const project = await createProject(h.profileDir, { root: h.neutral, name: '子代理活动' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '子代理活动' })

  const run = await startAutomation(h, automation, { trigger: 'manual', runId: 'activity-subagent' })
  await poll(() => h.followups.length === 1)
  const sessionId = h.followups[0]!.sessionId
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 60))
    h.routeCtx.emit({
      event: 'subagent/run',
      run: {
        runId: 'child-1',
        parentSessionId: sessionId,
        kind: 'legacy',
        label: '调研子任务',
        phase: 'generating',
        activeTools: [],
        startedAt: Date.now(),
        lastActivity: Date.now() + index,
        cleanupWarnings: [],
        generation: 'generation-1',
        revision: index + 1,
      },
    })
  }
  h.release(sessionId)
  await run.done

  expect((await recentRuns(h.profileDir, automation.id)).at(-1)).toMatchObject({ status: 'ok' })
})

test('approval prompts do not count as agent activity', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  writeFileSync(join(h.profileDir, 'huaanwork-settings.json'), JSON.stringify({ automation_timeout_ms: 180 }))
  const project = await createProject(h.profileDir, { root: h.neutral, name: '审批等待' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '审批等待' })

  const run = await startAutomation(h, automation, { trigger: 'manual', runId: 'approval-idle' })
  await poll(() => h.followups.length === 1)
  const sessionId = h.followups[0]!.sessionId
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 60))
    h.routeCtx.emit({
      event: 'approval/asked',
      approvalRequestId: `approval-${index}`,
      toolName: 'bash',
      sessionId,
    })
  }
  await run.done

  expect((await recentRuns(h.profileDir, automation.id)).at(-1)).toMatchObject({
    status: 'timeout',
    output: expect.stringContaining('自动化任务连续 180 毫秒无活动'),
  })
})

test('activity from another session does not keep an agent run alive', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  writeFileSync(join(h.profileDir, 'huaanwork-settings.json'), JSON.stringify({ automation_timeout_ms: 180 }))
  const project = await createProject(h.profileDir, { root: h.neutral, name: '无关会话' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '无关会话' })

  const run = await startAutomation(h, automation, { trigger: 'manual', runId: 'unrelated-activity' })
  await poll(() => h.followups.length === 1)
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 60))
    h.routeCtx.emit({ event: 'token', text: `other-${index}`, sessionId: 'another-session' })
  }
  await run.done

  expect((await recentRuns(h.profileDir, automation.id)).at(-1)).toMatchObject({ status: 'timeout' })
})

test('repeated subagent snapshots without new activity do not keep an agent run alive', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  writeFileSync(join(h.profileDir, 'huaanwork-settings.json'), JSON.stringify({ automation_timeout_ms: 180 }))
  const project = await createProject(h.profileDir, { root: h.neutral, name: '重复快照' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '重复快照' })

  const run = await startAutomation(h, automation, { trigger: 'manual', runId: 'duplicate-subagent' })
  await poll(() => h.followups.length === 1)
  const sessionId = h.followups[0]!.sessionId
  const lastActivity = Date.now()
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 60))
    h.routeCtx.emit({
      event: 'subagent/run',
      run: {
        runId: 'child-1',
        parentSessionId: sessionId,
        kind: 'legacy',
        label: '调研子任务',
        phase: 'generating',
        activeTools: [],
        startedAt: lastActivity,
        lastActivity,
        cleanupWarnings: [],
        generation: 'generation-1',
        revision: index + 1,
      },
    })
  }
  await run.done

  expect((await recentRuns(h.profileDir, automation.id)).at(-1)).toMatchObject({ status: 'timeout' })
})

test('a script run keeps going past the configured window while it keeps writing output', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  writeFileSync(join(h.profileDir, 'huaanwork-settings.json'), JSON.stringify({ automation_timeout_ms: 3_000 }))
  const project = await createProject(h.profileDir, { root: h.neutral, name: '脚本活动' })
  const command = nodeEval(
    '(async()=>{for(let i=0;i<10;i+=1){console.log(`line-${i}`);await new Promise((resolve)=>setTimeout(resolve,400))}})()',
  )
  const automation = await scriptTask(h.profileDir, command, { projectId: project.id, name: '持续输出' })

  const run = await startAutomation(h, automation, { trigger: 'manual', runId: 'script-activity' })
  await run.done

  const recorded = (await recentRuns(h.profileDir, automation.id)).at(-1) as RunSummary
  expect(recorded).toMatchObject({ status: 'ok', ok: true })
  expect(recorded.durationMs).toBeGreaterThan(3_000)
  for (let index = 0; index < 10; index += 1) expect(recorded.output).toContain(`line-${index}`)
})

test('agent run reads the collector only after the agent goes idle, and the timeout covers that wait', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  const settings = join(h.profileDir, 'huaanwork-settings.json')
  writeFileSync(settings, JSON.stringify({ automation_timeout_ms: 5_000 }))
  const project = await createProject(h.profileDir, { root: h.neutral, name: '等空闲' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '等空闲' })

  const first = await startAutomation(h, automation, { trigger: 'manual', runId: 'idle-1' })
  await poll(() => h.followups.length === 1)
  const sessionId = h.followups[0]!.sessionId
  h.routeCtx.emit({ event: 'token', text: 'part-1 ', sessionId })
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(runEnds(h.events, automation.id)).toHaveLength(0)
  h.routeCtx.emit({ event: 'token', text: 'part-2', sessionId })
  h.release(sessionId)
  await first.done
  expect(await recentRuns(h.profileDir, automation.id)).toMatchObject([{ status: 'ok', output: 'part-1 part-2' }])

  writeFileSync(settings, JSON.stringify({ automation_timeout_ms: 150 }))
  const second = await startAutomation(h, automation, { trigger: 'manual', runId: 'idle-2' })
  await second.done
  expect((await recentRuns(h.profileDir, automation.id)).at(-1)).toMatchObject({
    status: 'timeout',
    output: expect.stringContaining('自动化任务连续 150 毫秒无活动'),
  })

  h.state.mode = 'immediate'
  h.state.noWhenIdle = true
  h.state.reply = 'no-idle-hook'
  const third = await startAutomation(h, automation, { trigger: 'manual', runId: 'idle-3' })
  await third.done
  expect((await recentRuns(h.profileDir, automation.id)).at(-1)).toMatchObject({ status: 'ok', output: 'no-idle-hook' })
})

test('agent run waits on its own session agent, not the channel agent, when get(sessionId) misses', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  let channelIdleCalls = 0
  h.installUserAgent(AGENT_ID, () => {
    channelIdleCalls += 1
    return Promise.resolve()
  })
  const agents = h.runtime.agents!
  const get = agents.get!
  agents.get = (id: string) => (id.startsWith('huaanwork-auto-') ? undefined : get(id))
  const project = await createProject(h.profileDir, { root: h.neutral, name: '精确会话' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '精确会话' })

  const run = await startAutomation(h, automation, { trigger: 'manual', runId: 'exact-1' })
  await poll(() => h.followups.length === 1)
  const sessionId = h.followups[0]!.sessionId
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(runEnds(h.events, automation.id)).toHaveLength(0)
  expect(channelIdleCalls).toBe(0)
  h.routeCtx.emit({ event: 'token', text: 'own-output', sessionId })
  h.release(sessionId)
  await run.done
  expect(await recentRuns(h.profileDir, automation.id)).toMatchObject([{ status: 'ok', output: 'own-output' }])
  expect(channelIdleCalls).toBe(0)
})

test('agent timeout cancels the session and settles the turn before the next agent starts', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  h.state.cancelDelayMs = 40
  writeFileSync(join(h.profileDir, 'huaanwork-settings.json'), JSON.stringify({ automation_timeout_ms: 180 }))
  const project = await createProject(h.profileDir, { root: h.neutral, name: '超时串行' })
  const first = await agentTask(h.profileDir, { projectId: project.id, name: '先超时' })
  const second = await agentTask(h.profileDir, { projectId: project.id, name: '后超时' })
  const firstRun = await startAutomation(h, first, { trigger: 'manual', runId: 'timeout-1' })
  await poll(() => h.followups.length === 1)
  await firstRun.done
  const secondRun = await startAutomation(h, second, { trigger: 'manual', runId: 'timeout-2' })
  await secondRun.done
  expect(h.state.maxInFlight).toBe(1)
  expect(h.state.cancels).toEqual([h.followups[0]?.sessionId, h.followups[1]?.sessionId])
  expect(h.state.inFlight).toBe(0)
})

test('agent timeout with an ineffective cancel drains the turn but keeps root/model bindings until it settles', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  h.state.ignoreCancel = true
  useDrain(80)
  writeFileSync(join(h.profileDir, 'huaanwork-settings.json'), JSON.stringify({ automation_timeout_ms: 180 }))
  const rootA = mkdtempSync(join(tmpdir(), 'hw-auto-drain-a-'))
  const rootB = mkdtempSync(join(tmpdir(), 'hw-auto-drain-b-'))
  dirs.push(rootA, rootB)
  const projectA = await createProject(h.profileDir, { root: rootA, name: '取消未命中 A' })
  const projectB = await createProject(h.profileDir, { root: rootB, name: '取消未命中 B' })
  const shell = shellName()
  const first = await agentTask(h.profileDir, {
    projectId: projectA.id,
    name: '取消无效',
    unattended: { enabled: true, allow: [shell, 'read'] },
  })
  const second = await agentTask(h.profileDir, { projectId: projectB.id, name: '取消无效后' })
  const firstRun = await startAutomation(h, first, { trigger: 'manual', runId: 'drain-1' })
  await poll(() => h.followups.length === 1)
  const secondRun = await startAutomation(h, second, { trigger: 'manual', runId: 'drain-2' })
  const firstSession = automationRunSessionId(first.id, 'drain-1')
  const secondSession = automationRunSessionId(second.id, 'drain-2')
  await firstRun.done
  await secondRun.done

  // cancel 都被调用过(取消路径确实走过),但 turn 从未被 settle——release 不触发。
  expect(h.state.cancels).toEqual([firstSession, secondSession])
  expect(h.state.inFlight).toBeGreaterThan(0)
  // drain 截止到期 → 仍按超时收尾:run 记录、collector/holder 清理。
  const firstRuns = await recentRuns(h.profileDir, first.id)
  expect(firstRuns[0]?.status).toBe('timeout')
  const secondRuns = await recentRuns(h.profileDir, second.id)
  expect(secondRuns[0]?.status).toBe('timeout')
  expect(automationCollector.size).toBe(0)
  expect(h.runtime.huaanworkUnattended?.size).toBe(0)
  // drain 只是放弃等待,回合与其工具仍在跑:根/模型绑定必须保留到 turn 真正 settle,
  // 否则残留工具调用会回落到前台根与全局模型。
  expect(h.runtime.huaanworkSessionRoots?.get(firstSession)).toBe(rootA)
  expect(h.runtime.huaanworkSessionRoots?.get(secondSession)).toBe(rootB)
  expect(h.runtime.huaanworkSessionModels?.get(firstSession)).toBe('default')
  expect(h.runtime.huaanworkSessionModels?.get(secondSession)).toBe('default')

  // 结算两个被放弃的回合:绑定随 turn 结束删除。
  h.release(firstSession)
  h.release(secondSession)
  await poll(() => h.runtime.huaanworkSessionRoots?.size === 0 && h.runtime.huaanworkSessionModels?.size === 0)
  expect(h.runtime.huaanworkSessionRoots?.has(firstSession)).toBe(false)
  expect(h.runtime.huaanworkSessionRoots?.has(secondSession)).toBe(false)
  expect(h.runtime.huaanworkSessionModels?.has(firstSession)).toBe(false)
  expect(h.runtime.huaanworkSessionModels?.has(secondSession)).toBe(false)
})

test.skipIf(process.platform === 'win32')('a timed-out script releases its root only after the child closes', { timeout: 20_000 }, async () => {
  const h = makeHarness()
  // 登录 shell 的 profile(conda/nvm 等)可能耗时数百毫秒:超时必须在它之后触发,
  // 让 SIGTERM 落在已经忽略它的 node 上。否则 SIGTERM 杀掉还在启动的 shell,进程树
  // 当即 close,本用例的前提(尚未 close 的进程树)不成立。
  writeFileSync(join(h.profileDir, 'huaanwork-settings.json'), JSON.stringify({ automation_timeout_ms: 5_000 }))
  const project = await createProject(h.profileDir, { root: h.neutral, name: '等 close' })
  const started = join(h.neutral, 'close-started')
  const termSeen = join(h.neutral, 'close-term')
  // 先装 SIGTERM 处理器再留启动标记:标记存在 ⇒ 超时杀掉的是忽略 TERM 的进程树。
  const code =
    'const fs=require("node:fs");' +
    `process.on("SIGTERM",()=>fs.writeFileSync(${JSON.stringify(termSeen)},"1"));` +
    `fs.writeFileSync(${JSON.stringify(started)},"1");` +
    'setInterval(()=>{},1000)'
  const script = await scriptTask(h.profileDir, nodeEval(code), { projectId: project.id, name: '忽略 TERM 的脚本' })
  await handler('automation.run')(body({ id: script.id }), h.routeCtx)
  await poll(() => existsSync(started))
  // 超时已触发 SIGTERM(进程树仍在),但 close 尚未到达:同根下一回合必须等待。
  await poll(() => existsSync(termSeen))
  const termAt = statSync(termSeen).mtimeMs
  const userSession = sessionIdFor(h.neutral)
  h.installUserAgent(userSession)
  const waiting = await handler('session.send')(
    body({ text: 'same-root', sessionId: userSession, tabId: 'tab-close' }),
    h.routeCtx,
  )
  expect(waiting).toMatchObject({ queued: true, waiting: true })
  expect(h.userFollowups).toHaveLength(0)

  const ended = await waitRunEnd(h.events, script.id)
  expect(ended).toMatchObject({ status: 'timeout' })
  // Promise 在 kill 之后仍等到 close(≥ SIGKILL 宽限)才结算。
  expect(Date.now() - termAt).toBeGreaterThan(1_800)
  await poll(() => h.userFollowups.length === 1)
})

test('manual agent run events carry runId, sessionId, trigger, status and durationMs, and thinking is stripped', async () => {
  const h = makeHarness()
  h.state.reply = '<think>先想一下</think>今日早报：市场上涨 1.2%'
  const project = await createProject(h.profileDir, { root: h.neutral, name: '事件' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '每日早报', prompt: '生成今日早报' })
  const accepted = (await handler('automation.run')(body({ id: automation.id }), h.routeCtx)) as {
    queued: boolean
    runId: string
  }
  expect(accepted.queued).toBe(true)
  expect(typeof accepted.runId).toBe('string')

  const ended = await waitRunEnd(h.events, automation.id)
  const started = h.events.find((event) => event.event === 'automation/run-start' && event.automationId === automation.id)
  expect(started).toMatchObject({
    runId: accepted.runId,
    trigger: 'manual',
    sessionId: `huaanwork-auto-${automation.id}-${accepted.runId}`,
  })
  expect(ended).toMatchObject({
    runId: accepted.runId,
    status: 'ok',
    ok: true,
    sessionId: `huaanwork-auto-${automation.id}-${accepted.runId}`,
  })
  expect(typeof (ended as { durationMs?: number }).durationMs).toBe('number')

  const run = (await recentRuns(h.profileDir, automation.id))[0]
  expect(run?.output).toBe('今日早报：市场上涨 1.2%')
  expect(run?.status).toBe('ok')
  expect(run?.trigger).toBe('manual')
  expect(run?.durationMs).toBe((run?.endedAt ?? 0) - (run?.startedAt ?? 0))
})

test('two parallel script tasks on different roots do not lock workspace.open', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const other = mkdtempSync(join(tmpdir(), 'hw-auto-open-'))
  const scriptRoots = [0, 1].map((index) => mkdtempSync(join(tmpdir(), `hw-auto-parallel-${index}-`)))
  dirs.push(other, ...scriptRoots)
  const projects: ProjectInfo[] = []
  for (let index = 0; index < scriptRoots.length; index += 1) {
    projects.push(await createProject(h.profileDir, { root: scriptRoots[index]!, name: `并行-${index}` }))
  }
  const marks = scriptRoots.map((root, index) => join(root, `open-mark-${index}`))
  const releases = scriptRoots.map((root, index) => join(root, `open-release-${index}`))
  h.releaseFiles.push(...releases)
  const tasks = await Promise.all(
    marks.map((mark, index) =>
      scriptTask(h.profileDir, holdCommand(mark, releases[index]!), {
        projectId: projects[index]!.id,
        name: `并行脚本-${index}`,
      }),
    ),
  )
  for (const task of tasks) await handler('automation.run')(body({ id: task.id }), h.routeCtx)
  await poll(() => marks.every((mark) => existsSync(mark)) && h.events.filter((event) => event.event === 'automation/run-start').length === 2)
  expect(h.events.some((event) => event.event === 'automation/run-end')).toBe(false)

  let restartCalls = 0
  h.routeCtx.requestRestart = async () => {
    restartCalls += 1
    return true
  }
  const opened = await handler('workspace.open')(body({ root: other }), h.routeCtx)
  expect(opened).toEqual({ workspaceRoot: resolve(other) })
  expect(h.routeCtx.workspaceRoot.current).toBe(resolve(other))
  expect(restartCalls).toBe(0)

  for (const release of releases) writeFileSync(release, '1')
  for (const task of tasks) await waitRunEnd(h.events, task.id)
})

test('agent output drops a closed think block', async () => {
  const h = makeHarness()
  h.state.reply = '<think>先想一下</think>今日早报：市场上涨 1.2%'
  const project = await createProject(h.profileDir, { root: h.neutral, name: '早报' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '每日早报', prompt: '生成今日早报' })
  await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
  await waitRunEnd(h.events, automation.id)
  expect((await recentRuns(h.profileDir, automation.id))[0]?.output).toBe('今日早报：市场上涨 1.2%')
})

test('a once task disables itself after it fires and does not record missed', async () => {
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '一次' })
  const automation = await scriptTask(h.profileDir, nodeEval('process.stdout.write("once-ok")'), {
    projectId: project.id,
    name: '一次性任务',
    schedule: { kind: 'once', at: Date.now() + 60_000 },
  })
  await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
  await waitRunEnd(h.events, automation.id)
  const stored = (await listAutomations(h.profileDir)).find((item) => item.id === automation.id)
  expect(stored?.enabled).toBe(false)
  const runs = await recentRuns(h.profileDir, automation.id)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ status: 'ok', output: 'once-ok' })
  expect(runs.some((run) => run.status === 'missed')).toBe(false)
})

test('a script waiting for a slot stays queued in flight until a slot frees', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const roots = [0, 1, 2].map((index) => mkdtempSync(join(tmpdir(), `hw-auto-inflight-${index}-`)))
  dirs.push(...roots)
  const projects: ProjectInfo[] = []
  for (let index = 0; index < roots.length; index += 1) {
    projects.push(await createProject(h.profileDir, { root: roots[index]!, name: `在途-${index}` }))
  }
  const marks = roots.map((root, index) => join(root, `mark-${index}`))
  const releases = roots.map((root, index) => join(root, `release-${index}`))
  h.releaseFiles.push(...releases)
  const tasks = await Promise.all(
    marks.map((mark, index) =>
      scriptTask(h.profileDir, holdCommand(mark, releases[index]!), {
        projectId: projects[index]!.id,
        name: `在途-${index}`,
      }),
    ),
  )
  const accepted: { runId: string }[] = []
  for (const task of tasks) {
    accepted.push((await handler('automation.run')(body({ id: task.id }), h.routeCtx)) as { runId: string })
  }
  await poll(() => marks.slice(0, 2).every((mark) => existsSync(mark)) && scriptSlotWaiters.length === 1)
  const entry = inFlightRunsOf(tasks[2]!.id)[0]
  if (!entry) throw new Error('in-flight entry missing')
  expect(entry).toMatchObject({
    automationId: tasks[2]!.id,
    runId: accepted[2]!.runId,
    trigger: 'manual',
    phase: 'queued',
    cancelRequested: false,
    slotConsumed: false,
  })
  expect(existsSync(marks[2]!)).toBe(false)

  writeFileSync(releases[0]!, '1')
  await poll(() => existsSync(marks[2]!))
  for (const release of releases) writeFileSync(release, '1')
  for (const task of tasks) await waitRunEnd(h.events, task.id)
  expect(inFlightRunsOf(tasks[2]!.id)).toEqual([])
  expect((await recentRuns(h.profileDir, tasks[2]!.id))[0]?.runId).toBe(accepted[2]!.runId)
})

test('a manual run keeps the caller supplied runId in flight and in the persisted record', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  const project = await createProject(h.profileDir, { root: h.neutral, name: '手动在途' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '手动任务' })

  const run = await startAutomation(h, automation, { trigger: 'manual', runId: 'manual-fixed-1' })
  await poll(() => inFlightRunsOf(automation.id).length === 1)
  // 供 automation.update 改绑守卫消费的只读判定:在途期间为真。
  expect(hasInFlightAutomationRun(automation.id)).toBe(true)
  expect(inFlightRunsOf(automation.id)).toMatchObject([
    {
      automationId: automation.id,
      runId: 'manual-fixed-1',
      trigger: 'manual',
      cancelRequested: false,
      slotConsumed: false,
    },
  ])
  await poll(() => h.followups.length === 1)
  h.release()
  await run.done
  expect(inFlightRunsOf(automation.id)).toEqual([])
  expect(hasInFlightAutomationRun(automation.id)).toBe(false)
  expect((await recentRuns(h.profileDir, automation.id))[0]?.runId).toBe('manual-fixed-1')
})

test('a schedule enqueue runs the script in the admitted project root', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const other = mkdtempSync(join(tmpdir(), 'hw-auto-schedule-root-'))
  dirs.push(other)
  const project = await createProject(h.profileDir, { root: other, name: '别的根' })
  const automation = await scriptTask(h.profileDir, nodeEval('process.stdout.write(process.cwd())'), {
    projectId: project.id,
    name: '调度根',
  })

  const run = await startAutomation(h, automation, { trigger: 'schedule', runId: 'schedule-root-1' })
  expect(run.root).toBe(resolve(other))
  await waitRunEnd(h.events, automation.id)
  expect((await recentRuns(h.profileDir, automation.id))[0]?.output).toBe(await realpath(other))
  expect(h.routeCtx.workspaceRoot.current).toBe(h.neutral)
  expect(inFlightRunsOf(automation.id)).toEqual([])
})

test('the in-flight entry flips to started as automation/run-start is emitted', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  const project = await createProject(h.profileDir, { root: h.neutral, name: '阶段' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '阶段任务' })

  const run = await startAutomation(h, automation, { trigger: 'manual', runId: 'phase-1' })
  await poll(() =>
    h.events.some((event) => event.event === 'automation/run-start' && event.automationId === automation.id),
  )
  const started = h.events.find(
    (event) => event.event === 'automation/run-start' && event.automationId === automation.id,
  )
  expect(started).toMatchObject({ runId: 'phase-1' })
  expect(inFlightRunsOf(automation.id)).toMatchObject([{ runId: 'phase-1', phase: 'started' }])
  await poll(() => h.followups.length === 1)
  h.release()
  await run.done
  expect(inFlightRunsOf(automation.id)).toEqual([])
})

/** 先冲刷产出再写 mark、然后占住进程等信号:停止时产出已确定到达父进程。 */
function outputThenHoldCommand(mark: string, text: string): string {
  const script =
    `const fs=require("node:fs");process.stdout.write(${JSON.stringify(text)},()=>{fs.writeFileSync(process.env.MARK,"1");` +
    'const end=Date.now()+8000;while(Date.now()<end){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,40)}})'
  return `MARK=${quote(mark)} ${quote(process.execPath)} -e ${quote(script)}`
}

test('stopping a started agent run writes one cancelled record and flips lastStatus to error', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  const project = await createProject(h.profileDir, { root: h.neutral, name: '停止对话' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '长对话' })
  const accepted = (await handler('automation.run')(body({ id: automation.id }), h.routeCtx)) as { runId: string }
  await poll(() => h.followups.length === 1)
  const sessionId = `huaanwork-auto-${automation.id}-${accepted.runId}`
  expect(inFlightRunsOf(automation.id)).toMatchObject([{ runId: accepted.runId, phase: 'started' }])

  await expect(stopAutomation(automation.id)).resolves.toEqual({ stopped: true })
  const ended = await waitRunEnd(h.events, automation.id)
  expect(ended).toMatchObject({ runId: accepted.runId, ok: false, status: 'cancelled', sessionId })
  // 已开始的取消走会话取消,不是空转。
  expect(h.state.cancels).toEqual([sessionId])
  expect(runEnds(h.events, automation.id)).toHaveLength(1)
  const runs = await recentRuns(h.profileDir, automation.id)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ runId: accepted.runId, ok: false, status: 'cancelled', output: '已停止' })
  const stored = (await listAutomations(h.profileDir)).find((item) => item.id === automation.id)
  expect(stored?.lastStatus).toBe('error')
  expect(inFlightRunsOf(automation.id)).toEqual([])
  expect(h.scheduler.activeTurnCount()).toBe(0)
})

test('stopping a started script kills the child, keeps collected output and is not a timeout', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const mark = join(h.neutral, 'stop-script-mark')
  const automation = await scriptTask(h.profileDir, outputThenHoldCommand(mark, 'partial-out'), { name: '可停脚本' })
  await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
  // mark 在 stdout 冲刷完成后才写,看到它即表示已收集文本一定在管道里。
  await poll(() => existsSync(mark))

  await expect(stopAutomation(automation.id)).resolves.toEqual({ stopped: true })
  const ended = await waitRunEnd(h.events, automation.id)
  expect(ended).toMatchObject({ ok: false, status: 'cancelled' })
  const runs = await recentRuns(h.profileDir, automation.id)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ status: 'cancelled', ok: false })
  expect(runs[0]?.status).not.toBe('timeout')
  expect(runs[0]?.output).toContain('partial-out')
  expect(runs[0]?.output).not.toContain('任务超时')
  // 合成脚注不算已收集文本:取消结算剥掉 runner 的退出码行。
  expect(runs[0]?.output).not.toContain('退出码')
  expect(scriptRunKillers.size).toBe(0)
  expect(inFlightRunsOf(automation.id)).toEqual([])
})

test('stopping a silent script records 已停止 instead of the runner exit-code footer', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const automation = await scriptTask(h.profileDir, 'sleep 30', { name: '静默脚本' })
  const accepted = (await handler('automation.run')(body({ id: automation.id }), h.routeCtx)) as { runId: string }
  // 等 kill 句柄登记:此时 close 处理器已挂上,stop 必定走脚本通道。
  await poll(() => scriptRunKillers.has(accepted.runId))

  await expect(stopAutomation(automation.id)).resolves.toEqual({ stopped: true })
  const ended = await waitRunEnd(h.events, automation.id)
  expect(ended).toMatchObject({ ok: false, status: 'cancelled' })
  const runs = await recentRuns(h.profileDir, automation.id)
  expect(runs).toHaveLength(1)
  // 修复前 runner 合成的「\n（退出码 unknown）」被当成产出落盘。
  expect(runs[0]).toMatchObject({ status: 'cancelled', ok: false, output: '已停止' })
  expect(scriptRunKillers.size).toBe(0)
  expect(inFlightRunsOf(automation.id)).toEqual([])
})

test('stopping a script synchronously at run-start kills it before the command runs', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const mark = join(h.neutral, 'pre-spawn-stop-mark')
  const automation = await scriptTask(h.profileDir, `sleep 1; echo ran > ${quote(mark)}`, { name: '早停脚本' })
  let stopResult: Promise<{ stopped: boolean }> | undefined
  h.state.onEvent = (event) => {
    if (event.event === 'automation/run-start' && event.automationId === automation.id) {
      // run-start 同步段内联停止:此时 runScript 还没 spawn, kill 句柄尚未登记。
      stopResult = stopAutomation(automation.id)
    }
  }

  await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
  expect(stopResult).toBeDefined()
  await expect(stopResult!).resolves.toEqual({ stopped: true })
  const ended = await waitRunEnd(h.events, automation.id)
  expect(ended).toMatchObject({ ok: false, status: 'cancelled' })

  // 修复前 stop 找不到 kill 句柄,脚本会跑完 sleep 1 并写下 mark。
  await new Promise((resolve) => setTimeout(resolve, 1200))
  expect(existsSync(mark)).toBe(false)
  expect(scriptRunKillers.size).toBe(0)
  expect(inFlightRunsOf(automation.id)).toEqual([])
})

test('a cancel that lands after run-start but before the agent is built still records cancelled', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  h.state.ignoreCancel = true
  const project = await createProject(h.profileDir, { root: h.neutral, name: '早取消' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '早取消任务' })
  let stopResult: Promise<{ stopped: boolean }> | undefined
  h.state.onEvent = (event) => {
    if (event.event === 'automation/run-start' && event.automationId === automation.id) {
      // run-start 同步段内联停止:此时 agent 还没 create,取消调用必然空转。
      stopResult = stopAutomation(automation.id)
    }
  }

  const accepted = (await handler('automation.run')(body({ id: automation.id }), h.routeCtx)) as { runId: string }
  await poll(() => h.followups.length === 1)
  expect(stopResult).toBeDefined()
  await expect(stopResult!).resolves.toEqual({ stopped: true })
  expect(h.state.cancels).toEqual([])

  // 标记之后回合自己跑完(ignoreCancel 表示取消对回合无效):仍写 cancelled,不写 ok。
  const sessionId = `huaanwork-auto-${automation.id}-${accepted.runId}`
  h.routeCtx.emit({ event: 'token', text: 'late-ok', sessionId })
  h.release()
  const ended = await waitRunEnd(h.events, automation.id)
  expect(ended).toMatchObject({ runId: accepted.runId, ok: false, status: 'cancelled' })
  const runs = await recentRuns(h.profileDir, automation.id)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ status: 'cancelled', ok: false, output: 'late-ok' })
})

test('a stopped run whose project vanished records cancelled, not error', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '将消失' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '消失项目任务' })
  writeFileSync(join(h.profileDir, 'projects.json'), `${JSON.stringify({ projects: [] })}\n`)
  let stopResult: Promise<{ stopped: boolean }> | undefined
  h.state.onEvent = (event) => {
    if (event.event === 'automation/run-start' && event.automationId === automation.id) {
      stopResult = stopAutomation(automation.id)
    }
  }

  await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
  expect(stopResult).toBeDefined()
  await expect(stopResult!).resolves.toEqual({ stopped: true })
  const ended = await waitRunEnd(h.events, automation.id)
  expect(ended).toMatchObject({ ok: false, status: 'cancelled' })
  const runs = await recentRuns(h.profileDir, automation.id)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ status: 'cancelled', ok: false, output: '已停止' })
  expect(inFlightRunsOf(automation.id)).toEqual([])
})

test('stopping after the run record is persisted reports not stopped and adds no second record', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '已落盘' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '已落盘任务' })
  h.state.reply = 'done-output'
  await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
  await waitRunEnd(h.events, automation.id)
  expect(inFlightRunsOf(automation.id)).toEqual([])

  await expect(stopAutomation(automation.id)).resolves.toEqual({ stopped: false })
  expect(await recentRuns(h.profileDir, automation.id)).toHaveLength(1)
})

test('stopping a queued script advances nextRunAt once and the executor skips it', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const roots = [0, 1, 2].map((index) => mkdtempSync(join(tmpdir(), `hw-auto-stop-${index}-`)))
  dirs.push(...roots)
  const projects: ProjectInfo[] = []
  for (let index = 0; index < roots.length; index += 1) {
    projects.push(await createProject(h.profileDir, { root: roots[index]!, name: `停止-${index}` }))
  }
  const marks = roots.map((root, index) => join(root, `mark-${index}`))
  const releases = roots.map((root, index) => join(root, `release-${index}`))
  h.releaseFiles.push(...releases)
  const holders = await Promise.all(
    [0, 1].map((index) =>
      scriptTask(h.profileDir, holdCommand(marks[index]!, releases[index]!), {
        projectId: projects[index]!.id,
        name: `占槽-${index}`,
      }),
    ),
  )
  const queued = await scriptTask(h.profileDir, holdCommand(marks[2]!, releases[2]!), {
    projectId: projects[2]!.id,
    name: '排队脚本',
    schedule: { kind: 'interval', minutes: 1 },
  })
  for (const task of holders) await handler('automation.run')(body({ id: task.id }), h.routeCtx)
  await poll(() => scriptSlotWaiters.length === 0 && marks.slice(0, 2).every((mark) => existsSync(mark)))
  await startAutomation(h, queued, { trigger: 'schedule', runId: 'stop-queued' })
  await poll(() => inFlightRuns.get('stop-queued')?.phase === 'queued')

  const storedBefore = (await listAutomations(h.profileDir)).find((item) => item.id === queued.id)
  const before = storedBefore?.nextRunAt
  expect(typeof before).toBe('number')

  await expect(stopAutomation(queued.id)).resolves.toEqual({ stopped: true })
  // 档位写入按规格放在后台(N2-O1):有界等它落盘,不在 stop 返回后立刻断言。
  await poll(async () => (await listAutomations(h.profileDir)).find((item) => item.id === queued.id)?.nextRunAt !== before)
  const advanced = (await listAutomations(h.profileDir)).find((item) => item.id === queued.id)?.nextRunAt
  expect(advanced).toBeGreaterThan(before!)

  // 仍排队时再次停止:slotConsumed 已声明,不二次消费。
  await expect(stopAutomation(queued.id)).resolves.toEqual({ stopped: true })
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect((await listAutomations(h.profileDir)).find((item) => item.id === queued.id)?.nextRunAt).toBe(advanced)

  writeFileSync(releases[0]!, '1')
  await poll(() => inFlightRunsOf(queued.id).length === 0)
  expect(
    h.events.some((event) => event.event === 'automation/run-start' && event.automationId === queued.id),
  ).toBe(false)
  expect(await recentRuns(h.profileDir, queued.id)).toEqual([])
  for (const release of releases) writeFileSync(release, '1')
  for (const task of holders) await waitRunEnd(h.events, task.id)
})

test('a skipped manual run leaves the run list and schedule alone', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '忙' })
  const userSession = sessionIdFor(h.neutral)
  h.installUserAgent(userSession, () => new Promise<void>(() => undefined))
  await sessionSend(h.runtime, h.routeCtx, {
    text: '占住前台',
    sessionId: userSession,
    tabId: 'tab-user',
    modelId: 'default',
  })
  const manual = await agentTask(h.profileDir, { projectId: project.id, name: '手动', schedule: { kind: 'interval', minutes: 5 } })
  const once = await agentTask(h.profileDir, {
    projectId: project.id,
    name: '一次',
    schedule: { kind: 'once', at: Date.now() + 600_000 },
  })
  const before = (await listAutomations(h.profileDir)).reduce<Record<string, number | undefined>>((acc, item) => {
    acc[item.id] = item.nextRunAt
    return acc
  }, {})

  for (const automation of [manual, once]) {
    const skipped = await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
    expect(skipped).toMatchObject({ queued: false, waiting: true, reason: 'root-busy' })
    expect((skipped as { runId: string }).runId).toEqual(expect.any(String))
  }
  await new Promise((resolve) => setTimeout(resolve, 80))
  const after = (await listAutomations(h.profileDir)).reduce<Record<string, number | undefined>>((acc, item) => {
    acc[item.id] = item.nextRunAt
    return acc
  }, {})
  expect(after).toEqual(before)
  for (const automation of [manual, once]) {
    expect(inFlightRunsOf(automation.id)).toEqual([])
    expect(await recentRuns(h.profileDir, automation.id)).toEqual([])
    expect((await listAutomations(h.profileDir)).find((item) => item.id === automation.id)?.enabled).toBe(true)
  }
})

test('a skipped manual run does not poison the scheduled missed-grace exemption', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '手动跳过' })
  const userSession = sessionIdFor(h.neutral)
  h.installUserAgent(userSession, () => new Promise<void>(() => undefined))
  await sessionSend(h.runtime, h.routeCtx, {
    text: '占住前台',
    sessionId: userSession,
    tabId: 'tab-user',
    modelId: 'default',
  })
  const automation = await agentTask(h.profileDir, {
    projectId: project.id,
    name: '定时任务',
    schedule: { kind: 'interval', minutes: 5 },
  })

  const skipped = await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
  expect(skipped).toMatchObject({ queued: false, waiting: true, reason: 'root-busy', workspaceRoot: h.neutral })
  // admissionSkips 只服务定时调度的 missed 豁免:手动跳过不得登记。
  expect(h.scheduler.isAdmissionSkipped(automation.id)).toBe(false)
})

test('a second run of a started task is admission-skipped and stop cancels the single run', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  const project = await createProject(h.profileDir, { root: h.neutral, name: '两轮同停' })
  const automation = await agentTask(h.profileDir, {
    projectId: project.id,
    name: '两轮任务',
    schedule: { kind: 'interval', minutes: 1 },
  })
  const started = (await handler('automation.run')(body({ id: automation.id }), h.routeCtx)) as { runId: string }
  await poll(() => h.followups.length === 1 && inFlightRuns.get(started.runId)?.phase === 'started')
  const skipped = await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
  expect(skipped).toMatchObject({ queued: false, waiting: true, reason: 'root-busy' })
  expect(inFlightRunsOf(automation.id)).toHaveLength(1)

  await expect(stopAutomation(automation.id)).resolves.toEqual({ stopped: true })
  await waitRunEnd(h.events, automation.id)
  const runs = await recentRuns(h.profileDir, automation.id)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ runId: started.runId, ok: false, status: 'cancelled' })
  const starts = h.events.filter((event) => event.event === 'automation/run-start' && event.automationId === automation.id)
  expect(starts).toHaveLength(1)
  expect(starts[0]).toMatchObject({ runId: started.runId })
  expect(inFlightRunsOf(automation.id)).toEqual([])
  expect(h.scheduler.activeTurnCount()).toBe(0)
})

test('a queued script stopped while waiting for a slot releases its root', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const roots = [0, 1, 2].map((index) => mkdtempSync(join(tmpdir(), `hw-auto-wait-${index}-`)))
  dirs.push(...roots)
  const projects: ProjectInfo[] = []
  for (let index = 0; index < roots.length; index += 1) {
    projects.push(await createProject(h.profileDir, { root: roots[index]!, name: `等待-${index}` }))
  }
  const marks = roots.map((root, index) => join(root, `mark-${index}`))
  const releases = roots.map((root, index) => join(root, `release-${index}`))
  h.releaseFiles.push(...releases)
  const holders = await Promise.all(
    [0, 1].map((index) =>
      scriptTask(h.profileDir, holdCommand(marks[index]!, releases[index]!), {
        projectId: projects[index]!.id,
        name: `占槽-${index}`,
      }),
    ),
  )
  const queued = await scriptTask(h.profileDir, holdCommand(marks[2]!, releases[2]!), {
    projectId: projects[2]!.id,
    name: '排队等待',
  })
  for (const task of holders) await handler('automation.run')(body({ id: task.id }), h.routeCtx)
  await poll(() => marks.slice(0, 2).every((mark) => existsSync(mark)))
  const accepted = (await handler('automation.run')(body({ id: queued.id }), h.routeCtx)) as { runId: string }
  await poll(() => inFlightRuns.get(accepted.runId)?.phase === 'queued')

  // 排队期间被停:档位由停止侧声明,轮到执行后从 cancelRequested 早退。
  await expect(stopAutomation(queued.id)).resolves.toEqual({ stopped: true })
  const userSession = sessionIdFor(roots[2]!)
  h.installUserAgent(userSession)
  const waiting = await handler('session.send')(
    body({ text: '同根等待', sessionId: userSession, tabId: 'tab-wait' }),
    h.routeCtx,
  )
  expect(waiting).toMatchObject({ queued: true, waiting: true })
  expect(h.userFollowups).toHaveLength(0)

  writeFileSync(releases[0]!, '1')
  // 早退之后同根用户发送可以 followup:根写者已由同一个 releaseOnce 释放。
  await poll(() => h.userFollowups.length === 1)
  expect(inFlightRunsOf(queued.id)).toEqual([])
  expect(
    h.events.some((event) => event.event === 'automation/run-start' && event.automationId === queued.id),
  ).toBe(false)
  expect(await recentRuns(h.profileDir, queued.id)).toEqual([])

  writeFileSync(releases[1]!, '1')
  await waitRunEnd(h.events, holders[0]!.id)
  await waitRunEnd(h.events, holders[1]!.id)
})

test('stop uses the run kind from the in-flight entry after the registry kind is edited', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  const project = await createProject(h.profileDir, { root: h.neutral, name: '改种类' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '改种类任务' })
  const accepted = (await handler('automation.run')(body({ id: automation.id }), h.routeCtx)) as { runId: string }
  await poll(() => h.followups.length === 1)
  const sessionId = `huaanwork-auto-${automation.id}-${accepted.runId}`

  // 运行中把任务改成脚本:执行体仍按入队时的 agent 种类跑,停止侧不得改读注册表。
  await updateAutomation(h.profileDir, automation.id, { kind: 'script', command: 'echo switched' })
  expect((await listAutomations(h.profileDir)).find((item) => item.id === automation.id)?.kind).toBe('script')

  await expect(stopAutomation(automation.id)).resolves.toEqual({ stopped: true })
  const ended = await waitRunEnd(h.events, automation.id)
  expect(ended).toMatchObject({ runId: accepted.runId, ok: false, status: 'cancelled' })
  // 旧实现按注册表的 script 去找 kill 句柄,agent 会话的 cancel 根本不会被调用。
  expect(h.state.cancels).toEqual([sessionId])
  const runs = await recentRuns(h.profileDir, automation.id)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ runId: accepted.runId, ok: false, status: 'cancelled' })
  expect(inFlightRunsOf(automation.id)).toEqual([])
})

test.skipIf(process.platform === 'win32')('stopping a script kills the whole process tree, not just the shell', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const started = join(h.neutral, 'tree-started')
  const marker = join(h.neutral, 'tree-marker')
  // 后台子 shell 先留痕再睡 2 秒后写 marker:只杀 bash 时它会活下来把 marker 写出来。
  const command = `(printf started > ${quote(started)}; sleep 2; printf done > ${quote(marker)}) & wait`
  const automation = await scriptTask(h.profileDir, command, { name: '进程树脚本' })
  await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
  // 等子 shell 真的起来(已写过 started 文件),否则在 fork 之前停止无法区分两种杀法。
  await poll(() => existsSync(started))

  await expect(stopAutomation(automation.id)).resolves.toEqual({ stopped: true })
  const ended = await waitRunEnd(h.events, automation.id)
  expect(ended).toMatchObject({ ok: false, status: 'cancelled' })
  // 子 shell 本应在启动约 2 秒后写 marker;给足 2.5 秒再断言它没有活下来。
  await new Promise((resolve) => setTimeout(resolve, 2_500))
  expect(existsSync(marker)).toBe(false)
})

test.skipIf(process.platform === 'win32')('the SIGKILL grace still kills a TERM-ignoring background descendant after the leader exits', { timeout: 15_000 }, async () => {
  const h = makeHarness()
  const started = join(h.neutral, 'term-ignored-started')
  const marker = join(h.neutral, 'term-ignored-marker')
  const descendant =
    'const fs=require("node:fs");' +
    'process.on("SIGTERM",()=>{});' +
    'fs.writeFileSync(process.env.STARTED,"1");' +
    'setTimeout(()=>{fs.writeFileSync(process.env.MARKER,"done");process.exit(0)},3000);' +
    'setInterval(()=>{},1000)'
  // 只在组长 bash 的退出码上做判断会漏掉这个后台进程:组长退出后它仍活着,
  // 宽限期后必须按进程组存活探测补发 SIGKILL,否则 3 秒后它会把 marker 写出来。
  const command = `STARTED=${quote(started)} MARKER=${quote(marker)} ${quote(process.execPath)} -e ${quote(descendant)} & wait`
  const automation = await scriptTask(h.profileDir, command, { name: '忽略 TERM 的后台脚本' })
  await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
  await poll(() => existsSync(started))

  await expect(stopAutomation(automation.id)).resolves.toEqual({ stopped: true })
  const ended = await waitRunEnd(h.events, automation.id)
  expect(ended).toMatchObject({ ok: false, status: 'cancelled' })
  // SIGTERM 在宽限 2 秒后被 SIGKILL 升级;后台进程本应在 3 秒时写 marker,
  // 给足 3.5 秒再断言它没有活下来(旧实现只看组长退出会放它跑完)。
  await new Promise((resolve) => setTimeout(resolve, 3_500))
  expect(existsSync(marker)).toBe(false)
})

test('rebinding keeps the admitted run on the old root and moves the next run to the new root', async () => {
  const h = makeHarness()
  const roots = mkdtempSync(join(tmpdir(), 'hw-auto-rebind-'))
  dirs.push(roots)
  const p1Root = join(roots, 'p1')
  const p2Root = join(roots, 'p2')
  mkdirSync(p1Root)
  mkdirSync(p2Root)
  const p1 = await createProject(h.profileDir, { root: p1Root, name: 'P1' })
  const p2 = await createProject(h.profileDir, { root: p2Root, name: 'P2' })
  const release = join(roots, 'release-first')
  h.releaseFiles.push(release)
  const task = await scriptTask(h.profileDir, holdCommand('first-cwd.txt', release), {
    projectId: p1.id,
    name: '改绑',
  })

  const first = await startAutomation(h, task)
  expect(first.root).toBe(resolve(p1.root))
  await poll(() => existsSync(join(p1.root, 'first-cwd.txt')))

  // 模拟「update 的在途检查之后、注册表写入之前，另一轮已按旧根准入」的窗口。
  // 路由自身的在途拒绝由本任务既有 automation.update 用例另行验证。
  const rebound = await updateAutomation(h.profileDir, task.id, {
    projectId: p2.id,
    command: nodeEval('process.stdout.write(process.cwd())'),
  })
  expect(await automationAdmissionRoot(h.routeCtx, rebound)).toBe(resolve(p2.root))
  expect(existsSync(join(p2.root, 'first-cwd.txt'))).toBe(false)

  writeFileSync(release, '1')
  await first.done
  await waitRunEnd(h.events, task.id, 1)
  expect(existsSync(join(p1.root, 'first-cwd.txt'))).toBe(true)
  expect(existsSync(join(p2.root, 'first-cwd.txt'))).toBe(false)

  const second = await startAutomation(h, rebound)
  expect(second.root).toBe(resolve(p2.root))
  await second.done
  await waitRunEnd(h.events, task.id, 2)
  // recentRuns 按时间顺序返回：appendRun 写的是 `[...existing, clipped]`
  // （automations-store.ts），recentRuns 再 `runs.slice(-limit)`（stores.ts）。
  // 所以 [0] 是首轮（holdCommand，无 stdout），[1] 才是第二轮的 cwd 输出。
  // 既有顺序证据：automations-store.spec.ts:1179 在 [r1,r2] 删掉 r2 后断言 ['r1']。
  expect((await recentRuns(h.profileDir, task.id))[1]?.output).toBe(await realpath(p2.root))
  // 旧项目目录与其中的产物不搬家、不删除。
  expect(existsSync(p1.root)).toBe(true)
})
