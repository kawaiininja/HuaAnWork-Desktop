/**
 * 自动化运行会话 id 前缀。
 * 客户端与宿主进程隔离, 保持独立声明; 值与 src/huaanwork-host/automation-session-ids.ts 保持同步。
 */
export const AUTO_SESSION_PREFIX = "huaanwork-auto-";
/**
 * 旧 chat 通道自动化运行会话前缀（与 src/huaanwork-host/automation-session-ids.ts 的 LEGACY_CHAT_AUTO_SESSION_PREFIX 保持同步）。
 * sidecar 启动时一次性清扫删除该前缀目录，这里仅过滤清扫失败（如 Windows 文件占用）的残留。
 */
export const LEGACY_CHAT_AUTO_SESSION_PREFIX = "huaanwork-chat-auto-";

/**
 * 自动化运行会话不进侧栏常规会话列表——它们由「任务」区运行 tab 与「自动化」页「运行记录」展示。
 * 同时识别旧 chat 通道运行前缀（huaanwork-chat-auto-）：正常已被 sidecar 启动清扫删除，
 * 匹配它只为兜住清扫失败的残留目录，避免以幽灵历史条目混入「任务」区/项目卡。
 */
export function isAutomationSessionId(id: string | undefined): boolean {
  return (
    typeof id === "string" &&
    (id.startsWith(AUTO_SESSION_PREFIX) || id.startsWith(LEGACY_CHAT_AUTO_SESSION_PREFIX))
  );
}

/**
 * 会话是否有真实对话内容：消息数 / 轮次数均大于 0 才算数。
 * 项目打开时会自动铸造稳定会话（只写初始化事件的空壳），它们不属于历史条目，
 * 若不过滤会以「未命名」条目污染「最近对话」/「历史记录」列表。
 */
export function sessionHasContent(session: { messageCount?: number; turnCount?: number }): boolean {
  return (
    (typeof session.messageCount === "number" && session.messageCount > 0) ||
    (typeof session.turnCount === "number" && session.turnCount > 0)
  );
}

/**
 * cwd 是否落在 root 目录内（含等于）。跨平台：统一分隔符并去尾部斜杠后做前缀比较，
 * 与 sidecar host.ts 的 sessionWithinRoot 语义一致（项目隔离的展示分组依据）。
 */
export function cwdWithinRoot(cwd: string | undefined, root: string | undefined): boolean {
  if (!cwd || !root) return false;
  const normalize = (p: string) => {
    const flat = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return flat || "/";
  };
  const dir = normalize(cwd);
  const base = normalize(root);
  return dir === base || dir.startsWith(`${base}/`);
}

type SessionLike = { id?: string; cwd?: string; messageCount?: number; turnCount?: number };
type ProjectLike = { id: string; root: string };

/**
 * 未归属任何项目的会话（中立工作区的游离对话）：cwd 不落在任何已登记项目根内。
 * 项目分组已退役（规格 §4.1）——项目会话全部收编进子任务，项目卡不再列 cwd 会话。
 * 自动化运行会话与空壳会话在此剔除，返回值可直接渲染。
 */
export function unscopedSessions<S extends SessionLike, P extends ProjectLike>(
  sessions: readonly S[],
  projects: readonly P[],
): S[] {
  return sessions.filter(
    (session) =>
      sessionHasContent(session) &&
      !isAutomationSessionId(session.id) &&
      !projects.some((project) => cwdWithinRoot(session.cwd, project.root)),
  );
}

type TitleItem = { kind: string; text?: string };

/** 对话列表标题：首条用户消息，否则回退标签名。 */
export function chatTabTitle(tab: { label: string; items: readonly TitleItem[] }): string {
  const first = tab.items.find((item) => item.kind === "user" && typeof item.text === "string" && item.text.trim());
  if (first && typeof first.text === "string") return first.text.replace(/\s+/g, " ").trim().slice(0, 80);
  return tab.label;
}

export function chatTabHasConversation(tab: { items: readonly TitleItem[] }): boolean {
  return tab.items.some((item) => item.kind === "user" || item.kind === "assistant");
}

/** 会话日志详情记录（与 sidecar session-view 的 detailRecords 对齐）。 */
export type HistoryRecord =
  | { kind: "user"; time: number; text: string }
  | { kind: "assistant"; time: number; text: string }
  | { kind: "tool-call"; time: number; name: string; callId?: string; args?: string }
  | { kind: "tool-result"; time: number; callId?: string; isError: boolean; text: string };

/** 历史记录映射后的对话流条目（App 侧再包一层 id 成为 ChatItem）。 */
export type HistoryChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; callId?: string }
  | { kind: "note"; text: string };

/**
 * 历史会话记录 → 对话流条目：user/assistant 按原文还原，tool-call 成工具卡（已完成态），
 * 失败的 tool-result 折叠为一条提示（成功的结果不重复占位）。
 */
export function historyItemsFromRecords(records: readonly HistoryRecord[]): HistoryChatItem[] {
  const items: HistoryChatItem[] = [];
  for (const record of records) {
    if (record.kind === "user") {
      items.push({ kind: "user", text: record.text });
    } else if (record.kind === "assistant") {
      items.push({ kind: "assistant", text: record.text });
    } else if (record.kind === "tool-call") {
      items.push({
        kind: "tool",
        name: record.name || "tool",
        ...(record.callId ? { callId: record.callId } : {}),
      });
    } else if (record.isError) {
      const text = record.text.replace(/\s+/g, " ").trim().slice(0, 200);
      items.push({ kind: "note", text: `工具调用失败：${text || "未知错误"}` });
    }
  }
  return items;
}
