import assert from "node:assert/strict";
import { test } from "vitest";
import {
  extractThinkBlocks,
  hasAssistantTextAfter,
  interruptTurnItems,
  withThinkingToggle,
  nextThinkingSteps,
  resolveThinking,
  shouldRenderThinking,
  thinkingChrome,
  thinkingStepsText,
  type ThinkingToggleItem,
} from "../../src/client-huaanwork/logic/thinkingPanel.ts";
import { attachmentAsAssistant } from "../../src/client-huaanwork/logic/runResultAttachments.ts";

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
    thinkingChrome({ hasAssistantText: true, userToggled: null, interrupted: false }),
    { title: "思考 · 已生成", expanded: false },
  );
  assert.equal(
    thinkingChrome({ hasAssistantText: true, userToggled: "expand", interrupted: false }).expanded,
    true,
  );
  assert.equal(
    thinkingChrome({ hasAssistantText: false, userToggled: null, interrupted: true }).title,
    "思考 · 已中断",
  );
  assert.deepEqual(
    thinkingChrome({ hasAssistantText: true, userToggled: null, interrupted: false, historical: true }),
    { title: "思考", expanded: false },
  );
  assert.deepEqual(
    thinkingChrome({ hasAssistantText: false, userToggled: null, interrupted: false, historical: true }),
    { title: "思考", expanded: false },
  );
  assert.equal(
    thinkingChrome({ hasAssistantText: false, userToggled: "expand", interrupted: false, historical: true }).expanded,
    true,
  );
});

test("a user stop marks the current turn interrupted", () => {
  const items = [
    { kind: "user" as const },
    { kind: "thinking" as const, interrupted: false },
    { kind: "assistant" as const, interrupted: false },
  ];
  const next = interruptTurnItems(items);
  assert.equal(next[1]?.interrupted, true);
  assert.equal(
    thinkingChrome({
      hasAssistantText: true,
      userToggled: null,
      interrupted: next[1]?.interrupted === true,
    }).title,
    "思考 · 已中断",
  );
});

test("a thinking toggle stays on the item", () => {
  const items: ThinkingToggleItem[] = [
    { id: 1, kind: "thinking" },
    { id: 2, kind: "assistant" },
    { id: 3, kind: "user" },
  ];
  const expanded = withThinkingToggle(items, 1, "expand");
  assert.equal(expanded[0]?.userToggled, "expand");
  assert.equal(withThinkingToggle(expanded, 2, "collapse")[1]?.userToggled, "collapse");
  assert.equal(withThinkingToggle(expanded, 1, "expand"), expanded);
  assert.equal(withThinkingToggle(items, 9, "collapse"), items);
});

test("blank thought does not render a panel", () => {
  assert.equal(shouldRenderThinking("  "), false);
  assert.equal(shouldRenderThinking("先看文件"), true);
});

test("later answer text counts after a think-only assistant item", () => {
  const items = [
    { kind: "thinking" as const, thought: "先看文件" },
    { kind: "assistant" as const, text: "<think>还没完" },
    { kind: "tool" as const },
    { kind: "assistant" as const, text: "这是答案" },
  ];
  assert.equal(hasAssistantTextAfter(items, 0), true);
});

test("a following user message ends the scan", () => {
  const items = [
    { kind: "thinking" as const, thought: "先看文件" },
    { kind: "assistant" as const, text: "<think></think>" },
    { kind: "user" as const },
    { kind: "assistant" as const, text: "下一轮的答案" },
  ];
  assert.equal(hasAssistantTextAfter(items, 0), false);
});

test("a folded result attachment counts as assistant text after a finished thinking panel", () => {
  // 运行结束后内容视图里的附件项：映射成 assistant 才算「已生成」。
  const withAttachment = [
    { kind: "thinking" as const, thought: "想了很久" },
    attachmentAsAssistant({ id: 2, sourceText: '{"a":1}' }),
  ];
  assert.equal(hasAssistantTextAfter(withAttachment, 0), true);
  // 评审前的空 note 占位：扫描不到助手正文，面板会展开并停在「进行中」。
  const withPlaceholder = [
    { kind: "thinking" as const, thought: "想了很久" },
    { kind: "note" as const, text: "" },
  ];
  assert.equal(hasAssistantTextAfter(withPlaceholder, 0), false);
  // chrome 随判据收敛：已生成且默认收起。
  assert.deepEqual(
    thinkingChrome({ hasAssistantText: true, userToggled: null, interrupted: false }),
    { title: "思考 · 已生成", expanded: false },
  );
});

test("a final reasoning event replaces only the current step, earlier steps stay", () => {
  let steps = { settled: "", draft: "" };
  steps = nextThinkingSteps(steps, "先读", false);
  steps = nextThinkingSteps(steps, "文件", false);
  assert.equal(thinkingStepsText(steps), "先读文件");
  steps = nextThinkingSteps(steps, "先读文件。", true);
  assert.equal(thinkingStepsText(steps), "先读文件。");
  // 工具调用之后的下一步思考
  steps = nextThinkingSteps(steps, "再写", false);
  assert.equal(thinkingStepsText(steps), "先读文件。\n\n再写");
  steps = nextThinkingSteps(steps, "再写报告。", true);
  assert.equal(thinkingStepsText(steps), "先读文件。\n\n再写报告。");
  // 与重开历史一致：每条消息一块思考，按顺序拼起来就是同一段文字
  assert.equal(thinkingStepsText(steps), ["先读文件。", "再写报告。"].join("\n\n"));
});
