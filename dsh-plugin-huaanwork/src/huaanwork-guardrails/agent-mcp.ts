import * as defaultMcpClient from "@deepseek-ai/dsh-mcp-client";

import { attachAgentTools, detachAgentTools, type AttachmentMaps } from "./agent-attachments.ts";
import { refreshAgentRestrict } from "./present-as.ts";

export const name = "huaanwork-agent-mcp";
export const inject = ["tools"];

export function apply(_ctx: unknown): void {}

/** The MCP client plugin surface `mountSessionMcp` mounts onto the session context. */
export type McpClientImpl = { apply: Function; inject: string[] };

export type MountSessionMcpOptions = {
  ctx: {
    plugin?: Function;
    tools: { schemas?: Function };
    huaanworkAttachments?: AttachmentMaps;
    /** Reads an optional Cordis service; hand-built test contexts may omit it. */
    get?: (name: string) => unknown;
  };
  sessionId: string;
  serverName: string;
  url: string;
  headers?: Record<string, string>;
  mcpClientImpl?: McpClientImpl; // optional injection seam for testing
};

function asMcpClient(value: unknown): McpClientImpl | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { apply?: unknown };
  return typeof candidate.apply === "function" ? (candidate as McpClientImpl) : undefined;
}

/**
 * Resolves the MCP client plugin: the explicit option, then the optional
 * `mcpClientImpl` service, then the packaged client.
 *
 * The service is read through `ctx.get`. Reading `ctx.mcpClientImpl` as a
 * property throws `cannot get property "mcpClientImpl" without inject` on a
 * real Cordis Context, because only the `tools` service is declared.
 */
function resolveMcpClient(opts: MountSessionMcpOptions): McpClientImpl {
  if (opts.mcpClientImpl) return opts.mcpClientImpl;
  if (typeof opts.ctx.get === "function") {
    try {
      const service = asMcpClient(opts.ctx.get("mcpClientImpl"));
      if (service) return service;
    } catch {
      // An unregistered optional service may throw instead of returning undefined.
    }
  }
  return defaultMcpClient;
}

/**
 * Mounts one MCP server's tools for a session and attaches their names to it.
 *
 * @param opts - Session context, server address, and the optional client seam.
 * @returns Mounted tool names and the disposal that unmounts them.
 */
export async function mountSessionMcp(
  opts: MountSessionMcpOptions,
): Promise<{ names: string[]; dispose: () => Promise<void> }> {
  const client = resolveMcpClient(opts);
  const mcpApply = client.apply;
  const mcpInject = client.inject ?? ["tools"];

  const config = {
    transport: "streamable-http" as const,
    serverName: opts.serverName,
    url: opts.url,
    failOnStartupError: true,
    reconnect: { enabled: false },
    ...(opts.headers ? { headers: opts.headers } : {}),
  };

  const scope: any = typeof opts.ctx.plugin === "function"
    ? await opts.ctx.plugin({ inject: mcpInject, apply: (fiber: any) => mcpApply(fiber, config) })
    : await mcpApply(opts.ctx as any, config);

  const schemas = (typeof opts.ctx.tools?.schemas === "function"
    ? opts.ctx.tools.schemas()
    : []) as Array<{ name?: string }>;
  const prefix = `mcp__${opts.serverName}__`;
  const names: string[] = [];
  for (const s of schemas) {
    if (typeof s?.name === "string" && s.name.startsWith(prefix)) {
      names.push(s.name);
    }
  }

  if (names.length === 0) {
    await scope?.dispose?.();
    throw new Error("MCP 服务「" + opts.serverName + "」未提供任何工具");
  }

  if (opts.ctx.huaanworkAttachments) {
    attachAgentTools(opts.ctx.huaanworkAttachments, opts.sessionId, names);
  }

  refreshAgentRestrict(opts.ctx as any, opts.sessionId);

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (opts.ctx.huaanworkAttachments) {
      detachAgentTools(opts.ctx.huaanworkAttachments, opts.sessionId, names);
    }
    refreshAgentRestrict(opts.ctx as any, opts.sessionId);
    await scope?.dispose?.();
  };

  return { names, dispose };
}
