import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, type Db } from '../db'
import { devices, type JobRow } from '../db/schema'
import { createDevSlotStore } from '../plugins/dev-slots'
import { createScriptRegistry } from '../scripts/registry'
import { createJobStore } from '../queue/job-store'
import type { DeviceHealth } from '../device/health'
import type { DeviceStateMachine } from '../device/state-machine'
import type { LeaseManager } from '../lease/lease-manager'
import type { Logger } from '../util/logger'
import { ExecutorRegistry } from './executor'
import { createExecutorHost } from './executor-host'
import { createScriptExecutor } from './executors/script'
import { createKvStore } from '../kv/store'
import { createPluginRuntime } from '../plugins/runtime'
import type { VerifyReport } from '../plugins/verify-child'

/**
 * Plan 82's own status header flagged exactly one thing as unproven: a real
 * queued job actually running a plugin-bundled script, end to end, through
 * the real queue → `ExecutorHost` → `@enkaku/session`'s `JobRunner` → a REAL
 * spawned child process that imports a REAL plugin bundle and selects a
 * member by `ENKAKU_SCRIPT_EXPORT_ID`. Everything up to `child-entry.ts`
 * itself was already tested in isolation (`child-entry.test.ts` spawns it
 * directly); what was missing was the wiring between a `jobs` row and that
 * env var, which lived entirely inside the two files this test exercises
 * for real: `executors/script.ts` and `@enkaku/session`'s `job-runner.ts`.
 *
 * No mocked isolation, no mocked runner, no stubbed registry — the only
 * fakes here are `states`/`leases`/`health`, which are orthogonal to "did
 * the right script run" (the same scope `executor-host.test.ts` already
 * fakes them at).
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
  db.insert(devices).values({ id, stableId: `stable-${id}`, serial: `serial-${id}`, label: id, status: 'idle' }).run()
}

const PLUGIN_BUNDLE_V1 = `
export default {
  id: 'tiktok',
  version: '1.0.0',
  reset: { packages: ['com.zhiliaoapp.musically'] },
  scripts: [
    { id: 'login', version: '1.0.0', params: { parse: (v) => v }, run: async () => 'login-ok-v1' },
    { id: 'warmup', version: '1.0.0', params: { parse: (v) => v }, run: async () => 'warmup-ok-v1' },
  ],
}
`

const PLUGIN_BUNDLE_V1_1 = `
export default {
  id: 'tiktok',
  version: '1.1.0',
  reset: { packages: ['com.zhiliaoapp.musically'] },
  scripts: [
    { id: 'login', version: '1.1.0', params: { parse: (v) => v }, run: async () => 'login-ok-v1.1' },
    { id: 'warmup', version: '1.1.0', params: { parse: (v) => v }, run: async () => 'warmup-ok-v1.1' },
  ],
}
`

describe('a plugin-published script runs end to end through a real queued job (plan 82, criterion 3)', () => {
  test('a job pinned to tiktok/login runs login, NOT warmup, out of the SAME shared bundle row', async () => {
    const { createJobRunner } = await import('@enkaku/session')
    const db = setUpDb()
    const dataDir = `/tmp/enkaku-plugin-exec-test-${crypto.randomUUID()}`
    seedDevice(db, 'd1')

    const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore() })
    const jobStore = createJobStore(db)

    const { scripts } = await import('../db/schema')
    db.insert(scripts)
      .values([
        { id: 's-login', name: 'tiktok/login', version: '1.0.0', bundle: PLUGIN_BUNDLE_V1, pluginId: 'p1', exportId: 'login', enabled: true, createdAt: new Date() },
        { id: 's-warmup', name: 'tiktok/warmup', version: '1.0.0', bundle: PLUGIN_BUNDLE_V1, pluginId: 'p1', exportId: 'warmup', enabled: true, createdAt: new Date() },
      ])
      .run()

    const runner = createJobRunner({
      logDir: `/tmp/enkaku-plugin-exec-test-logs-${crypto.randomUUID()}`,
      sessions: {
        acquire: async () => ({ deviceId: 'd1', inspector: null, whenInspectorReady: async () => {} }) as never,
        release: () => {},
        get: () => null as never,
        closeDevice: async () => {},
        closeIfIdle: async () => {},
        idleSessions: () => [],
        closeAll: async () => 0,
      },
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog() as never,
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
    })

    const executors = new ExecutorRegistry()
    executors.setFallback(createScriptExecutor({ registry, runner }))

    const states: DeviceStateMachine = { apply: () => ({ changed: true, from: 'busy', to: 'idle' }), current: () => 'busy' }
    const leases: LeaseManager = {
      acquireManual: () => { throw new Error('not used') },
      touchManual: () => {},
      releaseManual: () => false,
      releaseAllForClient: () => {},
      noteJobLease: () => {},
      clearJobLease: () => {},
      getLease: () => null,
      getHolder: () => null,
      lastManualReleaseAt: () => null,
      lastManualHolder: () => null,
      checkInputAllowed: () => ({ ok: true }),
      startReaper: () => {},
      stopReaper: () => {},
    }
    const health: DeviceHealth = { note: () => {}, consecutiveFailures: () => 0, start: () => {}, stop: () => {} }

    const settled: JobRow[] = []
    const host = createExecutorHost({
      registry: executors,
      jobStore,
      states,
      leases: () => leases,
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

    async function runOne(scriptId: string, scriptName: string): Promise<JobRow> {
      jobStore.enqueue({ scriptId, deviceId: 'd1', params: {}, priority: 0, scriptName, scriptVersion: '1.0.0' })
      const claimed = jobStore.claimNext(60)
      if (!claimed) throw new Error('expected a claimable job')
      const done = new Promise<void>((resolve) => {
        const check = setInterval(() => {
          const row = jobStore.get(claimed.job.id)
          if (row && (row.status === 'success' || row.status === 'failed')) {
            clearInterval(check)
            settled.push(row)
            resolve()
          }
        }, 20)
      })
      host.start(claimed.job)
      await done
      return settled[settled.length - 1] as JobRow
    }

    const loginResult = await runOne('s-login', 'tiktok/login')
    expect(loginResult.status).toBe('success')
    expect(loginResult.result).toBe('login-ok-v1')

    // Free the device back up (host settle already released it, but be defensive for claimNext ordering).
    db.update(devices).set({ status: 'idle' }).run()

    const warmupResult = await runOne('s-warmup', 'tiktok/warmup')
    expect(warmupResult.status).toBe('success')
    expect(warmupResult.result).toBe('warmup-ok-v1')
  }, 20000)

  test('a job pinned to v1.0.0 still runs v1.0.0 bytes after v1.1.0 is published (criterion 6, the "let it run" half)', async () => {
    const { createJobRunner } = await import('@enkaku/session')
    const db = setUpDb()
    const dataDir = `/tmp/enkaku-plugin-exec-pin-test-${crypto.randomUUID()}`
    seedDevice(db, 'd1')

    const registry = createScriptRegistry({ db, dataDir, devSlots: createDevSlotStore() })
    const jobStore = createJobStore(db)

    const { scripts, plugins } = await import('../db/schema')
    db.insert(scripts)
      .values({ id: 's-login-v1', name: 'tiktok/login', version: '1.0.0', bundle: PLUGIN_BUNDLE_V1, pluginId: 'p1', exportId: 'login', enabled: true, createdAt: new Date() })
      .run()
    db.insert(plugins)
      .values({ id: 'p1', name: 'tiktok', version: '1.0.0', bundle: PLUGIN_BUNDLE_V1, bundleHash: 'h1', status: 'active', createdAt: new Date() })
      .run()

    // Pin BEFORE the new version exists — exactly what an enqueue against
    // `tiktok/login@1.0.0` (or the entry a prior `@latest` resolved to)
    // would have captured.
    const pinned = registry.resolve('tiktok/login@1.0.0')
    jobStore.enqueue({ scriptId: pinned.id, deviceId: 'd1', params: {}, priority: 0, scriptName: pinned.name, scriptVersion: pinned.version })

    // Now "activate" 1.1.0 — a new plugin row/version claiming the same name,
    // as `PluginRuntime.activate` would really do: the old row is superseded
    // (kept, so a pinned ref keeps resolving — plan 82 §4.4), the new one
    // becomes active.
    db.insert(scripts)
      .values({ id: 's-login-v1.1', name: 'tiktok/login', version: '1.1.0', bundle: PLUGIN_BUNDLE_V1_1, pluginId: 'p2', exportId: 'login', enabled: true, createdAt: new Date() })
      .run()
    db.update(plugins).set({ status: 'superseded' }).where(eq(plugins.id, 'p1')).run()
    db.insert(plugins)
      .values({ id: 'p2', name: 'tiktok', version: '1.1.0', bundle: PLUGIN_BUNDLE_V1_1, bundleHash: 'h2', status: 'active', createdAt: new Date() })
      .run()
    expect(registry.resolve('tiktok/login@latest').version).toBe('1.1.0') // the new version is what NEW enqueues would get

    const runner = createJobRunner({
      logDir: `/tmp/enkaku-plugin-exec-pin-test-logs-${crypto.randomUUID()}`,
      sessions: {
        acquire: async () => ({ deviceId: 'd1', inspector: null, whenInspectorReady: async () => {} }) as never,
        release: () => {},
        get: () => null as never,
        closeDevice: async () => {},
        closeIfIdle: async () => {},
        idleSessions: () => [],
        closeAll: async () => 0,
      },
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog() as never,
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
    })
    const executors = new ExecutorRegistry()
    executors.setFallback(createScriptExecutor({ registry, runner }))

    const states: DeviceStateMachine = { apply: () => ({ changed: true, from: 'busy', to: 'idle' }), current: () => 'busy' }
    const leases: LeaseManager = {
      acquireManual: () => { throw new Error('not used') },
      touchManual: () => {},
      releaseManual: () => false,
      releaseAllForClient: () => {},
      noteJobLease: () => {},
      clearJobLease: () => {},
      getLease: () => null,
      getHolder: () => null,
      lastManualReleaseAt: () => null,
      lastManualHolder: () => null,
      checkInputAllowed: () => ({ ok: true }),
      startReaper: () => {},
      stopReaper: () => {},
    }
    const health: DeviceHealth = { note: () => {}, consecutiveFailures: () => 0, start: () => {}, stop: () => {} }
    const host = createExecutorHost({
      registry: executors,
      jobStore,
      states,
      leases: () => leases,
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

    const claimed = jobStore.claimNext(60)
    if (!claimed) throw new Error('expected a claimable job')
    expect(claimed.job.scriptId).toBe('s-login-v1') // still the OLD row — pinning is a property of the STORED scriptId

    const result = await new Promise<JobRow>((resolve) => {
      const check = setInterval(() => {
        const row = jobStore.get(claimed.job.id)
        if (row && (row.status === 'success' || row.status === 'failed')) {
          clearInterval(check)
          resolve(row)
        }
      }, 20)
      host.start(claimed.job)
    })

    expect(result.status).toBe('success')
    // The queued job runs the OLD bytes — v1.0.0's run() — even though
    // @latest has since moved on to v1.1.0.
    expect(result.result).toBe('login-ok-v1')
  }, 20000)
})

const SLOW_PLUGIN_BUNDLE = `
export default {
  id: 'tiktok',
  version: '1.0.0',
  scripts: [
    { id: 'login', version: '1.0.0', params: { parse: (v) => v }, run: async () => { await new Promise((r) => setTimeout(r, 800)); return 'login-ok-slow' } },
  ],
}
`

describe('restart() does not disturb a running job (plan 82, criterion 26 — the real-runner half)', () => {
  test('a job started before restart() still settles successfully, running the SAME bytes it started with', async () => {
    const { createJobRunner } = await import('@enkaku/session')
    const db = setUpDb()
    const dataDir = `/tmp/enkaku-plugin-exec-restart-test-${crypto.randomUUID()}`
    seedDevice(db, 'd1')

    const devSlots = createDevSlotStore()
    const registry = createScriptRegistry({ db, dataDir, devSlots })
    const kv = createKvStore(db, dataDir, () => ({ maxValueBytes: 65536, maxKeyLength: 256, maxEntriesPerNamespace: 1000, maxEntriesPerDevice: 5000 }))
    const healthyReport: VerifyReport = { ok: true, pluginId: 'tiktok', version: '1.0.0', scripts: [{ id: 'login', paramsSchema: {}, runtime: null }], resetPackages: [] }
    const runtime = createPluginRuntime({ db, dataDir, registry, kv, devSlots, verify: async () => healthyReport })

    const staged = await runtime.stage({ name: 'tiktok', version: '1.0.0', bundle: SLOW_PLUGIN_BUNDLE })
    await runtime.verify(staged.id)
    runtime.activate(staged.id)
    const entry = registry.resolve('tiktok/login@1.0.0')

    const jobStore = createJobStore(db)
    jobStore.enqueue({ scriptId: entry.id, deviceId: 'd1', params: {}, priority: 0, scriptName: entry.name, scriptVersion: entry.version })
    const claimed = jobStore.claimNext(60)
    if (!claimed) throw new Error('expected a claimable job')

    const runner = createJobRunner({
      logDir: `/tmp/enkaku-plugin-exec-restart-test-logs-${crypto.randomUUID()}`,
      sessions: {
        acquire: async () => ({ deviceId: 'd1', inspector: null, whenInspectorReady: async () => {} }) as never,
        release: () => {},
        get: () => null as never,
        closeDevice: async () => {},
        closeIfIdle: async () => {},
        idleSessions: () => [],
        closeAll: async () => 0,
      },
      artifacts: () => ({ save: async () => ({ path: 'x', sizeBytes: 0 }) }),
      log: silentLog() as never,
      onLog: () => {},
      onArtifact: () => {},
      onPhase: () => {},
      heartbeat: () => {},
    })
    const executors = new ExecutorRegistry()
    executors.setFallback(createScriptExecutor({ registry, runner }))
    const states: DeviceStateMachine = { apply: () => ({ changed: true, from: 'busy', to: 'idle' }), current: () => 'busy' }
    const leases: LeaseManager = {
      acquireManual: () => { throw new Error('not used') },
      touchManual: () => {},
      releaseManual: () => false,
      releaseAllForClient: () => {},
      noteJobLease: () => {},
      clearJobLease: () => {},
      getLease: () => null,
      getHolder: () => null,
      lastManualReleaseAt: () => null,
      lastManualHolder: () => null,
      checkInputAllowed: () => ({ ok: true }),
      startReaper: () => {},
      stopReaper: () => {},
    }
    const health: DeviceHealth = { note: () => {}, consecutiveFailures: () => 0, start: () => {}, stop: () => {} }
    const host = createExecutorHost({
      registry: executors,
      jobStore,
      states,
      leases: () => leases,
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

    const done = new Promise<JobRow>((resolve) => {
      const check = setInterval(() => {
        const row = jobStore.get(claimed.job.id)
        if (row && (row.status === 'success' || row.status === 'failed')) {
          clearInterval(check)
          resolve(row)
        }
      }, 20)
    })
    host.start(claimed.job)

    // The child is mid-`run()` (an 800ms sleep) when restart() fires — it
    // re-derives the WHOLE registry from the database and every dev slot,
    // and must not touch the row this job is already running against.
    await Bun.sleep(150)
    const restartResult = await runtime.restart()
    expect(restartResult.ok).toBe(1)
    expect(restartResult.failed).toBe(0)

    const result = await done
    expect(result.status).toBe('success')
    expect(result.result).toBe('login-ok-slow')
  }, 20000)
})
