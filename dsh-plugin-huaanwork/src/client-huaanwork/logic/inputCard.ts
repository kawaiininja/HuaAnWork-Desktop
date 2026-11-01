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

export function latestOpenInput(items: readonly Item[]): (Item & { card: InputCard }) | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (isOpenInput(item)) return item;
  }
  return undefined;
}

export function appendOpenInput<T extends Item>(items: T[], id: number, question: string, sessionId: string): T[] {
  return [
    ...closeOpenInputs(items),
    { id, kind: "input", card: { question, sessionId, state: "open" } } as T,
  ];
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
  if (card.state === "closed") return "问题已关闭，不再等待回答";
  return undefined;
}

export type ComposerSubmissionResult =
  | { kind: "message" }
  | { kind: "empty" }
  | { kind: "answer"; answered: boolean };

export async function dispatchComposerSubmission(
  items: readonly Item[],
  draft: string,
  handlers: {
    answer: (itemId: number, card: InputCard, answer: string) => Promise<boolean>;
    send: () => Promise<void>;
  },
): Promise<ComposerSubmissionResult> {
  const pending = latestOpenInput(items);
  if (!pending) {
    await handlers.send();
    return { kind: "message" };
  }
  const answer = draft.trim();
  if (!answer) return { kind: "empty" };
  const answered = await handlers.answer(pending.id, pending.card, answer);
  return { kind: "answer", answered };
}
