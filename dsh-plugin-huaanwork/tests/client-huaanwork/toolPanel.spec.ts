import assert from "node:assert/strict";
import { test } from "vitest";
import {
  applyToolEnd,
  applyTurnFinalToTabs,
  historicalTurnFinalByUserId,
  projectToolPanels,
  reduceTurnFinal,
  toolDescription,
  toolEntryStatus,
  withToolPanelToggle,
  type ToolPanelCard,
  type ToolPanelItem,
  type ToolPanelRow,
  type ToolPanelView,
  type TurnFinalEvent,
} from "../../src/client-huaanwork/logic/toolPanel.ts";
import {
  GOAL_ROUND_LIMIT,
  INITIAL_GOAL_TURN_STATE,
  reduceGoalTurn,
  type GoalTurnEvent,
  type GoalTurnState,
} from "../../src/client-huaanwork/logic/goalRound.ts";
import { attachmentAsAssistant } from "../../src/client-huaanwork/logic/runResultAttachments.ts";

function tool(id: number, name: string, callId?: string): ToolPanelItem {
  return {
    id,
    kind: "tool",
    card: { key: callId ?? `key-${id}`, name, ...(callId ? { callId } : {}), status: "start" },
  };
}

function cardAt(items: readonly ToolPanelItem[], index: number): ToolPanelCard {
  const item = items[index];
  if (item?.kind !== "tool") throw new Error(`expected tool at ${index}`);
  return item.card;
}

const content = (items: readonly ToolPanelItem[]): readonly { id: number; kind: string; text?: string }[] => items;

function panelAt(rows: readonly ToolPanelRow<ToolPanelItem>[], index: number): ToolPanelView {
  const row = rows[index];
  if (row?.kind !== "panel") throw new Error(`expected panel at ${index}`);
  return row.panel;
}

test("same-name tools without callId end one earliest running card at a time", () => {
  const started: ToolPanelItem[] = [{ id: 1, kind: "user" }, tool(2, "bash"), tool(3, "bash")];
  const first = applyToolEnd(started, { name: "bash", text: "one" });
  assert.equal(cardAt(first, 1).status, "end");
  assert.equal(cardAt(first, 2).status, "start");
  const second = applyToolEnd(first, { name: "bash", text: "two" });
  assert.deepEqual(second.map((item) => item.kind === "tool" && item.card.output), [false, "one", "two"]);
});

test("a late real end wins over inferred flags and preserves empty-result truth", () => {
  const pending = tool(2, "read", "r1");
  if (pending.kind !== "tool") throw new Error("tool fixture");
  pending.card = { ...pending.card, interrupted: true, unconfirmed: true };
  const other = tool(3, "read", "r2");
  if (other.kind !== "tool") throw new Error("tool fixture");
  other.card = { ...other.card, interrupted: true };
  const ended = applyToolEnd([{ id: 1, kind: "user" }, pending, other], {
    name: "read", callId: "r1", text: "", truncated: true,
  });
  const card = cardAt(ended, 1);
  assert.equal(card?.status, "end");
  assert.equal(card?.hasResult, true);
  assert.equal(card?.output, "");
  assert.equal(card?.interrupted, undefined);
  assert.equal(card?.unconfirmed, undefined);
  assert.equal(card?.truncated, true);
  assert.equal(cardAt(ended, 2).interrupted, true);

  const acrossTurns = applyToolEnd([
    ended[0]!,
    ended[1]!,
    { id: 4, kind: "user" },
    ended[2]!,
  ], { name: "read", callId: "r2", text: "late after a new user" });
  assert.equal(cardAt(acrossTurns, 3).status, "end");
  assert.equal(cardAt(acrossTurns, 3).interrupted, undefined);

  const withoutId = tool(6, "read");
  if (withoutId.kind !== "tool") throw new Error("tool fixture");
  withoutId.card = { ...withoutId.card, unconfirmed: true };
  const noIdEnded = applyToolEnd([{ id: 5, kind: "user" }, withoutId], { name: "read", text: "late" });
  assert.equal(cardAt(noIdEnded, 1).status, "end");
  assert.equal(cardAt(noIdEnded, 1).unconfirmed, undefined);

  const oldWithoutId = tool(7, "read");
  const newWithoutId = tool(9, "read");
  const lateAcrossTurns = applyToolEnd([
    { id: 6, kind: "user" },
    oldWithoutId,
    { id: 8, kind: "user" },
    newWithoutId,
  ], { name: "read", text: "old turn result" });
  assert.equal(cardAt(lateAcrossTurns, 1).status, "end");
  assert.equal(cardAt(lateAcrossTurns, 1).output, "old turn result");
  assert.equal(cardAt(lateAcrossTurns, 3).status, "start", "a late end without callId must not claim the new turn's tool");
});

