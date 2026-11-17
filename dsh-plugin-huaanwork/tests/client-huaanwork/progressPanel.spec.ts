import { describe, expect, it } from "vitest";

import {
  selectProgressPanelModel,
  type ProgressPanelInput,
} from "../../src/client-huaanwork/logic/progressPanel.ts";
import type { SubagentRunView } from "../../src/client-huaanwork/logic/subagentRuns.ts";
import { projectToolPanels } from "../../src/client-huaanwork/logic/toolPanel.ts";

function run(overrides: Partial<SubagentRunView> & { runId: string }): SubagentRunView {
  return {
    parentSessionId: "session-1",
    clientMessageId: "message-1",
    kind: "legacy",
    label: "@审阅",
    phase: "tool",
    activeTools: [],
    startedAt: 1_000,
    cleanupWarnings: [],
    generation: "gen-1",
    revision: 1,
    ...overrides,
  };
}

function baseInput(overrides: Partial<ProgressPanelInput> = {}): ProgressPanelInput {
  return {
    sessionId: "session-1",
    items: [
      { kind: "user", id: 1, clientMessageId: "message-1" },
      {
        kind: "todo",
        id: 2,
        clientMessageId: "message-1",
        roundKey: 5,
        todos: [
          { content: "一", status: "completed" },
          { content: "二", status: "in_progress" },
          { content: "三", status: "pending" },
        ],
      },
    ],
    toolRows: [],
    currentTurnClientMessageId: "message-1",
    turnFinal: false,
    subagents: [],
    sidecarDead: false,
    ready: true,
    sawReady: true,
    subagentConnection: "live",
    ...overrides,
  };
}

describe("selectProgressPanelModel tasks", () => {
  it("projects counts without inventing per-task percentages", () => {
    const model = selectProgressPanelModel(baseInput());
    expect(model.completedCount).toBe(1);
    expect(model.totalCount).toBe(3);
    expect(model.tasks.map((task) => task.displayStatus)).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
    expect(model.tasks.map((task) => task.sourceStatus)).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
    expect(model).not.toHaveProperty("percentage");
    expect(model.taskPhase).toBe("ready");
  });

  it("overlays interruption without rewriting the source todo", () => {
    const input = baseInput({ turnFinal: true });
    const model = selectProgressPanelModel(input);
    expect(model.tasks.map((task) => task.displayStatus)).toEqual([
      "completed",
      "interrupted",
      "pending",
    ]);
    const todo = input.items[1];
    expect(todo?.kind === "todo" ? (todo.todos ?? []).map((entry) => entry.status) : []).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
  });

  it("keeps every in-progress item and overlays all of them after the turn ends", () => {
    const items = [
      { kind: "user" as const, id: 1, clientMessageId: "m1" },
      {
        kind: "todo" as const,
        id: 2,
        clientMessageId: "m1",
        roundKey: 1,
        todos: [
          { content: "甲", status: "in_progress" as const },
          { content: "乙", status: "in_progress" as const },
          { content: "丙", status: "completed" as const },
        ],
      },
    ];
    expect(selectProgressPanelModel(baseInput({ items })).tasks.map((task) => task.displayStatus)).toEqual([
      "in_progress",
      "in_progress",
      "completed",
    ]);
    expect(
      selectProgressPanelModel(baseInput({ items, turnFinal: true })).tasks.map(
        (task) => task.displayStatus,
      ),
    ).toEqual(["interrupted", "interrupted", "completed"]);
  });

  it("reads only the last todo snapshot of the current turn", () => {
    const items = [
      { kind: "user" as const, id: 1, clientMessageId: "m1" },
      {
        kind: "todo" as const,
        id: 2,
        clientMessageId: "m1",
        roundKey: 2,
        todos: [{ content: "旧快照", status: "pending" as const }],
      },
      {
        kind: "todo" as const,
        id: 3,
        clientMessageId: "m1",
        roundKey: 4,
        todos: [
          { content: "新一", status: "completed" as const },
          { content: "新二", status: "pending" as const },
        ],
      },
    ];
    const model = selectProgressPanelModel(baseInput({ items }));
    expect(model.tasks.map((task) => task.content)).toEqual(["新一", "新二"]);
    expect(model.completedCount).toBe(1);
    expect(model.totalCount).toBe(2);
  });

  it("does not let a previous turn's todo snapshot leak into the current turn", () => {
    const items = [
      { kind: "user" as const, id: 1, clientMessageId: "m1" },
      {
        kind: "todo" as const,
        id: 2,
        clientMessageId: "m1",
        roundKey: 2,
        todos: [{ content: "上一回合", status: "in_progress" as const }],
      },
      { kind: "user" as const, id: 3, clientMessageId: "m2" },
    ];
    const model = selectProgressPanelModel(
      baseInput({ items, currentTurnClientMessageId: "m2", turnFinal: false }),
    );
    expect(model.taskPhase).toBe("waiting");
    expect(model.tasks).toEqual([]);
    expect(model.completedCount).toBe(0);
    expect(model.totalCount).toBe(0);
  });

  it("accepts a valid empty todo snapshot as a ready turn", () => {
    const items = [
      { kind: "user" as const, id: 1, clientMessageId: "m1" },
      { kind: "todo" as const, id: 2, clientMessageId: "m1", roundKey: 1, todos: [] },
    ];
    const model = selectProgressPanelModel(baseInput({ items }));
    expect(model.taskPhase).toBe("ready");
    expect(model.tasks).toEqual([]);
    expect(model.completedCount).toBe(0);
    expect(model.totalCount).toBe(0);
  });
});

