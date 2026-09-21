import { describe, expect, test } from 'bun:test'
import { planRecapTick, type RecapCandidate } from './recap-tick'

const NOW = 1_790_000_000
const WAIT = 6 * 60 * 60

const queued = (key: string, deviceId: string, opts?: { readAt?: number }): RecapCandidate => ({
  key,
  deviceId,
  state: 'reading',
  jobId: '',
  readAt: opts?.readAt ?? NOW,
})
const outFor = (key: string, deviceId: string): RecapCandidate => ({ key, deviceId, state: 'reading', jobId: 'j', readAt: NOW })
const done = (key: string, deviceId: string): RecapCandidate => ({ key, deviceId, state: 'ok', jobId: '', readAt: NOW })

/** `n` phones, one queued read each. */
const fleet = (n: number): RecapCandidate[] => Array.from({ length: n }, (_, i) => queued(`k${i}`, `d${i}`))
const allOnline = (n: number): Set<string> => new Set(Array.from({ length: n }, (_, i) => `d${i}`))

describe('planRecapTick — the pacing', () => {
  test('a fleet-wide refresh goes out in batches, not all at once', () => {
    // The whole reason this exists: 73 phones used to be dispatched in one
    // tick — 73 apps, 73 inspector sessions, 73 jobs at the same instant.
    const plan = planRecapTick({ rows: fleet(73), online: allOnline(73), claimed: new Set(), limit: 8, now: NOW, waitMaxSec: WAIT })
    expect(plan.send.length).toBe(8)
    expect(plan.outstanding).toBe(8)
  })

  test('reads already out count against the limit', () => {
    const rows = [outFor('a', 'd1'), outFor('b', 'd2'), outFor('c', 'd3'), ...fleet(10)]
    const plan = planRecapTick({ rows, online: new Set([...allOnline(10), 'd1', 'd2', 'd3']), claimed: new Set(), limit: 8, now: NOW, waitMaxSec: WAIT })
    expect(plan.send.length).toBe(5)
    expect(plan.outstanding).toBe(8)
  })

  test('a full farm sends nothing at all this tick', () => {
    const rows = [...Array.from({ length: 8 }, (_, i) => outFor(`o${i}`, `o${i}`)), ...fleet(20)]
    const plan = planRecapTick({ rows, online: new Set([...allOnline(20), ...Array.from({ length: 8 }, (_, i) => `o${i}`)]), claimed: new Set(), limit: 8, now: NOW, waitMaxSec: WAIT })
    expect(plan.send).toEqual([])
  })

  test('a slot freed by a settled read is filled in the same tick', () => {
    // `done` is a row the settle pass has just finished with — its phone is free now, not in fifteen seconds.
    const rows = [done('a', 'd1'), ...fleet(5)]
    const plan = planRecapTick({ rows, online: new Set([...allOnline(5), 'd1']), claimed: new Set(), limit: 8, now: NOW, waitMaxSec: WAIT })
    expect(plan.send.length).toBe(5)
  })

  test('the limit is never below one, whatever it is handed', () => {
    const plan = planRecapTick({ rows: fleet(5), online: allOnline(5), claimed: new Set(), limit: 0, now: NOW, waitMaxSec: WAIT })
    expect(plan.send.length).toBe(1)
  })
})

describe('planRecapTick — whose phone it is', () => {
  test('a phone the post or warm-up pass already took is left alone', () => {
    const plan = planRecapTick({ rows: fleet(3), online: allOnline(3), claimed: new Set(['d0', 'd1']), limit: 8, now: NOW, waitMaxSec: WAIT })
    expect(plan.send.map((r) => r.deviceId)).toEqual(['d2'])
  })

  test('one read per phone, so three platforms queue behind each other', () => {
    const rows = [queued('tiktok', 'd0'), queued('instagram', 'd0'), queued('youtube', 'd0')]
    const plan = planRecapTick({ rows, online: new Set(['d0']), claimed: new Set(), limit: 8, now: NOW, waitMaxSec: WAIT })
    expect(plan.send.map((r) => r.key)).toEqual(['tiktok'])
  })

  test('an offline phone is waited for, not sent to', () => {
    const plan = planRecapTick({ rows: fleet(3), online: new Set(['d1']), claimed: new Set(), limit: 8, now: NOW, waitMaxSec: WAIT })
    expect(plan.send.map((r) => r.deviceId)).toEqual(['d1'])
    expect(plan.expire).toEqual([])
  })
})

describe('planRecapTick — giving up', () => {
  test('a phone that never came back inside the budget is expired', () => {
    const rows = [queued('a', 'd0', { readAt: NOW - WAIT - 1 }), queued('b', 'd1', { readAt: NOW })]
    const plan = planRecapTick({ rows, online: new Set(), claimed: new Set(), limit: 8, now: NOW, waitMaxSec: WAIT })
    expect(plan.expire.map((r) => r.key)).toEqual(['a'])
  })

  test('a busy farm still expires — a spent send budget must not stop the pass noticing', () => {
    // Eight reads out, so nothing can be sent; the stale row must still be
    // found, or a farm that is always busy never expires anything.
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => outFor(`o${i}`, `o${i}`)),
      queued('stale', 'gone', { readAt: NOW - WAIT - 1 }),
      ...fleet(5),
    ]
    const plan = planRecapTick({
      rows,
      online: new Set([...allOnline(5), ...Array.from({ length: 8 }, (_, i) => `o${i}`)]),
      claimed: new Set(),
      limit: 8,
      now: NOW,
      waitMaxSec: WAIT,
    })
    expect(plan.send).toEqual([])
    expect(plan.expire.map((r) => r.key)).toEqual(['stale'])
  })
})
