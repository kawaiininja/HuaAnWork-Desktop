import { normalizeTodoEntries } from "@huaanwork/policy/todo";

/**
 * 待办事件的回合归属守卫(实时 `tool/start` 与历史回放共读同一份判据)。
 *
 * 一条 `todo_write` 只属于当前回合的真实用户开启者:锚点必须精确相等,且事件
 * `roundKey` 必填、不小于当前快照的 `roundKey`。`goal` 续轮与完成通知不另插用户条目,
 * 自然落在同一开启者上;无锚用户条目即使数值 `String(id)` 相等也拒绝(QP-M2)。
 */

/** 守卫只需要「开启者」与快照的这两个字段;ChatItem / 历史条目均可直接传入。 */
type TurnTodoItem = { id?: number; kind: string; clientMessageId?: string; roundKey?: number };

/** 本次待办事件的回合归属信息;缺任一字段都 fail closed。 */
export type TodoProjectionEvent = { clientMessageId?: string; roundKey?: number };

export { normalizeTodoEntries };

/**
 * 当前回合已写入的待办快照对应的轮次:取 `currentTurnStart` 之后最后一条带 `roundKey`
 * 的 todo 条目。没有快照(或快照缺轮次)时返回 `undefined`,由调用方放行任何非负轮次。
 */
export function currentSnapshotRoundKey(items: readonly TurnTodoItem[], currentTurnStart: number): number | undefined {
  for (let index = items.length - 1; index >= currentTurnStart; index -= 1) {
    const item = items[index];
    if (item?.kind === "todo" && typeof item.roundKey === "number") return item.roundKey;
  }
  return undefined;
}

/**
 * 该待办事件能否写入当前回合。
 *
 * @param items 当前标签的全部条目,`items[currentTurnStart - 1]` 是本回合开启者
 * @param currentTurnStart 本回合起点(`currentTurnStart(items)`)
 * @param event 实时 `tool/start` 的归属字段
 * @param snapshotRoundKey 本回合已写入待办的轮次(`currentSnapshotRoundKey`)
 * @returns 锚点精确匹配且轮次不早于快照时为 `true`;缺字段一律 `false`
 */
export function shouldApplyTodoEvent(
  items: readonly TurnTodoItem[],
  currentTurnStart: number,
  event: TodoProjectionEvent,
  snapshotRoundKey: number | undefined,
): boolean {
  if (typeof event.clientMessageId !== "string" || typeof event.roundKey !== "number") return false;
  if (snapshotRoundKey !== undefined && event.roundKey < snapshotRoundKey) return false;
  const opener = currentTurnStart > 0 ? items[currentTurnStart - 1] : undefined;
  if (opener?.kind !== "user" || typeof opener.clientMessageId !== "string") return false;
  return opener.clientMessageId === event.clientMessageId;
}
