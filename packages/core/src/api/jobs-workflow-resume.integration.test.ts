import { Hono } from 'hono'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { JobRunner, SessionManager } from '@enkaku/session'
import type { JobInfo, JobNodeInfo } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { devices, scripts, type JobRow } from '../db/schema'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createScriptRegistry } from '../scripts/registry'
import { createJobStore, type ConcreteJobStore } from '../queue/job-store'
import { createJobService } from '../services/job-service'
import { createJobNodeTracker } from '../runner/artifact-store'
import { createWorkflowExecutor, DEFAULT_WORKFLOW_MAX_TOTAL_MS } from '../jobs/executors/workflow'
import type { ExecutorContext } from '../jobs/executor'
import { ExecutorRegistry } from '../jobs/executor'
import type { ExecutorHost } from '../jobs/executor-host'
import type { Scheduler } from '../queue/scheduler'
import type { Logger } from '../util/logger'
import type { AuthEnv } from '../auth/middleware'
import { createJobRoutes } from './jobs'

/**
 * Plan 99 §3.5, §4.9, step 99.8's own brief: "Prove GET /:id/nodes and
 * POST /:id/resume from the real HTTP surface against rows the real
 * workflow executor wrote, not against fixtures you shaped yourself."
 *
 * This file does exactly that — no `JobNodeInfo`/`JobRow` is hand-built
 * anywhere below: a real 3-node workflow runs through the REAL
 * `createWorkflowExecutor` (step 99.7, untouched by this step) against a
 * REAL SQLite database, and both routes are then hit through a REAL
 * `Hono` app built from `createJobRoutes` + `createJobService` +
 * `createJobStore` — the exact chain a production request takes.
 *
 * `workflow.test.ts` and `workflow-real-claim.integration.test.ts`
 * (`jobs/executors/`, a directory this step does not own) already prove the
 * INTERPRETER's own contract in isolation and against the real claim path;
 * this file is the one place that proves the two ROUTES this step adds
 * read what that interpreter actually wrote.
 */

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

const silentLog = (): Logger => {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l as unknown as Logger
}

function publishScript(db: Db, name: string, version: string) {
  const id = `${name}-${version}`
  db.insert(scripts)
    .values({ pluginId: 'p-fixture', exportId: 'main', id, name, version, kind: 'script', bundle: 'export default { run: async () => null }', enabled: true, createdAt: new Date() })
    .run()
  return id
}

function publishWorkflow(db: Db, name: string, version: string, doc: unknown) {
  const id = `${name}-${version}`
  db.insert(scripts)
    .values({ id, name, version, kind: 'workflow', bundle: JSON.stringify(doc), source: JSON.stringify(doc, null, 2), enabled: true, createdAt: new Date() })
    .run()
  return id
}

type ExecuteCall = { nodeId?: string }
type Outcome = { ok: boolean; value?: unknown; error?: { code: string; message: string; phase: string } }

function fakeRunner(outcomes: Record<string, () => Outcome>): { runner: JobRunner; calls: ExecuteCall[] } {
  const calls: ExecuteCall[] = []
  const runner: JobRunner = {
    async execute(job) {
      calls.push({ nodeId: job.nodeId })
      const fn = outcomes[job.nodeId ?? 'default'] ?? outcomes.default
      if (!fn) throw new Error(`fakeRunner: no outcome configured for node "${job.nodeId}"`)
      return fn()
    },
    abort: () => true,
    notifyAssist: () => false,
  }
  return { runner, calls }
}

function fakeSessions(): SessionManager {
  return {
    acquire: async (deviceId) => ({ deviceId, inspector: null, whenInspectorReady: async () => {} }) as never,
    release: () => {},
    get: () => null as never,
    closeDevice: async () => {},
    closeIfIdle: async () => {},
    idleSessions: () => [],
    closeAll: async () => 0,
  }
}

function makeCtx(): ExecutorContext {
  return { signal: new AbortController().signal, heartbeat: () => {}, log: silentLog() }
}

function newRegistry(db: Db) {
  return createScriptRegistry({ db, dataDir: `/tmp/enkaku-jobs-resume-test-${crypto.randomUUID()}`, devSlots: createDevSlotStore() })
}

