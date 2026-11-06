const REGISTRY = Symbol.for('huaanwork.childSessions')

type ChildRegistry = {
  children: Map<string, Set<string>>
}

function registry(): ChildRegistry {
  const root = globalThis as typeof globalThis & { [REGISTRY]?: ChildRegistry }
  // skills 插件和 host 是两个打包入口，模块级 Map 会被打成两份。登记表挂在进程全局上，取消才能看见已登记的子会话。
  const existing = root[REGISTRY]
  if (existing) return existing
  const created: ChildRegistry = { children: new Map() }
  root[REGISTRY] = created
  return created
}

export function registerChildSession(parentSessionId: string, childSessionId: string): void {
  const children = registry().children
  const set = children.get(parentSessionId) ?? new Set<string>()
  set.add(childSessionId)
  children.set(parentSessionId, set)
}

export function childrenOf(parentSessionId: string): readonly string[] {
  return [...(registry().children.get(parentSessionId) ?? [])]
}

/**
 * 沿 `registerChildSession` 的登记表向父级走一层。
 * 调用方传进来的子会话 id 是唯一依据,没有进程级调用槽可回落。
 */
export function parentSessionOf(childSessionId: string): string | undefined {
  for (const [parentSessionId, children] of registry().children) {
    if (children.has(childSessionId)) return parentSessionId
  }
  return undefined
}

/** 父会话删除后不再需要它的子会话名单;重新登记时从空表开始。 */
export function forgetChildSessions(parentSessionId: string): void {
  registry().children.delete(parentSessionId)
}

/** 子会话删除后从所有父会话名单里摘掉,避免取消时命中已经不存在的会话。 */
export function forgetChildSession(childSessionId: string): void {
  const children = registry().children
  for (const [parentSessionId, set] of children) {
    if (!set.delete(childSessionId)) continue
    if (set.size === 0) children.delete(parentSessionId)
  }
}

/** 测试缝：清空进程级子会话登记，避免跨用例残留。 */
export function resetChildSessionRegistry(): void {
  registry().children.clear()
}
