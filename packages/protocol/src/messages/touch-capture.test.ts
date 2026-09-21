import { describe, expect, test } from 'bun:test'
import { TouchCaptureStatusMessage, TouchStrokeSchema } from './touch-capture'

const STROKE = {
  id: 'stroke-1',
  deviceId: 'dev-1',
  seq: 1,
  kind: 'tap' as const,
  source: '/dev/input/event3',
  sourceName: 'sec_touchscreen',
  synthetic: false,
  at: 1_758_000_000_000,
  deviceTsMs: 28_065_685.745,
  durationMs: 84,
  gapMs: null,
  pointerId: 0,
  concurrent: false,
  from: { x: 0.5, y: 0.25 },
  to: { x: 0.5, y: 0.25 },
  fromRaw: { x: 540, y: 585 },
  toRaw: { x: 540, y: 585 },
  travel: 0,
  samples: [{ x: 0.5, y: 0.25, atMs: 0 }],
  droppedSamples: 0,
}

describe('TouchStrokeSchema (plan 1000 §4.1)', () => {
  test('a captured tap round-trips', () => {
    expect(TouchStrokeSchema.parse(STROKE).kind).toBe('tap')
  })

  test('coordinates are normalised — a panel count is refused, so a raw value can never be mistaken for one', () => {
    expect(() => TouchStrokeSchema.parse({ ...STROKE, from: { x: 540, y: 585 } })).toThrow()
  })

  test('the schema is strict: a field nobody declared is a mistake, not a passthrough', () => {
    expect(() => TouchStrokeSchema.parse({ ...STROKE, pressureMax: 255 })).toThrow()
  })

  test('`gapMs` is nullable, because the first stroke of a capture has no interval to report', () => {
    expect(TouchStrokeSchema.parse({ ...STROKE, gapMs: 120 }).gapMs).toBe(120)
    expect(TouchStrokeSchema.parse(STROKE).gapMs).toBeNull()
  })
})

describe('TouchCaptureStatusMessage (plan 1000 §4.6)', () => {
  test('a pushed status carries no buffer, and that is valid — the client keeps what it has', () => {
    const parsed = TouchCaptureStatusMessage.parse({
      type: 'touch.capture.status',
      payload: { deviceId: 'dev-1', state: 'active', sources: [], viewers: 1 },
    })
    expect(parsed.payload.strokes).toBeUndefined()
  })

  test('a reply carries the buffer', () => {
    const parsed = TouchCaptureStatusMessage.parse({
      type: 'touch.capture.status',
      payload: {
        deviceId: 'dev-1',
        state: 'active',
        sources: [{ path: '/dev/input/event3', name: 'sec_touchscreen', protocol: 'mt-b', maxX: 1079, maxY: 2339, synthetic: false, rotation: 0 }],
        strokes: [STROKE],
        viewers: 1,
      },
    })
    expect(parsed.payload.strokes).toHaveLength(1)
    expect(parsed.payload.sources[0]?.synthetic).toBe(false)
  })
})
