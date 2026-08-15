import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { commandRunMembers } from '../db/schema'
import { EnkakuError } from '../util/errors'
import { createCommandRunStore, type CommandRunStore } from './store'

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof EnkakuError) return err.code
    throw err
  }
  throw new Error('expected fn() to throw')
}

function membersOf(db: Db, runId: string) {
  return db.select().from(commandRunMembers).where(eq(commandRunMembers.runId, runId)).all()
}

function setUp(): { db: Db; store: CommandRunStore } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return { db: opened.db, store: createCommandRunStore(opened.db) }
}

function createRun(
  store: CommandRunStore,
  opts: { cmd?: string; createdBy?: string | null; deviceIds?: string[]; startedAt?: Date },
) {
  return store.create({
    cmd: opts.cmd ?? 'getprop ro.build.version.release',
    target: { deviceIds: opts.deviceIds ?? ['device-a'] },
    createdBy: opts.createdBy ?? 'user-1',
    members: (opts.deviceIds ?? ['device-a']).map((deviceId) => ({ deviceId })),
    startedAt: opts.startedAt,
  })
}

describe('CommandRunStore.create — plan 93 §3.4, §4.2', () => {
  test('inserts the run and one pending member per target device, in array order', () => {
    const { store } = setUp()
    const run = createRun(store, { deviceIds: ['a', 'b', 'c'] })
    expect(run.status).toBe('running')
    expect(run.members).toHaveLength(3)
    expect(run.members.map((m) => m.deviceId)).toEqual(['a', 'b', 'c'])
    expect(run.members.every((m) => m.status === 'pending')).toBe(true)
    expect(run.members.map((m) => m.seq)).toEqual([0, 1, 2])
  })

  test('the target JSON round-trips through the local CommandTargetSchema', () => {
    const { store } = setUp()
    const run = store.create({
      cmd: 'true',
      target: { clusterId: 'pool:smoke' },
      createdBy: null,
      members: [{ deviceId: 'x' }],
    })
    expect(run.target).toEqual({ clusterId: 'pool:smoke' })
  })

  test('a single-device run is exactly a run with ONE member (plan 93 §3.3) — no special case', () => {
    const { store } = setUp()
    const run = createRun(store, { deviceIds: ['solo'] })
    expect(run.members).toHaveLength(1)
  })
})

describe('CommandRunStore.recordSingle — plan 93 §3.3, §3.17, step 93.5 (`shell.exec`\'s own entry point)', () => {
  test('builds a one-member run targeting exactly the given device, moved straight to running', () => {
    const { store } = setUp()
    const run = store.recordSingle({ cmd: 'getprop ro.serialno', deviceId: 'dev-1', actor: 'user-1' })
    expect(run.cmd).toBe('getprop ro.serialno')
    expect(run.target).toEqual({ deviceIds: ['dev-1'] })
    expect(run.createdBy).toBe('user-1')
    expect(run.members).toHaveLength(1)
    expect(run.members[0]?.deviceId).toBe('dev-1')
    // `create()` alone always leaves a fresh member `pending` — this is the
    // one thing `recordSingle` adds on top: the lease check already passed
    // by the time `ws-handlers.ts` calls it, so there is no admission phase
    // left to represent, unlike a fan-out member (`runner.ts`'s `admitMember`).
    expect(run.members[0]?.status).toBe('running')
  })

  test('accepts a null actor — local mode\'s implicit admin has no userId', () => {
    const { store } = setUp()
    const run = store.recordSingle({ cmd: 'true', deviceId: 'dev-1', actor: null })
    expect(run.createdBy).toBeNull()
  })

  test('is a genuine convenience over create + updateMember, not a second row shape: updateMember/finish work on its id exactly as on any other run', () => {
    const { store } = setUp()
    const run = store.recordSingle({ cmd: 'true', deviceId: 'dev-1', actor: 'user-1' })
    store.updateMember(run.id, 'dev-1', { status: 'ok', exitCode: 0, stdout: '', stderr: '', durationMs: 12 })
    store.finish(run.id, { status: 'ok' })
    const fetched = store.get(run.id)
    expect(fetched?.status).toBe('ok')
    expect(fetched?.members[0]?.status).toBe('ok')
    expect(fetched?.members[0]?.exitCode).toBe(0)
  })

  test('appears in listPage exactly like a fan-out run — one history, not two (plan 93 §3.3)', () => {
    const { store } = setUp()
    store.recordSingle({ cmd: 'terminal cmd', deviceId: 'dev-1', actor: 'user-1' })
    createRun(store, { cmd: 'fanout cmd', createdBy: 'user-1', deviceIds: ['dev-1', 'dev-2'] })
    const page = store.listPage({ createdBy: 'user-1', deviceId: null, q: null, status: null, cursor: null, limit: 10 })
    expect(page.items.map((r) => r.cmd).sort()).toEqual(['fanout cmd', 'terminal cmd'])
  })
})