test("connection loss demotes only unresolved running tools without rewriting facts", () => {
  assert.equal(toolEntryStatus({ key: "1", name: "read", status: "start" }, false), "running");
  assert.equal(toolEntryStatus({ key: "1", name: "read", status: "start" }, true), "unconfirmed");
  assert.equal(toolEntryStatus({ key: "1", name: "read", status: "start", interrupted: true }, true), "interrupted");
  assert.equal(toolEntryStatus({ key: "1", name: "read", status: "end", isError: true }, true), "failed");
  assert.equal(toolEntryStatus({ key: "1", name: "read", status: "end", hasResult: false, resultMissing: true }, false), "resultMissing");
});

test("a historical synthetic interruption outranks the end status", () => {
  assert.equal(
    toolEntryStatus({ key: "1", name: "bash", status: "end", interrupted: true }, false),
    "interrupted",
    "history restores synthetic interruptions with status=end; they must not render as done",
  );
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user" },
    { id: 2, kind: "tool", card: { key: "1", name: "bash", status: "end", interrupted: true } },
  ];
  assert.equal(
    panelAt(projectToolPanels(items, { contentItems: content(items), connectionLost: false }), 1).title,
    "工具 · 已中断 · 1 项调用",
  );
});

test("panel toggle is stored only on the anchor tool item", () => {
  const items = [tool(2, "read"), tool(3, "grep")];
  const changed = withToolPanelToggle(items, 2, "collapse");
  assert.equal(changed[0]?.panelToggled, "collapse");
  assert.equal(changed[1]?.panelToggled, undefined);
  assert.equal(withToolPanelToggle(items, 99, "expand"), items);
});

test("projection creates one anchored panel per user turn and preserves every special row", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user", text: "第一回合" },
    { id: 2, kind: "thinking" },
    tool(3, "read"),
    { id: 4, kind: "ask" },
    tool(5, "todo_write"),
    { id: 6, kind: "input" },
    { id: 7, kind: "subagent-run" },
    { id: 8, kind: "todo" },
    { id: 9, kind: "user", text: "第二回合" },
    tool(10, "grep"),
  ];
  const rows = projectToolPanels(items, { contentItems: content(items), connectionLost: false });
  assert.deepEqual(rows.map((row) => row.kind === "panel" ? `panel:${row.id}` : `${row.item.kind}:${row.item.id}`), [
    "user:1", "thinking:2", "panel:3", "ask:4", "input:6", "subagent-run:7", "todo:8", "user:9", "panel:10",
  ]);
  assert.equal(panelAt(rows, 2).tools.length, 2);
  assert.equal(panelAt(rows, 2).tools[1]?.name, "todo_write", "a tool todo_write without event.todos is still a normal tool");
  assert.equal(projectToolPanels([{ id: 1, kind: "user" }], { contentItems: [], connectionLost: false }).length, 1);
});

test("panel titles use the specified priority and connection loss removes running from contention", () => {
  const cards = [
    { key: "1", name: "read", status: "start" as const },
    { key: "2", name: "bash", status: "end" as const, isError: true, hasResult: true },
    { key: "3", name: "read", status: "end" as const, hasResult: false, resultMissing: true },
  ];
  const items: ToolPanelItem[] = [{ id: 1, kind: "user" }, ...cards.map((card, index) => ({ id: index + 2, kind: "tool" as const, card }))];
  const live = projectToolPanels(items, { contentItems: content(items), connectionLost: false });
  assert.equal(panelAt(live, 1).title, "工具 · 执行中 · 3 项调用");
  const lost = projectToolPanels(items, { contentItems: content(items), connectionLost: true });
  assert.equal(panelAt(lost, 1).title, "工具 · 含失败调用 · 3 项调用");
  const onlyMissing = projectToolPanels([items[0]!, items[3]!], { contentItems: [], connectionLost: true });
  assert.equal(panelAt(onlyMissing, 1).title, "工具 · 结果未记录 · 1 项调用");
});

