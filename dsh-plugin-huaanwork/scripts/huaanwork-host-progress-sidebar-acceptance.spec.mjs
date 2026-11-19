import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROGRESS_ACCEPT_CHECK_IDS,
  assertProgressSidebarAcceptanceFacts,
  cleanupIsolatedRoot,
  compareHeaderToolPhases,
  countSubagentCancelRequests,
  hasRecordedCheckFailure,
  inspectDelegationChain,
  inspectSessionHeaderTools,
  recordPartialCheckFailureBeforeBlocked,
  resolveBlockedOrFailedOutcome,
  resolveFinalExitCode,
} from './huaanwork-accept-progress-sidebar.mjs'

const TOOLS = ['bash', 'read', 'todo_write']

function headerEvent(names, reason = 'change') {
  return {
    type: 'request/header',
    seq: 1,
    data: {
      reason,
      header: names === undefined ? {} : {
        config: { provider: 'deepseek-official', model: 'local' },
        tools: names.map((name) => ({ name, description: `${name} tool`, parameters: { type: 'object' } })),
      },
    },
  }
}

function userMessage(id, text) {
  return {
    type: 'user/message',
    seq: 2,
    data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

function evidenceForRestart() {
  return {
    before: { canary: 'canary-1', timeOrigin: 1234.5, origin: 'http://127.0.0.1:43120' },
    restart: { oldPid: 501, newPid: 502 },
    after: { canary: 'canary-1', timeOrigin: 1234.5, origin: 'http://127.0.0.1:43120' },
    mainRunCountBefore: 2,
    mainRunCountAfter: 2,
    staleCards: [{ text: '状态不可恢复 · Host 已重启，结果未确认', terminateDisabled: true, elapsed: '00:12', phase: 'thinking' }],
    staleCardsLater: [{ text: '状态不可恢复 · Host 已重启，结果未确认', terminateDisabled: true, elapsed: '00:12', phase: 'thinking' }],
  }
}

function validFacts() {
  return {
    schemaVersion: 1,
    outcome: 'PASS',
    isolatedCleanup: 'removed',
    checks: {
      'progress-tasks': {
        ok: true,
        promptSent: true,
        taskCount: 4,
        countText: '已完成 1/4',
        countMatched: true,
        highlightedSeen: true,
        mainTodoCardCount: 1,
        sessionTodoWriteCount: 2,
        reasons: [],
      },
      'no-fabricated-percentage': {
        ok: true,
        taskPercentTexts: 0,
        countPercentTexts: 0,
        taskProgressBarCount: 0,
        totalProgressBarCount: 1,
        totalBarMatchesCount: true,
        countFormatAlwaysXY: true,
        activityAnchorMatched: true,
        activityCallsMatched: true,
        foreignActivityCalls: [],
        activityToolNames: ['bash', 'read'],
        sessionToolNames: ['read', 'bash'],
        latestRoundToolNames: ['bash'],
        latestRoundCovered: true,
        activityMatchesSession: true,
        reasons: [],
      },
      'parent-no-self-spawn': {
        ok: true,
        ordinaryTurnCount: 2,
        ordinaryTurnsWithoutSubagent: true,
        ordinaryHeaderSnapshots: [{ snapshot: 0, hasSubagent: false }, { snapshot: 1, hasSubagent: false }],
        legacyAtLabel: '@legacy-reviewer',
        legacyAtCardSeen: true,
        legacyAtKind: 'legacy',
        legacyTargetedCancelConverged: true,
        explicitAtLabel: '@typo-check',
        explicitCardSeen: true,
        targetedCancelConverged: true,
        reasons: [],
      },
      'dual-entry-system-skills': {
        ok: true,
        entries: [
          {
            entry: 'model-skill',
            skill: 'explore',
            runSeenInRail: true,
            runSeenInMain: true,
            runKind: 'system-skill',
            anchorMatched: true,
            headerHasSubagent: true,
            skillToolCalled: true,
            cancelled: false,
          },
          {
            entry: 'explicit-slash',
            skill: 'explore',
            runSeenInRail: true,
            runSeenInMain: true,
            runKind: 'system-skill',
            anchorMatched: true,
            headerHasSubagent: true,
            skillToolCalled: false,
            cancelled: true,
          },
          {
            entry: 'explicit-slash',
            skill: 'test-fix',
            runSeenInRail: true,
            runSeenInMain: true,
            runKind: 'system-skill',
            anchorMatched: true,
            headerHasSubagent: true,
            skillToolCalled: false,
            cancelled: true,
          },
        ],
        cancelledCount: 2,
        phases: { before: ['bash', 'read', 'todo_write'], during: ['bash', 'read', 'todo_write', 'subagent'], after: ['bash', 'read', 'todo_write'] },
        phaseComparison: compareHeaderToolPhases({
          before: ['bash', 'read', 'todo_write'],
          during: ['bash', 'read', 'todo_write', 'subagent'],
          after: ['bash', 'read', 'todo_write'],
        }),
        reasons: [],
      },
      'package-lane-depth-two': {
        ok: true,
        outerLabel: '@typo-check',
        outerCardSeenInRail: true,
        outerCardSeenInMain: true,
        railLaneRowCount: 0,
        aggregatedToolSummary: '正在执行 1 个工具',
        outerSummaryFromOuterChildOnly: true,
        chain: { rootId: 'root', childId: 'child', childCount: 1, childDepth: 1, laneIds: ['lane-a', 'lane-b'], laneDepths: [2, 2], identityOk: true },
        laneResults: [
          { id: 'lane-a', finalTextLength: 120, settlementDelivered: true, isError: false },
          { id: 'lane-b', finalTextLength: 132, settlementDelivered: true, isError: false },
        ],
        reasons: [],
      },
      'switch-history-restart': {
        ok: true,
        freshTabTaskCount: 0,
        historyReloadTaskCount: 4,
        historyTodoCardCount: 1,
        postHistoryTurnTaskCount: 0,
        previousTurnTodoNotCarried: true,
        previousTodoNotInFreshTab: true,
        connectionSamples: [{ connection: 'live', banner: null }, { connection: 'reconnecting', banner: '正在重新连接，状态可能不是最新' }],
        reconnectBannerSeen: true,
        restart: {
          attempted: true,
          evidence: evidenceForRestart(),
          asserted: true,
          staleCardCount: 1,
        },
        reasons: [],
      },
      'single-cancel-isolation': {
        ok: true,
        targetLabel: '@typo-check',
        siblingLabel: '@code-review',
        targetRunId: 'run-target',
        cancelRpc: { cancelRequestCount: 1, targetRunIdCount: 1, otherRunIdCount: 0 },
        siblingCompleted: true,
        siblingSettlementSeen: true,
        mainCardCounts: { target: 1, sibling: 1 },
        railCardCounts: { target: 1, sibling: 1 },
        perRunCardUnique: true,
        mainToolPanelCount: 2,
        mainToolPanelsUnique: true,
        todoCardCount: 1,
        duplicateFree: true,
        reasons: [],
      },
    },
  }
}

test('inspectSessionHeaderTools extracts request/header tool schema names in order', () => {
  const inspection = inspectSessionHeaderTools([
    userMessage('message-1', 'hello'),
    headerEvent(TOOLS, 'initial'),
    { type: 'tool/call', seq: 3, data: { name: 'todo_write' } },
    headerEvent([...TOOLS, 'subagent'], 'change'),
    headerEvent(undefined, 'series'),
  ])
  assert.equal(inspection.requestCount, 3)
  assert.deepEqual(inspection.requests.map((request) => request.reason), ['initial', 'change', 'series'])
  assert.deepEqual(inspection.requests[0].toolNames, ['bash', 'read', 'todo_write'])
  assert.equal(inspection.requests[0].hasSubagent, false)
  assert.equal(inspection.requests[1].hasSubagent, true)
  assert.deepEqual(inspection.requests[2].toolNames, [])
  assert.equal(inspection.subagentSnapshotCount, 1)
  assert.deepEqual(inspection.unionToolNames, ['bash', 'read', 'subagent', 'todo_write'])
})

test('inspectSessionHeaderTools tolerates missing or malformed tool entries', () => {
  const inspection = inspectSessionHeaderTools([
    { type: 'request/header', data: { reason: 'initial', header: { tools: [{ name: 'read' }, { description: 'no name' }, null, 'bash'] } } },
    { type: 'not-a-header' },
    null,
  ])
  assert.equal(inspection.requestCount, 1)
  assert.deepEqual(inspection.requests[0].toolNames, ['read'])
})

test('compareHeaderToolPhases accepts subagent opening only during execution and being reclaimed', () => {
  const comparison = compareHeaderToolPhases({
    before: ['bash', 'read', 'todo_write'],
    during: ['bash', 'read', 'todo_write', 'subagent'],
    after: ['bash', 'read', 'todo_write'],
  })
  assert.equal(comparison.ok, true)
  assert.deepEqual(comparison.added, ['subagent'])
  assert.deepEqual(comparison.removed, ['subagent'])
  assert.equal(comparison.beforeHasSubagent, false)
  assert.equal(comparison.duringHasSubagent, true)
  assert.equal(comparison.afterHasSubagent, false)
})

test('compareHeaderToolPhases rejects leaks before, absence during, and no reclaim afterwards', () => {
  const leaked = compareHeaderToolPhases({ before: ['subagent'], during: ['subagent'], after: [] })
  assert.equal(leaked.ok, false)
  assert.match(leaked.reasons.join(' '), /before/)
  const missing = compareHeaderToolPhases({ before: ['read'], during: ['read'], after: ['read'] })
  assert.equal(missing.ok, false)
  assert.match(missing.reasons.join(' '), /during/)
  const retained = compareHeaderToolPhases({ before: [], during: ['subagent'], after: ['subagent'] })
  assert.equal(retained.ok, false)
  assert.match(retained.reasons.join(' '), /after/)
})

test('compareHeaderToolPhases rejects a missing ordinary pre-execution header', () => {
  const comparison = compareHeaderToolPhases({ before: [], during: ['subagent'], after: ['bash'] })
  assert.equal(comparison.ok, false)
  assert.match(comparison.reasons.join(' '), /no ordinary pre-execution header snapshot/)
})

const SESSION_HEADERS = [
  { id: 'root', delegationDepth: 0 },
  { id: 'child', parentSession: 'root', origin: 'subagent', delegationDepth: 1 },
  { id: 'lane-a', parentSession: 'child', origin: 'subagent', delegationDepth: 2 },
  { id: 'lane-b', parentSession: 'child', origin: 'subagent', delegationDepth: 2 },
  { id: 'impostor', parentSession: 'root', origin: 'subagent', delegationDepth: 2 },
]

test('inspectDelegationChain pins the root -> package child -> lane identity chain', () => {
  const chain = inspectDelegationChain(SESSION_HEADERS, 'root')
  assert.equal(chain.rootFound, true)
  assert.equal(chain.childCount, 1)
  assert.equal(chain.childId, 'child')
  assert.equal(chain.childDepth, 1)
  assert.deepEqual(chain.laneIds, ['lane-a', 'lane-b'])
  assert.deepEqual(chain.laneDepths, [2, 2])
  assert.equal(chain.identityOk, true)
})

test('inspectDelegationChain rejects missing or mis-depthed children and lanes', () => {
  const missingRoot = inspectDelegationChain(SESSION_HEADERS, 'nope')
  assert.equal(missingRoot.rootFound, false)
  assert.equal(missingRoot.identityOk, false)

  const wrongChildDepth = inspectDelegationChain([
    { id: 'root', delegationDepth: 0 },
    { id: 'child', parentSession: 'root', origin: 'subagent', delegationDepth: 2 },
  ], 'root')
  assert.equal(wrongChildDepth.childCount, 0)
  assert.equal(wrongChildDepth.identityOk, false)

  const wrongLaneOrigin = inspectDelegationChain([
    { id: 'root', delegationDepth: 0 },
    { id: 'child', parentSession: 'root', origin: 'subagent', delegationDepth: 1 },
    { id: 'lane-a', parentSession: 'child', origin: 'legacy', delegationDepth: 2 },
  ], 'root')
  assert.deepEqual(wrongLaneOrigin.laneIds, [])
  assert.equal(wrongLaneOrigin.identityOk, false)
})

test('countSubagentCancelRequests isolates one target runId cancel request', () => {
  const requests = [
    { method: 'POST', url: 'http://127.0.0.1:1/huaanwork/subagent/list', postData: '{}' },
    { method: 'POST', url: 'http://127.0.0.1:1/huaanwork/subagent/cancel', postData: '{"parentSessionId":"p","runId":"run-target"}' },
    { method: 'POST', url: 'http://127.0.0.1:1/huaanwork/subagent/snapshot', postData: '{"generation":"g"}' },
    { method: 'POST', url: 'http://127.0.0.1:1/huaanwork/subagent/cancel', postData: 'not-json' },
    { method: 'POST', url: 'http://127.0.0.1:1/huaanwork/subagent/cancel', postData: '{"runId":"run-sibling"}' },
  ]
  const counted = countSubagentCancelRequests(requests, 'run-target')
  assert.equal(counted.cancelRequestCount, 3)
  assert.equal(counted.targetRunIdCount, 1)
  assert.equal(counted.otherRunIdCount, 1)
  assert.deepEqual(counted.runIds, ['run-target', 'run-sibling'])
})

test('assertProgressSidebarAcceptanceFacts accepts a fully observed walkthrough', () => {
  assert.equal(assertProgressSidebarAcceptanceFacts(validFacts()), true)
  assert.equal(PROGRESS_ACCEPT_CHECK_IDS.length, 7)
})

test('rejects a facts document that is missing an automated check', () => {
  const facts = validFacts()
  delete facts.checks['single-cancel-isolation']
  assert.throws(() => assertProgressSidebarAcceptanceFacts(facts), /single-cancel-isolation/)
})

test('rejects a fabricated percentage or an inconsistent task count', () => {
  const percent = validFacts()
  percent.checks['no-fabricated-percentage'].taskPercentTexts = 1
  assert.throws(() => assertProgressSidebarAcceptanceFacts(percent), /no-fabricated-percentage/)

  const perStepBar = validFacts()
  perStepBar.checks['no-fabricated-percentage'].taskProgressBarCount = 1
  assert.throws(() => assertProgressSidebarAcceptanceFacts(perStepBar), /per-step progress bars/)

  const totalBar = validFacts()
  totalBar.checks['no-fabricated-percentage'].totalBarMatchesCount = false
  assert.throws(() => assertProgressSidebarAcceptanceFacts(totalBar), /total progress bar/)

  const count = validFacts()
  count.checks['progress-tasks'].countMatched = false
  assert.throws(() => assertProgressSidebarAcceptanceFacts(count), /progress-tasks/)

  const duplicate = validFacts()
  duplicate.checks['progress-tasks'].mainTodoCardCount = 2
  assert.throws(() => assertProgressSidebarAcceptanceFacts(duplicate), /progress-tasks/)
})

test('rejects activity that does not match the current turn session log', () => {
  const facts = validFacts()
  facts.checks['no-fabricated-percentage'].activityMatchesSession = false
  assert.throws(() => assertProgressSidebarAcceptanceFacts(facts), /activity does not match/)
})

test('rejects an activity panel that misses the latest model round', () => {
  const facts = validFacts()
  facts.checks['no-fabricated-percentage'].latestRoundCovered = false
  assert.throws(() => assertProgressSidebarAcceptanceFacts(facts), /latest model round/)
})

test('rejects an ordinary turn that exposed subagent or an unconverged explicit @ cancel', () => {
  const exposed = validFacts()
  exposed.checks['parent-no-self-spawn'].ordinaryTurnsWithoutSubagent = false
  assert.throws(() => assertProgressSidebarAcceptanceFacts(exposed), /subagent/)

  const unconverged = validFacts()
  unconverged.checks['parent-no-self-spawn'].targetedCancelConverged = false
  assert.throws(() => assertProgressSidebarAcceptanceFacts(unconverged), /parent-no-self-spawn/)
})

test('rejects missing dual-entry system skill runs and a leaked execution tool window', () => {
  const missingEntry = validFacts()
  missingEntry.checks['dual-entry-system-skills'].entries.pop()
  assert.throws(() => assertProgressSidebarAcceptanceFacts(missingEntry), /dual-entry-system-skills/)

  const leaked = validFacts()
  leaked.checks['dual-entry-system-skills'].phases.after = ['bash', 'subagent']
  leaked.checks['dual-entry-system-skills'].phaseComparison = compareHeaderToolPhases(leaked.checks['dual-entry-system-skills'].phases)
  assert.throws(() => assertProgressSidebarAcceptanceFacts(leaked), /after/)
})

test('rejects a lane chain that is not two depth-2 lanes without independent rail rows', () => {
  const oneLane = validFacts()
  oneLane.checks['package-lane-depth-two'].chain.laneIds = ['lane-a']
  oneLane.checks['package-lane-depth-two'].chain.laneDepths = [2]
  oneLane.checks['package-lane-depth-two'].chain.identityOk = true
  assert.throws(() => assertProgressSidebarAcceptanceFacts(oneLane), /lane/)

  const independentRow = validFacts()
  independentRow.checks['package-lane-depth-two'].railLaneRowCount = 1
  assert.throws(() => assertProgressSidebarAcceptanceFacts(independentRow), /package-lane-depth-two/)

  const errorResult = validFacts()
  errorResult.checks['package-lane-depth-two'].laneResults[0].isError = true
  assert.throws(() => assertProgressSidebarAcceptanceFacts(errorResult), /lane/)
})

test('relays the Host restart evidence and requires the reconnect banner', () => {
  const noBanner = validFacts()
  noBanner.checks['switch-history-restart'].reconnectBannerSeen = false
  assert.throws(() => assertProgressSidebarAcceptanceFacts(noBanner), /reconnect/)

  const leakedTodo = validFacts()
  leakedTodo.checks['switch-history-restart'].previousTodoNotInFreshTab = false
  assert.throws(() => assertProgressSidebarAcceptanceFacts(leakedTodo), /switch-history-restart/)

  const carriedTodo = validFacts()
  carriedTodo.checks['switch-history-restart'].previousTurnTodoNotCarried = false
  assert.throws(() => assertProgressSidebarAcceptanceFacts(carriedTodo), /previous turn todo/)

  const samePid = validFacts()
  samePid.checks['switch-history-restart'].restart.evidence.restart.newPid = 501
  assert.throws(() => assertProgressSidebarAcceptanceFacts(samePid), /Host pid did not change/)

  const replaced = validFacts()
  replaced.checks['switch-history-restart'].restart.evidence.after.timeOrigin += 1
  assert.throws(() => assertProgressSidebarAcceptanceFacts(replaced), /renderer document was replaced/)
})

test('rejects duplicated cancel RPCs, sibling interference, and duplicated cards', () => {
  const doubled = validFacts()
  doubled.checks['single-cancel-isolation'].cancelRpc = { cancelRequestCount: 2, targetRunIdCount: 2, otherRunIdCount: 0 }
  assert.throws(() => assertProgressSidebarAcceptanceFacts(doubled), /single-cancel-isolation/)

  const sibling = validFacts()
  sibling.checks['single-cancel-isolation'].cancelRpc = { cancelRequestCount: 2, targetRunIdCount: 1, otherRunIdCount: 1 }
  assert.throws(() => assertProgressSidebarAcceptanceFacts(sibling), /single-cancel-isolation/)

  const notCompleted = validFacts()
  notCompleted.checks['single-cancel-isolation'].siblingCompleted = false
  assert.throws(() => assertProgressSidebarAcceptanceFacts(notCompleted), /single-cancel-isolation/)

  const duplicate = validFacts()
  duplicate.checks['single-cancel-isolation'].duplicateFree = false
  assert.throws(() => assertProgressSidebarAcceptanceFacts(duplicate), /single-cancel-isolation/)

  const duplicatedToolPanels = validFacts()
  duplicatedToolPanels.checks['single-cancel-isolation'].mainToolPanelsUnique = false
  assert.throws(() => assertProgressSidebarAcceptanceFacts(duplicatedToolPanels), /duplicate tool panels/)
})

test('Q4-M1: enforces anchor, callId/roundKey, legacy @agent, per-entry skill, outer-only summary, and per-runId card uniqueness', () => {
  const wrongAnchor = validFacts()
  wrongAnchor.checks['no-fabricated-percentage'].activityAnchorMatched = false
  assert.throws(() => assertProgressSidebarAcceptanceFacts(wrongAnchor), /turn anchor/)

  const wrongCalls = validFacts()
  wrongCalls.checks['no-fabricated-percentage'].activityCallsMatched = false
  assert.throws(() => assertProgressSidebarAcceptanceFacts(wrongCalls), /callId\/roundKey/)

  const foreignCall = validFacts()
  foreignCall.checks['no-fabricated-percentage'].foreignActivityCalls = [{ name: 'bash', callId: 'c-foreign', roundKey: 99 }]
  assert.throws(() => assertProgressSidebarAcceptanceFacts(foreignCall), /lack a matching current-turn callId\/roundKey/)

  const wrongLegacyKind = validFacts()
  wrongLegacyKind.checks['parent-no-self-spawn'].legacyAtKind = 'package'
  assert.throws(() => assertProgressSidebarAcceptanceFacts(wrongLegacyKind), /expected legacy run kind/)

  const missingDualKind = validFacts()
  missingDualKind.checks['dual-entry-system-skills'].entries[1].runKind = 'legacy'
  assert.throws(() => assertProgressSidebarAcceptanceFacts(missingDualKind), /kind=system-skill/)

  const missingSkillCall = validFacts()
  missingSkillCall.checks['dual-entry-system-skills'].entries[0].skillToolCalled = false
  assert.throws(() => assertProgressSidebarAcceptanceFacts(missingSkillCall), /did not invoke the skill tool/)

  const leakedLaneTool = validFacts()
  leakedLaneTool.checks['package-lane-depth-two'].outerSummaryFromOuterChildOnly = false
  assert.throws(() => assertProgressSidebarAcceptanceFacts(leakedLaneTool), /leaked a tool/)

  const missingRailCount = validFacts()
  missingRailCount.checks['single-cancel-isolation'].railCardCounts = { target: 2, sibling: 1 }
  assert.throws(() => assertProgressSidebarAcceptanceFacts(missingRailCount), /rail run card/)

  const nonUniqueRun = validFacts()
  nonUniqueRun.checks['single-cancel-isolation'].perRunCardUnique = false
  assert.throws(() => assertProgressSidebarAcceptanceFacts(nonUniqueRun), /per-runId card uniqueness/)
})

test('Q4-I5: BlockedError after an earlier check failure resolves to FAIL (exit 1) rather than BLOCKED (exit 3)', () => {
  const blockedErr = Object.assign(new Error('late environment prerequisite blocked'), {
    name: 'BlockedError',
    detail: { step: 'switch-history-restart' },
  })
  const failingChecks = {
    'progress-tasks': { ok: true },
    'parent-no-self-spawn': { ok: false, reasons: ['explicit cancel failed'] },
  }
  assert.equal(hasRecordedCheckFailure(failingChecks), true)
  const failVerdict = resolveBlockedOrFailedOutcome(validFacts(), failingChecks, blockedErr)
  assert.equal(failVerdict.exitCode, 1)
  assert.equal(failVerdict.facts.outcome, 'FAIL')
  assert.equal(failVerdict.facts.blocked.cause, 'late environment prerequisite blocked')

  const cleanChecks = { 'progress-tasks': { ok: true } }
  assert.equal(hasRecordedCheckFailure(cleanChecks), false)
  const blockedVerdict = resolveBlockedOrFailedOutcome({ schemaVersion: 1, outcome: 'PENDING', errors: [] }, cleanChecks, blockedErr)
  assert.equal(blockedVerdict.exitCode, 3)
  assert.equal(blockedVerdict.facts.outcome, 'BLOCKED')

  const f1OnlyErr = Object.assign(new Error('model-skill blocked'), {
    name: 'BlockedError',
    detail: { onlyBlockedCheckId: 'dual-entry-system-skills' },
  })
  const f1Clean = { 'progress-tasks': { ok: true }, 'dual-entry-system-skills': { ok: false } }
  assert.equal(resolveBlockedOrFailedOutcome({ schemaVersion: 1, outcome: 'PENDING', errors: [] }, f1Clean, f1OnlyErr).exitCode, 3)
  const f1WithPriorFail = { 'progress-tasks': { ok: false }, 'dual-entry-system-skills': { ok: false } }
  assert.equal(resolveBlockedOrFailedOutcome({ schemaVersion: 1, outcome: 'PENDING', errors: [] }, f1WithPriorFail, f1OnlyErr).exitCode, 1)
})

test('Q4-I6: failed tempRoot cleanup downgrades PASS to FAIL, records path, and forces non-zero exit', () => {
  const factsDoc = validFacts()
  const failedCleanup = cleanupIsolatedRoot('/tmp/huaanwork-progress-sidebar-perm-test', factsDoc, {
    keepTemp: false,
    removeDir: () => {
      throw new Error('EACCES: permission denied')
    },
  })
  assert.equal(failedCleanup.ok, false)
  assert.equal(factsDoc.outcome, 'FAIL')
  assert.match(factsDoc.isolatedCleanup, /^failed: EACCES/)
  assert.ok(factsDoc.errors.some((entry) => entry.includes('/tmp/huaanwork-progress-sidebar-perm-test')))
  assert.equal(resolveFinalExitCode(factsDoc, failedCleanup), 1)
  assert.throws(() => assertProgressSidebarAcceptanceFacts(factsDoc), /isolated credential cleanup failed/)

  const okFacts = validFacts()
  const okCleanup = cleanupIsolatedRoot('/tmp/huaanwork-progress-sidebar-ok-test', okFacts, {
    keepTemp: false,
    removeDir: () => undefined,
  })
  assert.equal(okCleanup.ok, true)
  assert.equal(okFacts.isolatedCleanup, 'removed')
  assert.equal(resolveFinalExitCode(okFacts, okCleanup), 0)

  const blockedFacts = { schemaVersion: 1, outcome: 'BLOCKED', errors: [] }
  const blockedFailedCleanup = cleanupIsolatedRoot('/tmp/huaanwork-progress-sidebar-blocked-perm', blockedFacts, {
    keepTemp: false,
    removeDir: () => {
      throw new Error('EPERM: busy')
    },
  })
  assert.equal(blockedFailedCleanup.ok, false)
  assert.equal(blockedFacts.outcome, 'FAIL')
  assert.equal(resolveFinalExitCode(blockedFacts, blockedFailedCleanup), 1)
})

test('in-scene switch-history failures flushed before BlockedError resolve to FAIL (exit 1) rather than BLOCKED (exit 3)', () => {
  const checks = { 'progress-tasks': { ok: true, reasons: [] } }
  const record = (id, fact) => {
    checks[id] = fact
  }
  const blockedErr = Object.assign(new Error('no active run could be constructed for the Host restart'), {
    name: 'BlockedError',
    detail: { attempts: 2 },
  })

  // 没有累计场景内失败时不写入假失败,真正的阻塞仍退出 3。
  assert.equal(
    recordPartialCheckFailureBeforeBlocked('switch-history-restart', [], { restart: { attempted: false, asserted: false } }, record),
    false,
  )
  assert.equal(checks['switch-history-restart'], undefined)
  const cleanBlocked = resolveBlockedOrFailedOutcome({ schemaVersion: 1, outcome: 'PENDING', errors: [] }, checks, blockedErr)
  assert.equal(cleanBlocked.exitCode, 3)
  assert.equal(cleanBlocked.facts.outcome, 'BLOCKED')

  // 场景内已出现切换/历史失败时先落盘为 ok:false,随后的 BlockedError 必须裁定 FAIL (exit 1) 且保留失败原因。
  const flushed = recordPartialCheckFailureBeforeBlocked(
    'switch-history-restart',
    ['the fresh tab showed 4 tasks'],
    { freshTabTaskCount: 4, restart: { attempted: false, asserted: false } },
    record,
  )
  assert.equal(flushed, true)
  assert.equal(checks['switch-history-restart'].ok, false)
  assert.deepEqual(checks['switch-history-restart'].reasons, ['the fresh tab showed 4 tasks'])
  const failedOutcome = resolveBlockedOrFailedOutcome({ schemaVersion: 1, outcome: 'PENDING', errors: [] }, checks, blockedErr)
  assert.equal(failedOutcome.exitCode, 1)
  assert.equal(failedOutcome.facts.outcome, 'FAIL')
  assert.equal(failedOutcome.facts.blocked.cause, 'no active run could be constructed for the Host restart')
})
