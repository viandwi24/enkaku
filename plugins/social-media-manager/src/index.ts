import { definePlugin, defineService, type PluginServiceContext } from '@enkaku/sdk'
import { PLUGIN_UI_API_VERSION } from '@enkaku/protocol'
import { z } from 'zod'
import addPost from './add-post'
import addPosts from './add-posts'
import addGroup from './add-group'
import startGroup from './start-group'
import retryGroup from './retry-group'
import updatePost from './update-post'
import { warmupRotation } from './workflows/warmup-rotation'
import { GROUP_PREFIX, GroupSchema, groupKeyFor, isRowDue, roomInFlight, withProgress, type Group, type RowState } from './groups'
import retryFailed from './retry-failed'
import { PLATFORMS, PLATFORM_IDS } from './platforms'
import {
  POST_PREFIX,
  PostSchema,
  deviceDisplayName,
  planDispatch,
  postSummary,
  refreshPost,
  rollUp,
  nextRound,
  pickAssignment,
  sessionOwner,
  stateFor,
  unassignedNote,
  withSummary,
  type Attempt,
  type Post,
  type RouterDevice,
} from './posts'

/**
 * # Social Media Manager
 *
 * Upload a video once, say which platforms it is for, and let the farm send it
 * to every phone that carries each platform's label.
 *
 * ## What this plugin is, structurally
 *
 * It is **policy over primitives the farm already has**, and it adds nothing to
 * the core — no table, no column, no migration, no new concept in the product:
 *
 * | what it needs | what it uses | whose it is |
 * |---|---|---|
 * | somewhere to store a post | `ctx.storage.global` (`kv_entries`) | the farm's generic KV |
 * | "this phone posts to Instagram" | device **labels** | the farm's generic many-to-many |
 * | "run this on that phone" | `job.run` | the farm's generic dispatch |
 * | the actual upload flow | each platform pack's own member | that pack |
 *
 * That is the whole design, and it is the reason this could be built as a
 * plugin at all. The one thing a platform genuinely needs code for — walking
 * its app's upload screens — stays in that platform's own pack, where its
 * selectors sit beside the hardware dumps they were read from.
 *
 * ## The honest state of it
 *
 * The router works and is tested. **TikTok and YouTube can post today**: both
 * packs' upload flows were walked on real hardware and every anchor in them was
 * measured there. Instagram has a pack and no upload flow, and this plugin says
 * so by name — the page offers it as "no upload flow yet" rather than routing to
 * it and reporting a success nothing performed. See `platforms.ts` for why
 * writing those selectors from memory would be worse than not having them.
 *
 * ## Changelog
 *
 * - **0.12.0 — one video, one phone; and a session page that says what is
 *   happening now.** Two production findings (2026-09-14):
 *
 *   1. "One video per phone" only meant each video went to one phone — WHICH
 *      phone was whoever was free when the video's turn came. A five-video,
 *      five-phone session put three videos on #21, and a retry sent a video to
 *      a phone that had already posted another. Now each video is bound to
 *      exactly one phone (`Post.assignedDeviceId`), paired randomly when the
 *      session is created (`add-group`). Every platform and every retry of that
 *      video goes to that phone. A row made before pairing existed is NOT
 *      guessed at — its history is the very tangle pairing prevents — so it is
 *      held, never sent, with a note suggesting a phone (`pickAssignment`,
 *      one owner per row via `sessionOwner`), until the operator chooses one
 *      with Edit. Nothing about such a row needs migrating: every new field
 *      defaults (no phone, empty history, round 1), and the row is rewritten in
 *      the new shape the first time the router touches it. The compose page says so up front instead of promising the extra
 *      videos would "wait for a phone to come free".
 *   2. The owner could not tell what was running, how far it had got, or
 *      whether an error was this run's or an earlier one. Attempts now record
 *      when they were sent and settled and which round they are, and a retry
 *      moves the failures it replaces into `history` instead of deleting them.
 *      The session page is a table built on those facts.
 *   3. A video already in a session can be edited — its phone, platforms and
 *      caption — through the new `update-post` member (rules in `posts.ts`
 *      `applyPostEdit`): refused while it is uploading or when the phone
 *      belongs to another video; what posted stays posted; the next attempt,
 *      or the operator's Retry failed, uses the new choice.
 *
 * - **0.11.0 — phones you choose are phones that post.** A session over phones
 *   chosen on the Social posts page (by name, or by a label such as "test 5")
 *   also needed each phone to carry the PLATFORM label (`tiktok`, `youtube`)
 *   before the router would send to it — the old "a choice narrows the
 *   label's fleet, never widens it" rule. The page asks for platforms and
 *   phones in one form, so that rule made the choice silently worthless: on
 *   the owner's production farm (2026-09-14) a started session of five videos
 *   over five "test 5" phones sent nothing and showed no failure, only
 *   "Waiting for a phone" on every row. Now a row that names its phones sends
 *   to those phones as they are; the platform label decides only when no
 *   phone is named. A chosen phone not signed in to the platform fails its
 *   upload by name and can be retried. And the page refuses to create a
 *   session that resolves to no phone at all — that was a warning, and a
 *   warning is not read by someone pressing Create and start.
 *
 * - **0.10.0 — ships the warm-up rotation as a workflow.** The three-platform
 *   warm-up the owner built in Studio (plan 314: `($device.number + slot) % 3`
 *   chooses TikTok, Instagram or YouTube per session, each branch shuffling
 *   that platform's activities) now ships with this plugin as
 *   `smm/warmup-rotation` (plan 315). Activating this version registers it on
 *   the farm, read-only; duplicate it to change it. Script refs are `@latest`
 *   because the platform packs version on their own.
 *
 * - **0.9.1 — tabs, and a page per session.** 0.9.0 put the whole job on one
 *   flat page: compose at the top, sessions underneath, each one expanding
 *   inline. With two sessions open that page could not be scanned, and the
 *   owner said so: *"ga bisa dibuat tabs aja kah biar rapih... dihalaman depan
 *   itu nampilin semua sesi atau grup, baru kalau di-details masing-masing sesi
 *   baru ada sub page nampilin list item"*. Still one sidebar entry — that part
 *   of 0.9.0 was right — now with two tabs (**Sessions**, **New session**) and
 *   a session that opens onto its own page: header, actions, then every video
 *   with every phone under it. Where you are lives in the URL (`?tab=`,
 *   `?session=`), so a reload lands where you were and one session is a link
 *   somebody can send.
 *
 *   It also ships the view's first stylesheet, and that is not cosmetic
 *   book-keeping: a plugin view inherits Studio's CSS, so any class Studio
 *   itself never writes was never GENERATED, and an ungenerated Tailwind class
 *   is silently nothing. `gap-x-1` resolved to `column-gap: normal` and a
 *   phone's name ran into its result — `#1 moto g06 powerpostedrun` — with no
 *   error anywhere. `src/ui/index.css` makes this pack's own classes real.
 *
 * - **0.9.0 — one screen for the whole job.** The plugin declared three views —
 *   a table of post rows, a table of sessions, a page listing platforms — and
 *   the owner's verdict after using them was that three menus for one job is
 *   three places to get lost: *"saya minta menunya sama aja jadi satu dong
 *   jangan dibedakan ada menu view page khusus untuk item post, untuk sesi dll
 *   jadi bingung user"*. They are now ONE React page (`src/ui/`), read top to
 *   bottom in the order the work happens: drop in forty files, watch them
 *   upload, pick the platforms, pick the phones (all labelled, by label, or by
 *   name), set the spread and the gaps, accept or replace the auto-generated
 *   title, Create or Create and start — then the sessions underneath, each
 *   expandable onto every video, every phone and every failure. Captions are
 *   written from the file names unless the operator types their own.
 *
 *   Three behavioural changes came with it, and each fixes something the old
 *   surface hid:
 *
 *   1. **A started session no longer consults the auto-post switch.** Pressing
 *      Start IS the consent, and the one screen has no such switch — a Start
 *      that quietly did nothing because of a setting nobody can see is the
 *      worst failure this plugin could have. Ungrouped rows (`add-post`,
 *      `add-posts`, which nothing starts) still wait for the timer, off by
 *      default, so a leftover row can never post itself on an upgrade.
 *   2. **Removing a session stops it.** The router refuses to dispatch a row
 *      whose session is gone. Before, an orphaned row read as unpaced and a
 *      deleted forty-video session would have fired all forty on the next tick.
 *   3. **The screen waits for what it asked for.** `run-script` answers when a
 *      job is ENQUEUED, so a member that then refused — forty videos and seven
 *      caption lines — left the screen saying "session created" with nothing
 *      created. The page now waits for the job's own verdict and shows the
 *      member's words, and reads the new session's id off its result rather
 *      than hunting for a row with the title it just typed.
 *
 *   No declared actions remain: they were buttons on tables that no longer
 *   exist, and the page calls the same members directly.
 *
 * - **0.8.0 — upload sessions: forty videos, forty phones, not all at once.**
 *   The farm this is built for loads a folder of videos, one per phone, and
 *   posts them as a batch. Three things were missing and are now here: a
 *   SESSION an operator names ("post hari Senin 14 Sep 2026"), watches as one
 *   thing and retries as one thing; a spread of ONE video per phone rather
 *   than every video to every labelled phone; and pacing, so forty phones do
 *   not light up in the same second — each video is stamped with its turn
 *   (drawn from a gap range, order shuffled or as listed) and the router
 *   sends it when the turn comes, never more than the session's "at once".
 *   Creating a session sends nothing; Start stamps the turns. Because the
 *   schedule is data on the rows, a plugin restart or a core restart resumes
 *   it. Group rows are considered on every poll rather than waiting for
 *   `intervalMinutes`, which would have rounded a 30-second gap up to the
 *   whole interval.
 *
 * - **0.7.0 — which phone, and the jobs behind the row.** The Posts table said
 *   `succeeded` and never WHERE, and a post's own jobs were unreachable from
 *   the row that caused them — the operator matched runs by timestamp on the
 *   Jobs screen. Three changes, all reading data the row already held:
 *
 *   1. Each platform cell is a sentence now, not a status word:
 *      `#3 moto g06 power · posted`, `2 phones · 1 posted, 1 failed`. Composed
 *      by `describePlatform` and stored as `dispatch.<platform>.summary`,
 *      because a tier-A column renders one stored path as text and has nowhere
 *      else to compose one. Every attempt records the phone's NAME as the farm
 *      gave it (`Attempt.deviceName`), so a phone since renamed, unplugged or
 *      removed still names itself.
 *   2. The row expands onto its jobs — one line per phone per platform, with
 *      the result, the error, and a link to the job the farm actually ran.
 *      This is the protocol's new `table.detail` (`@enkaku/protocol`), the
 *      smallest vocabulary that gives a tier-A row a real, clickable list;
 *      the alternative was a second screen the row could not link to.
 *   3. The timer settles on every poll, dispatches only when `enabled`. The
 *      two halves used to be one: with auto-posting off, a "Re-run failed"
 *      dispatched from the screen left its attempts `queued` forever and the
 *      platform pinned at `dispatched`, which is the disappearing act 0.2.0
 *      exists to end. Nothing is enqueued by the settling half.
 *
 * - **0.6.0 — YouTube posts.** The YouTube row of the platform table now names
 *   `youtube/post-video@latest` (youtube pack 0.20.0, walked on the owner's
 *   moto on 2026-09-11), so a post with YouTube ticked routes to phones
 *   labelled `youtube` exactly as TikTok does, and the row gains a
 *   "Post to YouTube now" action. Instagram still says why it cannot.
 *
 * - **0.5.0 — a green job is not a post.** The reconciler read the job's
 *   status and nothing else, so a TikTok run whose script returned
 *   `outcome: "unverified"` (the post was tapped, then TikTok's security
 *   check covered the profile and nothing could be confirmed) was written as
 *   "1 posted" on the owner's farm, 2026-09-11. It now reads the script's own
 *   `outcome`: `posted` is a success, `failed`/`skipped` is a retryable
 *   failure, and `unverified` is a new attempt state of its own — shown in
 *   the row's note and deliberately NOT re-sent by "Re-run failed", because a
 *   post that did land would become a duplicate on a real account.
 *
 * - **0.4.1 — the optional phone list was not optional.** Both post members
 *   wrote `deviceIds` as `.default([])`, and a Zod default still lands in the
 *   generated JSON Schema's `required` list — so submitting either form
 *   without choosing phones was refused with "deviceIds: required", on the
 *   one field whose whole point is that empty means "any phone carrying the
 *   label". `.optional()` instead, with the empty case handled in the body.
 *   It took a real form submission to find; a test now pins it.
 *
 * - **0.4.0 — twenty videos, one action.** `add-post` takes one video, so an
 *   operator holding twenty walked the same dialog twenty times, choosing the
 *   same platforms and phones each time — on a farm meant for a hundred
 *   devices. `add-posts` writes one row per ticked upload. The fan-out to
 *   devices was never the missing half: the router already spreads posts
 *   across free labelled phones, claiming each so two posts never land on one
 *   phone in a tick.
 *
 *   Captions are one per line — a single line for every video, or exactly one
 *   line per video. Anything else is refused, naming both counts, because
 *   cycling five captions over twenty videos would put the same text on four
 *   accounts each without saying so, and looking different per device is the
 *   whole point of the farm. Re-running over the same videos updates rows and
 *   re-posts nothing, by the same carry-over rule `add-post` follows.
 *
 * - **0.3.2 — `partial` says how partial.** The state word alone told an
 *   operator something had failed and nothing about how much, so the next
 *   move was a guess. The reconciler now writes the counts into `note`,
 *   which the Posts table already renders — "3 posted, 2 failed" — beside a
 *   reminder that a retry re-sends to those two only. In `note` rather than
 *   a new stored field because it is computed from the same array at the
 *   same instant as the state it describes, so the two cannot drift.
 *
 * - **0.3.0 — choose the phones, not just the label.** A post routed on the
 *   platform's device label and nothing else, so "send this to these five
 *   phones" had no expression at all. `deviceIds` on the post narrows the
 *   label's fleet: empty (every post before this) still means any phone
 *   carrying the label, and a chosen phone that does NOT carry it is still
 *   skipped — the label is what says this phone posts to Instagram, and a
 *   picker is not a way to overrule it. The stalled note distinguishes the
 *   two cases, because "none of your chosen phones carries the label" and
 *   "they are all busy" need different actions.
 *
 *   Drawn with the same `DevicePicker` every other screen uses, through a new
 *   `kind: 'deviceIds'` in the parameter vocabulary — the alternative was a
 *   free-text field holding UUIDs.
 *
 * - **0.2.0 — a post learns what happened.** `dispatched` was the end of a
 *   post's life here: the router handed N jobs to the queue, wrote "sent to
 *   N", and never looked again. Ten failed uploads and ten successful ones
 *   were the same row. No job id was stored, so there was no way back from a
 *   post to the phones, and "re-run the ones that failed" could not be asked
 *   at all — which is half of what the client asked this screen for.
 *
 *   Each dispatch now records one `Attempt` per phone (`jobId`, `deviceId`,
 *   state, error). The router reconciles them through `job.get` on its next
 *   tick and rolls them up into `succeeded`, `partial` or `failed`; the
 *   `retry-failed` member re-queues **only** the phones that failed, because
 *   re-sending to one that succeeded publishes the same video to that account
 *   twice. `job.get` joins the declared permissions for it.
 *
 *   `add-post`'s carry-over was widened in the same change: it preserved only
 *   `dispatched`, and with outcomes reachable it would have reset a finished
 *   platform to `pending` — handing the router a post it believed had never
 *   been sent.
 *
 * ## Auto-post is OFF until an operator turns it on
 *
 * The timer always runs; `enabled` decides whether any tick dispatches
 * anything, and it defaults to `false`. A farm that installs this pack must
 * never begin posting to real accounts merely because a timer exists — the
 * same posture, and for the same reason, as the TikTok pack's own auto-post
 * settings.
 */

