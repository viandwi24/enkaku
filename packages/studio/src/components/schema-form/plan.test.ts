import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { DeviceSettingsSchema, FarmSettingsSchema, ui } from '@enkaku/protocol'
// The tiktok pack has no `main`/`exports` field (it is loaded through its
// `enkaku.entry` manifest key by the core's plugin loader, not through
// ordinary package resolution) — the explicit subpath is what makes
// `@enkaku/plugin-tiktok`, a real workspace package, resolvable at all. This
// still goes through the package NAME, never a relative path across a
// package boundary.
import tiktokPlugin from '@enkaku/plugin-tiktok/src/index.ts'
import type { FieldPlan, PlanContext, PlannedField } from './plan'
import { planField, planForm, sectionFields } from './plan'
import type { JsonSchemaNode } from './types'

/**
 * `plan.ts`'s own test file — PURE. No React, no `@testing-library`, no DOM
 * of any kind: `planField`/`planForm` are schema in, plan out, and this file
 * proves it by never importing anything that needs a document to run (plan
 * 95 §3.3, §5 step 95.2's checklist). That is what keeps this file
 * meaningful across a Studio restyle: the design system can change
 * underneath it and every test here still describes what the form must
 * express.
 */

function rootCtx(root: JsonSchemaNode, depth = 1): PlanContext {
  return { root, depth, seen: new Set() }
}

/** Plans the JSON Schema for one Zod field, as it would arrive at the
 *  resolver in production: through `z.object({ field: ... })` →
 *  `z.toJSONSchema` → `planForm`. Returns the single field's plan. */
function planOne(zodField: z.ZodTypeAny): FieldPlan {
  const schema = JSON.parse(JSON.stringify(z.toJSONSchema(z.object({ field: zodField })))) as JsonSchemaNode
  const [planned] = planForm(schema)
  if (!planned) throw new Error('expected exactly one planned field')
  return planned.plan
}

