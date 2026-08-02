import type { AdbClient } from '@enkaku/adb'
import { BatteryStateSchema, type BatteryState, type DeviceStatus } from '@enkaku/protocol'
import { eq } from 'drizzle-orm'
import type { Db } from '../db'
import { devices } from '../db/schema'
import type { DeviceStateMachine } from './state-machine'
import type { FarmSettingsStore } from '../settings/farm-settings'
import type { Logger } from '../util/logger'

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
}): BatteryMonitor {
  let timer: ReturnType<typeof setInterval> | null = null

  async function pollOnce(): Promise<void> {
    const client = deps.client()
    if (!client) return
    const cfg = deps.settings.get().battery
    const rows = deps.db.select().from(devices).all()
    for (const row of rows) {
      const status = (row.status ?? 'offline') as DeviceStatus
      if (status === 'offline') continue
      try {
        const raw = await client.exec(row.serial, 'dumpsys battery')
        const battery = parseDumpsysBattery(raw)
        if (!battery) continue
        deps.db.update(devices).set({ battery }).where(eq(devices.id, row.id)).run()
        deps.onBattery(row.id, battery)

        if (cfg.autoQuarantine && battery.temperatureC > cfg.tempThresholdC && status !== 'quarantined') {
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
      } catch (err) {
        deps.log.debug(`battery poll for ${row.label} failed: ${String(err)}`)
      }
    }
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
