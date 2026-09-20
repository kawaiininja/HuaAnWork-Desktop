import { formatRunTime } from "./AutomationsView.tsx";
import { projectRootName, type AutomationInfo, type ProjectInfo, type RunSummary } from "./projects.ts";

type Props = {
  projects: ProjectInfo[];
  automations: AutomationInfo[];
  runs: Record<string, RunSummary[]>;
  projectId: string | null;
};

/** 项目 Widget 看板：widget 任务的最新成功产出网格。 */
export default function BoardView({ projects, automations, runs, projectId }: Props) {
  const project = projects.find((item) => item.id === projectId) ?? null;
  const widgets = automations.filter(
    (automation) => automation.widget && (!projectId || automation.projectId === projectId),
  );
  const cards = widgets.map((automation) => ({
    automation,
    run: latestOkRun(runs[automation.id] ?? []),
  }));

  // projectId 为 null 即「全部项目」模式（自动化页移除项目选择器后恒为 null）：
  // 空态只看「是否一个项目都没有」，不能因为 projectId 为 null 就误判成无项目。
  if (projects.length === 0) {
    return (
      <div className="empty-state">
        <div>
          <p>还没有项目</p>
          <p className="sub">先在侧边栏「项目」区把一个目录登记为项目</p>
        </div>
      </div>
    );
  }

  return (
    <div className="board-view">
      <p className="board-sub muted">
        {project ? `${project.name} · ${projectRootName(project.root)}` : "全部项目"}的看板任务最新成功产出
      </p>
      {cards.length === 0 ? (
        <div className="empty-state">
          <div>
            <div className="art">
              <svg viewBox="0 0 48 48" width={64} height={64} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden>
                <title>看板</title>
                <rect x="6" y="8" width="36" height="32" rx="4" />
                <path d="M6 18h36M18 18v22M30 18v22" />
              </svg>
            </div>
            <p>看板还是空的</p>
            <p className="sub">新建任务时勾选「推送到项目看板」，任务成功运行后产出会出现在这里</p>
          </div>
        </div>
      ) : (
        <div className="board-grid">
          {cards.map(({ automation, run }) => (
            <div key={automation.id} className="board-card">
              <header className="board-card-head">
                <span className="board-card-name">{automation.name}</span>
                <span className="board-card-time">{run ? formatRunTime(run.endedAt) : "尚未成功运行"}</span>
              </header>
              {run ? <WidgetOutput output={run.output} /> : <p className="board-card-empty muted">暂无产出</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 最新一次成功运行（runs 按时间升序，从尾部向前找）。 */
function latestOkRun(runs: RunSummary[]): RunSummary | undefined {
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    if (runs[i].ok) return runs[i];
  }
  return undefined;
}

/** 产出渲染：JSON 数组 → 表格；JSON 对象 → 键值表；其余 → 原文。 */
function WidgetOutput({ output }: { output: string }) {
  const trimmed = output.trim();
  const table = parseTable(trimmed);
  if (table) {
    const columns = table.columns.slice(0, 6);
    const rows = table.rows.slice(0, 12);
    return (
      <div className="board-table-wrap">
        <table className="board-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column}>{cellText(row[column])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {table.rows.length > 12 ? <p className="board-table-more muted">仅显示前 12 行 / 共 {table.rows.length} 行</p> : null}
      </div>
    );
  }
  return <pre className="board-text">{output}</pre>;
}

function parseTable(text: string): { columns: string[]; rows: Record<string, unknown>[] } | undefined {
  if (!text.startsWith("[") && !text.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((row) => isPlainObject(row))) {
    const rows = parsed as Record<string, unknown>[];
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => key !== "__proto__");
    return { columns, rows };
  }
  if (isPlainObject(parsed)) {
    const record = parsed as Record<string, unknown>;
    const entryRows = Object.entries(record).map(([key, value]) => ({ 键: key, 值: value }));
    return { columns: ["键", "值"], rows: entryRows };
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
