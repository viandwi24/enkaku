import { and, desc, eq, inArray } from 'drizzle-orm'
import type { JobKind, RunTrigger } from '@enkaku/protocol'
import crypto from 'node:crypto'
import { type Db } from '../../db'
import { jobRuns, jobs, type JobRow, type JobRunRow } from '../../db/schema'
import { EnkakuError } from '../../util/errors'

/**
 * A job is an INTENT (MVP 14 §1, plan 211): what to run, with which
 * parameters, on which device, made by whom. `runs/store.ts` is the ONLY
 * writer of `jobs.latest_run_id`/`jobs.run_count` and the only place a run
 * row is created, settled or deleted — every other module composes these
 * calls rather than touching `job_runs` directly.
 */

export interface CreateJobInput {
  kind: JobKind
  /** Required for `kind: 'script'`, refused for `kind: 'workflow'`. */
  scriptId?: string | null
  /** Required for `kind: 'workflow'`, refused for `kind: 'script'`. */
  workflowName?: string | null
  /** The snapshot (`WorkflowStore.snapshotForJob`, plan 210 §4.4). Required with `workflowName`. */
  workflowDoc?: unknown
  deviceId: string
  params: unknown
  scriptName: string | null
  scriptVersion: string | null
  batchId?: string | null
  batchSeq?: number | null
  scheduleId?: string | null
  parentWorkflowJobId?: string | null
  stepSeq?: number | null
  triggeredByJobId?: string | null
  rootJobId?: string | null
  depth?: number
  triggerKey?: string | null
  createdBy?: string | null
}

export interface AddRunInput {
  trigger: RunTrigger
  priority?: number
  expiresAt?: number | null
  notBefore?: number | null
  batchRepeat?: number | null
  pacedDelayMs?: number | null
  maxConcurrent?: number | null
  /** Omitted carries the previous run's value forward (plan 211 §3.2 decision 12 mirrors `job-service.ts`'s old `resume()`). */
  runtimeOverride?: unknown
  resumedFromRunId?: string | null
  resumedFromStep?: number | null
}

export interface SettleRunInput {
  status: 'success' | 'failed' | 'cancelled'
  result?: unknown
  error?: string
  failureClass?: string | null
  errorPhase?: string | null
  peakRssBytes?: number | null
  resultStatus?: string | null
  resultBytes?: number | null
  resultSummary?: string | null
  resultIssues?: unknown
}

