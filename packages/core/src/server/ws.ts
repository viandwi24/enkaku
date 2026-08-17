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
/**
 * A read-only tap on the broadcast (plan 109 §3.5, step 109.5 — how a plugin
 * hears a farm event).
 *
 * **Every word of the contract is load-bearing.** An observer is called
 * *after* the message has already been written to every client, so it cannot
 * change what anyone received. Its return value is ignored and never awaited,
 * so it cannot delay the broadcast. It runs inside a `try`/`catch`, so
 * throwing cannot break the broadcast either. What is left that an observer
 * CAN still do is block the event loop synchronously — which no design in a
 * single process can prevent, and which plan 109 §3.2 states as the cost of
 * in-process plugins rather than hiding. The plugin tap therefore detaches its
 * own dispatch (`runtime-events.ts`), and does not rely on this loop's good
 * manners.
 */
export type WsBroadcastObserver = (msg: ServerMessage) => void

export class WsHub {
  private clients = new Set<ServerWebSocket<unknown>>()
  private router: WsMessageRouter | null = null
  private observers = new Set<WsBroadcastObserver>()

  constructor(private log: Logger) {}

  setRouter(router: WsMessageRouter): void {
    this.router = router
  }

  /** Register a tap. Returns the function that removes it. See `WsBroadcastObserver`. */
  addObserver(observer: WsBroadcastObserver): () => void {
    this.observers.add(observer)
    return () => {
      this.observers.delete(observer)
    }
  }

  broadcast(msg: ServerMessage): void {
    // Validate before sending — no stray message ever leaves the core.
    const parsed = ServerMessageSchema.parse(msg)
    const data = JSON.stringify(parsed)
    for (const ws of this.clients) {
      ws.send(data)
    }
    // AFTER the fan-out, deliberately: an observer that runs first could, at
    // minimum, delay a client's frame. Here the sends are already done.
    for (const observe of this.observers) {
      try {
        observe(parsed)
      } catch (err) {
        // An observer is a tap. A tap that throws is the tap's bug, and it
        // must not become the broadcast's.
        this.log.warn(`a broadcast observer threw and was ignored — ${err instanceof Error ? err.message : String(err)}`)
      }
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
