import type {
  AgentListItem,
  AgentPackageDetail,
  AgentPackageDetailResult,
  AgentPackageListItem,
  AgentPackageListResult,
  AgentPackagePublishStatus,
  AgentPackageRevocation,
  AgentPackageSummary,
} from "../rpc-types.ts";

/**
 * 智能体包三页签的纯函数与产品文案（Task 8 / M2 Task 12）。
 *
 * 广场页 = 签名广场摘要 + legacy 目录条目；我的智能体页 = 本地包 + 已安装的
 * 广场包 + 已启用的 legacy 条目。两页都先映射成 `AgentPackageCard`，页内搜索、
 * 动作清单与渲染共用同一个形状。
 *
 * M2 的判别只认 `installed === false`（广场未安装签名卡）：`publishStatus` 与
 * `enabled` 都不能推断“未安装”，否则本地卡或已安装卡会掉进安装分支。
 */

/** 详情面板固定提示：脚本只受写沙箱限制，读文件与网络不受限。 */
export const PACKAGE_SANDBOX_WARNING =
  "脚本在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。";

export const PLAZA_EMPTY_TEXT = "暂无可用智能体；请先配置公用机目录。";
/** 目录已配置且非空、但所有条目都已安装时的广场空态(不是“未配置”)。 */
export const PLAZA_ALL_INSTALLED_TEXT = "目录中的智能体都已安装。";
export const MINE_EMPTY_TEXT = "还没有智能体。在会话里说「帮我新建一个智能体」即可创建。";
export const SEARCH_EMPTY_TEXT = "没有匹配的智能体";

/** 发布确认文案：管理员审查 + 签名，绝不会立即上架。 */
export const PUBLISH_CONFIRM_TEXT = "提交后需管理员审查与签名，不会立即上架";
/** 申请下架确认文案：下架只影响分发，安全处置仍由管理员撤销。 */
export const DELIST_CONFIRM_TEXT =
  "下架后广场不再提供下载，已安装副本仍可使用；安全处置请由管理员撤销。";
/** 目录侧确认已下架时的提示（已安装副本保留）。 */
export const DELISTED_NOTICE = "已下架，不再提供下载；已安装副本仍可使用";
/** 网络/超时统一文案：目录不可达不影响本地智能体。 */
export const CATALOG_UNREACHABLE_TEXT = "目录不可达，请稍后重试；本地智能体不受影响";
/** 签名/哈希/结构失败统一文案。 */
export const VERIFY_FAILURE_TEXT = "包校验失败，未安装或未运行。请联系管理员";
/** 签名迁移包的卡片标识。 */
export const MIGRATION_PACKAGE_LABEL = "签名迁移包";
/** 本地包详情的签名栏文案。 */
export const LOCAL_UNSIGNED_LABEL = "本地创建，未签名";
/** 目录包没有可用签名信息时的详情文案（不得冒充本地包）。 */
export const MISSING_SIGNATURE_LABEL = "未提供签名信息";
/** 广场未安装签名卡的详情：签名与文件清单只在安装后可查，不伪造。 */
export const INSTALL_DETAIL_NOTICE = "安装后可查看签名与文件清单";

/** 审查拒绝文案：有原因时按规格带出。 */
export function reviewRejectedText(reason: string | undefined): string {
  return reason !== undefined && reason.trim().length > 0 ? `审查未通过：${reason}` : "审查未通过";
}

/** 已撤销包的运行/详情文案（与宿主 `agentPackageRevokedMessage` 逐字一致）。 */
export function revokedText(revocation: Pick<AgentPackageRevocation, "reason">): string {
  return `该版本已被管理员撤销：${revocation.reason}`;
}

export type AgentPackageCardSource = "local" | "catalog" | "catalog-legacy";

