import { AdbError } from './errors'
import { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES } from './timeouts'

/**
 * Framing smartsocket adb server (plan 01 §4.2):
 * - request: 4 lowercase hex digits (payload length in bytes) + ASCII payload
 * - status:  4 bytes 'OKAY' | 'FAIL' (FAIL is followed by a 4-hex-length block plus a message)
 * - data block: 4-hex-length plus data
 */
export function encodeRequest(payload: string): Uint8Array {
  const body = new TextEncoder().encode(payload)
  const prefix = body.length.toString(16).padStart(4, '0')
  const out = new Uint8Array(4 + body.length)
  out.set(new TextEncoder().encode(prefix), 0)
  out.set(body, 4)
  return out
}

/**
 * An accumulating buffer — TCP makes no promises about chunk boundaries, so
 * every read works against this buffer and resolves once the requested bytes
 * have arrived.
 *
 * `abort()` (plan 22.1 §4.3) rejects any pending read immediately and marks
 * the queue permanently dead: it exists so a deadline or an `AbortSignal` can
 * unblock a read that is waiting on a peer that will never answer, instead of
 * leaving it parked forever.
 */
class ByteQueue {
  private chunks: Uint8Array[] = []
  private length = 0
  private waiter: { need: number; resolve: (b: Uint8Array) => void; reject: (e: unknown) => void } | null = null
  private ended = false
  private endedError: unknown = null
  private aborted = false
  /**
   * Set by `drain()` (plan 24 §4.1): once active, every later `push()` hands
   * its chunk straight to `onData` instead of accumulating it, so a stream's
   * memory use does not grow with total bytes transferred. `streamedBytes`
   * keeps the `maxBytes` guard meaningful in this mode even though nothing is
   * buffered to measure `this.length` against.
   */
  private streaming: { onData: (chunk: Uint8Array) => void; onEnd: (err?: unknown) => void } | null = null
  private streamedBytes = 0

  constructor(private maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES) {}

  push(chunk: Uint8Array): void {
    if (this.aborted) return // the peer is being ignored on purpose past this point
    if (this.streaming) {
      this.streamedBytes += chunk.length
      if (this.streamedBytes > this.maxBytes) {
        this.abort(new AdbError('E_ADB_OUTPUT_LIMIT', `adb stream output exceeded ${this.maxBytes} bytes`))
        return
      }
      if (chunk.length > 0) this.streaming.onData(chunk)
      return
    }
    this.chunks.push(chunk)
    this.length += chunk.length
    if (this.length > this.maxBytes) {
      this.abort(new AdbError('E_ADB_OUTPUT_LIMIT', `adb output exceeded ${this.maxBytes} bytes`))
      return
    }
    this.flush()
  }

  end(error?: unknown): void {
    if (this.aborted) return
    this.ended = true
    this.endedError = error ?? null
    if (this.streaming) {
      const s = this.streaming
      this.streaming = null
      s.onEnd(this.endedError ?? undefined)
      return
    }
    this.flush()
  }

  /**
   * Reject any pending read right now, and make every future `take()` /
   * `takeUntilEnd()` reject immediately with `err` instead of hanging.
   * Idempotent: the first abort wins, later ones are no-ops.
   */
  abort(err: unknown): void {
    if (this.aborted) return
    this.aborted = true
    this.ended = true
    this.endedError = err
    this.chunks = []
    this.length = 0
    const w = this.waiter
    // Cleared before rejecting: a caller must be able to see this queue is
    // free (rather than "concurrent read") even though it is really dead.
    this.waiter = null
    const s = this.streaming
    this.streaming = null
    if (w) w.reject(err)
    if (s) s.onEnd(err)
  }

  /**
   * Switch to streaming mode (plan 24 §4.1, §3.7): any bytes already
   * buffered (e.g. arrived between `readStatus()` returning and this call)
   * are handed to `onData` first, then every later chunk goes straight
   * through via `push()` above — `takeUntilEnd()`'s accumulate-everything
   * behaviour is bypassed entirely from this point on. Not reachable while a
   * `take()`/`takeUntilEnd()` read is still pending, matching the existing
   * "concurrent read" guard.
   */
  drain(onData: (chunk: Uint8Array) => void, onEnd: (err?: unknown) => void): void {
    if (this.waiter) throw new AdbError('E_ADB_PROTOCOL', 'concurrent read on adb socket')
    if (this.aborted) {
      onEnd(this.endedError ?? undefined)
      return
    }
    if (this.length > 0) {
      const buffered = this.concatAll()
      this.streamedBytes += buffered.length
      onData(buffered)
    }
    if (this.ended) {
      onEnd(this.endedError ?? undefined)
      return
    }
    this.streaming = { onData, onEnd }
  }

  /** Take exactly `n` bytes; rejects if the socket ends or is aborted first. */
  take(n: number): Promise<Uint8Array> {
    if (this.aborted) return Promise.reject(this.endedError)
    if (this.waiter) throw new AdbError('E_ADB_PROTOCOL', 'concurrent read on adb socket')
    return new Promise((resolve, reject) => {
      this.waiter = { need: n, resolve, reject }
      this.flush()
    })
  }

