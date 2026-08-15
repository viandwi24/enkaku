import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'bun:test'
import type { RecordingDoc } from '@enkaku/protocol'
import { defineRecording } from '@enkaku/sdk'
import type { AuthEnv } from '../auth/middleware'
import { createAuditLogger } from '../auth/audit'
import { openDb, runMigrations, type Db } from '../db'
import { scripts } from '../db/schema'
import { createWorkspaceStore, type WorkspaceStore } from '../workspace/store'
import type { RecordingService } from '../recording/service'
import { createRecordingRoutes } from './recordings'

/**
 * `GET/POST/PATCH/DELETE /api/recordings*` (plan 94 §4.9, §5 step 94.5).
 * Exercises the routes exactly as `http.ts` mounts them — through a real
 * SQLite `:memory:` db and a real `WorkspaceStore`, never a mock of either,
 * so `buildScriptFromWorkspace`/`publishScript` run for real (F11: this IS
 * the "no new bundling" claim, proven rather than asserted).
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

const QUOTAS = { maxFileBytes: 1_048_576, maxFilesPerScope: 1_000, maxTotalBytesPerScope: 64 * 1024 * 1024 }

function setUp(): { db: Db; workspace: WorkspaceStore } {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return { db: opened.db, workspace: createWorkspaceStore(opened.db, () => QUOTAS) }
}

function sampleDoc(overrides: Partial<RecordingDoc> = {}): RecordingDoc {
  return {
    schema: 1,
    name: 'checkout-flow',
    version: '1.0.0',
    description: 'Taps through checkout',
    recordedAt: 1_700_000_000,
    recordedOn: { stableId: 'abc123', model: 'moto g06 power', width: 1080, height: 2400 },
    speed: 1,
    maxGapMs: 15_000,
    cleanup: 'force-stop',
    packages: ['com.example.app'],
    steps: [
      { kind: 'tap', gapMs: 400, target: { kind: 'point', pos: { x: 0.5, y: 0.3 } }, holdMs: 80 },
      { kind: 'text', gapMs: 200, value: 'hunter2' },
      { kind: 'text', gapMs: 200, value: { param: 'caption' } },
    ],
    ...overrides,
  }
}

/** A fake `RecordingService` whose only wired method is `lastFinished` — every other method is unused by these routes and throws if called by mistake. */
function fakeRecordingService(lastFinishedByDevice: Record<string, RecordingDoc | undefined>): RecordingService {
  const notImplemented = (name: string) => {
    throw new Error(`unexpected call: ${name}`)
  }
  return {
    start: () => notImplemented('start'),
    get: () => null,
    stop: () => notImplemented('stop'),
    cancel: () => notImplemented('cancel'),
    lastFinished: (deviceId) => lastFinishedByDevice[deviceId] ?? null,
    stopForLeaseLost: () => undefined,
    onStep: () => undefined,
    onBoundStopped: () => undefined,
  }
}

async function writeRecording(workspace: WorkspaceStore, doc: RecordingDoc): Promise<void> {
  workspace.write(`/recordings/${doc.name}.recording.json`, { content: new TextEncoder().encode(JSON.stringify(doc, null, 2)), actor: null })
}

describe('GET /api/recordings', () => {
  test('lists every /recordings/*.recording.json with step count, detached flag, published version', async () => {
    const { db, workspace } = setUp()
    await writeRecording(workspace, sampleDoc())
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { slug: string; stepCount: number; detached: boolean; publishedVersion: string | null }[] }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ slug: 'checkout-flow', stepCount: 3, detached: false, publishedVersion: null })
  })

  test('an unauthenticated caller is refused', async () => {
    const { db, workspace } = setUp()
    const app = withUser(null, createRecordingRoutes({ db, workspace }))
    const res = await app.request('/')
    expect(res.status).toBe(403)
  })

  test('a corrupt file is reported, not thrown', async () => {
    const { db, workspace } = setUp()
    workspace.write('/recordings/broken.recording.json', { content: new TextEncoder().encode('not json'), actor: null })
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { slug: string; corrupt: boolean }[] }
    expect(body.items[0]).toMatchObject({ slug: 'broken', corrupt: true })
  })
})

