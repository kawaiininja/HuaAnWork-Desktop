import type { ArtifactFormat, ExpertTeamResult, ExpertTeamRun } from '../../client-huaanwork/rpc-types.ts'

/**
 * 专家团确定性调度规则（设计 §10.1 / §10.2 / §10.4 / §12.4）。
 *
 * 本模块只服务纯函数边界：不读时钟、不写注册表、不产生事件。所有「当前」事实都从
 * `ExpertTeamRun.results` 与团队快照派生，保证同一输入在入口、出队重验和回合结算
 * 得到同一结论。`unified` 返修周期的开/闭完全由结果链派生，`cycleOpen` 不是运行字段。
 */

const SCOPE_SEPARATOR = '\u0000'

/** 派工校验输入：与 `expert_team_dispatch` 参数同构，`task` 正文不参与规则判定。 */
export type ExpertTeamDispatchRuleInput = {
  memberId: string
  kind: 'execute' | 'review' | 'revision'
  task: string
  inputResultIds?: string[]
  supersedesResultId?: string
}

/** 审查 scope 解析输入；省略 `task`，供工具入口与出队重验共用。 */
export type ReviewScopeInput = {
  memberId: string
  kind: 'execute' | 'review' | 'revision'
  inputResultIds?: string[]
}

export type ReviewScopeFailure =
  | 'expert-team-review-disabled'
  | 'expert-team-empty-review-scope'
  | 'expert-team-review-scope'

export type ReviewScopeResolution =
  | { ok: true; inputResultIds: string[] }
  | { ok: false; error: ReviewScopeFailure }

export type DispatchRuleFailure =
  | 'expert-team-member-missing'
  | 'expert-team-member-role-mismatch'
  | 'expert-team-review-disabled'
  | 'expert-team-broadcast-incomplete'
  | 'expert-team-invalid-input-result'
  | 'expert-team-sequential-order'
  | 'expert-team-sequential-reference'
  | 'expert-team-invalid-supersede'
  | 'expert-team-revision-not-requested'
  | 'expert-team-revision-limit'

/**
 * 规则校验结果。`opensUnifiedRevisionCycle` 只在 `unified` 返修被允许时出现：
 * `true` 表示本次返修开启新周期（协调器需同步递增 `unifiedRevisionRounds`），
 * `false` 表示复用当前周期。其它派工成功时不写该键。
 */
export type DispatchRuleValidation =
  | { ok: true; opensUnifiedRevisionCycle?: boolean }
  | { ok: false; error: DispatchRuleFailure }

export type PrimaryArtifactFailure =
  | 'expert-team-terminal'
  | 'expert-team-delivery-sealed'
  | 'expert-team-no-valid-execution'
  | 'expert-team-dispatch-in-flight'
  | 'expert-team-artifact-format'
  | 'expert-team-broadcast-incomplete'
  | 'expert-team-review-incomplete'

export type PrimaryArtifactSubmission = {
  /** 在途派工（含等待队列与尚未 settle 的成员 run）。 */
  inFlight: boolean
  artifactFormat: ArtifactFormat
  callId: string
}

export type PrimaryArtifactDecision =
  | { ok: true }
  | { ok: false; error: PrimaryArtifactFailure }

export type ExpertTeamTerminalStatus = 'completed' | 'completed_with_issues' | 'partial' | 'failed'

export type ExpertTeamTerminalStatusInput = {
  run: ExpertTeamRun
  finalSummaryPresent: boolean
  protocolError?: string
}

type ReviewAttemptState = 'pass' | 'revise' | 'failed' | 'stopped' | 'invalid' | 'incomplete' | 'pending'

type LatestReviewAttempt = { index: number; state: ReviewAttemptState }

type UnifiedReviewRound = { scope: string[]; lastIndex: number; hasRevise: boolean }

function isNonBlankText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== ''
}

/** 有效执行结果：completed、非空成员文本、无结果级 error 的 execute/revision（§8.4）。 */
function isValidExecutionResult(result: ExpertTeamResult): boolean {
  return (
    (result.kind === 'execute' || result.kind === 'revision') &&
    result.status === 'completed' &&
    result.error === undefined &&
    isNonBlankText(result.output)
  )
}

function normalizeResultIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort()
}

function sameResultIds(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = normalizeResultIds(left)
  const normalizedRight = normalizeResultIds(right)
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((resultId, index) => resultId === normalizedRight[index])
  )
}

