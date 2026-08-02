import { describe, expect, test } from 'bun:test'
import { createChannelIdAllocator } from './channel-allocator'

describe('ChannelIdAllocator (plan 25 §4.5, §6.6) — proves ids are actually reused, not just counted', () => {
  test('allocate() hands out increasing ids starting at 0', () => {
    const alloc = createChannelIdAllocator()
    expect(alloc.allocate()).toBe(0)
    expect(alloc.allocate()).toBe(1)
    expect(alloc.allocate()).toBe(2)
    expect(alloc.size()).toBe(3)
  })

  test('release() returns to the allocator size — a start/stop cycle leaves it exactly where it started (acceptance #6)', () => {
    const alloc = createChannelIdAllocator()
    expect(alloc.size()).toBe(0)
    const ids = [alloc.allocate(), alloc.allocate(), alloc.allocate()]
    expect(alloc.size()).toBe(3)
    for (const id of ids) alloc.release(id)
    expect(alloc.size()).toBe(0)
  })

  test('a released id is reused on the next allocate() rather than the space growing forever', () => {
    const alloc = createChannelIdAllocator()
    const a = alloc.allocate()
    alloc.release(a)
    const b = alloc.allocate()
    expect(b).toBe(a)
    expect(alloc.size()).toBe(1)
  })

  test('releasing an id that was never allocated is a no-op, not a crash or a double-free', () => {
    const alloc = createChannelIdAllocator()
    alloc.allocate()
    expect(() => alloc.release(9999)).not.toThrow()
    expect(alloc.size()).toBe(1)
    // Releasing the SAME id twice must not let it be handed out twice.
    const id = alloc.allocate()
    alloc.release(id)
    alloc.release(id)
    const seen = new Set<number>()
    for (let i = 0; i < 5; i++) {
      const next = alloc.allocate()
      expect(seen.has(next)).toBe(false)
      seen.add(next)
    }
  })

  test('many start/stop cycles (simulating repeated monitor streams over days) always return to the starting size', () => {
    const alloc = createChannelIdAllocator()
    for (let i = 0; i < 500; i++) {
      const id = alloc.allocate()
      expect(alloc.size()).toBe(1)
      alloc.release(id)
      expect(alloc.size()).toBe(0)
    }
  })

  test('throws E_CHANNEL_EXHAUSTED once the whole 65536 space is allocated and none is free', () => {
    const alloc = createChannelIdAllocator()
    // Allocating the full 16-bit space is slow to do one at a time in a unit
    // test, but the allocator has no shortcut around it — this is the exact
    // behaviour plan 25 §8's risk table calls out ("channel-id leaks exhaust
    // the 16-bit space"), so it is worth proving the ceiling actually bites.
    for (let i = 0; i <= 0xffff; i++) alloc.allocate()
    expect(alloc.size()).toBe(0x10000)
    expect(() => alloc.allocate()).toThrow(/E_CHANNEL_EXHAUSTED|exhausted/i)
  })
})
