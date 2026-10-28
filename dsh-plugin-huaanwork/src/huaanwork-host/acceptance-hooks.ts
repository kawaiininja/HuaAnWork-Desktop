/**
 * Acceptance-only fault injection for the cleanup paths.
 *
 * Every helper is gated by the single `HUAANWORK_ACCEPTANCE_HOOKS=1` master
 * switch. With it unset — the production default — the helpers return their
 * fallback values and the Host behaves exactly as before; the seam cannot change
 * runtime behavior, cleanup semantics, or the `cleanupOk()` criterion.
 *
 * These values exist only so the remaining cleanup-related acceptance items
 * (A-08, B-05, B-08, A-14) can be exercised in a real Electron app. They are not
 * product tunables: they are not persisted, not surfaced in settings, and must
 * not be treated as supported configuration.
 */

import type { SubagentCleanupWarning, SubagentStopReason } from '../client-huaanwork/rpc-types.ts'

/** Master switch; any other value (including `undefined`) keeps every hook inert. */
export const HUAANWORK_ACCEPTANCE_HOOKS_ENV = 'HUAANWORK_ACCEPTANCE_HOOKS'

/** Overrides the cleanup timeout in milliseconds while hooks are enabled. */
export const HUAANWORK_ACCEPTANCE_CLEANUP_TIMEOUT_ENV = 'HUAANWORK_ACCEPTANCE_CLEANUP_TIMEOUT_MS'

/** Selects a synthetic activation dispose outcome while hooks are enabled. */
export const HUAANWORK_ACCEPTANCE_DISPOSE_FAILURE_ENV = 'HUAANWORK_ACCEPTANCE_DISPOSE_FAILURE'

/** Holds the `finalizing` phase for N ms before a resolved result is applied. */
export const HUAANWORK_ACCEPTANCE_HOLD_FINALIZING_ENV = 'HUAANWORK_ACCEPTANCE_HOLD_FINALIZING_MS'

/** Holds any resolved result for N ms before it is applied (cancel/end race). */
export const HUAANWORK_ACCEPTANCE_HOLD_END_ENV = 'HUAANWORK_ACCEPTANCE_HOLD_END_MS'

/** Selects which package await point is delayed: `createRuntime` or `startActivation`. */
export const HUAANWORK_ACCEPTANCE_PACKAGE_DELAY_POINT_ENV = 'HUAANWORK_ACCEPTANCE_PACKAGE_DELAY_POINT'

/** Delay in milliseconds for the selected package await point. */
export const HUAANWORK_ACCEPTANCE_PACKAGE_DELAY_MS_ENV = 'HUAANWORK_ACCEPTANCE_PACKAGE_DELAY_MS'

/** Injects an extra concurrent tool with this name alongside every real child tool. */
export const HUAANWORK_ACCEPTANCE_INJECT_TOOL_NAME_ENV = 'HUAANWORK_ACCEPTANCE_INJECT_TOOL_NAME'

/** Overrides the resolved terminal reason (`max-tokens`, `refusal`, or `unknown`). */
export const HUAANWORK_ACCEPTANCE_TERMINAL_REASON_ENV = 'HUAANWORK_ACCEPTANCE_TERMINAL_REASON'

/** Marks each child tool as failed without deciding the run outcome. */
export const HUAANWORK_ACCEPTANCE_TOOL_FAILURE_ENV = 'HUAANWORK_ACCEPTANCE_TOOL_FAILURE'

/** Appends extra cleanup warnings when a result is settled. */
export const HUAANWORK_ACCEPTANCE_EXTRA_WARNINGS_ENV = 'HUAANWORK_ACCEPTANCE_EXTRA_WARNINGS'

/**
 * Whether the acceptance master switch is on.
 *
 * @param env environment to read instead of `process.env`
 * @returns `true` only for the exact value `1`
 */
export function acceptanceHooksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HUAANWORK_ACCEPTANCE_HOOKS_ENV] === '1'
}

/**
 * Cleanup wait budget used by the legacy and package activation paths.
 *
 * @param fallback production timeout used whenever the hooks are off or the env value is invalid
 * @param env environment to read instead of `process.env`
 * @returns the rounded positive override while hooks are enabled, otherwise `fallback`
 */
