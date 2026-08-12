import { readHints } from '@enkaku/protocol'
import type { JsonSchemaNode } from '@/components/schema-form/types'

export interface DeviceSectionDef {
  id: string
  title: string
  keys: string[]
}

/**
 * A section id from its title — lowercased, non-alphanumeric runs collapsed
 * to one hyphen, trimmed. Only used for NAMED groups: "General" always keeps
 * the literal id `general` (below), independent of this function, because
 * nothing may ever rename or misspell the one section K9 promises always
 * exists.
 */
function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section'
}

/**
 * The device Settings tab's sections, derived ENTIRELY from
 * `DeviceSettingsSchema`'s own `x-enkaku.group` (plan 95 §3.5, §5 step 95.4)
 * — the hand-maintained `NAMED_GROUPS` list this replaced is gone. A setting
 * cannot be added to the schema and quietly appear nowhere: a key that
 * carries no `group` lands in "General" (K9, kept exactly), and a key that
 * carries one earns its own section titled after it, in the order that
 * group name is FIRST seen among the schema's top-level keys — which, for an
 * author who declares a group's fields next to each other (the common case,
 * and the one `settings.ts`'s own doc comments call out where it matters),
 * is exactly the schema's own declaration order.
 *
 * Deliberately NOT the same "maximal consecutive run" reduction
 * `plan.ts`'s `sectionFields` uses for an in-page run of controls
 * (plan 95 §3.5's "A, A, B, A is three sections, not two"): THIS list feeds
 * `SectionNav`, a left-hand tab strip where every `id` must be unique and a
 * repeated title would read as two confusingly identical tabs, not as a
 * legible re-reading of declaration order. So every key sharing one `group`
 * value lands in that group's ONE section regardless of whether its
 * declaration happens to be adjacent — a deliberately coarser rule than
 * `sectionFields`'s, for a coarser (page-level, not field-level) surface.
 * Today's schema does not exercise the difference: every named group's keys
 * are already declared back to back.
 */
export function deviceSections(schema: JsonSchemaNode): DeviceSectionDef[] {
  const properties = schema.properties ?? {}
  const keys = Object.keys(properties)

  const general: string[] = []
  const order: string[] = []
  const byGroup = new Map<string, string[]>()

  for (const key of keys) {
    const group = readHints(properties[key] ?? {}).group
    if (!group) {
      general.push(key)
      continue
    }
    if (!byGroup.has(group)) {
      byGroup.set(group, [])
      order.push(group)
    }
    byGroup.get(group)!.push(key)
  }

  return [
    { id: 'general', title: 'General', keys: general },
    ...order.map((title) => ({ id: slugify(title), title, keys: byGroup.get(title)! })),
  ]
}
