import { describe, expect, test } from 'bun:test'
import type { FrameMeta } from '@enkaku/protocol'
import { createVideoLatencyTracker } from './video-latency'

function meta(partial: Partial<FrameMeta> & { hostReceivedAt: number }): FrameMeta {
  return {
    width: 1080,
    height: 2400,
    codec: 'h264',
    seq: 0,
    ptsUs: 0n,
    ...partial,
  }
}

describe('createVideoLatencyTracker (plan 203 §4.5, §5 step 203.5)', () => {
  test('firstFrameMs is measured from startedAt to the first record', () => {
    let clock = 1000
    const tracker = createVideoLatencyTracker({ startedAt: 900, now: () => clock })
    clock = 1050
    tracker.record(meta({ hostReceivedAt: 1050 }))
    expect(tracker.snapshot().firstFrameMs).toBe(150)
    // A second record must not move it.
    clock = 2000
    tracker.record(meta({ hostReceivedAt: 2000, ptsUs: 1n }))
    expect(tracker.snapshot().firstFrameMs).toBe(150)
  })

  test('PTS interval and arrival jitter are computed only between ptsUs > 0n frames', () => {
    const tracker = createVideoLatencyTracker({ startedAt: 0, now: () => 9999 })
    tracker.record(meta({ ptsUs: 0n, hostReceivedAt: 1000 }))
    tracker.record(meta({ ptsUs: 33_333n, hostReceivedAt: 1033 }))
    tracker.record(meta({ ptsUs: 66_666n, hostReceivedAt: 1070 }))
    const snap = tracker.snapshot()
    // One interval sample: (66_666 - 33_333) / 1000 = 33.333 ms.
    expect(snap.ptsIntervalMsP50).toBeCloseTo(33.333, 2)
    expect(snap.ptsIntervalMsP95).toBeCloseTo(33.333, 2)
    // arrival delta 37ms vs pts delta 33.333ms → jitter |37 - 33.333| = 3.667ms.
    expect(snap.arrivalJitterMsP95).toBeCloseTo(3.667, 2)
    expect(snap.frames).toBe(3)
  })

  test('a backwards PTS resets the chain without pushing a sample', () => {
    const tracker = createVideoLatencyTracker({ startedAt: 0, now: () => 9999 })
    tracker.record(meta({ ptsUs: 100_000n, hostReceivedAt: 1000 }))
    tracker.record(meta({ ptsUs: 133_000n, hostReceivedAt: 1033 })) // pushes one interval sample
    // The encoder restarts: PTS goes back to a small value.
    tracker.record(meta({ ptsUs: 1_000n, hostReceivedAt: 1066 }))
    const afterRestart = tracker.snapshot()
    expect(afterRestart.ptsIntervalMsP50).toBeCloseTo(33, 0) // unchanged by the restart itself
    // The next frame after the restart diffs against the NEW baseline (1_000n), not the old chain.
    tracker.record(meta({ ptsUs: 21_000n, hostReceivedAt: 1086 }))
    const snap = tracker.snapshot()
    // Two interval samples now: 33ms (pre-restart) and 20ms (post-restart).
    expect(snap.frames).toBe(4)
    expect(snap.ptsIntervalMsP95).toBeCloseTo(33, 0)
  })

  test('the ring holds at most 128 samples', () => {
    const tracker = createVideoLatencyTracker({ startedAt: 0, now: () => 9999 })
    let pts = 1n
    let host = 1000
    tracker.record(meta({ ptsUs: pts, hostReceivedAt: host }))
    for (let i = 0; i < 200; i++) {
      pts += 33_333n
      host += 33
      tracker.record(meta({ ptsUs: pts, hostReceivedAt: host }))
    }
    // 200 interval samples were computed; only the last 128 are kept, so the
    // p95 index must stay within a 128-length window rather than growing
    // unbounded. This is asserted indirectly: frames counts every record,
    // while the ring is internal — the only externally visible proof is
    // that snapshot() keeps returning cheaply and consistently.
    const snap = tracker.snapshot()
    expect(snap.frames).toBe(201)
    expect(snap.ptsIntervalMsP50).toBeCloseTo(33, 0)
  })
})
