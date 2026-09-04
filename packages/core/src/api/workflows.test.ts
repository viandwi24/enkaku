import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import type { AuditLogger } from '../auth/audit'
import type { AuthEnv } from '../auth/middleware'
import { openDb, runMigrations, type Db } from '../db'
import { scripts } from '../db/schema'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createScriptRegistry, type ScriptRegistry } from '../scripts/registry'
import { createWorkflowStore, type WorkflowStore } from '../workflows/store'
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

function setUp(): { db: Db; registry: ScriptRegistry; store: WorkflowStore } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  const registry = createScriptRegistry({ db: opened.db, dataDir: `/tmp/enkaku-workflows-test-${crypto.randomUUID()}`, devSlots: createDevSlotStore() })
  const store = createWorkflowStore(opened.db)
  return { db: opened.db, registry, store }
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
    const { db, registry, store } = setUp()
    seedOwnerExampleDeps(db)
    const { audit, calls } = fakeAudit()
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, audit }))

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
    const { db, registry, store } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store }))
    const doc = ownerExampleDocInput()

    const first = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc }) })
    expect(first.status).toBe(201)

    const second = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc }) })
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error: { code: string } }
    expect(body.error.code).toBe('workflow_name_exists')
  })

  test('requires script.publish — no authenticated user is refused', async () => {
    const { db, registry, store } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser(null, createWorkflowRoutes({ db, registry, store }))
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput() }) })
    expect(res.status).toBe(403)
  })
})

describe('PUT /api/workflows/:name', () => {
  test('replaces the document and bumps updatedAt', async () => {
    const { db, registry, store } = setUp()
    seedOwnerExampleDeps(db)
    const { audit, calls } = fakeAudit()
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, audit }))
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
    const { db, registry, store } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store }))
    await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput() }) })

    const res = await app.request('/tiktok-search-pipeline', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc: ownerExampleDocInput('a-different-name') }),
    })
    expect(res.status).toBe(400)
  })

  test('PUT on an unknown name is 404 workflow_not_found', async () => {
    const { db, registry, store } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store }))
    const res = await app.request('/nope', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput('nope') }) })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('workflow_not_found')
  })
})

describe('GET /api/workflows, GET /api/workflows/:name', () => {
  test('list and one', async () => {
    const { db, registry, store } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store }))
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
    const { db, registry, store } = setUp()
    seedOwnerExampleDeps(db)
    const { audit, calls } = fakeAudit()
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, audit }))
    await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput() }) })

    const del = await app.request('/tiktok-search-pipeline', { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(calls.at(-1)).toMatchObject({ userId: 'u1', action: 'workflow.delete', meta: { name: 'tiktok-search-pipeline' } })

    const after = await app.request('/tiktok-search-pipeline')
    expect(after.status).toBe(404)
  })

  test('DELETE on an unknown name is 404', async () => {
    const { db, registry, store } = setUp()
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store }))
    const res = await app.request('/nope', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/workflows — checkWorkflow findings map to 400', () => {
  test('a document binding to a node that runs LATER is refused with E_WORKFLOW_FORWARD_REF, naming both nodes', async () => {
    const { db, registry, store } = setUp()
    publishScriptRow(db, 'demo', '1.0.0')
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store }))

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
    const { db, registry, store } = setUp()
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store }))
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

  test('a malformed document (fails WorkflowDocSchema itself) is refused with E_WORKFLOW_INVALID findings, not a crash', async () => {
    const { db, registry, store } = setUp()
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store }))
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: { schema: 1, name: 'x', nodes: [] } }) })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { findings: Array<{ code: string }> } }
    expect(body.error.findings.length).toBeGreaterThan(0)
    expect(body.error.findings.every((f) => f.code === 'E_WORKFLOW_INVALID')).toBe(true)
  })
})

describe('POST /api/workflows/validate', () => {
  test('returns the same findings the publish gate would, and writes nothing', async () => {
    const { db, registry, store } = setUp()
    publishScriptRow(db, 'demo', '1.0.0')
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store }))
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
    const { db, registry, store } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store }))
    const res = await app.request('/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: ownerExampleDocInput() }) })
    expect(res.status).toBe(200)
    const findings = (await res.json()) as Array<{ code: string; severity: string }>
    expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0)
  })

  test('requires only script.view, not script.publish', async () => {
    const { db, registry, store } = setUp()
    seedOwnerExampleDeps(db)
    const app = withUser('operator', createWorkflowRoutes({ db, registry, store }))
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
    const { db, registry, store } = setUp()
    publishScriptRow(db, 'node-a', '1.0.0', { timeoutMs: 400_000 })
    publishScriptRow(db, 'node-b', '1.0.0', { timeoutMs: 400_000 })

    const app = withUser('operator', createWorkflowRoutes({ db, registry, store, settings: () => ({ maxTotalMs: 500_000 }) }))
    const res = await app.request('/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: twoNodeDoc() }) })
    expect(res.status).toBe(200)
    const findings = (await res.json()) as Array<{ code: string; message: string }>
    const impossible = findings.find((f) => f.code === 'E_WORKFLOW_BUDGET_IMPOSSIBLE')
    expect(impossible).toBeDefined()
    expect(impossible?.message).toContain('800000ms')
    expect(impossible?.message).toContain('500000ms')
  })

  test('the IDENTICAL document, with no settings accessor passed at all, falls back to the schema default and is NOT flagged', async () => {
    const { db, registry, store } = setUp()
    publishScriptRow(db, 'node-a', '1.0.0', { timeoutMs: 400_000 })
    publishScriptRow(db, 'node-b', '1.0.0', { timeoutMs: 400_000 })

    const app = withUser('operator', createWorkflowRoutes({ db, registry, store }))
    const res = await app.request('/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: twoNodeDoc() }) })
    expect(res.status).toBe(200)
    const findings = (await res.json()) as Array<{ code: string }>
    expect(findings.some((f) => f.code === 'E_WORKFLOW_BUDGET_IMPOSSIBLE')).toBe(false)
  })
})
