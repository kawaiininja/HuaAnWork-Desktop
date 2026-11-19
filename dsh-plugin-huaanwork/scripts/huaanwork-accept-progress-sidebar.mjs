#!/usr/bin/env node
/**
 * Real-app CDP acceptance for the right-rail progress sidebar (spec §14.2).
 *
 * Drives the built HuaAnWork Electron renderer against an isolated
 * `DSH_HOME` + `--user-data-dir` and asserts the seven automated walkthrough
 * scenes the progress sidebar needs: complex task progress, no fabricated
 * per-step percentage, an ordinary parent that cannot self-spawn (it may only
 * delegate through an explicit `@`), the `explore` / `test-fix` system-skill
 * dual entries, a package lane at delegation depth 2, session switch / history
 * reload / Host restart invalidation, and sibling-run cancel isolation.
 *
 * The model configuration is copied read-only from the production
 * `huaanwork-settings.json` into the isolated profile; `api_key` is never
 * printed, written to facts, or committed. A missing production model file or
 * a missing `zstd` CLI is BLOCKED (exit 3), never silently degraded.
 *
 * Session-log assertions read the multi-frame `session.v4.jsonl.zstd` logs with
 * the `zstd` CLI. `request/header` snapshots expose the tool schema in force,
 * which is how an ordinary turn is proven to lack `subagent`, the system-skill
 * execution window is proven to open and reclaim it, and the package lane
 * identity chain is pinned from session headers.
 *
 * RPC isolation uses the CDP Network domain: `/huaanwork/subagent/cancel`
 * requests are captured from the renderer network layer, so one confirm click
 * must produce exactly one cancel for the target run and none for its sibling.
 *
 * Exit: 0 PASS / 1 FAIL / 2 usage / 3 BLOCKED (missing precondition).
 *
 * Usage:
 *   node scripts/huaanwork-accept-progress-sidebar.mjs \
 *     [--out <dir>] [--timeout <ms>] [--cdp <port>] [--only <scene,scene>]
 *
 * `--only` runs a subset of the scenes while developing the driver; the
 * committed evidence must come from a full run without it.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, scrypt } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { arch as osArch, homedir, platform as osPlatform, release as osRelease, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { initProfile } from '@deepseek-ai/dsh-app-boot'

import { assertHostRestartEvidence } from './huaanwork-accept-host-restart.mjs'
import { redactReport, redactSecrets } from './huaanwork-acceptance-redaction.mjs'

const scryptAsync = promisify(scrypt)
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const MAIN_PATH = join(PACKAGE_ROOT, 'lib', 'main.js')
const SEED_SCRIPT = join(PACKAGE_ROOT, 'scripts', 'seed-agent-packages.mjs')
const PRODUCTION_SETTINGS_PATH = join(homedir(), '.huaanwork', 'profiles', 'desktop', 'huaanwork-settings.json')
const AUTH_USERNAME = 'acceptance'
const AUTH_PASSWORD = 'acceptance-pass-1'
const TERMINAL_PHASES = new Set(['completed', 'failed', 'stopped'])
/** Marker prefix for every prompt this walkthrough sends. */
const MARKER = 'PSB'
/** The acceptance check ids the final verdict requires, in execution order. */
export const PROGRESS_ACCEPT_CHECK_IDS = [
  'progress-tasks',
  'no-fabricated-percentage',
  'parent-no-self-spawn',
  'dual-entry-system-skills',
  'package-lane-depth-two',
  'switch-history-restart',
  'single-cancel-isolation',
]
/** Debug-only `--only` scene keys, in the order the full walkthrough drives them. */
const SCENE_IDS = ['tasks', 'percent', 'at', 'lane', 'siblings', 'switch', 'dual']
/** Provider-side failure copy; a matching turn error blocks instead of failing the product. */
const MODEL_UNAVAILABLE_PATTERN = /(401|403|unauthorized|invalid[ _-]?api[ _-]?key|no_adapter|econnrefused|enotfound|etimedout|socket hang up)/iu
const SECRETS = []

/* ------------------------------------------------------------------------- *
 * Pure criteria (unit-tested by huaanwork-host-progress-sidebar-acceptance.spec.mjs)
 * ------------------------------------------------------------------------- */

function toolNamesOfHeader(header) {
  const tools = Array.isArray(header?.tools) ? header.tools : []
  return tools.flatMap((tool) => (
    tool !== null && typeof tool === 'object' && typeof tool.name === 'string' && tool.name !== ''
      ? [tool.name]
      : []
  ))
}

/**
 * Extract the `request/header` tool schema snapshots from a decoded session log.
 *
 * `request/header` is append-only and only logged when the header changes, so
 * each snapshot states the complete tool surface in force from that point on.
 *
 * @param events - decoded session events in log order
 * @returns the ordered snapshots, the union of declared tool names, and the count carrying `subagent`
 */
export function inspectSessionHeaderTools(events) {
  const requests = []
  for (const [index, event] of (Array.isArray(events) ? events : []).entries()) {
    if (event === null || typeof event !== 'object' || event.type !== 'request/header') continue
    const toolNames = toolNamesOfHeader(event.data?.header)
    requests.push({
      index,
      seq: typeof event.seq === 'number' ? event.seq : null,
      reason: typeof event.data?.reason === 'string' ? event.data.reason : null,
      toolNames,
      hasSubagent: toolNames.includes('subagent'),
    })
  }
  return {
    requestCount: requests.length,
    requests,
    subagentSnapshotCount: requests.filter((request) => request.hasSubagent).length,
    unionToolNames: [...new Set(requests.flatMap((request) => request.toolNames))].sort(),
  }
}

function namesOfPhase(phase) {
  return Array.isArray(phase) ? phase.filter((name) => typeof name === 'string') : []
}

/**
 * Compare the three header-tool phases around one system-skill execution.
 *
 * `subagent` must be absent before the execution turn, present in the execution
 * turn (the lease opens the delegation tool), and absent again in the next
 * ordinary turn (the lease is reclaimed).
 *
 * @param phases - `{ before, during, after }` tool-name lists
 * @returns the observed booleans, the added/removed names, and failure reasons
 */
export function compareHeaderToolPhases(phases) {
  const before = namesOfPhase(phases?.before)
  const during = namesOfPhase(phases?.during)
  const after = namesOfPhase(phases?.after)
  const beforeHasSubagent = before.includes('subagent')
  const duringHasSubagent = during.includes('subagent')
  const afterHasSubagent = after.includes('subagent')
  const reasons = []
  if (before.length === 0) reasons.push('no ordinary pre-execution header snapshot')
  if (beforeHasSubagent) reasons.push('subagent is already present in the ordinary turn before the execution window')
  if (!duringHasSubagent) reasons.push('subagent is absent during the system-skill execution window')
  if (afterHasSubagent) reasons.push('subagent was not reclaimed after the execution window')
  return {
    ok: reasons.length === 0,
    beforeHasSubagent,
    duringHasSubagent,
    afterHasSubagent,
    added: [...new Set(during.filter((name) => !before.includes(name)))],
    removed: [...new Set(before.filter((name) => !during.includes(name)))].concat(
      [...new Set(during.filter((name) => !after.includes(name)))].filter((name) => !before.includes(name)),
    ),
    reasons,
  }
}

function sessionHeaderFacts(session) {
  const header = session?.header ?? {}
  return {
    id: typeof header.id === 'string' ? header.id : null,
    parentSession: typeof header.parentSession === 'string' ? header.parentSession : null,
    origin: typeof header.origin === 'string' ? header.origin : null,
    delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : null,
  }
}

/**
 * Pin the package lane identity chain from session headers: one depth-1 package
 * child under the root session, and the depth-2 lane sessions under that child.
 *
 * @param sessionHeaders - session header facts (`id`, `parentSession`, `origin`, `delegationDepth`)
 * @param rootId - the parent session the package was dispatched from
 * @returns the chain facts; `identityOk` requires exactly one child and at least one lane
 */
export function inspectDelegationChain(sessionHeaders, rootId) {
  const headers = (Array.isArray(sessionHeaders) ? sessionHeaders : [])
    .filter((header) => header !== null && typeof header === 'object' && typeof header.id === 'string')
  const rootFound = headers.some((header) => header.id === rootId)
  const children = headers.filter((header) => header.parentSession === rootId
    && header.origin === 'subagent'
    && header.delegationDepth === 1)
  const child = children.length === 1 ? children[0] : undefined
  const lanes = child === undefined
    ? []
    : headers.filter((header) => header.parentSession === child.id
      && header.origin === 'subagent'
      && header.delegationDepth === 2)
  return {
    rootId,
    rootFound,
    childCount: children.length,
    childId: child?.id ?? null,
    childDepth: child?.delegationDepth ?? null,
    laneIds: lanes.map((lane) => lane.id),
    laneDepths: lanes.map((lane) => lane.delegationDepth),
    identityOk: rootFound && children.length === 1 && lanes.length > 0,
  }
}