const AUTO_POST_SETTINGS_KEY = 'settings:auto-post'
/** When the router last actually completed a tick, unix seconds — what `intervalMinutes` is measured against. */
const AUTO_POST_LAST_RUN_KEY = 'state:auto-post-last-run'

const AutoPostSettingsSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    intervalMinutes: z.number().int().positive().max(24 * 60),
    /**
     * The per-tick, per-platform ceiling on how many phones one post fans out
     * to. A farm with eighty idle phones and one new video would otherwise
     * fire eighty upload jobs inside one second — a thundering herd on the
     * same network, launching the same app, which is both operationally rough
     * and the least human-shaped thing this codebase could do.
     */
    maxDevicesPerPlatform: z.number().int().positive().max(500),
  })
  .strict()
type AutoPostSettings = z.infer<typeof AutoPostSettingsSchema>

const DEFAULT_AUTO_POST_SETTINGS: AutoPostSettings = { version: 1, enabled: false, intervalMinutes: 60, maxDevicesPerPlatform: 5 }

/**
 * How often the timer WAKES to check the clock — not how often it posts.
 * Deliberately much finer than any sane `intervalMinutes`, so a setting an
 * operator just changed is honoured within a minute rather than only at the
 * next multiple of the OLD interval.
 */
const POLL_MS = 15_000

