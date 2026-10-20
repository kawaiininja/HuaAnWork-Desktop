import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { childrenOf, registerChildSession } from '../../src/huaanwork-host/child-sessions.ts'
import { freshSessionIdFor, sessionIdFor } from '../../src/huaanwork-host/session-id.ts'
import { emptyAttachments } from '../../src/huaanwork-guardrails/agent-attachments.ts'
import {
  answerRouteInput,
  apply as applyRouteTools,
  noteInvalidRoute,
  releaseRouteInput,
} from '../../src/huaanwork-guardrails/route-tool-plugin.ts'
import {
  sendToAgent,
  sessionAnswerApproval,
  sessionAnswerInput,
  sessionCancel,
  sessionExitPlanMode,
  sessionList,
  sessionNew,
  sessionOpen,
  sessionRemove,
  sessionResume,
  sessionSend,
  setAgentsDirectory,
  type ListedAgent,
  type SessionRuntimeContext,
} from '../../src/huaanwork-host/sessions.ts'
import type { RouteContext } from '../../src/huaanwork-host/routes.ts'
import { emptySettings, readHuaanworkSettings, writeHuaanworkSettings } from '../../src/huaanwork-host/settings.ts'
import { assertStreamNetworkAllowed } from '../../src/huaanwork-host/net-gate.ts'
import { sweepProjectLegacySessions } from '../../src/huaanwork-host/session-sweep.ts'

// —— 用例移植自旧 sidecar session-history.test.ts(L61-69 / L115-153 / L220-241)
// 与 host.ts 会话 case 语义;存储 fixture 钉死读路径 <dshHome>/sessions ——

function makeRouteCtx(root: string, opts?: { workspace?: string }): RouteContext {
  return {
    dshHome: join(root, 'dsh'),
    profileDir: root,
    workspaceRoot: { current: opts?.workspace ?? join(root, 'workspace') },
    emit: () => undefined,
    logger: () => undefined,
    requestRestart: async () => true,
  }
}

function sessionLog(entries: Record<string, unknown>[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

/** 造一条带 cwd 的持久化会话日志到 <dshHome>/sessions/<dir>/<id>/session.jsonl。 */
function writePersistedSession(dshHome: string, id: string, cwd: string): void {
  const dir = join(dshHome, 'sessions', 'repo', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'session.jsonl'),
    sessionLog([
      { type: 'session', version: 0, id, createdAt: 1_000, cwd, delegationDepth: 0 },
      { type: 'user/message', seq: 1, time: 1_100, data: { role: 'user', content: [{ type: 'text', text: '旧任务' }], source: { kind: 'user' } } },
    ]),
    'utf8',
  )
}

/** fake ctx.agents:按 id 取 agent;create/resume 把 agent 注册进表(模拟注册表发布)。 */
function fakeAgentsRegistry() {
  const agents = new Map<string, ListedAgent & { followup: (message: unknown) => void }>()
  const calls: { method: 'create' | 'resume'; options: unknown }[] = []
  const ctx: SessionRuntimeContext = {
    agents: {
      get: (id) => agents.get(id),
      list: () => [...agents.values()],
      create: async (options) => {
        calls.push({ method: 'create', options })
        const sessionId = (options as { sessionId: string }).sessionId
        agents.set(sessionId, {
          id: sessionId,
          session: { id: sessionId },
          followup: () => undefined,
          whenIdle: async () => undefined,
          cancel: () => undefined,
        })
        return {}
      },
      resume: async (options) => {
        calls.push({ method: 'resume', options })
        const sessionId = (options as { resumeSessionId: string }).resumeSessionId
        agents.set(sessionId, {
          id: sessionId,
          session: { id: sessionId },
          followup: () => undefined,
          whenIdle: async () => undefined,
          cancel: () => undefined,
        })
        return {}
      },
    },
  }
  return { ctx, agents, calls }
}

let tmpRoot: string | undefined

function freshTmp(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'huaanwork-sessions-spec-'))
  return tmpRoot
}

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true })
    tmpRoot = undefined
  }
})

