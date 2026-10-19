export const GOAL_ROUND_LIMIT = 4;

export function goalRoundLabel(round: number): string {
  return `正在按目标继续，第 ${round}/${GOAL_ROUND_LIMIT} 轮，这还不是验收结果`;
}

export function goalRoundStopped(round: number, gaps: readonly string[]): string {
  const pending = gaps.length > 0 ? gaps.join("；") : "无";
  return `已停在第 ${round}/${GOAL_ROUND_LIMIT} 轮。尚未核对：${pending}`;
}
