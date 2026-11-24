import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createAgentPackageActiveTurnRegistry,
  createAgentPackageHost,
  type AgentPackageActiveTurnRecord,
  type AgentPackageActiveTurnRegistry,
  type AgentPackageHost,
} from '../../src/huaanwork-host/agent-package/host.ts'
import {
  createAgentPackageRuntimeRegistry,
  type AgentPackageRuntimeRegistry,
} from '../../src/huaanwork-host/agent-package/runtime.ts'
import type {
  AgentPackageSubagentRequest,
  AgentPackageTurnRuntime,
} from '../../src/huaanwork-host/agent-package/types.ts'
import {
  EXPERT_TEAM_MEMBER_CANCELLED,
  teamMcpServerName,
  type TeamMemberDispatchInput,
  type TeamMemberDispatchResult,
} from '../../src/huaanwork-host/expert-team/dispatch.ts'
import {
  createSubagentRunRegistry,
  type SubagentRunRegistry,
} from '../../src/huaanwork-host/subagent-runs.ts'
import type {
  SubagentActivationHandle,
  SubagentActivationSpec,
} from '../../src/huaanwork-host/subagents-service.ts'
import { emptyAttachments } from '../../src/huaanwork-guardrails/agent-attachments.ts'
import { apply as applyPresentAs } from '../../src/huaanwork-guardrails/present-as.ts'
import { apply as applySkills } from '../../src/huaanwork-guardrails/skills.ts'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
  activeFixture = undefined
})

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

type Schema = { name?: string }
type ToolsService = {
  schemas(): Schema[]
  restrict(filter: { allow: readonly string[] }): () => void
}

const BASE_NAMES = [
  'read',
  'read_file',
  'glob',
  'grep',
  'edit',
  'write',
  'bash',
  'pwsh',
  'skill',
  'subagent',
  'git_push',
  'web_search',
  'call_host_tool',
] as const

/** 相交层 fake（与 package-subagent-lineage.spec.ts 同形）：每层 restrict 独立生效，schemas 为全部活跃层交集。 */
function createComposingTools(names: readonly string[] = BASE_NAMES): ToolsService & { layers: Array<readonly string[]> } {
  const all = names.map((name) => ({ name }))
  const layers: Array<readonly string[]> = []
  return {
    layers,
    schemas(): Schema[] {
      return all.filter((schema) => layers.every((allow) => allow.includes(schema.name as string)))
    },
    restrict({ allow }: { allow: readonly string[] }): () => void {
      layers.push(allow)
      return () => {
        const index = layers.indexOf(allow)
        if (index >= 0) layers.splice(index, 1)
      }
    },
  }
}

type FakeAgent = {
  id: string
  session: { id: string }
  ctx: { get(name: string): ToolsService | undefined }
}

function agentOf(id: string, tools: ToolsService): FakeAgent {
  return { id, session: { id }, ctx: { get: (name) => (name === 'tools' ? tools : undefined) } }
}

type TeamOutputBlock = { type: string; text?: string; data?: string }

/** `SubagentResult.output` 的 fake 载荷；未知块只按 `type` 判别，与 Task 5 渲染协议一致。 */
type FakeSubagentResult = { stopReason: string; output: readonly TeamOutputBlock[] }

type ActivationRecord = {
  delivery: SubagentActivationSpec['delivery']
  spec: SubagentActivationSpec
  parentNotifications: unknown[]
  readonly boundChildren: string[]
  attachedAtStart: Record<string, string[]>
  disposed: boolean
  disposeCalls: number
}

type TeamFixtureOptions = {
  mcp?: boolean
  providerChangesChildId?: boolean
  /** true 时 activation.result 悬置，由 `finishAll` 结算（用于在取消/冲突竞态中观察在途成员）。 */
  holdResult?: boolean
  /** true 时 activation.result 以 rejection 结算（成员结果失败路径）。 */
  rejectResult?: boolean
  output?: readonly TeamOutputBlock[]
  /** true 时 startActivation 挂起，由 `releaseActivation` 放行（取消早于 activation 的竞态）。 */
  holdActivation?: boolean
  /** true 时 activation.dispose 挂起，由 `releaseDispose` 放行（清理确认未落定的竞态）。 */
  holdDispose?: boolean
  /** true 时 activation.dispose 立即拒绝（取消清理失败的故障注入）。 */
  disposeRejects?: boolean
}

