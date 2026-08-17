import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'bun:test'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { scripts } from '../db/schema'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createScriptRegistry, type ScriptRegistry } from '../scripts/registry'
import { createWorkflowRoutes } from './workflows'

/**
 * `POST /api/workflows`, `POST /api/workflows/validate`, `GET
 * /api/workflows/:name/versions` (plan 99 §4.5, §4.9, §5 step 99.6).
 */

function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function setUp(): { db: Db; registry: ScriptRegistry } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const registry = createScriptRegistry({ db: opened.db, dataDir: `/tmp/enkaku-workflows-test-${crypto.randomUUID()}`, devSlots: createDevSlotStore() })
  return { db: opened.db, registry }
}

/** Publishes an ordinary (kind: 'script') row directly, bypassing HTTP — a node's script reference must resolve to something real before a workflow document naming it can be checked at all. */
function publishScriptRow(db: Db, name: string, version: string, opts: { enabled?: boolean } = {}) {
  const id = `${name.replace(/\//g, '-')}-${version}`
  db.insert(scripts)
    .values({ pluginId: 'p-fixture', exportId: 'main', id, name, version, kind: 'script', bundle: 'export {}', enabled: opts.enabled ?? true, createdAt: new Date() })
    .run()
  return id
}

function publishWorkflowRow(db: Db, name: string, version: string) {
  const doc = {
    schema: 1,
    name,
    version,
    title: '',
    description: '',
    params: [],
    nodes: [{ kind: 'script', id: 'n1', title: '', script: 'demo@1.0.0', params: {}, onFailure: { go: 'fail' } }],
    maxSteps: 50,
  }
  const id = `${name}-${version}`
  db.insert(scripts)
    .values({ id, name, version, kind: 'workflow', bundle: JSON.stringify(doc), source: JSON.stringify(doc, null, 2), enabled: true, createdAt: new Date() })
    .run()
  return id
}

/** The owner's own example (plan 99 §0), as an unparsed JSON document — exactly what a real HTTP client would POST. */
function ownerExampleDocInput(name = 'tiktok-search-pipeline', version = '1.0.0') {
  return {
    schema: 1,
    name,
    version,
    title: 'TikTok search pipeline',
    description: 'Warm up the feed, search a keyword, and report what was found.',
    params: [{ name: 'keyword', type: 'string', required: true, title: 'Search keyword' }],
    nodes: [
      { kind: 'script', id: 'scroll1', title: 'Scroll FYP (warm-up)', script: 'tiktok/auto-scroll@1.4.0', params: {}, onFailure: { go: 'fail' } },
      {
        kind: 'script',
        id: 'search1',
        title: 'Search Keywords & Scroll Posts',
        script: 'tiktok/searched-follow@1.4.0',
        params: { keyword: { param: 'keyword' } },
        onFailure: { go: 'fail' },
      },
      {
        kind: 'gate',
        id: 'enough',
        title: 'Enough matches?',
        when: { left: { from: 'search1', path: 'matches' }, op: 'notEmpty' },
        then: { go: 'continue' },
        else: { go: 'goto', node: 'scroll1' },
      },
      { kind: 'script', id: 'scroll2', title: 'Scroll FYP again', script: 'tiktok/auto-scroll@1.4.0', params: {}, onFailure: { go: 'fail' } },
      {
        kind: 'script',
        id: 'report',
        title: 'Report',
        script: 'tiktok/report@1.0.0',
        params: { videos: { from: 'scroll1', path: 'videos' }, all: { run: 'summary' } },
        onFailure: { go: 'fail' },
      },
    ],
    onFail: { script: 'tiktok/switch-account@1.0.0', params: {} },
  }
}

function seedOwnerExampleDeps(db: Db) {
  publishScriptRow(db, 'tiktok/auto-scroll', '1.4.0')
  publishScriptRow(db, 'tiktok/searched-follow', '1.4.0')
  publishScriptRow(db, 'tiktok/report', '1.0.0')
  publishScriptRow(db, 'tiktok/switch-account', '1.0.0')
}

