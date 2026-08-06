import { describe, expect, test } from 'bun:test'
import { parseWebhookSignatureHeader, signWebhookBody, verifyWebhookSignature, webhookSignatureHeader } from './webhook'

/**
 * HMAC-SHA256 signing over `${timestamp}.${body}` (plan 68 §3.4, §4.4,
 * criterion 10; test plan §7 "Unit — signing"): "a known body and secret
 * produce a known signature; a tampered body fails verification; the
 * timestamp is present and outside a window is rejectable by a receiver."
 */
describe('signWebhookBody / verifyWebhookSignature (plan 68 §3.4, criterion 10)', () => {
  test('a known body and secret always produce the same signature — deterministic, not random', () => {
    const a = signWebhookBody('{"hello":"world"}', 'my-secret', 1_700_000_000)
    const b = signWebhookBody('{"hello":"world"}', 'my-secret', 1_700_000_000)
    expect(a.timestamp).toBe(1_700_000_000)
    expect(a.signature).toMatch(/^[0-9a-f]{64}$/) // hex-encoded SHA-256 HMAC
    expect(a.signature).toBe(b.signature)
    // A different secret over the exact same body/timestamp produces a different signature.
    const c = signWebhookBody('{"hello":"world"}', 'a-different-secret', 1_700_000_000)
    expect(c.signature).not.toBe(a.signature)
  })

  test('the header round-trips through parseWebhookSignatureHeader', () => {
    const sig = signWebhookBody('body', 'secret', 1000)
    const header = webhookSignatureHeader(sig)
    expect(header).toBe(`t=1000,v1=${sig.signature}`)
    expect(parseWebhookSignatureHeader(header)).toEqual(sig)
  })

  test('verifyWebhookSignature accepts a correctly signed body', () => {
    const secret = 'shared-secret'
    const body = JSON.stringify({ id: 'n1', title: 'hi' })
    const sig = signWebhookBody(body, secret, 1_700_000_000)
    const header = webhookSignatureHeader(sig)
    expect(verifyWebhookSignature(body, secret, header, { now: 1_700_000_000 })).toBe(true)
  })

  test('a tampered body fails verification', () => {
    const secret = 'shared-secret'
    const sig = signWebhookBody('original body', secret, 1_700_000_000)
    const header = webhookSignatureHeader(sig)
    expect(verifyWebhookSignature('tampered body', secret, header, { now: 1_700_000_000 })).toBe(false)
  })

  test('a tampered timestamp (in the header, without re-signing) fails verification', () => {
    const secret = 'shared-secret'
    const body = 'the body'
    const sig = signWebhookBody(body, secret, 1_700_000_000)
    const tamperedHeader = `t=1700000999,v1=${sig.signature}`
    expect(verifyWebhookSignature(body, secret, tamperedHeader, { now: 1_700_000_999 })).toBe(false)
  })

  test('the wrong secret fails verification', () => {
    const body = 'the body'
    const sig = signWebhookBody(body, 'secret-a', 1_700_000_000)
    const header = webhookSignatureHeader(sig)
    expect(verifyWebhookSignature(body, 'secret-b', header, { now: 1_700_000_000 })).toBe(false)
  })

  test('a timestamp outside the tolerance window is rejected — replay detection', () => {
    const secret = 'shared-secret'
    const body = 'the body'
    const sig = signWebhookBody(body, secret, 1_700_000_000)
    const header = webhookSignatureHeader(sig)
    // 10 minutes later, default window is 300s (5 minutes).
    expect(verifyWebhookSignature(body, secret, header, { now: 1_700_000_000 + 600 })).toBe(false)
    // Still within a widened window.
    expect(verifyWebhookSignature(body, secret, header, { now: 1_700_000_000 + 600, maxAgeSec: 700 })).toBe(true)
  })

  test('a malformed header (missing t or v1) fails to parse and to verify', () => {
    expect(parseWebhookSignatureHeader('garbage')).toBeNull()
    expect(parseWebhookSignatureHeader('t=123')).toBeNull()
    expect(verifyWebhookSignature('body', 'secret', 'not a valid header')).toBe(false)
  })
})