describe('sessionIdFor / freshSessionIdFor (旧 session-history.test.ts:L61-69)', () => {
  test('freshSessionIdFor keeps the stable prefix and adds a unique suffix', () => {
    const root = join(tmpdir(), 'huaanwork-fresh-id')
    const stable = sessionIdFor(root)
    expect(stable).toMatch(/^huaanwork-[0-9a-f]{16}$/)
    const fresh = freshSessionIdFor(root)
    expect(fresh.startsWith(stable)).toBe(true)
    expect(fresh).toMatch(/^huaanwork-[0-9a-f]{16}-[0-9a-f]{8}$/)
    expect(fresh).not.toBe(freshSessionIdFor(root))
  })

  test('sessionIdFor is stable across relative/absolute spellings of the same root', () => {
    expect(sessionIdFor('/tmp/demo')).toBe(sessionIdFor('/tmp/./demo'))
  })
})

describe('session.new (旧 host.ts:988-992)', () => {
  test('mints stable vs fresh ids', () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const stable = sessionNew(routeCtx, {})
    expect(stable.sessionId).toBe(sessionIdFor(routeCtx.workspaceRoot.current))
    expect(stable.cwd).toBe(routeCtx.workspaceRoot.current)
    const freshA = sessionNew(routeCtx, { fresh: true })
    const freshB = sessionNew(routeCtx, { fresh: true })
    expect(freshA.cwd).toBe(routeCtx.workspaceRoot.current)
    expect(freshA.sessionId).not.toBe(freshB.sessionId)
    expect(freshA.sessionId).toMatch(/^huaanwork-[0-9a-f]{16}-[0-9a-f]{8}$/)
  })
})

