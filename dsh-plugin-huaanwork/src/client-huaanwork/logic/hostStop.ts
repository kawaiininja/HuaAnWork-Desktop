/**
 * 执行进程停止后的展示决策。`ok | suspect | stoppable` 仍是探活判据；
 * `stopped` 是用户确认停止后的终态，不是故障——主窗口聚焦时 `notifyAttention`
 * 不弹提示，横幅必须自己给出中性文案，且不能再显示「执行进程无响应」与结束按钮。
 */

import type { LivenessPhase } from "../../huaanwork-host/host-liveness.ts";

/** 与宿主探活/预加载共用的同一联合，避免三处各自维护字面量。 */
export type HostLivenessPhase = LivenessPhase;

export const HOST_STOPPED_BY_USER_TEXT = "执行进程已按你的要求结束";
export const HOST_UNRESPONSIVE_TEXT = "执行进程无响应";
export const HOST_EXIT_NOTE = "执行进程已结束。结果可能不完整。";

export type HostLivenessNotice =
  | { kind: "none" }
  | { kind: "unresponsive"; canStop: boolean }
  | { kind: "stopped"; text: string };

/** 主横幅/侧栏提示：`stopped` 只给中性文案，其余非 ok 相位给无响应提示。 */
export function hostLivenessNotice(phase: HostLivenessPhase): HostLivenessNotice {
  if (phase === "ok") return { kind: "none" };
  if (phase === "stopped") return { kind: "stopped", text: HOST_STOPPED_BY_USER_TEXT };
  return { kind: "unresponsive", canStop: phase === "stoppable" };
}

/**
 * 用户确认停止后的失败标记撤回。套接字关闭可能先于 `stopped` 相位到达：
 * `onSidecarExit` 不知道这是主动停止，先把标签标成失败（红色横幅）。停止确认
 * 到达时必须撤回它，否则中性终态上会一直挂着「会话已失败」。
 * 返回同一个数组表示没有需要撤回的标记（调用方据此跳过状态更新）。
 */
export function clearFailureOnStopped<T extends { sessionFailed: boolean }>(
  phase: HostLivenessPhase,
  tabs: readonly T[],
): readonly T[] {
  if (phase !== "stopped") return tabs;
  if (!tabs.some((tab) => tab.sessionFailed)) return tabs;
  return tabs.map((tab) => (tab.sessionFailed ? { ...tab, sessionFailed: false } : tab));
}

/**
 * Host 套接字关闭时给每个有内容的标签补的脚注。用户主动停止走中性脚注且不把
 * 标签标成失败（失败标签会触发红色「会话已失败」横幅，误报成崩溃）。
 */
export function hostExitNotice(stoppedByUser: boolean): { text: string; sessionFailed: boolean } {
  return stoppedByUser
    ? { text: HOST_STOPPED_BY_USER_TEXT, sessionFailed: false }
    : { text: HOST_EXIT_NOTE, sessionFailed: true };
}
