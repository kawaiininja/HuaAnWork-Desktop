/**
 * `result_present` 普通父会话工具与内容最小化(设计 §「结果页」/ 计划 Task 2)。
 *
 * 工具全程全局注册:可见性由会话附件 + present-as restrict 控制,执行权由 policy 的
 * attached 判定兜底。这里同时用两种证据:
 * - 直接调用注册结果,核对两阶段存储接线、返回文本最小化与重放不重复 emit;
 * - 真实 agent-loop 装配(真实 SessionStore/ToolRuntime/AgentLoop 与真实 pre-step
 *   钩子),核对「首请求」时序:agent/inbox/claimed 在 prompt assembly 之前同步刷新附件,
 *   不靠 mock 的 schemas() 或手工触发 pre-step 冒充模型请求。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi, type Mock } from 'vitest'

import type { ExpertTeamResult, RpcEvent, TaskArtifactSummary } from '../../src/client-huaanwork/rpc-types.ts'
import type { TurnAnchor } from '../../src/huaanwork-host/turn-anchors.ts'
import { createTurnAnchorStore, installTurnAnchorHooks } from '../../src/huaanwork-host/turn-anchors.ts'
import { listArtifacts, readArtifactContent } from '../../src/huaanwork-host/artifacts-host.ts'
import {
  createExpertTeamCoordinator,
  type ExpertTeamCoordinator,
} from '../../src/huaanwork-host/expert-team/coordinator.ts'
import {
  computeExpertTeamTerminalStatus,
  type ExpertTeamTerminalStatus,
} from '../../src/huaanwork-host/expert-team/orchestration.ts'
import {
  createExpertTeamRunRegistry,
  type ExpertTeamRunRegistry,
} from '../../src/huaanwork-host/expert-team/runs.ts'
import {
  attachAgentTools,
  emptyAttachments,
  isAgentToolAttached,
} from '../../src/huaanwork-guardrails/agent-attachments.ts'
import { apply as applyPresentAs } from '../../src/huaanwork-guardrails/present-as.ts'
import {
  RESULT_PRESENT_TOOL,
  makeResultPresentClaimed,
  registerResultArtifactTools,
} from '../../src/huaanwork-guardrails/result-artifact-tools.ts'
import { executeResult, validTeam, validTeamInput } from '../fixtures/expert-team/team.ts'

type ResultPresentArgs = { title: string; format: 'markdown' | 'html'; content: string; downloadName?: string }
type ToolDefinition = {
  name: string
  description: string
  execute: (args: ResultPresentArgs, exec: { agent?: unknown; callId?: string }) => Promise<{ text: string }>
}

const agentForSession = (sessionId: string) => ({ session: { id: sessionId } })

function makeToolContext(registered: Map<string, ToolDefinition>, events: RpcEvent[], anchor?: TurnAnchor) {
  const attachments = emptyAttachments()
  attachAgentTools(attachments, 'session-1', [RESULT_PRESENT_TOOL])
  return {
    tools: { register: (definition: ToolDefinition) => { registered.set(definition.name, definition); return () => undefined } },
    huaanworkAttachments: attachments,
    huaanworkTurnAnchors: { current: (sessionId: string) => sessionId === 'session-1' ? anchor : undefined },
    huaanworkEmit: (event: RpcEvent) => events.push(event),
  }
}

it('creates an artifact without returning its content', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'result-present-'))
  try {
    const registered = new Map<string, ToolDefinition>()
    const events: RpcEvent[] = []
    registerResultArtifactTools(makeToolContext(registered, events, {
      clientMessageId: 'uuid-1', startedAt: '2026-11-15T10:00:00.000Z', origin: 'advanced',
    }), profileDir)
    const result = await registered.get('result_present')!.execute({
      title: '分析报告', format: 'markdown', content: '# 正文',
    }, { agent: agentForSession('session-1'), callId: 'call-1' })
    expect(result.text).toContain('分析报告')
    expect(result.text).toContain('artifactId')
    expect(result.text).not.toContain('# 正文')
    expect(events).toContainEqual(expect.objectContaining({
      event: 'artifact/created',
      artifact: expect.objectContaining({ anchor: { kind: 'turn', clientMessageId: 'uuid-1' } }),
    }))
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})

it('embeds the five model guidelines verbatim in the tool description', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'result-present-desc-'))
  try {
    const registered = new Map<string, ToolDefinition>()
    registerResultArtifactTools(makeToolContext(registered, []), profileDir)
    const description = registered.get('result_present')!.description
    expect(description).toContain('报告、分析、列表、表格、代码说明和线性文档优先使用 Markdown')
    expect(description).toContain('需要非线性布局、图表或交互的可视化结果使用 HTML')
    expect(description).toContain('普通对话答复不调用该工具')
    expect(description).toContain('同一交付物只提交一次，不同时提交两种格式')
    expect(description).toContain('工具成功后的最终助手回复只给简短说明，不重复完整 content')
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})

it('falls back to an unanchored turn for a pre-upgrade in-flight submission', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'result-present-no-anchor-'))
  try {
    const registered = new Map<string, ToolDefinition>()
    const events: RpcEvent[] = []
    registerResultArtifactTools(makeToolContext(registered, events, undefined), profileDir)
    await registered.get('result_present')!.execute({
      title: '升级前在途回合', format: 'markdown', content: '# 正文',
    }, { agent: agentForSession('session-1'), callId: 'call-legacy-inflight' })
    expect(events).toContainEqual(expect.objectContaining({
      event: 'artifact/created',
      artifact: expect.objectContaining({ anchor: { kind: 'turn' } }),
    }))
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})

it('requires an ordinary parent attachment', () => {
  const attachments = emptyAttachments()
  expect(isAgentToolAttached(attachments, 'ordinary-parent', RESULT_PRESENT_TOOL)).toBe(false)
  attachAgentTools(attachments, 'ordinary-parent', [RESULT_PRESENT_TOOL])
  expect(isAgentToolAttached(attachments, 'ordinary-parent', RESULT_PRESENT_TOOL)).toBe(true)
  expect(isAgentToolAttached(attachments, 'automation', RESULT_PRESENT_TOOL)).toBe(false)
  expect(isAgentToolAttached(attachments, 'package-child', RESULT_PRESENT_TOOL)).toBe(false)
})

it('rejects direct execution without the attachment or the execution identity', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'result-present-unattached-'))
  try {
    const registered = new Map<string, ToolDefinition>()
    const events: RpcEvent[] = []
    registerResultArtifactTools(makeToolContext(registered, events), profileDir)
    const tool = registered.get(RESULT_PRESENT_TOOL)!
    const args = { title: '日报', format: 'markdown' as const, content: '# 正文' }

    await expect(tool.execute(args, { agent: agentForSession('session-2'), callId: 'call-other' }))
      .rejects.toThrow('result-present-not-attached')
    await expect(tool.execute(args, { agent: agentForSession('session-1') }))
      .rejects.toThrow('result-present-context-missing')
    await expect(tool.execute(args, { agent: undefined, callId: 'call-missing-agent' }))
      .rejects.toThrow('result-present-context-missing')
    expect(events).toEqual([])
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})

it('replays the same call without emitting a second artifact/created', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'result-present-replay-'))
  try {
    const registered = new Map<string, ToolDefinition>()
    const events: RpcEvent[] = []
    registerResultArtifactTools(makeToolContext(registered, events), profileDir)
    const tool = registered.get(RESULT_PRESENT_TOOL)!
    const args = { title: '周报', format: 'markdown' as const, content: '# 正文' }
    const first = await tool.execute(args, { agent: agentForSession('session-1'), callId: 'call-replay' })
    const replay = await tool.execute(args, { agent: agentForSession('session-1'), callId: 'call-replay' })
    expect(replay.text).toBe(first.text)
    expect(events.filter((event) => event.event === 'artifact/created')).toHaveLength(1)
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})

// —— 真实 agent-loop 装配:首请求时序 ——

class RequestAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  beforeFinish?: () => Promise<void>
  resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    await this.beforeFinish?.()
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function makeClaimHarness(profileDir: string) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const anchors = createTurnAnchorStore()
  const attachments = emptyAttachments()
  Object.assign(ctx, { huaanworkTurnAnchors: anchors, huaanworkAttachments: attachments })
  const adapter = new RequestAdapter()
  ctx.llm.registerAdapter(['artifact-test'], adapter)
  // 注册一个已在 ALLOWED_TOOLS 内的基准工具，避免 present-as.ts 的 restrictInternal 在未挂载
  // result_present 时因 allowed.length === 0 提前返回而跳过 tools.restrict()。
  const unregisterBaseline = ctx.tools.register(defineTool({
    name: 'read',
    description: 'baseline allowed tool for restrict testing',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async () => ({ text: 'ok' }),
  }))
  const unregister = registerResultArtifactTools(ctx as never, profileDir)
  applyPresentAs(ctx as never)
  installTurnAnchorHooks(ctx as never) // 保留真实 pre-step 的 next 链
  ctx.on('agent/inbox/claimed', makeResultPresentClaimed(ctx as never), { global: true })
  const agent = await ctx.agentLoop.create(SessionId('huaanwork-claim-test'), { provider: 'artifact-test', model: 'test' })
  return {
    ctx,
    agent,
    anchors,
    adapter,
    attachments,
    async dispose() {
      unregister()
      unregisterBaseline()
      await ctx.fiber.dispose()
    },
  }
}

type ClaimHarness = Awaited<ReturnType<typeof makeClaimHarness>>

function userMessage(text: string, source: { kind: string } = { kind: 'user' }) {
  return createUserMessage({ content: [{ type: 'text', text }], source } as never)
}

function registerTurn(h: ClaimHarness, message: { id: string }, origin: TurnAnchor['origin']) {
  return h.anchors.register({ sessionId: h.agent.session.id, clientMessageId: message.id, origin })
}

function lastRequestToolNames(h: ClaimHarness): string[] {
  return h.adapter.requests.at(-1)?.tools?.map((tool) => tool.name) ?? []
}

it('includes result_present on the first advanced request and removes it on the first compat request', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'artifact-claim-'))
  const h = await makeClaimHarness(profileDir)
  try {
    for (const origin of ['advanced', 'unknown'] as const) {
      const message = createUserMessage({ content: [{ type: 'text', text: '报告' }], source: { kind: 'user' } })
      h.anchors.register({ sessionId: h.agent.session.id, clientMessageId: message.id, origin })
      h.agent.followup(message)
      await h.agent.whenIdle()
      const names = h.adapter.requests.at(-1)!.tools?.map((tool) => tool.name) ?? []
      expect(names).toContain('read')
      expect(names.includes(RESULT_PRESENT_TOOL)).toBe(origin === 'advanced')
    }
    expect(h.adapter.requests).toHaveLength(2)
  } finally {
    await h.dispose()
    rmSync(profileDir, { recursive: true, force: true })
  }
})

it('keeps result_present out of automation-origin first requests', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'artifact-claim-automation-'))
  const h = await makeClaimHarness(profileDir)
  try {
    const message = userMessage('自动化报告')
    registerTurn(h, message, 'automation')
    h.agent.followup(message)
    await h.agent.whenIdle()

    expect(h.adapter.requests).toHaveLength(1)
    expect(lastRequestToolNames(h)).toContain('read')
    expect(lastRequestToolNames(h)).not.toContain(RESULT_PRESENT_TOOL)
    expect(isAgentToolAttached(h.attachments, h.agent.session.id, RESULT_PRESENT_TOOL)).toBe(false)
  } finally {
    await h.dispose()
    rmSync(profileDir, { recursive: true, force: true })
  }
})

it('keeps result_present out of unregistered package-child first requests', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'artifact-claim-child-'))
  const h = await makeClaimHarness(profileDir)
  try {
    // 未登记 sendToAgent 的包儿童:pre-step 只能归约为 unknown。
    const message = userMessage('包儿童报告')
    h.agent.followup(message)
    await h.agent.whenIdle()

    expect(h.adapter.requests).toHaveLength(1)
    expect(lastRequestToolNames(h)).toContain('read')
    expect(lastRequestToolNames(h)).not.toContain(RESULT_PRESENT_TOOL)
    expect(h.anchors.current(h.agent.session.id)?.origin).toBe('unknown')
    expect(isAgentToolAttached(h.attachments, h.agent.session.id, RESULT_PRESENT_TOOL)).toBe(false)
  } finally {
    await h.dispose()
    rmSync(profileDir, { recursive: true, force: true })
  }
})

it('keeps the attachment and anchor across a goal continuation turn', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'artifact-claim-goal-'))
  const h = await makeClaimHarness(profileDir)
  try {
    const first = userMessage('首轮报告')
    registerTurn(h, first, 'advanced')
    h.agent.followup(first)
    await h.agent.whenIdle()
    expect(lastRequestToolNames(h)).toContain(RESULT_PRESENT_TOOL)

    const goal = userMessage('继续完成目标', { kind: 'goal' })
    h.agent.followup(goal)
    await h.agent.whenIdle()

    expect(h.adapter.requests).toHaveLength(2)
    expect(h.anchors.current(h.agent.session.id)?.clientMessageId).toBe(first.id)
    expect(isAgentToolAttached(h.attachments, h.agent.session.id, RESULT_PRESENT_TOOL)).toBe(true)
    expect(lastRequestToolNames(h)).toContain(RESULT_PRESENT_TOOL)
  } finally {
    await h.dispose()
    rmSync(profileDir, { recursive: true, force: true })
  }
})

it('leaves the active attachment and anchor alone until a queued send is claimed', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'artifact-claim-queued-'))
  const h = await makeClaimHarness(profileDir)
  try {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    h.adapter.beforeFinish = async () => {
      entered.resolve()
      await release.promise
    }

    const first = userMessage('暂停首轮')
    registerTurn(h, first, 'advanced')
    h.agent.followup(first)
    await entered.promise
    expect(h.adapter.requests).toHaveLength(1)
    expect(isAgentToolAttached(h.attachments, h.agent.session.id, RESULT_PRESENT_TOOL)).toBe(true)

    // 第二条消息只 register 并排队;尚未 claim 就不得改变当前附件与 anchor。
    const second = userMessage('排队中的第二条')
    registerTurn(h, second, 'unknown')
    h.agent.followup(second)

    expect(h.adapter.requests).toHaveLength(1)
    expect(h.anchors.current(h.agent.session.id)?.clientMessageId).toBe(first.id)
    expect(isAgentToolAttached(h.attachments, h.agent.session.id, RESULT_PRESENT_TOOL)).toBe(true)

    release.resolve()
    await h.agent.whenIdle()

    expect(h.adapter.requests).toHaveLength(2)
    expect(h.anchors.current(h.agent.session.id)?.clientMessageId).toBe(second.id)
    expect(isAgentToolAttached(h.attachments, h.agent.session.id, RESULT_PRESENT_TOOL)).toBe(false)
    expect(lastRequestToolNames(h)).not.toContain(RESULT_PRESENT_TOOL)
  } finally {
    await h.dispose()
    rmSync(profileDir, { recursive: true, force: true })
  }
})

it('cancels the driver when the claimed-time attachment sync throws', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'artifact-claim-cancel-'))
  const h = await makeClaimHarness(profileDir)
  try {
    h.anchors.notePreStep = () => {
      throw new Error('anchor store unavailable')
    }
    const cancelSpy = vi.spyOn(h.agent, 'cancel')
    const message = userMessage('同步失败')
    registerTurn(h, message, 'advanced')
    h.agent.followup(message)
    await h.agent.whenIdle()

    expect(cancelSpy).toHaveBeenCalledWith({ kind: 'hook', reason: 'result-present-attachment-sync-failed' })
    expect(h.adapter.requests).toHaveLength(0)
  } finally {
    await h.dispose()
    rmSync(profileDir, { recursive: true, force: true })
  }
})

// —— 专家团 Artifact 交付(设计 §12.4.1 / §18.1 / 计划 Task 12) ——

const fixtureRoots: string[] = []

afterEach(() => {
  while (fixtureRoots.length > 0) rmSync(fixtureRoots.pop()!, { recursive: true, force: true })
})

type TeamFixtureOptions = {
  dispatchAttempts?: number
  validExecution?: boolean
  missingReview?: boolean
  clientMessageId?: string
  /** 首次 `noteSessionArtifact` 返回 false，模拟 commit 成功但运行关联失败。 */
  failFirstLink?: boolean
  /** 协调器报告等待队列/未 settle 成员在途。 */
  inFlight?: boolean
  /** 第二次回合读取(Prepare 之后)时同步取消运行。 */
  cancelBeforeCommit?: boolean
  /** 第二次租约读取(Prepare 之后)时同步失效租约。 */
  invalidateLeaseBeforeCommit?: boolean
}

