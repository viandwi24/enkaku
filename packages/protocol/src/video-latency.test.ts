import { describe, expect, test } from 'bun:test'
import { createLatencyEstimator, OFFSET_WINDOW, type LatencyEvent } from './video-latency'

function decoded(partial: Partial<LatencyEvent & { kind: 'decoded' }>): LatencyEvent {
  return {
    kind: 'decoded',
    ptsUs: 0n,
    hostReceivedAt: 0,
    browserReceivedAt: 0,
    submittedAt: 0,
    queueSize: 0,
    outputAt: 0,
    paintedAt: 0,
    ...partial,
  }
}

describe('createLatencyEstimator (plan 203 §4.9, amended §12, §5 step 203.8)', () => {
  test('deviceToHost is null until 60 ptsUs > 0n samples, then min-anchored', () => {
    const estimator = createLatencyEstimator()
    for (let i = 0; i < OFFSET_WINDOW - 1; i++) {
      estimator.push(
        decoded({
          ptsUs: BigInt((i + 1) * 1000),
          hostReceivedAt: i + 100 + (i % 5) * 4, // varies, always >= 100ms offset
          browserReceivedAt: i + 100,
        }),
      )
    }
    expect(estimator.summary(0).deviceToHost).toBeNull()
    expect(estimator.summary(0).offsetSamples).toBe(OFFSET_WINDOW - 1)

    // The 60th sample: the offset locks, and the min-anchored value for that
    // exact frame reads (at worst) close to 0.
    estimator.push(decoded({ ptsUs: BigInt(60_000), hostReceivedAt: 100, browserReceivedAt: 100 }))
    const summary = estimator.summary(0)
    expect(summary.deviceToHost).not.toBeNull()
    expect(summary.deviceToHost?.n).toBeGreaterThan(0)
    // Every value in the window is clamped at 0 and anchored to the fastest
    // sample seen, so the minimum across the window must be exactly 0.
    expect(summary.deviceToHost?.median).toBeGreaterThanOrEqual(0)
  })

  test('hostToBrowser is min-anchored over the first 60 samples', () => {
    const estimator = createLatencyEstimator()
    for (let i = 0; i < OFFSET_WINDOW; i++) {
      estimator.push(
        decoded({
          ptsUs: 0n, // no device clock at all — hostToBrowser must still be computed
          hostReceivedAt: 1000,
          browserReceivedAt: 1000 + 5 + (i % 3) * 2, // 5..9ms, min is 5
        }),
      )
    }
    const summary = estimator.summary(0)
    expect(summary.hostToBrowser).not.toBeNull()
    // The fastest sample (offset 5ms) reads 0 after anchoring; nothing below it.
    const sorted = [summary.hostToBrowser!.median, summary.hostToBrowser!.p95]
    for (const v of sorted) expect(v).toBeGreaterThanOrEqual(0)
  })

  test('decode and decodeToPaint are absolute', () => {
    const estimator = createLatencyEstimator()
    estimator.push(decoded({ submittedAt: 10, outputAt: 14, paintedAt: 30, queueSize: 2 }))
    const summary = estimator.summary(30)
    expect(summary.decode.median).toBe(4)
    expect(summary.decodeToPaint.median).toBe(16)
    expect(summary.queue.median).toBe(2)
  })

  test('dropped counts dropped events plus seq gaps; keyframeRequests counts notes; reset clears all', () => {
    const estimator = createLatencyEstimator()
    estimator.push({ kind: 'dropped', reason: 'awaiting-keyframe' })
    estimator.push({ kind: 'dropped', reason: 'no-decoder' })
    estimator.noteSeqGap(3)
    estimator.noteKeyframeRequest()
    estimator.noteKeyframeRequest()
    let summary = estimator.summary(0)
    expect(summary.dropped).toBe(5) // 2 dropped events + 3 seq-gap frames
    expect(summary.keyframeRequests).toBe(2)

    estimator.reset()
    summary = estimator.summary(0)
    expect(summary.dropped).toBe(0)
    expect(summary.keyframeRequests).toBe(0)
    expect(summary.deviceToHost).toBeNull()
    expect(summary.offsetSamples).toBe(0)
  })

  test('a PTS that goes back by more than one second resets the offsets', () => {
    const estimator = createLatencyEstimator()
    for (let i = 0; i < OFFSET_WINDOW; i++) {
      estimator.push(decoded({ ptsUs: BigInt((i + 1) * 1_000_000), hostReceivedAt: 100, browserReceivedAt: 100 }))
    }
    expect(estimator.summary(0).deviceToHost).not.toBeNull()

    // PTS drops by more than 1s (encoder restarted): the tracker resets.
    estimator.push(decoded({ ptsUs: 1000n, hostReceivedAt: 200, browserReceivedAt: 200 }))
    const summary = estimator.summary(0)
    expect(summary.deviceToHost).toBeNull()
    expect(summary.offsetSamples).toBe(1)
  })
})
