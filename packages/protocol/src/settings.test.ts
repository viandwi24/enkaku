import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { DeviceSettingsSchema, FarmSettingsSchema, TimingSettingsSchema, defaultDeviceSettings, defaultFarmSettings } from './settings'

describe('TimingSettingsSchema — input realism (plan 40 §4.3)', () => {
  test('a row that predates these fields (an empty object) still parses, defaulting to "natural"', () => {
    const parsed = TimingSettingsSchema.parse({})
    expect(parsed.profile).toBe('natural')
    expect(parsed.gestureCurvature).toBe(0.08)
    expect(parsed.gestureSampleIntervalMs).toBe(8)
    expect(parsed.perCharMs).toEqual([40, 140])
  })

  test('profile only accepts "instant" or "natural"', () => {
    expect(TimingSettingsSchema.parse({ profile: 'instant' }).profile).toBe('instant')
    expect(TimingSettingsSchema.parse({ profile: 'natural' }).profile).toBe('natural')
    expect(() => TimingSettingsSchema.parse({ profile: 'fast' })).toThrow()
  })

  test('gestureCurvature is bounded to [0, 0.5]', () => {
    expect(TimingSettingsSchema.parse({ gestureCurvature: 0 }).gestureCurvature).toBe(0)
    expect(TimingSettingsSchema.parse({ gestureCurvature: 0.5 }).gestureCurvature).toBe(0.5)
    expect(() => TimingSettingsSchema.parse({ gestureCurvature: -0.01 })).toThrow()
    expect(() => TimingSettingsSchema.parse({ gestureCurvature: 0.51 })).toThrow()
  })

  test('gestureSampleIntervalMs is bounded to [4, 50]', () => {
    expect(TimingSettingsSchema.parse({ gestureSampleIntervalMs: 4 }).gestureSampleIntervalMs).toBe(4)
    expect(TimingSettingsSchema.parse({ gestureSampleIntervalMs: 50 }).gestureSampleIntervalMs).toBe(50)
    expect(() => TimingSettingsSchema.parse({ gestureSampleIntervalMs: 3 })).toThrow()
    expect(() => TimingSettingsSchema.parse({ gestureSampleIntervalMs: 51 })).toThrow()
  })

  test('perCharMs is a [min, max] millisecond tuple', () => {
    expect(TimingSettingsSchema.parse({ perCharMs: [10, 20] }).perCharMs).toEqual([10, 20])
    expect(() => TimingSettingsSchema.parse({ perCharMs: [-1, 20] })).toThrow()
  })

  test('DeviceSettingsSchema.timing carries every new field via its own default, not a stale literal (regression: a `.default()` literal bypasses validation and silently drops fields added later)', () => {
    const timing = DeviceSettingsSchema.parse({}).timing
    expect(timing).toEqual(TimingSettingsSchema.parse({}))
  })

  test('FarmSettingsSchema.defaults.timing agrees with the device schema (they are the same schema, reused)', () => {
    expect(defaultFarmSettings().defaults.timing).toEqual(defaultDeviceSettings().timing)
  })
})

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
      maxStreamsPerDevice: 4,
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
    expect(s.adb.maxStreamsPerDevice).toBe(4)
    expect(s.adb.maxStreams).toBe(4)
    expect(s.health.consecutiveFailures).toBe(3)
    expect(s.health.autoQuarantine).toBe(true)
    expect(s.health.probeIntervalSec).toBe(60)
  })
})

