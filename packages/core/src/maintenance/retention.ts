import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import { changedRows } from '../db'
import type { Db } from '../db'
import { artifacts, commandRunMembers, commandRuns, deviceEvents } from '../db/schema'
import type { FarmSettingsStore } from '../settings/farm-settings'
import type { Logger } from '../util/logger'

export interface RetentionGc {
  start(): void
  stop(): void
  sweepOnce(): { deleted: number; freedBytes: number; eventsDeleted: number; commandRunsDeleted: number }
}

/**
 * Retention artifact (spec §18): screenshot/log/video menumpuk cepat.
 * The policy: delete anything past its TTL, then — if the total is still over
 * quota — delete oldest-first (LRU by createdAt) until it fits.
 */
export function createRetentionGc(deps: {
  db: Db
  dataDir: string
  settings: FarmSettingsStore
  log: Logger
  intervalMinutes: number
  onSwept?: (result: { deleted: number; freedBytes: number }) => void
}): RetentionGc {
  let timer: ReturnType<typeof setInterval> | null = null

  function removeRows(ids: string[]): number {
    if (ids.length === 0) return 0
    const rows = deps.db.select().from(artifacts).where(inArray(artifacts.id, ids)).all()
    let freed = 0
    for (const row of rows) {
      try {
        rmSync(join(deps.dataDir, row.path), { force: true })
        freed += row.sizeBytes ?? 0
      } catch (err) {
        deps.log.warn(`failed to delete artifact ${row.path}: ${String(err)}`)
      }
    }
    deps.db.delete(artifacts).where(inArray(artifacts.id, ids)).run()
    return freed
  }

  /**
   * Device event log GC (plan 18 §4.4): two age budgets (one per stream) then
   * a hard row ceiling per (device, stream), oldest rows first. Unlike the
   * artifact policy above, this is NOT gated by `policy.enabled` — an
   * unbounded input stream is a disk-filling bug, not an opt-in convenience
   * (plan 18 §3.3).
   */
  function sweepEvents(): number {
    const policy = deps.settings.get().retention
    let deleted = 0

    const mainCutoff = new Date(Date.now() - policy.eventMainDays * 86_400_000)
    const inputCutoff = new Date(Date.now() - policy.eventInputDays * 86_400_000)
    deleted += changedRows(
      deps.db.delete(deviceEvents).where(and(eq(deviceEvents.stream, 'main'), lt(deviceEvents.at, mainCutoff))).run(),
    )
    deleted += changedRows(
      deps.db.delete(deviceEvents).where(and(eq(deviceEvents.stream, 'input'), lt(deviceEvents.at, inputCutoff))).run(),
    )

    // Hard ceiling per (device, stream) — the age budget above is not always
    // enough on a very busy device.
    const counts = deps.db
      .select({
        deviceId: deviceEvents.deviceId,
        stream: deviceEvents.stream,
        cnt: sql<number>`count(*)`.as('cnt'),
      })
      .from(deviceEvents)
      .groupBy(deviceEvents.deviceId, deviceEvents.stream)
      .all()
    for (const row of counts) {
      const excess = row.cnt - policy.eventMaxRowsPerDevice
      if (excess <= 0) continue
      const oldestIds = deps.db
        .select({ id: deviceEvents.id })
        .from(deviceEvents)
        .where(and(eq(deviceEvents.deviceId, row.deviceId), eq(deviceEvents.stream, row.stream)))
        .orderBy(asc(deviceEvents.at))
        .limit(excess)
        .all()
        .map((r) => r.id)
      deleted += changedRows(deps.db.delete(deviceEvents).where(inArray(deviceEvents.id, oldestIds)).run())
    }

    if (deleted > 0) deps.log.info(`event retention: deleted ${deleted} device event row(s)`)
    return deleted
  }

  /**
   * Command console history GC (plan 93 §3.9, §4.1, §5 step 93.2): fleet
   * command runs older than `retention.commandRunDays` (default 14 days),
   * with every one of their `command_run_members` cascaded in the same
   * sweep — a cascading delete has to actually cascade, never leave orphan
   * member rows behind. Sits beside `sweepEvents` above and is, like it,
   * deliberately NOT gated by `policy.enabled`: `command_runs` is the same
   * shape of append-only, per-action table `device_events` is (plan 18 §3.3's
   * reasoning, restated here rather than merely referenced) — an unbounded
   * command history is a disk-filling bug, not an opt-in convenience an
   * operator has to remember to switch on. The artifact policy below it IS
   * opt-in because deleting someone's screenshots without asking is a
   * product decision; deleting a command's own audit trail once it is
   * fourteen days past its retention window is not.
   */
  function sweepCommandRuns(): number {
    const policy = deps.settings.get().retention
    const cutoff = new Date(Date.now() - policy.commandRunDays * 86_400_000)
    const staleIds = deps.db
      .select({ id: commandRuns.id })
      .from(commandRuns)
      .where(lt(commandRuns.startedAt, cutoff))
      .all()
      .map((r) => r.id)
    if (staleIds.length === 0) return 0
    deps.db.delete(commandRunMembers).where(inArray(commandRunMembers.runId, staleIds)).run()
    const deleted = changedRows(deps.db.delete(commandRuns).where(inArray(commandRuns.id, staleIds)).run())
    if (deleted > 0) deps.log.info(`command run retention: deleted ${deleted} command run(s)`)
    return deleted
  }

  function sweepOnce(): { deleted: number; freedBytes: number; eventsDeleted: number; commandRunsDeleted: number } {
    const eventsDeleted = sweepEvents()
    const commandRunsDeleted = sweepCommandRuns()
    const policy = deps.settings.get().retention
    if (!policy.enabled) return { deleted: 0, freedBytes: 0, eventsDeleted, commandRunsDeleted }

    const rows = deps.db.select().from(artifacts).orderBy(asc(artifacts.createdAt)).all()
    const cutoff = Date.now() - policy.maxAgeDays * 86_400_000
    const expired = rows.filter((r) => (r.createdAt?.getTime() ?? 0) < cutoff).map((r) => r.id)
    let freed = removeRows(expired)
    let deleted = expired.length

    // Then: if the total is still over quota, drop the oldest first.
    const remaining = rows.filter((r) => !expired.includes(r.id))
    const quotaBytes = policy.maxTotalGb * 1024 ** 3
    let total = remaining.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0)
    const overflow: string[] = []
    for (const row of remaining) {
      if (total <= quotaBytes) break
      overflow.push(row.id)
      total -= row.sizeBytes ?? 0
    }
    freed += removeRows(overflow)
    deleted += overflow.length

    if (deleted > 0) {
      deps.log.info(`retention GC: deleted ${deleted} artifact(s) (${(freed / 1024 ** 2).toFixed(1)} MB)`)
      deps.onSwept?.({ deleted, freedBytes: freed })
    }
    return { deleted, freedBytes: freed, eventsDeleted, commandRunsDeleted }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void sweepOnce(), deps.intervalMinutes * 60_000)
      sweepOnce()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    sweepOnce,
  }
}
