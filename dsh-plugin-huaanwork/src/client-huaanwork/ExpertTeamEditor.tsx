import { useEffect, useRef, useState } from "react";
import { rpcCall } from "./api.ts";
import { expertTeamCapabilitiesText, expertTeamErrorMessage } from "./ExpertTeamListPanel.tsx";
import type {
  ExpertTeamFieldError,
  ExpertTeamListRow,
  ExpertTeamSelectablePackage,
  ExpertTeamWriteResult,
} from "./ExpertTeamsView.tsx";
import { defaultExpertTeamRules } from "./logic/expertTeamsLogic.ts";
import type { ExpertTeam, ExpertTeamMember } from "./rpc-types.ts";

/**
 * 专家团结构化编辑器（设计 §7.3 / §9）。
 *
 * 新建与编辑复用同一表单：基本信息、成员与职责、调度规则、审查与汇总。
 * 调用名在新建时随名称生成并可改，编辑已有定义时锁定；成员只从
 * `expertTeam.list` 返回的健康包中选择，保留失效成员的原始引用并要求显式移除。
 * 无审查成员时审查模式固定为 `none`；仅会话交付隐藏 Artifact 格式。
 * 保存失败按字段回显且不清空草稿；离开有未保存修改的编辑器需要二次确认。
 * 未保存状态通过 `onDirtyChange` 上报，让 App 的侧边栏导航也能拦截离开。
 */

const ASSIGNMENT_OPTIONS: Array<{ value: ExpertTeam["orchestration"]["assignmentMode"]; label: string }> = [
  { value: "by-responsibility", label: "按职责分配" },
  { value: "broadcast", label: "全员独立处理" },
];

const ORDER_OPTIONS: Array<{ value: ExpertTeam["orchestration"]["executionOrder"]; label: string }> = [
  { value: "parallel", label: "并行执行" },
  { value: "sequential", label: "顺序执行" },
  { value: "dynamic", label: "动态安排" },
];

const REVIEW_OPTIONS: Array<{ value: ExpertTeam["review"]["mode"]; label: string }> = [
  { value: "none", label: "不审查" },
  { value: "unified", label: "汇总前统一审查" },
  { value: "per-member", label: "逐成员结果审查" },
];

const SUMMARY_MODE_OPTIONS: Array<{ value: ExpertTeam["summary"]["mode"]; label: string }> = [
  { value: "integrated", label: "整合报告" },
  { value: "by-member", label: "按成员分章" },
  { value: "integrated-with-appendix", label: "整合报告 + 成员附录" },
];

const ROLE_LABELS: Record<ExpertTeamMember["role"], string> = {
  executor: "执行",
  reviewer: "审查",
};

const SOURCE_LABELS: Record<ExpertTeamMember["agentRef"]["source"], string> = {
  local: "本地",
  catalog: "广场",
};

type TeamDraft = {
  slug: string;
  name: string;
  description: string;
  scenarios: string;
  members: ExpertTeamMember[];
  assignmentMode: ExpertTeam["orchestration"]["assignmentMode"];
  executionOrder: ExpertTeam["orchestration"]["executionOrder"];
  maxParallel: 1 | 2 | 3 | 4;
  orchestrationInstructions: string;
  reviewMode: ExpertTeam["review"]["mode"];
  maxRevisionRounds: 0 | 1 | 2;
  reviewCriteria: string;
  delivery: ExpertTeam["summary"]["delivery"];
  artifactFormat: ExpertTeam["summary"]["artifactFormat"];
  summaryMode: ExpertTeam["summary"]["mode"];
  summaryInstructions: string;
};

