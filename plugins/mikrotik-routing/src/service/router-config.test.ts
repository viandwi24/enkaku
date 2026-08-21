import { describe, expect, test } from 'bun:test'
import { loadRouterConfig } from './router-config'

/**
 * `loadRouterConfig` — factored out of `handlers.ts` at step 122.6 so
 * `apply.ts` refuses with the exact same two messages rather than a second
 * copy. This pins those two messages so a future edit to either file cannot
 * silently diverge them.
 */

describe('loadRouterConfig', () => {
  test('nothing saved → ok:false naming the Settings tab', async () => {
    const result = await loadRouterConfig(async () => undefined)
    expect(result).toEqual({ ok: false, message: 'No router connection has been saved yet. Open the Settings tab and save one.' })
  })

  test('null (a deleted row) is treated the same as never having saved one', async () => {
    const result = await loadRouterConfig(async () => null)
    expect(result.ok).toBe(false)
  })

  test('an incomplete connection (e.g. no password) is refused by name, not handed back as ok', async () => {
    const result = await loadRouterConfig(async () => ({ baseUrl: '192.168.1.1', username: 'admin', password: '', tls: false, timeoutMs: 2000 }))
    expect(result).toEqual({ ok: false, message: 'The saved router connection is missing an address, a username, or a password. Open the Settings tab and save a complete connection.' })
  })

  test('a complete connection reads back verbatim', async () => {
    const stored = { baseUrl: '192.168.1.1', username: 'admin', password: 'x', tls: true, timeoutMs: 3000 }
    const result = await loadRouterConfig(async () => stored)
    expect(result).toEqual({ ok: true, config: stored })
  })
})
