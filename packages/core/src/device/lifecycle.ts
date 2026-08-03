import { eq, inArray } from 'drizzle-orm'
import type { DeviceStatus } from '@enkaku/protocol'
import type { Db } from '../db'
import { artifacts, blockedDevices, deletedDevices, deviceEvents, deviceTags, devices, jobs, type DeviceRow } from '../db/schema'
import type { EventRecorder } from '../events/recorder'
import type { LeaseManager } from '../lease/lease-manager'
import { EnkakuError } from '../util/errors'
import type { Logger } from '../util/logger'

/** Who performed the action — the same shape the API route already resolves from the session. */
export interface Actor {
  userId: string | null
}

export interface HistoryCounts {
  jobs: number
  artifacts: number
  events: number
}

export interface ForgetResult {
  deviceId: string
  stableId: string
  historyDeleted: boolean
  /** Populated only when `historyDeleted` — exactly what was deleted (plan 47 §3.4, §4.3). */
  counts: HistoryCounts | null
}

export interface BlockedDevice {
  stableId: string
  label: string | null
  reason: string | null
  /** Unix epoch seconds. */
  blockedAt: number
  blockedBy: string | null
}

/**
 * Device lifecycle (plan 47 §4.3): two verbs, not one (§3.2) — a plain
 * delete cannot work for a device that is still physically connected, since
 * the registry would re-insert it within milliseconds with a fresh id,
 * losing its tags and cluster while the clutter stays.
 */
export interface DeviceLifecycle {
  forget(deviceId: string, opts: { deleteHistory: boolean; actor: Actor }): Promise<ForgetResult>
  /** Counts shown before confirming "delete history" (§3.4) — never destructive. */
  historyCounts(deviceId: string): Promise<HistoryCounts>
  block(deviceId: string, opts: { reason?: string; actor: Actor }): Promise<BlockedDevice>
  unblock(stableId: string, actor: Actor): Promise<void>
  listBlocked(): Promise<BlockedDevice[]>
}

export interface DeviceLifecycleDeps {
  db: Db
  leases: LeaseManager
  /** Main-stream device events: device.forgotten / device.blocked (plan 47 §3.5, §18 §4.2 pattern). No event for unblock — see the comment on `unblock` below. */
  record?: EventRecorder['record']
  log: Logger
}

type LifecycleOp = 'forget' | 'block'

/**
 * The §3.5 safety matrix, shared by `forget` and `block` — both read the
 * SAME device row and the SAME lease state, so the two operations can never
 * disagree about whether a device is busy or leased.
 *
 * `status` is checked directly rather than re-deriving it from the job store
 * or the session layer: `status` IS the state machine's own single source of
 * truth (spec §10.1) — `busy` only ever means "a job currently holds this
 * device", and `manual` only ever means "a manual lease is held" (plan 04
 * §4.1's transition table). `leases.getLease` is also consulted so a test or
 * caller that constructed a row directly (bypassing the lease manager) is
 * still caught: whichever source is more restrictive wins.
 */
function checkRemovable(
  op: LifecycleOp,
  row: DeviceRow,
  leases: LeaseManager,
): { ok: true } | { ok: false; code: string; message: string } {
  const status = (row.status ?? 'offline') as DeviceStatus
  if (status === 'busy') {
    return { ok: false, code: 'device_busy', message: `${row.label} is running a job — wait for it to finish or cancel it first` }
  }
  const lease = leases.getLease(row.id)
  if (status === 'manual' || (lease && lease.type === 'manual')) {
    return { ok: false, code: 'device_in_use', message: `${row.label} has an active manual lease — release control first` }
  }
  if (op === 'forget' && status !== 'offline' && status !== 'quarantined') {
    // 'idle' (online) — the only remaining live status once busy/manual are
    // ruled out. Forgetting it would be pointless (§3.2): the registry would
    // re-insert it within milliseconds, with a fresh id, losing its tags and
    // cluster while the clutter stays. Block is the supported path instead.
    return { ok: false, code: 'device_online', message: `${row.label} is still connected; block it instead` }
  }
  return { ok: true }
}

