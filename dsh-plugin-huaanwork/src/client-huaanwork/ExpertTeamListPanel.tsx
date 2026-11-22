import { useState } from "react";
import type { ExpertTeam, ExpertTeamMember } from "./rpc-types.ts";
import type { ExpertTeamAvailability, ExpertTeamListRow, ExpertTeamSelectablePackage } from "./ExpertTeamsView.tsx";

/**
 * 专家团列表（设计 §7.2 / §9.3）：卡片展示定义摘要与实时可用性，操作为
 * 编辑、启停和二次确认删除。损坏定义只保留 id 与删除入口，编辑/启停禁用；
 * 成员失效的定义仍可编辑其他字段，但不会进入 `@team:` 可选结果（由 Host
 * 可用性投影保证，这里只展示原因）。
 */

const ASSIGNMENT_LABELS: Record<ExpertTeam["orchestration"]["assignmentMode"], string> = {
  "by-responsibility": "按职责分配",
  broadcast: "全员独立处理",
};

const ORDER_LABELS: Record<ExpertTeam["orchestration"]["executionOrder"], string> = {
  sequential: "顺序执行",
  parallel: "并行执行",
  dynamic: "动态安排",
};

const REVIEW_LABELS: Record<ExpertTeam["review"]["mode"], string> = {
  none: "不审查",
  unified: "汇总前统一审查",
  "per-member": "逐成员结果审查",
};

const SOURCE_LABELS: Record<ExpertTeamMember["agentRef"]["source"], string> = {
  local: "本地",
  catalog: "广场",
};

const REASON_LABELS: Record<string, string> = {
  "expert-team-member-missing": "成员不存在或不是本地/广场智能体包",
  "expert-team-member-disabled": "成员已停用",
  "expert-team-member-broken": "成员已损坏",
  "expert-team-member-revoked": "成员已撤销",
  "expert-team-disabled": "团队已停用",
  "expert-team-invalid": "配置不完整",
  "expert-team-corrupt": "定义文件已损坏",
};

/** 统一的错误文案：RPC 错误已是本地化消息，非 Error 值转字符串。 */
export function expertTeamErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 包原生能力摘要：成员选择器与保存前摘要共用同一文案。 */
export function expertTeamCapabilitiesText(
  capabilities: ExpertTeamSelectablePackage["capabilities"],
): string {
  if (capabilities === undefined) return "未知";
  const tools =
    capabilities.tools === "both"
      ? "HTTP / MCP"
      : capabilities.tools === "http"
        ? "HTTP"
        : capabilities.tools === "mcp"
          ? "MCP"
          : "仅内置工具";
  const scripts =
    capabilities.skillScripts.length === 0
      ? "无脚本"
      : `脚本：${capabilities.skillScripts.join("、")}`;
  return `${tools} · ${scripts}`;
}

function availabilityLabel(row: ExpertTeamListRow): string {
  if (row.error === "expert-team-corrupt") return "定义文件已损坏";
  switch (row.availability.kind) {
    case "invocable":
      return "可调用";
    case "disabled":
      return "已停用";
    case "incomplete":
      return "配置不完整";
    case "member-invalid":
      return "成员失效";
  }
}

function statusClass(row: ExpertTeamListRow): string {
  if (row.error === "expert-team-corrupt") return "team-status corrupt";
  return `team-status ${row.availability.kind}`;
}

