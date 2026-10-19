export type Liveness = { phase: "ok" | "suspect" | "stoppable"; turns: number; lastOkMs: number };

export const HOST_LIVENESS_CHANNEL = "huaanwork:host-liveness";
export const HOST_LIVENESS_TURNS_CHANNEL = "huaanwork:host-liveness-turns";
export const HOST_LIVENESS_STOP_CHANNEL = "huaanwork:host-liveness-stop";
export const HOST_LIVENESS_READ_CHANNEL = "huaanwork:host-liveness-read";

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