function defaultDraft(): TeamDraft {
  const rules = defaultExpertTeamRules([]);
  return {
    slug: "",
    name: "",
    description: "",
    scenarios: "",
    members: [],
    assignmentMode: rules.orchestration.assignmentMode,
    executionOrder: rules.orchestration.executionOrder,
    maxParallel: rules.orchestration.maxParallel,
    orchestrationInstructions: "",
    reviewMode: rules.review.mode,
    maxRevisionRounds: rules.review.maxRevisionRounds,
    reviewCriteria: "",
    delivery: rules.summary.delivery,
    artifactFormat: rules.summary.artifactFormat,
    summaryMode: rules.summary.mode,
    summaryInstructions: "",
  };
}

function draftFromTeam(team: ExpertTeam): TeamDraft {
  return {
    slug: team.slug,
    name: team.name,
    description: team.description,
    scenarios: team.scenarios ?? "",
    members: team.members.map((member) => ({
      memberId: member.memberId,
      agentRef: { ...member.agentRef },
      role: member.role,
      responsibility: member.responsibility,
      ...(member.outputInstructions === undefined ? {} : { outputInstructions: member.outputInstructions }),
    })),
    assignmentMode: team.orchestration.assignmentMode,
    executionOrder: team.orchestration.executionOrder,
    maxParallel: team.orchestration.maxParallel,
    orchestrationInstructions: team.orchestration.instructions ?? "",
    reviewMode: team.review.mode,
    maxRevisionRounds: team.review.maxRevisionRounds,
    reviewCriteria: team.review.criteria ?? "",
    delivery: team.summary.delivery,
    artifactFormat: team.summary.artifactFormat,
    summaryMode: team.summary.mode,
    summaryInstructions: team.summary.instructions ?? "",
  };
}

/** 名称 → 调用名；中文等没有拉丁字母的名称回落到一次性随机 token。 */
function slugFromName(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  if (base !== "") return base;
  if (name.trim() === "") return "";
  return `team-${Math.random().toString(36).slice(2, 8)}`;
}

