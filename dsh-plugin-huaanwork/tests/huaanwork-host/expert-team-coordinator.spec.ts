import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'

import type {
  ExpertTeamAgentRef,
  ExpertTeamMember,
} from '../../src/client-huaanwork/rpc-types.ts'
import {
  createExpertTeamRunRegistry,
  type ExpertTeamRunRegistry,
} from '../../src/huaanwork-host/expert-team/runs.ts'
import {
  createExpertTeamCoordinator,
  renderExpertTeamDispatchPrompt,
  type ExpertTeamCoordinator,
  type ExpertTeamDispatchInput,
  type ExpertTeamMemberDispatcher,
  type ExpertTeamMemberDispatchRequest,
} from '../../src/huaanwork-host/expert-team/coordinator.ts'
import type { AgentPackageDetail } from '../../src/huaanwork-host/agent-package/types.ts'
import {
  EXPERT_TEAM_MEMBER_CANCELLED,
  type TeamMemberDispatchResult,
} from '../../src/huaanwork-host/expert-team/dispatch.ts'
import type { MemberTextResult } from '../../src/huaanwork-host/expert-team/text-protocol.ts'
import { validTeamInput } from '../fixtures/expert-team/team.ts'

/**
 * 协调器契约测试。
 *
 * 使用真实 `ExpertTeamRunRegistry` 与真实协调器；只把 Task 7 的
 * `dispatchTeamMember` 换成可控 fake。`gate` 证明等待队列真实存在：`waitStarted`
 * 会在同步调用点武装 hold（早于任何派工微任务），让已启动的派工停在 running，
 * 再由 `release`/`releaseAll` 逐个或整体放行；`releaseAll` 同时解除 hold。
 */

const PARENT_SESSION_ID = 's1'
const CLIENT_MESSAGE_ID = 'm1'

type Roster = Array<{ memberId: string; role: 'executor' | 'reviewer' }>

const DEFAULT_ROSTER: Roster = [
  { memberId: 'a', role: 'executor' },
  { memberId: 'b', role: 'executor' },
  { memberId: 'c', role: 'executor' },
  { memberId: 'd', role: 'executor' },
  { memberId: 'executor', role: 'executor' },
  { memberId: 'executor-2', role: 'executor' },
  { memberId: 'reviewer', role: 'reviewer' },
]

const DEFAULT_ROSTER_3: Roster = [
  { memberId: 'executor', role: 'executor' },
  { memberId: 'executor-2', role: 'executor' },
  { memberId: 'reviewer', role: 'reviewer' },
]

type DispatchOverrides = Partial<Omit<ExpertTeamDispatchInput, 'callId' | 'parentSessionId' | 'clientMessageId' | 'memberId'>> & {
  callId?: string
}

/** brief 的 `dispatchInput`：完整输入、可选属性只在显式提供时出现。 */
function dispatchInput(memberId: string, overrides: DispatchOverrides = {}): ExpertTeamDispatchInput {
  const input: ExpertTeamDispatchInput = {
    callId: overrides.callId ?? `call-${memberId}`,
    parentSessionId: PARENT_SESSION_ID,
    clientMessageId: CLIENT_MESSAGE_ID,
    memberId,
    kind: overrides.kind ?? 'execute',
    task: overrides.task ?? 'task',
  }
  if (overrides.inputResultIds !== undefined) input.inputResultIds = [...overrides.inputResultIds]
  if (overrides.supersedesResultId !== undefined) input.supersedesResultId = overrides.supersedesResultId
  return input
}

/** 由多字节 seed 拼出恰好 `target` 个 UTF-8 字节的可打印文本。 */
function utf8TextOfBytes(target: number, seed: string): string {
  if (target < 0) throw new Error('target must be non-negative')
  let text = ''
  let used = 0
  const chars = [...seed]
  let index = 0
  while (chars.length > 0 && used < target) {
    const char = chars[index % chars.length]
    if (char === undefined) break
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > target) break
    text += char
    used += size
    index += 1
  }
  if (used < target) text += 'x'.repeat(target - used)
  return text
}

type GateMemberRun = {
  callId: string
  memberId: string
  slug: string
  role: ExpertTeamMember['role']
  runId: string
  settled: boolean
  resolve(result: TeamMemberDispatchResult): void
  reject(error: unknown): void
}