type TeamFixture = {
  execute(args: { callId?: string; title: string; format: 'markdown' | 'html'; content: string }): Promise<string>
  runs: ExpertTeamRunRegistry
  runId: string
  emitted: RpcEvent[]
  setCurrentAnchor(clientMessageId: string): void
  noteSessionArtifactSpy: Mock<(parentSessionId: string, callId: string, artifact: TaskArtifactSummary) => boolean>
  settleTurn(): ExpertTeamTerminalStatus
  listArtifacts(): Promise<TaskArtifactSummary[]>
  readContent(artifactId: string): Promise<string>
}

function reviewResult(): ExpertTeamResult {
  return executeResult('r-review-1', {
    memberId: 'm-rev-1',
    agentRef: { source: 'local', slug: 'reviewer' },
    kind: 'review',
    inputResultIds: ['r-exec-1'],
    reviewVerdict: 'pass',
  })
}

function createdArtifacts(events: readonly RpcEvent[]): TaskArtifactSummary[] {
  const artifacts: TaskArtifactSummary[] = []
  for (const event of events) {
    if (event.event === 'artifact/created') artifacts.push(event.artifact)
  }
  return artifacts
}

/**
 * 真实 `result_present` + 真实 ArtifactHost + 真实团队注册表/协调器的一次团队回合。
 *
 * `execute` 只补当前会话锚与 `callId`；重放、封存与关联恢复都走生产分支。
 * `cancelBeforeCommit` / `invalidateLeaseBeforeCommit` 在 Prepare 之后的第二次
 * 回合/租约读取处触发，确定性覆盖 commit 前的取消与租约复查。
 */
