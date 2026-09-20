import { drawGap, shuffled, type WarmupSettings } from './groups'
import type { PlatformId } from './platforms'
import { stylesFor, type WarmupDraw, type WarmupStyle } from './warmup-catalog'

/**
 * The warm-up planner (plan 900 D1, D6; wave 2) — who does what, on which
 * platform, in what order, and when.
 *
 * Pure and total: it never calls anything, never throws, and takes `now` and
 * `random` as arguments so a test asserts the plan instead of tolerating it.
 * That is the same shape `planDispatch` has in `posts.ts`, and using it twice
 * is the point of this programme — the composition is plugin code now, not a
 * document for an interpreter.
 *
 * ## The six behaviours this must keep (plan 900 §2 D6)
 *
 * 1. a random per-phone start delay;
 * 2. the fleet split into equal platform groups by the phone's own NUMBER,
 *    shifting daily;
 * 3. phases, so running the session N times covers every phone on every
 *    platform;
 * 4. a weighted style draw inside the platform, redrawn each session;
 * 5. activities shuffled, with a gap drawn per step;
 * 6. every count scaled by `amount`.
 *
 * Each is asserted by name in `warmup.test.ts`, because a rebuild that quietly
 * drops one is the risk this plan was written to carry.
 */

/** Milliseconds in a day, and the offset that makes the rotation turn at local midnight in WIB (UTC+7). */
const DAY_MS = 86_400_000
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000

/** As much of a phone as planning needs. `number` is the durable device number, never a batch position. */
export interface WarmupDevice {
  deviceId: string
  /** `device_numbers.number` — the `#` on the phone's own label. `null` when none is reserved. */
  number: number | null
}

export interface WarmupStep {
  activityId: string
  title: string
  /** The script ref to dispatch, `pack/member@latest`. */
  script: string
  params: Record<string, unknown>
  /** Seconds after the session starts before this step may be dispatched. */
  atSec: number
}

export interface WarmupAssignment {
  deviceId: string
  /** `null` when this phone was given nothing; `note` says why. */
  platform: PlatformId | null
  styleId: string | null
  styleTitle: string | null
  steps: WarmupStep[]
  /** Why this phone got nothing — `null` when it did. */
  note: string | null
}

/**
 * Which platform a phone warms up, or `null` when it has no number.
 *
 * Keyed on `device.number` and NOT on any batch position, and that distinction
 * is the whole reason this function is separate and tested on its own.
 * CLAUDE.md spends a paragraph on it: a batch position is reshuffled by
 * `order: 'random'` and renumbered whenever one phone is offline, so a rotation
 * keyed on it gives some phone the same platform twice and another one never —
 * with three green runs and nothing anywhere able to say so. A device number is
 * the `#` written on the phone's own label and means the same thing tomorrow.
 *
 * `null` for a phone with no number, never 0: rotating an unnumbered phone as
 * if it were number zero is exactly the silent wrong answer this guards.
 */
export function platformFor(input: {
  device: WarmupDevice
  platforms: readonly PlatformId[]
  slot: number
  phase: number
  nowMs: number
}): PlatformId | null {
  const { device, platforms, slot, phase, nowMs } = input
  if (device.number === null || platforms.length === 0) return null
  const day = Math.floor((nowMs + WIB_OFFSET_MS) / DAY_MS)
  const index = (((device.number + slot + phase + day) % platforms.length) + platforms.length) % platforms.length
  return platforms[index] as PlatformId
}

/**
 * Draw one style for a platform, weighted by the operator's settings.
 *
 * A style with no stored weight counts as 1, so a style shipped after an
 * operator saved their settings joins the draw instead of disappearing. A
 * weight of 0 removes it from the draw without removing it from the list, so it
 * can be put back.
 *
 * `null` when every style for this platform is weighted 0 — a deliberate
 * choice by the operator, and one the caller must report rather than quietly
 * substitute a style for.
 */
export function drawStyle(platform: PlatformId, weights: Readonly<Record<string, number>>, random: () => number): WarmupStyle | null {
  const styles = stylesFor(platform)
  const weighted = styles.map((style) => ({ style, weight: weights[style.id] ?? 1 })).filter((entry) => entry.weight > 0)
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0)
  if (total <= 0) return null
  let ticket = random() * total
  for (const entry of weighted) {
    ticket -= entry.weight
    if (ticket < 0) return entry.style
  }
  return weighted[weighted.length - 1]?.style ?? null
}

/**
 * Plan one phase of a warm-up session over a fleet.
 *
 * One assignment per device, always — a phone that gets nothing is returned
 * with `platform: null` and a sentence, because a fleet of eighty where four
 * silently did nothing is the failure mode this plugin exists to avoid.
 */
export function planWarmup(input: {
  devices: readonly WarmupDevice[]
  settings: WarmupSettings
  /** Which platforms this session covers, in a stable order — the rotation indexes into it. */
  platforms: readonly PlatformId[]
  /** 0-based; `settings.phases` says how many there are. */
  phase: number
  nowMs: number
  random: () => number
}): WarmupAssignment[] {
  const { devices, settings, platforms, phase, nowMs, random } = input
  const draw: WarmupDraw = { keywords: settings.keywords, amount: settings.amount, like: settings.like, random }

  return devices.map((device) => {
    const platform = platformFor({ device, platforms, slot: settings.slot, phase, nowMs })
    if (platform === null) {
      return {
        deviceId: device.deviceId,
        platform: null,
        styleId: null,
        styleTitle: null,
        steps: [],
        note: 'This phone has no device number, so its platform cannot be chosen. Reserve a number for it on the Devices page.',
      }
    }
    const style = drawStyle(platform, settings.styleWeights, random)
    if (style === null) {
      return {
        deviceId: device.deviceId,
        platform,
        styleId: null,
        styleTitle: null,
        steps: [],
        note: `Every activity style for ${platform} is turned off in this session's settings, so this phone was given nothing to do.`,
      }
    }

    /*
      The start jitter (D6.1). Not politeness: eighty phones that begin in the
      same second are eighty phones visibly doing the same thing, which is the
      shape a platform looks for. Drawn per phone, before anything is scheduled.
    */
    let atSec = Math.floor(random() * (settings.startJitterSec + 1))
    const steps: WarmupStep[] = []
    for (const item of shuffled(style.activities, random)) {
      steps.push({ activityId: item.id, title: item.title, script: item.script, params: item.params(draw), atSec })
      atSec += drawGap(settings.gapSec, random)
    }
    return { deviceId: device.deviceId, platform, styleId: style.id, styleTitle: style.title, steps, note: null }
  })
}

/**
 * How many phases this session runs, bounded by how many platforms it covers.
 *
 * Asking for three phases over two platforms repeats a platform rather than
 * covering a third that is not there, which is not what "every phone warms up
 * every platform" means to the operator who set it.
 */
export function phaseCount(settings: WarmupSettings, platforms: readonly PlatformId[]): number {
  return Math.max(1, Math.min(settings.phases, platforms.length))
}
