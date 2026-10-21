import { Fragment, useEffect, useMemo, useState } from "react";

import BoardView from "./BoardView.tsx";
import HistoryDetailPane, { type SessionDetailRecord, type SessionLogView } from "./HistoryDetailPane.tsx";
import { rpcCall } from "./api.ts";
import {
  automationRuns,
  createAutomation,
  describeSchedule,
  listAutomationTemplates,
  pruneAutomationSessions,
  removeAutomation,
  runAutomation,
  updateAutomation,
  type AutomationInfo,
  type AutomationSchedule,
  type AutomationTemplate,
  type ProjectInfo,
  type RunSummary,
} from "./projects.ts";
import { humanizeCronText } from "./logic/scheduleText.ts";
import { buildUnattendedAllow as computeUnattendedAllow } from "./logic/unattendedAllow.ts";

type Props = {
  projects: ProjectInfo[];
  activeProjectId: string | null;
  automations: AutomationInfo[];
  runs: Record<string, RunSummary[]>;
  /** 正在后台执行的任务 id 集合（run-start 加入 / run-end 移除）。 */
  runningIds: ReadonlySet<string>;
  /**
   * App 下发的一次性入口意图：create=自动打开该项目的创建表单（待配置）；focus=切到「任务」tab。
   * Task 13：composer 命中自然语言调度短语时，create 意图额外带 schedule/prompt 预填（同 applyTemplate 的一次性赋值语义）。
   */
  enterIntent?: {
    mode: "create" | "focus";
    /** issue #2：可空——create 一律为 null(表单内下拉默认「不绑定」);focus 允许无归属任务。 */
    projectId: string | null;
    schedule?: AutomationSchedule;
    prompt?: string;
  } | null;
  /** enterIntent 被消费后通知 App 清空，避免重复触发。 */
  onEnterIntentConsumed?: () => void;
  onChanged: () => void;
  /**
   * review finding 5：composer 自然语言拦截创建的任务真正落地后，通知 App 清空对应草稿
   * （App 侧不再在拦截当时清空草稿——那样一旦用户取消/关闭创建表单，草稿就无处还原）。
   * 手动点「＋新建任务」创建成功也会触发（此时 App 侧草稿本就为空或与本次创建无关，清空无害）。
   */
  onAutomationCreated?: () => void;
  /** 手动运行把工作区热切换到任务所属目录后通知 App 对齐界面。 */
  onWorkspaceAligned?: (workspaceRoot: string) => void;
  /** Task 10：保持系统唤醒设置值（与账户页共用同一持久化字段）。 */
  keepAwake: boolean;
  onToggleKeepAwake: (next: boolean) => void;
  /** Task 11：missed 启动横幅展示态，由 App 依据本次会话收到的 automation/missed 事件数计算。 */
  missedBanner: { visible: boolean; count: number };
  onDismissMissedBanner: () => void;
};

type Tab = "tasks" | "runs" | "board";
type Editing =
  | {
      mode: "create";
      /** 创建表单项目下拉的初始值;issue #2 起所有入口一律传 null(默认不绑定)。 */
      projectId: string | null;
      /** Task 13：composer 命中自然语言调度短语时的预填（一次性赋值，用户仍可改动任意字段）。 */
      schedule?: AutomationSchedule;
      prompt?: string;
    }
  | { mode: "edit"; automation: AutomationInfo };

type RunStatus = NonNullable<RunSummary["status"]>;

/** 运行状态五态映射：label 为行内文案，className 复用既有 ok/err 色调，color 供无 CSS 的新态内联着色。 */
const RUN_STATUS_META: Record<RunStatus, { label: string; className?: "ok" | "err"; color?: string }> = {
  ok: { label: "成功", className: "ok" },
  error: { label: "失败", className: "err" },
  missed: { label: "已错过", color: "#B45309" },
  timeout: { label: "超时", color: "#B45309" },
  cancelled: { label: "已取消", color: "var(--text-muted)" },
};

/** 旧记录无 status 字段：按 ok 布尔回填。 */
function runStatusOf(run: RunSummary): RunStatus {
  return run.status ?? (run.ok ? "ok" : "error");
}

const DOW_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const SCHEDULE_KIND_OPTIONS: { value: AutomationSchedule["kind"]; label: string }[] = [
  { value: "manual", label: "手动" },
  { value: "once", label: "单次" },
  { value: "interval", label: "每隔几分钟" },
  { value: "hourly", label: "每小时" },
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
  { value: "cron", label: "自定义（cron）" },
];

