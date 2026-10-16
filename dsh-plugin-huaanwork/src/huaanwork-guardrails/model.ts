import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  MessageId,
  ToolCallId,
  LlmAdapter,
  LlmError,
  attributionHeaders,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import {
  KNOWN_TOOL_NAMES,
  parseSseToolCalls,
  parseTextProtocol,
  sseEventDelta,
  sseFinishReason,
  ssePayloads,
  textProtocolHoldIndex,
  type ToolCall,
} from "@huaanwork/model";

const PROVIDER = "deepseek-official";
const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
/** 思考模型单次流式生成经常超过 2 分钟，120 秒会把正常回合掐成超时。 */
const REQUEST_TIMEOUT_MS = 600_000;

function resolveSettingsPath(profileDir: string): string {
  return join(profileDir, "huaanwork-settings.json");
}
/**
 * 调用方未指定时的 max_tokens 默认值。思考模式端点（deepseek 思考系）把 reasoning
 * 计入完成预算：不填时服务端默认预算（如 4096）会被长思考吃光，正文为空、回合死于
 * EMPTY_RESPONSE。16384 只是上限而非目标值，对本地 OpenAI 兼容端点同样安全。
 */
const DEFAULT_MAX_TOKENS = 16_384;

/**
 * 运行时注册工具放行谓词：dsh-base 静态白名单之外，`call_host_tool`（@ 小工具）与
 * `mcp__*`（会话级 MCP 挂载）也是发给模型的 tools schema 里的合法名字。静态过滤会把
 * 模型的这类原生调用静默丢弃，回合「正常结束但任务没做」。执行侧仍有 policy 的
 * attached 检查兜底（未挂载一律 deny），放行解析不扩大权限面。
 */
function isRegisteredToolName(name: string): boolean {
  return KNOWN_TOOL_NAMES.has(name) || name === "call_host_tool" || name.startsWith("mcp__");
}

type ModelSettings = {
  base_url: string;
  model: string;
  api_key: string;
};

type Context = { // 上游未导出;已逐字比对 0.1.6-alpha.2:core/llm/src/index.ts(LlmAdapter 已 import;ctx.llm 无单独类型导出)
  huaanworkProfileDir?: string;
  llm: {
    registerAdapter(providers: string[], adapter: LlmAdapter): unknown;
  };
};

type WireMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
};

export const name = "llm-deepseek";
export const inject = ["llm"];

const CONTINUE_AFTER_REASONING = "请继续完成这一步：需要工具就直接发起工具调用，否则输出正文结果。不要只输出思考。";

type ModelStreamRead = {
  text: string;
  textStarted: boolean;
  emitted: number;
  textIndex: number;
  nextIndex: number;
  reasoning: string;
  payloads: string[];
};

function streamHasOutput(read: ModelStreamRead): boolean {
  if (read.text.length > 0) return true;
  if (parseSseToolCalls(read.payloads, isRegisteredToolName).length > 0) return true;
  return parseTextProtocol(read.text, isRegisteredToolName) !== null;
}

function continueAfterReasoning(options: GenerateOptions, reasoning: string): GenerateOptions {
  const assistant: GenerateOptions["messages"][number] = {
    id: MessageId("hw-reasoning"),
    role: "assistant",
    content: reasoning.length > 0
      ? [{ type: "reasoning", text: reasoning }]
      : [{ type: "text", text: "" }],
    source: { kind: "model", provider: options.provider, model: options.model },
  };
  const nudge: GenerateOptions["messages"][number] = {
    id: MessageId("hw-continue"),
    role: "user",
    content: [{ type: "text", text: CONTINUE_AFTER_REASONING }],
    source: { kind: "user" },
  };
  return { ...options, messages: [...options.messages, assistant, nudge] };
}

function* finishModelStream(read: ModelStreamRead): Generator<StreamChunk> {
  const toolCalls = parseSseToolCalls(read.payloads, isRegisteredToolName);
  if (toolCalls.length > 0) {
    yield* emitToolCalls(toolCalls, read.nextIndex);
    return;
  }
  const textCall = parseTextProtocol(read.text, isRegisteredToolName);
  if (textCall) {
    yield* emitToolCalls([textCall], read.nextIndex);
    return;
  }
  yield* emitText(read.text, read.textStarted, read.emitted, read.textIndex, read.nextIndex, sseFinishReason(read.payloads));
}

