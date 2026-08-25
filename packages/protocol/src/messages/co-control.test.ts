import { describe, expect, test } from 'bun:test'
import {
  AssistChangedMessage,
  AssistEndReasonSchema,
  AssistStartedMessage,
  AssistStartMessage,
  AssistStoppedMessage,
  AssistStopMessage,
  InputMirrorMessage,
  InputMirrorResultMessage,
  MirrorChangedMessage,
  MirrorMemberSchema,
  MirrorResultSchema,
  MirrorStartedMessage,
  MirrorStartMessage,
  MirrorStoppedMessage,
  MirrorStopMessage,
} from './co-control'

const HOLDER = {
  kind: 'job' as const,
  id: 'job-1',
  label: 'checkout@1.4.2',
  runId: null,
  takeable: false,
  acquiredAt: 1_700_000_000,
  expiresAt: null,
}

/**
 * The Assist half of co-control (plan 91 §3.2, §4.4) — a device someone/
 * something else already controls, reached without taking it.
 */
describe('assist.* — twelve messages, part 1 (plan 91 §4.4)', () => {
  test('assist.start / assist.stop: deviceId only, id optional', () => {
    expect(AssistStartMessage.safeParse({ type: 'assist.start', payload: { deviceId: 'd1' } }).success).toBe(true)
    expect(AssistStartMessage.safeParse({ type: 'assist.start', id: 'req-1', payload: { deviceId: 'd1' } }).success).toBe(true)
    expect(AssistStopMessage.safeParse({ type: 'assist.stop', payload: { deviceId: 'd1' } }).success).toBe(true)
  })

  test('assist.started: carries expiresAt and the primary holder, never takeable', () => {
    const result = AssistStartedMessage.safeParse({
      type: 'assist.started',
      payload: { deviceId: 'd1', expiresAt: 1_700_000_300, primary: HOLDER },
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.payload.primary.takeable).toBe(false)
  })

  test('assist.stopped: reason is one of the five AssistEndReason values, id optional (push vs. direct reply)', () => {
    for (const reason of AssistEndReasonSchema.options) {
      expect(AssistStoppedMessage.safeParse({ type: 'assist.stopped', payload: { deviceId: 'd1', reason } }).success).toBe(true)
    }
    expect(AssistStoppedMessage.safeParse({ type: 'assist.stopped', payload: { deviceId: 'd1', reason: 'timed_out' } }).success).toBe(false)
  })

  test('assist.changed: broadcasts assistedBy as an array, no id (matches LeaseChangedMessage\'s shape)', () => {
    const result = AssistChangedMessage.safeParse({ type: 'assist.changed', payload: { deviceId: 'd1', assistedBy: [HOLDER] } })
    expect(result.success).toBe(true)
  })
})

/**
 * The Mirror half of co-control (plan 91 §3.8, §3.9, §4.4, §4.7) — one
 * operator's input fanned out to many devices from one message.
 */
describe('mirror.* / input.mirror.* — twelve messages, part 2 (plan 91 §4.4)', () => {
  test('mirror.start: focusDeviceId plus a device list', () => {
    const result = MirrorStartMessage.safeParse({ type: 'mirror.start', payload: { focusDeviceId: 'd1', deviceIds: ['d1', 'd2', 'd3'] } })
    expect(result.success).toBe(true)
  })

  test('mirror.stop: groupId only', () => {
    expect(MirrorStopMessage.safeParse({ type: 'mirror.stop', payload: { groupId: 'g1' } }).success).toBe(true)
  })

  test('mirror.started: one MirrorMember per requested device', () => {
    const member = { deviceId: 'd1', label: 'Pixel 7', number: 7, mode: 'lease' as const, reason: null, aspectDrift: false }
    const result = MirrorStartedMessage.safeParse({
      type: 'mirror.started',
      payload: { groupId: 'g1', focusDeviceId: 'd1', members: [member] },
    })
    expect(result.success).toBe(true)
  })

  test('mirror.stopped: groupId only', () => {
    expect(MirrorStoppedMessage.safeParse({ type: 'mirror.stopped', payload: { groupId: 'g1' } }).success).toBe(true)
  })

  test('input.mirror: groupId, seq, one MirrorAction, no top-level id (seq is the correlation)', () => {
    const result = InputMirrorMessage.safeParse({
      type: 'input.mirror',
      payload: { groupId: 'g1', seq: 1, action: { verb: 'tap', pos: { x: 0.5, y: 0.5 } } },
    })
    expect(result.success).toBe(true)
  })

  test('input.mirror: soloDeviceId narrows delivery to one member (the Alt-held escape hatch, §3.9)', () => {
    const result = InputMirrorMessage.safeParse({
      type: 'input.mirror',
      payload: { groupId: 'g1', seq: 2, action: { verb: 'key', keycode: 26 }, soloDeviceId: 'd2' },
    })
    expect(result.success).toBe(true)
  })

  test('input.mirror.result: one MirrorResult per member, correlated by the same seq', () => {
    const result = InputMirrorResultMessage.safeParse({
      type: 'input.mirror.result',
      payload: {
        groupId: 'g1',
        seq: 1,
        results: [
          { deviceId: 'd1', ok: true, code: null, latencyMs: 42 },
          { deviceId: 'd2', ok: false, code: 'orientation_mismatch', latencyMs: 0 },
        ],
      },
    })
    expect(result.success).toBe(true)
  })

  test('mirror.changed: unicast to the owner with the updated member list', () => {
    const member = { deviceId: 'd2', label: 'Pixel 6', number: 6, mode: 'skipped' as const, reason: 'repeated_failures', aspectDrift: false }
    expect(MirrorChangedMessage.safeParse({ type: 'mirror.changed', payload: { groupId: 'g1', members: [member] } }).success).toBe(true)
  })
})

describe('MirrorMemberSchema / MirrorResultSchema (plan 91 §4.4)', () => {
  test('MirrorMemberSchema accepts every documented mode', () => {
    for (const mode of ['lease', 'assist', 'partial', 'skipped'] as const) {
      expect(MirrorMemberSchema.safeParse({ deviceId: 'd1', label: 'x', number: 1, mode, reason: null, aspectDrift: false }).success).toBe(true)
    }
  })

  test('MirrorMemberSchema rejects an undocumented mode', () => {
    expect(MirrorMemberSchema.safeParse({ deviceId: 'd1', label: 'x', number: 1, mode: 'taken-over', reason: null, aspectDrift: false }).success).toBe(
      false,
    )
  })

  /**
   * Plan 124 §3.7, §3.1 — `number` is REQUIRED and nullable, not optional:
   * "this device has no reservation" is a real, distinct state that the
   * producer must state, and a member that simply omitted the field would be
   * indistinguishable from one built by code that forgot about the number
   * entirely — which is exactly the drift plan 124 exists to end.
   */
  test('MirrorMemberSchema requires `number`, accepts null for an unnumbered device, and rejects a non-integer', () => {
    const base = { deviceId: 'd1', label: 'x', mode: 'lease' as const, reason: null, aspectDrift: false }
    expect(MirrorMemberSchema.safeParse({ ...base, number: null }).success).toBe(true)
    expect(MirrorMemberSchema.safeParse({ ...base, number: 7 }).success).toBe(true)
    expect(MirrorMemberSchema.safeParse(base).success).toBe(false)
    expect(MirrorMemberSchema.safeParse({ ...base, number: 7.5 }).success).toBe(false)
    expect(MirrorMemberSchema.safeParse({ ...base, number: '7' }).success).toBe(false)
  })

  test('MirrorResultSchema: code is nullable (null on success)', () => {
    expect(MirrorResultSchema.safeParse({ deviceId: 'd1', ok: true, code: null, latencyMs: 12 }).success).toBe(true)
    expect(MirrorResultSchema.safeParse({ deviceId: 'd1', ok: false, code: 'E_INPUT_BUSY', latencyMs: 0 }).success).toBe(true)
  })
})
