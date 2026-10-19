const ALERT_MS = 5 * 60 * 1000;

const THINKING_GRACE_MS = 2_000;

export function turnStatus(input: {
  latest: "reasoning" | "text" | "tool" | "quiet";
  runningTool: string | null;
  quietMs: number;
}): { text: string; alert: boolean } {
  if (input.runningTool) return { text: `正在执行工具 ${input.runningTool}`, alert: false };
  if (input.latest === "reasoning" && input.quietMs < THINKING_GRACE_MS) {
    return { text: "正在思考", alert: false };
  }
  const seconds = Math.max(1, Math.floor(input.quietMs / 1000));
  return { text: `已 ${seconds} 秒没有新结果`, alert: input.quietMs >= ALERT_MS };
}
