const ALERT_MS = 5 * 60 * 1000;

const THINKING_GRACE_MS = 2_000;

export function turnStatus(input: {
  latest: "reasoning" | "text" | "tool" | "quiet";
  runningTool: string | null;
  quietMs: number;
}): { text: string; alert: boolean } {
  if (input.runningTool) {
    return { text: `正在执行工具 ${input.runningTool}`, alert: input.quietMs >= ALERT_MS };
  }
  if (input.latest === "reasoning" && input.quietMs < THINKING_GRACE_MS) {
    return { text: "正在思考", alert: false };
  }
  const seconds = Math.max(1, Math.floor(input.quietMs / 1000));
  return { text: `已 ${seconds} 秒没有新结果`, alert: input.quietMs >= ALERT_MS };
}

/** 停止优先取消这次发送记下的会话；标签上的 sessionId 还没提交时用它，没有再退回标签。 */
export function resolveStopSession(pending: string | null | undefined, tabSession: string | undefined): string | undefined {
  const inflight = pending?.trim();
  if (inflight) return inflight;
  const onTab = tabSession?.trim();
  return onTab ? onTab : undefined;
}
