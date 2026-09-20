import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { GROUP_PREFIX, GroupSchema, WarmupSettingsSchema, DEFAULT_WARMUP_KEYWORDS, groupKeyFor, newGroupId, reusableWarmup, slotFor, type Group } from './groups'
import { PLATFORMS, PLATFORM_IDS, PlatformIdSchema, deviceCarriesPlatform, type PlatformId } from './platforms'
import { phaseCount, planWarmup, type WarmupDevice } from './warmup'
import { WarmupTargetSchema, describeTarget, reachesNothing, resolveWarmupTarget } from './warmup-target'
import { runsFromPlan, warmupProgress, warmupRunKey, warmupSummary } from './warmup-runs'

/**
 * Start a warm-up session: draw the plan once, write a row per phone.
 *
 * ## Why the plan is drawn here and not by the router
 *
 * Every count, every style and every gap comes from `random`. A router that
 * re-planned each tick would give a phone a different style every minute, so
 * the draw happens ONCE — here — and the rows are what the phones are actually
 * doing. That is the same reason `start-group` stamps turns rather than
 * recomputing a schedule.
 *
 * ## Why this sends nothing
 *
 * Like `start-group`, and for the same three reasons: the session survives a
 * plugin restart because the schedule is data on the rows; the button answers
 * instantly for eighty phones because it writes eighty rows rather than waiting
 * on eighty phones; and the farm is never flooded, because each phone's first
 * activity is due at its own jittered moment.
 */

const settingsParams = {
  keywords: z
    .array(z.string().min(1).max(60))
    .min(1)
    .max(10)
    .default([...DEFAULT_WARMUP_KEYWORDS])
    .describe('The account\'s interests. Used as search queries, and — wherever a phone is scrolling — a caption, author or hashtag matching one of these raises its chance of liking and of opening the comments.')
    .meta(ui({ title: 'Keywords' })),
  amount: z.number().min(0.2).max(3).default(1).describe('Scales how many videos, reels and scrolls, and how long to watch. 0.5 is short, 2 is long.').meta(ui({ title: 'Activity amount' })),
  gapMinSec: z.number().int().min(0).max(3_600).default(8).describe('Each phone waits a random time between these two before its next activity.').meta(ui({ title: 'Gap min (s)' })),
  gapMaxSec: z.number().int().min(0).max(3_600).default(20).describe('The other end of that range.').meta(ui({ title: 'Gap max (s)' })),
  startJitterSec: z
    .number()
    .int()
    .min(0)
    .max(1_800)
    .default(120)
    .describe('Each phone first waits a random 0 to this many seconds, so a fleet does not start in one instant.')
    .meta(ui({ title: 'Start jitter (s)' })),
  activities: z
    .number()
    .int()
    .min(1)
    .max(12)
    .default(4)
    .describe('How many activities each phone does on each platform. The system picks which ones, and shuffles them per phone.')
    .meta(ui({ title: 'Activities per phone' })),
  /**
   * Left in the params because a stored schedule may still send it, and
   * defaulted to `-1` meaning "work it out".
   *
   * The owner's instruction was that the plugin should own this
   * (*"ga perlu ada slot sesi lagi, biarkan sistem smm yang mengaturnya"*), and
   * a knob whose right value is "however many sessions you already ran today"
   * is a knob that asks the operator to keep count for the computer.
   */
  slot: z
    .number()
    .int()
    .min(-1)
    .max(5)
    .default(-1)
    .describe('Shifts the platform rotation. Leave it alone — the plugin counts today\'s sessions and rotates on its own.')
    .meta(ui({ title: 'Session slot (automatic)' })),
  phases: z
    .number()
    .int()
    .min(1)
    .max(3)
    .default(3)
    .describe('How many platforms each phone covers, one after another. Three means every phone warms up every platform it carries.')
    .meta(ui({ title: 'Platforms per phone' })),
  likeChance: z.number().min(0).max(1).default(0.1).describe('How often a phone presses like, on the activities that can.').meta(ui({ title: 'Like chance' })),
  commentChance: z
    .number()
    .min(0)
    .max(1)
    .default(0.05)
    .describe('How often a phone opens a comment sheet, reads it and closes it. It never types.')
    .meta(ui({ title: 'Comment chance' })),
  keywordBoost: z.number().min(1).max(10).default(3).describe('How much a keyword match raises the like and watch chance.').meta(ui({ title: 'Keyword boost' })),
  sequenceMode: z
    .enum(['jobs', 'workflow'])
    .default('jobs')
    .describe('How a phone\'s activities go out. "jobs" sends one per activity and shows a result for each. "workflow" sends the whole sequence as one job with exact gaps, and shows one result — the steps are then in the job\'s own run view.')
    .meta(ui({ title: 'Send activities as', labels: { jobs: 'One job per activity', workflow: 'One workflow per phone' } })),
}

