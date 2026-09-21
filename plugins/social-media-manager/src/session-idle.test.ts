import { describe, expect, test } from 'bun:test'
import { AUTO_PAUSE_AFTER_SEC, postSessionIdle, warmupRunIdle, type IdlePost, type IdleRun } from './session-idle'

const NOW = 1_790_000_000
const LONG_AGO = NOW - AUTO_PAUSE_AFTER_SEC - 1
const JUST_NOW = NOW - 60

const done = (at: number) => ({ state: 'success', notBeforeAt: at - 30, startedAt: at - 30, settledAt: at })
const pending = (dueAt: number) => ({ state: 'pending', notBeforeAt: dueAt })
const queued = (at: number) => ({ state: 'queued', notBeforeAt: at, startedAt: at })

describe('warmupRunIdle — the owner\'s case', () => {
  /*
    73 phones, 20 connected. The twenty finish; the other fifty-three hold activities nobody can do.
    Ten minutes after the last one finished, the run pauses rather than waiting to stampede the farm
    the moment those phones are plugged in.
  */
  const run: IdleRun[] = [
    { deviceId: 'on-1', steps: [done(LONG_AGO)] },
    { deviceId: 'on-2', steps: [done(LONG_AGO)] },
    { deviceId: 'off-1', steps: [pending(LONG_AGO)] },
    { deviceId: 'off-2', steps: [pending(LONG_AGO)] },
  ]
  const online = new Set(['on-1', 'on-2'])

  test('pauses once everything left belongs to offline phones and nothing has moved for ten minutes', () => {
    const verdict = warmupRunIdle(run, online, NOW)
    expect(verdict.idle).toBe(true)
    expect(verdict.waiting).toBe(2)
    expect(verdict.reason).toContain('2 phones')
  })

  test('not inside the ten minutes — a phone drops for a minute all the time', () => {
    const recent: IdleRun[] = [{ deviceId: 'on-1', steps: [done(JUST_NOW)] }, { deviceId: 'off-1', steps: [pending(LONG_AGO)] }]
    expect(warmupRunIdle(recent, online, NOW).idle).toBe(false)
  })
})

describe('warmupRunIdle — never while there is anything to do', () => {
  test('a connected phone with work left, even if that work is not due yet', () => {
    const run: IdleRun[] = [{ deviceId: 'on-1', steps: [done(LONG_AGO), pending(NOW + 3_600)] }]
    expect(warmupRunIdle(run, new Set(['on-1']), NOW).idle).toBe(false)
  })

  test('an activity in flight', () => {
    const run: IdleRun[] = [{ deviceId: 'off-1', steps: [queued(LONG_AGO)] }, { deviceId: 'off-2', steps: [pending(LONG_AGO)] }]
    expect(warmupRunIdle(run, new Set(), NOW).idle).toBe(false)
  })

  test('a run that is simply finished has nothing to pause', () => {
    const run: IdleRun[] = [{ deviceId: 'off-1', steps: [done(LONG_AGO)] }]
    expect(warmupRunIdle(run, new Set(), NOW).idle).toBe(false)
  })

  test('rows an older build stopped are stopped, not waiting', () => {
    const run: IdleRun[] = [{ deviceId: 'off-1', stopped: true, steps: [pending(LONG_AGO)] }]
    expect(warmupRunIdle(run, new Set(), NOW).idle).toBe(false)
  })
})

describe('warmupRunIdle — a run in which nothing ever went out', () => {
  test('is measured from when its work first fell due', () => {
    const due = (at: number): IdleRun[] => [{ deviceId: 'off-1', steps: [pending(at)] }]
    expect(warmupRunIdle(due(LONG_AGO), new Set(), NOW).idle).toBe(true)
    expect(warmupRunIdle(due(JUST_NOW), new Set(), NOW).idle).toBe(false)
  })
})

