import { z } from 'zod'
import { DeviceInfoSchema, type DeviceInfo } from '@enkaku/protocol'
import { ASSIGNMENT_KEY, DEFAULT_GROUP_ID, DEFAULT_GROUP_NAME, EMPTY_ASSIGNMENT, deviceNameWithNumber, readAssignment, type RouterConfig, type StoredAssignment } from '../shared'
import { deriveCoreAddress, type CoreAddressResult } from './core-address'
import { messageOf, MikrotikRestError } from './errors'
import { buildIdentityBridge, type DeviceLanAddress, type StoredLanCandidates } from './identity-bridge'
import { classifyLocalException, type LocalExceptionReport, type ProtectedDevice } from './local-exception'
import { serialiseMarker } from './marker'
import { buildPlan, type PlanDesiredEntry, type PlanRow } from './planner'
import { loadRouterConfig } from './router-config'
import { MikrotikRestDriver, type Path, type PathHealth, type RouterDriver } from './router-driver'

/**
 * Apply, and the fleet-wide read behind the Assignments tab — plan 122 §5
 * step 122.6. **This is the one file in the plugin that actually writes to
 * the router.**
 *
 * ## The shape of a single assignment (§9 Q1)
 *
 * This step is stage 2 — single assignments, not named groups (122.7/122.8
 * own the group algebra and CRUD). Every assignment made from the
 * Assignments tab is modelled as living in the IMPLICIT group `default`
 * (`shared.ts`'s `DEFAULT_GROUP_ID`) — no `group:<id>` KV row is ever read or
 * written here. This is not a shortcut invented for this step: §9 Q1 already
 * settled it ("standalone assignments live in an implicit group named
 * `default`, so one invariant covers both cases with no special-casing"),
 * which is exactly what lets `planner.ts`'s `buildPlan` — built to diff
 * GROUP entries — serve a lone assignment with zero changes.
 *
 * ## Plan, then apply — one code path for both (§4.4)
 *
 * `previewPlan` and `applyNow` share `prepareApply`: both fetch the router's
 * CURRENT rules, inventory and device list fresh, build the identical
 * `PlanRow[]` through `planner.ts`'s `buildPlan`, and classify the §3.2
 * local-exception coverage the identical way. A preview and an apply can
 * therefore never disagree about what is about to happen — the one thing
 * §4.4 exists to guarantee.
 *
 * ## The gate (§3.2, acceptance criterion 1)
 *
 * `applyNow` refuses — never attempts — every write while
 * `classifyLocalException(...).status !== 'ok'`. This is checked AFTER the
 * plan is built (so the refusal can still explain itself with the same
 * report a preview would show) but BEFORE `executePlan` touches the router.
 * `missing` and `partial` both block, exactly as `partial` and `missing` are
 * `!== 'ok'` — there is no third branch to remember.
 *
 * ## Resolve-before-write, and why `.id` is never persisted (§3.3, §4.3)
 *
 * Every `create`/`update`/`delete` row in the plan already carries the
 * outcome of `resolve.ts`'s `resolveTarget`, run by `buildPlan` against the
 * rules THIS function fetched moments ago in the same request — never a
 * remembered id read back out of KV. `executePlan` below does no resolving of
 * its own; it only executes the rows the plan already decided, and a
 * `refuse-duplicate` outcome was already turned into a `skip` row by
 * `buildPlan` (`planner.ts`'s own header, point 1) — this file never sees it
 * and never has to choose which of two rules to keep.
 *
 * ## Previewing a write that has not happened yet (`ApplyDeps.assignmentOverrides`)
 *
 * `prepareApply` always reads every device's REAL `assignment` note — except
 * for device ids present in `deps.assignmentOverrides`, whose value is used
 * in place of the KV read. This is the one piece of plumbing `groups-
 * service.ts`'s `previewActivateGroup` needs to answer "what would activating
 * this group do" without writing anything: it hands `previewPlan` the exact
 * `StoredAssignment` values `activateGroup` would otherwise persist for the
 * group's own devices, so the SAME `prepareApply`/`buildPlan` this file
 * already runs for a real apply computes the plan — no second plan pipeline,
 * and a preview computed this way can never disagree with the apply that
 * follows once those values are actually written (§4.4).
 *
 * ## What is deliberately NOT here
 *
 * The `assignment` KV note itself (§4.9) is written by the BROWSER, directly,
 * through the core's generic `PUT/DELETE .../data/entry?scope=device&...`
 * route — the same non-secret, device-scoped write `plugins/proxy-manager`'s
 * own Assignments tab uses for its `assigned` note. Choosing a path or typing
 * a manual LAN IP is a note about INTENT and changes nothing on the router;
 * this file is what turns that intent into a real diff and, on `applyNow`,
 * a real write. `loadFleetState` below only ever READS the assignment KV.
 */

