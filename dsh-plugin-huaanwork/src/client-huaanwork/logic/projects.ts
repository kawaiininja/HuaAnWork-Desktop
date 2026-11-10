export type ProjectInfo = {
  id: string;
  name: string;
  root: string;
  createdAt: number;
  lastOpenedAt?: number;
};

export type AutomationSchedule =
  | { kind: "manual" }
  | { kind: "once"; at: number }                        // epoch ms，触发后自动 enabled=false
  | { kind: "interval"; minutes: number }
  | { kind: "hourly"; minute: number }                  // 0-59
  | { kind: "daily"; time: string }                     // HH:MM，保留兼容
  | { kind: "weekly"; days: number[]; time: string }    // 0-6，0=周日，7 归一化为 0
  | { kind: "monthly"; dates: number[]; time: string }  // 1-31，当月无此日则跳过该月
  | { kind: "cron"; expr: string };                     // 标准 5 字段

export type AutomationInfo = {
  id: string;
  projectId: string | null;                      // null = 历史存量中立归属；新建任务由 automation.create 自动建项目并绑定，改绑见 AutomationPatch.projectId
  name: string;
  kind: "agent" | "script";
  schedule: AutomationSchedule;
  prompt?: string;
  command?: string;
  widget: boolean;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  lastStatus?: "ok" | "error" | "running";
  expiresAt?: number;                              // 生效截止，到期自动 enabled=false
  missedPolicy?: "skip" | "run-once";              // 默认 "skip"
  taskShape?: "independent" | "merged";            // 默认 "independent"
  unattended?: { enabled: boolean; allow: string[] };  // Phase 2
  /** 注册表为 running 时的运行 id（恢复对账用）；终态对账必须清除。 */
  activeRunId?: string;
};

export type RunSummary = {
  runId: string;
  startedAt: number;
  endedAt: number;
  ok: boolean;
  output: string;
  status?: "ok" | "error" | "missed" | "timeout" | "cancelled";
  trigger?: "manual" | "schedule" | "catchup";
  coalescedCount?: number;
  sessionId?: string;
  durationMs?: number;
  /** 该运行创建的运行子任务 id；旧记录与未建子任务的运行没有此字段。 */
  taskId?: string;
};

export type AutomationTemplate = {
  name: string;
  kind: "agent" | "script";
  schedule: AutomationSchedule;
  prompt?: string;
  command?: string;
};

export type TaskInfo = {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  sessionId?: string;
  /** 该子任务首次真正开始执行时用的模型条目 id；还没跑过就不存在（旧 tasks.json 无此字段）。 */
  modelId?: string;
  /** 自动化来源（运行子任务）：只能成对出现，普通任务与旧 tasks.json 都没有。 */
  automationId?: string;
  runId?: string;
};

export type AutomationDraft = {
  projectId: string | null;
  name: string;
  kind: "agent" | "script";
  schedule: AutomationSchedule;
  prompt?: string;
  command?: string;
  widget?: boolean;
  enabled?: boolean;
  expiresAt?: number;
  missedPolicy?: "skip" | "run-once";
  taskShape?: "independent" | "merged";
  unattended?: { enabled: boolean; allow: string[] };
};

export type AutomationPatch = {
  name?: string;
  kind?: "agent" | "script";
  schedule?: AutomationSchedule;
  prompt?: string;
  command?: string;
  widget?: boolean;
  enabled?: boolean;
  expiresAt?: number | "";
  missedPolicy?: "skip" | "run-once" | "";
  taskShape?: "independent" | "merged" | "";
  unattended?: { enabled: boolean; allow: string[] } | "";
  /** 改绑归属项目（设计 §3.3.3）：只接受非空且真实存在的项目 id，不能改回 null。 */
  projectId?: string;
};

/** 项目根目录的名字（侧栏副行 / chip 用）。 */
export function projectRootName(root: string): string {
  const name = root.replace(/[/\\]+$/, "").split(/[/\\]/).pop();
  return name || root;
}
