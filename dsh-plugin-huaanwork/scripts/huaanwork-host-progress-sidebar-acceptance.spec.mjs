import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROGRESS_ACCEPT_CHECK_IDS,
  assertProgressSidebarAcceptanceFacts,
  compareHeaderToolPhases,
  countSubagentCancelRequests,
  inspectDelegationChain,
  inspectSessionHeaderTools,
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
        explicitAtLabel: '@typo-check',
        explicitCardSeen: true,
        targetedCancelConverged: true,
        reasons: [],
      },
      'dual-entry-system-skills': {
        ok: true,
        entries: [
          { entry: 'model-skill', skill: 'explore', runSeenInRail: true, runSeenInMain: true, cancelled: false },
          { entry: 'explicit-slash', skill: 'explore', runSeenInRail: true, runSeenInMain: true, cancelled: true },
          { entry: 'explicit-slash', skill: 'test-fix', runSeenInRail: true, runSeenInMain: true, cancelled: true },
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