/** How many post rows one tick will consider. A farm with more than this has a backlog problem the router cannot fix by reading harder. */
const MAX_POSTS_PER_TICK = 200

/**
 * Enough of `device.list`'s output to route, declared locally rather than
 * imported from the protocol package. `FarmApi.call`'s own contract: the
 * farm's output shape can change under a plugin published months ago, so the
 * CALLER validates against what it needs and nothing more. `labels` is the
 * field this plugin exists to read.
 */
const DeviceListOutput = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      stableId: z.string(),
      status: z.string(),
      activities: z.array(z.object({ kind: z.string() })),
      labels: z.array(z.object({ name: z.string() })).default([]),
      /**
       * The two naming fields, read so a post row can say WHICH phone it ran
       * on rather than a uuid. Both are defaulted rather than required: a farm
       * older than `number` (plan 89) still answers this call, and a name is
       * never worth failing a router tick over.
       */
      label: z.string().default(''),
      number: z.number().int().nullable().default(null),
    }),
  ),
})

/** Every phone's display name, by device id — what an attempt records and the Posts table reads. */
function fleetNames(fleet: z.infer<typeof DeviceListOutput>): Map<string, string> {
  return new Map(fleet.items.map((d) => [d.id, deviceDisplayName(d)]))
}

const JobRunOutput = z.object({ jobId: z.string() })
/** Only the fields the reconciler reads. Validated at this boundary because the farm's own shape may move under a published plugin. */
const JobGetOutput = z.object({ status: z.string(), error: z.string().nullable().optional(), result: z.unknown().optional() })

