import { describe, expect, test } from 'bun:test'
import { FarmSettingsSchema, toJsonSchema } from '@enkaku/protocol'
import { FARM_SECTION_DEFS } from './farmSections'

/**
 * Plan 96 item 96.4's actual fix: not the seven (really eight — `readiness`
 * turned up while fixing the other seven) missing entries themselves, but
 * this test, which is what keeps a NINTH from going missing the same way.
 * `FARM_SECTION_DEFS` stays hand-maintained on purpose (plan 95 §3.5's
 * screen-vs-schema distinction, restated in `farmSections.ts`'s own doc
 * comment) — so unlike `deviceSections.test.ts`, this cannot assert the
 * section list matches the schema BY CONSTRUCTION. It asserts the same
 * outcome directly instead: every real `FarmSettingsSchema` top-level key
 * is claimed by exactly one section's `keys`. A key added to the schema
 * with no matching entry here — the exact defect this item fixes — turns
 * this test red the moment it happens, not whenever someone next happens to
 * look at the Settings page.
 */
function realFarmSchemaKeys(): Set<string> {
  const schema = toJsonSchema(FarmSettingsSchema) as { properties?: Record<string, unknown> }
  return new Set(Object.keys(schema.properties ?? {}))
}

describe('FARM_SECTION_DEFS — schema coverage (plan 96 item 96.4)', () => {
  test('every top-level FarmSettingsSchema key is claimed by exactly one section', () => {
    const schemaKeys = realFarmSchemaKeys()
    const claimedBy = new Map<string, string>()

    for (const section of FARM_SECTION_DEFS) {
      for (const key of section.keys) {
        expect(claimedBy.has(key)).toBe(false)
        claimedBy.set(key, section.id)
      }
    }

    expect(new Set(claimedBy.keys())).toEqual(schemaKeys)
  })

  test('every section id is unique — SectionNav keys its tabs by id', () => {
    const ids = FARM_SECTION_DEFS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('sections sharing a group are declared consecutively — SectionNav renders one heading per RUN, not per group', () => {
    const seenGroups = new Set<string>()
    let lastGroup: string | null = null
    for (const section of FARM_SECTION_DEFS) {
      if (section.group !== lastGroup) {
        expect(seenGroups.has(section.group)).toBe(false)
        seenGroups.add(section.group)
        lastGroup = section.group
      }
    }
  })

  test('the eight previously-unreachable blocks are each claimed (plan 96 item 96.4)', () => {
    const claimedKeys = new Set(FARM_SECTION_DEFS.flatMap((s) => s.keys))
    for (const key of ['discovery', 'monitor', 'shell', 'transfer', 'network', 'workspace', 'kv', 'readiness']) {
      expect(claimedKeys.has(key)).toBe(true)
    }
  })
})
