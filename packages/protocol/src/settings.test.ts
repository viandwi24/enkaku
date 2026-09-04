import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { readHints } from './schema/vocabulary'
import { DeviceSettingsSchema, FarmSettingsSchema, defaultDeviceSettings, defaultFarmSettings, resolveDeviceSetting } from './settings'

const NINE_SECTIONS = ['general', 'hostDaemon', 'networkScan', 'jobRunner', 'capture', 'storage', 'devices', 'privacy', 'advanced']

describe('FarmSettingsSchema — the 26-field model (plan 212)', () => {
  test('top-level keys are the nine sections, in order', () => {
    expect(Object.keys(FarmSettingsSchema.shape)).toEqual(NINE_SECTIONS)
  })

  test('defaults round-trip', () => {
    const defaults = defaultFarmSettings()
    expect(FarmSettingsSchema.parse(defaults)).toEqual(defaults)
  })

  test('an unknown key is stripped, never rejected', () => {
    const raw = { ...defaultFarmSettings(), somethingRemoved: 'x', defaults: { anything: true } }
    const parsed = FarmSettingsSchema.parse(raw)
    expect(parsed).not.toHaveProperty('somethingRemoved')
    expect(parsed).not.toHaveProperty('defaults')
  })

  test('z.toJSONSchema(FarmSettingsSchema) does not throw', () => {
    expect(() => z.toJSONSchema(FarmSettingsSchema)).not.toThrow()
  })

  test('every field of the eleven advanced settings carries a hint', () => {
    type JsonNode = { properties?: Record<string, JsonNode>; description?: string }
    const json = z.toJSONSchema(FarmSettingsSchema) as unknown as { properties: Record<string, JsonNode> }
    const advanced = json.properties.advanced
    const fields = Object.values(advanced?.properties ?? {})
    expect(fields.length).toBe(11)
    for (const field of fields) {
      expect(readHints(field as never).hint, JSON.stringify(field)).toBeTruthy()
    }
  })

  test('every field of the fifteen visible settings carries a description', () => {
    type JsonNode = { properties?: Record<string, JsonNode>; description?: string }
    const json = z.toJSONSchema(FarmSettingsSchema) as unknown as { properties: Record<string, JsonNode> }
    const visibleSectionKeys = ['general', 'hostDaemon', 'networkScan', 'jobRunner', 'capture', 'storage', 'devices', 'privacy']
    const fields = visibleSectionKeys.flatMap((key) => Object.values(json.properties[key]?.properties ?? {}))
    expect(fields.length).toBe(15)
    for (const field of fields) {
      expect(field.description, JSON.stringify(field)).toBeTruthy()
    }
  })
})

describe('DeviceSettingsSchema — engines, identity, prep and optional overrides (plan 212 §4.6)', () => {
  test('device settings are engines, identity, prep and optional overrides', () => {
    expect(Object.keys(DeviceSettingsSchema.shape)).toEqual([
      'engines',
      'identity',
      'prep',
      'autoReconnect',
      'logInputText',
      'instrumentation',
      'overrides',
    ])
  })

  test('every field of overrides is optional and defaults to absent', () => {
    const parsed = defaultDeviceSettings()
    expect(parsed.overrides).toEqual({})
  })
})

describe('resolveDeviceSetting — the ONE place a device override is combined with the farm value (plan 212 §4.6)', () => {
  const farm = defaultFarmSettings()

  test('controlQuality: falls back to the farm value, and a device override wins', () => {
    expect(resolveDeviceSetting(farm, null, 'controlQuality')).toBe(farm.capture.controlQuality)
    const device = { ...defaultDeviceSettings(), overrides: { controlQuality: 'light' as const } }
    expect(resolveDeviceSetting(farm, device, 'controlQuality')).toBe('light')
  })

  test('wallQuality: falls back to the farm value, and a device override wins', () => {
    expect(resolveDeviceSetting(farm, null, 'wallQuality')).toBe(farm.capture.wallQuality)
    const device = { ...defaultDeviceSettings(), overrides: { wallQuality: 'detailed' as const } }
    expect(resolveDeviceSetting(farm, device, 'wallQuality')).toBe('detailed')
  })

  test('touchProfile: falls back to the farm value, and a device override wins', () => {
    expect(resolveDeviceSetting(farm, null, 'touchProfile')).toBe(farm.jobRunner.touchProfile)
    const device = { ...defaultDeviceSettings(), overrides: { touchProfile: 'slow' as const } }
    expect(resolveDeviceSetting(farm, device, 'touchProfile')).toBe('slow')
  })

  test('resetPolicy: falls back to the farm value, and a device override wins', () => {
    expect(resolveDeviceSetting(farm, null, 'resetPolicy')).toBe(farm.jobRunner.resetPolicy)
    const device = { ...defaultDeviceSettings(), overrides: { resetPolicy: 'never' as const } }
    expect(resolveDeviceSetting(farm, device, 'resetPolicy')).toBe('never')
  })

  test('defaultTimeoutMs: falls back to the farm value, and a device override wins', () => {
    expect(resolveDeviceSetting(farm, null, 'defaultTimeoutMs')).toBe(farm.jobRunner.defaultTimeoutMs)
    const device = { ...defaultDeviceSettings(), overrides: { defaultTimeoutMs: 60_000 } }
    expect(resolveDeviceSetting(farm, device, 'defaultTimeoutMs')).toBe(60_000)
  })

  test('deviceLabel: falls back to the farm value, and a device override wins', () => {
    expect(resolveDeviceSetting(farm, null, 'deviceLabel')).toBe(farm.general.deviceLabel)
    const device = { ...defaultDeviceSettings(), overrides: { deviceLabel: 'number' as const } }
    expect(resolveDeviceSetting(farm, device, 'deviceLabel')).toBe('number')
  })

  test('tempThresholdC: falls back to the farm value, and a device override wins', () => {
    expect(resolveDeviceSetting(farm, null, 'tempThresholdC')).toBe(farm.devices.tempThresholdC)
    const device = { ...defaultDeviceSettings(), overrides: { tempThresholdC: 50 } }
    expect(resolveDeviceSetting(farm, device, 'tempThresholdC')).toBe(50)
  })

  test('a null device (no row) always falls back to the farm value', () => {
    expect(resolveDeviceSetting(farm, null, 'controlQuality')).toBe(farm.capture.controlQuality)
  })
})
