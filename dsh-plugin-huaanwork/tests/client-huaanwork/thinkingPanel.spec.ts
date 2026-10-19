import assert from "node:assert/strict";
import { test } from "vitest";
import { extractThinkBlocks, resolveThinking, thinkingChrome } from "../../src/client-huaanwork/logic/thinkingPanel.ts";

test("reasoning wins and think tags stay out of the answer", () => {
  const resolved = resolveThinking({
    reasoning: "先看文件",
    assistantText: "正文<think>不要出现</think>",
  });
  assert.equal(resolved.thought, "先看文件");
  assert.equal(resolved.visible, "正文");
});

test("think tags fill the panel only when reasoning is empty", () => {
  const resolved = resolveThinking({
    reasoning: "   ",
    assistantText: "答案<think>内部</think>结尾",
  });
  assert.equal(resolved.thought, "内部");
  assert.equal(resolved.visible, "答案结尾");
  assert.equal(extractThinkBlocks("<think>内部</think>").thought, "内部");
});

test("an unclosed think tag stays out of the answer bubble", () => {
  const resolved = resolveThinking({
    reasoning: "",
    assistantText: "答案<think>还没完",
  });
  assert.equal(resolved.visible, "答案");
  assert.equal(resolved.thought, "还没完");
  assert.equal(extractThinkBlocks("答案<thi").visible, "答案");
});

test("panel collapses when answer text arrives unless the user toggled it", () => {
  assert.deepEqual(
    thinkingChrome({ thought: "先看文件", hasAssistantText: true, userToggled: null, interrupted: false }),
    { title: "思考 · 已生成", expanded: false },
  );
  assert.equal(
    thinkingChrome({ thought: "先看文件", hasAssistantText: true, userToggled: "expand", interrupted: false }).expanded,
    true,
  );
  assert.equal(
    thinkingChrome({ thought: "先看文件", hasAssistantText: false, userToggled: null, interrupted: true }).title,
    "思考 · 已中断",
  );
});
