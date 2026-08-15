import type { ControlPreset, DeviceSettings, FarmSettings, Quality, VideoNumbers, WallPreset } from '@enkaku/protocol'

/**
 * Preset tables (plan 92 §3.6, §4.2) — the values behind each named preset.
 * `control.sharp` and `wall.balanced` are the pre-plan-92 `QUALITY_PROFILES`
 * constants (`packages/session/src/session.ts`, deleted by this plan),
 * unchanged: `control` was `{ maxSize: 1600, maxFps: 30, bitRate: 4_000_000 }`,
 * `wall` was `{ maxSize: 480, maxFps: 5, bitRate: 800_000 }`. Pinned here so a
 * farm that changes no video setting sees byte-identical scrcpy arguments
 * after this plan — the whole safety of step 92.1, checked by
 * `video-profile.test.ts`.
 */
export const CONTROL_PRESETS: Record<ControlPreset, VideoNumbers> = {
  sharp: { maxSize: 1600, maxFps: 30, bitRate: 4_000_000 },
  balanced: { maxSize: 1080, maxFps: 30, bitRate: 2_500_000 },
  light: { maxSize: 720, maxFps: 20, bitRate: 1_200_000 },
}
/**
 * Plan 100 §3.4 (step 100.2) — replaces the pre-plan-100 table (`detailed`
 * 720px·8fps·1.5M, `balanced` 480px·5fps·800k, `light` 320px·3fps·400k,
 * `minimal` 240px·2fps·200k). The owner's binding decision: raise frame rate
 * and sharpness AT TILE SIZE, never raw resolution — a wall tile renders
 * small (`TILE_SIZE_PX.l` is 260px wide, `packages/studio/src/lib/prefs.ts`),
 * so spending bits on pixels nobody can see, at the cost of the fps
 * everybody can, was the mistake the old table made. `detailed` moves
 * 720px → 640px on purpose (closer to what an `l` tile actually renders)
 * while fps rises further — "detailed" means smoother and sharper at the
 * size it is shown, not bigger. Bitrates rise modestly alongside fps (more
 * frames need somewhat more data to avoid new-frame blockiness), not because
 * resolution grew.
 *
 * **Step 100.8 raised every preset's fps a second time**, now that step
 * 100.3 made a loopback/LAN wall's tile budget decode-bound rather than
 * bandwidth-bound: 100.2's `balanced` (12fps) was itself still a compromise
 * with the OLD bandwidth-only budget — every extra frame per second cost
 * live tiles, so 12 was chosen conservative. That trade no longer exists on
 * the default (loopback) deployment: `wall.decodeTileCeiling` (24, itself
 * still §7.3's placeholder) is what now governs tile count, and it does not
 * move when fps rises — a 480px tile's decode cost at 18fps is far below one
 * Control-sized (1600px) stream's cost at 30fps, which is the case the
 * 32-decoder worry (§7.3) was actually written about. **These fps numbers
 * are themselves an INTERIM raise, not a measured result** — the ceiling
 * they can safely be pushed to is §7.3/H-1's hardware ladder to establish
 * (`docs/plans/100-m65-realtime-wall-and-session-parity.md` §100.7's own
 * procedure), and this table should be revisited once that has run. Bitrates
 * rise again alongside fps, same reasoning as 100.2's own bump.
 */
export const WALL_PRESETS: Record<WallPreset, VideoNumbers> = {
  minimal: { maxSize: 240, maxFps: 10, bitRate: 350_000 },
  light: { maxSize: 320, maxFps: 14, bitRate: 650_000 },
  balanced: { maxSize: 480, maxFps: 18, bitRate: 1_100_000 },
  detailed: { maxSize: 640, maxFps: 22, bitRate: 1_500_000 },
}

/** Where one resolved number came from, for the Studio readout (plan 92 §3.9, §4.2). */
export type VideoSource = 'preset' | 'farm' | 'device'

export interface VideoProfile extends VideoNumbers {
  quality: Quality
  /** Where each number came from, for the readout. */
  source: { maxSize: VideoSource; maxFps: VideoSource; bitRate: VideoSource }
}

