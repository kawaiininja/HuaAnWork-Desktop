const REGISTRY = Symbol.for('huaanwork.childSessions')

type ChildRegistry = {
  children: Map<string, Set<string>>
  callerSessionId: string | undefined
}

function registry(): ChildRegistry {
  const root = globalThis as typeof globalThis & { [REGISTRY]?: ChildRegistry }
  // skills 插件和 host 是两个打包入口，模块级 Map 会被打成两份。登记表挂在进程全局上，取消才能看见已登记的子会话。
  const existing = root[REGISTRY]
  if (existing) return existing
  const created: ChildRegistry = { children: new Map(), callerSessionId: undefined }
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

/** 用户发送时记下的会话。subagent/start 拿不到 parent 时，子会话登记在这次调用上。 */
export function noteCallerSession(sessionId: string | undefined): void {
  registry().callerSessionId = sessionId
}

export function currentCallerSession(): string | undefined {
  return registry().callerSessionId
}
