import { describe, expect, test } from 'bun:test'
import { NodeToControlSchema } from './tunnel'

/**
 * Plan 61's `agent.hello`/`agent.devices` compatibility variants (kept for
 * one release so a node binary already deployed in the field could survive
 * the rename) were removed per the dated follow-up in `00-overview.md` §9 —
 * the deadline (v0.1.7) has passed. `node.hello`/`node.devices` are now the
 * only accepted spellings; the old ones must parse as unrecognised, exactly
 * like any other unknown type.
 */
describe('NodeToControlSchema — node.hello/node.devices only, the pre-rename agent.* variants are gone', () => {
  test('parses node.hello', () => {
    const parsed = NodeToControlSchema.safeParse({
      type: 'node.hello',
      payload: { nodeVersion: '0.0.1', platform: 'darwin-arm64', toolVersions: {} },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.type).toBe('node.hello')
  })

  test('rejects the removed agent.hello — a pre-rename node is no longer recognised', () => {
    const parsed = NodeToControlSchema.safeParse({
      type: 'agent.hello',
      payload: { agentVersion: '0.0.1', platform: 'darwin-arm64', toolVersions: {} },
    })
    expect(parsed.success).toBe(false)
  })

  test('parses node.devices', () => {
    const devices = [
      {
        id: 'd1',
        stableId: 'stable-1',
        serial: 'SERIAL1',
        label: 'Pixel',
        androidVersion: null,
        apiLevel: null,
        screenW: null,
        screenH: null,
        density: null,
        status: 'online' as const,
        lastSeen: 1_700_000_000,
        battery: null,
        quarantineReason: null,
        tags: [],
        group: null,
        lastCrashAt: null,
        readiness: { desired: 'asleep' as const, actual: 'asleep' as const, blocked: null, since: 1_700_000_000 },
      },
    ]
    const node = NodeToControlSchema.safeParse({ type: 'node.devices', payload: { devices } })
    expect(node.success).toBe(true)
  })

  test('rejects the removed agent.devices — same payload shape, but the type string is gone', () => {
    const parsed = NodeToControlSchema.safeParse({ type: 'agent.devices', payload: { devices: [] } })
    expect(parsed.success).toBe(false)
  })

  test('an unrecognised type parses as neither — forward-compatible ignore, not a crash', () => {
    const parsed = NodeToControlSchema.safeParse({ type: 'something.else', payload: {} })
    expect(parsed.success).toBe(false)
  })
})
