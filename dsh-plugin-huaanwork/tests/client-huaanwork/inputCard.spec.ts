import assert from "node:assert/strict";
import { test } from "vitest";
import { closeOpenInputs, inputCardStatus, settleInputCard } from "../../src/client-huaanwork/logic/inputCard.ts";

const open = { id: 2, kind: "input" as const, card: { question: "发给谁？", sessionId: "s1", state: "open" as const } };

test("an open input card can be submitted or cancelled once", () => {
  const items = [{ id: 1, kind: "user" as const }, open];
  const answered = settleInputCard(items, 2, "answered", "张三");
  assert.deepEqual(answered[1], { ...open, card: { ...open.card, state: "answered", answer: "张三" } });
  assert.equal(settleInputCard(answered, 2, "cancelled"), answered);
});

test("the end of the turn closes a question nobody answered", () => {
  const items = [{ id: 1, kind: "user" as const }, open];
  const closed = closeOpenInputs(items);
  assert.equal((closed[1] as typeof open).card.state, "closed");
  assert.equal(closeOpenInputs(closed), closed);
});

test("card status lines", () => {
  assert.equal(inputCardStatus({ state: "open" }), undefined);
  assert.equal(inputCardStatus({ state: "answered", answer: "张三" }), "已回答：张三");
  assert.equal(inputCardStatus({ state: "cancelled" }), "已取消");
  assert.equal(inputCardStatus({ state: "closed" }), "回合已结束，这个问题不再等待回答");
});
