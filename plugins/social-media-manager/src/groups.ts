import { z } from 'zod'
import { ExcludeRuleSchema, NO_EXCLUDES } from './excludes'
import { HashtagRuleSchema, NO_HASHTAG_RULE } from './hashtags'
import { PlatformIdSchema } from './platforms'
import { WarmupTargetSchema } from './warmup-target'

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
  /** Platforms an operator turned off for a phone (0.45.0). Defaulted, so a progress row written before it parses as none. */
  skipped: z.number().int().nonnegative().default(0),
})

/**
 * What KIND of session this is (plan 900 D4).
 *
 * A session used to be one thing, so nothing said which. Now there are two and
 * an operator must never have to work out which one they are looking at —
 * `videoArtifactIds` being empty is not an answer a person should have to
 * infer.
 */
export const SESSION_KINDS = ['post', 'warmup'] as const
export type SessionKind = (typeof SESSION_KINDS)[number]

/**
 * A warm-up session's settings — everything an operator tunes without a
 * release (plan 900 D1, D6).
 *
 * The rotation's STRUCTURE is plugin code now, not a graph: which platform a
 * phone gets, which style it draws, what order its activities run in. What
 * stayed configurable is what was actually being configured — the ten numbers
 * and lists below, which `warmup-rotation`'s own params exposed and which are
 * the only part of that workflow anybody ever edited.
 *
 * Defaulted field by field on purpose. These rows are read with
 * `safeParse` and a row that fails is SKIPPED ENTIRELY (`index.ts`'s group
 * reader), so a field added later without a default would make every session
 * stored before it vanish from the operator's screen rather than fail loudly.
 * That is the same reason `hashtags`, `excludes` and `progress.skipped` carry
 * defaults, and it is the rule for anything added here later.
 */
export const WarmupSettingsSchema = z.object({
  /**
   * The niche. Searched as queries, and used to hold attention on matching
   * content. One to ten, because a list of one is a valid choice and a list of
   * fifty is a phone that never repeats itself, which is its own tell.
   */
  keywords: z.array(z.string().min(1).max(60)).min(1).max(10),
  /** Scales how many videos, reels and scrolls, and how long to watch. 0.5 is a short session, 2 a long one. */
  amount: z.number().min(0.2).max(3).default(1),
  /** The gap between one activity and the next, drawn per step from this range, in seconds. */
  gapSec: z.tuple([z.number().int().min(0).max(3_600), z.number().int().min(0).max(3_600)]).default([8, 20]),
  /**
   * A random per-phone wait before the first activity (plan 900 D6.1).
   *
   * This is not politeness, it is the point: eighty phones that start the same
   * second are eighty phones visibly doing the same thing, which is the shape
   * a platform looks for.
   */
  startJitterSec: z.number().int().min(0).max(1_800).default(120),
  /**
   * How many activities each phone does, per platform (0.57.0).
   *
   * The style decides WHAT a phone does; this decides how much. Before it, a
   * phone did however many steps its drawn style happened to have — three or
   * four, invisible to the operator and not a number they could choose. The
   * owner asks in activities (*"1 device itu melakukan 4 aktifitas"*), so that
   * is the knob. `pickActivities` tops up from the platform's other styles
   * when a style is shorter than the number asked for, never repeating one.
   */
  activitiesPerPhone: z.number().int().min(1).max(12).default(4),
  /**
   * Shifts the platform rotation (plan 900 D6.2).
   *
   * No longer an operator setting (0.57.0): `add-warmup` derives it from how
   * many warm-up sessions the farm already made today, so a second session on
   * one day rotates the platforms on its own. The owner's instruction was
   * exactly that — *"ga perlu ada slot sesi lagi, biarkan sistem smm yang
   * mengaturnya"*. It stays in the schema because the derived value has to be
   * STORED: the rotation must still mean the same thing when the row is read
   * back tomorrow.
   */
  slot: z.number().int().min(0).max(5).default(0),
  /**
   * How many platform PHASES one session runs (plan 900 D6.3). With three
   * platforms and three phases, every phone warms up every platform in one
   * session — the thing plan 316 spent `$run.repeat` on.
   *
   * Defaulted to 3 since 0.57.0, bounded by `phaseCount` to the platforms the
   * session actually covers. The owner's expectation is that a warm-up covers
   * a phone's accounts, not one of them: *"setiap 1 device yah harus urut ada
   * youtube, tiktok dan instagram semuanya ke warmup"*. One platform per
   * session was a default that quietly did a third of the job.
   */
  phases: z.number().int().min(1).max(3).default(3),
  /**
   * How a phone's INTERESTS show up in what it does.
   *
   * `chance` and `commentChance` are the base rates; `keywordBoost` multiplies
   * BOTH when what is on screen matches one of the session's keywords. That is
   * what makes the keywords a personality rather than a search list: a phone
   * set to `trading` likes and reads trading content more often than the rest
   * of what it scrolls past, without ever searching for it.
   */
  like: z
    .object({
      chance: z.number().min(0).max(1).default(0.1),
      /** Opening the comment sheet, reading it and closing it. Never types. Lower than `chance` because it is a bigger action. */
      commentChance: z.number().min(0).max(1).default(0.05),
      keywordBoost: z.number().min(1).max(10).default(3),
    })
    .default({ chance: 0.1, commentChance: 0.05, keywordBoost: 3 }),
  /**
   * How a phone's activities are dispatched (plan 908).
   *
   * `jobs` — one job per activity, the gaps kept as `notBeforeAt` stamps the
   * router honours on its own tick. The default, and the path verified on
   * hardware: the operator sees a state and an error PER ACTIVITY.
   *
   * `workflow` — the whole sequence as ONE job, with `delay` nodes between the
   * scripts (plan 907's direct-run). The gaps are then exact rather than as
   * fine as a fifteen second tick, and the phone is claimed once instead of
   * four times. The cost is the per-activity column: this plugin holds
   * `job.get` and deliberately not `job.list`, so it sees one outcome for the
   * sequence and Studio's run view is where the steps are.
   *
   * A choice rather than a replacement, because those are real trade-offs in
   * both directions and neither answer is right for every farm.
   */
  sequenceMode: z.enum(['jobs', 'workflow']).default('jobs'),
  /**
   * Relative weight per activity style, for the weighted draw that decides
   * what a phone does inside its platform (plan 900 D6.4).
   *
   * A record rather than a list, and missing ids read as weight 1: the style
   * ids belong to the engine (wave 2), and a settings row written before a
   * style existed must keep working when that style ships. A weight of 0 turns
   * a style off without removing it, so an operator can put it back.
   */
  styleWeights: z.record(z.string().min(1), z.number().min(0).max(10)).default({}),
})
export type WarmupSettings = z.infer<typeof WarmupSettingsSchema>

