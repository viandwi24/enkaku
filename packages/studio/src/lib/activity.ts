import type { DeviceActivity, DeviceActivityEvent, DeviceInfo } from '@enkaku/protocol'

/**
 * The single client-side helper module for MVP 04's device activity model
 * (plan 205 §4.11) — the Studio-side counterpart to
 * `packages/protocol/src/activity.ts`'s `deviceState`. Every place Studio used
 * to read `DeviceInfo.status === 'busy'`/`'manual'` or the two old
 * per-holder/secondary-operator fields now reads `DeviceInfo.activities`/
 * `.lastControl` through these functions, so there is exactly one definition
 * of "this device is busy" and "this device is controlled" in the whole app.
 */

export const JOB_KINDS = new Set<DeviceActivity['kind']>(['job', 'workflow-job'])

/** A `job`/`workflow-job` activity is live on this device (plan 205 §4.9 — replaces `status === 'busy'`). */
export const hasJob = (d: Pick<DeviceInfo, 'activities'>): boolean => d.activities.some((a) => JOB_KINDS.has(a.kind))

/** A `control` marker is live on this device (plan 205 §4.9 — replaces `status === 'manual'`/`iHoldControl`). */
export const isControlled = (d: Pick<DeviceInfo, 'activities'>): boolean => d.activities.some((a) => a.kind === 'control')

/** The running job's id, with the `job:` marker prefix stripped — or `null` when none is live. */
export const runningJobId = (d: Pick<DeviceInfo, 'activities'>): string | null =>
  d.activities.find((a) => JOB_KINDS.has(a.kind))?.id.replace(/^job:/, '') ?? null

/** MVP 15 §1: green free, amber someone controlling, red job running, grey disconnected, warn quarantined. */
export type StateDot = 'free' | 'controlled' | 'job' | 'offline' | 'warn'

export function stateDot(d: Pick<DeviceInfo, 'status' | 'activities'>): StateDot {
  if (d.status === 'offline') return 'offline'
  if (d.status === 'quarantined') return 'warn'
  if (hasJob(d)) return 'job'
  if (isControlled(d)) return 'controlled'
  return 'free'
}

/**
 * Merges one `device.activity` payload into a device: add or replace by id
 * (`change === 'added'` or `'updated'`), drop by id (`change === 'ended'`),
 * and set `lastControl` from the event every time it carries one — the WS
 * payload already computed the tail (or its absence), so this never
 * recomputes it client-side.
 *
 * Generic over `D` (rather than fixed to `DeviceInfo`) so a caller holding a
 * wider shape — `DeviceDetailInfo` (`DeviceHeader.tsx`), which adds
 * `transport`/`display`/`settings`/etc. — gets that same wider shape back,
 * not the narrower base type: the object spread below already preserves
 * every extra field at runtime, this only keeps the TYPE honest about it.
 */
export function applyActivityEvent<D extends DeviceInfo>(d: D, e: DeviceActivityEvent['payload']): D {
  const activities =
    e.change === 'ended'
      ? d.activities.filter((a) => a.id !== e.activity.id)
      : [...d.activities.filter((a) => a.id !== e.activity.id), e.activity]
  return { ...d, activities, lastControl: e.lastControl }
}
