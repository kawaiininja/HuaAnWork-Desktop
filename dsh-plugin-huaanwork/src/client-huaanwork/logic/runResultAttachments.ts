/** 规格 §4.1/§4.2：整段助手回复是 JSON 对象或数组时收起为两份固定附件。 */
export const RESULT_ATTACHMENT_FILES = ["结果.md", "结果.html"] as const;
export type ResultAttachmentFile = (typeof RESULT_ATTACHMENT_FILES)[number];

/** 与宿主 automations-host.ts 的 stripModelThinking 同规则：去闭合块、丢未闭合块及其后文本。 */
export function stripThinkingForResult(text: string): string {
  const closed = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = closed.indexOf("<think>");
  return open >= 0 ? closed.slice(0, open) : closed;
}

export function collectAssistantText(items: readonly { kind: string; text?: string }[]): string {
  return items
    .filter((item) => item.kind === "assistant")
    .map((item) => item.text ?? "")
    .join("");
}

export function isJsonResultText(text: string): boolean {
  const stripped = stripThinkingForResult(text).trim();
  if (!stripped) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return false;
  }
  return typeof parsed === "object" && parsed !== null;
}

/** 不可折叠时原引用返回；可折叠时删掉全部 assistant，在第一个被删位置插入附件项。 */
export function foldRunAssistantItems<T extends { kind: string }>(
  items: readonly T[],
  createAttachment: (sourceText: string) => T,
): readonly T[] {
  if (!items.some((item) => item.kind === "assistant")) return items;
  const sourceText = stripThinkingForResult(
    collectAssistantText(items as readonly { kind: string; text?: string }[]),
  ).trim();
  if (!isJsonResultText(sourceText)) return items;
  const first = items.findIndex((item) => item.kind === "assistant");
  const rest = items.filter((item) => item.kind !== "assistant");
  return [...rest.slice(0, first), createAttachment(sourceText), ...rest.slice(first)];
}

/**
 * 折叠后的附件项在「按对话内容判断」的视图里等价于一整段助手正文：
 * 思考面板靠它判断本轮是否已有可见产出（`hasAssistantTextAfter`），回合核对
 * 不读 assistant，所以映射成 assistant 不改变核对结果。位置与 id 原样保留。
 */
export function attachmentAsAssistant(item: { id: number; sourceText: string }): {
  id: number;
  kind: "assistant";
  text: string;
} {
  return { id: item.id, kind: "assistant", text: item.sourceText };
}
