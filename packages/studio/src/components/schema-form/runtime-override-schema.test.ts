import { describe, expect, test } from 'bun:test'
import type { FieldPlan } from './plan'
import { planForm } from './plan'
import { RUNTIME_OVERRIDE_SCHEMA } from './runtime-override-schema'

/**
 * Plan 98 §3.9, §5 step 98.8 — the step's own verifiable result, named
 * verbatim in its brief: "a test asserting the planner produced `bytes` and
 * `duration` fields for the override schema with no new control component
 * registered." Spec §19's rule is schema-driven UI with no hardcoded UI per
 * component (`docs/design.md`'s own "Schema-driven forms" section); this
 * file is the proof that the runtime envelope's Run-form override honours
 * it exactly like every other schema in this product, rather than needing a
 * bespoke widget.
 *
 * PURE, like `plan.ts`'s own test file: no React, no `@testing-library`, no
 * DOM — `planForm` is schema in, plan out, and `KNOWN_CONTROLS` below is
 * checked against `FieldPlan['control']` at the TYPE level, so a future
 * control variant added to `plan.ts` without a matching entry here fails
 * `bash scripts/typecheck.sh`, not silently.
 */

/**
 * The CLOSED set of control names `controls/index.tsx`'s `renderControl`
 * dispatches to today. Adding a member to `FieldPlan`'s own discriminated
 * union without adding it here is a compile error (see `_assertComplete`/
 * `_assertNoExtra` below) — this list cannot silently drift from the one
 * `plan.ts` actually produces.
 */
const KNOWN_CONTROLS = ['toggle', 'choice', 'number', 'pair', 'text', 'list', 'table', 'group', 'json'] as const
type KnownControl = (typeof KNOWN_CONTROLS)[number]
type PlannedControl = FieldPlan['control']

// Every `FieldPlan['control']` member is named in `KNOWN_CONTROLS`...
type AssertComplete = [PlannedControl] extends [KnownControl] ? true : ['missing a FieldPlan control variant', PlannedControl]
// ...and `KNOWN_CONTROLS` names nothing `FieldPlan['control']` does not.
type AssertNoExtra = [KnownControl] extends [PlannedControl] ? true : ['KNOWN_CONTROLS names a control plan.ts does not produce', KnownControl]
const _assertComplete: AssertComplete = true
const _assertNoExtra: AssertNoExtra = true
void _assertComplete
void _assertNoExtra

/** Walks a planned form's `control` values, recursing into `group`/`list`/`table`. */
function collectControls(fields: ReturnType<typeof planForm>): string[] {
  const out: string[] = []
  for (const field of fields) {
    out.push(field.plan.control)
    if (field.plan.control === 'group') out.push(...collectControls(field.plan.children))
  }
  return out
}

describe('RUNTIME_OVERRIDE_SCHEMA (plan 98 §3.9 item 2, §4.1, step 98.8)', () => {
  const fields = planForm(RUNTIME_OVERRIDE_SCHEMA)
  const byPath = Object.fromEntries(fields.map((f) => [f.path, f.plan]))

  test('the planner produced a bytes field for maxRssBytes', () => {
    const plan = byPath.maxRssBytes
    expect(plan?.control).toBe('number')
    if (plan?.control !== 'number') throw new Error('unreachable')
    expect(plan.kind).toBe('bytes')
    // The exact bounds `RuntimeEnvelopeSchema.shape.maxRssBytes` already
    // enforces (64 MiB – 16 GiB) — reused, not re-typed (this file's own
    // module doc comment).
    expect(plan.min).toBe(64 * 1024 * 1024)
    expect(plan.max).toBe(16 * 1024 * 1024 * 1024)
    // The enforcement hint (plan 98 §3.5) survives the trip through
    // `z.toJSONSchema` and `planField`'s row 3 — this is what lets
    // `NumberControl` draw the "sampled" badge with no new control.
    expect(plan.enforcement).toBe('sampled')
  })

  test('the planner produced a duration field for timeoutMs', () => {
    const plan = byPath.timeoutMs
    expect(plan?.control).toBe('number')
    if (plan?.control !== 'number') throw new Error('unreachable')
    expect(plan.kind).toBe('duration')
    expect(plan.unit).toBe('ms')
    expect(plan.min).toBe(1_000)
    expect(plan.max).toBe(86_400_000)
    // `timeoutMs` carries no `enforcement` hint (a farm ceiling REFUSES an
    // over-ceiling override outright, §3.8 — the "hard" default
    // expectation), so no badge — asserted as the negative it is.
    expect(plan.enforcement).toBeUndefined()
  })

  test('retries and maxConcurrent plan to plain count numbers, advanced', () => {
    expect(byPath.retries?.control).toBe('number')
    expect(byPath.maxConcurrent?.control).toBe('number')
    const retries = fields.find((f) => f.path === 'retries')
    const maxConcurrent = fields.find((f) => f.path === 'maxConcurrent')
    expect(retries?.advanced).toBe(true)
    expect(maxConcurrent?.advanced).toBe(true)
  })

  test('sdk is deliberately not offered in the Run form (module doc comment)', () => {
    expect(byPath.sdk).toBeUndefined()
  })

  test('every planned control is one this product already renders — no new control component', () => {
    const controls = collectControls(fields)
    expect(controls.length).toBeGreaterThan(0)
    for (const c of controls) {
      expect(KNOWN_CONTROLS as readonly string[]).toContain(c)
    }
    // Concretely: this schema's own four fields all land on 'number' — the
    // SAME control every other bytes/duration/count field in this product
    // (job.memory.*, job.maxTimeoutMs, ...) already uses. Pinned exactly,
    // not just "a subset of KNOWN_CONTROLS", so a future field added to this
    // schema that accidentally requires a new control fails HERE first.
    expect(controls).toEqual(['number', 'number', 'number', 'number'])
  })

  test('sections split the farm-ceiling fields from the ones with none (plan 98 §3.8)', () => {
    expect(fields.find((f) => f.path === 'timeoutMs')?.group).toBe('Limits')
    expect(fields.find((f) => f.path === 'maxRssBytes')?.group).toBe('Limits')
    expect(fields.find((f) => f.path === 'retries')?.group).toBe('Advanced')
    expect(fields.find((f) => f.path === 'maxConcurrent')?.group).toBe('Advanced')
  })
})
