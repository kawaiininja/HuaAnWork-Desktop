/** 规格 §4.3：把已折叠的结果 JSON 转成块树，再分别渲染成 Markdown 与完整 HTML。 */
export type ResultBlock =
  | { kind: "heading"; text: string; level: 2 | 3 | 4 }
  | { kind: "bold-label"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "list"; items: string[] }
  | { kind: "empty"; text: string };

const MAX_HEADING_LEVEL = 4;

/** 单元格与列表项的压平文本：换行→空格；对象/数组一行 JSON.stringify；其余 String()。 */
function flattenCell(value: unknown): string {
  if (typeof value === "string") return value.replace(/\r?\n/g, " ");
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function objectKeysOf(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => key !== "__proto__");
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
  return [label, { kind: "paragraph", text: flattenCell(value) }];
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
      for (const key of objectKeysOf(row)) if (!columns.includes(key)) columns.push(key);
    }
    return [{
      kind: "table",
      columns,
      rows: rows.map((row) => columns.map((column) => (Object.hasOwn(row, column) ? flattenCell(row[column]) : ""))),
    }];
  }
  return [{ kind: "list", items: value.map(flattenCell) }];
}

export function jsonToBlocks(value: unknown): ResultBlock[] {
  if (Array.isArray(value)) return arrayBlocks(value);
  if (value !== null && typeof value === "object") return objectBlocks(value as Record<string, unknown>, 2);
  return [{ kind: "paragraph", text: flattenCell(value) }];
}

/** `|` 只在 Markdown 表格侧转义；正文保持原文。 */
const escapeCell = (text: string): string => text.replace(/\|/g, "\\|");

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
        for (const column of block.columns) body.push(`<th>${escapeHtml(column)}</th>`);
        body.push("</tr></thead><tbody>");
        for (const row of block.rows) {
          body.push("<tr>");
          for (const cell of row) body.push(`<td>${escapeHtml(cell)}</td>`);
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
