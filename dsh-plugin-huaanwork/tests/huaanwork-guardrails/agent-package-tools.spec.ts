import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { reasonToolUnattached } from '@huaanwork/policy'

import type { RpcEvent } from '../../src/client-huaanwork/rpc-types.ts'
import {
  attachAgentTools,
  emptyAttachments,
  isAgentToolAttached,
  type AttachmentMaps,
} from '../../src/huaanwork-guardrails/agent-attachments.ts'
import {
  AGENT_COMMIT_TOOL,
  AGENT_PROPOSE_TOOL,
  registerAgentPackageCreationTools,
} from '../../src/huaanwork-guardrails/agent-package-tools.ts'
import { apply as applyPolicy } from '../../src/huaanwork-guardrails/policy.ts'
import type {
  AgentPackageConfirmCard,
  AgentPackageProposalInput,
} from '../../src/huaanwork-host/agent-package/types.ts'
import type { AgentPackageHost } from '../../src/huaanwork-host/agent-package/host.ts'
import type { CommitResult } from '../../src/huaanwork-host/agent-package/drafts.ts'

const PRESENT_AS_STATE = Symbol.for('huaanwork.presentAs.restrictState')
const POLICY = (reason: string) => `huaanwork-policy: ${reason}`

const CARD: AgentPackageConfirmCard = {
  displayName: '周报小助手',
  slug: 'weekly-report',
  description: '把一周工作整理成周报',
  personaSummary: '写周报',
  skillSummary: '无专属技能包',
  tools: 'none',
  toolLabel: '不要',
  warning: '脚本将在本机沙箱中运行',
  consentHint: '回复「可以」创建（默认关闭）；回复「取消」放弃。',
}

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
}

function harness(options: { routeAgent?: unknown } = {}): Harness {
  const registered = new Map<string, CapturedTool>()
  const events: RpcEvent[] = []
  const restrictCalls: string[] = []
  const maps = emptyAttachments()
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
    huaanworkRouteAgent: { current: options.routeAgent },
    root: {
      [PRESENT_AS_STATE]: {
        restrict: () => undefined,
        restrictAll: () => undefined,
        restrictSession: (sessionId: string) => restrictCalls.push(sessionId),
      },
    },
  }
  return { ctx, registered, events, restrictCalls, maps }
}

function fakeHost(overrides: Partial<AgentPackageHost> = {}): AgentPackageHost {
  return {
    propose: async () => ({ ok: true, draftId: 'draft-1', slug: 'weekly-report', mode: 'create', card: CARD, cardText: 'CARD TEXT' }),
    commit: async () => ({
      ok: true,
      draftId: 'draft-1',
      slug: 'weekly-report',
      packagePath: '/tmp/agents/weekly-report',
      card: CARD,
      cardText: 'CARD TEXT',
      alreadyCommitted: false,
    }),
    cancel: async () => true,
    hasDraft: () => true,
    beginUpdate: async () => undefined,
    lastUserText: () => '可以',
    noteUserText: () => undefined,
    listLocal: () => [],
    detail: () => undefined,
    setEnabled: () => undefined,
    ...overrides,
  }
}

function execFor(sessionId: string): unknown {
  return { agent: { id: sessionId, session: { id: sessionId } }, signal: new AbortController().signal }
}

const proposalArgs = {
  mode: 'create',
  displayName: '周报小助手',
  slug: 'weekly-report',
  description: '把一周工作整理成周报',
  persona: '你是周报助手。',
  personaSummary: '写周报',
  skillSummary: '无专属技能包',
  skill: {
    summary: '整理本周工作',
    markdown: '---\nname: weekly-report\n---\n正文',
    scripts: [{ path: 'skill/scripts/collect.mjs', content: 'export const ok = true\n' }],
  },
  allowSkills: ['pdf'],
  tools: 'none',
}

let roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-package-tools-'))
  roots.push(root)
  return root
}

describe('isAgentToolAttached', () => {
  test('reads the per-session agent tool set and rejects missing inputs', () => {
    const maps = emptyAttachments()
    expect(isAgentToolAttached(maps, 'session-a', AGENT_PROPOSE_TOOL)).toBe(false)
    attachAgentTools(maps, 'session-a', [AGENT_PROPOSE_TOOL, AGENT_COMMIT_TOOL])
    expect(isAgentToolAttached(maps, 'session-a', AGENT_PROPOSE_TOOL)).toBe(true)
    expect(isAgentToolAttached(maps, 'session-b', AGENT_PROPOSE_TOOL)).toBe(false)
    expect(isAgentToolAttached(undefined, 'session-a', AGENT_PROPOSE_TOOL)).toBe(false)
    expect(isAgentToolAttached(maps, undefined, AGENT_PROPOSE_TOOL)).toBe(false)
    expect(isAgentToolAttached(maps, 'session-a', '')).toBe(false)
  })
})

