import type { ControlQuality, Quality, VideoNumbers, WallQuality } from '@enkaku/protocol'

/**
 * Preset tables (plan 92 §3.6, §4.2; kept byte-identical by plan 212 §4.5's
 * preset-only model). `control.sharp` and `wall.balanced` are the
 * pre-plan-92 `QUALITY_PROFILES` constants, unchanged.
 */
export const CONTROL_PRESETS: Record<ControlQuality, VideoNumbers> = {
  sharp: { maxSize: 1600, maxFps: 30, bitRate: 4_000_000 },
  balanced: { maxSize: 1080, maxFps: 30, bitRate: 2_500_000 },
  light: { maxSize: 720, maxFps: 20, bitRate: 1_200_000 },
}
/**
 * Plan 100 §3.4 (step 100.2), raised again at step 100.8 — unchanged by
 * plan 212. See git history for the fps/size reasoning; the hardware
 * ladder that would revise these is plan 223's own §7.3.
 */
export const WALL_PRESETS: Record<WallQuality, VideoNumbers> = {
  minimal: { maxSize: 240, maxFps: 10, bitRate: 350_000 },
  light: { maxSize: 320, maxFps: 14, bitRate: 650_000 },
  balanced: { maxSize: 480, maxFps: 18, bitRate: 1_100_000 },
  detailed: { maxSize: 640, maxFps: 22, bitRate: 1_500_000 },
}

/**
 * Where one resolved number came from, for the Studio readout (plan 92
 * §3.9; reduced by plan 212 §4.5 — there is no more numeric override to
 * produce a "customized" source, only a named preset or a per-device
 * override).
 */
export type VideoSource = 'preset' | 'device'

export interface VideoProfile extends VideoNumbers {
  quality: Quality
  /** Where each number came from, for the readout. */
  source: { maxSize: VideoSource; maxFps: VideoSource; bitRate: VideoSource }
}

const sourceFor = (fromDevice: boolean): VideoProfile['source'] => {
  const s: VideoSource = fromDevice ? 'device' : 'preset'
  return { maxSize: s, maxFps: s, bitRate: s }
}

/**
 * The ONE place a farm's video quality and a device's own override are
 * combined (plan 92 §3.5, §4.2; reduced to a preset-only model by plan 212
 * §4.5). Precedence: device override → farm quality → preset table. Pure —
 * no clock, no I/O, no settings store read inside.
 */
export function resolveVideoProfile(
  farm: { controlQuality: ControlQuality; wallQuality: WallQuality },
  device: { controlQuality?: ControlQuality; wallQuality?: WallQuality } | null,
  quality: Quality,
): VideoProfile {
  if (quality === 'control') {
    const name = device?.controlQuality ?? farm.controlQuality
    const numbers = CONTROL_PRESETS[name]
    return { quality, ...numbers, source: sourceFor(device?.controlQuality !== undefined) }
  }
  const name = device?.wallQuality ?? farm.wallQuality
  const numbers = WALL_PRESETS[name]
  return { quality, ...numbers, source: sourceFor(device?.wallQuality !== undefined) }
}

/** True when two profiles would produce a different encoder. Ignores `source` and `quality`. */
export function sameVideoNumbers(a: VideoNumbers, b: VideoNumbers): boolean {
  return a.maxSize === b.maxSize && a.maxFps === b.maxFps && a.bitRate === b.bitRate
}

/**
 * Plan 100 §3.1, §4.1 — the two independent bounds `computeAutoTiles`
 * combines with `min`. Resolved once per call site from farm settings plus
 * a transport classification (loopback/LAN vs. cloud/WAN, `WallTransport`
 * below) — this module stays a pure function of whatever `WallBudget` it is
 * given.
 */
export interface WallBudget {
  /**
   * Concurrent decode sessions one browser tab is assumed able to hold
   * without dropped frames — applied ALWAYS, regardless of transport,
   * because decode cost is a browser-tab constraint, not a network one.
   * `WALL_DECODE_TILE_CEILING` (`packages/core/src/config/constants.ts`)
   * ships at 24 — still plan 100 §7.3's unmeasured placeholder, revisited
   * by plan 223.
   */
  decodeTileCeiling: number
  /**
   * Bits/sec assumed available to one browser tab. Only meaningfully
   * binding when the transport is actually WAN (cloud mode) — on
   * loopback/LAN this is `WALL_LAN_BANDWIDTH_BPS`'s own generous default
   * (200 Mbit/s), so it essentially never binds there.
   */
  bandwidthBps: number
}

/** Where a wall tab's browser is assumed to be relative to the core (plan 100 §3.1, §4.1). */
export type WallTransport = 'loopback' | 'lan' | 'wan'

/**
 * Plan 100 §3.1, §4.1, step 100.3 — the transport classification itself,
 * derived "the same way auth mode already is": orchestrator/cloud mode
 * reads as `wan`, everything else as `loopback`. The farm's
 * `advanced` wall-transport override (`'auto'` by default) wins outright
 * when set to anything else. `'lan'` is reachable ONLY via an explicit
 * override — there is no local signal that distinguishes true loopback
 * from a same-subnet LAN link.
 */
export function resolveWallTransport(isOrchestrator: boolean, override: WallTransport | 'auto'): WallTransport {
  if (override !== 'auto') return override
  return isOrchestrator ? 'wan' : 'loopback'
}

/**
 * The bandwidth HALF of `WallBudget`, transport-aware (plan 100 §3.1, §3.6,
 * §4.1, step 100.3; plan 212 §212.5 turns the WAN branch's pinned number
 * into a caller-supplied one — `advanced.wallWanBandwidthBps`, so the
 * hard-coded `WALL_VIDEO_BUDGET_BPS` constant is gone). `loopback`/`lan`
 * use the LAN constant instead — it essentially never binds there, which is
 * the whole point: the decode bound is what actually governs a local wall.
 */
export function resolveWallBandwidthBps(transport: WallTransport, wanBandwidthBps: number, lanBandwidthBps: number): number {
  return transport === 'wan' ? wanBandwidthBps : lanBandwidthBps
}

/**
 * `wall.maxTiles: 0` (auto) — the min of a decode bound and a bandwidth
 * bound (plan 100 §3.1, §4.1, amending plan 92 §3.7's single-bound
 * version). Clamped to [4, 32]: a wall of fewer than 4 tiles is not a
 * wall, and more than 32 decoders in one tab is the frame-cost risk plan
 * 100 §7.3 measures.
 */
export function computeAutoTiles(wallBitRate: number, budget: WallBudget): number {
  const decodeBound = budget.decodeTileCeiling
  const bandwidthBound = Math.floor(budget.bandwidthBps / wallBitRate)
  return Math.min(32, Math.max(4, Math.min(decodeBound, bandwidthBound)))
}
