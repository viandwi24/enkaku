import { describe, expect, test } from 'bun:test'
import { EngineDescriptorSchema, type EngineSelection, type RegistryResponse, validateEngineSelection } from './registry'

function descriptor(over: Partial<ReturnType<typeof EngineDescriptorSchema.parse>>) {
  return EngineDescriptorSchema.parse({
    id: 'x',
    displayName: 'x',
    kind: 'network',
    ...over,
  })
}

function registry(networks: RegistryResponse['networks']): RegistryResponse {
  return {
    transports: [descriptor({ id: 't', kind: 'transport' })],
    displays: [descriptor({ id: 'd', kind: 'display' })],
    inputs: [descriptor({ id: 'i', kind: 'input' })],
    inspectors: [descriptor({ id: 'ins', kind: 'inspector' })],
    networks,
    tools: [],
  }
}

function selection(network: string): EngineSelection {
  return { transport: 't', display: 'd', input: 'i', inspection: 'ins', network }
}

describe('validateEngineSelection — network engines (plan 44 §5.3)', () => {
  test('an unknown network engine is rejected with UNKNOWN_ENGINE', () => {
    const reg = registry([descriptor({ id: 'none', locks: [] })])
    const result = validateEngineSelection(reg, selection('does-not-exist'))
    expect(result).toEqual({
      ok: false,
      code: 'UNKNOWN_ENGINE',
      message: "network 'does-not-exist' is not in the registry",
    })
  })

  test('a single network engine is accepted', () => {
    const reg = registry([descriptor({ id: 'none', locks: [] })])
    expect(validateEngineSelection(reg, selection('none'))).toEqual({ ok: true })
  })

  test('the network-route lock is enforced by the shared validator — a network engine conflicting with any other chosen engine on the same lock is rejected with LOCK_CONFLICT', () => {
    // EngineSelection only carries one `network` id, so "two network engines" cannot
    // both be chosen through this API in the same call — the mutual exclusion instead
    // has to hold against any other selected engine that claims 'network-route'. This
    // proves the networks tuple was wired into the validator's shared lock-conflict loop.
    const reg: RegistryResponse = registry([descriptor({ id: 'vpn-helper', locks: ['network-route'] })])
    reg.transports = [descriptor({ id: 't', kind: 'transport', locks: ['network-route'] })]
    const result = validateEngineSelection(reg, selection('vpn-helper'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('LOCK_CONFLICT')
  })
})

describe('validateEngineSelection — ui-tree holds no instrumentation lock (plan 222 §3.8, §4.2)', () => {
  // This test builds its own descriptor shapes rather than importing
  // `packages/drivers/src/descriptors.ts`'s real `engineDescriptors`:
  // `@enkaku/drivers` depends on `@enkaku/protocol`, never the reverse
  // (CLAUDE.md), so a protocol-package test cannot import from drivers. The
  // shapes below are copied by hand from `descriptors.ts`'s `ui-tree`,
  // `scrcpy-uhid`, `scrcpy-sdk`, and `adb-input` entries (id, kind, locks) —
  // exactly what `validateEngineSelection` reads.
  test('ui-tree holds no lock, so no inspector/input combination conflicts', () => {
    const uiTree = descriptor({ id: 'ui-tree', kind: 'inspector', locks: [] })
    const inputs = [
      descriptor({ id: 'scrcpy-uhid', kind: 'input', locks: ['input-injection'] }),
      descriptor({ id: 'scrcpy-sdk', kind: 'input', locks: ['input-injection'] }),
      descriptor({ id: 'adb-input', kind: 'input', locks: ['input-injection'] }),
    ]
    for (const input of inputs) {
      const reg: RegistryResponse = {
        transports: [descriptor({ id: 't', kind: 'transport' })],
        displays: [descriptor({ id: 'd', kind: 'display' })],
        inputs: [input],
        inspectors: [uiTree],
        networks: [descriptor({ id: 'none', locks: [] })],
        tools: [],
      }
      const result = validateEngineSelection(reg, {
        transport: 't',
        display: 'd',
        input: input.id,
        inspection: 'ui-tree',
        network: 'none',
      })
      expect(result).toEqual({ ok: true })
    }
  })
})
