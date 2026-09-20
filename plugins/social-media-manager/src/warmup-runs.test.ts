import { describe, expect, test } from 'bun:test'
import type { WarmupAssignment } from './warmup'
import {
  WarmupRunSchema,
  isRunOver,
  nextStep,
  platformsCovered,
  retryFailedSteps,
  runsFromPlan,
  settleWarmupStep,
  warmupProgress,
  warmupRunKey,
  warmupRunPrefix,
  warmupRunState,
  warmupSummary,
  withRunSummary,
  type WarmupRun,
  type WarmupStepRow,
  type WarmupStepState,
} from './warmup-runs'

const STARTED = 1_800_000_000

const assignment = (over: Partial<WarmupAssignment> = {}): WarmupAssignment => ({
  deviceId: 'd1',
  platform: 'tiktok',
  styleId: 'tt-a',
  styleTitle: 'For You, notifications and the shop',
  note: null,
  steps: [
    { activityId: 'tt-a-fyp', title: 'Scroll For You', script: 'tiktok/auto-scroll@latest', params: { videos: 12 }, atSec: 30 },
    { activityId: 'tt-a-notif', title: 'Check notifications', script: 'tiktok/notification-activity@latest', params: { scrolls: 2 }, atSec: 60 },
    { activityId: 'tt-a-shop', title: 'Browse the shop', script: 'tiktok/shop-browse@latest', params: { scrolls: 3 }, atSec: 95 },
  ],
  ...over,
})

const oneRun = (over: Partial<WarmupAssignment> = {}): WarmupRun =>
  runsFromPlan({ groupId: 'g1', assignments: [assignment(over)], phase: 0, startedAt: STARTED })[0] as WarmupRun

const withStates = (run: WarmupRun, states: readonly WarmupStepState[]): WarmupRun =>
  withRunSummary({ ...run, steps: run.steps.map((step, i) => ({ ...step, state: states[i] ?? step.state })) })

describe('runsFromPlan — the plan becomes rows once, at start', () => {
  test('a row carries the phone, its platform, its style and its steps', () => {
    const run = oneRun()
    expect(run.deviceId).toBe('d1')
    expect(run.platform).toBe('tiktok')
    expect(run.styleId).toBe('tt-a')
    expect(run.steps.map((s) => s.activityId)).toEqual(['tt-a-fyp', 'tt-a-notif', 'tt-a-shop'])
  })

  /*
    Computed from the session's own start, once. "Now plus the gap, each tick"
    drifts by however long the farm was busy, and a warm-up whose gaps stretch
    because the queue was full is not the pacing the operator chose.
  */
  test('each step is due at the session start plus its own offset', () => {
    expect(oneRun().steps.map((s) => s.notBeforeAt)).toEqual([STARTED + 30, STARTED + 60, STARTED + 95])
  })

  test('a phone given nothing is a row too, carrying the reason', () => {
    const run = oneRun({ platform: null, styleId: null, styleTitle: null, steps: [], note: 'This phone has no device number, so its platform cannot be chosen.' })
    expect(run.state).toBe('skipped')
    expect(run.summary).toContain('no device number')
  })

  test('a row round-trips through its schema', () => {
    const run = oneRun()
    expect(WarmupRunSchema.parse(run)).toEqual(run)
  })

  test('the key is per session and per phone, and the prefix reads one session', () => {
    expect(warmupRunKey('g1', 'd1')).toBe('warmup:g1:d1')
    expect(warmupRunKey('g1', 'd1').startsWith(warmupRunPrefix('g1'))).toBe(true)
    expect(warmupRunKey('g2', 'd1').startsWith(warmupRunPrefix('g1'))).toBe(false)
  })
})

