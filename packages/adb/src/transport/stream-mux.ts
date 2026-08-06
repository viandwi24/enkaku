import { A_CLSE, A_OKAY, A_OPEN, A_WRTE, type AdbdHeader, commandName, encodeFrame, stripTrailingNul } from './wire'

/**
 * A single raw, already-negotiated smartsocket byte stream (plan 27 §4.1) —
 * what `AdbClient.openRaw` hands back after `host:transport:<serial>` plus
 * the requested service both got `OKAY`. From this point the connection
 * carries whatever bytes the service protocol defines (`shell:`, `sync:`,
 * `shell,v2,...:`, ...), completely opaque to this module — that opacity is
 * the whole reason the shim can claim features it never has to parse.
 */
export interface RawStream {
  /**
   * Raw bytes, no smartsocket length-prefix framing. A LOCAL backend (a real
   * smartsocket TCP connection) completes synchronously — returns `undefined`
   * — and the mux's WRTE gets its OKAY immediately, exactly as before.
   *
   * A backend that carries the write across an additional hop (the cloud
   * adb endpoint, plan 28 §3.3) may instead return a `Promise<void>` that
   * resolves only once delivery is actually confirmed downstream (the
   * node's `adb.ack`). `handleWrte` below awaits that promise before
   * sending the OKAY, so the ready-window genuinely survives the extra hop
   * instead of lying about delivery — the shim never acknowledges a WRTE
   * merely because it handed the bytes to the tunnel.
   */
  write(chunk: Uint8Array): void | Promise<void>
  /** Drain mode (mirrors `AdbSocket.streamFrom`): every byte from here on goes straight to `onData`. */
  streamFrom(onData: (chunk: Uint8Array) => void, onEnd: (err?: unknown) => void): void
  /** `force=true` resets the connection; otherwise a clean FIN. */
  close(force?: boolean): void
}

function isThenable(value: unknown): value is Promise<void> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

export interface StreamMuxDeps {
  /** Write one already-encoded frame (`encodeFrame`) to the host connection. */
  send(frame: Uint8Array): void
  /** Opens a raw stream for a service string exactly as the host sent it (e.g. `shell:echo hi`, `sync:`, `shell,v2,...:...`). */
  openService(service: string): Promise<RawStream>
  /** The endpoint's per-connection stream budget (plan §3.5) — exceeding it refuses the OPEN with CLSE, never queues. */
  maxStreams: number
  /** Fired once a stream is genuinely open (after `openService` resolves) — the audit hook for `adb.open` (plan §3.6). */
  onOpen?: (service: string) => void
  /** Fired when a stream ends, opened or not — `reason` is `'closed'` for a normal close, or why it never opened. */
  onClose?: (service: string, reason: string) => void
  log?: (level: 'debug' | 'warn', msg: string) => void
}

export interface StreamMux {
  /** Feed one already-decoded frame plus its payload. CNXN never reaches here — the caller (`adbd-shim.ts`) handles the handshake itself. */
  handleFrame(header: AdbdHeader, payload: Uint8Array): void
  /** Currently open stream count (for `AdbEndpointManager`'s connection-count reporting). */
  readonly size: number
  /** Tear every open stream down without emitting a reply frame — there is no peer left to receive one (the host connection itself just closed). */
  closeAll(reason: string): void
}

interface StreamState {
  /** Our own id for this stream, assigned when we accept the OPEN. */
  ourId: number
  /** The host's id for this stream — also this stream's key in `streams` (every frame from the host names its OWN id in `header.arg0`). */
  hostId: number
  service: string
  /** Null while `openService` is still in flight for this stream — see `handleOpen`. */
  backend: RawStream | null
  /** True once EITHER side has sent a CLSE for this stream — the next CLSE seen is the peer's echo, not a fresh close request, and must not be echoed again (that would ping-pong forever). */
  closing: boolean
  /** Ready-window flow control (plan §3.2): true when we may send the next WRTE. Starts true right after the OPEN's OKAY (that OKAY is not itself a WRTE ack). */
  writeReady: boolean
  /** Bytes queued from the backend while `writeReady` is false — nothing is ever dropped, only delayed. */
  outbox: Uint8Array[]
}

/**
 * The per-connection stream table (plan 27 §4.1, §27.3): OPEN allocates a
 * stream (or refuses one with CLSE past `maxStreams`, §3.5); WRTE/OKAY
 * implement the base protocol's one-outstanding-write ready window; CLSE
 * propagates and tears the matching backend stream down. Pure state plus the
 * two IO seams (`send`, `openService`) it's given — no socket of its own, so
 * a test drives it with a scripted byte-level peer (plan §7).
 */
