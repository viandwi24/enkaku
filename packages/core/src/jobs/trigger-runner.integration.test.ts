import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { Subprocess } from 'bun'
import {
  createJobRunner,
  type ChildToParent,
  type IsolationProvider,
  type JobSpec,
  type Logger,
  type ParentToChild,
  type SessionManager,
} from '@enkaku/session'
import { openDb, runMigrations, type Db } from '../db'
import { devices, jobs, scripts, type JobRow } from '../db/schema'
import { createScriptRegistry } from '../scripts/registry'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createJobsRunnerPort } from './jobs-runner-port'

/**
 * `ctx.jobs.trigger()` through the REAL runner (plan 81 §7, criteria 7, 8) —
 * a unit test of the key-derivation function would pass while the
 * interaction between the phase lifecycle (a finish-only fallback spawning a
 * FRESH process, a retry spawning a FRESH process) and the key it derives
 * stayed broken. No real subprocess: a fake `IsolationProvider` plays the
 * child, exactly like `packages/session/src/runner/job-runner.test.ts`'s own
 * harness — but wired to a REAL in-memory DB and the REAL
 * `createJobsRunnerPort`/`createJobTrigger`, so the actual insert/dedup logic
 * runs, not a mock of it.
 */

const DEVICE_ID = 'd1'
const JOB: JobSpec = { id: 'job-1', deviceId: DEVICE_ID, bundlePath: '/does/not/matter.mjs', params: {} }

const silentLog = (): Logger => {
  const l = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => l }
  return l as unknown as Logger
}

function setUpDb(): Db {
  const opened = openDb(':memory:')
  runMigrations(opened.db)
  return opened.db
}

function seedDevice(db: Db, id: string) {
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status: 'idle' }).run()
}

function seedScript(db: Db, id: string, name: string, version = '1.0.0') {
  db.insert(scripts).values({ id, name, version, bundle: 'export {}', enabled: true, createdAt: new Date() }).run()
}

function seedCallerJob(db: Db, id: string, deviceId: string) {
  db.insert(jobs).values({ id, scriptId: 'internal:sleep', deviceId, status: 'running', priority: 0, createdAt: new Date(), depth: 0 }).run()
}

function fakeSessions(): SessionManager {
  const session = { deviceId: DEVICE_ID, inspector: null, whenInspectorReady: async () => {} }
  return {
    acquire: async () => session as never,
    release: () => {},
    get: () => session as never,
    closeDevice: async () => {},
    closeIfIdle: async () => {},
    idleSessions: () => [],
    closeAll: async () => 0,
  }
}

interface ChildBehavior {
  ready: Extract<ChildToParent, { t: 'ready' }>
  onInit?: (init: Extract<ParentToChild, { t: 'init' }>, emit: (m: ChildToParent) => void, exit: (code: number) => void) => void
}

/** One scripted fake child per array entry — spawn N gets behaviors[N] (mirrors `job-runner.test.ts`'s own harness). */
function fakeIsolation(behaviors: ChildBehavior[]): IsolationProvider {
  let spawnIndex = 0
  return {
    mode: 'child-process',
    available: true,
    spawn(_req, ipc) {
      const behavior = behaviors[spawnIndex++]
      if (!behavior) throw new Error('fakeIsolation: no behavior configured for this spawn')
      let resolveExited: (code: number) => void = () => {}
      const exited = new Promise<number>((resolve) => {
        resolveExited = resolve
      })
      const child = {
        send: (msg: unknown) => {
          const m = msg as ParentToChild
          if (m.t === 'init') queueMicrotask(() => behavior.onInit?.(m, ipc, resolveExited))
        },
        kill: () => resolveExited(0),
        exited,
        stdout: undefined,
        stderr: undefined,
      }
      queueMicrotask(() => ipc(behavior.ready))
      return child as unknown as Subprocess<'ignore', 'pipe', 'pipe'>
    },
  }
}

function buildRunner(db: Db, isolation: IsolationProvider) {
  const registry = createScriptRegistry({ db, dataDir: '/tmp/enkaku-trigger-runner-test', devSlots: createDevSlotStore() })
  const jobsRunnerPort = createJobsRunnerPort({
    db,
    jobStore: {
      get: (jobId: string) => db.select().from(jobs).where(eq(jobs.id, jobId)).get() ?? null,
    } as never,
    registry,
    triggerBudgets: () => ({ maxDepth: 5, maxPerChain: 200, maxPerJob: 10 }),
  })
  return createJobRunner({
    isolation,
    logDir: `/tmp/enkaku-trigger-runner-test-${crypto.randomUUID()}`,
    sessions: fakeSessions(),
    artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
    log: silentLog(),
    onLog: () => {},
    onArtifact: () => {},
    onPhase: () => {},
    heartbeat: () => {},
    jobs: { call: (ctx, call) => jobsRunnerPort.call(ctx, call) },
  })
}