describe('session.send 网络门禁 (旧 session-history.test.ts:L115-153)', () => {
  test('is gated to LAN model endpoints unless allow_network is on', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const remote = {
      models: [{ id: 'r', name: 'remote', base_url: 'https://api.example.com/v1', model: 'm', api_key: '' }],
      active_model_id: 'r',
    }
    await writeHuaanworkSettings(routeCtx.profileDir, remote)
    await expect(sessionSend({}, routeCtx, { text: 'do work' })).rejects.toThrow(/公网/)

    await writeHuaanworkSettings(routeCtx.profileDir, { ...remote, allow_network: true })
    const { ctx, agents } = fakeAgentsRegistry()
    agents.set('huaanwork', {
      id: 'huaanwork',
      session: { id: sessionIdFor(routeCtx.workspaceRoot.current) },
      followup: () => undefined,
      whenIdle: async () => undefined,
      cancel: () => undefined,
    })
    const sent = (await sessionSend(ctx, routeCtx, { text: 'do work' })) as { queued: boolean; sessionId: string }
    expect(sent.queued).toBe(true)

    await writeHuaanworkSettings(routeCtx.profileDir, {
      models: [{ id: 'l', name: 'local', base_url: 'http://127.0.0.1:11434/v1', model: 'm', api_key: '' }],
      active_model_id: 'l',
    })
    const local = (await sessionSend(ctx, routeCtx, { text: 'again' })) as { queued: boolean }
    expect(local.queued).toBe(true)
  })

  test('requires params.text when no at/skill', async () => {
    const root = freshTmp()
    await expect(sessionSend({}, makeRouteCtx(root), {})).rejects.toThrow(/requires params.text/)
  })

  test('followups the channel agent and waits idle', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const received: unknown[] = []
    const channelAgent: ListedAgent = {
      id: 'huaanwork',
      followup: (message) => received.push(message),
      whenIdle: async () => undefined,
    }
    const ctx: SessionRuntimeContext = { agents: { get: (id) => (id === 'huaanwork' ? channelAgent : undefined), list: () => [channelAgent] } }
    const sent = (await sessionSend(ctx, routeCtx, { text: '你好' })) as { queued: boolean; sessionId: string }
    expect(sent.queued).toBe(true)
    expect(sent.sessionId).toBe(sessionIdFor(routeCtx.workspaceRoot.current))
    expect(received).toHaveLength(1)
    const message = received[0] as { role: string; content: { type: string; text: string }[]; source: { kind: string } }
    expect(message.role).toBe('user')
    expect(message.content[0]).toEqual({ type: 'text', text: '你好' })
    expect(message.source).toEqual({ kind: 'user' })
  })

  test('sendToAgent returns after followup and detaches @ tools only after idle', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const sessionId = 'huaanwork-0123456789abcdef'
    const maps = emptyAttachments()
    let releaseIdle: () => void = () => {}
    const idle = new Promise<void>((resolve) => {
      releaseIdle = resolve
    })
    const agent: ListedAgent = {
      id: sessionId,
      session: { id: sessionId },
      followup: () => undefined,
      whenIdle: () => idle,
    }
    const ctx = {
      huaanworkAttachments: maps,
      agents: {
        get: (id: string) => (id === sessionId ? agent : undefined),
        list: () => [agent],
      },
    }
    const emptyDirectory = {
      list: () => ({ items: [] }),
      refresh: async () => ({ items: [] }),
      get: async () => undefined,
      setEnabled: () => undefined,
      addEndpoint: () => ({ ok: false as const, fieldErrors: [] }),
      removeEndpoint: () => undefined,
      snapshotForRuntime: () => ({ items: [] }),
    }
    setAgentsDirectory({
      ...emptyDirectory,
      list: () => ({
        items: [
          {
            name: 'tool',
            source: 'local',
            kind: 'tool',
            entrypointKind: 'http',
            description: '查询',
            version: '1',
            permissions: [],
            enabled: true,
          },
        ],
      }),
    })
    try {
      const pending = sendToAgent(ctx, routeCtx, { text: '@tool 查询', sessionId })
      const result = await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(() => resolve('timed-out'), 50)),
      ])
      expect(result).toEqual({ queued: true, sessionId })
      const detached = () => maps.sessionHostTools.get(sessionId)?.has('tool') !== true
      expect(detached()).toBe(false)
      releaseIdle()
      await idle.then(() => new Promise((resolve) => setTimeout(resolve, 0)))
      expect(detached()).toBe(true)
    } finally {
      releaseIdle()
      setAgentsDirectory(emptyDirectory)
    }
  })

  test('@agent with an unconfigured directory throws the empty-catalog error', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    await expect(sessionSend({}, routeCtx, { text: '@reviewer 看看代码' })).rejects.toThrow(/未启用或不存在/)
  })

  test('skill dispatch wraps the prompt with skill instructions', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    mkdirSync(join(routeCtx.profileDir, 'skills', 'demo'), { recursive: true })
    writeFileSync(
      join(routeCtx.profileDir, 'skills', 'demo', 'SKILL.md'),
      ['---', 'name: demo', 'description: 演示技能', '---', '', '按演示技能说明执行。'].join('\n'),
      'utf8',
    )
    const received: unknown[] = []
    const channelAgent: ListedAgent = {
      id: 'huaanwork',
      followup: (message) => received.push(message),
      whenIdle: async () => undefined,
    }
    const ctx: SessionRuntimeContext = { agents: { get: (id) => (id === 'huaanwork' ? channelAgent : undefined), list: () => [channelAgent] } }
    await sessionSend(ctx, routeCtx, { text: '跑一下', skill: 'demo' })
    const message = received[0] as { content: { text: string }[] }
    expect(message.content[0]!.text).toContain('# 已启用技能：demo')
    expect(message.content[0]!.text).toContain('用户请求：')
    expect(message.content[0]!.text).toContain('跑一下')
  })

  test('explicit sessionId without persisted log creates a fresh agent (ensureChannelAgent create 路径)', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const { ctx, calls } = fakeAgentsRegistry()
    const sessionId = freshSessionIdFor(routeCtx.workspaceRoot.current)
    const sent = (await sessionSend(ctx, routeCtx, { text: '你好', sessionId })) as { queued: boolean; sessionId: string }
    expect(sent.sessionId).toBe(sessionId)
    expect(calls).toEqual([
      { method: 'create', options: { sessionId, meta: { cwd: routeCtx.workspaceRoot.current }, agentOptions: { provider: 'deepseek-official', model: 'local' } } },
    ])
  })
})

