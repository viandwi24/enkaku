import { AdbError } from '../errors'
import type { RawStream } from './stream-mux'

/**
 * The adb `sync:` service protocol (plan 39 §3.2, §4.1) — what `adb push`,
 * `adb pull`, and `adb install`'s staging half all ride on. Distinct from the
 * adbd TRANSPORT wire format in `wire.ts` (24-byte header, CNXN/OPEN/OKAY/
 * WRTE/CLSE): once a `sync:` service stream is open, it carries its OWN much
 * smaller framing — a 4-byte ASCII packet id plus a 4-byte little-endian
 * length, then the payload. `SEND`/`RECV`/`STAT` are requests; `DATA`/`DONE`
 * are used both ways; `OKAY`/`FAIL` are the peer's status replies.
 *
 * This module is pure protocol plus one small internal byte-accumulating
 * reader on top of `RawStream.streamFrom` (the same push-to-pull adapter
 * `AdbSocket`'s private `ByteQueue` is, but generic over any `RawStream` —
 * `AdbClient.openRaw` and the plan 27 cloud endpoint's `createRemoteOpenService`
 * both hand back a `RawStream`, and this module must work against either with
 * no branching). It is exhaustively testable against a scripted fake peer —
 * no adb server, no device (plan 39 §7).
 */

const CHUNK_SIZE = 64 * 1024
const ID_SEND = 'SEND'
const ID_DATA = 'DATA'
const ID_DONE = 'DONE'
const ID_OKAY = 'OKAY'
const ID_FAIL = 'FAIL'
const ID_RECV = 'RECV'
const ID_STAT = 'STAT'

const td = new TextDecoder()
const te = new TextEncoder()

export interface SyncTransfer {
  readonly bytesSent: number
  cancel(): Promise<void>
}

export interface PushFileOptions {
  localPath: string
  remotePath: string
  /** Default 0o644 — the regular-file type bit is added automatically. */
  mode?: number
  onProgress?(sent: number, total: number): void
  signal?: AbortSignal
}

export interface PullFileOptions {
  remotePath: string
  localPath: string
  maxBytes: number
  onProgress?(received: number): void
  signal?: AbortSignal
}

export interface RemoteStat {
  size: number
  mode: number
  mtime: number
}

function decodeText(payload: Uint8Array): string {
  return td.decode(payload)
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

function encodePacket(id: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length)
  out.set(te.encode(id), 0)
  new DataView(out.buffer).setUint32(4, payload.length, true)
  out.set(payload, 8)
  return out
}

/** `DONE`'s "length" field is really a value (the mtime), never followed by a payload. */
function encodeValuePacket(id: string, value: number): Uint8Array {
  const out = new Uint8Array(8)
  out.set(te.encode(id), 0)
  new DataView(out.buffer).setUint32(4, value >>> 0, true)
  return out
}

async function writePacket(stream: RawStream, id: string, payload: Uint8Array): Promise<void> {
  // Awaited: a LOCAL backend resolves synchronously, but a large push must
  // respect socket backpressure or bytes are dropped (see AdbSocket.write).
  await stream.write(encodePacket(id, payload))
}

/**
 * Accumulates bytes pushed through `RawStream.streamFrom` and hands them back
 * on demand via `take(n)` — the pull-based reading interface the sync
 * protocol's request/reply framing needs, built on top of the stream's
 * push-based one. Mirrors `AdbSocket`'s private `ByteQueue` in shape, but
 * lives here because it has to work against any `RawStream`, not just a real
 * `AdbSocket`.
 */
class SyncByteReader {
  private chunks: Uint8Array[] = []
  private length = 0
  private waiter: { need: number; resolve: (b: Uint8Array) => void; reject: (e: unknown) => void } | null = null
  private ended = false
  private endedErr: unknown = null
  private aborted = false

  constructor(stream: RawStream) {
    stream.streamFrom(
      (chunk) => this.push(chunk),
      (err) => this.end(err),
    )
  }

  private push(chunk: Uint8Array): void {
    if (this.aborted || chunk.length === 0) return
    this.chunks.push(chunk)
    this.length += chunk.length
    this.flush()
  }

  private end(err?: unknown): void {
    if (this.aborted) return
    this.ended = true
    this.endedErr = err ?? null
    this.flush()
  }

  /** Rejects any pending read right now and makes every future `take()` reject immediately (plan 39 §7 cancel mid-transfer). */
  abort(err: unknown): void {
    if (this.aborted) return
    this.aborted = true
    this.ended = true
    this.endedErr = err
    const w = this.waiter
    this.waiter = null
    this.chunks = []
    this.length = 0
    if (w) w.reject(err)
  }

