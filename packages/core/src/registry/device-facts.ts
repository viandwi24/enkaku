import { asc, eq } from 'drizzle-orm'
import type { ExprDevice } from '@enkaku/expr'
import type { Db } from '../db'
import { deviceLabels, deviceNumbers, devices, groups, labels } from '../db/schema'

/**
 * The five device facts a workflow expression may read as `$device`
 * (plan 314 §10.11).
 *
 * Read once per RUN, not per step: none of them can change underneath a run
 * in a way a mid-run step should act on, and re-reading five joins on every
 * gate would be four queries per step for a value that did not move. The
 * same reasoning `runIndex`/`runCount` already state in the executor.
 *
 * `number` is the load-bearing one and the reason this function exists.
 * A rotation that has to mean the same thing across several batches — a
 * warm-up split into a morning, an afternoon and an evening session — cannot
 * key on `$run.index`, because that is a position inside ONE batch:
 * `order: 'random'` reshuffles it deliberately, and `createBatch` numbers
 * only the devices that resolved as usable, so one offline phone shifts
 * every device after it for that dispatch alone. `device_numbers.number` is
 * unique, durable, survives both, and is the number written on the phone's
 * own physical label, so an operator can check a rotation by looking at the
 * rack rather than at a batch report.
 *
 * A device with no row here reads `null` rather than a fabricated 0 —
 * a released reservation is a real state (plan 89), and arithmetic on `null`
 * then fails the step by name instead of quietly rotating everything to the
 * same platform.
 */
export function readDeviceFacts(db: Db, deviceId: string): ExprDevice | undefined {
  const row = db
    .select({ stableId: devices.stableId, label: devices.label, groupName: groups.name, number: deviceNumbers.number })
    .from(devices)
    .leftJoin(groups, eq(groups.id, devices.groupId))
    .leftJoin(deviceNumbers, eq(deviceNumbers.stableId, devices.stableId))
    .where(eq(devices.id, deviceId))
    .get()
  if (!row) return undefined

  const carried = db
    .select({ name: labels.name })
    .from(deviceLabels)
    .innerJoin(labels, eq(labels.id, deviceLabels.labelId))
    .where(eq(deviceLabels.deviceId, deviceId))
    .orderBy(asc(labels.name))
    .all()

  return {
    number: row.number ?? null,
    stableId: row.stableId,
    label: row.label,
    group: row.groupName ?? null,
    labels: carried.map((l) => l.name),
  }
}