/** 卡片视图形状：本地包、广场签名包、已安装广场包与旧目录智能体共用。 */
export type AgentPackageCard = {
  slug: string;
  displayName: string;
  description: string;
  version: string;
  source: AgentPackageCardSource;
  enabled: boolean;
  broken?: { reason: string };
  /**
   * 仅广场未安装签名卡置 `false`；其余卡（已安装目录卡、本地卡、legacy 卡）
   * 省略该字段。未安装判别只认 `installed === false`。
   */
  installed?: boolean;
  publishStatus?: AgentPackagePublishStatus;
  publishedVersion?: string;
  reviewReason?: string;
  revoked?: AgentPackageRevocation;
  updateAvailable?: boolean;
  /** 广场摘要里的包大小（字节）；只有签名广场卡携带。 */
  size?: number;
  /** 广场摘要的更新时间；未安装签名卡的详情只读摘要，不查磁盘。 */
  updatedAt?: string;
  /** 签名摘要的迁移来源；有值即标“签名迁移包”。 */
  migrationFrom?: string;
  /**
   * 广场签名摘要与本机本地包同 slug：不可安装（会覆盖本地包），只保留详情。
   * 与 `installed === false` 并存——同名不等于已安装。
   */
  conflict?: "local-slug";
};

export type AgentPackageAction =
  | "enable"
  | "disable"
  | "publish"
  | "publish-status"
  | "request-delist"
  | "install"
  | "update"
  | "remove"
  | "detail";

/** 提示条语气：普通提示 / 警告 / 错误。 */
export type PackageNotice = { tone: "note" | "warn" | "error"; text: string };

/** 卡片来源标识。 */
export function packageSourceLabel(source: AgentPackageCardSource): string {
  if (source === "local") return "本地创建";
  if (source === "catalog") return "来自广场";
  return "旧目录智能体";
}

/** 本地包的更新入口：在会话里用 create-agent 的 update 模式。 */
export function updateHintFor(slug: string): string {
  return `在会话里说「/create-agent update ${slug}」可更新此智能体。`;
}

/** 目录条目的展示名：displayName 缺省回落 name。 */
export function catalogAgentLabel(item: Pick<AgentListItem, "name" | "displayName">): string {
  const display = item.displayName?.trim();
  return display && display.length > 0 ? display : item.name;
}

/**
 * 卡片动作清单（M2 规格的唯一事实源）。
 *
 * - 撤销/目录损坏：只能移除与详情（不再提供启停）。
 * - 本地损坏 / legacy 损坏：只允许关闭（已启用时）+ 详情，不能发布或再次启用。
 * - 广场签名摘要与本地包同 slug（`conflict: 'local-slug'`）：只允许详情，
 *   不提供下载——安装会覆盖本地包；也不能伪装成“已安装”。
 * - legacy：启停 + 详情，永不伪造下载。
 * - 广场未安装（`installed === false`）：严格只有下载 + 详情。
 * - 已安装目录包：启停 +（可更新时）更新 + 移除 + 详情；下架后去掉更新。
 * - 本地发布状态：待审查只看状态；被拒只重新提交；已发布可申请下架；
 *   已下架不允许重新上架；默认未发布可发布。
 */
export function packageActions(card: AgentPackageCard): AgentPackageAction[] {
  if (card.revoked || (card.broken && card.source === "catalog")) return ["remove", "detail"];
  // 损坏判定先于 legacy 常规启停：disabled broken 不显示启用，enabled 仍可关闭。
  if (card.broken) return [...(card.enabled ? (["disable"] as const) : []), "detail"];
  if (card.conflict === "local-slug") return ["detail"];
  if (card.source === "catalog-legacy") return [card.enabled ? "disable" : "enable", "detail"];
  if (card.source === "catalog" && card.installed === false) return ["install", "detail"];
  if (card.source === "catalog" && card.publishStatus === "delisted") {
    return [card.enabled ? "disable" : "enable", "remove", "detail"];
  }
  if (card.source === "catalog") {
    return [
      card.enabled ? "disable" : "enable",
      ...(card.updateAvailable ? (["update"] as const) : []),
      "remove",
      "detail",
    ];
  }
  if (card.publishStatus === "pending-review") return ["publish-status", "detail"];
  if (card.publishStatus === "rejected") return ["publish", "detail"];
  if (card.publishStatus === "published") {
    return [card.enabled ? "disable" : "enable", "request-delist", "detail"];
  }
  if (card.publishStatus === "delisted") return [card.enabled ? "disable" : "enable", "detail"];
  return [card.enabled ? "disable" : "enable", "publish", "detail"];
}

