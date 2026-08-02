import { describe, expect, test } from 'bun:test'
import { redactInputText } from './ws-handlers'

/**
 * The credential-safety contract from plan 18 §3.4: `input.text` must never
 * store the literal string by default, because typed text routinely includes
 * passwords and one-time codes. This is exercised directly against the exact
 * function `input.text` handling calls in ws-handlers.ts (not a re-implementation
 * of it), so a regression here is a regression in the real code path.
 */
describe('redactInputText (plan 18 §3.4)', () => {
  test('default (storeLiteral=false) never includes the literal text', () => {
    const secret = 'hunter2-super-secret-password'
    const meta = redactInputText(secret, false)

    expect(meta).not.toHaveProperty('text')
    expect(JSON.stringify(meta)).not.toContain(secret)
    expect(meta.length).toBe(secret.length)
    expect('sha256Prefix' in meta && typeof meta.sha256Prefix === 'string').toBe(true)
  })

  test('the hash is deterministic and does not trivially reveal the input', () => {
    const a = redactInputText('password123', false)
    const b = redactInputText('password123', false)
    const c = redactInputText('password124', false)
    expect(a).toEqual(b) // same input, same hash — useful for spotting repeats
    expect(a).not.toEqual(c) // different input, different hash
    if ('sha256Prefix' in a) {
      expect(a.sha256Prefix).not.toBe('password123') // not the plaintext itself
      expect(a.sha256Prefix.length).toBe(16)
    }
  })

  test('opting in (storeLiteral=true) stores the literal text — an explicit, not accidental, choice', () => {
    const text = 'the actual typed string'
    const meta = redactInputText(text, true)
    expect(meta).toEqual({ length: text.length, text })
  })

  test('empty text is handled the same way as any other', () => {
    const meta = redactInputText('', false)
    expect(meta.length).toBe(0)
    expect(meta).not.toHaveProperty('text')
  })
})
