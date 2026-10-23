import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  AGENT_HTTP_TOOL,
  AGENT_PROPOSE_TOOL,
  AGENT_SKILL_RUN_TOOL,
  registerAgentPackageCreationTools,
  registerAgentPackageRuntimeTools,
} from '../../src/huaanwork-guardrails/agent-package-tools.ts'
import { apply as applyPolicy } from '../../src/huaanwork-guardrails/policy.ts'
import { apply as applySkills } from '../../src/huaanwork-guardrails/skills.ts'
import type {
  AgentPackageConfirmCard,
  AgentPackageProposalInput,
  AgentPackageTurnRuntime,
} from '../../src/huaanwork-host/agent-package/types.ts'
import { createAgentPackageHost, type AgentPackageHost } from '../../src/huaanwork-host/agent-package/host.ts'
import {
  createAgentPackageRuntimeRegistry,
  type StartAgentPackageProcessesOptions,
} from '../../src/huaanwork-host/agent-package/runtime.ts'
import { dispatchAt } from '../../src/huaanwork-host/agent-invoke.ts'
import { noteCallerSession, resetChildSessionRegistry } from '../../src/huaanwork-host/child-sessions.ts'
import {
  loadAgentPackageDraft,
  type CommitResult,
} from '../../src/huaanwork-host/agent-package/drafts.ts'

const PRESENT_AS_STATE = Symbol.for('huaanwork.presentAs.restrictState')
const POLICY = (reason: string) => `huaanwork-policy: ${reason}`
const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'agent-package')

