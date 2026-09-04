import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { inArray } from 'drizzle-orm'
import type { JobPurgeCounts } from '@enkaku/protocol'
import { changedRows } from '../db'
import type { Db } from '../db'
import { artifacts, jobEvents, jobRuns, jobs, workflowSteps } from '../db/schema'
import type { Logger } from '../util/logger'
import { createTraceFrameStore, type TraceFrameStore } from './trace/frame-store'

/**
 * The job-history cascade (plan 128 §4.5, re-keyed to runs by plan 211) — the
 * ONE implementation of "delete a job and everything that only exists
 * because of it".
 *
 * For every run of every named job, in this order:
 *
 * 1. `job_events` — the trace event stream, by `run_id`.
 * 2. `traces/<runId>/` — the frames and UI snapshots those events name.
 * 3. Every artifact FILE, then the `artifacts` rows, by `run_id`.
 * 4. `workflow_steps` — for a workflow job's runs (empty for a script job).
 * 5. The `job_runs` rows, then the `jobs` rows themselves.
 *
 * All three callers — `DELETE /api/jobs/:id`, `POST /api/jobs/history/clear`,
 * and `device/lifecycle.ts`'s `deleteHistory` block — go through here.
 *
 * **Files are removed before the rows that name them**, deliberately.
 */

const BATCH_SIZE = 500

const EMPTY: JobPurgeCounts = { jobs: 0, runs: 0, events: 0, artifacts: 0, traceDirs: 0 }

export interface JobPurgeDeps {
  dataDir?: string
  traceStore?: TraceFrameStore
  log?: Logger
}

/**
 * Deletes `jobIds` and their whole history (every run, and everything each
 * run produced). Returns what actually went.
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
    const batchJobIds = jobIds.slice(i, i + BATCH_SIZE)
    const counts = db.transaction((tx) => {
      const runRows = tx.select({ id: jobRuns.id }).from(jobRuns).where(inArray(jobRuns.jobId, batchJobIds)).all()
      const runIds = runRows.map((r) => r.id)

      let events = 0
      let traceDirs = 0
      let artifactsDeleted = 0

      if (runIds.length > 0) {
        events = changedRows(tx.delete(jobEvents).where(inArray(jobEvents.runId, runIds)).run())

        if (store) {
          for (const runId of runIds) {
            const dir = store.runDir(runId)
            if (!existsSync(dir)) continue
            try {
              rmSync(dir, { recursive: true, force: true })
              traceDirs += 1
            } catch (err) {
              deps.log?.warn(`failed to remove trace directory for run ${runId}: ${String(err)}`)
            }
          }
        }

        const artifactRows = tx.select().from(artifacts).where(inArray(artifacts.runId, runIds)).all()
        if (deps.dataDir !== undefined) {
          for (const row of artifactRows) {
            try {
              rmSync(join(deps.dataDir, row.path), { force: true })
            } catch (err) {
              deps.log?.warn(`failed to delete artifact file ${row.path}: ${String(err)}`)
            }
          }
        }
        artifactsDeleted = changedRows(tx.delete(artifacts).where(inArray(artifacts.runId, runIds)).run())

        tx.delete(workflowSteps).where(inArray(workflowSteps.runId, runIds)).run()
        tx.delete(jobRuns).where(inArray(jobRuns.id, runIds)).run()
      }

      const jobsDeleted = changedRows(tx.delete(jobs).where(inArray(jobs.id, batchJobIds)).run())

      return { jobs: jobsDeleted, runs: runIds.length, events, artifacts: artifactsDeleted, traceDirs }
    })
    total.jobs += counts.jobs
    total.runs += counts.runs
    total.events += counts.events
    total.artifacts += counts.artifacts
    total.traceDirs += counts.traceDirs
  }
  return total
}