/**
 * 当前有效结果集（§10.4）：只保留有效 execute/revision，并排除被后续有效结果的
 * `supersedesResultId` 指向的结果；按 resultId 排序去重。失败返修不替代旧有效结果。
 */
export function currentEffectiveResultIds(run: ExpertTeamRun): string[] {
  const valid = run.results.filter(isValidExecutionResult)
  const superseded = new Set<string>()
  for (const result of valid) {
    if (result.supersedesResultId !== undefined) superseded.add(result.supersedesResultId)
  }
  const effective = new Set<string>()
  for (const result of valid) {
    if (superseded.has(result.resultId)) continue
    effective.add(result.resultId)
  }
  return [...effective].sort()
}

function reviewerMemberIds(run: ExpertTeamRun): string[] {
  return run.teamSnapshot.members
    .filter((member) => member.role === 'reviewer')
    .map((member) => member.memberId)
}

function executorMemberIds(run: ExpertTeamRun): string[] {
  return run.teamSnapshot.members
    .filter((member) => member.role === 'executor')
    .map((member) => member.memberId)
}

/**
 * 解析本次审查的规范化 scope：unified 省略 ID 时返回当前有效全集，显式输入必须与
 * 全集完全相等；per-member 只接受当前有效结果中的单个目标；空全集禁止 review。
 *
 * 非 review 派工不适用审查 scope 规则，原样返回输入引用，供统一入口复用。
 */
export function resolveReviewScope(run: ExpertTeamRun, input: ReviewScopeInput): ReviewScopeResolution {
  if (input.kind !== 'review') {
    return { ok: true, inputResultIds: [...(input.inputResultIds ?? [])] }
  }
  const mode = run.teamSnapshot.review.mode
  if (mode === 'none') return { ok: false, error: 'expert-team-review-disabled' }
  const effective = currentEffectiveResultIds(run)
  if (effective.length === 0) return { ok: false, error: 'expert-team-empty-review-scope' }
  const explicit = input.inputResultIds
  if (mode === 'unified') {
    if (explicit === undefined) return { ok: true, inputResultIds: effective }
    if (!sameResultIds(explicit, effective)) return { ok: false, error: 'expert-team-review-scope' }
    return { ok: true, inputResultIds: effective }
  }
  if (explicit === undefined) return { ok: false, error: 'expert-team-review-scope' }
  const normalized = normalizeResultIds(explicit)
  if (normalized.length !== 1) return { ok: false, error: 'expert-team-review-scope' }
  const target = normalized[0]
  if (target === undefined || !effective.includes(target)) {
    return { ok: false, error: 'expert-team-review-scope' }
  }
  return { ok: true, inputResultIds: [target] }
}

/**
 * 出队启动成员前重验入口解析的 scope。当前全集变化时明确失败，绝不在等待后
 * 静默换成另一组结果（§10.4 / §12.3）。
 */
export function assertReviewScopeCurrent(
  run: ExpertTeamRun,
  resolvedInputResultIds: readonly string[],
): 'expert-team-review-scope-changed' | undefined {
  const mode = run.teamSnapshot.review.mode
  if (mode === 'none') return 'expert-team-review-scope-changed'
  const effective = currentEffectiveResultIds(run)
  if (mode === 'per-member') {
    const normalized = normalizeResultIds(resolvedInputResultIds)
    if (normalized.length !== 1) return 'expert-team-review-scope-changed'
    const target = normalized[0]
    if (target === undefined || !effective.includes(target)) return 'expert-team-review-scope-changed'
    return undefined
  }
  return sameResultIds(resolvedInputResultIds, effective) ? undefined : 'expert-team-review-scope-changed'
}

function reviewAttemptState(result: ExpertTeamResult): ReviewAttemptState {
  if (result.status === 'failed') return 'failed'
  if (result.status === 'stopped') return 'stopped'
  if (result.status !== 'completed') return 'pending'
  if (result.error !== undefined) return 'failed'
  if (result.reviewError === 'invalid-verdict') return 'invalid'
  if (result.reviewVerdict === 'pass') return 'pass'
  if (result.reviewVerdict === 'revise') return 'revise'
  return 'incomplete'
}

