import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { EnkakuError } from '../util/errors'
import { createWorkflowStore } from './store'

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function sampleDoc(name: string) {
  return {
    schema: 2 as const,
    name,
    title: '',
    description: '',
    params: [],
    maxSteps: 50,
    entry: 'start',
    nodes: [
      { kind: 'start' as const, id: 'start', title: '', ui: { x: 0, y: 0 }, next: 'n0' },
      { kind: 'script' as const, id: 'n0', title: '', ui: { x: 240, y: 0 }, script: 'demo/checkout@1.0.0', params: {} },
    ],
  }
}

describe('a fresh database has workflows(name unique) and jobs.workflow_doc (plan 210 §4.1)', () => {
  test('the table and index exist', () => {
    const db = setUp()
    const cols = db.all<{ name: string }>(sql`PRAGMA table_info('workflows')`).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['id', 'name', 'doc', 'created_by', 'created_at', 'updated_at']))

    const jobCols = db.all<{ name: string }>(sql`PRAGMA table_info('jobs')`).map((c) => c.name)
    expect(jobCols).toContain('workflow_doc')

    const index = db.all<{ sql: string }>(sql`SELECT sql FROM sqlite_master WHERE name = 'idx_workflows_name'`)
    expect(index[0]?.sql).toContain('UNIQUE')
  })
})

describe('createWorkflowStore CRUD (plan 210 §4.4)', () => {
  test('create then get round-trips', () => {
    const db = setUp()
    const store = createWorkflowStore(db)
    const created = store.create({ doc: sampleDoc('checkout'), createdBy: 'u1' })
    expect(created.name).toBe('checkout')
    const got = store.get('checkout')
    expect(got?.doc).toEqual(sampleDoc('checkout'))
    expect(got?.createdBy).toBe('u1')
  })

  test('create twice refuses workflow_name_exists', () => {
    const db = setUp()
    const store = createWorkflowStore(db)
    store.create({ doc: sampleDoc('checkout'), createdBy: null })
    try {
      store.create({ doc: sampleDoc('checkout'), createdBy: null })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(EnkakuError)
      expect((err as EnkakuError).code).toBe('workflow_name_exists')
    }
  })

  test('update bumps updatedAt and replaces doc', async () => {
    const db = setUp()
    const store = createWorkflowStore(db)
    const created = store.create({ doc: sampleDoc('checkout'), createdBy: null })
    await new Promise((r) => setTimeout(r, 1100))
    const edited = { ...sampleDoc('checkout'), description: 'edited' }
    const updated = store.update('checkout', { doc: edited })
    expect(updated.doc.description).toBe('edited')
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt)
  })

  test('update on an unknown name throws workflow_not_found', () => {
    const db = setUp()
    const store = createWorkflowStore(db)
    expect(() => store.update('nope', { doc: sampleDoc('nope') })).toThrow(EnkakuError)
  })

  test('remove returns true then false', () => {
    const db = setUp()
    const store = createWorkflowStore(db)
    store.create({ doc: sampleDoc('checkout'), createdBy: null })
    expect(store.remove('checkout')).toBe(true)
    expect(store.remove('checkout')).toBe(false)
  })

  test('list is name-ascending', () => {
    const db = setUp()
    const store = createWorkflowStore(db)
    store.create({ doc: sampleDoc('zeta'), createdBy: null })
    store.create({ doc: sampleDoc('alpha'), createdBy: null })
    expect(store.list().map((r) => r.name)).toEqual(['alpha', 'zeta'])
  })

  test('a hand-corrupted row is skipped by list and thrown by get as workflow_corrupt', () => {
    const db = setUp()
    const store = createWorkflowStore(db)
    store.create({ doc: sampleDoc('checkout'), createdBy: null })
    db.run(sql`UPDATE workflows SET doc = '{"schema":2}' WHERE name = 'checkout'`)
    expect(store.list()).toEqual([])
    expect(() => store.get('checkout')).toThrow(EnkakuError)
    try {
      store.get('checkout')
    } catch (err) {
      expect((err as EnkakuError).code).toBe('workflow_corrupt')
    }
  })

  test('snapshotForJob returns an equal document that is not the same object, and throws workflow_not_found', () => {
    const db = setUp()
    const store = createWorkflowStore(db)
    store.create({ doc: sampleDoc('checkout'), createdBy: null })
    const snap = store.snapshotForJob('checkout')
    expect(snap).toEqual(sampleDoc('checkout'))
    expect(snap).not.toBe(store.get('checkout')?.doc)
    expect(() => store.snapshotForJob('nope')).toThrow(EnkakuError)
  })
})

describe('upgrade on read (plan 301 §4.5, G7)', () => {
  test('a v1 row parses to a v2 document on GET, and is never written back by the read itself', () => {
    const db = setUp()
    const store = createWorkflowStore(db)
    const v1Json = JSON.stringify({
      schema: 1,
      name: 'legacy',
      title: '',
      description: '',
      params: [],
      maxSteps: 50,
      nodes: [{ kind: 'script', id: 'n0', title: '', script: 'demo/checkout@1.0.0', params: {}, onFailure: { go: 'fail' } }],
    })
    db.run(
      sql`INSERT INTO workflows (id, name, doc, created_by, created_at, updated_at) VALUES ('wf-legacy', 'legacy', ${v1Json}, NULL, 1700000000, 1700000000)`,
    )

    const record = store.get('legacy')
    expect(record?.doc.schema).toBe(2)
    expect(record?.doc.entry).toBeDefined()

    // The read did NOT write anything back — the row on disk is still v1.
    const rawRow = db.all<{ doc: string }>(sql`SELECT doc FROM workflows WHERE name = 'legacy'`)
    const rawParsed = JSON.parse(rawRow[0]!.doc) as { schema: number }
    expect(rawParsed.schema).toBe(1)
  })

  test('list() also upgrades every v1 row in place, in memory', () => {
    const db = setUp()
    const store = createWorkflowStore(db)
    const v1Json = JSON.stringify({
      schema: 1,
      name: 'legacy2',
      title: '',
      description: '',
      params: [],
      maxSteps: 50,
      nodes: [{ kind: 'script', id: 'n0', title: '', script: 'demo/checkout@1.0.0', params: {}, onFailure: { go: 'fail' } }],
    })
    db.run(
      sql`INSERT INTO workflows (id, name, doc, created_by, created_at, updated_at) VALUES ('wf-legacy2', 'legacy2', ${v1Json}, NULL, 1700000000, 1700000000)`,
    )
    const items = store.list()
    expect(items).toHaveLength(1)
    expect(items[0]?.doc.schema).toBe(2)
  })
})
