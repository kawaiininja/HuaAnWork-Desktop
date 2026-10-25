import { useEffect, useRef, useState } from "react";
import { rpcCall } from "./api.ts";
import {
  catalogErrorMessage,
  DELIST_CONFIRM_TEXT,
  filterPackageTab,
  formatPackageSize,
  INSTALL_DETAIL_NOTICE,
  isAgentPackageDetail,
  LOCAL_UNSIGNED_LABEL,
  MIGRATION_PACKAGE_LABEL,
  MINE_EMPTY_TEXT,
  MISSING_SIGNATURE_LABEL,
  mineCards,
  PACKAGE_SANDBOX_WARNING,
  packageActionLabel,
  packageActions,
  packageDetailPublishStatus,
  packageSourceLabel,
  packageStatusLabel,
  packageStatusTone,
  packageToolsLabel,
  PUBLISH_CONFIRM_TEXT,
  publicationNotice,
  SEARCH_EMPTY_TEXT,
  updateHintFor,
  type AgentPackageAction,
  type AgentPackageCard,
  type PackageNotice,
} from "./logic/agentPackagesLogic.ts";
import type {
  AgentPackageDetailResult,
  AgentPackageListResult,
  AgentPackagePublishStatus,
} from "./rpc-types.ts";

/**
 * 「我的智能体」页签（Task 8 / M2 Task 12）：本地包 + 已安装的广场签名包 +
 * 已启用的旧目录智能体。
 *
 * 数据来自 `agent.packageList`；动作清单由 `packageActions` 决定。异步动作按
 * slug 记录在飞状态：只禁用该卡按钮，其他卡继续可点。
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
  /** 列表拉取失败单独存放：动作成功后的重拉不能把动作提示清掉。 */
  const [loadError, setLoadError] = useState("");
  const [warning, setWarning] = useState("");
  const [note, setNote] = useState("");
  const [busySlugs, setBusySlugs] = useState<string[]>([]);
  /** 当前打开详情的卡片；未安装签名卡只读摘要，不带磁盘详情。 */
  const [detailCard, setDetailCard] = useState<AgentPackageCard>();
  /** 本面板动作后的重拉计数；`refreshToken` 来自外壳刷新与 App 的 `agent/changed`。 */
  const [reloadTick, setReloadTick] = useState(0);
  /** 在飞判定的同步事实源：state 更新是异步的，双击要靠 ref 挡。 */
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

  const toggle = async (card: AgentPackageCard) => {
    if (!begin(card.slug)) return;
    setError("");
    setWarning("");
    setNote("");
    try {
      await rpcCall("agent.packageSetEnabled", { slug: card.slug, enabled: !card.enabled });
      setNote(card.enabled ? `已关闭「${card.displayName}」` : `已启用「${card.displayName}」`);
      reload();
    } catch (cause) {
      setError(catalogErrorMessage(cause));
    } finally {
      end(card.slug);
    }
  };

  const cards = data ? filterPackageTab(mineCards(data), search) : [];

  return (
    <div className="agent-packages-panel">
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
        <p className="panel-empty">{search.trim() ? SEARCH_EMPTY_TEXT : MINE_EMPTY_TEXT}</p>
      ) : (
        <div className="skill-grid">
          {cards.map((card) => (
            <AgentPackageCardView
              key={`${card.source}:${card.slug}`}
              card={card}
              busy={busySlugs.includes(card.slug)}
              begin={begin}
              end={end}
              onToggle={(target) => void toggle(target)}
              onDetail={setDetailCard}
              onReload={reload}
              onNotice={showNotice}
            />
          ))}
        </div>
      )}

      {detailCard ? (
        <AgentPackageDetailDialog slug={detailCard.slug} onClose={() => setDetailCard(undefined)} />
      ) : null}
    </div>
  );
}