export function acceptanceCleanupTimeoutMs(fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  if (!acceptanceHooksEnabled(env)) return fallback
  const raw = env[HUAANWORK_ACCEPTANCE_CLEANUP_TIMEOUT_ENV]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.max(1, Math.round(parsed))
}

/** Synthetic activation dispose outcome injected by the acceptance seam. */
export type AcceptanceDisposeFailure = 'none' | 'reject' | 'hang'

/**
 * Activation dispose outcome to simulate.
 *
 * @param env environment to read instead of `process.env`
 * @returns `reject` / `hang` only for those exact values while hooks are enabled; `none` otherwise
 */
export function acceptanceDisposeFailure(env: NodeJS.ProcessEnv = process.env): AcceptanceDisposeFailure {
  if (!acceptanceHooksEnabled(env)) return 'none'
  const raw = env[HUAANWORK_ACCEPTANCE_DISPOSE_FAILURE_ENV]
  return raw === 'reject' || raw === 'hang' ? raw : 'none'
}

/** Parses a positive millisecond override; anything else falls back to 0 (inert). */
function acceptanceMs(raw: string | undefined): number {
  if (raw === undefined) return 0
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.max(1, Math.round(parsed))
}

/** Milliseconds to hold the `finalizing` phase; 0 when disabled or invalid. */
export function acceptanceHoldFinalizingMs(env: NodeJS.ProcessEnv = process.env): number {
  if (!acceptanceHooksEnabled(env)) return 0
  return acceptanceMs(env[HUAANWORK_ACCEPTANCE_HOLD_FINALIZING_ENV])
}

/** Milliseconds to hold any resolved result; 0 when disabled or invalid. */
export function acceptanceHoldEndMs(env: NodeJS.ProcessEnv = process.env): number {
  if (!acceptanceHooksEnabled(env)) return 0
  return acceptanceMs(env[HUAANWORK_ACCEPTANCE_HOLD_END_ENV])
}

/** Package await point to delay; `none` when disabled or invalid. */
export function acceptancePackageDelayPoint(env: NodeJS.ProcessEnv = process.env): 'createRuntime' | 'startActivation' | 'none' {
  if (!acceptanceHooksEnabled(env)) return 'none'
  const raw = env[HUAANWORK_ACCEPTANCE_PACKAGE_DELAY_POINT_ENV]
  return raw === 'createRuntime' || raw === 'startActivation' ? raw : 'none'
}

/** Milliseconds to delay the selected package await point; 0 when disabled or invalid. */
export function acceptancePackageDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  if (!acceptanceHooksEnabled(env)) return 0
  return acceptanceMs(env[HUAANWORK_ACCEPTANCE_PACKAGE_DELAY_MS_ENV])
}

/** Extra tool name to inject alongside every real child tool; undefined when disabled. */
export function acceptanceInjectToolName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!acceptanceHooksEnabled(env)) return undefined
  const raw = env[HUAANWORK_ACCEPTANCE_INJECT_TOOL_NAME_ENV]
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : undefined
}

/** Terminal reason to force on a resolved result; undefined when disabled or invalid. */
export function acceptanceTerminalReason(env: NodeJS.ProcessEnv = process.env): SubagentStopReason | undefined {
  if (!acceptanceHooksEnabled(env)) return undefined
  const raw = env[HUAANWORK_ACCEPTANCE_TERMINAL_REASON_ENV]
  return raw === 'max-tokens' || raw === 'refusal' || raw === 'unknown' ? raw : undefined
}

/** Whether to mark each child tool as failed without deciding the run outcome. */
export function acceptanceToolFailure(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!acceptanceHooksEnabled(env)) return false
  return env[HUAANWORK_ACCEPTANCE_TOOL_FAILURE_ENV] === '1'
}

/** Extra cleanup warnings to append when a result is settled; empty when disabled. */
export function acceptanceExtraWarnings(env: NodeJS.ProcessEnv = process.env): SubagentCleanupWarning[] {
  if (!acceptanceHooksEnabled(env)) return []
  if (env[HUAANWORK_ACCEPTANCE_EXTRA_WARNINGS_ENV] !== '1') return []
  return [
    { code: 'acceptance-warning-info', severity: 'info' },
    { code: 'acceptance-warning-error', severity: 'error' },
  ]
}
