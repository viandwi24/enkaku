import { z } from 'zod'
import { PlatformIdSchema, carriesLabel, labelKey, platformById, type PlatformId } from './platforms'

/**
 * Which platform a given phone must NOT post to — the session's skip rules.
 *
 * ## The case this exists for
 *
 * A session is forty videos over forty phones, every video to the same three
 * platforms. But the phones are not interchangeable: #2 has no YouTube channel,
 * #3 was never signed in to TikTok. Before this, the session sent all three to
 * all forty, and the two that could not post failed on the phone — a red row,
 * a wasted run, and a screen that said something went wrong when in fact
 * nothing was ever meant to go there.
 *
 * The obvious answer was already in the product and no longer works: a phone's
 * platform LABEL (`platforms.ts`) is exactly "this phone posts to Instagram",
 * and the router used to route by it. `planDispatch` widened that in 0.11.0 —
 * a phone the operator CHOSE is eligible whether or not it carries the label —
 * because the opposite failure is worse (a whole session silently sending
 * nothing for twenty minutes, the owner's farm, 2026-09-14). Since 0.40.0 the
 * New Session screen always names its phones, so the labels stopped deciding
 * anything at all.
 *
 * So the rule is brought back the other way round, as an EXCLUSION, and
 * materialised on the row where it can be seen and undone:
 *
 * - it is **stated** — a rule by label ("every phone tagged `no-youtube` skips
 *   YouTube"), a rule by device group ("nothing in `batch-b` posts to TikTok"),
 *   or a phone named outright ("#2 skips YouTube");
 * - it is **applied once**, when the session is created, and written onto the
 *   row as a `skipped` platform state rather than consulted at dispatch time;
 * - it is therefore **visible** on the session page and **reversible** with one
 *   press, which a filter inside the router could never be.
 *
 * The three halves are a union, not a precedence: a phone excluded by its
 * group, again by a label and again by hand is excluded once. Only the WORDING
 * has an order, and it is most-specific-wins — the phone named by hand, else
 * the label, else the group — because the sentence has to name the decision the
 * operator would recognise as theirs (`excludedFor`).
 *
 * Why all three rather than the one that covers the others: they are three
 * different facts about a farm, and the operator already keeps them apart on
 * the Devices screen. A GROUP is one per phone and usually says where the phone
 * physically is or which batch it belongs to; a LABEL is many per phone and is
 * how "this one has no YouTube channel" is actually recorded; a phone NAMED by
 * hand is the exception that fits neither and must not force an operator to
 * invent a label for a single evening's session.
 */

export const LabelExcludeSchema = z
  .object({
    /** The label as the operator typed it — kept verbatim so the skip can quote it back. Matched loosely (`labelKey`). */
    label: z.string().min(1).max(60),
    platforms: z.array(PlatformIdSchema).min(1),
  })
  .strict()
export type LabelExclude = z.infer<typeof LabelExcludeSchema>

export const GroupExcludeSchema = z
  .object({
    /**
     * The device group, as its id or as its name.
     *
     * Either, on purpose: a picker sends the id (exact, and survives a rename),
     * while a rule written by hand or by a workflow names the group the way an
     * operator says it. Matching both costs one comparison and removes the one
     * way this rule fails silently.
     */
    group: z.string().min(1).max(80),
    platforms: z.array(PlatformIdSchema).min(1),
  })
  .strict()
export type GroupExclude = z.infer<typeof GroupExcludeSchema>

export const ExcludeRuleSchema = z
  .object({
    /** Phones named outright: device id → the platforms that phone skips. */
    devices: z.record(z.string().min(1), z.array(PlatformIdSchema)).default({}),
    /** Rules by label: any phone carrying `label` skips those platforms. */
    labels: z.array(LabelExcludeSchema).max(50).default([]),
    /** Rules by device group: every phone in the group skips those platforms. Defaulted, so a 0.45.0 rule parses. */
    groups: z.array(GroupExcludeSchema).max(50).default([]),
  })
  .strict()
export type ExcludeRule = z.infer<typeof ExcludeRuleSchema>

/** No skips at all — what every session written before this existed meant, and the default of a new one. */
export const NO_EXCLUDES: ExcludeRule = { devices: {}, labels: [], groups: [] }

