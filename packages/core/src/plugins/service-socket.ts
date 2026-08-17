import type { ServerWebSocket } from 'bun'
import type { PluginCaller } from '@enkaku/protocol'
import type { PluginSocket, PluginSocketHandlers } from '@enkaku/sdk'
import type { Logger } from '../util/logger'
import { createLogger } from '../util/logger'
import type { RuntimeHost } from './runtime-host'
import { resolvePluginHandler, type PluginServiceRouteDeps } from './service-routes'

/**
 * Plan 109 (M74), step 109.6 — **`ctx.onSocket`: a plugin's own WebSocket.**
 *
 * ## This is not the farm's `/ws`, and it is not `ctx.onEvent`
 *
 * `WsHub` is one socket per browser carrying the farm's own typed
 * `ServerMessage` broadcast; `ctx.onEvent` (step 109.5) is a read-only TAP on
 * that broadcast, filtered, detached, and unable to answer. This is neither. It
 * is a private, bidirectional connection at `/api/plugins/:name/socket/:id`
 * between one browser and one plugin handler, carrying whatever bytes the
 * plugin writes, with no envelope, no `WsHub`, no observer list, and no
 * relation to the farm's broadcast at all. Conflating the two would be how a
 * plugin ends up able to write into the farm's broadcast — the exact thing
 * criterion 12 exists to prevent.
 *
 * ## The permission is checked BEFORE the upgrade
 *
 * A caller who may not reach the handler gets a `403` on the handshake, never
 * an open socket that closes a moment later — a browser cannot tell the second
 * apart from a network blip, and would retry it forever.
 *
 * ## Messages that arrive before `open` has finished
 *
 * The handler may be `async`, so there is a window between the socket opening
 * and its `message` callback existing. Frames in that window are QUEUED, up to
 * `PENDING_FRAME_LIMIT`, and flushed in order once the handler is installed —
 * dropping them would make a plugin's own first-message protocol
 * nondeterministic. Past the cap the socket is closed with a reason that says
 * so, rather than the core buffering without bound on a peer's say-so.
 */

/** What `srv.upgrade` attaches to a plugin socket, and what `daemon.ts` branches on. */
export interface PluginSocketData {
  plugin: string
  socketId: string
  caller: PluginCaller
}

/** Bounded, and the bound is the point: a peer that floods before the handler is ready must not grow the core's heap. */
export const PENDING_FRAME_LIMIT = 32

export interface PluginSocketRouterDeps extends PluginServiceRouteDeps {
  host: RuntimeHost
  log?: Logger
}

export interface PluginSocketRouter {
  /**
   * The pre-upgrade check. Throws an `EnkakuError` the caller turns into an
   * HTTP response; returns what to attach to the socket when it passes.
   */
  authorize(input: { plugin: string; socketId: string; caller: { id: string; role: 'admin' | 'operator' } | undefined }): PluginSocketData
  open(ws: ServerWebSocket<unknown>, data: PluginSocketData, query: Record<string, string>): void
  message(ws: ServerWebSocket<unknown>, data: PluginSocketData, message: string | Buffer): void
  close(ws: ServerWebSocket<unknown>, data: PluginSocketData, code: number, reason: string): void
  /** Live connections, for the tests and for the counters. */
  openCount(): number
}

interface Connection {
  connectionId: string
  data: PluginSocketData
  socket: PluginSocket
  handlers: PluginSocketHandlers | null
  pending: Array<string | Uint8Array>
  overflowed: boolean
  closed: boolean
}

