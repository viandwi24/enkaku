import { describe, expect, test } from 'bun:test'
import { ALL_PERMISSIONS, can, canAssist, canCancelJob, canUseAdbEndpoint, canUseShell, isPermission } from './acl'

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

/**
 * `device.assist` / `canAssist` (plan 91 §3.2, §3.6, §4.6) — the gate for
 * Assist, a narrow grant to touch a device someone/something else already
 * controls, checked the SAME "mode plus permission" way `canUseShell` is
 * (F23), but starting from an OPPOSITE static default: unlike `device.shell`,
 * `device.assist` is already in the OPERATOR set (it grants five input
 * verbs, never a shell), so `coControl.mode` alone decides admin-vs-operator
 * once `mode !== 'off'`.
 */
describe('device.assist / canAssist (plan 91 §3.2, §3.6, §4.6)', () => {
  test('the static ACL matrix admits BOTH admin and operator — unlike device.shell', () => {
    expect(can('admin', 'device.assist')).toBe(true)
    expect(can('operator', 'device.assist')).toBe(true)
  })

  test('mode "off" refuses everyone, including admin', () => {
    expect(canAssist('admin', 'off')).toBe(false)
    expect(canAssist('operator', 'off')).toBe(false)
  })

  test('mode "admin" admits only admin', () => {
    expect(canAssist('admin', 'admin')).toBe(true)
    expect(canAssist('operator', 'admin')).toBe(false)
  })

  test('mode "operator" (the default) admits both admin and operator', () => {
    expect(canAssist('admin', 'operator')).toBe(true)
    expect(canAssist('operator', 'operator')).toBe(true)
  })

  test('is a real, validated permission name', () => {
    expect(ALL_PERMISSIONS).toContain('device.assist')
    expect(isPermission('device.assist')).toBe(true)
  })
})

/**
 * `device.owner.set` (plan 09 §4.4) — gates the `ownerId` transition on
 * `PATCH /api/devices/:id`. Admin-only in the static matrix, unlike most
 * device permissions, because reassigning ownership changes what
 * `canUseDevice` admits for every other per-device gate.
 */
describe('device.owner.set (plan 09 §4.4, security fix)', () => {
  test('the static ACL matrix admits only admin, never operator', () => {
    expect(can('admin', 'device.owner.set')).toBe(true)
    expect(can('operator', 'device.owner.set')).toBe(false)
  })

  test('is a real, validated permission name', () => {
    expect(ALL_PERMISSIONS).toContain('device.owner.set')
    expect(isPermission('device.owner.set')).toBe(true)
  })
})

/**
 * `canCancelJob` (security fix, plan 09 §4.4's ownership boundary) — the
 * shared rule behind `POST /api/jobs/:id/cancel` and the WS `job.cancel`
 * message: `job.cancel.any` (admin, or an operator explicitly granted it)
 * bypasses ownership entirely; otherwise a job is only cancellable through
 * the SAME device-ownership boundary `job.run` already enforces at enqueue.
 */
describe('canCancelJob (security fix, plan 09 §4.4)', () => {
  const admin = { id: 'admin-1', role: 'admin' as const }
  const operator = { id: 'op-1', role: 'operator' as const }

  test('admin (job.cancel.any) can cancel a job on ANY device, owned or not', () => {
    expect(canCancelJob(admin, { ownerId: 'someone-else' })).toBe(true)
    expect(canCancelJob(admin, { ownerId: null })).toBe(true)
    expect(canCancelJob(admin, null)).toBe(true)
  })

  test('an operator can cancel a job on a device they own', () => {
    expect(canCancelJob(operator, { ownerId: 'op-1' })).toBe(true)
  })

  test('an operator can cancel a job on an unowned device', () => {
    expect(canCancelJob(operator, { ownerId: null })).toBe(true)
  })

  test('an operator CANNOT cancel a job on a device someone else owns — the bug this fixes', () => {
    expect(canCancelJob(operator, { ownerId: 'someone-else' })).toBe(false)
  })

  test('no device data at all (a test harness / host with no ownership wired) is permissive', () => {
    expect(canCancelJob(operator, null)).toBe(true)
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
