import { describe, expect, test } from 'bun:test'
import type { RouterDevice } from './posts'
import { admitRow, isAdmitted, isRunning, phoneQueueStatus, planAdmissions, queueCounts, stableGap, type QueueRow, type QueueStep } from './warmup-queue'

const NOW = 1_800_000_000

const online = (id: string): RouterDevice => ({ id, stableId: id, status: 'online', activities: [], labels: [], inUse: { control: false, viewers: 0 }, lastControl: null })
const offline = (id: string): RouterDevice => ({ ...online(id), status: 'offline' })
const fleet = (...devices: RouterDevice[]): Map<string, RouterDevice> => new Map(devices.map((d) => [d.id, d]))

const pending = (notBeforeAt: number): QueueStep => ({ state: 'pending', notBeforeAt, startedAt: null, settledAt: null })
const queued = (at: number): QueueStep => ({ state: 'queued', notBeforeAt: at, startedAt: at, settledAt: null })
const success = (at: number): QueueStep => ({ state: 'success', notBeforeAt: at - 60, startedAt: at - 60, settledAt: at })

/** A row the queue has not let out yet: two activities, a gap of 30 s between them. */
const waitingRow = (deviceId: string, queueSeq: number, phase = 0, dueAt = NOW - 3_600): QueueRow => ({
  deviceId,
  phase,
  queueSeq,
  admittedAt: null,
  steps: [pending(dueAt), pending(dueAt + 30)],
})
const runningRow = (deviceId: string, admittedAt = NOW - 600): QueueRow => ({
  deviceId,
  phase: 0,
  queueSeq: 0,
  admittedAt,
  steps: [queued(admittedAt), pending(admittedAt + 30)],
})

const NO_GAP = { maxParallel: 8, startGapSec: [0, 0] as const }

describe('the cap: never more than maxParallel at once', () => {
  test('ten phones ready, a cap of three, no gap: three go', () => {
    const rows = Array.from({ length: 10 }, (_, i) => waitingRow(`d${i}`, i))
    const plan = planAdmissions({ rows, devices: fleet(...rows.map((r) => online(r.deviceId))), holding: new Set(), now: NOW, settings: { ...NO_GAP, maxParallel: 3 }, runKey: 'g:r' })
    expect(plan.admit.map((r) => r.deviceId)).toEqual(['d0', 'd1', 'd2'])
  })

  test('places already taken count: two running under a cap of three leaves one place', () => {
    const rows = [runningRow('a'), runningRow('b'), waitingRow('c', 1), waitingRow('d', 2)]
    const plan = planAdmissions({ rows, devices: fleet(online('a'), online('b'), online('c'), online('d')), holding: new Set(['a', 'b']), now: NOW, settings: { ...NO_GAP, maxParallel: 3 }, runKey: 'g:r' })
    expect(plan.admit.map((r) => r.deviceId)).toEqual(['c'])
  })

  test('a full queue lets nothing out, however overdue the rest is', () => {
    const rows = [runningRow('a'), waitingRow('b', 1, 0, NOW - 86_400)]
    expect(planAdmissions({ rows, devices: fleet(online('a'), online('b')), holding: new Set(['a']), now: NOW, settings: { ...NO_GAP, maxParallel: 1 }, runKey: 'g:r' }).admit).toEqual([])
  })
})

describe('first in, first out — and a phone that cannot go does not hold up the rest', () => {
  test('the queue order is the run\'s shuffle, not the order the rows were read', () => {
    const rows = [waitingRow('late', 5), waitingRow('first', 0), waitingRow('second', 1)]
    const plan = planAdmissions({ rows, devices: fleet(online('late'), online('first'), online('second')), holding: new Set(), now: NOW, settings: { ...NO_GAP, maxParallel: 2 }, runKey: 'g:r' })
    expect(plan.admit.map((r) => r.deviceId)).toEqual(['first', 'second'])
  })

  test('an offline phone is passed over, named, and keeps its place', () => {
    const rows = [waitingRow('away', 0), waitingRow('here', 1)]
    const plan = planAdmissions({ rows, devices: fleet(offline('away'), online('here')), holding: new Set(), now: NOW, settings: { ...NO_GAP, maxParallel: 1 }, runKey: 'g:r' })
    expect(plan.admit.map((r) => r.deviceId)).toEqual(['here'])
    expect(plan.blocked.get('away')).toBe('offline')
  })

  test('a phone still holding work (a post, another run) is passed over as busy', () => {
    const rows = [waitingRow('posting', 0), waitingRow('free', 1)]
    const plan = planAdmissions({ rows, devices: fleet(online('posting'), online('free')), holding: new Set(['posting']), now: NOW, settings: { ...NO_GAP, maxParallel: 1 }, runKey: 'g:r' })
    expect(plan.admit.map((r) => r.deviceId)).toEqual(['free'])
    expect(plan.blocked.get('posting')).toBe('busy')
  })
})

