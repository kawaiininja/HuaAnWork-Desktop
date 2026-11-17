import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  CorruptAgentPackageDraftError,
  loadAgentPackageDraft,
  proposeAgentPackage,
} from '../../src/huaanwork-host/agent-package/drafts.ts'
import {
  attachCreationTools,
  detectAgentCreationIntent,
  detachCreationTools,
  injectCreateAgentSkill,
} from '../../src/huaanwork-host/agent-package/creation.ts'
import { dispatchAt } from '../../src/huaanwork-host/agent-invoke.ts'
import {
  attachSkillCreationTools,
  createSkillCreationHost,
  detachSkillCreationTools,
  injectCreateSkill,
  setSkillCreationHost,
} from '../../src/huaanwork-host/skill-creation.ts'
import { commitSkillCreation, proposeSkillCreation } from '../../src/huaanwork-host/skill-creation-drafts.ts'
import { INTERNAL_BUNDLED_SKILLS, listBundledSkills } from '../../src/huaanwork-guardrails/skills.ts'
import { setUserSkillToggle } from '../../src/huaanwork-host/skill-local-state.ts'
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
import { createTurnScheduler, type TurnScheduler } from '../../src/huaanwork-host/turn-scheduler.ts'

// 路由级互斥用例要钉住「是否注入 / 是否挂载 / 是否 @ 分发」,而这些是模块级函数,
// 只能经模块 mock 记录调用;包装函数一律回调真实实现,行为断言仍走真实路径。
vi.mock('../../src/huaanwork-host/agent-package/creation.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/huaanwork-host/agent-package/creation.ts')>()
  return {
    ...actual,
    injectCreateAgentSkill: vi.fn((text: string, mode?: Parameters<typeof actual.injectCreateAgentSkill>[1], slug?: string) =>
      actual.injectCreateAgentSkill(text, mode, slug),
    ),
    attachCreationTools: vi.fn((ctx: Parameters<typeof actual.attachCreationTools>[0], sessionId: string) =>
      actual.attachCreationTools(ctx, sessionId),
    ),
    // 取消失败必须保留工具:卸载函数同样要能被计数,否则只能间接推断。
    detachCreationTools: vi.fn((ctx: Parameters<typeof actual.detachCreationTools>[0], sessionId: string) =>
      actual.detachCreationTools(ctx, sessionId),
    ),
  }
})

vi.mock('../../src/huaanwork-host/skill-creation.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/huaanwork-host/skill-creation.ts')>()
  return {
    ...actual,
    injectCreateSkill: vi.fn((text: string, mode?: Parameters<typeof actual.injectCreateSkill>[1]) =>
      actual.injectCreateSkill(text, mode),
    ),
    attachSkillCreationTools: vi.fn((ctx: Parameters<typeof actual.attachSkillCreationTools>[0], sessionId: string) =>
      actual.attachSkillCreationTools(ctx, sessionId),
    ),
    detachSkillCreationTools: vi.fn((ctx: Parameters<typeof actual.detachSkillCreationTools>[0], sessionId: string) =>
      actual.detachSkillCreationTools(ctx, sessionId),
    ),
  }
})

// `@agent` 只用于证明显式 @ 分流不被创建互斥拦下;分发本身由 sessions.spec.ts 覆盖。
vi.mock('../../src/huaanwork-host/agent-invoke.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/huaanwork-host/agent-invoke.ts')>()
  return {
    ...actual,
    dispatchAt: vi.fn(async () => ({ text: 'at-dispatched', afterIdle: async () => undefined })),
  }
})

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
  setSkillCreationHost(undefined)
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

function testScheduler(): TurnScheduler {
  return createTurnScheduler({ maxConcurrentTurns: () => 8, modelExists: () => true })
}