test("visible body, turnFinal, history and manual toggle control default expansion", () => {
  const base: ToolPanelItem[] = [{ id: 1, kind: "user" }, tool(2, "read")];
  const thinkOnly: ToolPanelItem[] = [...base, { id: 3, kind: "assistant", text: "<think>还在想</think>" }];
  const expanded = projectToolPanels(thinkOnly, { contentItems: content(thinkOnly), connectionLost: false });
  assert.equal(panelAt(expanded, 1).expanded, true);
  const visible: ToolPanelItem[] = [...base, { id: 3, kind: "assistant", text: "正文" }];
  const collapsed = projectToolPanels(visible, { contentItems: content(visible), connectionLost: false });
  assert.equal(panelAt(collapsed, 1).expanded, false);

  const attachment = { id: 3, kind: "attachment" as const, sourceText: "运行结果" };
  const attachmentItems: ToolPanelItem[] = [...base, attachment];
  const attachmentRows = projectToolPanels(attachmentItems, {
    contentItems: [...base, attachmentAsAssistant(attachment)], connectionLost: false,
  });
  assert.equal(panelAt(attachmentRows, 1).expanded, false);

  const final = projectToolPanels(base, {
    contentItems: content(base), connectionLost: false, turnFinalByUserId: { 1: true },
  });
  assert.equal(panelAt(final, 1).expanded, false);
  const manual = withToolPanelToggle(base, 2, "expand");
  const overridden = projectToolPanels(manual, {
    contentItems: content(manual), connectionLost: false, turnFinalByUserId: { 1: true },
  });
  assert.equal(panelAt(overridden, 1).expanded, true);
  const manualCollapsed = projectToolPanels(withToolPanelToggle(base, 2, "collapse"), {
    contentItems: content(base), connectionLost: false,
  });
  assert.equal(panelAt(manualCollapsed, 1).expanded, false);

  const endedItems: ToolPanelItem[] = [
    { id: 1, kind: "user" },
    { id: 2, kind: "tool", card: { key: "done", name: "read", status: "end", hasResult: true, output: "ok" } },
  ];
  const endedFinal = projectToolPanels(endedItems, {
    contentItems: content(endedItems), connectionLost: false, turnFinalByUserId: { 1: true },
  });
  assert.equal(panelAt(endedFinal, 1).expanded, false, "all-ended tools without visible body still collapse on turnFinal");
});

test("an active goal round note and later tools reuse the same expanded panel", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user" },
    tool(2, "read"),
    { id: 3, kind: "note", text: "正在按目标继续，第 1/4 轮，这还不是验收结果" },
    tool(4, "grep"),
  ];
  const rows = projectToolPanels(items, { contentItems: content(items), connectionLost: false, turnFinalByUserId: {} });
  assert.equal(rows.filter((row) => row.kind === "panel").length, 1);
  assert.equal(panelAt(rows, 1).expanded, true);
  assert.equal(panelAt(rows, 1).count, 2);
  assert.equal(panelAt(rows, 1).tools.every((tool) => tool.status === "running"), true);
});

test("restored goal round notes keep one collapsed historical panel", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user", text: "完成目标" },
    { id: 2, kind: "tool", card: { key: "r1", name: "read", callId: "r1", status: "end", hasResult: true, output: "第一轮结果" } },
    { id: 3, kind: "note", text: "正在按目标继续，第 1/4 轮，这还不是验收结果" },
    { id: 4, kind: "tool", card: { key: "g1", name: "grep", callId: "g1", status: "end", hasResult: true, output: "续轮结果" } },
  ];
  const rows = projectToolPanels(items, {
    contentItems: content(items), connectionLost: false, turnFinalByUserId: { 1: true },
  });
  assert.equal(rows.filter((row) => row.kind === "panel").length, 1);
  assert.equal(panelAt(rows, 1).count, 2);
  assert.equal(panelAt(rows, 1).expanded, false);
});

