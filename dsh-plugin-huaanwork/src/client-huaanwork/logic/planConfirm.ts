export const PLAN_CARD_NOTE = "计划确认前，模型仍可能读取工作区；写入和命令继续走现有权限。";
export const AUTO_CONTINUE_LABEL = "按当前护栏自动继续";
export const PLAN_EXITED_NOTE = "已退出计划模式";

/** 对话只在宿主结果明确 `exited: true` 时记下退出。其它结果不记这条提示。 */
export function planExitNote(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  return (result as { exited?: unknown }).exited === true ? PLAN_EXITED_NOTE : undefined;
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
