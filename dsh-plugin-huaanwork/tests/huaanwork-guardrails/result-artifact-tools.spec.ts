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
import { mkdtempSync, rmSync } from 'node:fs'
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
import { expect, it, vi } from 'vitest'

import type { RpcEvent } from '../../src/client-huaanwork/rpc-types.ts'
import type { TurnAnchor } from '../../src/huaanwork-host/turn-anchors.ts'
import { createTurnAnchorStore, installTurnAnchorHooks } from '../../src/huaanwork-host/turn-anchors.ts'
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