/** As much of a phone as a skip rule reads. */
export interface ExcludableDevice {
  id: string
  labels: readonly { name: string }[]
  /** The phone's device group (`DeviceInfo.group`), or null when it is in none. */
  group?: { id: string; name: string } | null
}

/** Is there anything to apply? A rule of two empty halves is skipped entirely rather than walked per row. */
export function isEmptyRule(rule: ExcludeRule): boolean {
  return rule.labels.length === 0 && rule.groups.length === 0 && Object.keys(rule.devices).length === 0
}

/** Does this rule need the fleet read to resolve? Only the two that match on something the phone carries. */
export function needsFleet(rule: ExcludeRule): boolean {
  return rule.labels.length > 0 || rule.groups.length > 0
}

/**
 * The sentence a skipped platform carries, and the reason it is a sentence
 * rather than the word "skipped".
 *
 * Every other state in this plugin says WHO decided it and what undoes it
 * (`platformNote`, `partialNote`), because the operator reading a stalled row
 * an hour later has no other way to tell a decision from a fault. A skip is
 * the one state that is nobody's fault at all, so it has to say so out loud —
 * otherwise it reads as a third kind of failure.
 */
export function skipNoteFor(source: { kind: 'by-hand' } | { kind: 'label'; label: string } | { kind: 'group'; group: string }, platform: PlatformId): string {
  const title = platformById(platform)?.title ?? platform
  const why =
    source.kind === 'label'
      ? `this phone carries the "${source.label}" label`
      : source.kind === 'group'
        ? `this phone is in the "${source.group}" group`
        : 'you chose this phone to skip it when the session was made'
  return `${title} is skipped for this video: ${why}. Nothing is sent, and nothing failed. Press Enable to send it after all.`
}

/** What a skip toggled ON from the session page says. No rule decided it, so it names the press. */
export const SKIPPED_BY_HAND = 'Skipped by hand. Nothing is sent, and nothing failed. Press Enable to send it after all.'

/** Is this phone in the group a rule names? Matched on the group's id, or on its name loosely. */
export function inGroup(device: ExcludableDevice, group: string): boolean {
  const own = device.group
  if (!own) return false
  return own.id === group || labelKey(own.name) === labelKey(group)
}

/**
 * The platforms this phone skips, each with the sentence that says why.
 *
 * Broadest first, so the most specific statement wins the WORDING: a group
 * rule is overwritten by a label rule, and both by the phone named in
 * `devices`. The operator who typed that phone's name is the more specific
 * statement, and quoting a group at them for a skip they set by hand would be
 * a lie about who decided it. Which platforms end up skipped is unaffected by
 * the order — it is a union.
 */
export function excludedFor(device: ExcludableDevice, rule: ExcludeRule): Map<PlatformId, string> {
  const out = new Map<PlatformId, string>()
  for (const entry of rule.groups) {
    if (!inGroup(device, entry.group)) continue
    for (const platform of entry.platforms) out.set(platform, skipNoteFor({ kind: 'group', group: device.group?.name ?? entry.group }, platform))
  }
  for (const entry of rule.labels) {
    if (!carriesLabel(device.labels, entry.label)) continue
    for (const platform of entry.platforms) out.set(platform, skipNoteFor({ kind: 'label', label: entry.label }, platform))
  }
  for (const platform of rule.devices[device.id] ?? []) out.set(platform, skipNoteFor({ kind: 'by-hand' }, platform))
  return out
}

/** The rule in one line, for the router's own log and the member's result. Never stored. */
export function describeRule(rule: ExcludeRule): string {
  const parts: string[] = []
  for (const entry of rule.groups) parts.push(`group "${entry.group}" → ${entry.platforms.join(', ')}`)
  for (const entry of rule.labels) parts.push(`label "${entry.label}" → ${entry.platforms.join(', ')}`)
  const devices = Object.entries(rule.devices).filter(([, platforms]) => platforms.length > 0)
  if (devices.length > 0) parts.push(`${devices.length} phone${devices.length === 1 ? '' : 's'} by hand`)
  return parts.length === 0 ? 'no skips' : parts.join(' · ')
}
