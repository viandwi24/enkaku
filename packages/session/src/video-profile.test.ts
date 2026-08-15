import { describe, expect, test } from 'bun:test'
import { defaultFarmSettings, type DeviceSettings } from '@enkaku/protocol'
import {
  CONTROL_PRESETS,
  WALL_PRESETS,
  WALL_VIDEO_BUDGET_BPS,
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
 * `wall` is now pinned to plan 100 §3.4's revised numbers instead — see
 * `PRE_PLAN_100_WALL_BALANCED` below for the constant this test compared
 * against before this step.
 */
const PRE_PLAN_92_QUALITY_PROFILES = {
  control: { maxSize: 1600, maxFps: 30, bitRate: 4_000_000 },
}

/**
 * Plan 100 §3.4 — the slideshow default this step replaces. Kept here,
 * deliberately NOT deleted, so a future reader can see exactly what
 * `WALL_PRESETS.balanced` used to be and confirm the new number is a
 * genuine change, not a typo of the old one.
 */
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

describe('resolveVideoProfile — byte-identical scrcpy arguments for control; wall now resolves the plan 100 defaults', () => {
  test('control, farm defaults, no device override: max_size 1600 · max_fps 30 · video_bit_rate 4000000', () => {
    const profile = resolveVideoProfile(defaultFarmSettings().video, null, 'control')
    expect(profile.maxSize).toBe(1600)
    expect(profile.maxFps).toBe(30)
    expect(profile.bitRate).toBe(4_000_000)
    expect(profile.quality).toBe('control')
  })

  test('wall, farm defaults, no device override: max_size 480 · max_fps 18 · video_bit_rate 1100000 (plan 100 step 100.8)', () => {
    const profile = resolveVideoProfile(defaultFarmSettings().video, null, 'wall')
    expect(profile.maxSize).toBe(480)
    expect(profile.maxFps).toBe(18)
    expect(profile.bitRate).toBe(1_100_000)
    expect(profile.quality).toBe('wall')
  })

  test('every number is reported as "preset" sourced when the farm has changed nothing', () => {
    const control = resolveVideoProfile(defaultFarmSettings().video, null, 'control')
    expect(control.source).toEqual({ maxSize: 'preset', maxFps: 'preset', bitRate: 'preset' })
    const wall = resolveVideoProfile(defaultFarmSettings().video, null, 'wall')
    expect(wall.source).toEqual({ maxSize: 'preset', maxFps: 'preset', bitRate: 'preset' })
  })
})

describe('resolveVideoProfile — precedence: device field beats farm field beats preset table (plan 92 §3.5, §4.2)', () => {
  test('a farm number that differs from the selected preset resolves to the farm value, sourced "farm"', () => {
    const farm = { ...defaultFarmSettings().video, wallBitRate: 1_000_000 }
    const profile = resolveVideoProfile(farm, null, 'wall')
    expect(profile.bitRate).toBe(1_000_000)
    expect(profile.source.bitRate).toBe('farm')
    // The untouched numbers on the same profile still read "preset".
    expect(profile.source.maxSize).toBe('preset')
    expect(profile.source.maxFps).toBe('preset')
  })

  test('a device override wins over the farm value even when the farm value is itself non-default', () => {
    const farm = { ...defaultFarmSettings().video, wallBitRate: 1_000_000 }
    const device: DeviceSettings['video'] = { wallBitRate: 250_000 }
    const profile = resolveVideoProfile(farm, device, 'wall')
    expect(profile.bitRate).toBe(250_000)
    expect(profile.source.bitRate).toBe('device')
  })

  test('a null device (no row, or no override at all) behaves exactly like an empty object', () => {
    const farm = defaultFarmSettings().video
    expect(resolveVideoProfile(farm, null, 'control')).toEqual(resolveVideoProfile(farm, {}, 'control'))
  })

  test('control and wall device overrides are independent — a wall override never leaks into a control resolution', () => {
    const device: DeviceSettings['video'] = { wallMaxFps: 2 }
    const profile = resolveVideoProfile(defaultFarmSettings().video, device, 'control')
    expect(profile.maxFps).toBe(30) // untouched — the override was for `wall`, not `control`
    expect(profile.source.maxFps).toBe('preset')
  })

  test('every field can be independently sourced from a different layer on the same profile', () => {
    const farm = { ...defaultFarmSettings().video, controlMaxFps: 24 } // farm-overridden
    const device: DeviceSettings['video'] = { controlBitRate: 6_000_000 } // device-overridden
    const profile = resolveVideoProfile(farm, device, 'control')
    expect(profile.maxSize).toBe(1600) // preset
    expect(profile.source.maxSize).toBe('preset')
    expect(profile.maxFps).toBe(24) // farm
    expect(profile.source.maxFps).toBe('farm')
    expect(profile.bitRate).toBe(6_000_000) // device
    expect(profile.source.bitRate).toBe('device')
  })
})

describe('sameVideoNumbers — ignores source and quality (plan 92 §4.2)', () => {
  test('two profiles with identical numbers but different quality/source are still "same"', () => {
    const a = resolveVideoProfile(defaultFarmSettings().video, null, 'control')
    const b = { maxSize: a.maxSize, maxFps: a.maxFps, bitRate: a.bitRate }
    expect(sameVideoNumbers(a, b)).toBe(true)
  })

  test('a single differing number makes them different', () => {
    const a = resolveVideoProfile(defaultFarmSettings().video, null, 'wall')
    expect(sameVideoNumbers(a, { ...a, bitRate: a.bitRate + 1 })).toBe(false)
    expect(sameVideoNumbers(a, { ...a, maxFps: a.maxFps + 1 })).toBe(false)
    expect(sameVideoNumbers(a, { ...a, maxSize: a.maxSize + 1 })).toBe(false)
  })
})

/**
 * Plan 100 §3.1, §4.1 — `computeAutoTiles` now takes a `WallBudget` (a
 * decode bound + a bandwidth bound) and returns their `min`, clamped to
 * [4, 32]. The three describe blocks below cover: (1) a WAN/cloud
 * regression fixture proving the formula is byte-identical to plan 92's
 * single-bound version when the decode bound is set loose enough not to
 * bind and the bandwidth bound is pinned to the old 20 Mbit/s constant
 * (plan 100 §3.6's "cloud mode is untouched" claim, checked at the formula
 * level); (2) a loopback fixture proving the decode bound is what actually
 * governs at the new shipped defaults; (3) the clamp's own edges.
 */
describe('computeAutoTiles — decode bound × bandwidth bound (plan 100 §3.1, §4.1)', () => {
  const NEVER_BINDS = 1_000_000 // a decode ceiling far above the [4,32] clamp — isolates the bandwidth term

  describe('WAN/cloud regression: byte-identical to the pre-plan-100 bandwidth-only formula (plan 100 §3.6)', () => {
    const wanBudget: WallBudget = { decodeTileCeiling: NEVER_BINDS, bandwidthBps: WALL_VIDEO_BUDGET_BPS }

    test('WALL_VIDEO_BUDGET_BPS is still the named 20 Mbit/s constant', () => {
      expect(WALL_VIDEO_BUDGET_BPS).toBe(20_000_000)
    })

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
    // The shipped placeholder default (settings.ts `wall.decodeTileCeiling`)
    // and the shipped generous loopback bandwidth default
    // (`wall.bandwidthBps`) — duplicated here as literals rather than
    // imported from `@enkaku/protocol`, matching this file's existing
    // precedent of asserting numbers, not re-deriving them from the schema
    // it is meant to be checked against.
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
    const profile = resolveVideoProfile(defaultFarmSettings().video, null, 'wall')
    // 20_000_000 / 1_100_000 = 18.18 -> floor 18, below the 24 decode ceiling,
    // so bandwidth (not decode) is still the binding term on this specific
    // path — proving the two bounds really are independent, not a fixed
    // ordering.
    expect(computeAutoTiles(profile.bitRate, { decodeTileCeiling: 24, bandwidthBps: WALL_VIDEO_BUDGET_BPS })).toBe(18)
  })
})

/**
 * Plan 100 §3.1, §4.1, step 100.3 — the transport classification itself.
 * `packages/core/src/daemon-wiring.test.ts` proves `daemon.ts`'s real
 * `video:` accessor actually calls these two functions (reading `ENKAKU_MODE`
 * env-var classification is only meaningfully testable against the real
 * source text, not a fixture); this proves the pure functions are correct
 * in isolation.
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

describe('resolveWallBandwidthBps — WAN is hard-pinned to WALL_VIDEO_BUDGET_BPS, loopback/LAN use the farm setting (plan 100 §3.1, §3.6, §4.1)', () => {
  test('wan ignores the farm setting entirely — provably byte-identical to pre-plan-100 cloud behaviour', () => {
    expect(resolveWallBandwidthBps('wan', 999_000_000)).toBe(WALL_VIDEO_BUDGET_BPS)
    expect(resolveWallBandwidthBps('wan', 1_000_000)).toBe(WALL_VIDEO_BUDGET_BPS)
  })

  test('loopback and lan both pass the farm setting straight through', () => {
    expect(resolveWallBandwidthBps('loopback', 200_000_000)).toBe(200_000_000)
    expect(resolveWallBandwidthBps('lan', 50_000_000)).toBe(50_000_000)
  })
})