/** 动作按钮文案；被拒卡的发布按钮固定为“重新提交”。 */
export function packageActionLabel(action: AgentPackageAction, card: AgentPackageCard): string {
  switch (action) {
    case "enable":
      return "启用";
    case "disable":
      return "关闭";
    case "publish":
      return card.publishStatus === "rejected" ? "重新提交" : "发布";
    case "publish-status":
      return "查看状态";
    case "request-delist":
      return "申请下架";
    case "install":
      return "下载";
    case "update":
      return "更新";
    case "remove":
      return "移除";
    case "detail":
      return "查看详情";
  }
}

/** 发布状态的中文投影（卡片与详情共用）。 */
export function packagePublishStatusLabel(
  status: AgentPackagePublishStatus | undefined,
  extra: { publishedVersion?: string; reviewReason?: string } = {},
): string {
  switch (status) {
    case "pending-review":
      return "待审查";
    case "published":
      return extra.publishedVersion ? `已发布 v${extra.publishedVersion}` : "已发布";
    case "rejected":
      return reviewRejectedText(extra.reviewReason);
    case "delisted":
      return "已下架";
    case "installed":
      return "已安装";
    case "none":
    case undefined:
      return "未发布";
  }
}

/**
 * 卡片的发布/撤销状态行。返回 `undefined` 表示不额外显示。
 *
 * 本地卡只按 `publishStatus`；目录卡先看撤销/损坏/下架，再回落“来自广场”。
 */
export function packageStatusLabel(card: AgentPackageCard): string | undefined {
  if (card.revoked) return `已撤销：${card.revoked.reason}`;
  if (card.broken) return `已损坏：${card.broken.reason}`;
  if (card.source === "catalog") {
    if (card.installed === false) return undefined;
    if (card.publishStatus === "delisted") return "已下架";
    return "来自广场";
  }
  if (card.publishStatus === undefined || card.publishStatus === "none") return undefined;
  return packagePublishStatusLabel(card.publishStatus, card);
}

/** 状态行观感：撤销/损坏/下架/被拒用警告条，其余用徽标。 */
export function packageStatusTone(card: AgentPackageCard): "badge" | "warn" {
  if (card.revoked || card.broken || card.publishStatus === "delisted") return "warn";
  return card.publishStatus === "rejected" ? "warn" : "badge";
}

/** 详情页的发布状态文案：目录包缺省视为已安装，本地包缺省视为未发布。 */
export function packageDetailPublishStatus(
  detail: Pick<AgentPackageDetail, "source" | "publishStatus" | "publishedVersion" | "reviewReason">,
): string {
  if (detail.source === "catalog") {
    return detail.publishStatus === "delisted"
      ? "已下架"
      : packagePublishStatusLabel(detail.publishStatus ?? "installed", detail);
  }
  return packagePublishStatusLabel(detail.publishStatus ?? "none", detail);
}

