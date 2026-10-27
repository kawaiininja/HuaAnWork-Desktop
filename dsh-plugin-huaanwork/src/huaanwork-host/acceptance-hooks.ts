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

/** Master switch; any other value (including `undefined`) keeps every hook inert. */
export const HUAANWORK_ACCEPTANCE_HOOKS_ENV = 'HUAANWORK_ACCEPTANCE_HOOKS'

/** Overrides the cleanup timeout in milliseconds while hooks are enabled. */
export const HUAANWORK_ACCEPTANCE_CLEANUP_TIMEOUT_ENV = 'HUAANWORK_ACCEPTANCE_CLEANUP_TIMEOUT_MS'

/** Selects a synthetic activation dispose outcome while hooks are enabled. */
export const HUAANWORK_ACCEPTANCE_DISPOSE_FAILURE_ENV = 'HUAANWORK_ACCEPTANCE_DISPOSE_FAILURE'

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
