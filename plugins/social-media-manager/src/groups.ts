import { z } from 'zod'
import { PlatformIdSchema } from './platforms'

/**
 * A GROUP: one upload session an operator can name, start, watch and retry as
 * a whole — "post hari Senin 14 Sep 2026", forty videos, forty phones.
 *
 * ## Why a group is a label and a schedule, not a machine
 *
 * The farm this exists for has ~40 phones and ~40 videos in a folder, and the
 * operator's real question is never "what is post #17 doing" — it is "is
 * Monday's batch out yet, and what still needs a second try". That is an
 * AGGREGATE over rows, and every fact it needs (which phone, which state,
 * which job, which error) is already on the post rows the router writes.
 *
 * So a group stores only what cannot be derived: its title, when it was made,
 * and the pacing the operator chose. Membership is a `groupId` on each post
 * row; progress is counted from those rows; "retry the group" is "re-queue the
 * rows in it that failed". Nothing here duplicates a dispatch record, so a
 * group can never disagree with what the phones actually did — the failure
 * mode a second state machine would have introduced.
 *
 * ## Pacing: why the schedule is baked in at start
 *
 * "Do not let forty phones start at once" is a scheduling problem, and the
 * farm's `job.run` has no notBefore. Rather than hold the jobs somewhere and
 * hope the plugin is alive when their turn comes, each row is stamped with the
 * instant it becomes eligible (`notBeforeAt`). The router simply skips a row
 * whose turn has not come. A restarted plugin, a re-activated version, even a
 * core restart all resume the same schedule, because the schedule is data.
 */

export const GROUP_PREFIX = 'group:'

/** How the videos in a group are spread over the phones. */
export const ASSIGNMENTS = ['one-per-phone', 'every-phone'] as const
export type Assignment = (typeof ASSIGNMENTS)[number]

export const PacingSchema = z.object({
  /**
   * `as-listed` posts the videos in the order they were chosen; `random`
   * shuffles them at start. Shuffling is about the phones not moving in
   * lockstep, and it is drawn ONCE, at start, so the order a run had is the
   * order its rows keep — a retry does not silently re-order what is left.
   */
  order: z.enum(['as-listed', 'random']),
  /** How many of the group's videos may be in flight at once. */
  concurrency: z.number().int().min(1).max(500),
  /** The gap between one video's turn and the next, drawn per step from this range, in seconds. */
  gapSec: z.tuple([z.number().int().min(0).max(86_400), z.number().int().min(0).max(86_400)]),
})
export type Pacing = z.infer<typeof PacingSchema>

export const GroupProgressSchema = z.object({
  total: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  posted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  attention: z.number().int().nonnegative(),
})

export const GroupSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.number().int(),
  platforms: z.array(PlatformIdSchema).min(1),
  assignment: z.enum(ASSIGNMENTS),
  pacing: PacingSchema,
  /** The videos this group was created from, in the order they were chosen. */
  videoArtifactIds: z.array(z.string().min(1)),
  /**
   * How far the batch has got, as of the router's last look.
   *
   * DERIVED from the group's post rows and rewritten by the router, never
   * authoritative: the rows are what the phones actually did. It is stored
   * only because a table renders stored fields — a group row cannot count its
   * members at render time — and it is refreshed every tick, so the worst it
   * can be is one tick stale. `null` until the router has looked once.
   */
  progress: GroupProgressSchema.nullable().default(null),
  /** The same thing in one line, for the column an operator actually reads. */
  summary: z.string().max(200).nullable().default(null),
})
export type Group = z.infer<typeof GroupSchema>

export function groupKeyFor(id: string): string {
  return `${GROUP_PREFIX}${id}`
}

/** `g-<seconds>-<4 chars>` — sortable by eye, unique enough for one farm's operator pressing a button. */
export function newGroupId(now: number, random: () => number = Math.random): string {
  const suffix = Math.floor(random() * 0xffff)
    .toString(16)
    .padStart(4, '0')
  return `g-${now}-${suffix}`
}

/** Fisher-Yates against an injected `random`, so a test gets the same order twice. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

/** One number from `[min, max]` inclusive; a reversed range is read as written rather than refused. */
export function drawGap(gapSec: readonly [number, number], random: () => number): number {
  const lo = Math.min(gapSec[0], gapSec[1])
  const hi = Math.max(gapSec[0], gapSec[1])
  return lo + Math.round(random() * (hi - lo))
}

export interface ScheduledVideo {
  videoArtifactId: string
  /** Unix seconds: the router leaves this row alone until then. */
  notBeforeAt: number
}

