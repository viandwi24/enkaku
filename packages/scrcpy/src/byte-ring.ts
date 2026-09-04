/**
 * A head/tail byte window for a sequential parser (plan 209 §3.2 D1).
 * `push` copies the chunk exactly once; `read`/`skip` advance `head`;
 * the pending bytes are moved to offset 0 only when a push would overrun
 * the end, and the backing array doubles only when the pending bytes plus
 * the chunk exceed the capacity. Never a per-chunk allocation.
 */
export interface ByteRingStats {
  capacity: number
  pending: number
  pushedBytes: number
  /** Bytes copied by `push` (always equal to `pushedBytes`). */
  pushCopiedBytes: number
  /** Bytes moved by compaction. */
  compactionCopiedBytes: number
  compactions: number
  grows: number
}

export class ByteRing {
  private buf: Uint8Array
  private head = 0
  private tail = 0
  private readonly stat: ByteRingStats

  constructor(initialCapacity = 256 * 1024) {
    this.buf = new Uint8Array(initialCapacity)
    this.stat = { capacity: initialCapacity, pending: 0, pushedBytes: 0, pushCopiedBytes: 0, compactionCopiedBytes: 0, compactions: 0, grows: 0 }
  }

  get length(): number {
    return this.tail - this.head
  }

  push(chunk: Uint8Array): void {
    const pending = this.tail - this.head
    if (this.tail + chunk.length > this.buf.length) {
      if (pending + chunk.length > this.buf.length) {
        let cap = this.buf.length
        while (cap < pending + chunk.length) cap *= 2
        const next = new Uint8Array(cap)
        next.set(this.buf.subarray(this.head, this.tail), 0)
        this.buf = next
        this.stat.grows++
        this.stat.capacity = cap
      } else {
        this.buf.copyWithin(0, this.head, this.tail)
        this.stat.compactions++
      }
      this.stat.compactionCopiedBytes += pending
      this.head = 0
      this.tail = pending
    }
    this.buf.set(chunk, this.tail)
    this.tail += chunk.length
    this.stat.pushedBytes += chunk.length
    this.stat.pushCopiedBytes += chunk.length
  }

  /** A DataView over the pending bytes; valid until the next `push`/`read`/`skip`. */
  view(): DataView {
    return new DataView(this.buf.buffer, this.buf.byteOffset + this.head, this.tail - this.head)
  }

  skip(n: number): void {
    if (n > this.length) throw new RangeError(`skip ${n} > pending ${this.length}`)
    this.head += n
    if (this.head === this.tail) this.head = this.tail = 0
  }

  /** Copies `n` bytes out (a packet must never alias the ring) and advances. */
  read(n: number): Uint8Array {
    if (n > this.length) throw new RangeError(`read ${n} > pending ${this.length}`)
    const out = new Uint8Array(this.buf.subarray(this.head, this.head + n))
    this.skip(n)
    return out
  }

  stats(): ByteRingStats {
    return { ...this.stat, pending: this.length }
  }
}
