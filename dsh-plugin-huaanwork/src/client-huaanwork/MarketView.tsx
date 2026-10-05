import { useCallback, useEffect, useState, type ReactNode } from "react";

import { createDesktopSettingsApi } from "../client/desktop-settings-api.ts";
import { rpcCall, pickDirectoryDetailed } from "./api.ts";
import { PLUGIN_APPLY_FAIL, PLUGIN_CONFIRM } from "./Settings.tsx";
import {
  catalogItemLabel,
  describeInstalledEmptyMessage,
  describeMarketPanel,
  describeMarketSourceHint,
  filterCatalogItems,
  filterInstallable,
  formatMarketSize,
  immutableRemoveReason,
  installButtonState,
  installableLabel,
  MARKET_TAB_LABELS,
  MARKET_TABS,
  parseImmutableBundles,
  RESTART_CANCELLED_NOTICE,
  RESTART_CANCELLED_REMOVED_NOTICE,
  RESTART_UNAVAILABLE_NOTICE,
  restartPending,
  shortSha256,
  type MarketCatalogView,
  type MarketInstallableItem,
  type MarketInstallationsView,
  type MarketLoadState,
  type MarketMutationResult,
  type MarketPanelPhase,
  type MarketPreviewView,
  type MarketStateView,
  type MarketTab,
} from "./logic/market.ts";
import { presentMarketError, type MarketErrorPresentation } from "./logic/marketErrors.ts";
import { resolveRestartAvailability } from "./logic/restartAvailability.ts";
import MarketSourcePanel, { ErrorPanel } from "./MarketSourcePanel.tsx";

/**
 * 市场页（M5 Task 6）：经 wrapper 自注册的表外 routes 直连
 * `/api/huaanwork-market/*`（守则 5：不进 client-huaanwork/api.ts 的 ROUTES 镜像）。
 *
 * - discover/installable 目录与可安装列表；installed 复用 M4 plugin.remove 卸载；
 * - 安装走 preview → execute 链（Task 5），execute 期间防连点（wrapper 亦单飞 409）；
 * - 错误态三类区分（不可达/验签失败/sha 不符），fail-closed 类不提供绕过（R23）；
 * - 「本地安装」tab（Task 7）：目录/.tgz 经 M4 plugin.add/remove 本地 RPC，不经内网——
 *   内网宕机时 remote tab 诚实报错、本 tab 仍可用（spec §13 单点缓解旁路）；
 * - 切走再回来即重新挂载并重新拉取；在飞安装经 /state 的 executing 标志自恢复
 *   （D13 轮询恢复）：挂载发现飞行中 ⇒ 显示进行中标识并 2s 轮询至完成后刷新列表。
 * - 「来源」页签（M6 Task 5.1，债务 N-1）：MarketSourcePanel 呈现只读来源地址 +
 *   provider 开关（disabled ↔ huaanwork-market）——写面走 M5 既有 desktop settings
 *   route（/api/desktop/settings、/api/desktop/market/select），不改 route 面。
 * - 取消重启后的重启入口（M6 Task 5.3，债务 P28）：安装链取消重启 ⇒ 清单已写入而
 *   应用未重启，页面级给出「立即重启」（打既有表外 route，不新增 route）+
 *   spec §14 第 33 条诚实文案；动作可用性读 /state 的 `desktopActions.requestRestart`。
 * - IMMUTABLE bundle 的移除灰化（M6 Task 6.10，债务 P26）：不可移除名单随
 *   installations 应答下发（host 的 IMMUTABLE_BUNDLES 是唯一真相源，客户端不复制），
 *   命中即禁用移除按钮并给出可访问说明；installed 与 local 两个页签同口径（同一份
 *   清单、同一条 plugin.remove RPC）。
 */

