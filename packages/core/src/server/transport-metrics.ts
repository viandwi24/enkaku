/**
 * The shared `/ws` transport's own health (plan 85 §3.6, §4.6) — this is the
 * measurement half of "measure and make it self-healing" (§5 85.7a): H1 and
 * H2 both explain the field report ("the page loads slowly, closing the tab
 * fixes it"), and only numbers separate them. `bufferedBytes*` and
 * `controlReplyMs*` are the H1 evidence (a control reply queued behind
 * already-buffered H.264); the browser's own developer-tools watchdog-reconnect log is
 * H2's (`packages/studio/src/lib/ws.ts`) — `watchdogReconnects` here is a
 * best-effort SERVER-side proxy only, see its own doc comment below.
 *
 * In-memory only, exactly like `device/adb-metrics.ts` (plan 23 §4.6's "no
 * new table, no retention policy, costs nothing when nobody looks") — a core
 * restart clears it.
 */

/** Mirrors `device/adb-metrics.ts`'s ring size — enough recent samples for a stable p95 without unbounded memory. */
const RING_SIZE = 128

export interface TransportSnapshot {
  connections: number
  bufferedBytesMax: number
  bufferedBytesP95: number
  videoBytesPerSec: number
  controlReplyMsP50: number
  controlReplyMsP95: number
  watchdogReconnects: number
  /** Cumulative since boot (plan 223 §4.7) — never reset on `snapshot()` read, unlike `videoBytesPerSec`'s rolling window. */
  framesDroppedTotal: number
}

export interface TransportMetricsStore {
  /** Sampled every time a video frame's backpressure is checked (`ws-handlers.ts`'s `onFrame`) — the buffer depth sitting in front of every control reply (F15). */
  recordBufferedBytes(n: number): void
  /** Bytes actually written to a video-bearing socket — accumulated into a rate, reset on every `snapshot()` read. */
  recordVideoBytes(n: number): void
  /** Wall time from a client message's arrival to `handleMessage` finishing it — recorded only for messages carrying a correlation id, i.e. ones a `ws.request()` caller is actually waiting on (plan 85 §3.6, tests H1). */
  recordControlReplyMs(ms: number): void
  /**
   * A `/ws` connection opened — `currentConnections` is the live count right
   * after this one was added. `watchdogReconnects` (below) is derived from
   * this, NOT from the client's silence watchdog directly: the server never
   * learns *why* a socket reopened, because `ClientMessage` deliberately
   * carries no such signal (plan 85 §4.6's `heartbeat` is one-way by
   * design). This counts connection CHURN instead — opens beyond the peak
   * concurrency ever observed. A farm that opens N tabs once and leaves them
   * open reads 0; a tab that drops and reconnects three times (for any
   * reason — a watchdog trip, a network blip, a refresh) adds 3.
   */
  noteOpen(currentConnections: number): void
  /**
   * A frame was dropped for backpressure (plan 223 §4.7) — either `ws.send()`
   * returned `0` (R8) or the drop-to-keyframe-under-congestion branch fired.
   * Cumulative; never reset except by a core restart, so `soak.ts` can diff
   * it across an arbitrary run window.
   */
  recordFrameDropped(): void
  snapshot(currentConnections: number): TransportSnapshot
}

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

export function createTransportMetricsStore(): TransportMetricsStore {
  const bufferedBytes = createRing()
  const controlReplyMs = createRing()
  let videoByteAccumulator = 0
  let videoWindowStartedAt = Date.now()
  let totalOpens = 0
  let peakConnections = 0
  let framesDroppedTotal = 0

  return {
    recordBufferedBytes(n) {
      bufferedBytes.push(n)
    },
    recordVideoBytes(n) {
      videoByteAccumulator += n
    },
    recordControlReplyMs(ms) {
      controlReplyMs.push(ms)
    },
    noteOpen(currentConnections) {
      totalOpens += 1
      peakConnections = Math.max(peakConnections, currentConnections)
    },
    recordFrameDropped() {
      framesDroppedTotal += 1
    },
    snapshot(currentConnections) {
      peakConnections = Math.max(peakConnections, currentConnections)

      const buffered = bufferedBytes.values()
      const bufferedSorted = buffered.slice().sort((a, b) => a - b)
      const replySorted = controlReplyMs.values().sort((a, b) => a - b)

      // A rate reset on every read, not an all-time average — this is polled
      // periodically (the §7.3 ladder polls `/api/adb/stats` at 1Hz), so
      // "bytes since the last poll" is the useful number, not a figure that
      // gets smoother and less current the longer the core has been up.
      const now = Date.now()
      const elapsedSec = Math.max(0.001, (now - videoWindowStartedAt) / 1000)
      const videoBytesPerSec = videoByteAccumulator / elapsedSec
      videoByteAccumulator = 0
      videoWindowStartedAt = now

      return {
        connections: currentConnections,
        bufferedBytesMax: bufferedSorted.length > 0 ? (bufferedSorted[bufferedSorted.length - 1] ?? 0) : 0,
        bufferedBytesP95: percentile(bufferedSorted, 0.95),
        videoBytesPerSec,
        controlReplyMsP50: percentile(replySorted, 0.5),
        controlReplyMsP95: percentile(replySorted, 0.95),
        watchdogReconnects: Math.max(0, totalOpens - peakConnections),
        framesDroppedTotal,
      }
    },
  }
}