describe('CommandRunStore.updateMember / finish — plan 93 §4.5', () => {
  test('updateMember partially updates one member, leaving siblings untouched', () => {
    const { store } = setUp()
    const run = createRun(store, { deviceIds: ['a', 'b'] })
    store.updateMember(run.id, 'a', { status: 'ok', exitCode: 0, stdout: '13\n', outputHash: 'h1' })

    const fetched = store.get(run.id)!
    const a = fetched.members.find((m) => m.deviceId === 'a')!
    const b = fetched.members.find((m) => m.deviceId === 'b')!
    expect(a.status).toBe('ok')
    expect(a.exitCode).toBe(0)
    expect(a.stdout).toBe('13\n')
    expect(b.status).toBe('pending')
  })

  test('a skip is recorded verbatim under `skip`, never a paraphrase (plan 93 §3.8)', () => {
    const { store } = setUp()
    const run = createRun(store, { deviceIds: ['held'] })
    store.updateMember(run.id, 'held', { status: 'skipped', skipCode: 'not_lease_holder', skipMessage: 'another client is controlling this device' })
    const member = store.get(run.id)!.members[0]!
    expect(member.status).toBe('skipped')
    expect(member.skip).toEqual({ code: 'not_lease_holder', message: 'another client is controlling this device' })
  })

  test('updateMember on a nonexistent member throws command_run_member_not_found', () => {
    const { store } = setUp()
    const run = createRun(store, { deviceIds: ['a'] })
    expect(codeOf(() => store.updateMember(run.id, 'nope', { status: 'ok' }))).toBe('command_run_member_not_found')
  })

  test('finish sets the run terminal and stamps finishedAt', () => {
    const { store } = setUp()
    const run = createRun(store, { deviceIds: ['a'] })
    expect(run.finishedAt).toBeNull()
    store.finish(run.id, { status: 'ok' })
    const fetched = store.get(run.id)!
    expect(fetched.status).toBe('ok')
    expect(fetched.finishedAt).not.toBeNull()
  })

  test('finish on a nonexistent run throws run_not_found', () => {
    const { store } = setUp()
    expect(codeOf(() => store.finish('nope', { status: 'ok' }))).toBe('run_not_found')
  })
})

describe('CommandRunStore.get — plan 93 §4.4', () => {
  test('returns null for a run that does not exist', () => {
    const { store } = setUp()
    expect(store.get('nope')).toBeNull()
  })
})

describe('CommandRunStore.listPage — keyset paging (plan 93 §3.9, §4.2, via api/pagination.ts)', () => {
  test('pages through (startedAt DESC, id DESC), newest first, with no gaps or repeats', () => {
    const { store } = setUp()
    const base = Date.now()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const run = createRun(store, { createdBy: 'user-1', startedAt: new Date(base + i * 1000) })
      ids.push(run.id)
    }
    // Newest (i=4) first.
    const expectedOrder = [...ids].reverse()

    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const result = store.listPage({ cursor, limit: 2 })
      seen.push(...result.items.map((r) => r.id))
      cursor = result.nextCursor
      if (!cursor) break
    }
    expect(seen).toEqual(expectedOrder)
  })

  test('counts roll up per-status from command_run_members', () => {
    const { store } = setUp()
    const run = createRun(store, { deviceIds: ['a', 'b', 'c'] })
    store.updateMember(run.id, 'a', { status: 'ok' })
    store.updateMember(run.id, 'b', { status: 'failed' })
    // 'c' stays pending.
    const page = store.listPage({ cursor: null, limit: 10 })
    const summary = page.items.find((r) => r.id === run.id)!
    expect(summary.counts).toEqual({ total: 3, pending: 1, running: 0, ok: 1, failed: 1, skipped: 0, cancelled: 0 })
  })

  test('createdBy filters to one user\'s own runs ("?mine=1", plan 93 §3.9)', () => {
    const { store } = setUp()
    createRun(store, { createdBy: 'alice' })
    createRun(store, { createdBy: 'bob' })
    const page = store.listPage({ createdBy: 'alice', cursor: null, limit: 10 })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.createdBy).toBe('alice')
  })

  test('deviceId filters to runs that targeted that device', () => {
    const { store } = setUp()
    const withA = createRun(store, { deviceIds: ['a', 'b'] })
    createRun(store, { deviceIds: ['b', 'c'] })
    const page = store.listPage({ deviceId: 'a', cursor: null, limit: 10 })
    expect(page.items.map((r) => r.id)).toEqual([withA.id])
  })

  test('q substring-matches cmd', () => {
    const { store } = setUp()
    const match = createRun(store, { cmd: 'pm list packages' })
    createRun(store, { cmd: 'getprop ro.build.version.release' })
    const page = store.listPage({ q: 'list packages', cursor: null, limit: 10 })
    expect(page.items.map((r) => r.id)).toEqual([match.id])
  })

  test('status filters to a run status', () => {
    const { store } = setUp()
    const run = createRun(store, {})
    store.finish(run.id, { status: 'failed' })
    createRun(store, {}) // stays 'running'
    const page = store.listPage({ status: 'failed', cursor: null, limit: 10 })
    expect(page.items.map((r) => r.id)).toEqual([run.id])
  })
})