describe('planField — the precedence table (plan 95 §3.3), one case per row', () => {
  test('row 1 — a non-cycling $ref resolves against the root', () => {
    const schema: JsonSchemaNode = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/Named' } },
      $defs: { Named: { type: 'object', properties: { x: { type: 'number' } } } },
    }
    const [a] = planForm(schema)
    expect(a?.plan.control).toBe('group')
  })

  test('row 1 — a $ref cycle yields json with "this parameter refers to itself" (F21, R1)', () => {
    // The exact shape F21 measured against this repo's own Zod: a nested
    // `z.lazy()` dedupes into `$defs.__schema0`, whose own `next` property
    // `$ref`s straight back to it.
    const Node: z.ZodTypeAny = z.lazy(() => z.object({ label: z.string(), next: Node.optional() }))
    const schema = JSON.parse(JSON.stringify(z.toJSONSchema(z.object({ tree: Node })))) as JsonSchemaNode
    expect(schema.$defs?.__schema0?.properties?.next?.$ref).toBe('#/$defs/__schema0')

    const [tree] = planForm(schema)
    expect(tree?.plan.control).toBe('group')
    if (tree?.plan.control !== 'group') throw new Error('unreachable')
    const next = tree.plan.children.find((c) => c.path === 'next')
    expect(next?.plan).toEqual({ control: 'json', reason: 'this parameter refers to itself' })
    // ...and the sibling that is NOT part of the cycle still plans normally
    // — one field being unrenderable never takes the rest of the form down.
    const label = tree.plan.children.find((c) => c.path === 'label')
    expect(label?.plan.control).toBe('text')
  })

  test('row 2 — depth over SCHEMA_LIMITS.maxDepth yields json with "too deeply nested to render", and terminates', () => {
    // Deep, plain nesting with no `$ref` anywhere — isolates the DEPTH
    // mechanism from the $ref mechanism above.
    function nested(levels: number): JsonSchemaNode {
      return levels <= 0
        ? { type: 'number' }
        : { type: 'object', properties: { child: nested(levels - 1) }, required: ['child'] }
    }
    const schema: JsonSchemaNode = { type: 'object', properties: { top: nested(20) }, required: ['top'] }

    const start = Date.now()
    const [top] = planForm(schema)
    // Walk down through nested groups until something other than a group
    // is found — bounded by construction (the depth cap forces this to
    // terminate well before 20 levels), which is the totality claim itself.
    let plan = top?.plan
    let guard = 0
    while (plan?.control === 'group' && guard < 20) {
      plan = plan.children[0]?.plan
      guard++
    }
    expect(Date.now() - start).toBeLessThan(1000)
    expect(plan).toEqual({ control: 'json', reason: 'too deeply nested to render' })
  })

  test('row 3 — a declared kind valid for its structural type wins, one case per kind', () => {
    expect(planOne(z.number().int().min(0).default(0).meta(ui({ title: 'Videos', kind: 'count' })))).toEqual({
      control: 'number',
      kind: 'count',
      min: 0,
      step: 1,
      increment: 1,
    })
    expect(planOne(z.number().min(0).max(1).default(0).meta(ui({ title: 'Save chance', kind: 'chance' })))).toEqual({
      control: 'number',
      kind: 'chance',
      min: 0,
      max: 1,
      step: 'any',
      increment: 0.01,
    })
    expect(planOne(z.number().int().meta(ui({ title: 'Timeout', kind: 'duration', unit: 'ms' })))).toEqual({
      control: 'number',
      kind: 'duration',
      unit: 'ms',
      step: 1,
      increment: 1,
    })
    expect(planOne(z.number().int().meta(ui({ title: 'Max push', kind: 'bytes' })))).toEqual({
      control: 'number',
      kind: 'bytes',
      step: 1,
      increment: 1,
    })
    expect(planOne(z.number().int().meta(ui({ title: 'Bitrate', kind: 'bitrate' })))).toEqual({
      control: 'number',
      kind: 'bitrate',
      step: 1,
      increment: 1,
    })
    expect(planOne(z.number().int().meta(ui({ title: 'Max size', kind: 'pixels' })))).toEqual({
      control: 'number',
      kind: 'pixels',
      step: 1,
      increment: 1,
    })
    // NOT `.int()` — `tempThresholdC` in the real schema is a plain float
    // field (96.31's own blast radius), so this row deliberately does not
    // add `.int()` the way the others above do.
    expect(planOne(z.number().meta(ui({ title: 'Threshold', kind: 'temperature' })))).toEqual({
      control: 'number',
      kind: 'temperature',
      step: 'any',
      increment: 0.01,
    })
    expect(planOne(z.string().meta(ui({ title: 'Note', kind: 'text' })))).toEqual({ control: 'text', multiline: false })
    expect(planOne(z.string().meta(ui({ title: 'Package', kind: 'packageName' })))).toEqual({ control: 'text', multiline: false })
    expect(planOne(z.string().meta(ui({ title: 'Output folder', kind: 'workspaceFolder' })))).toEqual({ control: 'workspacePath', target: 'folder' })
    expect(planOne(z.string().meta(ui({ title: 'Captions', kind: 'workspaceFile' })))).toEqual({ control: 'workspacePath', target: 'file' })
  })

  test('row 4 — enum or const becomes a choice, decorated by labels', () => {
    expect(planOne(z.enum(['as-listed', 'random']).meta(ui({ title: 'Order', labels: { random: 'Shuffled' } })))).toEqual({
      control: 'choice',
      options: [
        { value: 'as-listed', label: 'as-listed' },
        { value: 'random', label: 'Shuffled' },
      ],
      source: undefined,
    })
    expect(planOne(z.literal('fixed'))).toEqual({ control: 'choice', options: [{ value: 'fixed', label: 'fixed' }], source: undefined })
  })

  test('row 4 — source is carried, not fetched (K4: enrichment happens later, in the control)', () => {
    const plan = planOne(z.enum(['a', 'b']).meta(ui({ title: 'Engine', source: 'registry.transports' })))
    expect(plan).toEqual({ control: 'choice', options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }], source: 'registry.transports' })
  })

  test('row 5 — boolean becomes a toggle', () => {
    expect(planOne(z.boolean())).toEqual({ control: 'toggle' })
  })

  test('row 6 — a 2-number tuple is a pair; ordered defaults true and is one word away from false', () => {
    expect(planOne(z.tuple([z.number(), z.number()]))).toEqual({
      control: 'pair',
      ordered: true,
      item: { control: 'number', kind: 'plain', step: 'any', increment: 0.01 },
    })
    expect(planOne(z.tuple([z.number(), z.number()]).meta(ui({ title: 'Pair', ordered: false })))).toMatchObject({
      control: 'pair',
      ordered: false,
    })
  })

  test('row 6 — a pair\'s kind/unit hint lives on the TUPLE and is applied to the half via rows 3/9', () => {
    const plan = planOne(z.tuple([z.number().int(), z.number().int()]).meta(ui({ title: 'Interval', kind: 'duration', unit: 'ms' })))
    expect(plan).toEqual({ control: 'pair', ordered: true, item: { control: 'number', kind: 'duration', unit: 'ms', step: 1, increment: 1 } })
  })

  test('row 7 — a known string format becomes the matching control, not a guess', () => {
    expect(planOne(z.string().email())).toEqual({ control: 'text', multiline: false, format: 'email' })
    expect(planOne(z.string().url())).toEqual({ control: 'text', multiline: false, format: 'uri' })
    expect(planOne(z.iso.datetime())).toEqual({ control: 'text', multiline: false, format: 'date-time' })
  })

  test('row 8 — a plain string is text; multiline inferred only from maxLength > 200', () => {
    expect(planOne(z.string())).toEqual({ control: 'text', multiline: false, maxLength: undefined })
    expect(planOne(z.string().max(50))).toEqual({ control: 'text', multiline: false, maxLength: 50 })
    expect(planOne(z.string().max(500))).toEqual({ control: 'text', multiline: true, maxLength: 500 })
    // The hint overrides the length heuristic in both directions.
    expect(planOne(z.string().max(500).meta(ui({ title: 'Token', multiline: false })))).toEqual({
      control: 'text',
      multiline: false,
      maxLength: 500,
    })
  })

  test('row 9 — a plain number/integer takes bounds from the schema and kind "plain"', () => {
    expect(planOne(z.number())).toEqual({ control: 'number', kind: 'plain', step: 'any', increment: 0.01 })
    expect(planOne(z.number().min(1).max(2000).default(30))).toEqual({ control: 'number', kind: 'plain', min: 1, max: 2000, step: 'any', increment: 0.01 })
    // `multipleOf` wins over the type-derived default on BOTH `step` and
    // `increment` — a declared multiple is a stronger statement than either
    // fallback.
    expect(planOne(z.number().multipleOf(5))).toEqual({ control: 'number', kind: 'plain', step: 5, increment: 5 })
  })

  test('row 9 (F5) — the ±MAX_SAFE_INTEGER sentinels z.number().int() emits with no explicit bounds are treated as unbounded', () => {
    const json = JSON.parse(JSON.stringify(z.toJSONSchema(z.number().int()))) as JsonSchemaNode
    expect(json.minimum).toBe(-Number.MAX_SAFE_INTEGER)
    expect(json.maximum).toBe(Number.MAX_SAFE_INTEGER)
    expect(planOne(z.number().int())).toEqual({ control: 'number', kind: 'plain', step: 1, increment: 1 })
    // A REAL bound close to, but not equal to, the sentinel is kept.
    expect(planOne(z.number().int().max(9007199254740990))).toEqual({
      control: 'number',
      kind: 'plain',
      max: 9007199254740990,
      step: 1,
      increment: 1,
    })
  })

  /**
   * 96.31 — the exact reported failure. The owner opened Settings, changed
   * nothing, clicked Save, and the browser refused the form's OWN
   * server-loaded value: `gestureCurvature` (`min(0).max(0.5).default(0.08)`,
   * no `.multipleOf()`) used to plan `step: undefined`, `NumberField` then
   * omitted the HTML `step` attribute, and HTML's own default for
   * `type="number"` is `step="1"` — so with `min=0`, only 0, 1, 2… were
   * valid and the stored `0.08` failed native validation with "The nearest
   * valid value is 0." This is the shape that must plan a `step` under which
   * `0.08` is a valid value: `'any'` imposes no multiple-of constraint at
   * all, which is the only correct reading of a float with no declared
   * `multipleOf`.
   */
  test('row 9 (96.31) — a gestureCurvature-shaped field plans a step that accepts its own stored 0.08', () => {
    const plan = planOne(z.number().min(0).max(0.5).default(0.08).meta({ title: 'Gesture curvature' }))
    expect(plan).toEqual({ control: 'number', kind: 'plain', min: 0, max: 0.5, step: 'any', increment: 0.01 })
    expect(plan.control).toBe('number')
    if (plan.control !== 'number') throw new Error('unreachable')
    // The actual native-validation question: is 0.08 a multiple of `step`
    // starting at `min`? `step: 'any'` means "yes, unconditionally" — no
    // finite step value could ever pass this same assertion for an
    // arbitrary float default, which is exactly why 'any' (not a smaller
    // number) is the correct plan for an undeclared float constraint.
    expect(plan.step).toBe('any')
  })

  /**
   * 96.31's second named instance — `lat`/`lng` (decimal degrees,
   * `packages/protocol/src/settings.ts:198-199`) can never hold a real
   * coordinate under the old behaviour, because almost every real latitude
   * or longitude is fractional and the implicit `step="1"` would reject it
   * exactly like `gestureCurvature` did.
   */
  test('row 9 (96.31) — a lat/lng-shaped field plans a step that accepts a real decimal coordinate', () => {
    const lat = planOne(z.number().min(-90).max(90).describe('Latitude, in decimal degrees').meta({ title: 'Latitude' }))
    expect(lat).toEqual({ control: 'number', kind: 'plain', min: -90, max: 90, step: 'any', increment: 0.01 })
    const lng = planOne(z.number().min(-180).max(180).describe('Longitude, in decimal degrees').meta({ title: 'Longitude' }))
    expect(lng).toEqual({ control: 'number', kind: 'plain', min: -180, max: 180, step: 'any', increment: 0.01 })
    // -6.2088, 106.8456 — Jakarta, a real coordinate, not a round number.
    // `step: 'any'` is what makes a browser accept it; nothing in `planOne`'s
    // output claims to validate the VALUE itself (that is `validate.ts`'s
    // job, unaffected by this fix), only that the HTML attribute this plan
    // produces does not reject it on its own.
  })

  /**
   * 96.31 — do not fix floats by breaking integers. An integer field must
   * keep planning `step: 1` (both as the HTML attribute and the button
   * delta) exactly as it always has — the fix only changes what an
   * UNCONSTRAINED float plans, never an integer.
   */
  test('row 9 (96.31) — an integer field still plans step 1, not "any"', () => {
    expect(planOne(z.number().int().min(0).max(2_000))).toEqual({
      control: 'number',
      kind: 'plain',
      min: 0,
      max: 2_000,
      step: 1,
      increment: 1,
    })
  })

  test('row 10 — an array of objects becomes a table, one planned column per property', () => {
    const plan = planOne(z.array(z.object({ name: z.string(), count: z.number().int() })))
    expect(plan.control).toBe('table')
    if (plan.control !== 'table') throw new Error('unreachable')
    expect(plan.columns).toEqual([
      { key: 'name', label: 'Name', plan: { control: 'text', multiline: false, maxLength: undefined } },
      { key: 'count', label: 'Count', plan: { control: 'number', kind: 'plain', step: 1, increment: 1 } },
    ])
  })

  test('row 11 — an array of scalars becomes a list of the planned item', () => {
    expect(planOne(z.array(z.string()))).toEqual({ control: 'list', item: { control: 'text', multiline: false, maxLength: undefined } })
    expect(planOne(z.array(z.number().int().min(0)))).toEqual({
      control: 'list',
      item: { control: 'number', kind: 'plain', min: 0, step: 1, increment: 1 },
    })
  })

  test('row 12 — a nested object with non-empty properties is a group, children in declaration order', () => {
    const plan = planOne(z.object({ zeta: z.string(), alpha: z.number() }).meta({ title: 'Nested' }))
    expect(plan.control).toBe('group')
    if (plan.control !== 'group') throw new Error('unreachable')
    expect(plan.heading).toBe('Nested')
    expect(plan.children.map((c) => c.path)).toEqual(['zeta', 'alpha'])
  })

  test('row 13 — an object with no properties (z.record) is a labelled escape hatch, never F19\'s empty card', () => {
    expect(planOne(z.record(z.string(), z.number()))).toEqual({ control: 'json', reason: 'this parameter is a free-form map' })
  })

  test('row 14 — anyOf/oneOf with exactly one non-null branch unwraps it (nullable, as today)', () => {
    expect(planOne(z.number().nullable())).toEqual({ control: 'number', kind: 'plain', step: 'any', increment: 0.01 })
    expect(planOne(z.string().nullable())).toEqual({ control: 'text', multiline: false, maxLength: undefined })
  })

  test('row 14 (96.3) — a kind hint on the OUTER nullable wrapper reaches the plan, not just the inner branch', () => {
    // Traced defect (M60 report item 7): `.meta()` chained after
    // `.nullable()` lands `x-enkaku` on the `anyOf` wrapper node, which has
    // no `.type` of its own — row 3 never matched it, and row 14's unwrap
    // re-planned the inner branch with no hints at all, so `kind` was
    // silently ignored. Mirrors the shape `settings.ts`'s `maxTimeoutMs` and
    // `spendCapOutputTokensPer24h` now use for real.
    expect(
      planOne(z.number().int().min(30_000).max(86_400_000).nullable().default(null).meta(ui({ title: 'Timeout', kind: 'duration', unit: 'ms' }))),
    ).toEqual({ control: 'number', kind: 'duration', unit: 'ms', min: 30_000, max: 86_400_000, step: 1, increment: 1 })
  })

  test('row 14 (96.3) — the fix is general, not kind-specific: a non-kind hint (multiline) on the wrapper reaches the plan too', () => {
    expect(planOne(z.string().max(500).nullable().meta(ui({ title: 'Note', multiline: false })))).toEqual({
      control: 'text',
      multiline: false,
      maxLength: 500,
    })
  })

  test('row 14 (96.3) — hints on BOTH the wrapper and the inner branch merge: the branch wins per key, the wrapper fills what the branch leaves unset', () => {
    const zodField = z
      .number()
      .int()
      .meta(ui({ title: 'Inner', kind: 'bytes' }))
      .nullable()
      .meta(ui({ title: 'Outer', kind: 'duration', unit: 'ms' }))
    // `kind`: the inner branch's own 'bytes' wins over the wrapper's
    // 'duration' — neither is silently dropped; 'duration' is overridden,
    // deliberately, by the more specific annotation on the value itself.
    expect(planOne(zodField)).toEqual({ control: 'number', kind: 'bytes', step: 1, increment: 1 })
  })

  test('row 14 (96.3) — the merge is shallow, per ParamHints KEY, not a deep merge of nested values like `labels`', () => {
    const zodField = z
      .enum(['a', 'b'])
      .meta(ui({ title: 'Inner', labels: { a: 'Inner A' } }))
      .nullable()
      .meta(ui({ title: 'Outer', labels: { a: 'Outer A', b: 'Outer B' }, source: 'registry.transports' }))
    // `labels`: the branch's own map REPLACES the wrapper's whole map (not a
    // per-member union) — 'Outer B' is gone even though only 'a' conflicted.
    // `source`: the branch never set it, so the wrapper's value fills the
    // gap and is not lost.
    expect(planOne(zodField)).toEqual({
      control: 'choice',
      options: [
        { value: 'a', label: 'Inner A' },
        { value: 'b', label: 'b' },
      ],
      source: 'registry.transports',
    })
  })

  test('row 15 — anyOf/oneOf with several real branches is a labelled escape hatch, not F20\'s bare textarea', () => {
    const union = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), x: z.number() }),
      z.object({ kind: z.literal('b'), y: z.string() }),
    ])
    expect(planOne(union)).toEqual({ control: 'json', reason: 'this parameter can take several different shapes' })
  })

  test('row 16 — anything else is a result, not an error', () => {
    expect(planOne(z.any())).toEqual({ control: 'json', reason: "this parameter's type is not one the form can draw" })
    expect(planOne(z.unknown())).toEqual({ control: 'json', reason: "this parameter's type is not one the form can draw" })
  })

  test('row 16 is unreachable BY FAILURE — planField never throws for a node planField itself cannot inspect', () => {
    expect(() => planField(null as unknown as JsonSchemaNode, rootCtx({}))).not.toThrow()
    expect(() => planField(undefined as unknown as JsonSchemaNode, rootCtx({}))).not.toThrow()
    expect(planField(null as unknown as JsonSchemaNode, rootCtx({}))).toEqual({
      control: 'json',
      reason: "this parameter's type is not one the form can draw",
    })
  })
})

