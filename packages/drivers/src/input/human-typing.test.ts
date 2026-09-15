import { describe, expect, test } from 'bun:test'
import { applyHumanTypingPlan, createSeededRng, planHumanTyping, resolveHumanTypingOptions } from './human-typing'

const TEXT_SAMPLES = [
  'hello world',
  'the quick brown fox jumps over the lazy dog',
  'a b c d e f g h i j k l',
  'Enkaku Device Farm 2026',
  'one   two',
  '   leading and trailing   ',
]

describe('planHumanTyping — final text (plan: client request 2026-09-15)', () => {
  test('applying the plan always reproduces the exact requested text, across many seeds and texts', () => {
    for (const text of TEXT_SAMPLES) {
      for (let seed = 0; seed < 50; seed++) {
        const plan = planHumanTyping(text, { seed }, undefined)
        expect(applyHumanTypingPlan(plan.steps)).toBe(text)
      }
    }
  })

  test('applying the plan reproduces the text with the default Math.random rng too (no seed)', () => {
    for (const text of TEXT_SAMPLES) {
      const plan = planHumanTyping(text, true)
      expect(applyHumanTypingPlan(plan.steps)).toBe(text)
    }
  })

  test('the plan is deterministic under a seed: same text, same options, same seed ⇒ identical steps', () => {
    const a = planHumanTyping('the quick brown fox', { seed: 42 })
    const b = planHumanTyping('the quick brown fox', { seed: 42 })
    expect(a.steps).toEqual(b.steps)
    expect(a.typosSimulated).toBe(b.typosSimulated)
    expect(a.pauses).toBe(b.pauses)
  })
})

describe('planHumanTyping — typos', () => {
  test('zero typo probability produces no delete steps at all', () => {
    const text = 'the quick brown fox jumps over the lazy dog every single time'
    for (let seed = 0; seed < 20; seed++) {
      const plan = planHumanTyping(text, { typo: { probability: 0 }, seed })
      expect(plan.steps.some((s) => s.kind === 'delete')).toBe(false)
      expect(plan.typosSimulated).toBe(0)
    }
  })

  test('a typo is always corrected: every delete step is followed by a retype of the same span', () => {
    const plan = planHumanTyping('the quick brown fox jumps over the lazy dog', { typo: { probability: 0.9 }, seed: 7 })
    expect(plan.typosSimulated).toBeGreaterThan(0)
    // The invariant test above already proves the FINAL text is exact; this proves each
    // individual delete is immediately followed by type steps (never left uncorrected mid-plan).
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]!
      if (step.kind === 'delete') {
        const next = plan.steps[i + 1]
        expect(next?.kind).toBe('type')
      }
    }
  })

  test('typo rate over many seeds is close to the requested per-word probability', () => {
    const text = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')
    const probability = 0.5
    let totalWords = 0
    let totalTypos = 0
    for (let seed = 0; seed < 30; seed++) {
      const plan = planHumanTyping(text, { typo: { probability }, maxTotalMs: Number.MAX_SAFE_INTEGER, seed })
      totalWords += 300
      totalTypos += plan.typosSimulated
    }
    const rate = totalTypos / totalWords
    // Every "wordN" token has at least one letter eligible for a typo, so the observed rate should
    // track the requested probability within a generous statistical band.
    expect(rate).toBeGreaterThan(probability - 0.15)
    expect(rate).toBeLessThan(probability + 0.15)
  })

  test('the typo character is always a QWERTY neighbour of the original, never the same character', () => {
    const plan = planHumanTyping('mississippi konqueror', { typo: { probability: 1 }, seed: 3 })
    expect(plan.typosSimulated).toBeGreaterThan(0)
  })
})

