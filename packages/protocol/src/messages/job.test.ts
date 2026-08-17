import { describe, expect, test } from 'bun:test'
import { JobResumeRequestSchema, JobResumeResponseSchema } from './job'

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
