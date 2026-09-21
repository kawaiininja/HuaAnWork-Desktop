import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { defineTool } from "@deepseek-ai/dsh-tools";
import { clampTimeoutMs } from "@huaanwork/policy/agent-catalog";
import { CATALOG_BODY_LIMIT, readCappedText } from "@huaanwork/policy/http-cap";
import { capToolOutput } from "@huaanwork/policy/truncate";

export const name = "huaanwork-agent-tool";
export const inject = ["tools"];

export type AgentCatalogSnapshotItem = {
  name: string;
  source?: string;
  kind?: string;
  entrypointKind?: string;
  enabled?: boolean;
  broken?: { reason: string };
  entrypoint?: { kind: string; url: string };
  timeoutMs?: number;
  argumentsSchema?: unknown;
  description?: string;
};

export type AgentCatalogSnapshot = {
  items: AgentCatalogSnapshotItem[];
};

type PreExecuteDecision = // 上游未导出;已逐字比对 0.1.6-alpha.2:core/tools/src/index.ts:426(PreToolDecision)
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason?: string };

type Context = {
  huaanworkDshHome?: string;
  huaanworkAgentCatalog?: { current: AgentCatalogSnapshot };
  on(
    event: "tools/pre-execute",
    listener: (
      execution: { name: string; arguments: unknown },
      next: () => Promise<PreExecuteDecision>,
    ) => Promise<PreExecuteDecision>,
    prepend?: boolean,
  ): void;
  tools?: {
    register(definition: unknown): () => void;
  };
};

function stringArg(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : "";
}

export function apply(ctx: Context): void {
  ctx.on(
    "tools/pre-execute",
    async (execution, next) => {
      const decision = await next();
      if (decision.kind !== "ask") return decision;
      if (execution.name === "call_host_tool") {
        const toolName = stringArg(execution.arguments, "name");
        return {
          kind: "ask",
          reason: toolName ? `调用公用机小工具「${toolName}」` : "调用公用机小工具",
        };
      }
      return decision;
    },
    true,
  );
}

const SCHEMA_HINT_LIMIT = 1024;

function buildToolDescription(snapshot: AgentCatalogSnapshot): string {
  const tools = (snapshot.items ?? []).filter(
    (item) =>
      item.kind === "tool" &&
      item.enabled === true &&
      !item.broken &&
      (item.entrypoint?.kind === "http" || item.entrypointKind === "http") &&
      Boolean(item.entrypoint?.url),
  );

  if (tools.length === 0) {
    return "调用公用机已挂载的 HTTP 小工具。当前无已启用的公用机小工具。";
  }

  const lines = [
    "调用公用机已挂载的 HTTP 小工具。可用小工具：",
    ...tools.map((t) => {
      let desc = `- ${t.name}`;
      if (t.description) {
        desc += `: ${t.description}`;
      }
      if (t.argumentsSchema && typeof t.argumentsSchema === "object") {
        // schema 序列化进模型上下文必须有上限，避免大 schema 撑爆提示
        const schemaText = JSON.stringify(t.argumentsSchema);
        desc += ` (参数: ${schemaText.length > SCHEMA_HINT_LIMIT ? `${schemaText.slice(0, SCHEMA_HINT_LIMIT)}…` : schemaText})`;
      }
      return desc;
    }),
  ];
  return lines.join("\n");
}

function readCatalogToken(dshHome?: string): string {
  if (!dshHome) return "";
  try {
    const settingsPath = join(dirname(dshHome), "settings.json");
    if (!existsSync(settingsPath)) return "";
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.agents_catalog_token === "string" ? parsed.agents_catalog_token.trim() : "";
  } catch {
    return "";
  }
}

