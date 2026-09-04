import { describe, expect, test } from 'bun:test'
import type { ActionResult } from '@enkaku/protocol'
import { createOperationRegistry, OPERATION_MAX, OPERATION_TTL_MS } from './operations'

function fakeClock(startMs = 0) {
  let ms = startMs
  return { now: () => ms, advance: (deltaMs: number) => (ms += deltaMs) }
}

function result(deviceId: string, over: Partial<ActionResult> = {}): ActionResult {
  return { deviceId, status: 'accepted', ...over }
}

describe('createOperationRegistry — create', () => {
  test('settled is false while any result is accepted', () => {
    const reg = createOperationRegistry({})
    const op = reg.create({ verb: 'wake', target: { deviceIds: ['d1', 'd2'] }, createdBy: 'u1', results: [result('d1'), result('d2')] })
    expect(op.settled).toBe(false)
  })

  test('settled is true when no result is accepted', () => {
    const reg = createOperationRegistry({})
    const op = reg.create({
      verb: 'wake',
      target: { deviceIds: ['d1'] },
      createdBy: 'u1',
      results: [result('d1', { status: 'skipped', message: 'offline' })],
    })
    expect(op.settled).toBe(true)
  })
})

describe('createOperationRegistry — settle', () => {
  test('replaces exactly one result, leaving the others untouched', () => {
    const reg = createOperationRegistry({})
    const op = reg.create({ verb: 'adb', target: { deviceIds: ['d1', 'd2'] }, createdBy: null, results: [result('d1'), result('d2')] })
    const ok = reg.settle(op.operationId, 'd1', { status: 'done', detail: { exitCode: 0 } })
    expect(ok).toBe(true)
    const after = reg.get(op.operationId)!
    expect(after.results.find((r) => r.deviceId === 'd1')).toMatchObject({ status: 'done', detail: { exitCode: 0 } })
    expect(after.results.find((r) => r.deviceId === 'd2')).toMatchObject({ status: 'accepted' })
    expect(after.settled).toBe(false)
  })

  test('settled becomes true once every result has settled', () => {
    const reg = createOperationRegistry({})
    const op = reg.create({ verb: 'adb', target: { deviceIds: ['d1'] }, createdBy: null, results: [result('d1')] })
    reg.settle(op.operationId, 'd1', { status: 'done' })
    expect(reg.get(op.operationId)!.settled).toBe(true)
  })

  test('refuses to replace a result that is not accepted', () => {
    const reg = createOperationRegistry({})
    const op = reg.create({
      verb: 'install',
      target: { deviceIds: ['d1'] },
      createdBy: null,
      results: [result('d1', { status: 'forbidden', code: 'E_DEVICE_CONFLICT' })],
    })
    const ok = reg.settle(op.operationId, 'd1', { status: 'done' })
    expect(ok).toBe(false)
    expect(reg.get(op.operationId)!.results[0]).toMatchObject({ status: 'forbidden', code: 'E_DEVICE_CONFLICT' })
  })

  test('an unknown operation id or device id returns false', () => {
    const reg = createOperationRegistry({})
    expect(reg.settle('ghost', 'd1', { status: 'done' })).toBe(false)
    const op = reg.create({ verb: 'wake', target: { deviceIds: ['d1'] }, createdBy: null, results: [result('d1')] })
    expect(reg.settle(op.operationId, 'ghost-device', { status: 'done' })).toBe(false)
  })
})

describe('createOperationRegistry — sweep (TTL)', () => {
  test('keeps a settled operation for 3599 s and drops it at 3600 s', () => {
    const clock = fakeClock()
    const reg = createOperationRegistry({ now: clock.now })
    const op = reg.create({ verb: 'wake', target: { deviceIds: ['d1'] }, createdBy: null, results: [result('d1', { status: 'done' })] })

    clock.advance(OPERATION_TTL_MS - 1_000)
    reg.sweep()
    expect(reg.get(op.operationId)).not.toBeNull()

    clock.advance(1_000)
    reg.sweep()
    expect(reg.get(op.operationId)).toBeNull()
  })

  test('the TTL clock starts when the operation actually settles, not when it was created', () => {
    const clock = fakeClock()
    const reg = createOperationRegistry({ now: clock.now })
    const op = reg.create({ verb: 'adb', target: { deviceIds: ['d1'] }, createdBy: null, results: [result('d1')] })

    clock.advance(OPERATION_TTL_MS - 1)
    reg.settle(op.operationId, 'd1', { status: 'done' })
    reg.sweep()
    expect(reg.get(op.operationId)).not.toBeNull()

    clock.advance(OPERATION_TTL_MS - 1)
    reg.sweep()
    expect(reg.get(op.operationId)).not.toBeNull()

    clock.advance(1)
    reg.sweep()
    expect(reg.get(op.operationId)).toBeNull()
  })
})

describe('createOperationRegistry — the OPERATION_MAX cap', () => {
  test('the 1001st operation evicts the oldest', () => {
    const reg = createOperationRegistry({})
    const first = reg.create({ verb: 'wake', target: { deviceIds: ['d0'] }, createdBy: null, results: [result('d0', { status: 'done' })] })
    for (let i = 1; i < OPERATION_MAX; i++) {
      reg.create({ verb: 'wake', target: { deviceIds: [`d${i}`] }, createdBy: null, results: [result(`d${i}`, { status: 'done' })] })
    }
    expect(reg.get(first.operationId)).not.toBeNull()

    reg.create({ verb: 'wake', target: { deviceIds: ['d-last'] }, createdBy: null, results: [result('d-last', { status: 'done' })] })
    reg.sweep()
    expect(reg.get(first.operationId)).toBeNull()
  })
})
