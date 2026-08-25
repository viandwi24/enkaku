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
  type ObservedScreen,
  type Readiness,
  type ReadinessBlockedReason,
} from '@enkaku/protocol'
import type { Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import type { AwakePolicy } from './awake-policy'
import type { Lease, LeaseManager } from '../lease/lease-manager'
import { mapWithConcurrency } from '../util/concurrency'
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
  /**
   * Ask the PHONE what its screen is doing (plan 125 §3.6) and remember the
   * answer, so the next `get()` carries it as `observed`.
   *
   * This is the "on demand" half of §3.6's rule — the other half runs inside
   * `reconcile`. There is deliberately no third caller: a probe costs an adb
   * round trip, and §3.6 states it plainly — *"it runs on reconcile and on
   * demand — **never on a timer**"* (`readiness.ts`'s own no-timer rule at the
   * head of `createReadinessManager` stands unchanged).
   *
   * Always answers; never throws. A device that cannot be probed answers
   * `unknown` WITH a reason, and never `off` (acceptance criterion 5).
   */
  observe(deviceId: string): Promise<ObservedScreen>
  /**
   * Runs the boot sweep (plan 125 §4.4) — ONCE, not on a timer. See the
   * implementation for why that is not a contradiction of the no-timer rule.
   */
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
  /**
   * The awake policy (plan 125 §4.1, §5 step 125.2) — optional, and its
   * absence is not a silent degradation but a deliberate refusal.
   *
   * `ensureAwake` writes the device's own `screen_off_timeout` ONLY when this
   * is wired, because §0.2's first rule is that nothing is written to a boxed
   * phone without its original value being captured first, and this is what
   * owns the capture. With no policy wired, the wake behaves exactly as it did
   * before plan 125: the runtime nudge and `svc power stayon`, both of which
   * predate this plan and are reverted by `releaseAwake` below.
   */
  awakePolicy?: () => AwakePolicy | null
  broadcast: (deviceId: string, readiness: DeviceReadiness) => void
  /** One `device.readiness` main-stream event per change (§4.5, acceptance #12). */
  record?: (e: { deviceId: string; actor: string | null; from: Readiness; to: Readiness }) => void
  log: Logger
}

const RANK: Record<Readiness, number> = { asleep: 0, awake: 1, hot: 2 }

/**
 * How stale a screen observation may be before `reconcile` pays for a fresh
 * one (plan 125 §3.6: *"cached with a timestamp"*).
 *
 * `reconcile` is not a rare event — `daemon.ts` calls it on EVERY device
 * status transition, every session open and close, and every job claim and
 * finish. Probing unconditionally would put a `dumpsys power` round trip on
 * all of those, on a farm of twelve phones, which is exactly the kind of cost
 * plan 125 §0.7 is trying to remove from this codebase rather than add to it.
 * The cache collapses a burst of reconciles into one probe and leaves the
 * observation no more than this many seconds old.
 *
 * `observe()` (the on-demand path) ignores this and always probes fresh — an
 * operator who asks a question deserves the current answer, not a cached one.
 */
const OBSERVE_MAX_AGE_SEC = 15

/**
 * The upper bound on how many devices the boot sweep wakes at once (plan 125
 * §4.4's *"bounded by the existing build-lane discipline"*).
 *
 * Lower than the 8 `battery.ts`/`health.ts` use for their polls, on purpose: a
 * poll is one `dumpsys`, whereas a wake opens a transport and issues several
 * shell calls including `svc power stayon`, measured at 1422 ms on the owner's
 * hardware (plan 96 §22). The real fleet-wide bound is still the shared adb
 * lane (`adb.maxConcurrent`, taken into account below) — this is the second,
 * tighter ceiling that stops a twelve-phone farm arriving at boot from
 * becoming a twelve-way fan-out of the most expensive call in the product.
 */
