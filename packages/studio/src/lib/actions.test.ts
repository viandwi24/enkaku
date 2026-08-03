import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { api } from './actions'

/**
 * `api()`'s POST-default (plan 42 §3.3, §4.3, §6.6): `FilesPanel`'s
 * install/push/pull calls used to pass `json` with no explicit `method`,
 * `fetch` defaulted to GET, and the browser refused a GET with a body. The
 * fix is two lines — default to POST whenever `json` is present, spread
 * BEFORE `...rest` so an explicit `method` still wins — and this is the unit
 * test the plan calls for covering both directions.
 */
describe('api()', () => {
  let calls: { url: string; init: RequestInit }[]
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    calls = []
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function stubFetch(body: unknown = {}, ok = true): void {
    globalThis.fetch = mock(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify(body), {
        status: ok ? 200 : 400,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
  }

  test('a json body defaults to POST when no method is given', async () => {
    stubFetch()
    await api('/api/devices/d1/install', { json: { artifactId: 'a1' } })
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.body).toBe(JSON.stringify({ artifactId: 'a1' }))
  })

  test("a caller's own explicit method still wins over the json default", async () => {
    stubFetch()
    await api('/api/devices/d1', { method: 'PATCH', json: { label: 'renamed' } })
    expect(calls[0]?.init.method).toBe('PATCH')
    expect(calls[0]?.init.body).toBe(JSON.stringify({ label: 'renamed' }))
  })

  test('no json body means no method is forced — the native fetch default applies', async () => {
    stubFetch()
    await api('/api/devices')
    expect(calls[0]?.init.method).toBeUndefined()
    expect(calls[0]?.init.body).toBeUndefined()
  })

  test('a json body still carries the content-type header', async () => {
    stubFetch()
    await api('/api/devices/d1/push', { json: { artifactId: 'a1', remotePath: '/sdcard/x' } })
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
  })
})
