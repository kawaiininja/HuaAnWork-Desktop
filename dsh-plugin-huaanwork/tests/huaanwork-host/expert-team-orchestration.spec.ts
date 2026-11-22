import { describe, expect, it } from 'vitest'

import type { ExpertTeam, ExpertTeamResult, ExpertTeamRun } from '../../src/client-huaanwork/rpc-types.ts'
import {
  assertReviewScopeCurrent,
  canSubmitPrimaryArtifact,
  computeExpertTeamTerminalStatus,
  currentEffectiveResultIds,
  resolveReviewScope,
  validateDispatchRule,
} from '../../src/huaanwork-host/expert-team/orchestration.ts'
import {
  executeResult,
  validTeam,
  validTeamInput,
} from '../fixtures/expert-team/team.ts'
import type {
  ExpertTeamInputOverrides,
  ExpertTeamResultOverrides,
} from '../fixtures/expert-team/team.ts'

/**
 * Task 6 测试工厂：只依赖 Task 1 的 `validTeam()` / `executeResult()`，不依赖后续
 * coordinator。可选属性只在有值时写入，遵守 `exactOptionalPropertyTypes`。
 *
 * `cycleOpen` 只是工厂入参而非 `ExpertTeamRun` 字段：`validateDispatchRule` 必须完全
 * 从 `run.results` 与 `unifiedRevisionRounds` 派生周期开/闭。
 */

type RunOverrides = Partial<ExpertTeamRun>

type ReviewMode = ExpertTeam['review']['mode']

type UnifiedReviseOptions = {
  maxRevisionRounds: 0 | 1 | 2
  unifiedRevisionRounds: number
  cycleOpen?: boolean
}

type PerMemberChainOptions = {
  memberId: string
  revisionsInChain: 0 | 1 | 2
  maxRevisionRounds: 0 | 1 | 2
}

function makeRun(results: ExpertTeamResult[], team: ExpertTeam, overrides: RunOverrides = {}): ExpertTeamRun {
  const run: ExpertTeamRun = {
    teamRunId: '00000000-0000-4000-8000-0000000000aa',
    parentSessionId: 's1',
    clientMessageId: 'm1',
    teamId: team.id,
    teamSnapshot: team,
    status: 'running',
    results: [...results],
    artifactStatus: team.summary.delivery === 'artifact' ? 'pending' : 'not-required',
    deliverySealed: false,
    unifiedRevisionRounds: 0,
    dispatchAttempts: 1,
    startedAt: '2026-11-22T00:00:00.000Z',
    revision: 1,
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) Object.assign(run, { [key]: value })
  }
  return run
}

/** 按成员 id 构造角色匹配的团队；不在 default roster 的成员必须显式加入。 */
function teamWith(
  executorIds: readonly string[],
  reviewerIds: readonly string[],
  overrides: ExpertTeamInputOverrides = {},
): ExpertTeam {
  const members: ExpertTeam['members'] = [
    ...executorIds.map((memberId, index) => ({
      memberId,
      agentRef: { source: 'local' as const, slug: index === 0 ? 'writer' : `writer-${index + 1}` },
      role: 'executor' as const,
      responsibility: `执行成员 ${memberId} 的职责`,
    })),
    ...reviewerIds.map((memberId, index) => ({
      memberId,
      agentRef: { source: 'local' as const, slug: index === 0 ? 'reviewer' : `reviewer-${index + 1}` },
      role: 'reviewer' as const,
      responsibility: `审查成员 ${memberId} 的职责`,
    })),
  ]
  return validTeamInput({ members, ...overrides })
}

/** 审查结果：`invalid` 只写 `reviewError`，绝不与 `reviewVerdict` 同时出现。 */
function reviewResult(
  resultId: string,
  verdict: 'pass' | 'revise' | 'invalid',
  overrides: ExpertTeamResultOverrides = {},
): ExpertTeamResult {
  const verdictFields: ExpertTeamResultOverrides =
    verdict === 'invalid' ? { reviewError: 'invalid-verdict' } : { reviewVerdict: verdict }
  const output =
    verdict === 'invalid'
      ? '审查意见缺少合法标记'
      : verdict === 'revise'
        ? '审查意见\n[VERDICT: REVISE]'
        : '审查意见\n[VERDICT: PASS]'
  return executeResult(resultId, {
    memberId: 'm-rev-1',
    agentRef: { source: 'local', slug: 'reviewer' },
    kind: 'review',
    output,
    ...verdictFields,
    ...overrides,
  })
}

