import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { DeviceSettingsSchema, FarmSettingsSchema, defaultDeviceSettings, defaultFarmSettings } from './settings'

describe('DeviceSettingsSchema.prep — legacy stayAwake transform (Plan 17 §4.2)', () => {
  test('a legacy stayAwake: true row parses to keepAwake: while-charging', () => {
    const parsed = DeviceSettingsSchema.parse({ prep: { stayAwake: true } })
    expect(parsed.prep.keepAwake).toBe('while-charging')
    expect('stayAwake' in parsed.prep).toBe(false)
  })

  test('a legacy stayAwake: false row parses to keepAwake: off', () => {
    const parsed = DeviceSettingsSchema.parse({ prep: { stayAwake: false } })
    expect(parsed.prep.keepAwake).toBe('off')
  })

  test('an absent prep.stayAwake / keepAwake parses to the default (while-charging)', () => {
    const parsed = DeviceSettingsSchema.parse({})
    expect(parsed.prep.keepAwake).toBe('while-charging')
    expect(defaultDeviceSettings().prep.keepAwake).toBe('while-charging')
  })

  test('a fresh row already carrying keepAwake is left alone (not re-derived from stayAwake)', () => {
    const parsed = DeviceSettingsSchema.parse({ prep: { keepAwake: 'always' } })
    expect(parsed.prep.keepAwake).toBe('always')
  })

  test('standbyScreenOff defaults to false and can be turned on', () => {
    expect(defaultDeviceSettings().prep.standbyScreenOff).toBe(false)
    expect(DeviceSettingsSchema.parse({ prep: { standbyScreenOff: true } }).prep.standbyScreenOff).toBe(true)
  })

  test('the generated JSON Schema still represents prep (no transform-cannot-be-represented error)', () => {
    // z.toJSONSchema throws on a bare `.transform()`; the preprocess-based
    // rewrite must not break the settings form's generated schema (§17.7).
    const jsonSchema = z.toJSONSchema(DeviceSettingsSchema) as unknown as {
      properties: { prep: { properties: Record<string, unknown> } }
    }
    expect(Object.keys(jsonSchema.properties.prep.properties)).toEqual([
      'disableAnimations',
      'keepAwake',
      'standbyScreenOff',
    ])
  })
})

describe('FarmSettingsSchema.adb / .health — new in plan 23 §4.1', () => {
  test('a settings row that predates these fields (an empty object) still parses, with working defaults', () => {
    const parsed = FarmSettingsSchema.parse({})
    expect(parsed.adb).toEqual({
      maxConcurrent: 0,
      execTimeoutMs: 15_000,
      maxQueueDepth: 32,
      maxStreamsPerDevice: 1,
      maxStreams: 4,
    })
    expect(parsed.health).toEqual({ consecutiveFailures: 3, autoQuarantine: true, probeIntervalSec: 60 })
  })

  test('a legacy row carrying only the pre-plan-23 sections (defaults/battery/retention) fills in adb and health', () => {
    const legacyRow = {
      defaults: defaultFarmSettings().defaults,
      battery: { pollIntervalSec: 30, autoQuarantine: false, tempThresholdC: 42 },
      retention: defaultFarmSettings().retention,
    }
    const parsed = FarmSettingsSchema.parse(legacyRow)
    expect(parsed.adb.maxConcurrent).toBe(0)
    expect(parsed.health.consecutiveFailures).toBe(3)
    // The fields that DID exist on the legacy row are left untouched.
    expect(parsed.battery.pollIntervalSec).toBe(30)
  })

  test('adb.maxConcurrent of 0 means "auto"; a non-zero value is accepted up to the ceiling of 24', () => {
    expect(FarmSettingsSchema.parse({ adb: { maxConcurrent: 12 } }).adb.maxConcurrent).toBe(12)
    expect(FarmSettingsSchema.parse({ adb: { maxConcurrent: 24 } }).adb.maxConcurrent).toBe(24)
    expect(() => FarmSettingsSchema.parse({ adb: { maxConcurrent: 25 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ adb: { maxConcurrent: -1 } })).toThrow()
  })

  test('adb.maxStreamsPerDevice / adb.maxStreams (plan 24 §4.2) are bounded and independent of maxConcurrent', () => {
    expect(FarmSettingsSchema.parse({ adb: { maxStreamsPerDevice: 3 } }).adb.maxStreamsPerDevice).toBe(3)
    expect(FarmSettingsSchema.parse({ adb: { maxStreams: 16 } }).adb.maxStreams).toBe(16)
    expect(() => FarmSettingsSchema.parse({ adb: { maxStreamsPerDevice: 0 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ adb: { maxStreamsPerDevice: 9 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ adb: { maxStreams: 0 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ adb: { maxStreams: 65 } })).toThrow()
  })

  test('defaultFarmSettings() carries adb and health with their documented defaults', () => {
    const s = defaultFarmSettings()
    expect(s.adb.maxConcurrent).toBe(0)
    expect(s.adb.execTimeoutMs).toBe(15_000)
    expect(s.adb.maxQueueDepth).toBe(32)
    expect(s.adb.maxStreamsPerDevice).toBe(1)
    expect(s.adb.maxStreams).toBe(4)
    expect(s.health.consecutiveFailures).toBe(3)
    expect(s.health.autoQuarantine).toBe(true)
    expect(s.health.probeIntervalSec).toBe(60)
  })
})
