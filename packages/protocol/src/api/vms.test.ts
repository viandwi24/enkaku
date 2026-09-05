import { describe, expect, test } from 'bun:test'
import { VmCreateBodySchema, VmListResponseSchema, VmRecordSchema, VmResponseSchema } from './vms'

function baseSpec() {
  return {
    name: 'enkaku-test',
    apiLevel: 36,
    variant: 'google_apis' as const,
    memoryMb: 2048,
    deviceProfile: 'pixel_7',
  }
}

function baseRecord() {
  return {
    id: 'vm-1',
    name: 'enkaku-test',
    state: 'stopped' as const,
    consolePort: 5554,
    serial: 'emulator-5554',
    spec: baseSpec(),
    message: null,
    createdAt: 1_700_000_000,
    startedAt: null,
  }
}

describe('VmRecordSchema (plan 402 §4.1)', () => {
  test('a full record parses', () => {
    const parsed = VmRecordSchema.parse(baseRecord())
    expect(parsed.serial).toBe('emulator-5554')
  })

  test('startedAt: null parses', () => {
    const parsed = VmRecordSchema.parse({ ...baseRecord(), startedAt: null })
    expect(parsed.startedAt).toBeNull()
  })

  test('a non-null startedAt parses too', () => {
    const parsed = VmRecordSchema.parse({ ...baseRecord(), startedAt: 1_700_000_100 })
    expect(parsed.startedAt).toBe(1_700_000_100)
  })

  test('a bad state rejects', () => {
    expect(() => VmRecordSchema.parse({ ...baseRecord(), state: 'booting' })).toThrow()
  })

  test('name rejects a path separator', () => {
    expect(() => VmRecordSchema.parse({ ...baseRecord(), spec: { ...baseSpec(), name: '../evil' } })).toThrow()
  })

  test('name rejects a space', () => {
    expect(() => VmRecordSchema.parse({ ...baseRecord(), spec: { ...baseSpec(), name: 'my avd' } })).toThrow()
  })
})

describe('VmSpecSchema defaults (plan 402 §4.1)', () => {
  test('apiLevel, variant, memoryMb, deviceProfile default when omitted', () => {
    const parsed = VmCreateBodySchema.parse({ name: 'enkaku-test' })
    expect(parsed.apiLevel).toBe(36)
    expect(parsed.variant).toBe('google_apis')
    expect(parsed.memoryMb).toBe(2048)
    expect(parsed.deviceProfile).toBe('pixel_7')
    expect(parsed.abi).toBeUndefined()
  })

  test('name is required — an empty body rejects', () => {
    expect(() => VmCreateBodySchema.parse({})).toThrow()
  })
})

describe('VmListResponseSchema / VmResponseSchema (plan 402 §4.1)', () => {
  test('a list of records parses', () => {
    const parsed = VmListResponseSchema.parse({ vms: [baseRecord()] })
    expect(parsed.vms).toHaveLength(1)
  })

  test('an empty list parses', () => {
    const parsed = VmListResponseSchema.parse({ vms: [] })
    expect(parsed.vms).toHaveLength(0)
  })

  test('a single-record response parses', () => {
    const parsed = VmResponseSchema.parse({ vm: baseRecord() })
    expect(parsed.vm.id).toBe('vm-1')
  })
})