const CARD: AgentPackageConfirmCard = {
  mode: 'create',
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

function harness(options: { routeAgent?: unknown; fetchImpl?: typeof fetch; httpTimeoutMs?: number } = {}): Harness {
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
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.httpTimeoutMs === undefined ? {} : { httpTimeoutMs: options.httpTimeoutMs }),
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
    findInvocable: async () => undefined,
    dispatch: async () => ({ text: '', afterIdle: async () => undefined }),
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

/** 真宿主可落盘的提案:不含需要解析已有技能/脚本的字段。 */
const committableProposal = {
  mode: 'create',
  displayName: '周报小助手',
  slug: 'weekly-report',
  description: '把一周工作整理成周报',
  persona: '你是周报助手。',
  personaSummary: '写周报',
  skillSummary: '无专属技能包',
  tools: 'none',
}

let roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  resetChildSessionRegistry()
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

  test('unattached package tools are denied; attached runtime tools allow and creation tools ask', async () => {
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
    // 创建链路仍需人工审批（创建界面弹确认）；运行链路由用户启用包授权，直接放行。
    for (const name of [AGENT_PROPOSE_TOOL, AGENT_COMMIT_TOOL]) {
      expect(await preExecute(exec(name, 'session-a'), async () => ({ kind: 'allow' }))).toEqual({ kind: 'ask' })
    }
    for (const name of ['agent_skill_run', 'agent_http']) {
      expect(await preExecute(exec(name, 'session-a'), async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })
    }
    // 真机失败点：guard 曾对附加的运行链路工具返回「需要审批且尚未获得批准」。
    expect(guard(exec('agent_http', 'session-a'))).toBeUndefined()
    expect(guard(exec('agent_skill_run', 'session-a'))).toBeUndefined()
    for (const name of TOOL_NAMES) {
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
    expect(tool?.description).toContain('草稿编号')
    expect(tool?.description).toContain('不创建智能体包目录')
    dispose()
    expect(h.registered.size).toBe(0)
  })

  test('returns the host card text plus a model-only draft id line', async () => {
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
    expect(value).toEqual({ text: 'CARD TEXT\n草稿编号：draft-1' })
    expect(calls).toEqual([{ sessionId: 'session-a', input: proposalArgs }])
    // 草稿编号只在工具结果里,确认卡事件保持用户可见字段。
    expect(h.events).toEqual([{ event: 'agent/confirm', card: CARD, sessionId: 'session-a' }])
    expect(JSON.stringify(h.events)).not.toContain('draft-1')
  })

  test('returns field errors as an error result and a notice without a confirm card', async () => {
    const host = fakeHost({
      propose: async () => ({ ok: false, fieldErrors: [{ field: 'slug', message: '智能体 @weekly-report 已存在' }] }),
    })
    const h = harness()
    registerAgentPackageCreationTools(h.ctx, host)
    const tool = h.registered.get(AGENT_PROPOSE_TOOL)

    await expect(tool?.execute(proposalArgs, execFor('session-a'))).rejects.toThrow(
      /slug: 智能体 @weekly-report 已存在/,
    )
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
    expect(tool?.description).toContain('草稿编号')

    const value = await tool?.execute({ draftId: 'draft-1' }, execFor('session-a'))

    expect(commitCalls).toEqual([{ sessionId: 'session-a', draftId: 'draft-1', rawUserText: '可以' }])
    expect(value?.text).toContain('已写入智能体 @weekly-report')
    expect(h.events).toContainEqual({ event: 'agent/notice', text: value?.text, sessionId: 'session-a' })
    expect(h.events).toContainEqual({ event: 'agent/changed', slug: 'weekly-report' })
    expect(isAgentToolAttached(h.maps, 'session-a', AGENT_PROPOSE_TOOL)).toBe(false)
    expect(isAgentToolAttached(h.maps, 'session-a', AGENT_COMMIT_TOOL)).toBe(false)
    expect(h.restrictCalls).toEqual(['session-a'])
  })

  test('update-mode success copy keeps the existing enabled state', async () => {
    const host = fakeHost({
      commit: async (_sessionId, draftId): Promise<CommitResult> => ({
        ok: true,
        draftId,
        slug: 'weekly-report',
        packagePath: '/tmp/agents/weekly-report',
        card: CARD,
        cardText: 'CARD TEXT',
        alreadyCommitted: false,
        mode: 'update',
      }),
    })
    const h = harness()
    registerAgentPackageCreationTools(h.ctx, host)

    const value = await h.registered.get(AGENT_COMMIT_TOOL)?.execute({ draftId: 'draft-1' }, execFor('session-a'))
    expect(value?.text).toContain('已更新智能体 @weekly-report')
    expect(value?.text).toContain('原有启用状态保持不变')
    expect(value?.text).not.toContain('默认关闭')
  })

  test('reports a rejected commit as an error result without changing state or detaching', async () => {
    const host = fakeHost({
      commit: async (): Promise<CommitResult> => ({ ok: false, error: '用户原句不是同意创建的说法' }),
    })
    const h = harness()
    attachAgentTools(h.maps, 'session-a', [AGENT_PROPOSE_TOOL, AGENT_COMMIT_TOOL])
    registerAgentPackageCreationTools(h.ctx, host)

    await expect(
      h.registered.get(AGENT_COMMIT_TOOL)?.execute({ draftId: 'draft-1' }, execFor('session-a')),
    ).rejects.toThrow(/智能体未写入：用户原句不是同意创建的说法/)
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

describe('propose → commit integration', () => {
  test('the draft id extracted from the propose result commits through the registered commit tool', async () => {
    const root = makeRoot()
    const sessionId = 'session-a'
    const host = createAgentPackageHost({ profileDir: root, takenSlugs: () => [] })
    const h = harness()
    attachAgentTools(h.maps, sessionId, [AGENT_PROPOSE_TOOL, AGENT_COMMIT_TOOL])
    const dispose = registerAgentPackageCreationTools(h.ctx, host)

    const proposed = await h.registered.get(AGENT_PROPOSE_TOOL)?.execute(committableProposal, execFor(sessionId))
    const proposeText = proposed?.text ?? ''
    const match = /草稿编号：(\S+)/.exec(proposeText)
    expect(match).not.toBeNull()
    const draftId = match?.[1] ?? ''
    expect(draftId).not.toBe('')
    // 编号行是工具结果的一部分,但确认卡事件里没有它。
    expect(proposeText.endsWith(`\n草稿编号：${draftId}`)).toBe(true)
    expect(JSON.stringify(h.events.find((event) => event.event === 'agent/confirm'))).not.toContain(draftId)

    // 下一轮用户同意:noteUserText 同时清掉「同一轮刚 propose」标记。
    host.noteUserText(sessionId, '可以')

    const committed = await h.registered.get(AGENT_COMMIT_TOOL)?.execute({ draftId }, execFor(sessionId))
    expect(committed?.text).toContain('已写入智能体 @weekly-report')
    expect(loadAgentPackageDraft(root, sessionId)).toBeUndefined()
    expect(isAgentToolAttached(h.maps, sessionId, AGENT_COMMIT_TOOL)).toBe(false)
    dispose()
  })
})

// —— Task 6: agent_skill_run / agent_http ——

type SkillScriptResult = { text: string; isError?: boolean }
type SkillRunImpl = (script: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<SkillScriptResult>

function fakeTurnRuntime(overrides: Partial<AgentPackageTurnRuntime> = {}): AgentPackageTurnRuntime {
  return {
    slug: 'weekly-report',
    packageDir: '/tmp/agents/weekly-report',
    workspaceRoot: '/tmp/workspace',
    httpPort: 43210,
    skillScripts: ['skill/scripts/echo.mjs'],
    runSkillScript: async () => ({ text: 'ok' }),
    ...overrides,
  }
}

function runtimeWithScript(run: SkillRunImpl): AgentPackageTurnRuntime {
  return fakeTurnRuntime({ runSkillScript: run as AgentPackageTurnRuntime['runSkillScript'] })
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function recordingFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    requests.push({ url: target, init: init ?? {} })
    return respond(target, init ?? {})
  }) as unknown as typeof fetch
  return { requests, fetchImpl }
}

describe('agent_skill_run', () => {
  test('declares script/args and forwards the resolved session, args, and signal', async () => {
    const calls: Array<{ script: string; args: Record<string, unknown>; signal?: AbortSignal }> = []
    const registry = createAgentPackageRuntimeRegistry()
    registry.bind(
      'session-a',
      runtimeWithScript(async (script, args, signal) => {
        calls.push({ script, args, ...(signal === undefined ? {} : { signal }) })
        return { text: '脚本输出' }
      }),
    )
    const h = harness()
    const dispose = registerAgentPackageRuntimeTools(h.ctx, registry)
    const tool = h.registered.get(AGENT_SKILL_RUN_TOOL)
    expect(tool).toBeDefined()
    expect(tool?.parameters.required).toEqual(['script'])
    const exec = execFor('session-a') as { signal: AbortSignal }

    await expect(tool?.execute({ script: 'skill/scripts/echo.mjs', args: { hello: '世界' } }, exec)).resolves.toEqual({
      text: '脚本输出',
    })
    expect(calls).toEqual([{ script: 'skill/scripts/echo.mjs', args: { hello: '世界' }, signal: exec.signal }])
    dispose()
    expect(h.registered.size).toBe(0)
  })

  test('rejects a script outside the declared set as a tool error', async () => {
    const registry = createAgentPackageRuntimeRegistry()
    registry.bind('session-a', runtimeWithScript(async () => ({ text: '未声明的技能脚本：skill/scripts/other.mjs', isError: true })))
    const h = harness()
    registerAgentPackageRuntimeTools(h.ctx, registry)

    await expect(
      h.registered.get(AGENT_SKILL_RUN_TOOL)?.execute({ script: 'skill/scripts/other.mjs' }, execFor('session-a')),
    ).rejects.toThrow(/未声明的技能脚本/)
  })

  test('surfaces a non-zero exit as a tool error with the script stderr', async () => {
    const registry = createAgentPackageRuntimeRegistry()
    registry.bind('session-a', runtimeWithScript(async () => ({ text: 'script-boom', isError: true })))
    const h = harness()
    registerAgentPackageRuntimeTools(h.ctx, registry)

    await expect(
      h.registered.get(AGENT_SKILL_RUN_TOOL)?.execute({ script: 'skill/scripts/echo.mjs' }, execFor('session-a')),
    ).rejects.toThrow(/script-boom/)
  })

  test('fails as a tool error when the session has no bound runtime', async () => {
    const h = harness()
    registerAgentPackageRuntimeTools(h.ctx, createAgentPackageRuntimeRegistry())

    await expect(
      h.registered.get(AGENT_SKILL_RUN_TOOL)?.execute({ script: 'skill/scripts/echo.mjs' }, execFor('session-a')),
    ).rejects.toThrow(/没有运行中的智能体包/)
  })

  test('falls back to the current caller session when the execution carries no agent', async () => {
    const calls: string[] = []
    const registry = createAgentPackageRuntimeRegistry()
    registry.bind('session-caller', runtimeWithScript(async (script) => {
      calls.push(script)
      return { text: 'ok' }
    }))
    const h = harness()
    registerAgentPackageRuntimeTools(h.ctx, registry)
    noteCallerSession('session-caller')

    await expect(h.registered.get(AGENT_SKILL_RUN_TOOL)?.execute({ script: 'skill/scripts/echo.mjs' }, {})).resolves.toEqual({
      text: 'ok',
    })
    expect(calls).toEqual(['skill/scripts/echo.mjs'])
  })
})

describe('agent_http', () => {
  test('posts the arguments to the bound loopback port and returns the result text', async () => {
    const registry = createAgentPackageRuntimeRegistry()
    registry.bind('session-a', fakeTurnRuntime())
    const { requests, fetchImpl } = recordingFetch(() => jsonResponse({ ok: true, result: { echo: { week: 'W43' } } }))
    const h = harness({ fetchImpl })
    registerAgentPackageRuntimeTools(h.ctx, registry)

    const value = await h.registered.get(AGENT_HTTP_TOOL)?.execute(
      { arguments: { week: 'W43' } },
      execFor('session-a'),
    )

    expect(value?.text).toBe(JSON.stringify({ echo: { week: 'W43' } }, null, 2))
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('http://127.0.0.1:43210/invoke')
    expect(requests[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ arguments: { week: 'W43' } })
  })

  test('defaults arguments to an empty object', async () => {
    const registry = createAgentPackageRuntimeRegistry()
    registry.bind('session-a', fakeTurnRuntime())
    const { requests, fetchImpl } = recordingFetch(() => jsonResponse({ ok: true, result: 'ok' }))
    const h = harness({ fetchImpl })
    registerAgentPackageRuntimeTools(h.ctx, registry)

    await h.registered.get(AGENT_HTTP_TOOL)?.execute({}, execFor('session-a'))
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ arguments: {} })
  })

  test('turns ok:false into a tool error carrying the package error', async () => {
    const registry = createAgentPackageRuntimeRegistry()
    registry.bind('session-a', fakeTurnRuntime())
    const { fetchImpl } = recordingFetch(() => jsonResponse({ ok: false, error: '坏参数' }))
    const h = harness({ fetchImpl })
    registerAgentPackageRuntimeTools(h.ctx, registry)

    await expect(h.registered.get(AGENT_HTTP_TOOL)?.execute({}, execFor('session-a'))).rejects.toThrow('坏参数')
  })

  test('turns a non-2xx response into a transport error with the capped body', async () => {
    const registry = createAgentPackageRuntimeRegistry()
    registry.bind('session-a', fakeTurnRuntime())
    const { fetchImpl } = recordingFetch(() => new Response('server exploded', { status: 500 }))
    const h = harness({ fetchImpl })
    registerAgentPackageRuntimeTools(h.ctx, registry)

    await expect(h.registered.get(AGENT_HTTP_TOOL)?.execute({}, execFor('session-a'))).rejects.toThrow(
      /HTTP 500: server exploded/,
    )
  })

  test('reports a timeout as a tool error', async () => {
    const registry = createAgentPackageRuntimeRegistry()
    registry.bind('session-a', fakeTurnRuntime())
    const { fetchImpl } = recordingFetch(() => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    })
    const h = harness({ fetchImpl })
    registerAgentPackageRuntimeTools(h.ctx, registry)

    await expect(h.registered.get(AGENT_HTTP_TOOL)?.execute({}, execFor('session-a'))).rejects.toThrow(/调用超时/)
  })

  test('reports caller cancellation as a tool error', async () => {
    const registry = createAgentPackageRuntimeRegistry()
    registry.bind('session-a', fakeTurnRuntime())
    const { fetchImpl } = recordingFetch(() => {
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    })
    const h = harness({ fetchImpl })
    registerAgentPackageRuntimeTools(h.ctx, registry)
    const controller = new AbortController()
    controller.abort()

    await expect(
      h.registered.get(AGENT_HTTP_TOOL)?.execute({}, { agent: { id: 'session-a' }, signal: controller.signal }),
    ).rejects.toThrow(/调用已取消/)
  })

  test('caps the rendered result at 32 KiB', async () => {
    const registry = createAgentPackageRuntimeRegistry()
    registry.bind('session-a', fakeTurnRuntime())
    const { fetchImpl } = recordingFetch(() => jsonResponse({ ok: true, result: 'x'.repeat(40_000) }))
    const h = harness({ fetchImpl })
    registerAgentPackageRuntimeTools(h.ctx, registry)

    const value = await h.registered.get(AGENT_HTTP_TOOL)?.execute({}, execFor('session-a'))
    expect(Buffer.byteLength(value?.text ?? '', 'utf8')).toBeLessThanOrEqual(32 * 1024)
    expect(value?.text).toContain('已截断')
  })

  test('rejects a response that is not the {ok,result} envelope', async () => {
    const registry = createAgentPackageRuntimeRegistry()
    registry.bind('session-a', fakeTurnRuntime())
    const { fetchImpl } = recordingFetch(() => new Response('not json', { status: 200 }))
    const h = harness({ fetchImpl })
    registerAgentPackageRuntimeTools(h.ctx, registry)

    await expect(h.registered.get(AGENT_HTTP_TOOL)?.execute({}, execFor('session-a'))).rejects.toThrow(/无法解析/)
  })

  test('reports a response above the 1 MiB read cap instead of an unparseable envelope', async () => {
    const registry = createAgentPackageRuntimeRegistry()
    registry.bind('session-a', fakeTurnRuntime())
    const { fetchImpl } = recordingFetch(() => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }))
    const h = harness({ fetchImpl })
    registerAgentPackageRuntimeTools(h.ctx, registry)

    await expect(h.registered.get(AGENT_HTTP_TOOL)?.execute({}, execFor('session-a'))).rejects.toThrow(
      /响应超过 1 MiB/,
    )
  })

  test('fails when the bound package has no HTTP port', async () => {
    const registry = createAgentPackageRuntimeRegistry()
    registry.bind('session-a', fakeTurnRuntime({ httpPort: undefined }))
    const h = harness()
    registerAgentPackageRuntimeTools(h.ctx, registry)

    await expect(h.registered.get(AGENT_HTTP_TOOL)?.execute({}, execFor('session-a'))).rejects.toThrow(
      /没有启用 HTTP 工具/,
    )
  })

  test('fails when the session has no bound runtime', async () => {
    const h = harness()
    registerAgentPackageRuntimeTools(h.ctx, createAgentPackageRuntimeRegistry())
    await expect(h.registered.get(AGENT_HTTP_TOOL)?.execute({}, execFor('session-a'))).rejects.toThrow(
      /没有运行中的智能体包/,
    )
  })
})

