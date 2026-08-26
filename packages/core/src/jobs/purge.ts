import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { inArray } from 'drizzle-orm'
import type { JobPurgeCounts } from '@enkaku/protocol'
import { changedRows } from '../db'
import type { Db } from '../db'
import { artifacts, jobEvents, jobNodes, jobs } from '../db/schema'
import type { Logger } from '../util/logger'
import { createTraceFrameStore, type TraceFrameStore } from './trace/frame-store'

/**
 * The job-history cascade (plan 128 §4.5) — the ONE implementation of "delete
 * a job and everything that only exists because of it".
 *
 * Five things go together, in this order:
 *
 * 1. `job_events` — the trace event stream.
 * 2. `traces/<jobId>/` — the frames and UI snapshots those events name.
 * 3. Every artifact FILE, then the `artifacts` rows that pointed at them.
 * 4. `job_nodes` — the workflow node timeline (empty for a non-workflow job).
 * 5. The `jobs` rows themselves.
 *
 * All three callers — `DELETE /api/jobs/:id`, `POST /api/jobs/history/clear`,
 * and `device/lifecycle.ts`'s `deleteHistory` block — go through here rather
 * than each deleting what it happens to remember, which is exactly how
 * `device/lifecycle.ts` came to delete artifact ROWS while leaving their FILES
 * on disk. R5 in that plan's risk table is this function existing.
 *
 * **Files are removed before the rows that name them**, deliberately. The
 * reverse order can lose the path on a rollback and orphan the bytes forever,
 * with nothing left in the database to find them by; this order can at worst
 * leave a row pointing at a file that is already gone, which the artifact
 * routes already handle as a 404.
 */

/** How many job ids go into one transaction — see `deleteJobsWithHistory`'s note on batching. */
const BATCH_SIZE = 500

const EMPTY: JobPurgeCounts = { jobs: 0, events: 0, artifacts: 0, nodes: 0, traceDirs: 0 }

export interface JobPurgeDeps {
  /**
   * App-data root. Artifact `path`s are stored RELATIVE to it
   * (`runner/artifact-store.ts`), and `traces/<jobId>/` lives under it.
   *
   * Optional, because a caller that has not wired it (a test harness, or a
   * host constructed before this plan) must still get the row half of the
   * cascade rather than a crash — but a run without it leaves files on disk,
   * so it is logged as the incomplete cascade it is rather than passing for a
   * clean one.
   */
  dataDir?: string
  /** An already-constructed store; built from `dataDir` when omitted. */
  traceStore?: TraceFrameStore
  log?: Logger
}

/**
 * Deletes `jobIds` and their whole history. Returns what actually went.
 *
 * `db` may be the root database OR an open transaction handle: Drizzle nests a
 * transaction as a SAVEPOINT, so `device/lifecycle.ts` can call this from
 * inside the single transaction its `forget` already runs in, and the two
 * route callers get a real transaction of their own. Neither caller has to
 * know which case it is in.
 *
 * Batched at {@link BATCH_SIZE} ids per transaction: "clear all history" on a
 * long-lived farm can select tens of thousands of jobs, and SQLite binds one
 * parameter per id in the `IN (...)` list — a single statement would hit the
 * variable ceiling. Plan §4.3's "one transaction per batch" is this.
 */
export function deleteJobsWithHistory(db: Db, jobIds: string[], deps: JobPurgeDeps = {}): JobPurgeCounts {
  if (jobIds.length === 0) return { ...EMPTY }

  const store = deps.traceStore ?? (deps.dataDir !== undefined ? createTraceFrameStore({ dataDir: deps.dataDir }) : null)
  if (!store) {
    deps.log?.warn(
      `deleting ${jobIds.length} job(s) without a data directory: rows go, but trace directories and artifact files are left on disk`,
    )
  }

  const total: JobPurgeCounts = { ...EMPTY }
  for (let i = 0; i < jobIds.length; i += BATCH_SIZE) {
    const batch = jobIds.slice(i, i + BATCH_SIZE)
    const counts = db.transaction((tx) => {
      // 1. The trace event stream.
      const events = changedRows(tx.delete(jobEvents).where(inArray(jobEvents.jobId, batch)).run())

      // 2. The trace directory. `jobDir` re-validates the id before it builds
      //    a path (frame-store.ts's own guard), so a job id that could never
      //    have been written is refused here rather than passed to `rmSync`.
      let traceDirs = 0
      if (store) {
        for (const jobId of batch) {
          const dir = store.jobDir(jobId)
          if (!existsSync(dir)) continue
          try {
            rmSync(dir, { recursive: true, force: true })
            traceDirs += 1
          } catch (err) {
            deps.log?.warn(`failed to remove trace directory for job ${jobId}: ${String(err)}`)
          }
        }
      }

      // 3. Artifact files first, then their rows (see the module doc).
      const artifactRows = tx.select().from(artifacts).where(inArray(artifacts.jobId, batch)).all()
      if (deps.dataDir !== undefined) {
        for (const row of artifactRows) {
          try {
            rmSync(join(deps.dataDir, row.path), { force: true })
          } catch (err) {
            deps.log?.warn(`failed to delete artifact file ${row.path}: ${String(err)}`)
          }
        }
      }
      const artifactsDeleted = changedRows(tx.delete(artifacts).where(inArray(artifacts.jobId, batch)).run())

      // 4. The workflow node timeline (plan 99) — 0 rows for every non-workflow job.
      const nodes = changedRows(tx.delete(jobNodes).where(inArray(jobNodes.jobId, batch)).run())

      // 5. The jobs themselves, last: everything above is keyed on the id.
      const jobsDeleted = changedRows(tx.delete(jobs).where(inArray(jobs.id, batch)).run())

      return { jobs: jobsDeleted, events, artifacts: artifactsDeleted, nodes, traceDirs }
    })
    total.jobs += counts.jobs
    total.events += counts.events
    total.artifacts += counts.artifacts
    total.nodes += counts.nodes
    total.traceDirs += counts.traceDirs
  }
  return total
}