test("all currently allowed tool names have closed generic descriptions and unknown names fall back", () => {
  const groups: Array<[readonly string[], string]> = [
    [["read", "read_file"], "正在读取文件"],
    [["glob", "grep"], "正在搜索内容"],
    [["edit", "write", "str_replace_editor"], "正在修改文件"],
    [["bash", "pwsh"], "正在运行命令"],
    [["skill"], "正在执行技能"],
    [["subagent"], "正在调用子代理"],
    [["todo_write"], "正在更新待办"],
    [["get_goal", "create_goal", "update_goal"], "正在处理目标"],
    [["git_status", "git_diff", "git_branch", "git_checkout", "git_commit", "git_push"], "正在执行 Git 操作"],
    [["web_fetch"], "正在读取网页"],
    [["screenshot"], "正在获取截图"],
    [["call_host_tool"], "正在调用宿主工具"],
    [["propose_plan", "exit_plan_mode"], "正在处理计划"],
    [["request_input"], "正在请求输入"],
  ];
  assert.equal(groups.flatMap(([names]) => names).length, 27);
  for (const [names, description] of groups) {
    for (const name of names) assert.equal(toolDescription(name), description, name);
  }
  assert.equal(toolDescription("future_tool"), "正在执行工具");
  assert.equal(toolDescription("read"), "正在读取文件");
});

test("panel titles cover all six states with the exact Chinese label and count", () => {
  const cases: Array<[ToolPanelCard, string]> = [
    [{ key: "1", name: "read", status: "start" }, "执行中"],
    [{ key: "1", name: "read", status: "end", hasResult: true, isError: true }, "含失败调用"],
    [{ key: "1", name: "read", status: "start", interrupted: true }, "已中断"],
    [{ key: "1", name: "read", status: "start", unconfirmed: true }, "状态未确认"],
    [{ key: "1", name: "read", status: "end", hasResult: false, resultMissing: true }, "结果未记录"],
    [{ key: "1", name: "read", status: "end", hasResult: true, output: "ok" }, "已完成"],
  ];
  for (const [card, label] of cases) {
    const items: ToolPanelItem[] = [{ id: 1, kind: "user" }, { id: 2, kind: "tool", card }];
    assert.equal(panelAt(projectToolPanels(items, { contentItems: content(items), connectionLost: false }), 1).title, `工具 · ${label} · 1 项调用`);
  }
});

test("turnFinal is monotonic and active continuation ends stay non-final", () => {
  assert.equal(reduceTurnFinal(undefined, { kind: "session-end", ok: true, cancelled: false }, "active"), false);
  for (const phase of [undefined, "paused", "blocked", "complete"] as const) {
    assert.equal(reduceTurnFinal(undefined, { kind: "session-end", ok: true, cancelled: false }, phase), true);
  }
  assert.equal(reduceTurnFinal(undefined, { kind: "session-end", ok: false, cancelled: false }, "active"), true);
  assert.equal(reduceTurnFinal(undefined, { kind: "session-end", ok: true, cancelled: true }, "active"), true);
  assert.equal(reduceTurnFinal(true, { kind: "session-end", ok: true, cancelled: false }, "active"), true);
  assert.equal(reduceTurnFinal(true, { kind: "goal-action", action: { kind: "none" } }, undefined), true);
});

test("real goal actions settle completeFirst and endFirst without requiring a second session end", () => {
  for (const order of ["completeFirst", "endFirst"] as const) {
    let state: GoalTurnState = INITIAL_GOAL_TURN_STATE;
    let final = false;
    const events: GoalTurnEvent[] = order === "completeFirst"
      ? [
          { kind: "turn-started", sessionId: "s" },
          { kind: "goal-state", phase: "active", sessionId: "s" },
          { kind: "goal-state", phase: "complete", sessionId: "s" },
          { kind: "session-end", sessionId: "s", ok: true },
        ]
      : [
          { kind: "turn-started", sessionId: "s" },
          { kind: "goal-state", phase: "active", sessionId: "s" },
          { kind: "session-end", sessionId: "s", ok: true },
          { kind: "goal-state", phase: "complete", sessionId: "s" },
          { kind: "goal-state", phase: "complete", sessionId: "s" },
          { kind: "session-end", sessionId: "s", ok: true },
        ];
    const observed: boolean[] = [];
    for (const event of events) {
      const result = reduceGoalTurn(state, event);
      state = result.state;
      const input: TurnFinalEvent = event.kind === "session-end"
        ? { kind: "session-end", ok: event.ok, cancelled: event.cancelled === true }
        : event.kind === "goal-state" || event.kind === "goal-round-limit"
          ? { kind: "goal-action", action: result.action }
          : { kind: "goal-action", action: { kind: "none" } };
      final = reduceTurnFinal(final, input, state.phases[event.sessionId ?? ""]);
      observed.push(final);
    }
    if (order === "endFirst") {
      assert.equal(observed[2], false, "active intermediate end does not settle");
      assert.equal(observed[3], true, "the actual complete outcome settles immediately");
    }
    assert.equal(final, true);
    assert.equal(observed.at(-1), true, "later duplicate events never reopen the turn");
  }
});

