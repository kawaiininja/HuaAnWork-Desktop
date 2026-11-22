import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  activeCompositionContext,
  bootCompositionHost,
  createComplianceTeamScenario,
  disposeCompositionEnvironment,
  restartHostWithSameProfile,
  runComplianceTeamSmoke,
} from '../fixtures/expert-team/driver.ts'

/**
 * 真实组合场景(设计 §18.4):真实 `prepareDesktopProfile`/`boot`、真实
 * `session.send`、包 runtime 与 Artifact 存储;模型经 `llm/stream` 脚本化,
 * 不触网、不需要真实 API key。
 */

/** 上游子代理通知的真实 user 消息来源种类(`subagent-settled` / `agent-message`)。 */
const SUBAGENT_NOTIFICATION_KINDS: readonly string[] = ['subagent-settled', 'agent-message']

beforeAll(async () => {
  await bootCompositionHost()
}, 300_000)

afterAll(async () => {
  await disposeCompositionEnvironment()
})

describe('expert team real composition', () => {
  it('runs two executors, one unified reviewer, one revision and one primary artifact (Spec §18.4 default)', async () => {
    const scenario = await createComplianceTeamScenario(activeCompositionContext())
    const result = await runComplianceTeamSmoke(scenario, {
      executionOrder: 'parallel',
      maxParallel: 2,
      reviewVerdicts: ['revise', 'pass'],
      dualMcp: true,
    })
    expect(result.maxMemberConcurrency).toBe(2)
    expect(result.dispatches.map((item) => item.kind)).toEqual(['execute', 'execute', 'review', 'revision', 'review'])
    expect(result.memberRunIds).toHaveLength(5)
    expect(result.parentMcpAttachments).toEqual([])
    expect(result.parentMcpToolNames).toEqual([])
    expect(result.memberMcpServers).toHaveLength(2)
    expect(result.memberMcpServers.every((item) => item.serverName.length <= 32)).toBe(true)
    expect(result.primaryArtifactIds).toHaveLength(1)
    expect(result.artifactCount).toBe(1)
    expect(result.artifact?.content).toContain('未解决项')
    expect(result.run.status).toBe('completed')
    expect(result.parentNotifications.filter((item) => SUBAGENT_NOTIFICATION_KINDS.includes(item.kind))).toEqual([])
  }, 180_000)

  it('re-reviews with all reviewers in parallel after revision when a team has two reviewers, and respects parent maxParallelToolCalls=1 even when team maxParallel=4', async () => {
    const scenario = await createComplianceTeamScenario(activeCompositionContext(), { reviewerCount: 2 })
    const result = await runComplianceTeamSmoke(scenario, {
      executionOrder: 'parallel',
      maxParallel: 2,
      reviewVerdicts: ['revise', 'pass', 'pass', 'pass'],
    })
    expect(result.dispatches.map((item) => item.kind)).toEqual([
      'execute',
      'execute',
      'review',
      'review',
      'revision',
      'review',
      'review',
    ])
    expect(result.memberRunIds).toHaveLength(7)
    // 两名审查成员必须在同一波次真实重叠：barrier 只在第二路审查流在场或波次超时后放行。
    expect(result.maxReviewConcurrency).toBe(2)
    expect(result.artifactCount).toBe(1)
    expect(result.run.status).toBe('completed')

    const serialPool = await runComplianceTeamSmoke(scenario, {
      executionOrder: 'parallel',
      maxParallel: 4,
      parentMaxParallelToolCalls: 1,
      reviewVerdicts: ['pass', 'pass'],
    })
    expect(serialPool.maxMemberConcurrency).toBe(1)
    expect(serialPool.maxReviewConcurrency).toBe(1)
    expect(serialPool.artifactCount).toBe(1)
    expect(serialPool.run.status).toBe('completed')
  }, 180_000)

  it('allows a partial artifact after the dispatch budget is exhausted and settles partial on unrecovered Artifact write failure (Spec §18.4 item 6)', async () => {
    const scenario = await createComplianceTeamScenario(activeCompositionContext())
    const result = await runComplianceTeamSmoke(scenario, { failUntilBudgetExhausted: true })
    expect(result.dispatches).toHaveLength(24)
    expect(result.run.status).toBe('partial')
    expect(result.artifact?.content).toContain('失败与遗漏')
    expect(result.primaryArtifactIds).toHaveLength(1)
    expect(result.artifactCount).toBe(1)

    const writeFailed = await runComplianceTeamSmoke(scenario, { failArtifactWrite: true })
    expect(writeFailed.primaryArtifactIds).toEqual([])
    expect(writeFailed.artifactCount).toBe(0)
    expect(writeFailed.run.artifactStatus).toBe('pending')
    expect(writeFailed.run.status).toBe('partial')
  }, 300_000)

  it('uses final post-tool text for message delivery and seals before goal continuation', async () => {
    const scenario = await createComplianceTeamScenario(activeCompositionContext())
    const result = await runComplianceTeamSmoke(scenario, {
      delivery: 'message',
      activeGoal: true,
      transitionalTextBeforeDispatch: '我先安排成员',
    })
    expect(result.run.status).toBe('completed')
    expect(result.finalSummary).toBe('最终合规汇总')
    // 真实 goal 续轮:round >= 1 的 goal user 消息,且续轮请求不再持有团长派工工具。
    expect(result.goalRounds).toContain(1)
    const goalNotifications = result.parentNotifications.filter((item) => item.kind === 'goal')
    expect(goalNotifications.length).toBeGreaterThanOrEqual(1)
    const goalRequests = result.requests.filter((request) => request.goalRound !== undefined)
    expect(goalRequests).toHaveLength(1)
    expect(goalRequests[0]?.goalRound).toBeGreaterThanOrEqual(1)
    expect(goalRequests.every((request) => !request.toolNames.includes('expert_team_dispatch'))).toBe(true)
    expect(result.goalDispatchError).toBe('expert-team-terminal')
  }, 180_000)

  it('drops run projections but preserves messages and artifacts after Host restart', async () => {
    const scenario = await createComplianceTeamScenario(activeCompositionContext())
    const first = await runComplianceTeamSmoke(scenario, {})
    expect(first.artifactCount).toBe(1)
    const restarted = await restartHostWithSameProfile(activeCompositionContext())
    expect(restarted.expertTeamRuns).toEqual([])
    expect(restarted.artifactIds).toContain(first.primaryArtifactIds[0])
    expect(restarted.messages.map((item) => item.text)).toContain(first.finalSummary)
  }, 300_000)
})
