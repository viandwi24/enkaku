import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { HOSTILE_PARAMS_FIXTURES, ui } from '@enkaku/protocol'
import { planResult } from './plan-result'
import type { JsonSchemaNode } from '../schema-form/types'

/**
 * `plan-result.ts`'s own test file — PURE, like `plan.test.ts` beside it
 * (plan 95 §3.3, plan 97 §5 step 97.6's own checklist item: "Pure; its test
 * imports no React"). `planResult` is schema + value in, plan out; nothing
 * here needs a document to run.
 */

/** A real result schema, `io: 'output'` (§3.2 — a result describes what
 *  already happened, so a `.default()` field is legitimately `required`),
 *  round-tripped through JSON the way a published schema actually would be
 *  (`JSON.parse(JSON.stringify(...))`, matching `plan.test.ts`'s own
 *  `planOne` helper). */
function toResultSchema(shape: z.ZodRawShape): JsonSchemaNode {
  return JSON.parse(JSON.stringify(z.toJSONSchema(z.object(shape), { io: 'output' }))) as JsonSchemaNode
}

describe('planResult — delegation (H3: a flat object of scalars plus one record)', () => {
  /**
   * H3's own evidence: the tiktok pack's real result is thirteen fields,
   * twelve scalars and one `Record<string, number>`. This is that shape,
   * with `kind`/`unit` on the numeric fields exactly as the worked example
   * in §3.2 declares them, and the verifiable result 97.6 names: every
   * field renders through an EXISTING `FieldPlan` row, no new control.
   */
  const autoScrollResult = toResultSchema({
    videos: z.number().int().meta(ui({ title: 'Videos watched', kind: 'count' })),
    watchSeconds: z.number().meta(ui({ title: 'Time on feed', kind: 'duration', unit: 's' })),
    matchRate: z.number().min(0).max(1).meta(ui({ title: 'Matched the target', kind: 'chance' })),
    byLabel: z.record(z.string(), z.number()).meta(ui({ title: 'Videos by label' })),
    endedOnStall: z.boolean().default(false),
  })

  const value = {
    videos: 312,
    watchSeconds: 2520,
    matchRate: 0.35,
    byLabel: { funny: 120, dance: 80, other: 112 },
    endedOnStall: false,
  }

  test('every declared field plans through an existing row — no new control', () => {
    const fields = planResult(autoScrollResult, value)
    const byPath = new Map(fields.map((f) => [f.path, f]))

    // `step`/`increment` land here too (96.31) — `planResult` delegates to
    // the SAME `planField` a form uses, unchanged, so an integer result
    // field plans `step: 1`/`increment: 1` exactly as a form's would.
    expect(byPath.get('videos')?.plan).toEqual({
      control: 'number',
      kind: 'count',
      unit: undefined,
      enforcement: undefined,
      step: 1,
      increment: 1,
    })
    expect(byPath.get('watchSeconds')?.plan).toMatchObject({ control: 'number', kind: 'duration', unit: 's' })
    expect(byPath.get('matchRate')?.plan).toMatchObject({ control: 'number', kind: 'chance' })
    expect(byPath.get('endedOnStall')?.plan).toEqual({ control: 'toggle' })

    // The record field plans as a `group` whose children are R2's own rows
    // (declaration below), never `planField`'s row-13 `json` fallback —
    // that fallback is exactly right for a FORM (no value to expand), and
    // exactly wrong for a result that already has one.
    const byLabel = byPath.get('byLabel')
    expect(byLabel?.plan.control).toBe('group')
    expect(byLabel?.plan.control === 'group' ? byLabel.plan.children.map((c) => c.path).sort() : null).toEqual(['dance', 'funny', 'other'])
  })

  test('values are carried alongside each plan, unchanged', () => {
    const fields = planResult(autoScrollResult, value)
    const byPath = new Map(fields.map((f) => [f.path, f]))
    expect(byPath.get('videos')?.value).toBe(312)
    expect(byPath.get('matchRate')?.value).toBe(0.35)
  })

  test('no field is marked `unknown` when the value declares nothing extra', () => {
    const fields = planResult(autoScrollResult, value)
    expect(fields.every((f) => !f.unknown)).toBe(true)
  })
})

