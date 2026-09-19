/**
 * 无人值守授权（Phase 2）allow 列表构建：创建表单/编辑表单共用的纯函数，方便无 DOM 单测覆盖
 * （项目没有组件测试基座，AutomationsView.tsx 里只做薄的 UI 接线）。
 *
 * 关键约束（review finding 3）：**编辑**已有任务时，若该任务已存的 `unattended.allow`
 * 比硬编码默认列表更窄（例如用户此前通过 API/脚本收窄过），提交时绝不能用默认列表把它冲掉——
 * 要以已存列表为基底，只按 shell 勾选框增删 bash/pwsh。**创建**新任务没有已存列表，
 * 用默认基础列表（只读 + 项目目录内写/编辑）。
 */

const SHELL_TOOLS = ["bash", "pwsh"] as const;

/** 打开无人值守但未显式收窄时的默认基础列表：只读 + 写/编辑，不含 bash/pwsh。 */
export const UNATTENDED_DEFAULT_BASE = ["read", "read_file", "glob", "grep", "edit", "write", "str_replace_editor"];

export function buildUnattendedAllow(params: {
  /** 编辑模式下已存的 allow 列表；创建模式传 undefined。 */
  storedAllow: readonly string[] | undefined;
  /** 「同时允许执行 Shell 命令」勾选框状态。 */
  shellChecked: boolean;
}): string[] {
  const base = params.storedAllow !== undefined
    ? params.storedAllow.filter((tool) => !SHELL_TOOLS.includes(tool as (typeof SHELL_TOOLS)[number]))
    : [...UNATTENDED_DEFAULT_BASE];
  return params.shellChecked ? [...base, ...SHELL_TOOLS] : base;
}