type CoordinatorFixtureOptions = {
  maxParallel?: 1 | 2 | 3 | 4
  reviewMode?: 'none' | 'unified' | 'per-member'
  maxRevisionRounds?: 0 | 1 | 2
  assignmentMode?: 'by-responsibility' | 'broadcast'
  executionOrder?: 'sequential' | 'parallel' | 'dynamic'
  roster?: Roster
  packagePersonaBytes?: number
  /** 上游剩余子智能体容量不足：fake 在创建 run 前即抛错。 */
  maxActiveSubagentsError?: string
  /** 按 callId 注入启动失败（成员尚未创建 run）。 */
  dispatchErrors?: Record<string, string>
  /** 按 callId 给启动失败附加稳定 `code`（如 `EXPERT_TEAM_MEMBER_CANCELLED`）。 */
  dispatchErrorCodes?: Record<string, string>
  /**
   * 派工结果返回的 `cleanupPromise` 保持悬挂，直到 `gate.releaseCleanup()`：
   * 验证取消/等待清理确实以成员清理确认作为收敛屏障。
   */
  holdMemberCleanup?: boolean
  /** 按 callId 注入非 completed 的 stopReason。 */
  stopReasons?: Record<string, string>
  /** 按 callId 注入成员文本渲染结果。 */
  outputs?: Record<string, MemberTextResult>
  /** 审查成员按顺序返回的结论；缺省一律 revise。 */
  verdicts?: Array<'pass' | 'revise'>
  /** 记录/注入团长回合取消；缺省不提供该能力。 */
  cancelParentTurn?: (parentSessionId: string) => void
}

type CoordinatorFixture = {
  coordinator: ExpertTeamCoordinator
  runs: ExpertTeamRunRegistry
  gate: CoordinatorGate
  activations: Array<{ callId: string; memberId: string; runId: string }>
  exactTaskForBytes(memberId: string, targetTotalBytes: number, seed: string): string
  /** 把成员包标记为已撤销，模拟出队前包实时状态变化。 */
  revoke(slug: string): void
}

type CoordinatorGate = {
  readonly running: number
  readonly maxRunning: number
  readonly startedIds: string[]
  readonly reviewPrompts: string[]
  readonly cancelledRunIds: string[]
  waitStarted(count: number): Promise<void>
  release(count: number): void
  releaseAll(): void
  holdCleanup(): void
  releaseCleanup(): void
  cancelMember(runId: string): void
}

function cancellationError(): Error {
  const error = new Error('member run cancelled')
  error.name = 'AbortError'
  return error
}

function packageDetail(slug: string, persona: string): AgentPackageDetail {
  return {
    slug,
    displayName: `成员-${slug}`,
    description: `团队测试成员 ${slug}`,
    version: '1.0.0',
    source: 'local',
    enabled: true,
    persona,
    skill: null,
    tools: 'none',
    files: [],
  }
}

