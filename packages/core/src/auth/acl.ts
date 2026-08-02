import type { ShellMode } from '@enkaku/protocol'
import type { Role } from './service'

/**
 * The ACL matrix (plan 09 §4.4). `admin` may do everything; `operator` is
 * limited to day-to-day work. Server-authoritative — the UI only hides buttons.
 */
export type Permission =
  | 'device.view'
  | 'device.control'
  | 'device.settings'
  | 'device.enroll'
  | 'device.quarantine'
  /**
   * Free-form shell commands on a device (plan 26 §3.2, §4.1) — genuine
   * remote code execution, so unlike everything else here it is admin-only
   * in the STATIC matrix below. `canUseShell` is the actual gate the WS
   * handler calls: it additionally honours the farm-wide `shell.mode`
   * setting, which is the only way an operator ever gains this.
   */
  | 'device.shell'
  /**
   * Opening a lease-scoped adb endpoint for a device (plan 27 §3.4, §4.3) —
   * lending the caller's own `adb` full control of the device, so it sits at
   * the same admin-only default as `device.shell` and is widened by the
   * SAME `shell.mode` switch (`canUseAdbEndpoint` below), not a second one.
   */
  | 'device.adb'
  | 'script.view'
  | 'script.publish'
  | 'script.delete'
  | 'job.view'
  | 'job.run'
  | 'job.cancel.any'
  | 'tool.view'
  | 'tool.manage'
  | 'settings.view'
  | 'settings.manage'
  | 'user.manage'
  | 'audit.view'

const OPERATOR: ReadonlySet<Permission> = new Set<Permission>([
  'device.view',
  'device.control',
  'device.settings',
  'device.enroll',
  'script.view',
  'script.publish',
  'job.view',
  'job.run',
  'tool.view',
  'settings.view',
])

export function can(role: Role, permission: Permission): boolean {
  return role === 'admin' ? true : OPERATOR.has(permission)
}

/**
 * The real gate for `shell.exec` (plan 26 §3.2, §4.1, §4.3): `device.shell`
 * alone (`can(role, 'device.shell')`) only ever admits `admin` — that is the
 * static ACL matrix's answer, ignoring settings entirely. The farm's
 * `shell.mode` then either narrows that further (`'off'` refuses everyone,
 * even an admin) or widens it (`'operator'` additionally admits operators).
 * `'admin'` mode is a no-op on top of the static matrix: admins already
 * pass, operators still do not.
 */
export function canUseShell(role: Role, mode: ShellMode): boolean {
  if (mode === 'off') return false
  if (can(role, 'device.shell')) return true
  return mode === 'operator' && role === 'operator'
}

/**
 * The gate for opening/closing/inspecting an adb endpoint (plan 27 §3.4,
 * §4.3) — deliberately reuses the terminal's `shell.mode` rather than
 * inventing a second role switch: an operator who has been granted shell
 * access on this farm is trusted with the endpoint too, since both are the
 * same "full remote code execution on this device" level of access. The
 * endpoint's OWN opt-in (`shell.endpointEnabled`) is a separate, additional
 * gate checked by the caller — this function only answers the role question.
 */
export function canUseAdbEndpoint(role: Role, mode: ShellMode): boolean {
  if (mode === 'off') return false
  if (can(role, 'device.adb')) return true
  return mode === 'operator' && role === 'operator'
}

/**
 * Device ownership (spec §12 `ownerId`): a device with no owner is free for
 * any operator; an owned device is for its owner and admins only.
 * (The default policy — see the Open questions in plan 09.)
 */
export function canUseDevice(user: { id: string; role: Role }, device: { ownerId: string | null }): boolean {
  if (user.role === 'admin') return true
  return device.ownerId === null || device.ownerId === user.id
}
