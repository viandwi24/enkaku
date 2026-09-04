import { describe, expect, test } from 'bun:test'
import {
  CONTROL_PRESETS,
  WALL_PRESETS,
  computeAutoTiles,
  resolveVideoProfile,
  resolveWallBandwidthBps,
  resolveWallTransport,
  sameVideoNumbers,
  type WallBudget,
} from './video-profile'

/**
 * Plan 92 §4.2, step 92.1 — the whole safety of this step, per its own
 * brief: "Pin the current values from the real `QUALITY_PROFILES` before
 * you delete them, and let the test compare against those pinned numbers."
 * `control` is still pinned to the literal, hand-copied pre-plan-92 numbers.
 * `wall` is now pinned to plan 100 §3.4's revised numbers instead.
 */
const PRE_PLAN_92_QUALITY_PROFILES = {
  control: { maxSize: 1600, maxFps: 30, bitRate: 4_000_000 },
}

const PRE_PLAN_100_WALL_BALANCED = { maxSize: 480, maxFps: 5, bitRate: 800_000 }

describe('CONTROL_PRESETS / WALL_PRESETS — pinned literal numbers (plan 92 §4.2; wall table revised by plan 100 §3.4)', () => {
  test('CONTROL_PRESETS.sharp is byte-identical to the old control constant (plan 100 does not touch control)', () => {
    expect(CONTROL_PRESETS.sharp).toEqual(PRE_PLAN_92_QUALITY_PROFILES.control)
  })

  test('WALL_PRESETS.balanced is the plan 100 step 100.8 table exactly: 480 px · 18 fps · 1.1 Mbit/s', () => {
    expect(WALL_PRESETS.balanced).toEqual({ maxSize: 480, maxFps: 18, bitRate: 1_100_000 })
  })

  test('WALL_PRESETS.balanced is genuinely different from the pre-plan-100 slideshow default — the fix this step ships', () => {
    expect(WALL_PRESETS.balanced).not.toEqual(PRE_PLAN_100_WALL_BALANCED)
    expect(WALL_PRESETS.balanced.maxFps).toBeGreaterThan(PRE_PLAN_100_WALL_BALANCED.maxFps)
  })

  test('every other wall preset matches plan 100 step 100.8\'s table exactly', () => {
    expect(WALL_PRESETS.minimal).toEqual({ maxSize: 240, maxFps: 10, bitRate: 350_000 })
    expect(WALL_PRESETS.light).toEqual({ maxSize: 320, maxFps: 14, bitRate: 650_000 })
    expect(WALL_PRESETS.detailed).toEqual({ maxSize: 640, maxFps: 22, bitRate: 1_500_000 })
  })

  test('fps rises monotonically minimal -> light -> balanced -> detailed (the owner\'s binding decision: fps is the smoothness lever)', () => {
    expect(WALL_PRESETS.minimal.maxFps).toBeLessThan(WALL_PRESETS.light.maxFps)
    expect(WALL_PRESETS.light.maxFps).toBeLessThan(WALL_PRESETS.balanced.maxFps)
    expect(WALL_PRESETS.balanced.maxFps).toBeLessThan(WALL_PRESETS.detailed.maxFps)
  })

  test('no wall preset reaches the 24 fps NFR floor reserved for control (spec §16) — wall stays visibly distinct from control', () => {
    for (const p of Object.values(WALL_PRESETS)) {
      expect(p.maxFps).toBeLessThan(24)
    }
  })

  test('every other preset is a genuinely distinct set of numbers (no accidental duplicate rows)', () => {
    const controlRows = Object.values(CONTROL_PRESETS).map((p) => JSON.stringify(p))
    expect(new Set(controlRows).size).toBe(controlRows.length)
    const wallRows = Object.values(WALL_PRESETS).map((p) => JSON.stringify(p))
    expect(new Set(wallRows).size).toBe(wallRows.length)
  })
})

