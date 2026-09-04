import { describe, expect, test } from 'bun:test'
import { InputGestureMessage, InputKeyEventMessage, InputPinchMessage, InputScrollMessage, InputTapMessage, InputTouchMessage } from './input'
import { INPUT_EVENT_KINDS } from './device-event'
import { ClientMessageSchema } from '../index'

/**
 * `input.tap`'s `holdMs` (plan 94 §4.4, closes F4/F5) — the operator's
 * measured pointer down→up duration, absent on an older client.
 */
describe('InputTapMessage (plan 94 §4.4)', () => {
  const base = { deviceId: 'dev-1', pos: { x: 0.5, y: 0.5 } }

  test('accepts a tap with no holdMs at all — an older client keeps working unchanged', () => {
    const result = InputTapMessage.safeParse({ type: 'input.tap', payload: base })
    expect(result.success).toBe(true)
  })

  test('accepts a tap carrying holdMs', () => {
    const result = InputTapMessage.safeParse({ type: 'input.tap', payload: { ...base, holdMs: 650 } })
    expect(result.success).toBe(true)
    expect(result.success && result.data.payload.holdMs).toBe(650)
  })

  test('rejects a negative holdMs', () => {
    const result = InputTapMessage.safeParse({ type: 'input.tap', payload: { ...base, holdMs: -1 } })
    expect(result.success).toBe(false)
  })

  test('rejects a holdMs above the 60s ceiling', () => {
    const result = InputTapMessage.safeParse({ type: 'input.tap', payload: { ...base, holdMs: 60_001 } })
    expect(result.success).toBe(false)
  })

  test('accepts holdMs: 0 — a tap released the instant it landed', () => {
    const result = InputTapMessage.safeParse({ type: 'input.tap', payload: { ...base, holdMs: 0 } })
    expect(result.success).toBe(true)
  })
})

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

describe('the four new input messages (plan 209 §4.5, §5 step 209.3)', () => {
  test('input.touch defaults pointerId to 0 and rejects 10', () => {
    const base = { deviceId: 'dev-1', action: 'down', pos: { x: 0.5, y: 0.5 } }
    const defaulted = InputTouchMessage.safeParse({ type: 'input.touch', payload: base })
    expect(defaulted.success).toBe(true)
    expect(defaulted.success && defaulted.data.payload.pointerId).toBe(0)
    const rejected = InputTouchMessage.safeParse({ type: 'input.touch', payload: { ...base, pointerId: 10 } })
    expect(rejected.success).toBe(false)
  })

  test('input.touch rejects an action outside down/move/up', () => {
    const result = InputTouchMessage.safeParse({
      type: 'input.touch',
      payload: { deviceId: 'dev-1', action: 'cancel', pos: { x: 0.5, y: 0.5 } },
    })
    expect(result.success).toBe(false)
  })

  test('input.scroll rejects a delta outside -1..1', () => {
    const result = InputScrollMessage.safeParse({
      type: 'input.scroll',
      payload: { deviceId: 'dev-1', pos: { x: 0.5, y: 0.5 }, hDelta: 1.5, vDelta: 0 },
    })
    expect(result.success).toBe(false)
  })

  test('input.keyEvent accepts KeyA with meta and rejects an unmapped code', () => {
    const meta = { shift: false, ctrl: false, alt: false, meta: false }
    const ok = InputKeyEventMessage.safeParse({
      type: 'input.keyEvent',
      payload: { deviceId: 'dev-1', action: 'down', code: 'KeyA', meta },
    })
    expect(ok.success).toBe(true)
    const bad = InputKeyEventMessage.safeParse({
      type: 'input.keyEvent',
      payload: { deviceId: 'dev-1', action: 'down', code: 'NotAKey', meta },
    })
    expect(bad.success).toBe(false)
  })

  test('input.keyEvent requires all four meta flags', () => {
    const result = InputKeyEventMessage.safeParse({
      type: 'input.keyEvent',
      payload: { deviceId: 'dev-1', action: 'down', code: 'KeyA', meta: { shift: false } },
    })
    expect(result.success).toBe(false)
  })

  test('input.pinch defaults durationMs to 300 and rejects scaleTo above 0.5', () => {
    const defaulted = InputPinchMessage.safeParse({
      type: 'input.pinch',
      payload: { deviceId: 'dev-1', center: { x: 0.5, y: 0.5 }, scaleFrom: 0.1, scaleTo: 0.2 },
    })
    expect(defaulted.success).toBe(true)
    expect(defaulted.success && defaulted.data.payload.durationMs).toBe(300)
    const rejected = InputPinchMessage.safeParse({
      type: 'input.pinch',
      payload: { deviceId: 'dev-1', center: { x: 0.5, y: 0.5 }, scaleFrom: 0.1, scaleTo: 0.6 },
    })
    expect(rejected.success).toBe(false)
  })

  test('ClientMessageSchema parses the four new messages', () => {
    const meta = { shift: false, ctrl: false, alt: false, meta: false }
    expect(ClientMessageSchema.safeParse({ type: 'input.touch', payload: { deviceId: 'd', action: 'down', pos: { x: 0.1, y: 0.1 } } }).success).toBe(true)
    expect(ClientMessageSchema.safeParse({ type: 'input.scroll', payload: { deviceId: 'd', pos: { x: 0.1, y: 0.1 }, hDelta: 0, vDelta: 1 } }).success).toBe(true)
    expect(ClientMessageSchema.safeParse({ type: 'input.keyEvent', payload: { deviceId: 'd', action: 'down', code: 'KeyA', meta } }).success).toBe(true)
    expect(ClientMessageSchema.safeParse({ type: 'input.pinch', payload: { deviceId: 'd', center: { x: 0.5, y: 0.5 }, scaleFrom: 0.1, scaleTo: 0.2 } }).success).toBe(true)
  })

  test('INPUT_EVENT_KINDS contains input.scroll, input.keyEvent and input.pinch and not input.touch', () => {
    expect(INPUT_EVENT_KINDS).toContain('input.scroll')
    expect(INPUT_EVENT_KINDS).toContain('input.keyEvent')
    expect(INPUT_EVENT_KINDS).toContain('input.pinch')
    expect(INPUT_EVENT_KINDS as readonly string[]).not.toContain('input.touch')
  })
})
