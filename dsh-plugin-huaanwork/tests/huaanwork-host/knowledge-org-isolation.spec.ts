/**
 * M1-2 Task 1: 整理槽前缀、6 点可见性隔离、缺根 fail-closed 与两个所有权注册表。
 *
 * 规格依据:docs/superpowers/specs/2026-11-24-knowledge-base-design.md §5.3 / §8.1 / §11.1。
 * 整理槽是每库固定单槽 `huaanwork-kb-org-<kbId>`:它不属于任何用户会话,
 * 因此读不到前台工作区、进不了侧栏、写不进用户对话流,也不占用回合锚点 LRU。
 */
import { spawnSync } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

import {
  isKbOrganizeSessionId as isClientKbOrganizeSessionId,
  KB_ORG_SESSION_PREFIX as CLIENT_KB_ORG_SESSION_PREFIX,
  unscopedSessions,
} from '../../src/client-huaanwork/logic/sessionChannel.ts'
import {
  attachAgentTools,
  emptyAttachments,
  isAgentToolAttached,
  type AttachmentMaps,
} from '../../src/huaanwork-guardrails/agent-attachments.ts'
import { apply as applyBridge } from '../../src/huaanwork-guardrails/bridge.ts'
import { makeResultPresentClaimed, RESULT_PRESENT_TOOL } from '../../src/huaanwork-guardrails/result-artifact-tools.ts'
import { apply as applySandbox, sessionWorkspaceRoot } from '../../src/huaanwork-guardrails/sandbox-cwd.ts'
import { registerChildSession, resetChildSessionRegistry } from '../../src/huaanwork-host/child-sessions.ts'
import {
  noteKnowledgeOrganizerActivity,
  noteKnowledgeOrganizerError,
  registerKnowledgeOrganizerActivity,
  type KnowledgeOrganizerActivity,
} from '../../src/huaanwork-host/knowledge/organizer-activity.ts'
import {
  isKbOrganizeSessionId,
  KB_ORG_SESSION_PREFIX,
  kbIdFromOrganizeSessionId,
  kbOrganizeSessionId,
} from '../../src/huaanwork-host/knowledge/session-ids.ts'
import { sweepProjectLegacySessions } from '../../src/huaanwork-host/session-sweep.ts'
import { sessionList, turnOriginForSession } from '../../src/huaanwork-host/sessions.ts'
import {
  createTurnAnchorStore,
  installTurnAnchorHooks,
  type TurnAnchorStore,
} from '../../src/huaanwork-host/turn-anchors.ts'
import { neutralKnowledgeWikiRootPath } from '../../src/huaanwork-host/workspace-state.ts'
import {
  registeredKnowledgeBaseIds,
  setRegisteredKnowledgeBaseIdsProvider,
  writableRootForSession,
} from '../../src/huaanwork-host/writable-root.ts'

// 透明包装 spawnSync:整理槽断言「不执行 git」,其余用例仍可用真实实现(此处不执行 git)。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) }
})

const ORG_SESSION = 'huaanwork-kb-org-kb1'
const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
  resetChildSessionRegistry()
})

function tmpDir(prefix = 'huaanwork-org-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function userMessage(id: string, kind = 'user') {
  return { role: 'user', id, source: { kind } }
}

type Listener = (...args: never[]) => unknown

// —— 沙箱与可写根 ——

type StubOptions = { seedSource?: string; meta?: { cwd?: string; parentSession?: string } }