export function createPluginSocketRouter(deps: PluginSocketRouterDeps): PluginSocketRouter {
  const log = deps.log ?? createLogger('plugin.socket')
  const connections = new Map<ServerWebSocket<unknown>, Connection>()

  function deliver(conn: Connection, frame: string | Uint8Array): void {
    const handlers = conn.handlers
    if (!handlers?.message) return
    void deps.host
      .invoke(conn.data.plugin, { what: `socket:${conn.data.socketId} message` }, (signal) => {
        // The signal is handed on for symmetry with every other funnel entry;
        // a message callback that ignores it is stopped by nothing, exactly as
        // §3.2 says of every in-process handler.
        void signal
        return handlers.message!(frame)
      })
      .catch((err: unknown) => {
        // There is no reply channel for a failed message — the plugin owns the
        // protocol, and the core does not know what an error looks like in it.
        // Charged to the budget by `invoke` and logged here; the socket stays
        // open, because one bad frame is not a broken connection.
        log.warn(`plugin "${conn.data.plugin}": socket "${conn.data.socketId}" message handler failed — ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  return {
    authorize(input) {
      const resolved = resolvePluginHandler(deps, { plugin: input.plugin, kind: 'socket', id: input.socketId, caller: input.caller })
      return { plugin: input.plugin, socketId: input.socketId, caller: resolved.caller }
    },

    open(ws, data, query) {
      const connectionId = crypto.randomUUID()
      const conn: Connection = {
        connectionId,
        data,
        handlers: null,
        pending: [],
        overflowed: false,
        closed: false,
        socket: {
          connectionId,
          caller: data.caller,
          query,
          get open() {
            return !conn.closed
          },
          send(payload) {
            // A no-op rather than a throw on a closed socket: a plugin pushing
            // on a timer would otherwise have to guard every tick, and the
            // guard it wrote would race the close anyway.
            if (conn.closed) return
            ws.send(payload)
          },
          close(code, reason) {
            if (conn.closed) return
            ws.close(code ?? 1000, reason ?? '')
          },
        },
      }
      connections.set(ws, conn)
      deps.host.noteSocket(data.plugin, 1)

      const registration = deps.host.lookupHandler(data.plugin, 'socket', data.socketId)
      if (!registration || registration.kind !== 'socket') {
        // The service went down between the handshake and the open. Closed
        // with a code, not left hanging: 1011 is "the server hit a condition
        // that stopped it fulfilling the request", which is exactly this.
        ws.close(1011, 'the plugin service stopped before this socket opened')
        return
      }

      void deps.host
        .invoke(
          data.plugin,
          {
            what: `socket:${data.socketId} open`,
            ...(registration.timeoutMs !== undefined ? { timeoutMs: registration.timeoutMs } : {}),
          },
          (signal) => registration.handler(conn.socket, signal),
        )
        .then((handlers) => {
          if (conn.closed) return
          conn.handlers = handlers && typeof handlers === 'object' ? handlers : {}
          for (const frame of conn.pending.splice(0)) deliver(conn, frame)
          if (conn.overflowed) {
            ws.close(1013, `more than ${PENDING_FRAME_LIMIT} frames arrived before the handler was ready`)
          }
        })
        .catch((err: unknown) => {
          log.warn(`plugin "${data.plugin}": socket "${data.socketId}" failed to open — ${err instanceof Error ? err.message : String(err)}`)
          if (!conn.closed) ws.close(1011, 'the plugin handler failed to accept this socket')
        })
    },

    message(ws, _data, message) {
      const conn = connections.get(ws)
      if (!conn || conn.closed) return
      const frame = typeof message === 'string' ? message : new Uint8Array(message)
      if (!conn.handlers) {
        if (conn.pending.length >= PENDING_FRAME_LIMIT) {
          conn.overflowed = true
          return
        }
        conn.pending.push(frame)
        return
      }
      deliver(conn, frame)
    },

    close(ws, data, code, reason) {
      const conn = connections.get(ws)
      connections.delete(ws)
      deps.host.noteSocket(data.plugin, -1)
      if (!conn || conn.closed) return
      conn.closed = true
      conn.pending.length = 0
      const handlers = conn.handlers
      if (!handlers?.close) return
      void deps.host
        .invoke(data.plugin, { what: `socket:${data.socketId} close` }, () => handlers.close!(code, reason))
        .catch((err: unknown) => {
          log.warn(`plugin "${data.plugin}": socket "${data.socketId}" close handler failed — ${err instanceof Error ? err.message : String(err)}`)
        })
    },

    openCount: () => connections.size,
  }
}
