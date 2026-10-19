/**
 * 命令结果的唯一判定处:实时路径(bridge.ts)与会话日志详情(session-view.ts)共用,
 * 回合结束核对(outcomeCheck.ts)只读它们产出的 command 与 isError。
 *
 * 失败标记取自 @deepseek-ai/dsh-tool-bash rc.1 的 renderResult:每个标记独占一行,
 * 位于输出末尾。长输出被截断时保留尾部,所以必须在未截断的结果文本上解析;
 * HuaAnWork 的 capToolOutput / clipText 保留头部,标记会被切掉。
 */

const NONZERO_EXIT = /^\[exit code: (-?\d+)\]$/;
const PREFIX_MARKERS = ["[timed out", "[killed by signal", "[stopped:", "[sandbox: file access denied"];

export function isShellTool(name: string): boolean {
  return name === "bash" || name === "pwsh";
}

/** bash / pwsh 调用的 command 参数;日志里没有退出码,这里也不造一个。 */
export function shellCommandOf(name: string, args: unknown): string | undefined {
  if (!isShellTool(name)) return undefined;
  const command = args !== null && typeof args === "object" ? (args as { command?: unknown }).command : undefined;
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