function createSandboxCtx(roots: Map<string, string> = new Map()) {
  const opened = tmpDir('huaanwork-org-sandbox-opened-')
  const created: StubOptions[] = []
  const prepared: StubOptions[] = []
  const ctx = {
    huaanworkWorkspaceRoot: { current: opened },
    huaanworkSessionRoots: roots,
    sessions: {
      create(_id?: string, options?: StubOptions) {
        created.push(options ?? {})
        return { header: options?.meta }
      },
      prepare(_id?: string, options?: StubOptions) {
        prepared.push(options ?? {})
        return { header: options?.meta }
      },
    },
    sandboxPolicy: {
      workspaceRoot: opened,
      resolve(request?: { session?: { header?: { id?: string; cwd?: string; parentSession?: string } } }) {
        return { mode: 'workspace-write', workspaceRoot: request?.session?.header?.cwd ?? opened }
      },
    },
  }
  applySandbox(ctx as never)
  return { ctx, opened, created, prepared, roots }
}

test('organizer sessions without a registered root fail closed in every sandbox entry point', () => {
  const { ctx, opened, created, prepared } = createSandboxCtx()
  expect(() => ctx.sessions.create(ORG_SESSION, { meta: { cwd: opened } }))
    .toThrow(/knowledge-organize-root-missing/)
  // 缺根检查必须先于 persistence 早退:持久化恢复也不得回落前台工作区。
  expect(() => ctx.sessions.create(ORG_SESSION, { seedSource: 'persistence', meta: { cwd: opened } }))
    .toThrow(/knowledge-organize-root-missing/)
  expect(() => ctx.sessions.prepare(ORG_SESSION, { seedSource: 'persistence', meta: { cwd: opened } }))
    .toThrow(/knowledge-organize-root-missing/)
  expect(() => ctx.sandboxPolicy.resolve({ session: { header: { id: ORG_SESSION, cwd: opened } } }))
    .toThrow(/knowledge-organize-root-missing/)
  expect(() => sessionWorkspaceRoot(ctx, ORG_SESSION)).toThrow(/knowledge-organize-root-missing/)
  // 抛错发生在包装层:create / prepare 的底层实现没有被调用,也就不会写任何前台 cwd。
  expect(created).toEqual([])
  expect(prepared).toEqual([])
})

test('a registered parent root never rescues an organizer session without its own root', () => {
  const parent = tmpDir('huaanwork-org-parent-')
  const roots = new Map([['parent-session', parent]])
  registerChildSession('parent-session', ORG_SESSION)
  const { ctx } = createSandboxCtx(roots)
  expect(() => ctx.sandboxPolicy.resolve({ session: { header: { id: ORG_SESSION, cwd: parent } } }))
    .toThrow(/knowledge-organize-root-missing/)
  expect(() => sessionWorkspaceRoot(ctx, ORG_SESSION)).toThrow(/knowledge-organize-root-missing/)
})

test('a registered organizer root clamps every cwd into its wiki directory', () => {
  const profile = tmpDir('huaanwork-org-profile-')
  const wiki = resolve(neutralKnowledgeWikiRootPath(profile, 'kb1'))
  const roots = new Map([[ORG_SESSION, wiki]])
  const { ctx, opened, created, prepared } = createSandboxCtx(roots)
  const inside = join(wiki, 'topics', 'alpha.md')

  ctx.sessions.create(ORG_SESSION, { meta: { cwd: inside } })
  ctx.sessions.create(ORG_SESSION, { meta: { cwd: opened } })
  expect(created.map((options) => options.meta?.cwd)).toEqual([inside, wiki])

  ctx.sessions.prepare(ORG_SESSION, { seedSource: 'persistence', meta: { cwd: opened } })
  // persistence 早退保留原 cwd(日志路径匹配),但缺根检查已经先行通过。
  expect(prepared[0]?.meta?.cwd).toBe(opened)

  expect(ctx.sandboxPolicy.resolve({ session: { header: { id: ORG_SESSION, cwd: inside } } }).workspaceRoot)
    .toBe(inside)
  expect(ctx.sandboxPolicy.resolve({ session: { header: { id: ORG_SESSION, cwd: opened } } }).workspaceRoot)
    .toBe(wiki)
  expect(sessionWorkspaceRoot(ctx, ORG_SESSION)).toBe(wiki)
})

