import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decideSubagentRunAcceptance } from './huaanwork-subagent-run-windows-verdict.mjs'

function scenario(id, expected, expectedStatus) {
  return {
    id,
    expected,
    expectedStatus,
    cardsBefore: 0,
    cardsAfter: 1,
    anchored: true,
    phases: expected === 'completed' ? ['starting', 'tool', 'completed'] : ['starting', 'reasoning', 'stopped'],
    sawToolActivity: expected === 'completed',
    terminateClicked: expected === 'stopped',
    terminalPhase: expected,
    terminalStatus: expectedStatus,
  }
}

function facts() {
  return {
    schemaVersion: 1,
    platform: 'win32',
    runner: { os: 'Windows' },
    desktop: {
      headSha: 'a'.repeat(40),
      branch: 'refactor/huaanwork-single-desktop',
      appVersion: '0.1.0',
      dshVersion: '0.2.1-rc.1',
      buildType: 'workspace-electron',
    },
    harness: { pin: 'b'.repeat(40) },
    model: { kind: 'loopback-stub', allowNetwork: false },
    legacyCatalog: { kind: 'loopback-fixture' },
    packageFixture: { slug: 'doc-clerk' },
    scenarios: [
      scenario('package-complete', 'completed', '已完成'),
      scenario('package-cancel', 'stopped', '已停止'),
      scenario('legacy-complete', 'completed', '已完成'),
      scenario('legacy-cancel', 'stopped', '已停止'),
    ],
    parentUsable: { observed: true },
    cardCount: 4,
    screenshots: [
      { name: '00-app-ready.png', bytes: 10 },
      { name: '10-package-completed.png', bytes: 10 },
      { name: '11-package-stopped.png', bytes: 10 },
      { name: '12-legacy-completed.png', bytes: 10 },
      { name: '13-legacy-stopped.png', bytes: 10 },
    ],
    errors: [],
  }
}

test('accepts the four real-@ scenarios with complete evidence', () => {
  assert.equal(decideSubagentRunAcceptance(facts(), 'win32'), true)
})

test('rejects a missing scenario', () => {
  const report = facts()
  report.scenarios.pop()
  assert.throws(() => decideSubagentRunAcceptance(report, 'win32'), /expected 4 scenarios/)
})

test('rejects a completion that stopped instead', () => {
  const report = facts()
  report.scenarios[0].terminalPhase = 'stopped'
  report.scenarios[0].terminalStatus = '已停止'
  assert.throws(() => decideSubagentRunAcceptance(report, 'win32'), /package-complete terminal phase/)
})

test('rejects a cancellation that never clicked terminate', () => {
  const report = facts()
  report.scenarios[1].terminateClicked = false
  assert.throws(() => decideSubagentRunAcceptance(report, 'win32'), /stopped without a targeted terminate click/)
})

test('rejects a completion without observed tool activity', () => {
  const report = facts()
  report.scenarios[0].sawToolActivity = false
  assert.throws(() => decideSubagentRunAcceptance(report, 'win32'), /never observed real tool activity/)
})

test('rejects an extra or missing card', () => {
  const report = facts()
  report.scenarios[2].cardsAfter = 2
  assert.throws(() => decideSubagentRunAcceptance(report, 'win32'), /produced 2 cards for one explicit @/)
  const report2 = facts()
  report2.cardCount = 5
  assert.throws(() => decideSubagentRunAcceptance(report2, 'win32'), /transcript held 5 cards/)
})

test('rejects an unanchored card', () => {
  const report = facts()
  report.scenarios[3].anchored = false
  assert.throws(() => decideSubagentRunAcceptance(report, 'win32'), /was not anchored/)
})

test('rejects missing screenshots, SHA, pin, or a different platform', () => {
  const report = facts()
  report.screenshots.pop()
  assert.throws(() => decideSubagentRunAcceptance(report, 'win32'), /at least 5 screenshots/)
  const report2 = facts()
  report2.desktop.headSha = 'short'
  assert.throws(() => decideSubagentRunAcceptance(report2, 'win32'), /full 40-character git SHA/)
  const report3 = facts()
  report3.harness.pin = ''
  assert.throws(() => decideSubagentRunAcceptance(report3, 'win32'), /full 40-character git SHA/)
  assert.throws(() => decideSubagentRunAcceptance(facts(), 'darwin'), /does not match --platform darwin/)
})

test('rejects a report that does not name the stub model or fixture catalog', () => {
  const report = facts()
  report.model.kind = 'deepseek'
  assert.throws(() => decideSubagentRunAcceptance(report, 'win32'), /loopback stub/)
  const report2 = facts()
  report2.legacyCatalog.kind = 'intranet'
  assert.throws(() => decideSubagentRunAcceptance(report2, 'win32'), /loopback fixture/)
})

test('rejects driver errors and an unusable parent session', () => {
  const report = facts()
  report.errors.push('boom')
  assert.throws(() => decideSubagentRunAcceptance(report, 'win32'), /driver errors/)
  const report2 = facts()
  report2.parentUsable.observed = false
  assert.throws(() => decideSubagentRunAcceptance(report2, 'win32'), /parent session was not usable/)
})