/** 包大小的可读文本；非法值回空串，避免渲染 NaN。 */
export function formatPackageSize(size: number | undefined): string {
  if (size === undefined || !Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${Math.round(size)} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : String(Math.round(kb))} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : String(Math.round(mb))} MB`;
}

/**
 * 目录/网络失败的用户文案。
 *
 * 宿主的目录客户端已经给出 `目录不可达…` 时原样透传；renderer 只把典型的
 * fetch/超时/断网错误归一成同一句，其余业务错误（撤销、验签、版本冲突）保留
 * 原文，不能被网络文案盖掉。
 */
export function catalogErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  if (message.trim().length === 0) return CATALOG_UNREACHABLE_TEXT;
  if (message.includes(CATALOG_UNREACHABLE_TEXT)) return CATALOG_UNREACHABLE_TEXT;
  return /fetch|networkerror|network error|failed to fetch|timeout|timed out|超时|econn|enotfound|eai_again|socket/i.test(
    message,
  )
    ? CATALOG_UNREACHABLE_TEXT
    : message;
}

/** `agent.packagePublishStatus` 结果的提示条。 */
export function publicationNotice(publication: {
  publishStatus: AgentPackagePublishStatus;
  publishedVersion?: string;
  reviewReason?: string;
}): PackageNotice {
  switch (publication.publishStatus) {
    case "pending-review":
      return { tone: "note", text: "仍在审查中" };
    case "published":
      return {
        tone: "note",
        text: publication.publishedVersion ? `已发布 v${publication.publishedVersion}` : "已发布",
      };
    case "rejected":
      return { tone: "error", text: reviewRejectedText(publication.reviewReason) };
    case "delisted":
      return { tone: "warn", text: DELISTED_NOTICE };
    default:
      return { tone: "note", text: `当前状态：${publication.publishStatus}` };
  }
}

function localPackageCard(item: AgentPackageListItem): AgentPackageCard {
  return {
    slug: item.slug,
    displayName: item.displayName,
    description: item.description,
    version: item.version,
    source: item.source,
    enabled: item.enabled,
    ...(item.broken === undefined ? {} : { broken: item.broken }),
    ...(item.publishStatus === undefined ? {} : { publishStatus: item.publishStatus }),
    ...(item.publishedVersion === undefined ? {} : { publishedVersion: item.publishedVersion }),
    ...(item.reviewReason === undefined ? {} : { reviewReason: item.reviewReason }),
    ...(item.revoked === undefined ? {} : { revoked: item.revoked }),
    ...(item.updateAvailable === undefined ? {} : { updateAvailable: item.updateAvailable }),
  };
}

function catalogAgentCard(item: AgentListItem): AgentPackageCard {
  return {
    slug: item.name,
    displayName: catalogAgentLabel(item),
    description: item.description,
    version: item.version,
    source: "catalog-legacy",
    enabled: item.enabled,
    ...(item.broken === undefined ? {} : { broken: item.broken }),
  };
}

/** 广场摘要卡：签名包但本机未安装，严格只走下载/详情。 */
function catalogPackageCard(summary: AgentPackageSummary): AgentPackageCard {
  return {
    slug: summary.slug,
    displayName: summary.displayName,
    description: summary.description,
    version: summary.version,
    source: "catalog",
    enabled: false,
    installed: false,
    size: summary.size,
    updatedAt: summary.updatedAt,
    ...(summary.migrationFrom === undefined || summary.migrationFrom.length === 0
      ? {}
      : { migrationFrom: summary.migrationFrom }),
  };
}

/**
 * 广场卡片：签名摘要优先，legacy 目录条目随后。
 *
 * 只有 `source === 'catalog'` 的已安装记录才抑制同名摘要——本地包与目录包可以
 * 同 slug 共存，本地同名只表示这份摘要不可安装，不能把摘要藏起来谎称“已安装”。
 * 这类摘要卡保留并标 `conflict: 'local-slug'`（动作只剩详情）。
 *
 * 签名包的 `slug` 或 `migrationFrom` 已覆盖的 legacy 条目不再重复显示
 * （迁移包的签名卡带 `migrationFrom`，标“签名迁移包”）；已安装包的覆盖
 * 同样生效，避免旧目录条目在广场里借尸还魂。
 */
export function plazaCards(
  result: Pick<AgentPackageListResult, "catalogAgents" | "catalogPackages" | "packages">,
): AgentPackageCard[] {
  const installedCatalogSlugs = new Set(
    result.packages.filter((item) => item.source === "catalog").map((item) => item.slug),
  );
  const localSlugs = new Set(
    result.packages.filter((item) => item.source === "local").map((item) => item.slug),
  );
  const summaries = result.catalogPackages;
  const signed = summaries
    .filter((summary) => !installedCatalogSlugs.has(summary.slug))
    .map((summary) => ({
      ...catalogPackageCard(summary),
      ...(localSlugs.has(summary.slug) ? { conflict: "local-slug" as const } : {}),
    }));
  const claimed = new Set<string>();
  for (const summary of summaries) {
    claimed.add(summary.slug);
    if (summary.migrationFrom !== undefined && summary.migrationFrom.length > 0) {
      claimed.add(summary.migrationFrom);
    }
  }
  const legacy = result.catalogAgents
    .filter((item) => item.kind === "agent" && !claimed.has(item.name))
    .map(catalogAgentCard);
  return [...signed, ...legacy];
}

/**
 * 广场空态文案（M2 Task 11）：查询优先；有卡不显示空态；只有“目录里的每一条
 * 摘要都已经作为 catalog 包安装”时才说“都已安装”。本地同名冲突不算已安装，
 * 否则会把“无法安装”误报成“全部装好了”。
 */
export function plazaEmptyText(
  result: Pick<AgentPackageListResult, "catalogPackages" | "packages">,
  cardCount: number,
  query: string,
): string {
  if (query.trim().length > 0) return SEARCH_EMPTY_TEXT;
  if (cardCount > 0) return "";
  const installedCatalogSlugs = new Set(
    result.packages.filter((item) => item.source === "catalog").map((item) => item.slug),
  );
  const allInstalled =
    result.catalogPackages.length > 0
    && result.catalogPackages.every((summary) => installedCatalogSlugs.has(summary.slug));
  return allInstalled ? PLAZA_ALL_INSTALLED_TEXT : PLAZA_EMPTY_TEXT;
}

/**
 * 我的智能体卡片：本地包 + 已安装的广场包（都在 `packages` 里）+ 已启用的
 * legacy 条目。legacy 条目若与包行同 slug（迁移后的旧名）不重复显示。
 */
export function mineCards(
  result: Pick<AgentPackageListResult, "packages" | "catalogAgents">,
): AgentPackageCard[] {
  const installedSlugs = new Set(result.packages.map((item) => item.slug));
  const legacy = result.catalogAgents
    .filter(
      (item) => item.kind === "agent" && item.enabled === true && !installedSlugs.has(item.name),
    )
    .map(catalogAgentCard);
  return [...result.packages.map(localPackageCard), ...legacy];
}

/** 页内搜索：空查询原样返回；否则按展示名、slug 与简介大小写不敏感匹配。 */
export function filterPackageTab(
  cards: readonly AgentPackageCard[],
  query: string,
): AgentPackageCard[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...cards];
  return cards.filter((card) =>
    `${card.displayName} ${card.slug} ${card.description}`.toLowerCase().includes(needle),
  );
}

/**
 * `agent.packageDetail` 的两侧载荷收窄：按 `slug`（或 `files`/`skill`）判包详情，
 * 不能用 `source`——legacy 本地工具条目也可能带 `source: 'local'`。
 */
export function isAgentPackageDetail(detail: AgentPackageDetailResult): detail is AgentPackageDetail {
  return "slug" in detail;
}

/** 包工具模式的展示文案。 */
export function packageToolsLabel(tools: AgentPackageDetail["tools"]): string {
  switch (tools) {
    case "none":
      return "无";
    case "http":
      return "HTTP 工具";
    case "mcp":
      return "MCP 工具";
    case "both":
      return "HTTP + MCP 工具";
  }
}
