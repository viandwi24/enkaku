import { NotifySendOutputSchema } from '@enkaku/protocol'
import { z } from 'zod'
import { CONFIG_KEY, DEFAULT_RECONCILE_INTERVAL_SEC, deviceNameWithNumber, readPluginConfig, type RouterConfig } from '../shared'
import {
  desiredEntriesFrom,
  errorMessageOf,
  loadFleetState,
  protectedDevicesFrom,
  type ApplyDeps,
} from './apply'
import { classifyDrift, type Drift, type DesiredAssignment } from './drift'
import { deriveCoreAddress } from './core-address'
import { messageOf } from './errors'
import { GROUP_KEY_PREFIX, groupIdFromKey, readGroup, type Group } from './groups'
import { classifyLocalException, type LocalExceptionReport } from './local-exception'
import { serialiseMarker } from './marker'
import { loadRouterConfig } from './router-config'
import { MikrotikRestDriver, type RouterDriver } from './router-driver'

/**
 * The reconcile loop — plan 122 §5 step 122.9, §4.7. Detects every drift
 * class §4.7's table names (`classifyDrift`, step 122.2, reused verbatim —
 * not reimplemented here), reports it, and repairs nothing unless
 * `config.autoRepair` is on — and even then, only `missing-rule`/`wrong-path`
 * (§4.7: "an auto-healer would have hidden" the owner's own Safe Mode
 * incident, three router wipes in one day — see `drift.ts`'s own header and
 * this plan's §4.7).
 *
 * ## The loop shape, and why (§0.2)
 *
 * `PluginServiceContext` has no timer of its own (§0.2 — confirmed by
 * reading the whole interface). `plugins/proxy-manager/src/service/
 * supervisor.ts`'s `scheduleProbe`/`destroyAll` is the precedent this file
 * follows exactly: a self-rescheduling `setTimeout`, deliberately never
 * `setInterval` (a `setInterval` would queue a second tick while the first is
 * still awaiting the router), cleared by a `torndown` flag + `clearTimeout`,
 * and the interval is injectable (`opts.intervalMsOverride`) so a test never
 * waits real seconds.
 *
 * ## How overlap is prevented
 *
 * Two mechanisms, not one:
 *
 * 1. **Structural** — `scheduleNext()` is only ever called from inside the
 *    PREVIOUS tick's own `.finally()`, so the timer for tick N+1 is not even
 *    armed until tick N has fully settled (mirrors `supervisor.ts`'s
 *    `scheduleProbe`).
 * 2. **Single-flight** — `tick()` itself tracks the in-flight promise in a
 *    closure variable (`inFlight`) and hands the SAME promise back to any
 *    caller that asks for a tick while one is already running. This is what
 *    also makes `reconcileNow()` (the explicit "Reconcile now" path) safe to
 *    call while the scheduled timer's own tick happens to be running: it
 *    awaits and returns the SAME result rather than starting a second pass
 *    that would race the first one's router calls.
 *
 * ## What "newly-detected" means for `notify.send`
 *
 * A farm with standing drift must not be paged every interval — §4.7's own
 * report-only stance is about not silently REPAIRING, not about being silent.
 * This loop keeps a `previousSignatures: Set<string>` of every drift item's
 * `driftSignature()` from the LAST tick that actually completed. On each
 * tick, only the drift items whose signature was NOT in that set are
 * "newly-detected" and go into one batched `notify.send` call (never one
 * notification per item — a farm with forty stale rules must not fire forty
 * pages). The signature set is then replaced wholesale with the current
 * tick's signatures — so a drift item that disappears (repaired, by hand or
 * by `autoRepair`) and later reappears is treated as newly-detected again,
 * which is the correct behaviour: an operator who fixed something and later
 * finds it broken again should be told, not silently skipped because it was
 * once seen before. A tick that FAILS outright (router unreachable, not
 * configured) never touches `previousSignatures` — a transient failure must
 * not erase the memory of standing drift and make it look "new" again on the
 * next successful tick.
 *
 * `driftSignature()` deliberately never uses a router rule's own `.id`: §3.3
 * established that a rule's `.id` is NOT stable across a router reboot or
 * config reload, so keying dedup on it would re-notify every standing drift
 * item after every reboot. Every signature is built from values this plugin
 * itself produced (`deviceId`, `pathId`, `endpointKey`, `groupId`) or, for an
 * orphan whose marker did not even parse, the rule's own comment text (which
 * DOES survive a reboot, unlike `.id`).
 */