describe("selectProgressPanelModel task phase", () => {
  it("reports an empty phase for an empty session and a finalized turn without todos", () => {
    expect(selectProgressPanelModel(baseInput({ items: [], turnFinal: false })).taskPhase).toBe("empty");
    const items = [{ kind: "user" as const, id: 1, clientMessageId: "m1" }];
    expect(selectProgressPanelModel(baseInput({ items, turnFinal: true })).taskPhase).toBe("empty");
  });

  it("reports waiting only for a started, unfinalized turn without a todo snapshot", () => {
    const items = [{ kind: "user" as const, id: 1, clientMessageId: "m1" }];
    const model = selectProgressPanelModel(baseInput({ items, turnFinal: false }));
    expect(model.taskPhase).toBe("waiting");
    expect(model.completedCount).toBe(0);
    expect(model.totalCount).toBe(0);
    expect(model).not.toHaveProperty("percentage");
  });
});

describe("selectProgressPanelModel activity", () => {
  it("keeps only tool panels whose items belong to the current turn", () => {
    const items = [
      { kind: "user" as const, id: 1, clientMessageId: "m1" },
      {
        kind: "tool" as const,
        id: 2,
        card: { key: "old", name: "read_file", status: "start" as const, roundKey: 1 },
      },
      { kind: "assistant" as const, id: 3, text: "第一回合完成", roundKey: 1 },
      { kind: "user" as const, id: 4, clientMessageId: "m2" },
      {
        kind: "tool" as const,
        id: 5,
        card: { key: "new", name: "write_file", status: "start" as const, roundKey: 2 },
      },
    ];
    const toolRows = projectToolPanels(items, {
      contentItems: items,
      turnFinalByUserId: { 1: true },
      connectionLost: false,
    });
    const model = selectProgressPanelModel(
      baseInput({ items, toolRows, currentTurnClientMessageId: "m2", turnFinal: false }),
    );
    expect(model.activity).toHaveLength(1);
    expect(model.activity[0]?.anchorId).toBe(5);
    expect(model.activity[0]?.tools.map((tool) => tool.name)).toEqual(["write_file"]);
  });

  it("preserves the caller's turnFinal folding for the current turn panels", () => {
    const items = [
      { kind: "user" as const, id: 1, clientMessageId: "m1" },
      {
        kind: "tool" as const,
        id: 2,
        card: { key: "t", name: "read_file", status: "start" as const, roundKey: 1 },
      },
    ];
    const toolRows = projectToolPanels(items, {
      contentItems: items,
      turnFinalByUserId: { 1: true },
      connectionLost: false,
    });
    const model = selectProgressPanelModel(baseInput({ items, toolRows, turnFinal: true }));
    expect(model.activity).toHaveLength(1);
    // 回合已终结时 projectToolPanels 本来会折叠该面板；选择器必须沿用，不能重新按
    // “未终结”计算而把旧回合工具展开进右栏。
    expect(model.activity[0]?.expanded).toBe(false);
  });

  it("has no activity outside the current turn", () => {
    const items = [
      { kind: "user" as const, id: 1, clientMessageId: "m1" },
      {
        kind: "tool" as const,
        id: 2,
        card: { key: "t", name: "read_file", status: "start" as const, roundKey: 1 },
      },
      { kind: "user" as const, id: 3, clientMessageId: "m2" },
    ];
    const toolRows = projectToolPanels(items, {
      contentItems: items,
      turnFinalByUserId: { 1: true },
      connectionLost: false,
    });
    const model = selectProgressPanelModel(
      baseInput({ items, toolRows, currentTurnClientMessageId: "m2", turnFinal: false }),
    );
    expect(model.activity).toEqual([]);
  });
});