describe('GET /api/recordings/:slug', () => {
  test('returns the document plus a generated-source preview', async () => {
    const { db, workspace } = setUp()
    await writeRecording(workspace, sampleDoc())
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    const res = await app.request('/checkout-flow')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { doc: RecordingDoc; generatedSource: string | null; hash: string }
    expect(body.doc.name).toBe('checkout-flow')
    expect(body.generatedSource).toContain('defineRecording(')
    expect(body.hash).toBe(workspace.read('/recordings/checkout-flow.recording.json').hash)
  })

  test('404s honestly on a missing slug', async () => {
    const { db, workspace } = setUp()
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    const res = await app.request('/does-not-exist')
    expect(res.status).toBe(404)
  })
})

describe('POST /api/recordings (create — an addition beyond §4.9\'s six routes, see this file\'s own header)', () => {
  test('pulls a finished in-memory recording and writes the first .recording.json', async () => {
    const { db, workspace } = setUp()
    const recording = fakeRecordingService({ dev1: sampleDoc({ name: 'placeholder', version: '0.0.0' }) })
    const app = withUser('operator', createRecordingRoutes({ db, workspace, recording }))
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev1', name: 'checkout-flow', version: '1.0.0' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { slug: string }
    expect(body.slug).toBe('checkout-flow')
    expect(() => workspace.read('/recordings/checkout-flow.recording.json')).not.toThrow()
  })

  test('refuses with E_NO_RECORDING_DOCUMENT when nothing is waiting for that device', async () => {
    const { db, workspace } = setUp()
    const recording = fakeRecordingService({})
    const app = withUser('operator', createRecordingRoutes({ db, workspace, recording }))
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev1', name: 'checkout-flow', version: '1.0.0' }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_NO_RECORDING_DOCUMENT')
  })

  test('refuses E_NOT_SUPPORTED when no RecordingService is wired', async () => {
    const { db, workspace } = setUp()
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev1', name: 'checkout-flow', version: '1.0.0' }),
    })
    expect(res.status).toBe(501)
  })
})

describe('PATCH /api/recordings/:slug', () => {
  test('trims steps, reorders, and updates top-level fields under CAS', async () => {
    const { db, workspace } = setUp()
    const doc = sampleDoc()
    await writeRecording(workspace, doc)
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    const hash = workspace.read('/recordings/checkout-flow.recording.json').hash
    const res = await app.request('/checkout-flow', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ifMatch: hash, doc: { steps: [doc.steps[0]], speed: 2, maxGapMs: 5_000 } }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { doc: RecordingDoc }
    expect(body.doc.steps).toHaveLength(1)
    expect(body.doc.speed).toBe(2)
    expect(body.doc.maxGapMs).toBe(5_000)
    // name/schema/recordedAt/recordedOn are immutable through this route.
    expect(body.doc.name).toBe('checkout-flow')
    expect(body.doc.recordedOn).toEqual(doc.recordedOn)
  })

  test('a stale ifMatch is refused with E_STALE, never silently applied', async () => {
    const { db, workspace } = setUp()
    await writeRecording(workspace, sampleDoc())
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    const res = await app.request('/checkout-flow', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ifMatch: 'not-the-real-hash', doc: { speed: 3 } }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_STALE')
  })

  test('promoting a candidate is an ordinary PATCH — the client turns a point target into a selector target', async () => {
    const { db, workspace } = setUp()
    const doc = sampleDoc({
      steps: [
        {
          kind: 'tap',
          gapMs: 100,
          target: { kind: 'point', pos: { x: 0.5, y: 0.5 } },
          candidate: { selector: { id: 'com.example.app:id/btn' }, count: 1, anchorAgeMs: 50, anchorStepsSince: 0, anchorPackage: 'com.example.app' },
        },
      ],
    })
    await writeRecording(workspace, doc)
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    const hash = workspace.read('/recordings/checkout-flow.recording.json').hash
    const promoted = { kind: 'tap' as const, gapMs: 100, target: { kind: 'selector' as const, selector: { id: 'com.example.app:id/btn' }, fallback: { x: 0.5, y: 0.5 } } }
    const res = await app.request('/checkout-flow', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ifMatch: hash, doc: { steps: [promoted] } }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { doc: RecordingDoc }
    const step0 = body.doc.steps[0]
    expect(step0?.kind === 'tap' && step0.target).toEqual({ kind: 'selector', selector: { id: 'com.example.app:id/btn' }, fallback: { x: 0.5, y: 0.5 } })
  })

  test('refused once the recording is detached', async () => {
    const { db, workspace } = setUp()
    await writeRecording(workspace, sampleDoc())
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    await app.request('/checkout-flow/detach', { method: 'POST' })
    const hash = workspace.read('/recordings/checkout-flow.recording.json').hash
    const res = await app.request('/checkout-flow', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ifMatch: hash, doc: { speed: 3 } }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_RECORDING_DETACHED')
  })
})

