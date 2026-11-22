import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  activeCompositionContext,
  bootCompositionHost,
  createComplianceTeamScenario,
  disposeCompositionEnvironment,
  restartHostWithSameProfile,
  runComplianceTeamSmoke,
  type CompositionHost,
} from '../fixtures/expert-team/driver.ts'

/**
 * 真实组合场景(设计 §18.4):真实 `prepareDesktopProfile`/`boot`、真实
 * `session.send`、包 runtime 与 Artifact 存储;模型经 `llm/stream` 脚本化,
 * 不触网、不需要真实 API key。
 */

let host: CompositionHost

beforeAll(async () => {
  host = await bootCompositionHost()
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
    console.log('SCENARIO1', JSON.stringify({
      status: result.run.status,
      dispatches: result.dispatches.map((item) => item.kind),
      memberRunIds: result.memberRunIds.length,
      maxMemberConcurrency: result.maxMemberConcurrency,
      parentMcpAttachments: result.parentMcpAttachments,
      memberMcpServers: result.memberMcpServers,
      primaryArtifactIds: result.primaryArtifactIds,
      notifications: result.parentNotifications,
      finalSummary: result.finalSummary,
      failure: result.run.failure,
      artifactPreview: result.artifact?.content.slice(0, 200),
    }, null, 2))
    expect(result.maxMemberConcurrency).toBe(2)
    expect(result.dispatches.map((item) => item.kind)).toEqual(['execute', 'execute', 'review', 'revision', 'review'])
    expect(result.memberRunIds).toHaveLength(5)
    expect(result.parentMcpAttachments).toEqual([])
    expect(result.primaryArtifactIds).toHaveLength(1)
    expect(result.artifact?.content).toContain('未解决项')
    expect(result.run.status).toBe('completed')
    expect(result.parentNotifications.filter((item) => item.kind === 'subagent-notification')).toEqual([])
  }, 180_000)

  it('placeholder restart', async () => {
    expect(host.sessionId.length).toBeGreaterThan(0)
    await restartHostWithSameProfile(activeCompositionContext())
  }, 300_000)
})