describe('every kind on the wrong structural type falls through to its structural row (§3.3 "where the resolver refuses to infer")', () => {
  test('a numeric kind on a string falls through to row 7/8, never becomes a number control', () => {
    expect(planOne(z.string().meta(ui({ title: 'Weird', kind: 'count' as never })))).toEqual({
      control: 'text',
      multiline: false,
      maxLength: undefined,
    })
  })

  test('a string kind (text/packageName) on a number falls through to row 9, never becomes a text control', () => {
    expect(planOne(z.number().meta(ui({ title: 'Weird', kind: 'text' as never })))).toEqual({
      control: 'number',
      kind: 'plain',
      step: 'any',
      increment: 0.01,
    })
  })

  test('a workspace path kind on a non-string falls through to that node\'s own structural row', () => {
    expect(planOne(z.number().meta(ui({ title: 'Weird', kind: 'workspaceFolder' as never })))).toEqual({
      control: 'number',
      kind: 'plain',
      step: 'any',
      increment: 0.01,
    })
    expect(planOne(z.boolean().meta(ui({ title: 'Weird', kind: 'workspaceFile' as never })))).toEqual({ control: 'toggle' })
    expect(planOne(z.array(z.string()).meta(ui({ title: 'Weird', kind: 'workspaceFile' as never })))).toMatchObject({ control: 'list' })
    // The same rule row 3 already applies to every kind: a closed choice is
    // never displaced by a free-value control (§3.2).
    expect(planOne(z.enum(['/a', '/b']).meta(ui({ title: 'Weird', kind: 'workspaceFile' as never })))).toMatchObject({ control: 'choice' })
  })

  test('a numeric kind on a boolean falls through to row 5', () => {
    expect(planOne(z.boolean().meta(ui({ title: 'Weird', kind: 'count' as never })))).toEqual({ control: 'toggle' })
  })

  test('a kind on an enum never displaces the choice (an invalid entry must not become easy, §3.2)', () => {
    expect(planOne(z.enum(['a', 'b']).meta(ui({ title: 'Weird', kind: 'text' as never })))).toEqual({
      control: 'choice',
      options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }],
      source: undefined,
    })
  })

  test('"gestureCurvature is not a chance": kind: chance outside [0,1] falls through to row 9\'s plain number (§3.2, §3.3)', () => {
    expect(planOne(z.number().min(0).max(0.5).meta(ui({ title: 'Curvature', kind: 'chance' })))).toEqual({
      control: 'number',
      kind: 'plain',
      min: 0,
      max: 0.5,
      step: 'any',
      increment: 0.01,
    })
    // The brief's own example: [0, 100] is not a percentage either.
    expect(planOne(z.number().min(0).max(100).meta(ui({ title: 'Weird', kind: 'chance' })))).toEqual({
      control: 'number',
      kind: 'plain',
      min: 0,
      max: 100,
      step: 'any',
      increment: 0.01,
    })
  })

  test('kind: duration on an object/array/pair falls through to its own structural row, not row 3', () => {
    expect(planOne(z.object({ a: z.number() }).meta(ui({ title: 'Weird', kind: 'duration' as never, unit: 's' as never })))).toMatchObject({
      control: 'group',
    })
    expect(planOne(z.array(z.string()).meta(ui({ title: 'Weird', kind: 'duration' as never, unit: 's' as never })))).toMatchObject({
      control: 'list',
    })
  })
})

