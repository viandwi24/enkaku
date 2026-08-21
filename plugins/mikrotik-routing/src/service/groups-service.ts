import { z } from 'zod'
import { ASSIGNMENT_KEY, writeAssignment, type RouterConfig, type StoredAssignment } from '../shared'
import { applyNow, previewPlan, type ApplyDeps, type ApplyResult, type BlockedAssignment } from './apply'
import {
  decideActivation,
  describeConflicts,
  deriveGroupId,
  devicesOf,
  duplicateDeviceIds,
  groupIdFromKey,
  groupKeyFor,
  readGroup,
  writeGroup,
  GROUP_KEY_PREFIX,
  type ActivationDecision,
  type Group,
  type GroupConflict,
  type GroupEntry,
  type GroupFailoverPolicy,
  type GroupOnDeactivate,
} from './groups'
import type { LocalExceptionReport } from './local-exception'
import type { PlanRow } from './planner'
import { loadRouterConfig } from './router-config'
import { MikrotikRestDriver, type RouterDriver } from './router-driver'
import { resolveTarget } from './resolve'

/**
 * Groups end to end — plan 122 §5 step 122.8, the four things that step owns:
 * group CRUD, the activation transaction (§4.6 steps 4-7), deactivation
 * honouring `onDeactivate`, and (in `groups-routes.ts`/`ui/parts/groups.tsx`)
 * the tab itself. 122.7 built the pure algebra
 * (`groups.ts` — `readGroup`/`writeGroup`, `conflict`/`overlappingDeviceIds`,
 * `decideActivation`) and deliberately deferred every I/O; this file is that
 * I/O, mirroring `apply.ts`'s own split between pure computation and the
 * wiring around it.
 *
 * ## Why activation reuses `apply.ts`'s `applyNow` rather than writing to the
 * router itself
 *
 * §4.9's data model has ONE source of truth for "what should the router
 * currently be doing": each device's own `assignment` KV note
 * (`apply.ts`'s `loadFleetState`/`desiredEntriesFrom` read it for EVERY
 * device, unconditionally — a group's `active` flag never enters that
 * computation directly). So "build the desired rule set from the group" here
 * means writing THIS group's own entries into each of ITS devices'
 * `assignment` notes, and THEN calling `applyNow` — the exact same write path
 * a single Assignments-tab edit goes through (§5 step 122.8's own wording,
 * "apply through 122.6's write path"). Reusing it, rather than a second
 * apply implementation, is what makes "activation writes exactly the group's
 * rules and nothing else" true BY CONSTRUCTION: every other device's
 * `assignment` note is untouched, so `buildPlan` produces no row for it.
 *
 * ## Why deactivation does NOT go through `applyNow`
 *
 * Deactivation must support `onDeactivate: 'disable-rules'` — keep the rule,
 * set `disabled: true` — which `planner.ts`'s five-row vocabulary has no verb
 * for (a `disable` is not a `create`/`update`/`delete`). So deactivation acts
 * directly on the driver, one entry at a time, resolved the SAME way every
 * other write in this plugin resolves its target (`resolve.ts`'s
 * `resolveTarget`, §4.3) — never by a remembered `.id` (§3.3) — and then
 * clears each entry's own `assignment` note so the fleet-wide desired state
 * (what `applyNow` reads next time ANYTHING is applied) no longer claims
 * these devices. Because it only ever touches rules resolved from THIS
 * group's OWN `entries`, a foreign rule at the same address is never a
 * candidate (`resolveTarget` filters to the write-scope prefix first) and an
 * unrelated managed rule for a DIFFERENT group is never even visited.
 *
 * ## `previewActivateGroup` — the gap fix, 2026-08-21
 *
 * §4.4 ("Studio requires confirmation... before anything is written") and
 * 122.6's own Assignments tab both establish "preview, then confirm, then
 * apply" as this plugin's rule for any router write. This step's first
 * landing broke that rule for groups — the Activate dialog showed the real
 * §4.4 diff only AFTER `activateGroup` had already run, not before — flagged
 * honestly in this step's own "Deliberate scope trim" note as the wrong
 * order, and fixed here rather than left. `previewActivateGroup` answers the
 * exact same question `activateGroup` would act on, with zero writes: see its
 * own doc comment for how it reuses `apply.ts`'s `previewPlan` instead of a
 * second plan pipeline.
 */

// ---------------------------------------------------------------------------
// The host seam — a structural superset of `apply.ts`'s `ApplyHost` (every
// `GroupsHost` value is a valid `ApplyHost`, so it can be handed straight to
// `previewPlan`/`applyNow`), extended with the writes group CRUD and the
// activation transaction need: `global.set`/`.list`/`.delete` (group rows)
// and `forDevice(id).set`/`.delete` (the per-device `assignment` note, §4.9).
// ---------------------------------------------------------------------------

