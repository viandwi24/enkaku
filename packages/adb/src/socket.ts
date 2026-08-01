import { AdbError } from './errors'

/**
 * Framing smartsocket adb server (plan 01 §4.2):
 * - request: 4 hex digit lowercase (panjang payload dalam byte) + payload ASCII
 * - status:  4 byte 'OKAY' | 'FAIL' (FAIL diikuti blok 4-hex-length + pesan)
 * - blok data: 4-hex-length + data
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
 * Buffer akumulatif — TCP tidak menjamin chunk boundary, jadi semua read
 * dilakukan terhadap buffer ini, di-resolve begitu byte yang diminta lengkap.
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

  /** Ambil tepat `n` byte; reject kalau socket berakhir sebelum lengkap. */
  take(n: number): Promise<Uint8Array> {
    if (this.waiter) throw new AdbError('E_ADB_PROTOCOL', 'concurrent read on adb socket')
    return new Promise((resolve, reject) => {
      this.waiter = { need: n, resolve, reject }
      this.flush()
    })
  }

  /** Semua byte yang tersisa sampai socket ditutup. */
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

  /** Baca 4 byte status; throw E_ADB_FAIL (dengan pesan server) pada FAIL. */
  async readStatus(): Promise<'OKAY'> {
    const status = td.decode(await this.queue.take(4))
    if (status === 'OKAY') return 'OKAY'
    if (status === 'FAIL') {
      const msg = await this.readBlock()
      throw new AdbError('E_ADB_FAIL', msg)
    }
    throw new AdbError('E_ADB_PROTOCOL', `unexpected adb status: ${JSON.stringify(status)}`)
  }

  /** Baca satu blok 4-hex-length + data → string utf8. */
  async readBlock(): Promise<string> {
    const lenHex = td.decode(await this.queue.take(4))
    const len = Number.parseInt(lenHex, 16)
    if (Number.isNaN(len)) throw new AdbError('E_ADB_PROTOCOL', `bad block length: ${JSON.stringify(lenHex)}`)
    if (len === 0) return ''
    return td.decode(await this.queue.take(len))
  }

  /** Raw output sampai server menutup socket (dipakai shell:). */
  async readUntilClose(): Promise<Uint8Array> {
    return this.queue.takeUntilEnd()
  }

  close(): void {
    this.socket.end()
  }
}