const ROUTE_STATE = "/api/huaanwork-market/state";
const ROUTE_CATALOG = "/api/huaanwork-market/catalog";
const ROUTE_INSTALLABLE = "/api/huaanwork-market/installable";
const ROUTE_INSTALLATIONS = "/api/huaanwork-market/installations";
const ROUTE_PREVIEW = "/api/huaanwork-market/operations/preview";
const ROUTE_EXECUTE = "/api/huaanwork-market/operations/execute";
// 表外既有 route 的第 7 条（market/routes.ts:59，P28 的后半）：取消重启后的唯一
// 重启入口。MARKET_ROUTE_PATHS 恒 7 条——本 Task 只消费，不新增（Global Constraint 5）。
const ROUTE_REQUEST_RESTART = "/api/huaanwork-market/desktop/request-restart";

// 在飞安装轮询的放弃预算(修复轮 N-4)。/state 走 market route、本地安装走 host
// RPC——两条通道,不能假定同生共死;市场面持续不可读时必须放弃观察并诚实告知,
// 否则 remoteExecuting 永久为 true ⇒ 红条不退、anyExecuting 恒真 ⇒ installable
// 与本地页签的全部控件被永久禁用(把旁路可用性挂在一个可能永久失败的观察态上)。
const EXECUTING_POLL_INTERVAL_MS = 2000;
const EXECUTING_POLL_FAILURE_BUDGET = 3;
const EXECUTING_POLL_TOTAL_BUDGET_MS = 10 * 60 * 1000;

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

