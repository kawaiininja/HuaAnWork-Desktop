/**
 * `subagents` 服务的解析(智能体包与 legacy `@agent` 分发共用)。
 *
 * Host 侧拿到的 Context 是跨插件传递的 duck-type 视图:Cordis 的服务属性沿
 * fiber 链解析,这个视图上 `ctx.subagents` 可能缺席,而 `ctx.get` 直接读全局
 * 服务表。两条路都要看;直接属性优先——技能护栏把 `startActivation` 的包装装
 * 在那份属性上,存在时它才是接管 `@slug` 回合的那一版。
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
  /** 预留子会话 id;只有本地后端接受,spawn 由 provider 自行分配。 */
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
  /** 旧签名;rc.1 的 `SubagentRuntime` 不再提供,legacy `@agent` 仍按它调用。 */
  start?: SubagentsStart
  /** rc.1 的唯一启动入口,智能体包 `@slug` 回合走这里。 */
  startActivation?: (spec: SubagentActivationSpec) => Promise<SubagentActivationHandle>
}

/** 解析所需的最小 Context 面:服务属性与全局服务表查找。 */
export type SubagentsContext = {
  subagents?: { start?: unknown; startActivation?: unknown }
  get?: (name: string) => unknown
}

function isSubagentsService(value: unknown): value is SubagentsService {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { start?: unknown; startActivation?: unknown }
  return typeof candidate.start === 'function' || typeof candidate.startActivation === 'function'
}

/**
 * 取得 `subagents` 服务:直接属性可用时用它,否则回落 `ctx.get('subagents')`。
 *
 * @param ctx — Host 运行时上下文,只读取 `subagents` 与 `get`。
 * @returns 至少带一条可调用启动入口的服务;两处都拿不到时为 `undefined`,由调用方报
 *   「current dsh runtime does not support subagents」。
 */
export function resolveSubagents(ctx: SubagentsContext): SubagentsService | undefined {
  if (isSubagentsService(ctx.subagents)) return ctx.subagents
  const found = ctx.get?.('subagents')
  return isSubagentsService(found) ? found : undefined
}
