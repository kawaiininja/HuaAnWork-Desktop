import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionSeq, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { attachAgentTools, emptyAttachments, isAgentToolAttached } from '../../src/huaanwork-guardrails/agent-attachments.ts'
import {
  EXPERT_TEAM_DISPATCH_TOOL,
  makeExpertTeamClaimed,
} from '../../src/huaanwork-guardrails/expert-team-dispatch.ts'
import type {
  AgentPackageDetail,
  AgentPackageListItem,
} from '../../src/huaanwork-host/agent-package/types.ts'
import type { AgentsHost } from '../../src/huaanwork-host/agents-host.ts'
import {
  createExpertTeamCoordinator,
  renderExpertTeamDispatchPrompt,
  type ExpertTeamCoordinator,
  type ExpertTeamDispatchInput,
  type ExpertTeamMemberDispatcher,
} from '../../src/huaanwork-host/expert-team/coordinator.ts'
import { createExpertTeamRunRegistry, type ExpertTeamRunRegistry } from '../../src/huaanwork-host/expert-team/runs.ts'
import * as expertTeamSession from '../../src/huaanwork-host/expert-team/session.ts'
import type { ExpertTeamStore } from '../../src/huaanwork-host/expert-team/types.ts'
import type { RouteContext } from '../../src/huaanwork-host/routes.ts'
import {
  drainUserQueue,
  sessionCancel,
  sessionSend,
  setAgentPackageHost,
  setAgentsDirectory,
  type ListedAgent,
  type SessionRuntimeContext,
} from '../../src/huaanwork-host/sessions.ts'
import { writeHuaanworkSettings } from '../../src/huaanwork-host/settings.ts'
import { createTurnAnchorStore, type TurnAnchorStore } from '../../src/huaanwork-host/turn-anchors.ts'
import { createTurnScheduler } from '../../src/huaanwork-host/turn-scheduler.ts'
import { neutralWorkspaceRoot } from '../../src/huaanwork-host/workspace-state.ts'
import { executeResult, validTeam, validTeamInput } from '../fixtures/expert-team/team.ts'

/**
 * 团队会话启动、排队隔离与 turn/end 结算(设计 §11.3 / §12.1 / §12.4.2 / §13.3 / §17)。
 *
 * fixture 组合真实的 `sessionSend`/`sendToAgent`、`TurnAnchorStore`、`TurnScheduler`、
 * `AttachmentMaps`、运行注册表与协调器;只有 Agent、包列表读取与成员派发适配层是
 * 可脚本化 fake。`session.send` 的团队分支由 `at.kind='expert-team'` 识别,普通
 * `@<slug>` 路径保持不变。
 */

const SESSION_ID = 's1'
const TAB_ID = 'tab-1'
const MODEL_ID = 'm1'
const TEAM_SLUG = 'compliance-team'

/** 派工输入:字段与 Task 8 协调器 spec 同构(含 `callId`),运行身份默认指向当前团队回合。 */
type DispatchOverrides = Partial<Omit<ExpertTeamDispatchInput, 'callId' | 'parentSessionId' | 'clientMessageId' | 'memberId'>> & {
  callId?: string
  parentSessionId?: string
  clientMessageId?: string
}

let latestTeamTurn: { parentSessionId: string; clientMessageId: string } | undefined

function dispatchInput(memberId: string, overrides: DispatchOverrides = {}): ExpertTeamDispatchInput {
  const turn = latestTeamTurn ?? { parentSessionId: SESSION_ID, clientMessageId: 'm1' }
  const input: ExpertTeamDispatchInput = {
    callId: overrides.callId ?? `call-${memberId}`,
    parentSessionId: overrides.parentSessionId ?? turn.parentSessionId,
    clientMessageId: overrides.clientMessageId ?? turn.clientMessageId,
    memberId,
    kind: overrides.kind ?? 'execute',
    task: overrides.task ?? 'task',
  }
  if (overrides.inputResultIds !== undefined) input.inputResultIds = [...overrides.inputResultIds]
  if (overrides.supersedesResultId !== undefined) input.supersedesResultId = overrides.supersedesResultId
  return input
}

const session = (id: string): { id: string } => ({ id })

function turnEnd({ seq, turn, reason }: { seq: number; turn: number; reason: TurnEndReason }): SessionEvent {
  return { type: 'turn/end', seq: SessionSeq(seq), time: seq, data: { turn, reason } }
}

function makeRouteCtx(root: string): RouteContext {
  return {
    dshHome: join(root, 'dsh'),
    profileDir: root,
    workspaceRoot: { current: join(root, 'workspace') },
    emit: () => undefined,
    logger: () => undefined,
    requestRestart: async () => true,
  }
}