const DeviceListSchema = z.object({ items: z.array(DeviceInfoSchema) })

/** One device, joined to its resolved LAN address (§3.4) and its noted assignment — the Assignments tab's whole initial load, in one round trip. */
export interface FleetDeviceRow {
  deviceId: string
  stableId: string
  label: string
  /**
   * The device's operator-facing number (plan 89 §3.1), `null` when it has
   * none — put on the wire by plan 124 §3.7's table, which names this row as
   * one of five payloads that named a device and carried no number.
   *
   * It is not decoration. The owner's farm is 45 physically identical modems
   * and phones, so the Assignments tab and the group editor were listing
   * `SM-F721U1, SM-F721U1, SM-F721U1` and an operator could not tell which
   * row was the phone in their hand. The number is the ONLY field that tells
   * them apart, which is why it is carried here rather than composed into
   * `label` — nothing in this product writes `#7` into `devices.label`, and
   * nothing parses it back out (plan 124 §3.1).
   */
  number: number | null
  lan: DeviceLanAddress
  assignment: StoredAssignment
}

export interface FleetState {
  devices: FleetDeviceRow[]
  paths: Path[]
  health: PathHealth[]
}

/** A noted assignment that cannot be planned at all — the device has no known LAN address yet (§3.4's `needs-address`). Named explicitly rather than silently dropped from the plan. */
export interface BlockedAssignment {
  deviceId: string
  label: string
  reason: string
}

/** The narrow slice of a `PluginServiceContext` this file needs — the same trade `handlers.ts`'s own `HandlerHost` makes, extended with `storage.forDevice` since reading every device's own `assignment` note is this file's whole job. */
export interface ApplyHost {
  storage: {
    global: { getRaw(key: string): Promise<unknown> }
    forDevice(deviceId: string): { getRaw(key: string): Promise<unknown> }
  }
  farm: { call<T>(id: string, input: unknown, schema: z.ZodType<T>): Promise<T> }
  log: { warn(msg: string, fields?: Record<string, unknown>): void }
}

export interface ApplyDeps {
  createDriver?: (config: RouterConfig) => RouterDriver
  deriveCoreAddress?: (config: { baseUrl: string; tls: boolean }) => Promise<CoreAddressResult>
  /**
   * Per-device `assignment` overrides — read in place of `storage.forDevice
   * (id).getRaw('assignment')` for exactly the device ids present in the map,
   * every other device unaffected. `undefined` (the default) changes nothing:
   * `loadFleetState` reads every device's REAL stored note, as it always has.
   *
   * The one caller of this (`groups-service.ts`'s `previewActivateGroup`, gap
   * fix to plan 122 §5 step 122.8, 2026-08-21) uses it to answer "what would
   * `applyNow` do if this group's own `entries` were already written to their
   * devices' `assignment` notes" WITHOUT writing anything — by handing
   * `prepareApply` the exact same `StoredAssignment` values `activateGroup`
   * would otherwise persist. This is deliberately the only extra plumbing
   * added for that preview: `prepareApply`/`buildPlan` themselves are
   * untouched, so a preview computed this way and a real apply computed after
   * the override values are actually written can never disagree (§4.4's own
   * guarantee, preserved rather than reimplemented in a second pipeline).
   */
  assignmentOverrides?: ReadonlyMap<string, StoredAssignment>
}

/**
 * Every device (`device.list`), joined to its resolved LAN address and its
 * stored `assignment` note. N+1 over devices — one `getRaw` per device — the
 * same trade `plugins/proxy-manager/src/service/apply.ts`'s own
 * `currentHolders` makes: no host-side capability exists to scan device KV
 * across the whole fleet in one call from a service (that shape,
 * `GET .../data/scan`, is a browser-only, `plugin.data`-gated core route).
 * Bounded by the same fleet size every other per-device loop in this
 * workspace already is.
 */