/** 同一审查成员与同一规范化 scope 的最新审查尝试决定该 scope 的技术完整性。 */
function latestReviewAttempt(
  run: ExpertTeamRun,
  reviewerId: string,
  scope: readonly string[],
): LatestReviewAttempt | undefined {
  for (let index = run.results.length - 1; index >= 0; index -= 1) {
    const result = run.results[index]
    if (result === undefined) continue
    if (result.kind !== 'review') continue
    if (result.memberId !== reviewerId) continue
    if (!sameResultIds(result.inputResultIds, scope)) continue
    return { index, state: reviewAttemptState(result) }
  }
  return undefined
}

/** unified 的必审 scope 是当前有效全集；per-member 的每个有效结果各自成 scope。 */
function requiredReviewScopes(run: ExpertTeamRun): string[][] {
  const mode = run.teamSnapshot.review.mode
  if (mode === 'none') return []
  const effective = currentEffectiveResultIds(run)
  if (effective.length === 0) return []
  if (mode === 'unified') return [effective]
  return effective.map((resultId) => [resultId])
}

/**
 * 最近一次「全员统一审查」：同一规范化 scope 下每名审查成员的最新尝试都有效。
 * `lastIndex` 是该轮最后一条审查结果的数组位置，用于判断之后是否已有同周期返修。
 */
function latestFullUnifiedRound(run: ExpertTeamRun): UnifiedReviewRound | undefined {
  const reviewers = reviewerMemberIds(run)
  if (reviewers.length === 0) return undefined
  const reviewerSet = new Set(reviewers)
  const rounds = new Map<
    string,
    { scope: string[]; lastIndex: number; verdicts: Map<string, 'pass' | 'revise'> }
  >()
  run.results.forEach((result, index) => {
    if (result.kind !== 'review') return
    if (!reviewerSet.has(result.memberId)) return
    const scope = normalizeResultIds(result.inputResultIds)
    const key = scope.join(SCOPE_SEPARATOR)
    let round = rounds.get(key)
    if (round === undefined) {
      round = { scope, lastIndex: index, verdicts: new Map() }
      rounds.set(key, round)
    }
    round.lastIndex = index
    const state = reviewAttemptState(result)
    if (state === 'pass' || state === 'revise') round.verdicts.set(result.memberId, state)
    else round.verdicts.delete(result.memberId)
  })
  let latest: UnifiedReviewRound | undefined
  for (const round of rounds.values()) {
    if (round.verdicts.size !== reviewers.length) continue
    if (latest === undefined || round.lastIndex > latest.lastIndex) {
      latest = {
        scope: round.scope,
        lastIndex: round.lastIndex,
        hasRevise: [...round.verdicts.values()].includes('revise'),
      }
    }
  }
  return latest
}

/**
 * 统一返修周期是否处于开启态：最近一次全员统一审查给出 `revise`，且之后已有同
 * 周期返修结果、尚未发起下一次全员统一审查。
 */
function unifiedCycleOpen(run: ExpertTeamRun, round: UnifiedReviewRound): boolean {
  if (!round.hasRevise) return false
  const reviewedScope = new Set(round.scope)
  for (let index = round.lastIndex + 1; index < run.results.length; index += 1) {
    const result = run.results[index]
    if (result === undefined) continue
    if (result.kind !== 'revision') continue
    if (result.supersedesResultId === undefined) continue
    if (reviewedScope.has(result.supersedesResultId)) return true
  }
  return false
}

/**
 * per-member 结果链中的 revision 次数：从目标结果沿 `supersedesResultId` 双向遍历
 * 连通链，统计链上所有 revision 结果（失败的返修同样消耗业务轮次）。
 */
function perMemberChainRevisionCount(run: ExpertTeamRun, targetId: string): number {
  const neighbors = new Map<string, Set<string>>()
  const link = (left: string, right: string): void => {
    let leftSet = neighbors.get(left)
    if (leftSet === undefined) {
      leftSet = new Set()
      neighbors.set(left, leftSet)
    }
    leftSet.add(right)
    let rightSet = neighbors.get(right)
    if (rightSet === undefined) {
      rightSet = new Set()
      neighbors.set(right, rightSet)
    }
    rightSet.add(left)
  }
  for (const result of run.results) {
    if (result.supersedesResultId === undefined) continue
    link(result.resultId, result.supersedesResultId)
  }
  const visited = new Set<string>([targetId])
  const queue = [targetId]
  let cursor = 0
  while (cursor < queue.length) {
    const current = queue[cursor]
    cursor += 1
    if (current === undefined) continue
    const linked = neighbors.get(current)
    if (linked === undefined) continue
    for (const next of linked) {
      if (visited.has(next)) continue
      visited.add(next)
      queue.push(next)
    }
  }
  const revisions = new Set<string>()
  for (const result of run.results) {
    if (result.kind !== 'revision') continue
    if (!visited.has(result.resultId)) continue
    revisions.add(result.resultId)
  }
  return revisions.size
}

