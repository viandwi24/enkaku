import { AdbError } from '../errors'
import { createStreamMux, type RawStream, type StreamMux } from './stream-mux'
import { A_AUTH, A_CNXN, CONNECT_VERSION, HEADER_BYTES, type AdbdHeader, clampMaxdata, commandName, decodeHeader, encodeFrame } from './wire'

/**
 * Ties `wire.ts` and `stream-mux.ts` together into something that can sit
 * behind `Bun.listen` (plan 27 §4.1, §27.4): performs the CNXN handshake for
 * each connection, then hands every later frame to a fresh `StreamMux`.
 *
 * `openService` mirrors `AdbdShimDeps.openService` from the plan exactly —
 * `serial` is threaded through here (rather than baked into the closure)
 * because `deps.serial` below already fixes it per shim instance; the two
 * are equivalent, this just matches the plan's literal signature.
 */
export interface AdbdShimDeps {
  /** Opens a raw smartsocket stream: `host:transport:<serial>` then `<service>`. */
  openService(serial: string, service: string): Promise<RawStream>
  serial: string
  banner: string
  /** The per-connection stream cap (plan §3.5) — forwarded straight into `createStreamMux`. */
  maxStreams: number
  /** Audit hook: fired once per stream that actually opened. */
  onOpen(service: string): void
  /** Fired once per connection when it ends, whatever the reason (`'handshake_failed'`, `'closed'`, `'error'`, ...). */
  onClose(reason: string): void
  log(level: 'debug' | 'warn', msg: string): void
}

/**
 * The plan sketches `createAdbdShim`'s return type as a single
 * `(socket) => void` (the `open` handler). A real Bun listener also needs
 * `data`/`close`/`error` wired to the SAME per-connection frame reader, which
 * a lone `open`-shaped function cannot expose on its own — so this returns
 * the small handler bundle `Bun.listen`'s `socket:` option already expects.
 * Functionally it is exactly "accepts a socket, performs CNXN, and bridges
 * each OPEN to a smartsocket stream" — just wired through four callbacks
 * instead of one, which is what Bun's socket API actually offers.
 */
export interface AdbdShimHandlers {
  open(socket: import('bun').Socket): void
  data(socket: import('bun').Socket, chunk: Uint8Array): void
  close(socket: import('bun').Socket): void
  error(socket: import('bun').Socket, err: Error): void
}

/** A tiny pull-based byte accumulator, fed by a Bun socket's `data` events — the same shape as `AdbSocket`'s internal `ByteQueue`, scoped down to what a frame reader needs. */
class FrameReader {
  private chunks: Uint8Array[] = []
  private length = 0
  private waiter: { need: number; resolve: (b: Uint8Array) => void; reject: (e: unknown) => void } | null = null
  private ended = false
  private endErr: unknown = null

  push(chunk: Uint8Array): void {
    if (this.ended) return
    this.chunks.push(chunk)
    this.length += chunk.length
    this.flush()
  }

  end(err?: unknown): void {
    if (this.ended) return
    this.ended = true
    this.endErr = err
    this.flush()
  }

  private flush(): void {
    const w = this.waiter
    if (!w) return
    if (this.length >= w.need) {
      const all = new Uint8Array(this.length)
      let off = 0
      for (const c of this.chunks) {
        all.set(c, off)
        off += c.length
      }
      const head = all.subarray(0, w.need)
      const rest = all.subarray(w.need)
      this.chunks = rest.length ? [rest] : []
      this.length = rest.length
      this.waiter = null
      w.resolve(head)
    } else if (this.ended) {
      this.waiter = null
      w.reject(this.endErr ?? new AdbError('E_ADB_PROTOCOL', 'adb endpoint connection ended mid-frame'))
    }
  }

  take(n: number): Promise<Uint8Array> {
    if (this.waiter) throw new AdbError('E_ADB_PROTOCOL', 'concurrent read on an adb endpoint connection')
    return new Promise((resolve, reject) => {
      this.waiter = { need: n, resolve, reject }
      this.flush()
    })
  }

  async readFrame(): Promise<{ header: AdbdHeader; payload: Uint8Array }> {
    const headerBytes = await this.take(HEADER_BYTES)
    const header = decodeHeader(headerBytes)
    const payload = header.dataLength > 0 ? await this.take(header.dataLength) : new Uint8Array(0)
    return { header, payload }
  }
}

