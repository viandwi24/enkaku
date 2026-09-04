import { describe, expect, test } from 'bun:test'
import { defaultFarmSettings } from '@enkaku/protocol'
import { openDb, runMigrations, type Db } from '../db'
import { devices, type JobRow } from '../db/schema'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createScriptRegistry } from '../scripts/registry'
import { createJobStore } from '../queue/job-store'
import type { DeviceHealth } from '../device/health'
import { createActivityRegistry } from '../activity/registry'
import type { Logger } from '../util/logger'
import { ExecutorRegistry } from './executor'
import { createExecutorHost } from './executor-host'
import { createScriptExecutor } from './executors/script'

/**
 * Plan 98 §3.5, §3.6, §4.8, H1/H2 — step 98.3, "the memory limit". This is
 * the step that KILLS a job, so — unlike `peak-rss.integration.test.ts`
 * (98.2, measurement only) — this test has to prove three things at once,
 * end to end, through the SAME real pipeline that file already established:
 * real SQLite migrated through the real generated migration, the real
 * `ExecutorHost`, the real `createScriptExecutor`, `@enkaku/session`'s real
 * `JobRunner` with NO isolation override (`createChildProcessIsolation()`,
 * exactly what a live core uses), spawning a REAL `bun child-entry.ts
 * <bundle>` child process that genuinely allocates and touches memory
 * (`.fill()` — an untouched `Uint8Array` never faults its pages in, per the
 * plan's own §0.3 measurement M3).
 *
 * 1. A fixture script allocating across `await`s under a 256 MB limit is
 *    killed within one sample of the breach.
 * 2. The job settles `failed` / `failureClass: 'script'` / `errorPhase:
 *    'timeout'`, and NEVER feeds the device health tracker (`blameDevice:
 *    false` — SCRIPT_CODES, `failure-class.ts`).
 * 3. `finish()` is proven to have run in a FRESH process — not merely "no
 *    error was thrown" — by asserting a side effect: two REAL child
 *    processes each write a JSON marker file tagged with their OWN
 *    `process.pid`. The killed attempt's `run()` writes a "run started"
 *    marker with its pid; the SEPARATE finish-only re-run (spec §11.2) never
 *    calls `run()` at all (`child-entry.ts`'s `mode === 'finish-only'`
 *    branch), so the "finish ran" marker's pid can ONLY have come from a
 *    genuinely different OS process — comparing the two pids is the proof,
 *    not an assumption.
 *
 * A second test proves `enforce: 'warn'`: the IDENTICAL shape of script
 * (allocates past the same ceiling) completes normally, and the job log
 * carries EXACTLY one warning — not the 80%-of-limit warning `enforce:
 * 'kill'` gets (there is no kill coming to precede), and not one per sample
 * spent over the limit.
 */

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
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status: 'online' }).run()
}

/**
 * A script that allocates and TOUCHES memory across `await` points (plan 98
 * H2, §0.3 M3) — the shape the sampler is designed to catch. Two marker
 * files (read from env, so the test can point each run at its own unique
 * path) are the only way to observe, from OUTSIDE the child, which process
 * actually executed which phase:
 *  - `ENKAKU_TEST_RUN_MARKER` is written the moment `run()` starts, tagged
 *    with `process.pid` — only the FULL attempt's process ever reaches this
 *    line (a finish-only re-run never calls `run()` at all).
 *  - `ENKAKU_TEST_FINISH_MARKER` is written from `finish()`, also tagged
 *    with `process.pid`, plus whatever `ctx.error.code` it saw.
 */
function memoryHogBundle(opts: { chunkMb: number; iterations: number; delayMs: number }): string {
  return `
export default {
  id: 'memory-hog',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => {
    const runMarkerPath = process.env.ENKAKU_TEST_RUN_MARKER
    if (runMarkerPath) await Bun.write(runMarkerPath, JSON.stringify({ pid: process.pid, at: Date.now() }))
    const chunks = []
    for (let i = 0; i < ${opts.iterations}; i++) {
      const buf = new Uint8Array(${opts.chunkMb} * 1024 * 1024)
      buf.fill(7) // touch every page — an untouched buffer never moves RSS (plan 98 M3)
      chunks.push(buf)
      await new Promise((resolve) => setTimeout(resolve, ${opts.delayMs}))
    }
    return 'completed-without-being-killed'
  },
  finish: async (ctx) => {
    const finishMarkerPath = process.env.ENKAKU_TEST_FINISH_MARKER
    if (finishMarkerPath) {
      await Bun.write(
        finishMarkerPath,
        JSON.stringify({ pid: process.pid, at: Date.now(), errorCode: ctx.error ? ctx.error.code : null }),
      )
    }
  },
}
`
}

