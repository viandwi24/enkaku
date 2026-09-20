import { describe, expect, test } from 'bun:test'
import { GroupSchema, WarmupSettingsSchema, defaultWarmupSettings, isWarmup, reusableWarmup, drawGap, editPacing, withProgress, groupProgress, groupSummary, isRowDue, maxDevicesFor, newGroupId, planSchedule, retimeTurns, roomInFlight, shuffled, type Pacing, type RowState } from './groups'

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
      hashtags: { fixed: [], lines: [], randomLine: false },
      excludes: { devices: {}, labels: [], groups: [] },
      progress: null,
      summary: null,
    }
    // `kind` and `warmup` are filled in by their defaults — see the migration test below.
    expect(GroupSchema.parse(group)).toEqual({ ...group, kind: 'post', warmup: null })
  })

  /*
    The migration, and the whole reason `kind` is defaulted rather than required
    (plan 900 D4): `index.ts` reads these rows with `safeParse` and SKIPS a row
    that fails. A required discriminator would have emptied the operator's
    sessions list on upgrade — silently, because a skipped row reports nothing.
  */
  test('a session stored before warm-up existed reads as a post session', () => {
    const stored = {
      version: 1,
      id: 'g-1000-0a1b',
      title: 'post hari Senin',
      createdAt: 1000,
      platforms: ['tiktok'],
      assignment: 'one-per-phone',
      pacing: PACING,
      videoArtifactIds: VIDEOS,
    }
    const parsed = GroupSchema.parse(stored)
    expect(parsed.kind).toBe('post')
    expect(parsed.warmup).toBeNull()
    expect(isWarmup(parsed)).toBe(false)
  })

  test('a warm-up session carries its settings and says so', () => {
    const parsed = GroupSchema.parse({
      version: 1,
      id: 'g-2000-beef',
      title: 'warmup pagi',
      createdAt: 2000,
      platforms: ['tiktok', 'instagram', 'youtube'],
      assignment: 'one-per-phone',
      pacing: PACING,
      videoArtifactIds: [],
      kind: 'warmup',
      warmup: { keywords: ['trading'] },
    })
    expect(isWarmup(parsed)).toBe(true)
    expect(parsed.warmup?.amount).toBe(1)
    expect(parsed.warmup?.gapSec).toEqual([8, 20])
    expect(parsed.warmup?.like).toEqual({ chance: 0.1, keywordBoost: 3 })
    expect(parsed.warmup?.styleWeights).toEqual({})
  })

  /* The two fields are one fact (plan 900 D4), so a row that disagrees with itself is refused. */
  test('a kind that disagrees with its settings is refused', () => {
    const base = {
      version: 1,
      id: 'g1',
      title: 't',
      createdAt: 1,
      platforms: ['tiktok'],
      assignment: 'one-per-phone',
      pacing: PACING,
      videoArtifactIds: [],
    }
    expect(GroupSchema.safeParse({ ...base, kind: 'warmup' }).success).toBe(false)
    expect(GroupSchema.safeParse({ ...base, kind: 'post', warmup: { keywords: ['x'] } }).success).toBe(false)
  })

  test('warm-up settings are bounded, so a typo cannot ask for a session that never ends', () => {
    const settings = (over: Record<string, unknown>) => WarmupSettingsSchema.safeParse({ keywords: ['trading'], ...over }).success
    expect(settings({ amount: 3 })).toBe(true)
    expect(settings({ amount: 30 })).toBe(false)
    expect(settings({ phases: 4 })).toBe(false)
    expect(settings({ like: { chance: 1.5 } })).toBe(false)
    expect(WarmupSettingsSchema.safeParse({ keywords: [] }).success).toBe(false)
  })

  /* A style the engine has not shipped yet must not break a stored row (plan 900 D6.4). */
  test('an unknown style weight is stored, and zero turns a style off without removing it', () => {
    const parsed = WarmupSettingsSchema.parse({ keywords: ['trading'], styleWeights: { 'tt-a': 2, 'tt-c': 0 } })
    expect(parsed.styleWeights).toEqual({ 'tt-a': 2, 'tt-c': 0 })
  })

  test('the shipped defaults are the trading niche the rotation used', () => {
    expect(defaultWarmupSettings().keywords).toContain('belajar trading')
    expect(defaultWarmupSettings().keywords.length).toBe(10)
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

describe('editing a started session\'s pacing (0.30.0)', () => {
  test('only the fields given change, a reversed gap is read as written, and the change is named', () => {
    expect(editPacing(PACING, { concurrency: 2 })).toEqual({ pacing: { ...PACING, concurrency: 2 }, changed: ['concurrency'] })
    expect(editPacing(PACING, { gapMinSec: 120, gapMaxSec: 60 })).toEqual({ pacing: { ...PACING, gapSec: [60, 120] }, changed: ['gap'] })
    expect(editPacing(PACING, { concurrency: 4, gapMinSec: 30, gapMaxSec: 90 }).changed).toEqual([])
  })

  test('the turns still to come keep their order; the first keeps its time and the rest follow by the new gap', () => {
    const rows = [
      { videoArtifactId: 'v3', notBeforeAt: 1_300 },
      { videoArtifactId: 'v2', notBeforeAt: 1_150 },
      { videoArtifactId: 'v4', notBeforeAt: 1_400 },
    ]
    // random() = 0 draws the range's low end: every gap is exactly 10 s.
    expect(retimeTurns(rows, [10, 20], 1_000, () => 0)).toEqual([
      { videoArtifactId: 'v2', notBeforeAt: 1_150 },
      { videoArtifactId: 'v3', notBeforeAt: 1_160 },
      { videoArtifactId: 'v4', notBeforeAt: 1_170 },
    ])
    // A first turn already past is never scheduled in the past.
    expect(retimeTurns([{ videoArtifactId: 'v1', notBeforeAt: 900 }], [10, 20], 1_000, () => 0)).toEqual([{ videoArtifactId: 'v1', notBeforeAt: 1_000 }])
    expect(retimeTurns([], [10, 20], 1_000)).toEqual([])
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
    expect(p).toEqual({ total: 40, waiting: 1, running: 3, posted: 30, failed: 4, attention: 2, skipped: 0 })
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
    expect(next?.progress).toEqual({ total: 4, waiting: 1, running: 1, posted: 1, failed: 1, attention: 0, skipped: 0 })
  })

  test('nothing changed is nothing written — a quiet farm does not rewrite its groups every tick', () => {
    const first = withProgress(group, ['succeeded', 'pending']) as NonNullable<ReturnType<typeof withProgress>>
    expect(withProgress(first, ['succeeded', 'pending'])).toBeNull()
    expect(withProgress(first, ['succeeded', 'succeeded'])).not.toBeNull()
  })
})

describe('a session that skips platforms (0.45.0)', () => {
  const states = (s: Record<string, number>): RowState[] =>
    Object.entries(s).flatMap(([k, n]) => Array.from({ length: n }, () => k as RowState))

  test('skipped is counted apart from waiting, failed and needs-a-look', () => {
    const p = groupProgress(states({ succeeded: 36, skipped: 4 }))
    expect(p).toEqual({ total: 40, waiting: 0, running: 0, posted: 36, failed: 0, attention: 0, skipped: 4 })
  })

  test('a session whose every remaining platform was skipped reads as DONE, with the skips named', () => {
    // The whole reason `skipped` is its own count: folded into `waiting` this line would have read
    // "36 posted, 4 waiting of 40" forever, on a session with nothing left to do.
    expect(groupSummary('Senin', groupProgress(states({ succeeded: 36, skipped: 4 })))).toBe('Senin: all 36 posted, 4 skipped')
  })

  test('a session still running says how many are skipped without hiding what is left', () => {
    expect(groupSummary('Senin', groupProgress(states({ succeeded: 10, pending: 26, failed: 1, skipped: 3 })))).toBe(
      'Senin: 10 posted, 26 waiting, 1 failed, 3 skipped of 40',
    )
  })

  test('a session with no skips reads exactly as it did before they existed', () => {
    expect(groupSummary('Senin', groupProgress(states({ succeeded: 40 })))).toBe('Senin: all 40 posted')
  })
})

/*
  The guard that stops a schedule aimed at a whole fleet from making one session
  per phone. `smm/warmup-rotation` was a workflow DISPATCHED to every phone, so
  a schedule for it naturally targeted the fleet; its replacement plans the
  whole fleet from one run, and eighty scheduled runs pointed the same way would
  make eighty identical sessions each planning the same eighty phones.
*/
describe('reusableWarmup — a schedule aimed at a fleet must not make a session per phone', () => {
  const NOW = 1_800_000_000
  const session = (over: Record<string, unknown>) =>
    GroupSchema.parse({
      version: 1,
      id: 'g1',
      title: 'Warm-up pagi',
      createdAt: NOW,
      platforms: ['tiktok'],
      assignment: 'one-per-phone',
      pacing: PACING,
      videoArtifactIds: [],
      kind: 'warmup',
      warmup: { keywords: ['trading'] },
      ...over,
    })

  test('a warm-up of the same title made moments ago is reused', () => {
    const made = [session({ id: 'g-first', createdAt: NOW - 60 })]
    expect(reusableWarmup(made, 'Warm-up pagi', NOW, 30)?.id).toBe('g-first')
  })

  test('one made before the window is not', () => {
    const made = [session({ id: 'g-old', createdAt: NOW - 31 * 60 })]
    expect(reusableWarmup(made, 'Warm-up pagi', NOW, 30)).toBeNull()
  })

  test('a different title is a different session', () => {
    const made = [session({ id: 'g-other', title: 'Warm-up sore', createdAt: NOW - 60 })]
    expect(reusableWarmup(made, 'Warm-up pagi', NOW, 30)).toBeNull()
  })

  /* A post session of the same name is not a warm-up, however recent. */
  test('a post session is never reused as a warm-up', () => {
    const post = GroupSchema.parse({
      version: 1,
      id: 'g-post',
      title: 'Warm-up pagi',
      createdAt: NOW - 60,
      platforms: ['tiktok'],
      assignment: 'one-per-phone',
      pacing: PACING,
      videoArtifactIds: ['v1'],
    })
    expect(reusableWarmup([post], 'Warm-up pagi', NOW, 30)).toBeNull()
  })

  /* Two runs a second apart must answer with the SAME session, not two different old ones. */
  test('the newest match wins, so concurrent runs agree', () => {
    const made = [session({ id: 'g-older', createdAt: NOW - 600 }), session({ id: 'g-newer', createdAt: NOW - 30 })]
    expect(reusableWarmup(made, 'Warm-up pagi', NOW, 30)?.id).toBe('g-newer')
    expect(reusableWarmup([...made].reverse(), 'Warm-up pagi', NOW, 30)?.id).toBe('g-newer')
  })

  test('a window of zero turns the guard off, for someone who means it', () => {
    const made = [session({ id: 'g-first', createdAt: NOW })]
    expect(reusableWarmup(made, 'Warm-up pagi', NOW, 0)).toBeNull()
  })
})
