/**
 * 护栏三档模式的前端纯逻辑：chip 循环切换、持久化回滚、完全访问确认判定。
 * 与 sidecar settings.ts / bundle policy.ts 的 GuardMode 语义保持一致（项目无共享类型包，
 * 三处各自维护同一字面量集合）。
 */
export type GuardMode = "ask" | "smart" | "full";

export const GUARD_MODES: readonly GuardMode[] = ["ask", "smart", "full"];

export const GUARD_MODE_LABELS: Record<GuardMode, { label: string; tooltip: string }> = {
  ask: {
    label: "✋ 修改前询问",
    tooltip: "执行命令、git 提交/推送前都会请求确认（工作区内文件修改本来就自动放行）",
  },
  smart: {
    label: "⚡ 高危才询问",
    tooltip:
      "普通修改和命令直接执行；仅 git push、递归删除、发布、联网下载等高危操作需要确认；含管道/链式的复合命令仍被拒绝",
  },
  full: {
    label: "🚀 完全访问",
    tooltip: "全部操作自动执行；以下仍被拒绝：工作区外读写、切换分支、未注册工具、灾难性命令",
  },
};

/** 白名单解析：合法三值原样返回，其余（含缺失/非法）回落 "ask"（安全方向）。 */
export function parseGuardMode(value: unknown): GuardMode {
  return value === "smart" || value === "full" ? value : "ask";
}

/** composer chip 点击循环：ask → smart → full → ask。 */
export function nextGuardMode(current: GuardMode): GuardMode {
  const index = GUARD_MODES.indexOf(current);
  return GUARD_MODES[(index + 1) % GUARD_MODES.length];
}

/** 每次从其他档切入 full 都需要确认（循环下来必经其他档，故等价于 next === "full"）。 */
export function shouldConfirmFull(next: GuardMode): boolean {
  return next === "full";
}

/**
 * 持久化 guard_mode：成功采用新档；失败回滚到切换前的显示档（磁盘实际值不变）并返回错误文案。
 * persist 注入以便无 DOM 单测覆盖回滚路径。
 */
export async function commitGuardMode(
  current: GuardMode,
  next: GuardMode,
  persist: (mode: GuardMode) => Promise<unknown>,
): Promise<{ mode: GuardMode; error?: string }> {
  try {
    await persist(next);
    return { mode: next };
  } catch (cause) {
    return { mode: current, error: cause instanceof Error ? cause.message : String(cause) };
  }
}
