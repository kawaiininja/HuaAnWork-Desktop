/**
 * M1-2 Task 6: organizer 接入 KnowledgeHost / SyncEngine 的整链路。
 *
 * 规格依据:docs/superpowers/specs/2026-11-24-knowledge-base-design.md §8.1–§8.3 / §11.1。
 * 这里只装配生产接线(KnowledgeHost + SyncEngine + KnowledgeOrganizer + TurnScheduler),
 * 用 fake `AgentHandle` 在 `followup` 内驱动真实 `kb_org_*` 工具,不调用真实模型:
 * - 阶段 1 对账的唯一提交回调 `onIndexCommitted` 覆盖六种 trigger;
 * - create / 重绑 / rebuild 成功出口的补偿排期;
 * - 维护取消、退场取消与看门狗心跳;
 * - `wiki/` 根部创建与否由真实 `preExecuteExplained` 的 allow/deny 对照判别(G-I1)。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Agent, AgentCancelCause, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { preExecuteExplained, REASON_PATH_ESCAPE } from '@huaanwork/policy'

import { emptyAttachments, type AttachmentMaps } from '../../src/huaanwork-guardrails/agent-attachments.ts'
import { apply as applyBridge } from '../../src/huaanwork-guardrails/bridge.ts'
import {
  createKnowledgeHost,
  type KnowledgeHost,
} from '../../src/huaanwork-host/knowledge/host.ts'
import { getKnowledgeHost, setKnowledgeHost } from '../../src/huaanwork-host/knowledge/host-ref.ts'
import { registerKnowledgeOrgTools } from '../../src/huaanwork-host/knowledge/org-tools.ts'
import {
  createKnowledgeOrganizer,
  type KnowledgeOrganizer,
  type KnowledgeOrganizerDeps,
} from '../../src/huaanwork-host/knowledge/organizer.ts'
import { kbIdFromOrganizeSessionId, kbOrganizeSessionId } from '../../src/huaanwork-host/knowledge/session-ids.ts'
import {
  createKnowledgeStorageClient,
  type KnowledgeStorageClient,
} from '../../src/huaanwork-host/knowledge/storage-client.ts'
import type { SyncWatchFactory, SyncWatcherHandle } from '../../src/huaanwork-host/knowledge/sync-engine.ts'
import type { KnowledgeBaseRecord, PendingOrganizeBatch } from '../../src/huaanwork-host/knowledge/types.ts'
import type { RouteContext } from '../../src/huaanwork-host/routes.ts'
import {
  drainUserQueue,
  releaseAndDrain,
  setReevaluateKbOrganize,
  type SessionRuntimeContext,
} from '../../src/huaanwork-host/sessions.ts'
import { createTurnScheduler, type TurnScheduler } from '../../src/huaanwork-host/turn-scheduler.ts'
import {
  registeredKnowledgeBaseIds,
  setRegisteredKnowledgeBaseIdsProvider,
} from '../../src/huaanwork-host/writable-root.ts'
import {
  neutralKnowledgeRootPath,
  neutralKnowledgeWikiRootPath,
} from '../../src/huaanwork-host/workspace-state.ts'
import { bootHuaanworkHost, hostConfig } from './startup-sweep-fixture.ts'

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(error: unknown): void
  readonly settled: boolean
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  let settled = false
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    reject = (error) => {
      if (settled) return
      settled = true
      rejectPromise(error)
    }
  })
  return {
    promise,
    resolve,
    reject,
    get settled() {
      return settled
    },
  }
}

interface FixtureFile {
  readonly relPath: string
  readonly content: string
}

const DEFAULT_FILES: readonly FixtureFile[] = [
  { relPath: 'alpha.md', content: '# Alpha\n\n组织章程第一条：风控审批。\n' },
  { relPath: 'beta.md', content: '# Beta\n\n组织章程第二条：季度复盘。\n' },
]

const DEFAULT_SETTINGS: Record<string, unknown> = {
  models: [{
    id: 'm1',
    name: '测试模型',
    base_url: 'http://127.0.0.1:11434/v1',
    model: 'deepseek-chat',
    api_key: '',
  }],
  active_model_id: 'm1',
  allow_network: false,
}

/** 模型缺失:models 为空 ⇒ organizer 预检落在 blocked-no-model。 */
const NO_MODEL_SETTINGS: Record<string, unknown> = {
  models: [],
  active_model_id: '',
  allow_network: false,
}

/** 公网端点且未开 allow_network ⇒ 预检落在 blocked-network。 */
const PUBLIC_ENDPOINT_SETTINGS: Record<string, unknown> = {
  models: [{
    id: 'm1',
    name: '公网模型',
    base_url: 'https://api.example.com/v1',
    model: 'deepseek-chat',
    api_key: '',
  }],
  active_model_id: 'm1',
  allow_network: false,
}

function writeSettings(profileDir: string, settings: Record<string, unknown> = DEFAULT_SETTINGS): void {
  writeFileSync(join(profileDir, 'huaanwork-settings.json'), `${JSON.stringify(settings, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// registry 写入门闩(只在「create 补偿排期」用例里使用)
// ---------------------------------------------------------------------------

const registryGate = vi.hoisted(() => ({ promise: undefined as Promise<void> | undefined }))

vi.mock('../../src/huaanwork-host/knowledge/registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/huaanwork-host/knowledge/registry.ts')>()
  return {
    ...actual,
    writeKnowledgeBases: async (
      profileDir: string,
      records: readonly KnowledgeBaseRecord[],
    ): Promise<void> => {
      const gate = registryGate.promise
      if (gate !== undefined) await gate
      return actual.writeKnowledgeBases(profileDir, records)
    },
  }
})

// ---------------------------------------------------------------------------
// 工具注册表(fake tools 服务)与 fake AgentHandle
// ---------------------------------------------------------------------------

type OrganizerAgentRef = { readonly id?: string; readonly session?: { readonly id?: string } }

interface ToolDefinition {
  readonly name: string
  execute(args: Record<string, unknown>, exec: { readonly agent?: OrganizerAgentRef }): Promise<{ readonly text: string }>
}

interface ScriptContext {
  readonly kbId: string
  readonly sessionId: string
  readonly wikiRoot: string
  readonly batch: PendingOrganizeBatch
  readonly runTool: (name: string, args?: Record<string, unknown>) => Promise<string>
  readonly idle: Deferred<void>
}

type AgentScript = (context: ScriptContext) => Promise<void>

/** 按上游 `write` 行为补建 `docs/` 与卡片,再走真实 `kb_org_mark_organized` 结算。 */
async function performBatch(context: ScriptContext): Promise<PendingOrganizeBatch> {
  const delta = JSON.parse(await context.runTool('kb_org_get_delta')) as PendingOrganizeBatch
  if (delta.docs.length > 0) mkdirSync(join(context.wikiRoot, 'docs'), { recursive: true })
  for (const doc of delta.docs) {
    writeFileSync(
      join(context.wikiRoot, 'docs', `${doc.docId}.md`),
      `# ${doc.relPath}\n\n整理卡片：${doc.docId}\n`,
    )
  }
  await context.runTool('kb_org_mark_organized', {
    processed: delta.docs.map(doc => doc.docId),
    clearedTombstones: delta.tombstones.map(tombstone => tombstone.docId),
    summary: '集成整理批次',
  })
  return delta
}

