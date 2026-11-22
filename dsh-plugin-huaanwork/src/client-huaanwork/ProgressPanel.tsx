import type { ReactElement } from "react";

import ExpertTeamRunCard, {
  type ExpertTeamCancelRequest,
  type ExpertTeamCancelTarget,
  type ExpertTeamMemberCancelRequest,
} from "./ExpertTeamRunCard.tsx";
import type { ProgressPanelModel, ProgressTaskView } from "./logic/progressPanel.ts";
import { isSubagentRunActive, subagentNeedsStartTime } from "./logic/subagentRuns.ts";
import type { PanelToggle } from "./logic/toolPanel.ts";
import { SubagentRunSummary, type SubagentConfirmTarget } from "./SubagentRunCard.tsx";
import type { SubagentRunView } from "./logic/subagentRuns.ts";
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
  /** App 持有的唯一确认目标；右栏只在确认由右栏发起时展示确认区。 */
  confirmingTarget: SubagentConfirmTarget | null;
  cancelBusyByRunId: Readonly<Record<string, boolean>>;
  cancelErrorByRunId: Readonly<Record<string, string>>;
  onToggleActivity(anchorId: number, next: PanelToggle): void;
  onRequestCancel(runId: string): void;
  onConfirmCancel(runId: string): void;
  onDismissCancel(runId: string): void;
  /** 专家团连接的断连冻结态；缺省视为正常。 */
  expertTeamConnection?: "open" | "closed";
  /** 专家团断连冻结时刻（毫秒），只冻结耗时显示。 */
  expertTeamFrozenAt?: number;
  /** 团队成员 run 投影，供聚合卡的成员行显示真实相位。 */
  expertTeamMemberRuns?: readonly SubagentRunView[];
  expertTeamExpandedResults?: Readonly<Record<string, boolean>>;
  expertTeamConfirming?: ExpertTeamCancelTarget | null;
  expertTeamCancelBusyByKey?: Readonly<Record<string, boolean>>;
  expertTeamCancelErrorByKey?: Readonly<Record<string, string>>;
  onToggleTeamResult?(resultId: string): void;
  onRequestCancelTeam?(input: ExpertTeamCancelRequest): void;
  onRequestCancelMember?(input: ExpertTeamMemberCancelRequest): void;
  onConfirmTeamCancel?(target: ExpertTeamCancelTarget): void;
  onDismissTeamCancel?(): void;
  onPreviewArtifact?(artifactId: string): void;
};

/**
 * 右栏「进度」窄栏：连接状态、分步任务、当前回合工具活动与受管子代理运行。
 *
 * 任务只显示 `completed/total` 计数与展示状态，不构造单步百分比；`Y > 0` 时顶部
 * 显示总进度条（规格 §8.1）。活动直接复用 `ToolPanel` 的面板/切换回调；子代理复用
 * `SubagentRunSummary` 与 App 持有的确认目标/忙态/错误，确认区只在右栏发起时出现。
 */
export default function ProgressPanel(props: ProgressPanelProps): ReactElement {
  const {
    model,
    now,
    frozenAt,
    confirmingTarget,
    cancelBusyByRunId,
    cancelErrorByRunId,
    onToggleActivity,
    onRequestCancel,
    onConfirmCancel,
    onDismissCancel,
    expertTeamConnection = "open",
    expertTeamFrozenAt,
    expertTeamMemberRuns = [],
    expertTeamExpandedResults = {},
    expertTeamConfirming = null,
    expertTeamCancelBusyByKey = {},
    expertTeamCancelErrorByKey = {},
    onToggleTeamResult,
    onRequestCancelTeam,
    onRequestCancelMember,
    onConfirmTeamCancel,
    onDismissTeamCancel,
    onPreviewArtifact,
  } = props;

  const expertTeams = model.expertTeams ?? [];

  return (
    <div
      className="panel-card progress-panel"
      data-connection={model.connection}
      data-turn-anchor={model.currentTurnClientMessageId}
    >
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
        {model.taskPhase === "ready" && model.totalCount > 0 ? (
          <progress
            className="progress-total-bar"
            value={model.completedCount}
            max={model.totalCount}
            aria-label={`总进度 ${model.completedCount}/${model.totalCount}`}
          />
        ) : null}
        {model.taskPhase === "waiting" ? (
          <p className="panel-empty">正在等待任务拆解</p>
        ) : model.taskPhase === "empty" ? (
          <p className="panel-empty">暂无任务拆解</p>
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
              <ToolPanel
                key={panel.anchorId}
                panel={panel}
                onToggle={onToggleActivity}
                idPrefix="progress"
              />
            ))}
          </div>
        )}
      </section>

      {expertTeams.length > 0 ? (
        <section className="progress-section" aria-label="专家团">
          <p className="h">专家团</p>
          <div className="progress-expert-team-list">
            {expertTeams.map((run) => (
              <ExpertTeamRunCard
                key={run.teamRunId}
                run={run}
                now={now}
                connection={expertTeamConnection}
                {...(expertTeamFrozenAt === undefined ? {} : { frozenAt: expertTeamFrozenAt })}
                surface="progress"
                memberRuns={expertTeamMemberRuns}
                expandedResultIds={expertTeamExpandedResults}
                confirming={expertTeamConfirming}
                cancelBusyByKey={expertTeamCancelBusyByKey}
                cancelErrorByKey={expertTeamCancelErrorByKey}
                {...(onToggleTeamResult === undefined ? {} : { onToggleResult: onToggleTeamResult })}
                {...(onRequestCancelTeam === undefined ? {} : { onRequestCancelTeam })}
                {...(onRequestCancelMember === undefined ? {} : { onRequestCancelMember })}
                {...(onConfirmTeamCancel === undefined ? {} : { onConfirmCancel: onConfirmTeamCancel })}
                {...(onDismissTeamCancel === undefined ? {} : { onDismissCancel: onDismissTeamCancel })}
                {...(onPreviewArtifact === undefined ? {} : { onPreviewArtifact })}
              />
            ))}
          </div>
        </section>
      ) : null}

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
                  data-run-id={run.runId}
                  data-phase={run.phase}
                  data-stale={!terminal && run.stale === true ? "true" : undefined}
                  data-frozen={!terminal && frozenAt !== undefined ? "true" : undefined}
                >
                  <SubagentRunSummary
                    run={run}
                    now={now}
                    frozenAt={frozenAt}
                    duplicateLabel={subagentNeedsStartTime(run, model.subagents)}
                    confirming={confirmingTarget?.runId === run.runId && confirmingTarget.surface === "progress"}
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