function jsonKey(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export interface RunStore {
  /** Inserts the job row only. A job with no run is legal and invisible to the queue. */
  createJob(input: CreateJobInput): JobRow
  /**
   * Inserts a run at `seq = job.run_count + 1`, status `queued`, and updates
   * `latest_run_id`/`run_count` in the SAME transaction. Throws
   * `job_not_found`. `deviceId` and `scriptName` are copied from the job.
   */
  addRun(jobId: string, input: AddRunInput): JobRunRow
  /**
   * MVP 14 §2 and §6 item 2: adds a run when `params`, `scriptId`/
   * `workflowName`, `deviceId` and `kind` all match the job; otherwise
   * creates a NEW job (copying `batchId`, `batchSeq`, `scheduleId`,
   * `createdBy`) and adds its first run. `sameJob` says which happened.
   */
  addRunOrNewJob(jobId: string, params: unknown, input: AddRunInput): { job: JobRow; run: JobRunRow; sameJob: boolean }
  getJob(jobId: string): JobRow | null
  getRun(runId: string): JobRunRow | null
  latestRun(jobId: string): JobRunRow | null
  runs(jobId: string): JobRunRow[]
  /** The latest run of each of these jobs, in one statement (the list projection and `recomputeBatchStatus`). */
  latestRuns(jobIds: string[]): Map<string, JobRunRow>
  /** Terminal settle. Only ever touches a `running` row, mirroring today's `finish()`. Returns null when it did not. */
  settle(runId: string, input: SettleRunInput): JobRunRow | null
  /** `queued` to `cancelled`. */
  cancelQueuedRun(runId: string): JobRunRow | null
  /** Every run of every member job of a batch, newest generation first. */
  runsByBatch(batchId: string): JobRunRow[]
  /**
   * Deletes runs and recomputes `latest_run_id`/`run_count` for every job
   * they belonged to, in one transaction. The ONLY delete path for a run;
   * `purge.ts` and the retention sweeper both go through it.
   */
  deleteRuns(runIds: string[]): { runs: number; jobsTouched: string[] }
}

export function createRunStore(db: Db): RunStore {
  return {
    createJob(input) {
      if (input.kind === 'script' && input.workflowName) {
        throw new EnkakuError('E_BAD_REQUEST', 'a script job cannot carry a workflowName')
      }
      if (input.kind === 'workflow' && input.scriptId) {
        throw new EnkakuError('E_BAD_REQUEST', 'a workflow job cannot carry a scriptId')
      }
      const row: typeof jobs.$inferInsert = {
        id: crypto.randomUUID(),
        kind: input.kind,
        scriptId: input.kind === 'script' ? (input.scriptId ?? null) : null,
        workflowName: input.kind === 'workflow' ? (input.workflowName ?? null) : null,
        workflowDoc: input.kind === 'workflow' ? (input.workflowDoc ?? null) : null,
        deviceId: input.deviceId,
        params: input.params ?? null,
        batchId: input.batchId ?? null,
        batchSeq: input.batchSeq ?? null,
        scheduleId: input.scheduleId ?? null,
        parentWorkflowJobId: input.parentWorkflowJobId ?? null,
        stepSeq: input.stepSeq ?? null,
        scriptName: input.scriptName,
        scriptVersion: input.scriptVersion,
        triggeredByJobId: input.triggeredByJobId ?? null,
        rootJobId: input.rootJobId ?? null,
        depth: input.depth ?? 0,
        triggerKey: input.triggerKey ?? null,
        createdBy: input.createdBy ?? null,
        createdAt: new Date(),
        latestRunId: null,
        runCount: 0,
      }
      db.insert(jobs).values(row).run()
      return db.select().from(jobs).where(eq(jobs.id, row.id)).get() as JobRow
    },

    addRun(jobId, input) {
      return db.transaction((tx) => {
        const job = tx.select().from(jobs).where(eq(jobs.id, jobId)).get()
        if (!job) throw new EnkakuError('E_NOT_FOUND', 'job_not_found')
        const seq = job.runCount + 1
        const previous = job.latestRunId ? (tx.select().from(jobRuns).where(eq(jobRuns.id, job.latestRunId)).get() ?? null) : null
        const runtimeOverride = input.runtimeOverride !== undefined ? input.runtimeOverride : (previous?.runtimeOverride ?? null)
        const runRow: typeof jobRuns.$inferInsert = {
          id: crypto.randomUUID(),
          jobId: job.id,
          seq,
          trigger: input.trigger,
          status: 'queued',
          deviceId: job.deviceId,
          scriptName: job.scriptName,
          priority: input.priority ?? 0,
          createdAt: new Date(),
          expiresAt: input.expiresAt ?? null,
          notBefore: input.notBefore ?? null,
          batchRepeat: input.batchRepeat ?? null,
          pacedDelayMs: input.pacedDelayMs ?? null,
          maxConcurrent: input.maxConcurrent ?? null,
          runtimeOverride: runtimeOverride as typeof jobRuns.$inferInsert.runtimeOverride,
          infraAttempts: 0,
          resumedFromRunId: input.resumedFromRunId ?? null,
          resumedFromStep: input.resumedFromStep ?? null,
        }
        tx.insert(jobRuns).values(runRow).run()
        tx.update(jobs).set({ latestRunId: runRow.id, runCount: seq }).where(eq(jobs.id, job.id)).run()
        return tx.select().from(jobRuns).where(eq(jobRuns.id, runRow.id)).get() as JobRunRow
      })
    },

    addRunOrNewJob(jobId, params, input) {
      const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get()
      if (!job) throw new EnkakuError('E_NOT_FOUND', 'job_not_found')
      if (jsonKey(job.params) === jsonKey(params)) {
        const run = this.addRun(jobId, input)
        return { job: db.select().from(jobs).where(eq(jobs.id, jobId)).get() as JobRow, run, sameJob: true }
      }
      const newJob = this.createJob({
        kind: job.kind,
        scriptId: job.scriptId,
        workflowName: job.workflowName,
        workflowDoc: job.workflowDoc,
        deviceId: job.deviceId,
        params,
        scriptName: job.scriptName,
        scriptVersion: job.scriptVersion,
        batchId: job.batchId,
        batchSeq: job.batchSeq,
        scheduleId: job.scheduleId,
        createdBy: job.createdBy,
      })
      const run = this.addRun(newJob.id, input)
      return { job: newJob, run, sameJob: false }
    },

    getJob(jobId) {
      return db.select().from(jobs).where(eq(jobs.id, jobId)).get() ?? null
    },

    getRun(runId) {
      return db.select().from(jobRuns).where(eq(jobRuns.id, runId)).get() ?? null
    },

    latestRun(jobId) {
      const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get()
      if (!job?.latestRunId) return null
      return db.select().from(jobRuns).where(eq(jobRuns.id, job.latestRunId)).get() ?? null
    },

    runs(jobId) {
      return db.select().from(jobRuns).where(eq(jobRuns.jobId, jobId)).orderBy(desc(jobRuns.seq)).all()
    },

    latestRuns(jobIds) {
      const out = new Map<string, JobRunRow>()
      if (jobIds.length === 0) return out
      const rows = db.select().from(jobs).where(inArray(jobs.id, jobIds)).all()
      const runIds = rows.map((r) => r.latestRunId).filter((id): id is string => id !== null)
      if (runIds.length === 0) return out
      const runRows = db.select().from(jobRuns).where(inArray(jobRuns.id, runIds)).all()
      const byId = new Map(runRows.map((r) => [r.id, r]))
      for (const row of rows) {
        if (row.latestRunId) {
          const run = byId.get(row.latestRunId)
          if (run) out.set(row.id, run)
        }
      }
      return out
    },

    settle(runId, input) {
      return db.transaction((tx) => {
        const run = tx.select().from(jobRuns).where(and(eq(jobRuns.id, runId), eq(jobRuns.status, 'running'))).get()
        if (!run) return null
        const patch: Partial<typeof jobRuns.$inferInsert> = {
          status: input.status,
          finishedAt: new Date(),
        }
        if (input.result !== undefined) patch.result = input.result as typeof jobRuns.$inferInsert.result
        if (input.error !== undefined) patch.error = input.error
        if (input.failureClass !== undefined) patch.failureClass = input.failureClass
        if (input.errorPhase !== undefined) patch.errorPhase = input.errorPhase
        if (input.peakRssBytes !== undefined) patch.peakRssBytes = input.peakRssBytes
        if (input.resultStatus !== undefined) patch.resultStatus = input.resultStatus
        if (input.resultBytes !== undefined) patch.resultBytes = input.resultBytes
        if (input.resultSummary !== undefined) patch.resultSummary = input.resultSummary
        if (input.resultIssues !== undefined) patch.resultIssues = input.resultIssues as typeof jobRuns.$inferInsert.resultIssues
        tx.update(jobRuns).set(patch).where(eq(jobRuns.id, runId)).run()
        return tx.select().from(jobRuns).where(eq(jobRuns.id, runId)).get() as JobRunRow
      })
    },

    cancelQueuedRun(runId) {
      return db.transaction((tx) => {
        const run = tx.select().from(jobRuns).where(and(eq(jobRuns.id, runId), eq(jobRuns.status, 'queued'))).get()
        if (!run) return null
        tx.update(jobRuns).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(jobRuns.id, runId)).run()
        return tx.select().from(jobRuns).where(eq(jobRuns.id, runId)).get() as JobRunRow
      })
    },

    runsByBatch(batchId) {
      const memberJobs = db.select().from(jobs).where(eq(jobs.batchId, batchId)).all()
      if (memberJobs.length === 0) return []
      const jobIds = memberJobs.map((j) => j.id)
      return db.select().from(jobRuns).where(inArray(jobRuns.jobId, jobIds)).orderBy(desc(jobRuns.seq)).all()
    },

    deleteRuns(runIds) {
      if (runIds.length === 0) return { runs: 0, jobsTouched: [] }
      return db.transaction((tx) => {
        const rows = tx.select().from(jobRuns).where(inArray(jobRuns.id, runIds)).all()
        const jobIds = Array.from(new Set(rows.map((r) => r.jobId)))
        tx.delete(jobRuns).where(inArray(jobRuns.id, runIds)).run()
        for (const jobId of jobIds) {
          const remaining = tx.select().from(jobRuns).where(eq(jobRuns.jobId, jobId)).all()
          const latest = remaining.reduce<JobRunRow | null>((best, r) => (best === null || r.seq > best.seq ? r : best), null)
          tx.update(jobs)
            .set({ latestRunId: latest?.id ?? null, runCount: remaining.length })
            .where(eq(jobs.id, jobId))
            .run()
        }
        return { runs: rows.length, jobsTouched: jobIds }
      })
    },
  }
}
