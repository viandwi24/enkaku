import { describe, expect, test } from 'bun:test'
import { OnApprovalRequiredSchema, ScheduleThreadModeSchema, ScheduleWorkTargetSchema } from './schedule'

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