/** Runs a 3-node workflow (a, b succeed; c fails) through the REAL interpreter, then settles the job — mirroring what `ExecutorHost` would do, bypassed here for speed exactly as `workflow.test.ts` bypasses it. */
async function runOriginalWorkflow(db: Db): Promise<{ jobStore: ConcreteJobStore; originalJobRow: JobRow; workflowId: string }> {
  db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'device d1', status: 'idle' }).run()
  publishScript(db, 'node-a', '1.0.0')
  publishScript(db, 'node-b', '1.0.0')
  publishScript(db, 'node-c', '1.0.0')
  const doc = {
    schema: 1,
    name: 'pipeline',
    version: '1.0.0',
    params: [],
    nodes: [
      { kind: 'script', id: 'a', script: 'node-a@1.0.0', params: {}, onFailure: { go: 'fail' } },
      { kind: 'script', id: 'b', script: 'node-b@1.0.0', params: {}, onFailure: { go: 'fail' } },
      // References BOTH earlier nodes' outputs — proves data actually
      // flowed along the edge, the same way `workflow-real-claim
      // .integration.test.ts` proves it for an ordinary (non-resumed) run.
      { kind: 'script', id: 'c', script: 'node-c@1.0.0', params: { fromA: { from: 'a' }, fromB: { from: 'b', path: 'count' } }, onFailure: { go: 'fail' } },
    ],
    maxSteps: 50,
  }
  const workflowId = publishWorkflow(db, 'pipeline', '1.0.0', doc)

  const { runner, calls } = fakeRunner({
    a: () => ({ ok: true, value: { count: 1 } }),
    b: () => ({ ok: true, value: { count: 2 } }),
    c: () => ({ ok: false, error: { code: 'E_TEST_FAIL', message: 'boom', phase: 'run' } }),
  })

  const jobStore = createJobStore(db)
  const enqueued = jobStore.enqueue({ scriptId: workflowId, deviceId: 'd1', params: {}, priority: 0 })
  const claimed = jobStore.claimNext(60)
  if (!claimed) throw new Error('claimNext must claim the freshly-enqueued job')
  expect(claimed.job.id).toBe(enqueued.id)

  const executor = createWorkflowExecutor({
    db,
    registry: newRegistry(db),
    runner,
    sessions: fakeSessions(),
    nodeTracker: createJobNodeTracker(),
    settings: () => ({ maxTotalMs: DEFAULT_WORKFLOW_MAX_TOTAL_MS }),
    log: silentLog(),
    onNode: () => {},
  })

  let threw: unknown
  try {
    await executor.run(claimed.job, makeCtx())
  } catch (err) {
    threw = err
  }
  expect(threw).toBeDefined() // node "c" failed with the default onFailure: 'fail'
  expect(calls.map((c) => c.nodeId)).toEqual(['a', 'b', 'c'])

  // What `ExecutorHost`/`DeviceStateMachine` would do next (bypassed here,
  // matching workflow.test.ts) — settle the JOBS row so the job is
  // terminal, which `POST /:id/resume` requires, and return the DEVICE to
  // idle, which a real settle always does and which `claimNext` for any
  // later job (including a resume) depends on.
  jobStore.finish(enqueued.id, 'failed', { error: 'node "c" failed: boom', failureClass: 'script' })
  db.update(devices).set({ status: 'idle' }).where(eq(devices.id, 'd1')).run()

  const originalJobRow = jobStore.get(enqueued.id)
  if (!originalJobRow) throw new Error('the job must still exist after finish()')
  return { jobStore, originalJobRow, workflowId }
}

function buildApp(jobStore: ConcreteJobStore, role: 'operator' | 'admin' = 'operator') {
  const service = createJobService({
    jobStore,
    registry: new ExecutorRegistry(),
    scheduler: { kick: () => {}, start: () => {}, stop: () => {} } as Scheduler,
    host: {} as ExecutorHost,
    log: silentLog(),
    onJobStatus: () => {},
    getDeviceOwner: () => ({ ownerId: null }),
  })
  const app = new Hono<AuthEnv>()
  app.use('*', async (c, next) => {
    c.set('user', { id: 'u1', email: 'u@test', role })
    await next()
  })
  app.route('/', createJobRoutes(service, { getDeviceOwner: () => ({ ownerId: null }) }))
  return app
}