const BOOT_SWEEP_MAX_CONCURRENCY = 4

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
    // Written explicitly rather than left to the schema (plan 125 §4.2): this
    // fallback exists precisely where no manager — and therefore no probe —
    // is wired, so "nothing was ever observed" is the literal truth here, and
    // the wire shape stays identical to the real manager's.
    observed: null,
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
  /**
   * deviceId → the last thing the PHONE said about its own screen (plan 125
   * §3.6). Absent means "never probed", which the wire reports as `null` —
   * distinct from a probe that ran and answered `unknown`.
   */
  const lastObserved = new Map<string, ObservedScreen>()
  /** Set by `stop()`, so a core shutting down mid-boot-sweep stops waking phones it is about to abandon. */
  let stopped = false
  /** The boot sweep is once-per-process by construction (plan 125 §4.4), not once-per-`start()`-call. */
  let sweepStarted = false

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

  /**
   * The fallback tracks `DeviceSettingsSchema`'s own default, which plan 125
   * §3.3 moved to `'always'`: `'while-charging'` maps to `svc power stayon
   * usb`, a documented no-op on a device attached over `adb-tcp`, so leaving
   * it here would make a device with an unparseable settings blob quietly
   * un-holdable on exactly the transport this farm runs on.
   */
  function keepAwakeModeFor(row: DeviceRow): KeepAwakeMode {
    const parsed = DeviceSettingsSchema.safeParse(row.settings ?? {})
    return parsed.success ? parsed.data.prep.keepAwake : 'always'
  }

  /** `prep.screenOffTimeoutMs` (plan 125 §4.2) — `null` means "leave the device's own value alone" and issues no write. */
  function screenOffTimeoutFor(row: DeviceRow): number | null {
    const parsed = DeviceSettingsSchema.safeParse(row.settings ?? {})
    return parsed.success ? parsed.data.prep.screenOffTimeoutMs : null
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

  /**
   * Record an observation we can make WITHOUT talking to the device (plan 125
   * §3.6).
   *
   * An offline or quarantined phone cannot be probed, and leaving the previous
   * answer in place would be worse than having none: a stale `on` from five
   * minutes ago, still presented to an operator as the current state of a
   * phone that has since dropped off the farm, is exactly the "inference
   * presented as fact" plan 125 §0.3 exists to stop. `unknown` with the reason
   * is the honest replacement — never `off`, because "we cannot ask" and "the
   * panel is dark" are different facts (acceptance criterion 5).
   */
  function markUnobservable(deviceId: string, reason: string): void {
    lastObserved.set(deviceId, { state: 'unknown', reason, observedAt: nowSec() })
  }

  /**
   * The probe itself (plan 125 §3.6). Returns null — and stores nothing — when
   * there is no probe to run at all, so a core built without an awake policy
   * reports `observed: null` ("never asked") rather than inventing an
   * `unknown` that would read as a failed probe.
   *
   * Never throws: a screen observation is a nice-to-have, and a failing probe
   * must never take down the `reconcile` that carries it, whose actual job is
   * keeping a boxed phone awake.
   */
  async function refreshObserved(deviceId: string, opts: { force?: boolean } = {}): Promise<ObservedScreen | null> {
    const policy = deps.awakePolicy?.() ?? null
    if (!policy) return null
    // A cloud/node-owned device is out of scope for the whole module (§2) — a
    // local transport against one would silently talk to nothing, and an
    // observation read off nothing is the worst possible answer here.
    if (deps.isRemote?.(deviceId)) return null
    const prev = lastObserved.get(deviceId)
    if (!opts.force && prev && nowSec() - prev.observedAt < OBSERVE_MAX_AGE_SEC) return prev
    try {
      const observed = await policy.observe(deviceId)
      lastObserved.set(deviceId, observed)
      return observed
    } catch (err) {
      const observed: ObservedScreen = { state: 'unknown', reason: `the screen probe failed: ${String(err)}`, observedAt: nowSec() }
      lastObserved.set(deviceId, observed)
      return observed
    }
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
    // `observed` rides alongside `actual`, never in place of it (plan 125
    // §4.2) — `actual` stays the scheduling-relevant bookkeeping value every
    // other module in this codebase already reasons about, and `observed` is
    // the phone's own answer, which is allowed to disagree with it.
    return DeviceReadinessSchema.parse({ desired, actual, blocked, since, observed: lastObserved.get(deviceId) ?? null })
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
      // Plan 125 §3.3, step 125.2 — the PERSISTED writes ride along with the
      // runtime nudge, which is what keeps a boxed phone awake even when the
      // core is not running at all. The timeout write and the capture sink
      // travel together on purpose: no policy wired means no capture sink,
      // and no capture sink means no persisted timeout write (§0.2 rule 1).
      const policy = deps.awakePolicy?.() ?? null
      await wakeDevice(transport, {
        keepAwake: keepAwakeModeFor(row),
        screenOffTimeoutMs: policy ? screenOffTimeoutFor(row) : null,
        ...(policy ? { capture: policy.captureSink(deviceId) } : {}),
        log,
      })
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
      // The device itself is gone — nothing left to revert on it.
      //
      // Plan 125 §4.4 is about what happens NEXT, and this line is why it
      // needed saying: dropping the flag means `rawActual` reads `asleep`
      // again, so a `desired: 'awake'` device that blipped offline is only
      // ever re-woken if something calls `reconcile` when it comes back. That
      // something is `daemon.ts`'s device-status hook — the registry applies
      // `DEVICE_CONNECTED` (offline→idle) on reprobe, the state machine's
      // `onChange` fires, and it reconciles here, landing in the `awake`
      // branch below and calling `ensureAwake`. Before the default flipped to
      // `'awake'` (125.2) a missed re-wake merely meant a dark tile; now it
      // means a phone in a sealed box that nobody can reach to wake by hand
      // (§0.2), so the reconnect test in `readiness.test.ts` pins the whole
      // chain rather than just this function.
      keepAwakeApplied.delete(deviceId)
      blockedReason.set(deviceId, desired !== 'asleep' ? 'offline' : null)
      markUnobservable(deviceId, 'the device is offline')
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
      markUnobservable(deviceId, 'the device is quarantined')
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
    // One of §3.6's two probe points ("on reconcile and on demand — never on a
    // timer"), placed AFTER the wake so what it observes is the state this
    // pass just produced rather than the one it replaced. Cached
    // (`OBSERVE_MAX_AGE_SEC`), because `reconcile` fires on every status
    // transition, session open/close and job claim/finish, and awaited rather
    // than fired-and-forgotten so the single `broadcast` below carries the
    // observation instead of racing a second one behind it. It cannot throw
    // (see `refreshObserved`), so it can never cost a device its wake.
    await refreshObserved(deviceId)
    broadcast(deviceId)
  }

  /**
   * The boot sweep (plan 125 §4.4, §3.1) — run once from `start()`.
   *
   * **Why this is not a breach of the no-timer rule** at the head of this
   * function: there is no timer. It runs exactly once, when the core comes up,
   * and nothing reschedules it. §4.4 grants it in those words — *"this is the
   * one new periodic-ish behaviour, and it runs once at boot, not on a
   * timer"* — because the alternative is the treadmill §0.4 documents: a
   * `desired: 'awake'` device that was awake before a core restart comes back
   * dark, and in a sealed box (§0.2) there is no hand to wake it.
   *
   * Three properties this deliberately has:
   *
   * - **Bounded.** `mapWithConcurrency` with a ceiling of
   *   `BOOT_SWEEP_MAX_CONCURRENCY`, further clamped by the live adb lane
   *   width, so a twelve-device farm does not fan out twelve simultaneous
   *   `svc power stayon` calls at the exact moment the core is busiest.
   * - **Loud.** One summary line naming what it woke, what it skipped, and
   *   why. An operator who cannot see their phones (§0.2) is entitled to read
   *   in the log what the core did to them at startup.
   * - **Not a retry loop.** An offline or quarantined device is skipped WITH a
   *   reason and never re-attempted here; it is picked up by its own
   *   `DEVICE_CONNECTED`/`UNQUARANTINE` transition, which reconciles anyway
   *   (see the offline branch above). A sweep that retried would be the timer
   *   this module does not have, wearing a different name.
   */
  async function bootSweep(): Promise<void> {
    const rows = db.select().from(devices).all()
    const targets: DeviceRow[] = []
    const skipped: string[] = []
    for (const row of rows) {
      if (desiredOf(row) === 'asleep') continue // not this sweep's business, and not worth a log line
      if (deps.isRemote?.(row.id)) {
        skipped.push(`${row.label ?? row.id} (owned by a cloud node)`)
        continue
      }
      const status = (row.status ?? 'offline') as DeviceStatus
      if (status === 'offline' || status === 'quarantined') {
        // Recorded as blocked so the very first `get()` after boot reports the
        // right reason, exactly as `computeReadiness` already does for a
        // device that has never been reconciled.
        blockedReason.set(row.id, status)
        markUnobservable(row.id, status === 'offline' ? 'the device is offline' : 'the device is quarantined')
        skipped.push(`${row.label ?? row.id} (${status})`)
        broadcast(row.id)
        continue
      }
      targets.push(row)
    }

    if (targets.length === 0) {
      if (skipped.length > 0) log.info(`boot sweep: nothing to wake — skipped ${skipped.length}: ${skipped.join(', ')}`)
      return
    }

    const client = deps.client()
    if (!client) {
      // `daemon.ts` calls `start()` after `adbState = 'ready'`, so this is a
      // misordering rather than an expected state — and it is reported, not
      // retried: a sweep that waited for adb would be a timer (§3.7).
      log.warn(`boot sweep skipped: the adb subsystem is not ready, so ${targets.length} device(s) were not woken`)
      return
    }
    const limit = Math.max(1, Math.min(BOOT_SWEEP_MAX_CONCURRENCY, client.stats().maxConcurrent, targets.length))
    log.info(`boot sweep: reconciling ${targets.length} device(s) desired awake or hot, ${limit} at a time`)
    const results = await mapWithConcurrency(targets, limit, async (row) => {
      if (stopped) return
      await reconcile(row.id)
    })
    const failed = results.filter((r) => r.status === 'rejected').length
    const awake = targets.filter((row) => keepAwakeApplied.has(row.id) || desiredHotRelease.has(row.id)).length
    log.info(
      `boot sweep done: ${awake}/${targets.length} device(s) now held awake${failed > 0 ? `, ${failed} failed` : ''}` +
        (skipped.length > 0 ? ` — skipped ${skipped.length}: ${skipped.join(', ')}` : ''),
    )
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

    async observe(deviceId) {
      // `force: true` — the on-demand half of §3.6. A cached answer is right
      // for `reconcile`'s bursts and wrong for someone who just asked.
      const observed = await refreshObserved(deviceId, { force: true })
      if (observed) {
        broadcast(deviceId)
        return observed
      }
      // No policy wired, or a cloud-owned device: nothing was stored (so
      // `observed` stays `null` on the wire, meaning "never asked"), but the
      // caller still gets an answer, and that answer is `unknown` with its
      // reason — never `off` (acceptance criterion 5).
      return {
        state: 'unknown',
        reason: deps.isRemote?.(deviceId)
          ? 'this device is owned by a cloud node, so its screen cannot be probed from here'
          : 'no awake policy is wired, so this core cannot probe a screen',
        observedAt: nowSec(),
      }
    },

    start() {
      // Still no timer (§3.7) — see `bootSweep` for why running it from here
      // is the one behaviour plan 125 §4.4 adds and why it is not a timer in
      // disguise. Fire-and-forget on purpose: waking a farm must never delay
      // the core coming up, exactly like `agentProvisioner.ensureAll()` and
      // `preparationRunner.ensureAll()` beside it in `daemon.ts`.
      if (sweepStarted) return
      sweepStarted = true
      stopped = false
      void bootSweep().catch((err) => log.warn(`readiness: boot sweep failed, tolerated: ${String(err)}`))
    },

    stop() {
      // There is no timer to clear; this flag is what a shutdown mid-sweep
      // needs, so the core does not keep waking phones it is walking away from.
      stopped = true
    },
  }
}