export function createStreamMux(deps: StreamMuxDeps): StreamMux {
  const streams = new Map<number, StreamState>()
  let nextOurId = 1
  const log = deps.log ?? (() => {})

  function pump(state: StreamState): void {
    if (!state.writeReady) return
    const chunk = state.outbox.shift()
    if (!chunk) return
    state.writeReady = false
    deps.send(encodeWrte(state.ourId, state.hostId, chunk))
  }

  function finishStream(state: StreamState, reason: string): void {
    if (!streams.has(state.hostId)) return
    streams.delete(state.hostId)
    deps.onClose?.(state.service, reason)
  }

  function beginClose(state: StreamState, reason: string): void {
    if (state.closing) {
      finishStream(state, reason)
      return
    }
    state.closing = true
    // If the backend was never attached, we never sent the OPEN's OKAY
    // either — the host has no idea what `ourId` is yet, so the close must
    // use id 0, the same as an outright refusal (§ handleOpen's stream-cap path).
    const neverOpened = state.backend === null
    state.backend?.close(true)
    deps.send(encodeClse(neverOpened ? 0 : state.ourId, state.hostId))
    finishStream(state, reason)
  }

  function handleOpen(header: AdbdHeader, payload: Uint8Array): void {
    const hostId = header.arg0
    const service = stripTrailingNul(new TextDecoder().decode(payload))
    if (streams.size >= deps.maxStreams) {
      log('warn', `adb endpoint: refusing OPEN ${JSON.stringify(service)} — at the ${deps.maxStreams}-stream cap`)
      deps.send(encodeClse(0, hostId))
      deps.onClose?.(service, 'stream_limit')
      return
    }
    const ourId = nextOurId++
    // Reserve the id immediately (before the async `openService` settles) so
    // a same-hostId re-OPEN mid-flight cannot double-allocate — connect
    // failures below clean the reservation up via `streams.delete`.
    const placeholder: StreamState = {
      ourId,
      hostId,
      service,
      backend: null,
      closing: false,
      writeReady: false,
      outbox: [],
    }
    streams.set(hostId, placeholder)

    deps
      .openService(service)
      .then((backend) => {
        const state = streams.get(hostId)
        // The host already CLSE'd (or the connection tore down) while
        // `openService` was still in flight — this backend connection has
        // nowhere to go now; close it rather than leak it.
        if (!state || state.backend) {
          backend.close(true)
          return
        }
        state.backend = backend
        state.writeReady = true
        backend.streamFrom(
          (chunk) => {
            state.outbox.push(chunk)
            pump(state)
          },
          (err) => {
            log('debug', `adb endpoint: backend stream ended (${JSON.stringify(service)}): ${err ? String(err) : 'closed'}`)
            beginClose(state, 'closed')
          },
        )
        deps.send(encodeOkay(state.ourId, state.hostId))
        deps.onOpen?.(service)
      })
      .catch((err) => {
        streams.delete(hostId)
        log('warn', `adb endpoint: OPEN ${JSON.stringify(service)} failed: ${String(err)}`)
        deps.send(encodeClse(0, hostId))
        deps.onClose?.(service, 'backend_error')
      })
  }

  function handleOkay(header: AdbdHeader): void {
    const state = streams.get(header.arg0)
    if (!state) {
      log('debug', `adb endpoint: OKAY for unknown stream ${header.arg0} — ignored`)
      return
    }
    // The OPEN's own OKAY is sent by US and never acked with a further OKAY
    // by adb's base protocol, so every OKAY reaching here is a write ack.
    state.writeReady = true
    pump(state)
  }

  function handleWrte(header: AdbdHeader, payload: Uint8Array): void {
    const state = streams.get(header.arg0)
    if (!state || !state.backend) {
      log('warn', `adb endpoint: WRTE for unknown/unopened stream ${header.arg0} — refusing`)
      deps.send(encodeClse(0, header.arg0))
      return
    }
    const result = state.backend.write(payload)
    const ack = (): void => {
      // The stream may have closed (or been replaced — it can't, hostId keys
      // are stable, but it CAN simply be gone) while a deferred write was in
      // flight — do not resurrect it with a stray OKAY.
      if (streams.get(header.arg0) !== state) return
      // Ready-signal ack (plan §3.2): tells the host it may send its next WRTE.
      deps.send(encodeOkay(state.ourId, state.hostId))
    }
    if (isThenable(result)) {
      // Plan 28 §3.3: a remote backend's write does not settle until the
      // node has actually written the bytes downstream — the WRTE's OKAY
      // follows THAT acknowledgement, not the mere handoff to the tunnel.
      // Settle either way (a rejection means the backend is ending; its own
      // `onEnd` — wired via `streamFrom` — is what sends the CLSE) so a
      // failed write can never leave the host waiting forever for an OKAY.
      void result.then(ack, ack)
    } else {
      ack()
    }
  }

  function handleClse(header: AdbdHeader): void {
    const state = streams.get(header.arg0)
    if (!state) {
      log('debug', `adb endpoint: CLSE for unknown stream ${header.arg0} — ignored`)
      return
    }
    beginClose(state, 'closed')
  }

  return {
    handleFrame(header, payload) {
      switch (header.command) {
        case A_OPEN:
          handleOpen(header, payload)
          return
        case A_OKAY:
          handleOkay(header)
          return
        case A_WRTE:
          handleWrte(header, payload)
          return
        case A_CLSE:
          handleClse(header)
          return
        default:
          log('warn', `adb endpoint: unexpected frame on an established connection: ${commandName(header.command)}`)
      }
    },
    get size() {
      return streams.size
    },
    closeAll(reason) {
      for (const state of [...streams.values()]) {
        state.backend?.close(true)
        streams.delete(state.hostId)
        deps.onClose?.(state.service, reason)
      }
    },
  }
}

function encodeOkay(ourId: number, hostId: number): Uint8Array {
  return encodeFrame(A_OKAY, ourId, hostId)
}

function encodeClse(ourId: number, hostId: number): Uint8Array {
  return encodeFrame(A_CLSE, ourId, hostId)
}

function encodeWrte(ourId: number, hostId: number, data: Uint8Array): Uint8Array {
  return encodeFrame(A_WRTE, ourId, hostId, data)
}
