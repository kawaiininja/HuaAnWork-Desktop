import * as defaultMcpClient from "@deepseek-ai/dsh-mcp-client";

import { attachAgentTools, detachAgentTools, type AttachmentMaps } from "./agent-attachments.ts";
import { refreshAgentRestrict } from "./present-as.ts";

export const name = "huaanwork-agent-mcp";
export const inject = ["tools"];

export function apply(_ctx: unknown): void {}

export async function mountSessionMcp(opts: {
  ctx: {
    plugin?: Function;
    tools: { schemas?: Function };
    huaanworkAttachments?: AttachmentMaps;
  };
  sessionId: string;
  serverName: string;
  url: string;
  headers?: Record<string, string>;
  mcpClientImpl?: { apply: Function; inject: string[] }; // optional injection seam for testing
}): Promise<{ names: string[]; dispose: () => Promise<void> }> {
  const client = opts.mcpClientImpl ?? (opts.ctx as any)?.mcpClientImpl ?? defaultMcpClient;
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