async function makeResultPresentFixture(options: TeamFixtureOptions = {}): Promise<TeamFixture> {
  const profileDir = mkdtempSync(join(tmpdir(), 'result-present-team-'))
  fixtureRoots.push(profileDir)
  const emitted: RpcEvent[] = []
  const registry = createExpertTeamRunRegistry({ emit: (event) => emitted.push(event) })
  const coordinator = createExpertTeamCoordinator({
    runs: registry,
    resolveMemberPackage: () => undefined,
    dispatchMember: () => Promise.reject(new Error('unexpected team member dispatch')),
  })
  const lease = coordinator.begin({
    parentSessionId: 's1',
    clientMessageId: options.clientMessageId ?? 'm1',
    teamSnapshot: validTeam(),
  })
  const runId = lease.teamRunId
  registry.update(runId, (run) => {
    run.dispatchAttempts = options.dispatchAttempts ?? 1
    if (options.validExecution === true) run.results.push(executeResult('r-exec-1'))
    if (options.missingReview !== true && options.validExecution === true) run.results.push(reviewResult())
  })

  let anchorClientMessageId = options.clientMessageId ?? 'm1'
  let turnReads = 0
  let leaseReads = 0
  const runs: ExpertTeamRunRegistry = {
    ...registry,
    byTurn(parentSessionId, clientMessageId) {
      turnReads += 1
      // 第二次读取发生在 Prepare 之后:此时取消运行,commit 前复查必须读到 stopping。
      if (options.cancelBeforeCommit === true && turnReads === 2) {
        registry.requestCancel(parentSessionId, runId)
      }
      return registry.byTurn(parentSessionId, clientMessageId)
    },
  }
  const gatedCoordinator: Pick<ExpertTeamCoordinator, 'isLeaseValid' | 'hasInFlight'> = {
    hasInFlight: () => (options.inFlight === true ? true : coordinator.hasInFlight(runId)),
    isLeaseValid: (teamRunId) => {
      leaseReads += 1
      if (options.invalidateLeaseBeforeCommit === true && leaseReads === 2) {
        coordinator.invalidateLease(teamRunId)
      }
      return coordinator.isLeaseValid(teamRunId)
    },
  }

  let failFirstLink = options.failFirstLink === true
  const noteSessionArtifactSpy = vi.fn(
    (parentSessionId: string, callId: string, artifact: TaskArtifactSummary): boolean => {
      if (failFirstLink) {
        failFirstLink = false
        return false
      }
      return registry.noteSessionArtifact(parentSessionId, callId, artifact)
    },
  )
  const linkedRuns: ExpertTeamRunRegistry = { ...runs, noteSessionArtifact: noteSessionArtifactSpy }

  const attachments = emptyAttachments()
  attachAgentTools(attachments, 's1', [RESULT_PRESENT_TOOL])
  const registered = new Map<string, ToolDefinition>()
  registerResultArtifactTools({
    tools: { register: (definition: ToolDefinition) => { registered.set(definition.name, definition); return () => undefined } },
    huaanworkAttachments: attachments,
    huaanworkTurnAnchors: {
      current: (sessionId: string) => sessionId === 's1'
        ? { clientMessageId: anchorClientMessageId, startedAt: '2026-11-23T00:00:00.000Z', origin: 'advanced' as const }
        : undefined,
    },
    huaanworkEmit: (event: RpcEvent) => { emitted.push(event) },
    huaanworkExpertTeamRuns: linkedRuns,
    huaanworkExpertTeamCoordinator: gatedCoordinator,
  }, profileDir)
  const tool = registered.get(RESULT_PRESENT_TOOL)!

  let fallbackCallId = 0
  return {
    async execute(args) {
      fallbackCallId += 1
      const exec = args.callId === undefined
        ? { agent: agentForSession('s1'), callId: `call-team-${fallbackCallId}` }
        : { agent: agentForSession('s1'), callId: args.callId }
      const result = await tool.execute({
        title: args.title,
        format: args.format,
        content: args.content,
      }, exec)
      return result.text
    },
    runs: linkedRuns,
    runId,
    emitted,
    setCurrentAnchor(clientMessageId) {
      anchorClientMessageId = clientMessageId
    },
    noteSessionArtifactSpy,
    settleTurn() {
      return computeExpertTeamTerminalStatus({ run: registry.get(runId)!, finalSummaryPresent: true })
    },
    listArtifacts() {
      return listArtifacts(profileDir, 's1')
    },
    async readContent(artifactId) {
      return (await readArtifactContent(profileDir, 's1', artifactId)).toString('utf8')
    },
  }
}

