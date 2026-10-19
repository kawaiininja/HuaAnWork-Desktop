import { spawnSync } from "node:child_process";

import { sessionIdOfAgentRef } from "@huaanwork/policy/channels";
import { capToolOutput } from "@huaanwork/policy/truncate";

import { isShellTool, resultTextFailed, shellCommandOf } from "../client-huaanwork/logic/commandOutcome.ts";

type RpcEvent =
  | { event: "token"; text: string; sessionId?: string }
  | { event: "reasoning"; text: string; sessionId?: string; final?: true }
  | {
      event: "tool/start";
      name: string;
      callId?: string;
      sessionId?: string;
      command?: string;
      todos?: { content: string; status: "pending" | "in_progress" | "completed" }[];
    }
  | { event: "tool/end"; name: string; callId?: string; truncated?: boolean; sessionId?: string; isError?: true }
  | { event: "diff"; text: string; sessionId?: string }
  | { event: "compaction/done"; sessionId?: string }
  | { event: "session/end"; ok: boolean; error?: string; cancelled?: boolean; sessionId?: string };

type StreamChunk = {
  type?: string;
  text?: string;
  block?: { type?: string; text?: string };
};

/** dsh 执行对象的 agent 引用：会话身份取 session.id，回落 agent.id（与 host 的 findAgentBySession 同形状）。 */
type AgentRef = { id?: string; session?: { id?: string } };

type ToolExecution = { // 上游未导出;已逐字比对 0.1.6-alpha.2:core/tools/src/index.ts:376
  name: string;
  callId?: string;
  arguments?: unknown;
  agent?: AgentRef;
};

type ToolResult = { // 上游未导出;已逐字比对 0.1.6-alpha.2:core/tools/src/index.ts:579(ToolExecutionResult)
  isError?: boolean;
  value?: unknown;
  content?: readonly { type?: string; text?: string }[];
  error?: { message?: string } | unknown;
  meta?: { truncated?: boolean };
};

type Context = {
  huaanworkWorkspaceRoot?: { current: string };
  huaanworkEmit?: (event: RpcEvent) => void;
  on(event: string, listener: (...args: never[]) => unknown, options?: boolean | { global?: boolean; prepend?: boolean }): void;
};

const DIFF_AFTER = new Set([
  "write",
  "edit",
  "str_replace_editor",
  "git_commit",
  "git_checkout",
  "bash",
  "pwsh",
]);

export const name = "huaanwork-bridge";
export const inject = ["tools"];

