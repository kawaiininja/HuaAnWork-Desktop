export type RpcRequest = {
  id: number;
  method:
    | "workspace.open"
    | "workspace.close"
    | "session.send"
    | "session.cancel"
    | "session.approve"
    | "session.reject"
    | "session.exitPlanMode"
    | "session.answerInput"
    | "session.list"
    | "session.open"
    | "session.remove"
    | "session.new"
    | "session.resume"
    | "settings.get"
    | "settings.set"
    | "auth.status"
    | "auth.register"
    | "auth.login"
    | "auth.logout"
    | "auth.changePassword"
    | "plugin.add"
    | "plugin.remove"
    | "plugin.list"
    | "skill.list"
    | "skill.get"
    | "skill.create"
    | "skill.update"
    | "skill.remove"
    | "skill.importPreview"
    | "skill.import"
    | "skill.setEnabled"
    | "agent.list"
    | "agent.get"
    | "agent.refresh"
    | "agent.setEnabled"
    | "agent.addEndpoint"
    | "agent.removeEndpoint"
    | "status.get"
    | "project.list"
    | "project.create"
    | "project.open"
    | "project.remove"
    | "project.rename"
    | "automation.list"
    | "automation.create"
    | "automation.update"
    | "automation.remove"
    | "automation.run"
    | "automation.runs"
    | "automation.pruneSessions"
    | "automation.templates"
    | "task.list"
    | "task.create"
    | "task.remove"
    | "task.bindSession"
    | "task.rename";
  params?: unknown;
};

export type SkillSource = "bundled" | "user" | "external";

export type SkillInfo = { name: string; description: string; source: SkillSource; whenToUse?: string; enabled?: boolean };

export type SkillDetail = SkillInfo & {
  content: string;
  /** invocation 策略（供查看/编辑回填；缺省 = dsh 默认：模型可调用、用户可调用）。 */
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
};

export type SkillFieldError = { field: string; message: string };

/** 技能写操作结果：校验失败走 result payload（非 RPC error），前端据 field 做模态内回显。 */
export type SkillWriteResult = { ok: true; skill: SkillInfo } | { ok: false; fieldErrors: SkillFieldError[] };

export type SkillImportPreview =
  | { ok: true; preview: SkillDetail & { targetName: string; sourceName: string; nameMismatch: boolean; kind: "file" | "directory" } }
  | { ok: false; fieldErrors: SkillFieldError[] };

export type AgentSource = "catalog" | "local";
export type AgentKind = "tool" | "agent";
export type EntrypointKind = "http" | "mcp";

export type AgentListItem = {
  name: string;
  source: AgentSource;
  kind: AgentKind;
  entrypointKind?: EntrypointKind;
  description: string;
  whenToUse?: string;
  version: string;
  permissions: string[];
  enabled: boolean;
  broken?: { reason: string };
};

export type AgentListResult = {
  items: AgentListItem[];
  catalogError?: string;
};

export type AgentDetail = AgentListItem & {
  persona?: string;
  entrypoint?: { kind: EntrypointKind; url: string };
  allow?: string[];
  timeoutMs?: number;
  argumentsSchema?: unknown;
};

export type AgentFieldError = { field: string; message: string };
export type AgentWriteResult = { ok: true } | { ok: false; fieldErrors: AgentFieldError[] };
export type SettingsFieldError = { field: string; message: string };

/** 项目：隔离的工作空间（文件目录 + 对话历史 + 自动化配置 + Widget 看板）。 */
export type ProjectInfo = {
  id: string;
  name: string;
  root: string;
  createdAt: number;
  lastOpenedAt?: number;
};

/** 任务触发计划：8 种 kind；旧记录只有 manual/interval/daily 三种，读出走默认值语义、零迁移。 */
export type AutomationSchedule =
  | { kind: "manual" }
  | { kind: "once"; at: number }                        // epoch ms，触发后自动 enabled=false
  | { kind: "interval"; minutes: number }
  | { kind: "hourly"; minute: number }                  // 0-59
  | { kind: "daily"; time: string }                     // HH:MM，保留兼容
  | { kind: "weekly"; days: number[]; time: string }    // 0-6，0=周日，7 归一化为 0
  | { kind: "monthly"; dates: number[]; time: string }  // 1-31，当月无此日则跳过该月
  | { kind: "cron"; expr: string };                     // 标准 5 字段