describe('ctx.jobs.trigger() through the real runner — criterion 7: a re-run finish() produces ONE job', () => {
  test('two separate execute() calls for the same job each spawn a finish-only fallback that triggers with the SAME default key — one job results', async () => {
    const db = setUpDb()
    seedDevice(db, DEVICE_ID)
    seedScript(db, 's-warmup', 'warmup')
    seedCallerJob(db, JOB.id, DEVICE_ID)

    // Same behavior sequence reused for BOTH `execute()` calls — a fresh
    // attempt counter starts at 1 every time `execute()` is invoked with the
    // SAME job (exactly what "the core runs it again" means: attempt
    // numbering is per-execution, not persisted).
    const behaviors = (): ChildBehavior[] => [
      {
        // Spawn 1 — the 'full' attempt. It fails WITHOUT running finish()
        // (finishRan: false), which is what makes the runner spawn a
        // finish-only fallback automatically (plan 35 §4.3's own mechanism).
        ready: { t: 'ready', scriptId: 'main', version: '1.0.0' },
        onInit: (_init, emit) => {
          emit({ t: 'result', ok: false, error: { code: 'CRASHED', message: 'died mid-run', phase: 'run' }, finishRan: false })
        },
      },
      {
        // Spawn 2 — the finish-only fallback, SAME attempt number as spawn 1.
        // `finish()` calls `ctx.jobs.trigger()`. The key a REAL
        // `jobs-client.ts` would derive for the FIRST trigger call of
        // attempt 1 is `${jobId}:1:0` — reproduced here by hand since this
        // fake plays the child directly rather than running the real
        // `child-entry.ts`/`jobs-client.ts` code.
        ready: { t: 'ready', scriptId: 'main', version: '1.0.0' },
        onInit: (_init, emit) => {
          emit({ t: 'jobs.call', callId: 'c1', method: 'trigger', script: 'warmup@1.0.0', key: `${JOB.id}:1:0` } as never)
          emit({ t: 'result', ok: false, error: { code: 'CRASHED', message: 'died mid-run', phase: 'run' }, finishRan: true })
        },
      },
    ]

    const runnerA = buildRunner(db, fakeIsolation(behaviors()))
    await runnerA.execute(JOB)
    const runnerB = buildRunner(db, fakeIsolation(behaviors()))
    await runnerB.execute(JOB)

    const triggered = db.select().from(jobs).where(eq(jobs.scriptId, 's-warmup')).all()
    expect(triggered).toHaveLength(1)
    expect((triggered[0] as JobRow).triggerKey).toBe(`${JOB.id}:1:0`)
  })
})

describe('ctx.jobs.trigger() through the real runner — criterion 8: different attempts are different work', () => {
  test('a script with retries: 2 that fails on every attempt produces THREE triggered jobs', async () => {
    const db = setUpDb()
    seedDevice(db, DEVICE_ID)
    seedScript(db, 's-warmup', 'warmup')
    seedCallerJob(db, JOB.id, DEVICE_ID)

    // Three spawns — one per attempt (1, 2, 3) — each declares `retries: 2`
    // in its `ready` message (the runner reads `meta.retries` fresh from
    // whichever attempt's `ready` arrived most recently), calls
    // `ctx.jobs.trigger()` once with the key a real client would derive for
    // THAT attempt, and finishes (finishRan: true, so no finish-only
    // fallback spawn is added on top of these three).
    const behaviorFor = (attempt: number): ChildBehavior => ({
      ready: { t: 'ready', scriptId: 'main', version: '1.0.0', retries: 2 },
      onInit: (_init, emit) => {
        emit({ t: 'jobs.call', callId: `c${attempt}`, method: 'trigger', script: 'warmup@1.0.0', key: `${JOB.id}:${attempt}:0` } as never)
        emit({ t: 'result', ok: false, error: { code: 'SCRIPT_FAILED', message: 'nope', phase: 'run' }, finishRan: true })
      },
    })

    const isolation = fakeIsolation([behaviorFor(1), behaviorFor(2), behaviorFor(3)])
    const runner = buildRunner(db, isolation)
    const outcome = await runner.execute(JOB)
    expect(outcome.ok).toBe(false) // exhausted all retries, still failing

    const triggeredRows = db.select().from(jobs).where(eq(jobs.scriptId, 's-warmup')).all() as JobRow[]
    expect(triggeredRows).toHaveLength(3)
    expect(triggeredRows.map((r) => r.triggerKey).sort()).toEqual([`${JOB.id}:1:0`, `${JOB.id}:2:0`, `${JOB.id}:3:0`])
    // Every triggered job shares one root and is one level deeper than the caller.
    for (const r of triggeredRows) {
      expect(r.triggeredByJobId).toBe(JOB.id)
      expect(r.depth).toBe(1)
    }
  })
})
