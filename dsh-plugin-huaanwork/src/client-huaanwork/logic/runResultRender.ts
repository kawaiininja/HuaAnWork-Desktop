/** 规格 §4.3：把已折叠的结果 JSON 转成块树，再分别渲染成 Markdown 与完整 HTML。 */
export type ResultBlock =
  | { kind: "heading"; text: string; level: 2 | 3 | 4 }
  | { kind: "bold-label"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "list"; items: string[] }
  | { kind: "empty"; text: string };

const MAX_HEADING_LEVEL = 4;

/** 表格与列表的压平文本：CRLF、CR、LF 一律写成空格，避免拆开表格行或列表项。 */
const flattenLine = (text: string): string => text.replace(/\r\n|\r|\n/g, " ");

/** 非字符串值的文本形态：对象/数组一行 JSON.stringify；其余 String()。 */
function scalarText(value: unknown): string {
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * 表格单元格与列表项的压平文本：换行→空格（结构例外，原始换行会拆开表格行或列表项）；
 * 对象/数组一行 JSON.stringify；其余 String()。
 */
function flattenedText(value: unknown): string {
  return typeof value === "string" ? flattenLine(value) : scalarText(value);
}

/**
 * 正文段落（规格 §4.3「字符串按原文分段」）：按任意换行切成独立段落，
 * 不压平成空格、不裁剪原文；空行产生的空片段直接跳过。
 */
function paragraphBlocks(value: unknown): ResultBlock[] {
  if (typeof value !== "string") return [{ kind: "paragraph", text: scalarText(value) }];
  return value
    .split(/\r\n|\r|\n/)
    .filter((text) => text !== "")
    .map((text) => ({ kind: "paragraph", text }));
}

function objectKeysOf(value: Record<string, unknown>): string[] {
  return Object.keys(value);
}

/** 顶层字段从二级标题开始；嵌套对象逐级加一，超过四级改用加粗段落。 */
function labelBlock(key: string, level: number): ResultBlock {
  if (level > MAX_HEADING_LEVEL) return { kind: "bold-label", text: key };
  return { kind: "heading", text: key, level: level === 2 ? 2 : level === 3 ? 3 : 4 };
}

function fieldBlocks(key: string, value: unknown, level: number): ResultBlock[] {
  const label = labelBlock(key, level);
  if (Array.isArray(value)) return [label, ...arrayBlocks(value)];
  if (value !== null && typeof value === "object") {
    return [label, ...objectBlocks(value as Record<string, unknown>, level + 1)];
  }
  return [label, ...paragraphBlocks(value)];
}

function objectBlocks(value: Record<string, unknown>, level: number): ResultBlock[] {
  const keys = objectKeysOf(value);
  if (keys.length === 0) return [{ kind: "empty", text: "（空对象）" }];
  const blocks: ResultBlock[] = [];
  for (const key of keys) blocks.push(...fieldBlocks(key, value[key], level));
  return blocks;
}

function arrayBlocks(value: readonly unknown[]): ResultBlock[] {
  if (value.length === 0) return [{ kind: "empty", text: "（空数组）" }];
  if (value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) {
    const rows = value as readonly Record<string, unknown>[];
    const columns: string[] = [];
    for (const row of rows) {
      // 只有表格列收集跳过 __proto__；对象字段展开保留全部自有键（Object.keys 只返回自有属性）。
      for (const key of objectKeysOf(row)) if (key !== "__proto__" && !columns.includes(key)) columns.push(key);
    }
    return [{
      kind: "table",
      columns,
      rows: rows.map((row) => columns.map((column) => (Object.hasOwn(row, column) ? flattenedText(row[column]) : ""))),
    }];
  }
  return [{ kind: "list", items: value.map(flattenedText) }];
}

export function jsonToBlocks(value: unknown): ResultBlock[] {
  if (Array.isArray(value)) return arrayBlocks(value);
  if (value !== null && typeof value === "object") return objectBlocks(value as Record<string, unknown>, 2);
  return paragraphBlocks(value);
}

/** Markdown 表格文本：先压平换行，再转义反斜杠、最后转义竖线（`a\|b` 不会拆开表格）。 */
const escapeCell = (text: string): string =>
  flattenLine(text).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

export function blocksToMarkdown(blocks: readonly ResultBlock[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "heading":
        lines.push(`${"#".repeat(block.level)} ${block.text}`, "");
        break;
      case "bold-label":
        lines.push(`**${block.text}**`, "");
        break;
      case "paragraph":
        lines.push(block.text, "");
        break;
      case "table":
        lines.push(`| ${block.columns.map(escapeCell).join(" | ")} |`);
        lines.push(`| ${block.columns.map(() => "---").join(" | ")} |`);
        for (const row of block.rows) lines.push(`| ${row.map(escapeCell).join(" | ")} |`);
        lines.push("");
        break;
      case "list":
        for (const item of block.items) lines.push(`- ${item}`);
        lines.push("");
        break;
      case "empty":
        lines.push(block.text, "");
        break;
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** HTML 表格文本：与 Markdown 同一份压平文本，再做 HTML 转义。 */
const escapeTableCellHtml = (text: string): string => escapeHtml(flattenLine(text));

export function blocksToHtmlDocument(blocks: readonly ResultBlock[]): string {
  const body: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "heading":
        body.push(`<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`);
        break;
      case "bold-label":
        body.push(`<p><strong>${escapeHtml(block.text)}</strong></p>`);
        break;
      case "paragraph":
        body.push(`<p>${escapeHtml(block.text)}</p>`);
        break;
      case "table":
        body.push("<table><thead><tr>");
        for (const column of block.columns) body.push(`<th>${escapeTableCellHtml(column)}</th>`);
        body.push("</tr></thead><tbody>");
        for (const row of block.rows) {
          body.push("<tr>");
          for (const cell of row) body.push(`<td>${escapeTableCellHtml(cell)}</td>`);
          body.push("</tr>");
        }
        body.push("</tbody></table>");
        break;
      case "list":
        body.push(`<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
        break;
      case "empty":
        body.push(`<p>${escapeHtml(block.text)}</p>`);
        break;
    }
  }
  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>结果</title>",
    "<style>body{font-family:system-ui,-apple-system,sans-serif;margin:24px;color:#1f2328}table{border-collapse:collapse;margin:8px 0}th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left}h2,h3,h4{margin:20px 0 8px}</style>",
    "</head>",
    `<body>${body.join("")}</body>`,
    "</html>",
  ].join("");
}

export function renderResultMarkdown(sourceText: string): string {
  return blocksToMarkdown(jsonToBlocks(JSON.parse(sourceText)));
}

export function renderResultHtml(sourceText: string): string {
  return blocksToHtmlDocument(jsonToBlocks(JSON.parse(sourceText)));
}
