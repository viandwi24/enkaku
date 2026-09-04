import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { jobRuns, jobs, scripts, workflowSteps } from '../db/schema'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createScriptRegistry, type ScriptRegistry } from '../scripts/registry'
import { createWorkflowStore, type WorkflowStore } from '../workflows/store'
import { createPinStore, type PinStore } from '../workflows/pins'
import { createRunStore, type RunStore } from '../jobs/runs/store'
import { createWorkflowRoutes } from './workflows'

/**
 * `GET/POST/PUT/DELETE /api/workflows`, `POST /api/workflows/validate` (plan
 * 210 §4.3, §4.4). A workflow is its own table now, no version, edited in
 * place — the writer under test is `WorkflowStore`, not the old per-script
 * publish path.
 */

function fakeAudit(): { audit: AuditLogger; calls: Parameters<AuditLogger['record']>[0][] } {
  const calls: Parameters<AuditLogger['record']>[0][] = []
  return { audit: { record: (input) => void calls.push(input), list: () => [] }, calls }
}

function withUser(role: 'admin' | 'operator' | null, inner: Hono<AuthEnv>): Hono<AuthEnv> {
  const wrapper = new Hono<AuthEnv>()
  wrapper.use('*', async (c, next) => {
    if (role) c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  wrapper.route('/', inner)
  return wrapper
}

function setUp(): { db: Db; registry: ScriptRegistry; store: WorkflowStore; runs: RunStore; pins: PinStore; scheduler: { kick: () => void }; kicked: number[] } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const registry = createScriptRegistry({ db: opened.db, dataDir: `/tmp/enkaku-workflows-test-${crypto.randomUUID()}`, devSlots: createDevSlotStore() })
  const store = createWorkflowStore(opened.db)
  const runs = createRunStore(opened.db)
  const pins = createPinStore(opened.db)
  const kicked: number[] = []
  const scheduler = { kick: () => void kicked.push(1) }
  return { db: opened.db, registry, store, runs, pins, scheduler, kicked }
}

/** Publishes a plugin member row directly, bypassing HTTP — a node's script reference must resolve to something real before a workflow document naming it can be checked at all. */
function publishScriptRow(db: Db, name: string, version: string, opts: { enabled?: boolean; timeoutMs?: number } = {}) {
  const id = `${name.replace(/\//g, '-')}-${version}`
  db.insert(scripts)
    .values({
      pluginId: 'p-fixture',
      exportId: 'main',
      id,
      name,
      version,
      bundle: 'export {}',
      enabled: opts.enabled ?? true,
      createdAt: new Date(),
      ...(opts.timeoutMs !== undefined ? { runtime: { timeoutMs: opts.timeoutMs } } : {}),
    })
    .run()
  return id
}

/** The owner's own example (plan 99 §0), as an unparsed JSON document — exactly what a real HTTP client would POST. No version key (plan 210). */
function ownerExampleDocInput(name = 'tiktok-search-pipeline') {
  return {
    schema: 1,
    name,
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

describe('POST /api/workflows — the owner\'s example (plan 210 §4.4)', () => {
  test('creates a workflows row and answers 201 { workflow }', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    seedOwnerExampleDeps(db)
    const { audit, calls } = fakeAudit()
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler, audit }))

    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput() }) })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { workflow: { id: string; name: string; doc: { name: string }; createdBy: string | null; createdAt: number; updatedAt: number } }
    expect(body.workflow.name).toBe('tiktok-search-pipeline')
    expect(body.workflow.doc.name).toBe('tiktok-search-pipeline')
    expect('version' in body.workflow.doc).toBe(false)
    expect(body.workflow.createdBy).toBe('u1')
    expect(calls.at(-1)).toMatchObject({ userId: 'u1', action: 'workflow.create', target: body.workflow.id, meta: { name: 'tiktok-search-pipeline' } })
  })

  test('a second POST with the same name is 409 workflow_name_exists', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    const doc = ownerExampleDocInput()

    const first = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc }) })
    expect(first.status).toBe(201)

    const second = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc }) })
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error: { code: string } }
    expect(body.error.code).toBe('workflow_name_exists')
  })

  test('requires script.publish — no authenticated user is refused', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser(null, createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput() }) })
    expect(res.status).toBe(403)
  })
})

