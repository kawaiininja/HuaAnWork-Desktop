export const PLAN_CARD_NOTE = "计划确认前，模型仍可能读取工作区；写入和命令继续走现有权限。";
export const AUTO_CONTINUE_LABEL = "按当前护栏自动继续";

export function planNeedsConfirm(input: {
  mode: "ask" | "smart" | "full";
  declaresAskTool: boolean;
  changesTarget: boolean;
}): boolean {
  if (input.mode === "ask") return true;
  if (input.mode === "smart") return input.declaresAskTool;
  return input.changesTarget;
}