  take(n: number): Promise<Uint8Array> {
    if (this.aborted) return Promise.reject(this.endedErr)
    if (this.waiter) return Promise.reject(new AdbError('E_ADB_PROTOCOL', 'concurrent read on a sync stream'))
    return new Promise((resolve, reject) => {
      this.waiter = { need: n, resolve, reject }
      this.flush()
    })
  }

  private flush(): void {
    const w = this.waiter
    if (!w) return
    if (this.length >= w.need) {
      const all = concatChunks(this.chunks)
      const head = all.subarray(0, w.need)
      const rest = all.subarray(w.need)
      this.chunks = rest.length > 0 ? [rest] : []
      this.length = rest.length
      this.waiter = null
      w.resolve(head)
      return
    }
    if (this.ended) {
      this.waiter = null
      w.reject(this.endedErr ?? new AdbError('E_ADB_PROTOCOL', `sync stream closed while waiting for ${w.need} bytes (had ${this.length})`))
    }
  }
}

interface SyncPacket {
  id: string
  payload: Uint8Array
}

async function readPacket(reader: SyncByteReader): Promise<SyncPacket> {
  const header = await reader.take(8)
  const id = decodeText(header.subarray(0, 4))
  if (id === ID_DONE) {
    // `DONE` never carries a trailing payload, regardless of direction: the
    // second header field is a VALUE (the mtime on a push's `DONE`, an
    // ignorable value on a pull's terminating one) — never a length to read
    // further bytes for. Treating it as a length here would misparse (or
    // hang on) a real peer's `DONE`, since that field is routinely a large
    // 32-bit unix timestamp.
    return { id, payload: header.subarray(4, 8) }
  }
  if (id === ID_STAT) {
    // A STAT *reply* is fixed-width and NOT length-prefixed: `STAT` followed by
    // mode, size and mtime — 16 bytes in total. The four bytes after the id are
    // the mode, so reading them as a length makes the reader wait for ~33 000
    // bytes that never arrive. Measured against a real device (moto g06 power,
    // Android 15): `statRemote` hung indefinitely, while push and pull round
    // -tripped correctly. The unit fake had encoded the same wrong assumption,
    // so it agreed with the bug — hence the fixture below now speaks the real
    // wire format.
    //
    // Only the reply is affected; the STAT *request* we send does carry a
    // length-prefixed path, and `writePacket` is unchanged.
    const rest = await reader.take(8)
    const payload = new Uint8Array(12)
    payload.set(header.subarray(4, 8), 0)
    payload.set(rest, 4)
    return { id, payload }
  }
  const len = new DataView(header.buffer, header.byteOffset, 8).getUint32(4, true)
  const payload = len > 0 ? await reader.take(len) : new Uint8Array(0)
  return { id, payload }
}

async function readStatus(reader: SyncByteReader): Promise<void> {
  const { id, payload } = await readPacket(reader)
  if (id === ID_OKAY) return
  if (id === ID_FAIL) throw new AdbError('E_ADB_SYNC_FAIL', decodeText(payload) || 'sync operation failed')
  throw new AdbError('E_ADB_PROTOCOL', `unexpected sync status packet: ${id}`)
}