describe('session.resume (旧 host.ts:994-1002 / session-history.test.ts:L155-241)', () => {
  test('resumes a persisted session via agents.resume and rejects unknown ids', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const workspace = routeCtx.workspaceRoot.current
    const sessionId = sessionIdFor(workspace)
    writePersistedSession(routeCtx.dshHome, sessionId, workspace)
    const { ctx, calls } = fakeAgentsRegistry()
    const resumed = await sessionResume(ctx, routeCtx, { sessionId })
    expect(resumed).toEqual({ sessionId, resumed: true })
    expect(calls).toEqual([
      { method: 'resume', options: { resumeSessionId: sessionId, agentOptions: { provider: 'deepseek-official', model: 'local' } } },
    ])
    await expect(sessionResume(ctx, routeCtx, { sessionId: 'huaanwork-nonexistent' })).rejects.toThrow(/was not found/)
  })

  test('rejects sessions owned by another workspace (跨工作区 cwd 守卫,AGENTS.md 不变式 6)', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const otherWorkspace = join(root, 'repo-b')
    writePersistedSession(routeCtx.dshHome, 'huaanwork-other', otherWorkspace)
    const { ctx, calls } = fakeAgentsRegistry()
    await expect(sessionResume(ctx, routeCtx, { sessionId: 'huaanwork-other' })).rejects.toThrow(/工作区/)
    expect(calls).toEqual([])
  })

  test('reuses a live agent without create/resume', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const workspace = routeCtx.workspaceRoot.current
    const sessionId = sessionIdFor(workspace)
    writePersistedSession(routeCtx.dshHome, sessionId, workspace)
    const live: ListedAgent & { followup: (message: unknown) => void } = {
      id: sessionId,
      session: { id: sessionId },
      followup: () => undefined,
    }
    const ctx: SessionRuntimeContext = { agents: { get: (id) => (id === sessionId ? live : undefined), list: () => [live] } }
    const resumed = await sessionResume(ctx, routeCtx, { sessionId })
    expect(resumed.resumed).toBe(true)
  })
})

describe('session.cancel (旧 host.ts:1560)', () => {
  test('cancels the primary agent as user and the rest as parent', () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const cancelled: { kind: string }[] = []
    const primary: ListedAgent = {
      id: 'huaanwork',
      session: { id: sessionIdFor(routeCtx.workspaceRoot.current) },
      cancel: (reason) => cancelled.push(reason),
    }
    const child: ListedAgent = { id: 'child-1', cancel: (reason) => cancelled.push(reason) }
    const ctx: SessionRuntimeContext = { agents: { get: (id) => (id === 'huaanwork' ? primary : undefined), list: () => [primary, child] } }
    registerChildSession(sessionIdFor(routeCtx.workspaceRoot.current), 'child-1')
    const result = sessionCancel(ctx, routeCtx, {}) as { accepted: boolean }
    expect(result).toEqual({ accepted: true })
    expect(cancelled).toEqual([{ kind: 'parent' }, { kind: 'user' }])
  })

  test('cancelAgent does not cancel a sibling session', () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const reasons: string[] = []
    const target: ListedAgent = {
      session: { id: 'huaanwork-aaaaaaaaaaaaaaaa' },
      cancel(reason) {
        reasons.push(`target:${reason.kind}`)
      },
    }
    const child: ListedAgent = {
      session: { id: 'child' },
      cancel(reason) {
        reasons.push(`child:${reason.kind}`)
      },
    }
    const sibling: ListedAgent = {
      session: { id: 'huaanwork-bbbbbbbbbbbbbbbb' },
      cancel() {
        reasons.push('sibling')
      },
    }
    registerChildSession('huaanwork-aaaaaaaaaaaaaaaa', 'child')
    const ctx: SessionRuntimeContext = { agents: { list: () => [target, child, sibling] } }
    sessionCancel(ctx, routeCtx, { sessionId: 'huaanwork-aaaaaaaaaaaaaaaa' })
    expect(reasons.sort()).toEqual(['child:parent', 'target:user'])
  })

  test('cancelAgent does not cancel a channel agent that is running a sibling session', () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const reasons: string[] = []
    const channel: ListedAgent = {
      id: 'huaanwork',
      session: { id: 'huaanwork-bbbbbbbbbbbbbbbb' },
      cancel(reason) {
        reasons.push(`channel:${reason.kind}`)
      },
    }
    const child: ListedAgent = {
      session: { id: 'huaanwork-child' },
      cancel(reason) {
        reasons.push(`child:${reason.kind}`)
      },
    }
    registerChildSession('huaanwork-aaaaaaaaaaaaaaaa', 'huaanwork-child')
    const ctx: SessionRuntimeContext = {
      agents: { get: (id) => (id === 'huaanwork' ? channel : undefined), list: () => [channel, child] },
    }
    sessionCancel(ctx, routeCtx, { sessionId: 'huaanwork-aaaaaaaaaaaaaaaa' })
    expect(reasons).toEqual(['child:parent'])
  })
})