/**
 * The upload script's own verdict, when it gives one. Every platform pack's
 * post script returns `outcome` (`tiktok/post-video` §4.1: posted, unverified,
 * skipped, failed) and a `reason`; a script that returns neither is judged by
 * its job status alone, as before.
 */
const ScriptVerdict = z.object({ outcome: z.string(), reason: z.string().nullable().optional() })

/** The farm's job statuses that mean "this phone has given its answer". */
const SETTLED: Record<string, Attempt['state']> = { success: 'success', failed: 'failed', cancelled: 'failed', expired: 'failed' }

/**
 * Settle one finished job into an attempt state.
 *
 * A job that SUCCEEDED is only a post when the script says so. The measured
 * case (2026-09-11, the owner's moto g06): the job went green, the script
 * returned `outcome: "unverified"` because TikTok's security check covered
 * the profile, and this reconciler — reading `status` alone — wrote "1
 * posted" for a video that never appeared. `unverified` is kept apart from
 * `failed` on purpose: "Re-run failed" must not re-send something that may
 * already be live on that account.
 */
export function settleJob(job: z.infer<typeof JobGetOutput>): { state: Attempt['state']; error: string | null } | null {
  const next = SETTLED[job.status]
  if (!next) return null
  if (next === 'failed') return { state: 'failed', error: (job.error ?? `job ${job.status}`).slice(0, 300) }
  const verdict = ScriptVerdict.safeParse(job.result)
  if (!verdict.success) return { state: 'success', error: null }
  const reason = verdict.data.reason ?? null
  switch (verdict.data.outcome) {
    case 'posted':
      return { state: 'success', error: null }
    case 'unverified':
      return { state: 'unverified', error: (reason ?? 'the upload script could not confirm the post landed').slice(0, 300) }
    // The script walked away without posting (nothing to post, or its own
    // cleanup path): nothing is live, so a retry is safe.
    case 'skipped':
    case 'failed':
      return { state: 'failed', error: (reason ?? `the upload script reported ${verdict.data.outcome}`).slice(0, 300) }
    default:
      return { state: 'success', error: null }
  }
}

/**
 * Turn queued attempts into answers, for ONE post.
 *
 * Returns the post to store, or `null` when nothing moved — the caller must
 * not write in that case, because rewriting an unchanged row every tick makes
 * the Posts table look permanently busy for no reason.
 *
 * A job the farm no longer knows about (pruned, or a farm restored from a
 * backup taken before it ran) resolves to `failed` with that stated as the
 * reason. The alternative is an attempt that stays `queued` forever, which
 * pins its platform at `dispatched` and quietly removes the row from both the
 * success and the failure column — the same disappearing act this whole change
 * exists to end.
 */