describe('GET /:id/nodes and POST /:id/resume — real HTTP surface, real workflow-executor rows (plan 99 §3.5, §4.9, step 99.8)', () => {
  test('GET /:id/nodes returns the real timeline the real executor wrote, with real bound output', async () => {
    const db = setUpDb()
    const { jobStore, originalJobRow } = await runOriginalWorkflow(db)
    const app = buildApp(jobStore)

    const res = await app.request(`/${originalJobRow.id}/nodes`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: JobNodeInfo[]; finalized: boolean }

    expect(body.finalized).toBe(true) // the job settled to 'failed'
    expect(body.items.map((n) => [n.seq, n.nodeId, n.status])).toEqual([
      [0, 'a', 'success'],
      [1, 'b', 'success'],
      [2, 'c', 'failed'],
    ])
    expect(body.items[0]?.output.value).toEqual({ count: 1 })
    expect(body.items[1]?.output.value).toEqual({ count: 2 })
    // Node c's own recorded failure, on the STRUCTURED shape (plan 99 §4.9's merge).
    expect(body.items[2]?.output.error).toEqual({ code: 'E_TEST_FAIL', message: 'boom' })
    expect(body.items[2]?.attempts.lastError).toEqual({ code: 'E_TEST_FAIL', message: 'boom' })
  })

  test('POST /:id/resume (fromNode omitted) creates a new job for the SAME resolved scriptId, defaulting to the last attempted node ("c")', async () => {
    const db = setUpDb()
    const { jobStore, originalJobRow, workflowId } = await runOriginalWorkflow(db)
    const app = buildApp(jobStore)

    const res = await app.request(`/${originalJobRow.id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { job: JobInfo }

    // The whole point of §3.5: the SAME resolved id, never re-resolved.
    expect(body.job.scriptId).toBe(workflowId)
    expect(body.job.scriptId).toBe(originalJobRow.scriptId)
    expect(body.job.jobId).not.toBe(originalJobRow.id)
    expect(body.job.deviceId).toBe(originalJobRow.deviceId)

    const resumeInfo = jobStore.resumeInfo(body.job.jobId)
    expect(resumeInfo).toEqual({ resumedFromJobId: originalJobRow.id, resumedFromNode: 'c' })
  })

  test('POST /:id/resume with an explicit fromNode overrides the default', async () => {
    const db = setUpDb()
    const { jobStore, originalJobRow } = await runOriginalWorkflow(db)
    const app = buildApp(jobStore)

    const res = await app.request(`/${originalJobRow.id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromNode: 'b' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { job: JobInfo }
    expect(jobStore.resumeInfo(body.job.jobId)).toEqual({ resumedFromJobId: originalJobRow.id, resumedFromNode: 'b' })
  })

  test('POST /:id/resume with a node that never ran is refused 400, and creates nothing', async () => {
    const db = setUpDb()
    const { jobStore, originalJobRow } = await runOriginalWorkflow(db)
    const app = buildApp(jobStore)
    const before = jobStore.list({ limit: 50 }).total

    const res = await app.request(`/${originalJobRow.id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromNode: 'does-not-exist' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('job_node_not_found')
    expect(jobStore.list({ limit: 50 }).total).toBe(before)
  })

  test('POST /:id/resume on a job still running is refused 409', async () => {
    const db = setUpDb()
    db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'device d1', status: 'busy' }).run()
    const workflowId = publishWorkflow(db, 'pipeline', '1.0.0', { schema: 1, name: 'pipeline', version: '1.0.0', params: [], nodes: [{ kind: 'script', id: 'a', script: 'x@1.0.0', params: {}, onFailure: { go: 'fail' } }], maxSteps: 50 })
    const jobStore = createJobStore(db)
    const enqueued = jobStore.enqueue({ scriptId: workflowId, deviceId: 'd1', params: {}, priority: 0 })
    // Still queued, never claimed — not terminal.
    const app = buildApp(jobStore)

    const res = await app.request(`/${enqueued.id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('job_not_terminal')
  })

  /**
   * SELF-DETECTING GAP — fails while the fix is missing, per this step's own
   * brief ("if a small edit in another file is unavoidable, make the gap
   * self-detecting: a test that fails while it is missing, naming the exact
   * lines").
   *
   * `packages/core/src/jobs/executors/workflow.ts` is outside this step's
   * file list (`jobs/executors/**`), so the interpreter itself was not
   * touched. `POST /:id/resume` (proven above) does everything a ROUTE can:
   * it creates the new job for the resolved scriptId and records
   * `{ resumedFromJobId, resumedFromNode }` in `job_resumes` (the side table
   * this step added — `packages/core/src/db/schema.ts`, migration
   * `0047_dear_quasar.sql` — deliberately NOT two columns on `jobs` itself,
   * because `JobRow` is hand-built as a literal fixture in several files
   * this step does not own, and two more required keys there would force an
   * edit to every one of them for no logic reason).
   *
   * But `createWorkflowExecutor`'s `run()` NEVER reads `job_resumes` — not
   * today, and not through any seam this step could add without editing
   * that file. Every workflow job, resumed or not, starts its interpreter
   * at `doc.nodes[0]` with an empty `outputs` map. This test proves it
   * against the REAL executor and the REAL row `POST /:id/resume` (a real
   * HTTP call, above) just created — not a synthetic fixture.
   *
   * THE FIX (verbatim, for whoever picks this up — belongs in `run()`,
   * right after `doc` is parsed and before the `cursor`/`outputs` locals
   * are initialised, ~`workflow.ts:199-204`):
   *
   *   const resumeInfo = deps.db.select().from(jobResumes).where(eq(jobResumes.jobId, job.id)).get()
   *   let cursor: string | null = resumeInfo?.resumedFromNode ?? (doc.nodes[0] as WorkflowNode).id
   *   const outputs = new Map<string, unknown>()
   *   if (resumeInfo) {
   *     const priorRows = deps.db.select().from(jobNodes)
   *       .where(and(eq(jobNodes.jobId, resumeInfo.resumedFromJobId), eq(jobNodes.status, 'success')))
   *       .orderBy(asc(jobNodes.seq)).all()
   *     for (const r of priorRows) outputs.set(r.nodeId, r.output)   // later seq overwrites earlier — same rule ResolveScope.outputs already documents
   *     // write 'skipped-on-resume' rows for every node BEFORE resumeInfo.resumedFromNode in doc order,
   *     // with resumedFromJobId/resumedFromNode set on the FIRST such row (or the resumed node's own
   *     // row if none are skipped) — mirrors the 'skipped' bulk-write this file already does in `finally`.
   *   }
   *
   * No change to `WorkflowExecutorDeps`'s signature is needed — `deps.db` is
   * already there, and `jobResumes`/`jobNodes` are both already exported
   * from `../../db/schema` (this file's own relative import path).
   *
   * HOW THIS TEST PROVES IT WITHOUT EDITING `workflow.ts`: it runs the
   * UNMODIFIED real executor against the resumed job's REAL row and REAL
   * `job_resumes` entry, and asserts the desired outcome — only node "c"
   * executes, because "a" and "b" already succeeded in the original job.
   * TODAY this fails (`calls.map(...)` reads `['a','b','c']`, not `['c']`):
   * the interpreter reruns everything. The day the fix above lands, this
   * exact assertion starts passing with no edit to this file.
   */
  test('SELF-DETECTING GAP: a resumed job re-runs every node instead of continuing from where it stopped, because workflow.ts never reads job_resumes', async () => {
    const db = setUpDb()
    const { jobStore, originalJobRow } = await runOriginalWorkflow(db)
    const app = buildApp(jobStore)

    const resumeRes = await app.request(`/${originalJobRow.id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(resumeRes.status).toBe(201)
    const { job: resumedJobInfo } = (await resumeRes.json()) as { job: JobInfo }

    // The route did its job: `job_resumes` has the real lineage.
    expect(jobStore.resumeInfo(resumedJobInfo.jobId)).toEqual({ resumedFromJobId: originalJobRow.id, resumedFromNode: 'c' })

    const resumedRow = jobStore.claimNext(60)?.job
    if (!resumedRow) throw new Error('the resumed job must be claimable — the device is idle again after finish()')
    expect(resumedRow.id).toBe(resumedJobInfo.jobId)

    const { runner: runner2, calls: calls2 } = fakeRunner({
      a: () => ({ ok: true, value: { count: 1 } }),
      b: () => ({ ok: true, value: { count: 2 } }),
      c: () => ({ ok: true, value: { count: 3 } }),
    })
    const executor2 = createWorkflowExecutor({
      db,
      registry: newRegistry(db),
      runner: runner2,
      sessions: fakeSessions(),
      nodeTracker: createJobNodeTracker(),
      settings: () => ({ maxTotalMs: DEFAULT_WORKFLOW_MAX_TOTAL_MS }),
      log: silentLog(),
      onNode: () => {},
    })
    await executor2.run(resumedRow, makeCtx())

    // THE line that flips red → green the day workflow.ts's `run()` reads
    // `job_resumes` — no other edit needed in this file.
    expect(calls2.map((c) => c.nodeId)).toEqual(['c'])
  })
})
