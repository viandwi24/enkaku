import { describe, expect, test } from 'bun:test'
import type { WarmupAssignment } from './warmup'
import {
  WarmupRowSchema,
  isRunOver,
  nextStep,
  platformsCovered,
  retryFailedSteps,
  dueSequence,
  runsFromPlan,
  sequenceOutcome,
  settleWarmupStep,
  warmupProgress,
  warmupRowKey,
  warmupRowPrefix,
  warmupRowState,
  warmupSummary,
  withRunSummary,
  type WarmupRow,
  type WarmupStepRow,
  type WarmupStepState,
  LEGACY_RUN_ID,
  newRunId,
  warmupRunPrefix,
} from './warmup-rows'

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

const oneRun = (over: Partial<WarmupAssignment> = {}): WarmupRow =>
  runsFromPlan({ groupId: 'g1', runId: 'r1', assignments: [assignment(over)], phase: 0, startedAt: STARTED })[0] as WarmupRow

const withStates = (run: WarmupRow, states: readonly WarmupStepState[]): WarmupRow =>
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
    expect(WarmupRowSchema.parse(run)).toEqual(run)
  })

  test('the key is per session, per run, per phase and per phone, and one prefix reads a whole session', () => {
    expect(warmupRowKey('g1', 'r1', 0, 'd1')).toBe('warmup:g1:r1:0:d1')
    expect(warmupRowKey('g1', 'r1', 0, 'd1').startsWith(warmupRowPrefix('g1'))).toBe(true)
    expect(warmupRowKey('g1', 'r9', 2, 'd1').startsWith(warmupRowPrefix('g1'))).toBe(true)
    expect(warmupRowKey('g2', 'r1', 0, 'd1').startsWith(warmupRowPrefix('g1'))).toBe(false)
  })

  /* Three phases are three pieces of work for one phone; one key would lose two of them. */
  test('two phases of one phone do not share a key', () => {
    expect(warmupRowKey('g1', 'r1', 0, 'd1')).not.toBe(warmupRowKey('g1', 'r1', 1, 'd1'))
  })

  /*
    And the one the run id exists for: starting a session again must not write
    over what the last start did. Without the run in the key the second run
    would overwrite the first phone for phone, and a session would be a thing
    with no memory.
  */
  test('two runs of one session do not share a key, and one run reads on its own', () => {
    expect(warmupRowKey('g1', 'r1', 0, 'd1')).not.toBe(warmupRowKey('g1', 'r2', 0, 'd1'))
    expect(warmupRowKey('g1', 'r2', 0, 'd1').startsWith(warmupRunPrefix('g1', 'r2'))).toBe(true)
    expect(warmupRowKey('g1', 'r1', 0, 'd1').startsWith(warmupRunPrefix('g1', 'r2'))).toBe(false)
  })

  test('a row written before runs existed is read as the first run, not skipped', () => {
    // The whole migration: a farm that upgrades keeps its history instead of
    // appearing to lose it.
    const { runId, ...older } = oneRun()
    expect(WarmupRowSchema.parse(older).runId).toBe(LEGACY_RUN_ID)
  })

  test('run ids sort by the moment they started', () => {
    expect(newRunId(1_000) < newRunId(2_000)).toBe(true)
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

describe('warmupRowState — what an operator is told about one phone', () => {
  test('every state is reachable from its steps', () => {
    const run = oneRun()
    expect(warmupRowState(run.steps)).toBe('pending')
    expect(warmupRowState(withStates(run, ['success']).steps)).toBe('running')
    expect(warmupRowState(withStates(run, ['success', 'success', 'success']).steps)).toBe('done')
    expect(warmupRowState(withStates(run, ['success', 'failed', 'success']).steps)).toBe('partial')
    expect(warmupRowState(withStates(run, ['failed', 'failed', 'failed']).steps)).toBe('failed')
    expect(warmupRowState([])).toBe('skipped')
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
    /*
      The row's own `state` is NOT recomputed here — since 0.59.0 the Retry
      button runs in the BROWSER, which has a narrower mirror of this schema
      and no `withRunSummary`. The router's next tick fixes it; a stale summary
      for one tick is a smaller cost than two copies of the retry rule.
    */
    expect(withRunSummary(again as WarmupRow).state).toBe('running')
  })

  test('a retried activity forgets its old job and its old error', () => {
    const run = withStates(oneRun(), ['failed'])
    const failed = { ...run, steps: run.steps.map((s, i) => (i === 0 ? { ...s, jobId: 'j1', error: 'boom', settledAt: 1 } : s)) }
    const again = retryFailedSteps(failed, STARTED + 1)
    expect(again?.steps[0]).toMatchObject({ state: 'pending', jobId: null, error: null, settledAt: null })
  })

  /* A sequence that stopped leaves everything after it `skipped` — never run. */
  test('activities a stopped sequence never reached go again too', () => {
    const again = retryFailedSteps(withStates(oneRun(), ['success', 'failed', 'skipped']), STARTED + 9_000)
    expect(again?.steps.map((s) => s.state)).toEqual(['success', 'pending', 'pending'])
    expect(again?.steps[2]?.notBeforeAt).toBe(STARTED + 9_000)
  })

  test('a run with nothing failed is left exactly as it was', () => {
    expect(retryFailedSteps(withStates(oneRun(), ['success', 'success', 'success']), STARTED)).toBeNull()
    expect(retryFailedSteps(oneRun(), STARTED)).toBeNull()
  })
})

describe('the session, over its phones', () => {
  const runs = (): WarmupRow[] => {
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
    const parsed = WarmupRowSchema.parse({
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

/*
  A workflow row is dispatched whole (plan 908): the delays live INSIDE the job,
  so the steps after the first are not separately due, and sending a second job
  while the first is still walking the phone is the thing `nextStep` refuses for
  the other path.
*/
describe('dueSequence — a row that goes out as one workflow job', () => {
  const workflowRun = (): WarmupRow =>
    runsFromPlan({ groupId: 'g1', runId: 'r1', assignments: [assignment()], phase: 0, startedAt: STARTED, sequence: 'workflow' })[0] as WarmupRow

  test('a job-per-activity row offers nothing here', () => {
    expect(dueSequence(oneRun(), STARTED + 10_000)).toBeNull()
  })

  test('a workflow row offers nothing to `nextStep`, so the two paths cannot both fire', () => {
    expect(nextStep(workflowRun(), STARTED + 10_000)).toBeNull()
  })

  test('the whole sequence goes out once the first step is due', () => {
    const run = workflowRun()
    expect(dueSequence(run, STARTED + 29)).toBeNull()
    expect(dueSequence(run, STARTED + 30)?.map((s) => s.activityId)).toEqual(['tt-a-fyp', 'tt-a-notif', 'tt-a-shop'])
  })

  test('nothing else goes out while the sequence is on the phone', () => {
    const run = withStates(workflowRun(), ['queued', 'queued', 'queued'])
    expect(dueSequence(run, STARTED + 10_000)).toBeNull()
  })

  test('a finished sequence offers nothing', () => {
    expect(dueSequence(withStates(workflowRun(), ['success', 'success', 'success']), STARTED + 10_000)).toBeNull()
  })

  /* A retry re-queues the failed ones, and they go out together as a shorter sequence. */
  test('after a retry only the failed activities go out again', () => {
    const run = retryFailedSteps(withStates(workflowRun(), ['success', 'failed', 'failed']), STARTED + 5_000)
    expect(dueSequence(run as WarmupRow, STARTED + 5_000)?.map((s) => s.activityId)).toEqual(['tt-a-notif', 'tt-a-shop'])
  })

  test('the row remembers the mode it was planned in', () => {
    expect(workflowRun().sequence).toBe('workflow')
    expect(oneRun().sequence).toBe('jobs')
  })
})

/*
  Found by running it. A workflow row has every activity against one job, so a
  failed job first read as "all 4 failed" — while three of the four had gone
  green as the workflow's own child jobs before the fourth met a bad screen.
  That is not a rounding error; it is the opposite of what happened.
*/
describe('sequenceOutcome — which activity in a sequence actually failed', () => {
  const steps = (): WarmupStepRow[] => (oneRun().steps as WarmupStepRow[])

  test('everything before the named step ran, everything after it never did', () => {
    const out = sequenceOutcome(steps(), 'step "s1" failed: the feed did not load')
    expect(out?.map((s) => s.state)).toEqual(['success', 'failed', 'skipped'])
  })

  test('a failure on the first step blames only the first', () => {
    expect(sequenceOutcome(steps(), 'step "s0" failed: boom')?.map((s) => s.state)).toEqual(['failed', 'skipped', 'skipped'])
  })

  test('a failure on the last blames only the last, and the rest are credited', () => {
    expect(sequenceOutcome(steps(), 'step "s2" failed: boom')?.map((s) => s.state)).toEqual(['success', 'success', 'failed'])
  })

  /*
    Reading an index out of a message is fragile, and this is the only thing
    that depends on it: an unparseable message falls back to the crude answer
    rather than guessing, because a wrong guess is worse than a blunt one.
  */
  test('a message with no step name gives no answer at all', () => {
    expect(sequenceOutcome(steps(), 'the phone went offline')).toBeNull()
    expect(sequenceOutcome(steps(), null)).toBeNull()
  })

  test('a step name outside the sequence is refused, not clamped', () => {
    expect(sequenceOutcome(steps(), 'step "s9" failed: boom')).toBeNull()
    expect(sequenceOutcome(steps(), 'step "s-1" failed: boom')).toBeNull()
  })
})

describe('warmupProgress counts PHONES, not stored rows', () => {
  /*
    A session stores a row per phone per phase. Reporting those as phones gave
    a fourteen-phone farm "42 phones", and the owner rightly asked whether any
    of the states beside it were real. They were; the noun was wrong, which is
    worse — a number nobody can check against the shelf makes every number
    beside it suspect.
  */
  const rowFor = (deviceId: string, phase: number, state: WarmupStepState): WarmupRow =>
    WarmupRowSchema.parse({
      version: 1,
      groupId: 'g1',
      deviceId,
      phase,
      platform: 'youtube',
      steps: [{ activityId: `a${phase}`, title: 'Home feed', script: 'youtube/home-feed', atSec: 0, notBeforeAt: 0, state }],
    })

  test('three phases of one phone are one phone', () => {
    const progress = warmupProgress([rowFor('d1', 0, 'success'), rowFor('d1', 1, 'success'), rowFor('d1', 2, 'success')])
    expect(progress.devices).toBe(1)
    expect(progress.done).toBe(1)
  })

  test('a phone part way through its phases reads running, not one done and one waiting', () => {
    const progress = warmupProgress([rowFor('d1', 0, 'success'), rowFor('d1', 1, 'pending')])
    expect(progress.devices).toBe(1)
    expect(progress.running).toBe(1)
    expect(progress.done).toBe(0)
    expect(progress.waiting).toBe(0)
  })

  test('the buckets always add up to the phone count', () => {
    const runs = [rowFor('a', 0, 'success'), rowFor('a', 1, 'failed'), rowFor('b', 0, 'pending'), rowFor('c', 0, 'queued')]
    const p = warmupProgress(runs)
    expect(p.waiting + p.running + p.done + p.partial + p.failed + p.skipped).toBe(p.devices)
    expect(p.devices).toBe(3)
  })

  test('the summary says phones and means phones', () => {
    expect(warmupSummary(warmupProgress([rowFor('a', 0, 'success'), rowFor('a', 1, 'success')]))).toBe('1 done of 1 phone')
  })
})
