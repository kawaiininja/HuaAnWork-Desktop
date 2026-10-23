import { useEffect, useState } from "react";
import { rpcCall } from "./api.ts";
import {
  filterPackageTab,
  isAgentPackageDetail,
  MINE_EMPTY_TEXT,
  mineCards,
  PACKAGE_SANDBOX_WARNING,
  packageSourceLabel,
  packageToolsLabel,
  SEARCH_EMPTY_TEXT,
  updateHintFor,
  type AgentPackageCard,
} from "./logic/agentPackagesLogic.ts";
import type {
  AgentPackageDetailResult,
  AgentPackageListResult,
} from "./rpc-types.ts";

/**
 * 「我的智能体」页签（Task 8）：本地包 + 已启用的旧目录智能体。
 * 数据来自 `agent.packageList`；无发布/下载/移除动作（M2 面不在此页）。
 */
export default function AgentPackagesPanel({
  search,
  refreshToken,
}: {
  search: string;
  refreshToken: number;
}) {
  const [data, setData] = useState<AgentPackageListResult | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busySlug, setBusySlug] = useState("");
  const [detailSlug, setDetailSlug] = useState("");
  /** 本面板动作后的重拉计数；`refreshToken` 来自外壳刷新与 App 的 `agent/changed`。 */
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await rpcCall<AgentPackageListResult>("agent.packageList");
        if (!active) return;
        setData({
          packages: Array.isArray(res.packages) ? res.packages : [],
          catalogAgents: Array.isArray(res.catalogAgents) ? res.catalogAgents : [],
          ...(res.catalogError ? { catalogError: res.catalogError } : {}),
        });
        setError("");
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [refreshToken, reloadTick]);

  const toggle = async (card: AgentPackageCard) => {
    if (busySlug) return;
    setBusySlug(card.slug);
    setError("");
    setNote("");
    try {
      await rpcCall("agent.packageSetEnabled", { slug: card.slug, enabled: !card.enabled });
      setNote(card.enabled ? `已关闭「${card.displayName}」` : `已启用「${card.displayName}」`);
      setReloadTick((prev) => prev + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusySlug("");
    }
  };

  const cards = data ? filterPackageTab(mineCards(data), search) : [];

  return (
    <div className="agent-packages-panel">
      {note ? <p className="hint" style={{ marginBottom: 12 }}>{note}</p> : null}
      {error ? <p className="banner error" style={{ marginBottom: 12 }}>{error}</p> : null}
      {data?.catalogError ? (
        <div className="banner warn" style={{ marginBottom: 12 }}>
          {data.catalogError}
        </div>
      ) : null}

      {loading && !data ? (
        <p className="panel-empty">加载中…</p>
      ) : cards.length === 0 ? (
        <p className="panel-empty">{search.trim() ? SEARCH_EMPTY_TEXT : MINE_EMPTY_TEXT}</p>
      ) : (
        <div className="skill-grid">
          {cards.map((card) => (
            <div key={`${card.source}:${card.slug}`} className="skill-card">
              <div className="top">
                <span className="av">{card.displayName.slice(0, 1).toUpperCase()}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="nm">{card.displayName}</div>
                  <div className="agent-card-badges">
                    <span className="badge">{packageSourceLabel(card.source)}</span>
                    <span className="badge">v{card.version}</span>
                    <span className="badge">@{card.slug}</span>
                  </div>
                </div>
              </div>
              {card.broken ? (
                <div className="banner warn" style={{ margin: "6px 0", fontSize: 12 }}>
                  已损坏：{card.broken.reason}
                </div>
              ) : null}
              <p>{card.description || "（无描述）"}</p>
              {card.source === "local" ? (
                <p className="hint agent-update-hint">{updateHintFor(card.slug)}</p>
              ) : null}
              <div className="page-tools" style={{ marginTop: 8, marginBottom: 0 }}>
                <button type="button" className="filter-tab" onClick={() => setDetailSlug(card.slug)}>
                  查看详情
                </button>
                <span className="composer-spacer" />
                <button
                  type="button"
                  className={card.enabled ? "filter-tab on" : "filter-tab"}
                  disabled={busySlug === card.slug || card.broken !== undefined}
                  onClick={() => void toggle(card)}
                >
                  {card.enabled ? "关闭" : "启用"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {detailSlug ? (
        <AgentPackageDetailDialog slug={detailSlug} onClose={() => setDetailSlug("")} />
      ) : null}
    </div>
  );
}

/**
 * 包/旧目录智能体的详情弹层：`agent.packageDetail` 返回两侧载荷，按 `slug` 收窄。
 * 底部固定展示本机沙箱提示（两种详情相同）。
 */
export function AgentPackageDetailDialog({
  slug,
  onClose,
}: {
  slug: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<AgentPackageDetailResult | undefined>(undefined);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await rpcCall<AgentPackageDetailResult>("agent.packageDetail", { slug });
        if (!active) return;
        setDetail(res);
        setError("");
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [slug]);

  const packageDetail = detail !== undefined && isAgentPackageDetail(detail) ? detail : undefined;
  const legacyDetail = detail !== undefined && !isAgentPackageDetail(detail) ? detail : undefined;
  const title = packageDetail?.displayName ?? legacyDetail?.displayName ?? legacyDetail?.name ?? slug;

  return (
    <div className="settings-overlay" role="dialog" aria-label={`智能体详情：${title}`}>
      <div className="confirm-modal automation-form">
        <h3>{title}</h3>
        {error ? <p className="banner error">{error}</p> : null}
        {detail === undefined && !error ? <p className="hint">加载中…</p> : null}

        {packageDetail ? (
          <>
            <div className="agent-card-badges">
              <span className="badge">{packageSourceLabel(packageDetail.source)}</span>
              <span className="badge">v{packageDetail.version}</span>
              <span className="badge">@{packageDetail.slug}</span>
            </div>
            <p className="hint">{packageDetail.description || "（无描述）"}</p>
            <section className="agent-detail-section">
              <strong>人设</strong>
              <pre>{packageDetail.persona}</pre>
            </section>
            <section className="agent-detail-section">
              <strong>技能</strong>
              <p>{packageDetail.skill?.summary || "无"}</p>
            </section>
            <section className="agent-detail-section">
              <strong>工具</strong>
              <p>{packageToolsLabel(packageDetail.tools)}</p>
            </section>
            <section className="agent-detail-section">
              <strong>文件</strong>
              <ul>
                {packageDetail.files.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>（{file.size} 字节）
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : null}

        {legacyDetail ? (
          <>
            <div className="agent-card-badges">
              <span className="badge">旧目录智能体</span>
              <span className="badge">v{legacyDetail.version}</span>
              <span className="badge">@{legacyDetail.name}</span>
            </div>
            <p className="hint">{legacyDetail.description || "（无描述）"}</p>
            {legacyDetail.persona ? (
              <section className="agent-detail-section">
                <strong>人设</strong>
                <pre>{legacyDetail.persona}</pre>
              </section>
            ) : null}
            {legacyDetail.entrypoint ? (
              <section className="agent-detail-section">
                <strong>入口</strong>
                <p>
                  {legacyDetail.entrypoint.kind.toUpperCase()} {legacyDetail.entrypoint.url}
                </p>
              </section>
            ) : null}
          </>
        ) : null}

        <p className="banner warn" style={{ margin: 0 }}>
          {PACKAGE_SANDBOX_WARNING}
        </p>
        <div className="page-tools" style={{ margin: "10px 0 0" }}>
          <span className="composer-spacer" />
          <button type="button" className="filter-tab" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
