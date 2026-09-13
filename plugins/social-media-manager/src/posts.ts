import { z } from 'zod'
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

/**
 * One phone's attempt at one post, on one platform.
 *
 * The `jobId` is the whole point: it is the only link from a post back to what
 * the farm actually did, and without it "re-run the ones that failed" cannot
 * be answered at all. `deviceId` is stored beside it so a retry can target the
 * same phones without re-deriving them from a fleet that has moved on.
 */
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
    /** The job's own error, when it failed. Truncated — the full text is on the job itself. */
    error: z.string().max(300).nullable(),
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
  // not a success, and it must not be worded as one.
  unverified: 'unverified',
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
  if (unsure > 0) parts.push(`${unsure} unverified`)
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

export const PENDING_STATE: PlatformState = withSummary({ state: 'pending', at: null, deviceCount: 0, attempts: [], note: null, summary: null })

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
    caption: z.string().min(1).max(2_200),
    /** Which platforms this video is for. Empty is legal and simply never dispatches. */
    platforms: z.array(PlatformIdSchema),
    /**
     * Which phones this post may go to, or EMPTY for "any phone carrying the
     * platform's label".
     *
     * Empty is the default and the original behaviour: the label decides, and
     * a phone labelled later is picked up with no edit. A non-empty list
     * narrows that — it never widens it. A device named here that does not
     * carry the platform's label is still not eligible, because the label is
     * what says "this phone posts to Instagram" and a device picker is not a
     * way to overrule it.
     *
     * Defaulted so a row written before this field existed still parses, and
     * parses as "any", which is what those posts meant.
     */
    deviceIds: z.array(z.string().min(1)).default([]),
    createdAt: z.number().int().nonnegative(),
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
        return `${title}: ${ok} posted, ${bad} failed${unsure > 0 ? `, ${unsure} unverified` : ''}`
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
 */
export function isDeviceFree(device: RouterDevice): boolean {
  return device.status === 'online' && device.activities.length === 0
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
}): DispatchPlan {
  const { post, devices, now, maxDevicesPerPlatform } = input
  const plan: DispatchPlan = { dispatches: [], states: {}, note: null }
  // The first explanation any platform produces this tick wins the post-level
  // note. First rather than last, and rather than a joined list of all of
  // them: the platforms are walked in the post's own canonical order, so the
  // sentence an operator reads is stable between ticks instead of reshuffling
  // whenever one platform's situation changes.
  const noteOnce = (text: string): void => {
    if (plan.note === null) plan.note = text
  }

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
      plan.states[platformId] = withSummary({ state: 'unsupported', at: now, deviceCount: 0, attempts: [], note, summary: null })
      noteOnce(note)
      continue
    }

    if (platform.script === null) {
      // Write the reason once and leave it. Rewriting an unchanged state every
      // tick would bump `updatedAt` on the row forever and make the Posts table
      // look permanently busy.
      if (current.state !== 'unsupported') {
        plan.states[platformId] = withSummary({ state: 'unsupported', at: now, deviceCount: 0, attempts: [], note: platform.unsupportedReason, summary: null })
      }
      // Noted every tick even when the STATE is unchanged: the state is
      // written once and the note is what the operator actually reads, so a
      // post whose only remaining platform cannot post must keep saying so.
      if (platform.unsupportedReason !== null) noteOnce(`${platform.title} — ${platform.unsupportedReason}`)
      continue
    }

    /*
      The operator's chosen phones NARROW the label's fleet; they never widen
      it. A device picked here that does not carry the platform's label is
      still not eligible — the label is what says "this phone posts to
      Instagram", and a picker is not a way to overrule it. An empty list
      means "any", which is what every post written before the picker existed
      meant.
    */
    const allowed = post.deviceIds.length === 0 ? devices : devices.filter((d) => post.deviceIds.includes(d.id))
    const eligible = allowed.filter((d) => isDeviceFree(d) && deviceCarriesPlatform(d.labels, platform))
    if (eligible.length === 0) {
      const note = post.deviceIds.length > 0 && !allowed.some((d) => deviceCarriesPlatform(d.labels, platform))
        ? `None of the phones chosen for this post carries the "${platform.label}" label, so it can never send. Either label one of them or widen the choice.`
        : allowed.some((d) => deviceCarriesPlatform(d.labels, platform))
        ? `Every phone labelled "${platform.label}" is offline or busy. Waiting.`
        : `No phone carries the "${platform.label}" label yet. Add it on the Devices screen and this will send itself.`
      // Only write when the WORDING changes — the two notes above distinguish
      // "you have not labelled anything" from "they are all busy", which is the
      // difference between a setup mistake and a normal, self-resolving wait.
      if (current.state !== 'pending' || current.note !== note) {
        plan.states[platformId] = withSummary({ state: 'pending', at: null, deviceCount: 0, attempts: [], note, summary: null })
      }
      noteOnce(note)
      continue
    }

    const chosen = eligible.slice(0, Math.max(1, maxDevicesPerPlatform))
    for (const device of chosen) {
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
    plan.states[platformId] = { state: 'dispatched', at: now, deviceCount: chosen.length, attempts: [], note: capped, summary: null }
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
    lastNote: null,
  }
}