const params = z.object({
  title: z.string().min(1).max(120).describe('What to call this session.').meta(ui({ title: 'Title' })),
  platforms: z
    .array(PlatformIdSchema)
    .min(1)
    .default([...PLATFORM_IDS])
    .describe('Which platforms this session covers. A phone is only sent to one it carries a label for.')
    .meta(ui({ title: 'Platforms' })),
  /**
   * The legacy one-label shorthand, kept because a stored SCHEDULE may still
   * send it (0.53.0 to 0.56.0 shipped it as the only way to pick phones).
   *
   * It folds into `targetLabels` below rather than being read separately —
   * two independent phone-picking rules in one member is exactly how a session
   * ends up reaching a fleet nobody chose.
   */
  label: z
    .string()
    .max(60)
    .default('')
    .describe('Older shorthand for "only phones labelled this". Leave empty and use Which phones below.')
    .meta(ui({ title: 'Only phones labelled (older)' })),
  targetMode: z
    .enum(['all', 'labels', 'groups', 'devices'])
    .default('all')
    .describe('Where the phone list starts, before any exception below.')
    .meta(
      ui({
        title: 'Which phones',
        labels: { all: 'Every phone', labels: 'Phones with these labels', groups: 'Phones in these device groups', devices: 'Only the phones I name' },
      }),
    ),
  targetLabels: z.array(z.string().min(1).max(60)).max(20).default([]).describe('Used when "Phones with these labels" is chosen. A phone needs any one of them, not all.').meta(ui({ title: 'Labels' })),
  targetGroups: z.array(z.string().min(1).max(60)).max(20).default([]).describe('Used when "Phones in these device groups" is chosen.').meta(ui({ title: 'Device groups' })),
  targetDeviceIds: z.array(z.string().min(1)).max(500).default([]).describe('Used when "Only the phones I name" is chosen.').meta(ui({ title: 'Phones' })),
  exceptDeviceIds: z.array(z.string().min(1)).max(500).default([]).describe('Left out whatever the choice above was.').meta(ui({ title: 'Except these phones' })),
  exceptLabels: z.array(z.string().min(1).max(60)).max(20).default([]).describe('Any phone carrying one of these is left out, whatever the choice above was.').meta(ui({ title: 'Except these labels' })),
  exceptGroups: z.array(z.string().min(1).max(60)).max(20).default([]).describe('Any phone in one of these is left out, whatever the choice above was.').meta(ui({ title: 'Except these device groups' })),
  /**
   * Minutes within which a warm-up of the same title is taken as already made.
   *
   * This exists because of how the thing it replaces was RUN. `smm/warmup-rotation`
   * was a workflow dispatched to every phone, so a schedule naturally targeted
   * the whole fleet. This member plans the whole fleet from ONE run — so a
   * schedule pointed at eighty phones the same way would create eighty
   * identical sessions, each planning the same eighty phones, and the farm
   * would spend its day warming up eighty times over.
   *
   * A dedupe window is the guard that does not depend on the operator reading
   * a warning: the first run makes the session and the other seventy-nine find
   * it and answer with its id. 0 turns it off, for someone who genuinely wants
   * two sessions of one name in one hour.
   */
  dedupeMinutes: z
    .number()
    .int()
    .min(0)
    .max(1_440)
    .default(30)
    .describe('If a warm-up with this title was made within this many minutes, use it instead of making another. Guards a schedule aimed at many phones.')
    .meta(ui({ title: 'Reuse a session made in the last (min)' })),
  ...settingsParams,
})

