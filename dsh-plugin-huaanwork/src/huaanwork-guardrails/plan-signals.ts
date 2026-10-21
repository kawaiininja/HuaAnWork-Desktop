import { preExecute, type ToolCall } from "@huaanwork/policy";
import { isHardDenyShell } from "@huaanwork/policy/shell";

/** 计划正文里能读出的确认依据。计划是模型写的 Markdown，这里只做保守的文本判读。 */

const OUTBOUND_OR_DELETE = /发送|外发|发邮件|邮件|上传|发布|删除|移除|\b(send|e-?mail|upload|publish|delete|remove|rm)\b/i;
const SHELL_FENCE = /^```(?:sh|bash|zsh|shell|console|pwsh|powershell|ps1)?\s*$/i;

export type PlanEnv = {
  workspaceRoot: string;
  /** 只在计划提到切换分支时才查，避免每次评审都 spawn git。 */
  gitDirty: () => boolean;
  /** 本会话附加的 host / MCP 工具名。 */
  attachedTools: readonly string[];
};

/**
 * smart 档：计划里任一步落在现有 policy 会询问的集合里就要先确认——
 * 高危命令、`git_push`、脏树 `git_checkout`、附加的 host/MCP 工具、外发或删除。
 */
export function declaresAskTool(plan: string, env: PlanEnv): boolean {
  if (OUTBOUND_OR_DELETE.test(plan)) return true;
  const shell = process.platform === "win32" ? "pwsh" : "bash";
  const calls: ToolCall[] = [];
  for (const command of commandCandidates(plan)) {
    if (isHardDenyShell(command)) return true;
    calls.push({ name: shell, args: { command }, workspaceRoot: env.workspaceRoot });
  }
  if (/\bgit[\s_]+push\b|推送/i.test(plan)) calls.push({ name: "git_push", args: {}, workspaceRoot: env.workspaceRoot });
  if (/\bgit[\s_]+checkout\b|切换分支/i.test(plan)) {
    calls.push({ name: "git_checkout", args: {}, workspaceRoot: env.workspaceRoot, gitDirty: env.gitDirty() });
  }
  if (/\bcall_host_tool\b|\bmcp__\w/.test(plan) || env.attachedTools.some((name) => plan.includes(name))) {
    calls.push({ name: "call_host_tool", args: {}, workspaceRoot: env.workspaceRoot, attached: true });
  }
  return calls.some((call) => preExecute(call, "smart") === "ask");
}

export type PlanTarget = { goal: string; recipients: string[]; writeScope: string[] };

/** 目标取首个标题，收件人取邮箱与「收件人」行，写入范围取反引号里的路径。 */
export function planTarget(plan: string): PlanTarget {
  const goal = /^#{1,6}\s+(.+?)\s*$/m.exec(plan)?.[1]?.replace(/\s+/g, " ").toLowerCase() ?? "";
  const recipients = new Set<string>();
  for (const match of plan.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) recipients.add(match[0].toLowerCase());
  for (const match of plan.matchAll(/(?:收件人|抄送|发给)\s*[:：]\s*(.+)/g)) {
    for (const name of match[1]!.split(/[,，、;；\s]+/)) if (name) recipients.add(name.toLowerCase());
  }
  const writeScope = new Set<string>();
  for (const match of plan.matchAll(/`([^`\s]+)`/g)) {
    const span = match[1]!;
    if (/[\\/]/.test(span) || /\.[A-Za-z0-9]{1,8}$/.test(span)) writeScope.add(span);
  }
  return { goal, recipients: [...recipients].sort(), writeScope: [...writeScope].sort() };
}

/** full 档：相对上一份已确认的计划，目标、收件人或写入范围有变就要再确认。没有上一份时不算变化。 */
export function targetChanged(previous: PlanTarget | undefined, next: PlanTarget): boolean {
  if (!previous) return false;
  return previous.goal !== next.goal
    || previous.recipients.join("\n") !== next.recipients.join("\n")
    || previous.writeScope.join("\n") !== next.writeScope.join("\n");
}

function commandCandidates(plan: string): string[] {
  const commands: string[] = [];
  let inShellFence = false;
  let inOtherFence = false;
  for (const line of plan.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      if (inShellFence || inOtherFence) {
        inShellFence = false;
        inOtherFence = false;
      } else if (SHELL_FENCE.test(trimmed)) {
        inShellFence = true;
      } else {
        inOtherFence = true;
      }
      continue;
    }
    if (inShellFence) {
      const command = trimmed.replace(/^\$\s+/, "");
      if (command) commands.push(command);
      continue;
    }
    if (inOtherFence) continue;
    for (const match of line.matchAll(/`([^`]+)`/g)) commands.push(match[1]!.trim());
  }
  return commands;
}
