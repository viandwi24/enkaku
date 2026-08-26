import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { JobTraceEvent } from '@enkaku/protocol'
import { advancePlayheadMs, useTracePlayback } from './useTracePlayback'

afterEach(cleanup)

/**
 * Plan 130 step 130.6 — play/pause on the job trace timeline. The claims
 * under test are the step's own list: playing advances the playhead over
 * time; the multiplier changes the rate; pause stops it; reaching the end
 * stops it (without wrapping); a scrub during playback pauses.
 *
 * **No real multi-second waits.** `useTracePlayback` takes an injectable
 * `now`/`tickMs` for exactly this reason (see its own doc). Every test below
 * drives a fake clock forward by however much SIMULATED time a case needs —
 * seconds, even a minute — and only ever waits, in real wall-clock terms,
 * for the next real timer tick to fire (`tickMs` is set to a few
 * milliseconds here). The real run time of this whole file stays well under
 * a second.
 */

function ev(over: Partial<JobTraceEvent>): JobTraceEvent {
  return {
    id: 'e',
    jobId: 'job-1',
    seq: 1,
    atMs: 0,
    attempt: 1,
    phase: 'run',
    nodeId: null,
    kind: 'action',
    name: 'tap',
    durationMs: null,
    ok: true,
    errorCode: null,
    meta: null,
    frameHash: null,
    frameStatus: null,
    uiHash: null,
    ...over,
  }
}

/** A fake clock: `now()` reads whatever the test last set with `set()`. */
function fakeClock(start = 0) {
  let t = start
  return { now: () => t, set: (v: number) => (t = v), advance: (d: number) => (t += d) }
}

describe('advancePlayheadMs — the pure tick (plan 130 step 130.6)', () => {
  test('moves by real elapsed time scaled by speed', () => {
    expect(advancePlayheadMs(1_000, 4_000, 1, 100_000)).toBe(5_000)
    expect(advancePlayheadMs(1_000, 4_000, 2, 100_000)).toBe(9_000)
    expect(advancePlayheadMs(1_000, 4_000, 4, 100_000)).toBe(17_000)
  })

  test('clamps at endMs — never overshoots the last event', () => {
    expect(advancePlayheadMs(9_000, 5_000, 4, 10_000)).toBe(10_000)
  })

  test('a non-positive delta is a no-op, never moves the playhead backwards', () => {
    expect(advancePlayheadMs(5_000, 0, 1, 10_000)).toBe(5_000)
    expect(advancePlayheadMs(5_000, -50, 1, 10_000)).toBe(5_000)
  })
})

describe('useTracePlayback — playing advances the playhead over real elapsed time (plan 130 step 130.6)', () => {
  test('honours a real gap — the playhead reaches a point it was never told about directly, only via elapsed time', async () => {
    const events = [
      ev({ id: 'a', seq: 1, atMs: 0, kind: 'phase', name: 'start' }),
      ev({ id: 'b', seq: 2, atMs: 1_000, name: 'tap' }),
      // The long idle gap this step's brief calls out (§0 measured 75s on a
      // real job) — scaled down here only in magnitude, not in kind: nothing
      // else happens on the axis between 1_000 and 76_000.
      ev({ id: 'c', seq: 3, atMs: 76_000, name: 'find' }),
    ]
    const clock = fakeClock(0)
    const { result, unmount } = renderHook(() => useTracePlayback(events, 0, { now: clock.now, tickMs: 4 }))

    act(() => result.current.play())
    expect(result.current.playing).toBe(true)

    // Simulate 4 real SECONDS passing in one jump — proves the axis position
    // is driven by elapsed time, not by an event actually existing there.
    clock.advance(4_000)
    await waitFor(() => expect(result.current.playheadMs).toBeGreaterThanOrEqual(4_000))
    // Still resolves to the nearest event behind it (`b`, at 1_000) — the
    // idle gap moves the CONTINUOUS position without inventing an event.
    expect(result.current.selected).toBe(1)

    unmount()
  })
})

describe('useTracePlayback — the speed multiplier changes the rate (plan 130 step 130.6)', () => {
  test('2x covers twice the axis distance for the same elapsed time', async () => {
    const events = [ev({ id: 'a', atMs: 0 }), ev({ id: 'z', atMs: 1_000_000 })]
    const clock = fakeClock(0)
    const { result, unmount } = renderHook(() => useTracePlayback(events, 0, { now: clock.now, tickMs: 4 }))

    act(() => result.current.play())
    clock.advance(1_000)
    await waitFor(() => expect(result.current.playheadMs).toBeGreaterThanOrEqual(1_000))
    const afterOneSecondAt1x = result.current.playheadMs

    act(() => result.current.setSpeed(2))
    clock.advance(1_000)
    await waitFor(() => expect(result.current.playheadMs).toBeGreaterThanOrEqual(afterOneSecondAt1x + 2_000))

    unmount()
  })
})

