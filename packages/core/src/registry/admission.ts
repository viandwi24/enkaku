import { eq } from 'drizzle-orm'
import { defaultDeviceSettings, type DeviceSettings, type Readiness } from '@enkaku/protocol'
import type { Db } from '../db'
import { blockedDevices, devices, discoveredDevices, type DeviceRow } from '../db/schema'
import { allocateDeviceNumber } from './device-number'

/**
 * Whether a phone adb just reported is allowed into the farm (plan 56).
 *
 * The farm used to be a denylist: anything that connected became a schedulable
 * device, and the only way to say no was to react afterwards. On a workstation
 * whose adb server is shared with Android Studio, that means a personal phone
 * plugged in to charge could be handed to a job. Admission inverts it — a
 * device is a farm member only once someone said so.
 */
export type Admission = 'blocked' | 'admitted' | 'discovered'

/**
 * Precedence is deliberate and total: **blocked beats everything**, then an
 * existing `devices` row, then discovery.
 *
 * Blocked wins even over an existing device row, so a block always takes
 * effect on the next connection rather than depending on which record happens
 * to be cleaned up first. And an existing row is admitted by construction —
 * that is what grandfathers every device enrolled before this plan without
 * rewriting a single one of them (plan 56 §3.3).
 */
export function classify(db: Db, stableId: string): Admission {
  const blocked = db
    .select({ stableId: blockedDevices.stableId })
    .from(blockedDevices)
    .where(eq(blockedDevices.stableId, stableId))
    .get()
  if (blocked) return 'blocked'

  const member = db.select({ id: devices.id }).from(devices).where(eq(devices.stableId, stableId)).get()
  if (member) return 'admitted'

  return 'discovered'
}

/**
 * The farm defaults a device receives the moment it becomes a member.
 *
 * This used to live in the registry, because the registry was where rows were
 * born. Admission moved that moment: `classify` only ever answers `admitted`
 * for a device that already HAS a row, so the registry's create branch became
 * unreachable and creation now happens exactly once, here, when an operator
 * admits the device (plan 56 §4.3).
 */
export function defaultsForNewDevice(opts: {
  deviceDefaults?: () => DeviceSettings
  defaultDesiredReadiness?: () => Readiness
}): {
  transport: DeviceSettings['engines']['transport']
  display: DeviceSettings['engines']['display']
  input: DeviceSettings['engines']['input']
  inspection: DeviceSettings['engines']['inspection']
  settings: DeviceSettings
  desiredReadiness: Readiness | null
} {
  const s = opts.deviceDefaults?.() ?? defaultDeviceSettings()
  return {
    transport: s.engines.transport,
    display: s.engines.display,
    input: s.engines.input,
    inspection: s.engines.inspection,
    settings: s,
    // Readiness (plan 43 §4.4) — `readiness.defaultDesired` on `FarmSettings`
    // is a separate top-level block from `DeviceSettings`, so it needs its own
    // accessor. `null` reads as `asleep` everywhere `desiredReadiness` is
    // consulted, which is the schema's own default.
    desiredReadiness: opts.defaultDesiredReadiness?.() ?? null,
  }
}

/** What an operator may set while admitting a device (plan 56 §4.3). */
export interface AdmitOptions {
  label?: string
  clusterId?: string
  deviceDefaults?: () => DeviceSettings
  defaultDesiredReadiness?: () => Readiness
}

/**
 * Promotes a discovered device into a farm member.
 *
 * Idempotent on `stableId`: two operators pressing **Add to farm** at the same
 * moment is not a failure, so an existing row wins and the discovered entry is
 * cleared either way. Returns the device row, or `null` when there was nothing
 * to admit — a phone that was blocked or dismissed in the meantime.
 */
export function admitDevice(db: Db, stableId: string, opts: AdmitOptions = {}): DeviceRow | null {
  if (classify(db, stableId) === 'blocked') return null

  const existing = db.select().from(devices).where(eq(devices.stableId, stableId)).get()
  if (existing) {
    db.delete(discoveredDevices).where(eq(discoveredDevices.stableId, stableId)).run()
    return existing
  }

  const sighting = db.select().from(discoveredDevices).where(eq(discoveredDevices.stableId, stableId)).get()
  if (!sighting) return null

  // One transaction (plan 89 §3.1, §4.2): the insert and the number
  // allocation must land together, or not at all. `allocateDeviceNumber`
  // requires being called inside the caller's own transaction for exactly
  // this reason — a failed insert must never consume a number.
  return db.transaction((tx) => {
    tx.insert(devices)
      .values({
        id: crypto.randomUUID(),
        stableId,
        serial: sighting.serial,
        label: opts.label?.trim() || sighting.label || stableId,
        androidVersion: sighting.androidVersion,
        status: 'offline',
        lastSeen: sighting.lastSeen,
        ...(opts.clusterId ? { clusterId: opts.clusterId } : {}),
        ...defaultsForNewDevice(opts),
      })
      .run()

    allocateDeviceNumber(tx, stableId)

    tx.delete(discoveredDevices).where(eq(discoveredDevices.stableId, stableId)).run()
    return tx.select().from(devices).where(eq(devices.stableId, stableId)).get() ?? null
  })
}

/** What the registry learned about a phone it is not allowed to enrol yet. */
export interface DiscoverySighting {
  stableId: string
  serial: string
  label: string | null
  androidVersion: string | null
}

/**
 * Records a sighting without creating a farm device.
 *
 * `firstSeen` survives re-sightings — it is how long a phone has been waiting
 * for a decision, which is the one piece of information the tray can offer
 * that a live device list cannot.
 */
export function recordSighting(db: Db, sighting: DiscoverySighting, now: Date = new Date()): void {
  db.insert(discoveredDevices)
    .values({
      stableId: sighting.stableId,
      serial: sighting.serial,
      label: sighting.label,
      androidVersion: sighting.androidVersion,
      firstSeen: now,
      lastSeen: now,
    })
    .onConflictDoUpdate({
      target: discoveredDevices.stableId,
      set: {
        serial: sighting.serial,
        label: sighting.label,
        androidVersion: sighting.androidVersion,
        lastSeen: now,
      },
    })
    .run()
}
