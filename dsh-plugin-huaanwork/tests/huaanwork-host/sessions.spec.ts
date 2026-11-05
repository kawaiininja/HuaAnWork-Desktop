import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  childrenOf,
  registerChildSession,
  resetChildSessionRegistry,
} from '../../src/huaanwork-host/child-sessions.ts'
import { freshSessionIdFor, sessionIdFor } from '../../src/huaanwork-host/session-id.ts'
import { emptyAttachments } from '../../src/huaanwork-guardrails/agent-attachments.ts'
import { apply as applySkills, setBundledSkillRegistrar } from '../../src/huaanwork-guardrails/skills.ts'
import {
  answerRouteInput,
  apply as applyRouteTools,
  noteInvalidRoute,
  releaseRouteInput,
  resetRouteToolState,
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
import { openWorkspace } from '../../src/huaanwork-host/workspace.ts'
import type { RouteContext } from '../../src/huaanwork-host/routes.ts'
import { ROUTE_TABLE } from '../../src/huaanwork-host/routes.ts'
import {
  apply as applyQuestionAnswerer,
  resetQuestionAnswererState,
} from '../../src/huaanwork-guardrails/question-answerer.ts'
import {
  emptySettings,
  readHuaanworkSettings,
  readHuaanworkSettingsSync,
  writeHuaanworkSettings,
} from '../../src/huaanwork-host/settings.ts'
import { assertStreamNetworkAllowed } from '../../src/huaanwork-host/net-gate.ts'
import { neutralWorkspaceRoot } from '../../src/huaanwork-host/workspace-state.ts'
import { sessionWorkspaceRoot } from '../../src/huaanwork-guardrails/sandbox-cwd.ts'
import { createTurnScheduler, type TurnScheduler } from '../../src/huaanwork-host/turn-scheduler.ts'
import type { RpcEvent } from '../../src/client-huaanwork/rpc-types.ts'
import { sweepProjectLegacySessions } from '../../src/huaanwork-host/session-sweep.ts'
import { ACTIVATION_CLEANUP_TIMEOUT_MS } from '../../src/huaanwork-host/agent-package/host.ts'
import { dispatchAt } from '../../src/huaanwork-host/agent-invoke.ts'
import type { AgentsHost } from '../../src/huaanwork-host/agents-host.ts'
import {
  HUAANWORK_SUBAGENT_RUN_ID,
  type SubagentActivationHandle,
} from '../../src/huaanwork-host/subagents-service.ts'
import {
  createSubagentRunRegistry,
  type SubagentRunRegistry,
} from '../../src/huaanwork-host/subagent-runs.ts'

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

function makeDeferred<T = void>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** 手动 idle:每次 `whenIdle()` 登记一个回调,可对同一次登记触发多次以模拟迟到的重复通知。 */
function manualIdle() {
  const pending: (() => void)[] = []
  return {
    whenIdle: () =>
      (({
        then(onFulfilled: () => void) {
          pending.push(onFulfilled)
          return Promise.resolve()
        },
      }) as unknown) as Promise<void>,
    fire(index: number, times = 1): void {
      for (let i = 0; i < times; i += 1) pending[index]?.()
    },
  }
}

/** 单条 sessionSend 用例只关心门禁/分发时用的空闲调度器(不排队)。 */
function idleScheduler(): TurnScheduler {
  return createTurnScheduler({ maxConcurrentTurns: () => 8, modelExists: () => true })
}

function sessionLog(entries: Record<string, unknown>[]): string {  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
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
    huaanworkSessionModels: new Map(),
    huaanworkSessionRoots: new Map(),
    huaanworkTurnScheduler: createTurnScheduler({
      maxConcurrentTurns: () => 3,
      modelExists: () => true,
    }),
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
  // 护栏插件把等待中的卡片/坏参数计数/计划目标登记在模块级 Map 上:逐用例复位。
  resetRouteToolState()
  resetQuestionAnswererState()
  resetChildSessionRegistry()
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
    await expect(sessionSend({}, routeCtx, { text: 'do work', tabId: 'tab-gate' })).rejects.toThrow(/公网/)

    await writeHuaanworkSettings(routeCtx.profileDir, { ...remote, allow_network: true })
    const { ctx, agents } = fakeAgentsRegistry()
    agents.set('huaanwork', {
      id: 'huaanwork',
      session: { id: sessionIdFor(routeCtx.workspaceRoot.current) },
      followup: () => undefined,
      whenIdle: async () => undefined,
      cancel: () => undefined,
    })
    const sent = (await sessionSend(ctx, routeCtx, { text: 'do work', tabId: 'tab-a' })) as { queued: boolean; sessionId: string }
    expect(sent.queued).toBe(true)

    await writeHuaanworkSettings(routeCtx.profileDir, {
      models: [{ id: 'l', name: 'local', base_url: 'http://127.0.0.1:11434/v1', model: 'm', api_key: '' }],
      active_model_id: 'l',
    })
    const local = (await sessionSend(ctx, routeCtx, { text: 'again', tabId: 'tab-a' })) as { queued: boolean }
    expect(local.queued).toBe(true)
  })

  test('requires params.text when no at/skill', async () => {
    const root = freshTmp()
    await expect(sessionSend({}, makeRouteCtx(root), { tabId: 'tab-a' })).rejects.toThrow(/requires params.text/)
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
    const ctx: SessionRuntimeContext = { huaanworkTurnScheduler: idleScheduler(), agents: { get: (id) => (id === 'huaanwork' ? channelAgent : undefined), list: () => [channelAgent] } }
    const sent = (await sessionSend(ctx, routeCtx, { text: '你好', tabId: 'tab-a' })) as { queued: boolean; sessionId: string }
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
      expect(result).toEqual({ queued: true, sessionId, started: true })
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
    const ctx: SessionRuntimeContext = { huaanworkTurnScheduler: idleScheduler() }
    await expect(sessionSend(ctx, routeCtx, { text: '@reviewer 看看代码', tabId: 'tab-a' })).rejects.toThrow(/未启用或不存在/)
  })

  test('@agent injects the parent delivery instruction instead of the bare remainder', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const sessionId = freshSessionIdFor(routeCtx.workspaceRoot.current)
    const received: { content: { text: string }[] }[] = []
    const activationSpecs: { request: { prompt: { text: string }[] }; childId?: string; signal?: AbortSignal }[] = []
    const registry = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined })
    const live: ListedAgent & { followup: (message: unknown) => void } = {
      id: sessionId,
      session: { id: sessionId },
      followup: (message) => received.push(message as { content: { text: string }[] }),
      whenIdle: async () => undefined,
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
    } as never)
    try {
      const ctx = {
        huaanworkTurnScheduler: idleScheduler(),
        agents: { get: (id: string) => (id === sessionId ? live : undefined), list: () => [live] },
        subagents: {
          startActivation: async (spec: never) => {
            activationSpecs.push(spec as never)
            return { childId: 'legacy-child', result: Promise.resolve({ ok: true }), dispose: async () => undefined }
          },
        },
        huaanworkSubagentRuns: registry,
      } as unknown as SessionRuntimeContext
      await sessionSend(ctx, routeCtx, { text: '@legacy-assistant 整理本周进展', sessionId, tabId: 'tab-a' })
      expect(received).toHaveLength(1)
      const text = received[0]!.content[0]!.text
      expect(text).toContain('整理本周进展')
      expect(text).toContain('自动回到本会话')
      expect(text).toContain('不要用 call_host_tool')
      // 提示只给父会话;子代理首条 prompt 仍是人设 + 用户请求。
      expect(activationSpecs[0]!.request.prompt[0]!.text).toBe('你是旧目录助手\n\n---\n用户请求：\n整理本周进展')
      // 预留 childId 是 Host 生成的 UUID;provider 返回实际 id 后重绑定。
      expect(activationSpecs[0]!.childId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
      const runs = registry.snapshot(sessionId).runs
      expect(runs).toHaveLength(1)
      expect(runs[0]!.kind).toBe('legacy')
      expect(runs[0]!.label).toBe('@legacy-assistant')
      expect(runs[0]!.childId).toBe('legacy-child')
    } finally {
      setAgentsDirectory(emptyDirectory as never)
    }
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
    const ctx: SessionRuntimeContext = { huaanworkTurnScheduler: idleScheduler(), agents: { get: (id) => (id === 'huaanwork' ? channelAgent : undefined), list: () => [channelAgent] } }
    await sessionSend(ctx, routeCtx, { text: '跑一下', skill: 'demo', tabId: 'tab-a' })
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
    const sent = (await sessionSend(ctx, routeCtx, { text: '你好', sessionId, tabId: 'tab-a' })) as { queued: boolean; sessionId: string }
    expect(sent.sessionId).toBe(sessionId)
    expect(calls).toEqual([
      { method: 'create', options: { sessionId, meta: { cwd: routeCtx.workspaceRoot.current }, agentOptions: { provider: 'deepseek-official', model: 'local' } } },
    ])
  })
})

/**
 * legacy `@agent` 执行链与子代理 run registry 的接线(设计 §5.1/§5.2)。
 *
 * 每条用例都钉一条取消/清理路径,并以 run 的真实相位收敛为准:只有执行终结且
 * 清理确认后才是 `stopped`,accepted/abort/dispose 发起都不算。
 */
