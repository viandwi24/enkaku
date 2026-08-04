/**
 * The `shell,v2,raw:<cmd>` wire format (plan 53 §3.3, §4.1), verified against
 * a real device (plan 53 §3.1): each packet is
 * `[id: 1 byte][length: u32 little-endian][payload]`, with `id` one of
 * `0` stdin, `1` stdout, `2` stderr, `3` exit, `4` close-stdin. The exit
 * packet's payload is exactly one byte holding the exit code.
 *
 * This is `raw`, not `pty`: no terminal echo, no CR/LF translation — the
 * payload bytes are exactly what the program wrote.
 */

const ID_STDOUT = 1
const ID_STDERR = 2
const ID_EXIT = 3

/** 1 byte id + 4 byte little-endian length. */
const HEADER_LEN = 5

export interface ShellResult {
  stdout: string
  stderr: string
  /** null when the device could not report one (plan 53 §3.4) — never fabricated. */
  exitCode: number | null
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  if (b.length === 0) return a
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function concatAll(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/**
 * Incremental — TCP chunk boundaries never align with packets, so a header or
 * a payload can arrive split across any number of `push()` calls. Bytes that
 * do not yet form a complete packet stay buffered until the next `push()`.
 */
export class ShellFrameParser {
  private pending: Uint8Array = new Uint8Array(0)
  private stdoutChunks: Uint8Array[] = []
  private stderrChunks: Uint8Array[] = []
  private exitCode: number | null = null
  private readonly decoder = new TextDecoder()

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    this.pending = concat(this.pending, chunk)
    this.drain()
  }

  private drain(): void {
    let offset = 0
    while (this.pending.length - offset >= HEADER_LEN) {
      const id = this.pending[offset] as number
      const view = new DataView(this.pending.buffer, this.pending.byteOffset + offset + 1, 4)
      const len = view.getUint32(0, true)
      const total = HEADER_LEN + len
      if (this.pending.length - offset < total) break // payload not fully arrived yet
      const payload = this.pending.subarray(offset + HEADER_LEN, offset + total)
      switch (id) {
        case ID_STDOUT:
          this.stdoutChunks.push(payload.slice())
          break
        case ID_STDERR:
          this.stderrChunks.push(payload.slice())
          break
        case ID_EXIT:
          this.exitCode = payload.length > 0 ? (payload[0] as number) : null
          break
        default:
          // stdin/close-stdin never arrive from the device on a one-shot exec; ignore anything else too.
          break
      }
      offset += total
    }
    this.pending = offset > 0 ? this.pending.slice(offset) : this.pending
  }

  /** Everything decoded so far, plus the exit code if its packet has arrived. */
  result(): ShellResult {
    return {
      stdout: this.decoder.decode(concatAll(this.stdoutChunks)),
      stderr: this.decoder.decode(concatAll(this.stderrChunks)),
      exitCode: this.exitCode,
    }
  }
}
