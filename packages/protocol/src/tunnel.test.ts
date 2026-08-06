import { describe, expect, test } from 'bun:test'
import { NodeToControlSchema } from './tunnel'

/**
 * Plan 61 §3.3, §7: the control plane's tunnel schema must keep parsing the
 * pre-rename `agent.hello`/`agent.devices` messages for one release — a node
 * binary already deployed in the field cannot be told to speak the new
 * vocabulary until it is upgraded. `node.hello`/`node.devices` are what a
 * post-plan-61 node actually sends; the `agent.*` variants exist ONLY for
 * this compatibility window (removed per the follow-up in `00-overview.md`).
 */
describe('NodeToControlSchema (plan 61 §3.3) — accepts both the new and the pre-rename hello/devices', () => {
  test('parses node.hello (what a post-plan-61 node sends)', () => {
    const parsed = NodeToControlSchema.safeParse({
      type: 'node.hello',
      payload: { nodeVersion: '0.0.1', platform: 'darwin-arm64', toolVersions: {} },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.type).toBe('node.hello')
  })

  test('parses the deprecated agent.hello (what a pre-plan-61 node still sends)', () => {
    const parsed = NodeToControlSchema.safeParse({
      type: 'agent.hello',
      payload: { agentVersion: '0.0.1', platform: 'darwin-arm64', toolVersions: {} },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.type).toBe('agent.hello')
  })

  test('rejects agent.hello with the NEW payload shape (nodeVersion instead of agentVersion) — the two variants do not silently cross-accept each other\'s payload', () => {
    const parsed = NodeToControlSchema.safeParse({
      type: 'agent.hello',
      payload: { nodeVersion: '0.0.1', platform: 'darwin-arm64', toolVersions: {} },
    })
    expect(parsed.success).toBe(false)
  })

  test('parses node.devices and the deprecated agent.devices with the identical payload shape', () => {
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
        status: 'idle' as const,
        lastSeen: 1_700_000_000,
        battery: null,
        quarantineReason: null,
        tags: [],
        cluster: null,
        lastCrashAt: null,
        readiness: { desired: 'asleep' as const, actual: 'asleep' as const, blocked: null, since: 1_700_000_000 },
      },
    ]
    const node = NodeToControlSchema.safeParse({ type: 'node.devices', payload: { devices } })
    const legacy = NodeToControlSchema.safeParse({ type: 'agent.devices', payload: { devices } })
    expect(node.success).toBe(true)
    expect(legacy.success).toBe(true)
  })

  test('an unrecognised type parses as neither — forward-compatible ignore, not a crash', () => {
    const parsed = NodeToControlSchema.safeParse({ type: 'something.else', payload: {} })
    expect(parsed.success).toBe(false)
  })
})