describe('policy gating for the four package tools', () => {
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

  const TOOL_NAMES = [AGENT_PROPOSE_TOOL, AGENT_COMMIT_TOOL, 'agent_skill_run', 'agent_http']

  test('unattached package tools are denied and attached ones ask in ask mode', async () => {
    const maps = emptyAttachments()
    const { preExecute, guard } = policyHarness(maps)
    const exec = (name: string, sessionId: string) => ({ name, arguments: {}, agent: { session: { id: sessionId } } })

    for (const name of TOOL_NAMES) {
      expect(await preExecute(exec(name, 'session-a'), async () => ({ kind: 'allow' }))).toEqual({
        kind: 'deny',
        reason: POLICY(reasonToolUnattached(name)),
      })
    }
    expect(guard(exec(AGENT_PROPOSE_TOOL, 'session-a'))).toBe(
      `huaanwork-guard: ${reasonToolUnattached(AGENT_PROPOSE_TOOL)}`,
    )

    attachAgentTools(maps, 'session-a', TOOL_NAMES)
    for (const name of TOOL_NAMES) {
      expect(await preExecute(exec(name, 'session-a'), async () => ({ kind: 'allow' }))).toEqual({ kind: 'ask' })
      expect(await preExecute(exec(name, 'session-b'), async () => ({ kind: 'allow' }))).toEqual({
        kind: 'deny',
        reason: POLICY(reasonToolUnattached(name)),
      })
    }
  })

  test('full mode lets attached package tools through to the next guard', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'huaanwork-settings.json'), JSON.stringify({ guard_mode: 'full' }), 'utf8')
    const maps = emptyAttachments()
    attachAgentTools(maps, 'session-a', TOOL_NAMES)
    const { preExecute } = policyHarness(maps, root)
    const allowed = async () => ({ kind: 'allow' as const })

    expect(
      await preExecute({ name: AGENT_PROPOSE_TOOL, arguments: {}, agent: { session: { id: 'session-a' } } }, allowed),
    ).toEqual({ kind: 'allow' })
    expect(
      await preExecute({ name: AGENT_COMMIT_TOOL, arguments: {}, agent: { session: { id: 'session-b' } } }, allowed),
    ).toEqual({ kind: 'deny', reason: POLICY(reasonToolUnattached(AGENT_COMMIT_TOOL)) })
  })
})

describe('agent_propose', () => {
  test('declares the proposal fields and modes, with mode required', () => {
    const host = fakeHost()
    const h = harness()
    const dispose = registerAgentPackageCreationTools(h.ctx, host)
    const tool = h.registered.get(AGENT_PROPOSE_TOOL)
    expect(tool).toBeDefined()
    expect(Object.keys(tool?.parameters.properties ?? {}).sort()).toEqual(
      [
        'allowSkills',
        'description',
        'displayName',
        'httpServer',
        'mcpServer',
        'mode',
        'persona',
        'personaSummary',
        'skill',
        'skillSummary',
        'slug',
        'tools',
      ].sort(),
    )
    expect(tool?.parameters.required).toEqual(['mode'])
    dispose()
    expect(h.registered.size).toBe(0)
  })

  test('returns the host card text and emits the structured confirm event', async () => {
    const calls: Array<{ sessionId: string; input: AgentPackageProposalInput }> = []
    const host = fakeHost({
      propose: async (sessionId, input) => {
        calls.push({ sessionId, input })
        return { ok: true, draftId: 'draft-1', slug: 'weekly-report', mode: 'create', card: CARD, cardText: 'CARD TEXT' }
      },
    })
    const h = harness()
    registerAgentPackageCreationTools(h.ctx, host)
    const tool = h.registered.get(AGENT_PROPOSE_TOOL)

    const value = await tool?.execute(proposalArgs, execFor('session-a'))
    expect(value).toEqual({ text: 'CARD TEXT' })
    expect(calls).toEqual([{ sessionId: 'session-a', input: proposalArgs }])
    expect(h.events).toEqual([{ event: 'agent/confirm', card: CARD, sessionId: 'session-a' }])
  })

  test('returns field errors and a notice without a confirm card', async () => {
    const host = fakeHost({
      propose: async () => ({ ok: false, fieldErrors: [{ field: 'slug', message: '智能体 @weekly-report 已存在' }] }),
    })
    const h = harness()
    registerAgentPackageCreationTools(h.ctx, host)
    const tool = h.registered.get(AGENT_PROPOSE_TOOL)

    const value = await tool?.execute(proposalArgs, execFor('session-a'))
    expect(value?.text).toContain('slug: 智能体 @weekly-report 已存在')
    expect(h.events.some((event) => event.event === 'agent/confirm')).toBe(false)
    expect(h.events.find((event) => event.event === 'agent/notice')).toMatchObject({ sessionId: 'session-a' })
  })

  test('resolves the session from the route-agent fallback', async () => {
    const calls: string[] = []
    const host = fakeHost({
      propose: async (sessionId) => {
        calls.push(sessionId)
        return { ok: true, draftId: 'draft-1', slug: 'weekly-report', mode: 'create', card: CARD, cardText: 'CARD TEXT' }
      },
    })
    const h = harness({ routeAgent: { id: 'huaanwork', session: { id: 'session-route' } } })
    registerAgentPackageCreationTools(h.ctx, host)
    await h.registered.get(AGENT_PROPOSE_TOOL)?.execute(proposalArgs, {})
    expect(calls).toEqual(['session-route'])
  })
})