const completeScript: AgentScript = async (context) => {
  await performBatch(context)
  context.idle.resolve()
}

/** 回合永不自行结束:用于维护取消、退场取消与心跳用例。 */
const stuckScript: AgentScript = async () => {
  // 故意不 resolve:结算只能来自取消或看门狗。
}

interface AgentCreateInfo {
  readonly profileDir: string
  readonly kbId: string
  readonly sessionId: string
  readonly wikiRoot: string
  readonly batch: PendingOrganizeBatch
}

interface AgentHarness {
  readonly sessionId: string
  readonly agent: Agent
  readonly idle: Deferred<void>
  readonly followup: ReturnType<typeof vi.fn>
  /** `followup` 已被调用(与 fake 定时器兼容的等待信号)。 */
  readonly followupSignal: Deferred<void>
  readonly whenIdle: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
  readonly dispose: ReturnType<typeof vi.fn>
  readonly cancelCauses: AgentCancelCause[]
  readonly promptContexts: Array<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// fake watcher(debounce trigger)
// ---------------------------------------------------------------------------

type WatcherChangeListener = (eventType: string, filename: string | Buffer | null) => void

interface FakeWatcher {
  readonly handle: SyncWatcherHandle
  emitChange(name: string): void
  readonly closed: boolean
}

function createFakeWatcher(): FakeWatcher {
  const listeners: WatcherChangeListener[] = []
  let closed = false
  const handle = {
    on(event: 'change' | 'error', listener: WatcherChangeListener): unknown {
      if (event === 'change' && !closed) listeners.push(listener)
      return handle
    },
    close(): void {
      closed = true
      listeners.length = 0
    },
  } as unknown as SyncWatcherHandle
  return {
    handle,
    emitChange(name: string): void {
      for (const listener of [...listeners]) listener('change', name)
    },
    get closed() {
      return closed
    },
  }
}

// ---------------------------------------------------------------------------
// Harness:生产接线的测试装配
// ---------------------------------------------------------------------------

interface NotifyCall {
  readonly kbId: string
  readonly candidates: readonly string[]
}

interface HarnessOptions {
  readonly prefix?: string
  readonly files?: readonly FixtureFile[]
  readonly settings?: Record<string, unknown> | null
  readonly autoOrganize?: boolean
  /** 默认 api:start() 后 host.create;file:预写注册表后 start()。 */
  readonly register?: 'api' | 'file'
  readonly script?: AgentScript
  readonly timeoutMs?: number
  readonly maxConcurrentTurns?: number
  readonly debounceMs?: number
  readonly writeStableMs?: number
  readonly reconcileIntervalMs?: number
  readonly storageOverride?: (real: KnowledgeStorageClient) => Partial<KnowledgeStorageClient>
  readonly now?: () => number
  readonly onCreate?: (info: AgentCreateInfo) => void
}

interface Harness {
  readonly root: string
  readonly profileDir: string
  readonly dshHome: string
  readonly sourceDir: string
  readonly kbId: string
  readonly wikiRoot: string
  readonly host: KnowledgeHost
  readonly organizer: KnowledgeOrganizer
  readonly scheduler: TurnScheduler
  readonly storage: KnowledgeStorageClient
  readonly runtimeCtx: SessionRuntimeContext
  readonly routeCtx: RouteContext
  readonly sessionRoots: Map<string, string>
  readonly sessionToolAllow: Map<string, readonly string[]>
  readonly sessionModels: Map<string, string>
  readonly attachments: AttachmentMaps
  readonly createAgent: ReturnType<typeof vi.fn>
  readonly agents: AgentHarness[]
  readonly notifyCalls: NotifyCall[]
  readonly noteSystemResumeSpy: { mockClear(): void }
  readonly scheduleEvaluateSpy: { mockClear(): void }
  readonly watchers: FakeWatcher[]
  readonly recordOrganizeFailureSpy: unknown
  readonly unregisterKnowledgeHost: () => void
  readonly unregisterKnowledgeIds: () => void
  readonly unsubscribeOrganizerResume: () => void
  readonly disposeTools: () => void
  clearNotifies(): void
  waitForAgent(target: number): Promise<void>
  waitForPhase(phase: string): Promise<void>
  addKb(name: string, files: readonly FixtureFile[]): Promise<{ readonly kbId: string; readonly sourceDir: string; readonly wikiRoot: string }>
}

const tempDirs: string[] = []
const activeHarnesses: Harness[] = []

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(root)
  return root
}

