import { definePlugin, defineService, type PluginServiceContext } from '@enkaku/sdk'
import { z } from 'zod'
import addPost from './add-post'
import retryFailed from './retry-failed'
import { PLATFORMS, PLATFORM_IDS } from './platforms'
import { POST_PREFIX, PostSchema, planDispatch, postSummary, rollUp, stateFor, type Attempt, type Post, type RouterDevice } from './posts'

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
 * The router works and is tested. **TikTok is the only platform that can
 * actually post today**: `tiktok/post-video` exists and every anchor in it was
 * measured on a real device. Instagram and YouTube have packs here, neither has
 * an upload flow, and this plugin says so by name — in the Platforms screen, in
 * each post's row, and in the router's log — rather than routing to them and
 * reporting a success nothing performed. See `platforms.ts` for why writing
 * those selectors from memory would be worse than not having them.
 *
 * ## Changelog
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
const POLL_MS = 60_000

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
    }),
  ),
})

const JobRunOutput = z.object({ jobId: z.string() })
/** Only the two fields the reconciler reads. Validated at this boundary because the farm's own shape may move under a published plugin. */
const JobGetOutput = z.object({ status: z.string(), error: z.string().nullable().optional() })

/** The farm's job statuses that mean "this phone has given its answer". */
const SETTLED: Record<string, Attempt['state']> = { success: 'success', failed: 'failed', cancelled: 'failed', expired: 'failed' }

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
        const next = SETTLED[job.status]
        if (!next) {
          settled.push(attempt)
          continue
        }
        settled.push({ ...attempt, state: next, error: next === 'failed' ? (job.error ?? `job ${job.status}`).slice(0, 300) : null })
        moved = true
      } catch (err) {
        settled.push({ ...attempt, state: 'failed', error: `the farm no longer has this job: ${messageOf(err)}`.slice(0, 300) })
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
    const note =
      next === 'succeeded'
        ? null
        : next === 'failed'
          ? `Failed on all ${bad} phone${bad === 1 ? '' : 's'}. "Re-run failed" sends it to them again.`
          : next === 'partial'
            ? `${ok} posted, ${bad} failed. "Re-run failed" re-sends to those ${bad} only — the ones that posted are left alone.`
            : state.note
    dispatch[platformId] = { ...state, attempts: settled, state: next, note }
    any = true
  }
  return any ? { ...post, dispatch } : null
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
 */