describe('useTracePlayback — pause stops it (plan 130 step 130.6)', () => {
  test('the playhead does not move after pause, however much simulated time passes', async () => {
    const events = [ev({ id: 'a', atMs: 0 }), ev({ id: 'z', atMs: 1_000_000 })]
    const clock = fakeClock(0)
    const { result, unmount } = renderHook(() => useTracePlayback(events, 0, { now: clock.now, tickMs: 4 }))

    act(() => result.current.play())
    clock.advance(2_000)
    await waitFor(() => expect(result.current.playheadMs).toBeGreaterThanOrEqual(2_000))

    act(() => result.current.pause())
    expect(result.current.playing).toBe(false)
    const atPause = result.current.playheadMs

    clock.advance(50_000)
    // No fake-timer flush can prove a negative instantly; a short real wait
    // (well under the "no real seconds" line — a few ms) confirms no further
    // tick moved the playhead once paused.
    await new Promise((r) => setTimeout(r, 30))
    expect(result.current.playheadMs).toBe(atPause)
    expect(result.current.playing).toBe(false)

    unmount()
  })
})

describe('useTracePlayback — reaching the end stops it, and it never wraps (plan 130 step 130.6)', () => {
  test('clamps to the last event and flips playing to false on its own', async () => {
    const events = [ev({ id: 'a', atMs: 0 }), ev({ id: 'z', atMs: 1_000 })]
    const clock = fakeClock(0)
    const { result, unmount } = renderHook(() => useTracePlayback(events, 0, { now: clock.now, tickMs: 4 }))

    act(() => result.current.play())
    clock.advance(10_000) // far past the end
    await waitFor(() => expect(result.current.playing).toBe(false))
    expect(result.current.playheadMs).toBe(1_000)
    expect(result.current.selected).toBe(1)

    // It does not silently keep going past the end on a later tick either.
    clock.advance(10_000)
    await new Promise((r) => setTimeout(r, 30))
    expect(result.current.playheadMs).toBe(1_000)
    expect(result.current.playing).toBe(false)

    unmount()
  })

  test('pressing play again after the end restarts from the beginning', async () => {
    const events = [ev({ id: 'a', atMs: 0 }), ev({ id: 'z', atMs: 1_000 })]
    const clock = fakeClock(0)
    const { result, unmount } = renderHook(() => useTracePlayback(events, 0, { now: clock.now, tickMs: 4 }))

    act(() => result.current.play())
    clock.advance(5_000)
    await waitFor(() => expect(result.current.playing).toBe(false))

    act(() => result.current.play())
    expect(result.current.playheadMs).toBe(0)
    expect(result.current.playing).toBe(true)

    unmount()
  })
})

describe('useTracePlayback — a scrub during playback pauses (plan 130 step 130.6)', () => {
  test('select() while playing stops playback and moves the playhead to the chosen event', async () => {
    const events = [ev({ id: 'a', atMs: 0 }), ev({ id: 'b', atMs: 5_000 }), ev({ id: 'z', atMs: 1_000_000 })]
    const clock = fakeClock(0)
    const { result, unmount } = renderHook(() => useTracePlayback(events, 0, { now: clock.now, tickMs: 4 }))

    act(() => result.current.play())
    clock.advance(1_000)
    await waitFor(() => expect(result.current.playheadMs).toBeGreaterThan(0))
    expect(result.current.playing).toBe(true)

    act(() => result.current.select(1)) // the manual scrub — a click, a drag, a keyboard step
    expect(result.current.playing).toBe(false)
    expect(result.current.selected).toBe(1)
    await waitFor(() => expect(result.current.playheadMs).toBe(5_000))

    // And it stays paused — no tick resumes it on its own.
    clock.advance(10_000)
    await new Promise((r) => setTimeout(r, 30))
    expect(result.current.playing).toBe(false)
    expect(result.current.playheadMs).toBe(5_000)

    unmount()
  })
})

describe('useTracePlayback — edge cases', () => {
  test('play() on an empty trace does nothing', () => {
    const { result, unmount } = renderHook(() => useTracePlayback([], 0, { now: () => 0, tickMs: 4 }))
    act(() => result.current.play())
    expect(result.current.playing).toBe(false)
    unmount()
  })
})