async function makeCoordinatorFixture(options: CoordinatorFixtureOptions = {}): Promise<CoordinatorFixture> {
  const roster = options.roster ?? DEFAULT_ROSTER
  const members: ExpertTeamMember[] = roster.map(({ memberId, role }) => {
    const member: ExpertTeamMember = {
      memberId,
      agentRef: { source: 'local', slug: `pkg-${memberId}` },
      role,
      responsibility: `职责-${memberId}`,
    }
    // 执行成员带输出要求，让 256 KiB 固定开销包含该段；审查成员不写可选键。
    if (role === 'executor') member.outputInstructions = `输出-${memberId}`
    return member
  })
  const team = validTeamInput({
    members,
    orchestration: {
      assignmentMode: options.assignmentMode ?? 'by-responsibility',
      executionOrder: options.executionOrder ?? 'parallel',
      maxParallel: options.maxParallel ?? 2,
    },
    review: {
      mode: options.reviewMode ?? 'unified',
      maxRevisionRounds: options.maxRevisionRounds ?? 1,
    },
    summary: { delivery: 'message', artifactFormat: 'markdown', mode: 'integrated' },
  })

  const runs = createExpertTeamRunRegistry({ emit: () => undefined })
  const persona = '人'.repeat(options.packagePersonaBytes ?? 0)
  const revoked = new Set<string>()
  const activations: Array<{ callId: string; memberId: string; runId: string }> = []
  const verdicts = [...(options.verdicts ?? [])]

  let hold = false
  let running = 0
  let maxRunning = 0
  const startedIds: string[] = []
  const reviewPrompts: string[] = []
  const cancelledRunIds: string[] = []
  const held: GateMemberRun[] = []
  const runsById = new Map<string, GateMemberRun>()
  const waiters: Array<{ count: number; resolve: () => void }> = []
  let cleanupGate: Promise<void> | undefined
  let releaseCleanupGate: (() => void) | undefined

  /** 共享的清理闸：既推迟取消 rejection，也可作为派工返回的 `cleanupPromise`。 */
  function holdCleanupGate(): Promise<void> {
    if (cleanupGate === undefined) {
      cleanupGate = new Promise<void>((resolve) => { releaseCleanupGate = resolve })
    }
    return cleanupGate
  }

  function settleCompleted(entry: GateMemberRun): void {
    if (entry.settled) return
    entry.settled = true
    running = Math.max(0, running - 1)
    const index = held.indexOf(entry)
    if (index >= 0) held.splice(index, 1)
    const verdict = entry.role === 'reviewer' ? (verdicts.shift() ?? 'revise') : undefined
    const override = options.outputs?.[entry.callId]
    const output: MemberTextResult =
      override ??
      (verdict === undefined
        ? { ok: true, text: '成员结论' }
        : { ok: true, text: `审查完成\n\n[VERDICT: ${verdict === 'pass' ? 'PASS' : 'REVISE'}]` })
    entry.resolve({
      runId: entry.runId,
      reservedChildId: entry.runId as SessionId,
      actualChildId: entry.runId as SessionId,
      stopReason: options.stopReasons?.[entry.callId] ?? 'completed',
      output,
      // 默认即时清理；`holdMemberCleanup` 让清理确认晚于派工结算，验证协调器等待循环。
      cleanupPromise: options.holdMemberCleanup === true ? holdCleanupGate() : Promise.resolve(),
    })
  }

  function settleCancelled(entry: GateMemberRun, error: unknown = cancellationError()): void {
    if (entry.settled) return
    const finish = (): void => {
      entry.settled = true
      running = Math.max(0, running - 1)
      const index = held.indexOf(entry)
      if (index >= 0) held.splice(index, 1)
      entry.reject(error)
    }
    if (cleanupGate !== undefined) void cleanupGate.then(finish)
    else finish()
  }

  const dispatchMember: ExpertTeamMemberDispatcher = (request: ExpertTeamMemberDispatchRequest) => {
    if (options.maxActiveSubagentsError !== undefined) {
      throw new Error(options.maxActiveSubagentsError)
    }
    const dispatchError = options.dispatchErrors?.[request.callId]
    if (dispatchError !== undefined) {
      const error = new Error(dispatchError) as Error & { code?: string }
      const code = options.dispatchErrorCodes?.[request.callId]
      if (code !== undefined) error.code = code
      throw error
    }
    const runId = `member-run-${activations.length + 1}`
    activations.push({ callId: request.callId, memberId: request.member.memberId, runId })
    request.onRunCreated({ runId })
    running += 1
    maxRunning = Math.max(maxRunning, running)
    startedIds.push(runId)
    if (request.member.role === 'reviewer') reviewPrompts.push(request.prompt)
    maybeResolveWaiters()
    return new Promise<TeamMemberDispatchResult>((resolve, reject) => {
      const entry: GateMemberRun = {
        callId: request.callId,
        memberId: request.member.memberId,
        slug: request.member.agentRef.slug,
        role: request.member.role,
        runId,
        settled: false,
        resolve,
        reject,
      }
      runsById.set(runId, entry)
      request.signal.addEventListener('abort', () => { settleCancelled(entry) }, { once: true })
      if (hold) held.push(entry)
      else queueMicrotask(() => { settleCompleted(entry) })
    })
  }

  const coordinator = createExpertTeamCoordinator({
    runs,
    resolveMemberPackage(ref: ExpertTeamAgentRef) {
      const pkg = packageDetail(ref.slug, persona)
      if (!revoked.has(ref.slug)) return pkg
      return {
        ...pkg,
        revoked: { slug: ref.slug, version: pkg.version, reason: '管理员撤销', revokedAt: '2026-11-22T00:00:00.000Z' },
      }
    },
    dispatchMember,
    requestMemberCancel(_parentSessionId, memberRunId) {
      cancelledRunIds.push(memberRunId)
      const entry = runsById.get(memberRunId)
      if (entry !== undefined) settleCancelled(entry)
      return Promise.resolve()
    },
    ...(options.cancelParentTurn === undefined ? {} : { cancelParentTurn: options.cancelParentTurn }),
  })

  coordinator.begin({
    parentSessionId: PARENT_SESSION_ID,
    clientMessageId: CLIENT_MESSAGE_ID,
    teamSnapshot: team,
  })

  function maybeResolveWaiters(): void {
    for (const waiter of [...waiters]) {
      if (running < waiter.count) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  }

  const gate: CoordinatorGate = {
    get running() {
      return running
    },
    get maxRunning() {
      return maxRunning
    },
    startedIds,
    reviewPrompts,
    cancelledRunIds,
    waitStarted(count) {
      hold = true
      return new Promise<void>((resolve) => {
        waiters.push({ count, resolve })
        maybeResolveWaiters()
      })
    },
    release(count) {
      for (let index = 0; index < count; index += 1) {
        const entry = held.shift()
        if (entry === undefined) return
        settleCompleted(entry)
      }
      maybeResolveWaiters()
    },
    releaseAll() {
      hold = false
      for (const entry of [...held]) settleCompleted(entry)
      maybeResolveWaiters()
    },
    holdCleanup() {
      void holdCleanupGate()
    },
    releaseCleanup() {
      releaseCleanupGate?.()
      releaseCleanupGate = undefined
    },
    cancelMember(runId) {
      const entry = runsById.get(runId)
      // 与旧版 Task 7 `cancelError()` 同形：普通 Error、无稳定 code，走文案兜底。
      if (entry !== undefined) settleCancelled(entry, new Error(`智能体「${entry.slug}」的回合已取消`))
    },
  }

  function exactTaskForBytes(memberId: string, targetTotalBytes: number, seed: string): string {
    const run = runs.byTurn(PARENT_SESSION_ID, CLIENT_MESSAGE_ID)
    if (run === undefined) throw new Error('team run missing')
    const member = run.teamSnapshot.members.find((item) => item.memberId === memberId)
    if (member === undefined) throw new Error(`member missing: ${memberId}`)
    const overhead = Buffer.byteLength(
      renderExpertTeamDispatchPrompt({ member, kind: 'execute', task: '', references: [] }),
      'utf8',
    )
    const task = utf8TextOfBytes(targetTotalBytes - overhead, seed)
    const rendered = renderExpertTeamDispatchPrompt({ member, kind: 'execute', task, references: [] })
    if (Buffer.byteLength(rendered, 'utf8') !== targetTotalBytes) {
      throw new Error(`exact task fixture mismatch: ${String(Buffer.byteLength(rendered, 'utf8'))}`)
    }
    return task
  }

  return {
    coordinator,
    runs,
    gate,
    activations,
    exactTaskForBytes,
    revoke(slug) {
      revoked.add(slug)
    },
  }
}

function runOf(fixture: CoordinatorFixture) {
  const run = fixture.runs.byTurn(PARENT_SESSION_ID, CLIENT_MESSAGE_ID)
  if (run === undefined) throw new Error('team run missing')
  return run
}

describe('expert team coordinator', () => {
  it('enforces team and per-member concurrency without pendingTurns', async () => {
    const { coordinator, gate } = await makeCoordinatorFixture({ maxParallel: 2 })
    const first = coordinator.dispatch(dispatchInput('a'))
    const second = coordinator.dispatch(dispatchInput('b'))
    const third = coordinator.dispatch(dispatchInput('c'))
    const fourth = coordinator.dispatch(dispatchInput('d'))
    await gate.waitStarted(2)
    expect(gate.running).toBe(2)
    expect(gate.startedIds).toHaveLength(2)
    gate.releaseAll()
    await Promise.all([first, second, third, fourth])
    expect(gate.maxRunning).toBe(2)

    // 单成员并发上限恒为 1：即使团队 maxParallel=2，同一成员的两条派工也必须串行
    const sameMember = await makeCoordinatorFixture({ maxParallel: 2 })
    const mFirst = sameMember.coordinator.dispatch(dispatchInput('a', { callId: 'same-1' }))
    const mSecond = sameMember.coordinator.dispatch(dispatchInput('a', { callId: 'same-2' }))
    await sameMember.gate.waitStarted(1)
    await Promise.resolve()
    expect(sameMember.gate.running).toBe(1)
    sameMember.gate.release(1)
    await mFirst
    await sameMember.gate.waitStarted(1)
    sameMember.gate.releaseAll()
    await mSecond
    expect(sameMember.gate.maxRunning).toBe(1)
  })

  it('increments unifiedRevisionRounds once per cycle even under parallel revisions and rejects revisions after quota exhaustion', async () => {
    const { coordinator, gate } = await makeCoordinatorFixture({ maxParallel: 2, reviewMode: 'unified', maxRevisionRounds: 1 })
    // 首轮 2 名执行成员产出 r1/r2，随后统一审查给出 revise
    const r1 = await coordinator.dispatch(dispatchInput('executor', { callId: 'u-e1' }))
    const r2 = await coordinator.dispatch(dispatchInput('executor-2', { callId: 'u-e2' }))
    await coordinator.dispatch(dispatchInput('reviewer', { callId: 'u-rev1', kind: 'review', task: '首轮审查' })) // fixture 返回 [VERDICT: REVISE]
    // 启动前校验被拒（超 256 KiB）不得消耗 unifiedRevisionRounds
    await expect(coordinator.dispatch(dispatchInput('executor', {
      callId: 'u-bad-rev', kind: 'revision', supersedesResultId: r1.resultId, task: '超长'.repeat(150 * 1024),
    }))).rejects.toThrow('expert-team-prompt-too-large')
    expect(coordinator.runs.byTurn('s1', 'm1')?.unifiedRevisionRounds).toBe(0)

    // 同周期并行返修两名成员：首份开启周期（0 -> 1），第二份复用同一周期（仍为 1，不得重复递增为 2）
    const revA = coordinator.dispatch(dispatchInput('executor', { callId: 'u-r1', kind: 'revision', supersedesResultId: r1.resultId, task: '返修 A' }))
    const revB = coordinator.dispatch(dispatchInput('executor-2', { callId: 'u-r2', kind: 'revision', supersedesResultId: r2.resultId, task: '返修 B' }))
    gate.releaseAll()
    const [resA] = await Promise.all([revA, revB])
    expect(coordinator.runs.byTurn('s1', 'm1')?.unifiedRevisionRounds).toBe(1)

    // 全员复审再次返回 revise 关闭该周期后，第 2 轮返修因超过 maxRevisionRounds=1 被拒绝
    await coordinator.dispatch(dispatchInput('reviewer', { callId: 'u-rev2', kind: 'review', task: '复审' }))
    await expect(coordinator.dispatch(dispatchInput('executor', {
      callId: 'u-r3', kind: 'revision', supersedesResultId: resA.resultId, task: '超额返修',
    }))).rejects.toThrow('expert-team-revision-limit')
  })

  it('counts each arrival once and rejects calls after 24', async () => {
    const { coordinator } = await makeCoordinatorFixture()
    for (let index = 0; index < 24; index += 1) await coordinator.dispatch(dispatchInput('a', { callId: `c-${index}`, task: `task-${index}` }))
    await expect(coordinator.dispatch(dispatchInput('a', { callId: 'c-24' }))).rejects.toThrow('expert-team-dispatch-budget')
    expect(coordinator.runs.byTurn('s1', 'm1')?.dispatchAttempts).toBe(25)
  })

  it('resolves unified scope once and rejects stale queued scope', async () => {
    const { coordinator, gate } = await makeCoordinatorFixture({ maxParallel: 1, reviewMode: 'unified' })
    const first = coordinator.dispatch(dispatchInput('executor', { callId: 'c1' }))
    await gate.waitStarted(1) // 第一名执行成员仍在运行，当前全集为空
    const second = coordinator.dispatch(dispatchInput('executor-2', { callId: 'c2' }))
    gate.release(1)
    await first // 当前全集只有 executor 的 r1，executor-2 已占据唯一执行槽
    await gate.waitStarted(1)
    const pending = coordinator.dispatch(dispatchInput('reviewer', { callId: 'c3', kind: 'review', task: '审查全部结果' }))
    gate.releaseAll() // executor-2 产出 r2 后，排队中的 review 出队发现 r1,r2 与入口 r1 不同
    await second
    await expect(pending).rejects.toThrow('expert-team-review-scope-changed')
    expect(gate.reviewPrompts).toHaveLength(0)
  })

  it('enforces the exact 256 KiB UTF-8 byte boundary (including multibyte characters) without counting package persona, and returns structured failure on upstream subagent capacity exhaustion', async () => {
    const { coordinator, activations, exactTaskForBytes } = await makeCoordinatorFixture({ packagePersonaBytes: 48 * 1024 })
    // 含中文/emoji 的多字节文本：合计恰好 256 * 1024 UTF-8 字节时允许启动（即便包 persona 另有 48 KiB）
    const exact256KiB = exactTaskForBytes('a', 256 * 1024, '审🧪')
    await expect(coordinator.dispatch(dispatchInput('a', { callId: 'c-exact', task: exact256KiB }))).resolves.toMatchObject({ status: 'completed' })
    expect(activations).toHaveLength(1)

    // 多 1 个 UTF-8 字节（256 * 1024 + 1）在启动成员前直接拒绝
    await expect(coordinator.dispatch(dispatchInput('a', { callId: 'c-over', task: `${exact256KiB}x` }))).rejects.toThrow('expert-team-prompt-too-large')
    expect(activations).toHaveLength(1)

    // 上游剩余子智能体容量不足时：计入 24 次预算并返回带 resultId 的失败结果，不隐藏重试
    const capFixture = await makeCoordinatorFixture({ maxActiveSubagentsError: 'maxActiveSubagents reached' })
    const capRes = await capFixture.coordinator.dispatch(dispatchInput('a', { callId: 'c-cap' }))
    expect(capRes).toMatchObject({ status: 'failed', error: expect.stringContaining('maxActiveSubagents') })
    expect(capFixture.coordinator.runs.byTurn('s1', 'm1')?.dispatchAttempts).toBe(1)
  })

  it('rejects missing callId, records dispatchId, and refuses dispatch once the lease is invalidated even when attachment cleanup throws', async () => {
    const { coordinator, runs, gate } = await makeCoordinatorFixture({ maxParallel: 1 })
    const runId = runs.byTurn(PARENT_SESSION_ID, CLIENT_MESSAGE_ID)?.teamRunId
    if (runId === undefined) throw new Error('team run missing')

    await expect(coordinator.dispatch(dispatchInput('a', { callId: '' }))).rejects.toThrow('expert-team-dispatch-context-missing')
    expect(runs.byTurn('s1', 'm1')?.dispatchAttempts).toBe(0)

    const completed = await coordinator.dispatch(dispatchInput('a', { callId: 'dispatch-visible' }))
    expect(runs.byTurn('s1', 'm1')?.results.find((item) => item.resultId === completed.resultId)?.dispatchId).toBe('dispatch-visible')

    // 排队等待的派工在租约失效后立即被拒绝（不等到成员槽释放）
    const held = coordinator.dispatch(dispatchInput('b', { callId: 'held-before-invalidate' }))
    await gate.waitStarted(1)
    const queued = coordinator.dispatch(dispatchInput('c', { callId: 'queued-before-invalidate' }))
    try {
      throw new Error('attachment detach failed')
    } catch {
      coordinator.invalidateLease(runId)
    }
    expect(coordinator.isLeaseValid(runId)).toBe(false)
    await expect(queued).rejects.toThrow('expert-team-terminal')
    await expect(coordinator.dispatch(dispatchInput('d', { callId: 'after-invalidate' }))).rejects.toThrow('expert-team-terminal')
    gate.releaseAll()
    await expect(held).resolves.toMatchObject({ status: 'completed' })
    expect(() => { coordinator.invalidateLease('unknown-run') }).not.toThrow()
  })

  it('returns structured failed results with resultId for startup, execution and output failures so failed executes can be retried', async () => {
    const fixture = await makeCoordinatorFixture({
      dispatchErrors: { 'e-start': '成员启动失败' },
      stopReasons: { 'e-stop': 'max_tokens' },
      outputs: { 'e-empty': { ok: false, error: 'empty-output' } },
    })
    const { coordinator, runs } = fixture

    const startup = await coordinator.dispatch(dispatchInput('a', { callId: 'e-start' }))
    expect(startup).toMatchObject({ status: 'failed', resultId: expect.any(String), error: expect.stringContaining('成员启动失败') })
    expect(runs.byTurn('s1', 'm1')?.results.find((item) => item.resultId === startup.resultId)).toMatchObject({
      status: 'failed',
      dispatchId: 'e-start',
      error: expect.stringContaining('成员启动失败'),
    })

    const stop = await coordinator.dispatch(dispatchInput('b', { callId: 'e-stop' }))
    expect(stop).toMatchObject({ status: 'failed', error: expect.stringContaining('max_tokens') })

    const empty = await coordinator.dispatch(dispatchInput('c', { callId: 'e-empty' }))
    expect(empty).toMatchObject({ status: 'failed', error: 'empty-output' })

    // 团长可凭失败 execute 的 resultId 通过 execute + supersedesResultId 重试
    const retry = await coordinator.dispatch(dispatchInput('a', { callId: 'e-start-retry', supersedesResultId: startup.resultId }))
    expect(retry.status).toBe('completed')
    expect(runs.byTurn('s1', 'm1')?.results.find((item) => item.resultId === retry.resultId)?.supersedesResultId).toBe(startup.resultId)
  })

  it('returns stopped results with resultId when a single member is cancelled and records invalid review verdicts without failing the member', async () => {
    const fixture = await makeCoordinatorFixture({ outputs: { 'e-invalid': { ok: true, text: '审查意见\n最后一行缺少标记' } } })
    const { coordinator, gate } = fixture

    const pending = coordinator.dispatch(dispatchInput('a', { callId: 'e-cancel' }))
    await gate.waitStarted(1)
    const memberRunId = runOf(fixture).results.find((item) => item.dispatchId === 'e-cancel')?.memberRunId
    expect(memberRunId).toBeTruthy()
    gate.cancelMember(memberRunId ?? '')
    const cancelled = await pending
    expect(cancelled).toMatchObject({ status: 'stopped', resultId: expect.any(String) })
    gate.releaseAll()

    const retry = await coordinator.dispatch(dispatchInput('a', { callId: 'e-cancel-retry', supersedesResultId: cancelled.resultId }))
    expect(retry.status).toBe('completed')

    const review = await coordinator.dispatch(dispatchInput('reviewer', { callId: 'e-invalid', kind: 'review', task: '审查' }))
    expect(review).toMatchObject({ status: 'completed', reviewError: 'invalid-verdict' })
    expect(runOf(fixture).results.find((item) => item.resultId === review.resultId)?.reviewVerdict).toBeUndefined()
  })

  it('classifies a coded member cancel as stopped before any localized copy fallback', async () => {
    const fixture = await makeCoordinatorFixture({
      // 文案与旧版 `智能体「<slug>」的回合已取消` 完全不同：只有稳定 code 能识别取消。
      dispatchErrors: { 'coded-cancel': '成员被用户主动停止（本地化文案已变更）' },
      dispatchErrorCodes: { 'coded-cancel': EXPERT_TEAM_MEMBER_CANCELLED },
    })
    const { coordinator, runs } = fixture
    const result = await coordinator.dispatch(dispatchInput('a', { callId: 'coded-cancel' }))
    expect(result).toMatchObject({
      status: 'stopped',
      error: EXPERT_TEAM_MEMBER_CANCELLED,
      resultId: expect.any(String),
    })
    // 注册表投影与工具结果一致：停止而非失败，且错误值稳定。
    expect(runs.byTurn(PARENT_SESSION_ID, CLIENT_MESSAGE_ID)?.results.find((item) => item.resultId === result.resultId)).toMatchObject({
      status: 'stopped',
      error: EXPERT_TEAM_MEMBER_CANCELLED,
    })
  })

  it('writes memberRunId as soon as a member run exists and cancels queued and in-flight members while awaiting cleanup', async () => {
    const fixture = await makeCoordinatorFixture({ maxParallel: 2 })
    const { coordinator, gate, runs } = fixture
    const runId = runOf(fixture).teamRunId

    const first = coordinator.dispatch(dispatchInput('a', { callId: 'cancel-1' }))
    const second = coordinator.dispatch(dispatchInput('b', { callId: 'cancel-2' }))
    await gate.waitStarted(2)
    const queued = coordinator.dispatch(dispatchInput('c', { callId: 'cancel-3' }))

    const run = runOf(fixture)
    const started = run.results.filter((item) => item.memberRunId !== undefined)
    expect(started).toHaveLength(2)
    expect(started.every((item) => item.status === 'running')).toBe(true)
    expect(started.map((item) => item.memberRunId)).toEqual(gate.startedIds)
    expect(coordinator.hasInFlight(runId)).toBe(true)

    gate.holdCleanup()
    const cancellation = coordinator.cancelRun(runId)
    await expect(queued).rejects.toThrow('expert-team-terminal')

    let cancellationSettled = false
    void cancellation.then(() => { cancellationSettled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(cancellationSettled).toBe(false)

    gate.releaseCleanup()
    await cancellation
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toMatchObject({ status: 'stopped', resultId: expect.any(String) })
    expect(secondResult.status).toBe('stopped')
    expect(gate.cancelledRunIds).toEqual(expect.arrayContaining(started.map((item) => item.memberRunId)))
    expect(gate.cancelledRunIds).toHaveLength(2)
    expect(coordinator.hasInFlight(runId)).toBe(false)
    expect(runs.get(runId)?.status).toBe('stopped')
    // waitMemberCleanups 在取消收敛后立即可返回
    await expect(coordinator.waitMemberCleanups(runId)).resolves.toBeUndefined()
  })

  it('keeps cancelRun and waitMemberCleanups pending until a settled member cleanup promise releases', async () => {
    const fixture = await makeCoordinatorFixture({ holdMemberCleanup: true })
    const { coordinator, gate } = fixture
    const runId = runOf(fixture).teamRunId

    const pending = coordinator.dispatch(dispatchInput('a', { callId: 'cleanup-1' }))
    await gate.waitStarted(1)
    gate.releaseAll()
    // 派工本身已结算（completed），但成员清理确认仍被 held：协调器必须记住该 promise。
    const result = await pending
    expect(result.status).toBe('completed')
    expect(coordinator.hasInFlight(runId)).toBe(false)

    const flush = async (): Promise<void> => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) }
    let waitSettled = false
    let cancelSettled = false
    const waiting = coordinator.waitMemberCleanups(runId).then(() => { waitSettled = true })
    const cancellation = coordinator.cancelRun(runId).then(() => { cancelSettled = true })
    await flush()
    await flush()
    expect(waitSettled).toBe(false)
    expect(cancelSettled).toBe(false)
    expect(runOf(fixture).status).toBe('stopping')

    gate.releaseCleanup()
    await waiting
    await cancellation
    expect(waitSettled).toBe(true)
    expect(cancelSettled).toBe(true)
    expect(runOf(fixture).status).toBe('stopped')
    // 收敛后清理等待立即返回，不重复挂起。
    await expect(coordinator.waitMemberCleanups(runId)).resolves.toBeUndefined()
  })

  it('enforces sequential order and reference, allows broadcast shortfall at dispatch, and enforces per-member revision scope and quota', async () => {
    const sequential = await makeCoordinatorFixture({
      roster: DEFAULT_ROSTER_3,
      executionOrder: 'sequential',
    })
    await expect(sequential.coordinator.dispatch(dispatchInput('executor-2', { callId: 'seq-1' }))).rejects.toThrow('expert-team-sequential-order')
    const first = await sequential.coordinator.dispatch(dispatchInput('executor', { callId: 'seq-2' }))
    await expect(sequential.coordinator.dispatch(dispatchInput('executor-2', { callId: 'seq-3' }))).rejects.toThrow('expert-team-sequential-reference')
    const second = await sequential.coordinator.dispatch(dispatchInput('executor-2', {
      callId: 'seq-4',
      inputResultIds: [first.resultId],
    }))
    expect(second.status).toBe('completed')
    // 有效执行并发固定为 1：sequential 下 gate 从未同时启动两名成员
    expect(sequential.gate.maxRunning).toBe(1)

    // 控制器裁定：broadcast 首轮缺员不在派工层拒绝，由提交/回合终态判定
    const broadcast = await makeCoordinatorFixture({ assignmentMode: 'broadcast' })
    const single = await broadcast.coordinator.dispatch(dispatchInput('a', { callId: 'broadcast-1' }))
    expect(single.status).toBe('completed')

    // per-member：审查 scope 必须是目标单例，返修只在有效 revise 后允许且受链上限约束
    const perMember = await makeCoordinatorFixture({
      roster: DEFAULT_ROSTER_3,
      reviewMode: 'per-member',
      maxRevisionRounds: 1,
      dispatchErrors: { 'rev-fail': '返修启动失败' },
    })
    const target = await perMember.coordinator.dispatch(dispatchInput('executor', { callId: 'pm-1' }))
    await expect(perMember.coordinator.dispatch(dispatchInput('reviewer', { callId: 'pm-rev-noscope', kind: 'review', task: '缺 scope' }))).rejects.toThrow('expert-team-review-scope')
    const review = await perMember.coordinator.dispatch(dispatchInput('reviewer', {
      callId: 'pm-rev-1',
      kind: 'review',
      task: '单链审查',
      inputResultIds: [target.resultId],
    }))
    expect(review).toMatchObject({ status: 'completed', reviewVerdict: 'revise' })
    const failedRevision = await perMember.coordinator.dispatch(dispatchInput('executor', {
      callId: 'rev-fail',
      kind: 'revision',
      supersedesResultId: target.resultId,
      task: '失败的返修',
    }))
    expect(failedRevision.status).toBe('failed')
    await expect(perMember.coordinator.dispatch(dispatchInput('executor', {
      callId: 'pm-r2',
      kind: 'revision',
      supersedesResultId: target.resultId,
      task: '超额返修',
    }))).rejects.toThrow('expert-team-revision-limit')

    // review.mode = none：透传 Task 6 具名错误
    const noReview = await makeCoordinatorFixture({ reviewMode: 'none' })
    await expect(noReview.coordinator.dispatch(dispatchInput('reviewer', {
      callId: 'none-1',
      kind: 'review',
      task: '不应允许',
      inputResultIds: [],
    }))).rejects.toThrow('expert-team-review-disabled')
  })

  it('rechecks live member package availability at dequeue without starting the member', async () => {
    const fixture = await makeCoordinatorFixture({ maxParallel: 1 })
    const { coordinator, gate } = fixture
    const first = coordinator.dispatch(dispatchInput('a', { callId: 'live-1' }))
    await gate.waitStarted(1)
    const queued = coordinator.dispatch(dispatchInput('b', { callId: 'live-2' }))
    fixture.revoke('pkg-b')
    gate.releaseAll()
    await first
    await expect(queued).rejects.toThrow('expert-team-member-revoked')
    expect(gate.startedIds).toHaveLength(1)
    expect(fixture.activations.map((item) => item.memberId)).toEqual(['a'])
  })

  it('cancels the leader turn exactly once when the team is terminated and converges to stopped', async () => {
    const parentCancels: string[] = []
    const fixture = await makeCoordinatorFixture({
      cancelParentTurn: (parentSessionId) => {
        parentCancels.push(parentSessionId)
      },
    })
    const pending = fixture.coordinator.dispatch(dispatchInput('a', { callId: 'leader-cancel' }))
    await fixture.gate.waitStarted(1)
    const runId = runOf(fixture).teamRunId

    await fixture.coordinator.cancelRun(runId)
    expect(parentCancels).toEqual([PARENT_SESSION_ID])
    await expect(pending).resolves.toMatchObject({ status: 'stopped' })
    expect(fixture.runs.get(runId)?.status).toBe('stopped')

    // 幂等：对已停止运行再次终止不得再次取消（可能已属于下一次回合的）团长回合。
    await fixture.coordinator.cancelRun(runId)
    expect(parentCancels).toEqual([PARENT_SESSION_ID])
  })

})
