import { z } from 'zod'
import { normalizeHashtags } from './hashtags'
import { PLATFORM_IDS, PlatformIdSchema, deviceCarriesPlatform, platformById, type PlatformId } from './platforms'

/**
 * One "post" — a video an operator uploaded once, plus what is to happen to it
 * on each platform — and the pure function that decides what to dispatch next.
 *
 * Everything here is pure: no `ctx`, no farm call, no clock of its own. The
 * service (`index.ts`) reads the devices, calls `planDispatch`, fires the jobs
 * it is told to fire, and writes back the states it is given. That split is
 * what makes the routing rules testable at all — the interesting decisions
 * ("this phone is busy", "no phone carries this label yet", "this platform
 * cannot post") are exactly the ones that are impossible to exercise through a
 * live farm in CI.
 *
 * ## The storage shape, and why it is one row per post
 *
 * A post lives at `post:<artifactId>` in the plugin's own global KV namespace.
 * No core table was added for any of this, and none needs to be: `kv_entries`
 * is the generic store, `labels` is the generic "this phone is one of these",
 * and `job.run` is the generic "do this on that phone". This plugin is only
 * the policy that joins them.
 *
 * Keyed by the ARTIFACT id rather than a generated id, for the same reason the
 * TikTok queue is: re-adding the same video is then an update of the one row
 * that video already has, instead of a second row racing the first to post it.
 */

/** Where every post row lives. Also the surface view's `kv.list` prefix — one constant, both readers. */
export const POST_PREFIX = 'post:'

export function postKeyFor(videoArtifactId: string): string {
  return `${POST_PREFIX}${videoArtifactId}`
}

/**
 * What happened to one post on one platform.
 *
 * `pending` and `skipped` are deliberately different states, and the
 * difference is the one an operator cares about:
 *
 * - `pending` — nothing is wrong; there was simply no eligible phone at the
 *   last tick (all busy, all offline, or none labelled yet). The router will
 *   try again on the next tick, so labelling a phone an hour from now picks
 *   this post up with no operator action at all.
 * - `unsupported` — this platform has no verified upload flow in this build.
 *   Retrying changes nothing, and the row says so by name rather than sitting
 *   at `pending` forever looking like a transient problem.
 */
/**
 * `dispatched` is not an outcome, and treating it as one was this plugin's
 * worst bug.
 *
 * The first three states stopped at the moment the jobs were handed to the
 * queue. A post whose ten upload jobs all failed still read **"sent to 10"**,
 * forever, with nothing anywhere to say otherwise: no job id was stored, so
 * there was no way back from a post to what happened on the phones. The
 * client asked for exactly the missing half — *"kecatat berhasil atau tidak
 * dan bisa di rerun"* — and this is it.
 *
 * - `pending` — nothing is wrong; there was simply no eligible phone at the
 *   last tick (all busy, all offline, or none labelled yet). The router will
 *   try again on the next tick, so labelling a phone an hour from now picks
 *   this post up with no operator action at all.
 * - `dispatched` — the jobs are queued or running. A waypoint now, not a
 *   destination: the reconciler moves it on as the jobs settle.
 * - `succeeded` — every dispatched job finished successfully.
 * - `partial` — some phones posted, some did not. Its own state rather than a
 *   flavour of `failed`, because the operator's next move differs: retry the
 *   stragglers, not the lot.
 * - `failed` — every dispatched job failed.
 * - `unsupported` — this platform has no verified upload flow in this build.
 *   Retrying changes nothing, and the row says so by name rather than sitting
 *   at `pending` forever looking like a transient problem.
 */
export const DISPATCH_STATES = ['pending', 'dispatched', 'succeeded', 'partial', 'failed', 'unsupported'] as const
export type DispatchState = (typeof DISPATCH_STATES)[number]

/**
 * What one phone's upload job did. `queued` covers queued AND running — both
 * mean "not yet an answer".
 *
 * `unverified` is the job SUCCEEDING while the platform script says it could
 * not confirm the post landed (`tiktok/post-video`'s `outcome: "unverified"`).
 * It is its own word because both neighbours are lies: calling it `success`
 * reported "1 posted" on the owner's farm for an upload that never appeared
 * (2026-09-11), and calling it `failed` would hand it to "Re-run failed", which
 * re-sends — and if the post DID land, that is the same video on the same
 * account twice.
 */
export const ATTEMPT_STATES = ['queued', 'success', 'failed', 'unverified'] as const
export type AttemptState = (typeof ATTEMPT_STATES)[number]

/** How much of a job's error or a script's reason an attempt keeps. The full text stays on the job. */
export const ATTEMPT_ERROR_MAX = 1_000

/**
 * What a hand mark leaves an attempt as: `posted` (the attempt is `success`) or `failed`. The words of
 * 0.21.0, kept, so a mark written then still parses.
 */
export const RESOLUTIONS = ['posted', 'failed'] as const
export type Resolution = (typeof RESOLUTIONS)[number]

/**
 * What an operator may force on one platform of one video, by hand (0.23.0):
 *
 * - `mark-posted` — the video is on the account whatever the farm recorded. A `failed`, `unverified`
 *   or settled `queued` attempt becomes `success`; a platform with no attempt at all (`pending`,
 *   `unsupported`) gets a MANUAL attempt that no phone of the farm ran. Either way the router never
 *   sends it there again.
 * - `unmark-posted` — a `success` that is not actually on the account becomes `failed`, which is what
 *   Retry failed re-sends.
 * - `mark-failed` — a not-confirmed attempt the operator checked and did not find (0.21.0).
 */
export const MARK_ACTIONS = ['mark-posted', 'unmark-posted', 'mark-failed'] as const
export type MarkAction = (typeof MARK_ACTIONS)[number]

/** How many hand marks one attempt keeps. Enough to see someone flip it back and forth; not a log. */
export const MARKS_LIMIT = 20

/** The jobId of a manual attempt starts with this — there is no farm job behind it, so nothing links to one. */
export const MANUAL_JOB_PREFIX = 'manual:'

/**
 * One hand mark, kept ON the attempt it changed so the page can always say "a person set this, not the
 * script". A plugin member has no actor of its own, so "who" is the job that wrote it (`byJobId` — the
 * Jobs screen names who ran that job) and "when" is `at`.
 */
export const AttemptResolutionSchema = z
  .object({
    /** Which hand action wrote it. Absent on a mark written by 0.21.0/0.22.0, which only knew "resolve". */
    action: z.enum(MARK_ACTIONS).optional(),
    /** The attempt's state before the mark; `null` for a manual attempt, which had no state before it existed. */
    from: z.enum(ATTEMPT_STATES).nullable(),
    to: z.enum(RESOLUTIONS),
    at: z.number().int().nonnegative(),
    byJobId: z.string().min(1).nullable(),
    /** The operator's own words, when they gave any. */
    note: z.string().max(300).nullable(),
    /** What the attempt said before the mark — its error or the script's reason; for a manual attempt, the platform's note. */
    reason: z.string().max(ATTEMPT_ERROR_MAX).nullable(),
  })
  .strict()
export type AttemptResolution = z.infer<typeof AttemptResolutionSchema>

/**
 * One phone's attempt at one post, on one platform.
 *
 * The `jobId` is the whole point: it is the only link from a post back to what
 * the farm actually did, and without it "re-run the ones that failed" cannot
 * be answered at all. `deviceId` is stored beside it so a retry can target the
 * same phones without re-deriving them from a fleet that has moved on.
 */
/** How many replaced attempts a platform keeps. Enough to see a pattern of failures; not a log. */
export const HISTORY_LIMIT = 20

/**
 * Move replaced attempts into history, keeping the newest `HISTORY_LIMIT`. The one writer of
 * `history`, used by both retry members so they cannot disagree about order or cap.
 */
export function withRetired(history: readonly Attempt[], retired: readonly Attempt[]): Attempt[] {
  return [...history, ...retired].slice(-HISTORY_LIMIT)
}

/** The round the next attempt on this platform is: one past everything it has already tried. */
export function nextRound(state: { attempts: readonly Attempt[]; history: readonly Attempt[] }): number {
  let max = 0
  for (const a of [...state.history, ...state.attempts]) if (a.round > max) max = a.round
  return max + 1
}

