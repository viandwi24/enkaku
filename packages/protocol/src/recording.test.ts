import { describe, expect, test } from 'bun:test'
import { RecordingDocSchema, RecordingStepSchema, RecordingTargetSchema } from './recording'

/**
 * plan 94 §4.1, step 94.1 — the recording document. `RecordingDocSchema` is
 * the one place the "coordinates are normalised, always" property (F2,
 * acceptance criterion 1) and the "a drag keeps its own sampled path, a
 * long-press keeps its own hold" property (F3, F4, acceptance criterion 5)
 * are actually enforced, so this file checks both directly rather than only
 * through `defineRecording` (`@enkaku/sdk`'s tests do that end to end).
 */

const pointTarget = { kind: 'point' as const, pos: { x: 0.5, y: 0.5 } }

function baseDoc(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    name: 'checkout',
    version: '1.0.0',
    recordedAt: 1_700_000_000,
    recordedOn: { stableId: 'abc123', model: 'moto g06 power', width: 1080, height: 2400 },
    steps: [],
    ...overrides,
  }
}

describe('RecordingTargetSchema', () => {
  test('a point target carries a normalised (0..1) position', () => {
    const parsed = RecordingTargetSchema.parse(pointTarget)
    expect(parsed).toEqual(pointTarget)
  })

  test('a selector target keeps its normalised fallback alongside the promoted selector', () => {
    const target = { kind: 'selector' as const, selector: { id: 'checkout_button' }, fallback: { x: 0.5, y: 0.9 } }
    expect(RecordingTargetSchema.parse(target)).toEqual(target)
  })

  test('a point target rejects an out-of-range coordinate — this is what makes it NOT a pixel', () => {
    expect(() => RecordingTargetSchema.parse({ kind: 'point', pos: { x: 1.5, y: 0.5 } })).toThrow()
  })

  test('an unrecognised extra field is refused (.strict())', () => {
    expect(() => RecordingTargetSchema.parse({ ...pointTarget, extra: true })).toThrow()
  })
})

describe('RecordingStepSchema — every kind round-trips', () => {
  test('tap: holdMs is optional', () => {
    const step = { kind: 'tap' as const, gapMs: 250, target: pointTarget }
    expect(RecordingStepSchema.parse(step)).toEqual(step)
  })

  test('tap: holdMs, when present, is carried through untouched', () => {
    const step = { kind: 'tap' as const, gapMs: 250, target: pointTarget, holdMs: 90 }
    expect(RecordingStepSchema.parse(step).kind).toBe('tap')
    expect((RecordingStepSchema.parse(step) as { holdMs?: number }).holdMs).toBe(90)
  })

  test('longPress: holdMs is REQUIRED and floored at 200 (F4 — a long-press replays as a long-press)', () => {
    const step = { kind: 'longPress' as const, gapMs: 100, target: pointTarget, holdMs: 600 }
    expect(RecordingStepSchema.parse(step)).toEqual(step)
    expect(() => RecordingStepSchema.parse({ kind: 'longPress', gapMs: 100, target: pointTarget })).toThrow()
    expect(() => RecordingStepSchema.parse({ kind: 'longPress', gapMs: 100, target: pointTarget, holdMs: 100 })).toThrow()
  })

  test('gesture: the sampled path is stored verbatim, not reduced to two endpoints (F3)', () => {
    const samples = [
      { x: 0.1, y: 0.1, atMs: 0 },
      { x: 0.2, y: 0.15, atMs: 16 },
      { x: 0.4, y: 0.3, atMs: 40 },
    ]
    const step = { kind: 'gesture' as const, gapMs: 50, samples }
    const parsed = RecordingStepSchema.parse(step)
    expect(parsed).toEqual(step)
    if (parsed.kind === 'gesture') expect(parsed.samples).toHaveLength(3)
  })

  test('gesture: fewer than 2 samples is refused', () => {
    expect(() => RecordingStepSchema.parse({ kind: 'gesture', gapMs: 50, samples: [{ x: 0, y: 0, atMs: 0 }] })).toThrow()
  })

  test('swipe: the two-point fallback, normalised', () => {
    const step = { kind: 'swipe' as const, gapMs: 50, from: { x: 0.2, y: 0.8 }, to: { x: 0.2, y: 0.2 }, durationMs: 300 }
    expect(RecordingStepSchema.parse(step)).toEqual(step)
  })

  test('key: a bare Android keycode', () => {
    const step = { kind: 'key' as const, gapMs: 0, keycode: 4 }
    expect(RecordingStepSchema.parse(step)).toEqual(step)
  })

  test('text: a literal string', () => {
    const step = { kind: 'text' as const, gapMs: 0, value: 'hello@example.com' }
    expect(RecordingStepSchema.parse(step)).toEqual(step)
  })

  test('text: a { param } reference — the one parameterisation seam (§4.2)', () => {
    const step = { kind: 'text' as const, gapMs: 0, value: { param: 'caption' } }
    expect(RecordingStepSchema.parse(step)).toEqual(step)
  })

  test('text: a bad param name is refused', () => {
    expect(() => RecordingStepSchema.parse({ kind: 'text', gapMs: 0, value: { param: 'Not Valid' } })).toThrow()
    expect(() => RecordingStepSchema.parse({ kind: 'text', gapMs: 0, value: { param: '1abc' } })).toThrow()
  })

  test('an unknown kind is refused', () => {
    expect(() => RecordingStepSchema.parse({ kind: 'pinch', gapMs: 0 })).toThrow()
  })
})

