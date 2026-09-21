import { describe, expect, test } from 'bun:test'
import { PostSchema, type Attempt, type Post } from './posts'
import { holdKey, holdOf, resumeWarmupRow, stopMarkerOf, stopPostRow, stopWarmupRow } from './session-control'
import { WarmupRowSchema, type WarmupRow, type WarmupStepRow } from './warmup-rows'

const attempt = (over: Partial<Attempt>): Attempt => ({
  jobId: over.jobId ?? 'j1',
  deviceId: over.deviceId ?? 'd1',
  deviceName: null,
  state: over.state ?? 'queued',
  error: null,
  at: 100,
  startedAt: 100,
  settledAt: null,
  round: over.round ?? 1,
  ...over,
})

const post = (attempts: Attempt[]): Post =>
  PostSchema.parse({
    version: 1,
    videoArtifactId: 'v1',
    caption: 'hi',
    platforms: ['youtube'],
    createdAt: 1,
    dispatch: { youtube: { state: 'dispatched', at: 1, attempts, history: [], deviceCount: attempts.length, note: null } },
    lastNote: null,
  })

const step = (over: Partial<WarmupStepRow>): WarmupStepRow => ({
  activityId: over.activityId ?? 'a1',
  title: 'Home feed',
  script: 'youtube/home-feed',
  params: {},
  atSec: over.atSec ?? 0,
  notBeforeAt: over.notBeforeAt ?? 1_000,
  state: over.state ?? 'pending',
  jobId: over.jobId ?? null,
  error: null,
  startedAt: over.startedAt ?? null,
  settledAt: null,
})

const run = (steps: WarmupStepRow[]): WarmupRow =>
  WarmupRowSchema.parse({ version: 1, groupId: 'g1', deviceId: 'd1', platform: 'youtube', steps })

describe('stopPostRow', () => {
  test('an attempt still out is cancelled, retired, and owed again', () => {
    const { row, cancel, pulled } = stopPostRow(post([attempt({ jobId: 'j7', state: 'queued' })]), 500)
    expect(cancel).toEqual(['j7'])
    expect(pulled).toBe(1)
    const state = row.dispatch.youtube
    expect(state?.attempts).toEqual([])
    // Retired, not erased: "did this phone already open the app?" is the first
    // question after a stop, and an empty row cannot answer it.
    expect(state?.history).toHaveLength(1)
    expect(state?.history[0]?.error).toContain('stopped')
    expect(state?.state).toBe('pending')
  })

  test('an answer that already happened is never rewritten', () => {
    // Above all a success: reversing one would send the same video twice.
    const { row, cancel, pulled } = stopPostRow(post([attempt({ jobId: 'ok', state: 'success' }), attempt({ jobId: 'bad', state: 'failed', deviceId: 'd2' })]), 500)
    expect(cancel).toEqual([])
    expect(pulled).toBe(0)
    expect(row.dispatch.youtube?.attempts).toHaveLength(2)
  })

  test('a row with nothing out comes back identical, so a stop writes nothing it need not', () => {
    const before = post([attempt({ state: 'success' })])
    expect(stopPostRow(before, 500).row).toBe(before)
  })

  test('two platforms sharing one job cancel it once', () => {
    const both = PostSchema.parse({
      version: 1,
      videoArtifactId: 'v1',
      caption: 'hi',
      platforms: ['youtube', 'tiktok'],
      createdAt: 1,
      dispatch: {
        youtube: { state: 'dispatched', at: 1, attempts: [attempt({ jobId: 'shared' })], history: [], deviceCount: 1, note: null },
        tiktok: { state: 'dispatched', at: 1, attempts: [attempt({ jobId: 'shared' })], history: [], deviceCount: 1, note: null },
      },
      lastNote: null,
    })
    expect(stopPostRow(both, 500).cancel).toEqual(['shared'])
  })
})

