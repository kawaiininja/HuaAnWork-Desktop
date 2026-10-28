import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  TERMINAL_RUN_PHASES,
  formatCleanupBudget,
  formatRunStartedAt,
  insertSubagentRunCard,
  isSubagentRunActive,
  parentTurnLine,
  reduceSubagentRuns,
  subagentAlert,
  subagentAlerts,
  subagentElapsedMs,
  subagentNeedsStartTime,
  subagentStatusDetail,
  subagentStatusText,
  subagentToolSummary,
  type SubagentRunsAction,
  type SubagentRunsState,
  type SubagentRunView,
} from "../../src/client-huaanwork/logic/subagentRuns.ts";
import type {
  SubagentRunPhase,
  SubagentRunProjection,
  SubagentStopReason,
  SubagentToolActivity,
} from "../../src/client-huaanwork/rpc-types.ts";

const BASE_RUN: SubagentRunProjection = {
  runId: "run-1",
  parentSessionId: "parent-a",
  kind: "legacy",
  label: "@agent",
  phase: "generating",
  activeTools: [],
  startedAt: 1_000,
  cleanupWarnings: [],
  generation: "g1",
  revision: 1,
};

function run(overrides: Partial<SubagentRunProjection> = {}): SubagentRunProjection {
  return { ...BASE_RUN, ...overrides };
}

function state(
  runs: readonly SubagentRunView[] = [],
  overrides: Partial<SubagentRunsState> = {},
): SubagentRunsState {
  return {
    generation: "g1",
    revision: runs.reduce((max, item) => Math.max(max, item.revision), 0),
    runs: new Map<string, SubagentRunView>(runs.map((item) => [item.runId, item])),
    connection: "live",
    ...overrides,
  };
}

function runEvent(item: SubagentRunProjection): SubagentRunsAction {
  return { type: "event", event: { event: "subagent/run", run: item } };
}

function removeEvent(runId: string, generation: string, revision: number): SubagentRunsAction {
  return {
    type: "event",
    event: { event: "subagent/run-remove", runId, parentSessionId: "parent-a", generation, revision },
  };
}

function snapshot(
  generation: string,
  revision: number,
  runs: readonly SubagentRunProjection[],
  at?: number,
): SubagentRunsAction {
  const action: Extract<SubagentRunsAction, { type: "snapshot" }> = {
    type: "snapshot",
    snapshot: { generation, revision, runs: [...runs] },
  };
  return at === undefined ? action : { ...action, at };
}

test("active means non-terminal and not stale; stopping is still active", () => {
  assert.deepEqual([...TERMINAL_RUN_PHASES].sort(), ["completed", "failed", "stopped"]);
  assert.equal(isSubagentRunActive(run()), true);
  assert.equal(isSubagentRunActive(run({ phase: "starting" })), true);
  assert.equal(isSubagentRunActive(run({ phase: "stopping" })), true);
  assert.equal(isSubagentRunActive(run({ phase: "completed" })), false);
  assert.equal(isSubagentRunActive(run({ phase: "failed" })), false);
  assert.equal(isSubagentRunActive(run({ phase: "stopped" })), false);
  assert.equal(isSubagentRunActive({ ...run(), stale: true }), false);
});

test("an older same-generation snapshot does not roll back a newer websocket event", () => {
  const before = state([run({ runId: "a", phase: "tool", revision: 9 })], { revision: 9 });
  const next = reduceSubagentRuns(
    before,
    snapshot("g1", 8, [run({ runId: "a", phase: "generating", revision: 7 })]),
  );
  assert.equal(next.generation, "g1");
  assert.equal(next.revision, 9, "the highest revision seen wins");
  assert.equal(next.runs.get("a")?.phase, "tool");
  assert.equal(next.runs.get("a")?.revision, 9);
  assert.notEqual(next.runs, before.runs);
  assert.equal(before.runs.get("a")?.phase, "tool", "the input run object is not mutated");

  const tie = reduceSubagentRuns(
    state([run({ runId: "a", revision: 10, lastActivity: 1_200 })], { revision: 10 }),
    snapshot("g1", 10, [run({ runId: "a", revision: 10, phase: "reasoning", lastActivity: 1_500 })]),
  );
  assert.equal(tie.runs.get("a")?.phase, "reasoning", "at equal revision the snapshot wins");
});

test("a snapshot keeps later runs and drops terminal history the host already pruned", () => {
  const before = state(
    [
      run({ runId: "pruned", phase: "completed", revision: 4, endedAt: 1_400 }),
      run({ runId: "fresh-active", revision: 11 }),
      run({ runId: "fresh-done", phase: "completed", revision: 12, endedAt: 1_600 }),
    ],
    { revision: 12 },
  );
  const next = reduceSubagentRuns(before, snapshot("g1", 10, [run({ runId: "live", revision: 6 })]));
  assert.equal(next.runs.has("pruned"), false, "absent terminal history at or below the snapshot revision is gone");
  assert.equal(next.runs.has("fresh-active"), true, "a run created after the snapshot was captured survives");
  assert.equal(next.runs.has("fresh-done"), true, "a finished run newer than the snapshot was not in it yet");
  assert.equal(next.runs.has("live"), true);
});

test("a snapshot keeps active runs and stopping runs it does not know about", () => {
  const before = state([
    run({ runId: "active", revision: 3 }),
    run({ runId: "stopping", phase: "stopping", revision: 4, stopRequestedAt: 1_200 }),
  ]);
  const next = reduceSubagentRuns(before, snapshot("g1", 10, [run({ runId: "other", revision: 5 })]));
  assert.equal(next.runs.has("active"), true);
  assert.equal(next.runs.has("stopping"), true);
});

