import net from 'node:net'
import type { BridgeSocket } from './socket'
import type { ConnectionLogger } from './logbook'
import { classifyBindError, classifyDialError, type ProxyError } from './errors'
import { createRelay, type RelayCounters } from './relay'
import type { Upstream, UpstreamTarget } from './upstream'
import type { ListenerCredential } from './auth'

/**
 * The half of a bridge that is the same whichever protocol it speaks: bind,
 * accept, count, cap, hand each connection to a negotiator, wire the relay,
 * and let go on demand.
 *
 * ## Why we track live sockets ourselves
 *
 * Plan 112 §3.2 states the cost of choosing `node:net` over `Bun.listen`
 * plainly: we lose `SocketListener.stop(closeActiveConnections)` — one call
 * that both stops accepting and kills live sockets — and must keep a `Set`.
 * The supervisor needs that `Set` anyway, for the live connection count on the
 * row and for phase 2 of the two-phase stop, so the cost is close to zero and
 * the alternative (hand-written backpressure between a Bun socket and a Node
 * socket) was not.
 *
 * ## Why `close()` and `destroyLive()` are two methods
 *
 * They are the two phases of a stop (§3.7), and conflating them would make one
 * of them impossible. `close()` stops accepting and **releases the port
 * immediately**, leaving live tunnels alone; `destroyLive()` is the guillotine
 * the supervisor drops after `drainMs`, or at once for a force stop, or at
 * once inside `ctx.onStop` — where the host's whole disposer budget is 5 s and
 * a 10 s drain could only fail.
 */

/** One live connection, as the supervisor counts it. */
export interface BridgeConn {
  readonly id: number
  destroy(): void
}

export interface Listener {
  /**
   * The port actually bound, read back off the socket rather than echoed from
   * the request — so `port: 0` ("give me any free one") reports the real
   * number. A record never asks for 0; the tests do, constantly, and a
   * listener that lied about its port would make every one of them bind a
   * fixed port and race each other.
   */
  readonly port: number
  /** Every live connection. Read by the supervisor for the count and for phase 2 of the stop. */
  readonly live: ReadonlySet<BridgeConn>
  /**
   * Stop accepting; the port is released. Live sockets are untouched.
   *
   * **Synchronous, and that is a correction to plan 112 §4.4's sketch, which
   * types it `Promise<void>`.** Node's `server.close()` releases the listening
   * socket before it returns and calls its callback only once every connection
   * has gone — so awaiting it would be awaiting the drain, which is the
   * supervisor's job and has its own bounded timer. A `close()` that resolved
   * on the callback would also never resolve for a proxy carrying a long
   * download, and `ctx.onStop`'s whole budget is 5 s.
   */
  close(): void
  /** Destroy every live connection now. Idempotent. */
  destroyLive(): void
}

/** What a negotiator can do with a client that has just connected. */
export interface NegotiationApi {
  readonly connId: number
  /**
   * Dial the upstream for `dest` and, on success, wire the relay.
   *
   * `onReady` runs **after** the upstream is connected and **before** any
   * piping, which is where each protocol writes its own success reply — a
   * `200 Connection Established` for HTTP CONNECT, a rewritten request line
   * for absolute-form, an RFC 1928 reply for SOCKS5.
   *
   * `leftover` is whatever the negotiator read past the end of its own
   * framing. It is pushed back onto the client before piping, because a client
   * that pipelines its first request body behind the head would otherwise lose
   * exactly those bytes — intermittently, under load, and never in a test that
   * writes the head as one chunk.
   */
  open(
    dest: UpstreamTarget,
    hooks: {
      onReady: (upstream: BridgeSocket) => void
      onFailure: (err: ProxyError) => void
      leftover?: Buffer
    },
  ): void
  /**
   * Refuse this connection, log the reason, and close. The caller writes any
   * protocol-level refusal first.
   *
   * `clientAddress` is for the one reason that needs it (plan 117 §4.4): a
   * refused authentication attempt is logged with the address it came from,
   * never with what it offered. Every other refusal reason leaves it unset.
   */
  refuse(reason: string, extra?: { code?: string; destPort?: number; destHost?: string; clientAddress?: string }): void
}

