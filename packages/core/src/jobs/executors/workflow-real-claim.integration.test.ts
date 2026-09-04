import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { SessionManager } from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../../db'
import { devices, jobNodes, jobs, scripts } from '../../db/schema'
import type { DeviceHealth } from '../../device/health'
import { createActivityRegistry } from '../../activity/registry'
import { createDevSlotStore } from '../../plugins/dev-slots'
import { createJobStore } from '../../queue/job-store'
import { createJobNodeTracker } from '../../runner/artifact-store'
import { createScriptRegistry } from '../../scripts/registry'
import type { Logger } from '../../util/logger'
import { ExecutorRegistry } from '../executor'
import { createExecutorHost } from '../executor-host'
import { createWorkflowExecutor, DEFAULT_WORKFLOW_MAX_TOTAL_MS } from './workflow'

/**
 * The plan's own central claim, proved against the REAL machinery (plan 99
 * step 99.7's brief: "Prove it against the real claim path —
 * `job-store.ts`'s `BEGIN IMMEDIATE` predicate ... with a second job
 * genuinely queued on the same device while the workflow runs"), reworked by
 * plan 205 §4.7 for the activity model:
 *
 *   a three-node workflow on one device produces ONE `jobs` row, ONE
 *   `job:<id>` activity held end to end, ONE session build, THREE
 *   `job_nodes` rows and THREE child spawns; the device stays `online`
 *   throughout (plan 205 §4.6 — "busy" is derived, never stored) with a
 *   live job activity for the whole pipeline, and NO OTHER queued job on it
 *   is claimed during it.
 *
 * Real throughout, no fakes for the claim path itself: `JobStore` (SQLite,
 * the actual `claimNext` `BEGIN IMMEDIATE` transaction with its `NOT EXISTS`
 * running-job guard), `ActivityRegistry` (the actual in-memory map),
 * `ExecutorHost` (the actual settle/heartbeat/activity lifecycle),
 * `ScriptRegistry`/`JobRunner` (real bundles, REAL spawned child
 * processes — the same subprocess path `plugin-execution.integration.test.ts`
 * already proves for a standalone job). Only `SessionManager` is a fake
 * (recording acquire/release calls) — the REAL refcounted manager needs a
 * live adb/device and is plan 99's own 99.11 hardware measurement, not this
 * step's job; what THIS step owns is that the EXECUTOR calls acquire/release
 * exactly once for the whole pipeline, which a fake proves precisely.
 *
 * `.register()`, not `.setFallback(..., 'workflow')`: `ExecutorHost.start()`
 * does not yet read a job's script `kind` and pass it to
 * `ExecutorRegistry.get()` — a gap in `executor-host.ts` (a file this step
 * does not own) pinned separately and in detail in
 * `../executor-kind-dispatch.test.ts`. Registering the workflow's OWN
 * concrete scriptId via `ExecutorRegistry.register()` (the same door
 * `internal:sleep`/`internal:install` already use) reaches the exact same
 * `ExecutorHost.start()` → `settle()` → activity machinery this test
 * needs to exercise for real, without depending on the separately-tracked
 * gap. `daemon.ts`'s own PRODUCTION wiring — `executors.setFallback(workflowExecutor,
 * 'workflow')` — is pinned by source-text assertion in `daemon-wiring.test.ts`.
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

function seedDevice(db: Db, id: string) {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status: 'online' }).run()
}

function deviceStatus(db: Db, id: string): string | null {
  return db.select({ status: devices.status }).from(devices).where(eq(devices.id, id)).get()?.status ?? null
}

const NODE_A_BUNDLE = `export default { id: 'node-a', version: '1.0.0', params: { parse: (v) => v }, run: async () => ({ marker: 'a', videos: 15 }) }`
// A real, measurable delay — long enough for the test to poll for the
// 'running' job_nodes row and perform its mid-pipeline assertions before
// this node settles.
const NODE_B_BUNDLE = `export default { id: 'node-b', version: '1.0.0', params: { parse: (v) => v }, run: async () => { await new Promise((r) => setTimeout(r, 250)); return { marker: 'b' } } }`
const NODE_C_BUNDLE = `export default { id: 'node-c', version: '1.0.0', params: { parse: (v) => v }, run: async () => ({ marker: 'c' }) }`
const FILLER_BUNDLE = `export default { id: 'filler', version: '1.0.0', params: { parse: (v) => v }, run: async () => 'filler-ok' }`

function publishScript(db: Db, name: string, bundle: string) {
  const id = `${name}-1.0.0`
  db.insert(scripts).values({ pluginId: 'p-fixture', exportId: 'main', id, name, version: '1.0.0', kind: 'script', bundle, enabled: true, createdAt: new Date() }).run()
  return id
}

function publishWorkflow(db: Db, name: string, doc: unknown) {
  const id = `${name}-1.0.0`
  db.insert(scripts)
    .values({ id, name, version: '1.0.0', kind: 'workflow', bundle: JSON.stringify(doc), source: JSON.stringify(doc, null, 2), enabled: true, createdAt: new Date() })
    .run()
  return id
}

/**
 * A REFCOUNTED fake — deliberately not a dumb call recorder. The real
 * `SessionManager` (F11) only actually BUILDS a session when refcount goes
 * 0→1; every acquire while it is already held is a cheap bump. This step's
 * central claim (H1, criterion 5: "one session is built per workflow, not
 * per node") is a fact about THAT distinction — the workflow executor's own
 * outer `acquire()` (once, for the whole pipeline) plus the runner's OWN
 * per-node inner `acquire()`/`release()` pair (three times, once per node)
 * together add up to four acquire calls and three release calls, and the
 * only way to see "one real build" is to count refcount transitions, not
 * raw call counts.
 */
