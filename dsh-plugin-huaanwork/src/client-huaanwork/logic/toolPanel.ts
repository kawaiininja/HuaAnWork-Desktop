import type { GoalPhase, GoalTurnAction } from "./goalRound.ts";
import { resolveThinking } from "./thinkingPanel.ts";

export type PanelToggle = "expand" | "collapse";

export type ToolPanelCard = {
  key: string;
  name: string;
  callId?: string;
  status: "start" | "end";
  args?: string;
  output?: string;
  command?: string;
  hasResult?: boolean;
  truncated?: boolean;
  isError?: boolean;
  interrupted?: boolean;
  unconfirmed?: boolean;
  resultMissing?: boolean;
};

export type ToolPanelItem =
  | { id: number; kind: "tool"; card: ToolPanelCard; panelToggled?: PanelToggle; text?: string }
  | {
      id: number;
      kind: "user" | "assistant" | "thinking" | "todo" | "ask" | "input" | "attachment" | "agent-confirm" | "subagent-run" | "note";
      card?: unknown;
      panelToggled?: PanelToggle;
      text?: string;
      sourceText?: string;
    };

export type ToolEntryStatus = "running" | "done" | "failed" | "interrupted" | "unconfirmed" | "resultMissing";

export function toolPanelCard(item: ToolPanelItem): ToolPanelCard | undefined {
  if (item.kind !== "tool" || item.card === null || typeof item.card !== "object") return undefined;
  return item.card as ToolPanelCard;
}

export function toolEntryStatus(card: ToolPanelCard, connectionLost: boolean): ToolEntryStatus {
  if (card.resultMissing === true) return "resultMissing";
  // 历史合成中断结果以 status="end" 落卡；实时迟到的真实终态会先清除 interrupted。
  if (card.interrupted === true) return "interrupted";
  if (card.status === "end") return card.isError === true ? "failed" : "done";
  if (card.unconfirmed === true || connectionLost) return "unconfirmed";
  return "running";
}

/** 当前用户回合的起始下标；供回合投影与结算复用。 */
export function currentTurnStart(items: readonly ToolPanelItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === "user") return index + 1;
  }
  return 0;
}

export function applyToolEnd<T extends ToolPanelItem>(
  items: readonly T[],
  event: { name: string; callId?: string; text?: string; truncated?: boolean; isError?: true },
): T[] {
  // 无 callId 时也从全部条目选择最早同名开始态；迟到终态不能错套到新用户回合。
  let match = -1;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    const card = toolPanelCard(item);
    if (!card || card.status !== "start") continue;
    const matches = event.callId
      ? card.callId === event.callId
      : card.name === event.name;
    if (matches) {
      match = index;
      break;
    }
  }
  if (match < 0) return items as T[];
  const next = items.slice();
  const item = next[match];
  const card = item ? toolPanelCard(item) : undefined;
  if (!item || !card) return items as T[];
  const {
    interrupted: _interrupted,
    unconfirmed: _unconfirmed,
    resultMissing: _resultMissing,
    truncated: _truncated,
    isError: _isError,
    ...preserved
  } = card;
  next[match] = {
    ...item,
    card: {
      ...preserved,
      status: "end",
      hasResult: true,
      output: event.text ?? "",
      ...(event.truncated === true ? { truncated: true } : {}),
      ...(event.isError === true ? { isError: true } : {}),
    },
  } as T;
  return next;
}

export function withToolPanelToggle<T extends ToolPanelItem>(
  items: readonly T[],
  anchorId: number,
  panelToggled: PanelToggle,
): readonly T[] {
  const index = items.findIndex((item) => item.kind === "tool" && item.id === anchorId);
  if (index < 0) return items;
  const current = items[index];
  if (!current || current.panelToggled === panelToggled) return items;
  const next = items.slice();
  next[index] = { ...current, panelToggled };
  return next;
}

export type TurnFinalEvent =
  | { kind: "session-end"; ok: boolean; cancelled: boolean }
  | { kind: "goal-action"; action: GoalTurnAction }
  | { kind: "run-end"; interrupted: boolean };

export function reduceTurnFinal(
  current: boolean | undefined,
  event: TurnFinalEvent,
  phase: GoalPhase | undefined,
): boolean {
  if (current === true) return true;
  if (event.kind === "goal-action") return event.action.kind !== "none";
  if (event.kind === "run-end") return true;
  if (!event.ok || event.cancelled) return true;
  return phase !== "active";
}

