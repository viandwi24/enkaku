import { describe, expect, test } from 'bun:test'
import {
  JobDeleteResponseSchema,
  JobHistoryClearRequestSchema,
  JobHistoryClearResponseSchema,
  JobNodeInfoSchema,
  JobNodesResponseSchema,
  JobPurgeCountsSchema,
  JobTraceResponseSchema,
} from './jobs'

/** A script node exactly as `job_nodes` stores one, projected for the API. */
const scriptNode = {
  seq: 0,
  nodeId: 'scroll-fyp',
  kind: 'script' as const,
  scriptId: '9f2c1b7e-0000-4000-8000-000000000001',
  scriptName: 'tiktok/auto-scroll',
  scriptVersion: '1.4.0',
  status: 'success' as const,
  duration: { startedAt: 1_754_000_000, finishedAt: 1_754_000_042, elapsedMs: 42_000 },
  attempts: { current: 1, total: 3, lastError: null },
  output: { value: { scrolled: 27 }, truncated: null, error: null, verdict: null },
  resumedFromJobId: null,
  resumedFromNode: null,
}

describe('JobNodeInfoSchema (plan 99 §4.9)', () => {
  test('parses a completed script node', () => {
    const parsed = JobNodeInfoSchema.parse(scriptNode)
    expect(parsed.scriptVersion).toBe('1.4.0')
    expect(parsed.attempts.current).toBe(1)
  })

  test('a gate node carries no script — every script column is null, not absent-and-invalid', () => {
    const gate = {
      ...scriptNode,
      seq: 1,
      nodeId: 'enough-scrolled',
      kind: 'gate' as const,
      scriptId: null,
      scriptName: null,
      scriptVersion: null,
      output: { value: null, truncated: null, error: null, verdict: { branch: 'then', matched: true } },
    }
    const parsed = JobNodeInfoSchema.parse(gate)
    expect(parsed.scriptId).toBeNull()
    expect(parsed.output.verdict).toEqual({ branch: 'then', matched: true })
  })

  test('two executions of the same node differ by seq, never by nodeId (a loop)', () => {
    const first = JobNodeInfoSchema.parse(scriptNode)
    const second = JobNodeInfoSchema.parse({ ...scriptNode, seq: 2 })
    expect(first.nodeId).toBe(second.nodeId)
    expect(first.seq).not.toBe(second.seq)
  })

  test('timestamps are unix seconds — a Date instance is rejected, because JSON has no date type', () => {
    const withDate = { ...scriptNode, duration: { ...scriptNode.duration, startedAt: new Date() } }
    expect(JobNodeInfoSchema.safeParse(withDate).success).toBe(false)
  })

  test('a skipped node has no timing at all', () => {
    const skipped = {
      ...scriptNode,
      seq: 3,
      status: 'skipped-on-resume' as const,
      duration: { startedAt: null, finishedAt: null, elapsedMs: null },
      attempts: { current: 0, total: null, lastError: null },
      output: { value: null, truncated: null, error: null, verdict: null },
    }
    expect(JobNodeInfoSchema.parse(skipped).duration.elapsedMs).toBeNull()
  })

  test('a failed node reports code and message', () => {
    const failed = {
      ...scriptNode,
      status: 'failed' as const,
      attempts: { current: 3, total: 3, lastError: { code: 'E_FIND_TIMEOUT', message: 'no match within 20s' } },
      output: { value: null, truncated: null, error: { code: null, message: 'no match within 20s' }, verdict: null },
    }
    const parsed = JobNodeInfoSchema.parse(failed)
    expect(parsed.attempts.lastError?.code).toBe('E_FIND_TIMEOUT')
    expect(parsed.output.error?.code).toBeNull()
  })

  test('an unknown status is refused rather than passed through as a string', () => {
    expect(JobNodeInfoSchema.safeParse({ ...scriptNode, status: 'completed' }).success).toBe(false)
  })
})

describe('JobNodesResponseSchema', () => {
  test('an unfinished job reports finalized: false', () => {
    const parsed = JobNodesResponseSchema.parse({
      items: [scriptNode, { ...scriptNode, seq: 1, status: 'running' }],
      finalized: false,
    })
    expect(parsed.items).toHaveLength(2)
    expect(parsed.finalized).toBe(false)
  })

  test('a job with no node rows is a valid, empty timeline', () => {
    expect(JobNodesResponseSchema.parse({ items: [], finalized: true }).items).toEqual([])
  })

  /**
   * The envelope keys the timeline is `{ items, finalized }`, never
   * `{ jobId, nodes, finalized }`: a second, differently-shaped
   * `JobNodesResponseSchema` once existed in `../messages/job` and won the
   * barrel's name resolution, which broke `packages/core`'s typecheck and
   * pushed Studio into declaring a local copy. `export-uniqueness.test.ts`
   * stops the duplicate coming back; this pins the surviving shape.
   */
  test('the caller already has the job id from the URL — a { jobId, nodes } envelope is not this schema', () => {
    expect(JobNodesResponseSchema.safeParse({ jobId: 'job-1', nodes: [], finalized: true }).success).toBe(false)
  })
})

// ---- Plan 128 (M93 — the job trace timeline), step 128.1, §4.3 ----

/** One trace event, the shape `GET /api/jobs/:id/trace` pages over. */
const traceEvent = {
  id: 'evt-1',
  jobId: 'job-1',
  seq: 0,
  atMs: 1_756_000_000_000,
  attempt: 1,
  phase: 'run' as const,
  nodeId: null,
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

  test('a job that recorded nothing is a valid, empty page — never a 404 for that reason', () => {
    const parsed = JobTraceResponseSchema.parse({ items: [], nextCursor: null, total: 0 })
    expect(parsed.items).toEqual([])
    expect(parsed.nextCursor).toBeNull()
  })

  test('the items are validated as trace events, not waved through', () => {
    expect(JobTraceResponseSchema.safeParse({ items: [{ ...traceEvent, kind: 'nope' }], nextCursor: null, total: null }).success).toBe(false)
  })
})

/** The counts every cascade reports (§4.5) — five things go together, so five numbers come back. */
const purgeCounts = { jobs: 1, events: 214, artifacts: 3, nodes: 0, traceDirs: 1 }

describe('JobDeleteResponseSchema (plan 128 §4.3, §4.5)', () => {
  test('it echoes the job id and reports what the cascade removed', () => {
    const parsed = JobDeleteResponseSchema.parse({ jobId: 'job-1', deleted: purgeCounts })
    expect(parsed.jobId).toBe('job-1')
    expect(parsed.deleted.events).toBe(214)
    expect(parsed.deleted.traceDirs).toBe(1)
  })

  test('every one of the five cascade counts is required — a response that cannot say is not this schema', () => {
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
