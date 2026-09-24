/** POST /huaanwork/keep-awake — 54 表外专用 route,不进 ROUTE_TABLE / NATIVE_ROUTES。 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { DesktopRuntime } from '../runtime.ts'
import {
  KEEP_AWAKE_UNAVAILABLE_MESSAGE,
  KeepAwakeUnavailableError,
  callSetKeepAwake,
} from '../host-runtime-bridge.ts'
import { isSameOriginLoopbackRequest } from './loopback.ts'
import { readJsonBody, RouteError } from './routes.ts'

export const KEEP_AWAKE_PATH = '/huaanwork/keep-awake'

/**
 * 响应保持本路由更严的响应头(no-store/nosniff/allow,审计 D-9:统一助手时
 * 不得反向退化);body 读取与错误 envelope(code+message)复用 routes.ts 的
 * 单一实现(M4 评审 C1)。
 */
function finishJson(res: ServerResponse, statusCode: number, value: unknown, allow?: 'POST'): void {
  res.statusCode = statusCode
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  if (allow !== undefined) res.setHeader('allow', allow)
  res.end(JSON.stringify(value))
}

function sendRouteError(res: ServerResponse, error: RouteError, allow?: 'POST'): void {
  finishJson(res, error.status, { error: { code: error.code, message: error.message } }, allow)
}

function isJsonRequest(req: IncomingMessage): boolean {
  return req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

function parseHold(value: unknown): boolean | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 1 || typeof record.hold !== 'boolean') return undefined
  return record.hold
}

/**
 * 同源 loopback POST。窄化 desktopRuntime:缺 setKeepAwake 抛 KeepAwakeUnavailableError。
 * 成功应答是 JSON boolean——true 表示调用后仍持有断言(与旧 set_keep_awake 一致)。
 */
export async function handleKeepAwakeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string | (() => string),
  runtime: DesktopRuntime,
): Promise<void> {
  if (req.method !== 'POST') return sendRouteError(res, new RouteError(405, 'method-not-allowed', 'method not allowed'), 'POST')
  const origin = typeof expectedOrigin === 'function' ? expectedOrigin() : expectedOrigin
  if (!isSameOriginLoopbackRequest(req, origin, true)) {
    return sendRouteError(res, new RouteError(403, 'forbidden', 'forbidden'))
  }
  if (!isJsonRequest(req)) {
    return sendRouteError(res, new RouteError(415, 'unsupported-media-type', 'content type must be application/json'))
  }
  let value: unknown
  try {
    value = await readJsonBody(req)
  } catch (cause) {
    if (cause instanceof RouteError) return sendRouteError(res, cause)
    throw cause
  }
  const hold = parseHold(value)
  if (hold === undefined) return sendRouteError(res, new RouteError(400, 'bad-request', 'invalid keep-awake request'))
  try {
    await callSetKeepAwake(runtime, hold)
  } catch (cause) {
    const named = cause instanceof KeepAwakeUnavailableError
      || (cause instanceof Error && cause.message === KEEP_AWAKE_UNAVAILABLE_MESSAGE)
    if (named) return sendRouteError(res, new RouteError(501, 'keep-awake-unavailable', KEEP_AWAKE_UNAVAILABLE_MESSAGE))
    return sendRouteError(res, new RouteError(500, 'internal-error', 'keep-awake unavailable'))
  }
  finishJson(res, 200, hold)
}

/** 与 huaanwork routes effect 并列登记。exact 优先于 /huaanwork 前缀。 */
export function registerKeepAwakeRoute(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: KEEP_AWAKE_PATH,
    handler: (req, res) => handleKeepAwakeRequest(
      req,
      res,
      () => `http://127.0.0.1:${ctx.webServer.port}`,
      ctx.desktopRuntime,
    ),
  })
}
