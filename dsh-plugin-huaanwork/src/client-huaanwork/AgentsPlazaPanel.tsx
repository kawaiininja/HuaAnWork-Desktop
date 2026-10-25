import { useEffect, useRef, useState } from "react";
import { rpcCall } from "./api.ts";
import { AgentPackageCardView, AgentPackageDetailDialog } from "./AgentPackagesPanel.tsx";
import { EnableConfirmModal } from "./AgentToolkitPanel.tsx";
import {
  catalogErrorMessage,
  filterPackageTab,
  PLAZA_EMPTY_TEXT,
  plazaCards,
  SEARCH_EMPTY_TEXT,
  type AgentPackageCard,
  type PackageNotice,
} from "./logic/agentPackagesLogic.ts";
import type { AgentListItem, AgentPackageListResult } from "./rpc-types.ts";

/**
 * 「智能体广场」页签（Task 8 / M2 Task 12）。
 *
 * 两张来源合并展示：
 * - 签名广场摘要（`catalogPackages`）：本机未安装，动作严格只有下载与详情；
 *   已安装的 slug 由 `plazaCards` 剔除，不会以“下载”卡重复出现；
 * - legacy 目录条目（`catalogAgents`）：沿用启用/关闭（启用先经能力披露确认框）
 *   与查看详情，不伪造下载入口。
 *
 * 未安装签名卡的详情只读摘要（不调用 `agent.packageDetail`），并明示签名与文件
 * 清单需安装后查看。同 slug 或签名包 `migrationFrom` 覆盖的 legacy 条目只显示签名卡
 * （标“签名迁移包”）。公用机目录不可达时，本地包仍可在「我的智能体」查看——两页
 * 取数互不阻塞。
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
  /** 列表拉取失败单独存放：动作成功后的重拉不能把动作提示清掉。 */
  const [loadError, setLoadError] = useState("");
  const [warning, setWarning] = useState("");
  const [note, setNote] = useState("");
  const [busySlugs, setBusySlugs] = useState<string[]>([]);
  /** 当前打开详情的卡片；未安装签名卡只读摘要，不带磁盘详情。 */
  const [detailCard, setDetailCard] = useState<AgentPackageCard>();
  /** 待确认启用的目录条目；确认框负责披露能力并发出 `agent.setEnabled`。 */
  const [confirmItem, setConfirmItem] = useState<AgentListItem>();
  /** 本面板动作后的重拉计数；`refreshToken` 来自外壳刷新与 App 的 `agent/changed`。 */
  const [reloadTick, setReloadTick] = useState(0);
  const busyRef = useRef<Set<string>>(new Set());

  const begin = (slug: string): boolean => {
    if (busyRef.current.has(slug)) return false;
    busyRef.current.add(slug);
    setBusySlugs([...busyRef.current]);
    return true;
  };

  const end = (slug: string) => {
    busyRef.current.delete(slug);
    setBusySlugs([...busyRef.current]);
  };

  const showNotice = (notice: PackageNotice) => {
    setNote("");
    setWarning("");
    setError("");
    if (notice.tone === "note") setNote(notice.text);
    else if (notice.tone === "warn") setWarning(notice.text);
    else setError(notice.text);
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await rpcCall<AgentPackageListResult>("agent.packageList");
        if (!active) return;
        setData({
          packages: Array.isArray(res.packages) ? res.packages : [],
          catalogAgents: Array.isArray(res.catalogAgents) ? res.catalogAgents : [],
          catalogPackages: Array.isArray(res.catalogPackages) ? res.catalogPackages : [],
          ...(res.catalogError ? { catalogError: res.catalogError } : {}),
          ...(res.revocationWarning ? { revocationWarning: res.revocationWarning } : {}),
        });
        setLoadError("");
      } catch (cause) {
        if (active) setLoadError(catalogErrorMessage(cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [refreshToken, reloadTick]);

  const reload = () => setReloadTick((prev) => prev + 1);

  const disable = async (card: AgentPackageCard) => {
    if (!begin(card.slug)) return;
    setError("");
    setWarning("");
    setNote("");
    try {
      await rpcCall("agent.setEnabled", { name: card.slug, enabled: false });
      setNote(`已关闭「${card.displayName}」`);
      reload();
    } catch (cause) {
      setError(catalogErrorMessage(cause));
    } finally {
      end(card.slug);
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
    setWarning("");
    setNote("");
    setConfirmItem(item);
  };

  const toggle = (card: AgentPackageCard) => {
    if (card.enabled) void disable(card);
    else requestEnable(card);
  };

  const allCards = data ? plazaCards(data) : [];
  const cards = filterPackageTab(allCards, search);

  return (
    <div className="agent-plaza-panel">
      {note ? <p className="hint" style={{ marginBottom: 12 }}>{note}</p> : null}
      {error ? <p className="banner error" style={{ marginBottom: 12 }}>{error}</p> : null}
      {loadError ? <p className="banner error" style={{ marginBottom: 12 }}>{loadError}</p> : null}
      {warning ? (
        <p className="banner warn" style={{ marginBottom: 12 }}>
          {warning}
        </p>
      ) : null}
      {data?.catalogError ? (
        <div className="banner warn" style={{ marginBottom: 12 }}>
          {data.catalogError}
        </div>
      ) : null}
      {data?.revocationWarning ? (
        <div className="banner warn" style={{ marginBottom: 12 }}>
          {data.revocationWarning}
        </div>
      ) : null}

      {loading && !data ? (
        <p className="panel-empty">加载中…</p>
      ) : cards.length === 0 ? (
        <p className="panel-empty">{search.trim() ? SEARCH_EMPTY_TEXT : PLAZA_EMPTY_TEXT}</p>
      ) : (
        <div className="skill-grid">
          {cards.map((card) => (
            <AgentPackageCardView
              key={`plaza:${card.source}:${card.slug}`}
              card={card}
              busy={busySlugs.includes(card.slug)}
              begin={begin}
              end={end}
              onToggle={toggle}
              onDetail={setDetailCard}
              onReload={reload}
              onNotice={showNotice}
              {...(card.source === "catalog-legacy" ? { sourceBadge: "公用机" } : {})}
            />
          ))}
        </div>
      )}

      {detailCard ? (
        <AgentPackageDetailDialog
          slug={detailCard.slug}
          summary={detailCard}
          onClose={() => setDetailCard(undefined)}
        />
      ) : null}

      {confirmItem ? (
        <EnableConfirmModal
          item={confirmItem}
          onClose={() => setConfirmItem(undefined)}
          onConfirmed={async () => {
            setConfirmItem(undefined);
            setNote(`已启用「${confirmItem.displayName ?? confirmItem.name}」`);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}