// ---------------------------------------------------------------------------
// The host seam — a structural superset of `apply.ts`'s `ApplyHost` (a
// `ReconcileHost` is a valid `ApplyHost`, so it can be handed straight to
// `loadFleetState`), widened three ways: `log.info` alongside `log.warn`
// (a tick's own summary line is genuinely informational, not a warning),
// and `storage.global.list` — needed for `listActiveGroups` below, the SAME
// shape `groups-service.ts`'s own `GroupsHost.storage.global.list` uses.
// ---------------------------------------------------------------------------

export interface ReconcileHost {
  storage: {
    global: {
      getRaw(key: string): Promise<unknown>
      list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ items: { key: string; value: unknown }[]; nextCursor: string | null }>
    }
    forDevice(deviceId: string): { getRaw(key: string): Promise<unknown> }
  }
  farm: { call<T>(id: string, input: unknown, schema: z.ZodType<T>): Promise<T> }
  log: {
    warn(msg: string, fields?: Record<string, unknown>): void
    info(msg: string, fields?: Record<string, unknown>): void
  }
}

/**
 * Every ACTIVE group's own saved row (`group:<id>`, global KV — listable
 * regardless of any member device's current status), reusing
 * `groups.ts`'s `readGroup` rather than a second parser. Mirrors
 * `groups-service.ts`'s own `listAllGroups`, filtered to `active` and built
 * locally rather than imported: `listAllGroups` takes the FULL `GroupsHost`
 * (which also demands `global.set`/`delete` and `forDevice(...).set`/
 * `delete` — the group CRUD/activation writes this file never performs), and
 * widening `ReconcileHost` to satisfy that whole write-capable interface just
 * to call a read-only listing would hand a reconcile tick more authority than
 * it uses.
 */