afterEach(async () => {
  registryGate.promise = undefined
  for (const harness of activeHarnesses.splice(0).reverse()) {
    setReevaluateKbOrganize(undefined)
    try {
      harness.unsubscribeOrganizerResume()
    } catch {
      // 退订失败不掩盖测试结果。
    }
    try {
      harness.unregisterKnowledgeIds()
      harness.unregisterKnowledgeHost()
    } catch {
      // 所有权注销失败不掩盖测试结果。
    }
    try {
      harness.disposeTools()
    } catch {
      // 工具注销失败不掩盖测试结果。
    }
    try {
      await harness.organizer.cancelAll()
    } catch {
      // 清理失败不掩盖测试结果。
    }
    try {
      await harness.host.dispose()
    } catch {
      // 清理失败不掩盖测试结果。
    }
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = makeRoot(options.prefix ?? 'kb-org-integration-')
  const profileDir = join(root, 'profile')
  const dshHome = join(root, 'dsh')
  const sourceDir = join(root, 'source')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })
  for (const file of options.files ?? DEFAULT_FILES) {
    writeFileSync(join(sourceDir, file.relPath), file.content)
  }
  if (options.settings !== null) writeSettings(profileDir, options.settings ?? DEFAULT_SETTINGS)

  const realStorage = createKnowledgeStorageClient()
  const storage: KnowledgeStorageClient = {
    ...realStorage,
    ...(options.storageOverride?.(realStorage) ?? {}),
  }

  const watchers: FakeWatcher[] = []
  const watchFactory: SyncWatchFactory = () => {
    const watcher = createFakeWatcher()
    watchers.push(watcher)
    return watcher.handle
  }

  const host = createKnowledgeHost({
    profileDir,
    storageOverrideForTest: storage,
    debounceMs: options.debounceMs ?? 3_000,
    writeStableMs: options.writeStableMs ?? 0,
    reconcileIntervalMs: options.reconcileIntervalMs ?? 300_000,
    watchFactory,
  })

  const sessionModels = new Map<string, string>()
  const sessionRoots = new Map<string, string>()
  const sessionToolAllow = new Map<string, readonly string[]>()
  const attachments = emptyAttachments()
  const scheduler = createTurnScheduler({
    maxConcurrentTurns: () => options.maxConcurrentTurns ?? 1,
    modelExists: () => true,
    now: () => Date.now(),
  })
  const runtimeCtx = { huaanworkTurnScheduler: scheduler } as unknown as SessionRuntimeContext
  const routeCtx = {
    dshHome,
    profileDir,
    workspaceRoot: { current: join(root, 'workspace') },
    emit: () => undefined,
    logger: () => undefined,
    requestRestart: async () => true,
  } as unknown as RouteContext

  const agents: AgentHarness[] = []
  const liveSessions = new Set<string>()
  const registeredTools = new Map<string, ToolDefinition>()
  const agentSignals: Array<Deferred<void>> = []
  const signalAgent = (): void => {
    for (const signal of agentSignals.splice(0)) signal.resolve()
  }
  const nextAgentSignal = (): Promise<void> => {
    const signal = deferred<void>()
    agentSignals.push(signal)
    return signal.promise
  }

  const createAgentMock = vi.fn(async (createOptions: CreateAgentOptions): Promise<AgentHandle> => {
    const sessionId = String(createOptions.sessionId)
    // 真实注册表对同一会话重复 create 会抛 SessionAlreadyExistsError;维护取消必须
    // await in-flight 结算,否则这里会把该错误暴露给 rebuild/remove 调用方。
    if (liveSessions.has(sessionId)) {
      throw new Error(`SessionAlreadyExistsError: ${sessionId}`)
    }
    const kbId = kbIdFromOrganizeSessionId(sessionId)
    if (kbId === undefined) throw new Error(`unexpected organizer session id: ${sessionId}`)
    const wikiRoot = neutralKnowledgeWikiRootPath(profileDir, kbId)
    // G-I1:organizer 必须在 createAgent 前补建 wiki/ 根;fake agent 自己绝不创建它。
    expect(existsSync(wikiRoot), `organizer must create wiki/ before createAgent (${kbId})`).toBe(true)
    const batch = host.getOpenOrganizeBatch(kbId)
    options.onCreate?.({ profileDir, kbId, sessionId, wikiRoot, batch })
    liveSessions.add(sessionId)

    const idle = deferred<void>()
    void idle.promise.catch(() => undefined)
    const followupSignal = deferred<void>()
    const cancelCauses: AgentCancelCause[] = []
    const promptContexts: Array<Record<string, unknown>> = []
    const agentRef = {} as Agent
    const runTool = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
      const tool = registeredTools.get(name)
      if (tool === undefined) throw new Error(`tool ${name} is not registered`)
      const result = await tool.execute(args, { agent: agentRef as OrganizerAgentRef })
      return result.text
    }
    const followup = vi.fn((_message: unknown): void => {
      followupSignal.resolve()
      const script = options.script ?? completeScript
      void (async (): Promise<void> => {
        await script({ kbId, sessionId, wikiRoot, batch, runTool, idle })
      })().catch((error: unknown) => {
        idle.reject(error)
      })
    })
    const cancel = vi.fn((cause: AgentCancelCause): void => {
      cancelCauses.push(cause)
      if (!idle.settled) idle.reject(new Error(`agent-canceled:${cause.kind}`))
    })
    Object.assign(agentRef, {
      id: sessionId,
      session: { id: sessionId },
      followup,
      whenIdle: vi.fn(() => idle.promise),
      cancel,
    })
    const dispose = vi.fn(async (): Promise<void> => {
      liveSessions.delete(sessionId)
    })
    const handle: AgentHandle = { agent: agentRef, dispose: dispose as () => Promise<void> }
    const agentCtx = {
      systemPrompt: {
        context: vi.fn((context: Record<string, unknown>) => {
          promptContexts.push(context)
          return () => undefined
        }),
      },
    }
    await createOptions.setup?.(agentCtx as never, agentRef)
    agents.push({
      sessionId,
      agent: agentRef,
      idle,
      followup,
      followupSignal,
      whenIdle: agentRef.whenIdle as unknown as ReturnType<typeof vi.fn>,
      cancel,
      dispose,
      cancelCauses,
      promptContexts,
    })
    signalAgent()
    return handle
  })

  const organizerDeps: KnowledgeOrganizerDeps = {
    profileDir,
    dshHome,
    host,
    scheduler,
    sessionRoots,
    sessionToolAllow,
    sessionModels,
    attachments,
    createAgent: createAgentMock as unknown as (options: CreateAgentOptions) => Promise<AgentHandle>,
    releaseSlot: (sessionId: string) => {
      releaseAndDrain(runtimeCtx, routeCtx, sessionId)
    },
    now: options.now ?? (() => Date.now()),
    timeoutMs: () => options.timeoutMs ?? 600_000,
  }
  const organizer = createKnowledgeOrganizer(organizerDeps)
  // 接线前换成 spy:subscribe/notifyPending 记录的是方法引用,晚安装的 spy 看不到调用。
  const noteSystemResumeSpy = vi.spyOn(organizer, 'noteSystemResume')
  const scheduleEvaluateSpy = vi.spyOn(organizer, 'scheduleEvaluate')
  const recordOrganizeFailureSpy: unknown = vi.spyOn(host, 'recordOrganizeFailure')

  const notifyCalls: NotifyCall[] = []
  const unregisterKnowledgeHost = setKnowledgeHost(host)
  const unregisterKnowledgeIds = setRegisteredKnowledgeBaseIdsProvider(
    () => host.getRegisteredKnowledgeBaseIds(),
  )
  const unsubscribeOrganizerResume = host.onSystemResume(organizer.noteSystemResume)
  const notifyPending = vi.fn((kbId: string): void => {
    notifyCalls.push({ kbId, candidates: host.listOrganizeCandidates().map(record => record.id) })
    void organizer.scheduleEvaluate().catch(() => undefined)
  })
  host.setOrganizerHooks({
    cancelForKb: kbId => organizer.cancelForKb(kbId, 'maintenance'),
    cancelAll: () => organizer.cancelAll(),
    notifyPending,
  })
  setReevaluateKbOrganize(() => {
    void organizer.scheduleEvaluate().catch(() => undefined)
  })

  const disposeTools = registerKnowledgeOrgTools({
    tools: {
      register(definition: unknown): () => void {
        const tool = definition as ToolDefinition
        registeredTools.set(tool.name, tool)
        return () => {
          registeredTools.delete(tool.name)
        }
      },
    },
    huaanworkProfileDir: profileDir,
  })

  const register = options.register ?? 'api'
  let kbId = ''
  let resolvedSourceDir = sourceDir
  if (register === 'file') {
    kbId = randomUUID()
    const record: KnowledgeBaseRecord = {
      id: kbId,
      name: '预置库',
      sourceDir,
      autoOrganize: options.autoOrganize ?? true,
      watchPaused: false,
      createdAt: '2026-11-28T00:00:00.000Z',
    }
    writeFileSync(
      join(profileDir, 'knowledge-bases.json'),
      `${JSON.stringify({ knowledgeBases: [record] }, null, 2)}\n`,
    )
  }

  await host.start()
  if (register === 'api') {
    const record = await host.create({
      name: '集成库',
      sourceDir,
      autoOrganize: options.autoOrganize ?? true,
    })
    kbId = record.id
    resolvedSourceDir = record.sourceDir
  }

  const harness: Harness = {
    root,
    profileDir,
    dshHome,
    sourceDir: resolvedSourceDir,
    kbId,
    wikiRoot: kbId === '' ? '' : neutralKnowledgeWikiRootPath(profileDir, kbId),
    host,
    organizer,
    scheduler,
    storage,
    runtimeCtx,
    routeCtx,
    sessionRoots,
    sessionToolAllow,
    sessionModels,
    attachments,
    createAgent: createAgentMock as unknown as ReturnType<typeof vi.fn>,
    agents,
    notifyCalls,
    noteSystemResumeSpy: noteSystemResumeSpy as unknown as { mockClear(): void },
    scheduleEvaluateSpy: scheduleEvaluateSpy as unknown as { mockClear(): void },
    watchers,
    recordOrganizeFailureSpy,
    unregisterKnowledgeHost,
    unregisterKnowledgeIds,
    unsubscribeOrganizerResume,
    disposeTools,
    clearNotifies(): void {
      notifyCalls.length = 0
    },
    async waitForAgent(target: number): Promise<void> {
      while (agents.length < target) await nextAgentSignal()
    },
    async waitForPhase(phase: string): Promise<void> {
      await vi.waitFor(
        () => expect(host.get(kbId)?.phase).toBe(phase),
        { timeout: 15_000 },
      )
    },
    async addKb(name: string, extraFiles: readonly FixtureFile[]) {
      const extraSourceDir = join(root, `source-${randomUUID().slice(0, 8)}`)
      mkdirSync(extraSourceDir, { recursive: true })
      for (const file of extraFiles) writeFileSync(join(extraSourceDir, file.relPath), file.content)
      const record = await host.create({ name, sourceDir: extraSourceDir, autoOrganize: true })
      return {
        kbId: record.id,
        sourceDir: record.sourceDir,
        wikiRoot: neutralKnowledgeWikiRootPath(profileDir, record.id),
      }
    },
  }
  activeHarnesses.push(harness)
  return harness
}

