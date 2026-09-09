import { describe, expect, test } from 'bun:test'
import { findRedundantSchedules, OnApprovalRequiredSchema, ScheduleInfoSchema, ScheduleThreadModeSchema, ScheduleWorkTargetSchema, type ScheduleInfo } from './schedule'

/**
 * The schedule work-target discriminated union (plan 68 §3.1, §4.1) — a
 * schedule targets a script OR an agent, never both, never neither. Test
 * plan §7: "Unit: target discriminated union parsing."
 */
describe('ScheduleWorkTargetSchema', () => {
  test('parses a script target with a valid ref', () => {
    const result = ScheduleWorkTargetSchema.safeParse({ kind: 'script', ref: 'checkout@1.0.0' })
    expect(result.success).toBe(true)
  })

  test('parses a script target with @latest and optional params', () => {
    const result = ScheduleWorkTargetSchema.safeParse({ kind: 'script', ref: 'checkout@latest', params: { a: 1 } })
    expect(result.success).toBe(true)
  })

  test('parses an agent target with agentId and a non-empty prompt', () => {
    const result = ScheduleWorkTargetSchema.safeParse({ kind: 'agent', agentId: 'agent-1', prompt: 'check the checkout flow' })
    expect(result.success).toBe(true)
  })

  test('rejects an agent target with an empty prompt', () => {
    expect(ScheduleWorkTargetSchema.safeParse({ kind: 'agent', agentId: 'agent-1', prompt: '' }).success).toBe(false)
  })

  test('rejects an agent target missing agentId', () => {
    expect(ScheduleWorkTargetSchema.safeParse({ kind: 'agent', prompt: 'x' }).success).toBe(false)
  })

  test('rejects a script target with an invalid reference (no @version)', () => {
    expect(ScheduleWorkTargetSchema.safeParse({ kind: 'script', ref: 'checkout' }).success).toBe(false)
  })

  test('rejects an unknown kind', () => {
    expect(ScheduleWorkTargetSchema.safeParse({ kind: 'webhook', ref: 'x' }).success).toBe(false)
  })

  test('rejects a payload with fields from BOTH kinds mixed under the wrong discriminant', () => {
    expect(ScheduleWorkTargetSchema.safeParse({ kind: 'script', agentId: 'a1', prompt: 'x' }).success).toBe(false)
  })
})

describe('ScheduleThreadModeSchema (plan 68 §3.2)', () => {
  test('accepts new and continue only', () => {
    expect(ScheduleThreadModeSchema.safeParse('new').success).toBe(true)
    expect(ScheduleThreadModeSchema.safeParse('continue').success).toBe(true)
    expect(ScheduleThreadModeSchema.safeParse('always').success).toBe(false)
  })
})

describe('OnApprovalRequiredSchema (plan 68 §3.5)', () => {
  test('accepts deny and pause only', () => {
    expect(OnApprovalRequiredSchema.safeParse('deny').success).toBe(true)
    expect(OnApprovalRequiredSchema.safeParse('pause').success).toBe(true)
    expect(OnApprovalRequiredSchema.safeParse('ask').success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// findRedundantSchedules (plan 314 §10.12)
// ---------------------------------------------------------------------------

describe('findRedundantSchedules — the copy-paste trap', () => {
  const base = (over: Partial<ScheduleInfo> = {}): ScheduleInfo =>
    ScheduleInfoSchema.parse({
      id: 'x',
      name: 'n',
      enabled: true,
      cron: '0 8 * * *',
      timezone: 'Asia/Jakarta',
      target: { kind: 'workflow', workflowName: 'warmup', params: { slot: 0 } },
      scriptRef: null,
      params: null,
      groupId: 'g1',
      deviceIds: [],
      labelIds: [],
      concurrency: 0,
      order: 'as-listed',
      onOverlap: 'skip',
      queueTimeoutSec: null,
      catchUp: 'skip',
      jitterSec: 0,
      priority: 0,
      lastFiredAt: null,
      batchId: null,
      lastFireOutcome: null,
      lastFireDetail: null,
      createdBy: null,
      createdAt: 0,
      threadMode: 'new',
      threadId: null,
      onApprovalRequired: 'deny',
      lastAgentRunId: null,
      ...over,
    })

  test('THE TRAP: three sessions duplicated without changing the slot are flagged', () => {
    // What an operator actually does: build one, duplicate it twice, change
    // only the time. The farm then runs one platform three times a day.
    const items = [
      base({ id: 'a', name: 'pagi', cron: '0 8 * * *' }),
      base({ id: 'b', name: 'siang', cron: '0 13 * * *' }),
      base({ id: 'c', name: 'malam', cron: '0 19 * * *' }),
    ]
    expect(findRedundantSchedules(items)).toEqual([['a', 'b', 'c']])
  })

  test('the correct rotation — same workflow, different slots — is NOT flagged', () => {
    const items = [
      base({ id: 'a', cron: '0 8 * * *', target: { kind: 'workflow', workflowName: 'warmup', params: { slot: 0 } } }),
      base({ id: 'b', cron: '0 13 * * *', target: { kind: 'workflow', workflowName: 'warmup', params: { slot: 1 } } }),
      base({ id: 'c', cron: '0 19 * * *', target: { kind: 'workflow', workflowName: 'warmup', params: { slot: 2 } } }),
    ]
    expect(findRedundantSchedules(items)).toEqual([])
  })

  test('a different device target is different work, even with the same params', () => {
    const items = [base({ id: 'a', groupId: 'g1' }), base({ id: 'b', groupId: 'g2' })]
    expect(findRedundantSchedules(items)).toEqual([])
  })

  test('key order in params does not create a false difference', () => {
    const items = [
      base({ id: 'a', target: { kind: 'workflow', workflowName: 'w', params: { slot: 1, mode: 'x' } } }),
      base({ id: 'b', target: { kind: 'workflow', workflowName: 'w', params: { mode: 'x', slot: 1 } } }),
    ]
    expect(findRedundantSchedules(items)).toEqual([['a', 'b']])
  })

  test('a disabled copy is an operator keeping a spare, not the mistake', () => {
    const items = [base({ id: 'a' }), base({ id: 'b', enabled: false })]
    expect(findRedundantSchedules(items)).toEqual([])
  })

  test('script targets are covered too; agent targets are not', () => {
    const scripts = [
      base({ id: 'a', target: { kind: 'script', ref: 'tiktok/warmup@latest', params: {} } }),
      base({ id: 'b', target: { kind: 'script', ref: 'tiktok/warmup@latest', params: {} } }),
    ]
    expect(findRedundantSchedules(scripts)).toEqual([['a', 'b']])

    // An agent prompt is free text an operator repeats on purpose as often as
    // by accident — flagging it would be noise.
    const agents = [
      base({ id: 'a', target: { kind: 'agent', agentId: 'ag1', prompt: 'check the farm' } }),
      base({ id: 'b', target: { kind: 'agent', agentId: 'ag1', prompt: 'check the farm' } }),
    ]
    expect(findRedundantSchedules(agents)).toEqual([])
  })

  test('a lone schedule is never a group', () => {
    expect(findRedundantSchedules([base({ id: 'a' })])).toEqual([])
    expect(findRedundantSchedules([])).toEqual([])
  })
})