/** 一张包卡片：徽标、状态行、简介与 `packageActions` 生成的按钮。 */
export function AgentPackageCardView({
  card,
  busy,
  begin,
  end,
  onToggle,
  onDetail,
  onReload,
  onNotice,
  sourceBadge,
}: {
  card: AgentPackageCard;
  busy: boolean;
  begin: (slug: string) => boolean;
  end: (slug: string) => void;
  onToggle: (card: AgentPackageCard) => void;
  onDetail: (card: AgentPackageCard) => void;
  onReload: () => void;
  onNotice: (notice: PackageNotice) => void;
  /** 来源徽标的覆盖文案；广场沿用 M1 的“公用机”。 */
  sourceBadge?: string;
}) {
  const status = packageStatusLabel(card);
  const statusTone = packageStatusTone(card);
  const sourceLabel = sourceBadge ?? packageSourceLabel(card.source);
  return (
    <div className="skill-card" data-slug={card.slug}>
      <div className="top">
        <span className="av">{card.displayName.slice(0, 1).toUpperCase()}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="nm">{card.displayName}</div>
          <div className="agent-card-badges">
            <span className="badge">{sourceLabel}</span>
            <span className="badge">v{card.version}</span>
            <span className="badge">@{card.slug}</span>
            {card.migrationFrom ? <span className="badge">{MIGRATION_PACKAGE_LABEL}</span> : null}
            {/* 目录卡的状态行就是“来自广场”，与来源徽标重复时不再渲染第二个徽标。 */}
            {status && statusTone === "badge" && status !== sourceLabel ? (
              <span className="badge">{status}</span>
            ) : null}
          </div>
        </div>
      </div>
      {status && statusTone === "warn" ? (
        <div className="banner warn" style={{ margin: "6px 0", fontSize: 12 }}>
          {status}
        </div>
      ) : null}
      <p>{card.description || "（无描述）"}</p>
      {card.size !== undefined ? (
        <p className="hint agent-package-size">包大小 {formatPackageSize(card.size)}</p>
      ) : null}
      {card.source === "local" ? (
        <p className="hint agent-update-hint">{updateHintFor(card.slug)}</p>
      ) : null}
      <AgentPackageCardActions
        card={card}
        busy={busy}
        begin={begin}
        end={end}
        onToggle={onToggle}
        onDetail={onDetail}
        onReload={onReload}
        onNotice={onNotice}
      />
    </div>
  );
}

/**
 * 卡片动作区（M2）：发布/下架/移除走确认对话框，下载/更新/看状态直接调用。
 *
 * `begin/end` 来自面板的 per-slug 在飞表：同卡重复点击被忽略，其他卡不阻塞。
 * 启停由页签自己实现（广场的启用要先披露能力），这里只负责渲染与调用。
 */
