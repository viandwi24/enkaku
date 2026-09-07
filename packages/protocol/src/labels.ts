import { z } from 'zod'

/**
 * A label is a named, coloured thing an operator creates once and then puts
 * on as many devices as they like — the many-to-many counterpart to a group,
 * which is a container and holds a device exactly once (`devices.group_id`).
 * The two answer different questions and neither replaces the other: "which
 * rack is this phone in" is a group, "is this phone on the smoke pool AND
 * running Android 15" is two labels.
 *
 * Labels REPLACE the free-form device tags plan 19 introduced. A tag was a
 * bare string with no life of its own: it existed only while some device
 * carried it, so it could not be created empty, renamed, recoloured, or
 * deleted farm-wide, and a typo silently became a second tag nobody meant.
 * Migration 0080 turns every distinct tag into a label of the same name, so
 * nothing an operator wrote is lost — see `db/schema.ts`'s `labels` comment.
 */

/**
 * Label name normalisation. Deliberately far looser than `normaliseTag` was:
 * a tag was a machine token (`[a-z0-9:._-]`, lowercase-only) because scripts
 * matched on it verbatim, while a label is read by a human on a chip, so
 * `Smoke Pool` and `Android 15` must survive as typed. Only the whitespace is
 * disciplined — outer trimmed, inner runs collapsed to one space — so two
 * labels cannot differ by nothing but spacing.
 */
export function normaliseLabelName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

/**
 * A label name as stored: normalised on write, then bounded. Empty after
 * normalisation is rejected rather than stored as a nameless chip. The 64
 * character ceiling is the one the tags this replaces had, so every tag
 * migration 0080 carries over is still a legal name to rename or recolour.
 */
export const LabelNameSchema = z
  .string()
  .transform(normaliseLabelName)
  .pipe(z.string().min(1, 'a label needs a name').max(64, 'a label name is at most 64 characters'))

/**
 * The palette a label's colour comes from — a closed set, not a free hex
 * string. Two reasons, both learned from the design system (`docs/design.md`):
 * a chip has to stay legible in BOTH themes, which an operator-picked hex
 * cannot promise, and a farm whose labels are drawn from eight tokens reads as
 * one system where one drawn from sixteen million reads as noise. Studio maps
 * each name to a token pair (background + text) in exactly one place.
 */
export const LABEL_COLORS = ['slate', 'blue', 'green', 'amber', 'red', 'purple', 'pink', 'teal'] as const
export const LabelColorSchema = z.enum(LABEL_COLORS)
export type LabelColor = z.infer<typeof LabelColorSchema>

/** What a brand-new label gets when the caller expresses no preference. */
export const DEFAULT_LABEL_COLOR: LabelColor = 'slate'

/**
 * A label as it appears INLINE on a device (`DeviceInfo.labels`) — the id,
 * the name and the colour, and nothing else. Carried on the device row rather
 * than referenced by id for the same reason `DeviceInfo.group` is an object:
 * every list, chip and picker can render it without a second lookup, and a
 * fleet of 200 devices costs one query, not 200.
 */
export const DeviceLabelRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: LabelColorSchema,
})
export type DeviceLabelRef = z.infer<typeof DeviceLabelRefSchema>

/** A label as the labels API returns it: its own identity plus how many devices carry it. */
export const LabelInfoSchema = DeviceLabelRefSchema.extend({
  description: z.string().nullable(),
  /** Unix epoch seconds. */
  createdAt: z.number().int(),
  /** How many devices carry this label right now. */
  deviceCount: z.number().int(),
})
export type LabelInfo = z.infer<typeof LabelInfoSchema>