describe('the workspace path kinds — row 3, through the same lookup every other kind uses', () => {
  test('an extension filter rides through onto the file browser, unchanged', () => {
    expect(planOne(z.string().meta(ui({ title: 'Captions', kind: 'workspaceFile', extensions: ['.txt'] })))).toEqual({
      control: 'workspacePath',
      target: 'file',
      extensions: ['.txt'],
    })
  })

  test('extensions on a folder is a malformed hint object, so the WHOLE hint degrades to {} — the same discipline as a unitless duration', () => {
    const schema = {
      type: 'object',
      properties: { out: { type: 'string', 'x-enkaku': { kind: 'workspaceFolder', extensions: ['.txt'] } } },
    } as unknown as JsonSchemaNode
    expect(planField(schema.properties!.out!, rootCtx(schema))).toEqual({ control: 'text', multiline: false, maxLength: undefined })
  })

  test('a folder never carries extensions, even through row 14\'s per-key merge — the one path that can combine two independently valid hints into an invalid one', () => {
    const schema = {
      type: 'object',
      properties: {
        out: {
          'x-enkaku': { kind: 'workspaceFile', extensions: ['.txt'] },
          anyOf: [{ type: 'string', 'x-enkaku': { kind: 'workspaceFolder' } }, { type: 'null' }],
        },
      },
    } as unknown as JsonSchemaNode
    expect(planField(schema.properties!.out!, rootCtx(schema))).toEqual({ control: 'workspacePath', target: 'folder' })
  })

  test('a nullable/optional workspace path still resolves — row 14 threads the wrapper hints down (96.3)', () => {
    expect(planOne(z.string().nullable().meta(ui({ title: 'Captions', kind: 'workspaceFile', extensions: ['.txt'] })))).toEqual({
      control: 'workspacePath',
      target: 'file',
      extensions: ['.txt'],
    })
    expect(planOne(z.string().nullable().optional().meta(ui({ title: 'Folder', kind: 'workspaceFolder' })))).toEqual({
      control: 'workspacePath',
      target: 'folder',
    })
  })

  test('a kind this build does not know falls through to its structural row, never to a browser', () => {
    const schema = {
      type: 'object',
      properties: { out: { type: 'string', 'x-enkaku': { kind: 'workspaceDevice' } } },
    } as unknown as JsonSchemaNode
    expect(planField(schema.properties!.out!, rootCtx(schema))).toEqual({ control: 'text', multiline: false, maxLength: undefined })
  })
})

