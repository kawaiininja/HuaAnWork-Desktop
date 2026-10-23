/**
 * `subagents` 服务的解析(智能体包与 legacy `@agent` 分发共用)。
 *
 * Host 侧拿到的 Context 是跨插件传递的 duck-type 视图:Cordis 的服务属性沿
 * fiber 链解析,这个视图上 `ctx.subagents` 可能缺席,而 `ctx.get` 直接读全局
 * 服务表。两条路都要看;能力优先——调用方声明自己要调用的方法,直接属性只有
 * 在该方法可调用时才优先(技能护栏把两个入口的包装装在那份属性上,存在时它
 * 才是接管 `@slug` 回合的那一版);否则回落到 `ctx.get('subagents')`。这样
 * 一个只带 `start` 的直接属性不会遮住全局服务上的 `startActivation`,反之亦然。
 */

/** `subagents.start` 的旧签名(`start(provider, request)`);rc.1 运行时已删除该方法。 */
export type SubagentsStart = (
  provider: string,
  request: {
    prompt: Array<{ type: string; text: string }>
    persona?: string
    parent?: unknown
    signal?: AbortSignal
    [key: string]: unknown
  },
) => Promise<unknown>

/**
 * rc.1 `SubagentActivationSpec` 的宿主侧视图:唯一的启动入口。
 *
 * `request` 是 `SubagentStartRequest` 去掉 `label`/`signal` 后的部分,没有
 * `persona` 字段;`parent` 必须是 `ctx.agents` 里的同一个活动 Agent 对象。
 */
export type SubagentActivationSpec = {
  provider: string
  label: string
  /**
   * 预留子会话 id:任何实现 `prepareContinuable` 的 provider 都接受(spawn 即实现),
   * 服务按它创建子会话。Host 在 activation 之前就按这个 id 预挂载工具与运行时,
   * 首条模型请求要看到它们就依赖该 id 被原样沿用。
   */
  childId?: string
  request: {
    prompt: Array<{ type: string; text: string }>
    parent: unknown
    [key: string]: unknown
  }
  /** 发布前取消;发布后的取消归 `dispose()`。 */
  signal?: AbortSignal
  delivery: 'parent' | 'caller'
}

/** 一次 activation 中宿主消费的成员:子会话 id、结果与释放。 */
export type SubagentActivationHandle = {
  childId: string
  result: Promise<unknown>
  dispose(): Promise<void>
}

/** 可用的 `subagents` 服务面:至少一个启动入口可调用。 */
export type SubagentsService = {
  /** 旧签名;rc.1 的 `SubagentRuntime` 不再提供,保留仅为解析回落的类型面。 */
  start?: SubagentsStart
  /** rc.1 的唯一启动入口,智能体包 `@slug` 与 legacy `@agent` 都走这里。 */
  startActivation?: (spec: SubagentActivationSpec) => Promise<SubagentActivationHandle>
}

/** 解析所需的最小 Context 面:服务属性与全局服务表查找。 */
export type SubagentsContext = {
  subagents?: { start?: unknown; startActivation?: unknown }
  get?: (name: string) => unknown
}

/** 调用方要使用的启动入口;解析结果保证该成员可调用。 */
export type SubagentsStartMethod = 'start' | 'startActivation'

/** 已确认提供指定启动入口的服务面。 */
export type ResolvedSubagents<M extends SubagentsStartMethod> = SubagentsService & {
  [K in M]-?: NonNullable<SubagentsService[K]>
}

function provides<M extends SubagentsStartMethod>(
  value: unknown,
  method: M,
): value is ResolvedSubagents<M> {
  if (typeof value !== 'object' || value === null) return false
  return typeof (value as Record<string, unknown>)[method] === 'function'
}

/**
 * 取得提供指定启动入口的 `subagents` 服务。
 *
 * @param ctx — Host 运行时上下文,只读取 `subagents` 与 `get`。
 * @param method — 调用方即将调用的入口;直接属性缺少它时回落到 `ctx.get('subagents')`。
 * @returns 该入口可调用的服务;两处都拿不到时为 `undefined`,由调用方报
 *   「current dsh runtime does not support subagents」。
 */
export function resolveSubagents<M extends SubagentsStartMethod>(
  ctx: SubagentsContext,
  method: M,
): ResolvedSubagents<M> | undefined {
  if (provides(ctx.subagents, method)) return ctx.subagents
  const found = ctx.get?.('subagents')
  return provides(found, method) ? found : undefined
}
