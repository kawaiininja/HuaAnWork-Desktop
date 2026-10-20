import type { InputCard } from "./inputCard.ts";

/** 当前标签还在列表里就留着；不在了就选第一个真实标签，不用预分配、尚未插入的 id。 */
export function resolveActiveTab(activeId: string, tabs: readonly { id: string }[]): string {
  if (tabs.some((tab) => tab.id === activeId)) return activeId;
  return tabs[0]?.id ?? activeId;
}

type CardView = {
  answered?: "approve" | "reject";
  autoContinue?: boolean;
  /** false = 这张卡没有可提交的审批（例:没人接的提问），不渲染按钮、也不算等待。 */
  actionable?: boolean;
  /** request_input 卡的状态;与 InputCard 同一联合,拼错即编译错误。 */
  state?: InputCard["state"];
};

/** 审批卡的展示字段子集（AskCard 的结构形状；工具卡/输入卡不必满足）。 */
export type ApprovalCardView = CardView & { approvalRequestId?: string; toolName?: string };

/**
 * 这张审批卡是否还在等用户点击。autoContinue 的计划卡由回答者按护栏自动同意，
 * 不渲染按钮，也永远不会被标成 answered;非 actionable 的说明卡同样不算等待。
 */
export function askCardWaitsForClick(card: ApprovalCardView): boolean {
  return card.answered === undefined && card.autoContinue !== true && card.actionable !== false;
}

/**
 * 是否还有等用户点击的卡片。退出登录据此禁用。
 * 只认还没回答的 ask 卡和仍打开的 request_input 卡。
 */
export function hasPendingAsk(
  tabs: readonly { items: readonly { kind: string; card?: unknown }[] }[],
): boolean {
  return tabs.some((tab) =>
    tab.items.some((item) => {
      const card = (item.card && typeof item.card === "object" ? item.card : {}) as ApprovalCardView;
      if (item.kind === "ask") return askCardWaitsForClick(card);
      return item.kind === "input" && card.state === "open";
    }),
  );
}

/** 已处理标记写回卡片的形状（ApprovalCard 的子集；工具卡/输入卡不必满足）。 */
type AnsweredCardView = { approvalRequestId?: string; answered?: "approve" | "reject" };

/**
 * 把「已处理」记到真正持有这张卡的条目上。App 的 `liveChatRef` 是「谁拥有当前流」，
 * 切标签后可能指向另一张;按 approvalRequestId 找卡片才能落在它自己的标签里。
 * 返回同一个数组表示没有命中（调用方据此跳过状态更新）。
 */
export function markApprovalAnswered<T extends { kind: string }>(
  items: readonly T[],
  approvalRequestId: string,
  decision: "approve" | "reject",
): readonly T[] {
  let changed = false;
  const next = items.map((item) => {
    const card = (item as { card?: AnsweredCardView }).card;
    if (item.kind !== "ask" || card?.approvalRequestId !== approvalRequestId) return item;
    changed = true;
    return { ...item, card: { ...card, answered: decision } } as T;
  });
  return changed ? next : items;
}