describe('postSessionIdle', () => {
  const post = (platforms: Record<string, { state: string; attempts?: { at?: number; settledAt?: number }[]; waitingSince?: number | null }>): IdlePost & { id: string } => ({
    id: Math.random().toString(36),
    platforms: Object.keys(platforms),
    dispatch: platforms,
  })
  const nobodyOnline = () => false

  test('pauses once every waiting post can only go to offline phones, ten minutes on', () => {
    const posts = [
      post({ tiktok: { state: 'succeeded', attempts: [{ at: LONG_AGO - 60, settledAt: LONG_AGO }] } }),
      post({ tiktok: { state: 'pending', waitingSince: LONG_AGO } }),
      post({ youtube: { state: 'pending', waitingSince: LONG_AGO } }),
    ]
    const verdict = postSessionIdle(posts, nobodyOnline, NOW)
    expect(verdict.idle).toBe(true)
    expect(verdict.waiting).toBe(2)
  })

  test('never while a post is out on a phone', () => {
    const posts = [post({ tiktok: { state: 'dispatched' } }), post({ youtube: { state: 'pending', waitingSince: LONG_AGO } })]
    expect(postSessionIdle(posts, nobodyOnline, NOW).idle).toBe(false)
  })

  test('never while some connected phone could take a waiting post', () => {
    const posts = [post({ tiktok: { state: 'pending', waitingSince: LONG_AGO } })]
    expect(postSessionIdle(posts, () => true, NOW).idle).toBe(false)
  })

  test('never on a reading the router has not taken yet', () => {
    // No attempts and no `waitingSince`: the router has not looked at these rows.
    const posts = [post({ tiktok: { state: 'pending' } })]
    expect(postSessionIdle(posts, nobodyOnline, NOW).idle).toBe(false)
  })

  test('a finished session has nothing to pause', () => {
    const posts = [post({ tiktok: { state: 'succeeded', attempts: [{ settledAt: LONG_AGO }] } }), post({ youtube: { state: 'failed', attempts: [{ settledAt: LONG_AGO }] } })]
    expect(postSessionIdle(posts, nobodyOnline, NOW).idle).toBe(false)
  })
})

describe('Start is not undone on the next tick', () => {
  test('a warm-up re-timed to now has its full window again, even with every phone still offline', () => {
    // Start shifts waiting steps to "now"; old history must not re-pause it at once.
    const run: IdleRun[] = [{ deviceId: 'on-1', steps: [done(LONG_AGO)] }, { deviceId: 'off-1', steps: [pending(NOW)] }]
    expect(warmupRunIdle(run, new Set(), NOW).idle).toBe(false)
  })

  test('work scheduled for later does not keep a stuck run looking alive', () => {
    // Phase 0 stuck for long, phase 2 an hour off: the stuck part is what counts.
    const run: IdleRun[] = [{ deviceId: 'off-1', steps: [pending(LONG_AGO)] }, { deviceId: 'off-1', steps: [pending(NOW + 3_600)] }]
    expect(warmupRunIdle(run, new Set(), NOW).idle).toBe(true)
  })

  test('a post session whose waiting clock was cleared by Start waits for the router to read it again', () => {
    const posts = [
      { platforms: ['tiktok'], dispatch: { tiktok: { state: 'succeeded', attempts: [{ settledAt: LONG_AGO }] } } },
      { platforms: ['youtube'], dispatch: { youtube: { state: 'pending', waitingSince: null } } },
    ]
    expect(postSessionIdle(posts, () => false, NOW).idle).toBe(false)
  })

  test('and once the router has read it again, it has a fresh ten minutes', () => {
    const posts = [
      { platforms: ['tiktok'], dispatch: { tiktok: { state: 'succeeded', attempts: [{ settledAt: LONG_AGO }] } } },
      { platforms: ['youtube'], dispatch: { youtube: { state: 'pending', waitingSince: JUST_NOW } } },
    ]
    expect(postSessionIdle(posts, () => false, NOW).idle).toBe(false)
  })
})

describe('a post session whose later rows have not had their turn yet', () => {
  test('is measured from the rows the router HAS read, not held open by the ones it has not', () => {
    const posts = [
      { platforms: ['tiktok'], dispatch: { tiktok: { state: 'pending', waitingSince: LONG_AGO } } },
      // Not due yet, so the router never wrote its clock; its phone is offline too.
      { platforms: ['tiktok'], dispatch: { tiktok: { state: 'pending' } } },
    ]
    expect(postSessionIdle(posts, () => false, NOW).idle).toBe(true)
  })
})