describe('nextStep — one activity at a time, in order, on the clock', () => {
  test('nothing goes out before its turn', () => {
    const run = oneRun()
    expect(nextStep(run, STARTED)).toBeNull()
    expect(nextStep(run, STARTED + 29)).toBeNull()
    expect(nextStep(run, STARTED + 30)?.activityId).toBe('tt-a-fyp')
  })

  /* Two warm-up jobs on one phone would fight over the same screen. */
  test('nothing else goes out while something is already on the phone', () => {
    const run = withStates(oneRun(), ['queued'])
    expect(nextStep(run, STARTED + 10_000)).toBeNull()
  })

  test('the next step waits for its own turn even when the one before finished early', () => {
    const run = withStates(oneRun(), ['success'])
    expect(nextStep(run, STARTED + 31)).toBeNull()
    expect(nextStep(run, STARTED + 60)?.activityId).toBe('tt-a-notif')
  })

  /* Plan 900 D6.5: a failing activity does not end the phone's session. */
  test('a failed activity does not stop the ones after it', () => {
    const run = withStates(oneRun(), ['failed'])
    expect(nextStep(run, STARTED + 60)?.activityId).toBe('tt-a-notif')
  })

  test('a finished run offers nothing and says it is over', () => {
    const run = withStates(oneRun(), ['success', 'failed', 'success'])
    expect(nextStep(run, STARTED + 10_000)).toBeNull()
    expect(isRunOver(run)).toBe(true)
    expect(isRunOver(oneRun())).toBe(false)
  })
})

describe('warmupRunState — what an operator is told about one phone', () => {
  test('every state is reachable from its steps', () => {
    const run = oneRun()
    expect(warmupRunState(run.steps)).toBe('pending')
    expect(warmupRunState(withStates(run, ['success']).steps)).toBe('running')
    expect(warmupRunState(withStates(run, ['success', 'success', 'success']).steps)).toBe('done')
    expect(warmupRunState(withStates(run, ['success', 'failed', 'success']).steps)).toBe('partial')
    expect(warmupRunState(withStates(run, ['failed', 'failed', 'failed']).steps)).toBe('failed')
    expect(warmupRunState([])).toBe('skipped')
  })

  /* "Some of it worked" is a different fact from both of its neighbours, and it decides whether Retry is worth pressing. */
  test('one bad activity out of three is part-done, not failed', () => {
    const run = withStates(oneRun(), ['success', 'failed', 'success'])
    expect(run.state).toBe('partial')
    expect(run.summary).toBe('tiktok — 2 done, 1 failed')
  })

  test('the summary is computed from the same steps as the state', () => {
    expect(withStates(oneRun(), ['success', 'success', 'success']).summary).toBe('tiktok — all 3 activities done')
    expect(oneRun().summary).toBe('tiktok — waiting to start')
  })
})

describe('settleWarmupStep — a job becomes an answer', () => {
  test('a green job is a done activity', () => {
    expect(settleWarmupStep({ status: 'success' })).toEqual({ state: 'success', error: null })
  })

  test('a failed job keeps its error', () => {
    expect(settleWarmupStep({ status: 'failed', error: 'the feed did not load' })).toEqual({ state: 'failed', error: 'the feed did not load' })
  })

  test('a job with no message still says something an operator can act on', () => {
    expect(settleWarmupStep({ status: 'failed' })?.error).toContain('without an error message')
  })

  test('cancelled and expired are failures that say which', () => {
    expect(settleWarmupStep({ status: 'cancelled' })?.error).toContain('cancelled')
    expect(settleWarmupStep({ status: 'expired' })?.error).toContain('expired')
  })

  test('a job still running is not an answer yet', () => {
    expect(settleWarmupStep({ status: 'queued' })).toBeNull()
    expect(settleWarmupStep({ status: 'running' })).toBeNull()
  })

  /*
    The deliberate difference from `settleJob` in posts.ts. A post can be
    "unverified" because pressing Upload and knowing it landed are two different
    things, and re-sending one that DID land puts the same video on an account
    twice. Scrolling a feed twice is a phone using an app twice, so there is no
    such state here and a retry is always safe.
  */
  test('there is no unverified: a warm-up activity is never dangerous to repeat', () => {
    for (const status of ['success', 'failed', 'cancelled', 'expired']) {
      expect(settleWarmupStep({ status })?.state).not.toBe('unverified' as unknown as WarmupStepState)
    }
  })
})

