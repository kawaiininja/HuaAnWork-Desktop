import assert from "node:assert/strict";
import { test } from "vitest";
import { AUTO_CONTINUE_LABEL, PLAN_CARD_NOTE, PLAN_EXITED_NOTE, planExitNote, planNeedsConfirm } from "../../src/client-huaanwork/logic/planConfirm.ts";

test("ask always confirms, smart confirms only the ask-set, full confirms target changes", () => {
  assert.equal(planNeedsConfirm({ mode: "ask", declaresAskTool: false, changesTarget: false }), true);
  assert.equal(planNeedsConfirm({ mode: "smart", declaresAskTool: false, changesTarget: true }), false);
  assert.equal(planNeedsConfirm({ mode: "smart", declaresAskTool: true, changesTarget: false }), true);
  assert.equal(planNeedsConfirm({ mode: "full", declaresAskTool: true, changesTarget: false }), false);
  assert.equal(planNeedsConfirm({ mode: "full", declaresAskTool: false, changesTarget: true }), true);
  assert.match(PLAN_CARD_NOTE, /仍可能读取工作区/);
  assert.equal(AUTO_CONTINUE_LABEL, "按当前护栏自动继续");
});

test("the chat records 已退出计划模式 only when the host result is exited: true", () => {
  assert.equal(planExitNote({ exited: true }), PLAN_EXITED_NOTE);
  assert.equal(PLAN_EXITED_NOTE, "已退出计划模式");
  for (const result of [undefined, null, {}, { exited: false }, { exited: "true" }]) {
    assert.equal(planExitNote(result), undefined);
  }
});