describe('POST /api/workflows — the owner\'s example (step 99.6 verifiable result)', () => {
  test('publishes a scripts row indistinguishable from a hand-written script\'s to every existing consumer', async () => {
    const { db, registry } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry }))

    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput() }) })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { script: { id: string; name: string; version: string } }
    expect(body.script.name).toBe('tiktok-search-pipeline')
    expect(body.script.version).toBe('1.0.0')

    // The exact same row `(name, version)` uniqueness, `enabled`, `createdAt`
    // etc. every OTHER `scripts` row has (F15/F16) — read straight from the
    // table, not through any workflow-specific accessor.
    const row = db.select().from(scripts).where(eq(scripts.id, body.script.id)).get()
    expect(row?.kind).toBe('workflow')
    expect(row?.enabled).toBe(true)
    expect(row?.paramsSchema).not.toBeNull()
    // `bundle` is the canonical WorkflowDoc JSON; `source` is the SAME
    // document pretty-printed (plan 99 §4.5).
    expect(() => JSON.parse(row!.bundle)).not.toThrow()
    expect(row?.source).toContain('"name": "tiktok-search-pipeline"')
    // Plan 110 §3.3, criterion 2 — a workflow publishes with NO owning plugin,
    // and that is not an exemption from "a script cannot exist outside a
    // plugin": the rule is written about a `kind: 'script'` row, and this is
    // not one. The writer that refuses a plugin-less script wrote this row.
    expect(row?.pluginId).toBeNull()
    expect(row?.exportId).toBeNull()
  })

  test('a duplicate name@version is refused with script_version_exists — the EXISTING writer\'s own conflict check, not a second one', async () => {
    const { db, registry } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry }))
    const doc = ownerExampleDocInput()

    const first = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc }) })
    expect(first.status).toBe(201)

    const second = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc }) })
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error: { code: string } }
    expect(body.error.code).toBe('script_version_exists')
  })

  test('requires script.publish — an operator with no publish right (viewer-shaped: no user at all) is refused', async () => {
    const { db, registry } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser(null, createWorkflowRoutes({ db, registry }))
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput() }) })
    expect(res.status).toBe(403)
  })
})

