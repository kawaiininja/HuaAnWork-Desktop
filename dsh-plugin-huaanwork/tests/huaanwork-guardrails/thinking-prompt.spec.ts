import assert from "node:assert/strict";
import { test } from "vitest";
import { apply, THINKING_PROMPT_NAME, THINKING_PROMPT_ORDER, THINKING_PROMPT_TEXT } from "../../src/huaanwork-guardrails/thinking-prompt.ts";

test("thinking prompt is a constant section and does not use plan-policy order", () => {
  const registered: { name: string; order: number; text: string }[] = [];
  apply({
    systemPrompt: {
      section(entry: { name: string; order: number; text: string }) {
        registered.push(entry);
      },
    },
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0]?.name, THINKING_PROMPT_NAME);
  assert.equal(registered[0]?.order, 40);
  assert.notEqual(THINKING_PROMPT_ORDER, 500);
  assert.equal(registered[0]?.text, THINKING_PROMPT_TEXT);
  assert.match(THINKING_PROMPT_TEXT, /简体中文/);
  assert.match(THINKING_PROMPT_TEXT, /回答语言跟随用户/);
});
