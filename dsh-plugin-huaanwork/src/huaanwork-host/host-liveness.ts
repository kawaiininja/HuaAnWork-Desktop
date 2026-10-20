export type Liveness = { phase: "ok" | "suspect" | "stoppable"; turns: number; lastOkMs: number };

export const HOST_LIVENESS_CHANNEL = "huaanwork:host-liveness";
export const HOST_LIVENESS_TURNS_CHANNEL = "huaanwork:host-liveness-turns";
export const HOST_LIVENESS_STOP_CHANNEL = "huaanwork:host-liveness-stop";
export const HOST_LIVENESS_READ_CHANNEL = "huaanwork:host-liveness-read";

/** 探活走既有的 `status` 调用：Host 主事件循环回出带 pid 的状态才算应答。 */
export function probeAnswered(value: unknown): boolean {
  return !!value && typeof value === "object" && typeof (value as { pid?: unknown }).pid === "number";
}

export function reduceLiveness(
  state: Liveness,
  event: { kind: "probe-ok" | "probe-miss" | "turn-count"; atMs: number; turns?: number },
): Liveness {
  if (event.kind === "turn-count") return { ...state, turns: event.turns ?? 0 };
  if (event.kind === "probe-ok") return { phase: "ok", turns: state.turns, lastOkMs: event.atMs };
  const silent = event.atMs - state.lastOkMs;
  if (silent >= 60_000 && state.turns > 0) return { ...state, phase: "stoppable" };
  if (silent >= 15_000) return { ...state, phase: "suspect" };
  return state;
}

/** Why the supervised Host is exiting, from the supervisor's point of view. */
export type HostExitDisposition = "failure" | "user-stop" | "silent";

export type HostExitGate = {
  readonly booted: boolean;
  readonly stopping: boolean;
  readonly stoppedByUser: boolean;
  markBooted(): void;
  markStopping(): void;
  /**
   * Mark that the user confirmed the liveness dialog and the child is about to be
   * killed. Must run before `child.kill()` so the exit handler never reads the
   * kill as a crash and opens the recovery dialog (whose default is restart).
   */
  markStoppedByUser(): void;
  disposition(): HostExitDisposition;
};

/**
 * Tracks the three reasons a Host can end. A stop the user asked for is neutral:
 * it is neither an unexpected failure nor an app-requested teardown (which stays
 * completely silent while quitting or restarting).
 */
export function createHostExitGate(): HostExitGate {
  let booted = false;
  let stopping = false;
  let stoppedByUser = false;
  return {
    get booted() { return booted; },
    get stopping() { return stopping; },
    get stoppedByUser() { return stoppedByUser; },
    markBooted() { booted = true; },
    markStopping() { stopping = true; },
    markStoppedByUser() { stoppedByUser = true; },
    disposition() {
      if (stopping) return "silent";
      if (stoppedByUser) return "user-stop";
      return booted ? "failure" : "silent";
    },
  };
}