// —— Task 6: skills.ts subagent request branch ——

function skillsRuntimePackage(options: {
  allow: string[]
  childNames: string[]
  childSessionId?: string
  parentSessionId?: string
}) {
  const childSessionId = options.childSessionId ?? 'child'
  const parentSessionId = options.parentSessionId ?? 'parent-session'
  const allSchemas = options.childNames.map((name) => ({ name }))
  const childTools = {
    visible: [...allSchemas],
    schemas() {
      return childTools.visible
    },
    restrict({ allow }: { allow: readonly string[] }) {
      childTools.visible = allSchemas.filter((schema) => allow.includes(schema.name))
      return () => undefined
    },
    guard() {
      return () => undefined
    },
  }
  const childAgent = {
    id: childSessionId,
    session: { id: childSessionId, header: { id: childSessionId, parentSession: parentSessionId } },
    ctx: { get: (name: string) => (name === 'tools' ? childTools : undefined) },
  }
  const maps = emptyAttachments()
  const bindCalls: string[] = []
  const restrictSnapshots: Array<{ sessionId: string; names: string[] }> = []
  const activationSpecs: ActivationSpec[] = []
  const runtime = fakeTurnRuntime({ mcpNames: ['mcp__weekly-report__echo'] })
  const ctx = {
    skills: { register: () => () => undefined },
    on: () => undefined,
    agents: {
      get: (id: string) => (id === childSessionId ? childAgent : undefined),
    },
    root: {
      [PRESENT_AS_STATE]: {
        restrict: () => undefined,
        restrictAll: () => undefined,
        restrictSession: (sessionId: string) => {
          restrictSnapshots.push({
            sessionId,
            names: [...(maps.sessionAgentTools.get(sessionId) ?? [])],
          })
        },
      },
    },
    huaanworkAttachments: maps,
    huaanworkAgentPackageRequest: {
      current: {
        allow: options.allow,
        persona: '你是周报助手',
        runtime,
        parentSessionId,
        bindChild: (sessionId: string) => {
          // 运行时工具与 MCP 名由 skills.ts 自己挂;这里只按真实 host 记录子会话。
          bindCalls.push(sessionId)
        },
      },
    },
    subagents: {
      start: async () => ({ localAgent: childAgent }),
      startActivation: async (spec: ActivationSpec) => {
        activationSpecs.push(spec)
        return {
          childId: childSessionId,
          result: Promise.resolve({}),
          dispose: async () => undefined,
        }
      },
    },
  }
  return { ctx, childTools, maps, bindCalls, restrictSnapshots, activationSpecs }
}