  /** Every remaining byte until the socket closes. */
  takeUntilEnd(): Promise<Uint8Array> {
    if (this.aborted) return Promise.reject(this.endedError)
    if (this.waiter) throw new AdbError('E_ADB_PROTOCOL', 'concurrent read on adb socket')
    return new Promise((resolve, reject) => {
      this.waiter = { need: -1, resolve, reject }
      this.flush()
    })
  }

  private concatAll(): Uint8Array {
    const out = new Uint8Array(this.length)
    let off = 0
    for (const c of this.chunks) {
      out.set(c, off)
      off += c.length
    }
    this.chunks = []
    this.length = 0
    return out
  }

  private flush(): void {
    const w = this.waiter
    if (!w) return
    if (w.need === -1) {
      if (!this.ended) return
      this.waiter = null
      if (this.endedError) w.reject(this.endedError)
      else w.resolve(this.concatAll())
      return
    }
    if (this.length >= w.need) {
      const all = this.concatAll()
      const head = all.subarray(0, w.need)
      const rest = all.subarray(w.need)
      if (rest.length > 0) {
        this.chunks.push(rest)
        this.length = rest.length
      }
      this.waiter = null
      w.resolve(head)
      return
    }
    if (this.ended) {
      this.waiter = null
      w.reject(
        this.endedError ??
          new AdbError('E_ADB_PROTOCOL', `adb socket closed while waiting for ${w.need} bytes (had ${this.length})`),
      )
    }
  }
}

const td = new TextDecoder()

export interface AdbSocketOptions {
  /** How long `connect()` may take before it gives up. Default 2000ms. */
  connectTimeoutMs?: number
  /** Hard cap on buffered bytes; exceeding it ends the queue with E_ADB_OUTPUT_LIMIT. */
  maxBytes?: number
}

export class AdbSocket {
  private closed = false

  private constructor(
    private socket: import('bun').Socket,
    private queue: ByteQueue,
  ) {}

  static async connect(host: string, port: number, opts?: AdbSocketOptions): Promise<AdbSocket> {
    const connectTimeoutMs = opts?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    const queue = new ByteQueue(opts?.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES)

    // Set by whichever of "the connect attempt failed" or "the deadline
    // fired" happens first; both a wedged adb server (never answers) and a
    // refused connection (answers immediately, badly) must reject instead of
    // hanging (plan 22.1 §4.3.1).
    let settleEarly: ((err: unknown) => void) | null = null
    const early = new Promise<never>((_, reject) => {
      settleEarly = reject
    })

    // Bound to the AdbSocket instance below, once it exists — the native
    // `timeout` handler (plan 24 §3.3, §4.1) has to be wired into the
    // `socket:` config passed to `Bun.connect`, which runs before an
    // `AdbSocket` can be constructed around its result. Same forward-ref
    // shape as `settleEarly` above.
    let onNativeTimeout: (() => void) | null = null

    const connecting = Bun.connect({
      hostname: host,
      port,
      socket: {
        data(_s, data) {
          queue.push(new Uint8Array(data))
        },
        close() {
          queue.end()
        },
        error(_s, err) {
          queue.end(err)
        },
        // Without this, a refused connection surfaces only as an unhandled
        // rejection on the connect() promise; routing it through `early`
        // keeps it on the same reject path as the timeout below.
        connectError(_s, err) {
          settleEarly?.(
            new AdbError('E_ADB_CONNECT_TIMEOUT', `could not connect to ${host}:${port}: ${err.message}`, err),
          )
        },
        // Only fires once `setIdleTimeout()` has armed the native timer
        // (streams only, plan 24 §3.3) — a one-shot exec never calls it, so
        // this handler is otherwise dormant.
        timeout(_s) {
          onNativeTimeout?.()
        },
      },
    })
    // A rejection here is already observed via `early`/`Promise.race` below;
    // this second handler only exists to stop Bun from also reporting it as
    // an unhandled rejection.
    connecting.catch(() => {})

    const timer = setTimeout(() => {
      settleEarly?.(
        new AdbError('E_ADB_CONNECT_TIMEOUT', `could not connect to ${host}:${port} within ${connectTimeoutMs}ms`),
      )
    }, connectTimeoutMs)

    try {
      const socket = await Promise.race([connecting, early])
      const adbSocket = new AdbSocket(socket, queue)
      onNativeTimeout = () => adbSocket.handleIdleTimeout()
      return adbSocket
    } catch (err) {
      // Whichever side loses the race must still be cleaned up: a connect
      // that eventually succeeds after we already gave up must not leak the fd.
      connecting.then((s) => s.terminate()).catch(() => {})
      throw err
    } finally {
      clearTimeout(timer)
      settleEarly = null
    }
  }

  send(payload: string): void {
    this.socket.write(encodeRequest(payload))
  }