export async function loadFleetState(host: ApplyHost, driver: RouterDriver, overrides?: ReadonlyMap<string, StoredAssignment>): Promise<FleetState> {
  const [devicesResult, inventory] = await Promise.all([host.farm.call('device.list', {}, DeviceListSchema), driver.inventory()])
  const devices: DeviceInfo[] = devicesResult.items

  const assignments: StoredAssignment[] = []
  for (const device of devices) {
    const override = overrides?.get(device.id)
    if (override) {
      assignments.push(override)
      continue
    }
    const raw = await host.storage.forDevice(device.id).getRaw(ASSIGNMENT_KEY)
    assignments.push(readAssignment(raw))
  }

  // Tier 2/3 candidates for the identity bridge (§3.4), sourced from each
  // device's own noted assignment — the only place this plugin persists a
  // probed or manually-entered LAN IP. Tier 1 (`connection.address`) always
  // wins inside `buildIdentityBridge` regardless of what is stored here.
  const candidates = new Map<string, StoredLanCandidates>()
  devices.forEach((device, i) => {
    const a = assignments[i]
    candidates.set(device.id, {
      probe: a?.lanIpSource === 'probe' && a.lanIp ? a.lanIp : null,
      manual: a?.lanIpSource === 'manual' && a.lanIp ? a.lanIp : null,
    })
  })

  const bridge = buildIdentityBridge(devices, inventory.leases, candidates)

  const rows: FleetDeviceRow[] = devices.map((device, i) => ({
    deviceId: device.id,
    stableId: device.stableId,
    label: device.label,
    // Plan 124 §0.2: this row was built from a real `DeviceInfo` — which has
    // carried `number` since plan 89 — and dropped it on the floor, which is
    // why no Mikrotik screen could show it. The whole payload change is this
    // one line plus the field on `FleetDeviceRowSchema` (`ui/parts/api.ts`).
    number: device.number,
    lan: bridge[i] ?? { deviceId: device.id, stableId: device.stableId, label: device.label, state: 'needs-address' as const },
    assignment: assignments[i] ?? EMPTY_ASSIGNMENT,
  }))

  return { devices: rows, paths: inventory.paths, health: inventory.health }
}

/**
 * The devices §3.2's coverage check can actually evaluate — resolved LAN
 * addresses only (`local-exception.ts`'s own contract: there is no
 * `src-address` to test coverage against for a device this plugin cannot yet
 * place). Exported so `reconcile.ts` (step 122.9) computes the SAME
 * local-exception gate this file's own `applyNow` does, rather than a second
 * implementation that could drift from it.
 */
export function protectedDevicesFrom(rows: readonly FleetDeviceRow[]): ProtectedDevice[] {
  const out: ProtectedDevice[] = []
  for (const row of rows) {
    // The number goes into the label here for the same reason
    // `local-exception.ts`'s `describeUncovered` already appends the address
    // (its own comment, defect 2 of step 122.12): this list is read as prose
    // ("Uncovered: …"), and the owner's own farm printed "SM-F721U1,
    // SM-F721U1, SM-F721U1" into it. The address says which rule has to cover
    // the device; the number says which phone on the rack it is. Both.
    if (row.lan.state === 'resolved') out.push({ id: row.deviceId, label: deviceNameWithNumber(row.number, row.label), address: row.lan.lanIp })
  }
  return out
}

/**
 * Every device with a noted path (`assignment.pathId !== ''`) becomes a
 * desired entry — UNLESS its LAN address is not yet resolvable, in which case
 * it is named in `blocked` rather than silently dropped (a device with no
 * `endpointKey` cannot appear in a plan row at all; `planner.ts` has nothing
 * to diff it against).
 *
 * Exported so `reconcile.ts` (step 122.9) builds the SAME `desired` state
 * `classifyDrift` is fed — the union of active groups' entries is, in this
 * plugin's data model, exactly every device's own noted `assignment` (§4.9,
 * this file's own header) — rather than a second reading of what "desired"
 * means.
 */
