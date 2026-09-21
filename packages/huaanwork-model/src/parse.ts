export type ToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export const KNOWN_TOOL_NAMES = new Set([
  "read",
  "read_file",
  "glob",
  "grep",
  "edit",
  "write",
  "str_replace_editor",
  "bash",
  "pwsh",
  "skill",
  "subagent",
  "todo_write",
  "git_status",
  "git_diff",
  "git_branch",
  "git_checkout",
  "git_commit",
  "git_push",
]);

/**
 * 工具名过滤器：静态白名单之外的运行时注册工具（`call_host_tool`、`mcp__*`）由调用方
 * 通过该谓词补充放行——它们不在 dsh-base 静态清单里，但同样是发给模型的 tools schema
 * 中的合法名字，静默丢弃会让回合「正常结束却什么都没做」。
 */
export type ToolNameFilter = (name: string) => boolean;

const defaultToolNameFilter: ToolNameFilter = (name) => KNOWN_TOOL_NAMES.has(name);

type AccumulatedCall = {
  name?: string;
  arguments: string;
};

/**
 * Concatenate OpenAI-style streaming `tool_calls` deltas from SSE data payloads.
 * Unknown names are skipped and never returned for execution.
 */
export function parseSseToolCalls(chunks: string[], filter: ToolNameFilter = defaultToolNameFilter): ToolCall[] {
  const byIndex = new Map<number, AccumulatedCall>();

  for (const payload of ssePayloads(chunks)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const choices = (parsed as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) continue;

    for (const choice of choices) {
      const delta = choice && typeof choice === "object" ? (choice as { delta?: unknown }).delta : undefined;
      const toolCalls =
        delta && typeof delta === "object" ? (delta as { tool_calls?: unknown }).tool_calls : undefined;
      if (!Array.isArray(toolCalls)) continue;

      for (const call of toolCalls) {
        if (!call || typeof call !== "object") continue;
        const record = call as {
          index?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        };
        const index = typeof record.index === "number" ? record.index : 0;
        const current = byIndex.get(index) ?? { arguments: "" };
        const fn = record.function;
        if (fn && typeof fn === "object") {
          if (typeof fn.name === "string" && fn.name.length > 0) current.name = fn.name;
          if (typeof fn.arguments === "string") current.arguments += fn.arguments;
        }
        byIndex.set(index, current);
      }
    }
  }

  return [...byIndex.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, call]) => {
      const parsed = knownToolCall(call.name, parseArgs(call.arguments), filter);
      return parsed ? [parsed] : [];
    });
}

/**
 * Parse one XML `<tool_call>` or a whole-line `{"tool":"...","args":{...}}`.
 * Unknown names and garbage return null so the caller can treat the text as a final reply.
 */
export function parseTextProtocol(text: string, filter: ToolNameFilter = defaultToolNameFilter): ToolCall | null {
  return parseXmlToolCall(text, filter) ?? parseJsonToolLine(text, filter);
}

/**
 * Index from which `text` may still be XML `<tool_call` or a JSON tool line.
 * Prefix before this index is safe to emit as `text-delta`.
 */
export function textProtocolHoldIndex(text: string): number {
  const xmlOpen = "<tool_call";
  let pos = 0;
  while (pos <= text.length) {
    const nl = newlineIndex(text, pos);
    const lineEnd = nl < 0 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    const trimmed = line.trimStart();
    if (trimmed.length === 0) {
      if (nl < 0) return pos;
      pos = skipNewline(text, nl);
      continue;
    }
    if (trimmed.startsWith("{")) return pos;
    const lt = line.indexOf("<");
    if (lt >= 0) {
      const fromLt = line.slice(lt);
      if (fromLt.startsWith(xmlOpen) || xmlOpen.startsWith(fromLt)) return pos + lt;
    }
    if (nl < 0) break;
    pos = skipNewline(text, nl);
  }
  return text.length;
}

export function sseEventDelta(payload: string): { content: string; reasoning: string; hasToolCalls: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { content: "", reasoning: "", hasToolCalls: false };
  }
  if (!parsed || typeof parsed !== "object") return { content: "", reasoning: "", hasToolCalls: false };
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return { content: "", reasoning: "", hasToolCalls: false };

  let content = "";
  let reasoning = "";
  let hasToolCalls = false;
  for (const choice of choices) {
    const delta = choice && typeof choice === "object" ? (choice as { delta?: unknown }).delta : undefined;
    if (!delta || typeof delta !== "object") continue;
    const record = delta as { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown };
    if (typeof record.content === "string") content += record.content;
    if (typeof record.reasoning_content === "string") reasoning += record.reasoning_content;
    if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) hasToolCalls = true;
  }
  return { content, reasoning, hasToolCalls };
}

export function ssePayloads(chunks: string[]): string[] {
  const payloads: string[] = [];
  for (const chunk of chunks) {
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      const payload = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : trimmed;
      if (!payload || payload === "[DONE]") continue;
      payloads.push(payload);
    }
  }
  return payloads;
}

export function collectSseText(chunks: string[]): string {
  let text = "";
  for (const payload of ssePayloads(chunks)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const choices = (parsed as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) continue;
    for (const choice of choices) {
      const delta = choice && typeof choice === "object" ? (choice as { delta?: unknown }).delta : undefined;
      const content =
        delta && typeof delta === "object" ? (delta as { content?: unknown }).content : undefined;
      if (typeof content === "string") text += content;
    }
  }
  return text;
}

function newlineIndex(text: string, from: number): number {
  const n = text.indexOf("\n", from);
  const r = text.indexOf("\r", from);
  if (n < 0) return r;
  if (r < 0) return n;
  return Math.min(n, r);
}

function skipNewline(text: string, nl: number): number {
  if (text[nl] === "\r" && text[nl + 1] === "\n") return nl + 2;
  return nl + 1;
}

function parseXmlToolCall(text: string, filter: ToolNameFilter): ToolCall | null {
  const match = text.match(/<tool_call\s+name="([^"]+)">([\s\S]*?)<\/tool_call>/);
  if (!match) return null;
  const args: Record<string, unknown> = {};
  const body = match[2] ?? "";
  for (const arg of body.matchAll(/<arg\s+name="([^"]+)">([\s\S]*?)<\/arg>/g)) {
    args[arg[1] ?? ""] = arg[2] ?? "";
  }
  return knownToolCall(match[1], args, filter);
}

function parseJsonToolLine(text: string, filter: ToolNameFilter): ToolCall | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as { tool?: unknown; args?: unknown };
    if (typeof record.tool !== "string") continue;
    if (!record.args || typeof record.args !== "object" || Array.isArray(record.args)) continue;
    const call = knownToolCall(record.tool, record.args as Record<string, unknown>, filter);
    if (call) return call;
  }
  return null;
}

function parseArgs(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function knownToolCall(
  name: string | undefined,
  args: Record<string, unknown> | null,
  filter: ToolNameFilter,
): ToolCall | null {
  if (!name || !filter(name) || args === null) return null;
  return { name, args };
}

/** 取 SSE 流里最后一个非空的 finish_reason（用于区分「思考耗尽 max_tokens」与真空响应）。 */
export function sseFinishReason(chunks: string[]): string | undefined {
  let reason: string | undefined;
  for (const payload of ssePayloads(chunks)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const choices = (parsed as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) continue;
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      const value = (choice as { finish_reason?: unknown }).finish_reason;
      if (typeof value === "string" && value) reason = value;
    }
  }
  return reason;
}
