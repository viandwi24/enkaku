import { describe, expect, test } from 'bun:test'
import { GroupSchema, drawGap, withProgress, groupProgress, groupSummary, isRowDue, maxDevicesFor, newGroupId, planSchedule, roomInFlight, shuffled, type Pacing, type RowState } from './groups'

/** A deterministic `random` — the same draws every run, so a schedule can be asserted exactly. */
function seeded(values: readonly number[]): () => number {
  let i = 0
  return () => values[i++ % values.length] as number
}

const PACING: Pacing = { order: 'as-listed', concurrency: 4, gapSec: [30, 90] }
const VIDEOS = ['v1', 'v2', 'v3', 'v4']

describe('the stored shape', () => {
  test('a group round-trips through its schema', () => {
    const group = {
      version: 1 as const,
      id: 'g-1000-0a1b',
      title: 'post hari Senin 14 Sep 2026',
      createdAt: 1000,
      platforms: ['tiktok' as const],
      assignment: 'one-per-phone' as const,
      pacing: PACING,
      videoArtifactIds: VIDEOS,
      progress: null,
      summary: null,
    }
    expect(GroupSchema.parse(group)).toEqual(group)
  })

  test('a group with no platform, or no title, is refused rather than stored', () => {
    const base = { version: 1, id: 'g1', title: 't', createdAt: 1, platforms: ['tiktok'], assignment: 'one-per-phone', pacing: PACING, videoArtifactIds: ['v'] }
    expect(GroupSchema.safeParse({ ...base, platforms: [] }).success).toBe(false)
    expect(GroupSchema.safeParse({ ...base, title: '' }).success).toBe(false)
  })

  test('an id carries the second it was made, so groups sort by eye', () => {
    expect(newGroupId(1789320000, () => 0.5)).toBe('g-1789320000-7fff')
  })
})