describe('session.answerInput', () => {
  type Exec = { agent?: unknown; signal?: AbortSignal }
  type Registered = { name: string; execute: (args: unknown, exec?: Exec) => Promise<unknown> }

  function askInput(agent: ListedAgent): Promise<unknown> {
    const tools = new Map<string, Registered>()
    applyRouteTools({
      huaanworkEmit: () => undefined,
      planMode: { set: () => undefined },
      tools: { register: (definition: Registered) => { tools.set(definition.name, definition) } },
    })
    return tools.get('request_input')!.execute({ question: '发给谁？' }, { agent })
  }

  test('the card answer becomes the request_input result', async () => {
    const agent: ListedAgent = { id: 'huaanwork-1111111111111111', cancel: () => undefined }
    const waiting = askInput(agent)
    expect(sessionAnswerInput({ sessionId: agent.id, answer: '张三' })).toEqual({ handled: true })
    await expect(waiting).resolves.toEqual({ text: '张三' })
    expect(sessionAnswerInput({ sessionId: agent.id, answer: '张三' })).toEqual({ handled: false })
  })

  test('cancelling the card ends the call and stops the turn', async () => {
    const reasons: string[] = []
    const agent: ListedAgent = { id: 'huaanwork-2222222222222222', cancel: (reason) => { reasons.push(reason.kind) } }
    const waiting = askInput(agent)
    expect(sessionAnswerInput({ sessionId: agent.id, cancel: true })).toEqual({ handled: true })
    await expect(waiting).rejects.toThrow(/用户取消了这个问题/)
    expect(reasons).toEqual(['parent'])
  })

  test('a blank answer or a missing session id is not handled', () => {
    expect(sessionAnswerInput({ sessionId: 'huaanwork-3333333333333333', answer: '  ' })).toEqual({ handled: false })
    expect(sessionAnswerInput({ answer: '张三' })).toEqual({ handled: false })
  })

  test('session.cancel releases a waiting request_input', async () => {
    const agent: ListedAgent = { id: 'huaanwork-4444444444444444', cancel: () => undefined }
    const waiting = askInput(agent)
    const ctx: SessionRuntimeContext = { agents: { get: (id) => (id === agent.id ? agent : undefined), list: () => [agent] } }
    sessionCancel(ctx, makeRouteCtx(freshTmp()), { sessionId: agent.id })
    await expect(waiting).rejects.toThrow(/回合已停止/)
  })
})

