import type { JobStatus, JobSummary, ResultStatus } from '@enkaku/protocol'
import { and, asc, desc, eq } from 'drizzle-orm'
import type { Db } from '../db'
import { jobRuns, jobs, type JobRow, type JobRunRow } from '../db/schema'
import { decodeCursor, encodeCursor } from '../api/pagination'
import type { JobStore } from '../queue/job-store'
import type { RunStore } from './runs/store'

/**
 * A running script's own view of the queue (plan 80, re-keyed to runs by
 * plan 211). Every method takes the CALLER's own `JobRow` as its first
 * argument rather than a `deviceId` — the scope is derived, never passed, so
 * there is no argument that can widen it to another device (§3.2,
 * criterion 2).
 */
export interface ScriptJobsDeps {
  jobStore: JobStore
  runs: RunStore
  db: Db
}

export interface ScriptJobsListResult {
  items: JobSummary[]
  nextCursor: string | null
  total: number
}

export type ResultOfOutcome = { ok: true; result: unknown } | { ok: false; reason: 'not-found' | 'foreign-namespace' | 'not-finished' }

export interface ScriptJobsReader {
  list(job: JobRow, q: { status?: JobStatus; limit: number; cursor?: string | null }): ScriptJobsListResult
  /** The most recent job on this device that finished before this one started, or null (criteria 6, 7). */
  previous(job: JobRow): JobSummary | null
  /** Jobs still queued on this device, in claim order — excludes the caller, which cannot be `queued` while calling this (criterion 8). */
  queuedAfter(job: JobRow, limit: number): JobSummary[]
  resultOf(job: JobRow, targetJobId: string): ResultOfOutcome
}

const MAX_LIMIT = 100

const toSec = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null)

const TERMINAL_STATUSES = new Set(['success', 'failed', 'cancelled', 'expired'])

function toSummary(row: JobRow, run: JobRunRow | null, names: Map<string, { name: string; version: string }>): JobSummary {
  const script = row.scriptId ? names.get(row.scriptId) : undefined
  const startedAt = run?.startedAt ?? null
  const finishedAt = run?.finishedAt ?? null
  return {
    jobId: row.id,
    scriptName: row.scriptName ?? script?.name ?? null,
    scriptVersion: row.scriptVersion ?? script?.version ?? null,
    origin: null,
    pluginName: null,
    status: (run?.status ?? 'queued') as JobStatus,
    createdAt: toSec(row.createdAt) ?? 0,
    startedAt: toSec(startedAt),
    finishedAt: toSec(finishedAt),
    durationMs: startedAt && finishedAt ? finishedAt.getTime() - startedAt.getTime() : null,
    failureClass: run?.failureClass ?? null,
    errorPhase: run?.errorPhase ?? null,
    error: run?.error ?? null,
    triggeredByJobId: row.triggeredByJobId ?? null,
    rootJobId: row.rootJobId ?? null,
    depth: row.depth ?? null,
    resultStatus: (run?.resultStatus ?? null) as ResultStatus | null,
  }
}

export function createScriptJobsReader(deps: ScriptJobsDeps): ScriptJobsReader {
  const { jobStore, runs, db } = deps

  return {
    list(job, q) {
      const limit = Math.min(Math.max(1, q.limit), MAX_LIMIT)
      const cursor = q.cursor ? decodeCursor(q.cursor) : null
      const page = jobStore.list({
        deviceId: job.deviceId,
        ...(q.status ? { status: q.status } : {}),
        limit,
        cursor,
      })
      const scriptIds = page.rows.map((r) => r.scriptId).filter((id): id is string => id !== null)
      const names = jobStore.scriptNames(scriptIds)
      const latestRuns = runs.latestRuns(page.rows.map((r) => r.id))
      const items = page.rows.map((r) => toSummary(r, latestRuns.get(r.id) ?? null, names))
      const nextCursor = page.nextCursor ? encodeCursor(page.nextCursor.sortValue, page.nextCursor.id) : null
      return { items, nextCursor, total: page.total }
    },

    previous(job) {
      const ownRun = runs.latestRun(job.id)
      if (!ownRun?.startedAt) return null
      const row = db
        .select({ job: jobs, run: jobRuns })
        .from(jobRuns)
        .innerJoin(jobs, eq(jobs.id, jobRuns.jobId))
        .where(and(eq(jobRuns.deviceId, job.deviceId), eq(jobRuns.status, 'success')))
        .orderBy(desc(jobRuns.finishedAt), desc(jobRuns.id))
        .all()
        .find((r) => r.run.finishedAt && ownRun.startedAt && r.run.finishedAt < ownRun.startedAt && r.job.id !== job.id)
      if (!row) return null
      const names = row.job.scriptId ? jobStore.scriptNames([row.job.scriptId]) : new Map()
      return toSummary(row.job, row.run, names)
    },

    queuedAfter(job, limit) {
      const lim = Math.min(Math.max(1, limit), MAX_LIMIT)
      const rows = db
        .select({ job: jobs, run: jobRuns })
        .from(jobRuns)
        .innerJoin(jobs, eq(jobs.id, jobRuns.jobId))
        .where(and(eq(jobRuns.deviceId, job.deviceId), eq(jobRuns.status, 'queued')))
        .orderBy(desc(jobRuns.priority), asc(jobRuns.createdAt))
        .limit(lim)
        .all()
      const scriptIds = rows.map((r) => r.job.scriptId).filter((id): id is string => id !== null)
      const names = jobStore.scriptNames(scriptIds)
      return rows.map((r) => toSummary(r.job, r.run, names))
    },

    resultOf(job, targetJobId) {
      const target = jobStore.get(targetJobId)
      if (!target) return { ok: false, reason: 'not-found' }
      const targetRun = runs.latestRun(targetJobId)
      if (!targetRun?.finishedAt || !TERMINAL_STATUSES.has(targetRun.status)) {
        return { ok: false, reason: 'not-finished' }
      }
      const scriptIds = [job.scriptId, target.scriptId].filter((id): id is string => id !== null)
      const names = jobStore.scriptNames(scriptIds)
      const callerName = job.scriptName ?? (job.scriptId ? names.get(job.scriptId)?.name : undefined)
      const targetName = target.scriptName ?? (target.scriptId ? names.get(target.scriptId)?.name : undefined)
      if (!callerName || !targetName || callerName !== targetName) {
        return { ok: false, reason: 'foreign-namespace' }
      }
      return { ok: true, result: targetRun.result ?? null }
    },
  }
}
