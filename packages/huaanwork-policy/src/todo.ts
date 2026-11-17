/** 待办条目的三态;其他取值都是坏条目,不猜测映射。 */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** 结构化待办条目(实时 `todo_write` 与历史 `tool/call` 共用的唯一形状)。 */
export type TodoEntry = { content: string; status: TodoStatus };

const TODO_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/**
 * 把原始 `todo_write.todos` 规范化为结构化条目。
 *
 * - 非数组(含 JSON 字符串、缺字段)返回 `undefined`:调用方保持原行为,不伪造空快照;
 * - 数组逐条过滤坏条目(`content` 非字符串或 `status` 不在三态内),空数组合法。
 */
export function normalizeTodoEntries(value: unknown): TodoEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const todo = entry as { content?: unknown; status?: unknown };
    return typeof todo.content === "string" && typeof todo.status === "string" && TODO_STATUSES.has(todo.status)
      ? [{ content: todo.content, status: todo.status as TodoStatus }]
      : [];
  });
}
