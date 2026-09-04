import { describe, expect, test } from 'bun:test'
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
 * Plan 98 §3.9 item 4, §4.4, §4.8, H1 — step 98.2, "measure before
 * limiting". Every OTHER test touching `peakRssBytes` in this plan fakes at
 * least one layer (a scripted `ChildBehavior` in `job-runner.test.ts`, a fake
 * `JobStore`/`ExecutorContext` in `executor-host.test.ts`). This one does
 * not: it runs a real queued job end to end — real SQLite migrated through
 * the real generated migration, the real `ExecutorHost`, the real
 * `createScriptExecutor`, `@enkaku/session`'s real `JobRunner` with NO
 * isolation override (the default `createChildProcessIsolation()`, exactly
 * what a live core uses), which spawns a REAL `bun child-entry.ts <bundle>`
 * child process. That child reports a real `process.memoryUsage.rss()` over
 * IPC, the parent accumulates the peak, `ExecutorHost.settle` writes it, and
 * this test reads it back from the SAME row a live Studio page would fetch.
 *
 * Modelled on `plugin-execution.integration.test.ts`'s own end-to-end
 * pattern (its own header explains why a mocked runner would not have proven
 * anything) — the only fake here is `health`, orthogonal to "did the peak
 * reach the row", the same scope that file already fakes at.
 *
 * No memory LIMIT is enforced anywhere in this test or in the code it
 * exercises — that is step 98.3. This proves only the measurement.
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

// Deliberately does NOT sleep — the whole point of the "immediate first
// sample" design (child-entry.ts) is that even a job finishing faster than
// the rss sample interval still gets a reading.
const FAST_BUNDLE = `
export default {
  id: 'fast',
  version: '1.0.0',
  params: { parse: (v) => v },
  run: async () => 'done',
}
`

describe('a real job records a real peakRssBytes end to end (plan 98 §4.4, §4.8, H1)', () => {
  test('run any script; its job row has a non-null peak_rss_bytes', async () => {
    const { createJobRunner } = await import('@enkaku/session')
    const db = setUpDb()
    const dataDir = `/tmp/enkaku-peak-rss-test-${crypto.randomUUID()}`
    seedDevice(db, 'd1')

    const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore() })
    const jobStore = createJobStore(db)

    const { scripts } = await import('../db/schema')
    db.insert(scripts)
      .values({ pluginId: 'p-fixture', exportId: 'main', id: 's-fast', name: 'fast', version: '1.0.0', bundle: FAST_BUNDLE, enabled: true, createdAt: new Date() })
      .run()

    // NO `isolation` override — the default (`resolveIsolation()` inside
    // `job-runner.ts`) spawns a real `bun child-entry.ts <bundle>` process.
    const runner = createJobRunner({
      logDir: `/tmp/enkaku-peak-rss-test-logs-${crypto.randomUUID()}`,
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
        forwards: () => [],
      },
      artifacts: () => ({ save: async () => ({ id: 'artifact-x', path: 'x', sizeBytes: 0 }) }),
      log: silentLog() as never,
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
    })

    const executors = new ExecutorRegistry()
    executors.setFallback(createScriptExecutor({ registry, runner }))

    const activities = createActivityRegistry({ log: silentLog() as never, controlIdleSec: () => 30, onChange: () => {} })
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

    jobStore.enqueue({ scriptId: 's-fast', deviceId: 'd1', params: {}, priority: 0, scriptName: 'fast', scriptVersion: '1.0.0' })
    const claimed = jobStore.claimNext(60)
    if (!claimed) throw new Error('expected a claimable job')

    const settled = await new Promise<JobRow>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('job did not settle in time')), 15_000)
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

    expect(settled.status).toBe('success')
    expect(settled.result).toBe('done')
    // The actual acceptance bar this step is verified against: a real job
    // row has a non-null peak_rss_bytes — read back from the database, not
    // asserted against anything this test shaped itself.
    expect(settled.peakRssBytes).not.toBeNull()
    expect(typeof settled.peakRssBytes).toBe('number')
    expect(settled.peakRssBytes as number).toBeGreaterThan(1_000_000)

    // And it survives the SAME projection Studio's Summary tab reads through
    // (`GET /api/jobs/:id` → `rowToJobDetail` → `JobDetailSchema`).
    const { rowToJobDetail } = await import('../queue/job-store')
    const detail = rowToJobDetail(settled)
    expect(detail.peakRssBytes).toBe(settled.peakRssBytes)
  }, 20_000)
})