it('allows an exhausted-budget partial artifact without waiving other guards', async () => {
  const { execute, runs, runId } = await makeResultPresentFixture({ dispatchAttempts: 24, missingReview: true, validExecution: true })
  await expect(execute({ title: '部分报告', format: 'markdown', content: '# 部分结论\n\n缺审说明' })).resolves.toContain('artifactId')
  const run = runs.get(runId)!
  expect(run.primaryArtifactId).toBeDefined()
  expect(run.deliverySealed).toBe(true)
  expect(run.artifactStatus).toBe('created')
})

it('recovers the persisted-anchor link on same-callId replay after an initial link failure', async () => {
  const { execute, runs, runId, setCurrentAnchor, noteSessionArtifactSpy } = await makeResultPresentFixture({ validExecution: true, clientMessageId: 'm1', failFirstLink: true })
  await execute({ callId: 'call-1', title: '主报告', format: 'markdown', content: '# 完成' })
  expect(runs.get(runId)).toMatchObject({ artifactStatus: 'pending', artifactLinkError: 'expert-team-artifact-link-failed' })
  setCurrentAnchor('m2')
  await execute({ callId: 'call-1', title: '主报告', format: 'markdown', content: '# 完成' })
  expect(runs.get(runId)).toMatchObject({ artifactStatus: 'created', deliverySealed: true })
  expect(runs.get(runId)?.artifactLinkError).toBeUndefined()
  expect(noteSessionArtifactSpy).toHaveBeenLastCalledWith('s1', 'call-1', expect.objectContaining({ anchor: { kind: 'turn', clientMessageId: 'm1' } }))
  expect(runs.byTurn('s1', 'm2')).toBeUndefined()
})

