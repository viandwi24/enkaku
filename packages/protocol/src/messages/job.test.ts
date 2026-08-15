import { describe, expect, test } from 'bun:test'
import {
  JobNodeSchema,
  JobNodesResponseSchema,
  JobResumeRequestSchema,
  JobResumeResponseSchema,
} from './job'

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
  output: { value: { scrolled: 27 }, truncated: null, error: null, verdict: undefined },
  resumedFromJobId: null,
  resumedFromNode: null,
}

describe('JobNodeSchema (plan 99 §4.9)', () => {
  test('parses a completed script node', () => {
    const parsed = JobNodeSchema.parse(scriptNode)
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
      output: { value: undefined, truncated: null, error: null, verdict: { branch: 'then', matched: true } },
    }
    const parsed = JobNodeSchema.parse(gate)
    expect(parsed.scriptId).toBeNull()
    expect(parsed.output.verdict).toEqual({ branch: 'then', matched: true })
  })

  test('two executions of the same node differ by seq, never by nodeId (a loop)', () => {
    const first = JobNodeSchema.parse(scriptNode)
    const second = JobNodeSchema.parse({ ...scriptNode, seq: 2 })
    expect(first.nodeId).toBe(second.nodeId)
    expect(first.seq).not.toBe(second.seq)
  })

  test('timestamps are unix seconds — a Date instance is rejected, because JSON has no date type', () => {
    const withDate = { ...scriptNode, duration: { ...scriptNode.duration, startedAt: new Date() } }
    expect(JobNodeSchema.safeParse(withDate).success).toBe(false)
  })

  test('a skipped node has no timing at all', () => {
    const skipped = {
      ...scriptNode,
      seq: 3,
      status: 'skipped-on-resume' as const,
      duration: { startedAt: null, finishedAt: null, elapsedMs: null },
      attempts: { current: 0, total: null, lastError: null },
      output: { value: undefined, truncated: null, error: null, verdict: undefined },
    }
    expect(JobNodeSchema.parse(skipped).duration.elapsedMs).toBeNull()
  })

  test('a failed node reports code and message', () => {
    const failed = {
      ...scriptNode,
      status: 'failed' as const,
      attempts: { current: 3, total: 3, lastError: { code: 'E_FIND_TIMEOUT', message: 'no match within 20s' } },
      output: { value: undefined, truncated: null, error: { code: null, message: 'no match within 20s' }, verdict: undefined },
    }
    const parsed = JobNodeSchema.parse(failed)
    expect(parsed.attempts.lastError?.code).toBe('E_FIND_TIMEOUT')
    expect(parsed.output.error?.code).toBeNull()
  })

  test('an unknown status is refused rather than passed through as a string', () => {
    expect(JobNodeSchema.safeParse({ ...scriptNode, status: 'completed' }).success).toBe(false)
  })
})

describe('JobNodesResponseSchema', () => {
  test('an unfinished job reports finalized: false', () => {
    const parsed = JobNodesResponseSchema.parse({
      jobId: 'job-1',
      nodes: [scriptNode, { ...scriptNode, seq: 1, status: 'running' }],
      finalized: false,
    })
    expect(parsed.nodes).toHaveLength(2)
    expect(parsed.finalized).toBe(false)
  })

  test('a job with no node rows is a valid, empty timeline', () => {
    expect(JobNodesResponseSchema.parse({ jobId: 'job-1', nodes: [], finalized: true }).nodes).toEqual([])
  })
})

describe('resume (plan 99 §3.5)', () => {
  test('fromNode is optional — omitting it means "the first node that did not succeed"', () => {
    expect(JobResumeRequestSchema.parse({}).fromNode).toBeUndefined()
    expect(JobResumeRequestSchema.parse({ fromNode: 'report' }).fromNode).toBe('report')
  })

  test('the response echoes the node the server actually resolved', () => {
    const parsed = JobResumeResponseSchema.parse({
      newJobId: 'job-2',
      resumedFromJobId: 'job-1',
      resumedFromNode: 'scroll-fyp',
      status: 'queued',
    })
    expect(parsed.resumedFromNode).toBe('scroll-fyp')
  })

  test('a status outside the three the route can return is refused', () => {
    expect(
      JobResumeResponseSchema.safeParse({
        newJobId: 'job-2',
        resumedFromJobId: 'job-1',
        resumedFromNode: 'scroll-fyp',
        status: 'success',
      }).success,
    ).toBe(false)
  })
})
