import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import type { Db } from '../db'
import { artifacts, blockedDevices, deletedDevices, deviceEvents, deviceTags, devices, discoveredDevices, jobs, type DeviceRow } from '../db/schema'
import type { EventRecorder } from '../events/recorder'
import { deleteJobsWithHistory } from '../jobs/purge'
import type { ActivityRegistry } from '../activity/registry'
import type { ControlPolicySettings } from '../activity/policy'
import { formatDeviceLabel, lookupDeviceNumber } from '../registry/device-number'
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
  /**
   * How many kv-store values this device's stableId owned, now deleted (plan 79 §3.3, §4.6) —
   * ALWAYS populated, regardless of `deleteHistory`: unlike jobs/artifacts/events (a historical
   * record an operator may choose to keep), a kv value is live state — often a login session or
   * another secret — and "a phone leaving the farm does not leave its sessions behind" is not
   * conditional on the history checkbox. 0 when this host has no kv store wired.
   */
  kvDeleted: number
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
 * Device lifecycle (plan 47 §4.3): two verbs, not one.
 *
 * They no longer differ in what they CAN remove — plan 56 made forget work on
 * a connected device too, since an unadmitted phone falls into the Discovered
 * tray instead of being re-enrolled. They differ in what they MEAN: forget
 * takes a device out of the farm and lets it ask again; block says never.
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
  activities: Pick<ActivityRegistry, 'list'>
  controlSettings: () => ControlPolicySettings
  /** Main-stream device events: device.forgotten / device.blocked (plan 47 §3.5, §18 §4.2 pattern). No event for unblock — see the comment on `unblock` below. */
  record?: EventRecorder['record']
  /**
   * Tears down a network route because the OPERATOR explicitly removed this
   * device (plan 56 §3.6). `GuestAgentRoutesHandle.revertNetwork`, which is
   * documented for exactly this: an operator's explicit act, never an
   * automatic reaction to a control marker ending or a device going quiet.
   *
   * That distinction is the whole safety argument. A core that crashes,
   * disconnects, or simply stops talking must leave the tunnel HELD CLOSED —
   * that is the dead-man's switch's job (plan 54), it is verified on hardware,
   * and nothing here touches it. Only a human saying "remove this device"
   * reaches this call.
   */
  revertNetwork?: (deviceId: string, actor?: string | null) => Promise<void>
  /**
   * Best-effort clear of a device's physical label before its row is
   * deleted (plan 89 §3.7 point 4, §5 step 89.9) — the SAME ordering and
   * failure discipline as `releaseRoute` immediately below: it runs BEFORE
   * the transaction (the row still has to exist for `LabellingService` to
   * look it up), a failure is logged and recorded, and it NEVER aborts
   * forget/block. Optional so a test harness that predates this plan, or a
   * host with no labelling service wired, keeps compiling — a device with
   * `labelling.mode: 'off'` (or one that was never labelled at all) costs
   * this call nothing beyond a cheap cache read either way
   * (`LabellingService.clear`'s own "nothing was ever applied" branch).
   */
  clearLabel?: (deviceId: string, actor: Actor) => Promise<void>
  log: Logger
  /**
   * The kv store's own device teardown (plan 79 §3.3, §4.6) — joins `forget`'s existing
   * transaction (both operate on the same underlying SQLite connection, so this genuinely
   * participates in the same atomic commit, not a second one). Optional so a host that has not
   * wired a kv store (or a test that predates this plan) keeps compiling; `forget` then reports
   * `kvDeleted: 0`, honestly, rather than pretending the deletion happened.
   */
  kv?: { deleteDevice(stableId: string): number }
  /**
   * App-data root, needed only by `forget({ deleteHistory: true })` (plan 128
   * §4.5): artifact `path`s are stored relative to it and `traces/<jobId>/`
   * lives under it, so without it the cascade can delete rows but not the
   * bytes they name.
   *
   * Optional so every existing test harness keeps compiling, matching this
   * interface's own convention for an added dependency — but a host that does
   * not wire it leaves artifact files and trace directories on disk after a
   * device is forgotten with its history, and `deleteJobsWithHistory` says so
   * in the log rather than passing for a clean run.
   */
  dataDir?: string
}

