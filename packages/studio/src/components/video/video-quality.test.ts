import { describe, expect, test } from 'bun:test'
import { FarmSettingsSchema, toJsonSchema } from '@enkaku/protocol'
import {
  CONTROL_PRESETS,
  WALL_PRESETS,
  WALL_VIDEO_BUDGET_BPS,
  buildReprofileToast,
  computeAutoTiles,
  formatBitRatePreset,
  formatMbps,
  resolveControlProfile,
  resolveWallProfile,
  sameVideoNumbers,
  type FarmVideoSettings,
} from './video-quality'

const farm: FarmVideoSettings = FarmSettingsSchema.parse({}).video

/**
 * The drift guard this module's own header promises: `CONTROL_PRESETS`/
 * `WALL_PRESETS` are duplicated (not imported) from
 * `packages/session/src/video-profile.ts` for bundling reasons — this
 * cross-checks every number against `FarmSettingsSchema`'s own JSON Schema,
 * the only other place these numbers are expressed anywhere Studio can read
 * them live. `sharp`/`balanced` are pinned exactly (they are also the
 * schema's own baked defaults); every other preset row is checked against
 * the `.describe()` prose, which states each row in the exact
 * `Name W px · F fps · B` shape asserted here.
 */
describe('CONTROL_PRESETS / WALL_PRESETS — cross-checked against FarmSettingsSchema (plan 92 §4.2, step 92.8)', () => {
  test('CONTROL_PRESETS.sharp is byte-identical to the schema-baked control default', () => {
    expect(CONTROL_PRESETS.sharp).toEqual({
      maxSize: farm.controlMaxSize,
      maxFps: farm.controlMaxFps,
      bitRate: farm.controlBitRate,
    })
    expect(farm.controlPreset).toBe('sharp')
  })

  test('WALL_PRESETS.balanced is byte-identical to the schema-baked wall default', () => {
    expect(WALL_PRESETS.balanced).toEqual({
      maxSize: farm.wallMaxSize,
      maxFps: farm.wallMaxFps,
      bitRate: farm.wallBitRate,
    })
    expect(farm.wallPreset).toBe('balanced')
  })

  test('every CONTROL_PRESETS row appears verbatim in the schema\'s own controlPreset description', () => {
    const json = toJsonSchema(FarmSettingsSchema) as { properties: { video: { properties: { controlPreset: { description: string } } } } }
    const desc = json.properties.video.properties.controlPreset.description
    for (const [name, n] of Object.entries(CONTROL_PRESETS)) {
      const cap = name[0]!.toUpperCase() + name.slice(1)
      expect(desc).toContain(`${cap} ${n.maxSize} px · ${n.maxFps} fps · ${formatBitRatePreset(n.bitRate)}`)
    }
  })

  test('every WALL_PRESETS row appears verbatim in the schema\'s own wallPreset description', () => {
    const json = toJsonSchema(FarmSettingsSchema) as { properties: { video: { properties: { wallPreset: { description: string } } } } }
    const desc = json.properties.video.properties.wallPreset.description
    for (const [name, n] of Object.entries(WALL_PRESETS)) {
      const cap = name[0]!.toUpperCase() + name.slice(1)
      expect(desc).toContain(`${cap} ${n.maxSize} px · ${n.maxFps} fps · ${formatBitRatePreset(n.bitRate)}`)
    }
  })
})

describe('computeAutoTiles (plan 92 §3.7)', () => {
  test('the plan\'s own worked examples', () => {
    expect(computeAutoTiles(800_000)).toBe(25)
    expect(computeAutoTiles(1_500_000)).toBe(13)
    expect(computeAutoTiles(400_000)).toBe(32)
    expect(computeAutoTiles(4_000_000)).toBe(5)
  })

  test('clamped to [4, 32]', () => {
    expect(computeAutoTiles(1)).toBe(32)
    expect(computeAutoTiles(WALL_VIDEO_BUDGET_BPS * 10)).toBe(4)
  })
})