type ActivationView = {
  readonly delivery: SubagentActivationSpec['delivery']
  readonly spec: SubagentActivationSpec
  readonly parentNotifications: unknown[]
  readonly boundChildren: string[]
  readonly attachedAtStart: Record<string, string[]>
  readonly disposed: boolean
  readonly disposeCalls: number
}

type TeamFixture = {
  host: AgentPackageHost
  attachments: ReturnType<typeof emptyAttachments>
  activations: Map<string, ActivationRecord>
  requests: Map<string, AgentPackageSubagentRequest>
  runs: SubagentRunRegistry
  activeTurns: AgentPackageActiveTurnRegistry & { readonly registeredCount: number; readonly activeCount: number }
  registry: AgentPackageRuntimeRegistry
  /** 观察 MCP 挂载实际使用的 serverName。 */
  mcpServers: string[]
  teamInput: (
    sessionId: string,
    slug: string,
    remainder: string,
    overrides?: Partial<Omit<TeamMemberDispatchInput, 'ctx' | 'sessionId' | 'pkg' | 'remainder'>>,
  ) => TeamMemberDispatchInput
  /** 结算所有悬置的 activation.result。 */
  finishAll: (blocks?: readonly TeamOutputBlock[]) => void
  /** startActivation 已进入的次数（含挂起中的调用）。 */
  readonly startActivationCalls: number
  /** 放行 `holdActivation` 挂起的 startActivation。 */
  releaseActivation: () => void
  /** 放行 `holdDispose` 挂起的 activation.dispose。 */
  releaseDispose: () => void
  /** 唯一一次派工的 activation 视图（惰性读取；多派工 fixture 不使用）。 */
  readonly activation: ActivationView
}

const TEAM_RUN_ID = 'team-run-1'
const PACKAGE_SLUG = 'alpha'
const DEFAULT_OUTPUT: readonly TeamOutputBlock[] = [{ type: 'text', text: '成员结论' }]

let activeFixture: TeamFixture | undefined

/** 模块级便捷入口：复用最近一次 `makeTeamPackageFixture` 的 ctx/pkg（brief 的 `teamInput(...)` 形态）。 */
function teamInput(
  sessionId: string,
  slug: string,
  remainder: string,
  overrides: Partial<Omit<TeamMemberDispatchInput, 'ctx' | 'sessionId' | 'pkg' | 'remainder'>> = {},
): TeamMemberDispatchInput {
  if (activeFixture === undefined) throw new Error('call makeTeamPackageFixture first')
  return activeFixture.teamInput(sessionId, slug, remainder, overrides)
}

async function dispatchWithOutput(blocks: readonly TeamOutputBlock[]): Promise<TeamMemberDispatchResult> {
  const fixture = await makeTeamPackageFixture({ output: blocks })
  return fixture.host.dispatchTeamMember(fixture.teamInput('parent', PACKAGE_SLUG, 'task'))
}

