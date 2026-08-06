import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { buildCapabilityRegistry, type CapabilitySource } from './registry'
import type { AnyCoreCapability } from './types'

function fakeCap(overrides: Partial<AnyCoreCapability> = {}): AnyCoreCapability {
  return {
    id: 'test.op',
    input: z.object({}),
    output: z.object({ ok: z.literal(true) }),
    permission: 'device.view',
    lease: 'none',
    deadline: 1_000,
    effect: 'read',
    description: 'a test capability',
    handler: async () => ({ ok: true }),
    ...overrides,
  }
}

describe('buildCapabilityRegistry (plan 63 §4.2, acceptance #1-3)', () => {
  test('accepts a well-formed capability', () => {
    const registry = buildCapabilityRegistry([{ cap: fakeCap(), file: 'a.ts' }])
    expect(registry.get('test.op')?.id).toBe('test.op')
    expect(registry.all()).toHaveLength(1)
  })

  test('rejects a duplicate id, naming both files (acceptance #2)', () => {
    const sources: CapabilitySource[] = [
      { cap: fakeCap({ id: 'device.tap' }), file: 'device-input.ts' },
      { cap: fakeCap({ id: 'device.tap' }), file: 'device-inspect.ts' },
    ]
    expect(() => buildCapabilityRegistry(sources)).toThrow(/device\.tap.*device-input\.ts.*device-inspect\.ts/s)
  })

  test.each(['id', 'permission', 'description'] as const)('rejects a missing "%s" field (acceptance #1)', (field) => {
    const cap = fakeCap({ [field]: '' } as Partial<AnyCoreCapability>)
    expect(() => buildCapabilityRegistry([{ cap, file: 'a.ts' }])).toThrow()
  })

  test('rejects an invalid lease value', () => {
    const cap = fakeCap({ lease: 'bogus' as AnyCoreCapability['lease'] })
    expect(() => buildCapabilityRegistry([{ cap, file: 'a.ts' }])).toThrow()
  })

  test('rejects an invalid effect value', () => {
    const cap = fakeCap({ effect: 'bogus' as AnyCoreCapability['effect'] })
    expect(() => buildCapabilityRegistry([{ cap, file: 'a.ts' }])).toThrow()
  })

  test('rejects a non-positive deadline', () => {
    const cap = fakeCap({ deadline: 0 })
    expect(() => buildCapabilityRegistry([{ cap, file: 'a.ts' }])).toThrow()
  })

  test('rejects an input/output schema that cannot convert to JSON Schema (acceptance #3)', () => {
    const cap = fakeCap({ output: z.custom<() => void>((v) => typeof v === 'function') })
    expect(() => buildCapabilityRegistry([{ cap, file: 'a.ts' }])).toThrow(/JSON Schema/)
  })

  test('visibleTo filters by permission (acceptance #8)', () => {
    const registry = buildCapabilityRegistry([
      { cap: fakeCap({ id: 'a', permission: 'device.view' }), file: 'a.ts' },
      { cap: fakeCap({ id: 'b', permission: 'device.files' }), file: 'b.ts' },
    ])
    const visible = registry.visibleTo({ hasPermission: (p) => p === 'device.view' })
    expect(visible.map((c) => c.id)).toEqual(['a'])
  })
})

describe('imageOutputs boot assertion (plan 70 §4.3, criterion 11)', () => {
  test('accepts a declared dataField that exists on the output schema', () => {
    const cap = fakeCap({ output: z.object({ image: z.string(), format: z.literal('png') }), imageOutputs: [{ dataField: 'image', mediaType: 'image/png' }] })
    expect(() => buildCapabilityRegistry([{ cap, file: 'a.ts' }])).not.toThrow()
  })

  test('fails the boot, naming the capability and the field, when the dataField does not exist', () => {
    const cap = fakeCap({
      id: 'device.screenshot',
      output: z.object({ image: z.string(), format: z.literal('png') }),
      imageOutputs: [{ dataField: 'picture', mediaType: 'image/png' }],
    })
    expect(() => buildCapabilityRegistry([{ cap, file: 'device-inspect.ts' }])).toThrow(/device\.screenshot.*picture/s)
  })

  test('fails the boot when a declared mediaTypeField does not exist', () => {
    const cap = fakeCap({ output: z.object({ image: z.string() }), imageOutputs: [{ dataField: 'image', mediaTypeField: 'mime' }] })
    expect(() => buildCapabilityRegistry([{ cap, file: 'a.ts' }])).toThrow(/mime/)
  })

  test('fails the boot when an entry names neither a fixed mediaType nor a mediaTypeField', () => {
    const cap = fakeCap({ output: z.object({ image: z.string() }), imageOutputs: [{ dataField: 'image' }] })
    expect(() => buildCapabilityRegistry([{ cap, file: 'a.ts' }])).toThrow()
  })

  test('a capability with no imageOutputs at all is unaffected', () => {
    expect(() => buildCapabilityRegistry([{ cap: fakeCap(), file: 'a.ts' }])).not.toThrow()
  })
})
