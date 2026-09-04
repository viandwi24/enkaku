import { eq, sql } from 'drizzle-orm'
import crypto from 'node:crypto'
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from '../../util/logger'
import type { Db } from '../index'
import { artifacts, jobEvents, jobRuns, jobs, migrationMarkers, schedules } from '../schema'

/**
 * The tag `bun run --cwd packages/core db:generate` produced for this plan
 * (plan 211 §4.1, journal index 70 — the next free one after 205/207/210
 * merged, per plan 200 §2.1). The generated `__new_jobs` INSERT..SELECT was
 * hand-corrected (plan 211 §11 records the discrepancy: it selected columns
 * that do not exist on the pre-migration table) to rename the old `jobs`
 * table to `jobs_pre_211` instead of dropping it, and to leave `job_nodes`,
 * `job_resumes` and `schedule_runs` in place — this step is what finally
 * drops all four, after reading every row it needs from them.
 */
export const JOBS_TO_RUNS_TAG = '0070_robust_nightshade'
export const MARKER_ID = 'jobs-to-runs-211'

export interface JobsToRunsReport {
  ranAt: string
  jobs: number
  runs: number
  events: number
  artifacts: number
  traceDirs: number
  artifactDirs: number
  /** `<jobId>` of every resume chain folded into the earliest job of the chain (MVP 14 §3). */
  resumeChainsFolded: string[]
  /** `schedule_runs` rows dropped because their batch or job no longer exists (MVP 14 §3). */
  scheduleRunsDropped: number
  /** Directories that could not be renamed; their rows still point at the run. */
  unmovedDirs: string[]
}

interface RawJobPre211Row {
  id: string
  script_id: string | null
  device_id: string
  params: string | null
  priority: number | null
  status: string | null
  heartbeat_expires_at: number | null
  result: string | null
  error: string | null
  created_at: number | null
  started_at: number | null
  finished_at: number | null
  batch_id: string | null
  batch_seq: number | null
  expires_at: number | null
  not_before: number | null
  batch_repeat: number | null
  paced_delay_ms: number | null
  failure_class: string | null
  error_phase: string | null
  infra_attempts: number | null
  script_name: string | null
  script_version: string | null
  workflow_doc: string | null
  triggered_by_job_id: string | null
  root_job_id: string | null
  depth: number | null
  trigger_key: string | null
  peak_rss_bytes: number | null
  max_concurrent: number | null
  runtime_override: string | null
  result_status: string | null
  result_bytes: number | null
  result_summary: string | null
  result_issues: string | null
}

interface RawJobResumeRow {
  job_id: string
  resumed_from_job_id: string
  resumed_from_node: string
  created_at: number
}

interface RawScheduleRunRow {
  id: string
  schedule_id: string
  outcome: string
  batch_id: string | null
  detail: string | null
  fired_at: number | null
  due_at: number
}