/** The settings a warm-up session gets when nobody has chosen any — the trading-niche defaults `warmup-rotation` shipped. */
export const DEFAULT_WARMUP_KEYWORDS = ['trading', 'forex', 'gold', 'xau', 'scalping', 'full margin', 'belajar trading', 'saham', 'crypto', 'investasi'] as const

export function defaultWarmupSettings(): WarmupSettings {
  return WarmupSettingsSchema.parse({ keywords: [...DEFAULT_WARMUP_KEYWORDS] })
}

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
  /** The session's hashtag rule (0.19.0) — fixed ones on every video, and lines one of which each video may be given. */
  hashtags: HashtagRuleSchema.default(NO_HASHTAG_RULE),
  /**
   * Which platform each phone does NOT post to (0.45.0, `excludes.ts`).
   *
   * Stored although it has already been APPLIED to the rows, and the two are
   * not the same thing: the rows carry the decision (a `skipped` platform an
   * operator can undo one at a time), and this carries what was ASKED FOR, so
   * the session page can still say "this session skips YouTube on phones
   * tagged no-youtube" after somebody has enabled three of them by hand. It is
   * never re-applied on its own — a rule that quietly re-skipped what an
   * operator had just enabled would make the button a lie.
   */
  excludes: ExcludeRuleSchema.default(NO_EXCLUDES),
  /**
   * Which kind of session this is (plan 900 D4).
   *
   * Defaulted to `post`, which is what every session stored before this field
   * existed is. That default is the whole migration: the reader skips a row
   * that fails to parse, so a required discriminator would have emptied the
   * sessions list on upgrade instead of reporting anything.
   */
  kind: z.enum(SESSION_KINDS).default('post'),
  /** A warm-up session's settings; `null` on a post session. Tied to `kind` by the check below. */
  warmup: WarmupSettingsSchema.nullable().default(null),
  /**
   * Which phones a warm-up covers (0.57.0, `warmup-target.ts`).
   *
   * Stored although it has already been APPLIED when the rows were written —
   * the same trade `excludes` above explains. The rows are what the phones are
   * doing; this is what was ASKED FOR, so the session page can still say
   * "every phone except the ones tagged banned" long after the fleet changed
   * shape. It is never re-applied on its own.
   *
   * A post session leaves it at its default and ignores it: a post session's
   * phones come from the videos' own assignment, decided when the session was
   * made, and a second phone-picking rule would be two answers to one question.
   */
  target: WarmupTargetSchema,
  /**
   * When this session was last STARTED, as opposed to when it was made
   * (0.58.0).
   *
   * A warm-up is a definition you run again — on the 20th, and again on the
   * 21st — so "made" and "last started" stopped being the same fact. Two
   * things read this: the dedupe guard on `run-warmup`, which is what stops a
   * schedule aimed at eighty phones starting eighty runs; and the session
   * list, where "created 3 days ago" is the wrong thing to show about
   * something that ran an hour ago.
   *
   * `null` on a session made before runs existed. It is not back-filled from
   * `createdAt`: those two were the same moment for such a session, and
   * guessing would state a fact nothing recorded.
   */
  lastRunAt: z.number().int().nullable().default(null),
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
  /**
   * Stopped by the operator: the router sends nothing for this session until
   * it is started again (0.57.0).
   *
   * `false` by default, which is what every session stored before this field
   * existed is — and it must stay that way round. A flag whose default paused
   * work would stop an upgraded farm's sessions in silence, and the first sign
   * of it would be a session that simply never finished.
   *
   * The flag only gates what goes OUT. Pulling back what is already out is a
   * separate thing the stop member does through `session-control.ts`, because
   * the gate cannot do it: a job the farm is running is not the plugin's to
   * forget, it has to be cancelled.
   */
  stopped: z.boolean().default(false),
})
  /*
    The two fields are one fact, so they are checked as one (plan 900 D4). A
    warm-up session with no settings, or a post session carrying warm-up
    settings, is a row whose kind cannot be trusted — and the kind is what
    every screen and every dispatch branches on.
  */
  .refine((group) => (group.kind === 'warmup') === (group.warmup !== null), {
    message: 'a warmup session must carry warmup settings, and a post session must not',
    path: ['warmup'],
  })
