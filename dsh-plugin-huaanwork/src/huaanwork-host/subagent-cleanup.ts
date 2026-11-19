/**
 * Shared activation cleanup primitives for the legacy `@agent` and system-skill
 * dispatch paths.
 *
 * Both paths must bound three waits: the graceful result wait, the `dispose()`
 * call, and the observation window after `dispose()` while the authoritative
 * result is still pending. The observation window deliberately takes no
 * `AbortSignal`: the caller's controller is already aborted on a targeted
 * cancel, so reusing it would short-circuit the window at 0 ms.
 */

import { acceptanceDisposeFailure } from './acceptance-hooks.ts'
import { ACTIVATION_CLEANUP_TIMEOUT_MS, settleWithin } from './agent-package/host.ts'
import type { SubagentActivationHandle } from './subagents-service.ts'

export { settleWithin }

/** Bounded `dispose()` outcome; only `fulfilled` counts as cleanup confirmation. */
export type ActivationDisposeOutcome = 'fulfilled' | 'rejected' | 'timeout'

/**
 * Bounded activation release. Synchronous throws and rejections both report
 * `rejected`; a timeout is never treated as success, and no failure is thrown
 * to the caller.
 *
 * The acceptance fault-injection seam (`acceptanceDisposeFailure()`) short-
 * circuits the real handle while the master switch is on; with hooks off it is
 * always `none`.
 *
 * @param activation — handle narrowed to the only member this helper consumes
 * @param timeoutMs — release bound (defaults to the production constant)
 * @returns which of the three outcomes occurred first
 */
export async function disposeActivationWithTimeout(
  activation: Pick<SubagentActivationHandle, 'dispose'>,
  timeoutMs = ACTIVATION_CLEANUP_TIMEOUT_MS,
): Promise<ActivationDisposeOutcome> {
  const failure = acceptanceDisposeFailure()
  if (failure === 'reject') return 'rejected'
  if (failure === 'hang') {
    await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    return 'timeout'
  }
  let rejected = false
  let disposal: Promise<void>
  try {
    disposal = Promise.resolve(activation.dispose())
  } catch {
    return 'rejected'
  }
  const observed = disposal.catch(() => {
    rejected = true
  })
  const settled = await settleWithin(observed, timeoutMs)
  if (!settled) return 'timeout'
  return rejected ? 'rejected' : 'fulfilled'
}

/** Graceful result wait outcome: `cancelled` means a targeted cancel woke it. */
export type ResultWaitOutcome = 'settled' | 'timeout' | 'cancelled'

/**
 * Wait for the authoritative result observation, bounded by `timeoutMs` and
 * woken immediately by the dispatch's targeted-cancel signal.
 *
 * @param observed — promise already wired to `settleResult`/`rejectResult`
 * @param signal — the dispatch-local controller signal
 * @param timeoutMs — graceful wait budget (defaults to the production constant)
 * @returns why the wait ended; never rejects
 */
export function waitResultWithBudget(
  observed: Promise<void>,
  signal: AbortSignal,
  timeoutMs = ACTIVATION_CLEANUP_TIMEOUT_MS,
): Promise<ResultWaitOutcome> {
  return new Promise((resolve) => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (outcome: ResultWaitOutcome): void => {
      if (done) return
      done = true
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = (): void => finish('cancelled')
    if (signal.aborted) {
      finish('cancelled')
      return
    }
    timer = setTimeout(() => finish('timeout'), timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    void observed.then(
      () => finish('settled'),
      () => finish('settled'),
    )
  })
}
