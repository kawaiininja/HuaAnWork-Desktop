import { WebSocketServer, WebSocket } from 'ws'
import type { RpcEvent } from '../client-huaanwork/rpc-types.ts'

export const HUAANWORK_EVENTS_PATH = '/huaanwork/events'

export interface HuaanworkEventHub {
  readonly server: WebSocketServer
  broadcast(event: RpcEvent): void
  dispose(): void
}

let activeHub: HuaanworkEventHub | undefined

export function broadcastHuaanworkEvent(event: RpcEvent): void {
  activeHub?.broadcast(event)
}

/** 单条 WS 上的事件帧(spec §4.4):连接即补发 sidecar/status ready(替代 M2 的 microtask 重放)。 */
export function createHuaanworkEventHub(): HuaanworkEventHub {
  const wss = new WebSocketServer({ noServer: true })
  const sockets = new Set<WebSocket>()

  wss.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.send(JSON.stringify({ event: 'sidecar/status', ready: true } satisfies RpcEvent))
  })

  const hub: HuaanworkEventHub = {
    server: wss,
    broadcast(event: RpcEvent): void {
      const frame = JSON.stringify(event)
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(frame)
        }
      }
    },
    dispose(): void {
      if (activeHub === hub) activeHub = undefined
      for (const socket of sockets) {
        socket.terminate()
      }
      sockets.clear()
      wss.close()
    },
  }

  activeHub = hub
  return hub
}