function newMemberId(): string {
  return `member-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function memberKey(member: ExpertTeamMember): string {
  return `${member.agentRef.source}/${member.agentRef.slug}`;
}

function packageKey(pkg: ExpertTeamSelectablePackage): string {
  return `${pkg.source}/${pkg.slug}`;
}

export default function ExpertTeamEditor({
  row,
  packages,
  onClose,
  onSaved,
  onDirtyChange,
}: {
  row?: ExpertTeamListRow;
  packages: ExpertTeamSelectablePackage[];
  onClose: () => void;
  onSaved: (team: ExpertTeam) => void;
  /** 草稿脏状态上报给 App 的离开守卫；卸载时上报 false。 */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const editing = row?.team;
  const slugLocked = editing !== undefined;
  const [draft, setDraft] = useState<TeamDraft>(() =>
    editing === undefined ? defaultDraft() : draftFromTeam(editing),
  );
  /** 初始快照只决定是否提示未保存；保存失败不改变它。 */
  const [initialSnapshot] = useState(() => JSON.stringify(editing === undefined ? defaultDraft() : draftFromTeam(editing)));
  const [fieldErrors, setFieldErrors] = useState<ExpertTeamFieldError[]>([]);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  /** 用户改过调用名后不再随名称自动覆盖。 */
  const [slugTouched, setSlugTouched] = useState(false);
  /** 编辑已有定义时保留保存过的审查选择；新建团队在加入 reviewer 时默认统一审查。 */
  const [reviewTouched, setReviewTouched] = useState(editing !== undefined);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (slugLocked || slugTouched) return;
    setDraft((prev) => {
      const next = slugFromName(prev.name);
      return next === prev.slug ? prev : { ...prev, slug: next };
    });
  }, [draft.name, slugLocked, slugTouched]);

  const hasReviewer = draft.members.some((member) => member.role === "reviewer");

  useEffect(() => {
    setDraft((prev) => {
      if (!hasReviewer) {
        return prev.reviewMode === "none" ? prev : { ...prev, reviewMode: "none" };
      }
      if (!reviewTouched && prev.reviewMode === "none") {
        return { ...prev, reviewMode: "unified" };
      }
      return prev;
    });
  }, [hasReviewer, reviewTouched]);

  const dirty = JSON.stringify(draft) !== initialSnapshot;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  /** 编辑器卸载（保存、放弃修改或页面被换走）后对外不再有待保存草稿。 */
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const fieldError = (field: string): string | undefined =>
    fieldErrors.find((error) => error.field === field)?.message;

  const update = (patch: Partial<TeamDraft>): void => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const updateMember = (index: number, patch: Partial<ExpertTeamMember>): void => {
    setDraft((prev) => ({
      ...prev,
      members: prev.members.map((member, memberIndex) =>
        memberIndex === index ? { ...member, ...patch } : member,
      ),
    }));
  };

  const moveMember = (index: number, delta: -1 | 1): void => {
    setDraft((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.members.length) return prev;
      const members = [...prev.members];
      const current = members[index];
      const swapped = members[target];
      if (current === undefined || swapped === undefined) return prev;
      members[index] = swapped;
      members[target] = current;
      return { ...prev, members };
    });
  };

  const removeMember = (index: number): void => {
    setDraft((prev) => ({ ...prev, members: prev.members.filter((_member, memberIndex) => memberIndex !== index) }));
  };

  const addPackage = (pkg: ExpertTeamSelectablePackage): void => {
    setDraft((prev) => {
      if (prev.members.length >= 8) return prev;
      const key = packageKey(pkg);
      if (prev.members.some((member) => memberKey(member) === key)) return prev;
      return {
        ...prev,
        members: [
          ...prev.members,
          {
            memberId: newMemberId(),
            agentRef: { source: pkg.source, slug: pkg.slug },
            role: "executor",
            responsibility: "",
          },
        ],
      };
    });
  };

  const buildPayload = (): Record<string, unknown> => {
    const members: ExpertTeamMember[] = draft.members.map((member) => {
      const outputInstructions = (member.outputInstructions ?? "").trim();
      return {
        memberId: member.memberId,
        agentRef: { ...member.agentRef },
        role: member.role,
        responsibility: member.responsibility.trim(),
        ...(outputInstructions === "" ? {} : { outputInstructions }),
      };
    });
    const scenarios = draft.scenarios.trim();
    const orchestrationInstructions = draft.orchestrationInstructions.trim();
    const reviewCriteria = draft.reviewCriteria.trim();
    const summaryInstructions = draft.summaryInstructions.trim();
    return {
      slug: draft.slug.trim(),
      name: draft.name.trim(),
      description: draft.description.trim(),
      // 新建时省略空白可选字段；编辑时保留 "" 以显式清空已保存的 scenarios（Host 归一化后省略落盘）。
      ...(scenarios !== "" || editing !== undefined ? { scenarios } : {}),
      members,
      orchestration: {
        assignmentMode: draft.assignmentMode,
        executionOrder: draft.executionOrder,
        maxParallel: draft.maxParallel,
        ...(orchestrationInstructions === "" ? {} : { instructions: orchestrationInstructions }),
      },
      review: {
        mode: hasReviewer ? draft.reviewMode : "none",
        maxRevisionRounds: draft.maxRevisionRounds,
        ...(reviewCriteria === "" ? {} : { criteria: reviewCriteria }),
      },
      summary: {
        delivery: draft.delivery,
        artifactFormat: draft.artifactFormat,
        mode: draft.summaryMode,
        ...(summaryInstructions === "" ? {} : { instructions: summaryInstructions }),
      },
    };
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveError("");
    setFieldErrors([]);
    try {
      const payload = buildPayload();
      const result =
        editing === undefined
          ? await rpcCall<ExpertTeamWriteResult>("expertTeam.create", { ...payload, enabled: true })
          : await rpcCall<ExpertTeamWriteResult>("expertTeam.update", { id: row?.id ?? editing.id, ...payload });
      if (!result.ok) {
        setFieldErrors(result.fieldErrors);
        return;
      }
      if (!mountedRef.current) return;
      onSaved(result.team);
    } catch (cause) {
      if (mountedRef.current) setSaveError(expertTeamErrorMessage(cause));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const requestClose = (): void => {
    if (dirty) {
      setLeaveConfirm(true);
      return;
    }
    onClose();
  };

  const packageFor = (member: ExpertTeamMember): ExpertTeamSelectablePackage | undefined =>
    packages.find((pkg) => pkg.source === member.agentRef.source && pkg.slug === member.agentRef.slug);

  const memberDisplayName = (member: ExpertTeamMember): string =>
    packageFor(member)?.displayName ?? member.agentRef.slug;

  const reviewers = draft.members.filter((member) => member.role === "reviewer");
  const effectiveMaxParallel = draft.executionOrder === "sequential" ? 1 : draft.maxParallel;
  const fieldErrorsText = fieldErrors.map((error) => error.message).join("；");

  return (
    <div className="page-view expert-team-editor-page">
      <div className="page-head">
        <h1>{editing === undefined ? "新建专家团" : `编辑 ${editing.name}`}</h1>
        <span className="hint-text">成员沿用包原生工具、模型与沙箱边界；团队规则只约束派工与汇总</span>
      </div>

      {saveError !== "" ? (
        <p className="banner error" role="alert">
          {saveError}
        </p>
      ) : null}
      {fieldErrorsText !== "" ? (
        <p className="banner error" role="alert">
          {fieldErrorsText}
        </p>
      ) : null}

      <div className="team-editor">
        <section className="team-editor-section" aria-labelledby="team-section-basic">
          <h2 id="team-section-basic">基本信息</h2>
          <div className="team-field-grid">
            <label className="team-field">
              <span>名称</span>
              <input
                aria-label="名称"
                value={draft.name}
                maxLength={40}
                onChange={(event) => update({ name: event.target.value })}
              />
              {fieldError("name") !== undefined ? <em className="team-field-error">{fieldError("name")}</em> : null}
            </label>
            <label className="team-field">
              <span>描述</span>
              <input
                aria-label="描述"
                value={draft.description}
                maxLength={200}
                onChange={(event) => update({ description: event.target.value })}
              />
              {fieldError("description") !== undefined ? <em className="team-field-error">{fieldError("description")}</em> : null}
            </label>
            <label className="team-field">
              <span>适用场景</span>
              <input
                aria-label="适用场景"
                value={draft.scenarios}
                maxLength={500}
                onChange={(event) => update({ scenarios: event.target.value })}
              />
              {fieldError("scenarios") !== undefined ? <em className="team-field-error">{fieldError("scenarios")}</em> : null}
            </label>
            <label className="team-field">
              <span>调用名</span>
              <input
                aria-label="调用名"
                value={draft.slug}
                maxLength={32}
                disabled={slugLocked}
                onChange={(event) => {
                  setSlugTouched(true);
                  update({ slug: event.target.value });
                }}
              />
              <em className="team-field-hint">
                {slugLocked ? `调用名已锁定：@team:${draft.slug}` : "首次保存后锁定；保存后使用 @team:"}
                {slugLocked ? "" : draft.slug === "" ? "…" : draft.slug}
              </em>
              {fieldError("slug") !== undefined ? <em className="team-field-error">{fieldError("slug")}</em> : null}
            </label>
          </div>
        </section>

        <section className="team-editor-section" aria-labelledby="team-section-members">
          <h2 id="team-section-members">成员与职责</h2>
          <p className="hint-text">只列出当前健康、可用的智能体包；已失效成员保留原位，需显式移除后重新选择。</p>
          {fieldError("members") !== undefined ? <p className="banner error">{fieldError("members")}</p> : null}

          <h3 className="team-subhead">可选智能体包</h3>
          {packages.length === 0 ? (
            <p className="hint-text">暂无可选智能体包，请先在智能体页创建或安装并启用。</p>
          ) : (
            <ul className="team-package-list">
              {packages.map((pkg) => {
                const added = draft.members.some((member) => memberKey(member) === packageKey(pkg));
                return (
                  <li key={packageKey(pkg)} className="team-package-card">
                    <div className="team-package-info">
                      <strong>{pkg.displayName}</strong>
                      <span className="team-package-meta">
                        {SOURCE_LABELS[pkg.source]} · v{pkg.version} · {pkg.slug}
                      </span>
                      <p>{pkg.description}</p>
                      <p className="team-capabilities">原生能力：{expertTeamCapabilitiesText(pkg.capabilities)}</p>
                    </div>
                    <button
                      type="button"
                      className="btn small"
                      aria-label={`添加成员 ${pkg.slug}`}
                      disabled={added || draft.members.length >= 8}
                      onClick={() => addPackage(pkg)}
                    >
                      {added ? "已加入" : "添加"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <h3 className="team-subhead">团队成员（按顺序）</h3>
          {draft.members.length === 0 ? <p className="hint-text">尚未添加成员；至少需要一名执行成员。</p> : null}
          <ol className="team-member-list">
            {draft.members.map((member, index) => {
              const pkg = packageFor(member);
              const slug = member.agentRef.slug;
              return (
                <li key={member.memberId} className="team-member-row" data-member-slug={slug}>
                  <header className="team-member-head">
                    <span className="team-member-order">{index + 1}</span>
                    <strong>{memberDisplayName(member)}</strong>
                    <span className="team-package-meta">
                      {SOURCE_LABELS[member.agentRef.source]} · {pkg === undefined ? "包不可用" : `v${pkg.version}`}
                    </span>
                    {pkg === undefined ? <span className="team-status member-invalid">成员失效</span> : null}
                    <span className="composer-spacer" />
                    <button
                      type="button"
                      className="btn small"
                      aria-label={`成员 ${slug}：上移`}
                      disabled={index === 0}
                      onClick={() => moveMember(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn small"
                      aria-label={`成员 ${slug}：下移`}
                      disabled={index === draft.members.length - 1}
                      onClick={() => moveMember(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="btn small danger"
                      aria-label={`移除成员 ${slug}`}
                      onClick={() => removeMember(index)}
                    >
                      移除
                    </button>
                  </header>
                  <div className="team-member-fields">
                    <label className="team-field compact">
                      <span>角色</span>
                      <select
                        aria-label={`成员 ${slug} 角色`}
                        value={member.role}
                        onChange={(event) => updateMember(index, { role: event.target.value as ExpertTeamMember["role"] })}
                      >
                        <option value="executor">执行</option>
                        <option value="reviewer">审查</option>
                      </select>
                    </label>
                    <label className="team-field grow">
                      <span>职责</span>
                      <textarea
                        aria-label={`成员 ${slug} 职责`}
                        rows={2}
                        maxLength={500}
                        value={member.responsibility}
                        onChange={(event) => updateMember(index, { responsibility: event.target.value })}
                      />
                    </label>
                    <label className="team-field grow">
                      <span>输出要求（可选）</span>
                      <textarea
                        aria-label={`成员 ${slug} 输出要求`}
                        rows={2}
                        maxLength={500}
                        value={member.outputInstructions ?? ""}
                        onChange={(event) => updateMember(index, { outputInstructions: event.target.value })}
                      />
                    </label>
                  </div>
                  {pkg !== undefined ? (
                    <p className="team-capabilities">原生能力：{expertTeamCapabilitiesText(pkg.capabilities)}</p>
                  ) : (
                    <p className="team-field-error">
                      成员失效：该包不存在、已停用、已损坏或已撤销。保存其他字段不会移除它，但团队在移除或重新选择前不可调用。
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </section>

        <section className="team-editor-section" aria-labelledby="team-section-orchestration">
          <h2 id="team-section-orchestration">调度规则</h2>
          <div className="team-field-grid">
            <label className="team-field">
              <span>任务分配</span>
              <select
                aria-label="任务分配"
                value={draft.assignmentMode}
                onChange={(event) =>
                  update({ assignmentMode: event.target.value as ExpertTeam["orchestration"]["assignmentMode"] })
                }
              >
                {ASSIGNMENT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="team-field">
              <span>执行顺序</span>
              <select
                aria-label="执行顺序"
                value={draft.executionOrder}
                onChange={(event) =>
                  update({ executionOrder: event.target.value as ExpertTeam["orchestration"]["executionOrder"] })
                }
              >
                {ORDER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="team-field">
              <span>最大并发</span>
              <select
                aria-label="最大并发"
                value={String(draft.maxParallel)}
                disabled={draft.executionOrder === "sequential"}
                onChange={(event) =>
                  update({ maxParallel: Number(event.target.value) as TeamDraft["maxParallel"] })
                }
              >
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
              </select>
              <em className="team-field-hint">
                有效并发 {effectiveMaxParallel}；顺序执行固定按 1 生效。
              </em>
            </label>
            <label className="team-field grow">
              <span>补充说明（可选）</span>
              <textarea
                aria-label="调度说明"
                rows={2}
                maxLength={500}
                value={draft.orchestrationInstructions}
                onChange={(event) => update({ orchestrationInstructions: event.target.value })}
              />
            </label>
          </div>
          <p className="hint-text">每次运行最多 24 次派工工具调用；自然语言补充不能放宽成员、预算或并发硬边界。</p>
          {fieldError("orchestration") !== undefined ? (
            <p className="banner error">{fieldError("orchestration")}</p>
          ) : null}
        </section>

        <section className="team-editor-section" aria-labelledby="team-section-review">
          <h2 id="team-section-review">审查与汇总</h2>
          <div className="team-field-grid">
            <label className="team-field">
              <span>审查模式</span>
              <select
                aria-label="审查模式"
                value={hasReviewer ? draft.reviewMode : "none"}
                disabled={!hasReviewer}
                onChange={(event) => {
                  setReviewTouched(true);
                  update({ reviewMode: event.target.value as ExpertTeam["review"]["mode"] });
                }}
              >
                {REVIEW_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <em className="team-field-hint">
                {hasReviewer ? "存在审查成员；新团队默认汇总前统一审查。" : "没有审查成员时只能选择不审查。"}
              </em>
            </label>
            <label className="team-field">
              <span>返修上限</span>
              <select
                aria-label="返修上限"
                value={String(draft.maxRevisionRounds)}
                disabled={draft.reviewMode === "none" || !hasReviewer}
                onChange={(event) =>
                  update({ maxRevisionRounds: Number(event.target.value) as TeamDraft["maxRevisionRounds"] })
                }
              >
                <option value="0">0 轮</option>
                <option value="1">1 轮</option>
                <option value="2">2 轮</option>
              </select>
            </label>
            <label className="team-field grow">
              <span>审查标准（可选）</span>
              <textarea
                aria-label="审查标准"
                rows={2}
                maxLength={500}
                value={draft.reviewCriteria}
                onChange={(event) => update({ reviewCriteria: event.target.value })}
              />
            </label>
            <label className="team-field">
              <span>默认交付</span>
              <select
                aria-label="默认交付"
                value={draft.delivery}
                onChange={(event) => {
                  const delivery = event.target.value as ExpertTeam["summary"]["delivery"];
                  // 仅会话模式保留已选 Artifact 格式作为切回时的默认，但不在界面展示。
                  update({ delivery });
                }}
              >
                <option value="artifact">主 Artifact</option>
                <option value="message">仅会话消息</option>
              </select>
            </label>
            {draft.delivery === "artifact" ? (
              <label className="team-field">
                <span>报告格式</span>
                <select
                  aria-label="报告格式"
                  value={draft.artifactFormat}
                  onChange={(event) =>
                    update({ artifactFormat: event.target.value as ExpertTeam["summary"]["artifactFormat"] })
                  }
                >
                  <option value="markdown">Markdown</option>
                  <option value="html">HTML</option>
                </select>
              </label>
            ) : null}
            <label className="team-field">
              <span>汇总方式</span>
              <select
                aria-label="汇总方式"
                value={draft.summaryMode}
                onChange={(event) =>
                  update({ summaryMode: event.target.value as ExpertTeam["summary"]["mode"] })
                }
              >
                {SUMMARY_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="team-field grow">
              <span>汇总重点（可选）</span>
              <textarea
                aria-label="汇总说明"
                rows={2}
                maxLength={500}
                value={draft.summaryInstructions}
                onChange={(event) => update({ summaryInstructions: event.target.value })}
              />
            </label>
          </div>
          {fieldError("review") !== undefined ? <p className="banner error">{fieldError("review")}</p> : null}
          {fieldError("summary") !== undefined ? <p className="banner error">{fieldError("summary")}</p> : null}
        </section>

        <section className="team-editor-section team-save-summary" aria-labelledby="team-section-summary">
          <h2 id="team-section-summary">保存前摘要</h2>
          <p>
            调度：{ASSIGNMENT_OPTIONS.find((option) => option.value === draft.assignmentMode)?.label} ·{" "}
            {ORDER_OPTIONS.find((option) => option.value === draft.executionOrder)?.label} · 并发上限{" "}
            {effectiveMaxParallel} · 每次运行最多 24 次派工
          </p>
          <ul className="team-summary-members">
            {draft.members.map((member) => {
              const pkg = packageFor(member);
              return (
                <li key={member.memberId}>
                  {memberDisplayName(member)}（{ROLE_LABELS[member.role]}）
                  {member.responsibility.trim() === "" ? "：职责未填写" : `：${member.responsibility.trim()}`}
                  {" · "}
                  原生能力：{pkg === undefined ? "成员失效" : expertTeamCapabilitiesText(pkg.capabilities)}
                </li>
              );
            })}
          </ul>
          <p>
            审查：{REVIEW_OPTIONS.find((option) => option.value === (hasReviewer ? draft.reviewMode : "none"))?.label} · 必审名单：
            {reviewers.length === 0 ? "无" : reviewers.map(memberDisplayName).join("、")} · 返修上限{" "}
            {draft.reviewMode === "none" ? 0 : draft.maxRevisionRounds} 轮
          </p>
          <p>
            交付：{draft.delivery === "artifact" ? `主 Artifact（${draft.artifactFormat === "html" ? "HTML" : "Markdown"}）` : "仅会话消息"} ·{" "}
            {SUMMARY_MODE_OPTIONS.find((option) => option.value === draft.summaryMode)?.label}
          </p>
          <p>
            调用名：<code>{draft.slug === "" ? "@team:…" : `@team:${draft.slug}`}</code>
          </p>
        </section>
      </div>

      <div className="team-editor-actions">
        <button type="button" className="btn" onClick={requestClose}>
          返回列表
        </button>
        <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
          保存专家团
        </button>
      </div>

      {leaveConfirm ? (
        <div
          className="team-leave-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-label="未保存修改"
          onKeyDown={(event) => {
            if (event.key === "Escape") setLeaveConfirm(false);
          }}
        >
          <p>有未保存的修改，确定返回列表吗？</p>
          <div className="team-leave-actions">
            <button type="button" className="btn danger" onClick={onClose}>
              放弃修改
            </button>
            <button type="button" className="btn" autoFocus onClick={() => setLeaveConfirm(false)}>
              继续编辑
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
