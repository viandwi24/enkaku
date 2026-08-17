import { describe, expect, test } from 'bun:test'
import { ui } from '@enkaku/protocol'
import { planColumn } from './planColumn'

/**
 * Plan 108 §3.3, §5 step 108.7 — `planColumn` is an ADAPTER, so this file's
 * job is to prove it defines nothing of its own: every structural decision it
 * reports has to be traceable to `planField`, and every string it produces to
 * `formatFieldValue`.
 *
 * Pure by construction: no React import, no `@testing-library`, no DOM — the
 * same discipline `plan.test.ts` and `plan-result.test.ts` keep, and the
 * reason all three survive a Studio restyle.
 */

/** A fixed instant, so a `timestamp` cell's relative text is deterministic. */
const NOW = Date.UTC(2025, 7, 17, 12, 0, 0)
const NOW_SECONDS = Math.floor(NOW / 1000)

describe('planColumn — C1, a column that declares a schema', () => {
  test('a boolean column plans a toggle and renders Yes/No, not "true"', () => {
    expect(planColumn({ type: 'boolean' }, true, NOW)).toEqual({ plan: { control: 'toggle' }, text: 'Yes', raw: false })
    expect(planColumn({ type: 'boolean' }, false, NOW).text).toBe('No')
  })

  test('a declared kind reaches the same formatter a form label uses', () => {
    const cell = planColumn({ type: 'number', ...ui({ title: 'Watched', kind: 'duration', unit: 's' }) }, 2520, NOW)
    expect(cell.raw).toBe(false)
    expect(cell.text).toBe('42 min')
    // The plan came from `planField` — it carries the resolver's own shape,
    // not a shape this file invented.
    expect(cell.plan).toMatchObject({ control: 'number', kind: 'duration', unit: 's' })
  })

  test('an enum column renders its declared label, never the raw member', () => {
    const cell = planColumn({ type: 'string', enum: ['on', 'off'], ...ui({ title: 'State', labels: { on: 'Signed in', off: 'Signed out' } }) }, 'on', NOW)
    expect(cell.plan).toMatchObject({ control: 'choice' })
    expect(cell.text).toBe('Signed in')
  })

  test('a string column is its own text; an empty string reads as an em dash rather than a blank cell', () => {
    expect(planColumn({ type: 'string' }, 'alice', NOW).text).toBe('alice')
    expect(planColumn({ type: 'string' }, '', NOW).text).toBe('—')
  })

  test('a block-shaped plan (object/array) has no one-line rendering and falls to raw JSON', () => {
    const cell = planColumn({ type: 'object', properties: { a: { type: 'number' } } }, { a: 1 }, NOW)
    expect(cell.plan).toMatchObject({ control: 'group' })
    expect(cell.raw).toBe(true)
    expect(cell.text).toBe('{"a":1}')
  })
})

describe('planColumn — C2, a bare column with no schema at all', () => {
  test('a string renders as plain text', () => {
    expect(planColumn(undefined, 'alice', NOW)).toEqual({ plan: null, text: 'alice', raw: false })
  })

  test('a number goes through the SAME formatter, as the "no kind declared" plain member', () => {
    expect(planColumn(undefined, 1500, NOW).text).toBe('1500')
    expect(planColumn(undefined, 12.50000001, NOW).text).toBe('12.5')
  })

  test('a boolean reads the same Yes/No a planned toggle reads — two columns over one fact word it the same', () => {
    expect(planColumn(undefined, true, NOW).text).toBe('Yes')
    expect(planColumn({ type: 'boolean' }, true, NOW).text).toBe('Yes')
  })

  test('no plan is reported at all — "nothing was declared" is a different fact from "planned as the json escape hatch"', () => {
    expect(planColumn(undefined, 'alice', NOW).plan).toBeNull()
    expect(planColumn({}, 'alice', NOW).plan).not.toBeNull()
  })

  test('an object with no schema is still shown, as its raw JSON', () => {
    expect(planColumn(undefined, { a: 1 }, NOW)).toEqual({ plan: null, text: '{"a":1}', raw: true })
  })
})

describe('planColumn — C3, a value that does not match its declared schema', () => {
  test('renders raw rather than disappearing (planResult R3, applied to a cell)', () => {
    const cell = planColumn({ type: 'boolean' }, { ok: true }, NOW)
    expect(cell.raw).toBe(true)
    expect(cell.text).toBe('{"ok":true}')
    // The plan is still reported — the column was declared, the value drifted.
    expect(cell.plan).toEqual({ control: 'toggle' })
  })

  test('a number column holding a string is raw, never blank and never NaN', () => {
    const cell = planColumn({ type: 'number', ...ui({ title: 'Slot', kind: 'count' }) }, 'three', NOW)
    expect(cell.raw).toBe(true)
    expect(cell.text).toBe('"three"')
  })

  test('a string column holding a number is raw', () => {
    expect(planColumn({ type: 'string' }, 7, NOW)).toMatchObject({ raw: true, text: '7' })
  })

  test('an enum column holding a scalar outside the enum shows the scalar — legible, so not C3', () => {
    const cell = planColumn({ type: 'string', enum: ['on', 'off'] }, 'unknown', NOW)
    expect(cell.raw).toBe(false)
    expect(cell.text).toBe('unknown')
  })

  test('an absent value is an em dash under every schema, and is NOT flagged as a mismatch', () => {
    expect(planColumn({ type: 'boolean' }, undefined, NOW)).toMatchObject({ text: '—', raw: false })
    expect(planColumn({ type: 'boolean' }, null, NOW)).toMatchObject({ text: '—', raw: false })
    expect(planColumn(undefined, undefined, NOW)).toEqual({ plan: null, text: '—', raw: false })
  })

  test('a circular value still produces text — total, like every resolver it sits on', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(planColumn({ type: 'string' }, circular, NOW).raw).toBe(true)
  })
})

describe('planColumn — the new `timestamp` kind (plan 108 §4.3, item A)', () => {
  const schema = { type: 'number', ...ui({ title: 'Last synced', kind: 'timestamp' }) }

  test('unix SECONDS render relative to the clock the caller passes', () => {
    expect(planColumn(schema, NOW_SECONDS - 120, NOW).text).toBe('2m ago')
    expect(planColumn(schema, NOW_SECONDS - 2, NOW).text).toBe('just now')
    expect(planColumn(schema, NOW_SECONDS - 90_000, NOW).text).toBe('1d ago')
  })

  test('the kind reaches the plan through `planField`, not through a branch of this file', () => {
    expect(planColumn(schema, NOW_SECONDS, NOW).plan).toMatchObject({ control: 'number', kind: 'timestamp' })
  })

  test('a device that has never synced reads as an em dash, not as 1970', () => {
    expect(planColumn(schema, null, NOW).text).toBe('—')
  })

  test('a non-number under a timestamp column is C3, not a fabricated date', () => {
    expect(planColumn(schema, '2025-08-17', NOW)).toMatchObject({ raw: true })
  })

  test('a timestamp declared on a STRING column does not match row 3 and degrades to plain text', () => {
    // `kindStructurallyValid` refuses a numeric kind on a string node, so the
    // node falls through to `planField`'s own row 8 — a wrong hint never
    // produces a blank cell.
    const cell = planColumn({ type: 'string', ...ui({ title: 'When', kind: 'timestamp' }) }, '2025-08-17', NOW)
    expect(cell.plan).toMatchObject({ control: 'text' })
    expect(cell.text).toBe('2025-08-17')
  })
})
