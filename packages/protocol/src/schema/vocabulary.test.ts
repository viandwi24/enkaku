import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { JsonSchemaNode } from '../api/json-schema'
import { DURATION_UNITS, ENFORCEMENT_LEVELS, ENKAKU_META_KEY, PARAM_KINDS, PARAM_SOURCES, ParamHintsSchema, readHints, ui } from './vocabulary'

describe('PARAM_KINDS / DURATION_UNITS / PARAM_SOURCES (plan 95 §4.1)', () => {
  test('the kind list is exactly the nine entries §4.1 names — no more, no fewer', () => {
    expect(PARAM_KINDS).toEqual(['count', 'chance', 'duration', 'bytes', 'bitrate', 'pixels', 'temperature', 'text', 'packageName'])
  })

  test('"range" is not a kind — structure states arity, kind states meaning (plan 95 §3.2)', () => {
    expect((PARAM_KINDS as readonly string[]).includes('range')).toBe(false)
  })

  test('no control name ever appears in the kind list', () => {
    for (const forbidden of ['slider', 'stepper', 'dropdown', 'textarea', 'checkbox', 'toggle']) {
      expect((PARAM_KINDS as readonly string[]).includes(forbidden)).toBe(false)
    }
  })

  test('duration units are exactly ms/s/min/h', () => {
    expect(DURATION_UNITS).toEqual(['ms', 's', 'min', 'h'])
  })

  test('the source allowlist has grown to the seven registry/farm sources plus "scripts"', () => {
    expect(PARAM_SOURCES).toEqual([
      'registry.transports',
      'registry.displays',
      'registry.inputs',
      'registry.inspectors',
      'registry.networks',
      'devices',
      'clusters',
      'scripts',
    ])
  })
})

describe('readHints — total: never throws, never propagates junk (plan 95 §5 step 95.1)', () => {
  test('a node with no hints at all returns {}', () => {
    expect(readHints({ type: 'string' })).toEqual({})
  })

  test('a node that is not an object returns {} rather than throwing', () => {
    expect(readHints(null as unknown as JsonSchemaNode)).toEqual({})
    expect(readHints(undefined as unknown as JsonSchemaNode)).toEqual({})
    expect(readHints('not an object' as unknown as JsonSchemaNode)).toEqual({})
    expect(readHints(42 as unknown as JsonSchemaNode)).toEqual({})
  })

  test(`a "${ENKAKU_META_KEY}" that is not an object (a string, a number, an array) returns {}`, () => {
    expect(readHints({ [ENKAKU_META_KEY]: 'chance' })).toEqual({})
    expect(readHints({ [ENKAKU_META_KEY]: 5 })).toEqual({})
    expect(readHints({ [ENKAKU_META_KEY]: [] })).toEqual({})
  })

  test('a kind that does not exist yet (a schema published by a newer core) returns {} rather than the unknown value', () => {
    expect(readHints({ [ENKAKU_META_KEY]: { kind: 'percentage' } })).toEqual({})
  })

  test('a source that does not exist yet returns {}', () => {
    expect(readHints({ [ENKAKU_META_KEY]: { source: 'registry.somethingNew' } })).toEqual({})
  })

  test("kind: 'duration' with no unit is malformed and returns {}", () => {
    expect(readHints({ [ENKAKU_META_KEY]: { kind: 'duration' } })).toEqual({})
  })

  test("unit on a non-duration kind is malformed and returns {}", () => {
    expect(readHints({ [ENKAKU_META_KEY]: { kind: 'count', unit: 'ms' } })).toEqual({})
  })

  test('a well-formed hints object is read through intact', () => {
    expect(readHints({ [ENKAKU_META_KEY]: { kind: 'chance', group: 'Interaction' } })).toEqual({ kind: 'chance', group: 'Interaction' })
    expect(readHints({ [ENKAKU_META_KEY]: { kind: 'duration', unit: 's' } })).toEqual({ kind: 'duration', unit: 's' })
  })

  test('unknown keys inside x-enkaku are stripped, not rejected — forward compatible with a newer vocabulary', () => {
    expect(readHints({ [ENKAKU_META_KEY]: { kind: 'chance', someFutureKey: 'x' } })).toEqual({ kind: 'chance' })
  })

  test('showWhen is read through in both its "is" and "in" forms', () => {
    expect(readHints({ [ENKAKU_META_KEY]: { showWhen: { field: 'mode', is: 'advanced' } } })).toEqual({
      showWhen: { field: 'mode', is: 'advanced' },
    })
    expect(readHints({ [ENKAKU_META_KEY]: { showWhen: { field: 'mode', in: ['advanced', 'expert'] } } })).toEqual({
      showWhen: { field: 'mode', in: ['advanced', 'expert'] },
    })
  })

  test('a malformed showWhen (neither "is" nor "in") makes the whole hints object malformed, returning {}', () => {
    expect(readHints({ [ENKAKU_META_KEY]: { showWhen: { field: 'mode' } } })).toEqual({})
  })

  test('labels must be string-to-string; a non-string value makes the hints object malformed', () => {
    expect(readHints({ [ENKAKU_META_KEY]: { labels: { on: 'On', off: 'Off' } } })).toEqual({ labels: { on: 'On', off: 'Off' } })
    expect(readHints({ [ENKAKU_META_KEY]: { labels: { on: 1 } } })).toEqual({})
  })
})

