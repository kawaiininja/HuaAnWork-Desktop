import { useEffect, useState } from "react";
import { rpcCall } from "./api.ts";
import { AgentPackageDetailDialog } from "./AgentPackagesPanel.tsx";
import { EnableConfirmModal } from "./AgentToolkitPanel.tsx";
import {
  filterPackageTab,
  PLAZA_EMPTY_TEXT,
  plazaCards,
  SEARCH_EMPTY_TEXT,
  type AgentPackageCard,
} from "./logic/agentPackagesLogic.ts";
import type { AgentListItem, AgentPackageListResult } from "./rpc-types.ts";

/**
 * 「智能体广场」页签（Task 8）：只读公用机目录里的智能体（`kind === 'agent'`）。
 * 动作只有查看详情与启用/关闭；启用先经 `EnableConfirmModal` 披露声明的能力，
 * 用户确认后才以 `confirmPermissions: true` 调用 `agent.setEnabled`，关闭直接生效。
 * 工具条目不在本页签。公用机目录不可达时，本地包仍可在「我的智能体」查看——两页取数互不阻塞。
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
  /** 待确认启用的目录条目；确认框负责披露能力并发出 `agent.setEnabled`。 */
  const [confirmItem, setConfirmItem] = useState<AgentListItem>();
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

  const disable = async (card: AgentPackageCard) => {
    if (busyName) return;
    setBusyName(card.slug);
    setError("");
    setNote("");
    try {
      await rpcCall("agent.setEnabled", { name: card.slug, enabled: false });
      setNote(`已关闭「${card.displayName}」`);
      setReloadTick((prev) => prev + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyName("");
    }
  };

  /** 启用先取回目录原条目（含 `permissions`），交给确认框披露后再发 RPC。 */
  const requestEnable = (card: AgentPackageCard) => {
    const item = data?.catalogAgents.find((entry) => entry.kind === "agent" && entry.name === card.slug);
    if (!item) {
      setError(`目录中已找不到「${card.displayName}」，请刷新后重试`);
      return;
    }
    setError("");
    setNote("");
    setConfirmItem(item);
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
                  onClick={() => (card.enabled ? void disable(card) : requestEnable(card))}
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

      {confirmItem ? (
        <EnableConfirmModal
          item={confirmItem}
          onClose={() => setConfirmItem(undefined)}
          onConfirmed={async () => {
            setConfirmItem(undefined);
            setNote(`已启用「${confirmItem.displayName ?? confirmItem.name}」`);
            setReloadTick((prev) => prev + 1);
          }}
        />
      ) : null}
    </div>
  );
}