function makeSessionCtx(
  agent: ListedAgent,
  sessionId: string,
  maps = emptyAttachments(),
  scheduler: TurnScheduler = testScheduler(),
): SessionRuntimeContext {
  return {
    huaanworkAttachments: maps,
    huaanworkSessionModels: new Map(),
    huaanworkSessionRoots: new Map(),
    huaanworkTurnScheduler: scheduler,
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
    describeDraft: () => undefined,
    beginUpdate: async () => undefined,
    lastUserText: () => undefined,
    noteUserText: () => undefined,
    noteCreationTurn: () => undefined,
    listLocal: () => [],
    detail: () => undefined,
    setEnabled: () => undefined,
    listWithLegacy: async () => ({ packages: [], catalogAgents: [] }),
    invocableWithLegacy: async () => ({ items: [] }),
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
    ctx.huaanworkSessionModels?.set(sessionId, 'previous-model')

    const result = await sessionSend(ctx, makeRouteCtx(root, events), { text: '取消', sessionId, tabId: 'tab-a' })

    expect(result).toEqual({ queued: true, waiting: false, started: false, sessionId })
    // 没有 followup:不写本次模型键,也不清掉发送前已有的绑定。
    expect(ctx.huaanworkSessionModels?.get(sessionId)).toBe('previous-model')
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
    setUserSkillToggle(root, 'weekly-helper', true)

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

  test('a skill turn whose text is itself a consent phrase cannot commit an old draft', async () => {
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
    setUserSkillToggle(root, 'weekly-helper', true)

    const proposed = await host.propose(sessionId, draftProposal)
    expect(proposed.ok).toBe(true)
    const draftId = proposed.ok ? proposed.draftId : ''

    // 同意轮:用户只说了「可以」,模型没有在这一轮提交。
    await sendToAgent(ctx, makeRouteCtx(root, events), { text: '可以', sessionId })
    expect(host.lastUserText(sessionId)).toBe('可以')

    // 技能轮旁路创建门禁;原文仍是同意句,但不能借此提交上一轮留下的草稿。
    await sendToAgent(ctx, makeRouteCtx(root, events), { skill: 'weekly-helper', text: '可以', sessionId })
    expect(host.lastUserText(sessionId)).toBe('可以')

    const committed = await host.commit(sessionId, draftId, host.lastUserText(sessionId) ?? '')
    expect(committed.ok).toBe(false)
    expect(committed.ok ? '' : committed.error).toContain('本轮不是创建/继续创建流程')
    expect(loadAgentPackageDraft(root, sessionId)).toBeDefined()
  })

  test('a consent turn through sendToAgent marks the creation turn and commits', async () => {
    const root = makeRoot()
    const events: RpcEvent[] = []
    const received: unknown[] = []
    const sessionId = 'huaanwork-0123456789abcdef'
    const maps = emptyAttachments()
    const agent = makeAgent(sessionId, received)
    const ctx = makeSessionCtx(agent, sessionId, maps)
    const host = createAgentPackageHost({ profileDir: root, takenSlugs: () => [] })
    setAgentPackageHost(host)

    const proposed = await host.propose(sessionId, draftProposal)
    expect(proposed.ok).toBe(true)
    const draftId = proposed.ok ? proposed.draftId : ''

    await sendToAgent(ctx, makeRouteCtx(root, events), { text: '可以', sessionId })

    const committed = await host.commit(sessionId, draftId, host.lastUserText(sessionId) ?? '')
    expect(committed.ok).toBe(true)
    expect(loadAgentPackageDraft(root, sessionId)).toBeUndefined()
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
      tabId: 'tab-a',
    })

    expect(result).toEqual({ queued: true, waiting: false, started: false, sessionId })
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

    await sessionSend(ctx, makeRouteCtx(root, events), { text: '取消', sessionId, tabId: 'tab-a' })
    const message = received[0] as { content: { text: string }[] }
    expect(message.content[0]?.text).toBe('取消')
    expect(events.some((event) => event.event === 'agent/notice')).toBe(false)
  })

  test('a queued creation cancel fails without starting', async () => {
    const root = makeRoot()
    const events: RpcEvent[] = []
    const received: unknown[] = []
    const sessionId = 'huaanwork-0123456789abcdef'
    const idle = deferred()
    const maps = emptyAttachments()
    const agent = makeAgent(sessionId, received, idle.promise)
    const ctx = makeSessionCtx(agent, sessionId, maps)
    setAgentPackageHost(createAgentPackageHost({ profileDir: root, takenSlugs: () => [] }))
    const proposed = await proposeAgentPackage(root, sessionId, draftProposal, [])
    expect(proposed.ok).toBe(true)

    const routeCtx = makeRouteCtx(root, events)
    await sessionSend(ctx, routeCtx, { text: '帮我新建一个智能体', sessionId, tabId: 'tab-a' })
    const queued = await sessionSend(ctx, routeCtx, { text: '取消', sessionId, tabId: 'tab-a' })
    expect(queued).toMatchObject({ queued: true, waiting: true, started: false })

    idle.resolve()
    await vi.waitFor(() => expect(events.some((event) => event.event === 'session/queue-fail')).toBe(true))
    expect(events.some((event) => event.event === 'session/queue-start')).toBe(false)
    expect(events).toContainEqual({ event: 'agent/notice', text: '已取消创建，没有写入智能体。', sessionId })
    const failure = events.find((event) => event.event === 'session/queue-fail')
    expect(failure).toMatchObject({ reason: '已取消创建，没有写入智能体。' })
    expect(received).toHaveLength(1)
    expect(loadAgentPackageDraft(root, sessionId)).toBeUndefined()
  })

  test('a queued update failure fails without starting', async () => {
    const root = makeRoot()
    const events: RpcEvent[] = []
    const received: unknown[] = []
    const sessionId = 'huaanwork-0123456789abcdef'
    const idle = deferred()
    const agent = makeAgent(sessionId, received, idle.promise)
    const ctx = makeSessionCtx(agent, sessionId)
    setAgentPackageHost(createAgentPackageHost({ profileDir: root, takenSlugs: () => [] }))

    const routeCtx = makeRouteCtx(root, events)
    await sessionSend(ctx, routeCtx, { text: '普通一轮', sessionId, tabId: 'tab-a' })
    const queued = await sessionSend(ctx, routeCtx, {
      text: '/create-agent update no-such-agent',
      sessionId,
      tabId: 'tab-a',
    })
    expect(queued).toMatchObject({ queued: true, waiting: true, started: false })

    idle.resolve()
    await vi.waitFor(() => expect(events.some((event) => event.event === 'session/queue-fail')).toBe(true))
    expect(events.some((event) => event.event === 'session/queue-start')).toBe(false)
    expect(events).toContainEqual({
      event: 'agent/notice',
      text: '无法进入更新模式：智能体 @no-such-agent 不存在',
      sessionId,
    })
    const failure = events.find((event) => event.event === 'session/queue-fail')
    expect(failure).toMatchObject({ reason: '无法进入更新模式：智能体 @no-such-agent 不存在' })
    expect(received).toHaveLength(1)
  })

  test('no injected host leaves the send path unchanged', async () => {
    const root = makeRoot()
    const events: RpcEvent[] = []
    const received: unknown[] = []
    const sessionId = 'huaanwork-0123456789abcdef'
    const agent = makeAgent(sessionId, received)
    const ctx = makeSessionCtx(agent, sessionId)

    await sessionSend(ctx, makeRouteCtx(root, events), { text: '帮我新建一个智能体', sessionId, tabId: 'tab-a' })
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
    const entry = ROUTE_TABLE.find((route) => route.method === 'skill.centerList')
    expect(entry).toBeDefined()
    const result = (await entry?.handler(
      { method: 'GET', query: new URLSearchParams(), body: undefined } as never,
      makeRouteCtx(root, []),
    )) as { skills: Array<{ name: string }> }
    expect(result.skills.some((skill) => skill.name === 'create-agent')).toBe(false)
    expect(result.skills.some((skill) => skill.name === 'explore')).toBe(true)
  })
})