describe('POST /api/workflows — checkWorkflow findings map to 400', () => {
  test('a document binding to a node that runs LATER is refused with E_WORKFLOW_FORWARD_REF, naming both nodes', async () => {
    const { db, registry } = setUp()
    publishScriptRow(db, 'demo', '1.0.0')
    const app = withUser('operator', createWorkflowRoutes({ db, registry }))

    const doc = {
      schema: 1,
      name: 'forward-ref-doc',
      version: '1.0.0',
      params: [],
      nodes: [
        { kind: 'script', id: 'first', script: 'demo@1.0.0', params: { x: { from: 'second' } }, onFailure: { go: 'fail' } },
        { kind: 'script', id: 'second', script: 'demo@1.0.0', params: {}, onFailure: { go: 'fail' } },
      ],
    }
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc }) })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; findings: Array<{ code: string; message: string }> } }
    expect(body.error.code).toBe('E_WORKFLOW_INVALID')
    const forwardRef = body.error.findings.find((f) => f.code === 'E_WORKFLOW_FORWARD_REF')
    expect(forwardRef).toBeDefined()
    expect(forwardRef?.message).toContain('"first"')
    expect(forwardRef?.message).toContain('"second"')
    // Refused BEFORE any row was written.
    const row = db.select().from(scripts).where(eq(scripts.name, 'forward-ref-doc')).get()
    expect(row).toBeUndefined()
  })

  test('a document naming another workflow as a node is refused with E_WORKFLOW_NESTED', async () => {
    const { db, registry } = setUp()
    publishScriptRow(db, 'demo', '1.0.0')
    publishWorkflowRow(db, 'inner-workflow', '1.0.0')
    const app = withUser('operator', createWorkflowRoutes({ db, registry }))

    const doc = {
      schema: 1,
      name: 'outer-workflow',
      version: '1.0.0',
      params: [],
      nodes: [{ kind: 'script', id: 'a', script: 'inner-workflow@1.0.0', params: {}, onFailure: { go: 'fail' } }],
    }
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc }) })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; findings: Array<{ code: string }> } }
    expect(body.error.findings.some((f) => f.code === 'E_WORKFLOW_NESTED')).toBe(true)
  })

  test('a node naming a script that does not exist is refused with E_WORKFLOW_SCRIPT_UNRESOLVED, not a 500', async () => {
    const { db, registry } = setUp()
    const app = withUser('operator', createWorkflowRoutes({ db, registry }))
    const doc = {
      schema: 1,
      name: 'ghost-script',
      version: '1.0.0',
      params: [],
      nodes: [{ kind: 'script', id: 'a', script: 'no-such-script@1.0.0', params: {}, onFailure: { go: 'fail' } }],
    }
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc }) })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { findings: Array<{ code: string }> } }
    expect(body.error.findings.some((f) => f.code === 'E_WORKFLOW_SCRIPT_UNRESOLVED')).toBe(true)
  })

  test('a malformed document (fails WorkflowDocSchema itself) is refused with E_WORKFLOW_INVALID findings, not a crash', async () => {
    const { db, registry } = setUp()
    const app = withUser('operator', createWorkflowRoutes({ db, registry }))
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: { schema: 1, name: 'x', version: '1.0.0', nodes: [] } }) })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { findings: Array<{ code: string }> } }
    expect(body.error.findings.length).toBeGreaterThan(0)
    expect(body.error.findings.every((f) => f.code === 'E_WORKFLOW_INVALID')).toBe(true)
  })
})

describe('POST /api/workflows/validate', () => {
  test('returns the same findings the publish gate would, and writes nothing', async () => {
    const { db, registry } = setUp()
    publishScriptRow(db, 'demo', '1.0.0')
    const app = withUser('operator', createWorkflowRoutes({ db, registry }))
    const doc = {
      schema: 1,
      name: 'validate-only',
      version: '1.0.0',
      params: [],
      nodes: [
        { kind: 'script', id: 'first', script: 'demo@1.0.0', params: { x: { from: 'second' } }, onFailure: { go: 'fail' } },
        { kind: 'script', id: 'second', script: 'demo@1.0.0', params: {}, onFailure: { go: 'fail' } },
      ],
    }
    const res = await app.request('/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc }) })
    expect(res.status).toBe(200)
    const findings = (await res.json()) as Array<{ code: string }>
    expect(findings.some((f) => f.code === 'E_WORKFLOW_FORWARD_REF')).toBe(true)
    const row = db.select().from(scripts).where(eq(scripts.name, 'validate-only')).get()
    expect(row).toBeUndefined()
  })

  test('a valid document validates clean (only the @latest / unchecked-binding warnings the owner\'s example always carries)', async () => {
    const { db, registry } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry }))
    const res = await app.request('/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput() }) })
    expect(res.status).toBe(200)
    const findings = (await res.json()) as Array<{ code: string; severity: string }>
    expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0)
  })

  test('requires only script.view, not script.publish', async () => {
    const { db, registry } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry }))
    const res = await app.request('/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput() }) })
    expect(res.status).toBe(200)
  })
})

describe('GET /api/workflows/:name/versions', () => {
  test('lists every published version, newest semver first', async () => {
    const { db, registry } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry }))
    await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput('tiktok-search-pipeline', '1.0.0') }) })
    await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput('tiktok-search-pipeline', '2.0.0') }) })

    const res = await app.request('/tiktok-search-pipeline/versions')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ version: string }> }
    expect(body.items.map((i) => i.version)).toEqual(['2.0.0', '1.0.0'])
  })
})