describe('ParamHintsSchema — the same schema readHints and checkDeclaredSchema share (plan 95 §4.1)', () => {
  test('an empty object is valid — every hint is optional', () => {
    expect(ParamHintsSchema.safeParse({}).success).toBe(true)
  })

  test("kind: 'duration' requires unit", () => {
    expect(ParamHintsSchema.safeParse({ kind: 'duration' }).success).toBe(false)
    expect(ParamHintsSchema.safeParse({ kind: 'duration', unit: 'ms' }).success).toBe(true)
  })

  test('unit is rejected on every non-duration kind', () => {
    for (const kind of ['count', 'chance', 'bytes', 'bitrate', 'pixels', 'temperature', 'text', 'packageName'] as const) {
      expect(ParamHintsSchema.safeParse({ kind, unit: 'ms' }).success).toBe(false)
    }
  })

  test('unit with no kind at all is also rejected — unit is duration-only, never ambient', () => {
    expect(ParamHintsSchema.safeParse({ unit: 'ms' }).success).toBe(false)
  })
})

describe('ParamHintsSchema — enforcement (plan 98 §3.5, §4.3)', () => {
  test('the enforcement list is exactly the three levels plan 98 names', () => {
    expect(ENFORCEMENT_LEVELS).toEqual(['hard', 'sampled', 'advisory'])
  })

  test('each of the three enforcement levels is accepted', () => {
    for (const enforcement of ENFORCEMENT_LEVELS) {
      expect(ParamHintsSchema.safeParse({ enforcement }).success).toBe(true)
    }
  })

  test('an enforcement level from a newer vocabulary is rejected by the schema, and stripped (never thrown) by readHints', () => {
    expect(ParamHintsSchema.safeParse({ enforcement: 'best-effort' }).success).toBe(false)
    expect(readHints({ [ENKAKU_META_KEY]: { enforcement: 'best-effort' } })).toEqual({})
  })

  test('enforcement rides alongside kind, group and every other hint, and round-trips through readHints', () => {
    const hints = { kind: 'bytes', group: 'Memory', enforcement: 'sampled' } as const
    expect(ParamHintsSchema.safeParse(hints).success).toBe(true)
    expect(readHints({ [ENKAKU_META_KEY]: hints })).toEqual(hints)
  })

  test('ui() carries enforcement through into x-enkaku', () => {
    expect(ui({ title: 'Maximum job memory limit', kind: 'bytes', group: 'Memory', enforcement: 'sampled' })).toEqual({
      title: 'Maximum job memory limit',
      [ENKAKU_META_KEY]: { kind: 'bytes', group: 'Memory', enforcement: 'sampled' },
    })
  })

  test('unknown keys are still stripped, not rejected, alongside a known enforcement value — S3 forward compatibility (plan 98 §3.3) holds for this hint too', () => {
    expect(readHints({ [ENKAKU_META_KEY]: { enforcement: 'hard', someFutureKey: 'x' } })).toEqual({ enforcement: 'hard' })
  })
})

