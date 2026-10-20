/**
 * 命令结果的唯一判定处:实时路径(bridge.ts)与会话日志详情(session-view.ts)共用,
 * 回合结束核对(outcomeCheck.ts)只读它们产出的 command 与 isError。
 *
 * 失败标记取自 @deepseek-ai/dsh-tool-bash rc.1 的 renderResult:每个标记独占一行,
 * 通常位于输出末尾。长输出截断保留头、尾和中间的截断标记,会丢掉中段,
 * 所以标记仍在未截断的结果文本上解析;截断后没保留的标记由调用方补回。
 */

const NONZERO_EXIT = /^\[exit code: (-?\d+)\]$/;
const PREFIX_MARKERS = ["[timed out", "[killed by signal", "[stopped:", "[sandbox: file access denied"];

export function isShellTool(name: string): boolean {
  return name === "bash" || name === "pwsh";
}

/**
 * tool/call.arguments 的两种真实形状：实时事件是已解析对象，会话日志把它序列化成 JSON 字符串。
 * 字符串解析失败时原样返回，让调用方按非对象处理。
 */
export function parseToolArguments(args: unknown): unknown {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/** bash / pwsh 调用的 command 参数;日志里没有退出码,这里也不造一个。 */
export function shellCommandOf(name: string, args: unknown): string | undefined {
  if (!isShellTool(name)) return undefined;
  const parsed = parseToolArguments(args);
  const command = parsed !== null && typeof parsed === "object" ? (parsed as { command?: unknown }).command : undefined;
  return typeof command === "string" && command.trim() ? command : undefined;
}

/** 结果文本里的失败标记行(原样,按出现顺序)。 */
export function failureMarkers(text: string): string[] {
  const markers: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const exit = NONZERO_EXIT.exec(line);
    if (exit ? Number(exit[1]) !== 0 : PREFIX_MARKERS.some((prefix) => line.startsWith(prefix))) markers.push(line);
  }
  return markers;
}

export function resultTextFailed(text: string): boolean {
  return failureMarkers(text).length > 0;
}

/** 对话里工具行的图标：运行中、结束、出错。 */
export function toolRowIcon(card: { status: "start" | "end"; isError?: boolean }): string {
  if (card.status === "start") return "●";
  return card.isError === true ? "✗" : "✓";
}

/** 会话详情工具行的展示上限,与历史参数格(ARGS_MAX_CHARS)一致。 */
const TOOL_LABEL_MAX_CHARS = 200;

/** 历史工具行标签:命令优先、参数兜底;压成一行并限长,避免超长命令撑爆详情。 */
export function toolArgumentLabel(tool: { command?: string; args?: string }): string | undefined {
  for (const candidate of [tool.command, tool.args]) {
    if (typeof candidate !== "string") continue;
    const flat = candidate.replace(/\s+/g, " ").trim();
    if (!flat) continue;
    return flat.length <= TOOL_LABEL_MAX_CHARS ? flat : `${flat.slice(0, TOOL_LABEL_MAX_CHARS)}…`;
  }
  return undefined;
}