describe('retryFailedSteps — Retry failed means the same thing it does on the Posts page', () => {
  test('only the failed activities go again, and their turn is now', () => {
    const run = withStates(oneRun(), ['success', 'failed', 'success'])
    const again = retryFailedSteps(run, STARTED + 5_000)
    expect(again?.steps.map((s) => s.state)).toEqual(['success', 'pending', 'success'])
    expect(again?.steps[1]?.notBeforeAt).toBe(STARTED + 5_000)
    expect(again?.state).toBe('running')
  })

  test('a retried activity forgets its old job and its old error', () => {
    const run = withStates(oneRun(), ['failed'])
    const failed = { ...run, steps: run.steps.map((s, i) => (i === 0 ? { ...s, jobId: 'j1', error: 'boom', settledAt: 1 } : s)) }
    const again = retryFailedSteps(failed, STARTED + 1)
    expect(again?.steps[0]).toMatchObject({ state: 'pending', jobId: null, error: null, settledAt: null })
  })

  test('a run with nothing failed is left exactly as it was', () => {
    expect(retryFailedSteps(withStates(oneRun(), ['success', 'success', 'success']), STARTED)).toBeNull()
    expect(retryFailedSteps(oneRun(), STARTED)).toBeNull()
  })
})

describe('the session, over its phones', () => {
  const runs = (): WarmupRun[] => {
    const base = oneRun()
    return [
      withStates({ ...base, deviceId: 'a' }, ['success', 'success', 'success']),
      withStates({ ...base, deviceId: 'b' }, ['success', 'failed', 'success']),
      withStates({ ...base, deviceId: 'c' }, ['failed', 'failed', 'failed']),
      withStates({ ...base, deviceId: 'd' }, ['queued']),
      { ...base, deviceId: 'e' },
      withRunSummary({ ...base, deviceId: 'f', steps: [], platform: null, note: 'no number' }),
    ]
  }

  test('every phone lands in exactly one bucket', () => {
    const progress = warmupProgress(runs())
    expect(progress).toEqual({ devices: 6, waiting: 1, running: 1, done: 1, partial: 1, failed: 1, skipped: 1 })
    expect(progress.waiting + progress.running + progress.done + progress.partial + progress.failed + progress.skipped).toBe(progress.devices)
  })

  test('the session line reads as a sentence', () => {
    expect(warmupSummary(warmupProgress(runs()))).toBe('1 done, 1 running, 1 waiting, 1 part-done, 1 failed, 1 skipped of 6 phones')
  })

  test('a session nobody has started yet still says how many phones it has', () => {
    expect(warmupSummary({ devices: 4, waiting: 0, running: 0, done: 0, partial: 0, failed: 0, skipped: 0 })).toBe('4 phones')
  })

  test('the platforms a session covered are read from its rows', () => {
    const base = oneRun()
    const covered = platformsCovered([
      { ...base, platform: 'tiktok' },
      { ...base, platform: 'youtube' },
      { ...base, platform: 'tiktok' },
      { ...base, platform: null },
    ])
    expect(covered.sort()).toEqual(['tiktok', 'youtube'])
  })
})

describe('the stored shape survives a version that adds a field', () => {
  test('a step row written without the optional fields parses', () => {
    const minimal = {
      activityId: 'a',
      title: 'Activity',
      script: 'tiktok/auto-scroll@latest',
      atSec: 0,
      notBeforeAt: STARTED,
    }
    const parsed = WarmupRunSchema.parse({
      version: 1,
      groupId: 'g1',
      deviceId: 'd1',
      platform: 'tiktok',
      steps: [minimal],
    })
    expect(parsed.steps[0]).toMatchObject({ state: 'pending', jobId: null, params: {} } as Partial<WarmupStepRow>)
    expect(parsed.phase).toBe(0)
    expect(parsed.deviceName).toBeNull()
  })
})