describe('agent_commit', () => {
  test('commits with the last user text, then announces, emits changed, and detaches', async () => {
    const commitCalls: Array<{ sessionId: string; draftId: string; rawUserText: string }> = []
    const host = fakeHost({
      commit: async (sessionId, draftId, rawUserText): Promise<CommitResult> => {
        commitCalls.push({ sessionId, draftId, rawUserText })
        return {
          ok: true,
          draftId,
          slug: 'weekly-report',
          packagePath: '/tmp/agents/weekly-report',
          card: CARD,
          cardText: 'CARD TEXT',
          alreadyCommitted: false,
        }
      },
    })
    const h = harness()
    attachAgentTools(h.maps, 'session-a', [AGENT_PROPOSE_TOOL, AGENT_COMMIT_TOOL])
    registerAgentPackageCreationTools(h.ctx, host)
    const tool = h.registered.get(AGENT_COMMIT_TOOL)
    expect(tool?.parameters.required).toEqual(['draftId'])
    expect(tool?.parameters.properties?.draftId).toMatchObject({ type: 'string' })

    const value = await tool?.execute({ draftId: 'draft-1' }, execFor('session-a'))

    expect(commitCalls).toEqual([{ sessionId: 'session-a', draftId: 'draft-1', rawUserText: '可以' }])
    expect(value?.text).toContain('已写入智能体 @weekly-report')
    expect(h.events).toContainEqual({ event: 'agent/notice', text: value?.text, sessionId: 'session-a' })
    expect(h.events).toContainEqual({ event: 'agent/changed', slug: 'weekly-report' })
    expect(isAgentToolAttached(h.maps, 'session-a', AGENT_PROPOSE_TOOL)).toBe(false)
    expect(isAgentToolAttached(h.maps, 'session-a', AGENT_COMMIT_TOOL)).toBe(false)
    expect(h.restrictCalls).toEqual(['session-a'])
  })

  test('reports a rejected commit without changing state or detaching', async () => {
    const host = fakeHost({
      commit: async (): Promise<CommitResult> => ({ ok: false, error: '用户原句不是同意创建的说法' }),
    })
    const h = harness()
    attachAgentTools(h.maps, 'session-a', [AGENT_PROPOSE_TOOL, AGENT_COMMIT_TOOL])
    registerAgentPackageCreationTools(h.ctx, host)

    const value = await h.registered.get(AGENT_COMMIT_TOOL)?.execute({ draftId: 'draft-1' }, execFor('session-a'))
    expect(value?.text).toContain('智能体未写入：用户原句不是同意创建的说法')
    expect(h.events.some((event) => event.event === 'agent/changed')).toBe(false)
    expect(h.events.some((event) => event.event === 'agent/notice')).toBe(false)
    expect(isAgentToolAttached(h.maps, 'session-a', AGENT_COMMIT_TOOL)).toBe(true)
  })

  test('an idempotent repeat commit still announces the existing package', async () => {
    const host = fakeHost({
      commit: async (): Promise<CommitResult> => ({
        ok: true,
        draftId: 'draft-1',
        slug: 'weekly-report',
        packagePath: '/tmp/agents/weekly-report',
        card: CARD,
        cardText: 'CARD TEXT',
        alreadyCommitted: true,
      }),
    })
    const h = harness()
    registerAgentPackageCreationTools(h.ctx, host)

    const value = await h.registered.get(AGENT_COMMIT_TOOL)?.execute({ draftId: 'draft-1' }, execFor('session-a'))
    expect(value?.text).toContain('已在之前写入')
    expect(h.events).toContainEqual({ event: 'agent/changed', slug: 'weekly-report' })
  })

  test('refuses to run without a resolvable session', async () => {
    const calls: string[] = []
    const host = fakeHost({
      commit: async (sessionId): Promise<CommitResult> => {
        calls.push(sessionId)
        return { ok: false, error: 'should not run' }
      },
    })
    const h = harness()
    registerAgentPackageCreationTools(h.ctx, host)

    await expect(h.registered.get(AGENT_COMMIT_TOOL)?.execute({ draftId: 'draft-1' }, {})).rejects.toThrow(/会话/)
    expect(calls).toEqual([])
  })
})