it('replays the same callId against its persisted manifest anchor even when current anchor differs, and rejects a new callId after sealing', async () => {
  const { execute, runs, runId, emitted, setCurrentAnchor } = await makeResultPresentFixture({ validExecution: true, clientMessageId: 'm1' })
  await execute({ callId: 'call-1', title: '主报告', format: 'markdown', content: '# 完成' })
  const originalArtifactId = runs.get(runId)!.primaryArtifactId!
  setCurrentAnchor('m2')
  await execute({ callId: 'call-1', title: '主报告', format: 'markdown', content: '# 完成' })
  expect(runs.get(runId)?.primaryArtifactCallId).toBe('call-1')
  expect(runs.get(runId)?.primaryArtifactId).toBe(originalArtifactId)
  expect(runs.byTurn('s1', 'm2')).toBeUndefined()
  setCurrentAnchor('m1')
  await expect(execute({ callId: 'call-2', title: '第二份', format: 'markdown', content: '# 不应创建' })).rejects.toThrow('expert-team-delivery-sealed')
  expect(emitted.filter((event) => event.event === 'artifact/created')).toHaveLength(1)
})

it('keeps artifactStatus pending on Artifact prepare/commit write failure, allows same-turn retry, and settles partial/failed if turn ends unrecovered', async () => {
  const { execute, runs, runId, emitted, settleTurn } = await makeResultPresentFixture({ validExecution: true })
  await expect(execute({ callId: 'call-big', title: '超大报告', format: 'markdown', content: 'x'.repeat(5 * 1024 * 1024 + 1) }))
    .rejects.toThrow('artifact-too-large')
  expect(runs.get(runId)).toMatchObject({ artifactStatus: 'pending', deliverySealed: false })
  expect(runs.get(runId)?.primaryArtifactId).toBeUndefined()
  expect(emitted.filter((event) => event.event === 'artifact/created')).toHaveLength(0)
  expect(settleTurn()).toBe('partial')

  const retryFix = await makeResultPresentFixture({ validExecution: true })
  await expect(retryFix.execute({ callId: 'call-big-2', title: '超大报告', format: 'markdown', content: 'x'.repeat(5 * 1024 * 1024 + 1) }))
    .rejects.toThrow('artifact-too-large')
  await expect(retryFix.execute({ callId: 'call-ok', title: '修正报告', format: 'markdown', content: '# 修正后正文' }))
    .resolves.toContain('artifactId')
  expect(retryFix.runs.get(retryFix.runId)).toMatchObject({ artifactStatus: 'created', deliverySealed: true })
})