function runWithResults(results: ExpertTeamResult[], overrides: RunOverrides = {}): ExpertTeamRun {
  return makeRun(results, validTeam(), overrides)
}

function runWithCompletedDelivery(overrides: RunOverrides = {}): ExpertTeamRun {
  const execute = executeResult('delivered-execute')
  return makeRun(
    [execute, reviewResult('delivered-review', 'pass', { inputResultIds: [execute.resultId] })],
    validTeam(),
    {
      primaryArtifactId: 'artifact-delivered',
      primaryArtifactCallId: 'call-delivered',
      artifactStatus: 'created',
      deliverySealed: true,
      ...overrides,
    },
  )
}

function runWithMessageDelivery(overrides: RunOverrides = {}): ExpertTeamRun {
  const team = teamWith(['m-exec-1'], ['m-rev-1'], { summary: { delivery: 'message' } })
  const execute = executeResult('message-execute')
  return makeRun(
    [execute, reviewResult('message-review', 'pass', { inputResultIds: [execute.resultId] })],
    team,
    { artifactStatus: 'not-required', ...overrides },
  )
}

function runWithReviewMode(mode: ReviewMode, results: ExpertTeamResult[]): ExpertTeamRun {
  const team = teamWith(['m-exec-1', 'm-exec-2'], ['m-rev-1'], { review: { mode, maxRevisionRounds: 1 } })
  return makeRun(results, team)
}

function runWithInvalidReview(overrides: RunOverrides = {}): ExpertTeamRun {
  const execute = executeResult('invalid-review-execute')
  return makeRun(
    [execute, reviewResult('invalid-review', 'invalid', { inputResultIds: [execute.resultId] })],
    validTeam(),
    overrides,
  )
}

function runWithExhaustedRevision(overrides: RunOverrides = {}): ExpertTeamRun {
  const team = teamWith(['m-exec-1'], ['m-rev-1'], { review: { mode: 'unified', maxRevisionRounds: 1 } })
  const original = executeResult('exhausted-original')
  const revision = executeResult('exhausted-revision', {
    kind: 'revision',
    supersedesResultId: original.resultId,
    inputResultIds: [original.resultId],
  })
  return makeRun(
    [
      original,
      reviewResult('exhausted-review-first', 'revise', { inputResultIds: [original.resultId] }),
      revision,
      reviewResult('exhausted-review-final', 'revise', { inputResultIds: [revision.resultId] }),
    ],
    team,
    {
      unifiedRevisionRounds: 1,
      primaryArtifactId: 'artifact-exhausted',
      primaryArtifactCallId: 'call-exhausted',
      artifactStatus: 'created',
      deliverySealed: true,
      ...overrides,
    },
  )
}

function runWithMissingReview(overrides: RunOverrides = {}): ExpertTeamRun {
  return makeRun([executeResult('missing-review-execute')], validTeam(), overrides)
}

function runWithSequentialExecutors(memberIds: string[], results: ExpertTeamResult[] = []): ExpertTeamRun {
  const team = teamWith(memberIds, [], {
    orchestration: { assignmentMode: 'by-responsibility', executionOrder: 'sequential', maxParallel: 1 },
  })
  return makeRun(results, team)
}

