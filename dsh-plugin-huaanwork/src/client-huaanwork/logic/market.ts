import type { MarketErrorPresentation } from "./marketErrors.ts";

/**
 * 市场页（MarketView）纯函数与本地形态声明（M5 Task 6）。
 *
 * round3 R12：上游 `Market*Response` 类型未导出、api-types 不在 exports map，
 * 客户端形态**本地声明、仅作参照**——以下为 wrapper routes（Task 5）应答的
 * renderer 侧读取形态，不经 client-huaanwork/api.ts 的 ROUTES 镜像（守则 5：
 * market 面 fetch 直连 wrapper 自注册的表外 routes）。
 *
 * 所有函数保持纯（无副作用、可 node 测试），承 M4 keepAwake/missedBanner 惯例。
 */

/** MarketView 页内 tab 联合（形态参照 dsh-community-market MarketSettingsTab，重写为 renderer 实现）。
 * 「local」为 M5 有意偏离（spec §12 本地安装 tab 合并）：内网宕机旁路，走纯本地 plugin.add/remove。 */
export type MarketTab = "discover" | "installable" | "installed" | "local" | "sources";

export const MARKET_TABS: readonly MarketTab[] = ["discover", "installable", "installed", "local", "sources"];

export const MARKET_TAB_LABELS: Record<MarketTab, string> = {
  discover: "发现",
  installable: "可安装",
  installed: "已安装",
  local: "本地安装",
  sources: "来源",
};

/** GET /api/huaanwork-market/state —— wrapper 自有形态（round3 R14，不假设上游 MarketStateResponse）。 */
export interface MarketStateView {
  provider: string;
  origin: string;
  verification: { ready: boolean; currentKeyId?: string };
  catalog: { maxAcceptedRevision: number | null };
  desktopActions: { requestRestart: boolean };
  /**
   * 服务端单飞标志（D13 轮询恢复）：execute 在飞时为 true。挂载读到 true ⇒
   * 显示「安装进行中」标识并轮询至完成——切 view 卸载后回来仍能自恢复。
   * 可选字段：旧 wrapper 应答无此键，按 false 处理。
   */
  executing?: boolean;
}

/** 三条取数（state/catalog/installations）共用的加载态。 */
export type MarketLoadState = "loading" | "ready" | "error";

/** GET /api/huaanwork-market/catalog —— CatalogSnapshot 展示形态（items 为 provider-page item）。 */
export interface MarketCatalogItem {
  id?: string;
  name?: string;
  displayName?: string;
  summary?: string;
}

export interface MarketCatalogView {
  schemaVersion: string;
  source: {
    sourceRecordId: string;
    providerId: string;
    adapterId: string;
    registrationKind: string;
    fetchedAt: string;
    finalUrl: string;
    providerGeneratedAt?: string;
  };
  items: MarketCatalogItem[];
  page: { total?: number };
}

/** GET /api/huaanwork-market/installable 的单条可安装项。 */
export interface MarketInstallableItem {
  id: string;
  name: string;
  version: string;
  displayName?: string;
  summary?: string;
  sha256: string;
  size: number;
  installed: boolean;
}

/** POST /api/huaanwork-market/operations/preview 应答。 */
export interface MarketPreviewView {
  name: string;
  version: string;
  sha256: string;
  size: number;
  tarballUrl: string;
}

/** POST execute / request-restart 应答（键名与 M4 plugin.add/remove 一致）。 */
export interface MarketMutationResult {
  bundles?: string[];
  restarting?: boolean;
  message?: string;
}

/** 列表展示名：displayName 缺省回落包名。 */
export function installableLabel(item: Pick<MarketInstallableItem, "name" | "displayName">): string {
  const display = item.displayName?.trim();
  return display && display.length > 0 ? display : item.name;
}

/** 目录条目的展示名。 */
export function catalogItemLabel(item: MarketCatalogItem): string {
  const display = item.displayName?.trim();
  return display && display.length > 0 ? display : (item.name ?? item.id ?? "未命名条目");
}