function perMemberHasRevise(run: ExpertTeamRun, targetId: string): boolean {
  return reviewerMemberIds(run).some(
    (reviewer) => latestReviewAttempt(run, reviewer, [targetId])?.state === 'revise',
  )
}

function perMemberNecessaryRevisionPending(run: ExpertTeamRun): boolean {
  const maxRounds = run.teamSnapshot.review.maxRevisionRounds
  for (const targetId of currentEffectiveResultIds(run)) {
    if (!perMemberHasRevise(run, targetId)) continue
    if (perMemberChainRevisionCount(run, targetId) < maxRounds) return true
  }
  return false
}

/** 当前审查轮 / 结果链仍有返修额度，且存在有效 `revise` 却未执行必要返修（§10.4）。 */
function reviewNecessaryRevisionPending(run: ExpertTeamRun): boolean {
  const mode = run.teamSnapshot.review.mode
  if (mode === 'none') return false
  if (mode === 'unified') {
    const round = latestFullUnifiedRound(run)
    if (round === undefined || !round.hasRevise) return false
    if (unifiedCycleOpen(run, round)) return false
    if (!sameResultIds(round.scope, currentEffectiveResultIds(run))) return false
    return run.unifiedRevisionRounds < run.teamSnapshot.review.maxRevisionRounds
  }
  return perMemberNecessaryRevisionPending(run)
}

/**
 * 已被后续有效执行/返修结果解决的失败/非有效执行记录集合（§12.3 / §12.4.2）。
 *
 * 两种替代路径：
 * 1. 传递闭包：从每个有效执行/返修结果沿 `supersedesResultId` 向上追溯整个祖先链
 *    （覆盖连续多次链式失败的 `execute` 最终被后续有效 `execute` 替代）；
 * 2. 星型重试/返修：同成员在更晚索引存在有效执行/返修结果替代同一目标
 *    （对 `execute` 沿其失败祖先链检查，覆盖星型与链式+星型混合重试；对 `revision`
 *    只检查直接目标，避免跨返修轮误豁免）。
 */
function resolvedExecutionFailureIds(run: ExpertTeamRun): Set<string> {
  const byId = new Map<string, ExpertTeamResult>()
  for (const result of run.results) {
    byId.set(result.resultId, result)
  }

  const supersededByValid = new Set<string>()
  for (const result of run.results) {
    if (!isValidExecutionResult(result)) continue
    let targetId = result.supersedesResultId
    const visited = new Set<string>([result.resultId])
    while (targetId !== undefined && !visited.has(targetId)) {
      visited.add(targetId)
      supersededByValid.add(targetId)
      targetId = byId.get(targetId)?.supersedesResultId
    }
  }

  const latestValidSupersedeIndex = new Map<string, number>()
  run.results.forEach((result, index) => {
    if (!isValidExecutionResult(result)) return
    if (result.supersedesResultId === undefined) return
    latestValidSupersedeIndex.set(`${result.memberId}${SCOPE_SEPARATOR}${result.supersedesResultId}`, index)
  })

  const resolved = new Set<string>(supersededByValid)
  for (let index = 0; index < run.results.length; index += 1) {
    const result = run.results[index]
    if (result === undefined) continue
    if (result.kind !== 'execute' && result.kind !== 'revision') continue
    if (isValidExecutionResult(result)) continue
    if (resolved.has(result.resultId)) continue
    if (result.supersedesResultId === undefined) continue
    let ancestorId: string | undefined = result.supersedesResultId
    const visited = new Set<string>([result.resultId])
    while (ancestorId !== undefined && !visited.has(ancestorId)) {
      visited.add(ancestorId)
      const laterValidIndex = latestValidSupersedeIndex.get(
        `${result.memberId}${SCOPE_SEPARATOR}${ancestorId}`,
      )
      if (laterValidIndex !== undefined && laterValidIndex > index) {
        resolved.add(result.resultId)
        break
      }
      if (result.kind === 'revision') break
      ancestorId = byId.get(ancestorId)?.supersedesResultId
    }
  }
  return resolved
}

