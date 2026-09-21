export type ShellClassification = "allow-test" | "deny" | "ask";

const TEST_COMMANDS = new Set([
  "cargo test",
  "npm test",
  "pnpm test",
  "yarn test",
  "pytest",
  "python -m pytest",
  "python3 -m pytest",
  "go test",
]);

/** 取 `rm` 之后的短标志位串（去掉 `--` 长标志与非标志词），无 `rm` 时返回空串。 */
function rmShortFlags(command: string): string {
  const words = command.split(/\s+/);
  const rmIndex = words.findIndex((word) => word.toLowerCase() === "rm");
  if (rmIndex === -1) return "";
  return words
    .slice(rmIndex + 1)
    .filter((word) => /^-[^-]/.test(word))
    .join("")
    .toLowerCase();
}

function isRecursiveForcedRm(command: string): boolean {
  const flags = rmShortFlags(command);
  return flags.includes("r") && flags.includes("f");
}

/** 递归或强制的 `rm`（smart 档高危清单用；`rm -rf` 同时命中灾难性检查，deny 优先）。 */
function isRecursiveOrForcedRm(command: string): boolean {
  const flags = rmShortFlags(command);
  return flags.includes("r") || flags.includes("f");
}

export function classifyShell(command: string): ShellClassification {
  const trimmed = command.trim();

  if (/[|&;`$]/.test(trimmed)) return "deny";
  if (/(^|[\/\\\s>])\.git([\/\\\s]|$)/i.test(trimmed)) return "deny";
  if (TEST_COMMANDS.has(trimmed)) return "allow-test";
  if (isRecursiveForcedRm(trimmed)) return "deny";
  if (/\b(curl|wget)\b.*\|/i.test(trimmed)) return "deny";
  if (/\b(mkfs|format|diskutil\s+eraseDisk)\b/i.test(trimmed)) return "deny";

  return "ask";
}

/**
 * 灾难性 shell 命令（三档一致的硬 deny）。分两层，与 ask 档 classifyShell 的 deny
 * 覆盖面中的灾难性子集对齐：
 *  1. 整命令正则（切段前）：管道执行（`curl|wget … |`）、`.git` 路径操作、
 *     `mkfs`/`format`/`diskutil eraseDisk`——管道在切段后消失，必须在整命令上做；
 *  2. 按元字符切段后逐段检查：递归且强制的 `rm`（`rm -rf` 与 `rm -r -f` 同等命中）。
 * 命令替换（`$(…)` / 反引号）的定界符先归一为空白，否则 `$(rm` 不是独立的 `rm` 词会
 * 逃过检查（`echo $(rm -rf ~)` 在 full 档误放）。归一化只收紧 full/smart 档：含 `$`/
 * 反引号的命令在 ask 档本就被 classifyShell 判 deny，故不改变 ask 档行为。
 * 子 shell 形态 `(rm -rf x)` 不在硬 deny 子集内（ask 档 classifyShell 判 ask 而非 deny），
 * 有意不把 `(` 归一化以维持 ask 档逐字节一致。纯解析限制（含元字符的复合命令）不在本
 * 函数内——那是 full 档要放行的一类。
 */
export function isHardDenyShell(command: string): boolean {
  const trimmed = command.trim();
  if (/(^|[\/\\\s>])\.git([\/\\\s]|$)/i.test(trimmed)) return true;
  if (/\b(curl|wget)\b.*\|/i.test(trimmed)) return true;
  if (/\b(mkfs|format|diskutil\s+eraseDisk)\b/i.test(trimmed)) return true;
  // `$(` 与反引号统一替换为空白，让命令替换内的 rm 能被词分割识别。
  const normalized = trimmed.replace(/\$\(|`/g, " ");
  return normalized.split(/[|&;]+/).some((segment) => isRecursiveForcedRm(segment));
}

/** 剥离单/双引号包裹的字面量片段：`echo "do not git push"` 不误判为高危。 */
function stripQuotedLiterals(command: string): string {
  return command.replace(/"[^"]*"|'[^']*'/g, " ");
}

/**
 * 高危 shell 命令（smart 档仍需人工确认）。**只在 classifyShell 返回 `"ask"` 时调用**
 * ——此时命令不含任何元字符，剥离引号后按词边界匹配；不做命令头锚定，故
 * `sudo git push`、`GIT_TERMINAL_PROMPT=0 git push` 等前缀形态照常命中。
 *
 * 已知边界（有意保留，不加固）：
 *  - smart 档 bash 侧 `git checkout <branch>`（切分支）**不拦**：正则无法可靠区分切分支与
 *    恢复文件路径，故只匹配 `git checkout .` / `git checkout --`；与 full 档 bash 侧切分支
 *    旁路取舍并列声明（`git switch` 语义单一故可安全匹配）。
 *  - 引号混淆绕过：`git "push"` 剥离引号后为空、不命中 → smart 档退化为普通命令放行。
 *    后果有限（属 agent 既有权限面），成因是「剥引号」方案的固有代价。
 */
export function isHighRiskShell(command: string): boolean {
  const stripped = stripQuotedLiterals(command);
  if (/\bsudo\b/i.test(stripped)) return true;
  if (/\b(curl|wget)\b/i.test(stripped)) return true;
  if (/\b(npm|pnpm|yarn|cargo)\s+publish\b/i.test(stripped)) return true;
  if (/\bgit\s+push\b/i.test(stripped)) return true;
  if (/\bgit\s+reset\b/i.test(stripped) && /(^|\s)--hard(\s|$)/i.test(stripped)) return true;
  if (/\bgit\s+clean\b/i.test(stripped) && /(^|\s)(-[a-z]*f[a-z]*|--force)(\s|$)/i.test(stripped)) return true;
  if (/\bgit\s+(restore|switch)\b/i.test(stripped)) return true;
  if (/\bgit\s+checkout\s+(\.|--)(\s|$)/i.test(stripped)) return true;
  return isRecursiveOrForcedRm(stripped);
}