function reasonText(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

function availabilityDetail(row: ExpertTeamListRow, team: ExpertTeam): string[] {
  const details: string[] = [];
  for (const reason of row.availability.reasons) {
    if (reason === "expert-team-disabled") continue;
    if (row.error === "expert-team-corrupt") continue;
    details.push(reasonText(reason));
  }
  for (const member of row.availability.members) {
    if (member.reason === undefined) continue;
    details.push(`成员 ${member.displayName}：${reasonText(member.reason)}`);
  }
  if (details.length === 0 && row.availability.kind === "invocable" && team.enabled) {
    details.push("定义与成员均有效");
  }
  return details;
}

function reviewDetail(team: ExpertTeam): string {
  if (team.review.mode === "none") return "审查：不审查";
  const reviewerNames = team.members
    .filter((member) => member.role === "reviewer")
    .map((member) => member.agentRef.slug);
  const names = reviewerNames.length === 0 ? "无" : reviewerNames.join("、");
  return `审查：${REVIEW_LABELS[team.review.mode]} · 必审 ${names} · 返修上限 ${team.review.maxRevisionRounds} 轮`;
}

function deliveryDetail(team: ExpertTeam): string {
  return team.summary.delivery === "message"
    ? "交付：仅会话消息"
    : `交付：主 Artifact（${team.summary.artifactFormat === "html" ? "HTML" : "Markdown"}）`;
}

function matchesSearch(row: ExpertTeamListRow, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return true;
  const team = row.team;
  const fields =
    team === undefined
      ? [row.id, "定义文件已损坏"]
      : [team.name, team.slug, team.description, team.scenarios ?? ""];
  return fields.some((field) => field.toLocaleLowerCase().includes(needle));
}

function badgeFor(row: ExpertTeamListRow): string {
  return statusClass(row);
}

export default function ExpertTeamListPanel({
  teams,
  search,
  onSearch,
  loading,
  error,
  busyId,
  onNew,
  onEdit,
  onToggle,
  onRemove,
}: {
  teams: ExpertTeamListRow[];
  search: string;
  onSearch: (value: string) => void;
  loading: boolean;
  error?: string;
  busyId?: string;
  onNew: () => void;
  onEdit: (row: ExpertTeamListRow) => void;
  onToggle: (row: ExpertTeamListRow) => void;
  onRemove: (row: ExpertTeamListRow) => void;
}) {
  /** 同一时刻只保留一行的二次确认。 */
  const [confirmingId, setConfirmingId] = useState<string | undefined>(undefined);
  const visible = teams.filter((row) => matchesSearch(row, search));

  return (
    <div className="page-view expert-team-page">
      <div className="page-head">
        <h1>专家团</h1>
        <span className="hint-text">把多名智能体组合成团队，由团长按结构化规则派工并汇总</span>
      </div>

      <div className="page-tools">
        <input
          className="search-input"
          value={search}
          placeholder="🔍 搜索专家团"
          aria-label="搜索专家团"
          onChange={(event) => onSearch(event.target.value)}
        />
        <span className="composer-spacer" />
        <button type="button" className="btn primary small" onClick={onNew}>
          新建专家团
        </button>
      </div>

      {error !== undefined ? (
        <p className="banner error" role="alert">
          {error}
        </p>
      ) : null}
      {loading && teams.length === 0 ? <p className="panel-empty">加载中…</p> : null}
      {!loading && visible.length === 0 ? (
        <p className="panel-empty">
          {teams.length === 0 ? "暂无专家团，点击右上角新建。" : "没有匹配的专家团。"}
        </p>
      ) : null}

      <ul className="recent-list expert-team-list">
        {visible.map((row) => {
          const team = row.team;
          const corrupt = row.error === "expert-team-corrupt";
          const availability: ExpertTeamAvailability = row.availability;
          const busy = busyId === row.id;
          const confirming = confirmingId === row.id;
          const slug = team?.slug;

          return (
            <li key={row.id}>
              <article
                className={corrupt ? "team-card corrupt" : "team-card"}
                data-team-id={row.id}
                {...(slug === undefined ? {} : { "data-team-slug": slug })}
                aria-label={team === undefined ? `损坏的专家团 ${row.id}` : `专家团 ${team.name}`}
              >
                <header className="team-card-head">
                  <div className="team-card-title">
                    <strong>{team?.name ?? "定义文件已损坏"}</strong>
                    <span className={badgeFor(row)}>{availabilityLabel(row)}</span>
                    {team !== undefined ? <code className="team-slug">@team:{team.slug}</code> : null}
                  </div>
                  <div className="team-card-actions">
                    <button
                      type="button"
                      className="btn small"
                      disabled={corrupt || busy}
                      onClick={() => onEdit(row)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn small"
                      disabled={corrupt || busy || team === undefined}
                      aria-label={team !== undefined && team.enabled ? `停用 ${team.slug}` : `启用 ${slug ?? row.id}`}
                      onClick={() => onToggle(row)}
                    >
                      {team !== undefined && team.enabled ? "停用" : "启用"}
                    </button>
                    {confirming ? (
                      <>
                        <button
                          type="button"
                          className="btn danger small"
                          disabled={busy}
                          onClick={() => {
                            setConfirmingId(undefined);
                            onRemove(row);
                          }}
                        >
                          确认删除
                        </button>
                        <button
                          type="button"
                          className="btn small"
                          disabled={busy}
                          onClick={() => setConfirmingId(undefined)}
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn danger small"
                        disabled={busy}
                        aria-label={corrupt ? `删除损坏记录 ${row.id}` : `删除 ${slug ?? row.id}`}
                        onClick={() => setConfirmingId(row.id)}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </header>

                {team === undefined ? (
                  <div className="team-card-body">
                    <p className="team-corrupt-note">
                      无法读取 <code>{row.id}</code>：文件不是有效的专家团定义。删除不会影响智能体、会话或历史 Artifact。
                    </p>
                  </div>
                ) : (
                  <div className="team-card-body">
                    <p className="team-card-description">{team.description}</p>
                    {team.scenarios !== undefined && team.scenarios !== "" ? (
                      <p className="team-card-scenarios">适用场景：{team.scenarios}</p>
                    ) : null}
                    <p className="team-card-meta">
                      成员 {team.members.length} 名 · {ASSIGNMENT_LABELS[team.orchestration.assignmentMode]} ·{" "}
                      {ORDER_LABELS[team.orchestration.executionOrder]} · {REVIEW_LABELS[team.review.mode]}
                    </p>
                    <p className="team-card-meta">{deliveryDetail(team)}</p>
                    <p className="team-card-meta">{reviewDetail(team)}</p>
                    {availability.members.some((member) => member.reason !== undefined) ? (
                      <ul className="team-card-members">
                        {availability.members.map((member) => (
                          <li key={member.memberId} className={member.reason === undefined ? "team-member-ok" : "team-member-stale"}>
                            <span>{member.displayName}</span>
                            {member.version !== undefined ? <span className="team-member-version">v{member.version}</span> : null}
                            {member.reason !== undefined ? (
                              <span className="team-member-reason">{reasonText(member.reason)}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {availabilityDetail(row, team).length > 0 ? (
                      <p className="team-card-reasons">
                        {availabilityDetail(row, team).join("；")}
                      </p>
                    ) : null}
                    <p className="team-card-members-source">
                      成员来源：{team.members.map((member) => `${SOURCE_LABELS[member.agentRef.source]}/${member.agentRef.slug}`).join("、")}
                    </p>
                  </div>
                )}
              </article>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
