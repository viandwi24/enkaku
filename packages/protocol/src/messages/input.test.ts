import { describe, expect, test } from 'bun:test'
import { InputGestureMessage } from './input'

/**
 * Manual control sends the operator's real pointer trace as one batched
 * message (plan 40 §4.6) — this is the wire contract for it.
 */
describe('InputGestureMessage (plan 40 §4.6)', () => {
  const base = { deviceId: 'dev-1' }

  test('accepts a trace with at least 2 samples', () => {
    const result = InputGestureMessage.safeParse({
      type: 'input.gesture',
      payload: { ...base, samples: [{ x: 0.1, y: 0.2, atMs: 0 }, { x: 0.5, y: 0.6, atMs: 120 }] },
    })
    expect(result.success).toBe(true)
  })

  test('rejects a single-sample trace (a gesture needs at least a start and an end)', () => {
    const result = InputGestureMessage.safeParse({
      type: 'input.gesture',
      payload: { ...base, samples: [{ x: 0.1, y: 0.2, atMs: 0 }] },
    })
    expect(result.success).toBe(false)
  })

  test('rejects samples with coordinates outside 0..1 (normalised, not device pixels)', () => {
    const result = InputGestureMessage.safeParse({
      type: 'input.gesture',
      payload: { ...base, samples: [{ x: -0.1, y: 0.2, atMs: 0 }, { x: 0.5, y: 0.6, atMs: 120 }] },
    })
    expect(result.success).toBe(false)
  })

  test('rejects a trace longer than 300 samples', () => {
    const samples = Array.from({ length: 301 }, (_, i) => ({ x: 0.5, y: 0.5, atMs: i }))
    const result = InputGestureMessage.safeParse({ type: 'input.gesture', payload: { ...base, samples } })
    expect(result.success).toBe(false)
  })

  test('accepts exactly 300 samples', () => {
    const samples = Array.from({ length: 300 }, (_, i) => ({ x: 0.5, y: 0.5, atMs: i }))
    const result = InputGestureMessage.safeParse({ type: 'input.gesture', payload: { ...base, samples } })
    expect(result.success).toBe(true)
  })

  test('rejects a negative atMs', () => {
    const result = InputGestureMessage.safeParse({
      type: 'input.gesture',
      payload: { ...base, samples: [{ x: 0.1, y: 0.2, atMs: -1 }, { x: 0.5, y: 0.6, atMs: 120 }] },
    })
    expect(result.success).toBe(false)
  })
})