test("a snapshot for one parent never reconciles the history of another tab", () => {
  const before = state([
    run({ runId: "a-done", parentSessionId: "parent-a", phase: "completed", revision: 3, endedAt: 1_300 }),
    run({
      runId: "b-old",
      parentSessionId: "parent-b",
      generation: "g0",
      phase: "completed",
      revision: 2,
      endedAt: 1_200,
    }),
    run({ runId: "b-done", parentSessionId: "parent-b", phase: "completed", revision: 4, endedAt: 1_400 }),
  ]);
  const next = reduceSubagentRuns(
    before,
    snapshot("g1", 10, [run({ runId: "b-live", parentSessionId: "parent-b", revision: 6 })]),
  );
  assert.equal(next.runs.has("a-done"), true, "parent-a history is untouched by a parent-b snapshot");
  assert.equal(next.runs.has("b-old"), true, "history from another generation is untouched by a same-generation snapshot");
  assert.equal(next.runs.has("b-done"), false);
  assert.equal(next.runs.has("b-live"), true);
});

test("an empty snapshot cannot be attributed to a parent and deletes nothing", () => {
  const before = state([
    run({ runId: "done", phase: "completed", revision: 3, endedAt: 1_300 }),
    run({ runId: "active", revision: 4 }),
  ]);
  const next = reduceSubagentRuns(before, snapshot("g1", 10, []));
  assert.equal(next.runs.size, 2);
  assert.equal(next.connection, "live");
  assert.equal(next.frozenAt, undefined);
});

test("a new generation marks old non-terminal runs stale and keeps terminal history", () => {
  const before = state(
    [
      run({ runId: "old-active", revision: 3 }),
      run({ runId: "old-terminal", phase: "completed", revision: 2, endedAt: 1_200 }),
    ],
    { revision: 5 },
  );
  const next = reduceSubagentRuns(before, snapshot("g2", 8, [], 1_700));
  assert.equal(next.generation, "g2");
  assert.equal(next.revision, 8, "a new generation replaces the revision sequence");
  assert.equal(next.runs.get("old-active")?.stale, true);
  assert.equal(next.runs.get("old-active")?.staleAt, 1_700);
  assert.equal(next.runs.get("old-active")?.phase, "generating", "stale is not a new terminal phase");
  assert.equal(isSubagentRunActive(next.runs.get("old-active")!), false, "a stale card is never active");
  assert.equal(next.runs.get("old-terminal")?.stale, false);
  assert.equal(next.runs.get("old-terminal")?.phase, "completed");
});

test("a new generation inserts its snapshot runs and leaves old history in place", () => {
  const before = state([
    run({ runId: "old-terminal", phase: "completed", revision: 2, endedAt: 1_200 }),
    run({ runId: "old-active", revision: 3 }),
  ]);
  const next = reduceSubagentRuns(
    before,
    snapshot("g2", 8, [run({ runId: "fresh", generation: "g2", revision: 8 })]),
  );
  assert.equal(next.runs.get("fresh")?.stale, undefined);
  assert.equal(isSubagentRunActive(next.runs.get("fresh")!), true);
  assert.equal(next.runs.has("old-terminal"), true, "old terminal history is not deleted by reconciliation");
});

test("a stale timestamp defaults to the client clock when the action carries none", () => {
  const before = state([run({ runId: "a", revision: 3 })]);
  const next = reduceSubagentRuns(before, snapshot("g2", 8, []));
  assert.equal(typeof next.runs.get("a")?.staleAt, "number");
});

test("a second host generation keeps the first invalidation timestamp", () => {
  const first = reduceSubagentRuns(state([run({ runId: "a", revision: 3 })]), snapshot("g2", 8, [], 1_000));
  const second = reduceSubagentRuns(first, snapshot("g3", 12, [], 2_000));
  assert.equal(second.generation, "g3");
  assert.equal(second.runs.get("a")?.stale, true);
  assert.equal(second.runs.get("a")?.staleAt, 1_000, "the frozen time does not jump on a later restart");
});

test("a same-generation snapshot preserves client-only fields instead of crashing", () => {
  const before = state([{ ...run({ runId: "a", revision: 2 }), stale: true, staleAt: 77 }], { revision: 5 });
  const next = reduceSubagentRuns(
    before,
    snapshot("g1", 6, [run({ runId: "a", revision: 6, phase: "tool" })]),
  );
  assert.equal(next.runs.get("a")?.phase, "tool");
  assert.equal(next.runs.get("a")?.revision, 6);
  assert.equal(next.runs.get("a")?.stale, true);
  assert.equal(next.runs.get("a")?.staleAt, 77);
});

test("a normal same-generation snapshot leaves runs without stale markers", () => {
  const before = state([run({ runId: "a", revision: 2 })]);
  const next = reduceSubagentRuns(
    before,
    snapshot("g1", 6, [run({ runId: "a", revision: 6, phase: "reasoning" })]),
  );
  assert.equal(next.runs.get("a")?.stale, undefined);
  assert.equal(next.runs.get("a")?.staleAt, undefined);
});

test("a run event adopts the generation when none is established and merges by revision", () => {
  const empty: SubagentRunsState = { revision: 0, runs: new Map(), connection: "live" };
  const first = reduceSubagentRuns(empty, runEvent(run({ runId: "a", revision: 5 })));
  assert.equal(first.generation, "g1");
  assert.equal(first.revision, 5);

  const newer = reduceSubagentRuns(first, runEvent(run({ runId: "a", revision: 9, phase: "tool" })));
  assert.equal(newer.runs.get("a")?.phase, "tool");

  const older = reduceSubagentRuns(newer, runEvent(run({ runId: "a", revision: 7, phase: "reasoning" })));
  assert.equal(older.runs.get("a")?.phase, "tool", "a late event cannot roll the card back");
  assert.equal(older, newer, "an event that cannot advance a run is a no-op");

  const duplicate = reduceSubagentRuns(newer, runEvent(run({ runId: "a", revision: 9, phase: "tool" })));
  assert.equal(duplicate, newer, "an event with the same revision is a no-op");
});

test("generation changes are established by snapshots, not by run events", () => {
  const before = state([run({ runId: "old", revision: 3 })]);
  const early = reduceSubagentRuns(
    before,
    runEvent(run({ runId: "new", generation: "g2", revision: 9 })),
  );
  assert.equal(early, before, "an event from another generation cannot mix registries");

  const switched = reduceSubagentRuns(before, snapshot("g2", 8, []));
  const late = reduceSubagentRuns(
    switched,
    runEvent(run({ runId: "old", generation: "g1", revision: 99, phase: "completed", endedAt: 2_000 })),
  );
  assert.equal(late, switched, "a late old-generation frame cannot revive a stale card");
});