describe('planResult — R1: branch selection', () => {
  const okShape = toResultSchema({
    ok: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), videos: z.number().int() }),
      z.object({ ok: z.literal(false), reason: z.enum(['blocked', 'logged-out', 'no-feed']) }),
    ]),
  })
  // Zod nests the discriminated union one level (`{ ok: <union> }`) — pull
  // the union node itself out, matching how a script would actually declare
  // `result: z.discriminatedUnion(...)` at the TOP level (§3.5's own example).
  const unionSchema = (okShape.properties as Record<string, JsonSchemaNode>).ok as JsonSchemaNode

  test('the branch matching the value is planned, not a raw json fallback', () => {
    const fields = planResult(unionSchema, { ok: true, videos: 12 })
    const byPath = new Map(fields.map((f) => [f.path, f]))
    expect(byPath.get('videos')?.plan.control).toBe('number')
    expect(byPath.has('reason')).toBe(false)
  })

  test('the other branch matches its own value', () => {
    const fields = planResult(unionSchema, { ok: false, reason: 'blocked' })
    const byPath = new Map(fields.map((f) => [f.path, f]))
    expect(byPath.get('reason')?.plan.control).toBe('choice')
  })

  test('K7 wrong-branch — a value matching no branch plans as json, never a throw', () => {
    const fields = planResult(unionSchema, { ok: 'neither', mystery: true })
    expect(fields).toHaveLength(1)
    expect(fields[0]?.plan).toMatchObject({ control: 'json' })
  })
})

describe('planResult — R2: record expansion', () => {
  test('a bare top-level z.record renders the value\'s own keys as rows', () => {
    const recordSchema: JsonSchemaNode = { type: 'object', additionalProperties: { type: 'number' } }
    const fields = planResult(recordSchema, { funny: 120, dance: 80 })
    expect(fields.map((f) => f.path).sort()).toEqual(['dance', 'funny'])
    expect(fields.every((f) => f.plan.control === 'number')).toBe(true)
  })

  test('an empty record value plans to zero rows, not a throw', () => {
    const recordSchema: JsonSchemaNode = { type: 'object', additionalProperties: { type: 'number' } }
    expect(planResult(recordSchema, {})).toEqual([])
  })

  test('K7 record-no-properties — the params-side fixture plans with no throw', () => {
    const fixture = HOSTILE_PARAMS_FIXTURES['record-no-properties']
    expect(() => planResult(fixture, {})).not.toThrow()
  })
})

describe('planResult — R3: unknown keys are shown, never hidden', () => {
  const schema = toResultSchema({ videos: z.number().int() })

  test('a key the schema never declared is still rendered, flagged unknown', () => {
    const fields = planResult(schema, { videos: 5, secretDebugInfo: { hidden: true } })
    const extra = fields.find((f) => f.path === 'secretDebugInfo')
    expect(extra?.unknown).toBe(true)
    expect(extra?.value).toEqual({ hidden: true })
  })

  test('declared fields still come first, unknown ones after', () => {
    const fields = planResult(schema, { secretDebugInfo: 1, videos: 5 })
    expect(fields.map((f) => f.path)).toEqual(['videos', 'secretDebugInfo'])
  })

  test('a __proto__ value key is never surfaced, known or unknown', () => {
    // Built with `JSON.parse`, never an object literal — a literal
    // `__proto__:` key is special-cased by the language to set
    // `[[Prototype]]` instead of creating an own property, which would
    // silently defeat the very fixture meant to exercise this hazard (the
    // same reasoning `hostile-fixtures.ts`'s own `non-identifier-keys`
    // entry documents).
    const value = JSON.parse('{"videos": 5, "__proto__": {"polluted": true}}')
    const fields = planResult(schema, value)
    expect(fields.some((f) => f.path === '__proto__')).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('planResult — totality: never throws, never drops the value', () => {
  test('a schema with no object shape still returns the whole value as one field', () => {
    const fields = planResult({ type: 'string' }, 'whoer.net')
    expect(fields).toEqual([{ path: '', label: 'Result', advanced: false, required: false, value: 'whoer.net', plan: { control: 'text', multiline: false, maxLength: undefined } }])
  })

  test('K7 — every hostile schema fixture plans against an arbitrary value with no throw', () => {
    for (const [name, fixture] of Object.entries(HOSTILE_PARAMS_FIXTURES)) {
      expect(() => planResult(fixture, { anything: 'goes', n: 1 }), name).not.toThrow()
      expect(() => planResult(fixture, null), name).not.toThrow()
      expect(() => planResult(fixture, undefined), name).not.toThrow()
    }
  })
})
