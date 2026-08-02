import type { AdbMetric } from '@enkaku/adb'

/** Last N exec latencies plus outcome counts, per adb transport address (plan 23 §4.6). */
const RING_SIZE = 128

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
}

export interface AdbMetricsStore {
  /** Fed straight from `AdbClient`'s `onMetric` hook — one call per settled exec/execOut task. */
  record(m: AdbMetric): void
  /** Everything known about one device's transport address; zeroed out if never observed. */
  forSerial(serial: string): AdbDeviceMetrics
}

interface SerialEntry {
  /** A fixed-size ring — only successful execs are sampled, so a slow timeout does not skew the latency percentiles. */
  samples: number[]
  head: number
  filled: number
  counts: AdbOutcomeCounts
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

  function entryFor(serial: string): SerialEntry {
    let e = perSerial.get(serial)
    if (!e) {
      e = { samples: new Array(RING_SIZE).fill(0) as number[], head: 0, filled: 0, counts: { ok: 0, timeout: 0, busy: 0, error: 0 } }
      perSerial.set(serial, e)
    }
    return e
  }

  return {
    record(m) {
      const e = entryFor(m.serial)
      e.counts[m.outcome]++
      if (m.outcome === 'ok') {
        e.samples[e.head] = m.ms
        e.head = (e.head + 1) % RING_SIZE
        e.filled = Math.min(e.filled + 1, RING_SIZE)
      }
    },

    forSerial(serial) {
      const e = perSerial.get(serial)
      if (!e) return { execMsP50: null, execMsP95: null, counts: { ok: 0, timeout: 0, busy: 0, error: 0 } }
      const sorted = e.samples.slice(0, e.filled).sort((a, b) => a - b)
      return { execMsP50: percentile(sorted, 0.5), execMsP95: percentile(sorted, 0.95), counts: e.counts }
    },
  }
}