test("a real goal round-limit settles turnFinal through the goal-stopped action", () => {
  let state: GoalTurnState = INITIAL_GOAL_TURN_STATE;
  state = reduceGoalTurn(state, { kind: "turn-started", sessionId: "s" }).state;
  const limited = reduceGoalTurn(state, { kind: "goal-round-limit", round: GOAL_ROUND_LIMIT, sessionId: "s" });
  state = limited.state;
  assert.equal(limited.action.kind, "goal-stopped");
  if (limited.action.kind !== "goal-stopped") throw new Error("expected goal-stopped");
  assert.equal(limited.action.round, GOAL_ROUND_LIMIT);
  const event: TurnFinalEvent = { kind: "goal-action", action: limited.action };
  assert.equal(reduceTurnFinal(undefined, { kind: "goal-action", action: { kind: "none" } }, undefined), false, "a none action never settles");
  assert.equal(reduceTurnFinal(undefined, event, state.phases["s"]), true, "round-limit settles the turn final");
  // 与 App 的接线同形：goal-stopped 立刻写入 turnFinalByUserId，不需要第二次 session/end。
  const tabs: Array<{ id: string; items: ToolPanelItem[]; turnFinalByUserId?: Readonly<Record<number, boolean>> }> = [
    { id: "a", items: [{ id: 1, kind: "user" } as ToolPanelItem, tool(2, "bash")] },
  ];
  const settled = applyTurnFinalToTabs(tabs, "a", event, state.phases["s"]);
  assert.deepEqual(settled[0]?.turnFinalByUserId, { 1: true });
  assert.equal(cardAt(settled[0]!.items, 1).unconfirmed, true, "an unfinished tool of the stopped round is unconfirmed");
  assert.equal(applyTurnFinalToTabs(settled, "a", event, state.phases["s"]), settled, "the same stop action never re-settles");
});

test("tab settlement interrupts or unconfirms only the current turn on the owning tab", () => {
  const oldTool = tool(2, "bash", "old");
  const doneTool = tool(4, "read", "done");
  const pendingTool = tool(5, "bash", "pending");
  if (doneTool.kind === "tool") doneTool.card = { ...doneTool.card, status: "end", hasResult: true, output: "kept" };
  // `turnFinalByUserId` 由结算写入，fixture 必须声明这个可选字段，结算结果才可断言。
  const tabs: Array<{ id: string; items: ToolPanelItem[]; turnFinalByUserId?: Readonly<Record<number, boolean>> }> = [
    { id: "a", items: [{ id: 1, kind: "user" } as ToolPanelItem, oldTool, { id: 3, kind: "user" } as ToolPanelItem, doneTool, pendingTool] },
    { id: "b", items: [{ id: 11, kind: "user" } as ToolPanelItem, tool(12, "bash")] },
  ];
  const cancelled = applyTurnFinalToTabs(tabs, "a", { kind: "session-end", ok: false, cancelled: false }, "active");
  assert.deepEqual(cancelled[0]?.turnFinalByUserId, { 3: true });
  assert.equal(cardAt(cancelled[0]!.items, 1).interrupted, undefined);
  assert.equal(cardAt(cancelled[0]!.items, 3).output, "kept");
  assert.equal(cardAt(cancelled[0]!.items, 4).interrupted, true);
  assert.equal(cancelled[1], tabs[1], "background tab is untouched");

  const active = applyTurnFinalToTabs(tabs, "a", { kind: "session-end", ok: true, cancelled: false }, "active");
  assert.equal(active, tabs, "active intermediate end neither stores final nor marks tools");
  const normal = applyTurnFinalToTabs(tabs, "a", { kind: "session-end", ok: true, cancelled: false }, undefined);
  assert.equal(cardAt(normal[0]!.items, 4).unconfirmed, true);
  assert.equal(cardAt(normal[0]!.items, 4).interrupted, undefined);
});

test("history seed marks every restored user turn final", () => {
  assert.deepEqual(historicalTurnFinalByUserId([{ id: 1, kind: "user" }, tool(2, "read"), { id: 3, kind: "user" }]), { 1: true, 3: true });
});

