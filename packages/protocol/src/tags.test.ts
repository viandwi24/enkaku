import { describe, expect, test } from 'bun:test'
import { normaliseTag, TagSchema } from './tags'

describe('normaliseTag', () => {
  test('trims, lowercases, and collapses whitespace around the key:value colon', () => {
    expect(normaliseTag(' Pool: Smoke ')).toBe('pool:smoke')
  })

  test('collapses an internal whitespace run elsewhere in the tag into a single dash', () => {
    expect(normaliseTag('has space')).toBe('has-space')
  })
})

describe('TagSchema', () => {
  test('normalises then validates — the UI and the API see the same value', () => {
    expect(TagSchema.parse(' Pool: Smoke ')).toBe('pool:smoke')
  })

  test('rejects a tag outside the allowed charset', () => {
    expect(TagSchema.safeParse('pool@smoke').success).toBe(false)
    expect(TagSchema.safeParse('pool/smoke').success).toBe(false)
  })

  test('rejects a tag over 64 characters', () => {
    expect(TagSchema.safeParse('a'.repeat(65)).success).toBe(false)
    expect(TagSchema.safeParse('a'.repeat(64)).success).toBe(true)
  })

  test('rejects a tag that does not start with an alphanumeric', () => {
    expect(TagSchema.safeParse(':leading-colon').success).toBe(false)
    expect(TagSchema.safeParse('-leading-dash').success).toBe(false)
  })

  test('accepts a well-formed key:value tag unchanged', () => {
    expect(TagSchema.parse('android:15')).toBe('android:15')
  })
})