describe('skills.ts package subagent request', () => {
  test('attaches the runtime tools, binds the child, and intersects allow with schemas', async () => {
    const harnessed = skillsRuntimePackage({
      // `call_host_tool` is deliberately absent: the composer never emits it, and the
      // intersection with schemas must not resurrect it from the child's schema set.
      allow: ['read', 'agent_http', 'agent_skill_run', 'mcp__weekly-report__echo', 'missing_tool'],
      childNames: ['read', 'glob', 'agent_http', 'agent_skill_run', 'mcp__weekly-report__echo', 'call_host_tool'],
    })

    applySkills(harnessed.ctx as never)
    await (harnessed.ctx.subagents.start as (...args: unknown[]) => Promise<unknown>)('spawn', {
      parent: 'parent-session',
    })

    expect(harnessed.childTools.visible.map((schema) => schema.name)).toEqual([
      'read',
      'agent_http',
      'agent_skill_run',
      'mcp__weekly-report__echo',
    ])
    expect(isAgentToolAttached(harnessed.maps, 'child', AGENT_HTTP_TOOL)).toBe(true)
    expect(isAgentToolAttached(harnessed.maps, 'child', AGENT_SKILL_RUN_TOOL)).toBe(true)
    expect(isAgentToolAttached(harnessed.maps, 'child', 'mcp__weekly-report__echo')).toBe(true)
    expect(isAgentToolAttached(harnessed.maps, 'parent-session', AGENT_HTTP_TOOL)).toBe(false)
    expect(harnessed.bindCalls).toEqual(['child'])
    // present-as must recompute after both the runtime tools and the MCP names are attached,
    // otherwise its earlier restriction keeps hiding mcp__* from the child.
    expect(harnessed.restrictSnapshots).toEqual([
      {
        sessionId: 'child',
        names: expect.arrayContaining([AGENT_HTTP_TOOL, AGENT_SKILL_RUN_TOOL, 'mcp__weekly-report__echo']),
      },
    ])
    expect(harnessed.ctx.huaanworkAgentPackageRequest.current).toBeNull()
  })

  test('clears the package request when the subagent fails to start', async () => {
    const harnessed = skillsRuntimePackage({ allow: ['read'], childNames: ['read'] })
    const ctx = {
      ...harnessed.ctx,
      subagents: {
        start: async () => {
          throw new Error('subprocess crash')
        },
      },
    }

    applySkills(ctx as never)
    await expect((ctx.subagents.start as () => Promise<unknown>)()).rejects.toThrow('subprocess crash')
    expect(ctx.huaanworkAgentPackageRequest.current).toBeNull()
  })

  test('falls back to the agent id when the session header has no id', async () => {
    const harnessed = skillsRuntimePackage({ allow: ['read'], childNames: ['read'], childSessionId: 'child-fallback' })
    ;(harnessed.ctx.subagents as { start: unknown }).start = async () => ({
      localAgent: {
        id: 'child-fallback',
        session: { header: { parentSession: 'parent-session' } },
        ctx: { get: () => harnessed.childTools },
      },
    })

    applySkills(harnessed.ctx as never)
    await (harnessed.ctx.subagents.start as (...args: unknown[]) => Promise<unknown>)('spawn', {
      parent: 'parent-session',
    })
    expect(harnessed.bindCalls).toEqual(['child-fallback'])
    expect(isAgentToolAttached(harnessed.maps, 'child-fallback', AGENT_SKILL_RUN_TOOL)).toBe(true)
  })

  test('leaves an unrelated subagent without package attachments or a registry binding', async () => {
    const harnessed = skillsRuntimePackage({
      allow: ['read', 'agent_http', 'agent_skill_run', 'mcp__weekly-report__echo'],
      childNames: ['read', 'agent_http', 'agent_skill_run', 'mcp__weekly-report__echo'],
    })
    // A package turn for `parent-session` is in flight; this start belongs to another session.
    ;(harnessed.ctx.subagents as { start: unknown }).start = async () => ({
      localAgent: {
        id: 'other-child',
        session: { id: 'other-child', header: { id: 'other-child', parentSession: 'other-session' } },
        ctx: { get: () => harnessed.childTools },
      },
    })

    applySkills(harnessed.ctx as never)
    await (harnessed.ctx.subagents.start as (...args: unknown[]) => Promise<unknown>)('spawn', {
      parent: 'other-session',
    })

    expect(harnessed.bindCalls).toEqual([])
    expect(harnessed.maps.sessionAgentTools.size).toBe(0)
    expect(harnessed.restrictSnapshots).toEqual([])
    // The unrelated child keeps its full tool set; no package allow list was applied.
    expect(harnessed.childTools.visible.map((schema) => schema.name)).toEqual([
      'read',
      'agent_http',
      'agent_skill_run',
      'mcp__weekly-report__echo',
    ])
  })
})

describe('skills.ts package activation', () => {
  const activationSpec = {
    provider: 'spawn',
    label: '@weekly-report',
    request: { prompt: [{ type: 'text', text: '写周报' }], parent: { session: { id: 'parent-session' } } },
    delivery: 'parent',
  }

  test('attaches package tools to the activation child and intersects its allow list', async () => {
    const harnessed = skillsRuntimePackage({
      allow: ['read', 'agent_http', 'agent_skill_run', 'mcp__weekly-report__echo', 'missing_tool'],
      childNames: ['read', 'glob', 'agent_http', 'agent_skill_run', 'mcp__weekly-report__echo', 'call_host_tool'],
    })

    applySkills(harnessed.ctx as never)
    const activation = await (
      harnessed.ctx.subagents.startActivation as (spec: unknown) => Promise<unknown>
    )(activationSpec)

    expect(activation).toMatchObject({ childId: 'child' })
    // The wrapper forwards the spec unchanged; only the post-activation wiring is added.
    expect(harnessed.activationSpecs).toEqual([activationSpec])
    // Tools and MCP names attach to the activation's own child, never the parent session.
    expect(isAgentToolAttached(harnessed.maps, 'child', AGENT_HTTP_TOOL)).toBe(true)
    expect(isAgentToolAttached(harnessed.maps, 'child', AGENT_SKILL_RUN_TOOL)).toBe(true)
    expect(isAgentToolAttached(harnessed.maps, 'child', 'mcp__weekly-report__echo')).toBe(true)
    expect(isAgentToolAttached(harnessed.maps, 'parent-session', AGENT_HTTP_TOOL)).toBe(false)
    expect(harnessed.bindCalls).toEqual(['child'])
    expect(harnessed.restrictSnapshots).toEqual([
      {
        sessionId: 'child',
        names: expect.arrayContaining([AGENT_HTTP_TOOL, AGENT_SKILL_RUN_TOOL, 'mcp__weekly-report__echo']),
      },
    ])
    expect(harnessed.childTools.visible.map((schema) => schema.name)).toEqual([
      'read',
      'agent_http',
      'agent_skill_run',
      'mcp__weekly-report__echo',
    ])
    expect(harnessed.ctx.huaanworkAgentPackageRequest.current).toBeNull()
  })

  test('re-attaches to the activation child id without duplicating a host pre-attachment', async () => {
    const harnessed = skillsRuntimePackage({
      allow: ['read', 'agent_http', 'agent_skill_run', 'mcp__weekly-report__echo'],
      childNames: ['read', 'agent_http', 'agent_skill_run', 'mcp__weekly-report__echo'],
    })
    const request = harnessed.ctx.huaanworkAgentPackageRequest as {
      current: { childId?: string } | null
    }
    // host 已经按预留 id 预先挂载并登记运行时,activation 沿用同一个 id。
    request.current!.childId = 'child'
    attachAgentTools(harnessed.maps, 'child', [
      AGENT_HTTP_TOOL,
      AGENT_SKILL_RUN_TOOL,
      'mcp__weekly-report__echo',
    ])

    applySkills(harnessed.ctx as never)
    await (harnessed.ctx.subagents.startActivation as (spec: unknown) => Promise<unknown>)({
      ...activationSpec,
      childId: 'child',
    })

    // 安全网重复挂同一批名字不产生重复条目,也不重复绑定同一个子会话。
    expect([...(harnessed.maps.sessionAgentTools.get('child') ?? [])].sort()).toEqual(
      [AGENT_HTTP_TOOL, AGENT_SKILL_RUN_TOOL, 'mcp__weekly-report__echo'].sort(),
    )
    expect(harnessed.bindCalls).toEqual(['child'])
  })

  test('binds the reserved child id when the provider returns a different one', async () => {
    const harnessed = skillsRuntimePackage({
      allow: ['read', 'agent_http', 'agent_skill_run', 'mcp__weekly-report__echo'],
      childNames: ['read', 'agent_http', 'agent_skill_run', 'mcp__weekly-report__echo'],
    })
    const request = harnessed.ctx.huaanworkAgentPackageRequest as {
      current: { childId?: string } | null
    }
    request.current!.childId = 'reserved-child'

    applySkills(harnessed.ctx as never)
    await (harnessed.ctx.subagents.startActivation as (spec: unknown) => Promise<unknown>)({
      ...activationSpec,
      childId: 'reserved-child',
    })

    // 实际子会话拿到包工具;预留 id 也保留登记,回合清理按两者都能找到运行时。
    expect(isAgentToolAttached(harnessed.maps, 'child', AGENT_HTTP_TOOL)).toBe(true)
    expect(isAgentToolAttached(harnessed.maps, 'reserved-child', AGENT_HTTP_TOOL)).toBe(false)
    expect(harnessed.bindCalls).toEqual(['child', 'reserved-child'])
  })

  test('leaves an activation started by another session untouched', async () => {
    const harnessed = skillsRuntimePackage({
      allow: ['read', 'agent_http', 'agent_skill_run', 'mcp__weekly-report__echo'],
      childNames: ['read', 'agent_http', 'agent_skill_run', 'mcp__weekly-report__echo'],
    })

    applySkills(harnessed.ctx as never)
    await (harnessed.ctx.subagents.startActivation as (spec: unknown) => Promise<unknown>)({
      ...activationSpec,
      request: { ...activationSpec.request, parent: { session: { id: 'other-session' } } },
    })

    expect(harnessed.bindCalls).toEqual([])
    expect(harnessed.maps.sessionAgentTools.size).toBe(0)
    expect(harnessed.restrictSnapshots).toEqual([])
    expect(harnessed.childTools.visible.map((schema) => schema.name)).toEqual([
      'read',
      'agent_http',
      'agent_skill_run',
      'mcp__weekly-report__echo',
    ])
    expect(harnessed.ctx.huaanworkAgentPackageRequest.current).toBeNull()
  })

  test('clears the package request when the activation fails', async () => {
    const harnessed = skillsRuntimePackage({ allow: ['read'], childNames: ['read'] })
    const ctx = {
      ...harnessed.ctx,
      subagents: {
        start: async () => ({ localAgent: harnessed.ctx.agents.get('child') }),
        startActivation: async () => {
          throw new Error('activation crash')
        },
      },
    }

    applySkills(ctx as never)
    await expect(
      (ctx.subagents.startActivation as () => Promise<unknown>)(),
    ).rejects.toThrow('activation crash')
    expect(ctx.huaanworkAgentPackageRequest.current).toBeNull()
  })
})

