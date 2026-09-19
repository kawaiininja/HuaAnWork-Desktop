/** 懒创建子任务的命名：首条消息压空白后取前 20 字；空文本兜底「新子任务」。 */
export function subtaskNameFromMessage(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "新子任务";
  return compact.slice(0, 20);
}

/** pendingSubtask 派生的最小输入。hasConversation 由调用方用 chatTabHasConversation(tab) 计算。 */
export type PendingSubtaskProbe = {
  projectId: string | null;
  taskId?: string;
  pendingPick: boolean;
  hasConversation: boolean;
};

/**
 * pendingSubtask 派生判定（规格 §3.1）：已绑项目、未绑子任务、非待选项目、无既有对话。
 * 「无对话」以 items（hasConversation）为准而非 sessionId——selectSubtask 会对空子任务预铸
 * sessionId，若以 sessionId 判定会误伤该场景（评审 P2-4）。
 */
export function isPendingSubtask(tab: PendingSubtaskProbe): boolean {
  return tab.projectId != null && tab.taskId == null && !tab.pendingPick && !tab.hasConversation;
}

/**
 * 发送守卫两子态（规格 §2.5，计划评审 P2-1）：
 * 子态一 pendingSubtask → 建任务 + 铸会话 + 绑定；
 * 子态二 已绑 taskId 但任务尚无绑定会话（上次中途失败/预铸未绑）→ 复用任务，只铸会话 + 绑定。
 * boundTaskSessionId 由调用方以 projectTasks.find(t => t.id === tab.taskId)?.sessionId 传入。
 */
export function needsSubtaskOnSend(tab: PendingSubtaskProbe, boundTaskSessionId: string | undefined): boolean {
  if (tab.projectId == null) return false;
  return isPendingSubtask(tab) || (tab.taskId != null && !boundTaskSessionId);
}

/** 默认子任务名「子任务 N」判定：仅默认名的任务允许自动改名，用户手改过的名字绝不覆盖。 */
export function isDefaultSubtaskName(name: string): boolean {
  return /^子任务 \d+$/.test(name.trim());
}

/** 会话标题能否用作子任务名：非空且不是 session-view 的「未命名 · 日期」兜底标题。 */
export function usableSessionTitle(title: unknown): title is string {
  return typeof title === "string" && title.trim() !== "" && !title.trimStart().startsWith("未命名");
}

/** 自动改名候选：默认名 + 已绑会话 + 会话有可用标题；名字压空白截 20 字，与 subtaskNameFromMessage 对齐。 */
export type SubtaskRename = { taskId: string; name: string };

export function subtaskRenamesFromTitles(
  tasks: { id: string; name: string; sessionId?: string }[],
  sessions: { id?: string; title?: string }[],
): SubtaskRename[] {
  const titleById = new Map(sessions.map((session) => [session.id, session.title]));
  const renames: SubtaskRename[] = [];
  for (const task of tasks) {
    if (!task.sessionId || !isDefaultSubtaskName(task.name)) continue;
    const title = titleById.get(task.sessionId);
    if (usableSessionTitle(title)) {
      renames.push({ taskId: task.id, name: title.replace(/\s+/g, " ").trim().slice(0, 20) });
    }
  }
  return renames;
}
