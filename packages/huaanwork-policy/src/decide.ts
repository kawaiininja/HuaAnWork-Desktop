import fs from "node:fs";

import { resolveInside } from "./paths.ts";
import { classifyShell, isHardDenyShell, isHighRiskShell } from "./shell.ts";

export type ToolCall = {
  name: string;
  args: Record<string, unknown>;
  workspaceRoot: string;
  gitDirty?: boolean;
  attached?: boolean;
};

export type GuardMode = "ask" | "smart" | "full";

type PreExecuteDecision = "allow" | "deny" | "ask";
type GuardDecision = "allow" | "deny";
type Seam = "preExecute" | "guard";

export type ExplainedPreExecute = { decision: PreExecuteDecision; reason?: string };
export type ExplainedGuard = { decision: GuardDecision; reason?: string };

/**
 * 拒绝原因（面向模型的可执行建议，经 bundle 加 huaanwork-policy:/huaanwork-guard: 前缀后
 * 成为工具错误文本）。判定结果本身与原因解耦：加原因不改变任何 allow/ask/deny 判定。
 */
export const REASON_PATH_ESCAPE = "路径越出当前工作区：仅允许访问工作区目录内的文件";
export const REASON_STR_REPLACE =
  "old_str 未在目标文件中唯一匹配（或文件不可读）：请先 read 确认文件内容后重试";
export const REASON_SHELL_ARGS_ARITY = "shell 调用需要且只能携带 command 或 cmd 其中一个参数";
export const REASON_SHELL_ARGS_TYPE = "command/cmd 参数必须是字符串";
export const REASON_SHELL_HARD_DENY =
  "命令命中灾难性硬拒绝规则（curl/wget 接管道、.git 路径操作、mkfs/format/diskutil eraseDisk、rm -rf 等），任何护栏档位都不会执行；请改用安全写法";
export const REASON_SHELL_METACHAR =
  "命令含 shell 元字符（| & ; $ 或反引号），当前护栏档位无法安全解析：请拆成不含元字符的单条命令重试，或请用户在设置中把护栏档位调为 full";
export const REASON_GIT_BRANCH_SWITCH = "git_branch 不接受类似切换分支的参数：请改用 git_switch 工具";
export const REASON_NEEDS_APPROVAL = "该操作需要人工审批且尚未获得批准";

export function reasonToolUnattached(name: string): string {
  return `工具 ${name} 未附加到当前会话：不在可用工具列表内，请改用已附加的工具`;
}

export function reasonShellPlatform(expectedName: string, actualName: string): string {
  return `当前平台应使用 ${expectedName} 工具（而非 ${actualName}）`;
}

export function preExecute(input: ToolCall, mode: GuardMode = "ask"): PreExecuteDecision {
  return preExecuteExplained(input, mode).decision;
}

export function guard(input: ToolCall, mode: GuardMode = "ask"): GuardDecision {
  return guardExplained(input, mode).decision;
}

/** 与 preExecute 判定一致，deny 时附带面向模型的原因与整改建议。 */
export function preExecuteExplained(input: ToolCall, mode: GuardMode = "ask"): ExplainedPreExecute {
  const { result, reason } = decide(input, mode, "preExecute");
  return reason === undefined ? { decision: result } : { decision: result, reason };
}

/** 与 guard 判定一致，deny 时附带原因（含 would-be-ask 的「未获批准」）。 */
export function guardExplained(input: ToolCall, mode: GuardMode = "ask"): ExplainedGuard {
  const { result, reason } = decide(input, mode, "guard");
  return result === "allow" ? { decision: "allow" } : { decision: "deny", ...(reason !== undefined ? { reason } : {}) };
}

type Internal = { result: "allow" | "ask" | "deny"; reason?: string };

const ALLOW: Internal = { result: "allow" };
const ASK: Internal = { result: "ask" };

function deny(reason: string): Internal {
  return { result: "deny", reason };
}

