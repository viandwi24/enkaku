import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod'
import { api, BadResponseError, describeApiError, issuesFromError } from './actions'

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
   * `invalid_job_params` (plan 95 §3.7, §4.3, §4.8, fixes F12) — `api()` used
   * to throw only `{ code, message }`, so `RunScriptDialog`/
   * `ScheduleEditorDialog` had no field-level data to attach to
   * `SchemaForm`'s `serverErrors` even after the core started sending it.
   */
  test('an {error} body carrying `issues` throws them through, unchanged', async () => {
    stubFetch({ error: { code: 'invalid_job_params', message: 'videos: must be at most 2000', issues: [{ path: 'videos', message: 'must be at most 2000' }] } }, false)
    await expect(api('/api/jobs', z.unknown())).rejects.toMatchObject({
      code: 'invalid_job_params',
      issues: [{ path: 'videos', message: 'must be at most 2000' }],
    })
  })

  test('an {error} body with no `issues` throws with `issues` simply absent', async () => {
    stubFetch({ error: { code: 'device_not_found', message: 'no such device' } }, false)
    let caught: unknown
    try {
      await api('/api/devices/nope', z.unknown())
    } catch (err) {
      caught = err
    }
    expect(caught && typeof caught === 'object' && 'issues' in caught).toBe(false)
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

/**
 * `useAction().run()`'s catch block routes every thrown error through this —
 * `auth.forbidden` is the code `requirePermission` (`packages/core/src/auth/middleware.ts`)
 * and the couple of hand-written admin-only checks (e.g. `PATCH
 * /api/devices/:id`'s ownerId transition) both send, and it becomes a
 * legible, actionable message here rather than the server's own
 * `requires the tool.manage permission` — a permission NAME, not
 * something a user chose. This is the "still legible if a 403 reaches
 * the UI" fallback for a control this task disables (a race, a role
 * changed in another tab) rather than the normal path (normally the
 * button is already disabled and never fires the request at all).
 */
describe('describeApiError()', () => {
  test('auth.forbidden gets a plain-English rewrite, not the permission name', () => {
    const err = Object.assign(new Error('requires the tool.manage permission'), { code: 'auth.forbidden' })
    expect(describeApiError(err)).toBe('Your role does not allow this — ask an admin.')
  })

  test('every other code keeps the server-provided message verbatim', () => {
    const err = Object.assign(new Error('adb can no longer see this device'), { code: 'device_not_found' })
    expect(describeApiError(err)).toBe('adb can no longer see this device')
  })

  test('a non-Error, non-coded throw still stringifies rather than throwing again', () => {
    expect(describeApiError('network down')).toBe('network down')
  })

  /**
   * Reported from the owner's farm, 2026-08-26: an APK install answered 403
   * and the toast said "Your role does not allow this — ask an admin." The
   * server had actually sent `you do not have permission to run
   * internal:install (requires device.files)`, which names the exact gate and
   * points at a farm SETTING (`shell.mode`), not at a role anyone could grant.
   * Placing it took a read of the core's source.
   *
   * So the rewrite is now scoped to `requirePermission`'s own template — a
   * bare permission name, the thing it was written for — and every
   * hand-written 403 sentence reaches the operator intact.
   */
  test("a hand-written auth.forbidden sentence reaches the operator verbatim — it names a gate the generic line cannot", () => {
    const err = Object.assign(new Error('you do not have permission to run internal:install (requires device.files)'), { code: 'auth.forbidden' })
    expect(describeApiError(err)).toBe('you do not have permission to run internal:install (requires device.files)')
  })

  test('a farm-setting refusal survives too — nobody can fix this by changing a role', () => {
    const err = Object.assign(new Error('file transfer is disabled for this farm (transfer.enabled)'), { code: 'auth.forbidden' })
    expect(describeApiError(err)).toBe('file transfer is disabled for this farm (transfer.enabled)')
  })

  test('an auth.forbidden with no message at all still gets the generic line rather than an empty toast', () => {
    expect(describeApiError(Object.assign(new Error(''), { code: 'auth.forbidden' }))).toBe('Your role does not allow this — ask an admin.')
  })

  test('the permission-name rewrite matches the template exactly, not anything containing it', () => {
    // `requires the device.files permission` (bare) is the machine-ish one.
    // A sentence that merely mentions a permission is an author's own writing.
    const bare = Object.assign(new Error('requires the device.files permission'), { code: 'auth.forbidden' })
    const written = Object.assign(new Error('this batch requires the device.files permission on every target'), { code: 'auth.forbidden' })
    expect(describeApiError(bare)).toBe('Your role does not allow this — ask an admin.')
    expect(describeApiError(written)).toBe('this batch requires the device.files permission on every target')
  })
})

/**
 * `issuesFromError` (plan 95 §3.7, §5 step 95.6, fixes F12) — turns the
 * `issues` array `api()` now throws through into the `Record<path,
 * message>` shape `SchemaForm`'s `serverErrors` prop takes, so
 * `RunScriptDialog`/`ScheduleEditorDialog` can spread it straight in.
 */
describe('issuesFromError()', () => {
  test('an error with issues is keyed by path', () => {
    const err = Object.assign(new Error('videos: must be at most 2000'), {
      code: 'invalid_job_params',
      issues: [{ path: 'videos', message: 'must be at most 2000' }],
    })
    expect(issuesFromError(err)).toEqual({ videos: 'must be at most 2000' })
  })

  test('several issues all appear', () => {
    const err = Object.assign(new Error('bad'), {
      code: 'invalid_job_params',
      issues: [
        { path: 'videos', message: 'must be at most 2000' },
        { path: 'mode', message: 'required' },
      ],
    })
    expect(issuesFromError(err)).toEqual({ videos: 'must be at most 2000', mode: 'required' })
  })

  test('an error with no issues returns undefined, not an empty object', () => {
    const err = Object.assign(new Error('no such device'), { code: 'device_not_found' })
    expect(issuesFromError(err)).toBeUndefined()
  })

  test('a non-object, non-Error throw returns undefined rather than throwing again', () => {
    expect(issuesFromError('network down')).toBeUndefined()
    expect(issuesFromError(null)).toBeUndefined()
    expect(issuesFromError(undefined)).toBeUndefined()
  })
})
