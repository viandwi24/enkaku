import { and, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm'
import type { Db } from '../../db'
import { jobRuns, jobs } from '../../db/schema'
import { SIMULATE_RUN_RETENTION_DAYS } from '../../config/constants'
import type { RunStore } from './store'

/**
 * The single most recently finished terminal run of EACH workflow, across
 * every job that workflow ever had (plan 304 §4.4, G8) — distinct from
 * `jobs.latestRunId`, which only protects a job's own latest run: a workflow
 * that has been run from more than one job (a re-published document, a
 * schedule that creates a fresh job) can have its truly-latest run sitting
 * on a job that is not that job's own `latestRunId` is irrelevant here, only
 * "most recent across the whole workflow name" is. An author returning to a
 * workflow after a fortnight would otherwise find its data panes (plan 306)
 * empty even though a run exists.
 */
export function latestWorkflowRunIds(db: Db): Set<string> {
  const rows = db
    .select({ id: jobRuns.id, workflowName: jobs.workflowName, at: sql<number>`coalesce(${jobRuns.finishedAt}, ${jobRuns.createdAt})` })
    .from(jobRuns)
    .innerJoin(jobs, eq(jobs.id, jobRuns.jobId))
    .where(
      and(
        isNotNull(jobs.workflowName),
        inArray(jobRuns.status, ['success', 'failed', 'cancelled', 'expired']),
        // A `node-test`/`simulate` run must never be exempted from the
        // simulate/short-horizon sweep by looking like a workflow's own
        // "latest run" (plan 304 §4.6, plan 309 §3.4 G4) — the read side
        // (`api/workflows.ts`'s `last-run`) already excludes both the same way.
        notInArray(jobRuns.trigger, ['node-test', 'simulate']),
      ),
    )
    .all()
  const best = new Map<string, { id: string; at: number }>()
  for (const row of rows) {
    if (!row.workflowName) continue
    const current = best.get(row.workflowName)
    if (!current || row.at > current.at) best.set(row.workflowName, { id: row.id, at: row.at })
  }
  return new Set([...best.values()].map((v) => v.id))
}

/**
 * The seam MVP 09 §6 and MVP 14 §5 need: runs expire individually, and a job
 * with no runs that no schedule owns is swept with them. Plan 224 writes the
 * policy (the defaults, the nightly cadence, the Storage row in Settings) and
 * wires this into `retention/sweeper.ts`. Plan 211 ships the interface and
 * nothing else: there is no implementation, no caller, and no setting.
 */
export interface RunRetentionPolicy {
  /** Runs finished longer ago than this are candidates. */
  runDays: number
  /** Never sweep the latest run of a job, whatever its age. */
  keepLatest: boolean
  /** Rows per transaction, so a first sweep after an upgrade cannot hold the write lock. */
  chunk: number
}

export interface RunRetentionSweeper {
  /**
   * One pass. Deletes candidate runs through `RunStore.deleteRuns` (the one
   * delete path, so `latest_run_id`/`run_count` stay honest), then deletes
   * every job it touched that has `run_count = 0` AND `schedule_id IS NULL`
   * AND `parent_workflow_job_id IS NULL`. Returns what it removed.
   */
  sweepOnce(): { runs: number; jobs: number }
}

/** Plan 211 ships this and only this: a sweeper that removes nothing. */
export const NO_OP_RUN_SWEEPER: RunRetentionSweeper = { sweepOnce: () => ({ runs: 0, jobs: 0 }) }

export type CreateRunRetentionSweeper = (deps: { db: Db; runs: RunStore; policy: RunRetentionPolicy }) => RunRetentionSweeper

/**
 * Plan 224's implementation of the interface plan 211 shipped. Finds every
 * terminal run older than `policy.runDays` that is not its job's current
 * `latestRunId` (i.e. `keepLatest` is always honoured — the interface names
 * the field but there is only one policy this plan ever constructs), deletes
 * them in `policy.chunk`-sized batches through `RunStore.deleteRuns` (the
 * ONLY delete path for a run — plan 211 §4.3), then deletes every job
 * `deleteRuns` reports as touched whose `run_count` reached zero and that no
 * schedule or parent workflow job owns.
 */
export const createRunRetentionSweeper: CreateRunRetentionSweeper = (deps) => {
  function candidateRunIds(): string[] {
    const cutoffSec = Math.floor((Date.now() - deps.policy.runDays * 86_400_000) / 1000)
    const exempt = latestWorkflowRunIds(deps.db) // plan 304 §4.4, G8
    return deps.db
      .select({ id: jobRuns.id })
      .from(jobRuns)
      .innerJoin(jobs, eq(jobs.id, jobRuns.jobId))
      .where(
        and(
          inArray(jobRuns.status, ['success', 'failed', 'cancelled', 'expired']),
          ne(jobRuns.trigger, 'simulate'), // simulate runs have their OWN, much shorter horizon below
          or(isNull(jobs.latestRunId), ne(jobs.latestRunId, jobRuns.id)),
          sql`coalesce(${jobRuns.finishedAt}, ${jobRuns.createdAt}) < ${cutoffSec}`,
        ),
      )
      .all()
      .map((r) => r.id)
      .filter((id) => !exempt.has(id))
  }

  /**
   * A `trigger: 'simulate'` run's own, much shorter cutoff (plan 309 §3.4,
   * G4) — independent of the operator's `storage.historyDays`: it is
   * scratch work, not history, so it never rides the real-run policy's
   * (possibly months-long) horizon. Never exempted by `latestWorkflowRunIds`
   * (which already excludes `simulate`, above) — every terminal simulate
   * run older than the cutoff goes, including a job's own `latestRunId`,
   * since a simulate job exists for no other reason.
   */
  function candidateSimulateRunIds(): string[] {
    const cutoffSec = Math.floor((Date.now() - SIMULATE_RUN_RETENTION_DAYS * 86_400_000) / 1000)
    return deps.db
      .select({ id: jobRuns.id })
      .from(jobRuns)
      .where(
        and(
          eq(jobRuns.trigger, 'simulate'),
          inArray(jobRuns.status, ['success', 'failed', 'cancelled', 'expired']),
          sql`coalesce(${jobRuns.finishedAt}, ${jobRuns.createdAt}) < ${cutoffSec}`,
        ),
      )
      .all()
      .map((r) => r.id)
  }

  function sweepOnce(): { runs: number; jobs: number } {
    const ids = [...candidateRunIds(), ...candidateSimulateRunIds()]
    let runsDeleted = 0
    let jobsDeleted = 0
    for (let i = 0; i < ids.length; i += deps.policy.chunk) {
      const batch = ids.slice(i, i + deps.policy.chunk)
      const { runs, jobsTouched } = deps.runs.deleteRuns(batch)
      runsDeleted += runs
      for (const jobId of jobsTouched) {
        const row = deps.db.select().from(jobs).where(eq(jobs.id, jobId)).get()
        if (!row) continue
        if (row.runCount === 0 && row.scheduleId === null && row.parentWorkflowJobId === null) {
          deps.db.delete(jobs).where(eq(jobs.id, jobId)).run()
          jobsDeleted += 1
        }
      }
    }
    return { runs: runsDeleted, jobs: jobsDeleted }
  }

  return { sweepOnce }
}