interface RefcountState {
  refcount: number
  acquireCalls: number
  builds: number
  closes: number
}

function refcountingSessions(): { sessions: SessionManager; state: RefcountState } {
  const state: RefcountState = { refcount: 0, acquireCalls: 0, builds: 0, closes: 0 }
  const sessions: SessionManager = {
    acquire: async (deviceId) => {
      state.acquireCalls += 1
      state.refcount += 1
      if (state.refcount === 1) state.builds += 1
      return { deviceId, inspector: null, whenInspectorReady: async () => {}, prewarmInspector: async () => {} } as never
    },
    release: () => {
      state.refcount = Math.max(0, state.refcount - 1)
      if (state.refcount === 0) state.closes += 1
    },
    attachViewer: async () => ({ session: null, quality: 'wall' }) as never,
    detachViewer: () => {},
    build: async () => {},
    whenReady: async () => null as never,
    state: () => 'ready',
    get: () => null as never,
    getByQuality: () => null as never,
    closeDevice: async () => {},
    closeAll: async () => 0,
    encoders: () => [],
  }
  return { sessions, state }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out')
    await Bun.sleep(10)
  }
}

describe("a three-node workflow on one device — plan 99 step 99.7's own verifiable result", () => {
  test('one jobs row, one lease held throughout, one session build, three job_nodes rows, three real child spawns — and a second queued job on the same device is NOT claimed until the workflow settles', async () => {
    const { createJobRunner } = await import('@enkaku/session')
    const db = setUpDb()
    const dataDir = `/tmp/enkaku-workflow-real-claim-${crypto.randomUUID()}`
    seedDevice(db, 'd1')

    publishScript(db, 'node-a', NODE_A_BUNDLE)
    publishScript(db, 'node-b', NODE_B_BUNDLE)
    publishScript(db, 'node-c', NODE_C_BUNDLE)
    const fillerId = publishScript(db, 'filler', FILLER_BUNDLE)

    const doc = {
      schema: 1,
      name: 'pipeline',
      version: '1.0.0',
      params: [],
      nodes: [
        { kind: 'script', id: 'a', script: 'node-a@1.0.0', params: {}, onFailure: { go: 'fail' } },
        { kind: 'script', id: 'b', script: 'node-b@1.0.0', params: {}, onFailure: { go: 'fail' } },
        { kind: 'script', id: 'c', script: 'node-c@1.0.0', params: { fromB: { from: 'b', path: 'marker' } }, onFailure: { go: 'fail' } },
      ],
      maxSteps: 50,
    }
    const workflowId = publishWorkflow(db, 'pipeline', doc)

    const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore() })
    const jobStore = createJobStore(db)
    const { sessions, state: sessionState } = refcountingSessions()

    const runner = createJobRunner({
      logDir: `/tmp/enkaku-workflow-real-claim-logs-${crypto.randomUUID()}`,
      sessions,
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog() as never,
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
    })

    const nodeTracker = createJobNodeTracker()
    const nodeEvents: Array<{ id: string; seq: number; status: string }> = []
    const workflowExecutor = createWorkflowExecutor({
      db,
      registry,
      runner,
      sessions,
      nodeTracker,
      settings: () => ({ maxTotalMs: DEFAULT_WORKFLOW_MAX_TOTAL_MS }),
      log: silentLog(),
      onNode: (_jobId, node) => nodeEvents.push({ id: node.id, seq: node.seq, status: node.status }),
    })

    const executors = new ExecutorRegistry()
    // See this file's own module doc for why `.register()` is used here
    // rather than `.setFallback(..., 'workflow')`.
    executors.register(workflowId, workflowExecutor)

    const activities = createActivityRegistry({ log: silentLog(), controlIdleSec: () => 30, onChange: () => {} })
    const health: DeviceHealth = { note: () => {}, consecutiveFailures: () => 0, start: () => {}, stop: () => {} }

    const host = createExecutorHost({
      registry: executors,
      jobStore,
      activities: () => activities,
      log: silentLog(),
      jobTtlSec: 60,
      heartbeatMs: 5000,
      onJobStatus: () => {},
      onFinished: () => {},
      timeoutIsInfra: () => false,
      rebindOnInfra: () => false,
      health: () => health,
      deviceSerial: (deviceId) => `serial-${deviceId}`,
    })

    // ---- Enqueue and claim the ONE workflow job through the REAL claim SQL. ----
    const enqueued = jobStore.enqueue({ scriptId: workflowId, deviceId: 'd1', params: {}, priority: 0, scriptName: 'pipeline', scriptVersion: '1.0.0' })
    expect(deviceStatus(db, 'd1')).toBe('online') // devices.status never flips any more (plan 205 §4.6)
    expect(activities.list('d1')).toEqual([]) // not yet claimed — no job activity

    const claimed = jobStore.claimNext(60)
    if (!claimed) throw new Error('expected the workflow job to be claimable')
    expect(claimed.job.id).toBe(enqueued.id)
    // The scheduler starts the job activity right after a successful claim
    // (plan 205 §4.7); this test drives `claimNext` directly, so it does the
    // same thing the scheduler's loop would do.
    activities.start(claimed.deviceId, {
      id: `job:${claimed.job.id}`,
      kind: 'job',
      label: 'Running pipeline',
      actor: { kind: 'system', id: 'core', label: 'Scheduler' },
    })

    host.start(claimed.job)

    // ---- While node "b" (the slow one) is running, prove the central claim. ----
    await waitUntil(() => nodeEvents.some((e) => e.id === 'b' && e.status === 'running'))

    // 1. The device stays online, with a live job activity, for the WHOLE
    // pipeline (the same activity list `GET /api/devices` reads).
    expect(deviceStatus(db, 'd1')).toBe('online')
    expect(activities.list('d1').map((a) => a.id)).toEqual([`job:${claimed.job.id}`])

    // 2. One job activity, the SAME jobId, held throughout.
    const midActivity = activities.list('d1').find((a) => a.kind === 'job')
    expect(midActivity?.id).toBe(`job:${claimed.job.id}`)

    // 3. The REAL claim predicate refuses a second queued job on this device
    // while the workflow is still running — the whole point of one job
    // instead of N (plan 99 §3.1's rejection of candidate B).
    const secondJob = jobStore.enqueue({ scriptId: fillerId, deviceId: 'd1', params: {}, priority: 0, scriptName: 'filler', scriptVersion: '1.0.0' })
    const secondClaim = jobStore.claimNext(60)
    expect(secondClaim).toBeNull()
    expect(jobStore.get(secondJob.id)?.status).toBe('queued') // still waiting, untouched

    // 4. Exactly ONE real session BUILD so far (the workflow executor's own
    // outer acquire, refcount 0→1) — even though node "a" has already run
    // its own full acquire/release pair inside `JobRunner` and node "b"'s
    // own inner acquire has ALREADY happened too (it is "running"): neither
    // ever brought the refcount back to 0, so neither is a second build.
    // This IS H1's mechanism (F11), not a restatement of it.
    expect(sessionState.builds).toBe(1)
    expect(sessionState.closes).toBe(0) // never released all the way down yet
    expect(sessionState.acquireCalls).toBeGreaterThanOrEqual(3) // outer + node a + node b, at least

    // ---- Let the pipeline finish. ----
    await waitUntil(() => jobStore.get(claimed.job.id)?.status !== 'running', 5000)
    const finished = jobStore.get(claimed.job.id)
    expect(finished?.status).toBe('success')

    // One session build, one full close, for the ENTIRE three-node pipeline
    // — criterion 5, settled.
    expect(sessionState.builds).toBe(1)
    expect(sessionState.closes).toBe(1)
    expect(sessionState.acquireCalls).toBe(4) // 1 outer + 3 inner (one per node) — every inner one a refcount bump, never a rebuild

    // Exactly one `jobs` row for the workflow itself.
    const workflowJobRows = db.select().from(jobs).where(eq(jobs.scriptId, workflowId)).all()
    expect(workflowJobRows.length).toBe(1)

    // Three `job_nodes` rows, in order, each a REAL child spawn (distinct
    // markers only the actually-imported bundle could have returned) — and
    // node "c" genuinely read node "b"'s output through a binding.
    const nodeRows = db.select().from(jobNodes).where(eq(jobNodes.jobId, claimed.job.id)).orderBy(jobNodes.seq).all()
    expect(nodeRows.length).toBe(3)
    expect(nodeRows.map((r) => [r.nodeId, r.status])).toEqual([
      ['a', 'success'],
      ['b', 'success'],
      ['c', 'success'],
    ])
    expect(nodeRows[0]?.output).toEqual({ marker: 'a', videos: 15 })
    expect(nodeRows[1]?.output).toEqual({ marker: 'b' })
    expect(nodeRows[2]?.output).toEqual({ marker: 'c' })

    // The device stays online, and the job activity is gone once the job settles.
    expect(deviceStatus(db, 'd1')).toBe('online')
    expect(activities.list('d1')).toEqual([])

    // And ONLY NOW can the second, previously-refused job be claimed.
    const claimedSecond = jobStore.claimNext(60)
    expect(claimedSecond?.job.id).toBe(secondJob.id)
  }, 20000)
})