test("a stale run is display-only: no event makes it live or terminal again", () => {
  const stale: SubagentRunView = { ...run({ runId: "a", revision: 4 }), stale: true, staleAt: 100 };
  const before = state([], { runs: new Map([["a", stale]]) });
  assert.equal(
    reduceSubagentRuns(before, runEvent(run({ runId: "a", revision: 5, phase: "tool" }))),
    before,
  );
  assert.equal(
    reduceSubagentRuns(
      before,
      runEvent(run({ runId: "a", revision: 5, phase: "completed", endedAt: 2_000 })),
    ),
    before,
  );
});

test("a completed run is never revived by a higher-revision live projection", () => {
  const done = run({ runId: "a", phase: "completed", revision: 5, endedAt: 2_000 });
  const before = state([done], { revision: 5 });
  const next = reduceSubagentRuns(
    before,
    runEvent(run({ runId: "a", revision: 25, phase: "reasoning", activeTools: [] })),
  );
  assert.equal(next, before, "a live frame after the terminal phase is a no-op");
  assert.equal(next.runs.get("a"), done, "the stored run object is untouched");
  assert.equal(next.runs.get("a")?.phase, "completed");
  assert.equal(next.runs.get("a")?.revision, 5, "the ignored frame cannot advance the run revision");
  assert.equal(next.revision, 5, "the ignored frame cannot advance the state revision");
});

test("failed and stopped runs ignore non-terminal projections at any revision", () => {
  for (const phase of ["failed", "stopped"] as const) {
    const terminal = run({
      runId: "a",
      phase,
      revision: 5,
      endedAt: 2_000,
      ...(phase === "failed" ? { stopReason: "error" as SubagentStopReason } : {}),
    });
    const before = state([terminal], { revision: 5 });
    const next = reduceSubagentRuns(
      before,
      runEvent(
        run({
          runId: "a",
          revision: 30,
          phase: "tool",
          activeTools: [tool("t1", "read_file", 2_100)],
        }),
      ),
    );
    assert.equal(next, before, phase);
    assert.equal(next.runs.get("a"), terminal, phase);
    assert.equal(next.runs.get("a")?.phase, phase);
    assert.equal(next.runs.get("a")?.endedAt, 2_000, phase);
  }
});

test("a terminal run accepts a later terminal projection carrying a cleanup warning", () => {
  const done = run({ runId: "a", phase: "completed", revision: 5, endedAt: 2_000 });
  const before = state([done], { revision: 5 });
  const warning = { code: "cleanup-failed", severity: "error" as const };
  const next = reduceSubagentRuns(
    before,
    runEvent(
      run({ runId: "a", phase: "completed", revision: 9, endedAt: 2_000, cleanupWarnings: [warning] }),
    ),
  );
  assert.notEqual(next, before, "terminal-to-terminal updates still merge");
  assert.equal(next.runs.get("a")?.phase, "completed");
  assert.equal(next.runs.get("a")?.revision, 9);
  assert.equal(next.revision, 9);
  assert.deepEqual(next.runs.get("a")?.cleanupWarnings, [warning]);
  assert.deepEqual(subagentAlerts(next.runs.get("a")!, 10_000), [{
    code: "cleanup-failed",
    severity: "error",
    text: "清理失败",
  }]);
});

test("a stopping run ignores a higher-revision reasoning projection", () => {
  const tools = [tool("t1", "read_file", 1_100)];
  const stopping = run({
    runId: "a",
    phase: "stopping",
    revision: 5,
    stopRequestedAt: 1_200,
    stopReason: "aborted",
    stopCause: "targeted-cancel",
    lastActivity: 1_150,
    activeTools: tools,
  });
  const before = state([stopping], { revision: 5 });
  const next = reduceSubagentRuns(
    before,
    runEvent(
      run({ runId: "a", revision: 25, phase: "reasoning", activeTools: [], lastActivity: 9_000 }),
    ),
  );
  assert.equal(next, before, "a live frame cannot regress a stopping run to reasoning");
  assert.equal(next.runs.get("a"), stopping, "the stored run object is untouched");
  const stored = next.runs.get("a");
  assert.ok(stored);
  assert.equal(stored.phase, "stopping");
  assert.deepEqual(stored.activeTools, tools, "active tools stay at the stopping snapshot");
  assert.equal(stored.stopReason, "aborted");
  assert.equal(stored.stopCause, "targeted-cancel");
  assert.equal(stored.stopRequestedAt, 1_200);
  assert.equal(stored.lastActivity, 1_150, "the ignored frame cannot refresh the activity time");
  assert.equal(stored.revision, 5, "the ignored frame cannot advance the run revision");
  assert.equal(next.revision, 5, "the ignored frame cannot advance the state revision");
});

test("a stopping run ignores a higher-revision tool projection", () => {
  const stopping = run({ runId: "a", phase: "stopping", revision: 5, stopRequestedAt: 1_200 });
  const before = state([stopping], { revision: 5 });
  const next = reduceSubagentRuns(
    before,
    runEvent(
      run({ runId: "a", revision: 25, phase: "tool", activeTools: [tool("t1", "grep", 3_000)] }),
    ),
  );
  assert.equal(next, before, "a tool frame cannot restart a stopping card");
  assert.equal(next.runs.get("a")?.phase, "stopping");
  assert.deepEqual(next.runs.get("a")?.activeTools, []);
  assert.equal(next.runs.get("a")?.revision, 5);
});

test("a stopping run still accepts a higher-revision terminal projection", () => {
  const stopping = run({ runId: "a", phase: "stopping", revision: 5, stopRequestedAt: 1_200 });
  const before = state([stopping], { revision: 5 });
  const next = reduceSubagentRuns(
    before,
    runEvent(run({ runId: "a", phase: "stopped", revision: 25, stopRequestedAt: 1_200, endedAt: 3_000 })),
  );
  assert.notEqual(next, before, "stopping may still converge to a terminal phase");
  assert.equal(next.runs.get("a")?.phase, "stopped");
  assert.equal(next.runs.get("a")?.endedAt, 3_000);
  assert.equal(next.runs.get("a")?.revision, 25);
  assert.equal(next.revision, 25);
  assert.equal(isSubagentRunActive(next.runs.get("a")!), false);
});