async function reconcilePost(ctx: PluginServiceContext, post: Post): Promise<Post | null> {
  let any = false
  const dispatch: Post['dispatch'] = { ...post.dispatch }
  for (const platformId of post.platforms) {
    const state = stateFor(post, platformId)
    if (!state.attempts.some((a) => a.state === 'queued')) continue
    // Per platform, NOT per post: a shared flag would rewrite an untouched
    // platform's state merely because a different one moved.
    let moved = false
    const settled: Attempt[] = []
    for (const attempt of state.attempts) {
      if (attempt.state !== 'queued') {
        settled.push(attempt)
        continue
      }
      try {
        const job = await ctx.farm.call('job.get', { jobId: attempt.jobId }, JobGetOutput)
        const next = settleJob(job)
        if (!next) {
          settled.push(attempt)
          continue
        }
        settled.push({ ...attempt, ...next, settledAt: Math.floor(Date.now() / 1000) })
        moved = true
      } catch (err) {
        settled.push({ ...attempt, state: 'failed', error: `the farm no longer has this job: ${messageOf(err)}`.slice(0, 300), settledAt: Math.floor(Date.now() / 1000) })
        moved = true
      }
    }
    if (!moved) continue
    /*
      The counts go in `note`, which the Posts table already renders, because
      `partial` on its own tells an operator something went wrong and nothing
      about how much. Written here rather than stored as a separate field and
      kept in step: it is computed at the same instant as the state it
      describes, from the same array, so the two cannot drift.
    */
    const next = rollUp(settled)
    const ok = settled.filter((a) => a.state === 'success').length
    const bad = settled.filter((a) => a.state === 'failed').length
    const unsure = settled.filter((a) => a.state === 'unverified').length
    const note =
      next === 'succeeded'
        ? null
        : next === 'failed'
          ? `Failed on all ${bad} phone${bad === 1 ? '' : 's'}. "Re-run failed" sends it to them again.`
          : next === 'partial'
            ? partialNote(ok, bad, unsure)
            : state.note
    // `withSummary` last, so the line the Posts table shows is computed from
    // the attempts this very pass settled — the state word and the sentence
    // beside it can never describe two different moments.
    dispatch[platformId] = withSummary({ ...state, attempts: settled, state: next, note })
    any = true
  }
  return any ? { ...post, dispatch } : null
}

/**
 * `partial` in words. Unverified phones are named separately and deliberately
 * left out of "Re-run failed": the operator checks those accounts by eye,
 * because re-sending a post that did land is a duplicate on a real account.
 */