describe('CommandRunStore.trimForUser — per-user cap (plan 93 §3.9 commandRunsPerUser, §5 step 93.2)', () => {
  test('deletes the oldest runs beyond the cap, oldest-first, leaving the newest N', () => {
    const { store } = setUp()
    const base = Date.now()
    const runs = Array.from({ length: 5 }, (_, i) => createRun(store, { createdBy: 'user-1', startedAt: new Date(base + i * 1000) }))

    const deletedCount = store.trimForUser('user-1', 3)
    expect(deletedCount).toBe(2)

    // The two oldest (index 0, 1) are gone; the three newest survive.
    expect(store.get(runs[0]!.id)).toBeNull()
    expect(store.get(runs[1]!.id)).toBeNull()
    expect(store.get(runs[2]!.id)).not.toBeNull()
    expect(store.get(runs[3]!.id)).not.toBeNull()
    expect(store.get(runs[4]!.id)).not.toBeNull()
  })

  test('a trimmed run\'s members are deleted with it, not orphaned', () => {
    const { store, db } = setUp()
    const base = Date.now()
    const runs = Array.from({ length: 3 }, (_, i) => createRun(store, { createdBy: 'user-1', deviceIds: ['a', 'b'], startedAt: new Date(base + i * 1000) }))
    store.trimForUser('user-1', 1)
    const remaining = membersOf(db, runs[0]!.id)
    expect(remaining).toHaveLength(0)
  })

  test('under the cap, nothing is deleted', () => {
    const { store } = setUp()
    createRun(store, { createdBy: 'user-1' })
    expect(store.trimForUser('user-1', 500)).toBe(0)
  })

  test('never touches another user\'s runs', () => {
    const { store } = setUp()
    const base = Date.now()
    Array.from({ length: 5 }, (_, i) => createRun(store, { createdBy: 'user-1', startedAt: new Date(base + i * 1000) }))
    const bobRun = createRun(store, { createdBy: 'bob' })
    store.trimForUser('user-1', 1)
    expect(store.get(bobRun.id)).not.toBeNull()
  })
})

describe('CommandRunStore.sweepOrphans — boot sweep (plan 93 §3.7, mirroring failOrphanRunning/F29)', () => {
  test('a non-terminal run becomes cancelled, and its pending/running members become cancelled with "the core restarted"', () => {
    const { store } = setUp()
    const run = createRun(store, { deviceIds: ['a', 'b', 'c'] })
    store.updateMember(run.id, 'a', { status: 'running' })
    store.updateMember(run.id, 'b', { status: 'ok', exitCode: 0 }) // already terminal — must be left alone
    // 'c' stays pending.

    const swept = store.sweepOrphans()
    expect(swept).toBe(1)

    const fetched = store.get(run.id)!
    expect(fetched.status).toBe('cancelled')
    const a = fetched.members.find((m) => m.deviceId === 'a')!
    const b = fetched.members.find((m) => m.deviceId === 'b')!
    const c = fetched.members.find((m) => m.deviceId === 'c')!
    expect(a.status).toBe('cancelled')
    expect(a.error).toBe('the core restarted')
    expect(b.status).toBe('ok') // untouched — it had already finished
    expect(c.status).toBe('cancelled')
    expect(c.error).toBe('the core restarted')
  })

  test('an awaiting-continue run is swept too (a staged run left waiting across a restart)', () => {
    const { store, db } = setUp()
    const run = createRun(store, { deviceIds: ['a'] })
    db.run(`UPDATE command_runs SET status = 'awaiting-continue' WHERE id = '${run.id}'`)
    expect(store.sweepOrphans()).toBe(1)
    expect(store.get(run.id)!.status).toBe('cancelled')
  })

  test('a run already terminal (ok/failed/cancelled) is left untouched, and sweeping an all-terminal DB is a no-op', () => {
    const { store } = setUp()
    const run = createRun(store, {})
    store.finish(run.id, { status: 'ok' })
    expect(store.sweepOrphans()).toBe(0)
    expect(store.get(run.id)!.status).toBe('ok')
  })
})

describe('CommandRunStore.deleteRun — cascading delete (plan 93 §5 step 93.2 verifiable result)', () => {
  test('deletes the run AND its members', () => {
    const { store, db } = setUp()
    const run = createRun(store, { deviceIds: ['a', 'b'] })
    expect(store.deleteRun(run.id)).toBe(true)
    expect(store.get(run.id)).toBeNull()
    const remainingMembers = membersOf(db, run.id)
    expect(remainingMembers).toHaveLength(0)
  })

  test('returns false for a run that does not exist', () => {
    const { store } = setUp()
    expect(store.deleteRun('nope')).toBe(false)
  })

  test('deleting one run never touches a sibling run\'s members', () => {
    const { store, db } = setUp()
    const runA = createRun(store, { deviceIds: ['a'] })
    const runB = createRun(store, { deviceIds: ['a'] })
    store.deleteRun(runA.id)
    const remaining = membersOf(db, runB.id)
    expect(remaining).toHaveLength(1)
  })
})
