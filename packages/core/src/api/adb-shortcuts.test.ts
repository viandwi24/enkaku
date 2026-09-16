import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import type { ShellMode } from '@enkaku/protocol'
import { createAuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { createAdbShortcutRoutes } from './adb-shortcuts'

/**
 * The gate is the point of this file.
 *
 * Shortcuts moved out of the browser precisely because the only server store
 * that existed was admin-only, so the one thing that must not regress is the
 * door: an operator on a farm whose `shell.mode` admits them may save one, and
 * the same operator on a farm whose `shell.mode` does not may only read.
 */

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function makeApp(db: Db, opts: { role?: 'admin' | 'operator' | null; mode?: ShellMode } = {}) {
  const role = opts.role === undefined ? 'admin' : opts.role
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route(
    '/',
    createAdbShortcutRoutes({ db, audit: createAuditLogger(db), shellSettings: () => ({ mode: opts.mode ?? 'operator' }) }),
  )
  return wrapper
}

const post = (app: Hono<AuthEnv>, body: unknown) => app.request('/', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

interface Shortcut {
  id: string
  name: string
  cmd: string
  position: number
  createdAt: number
}

async function list(app: Hono<AuthEnv>): Promise<Shortcut[]> {
  const body = (await (await app.request('/')).json()) as { shortcuts: Shortcut[] }
  return body.shortcuts
}

describe('POST /api/adb/shortcuts', () => {
  test('stores the normalised command, so the same command typed two ways is one shortcut', async () => {
    const db = setUp()
    const app = makeApp(db)

    const created = (await (await post(app, { name: 'Battery', cmd: 'adb shell dumpsys battery' })).json()) as { shortcut: Shortcut }
    expect(created.shortcut.cmd).toBe('dumpsys battery')

    // The same command, typed bare: a rename, not a second row.
    const again = (await (await post(app, { name: 'Battery level', cmd: 'dumpsys battery' })).json()) as { shortcut: Shortcut }
    expect(again.shortcut.id).toBe(created.shortcut.id)

    const rows = await list(app)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('Battery level')
  })

  test('refuses a command the normaliser refuses', async () => {
    const db = setUp()
    const res = await post(makeApp(db), { name: 'Nope', cmd: 'adb reboot-bootloader' })
    expect(res.status).toBe(400)
  })

  test('new shortcuts join at the end, in the order they were saved', async () => {
    const db = setUp()
    const app = makeApp(db)
    for (const name of ['One', 'Two', 'Three']) await post(app, { name, cmd: `echo ${name}` })
    expect((await list(app)).map((s) => s.name)).toEqual(['One', 'Two', 'Three'])
  })
})

describe('the write gate is the adb verb’s own', () => {
  test('an operator may save one when shell.mode admits them', async () => {
    const db = setUp()
    const res = await post(makeApp(db, { role: 'operator', mode: 'operator' }), { name: 'Uptime', cmd: 'uptime' })
    expect(res.status).toBe(201)
  })

  test('an operator may not when shell.mode is admin-only, but may still read', async () => {
    const db = setUp()
    await post(makeApp(db), { name: 'Uptime', cmd: 'uptime' })

    const app = makeApp(db, { role: 'operator', mode: 'admin' })
    expect((await post(app, { name: 'Other', cmd: 'echo hi' })).status).toBe(403)
    expect(await list(app)).toHaveLength(1)
  })

  test('shell.mode off refuses everyone', async () => {
    const db = setUp()
    expect((await post(makeApp(db, { role: 'admin', mode: 'off' }), { name: 'Uptime', cmd: 'uptime' })).status).toBe(403)
  })
})

describe('PATCH / DELETE', () => {
  test('a rename keeps the row; repointing at a command another shortcut already runs is refused', async () => {
    const db = setUp()
    const app = makeApp(db)
    const a = ((await (await post(app, { name: 'A', cmd: 'echo a' })).json()) as { shortcut: Shortcut }).shortcut
    const b = ((await (await post(app, { name: 'B', cmd: 'echo b' })).json()) as { shortcut: Shortcut }).shortcut

    const renamed = (await (
      await app.request(`/${a.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Ayy' }), headers: { 'content-type': 'application/json' } })
    ).json()) as { shortcut: Shortcut }
    expect(renamed.shortcut).toMatchObject({ id: a.id, name: 'Ayy', cmd: 'echo a' })

    const clash = await app.request(`/${b.id}`, { method: 'PATCH', body: JSON.stringify({ cmd: 'echo a' }), headers: { 'content-type': 'application/json' } })
    expect(clash.status).toBe(409)

    expect((await app.request(`/${a.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await list(app)).map((s) => s.id)).toEqual([b.id])
    expect((await app.request(`/${a.id}`, { method: 'DELETE' })).status).toBe(404)
  })
})