// —— 会话路由与智能体/技能双向互斥(设计 §7) ——

const ROUTING_SESSION_ID = 'session-1'

function agentDraftJson(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      draftId: 'agent-draft-1',
      mode: 'create',
      slug: 'weekly-report',
      displayName: '周报小助手',
      description: '把一周工作整理成周报',
      persona: '你是周报助手。',
      personaSummary: '写周报',
      skillSummary: '无专属技能包',
      skill: null,
      allowSkills: [],
      tools: 'none',
      ...overrides,
    },
    null,
    2,
  )}\n`
}

function skillDraftJson(sessionId: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      draftId: 'draft-1',
      sessionId,
      proposal: { name: 'daily-summary', description: '生成日报', body: '整理输入并生成日报' },
      createdAt: '2026-11-15T00:00:00.000Z',
      updatedAt: '2026-11-15T00:00:00.000Z',
    },
    null,
    2,
  )}\n`
}

function lastEventText(events: RpcEvent[]): string {
  const last = events.at(-1)
  return last !== undefined && 'text' in last && typeof last.text === 'string' ? last.text : ''
}

function eventTexts(events: RpcEvent[]): string[] {
  return events.flatMap((event) => ('text' in event && typeof event.text === 'string' ? [event.text] : []))
}

function enableUserSkill(root: string, name: string): void {
  mkdirSync(join(root, 'skills', name), { recursive: true })
  writeFileSync(
    join(root, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 演示技能\n---\n按演示技能说明执行。\n`,
    'utf8',
  )
  setUserSkillToggle(root, name, true)
}

function routingHarness(options: { agentDraft?: boolean; skillDraft?: boolean } = {}) {
  const root = makeRoot()
  const events: RpcEvent[] = []
  const received: unknown[] = []
  const maps = emptyAttachments()
  const agent = makeAgent(ROUTING_SESSION_ID, received)
  const ctx = makeSessionCtx(agent, ROUTING_SESSION_ID, maps)
  const packageHost: AgentPackageHost = createAgentPackageHost({ profileDir: root, takenSlugs: () => [] })
  const skillHost = createSkillCreationHost({ profileDir: root })
  setAgentPackageHost(packageHost)
  setSkillCreationHost(skillHost)

  const agentDraftPath = join(root, 'agents', '.drafts', `${ROUTING_SESSION_ID}.json`)
  const skillDraftPath = join(root, 'skill-creation-drafts', `${ROUTING_SESSION_ID}.json`)

  const harness = {
    root,
    events,
    received,
    maps,
    ctx,
    packageHost,
    skillHost,
    agentDraftPath,
    skillDraftPath,
    originalAgentDraft: '',
    originalSkillDraft: '',
    proposeAgentPackage: vi.spyOn(packageHost, 'propose'),
    commitAgentPackage: vi.spyOn(packageHost, 'commit'),
    cancelAgent: vi.spyOn(packageHost, 'cancel'),
    cancelSkill: vi.spyOn(skillHost, 'cancel'),
    seedAgentDraft() {
      mkdirSync(join(root, 'agents', '.drafts'), { recursive: true })
      writeFileSync(agentDraftPath, agentDraftJson(), 'utf8')
      harness.originalAgentDraft = readFileSync(agentDraftPath, 'utf8')
    },
    seedSkillDraft() {
      mkdirSync(join(root, 'skill-creation-drafts'), { recursive: true })
      writeFileSync(skillDraftPath, skillDraftJson(ROUTING_SESSION_ID), 'utf8')
      harness.originalSkillDraft = readFileSync(skillDraftPath, 'utf8')
    },
    seedBothDrafts() {
      harness.seedAgentDraft()
      harness.seedSkillDraft()
    },
    send(params: Record<string, unknown>) {
      return sendToAgent(ctx, makeRouteCtx(root, events), { sessionId: ROUTING_SESSION_ID, ...params })
    },
  }
  if (options.agentDraft === true) harness.seedAgentDraft()
  if (options.skillDraft === true) harness.seedSkillDraft()
  return harness
}

describe('agent and skill creation routing', () => {
  // 文件级 afterEach 的 restoreAllMocks 恢复实现但不清调用记录;模块 mock 的回调计数必须逐例清零。
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const matrix = [
    { existing: 'agent', incoming: '/create-skill', rejected: true },
    { existing: 'agent', incoming: '帮我创建一个技能', rejected: true },
    { existing: 'skill', incoming: '/create-agent', rejected: true },
    { existing: 'skill', incoming: '/create-agent update weekly-report', rejected: true },
    { existing: 'skill', incoming: '新建一个智能体', rejected: true },
    { existing: 'agent', incoming: '/create-agent', rejected: false },
    { existing: 'skill', incoming: '/create-skill', rejected: false },
    { existing: 'none', incoming: '修改技能 weekly-report', rejected: false },
  ] as const

  for (const testCase of matrix) {
    test(`${String(testCase.existing)} draft + ${testCase.incoming} => rejected: ${String(testCase.rejected)}`, async () => {
      const harness = routingHarness({
        agentDraft: testCase.existing === 'agent',
        skillDraft: testCase.existing === 'skill',
      })

      const result = await harness.send({ text: testCase.incoming })

      if (testCase.rejected) {
        expect(result.started).toBe(false)
        expect(injectCreateSkill).not.toHaveBeenCalled()
        expect(injectCreateAgentSkill).not.toHaveBeenCalled()
        expect(attachSkillCreationTools).not.toHaveBeenCalled()
        expect(attachCreationTools).not.toHaveBeenCalled()
        if (testCase.existing === 'agent') {
          expect(readFileSync(harness.agentDraftPath, 'utf8')).toBe(harness.originalAgentDraft)
          expect(existsSync(harness.skillDraftPath)).toBe(false)
          expect(lastEventText(harness.events)).toContain('weekly-report')
        } else {
          expect(readFileSync(harness.skillDraftPath, 'utf8')).toBe(harness.originalSkillDraft)
          expect(existsSync(harness.agentDraftPath)).toBe(false)
          expect(lastEventText(harness.events)).toContain('daily-summary')
        }
        return
      }

      expect(result.started).toBe(true)
      if (testCase.incoming === '/create-agent') {
        expect(injectCreateAgentSkill).toHaveBeenCalledTimes(1)
        expect(attachCreationTools).toHaveBeenCalledTimes(1)
        expect(injectCreateSkill).not.toHaveBeenCalled()
        expect(attachSkillCreationTools).not.toHaveBeenCalled()
      } else if (testCase.incoming === '/create-skill') {
        expect(injectCreateSkill).toHaveBeenCalledTimes(1)
        expect(attachSkillCreationTools).toHaveBeenCalledTimes(1)
        expect(injectCreateAgentSkill).not.toHaveBeenCalled()
        expect(attachCreationTools).not.toHaveBeenCalled()
      } else {
        // 负例:修改技能不是新建入口,不进入任何创建流程。
        expect(injectCreateSkill).not.toHaveBeenCalled()
        expect(injectCreateAgentSkill).not.toHaveBeenCalled()
        expect(attachSkillCreationTools).not.toHaveBeenCalled()
        expect(attachCreationTools).not.toHaveBeenCalled()
      }
    })
  }

  test('does not let an agent draft hijack /create-skill into agent continue and commit', async () => {
    const harness = routingHarness({ agentDraft: true })

    const result = await harness.send({ text: '/create-skill' })

    expect(result.started).toBe(false)
    expect(harness.events.filter((event) => event.event === 'agent/confirm')).toHaveLength(0)
    expect(harness.proposeAgentPackage).not.toHaveBeenCalled()
    expect(harness.commitAgentPackage).not.toHaveBeenCalled()
    expect(readFileSync(harness.agentDraftPath, 'utf8')).toBe(harness.originalAgentDraft)
  })

  test('terminates the creation routing with a notice when the agent draft is corrupt', async () => {
    const harness = routingHarness()
    mkdirSync(join(harness.root, 'agents', '.drafts'), { recursive: true })
    writeFileSync(harness.agentDraftPath, '{corrupt', 'utf8')

    const result = await harness.send({ text: '/create-skill' })

    expect(result.started).toBe(false)
    expect(lastEventText(harness.events)).toContain('损坏')
    expect(injectCreateSkill).not.toHaveBeenCalled()
    expect(attachSkillCreationTools).not.toHaveBeenCalled()
    expect(readFileSync(harness.agentDraftPath, 'utf8')).toBe('{corrupt')
  })

  test('lets /create-agent cancel clean a corrupt agent draft (NI-1 recovery path)', async () => {
    const harness = routingHarness()
    mkdirSync(join(harness.root, 'agents', '.drafts'), { recursive: true })
    writeFileSync(harness.agentDraftPath, '{corrupt', 'utf8')

    const result = await harness.send({ text: '/create-agent cancel' })

    expect(result.started).toBe(false)
    expect(lastEventText(harness.events)).toContain('已取消创建智能体')
    expect(harness.cancelAgent).toHaveBeenCalledWith(ROUTING_SESSION_ID, { explicit: true })
    expect(existsSync(harness.agentDraftPath)).toBe(false)
  })

  test('cleans a corrupt agent draft alongside a valid skill draft without touching the skill draft', async () => {
    const harness = routingHarness()
    harness.seedBothDrafts()
    writeFileSync(harness.agentDraftPath, '{corrupt', 'utf8')

    const result = await harness.send({ text: '/create-agent cancel' })

    expect(result.started).toBe(false)
    expect(existsSync(harness.agentDraftPath)).toBe(false)
    expect(readFileSync(harness.skillDraftPath, 'utf8')).toBe(harness.originalSkillDraft)
  })

  test('does not reject a normal skill turn with creation-like body while an agent draft exists', async () => {
    const harness = routingHarness({ agentDraft: true })
    enableUserSkill(harness.root, 'weekly-report')

    const result = await harness.send({
      skill: 'weekly-report',
      text: '创建技能正文，但仍是一次普通技能调用',
    })

    expect(result).toMatchObject({ started: true })
    expect(
      harness.events.filter((event) => event.event === 'skill/notice' && event.text.includes('请先完成')),
    ).toHaveLength(0)
    expect(injectCreateSkill).not.toHaveBeenCalled()
    expect(readFileSync(harness.agentDraftPath, 'utf8')).toBe(harness.originalAgentDraft)
  })

  test('does not reject an @agent turn with creation-like body while a skill draft exists', async () => {
    const harness = routingHarness({ skillDraft: true })

    const result = await harness.send({
      at: { name: 'legacy-agent' },
      text: '创建技能正文，但仍是一次显式 @ 调用',
    })

    expect(result).toMatchObject({ started: true })
    expect(dispatchAt).toHaveBeenCalledTimes(1)
    expect(
      harness.events.filter((event) => event.event === 'skill/notice' && event.text.includes('请先完成')),
    ).toHaveLength(0)
    expect(injectCreateSkill).not.toHaveBeenCalled()
  })

  test('rejects bare cancel, propose and commit while both drafts exist', async () => {
    const harness = routingHarness()
    harness.seedBothDrafts()

    const result = await harness.send({ text: '取消' })

    expect(result.started).toBe(false)
    expect(lastEventText(harness.events)).toContain('/create-skill cancel')
    expect(readFileSync(harness.agentDraftPath, 'utf8')).toBe(harness.originalAgentDraft)
    expect(readFileSync(harness.skillDraftPath, 'utf8')).toBe(harness.originalSkillDraft)
    expect(harness.packageHost.cancel).not.toHaveBeenCalled()
    expect(harness.skillHost.cancel).not.toHaveBeenCalled()
    expect(harness.proposeAgentPackage).not.toHaveBeenCalled()
    expect(harness.commitAgentPackage).not.toHaveBeenCalled()
    expect(
      await proposeSkillCreation(harness.root, ROUTING_SESSION_ID, {
        name: 'daily-summary',
        description: '生成日报',
        body: '整理输入并生成日报',
      }),
    ).toMatchObject({ ok: false })
    expect(
      await commitSkillCreation(harness.root, ROUTING_SESSION_ID, 'draft-1', '确认', {
        proposedThisTurn: false,
        creationTurn: true,
      }),
    ).toMatchObject({ ok: false })
  })

  test('keeps ordinary chat out of both creation flows while both drafts exist', async () => {
    const harness = routingHarness()
    harness.seedBothDrafts()

    const result = await harness.send({ text: '普通聊天，不继续任何创建流程' })

    expect(result.started).toBe(true)
    expect(injectCreateSkill).not.toHaveBeenCalled()
    expect(injectCreateAgentSkill).not.toHaveBeenCalled()
    expect(attachSkillCreationTools).not.toHaveBeenCalled()
    expect(attachCreationTools).not.toHaveBeenCalled()
    expect(readFileSync(harness.agentDraftPath, 'utf8')).toBe(harness.originalAgentDraft)
    expect(readFileSync(harness.skillDraftPath, 'utf8')).toBe(harness.originalSkillDraft)
  })

  test.each(['/create-skill', '/create-agent'])(
    'rejects explicit creation entry %s while both drafts exist',
    async (entry) => {
      const harness = routingHarness()
      harness.seedBothDrafts()

      const result = await harness.send({ text: entry })

      expect(result.started).toBe(false)
      expect(lastEventText(harness.events)).toContain('检测到并存')
      expect(injectCreateSkill).not.toHaveBeenCalled()
      expect(injectCreateAgentSkill).not.toHaveBeenCalled()
      expect(attachSkillCreationTools).not.toHaveBeenCalled()
      expect(attachCreationTools).not.toHaveBeenCalled()
      expect(readFileSync(harness.agentDraftPath, 'utf8')).toBe(harness.originalAgentDraft)
      expect(readFileSync(harness.skillDraftPath, 'utf8')).toBe(harness.originalSkillDraft)
    },
  )

  test('cancels only the named flow via explicit cancel entries and recovers the other', async () => {
    const harness = routingHarness()
    harness.seedBothDrafts()

    const skillCancel = await harness.send({ text: '/create-skill cancel' })
    expect(skillCancel.started).toBe(false)
    expect(existsSync(harness.skillDraftPath)).toBe(false)
    expect(readFileSync(harness.agentDraftPath, 'utf8')).toBe(harness.originalAgentDraft)
    expect(lastEventText(harness.events)).toContain('已取消创建技能')

    harness.seedBothDrafts()
    const agentCancel = await harness.send({ text: '/create-agent cancel' })
    expect(agentCancel.started).toBe(false)
    expect(existsSync(harness.agentDraftPath)).toBe(false)
    expect(readFileSync(harness.skillDraftPath, 'utf8')).toBe(harness.originalSkillDraft)
    expect(lastEventText(harness.events)).toContain('已取消创建智能体')

    const continued = await harness.send({ text: '继续修改技能' })
    expect(continued.started).toBe(true)
    expect(injectCreateSkill).toHaveBeenCalledWith('继续修改技能', 'continue')
  })

  // 客户端把斜杠命令拆成 { skill, text }:显式取消必须按入口标志识别,
  // 否则 "cancel" 会被当成新一轮创建正文重新进入访谈。
  test('client-shaped skill cancel discards the draft without re-entering creation', async () => {
    const harness = routingHarness({ skillDraft: true })

    const result = await harness.send({ skill: 'create-skill', text: 'cancel' })

    expect(result.started).toBe(false)
    expect(result.reason).toContain('已取消创建技能')
    expect(harness.cancelSkill).toHaveBeenCalledWith(ROUTING_SESSION_ID, { explicit: true })
    expect(existsSync(harness.skillDraftPath)).toBe(false)
    expect(lastEventText(harness.events)).toContain('已取消创建技能')
    expect(harness.events.at(-1)).toMatchObject({ event: 'skill/notice', terminal: 'cancelled' })
    expect(injectCreateSkill).not.toHaveBeenCalled()
    expect(attachSkillCreationTools).not.toHaveBeenCalled()
    expect(injectCreateAgentSkill).not.toHaveBeenCalled()
    expect(attachCreationTools).not.toHaveBeenCalled()
  })

  test('client-shaped agent cancel discards the draft without starting a turn', async () => {
    const harness = routingHarness({ agentDraft: true })

    const result = await harness.send({ skill: 'create-agent', text: 'cancel' })

    expect(result.started).toBe(false)
    expect(result.reason).toContain('已取消创建智能体')
    expect(harness.cancelAgent).toHaveBeenCalledWith(ROUTING_SESSION_ID, { explicit: true })
    expect(existsSync(harness.agentDraftPath)).toBe(false)
    expect(lastEventText(harness.events)).toContain('已取消创建智能体')
    expect(injectCreateAgentSkill).not.toHaveBeenCalled()
    expect(attachCreationTools).not.toHaveBeenCalled()
    expect(injectCreateSkill).not.toHaveBeenCalled()
    expect(attachSkillCreationTools).not.toHaveBeenCalled()
  })

  // 客户端拆包的 `/create-agent 创建一个技能规划师`:正文命中技能自然语言入口时,
  // 不得把整轮从智能体创建流程抢走,否则两条入口都不启动。
  test('an explicit create-agent body that reads like skill creation stays in the agent flow', async () => {
    const harness = routingHarness()

    const result = await harness.send({ skill: 'create-agent', text: '创建一个技能规划师' })

    expect(result.started).toBe(true)
    expect(injectCreateAgentSkill).toHaveBeenCalledTimes(1)
    expect(injectCreateAgentSkill).toHaveBeenCalledWith('创建一个技能规划师', 'create', undefined)
    expect(attachCreationTools).toHaveBeenCalledTimes(1)
    expect(injectCreateSkill).not.toHaveBeenCalled()
    expect(attachSkillCreationTools).not.toHaveBeenCalled()
  })

  test('an explicit create-skill body that reads like agent creation stays in the skill flow', async () => {
    const harness = routingHarness({ skillDraft: true })

    const result = await harness.send({ skill: 'create-skill', text: '创建一个智能体管理助手' })

    expect(result.started).toBe(true)
    expect(injectCreateSkill).toHaveBeenCalledTimes(1)
    expect(injectCreateSkill).toHaveBeenCalledWith('创建一个智能体管理助手', 'create')
    expect(attachSkillCreationTools).toHaveBeenCalledTimes(1)
    expect(injectCreateAgentSkill).not.toHaveBeenCalled()
    expect(attachCreationTools).not.toHaveBeenCalled()
    expect(
      harness.events.filter((event) => event.event === 'skill/notice' && event.text.includes('请先完成')),
    ).toHaveLength(0)
    expect(readFileSync(harness.skillDraftPath, 'utf8')).toBe(harness.originalSkillDraft)
  })

  test('a skill-entry body that reads like agent creation names the agent draft when mutually exclusive', async () => {
    const harness = routingHarness({ agentDraft: true })

    const result = await harness.send({ skill: 'create-skill', text: '创建一个智能体管理助手' })

    expect(result.started).toBe(false)
    expect(lastEventText(harness.events)).toContain('请先完成或取消当前的智能体创建')
    expect(lastEventText(harness.events)).toContain('weekly-report')
    expect(harness.events.at(-1)).toMatchObject({ event: 'skill/notice' })
    expect(injectCreateSkill).not.toHaveBeenCalled()
    expect(injectCreateAgentSkill).not.toHaveBeenCalled()
    expect(readFileSync(harness.agentDraftPath, 'utf8')).toBe(harness.originalAgentDraft)
  })

  test('a corrupt agent draft does not block an explicit skill invocation while a skill draft exists', async () => {
    const harness = routingHarness({ skillDraft: true })
    mkdirSync(join(harness.root, 'agents', '.drafts'), { recursive: true })
    writeFileSync(harness.agentDraftPath, '{corrupt', 'utf8')
    enableUserSkill(harness.root, 'weekly-report')

    const result = await harness.send({ skill: 'weekly-report', text: '照常调用' })

    expect(result).toMatchObject({ started: true })
    expect(eventTexts(harness.events).some((text) => text.includes('损坏'))).toBe(false)
    expect(injectCreateSkill).not.toHaveBeenCalled()
  })

  test('a corrupt agent draft does not block an @agent turn while a skill draft exists', async () => {
    const harness = routingHarness({ skillDraft: true })
    mkdirSync(join(harness.root, 'agents', '.drafts'), { recursive: true })
    writeFileSync(harness.agentDraftPath, '{corrupt', 'utf8')

    const result = await harness.send({ at: { name: 'legacy-agent' }, text: '照常调用' })

    expect(result).toMatchObject({ started: true })
    expect(dispatchAt).toHaveBeenCalledTimes(1)
    expect(eventTexts(harness.events).some((text) => text.includes('损坏'))).toBe(false)
    expect(injectCreateSkill).not.toHaveBeenCalled()
  })

  test('a corrupt agent draft still blocks a plain continue turn while a skill draft exists', async () => {
    const harness = routingHarness({ skillDraft: true })
    mkdirSync(join(harness.root, 'agents', '.drafts'), { recursive: true })
    writeFileSync(harness.agentDraftPath, '{corrupt', 'utf8')

    const result = await harness.send({ text: '继续修改' })

    expect(result.started).toBe(false)
    expect(lastEventText(harness.events)).toContain('损坏')
    expect(lastEventText(harness.events)).toContain('/create-agent cancel')
    expect(injectCreateSkill).not.toHaveBeenCalled()
  })

  test('a corrupt skill draft rejection names /create-skill cancel', async () => {
    const harness = routingHarness()
    mkdirSync(join(harness.root, 'skill-creation-drafts'), { recursive: true })
    writeFileSync(harness.skillDraftPath, '{corrupt', 'utf8')

    const result = await harness.send({ text: '/create-agent' })

    expect(result.started).toBe(false)
    expect(lastEventText(harness.events)).toContain('损坏')
    expect(lastEventText(harness.events)).toContain('/create-skill cancel')
    expect(injectCreateAgentSkill).not.toHaveBeenCalled()
    expect(readFileSync(harness.skillDraftPath, 'utf8')).toBe('{corrupt')
  })

  test('a corrupt agent draft race in the mutual-exclusion prompt names /create-agent cancel', async () => {
    const harness = routingHarness({ agentDraft: true })
    // hasDraft 与 describeDraft 两次读取之间草稿被损坏的竞态:宽松读已在场,严格读抛错。
    vi.spyOn(harness.packageHost, 'describeDraft').mockImplementation(() => {
      throw new CorruptAgentPackageDraftError('智能体创建草稿损坏(内部):/race.json')
    })

    const result = await harness.send({ text: '/create-skill' })

    expect(result.started).toBe(false)
    expect(lastEventText(harness.events)).toContain('损坏')
    expect(lastEventText(harness.events)).toContain('/create-agent cancel')
    expect(injectCreateSkill).not.toHaveBeenCalled()
    expect(readFileSync(harness.agentDraftPath, 'utf8')).toBe(harness.originalAgentDraft)
  })

  test('raw /create-skill body is injected without the slash prefix', async () => {
    const harness = routingHarness()

    const result = await harness.send({ text: '/create-skill 帮我做周报' })

    expect(result.started).toBe(true)
    expect(injectCreateSkill).toHaveBeenCalledTimes(1)
    expect(injectCreateSkill).toHaveBeenCalledWith('帮我做周报', 'create')
  })

  test('routes single-draft bare cancel to the skill flow and names it', async () => {
    const harness = routingHarness({ skillDraft: true })

    const result = await harness.send({ text: '取消' })

    expect(result.started).toBe(false)
    expect(existsSync(harness.skillDraftPath)).toBe(false)
    expect(lastEventText(harness.events)).toContain('已取消创建技能')
    expect(harness.events.at(-1)).toMatchObject({ event: 'skill/notice', terminal: 'cancelled' })
    expect(harness.packageHost.cancel).not.toHaveBeenCalled()
  })

  // 取消是删除磁盘草稿的真操作,低层把 rmSync 失败吞成 false。假值必须如实报失败:
  // 不报「已取消」、不卸工具、草稿仍在——否则损坏草稿的唯一逃生口会报「已取消」却
  // 让互斥守卫继续挡住每一轮,用户陷入重试循环。
  const failedSkillCancel = '已取消创建技能失败，草稿仍保留，请重试。'
  const failedAgentCancel = '已取消创建智能体失败，草稿仍保留，请重试。'

  test('reports a failed explicit skill cancel without claiming the draft is gone', async () => {
    const harness = routingHarness({ skillDraft: true })
    const cancel = vi.fn(async () => false)
    harness.skillHost.cancel = cancel

    const result = await harness.send({ text: '/create-skill cancel' })

    expect(result).toEqual({
      queued: true,
      sessionId: ROUTING_SESSION_ID,
      started: false,
      reason: failedSkillCancel,
    })
    expect(cancel).toHaveBeenCalledWith(ROUTING_SESSION_ID, { explicit: true })
    expect(harness.events).toContainEqual({
      event: 'skill/notice',
      text: failedSkillCancel,
      sessionId: ROUTING_SESSION_ID,
    })
    expect(eventTexts(harness.events).some((text) => text.includes('没有写入技能'))).toBe(false)
    expect(detachSkillCreationTools).not.toHaveBeenCalled()
    expect(readFileSync(harness.skillDraftPath, 'utf8')).toBe(harness.originalSkillDraft)
  })

  test('reports a failed explicit agent cancel without claiming the draft is gone', async () => {
    const harness = routingHarness({ agentDraft: true })
    const cancel = vi.fn(async () => false)
    harness.packageHost.cancel = cancel

    const result = await harness.send({ text: '/create-agent cancel' })

    expect(result).toEqual({
      queued: true,
      sessionId: ROUTING_SESSION_ID,
      started: false,
      reason: failedAgentCancel,
    })
    expect(cancel).toHaveBeenCalledWith(ROUTING_SESSION_ID, { explicit: true })
    expect(harness.events).toContainEqual({
      event: 'agent/notice',
      text: failedAgentCancel,
      sessionId: ROUTING_SESSION_ID,
    })
    expect(eventTexts(harness.events).some((text) => text.includes('没有写入智能体'))).toBe(false)
    expect(detachCreationTools).not.toHaveBeenCalled()
    expect(readFileSync(harness.agentDraftPath, 'utf8')).toBe(harness.originalAgentDraft)
  })

  test('reports a failed bare skill cancel without claiming the draft is gone', async () => {
    const harness = routingHarness({ skillDraft: true })
    const cancel = vi.fn(async () => false)
    harness.skillHost.cancel = cancel

    const result = await harness.send({ text: '取消' })

    expect(result).toEqual({
      queued: true,
      sessionId: ROUTING_SESSION_ID,
      started: false,
      reason: failedSkillCancel,
    })
    expect(cancel).toHaveBeenCalledWith(ROUTING_SESSION_ID)
    expect(harness.events).toContainEqual({
      event: 'skill/notice',
      text: failedSkillCancel,
      sessionId: ROUTING_SESSION_ID,
    })
    expect(eventTexts(harness.events).some((text) => text.includes('没有写入技能'))).toBe(false)
    expect(detachSkillCreationTools).not.toHaveBeenCalled()
    expect(readFileSync(harness.skillDraftPath, 'utf8')).toBe(harness.originalSkillDraft)
  })
})
