/**
 * `subagents` 服务的解析(智能体包与 legacy `@agent` 分发共用)。
 *
 * Host 侧拿到的 Context 是跨插件传递的 duck-type 视图:Cordis 的服务属性沿
 * fiber 链解析,这个视图上 `ctx.subagents` 可能缺席,而 `ctx.get` 直接读全局
 * 服务表。两条路都要看;直接属性优先——技能护栏把 `start` 的包装装在那份属性
 * 上,存在时它才是接管 `@slug` 回合的那一版。
 */

/** `subagents.start` 的调用签名(探针 3 核实:`start(provider, request)`)。 */
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

/** 可用的 `subagents` 服务面:`start` 一定可调用。 */
export type SubagentsService = { start: SubagentsStart }

/** 解析所需的最小 Context 面:服务属性与全局服务表查找。 */
export type SubagentsContext = {
  subagents?: { start?: unknown }
  get?: (name: string) => unknown
}

function isSubagentsService(value: unknown): value is SubagentsService {
  return (
    typeof value === 'object' &&
    value !== null &&
    'start' in value &&
    typeof value.start === 'function'
  )
}

/**
 * 取得 `subagents` 服务:直接属性可用时用它,否则回落 `ctx.get('subagents')`。
 *
 * @param ctx — Host 运行时上下文,只读取 `subagents` 与 `get`。
 * @returns 带可调用 `start` 的服务;两处都拿不到时为 `undefined`,由调用方报
 *   「current dsh runtime does not support subagents」。
 */
export function resolveSubagents(ctx: SubagentsContext): SubagentsService | undefined {
  if (isSubagentsService(ctx.subagents)) return ctx.subagents
  const found = ctx.get?.('subagents')
  return isSubagentsService(found) ? found : undefined
}
