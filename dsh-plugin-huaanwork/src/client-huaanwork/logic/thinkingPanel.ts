const CLOSED_THINK = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
const OPEN_THINK = /<think(?:ing)?>[\s\S]*$/i;
const THINK_TAGS = ["<think>", "<thinking>", "</think>", "</thinking>"];

function holdIncompleteThinkTag(text: string): string {
  const lt = text.lastIndexOf("<");
  if (lt < 0) return text;
  const suffix = text.slice(lt);
  if (suffix.includes(">")) return text;
  const lower = suffix.toLowerCase();
  return THINK_TAGS.some((tag) => tag.startsWith(lower)) ? text.slice(0, lt) : text;
}

export function extractThinkBlocks(text: string): { visible: string; thought: string } {
  const head = holdIncompleteThinkTag(text);
  const parts: string[] = [];
  const withoutClosed = head.replace(CLOSED_THINK, (block) => {
    parts.push(block.replace(/<\/?think(?:ing)?>/gi, "").trim());
    return "";
  });
  const open = OPEN_THINK.exec(withoutClosed);
  const visible = open ? withoutClosed.slice(0, open.index) : withoutClosed;
  if (open) parts.push(open[0].replace(/<think(?:ing)?>/i, "").trim());
  return { visible, thought: parts.filter((part) => part.length > 0).join("\n") };
}

export function resolveThinking(input: { reasoning: string; assistantText: string }): { thought: string; visible: string } {
  const extracted = extractThinkBlocks(input.assistantText);
  const reasoning = input.reasoning.trim();
  if (reasoning.length > 0) return { thought: reasoning, visible: extracted.visible };
  return extracted;
}

export function thinkingChrome(input: {
  thought: string;
  hasAssistantText: boolean;
  userToggled: "expand" | "collapse" | null;
  interrupted: boolean;
  historical?: boolean;
}): { title: string; expanded: boolean } {
  const title = input.interrupted
    ? "思考 · 已中断"
    : input.historical
      ? "思考"
      : input.hasAssistantText
        ? "思考 · 已生成"
        : "思考";
  if (input.userToggled === "expand") return { title, expanded: true };
  if (input.userToggled === "collapse") return { title, expanded: false };
  if (input.historical) return { title, expanded: false };
  return { title, expanded: !input.hasAssistantText };
}

/** 用户取消或回合失败：只改当前用户消息之后的思考和正文，标题因此变成「思考 · 已中断」。 */
export function interruptTurnItems<T extends { kind: string; interrupted?: boolean }>(items: readonly T[]): T[] {
  let turnStart = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.kind === "user") {
      turnStart = i + 1;
      break;
    }
  }
  let changed = false;
  const next = items.map((item, index) => {
    if (index < turnStart) return item;
    if ((item.kind === "thinking" || item.kind === "assistant") && item.interrupted !== true) {
      changed = true;
      return { ...item, interrupted: true };
    }
    return item;
  });
  return changed ? next : [...items];
}

export function shouldRenderThinking(thought: string): boolean {
  return thought.trim().length > 0;
}

/** 把展开或收起记在思考条目上，切换标签后重挂载仍读得到。 */
export function withThinkingToggle<T extends { id: number; kind: string; userToggled?: "expand" | "collapse" }>(
  items: readonly T[],
  itemId: number,
  userToggled: "expand" | "collapse",
): T[] {
  const index = items.findIndex((item) => (item.kind === "thinking" || item.kind === "assistant") && item.id === itemId);
  if (index < 0) return items;
  const current = items[index];
  if (!current || current.userToggled === userToggled) return items;
  const next = items.slice();
  next[index] = { ...current, userToggled };
  return next;
}

/** 一回合的思考：已定稿的各步与当前步骤的草稿。 */
export type ThinkingSteps = { settled: string; draft: string };

function joinSteps(...parts: string[]): string {
  return parts.map((part) => part.trim()).filter((part) => part.length > 0).join("\n\n");
}

/** 非 final 追加到当前步骤；final 用全文替换当前步骤并定稿，之前定稿的步骤不动。 */
export function nextThinkingSteps(steps: ThinkingSteps, text: string, final: boolean): ThinkingSteps {
  if (final) return { settled: joinSteps(steps.settled, text), draft: "" };
  return { settled: steps.settled, draft: steps.draft + text };
}

/** 各步之间空一行，与重开历史时每条消息一块思考的文字一致。 */
export function thinkingStepsText(steps: ThinkingSteps): string {
  return joinSteps(steps.settled, steps.draft);
}

type TurnItem =
  | { kind: "thinking"; thought: string }
  | { kind: "assistant"; text: string }
  | { kind: "user" }
  | { kind: "tool" }
  | { kind: "ask" }
  | { kind: "input" }
  | { kind: "todo" }
  | { kind: "note" };

export function hasAssistantTextAfter(items: readonly TurnItem[], index: number): boolean {
  const current = items[index];
  if (current?.kind !== "thinking") return false;
  for (let i = index + 1; i < items.length; i += 1) {
    const item = items[i];
    if (item.kind === "user") return false;
    if (item.kind === "assistant") {
      const visible = resolveThinking({ reasoning: current.thought, assistantText: item.text }).visible.trim();
      if (visible.length > 0) return true;
    }
  }
  return false;
}
