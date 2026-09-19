/**
 * Task 11：missed 启动横幅的纯逻辑。
 *
 * N 口径（review C6，取最简口径）：N = 本次会话收到的 `automation/missed` 事件数，
 * **不**回填历史 `automation.list().missed` 记录。用户 dismiss 后横幅隐藏，且本次
 * 会话不再因后续 live 事件重新累积/展示——`nextMissedCount` 在 dismissed 时原样
 * 返回旧计数，App.tsx 收到事件也不会再次调用它去递增。
 */

/** 收到一次 `automation/missed` 事件后的下一个计数：已 dismiss 则不再累积。 */
export function nextMissedCount(count: number, dismissed: boolean): number {
  return dismissed ? count : count + 1;
}

/** 横幅展示态：可见性 + 展示计数。dismiss 后即隐藏，不会重新出现。 */
export function missedBannerView(count: number, dismissed: boolean): { visible: boolean; count: number } {
  return { visible: !dismissed && count > 0, count };
}
