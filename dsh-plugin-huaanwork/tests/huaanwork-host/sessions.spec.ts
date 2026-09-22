import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { freshSessionIdFor, sessionIdFor } from '../../src/huaanwork-host/session-id.ts'
import {
  sessionAnswerApproval,
  sessionCancel,
  sessionList,
  sessionNew,
  sessionOpen,
  sessionRemove,
  sessionResume,
  sessionSend,
  type ListedAgent,
  type SessionRuntimeContext,
} from '../../src/huaanwork-host/sessions.ts'
import type { RouteContext } from '../../src/huaanwork-host/routes.ts'
import { readHuaanworkSettings, writeHuaanworkSettings } from '../../src/huaanwork-host/settings.ts'

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
    const freshA = sessionNew(routeCtx, { fresh: true })
    const freshB = sessionNew(routeCtx, { fresh: true })
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
    const primary: ListedAgent = { id: 'huaanwork', cancel: (reason) => cancelled.push(reason) }
    const child: ListedAgent = { id: 'child-1', cancel: (reason) => cancelled.push(reason) }
    const ctx: SessionRuntimeContext = { agents: { get: (id) => (id === 'huaanwork' ? primary : undefined), list: () => [primary, child] } }
    const result = sessionCancel(ctx, routeCtx, {}) as { accepted: boolean }
    expect(result).toEqual({ accepted: true })
    expect(cancelled).toEqual([{ kind: 'parent' }, { kind: 'user' }])
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

    await expect(sessionRemove(routeCtx, { sessionId })).resolves.toEqual({ removed: true })
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

describe('settings 读取一致性', () => {
  test('readHuaanworkSettings defaults keep the send gate open (loopback base_url)', async () => {
    const root = freshTmp()
    const settings = await readHuaanworkSettings(root)
    expect(settings.allow_network).toBe(false)
    expect(settings.base_url).toBe('http://127.0.0.1:11434/v1')
  })
})
