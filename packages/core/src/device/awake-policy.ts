import { eq } from 'drizzle-orm'
import type { AdbClient } from '@enkaku/adb'
import { AdbTcpTransport, AdbUsbTransport } from '@enkaku/drivers'
import {
  CapturedPowerStateSchema,
  type AwakeApplyResult,
  type CapturedPowerState,
  type DeviceStatus,
  type KeepAwakeMode,
  type ObservedScreen,
  type Transport,
} from '@enkaku/protocol'
import {
  applyScreenOffTimeout,
  applyStayOn,
  firstPowerReason,
  observeScreen,
  readPowerState,
  restoreStayOn,
  type PowerReadback,
} from '@enkaku/session'
import type { Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'
import { DEVICE_SCREEN_OFF_TIMEOUT_MS } from '../config/constants'

/**
 * The awake policy, host side (plan 125 §4.1, §5 step 125.1 — this plan's
 * `Ships:` artefact).
 *
 * Device-scoped, persistent state, NOT a session step — the same shape
 * `labelling.ts` next door already has, and for the same reason: what this
 * writes to a phone must outlive the process that wrote it. The transport
 * commands and the read-back discipline live in `packages/session/src/power.ts`
 * (this file's `screen-label.ts`); this file owns the ONE thing that module
 * cannot: remembering, durably and per device, what the phone had before we
 * touched it.
 *
 * ### The constraint that shapes every method here (plan 125 §0.2)
 *
 * The owner's farm lives in a sealed phone-farm box — the phones are
 * physically enclosed, with no screen and no hands on them. In their own
 * words: *"if something happens to a device — say it disconnects — I can't get
 * to it any more, I have to take the box apart and attach an LCD."*
 *
 * **So the recovery cost of a bad device write is not "annoying", it is
 * hardware disassembly.** Every write this module makes is therefore:
 *
 * 1. **Read back and verified** before it may be reported as applied. A value
 *    that does not read back is `refused` with a reason, never `applied`
 *    (acceptance criterion 4). `packages/session/src/power.ts` enforces this
 *    by construction — there is no code path there that returns `applied`
 *    without having observed the value.
 * 2. **Reversible over adb alone.** `restore()` puts back the device's own
 *    literal captured strings, and `awake-policy.test.ts` exercises the revert
 *    rather than asserting it in prose (acceptance criterion 3).
 * 3. **Never dependent on physical access to recover.** Nothing here reboots a
 *    device, and nothing here touches Wi-Fi, network configuration, or
 *    lock-screen credentials — plan 125 §3.4 refuses that whole category
 *    outright, because a wrong write there strands a boxed phone permanently
 *    and no convenience win justifies that risk profile.
 *
 * ### Why `observe()` exists at all (plan 125 §0.3, §3.6)
 *
 * `readiness.actual` is bookkeeping, not an observation. Its `rawActual`
 * (`readiness.ts`) returns `asleep` when this core has no session open and has
 * not itself called `wakeDevice` — a phone whose screen is genuinely lit reads
 * `asleep`, and a phone whose `stayon usb` silently did nothing reads `awake`.
 * A grep across the workspace for `dumpsys power`/`mWakefulness` returned zero
 * hits before this plan. `observe()` is the first thing in this codebase that
 * actually asks the phone — and it answers `unknown`, never `off`, when it
 * could not (acceptance criterion 5).
 */

export interface AwakePolicyDeps {
  db: Db
  /** Live adb client accessor — the same forward-ref-safe shape `readiness.ts`'s `transportFor` and `labelling.ts`'s `client` use; null before the adb subsystem is up. */
  client: () => AdbClient | null
  log: Logger
  /** Test seam — replaces `Date.now()`. */
  now?: () => number
  /** Test seam — replaces the real `AdbUsbTransport`/`AdbTcpTransport` construction. Defaults to the real thing. */
  buildTransport?: (row: DeviceRow) => Transport | null
}

export interface AwakePolicy {
  /** Read and remember the device's own settings. Idempotent; NEVER overwrites an existing capture. */
  capture(deviceId: string): Promise<CapturedPowerState>
  /** Apply the persisted keep-awake writes, each verified by read-back (§3.3). Returns what actually took. */
  apply(deviceId: string, mode: KeepAwakeMode): Promise<AwakeApplyResult>
  /** Put back exactly what `capture` saw. Idempotent. */
  restore(deviceId: string): Promise<AwakeApplyResult>
  /** Observed screen state (§3.6), or `unknown` when the probe could not run. */
  observe(deviceId: string): Promise<ObservedScreen>
  /**
   * The `capture` sink for `wakeDevice` — plan 125 §4.1 does not list this,
   * and it is here for one concrete reason.
   *
   * §3.3 requires the original to be stored BEFORE the first write, and step
   * 125.2 puts the persisted writes inside `wakeDevice`. `wakeDevice` lives in
   * `@enkaku/session` and cannot reach the database, so it takes a sink and
   * hands it the power state it read anyway. This returns that sink, bound to
   * one device, so wiring capture-before-write into the wake path costs **zero
   * extra adb round trips** — the alternative, calling `capture()` first,
   * would open a second transport and re-read the same two values on the one
   * path plan 125 §0.7 is trying to make faster.
   *
   * Synchronous and never throws: `wakeDevice` tolerates a failing sink, but a
   * sink that fails is a capture that did not happen, and this one only writes
   * a row.
   */
  captureSink(deviceId: string): (state: PowerReadback) => void
}

function nowSeconds(now: () => number): number {
  return Math.floor(now() / 1000)
}

export function createAwakePolicy(deps: AwakePolicyDeps): AwakePolicy {
  const { db, log } = deps
  const now = deps.now ?? (() => Date.now())

  const mustGet = (id: string): DeviceRow => {
    const row = db.select().from(devices).where(eq(devices.id, id)).get()
    if (!row) throw new EnkakuError('device_not_found', `no such device: ${id}`)
    return row
  }

  /**
   * Zod-validated (CLAUDE.md: never trust a JSON DB column raw) — a corrupt or
   * pre-migration row reads as "never captured" rather than throwing. Reading
   * it as never-captured is the safe direction: the next wake takes a real
   * capture, whereas throwing here would take the wake down with it and leave
   * a boxed phone dark.
   */
  function readCapture(row: DeviceRow): CapturedPowerState | null {
    if (row.powerCapture === null || row.powerCapture === undefined) return null
    const parsed = CapturedPowerStateSchema.safeParse(row.powerCapture)
    if (!parsed.success) {
      log.warn(`device ${row.id}: stored power capture failed validation, treating as never-captured: ${parsed.error.message}`)
      return null
    }
    return parsed.data
  }

  /**
   * The one write to `devices.power_capture`, and the one place the
   * never-overwrite rule lives (§3.3).
   *
   * Two guards, both load-bearing:
   *
   * - **An existing capture wins, always.** A second capture would record our
   *   OWN writes as the phone's original settings and destroy the only copy of
   *   the truth. On a boxed phone that is unrecoverable without disassembly.
   * - **A capture where BOTH values are null is not stored.** "Could not read
   *   either key" is a real outcome (an offline device, a mid-boot device, a
   *   ROM that hides them), but persisting it would satisfy the
   *   never-overwrite rule forever and permanently prevent a real capture from
   *   ever being taken. A partial capture IS stored — half the truth is worth
   *   keeping, and `restore` reports the missing half as `unchanged` with a
   *   reason rather than guessing at it.
   */
  function storeCapture(deviceId: string, state: PowerReadback): CapturedPowerState | null {
    const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()
    if (!row) return null
    const existing = readCapture(row)
    if (existing) return existing
    if (state.screenOffTimeoutMs === null && state.stayOnWhilePluggedIn === null) {
      log.debug(`device ${deviceId}: neither power setting could be read, so nothing was captured (a real capture stays possible)`)
      return null
    }
    const captured = CapturedPowerStateSchema.parse({
      screenOffTimeoutMs: state.screenOffTimeoutMs,
      stayOnWhilePluggedIn: state.stayOnWhilePluggedIn,
      capturedAt: nowSeconds(now),
    })
    db.update(devices).set({ powerCapture: captured }).where(eq(devices.id, deviceId)).run()
    return captured
  }

  const buildTransport: (row: DeviceRow) => Transport | null =
    deps.buildTransport ??
    ((row: DeviceRow) => {
      const client = deps.client()
      if (!client) return null
      const opts = { client, serial: row.serial, stableId: row.stableId }
      return row.transport === 'adb-tcp' ? new AdbTcpTransport(opts) : new AdbUsbTransport(opts)
    })

  /** `prep.screenOffTimeoutMs` is a constant now (plan 212 §4.1 D18, `DEVICE_SCREEN_OFF_TIMEOUT_MS`) — no per-device row to read. */
  function screenOffTimeoutFor(_row: DeviceRow): number | null {
    return DEVICE_SCREEN_OFF_TIMEOUT_MS
  }

  /**
   * Every device-touching method runs through here: one transport, connected
   * once, disconnected in a `finally`. Mirrors `labelling.ts`'s tier-0 passes
   * exactly.
   */
  async function withTransport<T>(row: DeviceRow, fn: (transport: Transport) => Promise<T>, fallback: T): Promise<T> {
    const transport = buildTransport(row)
    if (!transport) return fallback
    await transport.connect()
    try {
      return await fn(transport)
    } finally {
      await transport.disconnect()
    }
  }

  function unreachable(row: DeviceRow): string | null {
    const status = (row.status ?? 'offline') as DeviceStatus
    if (status === 'offline') return 'the device is offline'
    if (status === 'quarantined') return 'the device is quarantined'
    return null
  }

  async function captureImpl(deviceId: string): Promise<CapturedPowerState> {
    const row = mustGet(deviceId)
    const existing = readCapture(row)
    // The never-overwrite rule, checked before any device I/O: a device whose
    // original is already recorded costs zero round trips on every subsequent
    // call. `capture()` is documented idempotent, and this is what makes it
    // cheap as well as correct.
    if (existing) return existing

    const empty: CapturedPowerState = { screenOffTimeoutMs: null, stayOnWhilePluggedIn: null, capturedAt: nowSeconds(now) }
    const blocked = unreachable(row)
    if (blocked) {
      log.debug(`device ${deviceId}: power capture skipped — ${blocked}`)
      return empty
    }
    const state = await withTransport(row, (transport) => readPowerState(transport), { screenOffTimeoutMs: null, stayOnWhilePluggedIn: null })
    return storeCapture(deviceId, state) ?? { ...empty, ...state }
  }

  async function applyImpl(deviceId: string, mode: KeepAwakeMode): Promise<AwakeApplyResult> {
    const row = mustGet(deviceId)
    const blocked = unreachable(row)
    if (blocked) return { screenOffTimeout: 'refused', stayOn: 'refused', reason: blocked }

    return withTransport(
      row,
      async (transport) => {
        // Read once, use three times: capture, the timeout's "is it already
        // right" check, and the stayon one. The stayon early-out is what
        // skips plan 96 §22's measured 1422 ms `svc power stayon` on a device
        // that already holds it.
        const current = await readPowerState(transport)
        // Capture-before-write, unconditionally and first (§3.3). A device
        // whose original is already stored is a cheap no-op here.
        storeCapture(deviceId, current)
        const timeout = await applyScreenOffTimeout(transport, screenOffTimeoutFor(row), current.screenOffTimeoutMs, log)
        const stayOn = await applyStayOn(transport, mode, current.stayOnWhilePluggedIn, log)
        return { screenOffTimeout: timeout.outcome, stayOn: stayOn.outcome, reason: firstPowerReason(timeout, stayOn) }
      },
      { screenOffTimeout: 'refused', stayOn: 'refused', reason: 'adb is not ready yet' },
    )
  }

  async function restoreImpl(deviceId: string): Promise<AwakeApplyResult> {
    const row = mustGet(deviceId)
    const captured = readCapture(row)
    if (!captured) {
      // Nothing was ever recorded, so there is nothing exact to put back —
      // and this module does not guess (the failure mode plan 89 §3.6
      // records for the wallpaper tier). Reported as `unchanged`, not
      // `refused`: nothing was refused, there was simply nothing to do.
      return { screenOffTimeout: 'unchanged', stayOn: 'unchanged', reason: 'this device’s original power settings were never captured, so there is nothing to put back' }
    }
    const blocked = unreachable(row)
    if (blocked) return { screenOffTimeout: 'refused', stayOn: 'refused', reason: blocked }

    return withTransport(
      row,
      async (transport) => {
        const current = await readPowerState(transport)
        const timeout = await applyScreenOffTimeout(transport, captured.screenOffTimeoutMs, current.screenOffTimeoutMs, log)
        const stayOn = await restoreStayOn(transport, captured.stayOnWhilePluggedIn, current.stayOnWhilePluggedIn, log)
        // The capture is deliberately NOT cleared. Two reasons: `restore` stays
        // genuinely idempotent — the tenth call reads the same capture, finds
        // the device already holding it, and reports `unchanged` twice, rather
        // than degrading into "nothing was ever captured"; and a device that
        // is restored and later re-woken must not re-capture OUR restored
        // values as if they were its originals.
        return { screenOffTimeout: timeout.outcome, stayOn: stayOn.outcome, reason: firstPowerReason(timeout, stayOn) }
      },
      { screenOffTimeout: 'refused', stayOn: 'refused', reason: 'adb is not ready yet' },
    )
  }

  async function observeImpl(deviceId: string): Promise<ObservedScreen> {
    const observedAt = nowSeconds(now)
    const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()
    // Every failure path below answers `unknown`, and none of them answers
    // `off` (acceptance criterion 5). "We could not ask" and "the panel is
    // dark" are different facts, and plan 125 §0.3 exists because this
    // codebase used to conflate them.
    if (!row) return { state: 'unknown', reason: `no such device: ${deviceId}`, observedAt }
    const blocked = unreachable(row)
    if (blocked) return { state: 'unknown', reason: blocked, observedAt }
    const probed = await withTransport(row, (transport) => observeScreen(transport, log), {
      state: 'unknown' as const,
      reason: 'adb is not ready yet',
    })
    return { ...probed, observedAt }
  }

  return {
    capture: captureImpl,
    apply: applyImpl,
    restore: restoreImpl,
    observe: observeImpl,
    captureSink(deviceId) {
      return (state) => {
        try {
          storeCapture(deviceId, state)
        } catch (err) {
          // Never throws into `wakeDevice` (§0.2's framing: a phone that stays
          // dark is worse than a missing capture, and the next wake takes one).
          log.warn(`device ${deviceId}: power capture failed: ${String(err)}`)
        }
      }
    },
  }
}