/**
 * Decide one number's `VideoSource`: a device override always wins and is
 * reported as `'device'`; otherwise the farm's own stored value is compared
 * against what the currently-selected preset would produce — equal reads as
 * `'preset'` (nobody has touched the Advanced field, or touched it back to
 * the same number, which plan 92 §3.6's "no redundant state" design
 * deliberately cannot tell apart), different reads as `'farm'` (an operator
 * typed a number into the Advanced reveal).
 */
function sourceOf(deviceValue: number | undefined, farmValue: number, presetValue: number): VideoSource {
  if (deviceValue !== undefined) return 'device'
  return farmValue === presetValue ? 'preset' : 'farm'
}

/**
 * The ONE place farm video settings and a device's own override are combined
 * (plan 92 §3.5, §4.2). Precedence, most specific first: device field → farm
 * field → preset table. Pure — no clock, no I/O, no settings store read
 * inside — so `reprofile`'s comparison (plan 92 §3.8, a later step) and the
 * Studio readout (§3.9) can both call it and can never disagree with each
 * other or with what actually reaches scrcpy.
 */
export function resolveVideoProfile(farm: FarmSettings['video'], device: DeviceSettings['video'] | null, quality: Quality): VideoProfile {
  if (quality === 'control') {
    const preset = CONTROL_PRESETS[farm.controlPreset]
    const maxSize = device?.controlMaxSize ?? farm.controlMaxSize
    const maxFps = device?.controlMaxFps ?? farm.controlMaxFps
    const bitRate = device?.controlBitRate ?? farm.controlBitRate
    return {
      quality,
      maxSize,
      maxFps,
      bitRate,
      source: {
        maxSize: sourceOf(device?.controlMaxSize, farm.controlMaxSize, preset.maxSize),
        maxFps: sourceOf(device?.controlMaxFps, farm.controlMaxFps, preset.maxFps),
        bitRate: sourceOf(device?.controlBitRate, farm.controlBitRate, preset.bitRate),
      },
    }
  }

  const preset = WALL_PRESETS[farm.wallPreset]
  const maxSize = device?.wallMaxSize ?? farm.wallMaxSize
  const maxFps = device?.wallMaxFps ?? farm.wallMaxFps
  const bitRate = device?.wallBitRate ?? farm.wallBitRate
  return {
    quality,
    maxSize,
    maxFps,
    bitRate,
    source: {
      maxSize: sourceOf(device?.wallMaxSize, farm.wallMaxSize, preset.maxSize),
      maxFps: sourceOf(device?.wallMaxFps, farm.wallMaxFps, preset.maxFps),
      bitRate: sourceOf(device?.wallBitRate, farm.wallBitRate, preset.bitRate),
    },
  }
}

/** True when two profiles would produce a different encoder. Ignores `source` and `quality`. */
export function sameVideoNumbers(a: VideoNumbers, b: VideoNumbers): boolean {
  return a.maxSize === b.maxSize && a.maxFps === b.maxFps && a.bitRate === b.bitRate
}

/**
 * The pre-plan-100 bandwidth-only budget, in bits per second (plan 92 §3.7).
 * Kept as a named constant — plan 100 §4.1 pins the WAN/cloud branch to this
 * EXACT number, hard-coded rather than read off `WallBudget.bandwidthBps`,
 * specifically so a cloud farm's tile budget stays provably byte-identical
 * to its pre-plan-100 behaviour (§3.6) no matter what an operator sets the
 * new `wall.bandwidthBps` farm setting to. Not used for loopback/LAN
 * anymore — those transports use `WallBudget.bandwidthBps` instead, which
 * defaults far higher (§3.1) because a loopback link has no real bandwidth
 * problem to protect against.
 */
export const WALL_VIDEO_BUDGET_BPS = 20_000_000

/**
 * Plan 100 §3.1, §4.1 — the two independent bounds `computeAutoTiles` now
 * combines with `min`, replacing the single bandwidth-only budget above.
 * Resolved once per call site from farm settings plus a transport
 * classification (loopback/LAN vs. cloud/WAN, `WallTransport` below) —
 * `packages/core/src/api/adb-stats.ts` and the Studio settings projection
 * are where that resolution happens (plan 100 step 100.3), not here: this
 * module stays a pure function of whatever `WallBudget` it is given.
 */