function parseJson(text: string | null): unknown {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * The boot data step (plan 211 §3.2 decision 13, §4.10): copies every job's
 * execution columns into one `job_runs` row at `seq 1`, folds resume chains
 * (MVP 14 §3), re-keys `job_events`/`artifacts` from job to run, adopts each
 * schedule's last dispatched batch and outcome, and finally drops the four
 * tables this plan replaces. Runs once, guarded by `migration_markers`.
 */
export function migrateJobsToRuns(db: Db, deps: { log: Logger; dataDir: string }): JobsToRunsReport | null {
  const marker = db.select().from(migrationMarkers).where(eq(migrationMarkers.id, MARKER_ID)).get()
  if (marker) return null

  /** Every pre-migration job's run id, immutable — the directory-rename and re-key passes both need the ORIGINAL job id, even for a job later folded into a resume chain's root. */
  const runIdByJobId = new Map<string, string>()
  /** Job ids that still exist as their own `jobs` row after resume-chain folding — what the report's `jobs` count reflects. */
  const survivingJobIds = new Set<string>()
  let eventsRekeyed = 0
  let artifactsRekeyed = 0
  const resumeChainsFolded: string[] = []
  let scheduleRunsDropped = 0

  db.transaction((tx) => {
    const oldJobs = tx.all<RawJobPre211Row>(
      sql`SELECT * FROM jobs_pre_211 ORDER BY created_at ASC`,
    )

    for (const row of oldJobs) {
      const runId = crypto.randomUUID()
      runIdByJobId.set(row.id, runId)
      survivingJobIds.add(row.id)
      tx.insert(jobRuns)
        .values({
          id: runId,
          jobId: row.id,
          seq: 1,
          trigger: row.batch_id ? 'batch' : 'manual',
          status: (row.status ?? 'queued') as (typeof jobRuns.$inferInsert)['status'],
          deviceId: row.device_id,
          scriptName: row.script_name,
          priority: row.priority ?? 0,
          createdAt: row.created_at ? new Date(row.created_at * 1000) : new Date(),
          startedAt: row.started_at ? new Date(row.started_at * 1000) : null,
          finishedAt: row.finished_at ? new Date(row.finished_at * 1000) : null,
          heartbeatExpiresAt: row.heartbeat_expires_at,
          expiresAt: row.expires_at,
          notBefore: row.not_before,
          batchRepeat: row.batch_repeat,
          pacedDelayMs: row.paced_delay_ms,
          result: parseJson(row.result) as (typeof jobRuns.$inferInsert)['result'],
          error: row.error,
          failureClass: row.failure_class,
          errorPhase: row.error_phase,
          infraAttempts: row.infra_attempts ?? 0,
          peakRssBytes: row.peak_rss_bytes,
          maxConcurrent: row.max_concurrent,
          runtimeOverride: parseJson(row.runtime_override) as (typeof jobRuns.$inferInsert)['runtimeOverride'],
          resultStatus: row.result_status,
          resultBytes: row.result_bytes,
          resultSummary: row.result_summary,
          resultIssues: parseJson(row.result_issues) as (typeof jobRuns.$inferInsert)['resultIssues'],
        })
        .run()
      tx.update(jobs).set({ latestRunId: runId, runCount: 1 }).where(eq(jobs.id, row.id)).run()
    }

    // ---- resume chains (MVP 14 §3) ----
    const resumeRows = tx.all<RawJobResumeRow>(sql`SELECT * FROM job_resumes ORDER BY created_at ASC`)
    if (resumeRows.length > 0) {
      const resumedFrom = new Map(resumeRows.map((r) => [r.job_id, r.resumed_from_job_id]))
      const isTarget = new Set(resumeRows.map((r) => r.job_id))

      function rootOf(jobId: string): string {
        let cur = jobId
        const seen = new Set<string>()
        while (resumedFrom.has(cur) && !seen.has(cur)) {
          seen.add(cur)
          cur = resumedFrom.get(cur) as string
        }
        return cur
      }

      // group every job that is part of some chain by its root
      const chains = new Map<string, string[]>()
      for (const jobId of new Set([...resumeRows.map((r) => r.job_id), ...resumeRows.map((r) => r.resumed_from_job_id)])) {
        const root = rootOf(jobId)
        const list = chains.get(root) ?? []
        if (!list.includes(jobId)) list.push(jobId)
        chains.set(root, list)
      }

      for (const [root, members] of chains) {
        if (!isTarget.has(root) && members.length <= 1) continue // nothing to fold
        // order the chain oldest to newest by created_at of the underlying job row
        const withCreated = members
          .map((id) => ({ id, row: oldJobs.find((j) => j.id === id) }))
          .filter((m): m is { id: string; row: RawJobPre211Row } => m.row !== undefined)
          .sort((a, b) => (a.row.created_at ?? 0) - (b.row.created_at ?? 0))
        if (withCreated.length <= 1) continue

        let previousRunId = runIdByJobId.get(root) as string
        let seq = 1
        for (const member of withCreated) {
          if (member.id === root) continue
          seq += 1
          const memberRunId = runIdByJobId.get(member.id)
          if (!memberRunId) continue
          tx.update(jobRuns)
            .set({ jobId: root, seq, trigger: 'resume', resumedFromRunId: previousRunId, resumedFromStep: null })
            .where(eq(jobRuns.id, memberRunId))
            .run()
          previousRunId = memberRunId
          tx.delete(jobs).where(eq(jobs.id, member.id)).run()
          survivingJobIds.delete(member.id)
        }
        tx.update(jobs).set({ latestRunId: previousRunId, runCount: seq }).where(eq(jobs.id, root)).run()
        resumeChainsFolded.push(root)
      }
    }

    // ---- workflow rows: kind = 'workflow' (MVP 14 §3 step 4) ----
    const workflowJobs = tx.select().from(jobs).where(sql`${jobs.workflowDoc} is not null`).all()
    for (const job of workflowJobs) {
      tx.update(jobs).set({ kind: 'workflow', workflowName: job.scriptName, scriptId: null }).where(eq(jobs.id, job.id)).run()
    }
    const jobNodesCount = tx.get<{ n: number }>(sql`SELECT COUNT(*) as n FROM job_nodes`)?.n ?? 0

    // ---- job_events / artifacts: run_id currently holds the OLD JOB id ----
    const eventRows = tx.all<{ id: string; run_id: string }>(sql`SELECT id, run_id FROM job_events`)
    for (const ev of eventRows) {
      const runId = runIdByJobId.get(ev.run_id)
      if (runId) {
        tx.update(jobEvents).set({ runId }).where(eq(jobEvents.id, ev.id)).run()
        eventsRekeyed++
      } else {
        tx.delete(jobEvents).where(eq(jobEvents.id, ev.id)).run()
      }
    }

    const artifactRows = tx.all<{ id: string; run_id: string | null }>(sql`SELECT id, run_id FROM artifacts WHERE run_id IS NOT NULL`)
    for (const art of artifactRows) {
      if (!art.run_id) continue
      const runId = runIdByJobId.get(art.run_id)
      if (runId) {
        tx.update(artifacts).set({ runId }).where(eq(artifacts.id, art.id)).run()
        artifactsRekeyed++
      } else {
        tx.delete(artifacts).where(eq(artifacts.id, art.id)).run()
      }
    }

    // ---- schedules adopt their last dispatched batch and outcome ----
    const scheduleRunRows = tx.all<RawScheduleRunRow>(sql`SELECT * FROM schedule_runs ORDER BY due_at ASC`)
    const byScheduleNewest = new Map<string, RawScheduleRunRow>()
    for (const r of scheduleRunRows) {
      byScheduleNewest.set(r.schedule_id, r)
    }
    for (const [scheduleId, r] of byScheduleNewest) {
      if (r.outcome === 'dispatched' && r.batch_id) {
        const schedRow = tx.select().from(schedules).where(eq(schedules.id, scheduleId)).get()
        if (schedRow && !schedRow.batchId) {
          tx.update(schedules).set({ batchId: r.batch_id }).where(eq(schedules.id, scheduleId)).run()
        }
      }
      tx.update(schedules).set({ lastFireOutcome: r.outcome, lastFireDetail: r.detail }).where(eq(schedules.id, scheduleId)).run()
    }
    scheduleRunsDropped = scheduleRunRows.length

    if (jobNodesCount > 0) {
      deps.log.warn(`jobs-to-runs: ${jobNodesCount} job_nodes row(s) recorded node executions inside one process and have no job to point at; dropped, not converted`)
    }

    // ---- drop the four tables this plan replaces ----
    tx.run(sql`DROP TABLE job_nodes`)
    tx.run(sql`DROP TABLE job_resumes`)
    tx.run(sql`DROP TABLE schedule_runs`)
    tx.run(sql`DROP TABLE jobs_pre_211`)

    tx.insert(migrationMarkers).values({ id: MARKER_ID, appliedAt: new Date() }).run()
  })

  // ---- directory renames, after commit (§4.10 step 8: a leaked directory is
  // strictly better than an aborted migration) ----
  const unmovedDirs: string[] = []
  let traceDirs = 0
  let artifactDirs = 0
  for (const [jobId, runId] of runIdByJobId) {
    const traceFrom = join(deps.dataDir, 'traces', jobId)
    const traceTo = join(deps.dataDir, 'traces', runId)
    if (existsSync(traceFrom)) {
      try {
        renameSync(traceFrom, traceTo)
        traceDirs++
      } catch {
        unmovedDirs.push(traceFrom)
      }
    }
    const artifactFrom = join(deps.dataDir, 'artifacts', jobId)
    const artifactTo = join(deps.dataDir, 'artifacts', runId)
    if (existsSync(artifactFrom)) {
      try {
        renameSync(artifactFrom, artifactTo)
        artifactDirs++
        db.run(sql`UPDATE artifacts SET path = replace(path, ${'artifacts/' + jobId + '/'}, ${'artifacts/' + runId + '/'}) WHERE run_id = ${runId}`)
      } catch {
        unmovedDirs.push(artifactFrom)
      }
    }
  }

  const report: JobsToRunsReport = {
    ranAt: new Date().toISOString(),
    jobs: survivingJobIds.size,
    runs: runIdByJobId.size,
    events: eventsRekeyed,
    artifacts: artifactsRekeyed,
    traceDirs,
    artifactDirs,
    resumeChainsFolded,
    scheduleRunsDropped,
    unmovedDirs,
  }

  deps.log.info(
    `jobs-to-runs: ${report.jobs} job(s) now hold ${report.runs} run(s); re-keyed ${report.events} trace event(s) and ${report.artifacts} artifact(s); moved ${report.traceDirs} trace and ${report.artifactDirs} artifact directories`,
  )
  if (resumeChainsFolded.length > 0) {
    deps.log.warn(`jobs-to-runs: folded resume chain(s) rooted at ${resumeChainsFolded.join(', ')}`)
  }
  if (scheduleRunsDropped > 0) {
    deps.log.warn(`${scheduleRunsDropped} schedule fire record(s) were dropped: a schedule's history is now its jobs' runs (docs/mvp/14-jobs-and-runs.md §3)`)
  }
  if (unmovedDirs.length > 0) {
    deps.log.warn(`jobs-to-runs: could not move ${unmovedDirs.join(', ')}; the rows already point at the run`)
  }

  return report
}