describe('stopWarmupRow', () => {
  test('a queued activity goes back to owing, with its job forgotten', () => {
    const { row, cancel, pulled } = stopWarmupRow(run([step({ activityId: 'a1', state: 'queued', jobId: 'j3', startedAt: 400 })]), 500)
    expect(cancel).toEqual(['j3'])
    expect(pulled).toBe(1)
    expect(row.steps[0]?.state).toBe('pending')
    // A row still naming a job nobody will answer for would wait for ever.
    expect(row.steps[0]?.jobId).toBeNull()
    expect(row.steps[0]?.startedAt).toBeNull()
  })

  test('a sequence sharing one job cancels it once and pulls back every step on it', () => {
    const { cancel, pulled, row } = stopWarmupRow(
      run([step({ activityId: 'a1', state: 'queued', jobId: 'w1' }), step({ activityId: 'a2', state: 'queued', jobId: 'w1' })]),
      500,
    )
    expect(cancel).toEqual(['w1'])
    expect(pulled).toBe(2)
    expect(row.steps.every((s) => s.state === 'pending')).toBe(true)
  })

  test('activities that already answered are left exactly as they are', () => {
    const { row, pulled } = stopWarmupRow(run([step({ activityId: 'a1', state: 'success' }), step({ activityId: 'a2', state: 'failed' })]), 500)
    expect(pulled).toBe(0)
    expect(row.steps.map((s) => s.state)).toEqual(['success', 'failed'])
  })
})

describe('resumeWarmupRow', () => {
  test('the gaps the operator chose survive a long stop', () => {
    // Three activities a minute apart, started again two hours late. They must
    // still be a minute apart — a warm-up firing four activities back to back
    // on one phone is the exact shape a platform looks for.
    const now = 100_000
    const resumed = resumeWarmupRow(
      run([step({ activityId: 'a1', state: 'pending', notBeforeAt: 1_000 }), step({ activityId: 'a2', state: 'pending', notBeforeAt: 1_060 }), step({ activityId: 'a3', state: 'pending', notBeforeAt: 1_120 })]),
      now,
    )
    expect(resumed.steps.map((s) => s.notBeforeAt)).toEqual([now, now + 60, now + 120])
  })

  test('an activity that already answered keeps its stamp', () => {
    const resumed = resumeWarmupRow(run([step({ activityId: 'a1', state: 'success', notBeforeAt: 1_000 }), step({ activityId: 'a2', state: 'pending', notBeforeAt: 1_060 })]), 100_000)
    expect(resumed.steps[0]?.notBeforeAt).toBe(1_000)
  })

  test('a session started again inside its own pacing keeps the plan it had', () => {
    // Nothing overdue means nothing to re-base, and shifting anyway would push
    // the whole plan later every time somebody pressed stop and start.
    const before = run([step({ activityId: 'a1', state: 'pending', notBeforeAt: 5_000 })])
    expect(resumeWarmupRow(before, 1_000)).toBe(before)
  })

  test('a finished run is returned untouched', () => {
    const before = run([step({ activityId: 'a1', state: 'success' })])
    expect(resumeWarmupRow(before, 100_000)).toBe(before)
  })
})

describe('a start spread across the fleet (0.63.0)', () => {
  test('a phone given an offset starts that much later, and keeps its gaps', () => {
    const now = 100_000
    const resumed = resumeWarmupRow(run([step({ activityId: 'a1', state: 'pending', notBeforeAt: 1_000 }), step({ activityId: 'a2', state: 'pending', notBeforeAt: 1_060 })]), now, 45)
    expect(resumed.steps.map((s) => s.notBeforeAt)).toEqual([now + 45, now + 105])
  })

  test('a negative offset is read as none', () => {
    const resumed = resumeWarmupRow(run([step({ activityId: 'a1', state: 'pending', notBeforeAt: 1_000 })]), 100_000, -30)
    expect(resumed.steps[0]?.notBeforeAt).toBe(100_000)
  })
})

describe('stopMarkerOf', () => {
  test('a marker from before 0.63.0 is still an operator stop', () => {
    expect(stopMarkerOf({ version: 1, at: 5 })).toEqual({ version: 1, at: 5, by: 'operator', reason: '' })
  })

  test('the router\'s own pause keeps its reason', () => {
    expect(stopMarkerOf({ version: 1, at: 5, by: 'auto', reason: 'why' })).toEqual({ version: 1, at: 5, by: 'auto', reason: 'why' })
  })

  test('something that is not a marker at all is still read as a stop, never thrown on', () => {
    expect(stopMarkerOf(null).by).toBe('operator')
  })
})

describe('hold keys — one device group paused inside a run (0.64.0)', () => {
  test('round-trip', () => {
    expect(holdOf(holdKey('g-1', 'r-2', 'grp-3'))).toEqual({ runKey: 'g-1:r-2', deviceGroupId: 'grp-3' })
  })

  test('anything else is not a hold', () => {
    expect(holdOf('stop:g-1:r-2')).toBeNull()
    expect(holdOf('hold:g-1:r-2')).toBeNull()
  })

  test('a Ready marker is read as ready', () => {
    expect(stopMarkerOf({ version: 1, at: 1, by: 'ready', reason: '' }).by).toBe('ready')
  })
})