/** 任何未被后续有效结果替代的非有效执行或返修都是技术缺失（§12.4.2）。 */
function hasUnsupersededExecutionFailure(run: ExpertTeamRun): boolean {
  const resolved = resolvedExecutionFailureIds(run)
  for (const result of run.results) {
    if (result.kind !== 'execute' && result.kind !== 'revision') continue
    if (isValidExecutionResult(result)) continue
    if (resolved.has(result.resultId)) continue
    return true
  }
  return false
}

function broadcastMissingFirstRound(run: ExpertTeamRun): boolean {
  if (run.teamSnapshot.orchestration.assignmentMode !== 'broadcast') return false
  return executorMemberIds(run).some(
    (executorId) =>
      !run.results.some(
        (result) =>
          result.memberId === executorId &&
          result.kind === 'execute' &&
          isValidExecutionResult(result),
      ),
  )
}

/** 审查义务是否有技术缺失：缺失、失败、停止、无效标记或挂起都算不完整。 */
function reviewObligationGap(run: ExpertTeamRun): boolean {
  if (run.teamSnapshot.review.mode === 'none') return false
  const reviewers = reviewerMemberIds(run)
  for (const scope of requiredReviewScopes(run)) {
    for (const reviewer of reviewers) {
      const attempt = latestReviewAttempt(run, reviewer, scope)
      if (attempt === undefined) return true
      if (attempt.state !== 'pass' && attempt.state !== 'revise') return true
    }
  }
  return false
}

function artifactDeliveryGap(run: ExpertTeamRun, finalSummaryPresent: boolean): boolean {
  if (run.teamSnapshot.summary.delivery === 'message') return !finalSummaryPresent
  if (run.primaryArtifactId === undefined) return true
  return run.artifactLinkError !== undefined
}

/** 最新有效审查仍为 `revise`，且当前统一审查轮 / 结果链的返修额度已用尽。 */
function hasExhaustedValidRevise(run: ExpertTeamRun): boolean {
  const mode = run.teamSnapshot.review.mode
  if (mode === 'none') return false
  const maxRounds = run.teamSnapshot.review.maxRevisionRounds
  if (mode === 'unified') {
    const round = latestFullUnifiedRound(run)
    if (round === undefined || !round.hasRevise) return false
    if (unifiedCycleOpen(run, round)) return false
    if (!sameResultIds(round.scope, currentEffectiveResultIds(run))) return false
    return run.unifiedRevisionRounds >= maxRounds
  }
  if (reviewerMemberIds(run).length === 0) return false
  return currentEffectiveResultIds(run).some(
    (targetId) =>
      perMemberHasRevise(run, targetId) &&
      perMemberChainRevisionCount(run, targetId) >= maxRounds,
  )
}

/**
 * 回合结算终态（§12.4.2）。取消不在这里直接判 `stopped`（由清理收敛后
 * `markStopped` 发布），本函数只覆盖失败、部分、完成有遗留项与完成。
 */
export function computeExpertTeamTerminalStatus(
  input: ExpertTeamTerminalStatusInput,
): ExpertTeamTerminalStatus {
  const { run, finalSummaryPresent, protocolError } = input
  if (currentEffectiveResultIds(run).length === 0) return 'failed'
  if (
    protocolError !== undefined ||
    hasUnsupersededExecutionFailure(run) ||
    reviewObligationGap(run) ||
    broadcastMissingFirstRound(run) ||
    reviewNecessaryRevisionPending(run) ||
    artifactDeliveryGap(run, finalSummaryPresent)
  ) {
    return 'partial'
  }
  if (hasExhaustedValidRevise(run)) return 'completed_with_issues'
  return 'completed'
}

function sequentialExecuteError(
  run: ExpertTeamRun,
  memberId: string,
  inputResultIds: readonly string[],
  effective: readonly string[],
): 'expert-team-sequential-order' | 'expert-team-sequential-reference' | undefined {
  const executors = executorMemberIds(run)
  const index = executors.indexOf(memberId)
  if (index <= 0) return undefined
  const earlier = executors.slice(0, index)
  const effectiveByExecutor = new Map<string, string[]>()
  for (const resultId of effective) {
    const result = run.results.find((item) => item.resultId === resultId)
    if (result === undefined) continue
    const ids = effectiveByExecutor.get(result.memberId)
    if (ids === undefined) effectiveByExecutor.set(result.memberId, [resultId])
    else ids.push(resultId)
  }
  for (const earlierMember of earlier) {
    const ids = effectiveByExecutor.get(earlierMember)
    if (ids === undefined || ids.length === 0) return 'expert-team-sequential-order'
  }
  const referenced = new Set(inputResultIds)
  for (const earlierMember of earlier) {
    const ids = effectiveByExecutor.get(earlierMember)
    if (ids === undefined || ids.length === 0) continue
    if (!ids.some((resultId) => referenced.has(resultId))) return 'expert-team-sequential-reference'
  }
  return undefined
}