describe('resolveVideoProfile — preset-only model (plan 212 §4.5): a device override or the farm quality name, never a numeric farm override', () => {
  test('control, farm "sharp", no device override: max_size 1600 · max_fps 30 · video_bit_rate 4000000', () => {
    const profile = resolveVideoProfile({ controlQuality: 'sharp', wallQuality: 'balanced' }, null, 'control')
    expect(profile.maxSize).toBe(1600)
    expect(profile.maxFps).toBe(30)
    expect(profile.bitRate).toBe(4_000_000)
    expect(profile.quality).toBe('control')
    expect(profile.source).toEqual({ maxSize: 'preset', maxFps: 'preset', bitRate: 'preset' })
  })

  test('wall, farm "balanced", no device override: max_size 480 · max_fps 18 · video_bit_rate 1100000 (plan 100 step 100.8)', () => {
    const profile = resolveVideoProfile({ controlQuality: 'sharp', wallQuality: 'balanced' }, null, 'wall')
    expect(profile.maxSize).toBe(480)
    expect(profile.maxFps).toBe(18)
    expect(profile.bitRate).toBe(1_100_000)
    expect(profile.quality).toBe('wall')
    expect(profile.source).toEqual({ maxSize: 'preset', maxFps: 'preset', bitRate: 'preset' })
  })

  test('every preset name resolves to its exact table row', () => {
    for (const name of Object.keys(CONTROL_PRESETS) as Array<keyof typeof CONTROL_PRESETS>) {
      const profile = resolveVideoProfile({ controlQuality: name, wallQuality: 'balanced' }, null, 'control')
      expect({ maxSize: profile.maxSize, maxFps: profile.maxFps, bitRate: profile.bitRate }).toEqual(CONTROL_PRESETS[name])
    }
    for (const name of Object.keys(WALL_PRESETS) as Array<keyof typeof WALL_PRESETS>) {
      const profile = resolveVideoProfile({ controlQuality: 'sharp', wallQuality: name }, null, 'wall')
      expect({ maxSize: profile.maxSize, maxFps: profile.maxFps, bitRate: profile.bitRate }).toEqual(WALL_PRESETS[name])
    }
  })

  test('a device override wins over the farm quality, and reports "device"', () => {
    const profile = resolveVideoProfile({ controlQuality: 'sharp', wallQuality: 'balanced' }, { wallQuality: 'minimal' }, 'wall')
    expect({ maxSize: profile.maxSize, maxFps: profile.maxFps, bitRate: profile.bitRate }).toEqual(WALL_PRESETS.minimal)
    expect(profile.source).toEqual({ maxSize: 'device', maxFps: 'device', bitRate: 'device' })
  })

  test('a null device (no row, or no override at all) behaves exactly like an empty object', () => {
    const farm = { controlQuality: 'sharp' as const, wallQuality: 'balanced' as const }
    expect(resolveVideoProfile(farm, null, 'control')).toEqual(resolveVideoProfile(farm, {}, 'control'))
  })

  test('control and wall device overrides are independent — a wall override never leaks into a control resolution', () => {
    const profile = resolveVideoProfile({ controlQuality: 'sharp', wallQuality: 'balanced' }, { wallQuality: 'minimal' }, 'control')
    expect(profile.maxFps).toBe(30) // untouched — the override was for `wall`, not `control`
    expect(profile.source.maxFps).toBe('preset')
  })
})

describe('sameVideoNumbers — ignores source and quality (plan 92 §4.2)', () => {
  test('two profiles with identical numbers but different quality/source are still "same"', () => {
    const a = resolveVideoProfile({ controlQuality: 'sharp', wallQuality: 'balanced' }, null, 'control')
    const b = { maxSize: a.maxSize, maxFps: a.maxFps, bitRate: a.bitRate }
    expect(sameVideoNumbers(a, b)).toBe(true)
  })

  test('a single differing number makes them different', () => {
    const a = resolveVideoProfile({ controlQuality: 'sharp', wallQuality: 'balanced' }, null, 'wall')
    expect(sameVideoNumbers(a, { ...a, bitRate: a.bitRate + 1 })).toBe(false)
    expect(sameVideoNumbers(a, { ...a, maxFps: a.maxFps + 1 })).toBe(false)
    expect(sameVideoNumbers(a, { ...a, maxSize: a.maxSize + 1 })).toBe(false)
  })
})

/**
 * Plan 100 §3.1, §4.1 — `computeAutoTiles` takes a `WallBudget` (a decode
 * bound + a bandwidth bound) and returns their `min`, clamped to [4, 32].
 */
