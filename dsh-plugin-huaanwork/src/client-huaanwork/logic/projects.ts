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
  projectId: string | null;                      // null = 中立归属(issue #2),创建后不可改
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
};

/** 项目根目录的名字（侧栏副行 / chip 用）。 */
export function projectRootName(root: string): string {
  const name = root.replace(/[/\\]+$/, "").split(/[/\\]/).pop();
  return name || root;
}
