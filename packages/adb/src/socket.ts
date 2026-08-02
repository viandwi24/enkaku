import { AdbError } from './errors'

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
 */
class ByteQueue {
  private chunks: Uint8Array[] = []
  private length = 0
  private waiter: { need: number; resolve: (b: Uint8Array) => void; reject: (e: unknown) => void } | null = null
  private ended = false
  private endedError: unknown = null

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk)
    this.length += chunk.length
    this.flush()
  }

  end(error?: unknown): void {
    this.ended = true
    this.endedError = error ?? null
    this.flush()
  }

  /** Take exactly `n` bytes; rejects if the socket ends first. */
  take(n: number): Promise<Uint8Array> {
    if (this.waiter) throw new AdbError('E_ADB_PROTOCOL', 'concurrent read on adb socket')
    return new Promise((resolve, reject) => {
      this.waiter = { need: n, resolve, reject }
      this.flush()
    })
  }

  /** Every remaining byte until the socket closes. */
  takeUntilEnd(): Promise<Uint8Array> {
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

export class AdbSocket {
  private constructor(
    private socket: import('bun').Socket,
    private queue: ByteQueue,
  ) {}

  static async connect(host: string, port: number): Promise<AdbSocket> {
    const queue = new ByteQueue()
    const socket = await Bun.connect({
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
      },
    })
    return new AdbSocket(socket, queue)
  }

  send(payload: string): void {
    this.socket.write(encodeRequest(payload))
  }

  /** Read the 4-byte status; throws E_ADB_FAIL (with the server's message) on FAIL. */
  async readStatus(): Promise<'OKAY'> {
    const status = td.decode(await this.queue.take(4))
    if (status === 'OKAY') return 'OKAY'
    if (status === 'FAIL') {
      const msg = await this.readBlock()
      throw new AdbError('E_ADB_FAIL', msg)
    }
    throw new AdbError('E_ADB_PROTOCOL', `unexpected adb status: ${JSON.stringify(status)}`)
  }

  /** Read one 4-hex-length block plus its data → a utf8 string. */
  async readBlock(): Promise<string> {
    const lenHex = td.decode(await this.queue.take(4))
    const len = Number.parseInt(lenHex, 16)
    if (Number.isNaN(len)) throw new AdbError('E_ADB_PROTOCOL', `bad block length: ${JSON.stringify(lenHex)}`)
    if (len === 0) return ''
    return td.decode(await this.queue.take(len))
  }

  /** Raw output until the server closes the socket (used by shell:). */
  async readUntilClose(): Promise<Uint8Array> {
    return this.queue.takeUntilEnd()
  }

  close(): void {
    this.socket.end()
  }
}