/**
 * 任务：挂在项目下的自动化工作流。
 * - `agent`：本地模型会话（agent local_conversation），产出为最后回复；
 * - `script`：在项目目录执行命令，产出为 stdout。
 * `widget` 为 true 时产出推送到项目看板。
 *
 * Phase 1 追加字段全部可选，旧记录读出来即默认值（missedPolicy 默认 "skip"、
 * taskShape 默认 "independent"），不需要迁移脚本；
 * `isAutomationInfo` 的宽松校验是这条保证的唯一依据，不要改严。
 *
 * issue #2：`projectId` 可为 `null`（中立归属，不绑定任何项目）；旧记录均为
 * string，向前兼容。归属在创建后不可改（update 白名单不含 projectId）。
 */
export type AutomationInfo = {
  id: string;
  projectId: string | null;
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

/** 内置任务模板（Task 12）：sidecar 从 `templates/automations.json` 读取，`automation.templates` RPC 返回；创建表单用它预填字段，选中不直接创建。 */
export type AutomationTemplate = {
  name: string;
  kind: "agent" | "script";
  schedule: AutomationSchedule;
  prompt?: string;
  command?: string;
};

/** 一次任务运行的记录（产出截断后存储）。 */
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

/** 子任务：挂在项目下的普通任务（区别于自动化任务，无调度与运行历史）。 */
export type TaskInfo = {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  /** 该子任务绑定的唯一会话；未发生首条消息时不存在（旧 tasks.json 无此字段，天然兼容）。 */
  sessionId?: string;
};

/** `session.list` 行：会话日志的摘要投影（标题、时间、统计）。 */
export type SessionSummary = {
  id: string;
  title: string;
  createdAt: number;
  lastTime: number;
  cwd?: string;
  origin?: string;
  parentSession?: string;
  messageCount: number;
  turnCount: number;
};

/** `session.open` 返回的可读会话记录，按日志顺序排列。 */
export type SessionDetailRecord =
  | { kind: "user"; time: number; text: string }
  | { kind: "thinking"; time: number; text: string }
  | { kind: "assistant"; time: number; text: string }
  | { kind: "tool-call"; time: number; name: string; callId?: string; args?: string; command?: string }
  | { kind: "tool-result"; time: number; callId?: string; isError: boolean; text: string };

/** 事件归属会话：token/tool/diff/session 事件携带发起回合的会话 id，前端与收集器据此归因。 */
export type RpcEvent =
  | { event: "token"; text: string; sessionId?: string }
  | { event: "reasoning"; text: string; sessionId?: string; final?: true }
  | {
      event: "tool/start";
      name: string;
      callId?: string;
      sessionId?: string;
      /** bash / pwsh 调用的 command 参数,供回合结束核对「要求的命令」。 */
      command?: string;
      /** todo_write 的完整替换列表。 */
      todos?: { content: string; status: "pending" | "in_progress" | "completed" }[];
    }
  | { event: "tool/end"; name: string; callId?: string; truncated?: boolean; sessionId?: string; isError?: true }
  | {
      event: "approval/asked";
      approvalRequestId: string;
      toolName: string;
      callId?: string;
      reason?: string;
      summary?: string;
      sessionId?: string;
      /** plan-review 已由回答者按当前护栏提交同意，卡片不再等待点击。 */
      autoContinue?: boolean;
    }
  /** `request_input` 在等对话卡片的回答；回答或取消走 `session.answerInput`。 */
  | { event: "input/asked"; question: string; sessionId: string }
  | { event: "diff"; text: string; sessionId?: string }
  | { event: "compaction/done"; sessionId?: string }
  | { event: "goal/round"; round: number; sessionId?: string }
  | { event: "goal/round-limit"; round: number; sessionId?: string }
  | { event: "session/end"; ok: boolean; error?: string; cancelled?: boolean; sessionId?: string }
  | { event: "sidecar/status"; ready: boolean }
  | { event: "automation/run-start"; automationId: string; runId: string; projectId: string | null; sessionId?: string; trigger?: "manual" | "schedule" | "catchup" }
  | {
      event: "automation/run-end";
      automationId: string;
      runId: string;
      projectId: string | null;
      ok: boolean;
      status?: "ok" | "error" | "missed" | "timeout" | "cancelled";
      sessionId?: string;
      durationMs?: number;
    }
  | { event: "automation/missed"; automationId: string; projectId: string | null; coalescedCount: number; missedAt: number }
  | { event: "automation/widget"; automationId: string; projectId: string | null; time: number };