export const AttemptSchema = z
  .object({
    jobId: z.string().min(1),
    deviceId: z.string().min(1),
    /**
     * The phone's NAME as the farm gave it at the moment of the attempt —
     * `#3 moto g06 power`, never a uuid.
     *
     * Stored rather than resolved at render, because this is the one place an
     * id cannot answer the question. The Posts table reads the stored row
     * straight out of `kv.list`; a device id in a cell is unreadable, and a
     * device that has since been removed from the farm has no name left to
     * look up at all — while what actually happened ("it posted from the phone
     * on the shelf labelled #3") stays true forever. The router refreshes it
     * each tick from the live fleet, so a renamed phone catches up within a
     * minute and only a phone that has left the farm keeps its old name.
     *
     * `null` on an attempt recorded before this field existed; `attemptPhone`
     * below is the single reader, and it falls back to the short id rather
     * than to a blank.
     */
    deviceName: z.string().max(120).nullable().default(null),
    state: z.enum(ATTEMPT_STATES),
    /**
     * Why it is in this state, verbatim: the job's own error when it failed, the script's `reason`
     * when it reported `failed` or could not confirm the post (`unverified`). Truncated at
     * `ATTEMPT_ERROR_MAX` — the full text is on the job itself. Raised from 300 in 0.21.0, so an
     * error an operator must act on is not cut mid-sentence.
     */
    error: z.string().max(ATTEMPT_ERROR_MAX).nullable(),
    /**
     * Every hand mark on this attempt, oldest first (a list since 0.23.0); absent when nobody marked it.
     * 0.21.0 and 0.22.0 stored ONE object here, and it is read as a list of one.
     */
    resolution: z
      .union([AttemptResolutionSchema, z.array(AttemptResolutionSchema).max(MARKS_LIMIT)])
      .transform((value) => (Array.isArray(value) ? value : [value]))
      .optional(),
    /**
     * `true` on an attempt no phone of the farm ran (0.23.0): an operator posted the video by hand and
     * marked the platform posted. Its `jobId` starts with `MANUAL_JOB_PREFIX`. Absent otherwise.
     */
    manual: z.literal(true).optional(),
    /**
     * Unix seconds the job was enqueued (0.12.0). With `settledAt` and `round` this is what lets
     * the session page answer the owner's three questions from the production farm: which ones are
     * running NOW, how far along it is, and whether an error on screen is from this run or an
     * earlier one. `null` on an attempt recorded before these fields existed.
     */
    at: z.number().int().nonnegative().nullable().default(null),
    /** Unix seconds the job reached an outcome; `null` while it is queued or running. */
    settledAt: z.number().int().nonnegative().nullable().default(null),
    /** 1 for the first send on this platform, 2 for the first retry, and so on. */
    round: z.number().int().positive().default(1),
  })
  .strict()
export type Attempt = z.infer<typeof AttemptSchema>

export const PlatformStateSchema = z
  .object({
    state: z.enum(DISPATCH_STATES),
    /** Unix seconds of the dispatch, or null while nothing has been dispatched. */
    at: z.number().int().nonnegative().nullable(),
    /** How many phones this post was dispatched to on this platform. */
    deviceCount: z.number().int().nonnegative(),
    /**
     * Every phone this platform was dispatched to, and what its job did.
     *
     * Defaulted rather than required so a row written by the build that had no
     * attempts still parses: those posts simply have nothing to reconcile and
     * no failures to retry, which is the truth about them.
     */
    attempts: z.array(AttemptSchema).default([]),
    /**
     * Earlier attempts a retry REPLACED, oldest first (0.12.0).
     *
     * A retry used to delete the failed attempts it replaced, so the page could not say whether a
     * red line was this run's or the last one's — and after a second failure nobody could see the
     * first. They are kept here instead, OUTSIDE `attempts`, so nothing that decides dispatch reads
     * them: `rollUp`, `failedDevices` and the router still see only the current attempts, exactly as
     * before. Capped, because a row retried every hour would otherwise grow without bound.
     */
    history: z.array(AttemptSchema).max(HISTORY_LIMIT).default([]),
    /** Why it is in this state, shown verbatim in the Posts table. Null when there is nothing to explain. */
    note: z.string().max(500).nullable(),
    /**
     * WHERE it ran and HOW it went, in one line — `#3 moto g06 power · posted`,
     * `2 phones · 1 posted, 1 failed`.
     *
     * This is what the platform's column in the Posts table actually renders,
     * and it exists because the state word alone could not answer the first
     * question an operator asks about a fan-out: which phone was that? A
     * tier-A column reads ONE dot path out of the stored row and renders it as
     * text, so the sentence has to be stored — there is nowhere else for it to
     * be composed.
     *
     * Derived, never authoritative: `describePlatform` computes it from
     * `state` and `attempts`, and `withSummary` is the only writer. A row whose
     * summary somehow disagreed with its attempts is a display bug, never a
     * dispatch one.
     *
     * `null` on a row written before this field existed. The router refreshes
     * every row it walks, so those catch up on the next tick.
     */
    summary: z.string().max(300).nullable().default(null),
  })
  .strict()
export type PlatformState = z.infer<typeof PlatformStateSchema>

/**
 * The phone an attempt ran on, named for a human.
 *
 * Never blank and never bare: an attempt with no stored name reads
 * `device 4f3a91c2`, which says out loud that this is an id — the phone was
 * removed from the farm, or the attempt predates the stored name. An empty
 * cell would read as "nowhere", which is the one thing it is not.
 */
export function attemptPhone(attempt: Pick<Attempt, 'deviceId' | 'deviceName'>): string {
  const name = attempt.deviceName?.trim()
  return name ? name : shortDeviceId(attempt.deviceId)
}

/** A device id, short enough to read and long enough to match against the Devices screen. */
export function shortDeviceId(deviceId: string): string {
  return `device ${deviceId.slice(0, 8)}`
}

/**
 * A phone's display name, from the fields `device.list` gives back.
 *
 * Mirrors `formatDeviceName` (`@enkaku/ui`, plan 124 §4.1) — `#7 Galaxy A15`,
 * or the bare label when the device has no number — deliberately and with the
 * rule named, because a plugin service cannot import it: `@enkaku/ui` is a
 * React component package, and pulling it into a bundled service to compose
 * two fields would drag React into a pack that never renders anything.
 */
export function deviceDisplayName(device: { id: string; label?: string | null; number?: number | null }): string {
  const label = (device.label ?? '').trim()
  if (label.length === 0) return shortDeviceId(device.id)
  return device.number == null ? label : `#${device.number} ${label}`
}

/** One attempt's outcome as a word an operator reads, never the stored enum. */
const ATTEMPT_WORDS: Record<AttemptState, string> = {
  queued: 'running',
  success: 'posted',
  failed: 'failed',
  // Kept apart from both neighbours on purpose (see `ATTEMPT_STATES`): it is
  // not a success, and it must not be worded as one. "not confirmed" since
  // 0.21.0 — the page's own word, so a summary line and the cell agree.
  unverified: 'not confirmed',
}

/**
 * One platform's whole state in one line — the string the Posts table shows.
 *
 * Pure, and the only place this wording lives. The shape is deliberately
 * "where · what": a single phone names itself, a fan-out counts itself, and
 * neither ever renders as a bare status word, because "partial" on its own was
 * exactly the cell that sent the operator hunting through the Jobs screen.
 */
export function describePlatform(state: PlatformState): string {
  if (state.state === 'unsupported') return 'Not supported in this build'
  const attempts = state.attempts ?? []
  if (attempts.length === 0) {
    // `dispatched` with no attempts is a row written before attempts were
    // recorded at all: the count is the only thing it knows, so it is the only
    // thing this claims.
    if (state.state === 'dispatched') return `Sent to ${state.deviceCount} phone${state.deviceCount === 1 ? '' : 's'}`
    return 'Waiting for a phone'
  }

  const first = attempts[0]
  if (attempts.length === 1 && first) return `${attemptPhone(first)} · ${ATTEMPT_WORDS[first.state]}`

  const count = (s: AttemptState) => attempts.filter((a) => a.state === s).length
  const running = count('queued')
  const ok = count('success')
  const bad = count('failed')
  const unsure = count('unverified')
  const phones = `${attempts.length} phones`
  if (running === attempts.length) return `${phones} · running`
  if (ok === attempts.length) return `${phones} · all posted`
  const parts: string[] = []
  if (ok > 0) parts.push(`${ok} posted`)
  if (bad > 0) parts.push(`${bad} failed`)
  if (unsure > 0) parts.push(`${unsure} not confirmed`)
  if (running > 0) parts.push(`${running} running`)
  return `${phones} · ${parts.join(', ')}`
}