it('discards a prepared new team artifact when cancellation or lease loss lands before commit', async () => {
  const cancelled = await makeResultPresentFixture({ validExecution: true, cancelBeforeCommit: true })
  await expect(cancelled.execute({ callId: 'call-cancelled', title: '主报告', format: 'markdown', content: '# 完成' }))
    .rejects.toThrow('expert-team-terminal')
  expect(cancelled.runs.get(cancelled.runId)).toMatchObject({ artifactStatus: 'pending', deliverySealed: false })
  expect(createdArtifacts(cancelled.emitted)).toHaveLength(0)
  expect(await cancelled.listArtifacts()).toEqual([])

  const leaseLost = await makeResultPresentFixture({ validExecution: true, invalidateLeaseBeforeCommit: true })
  await expect(leaseLost.execute({ callId: 'call-lease', title: '主报告', format: 'markdown', content: '# 完成' }))
    .rejects.toThrow('expert-team-lease-invalid')
  expect(leaseLost.runs.get(leaseLost.runId)).toMatchObject({ artifactStatus: 'pending', deliverySealed: false })
  expect(createdArtifacts(leaseLost.emitted)).toHaveLength(0)
  expect(await leaseLost.listArtifacts()).toEqual([])
})

it('records a link failure without deleting the committed artifact and settles partial', async () => {
  const fixture = await makeResultPresentFixture({ validExecution: true, failFirstLink: true })
  await expect(fixture.execute({ callId: 'call-1', title: '主报告', format: 'markdown', content: '# 完成' }))
    .resolves.toContain('artifactId')
  expect(fixture.runs.get(fixture.runId)).toMatchObject({
    artifactStatus: 'pending',
    deliverySealed: true,
    artifactLinkError: 'expert-team-artifact-link-failed',
  })
  const created = createdArtifacts(fixture.emitted)
  expect(created).toHaveLength(1)
  const artifactId = created[0]!.artifactId
  expect(await fixture.readContent(artifactId)).toBe('# 完成')
  expect(fixture.settleTurn()).toBe('partial')
})