function installTeamPackage(options: { mcp: boolean }): string {
  const profileDir = makeRoot('expert-team-dispatch-profile-')
  const packageDir = join(profileDir, 'agents', PACKAGE_SLUG)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(
    join(packageDir, 'agent.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        slug: PACKAGE_SLUG,
        displayName: '阿尔法',
        description: '团队执行成员',
        version: '1.0.0',
        draftId: 'draft-team-dispatch',
        createdAt: '2026-11-22T00:00:00.000Z',
        updatedAt: '2026-11-22T00:00:00.000Z',
        persona: 'persona.md',
        skill: null,
        tools: options.mcp
          ? { mode: 'mcp', mcp: { entry: 'tools/mcp/server.mjs' } }
          : { mode: 'none' },
        allowSkills: [],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  writeFileSync(join(packageDir, 'persona.md'), '你是团队成员。', 'utf8')
  if (options.mcp) {
    mkdirSync(join(packageDir, 'tools', 'mcp'), { recursive: true })
    writeFileSync(join(packageDir, 'tools', 'mcp', 'server.mjs'), 'process.exit(0)\n', 'utf8')
  }
  writeFileSync(
    join(profileDir, 'agents-state.json'),
    JSON.stringify({ [`local:${PACKAGE_SLUG}`]: { source: 'local', enabled: true, installedVersion: '1.0.0' } }),
    'utf8',
  )
  return profileDir
}

function createRecordingActiveTurns(): AgentPackageActiveTurnRegistry & {
  readonly registeredCount: number
  readonly activeCount: number
} {
  const inner = createAgentPackageActiveTurnRegistry()
  const live = new Set<AgentPackageActiveTurnRecord>()
  let registeredCount = 0
  return {
    get registeredCount() {
      return registeredCount
    },
    get activeCount() {
      return live.size
    },
    register(record) {
      registeredCount += 1
      live.add(record)
      const off = inner.register(record)
      let done = false
      return () => {
        if (done) return
        done = true
        live.delete(record)
        off()
      }
    },
    cancelBySessionId: (sessionId, reason) => inner.cancelBySessionId(sessionId, reason),
    cancelBySlug: (slug, reason) => inner.cancelBySlug(slug, reason),
    cancelAll: (reason) => inner.cancelAll(reason),
  }
}

async function makeTeamPackageFixture(options: TeamFixtureOptions = {}): Promise<TeamFixture> {
  const profileDir = installTeamPackage({ mcp: options.mcp === true })
  const attachments = emptyAttachments()
  const requests = new Map<string, AgentPackageSubagentRequest>()
  const activations = new Map<string, ActivationRecord>()
  const agentsById = new Map<string, FakeAgent>()
  const mcpServers: string[] = []
  const registeredTools: Array<{ name: string }> = []
  const listeners: Record<string, Array<(...args: never[]) => unknown>> = {}
  const pendingResults = new Set<(value: FakeSubagentResult) => void>()
  let startActivationCalls = 0
  let releaseActivationGate: () => void = () => undefined
  const activationGate = new Promise<void>((resolve) => {
    releaseActivationGate = resolve
  })
  let releaseDisposeGate: () => void = () => undefined
  const disposeGate = new Promise<void>((resolve) => {
    releaseDisposeGate = resolve
  })

  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners[event] ?? []) listener(...(args as never[]))
  }

  const mcpClient = {
    inject: ['tools'],
    apply: async (
      fiber: { tools: { register(tool: { name: string }): () => void } },
      config: { serverName: string },
    ) => {
      mcpServers.push(config.serverName)
      const unregister = fiber.tools.register({ name: `mcp__${config.serverName}__echo` })
      return {
        dispose: async () => {
          unregister()
        },
      }
    },
  }

  const innerRegistry = createAgentPackageRuntimeRegistry()
  const bindHistory = new Map<AgentPackageTurnRuntime, string[]>()
  const registry: AgentPackageRuntimeRegistry = {
    bind(sessionId, runtime) {
      innerRegistry.bind(sessionId, runtime)
      const history = bindHistory.get(runtime) ?? []
      if (!history.includes(sessionId)) history.push(sessionId)
      bindHistory.set(runtime, history)
    },
    get: (sessionId) => innerRegistry.get(sessionId),
    delete: (sessionId) => innerRegistry.delete(sessionId),
  }

  const runs = createSubagentRunRegistry({ activityFlushMs: 0, emit: () => undefined })
  const activeTurns = createRecordingActiveTurns()

  const snapshotAttachments = (): Record<string, string[]> => {
    const snapshot: Record<string, string[]> = {}
    for (const [sessionId, names] of attachments.sessionAgentTools) snapshot[sessionId] = [...names]
    return snapshot
  }

  const createResult = (): Promise<FakeSubagentResult> => {
    if (options.rejectResult === true) {
      return Promise.reject(new Error('成员结果失败'))
    }
    if (options.holdResult !== true) {
      return Promise.resolve({ stopReason: 'completed', output: options.output ?? DEFAULT_OUTPUT })
    }
    return new Promise<FakeSubagentResult>((resolve) => {
      pendingResults.add(resolve)
    })
  }

  const ctx: Record<string, unknown> = {
    get: (name: string) => (name === 'mcpClientImpl' ? mcpClient : undefined),
    huaanworkWorkspaceRoot: { current: join(profileDir, 'workspace') },
    huaanworkAttachments: attachments,
    huaanworkAgentPackageRequest: { current: null },
    huaanworkAgentPackageTeamRequests: requests,
    huaanworkPackageChildSessions: new Set<string>(),
    huaanworkPackageChildAllow: new Map<string, readonly string[]>(),
    huaanworkSubagentRuns: runs,
    skills: { register: () => () => undefined },
    agents: {
      get: (id: string) => agentsById.get(id),
      list: () => [...agentsById.values()],
    },
    tools: {
      presentAs: () => () => undefined,
      schemas: () => registeredTools,
      register: (tool: { name: string }) => {
        registeredTools.push(tool)
        emit('tools/change')
        return () => {
          const index = registeredTools.findIndex((candidate) => candidate.name === tool.name)
          if (index >= 0) registeredTools.splice(index, 1)
          emit('tools/change')
        }
      },
    },
    on(event: string, listener: (...args: never[]) => unknown) {
      ;(listeners[event] ??= []).push(listener)
    },
    subagents: {
      async startActivation(
        spec: SubagentActivationSpec,
      ): Promise<SubagentActivationHandle & { localAgent?: FakeAgent }> {
        startActivationCalls += 1
        if (options.holdActivation === true) await activationGate
        const requestedChildId = typeof spec.childId === 'string' ? spec.childId : `child-${String(activations.size + 1)}`
        const actualChildId =
          options.providerChangesChildId === true ? `actual-${requestedChildId}` : requestedChildId
        const request = requests.get(requestedChildId)
        agentsById.set(actualChildId, agentOf(actualChildId, createComposingTools()))
        const record: ActivationRecord = {
          delivery: spec.delivery,
          spec,
          parentNotifications: [],
          get boundChildren(): string[] {
            return request === undefined ? [] : [...(bindHistory.get(request.runtime) ?? [])]
          },
          attachedAtStart: snapshotAttachments(),
          disposed: false,
          disposeCalls: 0,
        }
        activations.set(request?.runId ?? '', record)
        return {
          childId: actualChildId,
          localAgent: agentsById.get(actualChildId)!,
          result: createResult(),
          dispose: async () => {
            record.disposeCalls += 1
            if (options.holdDispose === true) await disposeGate
            if (options.disposeRejects === true) throw new Error('fake activation dispose failed')
            record.disposed = true
          },
        }
      },
    },
  }

  applyPresentAs(ctx as never)
  applySkills(ctx as never)

  const host = createAgentPackageHost({
    profileDir,
    takenSlugs: () => [],
    registry,
    activeTurns,
    createRuntime: async (start) => {
      // 镜像真实 runtime：只有声明 MCP 的包才走 mountMcp，且 mcpNames 就是 mounted.names。
      const wantsMcp = start.manifest.tools.mode === 'mcp' || start.manifest.tools.mode === 'both'
      const mountedNames =
        start.mountMcp === undefined || !wantsMcp ? undefined : await start.mountMcp(43_210)
      const runtime: AgentPackageTurnRuntime = {
        slug: start.manifest.slug,
        packageDir: start.packageDir,
        workspaceRoot: start.workspaceRoot,
        skillScripts: [],
        runSkillScript: async () => ({ text: '' }),
        ...(mountedNames === undefined ? {} : { mcpNames: [...mountedNames] }),
      }
      return runtime
    },
    stopRuntime: async () => undefined,
  })
  const pkg = await host.findInvocable(PACKAGE_SLUG)
  if (pkg === undefined) throw new Error('fixture package missing')

  const soleActivation = (): ActivationRecord => {
    const records = [...activations.values()]
    if (records.length !== 1) throw new Error(`expected exactly one activation, found ${String(records.length)}`)
    return records[0]!
  }

  const fixture: TeamFixture = {
    host,
    attachments,
    activations,
    requests,
    runs,
    activeTurns,
    registry,
    mcpServers,
    teamInput(sessionId, slug, remainder, overrides = {}) {
      if (slug !== PACKAGE_SLUG) throw new Error(`fixture only installs @${PACKAGE_SLUG}`)
      return {
        ctx: ctx as never,
        sessionId,
        teamRunId: TEAM_RUN_ID,
        pkg,
        remainder,
        resolveParent: async () => ({ session: { id: sessionId } }),
        ...overrides,
      }
    },
    finishAll(blocks = options.output ?? DEFAULT_OUTPUT) {
      for (const resolve of pendingResults) resolve({ stopReason: 'completed', output: blocks })
      pendingResults.clear()
    },
    get startActivationCalls() {
      return startActivationCalls
    },
    releaseActivation: () => releaseActivationGate(),
    releaseDispose: () => releaseDisposeGate(),
    // 惰性视图：解构发生在派工之前，成员值在 activation 创建后才可读。
    activation: {
      get delivery() {
        return soleActivation().delivery
      },
      get spec() {
        return soleActivation().spec
      },
      get parentNotifications() {
        return soleActivation().parentNotifications
      },
      get boundChildren() {
        return soleActivation().boundChildren
      },
      get attachedAtStart() {
        return soleActivation().attachedAtStart
      },
      get disposed() {
        return soleActivation().disposed
      },
      get disposeCalls() {
        return soleActivation().disposeCalls
      },
    },
  }
  activeFixture = fixture
  return fixture
}