/** 以 `host.sync` 作为运行时串行链屏障:它排队在启动对账之后,返回即两者都完成。 */
async function syncAsBarrier(harness: Harness): Promise<void> {
  await harness.host.sync(harness.kbId)
}

// ---------------------------------------------------------------------------
// 1. 主链路:阶段 1 自动触发阶段 2,工具写卡并推进 organized_sha256
// ---------------------------------------------------------------------------

describe('stage-1 commit automatically schedules stage-2 organize', () => {
  it('creates wiki/ before the agent, writes docs cards, and advances organized_sha256', async () => {
    const createChecks: Array<{
      readonly allow: ReturnType<typeof preExecuteExplained>
      readonly deny: ReturnType<typeof preExecuteExplained>
      readonly wikiRoot: string
      readonly controlRoot: string
    }> = []
    const harness = await createHarness({
      files: DEFAULT_FILES,
      onCreate: (info) => {
        const docId = info.batch.docs[0]?.docId
        expect(docId).toBeTypeOf('string')
        const allow = preExecuteExplained({
          name: 'write',
          args: { file_path: `docs/${String(docId)}.md` },
          workspaceRoot: info.wikiRoot,
        }, 'ask')
        // 对照:未创建 wiki/ 的库根必须 deny,证明 allow 来自 organizer 的 mkdir。
        const controlRoot = neutralKnowledgeWikiRootPath(info.profileDir, 'control-kb-without-wiki')
        expect(existsSync(controlRoot)).toBe(false)
        const deny = preExecuteExplained({
          name: 'write',
          args: { file_path: `docs/${String(docId)}.md` },
          workspaceRoot: controlRoot,
        }, 'ask')
        createChecks.push({ allow, deny, wikiRoot: info.wikiRoot, controlRoot })
      },
    })
    try {
      await harness.waitForAgent(1)
      await harness.waitForPhase('watching')

      const alpha = harness.agents[0]
      expect(alpha).toBeDefined()
      expect(alpha?.followup).toHaveBeenCalledTimes(1)
      expect(alpha?.whenIdle).toHaveBeenCalledTimes(1)
      expect(alpha?.dispose).toHaveBeenCalledTimes(1)
      expect(harness.createAgent).toHaveBeenCalledTimes(1)
      expect(harness.notifyCalls.length).toBeGreaterThanOrEqual(1)
      expect(alpha?.promptContexts[0]).toMatchObject({
        name: 'huaanwork:kb-organizer',
        order: 40,
        required: true,
        interpolate: false,
      })

      const docs = (await harness.host.listDocs(harness.kbId)).docs
      expect(docs.map(doc => doc.relPath).sort()).toEqual(['alpha.md', 'beta.md'])
      for (const doc of docs) {
        expect(doc.organizedSha256).toBe(doc.sha256)
        expect(doc.wikiNotePath).toBe(`docs/${doc.docId}.md`)
        expect(doc.organizeAttempts).toBe(0)
        const cardPath = join(harness.wikiRoot, 'docs', `${doc.docId}.md`)
        expect(existsSync(cardPath)).toBe(true)
        expect(readFileSync(cardPath, 'utf8')).toContain('整理卡片')
      }

      const kinds = (await harness.host.getEvents(harness.kbId)).map(event => event.kind)
      expect(kinds).toContain('organize_started')
      expect(kinds).toContain('organize_completed')

      expect(harness.sessionRoots.size).toBe(0)
      expect(harness.sessionToolAllow.size).toBe(0)
      expect(harness.sessionModels.size).toBe(0)

      // G-I1 判别性对照:真实 preExecuteExplained 的 allow/deny 结论。
      expect(createChecks).toHaveLength(1)
      expect(createChecks[0]?.allow).toEqual({ decision: 'allow' })
      expect(createChecks[0]?.deny).toEqual({ decision: 'deny', reason: REASON_PATH_ESCAPE })
      expect(harness.wikiRoot).toBe(createChecks[0]?.wikiRoot)
      expect(existsSync(createChecks[0]?.controlRoot ?? '')).toBe(false)
    } finally {
      await harness.host.dispose()
    }
  }, 30_000)
})

// ---------------------------------------------------------------------------
// 2. 六种 trigger 共用 onIndexCommitted;失败与 epoch 失效不调用
// ---------------------------------------------------------------------------