/**
 * The same state with its summary line brought up to date.
 *
 * Returns the state UNCHANGED (same reference) when the line already agrees,
 * so a caller can use identity to decide whether a row needs writing at all —
 * rewriting an unchanged row every tick is what makes a table look permanently
 * busy for no reason.
 */
export function withSummary(state: PlatformState): PlatformState {
  const summary = describePlatform(state)
  return state.summary === summary ? state : { ...state, summary }
}

/**
 * The same state with every attempt's phone name refreshed from the live fleet.
 *
 * Three cases, in order: the fleet knows the phone and the name follows it
 * (including a rename); the fleet does not and the recorded name STAYS, which
 * is the whole reason the name is stored at all; neither, and the short id is
 * written in so the panel can never draw a blank where a phone should be.
 *
 * An unchanged state comes back by identity, as above.
 */
export function withDeviceNames(state: PlatformState, names: ReadonlyMap<string, string>): PlatformState {
  const attempts = state.attempts ?? []
  let changed = false
  const next = attempts.map((attempt) => {
    const name = names.get(attempt.deviceId) ?? attempt.deviceName ?? shortDeviceId(attempt.deviceId)
    if (name === attempt.deviceName) return attempt
    changed = true
    return { ...attempt, deviceName: name }
  })
  return changed ? { ...state, attempts: next } : state
}

export const PENDING_STATE: PlatformState = withSummary({ state: 'pending', at: null, deviceCount: 0, attempts: [], history: [], note: null, summary: null })

/**
 * A stored post. `.strict()` and an explicit `version`, so a row written by a
 * NEWER build of this plugin fails the parse loudly instead of being half-read
 * by an older one — the same fail-closed posture the TikTok pack takes with
 * its own stored shapes, and the reason the service treats a parse failure as
 * "leave this row alone" rather than "overwrite it".
 */
export const PostSchema = z
  .object({
    version: z.literal(1),
    videoArtifactId: z.string().min(1),
    /**
     * Required, and deliberately not nullable.
     *
     * It reads like a field that ought to be optional — every platform has
     * some fallback of its own — but the path this manager actually uses does
     * not have one. `tiktok/post-video` with `source: 'direct'` refuses an
     * empty caption outright (`E_PARAMS_INVALID`, in its own `resolveDirect`),
     * because the captions-file fallback belongs to its `queue` and `folder`
     * sources and there is nothing to fall back TO when a caller names the
     * video itself. Storing a caption-less post would therefore produce a row
     * that looks fine, dispatches, and fails on every phone.
     */
    // Empty is allowed since 0.19.0 — a video with no speech gets no auto caption. The router holds a row whose caption
    // AND hashtags are empty (`NO_CAPTION_YET`), because the direct upload path still refuses an empty text.
    caption: z.string().max(2_200),
    /** The video's OWN hashtags, normalised `#tag`s (0.19.0). The session's fixed ones and its picked line are added when it posts. */
    hashtags: z.array(z.string().min(2).max(100)).max(30).default([]),
    /** Which of the session's hashtag lines this video was given, picked once when the session was made; null for none. */
    hashtagLine: z.number().int().nonnegative().nullable().default(null),
    /** Which platforms this video is for. Empty is legal and simply never dispatches. */
    platforms: z.array(PlatformIdSchema),
    /**
     * Which phones this post may go to, or EMPTY for "any phone carrying the
     * platform's label".
     *
     * Empty is the default and the original behaviour: the label decides, and
     * a phone labelled later is picked up with no edit. A non-empty list is
     * the operator naming the phones, and those phones are used as named,
     * labelled or not (0.11.0 — `planDispatch` says why the older "narrows,
     * never widens" rule was retired).
     *
     * Defaulted so a row written before this field existed still parses, and
     * parses as "any", which is what those posts meant.
     */
    deviceIds: z.array(z.string().min(1)).default([]),
    createdAt: z.number().int().nonnegative(),
    /**
     * The upload session this row belongs to, or `null` for a row posted on
     * its own (every row written before groups existed, and every row the
     * single-video path still writes).
     *
     * Membership lives HERE rather than as a list on the group, because the
     * router walks rows and needs the answer per row, and because a list on
     * the group would be a second place for the truth to live. `groups.ts`
     * explains the rest of that trade.
     */
    groupId: z.string().min(1).nullable().default(null),
    /**
     * Unix seconds: the router leaves this row alone until then — how a group
     * of forty is spread over an hour instead of firing at once.
     *
     * `null` means two different things, and which one is decided by
     * `groupId` (`groups.ts`'s `isRowDue`): a row IN a group has not been
     * started yet, so it waits for the operator; a row outside one was never
     * paced and is due immediately, which is exactly what it meant before this
     * field existed.
     */
    notBeforeAt: z.number().int().nonnegative().nullable().default(null),
    /**
     * How many phones ONE tick may hand this row to, overriding the farm-wide
     * `maxDevicesPerPlatform`. `1` is what "one video per phone" means: the
     * router claims a phone for this row and the next row takes the next free
     * phone, which is what spreads forty videos over forty phones.
     *
     * `null` keeps the farm setting, which is what every row written before
     * groups existed meant.
     */
    maxDevices: z.number().int().positive().max(500).nullable().default(null),
  /**
   * The ONE phone this video belongs to, for every platform, for the life of its session (0.12.0).
   *
   * "One video per phone" used to mean only that each video went to one phone — the phone was
   * whichever labelled phone happened to be free when the video's turn came. So a phone that had
   * already posted one video took the next, and a retried video landed on a phone that had posted
   * a different one: on the owner's production farm (2026-09-14) #21 SM-A075F ended up with three
   * videos of a five-video session. The owner's expectation is the right rule — the pairing is
   * decided once, when the spread is drawn, and a retry goes back to the same phone.
   *
   * Written by `add-group` when the session is created over a known phone pool, or once by the
   * router for a row created before this field existed (`groups.ts` `pickAssignment`). `null` for
   * ungrouped posts and for `every-phone` sessions, which keep their fan-out.
   */
  assignedDeviceId: z.string().min(1).nullable().default(null),
    /**
     * Per-platform state, keyed by platform id. Seeded `pending` for every
     * targeted platform by `newPost`, so the Posts table can tell "not
     * targeted" (no key, rendered `—`) apart from "targeted and waiting"
     * without the operator having to know the difference. A key absent from
     * this map is still read as `PENDING_STATE`, so a post stored before a
     * platform existed starts routing to it the moment it is added to
     * `platforms`, with no migration.
     */
    dispatch: z.record(z.string(), PlatformStateSchema),
    /**
     * The one thing the router most recently had to SAY about this post,
     * across every platform — "no phone carries the instagram label yet", and
     * the like.
     *
     * A roll-up, and deliberately a different kind of thing from `dispatch`:
     * that map is state the router acts on, this is a sentence the router
     * writes for a human and never reads back. It exists because the actionable
     * half of a stalled post is always a sentence ("you have not labelled
     * anything") and a table of five status words cannot carry one. Null when
     * there is nothing to say.
     */
    lastNote: z.string().max(500).nullable(),
  })
  .strict()
export type Post = z.infer<typeof PostSchema>

/**
 * A platform's state, always with an `attempts` array.
 *
 * `attempts` was added after rows already existed, and `PlatformStateSchema`
 * defaults it — so a row that has been through the parser always has one. This
 * still normalises, because `stateFor` is the single door every reader goes
 * through and a `Post` reaches it from more than one place: a KV row parsed by
 * the schema, and an object assembled in code. Making the door safe is one
 * line; making every caller defensive is a rule someone eventually forgets.
 */
export function stateFor(post: Post, platform: PlatformId): PlatformState {
  const stored = post.dispatch[platform]
  if (!stored) return PENDING_STATE
  return stored.attempts ? stored : { ...stored, attempts: [] }
}

/**
 * A post's whole state in one line, for the router's own log. Computed on
 * demand and never stored: the Posts table renders the per-platform columns
 * straight off `dispatch`, so a stored copy of this string would be a second
 * source of truth that drifts the first time a write half-lands.
 */
