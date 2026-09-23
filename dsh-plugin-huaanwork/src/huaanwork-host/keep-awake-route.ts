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

export const KEEP_AWAKE_PATH = '/huaanwork/keep-awake'

const MAX_BODY_BYTES = 4 * 1024

class BodyTooLargeError extends Error {}

function finishJson(res: ServerResponse, statusCode: number, value: unknown, allow?: 'POST'): void {
  res.statusCode = statusCode
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  if (allow !== undefined) res.setHeader('allow', allow)
  res.end(JSON.stringify(value))
}

function isJsonRequest(req: IncomingMessage): boolean {
  return req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength)) throw new SyntaxError('invalid content length')
    if (Number(declaredLength) > MAX_BODY_BYTES) throw new BodyTooLargeError()
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError()
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
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
  if (req.method !== 'POST') return finishJson(res, 405, { error: { message: 'method not allowed' } }, 'POST')
  const origin = typeof expectedOrigin === 'function' ? expectedOrigin() : expectedOrigin
  if (!isSameOriginLoopbackRequest(req, origin, true)) {
    return finishJson(res, 403, { error: { message: 'forbidden' } })
  }
  if (!isJsonRequest(req)) {
    return finishJson(res, 415, { error: { message: 'content type must be application/json' } })
  }
  let value: unknown
  try {
    value = await readJson(req)
  } catch (cause) {
    const tooLarge = cause instanceof BodyTooLargeError
    return finishJson(res, tooLarge ? 413 : 400, {
      error: { message: tooLarge ? 'request body is too large' : 'invalid JSON request' },
    })
  }
  const hold = parseHold(value)
  if (hold === undefined) return finishJson(res, 400, { error: { message: 'invalid keep-awake request' } })
  try {
    await callSetKeepAwake(runtime, hold)
  } catch (cause) {
    if (cause instanceof KeepAwakeUnavailableError) {
      return finishJson(res, 501, { error: { message: KEEP_AWAKE_UNAVAILABLE_MESSAGE } })
    }
    return finishJson(res, 500, { error: { message: 'keep-awake unavailable' } })
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
