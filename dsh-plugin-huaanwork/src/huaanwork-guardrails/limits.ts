import { classifyShell } from "@huaanwork/policy/shell";

import { skillKindOf } from "./skills.ts";

export const name = "huaanwork-limits";
export const inject = ["agents", "tools"];

export const MAX_CONSECUTIVE_SAME_FAILURES = 3;
export const MAX_TEST_FIX_ROUNDS = 5;

type Agent = {
  id?: string;
  session?: { id?: string };
  cancel?: (reason: { kind: "parent" }) => void;
};

type Execution = { // 上游未导出;已逐字比对 0.1.6-alpha.2:core/tools/src/index.ts:376(ToolExecution)
  name: string;
  arguments: unknown;
  agent?: Agent;
};

type ToolResult = { // 上游未导出;已逐字比对 0.1.6-alpha.2:core/tools/src/index.ts:579(ToolExecutionResult)
  isError?: boolean;
  content?: readonly { type?: string; text?: string }[];
};

type SessionState = {
  failKey: string;
  failCount: number;
  testRounds: number;
  lastTestOutput: string;
  stopped: boolean;
};

type Context = {
  huaanworkEmit?: (event: { event: "session/end"; ok: false; error: string }) => void;
  on(
    event: "tools/pre-execute" | "tools/result",
    listener: (...args: never[]) => unknown,
    prepend?: boolean,
  ): void;
};

export function apply(ctx: Context): void {
  const sessions = new WeakMap<object, SessionState>();
  const anonymous = new Map<string, SessionState>();

  const stateOf = (agent: Agent | undefined): SessionState => {
    if (agent) {
      const existing = sessions.get(agent);
      if (existing) return existing;
      const created = newState();
      sessions.set(agent, created);
      return created;
    }
    const existing = anonymous.get("default");
    if (existing) return existing;
    const created = newState();
    anonymous.set("default", created);
    return created;
  };

  const emitStop = (reason: string) => {
    ctx.huaanworkEmit?.({
      event: "session/end",
      ok: false,
      error: reason,
    });
  };

  const stop = (agent: Agent | undefined, state: SessionState, reason: string) => {
    state.stopped = true;
    emitStop(reason);
    return deny(agent, reason);
  };

  ctx.on(
    "tools/pre-execute",
    (async (execution: Execution, next: () => Promise<{ kind: string; reason?: string }>) => {
      const state = stateOf(execution.agent);
      if (state.stopped) {
        return deny(execution.agent, stopReason(state));
      }
      if (state.failCount >= MAX_CONSECUTIVE_SAME_FAILURES) {
        return stop(execution.agent, state, "same tool and key args failed 3 times");
      }
      if (skillKindOf(execution.agent) === "test-fix" && isTestRound(execution)) {
        state.testRounds += 1;
        if (state.testRounds > MAX_TEST_FIX_ROUNDS) {
          const summary = state.lastTestOutput.trim() || "still-failing tests";
          return stop(execution.agent, state, `still-failing tests after ${MAX_TEST_FIX_ROUNDS} rounds\n${summary}`);
        }
      }
      return next();
    }) as never,
    true,
  );

  ctx.on("tools/result", ((execution: Execution, result: ToolResult) => {
    const state = stateOf(execution.agent);
    const key = callKey(execution.name, objectArgs(execution.arguments));
    if (result?.isError) {
      if (skillKindOf(execution.agent) === "test-fix" && isTestRound(execution)) {
        state.lastTestOutput = resultText(result);
        return;
      }
      if (state.failKey === key) state.failCount += 1;
      else {
        state.failKey = key;
        state.failCount = 1;
      }
      if (state.failCount >= MAX_CONSECUTIVE_SAME_FAILURES) {
        state.stopped = true;
        emitStop("same tool and key args failed 3 times");
        execution.agent?.cancel?.({ kind: "parent" });
      }
      return;
    }
    state.failKey = "";
    state.failCount = 0;
  }) as never);
}

function newState(): SessionState {
  return {
    failKey: "",
    failCount: 0,
    testRounds: 0,
    lastTestOutput: "",
    stopped: false,
  };
}

function deny(agent: Agent | undefined, reason: string): { kind: "deny"; reason: string } {
  agent?.cancel?.({ kind: "parent" });
  return { kind: "deny", reason };
}

function stopReason(state: SessionState): string {
  if (state.testRounds > MAX_TEST_FIX_ROUNDS) {
    const summary = state.lastTestOutput.trim() || "still-failing tests";
    return `still-failing tests after ${MAX_TEST_FIX_ROUNDS} rounds\n${summary}`;
  }
  if (state.failCount >= MAX_CONSECUTIVE_SAME_FAILURES) return "same tool and key args failed 3 times";
  return "session stopped";
}

function isTestRound(execution: Execution): boolean {
  if (execution.name !== "bash" && execution.name !== "pwsh") return false;
  const command = stringArg(execution.arguments, "command") || stringArg(execution.arguments, "cmd");
  return classifyShell(command) === "allow-test";
}

function callKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args, Object.keys(args).sort())}`;
}

function objectArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArg(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : "";
}

function resultText(result: ToolResult): string {
  return (result.content ?? [])
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}
