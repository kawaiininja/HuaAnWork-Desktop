import type { RouteContext, RouteHandler, RouteRequest } from './routes.ts'

/**
 * 路由错误面的中立模块。
 *
 * `routes.ts` 在模块初始化时展开 `expertTeamRoutes`,而 `expert-team-routes.ts` 的
 * handler 需要 `RouteError`;两者若互相以值导入会形成运行时环(先加载
 * expert-team-routes 时撞 TDZ)。把错误类型与映射工厂放在这里,routes.ts 继续
 * re-export 两者,既有导入方(workspace.ts、keep-awake-route.ts、market/routes.ts
 * 与测试)无需改动。
 */

export class RouteError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = 'RouteError'
  }
}

/**
 * 统一错误映射 wrapper 工厂 (N1 修复):
 * 旧 sidecar 的 RPC 错误面把用户可读消息(跨工作区拒绝、网络门禁文案、not found、
 * 校验失败等)直传前端;新 HTTP 面对非 RouteError 缺省只回 500 通用文案、
 * 真实错误消息对客户端不可达。
 * 该工厂把底层非 RouteError 的 Error 映射为 HTTP 400 + 指定业务错误码 + 原文字面量,
 * 确保旧用户可读错误面不丢失。非 Error 对象抛出仍放行至 dispatch 500 兜底。
 */
export const errorRoute = (code: string) => (fn: (req: RouteRequest, ctx: RouteContext) => unknown): RouteHandler => {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx)
    } catch (err) {
      if (err instanceof RouteError) throw err
      if (err instanceof Error) throw new RouteError(400, code, err.message)
      throw err
    }
  }
}
