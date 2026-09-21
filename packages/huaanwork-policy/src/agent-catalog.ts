import { isLanEndpoint } from "./network.ts";

export type AgentKind = "tool" | "agent";
export type EntrypointKind = "http" | "mcp";
export type CatalogEntrypoint = { kind: EntrypointKind; url: string };

export type ParsedCatalogItem = {
  name: string;
  version: string;
  kind: AgentKind;
  description: string;
  whenToUse?: string;
  permissions: string[];
  entrypoint?: CatalogEntrypoint;
  argumentsSchema?: unknown;
  timeoutMs: number;
  allow: string[];
  personaUrl?: string;
  persona?: string;
  broken?: { reason: string };
};

export const DEFAULT_AGENT_ALLOW = ["read", "read_file", "glob", "grep"] as const;

export const AGENT_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 拼装公用机目录的根 URL。
 * host 或 port 任一为空时返回 null；IPv6 主机名自动补方括号。
 */
export function catalogRootUrl(host: string, port: number | ""): string | null {
  const trimmed = host.trim();
  if (!trimmed || port === "") return null;
  const numPort = Number(port);
  if (!Number.isInteger(numPort) || numPort <= 0 || numPort > 65535) return null;
  let formattedHost = trimmed;
  if (formattedHost.includes(":") && !formattedHost.startsWith("[")) {
    formattedHost = `[${formattedHost}]`;
  }
  return `http://${formattedHost}:${numPort}`;
}

/**
 * 约束超时毫秒在 [1000, 150000] 范围内；非法或缺省值回退为 60000。
 */
export function clampTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 60_000;
  }
  return Math.min(150_000, Math.max(1000, Math.round(value)));
}

/**
 * 过滤 agent 子代理允许的工具列表。
 * 非数组回退为 DEFAULT_AGENT_ALLOW；过滤掉 run_code、call_host_tool 以及 mcp__* 前缀项。
 */
export function filterAgentAllow(allow: unknown): string[] {
  if (!Array.isArray(allow)) {
    return [...DEFAULT_AGENT_ALLOW];
  }
  return allow.filter((item): item is string => {
    if (typeof item !== "string") return false;
    if (item === "run_code" || item === "call_host_tool") return false;
    if (item.startsWith("mcp__")) return false;
    return true;
  });
}

/**
 * 解析目录条目。
 * 校验失败项标 broken（保留用于 UI 展示），非对象返回 null。
 */
export function parseCatalogItem(raw: unknown, seenNames?: Set<string>): ParsedCatalogItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;

  let brokenReason: string | undefined;

  const name = typeof obj.name === "string" ? obj.name : "";
  if (!name || !AGENT_NAME_RE.test(name) || name.length > 64) {
    brokenReason = "名称必须匹配 /^[a-z0-9]+(?:-[a-z0-9]+)*$/ 且不超过 64 字符";
  } else if (seenNames?.has(name)) {
    brokenReason = `重名条目：${name}`;
  }

  const rawKind = obj.kind;
  const kind: AgentKind = rawKind === "tool" || rawKind === "agent" ? rawKind : "tool";
  if (rawKind !== "tool" && rawKind !== "agent") {
    if (!brokenReason) brokenReason = "条目类型无效或缺失（必须为 tool 或 agent）";
  }

  const description = typeof obj.description === "string" ? obj.description : "";
  if (!description.trim() || description.length > 1024) {
    if (!brokenReason) brokenReason = "描述缺失或超过 1024 字符";
  }

  let entrypoint: CatalogEntrypoint | undefined;
  if (kind === "tool") {
    const ep = obj.entrypoint;
    if (!ep || typeof ep !== "object" || Array.isArray(ep)) {
      if (!brokenReason) brokenReason = "tool 类型必须指定 entrypoint";
    } else {
      const epObj = ep as Record<string, unknown>;
      const epKind = epObj.kind;
      const epUrl = typeof epObj.url === "string" ? epObj.url : "";

      if (epKind !== "http" && epKind !== "mcp") {
        if (!brokenReason) brokenReason = "entrypoint.kind 必须为 http 或 mcp";
      } else {
        entrypoint = { kind: epKind, url: epUrl };

        if (epKind === "mcp" && name.length > 32) {
          if (!brokenReason) brokenReason = "MCP 工具名称不能超过 32 字符";
        }

        try {
          const u = new URL(epUrl);
          if (u.protocol !== "http:" && u.protocol !== "https:") {
            if (!brokenReason) brokenReason = "entrypoint.url 协议必须是 http 或 https";
          } else if (!isLanEndpoint(epUrl)) {
            if (!brokenReason) brokenReason = "entrypoint.url 必须是局域网或本机地址，禁止公网地址";
          }
        } catch {
          if (!brokenReason) brokenReason = "entrypoint.url 不是合法 URL";
        }
      }
    }
  } else {
    entrypoint = undefined;
  }

  let personaUrl: string | undefined;
  if (typeof obj.personaUrl === "string" && obj.personaUrl) {
    personaUrl = obj.personaUrl;
    try {
      const u = new URL(personaUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        if (!brokenReason) brokenReason = "personaUrl 协议必须是 http 或 https";
      } else if (!isLanEndpoint(personaUrl)) {
        if (!brokenReason) brokenReason = "personaUrl 必须是局域网或本机地址，禁止公网地址";
      }
    } catch {
      if (!brokenReason) brokenReason = "personaUrl 不是合法 URL";
    }
  }

  let argumentsSchema: unknown = undefined;
  if (obj.argumentsSchema && typeof obj.argumentsSchema === "object" && !Array.isArray(obj.argumentsSchema)) {
    argumentsSchema = obj.argumentsSchema;
  }

  const timeoutMs = clampTimeoutMs(obj.timeoutMs);
  const allow = kind === "agent" ? filterAgentAllow(obj.allow) : [];
  const permissions: string[] = Array.isArray(obj.permissions)
    ? obj.permissions.filter((p): p is string => typeof p === "string")
    : [];

  const version = typeof obj.version === "string" ? obj.version : "";
  const whenToUse = typeof obj.whenToUse === "string" ? obj.whenToUse : undefined;
  const persona = typeof obj.persona === "string" ? obj.persona : undefined;

  let broken: { reason: string } | undefined;
  if (brokenReason) {
    broken = { reason: brokenReason };
  } else if (seenNames && name) {
    seenNames.add(name);
  }

  const item: ParsedCatalogItem = {
    name,
    version,
    kind,
    description,
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    permissions,
    ...(entrypoint !== undefined ? { entrypoint } : {}),
    ...(argumentsSchema !== undefined ? { argumentsSchema } : {}),
    timeoutMs,
    allow,
    ...(personaUrl !== undefined ? { personaUrl } : {}),
    ...(persona !== undefined ? { persona } : {}),
    ...(broken !== undefined ? { broken } : {}),
  };

  return item;
}
