/**
 * `expert_team_dispatch` 团长工具与 claim 附件(设计 §10.3 / §12.1 / §12.3;计划 Task 9)。
 *
 * 工具全局注册,可见性由「团队回合附件 + 团队租约」两层决定:
 * - `makeExpertTeamClaimed` 在 `agent/inbox/claimed`(首步工具快照之前)同步挂载/摘除;
 * - 工具执行体再按同一附件复核,并把 `exec.callId`、父会话与回合锚交给协调器。
 *
 * 这里的附件表用真实 `emptyAttachments()` / `isAgentToolAttached`,运行用真实
 * `ExpertTeamRunRegistry`,只有协调器是按需假体(本任务只验证接线,派工语义在 Task 8)。
 * `refreshAgentRestrict` 是模块级副作用,用 `vi.mock` 记录调用。
 */
import { MessageId, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'

import type { ExpertTeam, ExpertTeamRun } from '../../src/client-huaanwork/rpc-types.ts'
import { createExpertTeamRunRegistry } from '../../src/huaanwork-host/expert-team/runs.ts'
import { createTurnAnchorStore } from '../../src/huaanwork-host/turn-anchors.ts'
import {
  attachAgentTools,
  emptyAttachments,
  isAgentToolAttached,
} from '../../src/huaanwork-guardrails/agent-attachments.ts'
import { refreshAgentRestrict } from '../../src/huaanwork-guardrails/present-as.ts'
import {
  EXPERT_TEAM_DISPATCH_TOOL,
  expertTeamDispatchDefinition,
  makeExpertTeamClaimed,
} from '../../src/huaanwork-guardrails/expert-team-dispatch.ts'

vi.mock('../../src/huaanwork-guardrails/present-as.ts', () => ({
  refreshAgentRestrict: vi.fn(),
}))

const PARENT = 'parent'
const TEAM_CLIENT_MESSAGE_ID = 'client-team-1'

/** 形状与 `findAgentBySession` 一致:会话身份取 `session.id`。 */
const parentAgent = { session: { id: PARENT } }

function fixtureTeam(): ExpertTeam {
  return {
    schemaVersion: 1,
    id: 'team-1',
    slug: 'review-squad',
    name: '评审小组',
    description: '先执行再统一审查',
    enabled: true,
    members: [
      {
        memberId: 'm1',
        agentRef: { source: 'local', slug: 'writer' },
        role: 'executor',
        responsibility: '撰写正文',
      },
      {
        memberId: 'm2',
        agentRef: { source: 'local', slug: 'reviewer' },
        role: 'reviewer',
        responsibility: '审查结论',
      },
    ],
    orchestration: { assignmentMode: 'broadcast', executionOrder: 'parallel', maxParallel: 2 },
    review: { mode: 'unified', maxRevisionRounds: 1 },
    summary: { delivery: 'message', artifactFormat: 'markdown', mode: 'integrated' },
    createdAt: '2026-11-22T00:00:00.000Z',
    updatedAt: '2026-11-22T00:00:00.000Z',
  }
}

/** 真实 `UserMessage` 形状;`createUserMessage` 不接受显式 id,assistant 侧消息 id 由此对齐。 */
function userMessageWithId(id: string, source: { kind: string }): UserMessage {
  const base = createUserMessage({ content: [{ type: 'text', text: '开始' }], source: source as never })
  return { ...base, id: MessageId(id) } as UserMessage
}

function fixtureContext() {
  const attachments = emptyAttachments()
  attachAgentTools(attachments, PARENT, [EXPERT_TEAM_DISPATCH_TOOL])
  const dispatch = vi.fn(async (input: { memberId: string; kind: 'execute' | 'review' | 'revision' }) => ({
    resultId: 'result-1',
    memberId: input.memberId,
    agentSlug: 'writer',
    kind: input.kind,
    inputResultIds: [] as string[],
    status: 'completed' as const,
    output: '成员输出正文',
  }))
  return {
    tools: { register: vi.fn(() => () => undefined) },
    huaanworkAttachments: attachments,
    huaanworkTurnAnchors: {
      current: (sessionId: string) =>
        sessionId === PARENT
          ? { clientMessageId: TEAM_CLIENT_MESSAGE_ID, startedAt: '2026-11-22T00:00:00.000Z', origin: 'advanced' as const }
          : undefined,
    },
    huaanworkExpertTeamRuns: undefined,
    huaanworkExpertTeamCoordinator: { dispatch },
  }
}

function makeClaimFixture() {
  const attachments = emptyAttachments()
  const anchors = createTurnAnchorStore()
  const runs = createExpertTeamRunRegistry({ emit: () => undefined })
  const teamMessage = userMessageWithId(TEAM_CLIENT_MESSAGE_ID, { kind: 'user' })
  const goalMessage = createUserMessage({
    content: [{ type: 'text', text: '继续完成' }],
    source: { kind: 'goal' } as never,
  })
  const ordinaryMessage = createUserMessage({ content: [{ type: 'text', text: '普通提问' }], source: { kind: 'user' } })
  const lease = { valid: true }
  // 运行必须在 followup 之前登记(设计 §12.1),claim 才能识别当前团队回合。
  const run: ExpertTeamRun = runs.begin({
    parentSessionId: PARENT,
    clientMessageId: teamMessage.id,
    teamSnapshot: fixtureTeam(),
  })
  // 团队发送与高级回合同形登记 pending 锚点,claim 的 notePreStep 才会消费它。
  anchors.register({ sessionId: PARENT, clientMessageId: teamMessage.id, origin: 'advanced' })
  const refresh = vi.mocked(refreshAgentRestrict)
  refresh.mockClear()
  const listener = makeExpertTeamClaimed({
    huaanworkAttachments: attachments,
    huaanworkTurnAnchors: anchors,
    huaanworkExpertTeamRuns: runs,
    huaanworkExpertTeamCoordinator: { isLeaseValid: () => lease.valid },
  } as never)
  return {
    listener,
    attachments,
    refresh,
    runs,
    teamRunId: run.teamRunId,
    teamMessage,
    goalMessage,
    ordinaryMessage,
    lease,
    settleTeam() {
      runs.update(run.teamRunId, (current) => {
        current.status = 'completed'
      })
    },
  }
}

it('declares a concurrency-safe tool without teamRunId and requires exec.callId', async () => {
  const tool = expertTeamDispatchDefinition(fixtureContext())
  expect(tool.isConcurrencySafe?.({})).toBe(true)
  expect(tool.parameters).not.toHaveProperty('teamRunId')
  expect(tool.parameters).toHaveProperty('memberId')
  expect(tool.parameters).toHaveProperty('inputResultIds')
  await expect(tool.execute({ memberId: 'm1', kind: 'execute', task: 't' }, { agent: parentAgent })).rejects.toThrow(
    'expert-team-dispatch-context-missing',
  )
})

it('binds callId, parent session and turn anchor into the coordinator and never sends teamRunId', async () => {
  const ctx = fixtureContext()
  const tool = expertTeamDispatchDefinition(ctx)
  const result = await tool.execute(
    { memberId: 'm1', kind: 'review', task: '审查正文', inputResultIds: ['result-0'] },
    { agent: parentAgent, callId: 'call-9' },
  )
  expect(ctx.huaanworkExpertTeamCoordinator.dispatch).toHaveBeenCalledWith({
    callId: 'call-9',
    parentSessionId: PARENT,
    clientMessageId: TEAM_CLIENT_MESSAGE_ID,
    memberId: 'm1',
    kind: 'review',
    task: '审查正文',
    inputResultIds: ['result-0'],
  })
  expect(result.text).toContain('result-1')
  expect(result.text).toContain('成员输出正文')
})

it('rejects execution without the session attachment or the turn anchor', async () => {
  const unattached = fixtureContext()
  unattached.huaanworkAttachments = emptyAttachments()
  const tool = expertTeamDispatchDefinition(unattached)
  await expect(
    tool.execute({ memberId: 'm1', kind: 'execute', task: '撰写' }, { agent: parentAgent, callId: 'call-1' }),
  ).rejects.toThrow('expert-team-dispatch-not-attached')
  expect(unattached.huaanworkExpertTeamCoordinator.dispatch).not.toHaveBeenCalled()

  const unanchored = fixtureContext()
  unanchored.huaanworkTurnAnchors = { current: () => undefined }
  await expect(
    expertTeamDispatchDefinition(unanchored).execute(
      { memberId: 'm1', kind: 'execute', task: '撰写' },
      { agent: parentAgent, callId: 'call-2' },
    ),
  ).rejects.toThrow('expert-team-dispatch-context-missing')
  expect(unanchored.huaanworkExpertTeamCoordinator.dispatch).not.toHaveBeenCalled()
})

it('attaches only for an active running team matching message.id and detaches on ordinary or goal continuation turns', () => {
  const { listener, attachments, refresh, teamMessage, goalMessage, ordinaryMessage, settleTeam } = makeClaimFixture()
  listener({ agent: parentAgent as never, message: teamMessage, turn: 1 })
  expect(isAgentToolAttached(attachments, PARENT, EXPERT_TEAM_DISPATCH_TOOL)).toBe(true)
  settleTeam()
  listener({ agent: parentAgent as never, message: goalMessage, turn: 2 })
  expect(isAgentToolAttached(attachments, PARENT, EXPERT_TEAM_DISPATCH_TOOL)).toBe(false)
  listener({ agent: parentAgent as never, message: ordinaryMessage, turn: 3 })
  expect(isAgentToolAttached(attachments, PARENT, EXPERT_TEAM_DISPATCH_TOOL)).toBe(false)
  // 真实签名与 result_present 一致:`refreshAgentRestrict(ctx, sessionId)`。
  expect(refresh).toHaveBeenCalledWith(expect.anything(), PARENT)
})

it('keeps the tool detached when the lease is already invalid', () => {
  const { listener, attachments, teamMessage, lease } = makeClaimFixture()
  lease.valid = false
  listener({ agent: parentAgent as never, message: teamMessage, turn: 1 })
  expect(isAgentToolAttached(attachments, PARENT, EXPERT_TEAM_DISPATCH_TOOL)).toBe(false)
})

it('cancels the driver when the attachment sync throws instead of swallowing the error', () => {
  const { listener, refresh, teamMessage } = makeClaimFixture()
  refresh.mockImplementationOnce(() => {
    throw new Error('restrict unavailable')
  })
  const cancel = vi.fn()
  const agent = { session: { id: PARENT }, cancel }
  listener({ agent: agent as never, message: teamMessage, turn: 1 })
  expect(cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'expert-team-attachment-sync-failed' })
})