it('refuses the budget waiver before 24 attempts, with in-flight dispatch, or without a valid execution', async () => {
  const beforeBudget = await makeResultPresentFixture({ dispatchAttempts: 23, missingReview: true, validExecution: true })
  await expect(beforeBudget.execute({ title: '缺审报告', format: 'markdown', content: '# 缺审' }))
    .rejects.toThrow('expert-team-review-incomplete')

  const inFlight = await makeResultPresentFixture({ dispatchAttempts: 24, validExecution: true, inFlight: true })
  await expect(inFlight.execute({ title: '在途报告', format: 'markdown', content: '# 在途' }))
    .rejects.toThrow('expert-team-dispatch-in-flight')

  const noExecution = await makeResultPresentFixture({ dispatchAttempts: 24, validExecution: false })
  await expect(noExecution.execute({ title: '空报告', format: 'markdown', content: '# 空' }))
    .rejects.toThrow('expert-team-no-valid-execution')
  expect(noExecution.settleTurn()).toBe('failed')
})

it('keeps later ordinary turns unaffected by a sealed team run', async () => {
  const { execute, runs, setCurrentAnchor, emitted } = await makeResultPresentFixture({ validExecution: true })
  await expect(execute({ callId: 'call-team', title: '主报告', format: 'markdown', content: '# 完成' }))
    .resolves.toContain('artifactId')
  expect(runs.byTurn('s1', 'm1')?.deliverySealed).toBe(true)

  setCurrentAnchor('m2')
  await expect(execute({ callId: 'call-ordinary', title: '普通报告', format: 'markdown', content: '# 普通' }))
    .resolves.toContain('artifactId')
  expect(runs.byTurn('s1', 'm2')).toBeUndefined()
  expect(createdArtifacts(emitted)).toHaveLength(2)
})

