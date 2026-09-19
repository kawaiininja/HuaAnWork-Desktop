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