function parseJsonOrEmpty(text) {
  if (typeof text !== 'string' || text === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Count `subagent.cancel` RPCs captured from the renderer network layer and how
 * many carry the target runId; any other runId in a cancel request is a
 * sibling-isolation violation.
 *
 * @param requests - captured requests (`url`, `postData`)
 * @param runId - the run the single confirm click targeted
 * @returns the cancel request count, the target hits, and the foreign runIds
 */
export function countSubagentCancelRequests(requests, runId) {
  const cancelRequests = (Array.isArray(requests) ? requests : []).filter((request) => (
    request !== null
    && typeof request === 'object'
    && typeof request.url === 'string'
    && request.url.includes('/huaanwork/subagent/cancel')
  ))
  const bodies = cancelRequests.map((request) => parseJsonOrEmpty(request.postData))
  const runIds = [...new Set(bodies.flatMap((body) => (typeof body.runId === 'string' && body.runId !== '' ? [body.runId] : [])))]
  return {
    cancelRequestCount: cancelRequests.length,
    targetRunIdCount: bodies.filter((body) => body.runId === runId).length,
    otherRunIdCount: bodies.filter((body) => typeof body.runId === 'string' && body.runId !== runId).length,
    runIds,
    targetRunId: runId,
  }
}

function requireFacts(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * Final verdict over the seven automated walkthrough checks.
 *
 * Fails closed on any missing/false check, re-runs the Host restart evidence
 * relay, and rejects fabricated progress, duplicated cards, and cancel RPCs
 * that escaped the target run.
 *
 * @param facts - the walkthrough facts document written to `--out/facts.json`
 * @returns true when every criterion holds
 * @throws Error naming the failing check and its recorded reasons
 */
export function assertProgressSidebarAcceptanceFacts(facts) {
  if (facts === null || typeof facts !== 'object') throw new Error('acceptance facts are missing')
  const checks = facts.checks
  if (checks === null || typeof checks !== 'object') throw new Error('acceptance facts carry no checks')
  const failures = []
  for (const id of PROGRESS_ACCEPT_CHECK_IDS) {
    const check = checks[id]
    if (check === undefined) {
      failures.push(`${id}: not executed`)
      continue
    }
    if (check.ok !== true) {
      const reasons = Array.isArray(check.reasons) ? check.reasons.join('; ') : 'ok is not true'
      failures.push(`${id}: ${reasons}`)
    }
  }
  if (failures.length > 0) throw new Error(`progress sidebar acceptance failed: ${failures.join(' | ')}`)

  const tasks = checks['progress-tasks']
  requireFacts(tasks.promptSent === true, 'progress-tasks: the complex task request was not sent')
  requireFacts(Number.isInteger(tasks.taskCount) && tasks.taskCount >= 3, `progress-tasks: task list rendered ${String(tasks.taskCount)} tasks (expected at least 3)`)
  requireFacts(tasks.countMatched === true, `progress-tasks: header count ${JSON.stringify(tasks.countText)} does not match the rendered tasks`)
  requireFacts(tasks.highlightedSeen === true, 'progress-tasks: no highlighted in-progress task was observed during execution')
  requireFacts(tasks.mainTodoCardCount === 1, `progress-tasks: main flow carries ${String(tasks.mainTodoCardCount)} todo cards (expected exactly 1)`)
  requireFacts(Number.isInteger(tasks.sessionTodoWriteCount) && tasks.sessionTodoWriteCount >= 1, 'progress-tasks: the session log records no todo_write call for the turn')

  const percent = checks['no-fabricated-percentage']
  requireFacts(percent.taskPercentTexts === 0, `no-fabricated-percentage: ${String(percent.taskPercentTexts)} per-step percentage labels were rendered`)
  requireFacts(percent.countPercentTexts === 0, `no-fabricated-percentage: the header count rendered a percentage`)
  requireFacts(percent.taskProgressBarCount === 0, `no-fabricated-percentage: ${String(percent.taskProgressBarCount)} per-step progress bars were rendered`)
  requireFacts(percent.totalBarMatchesCount === true, `no-fabricated-percentage: the §8.1 total progress bar does not track the X/Y count (${percent.totalBarReason ?? 'no reason'})`)
  requireFacts(percent.countFormatAlwaysXY === true, 'no-fabricated-percentage: the header count left the X/Y format during execution')
  requireFacts(percent.activityMatchesSession === true, 'no-fabricated-percentage: the current-turn activity does not match the session log')
  requireFacts(percent.latestRoundCovered === true, 'no-fabricated-percentage: the latest model round is missing from the activity panel')
  requireFacts(percent.activityAnchorMatched === true, 'no-fabricated-percentage: the progress panel turn anchor does not match the complex turn clientMessageId')
  requireFacts(percent.activityCallsMatched === true, 'no-fabricated-percentage: the activity entries do not match the session tool callId/roundKey records')
  if (Array.isArray(percent.foreignActivityNames)) {
    requireFacts(percent.foreignActivityNames.length === 0, `no-fabricated-percentage: ${String(percent.foreignActivityNames.length)} activity tool names are absent from the current turn (${percent.foreignActivityNames.join(', ')})`)
  }
  if (Array.isArray(percent.foreignActivityCalls)) {
    requireFacts(percent.foreignActivityCalls.length === 0, `no-fabricated-percentage: ${String(percent.foreignActivityCalls.length)} activity entries lack a matching current-turn callId/roundKey`)
  }

  const spawn = checks['parent-no-self-spawn']
  requireFacts(Number.isInteger(spawn.ordinaryTurnCount) && spawn.ordinaryTurnCount >= 1, 'parent-no-self-spawn: no ordinary turn was inspected')
  requireFacts(spawn.ordinaryTurnsWithoutSubagent === true, 'parent-no-self-spawn: an ordinary turn request header exposed the subagent tool')
  requireFacts(spawn.legacyAtCardSeen === true, `parent-no-self-spawn: the explicit legacy ${String(spawn.legacyAtLabel)} dispatch produced no run card`)
  requireFacts(spawn.legacyAtKind === 'legacy', `parent-no-self-spawn: expected legacy run kind, got ${String(spawn.legacyAtKind)}`)
  requireFacts(spawn.legacyTargetedCancelConverged === true, `parent-no-self-spawn: the targeted cancel of the legacy ${String(spawn.legacyAtLabel)} run did not converge`)
  requireFacts(spawn.explicitCardSeen === true, `parent-no-self-spawn: the explicit ${String(spawn.explicitAtLabel)} dispatch produced no run card`)
  requireFacts(spawn.targetedCancelConverged === true, 'parent-no-self-spawn: the targeted cancel of the explicit @ run did not converge')

  const dual = checks['dual-entry-system-skills']
  requireFacts(Array.isArray(dual.entries) && dual.entries.length >= 3, 'dual-entry-system-skills: fewer than three entry/skill combinations were driven')
  requireFacts(dual.entries.every((entry) => entry.runSeenInRail === true && entry.runSeenInMain === true), 'dual-entry-system-skills: a system-skill run card was not visible in both the rail and the main flow')
  requireFacts(dual.entries.every((entry) => entry.runKind === 'system-skill'), 'dual-entry-system-skills: an entry run did not record kind=system-skill')
  requireFacts(dual.entries.every((entry) => entry.anchorMatched === true), 'dual-entry-system-skills: an entry run clientMessageId did not match its parent turn anchor')
  requireFacts(dual.entries.every((entry) => entry.headerHasSubagent === true), 'dual-entry-system-skills: an entry lacked subagent in its own turn request/header snapshots')
  const modelEntries = dual.entries.filter((entry) => entry.entry === 'model-skill')
  requireFacts(modelEntries.length >= 1 && modelEntries.every((entry) => entry.skillToolCalled === true), 'dual-entry-system-skills: the model-skill entry did not invoke the skill tool in the session log')
  requireFacts(Number.isInteger(dual.cancelledCount) && dual.cancelledCount >= 1, 'dual-entry-system-skills: no system-skill run was stopped through the targeted cancel control')
  const phaseReasons = Array.isArray(dual.phaseComparison?.reasons) ? dual.phaseComparison.reasons.join('; ') : 'phase comparison missing'
  requireFacts(dual.phaseComparison?.ok === true, `dual-entry-system-skills: request/header tool phases failed: ${phaseReasons}`)

  const lane = checks['package-lane-depth-two']
  requireFacts(lane.outerCardSeenInRail === true && lane.outerCardSeenInMain === true, 'package-lane-depth-two: the outer package run card is missing from the rail or the main flow')
  requireFacts(lane.railLaneRowCount === 0, `package-lane-depth-two: ${String(lane.railLaneRowCount)} independent lane rows appeared in the rail`)
  requireFacts(typeof lane.aggregatedToolSummary === 'string' && lane.aggregatedToolSummary !== '', 'package-lane-depth-two: the rail never showed an aggregated tool summary')
  requireFacts(lane.outerSummaryFromOuterChildOnly === true, 'package-lane-depth-two: the outer package summary leaked a tool not called by the depth-1 package child')
  requireFacts(lane.chain?.identityOk === true, 'package-lane-depth-two: the parent -> package child -> lane identity chain did not resolve')
  requireFacts(Array.isArray(lane.chain?.laneIds) && lane.chain.laneIds.length === 2, `package-lane-depth-two: found ${String(lane.chain?.laneIds?.length)} depth-2 lanes (expected exactly 2)`)
  requireFacts(Array.isArray(lane.chain?.laneDepths) && lane.chain.laneDepths.every((depth) => depth === 2), 'package-lane-depth-two: a lane session is not at delegation depth 2')
  requireFacts(Array.isArray(lane.laneResults) && lane.laneResults.length === 2, 'package-lane-depth-two: lane result facts are missing')
  requireFacts(lane.laneResults.every((result) => result.isError === false), 'package-lane-depth-two: a lane ended with an error result')
  requireFacts(lane.laneResults.every((result) => Number.isInteger(result.finalTextLength) && result.finalTextLength > 0), 'package-lane-depth-two: a lane produced no closing text')
  requireFacts(lane.laneResults.every((result) => result.settlementDelivered === true), 'package-lane-depth-two: a lane result was never delivered to the package child')

  const switched = checks['switch-history-restart']
  requireFacts(switched.freshTabTaskCount === 0, 'switch-history-restart: the previous session todo leaked into the fresh tab')
  requireFacts(switched.previousTodoNotInFreshTab === true, 'switch-history-restart: the previous session todo was not isolated from the fresh tab')
  requireFacts(switched.previousTurnTodoNotCarried === true, 'switch-history-restart: a new turn in the same session still showed the previous turn todo')
  requireFacts(switched.historyTodoCardCount >= 1, 'switch-history-restart: history reload rendered no todo cards')
  requireFacts(Number.isInteger(switched.historyReloadTaskCount) && switched.historyReloadTaskCount >= 3, 'switch-history-restart: the reloaded progress panel lost the task list')
  requireFacts(switched.reconnectBannerSeen === true, 'switch-history-restart: no disconnect/reconnect banner was observed during the Host restart')
  requireFacts(switched.restart?.attempted === true && switched.restart?.asserted === true, 'switch-history-restart: the Host restart relay was not executed')
  requireFacts(Number.isInteger(switched.restart?.staleCardCount) && switched.restart.staleCardCount >= 1, 'switch-history-restart: no stale run card appeared after the Host restart')
  try {
    assertHostRestartEvidence(switched.restart.evidence)
  } catch (cause) {
    throw new Error(`switch-history-restart: Host restart evidence relay failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }

  const cancel = checks['single-cancel-isolation']
  requireFacts(typeof cancel.targetRunId === 'string' && cancel.targetRunId !== '', 'single-cancel-isolation: no target runId was observed')
  requireFacts(cancel.cancelRpc?.targetRunIdCount === 1, `single-cancel-isolation: the target run received ${String(cancel.cancelRpc?.targetRunIdCount)} subagent.cancel requests (expected exactly 1)`)
  requireFacts(cancel.cancelRpc?.otherRunIdCount === 0, `single-cancel-isolation: ${String(cancel.cancelRpc?.otherRunIdCount)} cancel requests escaped to another runId`)
  requireFacts(cancel.siblingCompleted === true, 'single-cancel-isolation: the concurrent sibling run did not complete')
  requireFacts(cancel.siblingSettlementSeen === true, 'single-cancel-isolation: the sibling run was never delivered back to the parent')
  requireFacts(cancel.mainCardCounts?.target === 1 && cancel.mainCardCounts?.sibling === 1, 'single-cancel-isolation: a duplicated or missing main-flow run card was observed')
  requireFacts(cancel.railCardCounts?.target === 1 && cancel.railCardCounts?.sibling === 1, 'single-cancel-isolation: a duplicated or missing rail run card was observed')
  requireFacts(cancel.perRunCardUnique === true, 'single-cancel-isolation: per-runId card uniqueness failed')
  requireFacts(cancel.mainToolPanelsUnique === true, 'single-cancel-isolation: the main flow rendered duplicate tool panels')
  requireFacts(cancel.duplicateFree === true, `single-cancel-isolation: duplicated cards were observed (todo cards ${String(cancel.todoCardCount)})`)
  requireFacts(
    !(typeof facts.isolatedCleanup === 'string' && facts.isolatedCleanup.startsWith('failed:')),
    `isolated credential cleanup failed: ${String(facts.isolatedCleanup)}`,
  )
  return true
}

/** Whether any already-executed check has recorded an explicit product failure (`ok !== true`). */
export function hasRecordedCheckFailure(checks) {
  if (checks === null || typeof checks !== 'object') return false
  return Object.values(checks).some((check) => check !== null && typeof check === 'object' && check.ok !== true)
}

/**
 * Resolve an exception thrown by `run()` into final outcome and exit code.
 * A `BlockedError` can only classify the run as `BLOCKED` (exit 3) when no
 * earlier scene already recorded a real check failure; otherwise `FAIL` (1) wins.
 */
export function resolveBlockedOrFailedOutcome(factsDoc, checks, error, redact = (value) => value) {
  const target = factsDoc ?? {
    schemaVersion: 1,
    outcome: 'FAIL',
    startedAt: new Date().toISOString(),
    errors: [],
    screenshots: [],
  }
  const now = new Date().toISOString()
  target.finishedAt = now
  if (error?.name === 'BlockedError' || error instanceof BlockedError) {
    const allowedCheckId = typeof error?.detail?.onlyBlockedCheckId === 'string'
      ? error.detail.onlyBlockedCheckId
      : undefined
    const remainingChecks = allowedCheckId === undefined || checks === null || typeof checks !== 'object'
      ? checks
      : Object.fromEntries(Object.entries(checks).filter(([id]) => id !== allowedCheckId))
    target.blocked = { cause: error.message, detail: error.detail ?? {} }
    target.errors = [...(target.errors ?? []), error.message]
    if (hasRecordedCheckFailure(remainingChecks)) {
      target.outcome = 'FAIL'
      return { facts: target, exitCode: 1 }
    }
    target.outcome = 'BLOCKED'
    return { facts: target, exitCode: 3 }
  }
  target.outcome = 'FAIL'
  target.errors = [...(target.errors ?? []), redact(String(error?.stack ?? error))]
  return { facts: target, exitCode: 1 }
}

/**
 * Persist in-scene product failures right before throwing a late `BlockedError`
 * inside a multi-phase scene, so `resolveBlockedOrFailedOutcome` records `FAIL` (1)
 * with the accumulated reasons instead of downgrading to `BLOCKED` (3).
 */
export function recordPartialCheckFailureBeforeBlocked(checkId, reasons, partialFact, record = checkFact) {
  const nonEmpty = Array.isArray(reasons) ? reasons.filter((reason) => typeof reason === 'string' && reason !== '') : []
  if (nonEmpty.length === 0) return false
  record(checkId, {
    ...partialFact,
    ok: false,
    reasons: nonEmpty,
  })
  return true
}

/**
 * Remove the isolated credential/profile root and enforce fail-closed exit semantics:
 * if deletion fails, `facts.outcome` cannot stay `PASS`/`BLOCKED` and the leftover path is surfaced.
 */
export function cleanupIsolatedRoot(
  rootDir,
  factsDoc,
  {
    keepTemp = process.env.PSB_DEBUG_KEEP_TEMP === '1',
    removeDir = (dir) => rmSync(dir, { recursive: true, force: true }),
  } = {},
) {
  if (rootDir === undefined) return { ok: true, kept: false }
  if (keepTemp) {
    if (factsDoc !== undefined) factsDoc.isolatedCleanup = 'kept for debugging (PSB_DEBUG_KEEP_TEMP=1)'
    return { ok: true, kept: true, rootDir }
  }
  try {
    removeDir(rootDir)
    if (factsDoc !== undefined) factsDoc.isolatedCleanup = 'removed'
    return { ok: true, kept: false, rootDir }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (factsDoc !== undefined) {
      factsDoc.isolatedCleanup = `failed: ${detail}`
      factsDoc.errors = [
        ...(factsDoc.errors ?? []),
        `isolated credential root ${rootDir} could not be removed (${detail}); remove it manually`,
      ]
      if (factsDoc.outcome === 'PASS' || factsDoc.outcome === 'PENDING' || factsDoc.outcome === 'BLOCKED') {
        factsDoc.outcome = 'FAIL'
      }
    }
    return { ok: false, kept: false, rootDir, detail }
  }
}

/** Compute final process exit code AFTER shutdown/cleanup has completed. */
export function resolveFinalExitCode(factsDoc, cleanupResult) {
  if (cleanupResult?.ok === false) return 1
  if (factsDoc?.outcome === 'PASS') return 0
  if (factsDoc?.outcome === 'BLOCKED') return 3
  return 1
}

/* ------------------------------------------------------------------------- *
 * CLI
 * ------------------------------------------------------------------------- */

/** A precondition the walkthrough cannot work around; reported as BLOCKED (exit 3). */
class BlockedError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'BlockedError'
    this.detail = detail
  }
}

/**
 * CLI options. Parsed only when this file is the invoked entry point: importing
 * the module from its unit spec must not create output directories or reject the
 * test runner's own argv.
 */
let options = { outDir: undefined, timeout: 240_000, cdp: undefined, only: undefined }
const screenshots = []
const driverLog = []
let appLogFile
let appProcess
let appCdp
let legacyCatalogServer
let tempRoot
let userDataDir
let isolated
let mainLogPath
let facts
let shutdownDone = false
let lastCleanupResult = { ok: true, kept: false }
let rpcRequests = []
const progress = { checks: {} }

function parseArguments(argv) {
  const parsed = { outDir: undefined, timeout: 240_000, cdp: undefined, only: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const value = argv[index + 1]
    if (token === '--out' && value !== undefined) { parsed.outDir = resolve(value); index += 1 }
    else if (token === '--timeout' && value !== undefined) { parsed.timeout = Number(value); index += 1 }
    else if (token === '--cdp' && value !== undefined) { parsed.cdp = value; index += 1 }
    else if (token === '--only' && value !== undefined) {
      const scenes = value.split(',').map((scene) => scene.trim()).filter((scene) => scene !== '')
      if (scenes.length === 0 || scenes.some((scene) => !SCENE_IDS.includes(scene))) {
        console.error(`--only accepts a comma-separated subset of ${SCENE_IDS.join(',')}`)
        process.exit(2)
      }
      parsed.only = scenes
      index += 1
    }
    else {
      console.error(`unknown argument: ${token}`)
      console.error('usage: node scripts/huaanwork-accept-progress-sidebar.mjs [--out <dir>] [--timeout <ms>] [--cdp <port>] [--only <scene,scene>]')
      process.exit(2)
    }
  }
  if (parsed.outDir === undefined) parsed.outDir = mkdtempSync(join(tmpdir(), 'progress-sidebar-accept-out-'))
  if (!Number.isSafeInteger(parsed.timeout) || parsed.timeout < 30_000) {
    console.error('--timeout must be an integer of at least 30000ms')
    process.exit(2)
  }
  if (parsed.cdp !== undefined && !/^\d+$/u.test(parsed.cdp)) {
    console.error('--cdp must be a numeric port')
    process.exit(2)
  }
  return parsed
}

function registerSecrets(values) {
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue
    if (!SECRETS.includes(value)) SECRETS.push(value)
  }
}

function log(message) {
  const line = `${new Date().toISOString()} ${redactSecrets(message, SECRETS)}`
  driverLog.push(line)
  process.stdout.write(`${line}\n`)
}

function delay(ms) {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, ms) })
}

function runGit(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function clip(text, max) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function appVersions() {
  const desktop = readJson(join(PACKAGE_ROOT, 'package.json'))?.version
  const require = createRequire(import.meta.url)
  const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
  const dsh = readJson(dshManifest)?.version
  if (typeof desktop !== 'string' || desktop === '') throw new Error('desktop package version is missing')
  if (typeof dsh !== 'string' || dsh === '') throw new Error('dsh package version is missing')
  return { desktop, dsh }
}

/** The lane walkthrough needs `textutil` to mint a real docx sample (macOS only). */
function requireTextutil() {
  const probe = spawnSync('textutil', ['-help'], { encoding: 'utf8' })
  if (probe.error?.code === 'ENOENT') {
    throw new BlockedError('textutil is unavailable; the docx sample for the package lane cannot be generated', { platform: process.platform })
  }
}

/** Session logs are multi-frame zstd; Node zlib only decodes the first frame. */
function requireZstd() {
  const probe = spawnSync('zstd', ['--version'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    throw new BlockedError(
      'zstd CLI not found on PATH; session logs are multi-frame zstd and Node zlib only decodes the first frame',
      { status: probe.status, error: probe.error?.code },
    )
  }
  return (probe.stdout ?? '').trim().split('\n')[0] ?? ''
}

function newestSourceMtime() {
  let newest = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) newest = Math.max(newest, statSync(path).mtimeMs)
    }
  }
  walk(join(PACKAGE_ROOT, 'src'))
  return newest
}

function requireFreshBuild() {
  if (!existsSync(MAIN_PATH)) {
    throw new BlockedError(`built main process is missing: ${MAIN_PATH}; run corepack yarn workspace dsh-plugin-huaanwork build first`)
  }
  const libMtime = statSync(MAIN_PATH).mtimeMs
  const sourceMtime = newestSourceMtime()
  if (libMtime < sourceMtime) {
    throw new BlockedError(
      `built lib is older than src (lib ${new Date(libMtime).toISOString()} < src ${new Date(sourceMtime).toISOString()}); rebuild the package`,
    )
  }
  return { libMainMtime: new Date(libMtime).toISOString(), newestSourceMtime: new Date(sourceMtime).toISOString() }
}

/** The launcher loads the Electron-ABI fs-ext binding; a stale one fails deep inside the host. */
function requireElectronNative() {
  const require = createRequire(import.meta.url)
  let fsExtRoot
  try {
    fsExtRoot = dirname(require.resolve('fs-ext/package.json'))
  } catch (cause) {
    throw new BlockedError(`fs-ext is not installed for the desktop package: ${cause instanceof Error ? cause.message : String(cause)}`, {
      remediation: 'corepack yarn install --immutable',
    })
  }
  const dir = join(fsExtRoot, 'prebuilds', `${osPlatform()}-${osArch()}`)
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => /^electron\.abi\d+\.node$/u.test(name)).sort() : []
  if (files.length === 0) {
    throw new BlockedError(`Electron-ABI fs-ext binding is missing under ${dir}`, {
      remediation: 'corepack yarn workspace dsh-plugin-huaanwork prepare:electron-native',
    })
  }
  return { path: join(dir, files[0]), files }
}

/** Read-only copy of the production model settings; only the six model fields are forwarded. */
function readProductionModelSettings() {
  if (!existsSync(PRODUCTION_SETTINGS_PATH)) {
    throw new BlockedError(`production model settings are missing: ${PRODUCTION_SETTINGS_PATH}`)
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(PRODUCTION_SETTINGS_PATH, 'utf8'))
  } catch (cause) {
    throw new BlockedError(`production model settings are unreadable: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BlockedError('production model settings are not a JSON object')
  }
  const models = Array.isArray(raw.models)
    ? raw.models
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
      .map((entry) => ({
        id: entry.id,
        name: typeof entry.name === 'string' ? entry.name : '',
        base_url: typeof entry.base_url === 'string' ? entry.base_url : '',
        model: typeof entry.model === 'string' ? entry.model : '',
        api_key: typeof entry.api_key === 'string' ? entry.api_key : '',
      }))
    : []
  const settings = {
    base_url: typeof raw.base_url === 'string' ? raw.base_url : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    api_key: typeof raw.api_key === 'string' ? raw.api_key : '',
    models,
    active_model_id: typeof raw.active_model_id === 'string' ? raw.active_model_id : '',
    allow_network: raw.allow_network !== false,
  }
  const active = models.find((entry) => entry.id === settings.active_model_id) ?? models[0]
  const credential = active?.api_key || settings.api_key
  if (typeof credential !== 'string' || credential.length === 0) {
    throw new BlockedError('production model settings carry no api_key for the active model')
  }
  registerSecrets([settings.api_key, ...models.map((entry) => entry.api_key)])
  return {
    settings,
    summary: {
      activeModelId: active?.id ?? settings.active_model_id,
      providerName: active?.name ?? '',
      model: active?.model ?? settings.model,
      baseUrl: active?.base_url ?? settings.base_url,
      apiKeyPresent: true,
      allowNetwork: settings.allow_network,
      modelCount: models.length,
      source: 'copied read-only from the production active entry (api_key never printed)',
    },
  }
}

async function writeAuthState(profileDir) {
  const salt = randomBytes(16)
  const hash = await scryptAsync(AUTH_PASSWORD, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  writeFileSync(join(profileDir, 'account.json'), `${JSON.stringify({
    username: AUTH_USERNAME,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    kdf: 'scrypt',
    N: 16384,
    r: 8,
    p: 1,
  }, null, 2)}\n`)
  writeFileSync(join(profileDir, 'auth-session.json'), `${JSON.stringify({ username: AUTH_USERNAME }, null, 2)}\n`)
}

function setupWizardStatePath(userDataDirPath, profileDir) {
  const profileHash = createHash('sha256').update(resolve(profileDir)).digest('hex')
  return join(userDataDirPath, 'profile-setup', profileHash, 'state.json')
}

function makeSampleDocx(workDir) {
  const txt = join(workDir, 'sample.txt')
  const docx = join(workDir, 'sample.docx')
  writeFileSync(txt, [
    '本设备按装完毕，运行良好。',
    '积极应对市市场波动。',
  ].join('\n'), 'utf8')
  const result = spawnSync('textutil', ['-convert', 'docx', '-output', docx, txt], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`textutil failed to mint the docx sample: ${result.stderr ?? ''}`)
  return docx
}

function makeSampleCode(workDir) {
  const file = join(workDir, 'sample-review.js')
  writeFileSync(file, [
    "const apiKey = 'sk-hardcoded-secret-12345';",
    'function run(userInput) {',
    '  return eval(userInput);',
    '}',
    'module.exports = { run, apiKey };',
  ].join('\n'), 'utf8')
  return file
}

const LEGACY_AGENT_NAME = 'legacy-reviewer'

const LEGACY_TEST_AGENT = {
  name: LEGACY_AGENT_NAME,
  version: '1.0.0',
  kind: 'agent',
  description: '只读代码审阅代理，用于验证 legacy @agent 路径',
  permissions: ['read', 'glob'],
  allow: ['read', 'glob'],
  persona: [
    '你是只读代码审阅子代理。收到请求后，必须按顺序分多步调用工具仔细核对目标文件：',
    '1) 用 glob 列出工作区全部文件；',
    '2) 逐个用 read 读取 README.md、samples/sample-review.js 与 samples/sample.txt；',
    '3) 对每个文件逐行分析结构、依赖与潜在问题后再输出详细报告。',
  ].join('\n'),
}

function startLegacyCatalogServer() {
  return new Promise((resolveServer, rejectServer) => {
    const server = createHttpServer((request, response) => {
      const path = (request.url ?? '').split('?')[0]
      if (path === '/v1/catalog') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ items: [LEGACY_TEST_AGENT] }))
        return
      }
      if (path === `/v1/catalog/${encodeURIComponent(LEGACY_AGENT_NAME)}`) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(LEGACY_TEST_AGENT))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
    })
    server.once('error', rejectServer)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        rejectServer(new Error('legacy catalog server did not bind a TCP port'))
        return
      }
      resolveServer({
        server,
        port: address.port,
        close: () => new Promise((resolveClose) => {
          server.close(() => resolveClose())
        }),
      })
    })
  })
}

function prepareProfile({ homeDir, userDataDir: userData, workspaceDir, models, legacyCatalogPort }) {
  const versions = appVersions()
  const profileDir = join(homeDir, 'profiles', 'desktop')
  const parentDir = dirname(homeDir)
  mkdirSync(parentDir, { recursive: true })
  initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  mkdirSync(workspaceDir, { recursive: true })
  writeFileSync(join(workspaceDir, 'README.md'), '# progress sidebar acceptance workspace\n')
  runGit(['init', '-q'], workspaceDir)

  const flat = {
    base_url: models.base_url,
    // 验收需要模型稳定遵循「必须调用 subagent」的技能指令;deepseek-flash 在多轮
    // 双入口场景会自述没有 subagent。用 deepseek-chat 驱动,端点/密钥仍只读复制。
    model: process.env.PSB_ACCEPTANCE_MODEL ?? 'deepseek-chat',
    api_key: models.api_key,
    models: models.models.map((entry) => entry.id === models.active_model_id
      ? { ...entry, model: process.env.PSB_ACCEPTANCE_MODEL ?? 'deepseek-chat' }
      : entry),
    active_model_id: models.active_model_id,
    allow_network: models.allow_network,
  }
  writeFileSync(join(parentDir, 'settings.json'), `${JSON.stringify(flat, null, 2)}\n`)
  writeFileSync(join(profileDir, 'huaanwork-settings.json'), `${JSON.stringify({
    theme: 'light',
    ...flat,
    // Never copy the production guard mode: the walkthrough pins smart so the
    // package child (no approval surface) can extract the docx sample.
    guard_mode: 'smart',
    automation_timeout_ms: 600_000,
    keep_awake: false,
    ...(legacyCatalogPort === undefined ? {} : { agents_host: '127.0.0.1', agents_port: legacyCatalogPort }),
  }, null, 2)}\n`)
  if (legacyCatalogPort !== undefined) {
    writeFileSync(join(profileDir, 'agents-enabled.json'), `${JSON.stringify({
      [`catalog:${LEGACY_AGENT_NAME}`]: true,
    }, null, 2)}\n`)
  }
  writeFileSync(join(profileDir, 'huaanwork-workspace.json'), `${JSON.stringify({
    pendingRoot: workspaceDir,
    writtenAt: new Date().toISOString(),
  })}\n`)

  const statePath = setupWizardStatePath(userData, profileDir)
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(dirname(statePath), 0o700)
  writeFileSync(statePath, `${JSON.stringify({
    version: 2,
    profileHash: createHash('sha256').update(resolve(profileDir)).digest('hex'),
    outcome: 'skipped',
    desktopVersion: versions.desktop,
    dshVersion: versions.dsh,
    setupRevision: 1,
    recordedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(statePath, 0o600)
  return { profileDir, versions }
}

/** Seed the three shipped agent packages (the explicit `@` and lane walkthroughs need them). */
function seedAgentPackages(profileDir) {
  const result = spawnSync(process.execPath, ['--experimental-transform-types', SEED_SCRIPT, '--profile', profileDir], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new BlockedError('seeding the shipped agent packages into the isolated profile failed', {
      status: result.status,
      stderr: clip(result.stderr ?? '', 1200),
    })
  }
  return JSON.parse(result.stdout)
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address === null || typeof address === 'string') rejectPort(new Error('free port probe did not bind a TCP port'))
        else resolvePort(address.port)
      })
    })
  })
}

function createRedactingSink(file, target) {
  let buffer = ''
  const emit = (text) => {
    const redacted = redactSecrets(text, SECRETS)
    file.write(redacted)
    target.write(redacted)
  }
  return {
    push(chunk) {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        emit(buffer.slice(0, index + 1))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    },
    end() {
      if (buffer !== '') { emit(buffer); buffer = '' }
    },
  }
}

let streamSinks = []

async function launchApp({ homeDir, cdpPort, outDir }) {
  const require = createRequire(import.meta.url)
  const electronPath = require('electron')
  if (typeof electronPath !== 'string') throw new Error('electron package did not provide an executable path')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  env.DSH_HOME = homeDir
  env.DSH_TELEMETRY_DISABLED = '1'
  env.ELECTRON_ENABLE_LOGGING = '1'
  env.HUAANWORK_ACCEPTANCE_HOOKS = '1'
  log(`launch electron main=${MAIN_PATH} cdp=${String(cdpPort)}`)
  const child = spawn(electronPath, [
    MAIN_PATH,
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu',
    '--no-first-run',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ], {
    cwd: PACKAGE_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  appLogFile = createWriteStream(join(outDir, 'app-stdout.log'), { flags: 'a' })
  const stdoutSink = createRedactingSink(appLogFile, process.stdout)
  const stderrSink = createRedactingSink(appLogFile, process.stderr)
  streamSinks = [stdoutSink, stderrSink]
  child.stdout?.on('data', (chunk) => stdoutSink.push(chunk))
  child.stderr?.on('data', (chunk) => stderrSink.push(chunk))
  child.once('exit', (code, signal) => { log(`electron exited code=${String(code)} signal=${String(signal)}`) })
  return child
}

function findMainLog() {
  const dir = join(userDataDir, 'logs')
  let best
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.log$/u.test(entry.name)) continue
    const path = join(dir, entry.name)
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const match = /^--- .* run \d+ ---$/mu.exec(text)
    if (match === null) continue
    const mtime = statSync(path).mtimeMs
    if (best === undefined || mtime > best.mtime) best = { path, mtime }
  }
  return best?.path
}

async function mainRunCount(path) {
  if (path === undefined) return undefined
  try {
    const contents = readFileSync(path, 'utf8')
    return (contents.match(/^--- .* run \d+ ---$/gmu) ?? []).length
  } catch {
    return undefined
  }
}

async function listPageTargets(cdpPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
    if (!response.ok) return []
    const targets = await response.json()
    return targets.filter((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
  } catch {
    return []
  }
}

async function connectCdp(wsUrl, timeoutMs, onEvent) {
  const socket = new WebSocket(wsUrl)
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error(`CDP WebSocket did not open in ${timeoutMs}ms`)), timeoutMs)
    socket.addEventListener('open', () => { clearTimeout(timer); resolveOpen() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); rejectOpen(new Error('CDP WebSocket failed')) }, { once: true })
  })
  let sequence = 0
  const pending = new Map()
  const rejectPending = (cause) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(cause)
    }
    pending.clear()
  }
  socket.addEventListener('close', () => { rejectPending(new Error('CDP target closed')) })
  socket.addEventListener('error', () => { rejectPending(new Error('CDP WebSocket failed')) })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (!message.id) {
      onEvent?.(message)
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })
  const call = (method, params = {}) => new Promise((resolveCall, rejectCall) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectCall(new Error(`${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, { resolve: resolveCall, reject: rejectCall, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const response = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'evaluation failed')
    }
    return response.result?.value
  }
  await call('Runtime.enable')
  await call('Page.enable')
  await call('Network.enable')
  return {
    call,
    evaluate,
    close() {
      rejectPending(new Error('CDP client closed'))
      try { socket.close() } catch { /* already closed */ }
    },
  }
}