export function AgentPackageCardActions({
  card,
  busy,
  begin,
  end,
  onToggle,
  onDetail,
  onReload,
  onNotice,
}: {
  card: AgentPackageCard;
  busy: boolean;
  begin: (slug: string) => boolean;
  end: (slug: string) => void;
  onToggle: (card: AgentPackageCard) => void;
  onDetail: (card: AgentPackageCard) => void;
  onReload: () => void;
  onNotice: (notice: PackageNotice) => void;
}) {
  const [dialog, setDialog] = useState<"publish" | "delist" | "remove" | undefined>(undefined);
  const [delistReason, setDelistReason] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");

  const actions = packageActions(card);
  const primary = actions.filter((action) => action !== "detail");
  const hasDetail = actions.includes("detail");

  const closeDialog = () => {
    if (dialogBusy) return;
    setDialog(undefined);
    setDialogError("");
    setDelistReason("");
  };

  const invoke = async (task: () => Promise<PackageNotice | undefined>) => {
    if (!begin(card.slug)) return;
    try {
      const notice = await task();
      if (notice !== undefined) onNotice(notice);
      onReload();
    } catch (cause) {
      onNotice({ tone: "error", text: catalogErrorMessage(cause) });
    } finally {
      end(card.slug);
    }
  };

  const confirmDialog = async (task: () => Promise<PackageNotice>) => {
    if (!begin(card.slug)) return;
    setDialogBusy(true);
    setDialogError("");
    try {
      const notice = await task();
      setDialog(undefined);
      setDelistReason("");
      onNotice(notice);
      onReload();
    } catch (cause) {
      // 业务错误留在对话框里，用户能看到撤销/验签/网络的具体原因。
      setDialogError(catalogErrorMessage(cause));
    } finally {
      setDialogBusy(false);
      end(card.slug);
    }
  };

  const run = (action: AgentPackageAction) => {
    if (busy) return;
    switch (action) {
      case "detail":
        onDetail(card);
        return;
      case "enable":
      case "disable":
        onToggle(card);
        return;
      case "publish":
        setDialogError("");
        setDialog("publish");
        return;
      case "request-delist":
        setDialogError("");
        setDelistReason("");
        setDialog("delist");
        return;
      case "remove":
        setDialogError("");
        setDialog("remove");
        return;
      case "install":
        void invoke(async () => {
          const result = await rpcCall<{ version?: string }>("agent.packageInstall", {
            slug: card.slug,
            version: card.version,
          });
          return {
            tone: "note",
            text: `已下载「${card.displayName}」v${result?.version ?? card.version}`,
          };
        });
        return;
      case "update":
        void invoke(async () => {
          const result = await rpcCall<{ version?: string }>("agent.packageUpdate", { slug: card.slug });
          return {
            tone: "note",
            text: `已更新「${card.displayName}」到 v${result?.version ?? card.version}`,
          };
        });
        return;
      case "publish-status":
        void invoke(async () => {
          const result = await rpcCall<{
            publishStatus: AgentPackagePublishStatus;
            publishedVersion?: string;
            reviewReason?: string;
          }>("agent.packagePublishStatus", { slug: card.slug });
          return publicationNotice(result);
        });
        return;
    }
  };

  return (
    <>
      <div className="page-tools agent-package-actions" style={{ marginTop: 8, marginBottom: 0 }}>
        {hasDetail ? (
          <button type="button" className="filter-tab" disabled={busy} onClick={() => run("detail")}>
            查看详情
          </button>
        ) : null}
        <span className="composer-spacer" />
        {primary.map((action) => (
          <button
            key={action}
            type="button"
            className={
              (action === "enable" && card.enabled) || (action === "disable" && card.enabled)
                ? "filter-tab on"
                : "filter-tab"
            }
            disabled={busy}
            onClick={() => run(action)}
          >
            {packageActionLabel(action, card)}
          </button>
        ))}
      </div>

      {dialog === "publish" ? (
        <div className="settings-overlay" role="dialog" aria-label="发布确认">
          <div className="confirm-modal">
            <h3>提交审查</h3>
            <p className="sub">{PUBLISH_CONFIRM_TEXT}</p>
            {dialogError ? <p className="banner error">{dialogError}</p> : null}
            <div className="page-tools" style={{ margin: "10px 0 0" }}>
              <span className="composer-spacer" />
              <button type="button" className="filter-tab" onClick={closeDialog} disabled={dialogBusy}>
                取消
              </button>
              <button
                type="button"
                className="btn-dark"
                disabled={dialogBusy}
                onClick={() =>
                  void confirmDialog(async () => {
                    await rpcCall("agent.packagePublish", { slug: card.slug });
                    return { tone: "note", text: "已提交审查，等待管理员处理" };
                  })
                }
              >
                {dialogBusy ? "提交中…" : "确认提交"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog === "delist" ? (
        <div className="settings-overlay" role="dialog" aria-label="申请下架">
          <div className="confirm-modal">
            <h3>申请下架「{card.displayName}」</h3>
            <p className="sub">{DELIST_CONFIRM_TEXT}</p>
            <label className="modal-field">
              下架原因
              <input
                className="modal-input"
                value={delistReason}
                aria-label="下架原因"
                placeholder="下架原因（必填）"
                onChange={(event) => setDelistReason(event.target.value)}
              />
            </label>
            {dialogError ? <p className="banner error">{dialogError}</p> : null}
            <div className="page-tools" style={{ margin: "10px 0 0" }}>
              <span className="composer-spacer" />
              <button type="button" className="filter-tab" onClick={closeDialog} disabled={dialogBusy}>
                取消
              </button>
              <button
                type="button"
                className="btn-dark"
                disabled={dialogBusy || delistReason.trim().length === 0}
                onClick={() =>
                  void confirmDialog(async () => {
                    await rpcCall("agent.packageRequestDelist", {
                      slug: card.slug,
                      reason: delistReason.trim(),
                    });
                    return { tone: "note", text: "已提交下架申请" };
                  })
                }
              >
                {dialogBusy ? "提交中…" : "确认下架"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog === "remove" ? (
        <div className="settings-overlay" role="dialog" aria-label="移除智能体包">
          <div className="confirm-modal">
            <h3>移除「{card.displayName}」</h3>
            <p className="sub">移除后本机将删除该智能体包；如需再次使用，可从广场重新下载。</p>
            {dialogError ? <p className="banner error">{dialogError}</p> : null}
            <div className="page-tools" style={{ margin: "10px 0 0" }}>
              <span className="composer-spacer" />
              <button type="button" className="filter-tab" onClick={closeDialog} disabled={dialogBusy}>
                取消
              </button>
              <button
                type="button"
                className="btn-dark"
                disabled={dialogBusy}
                onClick={() =>
                  void confirmDialog(async () => {
                    await rpcCall("agent.packageRemove", { slug: card.slug });
                    return { tone: "note", text: `已移除「${card.displayName}」` };
                  })
                }
              >
                {dialogBusy ? "移除中…" : "确认移除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * 包/旧目录智能体的详情弹层：已安装包与 legacy 条目走 `agent.packageDetail`，
 * 按 `slug` 收窄两侧载荷。
 *
 * 广场未安装签名卡（`summary.installed === false`）**不**调用
 * `agent.packageDetail`：磁盘上没有这个包，调用只会得到“不存在”。这类详情只读
 * 目录摘要（名称/简介/版本/大小/更新时间/迁移来源），并明示签名与文件清单需
 * 安装后查看；不伪造 keyId/signedAt/验签结果。
 *
 * M2 增加发布状态与签名信息：已安装目录包显示 keyId/签名时间/槽位/验签结果，
 * 本地包明示“本地创建，未签名”。底部固定展示本机沙箱提示（所有详情相同）。
 */
export function AgentPackageDetailDialog({
  slug,
  summary,
  onClose,
}: {
  slug: string;
  /** 广场未安装签名卡的摘要；只有 `installed === false` 时启用摘要详情。 */
  summary?: AgentPackageCard;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<AgentPackageDetailResult | undefined>(undefined);
  const [error, setError] = useState("");
  const summaryOnly = summary?.installed === false;
  const summaryDetail = summaryOnly ? summary : undefined;

  useEffect(() => {
    if (summaryOnly) return undefined;
    let active = true;
    void (async () => {
      try {
        const res = await rpcCall<AgentPackageDetailResult>("agent.packageDetail", { slug });
        if (!active) return;
        setDetail(res);
        setError("");
      } catch (cause) {
        if (active) setError(catalogErrorMessage(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [slug, summaryOnly]);

  const packageDetail = detail !== undefined && isAgentPackageDetail(detail) ? detail : undefined;
  const legacyDetail = detail !== undefined && !isAgentPackageDetail(detail) ? detail : undefined;
  const title =
    summaryDetail?.displayName ??
    packageDetail?.displayName ??
    legacyDetail?.displayName ??
    legacyDetail?.name ??
    slug;
  const signature = packageDetail?.signature;

  return (
    <div className="settings-overlay" role="dialog" aria-label={`智能体详情：${title}`}>
      <div className="confirm-modal automation-form">
        <h3>{title}</h3>
        {error ? <p className="banner error">{error}</p> : null}
        {detail === undefined && !error && summaryDetail === undefined ? (
          <p className="hint">加载中…</p>
        ) : null}

        {summaryDetail ? (
          <>
            <div className="agent-card-badges">
              <span className="badge">{packageSourceLabel("catalog")}</span>
              <span className="badge">v{summaryDetail.version}</span>
              <span className="badge">@{summaryDetail.slug}</span>
              {summaryDetail.migrationFrom ? (
                <span className="badge">{MIGRATION_PACKAGE_LABEL}</span>
              ) : null}
            </div>
            <p className="hint">{summaryDetail.description || "（无描述）"}</p>
            <section className="agent-detail-section">
              <strong>包信息</strong>
              {summaryDetail.size !== undefined ? (
                <p>包大小 {formatPackageSize(summaryDetail.size)}</p>
              ) : null}
              {summaryDetail.updatedAt ? <p>更新时间：{summaryDetail.updatedAt}</p> : null}
              {summaryDetail.migrationFrom ? (
                <p>迁移来源：{summaryDetail.migrationFrom}</p>
              ) : null}
            </section>
            <section className="agent-detail-section">
              <strong>签名</strong>
              <p>{INSTALL_DETAIL_NOTICE}</p>
            </section>
          </>
        ) : null}

        {packageDetail ? (
          <>
            <div className="agent-card-badges">
              <span className="badge">{packageSourceLabel(packageDetail.source)}</span>
              <span className="badge">v{packageDetail.version}</span>
              <span className="badge">@{packageDetail.slug}</span>
            </div>
            <p className="hint">{packageDetail.description || "（无描述）"}</p>
            <section className="agent-detail-section">
              <strong>发布状态</strong>
              <p>{packageDetailPublishStatus(packageDetail)}</p>
              {packageDetail.publishedVersion ? (
                <p>已发布版本 v{packageDetail.publishedVersion}</p>
              ) : null}
            </section>
            <section className="agent-detail-section">
              <strong>签名</strong>
              {packageDetail.source === "local" ? (
                <p>{LOCAL_UNSIGNED_LABEL}</p>
              ) : signature === undefined ? (
                <p>{MISSING_SIGNATURE_LABEL}</p>
              ) : signature.verification === "valid" ? (
                <>
                  <p>keyId：{signature.keyId}</p>
                  <p>签名时间：{signature.signedAt}</p>
                  <p>槽位：{signature.slot}</p>
                  <p>验签结果：通过</p>
                </>
              ) : signature.verification === "invalid" ? (
                <>
                  <p>验签结果：未通过</p>
                  {signature.reason ? <p>原因：{signature.reason}</p> : null}
                </>
              ) : (
                <p>{MISSING_SIGNATURE_LABEL}</p>
              )}
            </section>
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
              <strong>文件（digest 清单）</strong>
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