export type Negotiator = (client: BridgeSocket, api: NegotiationApi) => void

/**
 * The one level of indirection that makes a listener's upstream swappable
 * without restarting the listener's port (plan 121 §3.3, §4.3).
 *
 * Before plan 121, `ListenerOptions.upstream` was a bare `Upstream`, captured
 * in `createListener`'s closure for the listener's whole lifetime — every
 * accepted connection's dial read the SAME object forever (plan 121 §0.2).
 * Wrapping it in a holder that the per-connection dial reads through
 * (`opts.upstream.current.connect(dest)`) means the supervisor can later
 * reassign `.current` to a freshly built `Upstream` — an ALREADY-OPEN
 * connection is a live pipe to the old socket by then, not a lookup, so it is
 * untouched; only the NEXT accepted connection sees the new upstream.
 *
 * Plan 121.2 built only this mechanism and proved it with a test — nothing
 * reassigned `.current` outside of `startLocked`'s own initial build. Plan
 * 121.3 (`service/failover.ts`) is the first live reassigner: it counts
 * dial failures fed through `ListenerOptions.onDialResult` and, once a
 * confirmation probe agrees the active upstream is actually down, builds a
 * fresh `Upstream` for the next configured fallback and reassigns
 * `.current` to it — through this exact holder, with this exact
 * already-open-connections-untouched guarantee.
 */
export interface UpstreamHolder {
  current: Upstream
}

export interface ListenerOptions {
  bindHost: string
  port: number
  upstream: UpstreamHolder
  maxConnections: number
  log: ConnectionLogger
  /**
   * The inbound credential a client must present to be served — absent means
   * this listener authenticates nobody (plan 117 §3.5, §4.4). `supervisor.ts`
   * is the only place that reads `proxy-auth:<id>` and fills this in;
   * `listen-socks5.ts` and `listen-http.ts` are the only places that check it.
   */
  auth?: ListenerCredential
  /** No bytes either way for this long ⇒ the pair is destroyed. See `DEFAULT_IDLE_MS`. */
  idleMs?: number
  /** Called once per closed connection, so the supervisor can accumulate totals. */
  onConnectionClosed?: (counters: RelayCounters) => void
  /** Written to a client turned away by `maxConnections`, when the protocol has something to say. */
  writeOverflowRefusal?: (client: BridgeSocket) => void
  /**
   * Called once per dial ATTEMPT through `opts.upstream.current` — `true` when
   * it resolved, `false` when it rejected (plan 121 §4.2's failure-counting
   * trigger). This is the SAME success/failure boundary `hooks.onReady`/
   * `hooks.onFailure` already fire at, one level down: those are the
   * NEGOTIATOR's protocol reply, this is the supervisor's failover counter,
   * and neither substitutes for the other. Fired even when the client has
   * already disconnected (`client.destroyed`) — the dial itself either
   * reached the upstream or it did not, independent of whether anyone is
   * still there to use it. Never awaited: a slow or async subscriber must not
   * delay the client's own reply.
   */
  onDialResult?: (ok: boolean) => void
}

/**
 * Bind, and resolve only once the socket is actually listening.
 *
 * The bind error is the failure everyone hits and it must arrive as a named,
 * actionable message on the row rather than as a stack trace — see
 * `classifyBindError`. `ctx.isPortFree` is a nicety on top of this, never a
 * substitute for it: a pre-check is racy, and the bind has to be handled
 * correctly anyway (plan 109 §3.3, plan 112 §3.7).
 */