test("a stopping run still merges a newer stopping projection", () => {
  const stopping = run({ runId: "a", phase: "stopping", revision: 5, stopRequestedAt: 1_200 });
  const before = state([stopping], { revision: 5 });
  const warning = { code: "runtime-stop-failed", severity: "error" as const };
  const next = reduceSubagentRuns(
    before,
    runEvent(
      run({ runId: "a", phase: "stopping", revision: 7, stopRequestedAt: 1_200, cleanupWarnings: [warning] }),
    ),
  );
  assert.notEqual(next, before, "stopping-to-stopping updates are not blocked");
  assert.equal(next.runs.get("a")?.phase, "stopping");
  assert.equal(next.runs.get("a")?.revision, 7);
  assert.deepEqual(next.runs.get("a")?.cleanupWarnings, [warning]);
});

test("a stale run ignores any later projection and keeps its stale view", () => {
  const stale: SubagentRunView = { ...run({ runId: "a", revision: 4 }), stale: true, staleAt: 100 };
  const before = state([], { runs: new Map([["a", stale]]), revision: 4 });
  const next = reduceSubagentRuns(
    before,
    runEvent(run({ runId: "a", revision: 99, phase: "reasoning", activeTools: [] })),
  );
  assert.equal(next, before);
  assert.equal(next.runs.get("a"), stale);
  assert.equal(next.runs.get("a")?.stale, true);
  assert.equal(next.runs.get("a")?.staleAt, 100);
  assert.equal(next.runs.get("a")?.phase, "generating", "the stale view keeps its original phase");
});

test("disconnect freezes once, events keep the freeze and only a snapshot clears it", () => {
  const before = state([run({ runId: "a", revision: 3 })]);
  const frozen = reduceSubagentRuns(before, { type: "disconnect", at: 5_000 });
  assert.equal(frozen.connection, "disconnected");
  assert.equal(frozen.frozenAt, 5_000);
  assert.equal(frozen.runs.get("a")?.phase, "generating");
  assert.notEqual(frozen.runs, before.runs);

  const repeated = reduceSubagentRuns(frozen, { type: "disconnect", at: 9_000 });
  assert.equal(repeated, frozen, "a repeated disconnect keeps the first freeze point");

  const bumped = reduceSubagentRuns(frozen, runEvent(run({ runId: "a", revision: 6, phase: "tool" })));
  assert.equal(bumped.connection, "disconnected");
  assert.equal(bumped.frozenAt, 5_000, "run events do not clear the freeze");
  assert.equal(bumped.runs.get("a")?.phase, "tool");

  const live = reduceSubagentRuns(
    frozen,
    snapshot("g1", 10, [run({ runId: "a", revision: 7 })]),
  );
  assert.equal(live.connection, "live");
  assert.equal(live.frozenAt, undefined, "a completed reconciliation clears the freeze");
  assert.equal(live.runs.get("a")?.revision, 7);
});

test("run-remove deletes only terminal history matching generation and revision", () => {
  const before = state([
    run({ runId: "done", phase: "completed", revision: 7, endedAt: 1_700 }),
    run({ runId: "newer", phase: "completed", revision: 9, endedAt: 1_800 }),
    run({ runId: "active", revision: 8 }),
    run({ runId: "stopping", phase: "stopping", revision: 8, stopRequestedAt: 1_500 }),
  ]);

  const removed = reduceSubagentRuns(before, removeEvent("done", "g1", 8));
  assert.equal(removed.runs.has("done"), false);
  assert.equal(removed.runs.size, 3);

  assert.equal(
    reduceSubagentRuns(before, removeEvent("newer", "g1", 8)),
    before,
    "a removal older than the run's revision is ignored",
  );
  assert.equal(
    reduceSubagentRuns(before, removeEvent("done", "g0", 8)),
    before,
    "a removal from another generation is ignored",
  );
  assert.equal(
    reduceSubagentRuns(before, removeEvent("active", "g1", 8)),
    before,
    "active runs are never removed",
  );
  assert.equal(
    reduceSubagentRuns(before, removeEvent("stopping", "g1", 8)),
    before,
    "stopping runs are still active",
  );
  assert.equal(reduceSubagentRuns(before, removeEvent("missing", "g1", 8)), before);
});

test("run-remove cannot delete a stale non-terminal card", () => {
  const before = state([
    run({ runId: "old-active", revision: 8 }),
    run({ runId: "old-terminal", phase: "completed", revision: 7, endedAt: 1_700 }),
  ]);
  const switched = reduceSubagentRuns(before, snapshot("g2", 20, []));
  assert.equal(
    reduceSubagentRuns(switched, removeEvent("old-active", "g1", 8)),
    switched,
    "history pruning never removes a non-terminal card",
  );
  const pruned = reduceSubagentRuns(switched, removeEvent("old-terminal", "g1", 7));
  assert.equal(pruned.runs.has("old-terminal"), false, "terminal history from the old generation is still removable");
});

test("expansion state never enters the run object", () => {
  const base = state([], { generation: undefined, revision: 0 });
  const next = reduceSubagentRuns(base, runEvent(run({ runId: "a", revision: 3 })));
  const stored = next.runs.get("a");
  assert.ok(stored);
  assert.equal("expanded" in stored, false);
  assert.deepEqual(Object.keys(stored).sort(), Object.keys(run()).sort());

  const switched = reduceSubagentRuns(next, snapshot("g2", 8, []));
  const stale = switched.runs.get("a");
  assert.ok(stale);
  assert.equal("expanded" in stale, false);
  assert.deepEqual(Object.keys(stale).sort(), [...Object.keys(run()), "stale", "staleAt"].sort());
});

