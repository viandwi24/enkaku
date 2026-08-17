import type { CoControlMode, ShellMode } from '@enkaku/protocol'
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
   * Assign or clear a device's `ownerId` (plan 09 §4.4 named this
   * `device.owner.set`; it was never carried into the matrix below until
   * now). Ownership is what `canUseDevice` bases every other per-device
   * gate on — lease acquisition, job enqueue, the adb endpoint — so letting
   * any operator reassign it would let them grant themselves, or take away
   * from someone else, exactly the access those gates exist to restrict.
   * Admin-only, the same default as `device.shell`/`device.adb`/
   * `device.files`/`kv.manage` here.
   */
  | 'device.owner.set'
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
   * Assist — reach into a device someone/something else already controls,
   * without taking it (plan 91 §3.2, §3.6, §4.6). Unlike `device.shell`/
   * `device.adb`/`device.files`, this sits directly in the OPERATOR set
   * below rather than behind an admin-only static default widened by a
   * mode: an assist grant is five narrow input verbs (tap/swipe/gesture/
   * key/text), never shell-equivalent access, so it does not need the same
   * admin-first posture those three do. `canAssist` still gates it together
   * with the farm's `coControl.mode`, the same "mode PLUS permission" shape
   * `canUseShell` established (F23).
   */
  | 'device.assist'
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
  /**
   * The durable key/value store's admin surface (plan 79 §4.3, step 4) —
   * `GET/PUT/DELETE /api/kv`. Deliberately admin-scoped from the start,
   * matching the plan's own wording: a KV value can hold a secret readable
   * in plaintext through this exact route (`get`), so it sits OUTSIDE the
   * `OPERATOR` set below, the same way `device.shell`/`device.adb` do,
   * rather than getting a `settings.manage`-style split gated on a farm
   * setting — nothing here widens it for an operator.
   */
  | 'kv.manage'
  /**
   * Read and write ONE plugin's own KV namespace through
   * `/api/plugins/:name/data/*` (plan 108 §3.7, step 108.4) — in the
   * `OPERATOR` set below, unlike `kv.manage` directly above it.
   *
   * The two are not redundant, and this one is not a weakening of that one.
   * `kv.manage` guards `/api/kv`, where the namespace is a QUERY PARAMETER:
   * `GET /api/kv/entry?namespace=…` can return a non-secret plaintext for
   * ANY namespace in the farm, so it stays admin-only exactly as it is.
   * `plugin.data` is structurally narrower: the namespace is never supplied
   * by the caller at all — it is the `:name` path segment, forced onto every
   * store call, and the route refuses with 404 unless a plugin of that name
   * is currently `active` or holds a dev slot. An operator therefore reaches
   * plugin data and nothing else, which is the boundary §3.7 is buying (a
   * boundary between plugin data and the rest of the database, not between
   * operators — an operator can already publish and run a script inside any
   * plugin, which reaches the same rows).
   */
  | 'plugin.data'
  /**
   * Start, stop or restart a plugin's SERVICE — the long-lived half plan 109
   * §4.2 loads into the core's own process. In the `OPERATOR` set below,
   * exactly as §4.6 specifies, and deliberately NOT `script.publish`.
   *
   * The two answer different questions. `script.publish` decides which VERSION
   * of a plugin is live, which is a change to what the farm runs; this decides
   * whether the currently-active version's service is running right now, which
   * is a change to nothing but its uptime. An operator looking at a plugin
   * screen whose service is down needs the second — criterion 21's Restart —
   * and making them hold the first would mean the only way to un-wedge a
   * screen is a permission that can also replace the code behind it.
   *
   * It grants no new REACH: a service that starts does exactly what its
   * already-consented manifest allows, checked by the same broker under the
   * same `plugin:<name>` principal (§4.3).
   */
  | 'plugin.runtime'

const OPERATOR: ReadonlySet<Permission> = new Set<Permission>([
  'device.view',
  'device.control',
  'device.settings',
  'device.enroll',
  'device.network',
  'device.assist',
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
  'plugin.data',
  'plugin.runtime',
])
// 'kv.manage' is deliberately NOT in OPERATOR (see its comment) — admin only.
// 'plugin.data' IS, and does not widen it: see its own comment for why the two are different.

/** Every permission the ACL matrix knows about — used to validate a caller-supplied permission NAME (e.g. an agent's `permissions` list, plan 65 §4.5) is real rather than a typo that would silently never match anything. */
export const ALL_PERMISSIONS: readonly Permission[] = [
  'device.view',
  'device.control',
  'device.settings',
  'device.enroll',
  'device.quarantine',
  'device.owner.set',
  'device.shell',
  'device.adb',
  'device.files',
  'device.network',
  'device.assist',
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
  'kv.manage',
  'plugin.data',
  'plugin.runtime',
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

/**
 * The gate for `job.cancel` on the two interactive paths (`POST
 * /api/jobs/:id/cancel`, the WS `job.cancel` message) — the agent/MCP-facing
 * capability (plan 63 §4.3, `capability/job.ts`) requires `job.cancel.any`
 * outright, no exception. These two paths give an operator a narrower one:
 * cancelling a job on a device they are themselves allowed to use
 * (`canUseDevice`) is ordinary operator work — the SAME ownership boundary
 * `job.run` already enforces at enqueue time (`services/job-service.ts`'s
 * `enqueue`). Cancelling a job on a device someone else owns is the
 * admin-shaped action the `.any` suffix names.
 *
 * There is no `job.cancel.own` permission in this ACL. Plan 09 §4.4 named
 * one, but it was never carried into the matrix above, and a job has no
 * per-user owner of its own — the `jobs` table has no `createdBy` column.
 * So "own" here is defined exactly the way every other per-resource check in
 * this file defines it: through the DEVICE's `ownerId`, not a separate grant.
 * `device: null` (the device row could not be found — a deleted device, or a
 * caller with no ownership data wired) is permissive, the same default
 * `canUseDevice`'s other call sites use when a device lookup comes back empty.
 */
export function canCancelJob(actor: { id: string; role: Role }, device: { ownerId: string | null } | null): boolean {
  if (can(actor.role, 'job.cancel.any')) return true
  return device === null || canUseDevice(actor, device)
}

/**
 * The gate for assisting a device someone/something else controls (plan 91
 * §3.2, §3.6, §4.6) — exactly the shape of `canUseShell` (:186-190): a
 * farm-wide mode PLUS a role permission, checked together,
 * server-authoritative. Deliberately NOT a widening of `shell.mode`:
 * assisting grants five input verbs (tap/swipe/gesture/key/text), never a
 * shell, so it gets its OWN mode (`coControl.mode`) rather than riding the
 * terminal's.
 *
 * `device.assist` is already in the OPERATOR set above (unlike
 * `device.shell`), so `can(role, 'device.assist')` alone would admit both
 * roles regardless of `mode` — the second check is what actually enforces
 * `mode: 'admin'` restricting this to admins.
 */
export function canAssist(role: Role, mode: CoControlMode): boolean {
  if (mode === 'off') return false
  if (!can(role, 'device.assist')) return false
  return mode === 'operator' || role === 'admin'
}
