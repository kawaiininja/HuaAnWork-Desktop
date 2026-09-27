import { useCallback, useEffect, useState, type ReactNode } from "react";

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
  installButtonState,
  installableLabel,
  MARKET_TAB_LABELS,
  MARKET_TABS,
  shortSha256,
  type MarketCatalogView,
  type MarketInstallableItem,
  type MarketLoadState,
  type MarketMutationResult,
  type MarketPanelPhase,
  type MarketPreviewView,
  type MarketStateView,
  type MarketTab,
} from "./logic/market.ts";
import { presentMarketError, type MarketErrorPresentation } from "./logic/marketErrors.ts";

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
 */

const ROUTE_STATE = "/api/huaanwork-market/state";
const ROUTE_CATALOG = "/api/huaanwork-market/catalog";
const ROUTE_INSTALLABLE = "/api/huaanwork-market/installable";
const ROUTE_INSTALLATIONS = "/api/huaanwork-market/installations";
const ROUTE_PREVIEW = "/api/huaanwork-market/operations/preview";
const ROUTE_EXECUTE = "/api/huaanwork-market/operations/execute";

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
      const listed = await marketFetch<{ bundles?: string[] }>(ROUTE_INSTALLATIONS);
      setBundles(Array.isArray(listed.bundles) ? listed.bundles : []);
      setInstallationsLoad("ready");
    } catch {
      // installations 读失败不阻断整页（旁路独立性，§13）——但**不得**把「读不到」
      // 呈现成「确实没有」（P27）：置 error 态，由 describeInstalledEmptyMessage
      // 给诚实文案，重进时自恢复。
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
      // 取消重启的 message 诚实告知（承 M4 confirmAdd 先例）；确认路径应用随即 relaunch。
      notify(result.message ?? (result.restarting ? "安装完成，正在重启…" : "插件已安装"));
      await Promise.all([loadCatalogSide(), loadInstallations()]);
    } catch (error) {
      setPreviewError(presentMarketError(error));
    } finally {
      setExecuting(false);
    }
  }

  async function removeBundle(name: string) {
    setNotice(null);
    try {
      const listed = await rpcCall<{ bundles?: string[]; message?: string }>("plugin.remove", { name });
      setBundles(Array.isArray(listed.bundles) ? listed.bundles : []);
      setInstallationsLoad("ready");
      if (listed.message) notify(listed.message);
      await loadCatalogSide();
    } catch (error) {
      notify(`移除失败：${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  /**
   * 本地安装（Task 7）：目录选择复用 M4 picker（仅 win32 注册 route）。
   * D11：平台不支持时诚实提示并指路路径输入，不再与「用户取消」同语义静默。
   */
  async function pickLocalPlugin() {
    const outcome = await pickDirectoryDetailed();
    if (outcome.path !== null) {
      setNotice(null);
      setLocalConfirming(outcome.path);
      return;
    }
    if (!outcome.available) {
      notify("当前平台不支持目录选择器；请在下方输入本地目录或 .tgz 的路径。", true);
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

  /** 确认本地安装：M4 confirmAdd 同构——取消重启时 message 诚实告知，失败给 PLUGIN_APPLY_FAIL。 */
  async function confirmLocalAdd() {
    if (!localConfirming || localBusy) return;
    const source = localConfirming;
    setLocalConfirming(null);
    setLocalBusy(true);
    try {
      const listed = await rpcCall<{ bundles?: string[]; message?: string }>("plugin.add", { source });
      setBundles(Array.isArray(listed.bundles) ? listed.bundles : []);
      setInstallationsLoad("ready");
      notify(listed.message ?? "插件已安装");
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
        {MARKET_TABS.map((item) => (
          <button
            key={item}
            type="button"
            className={tab === item ? "filter-tab on" : "filter-tab"}
            onClick={() => setTab(item)}
          >
            {MARKET_TAB_LABELS[item]}
          </button>
        ))}
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
            {bundles.map((name) => (
              <li key={name} className="market-item">
                <span className="recent-title">{name}</span>
                <button
                  type="button"
                  className="btn market-install"
                  disabled={localBusy || anyExecuting}
                  onClick={() => void removeBundle(name)}
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        )
      ) : tab === "local" ? (
        <LocalPanel
          bundles={bundles}
          emptyMessage={installedEmptyMessage}
          localBusy={localBusy}
          executing={anyExecuting}
          onPick={() => void pickLocalPlugin()}
          onSubmitPath={(path) => submitLocalPath(path)}
          onRemove={(name) => void removeBundle(name)}
        />
      ) : (
        <SourcesPanel state={state} stateLoad={stateLoad} stateError={stateError} />
      )}

      {localConfirming ? (
        <div className="settings-overlay" role="dialog" aria-label="本地安装确认">
          <div className="confirm-modal">
            <p>{PLUGIN_CONFIRM}</p>
            <p className="hint">{localConfirming}</p>
            <div className="row">
              <button type="button" className="btn primary" disabled={localBusy} onClick={() => void confirmLocalAdd()}>
                {localBusy ? "安装中…" : "安装"}
              </button>
              <button type="button" className="btn" disabled={localBusy} onClick={() => setLocalConfirming(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {preview ? (
        <div className="settings-overlay" role="dialog" aria-label="安装确认">
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
              <button type="button" className="btn" disabled={executing} onClick={() => setPreview(null)}>
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
 * installed tab 同口径。D11：自由文本路径输入是 .tgz 与无 picker 平台（macOS/Linux）
 * 的共同兜底；目录选择按钮仅在平台提供 picker route 时有效（否则诚实提示）。
 */
function LocalPanel({
  bundles,
  emptyMessage,
  localBusy,
  executing,
  onPick,
  onSubmitPath,
  onRemove,
}: {
  bundles: string[];
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
          {bundles.map((name) => (
            <li key={name} className="market-item">
              <span className="recent-title">{name}</span>
              <button
                type="button"
                className="btn market-install"
                disabled={disabled}
                onClick={() => onRemove(name)}
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 三类错误态展示：不可达给本地安装旁路提示，验签/sha 失败 fail-closed 无绕过（R23）。 */
function ErrorPanel({ presentation }: { presentation: MarketErrorPresentation }) {
  return (
    <div className="market-error" role="alert">
      <p className="market-error-title">{presentation.title}</p>
      <p className="hint">{presentation.body}</p>
      {presentation.canBypass ? (
        <p className="hint">旁路：切换到「本地安装」页签，可安装本地目录或 .tgz 插件（不经签名与 sha256 校验，风险披露见该页确认框）。</p>
      ) : null}
    </div>
  );
}

/** sources tab：M5 单 canonical 内网源；多源 UI 占位禁用（M6）。 */
function SourcesPanel({
  state,
  stateLoad,
  stateError,
}: {
  state: MarketStateView | null;
  stateLoad: LoadState;
  stateError: MarketErrorPresentation | null;
}) {
  return (
    <div className="market-sources">
      {stateLoad === "loading" ? (
        <p className="panel-empty">加载来源状态中…</p>
      ) : stateLoad === "error" ? (
        // D10 后半：复用与目录页签同口径的分类文案（not-registered 给出真实
        // 缺口与可达动作，unreachable 指向本地安装旁路），不再统一显示一句
        // 「无法读取市场状态」。stateError 理论上与 error 态成对置位，null 时
        // 回落旧文案仅作防御。
        stateError !== null ? (
          <ErrorPanel presentation={stateError} />
        ) : (
          <p className="panel-empty">无法读取市场状态</p>
        )
      ) : state ? (
        <ul className="market-list">
          <li className="market-item">
            <span className="recent-title">
              内网市场源 {state.verification.ready ? "（信任锚已配置）" : "（信任锚未配置）"}
            </span>
            <span className="recent-meta">地址：{state.origin}</span>
            {state.verification.currentKeyId ? (
              <span className="recent-meta">当前公钥：{state.verification.currentKeyId}</span>
            ) : null}
            <span className="recent-meta">
              已接受的清单 revision：{state.catalog.maxAcceptedRevision ?? "尚无"}
            </span>
          </li>
        </ul>
      ) : null}
      <div className="market-source-disabled" aria-disabled="true">
        <p className="recent-title">添加更多市场源</p>
        <p className="hint">多来源管理将在 M6 提供；当前版本仅支持内网单一受信任源。</p>
      </div>
    </div>
  );
}
