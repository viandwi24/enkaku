import type { PluginMemberScript, ScriptContext } from '@enkaku/sdk'
import { ui } from '@enkaku/sdk'
import { z } from 'zod'
import { PLATFORM_IDS, PlatformIdSchema, platformById, type PlatformId } from './platforms'
import { WarmupTargetSchema } from './warmup-target'
import { describeTarget, reachesNothing, resolveWarmupTarget } from './warmup-target'
import { DeviceListOutput } from './warmup-launch'
import { RECAP_SETTINGS_KEY, RecapRowSchema, RecapSettingsSchema, recapRowKey, type RecapRow } from './recap'

/**
 * `recap-videos` — ask a fleet how its posted videos are doing.
 *
 * ## Why this is a member and not a button
 *
 * The rule this plugin settled on (plan 900): a MEMBER is for work a SCHEDULE
 * must be able to run, because a schedule can only run a script; everything
 * else that needs no phone happens in the browser. A recap is the schedule
 * case — the point of it is a number that is refreshed every day without
 * anyone asking — so it is a member, and the Recap tab's own refresh button
 * calls the same thing.
 *
 * ## Why it sends nothing itself
 *
 * Same three reasons `add-warmup` sends nothing. It marks each phone's row as
 * wanted and returns; the router sends the reads, one per phone at a time,
 * around whatever else that phone is doing. On seventy-three phones and three
 * platforms that is two hundred and nineteen reads, and a member that
 * dispatched them itself would either take the phones away from an upload or
 * sit in a job slot for an hour waiting.
 *
 * The row is not cleared first. A refresh that fails leaves yesterday's
 * numbers where they were, with the failure written beside them — a recap that
 * blanked itself whenever a phone was asleep would be useless exactly on the
 * mornings it matters.
 */

const params = z.object({
  platforms: z
    .array(PlatformIdSchema)
    .min(1)
    .default([...PLATFORM_IDS])
    .describe('Which platforms to read on each phone.')
    .meta(ui({ title: 'Platforms' })),
  maxVideos: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(6)
    .describe('How many of the newest videos to read per account. Videos pushed out of this window keep their last known count.')
    .meta(ui({ title: 'Videos per account' })),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(8)
    .describe('How many phones read at once, across the whole farm. The rest wait their turn; a slot frees the moment a phone answers.')
    .meta(ui({ title: 'Phones at a time' })),
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
  exceptLabels: z.array(z.string().min(1).max(60)).max(20).default([]).describe('Any phone carrying one of these is left out.').meta(ui({ title: 'Except these labels' })),
  exceptGroups: z.array(z.string().min(1).max(60)).max(20).default([]).describe('Any phone in one of these is left out.').meta(ui({ title: 'Except these device groups' })),
})

const result = z.object({
  devices: z.number().int().describe('Phones this recap covers.').meta(ui({ title: 'Phones', summary: true })),
  reads: z.number().int().describe('Reads queued — one per phone per platform.').meta(ui({ title: 'Reads queued', summary: true })),
  alreadyReading: z.number().int().describe('Reads already out from an earlier run, left alone.').meta(ui({ title: 'Already reading' })),
  outOfScope: z.number().int().describe('Phones this recap does not cover.').meta(ui({ title: 'Out of scope' })),
  summary: z.string().meta(ui({ title: 'Summary' })),
})

const script: PluginMemberScript<typeof params, typeof result> = {
  id: 'recap-videos',
  title: 'Recap videos',
  description: 'Asks the phones you choose how many views each of their newest posts has, on each platform. The reads go out around whatever else the phones are doing, and a phone that cannot answer keeps its last numbers.',
  icon: 'gauge',
  params,
  result,
  timeout: 120_000,

  async run(ctx: ScriptContext<z.infer<typeof params>>) {
    const now = Math.floor(Date.now() / 1000)
    const target = WarmupTargetSchema.parse({
      mode: ctx.params.targetMode,
      labels: ctx.params.targetLabels,
      groups: ctx.params.targetGroups,
      deviceIds: ctx.params.targetDeviceIds,
      exceptLabels: ctx.params.exceptLabels,
      exceptGroups: ctx.params.exceptGroups,
      exceptDeviceIds: ctx.params.exceptDeviceIds,
    })
    if (reachesNothing(target)) {
      throw Object.assign(new Error(`${describeTarget(target)} — this recap would reach no phone at all. Choose "Every phone", or name what it should cover.`), { code: 'E_PARAMS_INVALID' })
    }

    const fleet = await ctx.farm.call('device.list', {}, DeviceListOutput)
    const resolved = resolveWarmupTarget<z.infer<typeof DeviceListOutput>['items'][number]>(fleet.items, target)
    if (resolved.chosen.length === 0) {
      const why = fleet.items.length === 0 ? 'This farm has no phones to recap.' : `${describeTarget(target)} — no phone on this farm matches. ${resolved.left[0]?.reason ?? ''}`.trim()
      throw Object.assign(new Error(why), { code: 'E_NO_DEVICES' })
    }

    /*
      The pacing is a property of the FARM, not of this run, so it lives in one
      settings row the router reads each tick rather than on eighty rows that
      could disagree. Written before any row is marked wanted, so the very
      first tick after this member already honours it.
    */
    await ctx.storage.global.set(RECAP_SETTINGS_KEY, RecapSettingsSchema.parse({ version: 1, concurrency: ctx.params.concurrency }))

    const platforms = ctx.params.platforms as PlatformId[]
    let reads = 0
    let alreadyReading = 0
    for (const item of resolved.chosen) {
      const name = item.label.trim() || item.id
      for (const platform of platforms) {
        const key = recapRowKey(platform, item.id)
        let existing: RecapRow | null = null
        try {
          existing = await ctx.storage.global.get(key, RecapRowSchema)
        } catch {
          /*
            A row this build cannot parse is replaced rather than left, and the
            history in it is lost. That is the right way round here: a recap
            row is a CACHE of what the phones said, and the phones can be asked
            again — unlike a warm-up row, which is the only record that an
            activity was ever dispatched.
          */
          existing = null
        }
        /*
          A read already out is left exactly as it is. Re-marking it would not
          send a second one — the router only sends rows with no job — but it
          would reset `readAt` and make a stuck read look fresh every time
          somebody pressed refresh.
        */
        if (existing?.state === 'reading' && existing.jobId !== '') {
          alreadyReading += 1
          continue
        }
        const row: RecapRow = RecapRowSchema.parse({
          ...(existing ?? {}),
          version: 1,
          platform,
          deviceId: item.id,
          deviceName: name,
          account: existing?.account ?? '',
          readAt: now,
          syncedAt: existing?.syncedAt ?? 0,
          state: 'reading',
          note: '',
          jobId: '',
          videos: existing?.videos ?? [],
          truncated: existing?.truncated ?? false,
          window: existing?.window ?? 0,
          asked: ctx.params.maxVideos,
        })
        await ctx.storage.global.set(key, row)
        reads += 1
      }
    }

    const names = platforms.map((id) => platformById(id)?.title ?? id).join(', ')
    const summary = `${resolved.chosen.length} phone${resolved.chosen.length === 1 ? '' : 's'} × ${names} — ${reads} read${reads === 1 ? '' : 's'} queued, ${ctx.params.concurrency} at a time${alreadyReading > 0 ? `, ${alreadyReading} already out` : ''}`
    ctx.log.info('recap queued', { devices: resolved.chosen.length, reads, alreadyReading, target: describeTarget(target) })
    return { devices: resolved.chosen.length, reads, alreadyReading, outOfScope: resolved.left.length, summary }
  },
}

export default script
