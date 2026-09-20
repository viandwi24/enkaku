import { describe, expect, test } from 'bun:test'
import { readDuration, rollUpByDevice, rollUpState, sessionReport } from './warmup-report'
import { WarmupRunSchema, type WarmupRun, type WarmupStepRow } from './warmup-runs'

const step = (over: Partial<WarmupStepRow> = {}): WarmupStepRow => ({
  activityId: over.activityId ?? 'a1',
  title: over.title ?? 'Home feed',
  script: 'youtube/home-feed',
  params: {},
  atSec: over.atSec ?? 0,
  notBeforeAt: over.notBeforeAt ?? 1000,
  state: over.state ?? 'pending',
  jobId: over.jobId ?? null,
  error: over.error ?? null,
  startedAt: over.startedAt ?? null,
  settledAt: over.settledAt ?? null,
})

const run = (over: Partial<WarmupRun> = {}): WarmupRun =>
  WarmupRunSchema.parse({
    version: 1,
    groupId: 'g1',
    deviceId: over.deviceId ?? 'd1',
    deviceName: over.deviceName ?? 'moto g06 power',
    phase: over.phase ?? 0,
    platform: over.platform === undefined ? 'youtube' : over.platform,
    steps: over.steps ?? [step()],
    state: over.state ?? 'pending',
    note: over.note ?? null,
    ...over,
  })

describe('rollUpByDevice', () => {
  test("a phone's phases become one entry, in phase order", () => {
    const rows = [run({ phase: 2, platform: 'tiktok' }), run({ phase: 0, platform: 'youtube' }), run({ phase: 1, platform: 'youtube' })]
    const [device] = rollUpByDevice(rows)
    expect(device?.phases.map((p) => p.phase)).toEqual([0, 1, 2])
    // Each platform once, in the order the phases give them — this is the line
    // the table shows, and repeating "youtube" twice would read as two accounts.
    expect(device?.platforms).toEqual(['youtube', 'tiktok'])
    expect(device?.activities).toBe(3)
  })

  test('two phones stay two entries', () => {
    expect(rollUpByDevice([run({ deviceId: 'a' }), run({ deviceId: 'b' })]).length).toBe(2)
  })

  test('a phone given nothing reads idle, and carries the reason', () => {
    const [device] = rollUpByDevice([run({ steps: [], state: 'skipped', note: 'This phone carries no label for any of this session’s platforms' })])
    expect(device?.idle).toBe(true)
    expect(device?.note).toContain('no label')
  })
})

describe('rollUpState', () => {
  test('one good phase and one bad is partial, never done and never failed', () => {
    expect(rollUpState(['done', 'failed'])).toBe('partial')
  })

  test('answers so far plus something still waiting is running, not partial', () => {
    // `partial` is a verdict on a finished thing. A session with a pending
    // phase has not finished, and calling it partial tells the operator to go
    // and look at a failure that may never happen.
    expect(rollUpState(['done', 'pending'])).toBe('running')
    expect(rollUpState(['failed', 'pending'])).toBe('running')
  })

  test('skipped phases do not drag a working phone down', () => {
    expect(rollUpState(['skipped', 'done'])).toBe('done')
    expect(rollUpState(['skipped', 'skipped'])).toBe('skipped')
  })

  test('nothing at all is pending', () => {
    expect(rollUpState([])).toBe('pending')
  })
})

describe('sessionReport', () => {
  const now = 2_000

  test('counts phones and activities across phases, and separates idle ones', () => {
    const report = sessionReport(
      [
        run({ deviceId: 'a', phase: 0, steps: [step({ state: 'success' }), step({ activityId: 'a2', state: 'failed' })] }),
        run({ deviceId: 'a', phase: 1, steps: [step({ activityId: 'a3', state: 'pending' })] }),
        run({ deviceId: 'b', steps: [], state: 'skipped' }),
      ],
      now,
    )
    expect(report.phones).toBe(2)
    expect(report.working).toBe(1)
    expect(report.idle).toBe(1)
    expect(report.activities).toBe(3)
    expect(report.finished).toBe(false)
  })

  test('nothing settled yet has NO success rate — not a zero one', () => {
    // A session two minutes old with nothing answered has not got a 0% success
    // rate. Rendering one reads as a fleet-wide failure and sends the operator
    // looking for a fault that does not exist.
    const report = sessionReport([run({ steps: [step({ state: 'queued' })] })], now)
    expect(report.successRate).toBeNull()
    expect(report.settled).toBe(0)
  })

  test('the rate is over answers, so skipped activities never count against it', () => {
    const report = sessionReport(
      [run({ steps: [step({ state: 'success' }), step({ activityId: 'a2', state: 'failed' }), step({ activityId: 'a3', state: 'skipped' }), step({ activityId: 'a4', state: 'skipped' })] })],
      now,
    )
    expect(report.settled).toBe(2)
    expect(report.successRate).toBe(0.5)
  })

  test('elapsed runs to now while work is out, and freezes at the last answer once it is not', () => {
    const live = sessionReport([run({ steps: [step({ state: 'success', startedAt: 1_000, settledAt: 1_500 }), step({ activityId: 'a2', state: 'pending' })] })], now)
    expect(live.elapsedSec).toBe(1_000)
    const over = sessionReport([run({ steps: [step({ state: 'success', startedAt: 1_000, settledAt: 1_500 })] })], now)
    expect(over.finished).toBe(true)
    expect(over.elapsedSec).toBe(500)
  })

  test('the last waiting activity is reported as a due time, and a due one reads 0 rather than negative', () => {
    const later = sessionReport([run({ steps: [step({ state: 'pending', notBeforeAt: now + 300 })] })], now)
    expect(later.lastDueInSec).toBe(300)
    const overdue = sessionReport([run({ steps: [step({ state: 'pending', notBeforeAt: now - 300 })] })], now)
    expect(overdue.lastDueInSec).toBe(0)
    const none = sessionReport([run({ steps: [step({ state: 'success' })] })], now)
    expect(none.lastDueInSec).toBeNull()
  })
})

describe('readDuration', () => {
  test('seconds, minutes and hours', () => {
    expect(readDuration(12)).toBe('12s')
    expect(readDuration(200)).toBe('3m 20s')
    expect(readDuration(3_840)).toBe('1h 04m')
  })
})

describe('covered — the phases that actually got a platform', () => {
  test('a phone given nothing in its third phase shows two platforms, not three', () => {
    // The empty phase is bookkeeping that stops the same account being warmed
    // up twice. Drawing it made the table ask a question whose answer is
    // "nothing is wrong" (owner, 2026-09-20).
    const [device] = rollUpByDevice([
      run({ phase: 0, platform: 'youtube' }),
      run({ phase: 1, platform: 'tiktok' }),
      run({ phase: 2, platform: null, steps: [], state: 'skipped', note: 'covered in the earlier phases' }),
    ])
    expect(device?.phases).toHaveLength(3)
    expect(device?.covered.map((p) => p.platform)).toEqual(['youtube', 'tiktok'])
  })
})
