import type { BridgeSocket } from './socket'

/**
 * The bidirectional pipe: bytes both ways, a counter each way, and exactly one
 * teardown path.
 *
 * This file is small because plan 112 F20's choice bought it. Both ends are
 * `node:net` sockets — the listener because we call `net.createServer`, the
 * upstream because `SocksClient.createConnection` hands back a `net.Socket` —
 * so `a.pipe(b); b.pipe(a)` is the whole of it, with Node's own backpressure.
 * Plan 109 §4.7's worked example uses `Bun.listen`, whose socket is **not** a
 * Node stream and has no `.pipe()`; pairing the two would mean hand-writing
 * backpressure between two socket kinds in the one place a bug is a silent
 * memory leak under load.
 *
 * The counters are added as an extra `data` listener rather than a
 * `Transform`, because a stream in the middle is a second buffer to get wrong
 * and the numbers are for a screen, not for accounting.
 */

export interface RelayCounters {
  bytesUp: number
  bytesDown: number
}

export interface Relay {
  readonly counters: RelayCounters
  /** Idempotent: destroys both sockets and fires `onClose` at most once. */
  destroy(): void
}

/**
 * Pipe `client` ↔ `upstream`, counting both directions.
 *
 * `onClose` fires exactly once, whichever side ends first and whether the end
 * was clean or an error — the supervisor's live-connection count depends on
 * that, and a count that can be decremented twice is a count that goes
 * negative under load.
 *
 * The `reason` is a **diagnostic, never a decision**, and only `'stopped'`
 * (an explicit `destroy()`) is exact. When a socket goes first, tearing down
 * one end of a `pipe` closes the other in the same tick and which `'close'`
 * the runtime delivers first is a race — so `'client'` and `'upstream'`
 * distinguish "a peer went away" from "we stopped it", and nothing more.
 * Nothing in this pack branches on which peer it names.
 *
 * `idleMs`, when set, destroys the pair after that long with **no bytes in
 * either direction**. It exists because of plan 112 H3's third fixture: an
 * upstream that accepts, completes the SOCKS handshake, and then black-holes
 * everything is invisible to `socks`'s own timeout, which covers the handshake
 * only. The measured behaviour is recorded in plan 112 §0.3 beside H3.
 */
export function createRelay(
  client: BridgeSocket,
  upstream: BridgeSocket,
  opts: { onClose: (counters: RelayCounters, reason: 'client' | 'upstream' | 'idle' | 'stopped') => void; idleMs?: number },
): Relay {
  const counters: RelayCounters = { bytesUp: 0, bytesDown: 0 }
  let closed = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  function finish(reason: 'client' | 'upstream' | 'idle' | 'stopped'): void {
    if (closed) return
    closed = true
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    client.destroy()
    upstream.destroy()
    opts.onClose(counters, reason)
  }

  function touch(): void {
    if (!opts.idleMs || closed) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => finish('idle'), opts.idleMs)
  }

  client.on('data', (chunk: Buffer) => {
    counters.bytesUp += chunk.length
    touch()
  })
  upstream.on('data', (chunk: Buffer) => {
    counters.bytesDown += chunk.length
    touch()
  })

  // A destroyed socket emits `error` before `close` when the other end sent an
  // RST. Swallowing it here is not hiding a fault: the pair is going away and
  // an unhandled `error` on a `net.Socket` is an uncaught exception that would
  // take the whole core down (plan 109 §3.2 — nothing catches that).
  client.on('error', () => finish('client'))
  upstream.on('error', () => finish('upstream'))
  client.on('close', () => finish('client'))
  upstream.on('close', () => finish('upstream'))

  client.pipe(upstream)
  upstream.pipe(client)
  touch()

  return {
    counters,
    destroy() {
      finish('stopped')
    },
  }
}
