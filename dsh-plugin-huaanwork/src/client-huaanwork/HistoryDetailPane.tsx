import { useState } from "react";
import { ThinkingPanel } from "./ThinkingPanel.tsx";

/** 会话日志详情记录（与 sidecar session-view 的 detailRecords 对齐）。 */
export type SessionDetailRecord =
  | { kind: "user"; time: number; text: string }
  | { kind: "thinking"; time: number; text: string }
  | { kind: "assistant"; time: number; text: string }
  | { kind: "tool-call"; time: number; name: string; callId?: string; args?: string; command?: string }
  | { kind: "tool-result"; time: number; callId?: string; isError: boolean; text: string };

/** 历史会话详情视图模型：session.open 的 log/records/summary 组装结果。 */
export type SessionLogView = {
  sessionId: string;
  title: string;
  log: string;
  records: SessionDetailRecord[];
  createdAt?: number;
  lastTime?: number;
  cwd?: string;
  messageCount?: number;
  turnCount?: number;
  error?: string;
};

/** 历史条目时间格式化（今天/昨天/M月D日 HH:mm），App 的会话列表副行也复用。 */
export function formatSessionTime(ts: number): string {
  const date = new Date(ts);
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
}

type Props = {
  view: SessionLogView;
  busy: boolean;
  onResume: () => void;
  onClose: () => void;
  /**
   * 是否展示「继续此会话」（session.resume 恢复到主对话流）。
   * 运行记录等只读场景（如自动化运行会话）传 false。缺省 true，保持既有行为。
   */
  canResume?: boolean;
};

/** 历史会话详情（主区域内嵌）：完整上下文 + 原始日志切换 + 继续会话。 */
export default function HistoryDetailPane({ view, busy, onResume, onClose, canResume = true }: Props) {
  const [showRaw, setShowRaw] = useState(false);
  const metaParts = sessionDetailMeta(view);
  return (
    <div className="history-pane">
      <header className="pane-header">
        <h2 className="session-detail-title" title={view.sessionId}>
          {view.title}
        </h2>
        <div className="row">
          {canResume && !view.error ? (
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              title="恢复该会话的完整上下文，在原会话上继续对话"
              onClick={onResume}
            >
              {busy ? "恢复中…" : "继续此会话"}
            </button>
          ) : null}
          <button type="button" onClick={() => setShowRaw((prev) => !prev)}>
            {showRaw ? "会话详情" : "原始日志"}
          </button>
          <button type="button" onClick={onClose}>
            返回
          </button>
        </div>
      </header>
      {metaParts.length > 0 ? (
        <p className="detail-meta">
          {metaParts.map((part) => (
            <span key={part}>{part}</span>
          ))}
        </p>
      ) : null}
      {view.error ? (
        <p className="banner error" style={{ borderRadius: 8 }}>
          {view.error}
        </p>
      ) : null}
      {showRaw ? (
        <pre className="session-log">{view.log || "（空会话日志）"}</pre>
      ) : view.error ? null : view.records.length === 0 ? (
        <p className="panel-empty">该会话暂无消息记录。</p>
      ) : (
        <div className="session-detail">
          {view.records.map((record) => (
            <SessionDetailRow key={recordKeyOf(record)} record={record} />
          ))}
        </div>
      )}
    </div>
  );
}

function sessionDetailMeta(view: SessionLogView): string[] {
  const parts: string[] = [];
  const start = typeof view.createdAt === "number" ? formatSessionTime(view.createdAt) : "";
  const end = typeof view.lastTime === "number" ? formatSessionTime(view.lastTime) : "";
  if (start && end && start !== end) parts.push(`${start} – ${end}`);
  else if (start || end) parts.push(start || end);
  if (view.cwd) parts.push(view.cwd);
  if (typeof view.messageCount === "number") parts.push(`${view.messageCount} 条消息`);
  if (typeof view.turnCount === "number") parts.push(`${view.turnCount} 轮`);
  parts.push(`ID ${view.sessionId}`);
  return parts;
}

function recordKeyOf(record: SessionDetailRecord): string {
  const callId = "callId" in record && typeof record.callId === "string" ? record.callId : "";
  const size = record.kind === "tool-call" ? (record.args?.length ?? 0) : record.text.length;
  return `${record.kind}:${record.time}:${callId}:${size}`;
}

function SessionDetailRow({ record }: { record: SessionDetailRecord }) {
  if (record.kind === "user") {
    return (
      <div className="detail-row detail-user">
        <span className="detail-role">你</span>
        <div className="detail-bubble">{record.text}</div>
      </div>
    );
  }
  if (record.kind === "assistant") {
    return (
      <div className="detail-row detail-assistant">
        <span className="detail-role">助手</span>
        <div className="detail-body">{record.text}</div>
      </div>
    );
  }
  if (record.kind === "thinking") {
    return <ThinkingPanel thought={record.text} hasAssistantText={true} interrupted={false} historical />;
  }
  if (record.kind === "tool-call") {
    return (
      <div className="detail-tool" title={record.callId}>
        <span className="detail-tool-mark">▸</span>
        <span className="detail-tool-name">{record.name || "tool"}</span>
        {record.command ? (
          <code className="detail-tool-args">{record.command}</code>
        ) : record.args ? (
          <code className="detail-tool-args">{record.args}</code>
        ) : null}
      </div>
    );
  }
  return (
    <details className="detail-result">
      <summary className={record.isError ? "err" : ""}>
        {record.isError ? "✗" : "✓"} 工具结果{record.callId ? ` · ${record.callId}` : ""}
      </summary>
      {record.text ? (
        <pre>{record.text}</pre>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          （无输出）
        </p>
      )}
    </details>
  );
}
