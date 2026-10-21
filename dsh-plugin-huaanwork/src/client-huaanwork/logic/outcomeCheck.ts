import { planModeActive, type PlanModeItem } from "./planConfirm.ts";

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

/** 文件路径可能带 Windows 盘符前缀（`C:\`、`C:/`），前缀可选、单独识别，避免把冒号放宽进整段路径。 */
const FILE_PATH = /(?:[A-Za-z]:[\\/])?[\w\u4e00-\u9fff./\\~-]+\.(?:md|txt|docx?|xlsx?|pptx?|csv|json|pdf|html?|tsx?|jsx?|py)\b/gi;
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

/** 路径是否出现在调用方列出的工作区目录树里。这是存在性核对，不打开文件。 */
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

/** 打开了项目就核对该目录；否则用会话自己的工作目录。两者都没有才算没读到工作区。 */
export function outcomeWorkspace(workspace: string | null | undefined, sessionCwd: string | null | undefined): string {
  if (typeof workspace === "string" && workspace.length > 0) return workspace;
  if (typeof sessionCwd === "string" && sessionCwd.length > 0) return sessionCwd;
  return "";
}

/** 列表里已有目录就用列表；刚铸出、列表还没跟上时用铸造时记下的目录。 */
export function lookupSessionCwd(
  sessionId: string | undefined,
  listed: readonly { id?: string; cwd?: string }[],
  remembered: ReadonlyMap<string, string>,
): string | undefined {
  const fromList = sessionId ? listed.find((row) => row.id === sessionId)?.cwd : undefined;
  if (typeof fromList === "string" && fromList.length > 0) return fromList;
  if (!sessionId) return undefined;
  const saved = remembered.get(sessionId);
  return typeof saved === "string" && saved.length > 0 ? saved : undefined;
}

/**
 * 回合结束核对读取工作区树的 depth 参数（与 App.tsx 的 listTree 调用一致）。
 * listTree 会展开到第 depth 层目录并列出它们的子项，所以树能覆盖到相对深度 depth + 1。
 */
export const WORKSPACE_SCAN_DEPTH = 6;

export type WorkspaceScan = { root?: string; depth?: number };

/**
 * 路径相对扫描根的层级。绝对路径（POSIX 的 `/` 或 Windows 盘符 `C:\`）需要 root 才能折算；
 * 根外或没有 root 时返回 undefined，保持「找不到就是缺失」的旧口径，不臆测未核对。
 */
function scanRelativeDepth(path: string, root: string | undefined): number | undefined {
  let wanted = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (wanted.startsWith("/") || /^[A-Za-z]:\//.test(wanted)) {
    if (typeof root !== "string" || root.length === 0) return undefined;
    const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalizedRoot) return undefined;
    if (wanted === normalizedRoot) return 0;
    if (!wanted.startsWith(`${normalizedRoot}/`)) return undefined;
    wanted = wanted.slice(normalizedRoot.length + 1);
  }
  return wanted.split("/").filter(Boolean).length;
}

/** 本回合核对出的缺项；工作区读不到时文件项如实记为未核对，不当作缺失。 */
export function turnGaps(
  checks: TurnChecks,
  tree: readonly TreeLike[],
  treeKnown = true,
  scan: WorkspaceScan = {},
): string[] {
  const commandGaps = outcomeGaps({
    requiredFiles: [],
    requiredCommands: checks.requiredCommands,
    toolResults: checks.toolResults,
    fileExists: () => false,
  });
  if (!treeKnown) {
    if (checks.requiredFiles.length > 0) {
      commandGaps.push(`没能读取工作区，文件未核对：${checks.requiredFiles.join("、")}`);
    }
    return commandGaps;
  }
  const paths = treePaths(tree);
  if (checks.requiredFiles.length > 0 && paths.length === 0) {
    commandGaps.push(`没能读取工作区，文件未核对：${checks.requiredFiles.join("、")}`);
    return commandGaps;
  }
  // 扫描深度之外的路径无法判断存在与否：如实记为未核对，不报「缺少文件」。
  const depth = scan.depth ?? WORKSPACE_SCAN_DEPTH;
  const deepestListed = depth + 1;
  const missing: string[] = [];
  const beyondScan: string[] = [];
  for (const file of checks.requiredFiles) {
    if (fileExistsInTree(paths, file)) continue;
    const relativeDepth = scanRelativeDepth(file, scan.root);
    if (relativeDepth !== undefined && relativeDepth > deepestListed) beyondScan.push(file);
    else missing.push(file);
  }
  return [
    ...outcomeGaps({ requiredFiles: missing, requiredCommands: [], toolResults: [], fileExists: () => false }),
    ...beyondScan.map((file) => `未核对（超出扫描深度）：${file}`),
    ...commandGaps,
  ];
}

/**
 * 回合结束时追加到对话里的核对句子；有缺项就不出现「已完成」。
 * 没有任何必核文件或命令时，只有本回合跑过工具或出现过计划卡才写「没有自动核对项」。
 */
export function turnOutcomeNotes(
  checks: TurnChecks,
  tree: readonly TreeLike[],
  treeKnown = true,
  scan: WorkspaceScan = {},
): string[] {
  const gaps = turnGaps(checks, tree, treeKnown, scan);
  const outcome = turnOutcomeLines({ requiredFiles: checks.requiredFiles, requiredCommands: checks.requiredCommands, gaps });
  if (outcome.done) {
    return [`已完成：自动核对 ${checks.requiredFiles.length + checks.requiredCommands.length} 项均通过`];
  }
  if (outcome.lines.length === 0 && checks.didWork) return [NO_AUTO_CHECK_TEXT];
  return outcome.lines;
}

/**
 * 计划模式还在等确认（模型已 `propose_plan`，计划尚未提交或批准）的回合不跑回合结束核对：
 * 这个回合只产出计划，真正的执行发生在批准后的下一回合。
 */
export function shouldCheckTurnOutcome(items: readonly PlanModeItem[]): boolean {
  return !planModeActive(items);
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

/**
 * 带会话 id 的事件写入绑定了该会话的标签。
 * 刚发出去、标签上的 sessionId 还没提交时，只有这次发送的会话（pendingSessionId）先落到当前空标签。
 * 当前标签已经绑了别的会话，或会话已从标签上删掉，就丢掉，不再画进当前对话。
 */
export function eventTargetTab(
  sessionId: string | undefined,
  tabs: readonly { id: string; sessionId?: string }[],
  liveTabId: string,
  pendingSessionId?: string | null,
): string | undefined {
  if (typeof sessionId === "string" && sessionId.length > 0) {
    const bound = tabs.find((tab) => tab.sessionId === sessionId)?.id;
    if (bound) return bound;
    const live = tabs.find((tab) => tab.id === liveTabId);
    if (live && !live.sessionId && sessionId === pendingSessionId) return live.id;
    return undefined;
  }
  return tabs.some((tab) => tab.id === liveTabId) ? liveTabId : undefined;
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
