import { z } from 'zod'
import { carriesLabel, labelKey } from './platforms'

/**
 * Which phones a warm-up session covers.
 *
 * ## Why this is not just "the phones carrying label X"
 *
 * That is what `add-warmup` shipped with, and it answers exactly one of the
 * four questions an operator actually has. The owner listed the rest
 * (2026-09-20): *"bisa aja suatu hari inginnya devices tertentu aja, atau
 * inginya semau device kecuali beberapa device, atau kecuali beberapa
 * labels/grup atau misalnya ingin hanya grup / lebels tertentu aja"* — these
 * phones; every phone but these; every phone but these labels or groups; only
 * this label or group.
 *
 * All four are the same sentence with two halves, so that is how it is stored:
 * a **start** (`mode` plus the names it needs) and a set of **exceptions** that
 * apply whatever the start was. "Every phone except #7" is `mode: 'all'` with
 * `exceptDeviceIds: ['#7']`; "only the `warm-b` group, but not the ones tagged
 * `banned`" is `mode: 'groups'` with `exceptLabels: ['banned']`. No mode is
 * special-cased, and adding "every phone in group A except label B" costs
 * nothing because it was never a separate shape.
 *
 * ## Why an exception always wins
 *
 * An exception is the narrower, later statement — the operator naming what
 * they know about a specific phone, over a rule they wrote about a fleet. So a
 * phone named in BOTH `deviceIds` and `exceptDeviceIds` is out, and the answer
 * says which rule removed it. A resolver that let the include win would make
 * "everything in this group except that one" impossible to express, which is
 * the single most common thing an operator wants.
 *
 * ## Why every rejection carries a sentence
 *
 * The question a warm-up screen gets asked is never "how many phones" — it is
 * *"why isn't THAT phone in it"*. A resolver that returns only the survivors
 * cannot answer it, and the operator goes and re-reads their labels. So the
 * left-out phones come back too, each with the rule that removed it, and the
 * session's rows carry the sentence.
 */

export const WARMUP_TARGET_MODES = ['all', 'labels', 'groups', 'devices'] as const
export type WarmupTargetMode = (typeof WARMUP_TARGET_MODES)[number]

const names = (max: number) => z.array(z.string().min(1).max(120)).max(max).default([])

export const WarmupTargetSchema = z
  .object({
    /** Where the list starts, before any exception is applied. */
    mode: z.enum(WARMUP_TARGET_MODES).default('all'),
    /** Phones carrying ANY of these labels — `mode: 'labels'`. Any, not all: a fleet is labelled by platform, and a phone is rarely on two. */
    labels: names(20),
    /** Device groups, by id or by name — `mode: 'groups'`. */
    groups: names(20),
    /** Exact device ids — `mode: 'devices'`. */
    deviceIds: names(500),
    /** Applied whatever the mode was. An exception is the narrower statement and always wins. */
    exceptLabels: names(20),
    exceptGroups: names(20),
    exceptDeviceIds: names(500),
    /**
     * Leave out every phone that is not connected right now.
     *
     * A FLAG rather than a fifth `mode`, because "which phones" and "only the
     * connected ones" are two different questions and an operator asks them
     * both: *"ada 73 devices terdaftar tapi ini yang terkoneksi cuman 20, nah
     * saya mau warm up cuman 20 ini doang"* (owner, 2026-09-21) — and just as
     * often they will want the connected phones OF a label. A mode could only
     * say one or the other.
     *
     * Resolved at each RUN, not stored as a list of ids. A session is a
     * definition that gets started again, so "the phones connected now" has to
     * mean now each time — tonight's twenty, not this morning's.
     */
    onlineOnly: z.boolean().default(false),
  })
  /* `prefault`, not `default`: the value given here is INPUT, so every field's own default still fills in. */
  .prefault({})
export type WarmupTarget = z.infer<typeof WarmupTargetSchema>

export const EVERY_PHONE: WarmupTarget = WarmupTargetSchema.parse({})

/** What the resolver needs of a phone — the subset `device.list` already returns. */
export interface TargetableDevice {
  id: string
  label?: string
  labels: readonly { name: string }[]
  group?: { id: string; name: string } | null
  /** The farm's own word for the connection. Only `'online'` counts as connected. */
  status?: string
}

export interface TargetVerdict<D> {
  device: D
  /** The rule that removed it, as a sentence for the row. */
  reason: string
}

export interface TargetResolution<D> {
  chosen: D[]
  left: TargetVerdict<D>[]
}

