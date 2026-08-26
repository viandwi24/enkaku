import { describe, expect, test } from 'bun:test'
import type { JobTraceEvent } from '@enkaku/protocol'
import {
  capturePolicyAt,
  compareTraceEvents,
  describeCapturePolicy,
  explainEmptyActionLane,
  failingEventIndex,
  frameEventAt,
  frameStatusCounts,
  nearestEventIndex,
  previousFrameEventAt,
  sortTraceEvents,
} from './useJobTrace'

/**
 * The Timeline's pure model (plan 128 §4.3, §3.4, step 128.8). Kept out of
 * the component tests deliberately: the ordering rule is the one thing in
 * this tab that is a genuine correctness bug rather than a layout choice,
 * and it should be provable without a DOM.
 */

function ev(over: Partial<JobTraceEvent>): JobTraceEvent {
  return {
    id: 'e',
    jobId: 'job-1',
    seq: 1,
    atMs: 1_000,
    attempt: 1,
    phase: 'run',
    nodeId: null,
    kind: 'log',
    name: 'info',
    durationMs: null,
    ok: null,
    errorCode: null,
    meta: null,
    frameHash: null,
    frameStatus: null,
    uiHash: null,
    ...over,
  }
}

describe('trace ordering — (atMs, seq), never seq alone (plan 128 §4.3, §10 item 4)', () => {
  /**
   * The real shape of the bug: an `action` is held until its screenshot
   * settles, so it reaches the recorder — and is NUMBERED — after a log line
   * that happened DURING it. Here the action happened first (`atMs` 1000)
   * and arrived last (`seq` 9). `seq` order and `atMs` order genuinely
   * disagree, which is what makes this fixture worth having.
   */
  const action = ev({ id: 'action', kind: 'action', name: 'tap', atMs: 1_000, seq: 9 })
  const during = ev({ id: 'log-a', kind: 'log', name: 'info', atMs: 1_050, seq: 7 })
  const after = ev({ id: 'log-b', kind: 'log', name: 'info', atMs: 1_120, seq: 8 })

  test('sorts the captured action BEFORE the log lines it produced', () => {
    expect(sortTraceEvents([during, after, action]).map((e) => e.id)).toEqual(['action', 'log-a', 'log-b'])
  })

  test('sorting by seq alone would get it wrong — the fixture really does disagree', () => {
    const bySeq = [during, after, action].sort((a, b) => a.seq - b.seq).map((e) => e.id)
    expect(bySeq).toEqual(['log-a', 'log-b', 'action'])
    expect(bySeq).not.toEqual(sortTraceEvents([during, after, action]).map((e) => e.id))
  })

  test('seq breaks a tie two events in the same millisecond cannot break themselves', () => {
    const a = ev({ id: 'a', atMs: 500, seq: 2 })
    const b = ev({ id: 'b', atMs: 500, seq: 1 })
    expect(sortTraceEvents([a, b]).map((e) => e.id)).toEqual(['b', 'a'])
    expect(compareTraceEvents(a, b)).toBeGreaterThan(0)
  })

  test('the input array is never mutated', () => {
    const input = [after, action]
    sortTraceEvents(input)
    expect(input.map((e) => e.id)).toEqual(['log-b', 'action'])
  })
})