describe('the start gap: phones start minutes apart, not in one tick', () => {
  test('within the gap after the last start, nothing more goes', () => {
    const rows = [runningRow('a', NOW - 5), waitingRow('b', 1)]
    const plan = planAdmissions({ rows, devices: fleet(online('a'), online('b')), holding: new Set(['a']), now: NOW, settings: { maxParallel: 8, startGapSec: [20, 20] }, runKey: 'g:r' })
    expect(plan.admit).toEqual([])
    expect(plan.nextStartAt).toBe(NOW + 15)
  })

  test('once the gap has passed one goes, and only one, however many places are free', () => {
    const rows = [runningRow('a', NOW - 25), waitingRow('b', 1), waitingRow('c', 2), waitingRow('d', 3)]
    const plan = planAdmissions({ rows, devices: fleet(online('a'), online('b'), online('c'), online('d')), holding: new Set(['a']), now: NOW, settings: { maxParallel: 8, startGapSec: [20, 20] }, runKey: 'g:r' })
    expect(plan.admit.map((r) => r.deviceId)).toEqual(['b'])
  })

  test('the gap is drawn once per start: the same answer on every tick, and inside the range', () => {
    for (let i = 0; i < 50; i++) {
      const gap = stableGap([20, 60], `g:r:${i}`)
      expect(gap).toBeGreaterThanOrEqual(20)
      expect(gap).toBeLessThanOrEqual(60)
      expect(stableGap([20, 60], `g:r:${i}`)).toBe(gap)
    }
    const spread = new Set(Array.from({ length: 50 }, (_, i) => stableGap([20, 60], `g:r:${i}`)))
    expect(spread.size).toBeGreaterThan(10)
  })
})

describe('a phone\'s phases, one after the other', () => {
  test('its second platform waits while the first is unfinished', () => {
    const rows = [runningRow('a'), waitingRow('a', 0, 1)]
    const plan = planAdmissions({ rows, devices: fleet(online('a')), holding: new Set(), now: NOW, settings: NO_GAP, runKey: 'g:r' })
    expect(plan.admit).toEqual([])
    expect(plan.blocked.get('a')).toBe('earlier-phase')
  })

  test('and then for a gap of its own after the first finishes', () => {
    const done: QueueRow = { deviceId: 'a', phase: 0, queueSeq: 0, admittedAt: NOW - 600, steps: [success(NOW - 5)] }
    const rows = [done, waitingRow('a', 0, 1)]
    const soon = planAdmissions({ rows, devices: fleet(online('a')), holding: new Set(), now: NOW, settings: { maxParallel: 8, startGapSec: [30, 30] }, runKey: 'g:r' })
    expect(soon.admit).toEqual([])
    const later = planAdmissions({ rows, devices: fleet(online('a')), holding: new Set(), now: NOW + 60, settings: { maxParallel: 8, startGapSec: [30, 30] }, runKey: 'g:r' })
    expect(later.admit).toHaveLength(1)
  })
})

describe('rows written before the queue existed', () => {
  test('one with a job out right now is running; one merely half done is waiting its turn again', () => {
    const out: QueueRow = { deviceId: 'a', phase: 0, steps: [queued(NOW - 30), pending(NOW)] }
    const halfDone: QueueRow = { deviceId: 'b', phase: 0, steps: [success(NOW - 3_600), pending(NOW - 3_500)] }
    expect(isRunning(out)).toBe(true)
    expect(isAdmitted(halfDone)).toBe(false)
    expect(queueCounts([out, halfDone])).toEqual({ running: 1, waiting: 1, over: 0 })
  })
})

describe('letting a row out', () => {
  test('re-times what it still owes from now, keeping the gaps, and leaves the answered alone', () => {
    const row: QueueRow = { deviceId: 'a', phase: 0, queueSeq: 0, admittedAt: null, steps: [success(NOW - 9_000), pending(NOW - 8_000), pending(NOW - 7_970)] }
    const out = admitRow(row, NOW)
    expect(out.admittedAt).toBe(NOW)
    expect(out.steps.map((s) => s.notBeforeAt)).toEqual([NOW - 9_060, NOW, NOW + 30])
  })
})