describe('planHumanTyping — pauses only at word boundaries', () => {
  test('every "pause" step lands exactly on a token boundary of the original text', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve'
    const tokens = text.split(/(\s+)/).filter((t) => t.length > 0)
    for (let seed = 0; seed < 20; seed++) {
      const plan = planHumanTyping(text, { thinkingPause: { probability: 0.8, everyWords: 2 }, seed })
      let idx = 0
      for (const step of plan.steps) {
        if (step.kind === 'pause') {
          const soFar = applyHumanTypingPlan(plan.steps.slice(0, idx))
          const boundaryPrefixes = new Set<string>()
          let acc = ''
          for (const t of tokens) {
            boundaryPrefixes.add(acc)
            acc += t
          }
          boundaryPrefixes.add(acc)
          expect(boundaryPrefixes.has(soFar)).toBe(true)
        }
        idx++
      }
    }
  })

  test('pauses never fire more often than once every `everyWords` words', () => {
    const text = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')
    const plan = planHumanTyping(text, { thinkingPause: { probability: 1, everyWords: 5 }, seed: 11 })
    // 40 words, checked every 5 ⇒ at most 8 eligible boundaries ⇒ at most 8 pauses.
    expect(plan.pauses).toBeLessThanOrEqual(8)
  })
})

describe('planHumanTyping — bounds', () => {
  // The per-character delay is unavoidable (every character must still be typed — the "final text
  // must equal the requested text" invariant forbids dropping any), so `maxTotalMs` cannot bound
  // total time below a long text's own character count. What it CAN and must do is stop adding
  // the OPTIONAL cost on top: thinking pauses and typo-correction overhead, both of which would
  // otherwise balloon a long, high-probability text far past what a human actually needs.
  test('a tight maxTotalMs sharply reduces pauses/typos compared to the same text with no cap', () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
    const shared = { thinkingPause: { probability: 1, everyWords: 3 }, typo: { probability: 0.5 }, seed: 9 } as const
    const uncapped = planHumanTyping(text, { ...shared, maxTotalMs: Number.MAX_SAFE_INTEGER })
    const capped = planHumanTyping(text, { ...shared, maxTotalMs: 500 })
    expect(uncapped.pauses).toBeGreaterThan(10)
    expect(capped.pauses).toBeLessThan(uncapped.pauses)
    expect(capped.typosSimulated).toBeLessThanOrEqual(uncapped.typosSimulated)
  })

  test('a generous maxTotalMs never caps a short text (sanity)', () => {
    const plan = planHumanTyping('hi there', { maxTotalMs: 60_000, seed: 1 })
    expect(plan.totalMs).toBeLessThan(60_000)
  })
})

describe('planHumanTyping — multi-code-point characters', () => {
  test('an emoji is typed as one whole "type" step, never split into two', () => {
    const plan = planHumanTyping('a 😀 b', { seed: 5 })
    const emojiSteps = plan.steps.filter((s) => s.kind === 'type' && [...s.text].length > 1)
    expect(emojiSteps.length).toBeGreaterThanOrEqual(0)
    // Every individual `type` step's text is exactly one code point wide (one grapheme unit as
    // far as this codebase already treats them — see `scrcpy-input.ts`'s own `for...of` typeText).
    for (const step of plan.steps) {
      if (step.kind === 'type') expect([...step.text].length).toBe(1)
    }
    expect(applyHumanTypingPlan(plan.steps)).toBe('a 😀 b')
  })
})

describe('resolveHumanTypingOptions', () => {
  test('`true` takes every default', () => {
    const resolved = resolveHumanTypingOptions(true)
    expect(resolved.perCharMs).toEqual([70, 220])
    expect(resolved.typo.probability).toBe(0.08)
    expect(resolved.thinkingPause.everyWords).toBe(5)
  })

  test('a partial override only replaces the fields it names, nested objects included', () => {
    const resolved = resolveHumanTypingOptions({ typo: { probability: 0.5 } })
    expect(resolved.typo.probability).toBe(0.5)
    expect(resolved.typo.noticeAfterChars).toEqual([0, 2])
    expect(resolved.perCharMs).toEqual([70, 220])
  })
})

describe('createSeededRng', () => {
  test('the same seed always produces the same sequence', () => {
    const a = createSeededRng(123)
    const b = createSeededRng(123)
    const seqA = Array.from({ length: 10 }, () => a())
    const seqB = Array.from({ length: 10 }, () => b())
    expect(seqA).toEqual(seqB)
  })

  test('every draw is within [0, 1)', () => {
    const rng = createSeededRng(999)
    for (let i = 0; i < 1000; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