/** Wires the same real pipeline `peak-rss.integration.test.ts` uses — repeated here rather than
 * imported so this file stays a single self-contained read, matching that file's own precedent. */
async function runOneMemoryHogJob(opts: {
  bundle: string
  memory: { defaultMaxRssBytes: number | null; maxRssBytes: number | null; enforce: 'kill' | 'warn' | 'off'; sampleIntervalMs: number }
  onLog?: (entry: { level: string; source: string; msg: string }) => void
  blamed: string[]
}): Promise<JobRow> {
  const { createJobRunner } = await import('@enkaku/session')
  const db = setUpDb()
  const dataDir = `/tmp/enkaku-memory-limit-test-${crypto.randomUUID()}`
  seedDevice(db, 'd1')

  const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore() })
  const jobStore = createJobStore(db)

  const { scripts } = await import('../db/schema')
  db.insert(scripts)
    .values({ pluginId: 'p-fixture', exportId: 'main', id: 's-memory-hog', name: 'memory-hog', version: '1.0.0', bundle: opts.bundle, enabled: true, createdAt: new Date() })
    .run()

  const runner = createJobRunner({
    logDir: `/tmp/enkaku-memory-limit-test-logs-${crypto.randomUUID()}`,
    sessions: {
      acquire: async () => ({ deviceId: 'd1', inspector: null, whenInspectorReady: async () => {}, prewarmInspector: async () => {} }) as never,
      release: () => {},
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
    },
    artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
    log: silentLog() as never,
    onLog: (e) => opts.onLog?.(e),
    onArtifact: () => {},
    onPhase: () => {},
    heartbeat: () => {},
    // `resetPolicy: 'none'` — this test is about the memory limit, not
    // session hygiene, and the fake session above has no `transport` to run
    // real reset commands against; skipping the reset phase entirely avoids
    // an unrelated "reset failed unexpectedly" warning line contaminating
    // the exact warning COUNT the enforce:'warn' test below asserts.
    resetPolicy: () => ({ ...defaultFarmSettings().job, resetPolicy: 'none', memory: opts.memory }),
  })

  const executors = new ExecutorRegistry()
  executors.setFallback(createScriptExecutor({ registry, runner }))

  const activities = createActivityRegistry({ log: silentLog() as never, controlIdleSec: () => 30, onChange: () => {} })
  // Plan 98 §3.6, acceptance #5 — a memory breach must NEVER feed plan 23's
  // health tracker. `note` pushes onto `opts.blamed`, asserted empty by the caller.
  const health: DeviceHealth = { note: (serial) => opts.blamed.push(serial), consecutiveFailures: () => 0, start: () => {}, stop: () => {} }

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

  jobStore.enqueue({ scriptId: 's-memory-hog', deviceId: 'd1', params: {}, priority: 0, scriptName: 'memory-hog', scriptVersion: '1.0.0' })
  const claimed = jobStore.claimNext(60)
  if (!claimed) throw new Error('expected a claimable job')

  return new Promise<JobRow>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('job did not settle in time')), 40_000)
    const check = setInterval(() => {
      const row = jobStore.get(claimed.job.id)
      if (row && (row.status === 'success' || row.status === 'failed')) {
        clearInterval(check)
        clearTimeout(timer)
        resolve(row)
      }
    }, 20)
    host.start(claimed.job)
  })
}

const LIMIT = 256 * 1024 * 1024 // the plan's own fixture number (§5 step 98.3) — NOT a shipped default.

