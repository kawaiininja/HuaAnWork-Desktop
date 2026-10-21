/**
 * 自动化在途表(规格 §8)。按 runId 索引,纯内存、无依赖。
 *
 * 写入点是真正入队的 `dispatchEnqueue` 同步段(跨根放弃在到达之前已 return),
 * `executeRun` 的同步段读它做取消检查并翻到 `started`,`finishAutomation`
 * 在运行记录落盘后摘除条目。停止、删除拒绝与档位消费(Task 8)共用这张表。
 */
export type InFlightRun = {
  automationId: string
  runId: string
  trigger: 'schedule' | 'catchup' | 'manual'
  phase: 'queued' | 'started'
  cancelRequested: boolean
  slotConsumed: boolean
}

export const inFlightRuns = new Map<string, InFlightRun>()

export function startInFlightRun(entry: InFlightRun): void {
  inFlightRuns.set(entry.runId, entry)
}

export function inFlightRunsOf(automationId: string): InFlightRun[] {
  return [...inFlightRuns.values()].filter((entry) => entry.automationId === automationId)
}
