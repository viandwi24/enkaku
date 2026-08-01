import type { ServerWebSocket, WebSocketHandler } from 'bun'
import { ServerMessageSchema, type ServerMessage } from '@enkaku/protocol'
import type { Logger } from '../util/logger'

/**
 * Hub WebSocket /ws — M0: server→client saja; message masuk di-log lalu
 * diabaikan (control messages = Plan 03+). Client baru TIDAK dikirimi
 * replay snapshot: konsumen GET /api/devices dulu, baru subscribe.
 */
export class WsHub {
  private clients = new Set<ServerWebSocket<unknown>>()

  constructor(private log: Logger) {}

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
        this.log.debug(`ws client disconnect (total ${this.clients.size})`)
      },
      message: (_ws, message) => {
        this.log.debug(`ws message masuk diabaikan (M0): ${String(message).slice(0, 200)}`)
      },
    }
  }
}
