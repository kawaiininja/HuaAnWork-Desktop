import type {
  AgentListItem,
  AgentPackageDetail,
  AgentPackageDetailResult,
  AgentPackageListItem,
  AgentPackageListResult,
} from "../rpc-types.ts";

/**
 * 智能体包三页签的纯函数与产品文案（Task 8）。
 *
 * 广场页只看目录快照里的 `kind === 'agent'` 行；我的智能体页 = 本地包 + 已启用的
 * 旧目录智能体。两页都先映射成 `AgentPackageCard`，页内搜索与渲染共用同一个形状。
 */

/** 详情面板固定提示：脚本只受写沙箱限制，读文件与网络不受限。 */
export const PACKAGE_SANDBOX_WARNING =
  "脚本在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。";

export const PLAZA_EMPTY_TEXT = "暂无可用智能体；请先配置公用机目录。";
export const MINE_EMPTY_TEXT = "还没有智能体。在会话里说「帮我新建一个智能体」即可创建。";
export const SEARCH_EMPTY_TEXT = "没有匹配的智能体";

export type AgentPackageCardSource = "local" | "catalog" | "catalog-legacy";

/** 卡片视图形状：本地包、已安装广场包与旧目录智能体共用。 */
export type AgentPackageCard = {
  slug: string;
  displayName: string;
  description: string;
  version: string;
  source: AgentPackageCardSource;
  enabled: boolean;
  broken?: { reason: string };
};

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

function localPackageCard(item: AgentPackageListItem): AgentPackageCard {
  return {
    slug: item.slug,
    displayName: item.displayName,
    description: item.description,
    version: item.version,
    source: item.source,
    enabled: item.enabled,
    ...(item.broken === undefined ? {} : { broken: item.broken }),
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

/** 广场卡片：目录快照中 `kind === 'agent'` 的行，工具条目不在本页签。 */
export function plazaCards(result: Pick<AgentPackageListResult, "catalogAgents">): AgentPackageCard[] {
  return result.catalogAgents.filter((item) => item.kind === "agent").map(catalogAgentCard);
}

/** 我的智能体卡片：全部本地包 + 已启用的旧目录智能体。 */
export function mineCards(
  result: Pick<AgentPackageListResult, "packages" | "catalogAgents">,
): AgentPackageCard[] {
  return [
    ...result.packages.map(localPackageCard),
    ...result.catalogAgents
      .filter((item) => item.kind === "agent" && item.enabled === true)
      .map(catalogAgentCard),
  ];
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
