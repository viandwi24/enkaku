import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { GROUP_PREFIX, GroupSchema, groupKeyFor, isWarmup, slotFor, type Group } from './groups'
import { launchWarmupRun } from './warmup-launch'
import { describeTarget } from './warmup-target'
import { stopKey, type StopMarker } from './session-control'

/**
 * Start an existing warm-up session again — a new RUN, with its own progress
 * and its own history (0.58.0).
 *
 * ## Why this is a member and Stop is not
 *
 * The rule this plugin settled on in 0.57.1: a member is for work a SCHEDULE
 * has to be able to run, because a schedule can only run a script. This is the
 * clearest possible case of it — the owner's ask was literally two dates:
 * *"saya jalanin 20 sep 2026 10:00 ... terus misalnya saya bisa jalanin lagi
 * di tanggal 21 sep 2026 11:00"*. Stopping is never scheduled; starting is
 * almost always.
 *
 * ## What a new run keeps and what it draws again
 *
 * It keeps the DECISION: which phones, which platforms, how many activities,
 * how long to watch, how to pace. It draws everything random again — the
 * platform each phone gets, its style, the order of its activities, its
 * jitter, its gaps — because two runs of one session are two different
 * evenings, not one evening replayed.
 *
 * The rotation slot advances with every run, so a session started twice in one
 * day does not send the same phone to the same platform twice.
 *
 * ## Why a session that is stopped refuses
 *
 * `stopped` means "send nothing for this session". A run started into that
 * would write a fleet's worth of rows that the router then ignores — work the
 * operator can see, cannot explain, and did not ask for. So this refuses and
 * says to start the session first.
 */

const params = z.object({
  groupId: z.string().min(1).describe('The warm-up session to run again.').meta(ui({ title: 'Session' })),
  /**
   * Minutes within which a run of this session is taken as already started.
   *
   * The same guard `add-warmup` carries, for the same reason: this member
   * plans the whole fleet from ONE run, so a schedule aimed at eighty phones
   * would otherwise start eighty runs of it, and the farm would spend its day
   * warming up eighty times over.
   */
  dedupeMinutes: z
    .number()
    .int()
    .min(0)
    .max(1_440)
    .default(30)
    .describe('If this session was already started within this many minutes, do nothing. Guards a schedule aimed at many phones.')
    .meta(ui({ title: 'Skip if started in the last (min)' })),
  /**
   * Start the run now, or leave it READY for the operator to press Play (0.64.0). A session made
   * from the page is looked at before it goes; a schedule has nobody to press anything.
   */
  startNow: z
    .boolean()
    .default(true)
    .describe('Start sending activities straight away. Off leaves the run ready, waiting for Play.')
    .meta(ui({ title: 'Start now' })),
})

const result = z.object({
  groupId: z.string().meta(ui({ title: 'Session', summary: true })),
  title: z.string().meta(ui({ title: 'Title', summary: true })),
  runId: z.string().describe('The run this started; empty when an existing one was used.').meta(ui({ title: 'Run', summary: true })),
  devices: z.number().int().meta(ui({ title: 'Phones', summary: true })),
  activities: z.number().int().meta(ui({ title: 'Activities', summary: true })),
  phases: z.number().int().meta(ui({ title: 'Platforms per phone' })),
  skipped: z.number().int().meta(ui({ title: 'Skipped' })),
  outOfScope: z.number().int().meta(ui({ title: 'Out of scope' })),
  started: z.boolean().describe('False when a run was already going and this one did nothing.').meta(ui({ title: 'Started' })),
  summary: z.string().meta(ui({ title: 'Summary' })),
})

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'run-warmup',
  title: 'Run a warm-up again',
  description: 'Starts an existing warm-up session again. The new run keeps the session’s settings and phones, draws its variation fresh, and keeps its own progress beside the runs before it.',
  icon: 'play',
  params,
  result,
  timeout: 180_000,

  async run(ctx: ScriptContext<z.infer<typeof params>>) {
    const group = await ctx.storage.global.get(groupKeyFor(ctx.params.groupId), GroupSchema)
    if (!group) {
      throw Object.assign(new Error(`No session called "${ctx.params.groupId}" — it may have been removed.`), { code: 'E_NOT_FOUND' })
    }
    if (!isWarmup(group)) {
      throw Object.assign(new Error(`"${group.title}" is a post session, not a warm-up. Only a warm-up can be run again this way.`), { code: 'E_PARAMS_INVALID' })
    }
    if (group.stopped) {
      throw Object.assign(new Error(`"${group.title}" is stopped, so a new run would sit there sending nothing. Start the session first, then run it.`), { code: 'E_PARAMS_INVALID' })
    }

    const now = Math.floor(Date.now() / 1000)

    /*
      Already started moments ago? See `dedupeMinutes`. Checked before the
      fleet is read, so seventy-nine of eighty scheduled runs cost one storage
      scan and nothing else.
    */
    const made: Group[] = []
    if (ctx.params.dedupeMinutes > 0) {
      let cursor: string | null = null
      do {
        const opts: { prefix: string; limit: number; cursor?: string } = { prefix: GROUP_PREFIX, limit: 200 }
        if (cursor !== null) opts.cursor = cursor
        const page = await ctx.storage.global.list(opts)
        for (const entry of page.items) {
          const parsed = GroupSchema.safeParse(entry.value)
          if (parsed.success) made.push(parsed.data)
        }
        cursor = page.nextCursor
      } while (cursor !== null)

      const lastRunAt = group.lastRunAt ?? 0
      if (lastRunAt > 0 && now - lastRunAt < ctx.params.dedupeMinutes * 60) {
        ctx.log.info('this warm-up was started moments ago — leaving its run alone', { groupId: group.id, startedAgoSec: now - lastRunAt })
        return { groupId: group.id, title: group.title, runId: '', devices: 0, activities: 0, phases: 0, skipped: 0, outOfScope: 0, started: false, summary: group.summary ?? '' }
      }
    }

    /* The rotation advances with the run, not with the session — see `slotFor`. */
    const settings = { ...group.warmup, slot: slotFor(made, now) }
    const launched = await launchWarmupRun(ctx, { groupId: group.id, settings, platforms: group.platforms, target: group.target, now })

    await ctx.storage.global.set(groupKeyFor(group.id), { ...group, lastRunAt: now, summary: launched.summary })
    if (!ctx.params.startNow) await ctx.storage.global.set(stopKey(group.id, launched.runId), { version: 1, at: now, by: 'ready', reason: '' } satisfies StopMarker)

    ctx.log.info('warm-up session started again', { groupId: group.id, runId: launched.runId, target: describeTarget(group.target) })
    return {
      groupId: group.id,
      title: group.title,
      runId: launched.runId,
      devices: launched.devices,
      activities: launched.activities,
      phases: launched.phases,
      skipped: launched.skipped,
      outOfScope: launched.outOfScope,
      started: true,
      summary: launched.summary,
    }
  },
}

export default script
