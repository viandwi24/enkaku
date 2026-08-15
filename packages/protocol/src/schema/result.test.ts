import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { ENKAKU_META_KEY, ui } from './vocabulary'
import { RESULT_LIMITS, RESULT_STATUSES, ResultOutcomeSchema, ResultStatusSchema, buildResultSummary, summaryFields } from './result'

describe('RESULT_STATUSES / ResultStatusSchema (plan 97 §3.3, §4.1)', () => {
  test('exactly the five states §3.3 names — no more, no fewer', () => {
    expect(RESULT_STATUSES).toEqual(['undeclared', 'valid', 'invalid', 'partial', 'oversize'])
  })

  test('ResultStatusSchema accepts every member', () => {
    for (const status of RESULT_STATUSES) {
      expect(ResultStatusSchema.parse(status)).toBe(status)
    }
  })

  test('ResultStatusSchema rejects anything else', () => {
    expect(ResultStatusSchema.safeParse('failed').success).toBe(false)
    expect(ResultStatusSchema.safeParse('').success).toBe(false)
    expect(ResultStatusSchema.safeParse(null).success).toBe(false)
  })
})

describe('RESULT_LIMITS (plan 97 §3.4, §3.7, §4.1)', () => {
  test('matches kv.maxValueBytes — the other place a script persists structured JSON', () => {
    expect(RESULT_LIMITS.defaultMaxResultBytes).toBe(65_536)
  })

  test('at most three summary fields', () => {
    expect(RESULT_LIMITS.maxSummaryFields).toBe(3)
  })

  test('the rest of the written numbers', () => {
    expect(RESULT_LIMITS.maxSummaryChars).toBe(120)
    expect(RESULT_LIMITS.maxIssues).toBe(20)
    expect(RESULT_LIMITS.maxIssueMessageChars).toBe(200)
    expect(RESULT_LIMITS.maxProgressBytes).toBe(4_096)
  })
})

describe('summaryFields — total: never throws, never propagates junk (plan 97 §3.6, §4.1)', () => {
  test('a null schema (undeclared) returns []', () => {
    expect(summaryFields(null)).toEqual([])
  })

  test('a schema with no properties returns []', () => {
    expect(summaryFields({ type: 'object' })).toEqual([])
  })

  test('a schema whose fields carry no summary hint returns []', () => {
    const schema = z.toJSONSchema(z.object({ videos: z.number().int().meta(ui({ title: 'Videos', kind: 'count' })) }), { io: 'output' })
    expect(summaryFields(schema)).toEqual([])
  })

  test('fields marked summary: true come back in declaration order, with their title/kind/unit', () => {
    const resultSchema = z.object({
      videos: z.number().int().meta(ui({ title: 'Videos watched', kind: 'count', summary: true })),
      watchSeconds: z.number().meta(ui({ title: 'Time on feed', kind: 'duration', unit: 's', summary: true })),
      matchRate: z.number().min(0).max(1).meta(ui({ title: 'Matched the target', kind: 'chance' })),
    })
    const json = z.toJSONSchema(resultSchema, { io: 'output' })
    expect(summaryFields(json)).toEqual([
      { path: 'videos', title: 'Videos watched', kind: 'count', unit: undefined },
      { path: 'watchSeconds', title: 'Time on feed', kind: 'duration', unit: 's' },
    ])
  })

  test('a field with no title falls back to its own key', () => {
    const schema = { type: 'object', properties: { videos: { [ENKAKU_META_KEY]: { summary: true } } } }
    expect(summaryFields(schema)).toEqual([{ path: 'videos', title: 'videos', kind: undefined, unit: undefined }])
  })

  test('caps at RESULT_LIMITS.maxSummaryFields even when more fields claim summary: true', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { title: 'A', [ENKAKU_META_KEY]: { summary: true } },
        b: { title: 'B', [ENKAKU_META_KEY]: { summary: true } },
        c: { title: 'C', [ENKAKU_META_KEY]: { summary: true } },
        d: { title: 'D', [ENKAKU_META_KEY]: { summary: true } },
      },
    }
    expect(summaryFields(schema)).toHaveLength(3)
  })

  test('a malformed hints object (fails ParamHintsSchema) is treated as no hints, not a throw', () => {
    const schema = { type: 'object', properties: { videos: { [ENKAKU_META_KEY]: { kind: 'duration' } } } }
    expect(summaryFields(schema)).toEqual([])
  })
})

