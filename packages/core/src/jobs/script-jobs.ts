import type { JobStatus, JobSummary, ResultStatus } from '@enkaku/protocol'
import { and, asc, desc, eq, isNotNull, lt, ne } from 'drizzle-orm'
import type { Db } from '../db'
import { jobs, type JobRow } from '../db/schema'
import { decodeCursor, encodeCursor } from '../api/pagination'
import type { JobStore } from '../queue/job-store'

/**
 * A running script's own view of the queue (plan 80). Every method takes the
 * CALLER's own `JobRow` as its first argument rather than a `deviceId` — the
 * scope is derived, never passed, so there is no argument that can widen it
 * to another device (§3.2, criterion 2).
 *
 * `list` is the existing `JobStore.list` (plan 30's keyset paging) with
 * `deviceId` pinned to `job.deviceId` — no second query engine (§3.1).
 * `previous`/`queuedAfter` are narrow, single-purpose reads directly against
 * the `jobs` table for the one question each answers; neither is a second
 * generic list.
 */
export interface ScriptJobsDeps {
  jobStore: JobStore
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

function toSummary(row: JobRow, names: Map<string, { name: string; version: string }>): JobSummary {
  const script = names.get(row.scriptId)
  const startedAt = row.startedAt
  const finishedAt = row.finishedAt
  return {
    jobId: row.id,
    // Plan 82 §3.4 denormalised `scriptName`/`scriptVersion` onto the row
    // itself; a row written before that column existed falls back to the
    // `scriptNames()` lookup, exactly as JobSummary's own doc comment says.
    scriptName: row.scriptName ?? script?.name ?? null,
    scriptVersion: row.scriptVersion ?? script?.version ?? null,
    // Plan 82 §3.4 has not landed a column to read these from yet — always
    // null until it does (see JobSummarySchema's own comment).
    origin: null,
    pluginName: null,
    status: (row.status ?? 'queued') as JobStatus,
    createdAt: toSec(row.createdAt) ?? 0,
    startedAt: toSec(startedAt),
    finishedAt: toSec(finishedAt),
    durationMs: startedAt && finishedAt ? finishedAt.getTime() - startedAt.getTime() : null,
    failureClass: row.failureClass ?? null,
    errorPhase: row.errorPhase ?? null,
    error: row.error ?? null,
    // Plan 81 §4.1 lineage — null for a job nothing triggered (a
    // pre-plan-81 row, or one a human/schedule/batch created directly).
    triggeredByJobId: row.triggeredByJobId ?? null,
    rootJobId: row.rootJobId ?? null,
    depth: row.depth ?? null,
    // Plan 97 §4.6 — the verdict ONLY (never the value, never the summary
    // text): plan 80 §3.3's rule that a neighbouring script reads a result
    // through `resultOf()` and nowhere else stands.
    resultStatus: (row.resultStatus ?? null) as ResultStatus | null,
  }
}

export function createScriptJobsReader(deps: ScriptJobsDeps): ScriptJobsReader {
  const { jobStore, db } = deps

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
      const names = jobStore.scriptNames(page.rows.map((r) => r.scriptId))
      const items = page.rows.map((r) => toSummary(r, names))
      const nextCursor = page.nextCursor ? encodeCursor(page.nextCursor.sortValue, page.nextCursor.id) : null
      return { items, nextCursor, total: page.total }
    },

    previous(job) {
      if (!job.startedAt) return null
      const row = db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.deviceId, job.deviceId),
            isNotNull(jobs.finishedAt),
            lt(jobs.finishedAt, job.startedAt),
            ne(jobs.id, job.id),
          ),
        )
        .orderBy(desc(jobs.finishedAt), desc(jobs.id))
        .limit(1)
        .get()
      if (!row) return null
      const names = jobStore.scriptNames([row.scriptId])
      return toSummary(row, names)
    },

    queuedAfter(job, limit) {
      const lim = Math.min(Math.max(1, limit), MAX_LIMIT)
      // Same ordering `JobStore.claimNext` uses (plan 20 §3.3, §4.2):
      // `priority DESC, createdAt ASC, batchSeq ASC` — "claim order" means
      // exactly this, not `createdAt` alone.
      const rows = db
        .select()
        .from(jobs)
        .where(and(eq(jobs.deviceId, job.deviceId), eq(jobs.status, 'queued')))
        .orderBy(desc(jobs.priority), asc(jobs.createdAt), asc(jobs.batchSeq))
        .limit(lim)
        .all()
      const names = jobStore.scriptNames(rows.map((r) => r.scriptId))
      return rows.map((r) => toSummary(r, names))
    },

    resultOf(job, targetJobId) {
      const target = jobStore.get(targetJobId)
      if (!target) return { ok: false, reason: 'not-found' }
      if (!target.finishedAt || !TERMINAL_STATUSES.has(target.status ?? '')) {
        return { ok: false, reason: 'not-finished' }
      }
      // "Same namespace" (§3.3): the same script, by name — the closest
      // available analogue to plan 79's kv namespace until plan 81/82 give
      // jobs a real plugin/dev-slot identity. Prefer the row's own
      // denormalised `scriptName` (plan 82 §3.4) and fall back to the
      // `scriptNames()` join for a row written before that column existed —
      // the same fallback `toSummary` uses. A caller whose own script cannot
      // be named at all (an internal/dummy job with no `scripts` row) can
      // never match anything, which is the safe default.
      const names = jobStore.scriptNames([job.scriptId, target.scriptId])
      const callerName = job.scriptName ?? names.get(job.scriptId)?.name
      const targetName = target.scriptName ?? names.get(target.scriptId)?.name
      if (!callerName || !targetName || callerName !== targetName) {
        return { ok: false, reason: 'foreign-namespace' }
      }
      return { ok: true, result: target.result ?? null }
    },
  }
}