export type Group = z.infer<typeof GroupSchema>

/**
 * A warm-up of this title made moments ago, or `null` — the guard that stops a
 * schedule aimed at a whole fleet from making one session per phone.
 *
 * `smm/warmup-rotation` was a workflow DISPATCHED to every phone, so a schedule
 * for it naturally targeted the fleet. Its replacement plans the whole fleet
 * from one run, and a schedule pointed the same way would make eighty identical
 * sessions each planning the same eighty phones. Seventy-nine of those runs
 * should find the first one's work and stop.
 *
 * Pure, and `now`/`windowMin` are arguments, so the window is a decision a test
 * can make rather than a clock it has to wait for. `windowMin: 0` turns it off.
 */
export function reusableWarmup(groups: readonly Group[], title: string, now: number, windowMin: number): Group | null {
  if (windowMin <= 0) return null
  const since = now - windowMin * 60
  const matches = groups.filter((group) => group.kind === 'warmup' && group.title === title && group.createdAt >= since)
  // The NEWEST, so two runs a second apart both answer with the same session
  // rather than each finding a different older one.
  return matches.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
}

/**
 * The rotation slot a new warm-up should take, from the sessions already made.
 *
 * ## Why this is derived and not asked
 *
 * `slot` shifts which platform each phone gets, so that a farm running two
 * warm-ups in a day does not send every phone to YouTube twice. Getting it
 * right meant the operator keeping count — and an operator who forgets, or who
 * adds a second schedule months later, silently gets the first session's
 * rotation again. That is a bug with no symptom: every run is green and half
 * the accounts are never touched.
 *
 * So the plugin counts. The owner's instruction was exactly this — *"ga perlu
 * ada slot sesi lagi, biarkan sistem smm yang mengaturnya"*.
 *
 * ## Why a rolling window and not "today"
 *
 * A calendar day needs a timezone, and the farm's is not this module's to
 * guess: a UTC day boundary falls at 07:00 in the owner's own timezone, which
 * would give a 06:00 session yesterday's slot. `SLOT_WINDOW_SEC` asks the
 * question that actually matters — how many warm-ups has this farm run
 * RECENTLY — and needs no calendar at all.
 *
 * Wraps at `SLOT_COUNT`, so a farm running six sessions in a day starts the
 * rotation over rather than failing the schema's `max(5)`.
 */
export const SLOT_WINDOW_SEC = 20 * 60 * 60
export const SLOT_COUNT = 6

export function slotFor(groups: readonly Group[], now: number): number {
  const since = now - SLOT_WINDOW_SEC
  const recent = groups.filter((group) => group.kind === 'warmup' && group.createdAt >= since).length
  return recent % SLOT_COUNT
}