describe('buildResultSummary (plan 97 §3.6, §4.1, worked example from §5 step 97.8)', () => {
  test("the tiktok-pack worked example: count + duration join as '312 videos · 42 min'", () => {
    const fields = [
      { path: 'videos', title: 'Videos watched', kind: 'count' as const, unit: undefined },
      { path: 'watchSeconds', title: 'Time on feed', kind: 'duration' as const, unit: 's' as const },
    ]
    expect(buildResultSummary(fields, { videos: 312, watchSeconds: 2520 })).toBe('312 videos · 42 min')
  })

  test('no fields marked → null', () => {
    expect(buildResultSummary([], { videos: 312 })).toBeNull()
  })

  test('a non-object value → null', () => {
    const fields = [{ path: 'videos', title: 'Videos', kind: 'count' as const, unit: undefined }]
    expect(buildResultSummary(fields, null)).toBeNull()
    expect(buildResultSummary(fields, 'raw string')).toBeNull()
    expect(buildResultSummary(fields, [1, 2, 3])).toBeNull()
  })

  test('a marked field missing from the value is skipped, not rendered as "undefined"', () => {
    const fields = [
      { path: 'videos', title: 'Videos', kind: 'count' as const, unit: undefined },
      { path: 'watchSeconds', title: 'Time on feed', kind: 'duration' as const, unit: 's' as const },
    ]
    expect(buildResultSummary(fields, { watchSeconds: 90 })).toBe('1 min 30 s')
  })

  test('every field missing → null, not an empty string', () => {
    const fields = [{ path: 'videos', title: 'Videos', kind: 'count' as const, unit: undefined }]
    expect(buildResultSummary(fields, {})).toBeNull()
  })

  test('chance/bytes/bitrate/pixels/temperature already carry their own unit through formatValue', () => {
    expect(buildResultSummary([{ path: 'matchRate', title: 'Matched', kind: 'chance', unit: undefined }], { matchRate: 0.35 })).toBe('35%')
    expect(buildResultSummary([{ path: 'bytesPulled', title: 'Pulled', kind: 'bytes', unit: undefined }], { bytesPulled: 536_870_912 })).toBe(
      '512 MB',
    )
  })

  test('a string field renders as its own text; an empty string is skipped', () => {
    expect(buildResultSummary([{ path: 'reason', title: 'Reason', kind: undefined, unit: undefined }], { reason: 'blocked' })).toBe('blocked')
    expect(buildResultSummary([{ path: 'reason', title: 'Reason', kind: undefined, unit: undefined }], { reason: '' })).toBeNull()
  })

  test('a boolean field renders as "<title>: yes|no"', () => {
    expect(buildResultSummary([{ path: 'endedOnStall', title: 'Ended on stall', kind: undefined, unit: undefined }], { endedOnStall: true })).toBe(
      'Ended on stall: yes',
    )
  })

  test('a plain (no-kind) number gets the field title as its unit word, same as count', () => {
    expect(buildResultSummary([{ path: 'retries', title: 'Retries needed', kind: undefined, unit: undefined }], { retries: 2 })).toBe(
      '2 retries',
    )
  })

  test('a result over maxSummaryChars is truncated with an ellipsis, never silently cut without a marker', () => {
    const fields = [{ path: 'reason', title: 'Reason', kind: undefined, unit: undefined }]
    const long = 'x'.repeat(RESULT_LIMITS.maxSummaryChars + 50)
    const summary = buildResultSummary(fields, { reason: long })
    expect(summary).not.toBeNull()
    expect(summary?.length).toBe(RESULT_LIMITS.maxSummaryChars)
    expect(summary?.endsWith('…')).toBe(true)
  })
})

/**
 * Plan 97 §3.3, §3.4, §3.8, §4.3, step 97.3 — the child's own verdict, the
 * shape carried across every boundary that touches it (the child⇄parent
 * `result` IPC message, the node⇄control-plane tunnel, `AttemptOutcome` /
 * `JobRunner.execute()`, and `result-store.ts`'s `recordResult`).
 */
describe('ResultOutcomeSchema (plan 97 §3.3, §3.4, §3.8, §4.3)', () => {
  test('accepts the minimal shape — status and bytes only, no issues', () => {
    const parsed = ResultOutcomeSchema.safeParse({ status: 'valid', bytes: 42 })
    expect(parsed.success).toBe(true)
  })

  test('accepts issues up to maxIssues, rejects one over it', () => {
    const issues = Array.from({ length: RESULT_LIMITS.maxIssues }, (_, i) => ({ path: `field${i}`, message: 'bad' }))
    expect(ResultOutcomeSchema.safeParse({ status: 'invalid', bytes: 10, issues }).success).toBe(true)
    const tooMany = [...issues, { path: 'oneMore', message: 'bad' }]
    expect(ResultOutcomeSchema.safeParse({ status: 'invalid', bytes: 10, issues: tooMany }).success).toBe(false)
  })

  test('rejects a status outside the five states, a negative byte count, or a non-integer byte count', () => {
    expect(ResultOutcomeSchema.safeParse({ status: 'failed', bytes: 0 }).success).toBe(false)
    expect(ResultOutcomeSchema.safeParse({ status: 'valid', bytes: -1 }).success).toBe(false)
    expect(ResultOutcomeSchema.safeParse({ status: 'valid', bytes: 1.5 }).success).toBe(false)
  })

  test('bytes: 0 is legal — the circular-reference case (V2, H2) has nothing to measure', () => {
    expect(ResultOutcomeSchema.safeParse({ status: 'invalid', bytes: 0, issues: [{ path: '', message: 'circular' }] }).success).toBe(true)
  })
})
