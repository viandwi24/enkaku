import { describe, expect, test } from 'bun:test'
import { JobDeleteResponseSchema, JobHistoryClearRequestSchema, JobHistoryClearResponseSchema, JobPurgeCountsSchema, JobTraceResponseSchema } from './jobs'

// ---- Plan 128 (M93 — the job trace timeline), step 128.1, §4.3 ----
// Re-keyed from jobId to runId by plan 211 (a step is a job, not a node;
// `JobNodeInfoSchema`/`JobNodesResponseSchema` are deleted with it).

/** One trace event, the shape `GET /api/jobs/:id/runs/:runId/trace` pages over. */
const traceEvent = {
  id: 'evt-1',
  runId: 'run-1',
  seq: 0,
  atMs: 1_756_000_000_000,
  attempt: 1,
  phase: 'run' as const,
  kind: 'action' as const,
  name: 'tap',
  durationMs: 42,
  ok: true,
  errorCode: null,
  meta: { args: { x: 100, y: 220 } },
  frameHash: 'c'.repeat(64),
  frameStatus: 'ok' as const,
  uiHash: null,
}

describe('JobTraceResponseSchema (plan 128 §4.3)', () => {
  test('it is the standard keyset envelope, not a bespoke shape', () => {
    const parsed = JobTraceResponseSchema.parse({
      items: [traceEvent, { ...traceEvent, id: 'evt-2', seq: 1, atMs: 1_756_000_000_180 }],
      nextCursor: '1',
      total: 2,
    })
    expect(parsed.items).toHaveLength(2)
    expect(parsed.nextCursor).toBe('1')
    expect(parsed.total).toBe(2)
  })

  test('a run that recorded nothing is a valid, empty page — never a 404 for that reason', () => {
    const parsed = JobTraceResponseSchema.parse({ items: [], nextCursor: null, total: 0 })
    expect(parsed.items).toEqual([])
    expect(parsed.nextCursor).toBeNull()
  })

  test('the items are validated as trace events, not waved through', () => {
    expect(JobTraceResponseSchema.safeParse({ items: [{ ...traceEvent, kind: 'nope' }], nextCursor: null, total: null }).success).toBe(false)
  })
})

/** The counts every cascade reports (§4.5) — several things go together, so several numbers come back. */
const purgeCounts = { jobs: 1, runs: 1, events: 214, artifacts: 3, traceDirs: 1 }

describe('JobDeleteResponseSchema (plan 128 §4.3, §4.5)', () => {
  test('it echoes the job id and reports what the cascade removed', () => {
    const parsed = JobDeleteResponseSchema.parse({ jobId: 'job-1', deleted: purgeCounts })
    expect(parsed.jobId).toBe('job-1')
    expect(parsed.deleted.events).toBe(214)
    expect(parsed.deleted.traceDirs).toBe(1)
  })

  test('every one of the cascade counts is required — a response that cannot say is not this schema', () => {
    expect(JobDeleteResponseSchema.safeParse({ jobId: 'job-1', deleted: { jobs: 1 } }).success).toBe(false)
    expect(JobPurgeCountsSchema.safeParse({ ...purgeCounts, traceDirs: -1 }).success).toBe(false)
  })
})

describe('JobHistoryClearRequestSchema (plan 128 §4.3)', () => {
  test('an empty body means "every settled job" — the Clear history button\'s own case', () => {
    const parsed = JobHistoryClearRequestSchema.parse({})
    expect(parsed.before).toBeUndefined()
    expect(parsed.deviceId).toBeUndefined()
    expect(parsed.status).toBeUndefined()
  })

  test('the three filters round-trip and AND together', () => {
    const parsed = JobHistoryClearRequestSchema.parse({
      before: 1_756_000_000,
      deviceId: 'dev-1',
      status: ['failed', 'cancelled'],
    })
    expect(parsed.before).toBe(1_756_000_000)
    expect(parsed.status).toEqual(['failed', 'cancelled'])
  })

  test('status is validated against JobStatus, not any string', () => {
    expect(JobHistoryClearRequestSchema.safeParse({ status: ['done'] }).success).toBe(false)
  })
})

describe('JobHistoryClearResponseSchema (plan 128 §4.3)', () => {
  test('it reports the same cascade counts plus what it deliberately left alone', () => {
    const parsed = JobHistoryClearResponseSchema.parse({ deleted: { ...purgeCounts, jobs: 12 }, skipped: 2 })
    expect(parsed.deleted.jobs).toBe(12)
    expect(parsed.skipped).toBe(2)
  })

  test('skipped defaults to 0 — a caller never has to guess whether the field is simply absent', () => {
    expect(JobHistoryClearResponseSchema.parse({ deleted: purgeCounts }).skipped).toBe(0)
  })
})
