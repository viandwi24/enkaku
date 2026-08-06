import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { openDb, runMigrations, type Db } from '../db'
import { EnkakuError } from '../util/errors'
import { createConnectorStore } from './connector-store'

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

function setUp(opts: { envApiKey?: () => string | undefined; fetch?: typeof fetch } = {}) {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const dataDir = mkdtempSync(join(tmpdir(), 'enkaku-connector-store-test-'))
  return {
    db: opened.db as Db,
    store: createConnectorStore({ db: opened.db, dataDir, ...(opts.envApiKey ? { envApiKey: opts.envApiKey } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) }),
  }
}

describe('connector store — credentials are write-only (plan 65 §3.6, criterion 4)', () => {
  test('GET never returns the credential, only configured + hint', () => {
    const { store } = setUp()
    const created = store.create({ name: 'anthropic-main', kind: 'anthropic', credential: 'sk-ant-api03-abcdefgh7Xq2' })
    expect(created).not.toHaveProperty('credential')
    expect(created.configured).toBe(true)
    expect(created.hint).toBe('sk-ant-…7Xq2')
    expect(JSON.stringify(created)).not.toContain('abcdefgh')

    const fetched = store.get(created.id)
    expect(fetched).not.toHaveProperty('credential')
    expect(fetched?.hint).toBe('sk-ant-…7Xq2')

    const listed = store.list()
    expect(JSON.stringify(listed)).not.toContain('abcdefgh')
  })

  test('a connector created with no credential is unconfigured, with a null hint', () => {
    const { store } = setUp()
    const created = store.create({ name: 'anthropic-empty', kind: 'anthropic' })
    expect(created.configured).toBe(false)
    expect(created.hint).toBeNull()
  })

  test('a duplicate connector name is refused', () => {
    const { store } = setUp()
    store.create({ name: 'dup', kind: 'anthropic', credential: 'x' })
    expect(() => store.create({ name: 'dup', kind: 'anthropic', credential: 'y' })).toThrow(EnkakuError)
  })

  test('replacing a credential updates the hint and resets status to unknown', () => {
    const { store } = setUp()
    const created = store.create({ name: 'rotating', kind: 'anthropic', credential: 'sk-ant-api03-oldoldold1234' })
    const updated = store.update(created.id, { credential: 'sk-ant-api03-newnewnew5678' })
    expect(updated.hint).toBe('sk-ant-…5678')
    expect(updated.status).toBe('unknown')
  })

  test('removing a connector deletes it', () => {
    const { store } = setUp()
    const created = store.create({ name: 'gone', kind: 'anthropic' })
    store.remove(created.id)
    expect(store.get(created.id)).toBeNull()
  })
})

describe('connector store — ENKAKU_ANTHROPIC_API_KEY fallback (criterion 5)', () => {
  test('the env fallback lets "Test connection" succeed with no stored credential', async () => {
    const { store } = setUp({ envApiKey: () => 'sk-ant-env-fallback-key', fetch: fakeFetch(200, { data: [], has_more: false, first_id: null, last_id: null }) })
    const created = store.create({ name: 'no-credential', kind: 'anthropic' })
    expect(created.configured).toBe(false)
    const result = await store.test(created.id)
    // Reaching the provider at all (rather than the "no credential" short-circuit)
    // proves the env var was used as the API key.
    expect(result.status).toBe('ok')
  })

  test('a stored credential wins over the env var (visible via the hint, which reflects the stored value)', () => {
    const { store } = setUp({ envApiKey: () => 'sk-ant-env-should-be-ignored' })
    const created = store.create({ name: 'has-credential', kind: 'anthropic', credential: 'sk-ant-stored-wins-0000' })
    expect(created.configured).toBe(true)
    expect(created.hint).toBe('sk-ant-…0000')
  })
})

describe('connector store — test() / "Test connection" (criterion 6, stubbed transport — no real network calls)', () => {
  test('with no credential and no env fallback, reports unauthenticated without calling the provider', async () => {
    const { store } = setUp()
    const created = store.create({ name: 'bare', kind: 'anthropic' })
    const result = await store.test(created.id)
    expect(result.status).toBe('unauthenticated')
    const after = store.get(created.id)
    expect(after?.status).toBe('unauthenticated')
    expect(after?.checkedAt).not.toBeNull()
  })

  test('reports and persists ok on a successful stubbed call', async () => {
    const { store } = setUp({ fetch: fakeFetch(200, { data: [], has_more: false, first_id: null, last_id: null }) })
    const created = store.create({ name: 'good', kind: 'anthropic', credential: 'sk-ant-good-key' })
    const result = await store.test(created.id)
    expect(result.status).toBe('ok')
    expect(store.get(created.id)?.status).toBe('ok')
  })

  test('reports and persists unauthenticated on a stubbed 401, with the provider message', async () => {
    const { store } = setUp({ fetch: fakeFetch(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) })
    const created = store.create({ name: 'bad-key', kind: 'anthropic', credential: 'sk-ant-bad-key' })
    const result = await store.test(created.id)
    expect(result.status).toBe('unauthenticated')
    expect(result.message).toBeTruthy()
    const after = store.get(created.id)
    expect(after?.status).toBe('unauthenticated')
    expect(after?.statusMessage).toBe(result.message)
  })

  test('reports and persists unreachable on a stubbed 500', async () => {
    const { store } = setUp({ fetch: fakeFetch(500, { type: 'error', error: { type: 'api_error', message: 'internal server error' } }) })
    const created = store.create({ name: 'flaky', kind: 'anthropic', credential: 'sk-ant-flaky-key' })
    const result = await store.test(created.id)
    expect(result.status).toBe('unreachable')
    expect(store.get(created.id)?.status).toBe('unreachable')
  })
})