function validateRevisionRule(
  run: ExpertTeamRun,
  input: ExpertTeamDispatchRuleInput,
  effective: readonly string[],
): DispatchRuleValidation {
  const targetId = input.supersedesResultId
  if (targetId === undefined) return { ok: false, error: 'expert-team-invalid-supersede' }
  const target = run.results.find((result) => result.resultId === targetId)
  if (
    target === undefined ||
    target.memberId !== input.memberId ||
    (target.kind !== 'execute' && target.kind !== 'revision') ||
    !effective.includes(targetId)
  ) {
    return { ok: false, error: 'expert-team-invalid-supersede' }
  }
  if (run.teamSnapshot.review.mode === 'unified') {
    const round = latestFullUnifiedRound(run)
    if (round === undefined || !round.hasRevise) {
      return { ok: false, error: 'expert-team-revision-not-requested' }
    }
    if (unifiedCycleOpen(run, round)) {
      // 同周期返修只能针对最近一轮统一审查范围内的当前有效结果。
      if (!round.scope.includes(targetId)) {
        return { ok: false, error: 'expert-team-revision-not-requested' }
      }
      return { ok: true, opensUnifiedRevisionCycle: false }
    }
    if (!sameResultIds(round.scope, effective)) {
      return { ok: false, error: 'expert-team-revision-not-requested' }
    }
    if (run.unifiedRevisionRounds >= run.teamSnapshot.review.maxRevisionRounds) {
      return { ok: false, error: 'expert-team-revision-limit' }
    }
    return { ok: true, opensUnifiedRevisionCycle: true }
  }
  if (!perMemberHasRevise(run, targetId)) {
    return { ok: false, error: 'expert-team-revision-not-requested' }
  }
  if (perMemberChainRevisionCount(run, targetId) >= run.teamSnapshot.review.maxRevisionRounds) {
    return { ok: false, error: 'expert-team-revision-limit' }
  }
  return { ok: true }
}

/**
 * 确定性派工校验：角色、`review.mode`、输入引用归属、sequential 首轮顺序与引用、
 * execute 技术重试、revision 响应当前有效 `revise` 与返修额度（§10.1 / §10.4 / §12.3）。
 */
export function validateDispatchRule(
  run: ExpertTeamRun,
  input: ExpertTeamDispatchRuleInput,
): DispatchRuleValidation {
  const member = run.teamSnapshot.members.find((item) => item.memberId === input.memberId)
  if (member === undefined) return { ok: false, error: 'expert-team-member-missing' }
  const roleMatches = input.kind === 'review' ? member.role === 'reviewer' : member.role === 'executor'
  if (!roleMatches) return { ok: false, error: 'expert-team-member-role-mismatch' }
  if (
    run.teamSnapshot.review.mode === 'none' &&
    (input.kind === 'review' || input.kind === 'revision')
  ) {
    return { ok: false, error: 'expert-team-review-disabled' }
  }
  const inputResultIds = input.inputResultIds ?? []
  for (const resultId of inputResultIds) {
    const referenced = run.results.find((result) => result.resultId === resultId)
    if (referenced === undefined || referenced.status !== 'completed') {
      return { ok: false, error: 'expert-team-invalid-input-result' }
    }
  }
  const effective = currentEffectiveResultIds(run)
  if (input.kind === 'execute') {
    if (run.teamSnapshot.orchestration.executionOrder === 'sequential') {
      const sequentialError = sequentialExecuteError(run, input.memberId, inputResultIds, effective)
      if (sequentialError !== undefined) return { ok: false, error: sequentialError }
    }
    if (input.supersedesResultId !== undefined) {
      const target = run.results.find((result) => result.resultId === input.supersedesResultId)
      if (
        target === undefined ||
        target.kind !== 'execute' ||
        target.memberId !== input.memberId ||
        (target.status !== 'failed' && target.status !== 'stopped') ||
        resolvedExecutionFailureIds(run).has(target.resultId)
      ) {
        return { ok: false, error: 'expert-team-invalid-supersede' }
      }
    }
    return { ok: true }
  }
  if (input.kind === 'review') {
    // 规格 §10.1：broadcast + unified 进入统一审查前，每名执行成员至少应已有已结束的首轮
    // execute 尝试（允许技术失败/停止后按不完整流程审查并结 partial，避免与必审要求死锁；
    // per-member 允许动态交错审查单个已完成结果）。
    if (
      run.teamSnapshot.review.mode === 'unified' &&
      broadcastMissingSettledFirstRoundAttempt(run)
    ) {
      return { ok: false, error: 'expert-team-broadcast-incomplete' }
    }
    return { ok: true }
  }
  return validateRevisionRule(run, input, effective)
}

