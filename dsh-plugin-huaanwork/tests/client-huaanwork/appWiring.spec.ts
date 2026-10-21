import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { answerApprovalInTabs } from "../../src/client-huaanwork/logic/chatTabs.ts";
import { clearFailuresInTabs } from "../../src/client-huaanwork/logic/hostStop.ts";
import { foldRunAssistantItems } from "../../src/client-huaanwork/logic/runResultAttachments.ts";

/**
 * App 两条回调接线的回归门（评审:helper 单测全绿但 App 调用被删仍绿）:
 * 1. 探活观察者 → clearFailuresInTabs → setChatTabs
 * 2. answer() → answerApprovalInTabs → setChatTabs
 *
 * 这里驱动 App 实际调用的生产函数（不是复刻循环），并在末尾钉住 App.tsx 的
 * 调用点；去掉调用点、把循环写回组件或换掉实现都会变红。
 */

type TabsSetter<T> = (value: T[] | ((prev: T[]) => T[])) => void;

/** 假 setChatTabs：收集函数式更新，按顺序应用后返回最终 tabs。 */
function collectUpdates<T>(initial: T[]) {
  const updates: Array<(prev: T[]) => T[]> = [];
  const setTabs: TabsSetter<T> = (value) => {
    updates.push(typeof value === "function" ? (value as (prev: T[]) => T[]) : () => value);
  };
  return {
    setTabs,
    updates,
    value(): T[] {
      return updates.reduce((tabs, update) => update(tabs), initial);
    },
  };
}

test("the stopped phase clears every failed tab through the same setter App uses", () => {
  const initial = [
    { id: "a", label: "会话 A", sessionFailed: true },
    { id: "b", label: "会话 B", sessionFailed: false },
  ];
  const harness = collectUpdates(initial);
  clearFailuresInTabs("stopped", harness.setTabs);
  assert.equal(harness.updates.length, 1);
  assert.deepEqual(harness.value(), [
    { id: "a", label: "会话 A", sessionFailed: false },
    { id: "b", label: "会话 B", sessionFailed: false },
  ]);
});

test("phases before the stop confirmation never touch the tabs", () => {
  // socket 先关时标签被标失败,但 suspect/stoppable 仍在探活里:不能提前撤掉红条。
  for (const phase of ["ok", "suspect", "stoppable"] as const) {
    const harness = collectUpdates([{ id: "a", sessionFailed: true }]);
    clearFailuresInTabs(phase, harness.setTabs);
    assert.equal(harness.updates.length, 0, phase);
    assert.deepEqual(harness.value(), [{ id: "a", sessionFailed: true }], phase);
  }
});

test("a repeated stopped phase with no failure keeps the same array (no state churn)", () => {
  const initial = [{ id: "a", sessionFailed: false }];
  const harness = collectUpdates(initial);
  clearFailuresInTabs("stopped", harness.setTabs);
  assert.equal(harness.updates.length, 1);
  assert.equal(harness.value(), initial);
});

test("answering writes the card into the tab that holds it, not the live tab", () => {
  type Item = {
    kind: string;
    text?: string;
    card?: { approvalRequestId?: string; toolName?: string; answered?: "approve" | "reject" };
  };
  type Tab = { id: string; items: Item[] };
  const tabs: Tab[] = [
    { id: "live", items: [{ kind: "user", text: "在另一张标签提问" }] },
    {
      id: "card",
      items: [
        { kind: "ask", card: { approvalRequestId: "req-1", toolName: "plan-review" } },
        { kind: "ask", card: { approvalRequestId: "req-2", toolName: "ask_user_question" } },
      ],
    },
  ];
  const harness = collectUpdates(tabs);
  answerApprovalInTabs("req-1", "approve", harness.setTabs);

  const next = harness.value();
  assert.equal(next[0], tabs[0], "不持有卡片的标签保持同一引用");
  assert.notEqual(next[1], tabs[1]);
  assert.equal(next[1]!.items[0]!.card?.answered, "approve");
  assert.equal(next[1]!.items[1]!.card?.answered, undefined, "只标记命中的那张卡");
});

const APP_SOURCE = readFileSync(new URL("../../src/client-huaanwork/App.tsx", import.meta.url), "utf8");