/** 记录 `{ global: true }` 监听并支持测试直接投递;注销时同步移除。 */
function listenerContext() {
  const listeners: Record<string, ((...args: never[]) => unknown)[]> = {}
  const ctx = {
    on(
      name: string,
      listener: (...args: never[]) => unknown,
      _options?: boolean | { global?: boolean },
    ): () => void {
      ;(listeners[name] ??= []).push(listener)
      return () => {
        const list = listeners[name]
        if (list === undefined) return
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
      }
    },
  }
  const dispatch = (name: string, ...args: unknown[]): void => {
    for (const listener of [...(listeners[name] ?? [])]) {
      ;(listener as (...callArgs: unknown[]) => unknown)(...args)
    }
  }
  return { ctx, listeners, dispatch }
}

/** 手动 idle:每次 `whenIdle()` 登记回调,`fire()` 一次性唤醒当前全部等待者。 */
function manualIdle() {
  const waiters: (() => void)[] = []
  return {
    whenIdle: () =>
      (({
        then(onFulfilled: () => void) {
          waiters.push(onFulfilled)
          return Promise.resolve()
        },
      }) as unknown) as Promise<void>,
    fire(): void {
      for (const resolve of waiters.splice(0)) resolve()
    },
  }
}

function packageList(): AgentPackageListItem[] {
  return [
    { slug: 'writer', displayName: '写作成员', description: '起草', version: '1.0.0', source: 'local', enabled: true },
    { slug: 'reviewer', displayName: '审查成员', description: '审查', version: '1.0.0', source: 'local', enabled: true },
  ]
}

function packageDetail(slug: string): AgentPackageDetail {
  const pkg = packageList().find((item) => item.slug === slug)
  if (pkg === undefined) throw new Error(`missing fixture package ${slug}`)
  return { ...pkg, persona: '', skill: null, tools: 'none', files: [] }
}

function catalogDirectory(agentInvokeSpy: () => void): AgentsHost {
  const items = [
    {
      name: TEAM_SLUG,
      source: 'catalog',
      kind: 'agent',
      description: '与团队同名的目录智能体',
      version: '1.0.0',
      enabled: true,
    },
  ]
  return {
    list: () => {
      agentInvokeSpy()
      return { items }
    },
    refresh: async () => ({ items }),
    get: async () => undefined,
    setEnabled: () => undefined,
    addEndpoint: () => ({ ok: false, fieldErrors: [] }),
    removeEndpoint: () => undefined,
    snapshotForRuntime: () => ({ items }),
  } as unknown as AgentsHost
}

type SessionFixtureOptions = {
  clientMessageId?: string
  ordinaryTurnInFlight?: boolean
  teamEnabled?: boolean
  teamDeleted?: boolean
  teamDelivery?: 'artifact' | 'message'
  sameSlugAgentExists?: boolean
  activeGoal?: boolean
  refreshRestrictThrows?: boolean
  followupError?: Error
  onBeforeFollowup?: (runs: ExpertTeamRunRegistry) => void
  cancelBeforeFollowup?: boolean
}

type SessionFixture = {
  routeCtx: RouteContext
  ctx: SessionRuntimeContext
  runs: ExpertTeamRunRegistry
  anchors: TurnAnchorStore
  attachments: ReturnType<typeof emptyAttachments>
  followups: Array<{ id: string; text: string }>
  observer: { event(target: { id?: string }, event: SessionEvent): void }
  coordinator: ExpertTeamCoordinator
  goal: { continue(): void }
  agentInvokeSpy: ReturnType<typeof vi.fn>
  resolveFollowupIdSpy: ReturnType<typeof vi.spyOn>
  listenerCount(name: string): number
  finishOrdinaryTurn(): Promise<void>
  finishTeamIdle(): Promise<void>
  afterIdle: { invokeFinally(): Promise<void> }
  sessionSend(params: Record<string, unknown>): Promise<Record<string, unknown>>
}

const RESTRICT_STATE = Symbol.for('huaanwork.presentAs.restrictState')

const fixtureRoots: string[] = []

/** 原始实现:多个 fixture 依次 spy 时仍调用真实函数,不叠加 mock。 */
const realDispatchExpertTeam = expertTeamSession.dispatchExpertTeam

