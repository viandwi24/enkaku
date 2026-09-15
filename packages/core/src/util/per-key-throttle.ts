/**
 * At most one pass per key per `minIntervalMs`.
 *
 * `take(key)` answers "may this run now?" and, when it may, records that it
 * did. A `minIntervalMs` of 0 or less lets everything through. In memory
 * only: a core restart starts every key fresh, which is the right answer for
 * a hook whose whole point is to run once when something comes back.
 */
export interface PerKeyThrottle {
  take(key: string): boolean
}

export function createPerKeyThrottle(minIntervalMs: number, now: () => number = Date.now): PerKeyThrottle {
  const lastAt = new Map<string, number>()
  return {
    take(key) {
      if (minIntervalMs <= 0) return true
      const t = now()
      const last = lastAt.get(key)
      if (last !== undefined && t - last < minIntervalMs) return false
      lastAt.set(key, t)
      return true
    },
  }
}