async function* readModelStream(
  opened: { body: ReadableStream<Uint8Array>; signal: AbortSignal; timeout: AbortSignal },
  callerSignal: AbortSignal | undefined,
): AsyncGenerator<StreamChunk, ModelStreamRead> {
  const payloads: string[] = [];
  let text = "";
  let emitted = 0;
  let textStarted = false;
  let sawNativeToolCall = false;
  let reasoning = "";
  let reasoningStarted = false;
  let nextIndex = 0;
  let reasoningIndex = 0;
  let textIndex = 0;

  try {
    for await (const line of readSseLines(opened.body, opened.signal)) {
      const [payload] = ssePayloads([line]);
      if (payload === undefined) continue;
      payloads.push(payload);
      const delta = sseEventDelta(payload);
      if (delta.hasToolCalls) sawNativeToolCall = true;
      if (delta.reasoning.length > 0) {
        if (!reasoningStarted) {
          reasoningIndex = nextIndex;
          nextIndex += 1;
          yield { type: "block-start", index: reasoningIndex, blockType: "reasoning" };
          reasoningStarted = true;
        }
        reasoning += delta.reasoning;
        yield { type: "reasoning-delta", index: reasoningIndex, text: delta.reasoning };
      }
      if (delta.content.length > 0) text += delta.content;
      if (sawNativeToolCall) continue;

      const safe = text.slice(emitted, textProtocolHoldIndex(text));
      if (safe.length === 0) continue;
      if (!textStarted) {
        textIndex = nextIndex;
        nextIndex += 1;
        yield { type: "block-start", index: textIndex, blockType: "text" };
        textStarted = true;
      }
      yield { type: "text-delta", index: textIndex, text: safe };
      emitted += safe.length;
    }
  } catch (error) {
    if (callerSignal?.aborted) throw new LlmError("HuaAnWork model request aborted by caller", "ABORTED", { cause: error });
    if (opened.timeout.aborted) {
      throw new LlmError(`HuaAnWork model request timed out after ${REQUEST_TIMEOUT_MS}ms`, "TIMEOUT", { cause: error });
    }
    throw error;
  }

  if (reasoningStarted) {
    yield { type: "block-end", index: reasoningIndex, block: { type: "reasoning", text: reasoning } };
  }
  return { text, textStarted, emitted, textIndex, nextIndex, reasoning, payloads };
}

export class HuaAnWorkAdapter extends LlmAdapter {
  constructor(private readonly profileDir?: string) {
    super();
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: "HuaAnWork" };
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const entries = loadModelEntries(this.profileDir);
    if (entries.length === 0) {
      const id = loadSettings(this.profileDir).model || "local";
      return [{ provider, id, name: id, inputModalities: ["text"] }];
    }
    return entries.map((entry) => {
      const id = entry.model || entry.id;
      return { provider, id, name: entry.name || id, inputModalities: ["text"] as const };
    });
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ["text"],
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const settings = loadSettings(this.profileDir);
    const first = yield* readModelStream(await openCompletions(options, settings), options.signal);
    if (streamHasOutput(first) || sseFinishReason(first.payloads) === "length") {
      yield* finishModelStream(first);
      return;
    }
    // deepseek-flash 一类思考模型经常只回 reasoning_content 就 stop。
    // 原请求重试仍是同一份上下文，所以这里带上思考再要一次正文或工具调用。
    const second = yield* readModelStream(
      await openCompletions(continueAfterReasoning(options, first.reasoning), settings),
      options.signal,
    );
    if (streamHasOutput(second)) {
      yield* finishModelStream(second);
      return;
    }
    const reasoning = second.reasoning || first.reasoning;
    if (reasoning.length > 0 && sseFinishReason(second.payloads) !== "length") {
      yield* emitText(reasoning, false, 0);
      return;
    }
    yield* finishModelStream(second.reasoning.length > 0 ? second : first);
  }
}

export function apply(ctx: Context): void {
  ctx.llm.registerAdapter([PROVIDER], new HuaAnWorkAdapter(ctx.huaanworkProfileDir));
}

type StoredModelEntry = {
  id: string;
  name: string;
  base_url: string;
  model: string;
  api_key: string;
};

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function parseStoredEntry(raw: unknown): StoredModelEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const id = asString(rec.id).trim();
  if (!id) return null;
  const model = asString(rec.model);
  return {
    id,
    name: asString(rec.name).trim() || model || id,
    base_url: asString(rec.base_url),
    model,
    api_key: asString(rec.api_key),
  };
}

export function loadModelEntries(profileDir = process.env.HUAANWORK_PROFILE_DIR ?? ""): StoredModelEntry[] {
  if (!profileDir) return [];
  const path = resolveSettingsPath(profileDir);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (!Array.isArray(parsed.models)) return [];
    return parsed.models.map(parseStoredEntry).filter((entry): entry is StoredModelEntry => entry !== null);
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
}

export function loadSettings(profileDir = process.env.HUAANWORK_PROFILE_DIR ?? ""): ModelSettings {
  const defaults: ModelSettings = { base_url: DEFAULT_BASE_URL, model: "", api_key: "" };
  if (!profileDir) return defaults;
  const path = resolveSettingsPath(profileDir);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const entries = Array.isArray(parsed.models)
      ? parsed.models.map(parseStoredEntry).filter((entry): entry is StoredModelEntry => entry !== null)
      : [];
    const activeId = asString(parsed.active_model_id);
    const active = entries.find((entry) => entry.id === activeId) ?? entries[0];
    if (active) {
      return {
        base_url: active.base_url.length > 0 ? active.base_url : defaults.base_url,
        model: active.model,
        api_key: active.api_key,
      };
    }
    return {
      base_url: typeof parsed.base_url === "string" && parsed.base_url.length > 0 ? parsed.base_url : defaults.base_url,
      model: typeof parsed.model === "string" ? parsed.model : defaults.model,
      api_key: typeof parsed.api_key === "string" ? parsed.api_key : defaults.api_key,
    };
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "ENOENT") return defaults;
    throw error;
  }
}