/** 可安装列表过滤：空查询原样返回；否则按 名称/displayName/摘要 大小写不敏感匹配。 */
export function filterInstallable(items: readonly MarketInstallableItem[], query: string): MarketInstallableItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...items];
  return items.filter((item) =>
    `${item.name} ${item.displayName ?? ""} ${item.summary ?? ""}`.toLowerCase().includes(normalized),
  );
}

/** 目录条目过滤（同口径）。 */
export function filterCatalogItems(items: readonly MarketCatalogItem[], query: string): MarketCatalogItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...items];
  return items.filter((item) =>
    `${item.name ?? ""} ${item.displayName ?? ""} ${item.summary ?? ""}`.toLowerCase().includes(normalized),
  );
}

/** 人类可读字节数（B/KB/MB/GB，一位小数）。 */
export function formatMarketSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return `${Math.round(size)} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = size;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

/** sha256 缩略展示（前 12 位，与制品命名口径一致）。 */
export function shortSha256(sha256: string): string {
  return sha256.length > 12 ? sha256.slice(0, 12) : sha256;
}

/**
 * 面板 UI 态判定（D13 抽离自 MarketView 的 JSX 三元链）：loading → error →
 * empty → items。error 态但无 presentation 时按既有 JSX 行为落入 empty/items
 * 分支（load 与 error 由同一 catch 路径成对置位，此处仅为防御性回落）。
 */
export type MarketPanelPhase =
  | { kind: "loading" }
  | { kind: "error"; presentation: MarketErrorPresentation }
  | { kind: "empty" }
  | { kind: "items" };

export function describeMarketPanel(
  load: MarketLoadState,
  error: MarketErrorPresentation | null,
  itemCount: number,
): MarketPanelPhase {
  if (load === "loading") return { kind: "loading" };
  if (load === "error" && error !== null) return { kind: "error", presentation: error };
  if (itemCount === 0) return { kind: "empty" };
  return { kind: "items" };
}

/** 安装按钮态（D13 抽离）：已安装/安装中禁用，标签与禁用条件同源。 */
export interface MarketInstallButtonState {
  disabled: boolean;
  label: string;
}

export function installButtonState(
  item: Pick<MarketInstallableItem, "installed">,
  executing: boolean,
): MarketInstallButtonState {
  if (item.installed) return { disabled: true, label: "已安装" };
  if (executing) return { disabled: true, label: "安装中…" };
  return { disabled: false, label: "安装" };
}

/** 来源状态提示（D13 抽离自 market-state-hint 三元链）：信任锚未配置给精确文案，未就绪返回 null。 */
export function describeMarketSourceHint(state: MarketStateView | null, load: MarketLoadState): string | null {
  if (load !== "ready" || state === null) return null;
  return state.verification.ready ? `源：${state.origin}` : "信任锚未配置：目录验签恒拒，请联系市场管理员";
}

/**
 * 已安装列表的空态/失败态文案（P27）。返回 null = 应当渲染列表本身。
 *
 * 读失败**不得**显示「尚未安装任何插件」——那是一句肯定式假话：旧实现把
 * `loadInstallations` 的 catch 静默降级为 `bundles = []`，于是「读不到」与
 * 「确实没有」在 UI 上不可区分。
 *
 * **有内容一律先渲染列表**（`count > 0` 优先于 load 态）：安装/移除后的刷新会
 * 短暂回到 loading，若按 load 态优先会让已有列表闪成「读取中…」。
 */
export function describeInstalledEmptyMessage(load: MarketLoadState, count: number): string | null {
  if (count > 0) return null;
  if (load === "loading") return "读取已安装列表中…";
  if (load === "error") {
    return "无法读取已安装列表，请稍后重试或重启应用；这不代表没有已安装的插件。";
  }
  return "尚未安装任何插件";
}
