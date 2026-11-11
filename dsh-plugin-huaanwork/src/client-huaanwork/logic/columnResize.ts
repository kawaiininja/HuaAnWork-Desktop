/**
 * 三栏布局的拖拽钳制:左栏与右栏以 px 固定,中栏吃剩余(1fr),
 * 因此三栏总宽恒等于容器宽;本模块只负责让各栏不低于最小宽度。
 * 容器窄于三栏最小宽度之和时,左右栏保持下限、中栏吃剩余(可为低于最小值,
 * 但不为负),由 grid 的 minmax(0,1fr) 保证不溢出。
 */
export const LEFT_MIN_WIDTH = 200;
export const RIGHT_MIN_WIDTH = 280;
export const CENTER_MIN_WIDTH = 320;

/** 左栏拖拽:右栏宽度固定,上限 = 容器 - 中栏最小 - 右栏(无右栏时右栏按 0)。 */
export function clampLeftWidth(requested: number, total: number, right: number, hasRight: boolean): number {
  const max = Math.max(LEFT_MIN_WIDTH, total - CENTER_MIN_WIDTH - (hasRight ? right : 0));
  return Math.min(Math.max(requested, LEFT_MIN_WIDTH), max);
}

/** 右栏拖拽:左栏宽度固定,上限 = 容器 - 中栏最小 - 左栏。 */
export function clampRightWidth(requested: number, total: number, left: number): number {
  const max = Math.max(RIGHT_MIN_WIDTH, total - CENTER_MIN_WIDTH - left);
  return Math.min(Math.max(requested, RIGHT_MIN_WIDTH), max);
}

/**
 * 窗口尺寸变化后的整体重钳制:先保左栏(以右栏下限为其让出空间),
 * 再压右栏到剩余空间,最后按右栏实际值回钳左栏。
 */
export function resolveColumnWidths(input: {
  left: number;
  right: number;
  total: number;
  hasRight: boolean;
}): { left: number; right: number } {
  const { left, right, total, hasRight } = input;
  if (!hasRight) return { left: clampLeftWidth(left, total, 0, false), right: 0 };
  const leftFirst = clampLeftWidth(left, total, RIGHT_MIN_WIDTH, true);
  const rightNext = clampRightWidth(right, total, leftFirst);
  return { left: clampLeftWidth(leftFirst, total, rightNext, true), right: rightNext };
}