describe("selectProgressPanelModel subagents", () => {
  it("keeps all active runs and only current-turn anchored inactive runs", () => {
    const model = selectProgressPanelModel(
      baseInput({
        subagents: [
          run({ runId: "active-old-turn", clientMessageId: "m0" }),
          run({ runId: "terminal-current", phase: "completed", endedAt: 2_000 }),
          run({ runId: "terminal-old-turn", clientMessageId: "m0", phase: "completed", endedAt: 2_000 }),
          run({ runId: "terminal-unanchored", clientMessageId: undefined, phase: "completed", endedAt: 2_000 }),
        ],
      }),
    );
    expect(model.subagents.map((entry) => entry.runId)).toEqual([
      "active-old-turn",
      "terminal-current",
    ]);
  });

  it("fails closed for terminal runs when the current turn has no authoritative anchor", () => {
    const model = selectProgressPanelModel(
      baseInput({
        currentTurnClientMessageId: undefined,
        subagents: [
          run({ runId: "terminal-anchored", phase: "completed", endedAt: 2_000 }),
          run({ runId: "active-unanchored", clientMessageId: undefined }),
        ],
      }),
    );
    expect(model.subagents.map((entry) => entry.runId)).toEqual(["active-unanchored"]);
  });

  it("never borrows runs from another parent session", () => {
    const model = selectProgressPanelModel(
      baseInput({
        subagents: [
          run({ runId: "own-active" }),
          run({ runId: "other-active", parentSessionId: "session-2" }),
          run({ runId: "other-terminal", parentSessionId: "session-2", phase: "completed", endedAt: 2_000 }),
        ],
      }),
    );
    expect(model.subagents.map((entry) => entry.runId)).toEqual(["own-active"]);
  });

  it("does not invent an independent package lane row", () => {
    const packageRun = run({
      runId: "package-run",
      kind: "package",
      label: "@slug",
      packageVersion: "1.0.0",
      depth: 2,
    });
    const model = selectProgressPanelModel(baseInput({ subagents: [packageRun] }));
    expect(model.subagents).toEqual([packageRun]);
  });
});

describe("selectProgressPanelModel connection", () => {
  it("reports disconnected when the sidecar is dead", () => {
    const model = selectProgressPanelModel(
      baseInput({ sidecarDead: true, ready: false, sawReady: true, subagentConnection: "disconnected" }),
    );
    expect(model.connection).toBe("disconnected");
  });

  it("reports reconnecting after a lost ready state or a disconnected run snapshot", () => {
    expect(
      selectProgressPanelModel(baseInput({ ready: false, sawReady: true })).connection,
    ).toBe("reconnecting");
    expect(
      selectProgressPanelModel(baseInput({ ready: true, subagentConnection: "disconnected" })).connection,
    ).toBe("reconnecting");
  });

  it("stays live for the initial boot and a ready connection", () => {
    expect(
      selectProgressPanelModel(baseInput({ ready: false, sawReady: false })).connection,
    ).toBe("live");
    expect(
      selectProgressPanelModel(baseInput({ ready: true, subagentConnection: "live" })).connection,
    ).toBe("live");
  });
});
