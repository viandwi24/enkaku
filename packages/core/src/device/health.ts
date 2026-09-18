import type { AdbClient } from '@enkaku/adb'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { devices } from '../db/schema'
import type { DeviceStateMachine } from './state-machine'
import type { FarmSettingsStore } from '../settings/farm-settings'
import type { EventRecorder } from '../events/recorder'
import type { Logger } from '../util/logger'
import { mapWithConcurrency } from '../util/concurrency'
import {
  ADB_SERVER_FAULT_DEVICES,
  ADB_SERVER_FAULT_WINDOW_SEC,
  DEVICE_AUTO_QUARANTINE,
  DEVICE_RECOVERY_PROBE_INTERVAL_SEC,
} from '../config/constants'
import type { QuarantineGrace } from './quarantine-grace'

export type AdbMetricOutcome = 'ok' | 'timeout' | 'busy' | 'error'

/**
 * Which `error`-outcome codes indicate the device itself is not answering
 * (plan 23 §3.6) — `E_ADB_TIMEOUT` is handled separately below since it has
 * its own `outcome` bucket. Everything else classified as `'error'`
 * (`E_ADB_FAIL`, `E_ADB_OUTPUT_LIMIT`, `E_ADB_ABORTED`, `E_ADB_BAD_TIMEOUT`)
 * is either a caller-side outcome or proof the device DID answer — none of
 * those may quarantine a healthy device.
 */
const COUNTING_ERROR_CODES = new Set(['E_ADB_CONNECT_TIMEOUT', 'E_ADB_HANDSHAKE_TIMEOUT'])

/**
 * Codes that are raised against the adb SERVER and can never be evidence
 * about one phone.
 *
 * `E_ADB_CONNECT_TIMEOUT` is `AdbSocket.connect(host, port)` failing to reach
 * 127.0.0.1:5037 inside `DEFAULT_CONNECT_TIMEOUT_MS` (2 s). The serial is not
 * in that path at all — it is attached to the metric only because the exec
 * that was about to be sent named one. Counting it per device made a busy or
 * dead adb server look like every phone on the farm failing at once, which is
 * precisely how 73 healthy phones quarantined themselves as `adb:unreachable`
 * (2026-09-17).
 *
 * It still feeds the farm-wide fault detector below, where it is the single
 * most honest signal there is — it just never moves a per-device streak.
 *
 * `E_ADB_HANDSHAKE_TIMEOUT` is deliberately NOT in here: it is the server
 * failing to ack `host:transport:<serial>`, and while a saturated server
 * causes it, so does a genuinely wedged transport for that one serial. A
 * device that is truly gone answers that request with FAIL (`E_ADB_FAIL`)
 * rather than silence, so the timeout keeps enough per-device meaning to
 * count — under load the detector below is what stops it mass-quarantining.
 */
const SERVER_ONLY_ERROR_CODES = new Set(['E_ADB_CONNECT_TIMEOUT'])

export interface DeviceHealth {
  /** Fed from AdbClient.onMetric (plan 22.1 §22.6). */
  note(serial: string, outcome: AdbMetricOutcome, code?: string): void
  consecutiveFailures(deviceId: string): number
  start(): void
  stop(): void
}

function countsAsFailure(outcome: AdbMetricOutcome, code: string | undefined): boolean {
  if (outcome === 'timeout') return true
  if (outcome === 'error') return code !== undefined && COUNTING_ERROR_CODES.has(code)
  return false // 'busy' never counts (plan 23 §3.6, §6.7) — that is load, not the device
}

/**
 * Device health (plan 23 §3.5, §3.6, §4.4): repeated adb failures quarantine
 * a device automatically, reusing the existing `quarantined` status rather
 * than inventing a new one. Only reasons prefixed `adb:` are ever released
 * automatically — a thermally quarantined device (`battery.ts`) still needs
 * a human to look at it before it goes back to work.
 */