export function postSummary(post: Post): string {
  if (post.platforms.length === 0) return 'no platforms'
  const parts = post.platforms.map((id) => {
    const s = stateFor(post, id)
    const title = platformById(id)?.title ?? id
    const ok = s.attempts.filter((a) => a.state === 'success').length
    const bad = s.attempts.filter((a) => a.state === 'failed').length
    const unsure = s.attempts.filter((a) => a.state === 'unverified').length
    switch (s.state) {
      case 'dispatched':
        return `${title}: running on ${s.deviceCount}`
      case 'succeeded':
        return `${title}: posted on ${ok}`
      case 'partial':
        return `${title}: ${ok} posted, ${bad} failed${unsure > 0 ? `, ${unsure} not confirmed` : ''}`
      case 'failed':
        return `${title}: failed on ${bad}`
      case 'unsupported':
        return `${title}: unsupported`
      default:
        return `${title}: waiting`
    }
  })
  return parts.join(' · ')
}

/**
 * Roll a platform's per-phone attempts up into the one word the table shows.
 *
 * Pure, and the only place that mapping lives. While any attempt is still
 * `queued` the platform stays `dispatched` — an answer is not owed until every
 * phone has given one, and calling a half-finished fan-out `partial` would
 * make a normal in-flight post look like a problem.
 */
export function rollUp(attempts: readonly Attempt[]): DispatchState {
  if (attempts.length === 0) return 'pending'
  if (attempts.some((a) => a.state === 'queued')) return 'dispatched'
  const ok = attempts.filter((a) => a.state === 'success').length
  const bad = attempts.filter((a) => a.state === 'failed').length
  if (ok === attempts.length) return 'succeeded'
  if (bad === attempts.length) return 'failed'
  // Anything unverified lands here too: it is not a success, and it is not a
  // failure an operator should blindly retry.
  return 'partial'
}

/**
 * The phones whose attempt failed — what a retry re-targets, and nothing else.
 *
 * A retry that re-sent to everyone would post the same video twice on every
 * phone that already succeeded. That is not a tidiness argument: it is a
 * duplicate post on a real account, which is the kind of mistake this farm
 * cannot take back.
 */
export function failedDevices(state: PlatformState): string[] {
  return state.attempts.filter((a) => a.state === 'failed').map((a) => a.deviceId)
}

/** As much of `job.get`'s answer as settling an attempt needs. */
export interface SettleableJob {
  status: string
  error?: string | null | undefined
  result?: unknown
}

/**
 * The upload script's own verdict. Every platform pack's post script returns `outcome` (TikTok:
 * posted, unverified, skipped, failed; YouTube and Instagram: posted, unverified, failed) and a
 * `reason`.
 */
const ScriptVerdictSchema = z.object({ outcome: z.string(), reason: z.string().nullable().optional() })

/** What a finished job with no readable verdict is recorded as saying. */
export const RESULT_UNREADABLE =
  'The job finished, but its result could not be read, so whether the video was posted is not known. Check the account on the phone, then mark it as posted or failed.'

function clipError(text: string): string {
  return text.slice(0, ATTEMPT_ERROR_MAX)
}

/**
 * Settle one job into an attempt state — or `null` while it has not finished. Pure, and the only
 * place this mapping lives (0.21.0; it was `index.ts`'s until then). The table, exactly:
 *
 * | the job | its result | the attempt | its text |
 * |---|---|---|---|
 * | `failed` | `outcome: 'posted'` or `'unverified'` | `unverified` | the job failed after the script's verdict — it may be live, so never retryable blind |
 * | `failed` | anything else | `failed` | the job's error, verbatim (the result's `reason` if the job has none) |
 * | `cancelled` | anything | `failed` | "The job was cancelled before it finished", plus the job's error |
 * | `expired` | anything | `failed` | "The job expired before a phone ran it", plus the job's error |
 * | `success` | `outcome: 'posted'` | `success` | none |
 * | `success` | `outcome: 'failed'` or `'skipped'` | `failed` | the result's `reason`, verbatim |
 * | `success` | `outcome: 'unverified'` | `unverified` | the result's `reason`, verbatim |
 * | `success` | an outcome this build does not know | `unverified` | says so, with the outcome and reason |
 * | `success` | no readable outcome at all | `unverified` | `RESULT_UNREADABLE` |
 * | `queued`, `running`, anything else | — | stays `queued` | — |
 *
 * A job that SUCCEEDED is a post only when the script says so. The measured case (2026-09-11, the
 * owner's moto g06): the job went green, the script said `unverified`, and a reconciler reading the
 * status alone wrote "1 posted" for a video that never appeared. The same rule is why a green job
 * with NO readable verdict is `unverified` rather than `success` (it was `success` until 0.21.0):
 * every platform's post script returns an outcome, so a missing one means the answer was lost, not
 * that the video posted. `unverified` is kept apart from `failed` on purpose — Retry failed must
 * never re-send something that may already be live on that account; an operator settles it with
 * `resolveAttempt` after looking.
 */
export function settleJob(job: SettleableJob): { state: AttemptState; error: string | null } | null {
  const jobError = job.error?.trim() || null
  switch (job.status) {
    case 'failed': {
      // A job can fail AFTER its script already had a verdict — the process died in `finish`, or the
      // run was killed while confirming. If that verdict says the post went up (or may have), a retry
      // could post the video twice to the same account, so it is not confirmed rather than failed.
      const late = verdictOf(job.result)
      if (late?.outcome === 'posted' || late?.outcome === 'unverified') {
        const said = late.outcome === 'posted' ? 'had already reported the post as done' : 'had pressed upload but could not confirm it'
        return {
          state: 'unverified',
          error: clipError(
            `The job failed after the upload script ${said}${jobError !== null ? ` (${jobError})` : ''}. It may be live — check the account on the phone, then mark it as posted or failed.`,
          ),
        }
      }
      if (jobError !== null) return { state: 'failed', error: clipError(jobError) }
      const reason = late?.reason?.trim() || null
      return { state: 'failed', error: clipError(reason ?? 'The job failed without an error message. Open its run for the log.') }
    }
    case 'cancelled':
      return { state: 'failed', error: clipError(jobError !== null ? `The job was cancelled before it finished: ${jobError}` : 'The job was cancelled before it finished.') }
    case 'expired':
      return { state: 'failed', error: clipError(jobError !== null ? `The job expired before a phone ran it: ${jobError}` : 'The job expired before a phone ran it.') }
    case 'success':
      break
    default:
      return null
  }

  const verdict = verdictOf(job.result)
  if (verdict === null) return { state: 'unverified', error: RESULT_UNREADABLE }
  const reason = verdict.reason?.trim() || null
  switch (verdict.outcome) {
    case 'posted':
      return { state: 'success', error: null }
    case 'unverified':
      return {
        state: 'unverified',
        error: clipError(reason ?? 'The upload script finished but could not confirm the post appeared. Check the account on the phone, then mark it as posted or failed.'),
      }
    // The script walked away without posting (its own failure path, or nothing to post): nothing is
    // live, so a retry is safe.
    case 'failed':
    case 'skipped':
      return { state: 'failed', error: clipError(reason ?? `The upload script reported "${verdict.outcome}" without saying why.`) }
    default:
      return {
        state: 'unverified',
        error: clipError(
          `The upload script returned an outcome this version does not know ("${verdict.outcome}")${reason !== null ? `: ${reason}` : ''}. Check the account on the phone, then mark it as posted or failed.`,
        ),
      }
  }
}

function verdictOf(result: unknown): z.infer<typeof ScriptVerdictSchema> | null {
  const parsed = ScriptVerdictSchema.safeParse(result)
  return parsed.success ? parsed.data : null
}

/**
 * Did `job.get` fail because the farm no longer HAS the job (pruned, or a farm restored from before
 * it ran)? Only then is an attempt settled as failed from the error. A read that simply did not get
 * through — a deadline, a busy farm — says nothing about what the phone did, and settling it as
 * failed would hand a post that may be live to Retry failed; the reconciler asks again next tick.
 */
export function isJobGone(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : ''
  if (code === 'job_not_found') return true
  const message = err instanceof Error ? err.message : String(err)
  return /job_not_found|no such job/i.test(message)
}

/**
 * The sentence a settled platform carries in `note`, computed from the same attempts as its state so
 * the two cannot drift. `succeeded` needs none; anything not settled keeps `fallback`.
 */
