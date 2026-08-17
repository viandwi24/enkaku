import { describe, expect, test } from 'bun:test'
import type { WorkflowDoc } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { scripts } from '../db/schema'
import { createScriptRoutes } from './routes'

/**
 * Plan 99 §4.5, §4.9, §5 step 99.6 — `kind` on the list and detail
 * projections, the `?kind=` filter, and a workflow's parsed doc on the
 * detail response. A NEW file rather than an addition to the existing
 * `routes.test.ts`: that file was under active, concurrent edit by another
 * worker throughout this step (confirmed via `git status` mid-session), and
 * a fresh file carries zero merge risk against it while covering exactly
 * the same route through the same public API (`createScriptRoutes`).
 */

function setUp(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function minimalWorkflowDoc(name: string, version = '1.0.0'): WorkflowDoc {
  return {
    schema: 1,
    name,
    version,
    title: '',
    description: '',
    params: [],
    nodes: [
      {
        kind: 'script',
        id: 'n1',
        title: '',
        script: 'demo@1.0.0',
        params: {},
        onFailure: { go: 'fail' },
      },
    ],
    maxSteps: 50,
  }
}

function seedScript(db: Db, id: string, name: string, version = '1.0.0') {
  db.insert(scripts)
    .values({ pluginId: 'p-fixture', exportId: 'main', id, name, version, kind: 'script', bundle: 'export {}', enabled: true, createdAt: new Date() })
    .run()
}

function seedWorkflow(db: Db, id: string, name: string, version = '1.0.0') {
  const doc = minimalWorkflowDoc(name, version)
  db.insert(scripts)
    .values({
      id,
      name,
      version,
      kind: 'workflow',
      bundle: JSON.stringify(doc),
      source: JSON.stringify(doc, null, 2),
      enabled: true,
      createdAt: new Date(),
    })
    .run()
}

describe('GET /api/scripts — kind projection (plan 99 §5 step 99.6)', () => {
  test('the ungrouped list carries kind on every row', async () => {
    const db = setUp()
    seedScript(db, 's1', 'my-script')
    seedWorkflow(db, 'w1', 'my-workflow')
    const app = createScriptRoutes({ db })

    const res = await app.request('/')
    const body = (await res.json()) as { items: Array<{ id: string; kind: string }> }
    const byId = new Map(body.items.map((i) => [i.id, i.kind]))
    expect(byId.get('s1')).toBe('script')
    expect(byId.get('w1')).toBe('workflow')
  })

  test('the grouped (?group=name) list carries kind on every group', async () => {
    const db = setUp()
    seedScript(db, 's1', 'my-script')
    seedWorkflow(db, 'w1', 'my-workflow')
    const app = createScriptRoutes({ db })

    const res = await app.request('/?group=name')
    const body = (await res.json()) as { items: Array<{ name: string; kind: string }> }
    const byName = new Map(body.items.map((i) => [i.name, i.kind]))
    expect(byName.get('my-script')).toBe('script')
    expect(byName.get('my-workflow')).toBe('workflow')
  })

  test('a script row published before this plan (no explicit kind) reads back kind: "script" with no backfill needed', async () => {
    const db = setUp()
    // Deliberately not calling seedScript's explicit `kind: 'script'` — this
    // mirrors a row inserted through the pre-plan-99 insert shape, relying
    // purely on the column's own `NOT NULL DEFAULT 'script'`.
    db.insert(scripts).values({ pluginId: 'p-fixture', exportId: 'main', id: 's-old', name: 'old-script', version: '1.0.0', bundle: 'export {}', enabled: true, createdAt: new Date() }).run()
    const app = createScriptRoutes({ db })
    const res = await app.request('/s-old')
    const body = (await res.json()) as { script: { kind: string } }
    expect(body.script.kind).toBe('script')
  })

  describe('?kind= filter', () => {
    test('?kind=workflow on the ungrouped list returns only workflow rows', async () => {
      const db = setUp()
      seedScript(db, 's1', 'my-script')
      seedWorkflow(db, 'w1', 'my-workflow')
      const app = createScriptRoutes({ db })

      const res = await app.request('/?kind=workflow')
      const body = (await res.json()) as { items: Array<{ id: string }> }
      expect(body.items.map((i) => i.id)).toEqual(['w1'])
    })

    test('?kind=script on the ungrouped list returns only script rows', async () => {
      const db = setUp()
      seedScript(db, 's1', 'my-script')
      seedWorkflow(db, 'w1', 'my-workflow')
      const app = createScriptRoutes({ db })

      const res = await app.request('/?kind=script')
      const body = (await res.json()) as { items: Array<{ id: string }> }
      expect(body.items.map((i) => i.id)).toEqual(['s1'])
    })

    test('?kind=workflow on the grouped list returns only workflow groups', async () => {
      const db = setUp()
      seedScript(db, 's1', 'my-script')
      seedWorkflow(db, 'w1', 'my-workflow')
      const app = createScriptRoutes({ db })

      const res = await app.request('/?group=name&kind=workflow')
      const body = (await res.json()) as { items: Array<{ name: string }> }
      expect(body.items.map((i) => i.name)).toEqual(['my-workflow'])
    })

    test('an unrecognised ?kind= value is ignored, not refused (a list query, not a publish gate)', async () => {
      const db = setUp()
      seedScript(db, 's1', 'my-script')
      const app = createScriptRoutes({ db })
      const res = await app.request('/?kind=not-a-real-kind')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: Array<{ id: string }> }
      expect(body.items.map((i) => i.id)).toEqual(['s1'])
    })
  })

  describe('GET /:id — the workflow field beside source', () => {
    test('a workflow row returns the parsed WorkflowDoc in `workflow`, beside `source`', async () => {
      const db = setUp()
      seedWorkflow(db, 'w1', 'my-workflow')
      const app = createScriptRoutes({ db })

      const res = await app.request('/w1')
      const body = (await res.json()) as { script: { kind: string; workflow: WorkflowDoc | null; source: string | null } }
      expect(body.script.kind).toBe('workflow')
      expect(body.script.workflow).not.toBeNull()
      expect(body.script.workflow?.name).toBe('my-workflow')
      expect(body.script.workflow?.nodes).toHaveLength(1)
      expect(typeof body.script.source).toBe('string')
    })

    test('a plain script row never carries a `workflow` key at all', async () => {
      const db = setUp()
      seedScript(db, 's1', 'my-script')
      const app = createScriptRoutes({ db })

      const res = await app.request('/s1')
      const body = (await res.json()) as { script: Record<string, unknown> }
      expect(body.script.kind).toBe('script')
      expect('workflow' in body.script).toBe(false)
    })

    test('a corrupt workflow bundle degrades to workflow: null rather than a 500', async () => {
      const db = setUp()
      db.insert(scripts)
        .values({ id: 'w-bad', name: 'bad-workflow', version: '1.0.0', kind: 'workflow', bundle: 'not json at all', enabled: true, createdAt: new Date() })
        .run()
      const app = createScriptRoutes({ db })
      const res = await app.request('/w-bad')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { script: { workflow: unknown } }
      expect(body.script.workflow).toBeNull()
    })
  })
})
