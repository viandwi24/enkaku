import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../../db'
import { agentMessages } from '../../db/schema'
import { createThreadStore } from './store'

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  return { db, store: createThreadStore(db) }
}

describe('thread store (plan 66 §3.1, §4.1, §7)', () => {
  test('creates a thread and reads it back', () => {
    const { store } = setUp()
    const thread = store.createThread({ agentId: 'a1', title: 'hello' })
    expect(store.getThread(thread.id)).toEqual(thread)
  })

  test('appendMessage assigns a monotonic seq per thread, starting at 1', () => {
    const { store } = setUp()
    const thread = store.createThread({ agentId: 'a1' })
    const m1 = store.appendMessage({ threadId: thread.id, runId: null, role: 'user', content: [{ type: 'text', text: 'hi' }] })
    const m2 = store.appendMessage({ threadId: thread.id, runId: null, role: 'assistant', content: [{ type: 'text', text: 'hello' }] })
    expect(m1.seq).toBe(1)
    expect(m2.seq).toBe(2)
  })

  test('(threadId, seq) is unique — a raw double insert at the same seq is rejected by the DB', () => {
    const { db, store } = setUp()
    const thread = store.createThread({ agentId: 'a1' })
    store.appendMessage({ threadId: thread.id, runId: null, role: 'user', content: [{ type: 'text', text: 'one' }] })
    // Bypass the store's own seq assignment to prove the DB-level guarantee (criterion 15),
    // not just that the store's happy path never collides.
    expect(() =>
      db
        .insert(agentMessages)
        .values({ id: crypto.randomUUID(), threadId: thread.id, runId: null, seq: 1, role: 'user', content: [{ type: 'text', text: 'two' }], createdAt: new Date() })
        .run(),
    ).toThrow()
  })

  test('two threads have independent seq counters', () => {
    const { store } = setUp()
    const t1 = store.createThread({ agentId: 'a1' })
    const t2 = store.createThread({ agentId: 'a1' })
    const m1 = store.appendMessage({ threadId: t1.id, runId: null, role: 'user', content: [{ type: 'text', text: 'a' }] })
    const m2 = store.appendMessage({ threadId: t2.id, runId: null, role: 'user', content: [{ type: 'text', text: 'b' }] })
    expect(m1.seq).toBe(1)
    expect(m2.seq).toBe(1)
  })

  test('listMessages(after=) returns only messages with a greater seq — the client gap-detection primitive', () => {
    const { store } = setUp()
    const thread = store.createThread({ agentId: 'a1' })
    store.appendMessage({ threadId: thread.id, runId: null, role: 'user', content: [{ type: 'text', text: '1' }] })
    store.appendMessage({ threadId: thread.id, runId: null, role: 'assistant', content: [{ type: 'text', text: '2' }] })
    store.appendMessage({ threadId: thread.id, runId: null, role: 'user', content: [{ type: 'text', text: '3' }] })
    const after1 = store.listMessages(thread.id, { after: 1 })
    expect(after1.map((m) => m.seq)).toEqual([2, 3])
  })

  test('createRun starts queued with zero steps; updateRun patches only what is given', () => {
    const { store } = setUp()
    const thread = store.createThread({ agentId: 'a1' })
    const run = store.createRun(thread.id)
    expect(run.status).toBe('queued')
    expect(run.steps).toBe(0)
    const updated = store.updateRun(run.id, { status: 'running', startedAt: new Date() })
    expect(updated.status).toBe('running')
    expect(updated.startedAt).not.toBeNull()
    const stepped = store.updateRun(run.id, { steps: 3 })
    expect(stepped.steps).toBe(3)
    expect(stepped.status).toBe('running') // untouched by the steps-only patch
  })

  test('recoverInterruptedRuns marks a running run failed/interrupted, and leaves a paused run alone', () => {
    const { store } = setUp()
    const thread = store.createThread({ agentId: 'a1' })
    const running = store.createRun(thread.id)
    store.updateRun(running.id, { status: 'running', startedAt: new Date() })
    const paused = store.createRun(thread.id)
    store.updateRun(paused.id, { status: 'paused', startedAt: new Date() })
    const queued = store.createRun(thread.id)

    const recovered = store.recoverInterruptedRuns()
    expect(recovered.map((r) => r.id).sort()).toEqual([running.id].sort())
    expect(store.getRun(running.id)?.status).toBe('failed')
    expect(store.getRun(running.id)?.stopReason).toBe('error')
    expect(store.getRun(paused.id)?.status).toBe('paused')
    expect(store.getRun(queued.id)?.status).toBe('queued')
  })

  test('listThreads scopes by agentId and returns every thread created for it', () => {
    const { store } = setUp()
    const t1 = store.createThread({ agentId: 'a1' })
    const t2 = store.createThread({ agentId: 'a1' })
    store.createThread({ agentId: 'a2' }) // a different agent — must not leak into a1's list
    const threads = store.listThreads({ agentId: 'a1' })
    // `createdAt` has one-second resolution, so two threads created in the same test tick can tie;
    // the ordering tiebreak is not the property under test here — completeness and scoping are.
    expect(threads.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort())
  })
})
