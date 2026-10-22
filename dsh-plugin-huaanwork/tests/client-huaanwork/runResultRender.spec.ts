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
  // Markdown 表格先转义反斜杠，JSON.stringify 里的 \n 从一条反斜杠加倍成两条。
  assert.ok(md.includes(String.raw`{"k":"a\\nb"}`));
  assert.ok(md.includes("\\[1,2\\]"));
});

test("table cells escape pipes and flatten newlines; inline prose characters are preserved", () => {
  const table = renderResultMarkdown('[{"文本":"a|b\\nc"}]');
  assert.ok(table.includes("a\\|b c"));
  const prose = renderResultMarkdown('{"说明":"x|y # 不是标题"}');
  assert.ok(prose.includes("x|y"));
  assert.ok(prose.includes("# 不是标题"));
});

test("markdown text escapes structure-changing characters so the downloaded file renders literally", () => {
  const source =
    '{"说明":"# 标题\\n- 列表项\\n1. 有序项\\n2) 括号有序项\\n> 引用\\n`代码` <script>x</script> *强调* _下划线_ [链接] & 实体"}';
  const md = renderResultMarkdown(source);
  assert.ok(md.includes("\\# 标题"));
  assert.ok(md.includes("\\- 列表项"));
  assert.ok(md.includes("1\\. 有序项"));
  assert.ok(md.includes("2\\) 括号有序项"));
  assert.ok(md.includes("\\> 引用"));
  assert.ok(md.includes("\\`代码\\`"));
  assert.ok(md.includes("\\<script>"));
  assert.ok(md.includes("\\*强调\\*"));
  assert.ok(md.includes("\\_下划线\\_"));
  assert.ok(md.includes("\\[链接\\]"));
  assert.ok(md.includes("\\& 实体"));
  // 结构化解释必须消失：不能出现行首标题、未转义的 HTML 或裸代码围栏。
  assert.ok(!md.includes("\n# 标题"));
  assert.ok(!/(^|[^\\])<script>/.test(md));
});

test("ordered markers with a closing paren are escaped as well as dotted markers", () => {
  const md = renderResultMarkdown('{"说明":"1) first\\n2) second"}');
  assert.ok(md.includes("1\\) first"));
  assert.ok(md.includes("2\\) second"));
  // 转义后行首不再残留可被 GFM 解析成有序列表的标记。
  assert.ok(!/^\s*\d+[.)]\s/m.test(md));
});

test("a trailing heading hash is escaped so it stays in the heading text", () => {
  // `## Title #` 会被 GFM 当成闭合标记，渲染成 `Title`；转义后才是 `Title #`。
  assert.ok(renderResultMarkdown('{"Title #":"v"}').includes("## Title \\#"));
  assert.ok(renderResultMarkdown('{"Title ##":"v"}').includes("## Title \\#\\#"));
});

test("standalone heading and thematic-break markers are escaped", () => {
  const md = renderResultMarkdown('{"说明":"####\\n---"}');
  assert.ok(md.includes("\\####"));
  assert.ok(md.includes("\\---"));
});

test("table cells escape markdown text as well as pipes", () => {
  const md = renderResultMarkdown('[{"文本":"<b> & *x* _y_ [z]"}]');
  assert.ok(md.includes("\\<b>"));
  assert.ok(md.includes("\\&"));
  assert.ok(md.includes("\\*x\\*"));
  assert.ok(md.includes("\\_y\\_"));
  assert.ok(md.includes("\\[z\\]"));
});

test("object field names with newlines flatten into one heading label", () => {
  const md = renderResultMarkdown('{"a\\nb":1}');
  assert.ok(md.includes("## a b"));
  assert.ok(!md.includes("## a\nb"));
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
  assert.ok(lines.includes("## \\_\\_proto\\_\\_"));
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

test("an array of empty objects does not render a columnless table", () => {
  const md = renderResultMarkdown('[{}]');
  assert.ok(md.includes("（空对象）"));
  assert.ok(!md.includes("|  |"));
  const html = renderResultHtml('[{}]');
  assert.ok(html.includes("<p>（空对象）</p>"));
  assert.ok(!html.includes("<table>"));
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

test("html document uses a light canvas so dark app themes keep text contrast", () => {
  const html = renderResultHtml('{"x":"正文"}');
  assert.ok(html.includes("color-scheme:light"));
  assert.ok(html.includes("background:#fff"));
  assert.ok(html.includes("color:#1f2328"));
});

test("html escapes text in headings, tables and lists too", () => {
  const html = renderResultHtml('{"<h>":"<x>","t":[{"<c>":"<v>"}],"l":["<i>"]}');
  assert.ok(html.includes("<h2>&lt;h&gt;</h2>"));
  assert.ok(html.includes("<th>&lt;c&gt;</th>"));
  assert.ok(html.includes("<td>&lt;v&gt;</td>"));
  assert.ok(html.includes("<li>&lt;i&gt;</li>"));
});
