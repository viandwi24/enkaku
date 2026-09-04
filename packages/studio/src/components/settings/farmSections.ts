import { readHints } from '@enkaku/protocol'
import type { JsonSchemaNode } from '@/components/schema-form/types'

export interface FarmSectionDef {
  id: string
  title: string
  /** The heading `SectionNav` renders above a run of consecutive entries sharing it. Empty means no heading. */
  group: string
  /** Top-level `FarmSettingsSchema` keys this section's `FarmForm` renders. Empty for the one bespoke screen. */
  keys: string[]
}

/**
 * The Settings sections (MVP 12 §1 as amended by MVP 15 §1, plan 212 §4.5).
 * All but one come from `FarmSettingsSchema`'s own top-level keys, in
 * declaration order, minus `HIDDEN_SECTIONS` below, each titled and grouped by its own `title`/
 * `x-enkaku.group` — this file is now a 40-line derivation, the same shape
 * `deviceSections.ts` already has, not a hand-maintained parallel list: the
 * old list's own doc comment argued for keeping it hand-maintained because
 * half its entries were bespoke screens against a different API; after
 * plan 212 exactly one is (Access), so that argument no longer holds. The
 * tenth, Access (users, API tokens, the audit log), is a table against
 * `/api/auth/*`, not a settings row, and is spliced in before Advanced.
 */
/**
 * `networkScan` is a settings key with no Settings section (owner,
 * 2026-09-04): the network list moved to the Devices page's own Scan
 * networks dialog, where an operator standing at a rack actually reaches for
 * it, and Settings should not carry a second door to the same array. The
 * SETTING is untouched — `FarmSettingsSchema.networkScan` is still the
 * sweep's only address space, still saved through `PATCH /api/settings`;
 * only this page's nav entry is gone. Hidden here rather than dropped from
 * the schema on purpose: the schema key is what `registry/sweep.ts` reads,
 * and a settings-page decision must not be able to delete a farm's networks.
 */
const HIDDEN_SECTIONS = new Set(['networkScan'])

export function farmSections(schema: JsonSchemaNode): FarmSectionDef[] {
  const properties = schema.properties ?? {}
  const derived: FarmSectionDef[] = Object.keys(properties)
    .filter((key) => !HIDDEN_SECTIONS.has(key))
    .map((key) => {
      const node = properties[key] ?? {}
      return { id: key, title: typeof node.title === 'string' ? node.title : key, group: readHints(node).group ?? '', keys: [key] }
    })
  const advancedAt = derived.findIndex((s) => s.id === 'advanced')
  const access: FarmSectionDef = { id: 'access', title: 'Access', group: 'Farm', keys: [] }
  return advancedAt === -1 ? [...derived, access] : [...derived.slice(0, advancedAt), access, ...derived.slice(advancedAt)]
}
