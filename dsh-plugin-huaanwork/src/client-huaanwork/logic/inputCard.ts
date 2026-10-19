/** `request_input` 在对话里的问题卡片：提交、取消或回合结束后不再接受回答。 */
export type InputCard = {
  question: string;
  sessionId: string;
  state: "open" | "answered" | "cancelled" | "closed";
  answer?: string;
};

type Item = { id: number; kind: string; card?: unknown };

function isOpenInput(item: Item): item is Item & { card: InputCard } {
  return item.kind === "input" && (item.card as InputCard | undefined)?.state === "open";
}

export function settleInputCard<T extends Item>(
  items: T[],
  id: number,
  state: "answered" | "cancelled" | "closed",
  answer?: string,
): T[] {
  const at = items.findIndex((item) => item.id === id && isOpenInput(item));
  if (at < 0) return items;
  const item = items[at] as T & { card: InputCard };
  const next = items.slice();
  next[at] = { ...item, card: { ...item.card, state, ...(answer === undefined ? {} : { answer }) } };
  return next;
}

/** 回合结束（成功、失败或停止）时，没人回答的问题关掉，按钮不再可点。 */
export function closeOpenInputs<T extends Item>(items: T[]): T[] {
  if (!items.some(isOpenInput)) return items;
  return items.map((item) => (isOpenInput(item) ? { ...item, card: { ...item.card, state: "closed" as const } } : item));
}

export function inputCardStatus(card: { state: InputCard["state"]; answer?: string }): string | undefined {
  if (card.state === "answered") return `已回答：${card.answer ?? ""}`;
  if (card.state === "cancelled") return "已取消";
  if (card.state === "closed") return "回合已结束，这个问题不再等待回答";
  return undefined;
}