export function platformNote(state: DispatchState, attempts: readonly Attempt[], fallback: string | null): string | null {
  const ok = attempts.filter((a) => a.state === 'success').length
  const bad = attempts.filter((a) => a.state === 'failed').length
  const unsure = attempts.filter((a) => a.state === 'unverified').length
  if (state === 'succeeded') return null
  if (state === 'failed') return `Failed on ${bad === 1 ? 'its phone' : `all ${bad} phones`}. "Retry failed" sends it again.`
  if (state === 'partial') return partialNote(ok, bad, unsure)
  return fallback
}

/**
 * `partial` in words. A not-confirmed phone is named separately and never re-sent on its own: the
 * operator checks that account and marks it, because re-sending a post that did land is a duplicate
 * on a real account.
 */
export function partialNote(ok: number, bad: number, unsure: number): string {
  const parts: string[] = []
  if (ok > 0) parts.push(`${ok} posted`)
  if (bad > 0) parts.push(`${bad} failed`)
  if (unsure > 0) parts.push(`${unsure} not confirmed`)
  const retry = bad > 0 ? ` "Retry failed" sends it again to ${bad === 1 ? 'the phone that failed' : `those ${bad}`} only — the ones that posted are left alone.` : ''
  const check =
    unsure > 0
      ? ` Check ${unsure === 1 ? 'the account that was' : `the ${unsure} accounts that were`} not confirmed on the phone, then mark ${unsure === 1 ? 'it' : 'each'} as posted or failed — ${unsure === 1 ? 'it is' : 'they are'} never re-sent on ${unsure === 1 ? 'its' : 'their'} own.`
      : ''
  return `${parts.join(', ')}.${retry}${check}`
}

/**
 * What `job.get` said about a `queued` attempt's job, for `mark-posted` (0.23.0): still `running`,
 * `settled` (any terminal status), `gone` (the farm no longer has it), or `unknown` (the read did not
 * get through). Only `settled` and `gone` let a queued attempt be marked posted.
 */
export type JobCheck = 'running' | 'settled' | 'gone' | 'unknown'

export type MarkOutcome =
  | { ok: true; post: Post; attempt: Attempt; from: AttemptState | null; manual: boolean }
  | { ok: false; code: 'E_NOT_FOUND' | 'E_CONFLICT' | 'E_PARAMS_INVALID'; message: string }

/** The operator's note, trimmed to what a mark keeps — or null. */
function markNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? ''
  return trimmed === '' ? null : trimmed.slice(0, 300)
}

/**
 * The current attempt a mark names, or why there is none. Pure; `markPost` and the member share it,
 * so the member can ask `job.get` about exactly the attempt `markPost` will then change.
 *
 * `deviceId` and `jobId` both narrow; either may be left out. With neither, a platform with exactly one
 * current attempt means that one. A `jobId` that no longer matches is a refusal — the page may be an
 * hour old, and an attempt a retry has since replaced must not be flipped from under it.
 */
export function markTarget(
  post: Post,
  platform: PlatformId,
  select: { deviceId?: string | null; jobId?: string | null },
): { ok: true; index: number; attempt: Attempt } | { ok: false; code: 'E_NOT_FOUND' | 'E_PARAMS_INVALID'; message: string } {
  const title = platformById(platform)?.title ?? platform
  const state = stateFor(post, platform)
  const deviceId = select.deviceId ?? null
  const jobId = select.jobId ?? null
  const matches = state.attempts.flatMap((a, index) =>
    (deviceId === null || a.deviceId === deviceId) && (jobId === null || a.jobId === jobId) ? [{ index, attempt: a }] : [],
  )
  const only = matches[0]
  if (matches.length === 1 && only !== undefined) return { ok: true, ...only }
  if (matches.length === 0) {
    return {
      ok: false,
      code: 'E_NOT_FOUND',
      message: `This video has no current ${title} attempt on that phone any more — it may have been retried or edited since. Refresh the page.`,
    }
  }
  return { ok: false, code: 'E_PARAMS_INVALID', message: `This video went to ${matches.length} phones on ${title}. Say which phone's attempt to mark.` }
}

/**
 * An operator's hand mark on one platform of one video (0.23.0; `resolveAttempt` in 0.21.0 was its
 * `mark-failed` and not-confirmed `mark-posted` half) — or a refusal, by name. Nothing is sent or
 * re-sent HERE. The transitions, exactly:
 *
 * | action | the attempt now | becomes | refused when |
 * |---|---|---|---|
 * | `mark-posted` | `failed`, `unverified` | `success`, error cleared | — |
 * | `mark-posted` | `queued` | `success` | its job is still running, or could not be checked (`E_CONFLICT`) |
 * | `mark-posted` | none; platform `pending`/`unsupported` | a MANUAL `success` attempt on the video's phone | no single phone to put it on (`E_PARAMS_INVALID`) |
 * | `mark-posted` | `success` | — | already posted (`E_CONFLICT`) |
 * | `unmark-posted` | `success` | `failed`, "Marked as not posted by hand — Retry failed sends it again" | any other state (`E_CONFLICT`) |
 * | `mark-failed` | `unverified` | `failed`, with what the script had said | any other state (`E_CONFLICT`) |
 *
 * Every change appends one entry to the attempt's `resolution` list (from, to, when, the job that
 * wrote it, the note, and the error or reason it replaced). The platform's state, note and summary are
 * recomputed from the changed attempts exactly as the reconciler computes them (`rollUp`,
 * `platformNote`, `withSummary`), so a row whose every attempt is marked posted reads `succeeded` —
 * and the router, which never dispatches a `succeeded` platform, leaves it alone for good.
 *
 * A manual attempt's phone is `deviceId` when given, else the video's assigned phone, else its one
 * chosen phone. The stored shape needs a real phone (`Attempt.deviceId`) and that is also the right
 * rule: if the mark is later removed, Retry failed sends it to that phone.
 */
export function markPost(input: {
  post: Post
  platform: PlatformId
  action: MarkAction
  deviceId?: string | null
  jobId?: string | null
  note?: string | null
  now: number
  byJobId?: string | null
  /** What `job.get` said about the target's job. Read only when the target is `queued`. */
  job?: JobCheck | null
}): MarkOutcome {
  const { post, platform, action, now } = input
  const title = platformById(platform)?.title ?? platform
  if (!post.dispatch[platform] && !post.platforms.includes(platform)) {
    return { ok: false, code: 'E_NOT_FOUND', message: `This video is not for ${title}, so there is nothing to mark.` }
  }
  const state = stateFor(post, platform)
  const note = markNote(input.note)
  const byJobId = input.byJobId ?? null

  if (state.attempts.length === 0) {
    if (action !== 'mark-posted') {
      return { ok: false, code: 'E_NOT_FOUND', message: `This video has not been sent to ${title}, so there is nothing to mark.` }
    }
    if (state.state !== 'pending' && state.state !== 'unsupported') {
      return {
        ok: false,
        code: 'E_CONFLICT',
        message: `${title} for this video has no record of which phones it went to, so it cannot be marked by hand. Refresh the page.`,
      }
    }
    const deviceId = input.deviceId ?? post.assignedDeviceId ?? (post.deviceIds.length === 1 ? (post.deviceIds[0] as string) : null)
    if (deviceId === null) {
      return {
        ok: false,
        code: 'E_PARAMS_INVALID',
        message: `This video has no single phone of its own, so there is no account to record the ${title} post against. Say which phone posted it.`,
      }
    }
    const attempt: Attempt = {
      jobId: `${MANUAL_JOB_PREFIX}${byJobId ?? String(now)}`,
      deviceId,
      deviceName: null,
      state: 'success',
      error: null,
      at: now,
      settledAt: now,
      round: nextRound(state),
      manual: true,
      resolution: [{ action, from: null, to: 'posted', at: now, byJobId, note, reason: state.note }],
    }
    const attempts = [attempt]
    const next = rollUp(attempts)
    const dispatch: Post['dispatch'] = {
      ...post.dispatch,
      [platform]: withSummary({ ...state, state: next, at: state.at ?? now, deviceCount: 1, attempts, note: platformNote(next, attempts, null) }),
    }
    return { ok: true, post: { ...post, dispatch }, attempt, from: null, manual: true }
  }

  const target = markTarget(post, platform, { deviceId: input.deviceId, jobId: input.jobId })
  if (!target.ok) return target
  const current = target.attempt
  const refuse = (message: string): MarkOutcome => ({ ok: false, code: 'E_CONFLICT', message })

  let changed: Pick<Attempt, 'state' | 'error'>
  switch (action) {
    case 'mark-posted': {
      if (current.state === 'success') return refuse(`This ${title} post is already marked as posted. Refresh the page to see it.`)
      if (current.state === 'queued') {
        if (input.job === 'running' || input.job === undefined || input.job === null) {
          return refuse(`This ${title} upload is still running on that phone. Wait for it to finish, then mark it.`)
        }
        if (input.job === 'unknown') {
          return refuse(`Could not check whether this ${title} upload is still running. Nothing was changed — try again in a moment.`)
        }
      }
      changed = { state: 'success', error: null }
      break
    }
    case 'unmark-posted': {
      if (current.state !== 'success') {
        return refuse(`Only a ${title} post marked as posted can have that mark removed, and this one is ${ATTEMPT_WORDS[current.state]} now. Refresh the page to see it.`)
      }
      changed = {
        state: 'failed',
        error: clipError(`Marked as not posted by hand${note !== null ? ` (${note})` : ''} — Retry failed sends it again.`),
      }
      break
    }
    case 'mark-failed': {
      if (current.state !== 'unverified') {
        return refuse(`Only a ${title} post that was not confirmed can be marked as failed by hand, and this one is ${ATTEMPT_WORDS[current.state]} now. Refresh the page to see it.`)
      }
      changed = {
        state: 'failed',
        error: clipError(`Marked as failed by hand after checking the account${note !== null ? ` (${note})` : ''}. The script had said: ${current.error ?? 'nothing'}`),
      }
      break
    }
  }

  const entry: AttemptResolution = { action, from: current.state, to: changed.state === 'success' ? 'posted' : 'failed', at: now, byJobId, note, reason: current.error }
  const marked: Attempt = {
    ...current,
    ...changed,
    settledAt: current.settledAt ?? now,
    resolution: [...(current.resolution ?? []), entry].slice(-MARKS_LIMIT),
  }
  const attempts = state.attempts.map((a, i) => (i === target.index ? marked : a))
  const next = rollUp(attempts)
  const dispatch: Post['dispatch'] = {
    ...post.dispatch,
    [platform]: withSummary({ ...state, attempts, state: next, note: platformNote(next, attempts, state.note) }),
  }
  return { ok: true, post: { ...post, dispatch }, attempt: marked, from: current.state, manual: current.manual === true }
}

