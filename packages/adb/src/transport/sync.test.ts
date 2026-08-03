import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdbError } from '../errors'
import type { RawStream } from './stream-mux'
import { pullFile, pushFile, statRemote } from './sync'

const te = new TextEncoder()
const td = new TextDecoder()

function encodePacket(id: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length)
  out.set(te.encode(id), 0)
  new DataView(out.buffer).setUint32(4, payload.length, true)
  out.set(payload, 8)
  return out
}

function encodeValuePacket(id: string, value: number): Uint8Array {
  const out = new Uint8Array(8)
  out.set(te.encode(id), 0)
  new DataView(out.buffer).setUint32(4, value, true)
  return out
}

interface ParsedPacket {
  id: string
  payload: Uint8Array
}

/**
 * A scripted fake `sync:` peer (plan 39 §7): parses whatever the module
 * under test writes into whole packets and hands each one to a per-test
 * `handler`, which decides what (if anything) to write back — including
 * splitting a reply across multiple `write` calls mid-frame, to prove the
 * reader in `sync.ts` never assumes a packet arrives in one chunk.
 */
class FakeSyncPeer implements RawStream {
  written: Uint8Array[] = []
  closed = false
  forceClosed = false
  private buffer: Uint8Array[] = []
  private bufferLen = 0
  private onData: ((chunk: Uint8Array) => void) | null = null
  private onEnd: ((err?: unknown) => void) | null = null

  constructor(private handler: (pkt: ParsedPacket, emit: (frame: Uint8Array) => void) => void) {}

  write(chunk: Uint8Array): void {
    this.written.push(chunk)
    this.buffer.push(chunk)
    this.bufferLen += chunk.length
    this.tryParse()
  }

  private tryParse(): void {
    for (;;) {
      if (this.bufferLen < 8) return
      const all = concatAll(this.buffer)
      const id = td.decode(all.subarray(0, 4))
      const arg = new DataView(all.buffer, all.byteOffset, 8).getUint32(4, true)
      // `DONE`'s second header field is a VALUE (the mtime), never a
      // trailing-payload length — the one asymmetry in this otherwise
      // uniform framing. Treating it as a length here (as a real length-
      // bearing packet would need) would make the parser wait forever for
      // an mtime's worth of bytes that will never arrive.
      const len = id === 'DONE' ? 0 : arg
      if (all.length < 8 + len) return
      const payload = id === 'DONE' ? all.subarray(4, 8) : all.subarray(8, 8 + len)
      const rest = all.subarray(8 + len)
      this.buffer = rest.length > 0 ? [rest] : []
      this.bufferLen = rest.length
      this.handler({ id, payload }, (frame) => this.emit(frame))
    }
  }

  private emit(frame: Uint8Array): void {
    this.onData?.(frame)
  }

  /** Split a reply frame into two `onData` deliveries — the chunk-boundary case (plan 39 §7). */
  emitSplit(frame: Uint8Array, at: number): void {
    this.onData?.(frame.subarray(0, at))
    this.onData?.(frame.subarray(at))
  }

  streamFrom(onData: (chunk: Uint8Array) => void, onEnd: (err?: unknown) => void): void {
    this.onData = onData
    this.onEnd = onEnd
  }

  close(force?: boolean): void {
    this.closed = true
    if (force) this.forceClosed = true
    this.onEnd?.()
  }
}