function toBlockedDevice(row: typeof blockedDevices.$inferSelect): BlockedDevice {
  return {
    stableId: row.stableId,
    label: row.label,
    reason: row.reason,
    blockedAt: Math.floor(row.blockedAt.getTime() / 1000),
    blockedBy: row.blockedBy,
  }
}

/** Every job id belonging to a device — used to find ITS artifacts too, since a job artifact carries `jobId`, not `deviceId` (schema.ts). */
function jobIdsOf(db: Db, deviceId: string): string[] {
  return db.select({ id: jobs.id }).from(jobs).where(eq(jobs.deviceId, deviceId)).all().map((r) => r.id)
}

/**
 * "Artifacts belonging to this device" spans two shapes (schema.ts's comment
 * on `artifacts`): device-scoped ones (Monitor tab "save last N lines",
 * `deviceId` set) AND every artifact of every one of the device's OWN jobs
 * (`jobId` set, `deviceId` null). Both count toward the number shown before
 * "delete history" is enabled, and both are what gets deleted — otherwise a
 * job's screenshots would survive as artifacts pointing at a `jobId` that
 * `historyCounts` promised was gone too.
 */
function countArtifacts(db: Db, deviceId: string, jobIds: string[]): number {
  const ownDeviceScoped = db.select().from(artifacts).where(eq(artifacts.deviceId, deviceId)).all().length
  const ownJobScoped = jobIds.length > 0 ? db.select().from(artifacts).where(inArray(artifacts.jobId, jobIds)).all().length : 0
  return ownDeviceScoped + ownJobScoped
}

