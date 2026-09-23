/**
 * 自动化执行体(Task 4)。agent 回合用进程内 agent double(followup/whenIdle),
 * 不启动真实模型,也不 boot 未构建的 lib/。token 经 bind 后的 emit 归集。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import type { AutomationInfo, RpcEvent, RunSummary } from '../../src/client-huaanwork/rpc-types.ts'
import {
  MANUAL_CROSS_NEUTRAL_MESSAGE,
  MANUAL_CROSS_PROJECT_MESSAGE,
  automationCollector,
  automationTail,
  bindAutomationRuntime,
  enqueueAutomation,
  scriptSlotWaiters,
  type AutomationRuntime,
} from '../../src/huaanwork-host/automations-host.ts'
import { createAutomation, normalizeAutomationInput, updateAutomation } from '../../src/huaanwork-host/automations-store.ts'
import { ROUTE_TABLE, type RouteContext, type RouteHandler, type RouteRequest } from '../../src/huaanwork-host/routes.ts'
import { sessionIdFor } from '../../src/huaanwork-host/session-id.ts'
import { sessionSendBlockers, type ListedAgent } from '../../src/huaanwork-host/sessions.ts'
import { createProject, listAutomations, recentRuns } from '../../src/huaanwork-host/stores.ts'
import { neutralWorkspaceRoot } from '../../src/huaanwork-host/workspace-state.ts'

type Mode = 'immediate' | 'hang' | 'throw'

type Harness = {
  profileDir: string
  dshHome: string
  neutral: string
  events: RpcEvent[]
  followups: { sessionId: string; text: string }[]
  runtime: AutomationRuntime
  routeCtx: RouteContext
  state: {
    mode: Mode
    reply: string
    cancelDelayMs: number
    cancels: string[]
    inFlight: number
    maxInFlight: number
  }
  release: (sessionId?: string) => void
  installUserAgent: (sessionId: string, whenIdle?: () => Promise<void>) => void
  userFollowups: unknown[]
  releaseFiles: string[]
}

const dirs: string[] = []
const live: Harness[] = []

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
  const state = {
    mode: 'immediate' as Mode,
    reply: 'stub-output',
    cancelDelayMs: 0,
    cancels: [] as string[],
    inFlight: 0,
    maxInFlight: 0,
  }
  const box: { routeCtx: RouteContext | undefined } = { routeCtx: undefined }

  const runtime = {
    huaanworkApprovals: new Map(),
    huaanworkUnattended: { current: undefined },
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
            const finish = releases.get(sessionId)
            if (!finish) return
            if (state.cancelDelayMs > 0) setTimeout(finish, state.cancelDelayMs)
            else finish()
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

  const harness: Harness = {
    profileDir,
    dshHome,
    neutral,
    events,
    followups,
    runtime,
    routeCtx,
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
  await Promise.race([automationTail, new Promise((resolve) => setTimeout(resolve, 3_000))])
  sessionSendBlockers.workspaceDisplaced = false
  automationCollector.clear()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
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
  expect(accepted).toMatchObject({ queued: true })
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
  expect(sessionSendBlockers.workspaceDisplaced).toBe(false)
})

test('manual run returns queued immediately and agent runs stay serial on automationTail', async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  const project = await createProject(h.profileDir, { root: h.neutral, name: '同根' })
  const first = await agentTask(h.profileDir, { projectId: project.id, name: '先跑' })
  const second = await agentTask(h.profileDir, { projectId: project.id, name: '后跑' })

  const accepted = await Promise.race([
    handler('automation.run')(body({ id: first.id }), h.routeCtx),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('handler blocked on execution')), 1_000)),
  ])
  expect(accepted).toMatchObject({ queued: true })
  const runId = (accepted as { runId: string }).runId
  expect(runId).toEqual(expect.any(String))
  expect(runEnds(h.events, first.id)).toHaveLength(0)

  await poll(() => h.followups.length === 1)
  expect(sessionSendBlockers.agentAutomationActive).toBeGreaterThan(0)
  expect(sessionSendBlockers.workspaceDisplaced).toBe(false)

  await expect(handler('automation.run')(body({ id: second.id }), h.routeCtx)).rejects.toThrow(/后台自动化任务运行中/)
  const secondRun = enqueueAutomation(second, { trigger: 'manual', runId: 'serial-2' })
  await poll(() => sessionSendBlockers.agentAutomationQueued === 2)
  expect(h.followups).toHaveLength(1)

  h.release()
  await poll(() => h.followups.length === 2)
  h.release()
  await secondRun
  await waitRunEnd(h.events, first.id)
  await waitRunEnd(h.events, second.id)
  await automationTail
  expect(sessionSendBlockers.agentAutomationQueued).toBe(0)
  expect(sessionSendBlockers.agentAutomationActive).toBe(0)
  expect(sessionSendBlockers.workspaceDisplaced).toBe(false)
}, 15_000)

test('script concurrency stops at 2 and the third waits for a slot', async () => {
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '槽位' })
  const marks = [0, 1, 2].map((index) => join(h.neutral, `mark-${index}`))
  const releases = [0, 1, 2].map((index) => join(h.neutral, `release-${index}`))
  h.releaseFiles.push(...releases)
  const tasks = await Promise.all(
    marks.map((mark, index) =>
      scriptTask(h.profileDir, holdCommand(mark, releases[index]!), {
        projectId: project.id,
        name: `槽位-${index}`,
      }),
    ),
  )
  for (const task of tasks) await handler('automation.run')(body({ id: task.id }), h.routeCtx)
  await poll(() => marks.filter((mark) => existsSync(mark)).length === 2 && scriptSlotWaiters.length === 1)
  expect(existsSync(marks[2]!)).toBe(false)
  writeFileSync(releases[0]!, '1')
  await poll(() => existsSync(marks[2]!))
  for (const release of releases) writeFileSync(release, '1')
  for (const task of tasks) await waitRunEnd(h.events, task.id)
  expect(scriptSlotWaiters).toHaveLength(0)
  expect(sessionSendBlockers.agentAutomationActive).toBe(0)
}, 15_000)

test('agent run rejects session.send and session.cancel; script run lets session.send through', async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  const project = await createProject(h.profileDir, { root: h.neutral, name: '门' })
  const agent = await agentTask(h.profileDir, { projectId: project.id, name: '长任务' })
  await handler('automation.run')(body({ id: agent.id }), h.routeCtx)
  await poll(() => h.events.some((event) => event.event === 'automation/run-start') && h.followups.length === 1)
  await expect(handler('session.send')(body({ text: 'hi' }), h.routeCtx)).rejects.toThrow(/后台自动化任务运行中/)
  await expect(handler('session.cancel')(body({}), h.routeCtx)).rejects.toThrow(/后台自动化任务运行中/)
  expect(sessionSendBlockers.workspaceDisplaced).toBe(false)
  h.release()
  await waitRunEnd(h.events, agent.id)
  await automationTail

  const release = join(h.neutral, 'script-release')
  const mark = join(h.neutral, 'script-mark')
  h.releaseFiles.push(release)
  const script = await scriptTask(h.profileDir, holdCommand(mark, release), { projectId: project.id, name: '慢脚本' })
  h.installUserAgent(sessionIdFor(h.routeCtx.workspaceRoot.current))
  await handler('automation.run')(body({ id: script.id }), h.routeCtx)
  await poll(() => h.events.some((event) => event.event === 'automation/run-start' && 'automationId' in event && event.automationId === script.id))
  expect(sessionSendBlockers.agentAutomationActive).toBe(0)
  const sent = await handler('session.send')(body({ text: 'hi' }), h.routeCtx)
  expect(sent).toMatchObject({ queued: true })
  expect(h.userFollowups).toHaveLength(1)
  writeFileSync(release, '1')
  await waitRunEnd(h.events, script.id)
}, 15_000)

test('tokens attribute to the run session and approvals stay isolated across a concurrent script', async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  const project = await createProject(h.profileDir, { root: h.neutral, name: '归因' })
  const agent = await agentTask(h.profileDir, { projectId: project.id, name: '归因任务' })
  const release = join(h.neutral, 'slow-release')
  h.releaseFiles.push(release)
  const script = await scriptTask(h.profileDir, holdCommand(join(h.neutral, 'slow-mark'), release), {
    projectId: project.id,
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
}, 15_000)

test('unattended allow degrades an ask, writes an audit line, and never admits run_code', async () => {
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
  const scope = h.runtime.huaanworkUnattended?.current
  expect(scope?.automationId).toBe(automation.id)
  expect(scope?.allow.has('run_code')).toBe(false)
  expect(scope?.allow.has(shell)).toBe(true)
  expect(scope?.allow.has('read')).toBe(true)

  const { apply } = await import('../../src/huaanwork-guardrails/policy.ts')
  type PreExecute = (
    execution: { name: string; arguments: unknown; callId?: string },
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string }>
  const listeners: PreExecute[] = []
  apply({
    huaanworkUnattended: h.runtime.huaanworkUnattended,
    huaanworkDshHome: h.profileDir,
    huaanworkAllowedOnce: new Set<string>(),
    huaanworkWorkspaceRoot: h.routeCtx.workspaceRoot,
    on(event: string, listener: PreExecute) {
      if (event === 'tools/pre-execute') listeners.push(listener)
    },
    tools: { guard: () => () => undefined },
  } as never)
  const decision = await listeners[0]?.(
    { name: shell, arguments: { command: 'ls -la' }, callId: 'call-1' },
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
  expect(h.runtime.huaanworkUnattended?.current).toBeUndefined()
}, 15_000)

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

test('automation-fire envelope and merged 4KB prefix', async () => {
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
}, 15_000)

test('timeout is status timeout for a hung agent, a hung script, and a plain error stays error', async () => {
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
  expect(timed.output).toContain('自动化任务执行超时')
  await automationTail

  const slow = await scriptTask(h.profileDir, nodeEval('setTimeout(() => {}, 30000)'), {
    projectId: project.id,
    name: '超时脚本',
  })
  await handler('automation.run')(body({ id: slow.id }), h.routeCtx)
  await waitRunEnd(h.events, slow.id)
  const scriptRun = (await recentRuns(h.profileDir, slow.id))[0] as RunSummary
  expect(scriptRun.status).toBe('timeout')
  expect(scriptRun.output).toMatch(/任务超时/)

  h.state.mode = 'throw'
  const broken = await agentTask(h.profileDir, { projectId: project.id, name: '失败任务' })
  await handler('automation.run')(body({ id: broken.id }), h.routeCtx)
  await waitRunEnd(h.events, broken.id)
  const failed = (await recentRuns(h.profileDir, broken.id))[0] as RunSummary
  expect(failed.status).toBe('error')
  expect(failed.output).toContain('agent boom')
}, 15_000)

test('manual cross-root runs are rejected; schedule and catchup are not enqueued', async () => {
  const h = makeHarness()
  const other = mkdtempSync(join(tmpdir(), 'hw-auto-other-'))
  dirs.push(other)
  const project = await createProject(h.profileDir, { root: other, name: '别的项目' })
  const bound = await scriptTask(h.profileDir, nodeEval("process.stdout.write('ran')"), {
    projectId: project.id,
    name: '跨根',
  })
  await expect(handler('automation.run')(body({ id: bound.id }), h.routeCtx)).rejects.toThrow(MANUAL_CROSS_PROJECT_MESSAGE)
  expect(h.events.some((event) => event.event === 'automation/run-start')).toBe(false)

  await enqueueAutomation(bound, { trigger: 'schedule' })
  await enqueueAutomation(bound, { trigger: 'catchup', coalescedCount: 2 })
  expect(h.events.some((event) => event.event === 'automation/run-start')).toBe(false)
  expect(sessionSendBlockers.agentAutomationQueued).toBe(0)

  h.routeCtx.workspaceRoot.current = other
  await enqueueAutomation(bound, { trigger: 'schedule' })
  const ended = await waitRunEnd(h.events, bound.id)
  expect(ended).toMatchObject({ ok: true })

  const away = mkdtempSync(join(tmpdir(), 'hw-auto-away-'))
  dirs.push(away)
  h.routeCtx.workspaceRoot.current = away
  const neutralTask = await agentTask(h.profileDir, { name: '中立', prompt: '冷知识' })
  await expect(handler('automation.run')(body({ id: neutralTask.id }), h.routeCtx)).rejects.toThrow(
    MANUAL_CROSS_NEUTRAL_MESSAGE,
  )
}, 15_000)

test('unbound agent runs on the neutral root and a vanished project still queues a failed run', async () => {
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
  expect((await recentRuns(h.profileDir, script.id))[0]?.output).toBe(await realpath(h.neutral))

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
  expect((await recentRuns(h.profileDir, ghost.id))[0]?.output).toMatch(/任务所属项目不存在/)
}, 15_000)

test('pruneSessions keeps collector and recorded sessions', async () => {
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
}, 15_000)

test('agentIdle rejects a manual run while the user agent is busy', async () => {
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '忙' })
  const automation = await agentTask(h.profileDir, { projectId: project.id })
  h.installUserAgent(sessionIdFor(h.neutral), () => new Promise<void>(() => undefined))
  await expect(handler('automation.run')(body({ id: automation.id }), h.routeCtx)).rejects.toThrow(
    /当前对话仍在进行/,
  )
  expect(h.events.some((event) => event.event === 'automation/run-start')).toBe(false)
}, 15_000)

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
    await expect(enqueueAutomation(automation, { trigger: 'manual', runId: 'disk-1' })).resolves.toBeUndefined()
    await automationTail
    expect(sessionSendBlockers.agentAutomationQueued).toBe(0)
    expect(sessionSendBlockers.agentAutomationActive).toBe(0)
    const queued = await handler('automation.run')(body({ id: automation.id }), h.routeCtx)
    expect(queued).toMatchObject({ queued: true })
    await automationTail
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(rejections).toEqual([])
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

test('agent timeout cancels the session and settles the turn before the next agent starts', async () => {
  const h = makeHarness()
  h.state.mode = 'hang'
  h.state.cancelDelayMs = 40
  writeFileSync(join(h.profileDir, 'huaanwork-settings.json'), JSON.stringify({ automation_timeout_ms: 180 }))
  const project = await createProject(h.profileDir, { root: h.neutral, name: '超时串行' })
  const first = await agentTask(h.profileDir, { projectId: project.id, name: '先超时' })
  const second = await agentTask(h.profileDir, { projectId: project.id, name: '后超时' })
  const firstRun = enqueueAutomation(first, { trigger: 'manual', runId: 'timeout-1' })
  await poll(() => h.followups.length === 1)
  const secondRun = enqueueAutomation(second, { trigger: 'manual', runId: 'timeout-2' })
  await firstRun
  await secondRun
  expect(h.state.maxInFlight).toBe(1)
  expect(h.state.cancels).toEqual([h.followups[0]?.sessionId, h.followups[1]?.sessionId])
  expect(h.state.inFlight).toBe(0)
}, 15_000)

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

test('two parallel script tasks do not lock workspace.open', async () => {
  const h = makeHarness()
  const other = mkdtempSync(join(tmpdir(), 'hw-auto-open-'))
  dirs.push(other)
  const project = await createProject(h.profileDir, { root: h.neutral, name: '并行' })
  const marks = [0, 1].map((index) => join(h.neutral, `open-mark-${index}`))
  const releases = [0, 1].map((index) => join(h.neutral, `open-release-${index}`))
  h.releaseFiles.push(...releases)
  const tasks = await Promise.all(
    marks.map((mark, index) =>
      scriptTask(h.profileDir, holdCommand(mark, releases[index]!), {
        projectId: project.id,
        name: `并行脚本-${index}`,
      }),
    ),
  )
  for (const task of tasks) void handler('automation.run')(body({ id: task.id }), h.routeCtx)
  await poll(() => marks.every((mark) => existsSync(mark)) && h.events.filter((event) => event.event === 'automation/run-start').length === 2)
  expect(h.events.some((event) => event.event === 'automation/run-end')).toBe(false)

  h.routeCtx.requestRestart = async () => true
  const opened = await handler('workspace.open')(body({ root: other }), h.routeCtx)
  expect(opened).toEqual({ restarting: true, workspaceRoot: resolve(other) })

  for (const release of releases) writeFileSync(release, '1')
  for (const task of tasks) await waitRunEnd(h.events, task.id)
}, 15_000)

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