/** Was this attempt set by hand — a manual attempt, or one with any mark on it? */
export function markedByHand(attempt: Pick<Attempt, 'manual' | 'resolution'>): boolean {
  return attempt.manual === true || (attempt.resolution?.length ?? 0) > 0
}

/**
 * The same post with every platform's phone names and summary line brought up
 * to date — or `null` when nothing moved.
 *
 * Pure, and the router's whole "keep the screen honest" pass. It is what
 * back-fills a row written by an older build (no names, no summary) and what
 * follows a phone that has since been renamed, without touching a single
 * dispatch decision: states, attempts, counts and notes come through
 * untouched, and only the two display fields can change.
 *
 * Walks `dispatch`'s own keys rather than `post.platforms`, so a platform
 * dropped from the post's list still gets a readable cell — it has already run
 * somewhere, and the row still shows it.
 */
export function refreshPost(post: Post, names: ReadonlyMap<string, string>): Post | null {
  const dispatch: Post['dispatch'] = { ...post.dispatch }
  let changed = false
  for (const [platformId, stored] of Object.entries(post.dispatch)) {
    const next = withSummary(withDeviceNames(stored, names))
    if (next === stored) continue
    dispatch[platformId] = next
    changed = true
  }
  return changed ? { ...post, dispatch } : null
}

/** A device as the router needs it — the subset of `device.list`'s output this module reads, nothing more. */
export interface RouterDevice {
  id: string
  stableId: string
  status: string
  activities: readonly { kind: string }[]
  labels: readonly { name: string }[]
  /** `device.list`'s `inUse` (0.24.0). Optional: a farm older than the field sends none, and the router then decides on `activities` alone. */
  inUse?: { control: boolean; viewers: number }
  /** Present while the tail after a control marker lasts — the quiet period after someone stopped using the phone. */
  lastControl?: { endedAt: number } | null
}

export interface PlannedDispatch {
  platform: PlatformId
  /** The member to run, already resolved from the platform table — never re-derived by the caller. */
  script: string
  deviceId: string
  stableId: string
}

export interface DispatchPlan {
  /** One entry per job to fire. Empty is the normal steady state. */
  dispatches: PlannedDispatch[]
  /** The platform states to write back, keyed by platform id. Only the platforms that CHANGED appear. */
  states: Partial<Record<PlatformId, PlatformState>>
  /**
   * The post-level `lastNote` to store — the first thing worth telling the
   * operator across every platform, or null when there is nothing to say.
   * Separate from `states` because it changes even when no platform state
   * does: a note is the reason a post is standing still.
   */
  note: string | null
}

/**
 * Is this phone free to take a post job right now?
 *
 * Read straight off `device.list`'s own fields, exactly as the TikTok pack's
 * auto-post tick does: an `activities` entry of any kind means something is
 * already happening on the phone (a job, an operator holding Device Control),
 * and queueing behind it is how a fleet ends up with six posts stacked on one
 * device while five sit idle. `job.list` is deliberately not consulted —
 * `activities` already answers this, and asking for a permission the plugin
 * does not need is a permission the operator is shown at install for nothing.
 *
 * `activities` is not the whole answer, though (0.24.0, owner field report
 * 2026-09-15). A `control` marker lives only while input flows, so a phone an
 * operator has open in Device Control and is merely watching carried no
 * activity and was handed a post. `inUse` says who is looking, and a
 * `lastControl` tail is a quiet period after someone stopped.
 */
export function isDeviceFree(device: RouterDevice): boolean {
  return device.status === 'online' && device.activities.length === 0 && !isDeviceInUse(device)
}

/** Someone is controlling or watching the phone in Device Control, or stopped only moments ago. */
export function isDeviceInUse(device: Pick<RouterDevice, 'inUse' | 'lastControl'>): boolean {
  if (device.inUse?.control === true) return true
  if ((device.inUse?.viewers ?? 0) > 0) return true
  return device.lastControl !== undefined && device.lastControl !== null
}

/**
 * Decide what to dispatch for ONE post, given the fleet as it is right now.
 *
 * Pure and total: it never throws, never calls anything, and returns the empty
 * plan for a post with nothing to do. `now` is passed in rather than read from
 * `Date` so a test can assert the recorded timestamp instead of tolerating it.
 *
 * `maxDevicesPerPlatform` bounds one tick's blast radius. A farm with eighty
 * idle phones and one new video would otherwise fire eighty upload jobs in a
 * single tick — every one of them launching the same app, on the same network,
 * within the same second, which is both a thundering herd and the least
 * human-shaped thing this codebase could do.
 */