/** 直连 wrapper route 的 fetch：非 2xx 解析 `{error:{code,message}}` 并抛出带 .code 的 Error。 */
async function marketFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    // 网络层失败（连接 reset 等）：等价于市场面不可达的呈现口径。
    const wrapped = new Error(error instanceof Error ? error.message : String(error)) as Error & {
      code?: string;
    };
    wrapped.code = "market-unreachable";
    throw wrapped;
  }
  const payload = (await response.json().catch(() => undefined)) as ErrorEnvelope | undefined;
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`) as Error & {
      code?: string;
      status?: number;
    };
    if (payload?.error?.code !== undefined) error.code = payload.error.code;
    // 无 code 时（如 frontend-static fallback 回 HTML），HTTP 状态供分类
    // not-registered（D10：市场路由未注册 = provider 未启用）。
    error.status = response.status;
    throw error;
  }
  return payload as T;
}

type LoadState = MarketLoadState;

export default function MarketView() {
  const [tab, setTab] = useState<MarketTab>("discover");
  const [search, setSearch] = useState("");

  const [state, setState] = useState<MarketStateView | null>(null);
  const [stateLoad, setStateLoad] = useState<LoadState>("loading");
  // D10 后半：state 读失败也保留分类后的形态，来源页签据此给出与其余页签
  // 同口径的指引（not-registered / unreachable 各自文案），不再统一显示
  // 「无法读取市场状态」。
  const [stateError, setStateError] = useState<MarketErrorPresentation | null>(null);

  const [catalog, setCatalog] = useState<MarketCatalogView | null>(null);
  const [catalogLoad, setCatalogLoad] = useState<LoadState>("loading");
  const [catalogError, setCatalogError] = useState<MarketErrorPresentation | null>(null);

  const [installable, setInstallable] = useState<MarketInstallableItem[]>([]);
  const [installableLoad, setInstallableLoad] = useState<LoadState>("loading");

  const [bundles, setBundles] = useState<string[]>([]);
  // P26（M6 Task 6.10）：host 的权威不可移除集合，来自 installations 应答的
  // `immutable` 字段（源头 plugins-host.ts 的 IMMUTABLE_BUNDLES）。客户端不复制
  // 名单；命中即灰化移除按钮并说明。plugin.add/remove 的应答不带该字段而集合是
  // host 恒定量，故只在 installations 取数时更新，读失败时保留上一次的已知值
  //（否则一次瞬时失败会把灰化按钮重新点亮）。
  const [immutableBundles, setImmutableBundles] = useState<string[]>([]);
  // P27：区分「读取中 / 读失败 / 确实为空」，否则读失败会被呈现成
  // 「尚未安装任何插件」这句肯定式假话。
  const [installationsLoad, setInstallationsLoad] = useState<LoadState>("loading");

  // 在飞安装的服务端观察态（D13）：挂载时经 /state.executing 发现（本组件发起的
  // execute 期间切走再回来即此态）。轮询至 false 后清并刷新列表——notice 属
  // 组件内 state，跨 view 不存活，列表刷新即恢复信号，不伪造完成通知。
  const [remoteExecuting, setRemoteExecuting] = useState(false);

  const [preview, setPreview] = useState<MarketPreviewView | null>(null);
  const [previewError, setPreviewError] = useState<MarketErrorPresentation | null>(null);
  const [executing, setExecuting] = useState(false);
  // 通知条（P25）：失败（移除失败/本地安装失败/选择器不可用）走红色 error 条，
  // 成功（安装完成/取消重启）保持中性条——视觉显著性不再对失败静音。
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const notify = useCallback((text: string, error = false) => {
    setNotice({ text, error });
  }, []);

  const [localConfirming, setLocalConfirming] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState(false);

  // 待生效变更（P28，M6 Task 5.3；M1/D5 Task 2.2）：安装/卸载链取消重启 ⇒ 清单已变更而应用未重启。
  // 此前该状态只能体现为一句通知，用户没有任何界面手段触发重启（只能自己退出
  // 应用）；现在置位后由页面级条给出「立即重启」与 §14 第 33 条诚实文案。
  const [pendingRestart, setPendingRestart] = useState(false);
  const [pendingRestartContext, setPendingRestartContext] = useState<"install" | "remove" | null>(null);
  const [desktopSettingsReachable, setDesktopSettingsReachable] = useState(false);
  const [restartRequesting, setRestartRequesting] = useState(false);

  const loadCatalogSide = useCallback(async () => {
    setCatalogLoad("loading");
    setCatalogError(null);
    try {
      const [catalogView, installableView] = await Promise.all([
        marketFetch<MarketCatalogView>(ROUTE_CATALOG),
        marketFetch<{ items: MarketInstallableItem[] }>(ROUTE_INSTALLABLE),
      ]);
      setCatalog(catalogView);
      setInstallable(Array.isArray(installableView.items) ? installableView.items : []);
      setCatalogLoad("ready");
      setInstallableLoad("ready");
    } catch (error) {
      setCatalogError(presentMarketError(error));
      setCatalogLoad("error");
      setInstallableLoad("error");
    }
  }, []);

  const loadInstallations = useCallback(async () => {
    try {
      const listed = await marketFetch<MarketInstallationsView>(ROUTE_INSTALLATIONS);
      setBundles(Array.isArray(listed.bundles) ? listed.bundles : []);
      setImmutableBundles(parseImmutableBundles(listed));
      setInstallationsLoad("ready");
    } catch {
      // installations 读失败不阻断整页（旁路独立性，§13）——但**不得**把「读不到」
      // 呈现成「确实没有」（P27）：置 error 态，由 describeInstalledEmptyMessage
      // 给诚实文案，重进时自恢复。P26：不可移除集合保留上一次的已知值（host 恒定量）。
      setBundles([]);
      setInstallationsLoad("error");
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const stateView = await marketFetch<MarketStateView>(ROUTE_STATE);
        if (!alive) return;
        setState(stateView);
        setStateError(null);
        setStateLoad("ready");
        setRemoteExecuting(stateView.executing === true);
      } catch (error) {
        if (!alive) return;
        setStateError(presentMarketError(error));
        setStateLoad("error");
      }
    })();
    void (async () => {
      try {
        await createDesktopSettingsApi().read();
        if (!alive) return;
        setDesktopSettingsReachable(true);
      } catch {
        // 桌面通道探测失败时静默忽略（不可达，回落至 market action 或 none）
      }
    })();
    void loadCatalogSide();
    void loadInstallations();
    return () => {
      alive = false;
    };
  }, [loadCatalogSide, loadInstallations]);

  // D13 轮询恢复：remoteExecuting 期间每 2s 读 /state，飞行结束即清标识并
  // 刷新目录与已装列表（自恢复）；unmount 时清理定时器。本地发起的 execute
  // 由 confirmInstall 的收尾刷新管理，不经此轮询。
  // N-4：轮询带放弃预算（连续失败 / 总时长），放弃时清标识并诚实告知——
  // 「无法确认」而不是「已完成」；若安装其实仍在飞，用户再次 execute 会拿到
  // wrapper 的单飞 409 → busy 文案，不会并发写 profile。
  useEffect(() => {
    if (!remoteExecuting) return undefined;
    let stopped = false;
    let consecutiveFailures = 0;
    const startedAt = Date.now();
    const giveUp = (reason: string) => {
      setRemoteExecuting(false);
      notify(`无法确认市场安装状态：${reason}。安装可能仍在进行，请重试或重启应用后确认结果。`, true);
    };
    const poll = async () => {
      try {
        const stateView = await marketFetch<MarketStateView>(ROUTE_STATE);
        if (stopped) return;
        consecutiveFailures = 0;
        if (stateView.executing === true) {
          if (Date.now() - startedAt >= EXECUTING_POLL_TOTAL_BUDGET_MS) giveUp("等待已超过 10 分钟");
          return;
        }
        setRemoteExecuting(false);
        await Promise.all([loadCatalogSide(), loadInstallations()]);
      } catch {
        if (stopped) return;
        consecutiveFailures += 1;
        // 单次失败仍静默重试（瞬时抖动不值得打扰用户）；连续到预算才放弃。
        if (consecutiveFailures >= EXECUTING_POLL_FAILURE_BUDGET) giveUp("市场状态连续多次读取失败");
      }
    };
    const timer = setInterval(() => {
      void poll();
    }, EXECUTING_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [remoteExecuting, loadCatalogSide, loadInstallations, notify]);

  async function startInstall(item: MarketInstallableItem) {
    setNotice(null);
    setPreviewError(null);
    try {
      const view = await marketFetch<MarketPreviewView>(ROUTE_PREVIEW, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: item.name, version: item.version }),
      });
      setPreview(view);
    } catch (error) {
      setPreviewError(presentMarketError(error));
    }
  }

  async function confirmInstall() {
    if (!preview || executing) return;
    setExecuting(true);
    setPreviewError(null);
    const target = preview;
    setPreview(null);
    try {
      const result = await marketFetch<MarketMutationResult>(ROUTE_EXECUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: target.name, version: target.version }),
      });
      if (restartPending(result)) {
        // 取消重启：清单已写入而应用未重启 ⇒ 置待生效态，由页面条给出「立即重启」
        // 入口（诚实文案由客户端持有：route 的取消句是无增/删语境的中立句，见
        // logic/market.ts 的 RESTART_CANCELLED_NOTICE）。
        setPendingRestart(true);
        setPendingRestartContext("install");
      } else {
        // 确认路径应用随即 relaunch。
        notify(result.message ?? "安装完成，正在重启…");
      }
      await Promise.all([loadCatalogSide(), loadInstallations()]);
    } catch (error) {
      setPreviewError(presentMarketError(error));
    } finally {
      setExecuting(false);
    }
  }

  /**
   * 「立即重启」（P28，M6 Task 5.3）：取消过一次重启的用户经**既有**表外 route
   * `/api/huaanwork-market/desktop/request-restart` 再触发一次（不新增 route：
   * MARKET_ROUTE_PATHS 恒 7 条）。取消 ⇒ 变更仍待生效：入口与诚实文案原样保留
   * （P3 修复后 route 回的是无增/删语境的中立句「变更已保存」，不带安装语境，
   * 不覆盖本横幅的文案）；接受 ⇒ 应用随即 relaunch。
   */
  async function requestRestartNow() {
    if (restartRequesting) return;
    setRestartRequesting(true);
    setNotice(null);
    try {
      const result = await marketFetch<MarketMutationResult>(ROUTE_REQUEST_RESTART, { method: "POST" });
      if (!restartPending(result)) notify("正在重启…");
    } catch (error) {
      const presentation = presentMarketError(error);
      notify(`重启请求失败：${presentation.title}。${presentation.body}`, true);
    } finally {
      setRestartRequesting(false);
    }
  }

  async function removeBundle(name: string) {
    setNotice(null);
    try {
      const listed = await rpcCall<{ bundles?: string[]; message?: string; restarting?: boolean }>("plugin.remove", { name });
      setBundles(Array.isArray(listed.bundles) ? listed.bundles : []);
      setInstallationsLoad("ready");
      if (restartPending(listed)) {
        setPendingRestart(true);
        setPendingRestartContext("remove");
      } else if (listed.message) {
        notify(listed.message);
      }
      await loadCatalogSide();
    } catch (error) {
      notify(`移除失败：${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  /**
   * 本地安装（Task 7）：目录选择复用 M4 picker（win32 走 Electron 对话框，darwin 走
   * 上游 directory-picker native capability）。D11：环境未提供 picker 时诚实提示并
   * 指路路径输入，不再与「用户取消」同语义静默。
   */
  async function pickLocalPlugin() {
    const outcome = await pickDirectoryDetailed();
    if (outcome.path !== null) {
      setNotice(null);
      setLocalConfirming(outcome.path);
      return;
    }
    if (!outcome.available) {
      notify("当前环境不支持目录选择器；请在下方输入本地目录或 .tgz 的路径。", true);
    }
    // 用户取消：保持静默（同 M4 口径）。
  }

  /** 本地安装（D11）：自由文本路径提交——.tgz 与无 picker 平台的共同兜底。 */
  function submitLocalPath(path: string) {
    const trimmed = path.trim();
    if (trimmed === "" || localBusy || executing) return;
    setNotice(null);
    setLocalConfirming(trimmed);
  }

  /** 确认本地安装：M4 confirmAdd 同构——取消重启时置待生效态（同一判定服务两条安装路径）。 */
  async function confirmLocalAdd() {
    if (!localConfirming || localBusy) return;
    const source = localConfirming;
    setLocalConfirming(null);
    setLocalBusy(true);
    try {
      const listed = await rpcCall<{ bundles?: string[]; message?: string; restarting?: boolean }>("plugin.add", { source });
      setBundles(Array.isArray(listed.bundles) ? listed.bundles : []);
      setInstallationsLoad("ready");
      if (restartPending(listed)) {
        setPendingRestart(true);
        setPendingRestartContext("install");
      } else {
        notify(listed.message ?? "插件已安装");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify(`${PLUGIN_APPLY_FAIL}：${message}`, true);
    } finally {
      setLocalBusy(false);
    }
  }

  const catalogItems = filterCatalogItems(catalog?.items ?? [], search);
  const installableItems = filterInstallable(installable, search);
  // D13：面板四态（loading/error/empty/items）经纯函数判定，组合态回归由
  // logic 测试 + jsdom spec 双层钉住；错误面板复用同一 presentation。
  const discoverPhase = describeMarketPanel(catalogLoad, catalogError, catalogItems.length);
  const installablePhase = describeMarketPanel(installableLoad, catalogError, installableItems.length);
  // 安装/移除按钮的在飞禁用口径：本地 execute 与远端观察态任一在飞即禁用。
  const anyExecuting = executing || remoteExecuting;
  // P27：已安装列表的三态文案（null = 渲染列表）。installed 与 local 两个页签
  // 共用同一份，避免两处空态口径分叉。
  const installedEmptyMessage = describeInstalledEmptyMessage(installationsLoad, bundles.length);
  // 待生效入口的动作可用性（M1/D5：消费共享判定 resolveRestartAvailability）。
  // 优先表外 request-restart route，若 market bundle 未注册则回落至桌面设置重启 route；
  // 仅在两条通道均不可达时诚实告知手动重启。
  const marketRestartAction = state !== null && state.desktopActions.requestRestart;
  const restartAvailability = resolveRestartAvailability({
    marketRestartAction,
    desktopRestartRoute: desktopSettingsReachable,
  });

  function panelBody(
    phase: MarketPanelPhase,
    loadingText: string,
    emptyText: string,
    children: ReactNode,
  ): ReactNode {
    if (phase.kind === "loading") return <p className="panel-empty">{loadingText}</p>;
    if (phase.kind === "error") return <ErrorPanel presentation={phase.presentation} />;
    if (phase.kind === "empty") return <p className="panel-empty">{emptyText}</p>;
    return children;
  }

  return (
    <div className="page-view">
      <div className="page-head">
        <h1>插件市场</h1>
        <span className="hint-text">内网签名市场：目录与制品均经签名与 sha256 校验后安装</span>
      </div>

      <div className="page-tools">
        {/* P24：tab 语义（role/aria-selected）承本仓 App.tsx/AutomationsView.tsx/Settings.tsx 惯例。 */}
        <div className="market-tabs" role="tablist" aria-label="市场视图">
          {MARKET_TABS.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              className={tab === item ? "filter-tab on" : "filter-tab"}
              onClick={() => setTab(item)}
            >
              {MARKET_TAB_LABELS[item]}
            </button>
          ))}
        </div>
        {tab === "discover" || tab === "installable" ? (
          <input
            className="search-input"
            value={search}
            placeholder="🔍 搜索插件"
            aria-label="搜索插件"
            onChange={(event) => setSearch(event.target.value)}
          />
        ) : null}
        <span className="market-state-hint">{describeMarketSourceHint(state, stateLoad)}</span>
      </div>

      {remoteExecuting ? (
        <div className="banner" role="status">
          市场安装正在进行中，完成后列表将自动刷新。
        </div>
      ) : null}
      {notice ? (
        <div className={notice.error ? "banner error" : "banner"} role={notice.error ? "alert" : undefined}>
          {notice.text}
        </div>
      ) : null}
      {previewError ? (
        <div className="banner error" role="alert">
          {previewError.title}：{previewError.body}
        </div>
      ) : null}
      {pendingRestart ? (
        // 页面级（非页签级）：待生效的是 profile 清单，与当前看哪个页签无关。
        <div className="banner market-pending" role="status">
          <span className="market-pending-text">
            {pendingRestartContext === "remove" ? RESTART_CANCELLED_REMOVED_NOTICE : RESTART_CANCELLED_NOTICE}
          </span>
          {restartAvailability.canRestart ? (
            <button
              type="button"
              className="btn primary"
              disabled={restartRequesting}
              onClick={() => {
                if (restartAvailability.route === "market-action") {
                  void requestRestartNow();
                } else if (restartAvailability.route === "desktop-route") {
                  if (restartRequesting) return;
                  setRestartRequesting(true);
                  void createDesktopSettingsApi()
                    .restart()
                    .catch((error) => {
                      const message = error instanceof Error ? error.message : String(error);
                      notify(`重启请求失败：${message}`, true);
                    })
                    .finally(() => {
                      setRestartRequesting(false);
                    });
                }
              }}
            >
              {restartRequesting ? "重启中…" : "立即重启"}
            </button>
          ) : (
            <span className="market-pending-hint">{RESTART_UNAVAILABLE_NOTICE}</span>
          )}
        </div>
      ) : null}

      {tab === "discover" ? (
        panelBody(discoverPhase, "加载目录中…", "目录为空", (
          <ul className="market-list">
            {catalogItems.map((item, index) => (
              <li key={item.id ?? item.name ?? `catalog-${index}`} className="market-item">
                <span className="recent-title">{catalogItemLabel(item)}</span>
                {item.summary ? <span className="recent-meta">{item.summary}</span> : null}
              </li>
            ))}
          </ul>
        ))
      ) : tab === "installable" ? (
        panelBody(installablePhase, "加载可安装列表中…", "暂无可安装插件", (
          <ul className="market-list">
            {installableItems.map((item) => {
              const button = installButtonState(item, anyExecuting);
              return (
                <li key={item.id} className="market-item">
                  <span className="recent-title">
                    {installableLabel(item)} <em className="market-version">{item.version}</em>
                  </span>
                  {item.summary ? <span className="recent-meta">{item.summary}</span> : null}
                  <span className="recent-meta">
                    {formatMarketSize(item.size)} · sha256 {shortSha256(item.sha256)}
                  </span>
                  <button
                    type="button"
                    className="btn primary market-install"
                    disabled={button.disabled}
                    onClick={() => void startInstall(item)}
                  >
                    {button.label}
                  </button>
                </li>
              );
            })}
          </ul>
        ))
      ) : tab === "installed" ? (
        installedEmptyMessage !== null ? (
          <p className="panel-empty">{installedEmptyMessage}</p>
        ) : (
          <ul className="market-list">
            {bundles.map((name, index) => {
              // P26：host 标注不可移除的 carrier 灰化 + 说明（见 logic/market.ts 的
              // immutableRemoveReason——名单来自 installations 应答，不在此复制）。
              const reason = immutableRemoveReason(immutableBundles, name);
              const reasonId = `market-installed-remove-reason-${index}`;
              return (
                <li key={name} className="market-item">
                  <span className="recent-title">{name}</span>
                  {reason !== null ? (
                    <span className="recent-meta" id={reasonId}>
                      {reason}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="btn market-install"
                    disabled={reason !== null || localBusy || anyExecuting}
                    title={reason ?? undefined}
                    aria-describedby={reason !== null ? reasonId : undefined}
                    onClick={() => void removeBundle(name)}
                  >
                    移除
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : tab === "local" ? (
        <LocalPanel
          bundles={bundles}
          immutableBundles={immutableBundles}
          emptyMessage={installedEmptyMessage}
          localBusy={localBusy}
          executing={anyExecuting}
          onPick={() => void pickLocalPlugin()}
          onSubmitPath={(path) => submitLocalPath(path)}
          onRemove={(name) => void removeBundle(name)}
        />
      ) : (
        <MarketSourcePanel state={state} stateLoad={stateLoad} stateError={stateError} />
      )}

      {localConfirming ? (
        <div
          className="settings-overlay"
          role="dialog"
          aria-label="本地安装确认"
          onKeyDown={(event) => {
            // P24：Escape 关闭（承 App.tsx/AutomationsView.tsx/Settings.tsx 惯例）。
            if (event.key === "Escape" && !localBusy) {
              event.preventDefault();
              setLocalConfirming(null);
            }
          }}
        >
          <div className="confirm-modal">
            <p>{PLUGIN_CONFIRM}</p>
            <p className="hint">{localConfirming}</p>
            <div className="row">
              <button type="button" className="btn primary" disabled={localBusy} onClick={() => void confirmLocalAdd()}>
                {localBusy ? "安装中…" : "安装"}
              </button>
              {/* P24：初始焦点给最不具破坏性的动作，避免回车误触安装。 */}
              <button type="button" className="btn" autoFocus disabled={localBusy} onClick={() => setLocalConfirming(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {preview ? (
        <div
          className="settings-overlay"
          role="dialog"
          aria-label="安装确认"
          onKeyDown={(event) => {
            // P24：Escape 关闭（承 App.tsx/AutomationsView.tsx/Settings.tsx 惯例）。
            if (event.key === "Escape" && !executing) {
              event.preventDefault();
              setPreview(null);
            }
          }}
        >
          <div className="confirm-modal">
            <p>
              安装 {preview.name}@{preview.version}？制品将经签名目录校验（sha256 比对）后安装。
            </p>
            <p className="hint">
              {formatMarketSize(preview.size)} · sha256 {preview.sha256}
              <br />
              {preview.tarballUrl}
            </p>
            <div className="row">
              <button type="button" className="btn primary" disabled={executing} onClick={() => void confirmInstall()}>
                {executing ? "安装中…" : "安装"}
              </button>
              {/* P24：初始焦点给最不具破坏性的动作，避免回车误触安装。 */}
              <button type="button" className="btn" autoFocus disabled={executing} onClick={() => setPreview(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 「本地安装」tab：纯本地 plugin.add/remove RPC（不经内网，宕机旁路）。已装列表与
 * installed tab 同口径。D11：自由文本路径输入是 .tgz 与无 picker route 平台
 * （Linux，及 darwin 上 native capability 不可用的组合）的共同兜底；目录选择按钮
 * 在 picker 拒绝时诚实提示并指路输入框（兜底不得删除）。
 */
function LocalPanel({
  bundles,
  immutableBundles,
  emptyMessage,
  localBusy,
  executing,
  onPick,
  onSubmitPath,
  onRemove,
}: {
  bundles: string[];
  /** P26：host 的权威不可移除集合（与 installed 页签同一份），命中即灰化移除。 */
  immutableBundles: readonly string[];
  /** P27：已安装列表的三态文案（null = 渲染列表），与 installed 页签同源。 */
  emptyMessage: string | null;
  localBusy: boolean;
  executing: boolean;
  onPick: () => void;
  onSubmitPath: (path: string) => void;
  onRemove: (name: string) => void;
}) {
  const [pathText, setPathText] = useState("");
  const disabled = localBusy || executing;
  const trimmed = pathText.trim();
  return (
    <div className="market-local">
      <p className="hint">
        仅本地目录或 .tgz，拒绝 GitHub / URL；本地安装不经签名与 sha256 校验（与内网市场远程安装不同），风险披露见安装确认框。
      </p>
      <div className="row">
        <input
          className="search-input market-path-input"
          value={pathText}
          placeholder="输入本地目录或 .tgz 的绝对路径"
          aria-label="本地插件路径"
          disabled={disabled}
          onChange={(event) => setPathText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && trimmed !== "") onSubmitPath(trimmed);
          }}
        />
        <button
          type="button"
          className="btn primary"
          disabled={disabled || trimmed === ""}
          onClick={() => onSubmitPath(trimmed)}
        >
          添加
        </button>
        <button type="button" className="btn" disabled={disabled} onClick={onPick}>
          浏览目录…
        </button>
      </div>
      {emptyMessage !== null ? (
        <p className="panel-empty">{emptyMessage}</p>
      ) : (
        <ul className="market-list">
          {bundles.map((name, index) => {
            // P26：与 installed 页签同口径——同一份 host 清单、同一条 plugin.remove
            // RPC，host 拒绝移除的 carrier 在此同样灰化并说明。
            const reason = immutableRemoveReason(immutableBundles, name);
            const reasonId = `market-local-remove-reason-${index}`;
            return (
              <li key={name} className="market-item">
                <span className="recent-title">{name}</span>
                {reason !== null ? (
                  <span className="recent-meta" id={reasonId}>
                    {reason}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="btn market-install"
                  disabled={disabled || reason !== null}
                  title={reason ?? undefined}
                  aria-describedby={reason !== null ? reasonId : undefined}
                  onClick={() => onRemove(name)}
                >
                  移除
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

