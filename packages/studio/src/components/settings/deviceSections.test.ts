import { describe, expect, test } from 'bun:test'
import { DeviceSettingsSchema } from '@enkaku/protocol'
import type { JsonSchemaNode } from '@/components/schema-form/types'
import { deviceSections } from './deviceSections'

/**
 * The schema-coverage test the plan calls out as the single most valuable
 * one here (plan 46 §3.3, §7, §8): sections are derived from
 * `DeviceSettingsSchema`'s own top-level keys, so a future setting cannot be
 * added to the schema and quietly appear nowhere in the UI. This asserts
 * that guarantee directly against the real schema, not a fixture — if
 * someone adds a key to `DeviceSettingsSchema` and forgets everything about
 * this plan, this is the test that goes red.
 *
 * Built from `DeviceSettingsSchema.shape` rather than `z.toJSONSchema(...)`:
 * the Studio package has no runtime dependency on `zod` (the core computes
 * the JSON Schema and ships it over `/api/settings`; Studio only ever
 * consumes the already-generated JSON), and `.shape`'s keys are exactly the
 * JSON Schema's top-level `properties` keys for an object schema like this
 * one — so the coverage guarantee is identical either way.
 */
function realDeviceSchema(): JsonSchemaNode {
  const keys = Object.keys(DeviceSettingsSchema.shape)
  return { properties: Object.fromEntries(keys.map((k) => [k, {}])) }
}

describe('deviceSections — schema coverage (plan 46 §3.3, §7)', () => {
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

  test('the real schema\'s known groups are non-empty today (prep, engines/input, timing, identity)', () => {
    const schema = realDeviceSchema()
    const byId = Object.fromEntries(deviceSections(schema).map((s) => [s.id, s.keys]))
    expect(byId.power).toEqual(['prep'])
    expect(byId.engines).toEqual(['engines', 'input'])
    expect(byId.timing).toEqual(['timing'])
    // Plan 58 §5.7 — its own named group, not General: see `deviceSections.ts`'s doc comment.
    expect(byId.identity).toEqual(['identity'])
    // Whatever is left over — today autoReconnect and logInputText — lands
    // in General rather than being dropped.
    expect(byId.general).toEqual(['autoReconnect', 'logInputText'])
  })

  test('a hand-built schema missing a named group\'s key still covers every key it does have (plan 45 not landed yet, §3.3)', () => {
    const schema: JsonSchemaNode = {
      properties: {
        engines: { type: 'object' },
        autoReconnect: { type: 'boolean' },
        // No `prep`, no `timing`, no top-level `input` — as if only a
        // partial schema were passed in.
      },
    }
    const sections = deviceSections(schema)
    const allSectionKeys = sections.flatMap((s) => s.keys)
    expect(new Set(allSectionKeys)).toEqual(new Set(['engines', 'autoReconnect']))
    const byId = Object.fromEntries(sections.map((s) => [s.id, s.keys]))
    expect(byId.power).toEqual([])
    expect(byId.timing).toEqual([])
    expect(byId.engines).toEqual(['engines'])
    expect(byId.general).toEqual(['autoReconnect'])
  })

  test('a brand-new schema key nobody grouped yet lands in General, not nowhere', () => {
    const schema: JsonSchemaNode = {
      properties: {
        prep: { type: 'object' },
        engines: { type: 'object' },
        input: { type: 'object' },
        timing: { type: 'object' },
        autoReconnect: { type: 'boolean' },
        logInputText: { type: 'boolean' },
        readiness: { type: 'object' }, // hypothetical future key
      },
    }
    const sections = deviceSections(schema)
    const general = sections.find((s) => s.id === 'general')
    expect(general?.keys).toContain('readiness')
  })
})