/**
 * The id the Studio picker uses for "the phones in no group at all".
 *
 * It has to be understood HERE and not only there, because the picker's choice
 * is stored on the session and resolved again every time a schedule fires. A
 * farm group id is a farm-issued id and never this literal
 * (`ui/parts/device-picker.tsx`'s `NO_GROUP`, kept in step).
 */
export const NO_GROUP = '__ungrouped__'

/** Is this phone in the named group? By id or by name, the same two ways `excludes.ts` matches one. */
function inGroup(device: TargetableDevice, group: string): boolean {
  const own = device.group
  if (group === NO_GROUP) return !own
  if (!own) return false
  return own.id === group || labelKey(own.name) === labelKey(group)
}

const list = (values: readonly string[]): string => values.map((value) => `"${value}"`).join(', ')

/**
 * Split a fleet into the phones this session covers and the phones it does not.
 *
 * Order is load-bearing: the START decides who is in the running, then the
 * EXCEPTIONS remove from it. Both halves are reported, so a phone that was
 * never in the running and a phone that was explicitly pulled out say different
 * things — they are different mistakes to have made.
 */
export function resolveWarmupTarget<D extends TargetableDevice>(devices: readonly D[], target: WarmupTarget): TargetResolution<D> {
  const chosen: D[] = []
  const left: TargetVerdict<D>[] = []

  for (const device of devices) {
    const included = ((): string | null => {
      switch (target.mode) {
        case 'labels':
          if (target.labels.length === 0) return 'this session names no label, so it reaches no phone'
          return target.labels.some((label) => carriesLabel(device.labels, label)) ? null : `carries none of this session's labels (${list(target.labels)})`
        case 'groups':
          if (target.groups.length === 0) return 'this session names no device group, so it reaches no phone'
          return target.groups.some((group) => inGroup(device, group)) ? null : `is not in any of this session's device groups (${list(target.groups)})`
        case 'devices':
          return target.deviceIds.includes(device.id) ? null : 'is not one of the phones this session names'
        default:
          return null
      }
    })()
    if (included !== null) {
      left.push({ device, reason: included })
      continue
    }

    // An exception is the narrower, later statement, so it wins over the start
    // even when the start named this very phone.
    const excludedLabel = target.exceptLabels.find((label) => carriesLabel(device.labels, label))
    const excludedGroup = target.exceptGroups.find((group) => inGroup(device, group))
    /*
      Connection last, after every other exception. A phone that was never in
      the running should say so rather than "was not connected" — those are
      different mistakes, and the whole point of reporting both halves is that
      a row says which one happened.
    */
    if (target.exceptDeviceIds.includes(device.id)) left.push({ device, reason: 'was left out of this session by name' })
    else if (excludedLabel !== undefined) left.push({ device, reason: `carries the excluded label "${excludedLabel}"` })
    else if (excludedGroup !== undefined) left.push({ device, reason: `is in the excluded device group "${excludedGroup}"` })
    else if (target.onlineOnly && device.status !== undefined && device.status !== 'online') left.push({ device, reason: 'was not connected when this run started' })
    else chosen.push(device)
  }

  return { chosen, left }
}

/** Does this target reach nothing at all, by construction rather than by accident of the fleet? */
export function reachesNothing(target: WarmupTarget): boolean {
  if (target.mode === 'labels') return target.labels.length === 0
  if (target.mode === 'groups') return target.groups.length === 0
  if (target.mode === 'devices') return target.deviceIds.length === 0
  return false
}

/** One line for the session row: what this target says, in the operator's own terms. */
export function describeTarget(target: WarmupTarget): string {
  const start =
    target.mode === 'all'
      ? 'Every phone'
      : target.mode === 'labels'
        ? target.labels.length === 0
          ? 'No label chosen'
          : `Phones labelled ${list(target.labels)}`
        : target.mode === 'groups'
          ? target.groups.length === 0
            ? 'No device group chosen'
            : `Phones in ${list(target.groups)}`
          : `${target.deviceIds.length} ${target.deviceIds.length === 1 ? 'phone' : 'phones'} chosen by hand`

  const except: string[] = []
  if (target.exceptDeviceIds.length > 0) except.push(`${target.exceptDeviceIds.length} named ${target.exceptDeviceIds.length === 1 ? 'phone' : 'phones'}`)
  if (target.exceptLabels.length > 0) except.push(`anything labelled ${list(target.exceptLabels)}`)
  if (target.exceptGroups.length > 0) except.push(`anything in ${list(target.exceptGroups)}`)
  const scoped = except.length === 0 ? start : `${start}, except ${except.join(' and ')}`
  return target.onlineOnly ? `${scoped} — connected phones only` : scoped
}