export interface GroupsHost {
  storage: {
    global: {
      getRaw(key: string): Promise<unknown>
      set(key: string, value: unknown): Promise<{ version: number }>
      list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ items: { key: string; value: unknown }[]; nextCursor: string | null }>
      delete(key: string, opts?: { ifVersion?: number }): Promise<boolean>
    }
    forDevice(deviceId: string): {
      getRaw(key: string): Promise<unknown>
      set(key: string, value: unknown): Promise<{ version: number }>
      delete(key: string, opts?: { ifVersion?: number }): Promise<boolean>
    }
  }
  farm: { call<T>(id: string, input: unknown, schema: z.ZodType<T>): Promise<T> }
  log: { warn(msg: string, fields?: Record<string, unknown>): void }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/** Every `group:<id>` row currently saved, parsed defensively (`groups.ts`'s own `readGroup` discipline). Paginates through every page `list` hands back rather than trusting one page holds all of them. */
export async function listAllGroups(host: GroupsHost): Promise<Group[]> {
  const groups: Group[] = []
  let cursor: string | undefined
  do {
    const page = await host.storage.global.list({ prefix: GROUP_KEY_PREFIX, cursor })
    for (const item of page.items) {
      const id = groupIdFromKey(item.key)
      if (id !== null) groups.push(readGroup(id, item.value))
    }
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return groups
}

/** One group by id, or `null` when no `group:<id>` row has ever been saved — distinct from a saved-but-empty row, which `readGroup` still turns into a valid (if useless) `Group`. */
async function getGroupRow(host: GroupsHost, id: string): Promise<Group | null> {
  const raw = await host.storage.global.getRaw(groupKeyFor(id))
  if (raw === null || raw === undefined) return null
  return readGroup(id, raw)
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface SaveGroupInput {
  /** Empty for CREATE — an id is minted from `name` (`deriveGroupId`, §4.9's own worked examples are slugs). Non-empty for UPDATE — must already exist. */
  id: string
  name: string
  note: string
  entries: GroupEntry[]
  onDeactivate: GroupOnDeactivate
  failoverPolicy: GroupFailoverPolicy
}

export type SaveGroupResult = { ok: true; group: Group } | { ok: false; code: string; message: string }

/**
 * Create or update a group. Refuses a duplicate `deviceId` inside `entries`
 * (acceptance criterion 12) BEFORE anything is written — the whole point of
 * this being a save-time check rather than the apply-time `duplicate`
 * refusal (§4.3) 122.7 found this gap next to.
 *
 * Editing an EXISTING group never changes its own `active` flag — that is
 * `activateGroup`/`deactivateGroup`'s job, a separate transaction, so a name
 * or entries edit can never accidentally flip what the router is doing.
 */
export async function saveGroup(host: GroupsHost, input: SaveGroupInput): Promise<SaveGroupResult> {
  const dupes = duplicateDeviceIds(input.entries)
  if (dupes.length > 0) {
    return {
      ok: false,
      code: 'E_GROUP_DUPLICATE_DEVICE',
      message: `This group lists the same device more than once: ${dupes.join(', ')}. One group can only claim a device at one path — remove the duplicate entry before saving (§4.3).`,
    }
  }
  if (input.name.trim() === '') {
    return { ok: false, code: 'E_GROUP_NAME_REQUIRED', message: 'Give this group a name before saving.' }
  }

  const existingGroups = await listAllGroups(host)

  let id = input.id
  let previouslyActive = false
  if (id === '') {
    id = deriveGroupId(
      input.name,
      existingGroups.map((g) => g.id),
    )
  } else {
    const existing = existingGroups.find((g) => g.id === id)
    if (!existing) return { ok: false, code: 'E_GROUP_NOT_FOUND', message: `No group is saved under "${id}".` }
    previouslyActive = existing.active
  }

  const group: Group = {
    id,
    name: input.name,
    note: input.note,
    entries: input.entries,
    active: previouslyActive,
    onDeactivate: input.onDeactivate,
    failoverPolicy: input.failoverPolicy,
    updatedAt: nowSec(),
  }

  await host.storage.global.set(groupKeyFor(id), writeGroup(group))
  return { ok: true, group }
}

export type DeleteGroupResult = { ok: true } | { ok: false; code: string; message: string }

/** Refuses to delete an ACTIVE group — its router rules would be orphaned with nothing left to say they were ever managed. Deactivate first. */
export async function deleteGroup(host: GroupsHost, id: string): Promise<DeleteGroupResult> {
  const group = await getGroupRow(host, id)
  if (!group) return { ok: false, code: 'E_GROUP_NOT_FOUND', message: `No group is saved under "${id}".` }
  if (group.active) {
    return { ok: false, code: 'E_GROUP_ACTIVE', message: `"${group.name || id}" is active — deactivate it first so its router rules are removed or disabled before the group itself is deleted.` }
  }
  await host.storage.global.delete(groupKeyFor(id))
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Deactivation (§4.6: "removes the group's managed rules ... onDeactivate:
// remove-rules (default) or disable-rules")
// ---------------------------------------------------------------------------

export interface DeactivateOutcome {
  deviceId: string
  action: 'deleted' | 'disabled' | 'left-alone'
  reason?: string
}

async function loadDriverFor(host: GroupsHost, deps: ApplyDeps): Promise<{ ok: true; driver: RouterDriver } | { ok: false; code: string; message: string }> {
  const createDriver = deps.createDriver ?? ((config: RouterConfig) => new MikrotikRestDriver(config))
  const loaded = await loadRouterConfig((key) => host.storage.global.getRaw(key))
  if (!loaded.ok) return { ok: false, code: 'E_ROUTER_NOT_CONFIGURED', message: loaded.message }
  return { ok: true, driver: createDriver(loaded.config) }
}

/**
 * Resolves each of `entries` against the router's OWN current rules
 * (`resolve.ts`'s `resolveTarget`, §4.3 — never a remembered `.id`, §3.3) and
 * removes or disables exactly the one it finds, per `onDeactivate`. An entry
 * with no matching rule is `left-alone` (nothing to undo); a `refuse-duplicate`
 * resolution is also `left-alone`, with a reason — §4.3's "never guess which
 * to keep" applies here exactly as it does to a write, and reconcile (122.9)
 * or the Rules tab is where a genuine duplicate gets sorted out by a human.
 */
async function deactivateEntries(driver: RouterDriver, entries: readonly GroupEntry[], onDeactivate: GroupOnDeactivate): Promise<DeactivateOutcome[]> {
  const rules = await driver.listRules()
  const outcomes: DeactivateOutcome[] = []

  for (const entry of entries) {
    const resolved = resolveTarget(rules, entry.lanIp)
    if (resolved.action === 'create') {
      outcomes.push({ deviceId: entry.deviceId, action: 'left-alone', reason: 'no matching rule on the router' })
      continue
    }
    if (resolved.action === 'refuse-duplicate') {
      outcomes.push({ deviceId: entry.deviceId, action: 'left-alone', reason: 'two managed rules already claim this endpoint (§4.3) — never guessed at' })
      continue
    }
    if (onDeactivate === 'remove-rules') {
      await driver.deleteRule(resolved.rule['.id'])
      outcomes.push({ deviceId: entry.deviceId, action: 'deleted' })
    } else {
      await driver.updateRule(resolved.rule['.id'], { disabled: true })
      outcomes.push({ deviceId: entry.deviceId, action: 'disabled' })
    }
  }

  return outcomes
}

export type DeactivateResult = { ok: true; group: Group; outcomes: DeactivateOutcome[] } | { ok: false; code: string; message: string }

/**
 * The actual transaction, shared by the standalone `deactivateGroup` below
 * and by `activateGroup`'s `force` path. `skipDeviceIds` is how `force`
 * avoids opening a window where an OVERLAPPING device has no assignment at
 * all (§4.6): for a device the candidate group is about to claim anyway, its
 * existing rule and `assignment` note are left exactly as they are here —
 * `applyNow` (called next, by the caller) will see the SAME still-live rule
 * and the candidate's freshly-written note and produce one `update` row
 * (old path → new path), never a delete followed by a separate create. Only
 * entries NOT claimed by the candidate are actually removed/disabled and
 * have their note cleared.
 */
async function deactivateGroupTransaction(host: GroupsHost, deps: ApplyDeps, group: Group, skipDeviceIds: ReadonlySet<string> = new Set()): Promise<DeactivateResult> {
  const loaded = await loadDriverFor(host, deps)
  if (!loaded.ok) return loaded

  const toDeactivate = group.entries.filter((e) => !skipDeviceIds.has(e.deviceId))
  const outcomes = await deactivateEntries(loaded.driver, toDeactivate, group.onDeactivate)

  for (const entry of toDeactivate) {
    await host.storage.forDevice(entry.deviceId).delete(ASSIGNMENT_KEY)
  }

  const updated: Group = { ...group, active: false, updatedAt: nowSec() }
  await host.storage.global.set(groupKeyFor(group.id), writeGroup(updated))

  return { ok: true, group: updated, outcomes }
}

/** Deactivates one group on its own — every one of its entries, per its own `onDeactivate` policy. Idempotent: an already-inactive group is still walked (its entries might carry a live rule from a previous partial run) rather than short-circuited. */
export async function deactivateGroup(host: GroupsHost, id: string, deps: ApplyDeps = {}): Promise<DeactivateResult> {
  const group = await getGroupRow(host, id)
  if (!group) return { ok: false, code: 'E_GROUP_NOT_FOUND', message: `No group is saved under "${id}".` }
  return deactivateGroupTransaction(host, deps, group)
}

// ---------------------------------------------------------------------------
// Activation (§4.6 steps 1-7)
// ---------------------------------------------------------------------------

export interface ActivateOk {
  ok: true
  group: Group
  /** Every OTHER group `force` deactivated first, in this same operation, and what happened to each of its entries. Empty when the activation was `clean`. */
  deactivated: { group: Group; outcomes: DeactivateOutcome[] }[]
  apply: ApplyResult & { ok: true }
}
export interface ActivateConflict {
  ok: false
  code: 'E_GROUP_CONFLICT'
  message: string
  conflicts: GroupConflict[]
}
export type ActivateResult = ActivateOk | ActivateConflict | { ok: false; code: string; message: string }

/**
 * `group.entries` → exactly the `StoredAssignment` values `activateGroup`
 * below writes for each one (`pathId`/`groupId`/`lanIp`/`lanIpSource:
 * 'manual'`) — factored out so the real write and the non-mutating preview
 * can never drift apart on what "this group's own desired state" means.
 */
function overridesFor(group: Group, now: number): Map<string, StoredAssignment> {
  const overrides = new Map<string, StoredAssignment>()
  for (const entry of group.entries) {
    overrides.set(entry.deviceId, { pathId: entry.pathId, groupId: group.id, lanIp: entry.lanIp, lanIpSource: 'manual', leaseKind: '', since: now })
  }
  return overrides
}

export interface ActivatePreviewOk {
  ok: true
  group: Group
  /** §4.6 steps 1-3 (122.7's `decideActivation`), computed without touching a router or KV — the exact outcome `activateGroup` would act on. */
  decision: ActivationDecision
  /** The §4.4 diff `applyNow` would execute if this group were activated right now — `apply.ts`'s own `buildPlan`, run over the candidate's own `entries` written into each device's `assignment` note IN MEMORY ONLY (`ApplyDeps.assignmentOverrides`), never persisted. */
  plan: PlanRow[]
  /** §3.2's precondition, exactly as `activateGroup` checks it before ever writing — surfaced here so a blocking state is visible BEFORE the operator presses anything, not after. */
  localException: LocalExceptionReport
  blocked: BlockedAssignment[]
}
export type ActivatePreviewResult = ActivatePreviewOk | { ok: false; code: string; message: string }

/**
 * The gap fix (plan 122 §5 step 122.8's own "deliberate scope trim", closed
 * 2026-08-21): a true, non-mutating preview of what `activateGroup(id,
 * force)` would do, computed BEFORE any write — the plan rows, the
 * `decideActivation` outcome (naming conflicting groups/devices, or under
 * `force` which groups would be deactivated first), and the §3.2 local-
 * exception state if it would block. Read-only end to end: `getGroupRow`/
 * `listAllGroups` only read `ctx.storage`, and `previewPlan` never calls a
 * driver write method (`apply.ts`'s own guarantee) — proven by a dedicated
 * test asserting zero `createRule`/`updateRule`/`deleteRule` calls even for a
 * conflicting, `force: true` preview.
 *
 * Reuses `apply.ts`'s `previewPlan` (and, through it, `prepareApply`/
 * `buildPlan`) rather than a second plan computation: `overridesFor` builds
 * the SAME `StoredAssignment` values `activateGroup` would persist for the
 * candidate's own devices, and hands them to `previewPlan` as
 * `ApplyDeps.assignmentOverrides` — an in-memory substitution for the KV read,
 * not a KV write. Every OTHER device's real stored `assignment` note is read
 * as normal, so the resulting plan is exactly what `applyNow` would compute
 * the instant those override values were actually written.
 *
 * Deliberately does NOT also simulate `force`'s deactivation of a
 * CONFLICTING group's own rules for its non-overlapping devices (only the
 * overlapping ones — already inside the candidate's own `entries` — are
 * reflected, correctly, as an `update`). Those non-overlapping devices are
 * unaffected by the override and so show no drift in this plan, exactly as
 * they would immediately BEFORE a real `force` activation runs. What they
 * are named IS surfaced: `decision.toDeactivate` states precisely which
 * groups would be deactivated and which devices each entails — the same
 * granularity the existing conflict-refusal UI already shows. A full
 * multi-group plan simulation (also modelling each conflicting group's own
 * `onDeactivate` policy — `disable-rules` has no verb in `planner.ts`'s
 * five-row vocabulary, `groups-service.ts`'s own header explains why
 * deactivation does not go through `applyNow` at all) is the "second, parallel
 * plan pipeline" this fix was explicitly told not to build.
 */
export async function previewActivateGroup(host: GroupsHost, id: string, force: boolean, deps: ApplyDeps = {}): Promise<ActivatePreviewResult> {
  const group = await getGroupRow(host, id)
  if (!group) return { ok: false, code: 'E_GROUP_NOT_FOUND', message: `No group is saved under "${id}".` }

  const dupes = duplicateDeviceIds(group.entries)
  if (dupes.length > 0) {
    return { ok: false, code: 'E_GROUP_DUPLICATE_DEVICE', message: `"${group.name || id}" lists the same device more than once: ${dupes.join(', ')} — fix the group before activating it.` }
  }

  const allGroups = await listAllGroups(host)
  const decision = decideActivation(group, allGroups, force)

  const preview = await previewPlan(host, { ...deps, assignmentOverrides: overridesFor(group, nowSec()) })
  if (!preview.ok) return preview

  return { ok: true, group, decision, plan: preview.rows, localException: preview.localException, blocked: preview.blocked }
}

/**
 * §4.6 steps 1-7, as one function: resolve conflicts (`decideActivation`,
 * 122.7), refuse or force-deactivate, build the desired rule set from the
 * group's own `entries` by writing each one's `assignment` note, apply
 * through `apply.ts`'s `applyNow` (§4.4's plan, then §3.2's gate, then the
 * write), and only on success mark the group active.
 */
export async function activateGroup(host: GroupsHost, id: string, force: boolean, deps: ApplyDeps = {}): Promise<ActivateResult> {
  const group = await getGroupRow(host, id)
  if (!group) return { ok: false, code: 'E_GROUP_NOT_FOUND', message: `No group is saved under "${id}".` }

  // Defensive — `saveGroup` already refuses this (criterion 12), but a row
  // could still arrive here hand-edited through `kv.manage`, and activation
  // must never build two desired rules for one endpoint.
  const dupes = duplicateDeviceIds(group.entries)
  if (dupes.length > 0) {
    return { ok: false, code: 'E_GROUP_DUPLICATE_DEVICE', message: `"${group.name || id}" lists the same device more than once: ${dupes.join(', ')} — fix the group before activating it.` }
  }

  const allGroups = await listAllGroups(host)
  const decision = decideActivation(group, allGroups, force)
  if (decision.kind === 'refuse') {
    return { ok: false, code: 'E_GROUP_CONFLICT', message: describeConflicts(group.name || group.id, decision.conflicts), conflicts: decision.conflicts }
  }

  // §3.2's precondition, checked BEFORE any mutation. `applyNow` below checks
  // it again on its own (and is the one that actually refuses the write) —
  // this earlier check exists so a `force` activation that is doomed to be
  // refused anyway never force-deactivates another group's real router rules
  // first for nothing.
  const preview = await previewPlan(host, deps)
  if (!preview.ok) return preview
  if (preview.localException.status !== 'ok') {
    return { ok: false, code: 'E_LOCAL_EXCEPTION_NOT_OK', message: `Activation refused (§3.2) — ${preview.localException.message}` }
  }

  const deactivated: { group: Group; outcomes: DeactivateOutcome[] }[] = []
  if (decision.kind === 'force') {
    const candidateDevices = devicesOf(group)
    for (const c of decision.toDeactivate) {
      const result = await deactivateGroupTransaction(host, deps, c.group, candidateDevices)
      if (result.ok) deactivated.push({ group: result.group, outcomes: result.outcomes })
      else host.log.warn('mikrotik-routing: force-deactivation of a conflicting group failed while activating another', { conflictingGroupId: c.group.id, code: result.code, message: result.message })
    }
  }

  const now = nowSec()
  for (const [deviceId, value] of overridesFor(group, now)) {
    await host.storage.forDevice(deviceId).set(ASSIGNMENT_KEY, writeAssignment(value))
  }

  const apply = await applyNow(host, deps)
  if (!apply.ok) return apply

  const updated: Group = { ...group, active: true, updatedAt: now }
  await host.storage.global.set(groupKeyFor(group.id), writeGroup(updated))

  return { ok: true, group: updated, deactivated, apply }
}
