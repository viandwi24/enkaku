import type { FrameMeta } from '@enkaku/protocol'

/**
 * Per-entry PTS statistics (plan 203 §4.5), computed where every frame of an
 * open `(deviceId, quality)` entry already passes: `manager.ts`'s
 * `dispatchFrame`. This is the server-side leg of `GET /api/video/latency`
 * (plan 203 §4.7) — in-memory only, cleared on restart, exactly like
 * `packages/core/src/server/transport-metrics.ts`.
 */

/** Mirrors `packages/core/src/server/transport-metrics.ts`'s ring size. */
const RING_SIZE = 128

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length))
  return sortedAsc[idx] ?? 0
}

function createRing(): { push(n: number): void; values(): number[] } {
  const samples = new Array<number>(RING_SIZE).fill(0)
  let head = 0
  let filled = 0
  return {
    push(n) {
      samples[head] = n
      head = (head + 1) % RING_SIZE
      filled = Math.min(filled + 1, RING_SIZE)
    },
    values: () => samples.slice(0, filled),
  }
}

export interface VideoLatencySnapshot {
  /** Frames dispatched since the entry was created (config packets included). */
  frames: number
  /** Entry creation → first dispatched frame, ms; null until one arrived. */
  firstFrameMs: number | null
  /** Consecutive device PTS deltas, ms (the encoder's real frame interval). 0 until two `ptsUs > 0n` frames exist. */
  ptsIntervalMsP50: number
  ptsIntervalMsP95: number
  /** |Δ hostReceivedAt − Δ pts| between consecutive `ptsUs > 0n` frames, ms: how unevenly the host receives an evenly-timed stream. */
  arrivalJitterMsP95: number
  /** `now - hostReceivedAt` of the last frame, ms; null before the first frame. */
  lastFrameAgeMs: number | null
}

export interface VideoLatencyTracker {
  record(meta: FrameMeta): void
  snapshot(): VideoLatencySnapshot
}

export function createVideoLatencyTracker(opts: { startedAt: number; now?: () => number }): VideoLatencyTracker {
  const now = opts.now ?? Date.now
  const ptsInterval = createRing()
  const arrivalJitter = createRing()

  let frames = 0
  let firstFrameMs: number | null = null
  let lastAnyHostReceivedAt: number | null = null
  let lastValidPtsUs: bigint | null = null
  let lastValidHostReceivedAt: number | null = null

  return {
    record(meta) {
      frames++
      if (firstFrameMs === null) firstFrameMs = now() - opts.startedAt
      lastAnyHostReceivedAt = meta.hostReceivedAt

      if (meta.ptsUs > 0n) {
        if (lastValidPtsUs !== null && meta.ptsUs < lastValidPtsUs) {
          // The encoder restarted (a new stream, a rotation re-init): forget
          // the chain rather than pushing a nonsense negative interval.
          lastValidPtsUs = meta.ptsUs
          lastValidHostReceivedAt = meta.hostReceivedAt
        } else if (lastValidPtsUs !== null && lastValidHostReceivedAt !== null) {
          const deltaPtsMs = Number(meta.ptsUs - lastValidPtsUs) / 1000
          const deltaHostMs = meta.hostReceivedAt - lastValidHostReceivedAt
          ptsInterval.push(deltaPtsMs)
          arrivalJitter.push(Math.abs(deltaHostMs - deltaPtsMs))
          lastValidPtsUs = meta.ptsUs
          lastValidHostReceivedAt = meta.hostReceivedAt
        } else {
          // The first ptsUs > 0n sample this tracker has seen: nothing to
          // diff against yet, just establish the baseline.
          lastValidPtsUs = meta.ptsUs
          lastValidHostReceivedAt = meta.hostReceivedAt
        }
      }
    },

    snapshot() {
      const intervalSorted = ptsInterval.values().sort((a, b) => a - b)
      const jitterSorted = arrivalJitter.values().sort((a, b) => a - b)
      return {
        frames,
        firstFrameMs,
        ptsIntervalMsP50: percentile(intervalSorted, 0.5),
        ptsIntervalMsP95: percentile(intervalSorted, 0.95),
        arrivalJitterMsP95: percentile(jitterSorted, 0.95),
        lastFrameAgeMs: lastAnyHostReceivedAt === null ? null : now() - lastAnyHostReceivedAt,
      }
    },
  }
}
