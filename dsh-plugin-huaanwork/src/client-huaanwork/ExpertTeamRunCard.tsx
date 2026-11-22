import type { ReactElement } from "react";

import { expertTeamCounts } from "./logic/expertTeamRuns.ts";
import { subagentStatusText, type SubagentRunView } from "./logic/subagentRuns.ts";
import type { ExpertTeamResult, ExpertTeamRun } from "./rpc-types.ts";

/**
 * 专家团聚合运行卡（设计 §13.1 / §13.2 / §13.3）。
 *
 * 卡片只消费 Host 的 `ExpertTeamRun` 投影与成员 `SubagentRunView`，不自行推导
 * 团队终态：状态文案严格按 Host 的 7 种 `status` 区分，业务未完全收敛
 * （`completed_with_issues`）与技术异常（`partial`）不共用一句文案。动态任务没有
 * 预定总步骤，活动只描述真实进行中的执行/审查，不显示百分比或虚构的「2/5」。
 *
 * 取消分两级：整团走 `expertTeam.cancel({ parentSessionId, teamRunId })`，单成员复用
 * `subagent.cancel({ parentSessionId, runId })`。忙态与错误按「表面 + runId」分开，
 * 主流与右栏互不覆盖；确认只在本卡发起，调用方持有唯一确认目标。
 */

/** 取消发起表面：主流聚合卡或右栏进度面板。 */
export type ExpertTeamCancelSurface = "chat" | "progress";

/** 当前唯一确认目标；同一时刻只允许一个团队或成员取消进入确认态。 */
export type ExpertTeamCancelTarget =
  | { kind: "team"; teamRunId: string; surface: ExpertTeamCancelSurface }
  | { kind: "member"; runId: string; surface: ExpertTeamCancelSurface };

/** 整团取消请求；直接就是 `expertTeam.cancel` 的参数。 */
export type ExpertTeamCancelRequest = { parentSessionId: string; teamRunId: string };

/** 单成员取消请求；直接就是既有 `subagent.cancel` 的参数。 */
export type ExpertTeamMemberCancelRequest = { parentSessionId: string; runId: string };

/** 7 种整体状态文案，两两不同；未知状态由 Host 兜底，卡片不猜成功。 */
export const EXPERT_TEAM_STATUS_LABEL: Record<ExpertTeamRun["status"], string> = {
  running: "进行中",
  stopping: "终止中",
  completed: "已完成",
  completed_with_issues: "已完成 · 有未解决的审查意见",
  partial: "部分完成 · 交付不完整",
  stopped: "已停止",
  failed: "运行失败",
};

const TERMINAL_STATUSES: ReadonlySet<ExpertTeamRun["status"]> = new Set<ExpertTeamRun["status"]>([
  "completed",
  "completed_with_issues",
  "partial",
  "stopped",
  "failed",
]);

const RESULT_STATUS_TEXT: Record<ExpertTeamResult["status"], string> = {
  starting: "启动中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
};

const RESULT_KIND_TEXT: Record<ExpertTeamResult["kind"], string> = {
  execute: "执行",
  review: "审查",
  revision: "返修",
};

const ROLE_TEXT: Record<"executor" | "reviewer", string> = {
  executor: "执行成员",
  reviewer: "审查成员",
};

/**
 * 取消忙态/错误的键：同一 runId 在主流与右栏是两个独立表面，不能互相清掉。
 *
 * @param surface 发起取消的表面
 * @param runId 团队运行 id 或成员运行 id
 * @returns 该表面该运行的稳定键
 */
export function expertTeamCancelKey(surface: ExpertTeamCancelSurface, runId: string): string {
  return `${surface}:${runId}`;
}

export type ExpertTeamRunCardProps = {
  run: ExpertTeamRun;
  now: number;
  /** Host generation 连接状态；断连只冻结操作，不改写运行状态。 */
  connection: "open" | "closed";
  /** 断连冻结时刻（毫秒），只用于冻结耗时显示。 */
  frozenAt?: number;
  surface?: ExpertTeamCancelSurface;
  /** 同一父会话的成员 run 投影，供成员行显示真实相位。 */
  memberRuns?: readonly SubagentRunView[];
  expandedResultIds?: Readonly<Record<string, boolean>>;
  confirming?: ExpertTeamCancelTarget | null;
  cancelBusyByKey?: Readonly<Record<string, boolean>>;
  cancelErrorByKey?: Readonly<Record<string, string>>;
  onToggleResult?(resultId: string): void;
  onRequestCancelTeam?(input: ExpertTeamCancelRequest): void;
  onRequestCancelMember?(input: ExpertTeamMemberCancelRequest): void;
  onConfirmCancel?(target: ExpertTeamCancelTarget): void;
  onDismissCancel?(): void;
  onPreviewArtifact?(artifactId: string): void;
};

