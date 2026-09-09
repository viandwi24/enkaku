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
export const DISPATCH_STATES = ['pending', 'dispatched', 'unsupported'] as const
export type DispatchState = (typeof DISPATCH_STATES)[number]

export const PlatformStateSchema = z
  .object({
    state: z.enum(DISPATCH_STATES),
    /** Unix seconds of the dispatch, or null while nothing has been dispatched. */
    at: z.number().int().nonnegative().nullable(),
    /** How many phones this post was dispatched to on this platform. */
    deviceCount: z.number().int().nonnegative(),
    /** Why it is in this state, shown verbatim in the Posts table. Null when there is nothing to explain. */
    note: z.string().max(500).nullable(),
  })
  .strict()
export type PlatformState = z.infer<typeof PlatformStateSchema>

export const PENDING_STATE: PlatformState = { state: 'pending', at: null, deviceCount: 0, note: null }

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

export function stateFor(post: Post, platform: PlatformId): PlatformState {
  return post.dispatch[platform] ?? PENDING_STATE
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
    if (s.state === 'dispatched') return `${title}: sent to ${s.deviceCount}`
    if (s.state === 'unsupported') return `${title}: unsupported`
    return `${title}: waiting`
  })
  return parts.join(' · ')
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
    // Already sent. A post is dispatched once per platform and never
    // re-dispatched by the router: re-posting the same video to the same
    // accounts is not a retry, it is a duplicate post, and it is the one
    // failure mode nobody can undo from here.
    if (current.state === 'dispatched') continue

    const platform = platformById(platformId)
    if (!platform) {
      // A platform id stored by some other build. Recorded, never guessed at.
      const note = `This build does not know a platform called "${platformId}".`
      plan.states[platformId] = { state: 'unsupported', at: now, deviceCount: 0, note }
      noteOnce(note)
      continue
    }

    if (platform.script === null) {
      // Write the reason once and leave it. Rewriting an unchanged state every
      // tick would bump `updatedAt` on the row forever and make the Posts table
      // look permanently busy.
      if (current.state !== 'unsupported') {
        plan.states[platformId] = { state: 'unsupported', at: now, deviceCount: 0, note: platform.unsupportedReason }
      }
      // Noted every tick even when the STATE is unchanged: the state is
      // written once and the note is what the operator actually reads, so a
      // post whose only remaining platform cannot post must keep saying so.
      if (platform.unsupportedReason !== null) noteOnce(`${platform.title} — ${platform.unsupportedReason}`)
      continue
    }

    const eligible = devices.filter((d) => isDeviceFree(d) && deviceCarriesPlatform(d.labels, platform))
    if (eligible.length === 0) {
      const note = devices.some((d) => deviceCarriesPlatform(d.labels, platform))
        ? `Every phone labelled "${platform.label}" is offline or busy. Waiting.`
        : `No phone carries the "${platform.label}" label yet. Add it on the Devices screen and this will send itself.`
      // Only write when the WORDING changes — the two notes above distinguish
      // "you have not labelled anything" from "they are all busy", which is the
      // difference between a setup mistake and a normal, self-resolving wait.
      if (current.state !== 'pending' || current.note !== note) {
        plan.states[platformId] = { state: 'pending', at: null, deviceCount: 0, note }
      }
      noteOnce(note)
      continue
    }

    const chosen = eligible.slice(0, Math.max(1, maxDevicesPerPlatform))
    for (const device of chosen) {
      plan.dispatches.push({ platform: platformId, script: platform.script, deviceId: device.id, stableId: device.stableId })
    }
    const capped = chosen.length < eligible.length ? `Sent to ${chosen.length} of ${eligible.length} eligible phones (per-tick cap).` : null
    plan.states[platformId] = { state: 'dispatched', at: now, deviceCount: chosen.length, note: capped }
    if (capped !== null) noteOnce(capped)
  }

  return plan
}

/** A fresh post, every targeted platform seeded `pending`. Used by the `add-post` member and by the tests. */
export function newPost(input: { videoArtifactId: string; caption: string; platforms: PlatformId[]; now: number }): Post {
  // Deduplicated and ordered by the canonical list rather than by whatever
  // order the form produced, so two identical posts compare equal and the
  // Posts table never shows the same fleet in two different orders.
  const platforms = PLATFORM_IDS.filter((id) => input.platforms.includes(id))
  const dispatch: Record<string, PlatformState> = {}
  // Seeded rather than left empty — see `PostSchema.dispatch`. A targeted
  // platform must be visibly waiting from the moment the post is created,
  // not from the first router tick.
  for (const id of platforms) dispatch[id] = { ...PENDING_STATE }
  return {
    version: 1,
    videoArtifactId: input.videoArtifactId,
    caption: input.caption,
    platforms,
    createdAt: input.now,
    dispatch,
    lastNote: null,
  }
}