describe('enforce: "kill" — a real breach is really killed (plan 98 §3.5, §3.6, §4.8)', () => {
  test(
    'killed within one sample of the breach; settles failed/script/MEMORY_LIMIT; finish() proven to run in a fresh process',
    async () => {
      const runMarkerPath = `/tmp/enkaku-memory-limit-test-run-${crypto.randomUUID()}.json`
      const finishMarkerPath = `/tmp/enkaku-memory-limit-test-finish-${crypto.randomUUID()}.json`
      process.env.ENKAKU_TEST_RUN_MARKER = runMarkerPath
      process.env.ENKAKU_TEST_FINISH_MARKER = finishMarkerPath

      const blamed: string[] = []
      const settled = await runOneMemoryHogJob({
        // 4 MiB every 50ms — crosses the 256 MB ceiling at chunk 64
        // (~3.2s nominal), giving the 250ms sampler roughly a DOZEN
        // opportunities to catch the breach before it happens, and a large
        // margin under real system load (other integration tests in this
        // same suite spawn real child processes too — see the "testing
        // discipline" note in this file's own header). 120 iterations
        // (~480 MB, ~6s) is the worst case if the kill never fires at all.
        bundle: memoryHogBundle({ chunkMb: 4, iterations: 120, delayMs: 50 }),
        memory: { defaultMaxRssBytes: LIMIT, maxRssBytes: null, enforce: 'kill', sampleIntervalMs: 250 },
        blamed,
      })

      expect(settled.status).toBe('failed')
      expect(settled.failureClass).toBe('script')
      // §3.6 — ctx.error.phase stays 'timeout' for a memory kill, so an
      // existing finish() branching on 'timeout' keeps matching.
      expect(settled.errorPhase).toBe('timeout')
      // Never blames the device (acceptance #5) — MEMORY_LIMIT is in
      // SCRIPT_CODES, so classifyFailure never calls health.note.
      expect(blamed).toEqual([])

      // "Killed within one sample of the breach": the recorded peak is past
      // the ceiling (the sample that triggered the kill), but nowhere near
      // what running all 80 iterations to completion would have produced
      // (~640 MB) — proof the kill actually stopped it early rather than
      // merely recording a peak after the fact.
      expect(settled.peakRssBytes).not.toBeNull()
      const peak = settled.peakRssBytes as number
      expect(peak).toBeGreaterThan(LIMIT * 0.7)
      // 120 × 4 MiB = 480 MB is the worst case if the kill never fired at
      // all — so 1.5× the ceiling is a real, meaningful upper bound, not a
      // trivially-true one: it fails if this test's OWN "failed" check
      // above somehow passed for the wrong reason.
      expect(peak).toBeLessThan(LIMIT * 1.5)

      // The strong proof: two REAL, DIFFERENT OS processes.
      const runMarker = JSON.parse(await Bun.file(runMarkerPath).text()) as { pid: number; at: number }
      const finishMarker = JSON.parse(await Bun.file(finishMarkerPath).text()) as { pid: number; at: number; errorCode: string | null }
      expect(finishMarker.errorCode).toBe('MEMORY_LIMIT')
      // `finish()` ran — and the pid tagged onto ITS marker is NOT the pid
      // that started `run()`. Since `child-entry.ts`'s finish-only branch
      // never calls `run()` at all, there is no way for these to match
      // unless finish() genuinely executed in a separate process.
      expect(finishMarker.pid).not.toBe(runMarker.pid)
      expect(typeof runMarker.pid).toBe('number')
      expect(typeof finishMarker.pid).toBe('number')

      delete process.env.ENKAKU_TEST_RUN_MARKER
      delete process.env.ENKAKU_TEST_FINISH_MARKER
    },
    40_000,
  )
})

describe('enforce: "warn" — the identical shape of script survives, exactly one warning (plan 98 §3.6)', () => {
  test('the job completes, and the log carries exactly one warning', async () => {
    const logEntries: Array<{ level: string; source: string; msg: string }> = []
    const blamed: string[] = []
    const settled = await runOneMemoryHogJob({
      // Same shape, same ceiling — but enough iterations to run WELL past it
      // (4 MiB × 150 = 600 MB, more than double the 256 MB limit) before
      // completing, so a periodic sampler that misses the exact instant the
      // ceiling is crossed still reliably records a peak past it — there are
      // roughly 17 more 250ms sample intervals between the breach (chunk 64,
      // ~3.2s) and completion (chunk 150, ~7.5s nominal).
      bundle: memoryHogBundle({ chunkMb: 4, iterations: 150, delayMs: 50 }),
      memory: { defaultMaxRssBytes: LIMIT, maxRssBytes: null, enforce: 'warn', sampleIntervalMs: 250 },
      onLog: (e) => logEntries.push(e),
      blamed,
    })

    expect(settled.status).toBe('success')
    expect(settled.result).toBe('completed-without-being-killed')
    expect(settled.peakRssBytes).not.toBeNull()
    expect(settled.peakRssBytes as number).toBeGreaterThan(LIMIT)

    const warnLines = logEntries.filter((e) => e.level === 'warn')
    expect(warnLines).toHaveLength(1)
    expect(warnLines[0]?.msg).toContain('memory limit exceeded')
    expect(blamed).toEqual([])
  }, 40_000)
})
