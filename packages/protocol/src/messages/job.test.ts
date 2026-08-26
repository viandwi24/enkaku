import { describe, expect, test } from 'bun:test'
import { JobResumeRequestSchema, JobResumeResponseSchema, JobTraceEventSchema, JobTraceMessage } from './job'
import { SERVER_MESSAGE_TYPES, ServerMessageSchema, isServerMessageType } from '../index'

// The node TIMELINE's schemas (`JobNodeInfoSchema`, `JobNodesResponseSchema`)
// live in `../api/jobs` and are covered by `../api/jobs.test.ts` — this file
// only owns what `messages/job.ts` still declares.

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

// ---- Plan 128 (M93 — the job trace timeline), step 128.1, §3.3, §4.2 ----

/** One `action` event exactly as the recorder writes one. */
const actionEvent = {
  id: 'evt-1',
  jobId: 'job-1',
  seq: 7,
  atMs: 1_756_000_000_123,
  attempt: 1,
  phase: 'run' as const,
  nodeId: null,
  kind: 'action' as const,
  name: 'find',
  durationMs: 184,
  ok: false,
  errorCode: 'E_FIND_NOT_FOUND',
  meta: { args: { sel: { text: 'Post' } } },
  frameHash: 'a'.repeat(64),
  frameStatus: 'ok' as const,
  uiHash: 'b'.repeat(64),
}

describe('JobTraceEventSchema (plan 128 §4.2)', () => {
  test('an action event round-trips with its duration, outcome and capture hashes intact', () => {
    const parsed = JobTraceEventSchema.parse(actionEvent)
    expect(parsed).toEqual(actionEvent)
  })

  test('a log event carries no duration, no outcome and no capture — every one of those is nullable, not absent', () => {
    const parsed = JobTraceEventSchema.parse({
      ...actionEvent,
      seq: 8,
      kind: 'log',
      name: 'info',
      durationMs: null,
      ok: null,
      errorCode: null,
      meta: { msg: 'starting' },
      frameHash: null,
      frameStatus: null,
      uiHash: null,
    })
    expect(parsed.kind).toBe('log')
    expect(parsed.durationMs).toBeNull()
    expect(parsed.frameStatus).toBeNull()
  })

  test('an event outside any script phase has phase null rather than a made-up phase name', () => {
    expect(JobTraceEventSchema.parse({ ...actionEvent, phase: null }).phase).toBeNull()
    expect(JobTraceEventSchema.safeParse({ ...actionEvent, phase: 'acquire' }).success).toBe(false)
  })

  /**
   * §3.3, and R4 in the plan's risk table: `atMs` is unix MILLISECONDS, the
   * deliberate carve-out from `00-overview.md` §4.2's seconds convention.
   * Two events 180 ms apart must order distinctly — a value in seconds could
   * not represent the difference at all.
   */
  test('atMs resolves sub-second ordering that a seconds timestamp could not represent', () => {
    const a = JobTraceEventSchema.parse({ ...actionEvent, seq: 1, atMs: 1_756_000_000_000 })
    const b = JobTraceEventSchema.parse({ ...actionEvent, seq: 2, atMs: 1_756_000_000_180 })
    expect(b.atMs - a.atMs).toBe(180)
    expect(Math.floor(a.atMs / 1000)).toBe(Math.floor(b.atMs / 1000))
  })

  test('every frameStatus the capture policy can produce is accepted, and nothing else is', () => {
    for (const frameStatus of ['ok', 'skipped-policy', 'skipped-busy', 'failed']) {
      expect(JobTraceEventSchema.safeParse({ ...actionEvent, frameStatus }).success).toBe(true)
    }
    expect(JobTraceEventSchema.safeParse({ ...actionEvent, frameStatus: 'skipped' }).success).toBe(false)
  })

  test('an unknown kind is refused rather than passed through as a string', () => {
    expect(JobTraceEventSchema.safeParse({ ...actionEvent, kind: 'screenshot' }).success).toBe(false)
  })

  test('the workflow node axis is carried, mirroring artifacts.nodeId', () => {
    expect(JobTraceEventSchema.parse({ ...actionEvent, nodeId: 'scroll-fyp' }).nodeId).toBe('scroll-fyp')
  })
})

describe('JobTraceMessage (plan 128 §4.2)', () => {
  test('the live tail wraps one event, mirroring job.log', () => {
    const parsed = JobTraceMessage.parse({ type: 'job.trace', payload: { jobId: 'job-1', event: actionEvent } })
    expect(parsed.type).toBe('job.trace')
    expect(parsed.payload.event.seq).toBe(7)
  })

  test('the event inside the payload is validated, not waved through', () => {
    expect(
      JobTraceMessage.safeParse({ type: 'job.trace', payload: { jobId: 'job-1', event: { ...actionEvent, kind: 'nope' } } }).success,
    ).toBe(false)
  })
})

/**
 * The registration itself, not just the schema. A message declared here and
 * never added to `ServerMessageSchema` typechecks perfectly and then fails at
 * runtime the first time the core broadcasts it — `isServerMessageType` says
 * no, and a plugin cannot subscribe to it. Nothing else in this package would
 * notice, so this is asserted here.
 *
 * This is the only test in the package that reaches for the barrel; it does so
 * deliberately, because the union is declared there and nowhere else.
 */
describe('job.trace is registered in the /ws server→client union (plan 128 §4.2)', () => {
  test('SERVER_MESSAGE_TYPES carries it, beside job.log', () => {
    expect(SERVER_MESSAGE_TYPES).toContain('job.trace')
    expect(SERVER_MESSAGE_TYPES).toContain('job.log')
    expect(isServerMessageType('job.trace')).toBe(true)
  })

  test('the union parses a job.trace envelope and discriminates it correctly', () => {
    const parsed = ServerMessageSchema.parse({ type: 'job.trace', payload: { jobId: 'job-1', event: actionEvent } })
    expect(parsed.type).toBe('job.trace')
    if (parsed.type !== 'job.trace') throw new Error('discriminated to the wrong member')
    expect(parsed.payload.event.frameStatus).toBe('ok')
  })
})