test('writableRootForSession reads registeredKbIds and never falls back for the organizer prefix', () => {
  const profile = tmpDir('huaanwork-org-writable-')
  const project = tmpDir('huaanwork-org-writable-project-')
  const projects = [{ id: 'p', root: project }]
  // 任务绑定与项目根都在,也必须被整理前缀分支挡住(不得改写写边界)。
  const tasks = [{ projectId: 'p', sessionId: ORG_SESSION }]
  const base = { profileDir: profile, sessionId: ORG_SESSION, projects, tasks }

  expect(() => writableRootForSession(base)).toThrow(/knowledge-organize-root-unregistered/)
  expect(() => writableRootForSession({ ...base, registeredKbIds: new Set<string>() }))
    .toThrow(/knowledge-organize-root-unregistered/)
  expect(() => writableRootForSession({ ...base, registeredKbIds: new Set(['other-kb']) }))
    .toThrow(/knowledge-organize-root-unregistered/)
  // 磁盘上存在 wiki/ 也不能代替登记(existsSync 不是登记判据)。
  mkdirSync(neutralKnowledgeWikiRootPath(profile, 'kb1'), { recursive: true })
  expect(() => writableRootForSession({ ...base, registeredKbIds: new Set(['other-kb']) }))
    .toThrow(/knowledge-organize-root-unregistered/)
  expect(writableRootForSession({ ...base, registeredKbIds: new Set(['kb1']) }))
    .toBe(resolve(neutralKnowledgeWikiRootPath(profile, 'kb1')))
})

test('session id helpers share one organizer prefix', () => {
  expect(KB_ORG_SESSION_PREFIX).toBe('huaanwork-kb-org-')
  expect(kbOrganizeSessionId('kb1')).toBe(ORG_SESSION)
  expect(isKbOrganizeSessionId(ORG_SESSION)).toBe(true)
  expect(isKbOrganizeSessionId('huaanwork-auto-x-y')).toBe(false)
  expect(isKbOrganizeSessionId('huaanwork-0123456789abcdef')).toBe(false)
  expect(isKbOrganizeSessionId(undefined)).toBe(false)
  expect(kbIdFromOrganizeSessionId(ORG_SESSION)).toBe('kb1')
  expect(kbIdFromOrganizeSessionId(KB_ORG_SESSION_PREFIX)).toBeUndefined()
  expect(kbIdFromOrganizeSessionId('huaanwork-0123456789abcdef')).toBeUndefined()
})

// —— 回合来源与回合锚点 ——

function claimResultPresent(
  sessionId: string,
  messageId: string,
  store: TurnAnchorStore,
  attachments: AttachmentMaps,
): void {
  // refreshAgentRestrict 在无 present-as state 的裸夹具里会写 console.error:测试内静音,不掩盖断言。
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    makeResultPresentClaimed({ huaanworkTurnAnchors: store, huaanworkAttachments: attachments })({
      agent: { session: { id: sessionId } },
      message: userMessage(messageId),
    } as never)
  } finally {
    errorSpy.mockRestore()
  }
}

test('organizer turns report the knowledge origin and never mount result_present', () => {
  expect(turnOriginForSession(ORG_SESSION)).toBe('knowledge')
  expect(turnOriginForSession('huaanwork-auto-x-y')).toBe('automation')
  expect(turnOriginForSession('huaanwork-0123456789abcdef')).toBe('advanced')

  const store = createTurnAnchorStore()
  store.register({ sessionId: ORG_SESSION, clientMessageId: 'm1', origin: 'knowledge' })
  expect(store.notePreStep(ORG_SESSION, [userMessage('m1')], 't1')).toMatchObject({
    clientMessageId: 'm1',
    origin: 'knowledge',
  })

  const attachments = emptyAttachments()
  attachAgentTools(attachments, ORG_SESSION, [RESULT_PRESENT_TOOL])
  claimResultPresent(ORG_SESSION, 'm1', store, attachments)
  expect(isAgentToolAttached(attachments, ORG_SESSION, RESULT_PRESENT_TOOL)).toBe(false)

  // 正对照:同一夹具下 advanced 回合仍会挂载 result_present(证明上面的 false 不是夹具失效)。
  const advancedStore = createTurnAnchorStore()
  advancedStore.register({ sessionId: 's-advanced', clientMessageId: 'm2', origin: 'advanced' })
  const advancedAttachments = emptyAttachments()
  claimResultPresent('s-advanced', 'm2', advancedStore, advancedAttachments)
  expect(isAgentToolAttached(advancedAttachments, 's-advanced', RESULT_PRESENT_TOOL)).toBe(true)
})