export interface WallBudget {
  /**
   * Concurrent decode sessions one browser tab is assumed able to hold
   * without dropped frames — applied ALWAYS, regardless of transport,
   * because decode cost is a browser-tab constraint, not a network one.
   * Seeded from plan 100 §7.3's hardware ladder; ships at 24 (plan 100
   * §3.3's own chosen placeholder — a number below the `computeAutoTiles`
   * clamp's own [4, 32] ceiling, not derived by any formula from either
   * bound, `packages/protocol/src/settings.ts`'s `wall.decodeTileCeiling`)
   * until that ladder has run — a documented placeholder, not a guess
   * dressed up as a measurement.
   */
  decodeTileCeiling: number
  /**
   * Bits/sec assumed available to one browser tab. Only meaningfully
   * binding when the transport is actually WAN (cloud mode) — see
   * `WALL_VIDEO_BUDGET_BPS` above for why the WAN branch does not read this
   * field at all. On loopback/LAN this is `wall.bandwidthBps`'s own
   * generous default (200 Mbit/s, plan 100 §3.1) so it essentially never
   * binds there — the decode bound above is what actually governs a local
   * wall.
   */
  bandwidthBps: number
}

/** Where a wall tab's browser is assumed to be relative to the core (plan 100 §3.1, §4.1). */
export type WallTransport = 'loopback' | 'lan' | 'wan'

/**
 * Plan 100 §3.1, §4.1, step 100.3 — the transport classification itself,
 * derived "the same way auth mode already is" (CLAUDE.md: "Auth mode
 * derives from the bind address"): orchestrator/cloud mode reads as `wan`,
 * everything else as `loopback`. `wall.transportOverride` (an explicit farm
 * setting, `'auto'` by default) wins outright when set to anything else —
 * this function never guesses from a request header, which could be spoofed
 * or simply wrong behind a reverse proxy. `'lan'` is reachable ONLY via an
 * explicit override: there is no local signal that distinguishes true
 * loopback from a same-subnet LAN link, so auto-derivation never produces it
 * on its own — an operator who knows their deployment is LAN, not loopback,
 * says so explicitly.
 */
export function resolveWallTransport(isOrchestrator: boolean, override: WallTransport | 'auto'): WallTransport {
  if (override !== 'auto') return override
  return isOrchestrator ? 'wan' : 'loopback'
}

/**
 * Plan 100 §3.1, §4.1, step 100.3 — the bandwidth HALF of `WallBudget`,
 * transport-aware: `wan` is hard-pinned to `WALL_VIDEO_BUDGET_BPS` (the
 * pre-plan-100 20 Mbit/s constant), never the farm's own `wall.bandwidthBps`
 * setting, specifically so a cloud farm's tile budget stays provably
 * byte-identical to its pre-plan-100 behaviour (§3.6) no matter what an
 * operator sets that farm setting to. `loopback`/`lan` use the farm's own
 * generous setting instead (§3.1) — it essentially never binds there, which
 * is the whole point: the decode bound is what actually governs a local wall.
 */
export function resolveWallBandwidthBps(transport: WallTransport, farmBandwidthBps: number): number {
  return transport === 'wan' ? WALL_VIDEO_BUDGET_BPS : farmBandwidthBps
}

/**
 * `wall.maxTiles: 0` (auto) — now the min of a decode bound and a bandwidth
 * bound (plan 100 §3.1, §4.1, amending plan 92 §3.7's single-bound version).
 * Still one clamped pure function, still following the "a non-zero setting
 * always wins" convention plan 85 and plan 92 both used. Clamped to [4, 32]:
 * a wall of fewer than 4 tiles is not a wall, and more than 32 decoders in
 * one tab is the frame-cost risk plan 92 §7.3 named and plan 100 §7.3
 * actually measures.
 */
export function computeAutoTiles(wallBitRate: number, budget: WallBudget): number {
  const decodeBound = budget.decodeTileCeiling
  const bandwidthBound = Math.floor(budget.bandwidthBps / wallBitRate)
  return Math.min(32, Math.max(4, Math.min(decodeBound, bandwidthBound)))
}