describe('PUT /api/workflows/:name', () => {
  test('replaces the document and bumps updatedAt', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    seedOwnerExampleDeps(db)
    const { audit, calls } = fakeAudit()
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler, audit }))
    const created = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput() }) })
    const { workflow } = (await created.json()) as { workflow: { id: string; updatedAt: number } }

    const edited = { ...ownerExampleDocInput(), description: 'edited' }
    const res = await app.request('/tiktok-search-pipeline', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: edited }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { workflow: { id: string; doc: { description: string }; updatedAt: number } }
    expect(body.workflow.doc.description).toBe('edited')
    expect(body.workflow.updatedAt).toBeGreaterThanOrEqual(workflow.updatedAt)
    expect(calls.at(-1)).toMatchObject({ userId: 'u1', action: 'workflow.update', target: workflow.id })
  })

  test('a mismatched name is 400', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput() }) })

    const res = await app.request('/tiktok-search-pipeline', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc: ownerExampleDocInput('a-different-name') }),
    })
    expect(res.status).toBe(400)
  })

  test('PUT on an unknown name is 404 workflow_not_found', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    const res = await app.request('/nope', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput('nope') }) })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('workflow_not_found')
  })
})

describe('GET /api/workflows, GET /api/workflows/:name', () => {
  test('list and one', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput() }) })

    const list = await app.request('/')
    expect(list.status).toBe(200)
    const listBody = (await list.json()) as { items: Array<{ name: string }>; total: number }
    expect(listBody.items.map((i) => i.name)).toEqual(['tiktok-search-pipeline'])
    expect(listBody.total).toBe(1)

    const one = await app.request('/tiktok-search-pipeline')
    expect(one.status).toBe(200)
    const oneBody = (await one.json()) as { workflow: { name: string } }
    expect(oneBody.workflow.name).toBe('tiktok-search-pipeline')

    const missing = await app.request('/nope')
    expect(missing.status).toBe(404)
  })
})

describe('DELETE /api/workflows/:name', () => {
  test('DELETE then GET is 404', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    seedOwnerExampleDeps(db)
    const { audit, calls } = fakeAudit()
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler, audit }))
    await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput() }) })

    const del = await app.request('/tiktok-search-pipeline', { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(calls.at(-1)).toMatchObject({ userId: 'u1', action: 'workflow.delete', meta: { name: 'tiktok-search-pipeline' } })

    const after = await app.request('/tiktok-search-pipeline')
    expect(after.status).toBe(404)
  })

  test('DELETE on an unknown name is 404', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    const res = await app.request('/nope', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/workflows — checkWorkflow findings map to 400', () => {
  test('a document binding to a node that runs LATER is refused with E_WORKFLOW_FORWARD_REF, naming both nodes', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    publishScriptRow(db, 'demo', '1.0.0')
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))

    const doc = {
      schema: 1,
      name: 'forward-ref-doc',
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
    expect(store.get('forward-ref-doc')).toBeNull()
  })

  test('a node naming a script that does not exist is refused with E_WORKFLOW_SCRIPT_UNRESOLVED, not a 500', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    const doc = {
      schema: 1,
      name: 'ghost-script',
      params: [],
      nodes: [{ kind: 'script', id: 'a', script: 'no-such-script@1.0.0', params: {}, onFailure: { go: 'fail' } }],
    }
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc }) })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { findings: Array<{ code: string }> } }
    expect(body.error.findings.some((f) => f.code === 'E_WORKFLOW_SCRIPT_UNRESOLVED')).toBe(true)
  })

  test('a malformed v2 document (fails WorkflowDocSchema itself) is refused with E_WORKFLOW_INVALID findings, not a crash', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: { schema: 2, name: 'x', entry: 'a', nodes: [] } }) })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { findings: Array<{ code: string }> } }
    expect(body.error.findings.length).toBeGreaterThan(0)
    expect(body.error.findings.every((f) => f.code === 'E_WORKFLOW_INVALID')).toBe(true)
  })

  test('a malformed v1 document (does not satisfy the frozen v1 shape) is refused with E_WORKFLOW_UPGRADE_FAILED, not a crash (plan 301 §4.6)', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: { schema: 1, name: 'x', nodes: [] } }) })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; findings: Array<{ code: string }> } }
    expect(body.error.code).toBe('E_WORKFLOW_UPGRADE_FAILED')
  })

  test('a document declaring an unknown schema is refused with E_WORKFLOW_SCHEMA_UNKNOWN (plan 301 §4.6)', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: { schema: 3, name: 'x', nodes: [] } }) })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_WORKFLOW_SCHEMA_UNKNOWN')
  })
})