interface ConnState {
  reader: FrameReader
  mux: StreamMux | null
  closed: boolean
}

export function createAdbdShim(deps: AdbdShimDeps): AdbdShimHandlers {
  const states = new WeakMap<import('bun').Socket, ConnState>()
  const te = new TextEncoder()

  function finishConnection(socket: import('bun').Socket, state: ConnState, reason: string): void {
    if (state.closed) return
    state.closed = true
    state.reader.end()
    state.mux?.closeAll(reason)
    deps.onClose(reason)
  }

  async function handleConnection(socket: import('bun').Socket, state: ConnState): Promise<void> {
    try {
      const first = await state.reader.readFrame()
      if (first.header.command === A_AUTH) {
        // Plan §3.4: this endpoint never authenticates a peer — it is not an
        // adbd standing in for a real device's RSA trust, only a lease-scoped,
        // loopback-by-default bridge. A peer that insists on AUTH first is
        // refused outright rather than answered with a fake challenge.
        deps.log('warn', 'adb endpoint: peer opened with AUTH — refusing (this endpoint never authenticates)')
        // `finishConnection` BEFORE `socket.end()`: ending the socket can
        // synchronously fire the listener's own `close` callback (Bun may
        // run it inline when there is nothing left to flush), which would
        // otherwise win the `state.closed` race and record `'closed'`
        // instead of this call's more specific reason.
        finishConnection(socket, state, 'auth_refused')
        socket.end()
        return
      }
      if (first.header.command !== A_CNXN) {
        deps.log('warn', `adb endpoint: expected CNXN first, got ${commandName(first.header.command)}`)
        finishConnection(socket, state, 'handshake_failed')
        socket.end()
        return
      }

      const peerVersion = first.header.arg0
      const peerMaxdata = first.header.arg1
      const ourMaxdata = clampMaxdata(peerMaxdata)
      // Mirror the peer's own version (plan §27.1 spike measurement: every
      // real adb client sends exactly `CONNECT_VERSION`) rather than always
      // forcing our own — a future/older client that sent something else at
      // least gets an answer at the version it asked for.
      const ourVersion = peerVersion || CONNECT_VERSION
      socket.write(encodeFrame(A_CNXN, ourVersion, ourMaxdata, te.encode(deps.banner)))
      deps.log(
        'debug',
        `adb endpoint: CNXN complete (peer version=0x${peerVersion.toString(16)} maxdata=${peerMaxdata} → replied maxdata=${ourMaxdata}) — no AUTH challenge`,
      )

      const mux = createStreamMux({
        send: (frame) => {
          if (!state.closed) socket.write(frame)
        },
        openService: (service) => deps.openService(deps.serial, service),
        maxStreams: deps.maxStreams,
        onOpen: (service) => deps.onOpen(service),
        // Per-stream close reasons are not the connection-level `onClose`
        // this module reports — plan §3.6 records those separately, per
        // OPEN, on the caller's audit path (wired in `adb-endpoint.ts`).
        onClose: () => {},
        log: deps.log,
      })
      state.mux = mux

      for (;;) {
        const frame = await state.reader.readFrame()
        mux.handleFrame(frame.header, frame.payload)
      }
    } catch (err) {
      // A clean disconnect (the user's `adb disconnect`, or the lease ending
      // and this endpoint being torn down) surfaces here as a rejected
      // `readFrame()` — that is the normal way this loop ends, not a bug.
      deps.log('debug', `adb endpoint: connection ended: ${String(err)}`)
      finishConnection(socket, state, 'closed')
    }
  }

  return {
    open(socket) {
      const state: ConnState = { reader: new FrameReader(), mux: null, closed: false }
      states.set(socket, state)
      void handleConnection(socket, state)
    },
    data(socket, chunk) {
      states.get(socket)?.reader.push(chunk)
    },
    close(socket) {
      const state = states.get(socket)
      if (state) {
        state.reader.end()
        finishConnection(socket, state, 'closed')
      }
    },
    error(socket, err) {
      const state = states.get(socket)
      if (state) {
        state.reader.end(err)
        finishConnection(socket, state, 'error')
      }
    },
  }
}
