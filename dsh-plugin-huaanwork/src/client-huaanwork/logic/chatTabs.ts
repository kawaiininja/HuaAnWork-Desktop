import type { InputCard } from "./inputCard.ts";

/** 当前标签还在列表里就留着；不在了就选第一个真实标签，不用预分配、尚未插入的 id。 */
export function resolveActiveTab(activeId: string, tabs: readonly { id: string }[]): string {
  if (tabs.some((tab) => tab.id === activeId)) return activeId;
  return tabs[0]?.id ?? activeId;
}

type CardView = {
  answered?: "approve" | "reject";
  autoContinue?: boolean;
  /** request_input 卡的状态;与 InputCard 同一联合,拼错即编译错误。 */
  state?: InputCard["state"];
};

/**
 * 是否还有等用户点击的卡片。退出登录据此禁用。
 * autoContinue 的计划卡由回答者按护栏自动同意，不渲染按钮，也永远不会被标成 answered，
 * 不能算作等待；只认还没回答的 ask 卡和仍打开的 request_input 卡。
 */
export function hasPendingAsk(
  tabs: readonly { items: readonly { kind: string; card?: unknown }[] }[],
): boolean {
  return tabs.some((tab) =>
    tab.items.some((item) => {
      const card = (item.card && typeof item.card === "object" ? item.card : {}) as CardView;
      if (item.kind === "ask") return !card.answered && !card.autoContinue;
      return item.kind === "input" && card.state === "open";
    }),
  );
}