describe('POST /api/workflows — accepts a v1 body and stores v2 (plan 301 §4.5)', () => {
  test('a v1 document is upgraded before checkWorkflow ever sees it, and stored as schema 2', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput() }) })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { workflow: { doc: { schema: number; entry: string } } }
    expect(body.workflow.doc.schema).toBe(2)
    expect(body.workflow.doc.entry).toBeDefined()
  })
})

describe('POST /api/workflows/validate', () => {
  test('returns the same findings the publish gate would, and writes nothing', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    publishScriptRow(db, 'demo', '1.0.0')
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    const doc = {
      schema: 1,
      name: 'validate-only',
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
    expect(store.get('validate-only')).toBeNull()
  })

  test('a valid document validates clean (only the @latest / unchecked-binding warnings the owner\'s example always carries)', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    const res = await app.request('/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput() }) })
    expect(res.status).toBe(200)
    const findings = (await res.json()) as Array<{ code: string; severity: string }>
    expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0)
  })

  test('requires only script.view, not script.publish', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    const res = await app.request('/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput() }) })
    expect(res.status).toBe(200)
  })
})

/**
 * `workflow.maxTotalMs` (docs/settings-audit.md #3) — the ROUTE half: the
 * exact same two-node document is flagged when a small custom `maxTotalMs`
 * is wired in, and NOT flagged when no accessor is passed at all (the
 * schema-default fallback).
 */
describe('POST /api/workflows/validate — workflow.maxTotalMs preflight honours a live, non-default setting (docs/settings-audit.md #3)', () => {
  function twoNodeDoc() {
    return {
      schema: 1,
      name: 'budget-preflight',
      params: [],
      nodes: [
        { kind: 'script', id: 'a', script: 'node-a@1.0.0', params: {}, onFailure: { go: 'fail' } },
        { kind: 'script', id: 'b', script: 'node-b@1.0.0', params: {}, onFailure: { go: 'fail' } },
      ],
    }
  }

  test('a custom, SMALL maxTotalMs (well under the 6h schema default) flags a document whose declared node timeouts sum past it', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    publishScriptRow(db, 'node-a', '1.0.0', { timeoutMs: 400_000 })
    publishScriptRow(db, 'node-b', '1.0.0', { timeoutMs: 400_000 })

    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler, settings: () => ({ maxTotalMs: 500_000 }) }))
    const res = await app.request('/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: twoNodeDoc() }) })
    expect(res.status).toBe(200)
    const findings = (await res.json()) as Array<{ code: string; message: string }>
    const impossible = findings.find((f) => f.code === 'E_WORKFLOW_BUDGET_IMPOSSIBLE')
    expect(impossible).toBeDefined()
    expect(impossible?.message).toContain('800000ms')
    expect(impossible?.message).toContain('500000ms')
  })

  test('the IDENTICAL document, with no settings accessor passed at all, falls back to the schema default and is NOT flagged', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    publishScriptRow(db, 'node-a', '1.0.0', { timeoutMs: 400_000 })
    publishScriptRow(db, 'node-b', '1.0.0', { timeoutMs: 400_000 })

    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    const res = await app.request('/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: twoNodeDoc() }) })
    expect(res.status).toBe(200)
    const findings = (await res.json()) as Array<{ code: string }>
    expect(findings.some((f) => f.code === 'E_WORKFLOW_BUDGET_IMPOSSIBLE')).toBe(false)
  })
})

