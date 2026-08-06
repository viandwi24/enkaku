import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod'
import { api, BadResponseError } from './actions'

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
    await api('/api/devices/d1/install', z.unknown(), { json: { artifactId: 'a1' } })
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.body).toBe(JSON.stringify({ artifactId: 'a1' }))
  })

  test("a caller's own explicit method still wins over the json default", async () => {
    stubFetch()
    await api('/api/devices/d1', z.unknown(), { method: 'PATCH', json: { label: 'renamed' } })
    expect(calls[0]?.init.method).toBe('PATCH')
    expect(calls[0]?.init.body).toBe(JSON.stringify({ label: 'renamed' }))
  })

  test('no json body means no method is forced — the native fetch default applies', async () => {
    stubFetch()
    await api('/api/devices', z.unknown())
    expect(calls[0]?.init.method).toBeUndefined()
    expect(calls[0]?.init.body).toBeUndefined()
  })

  test('a json body still carries the content-type header', async () => {
    stubFetch()
    await api('/api/devices/d1/push', z.unknown(), { json: { artifactId: 'a1', remotePath: '/sdcard/x' } })
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
  })

  test('{error} unwrapping — a non-ok response throws the server-provided code and message', async () => {
    stubFetch({ error: { code: 'device_not_found', message: 'no such device' } }, false)
    await expect(api('/api/devices/nope', z.unknown())).rejects.toMatchObject({
      message: 'no such device',
      code: 'device_not_found',
    })
  })

  test('a non-ok response with no {error} body falls back to a generic HTTP message', async () => {
    stubFetch(null, false)
    await expect(api('/api/devices/nope', z.unknown())).rejects.toMatchObject({
      message: 'Request failed (HTTP 400)',
      code: 'unknown',
    })
  })

  /**
   * Plan 72 §3.3, §6.1, §6.2 — `api()` cannot be called without a schema
   * (`grep -rn "as T" packages/studio/src/lib/actions.ts` finds nothing: the
   * old `return body as T` is gone). A response matching its schema parses
   * straight through.
   */
  test('a matching response parses through the schema', async () => {
    stubFetch({ device: { id: 'd1' } })
    const result = await api('/api/devices/d1', z.object({ device: z.object({ id: z.string() }) }))
    expect(result).toEqual({ device: { id: 'd1' } })
  })

  /**
   * The regression pin for criterion 9: a response shaped like the pre-fix
   * `GET /api/v1/cap` (a bare array where an object was claimed) throws
   * `BadResponseError` naming the path — never silently returns `undefined`
   * for the field the caller actually reads.
   */
  test('a shape mismatch throws BadResponseError naming the path, not a network error', async () => {
    stubFetch([{ id: 'device.tap' }]) // the pre-fix bare-array shape
    const schema = z.object({ capabilities: z.array(z.object({ id: z.string() })) })
    let thrown: unknown
    try {
      await api('/api/v1/cap', schema)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(BadResponseError)
    expect((thrown as BadResponseError).code).toBe('E_BAD_RESPONSE')
    expect((thrown as BadResponseError).path).toBe('/api/v1/cap')
    expect((thrown as Error).message).toContain('/api/v1/cap')
  })

  test('z.void() accepts a response with no body', async () => {
    globalThis.fetch = mock(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const result = await api('/api/devices/d1/tags', z.void(), { method: 'DELETE' })
    expect(result).toBeUndefined()
  })
})
