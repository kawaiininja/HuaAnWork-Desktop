import assert from "node:assert/strict";
import { test } from "vitest";

import {
  RESULT_ATTACHMENT_FILES,
  attachmentAsAssistant,
  collectAssistantText,
  foldRunAssistantItems,
  isJsonResultText,
  stripThinkingForResult,
} from "../../src/client-huaanwork/logic/runResultAttachments.ts";

test("only object/array bodies fold; scalars, prose and empty text do not", () => {
  assert.equal(isJsonResultText('{"a":1}'), true);
  assert.equal(isJsonResultText("[1,2]"), true);
  assert.equal(isJsonResultText("{}"), true);
  assert.equal(isJsonResultText("[]"), true);
  assert.equal(isJsonResultText("null"), false);
  assert.equal(isJsonResultText("42"), false);
  assert.equal(isJsonResultText('"文本"'), false);
  assert.equal(isJsonResultText("true"), false);
  assert.equal(isJsonResultText("结果如下：{\"a\":1}"), false);
  assert.equal(isJsonResultText("   "), false);
});

test("think blocks are stripped with the same rule as the host store", () => {
  assert.equal(stripThinkingForResult('{"a":1}<think>隐藏</think>'), '{"a":1}');
  assert.equal(stripThinkingForResult('{"a":1}<think>没写完'), '{"a":1}');
  assert.equal(isJsonResultText('{"a":1}<think>x</think>'), true);
});

test("folding replaces every assistant item with one attachment at the first assistant position", () => {
  type Item = { id: number; kind: string; text?: string; sourceText?: string };
  const items: Item[] = [
    { id: 1, kind: "note", text: "自动化运行中…" },
    { id: 2, kind: "assistant", text: '{"a"' },
    { id: 3, kind: "tool", text: undefined },
    { id: 4, kind: "assistant", text: ":1}" },
  ];
  assert.equal(collectAssistantText(items), '{"a":1}');
  const folded = foldRunAssistantItems(items, (sourceText) => ({ id: 99, kind: "attachment", sourceText }));
  assert.equal(folded.length, 3);
  assert.equal(folded[1]?.kind, "attachment");
  assert.equal((folded[1] as { sourceText?: string }).sourceText, '{"a":1}');
  assert.equal(folded.some((item) => item.kind === "assistant"), false);
  assert.equal(folded.some((item) => item.kind === "tool"), true);
});

test("non-JSON bodies return the same array reference untouched", () => {
  type Item = { id: number; kind: string; text?: string; sourceText?: string };
  const items: Item[] = [{ id: 1, kind: "assistant", text: "普通句子" }];
  assert.equal(foldRunAssistantItems(items, () => ({ id: 99, kind: "attachment", sourceText: "" })), items);
});

test("attachment file names are exactly the two fixed names", () => {
  assert.deepEqual([...RESULT_ATTACHMENT_FILES], ["结果.md", "结果.html"]);
});

test("an attachment becomes an assistant-shaped content item with the same id and text", () => {
  const attachment = { id: 7, kind: "attachment" as const, sourceText: '{"a":1}' };
  assert.deepEqual(attachmentAsAssistant(attachment), { id: 7, kind: "assistant", text: '{"a":1}' });
});
