import { describe, expect, test } from 'bun:test'
import { HumanTypingOptionsSchema, TypeArgsSchema } from './device-args'

describe('TypeArgsSchema — human typing option (client request, 2026-09-15)', () => {
  test('is optional: an ordinary call with no `human` at all still parses (existing callers unchanged)', () => {
    const parsed = TypeArgsSchema.parse({ text: 'hello' })
    expect(parsed.human).toBeUndefined()
  })

  test('accepts `human: true`', () => {
    const parsed = TypeArgsSchema.parse({ text: 'hello', human: true })
    expect(parsed.human).toBe(true)
  })

  test('accepts a full override object', () => {
    const parsed = TypeArgsSchema.parse({
      text: 'hello',
      human: {
        perCharMs: [50, 200],
        extraPerWordMs: [100, 300],
        thinkingPause: { probability: 0.3, everyWords: 4, ms: [500, 2000] },
        typo: { probability: 0.1, noticeAfterChars: [0, 3] },
        maxTotalMs: 30_000,
        seed: 7,
      },
    })
    expect(parsed.human).toMatchObject({ maxTotalMs: 30_000, seed: 7 })
  })

  test('accepts a partial override object — every field stays optional', () => {
    const parsed = TypeArgsSchema.parse({ text: 'hello', human: { typo: { probability: 0.5 } } })
    expect(parsed.human).toEqual({ typo: { probability: 0.5 } })
  })

  test('rejects `human: false` — the option is opt-in-or-configured, never an explicit off switch', () => {
    expect(() => TypeArgsSchema.parse({ text: 'hello', human: false })).toThrow()
  })

  test('rejects an out-of-range probability', () => {
    expect(() => TypeArgsSchema.parse({ text: 'hello', human: { typo: { probability: 2 } } })).toThrow()
  })

  test('rejects a non-integer seed', () => {
    expect(() => HumanTypingOptionsSchema.parse({ seed: 1.5 })).toThrow()
  })

  test('still coexists with `instant`, `perCharMs` and `via` — none of the existing fields are disturbed', () => {
    const parsed = TypeArgsSchema.parse({ text: 'hello', instant: true, perCharMs: [10, 20], via: 'adb', human: true })
    expect(parsed.instant).toBe(true)
    expect(parsed.perCharMs).toEqual([10, 20])
    expect(parsed.via).toBe('adb')
    expect(parsed.human).toBe(true)
  })
})