/** broadcast 缺员只按「从未派工」判定：已有技术失败证据不阻止提交部分报告。 */
function broadcastNeverDispatched(run: ExpertTeamRun): boolean {
  if (run.teamSnapshot.orchestration.assignmentMode !== 'broadcast') return false
  return executorMemberIds(run).some(
    (executorId) => !run.results.some((result) => result.memberId === executorId),
  )
}

/** broadcast 统一审查入口检查：每名执行成员至少已有已结束的首轮 execute（completed/failed/stopped）。 */
function broadcastMissingSettledFirstRoundAttempt(run: ExpertTeamRun): boolean {
  if (run.teamSnapshot.orchestration.assignmentMode !== 'broadcast') return false
  return executorMemberIds(run).some(
    (executorId) =>
      !run.results.some(
        (result) =>
          result.memberId === executorId &&
          result.kind === 'execute' &&
          (result.status === 'completed' || result.status === 'failed' || result.status === 'stopped'),
      ),
  )
}

/**
 * 必审员是否「从未尝试」：既无有效结论，也无明确的 failed/stopped/invalid-verdict
 * 记录。已有技术失败或无效标记证据时允许提交并如实披露（回合仍结 `partial`）。
 */
function reviewNeverAttempted(run: ExpertTeamRun): boolean {
  if (run.teamSnapshot.review.mode === 'none') return false
  const reviewers = reviewerMemberIds(run)
  for (const scope of requiredReviewScopes(run)) {
    for (const reviewer of reviewers) {
      const attempt = latestReviewAttempt(run, reviewer, scope)
      if (attempt === undefined) return true
      if (attempt.state === 'pending' || attempt.state === 'incomplete') return true
    }
  }
  return false
}

/**
 * 新主 Artifact 提交前校验（§12.4.1）。相同 `primaryArtifactCallId` 属于幂等重放，
 * 不按新提交拒绝。预算豁免只在 `dispatchAttempts >= 24`、已有有效结果且无在途时
 * 豁免 broadcast 缺员、必审缺失与额度内必要返修三类拒绝；运行归属、格式、取消与
 * 交付封闭永不豁免。
 */
export function canSubmitPrimaryArtifact(
  run: ExpertTeamRun,
  input: PrimaryArtifactSubmission,
): PrimaryArtifactDecision {
  if (run.primaryArtifactCallId !== undefined && run.primaryArtifactCallId === input.callId) {
    return { ok: true }
  }
  if (run.status !== 'running') return { ok: false, error: 'expert-team-terminal' }
  if (run.deliverySealed) return { ok: false, error: 'expert-team-delivery-sealed' }
  if (currentEffectiveResultIds(run).length === 0) {
    return { ok: false, error: 'expert-team-no-valid-execution' }
  }
  if (input.inFlight) return { ok: false, error: 'expert-team-dispatch-in-flight' }
  if (input.artifactFormat !== run.teamSnapshot.summary.artifactFormat) {
    return { ok: false, error: 'expert-team-artifact-format' }
  }
  if (run.primaryArtifactId !== undefined) return { ok: false, error: 'expert-team-delivery-sealed' }
  if (run.dispatchAttempts >= 24) return { ok: true }
  if (broadcastNeverDispatched(run)) return { ok: false, error: 'expert-team-broadcast-incomplete' }
  if (reviewNeverAttempted(run)) return { ok: false, error: 'expert-team-review-incomplete' }
  if (reviewNecessaryRevisionPending(run)) return { ok: false, error: 'expert-team-review-incomplete' }
  return { ok: true }
}