export function registerCallHostTool(
  ctx: unknown,
  snapshot: AgentCatalogSnapshot,
  opts?: { fetchImpl?: typeof fetch },
): (() => void) | undefined {
  const c = ctx as Context;
  if (!c.tools?.register) return undefined;

  const description = buildToolDescription(snapshot);
  const fetcher = opts?.fetchImpl ?? (c as any).fetchImpl ?? globalThis.fetch;

  const tool = defineTool({
    name: "call_host_tool",
    description,
    parameters: {
      name: { type: "string", required: true, description: "已 @ 挂载的小工具短名" },
      arguments: { type: "object", additionalProperties: true, description: "发给公用机的参数对象" },
    },
    output: {
      schema: { type: "json" },
      render: (_args: unknown, value: unknown) => [
        { type: "text" as const, text: (value as any)?.text ?? "" },
      ],
    },
    execute: (async (
      args: { name: string; arguments?: Record<string, unknown> },
      exec: { signal?: AbortSignal },
    ) => {
      const currentSnapshot = c.huaanworkAgentCatalog?.current;
      const currentItems = currentSnapshot?.items ?? [];

      const item = currentItems.find(
        (it) =>
          it.name === args.name &&
          it.kind === "tool" &&
          it.enabled === true &&
          !it.broken &&
          (it.entrypoint?.kind === "http" || it.entrypointKind === "http") &&
          Boolean(it.entrypoint?.url),
      );

      if (!item || !item.entrypoint?.url) {
        const text = "未挂载或不存在的小工具";
        return {
          isError: true,
          text,
          content: [{ type: "text" as const, text }],
        };
      }

      const callerSignal = exec?.signal;
      if (callerSignal?.aborted) {
        const text = `公用机小工具「${args.name}」调用已取消（ABORTED）`;
        return { isError: true, text, content: [{ type: "text" as const, text }] };
      }

      const timeoutMs = clampTimeoutMs(item.timeoutMs);
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = callerSignal
        ? AbortSignal.any([callerSignal, timeoutSignal])
        : timeoutSignal;

      const token = readCatalogToken(c.huaanworkDshHome);
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      try {
        const res = await fetcher(item.entrypoint.url, {
          method: "POST",
          headers,
          body: JSON.stringify({ arguments: args.arguments ?? {} }),
          signal: combinedSignal,
        });

        if (!res.ok) {
          let detail = "";
          try {
            const cappedErr = await readCappedText(res.body, CATALOG_BODY_LIMIT);
            detail = cappedErr.text.trim().slice(0, 500);
          } catch {
            // ignore
          }
          const text = `HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
          return {
            isError: true,
            status: res.status,
            text,
            content: [{ type: "text" as const, text }],
          };
        }

        const capped = await readCappedText(res.body, CATALOG_BODY_LIMIT);
        const output = capToolOutput(capped.text, "");
        const truncated = capped.truncated || output.truncated;

        let parsedJson: unknown = undefined;
        try {
          parsedJson = JSON.parse(capped.text);
        } catch {
          try {
            parsedJson = JSON.parse(output.text);
          } catch {
            // plain text
          }
        }

        if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
          const obj = parsedJson as Record<string, unknown>;
          if (obj.ok === false) {
            const err = obj.error;
            const errorText = typeof err === "string" && err ? err : output.text;
            return {
              isError: true,
              status: res.status,
              text: errorText,
              ...(err !== undefined ? { error: err } : {}),
              truncated,
              content: [{ type: "text" as const, text: errorText }],
            };
          }
          if (obj.ok === true && "result" in obj) {
            return {
              isError: false,
              status: res.status,
              text: output.text,
              result: obj.result,
              truncated,
              content: [{ type: "text" as const, text: output.text }],
            };
          }
        }

        return {
          isError: false,
          status: res.status,
          text: output.text,
          ...(parsedJson !== undefined ? { result: parsedJson } : {}),
          truncated,
          content: [{ type: "text" as const, text: output.text }],
        };
      } catch (error: any) {
        if (callerSignal?.aborted) {
          const text = `公用机小工具「${args.name}」调用已取消（ABORTED）`;
          return { isError: true, text, content: [{ type: "text" as const, text }] };
        }
        if (
          timeoutSignal.aborted ||
          error?.name === "TimeoutError" ||
          (combinedSignal as any).reason?.name === "TimeoutError"
        ) {
          const text = `公用机小工具「${args.name}」调用超时（TIMEOUT）`;
          return { isError: true, text, content: [{ type: "text" as const, text }] };
        }
        const detail = (error?.message ?? String(error)).slice(0, 500);
        const text = `公用机小工具「${args.name}」网络请求失败（TRANSPORT）: ${detail}`;
        return { isError: true, text, content: [{ type: "text" as const, text }] };
      }
    }) as any,
  });

  return c.tools.register(tool);
}