// —— Task 6: @slug host dispatch ——

type ActivationSpec = {
  provider: string
  label: string
  childId?: string
  request: { prompt: Array<{ type: string; text: string }>; parent?: unknown; [key: string]: unknown }
  signal?: AbortSignal
  delivery: string
}

type DispatchHarness = {
  host: AgentPackageHost
  ctx: Record<string, unknown>
  registry: ReturnType<typeof createAgentPackageRuntimeRegistry>
  runtime: AgentPackageTurnRuntime & { mcpNames?: string[] }
  activationCalls: ActivationSpec[]
  activationDisposals: number[]
  resolveActivationResult: (value?: unknown) => void
  stopped: AgentPackageTurnRuntime[]
  mcpDisposes: number[]
  maps: AttachmentMaps
  restrictSessions: string[]
  profileDir: string
}

function writeEnabledPackage(profileDir: string, enabled = true): string {
  const packageDir = join(profileDir, 'agents', 'weekly-report')
  mkdirSync(join(profileDir, 'agents'), { recursive: true })
  cpSync(FIXTURE_DIR, packageDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'agents-state.json'),
    JSON.stringify({ 'local:weekly-report': { source: 'local', enabled, installedVersion: '1.0.0' } }),
    'utf8',
  )
  return packageDir
}

function dispatchHarness(options: {
  enabled?: boolean
  createRuntime?: (startOptions: StartAgentPackageProcessesOptions) => Promise<AgentPackageTurnRuntime>
} = {}): DispatchHarness {
  const profileDir = makeRoot()
  const packageDir = writeEnabledPackage(profileDir, options.enabled ?? true)
  const registry = createAgentPackageRuntimeRegistry()
  const runtime: AgentPackageTurnRuntime & { mcpNames?: string[] } = {
    slug: 'weekly-report',
    packageDir,
    workspaceRoot: '/tmp/workspace',
    httpPort: 43210,
    skillScripts: ['skill/scripts/echo.mjs'],
    runSkillScript: async () => ({ text: 'ok' }),
  }
  const activationCalls: ActivationSpec[] = []
  const activationDisposals: number[] = []
  // The test controls when the child result settles; `afterIdle` must await it
  // before it stops the process.
  let resolveActivationResult: (value?: unknown) => void = () => undefined
  const activationResult = new Promise<unknown>((resolve) => {
    resolveActivationResult = resolve
  })
  const stopped: AgentPackageTurnRuntime[] = []
  const mcpDisposes: number[] = []
  const restrictSessions: string[] = []
  const maps = emptyAttachments()
  const ctx: Record<string, unknown> = {
    get: (name: string) => (name === 'sandbox' ? { confine: async (argv: readonly string[]) => ({ argv, enforcement: 'full' }) } : undefined),
    huaanworkWorkspaceRoot: { current: '/tmp/workspace' },
    huaanworkAttachments: maps,
    huaanworkAgentPackageRequest: { current: null },
    subagents: {
      startActivation: async (spec: ActivationSpec) => {
        activationCalls.push(spec)
        // 真实的 spawn 后端沿用预留 id;只有个别 provider 会另分配一个。
        return {
          childId: spec.childId ?? 'child',
          result: activationResult,
          dispose: async () => {
            activationDisposals.push(1)
          },
        }
      },
    },
    tools: { schemas: () => [{ name: 'mcp__weekly-report__echo' }] },
    plugin: async () => ({ dispose: async () => { mcpDisposes.push(1) } }),
    root: {
      [PRESENT_AS_STATE]: {
        restrict: () => undefined,
        restrictAll: () => undefined,
        restrictSession: (sessionId: string) => restrictSessions.push(sessionId),
      },
    },
  }
  const host = createAgentPackageHost({
    profileDir,
    takenSlugs: () => [],
    registry,
    createRuntime: options.createRuntime ?? (async (startOptions) => {
      const names = startOptions.mountMcp === undefined ? undefined : await startOptions.mountMcp(43210)
      if (names !== undefined) runtime.mcpNames = [...names]
      return runtime
    }),
    stopRuntime: async (turn) => {
      stopped.push(turn)
    },
  })
  return {
    host,
    ctx,
    registry,
    runtime,
    activationCalls,
    activationDisposals,
    resolveActivationResult,
    stopped,
    mcpDisposes,
    maps,
    restrictSessions,
    profileDir,
  }
}