const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

async function waitForCondition(condition: () => boolean, label: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`等待超时:${label}`)
    await delay(5)
  }
}

describe('expert team member dispatch', () => {
  it('binds two MCP members only to their reserved child sessions and notifies onRunCreated before result settles', async () => {
    const { host, attachments, activations } = await makeTeamPackageFixture({ mcp: true })
    const seenRunIds: string[] = []
    const [first, second] = await Promise.all([
      host.dispatchTeamMember(teamInput('parent', 'alpha', 'task A', { onRunCreated: ({ runId }) => seenRunIds.push(runId) })),
      host.dispatchTeamMember(teamInput('parent', 'alpha', 'task B', { onRunCreated: ({ runId }) => seenRunIds.push(runId) })),
    ])
    expect(seenRunIds).toEqual(expect.arrayContaining([first.runId, second.runId]))
    expect(first.reservedChildId).not.toBe(second.reservedChildId)
    expect(attachments.sessionAgentTools.has('parent')).toBe(false)
    for (const result of [first, second]) {
      expect(teamMcpServerName('a-very-long-agent-slug-name', result.reservedChildId)).toHaveLength(32)
      expect(activations.get(result.runId)?.delivery).toBe('caller')
      expect(activations.get(result.runId)?.disposed).toBe(true) // 成员结果结算后即时清理，不泄漏 MCP/进程
      // 双 MCP 隔离：挂载名按预留子会话命名，父会话从未成为挂载目标。
      const serverName = teamMcpServerName('alpha', result.reservedChildId)
      expect(activations.get(result.runId)?.attachedAtStart[result.reservedChildId]).toEqual(
        expect.arrayContaining([`mcp__${serverName}__echo`]),
      )
      expect(activations.get(result.runId)?.attachedAtStart).not.toHaveProperty('parent')
      expect(attachments.sessionAgentTools.size).toBe(0)
    }
    expect(new Set(seenRunIds).size).toBe(2)
  })

  it('publishes the member run synchronously and projects the team run id', async () => {
    const fixture = await makeTeamPackageFixture({ holdResult: true })
    const seen: Array<{ runId: string; reservedChildId: string }> = []
    const pending = fixture.host.dispatchTeamMember(
      fixture.teamInput('parent', 'alpha', 'task', { onRunCreated: (info) => seen.push(info) }),
    )
    // `onRunCreated` 必须早于任何 await：调用尚未结算时已经可见。
    expect(seen).toHaveLength(1)
    const created = seen[0]!
    expect(fixture.runs.get(created.runId)?.teamRunId).toBe(TEAM_RUN_ID)
    expect(fixture.runs.get(created.runId)?.phase).toBe('starting')
    expect(fixture.runs.get(created.runId)?.packageVersion).toBe('1.0.0')
    await waitForCondition(() => fixture.activations.size === 1, 'member activation')
    fixture.finishAll()
    const result = await pending
    expect(result.runId).toBe(created.runId)
    expect(result.reservedChildId).toBe(created.reservedChildId)
    expect(fixture.runs.get(created.runId)?.phase).toBe('completed')
  })

  it('rebinds an actual child id without rekeying the request map and cancels on package revoke/update via activeTurns', async () => {
    const { host, requests, activation, activeTurns } = await makeTeamPackageFixture({ providerChangesChildId: true })
    const result = await host.dispatchTeamMember(teamInput('parent', 'alpha', 'task'))
    expect(result.actualChildId).not.toBe(result.reservedChildId)
    expect(requests.has(result.reservedChildId)).toBe(false)
    expect(requests.has(result.actualChildId)).toBe(false)
    expect(activation.boundChildren).toEqual(expect.arrayContaining([result.reservedChildId, result.actualChildId]))
    expect(activeTurns.registeredCount).toBeGreaterThan(0)
  })

  it('aborts an in-flight member through activeTurns when the package is updated', async () => {
    const fixture = await makeTeamPackageFixture({ holdResult: true })
    const pending = fixture.host.dispatchTeamMember(fixture.teamInput('parent', 'alpha', 'task'))
    await waitForCondition(() => fixture.activations.size === 1, 'member activation')
    expect(fixture.activeTurns.activeCount).toBe(1)
    await fixture.activeTurns.cancelBySlug('alpha', 'update')
    await expect(pending).rejects.toThrow(/正在更新/)
    expect(fixture.activation.disposed).toBe(true)
    expect(fixture.activeTurns.activeCount).toBe(0)
    expect(fixture.requests.size).toBe(0)
    expect(fixture.attachments.sessionAgentTools.size).toBe(0)
    expect(fixture.activation.boundChildren.length).toBeGreaterThan(0)
    expect(fixture.activation.boundChildren.every((id) => fixture.registry.get(id) === undefined)).toBe(true)
    expect(fixture.activeTurns.registeredCount).toBe(1)
  })

  it('stops a single in-flight member through subagent.cancel without touching siblings', async () => {
    const fixture = await makeTeamPackageFixture({ holdResult: true })
    const pending = fixture.host.dispatchTeamMember(fixture.teamInput('parent', 'alpha', 'task'))
    await waitForCondition(() => fixture.activations.size === 1, 'member activation')
    const runId = [...fixture.activations.keys()][0]!
    expect((await fixture.runs.requestCancel('parent', runId)).status).toBe('accepted')
    const rejection = await pending.then(
      () => { throw new Error('expected the member dispatch to reject') },
      (error: unknown) => error,
    )
    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toMatch(/回合已取消/)
    // 团队路径的普通取消携带稳定 code：协调器按 code 归类 stopped，不解析文案。
    expect((rejection as Error & { code?: string }).code).toBe(EXPERT_TEAM_MEMBER_CANCELLED)
    expect(fixture.activation.disposed).toBe(true)
    expect(fixture.requests.size).toBe(0)
    expect(fixture.attachments.sessionAgentTools.size).toBe(0)
    expect(fixture.activeTurns.activeCount).toBe(0)
    expect(fixture.runs.get(runId)?.phase).toBe('stopped')
  })

  it('rejects a conflicting live team MCP server name and releases the name after cleanup', async () => {
    const fixture = await makeTeamPackageFixture({ mcp: true, holdResult: true })
    const first = fixture.host.dispatchTeamMember(
      fixture.teamInput('parent', 'alpha', 'task A', { mcpServerName: 'alpha__conflict' }),
    )
    await waitForCondition(() => fixture.mcpServers.length === 1, 'first member MCP mount')
    await expect(
      fixture.host.dispatchTeamMember(
        fixture.teamInput('parent', 'alpha', 'task B', { mcpServerName: 'alpha__conflict' }),
      ),
    ).rejects.toThrow(/expert-team-mcp-server-name-conflict/)
    await waitForCondition(() => fixture.activations.size === 1, 'first member activation')
    fixture.finishAll()
    const completed = await first
    expect(completed.output).toEqual({ ok: true, text: '成员结论' })
    // 释放后同名可再次使用。
    const replayPromise = fixture.host.dispatchTeamMember(
      fixture.teamInput('parent', 'alpha', 'task C', { mcpServerName: 'alpha__conflict' }),
    )
    await waitForCondition(() => fixture.activations.size === 2, 'replay member activation')
    fixture.finishAll()
    const replay = await replayPromise
    expect(replay.output).toEqual({ ok: true, text: '成员结论' })
  })

  it('returns caller text without parent notification or structured output', async () => {
    const { host, activation } = await makeTeamPackageFixture({
      output: [{ type: 'reasoning', text: '分析' }, { type: 'text', text: '成员结论' }],
    })
    const result = await host.dispatchTeamMember(teamInput('parent', 'alpha', 'task'))
    expect(activation.spec).toMatchObject({ delivery: 'caller' })
    expect(activation.spec).not.toHaveProperty('outputSchema')
    expect(result.output).toEqual({ ok: true, text: '成员结论' })
    expect(activation.parentNotifications).toEqual([])
  })

  it('marks empty and unsupported output without changing upstream stopReason', async () => {
    const empty = await dispatchWithOutput([{ type: 'reasoning', text: '仅思考' }])
    expect(empty).toMatchObject({ stopReason: 'completed', output: { ok: false, error: 'empty-output' } })
    const unsupported = await dispatchWithOutput([{ type: 'image', data: 'x' }])
    expect(unsupported).toMatchObject({ stopReason: 'completed', output: { ok: false, error: 'unsupported-output' } })
  })

  it('aborting the external signal never leaks an unhandled rejection when cancel cleanup fails', async () => {
    const fixture = await makeTeamPackageFixture({ holdResult: true, disposeRejects: true })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const controller = new AbortController()
      const pending = fixture.host.dispatchTeamMember(
        fixture.teamInput('parent', 'alpha', 'task', { signal: controller.signal }),
      )
      await waitForCondition(() => fixture.activations.size === 1, 'member activation')
      const runId = [...fixture.activations.keys()][0]!
      // 外部 abort 是协调器唯一的中止路径：清理失败必须以日志收敛，不得成为
      // fail-loud 的 exit(1) 输入。
      controller.abort()
      await expect(pending).rejects.toThrow(/回合已取消/)
      // 给 unhandledRejection 一个完整宏任务窗口再断言。
      await delay(20)
      expect(unhandled).toEqual([])
      expect(fixture.runs.get(runId)?.cleanupWarnings).toEqual([
        { code: 'activation-dispose-failed', severity: 'error' },
      ])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      errorSpy.mockRestore()
    }
  })

  it('retracts a stale cleanup confirmation when a cancelled member activation arrives late', async () => {
    const fixture = await makeTeamPackageFixture({
      holdResult: true,
      holdActivation: true,
      holdDispose: true,
      disposeRejects: true,
    })
    let runId = ''
    const pending = fixture.host.dispatchTeamMember(
      fixture.teamInput('parent', 'alpha', 'task', {
        onRunCreated: (info) => {
          runId = info.runId
        },
      }),
    )
    await waitForCondition(() => fixture.startActivationCalls === 1, 'startActivation entered')
    // 取消发生在 startActivation 仍挂起时：activation 尚未登记，清理确认「零失败」。
    expect((await fixture.runs.requestCancel('parent', runId)).status).toBe('accepted')
    await waitForCondition(() => fixture.runs.get(runId)?.phase === 'stopping', 'member stopping')
    // 等取消清理真正确认完（此时 activation 仍缺席），再放行晚到 activation。
    await delay(20)

    fixture.releaseActivation()
    await waitForCondition(() => fixture.activations.size === 1, 'late activation')
    // 权威结果先结算、dispose 仍挂起：晚到 activation 必须撤回先前的成功确认，
    // 否则执行终结 + 旧确认会拼出伪 stopped。
    fixture.finishAll()
    await delay(20)
    expect(fixture.activations.size).toBe(1)
    expect(fixture.runs.get(runId)?.phase).toBe('stopping')

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      fixture.releaseDispose()
      await expect(pending).rejects.toThrow(/回合已取消/)
    } finally {
      errorSpy.mockRestore()
    }
    const run = fixture.runs.get(runId)!
    expect(run.phase).toBe('stopping')
    expect(run.cleanupWarnings).toEqual([{ code: 'activation-dispose-failed', severity: 'error' }])
  })

  it('reports a rejected member result once without a duplicate failRun', async () => {
    const fixture = await makeTeamPackageFixture({ rejectResult: true })
    const rejectResult = vi.spyOn(fixture.runs, 'rejectResult')
    const failRun = vi.spyOn(fixture.runs, 'failRun')
    let runId = ''
    await expect(
      fixture.host.dispatchTeamMember(
        fixture.teamInput('parent', 'alpha', 'task', {
          onRunCreated: (info) => {
            runId = info.runId
          },
        }),
      ),
    ).rejects.toThrow(/成员结果失败/)
    // 观察者已用 rejectResult 上报：catch 不得再用 failRun 报告同一失败并绕过仲裁。
    expect(rejectResult).toHaveBeenCalledTimes(1)
    expect(failRun).not.toHaveBeenCalled()
    const run = fixture.runs.get(runId)
    expect(run?.phase).toBe('failed')
    expect(run?.stopReason).toBe('error')
    expect(run?.failure).toBe('成员结果失败')
  })
})