test("a tab without user entries settles its synthetic turn and collapses its panel", () => {
  const tabs: Array<{ id: string; items: ToolPanelItem[]; turnFinalWithoutUser?: boolean }> = [
    { id: "run", items: [tool(2, "bash", "b1")] },
  ];
  const cancelled = applyTurnFinalToTabs(tabs, "run", { kind: "session-end", ok: false, cancelled: true }, undefined);
  assert.equal(cancelled[0]?.turnFinalWithoutUser, true);
  assert.equal(cardAt(cancelled[0]!.items, 0).interrupted, true);
  const rows = projectToolPanels(cancelled[0]!.items, {
    contentItems: cancelled[0]!.items,
    connectionLost: false,
    turnFinalWithoutUser: cancelled[0]?.turnFinalWithoutUser,
  });
  assert.equal(panelAt(rows, 0).title, "工具 · 已中断 · 1 项调用");
  assert.equal(panelAt(rows, 0).expanded, false);
  assert.equal(
    applyTurnFinalToTabs(cancelled, "run", { kind: "session-end", ok: false, cancelled: true }, undefined),
    cancelled,
    "the same settlement never runs twice",
  );

  const normal = applyTurnFinalToTabs(tabs, "run", { kind: "session-end", ok: true, cancelled: false }, undefined);
  assert.equal(cardAt(normal[0]!.items, 0).unconfirmed, true);
  assert.equal(cardAt(normal[0]!.items, 0).interrupted, undefined);

  const runOk = applyTurnFinalToTabs(tabs, "run", { kind: "run-end", interrupted: false }, undefined);
  assert.equal(runOk[0]?.turnFinalWithoutUser, true);
  assert.equal(cardAt(runOk[0]!.items, 0).unconfirmed, true);
  const runFailed = applyTurnFinalToTabs(tabs, "run", { kind: "run-end", interrupted: true }, undefined);
  assert.equal(cardAt(runFailed[0]!.items, 0).interrupted, true);
  assert.equal(reduceTurnFinal(false, { kind: "run-end", interrupted: false }, undefined), true);
});

test("a goal outcome seals the turn without unconfirming in-flight tools", () => {
  const tabs: Array<{ id: string; items: ToolPanelItem[]; turnFinalByUserId?: Readonly<Record<number, boolean>> }> = [
    { id: "a", items: [{ id: 1, kind: "user" }, tool(2, "update_goal", "g1")] },
  ];
  const sealed = applyTurnFinalToTabs(tabs, "a", { kind: "goal-action", action: { kind: "outcome" } }, "complete");
  assert.deepEqual(sealed[0]?.turnFinalByUserId, { 1: true });
  assert.equal(cardAt(sealed[0]!.items, 1).unconfirmed, undefined);
  assert.equal(cardAt(sealed[0]!.items, 1).interrupted, undefined);

  const ended = applyToolEnd(sealed[0]!.items, { name: "update_goal", callId: "g1", text: "done" });
  assert.equal(cardAt(ended, 1).status, "end");
  assert.equal(cardAt(ended, 1).unconfirmed, undefined);

  const settled = applyTurnFinalToTabs(sealed, "a", { kind: "session-end", ok: true, cancelled: false }, "complete");
  assert.equal(cardAt(settled[0]!.items, 1).unconfirmed, true, "a real turn end still flags a genuinely stuck tool");
});

test("a later user closes the old panel, starts non-final, and preserves the old manual choice", () => {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user" },
    tool(2, "read"),
    { id: 3, kind: "user" },
    tool(4, "grep"),
  ];
  const rows = projectToolPanels(items, { contentItems: content(items), connectionLost: false });
  const panels = rows.flatMap((row) => row.kind === "panel" ? [row.panel] : []);
  assert.equal(panels.length, 2);
  assert.equal(panels[0]?.expanded, false, "the previous user turn is implicitly final");
  assert.equal(panels[1]?.expanded, true, "the new user turn starts non-final");

  const manual = withToolPanelToggle(items, 2, "expand");
  const rerendered = projectToolPanels(manual, { contentItems: content(manual), connectionLost: false });
  const manualPanels = rerendered.flatMap((row) => row.kind === "panel" ? [row.panel] : []);
  assert.equal(manualPanels[0]?.expanded, true, "manual expand survives tab-style reconstruction");
  assert.equal(manualPanels[1]?.expanded, true);
});