test("terminal history is bounded to 20 per parent while active and stale cards stay", () => {
  const terminal = Array.from({ length: 25 }, (_, index) =>
    run({
      runId: `done-${index}`,
      phase: "completed",
      revision: index + 1,
      startedAt: 1_000 + index,
      endedAt: 2_000 + index,
    }),
  );
  const before = state(terminal, { revision: 25 });
  const next = reduceSubagentRuns(before, runEvent(run({ runId: "active", revision: 26 })));
  const remaining = [...next.runs.values()].filter((item) => item.phase === "completed");
  assert.equal(remaining.length, 20);
  assert.equal(next.runs.has("done-24"), true, "the newest history survives");
  assert.equal(next.runs.has("active"), true, "an active run is never pruned");

  const staleBefore = state(
    Array.from({ length: 25 }, (_, index) =>
      run({ runId: `stale-${index}`, revision: index + 1, startedAt: 1_000 + index }),
    ),
  );
  const staleNext = reduceSubagentRuns(staleBefore, snapshot("g2", 30, []));
  assert.equal(
    [...staleNext.runs.values()].filter((item) => item.stale === true).length,
    25,
    "stale cards are never pruned",
  );
  const manyActive = state(Array.from({ length: 30 }, (_, index) => run({ runId: `live-${index}` })));
  assert.equal(reduceSubagentRuns(manyActive, snapshot("g1", 40, [])).runs.size, 30);
});

test("terminal history is bounded to 200 globally", () => {
  const terminal = Array.from({ length: 205 }, (_, index) =>
    run({
      runId: `g-${index}`,
      parentSessionId: `parent-${index}`,
      phase: "completed",
      revision: index + 1,
      startedAt: 1_000 + index,
      endedAt: 2_000 + index,
    }),
  );
  const before = state(terminal, { revision: 205 });
  const next = reduceSubagentRuns(
    before,
    runEvent(
      run({
        runId: "extra",
        parentSessionId: "parent-extra",
        phase: "completed",
        revision: 206,
        endedAt: 9_999,
      }),
    ),
  );
  const remaining = [...next.runs.values()].filter((item) => item.phase === "completed");
  assert.equal(remaining.length, 200);
  assert.equal(next.runs.has("extra"), true);
  assert.equal(next.runs.has("g-204"), true);
});

test("the reducer never mutates its input state or the run objects inside it", () => {
  const original: SubagentRunView = run({ runId: "a", revision: 3 });
  const before = state([original], { revision: 3 });

  const switched = reduceSubagentRuns(before, snapshot("g2", 8, [], 1_000));
  assert.notEqual(switched, before);
  assert.notEqual(switched.runs, before.runs);
  assert.equal(before.runs.get("a"), original);
  assert.equal(original.stale, undefined, "marking stale copies the run instead of mutating it");
  assert.notEqual(switched.runs.get("a"), original);

  const updated = reduceSubagentRuns(before, runEvent(run({ runId: "a", revision: 4, phase: "tool" })));
  assert.notEqual(updated.runs, before.runs);
  assert.equal(before.runs.get("a"), original);
  assert.equal(original.phase, "generating");
  assert.equal(updated.runs.get("a")?.phase, "tool");
});

function tool(id: string, name: string, startedAt: number): SubagentToolActivity {
  return { id, name, startedAt };
}

test("status text maps every phase and failed stop reason to the fixed copy", () => {
  const phaseText: Array<[SubagentRunPhase, string]> = [
    ["starting", "启动中"],
    ["reasoning", "思考中"],
    ["generating", "生成中"],
    ["tool", "正在执行工具"],
    ["finalizing", "正在确认执行结果"],
    ["stopping", "停止中"],
    ["completed", "已完成"],
    ["stopped", "已停止"],
  ];
  for (const [phase, text] of phaseText) {
    assert.equal(subagentStatusText(run({ phase })), text, phase);
  }

  const failureText: Array<[SubagentStopReason | undefined, string]> = [
    ["error", "失败 · 执行出错"],
    ["max-tokens", "未完成 · 达到模型输出上限"],
    ["refusal", "未完成 · 子代理拒绝执行"],
    ["unknown", "失败 · 原因未知"],
    [undefined, "失败 · 原因未知"],
    ["aborted", "失败 · 原因未知"],
    ["completed", "失败 · 原因未知"],
    ["unrecognized" as SubagentStopReason, "失败 · 原因未知"],
  ];
  for (const [stopReason, text] of failureText) {
    const failed = stopReason === undefined
      ? run({ phase: "failed" })
      : run({ phase: "failed", stopReason });
    assert.equal(subagentStatusText(failed), text, String(stopReason));
  }

  assert.equal(
    subagentStatusText(run({ phase: "finalizing" })).includes("即将完成"),
    false,
    "finalizing never promises imminent completion",
  );
});

test("finalizing carries the idle detail and no other phase invents one", () => {
  assert.equal(subagentStatusDetail(run({ phase: "finalizing" })), "子代理已空闲，等待运行结果返回");
  const otherPhases: SubagentRunPhase[] = [
    "starting",
    "reasoning",
    "generating",
    "tool",
    "stopping",
    "completed",
    "failed",
    "stopped",
  ];
  for (const phase of otherPhases) {
    assert.equal(subagentStatusDetail(run({ phase })), undefined, phase);
  }
});

test("elapsed time freezes at the real end, the stale point, or the disconnect point", () => {
  const live = run({ startedAt: 1_000 });
  assert.equal(subagentElapsedMs(live, 61_000), 60_000);
  assert.equal(subagentElapsedMs(live, 500), 0, "a clock before the start clamps to zero");

  const ended = run({ startedAt: 1_000, endedAt: 31_000 });
  assert.equal(subagentElapsedMs(ended, 61_000), 30_000);
  assert.equal(ended.endedAt, 31_000, "the display freeze never rewrites the authoritative endedAt");
  assert.equal(subagentElapsedMs(ended, 20_000), 19_000, "a clock behind endedAt shows the elapsed window");

  assert.equal(subagentElapsedMs(live, 61_000, 21_000), 20_000, "a disconnect freezes the display");

  const stale: SubagentRunView = { ...run({ startedAt: 1_000 }), stale: true, staleAt: 16_000 };
  assert.equal(
    subagentElapsedMs(stale, 61_000, 21_000),
    15_000,
    "a stale card freezes at its own invalidation point",
  );
  const staleWithoutPoint: SubagentRunView = { ...run({ startedAt: 1_000 }), stale: true };
  assert.equal(
    subagentElapsedMs(staleWithoutPoint, 61_000, 21_000),
    20_000,
    "a stale card without staleAt falls back to the connection freeze",
  );

  const endedAndFrozen = run({ startedAt: 1_000, endedAt: 31_000 });
  assert.equal(subagentElapsedMs(endedAndFrozen, 61_000, 21_000), 20_000, "the earliest stop wins");

  const endedAndStale: SubagentRunView = {
    ...run({ startedAt: 1_000, endedAt: 31_000 }),
    stale: true,
    staleAt: 41_000,
  };
  assert.equal(
    subagentElapsedMs(endedAndStale, 61_000),
    30_000,
    "the earliest of now, endedAt, and staleAt wins",
  );
});

