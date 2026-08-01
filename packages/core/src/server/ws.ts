import type { ServerWebSocket, WebSocketHandler } from 'bun'
import { ServerMessageSchema, type ServerMessage } from '@enkaku/protocol'
import type { Logger } from '../util/logger'

export interface WsMessageRouter {
  handleMessage(ws: ServerWebSocket<unknown>, raw: string): Promise<void>
  handleClose(ws: ServerWebSocket<unknown>): void
}

/**
 * Hub WebSocket /ws: broadcast event server→client + routing message
 * client→server ke handler (stream/input/pairing). Client baru TIDAK
 * dikirimi replay snapshot: konsumen GET /api/devices dulu, baru subscribe.
 */
export class WsHub {
  private clients = new Set<ServerWebSocket<unknown>>()
  private router: WsMessageRouter | null = null

  constructor(private log: Logger) {}

  setRouter(router: WsMessageRouter): void {
    this.router = router
  }

  broadcast(msg: ServerMessage): void {
    // Validasi sebelum kirim — tidak ada message liar keluar dari core.
    const parsed = ServerMessageSchema.parse(msg)
    const data = JSON.stringify(parsed)
    for (const ws of this.clients) {
      ws.send(data)
    }
  }

  get clientCount(): number {
    return this.clients.size
  }

  get handlers(): WebSocketHandler<unknown> {
    return {
      open: (ws) => {
        this.clients.add(ws)
        this.log.debug(`ws client connect (total ${this.clients.size})`)
      },
      close: (ws) => {
        this.clients.delete(ws)
        this.router?.handleClose(ws)
        this.log.debug(`ws client disconnect (total ${this.clients.size})`)
      },
      message: (ws, message) => {
        if (!this.router) {
          this.log.debug('ws message masuk tapi router belum siap — diabaikan')
          return
        }
        void this.router.handleMessage(ws, typeof message === 'string' ? message : message.toString())
      },
    }
  }
}
