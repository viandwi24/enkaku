import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { AnyCoreCapability } from '../../capability/types'
import { buildToolSet } from './tools'

/**
 * Unit tests for the registry → `ToolSet` projection (plan 76 §3.2, §7's "unit — tools.ts: a
 * capability projected to a tool"). `execute` is deliberately absent from every generated tool
 * (see `tools.ts`'s own module comment for why) — these tests assert the SCHEMA/naming
 * projection; `harness/run.test.ts` proves every call still reaches `invoke()`.
 */

function cap(id: string, overrides: Partial<AnyCoreCapability> = {}): AnyCoreCapability {
  return {
    id,
    input: z.object({}),
    output: z.object({}),
    permission: 'device.control' as never,
    lease: 'none',
    deadline: 5000,
    effect: 'read',
    description: `describes ${id}`,
    handler: async () => ({}),
    ...overrides,
  }
}

describe('buildToolSet', () => {
  test('sanitises capability ids with dots into legal AI SDK tool names', () => {
    const { tools, capabilityIdForToolName } = buildToolSet([cap('device.tap')])
    expect(Object.keys(tools)).toEqual(['device_tap'])
    expect(capabilityIdForToolName.get('device_tap')).toBe('device.tap')
  })

  test('carries the capability description through unchanged', () => {
    const { tools } = buildToolSet([cap('device.tap', { description: 'Tap a point on the screen.' })])
    expect(tools.device_tap!.description).toBe('Tap a point on the screen.')
  })

  test('throws on a wire-name collision rather than silently dropping one tool', () => {
    expect(() => buildToolSet([cap('device.tap'), cap('device_tap')])).toThrow(/collision/)
  })

  test('no tool carries an execute function — every call is resolved by harness/run.ts, not the AI SDK', () => {
    const { tools } = buildToolSet([cap('device.tap'), cap('fs.read')])
    for (const tool of Object.values(tools)) expect(tool.execute).toBeUndefined()
  })

  test('for an anthropic connector, only the LAST tool (in sorted id order) carries the cache breakpoint', () => {
    const { tools } = buildToolSet([cap('z.last'), cap('a.first')], 'anthropic')
    // Sorted by id: a.first, z.last — so z.last is last.
    expect(tools.a_first!.providerOptions).toBeUndefined()
    expect(tools.z_last!.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } })
  })

  test('for openrouter (or no connector kind given), no tool carries a cache breakpoint', () => {
    const { tools } = buildToolSet([cap('a.first'), cap('z.last')], 'openrouter')
    for (const tool of Object.values(tools)) expect(tool.providerOptions).toBeUndefined()
    const { tools: tools2 } = buildToolSet([cap('a.first')])
    expect(tools2.a_first!.providerOptions).toBeUndefined()
  })
})