test("alerts prioritize cleanup failures over stop-wait, cleanup budget, and inactivity", () => {
  const busy = run({
    phase: "stopping",
    startedAt: 1_000,
    lastActivity: 1_000,
    stopRequestedAt: 1_000,
    cleanupBudgetMs: 5_000,
    cleanupWarnings: [
      { code: "activation-dispose-failed", severity: "error" },
      { code: "cleanup-budget-exceeded", severity: "info" },
      { code: "runtime-stop-failed", severity: "error" },
    ],
  });
  const alerts = subagentAlerts(busy, 400_000);
  assert.deepEqual(
    alerts.map((alert) => alert.code),
    ["activation-dispose-failed", "runtime-stop-failed", "stop-wait", "cleanup-budget", "inactive"],
  );
  assert.deepEqual(alerts[0], {
    code: "activation-dispose-failed",
    severity: "error",
    text: "子代理释放失败，清理未确认",
  });
  assert.deepEqual(alerts[2], {
    code: "stop-wait",
    severity: "info",
    text: "停止已受理超过 1 分钟，资源释放仍未确认；可离开此卡稍后查看，无需重复点击",
  });
  assert.deepEqual(alerts[3], {
    code: "cleanup-budget",
    severity: "info",
    text: "父会话空闲后等待收尾超过 5 秒，已开始强制释放",
  });
  assert.deepEqual(alerts[4], {
    code: "inactive",
    severity: "info",
    text: "已 6 分钟没有新活动",
  });
  assert.deepEqual(subagentAlert(busy, 400_000), alerts[0], "subagentAlert is the first prior alert");

  const stopOnly = run({ phase: "stopping", stopRequestedAt: 1_000 });
  assert.equal(subagentAlert(stopOnly, 62_000)?.code, "stop-wait");

  const budgetOnly = run({ phase: "stopping", cleanupBudgetMs: 5_000 });
  assert.equal(subagentAlert(budgetOnly, 10_000)?.code, "cleanup-budget");

  const idleOnly = run({ phase: "generating", lastActivity: 1_000 });
  assert.deepEqual(subagentAlert(idleOnly, 301_000), {
    code: "inactive",
    severity: "info",
    text: "已 5 分钟没有新活动",
  });
});

test("stop-wait starts strictly after 60 seconds of the host timestamp and does not restart on reconnect", () => {
  const stopping = run({ phase: "stopping", stopRequestedAt: 1_000 });
  assert.equal(subagentAlert(stopping, 61_000), undefined, "61s minus a 1s request is exactly 60s");
  assert.equal(subagentAlert(stopping, 62_000)?.code, "stop-wait");

  // A reconnect near the deadline must keep the alert visible; a client-side
  // restart of the 60s window would hide it again.
  assert.equal(subagentAlert(stopping, 105_000)?.code, "stop-wait");
  assert.deepEqual(subagentAlert({ ...stopping }, 105_000), subagentAlert(stopping, 105_000));
  assert.equal(subagentAlert({ ...stopping }, 61_000), undefined, "a snapshot cannot move the boundary");

  const recentStop = run({ phase: "stopping", stopRequestedAt: 50_000 });
  assert.equal(subagentAlert(recentStop, 62_000), undefined, "the host timestamp, not the client clock, starts the wait");

  const stoppingWithoutHostTime = run({ phase: "stopping", lastActivity: 1_000 });
  assert.equal(
    subagentAlerts(stoppingWithoutHostTime, 400_000).some((alert) => alert.code === "stop-wait"),
    false,
    "without stopRequestedAt there is no 60s reminder",
  );

  const completedWithStop = run({ phase: "completed", stopRequestedAt: 1_000, lastActivity: 1_000 });
  assert.equal(
    subagentAlerts(completedWithStop, 400_000).some((alert) => alert.code === "stop-wait"),
    false,
    "stop-wait is a stopping-phase reminder only",
  );
});

test("cleanup budget text is formatted from the host value and never invented", () => {
  assert.equal(
    subagentAlert(run({ phase: "stopping", cleanupBudgetMs: 5_000 }), 10_000)?.text,
    "父会话空闲后等待收尾超过 5 秒，已开始强制释放",
  );
  assert.equal(
    subagentAlert(run({ phase: "stopping", cleanupBudgetMs: 600_000 }), 10_000)?.text,
    "父会话空闲后等待收尾超过 10 分钟，已开始强制释放",
  );
  assert.deepEqual(subagentAlert(run({ phase: "stopping", stopCause: "cleanup-budget" }), 10_000), {
    code: "cleanup-budget",
    severity: "info",
    text: "等待收尾超时",
  }, "a missing budget number is not invented");

  const warningOnly = run({
    phase: "completed",
    cleanupWarnings: [{ code: "cleanup-budget-exceeded", severity: "info" }],
  });
  assert.deepEqual(subagentAlerts(warningOnly, 10_000), [{
    code: "cleanup-budget",
    severity: "info",
    text: "等待收尾超时",
  }]);

  const warningWithNumber = run({
    phase: "completed",
    cleanupBudgetMs: 600_000,
    cleanupWarnings: [{ code: "cleanup-budget-exceeded", severity: "info" }],
  });
  assert.deepEqual(subagentAlerts(warningWithNumber, 10_000), [{
    code: "cleanup-budget",
    severity: "info",
    text: "父会话空闲后等待收尾超过 10 分钟，已开始强制释放",
  }], "the budget warning renders once at budget priority, not as a cleanup failure");
});

