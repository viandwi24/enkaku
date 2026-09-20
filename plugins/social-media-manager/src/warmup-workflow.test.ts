import { describe, expect, test } from 'bun:test'
import { WorkflowDocSchema } from '@enkaku/protocol'
import type { WarmupAssignment } from './warmup'
import { warmupSequenceDoc } from './warmup-workflow'

const assignment = (over: Partial<WarmupAssignment> = {}): WarmupAssignment => ({
  deviceId: 'd1',
  platform: 'tiktok',
  styleId: 'tt-a',
  styleTitle: 'For You, notifications and the shop',
  note: null,
  steps: [
    { activityId: 'a1', title: 'Scroll For You', script: 'tiktok/auto-scroll@latest', params: { videos: 12, keywords: ['trading'] }, atSec: 30 },
    { activityId: 'a2', title: 'Check notifications', script: 'tiktok/notification-activity@latest', params: { scrolls: 2 }, atSec: 55 },
    { activityId: 'a3', title: 'Browse the shop', script: 'tiktok/shop-browse@latest', params: { scrolls: 3 }, atSec: 90 },
  ],
  ...over,
})

const GAPS: readonly [number, number] = [8, 20]

describe('warmupSequenceDoc — one phone, one job, the waits inside it', () => {
  /*
    The decisive test. A document this plugin generates has to survive the SAME
    schema a saved one does — and the first hand-written attempt at one (plan
    907 §4.1) was refused for passing bare values where every workflow value
    takes a wrapper. A generator that gets that wrong fails on a phone; this
    catches it here.
  */
  test('the generated document is accepted by the real schema', () => {
    const doc = warmupSequenceDoc(assignment(), { gapSec: GAPS })
    const parsed = WorkflowDocSchema.safeParse(doc)
    expect(parsed.success).toBe(true)
  })

  test('every script the planner drew is in it, in the same order', () => {
    const doc = warmupSequenceDoc(assignment(), { gapSec: GAPS })
    const scripts = (doc?.nodes ?? []).filter((n) => n.kind === 'script').map((n) => (n as { script: string }).script)
    expect(scripts).toEqual(['tiktok/auto-scroll@latest', 'tiktok/notification-activity@latest', 'tiktok/shop-browse@latest'])
  })

  /* The gaps are the ones the row already says it has — re-drawing them here would make the session lie about its own pace. */
  test('the delays are the planner\'s own gaps, not a fresh draw', () => {
    const doc = warmupSequenceDoc(assignment(), { gapSec: GAPS })
    const delays = (doc?.nodes ?? []).filter((n) => n.kind === 'delay').map((n) => (n as { ms: { const: number } }).ms.const)
    // 55 - 30 = 25s, 90 - 55 = 35s
    expect(delays).toEqual([25_000, 35_000])
  })

  test('params are wrapped as workflow values, never passed bare', () => {
    const doc = warmupSequenceDoc(assignment(), { gapSec: GAPS })
    const first = (doc?.nodes ?? []).find((n) => n.kind === 'script') as { params: Record<string, unknown> }
    expect(first.params.videos).toEqual({ const: 12 })
    expect(first.params.keywords).toEqual({ const: ['trading'] })
  })

  test('it starts at the first activity and ends on a finish', () => {
    const doc = warmupSequenceDoc(assignment(), { gapSec: GAPS })
    const kinds = (doc?.nodes ?? []).map((n) => n.kind)
    expect(kinds[0]).toBe('start')
    expect(kinds.at(-1)).toBe('finish')
    expect(doc?.entry).toBe('start')
  })

  /* A workflow with no script in it is a job that does nothing; one per idle phone would fill the job list with meaningless successes. */
  test('a phone given nothing gets no document at all', () => {
    expect(warmupSequenceDoc(assignment({ steps: [], platform: null, styleId: null, styleTitle: null, note: 'no number' }), { gapSec: GAPS })).toBeNull()
  })

  test('a single-activity sequence needs no delay node', () => {
    const doc = warmupSequenceDoc(assignment({ steps: [{ activityId: 'a1', title: 'Only', script: 'tiktok/search-keyword@latest', params: { query: 'gold' }, atSec: 0 }] }), { gapSec: GAPS })
    expect(WorkflowDocSchema.safeParse(doc).success).toBe(true)
    expect((doc?.nodes ?? []).filter((n) => n.kind === 'delay')).toHaveLength(0)
  })

  /* A settings change that made the gaps enormous must not leave a phone asleep for an afternoon. */
  test('every delay carries a ceiling of its own', () => {
    const doc = warmupSequenceDoc(assignment(), { gapSec: [0, 3_600] })
    for (const node of (doc?.nodes ?? []).filter((n) => n.kind === 'delay')) {
      expect((node as { maxMs: number }).maxMs).toBeGreaterThan(0)
    }
  })

  /* The document is bounded like any other, so a long style cannot outgrow the engine's own limit. */
  test('a full nine-activity style still fits inside the node limit', () => {
    const long = assignment({
      steps: Array.from({ length: 9 }, (_, i) => ({ activityId: `a${i}`, title: `Activity ${i}`, script: 'tiktok/auto-scroll@latest', params: { videos: 3 }, atSec: i * 20 })),
    })
    const doc = warmupSequenceDoc(long, { gapSec: GAPS })
    expect(doc?.nodes.length).toBe(9 * 2 + 1)
    expect(WorkflowDocSchema.safeParse(doc).success).toBe(true)
  })
})