it('detaches result_present on a message-mode team claim and keeps it for artifact-mode teams', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  const attachments = emptyAttachments()
  const anchors = createTurnAnchorStore()
  const runs = createExpertTeamRunRegistry({ emit: () => undefined })
  Object.assign(ctx, { huaanworkAttachments: attachments, huaanworkTurnAnchors: anchors, huaanworkExpertTeamRuns: runs })
  applyPresentAs(ctx as never)
  const noteClaimed = makeResultPresentClaimed(ctx as never)
  try {
    for (const delivery of ['message', 'artifact'] as const) {
      const sessionId = `s-${delivery}`
      const message = userMessage('团队报告')
      anchors.register({ sessionId, clientMessageId: message.id, origin: 'advanced' })
      runs.begin({ parentSessionId: sessionId, clientMessageId: message.id, teamSnapshot: validTeamInput({ summary: { delivery } }) })
      // message 模式先处于挂载态(证明 claim 会摘除);artifact 模式先摘除(证明 claim 会挂载)。
      if (delivery === 'message') attachAgentTools(attachments, sessionId, [RESULT_PRESENT_TOOL])
      noteClaimed({ agent: agentForSession(sessionId) as never, message })
      expect(isAgentToolAttached(attachments, sessionId, RESULT_PRESENT_TOOL)).toBe(delivery === 'artifact')
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

it('passes the expert team holders from index.ts toolCtx to registerResultArtifactTools', () => {
  const source = readFileSync(new URL('../../src/huaanwork-host/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('const toolCtx = {')
  const end = source.indexOf('registerResultArtifactTools(toolCtx', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const toolCtxBlock = source.slice(start, end)
  expect(toolCtxBlock).toContain('huaanworkExpertTeamRuns: ctx.huaanworkExpertTeamRuns')
  expect(toolCtxBlock).toContain('huaanworkExpertTeamCoordinator: ctx.huaanworkExpertTeamCoordinator')
})
