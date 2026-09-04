import type { Db } from '../../db'
import type { RunStore } from './store'

/**
 * The seam MVP 09 §6 and MVP 14 §5 need: runs expire individually, and a job
 * with no runs that no schedule owns is swept with them. Plan 224 writes the
 * policy (the defaults, the nightly cadence, the Storage row in Settings) and
 * wires this into `maintenance/retention.ts`. Plan 211 ships the interface and
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