export function desiredEntriesFrom(rows: readonly FleetDeviceRow[]): { desired: PlanDesiredEntry[]; blocked: BlockedAssignment[] } {
  const desired: PlanDesiredEntry[] = []
  const blocked: BlockedAssignment[] = []
  for (const row of rows) {
    if (row.assignment.pathId === '') continue
    if (row.lan.state !== 'resolved') {
      blocked.push({
        deviceId: row.deviceId,
        // `blocked` is rendered as a plain sentence list in BOTH the Apply
        // dialog and the group Activate dialog, so it is a `string` and the
        // number has to be composed into it here (plan 124 §3.2's "for
        // toasts, aria-labels, dialog titles and joined lists" half). A bare
        // label in this list is the exact failure the plan exists to fix:
        // "3 devices cannot be applied yet — SM-F721U1, SM-F721U1, SM-F721U1"
        // tells an operator nothing about which three.
        label: deviceNameWithNumber(row.number, row.label),
        reason: 'No LAN IP is known for this device yet — enter one manually on the Assignments tab, or wait for it to appear on adb-tcp (§3.4).',
      })
      continue
    }
    desired.push({
      groupId: row.assignment.groupId || DEFAULT_GROUP_ID,
      groupName: DEFAULT_GROUP_NAME,
      endpointKey: row.lan.lanIp,
      deviceId: row.deviceId,
      pathId: row.assignment.pathId,
    })
  }
  return { desired, blocked }
}

/** Exported so `reconcile.ts` (step 122.9) reports a driver failure with the SAME `E_ROUTER_<kind>` codes this file's own routes already use, rather than a second classification. */
export function errorMessageOf(err: unknown): { code: string; message: string } {
  if (err instanceof MikrotikRestError) return { code: `E_ROUTER_${err.kind.toUpperCase()}`, message: err.message }
  return { code: 'E_ROUTER_UNKNOWN', message: messageOf(err) }
}

export interface PreparedApply {
  driver: RouterDriver
  plan: PlanRow[]
  localException: LocalExceptionReport
  blocked: BlockedAssignment[]
}

export type PrepareResult = { ok: true; prepared: PreparedApply } | { ok: false; code: string; message: string }

/** Fetches the router's current state fresh and builds the §4.4 diff over the currently-noted assignments — shared by `previewPlan` and `applyNow` so the two can never disagree. Never throws. */
async function prepareApply(host: ApplyHost, deps: ApplyDeps = {}): Promise<PrepareResult> {
  const createDriver = deps.createDriver ?? ((config: RouterConfig) => new MikrotikRestDriver(config))
  const resolveCoreAddress = deps.deriveCoreAddress ?? deriveCoreAddress

  const loaded = await loadRouterConfig((key) => host.storage.global.getRaw(key))
  if (!loaded.ok) return { ok: false, code: 'E_ROUTER_NOT_CONFIGURED', message: loaded.message }

  const driver = createDriver(loaded.config)

  try {
    const [fleet, rules, coreAddress] = await Promise.all([
      loadFleetState(host, driver, deps.assignmentOverrides),
      driver.listRules(),
      resolveCoreAddress({ baseUrl: loaded.config.baseUrl, tls: loaded.config.tls }),
    ])

    const { desired, blocked } = desiredEntriesFrom(fleet.devices)
    const localException = classifyLocalException(rules, protectedDevicesFrom(fleet.devices), coreAddress)
    const pathIds = new Set(fleet.paths.map((p) => p.id))
    const plan = buildPlan({ desired, rules, pathIds, health: fleet.health })

    return { ok: true, prepared: { driver, plan, localException, blocked } }
  } catch (err) {
    const { code, message } = errorMessageOf(err)
    return { ok: false, code, message }
  }
}

export interface FleetResultOk {
  ok: true
  fleet: FleetState
}
export type FleetResult = FleetResultOk | { ok: false; code: string; message: string }

/** The Assignments tab's initial load — every device, its resolved LAN address, and its noted assignment. Read-only; never touches the router beyond `inventory()`. */
export async function loadFleet(host: ApplyHost, deps: ApplyDeps = {}): Promise<FleetResult> {
  const createDriver = deps.createDriver ?? ((config: RouterConfig) => new MikrotikRestDriver(config))
  const loaded = await loadRouterConfig((key) => host.storage.global.getRaw(key))
  if (!loaded.ok) return { ok: false, code: 'E_ROUTER_NOT_CONFIGURED', message: loaded.message }

  try {
    const fleet = await loadFleetState(host, createDriver(loaded.config))
    return { ok: true, fleet }
  } catch (err) {
    const { code, message } = errorMessageOf(err)
    return { ok: false, code, message }
  }
}

export interface PlanPreviewOk {
  ok: true
  rows: PlanRow[]
  localException: LocalExceptionReport
  blocked: BlockedAssignment[]
}
export type PlanPreviewResult = PlanPreviewOk | { ok: false; code: string; message: string }