describe('session.open / session.remove (旧 host.ts:1381/1395)', () => {
  test('open returns header, raw log, records, and summary; remove deletes the log', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const sessionId = 'huaanwork-abc123'
    writePersistedSession(routeCtx.dshHome, sessionId, routeCtx.workspaceRoot.current)

    const opened = (await sessionOpen(routeCtx, { sessionId })) as {
      header?: { id?: string }
      log?: string
      records?: { kind: string }[]
      summary?: { title?: string }
    }
    expect(opened.header?.id).toBe(sessionId)
    expect(opened.log?.includes('旧任务')).toBe(true)
    expect(opened.records).toHaveLength(1)
    expect(opened.summary?.title).toBe('旧任务')

    await expect(sessionOpen(routeCtx, { sessionId: 'missing' })).rejects.toThrow(/was not found/)
    await expect(sessionOpen(routeCtx, {})).rejects.toThrow(/requires params.sessionId/)

    await expect(sessionRemove({}, routeCtx, { sessionId })).resolves.toEqual({ removed: true })
    await expect(sessionOpen(routeCtx, { sessionId })).rejects.toThrow(/was not found/)
  })
})

describe('session.remove lifecycle', () => {
  test('releases a waiting request_input, cancels the live agent, and forgets the session', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const sessionId = 'huaanwork-5555555555555555'
    writePersistedSession(routeCtx.dshHome, sessionId, routeCtx.workspaceRoot.current)

    const reasons: string[] = []
    const agent: ListedAgent = {
      id: sessionId,
      session: { id: sessionId },
      status: 'running',
      cancel: (reason) => { reasons.push(reason.kind) },
    }
    // 通道 agent 绑在兄弟会话上:删这个会话不能顺手把它停掉。
    const channel: ListedAgent = {
      id: 'huaanwork',
      session: { id: 'huaanwork-6666666666666666' },
      status: 'running',
      cancel: (reason) => { reasons.push(`channel:${reason.kind}`) },
    }
    registerChildSession(sessionId, 'child-of-removed')
    registerChildSession('parent-of-removed', sessionId)
    expect(noteInvalidRoute(sessionId).endTurn).toBe(false)
    expect(noteInvalidRoute(sessionId).endTurn).toBe(true)

    type Exec = { agent?: unknown; signal?: AbortSignal }
    type Registered = { name: string; execute: (args: unknown, exec?: Exec) => Promise<unknown> }
    const tools = new Map<string, Registered>()
    applyRouteTools({
      huaanworkEmit: () => undefined,
      planMode: { set: () => undefined },
      tools: { register: (definition: Registered) => { tools.set(definition.name, definition) } },
    })
    const waiting = tools.get('request_input')!.execute({ question: '发给谁？' }, { agent })
    const settlement = expect(waiting).rejects.toThrow(/回合已停止/)
    await Promise.resolve()

    const ctx: SessionRuntimeContext = {
      agents: {
        get: (id) => (id === sessionId ? agent : id === 'huaanwork' ? channel : undefined),
        list: () => [agent, channel],
      },
    }
    await expect(sessionRemove(ctx, routeCtx, { sessionId })).resolves.toEqual({ removed: true })
    await settlement

    expect(answerRouteInput(sessionId, 'late')).toBe(false)
    expect(releaseRouteInput(sessionId)).toBe(false)
    expect(reasons).toEqual(['user'])
    expect(childrenOf(sessionId)).toEqual([])
    expect(childrenOf('parent-of-removed')).not.toContain(sessionId)
    expect(noteInvalidRoute(sessionId).endTurn).toBe(false)
    await expect(sessionOpen(routeCtx, { sessionId })).rejects.toThrow(/was not found/)
  })
})