describe('FarmSettingsSchema.job — session hygiene between jobs (plan 35 §4.1)', () => {
  test('a settings row that predates this field (an empty object) still parses, defaulting to "home"', () => {
    const parsed = FarmSettingsSchema.parse({})
    expect(parsed.job).toEqual({
      resetPolicy: 'home',
      resetTimeoutMs: 15_000,
      resetStrict: false,
      retry: { maxInfraAttempts: 2, backoffBaseMs: 2_000, backoffMaxMs: 30_000, timeoutIsInfra: false, rebindOnInfra: true },
      crashPolicy: 'declared',
      quietPeriodSec: 10,
      maxWaitSec: 120,
      defaultTimeoutMs: 3_600_000,
      startupTimeoutMs: 60_000,
      maxTimeoutMs: null,
      trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
    })
  })

  test('resetTimeoutMs is bounded to [1_000, 60_000]', () => {
    expect(FarmSettingsSchema.parse({ job: { resetTimeoutMs: 1_000 } }).job.resetTimeoutMs).toBe(1_000)
    expect(FarmSettingsSchema.parse({ job: { resetTimeoutMs: 60_000 } }).job.resetTimeoutMs).toBe(60_000)
    expect(() => FarmSettingsSchema.parse({ job: { resetTimeoutMs: 999 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ job: { resetTimeoutMs: 60_001 } })).toThrow()
  })

  test('resetPolicy only accepts the four documented levels', () => {
    const policies = ['none', 'home', 'declared', 'aggressive'] as const
    for (const policy of policies) {
      expect(FarmSettingsSchema.parse({ job: { resetPolicy: policy } }).job.resetPolicy).toBe(policy)
    }
    expect(() => FarmSettingsSchema.parse({ job: { resetPolicy: 'reboot' } })).toThrow()
  })

  test('resetStrict defaults to false and can be turned on', () => {
    expect(defaultFarmSettings().job.resetStrict).toBe(false)
    expect(FarmSettingsSchema.parse({ job: { resetStrict: true } }).job.resetStrict).toBe(true)
  })
})

describe('FarmSettingsSchema.job.crashPolicy — crash detection (plan 37 §3.4, §4.4)', () => {
  test('defaults to "declared"', () => {
    expect(defaultFarmSettings().job.crashPolicy).toBe('declared')
  })

  test('only the three documented levels are accepted', () => {
    for (const policy of ['ignore', 'declared', 'any'] as const) {
      expect(FarmSettingsSchema.parse({ job: { crashPolicy: policy } }).job.crashPolicy).toBe(policy)
    }
    expect(() => FarmSettingsSchema.parse({ job: { crashPolicy: 'always' } })).toThrow()
  })

  test('a legacy row without job.crashPolicy at all still parses, defaulting to "declared"', () => {
    const legacyRow = { job: { resetPolicy: 'aggressive' } }
    expect(FarmSettingsSchema.parse(legacyRow).job.crashPolicy).toBe('declared')
  })
})

describe('FarmSettingsSchema.adb.maxStreamsPerDevice — raised for the crash watcher (plan 37 §3.4, §4.3), then again for transfers (plan 39 §3.3)', () => {
  test('defaults to 4, not plan 24\'s original 1 nor plan 37\'s 3, so a transfer never starves ui-server, the crash watcher, or a human Monitor tab', () => {
    expect(defaultFarmSettings().adb.maxStreamsPerDevice).toBe(4)
  })

  test('the setting still bounds to [1, 8] — only the default moved, not the range', () => {
    expect(() => FarmSettingsSchema.parse({ adb: { maxStreamsPerDevice: 0 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ adb: { maxStreamsPerDevice: 9 } })).toThrow()
    expect(FarmSettingsSchema.parse({ adb: { maxStreamsPerDevice: 8 } }).adb.maxStreamsPerDevice).toBe(8)
    expect(FarmSettingsSchema.parse({ adb: { maxStreamsPerDevice: 1 } }).adb.maxStreamsPerDevice).toBe(1)
  })
})

describe('FarmSettingsSchema.transfer — file transfer and APK install (plan 39 §4.3)', () => {
  test('a settings row that predates this field (an empty object) still parses, with working defaults', () => {
    const parsed = FarmSettingsSchema.parse({})
    expect(parsed.transfer).toEqual({
      enabled: true,
      maxPushBytes: 536_870_912,
      maxPullBytes: 536_870_912,
      installTimeoutMs: 300_000,
    })
  })

  test('enabled can be turned off, refusing every transfer route (acceptance #7)', () => {
    expect(FarmSettingsSchema.parse({ transfer: { enabled: false } }).transfer.enabled).toBe(false)
  })

  test('maxPushBytes / maxPullBytes are bounded below at 1 MiB', () => {
    expect(() => FarmSettingsSchema.parse({ transfer: { maxPushBytes: 0 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ transfer: { maxPullBytes: 100 } })).toThrow()
    expect(FarmSettingsSchema.parse({ transfer: { maxPushBytes: 1_048_576 } }).transfer.maxPushBytes).toBe(1_048_576)
  })

  test('installTimeoutMs is bounded to [10_000, 1_800_000] — well above MAX_EXEC_TIMEOUT_MS, since install runs on the lane, not exec (plan 39 §3.4)', () => {
    expect(() => FarmSettingsSchema.parse({ transfer: { installTimeoutMs: 9_999 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ transfer: { installTimeoutMs: 1_800_001 } })).toThrow()
    expect(FarmSettingsSchema.parse({ transfer: { installTimeoutMs: 1_800_000 } }).transfer.installTimeoutMs).toBe(1_800_000)
  })
})

describe('FarmSettingsSchema.network — geo lookup provider (plan 55 §3.2, §5.1)', () => {
  test('a settings row that predates this field (an empty object) still parses, geoProvider unset', () => {
    const parsed = FarmSettingsSchema.parse({})
    expect(parsed.network.geoProvider).toBeUndefined()
    expect(parsed.network.geoIntervalSec).toBe(300)
  })

  test('geoProvider must be a URL, not an arbitrary string', () => {
    expect(() => FarmSettingsSchema.parse({ network: { geoProvider: 'not a url' } })).toThrow()
    expect(FarmSettingsSchema.parse({ network: { geoProvider: 'https://probe.example.com/geo' } }).network.geoProvider).toBe(
      'https://probe.example.com/geo',
    )
  })

  test('geoIntervalSec is bounded to [30, 86400] and round-trips a custom value', () => {
    expect(() => FarmSettingsSchema.parse({ network: { geoIntervalSec: 10 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ network: { geoIntervalSec: 86_401 } })).toThrow()
    expect(FarmSettingsSchema.parse({ network: { geoIntervalSec: 600 } }).network.geoIntervalSec).toBe(600)
  })
})
