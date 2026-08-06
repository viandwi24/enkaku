import { eq } from 'drizzle-orm'
import type { AdbClient } from '@enkaku/adb'
import { AdbTcpTransport, AdbUsbTransport } from '@enkaku/drivers'
import { wakeDevice, type SessionManager } from '@enkaku/session'
import {
  DeviceReadinessSchema,
  DeviceSettingsSchema,
  type DeviceReadiness,
  type DeviceStatus,
  type KeepAwakeMode,
  type Readiness,
  type ReadinessBlockedReason,
} from '@enkaku/protocol'
import type { Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import type { Lease, LeaseManager } from '../lease/lease-manager'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'

/**
 * Why a caller needs the device at least `awake` (Plan 43 §3.7 table, §4.3).
 * Ref-counted per device — released when the specific thing that needed the
 * device goes away (the tab closes, the job finishes, the endpoint idles
 * out, ...). NEVER changes `desired` (§3.6) — see `hold()` below.
 */
export type HoldReason = 'viewer' | 'lease' | 'job' | 'monitor' | 'adb-endpoint' | 'transfer' | 'capability'

export interface Hold {
  readonly id: string
  /** Idempotent — calling it twice is a no-op the second time. */
  release(): void
}

export interface ReadinessManager {
  /** Current actual level, derived from live session state. Never persisted. */
  actual(deviceId: string): Readiness
  get(deviceId: string): DeviceReadiness
  /** Apply an operator or policy request. Rejects with a coded `EnkakuError` per §3.4. */
  set(deviceId: string, desired: Readiness, actor: { userId: string | null; clientId: string | null }): Promise<DeviceReadiness>
  /** Re-derive and broadcast; called on session, status, and device changes (§5 step 43.6). */
  reconcile(deviceId: string): Promise<void>
  /**
   * Ensure the device is at least `awake` and keep it there while the caller
   * needs it (§3.6). Wakes if asleep, no-ops if already awake or hot.
   * NEVER changes `desired` — releasing the last hold lets the device settle
   * back toward it (immediately if there is no live session; on Plan 42's
   * OWN `session.idleTtlSec` grace period if the hold's caller went on to
   * open a real session, e.g. `stream.start`'s own `sessions.acquire`).
   */
  hold(deviceId: string, reason: HoldReason): Promise<Hold>
  start(): void
  stop(): void
}

export interface ReadinessManagerDeps {
  db: Db
  /** null before the adb subsystem is ready (daemon.ts's boot ordering) — reconcile/hold become safe no-ops until then. */
  client: () => AdbClient | null
  /** Plan 42's session manager — the ONLY place a grace-period timer lives (§3.7, acceptance #17). This module starts none of its own. */
  sessions: () => SessionManager | null
  leases: LeaseManager
  /** `readiness.maxHot`, read fresh (the same freshness pattern every other farm setting in this codebase uses). */
  maxHot: () => number
  /**
   * Cloud/node-owned devices are out of scope for this plan (§2, §9 open
   * question #2) — a local `Transport`/`SessionManager` acquire against one
   * would silently talk to nothing. `ensureAwake`/`reconcile` no-op for any
   * device this reports true for; `hold()` still resolves normally (a
   * no-op release), so callers do not need to branch on locality themselves.
   */
  isRemote?: (deviceId: string) => boolean
  broadcast: (deviceId: string, readiness: DeviceReadiness) => void
  /** One `device.readiness` main-stream event per change (§4.5, acceptance #12). */
  record?: (e: { deviceId: string; actor: string | null; from: Readiness; to: Readiness }) => void
  log: Logger
}

const RANK: Record<Readiness, number> = { asleep: 0, awake: 1, hot: 2 }

/**
 * A pure, manager-free fallback (Plan 43 §4.1): `offline` always reads
 * `asleep`; otherwise `actual` mirrors `desired` as a best guess — used only
 * where no live `ReadinessManager` is wired (orchestrator mode's
 * node-owned devices, or a test that constructs `DeviceInfo` directly).
 * Every production local-device call site passes the manager's real `get()`
 * instead.
 */
export function staticReadinessFallback(row: Pick<DeviceRow, 'status' | 'desiredReadiness'>): DeviceReadiness {
  const desired = (row.desiredReadiness as Readiness | null) ?? 'asleep'
  const offline = (row.status ?? 'offline') === 'offline'
  return DeviceReadinessSchema.parse({
    desired,
    actual: offline ? 'asleep' : desired,
    blocked: offline && desired !== 'asleep' ? 'offline' : null,
    since: 0,
  })
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Wiring for readiness (Plan 43): a second, orthogonal axis to `DeviceStatus`
 * (§3.1) — `desired` is persisted on the device row, `actual` is re-derived
 * on every read from live session state and NEVER persisted (§3.3). A hold
 * NEVER changes `desired` (§3.6): jobs, viewers, monitors, adb endpoints, and
 * transfers all call `hold()`, and none of them ever write the
 * `desiredReadiness` column — only `set()` does that, and `set()` is reached
 * only from an explicit operator or policy request (the WS `device.readiness.set`
 * message and the `PUT /api/devices/:id/readiness` route, both of which
 * enforce §3.4 through this exact function).
 *
 * There is exactly ONE inactivity clock (§3.7, acceptance #17): Plan 42's
 * `session.idleTtlSec`, inside `@enkaku/session`'s `SessionManager`. This
 * module starts no `setTimeout`/`setInterval` of its own anywhere below —
 * search it and there is none. A `desired: hot` device is kept hot by
 * holding a STANDING subscriber on `SessionManager` (`desiredHotRelease`
 * below) — the exact same "a session with a subscriber never idles out"
 * mechanism Plan 42 already built, not a second copy of it. A transient hold
 * (viewer/job/monitor/adb-endpoint/transfer) only guarantees `awake` (a
 * direct, one-off `wakeDevice` call, no session, no timer); if the caller
 * goes on to open a REAL session (`stream.start` → `sessions.acquire`), that
 * session's own subscriber is what keeps it warm through Plan 42's grace
 * period — this module never duplicates that bookkeeping.
 */
export function createReadinessManager(deps: ReadinessManagerDeps): ReadinessManager {
  const { db, log } = deps

  /** Devices this manager has directly run `wakeDevice` for for (no session backing it). */
  const keepAwakeApplied = new Set<string>()
  /** deviceId → release() for the standing `SessionManager` subscriber keeping a `desired: hot` device warm. */
  const desiredHotRelease = new Map<string, () => void>()
  /** deviceId → why `actual` cannot reach `desired` right now, or null. */
  const blockedReason = new Map<string, ReadinessBlockedReason | null>()
  /** deviceId → the last observed `actual` level and when it was first seen — drives `since`. */
  const lastActual = new Map<string, { level: Readiness; since: number }>()
  /** deviceId → number of open holds (viewer/job/monitor/adb-endpoint/transfer/lease). */
  const holdCounts = new Map<string, number>()

  function getRow(deviceId: string): DeviceRow | null {
    return db.select().from(devices).where(eq(devices.id, deviceId)).get() ?? null
  }

  function desiredOf(row: DeviceRow | null): Readiness {
    return row ? ((row.desiredReadiness as Readiness | null) ?? 'asleep') : 'asleep'
  }

  function transportFor(row: DeviceRow): AdbUsbTransport | null {
    const client = deps.client()
    if (!client) return null
    const opts = { client, serial: row.serial, stableId: row.stableId }
    return row.transport === 'adb-tcp' ? new AdbTcpTransport(opts) : new AdbUsbTransport(opts)
  }

  function keepAwakeModeFor(row: DeviceRow): KeepAwakeMode {
    const parsed = DeviceSettingsSchema.safeParse(row.settings ?? {})
    return parsed.success ? parsed.data.prep.keepAwake : 'while-charging'
  }

  /** `actual`, ignoring `blocked` — the raw, live-derived level (§4.3's derivation order). */
  function rawActual(deviceId: string, row: DeviceRow | null): Readiness {
    if (!row) return 'asleep'
    if (((row.status ?? 'offline') as DeviceStatus) === 'offline') return 'asleep'
    if (deps.sessions()?.get(deviceId)) return 'hot'
    if (keepAwakeApplied.has(deviceId)) return 'awake'
    return 'asleep'
  }

  function touchActual(deviceId: string, level: Readiness): number {
    const prev = lastActual.get(deviceId)
    if (!prev || prev.level !== level) {
      const since = nowSec()
      lastActual.set(deviceId, { level, since })
      return since
    }
    return prev.since
  }

  function computeReadiness(deviceId: string): DeviceReadiness {
    const row = getRow(deviceId)
    const desired = desiredOf(row)
    const status: DeviceStatus = row ? ((row.status ?? 'offline') as DeviceStatus) : 'offline'
    const actual = rawActual(deviceId, row)
    const since = touchActual(deviceId, actual)
    // `blocked` only means something while actual has not (yet) caught up to
    // desired — once it has, any stale reason is cleared, never shown once
    // it is no longer true. `offline`/`quarantined` are derived live, right
    // here, so a restart reports the correct reason on the very first read —
    // BEFORE any `reconcile()` has ever run for this device (acceptance #4,
    // #9). `hot_budget_full`/`error` can only be known from an actual
    // reconciliation attempt, so those two fall back to the stored map.
    let blocked: ReadinessBlockedReason | null = null
    if (RANK[actual] < RANK[desired]) {
      if (status === 'offline') blocked = 'offline'
      else if (status === 'quarantined') blocked = 'quarantined'
      else blocked = blockedReason.get(deviceId) ?? null
    }
    return DeviceReadinessSchema.parse({ desired, actual, blocked, since })
  }

  function broadcast(deviceId: string): void {
    deps.broadcast(deviceId, computeReadiness(deviceId))
  }

  /** Run the shared wake sequence directly against the device — no session, no timer (§4.3 "→ awake"). */
  async function ensureAwake(deviceId: string): Promise<void> {
    if (deps.isRemote?.(deviceId)) return
    const row = getRow(deviceId)
    if (!row) return
    const status = (row.status ?? 'offline') as DeviceStatus
    if (status === 'offline' || status === 'quarantined') return
    if (rawActual(deviceId, row) !== 'asleep') return
    const transport = transportFor(row)
    if (!transport) return
    await transport.connect()
    try {
      await wakeDevice(transport, { keepAwake: keepAwakeModeFor(row), log })
    } catch (err) {
      log.warn(`readiness: wakeDevice failed for ${deviceId}: ${String(err)}`)
    } finally {
      await transport.disconnect()
    }
    keepAwakeApplied.add(deviceId)
    broadcast(deviceId)
  }

  /** Reverse of `ensureAwake` (§4.3 "→ asleep") — only when no live session is keeping the device warm regardless. */
  async function releaseAwake(deviceId: string): Promise<void> {
    if (!keepAwakeApplied.has(deviceId)) return
    keepAwakeApplied.delete(deviceId)
    const row = getRow(deviceId)
    if (!row) return
    const transport = transportFor(row)
    if (!transport) return
    await transport.connect()
    await transport.exec('svc power stayon false', { profile: 'probe' }).catch(() => undefined)
    await transport.disconnect()
  }

  function releaseDesiredHot(deviceId: string): void {
    const release = desiredHotRelease.get(deviceId)
    if (!release) return
    desiredHotRelease.delete(deviceId)
    release()
  }

  async function reconcile(deviceId: string): Promise<void> {
    if (deps.isRemote?.(deviceId)) return
    const row = getRow(deviceId)
    if (!row) return
    const desired = desiredOf(row)
    const status = (row.status ?? 'offline') as DeviceStatus

    if (status === 'offline') {
      releaseDesiredHot(deviceId)
      keepAwakeApplied.delete(deviceId) // the device itself is gone — nothing left to revert on it
      blockedReason.set(deviceId, desired !== 'asleep' ? 'offline' : null)
      broadcast(deviceId)
      return
    }
    if (status === 'quarantined') {
      // A device quarantined while hot drops to asleep and keeps `desired`
      // (Plan 43 §8 risks table) — releasing our own standing subscriber
      // lets Plan 42's `closeIfIdle` (already called from the state machine
      // hook, daemon.ts) tear the session down; we do not force it here.
      releaseDesiredHot(deviceId)
      blockedReason.set(deviceId, desired !== 'asleep' ? 'quarantined' : null)
      broadcast(deviceId)
      return
    }

    if (desired === 'hot') {
      if (!desiredHotRelease.has(deviceId)) {
        const sessions = deps.sessions()
        if (sessions && desiredHotRelease.size < deps.maxHot()) {
          const sink = (): void => {}
          try {
            await sessions.acquire(deviceId, sink, 'wall')
            desiredHotRelease.set(deviceId, () => sessions.release(deviceId, sink))
            blockedReason.set(deviceId, null)
          } catch (err) {
            log.warn(`readiness: failed to acquire a hot session for ${deviceId}: ${String(err)}`)
            blockedReason.set(deviceId, 'error')
            await ensureAwake(deviceId)
          }
        } else {
          // The hot budget is full (§3.5): `desired` stays hot, `actual`
          // reports `awake`, and nothing already hot is evicted.
          blockedReason.set(deviceId, 'hot_budget_full')
          await ensureAwake(deviceId)
        }
      } else {
        blockedReason.set(deviceId, null)
      }
    } else if (desired === 'awake') {
      releaseDesiredHot(deviceId)
      blockedReason.set(deviceId, null)
      await ensureAwake(deviceId)
    } else {
      // asleep
      releaseDesiredHot(deviceId)
      blockedReason.set(deviceId, null)
      // A live session may still be up (someone's hold, or Plan 42's own
      // idle grace period) — leave it alone; `session.closed` re-triggers
      // `reconcile` and this branch finishes the job then.
      if (!deps.sessions()?.get(deviceId)) await releaseAwake(deviceId)
    }
    broadcast(deviceId)
  }

  return {
    actual(deviceId) {
      return computeReadiness(deviceId).actual
    },

    get(deviceId) {
      return computeReadiness(deviceId)
    },

    async set(deviceId, desired, actor) {
      const row = getRow(deviceId)
      if (!row) throw new EnkakuError('device_not_found', `no such device: ${deviceId}`)
      const status = (row.status ?? 'offline') as DeviceStatus
      const currentDesired = desiredOf(row)
      if (desired === currentDesired) return computeReadiness(deviceId)

      const waking = RANK[desired] > RANK[currentDesired]
      if (waking) {
        // §3.4: Wake is allowed for idle/manual/busy, refused for offline/quarantined.
        if (status === 'offline') throw new EnkakuError('device_offline', 'the device is offline')
        if (status === 'quarantined') throw new EnkakuError('device_quarantined', 'the device is quarantined')
      } else {
        // §3.4, corrected by Plan 49 §3.1/§4.1: Sleep is refused only for
        // ACTIVE use — a running job, or another operator's manual lease.
        // Watching NEVER blocks it: the Wall tile is itself a viewer, so a
        // viewer check made Sleep impossible from the one screen it belongs
        // on — refusing the person pressing the button by telling them
        // someone is watching, when that someone was them. Holding the
        // lease YOURSELF does not block your own sleep — you are the one
        // using it, and you are the one asking.
        if (status === 'busy') throw new EnkakuError('job_running', 'a job is running')
        const lease: Lease | null = deps.leases.getLease(deviceId)
        const actorHoldsLease =
          lease?.type === 'manual' &&
          (lease.holder === actor.clientId || (actor.userId !== null && lease.holderUserId === actor.userId))
        if (lease?.type === 'manual' && !actorHoldsLease) {
          throw new EnkakuError('device_in_use', 'another operator holds the lease on this device')
        }
      }

      db.update(devices).set({ desiredReadiness: desired }).where(eq(devices.id, deviceId)).run()
      deps.record?.({ deviceId, actor: actor.userId, from: currentDesired, to: desired })
      await reconcile(deviceId)
      return computeReadiness(deviceId)
    },

    reconcile,

    async hold(deviceId, _reason) {
      const count = (holdCounts.get(deviceId) ?? 0) + 1
      holdCounts.set(deviceId, count)
      if (count === 1) await ensureAwake(deviceId)
      let released = false
      const id = crypto.randomUUID()
      return {
        id,
        release() {
          if (released) return
          released = true
          const left = Math.max(0, (holdCounts.get(deviceId) ?? 1) - 1)
          if (left === 0) holdCounts.delete(deviceId)
          else holdCounts.set(deviceId, left)
          // No timer here (§3.7, acceptance #17): a pure-awake hold (no
          // session behind it) reconciles back toward `desired` immediately.
          // A hold whose caller went on to open a real session is not torn
          // down by this at all — `deps.sessions().get(deviceId)` is still
          // non-null and `reconcile`'s asleep branch leaves it alone,
          // deferring entirely to Plan 42's own `session.idleTtlSec`.
          if (left === 0) void reconcile(deviceId)
        },
      }
    },

    start() {
      // No timer to start (§3.7) — present so the interface mirrors every
      // other manager in this codebase (`SessionManager`, `DeviceHealth`, ...)
      // and so a future policy-driven reconciliation loop has somewhere to
      // live without changing this interface again.
    },

    stop() {
      // Nothing to stop, for the same reason.
    },
  }
}