describe('legacy @agent 运行链接线', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

  /** catalog 目录:一个 `kind: 'agent'` 条目 + 固定人设(与既有 @agent 用例同一形状)。 */
  function legacyCatalogDirectory(): { host: AgentsHost; restore: () => void } {
    const emptyDirectory = {
      list: () => ({ items: [] }),
      refresh: async () => ({ items: [] }),
      get: async () => undefined,
      setEnabled: () => undefined,
      addEndpoint: () => ({ ok: false as const, fieldErrors: [] }),
      removeEndpoint: () => undefined,
      snapshotForRuntime: () => ({ items: [] }),
    }
    const host = {
      ...emptyDirectory,
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
    } as unknown as AgentsHost
    setAgentsDirectory(host)
    return { host, restore: () => setAgentsDirectory(emptyDirectory as never) }
  }

  function legacyLiveAgent(
    sessionId: string,
    whenIdle?: () => Promise<void>,
  ): ListedAgent & { followup: (message: unknown) => void } {
    return {
      id: sessionId,
      session: { id: sessionId },
      followup: () => undefined,
      whenIdle: whenIdle ?? (async () => undefined),
    }
  }

  function legacyRunContext(options: {
    sessionId: string
    live: ListedAgent & { followup: (message: unknown) => void }
    registry: SubagentRunRegistry
    startActivation: (spec: { childId?: string; signal?: AbortSignal }) => Promise<SubagentActivationHandle>
  }): SessionRuntimeContext {
    return {
      huaanworkTurnScheduler: idleScheduler(),
      huaanworkSessionModels: new Map(),
      huaanworkSessionRoots: new Map(),
      agents: {
        get: (id: string) => (id === options.sessionId ? options.live : undefined),
        list: () => [options.live],
      },
      subagents: { startActivation: options.startActivation },
      huaanworkSubagentRuns: options.registry,
    } as unknown as SessionRuntimeContext
  }

  function newRegistry(): SubagentRunRegistry {
    return createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined })
  }

  /**
   * 等 run 出现。send 路径先做真实 settings 文件 I/O 才进 dispatchAt(评审 F-9),
   * 微任务轮询跨不过这个宏任务边界,必须用 `vi.waitFor`。
   */
  async function runIdOf(
    registry: SubagentRunRegistry,
    sessionId: string,
    clientMessageId?: string,
  ): Promise<string> {
    let runId = ''
    await vi.waitFor(() => {
      const run = registry
        .snapshot(sessionId)
        .runs.find((candidate) => clientMessageId === undefined || candidate.clientMessageId === clientMessageId)
      runId = run?.runId ?? ''
      expect(runId).toBeTruthy()
    })
    return runId
  }

  test('legacy cancel aborts before activation and disposes a late activation', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const sessionId = freshSessionIdFor(routeCtx.workspaceRoot.current)
    const { restore } = legacyCatalogDirectory()
    let resolveActivation!: (value: SubagentActivationHandle) => void
    const activationPromise = new Promise<SubagentActivationHandle>((resolve) => {
      resolveActivation = resolve
    })
    let disposeCalls = 0
    const registry = newRegistry()
    const specs: { childId?: string; signal?: AbortSignal }[] = []
    const ctx = legacyRunContext({
      sessionId,
      live: legacyLiveAgent(sessionId),
      registry,
      startActivation: (spec) => {
        specs.push(spec)
        return activationPromise
      },
    })
    try {
      const sent = sessionSend(ctx, routeCtx, {
        text: '整理本周进展',
        sessionId,
        tabId: 'tab-a',
        at: { name: 'legacy-assistant', clientMessageId: '42' },
      })
      const runId = await runIdOf(registry, sessionId)
      expect((await registry.requestCancel(sessionId, runId)).status).toBe('accepted')
      expect(registry.get(runId)?.phase).toBe('stopping')
      // 启动中的 abort 挂在保存的 controller 上,而不是一次性匿名 signal。
      expect(specs[0]?.signal?.aborted).toBe(true)
      resolveActivation({
        childId: 'legacy-child',
        result: Promise.resolve({ stopReason: 'aborted' }),
        dispose: async () => {
          disposeCalls += 1
        },
      })
      await expect(sent).rejects.toThrow(/取消/)
      // 晚到 activation:绑定 → 立即 dispose → 结果观察与 dispose 都结束后才 stopped。
      expect(disposeCalls).toBe(1)
      expect(registry.get(runId)?.phase).toBe('stopped')
      expect(registry.get(runId)?.childId).toBe('legacy-child')
      expect(registry.get(runId)?.clientMessageId).toBe('42')
    } finally {
      restore()
    }
  })

  test('legacy run reserves a UUID child, rebinds to the provider child, and observes a rejected result', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const sessionId = freshSessionIdFor(routeCtx.workspaceRoot.current)
    const { host, restore } = legacyCatalogDirectory()
    const registry = newRegistry()
    const specs: { childId?: string; signal?: AbortSignal; [HUAANWORK_SUBAGENT_RUN_ID]?: string }[] = []
    let rejectActivation!: (error: Error) => void
    const activationResult = new Promise((_resolve, reject) => {
      rejectActivation = reject
    })
    const live = legacyLiveAgent(sessionId)
    const ctx = legacyRunContext({
      sessionId,
      live,
      registry,
      startActivation: async (spec) => {
        specs.push(spec)
        return { childId: 'provider-assigned-child', result: activationResult, dispose: async () => undefined }
      },
    })
    try {
      await dispatchAt({
        host,
        ctx,
        sessionId,
        name: 'legacy-assistant',
        remainder: '整理本周进展',
        resolveParent: async () => live,
      })
      const runs = registry.snapshot(sessionId).runs
      expect(runs).toHaveLength(1)
      const runId = runs[0]!.runId
      expect(specs[0]!.childId).toMatch(UUID_RE)
      expect(specs[0]![HUAANWORK_SUBAGENT_RUN_ID]).toBe(runId)
      // provider 未沿用预留 id:活动归因改绑到实际 childId。
      expect(runs[0]!.childId).toBe('provider-assigned-child')
      rejectActivation(new Error('子代理结果失败'))
      // result rejection 走 rejectResult(执行失败),不是只表示启动失败的 failRun。
      await vi.waitFor(() => {
        expect(registry.get(runId)?.phase).toBe('failed')
      })
      expect(registry.get(runId)?.failure).toContain('子代理结果失败')
    } finally {
      restore()
    }
  })

  test('cancel before the activation is published stops the run without dispose or an afterIdle wait', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const sessionId = freshSessionIdFor(routeCtx.workspaceRoot.current)
    const { restore } = legacyCatalogDirectory()
    const registry = newRegistry()
    const specs: { childId?: string; signal?: AbortSignal }[] = []
    let releaseIdle!: () => void
    const idle = new Promise<void>((resolve) => {
      releaseIdle = resolve
    })
    const live = legacyLiveAgent(sessionId, () => idle)
    const ctx = legacyRunContext({
      sessionId,
      live,
      registry,
      startActivation: (spec) => {
        specs.push(spec)
        // 取消后才拒绝,始终不返回 activation:启动根本没有发布。
        return new Promise<SubagentActivationHandle>((_resolve, reject) => {
          spec.signal?.addEventListener('abort', () => reject(new Error('子代理启动已取消')))
        })
      },
    })
    try {
      const sent = sessionSend(ctx, routeCtx, {
        text: '整理本周进展',
        sessionId,
        tabId: 'tab-a',
        at: { name: 'legacy-assistant', clientMessageId: '启动中' },
      })
      const runId = await runIdOf(registry, sessionId)
      expect((await registry.requestCancel(sessionId, runId)).status).toBe('accepted')
      await expect(sent).rejects.toThrow(/取消/)
      expect(specs[0]?.signal?.aborted).toBe(true)
      expect(registry.get(runId)?.phase).toBe('stopped')
      // dispatchAt 抛错时 afterIdle 根本不会发布:父回合仍未 idle,run 已 stopped。
      expect(registry.get(runId)?.cleanupBudgetMs).toBeUndefined()
    } finally {
      releaseIdle()
      restore()
    }
  })

  test('cancel of a published activation stays stopping until dispose resolves and leaves the sibling alone', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const sessionId = freshSessionIdFor(routeCtx.workspaceRoot.current)
    const { host, restore } = legacyCatalogDirectory()
    const registry = newRegistry()
    const disposeGates: (() => void)[] = []
    const disposeCalls: number[] = []
    let started = 0
    // 父回合保持未 idle:afterIdle 不会自己跑,清理只可能来自定向取消。
    let releaseIdle!: () => void
    const idle = new Promise<void>((resolve) => {
      releaseIdle = resolve
    })
    const live = legacyLiveAgent(sessionId, () => idle)
    const ctx = legacyRunContext({
      sessionId,
      live,
      registry,
      startActivation: async () => {
        const index = started++
        disposeCalls[index] = 0
        const gate = new Promise<void>((resolve) => {
          disposeGates[index] = resolve
        })
        return {
          childId: `legacy-child-${String(index)}`,
          result: Promise.resolve({ stopReason: 'aborted' }),
          dispose: async () => {
            disposeCalls[index]! += 1
            await gate
          },
        }
      },
    })
    try {
      await sessionSend(ctx, routeCtx, {
        text: '第一件',
        sessionId,
        tabId: 'tab-a',
        at: { name: 'legacy-assistant', clientMessageId: 'first' },
      })
      // 第二件不经 session.send:同一会话的第二次发送现在会排队(单写者),
      // 这里要的是两个并行的 legacy run 来验证定向取消只作用于选中的 run。
      await dispatchAt({
        host,
        ctx,
        sessionId,
        name: 'legacy-assistant',
        remainder: '第二件',
        resolveParent: async () => live,
        clientMessageId: 'second',
      })
      const runs = registry.snapshot(sessionId).runs
      const runA = runs.find((run) => run.clientMessageId === 'first')!
      const runB = runs.find((run) => run.clientMessageId === 'second')!
      // 权威 aborted 已到但停止意图接管后仍停在 stopping,直到清理确认。
      await vi.waitFor(() => {
        expect(registry.get(runA.runId)?.phase).toBe('stopping')
      })
      expect((await registry.requestCancel(sessionId, runA.runId)).status).toBe('accepted')
      await vi.waitFor(() => {
        expect(disposeCalls[0]).toBe(1)
      })
      expect(registry.get(runA.runId)?.phase).toBe('stopping')
      disposeGates[0]!()
      await vi.waitFor(() => {
        expect(registry.get(runA.runId)?.phase).toBe('stopped')
      })
      // 定向取消只作用于选中的 run:兄弟 activation 既不 dispose 也不进 stopped。
      expect(registry.get(runB.runId)?.phase).toBe('stopping')
      expect(disposeCalls[1]).toBe(0)
    } finally {
      for (const release of disposeGates) release?.()
      releaseIdle()
      restore()
    }
  })

  test('afterIdle confirms cleanup only after the real result and dispose finish', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const sessionId = freshSessionIdFor(routeCtx.workspaceRoot.current)
    const { host, restore } = legacyCatalogDirectory()
    const registry = newRegistry()
    let disposeCalls = 0
    const live = legacyLiveAgent(sessionId)
    const ctx = legacyRunContext({
      sessionId,
      live,
      registry,
      startActivation: async () => ({
        childId: 'legacy-child',
        result: Promise.resolve({ stopReason: 'completed' }),
        dispose: async () => {
          disposeCalls += 1
        },
      }),
    })
    try {
      const dispatched = await dispatchAt({
        host,
        ctx,
        sessionId,
        name: 'legacy-assistant',
        remainder: '整理本周进展',
        resolveParent: async () => live,
      })
      const runId = registry.snapshot(sessionId).runs[0]!.runId
      await vi.waitFor(() => {
        expect(registry.get(runId)?.phase).toBe('completed')
      })
      await dispatched.afterIdle()
      const run = registry.get(runId)!
      expect(disposeCalls).toBe(1)
      // 成功结果不因后续清理改写,也不追加收尾预算。
      expect(run.phase).toBe('completed')
      expect(run.cleanupWarnings).toEqual([])
      expect(run.cleanupBudgetMs).toBeUndefined()
      // 重复 afterIdle 共享同一清理 Promise,不二次 dispose。
      await dispatched.afterIdle()
      expect(disposeCalls).toBe(1)
    } finally {
      restore()
    }
  })

  test('a rejected dispose keeps the natural phase and only adds the dispose warning', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const sessionId = freshSessionIdFor(routeCtx.workspaceRoot.current)
    const { host, restore } = legacyCatalogDirectory()
    const phases: string[] = []
    try {
      for (const stopReason of ['completed', 'error'] as const) {
        const registry = newRegistry()
        const live = legacyLiveAgent(sessionId)
        const ctx = legacyRunContext({
          sessionId,
          live,
          registry,
          startActivation: async () => ({
            childId: `legacy-child-${stopReason}`,
            result: Promise.resolve({ stopReason }),
            dispose: async () => {
              throw new Error('释放失败')
            },
          }),
        })
        const dispatched = await dispatchAt({
          host,
          ctx,
          sessionId,
          name: 'legacy-assistant',
          remainder: '整理本周进展',
          resolveParent: async () => live,
        })
        const runId = registry.snapshot(sessionId).runs[0]!.runId
        const natural = stopReason === 'completed' ? 'completed' : 'failed'
        await vi.waitFor(() => {
          expect(registry.get(runId)?.phase).toBe(natural)
        })
        await dispatched.afterIdle()
        const run = registry.get(runId)!
        expect(run.phase).toBe(natural)
        expect(run.cleanupWarnings).toEqual([{ code: 'activation-dispose-failed', severity: 'error' }])
        expect(run.cleanupBudgetMs).toBeUndefined()
        phases.push(run.phase)
      }
      expect(phases).toEqual(['completed', 'failed'])
    } finally {
      restore()
    }
  })

  test('a targeted cancel wakes an idle result wait without the cleanup budget', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const sessionId = freshSessionIdFor(routeCtx.workspaceRoot.current)
    const { host, restore } = legacyCatalogDirectory()
    const registry = newRegistry()
    let settleActivation!: (value: { stopReason: string }) => void
    const activationResult = new Promise((resolve) => {
      settleActivation = resolve
    })
    let releaseDispose!: () => void
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve
    })
    let disposeCalls = 0
    const live = legacyLiveAgent(sessionId)
    const ctx = legacyRunContext({
      sessionId,
      live,
      registry,
      startActivation: async () => ({
        childId: 'legacy-child',
        result: activationResult,
        dispose: async () => {
          disposeCalls += 1
          await disposeGate
        },
      }),
    })
    const dispatched = await dispatchAt({
      host,
      ctx,
      sessionId,
      name: 'legacy-assistant',
      remainder: '整理本周进展',
      resolveParent: async () => live,
    })
    const runId = registry.snapshot(sessionId).runs[0]!.runId
    try {
      // 正常 afterIdle 已开始等 real result;取消必须唤醒这次等待,而不是等满预算。
      const cleanup = dispatched.afterIdle()
      expect(disposeCalls).toBe(0)
      expect((await registry.requestCancel(sessionId, runId)).status).toBe('accepted')
      await vi.waitFor(() => {
        expect(disposeCalls).toBe(1)
      })
      expect(registry.get(runId)?.cleanupBudgetMs).toBeUndefined()
      expect(registry.get(runId)?.cleanupWarnings).toEqual([])
      expect(registry.get(runId)?.phase).toBe('stopping')
      settleActivation({ stopReason: 'aborted' })
      releaseDispose()
      await cleanup
      expect(disposeCalls).toBe(1)
      expect(registry.get(runId)?.phase).toBe('stopped')
    } finally {
      releaseDispose()
      restore()
    }
  })

  test('a short cleanup budget marks the run stopping once and converges after dispose (A-08)', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const sessionId = freshSessionIdFor(routeCtx.workspaceRoot.current)
    const { host, restore } = legacyCatalogDirectory()
    const registry = newRegistry()
    let settleActivation!: (value: { stopReason: string }) => void
    const activationResult = new Promise((resolve) => {
      settleActivation = resolve
    })
    let releaseDispose!: () => void
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve
    })
    let disposeCalls = 0
    const live = legacyLiveAgent(sessionId)
    const ctx = legacyRunContext({
      sessionId,
      live,
      registry,
      startActivation: async () => ({
        childId: 'legacy-child',
        result: activationResult,
        // dispose 同时结算 aborted result 并成功返回:释放即执行终结。
        dispose: async () => {
          disposeCalls += 1
          await disposeGate
          settleActivation({ stopReason: 'aborted' })
        },
      }),
    })
    const dispatched = await dispatchAt({
      host,
      ctx,
      sessionId,
      name: 'legacy-assistant',
      remainder: '整理本周进展',
      resolveParent: async () => live,
    })
    const runId = registry.snapshot(sessionId).runs[0]!.runId
    try {
      vi.useFakeTimers()
      // 父未 idle:还没有任何清理等待,推进预算不得写 cleanupBudgetMs。
      await vi.advanceTimersByTimeAsync(ACTIVATION_CLEANUP_TIMEOUT_MS)
      expect(registry.get(runId)?.cleanupBudgetMs).toBeUndefined()
      const cleanup = dispatched.afterIdle()
      await vi.advanceTimersByTimeAsync(ACTIVATION_CLEANUP_TIMEOUT_MS)
      // 预算到期先记事实再 dispose;stopped 要等 dispose 与结果观察都结束。
      expect(registry.get(runId)?.cleanupBudgetMs).toBe(ACTIVATION_CLEANUP_TIMEOUT_MS)
      expect(registry.get(runId)?.stopCause).toBe('cleanup-budget')
      expect(registry.get(runId)?.phase).toBe('stopping')
      // registry 契约(Task 2):`cleanup-budget-exceeded` 只在「已终态才发现预算到期」
      // 时追加;未终态走 cleanupBudgetMs + stopCause + stopping,不重复记告警。
      expect(registry.get(runId)?.cleanupWarnings).toEqual([])
      releaseDispose()
      await cleanup
      expect(disposeCalls).toBe(1)
      expect(registry.get(runId)?.phase).toBe('stopped')
      expect(registry.get(runId)?.stopReason).toBe('aborted')
    } finally {
      vi.useRealTimers()
      restore()
    }
  })

  test('the legacy branch fails loudly when the run registry was not injected', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const sessionId = freshSessionIdFor(routeCtx.workspaceRoot.current)
    const { host, restore } = legacyCatalogDirectory()
    const live = legacyLiveAgent(sessionId)
    const ctx = {
      agents: { get: (id: string) => (id === sessionId ? live : undefined), list: () => [live] },
      subagents: {
        startActivation: async () => ({
          childId: 'legacy-child',
          result: Promise.resolve({}),
          dispose: async () => undefined,
        }),
      },
    } as unknown as SessionRuntimeContext
    try {
      await expect(
        dispatchAt({
          host,
          ctx,
          sessionId,
          name: 'legacy-assistant',
          remainder: '整理本周进展',
          resolveParent: async () => live,
        }),
      ).rejects.toThrow(/subagent run registry is not initialized/)
    } finally {
      restore()
    }
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

  /** full 模式答一次计划评审,把目标记为该会话的已确认基线;这里返回评审监听器与事件。 */
  function planAnswerer(profileDir: string) {
    writeFileSync(join(profileDir, 'huaanwork-settings.json'), JSON.stringify({ guard_mode: 'full' }))
    const events: { approvalRequestId: string; autoContinue?: boolean }[] = []
    const approvals = new Map<string, (result: 'allowed-once' | 'rejected' | 'unavailable' | 'cancelled') => void>()
    let listener:
      | ((request: unknown, next: () => Promise<unknown>) => Promise<{ answers: { id: string; selected: string[] }[] }>)
      | undefined
    applyQuestionAnswerer({
      huaanworkProfileDir: profileDir,
      huaanworkWorkspaceRoot: { current: tmpdir() },
      huaanworkApprovals: approvals,
      huaanworkPlanReviews: new Map(),
      huaanworkEmit(event) {
        if (event.event === 'approval/asked') events.push(event)
      },
      on(_name, fn) {
        listener = fn as typeof listener
      },
    })
    const ask = (sessionId: string, plan: string) => {
      const callId = `call-${events.length}`
      return listener!({
        questions: [{
          id: 'plan-review',
          question: 'Approve this plan and leave plan mode?',
          detail: plan,
          options: [{ label: 'Approve' }, { label: 'Keep planning' }],
          intent: { kind: 'plan-review', approve: 'Approve', callId },
        }],
        agent: { session: { id: sessionId } },
      }, async () => {
        throw new Error('next')
      })
    }
    return { events, approvals, ask }
  }

  async function pendingAfter(promise: Promise<unknown>): Promise<'settled' | 'pending'> {
    return Promise.race([
      promise.then(() => 'settled' as const, () => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 30)),
    ])
  }

  test('sessionRemove forgets the last confirmed plan target through the real route path', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const sessionId = 'huaanwork-7777777777777777'
    writePersistedSession(routeCtx.dshHome, sessionId, routeCtx.workspaceRoot.current)
    const { events, approvals, ask } = planAnswerer(root)

    // full 模式没有基线 ⇒ 第一份计划自动继续,并记成该会话的确认目标。
    const first = await ask(sessionId, '# 周报\n\n写入 `out/report.md`，收件人：张三')
    expect(first.answers).toEqual([{ id: 'plan-review', selected: ['Approve'] }])
    expect(events[0]?.autoContinue).toBe(true)

    // 目标变了就再确认一次,把这第二份记为新的已确认目标。
    const second = ask(sessionId, '# 月报\n\n写入 `out/report.md`，收件人：李四')
    expect(await pendingAfter(second)).toBe('pending')
    approvals.get(events[1]!.approvalRequestId)!('allowed-once')
    await second

    // 经 session.remove 删除(不是直接调 forgetConfirmedTarget):记忆必须一起消失,
    // 因此下一份不同的计划按「没有上一份」自动继续;若接线丢失,它会停住等确认。
    await expect(sessionRemove(undefined, routeCtx, { sessionId })).resolves.toEqual({ removed: true })
    const afterRemoval = ask(sessionId, '# 季报\n\n写入 `out/report.md`，收件人：王五')
    const state = await pendingAfter(afterRemoval)
    if (state === 'pending') approvals.get(events[2]!.approvalRequestId)!('rejected')
    await afterRemoval
    expect(state).toBe('settled')
    expect(events[2]?.autoContinue).toBe(true)
  })

  test('task.remove and project.remove release runtime state before the sweep deletes logs', async () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const taskSession = 'huaanwork-8888888888888888'
    const projectSession = 'huaanwork-9999999999999999'
    writePersistedSession(routeCtx.dshHome, taskSession, routeCtx.workspaceRoot.current)
    writePersistedSession(routeCtx.dshHome, projectSession, routeCtx.workspaceRoot.current)
    writeFileSync(join(root, 'tasks.json'), JSON.stringify({
      tasks: [
        { id: 't1', projectId: 'p1', name: 'T1', createdAt: 1, sessionId: taskSession },
        { id: 't2', projectId: 'p2', name: 'T2', createdAt: 2, sessionId: projectSession },
      ],
    }))
    writeFileSync(join(root, 'projects.json'), JSON.stringify({
      projects: [{ id: 'p2', name: 'P2', root: join(root, 'p2'), createdAt: 1 }],
    }))

    const cancelled: string[] = []
    const agents = new Map<string, ListedAgent>()
    for (const sessionId of [taskSession, projectSession]) {
      agents.set(sessionId, {
        id: sessionId,
        session: { id: sessionId },
        status: 'running',
        cancel: (reason) => { cancelled.push(`${sessionId}:${reason.kind}`) },
      })
      registerChildSession(sessionId, `child-${sessionId}`)
      registerChildSession(`parent-${sessionId}`, sessionId)
      expect(noteInvalidRoute(sessionId).endTurn).toBe(false)
      expect(noteInvalidRoute(sessionId).endTurn).toBe(true)
    }
    routeCtx.runtimeCtx = { agents: { get: (id) => agents.get(id), list: () => [...agents.values()] } }

    type Exec = { agent?: unknown; signal?: AbortSignal }
    type Registered = { name: string; execute: (args: unknown, exec?: Exec) => Promise<unknown> }
    const tools = new Map<string, Registered>()
    applyRouteTools({
      huaanworkEmit: () => undefined,
      planMode: { set: () => undefined },
      tools: { register: (definition: Registered) => { tools.set(definition.name, definition) } },
    })
    const waiting = new Map<string, Promise<unknown>>()
    for (const sessionId of [taskSession, projectSession]) {
      const agent = agents.get(sessionId)!
      const pending = tools.get('request_input')!.execute({ question: '发给谁？' }, { agent })
      const settlement = expect(pending).rejects.toThrow(/回合已停止/)
      waiting.set(sessionId, settlement)
      await Promise.resolve()
    }

    const invoke = async (method: string, body: unknown) => {
      const route = ROUTE_TABLE.find((entry) => entry.method === method)
      if (!route) throw new Error(`missing route ${method}`)
      return route.handler({ params: {}, body, query: new URLSearchParams() }, routeCtx)
    }

    // task.remove:级联删任务绑定的会话日志;运行态必须先释放(等待卡片/agent/子会话/坏参数计数)。
    await invoke('task.remove', { id: 't1' })
    await waiting.get(taskSession)
    expect(answerRouteInput(taskSession, 'late')).toBe(false)
    expect(cancelled).toEqual([`${taskSession}:user`])
    expect(childrenOf(taskSession)).toEqual([])
    expect(childrenOf(`parent-${taskSession}`)).not.toContain(taskSession)
    expect(noteInvalidRoute(taskSession).endTurn).toBe(false)
    expect(existsSync(join(routeCtx.dshHome, 'sessions', 'repo', taskSession))).toBe(false)

    // project.remove:同一层级联路径也必须走同一释放逻辑。
    await invoke('project.remove', { projectId: 'p2' })
    await waiting.get(projectSession)
    expect(answerRouteInput(projectSession, 'late')).toBe(false)
    expect(cancelled).toEqual([`${taskSession}:user`, `${projectSession}:user`])
    expect(childrenOf(projectSession)).toEqual([])
    expect(childrenOf(`parent-${projectSession}`)).not.toContain(projectSession)
    expect(noteInvalidRoute(projectSession).endTurn).toBe(false)
    expect(existsSync(join(routeCtx.dshHome, 'sessions', 'repo', projectSession))).toBe(false)
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

  test('gates the session-bound endpoint instead of the global one', () => {
    const models = [
      { id: 'cloud', name: 'Cloud', base_url: 'https://api.example.com/v1', model: 'cloud', api_key: '' },
      { id: 'lan', name: 'LAN', base_url: 'http://192.168.1.10:8080/v1', model: 'qwen', api_key: '' },
    ]
    const publicGlobal = { ...emptySettings(), base_url: 'https://api.example.com/v1', allow_network: false, models }
    expect(() => assertStreamNetworkAllowed(publicGlobal)).toThrow(/公网/)
    expect(() => assertStreamNetworkAllowed(publicGlobal, { sessionId: 's1', table: new Map([['s1', 'lan']]) }))
      .not.toThrow()

    const lanGlobal = { ...emptySettings(), base_url: 'http://127.0.0.1:11434/v1', allow_network: false, models }
    expect(() => assertStreamNetworkAllowed(lanGlobal)).not.toThrow()
    expect(() => assertStreamNetworkAllowed(lanGlobal, { sessionId: 's1', table: new Map([['s1', 'cloud']]) }))
      .toThrow(/公网/)
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

/**
 * Task 6 调度器接线:发送只占坑不等待回合,排队项出队后重新复检并以队列项
 * 自己的标签、skill、at 启动。这里用一个真实调度器加可编排的 live agent,
 * 钉住应答形状、释放时机与根/模型表。
 */
describe('session.send 调度器接线', () => {
  type Harness = {
    routeCtx: RouteContext
    ctx: SessionRuntimeContext
    scheduler: TurnScheduler
    roots: Map<string, string>
    models: Map<string, string>
    followups: string[]
    followupsBySession: Map<string, string[]>
    releaseCalls: string[]
    cancelCalls: string[]
    events: RpcEvent[]
    createCalls: { sessionId: string; meta?: { cwd?: string }; rootAtCreate: string | undefined }[]
    addAgent(sessionId: string, whenIdle?: () => Promise<void>): void
    send(params: Record<string, unknown>): Promise<Record<string, unknown>>
    queueEvents(): RpcEvent[]
  }

  function bindProjects(
    profileDir: string,
    entries: readonly { projectId: string; projectRoot: string; sessionId: string }[],
  ): void {
    writeFileSync(
      join(profileDir, 'projects.json'),
      JSON.stringify({
        projects: entries.map((entry) => ({
          id: entry.projectId,
          name: entry.projectId,
          root: entry.projectRoot,
          createdAt: 1,
        })),
      }),
    )
    writeFileSync(
      join(profileDir, 'tasks.json'),
      JSON.stringify({
        tasks: entries.map((entry, index) => ({
          id: `task-${String(index)}`,
          projectId: entry.projectId,
          name: entry.projectId,
          createdAt: index,
          sessionId: entry.sessionId,
        })),
      }),
    )
  }

  function makeProject(root: string, name: string): string {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  async function makeHarness(root: string, options: { max?: number; workspace?: string } = {}): Promise<Harness> {
    const routeCtx = makeRouteCtx(root, options.workspace === undefined ? undefined : { workspace: options.workspace })
    const events: RpcEvent[] = []
    routeCtx.emit = (event) => {
      events.push(event)
    }
    neutralWorkspaceRoot(root)
    await writeHuaanworkSettings(root, {
      models: [
        { id: 'm1', name: 'M1', base_url: 'http://127.0.0.1:11434/v1', model: 'm1', api_key: '' },
        { id: 'm2', name: 'M2', base_url: 'http://127.0.0.1:11434/v1', model: 'm2', api_key: '' },
      ],
      active_model_id: 'm1',
    })
    const roots = new Map<string, string>()
    const models = new Map<string, string>()
    const followups: string[] = []
    const followupsBySession = new Map<string, string[]>()
    const releaseCalls: string[] = []
    const cancelCalls: string[] = []
    const createCalls: Harness['createCalls'] = []
    const live = new Map<string, ListedAgent & { followup: (message: unknown) => void }>()
    const textOf = (message: unknown): string => {
      const content = (message as { content?: { text?: string }[] }).content ?? []
      return content.map((block) => block.text ?? '').join('')
    }
    const addAgent = (sessionId: string, whenIdle?: () => Promise<void>): void => {
      live.set(sessionId, {
        id: sessionId,
        session: { id: sessionId },
        followup: (message) => {
          const text = textOf(message)
          followups.push(text)
          const list = followupsBySession.get(sessionId) ?? []
          list.push(text)
          followupsBySession.set(sessionId, list)
        },
        whenIdle: whenIdle ?? (async () => undefined),
        cancel: (reason) => {
          cancelCalls.push(`${sessionId}:${reason.kind}`)
        },
      })
    }
    const base = createTurnScheduler({
      // 缺省像生产 index.ts 一样每次从设置文件读上限(huaanwork-host/index.ts 的
      // maxConcurrentTurns 闭包同形):settings.set 写入新上限后即生效;
      // 传入 options.max 的用例保持固定上限,不受后续设置写入影响。
      maxConcurrentTurns: () => options.max ?? readHuaanworkSettingsSync(root).max_concurrent_turns,
      modelExists: (modelId) => readHuaanworkSettingsSync(root).models.some((model) => model.id === modelId),
    })
    const scheduler: TurnScheduler = {
      ...base,
      release: (sessionId) => {
        releaseCalls.push(sessionId)
        base.release(sessionId)
      },
    }
    const ctx: SessionRuntimeContext = {
      huaanworkTurnScheduler: scheduler,
      huaanworkSessionRoots: roots,
      huaanworkSessionModels: models,
      agents: {
        get: (id) => live.get(id),
        list: () => [...live.values()],
        create: async (payload) => {
          const { sessionId, meta } = payload as { sessionId: string; meta?: { cwd?: string } }
          createCalls.push({ sessionId, ...(meta === undefined ? {} : { meta }), rootAtCreate: roots.get(sessionId) })
          addAgent(sessionId)
          return {}
        },
        resume: async (payload) => {
          const sessionId = (payload as { resumeSessionId: string }).resumeSessionId
          createCalls.push({ sessionId, rootAtCreate: roots.get(sessionId) })
          addAgent(sessionId)
          return {}
        },
      },
    }
    return {
      routeCtx,
      ctx,
      scheduler,
      roots,
      models,
      followups,
      followupsBySession,
      releaseCalls,
      cancelCalls,
      events,
      createCalls,
      addAgent,
      send: async (params) => (await sessionSend(ctx, routeCtx, params)) as Record<string, unknown>,
      queueEvents: () =>
        events.filter((event) => event.event === 'session/queue-start' || event.event === 'session/queue-fail'),
    }
  }

  test('session.send returns before the turn is idle and queues a second writer on the same root', async () => {
    const root = freshTmp()
    const h = await makeHarness(root, { max: 2 })
    const project = makeProject(root, 'project-a')
    bindProjects(root, [
      { projectId: 'pa', projectRoot: project, sessionId: 'a1' },
      { projectId: 'pa', projectRoot: project, sessionId: 'a2' },
    ])
    const idle = makeDeferred()
    const idleA2 = makeDeferred()
    h.addAgent('a1', () => idle.promise)
    h.addAgent('a2', () => idleA2.promise)
    const sent = await h.send({ text: 'first', sessionId: 'a1', tabId: 'tab-a', modelId: 'm1' })
    expect(sent).toMatchObject({ queued: true, waiting: false, started: true })
    expect(h.releaseCalls).toEqual([])
    expect(h.followups).toEqual(['first'])

    const queued = await h.send({ text: 'second', sessionId: 'a2', tabId: 'tab-b', modelId: 'm1' })
    expect(queued).toMatchObject({ queued: true, waiting: true, started: false })
    expect(h.followups).toEqual(['first'])

    idle.resolve()
    await vi.waitFor(() => expect(h.followups).toEqual(['first', 'second']))
    expect(h.releaseCalls).toEqual(['a1'])
    expect(h.queueEvents()).toContainEqual({
      event: 'session/queue-start',
      sessionId: 'a2',
      tabId: 'tab-b',
      queueItemId: expect.any(String),
    })
    idleA2.resolve()
  })

  test('cancelling a running turn keeps the slot until the turn is idle', async () => {
    const root = freshTmp()
    const h = await makeHarness(root)
    const idle = makeDeferred()
    h.addAgent('a1', () => idle.promise)
    await h.send({ text: 'first', sessionId: 'a1', tabId: 'tab-a', modelId: 'm1' })

    sessionCancel(h.ctx, h.routeCtx, { sessionId: 'a1' })
    expect(h.cancelCalls).toEqual(['a1:user'])
    expect(h.releaseCalls).toEqual([])

    idle.resolve()
    await vi.waitFor(() => expect(h.releaseCalls).toEqual(['a1']))
  })

  test('session.resume keeps working while another project turn is active', async () => {
    const root = freshTmp()
    const projectA = makeProject(root, 'project-a')
    const projectB = makeProject(root, 'project-b')
    const routeCtx = makeRouteCtx(root, { workspace: projectA })
    const sessionB = 'huaanwork-bbbbbbbbbbbbbbbb'
    writePersistedSession(routeCtx.dshHome, sessionB, projectB)
    writeFileSync(
      join(root, 'projects.json'),
      JSON.stringify({ projects: [{ id: 'pb', name: 'B', root: projectB, createdAt: 1 }] }),
    )
    const { ctx, calls } = fakeAgentsRegistry()
    // 另一个项目根上的用户回合正在进行:resume 只恢复会话,不占根写者,也不读自动化计数。
    expect(
      ctx.huaanworkTurnScheduler!.admitUserTurn({
        sessionId: sessionIdFor(projectA),
        tabId: 'tab-a',
        text: '占用另一个根',
        modelId: 'default',
        root: projectA,
      }),
    ).toMatchObject({ kind: 'start' })
    await expect(sessionResume(ctx, routeCtx, { sessionId: sessionB })).resolves.toEqual({
      sessionId: sessionB,
      resumed: true,
    })
    expect(calls.map((call) => call.method)).toEqual(['resume'])
  })

  test('a missing writable root does not start', async () => {
    const root = freshTmp()
    const h = await makeHarness(root)
    bindProjects(root, [
      { projectId: 'p-missing', projectRoot: join(root, 'missing-project'), sessionId: 'missing' },
    ])
    h.addAgent('missing')

    await expect(h.send({ text: 'hello', sessionId: 'missing', tabId: 'tab-a', modelId: 'm1' }))
      .rejects.toThrow(/不存在/)
    expect(h.followups).toEqual([])
    expect(h.scheduler.activeTurnCount()).toBe(0)
  })

  test('a failed queued item releases the cap for the next root', async () => {
    const root = freshTmp()
    const h = await makeHarness(root, { max: 1 })
    const projectA = makeProject(root, 'project-a')
    const projectB = makeProject(root, 'project-b')
    const projectC = makeProject(root, 'project-c')
    bindProjects(root, [
      { projectId: 'pa', projectRoot: projectA, sessionId: 'a' },
      { projectId: 'pb', projectRoot: projectB, sessionId: 'b' },
      { projectId: 'pc', projectRoot: projectC, sessionId: 'c' },
    ])
    const idleA = makeDeferred()
    h.addAgent('a', () => idleA.promise)
    h.addAgent('b')
    h.addAgent('c')

    await h.send({ text: 'active', sessionId: 'a', tabId: 'tab-a', modelId: 'm1' })
    const queuedB = await h.send({ text: 'queued-b', sessionId: 'b', tabId: 'tab-b', modelId: 'm1' })
    await h.send({ text: 'queued-c', sessionId: 'c', tabId: 'tab-c', modelId: 'm2' })
    expect(queuedB).toMatchObject({ waiting: true, started: false })

    // 出队前模型 m1 被删;m2 仍可用。名额 1 ⇒ 失败项独占一次 drain。
    await writeHuaanworkSettings(root, {
      models: [{ id: 'm2', name: 'M2', base_url: 'http://127.0.0.1:11434/v1', model: 'm2', api_key: '' }],
      active_model_id: 'm2',
    })
    idleA.resolve()

    await vi.waitFor(() => expect(h.followups).toContain('queued-c'))
    expect(h.followups).toEqual(['active', 'queued-c'])
    expect(h.queueEvents()).toContainEqual({
      event: 'session/queue-fail',
      sessionId: 'b',
      tabId: 'tab-b',
      queueItemId: expect.any(String),
      reason: '模型不存在',
    })
    expect(h.queueEvents().filter((event) => event.event === 'session/queue-start'))
      .toContainEqual({
        event: 'session/queue-start',
        sessionId: 'c',
        tabId: 'tab-c',
        queueItemId: expect.any(String),
      })
    expect(h.queueEvents().some(
      (event) => event.event === 'session/queue-start' && 'sessionId' in event && event.sessionId === 'b',
    )).toBe(false)
  })

  // 最终评审 Important 2:删除会话必须收掉它在调度器里的等待项,否则下一次
  // drain 会对已删除会话走 sendToAgent → ensureChannelAgent,无 header 后重新
  // create,已删除会话被复活并执行排队文本。
  test('session.remove cancels the removed session’s queued items so a drain cannot resurrect it', async () => {
    const root = freshTmp()
    const h = await makeHarness(root, { max: 1 })
    const projectA = makeProject(root, 'project-a')
    const projectB = makeProject(root, 'project-b')
    bindProjects(root, [
      { projectId: 'pa', projectRoot: projectA, sessionId: 'a' },
      { projectId: 'pa', projectRoot: projectA, sessionId: 'victim' },
      { projectId: 'pb', projectRoot: projectB, sessionId: 'b' },
    ])
    // victim 有持久化日志:session.remove 要能找到并删掉它;删除后 header 即消失。
    writePersistedSession(h.routeCtx.dshHome, 'victim', projectA)
    const idleA = makeDeferred()
    const idleB = makeDeferred()
    h.addAgent('a', () => idleA.promise)
    h.addAgent('b', () => idleB.promise)

    // 名额 1:a 在 projectA 执行;victim 同根排队(早于 b);b 因名额满排队。
    await h.send({ text: 'active', sessionId: 'a', tabId: 'tab-a', modelId: 'm1' })
    const queuedVictim = await h.send({ text: 'queued-victim', sessionId: 'victim', tabId: 'tab-victim', modelId: 'm1' })
    await h.send({ text: 'queued-b', sessionId: 'b', tabId: 'tab-b', modelId: 'm1' })
    expect(queuedVictim).toMatchObject({ waiting: true, started: false })

    await expect(sessionRemove(h.ctx, h.routeCtx, { sessionId: 'victim' })).resolves.toEqual({ removed: true })
    await expect(sessionOpen(h.routeCtx, { sessionId: 'victim' })).rejects.toThrow(/was not found/)

    // a 空闲触发 drain:victim 不得被 create/resume/复活,b 正常接手名额。
    idleA.resolve()
    await vi.waitFor(() => expect(h.followupsBySession.get('b')).toEqual(['queued-b']))
    expect(h.createCalls.map((call) => call.sessionId)).not.toContain('victim')
    expect(h.followupsBySession.get('victim') ?? []).toEqual([])
    expect(h.queueEvents().some(
      (event) => event.event === 'session/queue-start' && 'sessionId' in event && event.sessionId === 'victim',
    )).toBe(false)
    expect(h.queueEvents()).toContainEqual({
      event: 'session/queue-start',
      sessionId: 'b',
      tabId: 'tab-b',
      queueItemId: expect.any(String),
    })
    expect(h.releaseCalls).toEqual(['a'])
    idleB.resolve()
  })

  test('a child session does not increment the active turn count', async () => {
    const root = freshTmp()
    const h = await makeHarness(root, { max: 1 })
    const project = makeProject(root, 'project-a')
    bindProjects(root, [{ projectId: 'pa', projectRoot: project, sessionId: 'parent' }])
    const idle = makeDeferred()
    h.addAgent('parent', () => idle.promise)

    // 真实子代理启动路径:skills 插件监听 subagent/start 登记子会话;假 activation
    // 在 startActivation 的父会话作用域里同步派发该事件(与 skills.spec.ts 的 harness 同形)。
    const startListeners: ((info: unknown) => void)[] = []
    let startedChildId: string | undefined
    h.ctx.huaanworkSubagentRuns = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined })
    h.ctx.subagents = {
      startActivation: async (spec) => {
        const childId = spec.childId
        if (childId === undefined) throw new Error('activation spec missing childId')
        startedChildId = childId
        for (const listener of startListeners) listener({ id: childId })
        return { childId, result: Promise.resolve({}), dispose: async () => undefined }
      },
    }
    const eventCtx = h.ctx as SessionRuntimeContext & {
      skills: { register: (skill: unknown) => () => void }
      on: (event: string, listener: (info: unknown) => void) => void
    }
    eventCtx.skills = { register: () => () => undefined }
    eventCtx.on = (event, listener) => {
      if (event === 'subagent/start') startListeners.push(listener)
    }
    applySkills(eventCtx as never)

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
            name: 'child-agent',
            source: 'catalog',
            kind: 'agent',
            description: '子代理',
            version: '1.0.0',
            permissions: [],
            enabled: true,
          },
        ],
      }),
      get: async () => ({ persona: '你是子代理' }),
    } as never)

    try {
      const sent = await h.send({
        text: '@child-agent 整理本周进展',
        sessionId: 'parent',
        tabId: 'tab-a',
        modelId: 'm1',
      })
      expect(sent).toMatchObject({ started: true })
      expect(startedChildId).toEqual(expect.any(String))
      // 子会话经真实 subagent/start 事件登记,不是测试里直接调 registerChildSession。
      expect(childrenOf('parent')).toEqual([startedChildId])
      // 父回合占一个名额;子代理启动后计数与写者都不变。
      expect(h.scheduler.activeTurnCount()).toBe(1)
      expect(h.scheduler.soleCapWriterSessionId()).toBe('parent')
      expect(h.followups).toHaveLength(1)

      // 若子代理启动被误当成一次用户准入(即便同根排队),父回合结束后它会被出队。
      idle.resolve()
      await vi.waitFor(() => expect(h.releaseCalls).toEqual(['parent']))
      expect(h.scheduler.activeTurnCount()).toBe(0)
      expect(h.followups).toHaveLength(1)
      expect(h.queueEvents()).toEqual([])
    } finally {
      setAgentsDirectory(emptyDirectory as never)
      setBundledSkillRegistrar(null)
    }
  })

  test('a late release from the first turn does not drop the next turn', async () => {
    const root = freshTmp()
    const h = await makeHarness(root, { max: 1 })
    const project = makeProject(root, 'project-a')
    bindProjects(root, [
      { projectId: 'pa', projectRoot: project, sessionId: 'same-session' },
      { projectId: 'pa', projectRoot: project, sessionId: 'other-session' },
    ])
    // T1、T2 是同一 sessionId(同一根、同一 live agent);T3 在另一会话上排队。
    const idle = manualIdle()
    const idleOther = manualIdle()
    h.addAgent('same-session', idle.whenIdle)
    h.addAgent('other-session', idleOther.whenIdle)

    await h.send({ text: 'first', sessionId: 'same-session', tabId: 'tab-1', modelId: 'm1' })
    const second = await h.send({ text: 'second', sessionId: 'same-session', tabId: 'tab-1', modelId: 'm1' })
    const third = await h.send({ text: 'third', sessionId: 'other-session', tabId: 'tab-3', modelId: 'm1' })
    expect(second).toMatchObject({ waiting: true, started: false })
    expect(third).toMatchObject({ waiting: true, started: false })
    expect(h.followups).toEqual(['first'])

    // T1 的 idle 迟到第二次:同一个 releaseOnce 再被调用一次,不得放掉接手同一会话的 T2。
    idle.fire(0, 2)
    await vi.waitFor(() => expect(h.followups).toEqual(['first', 'second']))
    expect(h.releaseCalls).toEqual(['same-session'])
    expect(h.scheduler.soleCapWriterSessionId()).toBe('same-session')
    expect(h.scheduler.activeTurnCount()).toBe(1)
    await new Promise((done) => setTimeout(done, 20))
    expect(h.followups).toEqual(['first', 'second'])

    // T2 结束后名额才轮到 T3;T2 与 T3 不得同时 followup。
    idle.fire(1)
    await vi.waitFor(() => expect(h.followups).toEqual(['first', 'second', 'third']))
    expect(h.scheduler.soleCapWriterSessionId()).toBe('other-session')
    expect(h.scheduler.activeTurnCount()).toBe(1)

    idleOther.fire(0)
    await vi.waitFor(() => expect(h.scheduler.activeTurnCount()).toBe(0))
    // T1 的重复 idle 只释放一次;序列里另外两次分别是 T2 与 T3 各自的回合结束。
    expect(h.releaseCalls).toEqual(['same-session', 'same-session', 'other-session'])
  })

  test('cancelling a queued item leaves the running turn', async () => {
    const root = freshTmp()
    const h = await makeHarness(root, { max: 2 })
    const project = makeProject(root, 'project-a')
    bindProjects(root, [
      { projectId: 'pa', projectRoot: project, sessionId: 'a1' },
      { projectId: 'pa', projectRoot: project, sessionId: 'a2' },
    ])
    const idle = makeDeferred()
    h.addAgent('a1', () => idle.promise)
    h.addAgent('a2')
    h.addAgent('child-of-a1')
    registerChildSession('a1', 'child-of-a1')

    await h.send({ text: 'first', sessionId: 'a1', tabId: 'tab-a', modelId: 'm1' })
    const queued = await h.send({ text: 'second', sessionId: 'a2', tabId: 'tab-b', modelId: 'm1' })
    expect(queued.queueItemId).toEqual(expect.any(String))

    sessionCancel(h.ctx, h.routeCtx, { sessionId: 'a1', queueItemId: queued.queueItemId })
    expect(h.cancelCalls).toEqual([])
    expect(h.releaseCalls).toEqual([])
    expect(h.scheduler.activeTurnCount()).toBe(1)
    expect(h.followups).toEqual(['first'])

    idle.resolve()
    await vi.waitFor(() => expect(h.releaseCalls).toEqual(['a1']))
    expect(h.followups).toEqual(['first'])
  })

  test('a queued skill and at replay on dequeue', async () => {
    const root = freshTmp()
    const h = await makeHarness(root, { max: 1 })
    const project = makeProject(root, 'project-a')
    bindProjects(root, [
      { projectId: 'pa', projectRoot: project, sessionId: 'a1' },
      { projectId: 'pa', projectRoot: project, sessionId: 'skill-session' },
      { projectId: 'pa', projectRoot: project, sessionId: 'at-session' },
    ])
    mkdirSync(join(root, 'skills', 'demo'), { recursive: true })
    writeFileSync(
      join(root, 'skills', 'demo', 'SKILL.md'),
      ['---', 'name: demo', 'description: 演示技能', '---', '', '按演示技能说明执行。'].join('\n'),
      'utf8',
    )
    const idleA = makeDeferred()
    const idleSkill = makeDeferred()
    h.addAgent('a1', () => idleA.promise)
    h.addAgent('skill-session', () => idleSkill.promise)
    h.addAgent('at-session')
    const activationSpecs: { childId?: string }[] = []
    h.ctx.subagents = {
      startActivation: async (spec: never) => {
        activationSpecs.push(spec as { childId?: string })
        return {
          childId: 'legacy-child',
          result: Promise.resolve({ ok: true }),
          dispose: async () => undefined,
        }
      },
    } as never
    h.ctx.huaanworkSubagentRuns = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined })
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
    } as never)

    try {
      await h.send({ text: 'first', sessionId: 'a1', tabId: 'tab-a', modelId: 'm1' })
      const skillQueued = await h.send({
        text: '跑一下',
        sessionId: 'skill-session',
        tabId: 'tab-skill',
        modelId: 'm1',
        skill: 'demo',
      })
      const atQueued = await h.send({
        text: '整理本周进展',
        sessionId: 'at-session',
        tabId: 'tab-at',
        modelId: 'm1',
        at: { name: 'legacy-assistant', clientMessageId: '42' },
      })
      expect(skillQueued).toMatchObject({ waiting: true, started: false })
      expect(atQueued).toMatchObject({ waiting: true, started: false })

      idleA.resolve()
      await vi.waitFor(() => expect(h.followupsBySession.get('skill-session')?.length).toBe(1))
      const skillText = h.followupsBySession.get('skill-session')![0]!
      expect(skillText).toContain('# 已启用技能：demo')
      expect(skillText).toContain('用户请求：')
      expect(skillText).toContain('跑一下')

      idleSkill.resolve()
      await vi.waitFor(() => expect(h.followupsBySession.get('at-session')?.length).toBe(1))
      expect(h.followupsBySession.get('at-session')![0]).toContain('整理本周进展')
      expect(activationSpecs[0]?.childId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
      const runs = h.ctx.huaanworkSubagentRuns!.snapshot('at-session').runs
      expect(runs[0]?.clientMessageId).toBe('42')

      expect(h.queueEvents()).toEqual(expect.arrayContaining([
        {
          event: 'session/queue-start',
          sessionId: 'skill-session',
          tabId: 'tab-skill',
          queueItemId: expect.any(String),
        },
        {
          event: 'session/queue-start',
          sessionId: 'at-session',
          tabId: 'tab-at',
          queueItemId: expect.any(String),
        },
      ]))
    } finally {
      setAgentsDirectory(emptyDirectory as never)
    }
  })

  test('session.send without a tab throws 缺少标签', async () => {
    const root = freshTmp()
    const h = await makeHarness(root)
    h.addAgent('a1')
    await expect(h.send({ text: 'hello', sessionId: 'a1', modelId: 'm1' })).rejects.toThrow(/缺少标签/)
    expect(h.followups).toEqual([])
  })

  test('the send records the session model and writable root until removal', async () => {
    const root = freshTmp()
    const h = await makeHarness(root)
    const project = makeProject(root, 'project-a')
    bindProjects(root, [{ projectId: 'pa', projectRoot: project, sessionId: 's1' }])
    const idle = makeDeferred()
    h.addAgent('s1', () => idle.promise)

    await h.send({ text: 'work', sessionId: 's1', tabId: 'tab-a', modelId: 'm2' })
    expect(h.models.get('s1')).toBe('m2')
    expect(h.roots.get('s1')).toBe(resolve(project))

    idle.resolve()
    await vi.waitFor(() => expect(h.releaseCalls).toEqual(['s1']))
    expect(h.models.get('s1')).toBe('m2')
    expect(h.roots.get('s1')).toBe(resolve(project))

    writePersistedSession(h.routeCtx.dshHome, 's1', project)
    await sessionRemove(h.ctx, h.routeCtx, { sessionId: 's1' })
    expect(h.models.has('s1')).toBe(false)
    expect(h.roots.has('s1')).toBe(false)
  })

  test('session.new uses an existing absolute cwd without moving the foreground root', () => {
    const root = freshTmp()
    const routeCtx = makeRouteCtx(root)
    const other = join(root, 'other-project')
    mkdirSync(other)
    const created = sessionNew(routeCtx, { cwd: other })
    expect(created.cwd).toBe(resolve(other))
    expect(created.sessionId).toBe(sessionIdFor(other))
    expect(routeCtx.workspaceRoot.current).toBe(join(root, 'workspace'))
  })

  test('foreground switch leaves the background session root', async () => {
    const root = freshTmp()
    const h = await makeHarness(root)
    const projectA = makeProject(root, 'project-a')
    const projectB = makeProject(root, 'project-b')
    bindProjects(root, [{ projectId: 'pa', projectRoot: projectA, sessionId: 's1' }])
    const idle = makeDeferred()
    h.addAgent('s1', () => idle.promise)
    h.routeCtx.workspaceRoot.current = projectA

    await h.send({ text: 'work', sessionId: 's1', tabId: 'tab-a', modelId: 'm1' })
    await openWorkspace(h.routeCtx, projectB)
    expect(h.routeCtx.workspaceRoot.current).toBe(resolve(projectB))
    expect(sessionWorkspaceRoot(h.ctx, 's1')).toBe(resolve(projectA))
    idle.resolve()
  })

  test('first project creation keeps its root while another is foreground', async () => {
    const root = freshTmp()
    const h = await makeHarness(root)
    const projectA = makeProject(root, 'project-a')
    const projectB = makeProject(root, 'project-b')
    bindProjects(root, [{ projectId: 'pb', projectRoot: projectB, sessionId: 'new-session' }])
    h.routeCtx.workspaceRoot.current = projectA

    const sent = await h.send({ text: 'work', sessionId: 'new-session', tabId: 'tab-a', modelId: 'm2' })
    expect(sent).toMatchObject({ started: true })
    expect(h.createCalls).toHaveLength(1)
    expect(h.createCalls[0]?.meta?.cwd).toBe(resolve(projectB))
    expect(h.createCalls[0]?.rootAtCreate).toBe(resolve(projectB))
    expect(h.models.get('new-session')).toBe('m2')
  })

  test('a fresh channel send records the admitted root when no entry exists', async () => {
    const root = freshTmp()
    const h = await makeHarness(root)
    const channelId = sessionIdFor(h.routeCtx.workspaceRoot.current)
    h.addAgent(channelId)

    await h.send({ text: 'hello', tabId: 'tab-a', modelId: 'm1' })
    expect(h.models.get(channelId)).toBe('m1')
    expect(h.roots.get(channelId)).toBe(resolve(neutralWorkspaceRoot(root)))
  })

  // —— Task 9:子任务记住模型 ——
  const taskModels = (root: string): Record<string, string | undefined> => {
    const path = join(root, 'tasks.json')
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { tasks?: { id: string; modelId?: string }[] }
    return Object.fromEntries((parsed.tasks ?? []).map((task) => [task.id, task.modelId]))
  }

  test('the send writes the admitted model onto the bound subtask once it starts', async () => {
    const root = freshTmp()
    const h = await makeHarness(root)
    const project = makeProject(root, 'project-a')
    bindProjects(root, [{ projectId: 'pa', projectRoot: project, sessionId: 's1' }])
    const idle = makeDeferred()
    h.addAgent('s1', () => idle.promise)

    const sent = await h.send({ text: 'work', sessionId: 's1', tabId: 'tab-a', modelId: 'm2' })
    expect(sent).toMatchObject({ started: true })
    expect(taskModels(root)).toEqual({ 'task-0': 'm2' })

    // 下一次发送换模型也不改写已记住的选择。
    idle.resolve()
    await vi.waitFor(() => expect(h.releaseCalls).toEqual(['s1']))
    await h.send({ text: 'more', sessionId: 's1', tabId: 'tab-a', modelId: 'm1' })
    expect(taskModels(root)).toEqual({ 'task-0': 'm2' })
    expect(h.models.get('s1')).toBe('m1')
  })

  test('a queued send writes the model only after the dequeue is admitted', async () => {
    const root = freshTmp()
    const h = await makeHarness(root, { max: 1 })
    const projectA = makeProject(root, 'project-a')
    const projectB = makeProject(root, 'project-b')
    bindProjects(root, [
      { projectId: 'pa', projectRoot: projectA, sessionId: 'a' },
      { projectId: 'pb', projectRoot: projectB, sessionId: 'b' },
    ])
    const idleA = makeDeferred()
    h.addAgent('a', () => idleA.promise)
    h.addAgent('b')

    await h.send({ text: 'active', sessionId: 'a', tabId: 'tab-a', modelId: 'm1' })
    const queued = await h.send({ text: 'waiting', sessionId: 'b', tabId: 'tab-b', modelId: 'm2' })
    expect(queued).toMatchObject({ started: false, waiting: true })
    // 还没执行就落盘会让选择与事实不符:排队期间只有已开始的会话被记住。
    expect(taskModels(root)['task-0']).toBe('m1')
    expect(taskModels(root)['task-1']).toBeUndefined()

    idleA.resolve()
    await vi.waitFor(() => expect(h.followups).toEqual(['active', 'waiting']))
    await vi.waitFor(() => expect(taskModels(root)).toEqual({ 'task-0': 'm1', 'task-1': 'm2' }))
  })

  test('a cap raise via settings.set drains the queue without a turn release', async () => {
    const root = freshTmp()
    // 上限跟设置文件(同生产 index.ts):初始上限 1,A 根活动、B 根排队。
    const h = await makeHarness(root)
    const projectA = makeProject(root, 'project-a')
    const projectB = makeProject(root, 'project-b')
    bindProjects(root, [
      { projectId: 'pa', projectRoot: projectA, sessionId: 'a' },
      { projectId: 'pb', projectRoot: projectB, sessionId: 'b' },
    ])
    await writeHuaanworkSettings(root, { max_concurrent_turns: 1 })
    const idleA = makeDeferred()
    const idleB = makeDeferred()
    h.addAgent('a', () => idleA.promise)
    h.addAgent('b', () => idleB.promise)

    await h.send({ text: 'active', sessionId: 'a', tabId: 'tab-a', modelId: 'm1' })
    const queuedB = await h.send({ text: 'queued-b', sessionId: 'b', tabId: 'tab-b', modelId: 'm1' })
    expect(queuedB).toMatchObject({ waiting: true, started: false })
    expect(h.followups).toEqual(['active'])

    // 真实 settings.set 路由把上限写回 3:A 的 idle 保持未 resolve,
    // B 不得等待 A 释放就应收到 queue-start 与 followup(GUI 3.4 回归)。
    h.routeCtx.runtimeCtx = h.ctx
    const settingsRoute = ROUTE_TABLE.find((route) => route.method === 'settings.set')!
    const written = (await settingsRoute.handler(
      { params: {}, body: { max_concurrent_turns: 3 }, query: new URLSearchParams() },
      h.routeCtx,
    )) as { max_concurrent_turns: number }
    expect(written.max_concurrent_turns).toBe(3)

    await vi.waitFor(() => expect(h.followupsBySession.get('b')).toEqual(['queued-b']))
    expect(h.queueEvents()).toContainEqual({
      event: 'session/queue-start',
      sessionId: 'b',
      tabId: 'tab-b',
      queueItemId: expect.any(String),
    })
    // A 的回合未被释放、未被重新输入;名额现在由 A 与 B 各占一个。
    expect(h.releaseCalls).toEqual([])
    expect(h.cancelCalls).toEqual([])
    expect(h.scheduler.activeTurnCount()).toBe(2)

    idleA.resolve()
    idleB.resolve()
  })

  test('a cap lower via settings.set is a no-op for active writers and waiting roots', async () => {
    const root = freshTmp()
    const h = await makeHarness(root)
    const projectA = makeProject(root, 'project-a')
    const projectB = makeProject(root, 'project-b')
    const projectC = makeProject(root, 'project-c')
    bindProjects(root, [
      { projectId: 'pa', projectRoot: projectA, sessionId: 'a' },
      { projectId: 'pb', projectRoot: projectB, sessionId: 'b' },
      { projectId: 'pc', projectRoot: projectC, sessionId: 'c' },
    ])
    await writeHuaanworkSettings(root, { max_concurrent_turns: 2 })
    const idleA = makeDeferred()
    const idleB = makeDeferred()
    h.addAgent('a', () => idleA.promise)
    h.addAgent('b', () => idleB.promise)
    h.addAgent('c')

    await h.send({ text: 'active-a', sessionId: 'a', tabId: 'tab-a', modelId: 'm1' })
    await h.send({ text: 'active-b', sessionId: 'b', tabId: 'tab-b', modelId: 'm1' })
    const queuedC = await h.send({ text: 'queued-c', sessionId: 'c', tabId: 'tab-c', modelId: 'm1' })
    expect(queuedC).toMatchObject({ waiting: true, started: false })

    // 名额已满时调低上限:活动写者不释放、不取消,等待根不得启动。
    h.routeCtx.runtimeCtx = h.ctx
    const settingsRoute = ROUTE_TABLE.find((route) => route.method === 'settings.set')!
    await settingsRoute.handler(
      { params: {}, body: { max_concurrent_turns: 1 }, query: new URLSearchParams() },
      h.routeCtx,
    )

    await new Promise((done) => setTimeout(done, 20))
    expect(h.followups).toEqual(['active-a', 'active-b'])
    expect(h.queueEvents()).toEqual([])
    expect(h.releaseCalls).toEqual([])
    expect(h.cancelCalls).toEqual([])
    expect(h.scheduler.activeTurnCount()).toBe(2)

    idleA.resolve()
    idleB.resolve()
  })

  test('a subtask keeps an existing model choice and a session without a subtask writes nothing', async () => {
    const root = freshTmp()
    const h = await makeHarness(root)
    const project = makeProject(root, 'project-a')
    writeFileSync(
      join(root, 'projects.json'),
      JSON.stringify({ projects: [{ id: 'pa', name: 'A', root: project, createdAt: 1 }] }),
    )
    writeFileSync(
      join(root, 'tasks.json'),
      JSON.stringify({
        tasks: [{ id: 'chosen', projectId: 'pa', name: '周报', createdAt: 1, sessionId: 's1', modelId: 'm1' }],
      }),
    )
    const idle = makeDeferred()
    h.addAgent('s1', () => idle.promise)

    await h.send({ text: 'work', sessionId: 's1', tabId: 'tab-a', modelId: 'm2' })
    expect(taskModels(root)).toEqual({ chosen: 'm1' })
    idle.resolve()
    await vi.waitFor(() => expect(h.releaseCalls).toEqual(['s1']))

    // 没有绑定子任务的会话:不创建、不修改 tasks.json。
    const tasksBefore = readFileSync(join(root, 'tasks.json'), 'utf8')
    h.addAgent('free-session')
    await h.send({ text: 'hello', sessionId: 'free-session', tabId: 'tab-c', modelId: 'm2' })
    expect(readFileSync(join(root, 'tasks.json'), 'utf8')).toBe(tasksBefore)
  })
})