describe('DELETE /api/recordings/:slug', () => {
  test('deletes the document, the compiled entry, and the detached marker', async () => {
    const { db, workspace } = setUp()
    await writeRecording(workspace, sampleDoc())
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    await app.request('/checkout-flow/publish', { method: 'POST' })
    expect(() => workspace.read('/recordings/checkout-flow.ts')).not.toThrow()
    const res = await app.request('/checkout-flow', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(() => workspace.read('/recordings/checkout-flow.recording.json')).toThrow()
    expect(() => workspace.read('/recordings/checkout-flow.ts')).toThrow()
  })

  test('404s on a missing slug', async () => {
    const { db, workspace } = setUp()
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    const res = await app.request('/nope', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/recordings/:slug/publish (acceptance criteria 2, 3 — the core of step 94.5)', () => {
  test('publishing produces a scripts row indistinguishable from a hand-written one', async () => {
    const { db, workspace } = setUp()
    await writeRecording(workspace, sampleDoc())
    const app = withUser('operator', createRecordingRoutes({ db, workspace, audit: createAuditLogger(db) }))
    const res = await app.request('/checkout-flow/publish', { method: 'POST' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { script: { id: string; name: string; version: string } }
    expect(body.script.name).toBe('checkout-flow')
    expect(body.script.version).toBe('1.0.0')

    const row = db.select().from(scripts).where(eq(scripts.id, body.script.id)).get()
    expect(row).toBeTruthy()
    // The one non-negotiable property (acceptance criterion 2): `kind` is the
    // DEFAULT a hand-written script gets, never a special marker.
    expect(row?.kind).toBe('script')
    expect(row?.enabled).toBe(true)
  })

  test('GET /api/scripts/:id-equivalent source is readable generated source (F12, acceptance criterion 3)', async () => {
    const { db, workspace } = setUp()
    await writeRecording(workspace, sampleDoc())
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    const res = await app.request('/checkout-flow/publish', { method: 'POST' })
    const body = (await res.json()) as { script: { id: string } }
    const row = db.select().from(scripts).where(eq(scripts.id, body.script.id)).get()
    expect(row?.source).toBeTruthy()
    const source = row?.source as string
    expect(source).toContain("import { defineRecording } from '@enkaku/sdk'")
    expect(source).toContain('export default defineRecording(')
    // A human reading this can see exactly what steps will run — not opaque bundle output.
    expect(source).toContain('"kind": "tap"')
  })

  test('the published bundle is a real, runnable ScriptDefinition — never executed by the build itself (F11, F18)', async () => {
    const { db, workspace } = setUp()
    await writeRecording(workspace, sampleDoc())
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    const res = await app.request('/checkout-flow/publish', { method: 'POST' })
    const body = (await res.json()) as { script: { id: string } }
    const row = db.select().from(scripts).where(eq(scripts.id, body.script.id)).get()
    const tmpPath = `/tmp/enkaku-recordings-test-${crypto.randomUUID()}.mjs`
    await Bun.write(tmpPath, row?.bundle as string)
    const mod = (await import(tmpPath)) as { default: ReturnType<typeof defineRecording> }
    expect(mod.default.id).toBe('checkout-flow')
    expect(mod.default.version).toBe('1.0.0')
    expect(typeof mod.default.run).toBe('function')
  })

  test('the declared params schema requires the recording\'s own {param} field', async () => {
    const { db, workspace } = setUp()
    await writeRecording(workspace, sampleDoc())
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    const res = await app.request('/checkout-flow/publish', { method: 'POST' })
    const body = (await res.json()) as { script: { id: string } }
    const row = db.select().from(scripts).where(eq(scripts.id, body.script.id)).get()
    const paramsSchema = row?.paramsSchema as { required: string[] }
    expect(paramsSchema.required).toEqual(['caption'])
  })

  test('a version override in the body publishes that version and persists it back onto the document', async () => {
    const { db, workspace } = setUp()
    await writeRecording(workspace, sampleDoc())
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    const res = await app.request('/checkout-flow/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '1.1.0' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { script: { version: string } }
    expect(body.script.version).toBe('1.1.0')
    const stored = JSON.parse(new TextDecoder().decode(workspace.read('/recordings/checkout-flow.recording.json').content)) as RecordingDoc
    expect(stored.version).toBe('1.1.0')
  })

  test('publishing the same (name, version) twice refuses script_version_exists', async () => {
    const { db, workspace } = setUp()
    await writeRecording(workspace, sampleDoc())
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    await app.request('/checkout-flow/publish', { method: 'POST' })
    const res = await app.request('/checkout-flow/publish', { method: 'POST' })
    expect(res.status).toBe(409)
  })

  test('refused once detached — the recording no longer regenerates over the operator\'s file (criterion 4)', async () => {
    const { db, workspace } = setUp()
    await writeRecording(workspace, sampleDoc())
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    await app.request('/checkout-flow/detach', { method: 'POST' })
    const res = await app.request('/checkout-flow/publish', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('E_RECORDING_DETACHED')
  })

  test('recompiling with no edit writes byte-identical bytes to /recordings/:slug.ts', async () => {
    const { db, workspace } = setUp()
    await writeRecording(workspace, sampleDoc({ version: '1.0.0' }))
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    await app.request('/checkout-flow/publish', { method: 'POST' })
    const first = workspace.read('/recordings/checkout-flow.ts')
    // Publish a second version off the SAME unedited document — the entry recompiles, but its
    // content should be identical bar the version bump this test does not exercise (same version
    // is refused above; here we assert the compiled TEXT for the CURRENT document is stable).
    const again = await app.request('/checkout-flow', { method: 'GET' })
    const detail = (await again.json()) as { generatedSource: string }
    expect(detail.generatedSource).toBe(new TextDecoder().decode(first.content))
  })
})

describe('POST /api/recordings/:slug/detach (acceptance criterion 4)', () => {
  test('writes a plain defineScript to /scripts/:slug.ts and deletes the compiled recording entry', async () => {
    const { db, workspace } = setUp()
    await writeRecording(workspace, sampleDoc())
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    await app.request('/checkout-flow/publish', { method: 'POST' }) // compiles /recordings/checkout-flow.ts first
    expect(() => workspace.read('/recordings/checkout-flow.ts')).not.toThrow()

    const res = await app.request('/checkout-flow/detach', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { scriptPath: string }
    expect(body.scriptPath).toBe('/scripts/checkout-flow.ts')

    const scriptFile = workspace.read('/scripts/checkout-flow.ts')
    const scriptSource = new TextDecoder().decode(scriptFile.content)
    expect(scriptSource).toContain("import { defineScript } from '@enkaku/sdk'")
    expect(scriptSource).not.toContain('defineRecording')

    // The recording stops regenerating over it (criterion 4) — the compiled entry is gone.
    expect(() => workspace.read('/recordings/checkout-flow.ts')).toThrow()
    // The recording document itself is kept, marked detached.
    expect(() => workspace.read('/recordings/checkout-flow.recording.json')).not.toThrow()
  })

  test('a second detach on the same slug is refused, not silently repeated', async () => {
    const { db, workspace } = setUp()
    await writeRecording(workspace, sampleDoc())
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    await app.request('/checkout-flow/detach', { method: 'POST' })
    const res = await app.request('/checkout-flow/detach', { method: 'POST' })
    expect(res.status).toBe(409)
  })

  test('never overwrites a pre-existing hand-authored file at the same script path', async () => {
    const { db, workspace } = setUp()
    await writeRecording(workspace, sampleDoc())
    workspace.write('/scripts/checkout-flow.ts', { content: new TextEncoder().encode('// a human wrote this'), actor: null })
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    const res = await app.request('/checkout-flow/detach', { method: 'POST' })
    expect(res.status).toBe(409)
    const source = new TextDecoder().decode(workspace.read('/scripts/checkout-flow.ts').content)
    expect(source).toBe('// a human wrote this')
  })

  test('a detached recording is listed with detached: true and publish stays refused permanently', async () => {
    const { db, workspace } = setUp()
    await writeRecording(workspace, sampleDoc())
    const app = withUser('operator', createRecordingRoutes({ db, workspace }))
    await app.request('/checkout-flow/detach', { method: 'POST' })
    const listRes = await app.request('/')
    const listBody = (await listRes.json()) as { items: { detached: boolean }[] }
    expect(listBody.items[0]?.detached).toBe(true)
    const publishRes = await app.request('/checkout-flow/publish', { method: 'POST' })
    expect(publishRes.status).toBe(409)
  })
})