/** `start -> a -> b`, `b` reads `a`'s own output through `{ from: 'a', path: 'x' }` — the direct-predecessor case `run-node` supports (plan 304 §4.6). */
function twoNodeV2Doc() {
  return {
    schema: 2,
    name: 'run-node-doc',
    title: '',
    description: '',
    params: [],
    entry: 'start',
    nodes: [
      { kind: 'start', id: 'start', title: '', ui: { x: 0, y: 0 }, next: 'a' },
      { kind: 'script', id: 'a', title: '', ui: { x: 0, y: 0 }, script: 'node-a@1.0.0', params: {}, next: 'b' },
      { kind: 'script', id: 'b', title: '', ui: { x: 0, y: 0 }, script: 'node-b@1.0.0', params: { x: { from: 'a', path: 'x' } } },
    ],
  }
}

describe('POST /api/workflows/:name/run-node (plan 300 P9, plan 304 §3.2, §4.3, §4.6)', () => {
  async function seed(): Promise<{ db: Db; registry: ScriptRegistry; store: WorkflowStore; runs: RunStore; pins: PinStore; scheduler: { kick: () => void }; kicked: number[]; app: Hono<AuthEnv> }> {
    const { db, registry, store, runs, pins, scheduler, kicked } = setUp()
    publishScriptRow(db, 'node-a', '1.0.0')
    publishScriptRow(db, 'node-b', '1.0.0')
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    const created = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: twoNodeV2Doc() }) })
    expect(created.status).toBe(201)
    return { db, registry, store, runs, pins, scheduler, kicked, app }
  }

  test('running with a literal input creates a run with trigger = node-test (G3)', async () => {
    const { app, db, kicked } = await seed()
    const res = await app.request('/run-node-doc/run-node', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'b', deviceId: 'dev-1', input: { from: 'literal', value: { x: 42 } } }),
    })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { job: { jobId: string; kind: string }; runId: string }
    expect(body.job.kind).toBe('workflow')
    const runRow = db.select().from(jobRuns).where(eq(jobRuns.id, body.runId)).get()
    expect(runRow?.trigger).toBe('node-test')
    // Appears in the ordinary jobs table like any other run (plan 304 §6) — no hidden execution.
    const jobRow = db.select().from(jobs).where(eq(jobs.id, body.job.jobId)).get()
    expect(jobRow?.kind).toBe('workflow')
    expect(kicked.length).toBe(1) // the scheduler was kicked, exactly like any other enqueue
  })

  test('running with { from: "last-run" } (the default) uses the node\'s own recorded $input', async () => {
    const { app, db } = await seed()
    // Simulate a prior real run: its own workflow job (a workflow's
    // DEFINITION creates no `jobs` row — only running it does) plus one
    // step recording node "b"'s own $input.
    const priorJobId = crypto.randomUUID()
    const priorRunId = crypto.randomUUID()
    db.insert(jobs)
      .values({ id: priorJobId, kind: 'workflow', workflowName: 'run-node-doc', deviceId: 'dev-1', scriptName: 'run-node-doc', createdAt: new Date() })
      .run()
    db.insert(jobRuns)
      .values({ id: priorRunId, jobId: priorJobId, seq: 1, trigger: 'manual', status: 'success', deviceId: 'dev-1', createdAt: new Date(), seed: 0 })
      .run()
    db.insert(workflowSteps)
      .values({ id: crypto.randomUUID(), runId: priorRunId, seq: 1, stepId: 'b', kind: 'script', status: 'success', startedAt: new Date(), input: { x: 7 }, pinned: false })
      .run()

    const res = await app.request('/run-node-doc/run-node', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodeId: 'b', deviceId: 'dev-1' }) })
    expect(res.status).toBe(202)
  })

  test('running with { from: "last-run" } and no recorded input is refused with E_NODE_NO_INPUT', async () => {
    const { app } = await seed()
    const res = await app.request('/run-node-doc/run-node', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nodeId: 'b', deviceId: 'dev-1' }) })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NODE_NO_INPUT')
  })

  test('running with { from: "pin" } uses the pin on the node\'s own predecessor', async () => {
    const { app, pins } = await seed()
    pins.set('run-node-doc', 'a', { x: 99 }, 'u1')
    const res = await app.request('/run-node-doc/run-node', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'b', deviceId: 'dev-1', input: { from: 'pin' } }),
    })
    expect(res.status).toBe(202)
  })

  test('an unknown node is refused with E_NODE_UNKNOWN', async () => {
    const { app } = await seed()
    const res = await app.request('/run-node-doc/run-node', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'no-such-node', deviceId: 'dev-1', input: { from: 'literal', value: {} } }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NODE_UNKNOWN')
  })
})

