import { describe, expect, test } from 'bun:test'
import { can, canUseAdbEndpoint, canUseShell } from './acl'

/**
 * `device.shell` across roles and every `shell.mode` value (plan 26 §7) —
 * this is the server-authoritative gate acceptance criteria 3 and 4 depend
 * on, so every combination is exercised explicitly rather than trusting the
 * two building blocks (`can` and the mode switch) to compose correctly.
 */
describe('device.shell / canUseShell (plan 26 §3.2, §4.1)', () => {
  test('the static ACL matrix admits only admin, never operator', () => {
    expect(can('admin', 'device.shell')).toBe(true)
    expect(can('operator', 'device.shell')).toBe(false)
  })

  test('mode "off" refuses everyone, including admin', () => {
    expect(canUseShell('admin', 'off')).toBe(false)
    expect(canUseShell('operator', 'off')).toBe(false)
  })

  test('mode "admin" admits only admin', () => {
    expect(canUseShell('admin', 'admin')).toBe(true)
    expect(canUseShell('operator', 'admin')).toBe(false)
  })

  test('mode "operator" admits both admin and operator', () => {
    expect(canUseShell('admin', 'operator')).toBe(true)
    expect(canUseShell('operator', 'operator')).toBe(true)
  })
})

/**
 * `device.adb` / `canUseAdbEndpoint` (plan 27 §3.4, §4.3) — same shape as
 * `device.shell` above, since the plan deliberately reuses `shell.mode`
 * rather than adding a second role switch for the endpoint.
 */
describe('device.adb / canUseAdbEndpoint (plan 27 §3.4, §4.3)', () => {
  test('the static ACL matrix admits only admin, never operator', () => {
    expect(can('admin', 'device.adb')).toBe(true)
    expect(can('operator', 'device.adb')).toBe(false)
  })

  test('mode "off" refuses everyone, including admin', () => {
    expect(canUseAdbEndpoint('admin', 'off')).toBe(false)
    expect(canUseAdbEndpoint('operator', 'off')).toBe(false)
  })

  test('mode "admin" admits only admin', () => {
    expect(canUseAdbEndpoint('admin', 'admin')).toBe(true)
    expect(canUseAdbEndpoint('operator', 'admin')).toBe(false)
  })

  test('mode "operator" admits both admin and operator', () => {
    expect(canUseAdbEndpoint('admin', 'operator')).toBe(true)
    expect(canUseAdbEndpoint('operator', 'operator')).toBe(true)
  })
})