/**
 * 专家团聚合卡：团队名、状态、混合活动、耗时、结果尝试计数、主报告入口与
 * 按实际派工顺序展开的成员行。
 */
export default function ExpertTeamRunCard(props: ExpertTeamRunCardProps): ReactElement {
  const {
    run,
    now,
    connection,
    frozenAt,
    surface = "chat",
    memberRuns = [],
    expandedResultIds = {},
    confirming = null,
    cancelBusyByKey = {},
    cancelErrorByKey = {},
    onToggleResult,
    onRequestCancelTeam,
    onRequestCancelMember,
    onConfirmCancel,
    onDismissCancel,
    onPreviewArtifact,
  } = props;

  const terminal = TERMINAL_STATUSES.has(run.status);
  const frozen = connection === "closed";
  const teamKey = expertTeamCancelKey(surface, run.teamRunId);
  const teamBusy = cancelBusyByKey[teamKey] === true;
  const teamError = cancelErrorByKey[teamKey];
  const teamConfirming =
    confirming?.kind === "team" && confirming.teamRunId === run.teamRunId && confirming.surface === surface;
  const teamCancelDisabled = frozen || run.status === "stopping" || teamBusy;
  const counts = expertTeamCounts(run);
  const versions = resultVersions(run.results);
  const artifact = artifactProjection(run);

  return (
    <div
      className="expert-team-run-card"
      data-team-run-id={run.teamRunId}
      data-status={run.status}
      data-frozen={frozen ? "true" : undefined}
    >
      <div className="expert-team-run-header">
        <span className="expert-team-run-name" title={run.teamSnapshot.name}>
          {run.teamSnapshot.name}
        </span>
        <span className="expert-team-run-status" data-role="expert-team-status">
          {EXPERT_TEAM_STATUS_LABEL[run.status]}
        </span>
        <span className="expert-team-run-meta">{elapsedText(run, now, frozenAt)}</span>
        {teamConfirming ? (
          <span className="expert-team-run-actions">
            <button
              type="button"
              className="expert-team-run-terminate"
              onClick={() => onConfirmCancel?.({ kind: "team", teamRunId: run.teamRunId, surface })}
            >
              确认终止专家团
            </button>
            <button type="button" className="expert-team-run-terminate" onClick={() => onDismissCancel?.()}>
              取消
            </button>
          </span>
        ) : terminal ? null : (
          <button
            type="button"
            className="expert-team-run-terminate"
            aria-label={`终止专家团 ${run.teamSnapshot.name}`}
            aria-busy={teamBusy ? "true" : undefined}
            disabled={teamCancelDisabled}
            onClick={() => onRequestCancelTeam?.({ parentSessionId: run.parentSessionId, teamRunId: run.teamRunId })}
          >
            终止专家团
          </button>
        )}
      </div>

      {frozen ? (
        <p className="expert-team-run-notice" role="status">
          连接已断开，运行状态与操作已冻结，重连对账后恢复
        </p>
      ) : null}
      {run.status === "stopping" ? (
        <p className="expert-team-run-notice is-info">
          终止已受理，等待成员与团长终结；清理结果以成员状态与运行状态为准
        </p>
      ) : null}

      <p className="expert-team-run-activity">{activityText(run)}</p>
      <p className="expert-team-run-counts">
        派工 {counts.dispatched} · 进行中 {counts.running} · 完成 {counts.completed} · 失败{" "}
        {counts.failed} · 已终止 {counts.stopped} · 审查 {counts.reviews} · 返修 {counts.revisions}
      </p>

      <div className="expert-team-run-artifact">
        <span className="expert-team-run-artifact-status">{artifact.statusText}</span>
        {artifact.error !== undefined ? (
          <p className="expert-team-run-artifact-error" role="alert">
            {artifact.error}
          </p>
        ) : null}
        {artifact.artifactId !== undefined && onPreviewArtifact !== undefined ? (
          <button
            type="button"
            className="expert-team-run-preview"
            onClick={() => {
              if (artifact.artifactId !== undefined) onPreviewArtifact(artifact.artifactId);
            }}
          >
            查看主报告
          </button>
        ) : null}
      </div>

      {teamError !== undefined ? (
        <p className="expert-team-run-error" role="alert">
          终止专家团失败：{teamError}
        </p>
      ) : null}

      {run.results.length === 0 ? (
        <p className="expert-team-run-empty">尚无成员结果</p>
      ) : (
        <ul className="expert-team-run-results">
          {run.results.map((result) => {
            const expanded = expandedResultIds[result.resultId] === true;
            const member = run.teamSnapshot.members.find((entry) => entry.memberId === result.memberId);
            const label = `@${member?.agentRef.slug ?? result.agentRef.slug}`;
            const memberRun = result.memberRunId === undefined
              ? undefined
              : memberRuns.find((entry) => entry.runId === result.memberRunId);
            const memberRunId = result.memberRunId;
            const memberKey = memberRunId === undefined
              ? undefined
              : expertTeamCancelKey(surface, memberRunId);
            const memberBusy = memberKey !== undefined && cancelBusyByKey[memberKey] === true;
            const memberError = memberKey === undefined ? undefined : cancelErrorByKey[memberKey];
            const memberConfirming =
              confirming?.kind === "member" &&
              confirming.surface === surface &&
              memberRunId !== undefined &&
              confirming.runId === memberRunId;
            const active = result.status === "starting" || result.status === "running";
            const canCancelMember = active && memberRunId !== undefined && !frozen;
            const statusText =
              active && memberRun !== undefined ? subagentStatusText(memberRun) : RESULT_STATUS_TEXT[result.status];
            const version = versions.get(result.resultId) ?? 1;
            return (
              <li
                key={result.resultId}
                className="expert-team-result-row"
                data-status={result.status}
                data-kind={result.kind}
              >
                <div className="expert-team-result-head">
                  <span className="expert-team-result-label" title={label}>
                    {label}
                  </span>
                  <span className="expert-team-result-role">
                    {member === undefined ? RESULT_KIND_TEXT[result.kind] : ROLE_TEXT[member.role]}
                  </span>
                  <span className="expert-team-result-kind">{RESULT_KIND_TEXT[result.kind]}</span>
                  <span className="expert-team-result-version">第 {version} 版</span>
                  <span className="expert-team-result-package">v{result.packageVersion}</span>
                  <span className="expert-team-result-status">{statusText}</span>
                  {canCancelMember && !memberConfirming ? (
                    <button
                      type="button"
                      className="expert-team-run-terminate"
                      aria-label={`终止成员 ${label} 本次运行`}
                      aria-busy={memberBusy ? "true" : undefined}
                      disabled={memberBusy}
                      onClick={() => {
                        if (memberRunId !== undefined) {
                          onRequestCancelMember?.({ parentSessionId: run.parentSessionId, runId: memberRunId });
                        }
                      }}
                    >
                      终止成员
                    </button>
                  ) : memberConfirming ? (
                    <span className="expert-team-run-actions">
                      <button
                        type="button"
                        className="expert-team-run-terminate"
                        onClick={() =>
                          onConfirmCancel?.(
                            memberRunId === undefined
                              ? { kind: "team", teamRunId: run.teamRunId, surface }
                              : { kind: "member", runId: memberRunId, surface },
                          )
                        }
                      >
                        确认终止成员
                      </button>
                      <button type="button" className="expert-team-run-terminate" onClick={() => onDismissCancel?.()}>
                        取消
                      </button>
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="expert-team-run-expand"
                    aria-expanded={expanded}
                    onClick={() => onToggleResult?.(result.resultId)}
                  >
                    {expanded ? "收起" : "展开"}成员结果 {result.resultId}
                  </button>
                </div>
                {expanded ? (
                  <div className="expert-team-result-details">
                    {result.supersedesResultId !== undefined ? (
                      <p className="expert-team-result-supersede">替代 {result.supersedesResultId} 的上一次结果</p>
                    ) : null}
                    {reviewText(result) !== undefined ? (
                      <p
                        className={
                          result.reviewError === "invalid-verdict"
                            ? "expert-team-result-verdict is-error"
                            : "expert-team-result-verdict"
                        }
                      >
                        {reviewText(result)}
                      </p>
                    ) : null}
                    {result.output !== undefined ? (
                      <p className="expert-team-result-output">{result.output}</p>
                    ) : null}
                    {result.error !== undefined ? (
                      <p className="expert-team-result-error" role="alert">
                        {result.error}
                      </p>
                    ) : null}
                    {memberError !== undefined ? (
                      <p className="expert-team-result-error" role="alert">
                        终止成员失败：{memberError}
                      </p>
                    ) : null}
                  </div>
                ) : memberError !== undefined ? (
                  <p className="expert-team-result-error" role="alert">
                    终止成员失败：{memberError}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** 主报告区域：关联异常优先于任何正常入口，且不把 Artifact 展示成已完成交付。 */
function artifactProjection(run: ExpertTeamRun): {
  statusText: string;
  artifactId?: string;
  error?: string;
} {
  if (run.artifactLinkError !== undefined || (run.deliverySealed && run.artifactStatus === "pending")) {
    const reason = run.artifactLinkError === undefined ? "" : `（${run.artifactLinkError}）`;
    return {
      statusText: "主报告关联异常",
      error: `主报告已提交但运行关联失败${reason}；聊天流中的 Artifact 卡片仍可查看`,
    };
  }
  if (run.primaryArtifactId !== undefined) {
    return { statusText: "主报告已生成", artifactId: run.primaryArtifactId };
  }
  switch (run.artifactStatus) {
    case "not-required":
      return { statusText: "交付方式：仅会话汇总（无需 Artifact）" };
    case "pending":
      return { statusText: "主报告待生成" };
    case "created":
      return { statusText: "主报告已生成" };
  }
}

/** 成员结果链的版本号：沿 `supersedesResultId` 回溯，环由访问集合兜底。 */
function resultVersions(results: readonly ExpertTeamResult[]): Map<string, number> {
  const byId = new Map(results.map((result) => [result.resultId, result] as const));
  const versions = new Map<string, number>();
  for (const result of results) {
    let depth = 1;
    const seen = new Set<string>([result.resultId]);
    let cursor = result.supersedesResultId === undefined ? undefined : byId.get(result.supersedesResultId);
    while (cursor !== undefined && !seen.has(cursor.resultId)) {
      seen.add(cursor.resultId);
      depth += 1;
      cursor = cursor.supersedesResultId === undefined ? undefined : byId.get(cursor.supersedesResultId);
    }
    versions.set(result.resultId, depth);
  }
  return versions;
}

function reviewText(result: ExpertTeamResult): string | undefined {
  if (result.reviewError === "invalid-verdict") return "审查标记无效（invalid-verdict）";
  if (result.reviewVerdict === "pass") return "审查通过";
  if (result.reviewVerdict === "revise") return "审查要求返修";
  return undefined;
}

/**
 * 混合活动文案：执行与审查并行时如实并列，不伪装成线性阶段，也不显示百分比。
 */
function activityText(run: ExpertTeamRun): string {
  switch (run.status) {
    case "stopping":
      return "正在终止：已停止接受新派工，等待成员收敛";
    case "completed":
      return "交付已完成";
    case "completed_with_issues":
      return "交付完成，仍有未解决的审查意见";
    case "partial":
      return "已有部分结果，技术执行、审查或主报告关联不完整";
    case "failed":
      return "运行失败，没有可确认的完整交付";
    case "stopped":
      return "运行已停止";
    case "running":
      break;
  }
  const active = run.results.filter((result) => result.status === "starting" || result.status === "running");
  const executing = active.some((result) => result.kind === "execute");
  const revising = active.some((result) => result.kind === "revision");
  const reviewing = active.some((result) => result.kind === "review");
  if (executing && reviewing) return "执行与审查并行进行中";
  if (revising && reviewing) return "返修与审查并行进行中";
  if (reviewing) return "审查进行中";
  if (revising) return "返修进行中";
  if (executing) return "执行进行中";
  return run.dispatchAttempts > 0 ? "等待成员结果" : "正在准备派工";
}

/** 展示耗时：冻结断连时刻，终态取 `endedAt`；mm:ss，超过一小时为 H:mm:ss。 */
function elapsedText(run: ExpertTeamRun, now: number, frozenAt?: number): string {
  const started = Date.parse(run.startedAt);
  if (!Number.isFinite(started)) return "";
  const ended = run.endedAt === undefined ? undefined : Date.parse(run.endedAt);
  const end = Math.min(
    now,
    ended !== undefined && Number.isFinite(ended) ? ended : now,
    frozenAt ?? now,
  );
  const total = Math.max(0, Math.floor((end - started) / 1_000));
  const pad = (value: number): string => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
