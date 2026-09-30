import { useCallback, useEffect, useState } from "react";

import { createDesktopSettingsApi, type DesktopMarketProvider } from "../client/desktop-settings-api.ts";
import type { MarketErrorPresentation } from "./logic/marketErrors.ts";
import type { MarketLoadState, MarketStateView } from "./logic/market.ts";

/**
 * 市场来源面板（M6 Task 5.1，债务 N-1）：把 provider 开关（disabled ↔
 * huaanwork-market）接进华安工作台界面，并保留来源地址的只读展示。
 *
 * Step 1 数据面结论（2026-09-27 核实）：
 * - 读（启用态）：GET /api/huaanwork-market/state（huaanwork-host/market/routes.ts:153-178
 *   handleState）返回 {provider, origin, executing, verification:{ready,currentKeyId?},
 *   catalog:{maxAcceptedRevision|null}, desktopActions:{requestRestart:true}}；`origin`
 *   即 wrapper 配置的当前来源地址（只读展示的事实源）。该 route 由 `huaanwork-market`
 *   wrapper bundle 注册（market/index.ts:54-87）——provider 为 disabled 时整组 route
 *   未注册（404），故它只能读「启用后的地址」，不能作为切换入口。
 * - 读/写（入口）：GET /api/desktop/settings（desktop-settings-api.ts:352 read()）
 *   返回 market:{requested, effective, legacyDefaulted}；POST /api/desktop/market/select
 *   （desktop-settings-api.ts:374 selectMarket()）返回 DesktopRestartAcceptance
 *   {accepted,restartRequired}。这两条 desktop settings route 在 index.ts:304-336 仅以
 *   `desktopSettingsController` service 为门（main.ts:1682 于 start() 内 provide，非
 *   shell-mode 门控）⇒ 默认 advanced shell（client-huaanwork 独占 layout、零消费
 *   settings.section slot）下同样注册，正是 N-1 缺失的那条入口。
 * - 写后语义：DesktopSettingsController.selectMarket 先落盘选择、应答后
 *   scheduleRestart()（desktop-settings-controller.ts:149-158）⇒ 应用自行提示重启；
 *   取消重启不回滚已保存的选择（spec §14 第 33 条措辞，见对话框文案）。
 * - 产品面只呈现两个状态：disabled ↔ huaanwork-market（desktop-market.ts:25 联合类型
 *   四成员中本产品实际出货的两个；community-market / dsh-market 为上游形态，内网
 *   部署不可达，不呈现）。多来源增删改不做（spec §7.3：来源管理不暴露给终端用户）。
 */

/** 本产品出货的两个 provider 状态（顺序即呈现顺序）。 */
interface SourceOption {
  readonly id: DesktopMarketProvider;
  readonly label: string;
  readonly body: string;
}

const SOURCE_OPTIONS: readonly SourceOption[] = [
  // 文案参照 client/desktop-settings-locales.ts 的 marketDisabled/huaanworkMarket；
  // disabled 一项的标题与 not-registered 文案统一喊「禁用」（该文案口径即 provider 值）。
  { id: "disabled", label: "禁用插件市场", body: "不加载插件市场界面。" },
  { id: "huaanwork-market", label: "华安内网市场", body: "企业内网插件市场，目录源由部署方配置，仅在企业内网可用。" },
];

function providerLabel(provider: DesktopMarketProvider): string {
  return SOURCE_OPTIONS.find((option) => option.id === provider)?.label ?? provider;
}

type ProviderPhase = "loading" | "ready" | "error";
type ApplyPhase = "idle" | "saving" | "saved" | "failed";

interface ProviderView {
  readonly requested: DesktopMarketProvider;
  readonly effective: DesktopMarketProvider;
}

