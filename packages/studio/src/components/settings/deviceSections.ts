import type { JsonSchemaNode } from '@/components/schema-form/types'

export interface DeviceSectionDef {
  id: string
  title: string
  keys: string[]
}

/**
 * Named groups of `DeviceSettingsSchema`'s top-level keys (plan 46 §3.3).
 * This is the ONLY hand-maintained part of the grouping — everything else
 * about which keys exist comes from the schema itself at call time, via
 * `deviceSections()` below. Order here is deliberate: most-changed first,
 * since that is what an operator opens Settings for.
 */
const NAMED_GROUPS: readonly { id: string; title: string; keys: readonly string[] }[] = [
  { id: 'power', title: 'Power & readiness', keys: ['prep'] },
  { id: 'engines', title: 'Engines', keys: ['engines', 'input'] },
  { id: 'timing', title: 'Timing', keys: ['timing'] },
  // Plan 58 §4.1, §5.7 — named on its own rather than falling into General: `identity` is a
  // nested object (timezone/locale/gps), not a flat toggle like `autoReconnect`, and the device
  // page also has a dedicated Identity tab (`IdentityPanel.tsx`) for it — this keeps the
  // schema-driven Settings tab's fallback copy in one clearly-labelled place instead of dumping a
  // nested object next to unrelated booleans.
  { id: 'identity', title: 'Identity', keys: ['identity'] },
]

/**
 * The device Settings tab's sections, derived from the schema's own
 * top-level keys rather than a hand-maintained list (plan 46 §3.3): a
 * setting cannot be added to `DeviceSettingsSchema` and quietly appear
 * nowhere, because "General" is whatever is left after the named groups
 * above claim their keys — so a brand-new key lands there automatically.
 * A named group's keys are filtered to whatever the schema actually has,
 * so an as-yet-unlanded plan (e.g. readiness before plan 45) simply leaves
 * that section with fewer fields rather than a broken reference.
 */
export function deviceSections(schema: JsonSchemaNode): DeviceSectionDef[] {
  const allKeys = Object.keys(schema.properties ?? {})
  const claimed = new Set(NAMED_GROUPS.flatMap((g) => g.keys))
  const general = allKeys.filter((k) => !claimed.has(k))
  return [
    { id: 'general', title: 'General', keys: general },
    ...NAMED_GROUPS.map((g) => ({ id: g.id, title: g.title, keys: g.keys.filter((k) => allKeys.includes(k)) })),
  ]
}