export function createDeviceHealth(deps: {
  db: Db
  client: () => AdbClient | null
  states: DeviceStateMachine
  settings: FarmSettingsStore
  log: Logger
  /** Main-stream device events: device.unhealthy / device.recovered (plan 18 §4.2, plan 23 §4.4). */
  record?: EventRecorder['record']
  /** Test-only override for `DEVICE_RECOVERY_PROBE_INTERVAL_SEC` (plan 212 §4.1 turned this into a support constant; a unit test still needs a fast interval). */
  probeIntervalSecOverride?: number
  /** Test-only override for `DEVICE_AUTO_QUARANTINE` (plan 212 §4.1 F4/F38 — the same constant, kept injectable for the "never quarantines" test case). */
  autoQuarantineOverride?: boolean
  /** A device an operator just released (`battery.ts`'s `unquarantine`) neither counts failures nor is quarantined inside this window. */
  grace?: QuarantineGrace
  /** Test-only override for `ADB_SERVER_FAULT_DEVICES` — a unit test needs a threshold it can cross deliberately. */
  serverFaultDevicesOverride?: number
  /** Test-only override for `ADB_SERVER_FAULT_WINDOW_SEC`, so a test can let the window lapse without sleeping ten seconds. */
  serverFaultWindowSecOverride?: number
}): DeviceHealth {
  const { db, log } = deps
  /** In memory only — a core restart re-probes everything anyway (plan 23 §3.6). */
  const counters = new Map<string, number>()
  let timer: ReturnType<typeof setInterval> | null = null
  /**
   * deviceId → when it last logged a counting failure, for the farm-wide
   * fault detector. Pruned to the window on every read, so it stays the size
   * of "devices failing right now" rather than of the farm.
   */
  const recentFailures = new Map<string, number>()
  /** Rate-limits both the log line and the `ensureServer()` kick to one per window. */
  let lastFaultAt = 0

  const faultDevices = deps.serverFaultDevicesOverride ?? ADB_SERVER_FAULT_DEVICES
  const faultWindowMs = (deps.serverFaultWindowSecOverride ?? ADB_SERVER_FAULT_WINDOW_SEC) * 1000

  /**
   * Is the farm as a whole failing right now?
   *
   * Records this device's failure, then counts how many DISTINCT devices have
   * failed inside the window. At or past `faultDevices` the verdict is the
   * shared adb server, not the phones — see `ADB_SERVER_FAULT_DEVICES` for
   * why every code we count is raised against that server in the first place.
   *
   * On a verdict the streaks are CLEARED, not merely left alone: whatever
   * each device had accumulated was charged to it by a server-wide condition,
   * so carrying it forward would quarantine the first phone to fail once more
   * after the server recovers. A genuinely broken device simply rebuilds its
   * streak on its own, alone, the moment the farm is healthy again.
   */
  function farmWideFault(deviceId: string, nowMs: number): boolean {
    recentFailures.set(deviceId, nowMs)
    for (const [id, at] of recentFailures) {
      if (nowMs - at > faultWindowMs) recentFailures.delete(id)
    }
    if (recentFailures.size < faultDevices) return false

    if (nowMs - lastFaultAt > faultWindowMs) {
      lastFaultAt = nowMs
      log.warn(
        `${recentFailures.size} devices failed adb within ${Math.round(faultWindowMs / 1000)}s — blaming the adb server, not the devices; no quarantine`,
      )
      // The one repair that can actually apply here. Single-flighted inside
      // the client, and swallowed: the probe loop reports per device anyway.
      void deps.client()?.ensureServer().catch(() => {})
    }
    counters.clear()
    return true
  }

  function deviceIdForSerial(serial: string): string | null {
    const row = db.select({ id: devices.id }).from(devices).where(eq(devices.serial, serial)).get()
    return row?.id ?? null
  }

  function quarantineForUnreachable(deviceId: string): void {
    const applied = deps.states.apply(deviceId, 'QUARANTINE')
    if (!applied) {
      // The device is busy or under manual control → identical to how
      // thermal quarantine already behaves (battery.ts §105): retried on
      // the next failure rather than forced through.
      log.debug(`device ${deviceId} is unreachable but cannot be quarantined right now — retrying on the next failure`)
      return
    }
    db.update(devices).set({ quarantineReason: 'adb:unreachable' }).where(eq(devices.id, deviceId)).run()
    log.warn(`device ${deviceId} quarantined: unreachable over adb`)
    deps.record?.({ deviceId, stream: 'main', kind: 'device.unhealthy', meta: { reason: 'adb:unreachable' } })
  }

  /**
   * The recovery prober (plan 23 §4.4.4): every `probeIntervalSec`, every
   * device quarantined with an `adb:`-prefixed reason gets one cheap probe.
   * Success releases it automatically; failure leaves it exactly as is for
   * the next cycle. Bounded parallelism for the same reason as the battery
   * poll (§3.4) — one still-unreachable device must not delay probing the
   * others.
   */
  async function probeOnce(): Promise<void> {
    const client = deps.client()
    if (!client) return
    const candidates = db
      .select()
      .from(devices)
      .where(eq(devices.status, 'quarantined'))
      .all()
      .filter((row) => row.quarantineReason?.startsWith('adb:'))
    if (candidates.length === 0) return
    /*
      Every `adb:`-quarantined device on the farm has the same possible cause
      as the last: the adb server itself. Try to bring it back BEFORE spending
      one `getprop` per phone against a socket that is refusing everyone —
      otherwise this prober runs every 60 s for ever and releases nothing,
      which is exactly what 73 phones did on 2026-09-17 until a human
      restarted the core. Single-flighted, so the tracker doing the same thing
      at the same moment costs one attempt between them, not two.

      Swallowed: if it fails, the probes below fail too and say so per device.
    */
    await client.ensureServer().catch(() => {})
    const limit = Math.max(1, Math.min(8, client.stats().maxConcurrent))
    await mapWithConcurrency(candidates, limit, async (row) => {
      try {
        await client.exec(row.serial, 'getprop ro.serialno', { profile: 'probe' })
        const applied = deps.states.apply(row.id, 'UNQUARANTINE')
        if (applied) {
          db.update(devices).set({ quarantineReason: null }).where(eq(devices.id, row.id)).run()
          counters.set(row.id, 0)
          log.info(`device ${row.label} recovered — un-quarantined automatically`)
          deps.record?.({ deviceId: row.id, stream: 'main', kind: 'device.recovered', meta: {} })
        }
      } catch {
        // Still unreachable — leave it quarantined and try again next interval.
      }
    })
  }

  return {
    note(serial, outcome, code) {
      const deviceId = deviceIdForSerial(serial)
      if (!deviceId) return
      if (outcome === 'ok') {
        counters.set(deviceId, 0)
        recentFailures.delete(deviceId)
        return
      }
      if (!countsAsFailure(outcome, code)) return
      // Always feeds the detector; never moves this device's own streak.
      const serverOnly = code !== undefined && SERVER_ONLY_ERROR_CODES.has(code)
      if (farmWideFault(deviceId, Date.now()) || serverOnly) return
      // The streak that got it quarantined survives a manual release, so one
      // more timeout would pull it straight back. Inside the window the
      // streak starts over instead.
      if (deps.grace?.active(deviceId)) {
        counters.set(deviceId, 0)
        return
      }
      const next = (counters.get(deviceId) ?? 0) + 1
      counters.set(deviceId, next)
      if (next >= deps.settings.get().advanced.failuresBeforeQuarantine && (deps.autoQuarantineOverride ?? DEVICE_AUTO_QUARANTINE)) {
        quarantineForUnreachable(deviceId)
      }
    },

    consecutiveFailures(deviceId) {
      return counters.get(deviceId) ?? 0
    },

    start() {
      if (timer) return
      const intervalMs = (deps.probeIntervalSecOverride ?? DEVICE_RECOVERY_PROBE_INTERVAL_SEC) * 1000
      timer = setInterval(() => void probeOnce(), intervalMs)
    },

    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