test("cleanup warnings map by stable code, dedupe, keep unknown severity, and never rewrite the phase", () => {
  const known: Array<[string, string]> = [
    ["activation-dispose-failed", "子代理释放失败，清理未确认"],
    ["activation-dispose-timeout", "子代理释放超时，清理未确认"],
    ["runtime-stop-failed", "运行环境停止失败，清理未确认"],
    ["runtime-stop-timeout", "运行环境停止超时，清理未确认"],
    ["upstream-end-error", "上游结束状态与执行结果不一致"],
    ["cleanup-failed", "清理失败"],
  ];
  for (const [code, text] of known) {
    const completed = run({ phase: "completed", cleanupWarnings: [{ code, severity: "error" }] });
    assert.equal(subagentStatusText(completed), "已完成", `${code} does not turn completed into failed`);
    assert.deepEqual(subagentAlerts(completed, 10_000), [{ code, severity: "error", text }]);
  }

  const mixed = run({
    phase: "failed",
    stopReason: "error",
    cleanupWarnings: [
      { code: "cleanup-failed", severity: "error" },
      { code: "cleanup-failed", severity: "error" },
      { code: "unknown-code", severity: "info" },
    ],
  });
  const mixedAlerts = subagentAlerts(mixed, 10_000);
  assert.deepEqual(mixedAlerts.map((alert) => alert.code), ["cleanup-failed", "unknown-code"]);
  assert.deepEqual(mixedAlerts[1], {
    code: "unknown-code",
    severity: "info",
    text: "清理状态需要关注",
  });
  assert.equal(subagentStatusText(mixed), "失败 · 执行出错");

  const unknownError = run({
    phase: "completed",
    cleanupWarnings: [{ code: "unknown-code", severity: "error" }],
  });
  assert.equal(subagentAlerts(unknownError, 10_000)[0]?.severity, "error", "unknown codes keep the host severity");

  const knownSeverityMismatch = run({
    phase: "completed",
    cleanupWarnings: [{ code: "cleanup-failed", severity: "info" }],
  });
  assert.equal(
    subagentAlerts(knownSeverityMismatch, 10_000)[0]?.severity,
    "error",
    "known cleanup failure codes determine an error banner regardless of the payload severity",
  );

  const ordered = run({
    phase: "completed",
    cleanupWarnings: [
      { code: "runtime-stop-failed", severity: "error" },
      { code: "cleanup-failed", severity: "error" },
    ],
  });
  assert.deepEqual(
    subagentAlerts(ordered, 10_000).map((alert) => alert.code),
    ["runtime-stop-failed", "cleanup-failed"],
    "cleanup warnings keep their host order",
  );
});

test("inactivity is an active-phase reminder only", () => {
  const atStart = run({ phase: "generating", startedAt: 1_000 });
  assert.equal(subagentAlert(atStart, 300_999), undefined, "an idle window below five minutes stays quiet");
  assert.deepEqual(subagentAlert(atStart, 301_000), {
    code: "inactive",
    severity: "info",
    text: "已 5 分钟没有新活动",
  });

  const activeAgain = run({ phase: "generating", startedAt: 1_000, lastActivity: 295_000 });
  assert.equal(subagentAlert(activeAgain, 301_000), undefined, "new activity dismisses the reminder");

  const recentStart = run({ phase: "reasoning", lastActivity: 250_000 });
  assert.equal(subagentAlert(recentStart, 301_000), undefined);

  const terminalPhases: SubagentRunPhase[] = ["completed", "failed", "stopped"];
  for (const phase of terminalPhases) {
    const terminal = phase === "failed"
      ? run({ phase, stopReason: "error", lastActivity: 1_000 })
      : run({ phase, lastActivity: 1_000 });
    assert.equal(
      subagentAlerts(terminal, 600_000).some((alert) => alert.code === "inactive"),
      false,
      `${phase} never shows an inactivity reminder`,
    );
  }
});

test("tool summary sorts by start and internal id, shows two names, and appends the hidden count", () => {
  assert.deepEqual(subagentToolSummary([]), { visible: [], hiddenCount: 0, text: "" });

  const single = tool("t1", "read_file", 1_000);
  assert.deepEqual(subagentToolSummary([single]), { visible: [single], hiddenCount: 0, text: "read_file" });

  const alpha = tool("a", "read_file", 2_000);
  const beta = tool("b", "grep", 2_000);
  const early = tool("z", "think", 1_000);
  const late = tool("c", "write_file", 3_000);
  const tools = [beta, late, alpha, early];
  const summary = subagentToolSummary(tools);
  assert.deepEqual(summary.visible.map((item) => item.id), ["z", "a"], "startedAt first, then the internal id");
  assert.equal(summary.hiddenCount, 2);
  assert.equal(summary.text, "正在执行 4 个工具 · think、read_file +2");
  assert.deepEqual(tools.map((item) => item.id), ["b", "c", "a", "z"], "the input array is not reordered");

  assert.equal(subagentToolSummary([beta, alpha]).text, "正在执行 2 个工具 · read_file、grep");
  assert.equal(subagentToolSummary([late, beta, alpha]).text, "正在执行 3 个工具 · read_file、grep +1");
});

test("a start time is needed only when another run shares the label", () => {
  const target = run({ runId: "run-1", label: "@代码审查", startedAt: 1_000 });
  assert.equal(subagentNeedsStartTime(target, [target]), false, "a run is not its own duplicate");
  assert.equal(subagentNeedsStartTime(target, [{ ...target }]), false, "the same runId is not a duplicate");
  assert.equal(subagentNeedsStartTime(target, []), false);

  const terminalTwin = run({
    runId: "run-2",
    label: "@代码审查",
    phase: "completed",
    endedAt: 9_000,
  });
  assert.equal(subagentNeedsStartTime(target, [target, terminalTwin]), true, "terminal history still counts");

  const staleTwin: SubagentRunView = { ...run({ runId: "run-3", label: "@代码审查" }), stale: true, staleAt: 500 };
  assert.equal(subagentNeedsStartTime(target, [target, staleTwin]), true, "stale history still counts");

  assert.equal(
    subagentNeedsStartTime(target, [target, run({ runId: "run-4", label: "@其他" })]),
    false,
    "different labels need no start time",
  );
});