export function partialNote(ok: number, bad: number, unsure: number): string {
  const parts = [`${ok} posted`, `${bad} failed`]
  if (unsure > 0) parts.push(`${unsure} unverified`)
  const retry = bad > 0 ? ` "Re-run failed" re-sends to those ${bad} only — the ones that posted are left alone.` : ''
  const check = unsure > 0 ? ` Check the ${unsure} unverified account${unsure === 1 ? '' : 's'} on the phone before re-sending; they are not retried automatically.` : ''
  return `${parts.join(', ')}.${retry}${check}`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Every group, by id. A group this build cannot parse is skipped rather than
 * rewritten — the same rule the post rows keep, and for the same reason: it
 * may have been written by a newer version an operator is about to activate.
 */
async function readGroups(ctx: PluginServiceContext): Promise<Map<string, Group>> {
  const out = new Map<string, Group>()
  try {
    let cursor: string | null = null
    do {
      const opts: { prefix: string; limit: number; cursor?: string } = { prefix: GROUP_PREFIX, limit: 200 }
      if (cursor !== null) opts.cursor = cursor
      const page = await ctx.storage.global.list(opts)
      for (const entry of page.items) {
        const parsed = GroupSchema.safeParse(entry.value)
        if (parsed.success) out.set(parsed.data.id, parsed.data)
      }
      cursor = page.nextCursor
    } while (cursor !== null)
  } catch (err) {
    ctx.log.warn('router tick could not read the groups — pacing falls back to the farm settings this tick', { error: messageOf(err) })
  }
  return out
}

/**
 * One router tick: read the fleet once, then walk every post.
 *
 * The fleet is read ONCE for the whole tick rather than per post, and that is
 * a correctness choice as much as an efficiency one — two posts planned
 * against two different readings of the same fleet can both pick the same idle
 * phone, and the farm would then run two upload jobs back to back on it. One
 * reading, and `claimed` below removes a phone from the pool as soon as any
 * post takes it.
 *
 * ## `dispatch: false` — the settle-only pass
 *
 * A tick does two quite different things, and only one of them is "post to a
 * real account". Settling what is already in flight (`job.get` on the queued
 * attempts) and keeping each row's phone names and summary line current are
 * pure bookkeeping about work the farm has ALREADY done, so they run on every
 * poll whether or not auto-posting is on. Planning and firing new jobs is the
 * half `enabled` gates, and it is the only half `dispatch: false` skips.
 *
 * That split is a fix, not a tidy-up: "Re-run failed" enqueues jobs from the
 * Posts screen with auto-posting off, and before this those attempts stayed
 * `queued` forever — the platform pinned at `dispatched`, the retry's outcome
 * invisible on the very screen that offered the button.
 */
async function runTick(ctx: PluginServiceContext, settings: AutoPostSettings, options: { dispatch: boolean; enabled: boolean }): Promise<void> {
  let fleet: z.infer<typeof DeviceListOutput>
  try {
    fleet = await ctx.farm.call('device.list', {}, DeviceListOutput)
  } catch (err) {
    // Fatal for a dispatching tick — there is no fleet to route to. Not fatal
    // for a settle-only one: names simply stay as they were, which is what a
    // removed phone's attempt shows anyway.
    if (options.dispatch || options.enabled) {
      ctx.log.warn('router tick could not list devices — skipping this tick', { error: messageOf(err) })
      return
    }
    fleet = { items: [] }
  }
  const names = fleetNames(fleet)

  let listed: Awaited<ReturnType<typeof ctx.storage.global.list>>
  try {
    listed = await ctx.storage.global.list({ prefix: POST_PREFIX, limit: MAX_POSTS_PER_TICK })
  } catch (err) {
    ctx.log.warn('router tick could not read the post rows — skipping this tick', { error: messageOf(err) })
    return
  }
  if (listed.items.length === 0) return

  /*
   * Phones already spoken for THIS tick. A phone carrying both `tiktok` and
   * `instagram`, with two posts waiting, must take one of them and not both:
   * `device.list`'s `activities` was read before either job existed, so it
   * cannot see a job this same tick just created.
   */
  const claimed = new Set<string>()

  /*
    The groups this tick may have to pace, and what their rows are doing.
    Read ONCE: forty rows asking "how many of my group are in the air" would
    otherwise be forty scans, and two rows reading different answers could
    both decide there was room for one more.
  */
  const groups = await readGroups(ctx)
  const groupStates = new Map<string, RowState[]>()
  /** groupId → deviceId → the row key that owns that phone. */
  const ownersByGroup = new Map<string, Map<string, string>>()
  const rowsByGroup = new Map<string, number>()
  for (const entry of listed.items) {
    const parsed = PostSchema.safeParse(entry.value)
    if (!parsed.success || parsed.data.groupId === null) continue
    const states = groupStates.get(parsed.data.groupId) ?? []
    for (const id of parsed.data.platforms) states.push((parsed.data.dispatch[id]?.state ?? 'pending') as RowState)
    groupStates.set(parsed.data.groupId, states)
    /*
      Which phone each row of the session OWNS (0.12.0): its assigned phone, and the phones of its
      attempts that posted, could not be confirmed, or are still running. `pickAssignment` reads
      this so a row without a phone never takes one another row already has.
    */
    const owned = ownersByGroup.get(parsed.data.groupId) ?? new Map<string, string>()
    const phone = sessionOwner(parsed.data)
    if (phone !== null && !owned.has(phone)) owned.set(phone, entry.key)
    ownersByGroup.set(parsed.data.groupId, owned)
    rowsByGroup.set(parsed.data.groupId, (rowsByGroup.get(parsed.data.groupId) ?? 0) + 1)
  }
  /** Room left per group this tick, decremented as rows are sent so one tick cannot exceed the cap. */
  const room = new Map<string, number>()
  for (const [groupId, states] of groupStates) {
    const group = groups.get(groupId)
    room.set(groupId, group ? roomInFlight(states, group.pacing.concurrency) : Number.POSITIVE_INFINITY)
    /*
      The group's own row carries the counts the Groups table renders. Written
      here, from the same reading the pacing above used, and only when
      something actually moved — `withProgress` returns null otherwise, so a
      quiet farm does not rewrite every group every fifteen seconds.
    */
    if (group) {
      const next = withProgress(group, states)
      if (next) {
        try {
          await ctx.storage.global.set(groupKeyFor(group.id), next)
        } catch (err) {
          ctx.log.warn('could not write a group\'s progress — the rows themselves are unaffected', { groupId: group.id, error: messageOf(err) })
        }
      }
    }
  }

  for (const entry of listed.items) {
    let post: Post
    try {
      post = PostSchema.parse(entry.value)
    } catch (err) {
      // A row this build cannot understand is LEFT ALONE, never rewritten:
      // it may carry a dispatch record that is already true on a phone, and
      // overwriting it is the one way to make this plugin post twice.
      ctx.log.warn('a post row has a shape this build does not understand — leaving it untouched', { key: entry.key, error: messageOf(err) })
      continue
    }

    /*
      Settle what is already in flight before planning anything new.

      Order matters: reconciling first means a platform whose jobs have all
      finished leaves `dispatched` in the same tick it stopped being true, so
      the operator never sees "running on 10" for a fan-out that ended
      an hour ago. It is also written back on its own, because a post with
      nothing new to dispatch would otherwise never be stored at all.
    */
    const reconciled = await reconcilePost(ctx, post)
    /*
      Then bring the two DISPLAY fields up to date — the phone names and the
      summary line — on whatever the reconciler left behind. Folded into the
      same write rather than given one of its own: a row that settled and a row
      whose phone was renamed are one `setIfVersion` either way, and two writes
      would race each other for the version.
    */
    const settled = reconciled ?? post
    const refreshed = refreshPost(settled, names) ?? (reconciled !== null ? settled : null)
    if (refreshed !== null) {
      const written = await ctx.storage.global.setIfVersion(entry.key, refreshed, entry.version)
      if (!written) {
        // Someone else wrote this row between the read and here. Leave it; the
        // next tick re-reads and reconciles from whatever they stored.
        continue
      }
      post = refreshed
      entry.version += 1
      if (reconciled !== null) ctx.log.info('post outcomes settled', { key: entry.key, subject: entry.key, summary: postSummary(post) })
    }

    /*
      Everything above is bookkeeping about work already done. Everything
      below posts to real accounts.

      Two kinds of row reach this line, and they are told apart by who said
      "send it":

      - A row in a SESSION was started by an operator pressing Start, which
        stamped its turn (`notBeforeAt`). That press IS the consent, so the
        row is considered on every poll and does not consult the auto-post
        switch — the one screen has no such switch, and a Start that quietly
        did nothing because of a setting nobody can see is the worst failure
        this plugin could have.
      - An UNGROUPED row (written by `add-post`/`add-posts`, which nothing
        starts) has no such moment, so it still waits for the auto-post timer,
        off by default. Fail closed: a leftover row from an old build must
        never post itself because a new version was activated.
    */
    if (post.groupId === null) {
      if (!options.enabled || !options.dispatch) continue
    } else if (!groups.has(post.groupId)) {
      /*
        Its session was removed. Removing is therefore a STOP for whatever has
        not gone out yet — which is what an operator means by removing a
        running batch, and the only reading that is safe: the alternative,
        treating an orphan as unpaced, would let a deleted forty-video session
        dispatch all forty at once on the very next tick.
      */
      continue
    }

    /*
      One video, one phone (0.12.0). A one-per-phone row WITHOUT a phone is held here and never sent.

      Rows paired at creation always have one. A row that does not is from an older build — the
      owner's production session among them — and its history is the very tangle pairing exists to
      prevent, so it is not guessed at: the row carries a note with a suggested phone, and it waits
      until an operator chooses with Edit. Without this hold the row would fall through to "any free
      phone in its pool", which is exactly how one phone ended up with three videos.
    */
    if (post.groupId !== null && post.maxDevices === 1 && post.assignedDeviceId === null) {
      const owned = ownersByGroup.get(post.groupId) ?? new Map<string, string>()
      const ownedByOthers = new Set([...owned].filter(([, key]) => key !== entry.key).map(([deviceId]) => deviceId))
      const pick = pickAssignment({ post, ownedByOthers, fleet: fleet.items, sessionVideos: rowsByGroup.get(post.groupId) ?? 1 })
      const note = unassignedNote(pick, names)
      const dispatch: Post['dispatch'] = { ...post.dispatch }
      let changed = false
      for (const id of post.platforms) {
        const state = stateFor(post, id)
        if (state.state !== 'pending' || state.note === note) continue
        dispatch[id] = withSummary({ ...state, note })
        changed = true
      }
      if (changed) {
        const written = await ctx.storage.global.setIfVersion(entry.key, { ...post, dispatch }, entry.version)
        if (written) entry.version += 1
      }
      continue
    }

    /*
      A group row waits for two things before it may send: its own turn
      (`notBeforeAt`, stamped by Start) and room under the group's "how many
      at once". Both are skips, not states — a row whose turn has not come is
      not "pending for a reason an operator should read", it is simply not yet.
    */
    const nowSec = Math.floor(Date.now() / 1000)
    if (!isRowDue(post, nowSec)) continue
    if (post.groupId !== null) {
      const left = room.get(post.groupId) ?? Number.POSITIVE_INFINITY
      if (left <= 0) continue
    }

    const devices: RouterDevice[] = fleet.items.filter((d) => !claimed.has(d.id))
    const plan = planDispatch({ post, devices, now: nowSec, maxDevicesPerPlatform: settings.maxDevicesPerPlatform })
    if (plan.dispatches.length === 0 && Object.keys(plan.states).length === 0 && plan.note === post.lastNote) continue

    /*
     * Dispatch BEFORE writing state, and record only what was actually
     * enqueued. The alternative — mark dispatched, then fire — turns a farm
     * that refuses the job (offline since the list was read, no grant) into a
     * post that says "sent" and never was, which is the failure an operator
     * cannot detect from this screen.
     */
    if (post.groupId !== null) {
      const left = room.get(post.groupId)
      if (left !== undefined && Number.isFinite(left)) room.set(post.groupId, left - 1)
    }
    const sent: string[] = []
    /*
      The job id is kept, per platform, because it is the ONLY link back from
      a post to what the farm actually did on the phones. Without it this row
      could say "sent to 10" and never learn that ten uploads failed — which
      is exactly what it used to do — and "re-run the ones that failed" could
      not be answered at all.
    */
    const attempts: Record<string, Attempt[]> = {}
    for (const dispatch of plan.dispatches) {
      try {
        const params = { source: 'direct', videoArtifactId: post.videoArtifactId, caption: post.caption }
        const job = await ctx.farm.call('job.run', { scriptRef: dispatch.script, deviceId: dispatch.deviceId, params }, JobRunOutput)
        claimed.add(dispatch.deviceId)
        sent.push(dispatch.platform)
        ;(attempts[dispatch.platform] ??= []).push({
          jobId: job.jobId,
          deviceId: dispatch.deviceId,
          // Recorded at the moment of the dispatch, from the fleet reading
          // this tick was planned against — so the row can name the phone even
          // after it is unplugged, renamed or removed.
          deviceName: names.get(dispatch.deviceId) ?? null,
          state: 'queued',
          error: null,
          at: nowSec,
          settledAt: null,
          round: nextRound(stateFor(post, dispatch.platform)),
        })
      } catch (err) {
        // One phone's refusal never stops the rest — the same posture the
        // TikTok pack's own auto-post tick takes with its fleet.
        ctx.log.warn('could not enqueue a post job', {
          key: entry.key,
          platform: dispatch.platform,
          device: dispatch.stableId,
          error: messageOf(err),
        })
      }
    }

    const next: Post = { ...post, dispatch: { ...post.dispatch }, lastNote: plan.note }
    for (const [platformId, state] of Object.entries(plan.states)) {
      // A planned `dispatched` whose jobs ALL failed to enqueue stays where it
      // was, so the next tick tries again. `sent` is what actually happened;
      // `plan.states` is only what was intended.
      if (state.state === 'dispatched' && !sent.includes(platformId)) continue
      const fired = attempts[platformId]
      // `deviceCount` is corrected to what was enqueued, not what was planned:
      // a phone whose `job.run` threw is not a phone this post was sent to.
      // `withSummary` then writes the line naming those phones — it could not
      // be written inside `planDispatch`, which is pure and had no job ids.
      next.dispatch[platformId] = withSummary(fired ? { ...state, attempts: fired, deviceCount: fired.length } : state)
    }

    try {
      // `setIfVersion` against the version this row was read at: an operator
      // editing the same post through "New post" mid-tick must not have their
      // write silently stomped by the router's. A refusal is a no-op — the
      // next tick re-reads and re-plans from whatever they wrote.
      const written = await ctx.storage.global.setIfVersion(entry.key, next, entry.version)
      if (written === null) {
        ctx.log.info('a post row changed while this tick was planning it — leaving it for the next tick', { key: entry.key })
        continue
      }
    } catch (err) {
      ctx.log.warn('could not write back a post row', { key: entry.key, error: messageOf(err) })
      continue
    }

    if (sent.length > 0) ctx.log.info('dispatched a post', { key: entry.key, platforms: sent.join(','), summary: postSummary(next) })
  }
}

/**
 * The timer body — reads the settings fresh on every poll, so a changed
 * `enabled`/`intervalMinutes` takes effect without a republish, and only
 * actually DISPATCHES once `intervalMinutes` has genuinely elapsed.
 *
 * Every poll still settles: `runTick(..., { dispatch: false })` reads back the
 * jobs already in flight and refreshes what the Posts screen shows. That is
 * not a weakening of "auto-post is off until an operator turns it on" — it
 * enqueues nothing and can post nothing — it is what makes a manually
 * triggered retry visible on a farm that never turns the timer on at all.
 */
async function maybeRunTick(ctx: PluginServiceContext): Promise<void> {
  let settings: AutoPostSettings
  let readable = true
  try {
    settings = (await ctx.storage.global.get(AUTO_POST_SETTINGS_KEY, AutoPostSettingsSchema)) ?? DEFAULT_AUTO_POST_SETTINGS
  } catch (err) {
    // A stored shape this build cannot read must never be misread as
    // "enabled" — fail closed. Posting to real accounts is not a default.
    ctx.log.warn('auto-post settings have an incompatible shape — leaving auto-posting off this tick', { error: messageOf(err) })
    settings = { ...DEFAULT_AUTO_POST_SETTINGS, enabled: false }
    readable = false
  }

  let dispatch = false
  const enabled = readable && settings.enabled
  if (enabled) {
    const nowSec = Math.floor(Date.now() / 1000)
    const lastRunSec = (await ctx.storage.global.get(AUTO_POST_LAST_RUN_KEY, z.number().int().nonnegative())) ?? 0
    if (nowSec - lastRunSec >= settings.intervalMinutes * 60) {
      // Stamped BEFORE the tick: a tick slow enough to still be running (many
      // posts, many phones) must not be re-entered by the next 60 s poll.
      await ctx.storage.global.set(AUTO_POST_LAST_RUN_KEY, nowSec)
      dispatch = true
    }
  }

  await runTick(ctx, settings, { dispatch, enabled })
}

/** The platform choice an operator sees in the New post form — `tiktok` → `TikTok`. */
const PLATFORM_LABELS: Record<string, string> = Object.fromEntries(PLATFORMS.map((p) => [p.id, p.title]))

export default definePlugin({
  id: 'smm',
  // 0.1.0 — first release. The router, the post row, the Social posts and
  // Platforms screens, and the auto-post timer (off by default). TikTok is the
  // only platform with a verified upload flow; Instagram and YouTube are
  // declared and say why they cannot post yet.
  version: '0.12.0',
  icon: 'upload',
  title: 'Social Media Manager',
  description: 'Upload a folder of videos and send them across the phones labelled for each platform, paced so they do not all move at once. TikTok and YouTube post today; Instagram is declared and has no verified upload flow yet.',
  scripts: [addPost, retryFailed, addPosts, addGroup, startGroup, retryGroup, updatePost],
  /*
    Plan 315 — workflows this plugin ships. Registered on the farm as
    `smm/<name>` when this version is activated, read-only there; an operator
    who wants a different rotation duplicates it.
  */
  workflows: [warmupRotation],

  service: defineService({
    /**
     * Exhaustive, and nothing below calls anything absent from it — this list
     * is what the operator is shown and consents to at install.
     *
     * `device.list` is the fleet read (status, activities, labels); `job.run`
     * is the dispatch; `job.get` is how a dispatched post learns what actually
     * happened on each phone. `job.list` is still deliberately absent:
     * `activities` already answers "is this phone busy", and the reconciler
     * asks about jobs it holds ids for, one at a time — a permission asked for
     * and not needed is one an operator granted for nothing.
     */
    permissions: ['device.list', 'job.run', 'job.get'],
    setup: (ctx) => {
      const timer = setInterval(() => {
        void maybeRunTick(ctx).catch((err) => ctx.log.warn('router tick failed', { error: messageOf(err) }))
      }, POLL_MS)
      ctx.onStop(() => clearInterval(timer))
    },
  }),

  surface: {
    /*
      ONE entry, for one screen. The plugin used to carry three — posts,
      sessions, platforms — and the owner's verdict after using it was that
      three menus for one job is three places to get lost. The work is a
      single sequence (upload a folder, spread it over the phones, watch it),
      so the screen is a single page; see `ui/index.tsx`.
    */
    nav: [{ id: 'posts', label: 'Social posts', icon: 'upload', view: 'posts' }],
    views: {
      posts: {
        title: 'Social posts',
        description: 'Upload the videos, choose where they go and how fast, then start the session — all on this page.',
        /*
          Tier C. A declared table can render stored rows and fire an action
          per row, which is right for a list and cannot express this flow:
          files uploading one after another with progress, a fleet count that
          answers back as labels are picked, a pacing sentence that recomputes
          as the numbers move, captions generated from file names. Those are
          answers the screen computes WHILE the operator decides.
        */
        react: { entry: 'index.js', apiVersion: PLUGIN_UI_API_VERSION },
      },
    },

    /*
      No declared actions, deliberately.

      Tier A's actions are buttons a declared TABLE puts on a row or a
      toolbar, and this plugin no longer has a table: the one screen does the
      creating, the starting, the retrying and the removing itself, through the
      same members those buttons used to call. Keeping them declared would
      leave a set of controls nothing can render and no one can press — the
      exact kind of half-real surface this rewrite exists to remove.
    */
  },
})
