export type AgentSource = "catalog" | "local";
export type AgentKind = "tool" | "agent";
export type EntrypointKind = "http" | "mcp";

export type AgentListItem = {
  name: string;
  /** 展示名;本地智能体包带 displayName,目录条目只有 name。 */
  displayName?: string;
  source: AgentSource;
  kind: AgentKind;
  entrypointKind?: EntrypointKind;
  description: string;
  whenToUse?: string;
  version: string;
  permissions: string[];
  enabled: boolean;
  broken?: { reason: string };
};

export type AgentListResult = {
  items: AgentListItem[];
  catalogError?: string;
};

export type AgentDetail = AgentListItem & {
  persona?: string;
  entrypoint?: { kind: EntrypointKind; url: string };
  allow?: string[];
  timeoutMs?: number;
  argumentsSchema?: unknown;
};

export type AgentFieldError = { field: string; message: string };
export type AgentWriteResult = { ok: true } | { ok: false; fieldErrors: AgentFieldError[] };

/** 与 sidecar/policy 的 AGENT_NAME 规则对齐：小写字母/数字/连字符。 */
export const AGENT_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type AtToken = { start: number; end: number; query: string };

/** 光标所在词若是 `@name`，返回该 token；与 `slashTokenAt` 词法对齐。 */
export function atTokenAt(text: string, cursor: number): AtToken | undefined {
  const pos = Math.max(0, Math.min(cursor, text.length));
  let start = pos;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1;
  let end = pos;
  while (end < text.length && !/\s/.test(text[end]!)) end += 1;
  const token = text.slice(start, end);
  if (!token.startsWith("@") || token.startsWith("@@")) return undefined;
  const query = token.slice(1);
  if (!query ? token !== "@" : !/^[a-z0-9-]*$/.test(query)) return undefined;
  return { start, end, query };
}

