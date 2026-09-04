import { describe, expect, test } from 'bun:test'
import legacyFixture from './__fixtures__/farm-settings-0.1.32.json'
import { migrateFarmSettings } from './migrate-settings'
import type { Logger } from '../util/logger'

function fakeLog(): { log: Logger; warnings: string[] } {
  const warnings: string[] = []
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg: string) => warnings.push(msg),
    error: () => {},
    child: () => fakeLog().log,
  }
  return { log, warnings }
}

describe('migrateFarmSettings (plan 212 §4.8)', () => {
  test('case 1: the full pre-212 blob parses, with the expected mapped values and no clamp warnings', () => {
    const { log, warnings } = fakeLog()
    const result = migrateFarmSettings(legacyFixture, log)
    expect(result.general.deviceLabel).toBe('off')
    expect(result.privacy.adbCommand).toBe(true)
    expect(result.jobRunner.resetPolicy).toBe('always')
    expect(result.capture.controlQuality).toBe('sharp')
    expect(warnings.filter((w) => w.includes('outside the new range'))).toEqual([])
  })

  test('case 2: 60 unknown extra keys do not change the result and do not throw', () => {
    const { log } = fakeLog()
    const extra: Record<string, unknown> = {}
    for (let i = 0; i < 60; i++) extra[`unknownField${i}`] = i
    const withExtras = { ...(legacyFixture as Record<string, unknown>), ...extra }
    const a = migrateFarmSettings(legacyFixture, log)
    const b = migrateFarmSettings(withExtras, log)
    expect(b).toEqual(a)
  })

  test('case 3: out-of-range values are clamped, one warn line per field, naming both numbers', () => {
    const { log, warnings } = fakeLog()
    const result = migrateFarmSettings({ retention: { traceDays: 9999 }, battery: { tempThresholdC: 300 } }, log)
    expect(result.storage.traceDays).toBe(3650)
    expect(result.devices.tempThresholdC).toBe(90)
    const clampWarnings = warnings.filter((w) => w.includes('outside the new range'))
    expect(clampWarnings.length).toBe(2)
    expect(clampWarnings.some((w) => w.includes('storage.traceDays') && w.includes('9999') && w.includes('3650'))).toBe(true)
    expect(clampWarnings.some((w) => w.includes('devices.tempThresholdC') && w.includes('300') && w.includes('90'))).toBe(true)
  })

  test('case 4: the old two-value touch profile "instant" maps to "precise"', () => {
    const { log } = fakeLog()
    const result = migrateFarmSettings({ defaults: { timing: { profile: 'instant' } } }, log)
    expect(result.jobRunner.touchProfile).toBe('precise')
  })

  test('case 5: shell.mode maps onto the adbCommand boolean', () => {
    const { log } = fakeLog()
    expect(migrateFarmSettings({ shell: { mode: 'off' } }, log).privacy.adbCommand).toBe(false)
    expect(migrateFarmSettings({ shell: { mode: 'operator' } }, log).privacy.adbCommand).toBe(true)
  })

  test('case 6: a value already in the new shape is returned unchanged, with no warn', () => {
    const { log, warnings } = fakeLog()
    const already = { general: { name: 'x', deviceLabel: 'number' } }
    const result = migrateFarmSettings(already, log)
    expect(result.general.name).toBe('x')
    expect(result.general.deviceLabel).toBe('number')
    expect(warnings).toEqual([])
  })
})