const APP_PROBE = `(() => ({
  readyState: document.readyState,
  url: location.href,
  hasAuth: document.querySelector('.auth-gate') !== null,
  hasComposer: document.querySelector('.composer textarea') !== null,
  hasShell: document.querySelector('.app-shell') !== null,
  body: (document.body?.innerText ?? '').slice(0, 400),
}))()`

const COMPOSER_STATE = `(() => {
  const textarea = document.querySelector('.composer textarea')
  const stop = document.querySelector('.composer button.send.stop')
  const send = document.querySelector('.composer button.send[aria-label="发送"]')
  return {
    hasComposer: textarea !== null,
    textareaDisabled: textarea?.disabled ?? null,
    turnActive: stop !== null,
    sendPresent: send !== null,
    sendDisabled: send?.disabled ?? null,
  }
})()`

const PROGRESS_STATE = `(() => {
  const panel = document.querySelector('.right-pane .progress-panel')
  if (!panel) return { mounted: false }
  const tasks = [...panel.querySelectorAll('.progress-task')].map((element) => ({
    content: (element.querySelector('.progress-task-content')?.textContent ?? '').trim(),
    status: element.getAttribute('data-status'),
    statusText: (element.querySelector('.progress-task-status')?.textContent ?? '').trim(),
  }))
  const activity = [...panel.querySelectorAll('.progress-activity-list .tool-panel')].map((element) => ({
    title: (element.querySelector('.tool-panel-title')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    expanded: element.querySelector('.tool-panel-title')?.getAttribute('aria-expanded') === 'true',
    entryCount: element.querySelectorAll('.tool-panel-entry').length,
  }))
  const subagents = [...panel.querySelectorAll('.progress-subagent-card')].map((card) => ({
    runId: card.getAttribute('data-run-id') ?? null,
    label: (card.querySelector('.subagent-run-label')?.textContent ?? '').trim(),
    phase: card.getAttribute('data-phase'),
    stale: card.getAttribute('data-stale') === 'true',
    statusText: (card.querySelector('.subagent-run-status-text')?.textContent ?? '').trim(),
    text: (card.textContent ?? '').replace(/\\s+/g, ' ').trim(),
  }))
  const countText = (panel.querySelector('.progress-count')?.textContent ?? '').trim()
  const percentTexts = [...panel.querySelectorAll('.progress-task-status, .progress-count')]
    .map((node) => (node.textContent ?? '').trim())
    .filter((text) => /\\d+\\s*%/u.test(text))
  const PROGRESS_BAR_SELECTOR = 'progress, meter, [role="progressbar"], .progress-bar'
  return {
    mounted: true,
    connection: panel.getAttribute('data-connection'),
    turnAnchor: panel.getAttribute('data-turn-anchor') ?? null,
    banner: (panel.querySelector('.progress-connection')?.textContent ?? '').trim() || null,
    emptyText: (panel.querySelector('.progress-section .panel-empty')?.textContent ?? '').trim() || null,
    tasks,
    activity,
    subagents,
    countText,
    percentTexts,
    // 规格 §8.1:单步不渲染进度条;总进度条只出现在分步任务区头部(Y > 0)。
    taskProgressBarCount: panel.querySelectorAll('.progress-task-list ' + PROGRESS_BAR_SELECTOR).length,
    totalProgressBarCount: panel.querySelectorAll('.progress-total-bar').length,
    panelText: (panel.textContent ?? '').replace(/\\s+/g, ' ').trim(),
  }
})()`

const CARDS_STATE = `(() => {
  const read = (card) => ({
    runId: card.getAttribute('data-run-id') ?? null,
    label: (card.querySelector('.subagent-run-label')?.textContent ?? '').trim(),
    phase: card.getAttribute('data-phase'),
    stale: card.getAttribute('data-stale') === 'true',
    status: ((card.querySelector('.subagent-run-status-text') ?? card.querySelector('.subagent-run-status'))?.textContent ?? '').trim(),
    text: (card.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    terminateDisabled: card.querySelector('.subagent-run-terminate')?.disabled ?? null,
    elapsed: card.querySelector('.subagent-run-status .subagent-run-meta')?.textContent ?? null,
  })
  return {
    main: [...document.querySelectorAll('.chat-log .subagent-run-card')].map(read),
    rail: [...document.querySelectorAll('.right-pane .subagent-run-card')].map(read),
    todoCards: document.querySelectorAll('.chat-log .todo-card').length,
    toolPanelBodies: [...document.querySelectorAll('.chat-log [id^="tool-panel-body-"]')].map((node) => node.id),
  }
})()`

const EXPAND_ACTIVITY = `(() => {
  const buttons = [...document.querySelectorAll('.right-pane .progress-activity-list .tool-panel-title')]
  let clicked = 0
  for (const button of buttons) {
    if (button.getAttribute('aria-expanded') === 'true') continue
    button.click()
    clicked += 1
  }
  return { panels: buttons.length, clicked }
})()`

const ACTIVITY_ENTRIES = `(() => [...document.querySelectorAll('.right-pane .progress-activity-list .tool-panel-entry-title code')]
  .map((node) => (node.textContent ?? '').trim())
  .filter((name) => name !== ''))()`

const ACTIVITY_ENTRY_DETAILS = `(() => [...document.querySelectorAll('.right-pane .progress-activity-list .tool-panel-entry')].map((entry) => {
  const name = (entry.querySelector('.tool-panel-entry-title code')?.textContent ?? '').trim()
  const callId = entry.getAttribute('data-call-id') ?? null
  const rawRound = entry.getAttribute('data-round-key')
  const roundKey = rawRound !== null && rawRound !== '' && Number.isFinite(Number(rawRound)) ? Number(rawRound) : null
  return { name, callId, roundKey }
}).filter((item) => item.name !== ''))()`

async function waitFor(label, probe, timeoutMs = 60_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await probe()
      if (last?.ok === true) return last.value
    } catch (cause) {
      last = { error: cause instanceof Error ? cause.message : String(cause) }
    }
    await delay(intervalMs)
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms; last=${clip(JSON.stringify(last), 1200)}`)
}

async function connectAppPage(cdpPort, timeoutMs) {
  let sawWizard = false
  try {
    return await waitFor('app page target', async () => {
      const targets = await listPageTargets(cdpPort)
      const candidates = targets.filter((target) => !String(target.url).startsWith('devtools://'))
      for (const target of candidates) {
        if (String(target.url).startsWith('dsh-setup-wizard:')) {
          if (!sawWizard) log(`setup wizard target is present: ${target.url}`)
          sawWizard = true
          continue
        }
        let client
        try {
          client = await connectCdp(target.webSocketDebuggerUrl, 10_000, (message) => {
            if (message.method !== 'Network.requestWillBeSent') return
            const request = message.params?.request
            if (typeof request?.url !== 'string' || !request.url.includes('/huaanwork/')) return
            rpcRequests.push({
              requestId: message.params.requestId,
              method: request.method,
              url: request.url,
              postData: typeof request.postData === 'string' ? request.postData : undefined,
            })
          })
          const state = await client.evaluate(APP_PROBE)
          if (state?.hasAuth === true || state?.hasComposer === true || state?.hasShell === true) {
            return { ok: true, value: client }
          }
          client.close()
        } catch (cause) {
          client?.close()
          log(`page target ${String(target.url)} not ready: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
      return { ok: false }
    }, timeoutMs, 1_000)
  } catch (cause) {
    if (sawWizard) throw new Error(`the setup wizard stayed open despite the skipped marker: ${cause instanceof Error ? cause.message : String(cause)}`)
    throw cause
  }
}

async function ensureLoggedIn(client) {
  const state = await client.evaluate(APP_PROBE)
  if (state?.hasComposer === true) return
  if (state?.hasAuth !== true) {
    await waitFor('composer or auth gate', async () => {
      const probe = await client.evaluate(APP_PROBE)
      return { ok: probe?.hasComposer === true || probe?.hasAuth === true, value: probe }
    }, 120_000, 500)
    return ensureLoggedIn(client)
  }
  log('auth gate is visible; submitting the local acceptance account through the UI')
  const submitted = await client.evaluate(`(() => {
    const inputs = [...document.querySelectorAll('.auth-card input')]
    if (inputs.length < 2) return { ok: false, reason: 'auth inputs missing' }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const values = [${JSON.stringify(AUTH_USERNAME)}, ${JSON.stringify(AUTH_PASSWORD)}, ${JSON.stringify(AUTH_PASSWORD)}]
    inputs.forEach((input, index) => {
      setter.call(input, values[index] ?? values[1])
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const submit = document.querySelector('.auth-card button[type="submit"]')
    if (!submit) return { ok: false, reason: 'auth submit missing' }
    if (submit.disabled) return { ok: false, reason: 'auth submit disabled' }
    submit.click()
    return { ok: true }
  })()`)
  if (submitted?.ok !== true) throw new Error(`auth fallback failed: ${JSON.stringify(submitted)}`)
  await waitFor('composer after auth', async () => {
    const probe = await client.evaluate(APP_PROBE)
    return { ok: probe?.hasComposer === true, value: probe }
  }, 60_000, 500)
}

async function composerState(client) {
  return client.evaluate(COMPOSER_STATE)
}

async function waitForComposerIdle(client, timeoutMs = 120_000) {
  return waitFor('composer idle', async () => {
    const state = await composerState(client)
    return { ok: state?.hasComposer === true && state.turnActive === false && state.textareaDisabled !== true, value: state }
  }, timeoutMs, 250)
}

async function sendText(client, text, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await client.evaluate(`(async () => {
      const textarea = document.querySelector('.composer textarea')
      if (!textarea) return { ok: false, reason: 'composer missing' }
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, ${JSON.stringify(text)})
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 120))
      const send = document.querySelector('.composer button.send[aria-label="发送"]')
      if (!send) return { ok: false, reason: 'send button missing' }
      if (send.disabled) return { ok: false, reason: 'send disabled' }
      send.click()
      return { ok: true }
    })()`)
    if (result?.ok === true) return
    await delay(500)
  }
  throw new Error(`send failed for ${JSON.stringify(clip(text, 120))}`)
}

/**
 * After a send, the stop control (and the user bubble) lag the click by a React
 * commit; waiting only for "idle" would observe the pre-send state. The stop
 * control is the authoritative "turn is running" marker: a bubble without it is
 * only accepted after a grace window so a genuinely instant turn still settles.
 *
 * @param previousUserBubbles - the user-bubble count observed before the send
 */
async function waitForTurnStart(client, previousUserBubbles, timeoutMs = 60_000) {
  const startedAt = Date.now()
  await waitFor('turn start', async () => {
    const state = await client.evaluate(`(() => ({
      userBubbles: document.querySelectorAll('.chat-log .bubble.user').length,
      turnActive: document.querySelector('.composer button.send.stop') !== null,
    }))()`)
    const bubbleSeen = typeof state?.userBubbles === 'number' && state.userBubbles > previousUserBubbles
    const ok = state?.turnActive === true || (bubbleSeen && Date.now() - startedAt >= 5_000)
    return { ok, value: state }
  }, timeoutMs, 150)
}

async function userBubbleCount(client) {
  return client.evaluate(`document.querySelectorAll('.chat-log .bubble.user').length`)
}

/**
 * Send a prompt and wait for its turn to settle; a provider failure that made
 * the turn unusable is BLOCKED, a slow/product-failed turn is a FAIL.
 */
async function sendAndSettle(client, text, { timeoutMs = options.timeout, label } = {}) {
  await waitForComposerIdle(client, Math.min(timeoutMs, 120_000))
  const before = await userBubbleCount(client)
  log(`send ${label ?? ''}: ${clip(text, 160)}`)
  await sendText(client, text)
  await waitForTurnStart(client, before, Math.min(timeoutMs, 60_000))
  try {
    await waitForComposerIdle(client, timeoutMs)
  } catch (cause) {
    const failure = modelFailureText()
    if (failure !== undefined) {
      throw new BlockedError(`the real model could not run the turn: ${failure}`, { prompt: clip(text, 200) })
    }
    throw cause
  }
  return { sentAt: Date.now() }
}

/** Wait for a *new* main-flow run card (previous same-label cards must not satisfy the wait). */
async function waitForNewMainCard(client, label, previousCount, timeoutMs) {
  return waitFor(`new card ${label}`, async () => {
    const state = await cardsState(client)
    const target = state.main.filter((card) => card.label === label)
    const rail = state.rail.filter((card) => card.label === label)
    return { ok: target.length > previousCount && rail.length > 0, value: { main: target.length, rail: rail.length, previousCount } }
  }, timeoutMs, 250)
}

async function mainCardCount(client, label) {
  const state = await cardsState(client)
  return state.main.filter((card) => card.label === label).length
}

async function screenshot(client, name) {
  const captured = await client.call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  if (typeof captured?.data !== 'string' || captured.data === '') throw new Error(`screenshot ${name} was empty`)
  const bytes = Buffer.from(captured.data, 'base64')
  const path = join(options.outDir, name)
  writeFileSync(path, bytes)
  screenshots.push({ name, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
  log(`screenshot ${name} (${String(bytes.byteLength)} bytes)`)
}

async function ensureRightPane(client) {
  const present = await client.evaluate(`document.querySelector('.right-pane') !== null`)
  if (!present) {
    const expanded = await client.evaluate(`(() => {
      const toggle = document.querySelector('.right-toggle')
      if (!toggle) return false
      toggle.click()
      return true
    })()`)
    if (!expanded) throw new Error('the right pane is not mounted and the expand toggle is missing')
  }
  await waitFor('right pane', async () => {
    const ok = await client.evaluate(`document.querySelector('.right-pane') !== null`)
    return { ok, value: ok }
  }, 15_000, 200)
}

async function ensureProgressTab(client) {
  await ensureRightPane(client)
  const switched = await client.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.right-tabs button[role="tab"]')]
    const tab = tabs.find((candidate) => (candidate.textContent ?? '').trim() === '进度')
    if (!tab) return { ok: false, reason: 'progress tab missing' }
    if (tab.getAttribute('aria-selected') !== 'true') tab.click()
    return { ok: true }
  })()`)
  if (switched?.ok !== true) throw new Error(`progress tab unavailable: ${JSON.stringify(switched)}`)
  await waitFor('progress panel', async () => {
    const state = await client.evaluate(`document.querySelector('.right-pane .progress-panel') !== null`)
    return { ok: state === true, value: state }
  }, 15_000, 200)
}

/** Select the 进度 tab when another right tab is active; cheap and idempotent. */
async function selectProgressTab(client) {
  return client.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.right-tabs button[role="tab"]')]
    const tab = tabs.find((candidate) => (candidate.textContent ?? '').trim() === '进度')
    if (!tab) return { ok: false, reason: 'progress tab missing' }
    if (tab.getAttribute('aria-selected') !== 'true') tab.click()
    return { ok: true, switched: true }
  })()`)
}

/**
 * The app switches the right tab to 变更 whenever the active session records an
 * edit, so the rail must be re-selected before it is read; otherwise the panel
 * reads as unmounted and the rail looks empty.
 */
async function ensureRailTab(client) {
  const mounted = await client.evaluate(`document.querySelector('.right-pane .progress-panel') !== null`)
  if (mounted === true) return
  if ((await client.evaluate(`document.querySelector('.right-pane') !== null`)) !== true) await ensureRightPane(client)
  await selectProgressTab(client)
  await delay(200)
}

async function progressState(client) {
  await ensureRailTab(client)
  return client.evaluate(PROGRESS_STATE)
}

async function cardsState(client) {
  await ensureRailTab(client)
  return client.evaluate(CARDS_STATE)
}

async function newTaskTab(client) {
  const clicked = await client.evaluate(`(() => {
    const button = document.querySelector('button[title="新建任务"]')
    if (!button) return false
    button.click()
    return true
  })()`)
  if (!clicked) throw new Error('the new-task button is missing')
  await waitForComposerIdle(client, 60_000)
  await ensureProgressTab(client)
}

const RAIL_CARD_STATE = `(() => {
  const cards = [...document.querySelectorAll('.right-pane .progress-subagent-card')]
  return cards.map((card) => ({
    runId: card.getAttribute('data-run-id') ?? null,
    label: (card.querySelector('.subagent-run-label')?.textContent ?? '').trim(),
    phase: card.getAttribute('data-phase'),
    stale: card.getAttribute('data-stale') === 'true',
    text: (card.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    terminate: [...card.querySelectorAll('.subagent-run-terminate')]
      .some((candidate) => (candidate.textContent ?? '').trim() === '终止' && candidate.disabled === false),
  }))
})()`

/** Rail cards for one label, newest last; the active one is the cancel target. */
async function railCardsFor(client, label) {
  await ensureRailTab(client)
  const cards = await client.evaluate(RAIL_CARD_STATE)
  return Array.isArray(cards) ? cards.filter((card) => card.label === label) : []
}

/**
 * Click 「终止」 on the newest *active* rail card for `label`, then click
 * 「确认终止」 on that exact `data-run-id` card. Returns `{ label, runId }`
 * bound at click time (before any RPC inspection).
 */
async function clickRailTerminate(client, label, activationTimeoutMs = 60_000) {
  const requested = await waitFor(`active rail card ${label}`, async () => {
    const cards = await railCardsFor(client, label)
    const active = cards.filter((card) => !TERMINAL_PHASES.has(card.phase) && card.stale !== true)
    const candidate = active.find((card) => card.terminate === true)
    return { ok: candidate !== undefined, value: candidate ?? null }
  }, activationTimeoutMs, 120)
  log(`rail cancel request ${label} (phase ${String(requested?.phase)})`)
  const clicked = await client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.right-pane .progress-subagent-card')]
    const match = cards.filter((card) => (card.querySelector('.subagent-run-label')?.textContent ?? '').trim() === ${JSON.stringify(label)})
    const active = match.filter((card) => !['completed', 'failed', 'stopped'].includes(card.getAttribute('data-phase')) && card.getAttribute('data-stale') !== 'true')
    const card = active[active.length - 1]
    if (!card) return { ok: false, reason: 'active rail card missing' }
    const button = [...card.querySelectorAll('.subagent-run-terminate')]
      .find((candidate) => (candidate.textContent ?? '').trim() === '终止')
    if (!button) return { ok: false, reason: 'terminate button missing' }
    if (button.disabled) return { ok: false, reason: 'terminate disabled' }
    const runId = card.getAttribute('data-run-id') ?? ''
    button.click()
    return { ok: true, label: (card.querySelector('.subagent-run-label')?.textContent ?? '').trim(), runId }
  })()`)
  if (clicked?.ok !== true) throw new Error(`could not request cancel for ${label}: ${JSON.stringify(clicked)}`)
  const clickedRunId = typeof clicked.runId === 'string' ? clicked.runId : ''
  await waitFor(`confirm cancel ${label}`, async () => {
    const ready = await client.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.right-pane .progress-subagent-card')]
      const match = ${JSON.stringify(clickedRunId)} !== ''
        ? cards.filter((card) => card.getAttribute('data-run-id') === ${JSON.stringify(clickedRunId)})
        : cards.filter((card) => (card.querySelector('.subagent-run-label')?.textContent ?? '').trim() === ${JSON.stringify(label)})
      return match.some((card) => [...card.querySelectorAll('.subagent-run-terminate')]
        .some((candidate) => (candidate.textContent ?? '').trim().startsWith('确认终止')))
    })()`)
    return { ok: ready === true, value: ready }
  }, 10_000, 100)
  const confirmed = await client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.right-pane .progress-subagent-card')]
    const match = ${JSON.stringify(clickedRunId)} !== ''
      ? cards.filter((card) => card.getAttribute('data-run-id') === ${JSON.stringify(clickedRunId)})
      : cards.filter((card) => (card.querySelector('.subagent-run-label')?.textContent ?? '').trim() === ${JSON.stringify(label)})
    for (const card of match) {
      const button = [...card.querySelectorAll('.subagent-run-terminate')]
        .find((candidate) => (candidate.textContent ?? '').trim().startsWith('确认终止'))
      if (button !== undefined) {
        button.click()
        return { ok: true }
      }
    }
    return { ok: false, reason: 'confirm button missing' }
  })()`)
  if (confirmed?.ok !== true) throw new Error(`could not confirm cancel for ${label}: ${JSON.stringify(confirmed)}`)
  return { label: clicked.label ?? label, runId: clickedRunId }
}

/** The Host run ledger for one parent session, read from the renderer's own RPC. */
async function subagentRunsOf(client, parentSessionId) {
  if (typeof parentSessionId !== 'string' || parentSessionId === '') return { ok: false, runs: [] }
  const result = await client.evaluate(`fetch('/huaanwork/subagent/list?parentSessionId=' + encodeURIComponent(${JSON.stringify(parentSessionId)}))
    .then((response) => (response.ok ? response.json() : { ok: false, status: response.status }))
    .then((body) => ({ ok: Array.isArray(body?.runs), runs: Array.isArray(body?.runs) ? body.runs : [], status: 200 }))
    .catch((error) => ({ ok: false, runs: [], error: String(error) }))`)
  return { ...result, parentSessionId }
}

function runsForLabel(snapshot, label) {
  return (snapshot?.runs ?? []).filter((run) => run.label === label)
}

function isActiveRun(run) {
  return run !== undefined && !TERMINAL_PHASES.has(run.phase)
}

/** Wait for a new (not previously seen) run with `label` under the parent session. */
async function waitForNewRun(client, parentSessionId, label, knownRunIds, timeoutMs) {
  return waitFor(`new run ${label}`, async () => {
    const snapshot = await subagentRunsOf(client, parentSessionId)
    const runs = runsForLabel(snapshot, label).filter((run) => !knownRunIds.has(run.runId))
    return { ok: runs.length > 0, value: { runs, total: snapshot.runs.length } }
  }, timeoutMs, 200)
}

/** Poll one run's phase from the Host ledger. */
async function waitForRunPhase(client, parentSessionId, runId, phases, timeoutMs) {
  return waitFor(`run ${runId} ${[...phases].join('/')}`, async () => {
    const snapshot = await subagentRunsOf(client, parentSessionId)
    const run = (snapshot.runs ?? []).find((candidate) => candidate.runId === runId)
    return { ok: run !== undefined && phases.has(run.phase), value: run ?? null }
  }, timeoutMs, 250)
}

/** Poll for the parent session the marker's user message opened. */
async function waitForParentSessionId(client, marker, timeoutMs) {
  return waitFor(`parent session for ${marker}`, async () => {
    const sessions = loadSessions(isolated.homeDir)
    const parent = findParentSession(sessions, marker)
    return { ok: parent !== undefined, value: parent?.header.id ?? null }
  }, timeoutMs, 500)
}

/* Test-fix needs a real failing test so the child keeps working long enough for
 * the terminate control to be exercised; a one-liner exits before the click. */
const FIXTURE_LIB = `function multiply(a, b) {
  return a + b
}

