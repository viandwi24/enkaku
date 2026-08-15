import { describe, expect, test } from 'bun:test'
import { DeviceSettingsSchema, toJsonSchema } from '@enkaku/protocol'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { deviceSections } from './deviceSections'

/**
 * The schema-coverage test the plan calls out as the single most valuable
 * one here (plan 46 §3.3, §7, §8; plan 95 §3.5, §5 step 95.4): sections are
 * derived from `DeviceSettingsSchema`'s own `x-enkaku.group` hints, so a
 * future setting cannot be added to the schema and quietly appear nowhere in
 * the UI. This asserts that guarantee directly against the REAL schema, not
 * a fixture — if someone adds a key to `DeviceSettingsSchema` and forgets
 * everything about this plan, this is the test that goes red.
 *
 * Built from `toJsonSchema(DeviceSettingsSchema)` (plan 95 §5 step 95.4) —
 * NOT `.shape` (plan 46's original choice, which avoided a `zod` import
 * here): `deviceSections()` now reads each property's `x-enkaku.group`, and
 * `.shape` carries no JSON Schema metadata at all, only live `ZodType`
 * instances. `SchemaForm.test.tsx` already imports `toJsonSchema` from
 * `@enkaku/protocol` for the same reason (a *test*-time zod dependency, not
 * a production Studio one) — this follows that precedent rather than adding
 * a second way to get a real schema into a test.
 */
function realDeviceSchema(): JsonSchemaNode {
  return toJsonSchema(DeviceSettingsSchema) as JsonSchemaNode
}

describe('deviceSections — schema coverage (plan 46 §3.3, §7; plan 95 §5 step 95.4)', () => {
  test('the union of every section\'s keys equals DeviceSettingsSchema\'s own top-level keys, with none lost and none duplicated', () => {
    const schema = realDeviceSchema()
    const sections = deviceSections(schema)
    const allSectionKeys = sections.flatMap((s) => s.keys)

    expect(new Set(allSectionKeys)).toEqual(new Set(Object.keys(schema.properties ?? {})))
    expect(allSectionKeys.length).toBe(new Set(allSectionKeys).size)
  })

  test('every key appears in exactly one section', () => {
    const schema = realDeviceSchema()
    const sections = deviceSections(schema)
    const seen = new Map<string, string>()
    for (const section of sections) {
      for (const key of section.keys) {
        expect(seen.has(key)).toBe(false)
        seen.set(key, section.id)
      }
    }
  })

  test('the real schema\'s own x-enkaku.group hints produce the known sections (engines/input, timing, power & readiness, identity)', () => {
    const schema = realDeviceSchema()
    const byId = Object.fromEntries(deviceSections(schema).map((s) => [s.id, s.keys]))
    // `engines` and `input` are declared back to back with `group: 'Engines'`
    // (`settings.ts`) — one section, id slugified from the title.
    expect(byId.engines).toEqual(['engines', 'input'])
    expect(byId.timing).toEqual(['timing'])
    // "Power & readiness" -> `power-readiness` (non-alphanumeric runs
    // collapse to one hyphen) — not the old hand-picked `power` id
    // `NAMED_GROUPS` used; that list is gone (plan 95 §5 step 95.4).
    expect(byId['power-readiness']).toEqual(['prep'])
    expect(byId.identity).toEqual(['identity'])
    // `labelling` gained its own `group: 'Physical labelling'` at step 89.8
    // (plan 89 §4.3, §5) — the bespoke screen this section metadata was
    // deliberately deferred for now exists, so it earns its own tab instead
    // of landing in General beside the truly ungrouped keys.
    expect(byId['physical-labelling']).toEqual(['labelling'])
    // Whatever declares no `group` — today autoReconnect, logInputText, and
    // instrumentation (plan 87 §4.12, §5 step 87.13's farm tag) — lands in
    // General rather than being dropped (K9).
    expect(byId.general).toEqual(['autoReconnect', 'logInputText', 'instrumentation'])
  })

  test('a hand-built schema missing a named group\'s key still covers every key it does have (plan 45 not landed yet, §3.3)', () => {
    const schema: JsonSchemaNode = {
      properties: {
        engines: { type: 'object', 'x-enkaku': { group: 'Engines' } },
        autoReconnect: { type: 'boolean' },
        // No `prep`, no `timing`, no top-level `input` — as if only a
        // partial schema were passed in.
      },
    }
    const sections = deviceSections(schema)
    const allSectionKeys = sections.flatMap((s) => s.keys)
    expect(new Set(allSectionKeys)).toEqual(new Set(['engines', 'autoReconnect']))
    const byId = Object.fromEntries(sections.map((s) => [s.id, s.keys]))
    expect(byId['power-readiness']).toBeUndefined()
    expect(byId.timing).toBeUndefined()
    expect(byId.engines).toEqual(['engines'])
    expect(byId.general).toEqual(['autoReconnect'])
  })

  test('a brand-new schema key nobody grouped yet lands in General, not nowhere (K9)', () => {
    const schema: JsonSchemaNode = {
      properties: {
        prep: { type: 'object', 'x-enkaku': { group: 'Power & readiness' } },
        engines: { type: 'object', 'x-enkaku': { group: 'Engines' } },
        input: { type: 'object', 'x-enkaku': { group: 'Engines' } },
        timing: { type: 'object', 'x-enkaku': { group: 'Timing' } },
        autoReconnect: { type: 'boolean' },
        logInputText: { type: 'boolean' },
        readiness: { type: 'object' }, // hypothetical future key, no group at all
      },
    }
    const sections = deviceSections(schema)
    const general = sections.find((s) => s.id === 'general')
    expect(general?.keys).toContain('readiness')
  })

  test('the verifiable result (plan 95 §5 step 95.4): a field added to DeviceSettingsSchema with an EXISTING group\'s name joins that section, with zero changes to deviceSections.ts', () => {
    const schema: JsonSchemaNode = {
      properties: {
        engines: { type: 'object', 'x-enkaku': { group: 'Engines' } },
        input: { type: 'object', 'x-enkaku': { group: 'Engines' } },
        // A hypothetical new field, declared with the SAME group string an
        // author would use in `settings.ts` — nothing in this file (or any
        // other Studio file) needs to change for it to land here.
        capture: { type: 'object', 'x-enkaku': { group: 'Engines' } },
        autoReconnect: { type: 'boolean' },
      },
    }
    const byId = Object.fromEntries(deviceSections(schema).map((s) => [s.id, s.keys]))
    expect(byId.engines).toEqual(['engines', 'input', 'capture'])
    expect(byId.general).toEqual(['autoReconnect'])
  })
})