async function listActiveGroups(host: ReconcileHost): Promise<Group[]> {
  const groups: Group[] = []
  let cursor: string | undefined
  do {
    const page = await host.storage.global.list({ prefix: GROUP_KEY_PREFIX, cursor })
    for (const item of page.items) {
      const id = groupIdFromKey(item.key)
      if (!id) continue
      const group = readGroup(id, item.value)
      if (group.active) groups.push(group)
    }
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return groups
}

/**
 * The "desired" state `classifyDrift` is fed — and the one place this file
 * departs from simply reusing `apply.ts`'s `desiredEntriesFrom` outright,
 * for a reason worth recording rather than discovering as a silent gap:
 *
 * `desiredEntriesFrom` reads each device's own `assignment` KV note through
 * `storage.forDevice(id)`, but it can only do that for a device `id` it
 * already knows about — and it only knows about devices `device.list` still
 * returns. §3.5's whole point is that a BLOCKED device's `assignment` note
 * survives (unlike Forget, which deletes it in the same transaction) while
 * the device itself disappears from `device.list` entirely (`lifecycle.ts`'s
 * `block()` deletes the `devices` row, same as forget). So a `desired` set
 * built ONLY from `desiredEntriesFrom(fleet.devices)` can never produce an
 * entry for a blocked device — and `classifyDrift`'s `stale-owner` case can
 * only ever fire for a device THAT IS in `desired` — meaning that path alone
 * would make `stale-owner` unreachable in practice, contradicting §3.5's own
 * reason for existing.
 *
 * The fix: for every device NOT currently in the fleet, fall back to what an
 * ACTIVE GROUP's own `entries` array (global KV, listable independently of
 * any device's live status — `listActiveGroups` above) last recorded for it.
 * A blocked device that was part of an active group's declared entries is
 * still named there — nothing in the Block flow touches `group:<id>` KV —
 * so this is what actually makes `stale-owner` reachable. For a device
 * STILL in the fleet, the live per-device read always wins (it reflects the
 * CURRENT assignment, which may have moved since the group was declared);
 * a group's own stale copy is only consulted as the fallback of last resort.
 *
 * **A real, named limitation, not silently smoothed over**: a STANDALONE
 * assignment (the implicit `default` group, §9 Q1) has no `group:default` KV
 * row at all (`shared.ts`'s own comment on `DEFAULT_GROUP_ID`) — so a device
 * that was only ever assigned individually, never through a named group, and
 * is then blocked, leaves no trace this function can find. Its stale router
 * rule is real and will sit there, but this build reports it as
 * `unexpected-managed-rule` (an orphan — still visible, still offered
 * adopt-or-remove, §4.2) rather than the more specific `stale-owner`. Closing
 * that gap needs a way to enumerate `assignment` KV across every device
 * regardless of fleet membership, which no capability in this workspace
 * currently provides (§0.2's own finding: `PluginKv`'s `list` is scoped
 * to ONE device or the global namespace, never "every device").
 */
async function buildDesiredState(host: ReconcileHost, fleetDesired: readonly DesiredAssignment[], activeDeviceIds: ReadonlySet<string>): Promise<DesiredAssignment[]> {
  const byDeviceId = new Map<string, DesiredAssignment>()
  for (const d of fleetDesired) byDeviceId.set(d.deviceId, d)

  const activeGroups = await listActiveGroups(host)
  for (const group of activeGroups) {
    for (const entry of group.entries) {
      if (activeDeviceIds.has(entry.deviceId)) continue // covered by the live read above, and it wins
      if (byDeviceId.has(entry.deviceId)) continue // an earlier active group already claimed this device id — first one wins, same as `classifyDrift`'s own "second desired entry for one endpoint" guard
      if (entry.lanIp === '') continue // no recorded endpoint to match a router rule against at all
      byDeviceId.set(entry.deviceId, { groupId: group.id, endpointKey: entry.lanIp, deviceId: entry.deviceId, pathId: entry.pathId })
    }
  }

  return [...byDeviceId.values()]
}

/** `missing-rule`/`wrong-path` only — the two kinds `autoRepair` may ever touch (§4.7). */
export type RepairableDrift = Extract<Drift, { kind: 'missing-rule' } | { kind: 'wrong-path' }>

export interface RepairOutcome {
  drift: RepairableDrift
  outcome: 'repaired' | 'error'
  message?: string
}

function isRepairable(d: Drift): d is RepairableDrift {
  return d.kind === 'missing-rule' || d.kind === 'wrong-path'
}

/**
 * One drift item's identity for dedup purposes — stable across a router
 * reboot (never a rule `.id`, see this file's own header). Exported so
 * `reconcile.test.ts` can pin the exact strings rather than re-deriving them.
 */
export function driftSignature(d: Drift): string {
  switch (d.kind) {
    case 'missing-rule':
      return `missing-rule:${d.desired.deviceId}:${d.desired.pathId}`
    case 'wrong-path':
      return `wrong-path:${d.desired.deviceId}:${d.actualTable ?? '?'}->${d.desired.pathId}`
    case 'path-missing':
      return `path-missing:${d.desired.deviceId}:${d.desired.pathId}`
    case 'stale-owner':
      return `stale-owner:${d.desired.deviceId}:${d.desired.endpointKey}`
    case 'duplicate':
      return `duplicate:${d.endpointKey}`
    case 'unexpected-managed-rule':
      return `unexpected-managed-rule:${d.endpointKey ?? d.rule.comment}`
  }
}

/** A one-line, operator-facing description of one drift item — used for both the log line and the notify body. */
export function describeDrift(d: Drift, labelOf: (deviceId: string) => string): string {
  switch (d.kind) {
    case 'missing-rule':
      return `${labelOf(d.desired.deviceId)} (${d.desired.endpointKey}) has no router rule for path "${d.desired.pathId}" (group ${d.desired.groupId})`
    case 'wrong-path':
      return `${labelOf(d.desired.deviceId)} (${d.desired.endpointKey}) is routed via "${d.actualTable ?? 'unknown'}", expected "${d.desired.pathId}"`
    case 'path-missing':
      return `${labelOf(d.desired.deviceId)} (${d.desired.endpointKey}) is assigned to path "${d.desired.pathId}", which no longer exists on the router`
    case 'stale-owner':
      return `${labelOf(d.desired.deviceId)} (${d.desired.endpointKey}) is blocked or no longer in the fleet, but its router rule is still live`
    case 'duplicate':
      return `${d.endpointKey} has ${d.rules.length} managed rules on the router — never auto-fixed, needs a human decision (§4.3)`
    case 'unexpected-managed-rule':
      return `An orphaned managed rule${d.endpointKey ? ` for ${d.endpointKey}` : ''} has no matching assignment — adopt or remove it manually (§4.2)`
  }
}

export interface ReconcileTickOk {
  ok: true
  drifts: Drift[]
  autoRepaired: RepairOutcome[]
  localException: LocalExceptionReport
  /** `deviceId → label`, for rendering `describeDrift` — every device this tick's fleet read saw, whether or not it has any drift. */
  deviceLabels: Record<string, string>
  checkedAt: number
}
export type ReconcileTickResult = ReconcileTickOk | { ok: false; code: string; message: string }

/**
 * One tick's worth of work — fetch the router's current rules and the
 * fleet's own desired state fresh (never cached, matching every other read
 * in this plugin), classify drift (`classifyDrift`, reused verbatim), and —
 * only if `config.autoRepair` is on AND §3.2's local-exception check is
 * `ok` — repair the `missing-rule`/`wrong-path` items. Never throws: every
 * failure resolves to `{ ok: false, code, message }`, the same discipline
 * `apply.ts`'s own functions follow.
 *
 * Stateless and reusable from both the scheduled loop and an explicit
 * "Reconcile now" call — the dedup/notify bookkeeping is the LOOP's job
 * (`createReconcileLoop` below), not this function's, so a caller that wants
 * a plain snapshot (a future read-only route, a test) gets one without
 * touching notification state.
 */
export async function computeReconcileTick(host: ReconcileHost, deps: ApplyDeps = {}): Promise<ReconcileTickResult> {
  const createDriver = deps.createDriver ?? ((config: RouterConfig) => new MikrotikRestDriver(config))
  const resolveCoreAddress = deps.deriveCoreAddress ?? deriveCoreAddress

  const loaded = await loadRouterConfig((key) => host.storage.global.getRaw(key))
  if (!loaded.ok) return { ok: false, code: 'E_ROUTER_NOT_CONFIGURED', message: loaded.message }

  const driver = createDriver(loaded.config)

  try {
    const config = readPluginConfig(await host.storage.global.getRaw(CONFIG_KEY))

    const [fleet, rules, coreAddress] = await Promise.all([
      loadFleetState(host, driver),
      driver.listRules(),
      resolveCoreAddress({ baseUrl: loaded.config.baseUrl, tls: loaded.config.tls }),
    ])

    const { desired: fleetDesired } = desiredEntriesFrom(fleet.devices)
    const localException = classifyLocalException(rules, protectedDevicesFrom(fleet.devices), coreAddress)
    const pathIds = new Set(fleet.paths.map((p) => p.id))
    const activeDeviceIds = new Set(fleet.devices.map((d) => d.deviceId))

    // §3.5: a blocked device is gone from `fleet.devices` (same as forgotten,
    // per `lifecycle.ts`) but can still be named in an ACTIVE group's own
    // entries — this file's own header on `buildDesiredState` has the full
    // reasoning for why that fallback is what makes `stale-owner` reachable.
    const desired = await buildDesiredState(host, fleetDesired, activeDeviceIds)

    const drifts = classifyDrift({ desired, rules, pathIds, activeDeviceIds })

    // Named WITH the device number (plan 124 §3.2's string half) — not in
    // that plan's Group G list, but the same defect and now a one-line fix,
    // because `FleetDeviceRow` carries `number` as of step 124.7. These
    // strings become `describeDrift` sentences and the drift NOTIFICATION an
    // operator reads away from the screen ("SM-F721U1 (192.168.10.15) is
    // routed via …"); on a farm of identically modelled phones the address
    // was the only thing telling three of those lines apart, and an address
    // is not what anyone has written on the back of the phone.
    const deviceLabels: Record<string, string> = {}
    for (const row of fleet.devices) deviceLabels[row.deviceId] = deviceNameWithNumber(row.number, row.label)

    // autoRepair (§4.7): opt-in, and even then covers ONLY missing-rule/
    // wrong-path — never duplicate/unexpected-managed-rule/stale-owner/
    // path-missing, all of which need a human decision (§4.2, §4.3). Gated
    // on the SAME §3.2 precondition every other write in this plugin refuses
    // without (acceptance criterion 1) — a reconcile tick is a write like
    // any other the moment `autoRepair` is on.
    const repairable = drifts.filter(isRepairable)
    const autoRepaired: RepairOutcome[] = []
    if (config.autoRepair && repairable.length > 0) {
      if (localException.status !== 'ok') {
        host.log.warn('mikrotik-routing: reconcile found auto-repairable drift but the local-exception check (§3.2) is not ok — repair skipped', {
          status: localException.status,
          count: repairable.length,
        })
      } else {
        for (const d of repairable) {
          autoRepaired.push(await repairOne(driver, d))
        }
      }
    }

    return { ok: true, drifts, autoRepaired, localException, deviceLabels, checkedAt: Math.floor(Date.now() / 1000) }
  } catch (err) {
    const { code, message } = errorMessageOf(err)
    return { ok: false, code, message }
  }
}

/** One `missing-rule`/`wrong-path` item → one write, resolved the same way `apply.ts`'s own `executePlan` writes a `create`/`update` row (§4.3: the marker is re-derived from the drift's OWN group/endpoint, never assumed). Never throws. */
async function repairOne(driver: RouterDriver, d: RepairableDrift): Promise<RepairOutcome> {
  const marker = serialiseMarker(d.desired.groupId, d.desired.endpointKey)
  if (!marker.ok) {
    return { drift: d, outcome: 'error', message: `cannot build a marker for group "${d.desired.groupId}" / endpoint "${d.desired.endpointKey}": ${marker.reason}` }
  }
  try {
    if (d.kind === 'missing-rule') {
      await driver.createRule({ srcAddress: d.desired.endpointKey, table: d.desired.pathId, comment: marker.comment })
    } else {
      await driver.updateRule(d.rule['.id'], { table: d.desired.pathId, comment: marker.comment, disabled: false })
    }
    return { drift: d, outcome: 'repaired' }
  } catch (err) {
    const { message } = errorMessageOf(err)
    return { drift: d, outcome: 'error', message }
  }
}

/** One batched notification for every newly-detected drift item this tick — never one call per item (this file's own header). */
async function notifyNewDrift(host: ReconcileHost, newDrifts: readonly Drift[], labelOf: (deviceId: string) => string): Promise<void> {
  const lines = newDrifts.map((d) => describeDrift(d, labelOf))
  const MAX_LINES = 20
  const body = lines.length > MAX_LINES ? `${lines.slice(0, MAX_LINES).join('\n')}\n… and ${lines.length - MAX_LINES} more` : lines.join('\n')
  const title = newDrifts.length === 1 ? 'MikroTik routing: 1 new drift item detected' : `MikroTik routing: ${newDrifts.length} new drift items detected`
  await host.farm.call('notify.send', { level: 'warn', title, body }, NotifySendOutputSchema)
}

export type ReconcileResult = (ReconcileTickOk & { newDrifts: Drift[] }) | { ok: false; code: string; message: string }

export interface ReconcileLoop {
  /** Arms the self-rescheduling timer. Calling twice is harmless — the second call's own `scheduleNext` races the first's timer, and `torndown` guards both from firing after `stop()`. */
  start(): void
  /** Clears the timer. Idempotent, and safe before `start()` was ever called — this is what `ctx.onStop` wires to. Does NOT abort a tick already in flight; it only stops the NEXT one from being scheduled. */
  stop(): void
  /** Runs one tick right now — the "Reconcile now" path (§5 step 122.9). Shares the same single-flight guard and notify-dedup state as the scheduled timer: a call made while a tick is already running returns that SAME tick's result rather than starting a second pass. */
  reconcileNow(): Promise<ReconcileResult>
}

/**
 * Build the reconcile loop. `deps.intervalMsOverride` bypasses the KV read
 * for `config.reconcileIntervalSec` entirely — the same test-only seam
 * `supervisor.ts`'s own `opts.probeIntervalMs` is (this file's own header) —
 * so a test never waits real seconds. Real callers (`src/index.ts`) never set
 * it; production always reads the operator's own saved interval, fresh, on
 * every scheduling decision (so a Settings change to the interval takes
 * effect on the very next tick, with nothing to invalidate).
 */
export function createReconcileLoop(host: ReconcileHost, deps: ApplyDeps & { intervalMsOverride?: number } = {}): ReconcileLoop {
  let torndown = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<ReconcileResult> | null = null
  let previousSignatures = new Set<string>()

  async function readIntervalMs(): Promise<number> {
    if (deps.intervalMsOverride !== undefined) return deps.intervalMsOverride
    try {
      const raw = await host.storage.global.getRaw(CONFIG_KEY)
      return readPluginConfig(raw).reconcileIntervalSec * 1000
    } catch {
      // A storage fault must not stop the loop from ever ticking again —
      // fall back to the plan's own stated default (§4.7: "default 60 s").
      return DEFAULT_RECONCILE_INTERVAL_SEC * 1000
    }
  }

  async function runOnce(): Promise<ReconcileResult> {
    const result = await computeReconcileTick(host, deps)
    if (!result.ok) {
      host.log.warn('mikrotik-routing: reconcile tick failed', { code: result.code, message: result.message })
      return result
    }

    const currentSignatures = new Set(result.drifts.map(driftSignature))
    const newDrifts = result.drifts.filter((d) => !previousSignatures.has(driftSignature(d)))
    // Replaced wholesale, win or lose — a tick that FAILED (the branch above)
    // never reaches here, so standing drift is never forgotten by a
    // transient router error (this file's own header).
    previousSignatures = currentSignatures

    if (newDrifts.length > 0) {
      const labelOf = (id: string): string => result.deviceLabels[id] ?? id
      try {
        await notifyNewDrift(host, newDrifts, labelOf)
      } catch (err) {
        host.log.warn('mikrotik-routing: reconcile could not send a drift notification', { message: messageOf(err) })
      }
    }

    host.log.info('mikrotik-routing: reconcile tick complete', {
      driftCount: result.drifts.length,
      newCount: newDrifts.length,
      autoRepaired: result.autoRepaired.length,
    })

    return { ...result, newDrifts }
  }

  /** Single-flight (this file's own header, point 2). */
  function tick(): Promise<ReconcileResult> {
    if (inFlight) return inFlight
    const settled = runOnce()
      .catch((err: unknown): ReconcileResult => {
        // `computeReconcileTick`/`runOnce` should never throw (both already
        // resolve every failure into a value) — this is a backstop against a
        // genuine bug, not the expected path, so it is logged distinctly.
        const message = messageOf(err)
        host.log.warn('mikrotik-routing: reconcile tick threw unexpectedly', { message })
        return { ok: false, code: 'E_RECONCILE_UNKNOWN', message }
      })
      .finally(() => {
        inFlight = null
      })
    inFlight = settled
    return settled
  }

  /** Structural half of overlap prevention (this file's own header, point 1) — only ever called from the PREVIOUS tick's own `.finally()`, so tick N+1's timer is not armed until tick N has fully settled. */
  function scheduleNext(): void {
    if (torndown) return
    void readIntervalMs().then((ms) => {
      if (torndown) return
      timer = setTimeout(() => {
        tick().finally(scheduleNext)
      }, ms)
    })
  }

  return {
    start() {
      scheduleNext()
    },
    stop() {
      torndown = true
      if (timer) clearTimeout(timer)
      timer = null
    },
    reconcileNow() {
      return tick()
    },
  }
}
