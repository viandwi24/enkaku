import { describe, expect, test } from 'bun:test'
import { attemptWebhookDelivery } from './deliver'
import { parseWebhookSignatureHeader, verifyWebhookSignature } from './webhook'

/**
 * One HTTP attempt at a webhook delivery (plan 68 §4.4) — signed when a
 * secret is given, unsigned when it is not, and bounded by `timeoutMs`. No
 * real network call is ever made — every test injects a fake `fetch`.
 */

function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {})) as unknown as typeof fetch
}

describe('attemptWebhookDelivery', () => {
  test('a 2xx response is ok:true with the status', async () => {
    const result = await attemptWebhookDelivery('https://example.com/hook', '{}', null, { fetch: fakeFetch(() => new Response(null, { status: 204 })) })
    expect(result).toEqual({ ok: true, status: 204 })
  })

  test('a non-2xx response is ok:false with the status, not an exception', async () => {
    const result = await attemptWebhookDelivery('https://example.com/hook', '{}', null, { fetch: fakeFetch(() => new Response('nope', { status: 500 })) })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(500)
  })

  test('a network failure (thrown fetch) is ok:false with an error message, not a thrown exception', async () => {
    const throwingFetch = (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch
    const result = await attemptWebhookDelivery('https://example.com/hook', '{}', null, { fetch: throwingFetch })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('connection refused')
  })

  test('with a secret, the body is signed with a verifiable X-Enkaku-Signature header', async () => {
    let capturedHeaders: Record<string, string> = {}
    const body = JSON.stringify({ id: 'n1' })
    await attemptWebhookDelivery(
      'https://example.com/hook',
      body,
      'the-secret',
      { fetch: fakeFetch((_url, init) => {
        capturedHeaders = Object.fromEntries(new Headers(init.headers as Record<string, string>).entries())
        return new Response(null, { status: 200 })
      }), now: () => 1_700_000_000 },
    )
    const header = capturedHeaders['x-enkaku-signature']
    expect(header).toBeDefined()
    expect(parseWebhookSignatureHeader(header!)?.timestamp).toBe(1_700_000_000)
    expect(verifyWebhookSignature(body, 'the-secret', header!, { now: 1_700_000_000 })).toBe(true)
  })

  test('without a secret, no signature header is sent — an unsigned endpoint is a deliberate choice, not a silent gap', async () => {
    let capturedHeaders: Record<string, string> = {}
    await attemptWebhookDelivery('https://example.com/hook', '{}', null, {
      fetch: fakeFetch((_url, init) => {
        capturedHeaders = Object.fromEntries(new Headers(init.headers as Record<string, string>).entries())
        return new Response(null, { status: 200 })
      }),
    })
    expect(capturedHeaders['x-enkaku-signature']).toBeUndefined()
  })

  test('a hanging receiver is aborted at the timeout rather than hanging the caller forever', async () => {
    const hangingFetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')))
      })) as unknown as typeof fetch
    const result = await attemptWebhookDelivery('https://example.com/hook', '{}', null, { fetch: hangingFetch }, 20)
    expect(result.ok).toBe(false)
  })
})
