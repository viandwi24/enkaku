import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  INPUT_ACTION_BODIES,
  InputGestureMessage,
  InputKeyMessage,
  InputSwipeMessage,
  InputTapMessage,
  InputTextMessage,
  MirrorActionSchema,
} from './messages/input'
import {
  CidrSchema,
  ControlPresetSchema,
  DeviceSettingsSchema,
  FarmSettingsSchema,
  TimingSettingsSchema,
  WallPresetSchema,
  addressCount,
  defaultDeviceSettings,
  defaultFarmSettings,
} from './settings'

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

  // Plan 125 §3.3 moved this default off `while-charging`, which maps to `svc
  // power stayon usb` — a documented no-op for a device attached over
  // `adb-tcp`, and so a default that would have made plan 125's new
  // awake-by-default a lie on exactly the farm it was chosen for.
  test('an absent prep.stayAwake / keepAwake parses to the default (always)', () => {
    const parsed = DeviceSettingsSchema.parse({})
    expect(parsed.prep.keepAwake).toBe('always')
    expect(defaultDeviceSettings().prep.keepAwake).toBe('always')
  })

  // The `prep` block's own `.default()` is a LITERAL object (Zod 4 does not
  // re-parse it), so a field added to the block and forgotten there reads
  // `undefined` at runtime on every farm that never saved this block. These
  // two assertions are what catch that.
  test('prep.screenOffTimeoutMs defaults to 30 minutes, through both the field and the block default', () => {
    expect(DeviceSettingsSchema.parse({}).prep.screenOffTimeoutMs).toBe(1800000)
    expect(defaultDeviceSettings().prep.screenOffTimeoutMs).toBe(1800000)
    expect(DeviceSettingsSchema.parse({ prep: {} }).prep.screenOffTimeoutMs).toBe(1800000)
  })

  test('prep.screenOffTimeoutMs accepts null — "leave the device’s own timeout alone" (plan 125 §4.2)', () => {
    expect(DeviceSettingsSchema.parse({ prep: { screenOffTimeoutMs: null } }).prep.screenOffTimeoutMs).toBeNull()
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
      // Plan 125 §4.2 — a nullable number, and it must survive
      // `z.toJSONSchema` like the rest, since the settings form is generated
      // from exactly this output (spec §17.7).
      'screenOffTimeoutMs',
      'standbyScreenOff',
      'rotation',
      'textInput',
    ])
  })
})

describe('DeviceSettingsSchema.prep.rotation — screen rotation (plan 85 §3.7, §4.1)', () => {
  test('defaults to "device" (today\'s behaviour: Enkaku neither sets nor clears rotation)', () => {
    expect(defaultDeviceSettings().prep.rotation).toBe('device')
    expect(DeviceSettingsSchema.parse({}).prep.rotation).toBe('device')
  })

  test('accepts every documented lock mode', () => {
    for (const mode of ['device', 'lock-portrait', 'lock-landscape', 'lock-current'] as const) {
      expect(DeviceSettingsSchema.parse({ prep: { rotation: mode } }).prep.rotation).toBe(mode)
    }
  })

  test('rejects a value outside the documented modes', () => {
    expect(() => DeviceSettingsSchema.parse({ prep: { rotation: 'landscape' } })).toThrow()
  })
})

describe('DeviceSettingsSchema.instrumentation.tagTraffic — farm traffic tagging (spec §9.4/§17, plan 87 §4.12, §5 step 87.13)', () => {
  test('defaults to true — "on by default" is the spec\'s own wording', () => {
    expect(defaultDeviceSettings().instrumentation.tagTraffic).toBe(true)
    expect(DeviceSettingsSchema.parse({}).instrumentation.tagTraffic).toBe(true)
  })

  test('a settings row that predates this field (an empty object) still parses, defaulting to true', () => {
    const parsed = DeviceSettingsSchema.parse({ prep: { keepAwake: 'always' } })
    expect(parsed.instrumentation).toEqual({ tagTraffic: true })
  })

  test('the operator\'s off switch is honoured: false stays false, never silently forced back on', () => {
    expect(DeviceSettingsSchema.parse({ instrumentation: { tagTraffic: false } }).instrumentation.tagTraffic).toBe(false)
  })

  test('FarmSettingsSchema.defaults.instrumentation agrees with the device schema (they are the same schema, reused)', () => {
    expect(defaultFarmSettings().defaults.instrumentation).toEqual(defaultDeviceSettings().instrumentation)
  })

  test('the generated JSON Schema represents instrumentation.tagTraffic (the settings form needs this to render the off switch)', () => {
    const jsonSchema = z.toJSONSchema(DeviceSettingsSchema) as unknown as {
      properties: { instrumentation: { properties: Record<string, unknown> } }
    }
    expect(Object.keys(jsonSchema.properties.instrumentation.properties)).toEqual(['tagTraffic'])
  })
})

