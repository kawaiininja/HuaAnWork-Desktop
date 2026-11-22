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
    expect(result.primaryArtifactIds).toHaveLength(1)
    expect(result.artifact?.content).toContain('未解决项')
    expect(result.run.status).toBe('completed')
    expect(result.parentNotifications.filter((item) => item.kind === 'subagent-notification')).toEqual([])
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
    expect(result.run.status).toBe('completed')

    const serialPool = await runComplianceTeamSmoke(scenario, {
      executionOrder: 'parallel',
      maxParallel: 4,
      parentMaxParallelToolCalls: 1,
      reviewVerdicts: ['pass', 'pass'],
    })
    expect(serialPool.maxMemberConcurrency).toBe(1)
    expect(serialPool.run.status).toBe('completed')
  }, 180_000)

  it('allows a partial artifact after the dispatch budget is exhausted and settles partial on unrecovered Artifact write failure (Spec §18.4 item 6)', async () => {
    const scenario = await createComplianceTeamScenario(activeCompositionContext())
    const result = await runComplianceTeamSmoke(scenario, { failUntilBudgetExhausted: true })
    expect(result.dispatches).toHaveLength(24)
    expect(result.run.status).toBe('partial')
    expect(result.artifact?.content).toContain('失败与遗漏')
    expect(result.primaryArtifactIds).toHaveLength(1)

    const writeFailed = await runComplianceTeamSmoke(scenario, { failArtifactWrite: true })
    expect(writeFailed.primaryArtifactIds).toEqual([])
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
    expect(result.goalDispatchError).toBe('expert-team-terminal')
  }, 180_000)

  it('drops run projections but preserves messages and artifacts after Host restart', async () => {
    const scenario = await createComplianceTeamScenario(activeCompositionContext())
    const first = await runComplianceTeamSmoke(scenario, {})
    const restarted = await restartHostWithSameProfile(activeCompositionContext())
    expect(restarted.expertTeamRuns).toEqual([])
    expect(restarted.artifactIds).toContain(first.primaryArtifactIds[0])
    expect(restarted.messages.map((item) => item.text)).toContain(first.finalSummary)
  }, 300_000)
})