export function apply(ctx: Context): void {
  // Agent turns dispatch llm/stream, tools/execute, and agent/status on the
  // agent scope. An unscoped listener does not see those events.
  ctx.on("llm/stream", ((options: unknown, next: () => AsyncIterable<StreamChunk>) =>
    mapTokens(ctx, sessionIdOfOptions(options), purposeOfOptions(options), next())) as never, { global: true });

  ctx.on(
    "tools/execute",
    (async (execution: ToolExecution, next: () => Promise<ToolResult>) => {
      const sessionId = sessionIdOfAgentRef(execution.agent);
      emit(ctx, {
        event: "tool/start",
        name: execution.name,
        ...(execution.callId === undefined ? {} : { callId: execution.callId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...startDetail(execution),
      });
      const result = await next();
      const capped = capResult(result);
      emit(ctx, {
        event: "tool/end",
        name: execution.name,
        ...(execution.callId === undefined ? {} : { callId: execution.callId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(capped.truncated ? { truncated: true } : {}),
        ...(toolFailed(execution.name, result) ? { isError: true as const } : {}),
      });
      if (execution.name === "git_diff") {
        emit(ctx, { event: "diff", text: capped.text, ...(sessionId === undefined ? {} : { sessionId }) });
      } else if (DIFF_AFTER.has(execution.name)) {
        emitGitDiff(ctx, sessionId);
      }
      return { ...result, content: [{ type: "text", text: capped.text }] };
    }) as never,
    { global: true, prepend: true },
  );

  // 压缩收尾信号：compaction/end 只写会话日志，不经 llm/stream。无 error 才算压缩完成，失败不提示。
  ctx.on("session/event", ((session: { id?: string } | undefined, event: { type?: string; data?: { error?: unknown } } | undefined) => {
    if (event?.type !== "compaction/end" || event.data?.error !== undefined) return;
    const sessionId = typeof session?.id === "string" && session.id ? session.id : undefined;
    emit(ctx, { event: "compaction/done", ...(sessionId === undefined ? {} : { sessionId }) });
  }) as never, { global: true });

  ctx.on("agent/status", ((payload: { status?: string; agent?: AgentRef }) => {
    if (payload?.status !== "idle") return;
    const sessionId = sessionIdOfAgentRef(payload.agent);
    emit(ctx, { event: "session/end", ok: true, ...(sessionId === undefined ? {} : { sessionId }) });
  }) as never, { global: true });

  ctx.on("agent/error", ((payload: { error?: unknown; agent?: AgentRef }) => {
    const sessionId = sessionIdOfAgentRef(payload.agent);
    if (isAbortError(payload?.error)) {
      emit(ctx, { event: "session/end", ok: true, cancelled: true, ...(sessionId === undefined ? {} : { sessionId }) });
      return;
    }
    emit(ctx, {
      event: "session/end",
      ok: false,
      error: errorMessage(payload?.error),
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  }) as never, { global: true });
}

async function* mapTokens(
  ctx: Context,
  sessionId: string | undefined,
  purpose: string | undefined,
  stream: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  for await (const chunk of stream) {
    // 非回合流（compaction / session-title 等辅助模型调用）的 text-delta / reasoning 不是回合产出：
    // 照常透传 chunks，但不发 token 或 reasoning 事件——否则会被运行收集器按 sessionId 误归集为该次任务的产出。
    if (purpose === undefined && chunk?.type === "text-delta" && typeof chunk.text === "string" && chunk.text.length > 0) {
      emit(ctx, { event: "token", text: chunk.text, ...(sessionId === undefined ? {} : { sessionId }) });
    }
    if (purpose === undefined && chunk?.type === "reasoning-delta" && typeof chunk.text === "string" && chunk.text.length > 0) {
      emit(ctx, { event: "reasoning", text: chunk.text, ...(sessionId === undefined ? {} : { sessionId }) });
    }
    if (
      purpose === undefined
      && chunk?.type === "block-end"
      && chunk.block?.type === "reasoning"
      && typeof chunk.block.text === "string"
    ) {
      emit(ctx, {
        event: "reasoning",
        text: chunk.block.text,
        final: true,
        ...(sessionId === undefined ? {} : { sessionId }),
      });
    }
    yield chunk;
  }
}

function capResult(result: ToolResult): { text: string; truncated: boolean } {
  const value = objectValue(result.value);
  const stdout = typeof value.stdout === "string" ? value.stdout : contentText(result);
  const stderr = typeof value.stderr === "string" ? value.stderr : errorText(result);
  const alreadyTruncated = value.truncated === true || result.meta?.truncated === true;
  return capToolOutput(stdout, alreadyTruncated ? "" : stderr, alreadyTruncated);
}

function emitGitDiff(ctx: Context, sessionId: string | undefined): void {
  const root = ctx.huaanworkWorkspaceRoot?.current ?? process.cwd();
  try {
    const text = workspaceDiff(root);
    if (text === undefined) return;
    emit(ctx, { event: "diff", text, ...(sessionId === undefined ? {} : { sessionId }) });
  } catch {
    return;
  }
}

function workspaceDiff(root: string): string | undefined {
  const tracked = spawnSync("git", ["diff"], { cwd: root, encoding: "utf8" });
  if (tracked.error) return undefined;
  const parts = [tracked.stdout ?? ""];
  const status = spawnSync("git", ["status", "--porcelain", "-uall"], { cwd: root, encoding: "utf8" });
  if (!status.error) {
    const empty = process.platform === "win32" ? "NUL" : "/dev/null";
    for (const line of (status.stdout ?? "").split(/\r?\n/)) {
      const file = porcelainUntrackedPath(line);
      if (!file) continue;
      const extra = spawnSync("git", ["diff", "--no-index", "--", empty, file], {
        cwd: root,
        encoding: "utf8",
      });
      if (extra.error) continue;
      parts.push(extra.stdout ?? "");
    }
  }
  return parts.join("");
}

function porcelainUntrackedPath(line: string): string | undefined {
  if (!line.startsWith("?? ")) return undefined;
  let path = line.slice(3);
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1).replace(/\\([\\"ntr])/g, (_match, ch: string) => {
      if (ch === "n") return "\n";
      if (ch === "t") return "\t";
      if (ch === "r") return "\r";
      return ch;
    });
  }
  if (!path || path.endsWith("/")) return undefined;
  return path;
}

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);

/** tool/start 的附加信息:todo_write 的待办列表、bash / pwsh 的 command 参数。 */
function startDetail(execution: ToolExecution): Partial<Extract<RpcEvent, { event: "tool/start" }>> {
  const args = objectValue(execution.arguments);
  if (execution.name === "todo_write" && Array.isArray(args.todos)) {
    const todos = args.todos.flatMap((entry) => {
      const todo = objectValue(entry);
      return typeof todo.content === "string" && typeof todo.status === "string" && TODO_STATUSES.has(todo.status)
        ? [{ content: todo.content, status: todo.status as "pending" | "in_progress" | "completed" }]
        : [];
    });
    return { todos };
  }
  const command = shellCommandOf(execution.name, execution.arguments);
  return command === undefined ? {} : { command };
}

/** 工具报错,或 shell 结果文本(未截断)里已带失败标记。capToolOutput 保留头部,标记须在截断前解析。 */
function toolFailed(name: string, result: ToolResult): boolean {
  if (result.isError === true) return true;
  if (!isShellTool(name)) return false;
  const value = objectValue(result.value);
  const text = typeof value.stdout === "string" ? value.stdout : contentText(result);
  return resultTextFailed(`${text}\n${errorText(result)}`);
}

function emit(ctx: Context, event: RpcEvent): void {
  ctx.huaanworkEmit?.(event);
}

/** 从 llm/stream 请求 options 中读取会话 id（agent-loop 请求携带 sessionId）。 */
function sessionIdOfOptions(options: unknown): string | undefined {
  const sessionId = (options as { sessionId?: unknown } | undefined)?.sessionId;
  return typeof sessionId === "string" && sessionId ? sessionId : undefined;
}

/**
 * 从 llm/stream 请求 options 中读取 purpose（dsh-llm GenerateOptions.purpose：
 * 'compaction' | 'session-title'，辅助模型调用携带；普通回合请求不带）。
 * 实测形状见 @deepseek-ai/dsh-llm GenerateOptions（options.purpose 可选字符串）。
 */
function purposeOfOptions(options: unknown): string | undefined {
  const purpose = (options as { purpose?: unknown } | undefined)?.purpose;
  return typeof purpose === "string" && purpose ? purpose : undefined;
}

/** agent 引用的会话身份（session.id 优先，回落 agent.id）已下沉到 @huaanwork/policy/channels。 */
function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function contentText(result: ToolResult): string {
  return (result.content ?? [])
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("");
}

function errorText(result: ToolResult): string {
  if (!result.isError) return "";
  const error = result.error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (code === "ABORTED" || code === "ABORT_ERR") return true;
    const name = (error as { name?: unknown }).name;
    if (name === "AbortError") return true;
  }
  return /abort/i.test(errorMessage(error));
}
