import type { ServerWebSocket, WebSocketHandler } from 'bun'
import { ServerMessageSchema, type ServerMessage } from '@enkaku/protocol'
import type { Logger } from '../util/logger'

export interface WsMessageRouter {
  handleMessage(ws: ServerWebSocket<unknown>, raw: string): Promise<void>
  handleClose(ws: ServerWebSocket<unknown>): void
  /** Sends `hello` (plan 31 §4.2) — optional so a router set up before this plan still works. */
  handleOpen?(ws: ServerWebSocket<unknown>): void
}

/**
 * Hub WebSocket /ws: broadcast event server→client + routing message
 * client→server messages to the handler (stream/input/pairing). A new client
 * gets NO snapshot replay: consumers GET /api/devices first, then subscribe.
 */
export class WsHub {
  private clients = new Set<ServerWebSocket<unknown>>()
  private router: WsMessageRouter | null = null

  constructor(private log: Logger) {}

  setRouter(router: WsMessageRouter): void {
    this.router = router
  }

  broadcast(msg: ServerMessage): void {
    // Validate before sending — no stray message ever leaves the core.
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
        this.router?.handleOpen?.(ws)
        this.log.debug(`ws client connect (total ${this.clients.size})`)
      },
      close: (ws) => {
        this.clients.delete(ws)
        this.router?.handleClose(ws)
        this.log.debug(`ws client disconnect (total ${this.clients.size})`)
      },
      message: (ws, message) => {
        if (!this.router) {
          this.log.debug('a ws message arrived before the router was ready — ignoring it')
          return
        }
        void this.router.handleMessage(ws, typeof message === 'string' ? message : message.toString())
      },
    }
  }
}
