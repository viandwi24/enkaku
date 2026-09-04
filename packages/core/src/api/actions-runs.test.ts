import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { WorkflowDocSchema, type ActionRequest } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { devices } from '../db/schema'
import { ExecutorRegistry } from '../jobs/executor'
import type { ExecutorHost } from '../jobs/executor-host'
import { createRunStore } from '../jobs/runs/store'
import { createJobStore } from '../queue/job-store'
import type { Scheduler } from '../queue/scheduler'
import { createJobService } from '../services/job-service'
import { createAuditLogger } from '../auth/audit'
import { createOperationRegistry } from '../actions/operations'
import { createWorkflowStore } from '../workflows/store'
import { runAction, type ActionsDeps } from '../actions/run'

/**
 * `api/actions-runs.test.ts` (plan 211 §7.1, G7/G8) — `run-script`/
 * `run-workflow`'s re-run-adds-a-run behaviour and workflow batch dispatch,
 * exercised through `runAction` directly (the same function `POST /api/
 * actions/:verb` calls — `api/actions.ts`'s own handler is a thin JSON/auth
 * wrapper around it, proven separately in `api/actions.test.ts`).
 *
 * `ActionsDeps` is built from REAL sub-components wherever plan 211's own
 * area touches them (db, `JobStore`/`RunStore`/`JobService`, `WorkflowStore`,
 * `AuditLogger`, `OperationRegistry`) — everything else in the interface
 * (transfer, guest agent routes, preparation, …) is untouched by
 * `run-script`/`run-workflow` and is stubbed to throw if it is ever called,
 * so a wiring mistake fails loudly instead of silently passing.
 */

function unused(name: string): never {
  throw new Error(`${name} is not exercised by run-script/run-workflow`)
}

/** An object every property access on which throws — for a dep whose shape is itself an object (`transfer`, `lifecycle`, `preparation`), not a function. */
function unusedObject<T>(name: string): T {
  return new Proxy(
    {},
    {
      get: () => unused(name),
    },
  ) as T
}

function setUp(): { db: Db; deps: ActionsDeps } {
  const opened = openDb(':memory:')
  runMigrations(opened.db, opened.sqlite)
  const db = opened.db
  db.insert(devices).values({ id: 'd1', stableId: 'stable-d1', serial: 'serial-d1', label: 'd1', status: 'online' }).run()
  db.insert(devices).values({ id: 'd2', stableId: 'stable-d2', serial: 'serial-d2', label: 'd2', status: 'online' }).run()

  const jobStore = createJobStore(db)
  const runs = createRunStore(db)
  const scheduler: Scheduler = { kick: () => {}, start: () => {}, stop: () => {} }
  const host: ExecutorHost = {
    start: () => {},
    abort: () => false,
    isRunning: () => false,
    finishExternally: () => {},
    notifyCrash: () => false,
    progress: () => {},
    stopAll: () => {},
  }
  const jobService = createJobService({ jobStore, runs, registry: new ExecutorRegistry(), scheduler, host, log: { debug() {}, info() {}, warn() {}, error() {}, child: () => null as never }, onJobStatus: () => {} })
  const audit = createAuditLogger(db)
  const operations = createOperationRegistry({})
  const workflows = createWorkflowStore(db)

  const deps: ActionsDeps = {
    db,
    audit,
    record: () => {},
    broadcast: () => {},
    activities: { list: () => [] } as unknown as ActionsDeps['activities'],
    controlSettings: () => unused('controlSettings'),
    states: {
      current: (deviceId) => (db.select({ status: devices.status }).from(devices).where(eq(devices.id, deviceId)).get()?.status ?? null) as 'online' | 'offline' | 'quarantined' | null,
    },
    operations,
    userLabel: () => 'Test User',
    shellSettings: () => unused('shellSettings'),
    transferSettings: () => unused('transferSettings'),
    batchesFor: (actor) => ({
      db,
      runs,
      scheduler,
      audit,
      onJobStatus: () => {},
      assertDeviceAllowed: (deviceId) => {
        const row = db.select({ ownerId: devices.ownerId }).from(devices).where(eq(devices.id, deviceId)).get()
        if (row?.ownerId && row.ownerId !== actor.id && actor.role !== 'admin') throw new Error('device belongs to another user')
      },
    }),
    jobService,
    workflows,
    resolveScriptRef: (ref) => ({ id: ref }),
    transfer: unusedObject('transfer'),
    shellPortFor: () => unused('shellPortFor'),
    readiness: null,
    reconnector: () => null,
    sessions: () => null,
    cutover: () => null,
    lifecycle: unusedObject('lifecycle'),
    battery: () => null,
    routeService: () => null,
    labelling: null,
    preparation: unusedObject('preparation'),
    screenshot: () => unused('screenshot'),
    dataDir: '/tmp/unused',
    networks: () => [],
    infoWithTags: () => ({ ownerId: null }),
  }
  return { db, deps }
}