/** MarketView「来源」页签内容：来源只读展示 + provider 开关。 */
export default function MarketSourcePanel({
  state,
  stateLoad,
  stateError,
}: {
  state: MarketStateView | null;
  stateLoad: MarketLoadState;
  stateError: MarketErrorPresentation | null;
}) {
  const [provider, setProvider] = useState<ProviderView | null>(null);
  const [providerPhase, setProviderPhase] = useState<ProviderPhase>("loading");
  const [confirming, setConfirming] = useState<DesktopMarketProvider | null>(null);
  const [applyPhase, setApplyPhase] = useState<ApplyPhase>("idle");
  // 本次保存是否伴随重启（acceptance.restartRequired）：取消重启不回滚的措辞
  // 只在真的需要重启时出现——选择与当前生效来源一致时不得谎报「正在重启」。
  const [applyRestart, setApplyRestart] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const readProvider = useCallback(async () => {
    setProviderPhase("loading");
    try {
      const view = await createDesktopSettingsApi().read();
      setProvider({
        requested: view.market.requested,
        effective: view.market.effective,
      });
      setProviderPhase("ready");
    } catch {
      // 读不到当前 provider ⇒ 不呈现可能不成立的开关（fail-closed），诚实告知。
      setProvider(null);
      setProviderPhase("error");
    }
  }, []);

  useEffect(() => {
    void readProvider();
  }, [readProvider]);

  function openConfirm(target: DesktopMarketProvider): void {
    setApplyPhase("idle");
    setApplyRestart(false);
    setApplyError(null);
    setConfirming(target);
  }

  function closeConfirm(): void {
    if (applyPhase === "saving") return;
    setConfirming(null);
    setApplyPhase("idle");
    setApplyRestart(false);
    setApplyError(null);
  }

  async function confirmSwitch(): Promise<void> {
    if (confirming === null || applyPhase === "saving") return;
    const target = confirming;
    setApplyPhase("saving");
    setApplyError(null);
    const api = createDesktopSettingsApi();
    try {
      const acceptance = await api.selectMarket(target);
      setProvider((current) =>
        current === null ? current : { ...current, requested: target, legacyDefaulted: false },
      );
      setApplyPhase("saved");
      setApplyRestart(acceptance.restartRequired);
      if (acceptance.restartRequired) {
        // 确认后调既有 restart route（/api/desktop/restart；Electron 下经 preload
        // bridge 等价直调）。controller.selectMarket 已在应答后自行 scheduleRestart，
        // 而 ElectronDesktopRuntime.requestRestart 对在飞请求去重（restartRequest 字段）
        // ⇒ 两次调用合并为同一次重启确认，不新增 route。
        try {
          await api.restart();
        } catch {
          // 选择已保存，不得谎报为「未保存」；诚实告知需手动重启。
          setApplyError("选择已保存，但重启请求未成功；请手动退出并重新打开应用以生效。");
        }
      }
    } catch (error) {
      setApplyPhase("failed");
      setApplyError(error instanceof Error ? error.message : String(error));
    }
  }

  const currentLabel = provider === null ? "" : providerLabel(provider.requested);

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

      <div className="market-provider">
        <p className="recent-title">市场来源</p>
        <p className="hint">来源地址由部署方配置，此处只读展示；这里只切换是否启用内网市场。</p>
        {providerPhase === "loading" ? <p className="panel-empty">读取当前市场来源中…</p> : null}
        {providerPhase === "error" ? (
          <>
            <p className="panel-empty">无法读取当前市场来源，切换暂不可用。</p>
            <div className="row">
              <button type="button" className="btn" onClick={() => void readProvider()}>
                重试
              </button>
            </div>
          </>
        ) : null}
        {providerPhase === "ready" && provider !== null ? (
          <>
            <div className="market-provider-options" role="radiogroup" aria-label="市场来源">
              {SOURCE_OPTIONS.map((option) => {
                const checked = provider.requested === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    data-market-provider={option.id}
                    className={checked ? "market-provider-option on" : "market-provider-option"}
                    onClick={() => {
                      if (!checked) openConfirm(option.id);
                    }}
                  >
                    <span className="market-provider-option-title">{option.label}</span>
                    <span className="market-provider-option-body">{option.body}</span>
                    {checked ? (
                      <span className="market-provider-option-status">
                        当前{provider.requested !== provider.effective ? "（重启后生效）" : ""}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {provider.requested !== provider.effective ? (
              <p className="hint" role="status">
                已选择「{currentLabel}」，重启应用后生效；取消重启不会撤销该选择，下次启动应用时照常生效。
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="market-source-disabled" aria-disabled="true">
        <p className="recent-title">添加更多市场源</p>
        <p className="hint">多来源管理将在 M6 提供；当前版本仅支持内网单一受信任源。</p>
      </div>

      {confirming !== null ? (
        <div
          className="settings-overlay"
          role="dialog"
          aria-label="切换市场来源"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeConfirm();
            }
          }}
        >
          <div className="confirm-modal">
            <h3>切换市场来源</h3>
            <p className="hint">
              将市场来源切换为「{providerLabel(confirming)}」。市场来源变更需要重启应用后才能生效；若该选择本与当前生效来源一致，则无需重启。
            </p>
            <p className="hint">
              确认后应用会保存该选择；若需要重启，在重启确认中选择「取消」不会撤销该选择——它已保存，下次启动应用时照常生效。
            </p>
            {applyPhase === "saved" && applyError !== null ? (
              <p className="banner error" role="alert" style={{ borderRadius: 8 }}>
                {applyError}
              </p>
            ) : null}
            {applyPhase === "saved" && applyError === null ? (
              <p className="banner" role="status" style={{ borderRadius: 8 }}>
                {applyRestart
                  ? "选择已保存。应用会提示重启以生效；若取消重启，选择不会回滚，下次启动应用时照常生效。"
                  : "选择已保存，与当前生效的市场来源一致，无需重启。"}
              </p>
            ) : null}
            {applyPhase === "failed" ? (
              <p className="banner error" role="alert" style={{ borderRadius: 8 }}>
                切换未保存：{applyError ?? "请稍后重试。"}
              </p>
            ) : null}
            <div className="row">
              {/* P24：初始焦点给最不具破坏性的动作，避免回车误触切换。 */}
              <button type="button" className="btn" autoFocus disabled={applyPhase === "saving"} onClick={closeConfirm}>
                {applyPhase === "saved" ? "关闭" : "取消"}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={applyPhase === "saving" || applyPhase === "saved"}
                onClick={() => void confirmSwitch()}
              >
                {applyPhase === "saving" ? "保存中…" : "保存并重启"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 三类错误态展示：不可达给本地安装旁路提示，验签/sha 失败 fail-closed 无绕过（R23）。
 * 原在 MarketView 内（与来源面板共用同一 `.market-error` 形态）；随来源面板抽到
 * 本模块并由 MarketView 复用，避免两个组件互相 import 形成环。 */
export function ErrorPanel({ presentation }: { presentation: MarketErrorPresentation }) {
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