describe('the capture-policy line comes from the phase start event (plan 128 §3.4)', () => {
  const uiServerStart = ev({
    id: 'p1',
    kind: 'phase',
    name: 'start',
    phase: 'prepare',
    atMs: 0,
    seq: 1,
    meta: { inspectorEngineId: 'ui-server', framePolicy: 'per-action' },
  })
  const dumpStart = ev({
    id: 'p2',
    kind: 'phase',
    name: 'start',
    phase: 'run',
    atMs: 500,
    seq: 5,
    meta: { inspectorEngineId: 'uiautomator-dump', framePolicy: 'on-failure' },
  })

  test('ui-server reads "Frames: per action (ui-server)"', () => {
    expect(describeCapturePolicy(capturePolicyAt([uiServerStart], 0))).toBe('Frames: per action (ui-server)')
  })

  test('uiautomator-dump reads "Frames: on failure only (uiautomator-dump)"', () => {
    expect(describeCapturePolicy(capturePolicyAt([dumpStart], 0))).toBe('Frames: on failure only (uiautomator-dump)')
  })

  test('a mid-run fallback is read PER PHASE — the playhead decides which line shows', () => {
    const events = [uiServerStart, ev({ id: 'a', kind: 'action', name: 'tap', atMs: 200, seq: 2 }), dumpStart]
    expect(describeCapturePolicy(capturePolicyAt(events, 1))).toBe('Frames: per action (ui-server)')
    expect(describeCapturePolicy(capturePolicyAt(events, 2))).toBe('Frames: on failure only (uiautomator-dump)')
  })

  /**
   * The hole §10 item 2 records: a job that fails in `prepare` has ZERO
   * action events, so the line cannot be derived from `frameStatus`. It is
   * still answerable here, because the phase event carries it.
   */
  test('a job with no action events at all still gets a policy line', () => {
    const events = [uiServerStart, ev({ id: 'l', kind: 'log', name: 'error', atMs: 10, seq: 2 })]
    expect(events.some((e) => e.kind === 'action')).toBe(false)
    expect(describeCapturePolicy(capturePolicyAt(events, events.length - 1))).toBe('Frames: per action (ui-server)')
  })

  test('a node-owned (cloud) job says so, rather than claiming a policy it never had', () => {
    const remote = ev({ id: 'r', kind: 'phase', name: 'start', atMs: 0, seq: 1, meta: { remote: true } })
    const policy = capturePolicyAt([remote], 0)
    expect(describeCapturePolicy(policy)).toContain('cloud node')
    expect(explainEmptyActionLane([remote], policy)).toContain('cloud node')
  })

  test('no phase event at all degrades to a plain sentence, never a crash', () => {
    expect(capturePolicyAt([], 0)).toBeNull()
    expect(describeCapturePolicy(null)).toContain('not recorded')
  })

  test('an action lane that is NOT empty needs no explanation', () => {
    const events = [uiServerStart, ev({ id: 'a', kind: 'action', name: 'tap', atMs: 5, seq: 2 })]
    expect(explainEmptyActionLane(events, capturePolicyAt(events, 1))).toBeNull()
  })
})

describe('the scrubber resolves to the nearest event by TIME', () => {
  const events = [ev({ id: 'a', atMs: 0, seq: 1 }), ev({ id: 'b', atMs: 1_000, seq: 2 }), ev({ id: 'c', atMs: 5_000, seq: 3 })]

  test('picks the closest, not the one at the same fraction of the index', () => {
    expect(nearestEventIndex(events, 900)).toBe(1)
    expect(nearestEventIndex(events, 4_000)).toBe(2)
    expect(nearestEventIndex(events, -50)).toBe(0)
  })

  test('a tie goes to the earlier event, so dragging across it does not flicker', () => {
    expect(nearestEventIndex(events, 500)).toBe(0)
  })

  test('an empty trace answers -1 rather than 0 — there is no event to select', () => {
    expect(nearestEventIndex([], 10)).toBe(-1)
  })
})

describe('frames at the playhead, and what is missing (goal 6)', () => {
  const events = [
    ev({ id: 'f1', kind: 'action', name: 'tap', atMs: 0, seq: 1, frameHash: 'a'.repeat(64), frameStatus: 'ok' }),
    ev({ id: 'l1', kind: 'log', name: 'info', atMs: 100, seq: 2 }),
    ev({ id: 'f2', kind: 'action', name: 'find', atMs: 200, seq: 3, frameHash: 'b'.repeat(64), frameStatus: 'ok' }),
    ev({ id: 'busy', kind: 'action', name: 'tap', atMs: 300, seq: 4, frameStatus: 'skipped-busy' }),
    ev({ id: 'bad', kind: 'action', name: 'tap', atMs: 400, seq: 5, frameStatus: 'failed' }),
  ]

  test('a log line shows the most recent frame BEFORE it', () => {
    expect(frameEventAt(events, 1)?.id).toBe('f1')
  })

  test('the before/after toggle resolves to the frame one step earlier', () => {
    expect(frameEventAt(events, 2)?.id).toBe('f2')
    expect(previousFrameEventAt(events, 2)?.id).toBe('f1')
    expect(previousFrameEventAt(events, 0)).toBeNull()
  })

  test('skipped and failed captures are counted, never dropped', () => {
    expect(frameStatusCounts(events)).toEqual({ ok: 2, 'skipped-policy': 0, 'skipped-busy': 1, failed: 1 })
  })
})

describe('a failed job opens on the failing event', () => {
  test('the first failure wins, whether it is a failed action or an error event', () => {
    const events = [
      ev({ id: 'a', kind: 'action', name: 'tap', atMs: 0, seq: 1, ok: true }),
      ev({ id: 'b', kind: 'action', name: 'find', atMs: 10, seq: 2, ok: false, errorCode: 'not-found' }),
      ev({ id: 'c', kind: 'error', name: 'error', atMs: 20, seq: 3 }),
    ]
    expect(failingEventIndex(events)).toBe(1)
  })

  test('a job where nothing failed has no failing event', () => {
    expect(failingEventIndex([ev({ ok: true })])).toBeNull()
  })
})