function finalizeTurnTools<T extends ToolPanelItem>(items: readonly T[], mode: "interrupted" | "unconfirmed"): T[] {
  const start = currentTurnStart(items);
  let changed = false;
  const next = items.map((item, index) => {
    const card = index >= start ? toolPanelCard(item) : undefined;
    if (!card || card.status !== "start") return item;
    if (mode === "interrupted") {
      if (card.interrupted === true) return item;
      changed = true;
      const { unconfirmed: _unconfirmed, ...preserved } = card;
      return { ...item, card: { ...preserved, interrupted: true } } as T;
    }
    if (card.interrupted === true || card.unconfirmed === true) return item;
    changed = true;
    return { ...item, card: { ...card, unconfirmed: true } } as T;
  });
  return changed ? next : items as T[];
}

export function applyTurnFinalToTabs<
  I extends ToolPanelItem,
  T extends {
    id: string;
    items: I[];
    turnFinalByUserId?: Readonly<Record<number, boolean>>;
    turnFinalWithoutUser?: boolean;
  },
>(
  tabs: readonly T[],
  tabId: string | undefined,
  event: TurnFinalEvent,
  phase: GoalPhase | undefined,
): T[] {
  if (!tabId) return tabs as T[];
  const tab = tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return tabs as T[];
  let userId: number | undefined;
  for (let index = tab.items.length - 1; index >= 0; index -= 1) {
    if (tab.items[index]?.kind === "user") {
      userId = tab.items[index]?.id;
      break;
    }
  }
  const wasFinal = userId === undefined
    ? tab.turnFinalWithoutUser === true
    : tab.turnFinalByUserId?.[userId] === true;
  if (!reduceTurnFinal(wasFinal, event, phase)) return tabs as T[];
  if (wasFinal) return tabs as T[];
  const interrupted = event.kind === "session-end"
    ? !event.ok || event.cancelled
    : event.kind === "run-end" && event.interrupted;
  const items = finalizeTurnTools(tab.items, interrupted ? "interrupted" : "unconfirmed");
  return tabs.map((candidate) => candidate.id === tabId
    ? {
        ...candidate,
        items,
        ...(userId === undefined
          ? { turnFinalWithoutUser: true }
          : { turnFinalByUserId: { ...candidate.turnFinalByUserId, [userId]: true } }),
      }
    : candidate);
}

export function historicalTurnFinalByUserId(items: readonly { id: number; kind: string }[]): Record<number, true> {
  return Object.fromEntries(items.flatMap((item) => item.kind === "user" ? [[item.id, true] as const] : []));
}

/** 当前回合仍在运行的工具名；断连只会把未结束的工具降为「未确认」，不再算运行中。 */
export function runningToolName(items: readonly ToolPanelItem[], connectionLost: boolean): string | null {
  const start = currentTurnStart(items);
  for (let index = items.length - 1; index >= start; index -= 1) {
    const item = items[index];
    const card = item ? toolPanelCard(item) : undefined;
    if (card && toolEntryStatus(card, connectionLost) === "running") return card.name;
  }
  return null;
}

/** 当前回合存在状态未知的工具（断连或回合终结时没有结果）：回合条如实说「未确认」。 */
export function toolsUnconfirmed(items: readonly ToolPanelItem[], connectionLost: boolean): boolean {
  const start = currentTurnStart(items);
  return items.some((item, index) => {
    const card = index >= start ? toolPanelCard(item) : undefined;
    return card !== undefined && toolEntryStatus(card, connectionLost) === "unconfirmed";
  });
}

export type ToolEntryView = {
  id: number;
  key: string;
  name: string;
  description: string;
  status: ToolEntryStatus;
  statusText: string;
  args?: string;
  result: string;
  truncated: boolean;
};

export type ToolPanelView = {
  anchorId: number;
  count: number;
  status: ToolEntryStatus;
  title: string;
  expanded: boolean;
  panelToggled: PanelToggle | null;
  tools: ToolEntryView[];
};

export type ToolPanelRow<T extends ToolPanelItem> =
  | { kind: "item"; index: number; item: Exclude<T, { kind: "tool" }> }
  | { kind: "panel"; id: number; panel: ToolPanelView };

export type ToolPanelContentItem = { id: number; kind: string; text?: string };

const DESCRIPTION_GROUPS: Array<[readonly string[], string]> = [
  [["read", "read_file"], "正在读取文件"],
  [["glob", "grep"], "正在搜索内容"],
  [["edit", "write", "str_replace_editor"], "正在修改文件"],
  [["bash", "pwsh"], "正在运行命令"],
  [["skill"], "正在执行技能"],
  [["subagent"], "正在调用子代理"],
  [["todo_write"], "正在更新待办"],
  [["get_goal", "create_goal", "update_goal"], "正在处理目标"],
  [["git_status", "git_diff", "git_branch", "git_checkout", "git_commit", "git_push"], "正在执行 Git 操作"],
  [["web_fetch"], "正在读取网页"],
  [["screenshot"], "正在获取截图"],
  [["call_host_tool"], "正在调用宿主工具"],
  [["propose_plan", "exit_plan_mode"], "正在处理计划"],
  [["request_input"], "正在请求输入"],
];

