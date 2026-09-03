/**
 * Plan 203 §4.9, amended §12 — the browser-side latency estimator. Moved
 * here (from a Studio-only `lib/latency-stats.ts`) because it is pure,
 * deterministic wire-contract logic with no DOM dependency, and it is on
 * plan 200 §8.3's critical-test list ("`packages/protocol` Zod schemas and
 * binary framing — the wire contract between core, Studio, node, plugins").
 * `LatencyOverlay` (Studio) imports it from `@enkaku/protocol` and has no
 * test of its own — Studio has zero tests by decision (plan 200 §8.3).
 */

export const OFFSET_WINDOW = 60
export const SUMMARY_WINDOW = 120

export interface LegSummary {
  median: number
  p95: number
  n: number
}

export interface LatencySummary {
  /** null until OFFSET_WINDOW samples with ptsUs > 0n have been seen. */
  deviceToHost: LegSummary | null
  /** null until OFFSET_WINDOW samples have been seen. */
  hostToBrowser: LegSummary | null
  decode: LegSummary
  decodeToPaint: LegSummary
  queue: LegSummary
  fps: number
  dropped: number
  keyframeRequests: number
  /** Samples seen towards the two offsets, for the "estimating (n/60)" caption. */
  offsetSamples: number
}

/**
 * One decode/paint cycle's timings, or a dropped chunk. Mirrors
 * `packages/studio/src/lib/h264-decoder.ts`'s `DecodeEvent` (plan 203 §4.8)
 * without importing it — Studio depends on `@enkaku/protocol`, not the
 * other way around.
 */
export type LatencyEvent =
  | {
      kind: 'decoded'
      ptsUs: bigint
      hostReceivedAt: number
      browserReceivedAt: number
      /** `performance.now()` just before `decoder.decode()`. */
      submittedAt: number
      /** `decoder.decodeQueueSize` read just before `decoder.decode()`. */
      queueSize: number
      /** `performance.now()` inside the output callback, before `drawImage`. */
      outputAt: number
      /** The `requestAnimationFrame` timestamp of the first animation frame after `drawImage`. */
      paintedAt: number
    }
  | { kind: 'dropped'; reason: 'awaiting-keyframe' | 'no-decoder' }

export interface LatencyEstimator {
  push(event: LatencyEvent): void
  /** A `stream.keyframe` this view sent. */
  noteKeyframeRequest(): void
  /** A gap in `seq` between two `ptsUs > 0n` frames: `gap` frames never reached this browser. */
  noteSeqGap(gap: number): void
  /** New stream (`stream.started`) or the PTS went backwards by more than 1 s: forget both offsets and every window. */
  reset(): void
  summary(now: number): LatencySummary
}

function percentileIndex(n: number, p: number): number {
  return Math.min(n - 1, Math.floor(p * n))
}

function summarizeLeg(samples: number[]): LegSummary {
  const sorted = samples.slice().sort((a, b) => a - b)
  const n = sorted.length
  if (n === 0) return { median: 0, p95: 0, n: 0 }
  return {
    median: sorted[percentileIndex(n, 0.5)] ?? 0,
    p95: sorted[percentileIndex(n, 0.95)] ?? 0,
    n,
  }
}

function pushWindow(window: number[], value: number): void {
  window.push(value)
  if (window.length > SUMMARY_WINDOW) window.shift()
}