test("App consumes the two production helpers at their only call sites", () => {
  // 契约钉:删掉 App 里的调用(或把循环写回组件)即失败。
  assert.match(APP_SOURCE, /clearFailuresInTabs\(phase, setChatTabs\)/);
  assert.match(APP_SOURCE, /answerApprovalInTabs\(card\.approvalRequestId, decision, setChatTabs\)/);
  // 已处理标记只能由 helper 回写,App 里不得再出现内联循环。
  assert.doesNotMatch(APP_SOURCE, /markApprovalAnswered\(/);
});

test("App skips plan-turn outcomes before it lists the workspace tree", () => {
  const start = APP_SOURCE.indexOf("const appendTurnOutcome = async");
  const end = APP_SOURCE.indexOf("const appendGoalStopped", start);
  assert.ok(start >= 0 && end > start, "appendTurnOutcome is defined before appendGoalStopped");
  const body = APP_SOURCE.slice(start, end);
  const checkAt = body.indexOf("if (!shouldCheckTurnOutcome(pending.items)) return;");
  const readAt = body.indexOf("const turn = await readTurn(sessionId, pending)");
  assert.ok(checkAt >= 0, "appendTurnOutcome still suppresses plan-mode turns");
  assert.ok(
    readAt > checkAt,
    "the plan-turn check must run before readTurn, which pays the depth-6 tree listing",
  );
  // readTurn 仍只在确有必核文件时才列树（执行回合行为不变）。
  const turnStart = APP_SOURCE.indexOf("const readTurn = async");
  const turnEnd = APP_SOURCE.indexOf("const appendTurnNotes", turnStart);
  assert.ok(turnStart >= 0 && turnEnd > turnStart, "readTurn is defined before appendTurnNotes");
  const turnBody = APP_SOURCE.slice(turnStart, turnEnd);
  assert.match(turnBody, /if \(checks\.requiredFiles\.length > 0 && root\) \{/);
  assert.ok(
    turnBody.indexOf("listTree(root, WORKSPACE_SCAN_DEPTH)") > turnBody.indexOf("turnChecks(items)"),
    "the tree listing stays inside the required-files branch",
  );
});

type FoldableItem = {
  id: number;
  kind: "note" | "assistant" | "tool" | "attachment";
  text?: string;
  sourceText?: string;
};

test("folding a run's JSON assistant text keeps one attachment in place and leaves siblings alone", () => {
  const items: FoldableItem[] = [
    { id: 1, kind: "note", text: "自动化运行中…" },
    { id: 2, kind: "assistant", text: '{"a":1}' },
    { id: 3, kind: "tool", text: undefined },
  ];
  const folded = foldRunAssistantItems(items, (sourceText) => ({ id: 9, kind: "attachment" as const, sourceText }));
  assert.deepEqual(folded, [
    { id: 1, kind: "note", text: "自动化运行中…" },
    { id: 9, kind: "attachment", sourceText: '{"a":1}' },
    { id: 3, kind: "tool", text: undefined },
  ]);
});

test("App folds run output at both call sites and keeps each footnote last", () => {
  // 两处调用：run-end 分支与回填效果。只数调用形式——import 行没有左括号，
  // 删掉任一处接线，计数即降为 1（helper 全绿但 App 不调用的回归门）。
  assert.equal((APP_SOURCE.match(/foldRunAssistantItems\(/g) ?? []).length, 2);

  // run-end：先折叠目标标签，再追加结果脚注。
  const runEnd = APP_SOURCE.indexOf("foldRunAssistantItems(tab.items");
  assert.ok(runEnd >= 0, "run-end branch folds the target tab's items");
  assert.ok(
    APP_SOURCE.indexOf('kind: "note"', runEnd) > runEnd,
    "the run-end result footnote is appended after the fold (footnote stays last)",
  );

  // 回填：折叠包住 historyToChatItems，脚注 push 在其后。
  const composed = APP_SOURCE.indexOf("foldRunAssistantItems(historyToChatItems(view)");
  assert.ok(composed >= 0, "backfill folds the replayed history before appending its footnote");
  assert.ok(
    APP_SOURCE.indexOf("runResultNoteText(run.status)", composed) > composed,
    "the backfill footnote is pushed after the fold (footnote stays last)",
  );
});

test("ChatRow offers exactly the shared result attachment files through the optional handler", () => {
  assert.match(APP_SOURCE, /item\.kind === "attachment"/);
  assert.match(APP_SOURCE, /RESULT_ATTACHMENT_FILES\.map\(/);
  assert.match(APP_SOURCE, /onOpenAttachment\?\.\(file\)/);
  // 按钮文案来自共享清单，不在 App 里内联文件名。
  assert.doesNotMatch(APP_SOURCE, /结果\.md/);
});
