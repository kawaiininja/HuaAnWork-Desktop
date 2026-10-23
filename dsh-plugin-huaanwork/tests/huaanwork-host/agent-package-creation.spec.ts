import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { RpcEvent } from '../../src/client-huaanwork/rpc-types.ts'
import {
  attachAgentTools,
  emptyAttachments,
  isAgentToolAttached,
} from '../../src/huaanwork-guardrails/agent-attachments.ts'
import {
  AGENT_COMMIT_TOOL,
  AGENT_PROPOSE_TOOL,
  registerAgentPackageCreationTools,
} from '../../src/huaanwork-guardrails/agent-package-tools.ts'
import {
  createAgentPackageHost,
  type AgentPackageHost,
} from '../../src/huaanwork-host/agent-package/host.ts'
import {
  loadAgentPackageDraft,
  proposeAgentPackage,
} from '../../src/huaanwork-host/agent-package/drafts.ts'
import {
  attachCreationTools,
  detectAgentCreationIntent,
  detachCreationTools,
  injectCreateAgentSkill,
} from '../../src/huaanwork-host/agent-package/creation.ts'
import { INTERNAL_BUNDLED_SKILLS, listBundledSkills } from '../../src/huaanwork-guardrails/skills.ts'
import { ROUTE_TABLE } from '../../src/huaanwork-host/routes.ts'
import {
  sendToAgent,
  sessionSend,
  setAgentPackageHost,
  type ListedAgent,
  type SessionRuntimeContext,
} from '../../src/huaanwork-host/sessions.ts'
import type { RouteContext } from '../../src/huaanwork-host/routes.ts'
import { resetChildSessionRegistry } from '../../src/huaanwork-host/child-sessions.ts'

const PRESENT_AS_STATE = Symbol.for('huaanwork.presentAs.restrictState')

type RestrictCalls = { sessions: string[] }

/** 假 present-as 状态:refreshAgentRestrict 经 ctx.root 找到它,记录按会话刷新。 */
function restrictRoot(calls: RestrictCalls): object {
  return {
    [PRESENT_AS_STATE]: {
      restrict: () => undefined,
      restrictAll: () => undefined,
      restrictSession: (sessionId: string) => calls.sessions.push(sessionId),
    },
  }
}

let roots: string[] = []
let previousAgentsHome: string | undefined