async function openCompletions(
  options: GenerateOptions,
  settings: ModelSettings,
): Promise<{ body: ReadableStream<Uint8Array>; signal: AbortSignal; timeout: AbortSignal }> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const baseUrl = settings.base_url.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...attributionHeaders(),
  };
  if (settings.api_key.length > 0) headers.authorization = `Bearer ${settings.api_key}`;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(serializeRequest(options, settings)),
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw new LlmError("HuaAnWork model request aborted by caller", "ABORTED", { cause: error });
    if (timeout.aborted) {
      throw new LlmError(`HuaAnWork model request timed out after ${REQUEST_TIMEOUT_MS}ms`, "TIMEOUT", { cause: error });
    }
    throw new LlmError(`HuaAnWork model request to ${baseUrl} failed`, "TRANSPORT", { cause: error });
  }

  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 500);
    throw new LlmError(
      `HuaAnWork model error (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      httpErrorCode(response.status),
      { status: response.status },
    );
  }
  if (!response.body) throw new LlmError("HuaAnWork model returned no response body", "EMPTY_RESPONSE");
  return { body: response.body, signal, timeout };
}

async function* readSseLines(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw new LlmError("HuaAnWork model request aborted by caller", "ABORTED");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const nl = buffer.search(/\r?\n/);
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        const crlf = buffer[nl] === "\r" && buffer[nl + 1] === "\n";
        buffer = buffer.slice(nl + (crlf ? 2 : 1));
        yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

function serializeRequest(options: GenerateOptions, settings: ModelSettings): Record<string, unknown> {
  const messages: WireMessage[] = [];
  if (options.system !== undefined) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push(...serializeMessages(options.messages));
  const tools = options.tools?.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
  return {
    model: settings.model || options.model,
    messages,
    stream: true,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    // 思考内容计入完成预算。调用方给的更小上限（如标题生成）会被推理吃光，正文为空。
    max_tokens: Math.max(options.maxTokens ?? 0, DEFAULT_MAX_TOKENS),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  };
}

function serializeMessages(messages: GenerateOptions["messages"]): WireMessage[] {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      wire.push({ role: "system", content: flattenText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = message.content
        .filter((block) => block.type === "tool-call")
        .map((block) => ({
          id: block.id,
          type: "function" as const,
          function: { name: block.name, arguments: block.arguments },
        }));
      const reasoning = message.content
        .filter((block) => block.type === "reasoning")
        .map((block) => block.text)
        .join("");
      wire.push({
        role: "assistant",
        content: flattenText(message.content),
        // 思考模式端点（deepseek 思考系）要求带 tool_calls 的 assistant 消息必须回传
        // reasoning_content，缺失直接 400（空串合法）；纯文本 assistant 消息无此约束。
        ...(reasoning.length > 0 || toolCalls.length > 0 ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    if (message.role === "tool") {
      wire.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: flattenText(message.content) || "(no output)",
      });
      continue;
    }
    const text = flattenText(message.content);
    wire.push({ role: "user", content: text });
  }
  return wire;
}

function flattenText(blocks: GenerateOptions["messages"][number]["content"]): string {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function* emitToolCalls(calls: ToolCall[], startIndex = 0): Generator<StreamChunk> {
  for (const [offset, call] of calls.entries()) {
    const index = startIndex + offset;
    const id = ToolCallId(randomUUID());
    const argumentsJson = JSON.stringify(call.args);
    yield { type: "block-start", index, blockType: "tool-call" };
    yield { type: "tool-call-delta", index, id, name: call.name, argumentsDelta: argumentsJson };
    yield {
      type: "block-end",
      index,
      block: { type: "tool-call", id, name: call.name, arguments: argumentsJson },
    };
  }
  yield { type: "finish", reason: { kind: "tool-calls" } };
}

function* emitText(
  text: string,
  started: boolean,
  emitted: number,
  startedIndex = 0,
  nextIndex = 0,
  finishReason?: string,
): Generator<StreamChunk> {
  const rest = text.slice(emitted);
  const index = started ? startedIndex : nextIndex;
  if (!started && rest.length === 0) {
    const message =
      finishReason === "length"
        ? "model exhausted the max_tokens budget during reasoning and returned no content (finish_reason=length); increase max_tokens or shorten the context"
        : "model returned a completed response with no content";
    yield {
      type: "finish",
      reason: {
        kind: "error",
        failure: { message, code: "EMPTY_RESPONSE" },
      },
    };
    return;
  }
  if (!started) yield { type: "block-start", index, blockType: "text" };
  if (rest.length > 0) yield { type: "text-delta", index, text: rest };
  yield { type: "block-end", index, block: { type: "text", text } };
  yield { type: "finish", reason: { kind: "stop" } };
}

function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status === 400 || status === 413) return "INVALID_REQUEST";
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}
