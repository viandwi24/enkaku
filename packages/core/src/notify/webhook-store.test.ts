import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { createWebhookStore } from './webhook-store'

/**
 * Farm-level webhook endpoint CRUD (plan 68 §3.4, §4.1) — the secret is
 * write-only, encrypted via the `'webhook'` namespace of `../secrets/store.
 * ts` (an ADDED namespace, not a third mechanism — see that file). Rolling
 * delivery health (`lastStatus`/`failureCount`) is what makes a dead
 * endpoint visible in settings (criterion 11).
 */

function setUp() {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const db = opened.db as Db
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-webhook-store-test-'))
  return { db, store: createWebhookStore({ db, dataDir }) }
}

describe('createWebhookStore', () => {
  test('create never returns the secret — only `configured`', () => {
    const { store } = setUp()
    const endpoint = store.create({ name: 'slack', url: 'https://hooks.example.com/x', secret: 'shh' })
    expect(JSON.stringify(endpoint)).not.toContain('shh')
    expect(endpoint.configured).toBe(true)
    expect(endpoint.enabled).toBe(true)
    expect(endpoint.lastStatus).toBeNull()
    expect(endpoint.failureCount).toBe(0)
  })

  test('a secret round-trips through resolveSecret, and only through it', () => {
    const { store } = setUp()
    const endpoint = store.create({ name: 'pagerduty', url: 'https://example.com/hook', secret: 'top-secret-value' })
    expect(store.resolveSecret(endpoint.id)).toBe('top-secret-value')
  })

  test('an endpoint with no secret configures cleanly and signs nothing (resolveSecret is null)', () => {
    const { store } = setUp()
    const endpoint = store.create({ name: 'unsigned', url: 'https://example.com/hook' })
    expect(endpoint.configured).toBe(false)
    expect(store.resolveSecret(endpoint.id)).toBeNull()
  })

  test('duplicate names are refused', () => {
    const { store } = setUp()
    store.create({ name: 'dup', url: 'https://example.com/a' })
    expect(() => store.create({ name: 'dup', url: 'https://example.com/b' })).toThrow()
  })

  test('getRowByName finds an endpoint by its name — the only lookup notify.send is allowed to use', () => {
    const { store } = setUp()
    const endpoint = store.create({ name: 'on-call', url: 'https://example.com/hook' })
    expect(store.getRowByName('on-call')?.id).toBe(endpoint.id)
    expect(store.getRowByName('does-not-exist')).toBeNull()
  })

  test('update can change the url, enabled flag, and secret independently', () => {
    const { store } = setUp()
    const endpoint = store.create({ name: 'e1', url: 'https://a.example.com', secret: 'first' })
    const updated = store.update(endpoint.id, { enabled: false })
    expect(updated.enabled).toBe(false)
    expect(updated.url).toBe('https://a.example.com') // untouched
    expect(store.resolveSecret(endpoint.id)).toBe('first') // untouched

    const reSecreted = store.update(endpoint.id, { secret: 'second' })
    expect(reSecreted.configured).toBe(true)
    expect(store.resolveSecret(endpoint.id)).toBe('second')
  })

  test('remove deletes the endpoint', () => {
    const { store } = setUp()
    const endpoint = store.create({ name: 'gone', url: 'https://example.com' })
    store.remove(endpoint.id)
    expect(store.get(endpoint.id)).toBeNull()
  })

  test('remove on an unknown id throws', () => {
    const { store } = setUp()
    expect(() => store.remove('no-such-id')).toThrow()
  })

  test('recordDeliveryResult(ok) resets failureCount to 0; recordDeliveryResult(failed) increments it (criterion 11)', () => {
    const { store } = setUp()
    const endpoint = store.create({ name: 'health', url: 'https://example.com' })
    store.recordDeliveryResult(endpoint.id, 'failed')
    store.recordDeliveryResult(endpoint.id, 'failed')
    let got = store.get(endpoint.id)!
    expect(got.failureCount).toBe(2)
    expect(got.lastStatus).toBe('failed')

    store.recordDeliveryResult(endpoint.id, 'ok')
    got = store.get(endpoint.id)!
    expect(got.failureCount).toBe(0)
    expect(got.lastStatus).toBe('ok')
    expect(got.lastAttemptAt).not.toBeNull()
  })

  test('list returns every endpoint', () => {
    const { store } = setUp()
    store.create({ name: 'first', url: 'https://a.example.com' })
    store.create({ name: 'second', url: 'https://b.example.com' })
    const names = store.list().map((e) => e.name).sort()
    expect(names).toEqual(['first', 'second'])
  })
})