function concatAll(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'enkaku-sync-test-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

describe('pushFile', () => {
  test('encodes SEND with path,mode then DATA/DONE, and resolves on OKAY', async () => {
    await withTempDir(async (dir) => {
      const localPath = join(dir, 'payload.bin')
      const data = new Uint8Array(1000).fill(7)
      await Bun.write(localPath, data)

      const seen: ParsedPacket[] = []
      const peer = new FakeSyncPeer((pkt, emit) => {
        seen.push(pkt)
        if (pkt.id === 'DONE') emit(encodePacket('OKAY', new Uint8Array(0)))
      })

      await pushFile(peer, { localPath, remotePath: '/data/local/tmp/x.bin', mode: 0o644 })

      expect(seen[0]?.id).toBe('SEND')
      expect(td.decode(seen[0]?.payload)).toBe('/data/local/tmp/x.bin,33188') // 0o644 | S_IFREG(0o100000) = 33188
      const dataPackets = seen.filter((p) => p.id === 'DATA')
      expect(dataPackets.length).toBeGreaterThan(0)
      const total = dataPackets.reduce((n, p) => n + p.payload.length, 0)
      expect(total).toBe(1000)
      expect(seen[seen.length - 1]?.id).toBe('DONE')
    })
  })

  test('splits DATA into 64KB chunks for a larger file', async () => {
    await withTempDir(async (dir) => {
      const localPath = join(dir, 'big.bin')
      const size = 64 * 1024 * 3 + 123
      await Bun.write(localPath, new Uint8Array(size).fill(1))

      const dataLens: number[] = []
      const peer = new FakeSyncPeer((pkt, emit) => {
        if (pkt.id === 'DATA') dataLens.push(pkt.payload.length)
        if (pkt.id === 'DONE') emit(encodePacket('OKAY', new Uint8Array(0)))
      })

      let lastSent = 0
      await pushFile(peer, {
        localPath,
        remotePath: '/data/local/tmp/big.bin',
        onProgress: (sent) => {
          lastSent = sent
        },
      })

      expect(dataLens.every((l) => l <= 64 * 1024)).toBe(true)
      expect(dataLens.reduce((a, b) => a + b, 0)).toBe(size)
      expect(lastSent).toBe(size)
    })
  })

  test('rejects with E_ADB_SYNC_FAIL when the peer answers FAIL', async () => {
    await withTempDir(async (dir) => {
      const localPath = join(dir, 'x.bin')
      await Bun.write(localPath, new Uint8Array(10))
      const peer = new FakeSyncPeer((pkt, emit) => {
        if (pkt.id === 'DONE') emit(encodePacket('FAIL', te.encode('no space left on device')))
      })

      await expect(pushFile(peer, { localPath, remotePath: '/data/local/tmp/x.bin' })).rejects.toMatchObject({
        code: 'E_ADB_SYNC_FAIL',
        message: 'no space left on device',
      })
    })
  })

  test('a reply frame split across two writes is still read correctly', async () => {
    await withTempDir(async (dir) => {
      const localPath = join(dir, 'x.bin')
      await Bun.write(localPath, new Uint8Array(5))
      let peer!: FakeSyncPeer
      peer = new FakeSyncPeer((pkt) => {
        if (pkt.id === 'DONE') {
          const frame = encodePacket('OKAY', new Uint8Array(0))
          // Delivered in two pieces, split mid-header — proves the reader
          // never assumes a whole packet arrives in one `onData` call.
          peer.emitSplit(frame, 3)
        }
      })
      await pushFile(peer, { localPath, remotePath: '/data/local/tmp/x.bin' })
    })
  })

  test('cancel mid-transfer aborts and force-closes the stream', async () => {
    await withTempDir(async (dir) => {
      const localPath = join(dir, 'big.bin')
      await Bun.write(localPath, new Uint8Array(64 * 1024 * 5))
      const controller = new AbortController()
      let chunkCount = 0
      const peer = new FakeSyncPeer((pkt) => {
        if (pkt.id === 'DATA') {
          chunkCount++
          if (chunkCount === 2) controller.abort()
        }
      })

      await expect(
        pushFile(peer, { localPath, remotePath: '/data/local/tmp/big.bin', signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'E_ADB_ABORTED' })
      expect(peer.forceClosed).toBe(true)
    })
  })

  test('an already-aborted signal rejects before any bytes move', async () => {
    await withTempDir(async (dir) => {
      const localPath = join(dir, 'x.bin')
      await Bun.write(localPath, new Uint8Array(10))
      const controller = new AbortController()
      controller.abort()
      const peer = new FakeSyncPeer(() => {})
      await expect(
        pushFile(peer, { localPath, remotePath: '/data/local/tmp/x.bin', signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'E_ADB_ABORTED' })
      expect(peer.written.length).toBe(0)
    })
  })
})

describe('pullFile', () => {
  test('RECV then DATA*/DONE round-trips into the local file', async () => {
    await withTempDir(async (dir) => {
      const localPath = join(dir, 'out.bin')
      const payload = new Uint8Array(70000).map((_, i) => i % 251)
      const peer = new FakeSyncPeer((pkt, emit) => {
        if (pkt.id === 'RECV') {
          expect(td.decode(pkt.payload)).toBe('/data/local/tmp/y.bin')
          for (let off = 0; off < payload.length; off += 64 * 1024) {
            emit(encodePacket('DATA', payload.subarray(off, Math.min(off + 64 * 1024, payload.length))))
          }
          emit(encodeValuePacket('DONE', 0))
        }
      })

      let lastReceived = 0
      const result = await pullFile(peer, {
        remotePath: '/data/local/tmp/y.bin',
        localPath,
        maxBytes: 1_000_000,
        onProgress: (r) => {
          lastReceived = r
        },
      })

      expect(result.bytes).toBe(payload.length)
      expect(lastReceived).toBe(payload.length)
      const written = readFileSync(localPath)
      expect(written.length).toBe(payload.length)
      expect(written[0]).toBe(payload[0])
      expect(written[written.length - 1]).toBe(payload[payload.length - 1])
    })
  })

  test('rejects with E_ADB_SYNC_FAIL when the peer answers FAIL', async () => {
    await withTempDir(async (dir) => {
      const peer = new FakeSyncPeer((pkt, emit) => {
        if (pkt.id === 'RECV') emit(encodePacket('FAIL', te.encode('No such file or directory')))
      })
      await expect(
        pullFile(peer, { remotePath: '/nope', localPath: join(dir, 'out.bin'), maxBytes: 1000 }),
      ).rejects.toMatchObject({ code: 'E_ADB_SYNC_FAIL', message: 'No such file or directory' })
    })
  })

  test('aborts mid-stream once the running total exceeds maxBytes (the second cap enforcement)', async () => {
    await withTempDir(async (dir) => {
      const chunk = new Uint8Array(64 * 1024).fill(9)
      const peer = new FakeSyncPeer((pkt, emit) => {
        if (pkt.id === 'RECV') {
          // Sends far more than maxBytes — the growing-file case.
          for (let i = 0; i < 20; i++) emit(encodePacket('DATA', chunk))
          emit(encodeValuePacket('DONE', 0))
        }
      })
      await expect(
        pullFile(peer, { remotePath: '/big', localPath: join(dir, 'out.bin'), maxBytes: 128 * 1024 }),
      ).rejects.toMatchObject({ code: 'E_ADB_PULL_TOO_LARGE' })
    })
  })

  test('cancel mid-transfer stops it and force-closes the stream', async () => {
    await withTempDir(async (dir) => {
      const controller = new AbortController()
      const chunk = new Uint8Array(1024).fill(1)
      const peer = new FakeSyncPeer((pkt, emit) => {
        if (pkt.id === 'RECV') {
          emit(encodePacket('DATA', chunk))
          controller.abort()
          emit(encodePacket('DATA', chunk))
          emit(encodeValuePacket('DONE', 0))
        }
      })
      await expect(
        pullFile(peer, { remotePath: '/x', localPath: join(dir, 'out.bin'), maxBytes: 1_000_000, signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'E_ADB_ABORTED' })
      expect(peer.forceClosed).toBe(true)
    })
  })
})

describe('statRemote', () => {
  /**
   * The real wire format, which is NOT what `encodePacket` produces: a STAT
   * reply is `STAT` plus mode, size and mtime, 16 bytes with no length prefix.
   * The previous fixture used `encodePacket('STAT', payload)`, which prepends a
   * length — so the fake spoke a protocol no device speaks, and agreed with the
   * reader's bug instead of catching it. Verified against a physical device.
   */
  function encodeStatReply(mode: number, size: number, mtime: number): Uint8Array {
    const out = new Uint8Array(16)
    out.set(te.encode('STAT'), 0)
    const view = new DataView(out.buffer)
    view.setUint32(4, mode, true)
    view.setUint32(8, size, true)
    view.setUint32(12, mtime, true)
    return out
  }

  test('parses mode/size/mtime from a real STAT reply', async () => {
    const peer = new FakeSyncPeer((pkt, emit) => {
      if (pkt.id === 'STAT') emit(encodeStatReply(0o100644, 12345, 1700000000))
    })
    const stat = await statRemote(peer, '/data/local/tmp/exists')
    expect(stat).toEqual({ mode: 0o100644, size: 12345, mtime: 1700000000 })
  })

  test('parses a STAT reply delivered one byte at a time', async () => {
    const peer = new FakeSyncPeer((pkt, emit) => {
      if (pkt.id === 'STAT') {
        const reply = encodeStatReply(0o100644, 200000, 1700000000)
        for (const b of reply) emit(new Uint8Array([b]))
      }
    })
    const stat = await statRemote(peer, '/data/local/tmp/exists')
    expect(stat).toEqual({ mode: 0o100644, size: 200000, mtime: 1700000000 })
  })

  test('returns null for a missing path (all-zero STAT, adb convention)', async () => {
    const peer = new FakeSyncPeer((pkt, emit) => {
      if (pkt.id === 'STAT') emit(encodeStatReply(0, 0, 0))
    })
    const stat = await statRemote(peer, '/nope')
    expect(stat).toBeNull()
  })

  test('throws E_ADB_SYNC_FAIL on a FAIL reply', async () => {
    const peer = new FakeSyncPeer((pkt, emit) => {
      if (pkt.id === 'STAT') emit(encodePacket('FAIL', te.encode('permission denied')))
    })
    await expect(statRemote(peer, '/root/secret')).rejects.toMatchObject({ code: 'E_ADB_SYNC_FAIL' })
  })
})

describe('AdbError shape', () => {
  test('is exported and constructible (sanity)', () => {
    const err = new AdbError('E_ADB_SYNC_FAIL', 'x')
    expect(err.code).toBe('E_ADB_SYNC_FAIL')
  })
})
