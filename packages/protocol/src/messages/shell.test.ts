import { describe, expect, test } from 'bun:test'
import { MonitorOneshotMessage } from './shell'

/**
 * `MonitorOneshotMessage.payload.options` (plan 90 §3.5, step 90.7) — added
 * so `meminfo`'s new `package` option has a wire path at all. Before this
 * field existed, `runOneshotMonitor` built every one-shot command with `{}`
 * unconditionally (`packages/core/src/device/monitor-hub.ts`), so even a
 * correctly-validated server-side option schema would never have received a
 * client-supplied value — this is the "last connection to the surface"
 * check for that fix.
 */
describe('MonitorOneshotMessage (plan 90 §3.5, step 90.7)', () => {
  test('accepts a payload with no options at all — every existing caller keeps working', () => {
    const parsed = MonitorOneshotMessage.safeParse({ type: 'monitor.oneshot', id: 'm1', payload: { deviceId: 'dev-1', kind: 'df' } })
    expect(parsed.success).toBe(true)
  })

  test('accepts an options object — the wire path meminfo\'s "package" option needs', () => {
    const parsed = MonitorOneshotMessage.safeParse({
      type: 'monitor.oneshot',
      id: 'm1',
      payload: { deviceId: 'dev-1', kind: 'meminfo', options: { package: 'com.example.app' } },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.payload.options).toEqual({ package: 'com.example.app' })
  })
})