/** 自动化页：顶部「任务 / 运行记录 / 看板」三 tab，跨项目全局视图（无项目选择器）；仅展示自动化任务，子任务仍在项目卡片内。 */
export default function AutomationsView({
  projects,
  automations,
  runs,
  runningIds,
  enterIntent,
  onEnterIntentConsumed,
  onChanged,
  onAutomationCreated,
  onWorkspaceAligned,
  keepAwake,
  onToggleKeepAwake,
  missedBanner,
  onDismissMissedBanner,
}: Props) {
  // 注意:Props 里的 activeProjectId 不再用于创建归属(issue #2 起创建一律默认不绑定),仅为兼容 App 调用保留。
  const [tab, setTab] = useState<Tab>("tasks");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirming, setConfirming] = useState<AutomationInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // App 下发的一次性入口：「新建任务」选择器直接开创建表单。消费后通知 App 清除。
  useEffect(() => {
    if (!enterIntent) return;
    setTab("tasks");
    if (enterIntent.mode === "create") {
      setEditing({
        mode: "create",
        projectId: enterIntent.projectId,
        schedule: enterIntent.schedule,
        prompt: enterIntent.prompt,
      });
    }
    onEnterIntentConsumed?.();
  }, [enterIntent, onEnterIntentConsumed]);

  // 项目选择器已移除（2026-09-10）：任务 / 运行记录 / 看板均为跨项目全局视图。
  // issue #2：「新建任务」不再隐式归属——一律以 null 进表单,绑定由表单内项目下拉显式选择。
  const projectNameOf = useMemo(() => {
    const names = new Map(projects.map((project) => [project.id, project.name]));
    return (id: string | null) => (id ? (names.get(id) ?? "") : "");
  }, [projects]);

  async function toggleEnabled(automation: AutomationInfo) {
    setBusy(true);
    setError("");
    try {
      await updateAutomation(automation.id, { enabled: !automation.enabled });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function run(automation: AutomationInfo) {
    setError("");
    try {
      const started = await runAutomation(automation.id);
      if (started.workspaceRoot) onWorkspaceAligned?.(started.workspaceRoot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitRemove() {
    if (!confirming) return;
    setBusy(true);
    setError("");
    try {
      await removeAutomation(confirming.id);
      setConfirming(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-view">
      {missedBanner.visible ? (
        <div className="banner warn missed-banner">
          <span>有 {missedBanner.count} 次运行被错过</span>
          <button type="button" className="side-action" onClick={onDismissMissedBanner}>
            知道了
          </button>
        </div>
      ) : null}
      <div className="page-head">
        <h1>自动化</h1>
        <span className="hint-text">定时或手动驱动的自动化任务，产出可推送到项目看板</span>
        <span className="composer-spacer" />
        <span className="keep-awake-toggle" title="存在启用中的定时任务时阻止系统睡眠">
          <span className="hint-text">保持系统唤醒</span>
          <button
            type="button"
            className={keepAwake ? "switch on" : "switch"}
            role="switch"
            aria-checked={keepAwake}
            aria-label={keepAwake ? "关闭保持系统唤醒" : "开启保持系统唤醒"}
            onClick={() => onToggleKeepAwake(!keepAwake)}
          >
            <span className="knob" />
          </button>
        </span>
      </div>

      <div className="page-tools">
        <div className="seg automation-tabs" role="tablist" aria-label="自动化视图">
          <button type="button" role="tab" aria-selected={tab === "tasks"} className={tab === "tasks" ? "on" : ""} onClick={() => setTab("tasks")}>
            任务
          </button>
          <button type="button" role="tab" aria-selected={tab === "runs"} className={tab === "runs" ? "on" : ""} onClick={() => setTab("runs")}>
            运行记录
          </button>
          <button type="button" role="tab" aria-selected={tab === "board"} className={tab === "board" ? "on" : ""} onClick={() => setTab("board")}>
            看板
          </button>
        </div>
        <span className="composer-spacer" />
        {tab === "tasks" ? (
          <button
            type="button"
            className="btn-dark"
            onClick={() => setEditing({ mode: "create", projectId: null })}
          >
            ＋ 新建任务
          </button>
        ) : null}
      </div>

      {error ? <p className="banner error" style={{ borderRadius: 8, marginBottom: 12 }}>{error}</p> : null}

      {tab === "tasks" ? (
        // issue #2：任务不再要求项目归属,零项目也直接展示列表/空态,创建入口始终可用。
        automations.length === 0 ? (
          <div className="empty-state">
            <div>
              <div className="art">
                <svg viewBox="0 0 48 48" width={64} height={64} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden>
                  <title>任务</title>
                  <circle cx="24" cy="24" r="18" />
                  <path d="M24 14v10l7 4" />
                </svg>
              </div>
              <p>还没有自动化任务</p>
              <p className="sub">创建一个定时对话或脚本任务，让 HuaAnWork 按计划自动执行</p>
            </div>
          </div>
        ) : (
          <div className="automation-list">
            {automations.map((automation) => (
              <AutomationRow
                key={automation.id}
                automation={automation}
                projectName={projectNameOf(automation.projectId)}
                runs={runs[automation.id] ?? []}
                running={runningIds.has(automation.id)}
                busy={busy}
                onToggle={() => void toggleEnabled(automation)}
                onRun={() => void run(automation)}
                onEdit={() => setEditing({ mode: "edit", automation })}
                onRemove={() => setConfirming(automation)}
              />
            ))}
          </div>
        )
      ) : tab === "runs" ? (
        <RunsPanel automations={automations} onChanged={onChanged} />
      ) : (
        <BoardView automations={automations} runs={runs} projectId={null} projects={projects} />
      )}

      {editing ? (
        <AutomationFormModal
          editing={editing}
          projects={projects}
          onClose={() => setEditing(null)}
          onChanged={onChanged}
          onCreated={onAutomationCreated}
          onDone={() => {
            setEditing(null);
            onChanged();
          }}
        />
      ) : null}

      {confirming ? (
        <div className="settings-overlay" role="dialog" aria-label="删除任务确认">
          <div className="confirm-modal">
            <h3>删除任务</h3>
            <p className="hint" style={{ margin: 0, fontWeight: 600 }}>
              {confirming.name}
            </p>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              任务及其运行历史将被移除，此操作无法撤销。确定删除吗？
            </p>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(null)}>
                取消
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void submitRemove()}>
                {busy ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AutomationRow({
  automation,
  projectName,
  runs,
  running,
  busy,
  onToggle,
  onRun,
  onEdit,
  onRemove,
}: {
  automation: AutomationInfo;
  /** 跨项目全局列表（2026-09-10 移除项目选择器）需要行内归属标识。 */
  projectName: string;
  runs: RunSummary[];
  running: boolean;
  busy: boolean;
  onToggle: () => void;
  onRun: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={open ? "automation-row open" : "automation-row"}>
      <div className="automation-main">
        <button type="button" className="automation-expand" aria-label={open ? "收起运行历史" : "展开运行历史"} aria-expanded={open} onClick={() => setOpen((prev) => !prev)}>
          {open ? "▾" : "▸"}
        </button>
        <div className="automation-info">
          <div className="automation-title">
            <span className="automation-name">{automation.name}</span>
            {projectName ? <span className="automation-chip">{projectName}</span> : null}
            <span className="automation-chip">{automation.kind === "agent" ? "定时对话" : "脚本"}</span>
            {automation.widget ? <span className="automation-chip widget">看板</span> : null}
            {!automation.enabled ? <span className="automation-chip off">已停用</span> : null}
          </div>
          <span className="automation-meta">
            {describeSchedule(automation.schedule)} · {lastRunLabel(automation, running)}
            {automation.kind === "agent" && automation.prompt ? ` · ${automation.prompt.slice(0, 40)}` : ""}
            {automation.kind === "script" && automation.command ? ` · ${automation.command.slice(0, 40)}` : ""}
          </span>
        </div>
        <div className="automation-actions">
          <button
            type="button"
            className={automation.enabled ? "switch on" : "switch"}
            role="switch"
            aria-checked={automation.enabled}
            aria-label={automation.enabled ? "停用任务" : "启用任务"}
            disabled={busy}
            onClick={onToggle}
          >
            <span className="knob" />
          </button>
          <button type="button" className="side-action" disabled={running} onClick={onRun}>
            {running ? "运行中…" : "立即运行"}
          </button>
          <button type="button" className="side-action" onClick={onEdit}>
            编辑
          </button>
          <button type="button" className="side-action danger" onClick={onRemove}>
            删除
          </button>
        </div>
      </div>
      {open ? (
        runs.length === 0 ? (
          <p className="automation-runs-empty">还没有运行记录</p>
        ) : (
          <ul className="automation-runs">
            {[...runs].reverse().map((run) => {
              const meta = RUN_STATUS_META[runStatusOf(run)];
              return (
                <li key={run.runId} className={meta.className ?? ""}>
                  <span className="run-time">{formatRunTime(run.endedAt)}</span>
                  <span className="run-status" style={meta.color ? { color: meta.color } : undefined}>
                    {meta.label}
                  </span>
                  <pre className="run-output">{run.output || "（无输出）"}</pre>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </div>
  );
}

function lastRunLabel(automation: AutomationInfo, running: boolean): string {
  if (running) return "运行中";
  if (!automation.lastRunAt) return "从未运行";
  const status = automation.lastStatus === "ok" ? "成功" : automation.lastStatus === "error" ? "失败" : "";
  return `上次 ${formatRunTime(automation.lastRunAt)}${status ? ` · ${status}` : ""}`;
}

/** 「运行记录」tab：吃 automation.runs 全量运行，支持状态筛选、按日分组与点开会话详情（行内展开历史保留在任务行）。 */
function RunsPanel({ automations, onChanged }: { automations: AutomationInfo[]; onChanged: () => void }) {
  const [fullRuns, setFullRuns] = useState<Record<string, RunSummary[]>>({});
  const [statusFilter, setStatusFilter] = useState<"all" | RunStatus>("all");
  const [pruning, setPruning] = useState(false);
  const [pruneConfirm, setPruneConfirm] = useState(false);
  const [notice, setNotice] = useState("");
  /** 点开的运行会话详情（HistoryDetailPane 只读渲染，含原始日志切换）。 */
  const [detail, setDetail] = useState<SessionLogView | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        automations.map(async (automation) => {
          try {
            return [automation.id, (await automationRuns(automation.id)).runs] as const;
          } catch {
            return [automation.id, []] as const;
          }
        }),
      );
      if (!cancelled) setFullRuns(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [automations]);

  const rows = useMemo(() => {
    const merged: { automation: AutomationInfo; run: RunSummary }[] = [];
    for (const automation of automations) {
      for (const run of fullRuns[automation.id] ?? []) {
        if (statusFilter !== "all" && runStatusOf(run) !== statusFilter) continue;
        merged.push({ automation, run });
      }
    }
    merged.sort((a, b) => b.run.startedAt - a.run.startedAt);
    return merged;
  }, [automations, fullRuns, statusFilter]);

  /** 按日分组（spec Phase 3 仅要求 day 粒度）：组内保持 startedAt 倒序。 */
  const dayGroups = useMemo(() => {
    const groups: { key: string; label: string; rows: { automation: AutomationInfo; run: RunSummary }[] }[] = [];
    const index = new Map<string, (typeof groups)[number]>();
    for (const row of rows) {
      const day = new Date(row.run.startedAt);
      const key = day.toDateString();
      let group = index.get(key);
      if (!group) {
        group = { key, label: runDayLabel(day), rows: [] };
        index.set(key, group);
        groups.push(group);
      }
      group.rows.push(row);
    }
    return groups;
  }, [rows]);

  /** 点开一行：按 run.sessionId 经 session.open 拉取完整会话与工具轨迹。 */
  async function openRunSession(automation: AutomationInfo, run: RunSummary) {
    if (!run.sessionId || opening) return;
    setOpening(true);
    try {
      const opened = await rpcCall<{
        header?: Record<string, unknown>;
        log?: string;
        records?: SessionDetailRecord[];
        summary?: { title?: string; createdAt?: number; lastTime?: number; cwd?: string; messageCount?: number; turnCount?: number };
      }>("session.open", { sessionId: run.sessionId });
      const summary = opened.summary ?? {};
      setDetail({
        sessionId: run.sessionId,
        title: typeof summary.title === "string" && summary.title ? summary.title : `${automation.name} · ${formatRunTime(run.startedAt)}`,
        log: opened.log ?? "",
        records: Array.isArray(opened.records) ? opened.records : [],
        createdAt: typeof summary.createdAt === "number" ? summary.createdAt : undefined,
        lastTime: typeof summary.lastTime === "number" ? summary.lastTime : undefined,
        cwd: typeof summary.cwd === "string" ? summary.cwd : undefined,
        messageCount: typeof summary.messageCount === "number" ? summary.messageCount : undefined,
        turnCount: typeof summary.turnCount === "number" ? summary.turnCount : undefined,
      });
    } catch (error) {
      setDetail({
        sessionId: run.sessionId,
        title: `${automation.name} · ${formatRunTime(run.startedAt)}`,
        log: "",
        records: [],
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOpening(false);
    }
  }

  async function prune() {
    setPruning(true);
    setNotice("");
    try {
      const { removed } = await pruneAutomationSessions();
      setNotice(`已清理 ${removed} 个历史运行会话`);
      setPruneConfirm(false);
      onChanged();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setPruning(false);
    }
  }

  if (detail) {
    // 只读 drill-down：不提供「继续此会话」（运行会话恢复会劫持主对话流），返回回到列表。
    return <HistoryDetailPane view={detail} busy={opening} canResume={false} onResume={() => undefined} onClose={() => setDetail(null)} />;
  }

  return (
    <div>
      <div className="page-tools" style={{ marginBottom: 10 }}>
        <select
          className="project-select"
          value={statusFilter}
          aria-label="按状态筛选"
          onChange={(event) => setStatusFilter(event.target.value as "all" | RunStatus)}
        >
          <option value="all">全部状态</option>
          <option value="ok">成功</option>
          <option value="error">失败</option>
          <option value="missed">已错过</option>
          <option value="timeout">超时</option>
          <option value="cancelled">已取消</option>
        </select>
        <span className="composer-spacer" />
        {pruneConfirm ? (
          <>
            <span className="muted" style={{ fontSize: 12 }}>
              将删除最近 20 条运行之外的会话目录，确定？
            </span>
            <button type="button" className="btn danger" disabled={pruning} onClick={() => void prune()}>
              {pruning ? "清理中…" : "确认清理"}
            </button>
            <button type="button" className="btn" disabled={pruning} onClick={() => setPruneConfirm(false)}>
              取消
            </button>
          </>
        ) : (
          <button type="button" className="side-action" onClick={() => setPruneConfirm(true)}>
            清理历史运行会话
          </button>
        )}
      </div>
      {notice ? <p className="muted" style={{ margin: "0 0 8px", fontSize: 12 }}>{notice}</p> : null}
      {rows.length === 0 ? (
        <p className="automation-runs-empty">没有匹配的运行记录</p>
      ) : (
        <ul className="automation-runs">
          {dayGroups.map((group) => (
            <Fragment key={group.key}>
              <li className="run-day" aria-hidden>
                {group.label}
              </li>
              {group.rows.map(({ automation, run }) => {
                const meta = RUN_STATUS_META[runStatusOf(run)];
                const seconds = typeof run.durationMs === "number" ? ` · ${Math.round(run.durationMs / 1000)}s` : "";
                const catchup = run.trigger === "catchup" && run.coalescedCount ? ` · 补跑×${run.coalescedCount}` : "";
                const head = (
                  <>
                    <span className="run-time">{formatRunTime(run.startedAt)}</span>
                    <span className="run-status" style={meta.color ? { color: meta.color } : undefined}>
                      {meta.label}
                    </span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {automation.name}
                      {seconds}
                      {catchup}
                    </span>
                  </>
                );
                return (
                  <li key={run.runId} className={meta.className ?? ""}>
                    {run.sessionId ? (
                      <button
                        type="button"
                        className="run-row-btn"
                        title="查看完整会话与工具轨迹"
                        onClick={() => void openRunSession(automation, run)}
                      >
                        {head}
                      </button>
                    ) : (
                      head
                    )}
                    <pre className="run-output">{run.output || "（无输出）"}</pre>
                  </li>
                );
              })}
            </Fragment>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 按日分组标题：今天 / 昨天 / M月D日（跨年补年份）。 */
function runDayLabel(day: Date): string {
  const now = new Date();
  if (day.toDateString() === now.toDateString()) return "今天";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day.toDateString() === yesterday.toDateString()) return "昨天";
  const label = `${day.getMonth() + 1}月${day.getDate()}日`;
  return day.getFullYear() === now.getFullYear() ? label : `${day.getFullYear()}年${label}`;
}

/** epoch ms → datetime-local 输入值（本地墙钟，与 sidecar 的本地时区语义一致）。 */
function toLocalInput(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** cron 实时预览：合法给中文描述，非法给 sidecar 同款报错文案（提交时仍由后端校验兜底）。 */
function cronPreview(expr: string): string {
  try {
    return `预览：${humanizeCronText(expr)}`;
  } catch (error) {
    return `表达式无效：${error instanceof Error ? error.message : String(error)}`;
  }
}

/** 新建 / 编辑任务模态。提交与校验主要依赖 sidecar，错误信息回显在模态内。 */
function AutomationFormModal({
  editing,
  projects,
  onClose,
  onChanged,
  onCreated,
  onDone,
}: {
  editing: Editing;
  /** issue #2：创建表单的项目下拉数据源（默认「不绑定」）。 */
  projects: ProjectInfo[];
  onClose: () => void;
  onChanged: () => void;
  /** review finding 5：仅在 create 分支真正创建成功后调用一次，通知 App 侧清空对应的 composer 草稿。 */
  onCreated?: () => void;
  onDone: () => void;
}) {
  const source = editing.mode === "edit" ? editing.automation : null;
  // Task 13：composer 命中自然语言调度短语时的一次性预填（同 applyTemplate 语义，仅创建模式生效，用户仍可改动任意字段）。
  const prefillSchedule = editing.mode === "create" ? editing.schedule : undefined;
  const prefillPrompt = editing.mode === "create" ? editing.prompt : undefined;
  const [name, setName] = useState(source?.name ?? "");
  // issue #2：项目归属显式选择,默认「不绑定」(null);仅创建模式可选,编辑不可改(sidecar update 白名单不含 projectId)。
  const [bindProjectId, setBindProjectId] = useState<string | null>(
    editing.mode === "create" ? editing.projectId : (source?.projectId ?? null),
  );
  const [kind, setKind] = useState<"agent" | "script">(source?.kind ?? "agent");
  const [scheduleKind, setScheduleKind] = useState<AutomationSchedule["kind"]>(
    source?.schedule.kind ?? prefillSchedule?.kind ?? "manual",
  );
  const [onceAt, setOnceAt] = useState(
    source?.schedule.kind === "once"
      ? toLocalInput(source.schedule.at)
      : prefillSchedule?.kind === "once"
        ? toLocalInput(prefillSchedule.at)
        : "",
  );
  const [minutes, setMinutes] = useState(
    source?.schedule.kind === "interval"
      ? String(source.schedule.minutes)
      : prefillSchedule?.kind === "interval"
        ? String(prefillSchedule.minutes)
        : "30",
  );
  const [hourlyMinute, setHourlyMinute] = useState(
    source?.schedule.kind === "hourly"
      ? String(source.schedule.minute)
      : prefillSchedule?.kind === "hourly"
        ? String(prefillSchedule.minute)
        : "0",
  );
  const [dailyTime, setDailyTime] = useState(
    source?.schedule.kind === "daily"
      ? source.schedule.time
      : prefillSchedule?.kind === "daily"
        ? prefillSchedule.time
        : "09:00",
  );
  const [weeklyDays, setWeeklyDays] = useState<number[]>(
    source?.schedule.kind === "weekly"
      ? [...source.schedule.days]
      : prefillSchedule?.kind === "weekly"
        ? [...prefillSchedule.days]
        : [],
  );
  const [weeklyTime, setWeeklyTime] = useState(
    source?.schedule.kind === "weekly"
      ? source.schedule.time
      : prefillSchedule?.kind === "weekly"
        ? prefillSchedule.time
        : "09:00",
  );
  const [monthlyDates, setMonthlyDates] = useState<number[]>(
    source?.schedule.kind === "monthly"
      ? [...source.schedule.dates]
      : prefillSchedule?.kind === "monthly"
        ? [...prefillSchedule.dates]
        : [],
  );
  const [monthlyTime, setMonthlyTime] = useState(
    source?.schedule.kind === "monthly"
      ? source.schedule.time
      : prefillSchedule?.kind === "monthly"
        ? prefillSchedule.time
        : "09:00",
  );
  const [cronExpr, setCronExpr] = useState(
    source?.schedule.kind === "cron"
      ? source.schedule.expr
      : prefillSchedule?.kind === "cron"
        ? prefillSchedule.expr
        : "",
  );
  const [expiresAt, setExpiresAt] = useState(source?.expiresAt ? toLocalInput(source.expiresAt) : "");
  const [missedPolicy, setMissedPolicy] = useState<"skip" | "run-once">(source?.missedPolicy ?? "skip");
  const [taskShape, setTaskShape] = useState<"independent" | "merged">(source?.taskShape ?? "independent");
  // Phase 2：无人值守授权（方案 A）。默认关闭；开启时套只读+写/编辑的默认白名单，
  // bash/pwsh 需用户显式勾选（UNATTENDED_DEFAULT_ALLOW 之外的唯一可选项）。
  const [unattendedEnabled, setUnattendedEnabled] = useState(source?.unattended?.enabled ?? false);
  const [unattendedShell, setUnattendedShell] = useState(
    (source?.unattended?.allow ?? []).some((tool) => tool === "bash" || tool === "pwsh"),
  );
  const [prompt, setPrompt] = useState(source?.prompt ?? prefillPrompt ?? "");
  const [command, setCommand] = useState(source?.command ?? "");
  const [widget, setWidget] = useState(source?.widget ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** undefined=尚未提交；number|null=已提交，值为后端算好的 nextRunAt（null=无后续触发）。 */
  const [savedNextRun, setSavedNextRun] = useState<number | null | undefined>(undefined);

  // Task 12：内置任务模板——仅创建模式加载，选中只预填字段（不调用 automation.create）；
  // 用户此后改动任意字段都保留（选模板不是受控绑定，只是一次性赋值）。
  const [templates, setTemplates] = useState<AutomationTemplate[]>([]);
  const [templateChoice, setTemplateChoice] = useState("");
  useEffect(() => {
    if (editing.mode !== "create") return;
    let active = true;
    listAutomationTemplates()
      .then(({ templates: list }) => {
        if (active) setTemplates(list);
      })
      .catch(() => {
        // 模板加载失败不阻塞创建：静默降级为「不使用模板」。
      });
    return () => {
      active = false;
    };
  }, [editing.mode]);

  function applyTemplate(template: AutomationTemplate) {
    setName(template.name);
    setKind(template.kind);
    setScheduleKind(template.schedule.kind);
    if (template.schedule.kind === "once") setOnceAt(toLocalInput(template.schedule.at));
    if (template.schedule.kind === "interval") setMinutes(String(template.schedule.minutes));
    if (template.schedule.kind === "hourly") setHourlyMinute(String(template.schedule.minute));
    if (template.schedule.kind === "daily") setDailyTime(template.schedule.time);
    if (template.schedule.kind === "weekly") {
      setWeeklyDays([...template.schedule.days]);
      setWeeklyTime(template.schedule.time);
    }
    if (template.schedule.kind === "monthly") {
      setMonthlyDates([...template.schedule.dates]);
      setMonthlyTime(template.schedule.time);
    }
    if (template.schedule.kind === "cron") setCronExpr(template.schedule.expr);
    if (template.kind === "agent") setPrompt(template.prompt ?? "");
    else setCommand(template.command ?? "");
  }

  const availableTemplates = templates;

  /**
   * Phase 2 白名单：创建时用默认基础列表（只读 + 写/编辑）；编辑时以已存的 `source.unattended.allow`
   * 为基底（review finding 3：不能用硬编码默认列表冲掉用户此前收窄过的列表），只按 shell 勾选框
   * 增删 bash/pwsh。sidecar 侧仍会按 UNATTENDED_TOOL_NAMES 二次过滤。
   */
  function buildUnattendedAllow(): string[] {
    return computeUnattendedAllow({ storedAllow: source?.unattended?.allow, shellChecked: unattendedShell });
  }

  function toggleDay(day: number) {
    setWeeklyDays((prev) => (prev.includes(day) ? prev.filter((item) => item !== day) : [...prev, day]));
  }

  function toggleDate(date: number) {
    setMonthlyDates((prev) => (prev.includes(date) ? prev.filter((item) => item !== date) : [...prev, date]));
  }

  function buildSchedule(): AutomationSchedule {
    switch (scheduleKind) {
      case "once":
        return { kind: "once", at: new Date(onceAt).getTime() };
      case "interval":
        return { kind: "interval", minutes: Math.max(1, Math.floor(Number(minutes) || 1)) };
      case "hourly":
        return { kind: "hourly", minute: Math.min(59, Math.max(0, Math.floor(Number(hourlyMinute) || 0))) };
      case "daily":
        return { kind: "daily", time: dailyTime };
      case "weekly":
        return { kind: "weekly", days: [...weeklyDays].sort((a, b) => a - b), time: weeklyTime };
      case "monthly":
        return { kind: "monthly", dates: [...monthlyDates].sort((a, b) => a - b), time: monthlyTime };
      case "cron":
        return { kind: "cron", expr: cronExpr.trim() };
      default:
        return { kind: "manual" };
    }
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const schedule = buildSchedule();
      if (editing.mode === "create") {
        const { automation } = await createAutomation({
          projectId: bindProjectId,
          name: name.trim(),
          kind,
          schedule,
          // create 用 undefined 表示不设置（与 sidecar 白名单配对）。
          prompt: kind === "agent" ? prompt.trim() : undefined,
          command: kind === "script" ? command.trim() : undefined,
          widget,
          expiresAt: expiresAt ? new Date(expiresAt).getTime() : undefined,
          missedPolicy,
          taskShape,
          ...(unattendedEnabled
            ? { unattended: { enabled: true, allow: buildUnattendedAllow() } }
            : {}),
        });
        setSavedNextRun(automation.nextRunAt ?? null);
        onCreated?.();
      } else {
        const { automation } = await updateAutomation(editing.automation.id, {
          name: name.trim(),
          kind,
          schedule,
          // update 用 "" 清空可空字段（与 sidecar 白名单 patch 配对）。
          prompt: kind === "agent" ? prompt.trim() : "",
          command: kind === "script" ? command.trim() : "",
          widget,
          expiresAt: expiresAt ? new Date(expiresAt).getTime() : "",
          missedPolicy,
          taskShape,
          unattended: unattendedEnabled ? { enabled: true, allow: buildUnattendedAllow() } : "",
        });
        setSavedNextRun(automation.nextRunAt ?? null);
      }
      // 保存已成功（create 与 update 同路径）：列表立即刷新，saved 态下点「关闭」也不会看到旧列表。
      onChanged();
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const scheduleValid =
    scheduleKind === "manual" ||
    scheduleKind === "interval" ||
    scheduleKind === "hourly" ||
    scheduleKind === "daily" ||
    (scheduleKind === "once" && onceAt !== "" && new Date(onceAt).getTime() > Date.now()) ||
    (scheduleKind === "weekly" && weeklyDays.length > 0) ||
    (scheduleKind === "monthly" && monthlyDates.length > 0) ||
    (scheduleKind === "cron" && cronExpr.trim().length > 0);
  const valid =
    name.trim().length > 0 &&
    scheduleValid &&
    (kind !== "agent" || prompt.trim().length > 0) &&
    (kind !== "script" || command.trim().length > 0);

  const saved = savedNextRun !== undefined;

  return (
    <div className="settings-overlay" role="dialog" aria-label={source ? "编辑任务" : "新建任务"}>
      <div className="confirm-modal automation-form">
        <h3>{source ? "编辑任务" : "新建任务"}</h3>

        <div className="automation-form-body">
        <label className="modal-field">
          任务名称
          <input className="modal-input" value={name} autoFocus onChange={(event) => setName(event.target.value)} placeholder="如：每日早报" />
        </label>

        {editing.mode === "create" ? (
          <label className="modal-field">
            归属项目（可选）
            <select
              className="modal-input"
              value={bindProjectId ?? ""}
              aria-label="归属项目"
              onChange={(event) => setBindProjectId(event.target.value || null)}
            >
              <option value="">不绑定（中立任务）</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <span className="muted" style={{ fontSize: 12 }}>
              创建后不可更改；不绑定的任务与任何项目目录无关
            </span>
          </label>
        ) : null}

        {editing.mode === "create" && availableTemplates.length > 0 ? (
          <label className="modal-field">
            从模板开始（可选）
            <select
              className="modal-input"
              value={templateChoice}
              aria-label="任务模板"
              onChange={(event) => {
                const value = event.target.value;
                setTemplateChoice(value);
                const template = availableTemplates.find((item) => item.name === value);
                if (template) applyTemplate(template);
              }}
            >
              <option value="">不使用模板</option>
              {availableTemplates.map((template) => (
                <option key={template.name} value={template.name}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="modal-field">
          任务类型
          <div className="seg" role="tablist" aria-label="任务类型">
            <button type="button" role="tab" aria-selected={kind === "agent"} className={kind === "agent" ? "on" : ""} onClick={() => setKind("agent")}>
              定时对话
            </button>
            <button type="button" role="tab" aria-selected={kind === "script"} className={kind === "script" ? "on" : ""} onClick={() => setKind("script")}>
              脚本
            </button>
          </div>
        </div>

        <div className="modal-field">
          触发方式
          <select className="modal-input" value={scheduleKind} aria-label="触发方式" onChange={(event) => setScheduleKind(event.target.value as AutomationSchedule["kind"])}>
            {SCHEDULE_KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {scheduleKind === "once" ? (
            <>
              <input className="modal-input slim" type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} />
              <span className="muted" style={{ fontSize: 12 }}>到点触发一次后任务自动停用</span>
            </>
          ) : null}
          {scheduleKind === "interval" ? (
            <div className="interval-row">
              <input
                className="modal-input slim"
                type="number"
                min={1}
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
                aria-label="间隔分钟数"
              />
              <span className="muted">分钟</span>
            </div>
          ) : null}
          {scheduleKind === "hourly" ? (
            <div className="interval-row">
              <input
                className="modal-input slim"
                type="number"
                min={0}
                max={59}
                value={hourlyMinute}
                onChange={(event) => setHourlyMinute(event.target.value)}
                aria-label="每小时第几分钟"
              />
              <span className="muted">分钟（每小时的第 N 分钟触发）</span>
            </div>
          ) : null}
          {scheduleKind === "daily" ? (
            <input className="modal-input slim" type="time" value={dailyTime} onChange={(event) => setDailyTime(event.target.value)} />
          ) : null}
          {scheduleKind === "weekly" ? (
            <>
              <div className="seg" style={{ flexWrap: "wrap" }}>
                {DOW_LABELS.map((label, day) => (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={weeklyDays.includes(day)}
                    className={weeklyDays.includes(day) ? "on" : ""}
                    style={{ flex: "1 0 12%" }}
                    onClick={() => toggleDay(day)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <input className="modal-input slim" type="time" value={weeklyTime} onChange={(event) => setWeeklyTime(event.target.value)} aria-label="每周触发时间" />
            </>
          ) : null}
          {scheduleKind === "monthly" ? (
            <>
              <div className="seg" style={{ flexWrap: "wrap" }}>
                {Array.from({ length: 31 }, (_, index) => index + 1).map((date) => (
                  <button
                    key={date}
                    type="button"
                    aria-pressed={monthlyDates.includes(date)}
                    className={monthlyDates.includes(date) ? "on" : ""}
                    style={{ flex: "1 0 10%" }}
                    onClick={() => toggleDate(date)}
                  >
                    {date}
                  </button>
                ))}
              </div>
              <input className="modal-input slim" type="time" value={monthlyTime} onChange={(event) => setMonthlyTime(event.target.value)} aria-label="每月触发时间" />
            </>
          ) : null}
          {scheduleKind === "cron" ? (
            <>
              <input
                className="modal-input"
                value={cronExpr}
                onChange={(event) => setCronExpr(event.target.value)}
                placeholder="分 时 日 月 周，如：0 9 * * 1,4"
                aria-label="cron 表达式"
              />
              {cronExpr.trim() ? <span className="muted" style={{ fontSize: 12 }}>{cronPreview(cronExpr)}</span> : null}
            </>
          ) : null}
        </div>

        {kind === "agent" ? (
          <label className="modal-field">
            提示词（发给本地模型，产出进入运行历史与看板）
            <textarea
              className="modal-textarea"
              value={prompt}
              rows={4}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="如：请生成今日投研早报，包含市场概览与两条要点。"
            />
          </label>
        ) : (
          <label className="modal-field">
            命令（在项目目录下执行，取 stdout 作为产出）
            <input
              className="modal-input"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="如：node scripts/report.mjs"
            />
          </label>
        )}

        <label className="modal-check">
          <input type="checkbox" checked={widget} onChange={(event) => setWidget(event.target.checked)} />
          推送到项目看板
        </label>

        <label className="modal-field">
          生效截止（可选）
          <input className="modal-input slim" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
        </label>

        <div className="modal-field">
          错过补跑
          <select className="modal-input" value={missedPolicy} aria-label="错过补跑" onChange={(event) => setMissedPolicy(event.target.value as "skip" | "run-once")}>
            <option value="skip">跳过（记为已错过）</option>
            <option value="run-once">补跑一次</option>
          </select>
        </div>

        <div className="modal-field">
          产出形态
          <select className="modal-input" value={taskShape} aria-label="产出形态" onChange={(event) => setTaskShape(event.target.value as "independent" | "merged")}>
            <option value="independent">独立运行（每次开新运行会话）</option>
            <option value="merged">合并运行（带上次产出作为上下文）</option>
          </select>
        </div>

        {kind === "agent" ? (
          <>
            <label className="modal-check">
              <input
                type="checkbox"
                checked={unattendedEnabled}
                onChange={(event) => setUnattendedEnabled(event.target.checked)}
              />
              允许无人值守时自动放行需要确认的操作（默认关闭）
            </label>
            {unattendedEnabled ? (
              <>
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  只读与项目目录内的写/编辑本就被策略允许，与此开关无关（run_code 始终不可放行）；
                  未勾选下方选项时，本开关当前没有额外效果——真正需要授权的是 Shell 命令
                </p>
                <label className="modal-check">
                  <input
                    type="checkbox"
                    checked={unattendedShell}
                    onChange={(event) => setUnattendedShell(event.target.checked)}
                  />
                  同时允许无人值守时自动执行 Shell 命令（bash/pwsh，风险较高，需显式勾选）
                </label>
              </>
            ) : null}
          </>
        ) : null}
        </div>

        {error ? <p className="banner error" style={{ borderRadius: 8 }}>{error}</p> : null}
        {saved ? (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {savedNextRun === null ? "该任务没有后续触发时刻" : `下次运行：${formatRunTime(savedNextRun)}`}
          </p>
        ) : null}

        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {saved ? "关闭" : "取消"}
          </button>
          <button type="button" className="btn primary" disabled={busy || (!saved && !valid)} onClick={() => (saved ? onDone() : void submit())}>
            {busy ? "保存中…" : saved ? "完成" : source ? "保存" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 运行时间格式化（任务行与看板共用）。 */
export function formatRunTime(ts: number): string {
  const date = new Date(ts);
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
}