describe('a bare z.number() plans identically before and after this plan (the no-regression floor, §5 step 95.2)', () => {
  test('no bounds, no hints: a plain number box, nothing fancier', () => {
    // "Before this plan" a bare z.number() rendered as one bare number
    // input with no bounds, no explicit step attribute, no semantic kind
    // (F17). `kind: 'plain'` is the same "nothing more specific was said"
    // outcome, spelled out rather than left implicit — `min`/`max` stay
    // `undefined`, matching what an old renderer had nothing to show either.
    // `step`/`increment` are NOT `undefined` even here, though (96.31): a
    // bare `z.number()` is a `type: 'number'` node with no `multipleOf`, so
    // it plans `step: 'any'` (no HTML constraint, matching the pre-`step`-
    // attribute-era behaviour that omitting the attribute was SUPPOSED to
    // mean) and a `0.01` button increment — never `step: undefined`, which
    // is exactly the value that made the browser fall back to its own
    // implicit `step="1"` and reject a real stored float.
    const plan = planOne(z.number())
    expect(plan).toEqual({ control: 'number', kind: 'plain', step: 'any', increment: 0.01 })
  })
})

describe('planForm — declaration order and per-field metadata (K2, K6 preserved)', () => {
  test('fields come back in declaration order, with humanize() as the never-blank label fallback (K6)', () => {
    const schema = JSON.parse(
      JSON.stringify(z.toJSONSchema(z.object({ tapJitterMs: z.number(), videos: z.number().meta({ title: 'Videos' }) }))),
    ) as JsonSchemaNode
    const fields = planForm(schema)
    expect(fields.map((f) => f.path)).toEqual(['tapJitterMs', 'videos'])
    expect(fields[0]?.label).toBe('Tap Jitter Ms')
    expect(fields[1]?.label).toBe('Videos')
  })

  test('required, group, advanced and showWhen are carried onto PlannedField', () => {
    const schema = JSON.parse(
      JSON.stringify(
        z.toJSONSchema(
          z.object({
            mode: z.enum(['simple', 'advanced']).default('simple').meta(ui({ title: 'Mode' })),
            region: z.string().meta(ui({ title: 'Region', group: 'Advanced', advanced: true, showWhen: { field: 'mode', is: 'advanced' } })),
          }),
        ),
      ),
    ) as JsonSchemaNode
    const fields = planForm(schema)
    const region = fields.find((f) => f.path === 'region')
    expect(region?.required).toBe(true)
    expect(region?.group).toBe('Advanced')
    expect(region?.advanced).toBe(true)
    expect(region?.showWhen).toEqual({ field: 'mode', is: 'advanced' })
    const mode = fields.find((f) => f.path === 'mode')
    // `required` is read straight off the schema's own `required` array, not
    // recomputed here. Today's callers still convert with the DEFAULT
    // `io: 'output'`, which puts every defaulted field into `required` (F2)
    // — a defect this step does not fix (that is 95.6's `io: 'input'`
    // switch). `planPlannedField` faithfully reports what the schema says,
    // whichever mode produced it.
    expect(mode?.required).toBe(true)
    expect(mode?.advanced).toBe(false)
  })
})