export function planDispatch(input: {
  post: Post
  devices: readonly RouterDevice[]
  now: number
  maxDevicesPerPlatform: number
  /**
   * Phones that already have a Social job this tick or one still queued or running from an earlier
   * tick (0.25.0). Kept apart from `devices` rather than filtered out of it, so a row waiting for its
   * own phone reads "busy", never "not connected any more".
   */
  busy?: ReadonlySet<string>
}): DispatchPlan {
  const { post, devices, now, maxDevicesPerPlatform } = input
  const busy = input.busy ?? new Set<string>()
  const plan: DispatchPlan = { dispatches: [], states: {}, note: null }
  // The first explanation any platform produces this tick wins the post-level
  // note. First rather than last, and rather than a joined list of all of
  // them: the platforms are walked in the post's own canonical order, so the
  // sentence an operator reads is stable between ticks instead of reshuffling
  // whenever one platform's situation changes.
  const noteOnce = (text: string): void => {
    if (plan.note === null) plan.note = text
  }
  /*
    One job per phone at a time (0.25.0). A row whose phone posts to TikTok, YouTube and Instagram
    used to send all three in the same tick; the farm ran them one after another, but the table said
    "Running" for all three and the later ones sat queued on the phone. Now a phone that takes a
    platform here is busy for the rest of this row, and the next platform goes once it is free.
  */
  const taken = new Set<string>()

  for (const platformId of post.platforms) {
    const current = stateFor(post, platformId)
    /*
      Anything that has already been handed to phones is left alone by the
      ROUTER, whatever its outcome.

      `dispatched` is still in flight. But `succeeded`, `partial` and `failed`
      are equally final here, and `failed` deliberately so: re-posting the same
      video to the same accounts is not a retry, it is a duplicate post, and it
      is the one failure mode nobody can undo from here. A retry is a decision,
      so it belongs to an operator pressing "Re-run failed" — which re-targets
      only the phones that failed (`failedDevices`) — and never to a timer that
      finds a red row and tries again on its own.
    */
    if (current.state === 'dispatched' || current.state === 'succeeded' || current.state === 'partial' || current.state === 'failed') {
      continue
    }

    const platform = platformById(platformId)
    if (!platform) {
      // A platform id stored by some other build. Recorded, never guessed at.
      const note = `This build does not know a platform called "${platformId}".`
      plan.states[platformId] = withSummary({ state: 'unsupported', at: now, deviceCount: 0, attempts: [], history: current.history, note, summary: null })
      noteOnce(note)
      continue
    }

    if (platform.script === null) {
      // Write the reason once and leave it. Rewriting an unchanged state every
      // tick would bump `updatedAt` on the row forever and make the Posts table
      // look permanently busy.
      if (current.state !== 'unsupported') {
        plan.states[platformId] = withSummary({ state: 'unsupported', at: now, deviceCount: 0, attempts: [], history: current.history, note: platform.unsupportedReason, summary: null })
      }
      // Noted every tick even when the STATE is unchanged: the state is
      // written once and the note is what the operator actually reads, so a
      // post whose only remaining platform cannot post must keep saying so.
      if (platform.unsupportedReason !== null) noteOnce(`${platform.title} — ${platform.unsupportedReason}`)
      continue
    }

    /*
      Who may post, decided by who chose.

      - **No phones chosen** (`deviceIds` empty): the platform's LABEL is the
        fleet. The label is the operator's standing statement "this phone
        holds a TikTok account", and it is the only statement there is.
      - **Phones chosen**: those phones ARE the statement. The Social posts
        page asks for the platforms and the phones in one form, so choosing
        both already says "these phones post to these platforms". Requiring a
        separate label on top made that choice silently worthless — measured
        on the owner's production farm, 2026-09-14: a started session of five
        videos over hand-picked, unlabelled phones sat at "Waiting for a phone"
        for twenty minutes with nothing sent and nothing anyone could see
        fail. A chosen phone that is NOT signed in to the platform fails its
        upload by name and can be retried, which is the honest outcome; a
        post that can never send is not.

      This used to read "chosen phones narrow the label's fleet, never widen
      it" (0.4.x). It is widened here on purpose, and only for rows that name
      their phones.
    */
    const assigned = post.assignedDeviceId
    const explicit = assigned !== null || post.deviceIds.length > 0
    const allowed = assigned !== null ? devices.filter((d) => d.id === assigned) : explicit ? devices.filter((d) => post.deviceIds.includes(d.id)) : devices
    const eligible = allowed.filter((d) => isDeviceFree(d) && !busy.has(d.id) && !taken.has(d.id) && (explicit || deviceCarriesPlatform(d.labels, platform)))
    if (eligible.length === 0) {
      const note = assigned !== null
        ? allowed.length === 0
          ? `This video's phone is not connected to the farm any more. It waits for that phone — it is never sent to another one.`
          : `Waiting for this video's phone, which is offline or busy.`
        : explicit
        ? allowed.length === 0
          ? `None of the phones chosen for this post is connected to the farm any more. Reconnect one, or choose other phones.`
          : `Every phone chosen for this post is offline or busy. Waiting.`
        : devices.some((d) => deviceCarriesPlatform(d.labels, platform))
        ? `Every phone labelled "${platform.label}" is offline or busy. Waiting.`
        : `No phone carries the "${platform.label}" label yet. Add it on the Devices screen and this will send itself.`
      // Only write when the WORDING changes — the two notes above distinguish
      // "you have not labelled anything" from "they are all busy", which is the
      // difference between a setup mistake and a normal, self-resolving wait.
      if (current.state !== 'pending' || current.note !== note) {
        plan.states[platformId] = withSummary({ state: 'pending', at: null, deviceCount: 0, attempts: [], history: current.history, note, summary: null })
      }
      noteOnce(note)
      continue
    }

    /*
      The row's own cap wins over the farm's. `maxDevices: 1` is what a group
      spread "one video per phone" stores, and it is the whole mechanism: this
      row takes one free phone, the router's `claimed` set removes that phone
      from the pool, and the next row takes the next one.
    */
    const cap = post.maxDevices ?? maxDevicesPerPlatform
    const chosen = eligible.slice(0, Math.max(1, cap))
    for (const device of chosen) {
      taken.add(device.id)
      plan.dispatches.push({ platform: platformId, script: platform.script, deviceId: device.id, stableId: device.stableId })
    }
    const capped = chosen.length < eligible.length ? `Sent to ${chosen.length} of ${eligible.length} eligible phones (per-tick cap).` : null
    /*
      `attempts` is empty HERE and filled by the caller, because this function
      is pure and a job id does not exist until the job is enqueued. The
      service writes the state once, after the fan-out, with one attempt per
      job it actually got an id for — so a phone whose enqueue threw never
      appears as an attempt that silently never resolves.

      `summary` is null here for the same reason and is filled by the same
      caller (`withSummary`, once the attempts are in): a line naming the
      phones cannot be written before it is known which phones took the job.
    */
    plan.states[platformId] = { state: 'dispatched', at: now, deviceCount: chosen.length, attempts: [], history: current.history, note: capped, summary: null }
    if (capped !== null) noteOnce(capped)
  }

  return plan
}

/** A fresh post, every targeted platform seeded `pending`. Used by the `add-post` member and by the tests. */
export function newPost(input: { videoArtifactId: string; caption: string; platforms: PlatformId[]; deviceIds?: string[]; now: number }): Post {
  // Deduplicated and ordered by the canonical list rather than by whatever
  // order the form produced, so two identical posts compare equal and the
  // Posts table never shows the same fleet in two different orders.
  const platforms = PLATFORM_IDS.filter((id) => input.platforms.includes(id))
  const dispatch: Record<string, PlatformState> = {}
  // Seeded rather than left empty — see `PostSchema.dispatch`. A targeted
  // platform must be visibly waiting from the moment the post is created,
  // not from the first router tick.
  for (const id of platforms) dispatch[id] = { ...PENDING_STATE }
  // `PENDING_STATE` already carries its own summary line, so a brand new post
  // reads "Waiting for a phone" the moment it is stored — before the router
  // has ever looked at it, and whether or not the service is even running.
  return {
    version: 1,
    videoArtifactId: input.videoArtifactId,
    caption: input.caption,
    platforms,
    // Deduplicated for the same reason as `platforms`: a picker that let the
    // same phone in twice would double its weight in `allowed`.
    deviceIds: [...new Set(input.deviceIds ?? [])],
    createdAt: input.now,
    dispatch,
    groupId: null,
    notBeforeAt: null,
    maxDevices: null,
    assignedDeviceId: null,
    lastNote: null,
    hashtags: [],
    hashtagLine: null,
  }
}

/** What `pickAssignment` needs to know about the fleet. */
export interface AssignableDevice {
  id: string
  labels: readonly { name: string }[]
}

/**
 * SUGGEST a phone for a one-video-per-phone row that has none (0.12.0). It never binds one.
 *
 * New sessions are paired when they are created (`add-group`). A row created before pairing existed —
 * the owner's production session among them — is NOT bound automatically: its history is exactly
 * the tangle pairing exists to prevent (#21 carrying three videos, one video on two phones), and a
 * guess over that data can be wrong in ways that post to a real account. The owner's own read of
 * the upgrade was the right one: those rows show no phone, the operator chooses one with Edit, and
 * until then the row is held and never sent. This function only writes the suggestion into the
 * held row's note. Its rules, in order:
 *
 * 1. **Where it already landed.** The phone of the row's earliest attempt that did not fail — else
 *    of its earliest attempt at all — unless another row of the session owns that phone.
 * 2. **A phone nobody in the session owns**, from the row's chosen phones (or, when it named none,
 *    every phone carrying one of its platforms' labels), sorted by id so the answer is stable.
 * 3. **None left** — no suggestion, and a sentence saying so.
 *
 * "Owns" is `sessionOwner`: exactly ONE phone per row, so a legacy row that touched two phones does
 * not use up two of the session's phones.
 */
