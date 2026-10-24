/**
 * Pure Step 5 verdict for the Windows agent-package acceptance probe.
 *
 * Exit codes shared with the runner:
 *   0  PASS — sandbox facts and every started lifecycle phase held
 *   1  FAIL — a completed observation contradicted the expectation
 *   2  USAGE — the sandbox probe or this entry was invoked incorrectly
 *   3  BLOCKED — a required observation never started
 *
 * A force-kill of leftover processes is recorded by the runner and ignored
 * here. Leftovers themselves are already a hard failure on the phase that
 * saw them.
 */

const SANDBOX_FACTS = ['httpReady', 'writeDenied', 'readOutside', 'networkOutside']

/**
 * @param {object | null} facts sandbox-probe JSON, or null when it could not be parsed
 * @returns {{ pass: boolean, failures: string[] }}
 */
export function evaluateSandboxFacts(facts) {
  if (facts === null || typeof facts !== 'object') {
    return { pass: false, failures: ['sandbox-facts-missing'] }
  }
  const failures = []
  if (facts.platform !== 'win32') failures.push(`platform:${String(facts.platform)}`)
  if (facts.enforcement !== 'partial') failures.push(`enforcement:${String(facts.enforcement)}`)
  for (const key of SANDBOX_FACTS) {
    if (facts[key] !== true) failures.push(`${key}:${String(facts[key])}`)
  }
  return { pass: failures.length === 0, failures }
}

/**
 * Markers for `agents\<slug>\` and the slash form Node sometimes keeps.
 * The trailing separator keeps `weekly-report` from matching `weekly-report-v2`.
 *
 * @param {string} slug package directory name
 * @returns {string[]}
 */
export function packageCommandMarkers(slug) {
  return [`agents\\${slug}\\`, `agents/${slug}/`]
}

/**
 * @param {Array<{ commandLine?: string | null, processId?: number | null, name?: string | null }> | null | undefined} processes
 * @param {string} slug
 * @returns {Array<{ processId: number | null, name: string | null, commandLine: string }>}
 */
export function findResidualProcesses(processes, slug) {
  const markers = packageCommandMarkers(slug)
  const residuals = []
  for (const row of processes ?? []) {
    const commandLine = typeof row?.commandLine === 'string' ? row.commandLine : ''
    if (commandLine.length === 0) continue
    if (!markers.some((marker) => commandLine.includes(marker))) continue
    residuals.push({
      processId: row.processId ?? null,
      name: row.name ?? null,
      commandLine,
    })
  }
  return residuals
}

/**
 * Parse `Get-CimInstance Win32_Process | ConvertTo-Json` output.
 * PowerShell emits one object when the filter matches a single process.
 *
 * @param {string | null | undefined} text
 * @returns {Array<{ processId: number | null, name: string | null, commandLine: string | null }>}
 */
export function parseCimProcessList(text) {
  const trimmed = String(text ?? '').replace(/^\uFEFF/u, '').trim()
  if (trimmed.length === 0 || trimmed === 'null') return []
  const parsed = JSON.parse(trimmed)
  if (parsed === null) return []
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.map((row) => ({
    processId: row?.ProcessId ?? row?.processId ?? null,
    name: row?.Name ?? row?.name ?? null,
    commandLine: row?.CommandLine ?? row?.commandLine ?? null,
  }))
}

/**
 * @param {{ name: string, started: boolean, stopped: boolean, residuals?: unknown[], error?: string }} phase
 * @returns {{ hard: string[], blocked: string[] }}
 */
export function classifyPhase(phase) {
  if (!phase.started) {
    return { hard: [], blocked: [`${phase.name}:${phase.error ?? 'not-started'}`] }
  }
  const hard = []
  if (!phase.stopped) hard.push(`${phase.name}:not-stopped`)
  const count = phase.residuals?.length ?? 0
  if (count > 0) hard.push(`${phase.name}:residuals:${String(count)}`)
  return { hard, blocked: [] }
}

/**
 * @param {{
 *   sandboxExitCode: number,
 *   sandboxFacts: object | null,
 *   phases: Array<{ name: string, started: boolean, stopped: boolean, residuals?: unknown[], error?: string }>,
 *   forceKillErrors?: string[],
 * }} input
 * @returns {{ exitCode: number, verdict: string, hardFailures: string[], blockers: string[], forceKillIgnored: string[] }}
 */
export function decideWindowsAcceptance(input) {
  const forceKillIgnored = input.forceKillErrors ?? []
  if (input.sandboxExitCode === 2) {
    return {
      exitCode: 2,
      verdict: 'USAGE',
      hardFailures: ['sandbox-probe-usage'],
      blockers: [],
      forceKillIgnored,
    }
  }

  const hardFailures = []
  const blockers = []
  if (input.sandboxExitCode === 3) {
    blockers.push('sandbox-probe-blocked')
  } else {
    const sandbox = evaluateSandboxFacts(input.sandboxFacts)
    if (input.sandboxExitCode !== 0 || !sandbox.pass) {
      hardFailures.push(...(sandbox.failures.length > 0 ? sandbox.failures : [`sandbox-probe-exit-${String(input.sandboxExitCode)}`]))
    }
  }

  for (const phase of input.phases) {
    const classified = classifyPhase(phase)
    hardFailures.push(...classified.hard)
    blockers.push(...classified.blocked)
  }

  if (hardFailures.length > 0) {
    return { exitCode: 1, verdict: 'FAIL', hardFailures, blockers, forceKillIgnored }
  }
  if (blockers.length > 0) {
    return { exitCode: 3, verdict: 'BLOCKED', hardFailures, blockers, forceKillIgnored }
  }
  return { exitCode: 0, verdict: 'PASS', hardFailures, blockers, forceKillIgnored }
}