const result = z.object({
  groupId: z.string().meta(ui({ title: 'Session', summary: true })),
  title: z.string().meta(ui({ title: 'Title', summary: true })),
  devices: z.number().int().describe('Phones given a row.').meta(ui({ title: 'Phones', summary: true })),
  activities: z.number().int().describe('Activities planned across the fleet.').meta(ui({ title: 'Activities', summary: true })),
  phases: z.number().int().meta(ui({ title: 'Phases' })),
  skipped: z.number().int().describe('Phones given nothing — each row says why.').meta(ui({ title: 'Skipped' })),
  /** Phones the target left out entirely. They get no row: they were never part of this session. */
  outOfScope: z.number().int().describe('Phones this session does not cover.').meta(ui({ title: 'Out of scope' })),
  summary: z.string().meta(ui({ title: 'Summary' })),
  reused: z.boolean().describe('True when an existing session of this title was used instead of making another.').meta(ui({ title: 'Reused' })),
})

const DeviceListOutput = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      labels: z.array(z.object({ name: z.string() })).default([]),
      label: z.string().default(''),
      number: z.number().int().nullable().default(null),
      /** For `mode: 'groups'` and `exceptGroups`. Absent on an older core, which simply matches no group. */
      group: z.object({ id: z.string(), name: z.string() }).nullable().default(null),
    }),
  ),
})

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'add-warmup',
  title: 'New warm-up session',
  description: 'Plans a warm-up across the fleet: each phone gets one platform it carries, one activity style, and its own jittered schedule.',
  icon: 'activity',
  params,
  result,
  timeout: 180_000,

  async run(ctx: ScriptContext<z.infer<typeof params>>) {
    const now = Math.floor(Date.now() / 1000)
    const title = ctx.params.title.trim() || 'Warm-up'

    /*
      The sessions this farm already has. ONE scan, read before anything is
      planned, and both of the things that need it read from here: the dedupe
      guard below and the rotation slot. Two scans would be two chances for
      them to see different farms.
    */
    const made: Group[] = []
    {
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
    }

    const settings = WarmupSettingsSchema.parse({
      keywords: ctx.params.keywords,
      amount: ctx.params.amount,
      activitiesPerPhone: ctx.params.activities,
      gapSec: [Math.min(ctx.params.gapMinSec, ctx.params.gapMaxSec), Math.max(ctx.params.gapMinSec, ctx.params.gapMaxSec)],
      startJitterSec: ctx.params.startJitterSec,
      // `-1` is the default and means "work it out" — see the param's note.
      slot: ctx.params.slot >= 0 ? ctx.params.slot : slotFor(made, now),
      phases: ctx.params.phases,
      like: { chance: ctx.params.likeChance, commentChance: ctx.params.commentChance, keywordBoost: ctx.params.keywordBoost },
      sequenceMode: ctx.params.sequenceMode,
    })

    /* Already made? See `dedupeMinutes`. */
    if (ctx.params.dedupeMinutes > 0) {
      const existing = reusableWarmup(made, title, now, ctx.params.dedupeMinutes)
      if (existing !== null) {
        ctx.log.info('a warm-up of this title was made moments ago — using it rather than making another', { groupId: existing.id, title, madeAgoSec: now - existing.createdAt })
        return { groupId: existing.id, title: existing.title, devices: 0, activities: 0, phases: 0, skipped: 0, outOfScope: 0, summary: existing.summary ?? '', reused: true }
      }
    }

    /*
      The legacy `label` folds in here and nowhere else (see its note above), so
      a schedule written against 0.53.0 still means what it meant, and the rest
      of this member has one phone-picking rule to read.
    */
    const legacy = ctx.params.label.trim()
    const target = WarmupTargetSchema.parse({
      mode: legacy !== '' && ctx.params.targetMode === 'all' ? 'labels' : ctx.params.targetMode,
      labels: legacy !== '' && ctx.params.targetMode === 'all' ? [legacy] : ctx.params.targetLabels,
      groups: ctx.params.targetGroups,
      deviceIds: ctx.params.targetDeviceIds,
      exceptLabels: ctx.params.exceptLabels,
      exceptGroups: ctx.params.exceptGroups,
      exceptDeviceIds: ctx.params.exceptDeviceIds,
    })
    /*
      Refused BEFORE the fleet is read: "only these labels" with no label ticked
      reaches nothing, and the dangerous reading of it is the whole fleet. An
      operator who meant the fleet says so.
    */
    if (reachesNothing(target)) {
      throw Object.assign(new Error(`${describeTarget(target)} — this session would reach no phone at all. Choose "Every phone", or name what it should cover.`), { code: 'E_PARAMS_INVALID' })
    }

    const fleet = await ctx.farm.call('device.list', {}, DeviceListOutput)
    const resolved = resolveWarmupTarget(fleet.items, target)
    const chosen = resolved.chosen
    if (chosen.length === 0) {
      const why = fleet.items.length === 0 ? 'This farm has no phones to warm up.' : `${describeTarget(target)} — no phone on this farm matches. ${resolved.left[0]?.reason ?? ''}`.trim()
      throw Object.assign(new Error(why), { code: 'E_NO_DEVICES' })
    }

    /*
      What each phone can actually do. The rotation runs inside this, never
      across it — a phone labelled only `tiktok` has no YouTube account, and
      sending it there one day in three is a routing mistake that reads as a
      script one.
    */
    const devices: WarmupDevice[] = chosen.map((item) => ({
      deviceId: item.id,
      number: item.number,
      platforms: PLATFORMS.filter((platform) => deviceCarriesPlatform(item.labels, platform)).map((platform) => platform.id),
    }))
    const names = new Map(chosen.map((item) => [item.id, item.label.trim() || item.id]))

    const groupId = newGroupId(now)
    const platforms = ctx.params.platforms as PlatformId[]
    const phases = phaseCount(settings, platforms)

    /*
      One row per phone PER PHASE. Phase 0's activities are due from now; a
      later phase starts after the one before it could have finished, computed
      from the longest plan rather than a guess — a phase that overlapped the
      one before would put two activities on one phone at once, which `nextStep`
      would refuse and the operator would read as a stall.
    */
    let written = 0
    let activities = 0
    let skipped = 0
    let phaseStart = now
    const allRuns = []
    for (let phase = 0; phase < phases; phase++) {
      const assignments = planWarmup({ devices, settings, platforms, phase, nowMs: Date.now(), random: Math.random })
      const runs = runsFromPlan({ groupId, assignments, phase, startedAt: phaseStart, names, sequence: settings.sequenceMode })
      let longest = 0
      for (const run of runs) {
        await ctx.storage.global.set(warmupRunKey(groupId, phase, run.deviceId), run)
        written += 1
        activities += run.steps.length
        if (run.steps.length === 0) skipped += 1
        const last = run.steps[run.steps.length - 1]
        if (last) longest = Math.max(longest, last.atSec)
        allRuns.push(run)
      }
      // The next phase begins a gap after the slowest phone of this one.
      phaseStart += longest + settings.gapSec[1] + settings.startJitterSec
    }

    const progress = warmupProgress(allRuns)
    const summary = warmupSummary(progress)
    const group = GroupSchema.parse({
      version: 1,
      id: groupId,
      title,
      createdAt: now,
      platforms,
      assignment: 'one-per-phone',
      // Pacing belongs to a post session; a warm-up's spread is its jitter and its gaps.
      pacing: { order: 'as-listed', concurrency: Math.max(1, devices.length), gapSec: settings.gapSec },
      videoArtifactIds: [],
      kind: 'warmup',
      warmup: settings,
      target,
      summary,
    })
    await ctx.storage.global.set(groupKeyFor(groupId), group)

    ctx.log.info('warm-up session planned', { groupId, title: group.title, devices: written, activities, phases, skipped, outOfScope: resolved.left.length, target: describeTarget(target) })
    return { groupId, title: group.title, devices: written, activities, phases, skipped, outOfScope: resolved.left.length, summary, reused: false }
  },
}

export default script
