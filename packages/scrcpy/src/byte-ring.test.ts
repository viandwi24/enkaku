import { describe, expect, test } from 'bun:test'
import { ByteRing } from './byte-ring'

describe('ByteRing', () => {
  test('push then read returns the bytes in order across chunk boundaries', () => {
    const ring = new ByteRing(16)
    ring.push(new Uint8Array([1, 2, 3]))
    ring.push(new Uint8Array([4, 5]))
    expect(Array.from(ring.read(5))).toEqual([1, 2, 3, 4, 5])
  })

  test('pushCopiedBytes equals pushedBytes after 1000 pushes', () => {
    const ring = new ByteRing(64)
    for (let i = 0; i < 1000; i++) {
      ring.push(new Uint8Array([i % 256]))
      ring.read(1)
    }
    const stats = ring.stats()
    expect(stats.pushCopiedBytes).toBe(stats.pushedBytes)
    expect(stats.pushedBytes).toBe(1000)
  })

  test('a push that would overrun the end compacts instead of growing when the pending bytes fit', () => {
    const ring = new ByteRing(8)
    ring.push(new Uint8Array([1, 2, 3, 4, 5, 6]))
    ring.skip(5) // pending = 1, tail = 6
    ring.push(new Uint8Array([7, 8, 9])) // tail(6)+3=9 > 8, pending(1)+3=4 <= 8 -> compaction
    expect(ring.stats().compactions).toBe(1)
    expect(ring.stats().grows).toBe(0)
    expect(Array.from(ring.read(4))).toEqual([6, 7, 8, 9])
  })

  test('a push that cannot fit doubles the capacity once', () => {
    const ring = new ByteRing(4)
    ring.push(new Uint8Array([1, 2, 3, 4]))
    ring.push(new Uint8Array([5, 6, 7, 8, 9]))
    const stats = ring.stats()
    expect(stats.grows).toBe(1)
    expect(stats.capacity).toBe(16)
    expect(Array.from(ring.read(9))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test('read past pending throws RangeError', () => {
    const ring = new ByteRing(8)
    ring.push(new Uint8Array([1, 2]))
    expect(() => ring.read(3)).toThrow(RangeError)
  })
})