describe('H2 — declaration order survives the DB round trip (plan 95 §0.3, §3.5, §5 step 95.2)', () => {
  function orderedPropertyKeys(zodSchema: z.ZodTypeAny): string[] {
    const json = JSON.parse(JSON.stringify(z.toJSONSchema(zodSchema))) as { properties?: Record<string, unknown> }
    return Object.keys(json.properties ?? {})
  }

  test('DeviceSettingsSchema', () => {
    expect(orderedPropertyKeys(DeviceSettingsSchema)).toEqual(Object.keys(DeviceSettingsSchema.shape))
  })

  test('FarmSettingsSchema', () => {
    expect(orderedPropertyKeys(FarmSettingsSchema)).toEqual(Object.keys(FarmSettingsSchema.shape))
  })

  test("the tiktok pack's auto-scroll params", () => {
    const autoScroll = tiktokPlugin.scripts.find((s) => s.id === 'auto-scroll')
    if (!autoScroll) throw new Error('auto-scroll script not found in the tiktok pack — has it been renamed?')
    const params = autoScroll.params as z.ZodObject<z.ZodRawShape>
    expect(orderedPropertyKeys(params)).toEqual(Object.keys(params.shape))
    // Pinned to the real declaration in `plugins/tiktok-automation-pack/src/index.ts`
    // so a reordering there is caught here too, not just against itself. Grew to five
    // in plan 95 §5 step 95.3 (`commentChance`, `idlePauseSeconds` — H1's side-by-side
    // comparison of a chance slider and an ordered range against the old renderer).
    expect(orderedPropertyKeys(params)).toEqual(['videos', 'maxMinutes', 'keywords', 'commentChance', 'idlePauseSeconds'])
  })
})