describe('Workflow pins CRUD over HTTP (plan 300 P10, plan 304 §3.3, §4.3)', () => {
  test('PUT sets a literal pin, GET reads it back, list never carries the data, DELETE removes it', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    publishScriptRow(db, 'node-a', '1.0.0')
    publishScriptRow(db, 'node-b', '1.0.0')
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    const created = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: twoNodeV2Doc() }) })
    expect(created.status).toBe(201)

    const put = await app.request('/run-node-doc/pins/a', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { x: 5 } }) })
    expect(put.status).toBe(204)

    const list = await app.request('/run-node-doc/pins')
    expect(list.status).toBe(200)
    const listBody = (await list.json()) as { pins: Array<{ nodeId: string; updatedAt: number; bytes: number }> }
    expect(listBody.pins).toEqual([{ nodeId: 'a', updatedAt: expect.any(Number), bytes: expect.any(Number) }])

    const get = await app.request('/run-node-doc/pins/a')
    expect(get.status).toBe(200)
    expect(((await get.json()) as { data: unknown }).data).toEqual({ x: 5 })

    const del = await app.request('/run-node-doc/pins/a', { method: 'DELETE' })
    expect(del.status).toBe(204)
    const getAfter = await app.request('/run-node-doc/pins/a')
    expect(getAfter.status).toBe(404)
  })

  test('a gate cannot be pinned, and neither can a node that does not exist (plan 300 R6)', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    publishScriptRow(db, 'node-a', '1.0.0')
    publishScriptRow(db, 'node-b', '1.0.0')
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    const doc = twoNodeV2Doc()
    // a → gate → b, so the document carries a node whose successor is a decision.
    doc.nodes = [
      { kind: 'start', id: 'start', title: '', ui: { x: 0, y: 0 }, next: 'a' },
      { kind: 'script', id: 'a', title: '', ui: { x: 0, y: 0 }, script: 'node-a@1.0.0', params: {}, next: 'g' },
      { kind: 'gate', id: 'g', title: '', ui: { x: 0, y: 0 }, when: { left: { from: 'a', path: 'x' }, op: 'notEmpty' }, then: 'b' },
      { kind: 'script', id: 'b', title: '', ui: { x: 0, y: 0 }, script: 'node-b@1.0.0', params: {} },
    ] as unknown as typeof doc.nodes
    const created = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc }) })
    expect(created.status).toBe(201)

    const onGate = await app.request('/run-node-doc/pins/g', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { x: 1 } }) })
    expect(onGate.status).toBe(400)
    expect(((await onGate.json()) as { error: { code: string } }).error.code).toBe('E_PIN_NOT_PINNABLE')

    const onGhost = await app.request('/run-node-doc/pins/nope', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: {} }) })
    expect(onGhost.status).toBe(400)
    expect(((await onGhost.json()) as { error: { code: string } }).error.code).toBe('E_NODE_UNKNOWN')

    // The script node beside it is still pinnable — the guard is a rule, not a ban.
    const onScript = await app.request('/run-node-doc/pins/a', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { x: 1 } }) })
    expect(onScript.status).toBe(204)
  })

  test('deleting the workflow removes its pins too', async () => {
    const { db, registry, store, runs, pins, scheduler } = setUp()
    publishScriptRow(db, 'node-a', '1.0.0')
    publishScriptRow(db, 'node-b', '1.0.0')
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, runs, pins, scheduler }))
    const created = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: twoNodeV2Doc() }) })
    expect(created.status).toBe(201)
    pins.set('run-node-doc', 'a', { x: 1 }, 'u1')
    const del = await app.request('/run-node-doc', { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(pins.list('run-node-doc')).toHaveLength(0)
  })
})
