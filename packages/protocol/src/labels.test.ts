import { describe, expect, test } from 'bun:test'
import { DEFAULT_LABEL_COLOR, LABEL_COLORS, LabelColorSchema, LabelNameSchema, normaliseLabelName } from './labels'

describe('normaliseLabelName', () => {
  test('trims the outer whitespace', () => {
    expect(normaliseLabelName('  Smoke Pool  ')).toBe('Smoke Pool')
  })

  test('collapses an internal whitespace run into a single space', () => {
    expect(normaliseLabelName('Smoke    Pool')).toBe('Smoke Pool')
  })

  test('keeps case and punctuation a human typed — the whole point of replacing tags', () => {
    // `normaliseTag`, which this replaces, would have made this
    // `android:15-(beta)` and then rejected it for the parenthesis.
    expect(normaliseLabelName('Android 15 (beta)')).toBe('Android 15 (beta)')
  })
})

describe('LabelNameSchema', () => {
  test('normalises then validates — the UI and the API see the same value', () => {
    expect(LabelNameSchema.parse('  Smoke   Pool ')).toBe('Smoke Pool')
  })

  test('rejects a name that is empty once normalised', () => {
    expect(LabelNameSchema.safeParse('   ').success).toBe(false)
  })

  test('accepts up to 64 characters — the ceiling the migrated tags had', () => {
    expect(LabelNameSchema.safeParse('a'.repeat(64)).success).toBe(true)
    expect(LabelNameSchema.safeParse('a'.repeat(65)).success).toBe(false)
  })
})

describe('LabelColorSchema', () => {
  test('accepts every name in the palette and nothing else', () => {
    for (const c of LABEL_COLORS) expect(LabelColorSchema.safeParse(c).success).toBe(true)
    expect(LabelColorSchema.safeParse('#ff0000').success).toBe(false)
    expect(LabelColorSchema.safeParse('chartreuse').success).toBe(false)
  })

  test('the default is one of the palette', () => {
    expect(LABEL_COLORS).toContain(DEFAULT_LABEL_COLOR)
  })
})