describe('session.list 过滤口径', () => {
  test('excludes subagent logs and filters by root', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    writePersistedSession(routeCtx.dshHome, 'huaanwork-top', routeCtx.workspaceRoot.current)
    const subDir = join(routeCtx.dshHome, 'sessions', 'repo', 'child-1')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(
      join(subDir, 'session.jsonl'),
      sessionLog([
        { type: 'session', version: 0, id: 'child-1', createdAt: 2_000, cwd: routeCtx.workspaceRoot.current, origin: 'subagent', parentSession: 'huaanwork-top', delegationDepth: 1 },
      ]),
      'utf8',
    )
    const listed = await sessionList(routeCtx, undefined)
    expect(listed.map((s) => s.id)).toEqual(['huaanwork-top'])
    const filtered = await sessionList(routeCtx, join(root, 'elsewhere'))
    expect(filtered).toEqual([])
  })
})

describe('session.approve / session.reject (旧 host.ts:1677 answerApproval)', () => {
  test('resolves only pending ids; unknown ids are logged no-ops', async () => {
    const root = freshTmp()
    let logged = ''
    const routeCtx: RouteContext = { ...makeRouteCtx(root), logger: (message) => { logged = message } }
    const approvals = new Map<string, (result: string) => void>()
    let resolved = ''
    approvals.set('req-1', (result) => { resolved = result })
    const ctx: SessionRuntimeContext = { huaanworkApprovals: approvals as never }

    await expect(sessionAnswerApproval(ctx, routeCtx, { approvalRequestId: 'req-1' }, 'allowed-once'))
      .resolves.toEqual({ handled: true })
    expect(resolved).toBe('allowed-once')
    expect(approvals.has('req-1')).toBe(false)

    await expect(sessionAnswerApproval(ctx, routeCtx, { approvalRequestId: 'req-1' }, 'rejected'))
      .resolves.toEqual({ handled: false })
    expect(logged).toContain('Ignoring unknown sidecar approval request')

    await expect(sessionAnswerApproval(ctx, routeCtx, {}, 'rejected'))
      .resolves.toEqual({ handled: false })
  })
})

describe('session.exitPlanMode', () => {
  function planCtx(agent: ListedAgent, calls: string[]) {
    const reviews = new Map<string, () => boolean>()
    const ctx: SessionRuntimeContext = {
      huaanworkPlanReviews: reviews,
      agents: { get: (id) => (id === 's1' ? agent : undefined) },
      get: (name) => (name === 'planMode'
        ? { set: (target: unknown, active: boolean) => { calls.push(`set:${String(active)}:${target === agent}`) } }
        : undefined),
    }
    return { ctx, reviews }
  }

  test('settles the pending plan review before leaving plan mode', () => {
    const calls: string[] = []
    const agent: ListedAgent = { id: 's1', status: 'running', cancel: () => { calls.push('cancel') } }
    const { ctx, reviews } = planCtx(agent, calls)
    reviews.set('s1', () => { calls.push('settle'); return true })
    expect(sessionExitPlanMode(ctx, makeRouteCtx(freshTmp()), { sessionId: 's1' })).toEqual({ exited: true })
    expect(calls).toEqual(['settle', 'set:false:true'])
    expect(reviews.has('s1')).toBe(false)
  })

  test('without a review on screen it still leaves plan mode and stops the running turn', () => {
    const calls: string[] = []
    const agent: ListedAgent = { id: 's1', status: 'running', cancel: () => { calls.push('cancel') } }
    const { ctx } = planCtx(agent, calls)
    expect(sessionExitPlanMode(ctx, makeRouteCtx(freshTmp()), { sessionId: 's1' })).toEqual({ exited: true })
    expect(calls).toEqual(['set:false:true', 'cancel'])
  })

  test('a missing agent or planMode does not settle the pending review', () => {
    const agent: ListedAgent = { id: 's1', status: 'running', cancel: () => undefined }
    const routeCtx = makeRouteCtx(freshTmp())

    const missingAgentCalls: string[] = []
    const missingAgent = planCtx(agent, missingAgentCalls)
    missingAgent.ctx.agents = { get: () => undefined }
    missingAgent.reviews.set('s1', () => { missingAgentCalls.push('settle'); return true })
    expect(sessionExitPlanMode(missingAgent.ctx, routeCtx, { sessionId: 's1' })).toEqual({ exited: false })
    expect(missingAgentCalls).toEqual([])
    expect(missingAgent.reviews.has('s1')).toBe(true)

    const missingPlanCalls: string[] = []
    const missingPlan = planCtx(agent, missingPlanCalls)
    missingPlan.ctx.get = () => undefined
    missingPlan.reviews.set('s1', () => { missingPlanCalls.push('settle'); return true })
    expect(sessionExitPlanMode(missingPlan.ctx, routeCtx, { sessionId: 's1' })).toEqual({ exited: false })
    expect(missingPlanCalls).toEqual([])
    expect(missingPlan.reviews.has('s1')).toBe(true)
  })

  test('does not exit plan mode or cancel a channel agent running a sibling session', () => {
    const calls: string[] = []
    const channel: ListedAgent = {
      id: 'huaanwork',
      session: { id: 'huaanwork-bbbbbbbbbbbbbbbb' },
      status: 'running',
      cancel: () => { calls.push('channel-cancel') },
    }
    const ctx: SessionRuntimeContext = {
      agents: { get: (id) => (id === 'huaanwork' ? channel : undefined), list: () => [channel] },
      get: (name) => (name === 'planMode' ? { set: () => { calls.push('plan-mode-set') } } : undefined),
    }
    expect(sessionExitPlanMode(ctx, makeRouteCtx(freshTmp()), { sessionId: 'huaanwork-aaaaaaaaaaaaaaaa' }))
      .toEqual({ exited: false })
    expect(calls).toEqual([])
  })
})