describe('production, 2026-09-21: eighteen phones plugged in at once with a schedule from the morning', () => {
  test('they go out one gap apart, never more than eight at a time', () => {
    let rows: QueueRow[] = Array.from({ length: 18 }, (_, i) => waitingRow(`p${i}`, i, 0, NOW - 6 * 3_600))
    const devices = fleet(...rows.map((r) => online(r.deviceId)))
    const starts: number[] = []
    for (let t = NOW; t < NOW + 3_600; t += 15) {
      const holding = new Set(rows.filter(isRunning).map((r) => r.deviceId))
      const plan = planAdmissions({ rows, devices, holding, now: t, settings: { maxParallel: 8, startGapSec: [20, 60] }, runKey: 'g:r' })
      for (const row of plan.admit) {
        starts.push(t)
        rows = rows.map((r) => (r === row ? admitRow(r, t) : r))
      }
      // Nothing finishes in this test, so the cap is the whole story.
      expect(rows.filter(isRunning).length).toBeLessThanOrEqual(8)
    }
    expect(starts).toHaveLength(8)
    for (let i = 1; i < starts.length; i++) expect((starts[i] as number) - (starts[i - 1] as number)).toBeGreaterThanOrEqual(20)
  })
})

describe('a paused device group inside a run', () => {
  test('its phones are passed over as held, and the rest of the run carries on', () => {
    const rows = [waitingRow('pfb1-a', 0), waitingRow('pfb3-a', 1)]
    const plan = planAdmissions({
      rows,
      devices: fleet(online('pfb1-a'), online('pfb3-a')),
      holding: new Set(),
      now: NOW,
      settings: NO_GAP,
      runKey: 'g:r',
      held: (id) => id.startsWith('pfb1'),
    })
    expect(plan.admit.map((r) => r.deviceId)).toEqual(['pfb3-a'])
    expect(plan.blocked.get('pfb1-a')).toBe('held')
  })
})

describe('phoneQueueStatus — what the State column says', () => {
  const base = { online: true, run: 'running' as const, held: false, now: NOW, startGapSec: [20, 60] as const, runKey: 'g:r' }

  test('a phone out of the queue is running, with its platform', () => {
    expect(phoneQueueStatus({ ...base, deviceId: 'a', rows: [runningRow('a')] })).toEqual({ kind: 'running', phase: 0 })
  })

  test('a waiting phone says its place, counted across the whole run', () => {
    const rows = [waitingRow('a', 0), waitingRow('b', 1), waitingRow('c', 2)]
    expect(phoneQueueStatus({ ...base, deviceId: 'c', rows })).toEqual({ kind: 'queued', position: 3 })
  })

  test('the reason a waiting phone is not going wins over its place', () => {
    const rows = [waitingRow('a', 0)]
    expect(phoneQueueStatus({ ...base, deviceId: 'a', rows, online: false })).toEqual({ kind: 'blocked', reason: 'offline' })
    expect(phoneQueueStatus({ ...base, deviceId: 'a', rows, held: true })).toEqual({ kind: 'held' })
    expect(phoneQueueStatus({ ...base, deviceId: 'a', rows, run: 'ready' })).toEqual({ kind: 'ready' })
    expect(phoneQueueStatus({ ...base, deviceId: 'a', rows, run: 'paused' })).toEqual({ kind: 'paused' })
  })

  test('between two platforms a phone is resting, not queued', () => {
    const done: QueueRow = { deviceId: 'a', phase: 0, queueSeq: 0, admittedAt: NOW - 600, steps: [success(NOW - 5)] }
    expect(phoneQueueStatus({ ...base, deviceId: 'a', rows: [done, waitingRow('a', 0, 1)] })).toEqual({ kind: 'blocked', reason: 'resting' })
  })

  test('a finished phone is done, and says how many of its activities failed', () => {
    const row: QueueRow = { deviceId: 'a', phase: 0, queueSeq: 0, admittedAt: NOW - 600, steps: [success(NOW - 5), { state: 'failed', notBeforeAt: NOW - 300 }] }
    expect(phoneQueueStatus({ ...base, deviceId: 'a', rows: [row] })).toEqual({ kind: 'done', failed: 1 })
  })
})

describe('an account that needs a person', () => {
  test('its row is passed over and named; the rest of the run carries on', () => {
    const rows: QueueRow[] = [{ ...waitingRow('signed-out', 0), platform: 'tiktok' }, { ...waitingRow('fine', 1), platform: 'tiktok' }]
    const plan = planAdmissions({
      rows,
      devices: fleet(online('signed-out'), online('fine')),
      holding: new Set(),
      now: NOW,
      settings: NO_GAP,
      runKey: 'g:r',
      accountBlocked: (row) => row.deviceId === 'signed-out' && row.platform === 'tiktok',
    })
    expect(plan.admit.map((r) => r.deviceId)).toEqual(['fine'])
    expect(plan.blocked.get('signed-out')).toBe('account')
  })

  test('the State column names the platform', () => {
    const rows: QueueRow[] = [{ ...waitingRow('a', 0), platform: 'instagram' }]
    expect(phoneQueueStatus({ deviceId: 'a', rows, online: true, run: 'running', held: false, now: NOW, startGapSec: [20, 60], runKey: 'g:r', accountBlocked: new Set(['instagram']) })).toEqual({ kind: 'account', platform: 'instagram' })
  })
})