export function createDeviceLifecycle(deps: DeviceLifecycleDeps): DeviceLifecycle {
  const { db, leases, log } = deps

  const mustGet = (deviceId: string): DeviceRow => {
    const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()
    if (!row) throw new EnkakuError('device_not_found', `no such device: ${deviceId}`)
    return row
  }

  return {
    async historyCounts(deviceId) {
      const row = mustGet(deviceId)
      const jobIds = jobIdsOf(db, row.id)
      const events = db.select().from(deviceEvents).where(eq(deviceEvents.deviceId, row.id)).all().length
      return { jobs: jobIds.length, artifacts: countArtifacts(db, row.id, jobIds), events }
    },

    async forget(deviceId, opts) {
      const row = mustGet(deviceId)
      const check = checkRemovable('forget', row, leases)
      if (!check.ok) throw new EnkakuError(check.code, check.message)

      let counts: HistoryCounts | null = null
      // ONE transaction (plan 47 §4.3): the check above already ran, so
      // nothing here can be refused — either every write below lands, or (on
      // a thrown error) none of them do. `deletedDevices` is written FIRST,
      // inside the same transaction, so the dangling-reference label exists
      // the instant the row disappears — never a window with neither.
      db.transaction((tx) => {
        if (opts.deleteHistory) {
          const jobIds = tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.deviceId, row.id)).all().map((r) => r.id)
          const deviceScopedArtifacts = tx.select().from(artifacts).where(eq(artifacts.deviceId, row.id)).all().length
          const jobScopedArtifacts =
            jobIds.length > 0 ? tx.select().from(artifacts).where(inArray(artifacts.jobId, jobIds)).all().length : 0
          const events = tx.select().from(deviceEvents).where(eq(deviceEvents.deviceId, row.id)).all().length
          counts = { jobs: jobIds.length, artifacts: deviceScopedArtifacts + jobScopedArtifacts, events }

          if (jobIds.length > 0) tx.delete(artifacts).where(inArray(artifacts.jobId, jobIds)).run()
          tx.delete(artifacts).where(eq(artifacts.deviceId, row.id)).run()
          tx.delete(deviceEvents).where(eq(deviceEvents.deviceId, row.id)).run()
          tx.delete(jobs).where(eq(jobs.deviceId, row.id)).run()
        }
        tx.insert(deletedDevices).values({ id: row.id, stableId: row.stableId, label: row.label, deletedAt: new Date() }).run()
        tx.delete(deviceTags).where(eq(deviceTags.deviceId, row.id)).run()
        // Cluster membership is a single column on `devices` (plan 22.0
        // §3.2) — deleting the row itself is the whole of "clear cluster
        // membership"; there is no separate membership table to also clean.
        tx.delete(devices).where(eq(devices.id, row.id)).run()
      })

      log.info(`device forgotten: ${row.label} (${row.stableId})${opts.deleteHistory ? ' with history' : ''}`)
      deps.record?.({
        deviceId: row.id,
        stream: 'main',
        kind: 'device.forgotten',
        actor: opts.actor.userId,
        meta: { stableId: row.stableId, deleteHistory: opts.deleteHistory, ...(counts ? { counts } : {}) },
      })

      return { deviceId: row.id, stableId: row.stableId, historyDeleted: opts.deleteHistory, counts }
    },

    async block(deviceId, opts) {
      const row = mustGet(deviceId)
      const check = checkRemovable('block', row, leases)
      if (!check.ok) throw new EnkakuError(check.code, check.message)

      const blockedAt = new Date()
      const reason = opts.reason ?? null
      // Block FORGETS and blocks in the same transaction (plan 47 §4.3) — a
      // blocked device that stayed listed would be the confusing half-state
      // this plan exists to avoid. History is kept exactly like a plain
      // forget without "delete history": blocking is about presence, not
      // about the record of what the device once did.
      db.transaction((tx) => {
        tx.insert(blockedDevices)
          .values({ stableId: row.stableId, label: row.label, reason, blockedAt, blockedBy: opts.actor.userId })
          .onConflictDoUpdate({
            target: blockedDevices.stableId,
            set: { label: row.label, reason, blockedAt, blockedBy: opts.actor.userId },
          })
          .run()
        tx.insert(deletedDevices).values({ id: row.id, stableId: row.stableId, label: row.label, deletedAt: blockedAt }).run()
        tx.delete(deviceTags).where(eq(deviceTags.deviceId, row.id)).run()
        tx.delete(devices).where(eq(devices.id, row.id)).run()
      })

      log.info(`device blocked: ${row.label} (${row.stableId})${reason ? ` — ${reason}` : ''}`)
      deps.record?.({
        deviceId: row.id,
        stream: 'main',
        kind: 'device.blocked',
        actor: opts.actor.userId,
        meta: { stableId: row.stableId, reason },
      })

      return { stableId: row.stableId, label: row.label, reason, blockedAt: Math.floor(blockedAt.getTime() / 1000), blockedBy: opts.actor.userId }
    },

    async unblock(stableId, actor) {
      const existing = db.select().from(blockedDevices).where(eq(blockedDevices.stableId, stableId)).get()
      if (!existing) throw new EnkakuError('not_blocked', `no such blocked device: ${stableId}`)
      db.delete(blockedDevices).where(eq(blockedDevices.stableId, stableId)).run()
      log.info(`device unblocked: ${stableId} by ${actor.userId ?? 'system'}`)
      // No `record()` call here (unlike forget/block): the Plan 18 main
      // stream is deviceId-scoped, and an unblocked stableId has no
      // `devices` row yet — it only gets one on its next connection, with a
      // fresh id this module never sees. The audit log entry the API route
      // writes (target = stableId) is the durable, actor-attributed record
      // §3.5 requires; there is no device page for this event to appear on
      // until the device reconnects anyway.
    },

    async listBlocked() {
      return db.select().from(blockedDevices).all().map(toBlockedDevice)
    },
  }
}

export { checkRemovable }
