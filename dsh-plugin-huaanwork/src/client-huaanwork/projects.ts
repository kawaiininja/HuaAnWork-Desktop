import { rpcCall } from "./api.ts";
import { describeScheduleText } from "./logic/scheduleText.ts";

import type {
  AutomationDraft,
  AutomationInfo,
  AutomationPatch,
  AutomationSchedule,
  AutomationTemplate,
  ProjectInfo,
  RunSummary,
  TaskInfo,
} from "./logic/projects.ts";

export type * from "./logic/projects.ts";
export { projectRootName } from "./logic/projects.ts";

export function listProjects(): Promise<{ projects: ProjectInfo[] }> {
  return rpcCall("project.list");
}

export function createProject(params: { root: string; name?: string }): Promise<{ project: ProjectInfo }> {
  return rpcCall("project.create", params);
}

/**
 * 打开项目:应答恒带 workspaceRoot(评审 D1)——同根短路是项目当前根;确认重启
 * 也是项目根(重启后组合期即切到它,客户端可立即对齐 UI)。restarting 为 true 时
 * 应用随即 relaunch。用户在重启确认框取消时服务端回 400 restart-cancelled。
 */
export function openProject(projectId: string): Promise<{ workspaceRoot: string; project: ProjectInfo; restarting?: true }> {
  return rpcCall("project.open", { projectId });
}

export function renameProject(projectId: string, name: string): Promise<{ project: ProjectInfo }> {
  return rpcCall("project.rename", { projectId, name });
}

export function removeProject(projectId: string): Promise<{ removed: boolean; project: ProjectInfo }> {
  return rpcCall("project.remove", { projectId });
}

export function listAutomations(projectId?: string): Promise<{
  automations: AutomationInfo[];
  runs: Record<string, RunSummary[]>;
  missed: Record<string, RunSummary[]>;
}> {
  return rpcCall("automation.list", projectId ? { projectId } : {});
}

export function createAutomation(draft: AutomationDraft): Promise<{ automation: AutomationInfo }> {
  return rpcCall("automation.create", draft);
}

/** 内置任务模板列表：创建表单的模板选择器用它预填字段，选中不直接创建。 */
export function listAutomationTemplates(): Promise<{ templates: AutomationTemplate[] }> {
  return rpcCall("automation.templates");
}

export function updateAutomation(id: string, patch: AutomationPatch): Promise<{ automation: AutomationInfo }> {
  return rpcCall("automation.update", { id, ...patch });
}

export function removeAutomation(id: string): Promise<{ removed: boolean }> {
  return rpcCall("automation.remove", { id });
}

export function runAutomation(id: string): Promise<{ queued: boolean; runId?: string }> {
  return rpcCall("automation.run", { id });
}

/** 运行记录查询：status 筛选 + limit 截断（保留最近的几条），供「运行记录」tab 全量翻查。 */
export function automationRuns(
  id: string,
  opts: { limit?: number; status?: RunSummary["status"] } = {},
): Promise<{ runs: RunSummary[] }> {
  return rpcCall("automation.runs", { id, ...opts });
}

/** 清理历史运行会话目录：保留每任务最近 50 条运行对应的会话（及正在运行的），返回删除目录数。 */
export function pruneAutomationSessions(): Promise<{ removed: number }> {
  return rpcCall("automation.pruneSessions");
}

export function listTasks(projectId?: string): Promise<{ tasks: TaskInfo[] }> {
  return rpcCall("task.list", projectId ? { projectId } : {});
}

export function createTask(params: { projectId: string; name: string }): Promise<{ task: TaskInfo }> {
  return rpcCall("task.create", params);
}

export function removeTask(id: string): Promise<{ removed: boolean }> {
  return rpcCall("task.remove", { id });
}

export function bindTaskSession(params: { taskId: string; sessionId: string }): Promise<{ task: TaskInfo }> {
  return rpcCall("task.bindSession", params);
}

export function renameTask(params: { taskId: string; name: string }): Promise<{ task: TaskInfo }> {
  return rpcCall("task.rename", params);
}

/** 触发方式的可读描述（任务行副标题用）。实现在 scheduleText.ts（纯函数，node 测试可直接加载）。 */
export function describeSchedule(schedule: AutomationSchedule): string {
  return describeScheduleText(schedule);
}
