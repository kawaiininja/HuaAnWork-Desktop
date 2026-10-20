export type RouteDecision =
  | { kind: "answer" }
  | { kind: "direct"; call: { name: string; args: unknown } }
  | { kind: "planned"; objective: string }
  | { kind: "clarify"; question: string }
  | { kind: "invalid" };

function exactString(args: unknown, key: "objective" | "question"): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  if (Object.keys(record).some((name) => name !== key)) return undefined;
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.trim();
}

export function preferControlCalls<T extends { name: string }>(calls: readonly T[]): T[] {
  const control = calls.find((call) => call.name === "propose_plan" || call.name === "request_input");
  return control ? [control] : [...calls];
}

/**
 * 分流工具判定的唯一规格。`route-tool-plugin` 的 `propose_plan` / `request_input`
 * execute 都先过这一支（runtime 用的是同一函数，不是副本）；本文件保持纯函数，
 * 便于把「只接受声明字段」的边界单独测。
 */
export function classifyToolCalls(calls: readonly { name: string; args: unknown }[]): RouteDecision {
  const control = calls.find((call) => call.name === "propose_plan" || call.name === "request_input");
  if (control?.name === "propose_plan") {
    const objective = exactString(control.args, "objective");
    return objective === undefined ? { kind: "invalid" } : { kind: "planned", objective };
  }
  if (control?.name === "request_input") {
    const question = exactString(control.args, "question");
    return question === undefined ? { kind: "invalid" } : { kind: "clarify", question };
  }
  const first = calls[0];
  if (!first) return { kind: "answer" };
  return { kind: "direct", call: first };
}
