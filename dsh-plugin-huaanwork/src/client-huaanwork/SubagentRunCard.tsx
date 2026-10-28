import { useEffect, useLayoutEffect, useRef } from "react";
import type { ReactElement } from "react";

import {
  formatRunStartedAt,
  isSubagentRunActive,
  subagentAlerts,
  subagentElapsedMs,
  subagentStatusDetail,
  subagentStatusText,
  subagentToolSummary,
  type SubagentRunAlert,
  type SubagentRunView,
} from "./logic/subagentRuns.ts";
import type { SubagentToolActivity } from "./rpc-types.ts";

/** Host 重启后旧代际卡片的固定说明：只说明结果未确认，不猜终态。 */
const STALE_TEXT = "状态不可恢复 · Host 已重启，结果未确认";
/** WS 断连到 snapshot 对账完成之间的固定说明。 */
const FROZEN_TEXT = "连接中断，状态可能滞后";
const INACTIVITY_ALERT_CODE = "inactive";

export type SubagentRunCardProps = {
  run: SubagentRunView;
  now: number;
  frozenAt?: number;
  duplicateLabel: boolean;
  expanded: boolean;
  confirming: boolean;
  cancelBusy: boolean;
  cancelError?: string;
  onToggleExpanded(runId: string): void;
  onRequestCancel(runId: string): void;
  onConfirmCancel(runId: string): void;
  onDismissCancel(runId: string): void;
};

/**
 * 单次显式 `@` 调用的运行卡（Task 10）。
 *
 * 活跃卡三行：身份 + 终止、真实状态 + 工具摘要 + 惰性耗时、最近活动 + 展开；
 * 终态收为单行，展开后显示失败、清理告警与结束时的在途工具。stale（Host 重启）
 * 与断连冻结都保留最后已知状态并禁用终止，不把未知结果画成成功或失败。
 * `expanded`、`confirming` 等 UI 状态由调用方按 runId 持有，本组件不缓存。
 */
