/**
 * 保持系统唤醒的持有判定：sidecar 无法 invoke Tauri command，判定驱动放在前端——
 * 由 App 在 automation.list 刷新后计算是否应持有系统防睡眠断言，再调用 Rust command。
 */

/** 判定只关心 enabled 与 schedule.kind，用结构类型而非导入 AutomationInfo 避免不必要的耦合。 */
export type KeepAwakeAutomation = {
  enabled: boolean;
  schedule: { kind: string };
};

/** 设置开关开启，且至少一个启用中的非手动（manual）任务存在时才持有断言。 */
export function shouldHoldKeepAwake(
  keepAwake: boolean,
  automations: readonly KeepAwakeAutomation[],
): boolean {
  if (!keepAwake) return false;
  return automations.some((automation) => automation.enabled === true && automation.schedule.kind !== "manual");
}

/** 对 host 侧 setKeepAwake 的调用形状（api.ts 的 setKeepAwake，注入以便测试）。 */
export type SetKeepAwakeInvoke = (hold: boolean) => Promise<boolean>;

/**
 * keep-awake 断言驱动（M4 评审 D4）。App 的 effect 每次刷新（automation.list 回包、
 * 开关切换等）都会调 refresh(desired)；驱动负责把 desired 变成对 host 的断言：
 *
 * - **confirmed 只在 invoke 成功且期望未变时提交**——失败不提交，下次 refresh（下一
 *   个 automation/widget、run-end 等事件刷新）自然重试，不再因 ref 先提交而楔死。
 * - **期望比较替代 cancelled 标志**——resolve 时若 desired 已被更新的期望取代，结果
 *   一律丢弃（不发状态、不提交），避免 deps 换引用（每次刷新都是新 automations 数组）
 *   触发的 cleanup 丢弃成功回调、留下过期的「不可用」提示。
 * - confirmed 与期望相同则短路不发请求；in-flight 期间重复 refresh 会多发一次幂等
 *   调用（host 侧 powerSaveBlocker 幂等），窗口毫秒级，可接受。
 */
export type KeepAwakeDriver = {
  /** 期望的持有状态变化时调用；同值短路。 */
  refresh(desired: boolean): void;
};

export function createKeepAwakeDriver(
  invoke: SetKeepAwakeInvoke,
  onUnavailable: (unavailable: boolean) => void,
): KeepAwakeDriver {
  let confirmed: boolean | null = null;
  let desired: boolean | null = null;
  return {
    refresh(next: boolean) {
      desired = next;
      if (confirmed === next) return;
      void (async () => {
        try {
          const held = await invoke(next);
          if (desired !== next) return;
          confirmed = next;
          onUnavailable(next && !held);
        } catch {
          if (desired !== next) return;
          onUnavailable(next);
        }
      })();
    },
  };
}
