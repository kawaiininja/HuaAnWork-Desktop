import assert from "node:assert/strict";
import { test } from "vitest";
import {
  appendOpenInput,
  closeOpenInputs,
  dispatchComposerSubmission,
  inputCardStatus,
  latestOpenInput,
  settleInputCard,
} from "../../src/client-huaanwork/logic/inputCard.ts";

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
  assert.equal(inputCardStatus({ state: "closed" }), "问题已关闭，不再等待回答");
});

test("a new question closes the previous open card before it is appended", () => {
  const next = appendOpenInput([open], 3, "技能名称是什么？", "s1");
  assert.deepEqual(next, [
    { ...open, card: { ...open.card, state: "closed" } },
    { id: 3, kind: "input", card: { question: "技能名称是什么？", sessionId: "s1", state: "open" } },
  ]);
});

test("the composer targets the latest open question and ignores settled cards", () => {
  const latest = { id: 4, kind: "input" as const, card: { question: "下一个问题？", sessionId: "s1", state: "open" as const } };

  const selected = latestOpenInput([
    open,
    { id: 3, kind: "input" as const, card: { ...open.card, state: "answered" as const, answer: "张三" } },
    latest,
    { id: 5, kind: "input" as const, card: { ...open.card, state: "closed" as const } },
  ]);

  assert.equal(selected, latest);
  assert.equal(latestOpenInput([{ ...open, card: { ...open.card, state: "closed" as const } }]), undefined);
});

test("composer submission answers the open question instead of starting a new turn", async () => {
  const calls: unknown[] = [];

  const result = await dispatchComposerSubmission([open], "  周报助手  ", {
    answer: async (...args: unknown[]) => {
      calls.push(args);
      return true;
    },
    send: async () => {
      calls.push("send");
    },
  });

  assert.deepEqual(calls, [[2, open.card, "周报助手"]]);
  assert.deepEqual(result, { kind: "answer", answered: true });
});

test("composer submission keeps ordinary messages on the normal send path", async () => {
  const calls: unknown[] = [];

  const result = await dispatchComposerSubmission([], "继续聊天", {
    answer: async () => {
      calls.push("answer");
      return true;
    },
    send: async () => {
      calls.push("send");
    },
  });

  assert.deepEqual(calls, ["send"]);
  assert.deepEqual(result, { kind: "message" });
});

test("a blank answer does not call either submission path", async () => {
  const calls: unknown[] = [];

  const result = await dispatchComposerSubmission([open], "   ", {
    answer: async () => {
      calls.push("answer");
      return true;
    },
    send: async () => {
      calls.push("send");
    },
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(result, { kind: "empty" });
});

test("an unhandled answer is reported so the composer can preserve its draft", async () => {
  const result = await dispatchComposerSubmission([open], "周报助手", {
    answer: async () => false,
    send: async () => assert.fail("ordinary send must not run"),
  });

  assert.deepEqual(result, { kind: "answer", answered: false });
});
