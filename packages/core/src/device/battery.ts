import type { AdbClient } from '@enkaku/adb'
import { BatteryStateSchema, type BatteryState, type DeviceStatus } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { devices, type DeviceRow } from '../db/schema'
import type { DeviceStateMachine } from './state-machine'
import type { FarmSettingsStore } from '../settings/farm-settings'
import type { EventRecorder } from '../events/recorder'
import type { Logger } from '../util/logger'
import { mapWithConcurrency } from '../util/concurrency'

/** Parse output `dumpsys battery` (spec §15.2). */
export function parseDumpsysBattery(raw: string): BatteryState | null {
  const num = (key: string): number | null => {
    const m = new RegExp(`^\\s*${key}:\\s*(-?\\d+)`, 'm').exec(raw)
    return m?.[1] ? Number.parseInt(m[1], 10) : null
  }
  const level = num('level')
  if (level === null) return null
  const tempDeci = num('temperature')
  const statusCode = num('status')
  const healthCode = num('health')
  const voltage = num('voltage')
  const acPowered = /AC powered:\s*true/.test(raw)
  const usbPowered = /USB powered:\s*true/.test(raw)

  const STATUS: Record<number, BatteryState['status']> = {
    1: 'unknown',
    2: 'charging',
    3: 'discharging',
    4: 'not_charging',
    5: 'full',
  }
  const HEALTH: Record<number, BatteryState['health']> = {
    1: 'unknown',
    2: 'good',
    3: 'overheat',
    4: 'dead',
    5: 'over_voltage',
    7: 'cold',
  }

  return BatteryStateSchema.parse({
    level,
    temperatureC: tempDeci === null ? 0 : tempDeci / 10,
    status: statusCode !== null ? (STATUS[statusCode] ?? 'unknown') : acPowered || usbPowered ? 'charging' : 'unknown',
    health: healthCode !== null ? (HEALTH[healthCode] ?? 'unknown') : 'unknown',
    ...(voltage !== null ? { voltageMv: voltage } : {}),
    updatedAt: Math.floor(Date.now() / 1000),
  })
}

export interface BatteryMonitor {
  start(): void
  stop(): void
  /** Manually release a quarantine (from Studio). */
  unquarantine(deviceId: string): boolean
  pollOnce(): Promise<void>
}

/**
 * Poll baterai + auto-quarantine termal (spec §15.2): farm HP di-charge
 * Running 24/7 risks swollen batteries, so an overheating device is pulled from
 * the scheduler pool until it is released by hand.
 */
export function createBatteryMonitor(deps: {
  db: Db
  client: () => AdbClient | null
  states: DeviceStateMachine
  settings: FarmSettingsStore
  log: Logger
  onBattery: (deviceId: string, battery: BatteryState) => void
  /** Main-stream device event: battery.warning (plan 18 §4.2). */
  record?: EventRecorder['record']
}): BatteryMonitor {
  let timer: ReturnType<typeof setInterval> | null = null

  /** One device's poll body — unchanged from before plan 23, just no longer run in a sequential `for`. */
  async function pollDevice(client: AdbClient, row: DeviceRow, status: DeviceStatus): Promise<void> {
    const cfg = deps.settings.get().battery
    try {
      const raw = await client.exec(row.serial, 'dumpsys battery', { profile: 'battery' })
      const battery = parseDumpsysBattery(raw)
      if (!battery) return
      deps.db.update(devices).set({ battery }).where(eq(devices.id, row.id)).run()
      deps.onBattery(row.id, battery)

      if (battery.temperatureC > cfg.tempThresholdC && status !== 'quarantined') {
        deps.record?.({
          deviceId: row.id,
          stream: 'main',
          kind: 'battery.warning',
          meta: { level: battery.level, temperatureC: battery.temperatureC },
        })
        if (cfg.autoQuarantine) {
          const reason = `thermal:${battery.temperatureC.toFixed(1)}C`
          const applied = deps.states.apply(row.id, 'QUARANTINE')
          if (applied) {
            deps.db.update(devices).set({ quarantineReason: reason }).where(eq(devices.id, row.id)).run()
            deps.log.warn(`device ${row.label} quarantined: temperature ${battery.temperatureC}°C > ${cfg.tempThresholdC}°C`)
          } else {
            // The device is busy or under manual control → flag it for the next cycle.
            deps.log.warn(`device ${row.label} is hot (${battery.temperatureC}°C) but cannot be quarantined yet (${status})`)
          }
        }
      }
    } catch (err) {
      deps.log.debug(`battery poll for ${row.label} failed: ${String(err)}`)
    }
  }

  /**
   * Bounded parallelism (plan 23 §3.4, §4.5): the old `for` loop awaited each
   * device in turn, so one device sitting at the full `battery` timeout (8s,
   * plan 22.1) delayed the poll — and therefore the thermal check — of every
   * device behind it. The cap never exceeds 8 regardless of how high the
   * global adb semaphore has been auto-scaled, so a busy farm's battery poll
   * cannot itself become the thing that saturates the semaphore.
   */
  async function pollOnce(): Promise<void> {
    const client = deps.client()
    if (!client) return
    const rows = deps.db
      .select()
      .from(devices)
      .all()
      .filter((row) => ((row.status ?? 'offline') as DeviceStatus) !== 'offline')
    const limit = Math.max(1, Math.min(8, client.stats().maxConcurrent))
    await mapWithConcurrency(rows, limit, (row) => pollDevice(client, row, (row.status ?? 'offline') as DeviceStatus))
  }

  return {
    start() {
      if (timer) return
      const intervalMs = deps.settings.get().battery.pollIntervalSec * 1000
      timer = setInterval(() => void pollOnce(), intervalMs)
      void pollOnce()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    unquarantine(deviceId) {
      const applied = deps.states.apply(deviceId, 'UNQUARANTINE')
      if (!applied) return false
      deps.db.update(devices).set({ quarantineReason: null }).where(eq(devices.id, deviceId)).run()
      return true
    },
    pollOnce,
  }
}
