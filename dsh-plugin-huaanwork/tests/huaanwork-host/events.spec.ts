import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { WebSocket } from 'ws'
import {
  createHuaanworkEventHub,
  broadcastHuaanworkEvent,
  HUAANWORK_EVENTS_PATH,
  type HuaanworkEventHub,
} from '../../src/huaanwork-host/events.ts'
import type { RpcEvent } from '../../src/client-huaanwork/rpc-types.ts'

describe('createHuaanworkEventHub', () => {
  let server: Server
  let hub: HuaanworkEventHub
  let wsUrl: string

  beforeAll(async () => {
    hub = createHuaanworkEventHub()
    server = createServer()

    server.on('upgrade', (req, socket, head) => {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (parsed.pathname === HUAANWORK_EVENTS_PATH) {
        hub.server.handleUpgrade(req, socket, head, (ws) => {
          hub.server.emit('connection', ws, req)
        })
      } else {
        socket.destroy()
      }
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })

    const port = (server.address() as AddressInfo).port
    wsUrl = `ws://127.0.0.1:${port}${HUAANWORK_EVENTS_PATH}`
  })

  afterAll(async () => {
    hub.dispose()
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  })

  test('客户端连接即收 sidecar/status ready', async () => {
    const ws = new WebSocket(wsUrl)
    const message = await new Promise<string>((resolve, reject) => {
      ws.on('message', (data) => resolve(data.toString('utf8')))
      ws.on('error', reject)
    })
    ws.close()

    expect(JSON.parse(message)).toEqual({
      event: 'sidecar/status',
      ready: true,
    })
  })

  test('广播事件触达所有活跃连接', async () => {
    const ws1 = new WebSocket(wsUrl)
    const ws2 = new WebSocket(wsUrl)

    // 等待两条连接都收到初始 sidecar/status
    await Promise.all([
      new Promise<void>((resolve) => {
        ws1.once('message', () => resolve())
      }),
      new Promise<void>((resolve) => {
        ws2.once('message', () => resolve())
      }),
    ])

    const testEvent: RpcEvent = {
      event: 'diff',
      text: 'modified src/index.ts',
      sessionId: 'test-session',
    }

    const waitWs1 = new Promise<string>((resolve) => {
      ws1.once('message', (data) => resolve(data.toString('utf8')))
    })
    const waitWs2 = new Promise<string>((resolve) => {
      ws2.once('message', (data) => resolve(data.toString('utf8')))
    })

    hub.broadcast(testEvent)

    const [msg1, msg2] = await Promise.all([waitWs1, waitWs2])
    expect(JSON.parse(msg1)).toEqual(testEvent)
    expect(JSON.parse(msg2)).toEqual(testEvent)

    // 测试全局 broadcastHuaanworkEvent 导出
    const testTokenEvent: RpcEvent = {
      event: 'token',
      text: 'hello',
    }

    const waitToken = new Promise<string>((resolve) => {
      ws1.once('message', (data) => resolve(data.toString('utf8')))
    })

    broadcastHuaanworkEvent(testTokenEvent)

    const tokenMsg = await waitToken
    expect(JSON.parse(tokenMsg)).toEqual(testTokenEvent)

    ws1.close()
    ws2.close()
  })

  test('dispose 终止所有连接并关闭服务器', async () => {
    const freshHub = createHuaanworkEventHub()
    const freshServer = createServer()

    freshServer.on('upgrade', (req, socket, head) => {
      freshHub.server.handleUpgrade(req, socket, head, (ws) => {
        freshHub.server.emit('connection', ws, req)
      })
    })

    await new Promise<void>((resolve) => {
      freshServer.listen(0, '127.0.0.1', () => resolve())
    })

    const freshPort = (freshServer.address() as AddressInfo).port
    const freshWs = new WebSocket(`ws://127.0.0.1:${freshPort}`)

    await new Promise<void>((resolve) => {
      freshWs.once('open', () => resolve())
    })

    const closePromise = new Promise<void>((resolve) => {
      freshWs.on('close', () => resolve())
    })

    freshHub.dispose()
    await closePromise

    await new Promise<void>((resolve, reject) => {
      freshServer.close((err) => (err ? reject(err) : resolve()))
    })
  })
})