function greet(name) {
  return 'Hi ' + name
}

module.exports = { multiply, greet }
`
const FIXTURE_CHECK = `const assert = require('node:assert')
// Keep the failing run alive long enough for the walkthrough to exercise the
// rail's targeted terminate control before the skill finishes.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000)
const { multiply, greet } = require('./lib.js')

assert.equal(multiply(3, 4), 12)
assert.equal(multiply(-2, 5), -10)
assert.equal(greet('Ada'), 'Hello Ada')
console.log('PASS')
`

function writeTestFixFixture(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'lib.js'), FIXTURE_LIB)
  writeFileSync(join(dir, 'check.js'), FIXTURE_CHECK)
}

/** Copy the failing-test fixture into every workspace-session root of the isolated profile. */
function seedTestFixFixture() {
  const baseDir = join(isolated.profileDir, 'workspace-sessions')
  const roots = listDirNames(baseDir)
  for (const root of roots) writeTestFixFixture(join(baseDir, root, 'fixme'))
  return { roots: roots.length }
}

/**
 * Fresh task tabs mint an empty workspace-session root, so scenes that name
 * files must place the acceptance samples there first.
 */
function seedSceneFiles() {
  const baseDir = join(isolated.profileDir, 'workspace-sessions')
  const roots = listDirNames(baseDir)
  for (const root of roots) {
    const dir = join(baseDir, root)
    mkdirSync(join(dir, 'samples'), { recursive: true })
    cpSync(isolated.sampleDir, join(dir, 'samples'), { recursive: true })
    writeTestFixFixture(join(dir, 'fixme'))
    writeFileSync(join(dir, 'README.md'), '# progress sidebar acceptance workspace\n')
  }
  return { roots: roots.length }
}

async function waitForMainCardPhase(client, label, phases, timeoutMs, { allowStale = false } = {}) {
  return waitFor(`main card ${label} ${[...phases].join('/')}`, async () => {
    const state = await cardsState(client)
    const cards = state.main.filter((card) => card.label === label)
    const card = cards[cards.length - 1]
    const staleOk = allowStale || card?.stale !== true
    return { ok: card !== undefined && phases.has(card.phase) && staleOk, value: card ?? null }
  }, timeoutMs, 250)
}

async function expandActivity(client) {
  await ensureRailTab(client)
  await client.evaluate(EXPAND_ACTIVITY)
  await delay(250)
  return client.evaluate(ACTIVITY_ENTRY_DETAILS)
}

/* ------------------------------------------------------------------------- *
 * Session log reading
 * ------------------------------------------------------------------------- */

function walkFiles(dir, name, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(path, name, out)
    else if (entry.name === name) out.push(path)
  }
  return out
}

function decodeZstdFile(path) {
  const result = spawnSync('zstd', ['-dc', path], { maxBuffer: 256 * 1024 * 1024 })
  if (result.error !== undefined) throw new Error(`zstd failed for ${path}: ${result.error.message}`)
  const text = result.stdout?.toString('utf8') ?? ''
  if (text.length === 0 && result.status !== 0) {
    throw new Error(`zstd produced no output for ${path}: ${result.stderr?.toString('utf8') ?? ''}`)
  }
  return { text, warning: result.status === 0 ? undefined : `zstd exited ${String(result.status)} (truncated tail tolerated)` }
}

function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .flatMap((block) => (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .join('\n')
}

function loadSessions(homeDir) {
  const root = join(homeDir, 'sessions')
  const files = walkFiles(root, 'session.v4.jsonl.zstd').sort()
  const sessions = []
  for (const file of files) {
    let decoded
    try {
      decoded = decodeZstdFile(file)
    } catch {
      continue
    }
    for (const line of decoded.text.split('\n')) {
      if (line.trim() === '') continue
      let value
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      if (value?.type !== 'session') continue
      const lines = decoded.text.split('\n').filter((item) => item.trim() !== '')
      const events = []
      for (const raw of lines) {
        let event
        try {
          event = JSON.parse(raw)
        } catch {
          continue
        }
        if (event?.type === 'session') continue
        if (event !== null && typeof event === 'object') events.push(event)
      }
      sessions.push({ file, header: value, events, warning: decoded.warning })
      break
    }
  }
  return sessions
}

function isRealUserMessage(event) {
  return event?.type === 'user/message' && event.data?.source?.kind === 'user'
}

/** Whether a session received `marker` in any user-facing message, spliced inbox included. */
function sessionMentions(session, marker) {
  for (const event of session.events) {
    const messages = event?.type === 'user/message'
      ? [event.data]
      : event?.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted) ? event.data.inserted : []
    for (const message of messages) {
      if (messageText(message).includes(marker)) return true
    }
  }
  return false
}

/**
 * Distinct logical user turns that wrote a todo list. The live main flow renders one
 * todo card per user turn (updating in place across `subagent-settled` wakeups even
 * though DSH increments `event.data.turn` on each wakeup), so counting real user turns
 * matches the UI contract while still catching duplicated cards within a turn.
 */
export function todoCardTurns(session) {
  const userTurns = new Set()
  let userTurnIndex = 0
  for (const event of session?.events ?? []) {
    if (isRealUserMessage(event)) {
      userTurnIndex += 1
      continue
    }
    if (event?.type !== 'tool/call' || event.data?.name !== 'todo_write') continue
    userTurns.add(userTurnIndex)
  }
  return userTurns.size
}

function parentSessionsWithMarker(sessions, marker) {
  return sessions.filter((session) => !session.header.parentSession
    && session.events.some((event) => isRealUserMessage(event) && messageText(event.data).includes(marker)))
}

function findParentSession(sessions, marker) {
  const matches = parentSessionsWithMarker(sessions, marker)
  return matches.length === 1 ? matches[0] : matches[0]
}

/** The turn that a marker user message opened: its tool calls and header snapshots. */
export function turnFacts(session, marker) {
  const startIndex = session.events.findIndex((event) => isRealUserMessage(event) && messageText(event.data).includes(marker))
  if (startIndex < 0) return undefined
  const nextIndex = session.events.findIndex((event, index) => index > startIndex && isRealUserMessage(event))
  const end = nextIndex < 0 ? session.events.length : nextIndex
  const turnEvents = session.events.slice(startIndex, end)
  const toolCalls = []
  // DSH 在回合 step 1 里会先写入 `step/start` 再写入 `user/message`；
  // 向前回溯本回合紧邻的 `step/start`（遇到上一条真实用户消息即止），
  // 否则首轮非 todo 工具在 turnFacts 里会得到 `roundKey: null` 而与真实产品 `roundKey` 错配。
  let currentRoundKey = null
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const prior = session.events[index]
    if (prior?.type === 'step/start' && typeof prior.seq === 'number') {
      currentRoundKey = prior.seq
      break
    }
    if (isRealUserMessage(prior)) break
  }
  for (const event of turnEvents) {
    if (event?.type === 'step/start' && typeof event.seq === 'number') {
      currentRoundKey = event.seq
      continue
    }
    if (event?.type === 'tool/call' && typeof event.data?.name === 'string') {
      let argsObj = event.data.arguments
      if (typeof argsObj === 'string') {
        try { argsObj = JSON.parse(argsObj) } catch { argsObj = undefined }
      }
      toolCalls.push({
        name: event.data.name,
        callId: typeof event.data.callId === 'string' && event.data.callId !== '' ? event.data.callId : null,
        roundKey: currentRoundKey,
        seq: typeof event.seq === 'number' ? event.seq : null,
        turn: typeof event.data.turn === 'number' ? event.data.turn : null,
        step: typeof event.data.step === 'number' ? event.data.step : null,
        skillName: event.data.name === 'skill' && argsObj !== null && typeof argsObj === 'object' && typeof argsObj.name === 'string'
          ? argsObj.name
          : null,
      })
    }
  }
  const substantiveCalls = toolCalls.filter((call) => call.name !== 'todo_write')
  const latest = substantiveCalls.reduce((best, call) => {
    if (best === undefined) return call
    if (call.turn === null || call.step === null) return best
    if (best.turn === null || best.step === null) return call
    return call.turn > best.turn || (call.turn === best.turn && call.step > best.step) ? call : best
  }, undefined)
  const latestRoundCalls = latest === undefined
    ? []
    : substantiveCalls.filter((call) => call.turn === latest.turn && call.step === latest.step)
  const latestRoundToolNames = [...new Set(latestRoundCalls.map((call) => call.name))]
  const userMessage = session.events[startIndex]
  return {
    marker,
    clientMessageId: typeof userMessage.data?.id === 'string' ? userMessage.data.id : null,
    startSeq: typeof userMessage.seq === 'number' ? userMessage.seq : startIndex,
    endSeq: end >= session.events.length ? null : (typeof session.events[end].seq === 'number' ? session.events[end].seq : end),
    header: inspectSessionHeaderTools(session.events),
    toolNames: toolCalls.map((call) => call.name),
    skillCalls: toolCalls.filter((call) => call.name === 'skill').map((call) => call.skillName),
    substantiveCalls,
    latestRoundCalls,
    latestRoundToolNames,
    todoWriteCount: toolCalls.filter((call) => call.name === 'todo_write').length,
  }
}

/** Header tool names in force immediately before `seq`. */
function headerNamesBefore(header, seq) {
  let names = []
  for (const request of header.requests) {
    if (request.seq !== null && seq !== null && request.seq < seq) names = request.toolNames
  }
  return names
}

/** Header tool names logged inside [startSeq, endSeq). */
function headerNamesBetween(header, startSeq, endSeq) {
  const names = new Set()
  for (const request of header.requests) {
    if (request.seq === null) continue
    if (request.seq < startSeq) continue
    if (endSeq !== null && request.seq >= endSeq) continue
    for (const name of request.toolNames) names.add(name)
  }
  return [...names].sort()
}

function headerNamesAfter(header, seq) {
  let names
  for (const request of header.requests) {
    if (request.seq !== null && (seq === null || request.seq >= seq)) names = request.toolNames
  }
  return names ?? []
}

function settlementDeliveries(session) {
  const deliveries = []
  for (const event of session.events) {
    let messages = null
    if (event?.type === 'user/message') messages = [event.data]
    else if (event?.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) messages = event.data.inserted
    if (messages === null) continue
    for (const message of messages) {
      if (message?.source?.kind !== 'subagent-settled') continue
      deliveries.push({ at: event.time, laneId: message.source.senderSessionId, text: messageText(message) })
    }
  }
  return deliveries
}

function lastAssistantText(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const text = messageText(event.data?.message)
    if (text.trim() !== '') return { text, time: event.time }
  }
  return undefined
}

function turnErrorText(session) {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type !== 'turn/end') continue
    const reason = event.data?.reason
    if (reason?.kind === 'error') {
      const message = reason.error?.message ?? reason.error?.code ?? 'unknown error'
      return String(message)
    }
  }
  return undefined
}

function modelFailureText() {
  try {
    const sessions = loadSessions(isolated.homeDir)
    for (const session of sessions) {
      const text = turnErrorText(session)
      if (text !== undefined && MODEL_UNAVAILABLE_PATTERN.test(text)) return clip(text, 500)
    }
  } catch { /* logs may not exist yet */ }
  return undefined
}

/* ------------------------------------------------------------------------- *
 * Walkthrough scenes
 * ------------------------------------------------------------------------- */

function checkFact(id, fact) {
  const reasons = Array.isArray(fact.reasons) ? fact.reasons.filter((reason) => typeof reason === 'string' && reason !== '') : []
  const ok = fact.ok === true && reasons.length === 0
  const { _samples: ignored, ...publicFact } = fact
  progress.checks[id] = { ...publicFact, ok, reasons }
  log(`check ${id}: ${ok ? 'ok' : 'FAILED'}${reasons.length > 0 ? ` (${reasons.join('; ')})` : ''}`)
  return progress.checks[id]
}

function parseCount(countText) {
  const match = /已完成\s*(\d+)\s*\/\s*(\d+)/u.exec(typeof countText === 'string' ? countText : '')
  return match === null ? undefined : { completed: Number(match[1]), total: Number(match[2]) }
}

const COMPLEX_PROMPT = `${MARKER}-TODO 请用 todo_write 工具为下面的工作建立 4 个步骤的清单，并逐步执行：1) 列出当前工作区的文件名；2) 读取工作区的 README.md；3) 在工作区新建 acceptance-note.txt 并写入一行 done；4) 汇报完成情况。每完成一步都调用 todo_write 更新该步骤状态，全部完成后用一句话总结。`

/** Samples of the progress panel collected across the complex turn. */
let complexSamples = []

async function driveProgressTasks(client) {
  await ensureProgressTab(client)
  const before = await progressState(client)
  const beforeCards = await cardsState(client)
  const samples = []
  let highlightedSeen = false
  const collect = async () => {
    const state = await progressState(client)
    if (state?.mounted !== true) return
    samples.push(state)
    if (state.tasks.some((task) => task.status === 'in_progress')) highlightedSeen = true
  }
  await collect()
  const beforeBubbles = await userBubbleCount(client)
  await sendText(client, COMPLEX_PROMPT)
  await waitForTurnStart(client, beforeBubbles, Math.min(options.timeout, 60_000))
  const deadline = Date.now() + options.timeout
  let idle = false
  let sawActive = false
  while (Date.now() < deadline) {
    await collect()
    const composer = await composerState(client)
    if (composer?.turnActive === true) sawActive = true
    else if (sawActive) {
      idle = true
      break
    }
    await delay(300)
  }
  if (!idle) throw new Error(`the complex task turn did not settle within ${options.timeout}ms`)
  await waitForComposerIdle(client, 60_000)
  await collect()
  const final = samples[samples.length - 1]
  await screenshot(client, '01-complex-progress.png')

  const sessions = loadSessions(isolated.homeDir)
  const parent = findParentSession(sessions, `${MARKER}-TODO`)
  if (parent === undefined) throw new Error('the complex task turn is missing from the session logs')
  const turn = turnFacts(parent, `${MARKER}-TODO`)
  const taskCount = Math.max(0, ...samples.map((state) => state.tasks.length))
  const count = parseCount(final?.countText)
  const completedFromTasks = final?.tasks.filter((task) => task.status === 'completed').length ?? 0
  const countMatched = count !== undefined && count.total === final?.tasks.length && count.completed === completedFromTasks
  const mainTodoCardCount = (await cardsState(client)).todoCards
  const reasons = []
  if (taskCount < 3) reasons.push(`only ${String(taskCount)} progress tasks rendered`)
  if (!highlightedSeen) reasons.push('no in-progress highlight was observed during execution')
  if (!countMatched) reasons.push(`count ${JSON.stringify(final?.countText ?? null)} does not match the rendered tasks`)
  if (mainTodoCardCount !== 1) reasons.push(`${String(mainTodoCardCount)} todo cards in the main flow`)
  if (turn === undefined || turn.todoWriteCount < 1) reasons.push('the session log records no todo_write call for this turn')
  if (before.tasks.length !== 0) reasons.push('the panel already showed tasks before the complex request')
  if (beforeCards.todoCards !== 0) reasons.push('the main flow already carried a todo card before the request')
  complexSamples = samples
  return checkFact('progress-tasks', {
    ok: reasons.length === 0,
    promptSent: true,
    taskCount,
    countText: final?.countText ?? null,
    countMatched,
    highlightedSeen,
    mainTodoCardCount,
    sessionTodoWriteCount: turn?.todoWriteCount ?? 0,
    clientMessageId: turn?.clientMessageId ?? null,
    parentSessionId: parent.header.id,
    sampleCount: samples.length,
    reasons,
  })
}

async function driveNoFabricatedPercentage(client) {
  const samples = complexSamples
  const final = samples[samples.length - 1]
  const percentTexts = samples.flatMap((state) => state.percentTexts ?? [])
  const taskProgressBarCount = Math.max(0, ...samples.map((state) => state.taskProgressBarCount ?? 0))
  const countFormatAlwaysXY = samples.every((state) => state.countText === '' || parseCount(state.countText) !== undefined)
  // 规格 §8.1:有 X/Y 计数且 Y > 0 的样本必须恰好渲染一个总进度条;无计数(等待/空)
  // 或 Y === 0 的样本不得渲染任何进度条。
  const totalBarMismatch = samples.filter((state) => {
    const count = state.countText === '' ? undefined : parseCount(state.countText)
    const total = state.totalProgressBarCount ?? 0
    if (count === undefined) return total !== 0
    return count.total > 0 ? total !== 1 : total !== 0
  })
  const totalBarMatchesCount = totalBarMismatch.length === 0
  const totalBarReason = totalBarMatchesCount
    ? null
    : `${String(totalBarMismatch.length)} samples carried a total progress bar that disagrees with the header count`

  const sessions = loadSessions(isolated.homeDir)
  const parent = findParentSession(sessions, `${MARKER}-TODO`)
  const turn = parent === undefined ? undefined : turnFacts(parent, `${MARKER}-TODO`)
  const activityEntries = await expandActivity(client)
  const names = activityEntries.map((entry) => entry.name)
  await screenshot(client, '02-activity-expanded.png')
  // Unique tool names, sorted: repeated calls of one tool are a panel aggregation
  // detail, and a call rejected before execution leaves no panel on either side.
  // A name the current turn never ran (a previous round's panel leaking into the
  // rail) is the real violation.
  const substantiveCalls = turn?.substantiveCalls ?? []
  const sessionToolNames = [...new Set((turn?.toolNames ?? []).filter((name) => name !== 'todo_write'))].sort()
  const activityToolNames = [...new Set(names)].sort()
  const latestRoundToolNames = [...new Set((turn?.latestRoundToolNames ?? []).filter((name) => name !== 'todo_write'))].sort()
  const foreignActivityNames = activityToolNames.filter((name) => !sessionToolNames.includes(name))
  const activityMatchesSession = sessionToolNames.length > 0
    && activityToolNames.length > 0
    && foreignActivityNames.length === 0
  // §8.2 keeps the rail to the latest/in-progress round, so the rail need not
  // repeat every earlier-round tool; the latest round itself must be represented.
  const latestRoundCovered = latestRoundToolNames.length === 0
    || latestRoundToolNames.every((name) => activityToolNames.includes(name))
  const activityAnchorMatched = typeof turn?.clientMessageId === 'string'
    && turn.clientMessageId !== ''
    && final?.turnAnchor === turn.clientMessageId
  const matchCall = (call, entry) => (
    call.name === entry.name
    && typeof entry.callId === 'string'
    && entry.callId !== ''
    && call.callId === entry.callId
    && typeof entry.roundKey === 'number'
    && call.roundKey === entry.roundKey
  )
  const foreignActivityCalls = activityEntries.filter((entry) => !substantiveCalls.some((call) => matchCall(call, entry)))
  const latestRoundCalls = turn?.latestRoundCalls ?? []
  const latestRoundCallsCovered = latestRoundCalls.length === 0
    || latestRoundCalls.every((call) => activityEntries.some((entry) => matchCall(call, entry)))
  const activityCallsMatched = substantiveCalls.length > 0
    && activityEntries.length > 0
    && foreignActivityCalls.length === 0
    && latestRoundCallsCovered
  const reasons = []
  if (percentTexts.length > 0) reasons.push(`percentage labels rendered: ${percentTexts.slice(0, 3).join(', ')}`)
  if (taskProgressBarCount > 0) reasons.push(`${String(taskProgressBarCount)} per-step progress bars rendered`)
  if (!totalBarMatchesCount) reasons.push(String(totalBarReason))
  if (!countFormatAlwaysXY) reasons.push('the header count left the X/Y format')
  if (!activityMatchesSession) {
    reasons.push(`activity ${JSON.stringify(activityToolNames)} does not match the current-turn session log ${JSON.stringify(sessionToolNames)}`)
  }
  if (!latestRoundCovered) {
    reasons.push(`the latest round tools ${JSON.stringify(latestRoundToolNames)} are missing from the activity panel ${JSON.stringify(activityToolNames)}`)
  }
  if (!activityAnchorMatched) {
    reasons.push(`progress panel turn anchor ${JSON.stringify(final?.turnAnchor ?? null)} does not match turn clientMessageId ${JSON.stringify(turn?.clientMessageId ?? null)}`)
  }
  if (!activityCallsMatched) {
    reasons.push(`activity callId/roundKey records failed to match turn log (foreign=${JSON.stringify(foreignActivityCalls)}, latestCovered=${String(latestRoundCallsCovered)})`)
  }
  if (final?.tasks.some((task) => /\d+\s*%/u.test(task.content)) === true) {
    // Task content may legitimately carry a percentage; only status/count labels count as fabricated progress.
    log('note: a task content mentions a percentage (not treated as a fabricated progress label)')
  }
  return checkFact('no-fabricated-percentage', {
    ok: reasons.length === 0,
    taskPercentTexts: percentTexts.length,
    countPercentTexts: percentTexts.length,
    taskProgressBarCount,
    totalProgressBarCount: Math.max(0, ...samples.map((state) => state.totalProgressBarCount ?? 0)),
    totalBarMatchesCount,
    totalBarReason,
    countFormatAlwaysXY,
    activityAnchor: final?.turnAnchor ?? null,
    expectedTurnAnchor: turn?.clientMessageId ?? null,
    activityAnchorMatched,
    activityEntries,
    foreignActivityCalls,
    latestRoundCallsCovered,
    activityCallsMatched,
    activityToolNames,
    sessionToolNames,
    latestRoundToolNames,
    latestRoundCovered,
    foreignActivityNames,
    activityMatchesSession,
    samples: samples.length,
    reasons,
  })
}

const LEGACY_AT_LABEL = `@${LEGACY_AGENT_NAME}`
const LEGACY_AT_PROMPT = `${LEGACY_AT_LABEL} ${MARKER}-LEGACY 请作为只读审阅子代理按步骤使用 glob 与 read 工具检查工作区中的 README.md、samples/sample-review.js 与 samples/sample.txt，逐文件给出详细审阅意见。`
const EXPLICIT_AT_PROMPT = `@typo-check ${MARKER}-AT 检测这个文件夹里的 Word 文档：samples`

async function driveParentNoSelfSpawn(client, tasksFact) {
  const sessions = loadSessions(isolated.homeDir)
  const parent = findParentSession(sessions, `${MARKER}-TODO`)
  if (parent === undefined) throw new Error('the parent session for the ordinary-turn header inspection is missing')
  const ordinaryHeaders = inspectSessionHeaderTools(parent.events)
  const reasons = []
  const ordinaryTurnCount = ordinaryHeaders.requestCount
  const ordinaryTurnsWithoutSubagent = ordinaryTurnCount > 0 && ordinaryHeaders.subagentSnapshotCount === 0
  if (ordinaryTurnCount === 0) reasons.push('no request/header snapshot was logged for the ordinary turns')
  if (!ordinaryTurnsWithoutSubagent) reasons.push('an ordinary turn request header exposed subagent')

  await ensureProgressTab(client)

  // Q4-M1: cover both the legacy catalog @agent path (kind === 'legacy') and
  // the package @typo-check path sequentially under the same parent session.
  const catalogRefresh = await client.evaluate(`fetch('/huaanwork/agent/refresh', { method: 'POST' })
    .then((response) => (response.ok ? response.json() : { ok: false, status: response.status }))
    .catch((error) => ({ ok: false, error: String(error) }))`)
  const legacyCatalogLoaded = Array.isArray(catalogRefresh?.items)
    && catalogRefresh.items.some((item) => item.name === LEGACY_AGENT_NAME && item.enabled === true && !item.broken)
  if (!legacyCatalogLoaded) {
    reasons.push(`legacy catalog agent ${LEGACY_AGENT_NAME} did not load before @ dispatch: ${clip(JSON.stringify(catalogRefresh), 300)}`)
  }
  const beforeLegacyRuns = await subagentRunsOf(client, parent.header.id)
  const knownLegacyRunIds = new Set((beforeLegacyRuns.runs ?? []).map((run) => run.runId))
  const previousLegacyCards = await mainCardCount(client, LEGACY_AT_LABEL)
  let legacyAtCardSeen = false
  let legacyAtRunId = null
  let legacyAtKind = null
  let legacyTargetedCancelConverged = false
  if (legacyCatalogLoaded) {
    await sendText(client, LEGACY_AT_PROMPT)
    try {
      await waitForNewMainCard(client, LEGACY_AT_LABEL, previousLegacyCards, Math.min(options.timeout, 90_000))
      legacyAtCardSeen = true
    } catch { /* recorded below */ }
    try {
      const created = await waitForNewRun(client, parent.header.id, LEGACY_AT_LABEL, knownLegacyRunIds, Math.min(options.timeout, 45_000))
      const run = created.runs[created.runs.length - 1]
      legacyAtRunId = run?.runId ?? null
      legacyAtKind = run?.kind ?? null
    } catch (cause) {
      log(`legacy @ run lookup failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    await screenshot(client, '03a-legacy-at-card.png')
    if (legacyAtCardSeen) {
      try {
        await clickRailTerminate(client, LEGACY_AT_LABEL)
        if (legacyAtRunId !== null) {
          await waitForRunPhase(client, parent.header.id, legacyAtRunId, new Set(['stopped']), Math.min(options.timeout, 90_000))
        }
        await waitForMainCardPhase(client, LEGACY_AT_LABEL, new Set(['stopped']), Math.min(options.timeout, 90_000))
        legacyTargetedCancelConverged = true
      } catch (cause) {
        log(`legacy @ cancel did not converge: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
    await waitForComposerIdle(client, Math.min(options.timeout, 120_000))
    await screenshot(client, '03b-legacy-at-cancelled.png')
  }
  if (!legacyAtCardSeen) reasons.push(`the legacy ${LEGACY_AT_LABEL} dispatch produced no run card`)
  if (legacyAtKind !== 'legacy') reasons.push(`expected legacy run kind 'legacy', got ${JSON.stringify(legacyAtKind)}`)
  if (!legacyTargetedCancelConverged) reasons.push(`the targeted cancel of the legacy ${LEGACY_AT_LABEL} run did not converge to stopped`)

  const previousCards = await mainCardCount(client, '@typo-check')
  await sendText(client, EXPLICIT_AT_PROMPT)
  let explicitCardSeen = false
  try {
    await waitForNewMainCard(client, '@typo-check', previousCards, Math.min(options.timeout, 90_000))
    explicitCardSeen = true
  } catch { /* recorded below */ }
  await screenshot(client, '03-explicit-at-card.png')
  let targetedCancelConverged = false
  if (explicitCardSeen) {
    try {
      await waitForComposerIdle(client, Math.min(options.timeout, 90_000))
      await clickRailTerminate(client, '@typo-check')
      await waitForMainCardPhase(client, '@typo-check', new Set(['stopped']), Math.min(options.timeout, 90_000))
      targetedCancelConverged = true
    } catch (cause) {
      log(`explicit @ cancel did not converge: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  await waitForComposerIdle(client, Math.min(options.timeout, 120_000))
  await screenshot(client, '04-explicit-at-cancelled.png')
  if (!explicitCardSeen) reasons.push('the explicit @ dispatch produced no run card')
  if (!targetedCancelConverged) reasons.push('the targeted cancel of the explicit @ run did not converge to stopped')
  return checkFact('parent-no-self-spawn', {
    ok: reasons.length === 0,
    ordinaryTurnCount,
    ordinaryTurnsWithoutSubagent,
    ordinaryHeaderSnapshots: ordinaryHeaders.requests.map((request) => ({
      seq: request.seq,
      reason: request.reason,
      toolCount: request.toolNames.length,
      hasSubagent: request.hasSubagent,
    })),
    legacyAtLabel: LEGACY_AT_LABEL,
    legacyAtPrompt: LEGACY_AT_PROMPT,
    legacyCatalogLoaded,
    legacyAtRunId,
    legacyAtKind,
    legacyAtCardSeen,
    legacyTargetedCancelConverged,
    explicitAtLabel: '@typo-check',
    explicitAtPrompt: EXPLICIT_AT_PROMPT,
    explicitCardSeen,
    targetedCancelConverged,
    reasons,
  })
}

const DUAL_ENTRIES = [
  { entry: 'model-skill', skill: 'explore', modelSkill: true, prompt: `${MARKER}-SKILL 这是一次工具调用测试：你的第一个动作必须调用 skill 工具加载 explore 技能（参数 name 为 "explore"），不要直接回答。加载后必须立即调用 subagent 工具派发探索子代理，未调用 subagent 前不得结束本轮，最后只返回一行结论。`, cancel: false },
  { entry: 'explicit-slash', skill: 'explore', modelSkill: false, prompt: `/explore ${MARKER}-EXPLORE 必须通过 subagent 工具派发只读探索子代理，逐个阅读当前工作区的 README.md、samples/sample-review.js 与 fixme 目录下的所有文件，说明每个文件的作用；不允许在本会话直接读取或结束，最后给出一行结论。`, cancel: true },
  { entry: 'explicit-slash', skill: 'test-fix', modelSkill: false, prompt: `/test-fix ${MARKER}-TESTFIX 必须通过 subagent 工具派发修复子代理：先运行 node fixme/check.js 确认失败，然后修改 fixme/lib.js 让检查通过，重新运行直到输出 PASS，最后汇总改动；不允许在本会话直接执行修复。`, cancel: true },
]
const AFTER_PROMPT = `${MARKER}-AFTER 回复「完成」两个字即可。`

/**
 * The sole check reason the model-skill entry produces when the shipped profile
 * never declares the `skill` tool (F1). A BLOCKED verdict is only allowed when
 * this is the only recorded failure; any other reason is a real FAIL.
 */
const MODEL_SKILL_BLOCKED_REASON = 'model-skill explore was not constructible: the parent request/header tool schema never declares the skill tool'

/** The session-failure banner and the host error note the client renders after `sessionFailed`. */
const SESSION_FAILURE_STATE = `(() => {
  const banner = [...document.querySelectorAll('.banner.error')]
    .map((node) => (node.textContent ?? '').replace(/\\s+/g, ' ').trim())
    .find((text) => text.includes('会话已失败')) ?? null
  const errorTexts = [...document.querySelectorAll('.chat-log .note, .chat-log .banner')]
    .map((node) => (node.textContent ?? '').replace(/\\s+/g, ' ').trim())
    .filter((text) => /inactive context|cannot create effect/iu.test(text))
  return { banner, errorTexts: errorTexts.slice(-3) }
})()`

/**
 * The `skill` loader is only exposed to an agent whose tool catalog declares it.
 * When the parent surface has no `skill` tool the model-triggered entry cannot be
 * constructed at all, which is recorded (never silently skipped).
 */
function skillToolExposed(sessions) {
  const parent = findParentSession(sessions, `${MARKER}-TODO`)
  const names = parent === undefined ? [] : inspectSessionHeaderTools(parent.events).unionToolNames
  return { exposed: names.includes('skill'), toolNames: names, sessionId: parent?.header.id ?? null }
}

/**
 * Drive the dual-entry system-skill scene. The model-triggered `skill` entry is
 * driven only when the parent tool surface declares `skill`; both explicit slash
 * entries are always driven. A session failure (a Host exception surfaced as
 * "会话已失败") aborts the remaining entries with the observed error text.
 */
async function driveDualEntrySystemSkills(client, { freshTab }) {
  const entries = []
  const reasons = []
  const exposure = skillToolExposed(loadSessions(isolated.homeDir))
  const entryMarkerFor = (definition) => (
    definition.modelSkill
      ? `${MARKER}-SKILL`
      : definition.skill === 'explore'
        ? `${MARKER}-EXPLORE`
        : `${MARKER}-TESTFIX`
  )
  let dualParentSessionId = await waitForParentSessionId(client, `${MARKER}-DUAL-WARM`, 20_000).catch(() => null)
  const initialRuns = dualParentSessionId !== null
    ? await subagentRunsOf(client, dualParentSessionId).catch(() => ({ runs: [] }))
    : { runs: [] }
  const knownDualRunIds = new Set((initialRuns.runs ?? []).map((run) => run.runId))
  let sessionFailure = null
  let modelSkillBlocked = null
  if (!exposure.exposed) {
    // The model-triggered entry needs the `skill` loader in the request header.
    // It is absent, so the entry cannot be constructed at all; the run reports
    // BLOCKED with the observed schema instead of pretending the scene ran.
    modelSkillBlocked = {
      entry: 'model-skill',
      skill: 'explore',
      cause: 'the parent request/header tool schema never declares the skill tool',
      sessionId: exposure.sessionId,
      toolNames: exposure.toolNames,
    }
    entries.push({
      entry: 'model-skill',
      skill: 'explore',
      constructible: false,
      reason: modelSkillBlocked.cause,
      runSeenInMain: false,
      runSeenInRail: false,
      runId: null,
      runKind: null,
      clientMessageId: null,
      anchorMatched: false,
      headerHasSubagent: false,
      skillToolCalled: false,
      cancelled: false,
      marker: `${MARKER}-SKILL`,
    })
    reasons.push(MODEL_SKILL_BLOCKED_REASON)
  }
  const drivenIndices = DUAL_ENTRIES
    .map((definition, index) => ({ definition, index }))
    .filter(({ definition }) => !definition.modelSkill || exposure.exposed)
  for (let step = 0; step < drivenIndices.length; step += 1) {
    const { definition } = drivenIndices[step]
    const baseMarker = entryMarkerFor(definition)
    let usedMarker = baseMarker
    if (sessionFailure !== null) {
      entries.push({
        entry: definition.entry,
        skill: definition.skill,
        constructible: false,
        reason: `the session failed before this entry could be driven: ${sessionFailure}`,
        runSeenInMain: false,
        runSeenInRail: false,
        runId: null,
        runKind: null,
        clientMessageId: null,
        anchorMatched: false,
        headerHasSubagent: false,
        skillToolCalled: false,
        cancelled: false,
        marker: usedMarker,
      })
      reasons.push(`${definition.entry} ${definition.skill} was not driven because the session had already failed`)
      continue
    }
    if (definition.skill === 'test-fix') {
      // A one-liner exits before the rail can be clicked; the child needs a real
      // failing test to keep working while the targeted cancel is exercised.
      try {
        const seeded = seedTestFixFixture()
        log(`test-fix fixture written into ${String(seeded.roots)} workspace-session roots`)
      } catch (cause) {
        log(`test-fix fixture could not be written: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
    await ensureProgressTab(client)
    const previousCards = await mainCardCount(client, definition.skill)
    const previousRailCount = (await railCardsFor(client, definition.skill)).length
    try {
      // The parent turn can still be settling after a previous entry's cancel;
      // a slash send waits for the composer's send control to re-enable.
      await sendText(client, definition.prompt, Math.min(options.timeout, 120_000))
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      log(`${definition.entry} ${definition.skill} send failed: ${reason}`)
      entries.push({
        entry: definition.entry,
        skill: definition.skill,
        constructible: false,
        reason,
        runSeenInMain: false,
        runSeenInRail: false,
        runId: null,
        runKind: null,
        clientMessageId: null,
        anchorMatched: false,
        headerHasSubagent: false,
        skillToolCalled: false,
        cancelled: false,
        marker: usedMarker,
      })
      reasons.push(`${definition.entry} ${definition.skill} could not be sent: ${reason}`)
      continue
    }
    if (dualParentSessionId === null) {
      dualParentSessionId = await waitForParentSessionId(client, usedMarker, 20_000).catch(() => null)
    }
    let runSeenInMain = false
    let runSeenInRail = false
    let cancelled = false
    let entryRun = null
    try {
      await waitForNewMainCard(client, definition.skill, previousCards, Math.min(options.timeout, 120_000))
      runSeenInMain = true
    } catch (cause) {
      const failure = await client.evaluate(SESSION_FAILURE_STATE).catch(() => null)
      if (failure?.banner !== null && failure?.banner !== undefined) {
        sessionFailure = (failure.errorTexts ?? []).join(' / ') || failure.banner
      }
      log(`${definition.entry} ${definition.skill} card missing: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    // Model variance: a turn can finish without delegating even though subagent is
    // exposed. Retry once with an explicit tool-call instruction before failing,
    // preserving the entry's own activation path (`/${skill}` or `skill` tool) and
    // a unique per-entry marker so retries never run as an ordinary subagent-free
    // turn or collide in `turnFacts`.
    if (!runSeenInMain && sessionFailure === null) {
      await waitForComposerIdle(client, Math.min(options.timeout, 120_000)).catch(() => undefined)
      const retryMarker = `${MARKER}-RETRY-${definition.entry}-${definition.skill}`
      const retryPrompt = definition.modelSkill
        ? `${retryMarker} 你刚才没有完成工具调用测试。请先调用 skill 工具加载 "${definition.skill}" 技能，加载成功后立即调用 subagent 工具（description 填 "${definition.skill}"），不要直接回答或结束。`
        : `/${definition.skill} ${retryMarker} 你刚才没有调用 subagent 工具。本回合通过 /${definition.skill} 已挂载 subagent 工具，现在必须立即调用 subagent 工具（description 填 "${definition.skill}"），按技能要求执行，不要直接回答或结束。`
      try {
        await sendText(client, retryPrompt, Math.min(options.timeout, 120_000))
        usedMarker = retryMarker
        await waitForNewMainCard(client, definition.skill, previousCards, Math.min(options.timeout, 120_000))
        runSeenInMain = true
        log(`${definition.entry} ${definition.skill} run appeared after the explicit subagent retry`)
      } catch (cause) {
        log(`${definition.entry} ${definition.skill} retry still produced no run: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
    if (runSeenInMain) {
      if (dualParentSessionId === null) {
        dualParentSessionId = await waitForParentSessionId(client, usedMarker, 20_000).catch(() => null)
      }
      if (dualParentSessionId !== null) {
        try {
          const created = await waitForNewRun(client, dualParentSessionId, definition.skill, knownDualRunIds, 30_000)
          entryRun = created.runs[created.runs.length - 1] ?? null
          if (entryRun !== null) knownDualRunIds.add(entryRun.runId)
        } catch (cause) {
          log(`${definition.entry} ${definition.skill} Host run lookup failed: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
      try {
        await waitFor(`rail card ${definition.skill}`, async () => {
          const railCards = await railCardsFor(client, definition.skill)
          const matched = entryRun !== null
            ? railCards.some((card) => card.runId === entryRun.runId)
            : railCards.length > previousRailCount
          return { ok: matched, value: matched }
        }, 15_000, 200)
        runSeenInRail = true
      } catch {
        runSeenInRail = false
      }
    }
    await screenshot(client, `05-${definition.skill}-${definition.entry}.png`)
    // Cancel while the run is still active: a settled run has no terminate control.
    if (definition.cancel && runSeenInMain) {
      let cancelledChildId = entryRun?.childId ?? null
      try {
        await clickRailTerminate(client, definition.skill)
        if (dualParentSessionId !== null && entryRun !== null) {
          const stoppedRun = await waitForRunPhase(client, dualParentSessionId, entryRun.runId, new Set(['stopped']), Math.min(options.timeout, 90_000))
          cancelledChildId = stoppedRun?.childId ?? cancelledChildId
        }
        await waitForMainCardPhase(client, definition.skill, new Set(['stopped']), Math.min(options.timeout, 90_000))
        cancelled = true
      } catch (cause) {
        log(`system-skill cancel ${definition.skill} did not converge: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
      if (dualParentSessionId !== null && cancelled && typeof cancelledChildId === 'string' && cancelledChildId !== '') {
        await waitFor(`settlement delivery after cancel ${definition.skill}`, async () => {
          const currentSessions = loadSessions(isolated.homeDir)
          const currentParent = currentSessions.find((session) => session.header.id === dualParentSessionId)
          const delivered = currentParent !== undefined
            && settlementDeliveries(currentParent).some((delivery) => delivery.laneId === cancelledChildId)
          return { ok: delivered, value: delivered }
        }, 20_000, 250).catch(() => undefined)
      }
      const failure = await client.evaluate(SESSION_FAILURE_STATE).catch(() => null)
      if (failure?.banner !== null && failure?.banner !== undefined && sessionFailure === null) {
        sessionFailure = (failure.errorTexts ?? []).join(' / ') || failure.banner
      }
    }
    try {
      await delay(400)
      await waitForComposerIdle(client, Math.min(options.timeout, 120_000))
    } catch (cause) {
      log(`composer did not settle after ${definition.skill}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    entries.push({
      entry: definition.entry,
      skill: definition.skill,
      constructible: true,
      runSeenInMain,
      runSeenInRail,
      runId: entryRun?.runId ?? null,
      runKind: entryRun?.kind ?? null,
      clientMessageId: entryRun?.clientMessageId ?? null,
      anchorMatched: false,
      headerHasSubagent: false,
      skillToolCalled: false,
      cancelled,
      marker: usedMarker,
      initialMarker: baseMarker,
    })
    if (!runSeenInMain || !runSeenInRail) reasons.push(`${definition.entry} ${definition.skill} run card missing from the rail or main flow`)
    if (definition.cancel && !cancelled) reasons.push(`${definition.entry} ${definition.skill} targeted cancel did not converge`)

    // Separate consecutive system-skill turns with an ordinary turn so each entry
    // logs its own fresh open/reclaim request/header transition in session.v4.jsonl.zstd.
    if (step < drivenIndices.length - 1 && sessionFailure === null) {
      const midMarker = `${MARKER}-MID${String(step + 1)}`
      try {
        await sendAndSettle(client, `${midMarker} 只回复「好」两个字，不要调用任何工具。`, { label: `ordinary mid-${String(step + 1)}` })
      } catch (cause) {
        reasons.push(`the intermediate ordinary turn ${midMarker} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
  }
  if (sessionFailure !== null) reasons.push(`the Host raised an exception during the system-skill scene: ${sessionFailure}`)
  try {
    await sendAndSettle(client, AFTER_PROMPT, { label: 'ordinary follow-up' })
  } catch (cause) {
    reasons.push(`the ordinary follow-up turn failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }

  const hasAssistantAfter = (events, startSeq) => events.some((event) => (
    event?.type === 'assistant/message'
    && (startSeq === null || (typeof event.seq === 'number' && event.seq > startSeq))
    && messageText(event.data?.message).trim() !== ''
  ))

  // The follow-up request/header is persisted at turn start (or inherited from
  // a post-cancel settlement turn whose reclaimed schema matches); wait until
  // either a new request/header or the follow-up's assistant reply + turn/end lands.
  const headerDeadline = Date.now() + 60_000
  while (Date.now() < headerDeadline) {
    const probeSessions = loadSessions(isolated.homeDir)
    const probeParent = findParentSession(probeSessions, `${MARKER}-DUAL-WARM`)
      ?? findParentSession(probeSessions, `${MARKER}-EXPLORE`)
    if (probeParent !== undefined) {
      const probeTurn = turnFacts(probeParent, `${MARKER}-EXPLORE`)
      const probeFollow = turnFacts(probeParent, `${MARKER}-AFTER`)
      if (probeTurn !== undefined && probeFollow !== undefined) {
        const probeHeader = inspectSessionHeaderTools(probeParent.events)
        const probeStart = probeFollow.startSeq ?? (probeTurn.endSeq ?? 0)
        const settledAfter = hasAssistantAfter(probeParent.events, probeFollow.startSeq)
          && probeParent.events.some((event) => event?.type === 'turn/end' && typeof event.seq === 'number' && event.seq > probeFollow.startSeq)
        if (headerNamesBetween(probeHeader, probeStart, null).length > 0 || settledAfter) break
      }
    }
    await delay(500)
  }

  const sessions = loadSessions(isolated.homeDir)
  const parent = findParentSession(sessions, `${MARKER}-DUAL-WARM`)
    ?? findParentSession(sessions, `${MARKER}-EXPLORE`)
  let phaseComparison = { ok: false, reasons: ['the explicit /explore turn is missing from the session logs'], beforeHasSubagent: false, duringHasSubagent: false, afterHasSubagent: false, added: [], removed: [] }
  let phases = { before: [], during: [], after: [] }
  if (parent !== undefined) {
    const header = inspectSessionHeaderTools(parent.events)
    for (const item of entries) {
      if (!item.constructible) continue
      const entryTurn = turnFacts(parent, item.marker)
      const initialTurn = item.initialMarker && item.initialMarker !== item.marker
        ? turnFacts(parent, item.initialMarker)
        : undefined
      if (entryTurn !== undefined) {
        item.startSeq = entryTurn.startSeq
        item.endSeq = entryTurn.endSeq
        item.turnClientMessageId = entryTurn.clientMessageId
        item.anchorMatched = typeof item.clientMessageId === 'string'
          && item.clientMessageId !== ''
          && entryTurn.clientMessageId === item.clientMessageId
        const between = headerNamesBetween(header, entryTurn.startSeq, entryTurn.endSeq)
        item.headerTools = between
        item.headerHasSubagent = between.includes('subagent')
        const skillCalls = [...(entryTurn.skillCalls ?? []), ...(initialTurn?.skillCalls ?? [])]
        item.skillCalls = skillCalls
        item.skillToolCalled = skillCalls.includes(item.skill)
      }
      if (item.runKind !== 'system-skill') {
        reasons.push(`${item.entry} ${item.skill} run recorded kind=${JSON.stringify(item.runKind)} instead of 'system-skill'`)
      }
      if (!item.anchorMatched) {
        reasons.push(`${item.entry} ${item.skill} run clientMessageId ${JSON.stringify(item.clientMessageId)} did not match turn anchor`)
      }
      if (!item.headerHasSubagent) {
        reasons.push(`${item.entry} ${item.skill} turn lacked subagent in its request/header snapshot`)
      }
      if (item.entry === 'model-skill' && !item.skillToolCalled) {
        reasons.push(`${item.entry} ${item.skill} never called skill tool with name=${item.skill}`)
      }
    }

    const turn = turnFacts(parent, `${MARKER}-EXPLORE`)
    const followUp = turnFacts(parent, `${MARKER}-AFTER`)
    if (turn === undefined) {
      phaseComparison = { ok: false, reasons: ['the explicit /explore user message is missing'], beforeHasSubagent: false, duringHasSubagent: false, afterHasSubagent: false, added: [], removed: [] }
    } else {
      // The execution window starts at the first system-skill entry (model skill or
      // explicit slash); `before` is the ordinary turn before that window, not the
      // previous system-skill turn.
      const executionTurn = turnFacts(parent, `${MARKER}-SKILL`) ?? turn
      const executionStartSeq = executionTurn?.startSeq ?? turn.startSeq
      // The window must cover the trailing /test-fix turn as well: `subagent` stays
      // visible for the whole system-skill execution, not just the /explore leg.
      // Falls back to the /explore end when the /test-fix turn never settled.
      const testFixEntry = entries.find((item) => item.skill === 'test-fix')
      const testFixTurn = (testFixEntry?.marker ? turnFacts(parent, testFixEntry.marker) : undefined)
        ?? turnFacts(parent, `${MARKER}-TESTFIX`)
      const duringEndSeq = testFixTurn?.endSeq ?? turn.endSeq
      // `after` is the schema in force for the follow-up turn. If a preceding
      // post-cancel settlement turn already logged the reclaimed schema, DSH
      // omits a duplicate request/header on `followUp`; only fall back to the
      // latest logged request header >= executionStartSeq when `followUp` itself
      // produced a real LLM reply. If `subagent` leaked, that latest header still
      // carries `subagent` and `compareHeaderToolPhases` fails cleanly.
      const afterStart = followUp?.startSeq ?? (turn.endSeq ?? 0)
      const afterLogged = headerNamesBetween(header, afterStart, null)
      const followUpReplied = followUp !== undefined && hasAssistantAfter(parent.events, followUp.startSeq)
      const latestWindowHeader = header.requests
        .filter((request) => request.seq !== null && request.seq >= executionStartSeq)
        .pop()?.toolNames ?? []
      phases = {
        before: headerNamesBefore(header, executionStartSeq),
        during: headerNamesBetween(header, executionStartSeq, duringEndSeq),
        after: afterLogged.length > 0 ? afterLogged : (followUpReplied ? [...latestWindowHeader].sort() : []),
      }
      if (followUp === undefined) {
        phaseComparison = { ok: false, reasons: ['the ordinary follow-up turn after the execution window is missing from the session log'], beforeHasSubagent: false, duringHasSubagent: false, afterHasSubagent: false, added: [], removed: [] }
      } else if (phases.after.length === 0) {
        phaseComparison = { ok: false, reasons: ['no request/header snapshot after the follow-up turn proves the subagent tool was reclaimed'], beforeHasSubagent: false, duringHasSubagent: false, afterHasSubagent: false, added: [], removed: [] }
      } else {
        phaseComparison = compareHeaderToolPhases(phases)
      }
    }
  }
  if (!phaseComparison.ok) reasons.push(...phaseComparison.reasons.map((reason) => `request/header phases: ${reason}`))
  const cancelledCount = entries.filter((entry) => entry.cancelled).length
  if (cancelledCount < 1) reasons.push('no system-skill run was stopped through the targeted cancel control')
  return checkFact('dual-entry-system-skills', {
    ok: reasons.length === 0,
    freshTab,
    skillToolExposed: exposure,
    modelSkillBlocked,
    sessionFailure,
    entries,
    cancelledCount,
    phases,
    phaseComparison,
    reasons,
  })
}

/* The package advertises a two-lane double-blind check, so the scene asks for it
 * by name: the acceptance depends on depth-2 lanes existing, not on whether the
 * package model happens to choose the degraded single-session path (SKILL R8). */
const LANE_PROMPT = `@typo-check ${MARKER}-LANE 按包内双盲流程检测这个文件夹里的 Word 文档：samples，必须用 subagent 派发两个独立 lane（A/B）后再仲裁。`

function listDirNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

const LANE_SUMMARY_OBSERVER = `(() => {
  window.__laneSummaryAccept?.observer?.disconnect()
  window.__laneSummaryAccept = { samples: [], observer: null }
  const scan = () => {
    const root = document.querySelector('.right-pane .progress-panel')
    if (!root) return
    const cards = [...root.querySelectorAll('.progress-subagent-card')]
    for (const card of cards) {
      const label = (card.querySelector('.subagent-run-label')?.textContent ?? '').trim()
      if (label !== '@typo-check') continue
      const runId = card.getAttribute('data-run-id') ?? null
      const phase = card.getAttribute('data-phase')
      const statusText = (card.querySelector('.subagent-run-status-text')?.textContent ?? '').trim()
      const text = (card.textContent ?? '').replace(/\\s+/g, ' ').trim()
      const samples = window.__laneSummaryAccept.samples
      const last = samples[samples.length - 1]
      if (!last || last.runId !== runId || last.phase !== phase || last.statusText !== statusText || last.text !== text) {
        samples.push({ runId, phase, statusText, text, at: Date.now() })
      }
    }
  }
  scan()
  const target = document.querySelector('.right-pane') ?? document.body
  window.__laneSummaryAccept.observer = new MutationObserver(scan)
  window.__laneSummaryAccept.observer.observe(target, { subtree: true, childList: true, characterData: true, attributes: true })
  return true
})()`

/**
 * The lane scene runs in the stable session: its workspace already carries the
 * docx samples, and a brand-new task session cannot dispatch a package as its
 * very first message (the fresh workspace root is minted by that same send).
 */
async function drivePackageLaneDepthTwo(client, stableSessionId) {
  const reasons = []
  await ensureProgressTab(client)
  const before = await subagentRunsOf(client, stableSessionId)
  const known = new Set((before.runs ?? []).map((run) => run.runId))
  await client.evaluate(LANE_SUMMARY_OBSERVER)
  await sendText(client, LANE_PROMPT)

  let railLaneRowCount = 0
  let aggregatedToolSummary = ''
  let outerCardSeenInRail = false
  let outerCardSeenInMain = false
  let outerRunId = null
  const outerObservedTools = new Set()
  const collectToolText = (statusText) => {
    if (typeof statusText !== 'string' || !statusText.includes(' · ')) return
    const tail = statusText.slice(statusText.lastIndexOf(' · ') + 3).replace(/\s+\+\d+$/u, '').trim()
    for (const piece of tail.split('、')) {
      const toolName = piece.trim()
      if (toolName !== '') outerObservedTools.add(toolName)
    }
  }
  let terminal
  const deadline = Date.now() + Math.round(options.timeout * 1.5)
  while (Date.now() < deadline) {
    const state = await progressState(client)
    const railCards = state?.subagents ?? []
    const outer = railCards.filter((card) => card.label === '@typo-check')
    if (outer.length > 0) outerCardSeenInRail = true
    railLaneRowCount = Math.max(railLaneRowCount, railCards.filter((card) => card.label !== '@typo-check').length)
    for (const card of outer) {
      if (TERMINAL_PHASES.has(card.phase)) continue
      collectToolText(card.statusText ?? '')
    }
    const summary = outer.find((card) => /正在执行|个工具/u.test(card.text))
    if (summary !== undefined) aggregatedToolSummary = clip(summary.text, 300)
    const cards = await cardsState(client)
    const mainOuter = cards.main.filter((card) => card.label === '@typo-check')
    if (mainOuter.length > 0) outerCardSeenInMain = true
    const snapshot = await subagentRunsOf(client, stableSessionId)
    const run = runsForLabel(snapshot, '@typo-check').find((candidate) => !known.has(candidate.runId))
    if (run !== undefined) {
      outerRunId = run.runId
      if (!TERMINAL_PHASES.has(run.phase)) {
        for (const active of run.activeTools ?? []) {
          if (typeof active?.name === 'string' && active.name !== '') outerObservedTools.add(active.name)
        }
      }
      if (TERMINAL_PHASES.has(run.phase)) {
        terminal = { phase: run.phase, status: run.failure ?? '', text: mainOuter[mainOuter.length - 1]?.text ?? '' }
        break
      }
    }
    await delay(100)
  }
  const domSamples = await client.evaluate(`(() => {
    window.__laneSummaryAccept?.observer?.disconnect()
    const samples = window.__laneSummaryAccept?.samples ?? []
    delete window.__laneSummaryAccept
    return samples
  })()`).catch(() => [])
  const scopedSamples = Array.isArray(domSamples)
    ? domSamples.filter((sample) => (outerRunId === null || sample.runId === null || sample.runId === outerRunId))
    : []
  for (const sample of scopedSamples) {
    if (TERMINAL_PHASES.has(sample.phase)) continue
    collectToolText(sample.statusText ?? '')
    if (aggregatedToolSummary === '' && /正在执行|个工具/u.test(sample.text ?? '')) {
      aggregatedToolSummary = clip(sample.text, 300)
    }
  }
  if (terminal === undefined) throw new Error(`the package lane run did not reach a terminal phase within ${Math.round(options.timeout * 1.5)}ms`)
  await screenshot(client, '06-package-lane-terminal.png')

  const sessions = loadSessions(isolated.homeDir)
  const parent = findParentSession(sessions, `${MARKER}-LANE`)
  let chain = {
    rootId: parent?.header.id ?? null,
    rootFound: false,
    childCount: 0,
    childId: null,
    childDepth: null,
    laneIds: [],
    laneDepths: [],
    identityOk: false,
  }
  const laneResults = []
  let outerChildToolNames = []
  let laneOnlyToolNames = []
  if (parent === undefined) {
    reasons.push('the package lane parent session is missing from the session logs')
  } else {
    // The stable session also carries the earlier explicit `@` child; pin the
    // chain on the package child that received this scene's marker.
    const child = sessions.find((session) => session.header.parentSession === parent.header.id
      && session.header.origin === 'subagent'
      && session.header.delegationDepth === 1
      && sessionMentions(session, `${MARKER}-LANE`))
    const scoped = child === undefined
      ? [sessionHeaderFacts(parent)]
      : [
          sessionHeaderFacts(parent),
          sessionHeaderFacts(child),
          ...sessions
            .filter((session) => session.header.parentSession === child.header.id)
            .map(sessionHeaderFacts),
        ]
    chain = inspectDelegationChain(scoped, parent.header.id)
    const childSession = child
    outerChildToolNames = childSession === undefined
      ? []
      : [...new Set(childSession.events
          .filter((event) => event?.type === 'tool/call' && typeof event.data?.name === 'string')
          .map((event) => event.data.name))]
    const laneToolNameSet = new Set()
    const deliveries = childSession === undefined ? [] : settlementDeliveries(childSession)
    for (const laneId of chain.laneIds) {
      const lane = sessions.find((session) => session.header.id === laneId)
      for (const event of lane?.events ?? []) {
        if (event?.type === 'tool/call' && typeof event.data?.name === 'string') {
          laneToolNameSet.add(event.data.name)
        }
      }
      const final = lane === undefined ? undefined : lastAssistantText(lane.events)
      const delivery = deliveries.find((item) => item.laneId === laneId)
      const errorTurn = lane === undefined ? false : lane.events.some((event) => event?.type === 'turn/end' && event.data?.reason?.kind === 'error')
      laneResults.push({
        id: laneId,
        finalTextLength: final?.text.length ?? 0,
        settlementDelivered: delivery !== undefined && !/left no closing message/iu.test(delivery.text ?? ''),
        isError: errorTurn || final === undefined || final.text.trim() === '',
      })
    }
    laneOnlyToolNames = [...laneToolNameSet].filter((name) => !outerChildToolNames.includes(name))
    if (!chain.identityOk) reasons.push('the parent -> package child -> lane identity chain did not resolve from the session headers')
    if (chain.laneIds.length !== 2) reasons.push(`found ${String(chain.laneIds.length)} depth-2 lanes (expected exactly 2)`)
    if (chain.laneDepths.some((depth) => depth !== 2)) reasons.push('a lane session is not at delegation depth 2')
    if (laneResults.some((result) => result.isError)) reasons.push('a lane ended with an error result')
    if (laneResults.some((result) => result.finalTextLength === 0)) reasons.push('a lane produced no closing text')
    if (laneResults.some((result) => result.settlementDelivered !== true)) reasons.push('a lane result was never delivered to the package child')
  }
  const outerObservedToolNames = [...outerObservedTools].sort()
  const foreignOuterTools = outerObservedToolNames.filter((name) => !outerChildToolNames.includes(name))
  const laneOnlyLeakedTools = outerObservedToolNames.filter((name) => laneOnlyToolNames.includes(name))
  const outerSummaryFromOuterChildOnly = outerChildToolNames.length > 0
    && outerObservedToolNames.length > 0
    && foreignOuterTools.length === 0
    && laneOnlyLeakedTools.length === 0
  if (!outerCardSeenInMain || !outerCardSeenInRail) reasons.push('the outer package run card is missing from the rail or the main flow')
  if (railLaneRowCount !== 0) reasons.push(`${String(railLaneRowCount)} independent lane rows appeared in the rail`)
  if (aggregatedToolSummary === '') reasons.push('the rail never showed an aggregated tool summary for the outer package run')
  if (!outerSummaryFromOuterChildOnly) {
    reasons.push(`outer package summary did not stay scoped to depth-1 child tools (observed=${JSON.stringify(outerObservedToolNames)}, outerChild=${JSON.stringify(outerChildToolNames)}, foreign=${JSON.stringify(foreignOuterTools)}, laneOnlyLeaked=${JSON.stringify(laneOnlyLeakedTools)})`)
  }
  if (terminal.phase !== 'completed') reasons.push(`the outer package run ended ${String(terminal.phase)}`)
  if (terminal.status !== '') reasons.push(`the outer package run reported ${clip(terminal.status, 200)}`)
  await waitForComposerIdle(client, Math.min(options.timeout, 120_000)).catch(() => undefined)
  return checkFact('package-lane-depth-two', {
    ok: reasons.length === 0,
    outerLabel: '@typo-check',
    outerRunId,
    outerCardSeenInRail,
    outerCardSeenInMain,
    railLaneRowCount,
    aggregatedToolSummary,
    outerObservedToolNames,
    outerChildToolNames: [...outerChildToolNames].sort(),
    laneOnlyToolNames: [...laneOnlyToolNames].sort(),
    foreignOuterTools,
    laneOnlyLeakedTools,
    outerSummaryFromOuterChildOnly,
    terminalPhase: terminal.phase,
    terminalStatus: terminal.status,
    terminalText: clip(terminal.text, 400),
    chain,
    laneResults,
    reasons,
  })
}

/*
 * The scene needs two *live* managed runs in one parent session at the same instant,
 * which the product only allows inside a single parent turn:
 *
 * - a package `@slug` turn owns the session's single live-package slot (`pendingTurns`
 *   in huaanwork-host/agent-package/host.ts), so a second `@slug` send while the first
 *   package run is alive is rejected before activation and that run fails at 00:00 with
 *   「当前会话已有运行中的智能体包回合」;
 * - the turn scheduler admits one user turn per write root (`turn-scheduler.ts`
 *   `rootWriters`), and the root writer is held until the run's idle cleanup, so a
 *   second send is queued — a second turn cannot overlap the first turn's run.
 *
 * Two sibling runs therefore come from one `/explore` turn that dispatches two
 * `subagent` calls. Both are managed `system-skill` runs (`kind: 'system-skill'`,
 * `label: 'explore'`), so the rail shows one row per run and only one runId may be
 * cancelled by the two-step confirm.
 */
const SIBLING_RUN_PROMPT = `/explore ${MARKER}-SIBLING 并行发起两个独立的 subagent 工具调用（必须两次调用，不要合并成一个子代理）：子代理 A 只读分析 README.md 与 samples/sample-review.js；子代理 B 只读分析 samples/sample.txt 与 acceptance-note.txt。每个子代理都要逐文件说明用途、引用关系、可疑点（至少三点，带行号依据），最后各自给出一行结论。`
/** Second attempt: the model collapsed the work into one child instead of two siblings. */
const SIBLING_RUN_RETRY_PROMPT = `/explore ${MARKER}-SIBLING3 这次必须派出两个子代理：先调用一次 subagent 分析 README.md，再调用一次 subagent 分析 samples/sample-review.js。两次调用都要发生，分别给出用途、引用关系与可疑点（带行号依据），最后各自给出一行结论。`
const SIBLING_RUN_LABEL = 'explore'

/** Active (non-terminal, non-stale) rail cards for one label; the newest is last. */
async function railActiveCards(client, label) {
  const cards = await railCardsFor(client, label)
  return cards.filter((card) => !TERMINAL_PHASES.has(card.phase) && card.stale !== true)
}

/** Wait until `count` active rail rows for `label` expose an enabled terminate control. */
async function waitForRailRows(client, label, count, timeoutMs = 60_000) {
  return waitFor(`${String(count)} active rail rows ${label}`, async () => {
    const active = await railActiveCards(client, label)
    const cancellable = active.filter((card) => card.terminate === true)
    return {
      ok: active.length >= count && cancellable.length >= count,
      value: { activeRows: active.length, cancellableRows: cancellable.length, cards: active },
    }
  }, timeoutMs, 120)
}

/** Wait for at least `count` runs of `label` that were not in `knownRunIds`. */
async function waitForFreshRuns(client, parentSessionId, label, knownRunIds, count, timeoutMs) {
  return waitFor(`${String(count)} fresh ${label} runs`, async () => {
    const snapshot = await subagentRunsOf(client, parentSessionId)
    const runs = (snapshot.runs ?? []).filter((run) => run.label === label && !knownRunIds.has(run.runId))
    return { ok: runs.length >= count, value: { runs, total: snapshot.runs.length } }
  }, timeoutMs, 200)
}

/** The root writer is held while a managed run is alive; a send then only queues. */
async function waitForNoActiveRuns(client, parentSessionId, timeoutMs = 240_000) {
  return waitFor('no active runs', async () => {
    const snapshot = await subagentRunsOf(client, parentSessionId)
    const active = (snapshot.runs ?? []).filter((run) => isActiveRun(run))
    return { ok: active.length === 0, value: active.map((run) => `${run.label}:${run.phase}`) }
  }, timeoutMs, 250)
}

async function resolveRpcPostData(client) {
  const resolved = []
  for (const request of rpcRequests) {
    if (typeof request.postData === 'string') {
      resolved.push(request)
      continue
    }
    let postData
    try {
      const result = await client.call('Network.getRequestPostData', { requestId: request.requestId })
      postData = typeof result?.postData === 'string' ? result.postData : ''
    } catch {
      postData = ''
    }
    resolved.push({ ...request, postData })
  }
  return resolved
}

/**
 * `request_input` parks the parent turn: the composer is replaced by an answer strip,
 * so the next scene could not send anything. Dismiss the pending card through the
 * product's own 取消 control and wait for the normal composer to come back.
 */
async function dismissPendingInput(client) {
  const pending = await client.evaluate(`document.querySelectorAll('.chat-log .card.ask-card button.btn.reject').length`)
  if (typeof pending !== 'number' || pending === 0) return { dismissed: false, cards: 0 }
  const clicked = await client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.chat-log .card.ask-card')].reverse()
    for (const card of cards) {
      const button = card.querySelector('button.btn.reject')
      if (button === null) continue
      if (button.disabled) return { ok: false, reason: 'cancel disabled' }
      button.click()
      return { ok: true }
    }
    return { ok: false, reason: 'ask card cancel missing' }
  })()`)
  if (clicked?.ok !== true) return { dismissed: false, cards: pending, reason: clicked?.reason ?? 'cancel click failed' }
  await waitFor('pending input dismissed', async () => {
    const state = await client.evaluate(`(() => ({
      cards: document.querySelectorAll('.chat-log .card.ask-card button.btn.reject').length,
      answerStrip: document.querySelector('.composer .composer-context') !== null,
    }))()`)
    return { ok: state?.cards === 0, value: state }
  }, 30_000, 250).catch(() => undefined)
  return { dismissed: true, cards: pending }
}

async function driveSingleCancelIsolation(client, stableSessionId) {
  const reasons = []
  await ensureProgressTab(client)
  const beforeSnapshot = await subagentRunsOf(client, stableSessionId)
  const knownBefore = new Set((beforeSnapshot.runs ?? []).map((run) => run.runId))
  const known = new Set(knownBefore)
  const beforeCards = await cardsState(client)
  const siblingCardsBefore = beforeCards.main.filter((card) => card.label === SIBLING_RUN_LABEL).length

  // 1. Open the sibling pair from one parent turn. The send must not be queued behind
  //    another run (the root writer), and the skill lease must not be released by an
  //    idle event from the previous turn, so wait for a quiet session first.
  let pair = []
  for (let attempt = 1; attempt <= 2 && pair.length < 2; attempt += 1) {
    try {
      await waitForNoActiveRuns(client, stableSessionId)
      await waitForComposerIdle(client, Math.min(options.timeout, 120_000))
      await delay(1_500)
      await sendText(client, attempt === 1 ? SIBLING_RUN_PROMPT : SIBLING_RUN_RETRY_PROMPT)
      const created = await waitForFreshRuns(
        client, stableSessionId, SIBLING_RUN_LABEL, known, 2, Math.min(options.timeout, 90_000),
      )
      pair = created.runs.slice(0, 2)
    } catch (cause) {
      log(`sibling dispatch attempt ${String(attempt)} produced fewer than two runs: ${cause instanceof Error ? cause.message : String(cause)}`)
      const snapshot = await subagentRunsOf(client, stableSessionId)
      for (const run of snapshot.runs ?? []) known.add(run.runId)
    }
  }
  const pairRunIds = pair.map((run) => run.runId)
  if (pairRunIds.length < 2) {
    reasons.push(`the sibling turn produced ${String(pairRunIds.length)} managed runs (expected two concurrent siblings)`)
  }
  // The rail renders one row per run; both must be cancellable while both are live.
  const railWindow = pairRunIds.length === 2
    ? await waitForRailRows(client, SIBLING_RUN_LABEL, 2, Math.min(options.timeout, 60_000)).catch((cause) => {
      reasons.push(`the rail did not show two cancellable sibling rows: ${cause instanceof Error ? cause.message : String(cause)}`)
      return { activeRows: 0, cancellableRows: 0 }
    })
    : { activeRows: 0, cancellableRows: 0 }

  // 2. The concurrent window: both runs live, one rail row and one main card per run.
  const windowCards = await cardsState(client)
  const windowSnapshot = await subagentRunsOf(client, stableSessionId)
  const liveRuns = pairRunIds.map((runId) => (windowSnapshot.runs ?? []).find((run) => run.runId === runId))
  const activeAtWindow = liveRuns.filter((run) => isActiveRun(run)).length
  const windowRuns = (windowSnapshot.runs ?? []).filter((run) => run.label === SIBLING_RUN_LABEL && !knownBefore.has(run.runId))
  const activeLabelRuns = (windowSnapshot.runs ?? []).filter((run) => run.label === SIBLING_RUN_LABEL && isActiveRun(run)).length
  const railRowsAtWindow = windowCards.rail.filter((card) => card.label === SIBLING_RUN_LABEL).length
  const cardsAtWindow = windowCards.main.filter((card) => card.label === SIBLING_RUN_LABEL).length - siblingCardsBefore
  if (pairRunIds.length === 2 && activeAtWindow < 2) {
    reasons.push(`only ${String(activeAtWindow)} of the two sibling runs were live when the concurrent window opened`)
  }
  if (railRowsAtWindow !== activeLabelRuns) {
    reasons.push(`the rail rendered ${String(railRowsAtWindow)} sibling rows for ${String(activeLabelRuns)} live runs`)
  }
  const windowPairCardUnique = pairRunIds.length === 2 && pairRunIds.every((runId) => (
    windowCards.main.filter((card) => card.runId === runId).length === 1
    && windowCards.rail.filter((card) => card.runId === runId).length === 1
  ))
  // Two runs, two cards: each run of the pair rendered exactly one main-flow card.
  const pairRenderedOnce = windowRuns.length === 2 && cardsAtWindow === 2 && windowPairCardUnique
  if (!pairRenderedOnce) {
    reasons.push(`the concurrent window rendered ${String(cardsAtWindow)} main cards for ${String(windowRuns.length)} sibling runs (unique=${String(windowPairCardUnique)})`)
  }
  await screenshot(client, '07-sibling-active.png')

  // 3. One 「终止 → 确认终止」 pair binds the clicked card's `data-run-id` at click
  //    time and cancels that exact run alone.
  const cancelStartIndex = rpcRequests.length
  let cancelConverged = false
  let targetRunId = ''
  let siblingRunId = ''
  let targetTerminal
  if (pairRunIds.length === 2 && activeAtWindow === 2) {
    try {
      const clicked = await clickRailTerminate(client, SIBLING_RUN_LABEL)
      targetRunId = clicked?.runId ?? ''
    } catch (cause) {
      reasons.push(`the rail terminate control could not be clicked: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  if (targetRunId === '') reasons.push('the two-step confirm clicked a card without a bound data-run-id')
  if (targetRunId !== '' && !pairRunIds.includes(targetRunId)) {
    reasons.push(`the cancel targeted ${targetRunId}, which this scene did not dispatch`)
  }
  siblingRunId = targetRunId !== '' ? (pairRunIds.find((runId) => runId !== targetRunId) ?? '') : ''

  if (targetRunId !== '') {
    try {
      targetTerminal = await waitForRunPhase(
        client, stableSessionId, targetRunId, new Set(['stopped']), Math.min(options.timeout, 90_000),
      )
      cancelConverged = true
    } catch (cause) {
      reasons.push(`the cancelled sibling run did not converge to stopped: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  } else {
    reasons.push('the targeted cancel did not converge to stopped')
  }

  // 4. The other sibling must survive the cancel and finish on its own.
  let siblingCompleted = false
  let siblingFinal
  if (siblingRunId !== '') {
    try {
      siblingFinal = await waitForRunPhase(
        client, stableSessionId, siblingRunId, new Set(['completed']), Math.min(options.timeout, 240_000),
      )
      siblingCompleted = true
    } catch (cause) {
      reasons.push(`the sibling ${SIBLING_RUN_LABEL} run did not complete: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  } else {
    reasons.push('no sibling runId was left after the targeted cancel')
  }
  const siblingStopCause = typeof siblingFinal?.stopCause === 'string' ? siblingFinal.stopCause : ''
  if (siblingStopCause === 'targeted-cancel') reasons.push('the targeted cancel leaked onto the sibling run')
  // A cancelled child may make the parent ask whether it may retry; the pending card
  // parks the session and would block the later scenes, so it is dismissed here.
  const dismissedInput = await dismissPendingInput(client)
  if (dismissedInput.dismissed) log(`dismissed ${String(dismissedInput.cards)} pending input card(s) left by the cancelled child`)
  await waitForComposerIdle(client, Math.min(options.timeout, 120_000)).catch(() => undefined)
  await screenshot(client, '08-sibling-completed.png')

  // The sibling result must still be delivered back to the parent (unaffected run).
  let siblingSettlementSeen = false
  const siblingChildId = typeof siblingFinal?.childId === 'string' && siblingFinal.childId !== ''
    ? siblingFinal.childId
    : undefined
  if (siblingChildId === undefined) {
    reasons.push('the sibling run never bound a child session')
  } else {
    try {
      await waitFor('sibling settlement delivery', async () => {
        const sessions = loadSessions(isolated.homeDir)
        const parent = findParentSession(sessions, `${MARKER}-SIBLING`)
        const delivered = parent !== undefined
          && settlementDeliveries(parent).some((delivery) => delivery.laneId === siblingChildId)
        return { ok: delivered, value: parent?.header.id ?? null }
      }, 90_000, 500)
      siblingSettlementSeen = true
    } catch (cause) {
      reasons.push(`the sibling result was never delivered back to the parent: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  // Only inspect the cancel RPC window *after* both target stopped and sibling
  // completed+settled so any delayed or leaked cancel RPCs remain inside the window.
  try {
    await waitFor('cancel rpc captured', async () => {
      const capturedRequests = await resolveRpcPostData(client).catch(() => rpcRequests)
      const hit = countSubagentCancelRequests(capturedRequests.slice(cancelStartIndex), targetRunId)
      return { ok: hit.cancelRequestCount >= 1, value: hit.cancelRequestCount }
    }, 20_000, 250)
  } catch { /* recorded below */ }
  const requests = await resolveRpcPostData(client)
  const cancelWindow = requests.slice(cancelStartIndex)
  const cancelFacts = countSubagentCancelRequests(cancelWindow, targetRunId)
  if (cancelFacts.cancelRequestCount !== 1) reasons.push(`the two-step confirm sent ${String(cancelFacts.cancelRequestCount)} subagent.cancel requests (expected exactly 1)`)
  if (cancelFacts.targetRunIdCount !== 1) reasons.push(`the target run received ${String(cancelFacts.targetRunIdCount)} cancel requests (expected exactly 1)`)
  if (cancelFacts.otherRunIdCount !== 0) reasons.push(`${String(cancelFacts.otherRunIdCount)} cancel requests escaped to another runId`)
  if (cancelFacts.runIds[0] !== targetRunId) reasons.push(`cancel RPC runId ${JSON.stringify(cancelFacts.runIds[0] ?? null)} does not match clicked targetRunId ${JSON.stringify(targetRunId)}`)

  // 5. One rendered card per Host run: every run this scene created has exactly one
  //    main-flow card (a re-dispatch by the parent model is its own run and its own
  //    card, so the counts must still match one-to-one). The rail drops a settled run
  //    of an older turn, so its rows were pinned inside the concurrent window.
  //    The todo card is shared with the earlier scenes, so it is checked per writing
  //    turn instead of against a constant: one card per turn that wrote a list.
  let expectedTodoCards
  try {
    await waitFor('todo cards per writing turn', async () => {
      const sessions = loadSessions(isolated.homeDir)
      const parent = findParentSession(sessions, `${MARKER}-TODO`)
      expectedTodoCards = parent === undefined ? undefined : todoCardTurns(parent)
      const state = await cardsState(client)
      return {
        ok: expectedTodoCards !== undefined && state.todoCards === expectedTodoCards,
        value: { cards: state.todoCards, writingTurns: expectedTodoCards },
      }
    }, 20_000, 500)
  } catch { /* recorded below */ }
  const afterSnapshot = await subagentRunsOf(client, stableSessionId)
  const after = await cardsState(client)
  const toolPanelBodies = Array.isArray(after.toolPanelBodies) ? after.toolPanelBodies : []
  const mainToolPanelsUnique = new Set(toolPanelBodies).size === toolPanelBodies.length
  if (!mainToolPanelsUnique) reasons.push('the main flow rendered duplicate tool panels for the same anchor')
  const renderedCards = after.main.filter((card) => card.label === SIBLING_RUN_LABEL)
  const newRuns = (afterSnapshot.runs ?? []).filter((run) => run.label === SIBLING_RUN_LABEL && !knownBefore.has(run.runId))
  const renderedDelta = renderedCards.length - siblingCardsBefore
  const railCardCounts = {
    target: targetRunId === '' ? 0 : windowCards.rail.filter((card) => card.runId === targetRunId).length,
    sibling: siblingRunId === '' ? 0 : windowCards.rail.filter((card) => card.runId === siblingRunId).length,
  }
  const mainCardCounts = {
    target: targetRunId === '' ? 0 : after.main.filter((card) => card.runId === targetRunId).length,
    sibling: siblingRunId === '' ? 0 : after.main.filter((card) => card.runId === siblingRunId).length,
  }
  const perRunCardUnique = targetRunId !== ''
    && siblingRunId !== ''
    && windowPairCardUnique
    && railCardCounts.target === 1
    && railCardCounts.sibling === 1
    && mainCardCounts.target === 1
    && mainCardCounts.sibling === 1
  if (!perRunCardUnique) {
    reasons.push(`per-runId card uniqueness failed (main=${JSON.stringify(mainCardCounts)}, rail=${JSON.stringify(railCardCounts)}, windowUnique=${String(windowPairCardUnique)})`)
  }
  const oneCardPerRun = pairRenderedOnce && renderedDelta === newRuns.length
  if (!oneCardPerRun) {
    reasons.push(`rendered cards do not match the Host run ledger: ${String(renderedDelta)} cards for ${String(newRuns.length)} runs`)
  }
  const todoCardsOk = expectedTodoCards !== undefined && after.todoCards === expectedTodoCards
  if (!todoCardsOk) {
    reasons.push(`the main flow rendered ${String(after.todoCards)} todo cards for ${String(expectedTodoCards ?? 'unknown')} writing turns`)
  }
  const duplicateFree = oneCardPerRun && perRunCardUnique && railRowsAtWindow === activeLabelRuns && todoCardsOk
  if (!duplicateFree) {
    reasons.push(`duplicated or missing cards: railRows=${String(railRowsAtWindow)} liveRuns=${String(activeLabelRuns)} todoCards=${String(after.todoCards)}`)
  }
  return checkFact('single-cancel-isolation', {
    ok: reasons.length === 0,
    targetLabel: SIBLING_RUN_LABEL,
    siblingLabel: SIBLING_RUN_LABEL,
    targetKind: typeof targetTerminal?.kind === 'string' ? targetTerminal.kind : null,
    targetRunId,
    siblingRunId,
    dispatchedRunIds: pairRunIds,
    concurrentWindow: {
      activeRuns: activeAtWindow,
      railRows: railRowsAtWindow,
      railActiveRows: railWindow.activeRows,
      railCancellableRows: railWindow.cancellableRows,
      mainCards: cardsAtWindow,
      ledgerRuns: windowRuns.length,
      windowPairCardUnique,
      phases: liveRuns.map((run) => run?.phase ?? null),
    },
    targetTerminal: targetTerminal === undefined
      ? null
      : { phase: targetTerminal.phase, stopCause: targetTerminal.stopCause ?? null },
    cancelRpc: {
      cancelRequestCount: cancelFacts.cancelRequestCount,
      targetRunIdCount: cancelFacts.targetRunIdCount,
      otherRunIdCount: cancelFacts.otherRunIdCount,
      runIds: cancelFacts.runIds,
    },
    cancelConverged,
    siblingCompleted,
    siblingTerminal: siblingFinal === undefined
      ? null
      : { phase: siblingFinal.phase, stopCause: siblingStopCause === '' ? null : siblingStopCause, childId: siblingChildId ?? null },
    siblingSettlementSeen,
    dismissedPendingInput: dismissedInput,
    mainCardCounts,
    railCardCounts,
    perRunCardUnique,
    absoluteMainCardCounts: { sibling: renderedCards.length, siblingBefore: siblingCardsBefore },
    runLedgerCounts: { sibling: newRuns.length },
    mainToolPanelCount: toolPanelBodies.length,
    mainToolPanelsUnique,
    todoCardCount: after.todoCards,
    todoWritingTurns: expectedTodoCards ?? null,
    duplicateFree,
    reasons,
  })
}

const CONNECTION_SAMPLER = `(() => {
  window.__progressAccept = { samples: [] }
  const sample = () => {
    const panel = document.querySelector('.right-pane .progress-panel')
    const connection = panel?.getAttribute('data-connection') ?? null
    const banner = (panel?.querySelector('.progress-connection')?.textContent ?? '').trim() || null
    const samples = window.__progressAccept.samples
    const last = samples[samples.length - 1]
    if (last === undefined || last.connection !== connection || last.banner !== banner) {
      samples.push({ connection, banner, at: Date.now() })
    }
  }
  sample()
  window.__progressAccept.observer = new MutationObserver(sample)
  window.__progressAccept.observer.observe(document.body, { subtree: true, attributes: true, childList: true })
  return window.__progressAccept.samples.length
})()`

const HISTORY_PROMPT = `${MARKER}-HIST 请用 todo_write 工具为下面的工作建立 4 个步骤的清单，并逐步执行：1) 列出当前工作区的文件名；2) 读取工作区的 README.md；3) 在工作区新建 history-note.txt 并写入一行 done；4) 汇报完成情况。每完成一步都调用 todo_write 更新该步骤状态，全部完成后用一句话总结。`

/** Click the recent-session entry whose title carries `sessionId` (list renders asynchronously). */
async function clickRecentSession(client, sessionId) {
  const deadline = Date.now() + 20_000
  let last = { ok: false, reason: 'recent session item missing', count: 0 }
  while (Date.now() < deadline) {
    last = await client.evaluate(`(() => {
      const items = [...document.querySelectorAll('.recent-item')]
      const item = items.find((candidate) => (candidate.getAttribute('title') ?? '').includes(${JSON.stringify(sessionId)}))
      if (!item) return { ok: false, reason: 'recent session item missing', count: items.length }
      item.click()
      return { ok: true, count: items.length }
    })()`)
    if (last?.ok === true) return last
    await delay(300)
  }
  return last
}

async function driveSwitchHistoryRestart(client) {
  const reasons = []
  // A dedicated session keeps the history scene independent of the turns the
  // earlier scenes added to the shared session: the reopened session's current
  // turn must be the one that owns the task list.
  await newTaskTab(client)
  // A fresh tab mints its workspace-session root on the first send; seed after
  // that send so the history turn can actually read the samples.
  await sendAndSettle(client, `${MARKER}-WARM 回复「好」两个字即可。`, { label: 'warm-up' }).catch((cause) => {
    log(`history warm-up did not settle: ${cause instanceof Error ? cause.message : String(cause)}`)
  })
  const seededHistory = seedSceneFiles()
  log(`history scene files written into ${String(seededHistory.roots)} workspace-session roots`)
  const beforeBubbles = await userBubbleCount(client)
  await sendText(client, HISTORY_PROMPT)
  await waitForTurnStart(client, beforeBubbles, Math.min(options.timeout, 60_000))
  await waitForComposerIdle(client, options.timeout)
  const historySessionId = await waitForParentSessionId(client, `${MARKER}-HIST`, Math.min(options.timeout, 60_000))
  await waitFor('history session task list', async () => {
    const state = await progressState(client)
    return { ok: (state?.tasks.length ?? 0) >= 3, value: state?.tasks.length ?? 0 }
  }, Math.min(options.timeout, 90_000), 300)
  const ownedTasks = (await progressState(client))?.tasks.length ?? 0

  await newTaskTab(client)
  const fresh = await progressState(client)
  const freshTabTaskCount = fresh?.tasks.length ?? -1
  const freshTodoCards = (await cardsState(client)).todoCards
  await screenshot(client, '09-fresh-tab-empty.png')
  if (freshTabTaskCount !== 0) reasons.push(`the fresh tab showed ${String(freshTabTaskCount)} tasks`)
  if (freshTodoCards !== 0) reasons.push(`the fresh tab showed ${String(freshTodoCards)} todo cards`)

  const switched = await clickRecentSession(client, historySessionId)
  if (switched?.ok !== true) {
    reasons.push(`could not switch back to the history session: ${JSON.stringify(switched)}`)
  } else {
    await waitFor('history session restored', async () => {
      const state = await cardsState(client)
      return { ok: state.todoCards >= 1, value: state.todoCards }
    }, Math.min(options.timeout, 90_000), 300)
  }
  const switchedBack = await progressState(client)
  const switchTaskCount = switchedBack?.tasks.length ?? 0
  await screenshot(client, '10-switched-back.png')
  if (switchTaskCount !== ownedTasks) reasons.push(`switching back showed ${String(switchTaskCount)} tasks (expected ${String(ownedTasks)})`)
  const previousTodoNotInFreshTab = freshTabTaskCount === 0 && freshTodoCards === 0 && switchTaskCount === ownedTasks

  await client.call('Page.reload', { ignoreCache: false })
  await waitFor('composer after reload', async () => {
    const probe = await client.evaluate(APP_PROBE)
    return { ok: probe?.hasComposer === true, value: probe }
  }, Math.min(options.timeout, 120_000), 500)
  const reopened = await clickRecentSession(client, historySessionId)
  if (reopened?.ok !== true) reasons.push(`could not reopen the session after reload: ${JSON.stringify(reopened)}`)
  await waitFor('history todo card restored', async () => {
    const state = await cardsState(client)
    return { ok: state.todoCards >= 1, value: state.todoCards }
  }, Math.min(options.timeout, 120_000), 300)
  // The app re-selects 变更 after an edit history loads; the rail must be pinned
  // to 进度 before its task list can be read.
  await ensureProgressTab(client)
  await waitFor('history progress restored', async () => {
    const state = await progressState(client)
    return { ok: (state?.tasks.length ?? 0) >= 3, value: state?.tasks.length ?? 0 }
  }, Math.min(options.timeout, 120_000), 300)
  const reloaded = await progressState(client)
  const reloadedCards = await cardsState(client)
  const historyReloadTaskCount = reloaded?.tasks.length ?? 0
  const historyTodoCardCount = reloadedCards.todoCards
  await screenshot(client, '11-history-reloaded.png')
  if (historyReloadTaskCount < 3) reasons.push(`the reloaded progress panel showed ${String(historyReloadTaskCount)} tasks`)
  if (historyTodoCardCount < 1) reasons.push('history reload rendered no todo cards')

  // The previous turn's todo must not masquerade as the next turn's list in the
  // same session: a tool-free ordinary turn starts with no tasks in the rail.
  try {
    await sendAndSettle(client, `${MARKER}-HIST-AFTER 只回复「好的」两个字，不要调用任何工具。`, { label: 'history follow-up' })
  } catch (cause) {
    reasons.push(`the same-session follow-up turn failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  await ensureProgressTab(client)
  const postHistory = await progressState(client)
  const postHistoryTurnTaskCount = postHistory?.tasks.length ?? -1
  const previousTurnTodoNotCarried = postHistoryTurnTaskCount === 0
  if (!previousTurnTodoNotCarried) {
    reasons.push(`a new ordinary turn in the same session still showed ${String(postHistoryTurnTaskCount)} tasks from the previous turn`)
  }

  // The restart needs a run that is still active when the Host is replaced: the
  // task-orch package's two-lane flow stays running long enough to be invalidated.
  const restartPrompt = `@task-orch ${MARKER}-RESTART 请按双盲流程派发两个独立子代理（A/B），分别审查 samples 目录下的全部文件并给出分级评审报告，最后汇总交集与分歧。`
  let restartRunId
  const restartRunLabel = '@task-orch'
  for (let attempt = 1; attempt <= 2 && restartRunId === undefined; attempt += 1) {
    const restartBeforeLedger = await subagentRunsOf(client, historySessionId)
    const known = new Set((restartBeforeLedger.runs ?? []).map((run) => run.runId))
    await sendText(client, restartPrompt)
    try {
      const created = await waitForNewRun(client, historySessionId, restartRunLabel, known, Math.min(options.timeout, 90_000))
      const candidateId = created.runs[0].runId
      const active = await waitFor('restart run stays active', async () => {
        const snapshot = await subagentRunsOf(client, historySessionId)
        const run = (snapshot.runs ?? []).find((candidate) => candidate.runId === candidateId)
        return { ok: run !== undefined && isActiveRun(run), value: run?.phase ?? null }
      }, 20_000, 250).catch(() => undefined)
      if (active === undefined) {
        log(`restart run ${candidateId} finished before the restart; retrying`)
        continue
      }
      restartRunId = candidateId
    } catch (cause) {
      log(`restart run attempt ${attempt} did not appear: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  const flushPreRestartFailures = () => recordPartialCheckFailureBeforeBlocked(
    'switch-history-restart',
    reasons,
    {
      historySessionId,
      ownedTaskCount: ownedTasks,
      freshTabTaskCount,
      freshTodoCardCount: freshTodoCards,
      switchTaskCount,
      previousTodoNotInFreshTab,
      historyReloadTaskCount,
      historyTodoCardCount,
      postHistoryTurnTaskCount,
      previousTurnTodoNotCarried,
      connectionSamples: [],
      reconnectBannerSeen: false,
      restart: { attempted: false, asserted: false },
    },
  )
  if (restartRunId === undefined) {
    flushPreRestartFailures()
    throw new BlockedError('no active run could be constructed for the Host restart', { attempts: 2 })
  }
  const hook = await client.evaluate(`typeof window.huaanworkAcceptance?.restartHost === 'function'`)
  if (hook !== true) {
    flushPreRestartFailures()
    throw new BlockedError('window.huaanworkAcceptance.restartHost is unavailable; HUAANWORK_ACCEPTANCE_HOOKS=1 did not reach the renderer')
  }
  await screenshot(client, '12-before-host-restart.png')

  mainLogPath = findMainLog()
  if (mainLogPath !== undefined) log(`main log ${mainLogPath}`)
  const beforeExpression = `(() => {
    const canary = crypto.randomUUID()
    window.__huaanworkHostRestartCanary = canary
    return { canary, timeOrigin: performance.timeOrigin, origin: location.origin }
  })()`
  await client.evaluate(CONNECTION_SAMPLER)
  const before = await client.evaluate(beforeExpression)
  const mainRunCountBefore = await mainRunCount(mainLogPath)
  const restart = await client.evaluate('window.huaanworkAcceptance.restartHost()')
  const after = await client.evaluate(`(() => ({
    canary: window.__huaanworkHostRestartCanary,
    timeOrigin: performance.timeOrigin,
    origin: location.origin,
  }))()`)
  const staleExpression = `([...document.querySelectorAll('.subagent-run-card[data-stale="true"]')].map((card) => ({
    text: card.textContent ?? '',
    terminateDisabled: card.querySelector('.subagent-run-terminate')?.disabled ?? null,
    elapsed: card.querySelector('.subagent-run-status .subagent-run-meta')?.textContent ?? null,
    phase: card.getAttribute('data-phase'),
  })))`
  let staleCards = []
  try {
    staleCards = await waitFor('stale card after Host restart', async () => {
      const value = await client.evaluate(staleExpression)
      return { ok: Array.isArray(value) && value.length > 0, value }
    }, Math.min(options.timeout, 60_000), 250)
  } catch (cause) {
    reasons.push(`no stale run card appeared after the Host restart: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const mainRunCountAfter = await mainRunCount(mainLogPath)
  await delay(1_250)
  let staleCardsLater = []
  try {
    staleCardsLater = await client.evaluate(staleExpression)
  } catch { /* best effort */ }
  if (!Array.isArray(staleCards)) staleCards = []
  if (!Array.isArray(staleCardsLater)) staleCardsLater = []
  const connectionSamples = await client.evaluate('window.__progressAccept?.samples ?? []').catch(() => [])
  await screenshot(client, '13-after-host-restart.png')
  const reconnectBannerSeen = Array.isArray(connectionSamples) && connectionSamples.some((sample) => (
    sample.connection === 'reconnecting'
    || sample.connection === 'disconnected'
    || (typeof sample.banner === 'string' && (sample.banner.includes('重新连接') || sample.banner.includes('连接中断')))
  ))
  if (!reconnectBannerSeen) reasons.push(`no disconnect/reconnect banner was observed; connection samples ${JSON.stringify(connectionSamples)}`)

  const evidence = { before, restart, after, mainRunCountBefore, mainRunCountAfter, staleCards, staleCardsLater }
  let asserted = false
  try {
    assertHostRestartEvidence(evidence)
    asserted = true
  } catch (cause) {
    reasons.push(`Host restart evidence rejected: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  return checkFact('switch-history-restart', {
    ok: reasons.length === 0,
    historySessionId,
    ownedTaskCount: ownedTasks,
    freshTabTaskCount,
    freshTodoCardCount: freshTodoCards,
    switchTaskCount,
    previousTodoNotInFreshTab,
    historyReloadTaskCount,
    historyTodoCardCount,
    postHistoryTurnTaskCount,
    previousTurnTodoNotCarried,
    connectionSamples,
    reconnectBannerSeen,
    restart: {
      attempted: true,
      asserted,
      runId: restartRunId,
      oldPid: restart?.oldPid ?? null,
      newPid: restart?.newPid ?? null,
      sameDocument: before.canary === after.canary && before.timeOrigin === after.timeOrigin,
      mainRunCountBefore,
      mainRunCountAfter,
      staleCardCount: staleCards.length,
      staleCards: staleCards.map((card) => ({
        text: clip(card.text, 300),
        terminateDisabled: card.terminateDisabled,
        elapsed: card.elapsed,
        phase: card.phase,
      })),
      evidence,
    },
    reasons,
  })
}

/* ------------------------------------------------------------------------- *
 * Main
 * ------------------------------------------------------------------------- */

async function run() {
  mkdirSync(options.outDir, { recursive: true })
  const startedAt = new Date().toISOString()
  const zstdVersion = requireZstd()
  const versions = appVersions()
  const build = requireFreshBuild()
  const nativeBinding = requireElectronNative()
  const models = readProductionModelSettings()
  requireTextutil()

  tempRoot = mkdtempSync(join(tmpdir(), 'huaanwork-progress-sidebar-'))
  const homeDir = join(tempRoot, 'dsh-home', '.huaanwork')
  userDataDir = join(tempRoot, 'user-data')
  const workspaceDir = join(tempRoot, 'workspace')
  const sampleDir = join(workspaceDir, 'samples')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(sampleDir, { recursive: true })
  log(`isolated root ${tempRoot}`)

  legacyCatalogServer = await startLegacyCatalogServer()
  const prepared = prepareProfile({
    homeDir,
    userDataDir,
    workspaceDir,
    models: models.settings,
    legacyCatalogPort: legacyCatalogServer.port,
  })
  await writeAuthState(prepared.profileDir)
  const seeded = seedAgentPackages(prepared.profileDir)
  makeSampleDocx(sampleDir)
  makeSampleCode(sampleDir)
  isolated = { homeDir, profileDir: prepared.profileDir, workspaceDir, sampleDir, userDataDir }

  facts = {
    schemaVersion: 1,
    outcome: 'PENDING',
    startedAt,
    environment: {
      platform: process.platform,
      arch: osArch(),
      release: osRelease(),
      node: process.version,
      desktopVersion: versions.desktop,
      dshVersion: versions.dsh,
      zstd: zstdVersion,
      headSha: runGit(['rev-parse', 'HEAD'], REPO_ROOT),
      branch: runGit(['rev-parse', '--abbrev-ref', 'HEAD'], REPO_ROOT),
      harnessPin: runGit(['rev-parse', 'HEAD'], join(REPO_ROOT, 'deepseek-harness')),
      electronVersion: readJson(join(PACKAGE_ROOT, 'node_modules', 'electron', 'package.json'))?.version ?? '',
    },
    appEntry: {
      launched: 'electron lib/main.js with CDP flags, isolated DSH_HOME and HUAANWORK_ACCEPTANCE_HOOKS=1',
      mainPath: MAIN_PATH,
      build,
      nativeBinding,
    },
    precheck: {
      model: models.summary,
      guardMode: 'smart (written by this script; the production value is not copied)',
      seeded: Array.isArray(seeded?.seeded) ? seeded.seeded : [],
      legacyCatalogPort: legacyCatalogServer.port,
      zstdRequired: true,
    },
    isolated: { homeDir, userDataDir, workspaceDir, sampleDir },
    checks: progress.checks,
    rpc: { capturedRequestCount: 0, channel: 'CDP Network.requestWillBeSent (/huaanwork/*)' },
    screenshots,
    errors: [],
    blocked: null,
  }

  const cdpPort = options.cdp === undefined ? await freePort() : Number(options.cdp)
  appProcess = await launchApp({ homeDir, cdpPort, outDir: options.outDir })
  appCdp = await connectAppPage(cdpPort, options.timeout)
  await ensureLoggedIn(appCdp)
  await ensureProgressTab(appCdp)
  await screenshot(appCdp, '00-app-ready.png')
  log(`app ready (cdp ${String(cdpPort)})`)

  const selected = (scene) => options.only === undefined || options.only.includes(scene)
  let tasksFact = { taskCount: 0 }
  if (selected('tasks')) {
    tasksFact = await driveProgressTasks(appCdp)
  }
  // The shared session is the one the complex task opened; the later package
  // scenes reuse it because its workspace already carries the samples.
  const stableSessionId = selected('lane') || selected('siblings') || selected('at')
    ? await waitForParentSessionId(appCdp, `${MARKER}-TODO`, Math.min(options.timeout, 120_000))
    : undefined
  if (selected('percent')) {
    if (complexSamples.length === 0) throw new Error('--only percent needs the tasks scene to collect the activity samples')
    await driveNoFabricatedPercentage(appCdp, tasksFact)
  }
  if (selected('at')) {
    if (stableSessionId === undefined) throw new Error('--only at needs the stable session (run tasks first)')
    await driveParentNoSelfSpawn(appCdp, tasksFact)
  }
  if (selected('lane')) {
    if (stableSessionId === undefined) throw new Error('--only lane needs the stable session (run tasks first)')
    await drivePackageLaneDepthTwo(appCdp, stableSessionId)
  }
  if (selected('siblings')) {
    if (stableSessionId === undefined) throw new Error('--only siblings needs the stable session (run tasks first)')
    await driveSingleCancelIsolation(appCdp, stableSessionId)
  }
  if (selected('switch')) {
    await driveSwitchHistoryRestart(appCdp)
  }
  if (selected('dual')) {
    // The system-skill scene runs last and in its own tab: the two entries can make
    // the Host surface a real exception, and that must not poison the earlier scenes.
    await newTaskTab(appCdp)
    // Mint the tab's workspace-session root before seeding the samples/fixme fixture.
    await sendAndSettle(appCdp, `${MARKER}-DUAL-WARM 回复「好」两个字即可。`, { label: 'dual warm-up' }).catch((cause) => {
      log(`dual warm-up did not settle: ${cause instanceof Error ? cause.message : String(cause)}`)
    })
    seedSceneFiles()
    await driveDualEntrySystemSkills(appCdp, { freshTab: true })
  }

  facts.checks = progress.checks
  const requests = await resolveRpcPostData(appCdp).catch(() => rpcRequests)
  facts.rpc = {
    capturedRequestCount: requests.length,
    cancelRequests: countSubagentCancelRequests(requests, ''),
    channel: 'CDP Network.requestWillBeSent (/huaanwork/*)',
  }
  // A BLOCKED verdict is reserved for the model-skill entry being unreachable
  // (F1) as the only failure. Any other failing check is a real product FAIL and
  // must exit 1, so BLOCKED never masks a FAIL. The blocked detail is recorded in
  // facts either way; the failing-check assertion decides the verdict.
  const dualCheck = progress.checks['dual-entry-system-skills']
  if (dualCheck?.modelSkillBlocked !== null && dualCheck?.modelSkillBlocked !== undefined) {
    const blocked = {
      cause: `the model-triggered system-skill entry is unreachable: ${dualCheck.modelSkillBlocked.cause}`,
      detail: {
        check: 'dual-entry-system-skills',
        entry: dualCheck.modelSkillBlocked.entry,
        skill: dualCheck.modelSkillBlocked.skill,
        sessionId: dualCheck.modelSkillBlocked.sessionId,
        toolNames: dualCheck.modelSkillBlocked.toolNames,
      },
    }
    const failingIds = PROGRESS_ACCEPT_CHECK_IDS.filter((id) => progress.checks[id]?.ok !== true)
    const dualReasons = Array.isArray(dualCheck.reasons) ? dualCheck.reasons : []
    const onlyModelSkillBlocked = failingIds.length === 1
      && failingIds[0] === 'dual-entry-system-skills'
      && dualReasons.length > 0
      && dualReasons.every((reason) => reason === MODEL_SKILL_BLOCKED_REASON)
    if (onlyModelSkillBlocked) {
      throw new BlockedError(blocked.cause, { ...blocked.detail, onlyBlockedCheckId: 'dual-entry-system-skills' })
    }
    facts.blocked = blocked
  }
  assertProgressSidebarAcceptanceFacts(facts)
  facts.outcome = 'PASS'
  facts.finishedAt = new Date().toISOString()
  log('verdict PASS')
}

function persistFacts() {
  if (facts === undefined) return
  facts.checks = progress.checks
  facts.screenshots = screenshots
  mkdirSync(dirname(join(options.outDir, 'facts.json')), { recursive: true })
  writeFileSync(join(options.outDir, 'facts.json'), `${JSON.stringify(redactReport(facts, SECRETS), null, 2)}\n`)
}

function blockedFacts(error) {
  return {
    schemaVersion: 1,
    outcome: 'BLOCKED',
    startedAt: facts?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: osArch(),
      release: osRelease(),
      node: process.version,
      headSha: runGit(['rev-parse', 'HEAD'], REPO_ROOT),
      branch: runGit(['rev-parse', '--abbrev-ref', 'HEAD'], REPO_ROOT),
    },
    blocked: { cause: error.message, detail: error.detail ?? {} },
    checks: progress.checks,
    errors: [error.message],
    screenshots,
  }
}

async function shutdown() {
  if (shutdownDone) return
  shutdownDone = true
  try { appCdp?.close() } catch { /* best effort */ }
  if (legacyCatalogServer !== undefined) {
    try { await legacyCatalogServer.close() } catch { /* best effort */ }
    legacyCatalogServer = undefined
  }
  if (appProcess !== undefined && appProcess.exitCode === null && appProcess.signalCode === null) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/pid', String(appProcess.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        appProcess.kill('SIGTERM')
      }
    } catch { /* already gone */ }
    const deadline = Date.now() + 15_000
    while (appProcess.exitCode === null && appProcess.signalCode === null && Date.now() < deadline) await delay(250)
    if (appProcess.exitCode === null && appProcess.signalCode === null) {
      try { appProcess.kill('SIGKILL') } catch { /* already gone */ }
    }
  }
  for (const sink of streamSinks) sink.end()
  streamSinks = []
  if (appLogFile !== undefined) {
    await new Promise((resolveEnd) => { appLogFile.end(resolveEnd) })
  }
  // The isolated root holds the copied model credential, the per-run session
  // logs and screenshots-in-progress; it never survives the run. Fail closed
  // if cleanup itself throws (Q4-I6).
  lastCleanupResult = cleanupIsolatedRoot(tempRoot, facts)
  if (!lastCleanupResult.ok) {
    log(`FAILED isolated credential cleanup for ${String(tempRoot)}: ${String(lastCleanupResult.detail ?? 'unknown error')}`)
  } else if (lastCleanupResult.kept) {
    log(`kept isolated root ${String(tempRoot)} for debugging; remove it manually`)
  }
  persistFacts()
  log(`facts written to ${join(options.outDir, 'facts.json')}`)
  writeFileSync(join(options.outDir, 'walkthrough.log'), `${redactSecrets(driverLog.join('\n'), SECRETS)}\n`)
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  options = parseArguments(process.argv.slice(2))
  run()
    .catch(async (error) => {
      const seedFacts = facts === undefined && error instanceof BlockedError ? blockedFacts(error) : facts
      const resolved = resolveBlockedOrFailedOutcome(seedFacts, progress.checks, error, (value) => redactSecrets(value, SECRETS))
      facts = resolved.facts
      if (resolved.exitCode === 3) {
        log(`BLOCKED: ${error.message}`)
        persistFacts()
        return
      }
      if (appCdp !== undefined) {
        try {
          await screenshot(appCdp, '99-failure.png')
          const body = await appCdp.evaluate('document.body?.innerText ?? ""')
          writeFileSync(join(options.outDir, 'page-dom-on-failure.txt'), redactSecrets(String(body), SECRETS))
        } catch { /* best effort */ }
      }
      persistFacts()
      log(`FAILED: ${error instanceof Error ? error.message : String(error)}`)
    })
    .finally(async () => {
      await shutdown()
      process.exitCode = resolveFinalExitCode(facts, lastCleanupResult)
    })
}
