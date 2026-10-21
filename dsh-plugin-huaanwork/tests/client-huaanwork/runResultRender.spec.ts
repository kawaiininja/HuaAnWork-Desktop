import assert from "node:assert/strict";
import { test } from "vitest";

import { renderResultHtml, renderResultMarkdown } from "../../src/client-huaanwork/logic/runResultRender.ts";

test("top-level object fields become level-2 sections with plain text values", () => {
  const md = renderResultMarkdown('{"标题":"值","数量":3,"开关":true,"空":null}');
  assert.ok(md.includes("## 标题"));
  assert.ok(md.includes("值"));
  assert.ok(md.includes("3"));
  assert.ok(md.includes("true"));
  assert.ok(md.includes("null"));
});

test("array of objects becomes a table with first-seen column order and __proto__ skipped", () => {
  const md = renderResultMarkdown('[{"b":1,"a":2},{"a":3,"c":4,"__proto__":9}]');
  const header = md.split("\n").find((line) => line.startsWith("|")) ?? "";
  assert.ok(header.includes("b"));
  assert.ok(header.indexOf("b") < header.indexOf("a"));
  assert.ok(header.includes("c"));
  assert.ok(!header.includes("__proto__"));
});

test("missing table cells render as empty cells, never undefined", () => {
  const md = renderResultMarkdown('[{"a":1},{"b":2}]');
  assert.ok(md.includes("| a | b |"));
  assert.ok(md.includes("| 1 |  |"));
  assert.ok(md.includes("|  | 2 |"));
  assert.ok(!md.includes("undefined"));
});

test("object and array table cells become one-line JSON text", () => {
  const md = renderResultMarkdown('[{"o":{"k":"a\\nb"},"a":[1,2]}]');
  assert.ok(md.includes('{"k":"a\\nb"}'));
  assert.ok(md.includes("[1,2]"));
});

test("table cells escape pipes and flatten newlines; prose strings outside tables do not escape", () => {
  const table = renderResultMarkdown('[{"文本":"a|b\\nc"}]');
  assert.ok(table.includes("a\\|b c"));
  const prose = renderResultMarkdown('{"说明":"x|y # 不是标题"}');
  assert.ok(prose.includes("x|y"));
  assert.ok(prose.includes("# 不是标题"));
});

test("plain arrays become lists; nested objects climb headings then fall to bold labels", () => {
  const md = renderResultMarkdown('{"l1":{"l2":{"l3":{"l4":{"l5":"深"}}}},"arr":[1,2]}');
  assert.ok(md.includes("## l1"));
  assert.ok(md.includes("### l2"));
  assert.ok(md.includes("#### l3"));
  assert.ok(md.includes("**l4**"));
  assert.ok(md.includes("**l5**"));
  assert.ok(md.includes("深"));
  assert.ok(md.includes("- 1"));
});

test("empty object and array get their fixed labels", () => {
  const md = renderResultMarkdown('{"a":{},"b":[]}');
  assert.ok(md.includes("（空对象）"));
  assert.ok(md.includes("（空数组）"));
});

test("html document is complete, escaped, script-free", () => {
  const html = renderResultHtml('{"x":"<script>alert(1)</script>"}');
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.ok(html.includes('<meta charset="utf-8">'));
  assert.ok(html.includes("<title>结果</title>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("http://") && !html.includes("https://"));
});
