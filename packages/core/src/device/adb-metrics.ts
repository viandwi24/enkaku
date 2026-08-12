import type { AdbMetric } from '@enkaku/adb'

/** Last N exec latencies plus outcome counts, per adb transport address (plan 23 §4.6). */
const RING_SIZE = 128

/**
 * Farm-wide rolling window (plan 88 §3.9, §4.7, fixes F23) — ten 60-second
 * buckets, a 10-minute rolling view, fed from the SAME `record()` call the
 * per-serial counts below already use. F23: the cumulative-since-boot
 * counts below can never answer "has adb *started* timing out" — this can.
 */
const WINDOW_BUCKET_MS = 60_000
const WINDOW_BUCKET_COUNT = 10

export interface AdbOutcomeCounts {
  ok: number
  timeout: number
  busy: number
  error: number
}

export interface AdbDeviceMetrics {
  /** null until at least one successful exec has been observed. */
  execMsP50: number | null
  execMsP95: number | null
  counts: AdbOutcomeCounts
  /**
   * Timeouts in a row, right now, for this transport address — reset to 0
   * by any non-timeout outcome (plan 88 §3.9's "transports-wedged" symptom:
   * one device with a streak like this is a phone, several at once is the
   * server).
   */
  consecutiveTimeouts: number
}

export interface AdbWindow {
  seconds: number
  execs: number
  timeouts: number
  /** 0 when `execs` is 0 — never NaN. */
  timeoutRate: number
}

export interface AdbMetricsStore {
  /** Fed straight from `AdbClient`'s `onMetric` hook — one call per settled exec/execOut task. */
  record(m: AdbMetric): void
  /** Everything known about one device's transport address; zeroed out if never observed. */
  forSerial(serial: string): AdbDeviceMetrics
  /**
   * Outcome counts pooled across EVERY serial over the last `seconds`
   * (clamped to the ring's 10-minute depth) — "is adb itself timing out" is
   * a server-wide question, not a per-device one (plan 88 §3.9's
   * "timeout-storm" symptom).
   */
  window(seconds: number): AdbWindow
}

interface SerialEntry {
  /** A fixed-size ring — only successful execs are sampled, so a slow timeout does not skew the latency percentiles. */
  samples: number[]
  head: number
  filled: number
  counts: AdbOutcomeCounts
  consecutiveTimeouts: number
}

interface WindowBucket {
  /** Which 60s bucket this slot currently holds (`floor(ms / WINDOW_BUCKET_MS)`); `-1` means never written. The ring is reused, not proactively expired — a bucket more than 10 minutes stale is simply overwritten the next time its slot is due, and `window()` below ignores anything too old to belong to the requested range. */
  key: number
  execs: number
  timeouts: number
}

function percentile(sortedSamples: number[], p: number): number | null {
  if (sortedSamples.length === 0) return null
  const idx = Math.min(sortedSamples.length - 1, Math.floor(p * sortedSamples.length))
  return sortedSamples[idx] ?? null
}

/**
 * In-memory only, per plan 23 §4.6 ("no new table, no retention policy, and
 * it costs nothing when nobody looks") — a core restart clears it, exactly
 * like the health tracker's failure counters.
 */
export function createAdbMetricsStore(): AdbMetricsStore {
  const perSerial = new Map<string, SerialEntry>()
  const windowBuckets: WindowBucket[] = Array.from({ length: WINDOW_BUCKET_COUNT }, () => ({ key: -1, execs: 0, timeouts: 0 }))

  function entryFor(serial: string): SerialEntry {
    let e = perSerial.get(serial)
    if (!e) {
      e = {
        samples: new Array(RING_SIZE).fill(0) as number[],
        head: 0,
        filled: 0,
        counts: { ok: 0, timeout: 0, busy: 0, error: 0 },
        consecutiveTimeouts: 0,
      }
      perSerial.set(serial, e)
    }
    return e
  }

  return {
    record(m) {
      const e = entryFor(m.serial)
      e.counts[m.outcome]++
      e.consecutiveTimeouts = m.outcome === 'timeout' ? e.consecutiveTimeouts + 1 : 0
      if (m.outcome === 'ok') {
        e.samples[e.head] = m.ms
        e.head = (e.head + 1) % RING_SIZE
        e.filled = Math.min(e.filled + 1, RING_SIZE)
      }

      const key = Math.floor(Date.now() / WINDOW_BUCKET_MS)
      const bucket = windowBuckets[key % WINDOW_BUCKET_COUNT]!
      if (bucket.key !== key) {
        bucket.key = key
        bucket.execs = 0
        bucket.timeouts = 0
      }
      bucket.execs++
      if (m.outcome === 'timeout') bucket.timeouts++
    },

    forSerial(serial) {
      const e = perSerial.get(serial)
      if (!e) return { execMsP50: null, execMsP95: null, counts: { ok: 0, timeout: 0, busy: 0, error: 0 }, consecutiveTimeouts: 0 }
      const sorted = e.samples.slice(0, e.filled).sort((a, b) => a - b)
      return { execMsP50: percentile(sorted, 0.5), execMsP95: percentile(sorted, 0.95), counts: e.counts, consecutiveTimeouts: e.consecutiveTimeouts }
    },

    window(seconds) {
      const nowKey = Math.floor(Date.now() / WINDOW_BUCKET_MS)
      const requiredBuckets = Math.max(1, Math.min(WINDOW_BUCKET_COUNT, Math.ceil(seconds / (WINDOW_BUCKET_MS / 1000))))
      let execs = 0
      let timeouts = 0
      for (const b of windowBuckets) {
        if (b.key === -1) continue
        if (nowKey - b.key >= requiredBuckets) continue
        execs += b.execs
        timeouts += b.timeouts
      }
      return { seconds, execs, timeouts, timeoutRate: execs > 0 ? timeouts / execs : 0 }
    },
  }
}