test("start time formatting is local 24-hour HH:MM:SS", () => {
  assert.equal(formatRunStartedAt(new Date(2026, 0, 2, 3, 4, 5).getTime()), "03:04:05");
  assert.equal(formatRunStartedAt(new Date(2026, 0, 2, 23, 59, 9).getTime()), "23:59:09");
  assert.equal(formatRunStartedAt(new Date(2026, 0, 2, 0, 0, 0).getTime()), "00:00:00");
});

test("cleanup budget formatting uses seconds under a minute and minutes from a minute", () => {
  assert.equal(formatCleanupBudget(600_000), "10 分钟");
  assert.equal(formatCleanupBudget(60_000), "1 分钟");
  assert.equal(formatCleanupBudget(90_000), "1.5 分钟");
  assert.equal(formatCleanupBudget(61_000), "1.02 分钟");
  assert.equal(formatCleanupBudget(5_000), "5 秒");
  assert.equal(formatCleanupBudget(1_000), "1 秒");
  assert.equal(formatCleanupBudget(500), "0.5 秒");
  assert.equal(formatCleanupBudget(0), "0 秒");
});

test("presentation helpers never read the ambient clock", () => {
  const spy = vi.spyOn(Date, "now").mockImplementation(() => {
    throw new Error("presentation helpers must not read Date.now");
  });
  try {
    const target = run({
      phase: "stopping",
      startedAt: 1_000,
      lastActivity: 1_000,
      stopRequestedAt: 1_000,
      cleanupBudgetMs: 5_000,
      cleanupWarnings: [{ code: "cleanup-failed", severity: "error" }],
    });
    subagentStatusText(target);
    subagentStatusDetail(target);
    subagentElapsedMs(target, 400_000);
    subagentElapsedMs({ ...target, stale: true, staleAt: 2_000 }, 400_000, 3_000);
    subagentAlerts(target, 400_000);
    subagentAlert(target, 400_000);
    subagentToolSummary([tool("t1", "read_file", 1_000), tool("t2", "grep", 2_000)]);
    subagentNeedsStartTime(target, [target, { ...target, runId: "run-2" }]);
    formatRunStartedAt(1_000);
    formatCleanupBudget(600_000);
    insertSubagentRunCard([{ id: 1, kind: "user" }], { runId: "run-1", clientMessageId: "1", allocateId: () => 2 });
    parentTurnLine({ hasActiveChild: true, current: { text: "正在思考", alert: false } });
  } finally {
    spy.mockRestore();
  }
});

test("a run card anchors after the user message named by clientMessageId in its own tab", () => {
  const firstTab = [{ id: 41, kind: "user" }];
  const secondTab = [{ id: 42, kind: "user" }];
  const anchored = insertSubagentRunCard(secondTab, { runId: "run-1", clientMessageId: "42", allocateId: () => 43 });
  assert.deepEqual(anchored.map((item) => item.kind), ["user", "subagent-run"]);
  assert.deepEqual(anchored[1], { id: 43, kind: "subagent-run", runId: "run-1" });
  assert.equal(
    insertSubagentRunCard(firstTab, { runId: "run-1", clientMessageId: "42", allocateId: () => 44 }),
    firstTab,
    "another tab's user message is never an anchor",
  );
  assert.deepEqual(
    insertSubagentRunCard(firstTab, { runId: "run-1", clientMessageId: "42", allowSnapshotFallback: true, allocateId: () => 44 }).map((item) => item.kind),
    ["user", "subagent-run"],
    "only the snapshot path falls back inside the same tab",
  );
  assert.equal(
    insertSubagentRunCard(anchored, { runId: "run-1", clientMessageId: "42", allocateId: () => 45 }),
    anchored,
    "a duplicate upsert keeps the same array",
  );
});

test("the snapshot fallback anchors after the last user message and is opt-in", () => {
  const tab = [
    { id: 1, kind: "user" },
    { id: 2, kind: "assistant" },
    { id: 3, kind: "user" },
    { id: 4, kind: "note" },
  ];
  assert.equal(
    insertSubagentRunCard(tab, { runId: "run-1", clientMessageId: "missing", allocateId: () => 5 }),
    tab,
    "a live event never guesses an anchor",
  );
  const anchored = insertSubagentRunCard(tab, {
    runId: "run-1",
    clientMessageId: "missing",
    allowSnapshotFallback: true,
    allocateId: () => 5,
  });
  assert.deepEqual(anchored.map((item) => item.id), [1, 2, 3, 5, 4]);

  const empty: Array<{ id: number; kind: string }> = [];
  assert.equal(
    insertSubagentRunCard(empty, { runId: "run-1", clientMessageId: "1", allowSnapshotFallback: true, allocateId: () => 2 }),
    empty,
    "a tab without a user message cannot anchor a card",
  );
  assert.deepEqual(
    insertSubagentRunCard([], { runId: "run-1", allowSnapshotFallback: true, allocateId: () => 2 }),
    [],
  );
});

test("a matched anchor inserts directly after that message and keeps later items in order", () => {
  const tab = [
    { id: 1, kind: "user" },
    { id: 2, kind: "assistant" },
    { id: 3, kind: "user" },
    { id: 4, kind: "assistant" },
  ];
  const anchored = insertSubagentRunCard(tab, { runId: "run-1", clientMessageId: "1", allocateId: () => 9 });
  assert.deepEqual(anchored.map((item) => item.id), [1, 9, 2, 3, 4]);
  assert.deepEqual(anchored.map((item) => item.kind), ["user", "subagent-run", "assistant", "user", "assistant"]);
});

test("the parent line summarizes an active child run and otherwise keeps the turn status", () => {
  assert.deepEqual(
    parentTurnLine({ hasActiveChild: true, current: { text: "已 12 秒没有新结果", alert: true } }),
    { text: "主会话运行中", alert: false },
  );
  const current = { text: "正在执行工具 read_file", alert: true };
  assert.equal(parentTurnLine({ hasActiveChild: false, current }), current);
});