describe('onIndexCommitted is the single stage-1 commit seam', () => {
  it('notifies after a startup reconcile', async () => {
    const harness = await createHarness({ register: 'file', autoOrganize: false })
    await vi.waitFor(() => expect(harness.notifyCalls.length).toBe(1), { timeout: 15_000 })
    expect(harness.notifyCalls[0]?.kbId).toBe(harness.kbId)
    expect(harness.createAgent).not.toHaveBeenCalled()
  }, 20_000)

  it('notifies after a manual sync', async () => {
    const harness = await createHarness({ autoOrganize: false })
    await syncAsBarrier(harness)
    harness.clearNotifies()
    await harness.host.sync(harness.kbId)
    expect(harness.notifyCalls.length).toBeGreaterThanOrEqual(1)
    expect(harness.notifyCalls.every(call => call.kbId === harness.kbId)).toBe(true)
    expect(harness.createAgent).not.toHaveBeenCalled()
  }, 20_000)

  it('notifies after a system-resume reconcile', async () => {
    const harness = await createHarness({ autoOrganize: false })
    await syncAsBarrier(harness)
    harness.clearNotifies()
    await harness.host.handleSystemResume()
    expect(harness.notifyCalls.length).toBeGreaterThanOrEqual(1)
    expect(harness.notifyCalls.some(call => call.kbId === harness.kbId)).toBe(true)
  }, 20_000)

  it('notifies after a debounce reconcile', async () => {
    const harness = await createHarness({ autoOrganize: false, debounceMs: 10, writeStableMs: 0 })
    await syncAsBarrier(harness)
    harness.clearNotifies()
    const watcher = harness.watchers[0]
    expect(watcher).toBeDefined()
    writeFileSync(join(harness.sourceDir, 'beta.md'), '# Beta\n\n第二次写入。\n')
    watcher?.emitChange('beta.md')
    await vi.waitFor(() => expect(harness.notifyCalls.length).toBeGreaterThanOrEqual(1), {
      timeout: 15_000,
    })
    expect(harness.notifyCalls.some(call => call.kbId === harness.kbId)).toBe(true)
  }, 20_000)

  it('notifies after a periodic reconcile', async () => {
    const harness = await createHarness({ autoOrganize: false, reconcileIntervalMs: 40 })
    await syncAsBarrier(harness)
    harness.clearNotifies()
    await vi.waitFor(() => expect(harness.notifyCalls.length).toBeGreaterThanOrEqual(1), {
      timeout: 15_000,
    })
    expect(harness.notifyCalls.some(call => call.kbId === harness.kbId)).toBe(true)
  }, 20_000)

  it('notifies after a rebind reconcile while the KB is still under maintenance', async () => {
    const harness = await createHarness({ autoOrganize: false })
    await syncAsBarrier(harness)
    harness.clearNotifies()
    const nextSourceDir = join(harness.root, 'rebound-source')
    mkdirSync(nextSourceDir, { recursive: true })
    writeFileSync(join(nextSourceDir, 'gamma.md'), '# Gamma\n\n重绑后的新文件。\n')
    await harness.host.update(harness.kbId, { sourceDir: nextSourceDir })
    expect(
      harness.notifyCalls.some(call => call.kbId === harness.kbId && !call.candidates.includes(harness.kbId)),
    ).toBe(true)
  }, 20_000)

  it('does not notify on a failed reconcile, then notifies again after recovery', async () => {
    let failListDocs = false
    const harness = await createHarness({
      autoOrganize: false,
      storageOverride: real => ({
        listDocs: async (kbId, filter) => {
          if (failListDocs) {
            failListDocs = false
            throw new Error('index boom')
          }
          return real.listDocs(kbId, filter)
        },
      }),
    })
    await syncAsBarrier(harness)
    harness.clearNotifies()
    failListDocs = true
    await expect(harness.host.sync(harness.kbId)).rejects.toThrow(/index-error/)
    expect(harness.notifyCalls).toHaveLength(0)
    expect(harness.host.get(harness.kbId)?.phase).toBe('index-error')
    // 恢复路径:ensureStorageReady 重新开库后下一次对账真正完成才通知。
    await harness.host.sync(harness.kbId)
    expect(harness.notifyCalls.some(call => call.kbId === harness.kbId)).toBe(true)
    expect(harness.host.get(harness.kbId)?.phase).toBe('watching')
  }, 20_000)

  it('does not notify when a reconcile returns mid-way after its epoch went stale', async () => {
    const state: { host?: KnowledgeHost; arm: boolean; pendingUpdate?: Promise<unknown> } = {
      arm: false,
    }
    const harness = await createHarness({
      autoOrganize: false,
      storageOverride: real => ({
        listDocs: async (kbId, filter) => {
          if (state.arm) {
            state.arm = false
            // pauseWatch 的第一个同步段立即递增 epoch;对账在 listDocs 返回后会中途退出。
            state.pendingUpdate = state.host!.update(kbId, { watchPaused: true })
          }
          return real.listDocs(kbId, filter)
        },
      }),
    })
    state.host = harness.host
    await syncAsBarrier(harness)
    harness.clearNotifies()
    state.arm = true
    await harness.host.sync(harness.kbId)
    await state.pendingUpdate
    await harness.waitForPhase('watch-paused')
    expect(harness.notifyCalls).toHaveLength(0)
    // 恢复监听的 'resume' 对账是六种 trigger 之一,它必须再次到达同一回调。
    await harness.host.update(harness.kbId, { watchPaused: false })
    await vi.waitFor(() => expect(harness.notifyCalls.length).toBeGreaterThanOrEqual(1), {
      timeout: 15_000,
    })
  }, 25_000)

  it('notifyPending schedules a global no-arg evaluation and organizes every candidate KB', async () => {
    const harness = await createHarness({ files: [{ relPath: 'alpha.md', content: '# Alpha\n' }] })
    const second = await harness.addKb('第二库', [{ relPath: 'gamma.md', content: '# Gamma\n' }])
    await vi.waitFor(
      async () => {
        const firstDocs = (await harness.host.listDocs(harness.kbId)).docs
        const secondDocs = (await harness.host.listDocs(second.kbId)).docs
        expect(firstDocs).toHaveLength(1)
        expect(secondDocs).toHaveLength(1)
        expect(firstDocs.map(doc => doc.organizedSha256)).toEqual(firstDocs.map(doc => doc.sha256))
        expect(secondDocs.map(doc => doc.organizedSha256)).toEqual(secondDocs.map(doc => doc.sha256))
      },
      { timeout: 20_000 },
    )
    const scheduleSpy = harness.scheduleEvaluateSpy as unknown as ReturnType<typeof vi.spyOn>
    expect(scheduleSpy).toHaveBeenCalled()
    // 排期必须是无参全局评估,不得收窄成 { manualKbIds: [通知来源 kbId] }。
    for (const call of (scheduleSpy as unknown as { mock: { calls: unknown[] } }).mock.calls) {
      expect(call).toHaveLength(0)
    }
    expect(harness.createAgent).toHaveBeenCalledTimes(2)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// 3. 维护取消:rebuild / remove 以 maintenance 取消并等待在途结算
// ---------------------------------------------------------------------------

describe('maintenance cancels the in-flight organizer batch', () => {
  it('rebuild cancels with maintenance, waits in-flight, and never counts organize_attempts', async () => {
    const harness = await createHarness({ autoOrganize: false, script: stuckScript })
    await syncAsBarrier(harness)
    const manual = harness.organizer.triggerManual(harness.kbId)
    await harness.waitForAgent(1)
    await harness.waitForPhase('organizing')
    const agent = harness.agents[0]
    await agent?.followupSignal.promise
    expect(agent?.followup).toHaveBeenCalledTimes(1)

    await expect(harness.host.rebuild(harness.kbId)).resolves.toBeUndefined()
    await manual
    await harness.organizer.waitForKbSlotIdle(harness.kbId)

    expect(agent?.cancelCauses).toEqual([{ kind: 'hook', reason: 'knowledge-organize-maintenance' }])
    expect(harness.recordOrganizeFailureSpy).not.toHaveBeenCalled()
    expect(agent?.dispose).toHaveBeenCalledTimes(1)
    expect(harness.createAgent).toHaveBeenCalledTimes(1)

    const docs = (await harness.host.listDocs(harness.kbId)).docs
    expect(docs.length).toBeGreaterThan(0)
    for (const doc of docs) expect(doc.organizeAttempts).toBe(0)
    const kinds = (await harness.host.getEvents(harness.kbId)).map(event => event.kind)
    expect(kinds).toContain('organize_cancelled')
    expect(kinds).not.toContain('organize_failed')
  }, 30_000)

  it('remove cancels with maintenance, settles the turn, and deletes the KB without SessionAlreadyExistsError', async () => {
    const harness = await createHarness({ autoOrganize: false, script: stuckScript })
    await syncAsBarrier(harness)
    const manual = harness.organizer.triggerManual(harness.kbId)
    await harness.waitForAgent(1)
    await harness.waitForPhase('organizing')
    const agent = harness.agents[0]
    await agent?.followupSignal.promise
    const kbRoot = neutralKnowledgeRootPath(harness.profileDir, harness.kbId)

    await expect(harness.host.remove(harness.kbId)).resolves.toBeUndefined()
    await manual
    await harness.organizer.waitForKbSlotIdle(harness.kbId)

    expect(agent?.cancelCauses).toEqual([{ kind: 'hook', reason: 'knowledge-organize-maintenance' }])
    expect(harness.recordOrganizeFailureSpy).not.toHaveBeenCalled()
    expect(agent?.dispose).toHaveBeenCalledTimes(1)
    expect(harness.host.get(harness.kbId)).toBeUndefined()
    expect(existsSync(kbRoot)).toBe(false)
    expect(harness.sessionRoots.size).toBe(0)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// 4. 退场:卡死回合必须真正收到 dispose 取消并在 1 秒内落定
// ---------------------------------------------------------------------------

describe('host dispose cancels a stuck organizer turn', () => {
  it('issues the dispose cancel, settles the in-flight turn, and returns within 1s', async () => {
    const harness = await createHarness({ autoOrganize: false, script: stuckScript })
    await syncAsBarrier(harness)
    const manual = harness.organizer.triggerManual(harness.kbId)
    await harness.waitForAgent(1)
    await harness.waitForPhase('organizing')
    const agent = harness.agents[0]
    await agent?.followupSignal.promise
    expect(agent?.followup).toHaveBeenCalledTimes(1)

    const startedAt = performance.now()
    await harness.host.dispose()
    const elapsed = performance.now() - startedAt

    // 只断言耗时不够:dispose 自带 950ms race,没有取消也会「按时」返回。
    expect(agent?.cancelCauses).toEqual([{ kind: 'disposed' }])
    expect(agent?.dispose).toHaveBeenCalledTimes(1)
    await harness.organizer.waitForKbSlotIdle(harness.kbId)
    await manual
    expect(harness.sessionRoots.size).toBe(0)
    expect(harness.sessionToolAllow.size).toBe(0)
    expect(harness.sessionModels.size).toBe(0)
    expect(elapsed).toBeLessThan(1_000)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// 5. 提交后排期:create / 重绑 / rebuild 的成功出口补偿
// ---------------------------------------------------------------------------

describe('post-commit compensation scheduling', () => {
  it('still organizes after create when the startup reconcile completed before the registry commit', async () => {
    const harness = await createHarness({
      autoOrganize: false,
      files: [{ relPath: 'alpha.md', content: '# Alpha\n' }],
    })
    await syncAsBarrier(harness)
    harness.clearNotifies()

    // 用另一个库的注册表写入占住 Host 的 registryChain:新库的 commitRegistryChange
    // 因此排在它后面,mutate 之前新库记录在内存中仍不可见。
    const gate = deferred<void>()
    registryGate.promise = gate.promise
    const updatePromise = harness.host.update(harness.kbId, { name: '重命名占位' })
    const secondSourceDir = join(harness.root, 'second-source')
    mkdirSync(secondSourceDir, { recursive: true })
    for (const file of DEFAULT_FILES) writeFileSync(join(secondSourceDir, file.relPath), file.content)
    const createPromise = harness.host.create({
      name: '门闩库',
      sourceDir: secondSourceDir,
      autoOrganize: true,
    })

    // 新库的启动对账在注册表 commit 之前完成:回调已到达,但记录尚不可见。
    await vi.waitFor(
      () => expect(harness.notifyCalls.some(call => call.kbId !== harness.kbId)).toBe(true),
      { timeout: 15_000 },
    )
    const preCommit = harness.notifyCalls.find(call => call.kbId !== harness.kbId)
    expect(preCommit).toBeDefined()
    expect(harness.host.get(preCommit?.kbId ?? '')).toBeUndefined()
    expect(preCommit?.candidates).not.toContain(preCommit?.kbId)
    expect(harness.createAgent).not.toHaveBeenCalled()

    gate.resolve()
    registryGate.promise = undefined
    await updatePromise
    const record = await createPromise
    expect(record.id).toBe(preCommit?.kbId)

    // create 成功后的补偿通知:提交后候选集已包含本库,并真正整理一次。
    const compensation = harness.notifyCalls.find(
      call => call.kbId === record.id && call.candidates.includes(record.id),
    )
    expect(compensation).toBeDefined()
    await harness.waitForAgent(1)
    await vi.waitFor(
      () => expect(harness.host.get(record.id)?.phase).toBe('watching'),
      { timeout: 15_000 },
    )
    const docs = (await harness.host.listDocs(record.id)).docs
    expect(docs).toHaveLength(2)
    for (const doc of docs) expect(doc.organizedSha256).toBe(doc.sha256)
  }, 30_000)

  it('rebind notifies inside maintenance but really organizes only from the post-unlock compensation', async () => {
    const harness = await createHarness({ files: DEFAULT_FILES })
    await harness.waitForAgent(1)
    await harness.waitForPhase('watching')
    expect(harness.agents).toHaveLength(1)
    harness.clearNotifies()

    const nextSourceDir = join(harness.root, 'rebound-source')
    mkdirSync(nextSourceDir, { recursive: true })
    writeFileSync(join(nextSourceDir, 'gamma.md'), '# Gamma\n\n重绑后的新文件。\n')
    await harness.host.update(harness.kbId, { sourceDir: nextSourceDir })

    const inMaintenanceIndex = harness.notifyCalls.findIndex(
      call => call.kbId === harness.kbId && !call.candidates.includes(harness.kbId),
    )
    const compensationIndex = harness.notifyCalls.findIndex(
      call => call.kbId === harness.kbId && call.candidates.includes(harness.kbId),
    )
    expect(inMaintenanceIndex).toBeGreaterThanOrEqual(0)
    expect(compensationIndex).toBeGreaterThan(inMaintenanceIndex)

    await harness.waitForAgent(2)
    await harness.waitForPhase('watching')
    const docs = (await harness.host.listDocs(harness.kbId)).docs
    expect(docs.map(doc => doc.relPath)).toEqual(['gamma.md'])
    expect(docs[0]?.organizedSha256).toBe(docs[0]?.sha256)
  }, 30_000)

  it('rebuild notifies only after the maintenance lock is released and the KB is a candidate', async () => {
    const harness = await createHarness({ files: DEFAULT_FILES })
    await harness.waitForAgent(1)
    await harness.waitForPhase('watching')
    harness.clearNotifies()

    writeFileSync(join(harness.sourceDir, 'gamma.md'), '# Gamma\n\n重建前新增。\n')
    await harness.host.rebuild(harness.kbId)

    expect(harness.notifyCalls).toHaveLength(1)
    expect(harness.notifyCalls[0]?.kbId).toBe(harness.kbId)
    // spy 执行时维护锁已释放:候选集必须已包含该库。
    expect(harness.notifyCalls[0]?.candidates).toContain(harness.kbId)

    await harness.waitForAgent(2)
    await harness.waitForPhase('watching')
    const docs = (await harness.host.listDocs(harness.kbId)).docs
    expect(docs.map(doc => doc.relPath).sort()).toEqual(['alpha.md', 'beta.md', 'gamma.md'])
    for (const doc of docs) expect(doc.organizedSha256).toBe(doc.sha256)
  }, 30_000)

  it('failed rebuild and wiki-reset-pending never notify', async () => {
    let failCommit = false
    const harness = await createHarness({
      autoOrganize: false,
      storageOverride: real => ({
        commitRebuild: async (...args) => {
          if (failCommit) {
            return { ok: false, code: 'index-error', error: 'rebuild boom' }
          }
          return real.commitRebuild(...args)
        },
      }),
    })
    await syncAsBarrier(harness)
    harness.clearNotifies()

    failCommit = true
    await expect(harness.host.rebuild(harness.kbId)).rejects.toThrow(/index-error/)
    expect(harness.notifyCalls).toHaveLength(0)

    // 提交成功但 Wiki 重置待重试(真实损坏恢复路径的终态):不得触发整理排期。
    const pendingHarness = await createHarness({
      autoOrganize: false,
      storageOverride: () => ({
        commitRebuild: async () => ({ ok: true, corruptRecovery: false, wikiResetPending: true }),
      }),
    })
    await syncAsBarrier(pendingHarness)
    pendingHarness.clearNotifies()
    await expect(pendingHarness.host.rebuild(pendingHarness.kbId)).resolves.toBeUndefined()
    expect(pendingHarness.host.get(pendingHarness.kbId)?.phase).toBe('wiki-reset-pending')
    expect(pendingHarness.notifyCalls).toHaveLength(0)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// 6. 生产相位、看门狗心跳与 resume 订阅
// ---------------------------------------------------------------------------

type StreamChunk = { type?: string; text?: string; block?: { type?: string; text?: string } }
type StreamWrap = (options: unknown, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>

interface BridgeHarness {
  readonly listeners: Record<string, Array<(...args: never[]) => unknown>>
  readonly emitted: Array<{ event?: string }>
}

function createBridgeCtx(): BridgeHarness {
  const listeners: Record<string, Array<(...args: never[]) => unknown>> = {}
  const emitted: Array<{ event?: string }> = []
  const ctx = {
    huaanworkWorkspaceRoot: { current: makeRoot('kb-org-integration-bridge-') },
    huaanworkEmit(event: { event?: string }) {
      emitted.push(event)
    },
    on(event: string, listener: (...args: never[]) => unknown) {
      ;(listeners[event] ??= []).push(listener)
    },
  }
  applyBridge(ctx as never)
  return { listeners, emitted }
}

async function emitBridgeToken(bridge: BridgeHarness, sessionId: string): Promise<void> {
  const wrap = bridge.listeners['llm/stream']?.[0] as unknown as StreamWrap | undefined
  if (wrap === undefined) throw new Error('bridge llm/stream listener is missing')
  async function* stream(): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', text: '心跳' }
  }
  const received: StreamChunk[] = []
  for await (const chunk of wrap({ sessionId }, stream)) received.push(chunk)
  expect(received).toHaveLength(1)
}

describe('production phase and watchdog wiring', () => {
  it('observes waiting-turn-slot, organizing and blocked phases through the real host, then recovers', async () => {
    // 每个批次一个闸门:第 1 批(基线)已放行,第 2 批停在 organizing 供观察。
    const gates: Array<Deferred<void>> = []
    const openGate = (): Deferred<void> => {
      const gate = deferred<void>()
      gates.push(gate)
      return gate
    }
    const baselineGate = openGate()
    baselineGate.resolve()
    const harness = await createHarness({
      autoOrganize: true,
      files: DEFAULT_FILES,
      script: async (context) => {
        await performBatch(context)
        const gate = gates.shift()
        if (gate !== undefined) await gate.promise
        context.idle.resolve()
      },
    })
    await harness.waitForAgent(1)
    await harness.waitForPhase('watching')
    harness.clearNotifies()

    // 名额被用户回合占满:准入 skip,相位停在 waiting-turn-slot。
    const userTurn = harness.scheduler.admitUserTurn({
      sessionId: 'user-turn-1',
      tabId: 'tab-1',
      text: '占用唯一名额',
      modelId: 'm1',
      root: join(harness.root, 'user-workspace'),
    })
    expect(userTurn.kind).toBe('start')
    const secondGate = openGate()
    writeFileSync(join(harness.sourceDir, 'gamma.md'), '# Gamma\n\n新增待整理。\n')
    await harness.host.sync(harness.kbId)
    await harness.waitForPhase('waiting-turn-slot')

    // 用户回合结束走生产的 releaseAndDrain → drainUserQueue → reevaluateKbOrganize。
    releaseAndDrain(harness.runtimeCtx, harness.routeCtx, 'user-turn-1')
    await harness.waitForPhase('organizing')
    await harness.waitForAgent(2)
    secondGate.resolve()
    await harness.waitForPhase('watching')

    // blocked-no-model:预检失败不创建 Agent,phase 由 Host list 如实投影。
    writeSettings(harness.profileDir, NO_MODEL_SETTINGS)
    writeFileSync(join(harness.sourceDir, 'delta.md'), '# Delta\n\n新增待整理。\n')
    await harness.host.sync(harness.kbId)
    await harness.waitForPhase('blocked-no-model')
    expect(harness.agents).toHaveLength(2)

    // blocked-network:公网端点被 allow_network 门禁拒绝。
    writeSettings(harness.profileDir, PUBLIC_ENDPOINT_SETTINGS)
    await harness.host.sync(harness.kbId)
    await harness.waitForPhase('blocked-network')
    expect(harness.agents).toHaveLength(2)

    // 修回合法模型后,下一次对账通知清除 blocked 相位并真正整理。
    const recoveryGate = openGate()
    recoveryGate.resolve()
    writeSettings(harness.profileDir, DEFAULT_SETTINGS)
    await harness.host.sync(harness.kbId)
    await harness.waitForAgent(3)
    await harness.waitForPhase('watching')
    const docs = (await harness.host.listDocs(harness.kbId)).docs
    expect(docs.every(doc => doc.organizedSha256 === doc.sha256)).toBe(true)
  }, 40_000)

  it('keeps a stuck organizer turn alive while bridge heartbeats arrive, then times out without UI events', async () => {
    const clock = { now: 1_000_000 }
    const timeoutMs = 1_000
    const harness = await createHarness({
      autoOrganize: false,
      script: stuckScript,
      timeoutMs,
      now: () => clock.now,
    })
    await syncAsBarrier(harness)
    harness.clearNotifies()
    const bridge = createBridgeCtx()
    const sessionId = kbOrganizeSessionId(harness.kbId)

    vi.useFakeTimers()
    try {
      void harness.organizer.triggerManual(harness.kbId)
      await harness.waitForAgent(1)
      expect(harness.host.get(harness.kbId)?.phase).toBe('organizing')
      const agent = harness.agents[0]
      // 等 followup 真正发出(仍是 promise,不依赖 fake 定时器),再看门狗从此刻起算。
      await agent?.followupSignal.promise
      expect(agent?.followup).toHaveBeenCalledTimes(1)

      // 每 600ms 一次 bridge 心跳,累计远超 timeout,但回合不得被取消。
      for (let round = 0; round < 4; round += 1) {
        clock.now += 600
        await vi.advanceTimersByTimeAsync(600)
        await emitBridgeToken(bridge, sessionId)
      }
      expect(agent?.cancel).not.toHaveBeenCalled()
      expect(agent?.followup).toHaveBeenCalledTimes(1)
      expect(bridge.emitted).toEqual([])

      // 无活动地越过 timeout:看门狗必须真的发出 idle-timeout 取消(对照上面的存活断言)。
      clock.now += timeoutMs
      await vi.advanceTimersByTimeAsync(timeoutMs)
      await vi.advanceTimersByTimeAsync(0)
      expect(agent?.cancelCauses).toEqual([
        { kind: 'hook', reason: 'knowledge-organize-idle-timeout' },
      ])
      expect(bridge.emitted).toEqual([])
    } finally {
      vi.useRealTimers()
    }
    await harness.waitForPhase('watching')
  }, 40_000)

  it('wires organizer.noteSystemResume to host resume and stops after unsubscribe', async () => {
    const harness = await createHarness({ autoOrganize: false })
    await syncAsBarrier(harness)
    harness.noteSystemResumeSpy.mockClear()

    await harness.host.handleSystemResume()
    expect(harness.noteSystemResumeSpy).toHaveBeenCalledTimes(1)

    harness.unsubscribeOrganizerResume()
    await harness.host.handleSystemResume()
    expect(harness.noteSystemResumeSpy).toHaveBeenCalledTimes(1)
  }, 20_000)
})

// ---------------------------------------------------------------------------
// 7. index.ts 生产接线:getKnowledgeHost / provider / 退场顺序
// ---------------------------------------------------------------------------

describe('index.ts knowledge effect wiring', () => {
  it('registers the host and live registry-id provider, and clears both before disposing the host', async () => {
    const root = makeRoot('kb-org-integration-boot-')
    const config = hostConfig(root)
    const bootSourceDir = join(root, 'source')
    mkdirSync(bootSourceDir, { recursive: true })
    writeFileSync(join(bootSourceDir, 'alpha.md'), '# Alpha\n\n启动接线。\n')
    // 未写 huaanwork-settings.json ⇒ 默认模型为空 ⇒ blocked-no-model,不触碰真实 agents.create。
    const booted = await bootHuaanworkHost(config)
    try {
      const host = getKnowledgeHost()
      expect(host).toBeDefined()
      const record = await host!.create({ name: '接线库', sourceDir: bootSourceDir })
      expect(getKnowledgeHost()).toBe(host)
      // provider 是实时 getter:create 成功后下一次读取立即反映。
      expect(registeredKnowledgeBaseIds().has(record.id)).toBe(true)
      await vi.waitFor(
        () => expect(host!.get(record.id)?.phase).toBe('blocked-no-model'),
        { timeout: 15_000 },
      )
      await booted.ctx.fiber.dispose()
      expect(getKnowledgeHost()).toBeUndefined()
      expect(registeredKnowledgeBaseIds().size).toBe(0)
    } finally {
      await booted.ctx.fiber.dispose()
    }
  }, 30_000)

  it('registers the kb_org_* tools and the post-drain organizer re-evaluation in the real apply()', async () => {
    const root = makeRoot('kb-org-integration-apply-wiring-')
    const config = hostConfig(root)
    const bootSourceDir = join(root, 'source')
    mkdirSync(bootSourceDir, { recursive: true })
    writeFileSync(join(bootSourceDir, 'alpha.md'), '# Alpha\n\n接线断言。\n')
    const registered: Array<{ name: string }> = []
    const booted = await bootHuaanworkHost(config)
    // tools 服务后提供:注册子插件随之激活,与生产启动顺序无关(与 agent-tool-wiring 同法)。
    const disposeTools = booted.ctx.provide('tools', {
      register(definition: { name: string }) {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    } as never)
    const waitForTool = async (name: string, present: boolean): Promise<void> => {
      await vi.waitFor(
        () => expect(registered.some(tool => tool.name === name)).toBe(present),
        { timeout: 5_000 },
      )
    }
    try {
      // (a) 生产 apply() 必须把三个整理工具真正注册进 tools 服务。
      for (const name of ['kb_org_get_delta', 'kb_org_read_doc', 'kb_org_mark_organized']) {
        await waitForTool(name, true)
      }

      // (b) 用户队列排空 → setReevaluateKbOrganize → organizer.scheduleEvaluate。
      const host = getKnowledgeHost()
      expect(host).toBeDefined()
      const record = await host!.create({ name: '接线库', sourceDir: bootSourceDir })
      await vi.waitFor(
        () => expect(host!.get(record.id)?.phase).toBe('blocked-no-model'),
        { timeout: 15_000 },
      )
      // 等 create/sync 的自动评估链彻底静默,之后的评估只能来自排空钩子。
      await new Promise(resolve => setTimeout(resolve, 100))
      const candidatesSpy = vi.spyOn(host!, 'listOrganizeCandidates')
      const peekSpy = vi.spyOn(host!, 'peekPendingOrganizeBatch')

      // 队列为空:drainUserQueue 不启动任何用户回合,只走两次重评估。
      drainUserQueue(booted.ctx as unknown as SessionRuntimeContext, {} as RouteContext)

      // 真实 effect 级断言:评估真的跑到了这个库(列候选 + peek 批次)。
      await vi.waitFor(() => expect(candidatesSpy.mock.calls.length).toBeGreaterThan(0))
      await vi.waitFor(() => expect(peekSpy.mock.calls.length).toBeGreaterThan(0))
      expect(peekSpy.mock.calls[0]?.[0]).toBe(record.id)
      // 模型仍缺失:评估停在 blocked-no-model,不创建 Agent、不占名额。
      expect(host!.get(record.id)?.phase).toBe('blocked-no-model')
    } finally {
      await disposeTools()
      await booted.ctx.fiber.dispose()
    }
    // fiber 退场后不留悬挂工具行。
    for (const name of ['kb_org_get_delta', 'kb_org_read_doc', 'kb_org_mark_organized']) {
      expect(registered.some(tool => tool.name === name)).toBe(false)
    }
  }, 30_000)
})