beforeEach(() => {
  previousAgentsHome = process.env.DSH_AGENTS_HOME
  const isolatedHome = mkdtempSync(join(tmpdir(), 'hw-creation-agents-home-'))
  process.env.DSH_AGENTS_HOME = isolatedHome
  roots.push(isolatedHome)
  // present-as 未装载时 refreshAgentRestrict 会打 console.error;本文件只断言附件与刷新调用。
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  setAgentPackageHost(undefined)
  resetChildSessionRegistry()
  vi.restoreAllMocks()
  delete process.env.DSH_AGENTS_HOME
  if (previousAgentsHome !== undefined) process.env.DSH_AGENTS_HOME = previousAgentsHome
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-package-creation-'))
  roots.push(root)
  return root
}

function makeRouteCtx(root: string, events: RpcEvent[]): RouteContext {
  return {
    dshHome: join(root, 'dsh'),
    profileDir: root,
    workspaceRoot: { current: join(root, 'workspace') },
    emit: (event) => events.push(event),
    logger: () => undefined,
    requestRestart: async () => true,
  }
}

type Deferred = { promise: Promise<void>; resolve: () => void }

function deferred(): Deferred {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function makeAgent(sessionId: string, received: unknown[], idle?: Promise<void>): ListedAgent {
  return {
    id: sessionId,
    session: { id: sessionId },
    followup: (message) => received.push(message),
    whenIdle: () => idle ?? Promise.resolve(),
  }
}

function makeSessionCtx(agent: ListedAgent, sessionId: string, maps = emptyAttachments()): SessionRuntimeContext {
  return {
    huaanworkAttachments: maps,
    agents: {
      get: (id) => (id === sessionId ? agent : undefined),
      list: () => [agent],
    },
  }
}

function fakeHost(overrides: Partial<AgentPackageHost> = {}): AgentPackageHost {
  return {
    propose: async () => ({ ok: false, fieldErrors: [] }),
    commit: async () => ({ ok: false, error: 'not implemented' }),
    cancel: async () => false,
    hasDraft: () => false,
    beginUpdate: async () => undefined,
    lastUserText: () => undefined,
    noteUserText: () => undefined,
    listLocal: () => [],
    detail: () => undefined,
    setEnabled: () => undefined,
    findInvocable: async () => undefined,
    dispatch: async () => ({ text: '', afterIdle: async () => undefined }),
    ...overrides,
  }
}

const draftProposal = {
  mode: 'create' as const,
  displayName: '周报小助手',
  slug: 'weekly-report',
  description: '把一周工作整理成周报',
  persona: '你是周报助手。',
  personaSummary: '写周报',
  skillSummary: '无专属技能包',
  skill: null,
  allowSkills: [],
  tools: 'none' as const,
}

describe('creation intent detection', () => {
  test('detects canonical phrases and slash command', () => {
    expect(detectAgentCreationIntent('帮我新建一个智能体')?.kind).toBe('create')
    expect(detectAgentCreationIntent('帮我建一个数字员工，专门写周报')?.initialText).toContain('专门写周报')
    expect(detectAgentCreationIntent('/create-agent update weekly-report')?.kind).toBe('update')
    expect(detectAgentCreationIntent('帮我做个助手')).toBeUndefined()
  })

  test('accepts the conservative regex, the bare slash form, and its extra text', () => {
    expect(detectAgentCreationIntent('  新建智能体  ')).toEqual({ kind: 'create', initialText: '' })
    expect(detectAgentCreationIntent('/create-agent')).toEqual({ kind: 'create', initialText: '' })
    expect(detectAgentCreationIntent('/create-agent 我想做周报助手')).toEqual({
      kind: 'create',
      initialText: '我想做周报助手',
    })
    expect(detectAgentCreationIntent('/create-agent update weekly-report 名字改一下')).toEqual({
      kind: 'update',
      slug: 'weekly-report',
      initialText: '名字改一下',
    })
    expect(detectAgentCreationIntent('/create-agentx')).toBeUndefined()
    expect(detectAgentCreationIntent('帮我做个助手')).toBeUndefined()
  })

  test('an update command without a slug stays a create entry', () => {
    expect(detectAgentCreationIntent('/create-agent update')).toEqual({ kind: 'create', initialText: 'update' })
  })
})

describe('create-agent skill injection', () => {
  test('injects create-agent without requiring skill toggles', () => {
    const text = injectCreateAgentSkill('帮我新建一个智能体')
    expect(text).toContain('# 已启用技能：create-agent')
    expect(text).toContain('只通过 `agent_propose` 提交草稿')
    // 模型必须知道草稿编号只给自己看,并原样传给 agent_commit。
    expect(text).toContain('草稿编号')
    expect(text).toContain('不要贴给用户')
  })

  test('an active draft turns the next message into a continue turn', () => {
    const text = injectCreateAgentSkill('可以', 'continue')
    expect(text).toContain('# 已启用技能：create-agent')
    expect(text).toContain('用户请求：\n可以')
  })

  test('update mode names the target slug and only asks for changed fields', () => {
    const text = injectCreateAgentSkill('改一下名字', 'update', 'weekly-report')
    expect(text).toContain('更新目标：@weekly-report')
    expect(text).toContain('用户请求：\n改一下名字')
  })

  test('continue mode tells the model to commit a bare consent phrase', () => {
    const text = injectCreateAgentSkill('可以', 'continue')
    expect(text).toContain('agent_commit')
  })
})

describe('creation tool attachments', () => {
  test('attach and detach only the two creation tools for one session and refresh its restrict', () => {
    const maps = emptyAttachments()
    const calls: RestrictCalls = { sessions: [] }
    const ctx = { huaanworkAttachments: maps, root: restrictRoot(calls) }
    attachAgentTools(maps, 'other-session', ['mcp__demo__echo'])

    attachCreationTools(ctx, 'session-a')
    expect(isAgentToolAttached(maps, 'session-a', 'agent_propose')).toBe(true)
    expect(isAgentToolAttached(maps, 'session-a', 'agent_commit')).toBe(true)
    expect(isAgentToolAttached(maps, 'session-b', 'agent_propose')).toBe(false)
    expect(isAgentToolAttached(maps, 'other-session', 'mcp__demo__echo')).toBe(true)
    expect(calls.sessions).toEqual(['session-a'])

    detachCreationTools(ctx, 'session-a')
    expect(isAgentToolAttached(maps, 'session-a', 'agent_propose')).toBe(false)
    expect(isAgentToolAttached(maps, 'session-a', 'agent_commit')).toBe(false)
    expect(isAgentToolAttached(maps, 'other-session', 'mcp__demo__echo')).toBe(true)
    expect(calls.sessions).toEqual(['session-a', 'session-a'])
  })

  test('attach and detach are no-ops without an attachments map', () => {
    const calls: RestrictCalls = { sessions: [] }
    expect(() => attachCreationTools({ root: restrictRoot(calls) }, 'session-a')).not.toThrow()
    expect(() => detachCreationTools({ root: restrictRoot(calls) }, 'session-a')).not.toThrow()
    expect(calls.sessions).toEqual([])
  })
})

describe('sendToAgent creation gate', () => {
  test('a create phrase injects the skill, notes the raw turn, and keeps tools across idle without a draft', async () => {
    const root = makeRoot()
    const events: RpcEvent[] = []
    const received: unknown[] = []
    const sessionId = 'huaanwork-0123456789abcdef'
    const idle = deferred()
    const maps = emptyAttachments()
    const agent = makeAgent(sessionId, received, idle.promise)
    const ctx = makeSessionCtx(agent, sessionId, maps)
    const noted: Array<[string, string]> = []
    setAgentPackageHost(
      fakeHost({
        noteUserText: (id, text) => noted.push([id, text]),
        lastUserText: (id) => noted.find(([candidate]) => candidate === id)?.[1],
      }),
    )

    await sendToAgent(ctx, makeRouteCtx(root, events), { text: '帮我新建一个智能体', sessionId })

    // 每轮原句在 sendToAgent 顶部记一次,创建门禁内再记一次(同句重复写入无害)。
    expect(noted.length).toBeGreaterThan(0)
    expect(noted.every(([id, text]) => id === sessionId && text === '帮我新建一个智能体')).toBe(true)
    expect(isAgentToolAttached(maps, sessionId, 'agent_propose')).toBe(true)
    expect(isAgentToolAttached(maps, sessionId, 'agent_commit')).toBe(true)
    const message = received[0] as { content: { text: string }[] }
    expect(message.content[0]?.text).toContain('# 已启用技能：create-agent')
    expect(message.content[0]?.text).toContain('用户请求：\n帮我新建一个智能体')

    idle.resolve()
    await idle.promise
    await new Promise((done) => setTimeout(done, 0))
    // 设计 §6.2:访谈跨多轮,第一轮结束时没有草稿也不能卸下工具。
    expect(isAgentToolAttached(maps, sessionId, 'agent_propose')).toBe(true)
    expect(isAgentToolAttached(maps, sessionId, 'agent_commit')).toBe(true)
  })

  test('an interview turn without a draft keeps the tools callable, so the next turn can propose', async () => {
    const root = makeRoot()
    const events: RpcEvent[] = []
    const received: unknown[] = []
    const sessionId = 'huaanwork-0123456789abcdef'
    const idle = deferred()
    const maps = emptyAttachments()
    const agent = makeAgent(sessionId, received, idle.promise)
    const ctx = makeSessionCtx(agent, sessionId, maps)
    const host = createAgentPackageHost({ profileDir: root, takenSlugs: () => [] })
    setAgentPackageHost(host)
    const registered = new Map<string, { execute(args: unknown, exec: unknown): Promise<{ text: string }> }>()
    const disposeTools = registerAgentPackageCreationTools(
      {
        tools: {
          register(definition: unknown) {
            const tool = definition as {
              name: string
              execute(args: unknown, exec: unknown): Promise<{ text: string }>
            }
            registered.set(tool.name, tool)
            return () => registered.delete(tool.name)
          },
        },
        huaanworkEmit: (event: RpcEvent) => events.push(event),
        huaanworkAttachments: maps,
        root: restrictRoot({ sessions: [] }),
      },
      host,
    )

    // 第一轮:创建入口命中,但模型这一轮只问问题,没有草稿。
    await sendToAgent(ctx, makeRouteCtx(root, events), { text: '帮我新建一个智能体', sessionId })
    idle.resolve()
    await idle.promise
    await new Promise((done) => setTimeout(done, 0))
    expect(loadAgentPackageDraft(root, sessionId)).toBeUndefined()
    expect(isAgentToolAttached(maps, sessionId, AGENT_PROPOSE_TOOL)).toBe(true)

    // 第二轮是访谈回答:不命中入口说法,也还没有草稿,创建门禁不会重新进入;
    // 工具必须仍然挂着,模型才能在这一轮提交草稿。
    await sendToAgent(ctx, makeRouteCtx(root, events), { text: '每周五汇总本周工作', sessionId })
    await new Promise((done) => setTimeout(done, 0))
    const answer = received[1] as { content: { text: string }[] }
    expect(answer.content[0]?.text).toBe('每周五汇总本周工作')
    expect(isAgentToolAttached(maps, sessionId, AGENT_PROPOSE_TOOL)).toBe(true)
    expect(isAgentToolAttached(maps, sessionId, 'agent_commit')).toBe(true)

    const value = await registered.get(AGENT_PROPOSE_TOOL)?.execute(
      {
        mode: 'create',
        displayName: '周报小助手',
        slug: 'weekly-report',
        description: '把一周工作整理成周报',
        persona: '你是周报助手。',
        personaSummary: '写周报',
        skillSummary: '无专属技能包',
        tools: 'none',
      },
      { agent: { id: sessionId, session: { id: sessionId } } },
    )
    expect(value?.text).toContain('@标识：weekly-report')
    expect(loadAgentPackageDraft(root, sessionId)).toBeDefined()
    expect(events).toContainEqual({ event: 'agent/confirm', card: expect.objectContaining({ slug: 'weekly-report' }), sessionId })
    disposeTools()
  })

  test('an active draft turns the next message into a continue turn and keeps tools after idle', async () => {
    const root = makeRoot()
    const events: RpcEvent[] = []
    const received: unknown[] = []
    const sessionId = 'huaanwork-0123456789abcdef'
    const idle = deferred()
    const maps = emptyAttachments()
    const agent = makeAgent(sessionId, received, idle.promise)
    const ctx = makeSessionCtx(agent, sessionId, maps)
    setAgentPackageHost(fakeHost({ hasDraft: () => true }))

    await sendToAgent(ctx, makeRouteCtx(root, events), { text: '可以', sessionId })
    const message = received[0] as { content: { text: string }[] }
    expect(message.content[0]?.text).toContain('用户请求：\n可以')
    expect(message.content[0]?.text).toContain('agent_commit')

    idle.resolve()
    await idle.promise
    await new Promise((done) => setTimeout(done, 0))
    // 草稿仍在:工具必须留到下一轮确认。
    expect(isAgentToolAttached(maps, sessionId, 'agent_propose')).toBe(true)
    expect(isAgentToolAttached(maps, sessionId, 'agent_commit')).toBe(true)
  })

  test('/create-agent as a skill param enters the creation flow instead of the disabled-skill path', async () => {
    const root = makeRoot()
    const events: RpcEvent[] = []
    const received: unknown[] = []
    const sessionId = 'huaanwork-0123456789abcdef'
    const idle = deferred()
    const maps = emptyAttachments()
    const agent = makeAgent(sessionId, received, idle.promise)
    const ctx = makeSessionCtx(agent, sessionId, maps)
    const updates: Array<[string, string]> = []
    setAgentPackageHost(
      fakeHost({
        beginUpdate: async (id, slug) => {
          updates.push([id, slug])
        },
      }),
    )

    await sendToAgent(ctx, makeRouteCtx(root, events), { skill: 'create-agent', text: 'update weekly-report', sessionId })

    expect(updates).toEqual([[sessionId, 'weekly-report']])
    const message = received[0] as { content: { text: string }[] }
    expect(message.content[0]?.text).toContain('# 已启用技能：create-agent')
    expect(message.content[0]?.text).toContain('更新目标：@weekly-report')
    expect(isAgentToolAttached(maps, sessionId, 'agent_propose')).toBe(true)
    idle.resolve()
    await idle.promise
  })

  test('the skill param without a command body starts a create turn', async () => {
    const root = makeRoot()
    const events: RpcEvent[] = []
    const received: unknown[] = []
    const sessionId = 'huaanwork-0123456789abcdef'
    const idle = deferred()
    const agent = makeAgent(sessionId, received, idle.promise)
    const ctx = makeSessionCtx(agent, sessionId)
    setAgentPackageHost(fakeHost())

    await sendToAgent(ctx, makeRouteCtx(root, events), { skill: 'create-agent', text: '', sessionId })
    const message = received[0] as { content: { text: string }[] }
    expect(message.content[0]?.text).toContain('按该技能开始。')
    idle.resolve()
    await idle.promise
  })

  test('cancel discards the draft, emits the fixed notice, and sends nothing to the model', async () => {
    const root = makeRoot()
    const events: RpcEvent[] = []
    const received: unknown[] = []
    const sessionId = 'huaanwork-0123456789abcdef'
    const maps = emptyAttachments()
    const agent = makeAgent(sessionId, received)
    const ctx = makeSessionCtx(agent, sessionId, maps)
    const host = createAgentPackageHost({ profileDir: root, takenSlugs: () => [] })
    setAgentPackageHost(host)
    const proposed = await proposeAgentPackage(root, sessionId, draftProposal, [])
    expect(proposed.ok).toBe(true)
    expect(loadAgentPackageDraft(root, sessionId)).toBeDefined()
    attachAgentTools(maps, sessionId, [AGENT_PROPOSE_TOOL, AGENT_COMMIT_TOOL])
    expect(isAgentToolAttached(maps, sessionId, AGENT_PROPOSE_TOOL)).toBe(true)

    await sessionSend(ctx, makeRouteCtx(root, events), { text: '取消', sessionId })

    expect(events).toContainEqual({ event: 'agent/notice', text: '已取消创建，没有写入智能体。', sessionId })
    expect(loadAgentPackageDraft(root, sessionId)).toBeUndefined()
    expect(received).toHaveLength(0)
    expect(isAgentToolAttached(maps, sessionId, AGENT_PROPOSE_TOOL)).toBe(false)
    expect(isAgentToolAttached(maps, sessionId, AGENT_COMMIT_TOOL)).toBe(false)
  })

  test('a skill turn after a consent turn cannot commit using the stale consent text', async () => {
    const root = makeRoot()
    const events: RpcEvent[] = []
    const received: unknown[] = []
    const sessionId = 'huaanwork-0123456789abcdef'
    const maps = emptyAttachments()
    const agent = makeAgent(sessionId, received)
    const ctx = makeSessionCtx(agent, sessionId, maps)
    const host = createAgentPackageHost({ profileDir: root, takenSlugs: () => [] })
    setAgentPackageHost(host)
    mkdirSync(join(root, 'skills', 'weekly-helper'), { recursive: true })
    writeFileSync(
      join(root, 'skills', 'weekly-helper', 'SKILL.md'),
      '---\nname: weekly-helper\ndescription: 整理周报素材\n---\n\n整理吧。\n',
      'utf8',
    )

    const proposed = await host.propose(sessionId, draftProposal)
    expect(proposed.ok).toBe(true)
    const draftId = proposed.ok ? proposed.draftId : ''

    // 同意轮:用户只说了「可以」,模型没有在这一轮提交。
    await sendToAgent(ctx, makeRouteCtx(root, events), { text: '可以', sessionId })
    expect(host.lastUserText(sessionId)).toBe('可以')

    // 技能轮旁路创建门禁,但仍是同一会话的下一轮用户发言;原句必须覆盖「可以」。
    await sendToAgent(ctx, makeRouteCtx(root, events), { skill: 'weekly-helper', text: '整理今天的内容', sessionId })
    expect(host.lastUserText(sessionId)).toBe('整理今天的内容')

    const committed = await host.commit(sessionId, draftId, host.lastUserText(sessionId) ?? '')
    expect(committed.ok).toBe(false)
    expect(committed.ok ? '' : committed.error).toContain('用户原句不是同意创建的说法')
    expect(loadAgentPackageDraft(root, sessionId)).toBeDefined()
  })

  test('/create-agent update <missing> emits a notice instead of failing the send', async () => {
    const root = makeRoot()
    const events: RpcEvent[] = []
    const received: unknown[] = []
    const sessionId = 'huaanwork-0123456789abcdef'
    const maps = emptyAttachments()
    const agent = makeAgent(sessionId, received)
    const ctx = makeSessionCtx(agent, sessionId, maps)
    setAgentPackageHost(createAgentPackageHost({ profileDir: root, takenSlugs: () => [] }))

    const result = await sessionSend(ctx, makeRouteCtx(root, events), {
      text: '/create-agent update no-such-agent',
      sessionId,
    })

    expect(result).toEqual({ queued: true, sessionId })
    expect(events).toContainEqual({
      event: 'agent/notice',
      text: '无法进入更新模式：智能体 @no-such-agent 不存在',
      sessionId,
    })
    expect(received).toHaveLength(0)
    expect(isAgentToolAttached(maps, sessionId, AGENT_PROPOSE_TOOL)).toBe(false)
  })

  test('cancel without a draft falls through to a normal turn', async () => {
    const root = makeRoot()
    const events: RpcEvent[] = []
    const received: unknown[] = []
    const sessionId = 'huaanwork-0123456789abcdef'
    const agent = makeAgent(sessionId, received)
    const ctx = makeSessionCtx(agent, sessionId)
    setAgentPackageHost(fakeHost({ cancel: async () => false }))

    await sessionSend(ctx, makeRouteCtx(root, events), { text: '取消', sessionId })
    const message = received[0] as { content: { text: string }[] }
    expect(message.content[0]?.text).toBe('取消')
    expect(events.some((event) => event.event === 'agent/notice')).toBe(false)
  })

  test('no injected host leaves the send path unchanged', async () => {
    const root = makeRoot()
    const events: RpcEvent[] = []
    const received: unknown[] = []
    const sessionId = 'huaanwork-0123456789abcdef'
    const agent = makeAgent(sessionId, received)
    const ctx = makeSessionCtx(agent, sessionId)

    await sessionSend(ctx, makeRouteCtx(root, events), { text: '帮我新建一个智能体', sessionId })
    const message = received[0] as { content: { text: string }[] }
    expect(message.content[0]?.text).toBe('帮我新建一个智能体')
  })
})

describe('internal skill hiding', () => {
  test('listBundledSkills keeps create-agent for taken-name checks, the skill center filters it', async () => {
    expect(listBundledSkills().some((skill) => skill.name === 'create-agent')).toBe(true)
    expect(INTERNAL_BUNDLED_SKILLS.has('create-agent')).toBe(true)

    const root = makeRoot()
    mkdirSync(join(root, 'skills'), { recursive: true })
    const entry = ROUTE_TABLE.find((route) => route.method === 'skill.list')
    expect(entry).toBeDefined()
    const result = (await entry?.handler(
      { method: 'GET', query: new URLSearchParams(), body: undefined } as never,
      makeRouteCtx(root, []),
    )) as { skills: Array<{ name: string }> }
    expect(result.skills.some((skill) => skill.name === 'create-agent')).toBe(false)
    expect(result.skills.some((skill) => skill.name === 'explore')).toBe(true)
  })
})
