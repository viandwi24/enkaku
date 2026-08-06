import { describe, expect, test } from 'bun:test'
import { ALL_PERMISSIONS, can, canUseAdbEndpoint, canUseShell, isPermission } from './acl'

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

/** `ALL_PERMISSIONS`/`isPermission` (plan 65 §4.5) — validates an agent's caller-supplied `permissions` list against the real ACL rather than accepting any string. */
describe('ALL_PERMISSIONS / isPermission (plan 65 §4.5)', () => {
  test('accepts every real permission name', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(isPermission(permission)).toBe(true)
    }
  })

  test('rejects a typo or invented permission name', () => {
    expect(isPermission('devices.control')).toBe(false)
    expect(isPermission('agent.execute')).toBe(false)
    expect(isPermission('')).toBe(false)
  })

  test('includes the new agent.view / agent.manage pair, agent.manage in the operator set', () => {
    expect(ALL_PERMISSIONS).toContain('agent.view')
    expect(ALL_PERMISSIONS).toContain('agent.manage')
    expect(can('operator', 'agent.manage')).toBe(true)
    expect(can('operator', 'agent.view')).toBe(true)
  })
})
