export const PLAN_CARD_NOTE = "计划确认前，模型仍可能读取工作区；写入和命令继续走现有权限。";
export const AUTO_CONTINUE_LABEL = "按当前护栏自动继续";
export const PLAN_EXITED_NOTE = "已退出计划模式";

/** 对话只在宿主结果明确 `exited: true` 时记下退出。其它结果不记这条提示。 */
export function planExitNote(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  return (result as { exited?: unknown }).exited === true ? PLAN_EXITED_NOTE : undefined;
}

/** 计划判定只读 kind 与少量字段；App 的 ChatItem 可直接传入。 */
export type PlanModeItem = {
  kind: string;
  text?: string;
  card?: {
    name?: string;
    toolName?: string;
    autoContinue?: boolean;
    answered?: "approve" | "reject";
    /** 其它卡片字段（InputCard 等）不参与判定，只要求结构上可传入。 */
    [key: string]: unknown;
  };
};

/** 进入计划模式由 `propose_plan` 完成；计划被同意或用户点了「退出计划模式」后离开。 */
export function planModeActive(items: readonly PlanModeItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (!item) continue;
    if (item.kind === "note" && item.text === PLAN_EXITED_NOTE) return false;
    if (item.kind === "ask" && item.card?.toolName === "plan-review") {
      return !(item.card.autoContinue || item.card.answered === "approve");
    }
    if (item.kind === "tool" && item.card?.name === "propose_plan") return true;
  }
  return false;
}

export function planNeedsConfirm(input: {
  mode: "ask" | "smart" | "full";
  declaresAskTool: boolean;
  changesTarget: boolean;
}): boolean {
  if (input.mode === "ask") return true;
  if (input.mode === "smart") return input.declaresAskTool;
  return input.changesTarget;
}