describe('computeAutoTiles — decode bound × bandwidth bound (plan 100 §3.1, §4.1)', () => {
  const NEVER_BINDS = 1_000_000 // a decode ceiling far above the [4,32] clamp — isolates the bandwidth term
  const WAN_BUDGET_BPS = 20_000_000 // plan 212 §212.5 — the pre-plan-100 constant, now a caller-supplied number (advanced.wallWanBandwidthBps)

  describe('WAN/cloud regression: byte-identical to the pre-plan-100 bandwidth-only formula (plan 100 §3.6)', () => {
    const wanBudget: WallBudget = { decodeTileCeiling: NEVER_BINDS, bandwidthBps: WAN_BUDGET_BPS }

    test('the pre-plan-100 slideshow bitrate (800 kbit/s) -> 25, exactly as plan 92 §3.7 computed', () => {
      expect(computeAutoTiles(800_000, wanBudget)).toBe(25)
    })

    test('the pre-plan-100 detailed bitrate (1.5 Mbit/s) -> 13', () => {
      expect(computeAutoTiles(1_500_000, wanBudget)).toBe(13)
    })

    test('the pre-plan-100 light bitrate (400 kbit/s) -> 32, clamped at the ceiling', () => {
      expect(computeAutoTiles(400_000, wanBudget)).toBe(32)
    })

    test('control numbers typed into wall (4 Mbit/s) -> 5', () => {
      expect(computeAutoTiles(4_000_000, wanBudget)).toBe(5)
    })

    test('an absurd bitrate (100 Mbit/s) -> 4, clamped at the floor', () => {
      expect(computeAutoTiles(100_000_000, wanBudget)).toBe(4)
    })
  })

  describe('loopback/LAN: the decode bound wins at the new shipped defaults (plan 100 §3.1, §3.3)', () => {
    // The shipped placeholder default (`WALL_DECODE_TILE_CEILING`, constants.ts)
    // and the shipped generous loopback bandwidth default (`WALL_LAN_BANDWIDTH_BPS`)
    // — duplicated here as literals, matching this file's existing precedent
    // of asserting numbers, not re-deriving them from the constants module.
    const loopbackBudget: WallBudget = { decodeTileCeiling: 24, bandwidthBps: 200_000_000 }

    test('at the new balanced default (900 kbit/s), the bandwidth bound is nowhere near binding: decode wins at 24', () => {
      const bandwidthBoundAlone = Math.floor(200_000_000 / 900_000)
      expect(bandwidthBoundAlone).toBeGreaterThan(24)
      expect(computeAutoTiles(900_000, loopbackBudget)).toBe(24)
    })

    test('even at the cheapest minimal preset (250 kbit/s), decode still wins over the loopback bandwidth default', () => {
      expect(computeAutoTiles(250_000, loopbackBudget)).toBe(24)
    })

    test('an operator-set decode ceiling below 24 is respected', () => {
      expect(computeAutoTiles(900_000, { ...loopbackBudget, decodeTileCeiling: 10 })).toBe(10)
    })

    test('a decode ceiling above 32 is still clamped at the formula\'s own [4, 32] ceiling', () => {
      expect(computeAutoTiles(100, { decodeTileCeiling: 64, bandwidthBps: 1_000_000_000 })).toBe(32)
    })
  })

  describe('the clamp floor and ceiling apply regardless of which bound is smaller', () => {
    test('a tiny decode ceiling is still floored at 4', () => {
      expect(computeAutoTiles(100_000, { decodeTileCeiling: 1, bandwidthBps: 1_000_000_000 })).toBe(4)
    })

    test('a tiny bandwidth budget is still floored at 4', () => {
      expect(computeAutoTiles(100_000, { decodeTileCeiling: 32, bandwidthBps: 100 })).toBe(4)
    })
  })

  test('matches the resolved wall preset default end to end on the WAN path: balanced (1.1 Mbit/s, step 100.8) -> 18', () => {
    const profile = resolveVideoProfile({ controlQuality: 'sharp', wallQuality: 'balanced' }, null, 'wall')
    // 20_000_000 / 1_100_000 = 18.18 -> floor 18, below the 24 decode ceiling,
    // so bandwidth (not decode) is still the binding term on this specific
    // path — proving the two bounds really are independent, not a fixed
    // ordering.
    expect(computeAutoTiles(profile.bitRate, { decodeTileCeiling: 24, bandwidthBps: WAN_BUDGET_BPS })).toBe(18)
  })
})

/**
 * Plan 100 §3.1, §4.1, step 100.3 — the transport classification itself.
 */
describe('resolveWallTransport — orchestrator/cloud reads as WAN, everything else as loopback, override always wins (plan 100 §3.1, §4.1)', () => {
  test('non-orchestrator, no override: loopback', () => {
    expect(resolveWallTransport(false, 'auto')).toBe('loopback')
  })

  test('orchestrator, no override: wan', () => {
    expect(resolveWallTransport(true, 'auto')).toBe('wan')
  })

  test('an explicit override always wins, in either mode', () => {
    expect(resolveWallTransport(false, 'wan')).toBe('wan')
    expect(resolveWallTransport(true, 'loopback')).toBe('loopback')
    expect(resolveWallTransport(false, 'lan')).toBe('lan')
    expect(resolveWallTransport(true, 'lan')).toBe('lan')
  })

  test('"lan" is reachable ONLY via an explicit override — auto-derivation never produces it on its own', () => {
    expect(resolveWallTransport(false, 'auto')).not.toBe('lan')
    expect(resolveWallTransport(true, 'auto')).not.toBe('lan')
  })
})

describe('resolveWallBandwidthBps — WAN takes the caller-supplied WAN budget, loopback/LAN take the caller-supplied LAN budget (plan 212 §212.5)', () => {
  test('wan uses the wan budget regardless of the lan budget passed alongside it', () => {
    expect(resolveWallBandwidthBps('wan', 20_000_000, 999_000_000)).toBe(20_000_000)
    expect(resolveWallBandwidthBps('wan', 1_000_000, 999_000_000)).toBe(1_000_000)
  })

  test('loopback and lan both pass the lan budget straight through, ignoring the wan budget', () => {
    expect(resolveWallBandwidthBps('loopback', 20_000_000, 200_000_000)).toBe(200_000_000)
    expect(resolveWallBandwidthBps('lan', 20_000_000, 50_000_000)).toBe(50_000_000)
  })
})