/** A dry-run of `applyNow` — the exact §4.4 diff, nothing written. Used both by the confirmation dialog's own preview and by anything that wants to know what an apply WOULD do without risking it. */
export async function previewPlan(host: ApplyHost, deps: ApplyDeps = {}): Promise<PlanPreviewResult> {
  const prepared = await prepareApply(host, deps)
  if (!prepared.ok) return prepared
  const { plan, localException, blocked } = prepared.prepared
  return { ok: true, rows: plan, localException, blocked }
}

export interface RowOutcome {
  row: PlanRow
  outcome: 'applied' | 'error'
  message?: string
}

/**
 * Executes every actionable row (`create`/`update`/`delete`) through the
 * driver's write methods — `skip`/`foreign` rows are never touched, by
 * construction (they are not even in the branch below). Each row is
 * attempted independently: the router has no transaction spanning multiple
 * `/routing/rule` writes, so a batch of forty is honestly forty independent
 * REST calls, and one failing must not abort the rest — the caller reads
 * `RowOutcome[]` to see exactly which landed.
 */
async function executePlan(driver: RouterDriver, plan: readonly PlanRow[]): Promise<RowOutcome[]> {
  const outcomes: RowOutcome[] = []

  for (const row of plan) {
    if (row.kind === 'skip' || row.kind === 'foreign') continue

    try {
      if (row.kind === 'create' || row.kind === 'update') {
        const marker = serialiseMarker(row.groupId, row.endpointKey)
        if (!marker.ok) {
          throw new Error(`cannot build a marker for group "${row.groupId}" / endpoint "${row.endpointKey}": ${marker.reason}`)
        }
        if (row.kind === 'create') {
          await driver.createRule({ srcAddress: row.endpointKey, table: row.pathId, comment: marker.comment })
        } else {
          // The comment is re-derived from the row's OWN groupId/endpointKey
          // rather than left as whatever the existing rule already said — a
          // device that moved from one group to another still resolves to
          // 'update' here (§4.3 matches on src-address alone), and the
          // rule's comment must reflect the group that owns it NOW.
          //
          // `disabled: false` is always sent, not only when the row's own
          // reason for existing was the disabled flag (planner.ts's header,
          // point 5, step 122.8) — a device that is desired again always
          // means "live," and a group's `onDeactivate: 'disable-rules'`
          // policy (`groups-service.ts`) is the only place in this plugin
          // that ever sets `disabled: true` on a managed rule. Without this,
          // a rule disabled by one deactivation could stay disabled forever
          // even after a later activation legitimately wants it live again.
          await driver.updateRule(row.rule['.id'], { table: row.toPathId, comment: marker.comment, disabled: false })
        }
      } else {
        await driver.deleteRule(row.rule['.id'])
      }
      outcomes.push({ row, outcome: 'applied' })
    } catch (err) {
      const { message } = errorMessageOf(err)
      outcomes.push({ row, outcome: 'error', message })
    }
  }

  return outcomes
}

export interface ApplyOk {
  ok: true
  rows: PlanRow[]
  outcomes: RowOutcome[]
  localException: LocalExceptionReport
  blocked: BlockedAssignment[]
}
export type ApplyResult = ApplyOk | { ok: false; code: string; message: string; localException?: LocalExceptionReport }

/**
 * The one function in this plugin that writes to the router.
 *
 * Refuses — never attempts — while `localException.status !== 'ok'`
 * (acceptance criterion 1). The refusal still carries the full report, so the
 * caller can render exactly why and what to fix, the same as a preview would.
 */
export async function applyNow(host: ApplyHost, deps: ApplyDeps = {}): Promise<ApplyResult> {
  const prepared = await prepareApply(host, deps)
  if (!prepared.ok) return prepared

  const { driver, plan, localException, blocked } = prepared.prepared

  if (localException.status !== 'ok') {
    host.log.warn('mikrotik-routing: apply refused — the local-exception check (§3.2) is not ok', { status: localException.status })
    return {
      ok: false,
      code: 'E_LOCAL_EXCEPTION_NOT_OK',
      message: `Apply refused (§3.2) — ${localException.message}`,
      localException,
    }
  }

  const outcomes = await executePlan(driver, plan)
  return { ok: true, rows: plan, outcomes, localException, blocked }
}
