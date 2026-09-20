import { useState } from "react";

/** 知识条目：功能落地后的列表数据结构（预留）。 */
type KnowledgeEntry = {
  name: string;
  description?: string;
};

/** 知识库页（占位）：搜索与列表渲染结构已预留，暂无数据来源时显示「功能开发中」。 */
export default function KnowledgeBaseView() {
  const [query, setQuery] = useState("");
  // 功能开发中：暂无数据来源，接入后替换为本地知识条目列表。
  const entries: KnowledgeEntry[] = [];
  const normalized = query.trim().toLowerCase();
  const visible = normalized
    ? entries.filter((entry) => `${entry.name} ${entry.description ?? ""}`.toLowerCase().includes(normalized))
    : entries;

  return (
    <div className="page-view">
      <div className="page-head">
        <h1>知识库</h1>
        <span className="hint-text">沉淀项目知识与资料，供智能体检索引用（即将上线）</span>
      </div>
      <div className="page-tools">
        <input
          className="search-input"
          value={query}
          placeholder="🔍 搜索知识条目"
          aria-label="搜索知识条目"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {visible.length === 0 ? (
        <p className="panel-empty">功能开发中</p>
      ) : (
        // 预留：知识条目列表渲染（卡片或行列表）。
        <ul className="recent-list">
          {visible.map((entry) => (
            <li key={entry.name}>
              <div className="recent-item">
                <span className="recent-title">{entry.name}</span>
                {entry.description ? <span className="recent-meta">{entry.description}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