describe('sectionFields — grouping, without a parallel document (plan 95 §3.5, §5 step 95.4)', () => {
  /** A minimal `PlannedField` fixture — `sectionFields` only reads `.group`,
   *  never re-plans or re-reads a schema node, so every other property is a
   *  fixed, arbitrary stand-in. */
  function field(path: string, group?: string): PlannedField {
    return { path, label: path, group, advanced: false, required: false, plan: { control: 'toggle' } }
  }

  test('a schema where no field declares group produces exactly one section, heading undefined, holding every field (purely additive)', () => {
    const fields = [field('a'), field('b'), field('c')]
    expect(sectionFields(fields)).toEqual([{ heading: undefined, fields }])
  })

  test('adjacent fields sharing a group form one section; ungrouped fields form their own heading-less run', () => {
    const videos = field('videos', 'Core settings')
    const watch = field('watch', 'Core settings')
    const like = field('like', 'Interaction')
    const save = field('save', 'Interaction')
    const sections = sectionFields([videos, watch, like, save])
    expect(sections).toEqual([
      { heading: 'Core settings', fields: [videos, watch] },
      { heading: 'Interaction', fields: [like, save] },
    ])
  })

  test('ungrouped fields render before the first heading when they are declared first (the common case)', () => {
    const a = field('a')
    const b = field('b')
    const g = field('g', 'Group')
    expect(sectionFields([a, b, g])).toEqual([
      { heading: undefined, fields: [a, b] },
      { heading: 'Group', fields: [g] },
    ])
  })

  test('"A, A, B, A" is three sections, not two — a non-adjacent repeat of a group name is never merged (plan 95 §3.5)', () => {
    const a1 = field('a1', 'A')
    const a2 = field('a2', 'A')
    const b = field('b', 'B')
    const a3 = field('a3', 'A')
    expect(sectionFields([a1, a2, b, a3])).toEqual([
      { heading: 'A', fields: [a1, a2] },
      { heading: 'B', fields: [b] },
      { heading: 'A', fields: [a3] },
    ])
  })

  test('two non-adjacent ungrouped runs are likewise two separate heading-less sections, not merged into one', () => {
    const a = field('a')
    const g = field('g', 'Group')
    const z = field('z')
    const sections = sectionFields([a, g, z])
    expect(sections).toEqual([
      { heading: undefined, fields: [a] },
      { heading: 'Group', fields: [g] },
      { heading: undefined, fields: [z] },
    ])
    expect(sections).toHaveLength(3)
  })

  test('DeviceSettingsSchema\'s own top-level fields section exactly as settings.ts declares them (integration, not a hand-built fixture)', () => {
    const schema = JSON.parse(JSON.stringify(z.toJSONSchema(DeviceSettingsSchema))) as JsonSchemaNode
    const sections = sectionFields(planForm(schema))
    const headings = sections.map((s) => s.heading)
    // Plan 92 §3.5, §4.1 added `video` (its own `group: 'Video'`, declared
    // right after `identity`) — a seventh section, between `Identity` and
    // the trailing ungrouped run. Plan 89 §4.3, step 89.6 added `labelling`
    // right after `instrumentation`, ungrouped at the time (deliberately —
    // Studio's bespoke "Physical labelling" screen was still step 89.8, not
    // that one). Step 89.8 is that step: `labelling` now carries its own
    // `group: 'Physical labelling'`, so it opens an eighth section instead
    // of joining `instrumentation`'s trailing ungrouped run.
    expect(headings).toEqual([
      'Engines',
      'Timing',
      'Power & readiness',
      undefined,
      'Identity',
      'Video',
      undefined,
      'Physical labelling',
    ])
    expect(sections[0]?.fields.map((f) => f.path)).toEqual(['engines', 'input'])
    expect(sections[3]?.fields.map((f) => f.path)).toEqual(['autoReconnect', 'logInputText'])
    expect(sections[5]?.fields.map((f) => f.path)).toEqual(['video'])
    expect(sections[6]?.fields.map((f) => f.path)).toEqual(['instrumentation'])
    expect(sections[7]?.fields.map((f) => f.path)).toEqual(['labelling'])
  })
})