const DESCRIPTIONS = new Map(DESCRIPTION_GROUPS.flatMap(([names, description]) => names.map((name) => [name, description] as const)));
const STATUS_TEXT: Record<ToolEntryStatus, string> = {
  running: "运行中",
  done: "完成",
  failed: "失败",
  interrupted: "已中断",
  unconfirmed: "状态未确认",
  resultMissing: "结果未记录",
};
const PANEL_TEXT: Record<ToolEntryStatus, string> = {
  running: "执行中",
  done: "已完成",
  failed: "含失败调用",
  interrupted: "已中断",
  unconfirmed: "状态未确认",
  resultMissing: "结果未记录",
};
const STATUS_PRIORITY: readonly ToolEntryStatus[] = ["running", "failed", "interrupted", "unconfirmed", "resultMissing", "done"];

export function toolDescription(name: string): string {
  return DESCRIPTIONS.get(name) ?? "正在执行工具";
}

function toolEntryView(id: number, card: ToolPanelCard, connectionLost: boolean): ToolEntryView {
  const status = toolEntryStatus(card, connectionLost);
  const result = status === "resultMissing"
    ? "历史记录未保存结果"
    : status === "running"
      ? "等待执行结果"
      : status === "interrupted" || status === "unconfirmed"
        ? STATUS_TEXT[status]
        : card.hasResult === true && card.output
          ? card.output
          : "无输出";
  return {
    id,
    key: card.key,
    name: card.name,
    description: toolDescription(card.name),
    status,
    statusText: STATUS_TEXT[status],
    ...(card.args === undefined ? {} : { args: card.args }),
    result,
    truncated: card.truncated === true,
  };
}

export function projectToolPanels<T extends ToolPanelItem>(
  items: readonly T[],
  options: {
    contentItems: readonly ToolPanelContentItem[];
    turnFinalByUserId?: Readonly<Record<number, boolean>>;
    turnFinalWithoutUser?: boolean;
    connectionLost: boolean;
  },
): ToolPanelRow<T>[] {
  type Segment = { start: number; end: number; userId?: number; final: boolean };
  const segments: Segment[] = [];
  let start = 0;
  let userId: number | undefined;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item?.kind !== "user") continue;
    if (index > start) segments.push({ start, end: index, userId, final: true });
    start = index;
    userId = item.id;
  }
  segments.push({
    start,
    end: items.length,
    userId,
    final: userId === undefined
      ? options.turnFinalWithoutUser === true
      : options.turnFinalByUserId?.[userId] === true,
  });

  const rows: ToolPanelRow<T>[] = [];
  for (const segment of segments) {
    const ids = new Set<number>();
    const toolIndexes: number[] = [];
    for (let index = segment.start; index < segment.end; index += 1) {
      const item = items[index];
      if (!item) continue;
      ids.add(item.id);
      if (item.kind === "tool") toolIndexes.push(index);
    }
    // 终态回合的默认展开已由 `final` 决定，正文探测只在非终态分支被消费。
    const hasVisibleAssistant = segment.final ? false : options.contentItems.some((item) =>
      ids.has(item.id)
      && item.kind === "assistant"
      && resolveThinking({ reasoning: "", assistantText: item.text ?? "" }).visible.trim().length > 0
    );
    const anchorIndex = toolIndexes[0];
    for (let index = segment.start; index < segment.end; index += 1) {
      const item = items[index];
      if (!item) continue;
      if (index === anchorIndex) {
        const anchor = item;
        const tools = toolIndexes.flatMap((toolIndex) => {
          const source = items[toolIndex];
          const card = source ? toolPanelCard(source) : undefined;
          return source && card ? [toolEntryView(source.id, card, options.connectionLost)] : [];
        });
        const statuses = tools.map((tool) => tool.status);
        const status = STATUS_PRIORITY.find((candidate) => statuses.includes(candidate)) ?? "done";
        const panelToggled = anchor.panelToggled ?? null;
        rows.push({
          kind: "panel",
          id: anchor.id,
          panel: {
            anchorId: anchor.id,
            count: tools.length,
            status,
            title: `工具 · ${PANEL_TEXT[status]} · ${tools.length} 项调用`,
            expanded: panelToggled === "expand"
              ? true
              : panelToggled === "collapse"
                ? false
                : !segment.final && !hasVisibleAssistant,
            panelToggled,
            tools,
          },
        });
        continue;
      }
      if (item.kind === "tool") continue;
      rows.push({ kind: "item", index, item: item as Exclude<T, { kind: "tool" }> });
    }
  }
  return rows;
}