/** 整段草稿以 `@name` 开头时解析为智能体点名调用。 */
export function parseAtInvoke(text: string): { name: string; remainder: string } | undefined {
  const trimmed = text.trim();
  const match = trimmed.match(/^@([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  return { name: match[1]!, remainder: (match[2] ?? "").trim() };
}

/** 智能体是否可被 `@` 点名：已启用且无破损标记。 */
export function isAgentInvocable(item: AgentListItem): boolean {
  return item.enabled === true && !item.broken;
}

/** 供 `@` 补全列表使用的过滤与排序。 */
export function atAgents(items: readonly AgentListItem[], query: string): AgentListItem[] {
  const needle = query.trim().toLowerCase();
  const matched = items.filter((item) => {
    if (!isAgentInvocable(item)) return false;
    if (!needle) return true;
    return item.name.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle);
  });
  matched.sort((a, b) => {
    const aPrefix = needle && a.name.toLowerCase().startsWith(needle) ? 0 : 1;
    const bPrefix = needle && b.name.toLowerCase().startsWith(needle) ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;
    return a.name.localeCompare(b.name);
  });
  return matched;
}

function isLanIpv4Octets(a: number, b: number, c: number, d: number): boolean {
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;
  // 127.0.0.0/8 回环
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 链路本地
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * 客户端纯函数判定 URL 是否为本机或局域网（不做 DNS，不引入 node:net）。
 * 覆盖：localhost / *.localhost / *.local / 回环 / RFC1918 / 链路本地 / IPv6 ULA / IPv4-mapped IPv6。
 */
export function looksLikeLanUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (!hostname) return false;

  // localhost 与 *.localhost
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }
  // mDNS .local
  if (hostname.endsWith(".local")) {
    return true;
  }

  // IPv4-mapped IPv6：点分十进制形式与十六进制序列化形式（WHATWG URL 规范）
  const dottedMapped = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(hostname);
  if (dottedMapped) {
    const octets = dottedMapped[1]!.split(".").map(Number);
    return isLanIpv4Octets(octets[0]!, octets[1]!, octets[2]!, octets[3]!);
  }
  const hexMapped = /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(hostname);
  if (hexMapped) {
    const high = parseInt(hexMapped[1]!, 16);
    const low = parseInt(hexMapped[2]!, 16);
    return isLanIpv4Octets((high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff);
  }

  // IPv4 普通地址
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4Match) {
    return isLanIpv4Octets(
      Number(ipv4Match[1]),
      Number(ipv4Match[2]),
      Number(ipv4Match[3]),
      Number(ipv4Match[4]),
    );
  }

  // IPv6 回环
  if (hostname === "::1") {
    return true;
  }
  // IPv6 ULA: fc00::/7 (fc.. or fd..)
  if (/^f[cd][0-9a-f]{2}:/.test(hostname)) {
    return true;
  }
  // IPv6 链路本地: fe80::/10 (fe8., fe9., fea., feb.)
  if (/^fe[89ab][0-9a-f]:/.test(hostname)) {
    return true;
  }

  return false;
}

/** 公用机配置表单校验。 */
export function catalogFormErrors(host: string, port: string): Record<string, string> {
  const errors: Record<string, string> = {};
  const trimmedHost = host.trim();
  const trimmedPort = port.trim();

  if (trimmedPort) {
    const portNum = Number(trimmedPort);
    if (!/^\d+$/.test(trimmedPort) || portNum < 1 || portNum > 65535) {
      errors.agents_port = "端口必须是 1–65535 的整数";
    }
  }

  if (trimmedHost && trimmedPort && !errors.agents_port) {
    const hostForUrl = trimmedHost.includes(":") && !trimmedHost.startsWith("[") ? `[${trimmedHost}]` : trimmedHost;
    const testUrl = `http://${hostForUrl}:${trimmedPort}`;
    if (!looksLikeLanUrl(testUrl)) {
      errors.agents_host = "公用机地址必须是本机或局域网（含 .local），禁止公网主机名";
    }
  }

  return errors;
}

/** 登记调试入口表单校验。description / argumentsSchema 为选填的原始文本。 */
export function endpointFormErrors(
  values: {
    name: string;
    url: string;
    kind: "tool" | "agent";
    entrypointKind: "http" | "mcp";
    description?: string;
    argumentsSchema?: string;
  },
  taken: readonly string[],
): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!values.name.trim()) {
    errors.name = "名称必填";
  } else if (!AGENT_NAME_RE.test(values.name)) {
    errors.name = "名称需为小写字母/数字/连字符（kebab-case）";
  } else if (values.entrypointKind === "mcp" && values.name.length > 32) {
    errors.name = "MCP 名称不超过 32 字符";
  } else if (values.name.length > 64) {
    errors.name = "名称不超过 64 字符";
  } else if (taken.includes(values.name)) {
    errors.name = "已存在同名入口或智能体";
  }

  if (!values.url.trim()) {
    errors.url = "URL 必填";
  } else if (!looksLikeLanUrl(values.url)) {
    errors.url = "URL 必须是本机或局域网（http/https）地址";
  }

  if (values.description && values.description.trim().length > 200) {
    errors.description = "描述不超过 200 字符";
  }

  const schemaText = values.argumentsSchema?.trim() ?? "";
  if (schemaText) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(schemaText);
    } catch {
      errors.argumentsSchema = "参数 schema 必须是合法 JSON";
    }
    if (!errors.argumentsSchema && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
      errors.argumentsSchema = "参数 schema 必须是 JSON 对象";
    }
  }

  return errors;
}

/** 智能体页三页签：广场 / 我的智能体 / 我的工具包。各页数据形状不同,过滤在面板内做。 */
export type AgentTab = "plaza" | "mine" | "tools";

/** 三页签的 id 与可见文案;`AgentsView` 只负责渲染与切换。 */
export const AGENT_TABS: ReadonlyArray<{ id: AgentTab; label: string }> = [
  { id: "plaza", label: "智能体广场" },
  { id: "mine", label: "我的智能体" },
  { id: "tools", label: "我的工具包" },
];