describe('planSchedule — forty phones must not start in the same second', () => {
  test('the first video is due at once and each next one a drawn gap later', () => {
    // Every draw lands mid-range: 30 + round(0.5 * 60) = 60s apart.
    const plan = planSchedule({ videoArtifactIds: VIDEOS, pacing: PACING, startAt: 1_000, random: seeded([0.5]) })
    expect(plan.map((p) => p.notBeforeAt)).toEqual([1_000, 1_060, 1_120, 1_180])
    expect(plan.map((p) => p.videoArtifactId)).toEqual(VIDEOS)
  })

  test('a zero gap is honoured — an operator who wants them all at once gets that', () => {
    const plan = planSchedule({ videoArtifactIds: VIDEOS, pacing: { ...PACING, gapSec: [0, 0] }, startAt: 500, random: seeded([0.9]) })
    expect(plan.map((p) => p.notBeforeAt)).toEqual([500, 500, 500, 500])
  })

  test('random order shuffles the videos but keeps the same rising schedule', () => {
    const plan = planSchedule({ videoArtifactIds: VIDEOS, pacing: { ...PACING, order: 'random' }, startAt: 0, random: seeded([0.1, 0.9, 0.4, 0.6]) })
    expect([...plan].map((p) => p.videoArtifactId).sort()).toEqual([...VIDEOS].sort())
    const times = plan.map((p) => p.notBeforeAt)
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  test('one video is one turn, immediately', () => {
    expect(planSchedule({ videoArtifactIds: ['only'], pacing: PACING, startAt: 42, random: seeded([0.5]) })).toEqual([{ videoArtifactId: 'only', notBeforeAt: 42 }])
  })
})

describe('drawGap and shuffled', () => {
  test('a draw stays inside the range, and a reversed range is read as written', () => {
    expect(drawGap([30, 90], () => 0)).toBe(30)
    expect(drawGap([30, 90], () => 1)).toBe(90)
    expect(drawGap([90, 30], () => 0)).toBe(30)
  })

  test('a shuffle keeps every item and leaves the input alone', () => {
    const input = ['a', 'b', 'c', 'd']
    const out = shuffled(input, seeded([0.7, 0.2, 0.9]))
    expect([...out].sort()).toEqual([...input].sort())
    expect(input).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('assignment', () => {
  test('one video per phone caps a row at one phone; every-phone leaves the farm setting alone', () => {
    expect(maxDevicesFor('one-per-phone')).toBe(1)
    expect(maxDevicesFor('every-phone')).toBeNull()
  })
})

describe('groupProgress and its summary', () => {
  const states = (s: Record<string, number>): RowState[] =>
    Object.entries(s).flatMap(([k, n]) => Array.from({ length: n }, () => k as RowState))

  test('counts every row exactly once, and keeps "needs a look" apart from "failed"', () => {
    const p = groupProgress(states({ succeeded: 30, failed: 4, partial: 2, dispatched: 3, pending: 1 }))
    expect(p).toEqual({ total: 40, waiting: 1, running: 3, posted: 30, failed: 4, attention: 2 })
  })

  test('a finished group says so plainly', () => {
    expect(groupSummary('Senin', groupProgress(states({ succeeded: 40 })))).toBe('Senin: all 40 posted')
  })

  test('a running group says what is left, not just what is done', () => {
    expect(groupSummary('Senin', groupProgress(states({ succeeded: 10, dispatched: 2, pending: 27, failed: 1 })))).toBe(
      'Senin: 10 posted, 2 running, 27 waiting, 1 failed of 40',
    )
  })

  test('an empty group is not a success', () => {
    expect(groupSummary('Senin', groupProgress([]))).toBe('Senin: no videos')
  })
})

describe('pacing at dispatch time', () => {
  test('a group row waits for its turn, and an unstarted one never comes due', () => {
    expect(isRowDue({ groupId: 'g1', notBeforeAt: 1_100 }, 1_000)).toBe(false)
    expect(isRowDue({ groupId: 'g1', notBeforeAt: 1_000 }, 1_000)).toBe(true)
    // Created, not started: the operator has not pressed Start yet.
    expect(isRowDue({ groupId: 'g1', notBeforeAt: null }, 1_000)).toBe(false)
  })

  test('a row outside a group is due at once — the older single-video path is untouched', () => {
    expect(isRowDue({ groupId: null, notBeforeAt: null }, 1_000)).toBe(true)
    expect(isRowDue({}, 1_000)).toBe(true)
  })

  test('room is what concurrency leaves after the rows already in flight', () => {
    const inFlight: RowState[] = ['dispatched', 'dispatched', 'succeeded', 'pending']
    expect(roomInFlight(inFlight, 4)).toBe(2)
    expect(roomInFlight(inFlight, 2)).toBe(0)
    // A plugin that restarted mid-run must not flood the farm.
    expect(roomInFlight(['dispatched', 'dispatched', 'dispatched'], 2)).toBe(0)
  })
})

describe('withProgress — the counts a group row renders', () => {
  const group = GroupSchema.parse({
    version: 1,
    id: 'g-1-aaaa',
    title: 'Senin',
    createdAt: 1,
    platforms: ['tiktok'],
    assignment: 'one-per-phone',
    pacing: PACING,
    videoArtifactIds: VIDEOS,
  })

  test('the first look writes the counts and the line', () => {
    const next = withProgress(group, ['succeeded', 'pending', 'dispatched', 'failed'])
    expect(next?.summary).toBe('Senin: 1 posted, 1 running, 1 waiting, 1 failed of 4')
    expect(next?.progress).toEqual({ total: 4, waiting: 1, running: 1, posted: 1, failed: 1, attention: 0 })
  })

  test('nothing changed is nothing written — a quiet farm does not rewrite its groups every tick', () => {
    const first = withProgress(group, ['succeeded', 'pending']) as NonNullable<ReturnType<typeof withProgress>>
    expect(withProgress(first, ['succeeded', 'pending'])).toBeNull()
    expect(withProgress(first, ['succeeded', 'succeeded'])).not.toBeNull()
  })
})
