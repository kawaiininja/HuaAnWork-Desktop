import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { reasonToolUnattached } from '@huaanwork/policy'

import type { RpcEvent } from '../../src/client-huaanwork/rpc-types.ts'
import {
  attachAgentTools,
  emptyAttachments,
  isAgentToolAttached,
  type AttachmentMaps,
} from '../../src/huaanwork-guardrails/agent-attachments.ts'
import { apply as applyPolicy } from '../../src/huaanwork-guardrails/policy.ts'
import {
  SKILL_COMMIT_TOOL,
  SKILL_CREATION_TOOLS,
  SKILL_PROPOSE_TOOL,
  registerSkillCreationTools,
} from '../../src/huaanwork-guardrails/skill-creation-tools.ts'
import { CorruptSkillCreationDraftError } from '../../src/huaanwork-host/skill-creation-drafts.ts'
import {
  attachSkillCreationTools,
  detachSkillCreationTools,
  type SkillCreationHost,
} from '../../src/huaanwork-host/skill-creation.ts'

const PRESENT_AS_STATE = Symbol.for('huaanwork.presentAs.restrictState')
const POLICY = (reason: string) => `huaanwork-policy: ${reason}`

const PROPOSAL = {
  name: 'daily-summary',
  description: '生成日报',
  whenToUse: '需要汇总一天工作时',
  body: '整理输入并生成日报',
}

const SUCCESS_TEXT = '已保存技能 daily-summary，请在“我的技能”中启用'

type CapturedTool = {
  name: string
  description: string
  parameters: {
    type?: string
    required?: string[]
    properties?: Record<string, { type?: string; required?: boolean; description?: string }>
  }
  execute(args: unknown, exec: unknown): Promise<{ text: string }>
}

type Harness = {
  ctx: Record<string, unknown>
  registered: Map<string, CapturedTool>
  events: RpcEvent[]
  restrictCalls: string[]
  maps: AttachmentMaps
  emitToolResult(callId: string | undefined): void
}