test('turn anchor hooks skip organizer slots without occupying the 256-entry LRU', () => {
  const store = createTurnAnchorStore({ limit: 2 })
  store.notePreStep('s1', [userMessage('m1')], 't1')
  const noteSpy = vi.spyOn(store, 'notePreStep')
  const clearSpy = vi.spyOn(store, 'clearSession')
  const listeners: Record<string, Listener[]> = {}
  installTurnAnchorHooks({
    huaanworkTurnAnchors: store,
    on(event, listener) {
      ;(listeners[event] ??= []).push(listener as Listener)
    },
  })

  const preStep = listeners['agent/pre-step']?.[0] as unknown as (
    payload: { agent?: unknown; messages?: unknown },
    next: () => unknown,
  ) => unknown
  let nextCalls = 0
  preStep(
    { agent: { id: ORG_SESSION, session: { id: ORG_SESSION } }, messages: [userMessage('org-1')] },
    () => {
      nextCalls += 1
      return 'end'
    },
  )
  expect(nextCalls).toBe(1)
  expect(noteSpy.mock.calls.map((call) => call[0])).not.toContain(ORG_SESSION)

  // 已有一条 s1 锚点,limit=2:整理槽若挤进 LRU,s1 会在 s2 写入时被淘汰。
  store.notePreStep('s2', [userMessage('m2')], 't2')
  expect(store.current('s1')).toBeDefined()

  const disposed = listeners['session/disposed']?.[0] as unknown as (session: { id?: string }) => void
  disposed({ id: ORG_SESSION })
  expect(clearSpy).not.toHaveBeenCalled()
  disposed({ id: 's1' })
  expect(clearSpy).toHaveBeenCalledWith('s1')
})

// —— 列表可见性 ——