afterEach(() => {
  vi.restoreAllMocks()
  setAgentPackageHost(undefined)
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function makeSessionFixture(options: SessionFixtureOptions = {}): Promise<SessionFixture> {
  // 每个 fixture 使用独立 spy:同一测试内先建后建的 fixture 不得共享计数或 mock 层次。
  vi.restoreAllMocks()
  const root = mkdtempSync(join(tmpdir(), 'expert-team-session-'))
  fixtureRoots.push(root)
  neutralWorkspaceRoot(root)
  await writeHuaanworkSettings(root, {
    models: [{ id: MODEL_ID, name: 'M1', base_url: 'http://127.0.0.1:11434/v1', model: 'm1', api_key: '' }],
    active_model_id: MODEL_ID,
  })
  const routeCtx = makeRouteCtx(root)
  applyPackageHost()
  const listeners = listenerContext()
  const anchors = createTurnAnchorStore()
  const attachments = emptyAttachments()
  const scheduler = createTurnScheduler({ maxConcurrentTurns: () => 8, modelExists: () => true })

  const agentInvokeSpy = vi.fn()
  if (options.sameSlugAgentExists === true) setAgentsDirectory(catalogDirectory(agentInvokeSpy))

  const runs = createExpertTeamRunRegistry({
    generation: 'session-spec',
    emit: (event) => {
      if (event.event !== 'expertTeam/run') return
      latestTeamTurn = {
        parentSessionId: event.run.parentSessionId,
        clientMessageId: event.run.clientMessageId,
      }
    },
  })

  const team = validTeam()
  if (options.teamEnabled === false) team.enabled = false
  if (options.teamDelivery !== undefined) team.summary.delivery = options.teamDelivery
  const store: ExpertTeamStore = {
    list: async () => (options.teamDeleted === true ? [] : [{ id: team.id, team }]),
    get: async (id) =>
      options.teamDeleted === true || id !== team.id
        ? { id, error: 'expert-team-corrupt' }
        : { id, team },
    create: async () => {
      throw new Error('expert-team-store create is not used in this fixture')
    },
    update: async () => {
      throw new Error('expert-team-store update is not used in this fixture')
    },
    setEnabled: async () => {
      throw new Error('expert-team-store setEnabled is not used in this fixture')
    },
    remove: async () => {
      throw new Error('expert-team-store remove is not used in this fixture')
    },
  }

  const dispatchMember: ExpertTeamMemberDispatcher = async () => {
    throw new Error('expert-team-member-dispatch-not-expected')
  }
  const coordinator = createExpertTeamCoordinator({
    runs,
    resolveMemberPackage: (ref) => packageDetail(ref.slug),
    dispatchMember,
    requestMemberCancel: () => undefined,
    isMemberCancelled: () => false,
  })

  const idle = manualIdle()
  const followups: Array<{ id: string; text: string }> = []
  let expectedStarts = 0
  let cancelScheduled = false
  const textOf = (message: unknown): string => {
    const content = (message as { content?: Array<{ text?: string }> }).content ?? []
    return content.map((block) => block.text ?? '').join('')
  }

  const agent: ListedAgent & { followup: (message: unknown) => void } = {
    id: SESSION_ID,
    session: { id: SESSION_ID },
    followup: (message) => {
      options.onBeforeFollowup?.(runs)
      if (options.followupError !== undefined) throw options.followupError
      const id = (message as { id?: unknown }).id
      followups.push({ id: typeof id === 'string' ? id : '', text: textOf(message) })
      listeners.dispatch('agent/inbox/claimed', {
        agent: { id: SESSION_ID, session: { id: SESSION_ID } },
        message,
        turn: 1,
      })
    },
    whenIdle: idle.whenIdle,
    cancel: () => undefined,
  }

  /** 在首次 resolveAgent 之后、follow-up 前早退分支之前撤回首轮准入(两跳微任务)。 */
  const maybeSchedulePreFollowupCancel = (): void => {
    if (options.cancelBeforeFollowup !== true || cancelScheduled) return
    cancelScheduled = true
    queueMicrotask(() => {
      queueMicrotask(() => {
        sessionCancel(ctx, routeCtx, { sessionId: SESSION_ID })
      })
    })
  }

  let restrictCalls = 0
  const ctx: SessionRuntimeContext = {
    huaanworkAttachments: attachments,
    huaanworkTurnScheduler: scheduler,
    huaanworkTurnAnchors: anchors,
    huaanworkSessionModels: new Map(),
    huaanworkSessionRoots: new Map(),
    huaanworkExpertTeamStore: store,
    huaanworkExpertTeamRuns: runs,
    huaanworkExpertTeamCoordinator: coordinator,
    on: listeners.ctx.on,
    agents: {
      get: (id) => {
        if (id !== SESSION_ID) return undefined
        maybeSchedulePreFollowupCancel()
        return agent
      },
      list: () => [agent],
      create: async () => {
        maybeSchedulePreFollowupCancel()
        return {}
      },
      resume: async () => {
        maybeSchedulePreFollowupCancel()
        return {}
      },
    },
  }
  // present-as 的 restrict 状态:`refreshRestrictThrows` 只在合同结算那一次刷新抛错,
  // claim 的首次刷新保持成功,证明结算自身 fail-closed 而不是启动失败。
  ;(ctx as unknown as Record<symbol, unknown>)[RESTRICT_STATE] = {
    restrict: () => undefined,
    restrictAll: () => undefined,
    restrictSession: () => {
      restrictCalls += 1
      if (options.refreshRestrictThrows === true && restrictCalls > 1) {
        throw new Error('restrict refresh failed')
      }
    },
  }
  // claim 处理器必须读同一个 `ctx`:附件表、锚点、运行与 restrict 状态都是同一实例。
  const claimedHandler = makeExpertTeamClaimed(ctx as never)
  listeners.ctx.on('agent/inbox/claimed', claimedHandler as never, { global: true })

  if (options.activeGoal === true) {
    // goal-round-driver 的唤醒同款:用户消息 id 与团队锚不同,source.kind='goal'。
    agent.followup({
      id: 'goal-round-1',
      role: 'user',
      content: [{ type: 'text', text: '继续目标' }],
      source: { kind: 'goal' },
    })
  }
  if (options.ordinaryTurnInFlight === true) {
    const admitted = scheduler.admitUserTurn({
      sessionId: SESSION_ID,
      tabId: TAB_ID,
      text: '先跑普通回合',
      modelId: MODEL_ID,
      root: routeCtx.workspaceRoot.current,
    })
    if (admitted.kind !== 'start') throw new Error('fixture expected the ordinary turn to start')
  }

  const observer = {
    event(target: { id?: string }, event: SessionEvent): void {
      listeners.dispatch('session/event', target, event)
    },
  }

  const goal = {
    continue(): void {
      agent.followup({
        id: 'goal-round-2',
        role: 'user',
        content: [{ type: 'text', text: '继续目标' }],
        source: { kind: 'goal' },
      })
    },
  }

  const afterIdleControl: { latest: (() => Promise<void>) | undefined } = { latest: undefined }
  vi.spyOn(expertTeamSession, 'dispatchExpertTeam').mockImplementation(async (input) => {
    const dispatched = await realDispatchExpertTeam(input)
    afterIdleControl.latest = dispatched.afterIdle
    return dispatched
  })
  const resolveFollowupIdSpy = vi.spyOn(expertTeamSession, 'resolveFollowupClientMessageId')

  const send = async (params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = (await sessionSend(ctx, routeCtx, params)) as Record<string, unknown>
    if (result.started === true || result.waiting === true) expectedStarts += 1
    return result
  }

  const finishOrdinaryTurn = async (): Promise<void> => {
    scheduler.release(SESSION_ID)
    drainUserQueue(ctx, routeCtx)
    await vi.waitFor(() => {
      expect(runs.activeBySession(SESSION_ID)).toBeDefined()
    })
  }

  const finishTeamIdle = async (): Promise<void> => {
    idle.fire()
    await vi.waitFor(() => {
      expect(followups.length).toBeGreaterThanOrEqual(expectedStarts)
    })
  }

  return {
    routeCtx,
    ctx,
    runs,
    anchors,
    attachments,
    followups,
    observer,
    coordinator,
    goal,
    agentInvokeSpy,
    resolveFollowupIdSpy,
    listenerCount: (name: string): number => listeners.listeners[name]?.length ?? 0,
    finishOrdinaryTurn,
    finishTeamIdle,
    afterIdle: {
      async invokeFinally(): Promise<void> {
        await afterIdleControl.latest?.()
      },
    },
    sessionSend: send,
  }
}

/** 团队发送参数:typed token 的 `at.kind` 决定身份,绝不回退成同名智能体。 */
function teamSend(input: { task: string; clientMessageId?: string }): Record<string, unknown> {
  return {
    text: input.task,
    tabId: TAB_ID,
    sessionId: SESSION_ID,
    modelId: MODEL_ID,
    ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
    at: { kind: 'expert-team', name: TEAM_SLUG },
  }
}

function applyPackageHost(): void {
  setAgentPackageHost({
    listWithLegacy: async () => ({ packages: packageList(), catalogAgents: [] }),
    detail: (slug: string) => {
      try {
        return packageDetail(slug)
      } catch {
        return undefined
      }
    },
    hasDraft: () => false,
    describeDraft: () => undefined,
    cancel: async () => false,
    beginUpdate: async () => undefined,
    lastUserText: () => undefined,
    noteUserText: () => undefined,
    noteCreationTurn: () => undefined,
    listLocal: () => packageList(),
    setEnabled: () => undefined,
    invocableWithLegacy: async () => ({ items: [] }),
    findInvocable: async () => undefined,
    propose: async () => {
      throw new Error('agent package propose is not used in this fixture')
    },
    commit: async () => {
      throw new Error('agent package commit is not used in this fixture')
    },
    dispatch: async () => {
      throw new Error('agent package dispatch is not used in this fixture')
    },
    dispatchTeamMember: async () => {
      throw new Error('agent package team dispatch is not used in this fixture')
    },
  } as never)
}

describe('expert team session start, queue isolation and settlement', () => {
  it('uses one followupId (both omitted and explicit top-level clientMessageId) for run, anchor and followup and rejects a second team call while active or stopping', async () => {
    const { sessionSend, runs, anchors, followups } = await makeSessionFixture({})
    await sessionSend(teamSend({ task: '审查合同' }))
    const run = runs.activeBySession(SESSION_ID)!
    const followupId = run.clientMessageId
    expect(followupId).toMatch(/^[0-9a-f-]{36}$/)
    // 通过真实 TurnAnchorStore.notePreStep 验证该 followupId 已以 origin='advanced' 登记为 pending 锚点
    expect(anchors.notePreStep(SESSION_ID, [{ role: 'user', id: followupId, source: { kind: 'user' } }], new Date().toISOString()))
      .toMatchObject({ clientMessageId: followupId, origin: 'advanced' })
    expect(followups[0]?.id).toBe(followupId)
    // 同一父会话存在活跃/stopping 专家团时，准入前即拒绝，不得进入 turn-scheduler 静默排队
    await expect(sessionSend(teamSend({ task: '第二次团队调用' }))).rejects.toThrow('expert-team-session-busy')

    // 顶层 clientMessageId 存在时同样只计算一次并贯穿 run / anchor / followup
    const explicit = await makeSessionFixture({ clientMessageId: 'explicit-uuid-1' })
    await explicit.sessionSend(teamSend({ task: '显式锚点审查', clientMessageId: 'explicit-uuid-1' }))
    expect(explicit.resolveFollowupIdSpy).toHaveBeenCalledTimes(1)
    expect(explicit.runs.activeBySession(SESSION_ID)?.clientMessageId).toBe('explicit-uuid-1')
    expect(explicit.anchors.notePreStep(SESSION_ID, [{ role: 'user', id: 'explicit-uuid-1', source: { kind: 'user' } }], new Date().toISOString()))
      .toMatchObject({ clientMessageId: 'explicit-uuid-1', origin: 'advanced' })
    expect(explicit.followups[0]?.id).toBe('explicit-uuid-1')
  })

  it('preserves at.kind="expert-team" when queued behind an ordinary turn, rejects disabled/deleted teams without @agent fallback, and releases queued ordinary turns only after settlement and attachment cleanup', async () => {
    const { sessionSend, finishOrdinaryTurn, runs, agentInvokeSpy } = await makeSessionFixture({ ordinaryTurnInFlight: true })
    const queued = await sessionSend(teamSend({ task: '排队中的合规审查' }))
    // sessions.ts 中直接启动也返回 queued: true，必须以 waiting: true, started: false 确认真正进入排队
    expect(queued).toMatchObject({ queued: true, waiting: true, started: false })
    expect(runs.activeBySession(SESSION_ID)).toBeUndefined()
    await finishOrdinaryTurn()
    expect(runs.activeBySession(SESSION_ID)?.teamSnapshot.slug).toBe(TEAM_SLUG)
    expect(agentInvokeSpy).not.toHaveBeenCalled()

    // 缓存团队已停用或删除时（即使存在同名智能体）：Host 拒绝且绝不回退成普通 @agent
    const disabledFix = await makeSessionFixture({ teamEnabled: false, sameSlugAgentExists: true })
    await expect(disabledFix.sessionSend(teamSend({ task: '停用团队' }))).rejects.toThrow(/expert-team-/)
    expect(disabledFix.runs.list({ sessionId: SESSION_ID }).runs).toEqual([])
    expect(disabledFix.agentInvokeSpy).not.toHaveBeenCalled()

    const deletedFix = await makeSessionFixture({ teamDeleted: true, sameSlugAgentExists: true })
    await expect(deletedFix.sessionSend(teamSend({ task: '已删团队' }))).rejects.toThrow(/expert-team-/)
    expect(deletedFix.agentInvokeSpy).not.toHaveBeenCalled()

    // 团队回合在途时后续普通消息排队；仅在 turn/end 结算并摘除 expert_team_dispatch 附件且 afterIdle 清理后才放行下一条排队消息
    const releaseFix = await makeSessionFixture({})
    await releaseFix.sessionSend(teamSend({ task: '先跑团队' }))
    const runId = releaseFix.runs.activeBySession(SESSION_ID)!.teamRunId
    const queuedOrdinary = await releaseFix.sessionSend({ text: '下一条普通消息', tabId: TAB_ID, sessionId: SESSION_ID })
    expect(queuedOrdinary).toMatchObject({ queued: true, waiting: true, started: false })
    expect(releaseFix.followups).toHaveLength(1)
    // claim 已按 Task 9 挂载派工工具;settlement 后必须摘除,下一条排队消息才放行。
    expect(isAgentToolAttached(releaseFix.attachments, SESSION_ID, EXPERT_TEAM_DISPATCH_TOOL)).toBe(true)
    releaseFix.observer.event(session(SESSION_ID), turnEnd({ seq: 10, turn: 1, reason: { kind: 'completed' } }))
    await releaseFix.finishTeamIdle()
    expect(releaseFix.runs.get(runId)?.status).not.toBe('running')
    expect(isAgentToolAttached(releaseFix.attachments, SESSION_ID, EXPERT_TEAM_DISPATCH_TOOL)).toBe(false)
    expect(releaseFix.followups).toHaveLength(2)
  })

  it('seals at turn/end before a goal continuation can dispatch and fails closed even if attachment refresh throws during settlement', async () => {
    const { sessionSend, coordinator, observer, goal, runs } = await makeSessionFixture({ activeGoal: true })
    await sessionSend(teamSend({ task: '审查合同' }))
    const runId = runs.activeBySession(SESSION_ID)!.teamRunId
    observer.event(session(SESSION_ID), turnEnd({ seq: 10, turn: 1, reason: { kind: 'completed' } }))
    expect(coordinator.isLeaseValid(runId)).toBe(false)
    goal.continue()
    await expect(coordinator.dispatch(dispatchInput('executor'))).rejects.toThrow('expert-team-terminal')
    expect(runs.get(runId)?.status).not.toBe('running')

    // 上游 invokeContainedSessionObservers 会收容 session/event 异常：即使摘附件/refreshAgentRestrict 抛错，也必须先失效租约并把运行收敛出 running
    const throwFix = await makeSessionFixture({ refreshRestrictThrows: true })
    await throwFix.sessionSend(teamSend({ task: '结算抛错守卫' }))
    const throwRunId = throwFix.runs.activeBySession(SESSION_ID)!.teamRunId
    expect(() => throwFix.observer.event(session(SESSION_ID), turnEnd({ seq: 10, turn: 1, reason: { kind: 'completed' } }))).not.toThrow()
    expect(throwFix.coordinator.isLeaseValid(throwRunId)).toBe(false)
    expect(throwFix.runs.get(throwRunId)?.status).not.toBe('running')
    // 摘附件/refresh 抛错按稳定协议错误记录,运行仍落地终态而不是停留在 running。
    expect(throwFix.runs.get(throwRunId)?.failure).toContain('expert-team-attachment-detach-failed')
  })

  it('fails closed with eventMissing when the started team turn never emits turn/end', async () => {
    const { sessionSend, runs, afterIdle, coordinator } = await makeSessionFixture({})
    await sessionSend(teamSend({ task: '缺 turn/end 的团队回合' }))
    const runId = runs.activeBySession(SESSION_ID)!.teamRunId
    // afterIdle 是缺失 turn/end 的唯一兜底点:立即封闭派工并按 eventMissing 写终态。
    await afterIdle.invokeFinally()
    expect(coordinator.isLeaseValid(runId)).toBe(false)
    expect(runs.get(runId)?.status).not.toBe('running')
    expect(runs.get(runId)?.failure).toContain('expert-team-turn-end-missing')
  })

  it('fails once without duplicate afterIdle settlement when resolveAgent/followup rejects or admission cancels before followup', async () => {
    const { sessionSend, runs, afterIdle, anchors } = await makeSessionFixture({ followupError: new Error('reject') })
    await expect(sessionSend(teamSend({ task: 'x' }))).rejects.toThrow('reject')
    const [failedRun] = runs.list({ sessionId: SESSION_ID }).runs
    expect(failedRun?.status).toBe('failed')
    const revAfterFail = failedRun!.revision
    await afterIdle.invokeFinally()
    expect(runs.get(failedRun!.teamRunId)?.revision).toBe(revAfterFail)
    // pending anchor 已由 sessions.ts catch 回滚，后续同 id pre-step 不得再被认作 advanced
    expect(anchors.notePreStep(SESSION_ID, [{ role: 'user', id: failedRun!.clientMessageId, source: { kind: 'user' } }], new Date().toISOString())?.origin).toBe('unknown')

    // 另测 admission.cancelled() 在 resolveAgent() 后早退（不抛错、绕过 catch）时，finally 仍调用 abortBeforeSend 且立刻释放名额
    const cancelled = await makeSessionFixture({ cancelBeforeFollowup: true })
    // 预挂派工工具:abortBeforeSend 必须把它摘除,不能只靠「本轮从未 claim」的巧合通过。
    attachAgentTools(cancelled.attachments, SESSION_ID, [EXPERT_TEAM_DISPATCH_TOOL])
    await expect(cancelled.sessionSend(teamSend({ task: 'y' }))).resolves.toMatchObject({ started: false })
    expect(cancelled.runs.activeBySession(SESSION_ID)).toBeUndefined()
    expect(cancelled.runs.hasActiveForSession(SESSION_ID)).toBe(false)
    // M-10：取消先闩入 stopping 时遵循 §12.4.2 取消优先，由 abortBeforeSend 同步收敛为 stopped，
    // 既不覆写为 failed，也不把运行留在瞬态 stopping。
    const [cancelledRun] = cancelled.runs.list({ sessionId: SESSION_ID }).runs
    expect(cancelledRun?.status).toBe('stopped')
    expect(cancelledRun?.failure).toBeUndefined()
    expect(isAgentToolAttached(cancelled.attachments, SESSION_ID, EXPERT_TEAM_DISPATCH_TOOL)).toBe(false)
    // 观察器已释放:团队会话的 session/event 全局监听归零,claimed 只剩 fixture 自己的处理器。
    expect(cancelled.listenerCount('session/event')).toBe(0)
    expect(cancelled.listenerCount('agent/inbox/claimed')).toBe(1)

    // M-10 窗口回归：取消已先闩入 stopping、随后 followup 抛错时，终态仍须收敛为 stopped 而非 failed。
    const stoppingThenThrow = await makeSessionFixture({
      onBeforeFollowup: (liveRuns) => {
        const active = liveRuns.activeBySession(SESSION_ID)
        if (active !== undefined) liveRuns.requestCancel(SESSION_ID, active.teamRunId)
      },
      followupError: new Error('reject-after-cancel'),
    })
    await expect(stoppingThenThrow.sessionSend(teamSend({ task: 'z' }))).rejects.toThrow('reject-after-cancel')
    expect(stoppingThenThrow.runs.hasActiveForSession(SESSION_ID)).toBe(false)
    const [stoppedRun] = stoppingThenThrow.runs.list({ sessionId: SESSION_ID }).runs
    expect(stoppedRun?.status).toBe('stopped')
    expect(stoppedRun?.failure).toBeUndefined()
  })

  it('rejects a second team call while the first team turn is only queued behind an ordinary turn', async () => {
    const { sessionSend, finishOrdinaryTurn, runs } = await makeSessionFixture({ ordinaryTurnInFlight: true })
    const first = await sessionSend(teamSend({ task: '第一团队排队' }))
    // 第一团队只进入等待队列:尚不存在任何团队运行,初检看不出忙碌。
    expect(first).toMatchObject({ queued: true, waiting: true, started: false })
    expect(runs.activeBySession(SESSION_ID)).toBeUndefined()
    // 调度器的团队意图(队列 + 出队启动 + 根写者)在 admitUserTurn 之前拒绝第二个团队调用。
    await expect(sessionSend(teamSend({ task: '第二团队调用' }))).rejects.toThrow('expert-team-session-busy')
    // 被拒的调用没有留下第二个队列项:普通回合结束后只启动第一团队。
    await finishOrdinaryTurn()
    expect(runs.activeBySession(SESSION_ID)?.teamSnapshot.slug).toBe(TEAM_SLUG)
    expect(runs.list({ sessionId: SESSION_ID }).runs).toHaveLength(1)
  })

  it('settles facts=undefined as eventMissing protocol error even when results exist', async () => {
    const { sessionSend, runs, ctx, afterIdle } = await makeSessionFixture({})
    await sessionSend(teamSend({ task: '缺失结算的有结果回合' }))
    const runId = runs.activeBySession(SESSION_ID)!.teamRunId
    // 先写入一条有效执行结果:旧行为会因 `facts?.eventMissing` 只判 false 而可能判 completed。
    runs.update(runId, (run) => {
      run.results.push(executeResult('result-1'))
    })
    expertTeamSession.settleExpertTeamTurn({ ctx, sessionId: SESSION_ID, teamRunId: runId, facts: undefined })
    expect(runs.get(runId)?.status).toBe('partial')
    expect(runs.get(runId)?.status).not.toBe('completed')
    expect(runs.get(runId)?.failure).toContain('expert-team-turn-end-missing')
    // afterIdle 的同一兜底不得改写已收敛终态。
    const revision = runs.get(runId)!.revision
    await afterIdle.invokeFinally()
    expect(runs.get(runId)?.revision).toBe(revision)
  })

  it('renders the leader prompt with roster, verdict markers and delivery-mode instructions', async () => {
    const artifactFix = await makeSessionFixture({})
    await artifactFix.sessionSend(teamSend({ task: '审查合同' }))
    const artifactPrompt = artifactFix.followups[0]?.text ?? ''
    // 实际注入父会话的文本就是团长提示词:任务、名册、派工工具与结构化规则。
    expect(artifactPrompt).toContain('用户任务：\n审查合同')
    expect(artifactPrompt).toContain('- m-exec-1｜执行｜@writer：提取合同关键条款并起草结论')
    expect(artifactPrompt).toContain('- m-rev-1｜审查｜@reviewer：统一合规审查并指出风险项')
    expect(artifactPrompt).toContain('expert_team_dispatch')
    // 审查标记必须逐字出现在渲染结果中。
    expect(artifactPrompt).toContain('[VERDICT: PASS]')
    expect(artifactPrompt).toContain('[VERDICT: REVISE]')
    // Artifact 模式:交付方式与最终 result_present 要求。
    expect(artifactPrompt).toContain('交付方式：Artifact（markdown）')
    expect(artifactPrompt).toContain('最终必须调用 result_present 提交主报告')
    await artifactFix.afterIdle.invokeFinally()

    // message 模式必须明确禁止 result_present,并要求直接输出非空最终汇总。
    const messageFix = await makeSessionFixture({ teamDelivery: 'message' })
    await messageFix.sessionSend(teamSend({ task: '仅会话汇总审查' }))
    const messagePrompt = messageFix.followups[0]?.text ?? ''
    expect(messagePrompt).toContain('交付方式：仅会话消息')
    expect(messagePrompt).toContain('禁止调用 result_present')
    expect(messagePrompt).not.toContain('最终必须调用 result_present')
    expect(messagePrompt).toContain('直接输出非空的最终汇总文本')
    await messageFix.afterIdle.invokeFinally()

    // 空白可选说明字段不得在团长或成员提示词里生成空标题行。
    const blankTeam = validTeamInput({
      scenarios: '',
      members: validTeamInput().members.map((member) => ({ ...member, outputInstructions: '   ' })),
      orchestration: { instructions: '' },
      review: { criteria: '  ' },
      summary: { instructions: '' },
    })
    const leaderPrompt = expertTeamSession.renderExpertTeamLeaderPrompt(blankTeam, '空可选字段检查')
    expect(leaderPrompt).not.toContain('输出要求：')
    expect(leaderPrompt).not.toContain('- 补充说明：')
    expect(leaderPrompt).not.toContain('- 审查标准：')
    expect(leaderPrompt).not.toContain('- 汇总重点：')
    const dispatchPrompt = renderExpertTeamDispatchPrompt({
      member: blankTeam.members[0]!,
      kind: 'execute',
      task: '执行',
      references: [],
    })
    expect(dispatchPrompt).not.toContain('输出要求：')
  })

  it('releases bound global observer listeners immediately on cancelAll/requestCancel without waiting for afterIdle or session deletion', async () => {
    const fix = await makeSessionFixture({})
    await fix.sessionSend(teamSend({ task: '取消时立即释放观察器' }))
    const runId = fix.runs.activeBySession(SESSION_ID)!.teamRunId
    expect(fix.listenerCount('session/event')).toBe(1)
    // agent/inbox/claimed 包含 fixture 的 claim 处理器 + 观察器监听共 2 条。
    expect(fix.listenerCount('agent/inbox/claimed')).toBe(2)

    // 不触发 afterIdle、不删除会话：直接取消即刻注销观察器全局监听并摘除派工附件。
    await fix.runs.cancelAll()
    expect(fix.runs.get(runId)?.status).toBe('stopped')
    expect(fix.listenerCount('session/event')).toBe(0)
    expect(fix.listenerCount('agent/inbox/claimed')).toBe(1)
    expect(isAgentToolAttached(fix.attachments, SESSION_ID, EXPERT_TEAM_DISPATCH_TOOL)).toBe(false)
  })
})
