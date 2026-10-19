import assert from "node:assert/strict";
import { test } from "vitest";
import { GOAL_ROUND_LIMIT, goalRoundLabel, goalRoundStopped } from "../../src/client-huaanwork/logic/goalRound.ts";

test("goal rounds stop at four and keep the gaps", () => {
  assert.equal(GOAL_ROUND_LIMIT, 4);
  assert.equal(goalRoundLabel(2), "正在按目标继续，第 2/4 轮，这还不是验收结果");
  assert.equal(goalRoundStopped(4, ["缺少文件：报告.md"]), "已停在第 4/4 轮。尚未核对：缺少文件：报告.md");
});

test("goalRoundStopped says 无 when nothing is left unchecked", () => {
  assert.equal(goalRoundStopped(4, []), "已停在第 4/4 轮。尚未核对：无");
});