function decide(input: ToolCall, mode: GuardMode, seam: Seam): Internal {
  switch (input.name) {
    case "read":
    case "read_file":
      return pathsAreInside(input, false, false) ? ALLOW : deny(REASON_PATH_ESCAPE);
    case "glob":
    case "grep":
      return pathsAreInside(input, false, true) ? ALLOW : deny(REASON_PATH_ESCAPE);
    case "edit":
    case "write":
      return pathsAreInside(input, true, false) ? ALLOW : deny(REASON_PATH_ESCAPE);
    case "str_replace_editor":
      return validStringReplacement(input) ? ALLOW : deny(REASON_STR_REPLACE);
    case "skill":
    case "todo_write":
    case "propose_plan":
    case "request_input":
    case "exit_plan_mode":
    case "subagent":
    case "git_status":
    case "git_diff":
      return ALLOW;
    // 出网工具：策略层不 ask（避免每次抓取弹审批），门控由 allow_network 总闸
    // 与工具内 isLanEndpoint 判定承担（spec 裁定 3 / policy 增量汇总）。
    case "web_fetch":
    case "screenshot":
      return ALLOW;
    case "bash":
    case "pwsh":
      return decideShell(input, mode, seam);
    case "git_branch":
      return looksLikeBranchSwitch(input.args) ? deny(REASON_GIT_BRANCH_SWITCH) : ALLOW;
    case "git_checkout":
      return input.gitDirty ? checkoutDecision(mode, seam) : ALLOW;
    case "git_commit":
      return mode === "ask" ? askOrDeny(seam) : ALLOW;
    case "git_push":
      return mode === "full" ? ALLOW : askOrDeny(seam);
    case "call_host_tool":
      return input.attached ? (mode === "full" ? ALLOW : askOrDeny(seam)) : deny(reasonToolUnattached(input.name));
    default:
      return input.attached ? (mode === "full" ? ALLOW : askOrDeny(seam)) : deny(reasonToolUnattached(input.name));
  }
}

function pathsAreInside(input: ToolCall, forWrite: boolean, allowMissing: boolean): boolean {
  const candidates = ["path", "file", "file_path", "root"]
    .filter((key) => Object.hasOwn(input.args, key))
    .map((key) => input.args[key]);

  if (candidates.length === 0) return allowMissing;
  return candidates.every(
    (candidate) =>
      typeof candidate === "string" &&
      resolveInside(input.workspaceRoot, candidate, { forWrite }) !== null,
  );
}

function validStringReplacement(input: ToolCall): boolean {
  if (!pathsAreInside(input, true, false)) return false;
  if (typeof input.args.old_str !== "string") return false;

  const candidate = input.args.path ?? input.args.file ?? input.args.file_path;
  if (typeof candidate !== "string") return false;
  const file = resolveInside(input.workspaceRoot, candidate, { forWrite: true });
  if (file === null) return false;

  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  return countOccurrences(contents, input.args.old_str) === 1;
}

function countOccurrences(contents: string, search: string): number {
  if (search === "") return contents.length + 1;

  let count = 0;
  let offset = 0;
  let match = contents.indexOf(search);
  while (match !== -1) {
    count += 1;
    offset = match + search.length;
    match = contents.indexOf(search, offset);
  }
  return count;
}

/** 脏树 git_checkout：smart 与 ask 同询问，仅 full 放行。 */
function checkoutDecision(mode: GuardMode, seam: Seam): Internal {
  return mode === "full" ? ALLOW : askOrDeny(seam);
}

function decideShell(input: ToolCall, mode: GuardMode, seam: Seam): Internal {
  const expectedName = process.platform === "win32" ? "pwsh" : "bash";
  if (input.name !== expectedName) return deny(reasonShellPlatform(expectedName, input.name));

  const hasCommand = Object.hasOwn(input.args, "command");
  const hasCmd = Object.hasOwn(input.args, "cmd");
  if (hasCommand === hasCmd) return deny(REASON_SHELL_ARGS_ARITY);

  const command = hasCommand ? input.args.command : input.args.cmd;
  if (typeof command !== "string") return deny(REASON_SHELL_ARGS_TYPE);

  // 类别①：灾难性命令，三档一致 deny。必须先于 classifyShell——classifyShell 的
  // "deny" 混合了「灾难性」与「解析限制」，两类在 full 档去向不同。
  if (isHardDenyShell(command)) return deny(REASON_SHELL_HARD_DENY);

  const classification = classifyShell(command);
  if (classification === "allow-test") return ALLOW;
  if (classification === "deny") {
    // 类别②：仅剩「含元字符、解析器无法安全分析」的复合命令
    return mode === "full" ? ALLOW : deny(REASON_SHELL_METACHAR);
  }
  // classification === "ask"：单一命令
  if (isHighRiskShell(command)) {
    // 类别③：高危清单
    return mode === "full" ? ALLOW : askOrDeny(seam);
  }
  // 类别④：普通命令
  return mode === "ask" ? askOrDeny(seam) : ALLOW;
}

function looksLikeBranchSwitch(args: Record<string, unknown>): boolean {
  return Object.entries(args).some(
    ([key, value]) =>
      /checkout|switch/i.test(key) ||
      (typeof value === "string" && /(^|\s)(checkout|switch)(\s|$)/i.test(value)),
  );
}

function askOrDeny(seam: Seam): Internal {
  return seam === "preExecute" ? ASK : deny(REASON_NEEDS_APPROVAL);
}
