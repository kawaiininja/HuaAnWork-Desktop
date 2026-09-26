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

/** MarketView 页内 tab 联合（形态参照 dsh-community-market MarketSettingsTab，重写为 renderer 实现）。 */
export type MarketTab = "discover" | "installable" | "installed" | "sources";

export const MARKET_TABS: readonly MarketTab[] = ["discover", "installable", "installed", "sources"];

export const MARKET_TAB_LABELS: Record<MarketTab, string> = {
  discover: "发现",
  installable: "可安装",
  installed: "已安装",
  sources: "来源",
};

/** GET /api/huaanwork-market/state —— wrapper 自有形态（round3 R14，不假设上游 MarketStateResponse）。 */
export interface MarketStateView {
  provider: string;
  origin: string;
  verification: { ready: boolean; currentKeyId?: string };
  catalog: { maxAcceptedRevision: number | null };
  desktopActions: { requestRestart: boolean };
}

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