export function createListener(opts: ListenerOptions, negotiate: Negotiator): Promise<Listener> {
  const live = new Set<BridgeConn>()
  let nextConnId = 1
  let destroyed = false

  const server = net.createServer((client) => {
    const connId = nextConnId++

    // Nothing else attaches an error handler until the relay exists, and an
    // unhandled `error` on a `net.Socket` is an uncaught exception — which, in
    // the core's own process, is not caught by anything (plan 109 §3.2).
    client.on('error', () => client.destroy())

    if (live.size >= opts.maxConnections) {
      opts.log({ event: 'refused', conn: connId, reason: 'max-connections', code: 'E_PROXY_MAX_CONNECTIONS' })
      try {
        opts.writeOverflowRefusal?.(client)
      } finally {
        client.destroy()
      }
      return
    }

    opts.log({ event: 'accepted', conn: connId })

    // Tracked from ACCEPT, not from "upstream connected". A cap that counted
    // only established tunnels would be no cap at all against the case it
    // exists for: a client opening connections faster than a slow upstream can
    // answer them, each one holding a socket and a pending dial.
    const conn: BridgeConn = { id: connId, destroy: () => client.destroy() }
    const openedAt = Date.now()
    let tracked = true
    live.add(conn)

    function untrack(): void {
      if (!tracked) return
      tracked = false
      live.delete(conn)
    }

    // A client that hangs up, or is destroyed, before the negotiation finishes
    // must still leave the count.
    client.on('close', () => untrack())

    const api: NegotiationApi = {
      connId,

      open(dest, hooks) {
        opts.upstream.current
          .connect(dest)
          .then((upstream) => {
            opts.onDialResult?.(true)
            if (client.destroyed || destroyed) {
              upstream.destroy()
              return
            }
            opts.log({ event: 'upstream-connected', conn: connId, destPort: dest.port, destHost: dest.host })
            hooks.onReady(upstream)

            // Anything the negotiator read past its own framing belongs to the
            // tunnel. Pause first: the negotiator was in flowing mode, and
            // `unshift` on a flowing stream re-emits immediately, before the
            // pipe exists.
            if (hooks.leftover && hooks.leftover.length > 0) {
              client.pause()
              client.unshift(hooks.leftover)
            }

            const conn2 = createRelay(client, upstream, {
              idleMs: opts.idleMs,
              onClose: (counters) => {
                untrack()
                opts.log({
                  event: 'closed',
                  conn: connId,
                  durationMs: Date.now() - openedAt,
                  bytesUp: counters.bytesUp,
                  bytesDown: counters.bytesDown,
                })
                opts.onConnectionClosed?.(counters)
              },
            })
            // Replace the placeholder destroy with one that also tears the
            // upstream down — a force stop that killed only the client half
            // would leave the upstream socket open and the count wrong.
            conn.destroy = () => conn2.destroy()
          })
          .catch((err: unknown) => {
            const failure = classifyDialError(err, [])
            opts.log({ event: 'refused', conn: connId, reason: 'upstream', code: failure.code, destPort: dest.port, destHost: dest.host })
            opts.onDialResult?.(false)
            hooks.onFailure(failure)
            untrack()
            client.destroy()
          })
      },

      refuse(reason, extra) {
        opts.log({ event: 'refused', conn: connId, reason, ...extra })
        untrack()
        client.destroy()
      },
    }

    negotiate(client, api)
  })

  return new Promise<Listener>((resolve, reject) => {
    function onError(err: unknown): void {
      server.removeListener('error', onError)
      reject(classifyBindError(err, opts.bindHost, opts.port))
    }
    server.once('error', onError)
    server.listen(opts.port, opts.bindHost, () => {
      server.removeListener('error', onError)
      // After the bind succeeds an `error` on the server is not a bind error
      // and must not go unhandled.
      server.on('error', () => {})
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : opts.port,
        live,
        close() {
          // The callback is deliberately a no-op: it fires when the LAST
          // connection closes, and nothing here waits for that.
          server.close(() => {})
        },
        destroyLive() {
          destroyed = true
          for (const conn of [...live]) conn.destroy()
          live.clear()
        },
      })
    })
  })
}
