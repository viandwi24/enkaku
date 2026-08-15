import { describe, expect, test } from 'bun:test'
import { EmptyMonitorOptionsSchema, MeminfoOptionsSchema, MonitorKindSchema, ONE_SHOT_MONITOR_KINDS, STREAMING_MONITOR_KINDS, optionsSchemaFor } from './monitor'

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

/**
 * `meminfo`'s optional `package` scope (plan 90 §3.5, step 90.7) — one of
 * the two host-side corrections adopted instead of an on-device monitoring
 * facet: "the host currently runs `dumpsys meminfo` with no package
 * argument" (§3.5) is a real gap, ten lines, not an APK.
 */
describe('meminfo package option (plan 90 §3.5, step 90.7)', () => {
  test('optionsSchemaFor(meminfo) is the real MeminfoOptionsSchema, not the empty one', () => {
    expect(optionsSchemaFor('meminfo')).toBe(MeminfoOptionsSchema)
  })

  test('an empty options object is still valid — omitting the package scans the whole device', () => {
    expect(MeminfoOptionsSchema.safeParse({}).success).toBe(true)
  })

  test('a well-formed package name parses', () => {
    const parsed = MeminfoOptionsSchema.safeParse({ package: 'com.example.app' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.package).toBe('com.example.app')
  })

  test('a malformed package name is rejected before it reaches the command builder', () => {
    expect(MeminfoOptionsSchema.safeParse({ package: 'not a package; rm -rf /' }).success).toBe(false)
  })

  test('every other one-shot/streaming kind still gets the empty schema', () => {
    for (const kind of ['top', 'thermal', 'crash', 'ps', 'df'] as const) {
      expect(optionsSchemaFor(kind)).toBe(EmptyMonitorOptionsSchema)
    }
  })
})