describe('@slug package dispatch', () => {
  test('a local package is dispatched before the agentsHost lookup', async () => {
    const calls: unknown[] = []
    const pkg = { slug: 'weekly-report' } as never
    const result = await dispatchAt({
      host: {
        list() {
          throw new Error('agentsHost must not be read for a local package')
        },
      } as never,
      ctx: {} as never,
      sessionId: 'session-a',
      name: 'weekly-report',
      remainder: '写周报',
      packageHost: { findInvocable: async () => pkg },
      packageRuntime: {
        dispatch: async (input) => {
          calls.push(input)
          return { text: '已交给包运行时', afterIdle: async () => undefined }
        },
      },
    })

    expect(result.text).toBe('已交给包运行时')
    expect(calls).toEqual([
      expect.objectContaining({ sessionId: 'session-a', pkg, remainder: '写周报' }),
    ])
  })

  test('a slug with no local package falls through to the legacy lookup', async () => {
    await expect(
      dispatchAt({
        host: { list: () => ({ items: [] }) } as never,
        ctx: {} as never,
        sessionId: 'session-a',
        name: 'legacy-agent',
        remainder: '',
        packageHost: { findInvocable: async () => undefined },
        packageRuntime: { dispatch: async () => ({ text: '', afterIdle: async () => undefined }) },
      }),
    ).rejects.toThrow('智能体「legacy-agent」未启用或不存在')
  })

  test('composes persona/allow, binds the parent, and afterIdle stops every resource', async () => {
    const h = dispatchHarness()
    const pkg = await h.host.findInvocable('weekly-report')
    expect(pkg).toBeDefined()
    expect(pkg?.enabled).toBe(true)

    const dispatched = await h.host.dispatch({
      ctx: h.ctx as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '  写一份周报  ',
      resolveParent: async () => ({ id: 'parent-agent' }),
    })

    expect(dispatched.text).toBe('写一份周报')
    expect(h.activationCalls).toHaveLength(1)
    const spec = h.activationCalls[0] as ActivationSpec
    expect(spec.provider).toBe('spawn')
    expect(spec.label).toBe('@weekly-report')
    expect(spec.delivery).toBe('parent')
    expect(spec.request.parent).toEqual({ id: 'parent-agent' })
    expect(spec.signal).toBeInstanceOf(AbortSignal)
    const childPrompt = spec.request.prompt[0]?.text ?? ''
    // @slug 的人设必须包含 SKILL.md 正文(前端 frontmatter 已剥离),作为子代理
    // 首条消息的分隔前缀;rc.1 没有 persona 字段。
    expect(childPrompt).toContain('SKILL.md 正文:先收集本周工作,再生成周报。')
    expect(childPrompt).not.toContain('description: 生成周报')
    expect(childPrompt).toContain('---\n用户请求：\n写一份周报')
    expect(childPrompt.endsWith('写一份周报')).toBe(true)

    const holder = h.ctx.huaanworkAgentPackageRequest as {
      current: { allow: string[]; parentSessionId: string; childId: string; bindChild(id: string): void } | null
    }
    expect(holder.current).not.toBeNull()
    // agent_http 来自 http 工具模式,agent_skill_run 来自运行时枚举的脚本;MCP 名来自 mount。
    expect(holder.current?.allow).toEqual(
      expect.arrayContaining(['agent_http', 'agent_skill_run', 'mcp__weekly-report__echo', 'read']),
    )
    expect(holder.current?.allow).not.toContain('call_host_tool')
    expect(holder.current?.parentSessionId).toBe('parent-session')
    expect(h.registry.get('parent-session')).toBe(h.runtime)

    // 发现阶段挂到父会话的 MCP 名必须在 dispatch 返回前摘掉;它们只属于包子会话。
    expect(isAgentToolAttached(h.maps, 'parent-session', 'mcp__weekly-report__echo')).toBe(false)

    // 预留 id 同时写进 activation spec 与 request;host 在 activation 之前就按它挂好
    // 包工具、MCP 名并登记运行时,子代理的首条请求因此不会缺工具。
    const childId = spec.childId
    expect(childId).toBeTruthy()
    expect(holder.current?.childId).toBe(childId)
    expect(h.registry.get(childId!)).toBe(h.runtime)
    expect(isAgentToolAttached(h.maps, childId!, AGENT_HTTP_TOOL)).toBe(true)
    expect(isAgentToolAttached(h.maps, childId!, AGENT_SKILL_RUN_TOOL)).toBe(true)
    expect(isAgentToolAttached(h.maps, childId!, 'mcp__weekly-report__echo')).toBe(true)
    // skills.ts 的安全网再挂一次不产生重复:附件按名字存进 Set。
    attachAgentTools(h.maps, childId!, [AGENT_HTTP_TOOL, 'mcp__weekly-report__echo'])
    holder.current?.bindChild(childId!)
    expect(h.maps.sessionAgentTools.get(childId!)?.size).toBe(3)

    const idle = dispatched.afterIdle()
    await new Promise((resolve) => setImmediate(resolve))
    // 子会话结果尚未落定:afterIdle 必须等它,不能先停进程。
    expect(h.stopped).toEqual([])
    expect(h.activationDisposals).toEqual([])
    h.resolveActivationResult()

    await idle

    expect(h.stopped).toEqual([h.runtime])
    expect(h.activationDisposals).toEqual([1])
    expect(h.registry.get('parent-session')).toBeUndefined()
    expect(h.registry.get(childId!)).toBeUndefined()
    expect(holder.current).toBeNull()
    expect(h.mcpDisposes).toEqual([1])

    // cleanup 是幂等的:重复 afterIdle 不再停进程、不再释放 activation。
    await dispatched.afterIdle()
    expect(h.stopped).toEqual([h.runtime])
    expect(h.activationDisposals).toEqual([1])
    expect(h.mcpDisposes).toEqual([1])
    // 子会话的运行时工具与 MCP 名也随回合卸载,并重算 present-as。
    expect(h.maps.sessionAgentTools.size).toBe(0)
    expect(h.restrictSessions).toContain(childId!)
  })

  test('attaches the package tools to the reserved child id before startActivation runs', async () => {
    const h = dispatchHarness()
    const pkg = await h.host.findInvocable('weekly-report')
    const observed: Array<{ childId?: string; attached: string[]; bound: boolean }> = []
    ;(h.ctx.subagents as { startActivation: unknown }).startActivation = async (spec: ActivationSpec) => {
      const childId = spec.childId ?? ''
      observed.push({
        ...(spec.childId === undefined ? {} : { childId: spec.childId }),
        attached: [...(h.maps.sessionAgentTools.get(childId) ?? [])],
        bound: h.registry.get(childId) === h.runtime,
      })
      return { childId, result: Promise.resolve({}), dispose: async () => undefined }
    }

    const dispatched = await h.host.dispatch({
      ctx: h.ctx as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '写周报',
      resolveParent: async () => ({ id: 'parent-agent' }),
    })

    // 子代理的首条请求在包装运行前组装,所以 activation 被调用的那一刻工具必须已经在位。
    expect(observed).toHaveLength(1)
    const seen = observed[0]!
    expect(seen.childId).toBeTruthy()
    expect(seen.attached).toEqual(
      expect.arrayContaining([AGENT_HTTP_TOOL, AGENT_SKILL_RUN_TOOL, 'mcp__weekly-report__echo']),
    )
    expect(seen.bound).toBe(true)

    await dispatched.afterIdle()
    expect(h.maps.sessionAgentTools.has(seen.childId!)).toBe(false)
    expect(h.registry.get(seen.childId!)).toBeUndefined()
  })

  test('a failed activation detaches the reserved id and releases the session reservation', async () => {
    const h = dispatchHarness()
    const pkg = await h.host.findInvocable('weekly-report')
    const holder = h.ctx.huaanworkAgentPackageRequest as { current: unknown }
    let reservedChildId: string | undefined
    ;(h.ctx.subagents as { startActivation: unknown }).startActivation = async (spec: ActivationSpec) => {
      reservedChildId = spec.childId
      throw new Error('spawn failed')
    }

    await expect(
      h.host.dispatch({
        ctx: h.ctx as never,
        sessionId: 'parent-session',
        pkg: pkg!,
        remainder: '写周报',
        resolveParent: async () => ({ id: 'parent-agent' }),
      }),
    ).rejects.toThrow('spawn failed')

    expect(reservedChildId).toBeTruthy()
    expect(h.maps.sessionAgentTools.has(reservedChildId!)).toBe(false)
    expect(h.registry.get(reservedChildId!)).toBeUndefined()
    expect(h.registry.get('parent-session')).toBeUndefined()
    expect(holder.current).toBeNull()

    // 会话预留已释放:同一会话可以立即重试,并且重试拿到新的预留 id。
    let retriedChildId: string | undefined
    ;(h.ctx.subagents as { startActivation: unknown }).startActivation = async (spec: ActivationSpec) => {
      retriedChildId = spec.childId
      return { childId: spec.childId ?? 'child', result: Promise.resolve({}), dispose: async () => undefined }
    }
    const retried = await h.host.dispatch({
      ctx: h.ctx as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '重试',
      resolveParent: async () => ({ id: 'parent-agent' }),
    })
    expect(retriedChildId).toBeTruthy()
    expect(retriedChildId).not.toBe(reservedChildId)
    expect(h.registry.get(retriedChildId!)).toBe(h.runtime)
    await retried.afterIdle()
    expect(h.maps.sessionAgentTools.has(retriedChildId!)).toBe(false)
  })

  test('findInvocable still returns disabled and broken packages; dispatch rejects them', async () => {
    const disabled = dispatchHarness({ enabled: false })
    const disabledPkg = await disabled.host.findInvocable('weekly-report')
    expect(disabledPkg?.enabled).toBe(false)
    await expect(
      disabled.host.dispatch({ ctx: disabled.ctx as never, sessionId: 's', pkg: disabledPkg!, remainder: 'x' }),
    ).rejects.toThrow('智能体「weekly-report」未启用或不存在')

    const broken = dispatchHarness()
    writeFileSync(join(broken.profileDir, 'agents', 'weekly-report', 'agent.json'), '{oops', 'utf8')
    const brokenPkg = await broken.host.findInvocable('weekly-report')
    expect(brokenPkg?.broken).toBeDefined()
    await expect(
      broken.host.dispatch({ ctx: broken.ctx as never, sessionId: 's', pkg: brokenPkg!, remainder: 'x' }),
    ).rejects.toThrow(/智能体「weekly-report」已损坏：/)
  })

  test('returns undefined for a slug that is not a local package', async () => {
    const h = dispatchHarness()
    await expect(h.host.findInvocable('not-a-package')).resolves.toBeUndefined()
  })

  test('cleans up processes, MCP, registry, and holder when activation fails', async () => {
    const h = dispatchHarness()
    ;(h.ctx.subagents as { startActivation: unknown }).startActivation = async () => {
      throw new Error('spawn failed')
    }
    const pkg = await h.host.findInvocable('weekly-report')
    const holder = h.ctx.huaanworkAgentPackageRequest as { current: unknown }

    await expect(
      h.host.dispatch({
        ctx: h.ctx as never,
        sessionId: 'parent-session',
        pkg: pkg!,
        remainder: 'x',
        resolveParent: async () => ({ id: 'parent-agent' }),
      }),
    ).rejects.toThrow('spawn failed')

    expect(h.stopped).toEqual([h.runtime])
    expect(h.registry.get('parent-session')).toBeUndefined()
    expect(holder.current).toBeNull()
    expect(h.mcpDisposes).toEqual([1])

    // 失败路径的 cleanup 必须释放会话预留,同一会话可以立即重试。
    ;(h.ctx.subagents as { startActivation: unknown }).startActivation = async () => ({
      childId: 'child',
      result: Promise.resolve({}),
      dispose: async () => undefined,
    })
    const retried = await h.host.dispatch({
      ctx: h.ctx as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '重试',
      resolveParent: async () => ({ id: 'parent-agent' }),
    })
    await retried.afterIdle()
  })

  test('a failed child result does not reject afterIdle and still disposes the activation', async () => {
    const h = dispatchHarness()
    ;(h.ctx.subagents as { startActivation: unknown }).startActivation = async () => ({
      childId: 'child',
      // Reject after the dispatch returns so cleanup is the observer of the failure.
      result: new Promise((_resolve, reject) => {
        setImmediate(() => reject(new Error('child failed')))
      }),
      dispose: async () => {
        h.activationDisposals.push(1)
      },
    })
    const pkg = await h.host.findInvocable('weekly-report')
    const dispatched = await h.host.dispatch({
      ctx: h.ctx as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '写周报',
      resolveParent: async () => ({ id: 'parent-agent' }),
    })

    await expect(dispatched.afterIdle()).resolves.toBeUndefined()
    expect(h.activationDisposals).toEqual([1])
    expect(h.stopped).toEqual([h.runtime])
    expect(h.registry.get('parent-session')).toBeUndefined()
  })

  test('requires a live parent before starting an activation', async () => {
    const h = dispatchHarness()
    const pkg = await h.host.findInvocable('weekly-report')
    const holder = h.ctx.huaanworkAgentPackageRequest as { current: unknown }

    for (const resolveParent of [undefined, async () => undefined]) {
      await expect(
        h.host.dispatch({
          ctx: h.ctx as never,
          sessionId: 'parent-session',
          pkg: pkg!,
          remainder: '写周报',
          ...(resolveParent === undefined ? {} : { resolveParent }),
        }),
      ).rejects.toThrow(/当前会话没有可用的父会话/)
    }

    expect(h.activationCalls).toEqual([])
    expect(h.stopped).toEqual([h.runtime, h.runtime])
    expect(h.registry.get('parent-session')).toBeUndefined()
    expect(holder.current).toBeNull()
  })

  test('rejects a second package turn in the same session until the first cleans up', async () => {
    const h = dispatchHarness()
    const pkg = await h.host.findInvocable('weekly-report')
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let finishStart: (() => void) | undefined
    ;(h.ctx.subagents as { startActivation: unknown }).startActivation = () => {
      markStarted()
      return new Promise((resolve) => {
        finishStart = () =>
          resolve({ childId: 'child', result: Promise.resolve({}), dispose: async () => undefined })
      })
    }
    const resolveParent = async (): Promise<{ id: string }> => ({ id: 'parent-agent' })

    const first = h.host.dispatch({
      ctx: h.ctx as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '第一轮',
      resolveParent,
    })
    await started
    await expect(
      h.host.dispatch({
        ctx: h.ctx as never,
        sessionId: 'parent-session',
        pkg: pkg!,
        remainder: '第二轮',
        resolveParent,
      }),
    ).rejects.toThrow('智能体「weekly-report」无法开始：当前会话已有运行中的智能体包回合（@weekly-report）')

    finishStart?.()
    const dispatched = await first
    await dispatched.afterIdle()

    // cleanup 释放预留后,同一会话可以开始下一轮。
    ;(h.ctx.subagents as { startActivation: unknown }).startActivation = async () => ({
      childId: 'child',
      result: Promise.resolve({}),
      dispose: async () => undefined,
    })
    const third = await h.host.dispatch({
      ctx: h.ctx as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '第三轮',
      resolveParent,
    })
    await third.afterIdle()
  })

  test('disposes an MCP mount that resolves after the turn has already cleaned up', async () => {
    let resolveMount: ((scope: { dispose: () => Promise<void> }) => void) | undefined
    let disposeCalls = 0
    let mountPromise: Promise<readonly string[]> | undefined
    const h = dispatchHarness({
      createRuntime: async (startOptions) => {
        // 与 5 秒健康预算超时同形:回合失败清理后挂载才完成。
        mountPromise = Promise.resolve(startOptions.mountMcp?.(43210))
        throw new Error('脚本启动失败：MCP 服务挂载超时')
      },
    })
    h.ctx.plugin = () =>
      new Promise((resolve) => {
        resolveMount = resolve
      })
    const pkg = await h.host.findInvocable('weekly-report')

    await expect(
      h.host.dispatch({ ctx: h.ctx as never, sessionId: 'parent-session', pkg: pkg!, remainder: 'x' }),
    ).rejects.toThrow('MCP 服务挂载超时')

    resolveMount?.({
      dispose: async () => {
        disposeCalls += 1
      },
    })
    await mountPromise

    expect(disposeCalls).toBe(1)
    expect(h.maps.sessionAgentTools.size).toBe(0)
  })

  test('resolves subagents through ctx.get when the context has no direct property', async () => {
    // 真实宿主 Context 不把服务暴露成直接属性;`ctx.get('subagents')` 是唯一入口。
    const h = dispatchHarness()
    delete h.ctx.subagents
    const activationCalls: ActivationSpec[] = []
    const sandbox = { confine: async (argv: readonly string[]) => ({ argv, enforcement: 'full' }) }
    h.ctx.get = (name: string) =>
      name === 'subagents'
        ? {
            startActivation: async (spec: ActivationSpec) => {
              activationCalls.push(spec)
              return { childId: 'child', result: Promise.resolve({}), dispose: async () => undefined }
            },
          }
        : name === 'sandbox'
          ? sandbox
          : undefined
    const pkg = await h.host.findInvocable('weekly-report')

    const dispatched = await h.host.dispatch({
      ctx: h.ctx as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '写周报',
      resolveParent: async () => ({ id: 'parent-agent' }),
    })

    expect(activationCalls).toHaveLength(1)
    expect(activationCalls[0]?.provider).toBe('spawn')
    expect(activationCalls[0]?.request.prompt[0]?.text).toContain('SKILL.md 正文')
    await dispatched.afterIdle()
  })

  test('still rejects a package turn when neither the property nor the registered service provides startActivation', async () => {
    const h = dispatchHarness()
    delete h.ctx.subagents
    h.ctx.get = () => undefined
    const pkg = await h.host.findInvocable('weekly-report')

    await expect(
      h.host.dispatch({ ctx: h.ctx as never, sessionId: 'parent-session', pkg: pkg!, remainder: '写周报' }),
    ).rejects.toThrow('current dsh runtime does not support subagents')
  })

  test('a direct object with only start does not shadow a registered startActivation', async () => {
    const h = dispatchHarness()
    const legacyStart = vi.fn(async () => ({}))
    const originalGet = h.ctx.get as (name: string) => unknown
    h.ctx.subagents = { start: legacyStart }
    h.ctx.get = (name: string) =>
      name === 'subagents'
        ? {
            startActivation: async (spec: ActivationSpec) => {
              h.activationCalls.push(spec)
              return { childId: 'child', result: Promise.resolve({}), dispose: async () => undefined }
            },
          }
        : originalGet(name)
    const pkg = await h.host.findInvocable('weekly-report')

    const dispatched = await h.host.dispatch({
      ctx: h.ctx as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '写周报',
      resolveParent: async () => ({ id: 'parent-agent' }),
    })

    // 直接属性只有旧签名时,包回合必须回落到全局服务上的 startActivation。
    expect(h.activationCalls).toHaveLength(1)
    expect(legacyStart).not.toHaveBeenCalled()
    await dispatched.afterIdle()
  })

  test('afterIdle waits up to ten minutes for a slow child, then logs and disposes', async () => {
    const h = dispatchHarness()
    const pkg = await h.host.findInvocable('weekly-report')
    const dispatched = await h.host.dispatch({
      ctx: h.ctx as never,
      sessionId: 'parent-session',
      pkg: pkg!,
      remainder: '写周报',
      resolveParent: async () => ({ id: 'parent-agent' }),
    })
    const spec = h.activationCalls[0] as ActivationSpec

    vi.useFakeTimers()
    try {
      const idle = dispatched.afterIdle()
      await vi.advanceTimersByTimeAsync(599_999)
      // 边界内仍在等:HTTP/MCP 子代理可能比父回合的空闲点活得更久。
      expect(h.activationDisposals).toEqual([])
      expect(h.stopped).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await idle
    } finally {
      vi.useRealTimers()
    }

    expect(h.activationDisposals).toEqual([1])
    expect(h.stopped).toEqual([h.runtime])
    expect(h.registry.get('parent-session')).toBeUndefined()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('10 分钟'))
    // 发布后的取消归 dispose();cleanup 不再 abort 发布前用的 signal。
    expect(spec.signal?.aborted).toBe(false)
  })
})

