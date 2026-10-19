import { resultTextFailed } from "./commandOutcome.ts";

export function outcomeGaps(input: {
  requiredFiles: readonly string[];
  requiredCommands: readonly string[];
  toolResults: readonly { name: string; command?: string; isError: boolean }[];
  fileExists: (path: string) => boolean;
}): string[] {
  const gaps: string[] = [];
  for (const file of input.requiredFiles) {
    if (!input.fileExists(file)) gaps.push(`缺少文件：${file}`);
  }
  for (const command of input.requiredCommands) {
    // 同一命令跑过几次，以最后一次的结果为准。
    const result = input.toolResults.findLast((item) => item.command === command);
    if (!result || result.isError) gaps.push(`命令未通过：${command}`);
  }
  return gaps;
}

const FILE_PATH = /[\w\u4e00-\u9fff./\\~-]+\.(?:md|txt|docx?|xlsx?|pptx?|csv|json|pdf|html?|tsx?|jsx?|py)\b/gi;
const LEADING_CJK = /^[\u4e00-\u9fff]+/;
/** 句子里紧挨文件名的动词；的、和、与、及、或会进文件名，不在这里切开。 */
const NAME_BOUNDARY = /[到把在为成叫进入给存写至于将]/g;

/** 「帮我把总结写到报告.md」里文件名是「报告.md」：去掉连写在前面的中文句子。 */
function stripLeadingSentence(match: string): string {
  const run = LEADING_CJK.exec(match)?.[0] ?? "";
  let cut = 0;
  for (const boundary of run.matchAll(NAME_BOUNDARY)) cut = (boundary.index ?? 0) + 1;
  return cut > 0 && cut < match.length ? match.slice(cut) : match;
}
const COMMAND_SPAN = /`([^`\n]+)`/g;
const COMMAND_START = /^(?:pnpm|npm|yarn|corepack|npx|node|python3?|pytest|cargo|go|make|bun|deno|git)\s/;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** 只认文字里明确写出的文件路径（用户原文，或计划卡写明的产物路径）。 */
export function extractRequiredFiles(text: string): string[] {
  return unique((text.match(FILE_PATH) ?? []).map(stripLeadingSentence));
}

/** 只认用反引号写明、且以常见命令行工具开头的命令。 */
export function extractRequiredCommands(text: string): string[] {
  const commands: string[] = [];
  for (const match of text.matchAll(COMMAND_SPAN)) {
    const command = (match[1] ?? "").trim();
    if (COMMAND_START.test(command)) commands.push(command);
  }
  return unique(commands);
}

type TreeLike = { path: string; children?: readonly TreeLike[] };

export function treePaths(nodes: readonly TreeLike[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    paths.push(node.path.replace(/\\/g, "/"));
    if (node.children) paths.push(...treePaths(node.children));
  }
  return paths;
}

export function fileExistsInTree(paths: readonly string[], file: string): boolean {
  const wanted = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return paths.some((path) => path === wanted || path.endsWith(`/${wanted}`));
}

export const NO_AUTO_CHECK_TEXT = "没有自动核对项，需要你自己看";

/** Gaps block "已完成". Empty required lists are not a pass; the caller decides the no-check sentence. */
export function turnOutcomeLines(input: {
  requiredFiles: readonly string[];
  requiredCommands: readonly string[];
  gaps: readonly string[];
}): { done: boolean; lines: string[] } {
  if (input.gaps.length > 0) return { done: false, lines: [...input.gaps] };
  if (input.requiredFiles.length === 0 && input.requiredCommands.length === 0) {
    return { done: false, lines: [] };
  }
  return { done: true, lines: [] };
}

export type TodoStatus = "pending" | "in_progress" | "completed";

const TODO_LABELS: Record<TodoStatus, string> = {
  pending: "待做",
  in_progress: "进行中",
  completed: "已勾选",
};

export function todoLabel(status: string): string {
  return TODO_LABELS[status as TodoStatus] ?? TODO_LABELS.pending;
}

export type TodoEntry = { content: string; status: TodoStatus };

type TurnItem =
  | { kind: "user"; text: string }
  | { kind: "ask"; card: { toolName: string; summary?: string } }
  | { kind: "tool"; card: { name: string; command?: string; isError?: boolean; status?: "start" | "end" } }
  | { kind: "assistant" | "thinking" | "note" | "todo" | "input" };

export type TurnChecks = {
  requiredFiles: string[];
  requiredCommands: string[];
  toolResults: { name: string; command?: string; isError: boolean }[];
  /** 本回合跑过工具，或出现过计划评审卡。纯聊天为 false。 */
  didWork: boolean;
};

/** 本回合（最后一条用户消息之后）要核对的文件、命令与已记录的工具结果。 */
export function turnChecks(items: readonly TurnItem[]): TurnChecks {
  let start = 0;
  let userText = "";
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.kind === "user") {
      start = i + 1;
      userText = item.text;
      break;
    }
  }
  const files = extractRequiredFiles(userText);
  const toolResults: TurnChecks["toolResults"] = [];
  let didWork = false;
  for (const item of items.slice(start)) {
    if (item.kind === "ask" && item.card.toolName === "plan-review") {
      didWork = true;
      if (item.card.summary) files.push(...extractRequiredFiles(item.card.summary));
    } else if (item.kind === "tool") {
      didWork = true;
      toolResults.push({
        name: item.card.name,
        ...(item.card.command === undefined ? {} : { command: item.card.command }),
        // 没结束的工具卡不算通过。
        isError: item.card.isError === true || item.card.status === "start",
      });
    }
  }
  return { requiredFiles: unique(files), requiredCommands: extractRequiredCommands(userText), toolResults, didWork };
}

/** 本回合核对出的缺项；工作区读不到时文件项如实记为未核对，不当作缺失。 */
export function turnGaps(checks: TurnChecks, tree: readonly TreeLike[]): string[] {
  const paths = treePaths(tree);
  const unreadable = checks.requiredFiles.length > 0 && paths.length === 0;
  const gaps = outcomeGaps({
    requiredFiles: unreadable ? [] : checks.requiredFiles,
    requiredCommands: checks.requiredCommands,
    toolResults: checks.toolResults,
    fileExists: (path) => fileExistsInTree(paths, path),
  });
  if (unreadable) gaps.push(`没能读取工作区，文件未核对：${checks.requiredFiles.join("、")}`);
  return gaps;
}

/**
 * 回合结束时追加到对话里的核对句子；有缺项就不出现「已完成」。
 * 没有任何必核文件或命令时，只有本回合跑过工具或出现过计划卡才写「没有自动核对项」。
 */
export function turnOutcomeNotes(checks: TurnChecks, tree: readonly TreeLike[]): string[] {
  const gaps = turnGaps(checks, tree);
  const outcome = turnOutcomeLines({ requiredFiles: checks.requiredFiles, requiredCommands: checks.requiredCommands, gaps });
  if (outcome.done) {
    return [`已完成：自动核对 ${checks.requiredFiles.length + checks.requiredCommands.length} 项均通过`];
  }
  if (outcome.lines.length === 0 && checks.didWork) return [NO_AUTO_CHECK_TEXT];
  return outcome.lines;
}

type DetailRecord =
  | { kind: "tool-call"; name: string; callId?: string; command?: string }
  | { kind: "tool-result"; callId?: string; isError: boolean; text: string }
  | { kind: "user" | "thinking" | "assistant" };

/** 会话日志详情 → 核对输入：只认带 command 的 shell 调用；没有配对结果的调用不算通过。 */
export function toolResultsFromRecords(records: readonly DetailRecord[]): TurnChecks["toolResults"] {
  const results: TurnChecks["toolResults"] = [];
  records.forEach((record, index) => {
    if (record.kind !== "tool-call" || record.command === undefined) return;
    const paired = records.slice(index + 1).find(
      (candidate) => candidate.kind === "tool-result" && record.callId !== undefined && candidate.callId === record.callId,
    );
    results.push({
      name: record.name,
      command: record.command,
      isError: paired === undefined || paired.kind !== "tool-result" || paired.isError || resultTextFailed(paired.text),
    });
  });
  return results;
}

/**
 * 回合结束的核对只写进用户对话标签：会话 id 存在却不属于任何对话标签（子代理空闲也会发 session/end），
 * 或落在自动化运行标签上，一律不写；没有会话 id 时才回落到当前对话标签。
 */
export function outcomeTargetTab(
  sessionId: string | undefined,
  tabs: readonly { id: string; sessionId?: string; automationId?: string }[],
  liveTabId: string,
): string | undefined {
  const tab = sessionId ? tabs.find((candidate) => candidate.sessionId === sessionId) : tabs.find((candidate) => candidate.id === liveTabId);
  return tab && !tab.automationId ? tab.id : undefined;
}

export function latestUserItemId(items: readonly { id: number; kind: string }[]): number | undefined {
  return items.findLast((item) => item.kind === "user")?.id;
}

/** 异步核对返回时，标签上已有更新的用户消息就丢掉上一回合的结论。 */
export function appendOutcomeNotes<T extends { id: number; kind: string }>(
  items: readonly T[],
  turnUserId: number | undefined,
  notes: readonly T[],
): readonly T[] {
  return latestUserItemId(items) === turnUserId ? [...items, ...notes] : items;
}
