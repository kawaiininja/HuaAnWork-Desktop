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
  // Markdown 表格先转义反斜杠，JSON.stringify 里的 \n 写成 \\n。
  assert.ok(md.includes(String.raw`{"k":"a\\nb"}`));
  assert.ok(md.includes("[1,2]"));
});

test("table cells escape pipes and flatten newlines; prose strings outside tables do not escape", () => {
  const table = renderResultMarkdown('[{"文本":"a|b\\nc"}]');
  assert.ok(table.includes("a\\|b c"));
  const prose = renderResultMarkdown('{"说明":"x|y # 不是标题"}');
  assert.ok(prose.includes("x|y"));
  assert.ok(prose.includes("# 不是标题"));
});

test("prose strings keep paragraph breaks: every newline form starts a new paragraph", () => {
  const source = '{"说明":"第一段\\n\\n第二段"}';
  const md = renderResultMarkdown(source);
  assert.ok(md.includes("第一段\n\n第二段"));
  const html = renderResultHtml(source);
  assert.ok(html.includes("<p>第一段</p><p>第二段</p>"));

  const mixed = renderResultMarkdown('{"说明":"甲\\r乙\\r\\n丙"}');
  assert.ok(mixed.includes("甲\n\n乙\n\n丙"));
});

test("table header names flatten CRLF, CR and LF to spaces", () => {
  const source = '[{"a\\nb":1,"c\\rd":2,"e\\r\\nf":3}]';
  const md = renderResultMarkdown(source);
  const header = md.split("\n").find((line) => line.startsWith("|")) ?? "";
  assert.equal(header, "| a b | c d | e f |");
  const html = renderResultHtml(source);
  assert.ok(html.includes("<th>a b</th><th>c d</th><th>e f</th>"));
});

test("lone carriage returns in table cells flatten to spaces", () => {
  const source = '[{"a":"x\\ry"}]';
  const md = renderResultMarkdown(source);
  assert.ok(md.includes("| x y |"));
  assert.ok(!md.includes("\r"));
  const html = renderResultHtml(source);
  assert.ok(html.includes("<td>x y</td>"));
});

test("markdown table escapes backslashes before pipes so a literal a\\|b cannot split the table", () => {
  const source = '[{"a":"a\\\\|b"}]';
  const md = renderResultMarkdown(source);
  assert.ok(md.includes(String.raw`| a\\\|b |`));
  const html = renderResultHtml(source);
  assert.ok(html.includes(String.raw`<td>a\|b</td>`));
});

test("__proto__ is skipped as a table column but kept as an object field", () => {
  const md = renderResultMarkdown('{"__proto__":"字段值","a":1}');
  const lines = md.split("\n");
  assert.ok(lines.includes("## __proto__"));
  assert.ok(lines.includes("字段值"));
  assert.ok(lines.includes("## a"));

  const table = renderResultMarkdown('[{"__proto__":9,"b":2}]');
  const header = table.split("\n").find((line) => line.startsWith("|")) ?? "";
  assert.equal(header, "| b |");
});

test("plain arrays become lists; nested objects climb headings then fall to bold labels", () => {
  const md = renderResultMarkdown('{"l1":{"l2":{"l3":{"l4":{"l5":"深"}}}},"arr":[1,2]}');
  const lines = md.split("\n");
  // 整行相等：任何把标题层级压平的实现都无法通过。
  assert.ok(lines.includes("## l1"));
  assert.ok(lines.includes("### l2"));
  assert.ok(lines.includes("#### l3"));
  assert.ok(lines.includes("**l4**"));
  assert.ok(lines.includes("**l5**"));
  assert.ok(lines.includes("深"));
  assert.ok(lines.includes("- 1"));
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