describe('summary — the one key plan 97 §3.6 adds, and only that key', () => {
  test('a result field marked summary: true reads through intact', () => {
    expect(readHints({ [ENKAKU_META_KEY]: { kind: 'count', summary: true } })).toEqual({ kind: 'count', summary: true })
  })

  test('summary: false reads through intact too — the flag is a real boolean, not "present means true"', () => {
    expect(readHints({ [ENKAKU_META_KEY]: { summary: false } })).toEqual({ summary: false })
  })

  test('a non-boolean summary makes the whole hints object malformed, returning {} (same discipline as every other hint)', () => {
    expect(readHints({ [ENKAKU_META_KEY]: { summary: 'yes' } })).toEqual({})
  })

  test('summary rides through ui() alongside kind, exactly like every other hint', () => {
    expect(ui({ title: 'Videos watched', kind: 'count', summary: true })).toEqual({
      title: 'Videos watched',
      [ENKAKU_META_KEY]: { kind: 'count', summary: true },
    })
  })
})

describe('ui() — runtime shape (plan 95 §4.1)', () => {
  test('produces { title, x-enkaku } with no description when none is given', () => {
    expect(ui({ title: 'Number of videos', kind: 'count' })).toEqual({
      title: 'Number of videos',
      [ENKAKU_META_KEY]: { kind: 'count' },
    })
  })

  test('carries description through when given', () => {
    expect(ui({ title: 'Save chance', description: 'Chance the video is saved.', kind: 'chance' })).toEqual({
      title: 'Save chance',
      description: 'Chance the video is saved.',
      [ENKAKU_META_KEY]: { kind: 'chance' },
    })
  })

  test('a duration kind carries its unit inside x-enkaku', () => {
    expect(ui({ title: 'Watch time', kind: 'duration', unit: 's' })).toEqual({
      title: 'Watch time',
      [ENKAKU_META_KEY]: { kind: 'duration', unit: 's' },
    })
  })

  test('every other hint (group, advanced, source, labels, showWhen, ordered, multiline) rides along under x-enkaku', () => {
    expect(
      ui({
        title: 'Mode',
        kind: 'text',
        group: 'Core settings',
        advanced: true,
        source: 'devices',
        labels: { a: 'A' },
        showWhen: { field: 'enabled', is: true },
      }),
    ).toEqual({
      title: 'Mode',
      [ENKAKU_META_KEY]: {
        kind: 'text',
        group: 'Core settings',
        advanced: true,
        source: 'devices',
        labels: { a: 'A' },
        showWhen: { field: 'enabled', is: true },
      },
    })
  })

  test('the output round-trips through readHints', () => {
    const meta = ui({ title: 'Save chance', kind: 'chance', group: 'Interaction' })
    expect(readHints(meta as JsonSchemaNode)).toEqual({ kind: 'chance', group: 'Interaction' })
  })

  test('the output survives a real z.toJSONSchema() round trip and is still readable by readHints', () => {
    const schema = z.object({
      saveChance: z.number().min(0).max(1).default(0).meta(ui({ title: 'Save chance', kind: 'chance' })),
    })
    const json = z.toJSONSchema(schema) as unknown as { properties: { saveChance: JsonSchemaNode } }
    expect(readHints(json.properties.saveChance)).toEqual({ kind: 'chance' })
  })
})

describe('ui() — compile-time failures (plan 95 §5 step 95.1 verifiable result)', () => {
  // These three lean on `@ts-expect-error`: `bash scripts/typecheck.sh` runs
  // real `tsc --noEmit` over this file, and `@ts-expect-error` itself is a
  // compile error when the following line does NOT already fail to compile
  // — so a regression that made one of these three combinations legal again
  // would fail typecheck here, not silently pass. `bun test` cannot see this
  // (Bun strips types without checking them), which is why the `ui()` calls
  // below are otherwise inert.

  test("kind: 'duration' with no unit does not compile", () => {
    // @ts-expect-error — duration requires a unit; see the two ui() overloads.
    ui({ title: 'Watch time', kind: 'duration' })
    expect(true).toBe(true)
  })

  test('a unit on a non-duration kind does not compile', () => {
    // @ts-expect-error — unit is only valid for kind: 'duration'.
    ui({ title: 'Number of videos', kind: 'count', unit: 'ms' })
    expect(true).toBe(true)
  })

  test('a misspelled kind does not compile', () => {
    // @ts-expect-error — "coutn" is not a member of PARAM_KINDS.
    ui({ title: 'Number of videos', kind: 'coutn' })
    expect(true).toBe(true)
  })
})