function harness(): Harness {
  const registered = new Map<string, CapturedTool>()
  const events: RpcEvent[] = []
  const restrictCalls: string[] = []
  const maps = emptyAttachments()
  const listeners = new Set<(exec: { callId?: string }) => void>()
  const ctx = {
    tools: {
      register(definition: unknown) {
        const tool = definition as CapturedTool
        registered.set(tool.name, tool)
        return () => {
          registered.delete(tool.name)
        }
      },
    },
    huaanworkEmit: (event: RpcEvent) => events.push(event),
    huaanworkAttachments: maps,
    huaanworkOnToolResult: (listener: (exec: { callId?: string }) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    root: {
      [PRESENT_AS_STATE]: {
        restrict: () => undefined,
        restrictAll: () => undefined,
        restrictSession: (sessionId: string) => restrictCalls.push(sessionId),
      },
    },
  }
  return {
    ctx,
    registered,
    events,
    restrictCalls,
    maps,
    emitToolResult(callId) {
      for (const listener of [...listeners]) listener({ callId })
    },
  }
}

function fakeHost(overrides: Partial<SkillCreationHost> = {}): SkillCreationHost {
  return {
    propose: async () => ({ ok: true, draftId: 'draft-1', proposal: PROPOSAL }),
    commit: async (_sessionId, draftId) => ({ ok: true, draftId, name: PROPOSAL.name, alreadyCommitted: false }),
    cancel: async () => true,
    hasDraft: () => true,
    lastUserText: () => '确认',
    noteUserText: () => undefined,
    noteCreationTurn: () => undefined,
    describeDraft: () => PROPOSAL.name,
    ...overrides,
  }
}

function execFor(sessionId: string, options: { callId?: string; concludeTurn?: () => void } = {}): unknown {
  return {
    agent: { id: sessionId, session: { id: sessionId } },
    ...(options.callId === undefined ? {} : { callId: options.callId }),
    ...(options.concludeTurn === undefined ? {} : { concludeTurn: options.concludeTurn }),
  }
}

beforeEach(() => {
  // present-as 未装载时 refreshAgentRestrict 会打 console.error;本文件只断言附件与刷新调用。
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('skill_propose', () => {
  test('declares only the four proposal fields and projects them to the host', async () => {
    const calls: Array<{ sessionId: string; input: unknown }> = []
    const host = fakeHost({
      propose: async (sessionId, input) => {
        calls.push({ sessionId, input })
        return { ok: true, draftId: 'draft-1', proposal: PROPOSAL }
      },
    })
    const h = harness()
    const dispose = registerSkillCreationTools(h.ctx, host)
    const tool = h.registered.get(SKILL_PROPOSE_TOOL)
    expect(tool).toBeDefined()
    expect(Object.keys(tool?.parameters.properties ?? {}).sort()).toEqual([
      'body',
      'description',
      'name',
      'whenToUse',
    ])
    expect([...(tool?.parameters.required ?? [])].sort()).toEqual(['body', 'description', 'name'])
    expect(tool?.description).toContain('草稿编号')

    const value = await tool?.execute(PROPOSAL, execFor('session-a'))
    expect(calls).toEqual([{ sessionId: 'session-a', input: PROPOSAL }])
    // 确认卡事件只带用户可见字段,草稿编号只出现在模型结果里。
    expect(h.events).toEqual([
      {
        event: 'skill/confirm',
        card: {
          name: PROPOSAL.name,
          description: PROPOSAL.description,
          whenToUse: PROPOSAL.whenToUse,
          contentPreview: PROPOSAL.body,
        },
        sessionId: 'session-a',
      },
    ])
    expect(value?.text).toContain('草稿编号：draft-1')
    dispose()
    expect(h.registered.size).toBe(0)
  })

  test('the confirm card truncates the body preview to 500 characters', async () => {
    const host = fakeHost({
      propose: async () => ({ ok: true, draftId: 'draft-1', proposal: { ...PROPOSAL, body: '字'.repeat(600) } }),
    })
    const h = harness()
    const dispose = registerSkillCreationTools(h.ctx, host)
    const tool = h.registered.get(SKILL_PROPOSE_TOOL)

    await tool?.execute(PROPOSAL, execFor('session-a'))

    expect(h.events).toContainEqual({
      event: 'skill/confirm',
      card: {
        name: PROPOSAL.name,
        description: PROPOSAL.description,
        whenToUse: PROPOSAL.whenToUse,
        contentPreview: '字'.repeat(500),
      },
      sessionId: 'session-a',
    })
    dispose()
  })

  test('returns field errors as an error result and a notice without a confirm card', async () => {
    const host = fakeHost({
      propose: async () => ({ ok: false, fieldErrors: [{ field: 'name', message: '已存在同名技能' }] }),
    })
    const h = harness()
    registerSkillCreationTools(h.ctx, host)

    await expect(
      h.registered.get(SKILL_PROPOSE_TOOL)?.execute(PROPOSAL, execFor('session-a')),
    ).rejects.toThrow(/name: 已存在同名技能/)
    expect(h.events.filter((event) => event.event === 'skill/confirm')).toHaveLength(0)
    expect(h.events.filter((event) => event.event === 'skill/notice')).toHaveLength(1)
    expect(h.events.find((event) => event.event === 'skill/notice')).toMatchObject({ sessionId: 'session-a' })
  })

  test('turns a corrupt draft into a named notice and a model-readable error', async () => {
    const host = fakeHost({
      propose: async () => {
        throw new CorruptSkillCreationDraftError('技能创建草稿损坏(必须是 JSON 对象):/secret/path.json')
      },
    })
    const h = harness()
    registerSkillCreationTools(h.ctx, host)

    await expect(
      h.registered.get(SKILL_PROPOSE_TOOL)?.execute(PROPOSAL, execFor('session-a')),
    ).rejects.toThrow(/损坏.*\/create-skill cancel/)
    const notices = h.events.filter((event) => event.event === 'skill/notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]?.text).toContain('/create-skill cancel')
    // 原始内部异常(含路径)不得泄漏到会话事件里。
    expect(JSON.stringify(h.events)).not.toContain('/secret/path.json')
  })

  test('fails without emitting when the execution carries no agent', async () => {
    const calls: string[] = []
    const host = fakeHost({
      propose: async (sessionId) => {
        calls.push(sessionId)
        return { ok: true, draftId: 'draft-1', proposal: PROPOSAL }
      },
    })
    const h = harness()
    registerSkillCreationTools(h.ctx, host)

    await expect(h.registered.get(SKILL_PROPOSE_TOOL)?.execute(PROPOSAL, {})).rejects.toThrow(
      '当前没有可用于创建技能的会话',
    )
    expect(calls).toEqual([])
    expect(h.events).toEqual([])
  })
})

describe('skill_commit', () => {
  test('emits only success and changed, then detaches after the tool result settles', async () => {
    const host = fakeHost()
    const h = harness()
    attachAgentTools(h.maps, 'session-a', SKILL_CREATION_TOOLS)
    registerSkillCreationTools(h.ctx, host)
    const tool = h.registered.get(SKILL_COMMIT_TOOL)
    expect(tool?.parameters.required).toEqual(['draftId'])
    expect(tool?.description).toContain('草稿编号')

    let concluded = 0
    const value = await tool?.execute(
      { draftId: 'draft-1' },
      execFor('session-a', { callId: 'call-1', concludeTurn: () => { concluded += 1 } }),
    )

    expect(value?.text).toBe(SUCCESS_TEXT)
    expect(concluded).toBe(1)
    expect(h.events.filter((event) => event.event === 'skill/confirm')).toHaveLength(0)
    expect(h.events.filter((event) => event.event === 'skill/success')).toHaveLength(1)
    expect(h.events.filter((event) => event.event === 'skill/notice')).toHaveLength(0)
    const success = h.events.find((event) => event.event === 'skill/success')
    expect(success).toMatchObject({
      text: SUCCESS_TEXT,
      draftId: 'draft-1',
      name: 'daily-summary',
      sessionId: 'session-a',
    })
    expect(h.events.find((event) => event.event === 'skill/changed')).toMatchObject({
      name: 'daily-summary',
      origin: { kind: 'created' },
    })

    // 执行体内不解绑:上游按工具名重新解析结果之前,工具必须仍在附件表里。
    expect(isAgentToolAttached(h.maps, 'session-a', SKILL_PROPOSE_TOOL)).toBe(true)
    expect(isAgentToolAttached(h.maps, 'session-a', SKILL_COMMIT_TOOL)).toBe(true)
    expect(h.restrictCalls).toEqual([])

    h.emitToolResult('call-other')
    expect(isAgentToolAttached(h.maps, 'session-a', SKILL_COMMIT_TOOL)).toBe(true)

    h.emitToolResult('call-1')
    expect(isAgentToolAttached(h.maps, 'session-a', SKILL_PROPOSE_TOOL)).toBe(false)
    expect(isAgentToolAttached(h.maps, 'session-a', SKILL_COMMIT_TOOL)).toBe(false)
    expect(h.restrictCalls).toEqual(['session-a'])
  })

  test('replays the same success and changed events without a second pending detach', async () => {
    let commits = 0
    const host = fakeHost({
      commit: async (_sessionId, draftId) => {
        commits += 1
        return { ok: true, draftId, name: 'daily-summary', alreadyCommitted: commits > 1 }
      },
    })
    const h = harness()
    attachAgentTools(h.maps, 'session-a', SKILL_CREATION_TOOLS)
    registerSkillCreationTools(h.ctx, host)
    const tool = h.registered.get(SKILL_COMMIT_TOOL)

    let concluded = 0
    const first = await tool?.execute(
      { draftId: 'draft-1' },
      execFor('session-a', { callId: 'call-1', concludeTurn: () => { concluded += 1 } }),
    )
    const replay = await tool?.execute(
      { draftId: 'draft-1' },
      execFor('session-a', { callId: 'call-2', concludeTurn: () => { concluded += 1 } }),
    )

    expect(commits).toBe(2)
    expect(first?.text).toBe(SUCCESS_TEXT)
    expect(replay?.text).toBe(SUCCESS_TEXT)
    expect(concluded).toBe(2)
    const successes = h.events.filter((event) => event.event === 'skill/success')
    expect(successes).toHaveLength(2)
    for (const success of successes) {
      expect(success).toMatchObject({ draftId: 'draft-1', name: 'daily-summary' })
    }
    expect(h.events.filter((event) => event.event === 'skill/changed')).toHaveLength(2)
    expect(h.events.filter((event) => event.event === 'skill/notice')).toHaveLength(0)

    // 重放只补偿事件,不设置第二个 pendingDetach。
    h.emitToolResult('call-2')
    expect(isAgentToolAttached(h.maps, 'session-a', SKILL_COMMIT_TOOL)).toBe(true)
    h.emitToolResult('call-1')
    expect(isAgentToolAttached(h.maps, 'session-a', SKILL_COMMIT_TOOL)).toBe(false)
    expect(h.restrictCalls).toEqual(['session-a'])
  })

  test('reports a rejected commit as one notice error and never detaches', async () => {
    const host = fakeHost({
      commit: async () => ({
        ok: false,
        fieldErrors: [{ field: 'consent', message: '需要用户明确整句同意（例如「确认」）后才能创建技能' }],
      }),
    })
    const h = harness()
    attachAgentTools(h.maps, 'session-a', SKILL_CREATION_TOOLS)
    registerSkillCreationTools(h.ctx, host)

    let concluded = 0
    const failed = h.registered.get(SKILL_COMMIT_TOOL)?.execute(
      { draftId: 'draft-1' },
      execFor('session-a', { callId: 'call-fail', concludeTurn: () => { concluded += 1 } }),
    )
    await expect(failed).rejects.toThrow(/consent: 需要用户明确整句同意/)

    expect(concluded).toBe(0)
    expect(h.events.filter((event) => event.event === 'skill/notice')).toHaveLength(1)
    expect(h.events.some((event) => event.event === 'skill/success')).toBe(false)
    expect(h.events.some((event) => event.event === 'skill/changed')).toBe(false)

    h.emitToolResult('call-fail')
    expect(isAgentToolAttached(h.maps, 'session-a', SKILL_PROPOSE_TOOL)).toBe(true)
    expect(isAgentToolAttached(h.maps, 'session-a', SKILL_COMMIT_TOOL)).toBe(true)
    expect(h.restrictCalls).toEqual([])
  })

  test('turns a corrupt draft during commit into a notice error without detaching', async () => {
    const host = fakeHost({
      commit: async () => {
        throw new CorruptSkillCreationDraftError('技能创建草稿损坏(内部):/secret/path.json')
      },
    })
    const h = harness()
    attachAgentTools(h.maps, 'session-a', SKILL_CREATION_TOOLS)
    registerSkillCreationTools(h.ctx, host)

    await expect(
      h.registered.get(SKILL_COMMIT_TOOL)?.execute(
        { draftId: 'draft-1' },
        execFor('session-a', { callId: 'call-corrupt' }),
      ),
    ).rejects.toThrow(/损坏.*\/create-skill cancel/)
    expect(h.events.filter((event) => event.event === 'skill/notice')).toHaveLength(1)
    expect(JSON.stringify(h.events)).not.toContain('/secret/path.json')

    h.emitToolResult('call-corrupt')
    expect(isAgentToolAttached(h.maps, 'session-a', SKILL_COMMIT_TOOL)).toBe(true)
  })

  test('falls back to a deferred detach when the embedding has no result channel', async () => {
    const host = fakeHost()
    const h = harness()
    attachAgentTools(h.maps, 'session-a', SKILL_CREATION_TOOLS)
    registerSkillCreationTools(h.ctx, host)

    const value = await h.registered.get(SKILL_COMMIT_TOOL)?.execute({ draftId: 'draft-1' }, execFor('session-a'))
    expect(value?.text).toBe(SUCCESS_TEXT)
    expect(isAgentToolAttached(h.maps, 'session-a', SKILL_COMMIT_TOOL)).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(isAgentToolAttached(h.maps, 'session-a', SKILL_COMMIT_TOOL)).toBe(false)
    expect(h.restrictCalls).toEqual(['session-a'])
  })

  test('refuses to run without a resolvable session', async () => {
    const calls: string[] = []
    const host = fakeHost({
      commit: async (sessionId, draftId) => {
        calls.push(sessionId)
        return { ok: true, draftId, name: PROPOSAL.name, alreadyCommitted: false }
      },
    })
    const h = harness()
    registerSkillCreationTools(h.ctx, host)

    await expect(h.registered.get(SKILL_COMMIT_TOOL)?.execute({ draftId: 'draft-1' }, {})).rejects.toThrow(/会话/)
    expect(calls).toEqual([])
  })
})

describe('skill creation tool attachments', () => {
  test('attach and detach only the two skill tools for one session and refresh its restrict', () => {
    const maps = emptyAttachments()
    const restrictCalls: string[] = []
    const ctx = {
      huaanworkAttachments: maps,
      root: {
        [PRESENT_AS_STATE]: {
          restrict: () => undefined,
          restrictAll: () => undefined,
          restrictSession: (sessionId: string) => restrictCalls.push(sessionId),
        },
      },
    }
    attachAgentTools(maps, 'other-session', ['mcp__demo__echo'])

    attachSkillCreationTools(ctx, 'session-a')
    expect(isAgentToolAttached(maps, 'session-a', SKILL_PROPOSE_TOOL)).toBe(true)
    expect(isAgentToolAttached(maps, 'session-a', SKILL_COMMIT_TOOL)).toBe(true)
    expect(isAgentToolAttached(maps, 'session-b', SKILL_PROPOSE_TOOL)).toBe(false)
    expect(isAgentToolAttached(maps, 'other-session', 'mcp__demo__echo')).toBe(true)
    expect(restrictCalls).toEqual(['session-a'])

    detachSkillCreationTools(ctx, 'session-a')
    expect(isAgentToolAttached(maps, 'session-a', SKILL_PROPOSE_TOOL)).toBe(false)
    expect(isAgentToolAttached(maps, 'session-a', SKILL_COMMIT_TOOL)).toBe(false)
    expect(isAgentToolAttached(maps, 'other-session', 'mcp__demo__echo')).toBe(true)
    // 附件 Map 变更不触发上游 tools/change:挂/卸后必须马上按同一会话刷新 restrict。
    expect(restrictCalls).toEqual(['session-a', 'session-a'])
  })

  test('attach and detach are no-ops without an attachments map', () => {
    const restrictCalls: string[] = []
    const ctx = {
      root: {
        [PRESENT_AS_STATE]: {
          restrict: () => undefined,
          restrictAll: () => undefined,
          restrictSession: (sessionId: string) => restrictCalls.push(sessionId),
        },
      },
    }
    expect(() => attachSkillCreationTools(ctx, 'session-a')).not.toThrow()
    expect(() => detachSkillCreationTools(ctx, 'session-a')).not.toThrow()
    expect(restrictCalls).toEqual([])
  })
})

describe('policy gating for the two skill tools', () => {
  type PreExecute = (
    execution: {
      name: string
      arguments: Record<string, unknown>
      agent?: { id?: string; session?: { id?: string } }
      callId?: string
    },
    next: () => Promise<{ kind: 'allow' }>,
  ) => Promise<{ kind: string; reason?: string }>

  function policyHarness(maps: AttachmentMaps, profileDir?: string): {
    preExecute: PreExecute
    guard: (execution: { name: string; arguments: Record<string, unknown>; callId?: string }) => string | undefined
  } {
    let preExecute: PreExecute | undefined
    let guard:
      | ((execution: { name: string; arguments: Record<string, unknown>; callId?: string }) => string | undefined)
      | undefined
    applyPolicy({
      huaanworkWorkspaceRoot: { current: process.cwd() },
      huaanworkAttachments: maps,
      ...(profileDir !== undefined ? { huaanworkProfileDir: profileDir } : {}),
      on(event: string, listener: PreExecute) {
        if (event === 'tools/pre-execute') preExecute = listener
      },
      tools: {
        guard(listener: typeof guard) {
          guard = listener
          return () => undefined
        },
      },
    } as never)
    if (!preExecute || !guard) throw new Error('policy harness was not wired')
    return { preExecute, guard }
  }

  test('unattached skill tools are denied; attached creation tools reach the approval tier', async () => {
    const maps = emptyAttachments()
    const { preExecute, guard } = policyHarness(maps)
    const exec = (name: string, sessionId: string) => ({ name, arguments: {}, agent: { session: { id: sessionId } } })

    for (const name of SKILL_CREATION_TOOLS) {
      expect(await preExecute(exec(name, 'session-a'), async () => ({ kind: 'allow' }))).toEqual({
        kind: 'deny',
        reason: POLICY(reasonToolUnattached(name)),
      })
    }
    expect(guard(exec(SKILL_COMMIT_TOOL, 'session-a'))).toBe(
      `huaanwork-guard: ${reasonToolUnattached(SKILL_COMMIT_TOOL)}`,
    )

    attachAgentTools(maps, 'session-a', SKILL_CREATION_TOOLS)
    for (const name of SKILL_CREATION_TOOLS) {
      expect(await preExecute(exec(name, 'session-a'), async () => ({ kind: 'allow' }))).toEqual({ kind: 'ask' })
      expect(await preExecute(exec(name, 'session-b'), async () => ({ kind: 'allow' }))).toEqual({
        kind: 'deny',
        reason: POLICY(reasonToolUnattached(name)),
      })
    }
  })
})
