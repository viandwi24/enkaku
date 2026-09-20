import { describe, expect, test } from 'bun:test'
import type { RouterDevice } from './posts'
import { runsFromPlan, type WarmupRun } from './warmup-runs'
import { phonesInFlight, planWarmupTick, queuedSteps, withStepState } from './warmup-tick'
import type { WarmupAssignment } from './warmup'

const STARTED = 1_800_000_000
const NOW = STARTED + 1_000

const free = (id: string): RouterDevice => ({ id, stableId: id, status: 'online', activities: [], labels: [], inUse: { control: false, viewers: 0 }, lastControl: null })
const busy = (id: string): RouterDevice => ({ ...free(id), activities: [{ kind: 'job' }] })
const offline = (id: string): RouterDevice => ({ ...free(id), status: 'offline' })

const assignment = (deviceId: string): WarmupAssignment => ({
  deviceId,
  platform: 'tiktok',
  styleId: 'tt-a',
  styleTitle: 'For You',
  note: null,
  steps: [
    { activityId: 'a1', title: 'Scroll', script: 'tiktok/auto-scroll@latest', params: {}, atSec: 10 },
    { activityId: 'a2', title: 'Notifications', script: 'tiktok/notification-activity@latest', params: {}, atSec: 40 },
  ],
})

const runsFor = (...ids: string[]): WarmupRun[] => runsFromPlan({ groupId: 'g1', assignments: ids.map(assignment), phase: 0, startedAt: STARTED })
const devicesFor = (...devices: RouterDevice[]): Map<string, RouterDevice> => new Map(devices.map((d) => [d.id, d]))

describe('planWarmupTick — what goes out this tick', () => {
  test('a due step on a free phone goes out', () => {
    const plan = planWarmupTick({ runs: runsFor('d1'), devices: devicesFor(free('d1')), claimed: new Set(), now: NOW })
    expect(plan.map((p) => p.step.activityId)).toEqual(['a1'])
  })

  test('one phone takes one job, never two', () => {
    const plan = planWarmupTick({ runs: runsFor('d1', 'd1'), devices: devicesFor(free('d1')), claimed: new Set(), now: NOW })
    expect(plan).toHaveLength(1)
  })

  /* Posting is the higher-value work; a warm-up must never take a phone out from under an upload. */
  test('a phone the post pass already claimed is left alone', () => {
    const plan = planWarmupTick({ runs: runsFor('d1'), devices: devicesFor(free('d1')), claimed: new Set(['d1']), now: NOW })
    expect(plan).toEqual([])
  })

  test('a busy or offline phone is skipped, and keeps its place for the next tick', () => {
    for (const device of [busy('d1'), offline('d1')]) {
      const runs = runsFor('d1')
      expect(planWarmupTick({ runs, devices: devicesFor(device), claimed: new Set(), now: NOW })).toEqual([])
      expect(runs[0]?.steps[0]?.state).toBe('pending')
    }
  })

  test('a phone that has left the farm waits rather than failing', () => {
    const runs = runsFor('gone')
    expect(planWarmupTick({ runs, devices: devicesFor(), claimed: new Set(), now: NOW })).toEqual([])
    expect(runs[0]?.state).toBe('pending')
  })

  test('nothing goes out before its turn', () => {
    const plan = planWarmupTick({ runs: runsFor('d1'), devices: devicesFor(free('d1')), claimed: new Set(), now: STARTED + 5 })
    expect(plan).toEqual([])
  })

  test('a phone with a job still in the air takes nothing else', () => {
    const runs = runsFor('d1').map((run) => withStepState(run, 'a1', { state: 'queued', jobId: 'j1' }))
    expect(planWarmupTick({ runs, devices: devicesFor(free('d1')), claimed: new Set(), now: NOW + 10_000 })).toEqual([])
  })

  test('several phones each get their own activity in one tick', () => {
    const plan = planWarmupTick({ runs: runsFor('d1', 'd2', 'd3'), devices: devicesFor(free('d1'), free('d2'), free('d3')), claimed: new Set(), now: NOW })
    expect(plan.map((p) => p.deviceId).sort()).toEqual(['d1', 'd2', 'd3'])
  })
})

describe('the small helpers the tick writes with', () => {
  test('phonesInFlight names the phones a job is already out on', () => {
    const runs = [...runsFor('d1'), ...runsFor('d2').map((r) => withStepState(r, 'a1', { state: 'queued', jobId: 'j1' }))]
    expect([...phonesInFlight(runs)]).toEqual(['d2'])
  })

  test('queuedSteps only offers steps there is a job to ask about', () => {
    const [run] = runsFor('d1')
    expect(queuedSteps(run as WarmupRun)).toEqual([])
    const out = withStepState(run as WarmupRun, 'a1', { state: 'queued', jobId: 'j1' })
    expect(queuedSteps(out).map((s) => s.activityId)).toEqual(['a1'])
    // queued with no job id is a row mid-write, not something to reconcile
    const halfWritten = withStepState(run as WarmupRun, 'a1', { state: 'queued' })
    expect(queuedSteps(halfWritten)).toEqual([])
  })

  test('withStepState changes one step and leaves the rest untouched', () => {
    const [run] = runsFor('d1')
    const out = withStepState(run as WarmupRun, 'a2', { state: 'failed', error: 'boom' })
    expect(out.steps[0]).toEqual((run as WarmupRun).steps[0] as never)
    expect(out.steps[1]).toMatchObject({ state: 'failed', error: 'boom' })
  })
})