describe('resolveControlProfile / resolveWallProfile (plan 92 §3.9 — the readout\'s "where each number came from")', () => {
  test('with no device override, an untouched farm reads every field as "preset"', () => {
    const p = resolveControlProfile(farm)
    expect(p).toEqual({
      maxSize: 1600,
      maxFps: 30,
      bitRate: 4_000_000,
      source: { maxSize: 'preset', maxFps: 'preset', bitRate: 'preset' },
    })
  })

  test('a farm number that differs from the selected preset reads as "farm"', () => {
    const customFarm: FarmVideoSettings = { ...farm, controlMaxSize: 1920 }
    const p = resolveControlProfile(customFarm)
    expect(p.maxSize).toBe(1920)
    expect(p.source.maxSize).toBe('farm')
    // Untouched siblings still read as "preset".
    expect(p.source.maxFps).toBe('preset')
  })

  test('a device override always wins and reads as "device", regardless of the farm value', () => {
    const p = resolveWallProfile(farm, { wallBitRate: 300_000 })
    expect(p.bitRate).toBe(300_000)
    expect(p.source.bitRate).toBe('device')
    expect(p.source.maxSize).toBe('preset')
  })

  test('an empty device override object behaves identically to no override at all', () => {
    expect(resolveWallProfile(farm, {})).toEqual(resolveWallProfile(farm, null))
    expect(resolveWallProfile(farm, {})).toEqual(resolveWallProfile(farm, undefined))
  })
})

describe('sameVideoNumbers', () => {
  test('ignores source, compares only the three numbers', () => {
    const a = resolveControlProfile(farm)
    const b = resolveControlProfile({ ...farm, controlMaxSize: 1920 })
    expect(sameVideoNumbers(a, a)).toBe(true)
    expect(sameVideoNumbers(a, b)).toBe(false)
  })
})

describe('buildReprofileToast (plan 92 §3.8, §5 step 92.8 — "the summary toast must name the skipped devices")', () => {
  test('nothing changed: names the unchanged count, not a bare "applied"', () => {
    expect(buildReprofileToast({ restarted: [], skippedBusy: [], unchanged: 6 }, {})).toEqual({
      message: 'Already up to date',
      description: '6 live sessions already matched the new settings.',
    })
  })

  test('some restarted, nothing skipped: no description needed', () => {
    expect(buildReprofileToast({ restarted: ['d1', 'd2'], skippedBusy: [], unchanged: 0 }, {})).toEqual({
      message: 'New video settings applied to 2 devices',
    })
  })

  test('some skipped: NAMES them by label, resolved from the caller-supplied map — a bare id count is not enough (this step\'s own brief)', () => {
    const r = { restarted: ['d1'], skippedBusy: ['d2', 'd3'], unchanged: 0 }
    const labels = { d2: 'moto g06 — rack 1', d3: 'pixel 8 — rack 2' }
    expect(buildReprofileToast(r, labels)).toEqual({
      message: 'New video settings applied to 1 device',
      description: '2 kept their picture until their job finishes: moto g06 — rack 1, pixel 8 — rack 2',
    })
  })

  test('an id with no resolved label falls back to the raw id rather than being dropped', () => {
    const r = { restarted: [], skippedBusy: ['unknown-id'], unchanged: 3 }
    expect(buildReprofileToast(r, {}).description).toContain('unknown-id')
  })

  test('more than 5 skipped devices: shows 5 and a "+N more" tail', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const r = { restarted: [], skippedBusy: ids, unchanged: 0 }
    const { description } = buildReprofileToast(r, {})
    expect(description).toContain('a, b, c, d, e')
    expect(description).toContain('+2 more')
  })
})

describe('formatting', () => {
  test('formatBitRatePreset matches the schema prose style', () => {
    expect(formatBitRatePreset(4_000_000)).toBe('4 Mbit/s')
    expect(formatBitRatePreset(2_500_000)).toBe('2.5 Mbit/s')
    expect(formatBitRatePreset(800_000)).toBe('800 kbit/s')
  })

  test('formatMbps always keeps one decimal, for the projection/measured lines', () => {
    expect(formatMbps(20_000_000)).toBe('20.0 Mbit/s')
    expect(formatMbps(19_500_000)).toBe('19.5 Mbit/s')
  })
})