export default function SubagentRunCard(props: SubagentRunCardProps): ReactElement {
  const {
    run,
    now,
    frozenAt,
    duplicateLabel,
    expanded,
    confirming,
    cancelBusy,
    cancelError,
    onToggleExpanded,
    onRequestCancel,
    onConfirmCancel,
    onDismissCancel,
  } = props;

  const active = isSubagentRunActive(run);
  const stale = run.stale === true;
  const terminal = !active && !stale;
  const cancellable = active && frozenAt === undefined;
  const showConfirm = confirming && active && !stale;
  const controlsDisabled = !cancellable || cancelBusy;

  const terminateRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const wasConfirmingRef = useRef(false);
  const autoDismissedRef = useRef(false);

  // 确认区挂载时聚焦「取消」；Esc/取消关闭后只在调用方明确要求时归还焦点。
  useLayoutEffect(() => {
    if (showConfirm) {
      wasConfirmingRef.current = true;
      cancelRef.current?.focus();
      return;
    }
    if (!wasConfirmingRef.current) return;
    wasConfirmingRef.current = false;
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    terminateRef.current?.focus();
  }, [showConfirm]);

  // 确认期间 run 已终态或失效：只关闭确认，绝不发送取消请求。
  useEffect(() => {
    if (!confirming) {
      autoDismissedRef.current = false;
      return;
    }
    if ((active && !stale) || autoDismissedRef.current) return;
    autoDismissedRef.current = true;
    onDismissCancel(run.runId);
  }, [confirming, active, stale, onDismissCancel, run.runId]);

  // window 级 Esc 只存在于确认区生命周期内（沿用 MarketSourcePanel 的既有模式）。
  useEffect(() => {
    if (!showConfirm) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      restoreFocusRef.current = true;
      onDismissCancel(run.runId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showConfirm, onDismissCancel, run.runId]);

  const dismissWithFocus = (): void => {
    restoreFocusRef.current = true;
    onDismissCancel(run.runId);
  };

  const duplicateSuffix = duplicateLabel
    ? `，开始于 ${formatRunStartedAt(run.startedAt)}`
    : "";
  const terminateName = `终止 ${run.label} 本次运行${duplicateSuffix}`;
  const expandName = `${expanded ? "收起" : "展开"} ${run.label} 详情${duplicateSuffix}`;
  const confirmText = `确认终止 ${run.label}${duplicateSuffix}`;

  const alerts = subagentAlerts(run, now).filter(
    (alert) =>
      !(stale || frozenAt !== undefined) || alert.code !== INACTIVITY_ALERT_CODE,
  );
  const visibleAlerts = terminal
    ? expanded
      ? alerts
      : []
    : expanded
      ? alerts
      : alerts.slice(0, 1);

  // 取消 RPC 错误属于活跃操作；终态详情只保留执行失败与真实清理告警。
  const visibleCancelError = terminal ? undefined : cancelError;
  const alertElements = buildAlertElements(visibleCancelError, visibleAlerts);
  const sortedTools = [...run.activeTools].sort(compareTools);
  const elapsed = formatElapsed(subagentElapsedMs(run, now, frozenAt));
  const statusDetail = subagentStatusDetail(run);
  const showStatusDetail = !stale && statusDetail !== undefined;
  const lastKnownStatus = subagentStatusText(run);
  // 读屏播报只含状态 + 在途工具摘要（不含计时、最近活动与提醒），且由相位/工具决定，
  // 同一份运行状态下重渲染不改变文本。
  const liveStatusText = stale ? STALE_TEXT : toolSummaryStatus(run);
  const hasTerminalDetails =
    (run.failure !== undefined && run.failure !== "") ||
    alerts.length > 0 ||
    sortedTools.length > 0 ||
    visibleCancelError !== undefined;
  const showExpand = !terminal || hasTerminalDetails;

  const expandButton = (): ReactElement => (
    <button
      type="button"
      className="subagent-run-expand"
      aria-expanded={expanded}
      aria-label={expandName}
      onClick={() => onToggleExpanded(run.runId)}
    >
      {expanded ? "收起详情" : "展开详情"}
    </button>
  );

  const toolList = (): ReactElement => (
    <ul className="subagent-run-tools">
      {sortedTools.map((tool) => (
        <li key={tool.id}>{tool.name}</li>
      ))}
    </ul>
  );

  // 常驻根节点的读屏状态区：活跃与终态共用同一个 DOM 节点，插入内容与区域同在时
  // 也不会漏播报；可见状态文本保持可见但不承担 live region。
  const liveRegion = (): ReactElement => (
    <span
      className="subagent-run-sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {liveStatusText}
    </span>
  );

  if (terminal) {
    return (
      <div
        className="subagent-run-card"
        data-phase={run.phase}
      >
        {liveRegion()}
        <div className="subagent-run-compact">
          <span className="subagent-run-dot" aria-hidden="true" />
          <span className="subagent-run-label" title={run.label}>
            {run.label}
          </span>
          {duplicateLabel ? (
            <span className="subagent-run-meta">{formatRunStartedAt(run.startedAt)}</span>
          ) : null}
          {run.kind === "package" && run.packageVersion !== undefined ? (
            <span className="subagent-run-meta">v{run.packageVersion}</span>
          ) : null}
          <span className="subagent-run-status">{liveStatusText}</span>
          <span className="subagent-run-meta">{elapsed}</span>
          {showExpand ? expandButton() : null}
        </div>
        {expanded && hasTerminalDetails ? (
          <div className="subagent-run-details">
            {run.failure !== undefined && run.failure !== "" ? (
              <p className="subagent-run-failure">{run.failure}</p>
            ) : null}
            {alertElements}
            {sortedTools.length > 0 ? toolList() : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="subagent-run-card"
      data-phase={run.phase}
      data-stale={stale ? "true" : undefined}
      data-frozen={frozenAt === undefined ? undefined : "true"}
    >
      {liveRegion()}
      <div className="subagent-run-header">
        <span className="subagent-run-dot" aria-hidden="true" />
        <span className="subagent-run-label" title={run.label}>
          {run.label}
        </span>
        {duplicateLabel ? (
          <span className="subagent-run-meta">{formatRunStartedAt(run.startedAt)}</span>
        ) : null}
        {run.kind === "package" && run.packageVersion !== undefined ? (
          <span className="subagent-run-meta">v{run.packageVersion}</span>
        ) : null}
        {showConfirm ? (
          <span className="subagent-run-actions">
            <button
              type="button"
              className="subagent-run-terminate"
              disabled={controlsDisabled}
              onClick={() => onConfirmCancel(run.runId)}
            >
              {confirmText}
            </button>
            <button
              type="button"
              className="subagent-run-terminate"
              ref={cancelRef}
              onClick={dismissWithFocus}
            >
              取消
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="subagent-run-terminate"
            ref={terminateRef}
            aria-label={terminateName}
            disabled={controlsDisabled}
            onClick={() => onRequestCancel(run.runId)}
          >
            终止
          </button>
        )}
      </div>

      <div className="subagent-run-status">
        <span className="subagent-run-status-text">{liveStatusText}</span>
        {showStatusDetail ? (
          <span className="subagent-run-detail">{statusDetail}</span>
        ) : null}
        <span className="subagent-run-meta">{elapsed}</span>
      </div>

      <div className="subagent-run-foot">
        {stale ? (
          <span>最后状态：{lastKnownStatus}</span>
        ) : (
          <span>最近活动 {formatActivityAgo(lastActivityMs(run, now, frozenAt))}</span>
        )}
        {frozenAt !== undefined && !stale ? <span>· {FROZEN_TEXT}</span> : null}
        {showExpand ? expandButton() : null}
      </div>

      {alertElements.length > 0 ? (
        <div className="subagent-run-details">{alertElements}</div>
      ) : null}

      {expanded && sortedTools.length > 0 ? toolList() : null}
    </div>
  );
}

/** 状态 + 在途工具摘要；两者都只由相位与工具集合决定，不随时钟变化。 */
function toolSummaryStatus(run: SubagentRunView): string {
  const status = subagentStatusText(run);
  if (!isSubagentRunActive(run)) return status;
  const summary = subagentToolSummary(run.activeTools).text;
  if (summary === "") return status;
  // 多工具摘要本身已以「正在执行 N 个工具」开头；tool 相位直接用它，
  // 避免渲染成「正在执行工具 · 正在执行 N 个工具 · …」。单工具仍保留相位前缀。
  if (run.phase === "tool" && summary.startsWith("正在执行")) return summary;
  return `${status} · ${summary}`;
}

/** 最近活动的展示时长：60 秒以内按秒，其余按整分钟。 */
function formatActivityAgo(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds} 秒前`;
  return `${Math.floor(seconds / 60)} 分钟前`;
}

/** 显示用总耗时（mm:ss，超过一小时为 H:mm:ss）；冻结语义由 subagentElapsedMs 负责。 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const pad = (value: number): string => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** 最近活动同样随断连/失效冻结，避免重连前倒计时继续走。 */
function lastActivityMs(run: SubagentRunView, now: number, frozenAt?: number): number {
  const freeze = run.stale === true && run.staleAt !== undefined ? run.staleAt : frozenAt;
  const end = Math.min(now, run.endedAt ?? now, freeze ?? now);
  return Math.max(0, end - (run.lastActivity ?? run.startedAt));
}

function compareTools(left: SubagentToolActivity, right: SubagentToolActivity): number {
  if (left.startedAt !== right.startedAt) return left.startedAt - right.startedAt;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/**
 * 提醒横幅：真实 error（含 cancelError）合并进唯一一个 `role="alert"` 容器，
 * 一次播报全部失败；info 提醒保持静态文本，不与状态区域重复播报。
 */
function buildAlertElements(
  cancelError: string | undefined,
  alerts: SubagentRunAlert[],
): ReactElement[] {
  const errors: Array<{ key: string; text: string }> = [];
  const infos: Array<{ key: string; text: string }> = [];
  if (cancelError !== undefined) {
    errors.push({ key: "cancel-error", text: cancelError });
  }
  alerts.forEach((alert, index) => {
    const item = { key: `${alert.code}-${index}`, text: alert.text };
    if (alert.severity === "error") errors.push(item);
    else infos.push(item);
  });

  const elements: ReactElement[] = [];
  if (errors.length > 0) {
    elements.push(
      <div key="alert-group" className="subagent-run-alert is-error" role="alert">
        {errors.map((item) => (
          <p key={item.key}>{item.text}</p>
        ))}
      </div>,
    );
  }
  for (const item of infos) {
    elements.push(
      <p key={item.key} className="subagent-run-alert is-info">
        {item.text}
      </p>,
    );
  }
  return elements;
}
