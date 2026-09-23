import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, test } from 'vitest'
import type { DesktopRuntime } from '../../src/runtime.ts'
import { KEEP_AWAKE_UNAVAILABLE_MESSAGE } from '../../src/host-runtime-bridge.ts'
import { handleKeepAwakeRequest } from '../../src/huaanwork-host/keep-awake-route.ts'

const ORIGIN = 'http://127.0.0.1:9'

function request(body: unknown, init: { method?: string; origin?: string; contentType?: string } = {}): IncomingMessage {
  const raw = Buffer.from(JSON.stringify(body))
  const req = {
    method: init.method ?? 'POST',
    headers: {
      host: '127.0.0.1:9',
      origin: init.origin ?? ORIGIN,
      'content-type': init.contentType ?? 'application/json',
      'content-length': String(raw.byteLength),
    },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield raw
    },
  }
  return req as unknown as IncomingMessage
}

function capture(): { res: ServerResponse; status: () => number; json: () => unknown } {
  let status = 0
  let raw = ''
  const res = {
    statusCode: 200,
    setHeader() {},
    end(data?: string) {
      status = this.statusCode
      raw = data ?? ''
    },
  }
  return {
    res: res as unknown as ServerResponse,
    status: () => status,
    json: () => JSON.parse(raw) as unknown,
  }
}

describe('POST /huaanwork/keep-awake', () => {
  test('hold true/false 转发并回传是否仍持有', async () => {
    const seen: boolean[] = []
    const runtime = {
      setKeepAwake: async (hold: boolean) => { seen.push(hold) },
    } as unknown as DesktopRuntime
    const held = capture()
    await handleKeepAwakeRequest(request({ hold: true }), held.res, ORIGIN, runtime)
    expect(held.status()).toBe(200)
    expect(held.json()).toBe(true)
    const released = capture()
    await handleKeepAwakeRequest(request({ hold: false }), released.res, ORIGIN, runtime)
    expect(released.status()).toBe(200)
    expect(released.json()).toBe(false)
    expect(seen).toEqual([true, false])
  })

  test('缺 setKeepAwake 抛具名错误并应答 501', async () => {
    const out = capture()
    await handleKeepAwakeRequest(request({ hold: true }), out.res, ORIGIN, {} as DesktopRuntime)
    expect(out.status()).toBe(501)
    expect(out.json()).toEqual({ error: { message: KEEP_AWAKE_UNAVAILABLE_MESSAGE } })
  })

  test('跨源与非 POST 被拒绝', async () => {
    const runtime = { setKeepAwake: async () => {} } as unknown as DesktopRuntime
    const forbidden = capture()
    await handleKeepAwakeRequest(request({ hold: true }, { origin: 'http://evil.example' }), forbidden.res, ORIGIN, runtime)
    expect(forbidden.status()).toBe(403)
    const method = capture()
    await handleKeepAwakeRequest(request({ hold: true }, { method: 'GET' }), method.res, ORIGIN, runtime)
    expect(method.status()).toBe(405)
  })

  test('非法 body 400,不调用 runtime', async () => {
    let called = false
    const runtime = { setKeepAwake: async () => { called = true } } as unknown as DesktopRuntime
    const out = capture()
    await handleKeepAwakeRequest(request({ hold: 'yes' }), out.res, ORIGIN, runtime)
    expect(out.status()).toBe(400)
    expect(called).toBe(false)
  })
})