/** Is this a warm-up session? Narrows `warmup` to non-null, so callers stop re-checking. */
export function isWarmup(group: Group): group is Group & { kind: 'warmup'; warmup: WarmupSettings } {
  return group.kind === 'warmup' && group.warmup !== null
}

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

/** What an operator may change about a started session's pacing (0.30.0). A field left out is unchanged. */
export interface PacingEdit {
  concurrency?: number
  gapMinSec?: number
  gapMaxSec?: number
}

/**
 * The pacing after an edit, and which parts of it changed (0.30.0). The owner (2026-09-15): "4 at a time, 30–120 s
 * apart" could not be changed once a session existed. A reversed gap range is read as written, like `drawGap`.
 */
export function editPacing(pacing: Pacing, edit: PacingEdit): { pacing: Pacing; changed: Array<'concurrency' | 'gap'> } {
  const lo = edit.gapMinSec ?? Math.min(pacing.gapSec[0], pacing.gapSec[1])
  const hi = edit.gapMaxSec ?? Math.max(pacing.gapSec[0], pacing.gapSec[1])
  const next: Pacing = { ...pacing, concurrency: edit.concurrency ?? pacing.concurrency, gapSec: [Math.min(lo, hi), Math.max(lo, hi)] }
  const changed: Array<'concurrency' | 'gap'> = []
  if (next.concurrency !== pacing.concurrency) changed.push('concurrency')
  if (next.gapSec[0] !== Math.min(pacing.gapSec[0], pacing.gapSec[1]) || next.gapSec[1] !== Math.max(pacing.gapSec[0], pacing.gapSec[1])) changed.push('gap')
  return { pacing: next, changed }
}

/**
 * The turns still to come, spaced again by a new gap (0.30.0). Only rows whose turn is in the FUTURE are given; they keep
 * their order, and the first of them keeps its time — it was already one old gap after the turn before it — so nothing is
 * pulled in ahead of what was promised, and every later turn follows by a newly drawn gap.
 */
export function retimeTurns(
  rows: readonly { videoArtifactId: string; notBeforeAt: number }[],
  gapSec: readonly [number, number],
  now: number,
  random: () => number = Math.random,
): ScheduledVideo[] {
  const ordered = [...rows].sort((a, b) => a.notBeforeAt - b.notBeforeAt)
  const first = ordered[0]
  if (!first) return []
  let at = Math.max(now, first.notBeforeAt)
  return ordered.map((row, index) => {
    if (index > 0) at += drawGap(gapSec, random)
    return { videoArtifactId: row.videoArtifactId, notBeforeAt: at }
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

export type RowState = 'pending' | 'dispatched' | 'succeeded' | 'partial' | 'failed' | 'unsupported' | 'skipped'

export interface GroupProgress {
  total: number
  waiting: number
  running: number
  posted: number
  failed: number
  attention: number
  skipped: number
}

/**
 * What the operator reads at a glance: how far Monday's batch has got.
 *
 * `attention` is `partial` — some phone posted and some did not — kept apart
 * from `failed` because the two need different actions: one is "try again",
 * the other is "look at it first". `unsupported` counts as attention too; it
 * is a row that can never send until something changes.
 *
 * `skipped` is its own count and belongs to NONE of the others (0.45.0). It is
 * not waiting (nothing will come for it), not failed (nothing went wrong), and
 * not something to look at (it is already what the operator asked for) — and
 * folding it into any of those is what would make a finished session read as
 * eight things still outstanding. `total` still counts it, so the parts add up
 * and "3 skipped of 120" is visible rather than silently missing.
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
    skipped: count('skipped'),
  }
}

/** The one-line summary a group row shows. Says what is left, not just what is done. */
export function groupSummary(title: string, p: GroupProgress): string {
  if (p.total === 0) return `${title}: no videos`
  if (p.posted === p.total) return `${title}: all ${p.total} posted`
  // A session whose every remaining platform was skipped is DONE, and says so with the skips named
  // (0.45.0): "all 36 posted, 4 skipped" rather than a bar stuck four short of the end forever.
  if (p.posted + p.skipped === p.total) return `${title}: all ${p.posted} posted, ${p.skipped} skipped`
  const parts: string[] = []
  if (p.posted > 0) parts.push(`${p.posted} posted`)
  if (p.running > 0) parts.push(`${p.running} running`)
  if (p.waiting > 0) parts.push(`${p.waiting} waiting`)
  if (p.failed > 0) parts.push(`${p.failed} failed`)
  if (p.attention > 0) parts.push(`${p.attention} need a look`)
  if (p.skipped > 0) parts.push(`${p.skipped} skipped`)
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