type LifecycleOp = 'forget' | 'block'

/**
 * The §3.5 safety matrix, shared by `forget` and `block` — both read the
 * SAME device row and the SAME live activities, so the two operations can
 * never disagree about whether a device is busy or being controlled.
 *
 * Reworked by plan 205 §4.9: `device_busy` is a live `job`/`workflow-job`/
 * `install` activity (never the device's `status`, which no longer encodes
 * this at all — MVP 04 §1.1 shrank it to `offline`/`online`/`quarantined`);
 * `device_in_use` is a live `control` marker NOT owned by the calling actor
 * — an operator forgetting or blocking a device they are themselves
 * currently driving needs no separate "release control first" step, unlike
 * the old manual hold this replaced, which blocked unconditionally
 * regardless of who held it.
 */
function checkRemovable(
  op: LifecycleOp,
  row: DeviceRow,
  activities: Pick<ActivityRegistry, 'list'>,
  controlSettings: () => ControlPolicySettings,
  actor: Actor,
): { ok: true } | { ok: false; code: string; message: string } {
  const live = activities.list(row.id)
  if (live.some((a) => a.kind === 'job' || a.kind === 'workflow-job' || a.kind === 'install')) {
    return { ok: false, code: 'device_busy', message: `${row.label} is running a job — wait for it to finish or cancel it first` }
  }
  const control = live.find((a) => a.kind === 'control')
  if (control && !(control.actor.kind === 'user' && control.actor.id === actor.userId)) {
    return { ok: false, code: 'device_in_use', message: `someone is controlling ${row.label}; wait ${controlSettings().idleSec}s after their last input` }
  }
  // Forgetting a CONNECTED device used to be refused here, with a one-click
  // offer to block instead, because the registry would have re-enrolled it
  // within milliseconds and the delete would have achieved nothing.
  //
  // Plan 56 removed that premise: an unadmitted phone now lands in the
  // Discovered tray rather than back in the fleet. So forget is allowed at
  // any status, and an operator who only wants a device OUT of the farm no
  // longer has to declare it permanently unwelcome to get there. Block still
  // exists and still means "never again" — a different sentence.
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
  const { db, activities, controlSettings, log } = deps

  /**
   * Takes the device's network route down before it stops being a device.
   *
   * Ordering is the point: the route must be released while the row still
   * exists, because everything that knows how to reach the phone is keyed on
   * it. Removing the row first is what stranded a tunnel on a phone with no
   * record of who put it there.
   *
   * A failure here does NOT abort the removal. Refusing would rebuild the very
   * trap this work removed — an operator unable to get a device out of the
   * farm. And the failure mode is safe on its own: a route that could not be
   * torn down stays held closed by the device's own dead-man's switch, so the
   * phone blocks traffic rather than leaking it. Blocked-and-noisy is an
   * acceptable outcome; leaking quietly is not. It is recorded either way, so
   * the state is answerable later instead of invisible.
   */
  async function releaseRoute(row: DeviceRow, actor: Actor): Promise<void> {
    if (!deps.revertNetwork) return
    try {
      await deps.revertNetwork(row.id, actor.userId)
    } catch (err) {
      log.warn(
        `could not take the network route down for ${row.label} (${row.stableId}) before removing it: ${String(err)} — ` +
          'the device holds its route closed until it is admitted again, so it blocks traffic rather than leaking',
      )
      deps.record?.({
        deviceId: row.id,
        stream: 'main',
        kind: 'network.orphaned',
        actor: actor.userId,
        meta: { stableId: row.stableId, reason: String(err) },
      })
    }
  }

  /**
   * Clears a device's physical label before it stops being a device (plan 89
   * §3.7 point 4, §5 step 89.9) — same ordering argument as `releaseRoute`
   * just above: the row still exists, so `LabellingService` can still look
   * it up, resolve its guest-agent session or adb transport, and write the
   * clear. A failure here does NOT abort the removal, for the identical
   * reason `releaseRoute` does not: refusing to forget/block a device just
   * because its wallpaper could not be cleared would rebuild the very trap
   * plan 56 removed. Unlike an orphaned network route, a stale label left on
   * a forgotten phone's screen is cosmetic, not a safety hazard — but it is
   * still recorded, so the state is answerable later instead of invisible.
   */
  async function releaseLabel(row: DeviceRow, actor: Actor): Promise<void> {
    if (!deps.clearLabel) return
    try {
      await deps.clearLabel(row.id, actor)
    } catch (err) {
      log.warn(`could not clear the physical label on ${row.label} (${row.stableId}) before removing it: ${String(err)}`)
      deps.record?.({
        deviceId: row.id,
        stream: 'main',
        kind: 'device.label',
        actor: actor.userId,
        meta: { state: 'unavailable', reason: `clear failed during removal: ${String(err)}` },
      })
    }
  }

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
      const check = checkRemovable('forget', row, activities, controlSettings, opts.actor)
      if (!check.ok) throw new EnkakuError(check.code, check.message)

      // Before the row goes: hand the phone back its own network, and clear
      // whatever physical label it was showing (plan 89 §3.7 point 4).
      await releaseRoute(row, opts.actor)
      await releaseLabel(row, opts.actor)

      let counts: HistoryCounts | null = null
      let kvDeleted = 0
      // ONE transaction (plan 47 §4.3): the check above already ran, so
      // nothing here can be refused — either every write below lands, or (on
      // a thrown error) none of them do. `deletedDevices` is written FIRST,
      // inside the same transaction, so the dangling-reference label exists
      // the instant the row disappears — never a window with neither.
      db.transaction((tx) => {
        // The device's kv-store values (plan 79 §3.3, §4.6) — UNCONDITIONAL, unlike the
        // `deleteHistory`-gated block below: a stored session token is live state, not history.
        // `deps.kv` reads/writes through the SAME `db` this transaction runs on (one SQLite
        // connection), so this genuinely joins the transaction rather than opening a second one.
        kvDeleted = deps.kv?.deleteDevice(row.stableId) ?? 0
        if (opts.deleteHistory) {
          const jobIds = tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.deviceId, row.id)).all().map((r) => r.id)
          const deviceScopedArtifacts = tx.select().from(artifacts).where(eq(artifacts.deviceId, row.id)).all()
          const events = tx.select().from(deviceEvents).where(eq(deviceEvents.deviceId, row.id)).all().length

          // The job half of the cascade is `jobs/purge.ts`'s, not this file's
          // (plan 128 §4.5, R5): job_events, the trace directory, artifact
          // FILES then artifact rows, job_nodes, then the job rows. This block
          // used to do the artifact and job halves inline — which is exactly
          // how it came to delete artifact rows while leaving their files on
          // disk, and how it would have left `traces/<jobId>/` behind. It runs
          // on `tx`, so it joins THIS transaction (Drizzle nests as a
          // SAVEPOINT) rather than opening a second one.
          const purged = deleteJobsWithHistory(tx, jobIds, { dataDir: deps.dataDir, log })

          // Device-scoped artifacts (the Monitor tab's "save last N lines",
          // plan 24 §4.6) belong to no job, so they are outside that cascade —
          // their files and rows go here, in the same transaction.
          if (deps.dataDir !== undefined) {
            for (const artifact of deviceScopedArtifacts) {
              try {
                rmSync(join(deps.dataDir, artifact.path), { force: true })
              } catch (err) {
                log.warn(`failed to delete artifact file ${artifact.path}: ${String(err)}`)
              }
            }
          }
          tx.delete(artifacts).where(eq(artifacts.deviceId, row.id)).run()
          tx.delete(deviceEvents).where(eq(deviceEvents.deviceId, row.id)).run()

          // The same three numbers this has always reported, from the same
          // two shapes (`countArtifacts`'s doc): device-scoped artifacts plus
          // every artifact of every one of the device's own jobs. `events` is
          // `device_events` — NOT the job trace's `job_events`, which the
          // cascade counts separately and this shape has no field for.
          counts = { jobs: jobIds.length, artifacts: deviceScopedArtifacts.length + purged.artifacts, events }
        }
        tx.insert(deletedDevices).values({ id: row.id, stableId: row.stableId, label: row.label, deletedAt: new Date() }).run()
        tx.delete(deviceTags).where(eq(deviceTags.deviceId, row.id)).run()
        // Group membership is a single column on `devices` (plan 22.0
        // §3.2) — deleting the row itself is the whole of "clear group
        // membership"; there is no separate membership table to also clean.
        tx.delete(devices).where(eq(devices.id, row.id)).run()
        // A device forgotten while still plugged in has somewhere to go now
        // (plan 56 §3.2): straight into the Discovered tray, in the same
        // transaction, so it never spends an instant belonging to nothing.
        // Without this the phone would stay invisible until it was unplugged
        // and replugged, which is precisely the dead end that made blocking
        // feel like the only way out.
        if ((row.status ?? 'offline') !== 'offline') {
          const now = new Date()
          tx.insert(discoveredDevices)
            .values({
              stableId: row.stableId,
              serial: row.serial,
              label: row.label,
              androidVersion: row.androidVersion,
              firstSeen: now,
              lastSeen: now,
            })
            .onConflictDoUpdate({
              target: discoveredDevices.stableId,
              set: { serial: row.serial, label: row.label, androidVersion: row.androidVersion, lastSeen: now },
            })
            .run()
        }
      })

      // The number (plan 89 §1, §5 step 89.4) — read AFTER the transaction,
      // not before: `deviceNumbers` is untouched by forget (§3.2's whole
      // point — the reservation survives), so this is simply the same
      // answer either way, but reading it post-commit means a thrown
      // transaction never leaves this line describing a removal that did
      // not happen.
      const number = lookupDeviceNumber(db, row.stableId)
      log.info(`device forgotten: ${formatDeviceLabel(number, row.label)} (${row.stableId})${opts.deleteHistory ? ' with history' : ''}${kvDeleted > 0 ? `, ${kvDeleted} kv value(s)` : ''}`)
      deps.record?.({
        deviceId: row.id,
        stream: 'main',
        kind: 'device.forgotten',
        actor: opts.actor.userId,
        meta: { stableId: row.stableId, deleteHistory: opts.deleteHistory, kvDeleted, number, ...(counts ? { counts } : {}) },
      })

      return { deviceId: row.id, stableId: row.stableId, historyDeleted: opts.deleteHistory, counts, kvDeleted }
    },

    async block(deviceId, opts) {
      const row = mustGet(deviceId)
      const check = checkRemovable('block', row, activities, controlSettings, opts.actor)
      if (!check.ok) throw new EnkakuError(check.code, check.message)

      // Block removes the device too, so it strands a route exactly the same
      // way forget does — and a blocked phone is never coming back to be
      // cleaned up later, which makes this the more important of the two.
      await releaseRoute(row, opts.actor)
      await releaseLabel(row, opts.actor)

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

      // Same reasoning as `forget` above — read post-commit; block also
      // leaves the number reservation untouched (§3.2).
      const number = lookupDeviceNumber(db, row.stableId)
      log.info(`device blocked: ${formatDeviceLabel(number, row.label)} (${row.stableId})${reason ? ` — ${reason}` : ''}`)
      deps.record?.({
        deviceId: row.id,
        stream: 'main',
        kind: 'device.blocked',
        actor: opts.actor.userId,
        meta: { stableId: row.stableId, reason, number },
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