async function runTick(ctx: PluginServiceContext, settings: AutoPostSettings): Promise<void> {
  let fleet: z.infer<typeof DeviceListOutput>
  try {
    fleet = await ctx.farm.call('device.list', {}, DeviceListOutput)
  } catch (err) {
    ctx.log.warn('router tick could not list devices — skipping this tick', { error: messageOf(err) })
    return
  }

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
    if (reconciled !== null) {
      const written = await ctx.storage.global.setIfVersion(entry.key, reconciled, entry.version)
      if (!written) {
        // Someone else wrote this row between the read and here. Leave it; the
        // next tick re-reads and reconciles from whatever they stored.
        continue
      }
      post = reconciled
      entry.version += 1
      ctx.log.info('post outcomes settled', { key: entry.key, subject: entry.key, summary: postSummary(post) })
    }

    const devices: RouterDevice[] = fleet.items.filter((d) => !claimed.has(d.id))
    const plan = planDispatch({ post, devices, now: Math.floor(Date.now() / 1000), maxDevicesPerPlatform: settings.maxDevicesPerPlatform })
    if (plan.dispatches.length === 0 && Object.keys(plan.states).length === 0 && plan.note === post.lastNote) continue

    /*
     * Dispatch BEFORE writing state, and record only what was actually
     * enqueued. The alternative — mark dispatched, then fire — turns a farm
     * that refuses the job (offline since the list was read, no grant) into a
     * post that says "sent" and never was, which is the failure an operator
     * cannot detect from this screen.
     */
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
        ;(attempts[dispatch.platform] ??= []).push({ jobId: job.jobId, deviceId: dispatch.deviceId, state: 'queued', error: null })
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
      next.dispatch[platformId] = fired ? { ...state, attempts: fired, deviceCount: fired.length } : state
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
 * actually runs a tick once `intervalMinutes` has genuinely elapsed.
 */
async function maybeRunTick(ctx: PluginServiceContext): Promise<void> {
  let settings: AutoPostSettings
  try {
    settings = (await ctx.storage.global.get(AUTO_POST_SETTINGS_KEY, AutoPostSettingsSchema)) ?? DEFAULT_AUTO_POST_SETTINGS
  } catch (err) {
    // A stored shape this build cannot read must never be misread as
    // "enabled" — fail closed. Posting to real accounts is not a default.
    ctx.log.warn('auto-post settings have an incompatible shape — leaving auto-posting off this tick', { error: messageOf(err) })
    return
  }
  if (!settings.enabled) return

  const nowSec = Math.floor(Date.now() / 1000)
  const lastRunSec = (await ctx.storage.global.get(AUTO_POST_LAST_RUN_KEY, z.number().int().nonnegative())) ?? 0
  if (nowSec - lastRunSec < settings.intervalMinutes * 60) return

  // Stamped BEFORE the tick: a tick slow enough to still be running (many
  // posts, many phones) must not be re-entered by the next 60 s poll.
  await ctx.storage.global.set(AUTO_POST_LAST_RUN_KEY, nowSec)
  await runTick(ctx, settings)
}

/** The Platforms screen's rows — a static table of what this build can and cannot post, read straight off `PLATFORMS`. */
const PLATFORM_ROWS = PLATFORMS.map((p) => ({
  id: p.id,
  title: p.title,
  label: p.label,
  status: p.script === null ? 'Not available' : 'Ready',
  script: p.script ?? '—',
  detail: p.unsupportedReason ?? 'Posts through this platform’s own pack.',
}))

/** The platform choice an operator sees in the New post form — `tiktok` → `TikTok`. */
const PLATFORM_LABELS: Record<string, string> = Object.fromEntries(PLATFORMS.map((p) => [p.id, p.title]))

export default definePlugin({
  id: 'smm',
  // 0.1.0 — first release. The router, the post row, the Social posts and
  // Platforms screens, and the auto-post timer (off by default). TikTok is the
  // only platform with a verified upload flow; Instagram and YouTube are
  // declared and say why they cannot post yet.
  version: '0.3.2',
  icon: 'upload',
  title: 'Social Media Manager',
  description: 'Upload a video once and send it to every phone labelled for each platform. TikTok posts today; Instagram and YouTube are declared but have no verified upload flow yet.',
  scripts: [addPost, retryFailed],

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
      // The Platforms view's rows. Constant for the life of the build — there
      // is nothing to read and nothing that can fail, so it takes no error
      // path of its own.
      ctx.onQuery('platforms', () => ({ rows: PLATFORM_ROWS.map((row) => ({ id: row.id, value: row })) }), {
        description: 'What this build can post, and the device label each platform routes on.',
      })

      const timer = setInterval(() => {
        void maybeRunTick(ctx).catch((err) => ctx.log.warn('router tick failed', { error: messageOf(err) }))
      }, POLL_MS)
      ctx.onStop(() => clearInterval(timer))
    },
  }),

  surface: {
    nav: [
      { id: 'posts', label: 'Social posts', icon: 'upload', view: 'posts' },
      { id: 'platforms', label: 'Platforms', icon: 'puzzle', view: 'platforms' },
    ],
    views: {
      posts: {
        title: 'Social posts',
        description: 'One row per video. Each platform sends to the phones carrying that platform’s label.',
        data: { kind: 'kv.list', scope: 'global', prefix: POST_PREFIX },
        table: {
          rowKey: 'videoArtifactId',
          columns: [
            { field: 'videoArtifactId', header: 'Video', width: 'wide' },
            { field: 'caption', header: 'Caption', width: 'wide' },
            // One column per platform, reading the seeded per-platform state.
            // A platform this post does not target has no key at all and
            // renders `—`, which is why `newPost` seeds the targeted ones:
            // without that, "not targeted" and "waiting" would look identical.
            // The per-platform state words are the OUTCOME now, not the
            // hand-off: `succeeded`, `partial` and `failed` join `pending`,
            // `dispatched` and `unsupported`. A column that said `dispatched`
            // for a fan-out that had long since failed on every phone is the
            // bug this pack's 0.2.0 exists to end.
            { field: 'dispatch.tiktok.state', header: 'TikTok', width: 'narrow' },
            { field: 'dispatch.instagram.state', header: 'Instagram', width: 'narrow' },
            { field: 'dispatch.youtube.state', header: 'YouTube', width: 'narrow' },
            { field: 'lastNote', header: 'Note', width: 'wide' },
            { field: 'createdAt', header: 'Added', schema: { type: 'number', 'x-enkaku': { kind: 'timestamp' } } },
          ],
        },
        toolbar: ['addPost', 'autoPostSettings'],
        rowActions: ['retryFailedNow', 'postToTikTokNow', 'removePost'],
        empty: {
          title: 'No posts yet',
          hint: 'Upload a video on the Files screen, then use “New post” to say which platforms it is for.',
        },
      },
      platforms: {
        title: 'Platforms',
        description: 'What this build can post, and the device label each platform routes on. Label a phone on the Devices screen to make it part of that platform’s fleet.',
        /*
         * A `handler` source: the rows are this build's own platform registry,
         * assembled by code, not farm state anybody stored. The two `kv.*`
         * sources read stored rows, and there are none to read here — seeding
         * a KV entry just to describe constants would put a stale copy of the
         * registry on every farm that ever installed an older build.
         *
         * A handler view is the one source that can be DOWN (it needs the
         * service running). That is the right behaviour here rather than a
         * drawback: the service IS the router, so a farm being told "the
         * Social Media Manager service is not running" on this screen is being
         * told the true and more important thing — nothing is going to post.
         */
        data: { kind: 'handler', name: 'platforms' },
        table: {
          rowKey: 'id',
          columns: [
            { field: 'title', header: 'Platform' },
            { field: 'status', header: 'Status', width: 'narrow' },
            { field: 'label', header: 'Device label', width: 'narrow' },
            { field: 'script', header: 'Posts through' },
            { field: 'detail', header: 'Detail', width: 'wide' },
          ],
        },
        empty: { title: 'No platforms', hint: 'This build declares none.' },
      },
    },
    actions: {
      /**
       * A `form` whose `videoArtifactId` field declares `kind: 'artifact'` —
       * rendered by Studio's existing artifact picker, a real "upload a new
       * file or browse one you already uploaded" control, with no bespoke UI
       * written here at all.
       *
       * `then` is a JOB and not a `kv.set` because a binding cannot build
       * `post:<artifactId>` from a freshly-picked id — see `add-post.ts`. The
       * device it runs on does nothing; that trade-off is named there too.
       */
      addPost: {
        kind: 'form',
        label: 'New post',
        schema: {
          type: 'object',
          required: ['videoArtifactId', 'caption', 'platforms'],
          properties: {
            videoArtifactId: {
              type: 'string',
              title: 'Video',
              description: 'Upload a new video or pick one you already uploaded.',
              'x-enkaku': { kind: 'artifact' },
            },
            caption: {
              type: 'string',
              title: 'Caption',
              minLength: 1,
              maxLength: 2_200,
              // Required, not optional. `tiktok/post-video` refuses an empty
              // caption when it is told which video to post — see
              // `PostSchema.caption`. A dialog that lets one through would
              // store a post that fails on every phone it reaches.
              description: 'Typed into the app when the video is posted.',
            },
            platforms: {
              type: 'array',
              title: 'Platforms',
              description: 'Each one sends to the phones carrying that platform’s label. Only TikTok can post in this build — see the Platforms screen.',
              // Caught in the dialog rather than by the member: an empty list
              // stores a post that targets nothing and silently never sends.
              minItems: 1,
              items: { type: 'string', enum: [...PLATFORM_IDS], 'x-enkaku': { labels: PLATFORM_LABELS } },
            },
            // NOT in `required`: empty means "any phone carrying the label",
            // which is what every post written before this field meant, and
            // is still the right default for a fleet that grows.
            deviceIds: {
              type: 'array',
              title: 'Phones',
              description: 'Leave empty for any phone carrying the platform’s label. Choosing here narrows that fleet — it never widens it, so a phone without the label is still skipped.',
              items: { type: 'string' },
              'x-enkaku': { kind: 'deviceIds' },
            },
          },
        },
        submitLabel: 'Save post',
        then: {
          kind: 'job',
          label: 'New post',
          script: 'smm/add-post@latest',
          device: 'picker',
          params: {
            videoArtifactId: { $form: 'videoArtifactId' },
            caption: { $form: 'caption' },
            platforms: { $form: 'platforms' },
            deviceIds: { $form: 'deviceIds' },
          },
        },
      },

      autoPostSettings: {
        kind: 'form',
        label: 'Auto-post settings',
        schema: {
          type: 'object',
          required: ['version', 'enabled', 'intervalMinutes', 'maxDevicesPerPlatform'],
          properties: {
            // Written as part of the value so the stored row round-trips
            // through `AutoPostSettingsSchema`, which is `.strict()` and
            // requires it. `const` renders as a fixed, non-editable field.
            version: { type: 'number', title: 'Settings version', const: 1 },
            enabled: {
              type: 'boolean',
              title: 'Post automatically',
              description: 'Off by default. While off, nothing is ever dispatched on its own and the row actions below are the only way anything posts.',
            },
            intervalMinutes: {
              type: 'number',
              title: 'Check every',
              minimum: 1,
              maximum: 1_440,
              'x-enkaku': { kind: 'duration', unit: 'min' },
            },
            maxDevicesPerPlatform: {
              type: 'number',
              title: 'Phones per platform, per check',
              minimum: 1,
              maximum: 500,
              description: 'Caps one check’s blast radius, so a new video does not launch the same app on the whole fleet inside one second.',
            },
          },
        },
        submitLabel: 'Save settings',
        then: {
          kind: 'kv.set',
          label: 'Auto-post settings',
          scope: 'global',
          key: { $literal: AUTO_POST_SETTINGS_KEY },
          value: {
            version: { $form: 'version' },
            enabled: { $form: 'enabled' },
            intervalMinutes: { $form: 'intervalMinutes' },
            maxDevicesPerPlatform: { $form: 'maxDevicesPerPlatform' },
          },
        },
      },

      /**
       * The manual path, and the reason the screen is usable before an
       * operator ever turns the timer on: pick a row, pick the phones, post it
       * now. Only TikTok has one because only TikTok has a verified flow —
       * offering an Instagram button that cannot work would be an affordance
       * that always fails, which is worse than none.
       *
       * A BATCH with `target: 'picker'`: the operator chooses the phones, and
       * this deliberately does NOT consult the platform label. A manual post
       * is an operator saying "these phones, this video", and second-guessing
       * that with a label filter would refuse a phone they explicitly chose.
       */
      postToTikTokNow: {
        kind: 'batch',
        label: 'Post to TikTok now',
        script: 'tiktok/post-video@latest',
        target: 'picker',
        params: {
          source: { $literal: 'direct' },
          videoArtifactId: { $row: 'videoArtifactId' },
          caption: { $row: 'caption' },
        },
        confirm: 'Post this video to TikTok on the phones you pick? This publishes to whatever account is signed in on each one.',
      },

      /**
       * A plain `kv.delete` with no script behind it — the row read out of
       * `kv.list` carries its own exact key as `$entry.key`, so the create
       * path's binding problem does not exist here.
       */
      /*
        A `job`, not a `batch`: the phones are not the operator's to choose.
        A `batch` action opens a device picker, and a picker here invites the
        one mistake a retry must never make — ticking a phone that already
        posted, and publishing the video to that account twice. The member
        reads the failed set off the post's own attempts instead.

        `device: 'picker'` still asks for a phone because every job runs
        somewhere; this member does no device work on it, exactly as
        `add-post` does not.
      */
      retryFailedNow: {
        kind: 'job',
        label: 'Re-run failed',
        script: 'smm/retry-failed@latest',
        device: 'picker',
        params: { videoArtifactId: { $row: 'videoArtifactId' } },
        confirm:
          'Send this video again to the phones whose upload failed? Phones that already posted are left alone — only the failures are re-queued.',
      },

      removePost: {
        kind: 'kv.delete',
        label: 'Remove',
        scope: 'global',
        key: { $entry: 'key' },
        confirm: 'Remove this post? The uploaded video itself is left alone on the Files screen, and anything already posted stays posted.',
      },
    },
  },
})