function runWithUnifiedRevise(effectiveIds: string[], opts: UnifiedReviseOptions): ExpertTeamRun {
  const team = teamWith(['m-exec-1', 'm-exec-2'], ['m-rev-1'], {
    review: { mode: 'unified', maxRevisionRounds: opts.maxRevisionRounds },
  })
  const results: ExpertTeamResult[] = []
  if (opts.cycleOpen === true) {
    // 已有一轮全员 revise 审查，随后产生一份同周期 revision，且尚未发起新一轮全员复审。
    const [first, ...rest] = effectiveIds
    if (first !== undefined) {
      const originalId = `${first}-original`
      results.push(executeResult(originalId, { memberId: 'm-exec-1' }))
      rest.forEach((resultId, index) => {
        results.push(executeResult(resultId, { memberId: index === 0 ? 'm-exec-2' : 'm-exec-1' }))
      })
      results.push(reviewResult('unified-open-review', 'revise', { inputResultIds: [originalId, ...rest] }))
      results.push(executeResult(first, {
        memberId: 'm-exec-1',
        kind: 'revision',
        supersedesResultId: originalId,
        inputResultIds: [originalId],
      }))
    }
  } else {
    // 当前有效结果集上已完成全员统一审查，尚无新一轮 revision。
    effectiveIds.forEach((resultId, index) => {
      results.push(executeResult(resultId, { memberId: index % 2 === 0 ? 'm-exec-1' : 'm-exec-2' }))
    })
    results.push(reviewResult('unified-closed-review', 'revise', { inputResultIds: [...effectiveIds] }))
  }
  return makeRun(results, team, { unifiedRevisionRounds: opts.unifiedRevisionRounds })
}

function runWithPerMemberChain(opts: PerMemberChainOptions): ExpertTeamRun {
  const team = teamWith([opts.memberId], ['m-rev-1'], {
    review: { mode: 'per-member', maxRevisionRounds: opts.maxRevisionRounds },
  })
  const results: ExpertTeamResult[] = []
  let currentId = 'r1'
  results.push(executeResult(currentId, { memberId: opts.memberId }))
  for (let round = 1; round <= opts.revisionsInChain; round += 1) {
    const nextId = round === 1 ? 'r1-rev' : `r1-rev${round}`
    results.push(executeResult(nextId, {
      memberId: opts.memberId,
      kind: 'revision',
      supersedesResultId: currentId,
      inputResultIds: [currentId],
    }))
    currentId = nextId
  }
  results.push(reviewResult(`per-member-review-${opts.revisionsInChain}`, 'revise', { inputResultIds: [currentId] }))
  return makeRun(results, team)
}

function runWithUnattemptedBroadcastExecutor(overrides: RunOverrides = {}): ExpertTeamRun {
  const team = teamWith(['m-exec-1', 'm-exec-2'], [], {
    orchestration: { assignmentMode: 'broadcast', executionOrder: 'parallel', maxParallel: 2 },
  })
  return makeRun([executeResult('broadcast-execute-1', { memberId: 'm-exec-1' })], team, overrides)
}

/** 有效执行加一份有效 `revise` 审查：返修额度未用尽且周期未开启，必要返修尚未执行。 */
function runWithNecessaryRevisionPending(overrides: RunOverrides = {}): ExpertTeamRun {
  const team = teamWith(['m-exec-1'], ['m-rev-1'], { review: { mode: 'unified', maxRevisionRounds: 1 } })
  const execute = executeResult('pending-revision-execute', { memberId: 'm-exec-1' })
  return makeRun(
    [execute, reviewResult('pending-revision-review', 'revise', { inputResultIds: [execute.resultId] })],
    team,
    { unifiedRevisionRounds: 0, ...overrides },
  )
}

/** 另一名成员的 `failed` 执行从未被后续有效结果替代。 */
function runWithUnsupersededFailedExecute(overrides: RunOverrides = {}): ExpertTeamRun {
  const team = teamWith(['m-exec-1', 'm-exec-2'], ['m-rev-1'], { review: { mode: 'unified', maxRevisionRounds: 1 } })
  const valid = executeResult('unsuperseded-execute', { memberId: 'm-exec-1' })
  const failed = executeResult('unsuperseded-failed-execute', { memberId: 'm-exec-2', status: 'failed' })
  return makeRun(
    [valid, failed, reviewResult('unsuperseded-review', 'pass', { inputResultIds: [valid.resultId] })],
    team,
    overrides,
  )
}

/** 同一失败执行被后续有效 execute 重试（supersedesResultId）替代。 */
function runWithRetriedFailedExecute(overrides: RunOverrides = {}): ExpertTeamRun {
  const team = teamWith(['m-exec-1', 'm-exec-2'], ['m-rev-1'], { review: { mode: 'unified', maxRevisionRounds: 1 } })
  const valid = executeResult('retry-execute', { memberId: 'm-exec-1' })
  const failed = executeResult('retry-failed-execute', { memberId: 'm-exec-2', status: 'failed' })
  const retry = executeResult('retry-superseding-execute', {
    memberId: 'm-exec-2',
    supersedesResultId: failed.resultId,
  })
  return makeRun(
    [
      valid,
      failed,
      retry,
      reviewResult('retry-review', 'pass', { inputResultIds: [valid.resultId, retry.resultId] }),
    ],
    team,
    overrides,
  )
}