  /**
   * Write raw bytes with NO smartsocket length-prefix framing — for a
   * connection that has already left the `host:transport:<serial>` +
   * `<service>` handshake and become a plain byte stream (plan 27 §4.1's
   * `openRaw`, used to bridge an adb endpoint stream). Never call this
   * before both handshake `readStatus()`s have resolved.
   */
  write(data: Uint8Array): void {
    this.socket.write(data)
  }

  private async withHandshakeTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new AdbError('E_ADB_HANDSHAKE_TIMEOUT', `no ${what} within ${timeoutMs}ms`)
        this.queue.abort(err)
        reject(err)
      }, timeoutMs)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Read the 4-byte status; throws E_ADB_FAIL (with the server's message) on
   * FAIL. `timeoutMs` is opt-in: pass it for a genuine handshake read (a
   * one-shot exec, `host:version`, ...); omit it for a read that is meant to
   * wait indefinitely for the next event on an already-open, long-lived
   * stream (e.g. `DeviceTracker`'s `host:track-devices` loop, which is closed
   * externally via `close()` rather than by a deadline).
   */
  async readStatus(opts?: { timeoutMs?: number }): Promise<'OKAY'> {
    const read = () => this.queue.take(4)
    const status = td.decode(
      opts?.timeoutMs ? await this.withHandshakeTimeout(read(), opts.timeoutMs, 'adb status') : await read(),
    )
    if (status === 'OKAY') return 'OKAY'
    if (status === 'FAIL') {
      const msg = await this.readBlock(opts)
      throw new AdbError('E_ADB_FAIL', msg)
    }
    throw new AdbError('E_ADB_PROTOCOL', `unexpected adb status: ${JSON.stringify(status)}`)
  }

  /** Read one 4-hex-length block plus its data → a utf8 string. See `readStatus` for `timeoutMs`. */
  async readBlock(opts?: { timeoutMs?: number }): Promise<string> {
    const timeoutMs = opts?.timeoutMs
    const lenHex = td.decode(
      timeoutMs ? await this.withHandshakeTimeout(this.queue.take(4), timeoutMs, 'adb block length') : await this.queue.take(4),
    )
    const len = Number.parseInt(lenHex, 16)
    if (Number.isNaN(len)) throw new AdbError('E_ADB_PROTOCOL', `bad block length: ${JSON.stringify(lenHex)}`)
    if (len === 0) return ''
    return td.decode(
      timeoutMs
        ? await this.withHandshakeTimeout(this.queue.take(len), timeoutMs, 'adb block body')
        : await this.queue.take(len),
    )
  }

  /**
   * Raw output until the server closes the socket (used by shell:/exec:).
   * This has no timeout of its own — it is only safe to call from a caller
   * that has already imposed an absolute deadline on the whole exchange
   * (`AdbClient.exec`/`execOut` do, via `AdbSocket.abort`). Calling it
   * directly against an unbounded peer will hang.
   */
  async readUntilClose(): Promise<Uint8Array> {
    return this.queue.takeUntilEnd()
  }

  /**
   * Switch to streaming mode (plan 24 §4.1): any bytes already buffered are
   * handed to `onData` first, then every later chunk goes straight through
   * without accumulating — the caller (`AdbClient.execStream`) has already
   * imposed its own idle/absolute/byte clocks on top of this. Not safe to
   * call while a `readStatus`/`readBlock`/`readUntilClose` read is still
   * pending — callers stream only after the handshake reads have resolved.
   */
  streamFrom(onData: (chunk: Uint8Array) => void, onEnd: (err?: unknown) => void): void {
    this.queue.drain(onData, onEnd)
  }

  /**
   * Native idle timer (plan 24 §3.3, §4.1 — Bun's `socket.timeout()`,
   * verified in `bun-types@1.3.14`'s `bun.d.ts:5840`). `0` disables it. When
   * it fires, Bun closes the socket itself; this also aborts the queue with
   * `E_ADB_STREAM_IDLE` immediately so a `streamFrom` subscriber (or a
   * pending read) unblocks with a reason more specific than a bare close.
   */
  setIdleTimeout(seconds: number): void {
    this.socket.timeout(seconds)
  }

  private handleIdleTimeout(): void {
    if (this.closed) return
    // Bun closes the underlying socket itself once the `timeout` handler
    // runs — marking this closed up front stops our own close()/abort() from
    // redundantly calling terminate() on a socket that is already on its way
    // down, while still routing the specific idle error through the queue.
    this.closed = true
    this.queue.abort(new AdbError('E_ADB_STREAM_IDLE', `no data received within the idle timeout`))
  }

  /**
   * Force-end this socket right now because of a deadline or an
   * `AbortSignal`: unblocks any pending read with `err` and resets the
   * connection (plan 22.1 §3.5 — terminate, not end).
   */
  abort(err: unknown): void {
    this.queue.abort(err)
    this.close(true)
  }

  /** Idempotent: `force` resets the connection (terminate); otherwise it sends FIN (end). */
  close(force = false): void {
    if (this.closed) return
    this.closed = true
    if (force) this.socket.terminate()
    else this.socket.end()
  }
}