/** Wires `signal` to interrupt a pending/future read AND terminate the underlying stream — the two things cancel actually needs (plan 39 acceptance #9). */
function withCancel(reader: SyncByteReader, stream: RawStream, signal?: AbortSignal): () => void {
  if (!signal) return () => {}
  const onAbort = () => {
    reader.abort(new AdbError('E_ADB_ABORTED', 'the transfer was cancelled'))
    stream.close(true)
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}

/** Re-chunks a file's own stream into `size`-byte pieces — the sync protocol's `DATA` payload cap, independent of whatever chunking the filesystem happens to hand back. */
async function* chunksOf(file: Blob, size: number): AsyncGenerator<Uint8Array> {
  const reader = file.stream().getReader()
  let buffer = new Uint8Array(0)
  for (;;) {
    const { done, value } = await reader.read()
    if (value && value.length > 0) {
      const combined = new Uint8Array(buffer.length + value.length)
      combined.set(buffer, 0)
      combined.set(value, buffer.length)
      buffer = combined
      while (buffer.length >= size) {
        yield buffer.subarray(0, size)
        buffer = buffer.subarray(size)
      }
    }
    if (done) break
  }
  if (buffer.length > 0) yield buffer
}

/**
 * Push a local file over an already-open `sync:` stream: `SEND` with
 * `<path>,<mode>`, `DATA` chunks capped at 64 KB, `DONE` carrying the mtime,
 * then the peer's `OKAY`/`FAIL`.
 */
export async function pushFile(stream: RawStream, opts: PushFileOptions): Promise<void> {
  const reader = new SyncByteReader(stream)
  const cleanup = withCancel(reader, stream, opts.signal)
  try {
    if (opts.signal?.aborted) throw new AdbError('E_ADB_ABORTED', 'the transfer was cancelled')
    const mode = (opts.mode ?? 0o644) | 0o100000 // S_IFREG — a regular file, matching adb's own client
    const file = Bun.file(opts.localPath)
    const total = file.size
    const pathSpec = `${opts.remotePath},${mode}`
    await writePacket(stream, ID_SEND, te.encode(pathSpec))

    let sent = 0
    for await (const chunk of chunksOf(file, CHUNK_SIZE)) {
      if (opts.signal?.aborted) throw new AdbError('E_ADB_ABORTED', 'the transfer was cancelled')
      await writePacket(stream, ID_DATA, chunk)
      sent += chunk.length
      opts.onProgress?.(sent, total)
    }

    const mtime = Math.floor(Date.now() / 1000)
    await stream.write(encodeValuePacket(ID_DONE, mtime))
    await readStatus(reader)
  } finally {
    cleanup()
  }
}

/**
 * Pull a remote file over an already-open `sync:` stream: `RECV` with the
 * path, then `DATA` chunks until `DONE` (or `FAIL`). The cap is enforced
 * here on the running total — this is the SECOND enforcement plan 39 §3.6
 * requires, complementing `statRemote`'s pre-check in `TransferService`: a
 * file that grows between the two still cannot exceed `maxBytes` because
 * this loop aborts mid-stream the instant it does.
 */
export async function pullFile(stream: RawStream, opts: PullFileOptions): Promise<{ bytes: number }> {
  const reader = new SyncByteReader(stream)
  const cleanup = withCancel(reader, stream, opts.signal)
  const sink = Bun.file(opts.localPath).writer()
  try {
    if (opts.signal?.aborted) throw new AdbError('E_ADB_ABORTED', 'the transfer was cancelled')
    await writePacket(stream, ID_RECV, te.encode(opts.remotePath))

    let received = 0
    for (;;) {
      if (opts.signal?.aborted) throw new AdbError('E_ADB_ABORTED', 'the transfer was cancelled')
      const { id, payload } = await readPacket(reader)
      if (id === ID_DATA) {
        received += payload.length
        if (received > opts.maxBytes) {
          throw new AdbError('E_ADB_PULL_TOO_LARGE', `the remote file exceeded ${opts.maxBytes} bytes while streaming`)
        }
        sink.write(payload)
        opts.onProgress?.(received)
      } else if (id === ID_DONE) {
        break
      } else if (id === ID_FAIL) {
        throw new AdbError('E_ADB_SYNC_FAIL', decodeText(payload) || 'pull failed')
      } else {
        throw new AdbError('E_ADB_PROTOCOL', `unexpected sync packet during pull: ${id}`)
      }
    }
    await sink.end()
    return { bytes: received }
  } catch (err) {
    // `FileSink.end()` returns `number | Promise<number>`, not always a
    // promise — `await` handles either, but a `.catch()` chained directly
    // on it does not, so this is a plain try/catch rather than that.
    try {
      await sink.end()
    } catch {
      // best-effort: the caller already has the real error to report
    }
    throw err
  } finally {
    cleanup()
  }
}

/**
 * `STAT` a remote path. adb's own convention: a path that does not exist
 * comes back as an all-zero `{mode:0,size:0,mtime:0}` triple rather than a
 * `FAIL` — mirrored here as a `null` return so a caller never has to special-case
 * "all zero" as if it were a real, empty, zero-byte file.
 */
export async function statRemote(stream: RawStream, remotePath: string): Promise<RemoteStat | null> {
  const reader = new SyncByteReader(stream)
  await writePacket(stream, ID_STAT, te.encode(remotePath))
  const { id, payload } = await readPacket(reader)
  if (id === ID_FAIL) throw new AdbError('E_ADB_SYNC_FAIL', decodeText(payload) || 'stat failed')
  if (id !== ID_STAT) throw new AdbError('E_ADB_PROTOCOL', `unexpected sync packet for stat: ${id}`)
  if (payload.length < 12) throw new AdbError('E_ADB_PROTOCOL', 'truncated STAT response')
  const view = new DataView(payload.buffer, payload.byteOffset, 12)
  const mode = view.getUint32(0, true)
  const size = view.getUint32(4, true)
  const mtime = view.getUint32(8, true)
  if (mode === 0 && size === 0 && mtime === 0) return null
  return { size, mode, mtime }
}
