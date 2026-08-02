import type { AdbClient } from '@enkaku/adb'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { devices } from '../db/schema'
import type { DeviceStateMachine } from './state-machine'
import type { FarmSettingsStore } from '../settings/farm-settings'
import type { EventRecorder } from '../events/recorder'
import type { Logger } from '../util/logger'
import { mapWithConcurrency } from '../util/concurrency'

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
}): DeviceHealth {
  const { db, log } = deps
  /** In memory only — a core restart re-probes everything anyway (plan 23 §3.6). */
  const counters = new Map<string, number>()
  let timer: ReturnType<typeof setInterval> | null = null

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
        return
      }
      if (!countsAsFailure(outcome, code)) return
      const next = (counters.get(deviceId) ?? 0) + 1
      counters.set(deviceId, next)
      const cfg = deps.settings.get().health
      if (next >= cfg.consecutiveFailures && cfg.autoQuarantine) {
        quarantineForUnreachable(deviceId)
      }
    },

    consecutiveFailures(deviceId) {
      return counters.get(deviceId) ?? 0
    },

    start() {
      if (timer) return
      const intervalMs = deps.settings.get().health.probeIntervalSec * 1000
      timer = setInterval(() => void probeOnce(), intervalMs)
    },

    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