/**
 * When each video's turn comes.
 *
 * The first is due immediately — an operator who presses Start expects
 * something to happen — and every later one is one drawn gap after the
 * previous. With the default 30-90s and forty videos that is roughly a video a
 * minute for the best part of an hour, which is the point: forty phones that
 * do not all light up in the same second.
 *
 * `concurrency` is deliberately NOT expressed here. A gap says when a turn
 * comes; concurrency says how many may be in the air at once, and that can
 * only be answered at dispatch time, from what the phones are actually doing.
 */
export function planSchedule(input: {
  videoArtifactIds: readonly string[]
  pacing: Pacing
  startAt: number
  random?: () => number
}): ScheduledVideo[] {
  const random = input.random ?? Math.random
  const ordered = input.pacing.order === 'random' ? shuffled(input.videoArtifactIds, random) : [...input.videoArtifactIds]
  let at = input.startAt
  return ordered.map((videoArtifactId, index) => {
    if (index > 0) at += drawGap(input.pacing.gapSec, random)
    return { videoArtifactId, notBeforeAt: at }
  })
}

/**
 * The per-row cap this assignment implies.
 *
 * `one-per-phone` is the folder-of-forty case: each video goes to ONE phone,
 * and the router's own claim (a phone taken by one post is out of the pool for
 * the rest of that tick) is what spreads forty videos over forty phones
 * without anything here having to pair them up. `every-phone` keeps the older
 * meaning — the same video to every phone carrying the label — and leaves the
 * cap to the farm-wide setting.
 */
export function maxDevicesFor(assignment: Assignment): number | null {
  return assignment === 'one-per-phone' ? 1 : null
}

export type RowState = 'pending' | 'dispatched' | 'succeeded' | 'partial' | 'failed' | 'unsupported'

export interface GroupProgress {
  total: number
  waiting: number
  running: number
  posted: number
  failed: number
  attention: number
}

/**
 * What the operator reads at a glance: how far Monday's batch has got.
 *
 * `attention` is `partial` — some phone posted and some did not — kept apart
 * from `failed` because the two need different actions: one is "try again",
 * the other is "look at it first". `unsupported` counts as attention too; it
 * is a row that can never send until something changes.
 */
export function groupProgress(states: readonly RowState[]): GroupProgress {
  const count = (s: RowState): number => states.filter((x) => x === s).length
  return {
    total: states.length,
    waiting: count('pending'),
    running: count('dispatched'),
    posted: count('succeeded'),
    failed: count('failed'),
    attention: count('partial') + count('unsupported'),
  }
}

/** The one-line summary a group row shows. Says what is left, not just what is done. */
export function groupSummary(title: string, p: GroupProgress): string {
  if (p.total === 0) return `${title}: no videos`
  if (p.posted === p.total) return `${title}: all ${p.total} posted`
  const parts: string[] = []
  if (p.posted > 0) parts.push(`${p.posted} posted`)
  if (p.running > 0) parts.push(`${p.running} running`)
  if (p.waiting > 0) parts.push(`${p.waiting} waiting`)
  if (p.failed > 0) parts.push(`${p.failed} failed`)
  if (p.attention > 0) parts.push(`${p.attention} need a look`)
  return `${title}: ${parts.join(', ')} of ${p.total}`
}

/**
 * The group with this tick's progress written on, or `null` when nothing
 * changed — so a quiet farm does not rewrite forty group rows every fifteen
 * seconds and make the table look permanently busy.
 */
export function withProgress(group: Group, states: readonly RowState[]): Group | null {
  const progress = groupProgress(states)
  const summary = groupSummary(group.title, progress)
  const same =
    group.summary === summary &&
    group.progress !== null &&
    (Object.keys(progress) as (keyof GroupProgress)[]).every((k) => group.progress?.[k] === progress[k])
  return same ? null : { ...group, progress, summary }
}

/**
 * Has this row's turn come?
 *
 * The rule differs by whether the row belongs to a group, and that is the
 * point. A row in a group is created HELD — the operator picks the videos,
 * then presses Start — so a group row with no stamp has not been started and
 * must not send. A row outside a group is the older one-video path and is due
 * the moment it exists, exactly as before groups existed.
 */
export function isRowDue(row: { groupId?: string | null; notBeforeAt?: number | null }, now: number): boolean {
  if (row.groupId === null || row.groupId === undefined) return true
  return row.notBeforeAt !== null && row.notBeforeAt !== undefined && row.notBeforeAt <= now
}

/**
 * How many more of this group may be started right now.
 *
 * Counted from the rows themselves — `dispatched` means jobs of that row are
 * on phones — so a plugin that restarted mid-run resumes with the right
 * number instead of flooding the farm.
 */
export function roomInFlight(states: readonly RowState[], concurrency: number): number {
  return Math.max(0, concurrency - states.filter((s) => s === 'dispatched').length)
}
