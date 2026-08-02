import { EnkakuError } from '../util/errors'

/** The channel id space is a u16 (`TunnelChannelOpenMessage.payload.channelId`, protocol/src/tunnel.ts). */
const MAX_CHANNEL_ID = 0xffff

/**
 * A proper allocator for tunnel binary channel ids (plan 25 §4.5, §6.6, §8
 * risks) — freed ids are reused, and `size()` reports how many are currently
 * outstanding so a test can assert it returns to its starting value after a
 * start/stop cycle. Replaces the old `nextChannelId++` counter in
 * `router.ts`, which never reused an id and had no notion of "how many are
 * currently allocated" at all.
 */
export interface ChannelIdAllocator {
  /** Reserves the lowest available id. Throws `E_CHANNEL_EXHAUSTED` if the whole 65536 space is in use. */
  allocate(): number
  /** Idempotent: releasing an id that is not currently allocated is a no-op. */
  release(id: number): void
  /** The number of ids currently allocated. */
  size(): number
}

export function createChannelIdAllocator(): ChannelIdAllocator {
  let next = 0
  const free: number[] = []
  const allocated = new Set<number>()

  return {
    allocate() {
      let id: number
      if (free.length > 0) {
        // Freed ids are handed out LIFO — irrelevant for correctness, just the
        // cheapest structure (a stack) for a free list.
        id = free.pop() as number
      } else {
        if (next > MAX_CHANNEL_ID) {
          throw new EnkakuError('E_CHANNEL_EXHAUSTED', 'no tunnel channel ids remain (the 65536 space is exhausted)')
        }
        id = next++
      }
      allocated.add(id)
      return id
    },

    release(id) {
      if (!allocated.delete(id)) return // not currently allocated — a no-op, never a double-free error
      free.push(id)
    },

    size: () => allocated.size,
  }
}
