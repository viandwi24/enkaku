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
  /**
   * Push, pull, and APK install (plan 39 §3.7, §4.4) — a device write (push,
   * install) or a read of its filesystem (pull, which has no meaningful
   * "safe" subset of paths), so it sits at the same admin-only default as
   * `device.shell`/`device.adb` and is widened by the SAME `shell.mode`
   * switch (`canUseFiles` below), not a third one.
   */
  | 'device.files'
  /**
   * Install/repair/uninstall the guest agent and apply/revert its SOCKS5
   * route (plan 44 §5.8) — unlike `device.shell`/`device.adb`/`device.files`,
   * this is NOT admin-only by default: an operator legitimately running a
   * test through a proxy needs it, so it sits directly in the OPERATOR set
   * below rather than behind a `shell.mode`-style widening switch.
   */
  | 'device.network'
  /**
   * The database-backed workspace (plan 64 §4.2) — a caller with `fs.write`
   * still cannot write everywhere: the SCOPE (which path prefixes) is what
   * limits an agent, not this permission. A human operator gets both by
   * default (§3.2's "readable and writable by anyone with fs.write").
   */
  | 'fs.read'
  | 'fs.write'
  /**
   * AI agent records themselves — create/edit/delete an agent (plan 65
   * §4.5). This is DIFFERENT from what an agent is permitted to DO once it
   * runs: that is `agent.permissions` on the record, capped at its owner's
   * own set (§3.5) and never wider because of this permission. An operator
   * who can create agents can still only ever hand one the permissions they
   * themselves already have.
   */
  | 'agent.view'
  | 'agent.manage'
  /**
   * Talking to an agent — creating a thread, posting a message (which
   * starts a run), cancelling a run, deciding an approval (plan 66 §4.4).
   * Deliberately separate from `agent.manage`: that permission governs
   * editing the AGENT RECORD (model, tools, grants); this one governs
   * OPERATING an already-configured agent, the same split `device.view`/
   * `device.control` and `job.view`/`job.run` already draw for devices
   * and jobs.
   */
  | 'agent.run'
  /**
   * `notify.send` (plan 68 §4.3) — reaching a human via the in-app bell and
   * a webhook. Separate from `agent.run`: an agent that should observe but
   * never page anyone simply does not have this permission, the same
   * allowlist-shaped reasoning every other capability permission already
   * follows.
   */
  | 'notify.send'
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
  'device.network',
  'fs.read',
  'fs.write',
  'agent.view',
  'agent.manage',
  'agent.run',
  'notify.send',
  'script.view',
  'script.publish',
  'job.view',
  'job.run',
  'tool.view',
  'settings.view',
])

/** Every permission the ACL matrix knows about — used to validate a caller-supplied permission NAME (e.g. an agent's `permissions` list, plan 65 §4.5) is real rather than a typo that would silently never match anything. */
export const ALL_PERMISSIONS: readonly Permission[] = [
  'device.view',
  'device.control',
  'device.settings',
  'device.enroll',
  'device.quarantine',
  'device.shell',
  'device.adb',
  'device.files',
  'device.network',
  'fs.read',
  'fs.write',
  'agent.view',
  'agent.manage',
  'agent.run',
  'notify.send',
  'script.view',
  'script.publish',
  'script.delete',
  'job.view',
  'job.run',
  'job.cancel.any',
  'tool.view',
  'tool.manage',
  'settings.view',
  'settings.manage',
  'user.manage',
  'audit.view',
]

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value)
}

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
 * The gate for install/push/pull (plan 39 §3.7, §4.4) — reuses the terminal's
 * `shell.mode` rather than inventing a second role switch, exactly like
 * `canUseAdbEndpoint` does: an operator already trusted with shell access on
 * this farm is trusted with file transfer too, since both are "full remote
 * code execution / filesystem access on this device" in the same sense. The
 * farm's separate `transfer.enabled` opt-in is checked by the caller, not here.
 */
export function canUseFiles(role: Role, mode: ShellMode): boolean {
  if (mode === 'off') return false
  if (can(role, 'device.files')) return true
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
