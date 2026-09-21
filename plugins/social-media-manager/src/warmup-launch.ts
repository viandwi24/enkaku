import type { ScriptContext } from '@enkaku/sdk'
import { z } from 'zod'
import { PLATFORMS, deviceCarriesPlatform, type PlatformId } from './platforms'
import type { WarmupSettings } from './groups'
import { phaseCount, planWarmup, type WarmupDevice } from './warmup'
import { LEGACY_RUN_ID, newRunId, runsFromPlan, warmupProgress, warmupRowKey, warmupSummary, type WarmupRow } from './warmup-rows'
import { describeTarget, reachesNothing, resolveWarmupTarget, type WarmupTarget } from './warmup-target'

/**
 * Starting a warm-up — the part that is the same whether the session is new or
 * being started again (0.58.0).
 *
 * ## Why this exists
 *
 * A warm-up session used to BE its execution: `add-warmup` planned the fleet,
 * wrote the rows, and that was the session for ever. The owner asked for the
 * obvious next thing — *"saya jalanin 20 sep 2026 10:00 ... terus misalnya
 * saya bisa jalanin lagi di tanggal 21 sep 2026 11:00 ... jadi kaya ada
 * history kemarin tanggal 20 masih ada, tapi tanggal 21 juga ada juga"* — so a
 * session is now a DEFINITION and each start is a RUN with its own rows, its
 * own progress and its own history.
 *
 * Two members call this: `add-warmup` (make the definition, then run it once)
 * and `run-warmup` (run an existing one again). They must plan identically, so
 * they share this rather than each keeping a copy that drifts.
 *
 * ## What a run draws fresh, and what it inherits
 *
 * Everything random is drawn again — the platform each phone gets, its style,
 * the order of its activities, its start jitter, its gaps. That is the point:
 * two runs of one session are two different evenings, not the same evening
 * replayed. What it inherits is the DECISION — which phones, which platforms,
 * how many activities, how long to watch — because that is what the operator
 * wrote down and does not want to write again.
 *
 * The rotation slot is drawn per RUN too, so a session started twice in a day
 * sends its phones to different platforms the second time.
 */

/** What `device.list` must give back for a run to be planned. */
export const DeviceListOutput = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      labels: z.array(z.object({ name: z.string() })).default([]),
      label: z.string().default(''),
      number: z.number().int().nullable().default(null),
      group: z.object({ id: z.string(), name: z.string() }).nullable().default(null),
    }),
  ),
})

export interface LaunchResult {
  runId: string
  /** Phones given a row. */
  devices: number
  activities: number
  phases: number
  /** Phones given a row but nothing to do — each row says why. */
  skipped: number
  /** Phones the target left out entirely; they get no row. */
  outOfScope: number
  summary: string
}

/**
 * Plan one run over the fleet and write its rows.
 *
 * Throws `E_PARAMS_INVALID` when the target reaches nothing by construction and
 * `E_NO_DEVICES` when it reaches nothing on this farm — both BEFORE anything is
 * written, so a refused run leaves no half-planned session behind.
 */
export async function launchWarmupRun(
  ctx: Pick<ScriptContext<Record<string, never>>, 'farm' | 'storage' | 'log'>,
  input: { groupId: string; settings: WarmupSettings; platforms: readonly PlatformId[]; target: WarmupTarget; now: number; runId?: string },
): Promise<LaunchResult> {
  const { groupId, settings, target, now } = input
  const platforms = [...input.platforms]
  const runId = input.runId ?? newRunId(now)

  if (reachesNothing(target)) {
    throw Object.assign(new Error(`${describeTarget(target)} — this run would reach no phone at all. Choose "Every phone", or name what it should cover.`), { code: 'E_PARAMS_INVALID' })
  }

  const fleet = await ctx.farm.call('device.list', {}, DeviceListOutput)
  const resolved = resolveWarmupTarget<z.infer<typeof DeviceListOutput>['items'][number]>(fleet.items, target)
  if (resolved.chosen.length === 0) {
    const why = fleet.items.length === 0 ? 'This farm has no phones to warm up.' : `${describeTarget(target)} — no phone on this farm matches. ${resolved.left[0]?.reason ?? ''}`.trim()
    throw Object.assign(new Error(why), { code: 'E_NO_DEVICES' })
  }

  /*
    What each phone is KNOWN for. Since 0.57.3 this orders the platforms and
    never narrows them — the operator's choice of phones is the choice.
  */
  const devices: WarmupDevice[] = resolved.chosen.map((item) => ({
    deviceId: item.id,
    number: item.number,
    platforms: PLATFORMS.filter((platform) => deviceCarriesPlatform(item.labels, platform)).map((platform) => platform.id),
  }))
  const names = new Map(resolved.chosen.map((item) => [item.id, item.label.trim() || item.id]))
  const phases = phaseCount(settings, platforms)

  /*
    One row per phone PER PHASE. Phase 0's activities are due from now; a later
    phase starts after the one before it could have finished, computed from the
    longest plan rather than a guess — a phase that overlapped the one before
    would put two activities on one phone at once, which `nextStep` would refuse
    and the operator would read as a stall.
  */
  let written = 0
  let activities = 0
  let skipped = 0
  let phaseStart = now
  const all: WarmupRow[] = []
  /*
    The queue's order (0.64.0): a shuffle of the phones, drawn once for the run and shared by all of a
    phone's phases, so the order is random — no phone is always first — and stays what it was.
  */
  const order = resolved.chosen.map((item) => item.id)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[order[i], order[j]] = [order[j] as string, order[i] as string]
  }
  const queueSeq = new Map(order.map((id, i) => [id, i]))
  for (let phase = 0; phase < phases; phase++) {
    const assignments = planWarmup({ devices, settings, platforms, phase, nowMs: Date.now(), random: Math.random })
    const rows = runsFromPlan({ groupId, runId, assignments, phase, startedAt: phaseStart, names, sequence: settings.sequenceMode, queueSeq })
    let longest = 0
    for (const row of rows) {
      await ctx.storage.global.set(warmupRowKey(groupId, runId, phase, row.deviceId), row)
      written += 1
      activities += row.steps.length
      if (row.steps.length === 0) skipped += 1
      const last = row.steps[row.steps.length - 1]
      if (last) longest = Math.max(longest, last.atSec)
      all.push(row)
    }
    // The next phase begins a gap after the slowest phone of this one.
    phaseStart += longest + settings.gapSec[1] + settings.startJitterSec
  }

  const summary = warmupSummary(warmupProgress(all))
  ctx.log.info('warm-up run planned', { groupId, runId, devices: written, activities, phases, skipped, outOfScope: resolved.left.length, target: describeTarget(target) })
  return { runId, devices: written, activities, phases, skipped, outOfScope: resolved.left.length, summary }
}

export { LEGACY_RUN_ID }
