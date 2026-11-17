import type { ReactElement } from "react";

import type { ProgressPanelModel, ProgressTaskView } from "./logic/progressPanel.ts";
import { isSubagentRunActive, subagentNeedsStartTime } from "./logic/subagentRuns.ts";
import type { PanelToggle } from "./logic/toolPanel.ts";
import { SubagentRunSummary } from "./SubagentRunCard.tsx";
import ToolPanel from "./ToolPanel.tsx";

/** 分步任务的展示状态文案；没有单步百分比。 */
const TASK_STATUS_TEXT: Record<ProgressTaskView["displayStatus"], string> = {
  completed: "已完成",
  in_progress: "进行中",
  interrupted: "已中断",
  pending: "未开始",
};

export type ProgressPanelProps = {
  model: ProgressPanelModel;
  now: number;
  frozenAt?: number;
  confirmingRunId: string | null;
  cancelBusyByRunId: Readonly<Record<string, boolean>>;
  cancelErrorByRunId: Readonly<Record<string, string>>;
  onToggleActivity(anchorId: number, next: PanelToggle): void;
  onRequestCancel(runId: string): void;
  onConfirmCancel(runId: string): void;
  onDismissCancel(runId: string): void;
};

/**
 * 右栏「进度」窄栏：连接状态、分步任务、当前回合工具活动与受管子代理运行。
 *
 * 任务只显示 `completed/total` 计数与展示状态，不构造单步百分比；活动直接复用
 * `ToolPanel` 的面板/切换回调；子代理复用 `SubagentRunSummary` 与 App 持有的
 * `confirmingRunId`/忙态/错误，不另建取消 reducer 或确认状态。
 */
export default function ProgressPanel(props: ProgressPanelProps): ReactElement {
  const {
    model,
    now,
    frozenAt,
    confirmingRunId,
    cancelBusyByRunId,
    cancelErrorByRunId,
    onToggleActivity,
    onRequestCancel,
    onConfirmCancel,
    onDismissCancel,
  } = props;

  return (
    <div className="panel-card progress-panel" data-connection={model.connection}>
      {model.connection === "live" ? null : (
        <p
          className={`progress-connection is-${model.connection}`}
          role="status"
          aria-live="polite"
        >
          {model.connection === "disconnected"
            ? "连接中断，状态可能不是最新"
            : "正在重新连接，状态可能不是最新"}
        </p>
      )}

      <section className="progress-section" aria-label="分步任务">
        <div className="progress-section-head">
          <p className="h">分步任务</p>
          {model.taskPhase === "ready" ? (
            <span className="progress-count">
              已完成 {model.completedCount}/{model.totalCount}
            </span>
          ) : null}
        </div>
        {model.taskPhase === "waiting" ? (
          <p className="panel-empty">等待任务步骤…</p>
        ) : model.taskPhase === "empty" ? (
          <p className="panel-empty">当前回合还没有任务步骤</p>
        ) : model.tasks.length === 0 ? (
          <p className="panel-empty">本轮任务列表为空</p>
        ) : (
          <ul className="progress-task-list">
            {model.tasks.map((task, index) => (
              <li
                key={`${index}-${task.content}`}
                className="progress-task"
                data-status={task.displayStatus}
              >
                <span className="progress-task-content">{task.content}</span>
                <span className="progress-task-status">
                  {TASK_STATUS_TEXT[task.displayStatus]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="progress-section" aria-label="当前执行活动">
        <p className="h">当前执行活动</p>
        {model.activity.length === 0 ? (
          <p className="panel-empty">当前回合还没有工具活动</p>
        ) : (
          <div className="progress-activity-list">
            {model.activity.map((panel) => (
              <ToolPanel key={panel.anchorId} panel={panel} onToggle={onToggleActivity} />
            ))}
          </div>
        )}
      </section>

      <section className="progress-section" aria-label="子代理">
        <p className="h">子代理</p>
        {model.subagents.length === 0 ? (
          <p className="panel-empty">当前没有子代理运行</p>
        ) : (
          <div className="progress-subagent-list">
            {model.subagents.map((run) => {
              const terminal = !isSubagentRunActive(run) && run.stale !== true;
              return (
                <div
                  key={run.runId}
                  className="subagent-run-card progress-subagent-card"
                  data-phase={run.phase}
                  data-stale={!terminal && run.stale === true ? "true" : undefined}
                  data-frozen={!terminal && frozenAt !== undefined ? "true" : undefined}
                >
                  <SubagentRunSummary
                    run={run}
                    now={now}
                    frozenAt={frozenAt}
                    duplicateLabel={subagentNeedsStartTime(run, model.subagents)}
                    confirming={confirmingRunId === run.runId}
                    cancelBusy={cancelBusyByRunId[run.runId] === true || run.phase === "stopping"}
                    cancelError={cancelErrorByRunId[run.runId]}
                    onRequestCancel={onRequestCancel}
                    onConfirmCancel={onConfirmCancel}
                    onDismissCancel={onDismissCancel}
                  />
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
