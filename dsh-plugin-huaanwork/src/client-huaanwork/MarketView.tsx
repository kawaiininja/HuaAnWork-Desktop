import { useCallback, useEffect, useState } from "react";

import { rpcCall, pickDirectoryDetailed } from "./api.ts";
import { PLUGIN_APPLY_FAIL, PLUGIN_CONFIRM } from "./Settings.tsx";
import {
  catalogItemLabel,
  filterCatalogItems,
  filterInstallable,
  formatMarketSize,
  installableLabel,
  MARKET_TAB_LABELS,
  MARKET_TABS,
  shortSha256,
  type MarketCatalogView,
  type MarketInstallableItem,
  type MarketMutationResult,
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
 * - 切走再回来即重新挂载并重新拉取（installations 回来自恢复）。
 */

const ROUTE_STATE = "/api/huaanwork-market/state";
const ROUTE_CATALOG = "/api/huaanwork-market/catalog";
const ROUTE_INSTALLABLE = "/api/huaanwork-market/installable";
const ROUTE_INSTALLATIONS = "/api/huaanwork-market/installations";
const ROUTE_PREVIEW = "/api/huaanwork-market/operations/preview";
const ROUTE_EXECUTE = "/api/huaanwork-market/operations/execute";

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

type LoadState = "loading" | "ready" | "error";

export default function MarketView() {
  const [tab, setTab] = useState<MarketTab>("discover");
  const [search, setSearch] = useState("");

  const [state, setState] = useState<MarketStateView | null>(null);
  const [stateLoad, setStateLoad] = useState<LoadState>("loading");

  const [catalog, setCatalog] = useState<MarketCatalogView | null>(null);
  const [catalogLoad, setCatalogLoad] = useState<LoadState>("loading");
  const [catalogError, setCatalogError] = useState<MarketErrorPresentation | null>(null);

  const [installable, setInstallable] = useState<MarketInstallableItem[]>([]);
  const [installableLoad, setInstallableLoad] = useState<LoadState>("loading");

  const [bundles, setBundles] = useState<string[]>([]);

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
    } catch {
      // installations 读失败不阻断整页：installed tab 展示空并在重进时自恢复。
      setBundles([]);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const stateView = await marketFetch<MarketStateView>(ROUTE_STATE);
        if (!alive) return;
        setState(stateView);
        setStateLoad("ready");
      } catch {
        if (!alive) return;
        setStateLoad("error");
      }
    })();
    void loadCatalogSide();
    void loadInstallations();
    return () => {
      alive = false;
    };
  }, [loadCatalogSide, loadInstallations]);

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
        <span className="market-state-hint">
          {stateLoad === "ready" && state
            ? state.verification.ready
              ? `源：${state.origin}`
              : "信任锚未配置：目录验签恒拒，请联系市场管理员"
            : null}
        </span>
      </div>

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
        catalogLoad === "loading" ? (
          <p className="panel-empty">加载目录中…</p>
        ) : catalogLoad === "error" && catalogError ? (
          <ErrorPanel presentation={catalogError} />
        ) : catalogItems.length === 0 ? (
          <p className="panel-empty">目录为空</p>
        ) : (
          <ul className="market-list">
            {catalogItems.map((item, index) => (
              <li key={item.id ?? item.name ?? `catalog-${index}`} className="market-item">
                <span className="recent-title">{catalogItemLabel(item)}</span>
                {item.summary ? <span className="recent-meta">{item.summary}</span> : null}
              </li>
            ))}
          </ul>
        )
      ) : tab === "installable" ? (
        installableLoad === "loading" ? (
          <p className="panel-empty">加载可安装列表中…</p>
        ) : installableLoad === "error" && catalogError ? (
          <ErrorPanel presentation={catalogError} />
        ) : installableItems.length === 0 ? (
          <p className="panel-empty">暂无可安装插件</p>
        ) : (
          <ul className="market-list">
            {installableItems.map((item) => (
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
                  disabled={item.installed || executing}
                  onClick={() => void startInstall(item)}
                >
                  {item.installed ? "已安装" : executing ? "安装中…" : "安装"}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : tab === "installed" ? (
        bundles.length === 0 ? (
          <p className="panel-empty">尚未安装任何插件</p>
        ) : (
          <ul className="market-list">
            {bundles.map((name) => (
              <li key={name} className="market-item">
                <span className="recent-title">{name}</span>
                <button
                  type="button"
                  className="btn market-install"
                  disabled={localBusy || executing}
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
          localBusy={localBusy}
          executing={executing}
          onPick={() => void pickLocalPlugin()}
          onSubmitPath={(path) => submitLocalPath(path)}
          onRemove={(name) => void removeBundle(name)}
        />
      ) : (
        <SourcesPanel state={state} stateLoad={stateLoad} />
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
  localBusy,
  executing,
  onPick,
  onSubmitPath,
  onRemove,
}: {
  bundles: string[];
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
      {bundles.length === 0 ? (
        <p className="panel-empty">尚未安装任何插件</p>
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
function SourcesPanel({ state, stateLoad }: { state: MarketStateView | null; stateLoad: LoadState }) {
  return (
    <div className="market-sources">
      {stateLoad === "loading" ? (
        <p className="panel-empty">加载来源状态中…</p>
      ) : stateLoad === "error" ? (
        <p className="panel-empty">无法读取市场状态</p>
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