describe('FarmSettingsSchema.adb / .health — new in plan 23 §4.1', () => {
  test('a settings row that predates these fields (an empty object) still parses, with working defaults', () => {
    const parsed = FarmSettingsSchema.parse({})
    expect(parsed.adb).toEqual({
      maxConcurrent: 0,
      maxStreamsPerDevice: 4,
      maxStreams: 0,
      maxHostConcurrent: 4,
      maxInstallConcurrent: 2,
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

  test('adb.maxStreamsPerDevice / adb.maxStreams (plan 24 §4.2, min(0) since plan 85 §4.1) are bounded and independent of maxConcurrent', () => {
    expect(FarmSettingsSchema.parse({ adb: { maxStreamsPerDevice: 3 } }).adb.maxStreamsPerDevice).toBe(3)
    expect(FarmSettingsSchema.parse({ adb: { maxStreams: 16 } }).adb.maxStreams).toBe(16)
    expect(() => FarmSettingsSchema.parse({ adb: { maxStreamsPerDevice: 0 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ adb: { maxStreamsPerDevice: 9 } })).toThrow()
    // 0 is now a legal, meaningful value (auto) — only a negative value throws.
    expect(FarmSettingsSchema.parse({ adb: { maxStreams: 0 } }).adb.maxStreams).toBe(0)
    expect(() => FarmSettingsSchema.parse({ adb: { maxStreams: -1 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ adb: { maxStreams: 65 } })).toThrow()
  })

  test('adb.maxHostConcurrent / adb.maxInstallConcurrent (plan 85 §4.1) are bounded and default correctly', () => {
    expect(defaultFarmSettings().adb.maxHostConcurrent).toBe(4)
    expect(defaultFarmSettings().adb.maxInstallConcurrent).toBe(2)
    expect(FarmSettingsSchema.parse({ adb: { maxHostConcurrent: 32 } }).adb.maxHostConcurrent).toBe(32)
    expect(() => FarmSettingsSchema.parse({ adb: { maxHostConcurrent: 0 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ adb: { maxHostConcurrent: 33 } })).toThrow()
    expect(FarmSettingsSchema.parse({ adb: { maxInstallConcurrent: 16 } }).adb.maxInstallConcurrent).toBe(16)
    expect(() => FarmSettingsSchema.parse({ adb: { maxInstallConcurrent: 0 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ adb: { maxInstallConcurrent: 17 } })).toThrow()
  })

  test('defaultFarmSettings() carries adb and health with their documented defaults', () => {
    const s = defaultFarmSettings()
    expect(s.adb.maxConcurrent).toBe(0)
    expect(s.adb.maxStreamsPerDevice).toBe(4)
    expect(s.adb.maxStreams).toBe(0)
    expect(s.adb.maxHostConcurrent).toBe(4)
    expect(s.adb.maxInstallConcurrent).toBe(2)
    expect(s.health.consecutiveFailures).toBe(3)
    expect(s.health.autoQuarantine).toBe(true)
    expect(s.health.probeIntervalSec).toBe(60)
  })
})

describe('FarmSettingsSchema.adbControl — adb server health monitoring and restart control (plan 88 §3.9, §3.10, §4.7, §4.8, §5 step 88.9)', () => {
  test('a row that predates these fields (an empty object) still parses, with working defaults', () => {
    expect(FarmSettingsSchema.parse({}).adbControl).toEqual({
      healthIntervalSec: 15,
      stuckTimeoutRate: 0.5,
      restartCooldownSec: 60,
      drainTimeoutMs: 30_000,
    })
  })

  test('healthIntervalSec is bounded to [5, 300]', () => {
    expect(FarmSettingsSchema.parse({ adbControl: { healthIntervalSec: 5 } }).adbControl.healthIntervalSec).toBe(5)
    expect(FarmSettingsSchema.parse({ adbControl: { healthIntervalSec: 300 } }).adbControl.healthIntervalSec).toBe(300)
    expect(() => FarmSettingsSchema.parse({ adbControl: { healthIntervalSec: 4 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ adbControl: { healthIntervalSec: 301 } })).toThrow()
  })

  test('stuckTimeoutRate is a [0, 1] share, not a percentage', () => {
    expect(FarmSettingsSchema.parse({ adbControl: { stuckTimeoutRate: 0 } }).adbControl.stuckTimeoutRate).toBe(0)
    expect(FarmSettingsSchema.parse({ adbControl: { stuckTimeoutRate: 1 } }).adbControl.stuckTimeoutRate).toBe(1)
    expect(() => FarmSettingsSchema.parse({ adbControl: { stuckTimeoutRate: 1.1 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ adbControl: { stuckTimeoutRate: -0.1 } })).toThrow()
  })

  test('restartCooldownSec is bounded to [10, 3600] — the gap between adb-server-control cycle() restarts', () => {
    expect(FarmSettingsSchema.parse({ adbControl: { restartCooldownSec: 10 } }).adbControl.restartCooldownSec).toBe(10)
    expect(FarmSettingsSchema.parse({ adbControl: { restartCooldownSec: 3600 } }).adbControl.restartCooldownSec).toBe(3600)
    expect(() => FarmSettingsSchema.parse({ adbControl: { restartCooldownSec: 9 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ adbControl: { restartCooldownSec: 3601 } })).toThrow()
  })

  test('drainTimeoutMs is bounded to [5_000, 300_000] — how long cycle() waits for sessions/leases to drain', () => {
    expect(FarmSettingsSchema.parse({ adbControl: { drainTimeoutMs: 5_000 } }).adbControl.drainTimeoutMs).toBe(5_000)
    expect(FarmSettingsSchema.parse({ adbControl: { drainTimeoutMs: 300_000 } }).adbControl.drainTimeoutMs).toBe(300_000)
    expect(() => FarmSettingsSchema.parse({ adbControl: { drainTimeoutMs: 4_999 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ adbControl: { drainTimeoutMs: 300_001 } })).toThrow()
  })

  test('defaultFarmSettings() carries adbControl with its documented defaults', () => {
    const s = defaultFarmSettings()
    expect(s.adbControl.healthIntervalSec).toBe(15)
    expect(s.adbControl.stuckTimeoutRate).toBe(0.5)
    expect(s.adbControl.restartCooldownSec).toBe(60)
    expect(s.adbControl.drainTimeoutMs).toBe(30_000)
  })
})

describe('FarmSettingsSchema.adb.maxStreams — legacy migration (plan 85 §3.1, §4.1)', () => {
  test('a stored 4 (the old, never-deliberately-chosen default) is rewritten to 0 (auto)', () => {
    expect(FarmSettingsSchema.parse({ adb: { maxStreams: 4 } }).adb.maxStreams).toBe(0)
  })

  test('a stored 7 (a deliberate, non-default value) is left untouched', () => {
    expect(FarmSettingsSchema.parse({ adb: { maxStreams: 7 } }).adb.maxStreams).toBe(7)
  })

  test('a fresh row with no adb.maxStreams at all defaults to 0 (auto), not the migration path', () => {
    expect(FarmSettingsSchema.parse({}).adb.maxStreams).toBe(0)
    expect(FarmSettingsSchema.parse({ adb: {} }).adb.maxStreams).toBe(0)
    expect(defaultFarmSettings().adb.maxStreams).toBe(0)
  })

  test('the migration does not disturb the other adb fields on the same stored row', () => {
    const parsed = FarmSettingsSchema.parse({ adb: { maxStreams: 4, maxConcurrent: 10, maxStreamsPerDevice: 2 } })
    expect(parsed.adb.maxStreams).toBe(0)
    expect(parsed.adb.maxConcurrent).toBe(10)
    expect(parsed.adb.maxStreamsPerDevice).toBe(2)
  })
})

describe('FarmSettingsSchema.discovery — device rescan reconciliation (plan 85 §3.3, §4.1)', () => {
  const DISCOVERY_DEFAULTS = {
    scanIntervalSec: 10,
    offlineGraceSec: 20,
    recoveryCooldownSec: 120,
    tcpPort: 5555,
    endpointsPerDevice: 4,
    endpointRetireAfter: 10,
    connectSettleMs: 3_000,
    networks: [],
    scan: { mode: 'on-demand' as const, maxAddresses: 1024, concurrency: 32, probeTimeoutMs: 300 },
    cutover: { armWindowSec: 180, armPollSec: 5 },
  }

  test('a settings row that predates this field (an empty object) still parses, with working defaults', () => {
    const parsed = FarmSettingsSchema.parse({})
    expect(parsed.discovery).toEqual(DISCOVERY_DEFAULTS)
    expect(defaultFarmSettings().discovery).toEqual(DISCOVERY_DEFAULTS)
  })

  test('scanIntervalSec is bounded to [0, 300]; 0 disables the rescan (plan 85 §7.4 regression watch)', () => {
    expect(FarmSettingsSchema.parse({ discovery: { scanIntervalSec: 0 } }).discovery.scanIntervalSec).toBe(0)
    expect(FarmSettingsSchema.parse({ discovery: { scanIntervalSec: 300 } }).discovery.scanIntervalSec).toBe(300)
    expect(() => FarmSettingsSchema.parse({ discovery: { scanIntervalSec: -1 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ discovery: { scanIntervalSec: 301 } })).toThrow()
  })

  test('offlineGraceSec is bounded to [5, 600]', () => {
    expect(() => FarmSettingsSchema.parse({ discovery: { offlineGraceSec: 4 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ discovery: { offlineGraceSec: 601 } })).toThrow()
    expect(FarmSettingsSchema.parse({ discovery: { offlineGraceSec: 5 } }).discovery.offlineGraceSec).toBe(5)
  })

  test('recoveryCooldownSec is bounded to [30, 3600]', () => {
    expect(() => FarmSettingsSchema.parse({ discovery: { recoveryCooldownSec: 29 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ discovery: { recoveryCooldownSec: 3601 } })).toThrow()
    expect(FarmSettingsSchema.parse({ discovery: { recoveryCooldownSec: 3600 } }).discovery.recoveryCooldownSec).toBe(3600)
  })

  describe('the address-book / reconnect-ladder fields (plan 88 §4.2, §5 step 88.2)', () => {
    test('tcpPort is bounded to [1024, 65535], default 5555', () => {
      expect(FarmSettingsSchema.parse({}).discovery.tcpPort).toBe(5555)
      expect(FarmSettingsSchema.parse({ discovery: { tcpPort: 1024 } }).discovery.tcpPort).toBe(1024)
      expect(FarmSettingsSchema.parse({ discovery: { tcpPort: 65535 } }).discovery.tcpPort).toBe(65535)
      expect(() => FarmSettingsSchema.parse({ discovery: { tcpPort: 1023 } })).toThrow()
      expect(() => FarmSettingsSchema.parse({ discovery: { tcpPort: 65536 } })).toThrow()
    })

    test('endpointsPerDevice is bounded to [1, 16], default 4', () => {
      expect(FarmSettingsSchema.parse({}).discovery.endpointsPerDevice).toBe(4)
      expect(FarmSettingsSchema.parse({ discovery: { endpointsPerDevice: 1 } }).discovery.endpointsPerDevice).toBe(1)
      expect(FarmSettingsSchema.parse({ discovery: { endpointsPerDevice: 16 } }).discovery.endpointsPerDevice).toBe(16)
      expect(() => FarmSettingsSchema.parse({ discovery: { endpointsPerDevice: 0 } })).toThrow()
      expect(() => FarmSettingsSchema.parse({ discovery: { endpointsPerDevice: 17 } })).toThrow()
    })

    test('endpointRetireAfter is bounded to [1, 100], default 10', () => {
      expect(FarmSettingsSchema.parse({}).discovery.endpointRetireAfter).toBe(10)
      expect(() => FarmSettingsSchema.parse({ discovery: { endpointRetireAfter: 0 } })).toThrow()
      expect(() => FarmSettingsSchema.parse({ discovery: { endpointRetireAfter: 101 } })).toThrow()
      expect(FarmSettingsSchema.parse({ discovery: { endpointRetireAfter: 100 } }).discovery.endpointRetireAfter).toBe(100)
    })

    test('connectSettleMs is bounded to [500, 30_000], default 3_000', () => {
      expect(FarmSettingsSchema.parse({}).discovery.connectSettleMs).toBe(3_000)
      expect(() => FarmSettingsSchema.parse({ discovery: { connectSettleMs: 499 } })).toThrow()
      expect(() => FarmSettingsSchema.parse({ discovery: { connectSettleMs: 30_001 } })).toThrow()
      expect(FarmSettingsSchema.parse({ discovery: { connectSettleMs: 500 } }).discovery.connectSettleMs).toBe(500)
    })
  })

  describe('CidrSchema (plan 88 §3.5, §4.2, §5 step 88.3)', () => {
    test('accepts a plain IPv4 CIDR block', () => {
      expect(CidrSchema.parse('10.20.0.0/24')).toBe('10.20.0.0/24')
      expect(CidrSchema.parse('192.0.2.0/24')).toBe('192.0.2.0/24') // TEST-NET-1
      expect(CidrSchema.parse('0.0.0.0/0')).toBe('0.0.0.0/0')
      expect(CidrSchema.parse('10.0.0.5/32')).toBe('10.0.0.5/32')
    })

    test('rejects a malformed CIDR', () => {
      expect(() => CidrSchema.parse('not-a-cidr')).toThrow()
      expect(() => CidrSchema.parse('10.20.0.0')).toThrow() // no prefix
      expect(() => CidrSchema.parse('10.20.0.0/33')).toThrow() // prefix out of range
      expect(() => CidrSchema.parse('10.20.0.999/24')).toThrow() // octet out of range
      expect(() => CidrSchema.parse('10.20.0.0/24/1')).toThrow()
      expect(() => CidrSchema.parse('')).toThrow()
    })
  })

  describe('addressCount (plan 88 §4.2, §5 step 88.3)', () => {
    test('2 ** (32 - prefix), including the network and broadcast address', () => {
      expect(addressCount('10.20.0.0/24')).toBe(256)
      expect(addressCount('10.20.0.0/16')).toBe(65_536)
      expect(addressCount('10.20.0.0/30')).toBe(4)
      expect(addressCount('10.20.0.5/32')).toBe(1)
    })

    test('four /24s add up to exactly maxAddresses’ own default (1024) — the plan’s own "four /24s" note', () => {
      expect(addressCount('10.0.0.0/24') * 4).toBe(1_024)
    })

    test('returns 0 for anything malformed rather than throwing', () => {
      expect(addressCount('not-a-cidr')).toBe(0)
      expect(addressCount('10.20.0.0/33')).toBe(0)
      expect(addressCount('10.20.0.0/-1')).toBe(0)
    })
  })

  describe('discovery.networks / discovery.scan (plan 88 §3.5, §3.6, §4.2, §5 step 88.3)', () => {
    test('empty by default — no top-level key was added; both nest under discovery (plan 88 §5 step 88.3)', () => {
      const parsed = FarmSettingsSchema.parse({})
      expect(parsed.discovery.networks).toEqual([])
      expect(parsed.discovery.scan).toEqual({ mode: 'on-demand', maxAddresses: 1024, concurrency: 32, probeTimeoutMs: 300 })
      expect(Object.keys(FarmSettingsSchema.parse({})).includes('networks')).toBe(false)
      expect(Object.keys(FarmSettingsSchema.parse({})).includes('scan')).toBe(false)
    })

    test('scan.mode is only "off" | "on-demand" — no "auto" (§9 Q1, decided 2026-08-12)', () => {
      expect(FarmSettingsSchema.parse({ discovery: { scan: { mode: 'off' } } }).discovery.scan.mode).toBe('off')
      expect(FarmSettingsSchema.parse({ discovery: { scan: { mode: 'on-demand' } } }).discovery.scan.mode).toBe('on-demand')
      expect(() => FarmSettingsSchema.parse({ discovery: { scan: { mode: 'auto' } } })).toThrow()
    })

    test('a network row defaults label/medium/scan and validates its own cidr', () => {
      const parsed = FarmSettingsSchema.parse({ discovery: { networks: [{ cidr: '10.20.0.0/24' }] } })
      expect(parsed.discovery.networks).toEqual([{ cidr: '10.20.0.0/24', label: '', medium: 'wired', scan: true }])
      expect(() =>
        FarmSettingsSchema.parse({ discovery: { networks: [{ cidr: 'garbage' }] } }),
      ).toThrow()
    })

    test('one /24 is ok', () => {
      const parsed = FarmSettingsSchema.parse({ discovery: { networks: [{ cidr: '10.0.0.0/24', scan: true }] } })
      expect(parsed.discovery.networks.length).toBe(1)
    })

    test('five /24s (1280 addresses) are rejected, with the exact message', () => {
      const networks = Array.from({ length: 5 }, (_, i) => ({ cidr: `10.${i}.0.0/24`, scan: true }))
      let error: unknown
      try {
        FarmSettingsSchema.parse({ discovery: { networks } })
      } catch (err) {
        error = err
      }
      expect(error).toBeDefined()
      const zodError = error as { issues: Array<{ path: (string | number)[]; message: string }> }
      const issue = zodError.issues.find((i) => i.path.join('.') === 'discovery.networks')
      expect(issue?.message).toBe(
        'these networks add up to 1280 addresses, over the 1024 limit — untick one, narrow a range, or raise the limit',
      )
    })

    test('an untouched network (scan: false) does not count toward the ceiling', () => {
      const networks = [
        { cidr: '10.0.0.0/24', scan: true },
        { cidr: '10.1.0.0/16', scan: false }, // 65,536 addresses, but excluded
      ]
      expect(FarmSettingsSchema.parse({ discovery: { networks } }).discovery.networks.length).toBe(2)
    })

    test('a malformed CIDR inside the array is rejected', () => {
      expect(() =>
        FarmSettingsSchema.parse({ discovery: { networks: [{ cidr: '999.999.999.999/24' }] } }),
      ).toThrow()
    })

    test('raising maxAddresses lets the same networks through', () => {
      const networks = Array.from({ length: 5 }, (_, i) => ({ cidr: `10.${i}.0.0/24`, scan: true }))
      const parsed = FarmSettingsSchema.parse({ discovery: { networks, scan: { maxAddresses: 1280 } } })
      expect(parsed.discovery.networks.length).toBe(5)
    })
  })

  describe('discovery.cutover — the armed-window policy (plan 88 §3.4, §4.2, §5 step 88.5)', () => {
    test('defaults to a 180s window polled every 5s', () => {
      expect(FarmSettingsSchema.parse({}).discovery.cutover).toEqual({ armWindowSec: 180, armPollSec: 5 })
    })

    test('armWindowSec is bounded to [30, 900]', () => {
      expect(() => FarmSettingsSchema.parse({ discovery: { cutover: { armWindowSec: 29 } } })).toThrow()
      expect(() => FarmSettingsSchema.parse({ discovery: { cutover: { armWindowSec: 901 } } })).toThrow()
      expect(FarmSettingsSchema.parse({ discovery: { cutover: { armWindowSec: 900 } } }).discovery.cutover.armWindowSec).toBe(900)
    })

    test('armPollSec is bounded to [1, 60]', () => {
      expect(() => FarmSettingsSchema.parse({ discovery: { cutover: { armPollSec: 0 } } })).toThrow()
      expect(() => FarmSettingsSchema.parse({ discovery: { cutover: { armPollSec: 61 } } })).toThrow()
      expect(FarmSettingsSchema.parse({ discovery: { cutover: { armPollSec: 1 } } }).discovery.cutover.armPollSec).toBe(1)
    })
  })
})

describe('FarmSettingsSchema.monitor — always-on crash detection switch (plan 85 §3.2, §4.1)', () => {
  test('a settings row that predates this field (an empty object) still parses, defaulting to "always"', () => {
    const parsed = FarmSettingsSchema.parse({})
    expect(parsed.monitor).toEqual({ crashWatch: 'always' })
    expect(defaultFarmSettings().monitor).toEqual({ crashWatch: 'always' })
  })

  test('only "always" or "off" are accepted', () => {
    expect(FarmSettingsSchema.parse({ monitor: { crashWatch: 'off' } }).monitor.crashWatch).toBe('off')
    expect(() => FarmSettingsSchema.parse({ monitor: { crashWatch: 'sometimes' } })).toThrow()
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
      memory: { defaultMaxRssBytes: null, maxRssBytes: null, enforce: 'kill', sampleIntervalMs: 2_000 },
      trigger: { maxDepth: 5, maxPerChain: 200, maxPerJob: 10 },
      // Plan 97 §3.4, §3.7, §4.9 — the result-size cap and the progress
      // coalescing interval, landed concurrently with this test's own plan.
      maxResultBytes: 65_536,
      progressIntervalMs: 1_000,
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

describe('FarmSettingsSchema.job.memory — the script runtime envelope\'s memory field (plan 98 §3.5, §4.3)', () => {
  test('both byte fields default to null (off) — a farm that sets neither sees no change at all, matching maxTimeoutMs\'s "offered, and off" precedent (F7)', () => {
    expect(defaultFarmSettings().job.memory).toEqual({ defaultMaxRssBytes: null, maxRssBytes: null, enforce: 'kill', sampleIntervalMs: 2_000 })
  })

  test('a legacy row without job.memory at all still parses, defaulting to no limit anywhere', () => {
    const legacyRow = { job: { resetPolicy: 'aggressive' } }
    expect(FarmSettingsSchema.parse(legacyRow).job.memory).toEqual({ defaultMaxRssBytes: null, maxRssBytes: null, enforce: 'kill', sampleIntervalMs: 2_000 })
  })

  // Regression guard: the plan's own §4.3 snippet writes `.min(64<<20).max(16<<30)`,
  // and `16 << 30` overflows JS's 32-bit bitwise operators to 0 — which would make
  // `max` LOWER than `min` and reject every real byte value. This settings.ts
  // implementation uses plain literals instead; these two boundary values are
  // exactly what that bug would have rejected.
  test('defaultMaxRssBytes/maxRssBytes accept the full documented range, 64 MiB through 16 GiB — regression guard against a 32-bit bitshift overflow', () => {
    const sixtyFourMiB = 64 * 1024 * 1024
    const sixteenGiB = 16 * 1024 * 1024 * 1024
    expect(FarmSettingsSchema.parse({ job: { memory: { defaultMaxRssBytes: sixtyFourMiB, maxRssBytes: sixteenGiB } } }).job.memory).toMatchObject({
      defaultMaxRssBytes: sixtyFourMiB,
      maxRssBytes: sixteenGiB,
    })
    expect(() => FarmSettingsSchema.parse({ job: { memory: { defaultMaxRssBytes: sixtyFourMiB - 1 } } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ job: { memory: { maxRssBytes: sixteenGiB + 1 } } })).toThrow()
  })

  test('enforce only accepts kill/warn/off, defaulting to kill', () => {
    expect(defaultFarmSettings().job.memory.enforce).toBe('kill')
    for (const mode of ['kill', 'warn', 'off'] as const) {
      expect(FarmSettingsSchema.parse({ job: { memory: { enforce: mode } } }).job.memory.enforce).toBe(mode)
    }
    expect(() => FarmSettingsSchema.parse({ job: { memory: { enforce: 'pause' } } })).toThrow()
  })

  test('sampleIntervalMs is bounded to [250, 30_000] and defaults to 2_000', () => {
    expect(defaultFarmSettings().job.memory.sampleIntervalMs).toBe(2_000)
    expect(FarmSettingsSchema.parse({ job: { memory: { sampleIntervalMs: 250 } } }).job.memory.sampleIntervalMs).toBe(250)
    expect(FarmSettingsSchema.parse({ job: { memory: { sampleIntervalMs: 30_000 } } }).job.memory.sampleIntervalMs).toBe(30_000)
    expect(() => FarmSettingsSchema.parse({ job: { memory: { sampleIntervalMs: 249 } } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ job: { memory: { sampleIntervalMs: 30_001 } } })).toThrow()
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
      maxArchiveBytes: 2_147_483_648,
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

  test('maxArchiveBytes — bulk pull\'s one-download archive cap (plan 93 §3.13, §4.1), bounded under the 4 GiB zip64 boundary', () => {
    expect(defaultFarmSettings().transfer.maxArchiveBytes).toBe(2_147_483_648)
    expect(() => FarmSettingsSchema.parse({ transfer: { maxArchiveBytes: 100 } })).toThrow()
    expect(FarmSettingsSchema.parse({ transfer: { maxArchiveBytes: 4_294_967_295 } }).transfer.maxArchiveBytes).toBe(4_294_967_295)
  })
})

describe('FarmSettingsSchema.shell — fleet fan-out and saved commands (plan 93 §3.8, §3.9, §3.10, §4.1)', () => {
  test('a settings row that predates these fields (an empty object) still parses, with working defaults', () => {
    const parsed = FarmSettingsSchema.parse({})
    expect(parsed.shell.fanoutEnabled).toBe(true)
    expect(parsed.shell.fanoutMaxDevices).toBe(0)
    expect(parsed.shell.fanoutConcurrency).toBe(0)
    expect(parsed.shell.fanoutMaxOutputBytes).toBe(32_768)
    expect(parsed.shell.fanoutPreviewBytes).toBe(2_048)
    expect(parsed.shell.fanoutConfirmThreshold).toBe(5)
    expect(parsed.shell.fanoutStageWaitSec).toBe(900)
    expect(parsed.shell.commandRunsPerUser).toBe(500)
    expect(parsed.shell.savedCommandLimit).toBe(200)
  })

  test('fanoutPreviewBytes stays well under MAX_BUFFERED (512 KB, ws-handlers.ts) at every bound — plan 93 §3.6, §4.4 sizing check', () => {
    const MAX_BUFFERED = 512 * 1024
    expect(FarmSettingsSchema.parse({}).shell.fanoutPreviewBytes).toBeLessThan(MAX_BUFFERED)
    expect(() => FarmSettingsSchema.parse({ shell: { fanoutPreviewBytes: 16_384 } })).not.toThrow()
    expect(FarmSettingsSchema.parse({ shell: { fanoutPreviewBytes: 16_384 } }).shell.fanoutPreviewBytes).toBeLessThan(MAX_BUFFERED)
  })

  test('fanoutMaxDevices / fanoutConcurrency / commandRunsPerUser / savedCommandLimit are bounded', () => {
    expect(() => FarmSettingsSchema.parse({ shell: { fanoutMaxDevices: -1 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ shell: { fanoutConcurrency: 65 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ shell: { commandRunsPerUser: 49 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ shell: { savedCommandLimit: 9 } })).toThrow()
  })
})

describe('FarmSettingsSchema.retention.commandRunDays — command console history GC (plan 93 §3.9, §4.1)', () => {
  test('a settings row that predates this field (an empty object) still parses, defaulting to 14 days', () => {
    expect(FarmSettingsSchema.parse({}).retention.commandRunDays).toBe(14)
  })

  test('NOT gated by retention.enabled — an unbounded command history is a disk-filling bug, not an opt-in convenience, matching eventMainDays/eventInputDays', () => {
    const parsed = FarmSettingsSchema.parse({ retention: { enabled: false } })
    expect(parsed.retention.enabled).toBe(false)
    expect(parsed.retention.commandRunDays).toBe(14)
  })

  test('bounded below at 1 day', () => {
    expect(() => FarmSettingsSchema.parse({ retention: { commandRunDays: 0 } })).toThrow()
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

describe('FarmSettingsSchema.guestAgent — the on-device agent\'s provisioning and recovery policy (plan 90 §3.7, §4.4)', () => {
  test('a settings row that predates this block (an empty object) still parses, defaulting to auto-provision and the new recovery numbers', () => {
    const parsed = FarmSettingsSchema.parse({})
    expect(parsed.guestAgent.provision).toBe('auto')
    expect(parsed.guestAgent.maxRecoveryCyclesPerHour).toBe(4)
    expect(parsed.guestAgent.recoveryRearmSec).toBe(120)
    expect(defaultFarmSettings().guestAgent).toEqual({ provision: 'auto', maxRecoveryCyclesPerHour: 4, recoveryRearmSec: 120 })
  })

  test('provision only accepts auto/manual/off', () => {
    for (const mode of ['auto', 'manual', 'off'] as const) {
      expect(FarmSettingsSchema.parse({ guestAgent: { provision: mode } }).guestAgent.provision).toBe(mode)
    }
    expect(() => FarmSettingsSchema.parse({ guestAgent: { provision: 'always' } })).toThrow()
  })

  test('maxRecoveryCyclesPerHour is bounded to [1, 20]', () => {
    expect(() => FarmSettingsSchema.parse({ guestAgent: { maxRecoveryCyclesPerHour: 0 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ guestAgent: { maxRecoveryCyclesPerHour: 21 } })).toThrow()
    expect(FarmSettingsSchema.parse({ guestAgent: { maxRecoveryCyclesPerHour: 10 } }).guestAgent.maxRecoveryCyclesPerHour).toBe(10)
  })

  test('recoveryRearmSec is bounded to [30, 3600] — replaces the old max(lastBackoff * 5, 60) derivation (F15)', () => {
    expect(() => FarmSettingsSchema.parse({ guestAgent: { recoveryRearmSec: 29 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ guestAgent: { recoveryRearmSec: 3_601 } })).toThrow()
    expect(FarmSettingsSchema.parse({ guestAgent: { recoveryRearmSec: 60 } }).guestAgent.recoveryRearmSec).toBe(60)
  })

  test('the generated JSON Schema represents every field (the settings form needs this to render the Guest agent tab)', () => {
    const jsonSchema = z.toJSONSchema(FarmSettingsSchema) as unknown as {
      properties: { guestAgent: { properties: Record<string, unknown> } }
    }
    expect(Object.keys(jsonSchema.properties.guestAgent.properties).sort()).toEqual(['maxRecoveryCyclesPerHour', 'provision', 'recoveryRearmSec'])
  })
})

describe('DeviceSettingsSchema.prep.textInput — the guest agent keyboard (plan 90 §3.2, §3.3, §4.4, §5 step 90.5)', () => {
  test('defaults to "auto" — including through defaultDeviceSettings(), which must not silently omit it (prep uses a literal, not a thunk, default)', () => {
    expect(defaultDeviceSettings().prep.textInput).toBe('auto')
    expect(DeviceSettingsSchema.parse({}).prep.textInput).toBe('auto')
  })

  test('accepts every documented mode', () => {
    for (const mode of ['auto', 'agent', 'device'] as const) {
      expect(DeviceSettingsSchema.parse({ prep: { textInput: mode } }).prep.textInput).toBe(mode)
    }
  })

  test('rejects a value outside the documented modes', () => {
    expect(() => DeviceSettingsSchema.parse({ prep: { textInput: 'ime' } })).toThrow()
  })

  test('a stored row without it (predates this field) still parses, defaulting to auto — same "row without the field" guarantee prep.rotation already has', () => {
    const parsed = DeviceSettingsSchema.parse({ prep: { keepAwake: 'always' } })
    expect(parsed.prep.textInput).toBe('auto')
  })

  test('FarmSettingsSchema.defaults.prep.textInput agrees with the device schema (they are the same schema, reused)', () => {
    expect(defaultFarmSettings().defaults.prep.textInput).toBe(defaultDeviceSettings().prep.textInput)
  })
})

describe('FarmSettingsSchema.coControl — Assist (plan 91 §3.2, §3.6, §4.5, §5 step 91.3)', () => {
  test('a settings row that predates this block (an empty object) still parses, defaulting to operator mode', () => {
    const parsed = FarmSettingsSchema.parse({})
    expect(parsed.coControl.mode).toBe('operator')
    expect(parsed.coControl.grantTtlSec).toBe(300)
    expect(parsed.coControl.maxConcurrentPerDevice).toBe(1)
    expect(parsed.coControl.queueWaitMs).toBe(5_000)
    expect(parsed.coControl.maxQueueDepth).toBe(32)
    expect(defaultFarmSettings().coControl).toEqual({
      mode: 'operator',
      grantTtlSec: 300,
      maxConcurrentPerDevice: 1,
      queueWaitMs: 5_000,
      maxQueueDepth: 32,
    })
  })

  test('mode only accepts off/admin/operator', () => {
    for (const mode of ['off', 'admin', 'operator'] as const) {
      expect(FarmSettingsSchema.parse({ coControl: { mode } }).coControl.mode).toBe(mode)
    }
    expect(() => FarmSettingsSchema.parse({ coControl: { mode: 'everyone' } })).toThrow()
  })

  test('grantTtlSec is bounded to [30, 3600]', () => {
    expect(() => FarmSettingsSchema.parse({ coControl: { grantTtlSec: 29 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ coControl: { grantTtlSec: 3_601 } })).toThrow()
    expect(FarmSettingsSchema.parse({ coControl: { grantTtlSec: 600 } }).coControl.grantTtlSec).toBe(600)
  })

  test('maxConcurrentPerDevice is bounded to [1, 4]', () => {
    expect(() => FarmSettingsSchema.parse({ coControl: { maxConcurrentPerDevice: 0 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ coControl: { maxConcurrentPerDevice: 5 } })).toThrow()
  })

  test('queueWaitMs is bounded to [500, 30000]', () => {
    expect(() => FarmSettingsSchema.parse({ coControl: { queueWaitMs: 499 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ coControl: { queueWaitMs: 30_001 } })).toThrow()
  })

  test('maxQueueDepth is bounded to [1, 256]', () => {
    expect(() => FarmSettingsSchema.parse({ coControl: { maxQueueDepth: 0 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ coControl: { maxQueueDepth: 257 } })).toThrow()
  })

  test('the generated JSON Schema represents every field (the settings form needs this to render the Assist & mirror tab)', () => {
    const jsonSchema = z.toJSONSchema(FarmSettingsSchema) as unknown as {
      properties: { coControl: { properties: Record<string, unknown> } }
    }
    expect(Object.keys(jsonSchema.properties.coControl.properties).sort()).toEqual([
      'grantTtlSec',
      'maxConcurrentPerDevice',
      'maxQueueDepth',
      'mode',
      'queueWaitMs',
    ])
  })
})

describe('FarmSettingsSchema.mirror — controlling many devices at once (plan 91 §3.7, §3.9, §4.5, §5 step 91.3)', () => {
  test('a settings row that predates this block (an empty object) still parses, defaulting to 20 devices', () => {
    const parsed = FarmSettingsSchema.parse({})
    expect(parsed.mirror.maxDevices).toBe(20)
    expect(parsed.mirror.requireSameOrientation).toBe(true)
    expect(parsed.mirror.aspectTolerance).toBe(0.05)
    expect(parsed.mirror.dropAfterConsecutiveFailures).toBe(3)
    expect(defaultFarmSettings().mirror).toEqual({
      maxDevices: 20,
      requireSameOrientation: true,
      aspectTolerance: 0.05,
      dropAfterConsecutiveFailures: 3,
    })
  })

  test('maxDevices is bounded to [2, 64]', () => {
    expect(() => FarmSettingsSchema.parse({ mirror: { maxDevices: 1 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ mirror: { maxDevices: 65 } })).toThrow()
  })

  test('aspectTolerance is bounded to [0, 0.5]', () => {
    expect(() => FarmSettingsSchema.parse({ mirror: { aspectTolerance: -0.01 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ mirror: { aspectTolerance: 0.51 } })).toThrow()
  })

  test('dropAfterConsecutiveFailures is bounded to [1, 20]', () => {
    expect(() => FarmSettingsSchema.parse({ mirror: { dropAfterConsecutiveFailures: 0 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ mirror: { dropAfterConsecutiveFailures: 21 } })).toThrow()
  })

  test('requireSameOrientation can be turned off (keys/text still reach a rotated member — enforced by the mirror dispatcher, not this schema)', () => {
    expect(FarmSettingsSchema.parse({ mirror: { requireSameOrientation: false } }).mirror.requireSameOrientation).toBe(false)
  })
})

/**
 * The riskiest part of plan 91 §5 step 91.3: `INPUT_ACTION_BODIES` now backs
 * BOTH the five pre-existing input messages and the new `MirrorActionSchema`.
 * Every one of these assertions held true before the refactor (this file's
 * `input.test.ts` sibling is unchanged and still passes); this block locks
 * the wire shape down explicitly, in the same file the plan names for it.
 */
describe('input.ts — INPUT_ACTION_BODIES refactor is wire-identical (plan 91 §4.4, §5 step 91.3)', () => {
  test('InputTapMessage: unchanged bounds on pos', () => {
    expect(InputTapMessage.safeParse({ type: 'input.tap', payload: { deviceId: 'd1', pos: { x: 0.5, y: 0.5 } } }).success).toBe(true)
    expect(InputTapMessage.safeParse({ type: 'input.tap', payload: { deviceId: 'd1', pos: { x: 1.1, y: 0.5 } } }).success).toBe(false)
    expect(InputTapMessage.safeParse({ type: 'input.tap', payload: { deviceId: 'd1', pos: { x: -0.1, y: 0.5 } } }).success).toBe(false)
  })

  test('InputSwipeMessage: unchanged durationMs default and bounds', () => {
    const parsed = InputSwipeMessage.parse({ type: 'input.swipe', payload: { deviceId: 'd1', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } } })
    expect(parsed.payload.durationMs).toBe(300)
    expect(
      InputSwipeMessage.safeParse({ type: 'input.swipe', payload: { deviceId: 'd1', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, durationMs: 49 } })
        .success,
    ).toBe(false)
    expect(
      InputSwipeMessage.safeParse({
        type: 'input.swipe',
        payload: { deviceId: 'd1', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, durationMs: 10_001 },
      }).success,
    ).toBe(false)
  })

  test('InputKeyMessage: unchanged keycode bounds [0, 320]', () => {
    expect(InputKeyMessage.safeParse({ type: 'input.key', payload: { deviceId: 'd1', keycode: 321 } }).success).toBe(false)
    expect(InputKeyMessage.safeParse({ type: 'input.key', payload: { deviceId: 'd1', keycode: -1 } }).success).toBe(false)
    expect(InputKeyMessage.safeParse({ type: 'input.key', payload: { deviceId: 'd1', keycode: 320 } }).success).toBe(true)
  })

  test('InputTextMessage: still requires a top-level id (plan 90 §3.3) and bounds text to [1, 1000]', () => {
    expect(InputTextMessage.safeParse({ type: 'input.text', payload: { deviceId: 'd1', text: 'hi' } }).success).toBe(false)
    expect(InputTextMessage.safeParse({ type: 'input.text', id: 'req-1', payload: { deviceId: 'd1', text: '' } }).success).toBe(false)
    expect(InputTextMessage.safeParse({ type: 'input.text', id: 'req-1', payload: { deviceId: 'd1', text: 'a'.repeat(1001) } }).success).toBe(false)
    expect(InputTextMessage.safeParse({ type: 'input.text', id: 'req-1', payload: { deviceId: 'd1', text: 'hi' } }).success).toBe(true)
  })

  test('INPUT_ACTION_BODIES declares exactly the five verbs, in order', () => {
    expect(Object.keys(INPUT_ACTION_BODIES)).toEqual(['tap', 'swipe', 'gesture', 'key', 'text'])
  })

  test('MirrorActionSchema accepts the same five verbs, discriminated, built from the same bodies', () => {
    expect(MirrorActionSchema.safeParse({ verb: 'tap', pos: { x: 0.5, y: 0.5 } }).success).toBe(true)
    expect(MirrorActionSchema.safeParse({ verb: 'swipe', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }).success).toBe(true)
    expect(
      MirrorActionSchema.safeParse({
        verb: 'gesture',
        samples: [
          { x: 0.1, y: 0.2, atMs: 0 },
          { x: 0.5, y: 0.6, atMs: 120 },
        ],
      }).success,
    ).toBe(true)
    expect(MirrorActionSchema.safeParse({ verb: 'key', keycode: 26 }).success).toBe(true)
    expect(MirrorActionSchema.safeParse({ verb: 'text', text: 'hello' }).success).toBe(true)
  })

  test('MirrorActionSchema rejects a verb outside the five, and rejects the same out-of-bounds values InputTapMessage does', () => {
    expect(MirrorActionSchema.safeParse({ verb: 'scroll', pos: { x: 0.5, y: 0.5 } }).success).toBe(false)
    expect(MirrorActionSchema.safeParse({ verb: 'tap', pos: { x: 1.1, y: 0.5 } }).success).toBe(false)
    expect(MirrorActionSchema.safeParse({ verb: 'key', keycode: 321 }).success).toBe(false)
  })
})

/**
 * Plan 92 §3.5, §4.1, step 92.1; wall numbers revised by plan 100 §3.4,
 * step 100.2. The byte-identical requirement (92.1's own "whole safety")
 * still holds for `control` — a farm that changes no control setting must
 * produce the exact pre-plan-92 `QUALITY_PROFILES.control` constant
 * (`{ maxSize: 1600, maxFps: 30, bitRate: 4_000_000 }`). `wall`'s defaults
 * are DELIBERATELY no longer byte-identical to that history: the old
 * `{ maxSize: 480, maxFps: 5, bitRate: 800_000 }` was the slideshow plan
 * 100 §1 exists to fix, and every farm that never touched `video.wallPreset`
 * now sees the new numbers on upgrade, on purpose. This is asserted again,
 * independently, in `packages/session/src/video-profile.test.ts` against
 * `CONTROL_PRESETS`/`WALL_PRESETS` — this file only proves the SCHEMA's own
 * defaults match, since `video-profile.ts` cannot see this schema's
 * defaults drift without a settings row actually being parsed.
 */
describe('FarmSettingsSchema.video — the two quality profiles as farm settings (plan 92 §3.5, §4.1; wall revised by plan 100 §3.4)', () => {
  test('a settings row that predates this block (an empty object) still parses: control stays byte-identical to pre-plan-92, wall resolves the plan 100 defaults', () => {
    const parsed = FarmSettingsSchema.parse({})
    expect(parsed.video).toEqual({
      controlPreset: 'sharp',
      controlMaxSize: 1600,
      controlMaxFps: 30,
      controlBitRate: 4_000_000,
      wallPreset: 'balanced',
      wallMaxSize: 480,
      wallMaxFps: 18,
      wallBitRate: 1_100_000,
    })
    expect(defaultFarmSettings().video).toEqual(parsed.video)
  })

  test('controlMaxSize is bounded to [480, 2560]', () => {
    expect(() => FarmSettingsSchema.parse({ video: { controlMaxSize: 479 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ video: { controlMaxSize: 2_561 } })).toThrow()
    expect(FarmSettingsSchema.parse({ video: { controlMaxSize: 1080 } }).video.controlMaxSize).toBe(1080)
  })

  test('controlMaxFps is bounded to [5, 60]', () => {
    expect(() => FarmSettingsSchema.parse({ video: { controlMaxFps: 4 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ video: { controlMaxFps: 61 } })).toThrow()
  })

  test('controlBitRate is bounded to [500_000, 20_000_000]', () => {
    expect(() => FarmSettingsSchema.parse({ video: { controlBitRate: 499_999 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ video: { controlBitRate: 20_000_001 } })).toThrow()
  })

  test('wallMaxSize is bounded to [160, 1080]', () => {
    expect(() => FarmSettingsSchema.parse({ video: { wallMaxSize: 159 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ video: { wallMaxSize: 1_081 } })).toThrow()
  })

  test('wallMaxFps is bounded to [1, 30]', () => {
    expect(() => FarmSettingsSchema.parse({ video: { wallMaxFps: 0 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ video: { wallMaxFps: 31 } })).toThrow()
  })

  test('wallBitRate is bounded to [100_000, 8_000_000]', () => {
    expect(() => FarmSettingsSchema.parse({ video: { wallBitRate: 99_999 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ video: { wallBitRate: 8_000_001 } })).toThrow()
  })

  test('controlPreset/wallPreset only accept their documented presets', () => {
    for (const preset of ['sharp', 'balanced', 'light'] as const) {
      expect(FarmSettingsSchema.parse({ video: { controlPreset: preset } }).video.controlPreset).toBe(preset)
    }
    expect(() => FarmSettingsSchema.parse({ video: { controlPreset: 'ultra' } })).toThrow()
    for (const preset of ['detailed', 'balanced', 'light', 'minimal'] as const) {
      expect(FarmSettingsSchema.parse({ video: { wallPreset: preset } }).video.wallPreset).toBe(preset)
    }
    expect(() => FarmSettingsSchema.parse({ video: { wallPreset: 'ultra' } })).toThrow()
  })

  test('no field in this block is optional (F22) — every field survives a round trip through an empty object', () => {
    const keys = Object.keys(FarmSettingsSchema.parse({}).video)
    expect(keys.sort()).toEqual(
      ['controlPreset', 'controlMaxSize', 'controlMaxFps', 'controlBitRate', 'wallPreset', 'wallMaxSize', 'wallMaxFps', 'wallBitRate'].sort(),
    )
  })

  test('the generated JSON Schema represents every field (the settings form needs this to render the Video tab)', () => {
    const jsonSchema = z.toJSONSchema(FarmSettingsSchema) as unknown as {
      properties: { video: { properties: Record<string, unknown> } }
    }
    expect(Object.keys(jsonSchema.properties.video.properties).sort()).toEqual(
      ['controlBitRate', 'controlMaxFps', 'controlMaxSize', 'controlPreset', 'wallBitRate', 'wallMaxFps', 'wallMaxSize', 'wallPreset'].sort(),
    )
  })

  test('ControlPresetSchema and WallPresetSchema are exported directly, matching the field-level enums above', () => {
    expect(ControlPresetSchema.options).toEqual(['sharp', 'balanced', 'light'])
    expect(WallPresetSchema.options).toEqual(['detailed', 'balanced', 'light', 'minimal'])
  })
})

describe('DeviceSettingsSchema.video — per-device override (plan 92 §3.5, §4.1)', () => {
  test('a row that predates this block (an empty object) still parses, every field absent — "follow the farm"', () => {
    const parsed = DeviceSettingsSchema.parse({})
    expect(parsed.video).toEqual({})
    expect(defaultDeviceSettings().video).toEqual({})
  })

  test('every field is independently optional and round-trips when set', () => {
    const parsed = DeviceSettingsSchema.parse({
      video: { controlPreset: 'light', wallMaxFps: 2, wallBitRate: 300_000 },
    })
    expect(parsed.video).toEqual({ controlPreset: 'light', wallMaxFps: 2, wallBitRate: 300_000 })
  })

  test('bounds match the farm-level fields exactly', () => {
    expect(() => DeviceSettingsSchema.parse({ video: { controlMaxSize: 100 } })).toThrow()
    expect(() => DeviceSettingsSchema.parse({ video: { wallMaxFps: 0 } })).toThrow()
    expect(DeviceSettingsSchema.parse({ video: { controlMaxSize: 480 } }).video.controlMaxSize).toBe(480)
  })

  test('PATCH-replaces-the-blob semantics (F21): a device settings object with no video key at all clears every override back to "follow the farm"', () => {
    // Simulates `PATCH /api/devices/:id` writing a fresh blob with the video
    // key omitted entirely — the whole point of F21 (the blob is REPLACED,
    // not merged), so an omitted key must genuinely mean "no override" here.
    const cleared = DeviceSettingsSchema.parse({ prep: { keepAwake: 'always' } })
    expect(cleared.video).toEqual({})
  })
})

/**
 * Plan 92 §3.7, §4.1, step 92.1. `wall.maxTiles` changed meaning from a fixed
 * 8 to `0 = auto` — the exact same legacy-migration shape
 * `FarmSettingsSchema.adb.maxStreams` above already established (plan 85).
 */
describe('FarmSettingsSchema.wall.maxTiles — legacy migration (plan 92 §3.7, §4.1)', () => {
  test('a stored 8 (the old, never-deliberately-chosen default) is rewritten to 0 (auto)', () => {
    expect(FarmSettingsSchema.parse({ wall: { maxTiles: 8 } }).wall.maxTiles).toBe(0)
  })

  test('a stored 12 (a deliberate, non-default value) is left untouched', () => {
    expect(FarmSettingsSchema.parse({ wall: { maxTiles: 12 } }).wall.maxTiles).toBe(12)
  })

  test('a fresh row with no wall.maxTiles at all defaults to 0 (auto), not the migration path', () => {
    expect(FarmSettingsSchema.parse({}).wall.maxTiles).toBe(0)
    expect(FarmSettingsSchema.parse({ wall: {} }).wall.maxTiles).toBe(0)
    expect(defaultFarmSettings().wall.maxTiles).toBe(0)
  })

  test('the migration does not disturb rampConcurrency on the same stored row', () => {
    const parsed = FarmSettingsSchema.parse({ wall: { maxTiles: 8, rampConcurrency: 4 } })
    expect(parsed.wall.maxTiles).toBe(0)
    expect(parsed.wall.rampConcurrency).toBe(4)
  })

  test('maxTiles is bounded to [0, 64] — min(0), not min(1) as before this plan', () => {
    expect(() => FarmSettingsSchema.parse({ wall: { maxTiles: -1 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ wall: { maxTiles: 65 } })).toThrow()
    expect(FarmSettingsSchema.parse({ wall: { maxTiles: 0 } }).wall.maxTiles).toBe(0)
  })

  test('rampConcurrency defaults to 2 and is bounded to [1, 8]', () => {
    expect(defaultFarmSettings().wall.rampConcurrency).toBe(2)
    expect(() => FarmSettingsSchema.parse({ wall: { rampConcurrency: 0 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ wall: { rampConcurrency: 9 } })).toThrow()
  })

  test('there is no defaultView field — §9 Q1 (decided 2026-08-12) cut it before it shipped', () => {
    const parsed = FarmSettingsSchema.parse({ wall: { maxTiles: 5, defaultView: 'list' } })
    expect(parsed.wall).not.toHaveProperty('defaultView')
    // Zod strips unknown keys by default (no `.strict()`), so passing an
    // extra `defaultView` does not throw — it is simply not part of the
    // resolved shape, which is the assertion that actually matters here.
    expect(Object.keys(parsed.wall).sort()).toEqual(
      ['maxTiles', 'rampConcurrency', 'decodeTileCeiling', 'bandwidthBps', 'transportOverride'].sort(),
    )
  })
})

/**
 * Plan 100 §3.1, §3.3, §4.1, step 100.2 — the three fields added to
 * `wall` for the decode/bandwidth budget split. Additive to the existing
 * block above (no migration): a stored row from before this plan has no
 * `decodeTileCeiling`/`bandwidthBps`/`transportOverride` at all, and Zod's
 * own per-field `.default()` fills them in on read, exactly like
 * `maxTiles`/`rampConcurrency` did when plan 92 added them.
 *
 * The bounds-ordering regression test below exists because of a real defect
 * class this codebase has already hit once: a `16 << 30` literal in an
 * earlier plan's settings snippet silently evaluated to 0 through int32
 * bit-shift overflow, which would have produced a `.min(67108864).max(0)`
 * range that rejects every legal value it was meant to allow. Both new
 * numeric bounds here are written as explicit decimal literals for exactly
 * that reason — this test is the guard that a future edit cannot
 * reintroduce the class of bug silently.
 */
describe('FarmSettingsSchema.wall.decodeTileCeiling / bandwidthBps / transportOverride — the plan 100 §3.1 budget split (step 100.2)', () => {
  test('decodeTileCeiling defaults to 24 (the placeholder pending the plan 100 §7.3 hardware ladder) and is bounded to [4, 64]', () => {
    expect(defaultFarmSettings().wall.decodeTileCeiling).toBe(24)
    expect(() => FarmSettingsSchema.parse({ wall: { decodeTileCeiling: 3 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ wall: { decodeTileCeiling: 65 } })).toThrow()
    expect(FarmSettingsSchema.parse({ wall: { decodeTileCeiling: 4 } }).wall.decodeTileCeiling).toBe(4)
    expect(FarmSettingsSchema.parse({ wall: { decodeTileCeiling: 64 } }).wall.decodeTileCeiling).toBe(64)
  })

  test('bandwidthBps defaults to 200 Mbit/s (a loopback/LAN-generous default, never binding by accident) and is bounded to [1_000_000, 1_000_000_000]', () => {
    expect(defaultFarmSettings().wall.bandwidthBps).toBe(200_000_000)
    expect(() => FarmSettingsSchema.parse({ wall: { bandwidthBps: 999_999 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ wall: { bandwidthBps: 1_000_000_001 } })).toThrow()
    expect(FarmSettingsSchema.parse({ wall: { bandwidthBps: 1_000_000 } }).wall.bandwidthBps).toBe(1_000_000)
    expect(FarmSettingsSchema.parse({ wall: { bandwidthBps: 1_000_000_000 } }).wall.bandwidthBps).toBe(1_000_000_000)
  })

  test('transportOverride defaults to "auto" and only accepts the four documented values', () => {
    expect(defaultFarmSettings().wall.transportOverride).toBe('auto')
    for (const t of ['auto', 'loopback', 'lan', 'wan'] as const) {
      expect(FarmSettingsSchema.parse({ wall: { transportOverride: t } }).wall.transportOverride).toBe(t)
    }
    expect(() => FarmSettingsSchema.parse({ wall: { transportOverride: 'ethernet' } })).toThrow()
  })

  test('regression guard: every new bound is ordered min < max and admits its own shipped default — the 16<<30-overflow class of bug cannot hide here', () => {
    const bounds: Array<{ name: string; min: number; max: number; shippedDefault: number }> = [
      { name: 'decodeTileCeiling', min: 4, max: 64, shippedDefault: defaultFarmSettings().wall.decodeTileCeiling },
      { name: 'bandwidthBps', min: 1_000_000, max: 1_000_000_000, shippedDefault: defaultFarmSettings().wall.bandwidthBps },
    ]
    for (const b of bounds) {
      expect(b.min).toBeLessThan(b.max)
      expect(b.shippedDefault).toBeGreaterThanOrEqual(b.min)
      expect(b.shippedDefault).toBeLessThanOrEqual(b.max)
      // The boundaries themselves must be legal values, not merely "close to" one —
      // this is what a silent 0-through-overflow max would have failed.
      expect(() => FarmSettingsSchema.parse({ wall: { [b.name]: b.min } })).not.toThrow()
      expect(() => FarmSettingsSchema.parse({ wall: { [b.name]: b.max } })).not.toThrow()
    }
  })

  test('a stored pre-plan-100 row (no new fields at all) parses cleanly and fills in every new default — no migration needed', () => {
    const legacyRow = { wall: { maxTiles: 6, rampConcurrency: 3 } }
    const parsed = FarmSettingsSchema.parse(legacyRow)
    expect(parsed.wall).toEqual({
      maxTiles: 6,
      rampConcurrency: 3,
      decodeTileCeiling: 24,
      bandwidthBps: 200_000_000,
      transportOverride: 'auto',
    })
  })
})

describe('FarmSettingsSchema.display.fallbackRetryCount — the screencap-loop fallback retry budget (plan 100 §4.3, step 100.6)', () => {
  test('defaults to 6 and is bounded to [0, 20]', () => {
    expect(defaultFarmSettings().display.fallbackRetryCount).toBe(6)
    expect(() => FarmSettingsSchema.parse({ display: { fallbackRetryCount: -1 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ display: { fallbackRetryCount: 21 } })).toThrow()
    expect(FarmSettingsSchema.parse({ display: { fallbackRetryCount: 0 } }).display.fallbackRetryCount).toBe(0)
    expect(FarmSettingsSchema.parse({ display: { fallbackRetryCount: 20 } }).display.fallbackRetryCount).toBe(20)
  })

  test('a stored pre-plan-100 row (no display block at all) parses cleanly and fills in the default — no migration needed', () => {
    const parsed = FarmSettingsSchema.parse({})
    expect(parsed.display).toEqual({ fallbackRetryCount: 6 })
  })
})

describe('FarmSettingsSchema.session.maxConcurrentBuilds — the build lane budget (plan 92 §3.3, §4.1)', () => {
  test('defaults to 2, alongside the pre-existing idleTtlSec/maxIdleSessions defaults', () => {
    const parsed = FarmSettingsSchema.parse({})
    expect(parsed.session.maxConcurrentBuilds).toBe(2)
    expect(parsed.session.idleTtlSec).toBe(300)
    expect(parsed.session.maxIdleSessions).toBe(8)
    expect(defaultFarmSettings().session.maxConcurrentBuilds).toBe(2)
  })

  test('is bounded to [1, 16]', () => {
    expect(() => FarmSettingsSchema.parse({ session: { maxConcurrentBuilds: 0 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ session: { maxConcurrentBuilds: 17 } })).toThrow()
    expect(FarmSettingsSchema.parse({ session: { maxConcurrentBuilds: 16 } }).session.maxConcurrentBuilds).toBe(16)
  })
})

describe('FarmSettingsSchema.readiness.maxHot — unchanged by plan 92, only its doc comment was corrected (§3.7)', () => {
  test('still defaults to 8 — plan 92 did not touch the number, only decoupled it from wall.maxTiles conceptually', () => {
    expect(defaultFarmSettings().readiness.maxHot).toBe(8)
  })

  // Plan 125 §3.1: the owner's instruction was direct — the default must be
  // on. A fleet that goes dark five minutes after you look away optimises for
  // a battery cost a permanently-powered rack does not pay.
  test('readiness.defaultDesired is `awake` on a fresh farm (plan 125 §3.1)', () => {
    expect(defaultFarmSettings().readiness.defaultDesired).toBe('awake')
    expect(FarmSettingsSchema.parse({}).readiness.defaultDesired).toBe('awake')
    // Through the BLOCK default too, not only the field default — the block's
    // `.default()` is a literal object Zod 4 does not re-parse.
    expect(FarmSettingsSchema.parse({ readiness: {} }).readiness.defaultDesired).toBe('awake')
  })

  // Plan 125 §8's "flipping a product default surprises an existing farm"
  // risk, and §5 step 125.2's migration note. `createFarmSettingsStore` writes
  // a FULLY MATERIALISED FarmSettings into the `farm_settings` row the first
  // time a farm boots, so an existing farm always has its own literal value
  // stored — this asserts the parse honours it rather than re-defaulting.
  test('an existing farm’s stored `asleep` is never rewritten by the new default', () => {
    expect(FarmSettingsSchema.parse({ readiness: { maxHot: 8, defaultDesired: 'asleep' } }).readiness.defaultDesired).toBe('asleep')
  })

  // The same guarantee, one level down, for the other default plan 125 §3.3
  // flipped: a device row is written with a fully materialised DeviceSettings
  // at admission, so a device enrolled before the flip re-reads its own value.
  test('an existing device’s stored `while-charging` is never rewritten by the new default', () => {
    expect(DeviceSettingsSchema.parse({ prep: { keepAwake: 'while-charging' } }).prep.keepAwake).toBe('while-charging')
  })
})

describe('FarmSettingsSchema.recording — the action recorder (plan 94 §4.6, step 94.3)', () => {
  test('a settings row that predates this field (an empty object) still parses, with the exact defaults the plan specifies', () => {
    const parsed = FarmSettingsSchema.parse({})
    expect(parsed.recording).toEqual({
      anchorQuietMs: 400,
      anchorMinIntervalMs: 1_500,
      longPressMs: 400,
      maxSteps: 500,
      maxDurationSec: 900,
      captureScreenshots: true,
    })
    expect(defaultFarmSettings().recording).toEqual(parsed.recording)
  })

  test('every field is independently overridable', () => {
    const parsed = FarmSettingsSchema.parse({
      recording: {
        anchorQuietMs: 200,
        anchorMinIntervalMs: 3_000,
        longPressMs: 600,
        maxSteps: 50,
        maxDurationSec: 60,
        captureScreenshots: false,
      },
    })
    expect(parsed.recording).toEqual({
      anchorQuietMs: 200,
      anchorMinIntervalMs: 3_000,
      longPressMs: 600,
      maxSteps: 50,
      maxDurationSec: 60,
      captureScreenshots: false,
    })
  })

  test('longPressMs cannot go below 200 — RecordingStepSchema.longPress.holdMs itself requires >= 200', () => {
    expect(() => FarmSettingsSchema.parse({ recording: { longPressMs: 199 } })).toThrow()
    expect(FarmSettingsSchema.parse({ recording: { longPressMs: 200 } }).recording.longPressMs).toBe(200)
  })

  test('maxSteps and maxDurationSec are bounded, never zero or negative', () => {
    expect(() => FarmSettingsSchema.parse({ recording: { maxSteps: 0 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ recording: { maxDurationSec: 0 } })).toThrow()
  })
})

describe('DeviceLabellingSchema / DeviceSettings.labelling / FarmSettings.labelling (plan 89 §3.8, §4.3, step 89.6)', () => {
  test('defaults to off, showName true — the wallpaper overwrites something an operator may care about, so nothing writes unattended', () => {
    expect(defaultDeviceSettings().labelling).toEqual({ mode: 'off', showName: true })
    expect(DeviceSettingsSchema.parse({}).labelling).toEqual({ mode: 'off', showName: true })
  })

  test('only off/lock-screen/wallpaper are valid modes', () => {
    expect(DeviceSettingsSchema.parse({ labelling: { mode: 'wallpaper' } }).labelling.mode).toBe('wallpaper')
    expect(DeviceSettingsSchema.parse({ labelling: { mode: 'lock-screen' } }).labelling.mode).toBe('lock-screen')
    expect(() => DeviceSettingsSchema.parse({ labelling: { mode: 'both' } })).toThrow()
  })

  test('a thunk default (F26’s pattern) — an empty object parses to the canonical defaults, never `undefined`', () => {
    const parsed = DeviceSettingsSchema.parse({ labelling: {} })
    expect(parsed.labelling).toEqual({ mode: 'off', showName: true })
  })

  test('FarmSettingsSchema.defaults.labelling agrees with the device schema (they are literally the same schema, F26)', () => {
    expect(FarmSettingsSchema.parse({}).defaults.labelling).toEqual(defaultDeviceSettings().labelling)
  })

  test('FarmSettings.labelling.maxConcurrent defaults to 2 and is bounded 1..16', () => {
    expect(FarmSettingsSchema.parse({}).labelling).toEqual({ maxConcurrent: 2 })
    expect(FarmSettingsSchema.parse({ labelling: { maxConcurrent: 16 } }).labelling.maxConcurrent).toBe(16)
    expect(() => FarmSettingsSchema.parse({ labelling: { maxConcurrent: 0 } })).toThrow()
    expect(() => FarmSettingsSchema.parse({ labelling: { maxConcurrent: 17 } })).toThrow()
  })
})

describe('FarmSettingsSchema.defaults — identity is excluded (docs/settings-audit.md #1, docs/plans/96-m61-hotfixes.md)', () => {
  test('a brand new farm settings row has no identity key under defaults at all', () => {
    const parsed = FarmSettingsSchema.parse({})
    expect(parsed.defaults).not.toHaveProperty('identity')
    expect(Object.keys(parsed.defaults)).not.toContain('identity')
  })

  test('the generated JSON Schema for FarmSettingsSchema.defaults has no identity property — the Settings → Defaults form can no longer render one', () => {
    const jsonSchema = z.toJSONSchema(FarmSettingsSchema) as unknown as {
      properties: { defaults: { properties: Record<string, unknown> } }
    }
    expect(Object.keys(jsonSchema.properties.defaults.properties)).not.toContain('identity')
  })

  test('DeviceSettingsSchema itself still has identity — only the farm-wide defaults block lost it, per-device identity is untouched', () => {
    const jsonSchema = z.toJSONSchema(DeviceSettingsSchema) as unknown as {
      properties: { identity: unknown }
    }
    expect(jsonSchema.properties.identity).toBeDefined()
    expect(DeviceSettingsSchema.parse({})).toHaveProperty('identity')
  })

  test('a stored farm settings row from before this change, whose defaults still carries an identity key, still parses cleanly — the unknown key is stripped, never E_BAD_CONFIG', () => {
    const legacyRow = {
      defaults: {
        ...defaultFarmSettings().defaults,
        identity: { timezone: 'Asia/Jakarta', locale: 'id-ID', gps: { lat: -6.2, lng: 106.8, accuracy: 50 } },
      },
    }
    const parsed = FarmSettingsSchema.safeParse(legacyRow)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.defaults).not.toHaveProperty('identity')
    // The rest of the legacy row's `defaults` block survives untouched —
    // this is a stripped unknown key, not a fallback to unrelated defaults.
    expect(parsed.data.defaults.autoReconnect).toBe(defaultFarmSettings().defaults.autoReconnect)
  })
})