describe('settings 读取一致性', () => {
  test('readHuaanworkSettings defaults keep the send gate open (loopback base_url)', async () => {
    const root = freshTmp()
    const settings = await readHuaanworkSettings(root)
    expect(settings.allow_network).toBe(false)
    expect(settings.base_url).toBe('http://127.0.0.1:11434/v1')
  })
})

describe('stream network gate (旧 automations-host.test.ts 模型流层)', () => {
  test('blocks public endpoints unless allow_network is on', () => {
    const remote = { ...emptySettings(), base_url: 'https://api.example.com/v1', allow_network: false }
    expect(() => assertStreamNetworkAllowed(remote)).toThrow(/公网/)
    expect(() => assertStreamNetworkAllowed({ ...remote, allow_network: true })).not.toThrow()
  })
})

describe('session-sweep dual prefix (旧 unified-channel.test.ts:463)', () => {
  test('project sweep keeps huaanwork-auto- and huaanwork-chat-auto- sessions', async () => {
    const root = freshTmp()
    const project = join(root, 'project')
    mkdirSync(project, { recursive: true })
    const sessionsRoot = join(root, 'dsh', 'sessions')
    const chatAuto = 'huaanwork-chat-auto-legacy-run1'
    const currentAuto = 'huaanwork-auto-legacy-run2'
    const ordinary = 'plain-user-session'
    const userChat = 'huaanwork-chat-feedfacecafebeef'
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    writePersistedSession(join(root, 'dsh'), chatAuto, project)
    writePersistedSession(join(root, 'dsh'), currentAuto, project)
    writePersistedSession(join(root, 'dsh'), ordinary, project)
    const userDir = join(sessionsRoot, 'user-bucket', userChat)
    mkdirSync(userDir, { recursive: true })
    writeFileSync(
      join(userDir, 'session.jsonl'),
      sessionLog([{ type: 'session', version: 0, id: userChat, createdAt: 1_000, cwd: elsewhere, delegationDepth: 0 }]),
    )

    const swept = await sweepProjectLegacySessions(sessionsRoot, [project], new Set())
    expect(swept.removed).toBe(1)
    expect(existsSync(join(sessionsRoot, 'repo', chatAuto))).toBe(true)
    expect(existsSync(join(sessionsRoot, 'repo', currentAuto))).toBe(true)
    expect(existsSync(join(sessionsRoot, 'repo', ordinary))).toBe(false)
    expect(existsSync(userDir)).toBe(true)
  })
})
