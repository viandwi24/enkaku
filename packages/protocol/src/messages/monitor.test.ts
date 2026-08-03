import { describe, expect, test } from 'bun:test'
import { EmptyMonitorOptionsSchema, MonitorKindSchema, ONE_SHOT_MONITOR_KINDS, STREAMING_MONITOR_KINDS, optionsSchemaFor } from './monitor'

describe('MonitorKindSchema — the "crash" kind (plan 37 §4.1)', () => {
  test('crash is a valid kind', () => {
    expect(MonitorKindSchema.safeParse('crash').success).toBe(true)
  })

  test('crash is a STREAMING kind, not a one-shot one', () => {
    expect(STREAMING_MONITOR_KINDS).toContain('crash')
    expect(ONE_SHOT_MONITOR_KINDS).not.toContain('crash')
  })

  test('crash takes no options, same as top/thermal', () => {
    expect(optionsSchemaFor('crash')).toBe(EmptyMonitorOptionsSchema)
    expect(EmptyMonitorOptionsSchema.safeParse({}).success).toBe(true)
    expect(EmptyMonitorOptionsSchema.safeParse({ anything: true }).success).toBe(false)
  })

  test('every existing kind is still present — this is purely additive', () => {
    for (const kind of ['logcat', 'top', 'thermal', 'ps', 'meminfo', 'df']) {
      expect(MonitorKindSchema.safeParse(kind).success).toBe(true)
    }
  })
})