export function createLatencyEstimator(): LatencyEstimator {
  let deviceOffsetSamples: number[] = []
  let deviceOffsetMs: number | null = null
  let hostOffsetSamples: number[] = []
  let hostOffsetMs: number | null = null

  let deviceToHostWindow: number[] = []
  let hostToBrowserWindow: number[] = []
  let decodeWindow: number[] = []
  let decodeToPaintWindow: number[] = []
  let queueWindow: number[] = []

  // fps is windowed by wall time (the last 3000ms of paintedAt values), not
  // by sample count, matching LiveView's own 3s fps counter.
  let paintedTimestamps: number[] = []

  let droppedCount = 0
  let keyframeRequestCount = 0
  let lastPtsUs: bigint | null = null

  function reset(): void {
    deviceOffsetSamples = []
    deviceOffsetMs = null
    hostOffsetSamples = []
    hostOffsetMs = null
    deviceToHostWindow = []
    hostToBrowserWindow = []
    decodeWindow = []
    decodeToPaintWindow = []
    queueWindow = []
    paintedTimestamps = []
    droppedCount = 0
    keyframeRequestCount = 0
    lastPtsUs = null
  }

  return {
    push(event) {
      if (event.kind === 'dropped') {
        droppedCount++
        return
      }

      // `1_000_000n`/`0n` are written via `BigInt(...)` rather than literal
      // syntax: Studio's standalone tsconfig targets ES2017 (Next's own
      // requirement), which does not allow BigInt literal syntax even
      // though `bigint` the TYPE is fine — and Studio typechecks this
      // package's source directly (`@enkaku/protocol`'s `exports` points at
      // `src/index.ts`, not a build).
      const zero = BigInt(0)
      if (event.ptsUs > zero && lastPtsUs !== null && event.ptsUs + BigInt(1_000_000) < lastPtsUs) {
        reset()
      }
      if (event.ptsUs > zero) lastPtsUs = event.ptsUs

      // Device→host offset: the minimum over the first OFFSET_WINDOW samples
      // with a real device clock (ptsUs > 0n).
      if (event.ptsUs > zero) {
        const rawDeviceToHost = event.hostReceivedAt - Number(event.ptsUs) / 1000
        if (deviceOffsetMs === null && deviceOffsetSamples.length < OFFSET_WINDOW) {
          deviceOffsetSamples.push(rawDeviceToHost)
          if (deviceOffsetSamples.length === OFFSET_WINDOW) {
            deviceOffsetMs = Math.min(...deviceOffsetSamples)
          }
        }
        if (deviceOffsetMs !== null) {
          pushWindow(deviceToHostWindow, Math.max(0, rawDeviceToHost - deviceOffsetMs))
        }
      }

      // Host→browser offset: the minimum over the first OFFSET_WINDOW
      // samples, regardless of whether this frame carries a device clock —
      // the browser may be on another machine than the host either way.
      const rawHostToBrowser = event.browserReceivedAt - event.hostReceivedAt
      if (hostOffsetMs === null && hostOffsetSamples.length < OFFSET_WINDOW) {
        hostOffsetSamples.push(rawHostToBrowser)
        if (hostOffsetSamples.length === OFFSET_WINDOW) {
          hostOffsetMs = Math.min(...hostOffsetSamples)
        }
      }
      if (hostOffsetMs !== null) {
        pushWindow(hostToBrowserWindow, Math.max(0, rawHostToBrowser - hostOffsetMs))
      }

      pushWindow(decodeWindow, event.outputAt - event.submittedAt)
      pushWindow(decodeToPaintWindow, event.paintedAt - event.outputAt)
      pushWindow(queueWindow, event.queueSize)
      paintedTimestamps.push(event.paintedAt)
    },

    noteKeyframeRequest() {
      keyframeRequestCount++
    },

    noteSeqGap(gap) {
      droppedCount += gap
    },

    reset,

    summary(now) {
      // Trim the fps window to the trailing 3s, matching LiveView's counter.
      paintedTimestamps = paintedTimestamps.filter((t) => now - t <= 3000)
      const offsetSamples = Math.max(deviceOffsetSamples.length, hostOffsetSamples.length)
      return {
        deviceToHost: deviceOffsetMs === null ? null : summarizeLeg(deviceToHostWindow),
        hostToBrowser: hostOffsetMs === null ? null : summarizeLeg(hostToBrowserWindow),
        decode: summarizeLeg(decodeWindow),
        decodeToPaint: summarizeLeg(decodeToPaintWindow),
        queue: summarizeLeg(queueWindow),
        fps: paintedTimestamps.length / 3,
        dropped: droppedCount,
        keyframeRequests: keyframeRequestCount,
        offsetSamples,
      }
    },
  }
}