/** 成功的 `revise` 审查之后返修本身失败：失败返修不替代旧有效结果，但仍属技术缺失。 */
function runWithFailedRevision(overrides: RunOverrides = {}): ExpertTeamRun {
  const team = teamWith(['m-exec-1'], ['m-rev-1'], { review: { mode: 'unified', maxRevisionRounds: 1 } })
  const original = executeResult('failed-revision-original', { memberId: 'm-exec-1' })
  const failedRevision = executeResult('failed-revision', {
    memberId: 'm-exec-1',
    kind: 'revision',
    status: 'failed',
    supersedesResultId: original.resultId,
    inputResultIds: [original.resultId],
  })
  return makeRun(
    [
      original,
      reviewResult('failed-revision-review', 'revise', { inputResultIds: [original.resultId] }),
      failedRevision,
    ],
    team,
    overrides,
  )
}

describe('expert team orchestration rules', () => {
  it('resolves unified scope at entry and rejects empty/subset/stale scopes', () => {
    const run = runWithResults([executeResult('r1'), executeResult('r2')])
    expect(resolveReviewScope(run, { kind: 'review', memberId: 'reviewer' })).toEqual({ ok: true, inputResultIds: ['r1', 'r2'] })
    expect(resolveReviewScope(run, { kind: 'review', memberId: 'reviewer', inputResultIds: ['r1'] })).toMatchObject({ ok: false, error: 'expert-team-review-scope' })
    expect(resolveReviewScope(runWithResults([]), { kind: 'review', memberId: 'reviewer' })).toMatchObject({ ok: false, error: 'expert-team-empty-review-scope' })
    expect(assertReviewScopeCurrent(runWithResults([executeResult('r3')]), ['r1', 'r2'])).toBe('expert-team-review-scope-changed')
  })

  it('rejects stale per-member review scopes at dequeue re-validation', () => {
    const perMemberRun = runWithReviewMode('per-member', [
      executeResult('r1', { memberId: 'm-exec-1' }),
      executeResult('r2', { memberId: 'm-exec-2' }),
    ])
    expect(assertReviewScopeCurrent(perMemberRun, ['r1', 'r2'])).toBe('expert-team-review-scope-changed')
    expect(assertReviewScopeCurrent(perMemberRun, ['r1'])).toBeUndefined()

    // 目标结果被后续有效返修替代后，出队重验必须失败而不是换成另一组结果。
    const supersededRun = runWithReviewMode('per-member', [
      executeResult('r1', { memberId: 'm-exec-1' }),
      executeResult('r1-rev', { memberId: 'm-exec-1', kind: 'revision', supersedesResultId: 'r1' }),
      executeResult('r2', { memberId: 'm-exec-2' }),
    ])
    expect(assertReviewScopeCurrent(supersededRun, ['r1'])).toBe('expert-team-review-scope-changed')
    expect(assertReviewScopeCurrent(supersededRun, ['r1-rev'])).toBeUndefined()
  })

  it('keeps the previous valid result when a revision fails', () => {
    const original = executeResult('original')
    const failedRevision = { ...executeResult('failed'), kind: 'revision' as const, status: 'failed' as const, supersedesResultId: 'original' }
    expect(currentEffectiveResultIds(runWithResults([original, failedRevision]))).toEqual(['original'])
  })

  it('distinguishes invalid reviews from exhausted business revisions, covers all terminal statuses including message mode, and marks artifactLinkError as partial', () => {
    expect(computeExpertTeamTerminalStatus({ run: runWithResults([]), finalSummaryPresent: true })).toBe('failed')
    expect(computeExpertTeamTerminalStatus({ run: runWithCompletedDelivery(), finalSummaryPresent: true })).toBe('completed')
    expect(computeExpertTeamTerminalStatus({ run: runWithInvalidReview(), finalSummaryPresent: true })).toBe('partial')
    expect(computeExpertTeamTerminalStatus({ run: runWithExhaustedRevision(), finalSummaryPresent: true })).toBe('completed_with_issues')
    expect(computeExpertTeamTerminalStatus({
      run: runWithExhaustedRevision({ artifactStatus: 'pending', artifactLinkError: 'expert-team-artifact-link-failed' }),
      finalSummaryPresent: true,
    })).toBe('partial')
    expect(computeExpertTeamTerminalStatus({ run: runWithMessageDelivery(), finalSummaryPresent: false })).toBe('partial')
    expect(computeExpertTeamTerminalStatus({ run: runWithMessageDelivery(), finalSummaryPresent: true })).toBe('completed')
    expect(computeExpertTeamTerminalStatus({
      run: runWithCompletedDelivery(),
      finalSummaryPresent: true,
      protocolError: 'expert-team-attachment-detach-failed',
    })).toBe('partial')
  })

  it('rejects submission and settles partial while a necessary revision remains within quota', () => {
    const pending = runWithNecessaryRevisionPending()
    expect(canSubmitPrimaryArtifact(pending, { inFlight: false, artifactFormat: 'markdown', callId: 'call-pending-revision' })).toEqual({
      ok: false,
      error: 'expert-team-review-incomplete',
    })
    // 已关联主 Artifact 也必须因额度内必要返修未执行而结 partial。
    expect(computeExpertTeamTerminalStatus({
      run: runWithNecessaryRevisionPending({
        primaryArtifactId: 'artifact-pending-revision',
        artifactStatus: 'created',
        deliverySealed: true,
      }),
      finalSummaryPresent: true,
    })).toBe('partial')
  })

  it('treats unsuperseded failed executions and revisions as partial and clears the gap after a valid retry', () => {
    expect(computeExpertTeamTerminalStatus({
      run: runWithUnsupersededFailedExecute({
        primaryArtifactId: 'artifact-unsuperseded',
        artifactStatus: 'created',
        deliverySealed: true,
      }),
      finalSummaryPresent: true,
    })).toBe('partial')
    // 同一失败 execute 被后续有效 execute 重试替代后不再算技术缺失。
    expect(computeExpertTeamTerminalStatus({
      run: runWithRetriedFailedExecute({
        primaryArtifactId: 'artifact-retried',
        artifactStatus: 'created',
        deliverySealed: true,
      }),
      finalSummaryPresent: true,
    })).toBe('completed')
    // 失败返修不替代旧有效结果，但仍属未被替代的技术缺失。
    expect(computeExpertTeamTerminalStatus({
      run: runWithFailedRevision({
        primaryArtifactId: 'artifact-failed-revision',
        artifactStatus: 'created',
        deliverySealed: true,
      }),
      finalSummaryPresent: true,
    })).toBe('partial')
  })

  it('settles partial when a broadcast executor never produced a first-round result', () => {
    const delivered: RunOverrides = {
      primaryArtifactId: 'artifact-broadcast',
      artifactStatus: 'created',
      deliverySealed: true,
    }
    expect(computeExpertTeamTerminalStatus({
      run: runWithUnattemptedBroadcastExecutor(delivered),
      finalSummaryPresent: true,
    })).toBe('partial')
    // 24 次派工豁免只影响主报告提交，不改变结算终态。
    expect(computeExpertTeamTerminalStatus({
      run: runWithUnattemptedBroadcastExecutor({ ...delivered, dispatchAttempts: 24 }),
      finalSummaryPresent: true,
    })).toBe('partial')
  })

  it('enforces none/per-member scope rules, sequential order, execute retry via supersedesResultId, and 0/1/2 revision rounds', () => {
    // review.mode === 'none' 禁止 review 与 revision
    const noneReviewRun = runWithReviewMode('none', [executeResult('r1', { memberId: 'm-exec-1' })])
    expect(validateDispatchRule(noneReviewRun, { memberId: 'm-rev-1', kind: 'review', task: '不应允许' })).toEqual({
      ok: false,
      error: 'expert-team-review-disabled',
    })
    expect(validateDispatchRule(noneReviewRun, { memberId: 'm-exec-1', kind: 'revision', task: '不应允许', supersedesResultId: 'r1' })).toEqual({
      ok: false,
      error: 'expert-team-review-disabled',
    })

    // per-member scope 必须显式提供目标单例（省略或多选均拒绝）
    const perMemberScopeRun = runWithReviewMode('per-member', [executeResult('r1', { memberId: 'm-exec-1' }), executeResult('r2', { memberId: 'm-exec-2' })])
    expect(resolveReviewScope(perMemberScopeRun, { kind: 'review', memberId: 'm-rev-1' })).toMatchObject({ ok: false, error: 'expert-team-review-scope' })
    expect(resolveReviewScope(perMemberScopeRun, { kind: 'review', memberId: 'm-rev-1', inputResultIds: ['r1', 'r2'] })).toMatchObject({ ok: false, error: 'expert-team-review-scope' })
    expect(resolveReviewScope(perMemberScopeRun, { kind: 'review', memberId: 'm-rev-1', inputResultIds: ['r1'] })).toEqual({ ok: true, inputResultIds: ['r1'] })

    const seqRun = runWithSequentialExecutors(['m-exec-1', 'm-exec-2'])
    expect(validateDispatchRule(seqRun, { memberId: 'm-exec-2', kind: 'execute', task: '抢跑' })).toEqual({
      ok: false,
      error: 'expert-team-sequential-order',
    })
    const afterFirst = runWithSequentialExecutors(['m-exec-1', 'm-exec-2'], [executeResult('r1', { memberId: 'm-exec-1' })])
    expect(validateDispatchRule(afterFirst, { memberId: 'm-exec-2', kind: 'execute', task: '未引用前序', inputResultIds: [] })).toEqual({
      ok: false,
      error: 'expert-team-sequential-reference',
    })
    expect(validateDispatchRule(afterFirst, { memberId: 'm-exec-2', kind: 'execute', task: '引用前序', inputResultIds: ['r1'] })).toEqual({ ok: true })

    // execute + supersedesResultId 仅允许重试同成员失败/停止的 execute，且不消耗返修轮数
    const failedExecRun = runWithResults([executeResult('r-fail', { memberId: 'm-exec-1', status: 'failed' })])
    expect(validateDispatchRule(failedExecRun, { memberId: 'm-exec-1', kind: 'execute', task: '重试', supersedesResultId: 'r-fail' })).toEqual({ ok: true })
    expect(validateDispatchRule(afterFirst, { memberId: 'm-exec-1', kind: 'execute', task: '试图替代成功结果', supersedesResultId: 'r1' })).toEqual({
      ok: false,
      error: 'expert-team-invalid-supersede',
    })

    // maxRevisionRounds = 0：首次返修即被拒，有有效 revise 即可结 completed_with_issues
    const zeroQuotaUnified = runWithUnifiedRevise(['r1', 'r2'], { maxRevisionRounds: 0, unifiedRevisionRounds: 0 })
    expect(validateDispatchRule(zeroQuotaUnified, { memberId: 'm-exec-1', kind: 'revision', task: '0 额度返修', supersedesResultId: 'r1' })).toEqual({
      ok: false,
      error: 'expert-team-revision-limit',
    })

    // unified 返修周期（maxRevisionRounds = 1）：首份返修开启周期（opensUnifiedRevisionCycle=true），同周期第二名成员返修复用，全员复审关闭周期后超额返修被拒
    const unifiedReviseRun = runWithUnifiedRevise(['r1', 'r2'], { maxRevisionRounds: 1, unifiedRevisionRounds: 0 })
    expect(validateDispatchRule(unifiedReviseRun, { memberId: 'm-exec-1', kind: 'revision', task: '返修 1', supersedesResultId: 'r1' })).toEqual({
      ok: true,
      opensUnifiedRevisionCycle: true,
    })
    const midCycleRun = runWithUnifiedRevise(['r1-rev', 'r2'], { maxRevisionRounds: 1, unifiedRevisionRounds: 1, cycleOpen: true })
    expect(validateDispatchRule(midCycleRun, { memberId: 'm-exec-2', kind: 'revision', task: '同周期返修 2', supersedesResultId: 'r2' })).toEqual({
      ok: true,
      opensUnifiedRevisionCycle: false,
    })
    const exhaustedUnified = runWithUnifiedRevise(['r1-rev', 'r2-rev'], { maxRevisionRounds: 1, unifiedRevisionRounds: 1, cycleOpen: false })
    expect(validateDispatchRule(exhaustedUnified, { memberId: 'm-exec-1', kind: 'revision', task: '超额返修', supersedesResultId: 'r1-rev' })).toEqual({
      ok: false,
      error: 'expert-team-revision-limit',
    })

    // maxRevisionRounds = 2：允许开启第 2 轮周期，第 2 轮复审关闭后再返修被拒
    const round2Open = runWithUnifiedRevise(['r1-rev', 'r2-rev'], { maxRevisionRounds: 2, unifiedRevisionRounds: 1, cycleOpen: false })
    expect(validateDispatchRule(round2Open, { memberId: 'm-exec-1', kind: 'revision', task: '第 2 轮返修', supersedesResultId: 'r1-rev' })).toEqual({
      ok: true,
      opensUnifiedRevisionCycle: true,
    })
    const round2Exhausted = runWithUnifiedRevise(['r1-rev2', 'r2-rev'], { maxRevisionRounds: 2, unifiedRevisionRounds: 2, cycleOpen: false })
    expect(validateDispatchRule(round2Exhausted, { memberId: 'm-exec-1', kind: 'revision', task: '超 2 轮返修', supersedesResultId: 'r1-rev2' })).toEqual({
      ok: false,
      error: 'expert-team-revision-limit',
    })

    // per-member 按单条结果链的 revision 次数独立计数（覆盖 0/1/2）
    const perMemberRun = runWithPerMemberChain({ memberId: 'm-exec-1', revisionsInChain: 1, maxRevisionRounds: 1 })
    expect(validateDispatchRule(perMemberRun, { memberId: 'm-exec-1', kind: 'revision', task: '单链超额', supersedesResultId: 'r1-rev' })).toEqual({
      ok: false,
      error: 'expert-team-revision-limit',
    })
    const perMemberRound2 = runWithPerMemberChain({ memberId: 'm-exec-1', revisionsInChain: 1, maxRevisionRounds: 2 })
    expect(validateDispatchRule(perMemberRound2, { memberId: 'm-exec-1', kind: 'revision', task: '单链第 2 轮', supersedesResultId: 'r1-rev' })).toMatchObject({ ok: true })
  })

  it('allows partial artifact when every required member/reviewer has at least technical failure evidence, and waives unattempted broadcast/review obligations only at 24 attempts', () => {
    const failedReviewRun = runWithInvalidReview({ artifactStatus: 'pending', deliverySealed: false })
    expect(canSubmitPrimaryArtifact(failedReviewRun, { inFlight: false, artifactFormat: 'markdown', callId: 'call-partial' })).toEqual({ ok: true })
    const run = runWithMissingReview({ dispatchAttempts: 24, artifactStatus: 'pending', deliverySealed: false })
    expect(canSubmitPrimaryArtifact(run, { inFlight: false, artifactFormat: 'markdown', callId: 'call-new' })).toEqual({ ok: true })
    expect(canSubmitPrimaryArtifact(run, { inFlight: true, artifactFormat: 'markdown', callId: 'call-new' })).toMatchObject({ ok: false, error: 'expert-team-dispatch-in-flight' })
    expect(canSubmitPrimaryArtifact({ ...run, dispatchAttempts: 23 }, { inFlight: false, artifactFormat: 'markdown', callId: 'call-new' })).toMatchObject({ ok: false, error: 'expert-team-review-incomplete' })
    expect(canSubmitPrimaryArtifact(run, { inFlight: false, artifactFormat: 'html', callId: 'call-new' })).toMatchObject({ ok: false, error: 'expert-team-artifact-format' })

    const broadcastMissing = runWithUnattemptedBroadcastExecutor({ dispatchAttempts: 23 })
    expect(canSubmitPrimaryArtifact(broadcastMissing, { inFlight: false, artifactFormat: 'markdown', callId: 'call-b1' })).toMatchObject({
      ok: false,
      error: 'expert-team-broadcast-incomplete',
    })
    expect(canSubmitPrimaryArtifact({ ...broadcastMissing, dispatchAttempts: 24 }, { inFlight: false, artifactFormat: 'markdown', callId: 'call-b2' })).toEqual({ ok: true })
  })
})