describe('RecordingDocSchema', () => {
  test('a minimal document parses, with every default filled in', () => {
    const parsed = RecordingDocSchema.parse(baseDoc())
    expect(parsed.description).toBe('')
    expect(parsed.speed).toBe(1)
    expect(parsed.maxGapMs).toBe(15_000)
    expect(parsed.cleanup).toBe('force-stop')
    expect(parsed.packages).toEqual([])
  })

  test('a 2001-step document is refused (cap 2_000)', () => {
    const steps = Array.from({ length: 2_001 }, () => ({ kind: 'key' as const, gapMs: 0, keycode: 3 }))
    expect(() => RecordingDocSchema.parse(baseDoc({ steps }))).toThrow()
  })

  test('exactly 2_000 steps is accepted', () => {
    const steps = Array.from({ length: 2_000 }, () => ({ kind: 'key' as const, gapMs: 0, keycode: 3 }))
    expect(() => RecordingDocSchema.parse(baseDoc({ steps }))).not.toThrow()
  })

  test('name rejects a slash — a recording is not a plugin member', () => {
    expect(() => RecordingDocSchema.parse(baseDoc({ name: 'pack/checkout' }))).toThrow()
  })

  test('name rejects an uppercase or otherwise malformed slug', () => {
    expect(() => RecordingDocSchema.parse(baseDoc({ name: 'Checkout' }))).toThrow()
  })

  test('version must be semver', () => {
    expect(() => RecordingDocSchema.parse(baseDoc({ version: '1.0' }))).toThrow()
  })

  test('speed is bounded to [0.1, 10]', () => {
    expect(() => RecordingDocSchema.parse(baseDoc({ speed: 0 }))).toThrow()
    expect(() => RecordingDocSchema.parse(baseDoc({ speed: 11 }))).toThrow()
    expect(RecordingDocSchema.parse(baseDoc({ speed: 2 })).speed).toBe(2)
  })

  test('an unrecognised top-level field is refused (.strict()) — a typo in a hand-edited document fails loudly', () => {
    expect(() => RecordingDocSchema.parse(baseDoc({ notAField: true }))).toThrow()
  })

  test('recordedOn is not decoration — width/height/model/stableId all round-trip, for the review panel\'s cross-resolution note', () => {
    const parsed = RecordingDocSchema.parse(baseDoc())
    expect(parsed.recordedOn).toEqual({ stableId: 'abc123', model: 'moto g06 power', width: 1080, height: 2400 })
  })
})