const actor = { id: 'u1', role: 'operator' as const }

function runScriptRequest(overrides: Partial<ActionRequest & { verb: 'run-script' }> = {}): ActionRequest {
  return {
    verb: 'run-script',
    target: { deviceIds: ['d1'] },
    force: false,
    scriptId: 'internal:sleep',
    params: {},
    concurrency: 0,
    order: 'as-listed',
    ...overrides,
  } as ActionRequest
}

describe('run-script with jobId (plan 211 §4.8, G7)', () => {
  test('run-script with jobId adds a run to that job', async () => {
    const { deps } = setUp()
    const first = await runAction(deps, runScriptRequest(), actor)
    const jobId = first.results[0]?.jobId
    expect(jobId).toBeTruthy()
    expect(deps.jobService.get(jobId!)?.runCount).toBe(1)

    const second = await runAction(deps, runScriptRequest({ jobId, params: {} }), actor)
    expect(second.results[0]?.jobId).toBe(jobId)
    expect(deps.jobService.get(jobId!)?.runCount).toBe(2)
  })

  test('run-script with jobId and different params creates a new job', async () => {
    const { deps } = setUp()
    const first = await runAction(deps, runScriptRequest({ params: { a: 1 } }), actor)
    const jobId = first.results[0]?.jobId
    expect(jobId).toBeTruthy()

    const second = await runAction(deps, runScriptRequest({ jobId, params: { a: 2 } }), actor)
    const newJobId = second.results[0]?.jobId
    expect(newJobId).toBeTruthy()
    expect(newJobId).not.toBe(jobId)
    expect(deps.jobService.get(jobId!)?.runCount).toBe(1) // the ORIGINAL job's own run count is untouched
  })
})

function workflowDoc() {
  return WorkflowDocSchema.parse({
    schema: 1,
    name: 'wf-1',
    title: 'wf',
    description: '',
    params: [],
    nodes: [{ kind: 'script', id: 's1', title: 'Step 1', script: 'demo/step@1.0.0', params: {}, onFailure: { go: 'fail' } }],
  })
}

describe('run-workflow (plan 211 §4.8, G8)', () => {
  test('run-workflow creates one workflow job per device in a batch', async () => {
    const { deps } = setUp()
    deps.workflows.create({ doc: workflowDoc(), createdBy: null })

    const response = await runAction(
      deps,
      { verb: 'run-workflow', target: { deviceIds: ['d1', 'd2'] }, force: false, workflowName: 'wf-1', params: {} } as ActionRequest,
      actor,
    )

    expect(response.results).toHaveLength(2)
    const batchIds = new Set(response.results.map((r) => r.batchId))
    expect(batchIds.size).toBe(1) // one batch for both devices
    for (const r of response.results) {
      expect(r.status).toBe('done')
      expect(r.jobId).toBeTruthy()
      const detail = deps.jobService.get(r.jobId!)
      expect(detail?.kind).toBe('workflow')
    }
  })
})