describe('@agent legacy dispatch subagents resolution', () => {
  function legacyAgentHost(): never {
    return {
      list: () => ({
        items: [
          {
            name: 'legacy-assistant',
            source: 'catalog',
            kind: 'agent',
            description: '旧目录智能体',
            version: '1.0.0',
            permissions: [],
            enabled: true,
          },
        ],
      }),
      get: async () => ({ persona: '你是旧目录助手' }),
    } as never
  }

  test('starts the spawn subagent through ctx.get when the context has no direct property', async () => {
    const startCalls: Array<{ provider: string; request: Record<string, unknown> }> = []
    const ctx = {
      get: (name: string) =>
        name === 'subagents'
          ? {
              start: async (provider: string, request: Record<string, unknown>) => {
                startCalls.push({ provider, request })
                return { localAgent: { id: 'child', session: { id: 'child' } } }
              },
            }
          : undefined,
    }

    const dispatched = await dispatchAt({
      host: legacyAgentHost(),
      ctx: ctx as never,
      sessionId: 'session-a',
      name: 'legacy-assistant',
      remainder: '整理本周进展',
    })

    expect(startCalls).toHaveLength(1)
    expect(startCalls[0]?.provider).toBe('spawn')
    expect(startCalls[0]?.request.persona).toBe('你是旧目录助手')
    expect(dispatched.text).toBe('整理本周进展')
    await dispatched.afterIdle()
  })

  test('a direct object with only startActivation does not shadow a registered start', async () => {
    const startCalls: Array<{ provider: string; request: Record<string, unknown> }> = []
    const activationCalls: unknown[] = []
    const ctx = {
      subagents: {
        startActivation: async (spec: unknown) => {
          activationCalls.push(spec)
          return { childId: 'child', result: Promise.resolve({}), dispose: async () => undefined }
        },
      },
      get: (name: string) =>
        name === 'subagents'
          ? {
              start: async (provider: string, request: Record<string, unknown>) => {
                startCalls.push({ provider, request })
                return { localAgent: { id: 'child', session: { id: 'child' } } }
              },
            }
          : undefined,
    }

    const dispatched = await dispatchAt({
      host: legacyAgentHost(),
      ctx: ctx as never,
      sessionId: 'session-a',
      name: 'legacy-assistant',
      remainder: '整理本周进展',
    })

    // 直接属性只有新入口时,legacy 分支必须回落到全局服务上的 start。
    expect(startCalls).toHaveLength(1)
    expect(startCalls[0]?.provider).toBe('spawn')
    expect(activationCalls).toEqual([])
    await dispatched.afterIdle()
  })

  test('rejects when neither the property nor the registered service provides start', async () => {
    await expect(
      dispatchAt({
        host: legacyAgentHost(),
        ctx: { get: () => undefined } as never,
        sessionId: 'session-a',
        name: 'legacy-assistant',
        remainder: 'x',
      }),
    ).rejects.toThrow('current dsh runtime does not support subagents')
  })
})
