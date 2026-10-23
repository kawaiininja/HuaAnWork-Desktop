import { useEffect, useState } from "react";
import { rpcCall } from "./api.ts";
import { AgentPackageDetailDialog } from "./AgentPackagesPanel.tsx";
import {
  filterPackageTab,
  PLAZA_EMPTY_TEXT,
  plazaCards,
  SEARCH_EMPTY_TEXT,
  type AgentPackageCard,
} from "./logic/agentPackagesLogic.ts";
import type { AgentPackageListResult } from "./rpc-types.ts";

/**
 * 「智能体广场」页签（Task 8）：只读公用机目录里的智能体（`kind === 'agent'`）。
 * 动作只有查看详情与启用/关闭（`agent.setEnabled`）；工具条目不在本页签。
 * 公用机目录不可达时，本地包仍可在「我的智能体」查看——两页取数互不阻塞。
 */
export default function AgentsPlazaPanel({
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
  const [busyName, setBusyName] = useState("");
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
    if (busyName) return;
    setBusyName(card.slug);
    setError("");
    setNote("");
    try {
      await rpcCall("agent.setEnabled", {
        name: card.slug,
        enabled: !card.enabled,
        ...(card.enabled ? {} : { confirmPermissions: true }),
      });
      setNote(card.enabled ? `已关闭「${card.displayName}」` : `已启用「${card.displayName}」`);
      setReloadTick((prev) => prev + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyName("");
    }
  };

  const allCards = data ? plazaCards(data) : [];
  const cards = filterPackageTab(allCards, search);

  return (
    <div className="agent-plaza-panel">
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
        <p className="panel-empty">{search.trim() ? SEARCH_EMPTY_TEXT : PLAZA_EMPTY_TEXT}</p>
      ) : (
        <div className="skill-grid">
          {cards.map((card) => (
            <div key={`plaza:${card.slug}`} className="skill-card">
              <div className="top">
                <span className="av">{card.displayName.slice(0, 1).toUpperCase()}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="nm">{card.displayName}</div>
                  <div className="agent-card-badges">
                    <span className="badge">公用机</span>
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
              <div className="page-tools" style={{ marginTop: 8, marginBottom: 0 }}>
                <button type="button" className="filter-tab" onClick={() => setDetailSlug(card.slug)}>
                  查看详情
                </button>
                <span className="composer-spacer" />
                <button
                  type="button"
                  className={card.enabled ? "filter-tab on" : "filter-tab"}
                  disabled={busyName === card.slug || card.broken !== undefined}
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