export function pickAssignment(input: {
  post: Pick<Post, 'deviceIds' | 'platforms' | 'dispatch'>
  /** Phones owned by OTHER rows of the same session. */
  ownedByOthers: ReadonlySet<string>
  fleet: readonly AssignableDevice[]
  /** How many rows and phones the session has, for the sentence when none is left. */
  sessionVideos: number
}): { deviceId: string | null; reason: string | null } {
  const { post, ownedByOthers, fleet } = input
  const tried = post.platforms
    .flatMap((id) => {
      const state = post.dispatch[id]
      return state ? [...(state.history ?? []), ...(state.attempts ?? [])] : []
    })
    .sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER))
  const landed = tried.find((a) => a.state !== 'failed')?.deviceId
  if (landed !== undefined && !ownedByOthers.has(landed)) return { deviceId: landed, reason: null }
  const first = tried[0]?.deviceId
  if (first !== undefined && !ownedByOthers.has(first)) return { deviceId: first, reason: null }

  const pool =
    post.deviceIds.length > 0
      ? [...new Set(post.deviceIds)]
      : fleet
          .filter((d) => post.platforms.some((id) => {
            const platform = platformById(id)
            return platform !== null && deviceCarriesPlatform(d.labels, platform)
          }))
          .map((d) => d.id)
  const free = pool.filter((id) => !ownedByOthers.has(id)).sort()
  if (free.length > 0) return { deviceId: free[0] as string, reason: null }
  return {
    deviceId: null,
    reason: `No phone is left for this video: this session has ${input.sessionVideos} videos and ${pool.length} phone${pool.length === 1 ? '' : 's'}, and every phone already has a video. It is not sent to a phone that has one — add a phone to the session, or remove a video.`,
  }
}

/** What an operator may change about a video after its session was created (0.12.0). */
export interface PostEdit {
  assignedDeviceId?: string
  platforms?: PlatformId[]
  caption?: string
  /** The video's own hashtags; normalised on the way in. */
  hashtags?: string[]
}

/** The start of the note on a row held for having nothing to post. The session page matches on it, so it is exported. */
export const NO_CAPTION_YET = 'No caption yet'

export type PostEditOutcome = { ok: true; post: Post; changed: string[]; warnings: string[] } | { ok: false; code: 'E_PARAMS_INVALID'; message: string }

/**
 * Apply an operator's edit to one video of a session — or refuse it, by name.
 *
 * The owner's words: a video that has gone into a session must still be editable — its phone, its
 * platforms — so that a retry uses the new choice. Pure, so the rules below are pinned by tests and
 * the member that stores the result (`update-post`) has nothing to decide.
 *
 * Two situations WARN rather than refuse — the owner's call: an operator may genuinely mean to
 * re-upload, or to put a second video on a phone, and a hard block would stop a deliberate choice.
 *
 * - **While it is uploading.** A current attempt still `queued` means a phone is mid-upload. The
 *   running job keeps the parameters it started with; the edit applies to the next attempt. Said.
 * - **A phone another video has.** The new phone is owned by another video of the same session —
 *   its assigned phone, or the phone of an attempt of it that did not fail. Allowed, and the warning
 *   names that video, because both will now post from that phone.
 * - **What posted stays posted.** Nothing about an existing platform's record is rewritten. A new
 *   platform is seeded waiting, and goes out at the video's next turn; a removed platform keeps its
 *   record and is simply no longer sent. Failed attempts are NOT re-sent by an edit — that is still
 *   the operator's explicit Retry, which now goes to the new phone.
 */
export function applyPostEdit(input: { post: Post; edit: PostEdit; sessionRows: readonly Post[] }): PostEditOutcome {
  const { post, edit } = input
  const warnings: string[] = []
  const running = post.platforms.flatMap((id) => (post.dispatch[id]?.attempts ?? []).filter((a) => a.state === 'queued'))
  if (running.length > 0) {
    const phone = attemptPhone(running[0] as Attempt)
    warnings.push(`This video is uploading on ${phone} right now. That upload continues as it started; this change applies to the next attempt.`)
  }

  let next: Post = post
  const changed: string[] = []

  if (edit.assignedDeviceId !== undefined && edit.assignedDeviceId !== post.assignedDeviceId) {
    if (post.groupId === null || post.maxDevices !== 1) {
      return { ok: false, code: 'E_PARAMS_INVALID', message: 'Only a video in a one-video-per-phone session has a phone of its own to change.' }
    }
    const wanted = edit.assignedDeviceId
    const owner = input.sessionRows.find(
      (row) =>
        row.videoArtifactId !== post.videoArtifactId &&
        row.groupId === post.groupId &&
        (row.assignedDeviceId === wanted || row.platforms.some((id) => (row.dispatch[id]?.attempts ?? []).some((a) => a.deviceId === wanted && a.state !== 'failed'))),
    )
    if (owner) {
      const label = owner.caption === '' ? owner.videoArtifactId.slice(0, 8) : owner.caption.length > 40 ? `${owner.caption.slice(0, 40)}…` : owner.caption
      warnings.push(`That phone already has another video of this session ("${label}"). Both videos will post from it.`)
    }
    next = { ...next, assignedDeviceId: wanted }
    changed.push('phone')
  }

  if (edit.platforms !== undefined) {
    const platforms = PLATFORM_IDS.filter((id) => edit.platforms?.includes(id))
    if (platforms.length === 0) return { ok: false, code: 'E_PARAMS_INVALID', message: 'A video needs at least one platform.' }
    if (platforms.join(',') !== post.platforms.join(',')) {
      const dispatch: Post['dispatch'] = { ...next.dispatch }
      for (const id of platforms) if (!dispatch[id]) dispatch[id] = { ...PENDING_STATE }
      next = { ...next, platforms, dispatch }
      changed.push('platforms')
    }
  }

  if (edit.hashtags !== undefined) {
    const hashtags = normalizeHashtags(edit.hashtags).slice(0, 30)
    if (hashtags.join(' ') !== post.hashtags.join(' ')) {
      next = { ...next, hashtags }
      changed.push('hashtags')
    }
  }

  if (edit.caption !== undefined) {
    const caption = edit.caption.trim()
    if (caption.length > 2_200) return { ok: false, code: 'E_PARAMS_INVALID', message: 'A caption can be at most 2200 characters.' }
    // Allowed, with a warning (the owner's rule for edits: warn, never refuse). The session's own hashtags may still
    // give the video something to post; if nothing does, the router holds the row (`NO_CAPTION_YET`) rather than send an
    // empty text the direct upload path refuses.
    if (caption.length === 0 && next.hashtags.length === 0) {
      warnings.push('This video now has no caption and no hashtags of its own. It posts with the session\'s hashtags if the session has any; otherwise it waits until you write one.')
    }
    if (caption !== post.caption) {
      next = { ...next, caption }
      changed.push('caption')
    }
  }

  return { ok: true, post: next, changed, warnings }
}

/**
 * The ONE phone a row of a session owns, for deciding what is free (0.12.0): its assigned phone;
 * for a row with none, the phone of its earliest attempt that did not fail (where something may
 * have landed on that account); otherwise none. One per row on purpose — see `pickAssignment`.
 */
export function sessionOwner(post: Pick<Post, 'assignedDeviceId' | 'platforms' | 'dispatch'>): string | null {
  if (post.assignedDeviceId !== null) return post.assignedDeviceId
  const landed = post.platforms
    .flatMap((id) => [...(post.dispatch[id]?.history ?? []), ...(post.dispatch[id]?.attempts ?? [])])
    .filter((a) => a.state !== 'failed')
    .sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER))
  return landed[0]?.deviceId ?? null
}

/** The start of the held row's note. The session page matches on it, so it is exported, never paraphrased. */
export const NO_PHONE_ASSIGNED = 'No phone is assigned to this video'

/**
 * The sentence a held, unassigned one-per-phone row carries (0.12.0): that it is not sent until an
 * operator chooses its phone, and — when there is one — which phone `pickAssignment` suggests.
 * `names` turns a device id into the name the operator reads.
 */
export function unassignedNote(
  pick: { deviceId: string | null; reason: string | null },
  names: ReadonlyMap<string, string>,
): string {
  const head = `${NO_PHONE_ASSIGNED}, so it is not sent. Edit it to choose one.`
  if (pick.deviceId !== null) return `${head} Suggested: ${names.get(pick.deviceId) ?? pick.deviceId} — where it ran before, and no other video of this session has it.`
  return `${head} ${pick.reason ?? ''}`.trim()
}
