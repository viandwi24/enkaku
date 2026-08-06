import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { createNotificationStore } from './store'

/**
 * The in-app notification row (plan 68 §3.4, §4.1) — always written, nothing
 * to configure, and the record even when a webhook fails. `notify/service.
 * test.ts` covers the "written first" ordering; this file covers the store
 * itself: create, list, unread counting, mark-read, mark-all-read.
 */

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db as Db
}

describe('createNotificationStore', () => {
  test('create returns a fully-populated, unread notification', () => {
    const store = createNotificationStore(setUp())
    const n = store.create({ level: 'info', title: 'hello', body: 'world', source: 'system' })
    expect(n.id).toBeTruthy()
    expect(n.level).toBe('info')
    expect(n.title).toBe('hello')
    expect(n.body).toBe('world')
    expect(n.source).toBe('system')
    expect(n.readAt).toBeNull()
    expect(n.createdAt).toBeGreaterThan(0)
  })

  test('context defaults to null when omitted, and round-trips when given', () => {
    const store = createNotificationStore(setUp())
    const bare = store.create({ level: 'info', title: 'no context', source: 'system' })
    expect(bare.context).toBeNull()
    const withCtx = store.create({ level: 'warn', title: 'has context', source: 'agent:a1', context: { runId: 'r1', threadId: 't1' } })
    expect(withCtx.context).toEqual({ runId: 'r1', threadId: 't1' })
  })

  test('list returns every notification', () => {
    const store = createNotificationStore(setUp())
    store.create({ level: 'info', title: 'first', source: 'system' })
    store.create({ level: 'info', title: 'second', source: 'system' })
    const titles = store.list().map((i) => i.title).sort()
    expect(titles).toEqual(['first', 'second'])
  })

  test('list respects limit', () => {
    const store = createNotificationStore(setUp())
    for (let i = 0; i < 5; i++) store.create({ level: 'info', title: `n${i}`, source: 'system' })
    expect(store.list({ limit: 2 })).toHaveLength(2)
  })

  test('list(unreadOnly) excludes read notifications', () => {
    const store = createNotificationStore(setUp())
    const a = store.create({ level: 'info', title: 'a', source: 'system' })
    store.create({ level: 'info', title: 'b', source: 'system' })
    store.markRead(a.id)
    const unread = store.list({ unreadOnly: true })
    expect(unread).toHaveLength(1)
    expect(unread[0]?.title).toBe('b')
  })

  test('unreadCount tracks reads accurately', () => {
    const store = createNotificationStore(setUp())
    const a = store.create({ level: 'info', title: 'a', source: 'system' })
    store.create({ level: 'info', title: 'b', source: 'system' })
    expect(store.unreadCount()).toBe(2)
    store.markRead(a.id)
    expect(store.unreadCount()).toBe(1)
  })

  test('markRead is idempotent — a second call does not disturb the original readAt', () => {
    const store = createNotificationStore(setUp())
    const a = store.create({ level: 'info', title: 'a', source: 'system' })
    const first = store.markRead(a.id)
    const second = store.markRead(a.id)
    expect(second.readAt).toBe(first.readAt)
  })

  test('markRead on an unknown id throws a coded error', () => {
    const store = createNotificationStore(setUp())
    expect(() => store.markRead('no-such-id')).toThrow()
  })

  test('markAllRead marks every unread notification and returns the count', () => {
    const store = createNotificationStore(setUp())
    store.create({ level: 'info', title: 'a', source: 'system' })
    store.create({ level: 'info', title: 'b', source: 'system' })
    const count = store.markAllRead()
    expect(count).toBe(2)
    expect(store.unreadCount()).toBe(0)
    // Idempotent — nothing left to mark.
    expect(store.markAllRead()).toBe(0)
  })

  test('get returns null for an unknown id, and the notification otherwise', () => {
    const store = createNotificationStore(setUp())
    expect(store.get('nope')).toBeNull()
    const a = store.create({ level: 'error', title: 'a', source: 'system' })
    expect(store.get(a.id)?.title).toBe('a')
  })
})