function sessionLog(entries: Record<string, unknown>[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

function writePersistedSession(dshHome: string, id: string, cwd: string): void {
  const dir = join(dshHome, 'sessions', 'repo', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'session.jsonl'),
    sessionLog([
      { type: 'session', version: 0, id, createdAt: 1_000, cwd, delegationDepth: 0 },
      { type: 'user/message', seq: 1, time: 1_100, data: { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    ]),
    'utf8',
  )
}

test('sessionList hides organizer slots', async () => {
  const root = tmpDir('huaanwork-org-list-')
  const routeCtx = {
    dshHome: join(root, 'dsh'),
    profileDir: root,
    workspaceRoot: { current: join(root, 'workspace') },
    emit: () => undefined,
    logger: () => undefined,
    requestRestart: async () => true,
  }
  writePersistedSession(routeCtx.dshHome, 'huaanwork-0123456789abcdef', routeCtx.workspaceRoot.current)
  writePersistedSession(routeCtx.dshHome, 'huaanwork-kb-org-kb2', routeCtx.workspaceRoot.current)
  expect((await sessionList(routeCtx, undefined)).map((session) => session.id))
    .toEqual(['huaanwork-0123456789abcdef'])
})

test('the client sidebar mirror filters organizer slots', () => {
  expect(CLIENT_KB_ORG_SESSION_PREFIX).toBe('huaanwork-kb-org-')
  expect(isClientKbOrganizeSessionId(ORG_SESSION)).toBe(true)
  expect(isClientKbOrganizeSessionId(undefined)).toBe(false)
  const sessions = [
    { id: 'huaanwork-kb-org-kb1', cwd: '/neutral', messageCount: 3 },
    { id: 'huaanwork-auto-a-b', cwd: '/neutral', messageCount: 3 },
    { id: 'huaanwork-0123456789abcdef', cwd: '/neutral', messageCount: 3 },
  ]
  expect(unscopedSessions(sessions, []).map((session) => session.id))
    .toEqual(['huaanwork-0123456789abcdef'])
})

// —— bridge 事件抑制与活动心跳 ——

type StreamChunk = { type?: string; text?: string; block?: { type?: string; text?: string } }
type StreamWrap = (options: unknown, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
type ToolResult = { isError?: boolean; value?: unknown; content?: { type?: string; text?: string }[]; error?: unknown }
type Execute = (
  execution: {
    name: string
    callId?: string
    arguments?: unknown
    agent?: { id?: string; session?: { id?: string } }
  },
  next: () => Promise<ToolResult>,
) => Promise<ToolResult>

function createBridgeCtx() {
  const listeners: Record<string, Listener[]> = {}
  const emitted: { event?: string }[] = []
  const ctx = {
    huaanworkWorkspaceRoot: { current: tmpDir('huaanwork-org-bridge-root-') },
    huaanworkEmit(event: { event?: string }) {
      emitted.push(event)
    },
    on(event: string, listener: Listener) {
      ;(listeners[event] ??= []).push(listener)
    },
  }
  applyBridge(ctx as never)
  return { listeners, emitted }
}

function observeOrganizer() {
  const touches: KnowledgeOrganizerActivity[] = []
  const errors: string[] = []
  const dispose = registerKnowledgeOrganizerActivity(ORG_SESSION, {
    touch: (kind) => touches.push(kind),
    noteError: (message) => errors.push(message),
  })
  return { touches, errors, dispose }
}

test('mapTokens consumes and yields every organizer chunk without UI token events', async () => {
  const { listeners, emitted } = createBridgeCtx()
  const observer = observeOrganizer()
  try {
    const wrap = listeners['llm/stream']?.[0] as unknown as StreamWrap
    async function* stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', text: 'Hel' }
      yield { type: 'reasoning-delta', text: 'thinking' }
      yield { type: 'text-delta', text: 'lo' }
    }
    const received: StreamChunk[] = []
    for await (const chunk of wrap({ sessionId: ORG_SESSION }, stream)) received.push(chunk)
    expect(received.map((chunk) => chunk.text)).toEqual(['Hel', 'thinking', 'lo'])
    expect(emitted).toEqual([])
    expect(observer.touches).toEqual(['token', 'reasoning', 'token'])
  } finally {
    observer.dispose()
  }
})

test('organizer heartbeats fire before UI suppression and tools still execute exactly once', async () => {
  const { listeners, emitted } = createBridgeCtx()
  const observer = observeOrganizer()
  vi.mocked(spawnSync).mockClear()
  try {
    const wrap = listeners['llm/stream']?.[0] as unknown as StreamWrap
    async function* stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', text: 'a' }
      yield { type: 'reasoning-delta', text: 'b' }
    }
    const chunks: StreamChunk[] = []
    for await (const chunk of wrap({ sessionId: ORG_SESSION }, stream)) chunks.push(chunk)
    expect(chunks).toHaveLength(2)

    const execute = listeners['tools/execute']?.[0] as unknown as Execute
    let nextCalls = 0
    const result = await execute(
      { name: 'write', callId: 'w-1', agent: { session: { id: ORG_SESSION } } },
      async () => {
        nextCalls += 1
        return { isError: false, value: { stdout: 'written' }, content: [{ type: 'text', text: 'written' }] }
      },
    )
    expect(nextCalls).toBe(1)
    // 既有 capResult 返回形状原样保留(整理分支不得吞掉工具结果)。
    expect(result).toEqual({
      isError: false,
      value: { stdout: 'written' },
      content: [{ type: 'text', text: 'written' }],
    })
    // write 属于原本会做 diff 快照的工具,但整理槽不执行 git。
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled()

    const sessionEvent = listeners['session/event']?.[0] as unknown as (
      session: { id?: string },
      event: { type?: string; data?: unknown },
    ) => void
    sessionEvent({ id: ORG_SESSION }, { type: 'compaction/end', data: {} })

    expect(emitted).toEqual([])
    expect(observer.touches).toEqual([
      'token',
      'reasoning',
      'tool/start',
      'tool/end',
      'diff',
      'compaction/done',
    ])
  } finally {
    observer.dispose()
  }
})

test('organizer git_diff notes the diff heartbeat without emitting or snapshotting', async () => {
  const { listeners, emitted } = createBridgeCtx()
  const observer = observeOrganizer()
  vi.mocked(spawnSync).mockClear()
  try {
    const execute = listeners['tools/execute']?.[0] as unknown as Execute
    await execute(
      { name: 'git_diff', callId: 'd-1', agent: { session: { id: ORG_SESSION } } },
      async () => ({ isError: false, content: [{ type: 'text', text: '--- a\n+++ b' }] }),
    )
    expect(emitted).toEqual([])
    expect(observer.touches).toEqual(['tool/start', 'tool/end', 'diff'])
    expect(vi.mocked(spawnSync)).not.toHaveBeenCalled()
  } finally {
    observer.dispose()
  }
})

test('organizer agent/status and agent/error never broadcast session/end', () => {
  const { listeners, emitted } = createBridgeCtx()
  const observer = observeOrganizer()
  try {
    const status = listeners['agent/status']?.[0] as unknown as (
      payload: { status?: string; agent?: { session?: { id?: string } } },
    ) => void
    const error = listeners['agent/error']?.[0] as unknown as (
      payload: { error?: unknown; agent?: { session?: { id?: string } } },
    ) => void
    status({ status: 'idle', agent: { session: { id: ORG_SESSION } } })
    error({ error: new Error('boom'), agent: { session: { id: ORG_SESSION } } })
    error({
      error: Object.assign(new Error('upstream aborted'), { code: 'ABORTED' }),
      agent: { session: { id: ORG_SESSION } },
    })
    expect(emitted).toEqual([])
    expect(observer.errors).toEqual(['boom', 'upstream aborted'])
    expect(observer.touches).toEqual([])
  } finally {
    observer.dispose()
  }
})

test('App.tsx returns early for organizer event streams next to the automation early return', () => {
  const source = readFileSync(new URL('../../src/client-huaanwork/App.tsx', import.meta.url), 'utf8')
  expect(source).toMatch(/isKbOrganizeSessionId,\n/)
  expect(source).toMatch(/isAutomationSessionId\(eventSessionId\) && !boundTab\) return;/)
  expect(source).toMatch(/if \(typeof eventSessionId === "string" && isKbOrganizeSessionId\(eventSessionId\)\) return;/)
})

// —— 项目旧会话清扫豁免 ——

function sweepFileSystem(headers: Map<string, Record<string, unknown>>, removed: string[]) {
  return {
    async readdir(path: string): Promise<Dirent[]> {
      const dirent = path === '/fake/sessions'
        ? { name: 'repo', isDirectory: () => true, isFile: () => false }
        : { name: 'session.jsonl', isDirectory: () => false, isFile: () => true }
      return [dirent as unknown as Dirent]
    },
    async readEntryNames(): Promise<string[]> {
      return []
    },
    async readHeader(path: string): Promise<Record<string, unknown> | undefined> {
      return headers.get(path)
    },
    async remove(path: string): Promise<void> {
      removed.push(path)
    },
  }
}

test('the project legacy sweep keeps organizer slot logs and still removes ordinary ones', async () => {
  const project = tmpDir('huaanwork-org-sweep-project-')
  const orgRemoved: string[] = []
  const orgHeaders = new Map([
    ['/fake/sessions/repo/session.jsonl', { id: ORG_SESSION, cwd: join(project, 'wiki') }],
  ])
  const kept = await sweepProjectLegacySessions(
    '/fake/sessions',
    [project],
    new Set(),
    [],
    sweepFileSystem(orgHeaders, orgRemoved) as never,
  )
  expect(kept.removed).toBe(0)
  expect(orgRemoved).toEqual([])

  // 对照:同一判定下普通会话仍被删除(证明上面的 0 不是因为整轮短路)。
  const normalRemoved: string[] = []
  const normalHeaders = new Map([
    ['/fake/sessions/repo/session.jsonl', { id: 'huaanwork-0123456789abcdef', cwd: join(project, 'notes') }],
  ])
  const swept = await sweepProjectLegacySessions(
    '/fake/sessions',
    [project],
    new Set(),
    [],
    sweepFileSystem(normalHeaders, normalRemoved) as never,
  )
  expect(swept.removed).toBe(1)
  expect(normalRemoved).toEqual(['/fake/sessions/repo/session.jsonl'])
})

// —— 已登记 id provider 与活动表所有权 ——

test('registeredKnowledgeBaseIds is a live getter with ownership-checked disposers', () => {
  expect(registeredKnowledgeBaseIds().size).toBe(0)
  const live = new Set(['kb1'])
  const disposeOld = setRegisteredKnowledgeBaseIdsProvider(() => live)
  try {
    expect([...registeredKnowledgeBaseIds()]).toEqual(['kb1'])
    // 不缓存启动快照:provider 返回的集合增删立即反映。
    live.add('kb2')
    expect(registeredKnowledgeBaseIds().has('kb2')).toBe(true)
    live.delete('kb1')
    expect(registeredKnowledgeBaseIds().has('kb1')).toBe(false)

    const disposeNew = setRegisteredKnowledgeBaseIdsProvider(() => new Set(['kb3']))
    // 旧 Host 的晚到退场不得清掉新 Host 注册。
    disposeOld()
    expect([...registeredKnowledgeBaseIds()]).toEqual(['kb3'])
    disposeNew()
    expect(registeredKnowledgeBaseIds().size).toBe(0)
  } finally {
    disposeOld()
    setRegisteredKnowledgeBaseIdsProvider(undefined)()
  }
})

test('the organizer activity registry replaces per id and only removes its own observer', () => {
  const seen: string[] = []
  const disposeOld = registerKnowledgeOrganizerActivity(ORG_SESSION, {
    touch: (kind) => seen.push(`old:${kind}`),
    noteError: (message) => seen.push(`old-error:${message}`),
  })
  const disposeNew = registerKnowledgeOrganizerActivity(ORG_SESSION, {
    touch: (kind) => seen.push(`new:${kind}`),
    noteError: (message) => seen.push(`new-error:${message}`),
  })
  // 注册同一 id 已替换旧 observer;旧 disposer 晚到也不得删掉新注册。
  disposeOld()
  noteKnowledgeOrganizerActivity(ORG_SESSION, 'token')
  expect(seen).toEqual(['new:token'])

  disposeNew()
  noteKnowledgeOrganizerActivity(ORG_SESSION, 'token')
  noteKnowledgeOrganizerError(ORG_SESSION, 'after-dispose')
  expect(seen).toEqual(['new:token'])

  // 未注册 / 非字符串 id 一律 no-op(内部表不留 sessionId)。
  noteKnowledgeOrganizerActivity(undefined, 'token')
  noteKnowledgeOrganizerError(undefined, 'no-session')
  noteKnowledgeOrganizerActivity('huaanwork-kb-org-kb2', 'diff')
  noteKnowledgeOrganizerError('huaanwork-kb-org-kb2', 'no-observer')
  expect(seen).toEqual(['new:token'])
})
