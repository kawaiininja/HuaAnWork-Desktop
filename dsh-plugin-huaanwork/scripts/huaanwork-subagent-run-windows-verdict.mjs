/**
 * Verdict for the Windows subagent-run acceptance.
 *
 * Pure functions only: the CDP driver decides what happened, this module
 * decides whether that is enough to call the four real `@` scenarios passed.
 * Missing evidence fails closed; a CI-green build alone never satisfies it.
 */

const TERMINAL_PHASES = new Set(['completed', 'failed', 'stopped'])
const REQUIRED_SCENARIOS = [
  { id: 'package-complete', expected: 'completed', expectedStatus: '已完成' },
  { id: 'package-cancel', expected: 'stopped', expectedStatus: '已停止' },
  { id: 'legacy-complete', expected: 'completed', expectedStatus: '已完成' },
  { id: 'legacy-cancel', expected: 'stopped', expectedStatus: '已停止' },
]

function fail(message) {
  throw new Error(`subagent run acceptance: ${message}`)
}

function assertSha(label, value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) fail(`${label} must be a full 40-character git SHA`)
}

/**
 * @param {object} facts - driver report
 * @param {'win32'|'darwin'|'linux'} expectedPlatform - platform the run claims
 * @returns {true}
 */
export function decideSubagentRunAcceptance(facts, expectedPlatform) {
  if (facts === null || typeof facts !== 'object') fail('report is missing')
  if (facts.schemaVersion !== 1) fail('report schemaVersion must be 1')
  if (facts.platform !== expectedPlatform) fail(`platform ${String(facts.platform)} does not match --platform ${expectedPlatform}`)
  if (!['win32', 'darwin', 'linux'].includes(facts.platform)) fail(`unsupported platform ${String(facts.platform)}`)
  if (!Array.isArray(facts.errors) || facts.errors.length > 0) fail(`driver errors: ${JSON.stringify(facts.errors)}`)

  assertSha('desktop.headSha', facts.desktop?.headSha)
  assertSha('harness.pin', facts.harness?.pin)
  if (typeof facts.desktop?.branch !== 'string' || facts.desktop.branch.trim() === '') fail('desktop.branch is missing')
  if (typeof facts.desktop?.appVersion !== 'string' || facts.desktop.appVersion.trim() === '') fail('desktop.appVersion is missing')
  if (typeof facts.desktop?.dshVersion !== 'string' || facts.desktop.dshVersion.trim() === '') fail('desktop.dshVersion is missing')
  if (facts.desktop?.buildType !== 'workspace-electron') fail('buildType must record workspace-electron')
  if (facts.model?.kind !== 'loopback-stub') fail('model evidence must be the loopback stub')
  if (facts.model?.allowNetwork !== false) fail('the acceptance must keep allow_network=false')
  if (facts.legacyCatalog?.kind !== 'loopback-fixture') fail('legacy catalog evidence must be the loopback fixture')
  if (facts.packageFixture?.slug !== 'doc-clerk') fail('package fixture must be doc-clerk')

  const scenarios = Array.isArray(facts.scenarios) ? facts.scenarios : []
  if (scenarios.length !== REQUIRED_SCENARIOS.length) {
    fail(`expected ${String(REQUIRED_SCENARIOS.length)} scenarios, found ${String(scenarios.length)}`)
  }
  let cardTotal = 0
  for (const required of REQUIRED_SCENARIOS) {
    const scenario = scenarios.find((item) => item?.id === required.id)
    if (scenario === undefined) fail(`missing scenario ${required.id}`)
    if (scenario.expected !== required.expected) fail(`${required.id} expected ${required.expected}, report says ${String(scenario.expected)}`)
    if (scenario.terminalPhase !== required.expected) {
      fail(`${required.id} terminal phase was ${String(scenario.terminalPhase)}, expected ${required.expected}`)
    }
    if (scenario.terminalStatus !== required.expectedStatus) {
      fail(`${required.id} terminal status was ${JSON.stringify(scenario.terminalStatus)}, expected ${required.expectedStatus}`)
    }
    if (scenario.cardsAfter !== scenario.cardsBefore + 1) {
      fail(`${required.id} produced ${String(scenario.cardsAfter - scenario.cardsBefore)} cards for one explicit @`)
    }
    if (scenario.anchored !== true) fail(`${required.id} card was not anchored directly after its user message`)
    if (!Array.isArray(scenario.phases) || !scenario.phases.some((phase) => !TERMINAL_PHASES.has(phase))) {
      fail(`${required.id} never observed an active phase`)
    }
    if (required.expected === 'completed' && scenario.sawToolActivity !== true) {
      fail(`${required.id} never observed real tool activity`)
    }
    if (required.expected === 'stopped' && scenario.terminateClicked !== true) {
      fail(`${required.id} stopped without a targeted terminate click`)
    }
    cardTotal += 1
  }
  if (facts.cardCount !== cardTotal) fail(`transcript held ${String(facts.cardCount)} cards for ${String(cardTotal)} explicit @ sends`)
  if (facts.parentUsable?.observed !== true) fail('parent session was not usable after the cancelled runs')

  const screenshots = Array.isArray(facts.screenshots) ? facts.screenshots : []
  if (screenshots.length < 5) fail(`expected at least 5 screenshots, found ${String(screenshots.length)}`)
  for (const shot of screenshots) {
    if (typeof shot?.name !== 'string' || shot.name === '' || !Number.isSafeInteger(shot.bytes) || shot.bytes <= 0) {
      fail(`screenshot ${JSON.stringify(shot?.name)} is empty or unrecorded`)
    }
  }
  if (facts.runner === undefined || typeof facts.runner.os !== 'string' || facts.runner.os === '') {
    fail('runner OS is missing')
  }
  return true
}

export const SUBAGENT_RUN_REQUIRED_SCENARIOS = Object.freeze(REQUIRED_SCENARIOS)
